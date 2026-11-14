// gitproto.ts — git smart HTTP: the info/refs advertisements (v2 and v0), the v2
// ls-refs and fetch commands, the v0 fetch, and receive-pack (push). The wire shapes
// are the ones the suite's git client parses (kit program/env/src/git-client.ts):
// pkt-line framing, sideband band 1 for pack bytes and push reports, and the exact
// section names of a v2 fetch response.
//
// Object selection for fetch lives in store.ts (Repo.selectFetchObjects); this file
// only frames requests and answers.

import {
  ZERO_OID,
  PKT_FLUSH,
  decodePktLines,
  decodePktLinesUntilFlush,
  encodePktLines,
  packetLines,
  pktLine,
  readPack,
  writePack,
  PktLineError,
  PackError,
  type GitObject,
} from './gitcore.ts';
import { DEFAULT_BRANCH, type Forge, type Repo } from './store.ts';
import { errorResult, type HandlerResult } from './httputil.ts';

const AGENT = 'hamtaro-forge/1.0';
const UPLOAD_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** The largest data chunk inside one sideband packet (well under the pkt-line limit). */
const SIDEBAND_CHUNK = 32768;

/** Wrap bytes in sideband packets (band 1) for a pack or a push report. */
function sidebandPackets(data: Buffer, band = 1): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += SIDEBAND_CHUNK) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + SIDEBAND_CHUNK));
    const framed = Buffer.concat([Buffer.from([band]), chunk]);
    packets.push(pktLine(framed));
  }
  if (data.length === 0) packets.push(pktLine(Buffer.from([band])));
  return packets;
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

function v0Capabilities(service: 'git-upload-pack' | 'git-receive-pack'): string {
  const common = `agent=${AGENT} symref=HEAD:refs/heads/${DEFAULT_BRANCH}`;
  if (service === 'git-upload-pack') {
    return `multi_ack thin-pack side-band-64k side-band ofs-delta shallow no-progress include-tag ${common}`;
  }
  return `report-status side-band-64k delete-refs ofs-delta ${common}`;
}

/** The v0 ref advertisement: service preamble, flush, then ref lines (caps on the first). */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = v0Capabilities(service);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs: Array<{ oid: string; name: string; peeled?: string }> = [];
  const defaultTip = repo.branchTip(repo.defaultBranch);
  if (defaultTip === undefined && repo.refs.size === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  if (defaultTip !== undefined) refs.push({ oid: defaultTip, name: 'HEAD' });
  const branches: Array<{ oid: string; name: string }> = [];
  const tags: Array<{ oid: string; name: string }> = [];
  for (const [ref, oid] of repo.refs) {
    if (ref.startsWith('refs/heads/')) branches.push({ oid, name: ref });
    else if (ref.startsWith('refs/tags/')) tags.push({ oid, name: ref });
    else branches.push({ oid, name: ref });
  }
  branches.sort((a, b) => (a.name < b.name ? -1 : 1));
  tags.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const branch of branches) refs.push(branch);
  for (const tag of tags) {
    refs.push(tag);
    const peeled = repo.peelToCommit(tag.oid);
    const object = repo.getObject(tag.oid);
    if (object?.type === 'tag' && peeled !== undefined && peeled !== tag.oid) {
      refs.push({ oid: peeled, name: `${tag.name}^{}` });
    }
  }
  refs.forEach((ref, index) => {
    const suffix = index === 0 ? `\0${caps}` : '';
    parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
  });
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v2 capability advertisement: service preamble, flush, `version 2`, caps, flush. */
function v2Advertisement(): Buffer {
  return encodePktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

/** GET /{owner}/{repo}.git/info/refs?service=<service> */
export function gitInfoRefs(
  forge: Forge,
  owner: string,
  repoName: string,
  service: string | null,
  gitProtocol: string | null,
): HandlerResult {
  const repo = forge.getRepo(owner, repoName);
  if (!repo) return errorResult(404, 'Not Found');
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return { status: 200, contentType: UPLOAD_ADVERTISEMENT, body: v2Advertisement() };
    }
    return { status: 200, contentType: UPLOAD_ADVERTISEMENT, body: v0Advertisement(repo, 'git-upload-pack') };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: RECEIVE_ADVERTISEMENT, body: v0Advertisement(repo, 'git-receive-pack') };
  }
  return errorResult(400, 'Missing or unknown service');
}

// ---------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: string[] = [];
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const defaultTip = repo.branchTip(repo.defaultBranch);
  if (defaultTip !== undefined) {
    if (keep('HEAD')) {
      lines.push(`${defaultTip} HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    }
  } else if (args.unborn && keep('HEAD')) {
    lines.push(`unborn HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
  }
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [name, oid] of refs) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const object = repo.getObject(oid);
      if (object?.type === 'tag') {
        const peeled = repo.peelToCommit(oid);
        if (peeled !== undefined && peeled !== oid) line += ` peeled:${peeled}`;
      }
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

// ---------------------------------------------------------------------------
// fetch (v2 and v0)
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
}

