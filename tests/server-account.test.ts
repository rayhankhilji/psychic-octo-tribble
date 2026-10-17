import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_DELETED_COMMENT, DELETES_PER_HOUR, EXPORTS_PER_HOUR } from '../server/account.ts';
import { track } from '../server/analytics.ts';
import { stripeSignatureHeader } from '../server/crypto.ts';
import { notify } from '../server/notify.ts';
import { ENV, FakeSupabase, TOKEN, USER, call, form, givePlan, setup, stubFetch, type Call } from './server-helpers.ts';

vi.mock('../server/notify.ts', async (orig) => ({ ...(await orig<typeof import('../server/notify.ts')>()), notify: vi.fn(async () => {}) }));
vi.mock('../server/analytics.ts', async (orig) => ({ ...(await orig<typeof import('../server/analytics.ts')>()), track: vi.fn(async () => {}) }));

type Row = Record<string, unknown>;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers });
/** A failure fetchWithRetry hands straight back instead of retrying (the server asked for more than its longest wait). */
const down = () => json({ message: 'down' }, 503, { 'Retry-After': '3600' });

/** Looks like a credential; the export must not contain anything shaped like these. */
const SECRET_REFRESH = 'v1.SEALED-REFRESH-TOKEN';
const SECRET_ACCESS = 'v1.SEALED-ACCESS-TOKEN';

/**
 * The fake Supabase plus what accounts need: the Auth Admin API, the 0006
 * SQL functions, other modules' tables, and 0006's guard (inserts for a
 * user who no longer exists are dropped).
 */
class AccountDb extends FakeSupabase {
  admin = new Map<string, Row>();
  gone = new Set<string>();
  /** Tables from other migrations (email preferences and the like). */
  extra: Record<string, Row[]> = {};
  rpcMissing = false;
  rpcDown = false;
  adminDown = false;

  override async handle(url: URL, init: RequestInit): Promise<Response | undefined> {
    if (url.origin !== this.url) return undefined;
    const method = init.method ?? 'GET';
    const admin = /^\/auth\/v1\/admin\/users\/([\w-]+)$/.exec(url.pathname);
    if (admin) {
      if (new Headers(init.headers).get('apikey') !== 'service') return json({ msg: 'no' }, 401);
      if (this.adminDown) return down();
      const id = admin[1]!;
      const user = this.admin.get(id);
      if (!user) return json({ code: 404, error_code: 'user_not_found', msg: 'User not found' }, 404);
      if (method === 'GET') return json(user);
      if (method === 'DELETE') {
        this.admin.delete(id);
        this.gone.add(id);
        for (const [token, u] of this.users) if (u.id === id) this.users.delete(token);
        // 0001's foreign keys cascade.
        for (const t of Object.keys(this.tables)) this.tables[t] = this.tables[t]!.filter((r) => r.user_id !== id);
        return json({});
      }
    }
    const rpc = /^\/rest\/v1\/rpc\/(\w+)$/.exec(url.pathname);
    if (rpc) {
      const args = JSON.parse(String(init.body ?? '{}')) as { uid?: string };
      if (rpc[1] === 'rate_hit') return json([{ allowed: true, retry_after_s: 0 }]);
      if (this.rpcMissing) return json({ code: 'PGRST202', message: 'Could not find the function' }, 404);
      if (this.rpcDown) return down();
      if (rpc[1] === 'delete_user_data') {
        const counts: Record<string, number> = {};
        for (const store of [this.tables, this.extra]) {
          for (const t of Object.keys(store)) {
            const before = store[t]!.length;
            store[t] = store[t]!.filter((r) => r.user_id !== args.uid);
            if (before > store[t]!.length) counts[t] = before - store[t]!.length;
          }
        }
        return json(counts);
      }
      if (rpc[1] === 'export_user_data') {
        const out: Record<string, Row[]> = {};
        for (const [t, rows] of Object.entries(this.extra)) {
          const mine = rows.filter((r) => r.user_id === args.uid).map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !/token|secret|key|hash/i.test(k))));
          if (mine.length) out[t] = mine;
        }
        return json(out);
      }
    }
    const table = /^\/rest\/v1\/(\w+)$/.exec(url.pathname)?.[1];
    if (table && method === 'POST' && this.gone.has(String(JSON.parse(String(init.body ?? '{}')).user_id))) return json([]);
    return super.handle(url, init);
  }
}

