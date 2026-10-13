/**
 * The scheduled jobs (server/cron.ts, server/pipelines/): auth, leases,
 * time-boxing and resuming, the hourly refresh, broken connections, the
 * metric history, our own daily numbers, tidying, and the weekly digest.
 * Runs against an in-memory PostgREST that understands the filters, ordering,
 * counts and bulk writes the jobs use.
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAY, startOfDay, type Snapshot, type Timeline } from '../src/data/types.ts';
import { resetCaches } from '../server/app.ts';
import { hosted, type Hosted } from '../server/context.ts';
import { encrypt } from '../server/crypto.ts';
import { settings } from '../server/env.ts';
import { notify } from '../server/notify.ts';
import { setStripeRetryScale } from '../server/stripe-api.ts';
import { Budget, pool, type Clock } from '../server/pipelines/budget.ts';
import { recordProductDays } from '../server/pipelines/product.ts';
import { Rest } from '../server/pipelines/rest.ts';
import { loadDigest, runDaily, runHourly, runWeekly, weekOf } from '../server/pipelines/run.ts';
import { recordSnapshots, storedHistory, withStoredHistory, type SnapshotRow } from '../server/pipelines/snapshots.ts';
import { ENCRYPTION_KEY, ENV, FakeSupabase, call, form, stubFetch, type Route } from './server-helpers.ts';

vi.mock('../server/notify.ts', () => ({ notify: vi.fn(async () => {}) }));

type Row = Record<string, unknown>;
const EPOCH = new Date(0).toISOString();
const SECRET = 'cron-secret-0123456789abcdef';
const CRON_ENV = { ...ENV, CRON_SECRET: SECRET };
/** 03:17 UTC on 13 October 2026, when the daily job runs. */
const NOW = Date.UTC(2026, 9, 13, 3, 17);
const TODAY = startOfDay(NOW);
const YESTERDAY = TODAY - DAY;
const iso = (t: number) => new Date(t).toISOString();
const day = (t: number) => iso(t).slice(0, 10);
const json = (body: unknown, status = 200) => Response.json(body, { status });
const PAID = ['active', 'trialing', 'past_due'];

// ─── An in-memory PostgREST ───────────────────────────────────────────────

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\d/.test(v);

function compare(a: unknown, b: string): number {
  if (typeof a === 'number') return a - Number(b);
  if (isDate(a) && isDate(b)) return Date.parse(a) - Date.parse(b);
  return String(a) < b ? -1 : String(a) > b ? 1 : 0;
}

function parseList(s: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|([^,]+)/g;
  for (let m; (m = re.exec(s)); ) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]!);
  return out;
}

function test(row: Row, column: string, expr: string): boolean {
  const dot = expr.indexOf('.');
  const op = expr.slice(0, dot);
  const arg = expr.slice(dot + 1);
  const v = row[column];
  switch (op) {
    case 'is':
      return arg === 'null' ? v == null : v === (arg === 'true');
    case 'in':
      return v != null && parseList(arg.slice(1, -1)).includes(String(v));
    case 'eq':
      return v != null && (typeof v === 'boolean' ? String(v) === arg : compare(v, arg) === 0);
    case 'gt':
      return v != null && compare(v, arg) > 0;
    case 'gte':
      return v != null && compare(v, arg) >= 0;
    case 'lt':
      return v != null && compare(v, arg) < 0;
    case 'lte':
      return v != null && compare(v, arg) <= 0;
    default:
      throw new Error(`fake PostgREST: no operator ${op}`);
  }
}

const RESERVED = new Set(['select', 'order', 'limit', 'on_conflict']);

class Pg extends FakeSupabase {
  views: Record<string, () => Row[]> = {};
  /** Tables to answer 404 for, as PostgREST does when a migration hasn't been run. */
  missing = new Set<string>();
  /** Every REST request, for asserting what was (or wasn't) asked. */
  log: { method: string; table: string; query: URLSearchParams }[] = [];

  constructor() {
    super(ENV.SUPABASE_URL);
    for (const t of ['metric_snapshots', 'product_daily', 'cron_jobs', 'timeline_refresh', 'connection_breaks', 'plan_changes', 'email_log', 'rate_limits']) this.tables[t] = [];
    for (const job of ['hourly', 'daily', 'weekly']) this.tables.cron_jobs!.push({ job, lease_until: EPOCH, cursor: null, last_started_at: null, last_finished_at: null, last_ok_at: null, last_result: {} });
    this.views.pipeline_refresh_queue = () => this.queue();
  }

  /** The view in 0003, in JavaScript. */
  queue(): Row[] {
    const by = (table: string, userId: unknown) => this.tables[table]!.filter((r) => r.user_id === userId);
    return this.tables.subscriptions!.filter((s) => PAID.includes(String(s.status))).flatMap((s) => {
      const p = by('profiles', s.user_id)[0];
      const connected = by('connections', s.user_id).some((c) => c.provider === 'stripe' || (c.provider === 'github' && (c.metadata as Row).repo != null));
      if (!p || !connected) return [];
      const fetched = (by('timelines', s.user_id)[0]?.fetched_at as string | undefined) ?? EPOCH;
      const r = by('timeline_refresh', s.user_id)[0];
      const attempted = (r?.attempted_at as string | undefined) ?? EPOCH;
      const failing = !!r && Date.parse(attempted) > Date.parse(fetched);
      return [
        {
          user_id: s.user_id,
          last_seen: p.last_seen,
          touched_at: iso(Math.max(Date.parse(fetched), Date.parse(attempted))),
          retry_at: failing ? r.retry_at : EPOCH,
          failures: failing ? r.failures : 0,
        },
      ];
    });
  }

