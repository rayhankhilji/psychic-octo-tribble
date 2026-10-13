import { createVerify } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings } from '../server/env.ts';
import { decrypt, encrypt } from '../server/crypto.ts';
import { hosted } from '../server/context.ts';
import { accessToken } from '../server/stripe-app.ts';
import type { ConnectionRow } from '../server/store.ts';
import { ENCRYPTION_KEY, ENV, FakeSupabase, GITHUB_PUBLIC, USER, call, form, givePlan, setup, stubFetch, type Call } from './server-helpers.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 13, 12);
const json = (body: unknown, status = 200) => Response.json(body, { status });

let db: FakeSupabase;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db = setup();
  givePlan(db);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Starts a connect flow and returns the state plus the cookie the browser would send back. */
async function start(provider: 'stripe' | 'github', env = ENV) {
  const res = await call('POST', `/api/connect/${provider}`, { env });
  expect(res.status).toBe(200);
  const { url } = (await res.json()) as { url: string };
  const setCookie = res.headers.get('Set-Cookie')!;
  const cookie = setCookie.split(';')[0]!;
  return { url: new URL(url), state: new URL(url).searchParams.get('state')!, cookie, setCookie };
}

const callback = (provider: 'stripe' | 'github', query: Record<string, string>, cookie: string | null, env = ENV) =>
  call('GET', `/api/connect/${provider}/callback?${new URLSearchParams(query)}`, { token: null, headers: cookie ? { Cookie: cookie } : {}, env });

const founderSub = {
  id: 'sub_f1',
  customer: 'cus_f1',
  status: 'active',
  start_date: (NOW - 3 * DAY) / 1000,
  ended_at: null,
  trial_end: null,
  currency: 'usd',
  items: { data: [{ quantity: 1, price: { unit_amount: 4900, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } } }] },
};

const stripeRow = (over: Partial<ConnectionRow> = {}): ConnectionRow => ({
  user_id: USER.id,
  provider: 'stripe',
  account_id: 'acct_f1',
  display_name: null,
  livemode: true,
  secret: encrypt('rt_old', ENCRYPTION_KEY, `${USER.id}:stripe`),
  access_token: encrypt('at_old', ENCRYPTION_KEY, `${USER.id}:stripe`),
  access_expires_at: new Date(NOW - 60_000).toISOString(),
  token_version: 5,
  metadata: {},
  connected_at: new Date(NOW - 30 * DAY).toISOString(),
  ...over,
});

