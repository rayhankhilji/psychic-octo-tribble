import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composioFor } from '../server/composio.ts';
import { hosted } from '../server/context.ts';
import { settings } from '../server/env.ts';
import { ga4Callback, ga4Link, ga4PropertyList, setUsersSource } from '../server/users.ts';
import { ENV, FakeSupabase, USER, call, givePlan, setup, stubFetch, type Call } from './server-helpers.ts';

/**
 * The Composio path (CONNECT_VIA=composio): the same callbacks and the same
 * timeline, with Composio holding the tokens and proxying every read.
 */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 13, 12);
const json = (body: unknown, status = 200) => Response.json(body, { status });
const BASE = 'https://backend.composio.dev/api/v3.1';

const COMPOSIO_ENV = {
  ...ENV,
  CONNECT_VIA: 'composio',
  COMPOSIO_API_KEY: 'cmp_key',
  COMPOSIO_STRIPE_AUTH_CONFIG: 'ac_stripe',
  COMPOSIO_GITHUB_AUTH_CONFIG: 'ac_github',
  COMPOSIO_GA4_AUTH_CONFIG: 'ac_ga4',
};

const founderSub = (id: string, startDaysAgo: number) => ({
  id,
  customer: `cus_${id}`,
  status: 'active',
  start_date: (NOW - startDaysAgo * DAY) / 1000,
  ended_at: null,
  trial_end: null,
  currency: 'usd',
  items: { data: [{ quantity: 1, price: { unit_amount: 4900, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } } }] },
});

