// app.ts — the forge server. createApp() builds an HTTP server over one Forge store and
// routes every request: /healthz (unauthenticated, the env's boot probe), the GitHub API
// root, git smart HTTP, REST v3, GraphQL v4 and the MCP endpoint. main.ts owns the
// entry <-> env lifecycle and calls createApp(); this file owns the request surface.
//
// Auth: every API call carries Authorization: Bearer $MAKEFUN_SHOP_TOKEN. A missing or
// wrong token is 401 {"message": ...}, decided before any handler runs, and /healthz and
// the API root are the only public answers. When MAKEFUN_SHOP_TOKEN is not set at all
// (a local run without a token), requests are allowed through — in a trial the token is
// always set, so the 401 contract is what the suite sees.
//
// A handler that throws never takes the server down: the request answers 500 JSON and
// the process keeps serving, which the malformed-request checks rely on.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { Forge } from './store.ts';
import { gitInfoRefs, gitReceivePack, gitUploadPack } from './gitproto.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { errorResult, jsonResult, newRequestId, type HandlerResult } from './httputil.ts';

/** The largest request body accepted (packs from the suite stay far below this). */
const MAX_BODY_BYTES = 256 * 1024 * 1024;

/** A shared empty query set for requests that carry no query string (never mutated). */
const EMPTY_QUERY = new URLSearchParams();

/** The path and query of a request URL, or '/' when it does not parse. */
function urlOf(req: IncomingMessage): { path: string; query: URLSearchParams } {
  const raw = req.url ?? '/';
  // Fast path: most requests carry a plain path with no query string, no escapes
  // and no dot segments — take it as-is instead of building a URL object.
  if (
    raw.startsWith('/') &&
    !raw.startsWith('//') &&
    !raw.includes('?') &&
    !raw.includes('%') &&
    !raw.includes('/.')
  ) {
    return { path: raw, query: EMPTY_QUERY };
  }
  try {
    const url = new URL(raw, 'http://entry');
    return { path: url.pathname, query: url.searchParams };
  } catch {
    return { path: '/', query: EMPTY_QUERY };
  }
}

/** Read a request body to a Buffer; a body over the cap rejects. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The Authorization header matches the configured token (any token when none is set). */
function authorized(req: IncomingMessage, expectedToken: string): boolean {
  if (expectedToken === '') return true;
  return (req.headers.authorization ?? '') === `Bearer ${expectedToken}`;
}

/** Write a handler's result to the socket, with X-GitHub-Request-Id on every reply. */
function sendResult(res: ServerResponse, result: HandlerResult): void {
  const isString = typeof result.body === 'string';
  const length = isString ? Buffer.byteLength(result.body, 'utf8') : result.body.length;
  res.writeHead(result.status, {
    'content-type': result.contentType,
    'content-length': length,
    'x-github-request-id': newRequestId(),
    ...(result.headers ?? {}),
  });
  res.end(result.body);
}

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** One request, end to end: auth, body, routing, and the reply. */
async function handleRequest(forge: Forge, expectedToken: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { path, query } = urlOf(req);
  const method = req.method ?? 'GET';

  // The env's boot check calls this twice: 200 {"ok":true}, no auth.
  if (method === 'GET' && path === '/healthz') {
    sendResult(res, jsonResult(200, { ok: true }));
    return;
  }

  // The GitHub API root: a 200 with the token's scopes, as api.github.com answers GET /.
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendResult(res, jsonResult(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' }));
    return;
  }

  // Everything else needs the token.
  if (!authorized(req, expectedToken)) {
    sendResult(res, errorResult(401, 'Bad credentials'));
    return;
  }

  // GET and HEAD requests carry no body in this suite: when the request frames
  // none (no content-length, no chunked encoding), skip the body read entirely
  // instead of waiting a tick for the stream's end event.
  const hasBodyFrame = req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined;
  const body = (method === 'GET' || method === 'HEAD') && !hasBodyFrame ? Buffer.alloc(0) : await readBody(req);

  // Git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}.
  const gitMatch = GIT_ROUTE.exec(path);
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1]!);
    const repoName = decodeURIComponent(gitMatch[2]!);
    const service = gitMatch[3]!;
    const gitProtocol = typeof req.headers['git-protocol'] === 'string' ? req.headers['git-protocol'] : null;
    if (service === 'info/refs' && method === 'GET') {
      sendResult(res, gitInfoRefs(forge, owner, repoName, query.get('service'), gitProtocol));
      return;
    }
    if (service === 'git-upload-pack' && method === 'POST') {
      sendResult(res, gitUploadPack(forge, owner, repoName, body, gitProtocol));
      return;
    }
    if (service === 'git-receive-pack' && method === 'POST') {
      sendResult(res, gitReceivePack(forge, owner, repoName, body));
      return;
    }
    sendResult(res, errorResult(405, 'Method Not Allowed'));
    return;
  }

  // GraphQL v4: POST /api/graphql, one operation or a batch.
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendResult(res, errorResult(405, 'Method Not Allowed'));
      return;
    }
    let json: unknown;
    let jsonError = false;
    if (body.length > 0) {
      try {
        json = JSON.parse(body.toString('utf8')) as unknown;
      } catch {
        jsonError = true;
      }
    }
    sendResult(res, handleGraphQL(forge, json, jsonError));
    return;
  }

  // MCP: POST /mcp, JSON-RPC 2.0.
  if (path === '/mcp') {
    if (method !== 'POST') {
      sendResult(res, errorResult(405, 'Method Not Allowed'));
      return;
    }
    sendResult(res, handleMcp(forge, body));
    return;
  }

  // REST v3: /api/v3/...
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const restPath = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
    const segments = restPath === '' ? [] : restPath.split('/').map((segment) => (segment.includes('%') ? decodeURIComponent(segment) : segment));
    let json: unknown;
    let jsonError = false;
    if (body.length > 0) {
      try {
        json = JSON.parse(body.toString('utf8')) as unknown;
      } catch {
        jsonError = true;
      }
    }
    const host = req.headers.host ?? 'localhost';
    sendResult(
      res,
      handleRest({
        forge,
        method,
        segments,
        query,
        json,
        jsonError,
        origin: `http://${host}`,
      }),
    );
    return;
  }

  // Everything else, every method: GitHub's 404 body.
  sendResult(res, errorResult(404, 'Not Found'));
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    handleRequest(forge, expectedToken, req, res).catch((err: unknown) => {
      process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
      try {
        if (!res.headersSent) sendResult(res, errorResult(500, 'Internal Server Error'));
      } catch {
        // The socket is already gone; nothing left to answer.
      }
    });
  });
  return server;
}
