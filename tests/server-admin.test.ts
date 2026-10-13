import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAccessCaches } from '../server/access.ts';
import { resetCaches } from '../server/app.ts';
import { ENV, FakeSupabase, TOKEN, USER, call, stubFetch } from './server-helpers.ts';

vi.mock('../server/notify.ts', () => ({ notify: vi.fn(async () => undefined) }));
const { notify } = await import('../server/notify.ts');
const notified = () => vi.mocked(notify).mock.calls.map(([, e]) => e);

type Row = Record<string, unknown>;

/**
 * The shared fake Supabase plus what the console uses: PostgREST's range,
 * list and null filters, ordering, paging, counts and column selection, the
 * Auth admin API, and the tables from migration 0004. Tables a test hasn't
 * created answer 404, as PostgREST does for a table that doesn't exist.
 */
class AdminFake extends FakeSupabase {
  accounts = new Map<string, Row>();
  nextId = 1;

  constructor() {
    super(ENV.SUPABASE_URL);
    Object.assign(this.tables, { waitlist: [], admin_audit: [], plan_changes: [] });
  }

  account(id: string, email: string, extra: Row = {}) {
    this.accounts.set(id, { id, email, created_at: '2026-09-01T10:00:00.000Z', last_sign_in_at: '2026-10-12T09:00:00.000Z', email_confirmed_at: '2026-09-01T10:01:00.000Z', app_metadata: { provider: 'email', providers: ['email'] }, ...extra });
  }

