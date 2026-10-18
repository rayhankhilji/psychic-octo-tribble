/**
 * The observability plumbing on its own: log redaction and request lines,
 * Sentry's envelope and limits, upstream timeouts and retries, and the
 * funnel's PostHog capture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { track } from '../server/analytics.ts';
import type { Ctx } from '../server/context.ts';
import { settings, type Env } from '../server/env.ts';
import { captureException, finishRequest, framesOf, log, noteUser, parseDsn, redact, releaseOf, requestId, resetLogState, scrub } from '../server/log.ts';
import { UpstreamTimeout, deadline, fetchWithRetry, retryAfterMs } from '../server/retry.ts';
import { fetchGithub, fetchStripeSubscriptions } from '../server/sources.ts';
import { Db } from '../server/supabase.ts';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers });

function ctxFor(env: Env = {}, path = '/api/me', headers: Record<string, string> = {}): Ctx {
  const req = new Request(`https://tinytown.test${path}`, { headers });
  return { req, url: new URL(req.url), env, s: settings(env), now: Date.UTC(2026, 9, 13, 12) };
}

/** A scripted fetch: each call takes the next answer (a Response, an Error to throw, or a function). */
function script(...answers: (Response | Error | ((init: RequestInit) => Promise<Response>))[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const next = answers.shift();
    if (!next) throw new Error(`Unexpected fetch: ${input}`);
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(init) : next;
  });
  return calls;
}

