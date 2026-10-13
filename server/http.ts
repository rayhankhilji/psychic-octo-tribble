import type { ApiError, ErrorCode } from '../src/api/contract.ts';

/** A failure with a status the router turns into `{ error, code }`. Messages are written for the founder. */
export class HttpError extends Error {
  status: number;
  code: ErrorCode | undefined;
  constructor(status: number, message: string, code?: ErrorCode) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message: string) => new HttpError(400, message, 'bad_request');
export const notConfigured = (what: string) => new HttpError(503, `${what} isn't set up on this server.`, 'not_configured');
export const upstream = (message: string) => new HttpError(502, message, 'upstream');

const API_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...API_HEADERS, ...headers } });
}

export function errorResponse(err: HttpError): Response {
  const body: ApiError = { error: err.message, ...(err.code ? { code: err.code } : {}) };
  return json(body, err.status, err.status === 429 ? { 'Retry-After': '60' } : {});
}

/** A browser redirect after an OAuth callback. Relative, so it always lands on this deployment. */
export function redirect(location: string, headers: Headers = new Headers()): Response {
  headers.set('Location', location);
  headers.set('Cache-Control', 'no-store');
  // The callback URL carries a one-time code; keep it out of Referer headers.
  headers.set('Referrer-Policy', 'no-referrer');
  return new Response(null, { status: 302, headers });
}

/** Most request bodies are tiny; anything bigger than this is a mistake or an attack. */
const MAX_JSON_BYTES = 16 * 1024;

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > MAX_JSON_BYTES) throw new HttpError(413, 'That request is too large.', 'bad_request');
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw badRequest('Expected a JSON body.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Expected a JSON object.');
  return body as Record<string, unknown>;
}

export function bearer(req: Request): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('Authorization') ?? '');
  return m ? m[1]! : null;
}

export function cookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get('Cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