  override async handle(url: URL, init: RequestInit): Promise<Response | undefined> {
    const m = /^\/rest\/v1\/(\w+)$/.exec(url.pathname);
    if (url.origin !== this.url || !m) return super.handle(url, init);
    const name = m[1]!;
    const method = init.method ?? 'GET';
    this.log.push({ method, table: name, query: url.searchParams });
    const headers = new Headers(init.headers);
    if (headers.get('apikey') !== 'service') return json({ message: 'no' }, 401);
    if (this.missing.has(name) || (!this.tables[name] && !this.views[name])) return json({ code: 'PGRST205', message: 'not found' }, 404);
    const source = this.views[name]?.() ?? this.tables[name]!;
    const filters = [...url.searchParams].filter(([k]) => !RESERVED.has(k));
    const matches = (r: Row) => filters.every(([k, v]) => test(r, k, v));
    const prefer = headers.get('Prefer') ?? '';
    const body = init.body ? (JSON.parse(String(init.body)) as Row | Row[]) : null;

    if (method === 'GET' || method === 'HEAD') {
      let rows = source.filter(matches);
      const order = url.searchParams.get('order');
      if (order) {
        const keys = order.split(',').map((o) => o.split('.') as [string, string]);
        rows = [...rows].sort((a, b) => {
          for (const [k, dir] of keys) {
            const x = a[k];
            const y = b[k];
            const c = x == null ? (y == null ? 0 : -1) : y == null ? 1 : compare(x, String(y));
            if (c) return dir === 'desc' ? -c : c;
          }
          return 0;
        });
      }
      if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'Content-Range': `*/${rows.length}` } });
      const limit = url.searchParams.get('limit');
      if (limit) rows = rows.slice(0, Number(limit));
      const select = url.searchParams.get('select') ?? '*';
      if (select !== '*') rows = rows.map((r) => Object.fromEntries(select.split(',').map((c) => [c, r[c]])));
      return json(rows.map((r) => structuredClone(r)));
    }
    const table = this.tables[name]!;
    if (method === 'POST') {
      const keys = url.searchParams.get('on_conflict')!.split(',');
      const out: Row[] = [];
      for (const row of Array.isArray(body) ? body : [body!]) {
        const existing = table.find((r) => keys.every((k) => String(r[k]) === String(row[k])));
        if (existing) {
          if (prefer.includes('ignore-duplicates')) continue;
          Object.assign(existing, row);
          out.push(existing);
        } else {
          const fresh = { ...(name === 'timelines' ? { fetched_at: iso(Date.now()) } : {}), ...row };
          table.push(fresh);
          out.push(fresh);
        }
      }
      return prefer.includes('return=minimal') ? new Response(null, { status: 201 }) : json(out);
    }
    if (method === 'PATCH') {
      this.beforePatch?.(name);
      const rows = table.filter(matches);
      for (const r of rows) Object.assign(r, body);
      return json(rows);
    }
    if (method === 'DELETE') {
      const gone = table.filter(matches);
      this.tables[name] = table.filter((r) => !matches(r));
      return new Response(null, { status: 204, headers: { 'Content-Range': `*/${gone.length}` } });
    }
    return json({}, 405);
  }
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

