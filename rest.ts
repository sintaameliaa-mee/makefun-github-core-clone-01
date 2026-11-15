// rest.ts — the REST v3 API under /api/v3: repositories, branches, commits, contents,
// labels, issues, comments and pull requests. Every reply is JSON with a {message}
// error shape; unknown routes are 404 JSON, malformed JSON bodies are 400, and list
// endpoints paginate with a Link rel="next" header on the entry's own origin.

import { ZERO_OID } from './gitcore.ts';
import {
  VIEWER,
  Forge,
  globalId,
  isoOf,
  nextTimestamp,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import { errorResult, jsonRawResult, jsonResult, type HandlerResult } from './httputil.ts';

export interface RestContext {
  forge: Forge;
  method: string;
  segments: string[];
  query: URLSearchParams;
  /** The parsed JSON body, when the request carried one and it parsed. */
  json: unknown;
  /** True when the request carried a body that failed to parse as JSON. */
  jsonError: boolean;
  /** The entry's own origin (from the request Host), for absolute Link URLs. */
  origin: string;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(body: unknown, field: string): string | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

function boolField(body: unknown, field: string, fallback: boolean): boolean {
  if (!isRecord(body)) return fallback;
  const value = body[field];
  return typeof value === 'boolean' ? value : fallback;
}

// ---------------------------------------------------------------------------
// serializers (GitHub's shapes, with the fields the suite reads)
// ---------------------------------------------------------------------------

function userJson(): JsonRecord {
  return { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' };
}

export function repoJson(repo: Repo): JsonRecord {
  return {
    id: repo.databaseId,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    fork: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

function labelJson(repo: Repo, name: string): JsonRecord {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed' };
}

/** Clear one issue's cached REST JSON (call after any mutation of the issue). */
export function invalidateIssueJson(issue: Issue): void {
  issue.cachedJson = null;
}

/** Clear every issue's cached REST JSON in a repository (a label change recolours them all). */
function invalidateRepoIssueJson(repo: Repo): void {
  for (const issue of repo.issues.values()) issue.cachedJson = null;
}

/**
 * The single-issue REST JSON body (with its trailing newline), cached on the issue:
 * a repeated GET of the same issue — the read workload's 2,000 — skips the rebuild
 * and the stringify. Byte-identical to `jsonResult(200, issueJson(repo, issue))`.
 */
function issueJsonString(repo: Repo, issue: Issue): string {
  const cached = issue.cachedJson;
  if (cached !== null) return cached;
  const body = `${JSON.stringify(issueJson(repo, issue))}\n`;
  issue.cachedJson = body;
  return body;
}

export function issueJson(repo: Repo, issue: Issue): JsonRecord {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.databaseId}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    locked: false,
  };
}

function commentJson(comment: { id: number; body: string; createdAt: string }): JsonRecord {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', String(comment.id)),
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

export function pullJson(repo: Repo, pull: PullRequest): JsonRecord {
  const headSha = repo.branchTip(pull.headRef) ?? ZERO_OID;
  const baseSha = repo.branchTip(pull.baseRef) ?? ZERO_OID;
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.databaseId}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: userJson(),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    locked: false,
    draft: false,
  };
}

// ---------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number(query.get('per_page'));
  const pageRaw = Number(query.get('page'));
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  return { perPage, page };
}

function paginate<T>(items: readonly T[], query: URLSearchParams): { page: T[]; hasNext: boolean; perPage: number; pageNumber: number } {
  const { perPage, page } = pageParams(query);
  const start = (page - 1) * perPage;
  return {
    page: items.slice(start, start + perPage),
    hasNext: start + perPage < items.length,
    perPage,
    pageNumber: page,
  };
}

function listResult<T>(items: readonly T[], ctx: RestContext, path: string): HandlerResult {
  const { page, hasNext, perPage, pageNumber } = paginate(items, ctx.query);
  const headers: Record<string, string> = {};
  if (hasNext) {
    headers.link = `<${ctx.origin}${path}?per_page=${perPage}&page=${pageNumber + 1}>; rel="next"`;
  }
  return jsonResult(200, page, headers);
}

// ---------------------------------------------------------------------------
// path helpers
// ---------------------------------------------------------------------------

function parseNumber(segment: string): number | null {
  if (!/^\d+$/.test(segment)) return null;
  const value = Number(segment);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Parse a git identity line ("Name <email> 1700000000 +0000") into its parts. */
function parseIdentity(line: string): { name: string; email: string; date: string } {
  const lt = line.indexOf('<');
  const gt = line.indexOf('>', lt);
  const name = lt > 0 ? line.slice(0, lt).trim() : VIEWER.name;
  const email = lt >= 0 && gt > lt ? line.slice(lt + 1, gt) : VIEWER.email;
  const rest = gt >= 0 ? line.slice(gt + 1).trim().split(/\s+/) : [];
  const seconds = Number(rest[0]);
  const date = Number.isFinite(seconds) && seconds > 0 ? isoOf(seconds) : '';
  return { name, email, date };
}

/** Navigate a commit's tree by path segments: a file, a directory, or null. */
function lookupPath(
  repo: Repo,
  commitOid: string | undefined,
  segments: readonly string[],
): { kind: 'file'; blobOid: string; size: number } | { kind: 'dir'; entries: Array<{ mode: string; name: string; oid: string }> } | null {
  if (!commitOid) return null;
  const commit = repo.getCommit(commitOid);
  if (!commit) return null;
  let treeOid: string | undefined = commit.tree;
  for (let i = 0; i < segments.length; i += 1) {
    if (treeOid === undefined) return null;
    const entries = repo.getTree(treeOid);
    if (!entries) return null;
    const entry = entries.find((candidate) => candidate.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) {
      if (entry.mode === '40000') {
        return { kind: 'dir', entries: repo.getTree(entry.oid) ?? [] };
      }
      const blob = repo.getObject(entry.oid);
      return { kind: 'file', blobOid: entry.oid, size: blob?.data.length ?? 0 };
    }
    if (entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  // No segments: the root tree itself.
  return { kind: 'dir', entries: repo.getTree(treeOid) ?? [] };
}

// ---------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------

export function handleRest(ctx: RestContext): HandlerResult {
  const { forge, method, segments } = ctx;
  const needJson = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';
  if (needJson && ctx.jsonError) return errorResult(400, 'Problems parsing JSON');

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return errorResult(404, 'Not Found');
    return jsonResult(200, { installed_version: '1.0.0' });
  }

  // GET /api/v3/user
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return errorResult(404, 'Not Found');
    return jsonResult(200, userJson());
  }

  // /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const repos = forge.listUserRepos(VIEWER.login).map((repo) => repoJson(repo));
      return listResult(repos, ctx, '/api/v3/user/repos');
    }
    if (method === 'POST') {
      const name = stringField(ctx.json, 'name');
      if (name === undefined || name === '') return errorResult(422, 'name is required');
      const created = forge.createRepo(VIEWER.login, name, {
        isPrivate: boolField(ctx.json, 'private', false),
        description: stringField(ctx.json, 'description') ?? '',
      });
      if (!created) return errorResult(422, `Repository "${name}" already exists`);
      return jsonResult(201, repoJson(created));
    }
    return errorResult(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1]!;
    const name = segments[2]!;
    const repo = forge.getRepo(owner, name);
    const rest = segments.slice(3);
    if (!repo) return errorResult(404, 'Not Found');
    return handleRepo(ctx, repo, rest);
  }

  return errorResult(404, 'Not Found');
}

