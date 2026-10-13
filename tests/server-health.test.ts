/**
 * `/api/health` (shallow and deep) and `/api/telemetry`, end to end through
 * the router with every upstream stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLogState } from '../server/log.ts';
import { ENV, call, setup } from './server-helpers.ts';

const json = (body: unknown, status = 200) => Response.json(body, { status });

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;

/** A fetch that answers from `routes` and records every call. */
function stub(...routes: Handler[]) {
  const calls: { url: URL; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    for (const r of routes) {
      const res = await r(url, init);
      if (res) return res;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return calls;
}

/** Every dependency healthy. Overrides go first, so a test can break one. */
const healthy: Handler = (url) => {
  if (url.origin === ENV.SUPABASE_URL && url.pathname === '/rest/v1/profiles') return json([]);
  if (url.origin === ENV.SUPABASE_URL && url.pathname === '/auth/v1/health') return json({ name: 'GoTrue' });
  if (url.host === 'api.stripe.com' && url.pathname === '/v1/prices/price_month') return json({ active: true, livemode: false, recurring: { interval: 'month' } });
  if (url.host === 'api.stripe.com' && url.pathname === '/v1/prices/price_year') return json({ active: true, livemode: false, recurring: { interval: 'year' } });
  if (url.host === 'api.stripe.com' && url.pathname === '/v1/balance') return json({ object: 'balance' });
  if (url.host === 'api.github.com' && url.pathname === '/app') return json({ slug: ENV.GITHUB_APP_SLUG });
  return undefined;
};

const SECRET = 'health-secret-0123456789';
const FULL = { ...ENV, HEALTH_SECRET: SECRET, CRON_SECRET: 'cron-secret-xyz', RESEND_API_KEY: 're_test_key', SENTRY_DSN: 'https://pub@o1.ingest.sentry.io/42', POSTHOG_PROJECT_KEY: 'phc_test' };

let logs: string[];
beforeEach(() => {
  setup();
  resetLogState();
  logs = [];
  const keep = (s: unknown) => void logs.push(String(s));
  vi.spyOn(console, 'log').mockImplementation(keep);
  vi.spyOn(console, 'error').mockImplementation(keep);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('GET /api/health', () => {
  it('answers ok, the release and the time, without touching any dependency', async () => {
    const calls = stub();
    const res = await call('GET', '/api/health', { token: null, env: { ...ENV, VERCEL_GIT_COMMIT_SHA: 'abcdef1234567890' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body).toEqual({ ok: true, release: 'abcdef123456', time: expect.any(String) });
    expect(Number.isNaN(Date.parse(body.time))).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('works in local mode, answers HEAD with no body, and refuses other methods', async () => {
    stub();
    expect((await call('GET', '/api/health', { token: null, env: {} })).status).toBe(200);
    const head = await call('HEAD', '/api/health', { token: null });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect((await call('POST', '/api/health', { token: null })).status).toBe(405);
  });
});

describe('GET /api/health?deep=1', () => {
  it('needs a secret on the server, and the right one from the caller', async () => {
    const calls = stub(healthy);
    expect((await call('GET', '/api/health?deep=1', { token: SECRET })).status).toBe(503);
    expect((await call('GET', '/api/health?deep=1', { token: null, env: FULL })).status).toBe(401);
    expect((await call('GET', '/api/health?deep=1', { token: 'health-secret-0123456788', env: FULL })).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('checks every dependency and says 200 when they are all fine', async () => {
    const calls = stub(healthy);
    const res = await call('GET', '/api/health?deep=1', { token: SECRET, env: FULL });
    const text = await res.text();
    const body = JSON.parse(text);
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.degraded).toBe(false);
    for (const name of ['supabase_rest', 'supabase_auth', 'stripe_billing', 'stripe_app', 'github_app', 'config_accounts', 'config_billing', 'config_email']) {
      expect(body.checks[name], name).toMatchObject({ ok: true, ms: expect.any(Number) });
    }
    expect(body.checks.stripe_billing.detail).toBe('test mode');
    // The GitHub check signs a real JWT with the app's key.
    const gh = calls.find((c) => c.url.pathname === '/app')!;
    expect(new Headers(gh.init.headers).get('Authorization')).toMatch(/^Bearer ey/);
    // Nothing secret comes back.
    for (const secret of [ENV.SUPABASE_SERVICE_ROLE_KEY, ENV.STRIPE_BILLING_SECRET_KEY, ENV.STRIPE_APP_SECRET_KEY, ENV.STATE_SECRET, ENV.TOKEN_ENCRYPTION_KEY, ENV.GITHUB_APP_CLIENT_SECRET, SECRET, 're_test_key']) {
      expect(text).not.toContain(secret);
    }
  });

  it('accepts CRON_SECRET too', async () => {
    stub(healthy);
    expect((await call('GET', '/api/health?deep=1', { token: 'cron-secret-xyz', env: FULL })).status).toBe(200);
  });

  it('is a 503 when a critical dependency fails, naming it', async () => {
    stub((url) => (url.pathname === '/rest/v1/profiles' ? json({ message: 'boom' }, 500) : undefined), healthy);
    const res = await call('GET', '/api/health?deep=1', { token: SECRET, env: FULL });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.checks.supabase_rest).toMatchObject({ ok: false, critical: true, detail: 'Supabase REST responded 500' });
    expect(body.checks.supabase_auth.ok).toBe(true);
    expect(logs.some((l) => l.includes('"health check failed"') && l.includes('supabase_rest'))).toBe(true);
  });

  it('explains a Stripe key without Prices access, and a GitHub key that does not match', async () => {
    stub(
      (url) => (url.pathname.startsWith('/v1/prices/') ? json({ error: { message: 'restricted' } }, 403) : undefined),
      (url) => (url.pathname === '/app' ? json({ message: 'A JSON web token could not be decoded' }, 401) : undefined),
      healthy,
    );
    const body = await (await call('GET', '/api/health?deep=1', { token: SECRET, env: FULL })).json();
    expect(body.checks.stripe_billing).toMatchObject({ ok: false, detail: 'STRIPE_BILLING_SECRET_KEY lacks read access to Prices (403)' });
    expect(body.checks.github_app.detail).toMatch(/don't match \(401\)/);
    expect(JSON.stringify(body)).not.toContain('restricted');
  });

  it('catches an archived price and a restricted Stripe App key', async () => {
    stub(
      (url) => (url.pathname === '/v1/prices/price_year' ? json({ active: false, livemode: false, recurring: { interval: 'year' } }) : undefined),
      (url) => (url.pathname === '/v1/balance' ? json({}, 403) : undefined),
      healthy,
    );
    const res = await call('GET', '/api/health?deep=1', { token: SECRET, env: FULL });
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.checks.stripe_billing.detail).toBe('the yearly price is archived');
    expect(body.checks.stripe_app.detail).toMatch(/restricted key/);
  });

  it('stays 200 but degraded when only something optional is missing', async () => {
    stub(healthy);
    const env: Record<string, string | undefined> = { ...FULL, RESEND_API_KEY: undefined, SENTRY_DSN: undefined };
    const res = await call('GET', '/api/health?deep=1', { token: SECRET, env });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, degraded: true });
    expect(body.checks.config_email).toEqual({ ok: false, critical: false, ms: 0, detail: 'RESEND_API_KEY is not set' });
    expect(body.checks.config_observability.detail).toBe('SENTRY_DSN is not set');
  });

  it('fails a missing billing variable, and test settings in production', async () => {
    stub(healthy);
    const missing = await call('GET', '/api/health?deep=1', { token: SECRET, env: { ...FULL, STRIPE_WEBHOOK_SECRET: undefined } as Record<string, string | undefined> });
    expect(missing.status).toBe(503);
    expect((await missing.json()).checks.config_billing.detail).toBe('STRIPE_WEBHOOK_SECRET is not set');

    const prod = await call('GET', '/api/health?deep=1', { token: SECRET, env: { ...FULL, VERCEL_ENV: 'production', ALLOW_TEST_MODE: '1' } });
    expect(prod.status).toBe(503);
    const detail = (await prod.json()).checks.config_billing.detail;
    expect(detail).toContain('ALLOW_TEST_MODE is on in production');
    expect(detail).toContain('STRIPE_BILLING_SECRET_KEY is a test key in production');
  });

  it('gives up on a hung dependency after three seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stub((url, init) => {
      if (url.pathname !== '/auth/v1/health') return undefined;
      return new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));
    }, healthy);
    const pending = call('GET', '/api/health?deep=1', { token: SECRET, env: FULL });
    await vi.advanceTimersByTimeAsync(3_000);
    const res = await pending;
    expect(res.status).toBe(503);
    expect((await res.json()).checks.supabase_auth).toMatchObject({ ok: false, detail: 'timed out' });
  });
});

describe('POST /api/telemetry', () => {
  const report = {
    kind: 'error',
    message: 'TypeError: cannot read x of undefined for founder@example.com',
    stack: 'TypeError: cannot read x\n    at render (https://tinytown.test/assets/index-abc.js:10:20)\n    at tick (https://tinytown.test/assets/index-abc.js:5:1)',
    url: 'https://tinytown.test/play?code=secret123#access_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
    release: 'abc123',
    data: { fps: 58, gpu: 'Apple M2', ok: true, 'bad key!': 1, nested: { no: 1 } },
  };
  const post = (body: unknown, opts: { env?: Record<string, string | undefined>; headers?: Record<string, string> } = {}) =>
    call('POST', '/api/telemetry', { token: null, body, ...opts });

  it('takes a report, scrubs it and logs one line', async () => {
    const calls = stub();
    const res = await post(report);
    expect(res.status).toBe(204);
    expect(calls).toHaveLength(0);
    const line = logs.map((l) => JSON.parse(l)).find((l) => l.msg === 'client error')!;
    expect(line).toMatchObject({ level: 'warn', kind: 'error', page: 'https://tinytown.test/play', release: 'abc123', data: { fps: 58, gpu: 'Apple M2', ok: true } });
    expect(line.message).toBe('TypeError: cannot read x of undefined for [email]');
    expect(line.data).not.toHaveProperty('nested');
    expect(line.data).not.toHaveProperty('bad key!');
    const all = logs.join('\n');
    for (const secret of ['founder@example.com', 'secret123', 'eyJhbGci']) expect(all).not.toContain(secret);
  });

  it('caps the message at 500 characters and the stack at 4 KB', async () => {
    stub();
    expect((await post({ kind: 'error', message: 'x '.repeat(2000), stack: 'at a (b.js:1:1)\n'.repeat(400) })).status).toBe(204);
    // Past the 16 KB request cap it isn't read at all.
    expect((await post({ kind: 'error', message: 'x', stack: 'y'.repeat(20_000) })).status).toBe(413);
    const line = logs.map((l) => JSON.parse(l)).find((l) => l.msg === 'client error')!;
    expect(line.message.length).toBeLessThanOrEqual(500);
    expect(line.stack.length).toBeLessThanOrEqual(4096);
  });

  it('refuses what is not a report', async () => {
    stub();
    expect((await post({ kind: 'nope', message: 'x' })).status).toBe(400);
    expect((await post({ kind: 'error' })).status).toBe(400);
    expect((await post({ kind: 'error', message: '   ' })).status).toBe(400);
    expect((await post('not json')).status).toBe(400);
    expect((await call('GET', '/api/telemetry', { token: null })).status).toBe(405);
  });

  it('works without accounts configured', async () => {
    stub();
    expect((await post({ kind: 'perf', message: 'boot', data: { ms: 1200 } }, { env: {} })).status).toBe(204);
    expect(logs.some((l) => l.includes('"client perf"'))).toBe(true);
  });

  it('rate-limits each address to 20 a minute', async () => {
    stub();
    const from = (ip: string) => ({ headers: { 'x-forwarded-for': `${ip}, 10.0.0.1` } });
    for (let i = 0; i < 20; i++) expect((await post({ kind: 'perf', message: 'p' }, from('203.0.113.9'))).status).toBe(204);
    expect((await post({ kind: 'perf', message: 'p' }, from('203.0.113.9'))).status).toBe(429);
    expect((await post({ kind: 'perf', message: 'p' }, from('198.51.100.7'))).status).toBe(204);
    // The address itself is never written down.
    expect(logs.join('\n')).not.toContain('203.0.113.9');
  });

  it('quietly drops reports posted from another site', async () => {
    stub();
    const res = await post(report, { headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(204);
    expect(logs.some((l) => l.includes('client error'))).toBe(false);
    expect((await post(report, { headers: { Origin: 'https://tinytown.test' } })).status).toBe(204);
    expect(logs.some((l) => l.includes('client error'))).toBe(true);
  });

  it('forwards errors (not perf) to Sentry when a DSN is set, scrubbed', async () => {
    const calls = stub((url) => (url.host === 'o1.ingest.sentry.io' ? new Response('{}') : undefined));
    await post(report, { env: FULL });
    await post({ kind: 'perf', message: 'fps', data: { fps: 30 } }, { env: FULL });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const sent = calls[0]!;
    expect(sent.url.toString()).toBe('https://o1.ingest.sentry.io/api/42/envelope/');
    const [, item, event] = String(sent.init.body).trim().split('\n');
    expect(JSON.parse(item!).type).toBe('event');
    const e = JSON.parse(event!);
    expect(e).toMatchObject({ platform: 'javascript', release: 'abc123', transaction: '/play', tags: { source: 'browser', kind: 'error' } });
    expect(e.exception.values[0]).toMatchObject({ type: 'TypeError', value: expect.stringContaining('[email]') });
    expect(e.exception.values[0].stacktrace.frames.map((f: { function: string }) => f.function)).toEqual(['tick', 'render']);
    expect(String(sent.init.body)).not.toContain('founder@example.com');
  });
});
