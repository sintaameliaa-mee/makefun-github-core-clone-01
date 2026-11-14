// store.ts — the forge's whole state, in memory: repositories, git objects and refs,
// issues, pull requests, labels and comments. One process, one store; nothing is
// persisted (a trial's pod is fresh and the suite is the only client), which is what
// makes the timed workloads fast: every read is a Map lookup, every write a Map set.
//
// Determinism: commit timestamps, created_at values and ids all come from counters, never
// from the wall clock or Math.random, so two runs of the same trial leave the same state.

import {
  ZERO_OID,
  hashObject,
  parseCommit,
  parseTree,
  parseTag,
  buildCommit,
  buildTree,
  type GitObject,
  type GitObjectType,
  type ParsedCommit,
  type TreeEntry,
} from './gitcore.ts';
import { diffTrees, lineDiff, type FlatTree, type FileChange } from './diffutil.ts';

// The token owner, derived from the suite's fixed scenario seed (wire.ts SCENARIO_SEED
// 0x6a09e667f3bcc909; buildScenario() takes no other input, so these never vary).
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});
export const DEFAULT_BRANCH = 'main';

// ---------------------------------------------------------------------------
// Deterministic ids and timestamps
// ---------------------------------------------------------------------------

/** Seconds since the epoch for the next commit or created_at: a fixed base plus a counter. */
let clockTick = 0;
export function nextTimestamp(): number {
  clockTick += 1;
  return 1_700_000_000 + clockTick;
}

export function isoOf(timestampSec: number): string {
  return new Date(timestampSec * 1000).toISOString();
}