let db: Pg;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  resetCaches();
  vi.mocked(notify).mockClear();
  // Stripe's own quick retries (0.3 s, 0.9 s) without the real wait.
  setStripeRetryScale(0);
  db = new Pg();
});
afterEach(() => {
  setStripeRetryScale(1);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ctxAt = (now = NOW, env: Record<string, string> = CRON_ENV): Hosted => {
  const url = new URL('https://tinytown.test/api/cron/hourly');
  return hosted({ req: new Request(url), url, env, s: settings(env), now });
};

/** A clock the test moves: the budget runs out when the test says so, not when real time passes. */
function virtualClock(start = NOW): Clock & { advance(ms: number): void } {
  let t = start;
  return { now: () => t, sleep: async (ms) => void (t += ms), advance: (ms) => void (t += ms) };
}

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A paying founder with a working Stripe connection, last seen today, whose cache is `age` old. */
function founder(n: number, opts: { age?: number; lastSeen?: number | null; stripe?: 'ok' | 'dead' | null; github?: 'ok' | 'gone' | null; status?: string } = {}) {
  const id = uid(n);
  db.tables.profiles!.push({ user_id: id, seed: n, name: `Startup ${n}`, joined_at: null, last_seen: opts.lastSeen === undefined ? TODAY : opts.lastSeen, users_source: 'customers', users_manual: [], created_at: iso(NOW - 60 * DAY) });
  db.tables.subscriptions!.push({ user_id: id, stripe_customer_id: `cus_${n}`, stripe_subscription_id: `sub_${n}`, status: opts.status ?? 'active', price_id: 'price_month', plan_interval: 'month', current_period_end: null, cancel_at_period_end: false, livemode: false, updated_at: iso(NOW - 60 * DAY) });
  const stripe = opts.stripe === undefined ? 'ok' : opts.stripe;
  if (stripe) {
    db.tables.connections!.push({
      user_id: id,
      provider: 'stripe',
      account_id: `acct_${n}`,
      display_name: null,
      livemode: true,
      secret: encrypt(stripe === 'ok' ? 'rt_ok' : 'rt_dead', ENCRYPTION_KEY, `${id}:stripe`),
      access_token: encrypt('at_ok', ENCRYPTION_KEY, `${id}:stripe`),
      // A dead connection's access token has expired, so the build has to refresh (and Stripe says no).
      access_expires_at: iso(stripe === 'ok' ? NOW + 30 * DAY : NOW - 60_000),
      token_version: 1,
      metadata: {},
      connected_at: iso(NOW - 30 * DAY),
    });
  }
  if (opts.github) {
    db.tables.connections!.push({ user_id: id, provider: 'github', account_id: opts.github === 'ok' ? '77' : '99', display_name: 'acme', livemode: null, secret: null, access_token: null, access_expires_at: null, token_version: 0, metadata: { repo: 'acme/app' }, connected_at: iso(NOW - 20 * DAY) });
  }
  if (opts.age !== undefined) db.tables.timelines!.push({ user_id: id, timeline: { name: 'x', currency: 'usd', source: 'live', integrations: { stripe: true, github: false }, snapshots: [] }, fetched_at: iso(NOW - opts.age) });
  return id;
}

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

/** The founders' Stripe (subscriptions with an access token; refresh tokens that are dead) and GitHub (installation 77 works, 99 was uninstalled). */
function providers(opts: { onList?: () => Response | Promise<Response> | undefined } = {}) {
  const lists: string[] = [];
  const refreshes: string[] = [];
  const route: Route = async (url, init) => {
    if (url.href === 'https://api.stripe.com/v1/oauth/token') {
      refreshes.push(form(String(init.body)).refresh_token!);
      return json({ error: 'invalid_grant' }, 400);
    }
    if (url.host === 'api.stripe.com' && url.pathname === '/v1/subscriptions') {
      lists.push(new Headers(init.headers).get('Authorization')!);
      return (await opts.onList?.()) ?? json({ data: [founderSub], has_more: false });
    }
    if (url.pathname === '/app/installations/99/access_tokens') return json({ message: 'Not Found' }, 404);
    if (url.pathname === '/app/installations/77/access_tokens') return json({ token: 'ghs_ok', expires_at: iso(NOW + 3_600_000) });
    if (url.host === 'api.github.com' && url.pathname.startsWith('/repos/acme/app/')) return json([]);
    return undefined;
  };
  return { route, lists, refreshes };
}

// ─── Auth ─────────────────────────────────────────────────────────────────

describe('cron auth', () => {
  it('503 when CRON_SECRET is unset or too short, before looking at anything else', async () => {
    stubFetch(db);
    for (const env of [ENV, { ...ENV, CRON_SECRET: 'short' }, { ...ENV, CRON_SECRET: '   ' }]) {
      const res = await call('GET', '/api/cron/hourly', { token: SECRET, env });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: 'not_configured' });
    }
    expect(db.log).toHaveLength(0);
  });

  it('401 without the secret, with a wrong one, or with a user token; nothing is touched', async () => {
    stubFetch(db);
    for (const token of [null, 'wrong', SECRET.slice(0, -1), `${SECRET}x`, SECRET.toUpperCase(), 'user-access-token']) {
      for (const path of ['/api/cron/hourly', '/api/cron/daily', '/api/cron/weekly', '/api/cron/nope']) {
        const res = await call('GET', path, { token, env: CRON_ENV });
        expect(res.status, `${path} ${token}`).toBe(401);
        expect(await res.json()).toEqual({ error: 'Not authorised.', code: 'unauthenticated' });
      }
    }
    expect(db.log).toHaveLength(0);
    expect(db.authCalls).toBe(0);
  });

  it('runs with the right secret; 404 for an unknown job and 405 for anything but GET', async () => {
    stubFetch(db);
    const res = await call('GET', '/api/cron/hourly', { token: SECRET, env: CRON_ENV });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ job: 'hourly', ok: true, refresh: { candidates: 0, refreshed: 0 } });
    expect((await call('GET', '/api/cron/monthly', { token: SECRET, env: CRON_ENV })).status).toBe(404);
    expect((await call('POST', '/api/cron/daily', { token: SECRET, env: CRON_ENV })).status).toBe(405);
  });

  it('503 with the right secret when accounts aren’t configured', async () => {
    stubFetch(db);
    const res = await call('GET', '/api/cron/daily', { token: SECRET, env: { CRON_SECRET: SECRET } });
    expect(res.status).toBe(503);
  });
});

// ─── Leases and time ──────────────────────────────────────────────────────

describe('leases and time-boxing', () => {
  it('a duplicate delivery steps aside while the first run holds the lease', async () => {
    stubFetch(db);
    const [a, b] = await Promise.all([runHourly(ctxAt()), runHourly(ctxAt())]);
    expect([a.skipped, b.skipped].filter(Boolean)).toEqual(['already running']);
    // Released afterwards: the next run goes ahead.
    expect((await runHourly(ctxAt())).skipped).toBeUndefined();
    const row = db.row('cron_jobs', { job: 'hourly' })!;
    expect(row.last_ok_at).toBeTruthy();
    expect(row.last_result).toMatchObject({ job: 'hourly', ok: true });
  });

  it('a lease left by a run that was killed expires', async () => {
    stubFetch(db);
    Object.assign(db.row('cron_jobs', { job: 'hourly' })!, { lease_until: iso(NOW + 60_000) });
    expect((await runHourly(ctxAt())).skipped).toBe('already running');
    vi.setSystemTime(NOW + 2 * 60_000);
    const clock = { now: () => NOW + 2 * 60_000, sleep: async () => {} };
    expect((await runHourly(ctxAt(NOW + 2 * 60_000), { clock })).skipped).toBeUndefined();
  });

  it('pool keeps to its concurrency and stops starting work when the budget runs low', async () => {
    const clock = virtualClock();
    let running = 0;
    let most = 0;
    const done: number[] = [];
    const items = Array.from({ length: 20 }, (_, i) => i + 1);
    const result = await pool(items, { limit: 3, budget: new Budget(clock, 50_000), reserveMs: 8_000 }, async (n) => {
      most = Math.max(most, ++running);
      await new Promise((r) => setTimeout(r, 1));
      clock.advance(5_000);
      running--;
      done.push(n);
    });
    expect(most).toBe(3);
    // 5 s each, three at a time: new work starts until under 8 s of the 50 are left
    // (the 8th finish, at 40 s), so 3 + 8 items start and all of them finish.
    expect(result).toEqual({ started: 11, left: 9 });
    expect([...done].sort((a, b) => a - b)).toEqual(items.slice(0, 11));
  });
});