function ackLines(repo: Repo, args: FetchArgs): string[] {
  if (args.haves.length === 0) return ['NAK\n'];
  const acks: string[] = [];
  for (const have of args.haves) {
    if (!repo.hasObject(have)) continue;
    const common = args.wants.some((want) => {
      const wantCommit = repo.peelToCommit(want);
      const haveCommit = repo.peelToCommit(have);
      if (!wantCommit || !haveCommit) return want === have;
      return wantCommit === haveCommit || repo.isAncestor(haveCommit, wantCommit);
    });
    if (common) acks.push(`ACK ${have}\n`);
  }
  return acks.length > 0 ? acks : ['NAK\n'];
}

function handleFetchV2(repo: Repo, args: FetchArgs): Buffer {
  const { objects, shallow, unshallow } = repo.selectFetchObjects({
    wants: args.wants,
    haves: args.haves,
    depth: args.depth,
    clientShallow: args.shallow,
  });
  const parts: Buffer[] = [];
  // Protocol v2 sends an acknowledgments section only when the client sent haves: a
  // fresh clone sends none, and a real git client errors if the section appears. After
  // ACK lines the server sends `ready`, per the v2 spec; NAK stands alone.
  if (args.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    const lines = ackLines(repo, args);
    for (const line of lines) parts.push(pktLine(line));
    if (lines.some((line) => line.startsWith('ACK '))) parts.push(pktLine('ready\n'));
    parts.push(PKT_FLUSH);
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  if (objects.size > 0) {
    const sorted = [...objects.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, object]) => object);
    const pack = writePack(sorted);
    parts.push(pktLine('packfile\n'));
    for (const packet of sidebandPackets(pack, 1)) parts.push(packet);
    parts.push(PKT_FLUSH);
  }
  return Buffer.concat(parts);
}

function handleFetchV0(repo: Repo, args: FetchArgs): Buffer {
  const { objects, shallow, unshallow } = repo.selectFetchObjects({
    wants: args.wants,
    haves: args.haves,
    depth: args.depth,
    clientShallow: args.shallow,
  });
  const parts: Buffer[] = [];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const line of ackLines(repo, args)) parts.push(pktLine(line));
  if (objects.size > 0) {
    const sorted = [...objects.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, object]) => object);
    const pack = writePack(sorted);
    for (const packet of sidebandPackets(pack, 1)) parts.push(packet);
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function gitUploadPack(
  forge: Forge,
  owner: string,
  repoName: string,
  body: Buffer,
  gitProtocol: string | null,
): HandlerResult {
  const repo = forge.getRepo(owner, repoName);
  if (!repo) return errorResult(404, 'Not Found');
  let packets;
  try {
    packets = decodePktLines(body).packets;
  } catch (err) {
    if (err instanceof PktLineError) return errorResult(400, `malformed pkt-line stream: ${err.message}`);
    throw err;
  }
  const lines = packetLines(packets);
  try {
    if (gitProtocol === 'version=2') {
      const command = lines[0] ?? '';
      const args = parseV2Args(packets);
      if (command === 'command=ls-refs') {
        return { status: 200, contentType: UPLOAD_RESULT, body: handleLsRefs(repo, args.lsRefs) };
      }
      if (command === 'command=fetch') {
        return { status: 200, contentType: UPLOAD_RESULT, body: handleFetchV2(repo, args.fetch) };
      }
      return errorResult(400, `unknown v2 command ${JSON.stringify(command)}`);
    }
    // v0: wants (with shallow/deepen) in the first section, haves + done in the second.
    const args = parseV0FetchArgs(packets);
    return { status: 200, contentType: UPLOAD_RESULT, body: handleFetchV0(repo, args) };
  } catch (err) {
    if (err instanceof PktLineError || err instanceof PackError) return errorResult(400, err.message);
    throw err;
  }
}

/** Split a v2 request's packets into the ls-refs and fetch argument sets. */
function parseV2Args(packets: ReturnType<typeof decodePktLines>['packets']): { lsRefs: LsRefsArgs; fetch: FetchArgs } {
  const lsRefs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  const fetch: FetchArgs = { wants: [], haves: [], shallow: [] };
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !pastDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') lsRefs.peel = true;
    else if (line === 'symrefs') lsRefs.symrefs = true;
    else if (line === 'unborn') lsRefs.unborn = true;
    else if (line.startsWith('ref-prefix ')) lsRefs.prefixes.push(line.slice('ref-prefix '.length));
    else if (line.startsWith('want ')) fetch.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) fetch.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) fetch.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const depth = Number(line.slice(7).trim());
      if (Number.isFinite(depth) && depth > 0) fetch.depth = Math.trunc(depth);
    }
    // thin-pack, no-progress, ofs-delta, done, filter and agent lines need no action:
    // this server always sends full objects and no progress.
  }
  return { lsRefs, fetch };
}