/** Our Stripe account: the customer's subscriptions, Checkout sessions and the customer itself. */
class FakeStripe {
  subs: Row[] = [];
  sessions: Row[] = [];
  customers = new Map<string, Row>([['cus_1', { id: 'cus_1', metadata: {} }]]);
  down = false;
  /** The next cancel answers "already cancelled", as if a webhook-driven cancel won the race. */
  raceCancel = false;

  route = (url: URL, init: RequestInit): Response | undefined => {
    if (url.host !== 'api.stripe.com') return undefined;
    if (this.down) return json({ error: { message: 'Stripe is having a moment', type: 'api_error' } }, 500, { 'Stripe-Should-Retry': 'false' });
    const method = init.method ?? 'GET';
    const q = url.searchParams;
    const p = url.pathname;
    const missingCustomer = (id: string | null) => json({ error: { message: `No such customer: '${id}'`, type: 'invalid_request_error', code: 'resource_missing', param: 'customer' } }, 400);
    if (p === '/v1/checkout/sessions' && method === 'GET') {
      return json({ data: this.sessions.filter((s) => s.customer === q.get('customer') && s.status === q.get('status')), has_more: false });
    }
    let m = /^\/v1\/checkout\/sessions\/(\w+)\/expire$/.exec(p);
    if (m && method === 'POST') {
      const s = this.sessions.find((x) => x.id === m![1]);
      if (!s || s.status !== 'open') return json({ error: { message: 'Only open sessions can be expired', type: 'invalid_request_error' } }, 400);
      s.status = 'expired';
      return json(s);
    }
    if (p === '/v1/subscriptions' && method === 'GET') {
      if (!this.customers.has(q.get('customer')!)) return missingCustomer(q.get('customer'));
      expect(q.get('status')).toBe('all');
      return json({ data: this.subs.filter((s) => s.customer === q.get('customer')), has_more: false });
    }
    m = /^\/v1\/subscriptions\/(\w+)$/.exec(p);
    if (m) {
      const s = this.subs.find((x) => x.id === m![1]);
      if (!s) return json({ error: { message: 'No such subscription', type: 'invalid_request_error', code: 'resource_missing' } }, 404);
      if (method === 'GET') return json(s);
      if (method === 'DELETE') {
        if (this.raceCancel) {
          this.raceCancel = false;
          s.status = 'canceled';
        }
        if (s.status === 'canceled') return json({ error: { message: 'This subscription has already been canceled.', type: 'invalid_request_error' } }, 400);
        s.status = 'canceled';
        return json(s);
      }
    }
    m = /^\/v1\/customers\/(\w+)$/.exec(p);
    if (m && method === 'POST') {
      const c = this.customers.get(m[1]!);
      if (!c) return json({ error: { message: 'No such customer', code: 'resource_missing' } }, 404);
      for (const [k, v] of Object.entries(form(String(init.body)))) {
        const key = /^metadata\[(\w+)\]$/.exec(k)?.[1];
        if (key) (c.metadata as Row)[key] = v;
      }
      return json(c);
    }
    return undefined;
  };
}

/** GitHub's side: uninstalling our App. */
class FakeGithub {
  uninstalled: string[] = [];
  status = 202;
  route = (url: URL, init: RequestInit): Response | undefined => {
    if (url.host !== 'api.github.com') return undefined;
    const m = /^\/app\/installations\/(\d+)$/.exec(url.pathname);
    if (!m || init.method !== 'DELETE') return undefined;
    if (this.status === 202) this.uninstalled.push(m[1]!);
    return new Response(null, { status: this.status, headers: this.status >= 500 ? { 'Retry-After': '3600' } : {} });
  };
}