// ─── Hourly refresh ───────────────────────────────────────────────────────

describe('hourly: refreshing timelines', () => {
  it('rebuilds stale timelines of paying founders seen in the last 14 days, oldest first, a few at a time', async () => {
    const order: string[] = [];
    let running = 0;
    let most = 0;
    const p = providers({
      onList: async () => {
        most = Math.max(most, ++running);
        await new Promise((r) => setTimeout(r, 2));
        running--;
        return undefined as unknown as Response;
      },
    });
    stubFetch(db, p.route);
    for (let n = 1; n <= 6; n++) founder(n, { age: (10 - n) * 3_600_000 });
    founder(7, { age: 10 * 60_000 }); // fresh: left alone
    founder(8, { age: 5 * 3_600_000, status: 'canceled' }); // not paying
    founder(9, { age: 5 * 3_600_000, stripe: null }); // nothing to build from
    db.tables.timelines!.forEach((t) => order.push(t.user_id as string));

    const result = await runHourly(ctxAt());
    expect(result.refresh).toMatchObject({ candidates: 6, refreshed: 6, failed: 0, broken: 0, left: 0, tripped: false });
    expect(most).toBeLessThanOrEqual(4);
    expect(most).toBeGreaterThan(1);
    for (let n = 1; n <= 6; n++) expect(db.row('timelines', { user_id: uid(n) })!.fetched_at).toBe(iso(NOW));
    expect(db.row('timelines', { user_id: uid(7) })!.fetched_at).toBe(iso(NOW - 10 * 60_000));
    // Each refresh writes the founder's complete days (three days of subscription history).
    expect(db.tables.metric_snapshots!.filter((r) => r.user_id === uid(1)).map((r) => r.day)).toEqual([day(NOW - 3 * DAY), day(NOW - 2 * DAY), day(YESTERDAY)]);
    expect(db.row('metric_snapshots', { user_id: uid(1), day: day(YESTERDAY) })).toMatchObject({ mrr: 49, customers: 1, currency: 'usd', stripe: true, github: false });
  });

  it('stops near the end of its budget and the next run picks up the founders left over, oldest first', async () => {
    const clock = virtualClock();
    const p = providers({ onList: () => (clock.advance(10_000), undefined as unknown as Response) });
    stubFetch(db, p.route);
    for (let n = 1; n <= 8; n++) founder(n, { age: (20 - n) * 3_600_000 });

    const first = await runHourly(ctxAt(), { clock, concurrency: 1 });
    const firstDone = db.tables.timelines!.filter((t) => t.fetched_at === iso(NOW)).map((t) => t.user_id);
    expect(first.refresh).toMatchObject({ candidates: 8, left: 8 - firstDone.length });
    expect(firstDone.length).toBeGreaterThan(0);
    expect(firstDone.length).toBeLessThan(8);
    // Oldest caches went first.
    expect(firstDone).toEqual([1, 2, 3, 4, 5, 6, 7, 8].slice(0, firstDone.length).map(uid));

    const second = await runHourly(ctxAt(), { clock: virtualClock(clock.now()), concurrency: 1 });
    expect(second.refresh).toMatchObject({ candidates: 8 - firstDone.length, left: 0 });
    expect(db.tables.timelines!.every((t) => t.fetched_at === iso(NOW))).toBe(true);
  });

  it('after the active founders, refreshes paying founders who haven’t visited, once a day', async () => {
    stubFetch(db, providers().route);
    founder(1, { age: 2 * 3_600_000, lastSeen: TODAY - 40 * DAY }); // refreshed today already
    founder(2, { age: 5 * 3_600_000, lastSeen: TODAY - 40 * DAY }); // last refreshed yesterday
    founder(3, { age: 2 * 3_600_000, lastSeen: null });
    vi.setSystemTime(NOW);
    const result = await runHourly(ctxAt(NOW));
    // 03:17: a 5-hour-old cache is from yesterday; a 2-hour-old one is from today.
    expect(result.refresh).toMatchObject({ candidates: 1, refreshed: 1 });
    expect(db.row('timelines', { user_id: uid(2) })!.fetched_at).toBe(iso(NOW));
  });

  it('backs off a founder whose rebuild fails, and trips after a run of provider failures', async () => {
    // Retry-After: 0 so the client's own quick retries don't wait in real time.
    stubFetch(db, providers({ onList: () => Response.json({ error: { message: 'down' } }, { status: 500, headers: { 'Retry-After': '0' } }) }).route);
    for (let n = 1; n <= 12; n++) founder(n, { age: (20 - n) * 3_600_000 });
    const result = await runHourly(ctxAt(), { concurrency: 1 });
    expect(result.refresh).toMatchObject({ refreshed: 0, failed: 8, tripped: true, left: 4 });
    expect(notify).not.toHaveBeenCalled();
    const note = db.row('timeline_refresh', { user_id: uid(1) })!;
    expect(note).toMatchObject({ failures: 1, error_code: 'upstream', retry_at: iso(NOW + 3_600_000) });
    // The cached copies were served (and kept), not replaced.
    expect(db.row('timelines', { user_id: uid(1) })!.fetched_at).toBe(iso(NOW - 19 * 3_600_000));

    // Within the backoff: not tried again. After it: tried, and the wait doubles.
    resetCaches();
    const later = NOW + 30 * 60_000;
    vi.setSystemTime(later);
    expect((await runHourly(ctxAt(later), { concurrency: 1 })).refresh).toMatchObject({ candidates: 4 });
    resetCaches();
    const after = NOW + 61 * 60_000;
    vi.setSystemTime(after);
    await runHourly(ctxAt(after), { concurrency: 1 });
    expect(db.row('timeline_refresh', { user_id: uid(1) })).toMatchObject({ failures: 2, retry_at: iso(after + 2 * 3_600_000) });
  });
});