  private matcher(params: URLSearchParams) {
    const tests: ((r: Row) => boolean)[] = [];
    for (const [key, raw] of params) {
      if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(key)) continue;
      const get = (r: Row) => {
        const [col, field] = key.split('->>');
        const v = r[col!];
        return field ? (v as Row | undefined)?.[field] ?? null : v;
      };
      const not = raw.startsWith('not.');
      const expr = not ? raw.slice(4) : raw;
      const dot = expr.indexOf('.');
      const op = expr.slice(0, dot);
      const val = expr.slice(dot + 1);
      const test = (r: Row): boolean => {
        const v = get(r);
        switch (op) {
          case 'eq':
            return v != null && String(v) === val;
          case 'neq':
            return v != null && String(v) !== val;
          case 'is':
            return val === 'null' ? v == null : String(v) === val;
          case 'in':
            return val
              .slice(1, -1)
              .split(',')
              .map((s) => s.replace(/^"|"$/g, ''))
              .includes(String(v));
          case 'gte':
            return v != null && String(v) >= val;
          case 'gt':
            return v != null && String(v) > val;
          case 'lte':
            return v != null && String(v) <= val;
          case 'lt':
            return v != null && String(v) < val;
          case 'ilike':
            return v != null && new RegExp(`^${val.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i').test(String(v));
          default:
            throw new Error(`fake PostgREST: no operator ${op}`);
        }
      };
      tests.push(not ? (r) => !test(r) : test);
    }
    return (r: Row) => tests.every((t) => t(r));
  }

  private project(rows: Row[], select: string | null) {
    if (!select || select === '*') return rows.map((r) => ({ ...r }));
    const cols = select.split(',');
    return rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
  }

  override async handle(url: URL, init: RequestInit): Promise<Response | undefined> {
    if (url.origin !== this.url) return undefined;
    const headers = new Headers(init.headers);
    if (url.pathname.startsWith('/auth/v1/admin/')) {
      if (headers.get('apikey') !== 'service') return Response.json({}, { status: 401 });
      const id = /\/users\/([^/]+)$/.exec(url.pathname)?.[1];
      if (id) return this.accounts.has(id) ? Response.json(this.accounts.get(id)) : Response.json({ msg: 'User not found' }, { status: 404 });
      const filter = url.searchParams.get('filter') ?? '';
      const users = [...this.accounts.values()].filter((u) => String(u.email).includes(filter)).slice(0, Number(url.searchParams.get('per_page') ?? 50));
      return Response.json({ users, aud: 'authenticated' });
    }
    if (!url.pathname.startsWith('/rest/v1/')) return super.handle(url, init);
    const name = url.pathname.slice('/rest/v1/'.length);
    if (headers.get('apikey') !== 'service') return Response.json({ message: 'no' }, { status: 401 });
    if (!this.tables[name]) return Response.json({ code: 'PGRST205', message: `Could not find the table 'public.${name}'` }, { status: 404 });
    const p = url.searchParams;
    const match = this.matcher(p);
    const prefer = headers.get('Prefer') ?? '';
    const method = init.method ?? 'GET';

    if (method === 'GET') {
      let rows = this.tables[name]!.filter(match);
      const total = rows.length;
      for (const o of (p.get('order') ?? '').split(',').filter(Boolean).reverse()) {
        const [col, dir] = o.split('.');
        rows = [...rows].sort((a, b) => {
          const x = a[col!] as string | number | null;
          const y = b[col!] as string | number | null;
          const c = x == null ? 1 : y == null ? -1 : x < y ? -1 : x > y ? 1 : 0;
          return dir === 'desc' ? -c : c;
        });
      }
      const offset = Number(p.get('offset') ?? 0);
      rows = rows.slice(offset, offset + Number(p.get('limit') ?? 1e9));
      const h: Record<string, string> = {};
      if (prefer.includes('count=exact')) h['Content-Range'] = rows.length ? `${offset}-${offset + rows.length - 1}/${total}` : `*/${total}`;
      return Response.json(this.project(rows, p.get('select')), { headers: h });
    }
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (method === 'POST') {
      const keys = (p.get('on_conflict') ?? '').split(',').filter(Boolean);
      const out: Row[] = [];
      for (const item of Array.isArray(body) ? (body as Row[]) : [body as Row]) {
        const existing = keys.length ? this.tables[name]!.find((r) => keys.every((k) => r[k] != null && r[k] === item[k])) : undefined;
        if (existing) {
          if (prefer.includes('ignore-duplicates')) continue;
          Object.assign(existing, item);
          out.push(existing);
          continue;
        }
        const row: Row = { ...this.defaults(name), ...item };
        this.tables[name]!.push(row);
        out.push(row);
      }
      return prefer.includes('return=minimal') ? new Response(null, { status: 201 }) : Response.json(this.project(out, p.get('select')), { status: 201 });
    }
    if (method === 'PATCH') {
      const rows = this.tables[name]!.filter(match);
      for (const r of rows) Object.assign(r, body);
      return prefer.includes('return=minimal') ? new Response(null, { status: 204 }) : Response.json(this.project(rows, p.get('select')));
    }
    if (method === 'DELETE') {
      this.tables[name] = this.tables[name]!.filter((r) => !match(r));
      return new Response(null, { status: 204 });
    }
    return Response.json({}, { status: 405 });
  }

  private defaults(table: string): Row {
    const now = new Date().toISOString();
    switch (table) {
      case 'profiles':
        return { seed: 12345, name: 'Your Startup', joined_at: null, last_seen: null, users_source: 'customers', users_manual: [], created_at: now };
      case 'subscriptions':
        return { stripe_customer_id: null, stripe_subscription_id: null, status: 'none', price_id: null, plan_interval: null, current_period_end: null, cancel_at_period_end: false, livemode: null, comp: false, comp_reason: null, comp_by: null, comp_at: null };
      case 'waitlist':
        return { source: 'import', created_at: now, invited_at: null, wave: null, notified_at: null, signed_up_at: null, user_id: null };
      case 'admin_audit':
        return { id: this.nextId++, at: now, target: null, request_id: null, status: 'ok', detail: {} };
      case 'worlds':
        return { actions: [], version: 0 };
      default:
        return {};
    }
  }
}

const ADMIN = { id: '6f1c2b7e-0000-4000-8000-0000000000ad', email: 'Boss@TinyTown.test' };
const ADMIN_TOKEN = 'admin-access-token';
const OTHER = { id: '6f1c2b7e-0000-4000-8000-000000000002', email: 'second@example.com' };
const OTHER_TOKEN = 'other-access-token';

const WAITLIST_ENV = { ...ENV, ADMIN_EMAILS: 'someone@else.test, boss@tinytown.test', ACCESS_MODE: 'waitlist' };
const OPEN_ENV = { ...ENV, ADMIN_EMAILS: 'boss@tinytown.test', ACCESS_MODE: 'open' };

const prices = (url: URL) => {
  if (url.host !== 'api.stripe.com' || !url.pathname.startsWith('/v1/prices/')) return undefined;
  const year = url.pathname.endsWith('price_year');
  return Response.json({ id: year ? 'price_year' : 'price_month', unit_amount: year ? 9900 : 1200, currency: 'usd', recurring: { interval: year ? 'year' : 'month' } });
};

let db: AdminFake;
let rid = 0;
const requestId = () => `test-request-${++rid}-${Date.now()}`;

beforeEach(() => {
  resetCaches();
  resetAccessCaches();
  vi.mocked(notify).mockClear();
  db = new AdminFake();
  db.users.set(TOKEN, USER);
  db.users.set(ADMIN_TOKEN, ADMIN);
  db.users.set(OTHER_TOKEN, OTHER);
  db.account(USER.id, USER.email);
  db.account(ADMIN.id, ADMIN.email.toLowerCase());
  db.account(OTHER.id, OTHER.email);
});
afterEach(() => vi.unstubAllGlobals());

const admin = (method: string, path: string, body?: unknown, env: Record<string, string | undefined> = WAITLIST_ENV) => call(method, path, { token: ADMIN_TOKEN, env, ...(body !== undefined ? { body } : {}) });

const waiting = (email: string, createdAt: string, extra: Row = {}) => db.tables.waitlist!.push({ email, source: 'import', created_at: createdAt, invited_at: null, wave: null, notified_at: null, signed_up_at: null, user_id: null, ...extra });

const subscription = (userId: string, status: string, extra: Row = {}) =>
  db.tables.subscriptions!.push({
    user_id: userId,
    stripe_customer_id: `cus_${userId.slice(-4)}`,
    stripe_subscription_id: `sub_${userId.slice(-4)}`,
    status,
    price_id: 'price_month',
    plan_interval: 'month',
    current_period_end: null,
    cancel_at_period_end: false,
    livemode: true,
    comp: false,
    ...extra,
  });

// ─── The waitlist gate ────────────────────────────────────────────────────

describe('checkAccess', () => {
  it('lets everyone in with ACCESS_MODE unset, without touching the waitlist', async () => {
    const calls = stubFetch(db);
    const res = await call('GET', '/api/me', { env: ENV });
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.url.pathname.endsWith('/waitlist'))).toBe(false);
  });

  it('turns away someone not invited with a warm 403, and puts them in line', async () => {
    stubFetch(db);
    const res = await call('GET', '/api/me', { env: WAITLIST_ENV });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('not_invited');
    expect(body.error).toMatch(/waitlist/);
    expect(body.error).toMatch(/email you/);
    expect(db.tables.waitlist).toEqual([expect.objectContaining({ email: 'founder@example.com', source: 'signin', invited_at: null })]);
  });

  it('keeps someone waiting in their place (no second row, original source)', async () => {
    stubFetch(db);
    waiting('founder@example.com', '2026-01-01T00:00:00.000Z');
    expect((await call('GET', '/api/me', { env: WAITLIST_ENV })).status).toBe(403);
    expect(db.tables.waitlist).toHaveLength(1);
    expect(db.tables.waitlist![0]).toMatchObject({ source: 'import', created_at: '2026-01-01T00:00:00.000Z' });
  });

  it('lets an invited email in, whatever its case, and records the sign-up', async () => {
    stubFetch(db);
    db.users.set(TOKEN, { ...USER, email: 'Founder@Example.com' });
    waiting('founder@example.com', '2026-01-01T00:00:00.000Z', { invited_at: '2026-10-01T00:00:00.000Z', wave: 1 });
    const res = await call('GET', '/api/me', { env: WAITLIST_ENV });
    expect(res.status).toBe(200);
    expect(db.tables.waitlist![0]).toMatchObject({ user_id: USER.id, signed_up_at: expect.any(String) });
  });

  it('always lets admins in', async () => {
    stubFetch(db);
    const res = await call('GET', '/api/me', { token: ADMIN_TOKEN, env: WAITLIST_ENV });
    expect(res.status).toBe(200);
  });

  it('lets in anyone who already pays, or has a comp, but not a canceled plan', async () => {
    stubFetch(db);
    subscription(USER.id, 'past_due');
    expect((await call('GET', '/api/me', { env: WAITLIST_ENV })).status).toBe(200);

    subscription(OTHER.id, 'active', { comp: true, comp_reason: 'Design partner', stripe_customer_id: null, stripe_subscription_id: null });
    expect((await call('GET', '/api/me', { token: OTHER_TOKEN, env: WAITLIST_ENV })).status).toBe(200);

    db.tables.subscriptions = [];
    subscription(USER.id, 'canceled');
    resetAccessCaches();
    expect((await call('GET', '/api/me', { env: WAITLIST_ENV })).status).toBe(403);
  });

  it('remembers a no briefly, and an invite clears it on this instance', async () => {
    const calls = stubFetch(db);
    waiting('founder@example.com', '2026-01-01T00:00:00.000Z');
    expect((await call('GET', '/api/me', { env: WAITLIST_ENV })).status).toBe(403);
    const lookups = calls.filter((c) => c.url.pathname.endsWith('/waitlist')).length;
    expect((await call('GET', '/api/me', { env: WAITLIST_ENV })).status).toBe(403);
    expect(calls.filter((c) => c.url.pathname.endsWith('/waitlist')).length).toBe(lookups);

    const inv = await admin('POST', '/api/admin/waitlist/invite-emails', { emails: ['founder@example.com'], requestId: requestId() });
    expect(inv.status).toBe(200);
    expect((await call('GET', '/api/me', { env: WAITLIST_ENV })).status).toBe(200);
  });

  it('in explicit open mode, still records when someone from the list signs up', async () => {
    stubFetch(db);
    waiting('founder@example.com', '2026-01-01T00:00:00.000Z');
    expect((await call('GET', '/api/me', { env: OPEN_ENV })).status).toBe(200);
    expect(db.tables.waitlist![0]).toMatchObject({ user_id: USER.id, signed_up_at: expect.any(String) });
  });
});

// ─── Who can see the console ──────────────────────────────────────────────

describe('/api/admin is invisible to everyone but admins', () => {
  it('answers exactly like an unknown route for no token, a bad token, a founder, or no ADMIN_EMAILS', async () => {
    stubFetch(db);
    const unknown = await call('GET', '/api/nothing-here', { token: null, env: WAITLIST_ENV });
    const expected = { status: unknown.status, body: await unknown.json() };
    expect(expected.status).toBe(404);
    for (const [token, env] of [
      [null, WAITLIST_ENV],
      ['forged', WAITLIST_ENV],
      [TOKEN, WAITLIST_ENV],
      [ADMIN_TOKEN, { ...WAITLIST_ENV, ADMIN_EMAILS: '' }],
      [ADMIN_TOKEN, {}],
    ] as const) {
      for (const [method, path] of [
        ['GET', '/api/admin/overview'],
        ['GET', '/api/admin'],
        ['POST', '/api/admin/waitlist/invite'],
        ['DELETE', `/api/admin/users/${USER.id}/comp`],
      ]) {
        const res = await call(method!, path!, { token, env, body: method === 'GET' ? undefined : { count: 5 } });
        expect({ status: res.status, body: await res.json() }, `${token} ${method} ${path}`).toEqual(expected);
      }
    }
    expect(db.tables.waitlist).toHaveLength(0);
    expect(db.tables.admin_audit).toHaveLength(0);
  });

  it('serves an admin, and 404s their unknown routes and wrong methods too', async () => {
    stubFetch(db);
    const res = await admin('GET', '/api/admin/me');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ email: 'boss@tinytown.test', access: 'waitlist' });
    expect((await admin('GET', '/api/admin/nope')).status).toBe(404);
    expect((await admin('DELETE', '/api/admin/overview')).status).toBe(404);
  });

  it('rate-limits each admin', async () => {
    stubFetch(db);
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await admin('GET', '/api/admin/me')).status;
    expect(last).toBe(429);
  });
});

// ─── The audit log ────────────────────────────────────────────────────────

describe('admin_audit', () => {
  it('logs reads with who, what and the target', async () => {
    stubFetch(db);
    await admin('GET', `/api/admin/users/${USER.id}`);
    expect(db.tables.admin_audit).toEqual([expect.objectContaining({ admin_id: ADMIN.id, admin_email: 'boss@tinytown.test', action: 'user.read', target: USER.id, status: 'ok' })]);
  });

  it('logs a change as started before it runs and ok with its result after', async () => {
    stubFetch(db);
    let seenDuring: Row | undefined;
    vi.mocked(notify).mockImplementationOnce(async () => {
      seenDuring = { ...db.tables.admin_audit!.at(-1)! };
    });
    waiting('a@example.com', '2026-01-01T00:00:00.000Z');
    const res = await admin('POST', '/api/admin/waitlist/invite', { count: 1, requestId: requestId() });
    expect(res.status).toBe(200);
    expect(seenDuring).toMatchObject({ action: 'waitlist.invite_next', status: 'started' });
    expect(db.tables.admin_audit!.at(-1)).toMatchObject({ status: 'ok', detail: { input: { count: 1 }, result: { invited: 1 } } });
  });

  it('refuses a change without a request id, and runs a repeated one once', async () => {
    stubFetch(db);
    waiting('a@example.com', '2026-01-01T00:00:00.000Z');
    waiting('b@example.com', '2026-01-02T00:00:00.000Z');
    expect((await admin('POST', '/api/admin/waitlist/invite', { count: 1 })).status).toBe(400);
    const id = requestId();
    const first = await (await admin('POST', '/api/admin/waitlist/invite', { count: 1, requestId: id })).json();
    const again = await (await admin('POST', '/api/admin/waitlist/invite', { count: 1, requestId: id })).json();
    expect(again).toEqual(first);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(db.tables.waitlist!.filter((r) => r.invited_at)).toHaveLength(1);
  });

  it('records a failed change as an error', async () => {
    stubFetch(db);
    const res = await admin('DELETE', `/api/admin/users/${USER.id}/comp`, { requestId: requestId() });
    expect(res.status).toBe(409);
    expect(db.tables.admin_audit!.at(-1)).toMatchObject({ action: 'comp.revoke', status: 'error', detail: { error: expect.stringMatching(/comp to revoke/) } });
  });
});

// ─── Comps ────────────────────────────────────────────────────────────────

describe('comped plans', () => {
  it('needs a reason', async () => {
    stubFetch(db);
    const res = await admin('POST', `/api/admin/users/${USER.id}/comp`, { reason: ' ', requestId: requestId() });
    expect(res.status).toBe(400);
    expect(db.tables.subscriptions).toHaveLength(0);
  });

  it('grants paid access with no Stripe subscription, and revoking takes it away', async () => {
    stubFetch(db);
    expect((await call('GET', '/api/world/actions', { env: OPEN_ENV })).status).toBe(402);

    const res = await admin('POST', `/api/admin/users/${USER.id}/comp`, { reason: 'Design partner for the launch', requestId: requestId() }, OPEN_ENV);
    expect(res.status).toBe(200);
    expect(db.tables.subscriptions![0]).toMatchObject({
      user_id: USER.id,
      status: 'active',
      comp: true,
      comp_reason: 'Design partner for the launch',
      comp_by: 'boss@tinytown.test',
      stripe_subscription_id: null,
    });
    expect((await call('GET', '/api/world/actions', { env: OPEN_ENV })).status).toBe(200);
    // Comps get past the waitlist too.
    expect((await call('GET', '/api/world/actions', { env: WAITLIST_ENV })).status).toBe(200);

    const off = await admin('DELETE', `/api/admin/users/${USER.id}/comp`, { reason: 'Partnership ended', requestId: requestId() }, OPEN_ENV);
    expect(off.status).toBe(200);
    expect(db.tables.subscriptions![0]).toMatchObject({ status: 'canceled', comp: false });
    expect((await call('GET', '/api/world/actions', { env: OPEN_ENV })).status).toBe(402);
    expect(db.tables.admin_audit!.map((r) => [r.action, r.status])).toEqual([
      ['comp.grant', 'ok'],
      ['comp.revoke', 'ok'],
    ]);
  });

  it("won't comp someone already paying through Stripe", async () => {
    stubFetch(db);
    subscription(USER.id, 'active');
    const res = await admin('POST', `/api/admin/users/${USER.id}/comp`, { reason: 'Friend of the show', requestId: requestId() });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/already pay through Stripe/);
    expect(db.tables.subscriptions![0]).toMatchObject({ comp: false, stripe_subscription_id: expect.any(String) });
  });

  it('404s for an account that does not exist', async () => {
    stubFetch(db);
    const res = await admin('POST', '/api/admin/users/6f1c2b7e-0000-4000-8000-00000000dead/comp', { reason: 'Typo test', requestId: requestId() });
    expect(res.status).toBe(404);
    expect(db.tables.subscriptions).toHaveLength(0);
  });
});

// ─── Invites ──────────────────────────────────────────────────────────────

describe('inviting from the waitlist', () => {
  const seed = (n: number, source = 'import') => {
    for (let i = 0; i < n; i++) {
      // Shuffled insert order: the invite must follow created_at, not the table's order.
      const k = (i * 37) % n;
      waiting(`${source}-${String(k).padStart(3, '0')}@example.com`, new Date(Date.UTC(2026, 0, 1) + k * 60_000).toISOString(), { source });
    }
  };

  it('invites the oldest N in a new wave and hands each one invite email', async () => {
    stubFetch(db);
    seed(120);
    const res = await admin('POST', '/api/admin/waitlist/invite', { count: 50, requestId: requestId() });
    expect(await res.json()).toMatchObject({ invited: 50, wave: 1, remaining: 70 });
    const sent = notified();
    expect(sent).toHaveLength(50);
    expect(sent.every((e) => e.kind === 'access.invited')).toBe(true);
    expect(sent.map((e) => (e as { email: string }).email).sort()).toEqual(Array.from({ length: 50 }, (_, k) => `import-${String(k).padStart(3, '0')}@example.com`));
    const invited = db.tables.waitlist!.filter((r) => r.invited_at);
    expect(invited).toHaveLength(50);
    expect(invited.every((r) => r.wave === 1 && r.notified_at)).toBe(true);

    vi.mocked(notify).mockClear();
    const next = await (await admin('POST', '/api/admin/waitlist/invite', { count: 50, requestId: requestId() })).json();
    expect(next).toMatchObject({ invited: 50, wave: 2, remaining: 20 });
    expect(notified().map((e) => (e as { email: string }).email)).not.toContain('import-000@example.com');
  });

  it('can invite from one source, caps the batch, and previews without changing anything', async () => {
    stubFetch(db);
    seed(10, 'import');
    seed(5, 'producthunt');
    const preview = await (await admin('POST', '/api/admin/waitlist/invite', { count: 3, source: 'producthunt', dryRun: true })).json();
    expect(preview).toMatchObject({ dryRun: true, invited: 3, remaining: 5, wave: 1 });
    expect(notify).not.toHaveBeenCalled();
    expect(db.tables.waitlist!.some((r) => r.invited_at)).toBe(false);

    const res = await (await admin('POST', '/api/admin/waitlist/invite', { count: 3, source: 'producthunt', requestId: requestId() })).json();
    expect(res).toMatchObject({ invited: 3, remaining: 2 });
    expect(db.tables.waitlist!.filter((r) => r.invited_at).every((r) => r.source === 'producthunt')).toBe(true);

    expect((await admin('POST', '/api/admin/waitlist/invite', { count: 501, requestId: requestId() })).status).toBe(400);
  });

  it('invites specific emails: adds new ones, skips the already invited, reports the invalid', async () => {
    stubFetch(db);
    waiting('waiting@example.com', '2026-01-01T00:00:00.000Z');
    waiting('done@example.com', '2026-01-01T00:00:00.000Z', { invited_at: '2026-10-01T00:00:00.000Z', wave: 1, notified_at: '2026-10-01T00:00:00.000Z' });
    const res = await admin('POST', '/api/admin/waitlist/invite-emails', {
      emails: ['Waiting@Example.com', 'done@example.com', 'new@example.com', 'not-an-email', 'new@example.com'],
      requestId: requestId(),
    });
    expect(await res.json()).toEqual({ invited: 2, already: 1, added: 1, invalid: ['not-an-email'], wave: 0 });
    expect(notified()).toEqual([
      { kind: 'access.invited', email: 'waiting@example.com' },
      { kind: 'access.invited', email: 'new@example.com' },
    ]);
    expect(db.tables.waitlist!.find((r) => r.email === 'new@example.com')).toMatchObject({ source: 'admin', wave: 0, invited_at: expect.any(String) });
    expect(db.tables.waitlist!.find((r) => r.email === 'done@example.com')).toMatchObject({ wave: 1, invited_at: '2026-10-01T00:00:00.000Z' });
  });

  it('sends invites a batch cut short never sent, and resends one on request', async () => {
    stubFetch(db);
    waiting('lost@example.com', '2026-01-01T00:00:00.000Z', { invited_at: '2026-10-01T00:00:00.000Z', wave: 1 });
    waiting('waiting@example.com', '2026-01-01T00:00:00.000Z');
    const res = await (await admin('POST', '/api/admin/waitlist/notify-pending', { requestId: requestId() })).json();
    expect(res).toEqual({ sent: 1 });
    expect(notified()).toEqual([{ kind: 'access.invited', email: 'lost@example.com' }]);
    expect(db.tables.waitlist![0]!.notified_at).toEqual(expect.any(String));

    vi.mocked(notify).mockClear();
    expect((await admin('POST', '/api/admin/waitlist/resend', { email: 'lost@example.com', requestId: requestId() })).status).toBe(200);
    // A resend carries its own ref, so the email module's once-per-address dedupe lets it through.
    expect(notified()).toEqual([{ kind: 'access.invited', email: 'lost@example.com', ref: expect.stringMatching(/^resend:\d+$/) }]);
    expect((await admin('POST', '/api/admin/waitlist/resend', { email: 'waiting@example.com', requestId: requestId() })).status).toBe(409);
  });

  it('lists the waitlist with its funnel, sources and waves', async () => {
    stubFetch(db);
    waiting('a@example.com', '2026-01-01T00:00:00.000Z', { invited_at: '2026-10-01T00:00:00.000Z', wave: 1, notified_at: '2026-10-01T00:00:00.000Z', signed_up_at: '2026-10-02T00:00:00.000Z', user_id: USER.id });
    waiting('b@example.com', '2026-01-02T00:00:00.000Z', { invited_at: '2026-10-01T00:00:00.000Z', wave: 1 });
    waiting('c@example.com', '2026-01-03T00:00:00.000Z', { source: 'producthunt' });
    subscription(USER.id, 'active');
    const page = (await (await admin('GET', '/api/admin/waitlist?status=waiting')).json()) as { rows: { email: string }[]; total: number; funnel: unknown; sources: unknown; waves: unknown };
    expect(page.rows.map((r) => r.email)).toEqual(['c@example.com']);
    expect(page.total).toBe(1);
    expect(page.funnel).toEqual({ total: 3, waiting: 1, invited: 2, signedUp: 1, paid: 1, unnotified: 1, lastWave: 1 });
    expect(page.sources).toEqual([
      { source: 'import', total: 2, waiting: 0 },
      { source: 'producthunt', total: 1, waiting: 1 },
    ]);
    expect(page.waves).toEqual([{ wave: 1, invited: 2, signedUp: 1, paid: 1, at: Date.parse('2026-10-01T00:00:00.000Z') }]);
  });
});

// ─── Overview, search and the user page ───────────────────────────────────

describe('overview', () => {
  it('counts accounts, paying founders, MRR, movement, the funnel and broken connections', async () => {
    stubFetch(db, prices);
    const now = Date.now();
    const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
    const id = (n: number) => `6f1c2b7e-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
    for (let i = 0; i < 6; i++) db.tables.profiles!.push({ user_id: id(i), seed: 1, name: 'X', created_at: ago([0.5, 3, 3, 20, 40, 90][i]!) });
    subscription(id(0), 'active');
    subscription(id(1), 'active');
    subscription(id(2), 'active', { plan_interval: 'year', price_id: 'price_year', cancel_at_period_end: true });
    subscription(id(3), 'past_due');
    subscription(id(4), 'active', { comp: true, comp_reason: 'Partner', stripe_subscription_id: null });
    subscription(id(5), 'canceled');
    db.tables.plan_changes!.push(
      { founder_id: id(0), at: ago(0.2), change: 'started', comp: false },
      { founder_id: id(1), at: ago(5), change: 'started', comp: false },
      { founder_id: id(4), at: ago(5), change: 'started', comp: true },
      { founder_id: id(5), at: ago(10), change: 'ended', comp: false },
    );
    waiting('a@example.com', ago(100), { invited_at: ago(5), wave: 1, notified_at: ago(5), signed_up_at: ago(4), user_id: id(0) });
    waiting('b@example.com', ago(99));
    db.tables.connections!.push(
      { user_id: id(0), provider: 'stripe', account_id: 'acct_1', livemode: true, secret: 'sealed-refresh-token', metadata: {} },
      { user_id: id(1), provider: 'stripe', account_id: 'acct_2', livemode: true, secret: null, metadata: {} },
      { user_id: id(2), provider: 'stripe', account_id: 'acct_3', livemode: false, secret: 'sealed-test-token', metadata: {} },
      { user_id: id(0), provider: 'github', account_id: '42', livemode: null, secret: null, metadata: { repo: 'acme/app' } },
      { user_id: id(1), provider: 'github', account_id: '43', livemode: null, secret: null, metadata: {} },
    );

    const res = await admin('GET', '/api/admin/overview');
    const text = await res.text();
    expect(text).not.toContain('sealed');
    const o = JSON.parse(text);
    expect(o.source).toBe('live');
    expect(o.accounts).toEqual({ total: 6, d1: 1, d7: 3, d30: 4 });
    expect(o.paying).toEqual({ total: 5, monthly: 3, yearly: 1, comp: 1, pastDue: 1, cancelling: 1 });
    expect(o.mrr).toEqual({ amount: 3 * 1200 + 825, currency: 'usd' });
    expect(o.movement).toEqual({ d1: { started: 1, ended: 0 }, d7: { started: 2, ended: 0 }, d30: { started: 2, ended: 1 } });
    expect(o.waitlist).toEqual({ total: 2, waiting: 1, invited: 1, signedUp: 1, paid: 1, unnotified: 0, lastWave: 1 });
    expect(o.connections.stripe).toEqual({ total: 3, live: 2, test: 1, broken: 2 });
    expect(o.connections.github).toEqual({ total: 2, noRepo: 1 });
    expect(o.connections.broken).toEqual(
      expect.arrayContaining([
        { userId: id(1), reason: 'No refresh token stored' },
        { userId: id(2), reason: 'Connected in test mode' },
      ]),
    );
    expect(o.series).toEqual([]);
  });

  it("uses the data pipeline's product_daily when it exists", async () => {
    stubFetch(db, prices);
    db.tables.product_daily = Array.from({ length: 10 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, mrr_cents: 1000 * i, paying: i, new_paying: 1, churned: i % 2 }));
    const o = await (await admin('GET', '/api/admin/overview')).json();
    expect(o.source).toBe('product_daily');
    // The last seven days are 3..9, of which 3, 5, 7 and 9 had a churn.
    expect(o.movement.d7).toEqual({ started: 7, ended: 4 });
    expect(o.series).toHaveLength(10);
    expect(o.series.at(-1)).toMatchObject({ mrr: 9000, paying: 9 });
  });

  it('says the waitlist is missing rather than empty when its table does not exist', async () => {
    stubFetch(db, prices);
    delete db.tables.waitlist;
    delete db.tables.plan_changes;
    const o = await (await admin('GET', '/api/admin/overview')).json();
    expect(o.waitlist).toBeNull();
    expect(o.movement).toBeNull();
  });
});