/** An opaque, stable Relay global id: base64url("<Type>:<key>"). */
export function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Issues, pull requests, labels, comments
// ---------------------------------------------------------------------------

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Label {
  name: string;
  color: string;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class Repo {
  readonly databaseId: number;
  readonly owner: string;
  readonly name: string;
  private: boolean;
  description: string;
  readonly defaultBranch: string;
  readonly createdAt: string;
  readonly seq: number;

  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, Label>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, PullRequest>();
  nextNumber = 1;

  private readonly commitCache = new Map<string, ParsedCommit>();
  private readonly treeCache = new Map<string, TreeEntry[]>();
  private readonly flatCache = new Map<string, FlatTree>();

  constructor(init: {
    databaseId: number;
    owner: string;
    name: string;
    isPrivate: boolean;
    description: string;
    createdAt: string;
    seq: number;
  }) {
    this.databaseId = init.databaseId;
    this.owner = init.owner;
    this.name = init.name;
    this.private = init.isPrivate;
    this.description = init.description;
    this.defaultBranch = DEFAULT_BRANCH;
    this.createdAt = init.createdAt;
    this.seq = init.seq;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  get nodeId(): string {
    return globalId('Repository', String(this.databaseId));
  }

  // -- objects ---------------------------------------------------------------

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  hasObject(oid: string): boolean {
    return this.objects.has(oid);
  }

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putObjects(objects: ReadonlyMap<string, GitObject>): void {
    for (const [oid, object] of objects) {
      if (!this.objects.has(oid)) this.objects.set(oid, object);
    }
  }

  getCommit(oid: string): ParsedCommit | undefined {
    const cached = this.commitCache.get(oid);
    if (cached) return cached;
    const object = this.objects.get(oid);
    if (!object || object.type !== 'commit') return undefined;
    const parsed = parseCommit(object.data);
    this.commitCache.set(oid, parsed);
    return parsed;
  }

  getTree(oid: string): TreeEntry[] | undefined {
    const cached = this.treeCache.get(oid);
    if (cached) return cached;
    const object = this.objects.get(oid);
    if (!object || object.type !== 'tree') return undefined;
    const parsed = parseTree(object.data);
    this.treeCache.set(oid, parsed);
    return parsed;
  }

  /** Follow annotated tags to the commit they point at (or return the oid itself). */
  peelToCommit(oid: string): string | undefined {
    let current = oid;
    for (let depth = 0; depth < 10; depth += 1) {
      const object = this.objects.get(current);
      if (!object) return undefined;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return undefined;
    }
    return undefined;
  }

  // -- refs ------------------------------------------------------------------

  refTip(ref: string): string | undefined {
    return this.refs.get(ref);
  }

  branchTip(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }

  listBranches(): Array<{ name: string; sha: string }> {
    const branches: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of this.refs) {
      if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    branches.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return branches;
  }

  /** Resolve a branch name, a full ref, or a 40-hex oid to a commit oid. */
  resolveToCommit(ref: string): string | undefined {
    if (/^[0-9a-f]{40}$/i.test(ref)) return this.peelToCommit(ref.toLowerCase());
    const direct = this.refs.get(ref);
    if (direct) return this.peelToCommit(direct);
    const branch = this.refs.get(`refs/heads/${ref}`);
    if (branch) return this.peelToCommit(branch);
    const tag = this.refs.get(`refs/tags/${ref}`);
    if (tag) return this.peelToCommit(tag);
    return undefined;
  }

  // -- trees -----------------------------------------------------------------

  /** Flatten a tree (recursively) into path -> {mode, oid}. Results are cached per tree. */
  flattenTree(treeOid: string): FlatTree {
    const cached = this.flatCache.get(treeOid);
    if (cached) return cached;
    const flat: FlatTree = new Map();
    const walk = (oid: string, prefix: string): void => {
      const entries = this.getTree(oid);
      if (!entries) return;
      for (const entry of entries) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else flat.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(treeOid, '');
    this.flatCache.set(treeOid, flat);
    return flat;
  }

  /** Build (and store) the nested trees for a flat path map; returns the root tree oid. */
  buildTreeFromFlat(flat: FlatTree): string {
    interface DirNode {
      files: Array<{ name: string; mode: string; oid: string }>;
      dirs: Map<string, DirNode>;
    }
    const root: DirNode = { files: [], dirs: new Map() };
    for (const [path, entry] of flat) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i]!;
        let child = node.dirs.get(part);
        if (!child) {
          child = { files: [], dirs: new Map() };
          node.dirs.set(part, child);
        }
        node = child;
      }
      node.files.push({ name: parts[parts.length - 1]!, mode: entry.mode, oid: entry.oid });
    }
    const buildDir = (node: DirNode): string => {
      const entries: TreeEntry[] = [];
      for (const file of node.files) entries.push({ mode: file.mode, name: file.name, oid: file.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: buildDir(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return buildDir(root);
  }

  /** The flat tree at a commit (empty when the commit has no tree or does not exist). */
  flatAtCommit(commitOid: string | undefined): FlatTree {
    if (!commitOid) return new Map();
    const commit = this.getCommit(commitOid);
    if (!commit) return new Map();
    return this.flattenTree(commit.tree);
  }

  // -- commits ---------------------------------------------------------------

  /** Create a commit object (stored) with the viewer's identity and a deterministic time. */
  createCommit(treeOid: string, parents: readonly string[], message: string): string {
    const timestamp = nextTimestamp();
    const identity = `${VIEWER.name} <${VIEWER.email}> ${timestamp} +0000`;
    const data = buildCommit({ tree: treeOid, parents, author: identity, committer: identity, message });
    return this.putObject('commit', data);
  }

  /** Commits reachable from `tip`, newest first (depth-first pre-order from the tip). */
  commitsFrom(tip: string | undefined, limit = 1000): string[] {
    if (!tip) return [];
    const order: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0 && order.length < limit) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.getCommit(oid);
      if (!commit) continue;
      order.push(oid);
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i]!);
    }
    return order;
  }

  /** Every commit reachable from `tip` (as a set). */
  ancestorSet(tip: string | undefined): Set<string> {
    const seen = new Set<string>();
    if (!tip) return seen;
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.getCommit(oid);
      if (!commit) continue;
      for (const parent of commit.parents) stack.push(parent);
    }
    return seen;
  }

  isAncestor(maybeAncestor: string, tip: string | undefined): boolean {
    if (maybeAncestor === tip) return true;
    return this.ancestorSet(tip).has(maybeAncestor);
  }

  /**
   * The merge-base of two commits: a common ancestor that is not an ancestor of any
   * other common ancestor. Histories here are small (a few hundred commits), so the
   * straightforward O(common^2) scan is fast enough and always correct.
   */
  mergeBase(a: string | undefined, b: string | undefined): string | undefined {
    if (!a || !b) return undefined;
    if (a === b) return a;
    const aAncestors = this.ancestorSet(a);
    const bAncestors = this.ancestorSet(b);
    const common: string[] = [];
    for (const oid of aAncestors) if (bAncestors.has(oid)) common.push(oid);
    if (common.length === 0) return undefined;
    for (const candidate of common) {
      let dominated = false;
      for (const other of common) {
        if (other === candidate) continue;
        if (this.isAncestor(candidate, other)) {
          dominated = true;
          break;
        }
      }
      if (!dominated) return candidate;
    }
    return common[0];
  }

  /**
   * The objects a fetch must send: everything reachable from `wants` (to `depth`
   * generations when set; depth 1 is the wants alone) minus everything reachable from
   * `haves`, without traversing past the depth boundary's parents. Also answers the
   * new shallow boundary and the client's shallow commits that are now unshallowed.
   */
  selectFetchObjects(options: {
    wants: readonly string[];
    haves?: readonly string[];
    depth?: number;
    clientShallow?: readonly string[];
  }): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
    const depth = options.depth;
    // BFS over commits from the wants, tracking generation (wants are generation 1).
    const included = new Set<string>();
    const boundary = new Set<string>();
    const queue: Array<{ oid: string; gen: number }> = [];
    const extraObjects = new Set<string>(); // non-commit wants (tags, trees, blobs)
    for (const want of options.wants) {
      const object = this.objects.get(want);
      if (!object) continue;
      if (object.type === 'tag') {
        extraObjects.add(want);
        const commit = this.peelToCommit(want);
        if (commit) queue.push({ oid: commit, gen: 1 });
      } else if (object.type === 'commit') {
        queue.push({ oid: want, gen: 1 });
      } else {
        extraObjects.add(want);
      }
    }
    const seenGen = new Map<string, number>();
    while (queue.length > 0) {
      const { oid, gen } = queue.shift()!;
      const prev = seenGen.get(oid);
      if (prev !== undefined && prev <= gen) continue;
      seenGen.set(oid, gen);
      included.add(oid);
      if (depth !== undefined && gen >= depth) {
        boundary.add(oid);
        continue;
      }
      const commit = this.getCommit(oid);
      if (!commit) continue;
      for (const parent of commit.parents) queue.push({ oid: parent, gen: gen + 1 });
    }
    // Objects reachable from the included commits (trees + blobs), without crossing
    // the boundary's parents (they were never added to `included`).
    const wanted = new Map<string, GitObject>();
    const addObject = (oid: string): void => {
      const object = this.objects.get(oid);
      if (object && !wanted.has(oid)) wanted.set(oid, object);
    };
    for (const oid of extraObjects) addObject(oid);
    for (const oid of included) {
      addObject(oid);
      const commit = this.getCommit(oid);
      if (!commit) continue;
      const stack: string[] = [commit.tree];
      while (stack.length > 0) {
        const treeOid = stack.pop()!;
        addObject(treeOid);
        const entries = this.getTree(treeOid);
        if (!entries) continue;
        for (const entry of entries) {
          if (entry.mode === '40000') stack.push(entry.oid);
          else addObject(entry.oid);
        }
      }
    }
    // Subtract everything the client already has (full reachability from its haves),
    // except past a commit it holds shallowly: it has that commit and its tree, but
    // none of its ancestors — delivering those ancestors is what deepen is for.
    if (options.haves && options.haves.length > 0) {
      const clientShallow = new Set(options.clientShallow ?? []);
      const haveObjects = new Set<string>();
      const commitQueue: string[] = [];
      for (const have of options.haves) {
        const object = this.objects.get(have);
        if (!object) continue;
        if (object.type === 'commit') commitQueue.push(have);
        else if (object.type === 'tag') {
          haveObjects.add(have);
          const commit = this.peelToCommit(have);
          if (commit) commitQueue.push(commit);
        } else {
          haveObjects.add(have);
        }
      }
      const haveCommits = new Set<string>();
      while (commitQueue.length > 0) {
        const oid = commitQueue.pop()!;
        if (haveCommits.has(oid)) continue;
        haveCommits.add(oid);
        haveObjects.add(oid);
        const commit = this.getCommit(oid);
        if (!commit) continue;
        if (!clientShallow.has(oid)) {
          for (const parent of commit.parents) commitQueue.push(parent);
        }
        const stack: string[] = [commit.tree];
        while (stack.length > 0) {
          const treeOid = stack.pop()!;
          if (haveObjects.has(treeOid)) continue;
          haveObjects.add(treeOid);
          const entries = this.getTree(treeOid);
          if (!entries) continue;
          for (const entry of entries) {
            if (entry.mode === '40000') stack.push(entry.oid);
            else haveObjects.add(entry.oid);
          }
        }
      }
      for (const oid of haveObjects) wanted.delete(oid);
    }
    const shallow = depth === undefined ? [] : [...boundary].sort();
    const unshallow: string[] = [];
    for (const oid of options.clientShallow ?? []) {
      if (included.has(oid) && !boundary.has(oid)) unshallow.push(oid);
    }
    unshallow.sort();
    return { objects: wanted, shallow, unshallow };
  }

  // -- contents --------------------------------------------------------------

  /**
   * Write (create or update) a file through the contents API. Returns the commit and
   * blob shas, or an error kind: 'stale' (sha mismatch), 'missing-sha' (update without
   * a sha), 'not-found' (delete of a missing file).
   */
  putContent(options: {
    path: string;
    content: Buffer;
    message: string;
    branch?: string;
    sha?: string;
  }): { commitSha: string; blobSha: string; created: boolean; error?: 'stale' | 'missing-sha' } {
    const branch = options.branch ?? this.defaultBranch;
    let tip = this.branchTip(branch);
    if (tip === undefined && branch !== this.defaultBranch) {
      // A write to a branch that does not exist yet starts it from the default tip.
      tip = this.branchTip(this.defaultBranch);
    }
    const flat = this.flatAtCommit(tip);
    const existing = flat.get(options.path);
    const blobSha = this.putObject('blob', options.content);
    if (existing !== undefined) {
      if (options.sha === undefined) return { commitSha: '', blobSha, created: false, error: 'missing-sha' };
      if (options.sha.toLowerCase() !== existing.oid.toLowerCase()) {
        return { commitSha: '', blobSha, created: false, error: 'stale' };
      }
    }
    const next = new Map(flat);
    next.set(options.path, { mode: existing?.mode ?? '100644', oid: blobSha });
    const treeOid = this.buildTreeFromFlat(next);
    const commitSha = this.createCommit(treeOid, tip ? [tip] : [], options.message);
    this.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, blobSha, created: existing === undefined };
  }

  deleteContent(options: {
    path: string;
    message: string;
    branch?: string;
    sha?: string;
  }): { commitSha: string; error?: 'stale' | 'not-found' } {
    const branch = options.branch ?? this.defaultBranch;
    const tip = this.branchTip(branch);
    const flat = this.flatAtCommit(tip);
    const existing = flat.get(options.path);
    if (!existing) return { commitSha: '', error: 'not-found' };
    if (options.sha !== undefined && options.sha.toLowerCase() !== existing.oid.toLowerCase()) {
      return { commitSha: '', error: 'stale' };
    }
    const next = new Map(flat);
    next.delete(options.path);
    const treeOid = this.buildTreeFromFlat(next);
    const commitSha = this.createCommit(treeOid, tip ? [tip] : [], options.message);
    this.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha };
  }

  // -- issues and pull requests ----------------------------------------------

  createIssue(input: { title: string; body: string; labels: string[] }, ids: { id: number }): Issue {
    const now = isoOf(nextTimestamp());
    const issue: Issue = {
      id: ids.id,
      number: this.nextNumber,
      title: input.title,
      body: input.body,
      state: 'open',
      labels: [...input.labels],
      comments: [],
      createdAt: now,
      updatedAt: now,
      seq: this.nextNumber,
    };
    this.nextNumber += 1;
    this.issues.set(issue.number, issue);
    return issue;
  }

  createPull(input: { title: string; body: string; headRef: string; baseRef: string }, ids: { id: number }): PullRequest {
    const now = isoOf(nextTimestamp());
    const pull: PullRequest = {
      id: ids.id,
      number: this.nextNumber,
      title: input.title,
      body: input.body,
      state: 'open',
      headRef: input.headRef,
      baseRef: input.baseRef,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: now,
      updatedAt: now,
      seq: this.nextNumber,
    };
    this.nextNumber += 1;
    this.pulls.set(pull.number, pull);
    return pull;
  }

  /** The diff of a pull request: merge-base...head, with line counts. */
  pullFiles(pull: PullRequest): Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
  }> {
    const headTip = this.branchTip(pull.headRef);
    const baseTip = this.branchTip(pull.baseRef);
    const base = this.mergeBase(headTip, baseTip);
    const baseFlat = this.flatAtCommit(base);
    const headFlat = this.flatAtCommit(headTip);
    const changes = diffTrees(baseFlat, headFlat);
    return changes.map((change) => {
      const oldText = change.oldOid ? this.blobText(change.oldOid) : '';
      const newText = change.newOid ? this.blobText(change.newOid) : '';
      const { additions, deletions } = lineDiff(oldText, newText);
      const status = change.status === 'removed' ? 'removed' : change.status;
      return {
        filename: change.path,
        status,
        additions,
        deletions,
        changes: additions + deletions,
      };
    });
  }

  blobText(oid: string): string {
    const object = this.objects.get(oid);
    if (!object || object.type !== 'blob') return '';
    return object.data.toString('utf8');
  }

  /** Whether a pull request's head can merge cleanly into its base (file-level 3-way). */
  mergeable(pull: PullRequest): boolean {
    return this.mergePlan(pull).conflict === false;
  }

  /**
   * The squash-merge plan: the merged tree (base tip + head's changes) or a conflict.
   * A file conflicts when the base tip changed it from the merge-base AND the head's
   * version differs from the base tip's version.
   */
  mergePlan(pull: PullRequest): { conflict: boolean; treeOid?: string; mergeBase?: string } {
    const headTip = this.branchTip(pull.headRef);
    const baseTip = this.branchTip(pull.baseRef);
    if (!headTip || !baseTip) return { conflict: true };
    const base = this.mergeBase(headTip, baseTip);
    const mbFlat = this.flatAtCommit(base);
    const headFlat = this.flatAtCommit(headTip);
    const baseFlat = this.flatAtCommit(baseTip);
    const changes = diffTrees(mbFlat, headFlat);
    const merged = new Map(baseFlat);
    for (const change of changes) {
      const mbEntry = mbFlat.get(change.path);
      const baseEntry = baseFlat.get(change.path);
      const headEntry = headFlat.get(change.path);
      const baseChanged = (baseEntry?.oid ?? null) !== (mbEntry?.oid ?? null);
      const headDiffersFromBase = (headEntry?.oid ?? null) !== (baseEntry?.oid ?? null);
      if (baseChanged && headDiffersFromBase) return { conflict: true, mergeBase: base };
      if (headEntry) merged.set(change.path, { mode: headEntry.mode, oid: headEntry.oid });
      else merged.delete(change.path);
    }
    return { conflict: false, treeOid: this.buildTreeFromFlat(merged), mergeBase: base };
  }

  /** Squash-merge an open pull request; returns the merge sha or a conflict. */
  squashMerge(pull: PullRequest): { sha: string } | { conflict: true } {
    const plan = this.mergePlan(pull);
    if (plan.conflict || !plan.treeOid) return { conflict: true };
    const baseTip = this.branchTip(pull.baseRef)!;
    const message = pull.title;
    const sha = this.createCommit(plan.treeOid, [baseTip], message);
    this.refs.set(`refs/heads/${pull.baseRef}`, sha);
    const now = isoOf(nextTimestamp());
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = now;
    pull.mergeCommitSha = sha;
    pull.updatedAt = now;
    return { sha };
  }
}