let db: AccountDb;
let stripe: FakeStripe;
let github: FakeGithub;
let calls: Call[];

beforeEach(() => {
  setup();
  db = new AccountDb(ENV.SUPABASE_URL);
  db.users.set(TOKEN, USER);
  db.admin.set(USER.id, {
    id: USER.id,
    email: USER.email,
    created_at: '2026-09-01T10:00:00Z',
    last_sign_in_at: '2026-10-12T08:00:00Z',
    app_metadata: { provider: 'github', providers: ['github', 'email'] },
    user_metadata: { full_name: 'Ada Founder', avatar_url: 'https://avatars.example/ada.png', provider_token: 'gho_should_not_export' },
    identities: [{ provider: 'github', identity_data: { user_name: 'ada', email: USER.email, sub: '123' }, created_at: '2026-09-01T10:00:00Z' }],
  });
  stripe = new FakeStripe();
  github = new FakeGithub();
  calls = stubFetch(db, stripe.route, github.route);
  vi.mocked(notify).mockClear();
  vi.mocked(track).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A founder with everything: a plan, both connections, a city, a cached timeline. */
function seedFounder(status = 'active') {
  givePlan(db, status);
  stripe.subs.push({ id: 'sub_1', customer: 'cus_1', status });
  const t = new Date().toISOString();
  db.tables.profiles!.push({ user_id: USER.id, seed: 777, name: 'Acme', joined_at: 1_780_000_000_000, last_seen: null, users_source: 'customers', users_manual: [], created_at: t });
  db.tables.connections!.push(
    { user_id: USER.id, provider: 'stripe', account_id: 'acct_founder', display_name: 'Acme Inc', livemode: true, secret: SECRET_REFRESH, access_token: SECRET_ACCESS, access_expires_at: t, token_version: 3, metadata: {}, connected_at: t },
    { user_id: USER.id, provider: 'github', account_id: '4401', display_name: 'acme', livemode: null, secret: null, access_token: null, access_expires_at: null, token_version: 0, metadata: { repo: 'acme/app' }, connected_at: t },
  );
  db.tables.worlds!.push({ user_id: USER.id, actions: [{ t: 1_780_000_000_000, kind: 'build', plot: 3, building: 'cafe' }], version: 1 });
  db.tables.timelines!.push({ user_id: USER.id, timeline: { name: 'Acme', days: [{ t: 1_780_000_000_000, mrr: 1234 }] }, fetched_at: t });
  db.extra.email_preferences = [{ user_id: USER.id, product_updates: false, unsubscribe_token: 'tok_secret_unsub' }];
}

const rowsOf = (userId = USER.id) =>
  [...Object.values(db.tables), ...Object.values(db.extra)].flat().filter((r) => r.user_id === userId).length;

const del = (confirm: unknown = USER.email, opts: { env?: Record<string, string | undefined>; token?: string | null } = {}) =>
  call('DELETE', '/api/account', { body: { confirm }, ...opts });

// ─── Export ───────────────────────────────────────────────────────────────

describe('GET /api/account/export', () => {
  it('needs a sign-in, the right method, and hosted mode', async () => {
    expect((await call('GET', '/api/account/export', { token: null })).status).toBe(401);
    expect((await call('GET', '/api/account/export', { token: 'forged' })).status).toBe(401);
    expect((await call('POST', '/api/account/export')).status).toBe(405);
    expect((await call('GET', '/api/account')).status).toBe(405);
    const local = await call('GET', '/api/account/export', { env: {} });
    expect(local.status).toBe(503);
    expect(await local.json()).toMatchObject({ code: 'not_configured' });
  });

  it('downloads everything we hold as a dated JSON file, with no secrets', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T09:30:00Z'));
    seedFounder();
    const res = await call('GET', '/api/account/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="tinytown-export-2026-10-13.json"');
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const text = await res.text();
    const body = JSON.parse(text);

    expect(body).toMatchObject({ format: 'tinytown-account-export', version: 1, exportedAt: '2026-10-13T09:30:00.000Z' });
    expect(body.account).toMatchObject({
      id: USER.id,
      email: USER.email,
      created_at: '2026-09-01T10:00:00Z',
      sign_in_methods: ['github', 'email'],
      profile_from_sign_in: { full_name: 'Ada Founder', avatar_url: 'https://avatars.example/ada.png' },
      identities: [{ provider: 'github', details: { user_name: 'ada', email: USER.email, sub: '123' } }],
    });
    expect(body.profile).toMatchObject({ user_id: USER.id, seed: 777, name: 'Acme', joined_at: 1_780_000_000_000 });
    expect(body.subscription).toMatchObject({ stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', status: 'active', plan_interval: 'month' });
    expect(body.connections).toEqual([
      expect.objectContaining({ provider: 'stripe', account_id: 'acct_founder', display_name: 'Acme Inc', livemode: true, metadata: {} }),
      expect.objectContaining({ provider: 'github', account_id: '4401', metadata: { repo: 'acme/app' } }),
    ]);
    for (const c of body.connections) {
      for (const k of ['secret', 'access_token', 'access_expires_at', 'token_version', 'user_id']) expect(c).not.toHaveProperty(k);
    }
    expect(body.world).toMatchObject({ actions: [{ kind: 'build', building: 'cafe' }], version: 1 });
    expect(body.timeline).toMatchObject({ timeline: { days: [{ mrr: 1234 }] } });
    expect(body.other).toEqual({ email_preferences: [{ user_id: USER.id, product_updates: false }] });
    expect(body.notes.join(' ')).toMatch(/Stripe keeps them after you delete your account/);

    for (const secret of [SECRET_REFRESH, SECRET_ACCESS, 'gho_should_not_export', 'tok_secret_unsub', ENV.SUPABASE_SERVICE_ROLE_KEY, ENV.STRIPE_BILLING_SECRET_KEY, ENV.TOKEN_ENCRYPTION_KEY]) {
      expect(text).not.toContain(secret);
    }
    // Reads only: an export never writes or calls a provider.
    expect(calls.filter((c) => (c.init.method ?? 'GET') !== 'GET' && !c.url.pathname.startsWith('/rest/v1/rpc/'))).toEqual([]);
    expect(calls.some((c) => c.url.host !== new URL(ENV.SUPABASE_URL).host)).toBe(false);
  });

  it('works with no plan and no data, and tolerates a missing 0006 and a slow Auth', async () => {
    db.rpcMissing = true;
    db.adminDown = true;
    const res = await call('GET', '/api/account/export');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ account: { id: USER.id, email: USER.email }, profile: null, subscription: null, connections: [], world: null, timeline: null, other: null });
  });

  it('is limited to three an hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T09:00:00Z'));
    for (let i = 0; i < EXPORTS_PER_HOUR; i++) expect((await call('GET', '/api/account/export')).status).toBe(200);
    const limited = await call('GET', '/api/account/export');
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: 'rate_limited' });
    vi.setSystemTime(new Date('2026-10-13T10:00:01Z'));
    expect((await call('GET', '/api/account/export')).status).toBe(200);
  });
});

