// httputil.ts — the small shared surface every handler returns through: a status, a
// content type, extra headers and a body. app.ts writes it to the socket.

export interface HandlerResult {
  status: number;
  contentType: string;
  headers?: Record<string, string>;
  body: Buffer | string;
}

export const JSON_TYPE = 'application/json; charset=utf-8';

/** A JSON result; the body is the value stringified with a trailing newline. */
export function jsonResult(status: number, value: unknown, headers: Record<string, string> = {}): HandlerResult {
  return { status, contentType: JSON_TYPE, headers, body: `${JSON.stringify(value)}\n` };
}

/** A JSON result from an already-serialised body (used with cached serialisations). */
export function jsonRawResult(status: number, body: string, headers: Record<string, string> = {}): HandlerResult {
  return { status, contentType: JSON_TYPE, headers, body };
}

/** A JSON error result with GitHub's {message} shape. */
export function errorResult(status: number, message: string): HandlerResult {
  return jsonResult(status, { message });
}

/** A fresh per-request id for X-GitHub-Request-Id (never in any scored state). */
let requestCounter = 0;
export function newRequestId(): string {
  requestCounter += 1;
  return requestCounter.toString(16).padStart(16, '0');
}