describe('users', () => {
  it('finds people by part of an email, by id, and by Stripe customer', async () => {
    const calls = stubFetch(db);
    subscription(USER.id, 'active');
    waiting('founder2@example.com', '2026-01-01T00:00:00.000Z');
    const byEmail = await (await admin('GET', '/api/admin/users?q=Founder')).json();
    expect(byEmail.users).toEqual([expect.objectContaining({ id: USER.id, email: USER.email, plan: 'active', comp: false })]);
    expect(byEmail.waitlist).toEqual([expect.objectContaining({ email: 'founder2@example.com' })]);
    expect(calls.some((c) => c.url.pathname === '/auth/v1/admin/users' && c.url.searchParams.get('filter') === 'founder')).toBe(true);

    const byId = await (await admin('GET', `/api/admin/users?q=${OTHER.id}`)).json();
    expect(byId.users.map((u: { id: string }) => u.id)).toEqual([OTHER.id]);

    const byCustomer = await (await admin('GET', `/api/admin/users?q=cus_${USER.id.slice(-4)}`)).json();
    expect(byCustomer.users.map((u: { id: string }) => u.id)).toEqual([USER.id]);
  });

  it('shows plan, connections without secrets, world size, last seen and recent actions', async () => {
    stubFetch(db);
    db.tables.profiles!.push({ user_id: USER.id, seed: 7, name: 'Acme', joined_at: 1_760_000_000_000, last_seen: 1_760_400_000_000, users_source: 'customers', users_manual: [], created_at: '2026-09-02T00:00:00.000Z' });
    subscription(USER.id, 'active', { comp: true, comp_reason: 'Design partner', comp_by: 'boss@tinytown.test', comp_at: '2026-10-01T00:00:00.000Z', stripe_subscription_id: null });
    db.tables.connections!.push(
      { user_id: USER.id, provider: 'stripe', account_id: 'acct_9', display_name: 'Acme Inc', livemode: true, secret: 'SEALED-REFRESH', access_token: 'SEALED-ACCESS', metadata: {}, connected_at: '2026-10-01T00:00:00.000Z' },
      { user_id: USER.id, provider: 'posthog', account_id: '123', display_name: null, livemode: null, secret: 'SEALED-POSTHOG', access_token: null, metadata: { host: 'eu.posthog.com' }, connected_at: '2026-10-01T00:00:00.000Z' },
    );
    db.tables.worlds!.push({
      user_id: USER.id,
      version: 3,
      actions: [
        { t: 1, kind: 'build', item: 'park', plot: 'b1-0' },
        { t: 2, kind: 'home', tier: 1, choice: 'loft' },
        { t: 3, kind: 'build', item: 'cafe' },
      ],
    });
    db.tables.timelines!.push({ user_id: USER.id, fetched_at: '2026-10-12T00:00:00.000Z', timeline: { snapshots: [{ t: 1, mrr: 100, customers: 4 }, { t: 2, mrr: 120, customers: 5 }] } });
    waiting('founder@example.com', '2026-01-01T00:00:00.000Z', { invited_at: '2026-10-01T00:00:00.000Z', wave: 1, user_id: USER.id });

    const res = await admin('GET', `/api/admin/users/${USER.id}`);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toMatch(/SEALED/);
    const d = JSON.parse(text);
    expect(d.user).toMatchObject({ id: USER.id, email: USER.email, providers: ['email'], confirmed: true });
    expect(d.profile).toMatchObject({ name: 'Acme', lastSeen: 1_760_400_000_000 });
    expect(d.plan).toMatchObject({ status: 'active', comp: { reason: 'Design partner', by: 'boss@tinytown.test' } });
    expect(d.connections).toEqual([
      expect.objectContaining({ provider: 'stripe', account: 'acct_9', name: 'Acme Inc', health: 'ok' }),
      expect.objectContaining({ provider: 'posthog', detail: 'eu.posthog.com', health: 'ok' }),
    ]);
    expect(d.world).toMatchObject({ actions: 3, built: 2, homeMoves: 1, version: 3 });
    expect(d.world.recent[0]).toEqual({ t: 3, what: 'Built cafe' });
    expect(d.timeline).toMatchObject({ days: 2, mrr: 120, customers: 5 });
    expect(d.waitlist).toMatchObject({ email: 'founder@example.com', wave: 1 });
  });

  it('forces a timeline refresh and reports what happened', async () => {
    stubFetch(db);
    db.tables.profiles!.push({ user_id: USER.id, seed: 7, name: 'Acme', joined_at: null, last_seen: null, users_source: 'customers', users_manual: [], created_at: '2026-09-02T00:00:00.000Z' });
    db.tables.timelines!.push({ user_id: USER.id, fetched_at: new Date().toISOString(), timeline: { snapshots: [] } });
    const res = await (await admin('POST', `/api/admin/users/${USER.id}/refresh`, { requestId: requestId() })).json();
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/Connect Stripe/) });
    expect(db.tables.timelines).toHaveLength(0);
  });

  it('resends an invite to a user by id', async () => {
    stubFetch(db);
    waiting('founder@example.com', '2026-01-01T00:00:00.000Z', { invited_at: '2026-10-01T00:00:00.000Z', wave: 1 });
    const res = await admin('POST', `/api/admin/users/${USER.id}/resend-invite`, { requestId: requestId() });
    expect(res.status).toBe(200);
    expect(notified()).toEqual([{ kind: 'access.invited', email: 'founder@example.com', ref: expect.stringMatching(/^resend:\d+$/) }]);
  });
});

