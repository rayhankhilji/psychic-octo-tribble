import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-ignore: a plain .mjs build script (run by Node directly), typed below.
import * as buildVercel from '../server/build-vercel.mjs';
import { rateLimit, resetContextCaches, type Ctx } from '../server/context.ts';
import { checkEnv, decryptionKeys, settings } from '../server/env.ts';
import { BASE_SECURITY_HEADERS, HttpError, clientIp, errorResponse, readJson, redirect, siteCsp } from '../server/http.ts';
import { nodeHandler } from '../server/node.ts';
import { storedKey } from '../server/ratelimit.ts';
import { vercelHandler } from '../server/vercel.ts';
import { ENV, FakeSupabase, GITHUB_PEM, call, setup } from './server-helpers.ts';

interface Route {
  src?: string;
  dest?: string;
  status?: number;
  handle?: string;
  headers?: Record<string, string>;
  continue?: boolean;
}
interface Cron {
  path: string;
  schedule: string;
}
const { FUNCTION_CONFIG, crons, outputConfig } = buildVercel as {
  FUNCTION_CONFIG: Record<string, unknown>;
  crons: (env?: Record<string, string | undefined>) => Cron[];
  outputConfig: (env?: Record<string, string | undefined>) => { version: 3; routes: Route[]; crons: Cron[] };
};

// ─── A shared counter that behaves like public.rate_hit() ─────────────────

interface RpcCall {
  key: string;
  windowS: number;
  max: number;
}

/** Stubs fetch: rate_hit answered by `rpc`, everything else by the fake Supabase. */
function stubRpc(db: FakeSupabase, rpc: (body: RpcCall, init: RequestInit) => Response | Promise<Response>) {
  const calls: RpcCall[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.origin === ENV.SUPABASE_URL && url.pathname === '/rest/v1/rpc/rate_hit') {
      expect(new Headers(init.headers).get('apikey')).toBe('service');
      const b = JSON.parse(String(init.body)) as { p_key: string; p_window_s: number; p_max: number };
      const c = { key: b.p_key, windowS: b.p_window_s, max: b.p_max };
      calls.push(c);
      return rpc(c, init);
    }
    const res = await db.handle(url, init);
    if (res) return res;
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return calls;
}

/** An in-memory rate_hit with the same fixed-window rule as the SQL. */
function countingRpc() {
  const hits = new Map<string, number>();
  return (c: RpcCall) => {
    const n = (hits.get(c.key) ?? 0) + 1;
    hits.set(c.key, n);
    return Response.json([{ allowed: n <= c.max, retry_after_s: 42 }]);
  };
}

const ctx = (env: Record<string, string | undefined> = ENV): Ctx => {
  const req = new Request('https://tinytown.test/api/x');
  return { req, url: new URL(req.url), env, s: settings(env), now: 1_000_000 };
};

