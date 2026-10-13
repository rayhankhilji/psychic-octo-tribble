import type { IncomingMessage, ServerResponse } from 'node:http';
import { API_CSP, API_HTML_CSP, BASE_SECURITY_HEADERS } from './http.ts';

/**
 * Bridges Node's http (the local server, and Vercel's Node.js launcher,
 * which calls `(req, res)`) to the web-standard handler in `app.ts`.
 *
 * Everything the API answers passes through here, so this is also where
 * every response gets its security headers (the ones a handler set itself
 * win) and where cross-origin preflights are turned away.
 */

/** API bodies are small JSON; Stripe webhook events stay well under this. */
const MAX_BODY_BYTES = 1024 * 1024;

export class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  // Refuse an announced oversize body without reading it.
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) throw new BodyTooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += b.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

export interface AdapterOptions {
  /** Rewrites can pass the original path through (see `server/vercel.ts`). */
  pathOf?: (req: IncomingMessage) => string | undefined;
  /**
   * True on Vercel, whose edge sets `X-Real-IP` and `X-Forwarded-For`
   * itself. Anywhere else those headers come from the caller and can say
   * anything, so they're replaced with the socket's address.
   */
  behindProxy?: boolean;
}

export async function toWebRequest(req: IncomingMessage, o: AdapterOptions = {}): Promise<Request> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathOverride = o.pathOf?.(req);
  if (pathOverride) url.pathname = pathOverride;
  // The origin isn't trusted for anything (redirect URIs come from APP_URL), so a fixed host is fine.
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const host = typeof req.headers.host === 'string' && /^[\w.:-]+$/.test(req.headers.host) ? req.headers.host : 'localhost';
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (!o.behindProxy && (k === 'x-real-ip' || k === 'x-forwarded-for')) continue;
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
  }
  if (!o.behindProxy && req.socket?.remoteAddress) headers.set('x-real-ip', req.socket.remoteAddress);
  const method = req.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
  return new Request(`${proto}://${host}${url.pathname}${url.search}`, { method, headers, ...(body ? { body: new Uint8Array(body) } : {}) });
}

/**
 * Fills in the security headers a response didn't set itself. JSON gets a
 * policy that forbids everything (it's data, not a page); the odd HTML page
 * gets one that allows its own inline styles.
 */
export function withSecurityHeaders(response: Response): Headers {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(BASE_SECURITY_HEADERS)) if (!headers.has(k)) headers.set(k, v);
  if (!headers.has('Content-Security-Policy')) {
    const html = (headers.get('Content-Type') ?? '').startsWith('text/html');
    headers.set('Content-Security-Policy', html ? API_HTML_CSP : API_CSP);
  }
  if (!headers.has('Cross-Origin-Resource-Policy')) headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  // The API is same-origin only. Nothing may opt a route into cross-origin
  // reads by accident; a deliberate public endpoint would need changing this.
  headers.delete('Access-Control-Allow-Origin');
  headers.delete('Access-Control-Allow-Credentials');
  return headers;
}

export async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const out: Record<string, string | string[]> = {};
  const headers = withSecurityHeaders(response);
  headers.forEach((v, k) => {
    if (k !== 'set-cookie') out[k] = v;
  });
  const cookies = headers.getSetCookie();
  if (cookies.length) out['set-cookie'] = cookies;
  res.writeHead(response.status, out);
  res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
}

/**
 * A CORS preflight (or any OPTIONS). The browser app is served from the same
 * origin and never needs one, so the answer grants nothing: without
 * `Access-Control-Allow-Origin` the browser stops a cross-site page from
 * sending its request at all.
 */
const preflight = () => new Response(null, { status: 204, headers: { Allow: 'GET, HEAD, POST, PUT, PATCH, DELETE', 'Cache-Control': 'no-store' } });

/** A Node `(req, res)` listener around a web handler. */
export function nodeHandler(handle: (req: Request) => Promise<Response>, opts: AdapterOptions | ((req: IncomingMessage) => string | undefined) = {}) {
  const o: AdapterOptions = typeof opts === 'function' ? { pathOf: opts } : opts;
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method === 'OPTIONS') return await sendWebResponse(res, preflight());
      const request = await toWebRequest(req, o);
      await sendWebResponse(res, await handle(request));
    } catch (err) {
      const tooLarge = err instanceof BodyTooLarge;
      if (!tooLarge) console.error(`API adapter failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      if (!res.headersSent) {
        const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
        withSecurityHeaders(new Response(null, { headers })).forEach((v, k) => (headers[k] = v));
        res.writeHead(tooLarge ? 413 : 500, headers);
      }
      res.end(JSON.stringify({ error: tooLarge ? 'That request is too large.' : 'Something went wrong on our side.' }));
    }
  };
}
