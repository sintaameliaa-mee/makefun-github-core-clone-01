// gitcore.ts — the git primitives the forge is built on: object hashing, commit/tree
// parsing and building, packfile read/write (with OFS_DELTA and REF_DELTA), pkt-line
// framing, and graph walks (reachability, ancestors, merge-base). No I/O, no git binary:
// everything here is pure computation over Buffers, so the suite's checks and the timed
// workloads both run against the same code.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const SHA1_RE = /^[0-9a-f]{40}$/;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export function isObjectId(value: string): boolean {
  return SHA1_RE.test(value);
}

/** The git object id of `type` + `data`: sha1("<type> <len>\0<data>"). */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

export type GitPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** One pkt-line: a 4-hex length prefix (length includes the prefix) plus the payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const prefix = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([prefix, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** Encode lines ('flush'/'delim' are control packets; anything else is a data packet). */
export function encodePktLines(lines: readonly (string | Buffer | 'flush' | 'delim' | 'response-end')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else if (line === 'response-end') parts.push(PKT_RESPONSE_END);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

export class PktLineError extends Error {}

/**
 * Decode a whole buffer of pkt-lines. Returns the packets and the offset where the
 * pkt-line stream ended (the byte after the last packet consumed) — receive-pack bodies
 * carry a raw packfile after the terminating flush, and the caller needs that offset.
 * Throws PktLineError on malformed framing instead of crashing the server.
 */
export function decodePktLines(buffer: Buffer, start = 0): { packets: GitPacket[]; end: number } {
  const packets: GitPacket[] = [];
  let offset = start;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new PktLineError('truncated pkt-line length prefix');
    const prefix = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(prefix)) throw new PktLineError(`bad pkt-line length ${JSON.stringify(prefix)}`);
    const length = parseInt(prefix, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4) throw new PktLineError(`pkt-line length ${length} is too small`);
    if (offset + length > buffer.length) throw new PktLineError('pkt-line overruns its buffer');
    packets.push({ kind: 'data', payload: Buffer.from(buffer.subarray(offset + 4, offset + length)) });
    offset += length;
  }
  return { packets, end: offset };
}

/** The data packets' payloads as UTF-8 lines (trailing newline stripped), in order. */
export function packetLines(packets: readonly GitPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

/**
 * Decode pkt-lines up to and including the first flush packet; returns the packets and
 * the offset just past the flush. Receive-pack bodies carry a raw packfile after the
 * terminating flush, and those bytes are not pkt-lines, so the full-buffer decoder
 * cannot be used on them.
 */
export function decodePktLinesUntilFlush(buffer: Buffer, start = 0): { packets: GitPacket[]; end: number } {
  const packets: GitPacket[] = [];
  let offset = start;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new PktLineError('truncated pkt-line length prefix');
    const prefix = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(prefix)) throw new PktLineError(`bad pkt-line length ${JSON.stringify(prefix)}`);
    const length = parseInt(prefix, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      return { packets, end: offset + 4 };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4) throw new PktLineError(`pkt-line length ${length} is too small`);
    if (offset + length > buffer.length) throw new PktLineError('pkt-line overruns its buffer');
    packets.push({ kind: 'data', payload: Buffer.from(buffer.subarray(offset + 4, offset + length)) });
    offset += length;
  }
  return { packets, end: offset };
}