let lines: string[];
beforeEach(() => {
  resetLogState();
  lines = [];
  vi.spyOn(console, 'log').mockImplementation((s: unknown) => void lines.push(String(s)));
  vi.spyOn(console, 'error').mockImplementation((s: unknown) => void lines.push(String(s)));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('redaction', () => {
  it('removes emails, tokens, keys and credentials in URLs', () => {
    const cases: [string, string][] = [
      ['mail ada@example.co.uk now', 'mail [email] now'],
      ['Authorization: Bearer abcdefghijklmnop', 'Authorization: Bearer [redacted]'],
      ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefgh done', 'jwt [jwt] done'],
      ['key sk_live_51abcDEF and rk_test_abcdefgh and whsec_abcdefghij', 'key [key] and [key] and [key]'],
      ['gh ghp_abcdefghijklmnopqrstuvwxyz github_pat_abcdefghijklmnopqrst', 'gh [key] [key]'],
      ['sb sb_secret_abcdefghijk phc_abcdefghijklmnopqrs re_abcdefghijklmnopq', 'sb [key] [key] [key]'],
      ['/cb?code=abc123&state=xyz&ok=1', '/cb?code=[redacted]&state=[redacted]&ok=1'],
      ['/#access_token=abc&refresh_token=def', '/#access_token=[redacted]&refresh_token=[redacted]'],
      ['-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----', '[pem]'],
      [`opaque ${'a1B2'.repeat(12)} end`, 'opaque [redacted] end'],
    ];
    for (const [input, out] of cases) expect(redact(input), input).toBe(out);
  });

  it('leaves ordinary text alone: ids, timestamps, stack frames, paths', () => {
    for (const text of [
      'user 6f1c2b7e-0000-4000-8000-000000000001 at 1760356800000',
      '    at render (/var/task/server/node_modules/three/build/three.module.js:10:20)',
      'database GET profiles → 503',
      'render@https://tinytown.app/assets/index-B9x2.js:1:2',
    ]) {
      expect(redact(text)).toBe(text);
    }
  });

  it('drops sensitive fields and reduces errors', () => {
    const out = scrub({ user_id: 'u1', email: 'a@b.co', authorization: 'x', nested: { apiKey: 'k', fine: 1 }, err: new Error('failed for a@b.co') }) as Record<string, unknown>;
    expect(out).toMatchObject({ user_id: 'u1', email: '[redacted]', authorization: '[redacted]', nested: { apiKey: '[redacted]', fine: 1 } });
    expect(out.err).toMatchObject({ type: 'Error', message: 'failed for [email]', stack: expect.any(String) });
    expect(scrub({ a: { b: { c: { d: 1 } } } })).toEqual({ a: { b: { c: '[object]' } } });
  });
});

describe('log lines', () => {
  it('writes one JSON line; info to stdout, warnings and errors to stderr', () => {
    log.info('hello', { route: '/api/me', token: 'secret' });
    log.error('oops', { status: 502 });
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
    const first = JSON.parse(lines[0]!);
    expect(first).toEqual({ level: 'info', time: expect.any(String), msg: 'hello', route: '/api/me', token: '[redacted]' });
  });

  it("takes the request id from Vercel's header, or makes one that lasts the request", () => {
    expect(requestId(ctxFor({}, '/', { 'x-vercel-id': 'iad1::abc12-1760000000000-def' }).req)).toBe('iad1::abc12-1760000000000-def');
    const ctx = ctxFor({}, '/', { 'x-vercel-id': 'bad id with spaces' });
    const id = requestId(ctx.req);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(requestId(ctx.req)).toBe(id);
  });

  it("logs a request's route, status, time and user, never its query, and stamps the id", () => {
    const ctx = ctxFor({}, '/api/connect/stripe/callback/?code=ac_secret&state=s', { 'x-vercel-id': 'sfo1::req1' });
    noteUser(ctx.req, '6f1c2b7e-0000-4000-8000-000000000001');
    const res = finishRequest(ctx, new Response(null, { status: 302 }), performance.now() - 12);
    expect(res.headers.get('X-Request-Id')).toBe('sfo1::req1');
    const line = JSON.parse(lines[0]!);
    expect(line).toMatchObject({ level: 'info', msg: 'request', request_id: 'sfo1::req1', method: 'GET', route: '/api/connect/stripe/callback', status: 302, user_id: '6f1c2b7e-0000-4000-8000-000000000001' });
    expect(line.duration_ms).toBeGreaterThanOrEqual(11);
    expect(lines[0]).not.toContain('ac_secret');
    // Immutable headers don't break the response.
    finishRequest(ctx, Response.redirect('https://tinytown.test/', 302), performance.now());
    expect(JSON.parse(lines[1]!).status).toBe(302);
    finishRequest(ctx, new Response(null, { status: 503 }), performance.now());
    expect(JSON.parse(lines[2]!).level).toBe('error');
  });

  it('names the release from RELEASE or the commit', () => {
    expect(releaseOf({})).toBe('dev');
    expect(releaseOf({ VERCEL_GIT_COMMIT_SHA: '0123456789abcdef' })).toBe('0123456789ab');
    expect(releaseOf({ RELEASE: 'v1.2.0', VERCEL_GIT_COMMIT_SHA: 'abc' })).toBe('v1.2.0');
    expect(releaseOf({ RELEASE: 'bad release name!' })).toBe('dev');
  });
});

describe('Sentry', () => {
  const DSN = 'https://abc123@o9.ingest.us.sentry.io/4507';
  const sentry = () => new Response('{}');

  it('reads a DSN, and refuses anything but https with a key and project', () => {
    expect(parseDsn(DSN)).toEqual({ url: 'https://o9.ingest.us.sentry.io/api/4507/envelope/', publicKey: 'abc123' });
    expect(parseDsn('https://k@self.host/sentry/7')).toEqual({ url: 'https://self.host/sentry/api/7/envelope/', publicKey: 'k' });
    for (const bad of [undefined, '', 'http://k@h/1', 'https://h/1', 'https://k@h/abc', 'nonsense']) expect(parseDsn(bad)).toBeNull();
  });

  it('does nothing without a DSN', async () => {
    const calls = script();
    await captureException(ctxFor(), new Error('x'));
    expect(calls).toHaveLength(0);
  });

  it('sends an envelope with the request id and route, and no personal data', async () => {
    const calls = script(sentry());
    const ctx = ctxFor({ SENTRY_DSN: DSN, VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_SHA: 'feedface00112233' }, '/api/world?x=1', { 'x-vercel-id': 'iad1::r9' });
    await captureException(ctx, new TypeError('no row for ada@example.com'));
    expect(calls[0]!.url).toBe('https://o9.ingest.us.sentry.io/api/4507/envelope/');
    expect(new Headers(calls[0]!.init.headers).get('X-Sentry-Auth')).toMatch(/^Sentry sentry_version=7, sentry_key=abc123, /);
    const body = String(calls[0]!.init.body);
    const [header, item, event] = body.trim().split('\n');
    const e = JSON.parse(event!);
    expect(JSON.parse(header!).event_id).toBe(e.event_id);
    expect(JSON.parse(item!)).toEqual({ type: 'event', length: Buffer.byteLength(event!) });
    expect(e).toMatchObject({ platform: 'node', level: 'error', release: 'feedface0011', environment: 'production', transaction: '/api/world', tags: { request_id: 'iad1::r9', route: '/api/world', method: 'GET', source: 'server' } });
    expect(e.exception.values[0]).toMatchObject({ type: 'TypeError', value: 'no row for [email]' });
    expect(e.exception.values[0].stacktrace.frames.length).toBeGreaterThan(0);
    expect(body).not.toContain('ada@example.com');
  });

  it('samples, and limits each instance to 3 of one error and 20 in all a minute', async () => {
    const calls = script(...Array.from({ length: 40 }, sentry));
    const ctx = ctxFor({ SENTRY_DSN: DSN });
    for (let i = 0; i < 5; i++) await captureException(ctx, new Error('same thing'));
    expect(calls).toHaveLength(3);
    for (let i = 0; i < 30; i++) await captureException(ctx, new Error(`different ${i}`));
    expect(calls).toHaveLength(20);
    // A minute on, the window opens again.
    await captureException({ ...ctx, now: ctx.now + 60_000 }, new Error('same thing'));
    expect(calls).toHaveLength(21);

    resetLogState();
    await captureException(ctxFor({ SENTRY_DSN: DSN, SENTRY_SAMPLE_RATE: '0' }), new Error('sampled out'));
    expect(calls).toHaveLength(21);
  });

  it('backs off when Sentry says 429, and never throws when it is down', async () => {
    const calls = script(new Response('', { status: 429, headers: { 'Retry-After': '120' } }), new Error('ECONNRESET'));
    const ctx = ctxFor({ SENTRY_DSN: DSN });
    await captureException(ctx, new Error('a'));
    await captureException({ ...ctx, now: ctx.now + 60_000 }, new Error('b'));
    expect(calls).toHaveLength(1);
    await expect(captureException({ ...ctx, now: ctx.now + 121_000 }, new Error('c'))).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it('turns V8 and Firefox stacks into frames, oldest first', () => {
    expect(framesOf('Error: x\n    at inner (/app/server/a.ts:3:4)\n    at /app/node_modules/lib/b.js:1:2')).toEqual([
      { filename: '/app/node_modules/lib/b.js', lineno: 1, colno: 2, in_app: false },
      { function: 'inner', filename: '/app/server/a.ts', lineno: 3, colno: 4, in_app: true },
    ]);
    expect(framesOf('draw@https://t.app/a.js?v=1:9:8')).toEqual([{ function: 'draw', filename: 'https://t.app/a.js', lineno: 9, colno: 8, in_app: true }]);
    expect(framesOf(undefined)).toBeUndefined();
  });
});

describe('fetchWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  it('retries a GET after a 503 with jittered backoff', async () => {
    const calls = script(json({}, 503), json({}, 502), json({ ok: true }));
    let done = false;
    const pending = fetchWithRetry('https://api.test/x').then((r) => ((done = true), r));
    await vi.advanceTimersByTimeAsync(149);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); // 0.5 × 300 ms
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(300); // 0.5 × 600 ms
    expect(done).toBe(true);
    expect((await pending).status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it("honours a short Retry-After, and returns straight away when it's long", async () => {
    const calls = script(json({}, 429, { 'Retry-After': '2' }), json({ ok: true }));
    const pending = fetchWithRetry('https://api.test/x');
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe(200);

    script(json({}, 429, { 'Retry-After': '60' }));
    expect((await fetchWithRetry('https://api.test/x')).status).toBe(429);
  });

  it('returns the last answer once retries run out', async () => {
    const calls = script(json({}, 500), json({}, 500), json({}, 500));
    const pending = fetchWithRetry('https://api.test/x');
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).status).toBe(500);
    expect(calls).toHaveLength(3);
  });

  it('never repeats a POST or PATCH, unless it carries an idempotency key', async () => {
    script(json({}, 503));
    expect((await fetchWithRetry('https://api.test/x', { method: 'POST' })).status).toBe(503);
    script(json({}, 503));
    expect((await fetchWithRetry('https://api.test/x', { method: 'PATCH' })).status).toBe(503);
    script(new TypeError('fetch failed'));
    await expect(fetchWithRetry('https://api.test/x', { method: 'POST' })).rejects.toThrow('fetch failed');

    const calls = script(json({}, 503), json({ ok: true }));
    const pending = fetchWithRetry('https://api.test/x', { method: 'POST', headers: { 'Idempotency-Key': 'k1' } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('retries a dropped connection on a GET', async () => {
    const calls = script(new TypeError('fetch failed'), json({ ok: true }));
    const pending = fetchWithRetry('https://api.test/x');
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('times out a hung attempt and does not retry it', async () => {
    const hang = (init: RequestInit) => new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));
    const calls = script(hang, hang);
    const pending = fetchWithRetry('https://api.test/x', {}, { timeoutMs: 1_000 });
    const check = expect(pending).rejects.toBeInstanceOf(UpstreamTimeout);
    await vi.advanceTimersByTimeAsync(1_000);
    await check;
    expect(calls).toHaveLength(1);
  });

  it('stops waiting when the overall deadline passes mid-backoff', async () => {
    script(json({}, 503, { 'Retry-After': '3' }), json({ ok: true }));
    const pending = fetchWithRetry('https://api.test/x', {}, { signal: deadline(1_000) });
    const check = expect(pending).rejects.toBeInstanceOf(UpstreamTimeout);
    await vi.advanceTimersByTimeAsync(1_000);
    await check;
  });

  it('reads Retry-After as seconds or a date', () => {
    const now = Date.UTC(2026, 0, 1);
    expect(retryAfterMs(new Response('', { headers: { 'Retry-After': '1.5' } }), now)).toBe(1_500);
    expect(retryAfterMs(new Response('', { headers: { 'Retry-After': new Date(now + 5_000).toUTCString() } }), now)).toBe(5_000);
    expect(retryAfterMs(new Response(''), now)).toBeNull();
  });
});

describe('upstream callers', () => {
  const cfg = { url: 'https://db.test', anonKey: 'anon', serviceKey: 'service' };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  it('Supabase reads retry; writes are sent once and fail as a 502', async () => {
    const calls = script(json({}, 503), json([{ user_id: 'u1' }]));
    const pending = new Db(cfg).one('profiles', { user_id: 'u1' });
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual({ user_id: 'u1' });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.init.signal).toBeInstanceOf(AbortSignal);

    const writes = script(json({}, 503));
    await expect(new Db(cfg).update('worlds', { user_id: 'u1', version: 1 }, { version: 2 })).rejects.toMatchObject({ status: 502, code: 'upstream' });
    expect(writes).toHaveLength(1);
    expect(lines.some((l) => l.includes('"database error"') && l.includes('"table":"worlds"'))).toBe(true);
  });

  it('a hung Supabase is a 502 after 8 seconds, not a hung request', async () => {
    script((init) => new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))));
    const pending = new Db(cfg).update('profiles', { user_id: 'u1' }, { name: 'x' });
    const check = expect(pending).rejects.toMatchObject({ status: 502 });
    await vi.advanceTimersByTimeAsync(8_000);
    await check;
  });

  it("Stripe and GitHub paging retry a 429, and say plainly when they're too slow", async () => {
    const calls = script(json({}, 429, { 'Retry-After': '1' }), json({ data: [{ id: 'sub_1' }], has_more: false }));
    const pending = fetchStripeSubscriptions('rk_test_x');
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).map((s) => s.id)).toEqual(['sub_1']);
    expect(calls).toHaveLength(2);

    const hang = (init: RequestInit) => new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));
    script(hang, hang);
    const slow = fetchGithub('acme/app');
    const check = expect(slow).rejects.toThrow('GitHub took too long to respond. Try again in a moment.');
    await vi.advanceTimersByTimeAsync(8_000);
    await check;
  });
});