describe('Stripe App: install', () => {
  it('returns the marketplace link with our client id, redirect URI and a signed state, and sets the nonce cookie', async () => {
    stubFetch(db);
    const { url, setCookie } = await start('stripe');
    expect(url.origin + url.pathname).toBe('https://marketplace.stripe.com/oauth/v2/authorize');
    expect(url.searchParams.get('client_id')).toBe('ca_app');
    expect(url.searchParams.get('redirect_uri')).toBe('https://tinytown.test/api/connect/stripe/callback');
    expect(setCookie).toMatch(/^tt_oauth_stripe=[\w-]+; Path=\/api\/connect; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
  });

  it('refuses a plain-http redirect URI in live mode', async () => {
    stubFetch(db);
    const res = await call('POST', '/api/connect/stripe', { env: { ...ENV, APP_URL: 'http://tinytown.test' } });
    expect(res.status).toBe(503);
  });
});

describe('Stripe App: callback', () => {
  const tokenRoute = (calls: { body: string; auth: string | null }[], livemode = true) => (url: URL, init: RequestInit) => {
    if (url.href !== 'https://api.stripe.com/v1/oauth/token') return undefined;
    calls.push({ body: String(init.body), auth: new Headers(init.headers).get('Authorization') });
    return json({ access_token: 'at_1', refresh_token: 'rt_1', livemode, stripe_user_id: 'acct_f1', scope: 'stripe_apps', token_type: 'bearer' });
  };

  it('exchanges the code with our app key, stores the refresh token encrypted, and starts the back-pay window', async () => {
    const tokens: { body: string; auth: string | null }[] = [];
    stubFetch(db, tokenRoute(tokens));
    await call('GET', '/api/me');
    const { state, cookie } = await start('stripe');
    const res = await callback('stripe', { code: 'ac_123', state }, cookie);

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/?connected=stripe');
    expect(res.headers.get('Set-Cookie')).toContain('tt_oauth_stripe=; ');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.auth).toBe(`Basic ${Buffer.from('sk_live_app:').toString('base64')}`);
    expect(form(tokens[0]!.body)).toEqual({ grant_type: 'authorization_code', code: 'ac_123' });

    const row = db.row('connections', { user_id: USER.id, provider: 'stripe' }) as unknown as ConnectionRow;
    expect(row).toMatchObject({ account_id: 'acct_f1', livemode: true });
    expect(row.secret).not.toContain('rt_1');
    expect(decrypt(row.secret!, ENCRYPTION_KEY, `${USER.id}:stripe`)).toBe('rt_1');
    expect(decrypt(row.access_token!, ENCRYPTION_KEY, `${USER.id}:stripe`)).toBe('at_1');
    expect(db.row('profiles', { user_id: USER.id })!.joined_at).toBe(Date.UTC(2026, 9, 13));

    const me = await (await call('GET', '/api/me')).json();
    expect(me.connections.stripe).toMatchObject({ account: 'acct_f1', livemode: true });
    expect(me.world.joinedAt).toBe(Date.UTC(2026, 9, 13));
  });

  it("won't finish a flow started in another browser, or with a forged or missing state", async () => {
    const tokens: { body: string; auth: string | null }[] = [];
    stubFetch(db, tokenRoute(tokens));
    const { state } = await start('stripe');
    for (const [query, cookie] of [
      [{ code: 'ac_1', state }, null],
      [{ code: 'ac_1', state }, 'tt_oauth_stripe=someone-elses-nonce'],
      [{ code: 'ac_1', state: state.slice(0, -2) + 'xx' }, null],
      [{ code: 'ac_1' }, null],
    ] as const) {
      const res = await callback('stripe', query, cookie);
      expect(res.headers.get('Location')).toBe('/?connect_error=stripe%3Astate');
    }
    expect(tokens).toHaveLength(0);
    expect(db.tables.connections).toHaveLength(0);
  });

  it('reports a cancelled install', async () => {
    stubFetch(db);
    const { state, cookie } = await start('stripe');
    const res = await callback('stripe', { error: 'access_denied', state }, cookie);
    expect(res.headers.get('Location')).toBe('/?connect_error=stripe%3Adenied');
  });

  it('rejects test-mode accounts unless ALLOW_TEST_MODE=1', async () => {
    const testEnv = { ...ENV, STRIPE_APP_SECRET_KEY: 'sk_test_app' };
    stubFetch(db, tokenRoute([], false));
    let flow = await start('stripe', testEnv);
    expect((await callback('stripe', { code: 'ac_1', state: flow.state }, flow.cookie, testEnv)).headers.get('Location')).toBe('/?connect_error=stripe%3Atestmode');
    expect(db.tables.connections).toHaveLength(0);

    const devEnv = { ...testEnv, ALLOW_TEST_MODE: '1' };
    flow = await start('stripe', devEnv);
    expect((await callback('stripe', { code: 'ac_1', state: flow.state }, flow.cookie, devEnv)).headers.get('Location')).toBe('/?connected=stripe');
    expect(db.row('connections', { provider: 'stripe' })).toMatchObject({ livemode: false });
  });
});