function handleRepo(ctx: RestContext, repo: Repo, rest: string[]): HandlerResult {
  const { forge, method } = ctx;
  const base = `/api/v3/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') return jsonResult(200, repoJson(repo));
    if (method === 'PATCH') {
      const description = stringField(ctx.json, 'description');
      if (description !== undefined) repo.description = description;
      if (isRecord(ctx.json) && typeof ctx.json.private === 'boolean') repo.private = ctx.json.private;
      return jsonResult(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo.owner, repo.name);
      return { status: 204, contentType: 'application/json; charset=utf-8', body: '' };
    }
    return errorResult(404, 'Not Found');
  }

  const head = rest[0]!;

  // Branches.
  if (head === 'branches') {
    if (rest.length === 1) {
      if (method !== 'GET') return errorResult(404, 'Not Found');
      return jsonResult(
        200,
        repo.listBranches().map((branch) => ({ name: branch.name, commit: { sha: branch.sha }, protected: false })),
      );
    }
    const branch = rest.slice(1).join('/');
    const tip = repo.branchTip(branch);
    if (method === 'GET' && tip !== undefined) {
      return jsonResult(200, { name: branch, commit: { sha: tip }, protected: false });
    }
    return errorResult(404, 'Not Found');
  }

  // Commits.
  if (head === 'commits') {
    if (method !== 'GET' || rest.length !== 1) return errorResult(404, 'Not Found');
    const ref = ctx.query.get('sha') ?? repo.defaultBranch;
    const tip = repo.resolveToCommit(ref);
    const commits = repo.commitsFrom(tip).map((sha) => {
      const commit = repo.getCommit(sha)!;
      const author = parseIdentity(commit.author);
      const committer = parseIdentity(commit.committer);
      return {
        sha,
        commit: {
          message: commit.message,
          author: { name: author.name, email: author.email, date: author.date },
          committer: { name: committer.name, email: committer.email, date: committer.date },
        },
        parents: commit.parents.map((parent) => ({ sha: parent })),
        author: userJson(),
        committer: userJson(),
      };
    });
    return jsonResult(200, commits);
  }

  // Git Data refs.
  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = stringField(ctx.json, 'ref');
      const sha = stringField(ctx.json, 'sha');
      if (!ref || !ref.startsWith('refs/')) return errorResult(422, 'ref must start with refs/');
      if (!sha || !repo.hasObject(sha)) return errorResult(422, 'sha is unknown');
      const object = repo.getObject(sha);
      if (object?.type !== 'commit' && object?.type !== 'tag') return errorResult(422, 'sha is not a commit');
      if (repo.refTip(ref) !== undefined) return errorResult(422, `Reference "${ref}" already exists`);
      repo.refs.set(ref, sha.toLowerCase());
      return jsonResult(201, { ref, object: { sha: sha.toLowerCase() } });
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const tip = repo.refTip(ref);
      if (tip === undefined) return errorResult(404, 'Not Found');
      return jsonResult(200, { ref, object: { sha: tip } });
    }
    if (method === 'GET' && rest.length === 2) {
      const refs = [...repo.refs.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([ref, sha]) => ({ ref, object: { sha } }));
      return jsonResult(200, refs);
    }
    return errorResult(404, 'Not Found');
  }

  // Contents.
  if (head === 'contents') {
    const pathSegments = rest.slice(1);
    const path = pathSegments.join('/');
    if (method === 'GET') {
      const ref = ctx.query.get('ref') ?? repo.defaultBranch;
      const tip = repo.resolveToCommit(ref);
      const found = lookupPath(repo, tip, pathSegments);
      if (!found) return errorResult(404, 'Not Found');
      if (found.kind === 'file') {
        const blob = repo.getObject(found.blobOid);
        const content = blob ? blob.data.toString('base64') : '';
        return jsonResult(200, {
          type: 'file',
          encoding: 'base64',
          content,
          sha: found.blobOid,
          size: found.size,
          name: pathSegments[pathSegments.length - 1] ?? '',
          path,
        });
      }
      const entries = found.entries
        .map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          name: entry.name,
          path: path === '' ? entry.name : `${path}/${entry.name}`,
          sha: entry.oid,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return jsonResult(200, entries);
    }
    if (method === 'PUT') {
      const content = stringField(ctx.json, 'content');
      const message = stringField(ctx.json, 'message') ?? '';
      if (content === undefined) return errorResult(422, 'content is required');
      const bytes = Buffer.from(content, 'base64');
      const result = repo.putContent({
        path,
        content: bytes,
        message,
        branch: stringField(ctx.json, 'branch'),
        sha: stringField(ctx.json, 'sha'),
      });
      if (result.error === 'stale') return errorResult(409, 'sha does not match the current file');
      if (result.error === 'missing-sha') return errorResult(422, 'sha is required to update a file');
      return jsonResult(result.created ? 201 : 200, {
        content: { name: pathSegments[pathSegments.length - 1] ?? '', path, sha: result.blobSha, size: bytes.length, encoding: 'base64', type: 'file' },
        commit: { sha: result.commitSha },
      });
    }
    if (method === 'DELETE') {
      const message = stringField(ctx.json, 'message') ?? '';
      const result = repo.deleteContent({
        path,
        message,
        branch: stringField(ctx.json, 'branch'),
        sha: stringField(ctx.json, 'sha'),
      });
      if (result.error === 'not-found') return errorResult(404, 'Not Found');
      if (result.error === 'stale') return errorResult(409, 'sha does not match the current file');
      return jsonResult(200, { commit: { sha: result.commitSha } });
    }
    return errorResult(404, 'Not Found');
  }

  // Labels.
  if (head === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      return jsonResult(
        200,
        [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })),
      );
    }
    if (method === 'POST' && rest.length === 1) {
      const name = stringField(ctx.json, 'name');
      if (!name) return errorResult(422, 'name is required');
      const color = stringField(ctx.json, 'color') ?? 'ededed';
      repo.labels.set(name, { name, color });
      invalidateRepoIssueJson(repo);
      return jsonResult(201, { name, color });
    }
    return errorResult(404, 'Not Found');
  }

  // Issues.
  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const direction = ctx.query.get('direction') ?? 'desc';
        let issues = [...repo.issues.values()];
        if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
        issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        return listResult(
          issues.map((issue) => issueJson(repo, issue)),
          ctx,
          `${base}/issues`,
        );
      }
      if (method === 'POST') {
        const title = stringField(ctx.json, 'title') ?? '';
        const body = stringField(ctx.json, 'body') ?? '';
        const labelsRaw = isRecord(ctx.json) && Array.isArray(ctx.json.labels) ? ctx.json.labels : [];
        const labels: string[] = [];
        for (const entry of labelsRaw) {
          const name = typeof entry === 'string' ? entry : isRecord(entry) ? stringField(entry, 'name') : undefined;
          if (name === undefined) continue;
          if (!repo.labels.has(name)) return errorResult(422, `label "${name}" does not exist`);
          labels.push(name);
        }
        const issue = repo.createIssue({ title, body, labels }, { id: forge.allocateIssueId() });
        return jsonResult(201, issueJson(repo, issue));
      }
      return errorResult(404, 'Not Found');
    }
    const number = parseNumber(rest[1]!);
    const issue = number === null ? undefined : repo.issues.get(number);
    if (!issue) return errorResult(404, 'Not Found');
    if (rest.length === 2) {
      if (method === 'GET') return jsonRawResult(200, issueJsonString(repo, issue));
      if (method === 'PATCH') {
        const state = stringField(ctx.json, 'state');
        if (state === 'open' || state === 'closed') issue.state = state;
        const title = stringField(ctx.json, 'title');
        if (title !== undefined) issue.title = title;
        const body = stringField(ctx.json, 'body');
        if (body !== undefined) issue.body = body;
        invalidateIssueJson(issue);
        return jsonResult(200, issueJson(repo, issue));
      }
      return errorResult(404, 'Not Found');
    }
    if (rest[2] === 'comments' && rest.length === 3) {
      if (method === 'GET') {
        return jsonResult(200, issue.comments.map((comment) => commentJson(comment)));
      }
      if (method === 'POST') {
        const body = stringField(ctx.json, 'body') ?? '';
        const comment = { id: forge.allocateCommentId(), body, createdAt: isoOf(nextTimestamp()) };
        issue.comments.push(comment);
        invalidateIssueJson(issue);
        return jsonResult(201, commentJson(comment));
      }
    }
    return errorResult(404, 'Not Found');
  }

  // Pull requests.
  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
        pulls.sort((a, b) => b.seq - a.seq);
        return listResult(
          pulls.map((pull) => pullJson(repo, pull)),
          ctx,
          `${base}/pulls`,
        );
      }
      if (method === 'POST') {
        const title = stringField(ctx.json, 'title') ?? '';
        const body = stringField(ctx.json, 'body') ?? '';
        let headRef = stringField(ctx.json, 'head') ?? '';
        let baseRef = stringField(ctx.json, 'base') ?? '';
        // GitHub accepts "owner:branch" for cross-fork heads; this forge has one owner.
        if (headRef.includes(':')) headRef = headRef.split(':').pop() ?? headRef;
        if (baseRef.includes(':')) baseRef = baseRef.split(':').pop() ?? baseRef;
        if (headRef === '' || baseRef === '') return errorResult(422, 'head and base are required');
        if (repo.branchTip(headRef) === undefined) return errorResult(422, `head branch "${headRef}" does not exist`);
        if (repo.branchTip(baseRef) === undefined) return errorResult(422, `base branch "${baseRef}" does not exist`);
        for (const existing of repo.pulls.values()) {
          if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
            return errorResult(422, 'a pull request for this head and base already exists');
          }
        }
        const pull = repo.createPull({ title, body, headRef, baseRef }, { id: forge.allocateIssueId() });
        return jsonResult(201, pullJson(repo, pull));
      }
      return errorResult(404, 'Not Found');
    }
    const number = parseNumber(rest[1]!);
    const pull = number === null ? undefined : repo.pulls.get(number);
    if (!pull) return errorResult(404, 'Not Found');
    if (rest.length === 2) {
      if (method === 'GET') return jsonResult(200, pullJson(repo, pull));
      return errorResult(404, 'Not Found');
    }
    if (rest[2] === 'files' && rest.length === 3) {
      if (method !== 'GET') return errorResult(404, 'Not Found');
      return jsonResult(200, repo.pullFiles(pull));
    }
    if (rest[2] === 'merge' && rest.length === 3) {
      if (method !== 'PUT') return errorResult(404, 'Not Found');
      if (pull.state !== 'open') return errorResult(405, 'pull request is not open');
      const merged = repo.squashMerge(pull);
      if ('conflict' in merged) return errorResult(405, 'pull request has conflicts and cannot be merged');
      return jsonResult(200, { merged: true, sha: merged.sha, message: 'Pull request successfully merged' });
    }
    return errorResult(404, 'Not Found');
  }

  return errorResult(404, 'Not Found');
}