/** A fake Composio: links, the account list, and a proxy that answers like Stripe, GitHub and GA4 would. */
function fakeComposio(opts: { owner?: string; status?: string; livemode?: boolean; upstreamStatus?: number } = {}) {
  const links: Record<string, unknown>[] = [];
  const proxied: { endpoint: string; method: string; params: Record<string, string>; account: string; body?: unknown }[] = [];
  const route = (url: URL, init: RequestInit) => {
    if (!url.href.startsWith(BASE)) return undefined;
    expect(new Headers(init.headers).get('x-api-key')).toBe('cmp_key');
    const path = url.pathname.replace('/api/v3.1', '');
    if (path === '/connected_accounts/link') {
      const b = JSON.parse(String(init.body));
      links.push(b);
      return json({ redirect_url: `https://connect.composio.dev/link/lk_1?toolkit=${b.auth_config_id}`, connected_account_id: 'ca_new', link_token: 'lk_1', expires_at: '2026-10-13T13:00:00Z' }, 201);
    }
    if (path === '/connected_accounts') {
      const q = url.searchParams;
      const owner = opts.owner ?? USER.id;
      const ok = q.get('user_ids') === owner && q.get('connected_account_ids') === 'ca_new';
      return json({ items: ok ? [{ id: 'ca_new', status: opts.status ?? 'ACTIVE', toolkit: { slug: q.get('toolkit_slugs') } }] : [], next_cursor: null });
    }
    if (path === '/connected_accounts/ca_new' && (init.method ?? 'GET') === 'GET') return json({ id: 'ca_new', status: opts.status ?? 'ACTIVE' });
    if (path === '/connected_accounts/ca_new' && init.method === 'DELETE') return json({ success: true });
    if (path === '/tools/execute/proxy') {
      const b = JSON.parse(String(init.body)) as { endpoint: string; method: string; connected_account_id: string; parameters: { name: string; value: string; type: string }[]; body?: unknown };
      const params = Object.fromEntries(b.parameters.filter((p) => p.type === 'query').map((p) => [p.name, p.value]));
      proxied.push({ endpoint: b.endpoint, method: b.method, params, account: b.connected_account_id, body: b.body });
      if (opts.upstreamStatus) return json({ data: { error: { message: 'Expired API Key provided' } }, status: opts.upstreamStatus, headers: {} });
      const e = b.endpoint;
      if (e === 'https://api.stripe.com/v1/account') return json({ data: { id: 'acct_f1', settings: { dashboard: { display_name: 'Nightjar' } } }, status: 200 });
      if (e === 'https://api.stripe.com/v1/balance') return json({ data: { object: 'balance', livemode: opts.livemode ?? true }, status: 200 });
      if (e === 'https://api.stripe.com/v1/subscriptions') {
        // Two pages, to prove the cursor is followed.
        const page = params.starting_after
          ? { data: [founderSub('sub_b', 1)], has_more: false }
          : { data: [founderSub('sub_a', 2)], has_more: true };
        return json({ data: page, status: 200 });
      }
      if (e === 'https://api.github.com/user') return json({ data: { login: 'mara' }, status: 200 });
      if (e === 'https://api.github.com/user/repos') return json({ data: [{ full_name: 'nightjar/app', private: true, default_branch: 'main' }], status: 200 });
      if (e === 'https://api.github.com/repos/nightjar/app') return json({ data: { full_name: 'nightjar/app' }, status: 200 });
      if (e === 'https://api.github.com/repos/nightjar/secret') return json({ data: { message: 'Not Found' }, status: 404 });
      if (e === 'https://api.github.com/repos/nightjar/app/commits')
        return json({ data: [{ commit: { committer: { date: new Date(NOW - DAY).toISOString() }, author: null } }], status: 200 });
      if (e === 'https://api.github.com/repos/nightjar/app/releases') return json({ data: [{ name: 'v2', tag_name: 'v2', draft: false, published_at: new Date(NOW).toISOString() }], status: 200 });
      if (e === 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries')
        return json({ data: { accountSummaries: [{ displayName: 'Nightjar', propertySummaries: [{ property: 'properties/31415', displayName: 'nightjar.dev' }] }] }, status: 200 });
      if (e === 'https://analyticsdata.googleapis.com/v1beta/properties/31415:runReport') {
        const day = (d: number) => new Date(NOW - d * DAY).toISOString().slice(0, 10).replace(/-/g, '');
        return json({ data: { rows: [1, 0].map((d, i) => ({ dimensionValues: [{ value: day(d) }], metricValues: [{ value: String(4000 + i * 100) }] })) }, status: 200 });
      }
      return json({ data: { message: 'no route' }, status: 404 });
    }
    return json({ error: { message: `no fake for ${path}` } }, 404);
  };
  return { route, links, proxied };
}

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

async function start(provider: 'stripe' | 'github', env: Record<string, string> = COMPOSIO_ENV) {
  const res = await call('POST', `/api/connect/${provider}`, { env });
  expect(res.status).toBe(200);
  const { url } = (await res.json()) as { url: string };
  return { url: new URL(url), cookie: res.headers.get('Set-Cookie')!.split(';')[0]! };
}

const get = (path: string, cookie: string | null, env = COMPOSIO_ENV) => call('GET', path, { token: null, headers: cookie ? { Cookie: cookie } : {}, env });

describe('Composio: settings', () => {
  it('is off unless CONNECT_VIA=composio and the provider has an auth config', () => {
    expect(composioFor(ENV, 'stripe')).toBeNull();
    expect(composioFor({ ...COMPOSIO_ENV, CONNECT_VIA: 'native' }, 'stripe')).toBeNull();
    expect(composioFor({ ...COMPOSIO_ENV, COMPOSIO_GITHUB_AUTH_CONFIG: '' }, 'github')).toBeNull();
    expect(composioFor(COMPOSIO_ENV, 'stripe')).toEqual({ apiKey: 'cmp_key', base: BASE, authConfig: 'ac_stripe' });
  });

  it('leaves the native Stripe App flow alone by default', async () => {
    stubFetch(db);
    const { url } = await start('stripe', ENV);
    expect(url.origin).toBe('https://marketplace.stripe.com');
  });
});

describe('Composio: Stripe', () => {
  it('goes out through our own callback to Composio, and back to a stored, named, live connection', async () => {
    const c = fakeComposio();
    stubFetch(db, c.route);
    await call('GET', '/api/me', { env: COMPOSIO_ENV });
    const { url, cookie } = await start('stripe');
    expect(url.pathname).toBe('/api/connect/stripe/callback');
    expect(url.searchParams.get('via')).toBe('composio');

    // Leg one: our callback asks Composio for a link filed under this user, returning to our callback.
    const out = await get(`${url.pathname}${url.search}`, cookie);
    expect(out.status).toBe(302);
    expect(out.headers.get('Location')).toBe('https://connect.composio.dev/link/lk_1?toolkit=ac_stripe');
    expect(c.links[0]).toMatchObject({ auth_config_id: 'ac_stripe', user_id: USER.id });
    const back = new URL(String(c.links[0]!.callback_url));
    expect(`${back.origin}${back.pathname}`).toBe('https://tinytown.test/api/connect/stripe/callback');
    expect(back.searchParams.get('state')).toBe(url.searchParams.get('state'));

    // Leg two: Composio sends the founder back with the account.
    back.searchParams.set('status', 'success');
    back.searchParams.set('connected_account_id', 'ca_new');
    const home = await get(`${back.pathname}${back.search}`, cookie);
    expect(home.headers.get('Location')).toBe('/?connected=stripe');
    const row = db.row('connections', { provider: 'stripe' })!;
    expect(row).toMatchObject({ account_id: 'acct_f1', display_name: 'Nightjar', livemode: true, secret: null, metadata: { via: 'composio', composio: 'ca_new' } });

    const me = await (await call('GET', '/api/me', { env: COMPOSIO_ENV })).json();
    expect(me.connections.stripe).toMatchObject({ account: 'acct_f1', name: 'Nightjar', livemode: true });
  });

  it("refuses an account that isn't this founder's, an unfinished one, a test-mode one, and a callback from another browser", async () => {
    for (const [opts, expected] of [
      [{ owner: 'someone-else' }, 'stripe%3Astate'],
      [{ status: 'INITIATED' }, 'stripe%3Astate'],
      [{ livemode: false }, 'stripe%3Atestmode'],
    ] as const) {
      db = setup();
      givePlan(db);
      stubFetch(db, fakeComposio(opts).route);
      const { url, cookie } = await start('stripe');
      const q = new URLSearchParams({ state: url.searchParams.get('state')!, status: 'success', connected_account_id: 'ca_new' });
      const res = await get(`/api/connect/stripe/callback?${q}`, cookie);
      expect(res.headers.get('Location')).toBe(`/?connect_error=${expected}`);
      expect(db.tables.connections).toHaveLength(0);
    }
    const { url } = await start('stripe');
    const q = new URLSearchParams({ state: url.searchParams.get('state')!, status: 'success', connected_account_id: 'ca_new' });
    expect((await get(`/api/connect/stripe/callback?${q}`, null)).headers.get('Location')).toBe('/?connect_error=stripe%3Astate');
    // Cancelled on Composio's page.
    const again = await start('stripe');
    const failed = new URLSearchParams({ state: again.url.searchParams.get('state')!, status: 'failed' });
    expect((await get(`/api/connect/stripe/callback?${failed}`, again.cookie)).headers.get('Location')).toBe('/?connect_error=stripe%3Adenied');
  });

  it('builds the timeline from every page of subscriptions, read through the proxy', async () => {
    const c = fakeComposio();
    stubFetch(db, c.route);
    db.tables.connections!.push({ user_id: USER.id, provider: 'stripe', account_id: 'acct_f1', display_name: 'Nightjar', livemode: true, secret: null, metadata: { via: 'composio', composio: 'ca_new' }, token_version: 1, connected_at: new Date(NOW).toISOString() });
    const t = await (await call('GET', '/api/timeline', { env: COMPOSIO_ENV })).json();
    expect(t.integrations).toEqual({ stripe: true, github: false });
    expect(t.snapshots.at(-1)).toMatchObject({ customers: 2, mrr: 98 });
    const subs = c.proxied.filter((p) => p.endpoint === 'https://api.stripe.com/v1/subscriptions');
    expect(subs.map((p) => p.params)).toEqual([
      { status: 'all', limit: '100' },
      { status: 'all', limit: '100', starting_after: 'sub_a' },
    ]);
    expect(subs.every((p) => p.account === 'ca_new' && p.method === 'GET')).toBe(true);
  });

  it('asks the founder to reconnect when Stripe refuses the token Composio holds', async () => {
    stubFetch(db, fakeComposio({ upstreamStatus: 401 }).route);
    db.tables.connections!.push({ user_id: USER.id, provider: 'stripe', account_id: 'acct_f1', livemode: true, secret: null, metadata: { via: 'composio', composio: 'ca_new' }, token_version: 1, connected_at: new Date(NOW).toISOString() });
    const res = await call('GET', '/api/timeline', { env: COMPOSIO_ENV });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'not_connected', error: 'Your Stripe connection has expired. Connect Stripe again.' });
  });
});

