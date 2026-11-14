// httputil.ts — the small shared surface every handler returns through: a status, a
// content type, extra headers and a body. app.ts writes it to the socket.

import { randomBytes } from 'node:crypto';

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

/** A JSON error result with GitHub's {message} shape. */
export function errorResult(status: number, message: string): HandlerResult {
  return jsonResult(status, { message });
}

/** A fresh per-request id for X-GitHub-Request-Id (never in any scored state). */
export function newRequestId(): string {
  return randomBytes(8).toString('hex');
}