describe('track', () => {
  it('does nothing without a project key', async () => {
    const calls = script();
    await track(ctxFor(), 'u1', 'signed_up');
    expect(calls).toHaveLength(0);
  });

  it('captures the event with the user id, and only clean props', async () => {
    const calls = script(new Response('{"status":"Ok"}'));
    const env = { POSTHOG_PROJECT_KEY: 'phc_abc', VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_SHA: '1234567890abcdef' };
    await track(ctxFor(env), '6f1c2b7e-0000-4000-8000-000000000001', 'checkout_started', { interval: 'year', note: 'for ada@example.com', amount: 9900, live: true, 'bad key': 1, n: Number.NaN });
    expect(calls[0]!.url).toBe('https://us.i.posthog.com/i/v0/e/');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      api_key: 'phc_abc',
      event: 'checkout_started',
      distinct_id: '6f1c2b7e-0000-4000-8000-000000000001',
      timestamp: '2026-10-13T12:00:00.000Z',
      properties: { interval: 'year', note: 'for [email]', amount: 9900, live: true, $lib: 'tinytown-server', release: '1234567890ab', environment: 'production' },
    });
  });

  it("on Vercel, hands the send to waitUntil and doesn't make the request wait", async () => {
    const SYMBOL = Symbol.for('@vercel/request-context');
    const held: Promise<unknown>[] = [];
    (globalThis as Record<symbol, unknown>)[SYMBOL] = { get: () => ({ waitUntil: (p: Promise<unknown>) => held.push(p) }) };
    try {
      let answer!: (r: Response) => void;
      const calls = script(() => new Promise<Response>((r) => (answer = r)));
      await track(ctxFor({ POSTHOG_PROJECT_KEY: 'phc_abc' }), 'u1', 'first_build');
      expect(calls).toHaveLength(1);
      expect(held).toHaveLength(1);
      answer(new Response('{}'));
      await held[0];
    } finally {
      delete (globalThis as Record<symbol, unknown>)[SYMBOL];
    }
  });

  it('uses a configured EU host, ignores a bad one, and never throws', async () => {
    const calls = script(new Response('{}'), new Error('ECONNRESET'));
    await track(ctxFor({ POSTHOG_PROJECT_KEY: 'phc_abc', POSTHOG_CAPTURE_HOST: 'https://eu.i.posthog.com/' }), 'u1', 'plan_started');
    expect(calls[0]!.url).toBe('https://eu.i.posthog.com/i/v0/e/');
    await expect(track(ctxFor({ POSTHOG_PROJECT_KEY: 'phc_abc' }), 'u1', 'plan_started')).resolves.toBeUndefined();
    await track(ctxFor({ POSTHOG_PROJECT_KEY: 'phc_abc', POSTHOG_CAPTURE_HOST: 'http://internal:8000' }), 'u1', 'plan_started');
    expect(calls).toHaveLength(2);
  });
});
