import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeHandler } from '../server/node.ts';
import { vercelHandler } from '../server/vercel.ts';

let server: Server | undefined;
afterEach(() => server?.close());

async function serve(listener: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(listener);
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe('Node adapter', () => {
  it('passes the exact body bytes, method, headers and query through, and every Set-Cookie back', async () => {
    const base = await serve(
      nodeHandler(async (req) => {
        const bytes = new Uint8Array(await req.arrayBuffer());
        const headers = new Headers({ 'Content-Type': 'application/json' });
        headers.append('Set-Cookie', 'a=1; Path=/');
        headers.append('Set-Cookie', 'b=2; Path=/');
        const url = new URL(req.url);
        return new Response(JSON.stringify({ method: req.method, path: url.pathname, q: url.searchParams.get('q'), sig: req.headers.get('stripe-signature'), bytes: [...bytes] }), { status: 201, headers });
      }),
    );
    const body = new Uint8Array([123, 34, 195, 169, 34, 125]); // {"é"} as UTF-8
    const res = await fetch(`${base}/api/x?q=1`, { method: 'POST', body, headers: { 'Stripe-Signature': 't=1,v1=abc' } });
    expect(res.status).toBe(201);
    expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    expect(await res.json()).toEqual({ method: 'POST', path: '/api/x', q: '1', sig: 't=1,v1=abc', bytes: [...body] });
  });

  it('refuses bodies over 1 MB', async () => {
    const base = await serve(nodeHandler(async () => new Response('ok')));
    const res = await fetch(`${base}/api/x`, { method: 'POST', body: new Uint8Array(1024 * 1024 + 1) });
    expect(res.status).toBe(413);
  });
});

describe('Vercel entry', () => {
  it('routes by the original path when the platform hands over the rewritten URL', async () => {
    const base = await serve(vercelHandler({}));
    const res = await fetch(`${base}/api?__path=/api/config`);
    expect(await res.json()).toMatchObject({ hosted: false });
    // And ignores a __path that isn't an API path, or when the real path is already there.
    expect((await fetch(`${base}/api?__path=/etc/passwd`)).status).toBe(503);
    expect((await fetch(`${base}/api/me?__path=/api/config`)).status).toBe(503);
  });

  it('works when the platform keeps the original URL', async () => {
    const base = await serve(vercelHandler({}));
    expect((await fetch(`${base}/api/config`)).status).toBe(200);
  });
});