let db: FakeSupabase;
beforeEach(() => {
  db = setup();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('rate limits', () => {
  it('the memory layer alone counts a fixed window and says when to come back', async () => {
    for (let i = 0; i < 3; i++) await rateLimit('k', 3, 0);
    let err: unknown;
    try {
      await rateLimit('k', 3, 20_000);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(429);
    expect(errorResponse(err as HttpError).headers.get('Retry-After')).toBe('40');
    // A new window opens after a minute.
    await rateLimit('k', 3, 60_000);
  });

  it('throws synchronously from memory, so callers that never awaited it keep working', () => {
    rateLimit('sync', 1, 0);
    expect(() => rateLimit('sync', 1, 1)).toThrow(HttpError);
  });

  it('counts in Postgres across instances, with hashed keys', async () => {
    const calls = stubRpc(db, countingRpc());
    const c = ctx();
    await rateLimit(`checkout:${'u1'}`, 2, c.now, { ctx: c });
    // Another instance: its memory is empty, the shared count is not.
    resetContextCaches();
    await rateLimit('checkout:u1', 2, c.now, { ctx: c });
    resetContextCaches();
    await expect(rateLimit('checkout:u1', 2, c.now, { ctx: c })).rejects.toMatchObject({ status: 429, retryAfter: 42 });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({ key: storedKey('checkout:u1'), windowS: 60, max: 2 });
    expect(calls[0]!.key).not.toContain('u1');
  });

  it('asks the database nothing once memory already says no', async () => {
    const calls = stubRpc(db, countingRpc());
    const c = ctx();
    await rateLimit('m', 1, c.now, { ctx: c });
    expect(() => rateLimit('m', 1, c.now, { ctx: c })).toThrow(HttpError);
    expect(calls).toHaveLength(1);
  });

  it('fails open when the database errors or is slow, logs once, then skips it for a while', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let n = 0;
    const calls = stubRpc(db, () => {
      n++;
      return Response.json({ message: 'down' }, { status: 503 });
    });
    const c = ctx();
    await rateLimit('open', 1, c.now, { ctx: c });
    resetContextCaches(); // a fresh instance would try again
    // Never answers; only the timeout ends it, as with a real hung connection.
    stubRpc(db, (_, init) => new Promise<Response>((_ok, fail) => init.signal?.addEventListener('abort', () => fail(init.signal!.reason))));
    const t0 = Date.now();
    await rateLimit('open', 1, c.now, { ctx: c });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1]![0])).toMatch(/no answer in 500 ms/);
    // The breaker is now open: the next limit doesn't wait on the database at all.
    stubRpc(db, () => {
      throw new Error('should not be called');
    });
    await rateLimit('open', 5, c.now + 1000, { ctx: c });
    expect(n + calls.length).toBeGreaterThan(0);
  });

  it('fails closed for sign-in and webhooks, even with the breaker open', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubRpc(db, () => Response.json({}, { status: 500 }));
    const c = ctx();
    await rateLimit('open-first', 5, c.now, { ctx: c }); // trips the breaker
    const calls = stubRpc(db, () => Response.json({}, { status: 500 }));
    await expect(rateLimit('signin:1.2.3.4', 5, c.now, { ctx: c, failClosed: true })).rejects.toMatchObject({ status: 503, retryAfter: 30 });
    expect(calls).toHaveLength(1);
    // And when the database is fine, fail-closed limits behave like any other.
    stubRpc(db, countingRpc());
    await rateLimit('signin:5.6.7.8', 1, c.now, { ctx: c, failClosed: true });
  });

  it('a shared failure on a call nobody awaited does not crash the process', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    stubRpc(db, () => Response.json([{ allowed: false, retry_after_s: 9 }]));
    const c = ctx();
    void rateLimit('fire-and-forget', 5, c.now, { ctx: c });
    await new Promise((r) => setTimeout(r, 20));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('uses whole-second windows and keeps memory windows of different lengths apart', async () => {
    const calls = stubRpc(db, countingRpc());
    const c = ctx();
    await rateLimit('w', 1, c.now, { ctx: c, windowS: 3600.4 });
    await rateLimit('w', 1, c.now, { ctx: c, windowS: 10 }).catch(() => {});
    expect(calls.map((x) => x.windowS)).toEqual([3600, 10]);
  });

  it('without Supabase, never calls out', async () => {
    const calls = stubRpc(db, countingRpc());
    await rateLimit('local', 5, 0, { ctx: ctx({}) });
    expect(calls).toHaveLength(0);
  });
});

// ─── Headers on the built site and the API ────────────────────────────────

const directives = (csp: string) => Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k!, v]));