// ─── Delete ───────────────────────────────────────────────────────────────

const stripeCalls = () => calls.filter((c) => c.url.host === 'api.stripe.com');

describe('DELETE /api/account', () => {
  it('refuses unless the email is typed again, and touches nothing', async () => {
    seedFounder();
    const before = rowsOf();
    for (const confirm of [undefined, 'someone@else.com', 42, 'x'.repeat(400)]) {
      const res = await call('DELETE', '/api/account', { body: confirm === undefined ? {} : { confirm } });
      expect(res.status, String(confirm)).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'bad_request' });
    }
    expect((await call('DELETE', '/api/account', { body: 'not json' })).status).toBe(400);
    expect(rowsOf()).toBe(before);
    expect(stripeCalls()).toEqual([]);
    expect(db.admin.has(USER.id)).toBe(true);
    expect((await call('DELETE', '/api/account', { token: null, body: { confirm: USER.email } })).status).toBe(401);
  });

  it('cancels the plan now, uninstalls GitHub, deletes every row and the sign-in', async () => {
    seedFounder();
    stripe.sessions.push({ id: 'cs_open', customer: 'cus_1', status: 'open' });
    // Case and surrounding spaces don't matter.
    const res = await del('  Founder@Example.COM ');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, stillInstalled: [{ provider: 'stripe', url: 'https://dashboard.stripe.com/apps/installed' }] });

    // Stripe: the open Checkout expired, the plan cancelled at once with no proration or invoice, the customer kept and tagged.
    expect(stripe.sessions[0]!.status).toBe('expired');
    const cancel = stripeCalls().find((c) => c.init.method === 'DELETE')!;
    expect(cancel.url.pathname).toBe('/v1/subscriptions/sub_1');
    expect(Object.fromEntries(cancel.url.searchParams)).toEqual({ invoice_now: 'false', prorate: 'false', 'cancellation_details[comment]': ACCOUNT_DELETED_COMMENT });
    expect(new Headers(cancel.init.headers).get('Authorization')).toBe(`Bearer ${ENV.STRIPE_BILLING_SECRET_KEY}`);
    expect(stripe.subs[0]!.status).toBe('canceled');
    expect(stripe.customers.get('cus_1')!.metadata).toMatchObject({ tinytown_user_id: USER.id, tinytown_deleted_at: expect.any(String) });
    expect(stripeCalls().some((c) => /refund/.test(c.url.pathname))).toBe(false);

    // GitHub: uninstalled with the App's own JWT.
    expect(github.uninstalled).toEqual(['4401']);
    const gh = calls.find((c) => c.url.host === 'api.github.com')!;
    expect(new Headers(gh.init.headers).get('Authorization')).toMatch(/^Bearer eyJ/);

    // Every row (other modules' too), then the auth user, in that order.
    expect(rowsOf()).toBe(0);
    expect(db.admin.has(USER.id)).toBe(false);
    const order = calls.map((c) => c.url.pathname);
    expect(order.indexOf('/rest/v1/rpc/delete_user_data')).toBeGreaterThan(order.indexOf('/v1/subscriptions/sub_1'));
    expect(order.indexOf(`/auth/v1/admin/users/${USER.id}`)).toBeGreaterThan(order.indexOf('/rest/v1/rpc/delete_user_data'));

    expect(notify).toHaveBeenCalledWith(expect.anything(), { kind: 'account.deleted', email: USER.email });
    expect(track).toHaveBeenCalledWith(expect.anything(), USER.id, 'account_deleted', expect.objectContaining({ subscriptionsCanceled: 1 }));
    // The token is dead: Supabase no longer knows the user.
    expect((await call('GET', '/api/me', { token: 'another-token-for-them' })).status).toBe(401);
  });

  it('cancels a past-due plan and any stray second subscription, and leaves finished ones alone', async () => {
    seedFounder('past_due');
    stripe.subs.push({ id: 'sub_2', customer: 'cus_1', status: 'active' }, { id: 'sub_old', customer: 'cus_1', status: 'canceled' }, { id: 'sub_x', customer: 'cus_1', status: 'incomplete_expired' });
    expect((await del()).status).toBe(200);
    const cancelled = stripeCalls()
      .filter((c) => c.init.method === 'DELETE')
      .map((c) => c.url.pathname);
    expect(cancelled).toEqual(['/v1/subscriptions/sub_1', '/v1/subscriptions/sub_2']);
    expect(track).toHaveBeenCalledWith(expect.anything(), USER.id, 'account_deleted', expect.objectContaining({ subscriptionsCanceled: 2 }));
  });

  it('needs no Stripe at all for a founder who never reached Checkout', async () => {
    db.tables.profiles!.push({ user_id: USER.id, seed: 1, name: 'Just looking', joined_at: null, last_seen: null, users_source: 'customers', users_manual: [], created_at: new Date().toISOString() });
    const res = await del(USER.email, { env: { ...ENV, STRIPE_BILLING_SECRET_KEY: undefined, GITHUB_APP_SLUG: undefined } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, stillInstalled: [] });
    expect(stripeCalls()).toEqual([]);
    expect(rowsOf()).toBe(0);
    expect(db.admin.has(USER.id)).toBe(false);
  });

  it("treats a customer Stripe no longer has as nothing to cancel", async () => {
    seedFounder();
    stripe.customers.clear();
    expect((await del()).status).toBe(200);
    expect(db.admin.has(USER.id)).toBe(false);
  });

  it('when Stripe is down, deletes nothing and says so; a retry finishes', async () => {
    seedFounder();
    stripe.down = true;
    const before = rowsOf();
    const res = await del();
    expect(res.status).toBe(502);
    const err = await res.json();
    expect(err).toMatchObject({ code: 'upstream' });
    expect(err.error).toMatch(/nothing has been deleted yet/);
    expect(rowsOf()).toBe(before);
    expect(db.admin.has(USER.id)).toBe(true);
    expect(github.uninstalled).toEqual([]);
    expect(notify).not.toHaveBeenCalled();

    stripe.down = false;
    expect((await del()).status).toBe(200);
    expect(stripe.subs[0]!.status).toBe('canceled');
    expect(rowsOf()).toBe(0);
  });

  it('when the database or Auth fails after billing, a retry picks up where it stopped', async () => {
    seedFounder();
    db.rpcDown = true;
    let res = await del();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/Nothing more will be charged/);
    expect(stripe.subs[0]!.status).toBe('canceled');
    expect(db.admin.has(USER.id)).toBe(true);

    db.rpcDown = false;
    db.adminDown = true;
    res = await del();
    expect(res.status).toBe(502);
    expect(rowsOf()).toBe(0);
    expect(db.admin.has(USER.id)).toBe(true);

    db.adminDown = false;
    const cancelsSoFar = stripeCalls().filter((c) => c.init.method === 'DELETE').length;
    res = await del();
    expect(res.status).toBe(200);
    // Nothing was cancelled twice.
    expect(stripeCalls().filter((c) => c.init.method === 'DELETE').length).toBe(cancelsSoFar);
    expect(db.admin.has(USER.id)).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('counts a user Auth no longer has as already deleted', async () => {
    seedFounder();
    db.admin.delete(USER.id);
    expect((await del()).status).toBe(200);
    expect(rowsOf()).toBe(0);
  });

  it('accepts a cancel that something else got to first', async () => {
    seedFounder();
    stripe.raceCancel = true;
    expect((await del()).status).toBe(200);
    expect(stripe.subs[0]!.status).toBe('canceled');
  });

  it("won't delete while it can't stop a live plan", async () => {
    seedFounder();
    // No billing key on this server.
    let res = await del(USER.email, { env: { ...ENV, STRIPE_BILLING_SECRET_KEY: undefined } });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'not_configured' });
    // A test-mode key can't see a live-mode customer.
    db.tables.subscriptions![0]!.livemode = true;
    res = await del();
    expect(res.status).toBe(503);
    expect(rowsOf()).toBeGreaterThan(0);
    expect(db.admin.has(USER.id)).toBe(true);

    // A plan that has already ended needs nothing from Stripe.
    db.tables.subscriptions![0]!.status = 'canceled';
    res = await del(USER.email, { env: { ...ENV, STRIPE_BILLING_SECRET_KEY: undefined } });
    expect(res.status).toBe(200);
  });

  it("keeps a GitHub installation a co-founder still uses, and reports one it couldn't remove", async () => {
    seedFounder();
    const cofounder = '6f1c2b7e-0000-4000-8000-000000000002';
    db.tables.connections!.push({ user_id: cofounder, provider: 'github', account_id: '4401', metadata: {}, connected_at: new Date().toISOString() });
    let res = await del();
    expect(res.status).toBe(200);
    expect((await res.json()).stillInstalled.map((s: { provider: string }) => s.provider)).toEqual(['stripe']);
    expect(calls.some((c) => c.url.host === 'api.github.com')).toBe(false);
    expect(db.row('connections', { user_id: cofounder })).toBeDefined();

    // A second founder whose uninstall GitHub refuses.
    const other = { id: '6f1c2b7e-0000-4000-8000-000000000003', email: 'b@example.com' };
    db.users.set('token-b', other);
    db.admin.set(other.id, { id: other.id, email: other.email });
    db.tables.connections!.push({ user_id: other.id, provider: 'github', account_id: '5500', metadata: {}, connected_at: new Date().toISOString() });
    github.status = 500;
    res = await call('DELETE', '/api/account', { token: 'token-b', body: { confirm: other.email } });
    expect(res.status).toBe(200);
    expect((await res.json()).stillInstalled).toEqual([{ provider: 'github', url: 'https://github.com/settings/installations' }]);
    expect(db.row('connections', { user_id: other.id })).toBeUndefined();
  });

  it('falls back to deleting 0001 tables when 0006 is missing', async () => {
    seedFounder();
    db.rpcMissing = true;
    expect((await del()).status).toBe(200);
    for (const t of ['profiles', 'subscriptions', 'connections', 'worlds', 'timelines']) expect(db.row(t, { user_id: USER.id }), t).toBeUndefined();
  });

  it('asks an account with no email to type DELETE', async () => {
    const id = '6f1c2b7e-0000-4000-8000-000000000004';
    db.users.set('token-c', { id, email: null });
    db.admin.set(id, { id });
    expect((await call('DELETE', '/api/account', { token: 'token-c', body: { confirm: 'nope' } })).status).toBe(400);
    expect((await call('DELETE', '/api/account', { token: 'token-c', body: { confirm: 'DELETE' } })).status).toBe(200);
    expect(notify).not.toHaveBeenCalled();
  });

  it('is rate-limited', async () => {
    for (let i = 0; i < DELETES_PER_HOUR; i++) expect((await del('wrong@example.com')).status).toBe(400);
    expect((await del()).status).toBe(429);
  });

  it("a Stripe webhook arriving after the account is gone doesn't bring it back", async () => {
    seedFounder();
    expect((await del()).status).toBe(200);
    const sub = {
      id: 'sub_1',
      customer: 'cus_1',
      status: 'canceled',
      livemode: false,
      cancel_at_period_end: false,
      metadata: { user_id: USER.id },
      items: { data: [{ current_period_end: 1_800_000_000, price: { id: 'price_month', recurring: { interval: 'month' } } }] },
    };
    stubFetch(db, (url) => (url.host === 'api.stripe.com' && url.pathname === '/v1/subscriptions/sub_1' ? json(sub) : undefined));
    const payload = JSON.stringify({ id: 'evt_late', type: 'customer.subscription.deleted', data: { object: sub } });
    const sig = stripeSignatureHeader(payload, ENV.STRIPE_WEBHOOK_SECRET, Math.floor(Date.now() / 1000));
    await call('POST', '/api/billing/webhook', { token: null, body: payload, headers: { 'Stripe-Signature': sig } });
    // 0006's guard dropped the write. (Whether Stripe then stops retrying is
    // billing's call: it should treat a dropped write for a missing row as done.)
    expect(rowsOf()).toBe(0);
    expect(db.row('subscriptions', { stripe_customer_id: 'cus_1' })).toBeUndefined();
  });
});
