// mcp.ts — the Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over Streamable
// HTTP, answering application/json. Both protocol eras the rules accept are served:
// the modern 2026-07-28 revision (server/discover, no handshake, no session) and the
// legacy handshake (initialize + notifications/initialized). Six tools, all acting on
// the same store as REST, so a repository or issue created over MCP reads back over
// /api/v3 as the same object.
//
// Error contract: an unknown tool is JSON-RPC -32602, a tools/call missing a required
// argument is -32602, a body that is not JSON is HTTP 400 with -32700, and a call with
// no Authorization header is HTTP 401 (auth is decided in app.ts, before this runs).

import { VIEWER, Forge, type Repo } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { jsonResult, type HandlerResult } from './httputil.ts';

const SERVER_NAME = 'hamtaro-forge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISION = '2025-11-25';

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

/**
 * The six tools, defined once: tools/list serializes this same array every time, so
 * two calls answer byte for byte. Property names are github-mcp-server's canonical
 * ones, which the suite maps its documented arguments onto.
 */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by its owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'open, closed or all (default open).' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolsListResult(): Record<string, unknown> {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: 'object',
        properties: tool.properties,
        required: tool.required,
      },
    })),
  };
}

// -- tool results ------------------------------------------------------------

interface ToolOutcome {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function toolOk(value: unknown): ToolOutcome {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function toolError(message: string): ToolOutcome {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// -- argument helpers --------------------------------------------------------

/** Resolve owner/repo from the arguments (a full_name "owner/repo" is also accepted). */
function repoOf(forge: Forge, args: Record<string, unknown>): Repo | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string' && args.full_name.includes('/')) {
    const [o, r] = args.full_name.split('/', 2);
    owner = owner === '' ? (o ?? '') : owner;
    repo = repo === '' ? (r ?? '') : repo;
  }
  if (owner === '' || repo === '') return null;
  return forge.getRepo(owner, repo) ?? null;
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function numberArg(args: Record<string, unknown>, name: string): number | null {
  const value = args[name];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

// -- tool implementations ----------------------------------------------------

function callTool(forge: Forge, name: string, args: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name');
      if (repoName === '') return toolError('create_repo: name is required');
      const created = forge.createRepo(VIEWER.login, repoName, {
        isPrivate: args.private === true,
        description: stringArg(args, 'description'),
      });
      if (!created) return toolError(`create_repo: repository "${repoName}" already exists`);
      return toolOk(repoJson(created));
    }
    case 'get_repo': {
      const repo = repoOf(forge, args);
      if (!repo) return toolError('get_repo: repository not found');
      return toolOk(repoJson(repo));
    }
    case 'create_issue': {
      const repo = repoOf(forge, args);
      if (!repo) return toolError('create_issue: repository not found');
      const title = stringArg(args, 'title');
      if (title === '') return toolError('create_issue: title is required');
      const issue = repo.createIssue(
        { title, body: stringArg(args, 'body'), labels: [] },
        { id: forge.allocateIssueId() },
      );
      return toolOk(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = repoOf(forge, args);
      if (!repo) return toolError('list_issues: repository not found');
      const state = stringArg(args, 'state') || 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => b.seq - a.seq);
      const value = issues.map((issue) => issueJson(repo, issue));
      return toolOk(value);
    }
    case 'create_pull_request': {
      const repo = repoOf(forge, args);
      if (!repo) return toolError('create_pull_request: repository not found');
      const title = stringArg(args, 'title');
      const head = stringArg(args, 'head');
      const base = stringArg(args, 'base');
      if (title === '' || head === '' || base === '') {
        return toolError('create_pull_request: title, head and base are required');
      }
      if (repo.branchTip(head) === undefined) return toolError(`create_pull_request: head branch "${head}" does not exist`);
      if (repo.branchTip(base) === undefined) return toolError(`create_pull_request: base branch "${base}" does not exist`);
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
          return toolError('create_pull_request: a pull request for this head and base already exists');
        }
      }
      const pull = repo.createPull(
        { title, body: stringArg(args, 'body'), headRef: head, baseRef: base },
        { id: forge.allocateIssueId() },
      );
      return toolOk(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = repoOf(forge, args);
      if (!repo) return toolError('merge_pull_request: repository not found');
      const number = numberArg(args, 'pull_number');
      if (number === null) return toolError('merge_pull_request: pull_number is required');
      const pull = repo.pulls.get(number);
      if (!pull) return toolError(`merge_pull_request: pull request #${number} not found`);
      if (pull.state !== 'open') return toolError(`merge_pull_request: pull request #${number} is not open`);
      const merged = repo.squashMerge(pull);
      if ('conflict' in merged) return toolError(`merge_pull_request: pull request #${number} has conflicts`);
      return toolOk({ merged: true, sha: merged.sha, number: pull.number, state: pull.state });
    }
    default:
      return toolError(`unknown tool "${name}"`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

function resultEnvelope(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function errorEnvelope(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

const SERVER_INFO = { name: SERVER_NAME, version: SERVER_VERSION };

/** One JSON-RPC request's response envelope, or null for a notification. */
function handleOne(forge: Forge, request: JsonRpcRequest): Record<string, unknown> | null {
  const id: JsonRpcId = request.id === undefined ? null : (request.id as JsonRpcId);
  const isNotification = request.id === undefined;
  const method = typeof request.method === 'string' ? request.method : '';

  if (method === 'notifications/initialized') return null;
  if (method === '' || request.jsonrpc !== '2.0') {
    if (isNotification) return null;
    return errorEnvelope(id, INVALID_REQUEST, 'the request is not a JSON-RPC 2.0 request');
  }

  switch (method) {
    case 'server/discover': {
      return resultEnvelope(id, {
        supportedVersions: [MODERN_REVISION, LEGACY_REVISION],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    }
    case 'initialize': {
      const params = isRecord(request.params) ? request.params : {};
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : LEGACY_REVISION;
      return resultEnvelope(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'tools/list': {
      return resultEnvelope(id, toolsListResult());
    }
    case 'tools/call': {
      const params = isRecord(request.params) ? request.params : {};
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (!tool) return errorEnvelope(id, INVALID_PARAMS, `unknown tool "${name}"`);
      const missing = tool.required.filter((field) => args[field] === undefined || args[field] === null || args[field] === '');
      if (missing.length > 0) {
        return errorEnvelope(id, INVALID_PARAMS, `tools/call ${name}: missing required argument(s): ${missing.join(', ')}`);
      }
      const outcome = callTool(forge, name, args);
      return resultEnvelope(id, outcome);
    }
    case 'ping': {
      return resultEnvelope(id, {});
    }
    default: {
      if (isNotification) return null;
      return errorEnvelope(id, METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  }
}

/** POST /mcp: one JSON-RPC request, or a batch of them. */
export function handleMcp(forge: Forge, rawBody: Buffer): HandlerResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return {
      status: 400,
      contentType: 'application/json; charset=utf-8',
      body: `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } })}\n`,
    };
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return jsonResult(200, errorEnvelope(null, INVALID_REQUEST, 'an empty batch is not a request'));
    }
    const responses: Array<Record<string, unknown>> = [];
    for (const entry of parsed) {
      if (!isRecord(entry)) {
        responses.push(errorEnvelope(null, INVALID_REQUEST, 'a batch entry is not a request object'));
        continue;
      }
      const response = handleOne(forge, entry as JsonRpcRequest);
      if (response !== null) responses.push(response);
    }
    return jsonResult(200, responses);
  }
  if (!isRecord(parsed)) {
    return jsonResult(200, errorEnvelope(null, INVALID_REQUEST, 'the request is not a JSON-RPC object'));
  }
  const response = handleOne(forge, parsed as JsonRpcRequest);
  if (response === null) {
    // A notification: no JSON-RPC response, just an accepted status.
    return { status: 202, contentType: 'application/json; charset=utf-8', body: '' };
  }
  return jsonResult(200, response);
}