describe('the static site headers (Build Output config)', () => {
  const config = outputConfig({ SUPABASE_URL: 'https://abcd.supabase.co' });
  const siteRoute = config.routes[0] as { src: string; headers: Record<string, string>; continue: boolean };

  it('puts every security header on every non-API path', () => {
    const re = new RegExp(siteRoute.src);
    for (const p of ['/', '/index.html', '/assets/index-abc.js', '/favicon.svg', '/some/spa/path', '/apiary']) expect(re.test(p), p).toBe(true);
    for (const p of ['/api', '/api/config']) expect(re.test(p), p).toBe(false);
    expect(siteRoute.continue).toBe(true);
    for (const [k, v] of Object.entries(BASE_SECURITY_HEADERS)) expect(siteRoute.headers[k]).toBe(v);
    expect(siteRoute.headers['Strict-Transport-Security']).toMatch(/max-age=63072000/);
    expect(siteRoute.headers['X-Frame-Options']).toBe('DENY');
    expect(siteRoute.headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(siteRoute.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(siteRoute.headers['Permissions-Policy']).toMatch(/camera=\(\)/);
  });

  it('has a strict CSP: no inline or eval scripts, only the sources the app uses', () => {
    const d = directives(siteRoute.headers['Content-Security-Policy']!);
    expect(d['script-src']).toEqual(["'self'", 'https://challenges.cloudflare.com']);
    expect(d['frame-src']).toEqual(['https://challenges.cloudflare.com']);
    expect(d['connect-src']).toEqual(["'self'", 'https://abcd.supabase.co']);
    expect(d['frame-ancestors']).toEqual(["'none'"]);
    expect(d['object-src']).toEqual(["'none'"]);
    expect(d['worker-src']).toEqual(["'self'", 'blob:']);
    expect(d['img-src']).toEqual(["'self'", 'data:', 'blob:']);
    expect(d['font-src']).toContain('https://fonts.gstatic.com');
    expect(d['style-src']).toContain('https://fonts.googleapis.com');
    const csp = siteRoute.headers['Content-Security-Policy']!;
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('api.stripe.com');
    expect(csp).not.toMatch(/(^|\s)\*(\s|;|$)/);
  });

  it('falls back to any Supabase project when the URL is unknown at build time, and allows the Vercel Toolbar only on previews', () => {
    expect(directives(siteCsp())['connect-src']).toEqual(["'self'", 'https://*.supabase.co']);
    expect(directives(siteCsp({ supabaseUrl: 'not a url' }))['connect-src']).toEqual(["'self'", 'https://*.supabase.co']);
    expect(siteCsp()).not.toContain('vercel.live');
    const preview = directives(outputConfig({ VERCEL_ENV: 'preview' }).routes[0]!.headers!['Content-Security-Policy']!);
    expect(preview['script-src']).toContain('https://vercel.live');
    expect(preview['connect-src']).toContain('wss://ws-us3.pusher.com');
  });

  it('caches hashed assets for a year and revalidates pages', () => {
    // Header routes before the filesystem phase apply to real files; the fallback is checked separately.
    const before = config.routes.slice(0, config.routes.findIndex((r) => 'handle' in r));
    const route = (path: string) => before.filter((r) => 'src' in r && 'headers' in r && new RegExp(r.src!).test(path) && r.headers!['Cache-Control']).map((r) => r.headers!['Cache-Control']);
    expect(route('/assets/three-abc123.js')).toEqual(['public, max-age=31536000, immutable']);
    expect(route('/')[0]).toBe('no-cache');
    expect(route('/index.html')[0]).toBe('no-cache');
    expect(route('/legal/privacy.html')[0]).toBe('no-cache');
    expect(route('/og.png')).toEqual([]);
    // The SPA fallback serves index.html for any other path, also revalidated.
    const fallback = config.routes.at(-1) as { dest: string; headers: Record<string, string> };
    expect(fallback.dest).toBe('/index.html');
    expect(fallback.headers['Cache-Control']).toBe('no-cache');
  });

  it('sends missing files and legal pages to the branded 404, and app paths to the app', () => {
    const after = config.routes.slice(config.routes.findIndex((r) => r.handle === 'filesystem') + 1);
    const served = (path: string) => after.find((r) => new RegExp(r.src!).test(path))!;
    for (const p of ['/legal/missing.html', '/legal/whatever', '/missing.png', '/assets/old-abc123.js']) {
      expect(served(p), p).toMatchObject({ status: 404, dest: '/404.html' });
    }
    for (const p of ['/', '/some/app/path']) expect(served(p).dest, p).toBe('/index.html');
    expect(served('/api/cron/daily').dest).toBe('/api?__path=$1');
  });

  it('schedules the three crons, and can leave out the hourly one for Hobby', () => {
    expect(config.crons).toEqual([
      { path: '/api/cron/hourly', schedule: '7 * * * *' },
      { path: '/api/cron/daily', schedule: '17 3 * * *' },
      { path: '/api/cron/weekly', schedule: '23 15 * * 1' },
    ]);
    expect(crons({ CRON_HOURLY: 'off' }).map((c) => c.path)).toEqual(['/api/cron/daily', '/api/cron/weekly']);
    // Every cron path is routed to the function.
    const api = config.routes.find((r) => 'dest' in r && r.dest?.startsWith('/api?'))!;
    for (const c of config.crons) expect(new RegExp(api.src!).test(c.path)).toBe(true);
  });

  it('gives the function a minute and raw request bodies', () => {
    expect(FUNCTION_CONFIG).toMatchObject({ runtime: 'nodejs22.x', maxDuration: 60, shouldAddHelpers: false, launcherType: 'Nodejs' });
  });

  const built = join(import.meta.dirname, '../.vercel/output/config.json');
  it.skipIf(!existsSync(built))('the last real build wrote the same headers and crons', () => {
    const real = JSON.parse(readFileSync(built, 'utf8')) as ReturnType<typeof outputConfig>;
    expect(real.routes[0]!.headers!['X-Frame-Options']).toBe('DENY');
    expect(real.routes[0]!.headers!['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(real.crons.map((c) => c.path)).toContain('/api/cron/daily');
  });
});

// ─── The API: headers, CORS, OPTIONS, bodies, redirects ──────────────────

let server: Server | undefined;
afterEach(() => server?.close());

async function serve(listener: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(listener);
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe('API responses', () => {
  it('carry security headers and a lock-everything CSP, whatever the handler set', async () => {
    const base = await serve(vercelHandler({}));
    const res = await fetch(`${base}/api/config`);
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('strict-transport-security')).toMatch(/max-age=/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    // Errors too.
    const err = await fetch(`${base}/api/me`);
    expect(err.status).toBe(503);
    expect(err.headers.get('x-frame-options')).toBe('DENY');
  });

  it('let an HTML page keep its own policy, or give it one with inline styles', async () => {
    const own = await serve(nodeHandler(async () => new Response('<p>hi</p>', { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'self'" } })));
    expect((await fetch(`${own}/api/x`)).headers.get('content-security-policy')).toBe("default-src 'self'");
    server!.close();
    const bare = await serve(nodeHandler(async () => new Response('<p>hi</p>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
    expect((await fetch(`${bare}/api/x`)).headers.get('content-security-policy')).toContain("style-src 'unsafe-inline'");
  });

  it('are same-origin only: preflights grant nothing, and no route can opt into CORS by accident', async () => {
    const base = await serve(vercelHandler(ENV));
    const pre = await fetch(`${base}/api/world/actions`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
    expect(pre.headers.get('access-control-allow-headers')).toBeNull();
    server!.close();
    const leaky = await serve(nodeHandler(async () => Response.json({}, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Credentials': 'true' } })));
    const res = await fetch(`${leaky}/api/x`, { headers: { Origin: 'https://evil.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('no route in the router sets CORS headers', async () => {
    const paths: [string, string][] = [
      ['GET', '/api/config'],
      ['GET', '/api/me'],
      ['POST', '/api/billing/checkout'],
      ['POST', '/api/billing/webhook'],
      ['GET', '/api/connect/stripe/callback'],
    ];
    vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => (await db.handle(new URL(String(input)), init)) ?? Response.json({}, { status: 500 }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const [method, path] of paths) {
      const res = await call(method, path, { headers: { Origin: 'https://evil.example' }, token: null });
      expect(res.headers.get('access-control-allow-origin'), `${method} ${path}`).toBeNull();
    }
  });

  it('refuse oversized bodies, announced or not', async () => {
    await expect(readJson(new Request('https://x.test', { method: 'POST', body: '{}', headers: { 'Content-Length': String(20_000) } }))).rejects.toMatchObject({ status: 413 });
    await expect(readJson(new Request('https://x.test', { method: 'POST', body: JSON.stringify({ a: 'x'.repeat(17_000) }) }))).rejects.toMatchObject({ status: 413 });
    // Multi-byte characters count as bytes, not characters.
    await expect(readJson(new Request('https://x.test', { method: 'POST', body: JSON.stringify({ a: 'é'.repeat(9_000) }) }))).rejects.toMatchObject({ status: 413 });
    await expect(readJson(new Request('https://x.test', { method: 'POST', body: '[1]' }))).rejects.toMatchObject({ status: 400 });
    await expect(readJson(new Request('https://x.test', { method: 'POST', body: new Uint8Array([0x7b, 0xff, 0x7d]) }))).rejects.toMatchObject({ status: 400 });
    expect(await readJson(new Request('https://x.test', { method: 'POST', body: '{"__proto__":{"admin":true}}' }))).not.toHaveProperty('admin');
  });

  it('redirect only within the site', () => {
    expect(redirect('/?connected=stripe').headers.get('Location')).toBe('/?connected=stripe');
    for (const bad of ['//evil.example/', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', '/ok\r\nSet-Cookie: x=1']) {
      expect(() => redirect(bad), bad).toThrow();
    }
  });

  it("trust X-Real-IP only from Vercel's edge", async () => {
    const seen: string[] = [];
    const echo = async (req: Request) => {
      seen.push(clientIp(req));
      return new Response('ok');
    };
    let base = await serve(nodeHandler(echo));
    await fetch(`${base}/api/x`, { headers: { 'X-Real-IP': '6.6.6.6', 'X-Forwarded-For': '6.6.6.6' } });
    server!.close();
    base = await serve(nodeHandler(echo, { behindProxy: true }));
    await fetch(`${base}/api/x`, { headers: { 'X-Real-IP': '9.9.9.9' } });
    expect(seen[0]).toMatch(/127\.0\.0\.1/);
    expect(seen[1]).toBe('9.9.9.9');
  });
});

// ─── Supabase: every table locked down ────────────────────────────────────

const MIGRATIONS = join(import.meta.dirname, '../supabase/migrations');

/** Comments out, whitespace collapsed, lower case: enough to read our own DDL. */
function sqlOf(file: string): string {
  return readFileSync(join(MIGRATIONS, file), 'utf8')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' $$body$$ ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const ident = (name: string) => name.replace(/"/g, '').replace(/^public\./, '');

describe('Supabase migrations', () => {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  const all = files.map(sqlOf).join(' ');

  it('are numbered, and there is at least the first one', () => {
    expect(files[0]).toBe('0001_init.sql');
    for (const f of files) expect(f).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
  });

  for (const file of files) {
    const sql = sqlOf(file);
    const tables = [...sql.matchAll(/create (?:unlogged )?table (?:if not exists )?([\w."]+)/g)].map((m) => ident(m[1]!));
    const where = (name: string) => `public.${name} in ${file}`;

    it(`${file}: every table has row-level security on`, () => {
      for (const t of tables) {
        const on = new RegExp(`alter table (?:if exists )?(?:only )?(?:public\\.)?"?${t}"? enable row level security`);
        expect(on.test(all), `${where(t)} needs: alter table public.${t} enable row level security;`).toBe(true);
      }
    });

    it(`${file}: no table is granted to the browser roles`, () => {
      for (const t of tables) {
        const revoked = [...all.matchAll(/revoke all (?:privileges )?on (?:table )?([^;]+?) from ([^;]+);/g)].some(
          (m) => m[1]!.split(',').map((x) => ident(x.trim())).includes(t) && /\banon\b/.test(m[2]!) && /\bauthenticated\b/.test(m[2]!),
        );
        expect(revoked, `${where(t)} needs: revoke all on table public.${t} from anon, authenticated;`).toBe(true);
      }
      expect(sql, `${file} grants something to anon or authenticated`).not.toMatch(/grant [^;]* to [^;]*\b(anon|authenticated|public)\b/);
    });

    it(`${file}: no policies (the browser never reads tables directly)`, () => {
      expect(sql).not.toMatch(/create policy/);
    });

    it(`${file}: security-definer functions pin their search path and are the server's alone`, () => {
      for (const m of sql.matchAll(/create (?:or replace )?function ([\w."]+)\s*\(([^)]*)\)([^;]*?)as \$\$body\$\$/g)) {
        const name = ident(m[1]!);
        const attrs = m[3]!;
        if (!/security definer/.test(attrs)) continue;
        expect(attrs, `${name}: set search_path = ''`).toMatch(/set search_path = ''/);
        const revoke = new RegExp(`revoke (?:all|execute) on function (?:public\\.)?${name}\\s*\\([^)]*\\) from ([^;]+);`).exec(all);
        expect(revoke?.[1], `${name} must be revoked from public, anon, authenticated`).toMatch(/public/);
        expect(revoke?.[1]).toMatch(/anon/);
        expect(revoke?.[1]).toMatch(/authenticated/);
      }
    });
  }

  it('the lint itself catches a table without RLS', () => {
    const sql = 'create table public.leaky (id int); revoke all on table public.leaky from anon, authenticated;'.toLowerCase();
    const tables = [...sql.matchAll(/create (?:unlogged )?table (?:if not exists )?([\w."]+)/g)].map((m) => ident(m[1]!));
    expect(tables).toEqual(['leaky']);
    expect(/alter table (?:public\.)?leaky enable row level security/.test(sql)).toBe(false);
  });
});

// ─── Configuration checks ─────────────────────────────────────────────────

describe('environment checks', () => {
  const errors = (env: Record<string, string>) => checkEnv(env).filter((p) => p.level === 'error').map((p) => p.message);
  const warnings = (env: Record<string, string>) => checkEnv(env).filter((p) => p.level === 'warning').map((p) => p.message);

  it('is quiet for the demo and for a complete setup', () => {
    expect(checkEnv({})).toEqual([]);
    expect(errors({ ...ENV, STRIPE_APP_SECRET_KEY: 'sk_test_app', TOKEN_ENCRYPTION_KEY: ENV.TOKEN_ENCRYPTION_KEY, STATE_SECRET: 'x'.repeat(44) })).toEqual([]);
  });

  it('refuses a billing key without its webhook secret, and says why', () => {
    const { STRIPE_WEBHOOK_SECRET: _, ...env } = ENV;
    const e = errors(env);
    expect(e.join('\n')).toMatch(/Billing is half set up: .* STRIPE_WEBHOOK_SECRET is missing/);
    expect(e.join('\n')).toMatch(/could pay and never get in/);
  });

  it('names what is missing from each half-configured group', () => {
    expect(errors({ SUPABASE_URL: 'https://abcd.supabase.co' })[0]).toBe(
      'Supabase (accounts) is half set up: SUPABASE_URL is set but SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY are missing.',
    );
    expect(errors({ ...ENV, GITHUB_APP_CLIENT_SECRET: '' }).join('\n')).toMatch(/GitHub App is half set up: .* GITHUB_APP_CLIENT_SECRET is missing/);
    expect(errors({ STRIPE_BILLING_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_MONTHLY: 'price_1', STRIPE_PRICE_YEARLY: 'price_2', STRIPE_WEBHOOK_SECRET: 'whsec_1' }).join('\n')).toMatch(
      /hosted features need Supabase first/,
    );
  });

  it('catches swapped and malformed values without echoing them', () => {
    const env = {
      ...ENV,
      TOKEN_ENCRYPTION_KEY: 'too-short',
      STRIPE_WEBHOOK_SECRET: 'sk_test_oops',
      STRIPE_PRICE_MONTHLY: 'prod_123',
      SUPABASE_ANON_KEY: 'sb_secret_abc',
      APP_URL: 'http://tinytown.app',
      GITHUB_APP_PRIVATE_KEY: 'bm90IGEga2V5',
      ACCESS_MODE: 'closed',
      POSTHOG_HOSTS: 'us.posthog.com,169.254.169.254',
    };
    const e = errors(env).join('\n');
    expect(e).toMatch(/TOKEN_ENCRYPTION_KEY must be 32 random bytes/);
    expect(e).toMatch(/STRIPE_WEBHOOK_SECRET should start with whsec_/);
    expect(e).toMatch(/STRIPE_PRICE_MONTHLY should be a price id/);
    expect(e).toMatch(/SUPABASE_ANON_KEY holds a secret key/);
    expect(e).toMatch(/APP_URL must be an https/);
    expect(e).toMatch(/GITHUB_APP_PRIVATE_KEY is not a readable private key/);
    expect(e).toMatch(/ACCESS_MODE/);
    expect(e).toMatch(/POSTHOG_HOSTS lists "169.254.169.254"/);
    for (const secret of ['too-short', 'sk_test_oops', 'sb_secret_abc', 'bm90IGEga2V5']) expect(e).not.toContain(secret);
  });

  it('warns about test keys and test mode in production, and a missing CRON_SECRET on Vercel', () => {
    const w = warnings({ ...ENV, VERCEL: '1', VERCEL_ENV: 'production', ALLOW_TEST_MODE: '1' }).join('\n');
    expect(w).toMatch(/Production is billing with a Stripe test key/);
    expect(w).toMatch(/ALLOW_TEST_MODE=1 in production/);
    expect(w).toMatch(/CRON_SECRET is not set/);
  });

  it('returns people to the deployment they started on: previews never hand back to production', () => {
    const vercel = { VERCEL_PROJECT_PRODUCTION_URL: 'tinytown.app', VERCEL_URL: 'tinytown-abc123.vercel.app', VERCEL_BRANCH_URL: 'tinytown-git-feature.vercel.app' };
    expect(settings({ ...vercel, VERCEL_ENV: 'production' }).appUrl).toBe('https://tinytown.app');
    expect(settings({ ...vercel, VERCEL_ENV: 'preview' }).appUrl).toBe('https://tinytown-git-feature.vercel.app');
    expect(settings({ ...vercel, VERCEL_BRANCH_URL: undefined, VERCEL_ENV: 'preview' }).appUrl).toBe('https://tinytown-abc123.vercel.app');
    // APP_URL always wins, and local runs with no Vercel variables have none.
    expect(settings({ ...vercel, VERCEL_ENV: 'preview', APP_URL: 'https://staging.tinytown.app/' }).appUrl).toBe('https://staging.tinytown.app');
    expect(settings({}).appUrl).toBeNull();
  });

  it('accepts a base64 PEM for the GitHub key', () => {
    expect(errors({ ...ENV, GITHUB_APP_PRIVATE_KEY: Buffer.from(GITHUB_PEM).toString('base64') })).toEqual([]);
  });

  it('lists the old encryption key after the current one while rotating', () => {
    const old = Buffer.alloc(32, 9).toString('base64');
    expect(decryptionKeys(settings({ ...ENV, TOKEN_ENCRYPTION_KEY_OLD: old }).secrets!)).toEqual([ENV.TOKEN_ENCRYPTION_KEY, old]);
    expect(decryptionKeys(settings(ENV).secrets!)).toEqual([ENV.TOKEN_ENCRYPTION_KEY]);
    expect(errors({ ...ENV, TOKEN_ENCRYPTION_KEY_OLD: 'nope' }).join('\n')).toMatch(/TOKEN_ENCRYPTION_KEY_OLD must be 32 random bytes/);
  });
});