describe('Composio: GitHub', () => {
  it('connects, lists repositories, checks access to the chosen one, and builds from it', async () => {
    const c = fakeComposio();
    stubFetch(db, c.route);
    const { url, cookie } = await start('github');
    await get(`${url.pathname}${url.search}`, cookie);
    expect(c.links[0]).toMatchObject({ auth_config_id: 'ac_github', user_id: USER.id });
    const back = new URL(String(c.links[0]!.callback_url));
    back.searchParams.set('status', 'success');
    back.searchParams.set('connected_account_id', 'ca_new');
    expect((await get(`${back.pathname}${back.search}`, cookie)).headers.get('Location')).toBe('/?connected=github');
    expect(db.row('connections', { provider: 'github' })).toMatchObject({ account_id: 'composio:ca_new', display_name: 'mara', metadata: { via: 'composio', composio: 'ca_new' } });

    expect(await (await call('GET', '/api/connect/github/repos', { env: COMPOSIO_ENV })).json()).toEqual({ repos: [{ fullName: 'nightjar/app', private: true, defaultBranch: 'main' }] });
    expect((await call('PUT', '/api/connect/github/repo', { body: { repo: 'nightjar/secret' }, env: COMPOSIO_ENV })).status).toBe(400);
    const conns = await (await call('PUT', '/api/connect/github/repo', { body: { repo: 'nightjar/app' }, env: COMPOSIO_ENV })).json();
    expect(conns.github.repo).toBe('nightjar/app');

    const t = await (await call('GET', '/api/timeline', { env: COMPOSIO_ENV })).json();
    expect(t.snapshots.at(-1)).toMatchObject({ releases: 1, commits: 1, release: 'v2' });
  });
});