describe('Stripe App: rolling refresh tokens', () => {
  /** Stripe's token endpoint: each refresh token works once and rolls to the next. */
  function fakeStripe(opts: { onRefresh?: () => Response | undefined } = {}) {
    let live = 'rt_old';
    let n = 0;
    const refreshes: string[] = [];
    const listCalls: string[] = [];
    const route = (url: URL, init: RequestInit) => {
      if (url.href === 'https://api.stripe.com/v1/oauth/token') {
        const p = form(String(init.body));
        refreshes.push(p.refresh_token!);
        const override = opts.onRefresh?.();
        if (override) return override;
        if (p.grant_type !== 'refresh_token' || p.refresh_token !== live) return json({ error: 'invalid_grant' }, 400);
        n++;
        live = `rt_${n}`;
        return json({ access_token: `at_${n}`, refresh_token: live, livemode: true, stripe_user_id: 'acct_f1' });
      }
      if (url.pathname === '/v1/subscriptions') {
        listCalls.push(new Headers(init.headers).get('Authorization')!);
        return json({ data: [founderSub], has_more: false });
      }
      return undefined;
    };
    return { route, refreshes, listCalls };
  }

  it('refreshes an expired access token, stores the rolled refresh token, and builds the timeline', async () => {
    db.tables.connections!.push({ ...stripeRow() });
    const s = fakeStripe();
    stubFetch(db, s.route);
    const res = await call('GET', '/api/timeline');
    expect(res.status).toBe(200);
    const t = await res.json();
    expect(t).toMatchObject({ source: 'live', currency: 'usd', integrations: { stripe: true, github: false } });
    expect(t.snapshots.at(-1)).toMatchObject({ customers: 1, mrr: 49 });

    expect(s.refreshes).toEqual(['rt_old']);
    expect(s.listCalls).toEqual(['Bearer at_1']);
    const row = db.row('connections', { provider: 'stripe' }) as unknown as ConnectionRow;
    expect(decrypt(row.secret!, ENCRYPTION_KEY, `${USER.id}:stripe`)).toBe('rt_1');
    expect(decrypt(row.access_token!, ENCRYPTION_KEY, `${USER.id}:stripe`)).toBe('at_1');
    expect(row.token_version).toBe(6);

    // Cached for 15 minutes, then rebuilt with the stored access token (no refresh needed).
    await call('GET', '/api/timeline');
    expect(s.listCalls).toHaveLength(1);
    vi.setSystemTime(NOW + 16 * 60_000);
    await call('GET', '/api/timeline');
    expect(s.listCalls).toEqual(['Bearer at_1', 'Bearer at_1']);
    expect(s.refreshes).toHaveLength(1);
  });

  it('shares one refresh between concurrent callers in the same server', async () => {
    const s = fakeStripe();
    stubFetch(db, s.route);
    const ctx = hosted({ req: new Request('https://tinytown.test/'), url: new URL('https://tinytown.test/'), env: ENV, s: settings(ENV), now: NOW });
    const row = stripeRow();
    db.tables.connections!.push({ ...row });
    const [a, b] = await Promise.all([accessToken(ctx, row), accessToken(ctx, row)]);
    expect([a, b]).toEqual(['at_1', 'at_1']);
    expect(s.refreshes).toEqual(['rt_old']);
  });

  it("uses the token another server just stored when its own refresh token was already spent", async () => {
    db.tables.connections!.push({ ...stripeRow() });
    const s = fakeStripe({
      onRefresh: () => {
        // Another instance refreshed first: the row moved on and rt_old is dead.
        Object.assign(db.row('connections', { provider: 'stripe' })!, {
          token_version: 6,
          secret: encrypt('rt_other', ENCRYPTION_KEY, `${USER.id}:stripe`),
          access_token: encrypt('at_other', ENCRYPTION_KEY, `${USER.id}:stripe`),
          access_expires_at: new Date(NOW + 50 * 60_000).toISOString(),
        });
        return json({ error: 'invalid_grant' }, 400);
      },
    });
    stubFetch(db, s.route);
    expect((await call('GET', '/api/timeline')).status).toBe(200);
    expect(s.listCalls).toEqual(['Bearer at_other']);
    expect(decrypt(String(db.row('connections', { provider: 'stripe' })!.secret), ENCRYPTION_KEY, `${USER.id}:stripe`)).toBe('rt_other');
  });

  it("never overwrites a newer token: the write lands only on the version that was read", async () => {
    db.tables.connections!.push({ ...stripeRow() });
    db.beforePatch = (table) => {
      if (table === 'connections') db.row('connections', { provider: 'stripe' })!.token_version = 9;
    };
    stubFetch(db, fakeStripe().route);
    expect((await call('GET', '/api/timeline')).status).toBe(200);
    expect(decrypt(String(db.row('connections', { provider: 'stripe' })!.secret), ENCRYPTION_KEY, `${USER.id}:stripe`)).toBe('rt_old');
  });

  it('asks the founder to reconnect when the refresh token is dead', async () => {
    db.tables.connections!.push({ ...stripeRow({ secret: encrypt('rt_revoked', ENCRYPTION_KEY, `${USER.id}:stripe`) }) });
    stubFetch(db, fakeStripe().route);
    const res = await call('GET', '/api/timeline');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'not_connected' });
  });

  it('says not_connected when nothing is connected yet', async () => {
    stubFetch(db);
    const res = await call('GET', '/api/timeline');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'not_connected' });
  });
});

