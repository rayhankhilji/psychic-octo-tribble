import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Bridges Node's http (the local server, and Vercel's Node.js launcher,
 * which calls `(req, res)`) to the web-standard handler in `app.ts`.
 */

/** API bodies are small JSON; Stripe webhook events stay well under this. */
const MAX_BODY_BYTES = 1024 * 1024;

export class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<Buffer> {
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

/** `pathOverride` lets a rewrite pass the original path through (see `server/vercel.ts`). */
export async function toWebRequest(req: IncomingMessage, pathOverride?: string): Promise<Request> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (pathOverride) url.pathname = pathOverride;
  // The origin isn't trusted for anything (redirect URIs come from APP_URL), so a fixed host is fine.
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const host = typeof req.headers.host === 'string' && /^[\w.:-]+$/.test(req.headers.host) ? req.headers.host : 'localhost';
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
  }
  const method = req.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
  return new Request(`${proto}://${host}${url.pathname}${url.search}`, { method, headers, ...(body ? { body: new Uint8Array(body) } : {}) });
}

export async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((v, k) => {
    if (k !== 'set-cookie') headers[k] = v;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
}

/** A Node `(req, res)` listener around a web handler. */
export function nodeHandler(handle: (req: Request) => Promise<Response>, pathOf?: (req: IncomingMessage) => string | undefined) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const request = await toWebRequest(req, pathOf?.(req));
      await sendWebResponse(res, await handle(request));
    } catch (err) {
      const tooLarge = err instanceof BodyTooLarge;
      if (!tooLarge) console.error(`API adapter failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      if (!res.headersSent) res.writeHead(tooLarge ? 413 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: tooLarge ? 'That request is too large.' : 'Something went wrong on our side.' }));
    }
  };
}