/** Split a v0 fetch request's packets into wants/haves/shallow/deepen. */
function parseV0FetchArgs(packets: ReturnType<typeof decodePktLines>['packets']): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [] };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      // The first want line may carry capabilities after a space: `want <oid> <caps>`.
      args.wants.push(line.slice(5, 45).trim());
    } else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const depth = Number(line.slice(7).trim());
      if (Number.isFinite(depth) && depth > 0) args.depth = Math.trunc(depth);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// receive-pack (push)
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushCommands(packets: ReturnType<typeof decodePktLines>['packets']): { commands: PushCommand[]; sideband: boolean } {
  const commands: PushCommand[] = [];
  let sideband = false;
  let first = true;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (first) {
      first = false;
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        const caps = line.slice(nul + 1).split(' ');
        sideband = caps.includes('side-band-64k');
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length !== 3) throw new PktLineError(`bad push command ${JSON.stringify(line.slice(0, 60))}`);
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  return { commands, sideband };
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function gitReceivePack(forge: Forge, owner: string, repoName: string, body: Buffer): HandlerResult {
  const repo = forge.getRepo(owner, repoName);
  if (!repo) return errorResult(404, 'Not Found');
  let decoded;
  try {
    // Only the command list is pkt-framed; the pack after the flush is raw bytes.
    decoded = decodePktLinesUntilFlush(body);
  } catch (err) {
    if (err instanceof PktLineError) return errorResult(400, `malformed pkt-line stream: ${err.message}`);
    throw err;
  }
  let commands: PushCommand[];
  let sideband: boolean;
  try {
    ({ commands, sideband } = parsePushCommands(decoded.packets));
  } catch (err) {
    if (err instanceof PktLineError) return errorResult(400, err.message);
    throw err;
  }
  const packBytes = body.subarray(decoded.end);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(Buffer.from(packBytes), {
        resolveBase: (oid) => repo.getObject(oid),
      });
      repo.putObjects(objects);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpacker error';
    }
  }
  // Apply the ref updates, one report line each; a refused update leaves its ref alone
  // (the unpacked objects stay stored either way).
  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpacker error\n`);
      continue;
    }
    reportLines.push(`${applyPushCommand(repo, command)}\n`);
  }
  const report = encodePktLines(reportLines);
  const parts: Buffer[] = [];
  if (sideband) {
    // The report-status stream is itself pkt-lined inside band 1 — including its own
    // terminating flush, which the client's report reader waits for — and the outer
    // stream ends with a flush of its own, exactly as git's receive-pack sends it.
    const inner = Buffer.concat([report, PKT_FLUSH]);
    for (const packet of sidebandPackets(inner, 1)) parts.push(packet);
    parts.push(PKT_FLUSH);
  } else {
    parts.push(report);
    parts.push(PKT_FLUSH);
  }
  return { status: 200, contentType: RECEIVE_RESULT, body: Buffer.concat(parts) };
}

function applyPushCommand(repo: Repo, command: PushCommand): string {
  const { oldOid, newOid, ref } = command;
  const current = repo.refTip(ref);
  if (newOid === ZERO_OID) {
    // A delete.
    if (current === undefined) return `ng ${ref} remote ref does not exist`;
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }
  const newObject: GitObject | undefined = repo.getObject(newOid);
  if (!newObject || (newObject.type !== 'commit' && newObject.type !== 'tag')) {
    return `ng ${ref} object not found`;
  }
  if (oldOid === ZERO_OID) {
    // A create.
    if (current !== undefined) return `ng ${ref} non-fast-forward`;
    repo.refs.set(ref, newOid);
    return `ok ${ref}`;
  }
  // An update: the old tip must match, and the new tip must descend from it.
  if (current === undefined) return `ng ${ref} non-fast-forward`;
  if (current.toLowerCase() !== oldOid.toLowerCase()) return `ng ${ref} non-fast-forward`;
  if (newOid.toLowerCase() === oldOid.toLowerCase()) return `ok ${ref}`;
  const oldCommit = repo.peelToCommit(oldOid);
  const newCommit = repo.peelToCommit(newOid);
  if (oldCommit !== undefined && newCommit !== undefined && repo.isAncestor(oldCommit, newCommit)) {
    repo.refs.set(ref, newOid);
    return `ok ${ref}`;
  }
  return `ng ${ref} non-fast-forward`;
}