// ─── tools/import-waitlist.mjs ────────────────────────────────────────────

interface ImportTool {
  parseCsv(text: string): string[][];
  prepare(
    rows: string[][],
    opts?: { column?: string | null; source?: string; now?: number },
  ): {
    columns: { email: string; source: string | null; date: string | null };
    read: number;
    entries: { email: string; source: string; created_at: string }[];
    invalid: { line: number; value: string }[];
    duplicates: number;
    undated: number;
  };
  upload(entries: unknown[], opts: { url: string; key: string; fetchImpl: typeof fetch; sleep?: (ms: number) => Promise<void> }): Promise<number>;
}
const toolPath = '../tools/import-waitlist.mjs';
const tool = (await import(toolPath)) as ImportTool;

describe('import-waitlist', () => {
  it('parses quoted fields, doubled quotes, CRLF, a BOM and semicolons', () => {
    expect(tool.parseCsv('﻿Name,Email\r\n"Lee, Ada",ada@example.com\r\n"Say ""hi""",b@example.com\r\n\r\n')).toEqual([
      ['Name', 'Email'],
      ['Lee, Ada', 'ada@example.com'],
      ['Say "hi"', 'b@example.com'],
    ]);
    expect(tool.parseCsv('email;source\nx@example.com;twitter\n')).toEqual([
      ['email', 'source'],
      ['x@example.com', 'twitter'],
    ]);
    expect(tool.parseCsv('a,"line\nbreak"\n')).toEqual([['a', 'line\nbreak']]);
  });

  it('finds the email, source and date columns, dedupes, validates and keeps the queue order', () => {
    const csv = [
      'Submitted At,Your name,E-mail Address,utm_source',
      '2026-03-02 10:00,Bo,bo@example.com,twitter',
      '2026-03-01 09:00,Al,  AL@Example.com ,',
      '2026-03-03 11:00,Cy,not an email,hn',
      '2026-02-28 08:00,Al again,al@example.com,hn',
      'yesterday,Di,di@example.com,hn',
    ].join('\n');
    const p = tool.prepare(tool.parseCsv(csv), { source: 'launch', now: Date.parse('2026-10-13T00:00:00Z') });
    expect(p.columns).toEqual({ email: 'E-mail Address', source: 'utm_source', date: 'Submitted At' });
    expect(p.read).toBe(5);
    expect(p.duplicates).toBe(1);
    expect(p.invalid).toEqual([{ line: 4, value: 'not an email' }]);
    expect(p.undated).toBe(1);
    expect(p.entries.map((e) => [e.email, e.source])).toEqual([
      ['al@example.com', 'launch'],
      ['bo@example.com', 'twitter'],
      ['di@example.com', 'hn'],
    ]);
    // The earlier of Al's two rows wins.
    expect(p.entries[0]!.created_at.slice(0, 10)).toBe('2026-02-28');
  });

  it('finds an unnamed email column by its contents, and keeps file order without dates', () => {
    const p = tool.prepare(tool.parseCsv('Ada,zed@example.com\nBo,amy@example.com\n'), { now: 1_000_000 });
    expect(p.columns.email).toBe('column 2');
    expect(p.entries.map((e) => e.email)).toEqual(['zed@example.com', 'amy@example.com']);
    expect(() => tool.prepare(tool.parseCsv('name\nAda\n'))).toThrow(/column of email addresses/);
    expect(() => tool.prepare(tool.parseCsv('email,x\na@b.co,1\n'), { column: 'Mail' })).toThrow(/No column called "Mail"/);
  });

  it('uploads in chunks with the service role, counts only new rows, and retries a 503', async () => {
    const entries = Array.from({ length: 1200 }, (_, i) => ({ email: `p${i}@example.com`, source: 'import', created_at: new Date(i).toISOString() }));
    const seen: { headers: Headers; n: number }[] = [];
    let failed = false;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      if (!failed) {
        failed = true;
        return new Response('{}', { status: 503 });
      }
      const rows = JSON.parse(String(init.body)) as { email: string }[];
      seen.push({ headers: new Headers(init.headers), n: rows.length });
      // Pretend the first 100 were already on the list.
      return Response.json(rows.filter((r) => Number(r.email.slice(1).split('@')[0]) >= 100).map((r) => ({ email: r.email })));
    }) as unknown as typeof fetch;
    const inserted = await tool.upload(entries, { url: 'https://db.test', key: 'service', fetchImpl, sleep: async () => undefined });
    expect(inserted).toBe(1100);
    expect(seen.map((s) => s.n)).toEqual([500, 500, 200]);
    expect(seen[0]!.headers.get('apikey')).toBe('service');
    expect(seen[0]!.headers.get('Prefer')).toMatch(/ignore-duplicates/);
  });
});