// ---------------------------------------------------------------------------
// Forge
// ---------------------------------------------------------------------------

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextDatabaseId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private nextSeq = 1;

  static repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(Forge.repoKey(owner, name));
  }

  getRepoByDatabaseId(databaseId: number): Repo | undefined {
    for (const repo of this.repos.values()) {
      if (repo.databaseId === databaseId) return repo;
    }
    return undefined;
  }

  createRepo(owner: string, name: string, options: { isPrivate: boolean; description: string }): Repo | null {
    if (this.repos.has(Forge.repoKey(owner, name))) return null;
    const repo = new Repo({
      databaseId: this.nextDatabaseId,
      owner,
      name,
      isPrivate: options.isPrivate,
      description: options.description,
      createdAt: isoOf(nextTimestamp()),
      seq: this.nextSeq,
    });
    this.nextDatabaseId += 1;
    this.nextSeq += 1;
    this.repos.set(Forge.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(Forge.repoKey(owner, name));
  }

  /** The owner's repositories, in creation order. */
  listUserRepos(owner: string): Repo[] {
    const list: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) list.push(repo);
    }
    list.sort((a, b) => a.seq - b.seq);
    return list;
  }

  allocateIssueId(): number {
    const id = this.nextIssueId;
    this.nextIssueId += 1;
    return id;
  }

  allocateCommentId(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }
}

// Re-exported for callers that only import the store.
export { ZERO_OID };