// ─── Broken connections ───────────────────────────────────────────────────

describe('hourly: broken connections', () => {
  it('tells the founder once when Stripe stops accepting the refresh token', async () => {
    const p = providers();
    stubFetch(db, p.route);
    const id = founder(1, { stripe: 'dead' });

    const result = await runHourly(ctxAt());
    expect(result.refresh).toMatchObject({ broken: 1, failed: 0 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notify).mock.calls[0]![1]).toEqual({ kind: 'connection.broken', userId: id, provider: 'stripe', ref: `c${NOW - 30 * DAY}` });
    expect(db.row('connection_breaks', { user_id: id })).toMatchObject({ provider: 'stripe', notified_at: iso(NOW) });
    expect(db.row('timeline_refresh', { user_id: id })).toMatchObject({ error_code: 'not_connected', retry_at: iso(NOW + DAY) });

    // The next day it's still broken: tried again, but no second email.
    resetCaches();
    const later = NOW + DAY + 3_600_000;
    vi.setSystemTime(later);
    expect((await runHourly(ctxAt(later))).refresh).toMatchObject({ broken: 1 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(db.tables.connection_breaks).toHaveLength(1);

    // Reconnected (a new connection), and broken again later: that's a new break.
    resetCaches();
    Object.assign(db.row('connections', { user_id: id, provider: 'stripe' })!, { connected_at: iso(later) });
    db.tables.timeline_refresh = [];
    const muchLater = later + 3 * DAY;
    vi.setSystemTime(muchLater);
    await runHourly(ctxAt(muchLater));
    expect(notify).toHaveBeenCalledTimes(2);
    expect(db.tables.connection_breaks).toHaveLength(2);
  });

  it('names GitHub when the app was uninstalled, and leaves a working Stripe alone', async () => {
    stubFetch(db, providers().route);
    const id = founder(1, { stripe: 'ok', github: 'gone' });
    await runHourly(ctxAt());
    expect(vi.mocked(notify).mock.calls.map((c) => c[1])).toEqual([{ kind: 'connection.broken', userId: id, provider: 'github', ref: `c${NOW - 20 * DAY}` }]);
  });

  it('two overlapping runs still send one notice', async () => {
    stubFetch(db, providers().route);
    founder(1, { stripe: 'dead' });
    // Two different job instances (different leases can't overlap, so call the
    // break check from two refreshes of the same founder directly).
    const { noticeBreaks } = await import('../server/pipelines/refresh.ts');
    const profile = db.row('profiles', { user_id: uid(1) }) as never;
    await Promise.all([noticeBreaks(ctxAt(), profile), noticeBreaks(ctxAt(), profile)]);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

// ─── Metric history ───────────────────────────────────────────────────────

const timeline = (snapshots: Snapshot[], integrations = { stripe: true, github: true }): Timeline => ({ name: 'x', currency: 'usd', source: 'live', integrations, snapshots });
const snap = (t: number, mrr: number, extra: Partial<Snapshot> = {}): Snapshot => ({ t, mrr, customers: Math.round(mrr / 10), releases: 1, commits: 10, ...extra });

describe('metric snapshots', () => {
  const rest = () => new Rest(settings(ENV).supabase!);
  const id = uid(1);
  const days = (n: number) => Array.from({ length: n }, (_, i) => TODAY - (n - 1 - i) * DAY);

  it('writes complete days only, and writing the same timeline twice changes nothing', async () => {
    stubFetch(db);
    const t = timeline(days(5).map((d, i) => snap(d, 100 + i, i === 2 ? { release: 'v1.0', users: 40 } : {})));
    expect(await recordSnapshots(rest(), id, t, NOW)).toBe(4);
    const first = structuredClone(db.tables.metric_snapshots);
    expect(first.map((r) => r.day)).toEqual(days(5).slice(0, 4).map(day));
    expect(first[2]).toMatchObject({ mrr: 102, users: 40, release: 'v1.0', stripe: true, github: true });
    expect(first[0]).toMatchObject({ users: null, release: null });

    // Again: only the settling days are rewritten, with the same values.
    expect(await recordSnapshots(rest(), id, t, NOW)).toBe(2);
    expect(db.tables.metric_snapshots).toEqual(first);
  });

  it('never rewrites a settled day, rewrites the settling ones, and fills new days', async () => {
    stubFetch(db);
    await recordSnapshots(rest(), id, timeline(days(5).map((d) => snap(d, 100))), NOW);
    // A refund later rewrites history at the provider: every day now reads 50.
    const tomorrow = NOW + DAY;
    await recordSnapshots(rest(), id, timeline([...days(5), TODAY + DAY].map((d) => snap(d, 50))), tomorrow);
    const mrr = Object.fromEntries(db.tables.metric_snapshots!.map((r) => [r.day, r.mrr]));
    expect(mrr).toEqual({
      [day(TODAY - 4 * DAY)]: 100,
      [day(TODAY - 3 * DAY)]: 100,
      [day(TODAY - 2 * DAY)]: 100, // settled by now
      [day(TODAY - DAY)]: 50, // still settling
      [day(TODAY)]: 50, // new
    });
  });

  it('a build that knows less (Stripe disconnected) doesn’t overwrite settling days that had Stripe', async () => {
    stubFetch(db);
    await recordSnapshots(rest(), id, timeline(days(3).map((d) => snap(d, 100))), NOW);
    await recordSnapshots(rest(), id, timeline(days(3).map((d) => snap(d, 0)), { stripe: false, github: true }), NOW);
    expect(db.tables.metric_snapshots!.map((r) => r.mrr)).toEqual([100, 100]);
  });

  it('the daily pass records every paying founder from their cached timeline, and resumes from its cursor', async () => {
    stubFetch(db);
    for (let n = 1; n <= 5; n++) {
      founder(n);
      db.tables.timelines!.push({ user_id: uid(n), timeline: timeline(days(3).map((d) => snap(d, n * 10))), fetched_at: iso(NOW - 3_600_000) });
    }
    founder(6, { status: 'canceled' });
    db.tables.timelines!.push({ user_id: uid(6), timeline: timeline(days(3).map((d) => snap(d, 60))), fetched_at: iso(NOW) });

    // A budget that runs out after a few timeline reads.
    const clock = virtualClock();
    const reads: string[] = [];
    const original = db.handle.bind(db);
    db.handle = async (url, init) => {
      if (url.pathname === '/rest/v1/timelines' && (init.method ?? 'GET') === 'GET' && url.searchParams.has('user_id')) {
        reads.push(url.searchParams.get('user_id')!.slice(3));
        clock.advance(12_000);
      }
      return original(url, init);
    };
    db.tables.product_daily!.push({ day: day(YESTERDAY) }); // make the product phase cheap to skip past

    const first = await runDaily(ctxAt(), { clock, budgetMs: 40_000, concurrency: 1 });
    expect(first).toMatchObject({ partial: true });
    const cursor = db.row('cron_jobs', { job: 'daily' })!.cursor as { phase: string; after: string };
    expect(cursor.phase).toBe('snapshots');
    const doneFirst = reads.length;
    expect(cursor.after).toBe(uid(doneFirst));

    const second = await runDaily(ctxAt(), { clock: virtualClock(clock.now()), concurrency: 1 });
    // Picked up after the cursor: nobody read twice, nobody skipped, the canceled founder never.
    expect(reads).toEqual([1, 2, 3, 4, 5].map(uid));
    expect(second).toMatchObject({ snapshots: { after: null } });
    expect(db.row('cron_jobs', { job: 'daily' })!.cursor).toEqual({ day: day(YESTERDAY), phase: 'done' });
    expect(new Set(db.tables.metric_snapshots!.map((r) => r.user_id))).toEqual(new Set([1, 2, 3, 4, 5].map(uid)));

    // A third delivery the same day does nothing.
    expect(await runDaily(ctxAt(), { clock: virtualClock(clock.now() + 60_000) })).toMatchObject({ skipped: 'already done' });
  });

  it('an unfinished daily run is carried on by the next hourly run', async () => {
    stubFetch(db);
    founder(1, { stripe: null });
    db.tables.timelines!.push({ user_id: uid(1), timeline: timeline(days(3).map((d) => snap(d, 10))), fetched_at: iso(NOW) });
    Object.assign(db.row('cron_jobs', { job: 'daily' })!, { cursor: { day: day(YESTERDAY), phase: 'snapshots', after: null } });
    const result = await runHourly(ctxAt(NOW + 50 * 60_000));
    expect(result.daily).toMatchObject({ job: 'daily', ok: true });
    expect(db.tables.metric_snapshots).toHaveLength(2);
    expect(db.row('cron_jobs', { job: 'daily' })!.cursor).toMatchObject({ phase: 'done' });
  });

  it('storedHistory reads every day, oldest first, past the per-request row cap', async () => {
    stubFetch(db);
    const all = Array.from({ length: 1_203 }, (_, i) => TODAY - (1_203 - i) * DAY);
    await recordSnapshots(rest(), id, timeline(all.map((d) => snap(d, 10))), NOW);
    db.tables.metric_snapshots!.reverse();
    const got = await storedHistory(rest(), id);
    expect(got.map((r) => r.day)).toEqual(all.map(day));
  });

  it('withStoredHistory: settled days come from the store, live totals carry on from the stored ones', () => {
    const t0 = TODAY - 6 * DAY;
    const row = (t: number, mrr: number, commits: number): SnapshotRow => ({ user_id: id, day: day(t), mrr, currency: 'usd', customers: 1, users: null, releases: 2, commits, release: null, stripe: true, github: true });
    // Stored: days 0, 1, 3 (a hole on day 2), and day 5 (still settling, so ignored).
    const stored = [row(t0, 100, 500), row(t0 + DAY, 110, 510), row(t0 + 3 * DAY, 130, 530), row(t0 + 5 * DAY, 999, 999)];
    // Live: GitHub's window has slid, so its commit totals start lower; days 2..6.
    const live = [2, 3, 4, 5, 6].map((i) => snap(t0 + i * DAY, 50 + i, { commits: 20 + i * 10, releases: 1 }));
    const merged = withStoredHistory(live, stored, NOW);
    expect(merged.map((s) => s.t)).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => t0 + i * DAY));
    expect(merged.map((s) => s.mrr)).toEqual([100, 110, 52, 130, 54, 55, 56]);
    // Junction on day 3: stored 530 vs live 50, so live days shift by +480 and keep their +10 a day.
    expect(merged.map((s) => s.commits)).toEqual([500, 510, 520, 530, 540, 550, 560]);
    expect(withStoredHistory(live, [], NOW)).toBe(live);
  });
});

// ─── Product metrics ──────────────────────────────────────────────────────

describe('product_daily', () => {
  function fixture() {
    const sub = (n: number, over: Row) => db.tables.subscriptions!.push({ user_id: uid(n), stripe_customer_id: `cus_${n}`, status: 'active', price_id: 'price_month', plan_interval: 'month', livemode: false, comp: false, updated_at: iso(NOW - 5 * DAY), ...over });
    sub(1, {});
    sub(2, {});
    sub(3, { status: 'trialing' });
    sub(4, { status: 'past_due', price_id: 'price_year', plan_interval: 'year' });
    sub(5, { status: 'canceled' });
    sub(6, { price_id: null, plan_interval: null, comp: true, livemode: null }); // comped
    sub(7, { livemode: true }); // live-mode row while billing runs on a test key: not counted
    const profile = (n: number, created: number, lastSeen: number | null) =>
      db.tables.profiles!.push({ user_id: uid(n), seed: n, name: 'x', last_seen: lastSeen, users_source: 'customers', users_manual: [], created_at: iso(created) });
    profile(1, YESTERDAY + 3_600_000, YESTERDAY);
    profile(2, YESTERDAY + 20 * 3_600_000, TODAY);
    profile(3, YESTERDAY + 23.9 * 3_600_000, YESTERDAY - 3 * DAY);
    profile(4, YESTERDAY - 1, YESTERDAY - 20 * DAY); // the day before
    profile(5, TODAY, null); // today: tomorrow's row
    db.tables.connections!.push({ user_id: uid(1), provider: 'stripe' }, { user_id: uid(2), provider: 'stripe' }, { user_id: uid(1), provider: 'github' });
    const change = (n: number, change: string, at: number) => db.tables.plan_changes!.push({ user_id: uid(n), change, at: iso(at) });
    change(1, 'started', YESTERDAY + 1_000);
    change(2, 'started', YESTERDAY + 50_000_000);
    change(5, 'ended', YESTERDAY + 60_000_000);
    change(3, 'started', YESTERDAY - DAY + 1);
    change(4, 'switched', YESTERDAY + 1);
  }

  function prices(opts: { failFirst?: number } = {}) {
    let fails = opts.failFirst ?? 0;
    const calls: string[] = [];
    const route: Route = (url) => {
      if (url.host !== 'api.stripe.com' || !url.pathname.startsWith('/v1/prices/')) return undefined;
      calls.push(url.pathname);
      if (fails > 0) {
        fails--;
        return json({ error: { message: 'Too many requests' } }, 429);
      }
      const year = url.pathname.endsWith('price_year');
      return json({ id: year ? 'price_year' : 'price_month', unit_amount: year ? 9900 : 1200, currency: 'usd', recurring: { interval: year ? 'year' : 'month', interval_count: 1 } });
    };
    return { route, calls };
  }

  it('counts the day just ended from the fixture', async () => {
    fixture();
    stubFetch(db, prices().route);
    await recordProductDays(ctxAt(), new Rest(settings(ENV).supabase!), new Budget(virtualClock(), 50_000), YESTERDAY);
    const row = db.row('product_daily', { day: day(YESTERDAY) });
    expect(row).toMatchObject({
      signups: 3,
      new_paid: 2,
      churned: 1,
      paying_monthly: 3,
      paying_yearly: 1,
      comped: 1,
      // 3 × $12 + $99 / 12 = $44.25
      mrr_cents: 4425,
      currency: 'usd',
      stripe_connected: 2,
      github_connected: 1,
      dau: 2,
      wau: 3,
      mau: 4,
      measured_at: iso(NOW),
    });
    // The week before is filled in with event counts, and no state.
    const before = db.row('product_daily', { day: day(YESTERDAY - DAY) });
    expect(before).toMatchObject({ signups: 1, new_paid: 1, churned: 0, paying_monthly: null, mrr_cents: null, dau: null });
    expect(db.tables.product_daily).toHaveLength(7);
  });

  it('rides out Stripe rate limits on our prices with backoff', async () => {
    fixture();
    // Stripe's client tries three times itself; the fourth 429 makes the job back off and try again.
    const p = prices({ failFirst: 4 });
    stubFetch(db, p.route);
    const clock = virtualClock();
    await recordProductDays(ctxAt(), new Rest(settings(ENV).supabase!), new Budget(clock, 50_000), YESTERDAY);
    expect(db.row('product_daily', { day: day(YESTERDAY) })).toMatchObject({ mrr_cents: 4425 });
    expect(p.calls.length).toBe(6); // four 429s, then month and year
    expect(clock.now()).toBeGreaterThan(NOW); // it backed off
  });

  it('writes null MRR rather than a guess when prices can’t be read, and null plan counts without plan_changes', async () => {
    fixture();
    db.missing.add('plan_changes');
    stubFetch(db, prices({ failFirst: 100 }).route);
    await recordProductDays(ctxAt(), new Rest(settings(ENV).supabase!), new Budget(virtualClock(), 50_000), YESTERDAY);
    expect(db.row('product_daily', { day: day(YESTERDAY) })).toMatchObject({ mrr_cents: null, currency: null, new_paid: null, churned: null, paying_monthly: 3 });
  });

  it('re-running the day gives the same row', async () => {
    fixture();
    stubFetch(db, prices().route);
    const run = () => recordProductDays(ctxAt(), new Rest(settings(ENV).supabase!), new Budget(virtualClock(), 50_000), YESTERDAY);
    await run();
    const once = structuredClone(db.tables.product_daily);
    await run();
    expect(db.tables.product_daily).toEqual(once);
  });
});

// ─── Cleanup ──────────────────────────────────────────────────────────────

describe('daily cleanup', () => {
  it('drops caches of founders without a plan for 30 days, old email and rate-limit rows, and nothing else', async () => {
    stubFetch(db);
    const old = iso(NOW - 40 * DAY);
    const tl = (n: number, fetched: string) => db.tables.timelines!.push({ user_id: uid(n), timeline: {}, fetched_at: fetched });
    const sub = (n: number, status: string, updated: string) => db.tables.subscriptions!.push({ user_id: uid(n), status, updated_at: updated });
    tl(1, old); // canceled 40 days ago → goes
    sub(1, 'canceled', old);
    tl(2, old); // never had a plan → goes
    tl(3, old); // paying (just hasn't been rebuilt) → stays
    sub(3, 'active', old);
    tl(4, old); // canceled 10 days ago → stays for now
    sub(4, 'canceled', iso(NOW - 10 * DAY));
    tl(5, iso(NOW - DAY)); // recent → stays
    db.tables.metric_snapshots!.push({ user_id: uid(1), day: '2026-01-01' });
    db.tables.email_log!.push({ dedupe_key: 'a', created_at: iso(NOW - 200 * DAY) }, { dedupe_key: 'b', created_at: iso(NOW - 10 * DAY) });
    db.tables.rate_limits!.push({ key: 'k1', window_start: iso(NOW - 3 * DAY) }, { key: 'k2', window_start: iso(NOW - 60_000) });
    db.tables.product_daily!.push({ day: day(YESTERDAY) });

    const result = await runDaily(ctxAt());
    expect(result.reconcile).toEqual({ checked: 0, failed: 0 });
    expect(result.cleanup).toMatchObject({ timelines: 2, emailLog: 1, rateLimits: 1, partial: false });
    expect(db.tables.timelines!.map((t) => t.user_id).sort()).toEqual([3, 4, 5].map(uid));
    expect(db.tables.email_log!.map((r) => r.dedupe_key)).toEqual(['b']);
    expect(db.tables.rate_limits!.map((r) => r.key)).toEqual(['k2']);
    expect(db.tables.metric_snapshots).toHaveLength(1);
  });

  it('tolerates the email and rate-limit tables not existing', async () => {
    stubFetch(db);
    db.missing.add('email_log');
    db.missing.add('rate_limits');
    const result = await runDaily(ctxAt());
    expect(result).toMatchObject({ ok: true, cleanup: { emailLog: null, rateLimits: null } });
  });
});

// ─── Weekly ───────────────────────────────────────────────────────────────

describe('weekly digest', () => {
  const MONDAY = Date.UTC(2026, 9, 12, 15, 23);
  beforeEach(() => vi.setSystemTime(MONDAY));

  it('hands the run to the email module’s weeklyDigest, once a week', async () => {
    stubFetch(db);
    const digest = vi.fn(async () => ({ sent: 12 }));
    const ctx = ctxAt(MONDAY);
    const result = await runWeekly(ctx, { digest: async () => digest });
    expect(digest).toHaveBeenCalledTimes(1);
    expect(digest.mock.calls[0]).toEqual([ctx, MONDAY]);
    expect(result).toMatchObject({ job: 'weekly', ok: true, week: '2026-10-12', digest: { sent: 12 } });
    // A duplicate delivery the same week does nothing.
    vi.setSystemTime(MONDAY + 60_000);
    expect(await runWeekly(ctxAt(MONDAY + 60_000), { digest: async () => digest })).toMatchObject({ skipped: 'already sent' });
    expect(digest).toHaveBeenCalledTimes(1);
    expect(weekOf(MONDAY + 6 * DAY)).toBe('2026-10-12');
    expect(weekOf(MONDAY - DAY)).toBe('2026-10-05');
  });

  it('carries on without the digest module, and the hourly job sends it once it exists', async () => {
    stubFetch(db);
    expect(await runWeekly(ctxAt(MONDAY), { digest: async () => null })).toMatchObject({ ok: true, skipped: 'no digest module' });
    const digest = vi.fn(async () => ({ sent: 1 }));
    vi.setSystemTime(MONDAY + 44 * 60_000);
    const hourly = await runHourly(ctxAt(MONDAY + 44 * 60_000), { digest: async () => digest });
    expect(hourly.weekly).toMatchObject({ ok: true, week: '2026-10-12' });
    expect(digest).toHaveBeenCalledTimes(1);
    // A day after the slot, the hourly job leaves it for next week.
    vi.setSystemTime(MONDAY + 7 * DAY + DAY + 3_600_000);
    await runHourly(ctxAt(MONDAY + 7 * DAY + DAY + 3_600_000), { digest: async () => digest });
    expect(digest).toHaveBeenCalledTimes(1);
  });

  it('a failing digest fails the run (500) and is retried by the next hourly run', async () => {
    stubFetch(db);
    let attempt = 0;
    const digest = async () => {
      if (++attempt === 1) throw new Error('provider down');
      return { sent: 3 };
    };
    await expect(runWeekly(ctxAt(MONDAY), { digest: async () => digest })).rejects.toThrow('provider down');
    expect(db.row('cron_jobs', { job: 'weekly' })).toMatchObject({ last_result: { ok: false, error: 'provider down' } });
    vi.setSystemTime(MONDAY + 44 * 60_000);
    const hourly = await runHourly(ctxAt(MONDAY + 44 * 60_000), { digest: async () => digest });
    expect(hourly.weekly).toMatchObject({ ok: true, digest: { sent: 3 } });
  });

  it('a digest that ran out of time leaves the week open for the hourly job to finish', async () => {
    stubFetch(db);
    const results = [{ sent: 100, skipped: 0, left: 40 }, { sent: 40, skipped: 0, left: 0 }];
    const digest = vi.fn(async () => results.shift());
    expect(await runWeekly(ctxAt(MONDAY), { digest: async () => digest })).toMatchObject({ ok: true, partial: true });
    vi.setSystemTime(MONDAY + 44 * 60_000);
    expect((await runHourly(ctxAt(MONDAY + 44 * 60_000), { digest: async () => digest })).weekly).toMatchObject({ digest: { sent: 40 } });
    vi.setSystemTime(MONDAY + 104 * 60_000);
    expect((await runHourly(ctxAt(MONDAY + 104 * 60_000), { digest: async () => digest })).weekly).toBeUndefined();
    expect(digest).toHaveBeenCalledTimes(2);
  });

  it('loadDigest finds server/email/digest.ts when it exists and returns null when it doesn’t', async () => {
    const present = existsSync(new URL('../server/email/digest.ts', import.meta.url));
    const fn = await loadDigest();
    expect(fn === null).toBe(!present);
    if (present) expect(typeof fn).toBe('function');
  });
});