describe('Users source: test without saving', () => {
  it('checks a PostHog key and reports what it sees, saving nothing', async () => {
    stubFetch(db, (url) => {
      if (url.href !== 'https://us.posthog.com/api/projects/123/query/') return undefined;
      const days = [1, 0].map((d) => new Date(NOW - d * DAY).toISOString().slice(0, 10));
      return json({ results: [{ days, data: [2300, 2340] }] });
    });
    const res = await call('PUT', '/api/connect/users', { body: { source: 'posthog', host: 'us.posthog.com', projectId: '123', apiKey: 'phx_abcdefghijklmnopqrstuvwxyz', test: true } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, source: 'posthog', monthlyActiveUsers: 2340, asOf: Date.UTC(2026, 9, 13), days: 2 });
    expect(db.tables.connections).toHaveLength(0);
    expect(db.row('profiles', { user_id: USER.id })!.users_source).toBe('customers');
  });

  it('says which part PostHog refused', async () => {
    stubFetch(db, (url) => (url.hostname === 'us.posthog.com' ? json({ detail: 'nope' }, 401) : undefined));
    const res = await call('PUT', '/api/connect/users', { body: { source: 'posthog', host: 'us.posthog.com', projectId: '123', apiKey: 'phx_abcdefghijklmnopqrstuvwxyz', test: true } });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/didn't accept the API key/);
  });
});

describe('Composio: Google Analytics as the users source', () => {
  const ctxFor = (path: string, init: { cookie?: string } = {}) =>
    hosted({ req: new Request(`https://tinytown.test${path}`, { headers: init.cookie ? { Cookie: init.cookie } : {} }), url: new URL(`https://tinytown.test${path}`), env: COMPOSIO_ENV, s: settings(COMPOSIO_ENV), now: NOW });

  it('connects through Composio, lists properties, tests one, then counts 28-day actives per day', async () => {
    const c = fakeComposio();
    const calls: Call[] = stubFetch(db, c.route);
    await call('GET', '/api/me', { env: COMPOSIO_ENV });
    db.tables.connections!.push({ user_id: USER.id, provider: 'stripe', account_id: 'acct_f1', livemode: true, secret: null, metadata: { via: 'composio', composio: 'ca_new' }, token_version: 1, connected_at: new Date(NOW).toISOString() });

    const { body, setCookie } = ga4Link(ctxFor('/api/connect/ga4'), USER);
    const cookie = setCookie.split(';')[0]!;
    const first = new URL(body.url);
    const out = await ga4Callback(ctxFor(`${first.pathname}${first.search}`, { cookie }));
    expect(out.headers.get('Location')).toBe('https://connect.composio.dev/link/lk_1?toolkit=ac_ga4');
    const back = new URL(String(c.links[0]!.callback_url));
    back.searchParams.set('status', 'success');
    back.searchParams.set('connected_account_id', 'ca_new');
    const home = await ga4Callback(ctxFor(`${back.pathname}${back.search}`, { cookie }));
    expect(home.headers.get('Location')).toBe('/?connected=ga4');
    expect(db.row('connections', { provider: 'ga4' })).toMatchObject({ metadata: { via: 'composio', composio: 'ca_new' } });

    expect(await ga4PropertyList(ctxFor('/api/connect/ga4/properties'), USER)).toEqual({ properties: [{ id: '31415', name: 'nightjar.dev', account: 'Nightjar' }] });
    const tested = await setUsersSource(ctxFor('/api/connect/users'), USER, { source: 'ga4', property: '31415', test: true });
    expect(tested).toEqual({ ok: true, source: 'ga4', monthlyActiveUsers: 4100, asOf: Date.UTC(2026, 9, 13), days: 2 });
    await setUsersSource(ctxFor('/api/connect/users'), USER, { source: 'ga4', property: '31415', propertyName: 'nightjar.dev' });
    expect(db.row('profiles', { user_id: USER.id })!.users_source).toBe('ga4');

    const report = c.proxied.find((p) => p.endpoint.endsWith(':runReport'))!;
    expect(report).toMatchObject({ method: 'POST', body: { metrics: [{ name: 'active28DayUsers' }], dimensions: [{ name: 'date' }] } });
    const t = await (await call('GET', '/api/timeline', { env: COMPOSIO_ENV })).json();
    expect(t.snapshots.slice(-2).map((s: { users?: number }) => s.users)).toEqual([4000, 4100]);
    expect(calls.some((x) => x.url.hostname === 'analyticsdata.googleapis.com')).toBe(false);
  });
});