// ---------------------------------------------------------------------------
// commits and trees
// ---------------------------------------------------------------------------

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(commit: { tree: string; parents: readonly string[]; author: string; committer: string; message: string }): Buffer {
  const lines: string[] = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${commit.author}`);
  lines.push(`committer ${commit.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${commit.message}`, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries sort by name, directories as if their name ended in '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface ParsedTag {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Write a version-2 pack of plain objects (no deltas): git accepts it everywhere. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const typeCode = TYPE_CODE[object.type];
    const size = object.data.length;
    // Object header: (type << 4) | (size & 0x0f), then 7-bit size continuation bytes.
    let remaining = size;
    let first = (typeCode << 4) | (remaining & 0x0f);
    remaining >>= 4;
    const headerBytes: number[] = [];
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

export class PackError extends Error {}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

function readPackVarint(buffer: Buffer, offset: number): { size: number; first: number; next: number } {
  let byte = buffer[offset]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let next = offset + 1;
  while (byte & 0x80) {
    byte = buffer[next]!;
    next += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return { size, first, next };
}

function readOfsDeltaBase(buffer: Buffer, offset: number): { baseOffset: number; next: number } {
  let byte = buffer[offset]!;
  let next = offset + 1;
  let baseOffset = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[next]!;
    next += 1;
    baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
  }
  return { baseOffset, next };
}

/**
 * Adler-32 of `data` (zlib's checksum: the last 4 bytes of a zlib stream), with
 * the modulo deferred in 5552-byte blocks, the largest that cannot overflow.
 */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  let i = 0;
  while (i < data.length) {
    const end = Math.min(data.length, i + 5552);
    for (; i < end; i += 1) {
      a += data[i]!;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Inflate one zlib stream starting at `offset` in `buffer`; returns the data and the
 * offset just past the stream's end. Node's inflateSync ignores trailing bytes and
 * throws on a truncated stream, so the stream's end is found from its own checksum:
 * the last 4 bytes of a zlib stream are the Adler-32 of its output, so the first
 * position where those bytes occur AND the prefix inflates cleanly to the same
 * output is the true end (a match inside the deflate data fails the inflate, since
 * the stream is truncated there). Two inflates per object instead of a binary
 * search's dozen, and no thrown errors on the happy path.
 */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const rest = buffer.subarray(offset);
  // First confirm the stream completes at all inside this buffer.
  let full: Buffer;
  try {
    full = inflateSync(rest);
  } catch {
    throw new PackError('could not inflate a pack object');
  }
  const needle = Buffer.alloc(4);
  needle.writeUInt32BE(adler32(full), 0);
  let at = rest.indexOf(needle, 2);
  while (at !== -1) {
    const end = at + 4;
    try {
      const data = inflateSync(rest.subarray(0, end));
      if (data.length === full.length && data.equals(full)) {
        return { data: full, next: offset + end };
      }
    } catch {
      // A checksum match inside the deflate data: not the stream's end.
    }
    at = rest.indexOf(needle, at + 1);
  }
  // No checksum match (not expected for a well-formed stream): fall back to a
  // binary search over the window length, which always finds the end.
  let lo = 1;
  let hi = rest.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      inflateSync(rest.subarray(0, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return { data: inflateSync(rest.subarray(0, lo)), next: offset + lo };
}

/** Apply a git delta to a base buffer (source-size varint, target-size varint, ops). */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new PackError('delta varint overruns its buffer');
      const byte = delta[offset]!;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new PackError(`delta source size ${sourceSize} does not match base ${base.length}`);
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          if (offset >= delta.length) throw new PackError('delta copy offset overruns its buffer');
          copyOffset |= delta[offset]! << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          if (offset >= delta.length) throw new PackError('delta copy size overruns its buffer');
          copySize |= delta[offset]! << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new PackError('delta copy overruns its base');
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      if (offset + op > delta.length) throw new PackError('delta insert overruns its buffer');
      parts.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new PackError('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(parts);
  if (result.length !== targetSize || produced !== targetSize) {
    throw new PackError(`delta produced ${result.length} bytes, expected ${targetSize}`);
  }
  return result;
}

/**
 * Read a version 2/3 packfile and resolve every object, including OFS_DELTA and REF_DELTA
 * (thin-pack bases resolve through `resolveBase`). Every object's SHA-1 is recomputed from
 * its resolved bytes, so a corruption cannot slip through as a successful push.
 */
export function readPack(pack: Buffer, options: { resolveBase?: (oid: string) => GitObject | undefined } = {}): Map<string, GitObject> {
  if (pack.length < 32) throw new PackError(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new PackError('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new PackError(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new PackError('pack trailer checksum does not match its bytes');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new PackError(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new PackError('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new PackError(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new PackError(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new PackError(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, { type: GitObjectType; data: Buffer; oid: string }>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    const cached = resolvedByOid.get(`offset:${entry.offset}`);
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new PackError(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new PackError(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const inPack = resolvedByOid.get(wanted);
      if (inPack) {
        type = inPack.type;
        data = applyDelta(inPack.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (!external) throw new PackError(`ref-delta base ${wanted} is neither in the pack nor in the store`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const resolved = { type, data, oid };
    resolvedByOid.set(`offset:${entry.offset}`, resolved);
    resolvedByOid.set(oid, resolved);
    resolving.delete(entry.offset);
    return resolved;
  };
  // Two passes: plain objects first, so a REF_DELTA can find its base even when the
  // base entry sits later in the pack; deltas second (OFS chains resolve recursively).
  for (const entry of raw) {
    if (entry.typeCode === 6 || entry.typeCode === 7) continue;
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  for (const entry of raw) {
    if (entry.typeCode !== 6 && entry.typeCode !== 7) continue;
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

/** Verify a packfile's trailer checksum without parsing its objects. */
export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  const trailerStart = pack.length - 20;
  return pack.subarray(trailerStart).toString('hex') === createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
}