describe('GitHub App', () => {
  function fakeGithub(installations = [{ id: 77, account: { login: 'acme' } }]) {
    const calls: Call[] = [];
    const route = (url: URL, init: RequestInit) => {
      const auth = new Headers(init.headers).get('Authorization') ?? '';
      if (url.href === 'https://github.com/login/oauth/access_token') {
        calls.push({ url, init, body: String(init.body) });
        const body = JSON.parse(String(init.body));
        return json(body.code === 'gh_code' && body.client_secret === 'gh-client-secret' ? { access_token: 'ghu_user' } : { error: 'bad_verification_code' });
      }
      if (url.pathname === '/user/installations') return auth === 'Bearer ghu_user' ? json({ total_count: installations.length, installations }) : json({}, 401);
      if (url.pathname === '/app/installations/77/access_tokens') {
        calls.push({ url, init, body: auth });
        return json({ token: 'ghs_install', expires_at: new Date(NOW + 3600_000).toISOString() });
      }
      if (auth !== 'Bearer ghs_install') return undefined;
      if (url.pathname === '/installation/repositories') return json({ repositories: [{ full_name: 'acme/app', private: true, default_branch: 'main' }] });
      if (url.pathname === '/repos/acme/app') return json({ full_name: 'acme/app' });
      if (url.pathname === '/repos/acme/secret') return json({}, 404);
      if (url.pathname === '/repos/acme/app/commits') return json([{ commit: { committer: { date: new Date(NOW - DAY).toISOString() }, author: null } }]);
      if (url.pathname === '/repos/acme/app/releases') return json([{ name: 'v1', tag_name: 'v1', draft: false, published_at: new Date(NOW).toISOString() }]);
      return undefined;
    };
    return { route, calls };
  }

  it('install link, then a callback that proves the installation is yours', async () => {
    const gh = fakeGithub();
    stubFetch(db, gh.route);
    await call('GET', '/api/me');
    const { url, state, cookie } = await start('github');
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/apps/tinytown-test/installations/new');
    const res = await callback('github', { code: 'gh_code', installation_id: '77', setup_action: 'install', state }, cookie);
    expect(res.headers.get('Location')).toBe('/?connected=github');
    expect(db.row('connections', { provider: 'github' })).toMatchObject({ account_id: '77', display_name: 'acme', metadata: {} });
    expect(JSON.parse(gh.calls[0]!.body)).toEqual({ client_id: 'Iv1.client', client_secret: 'gh-client-secret', code: 'gh_code' });
  });

  it("refuses an installation id that isn't among the user's", async () => {
    stubFetch(db, fakeGithub().route);
    const { state, cookie } = await start('github');
    const res = await callback('github', { code: 'gh_code', installation_id: '666', setup_action: 'install', state }, cookie);
    expect(res.headers.get('Location')).toBe('/?connect_error=github%3Ainstallation');
    expect(db.tables.connections).toHaveLength(0);
  });

  it('handles an install awaiting approval, and asks for authorization when GitHub sends no code', async () => {
    stubFetch(db, fakeGithub().route);
    const { state, cookie } = await start('github');
    const pending = await callback('github', { setup_action: 'request', state }, cookie);
    expect(decodeURIComponent(pending.headers.get('Location')!)).toMatch(/^\/\?connect_error=github:Your organisation owner/);
    const noCode = await callback('github', { installation_id: '77', setup_action: 'update', state }, cookie);
    const to = new URL(noCode.headers.get('Location')!);
    expect(`${to.origin}${to.pathname}`).toBe('https://github.com/login/oauth/authorize');
    expect(to.searchParams.get('state')).toBe(state);
    expect(to.searchParams.get('redirect_uri')).toBe('https://tinytown.test/api/connect/github/callback');
  });

  it('lists repositories with an installation token minted from the app JWT, then builds from the chosen one', async () => {
    db.tables.connections!.push({ user_id: USER.id, provider: 'github', account_id: '77', display_name: 'acme', metadata: {}, token_version: 0, connected_at: new Date(NOW).toISOString() });
    const gh = fakeGithub();
    stubFetch(db, gh.route);
    expect(await (await call('GET', '/api/connect/github/repos')).json()).toEqual({ repos: [{ fullName: 'acme/app', private: true, defaultBranch: 'main' }] });

    const jwt = gh.calls.find((c) => c.url.pathname.endsWith('/access_tokens'))!.body.replace('Bearer ', '');
    const [head, payload, sig] = jwt.split('.');
    expect(createVerify('RSA-SHA256').update(`${head}.${payload}`).verify(GITHUB_PUBLIC, Buffer.from(sig!, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString()).iss).toBe('4242');

    expect((await call('PUT', '/api/connect/github/repo', { body: { repo: 'acme/secret' } })).status).toBe(400);
    expect((await call('PUT', '/api/connect/github/repo', { body: { repo: '../../etc' } })).status).toBe(400);
    const connections = await (await call('PUT', '/api/connect/github/repo', { body: { repo: 'acme/app' } })).json();
    expect(connections.github).toMatchObject({ installationId: 77, repo: 'acme/app' });

    const t = await (await call('GET', '/api/timeline')).json();
    expect(t.integrations).toEqual({ stripe: false, github: true });
    expect(t.snapshots.at(-1)).toMatchObject({ releases: 1, commits: 1, release: 'v1' });
    // One installation token, reused.
    expect(gh.calls.filter((c) => c.url.pathname.endsWith('/access_tokens'))).toHaveLength(1);
  });
});

describe('users source', () => {
  const posthog = (keys: string[]) => (url: URL, init: RequestInit) => {
    if (url.href !== 'https://us.posthog.com/api/projects/123/query/') return undefined;
    keys.push(new Headers(init.headers).get('Authorization')!);
    const q = JSON.parse(String(init.body)).query;
    expect(q).toMatchObject({ kind: 'TrendsQuery', interval: 'day', series: [{ math: 'monthly_active' }] });
    const days = [2, 1, 0].map((d) => new Date(NOW - d * DAY).toISOString().slice(0, 10));
    return json({ results: [{ days, data: [800, 900, 1000] }] });
  };

  it('connects PostHog (Cloud hosts only), keeps the key encrypted, and fills users per day', async () => {
    const keys: string[] = [];
    stubFetch(db, posthog(keys), (url, init) => (url.pathname === '/v1/subscriptions' ? json({ data: [founderSub], has_more: false }) : void init));
    db.tables.connections!.push({ ...stripeRow({ access_expires_at: new Date(NOW + 3600_000).toISOString() }) });
    const key = 'phx_abcdefghijklmnopqrstuvwxyz';

    for (const host of ['http://169.254.169.254', 'https://evil.example.com', 'https://us.posthog.com:8443']) {
      expect((await call('PUT', '/api/connect/users', { body: { source: 'posthog', host, projectId: '123', apiKey: key } })).status).toBe(400);
    }
    expect((await call('PUT', '/api/connect/users', { body: { source: 'posthog', host: 'us.posthog.com', projectId: 'abc', apiKey: key } })).status).toBe(400);
    expect(keys).toHaveLength(0);

    const res = await call('PUT', '/api/connect/users', { body: { source: 'posthog', host: 'https://us.i.posthog.com', projectId: '123', apiKey: key } });
    expect(res.status).toBe(200);
    expect((await res.json()).users).toMatchObject({ source: 'posthog', host: 'https://us.posthog.com', projectId: '123' });
    const row = db.row('connections', { provider: 'posthog' })!;
    expect(String(row.secret)).not.toContain(key);
    expect(JSON.stringify(await (await call('GET', '/api/me')).json())).not.toContain(key);

    const t = await (await call('GET', '/api/timeline')).json();
    expect(t.snapshots.map((s: { users?: number }) => s.users)).toEqual([undefined, 800, 900, 1000]);
    expect(keys.every((k) => k === `Bearer ${key}`)).toBe(true);

    // Disconnecting PostHog puts the population back on customers.
    await call('DELETE', '/api/connect/posthog');
    expect((await (await call('GET', '/api/me')).json()).connections.users).toEqual({ source: 'customers' });
  });

  it('counts a manual number from the day it was entered, never before', async () => {
    stubFetch(db, (url) => (url.pathname === '/v1/subscriptions' ? json({ data: [founderSub], has_more: false }) : undefined));
    db.tables.connections!.push({ ...stripeRow({ access_expires_at: new Date(NOW + 3600_000).toISOString() }) });
    expect((await call('PUT', '/api/connect/users', { body: { source: 'manual', value: -3 } })).status).toBe(400);
    const res = await call('PUT', '/api/connect/users', { body: { source: 'manual', value: 2500 } });
    expect((await res.json()).users).toEqual({ source: 'manual', value: 2500, updatedAt: Date.UTC(2026, 9, 13) });
    const t = await (await call('GET', '/api/timeline')).json();
    expect(t.snapshots.map((s: { users?: number }) => s.users)).toEqual([undefined, undefined, undefined, 2500]);
  });
});
