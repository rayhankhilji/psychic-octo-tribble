import { isPaid, type PlanInterval } from '../src/api/contract.ts';
import type { Action } from '../src/game/economy.ts';
import type { Timeline } from '../src/data/types.ts';
import {
  INVITE_BATCH_MAX,
  INVITE_EMAILS_MAX,
  type AdminMe,
  type AuditEntry,
  type ConnectionInfo,
  type InviteEmailsResult,
  type InviteResult,
  type Movement,
  type Overview,
  type UserDetail,
  type UserHit,
  type UserSearch,
  type WaitlistEntry,
  type WaitlistFunnel,
  type WaitlistPage,
} from '../src/admin/types.ts';
import { accessMode, adminEmails, isAdmin, normalizeEmail, resetAccessCaches, type WaitlistRow } from './access.ts';
import { plans } from './billing.ts';
import { hosted, rateLimit, requireUser, type Ctx, type Hosted } from './context.ts';
import type { Extension } from './extensions.ts';
import { userTimeline } from './hosted-timeline.ts';
import { HttpError, badRequest, bearer, json, readJson } from './http.ts';
import { notify } from './notify.ts';
import { planStatus, type ConnectionRow, type ProfileRow, type SubscriptionRow, type WorldRow } from './store.ts';

/**
 * The internal admin console's API (`/api/admin/*`), for ADMIN_EMAILS only.
 * Shapes are in src/admin/types.ts; the console itself is admin.html.
 *
 * - Anyone who isn't a signed-in admin gets the same 404 as an unknown
 *   route, whatever they send, so the console isn't advertised.
 * - Every call is rate-limited per admin and written to `admin_audit`: who,
 *   what, when and to whom. Changes are written *before* they run (and fail
 *   closed if that write fails), with a browser-made request id that makes a
 *   double click or a retry run once.
 * - Nothing secret leaves: connections are read column by column, never the
 *   encrypted tokens.
 */

const PREFIX = '/api/admin';
const DAY = 86_400_000;
const PAID = ['active', 'trialing', 'past_due'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9:_-]{8,80}$/;
const SOURCE = /^[\w .:@/-]{1,40}$/;

/** Calls per minute per admin: everything, and changes. */
const READS_PER_MINUTE = 120;
const WRITES_PER_MINUTE = 30;

const notFound = () => new HttpError(404, 'Not found.', 'bad_request');

interface Admin {
  id: string;
  email: string;
}

interface CompRow extends SubscriptionRow {
  comp?: boolean;
  comp_reason?: string | null;
  comp_by?: string | null;
  comp_at?: string | null;
}

// ─── PostgREST, with the filters the console needs ────────────────────────

type Params = [string, string][];

/**
 * server/supabase.ts's Db covers the game's equality lookups; the console
 * also needs ranges, lists, ordering, paging and counts, so it speaks
 * PostgREST directly with the same service-role headers.
 */
function serviceHeaders(ctx: Hosted, extra: Record<string, string> = {}): Record<string, string> {
  const key = ctx.supabase.serviceKey;
  const h: Record<string, string> = { apikey: key, 'Content-Type': 'application/json', ...extra };
  if (!key.startsWith('sb_')) h.Authorization = `Bearer ${key}`;
  return h;
}

const enc = (params: Params) => params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

/** `in.("a","b")`. Values are ours or validated (no quotes or backslashes). */
const inList = (values: string[]) => `in.(${values.map((v) => `"${v}"`).join(',')})`;

interface PgOptions {
  body?: unknown;
  prefer?: string[];
  count?: boolean;
  /** Answer null instead of failing when the table doesn't exist (yet): another module's, or a migration not run. */
  missingOk?: boolean;
}

async function pg<T>(ctx: Hosted, method: string, table: string, params: Params, opts: PgOptions = {}): Promise<{ rows: T[]; total: number | null } | null> {
  const prefer = [...(opts.prefer ?? []), ...(opts.count ? ['count=exact'] : [])];
  const res = await fetch(`${ctx.supabase.url}/rest/v1/${table}?${enc(params)}`, {
    method,
    headers: serviceHeaders(ctx, prefer.length ? { Prefer: prefer.join(',') } : {}),
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  if (res.status === 404 && opts.missingOk) return null;
  if (!res.ok) {
    // PostgREST errors can echo values (emails); log the status only.
    console.error(`admin database ${method} ${table} → ${res.status}`);
    throw new HttpError(502, 'The database is unavailable. Try again in a moment.', 'upstream');
  }
  const text = await res.text();
  const rows = (text ? JSON.parse(text) : []) as T[];
  const range = res.headers.get('Content-Range');
  const total = range && /\/(\d+)$/.test(range) ? Number(range.split('/')[1]) : null;
  return { rows: Array.isArray(rows) ? rows : [rows], total };
}

async function select<T>(ctx: Hosted, table: string, params: Params): Promise<T[]> {
  return (await pg<T>(ctx, 'GET', table, params))!.rows;
}

/** How many rows match. `col` is any cheap column, so the count never reads a secret. */
async function count(ctx: Hosted, table: string, col: string, filters: Params, missingOk = false): Promise<number | null> {
  const res = await pg(ctx, 'GET', table, [['select', col], ...filters, ['limit', '1']], { count: true, missingOk });
  return res ? (res.total ?? res.rows.length) : null;
}

const PAGE = 1000;
/** Every matching row, a page at a time (PostgREST serves at most 1,000 per request). */
async function all<T>(ctx: Hosted, table: string, params: Params, missingOk = false): Promise<T[] | null> {
  const first = await pg<T>(ctx, 'GET', table, [...params, ['limit', String(PAGE)], ['offset', '0']], { count: true, missingOk });
  if (!first) return null;
  const total = Math.min(first.total ?? first.rows.length, 200_000);
  const rest: Promise<T[]>[] = [];
  for (let offset = PAGE; offset < total; offset += PAGE) {
    rest.push(select<T>(ctx, table, [...params, ['limit', String(PAGE)], ['offset', String(offset)]]));
  }
  return [first.rows, ...(await Promise.all(rest))].flat();
}

// ─── Supabase Auth's admin API: who people are ────────────────────────────

interface AuthAdminUser {
  id: string;
  email?: string | null;
  created_at?: string | null;
  last_sign_in_at?: string | null;
  email_confirmed_at?: string | null;
  app_metadata?: { provider?: string; providers?: string[] };
}

async function authAdmin<T>(ctx: Hosted, path: string): Promise<T | null> {
  const res = await fetch(`${ctx.supabase.url}/auth/v1/admin/${path}`, { headers: serviceHeaders(ctx) });
  if (res.status === 404) return null;
  if (!res.ok) {
    console.error(`admin auth GET ${path.split('?')[0]} → ${res.status}`);
    throw new HttpError(502, 'The sign-in service is unavailable. Try again in a moment.', 'upstream');
  }
  return (await res.json()) as T;
}

const authUser = (ctx: Hosted, id: string) => (UUID.test(id) ? authAdmin<AuthAdminUser>(ctx, `users/${id}`) : Promise.resolve(null));

/** Newest first; `filter` matches part of an email (Supabase Auth's own search). */
async function authUsers(ctx: Hosted, filter: string): Promise<AuthAdminUser[]> {
  const body = await authAdmin<{ users?: AuthAdminUser[] }>(ctx, `users?page=1&per_page=25${filter ? `&filter=${encodeURIComponent(filter)}` : ''}`);
  return body?.users ?? [];
}

// ─── Small helpers ────────────────────────────────────────────────────────

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : null);
const iso = (t: number) => new Date(t).toISOString();

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function intIn(v: unknown, min: number, max: number, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw badRequest(`${what} should be a whole number from ${min} to ${max}.`);
  return v;
}

function entry(r: WaitlistRow): WaitlistEntry {
  return {
    email: r.email,
    source: r.source,
    createdAt: ms(r.created_at)!,
    invitedAt: ms(r.invited_at),
    wave: r.wave,
    notifiedAt: ms(r.notified_at),
    signedUpAt: ms(r.signed_up_at),
    userId: r.user_id,
  };
}

const WAITLIST_COLS = 'email,source,created_at,invited_at,wave,notified_at,signed_up_at,user_id';
const SUB_COLS = 'user_id,status,plan_interval,comp,cancel_at_period_end';
const CONNECTION_COLS = 'user_id,provider,account_id,display_name,livemode,metadata,connected_at';

/** Paid access right now: the founder ids, and which of them pay real money. */
async function payingRows(ctx: Hosted): Promise<CompRow[]> {
  return (await all<CompRow>(ctx, 'subscriptions', [['select', SUB_COLS], ['status', inList(PAID)], ['order', 'user_id.asc']]))!;
}

// ─── Audit ────────────────────────────────────────────────────────────────

interface AuditRow {
  id: number;
  at: string;
  admin_id: string;
  admin_email: string;
  action: string;
  target: string | null;
  request_id: string | null;
  status: 'started' | 'ok' | 'error';
  detail: Record<string, unknown>;
}

function auditEntry(r: AuditRow): AuditEntry {
  return { id: r.id, at: ms(r.at)!, adminEmail: r.admin_email, action: r.action, target: r.target, status: r.status, detail: r.detail ?? {} };
}

/** A read, logged after it's served. Best effort: a failed log line never hides the data from the admin. */
async function auditRead(ctx: Hosted, admin: Admin, action: string, target: string | null, detail: Record<string, unknown> = {}) {
  try {
    await pg(ctx, 'POST', 'admin_audit', [], {
      body: { admin_id: admin.id, admin_email: admin.email, action, target, status: 'ok', detail, at: iso(ctx.now) },
      prefer: ['return=minimal'],
    });
  } catch {
    console.error(`admin audit write failed for ${action}`);
  }
}

/**
 * A change, logged as `started` before it runs, so nothing changes without
 * a record. The request id is unique in `admin_audit`: a repeat finds the
 * first row and gets its stored result instead of running again.
 */
async function change<T extends object>(
  ctx: Hosted,
  admin: Admin,
  body: Record<string, unknown>,
  action: string,
  target: string | null,
  input: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> {
  const requestId = body.requestId;
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw badRequest('Changes need a requestId (8 to 80 letters, digits, - _ or :).');
  const inserted = await pg<AuditRow>(ctx, 'POST', 'admin_audit', [['on_conflict', 'request_id']], {
    body: { admin_id: admin.id, admin_email: admin.email, action, target, request_id: requestId, status: 'started', detail: { input }, at: iso(ctx.now) },
    prefer: ['resolution=ignore-duplicates', 'return=representation'],
  });
  const row = inserted!.rows[0];
  if (!row) {
    const [prev] = await select<AuditRow>(ctx, 'admin_audit', [['select', '*'], ['request_id', `eq.${requestId}`], ['limit', '1']]);
    if (prev?.status === 'ok' && prev.action === action && prev.detail?.result) return prev.detail.result as T;
    if (prev?.status === 'started') throw new HttpError(409, 'That change is still running. Give it a moment, then refresh.', 'rejected');
    throw new HttpError(409, 'That request was already used. Refresh and try again.', 'rejected');
  }
  const finish = async (status: 'ok' | 'error', detail: Record<string, unknown>) => {
    try {
      await pg(ctx, 'PATCH', 'admin_audit', [['id', `eq.${row.id}`]], { body: { status, detail: { input, ...detail } }, prefer: ['return=minimal'] });
    } catch {
      console.error(`admin audit update failed for ${action}`);
    }
  };
  try {
    const result = await run();
    await finish('ok', { result });
    return result;
  } catch (err) {
    await finish('error', { error: err instanceof Error ? err.message : 'unknown error' });
    throw err;
  }
}

// ─── Who's asking ─────────────────────────────────────────────────────────

/** The signed-in admin, or the same 404 an unknown route gets. */
async function authorize(ctx: Ctx): Promise<{ h: Hosted; admin: Admin }> {
  if (!ctx.s.supabase || adminEmails(ctx).size === 0 || !bearer(ctx.req)) throw notFound();
  const h = hosted(ctx);
  let user;
  try {
    user = await requireUser(h);
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) throw notFound();
    throw err;
  }
  if (!isAdmin(ctx, user)) throw notFound();
  return { h, admin: { id: user.id, email: normalizeEmail(user.email)! } };
}

// ─── Overview ─────────────────────────────────────────────────────────────

/** Numeric columns we read from the data pipeline's nightly table, by the names it might use. */
const pick = (row: Record<string, unknown>, ...names: string[]): number | null => {
  for (const n of names) if (typeof row[n] === 'number') return row[n] as number;
  return null;
};

/** Both columns as one number, or null when the row has neither. */
function sumOf(row: Record<string, unknown>, ...names: string[]): number | null {
  const vals = names.map((n) => pick(row, n)).filter((v): v is number => v !== null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
}

/**
 * Stripe connections the hourly job found broken and the founder hasn't
 * reconnected since: a break is keyed by the connection's `connected_at`,
 * so reconnecting (a new `connected_at`) leaves the old break behind.
 */
async function brokenNow(ctx: Hosted): Promise<{ user_id: string }[]> {
  const breaks = await pg<{ user_id: string; connected_at: string }>(ctx, 'GET', 'connection_breaks', [['select', 'user_id,connected_at'], ['provider', 'eq.stripe'], ['order', 'detected_at.desc'], ['limit', '50']], { missingOk: true }).catch(() => null);
  const rows = breaks?.rows ?? [];
  if (!rows.length) return [];
  const live = await select<{ user_id: string; connected_at: string }>(ctx, 'connections', [['select', 'user_id,connected_at'], ['provider', 'eq.stripe'], ['user_id', `in.(${[...new Set(rows.map((r) => r.user_id))].join(',')})`]]);
  const current = new Set(live.map((c) => `${c.user_id}|${Date.parse(c.connected_at)}`));
  return rows.filter((b) => current.has(`${b.user_id}|${Date.parse(b.connected_at)}`)).slice(0, 20);
}

async function overview(ctx: Hosted): Promise<Overview> {
  const since = (days: number) => `gte.${iso(ctx.now - days * DAY)}`;
  const app = ctx.s.stripeApp;
  const [accTotal, acc1, acc7, acc30, paying, waitRows, changes, daily, prices, stripeTotal, stripeLive, githubTotal, githubNoRepo, posthog, noToken, wrongMode, flagged] =
    await Promise.all([
      count(ctx, 'profiles', 'user_id', []),
      count(ctx, 'profiles', 'user_id', [['created_at', since(1)]]),
      count(ctx, 'profiles', 'user_id', [['created_at', since(7)]]),
      count(ctx, 'profiles', 'user_id', [['created_at', since(30)]]),
      payingRows(ctx),
      all<WaitlistRow>(ctx, 'waitlist', [['select', WAITLIST_COLS], ['order', 'created_at.asc']], true),
      all<{ at: string; change: string; comp: boolean }>(ctx, 'plan_changes', [['select', 'at,change,comp'], ['at', since(30)], ['order', 'at.asc']], true),
      pg<Record<string, unknown>>(ctx, 'GET', 'product_daily', [['select', '*'], ['order', 'day.desc'], ['limit', '30']], { missingOk: true }).catch(() => null),
      plans(ctx),
      count(ctx, 'connections', 'user_id', [['provider', 'eq.stripe']]),
      count(ctx, 'connections', 'user_id', [['provider', 'eq.stripe'], ['livemode', 'is.true']]),
      count(ctx, 'connections', 'user_id', [['provider', 'eq.github']]),
      count(ctx, 'connections', 'user_id', [['provider', 'eq.github'], ['metadata->>repo', 'is.null']]),
      count(ctx, 'connections', 'user_id', [['provider', 'eq.posthog']]),
      select<{ user_id: string }>(ctx, 'connections', [['select', 'user_id'], ['provider', 'eq.stripe'], ['secret', 'is.null'], ['limit', '20']]),
      // The server refuses a connection made in the other mode (see accessToken in stripe-app.ts).
      app ? select<{ user_id: string }>(ctx, 'connections', [['select', 'user_id'], ['provider', 'eq.stripe'], ['livemode', app.livemode ? 'is.false' : 'is.true'], ['limit', '20']]) : [],
      brokenNow(ctx),
    ]);

  const real = paying.filter((r) => !r.comp);
  const monthly = real.filter((r) => r.plan_interval === 'month').length;
  const yearly = real.filter((r) => r.plan_interval === 'year').length;
  const month = prices.find((p) => p.interval === 'month');
  const year = prices.find((p) => p.interval === 'year');
  const mrr = month && year ? { amount: Math.round(monthly * month.amount + (yearly * year.amount) / 12), currency: month.currency } : null;

  const window = (days: number): Movement => {
    const from = ctx.now - days * DAY;
    const inWindow = (changes ?? []).filter((c) => !c.comp && Date.parse(c.at) >= from);
    return { started: inWindow.filter((c) => c.change === 'started').length, ended: inWindow.filter((c) => c.change === 'ended').length };
  };
  let movement: Overview['movement'] = changes ? { d1: window(1), d7: window(7), d30: window(30) } : null;

  // The nightly table, when the data pipeline has made it: a series for the
  // sparklines, and its started/ended counts if it keeps them.
  const days = (daily?.rows ?? []).slice().reverse();
  const series = days.map((r) => ({
    day: typeof r.day === 'string' ? Date.parse(r.day) : (pick(r, 'day', 't') ?? 0),
    mrr: pick(r, 'mrr_cents', 'mrr'),
    // The pipeline keeps paying founders by plan; older shapes kept one total.
    paying: pick(r, 'paying', 'paid', 'subscribers') ?? sumOf(r, 'paying_monthly', 'paying_yearly'),
    accounts: pick(r, 'accounts', 'signups_total', 'users'),
  }));
  let source: Overview['source'] = 'live';
  if (days.length && pick(days.at(-1)!, 'new_paid', 'new_paying', 'started') != null) {
    const sum = (n: number, ...names: string[]) => days.slice(-n).reduce((s, r) => s + (pick(r, ...names) ?? 0), 0);
    const from = (n: number): Movement => ({ started: sum(n, 'new_paid', 'new_paying', 'started'), ended: sum(n, 'churned', 'ended') });
    movement = { d1: from(1), d7: from(7), d30: from(30) };
    source = 'product_daily';
  }

  const broken = new Map<string, string>();
  for (const r of flagged) broken.set(r.user_id, 'Stripe refused the token');
  for (const r of noToken) broken.set(r.user_id, 'No refresh token stored');
  for (const r of wrongMode) broken.set(r.user_id, app?.livemode ? 'Connected in test mode' : 'Connected in live mode');

  return {
    generatedAt: ctx.now,
    source,
    access: accessMode(ctx),
    accounts: { total: accTotal ?? 0, d1: acc1 ?? 0, d7: acc7 ?? 0, d30: acc30 ?? 0 },
    paying: {
      total: paying.length,
      monthly,
      yearly,
      comp: paying.length - real.length,
      pastDue: paying.filter((r) => r.status === 'past_due').length,
      cancelling: real.filter((r) => r.cancel_at_period_end).length,
    },
    mrr,
    movement,
    waitlist: waitRows ? funnel(waitRows, new Set(real.map((r) => r.user_id))) : null,
    connections: {
      stripe: { total: stripeTotal ?? 0, live: stripeLive ?? 0, test: (stripeTotal ?? 0) - (stripeLive ?? 0), broken: new Set([...noToken, ...wrongMode, ...flagged].map((r) => r.user_id)).size },
      github: { total: githubTotal ?? 0, noRepo: githubNoRepo ?? 0 },
      posthog: posthog ?? 0,
      broken: [...broken].slice(0, 20).map(([userId, reason]) => ({ userId, reason })),
    },
    series,
  };
}

function funnel(rows: WaitlistRow[], paidIds: Set<string>): WaitlistFunnel {
  const invited = rows.filter((r) => r.invited_at);
  const signedUp = invited.filter((r) => r.signed_up_at);
  const waves = invited.map((r) => r.wave ?? 0);
  return {
    total: rows.length,
    waiting: rows.length - invited.length,
    invited: invited.length,
    signedUp: signedUp.length,
    paid: signedUp.filter((r) => r.user_id && paidIds.has(r.user_id)).length,
    unnotified: invited.filter((r) => !r.notified_at).length,
    lastWave: waves.length ? Math.max(...waves) : null,
  };
}

// ─── Users ────────────────────────────────────────────────────────────────

async function searchUsers(ctx: Hosted, raw: string): Promise<UserSearch> {
  const q = raw.trim().toLowerCase().slice(0, 120);
  let found: AuthAdminUser[] = [];
  if (UUID.test(q)) {
    const u = await authUser(ctx, q);
    found = u ? [u] : [];
  } else if (/^(cus|acct)_\w{1,60}$/.test(q)) {
    // A Stripe id: ours (cus_, the founder's TinyTown subscription) or theirs (acct_, their connected account).
    const ids = q.startsWith('cus_')
      ? await select<{ user_id: string }>(ctx, 'subscriptions', [['select', 'user_id'], ['stripe_customer_id', `eq.${raw.trim()}`], ['limit', '5']])
      : await select<{ user_id: string }>(ctx, 'connections', [['select', 'user_id'], ['provider', 'eq.stripe'], ['account_id', `eq.${raw.trim()}`], ['limit', '5']]);
    found = (await Promise.all(ids.map((r) => authUser(ctx, r.user_id)))).filter((u): u is AuthAdminUser => !!u);
  } else {
    found = await authUsers(ctx, q.replace(/[^a-z0-9@._+-]/g, ''));
  }

  const term = q.replace(/[^a-z0-9@._+-]/g, '');
  const [subs, waitRows] = await Promise.all([
    found.length ? select<CompRow>(ctx, 'subscriptions', [['select', SUB_COLS], ['user_id', inList(found.map((u) => u.id))]]) : [],
    term && !UUID.test(q)
      ? pg<WaitlistRow>(ctx, 'GET', 'waitlist', [['select', WAITLIST_COLS], ['email', `ilike.*${term}*`], ['order', 'created_at.asc'], ['limit', '10']], { missingOk: true })
      : null,
  ]);
  const users: UserHit[] = found.map((u) => {
    const sub = subs.find((s) => s.user_id === u.id);
    return { id: u.id, email: u.email ?? null, createdAt: ms(u.created_at), lastSignInAt: ms(u.last_sign_in_at), plan: planStatus(sub?.status), comp: !!sub?.comp };
  });
  return { q: raw.trim().slice(0, 120), users, waitlist: (waitRows?.rows ?? []).map(entry) };
}

function describeAction(a: Action): string {
  if (a.kind === 'build') return `Built ${a.item}${a.plot ? ` on ${a.plot}` : ''}`;
  return `Moved house: ${a.choice} (tier ${a.tier})`;
}

async function userDetail(ctx: Hosted, id: string): Promise<UserDetail> {
  if (!UUID.test(id)) throw badRequest("That isn't a user id.");
  const [user, profile, sub, conns, noToken, world, timeline, history, waitByUser] = await Promise.all([
    authUser(ctx, id),
    ctx.db.one<ProfileRow>('profiles', { user_id: id }),
    ctx.db.one<CompRow>('subscriptions', { user_id: id }),
    select<ConnectionRow>(ctx, 'connections', [['select', CONNECTION_COLS], ['user_id', `eq.${id}`]]),
    count(ctx, 'connections', 'user_id', [['user_id', `eq.${id}`], ['provider', 'eq.stripe'], ['secret', 'is.null']]),
    ctx.db.one<WorldRow>('worlds', { user_id: id }),
    ctx.db.one<{ fetched_at: string; timeline: Timeline }>('timelines', { user_id: id }),
    pg<{ at: string; change: string; to_status: string | null; plan_interval: string | null; comp: boolean }>(
      ctx,
      'GET',
      'plan_changes',
      [['select', 'at,change,to_status,plan_interval,comp'], ['founder_id', `eq.${id}`], ['order', 'at.desc'], ['limit', '20']],
      { missingOk: true },
    ),
    pg<WaitlistRow>(ctx, 'GET', 'waitlist', [['select', WAITLIST_COLS], ['user_id', `eq.${id}`], ['limit', '1']], { missingOk: true }),
  ]);
  const email = normalizeEmail(user?.email);
  let wait = waitByUser?.rows[0] ?? null;
  if (!wait && email && waitByUser) wait = (await select<WaitlistRow>(ctx, 'waitlist', [['select', WAITLIST_COLS], ['email', `eq.${email}`], ['limit', '1']]))[0] ?? null;
  const audit = await select<AuditRow>(ctx, 'admin_audit', [
    ['select', 'id,at,admin_email,action,target,status,detail'],
    ['target', inList(email ? [id, email] : [id])],
    ['order', 'at.desc'],
    ['limit', '25'],
  ]);

  const app = ctx.s.stripeApp;
  const connections: ConnectionInfo[] = conns.map((c) => {
    let health = 'ok';
    if (c.provider === 'stripe') {
      if (noToken) health = 'Needs reconnecting: no refresh token stored';
      else if (app && !!c.livemode !== app.livemode) health = `Needs reconnecting: connected in ${c.livemode ? 'live' : 'test'} mode`;
      else if (typeof c.metadata?.broken_at === 'string') health = 'Needs reconnecting: Stripe refused the token';
    }
    if (c.provider === 'github' && typeof c.metadata?.repo !== 'string') health = 'No repository chosen';
    const detail = c.provider === 'github' ? c.metadata?.repo : c.provider === 'posthog' ? c.metadata?.host : null;
    return { provider: c.provider, account: c.account_id, name: c.display_name, livemode: c.livemode, connectedAt: ms(c.connected_at), detail: typeof detail === 'string' ? detail : null, health };
  });

  const actions = world?.actions ?? [];
  const last = timeline?.timeline?.snapshots?.at(-1);
  return {
    user: user
      ? {
          id: user.id,
          email: user.email ?? null,
          createdAt: ms(user.created_at),
          lastSignInAt: ms(user.last_sign_in_at),
          providers: user.app_metadata?.providers ?? (user.app_metadata?.provider ? [user.app_metadata.provider] : []),
          confirmed: !!user.email_confirmed_at,
        }
      : null,
    profile: profile ? { name: profile.name, seed: profile.seed, joinedAt: profile.joined_at, lastSeen: profile.last_seen, createdAt: ms(profile.created_at) } : null,
    plan: sub
      ? {
          status: sub.status,
          interval: sub.plan_interval,
          renewsAt: ms(sub.current_period_end),
          cancelAtPeriodEnd: sub.cancel_at_period_end,
          livemode: sub.livemode,
          stripeCustomer: sub.stripe_customer_id,
          stripeSubscription: sub.stripe_subscription_id,
          comp: sub.comp ? { reason: sub.comp_reason ?? null, by: sub.comp_by ?? null, at: ms(sub.comp_at) } : null,
        }
      : null,
    connections,
    world: world
      ? {
          actions: actions.length,
          built: actions.filter((a) => a.kind === 'build').length,
          homeMoves: actions.filter((a) => a.kind === 'home').length,
          version: world.version,
          recent: actions.slice(-10).reverse().map((a) => ({ t: a.t, what: describeAction(a) })),
        }
      : null,
    timeline: timeline ? { fetchedAt: ms(timeline.fetched_at)!, days: timeline.timeline?.snapshots?.length ?? 0, mrr: last?.mrr ?? null, customers: last?.customers ?? null } : null,
    waitlist: wait ? entry(wait) : null,
    history: (history?.rows ?? []).map((h) => ({ at: ms(h.at)!, change: h.change, status: h.to_status, interval: h.plan_interval, comp: h.comp })),
    audit: audit.map(auditEntry),
  };
}

// ─── Comps ────────────────────────────────────────────────────────────────

async function grantComp(ctx: Hosted, admin: Admin, id: string, body: Record<string, unknown>) {
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 3 || reason.length > 500) throw badRequest('Say why (3 to 500 characters). The reason is kept with the comp.');
  const interval: PlanInterval = body.interval === 'month' ? 'month' : 'year';
  return change(ctx, admin, body, 'comp.grant', id, { reason, interval }, async () => {
    if (!(await authUser(ctx, id))) throw new HttpError(404, 'No account with that id.', 'bad_request');
    const sub = await ctx.db.one<CompRow>('subscriptions', { user_id: id });
    if (sub?.comp && isPaid(planStatus(sub.status))) return { comp: true, already: true };
    if (sub && isPaid(planStatus(sub.status))) {
      throw new HttpError(409, `They already pay through Stripe (${sub.plan_interval === 'year' ? 'yearly' : 'monthly'}). Cancel that in Stripe first if you want to comp them instead.`, 'rejected');
    }
    // No Stripe subscription, so nothing can bill them or (with the billing
    // module's comp check) overwrite this row. Their Stripe customer, if any, stays.
    await ctx.db.upsert(
      'subscriptions',
      {
        user_id: id,
        status: 'active',
        comp: true,
        comp_reason: reason,
        comp_by: admin.email,
        comp_at: iso(ctx.now),
        plan_interval: interval,
        stripe_subscription_id: null,
        price_id: null,
        current_period_end: null,
        cancel_at_period_end: false,
        livemode: null,
        updated_at: iso(ctx.now),
      },
      'user_id',
    );
    resetAccessCaches(id);
    return { comp: true, already: false };
  });
}

async function revokeComp(ctx: Hosted, admin: Admin, id: string, body: Record<string, unknown>) {
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
  return change(ctx, admin, body, 'comp.revoke', id, { reason }, async () => {
    const sub = await ctx.db.one<CompRow>('subscriptions', { user_id: id });
    if (!sub?.comp) throw new HttpError(409, "They don't have a comp to revoke.", 'rejected');
    // Canceled, like a plan that ended: the app asks them to pick one.
    await ctx.db.update('subscriptions', { user_id: id }, { status: 'canceled', comp: false, updated_at: iso(ctx.now) });
    resetAccessCaches(id);
    return { comp: false };
  });
}

/** Drops the cached timeline and rebuilds it now, reporting what the providers said. */
async function refreshTimeline(ctx: Hosted, admin: Admin, id: string, body: Record<string, unknown>) {
  return change(ctx, admin, body, 'timeline.refresh', id, {}, async () => {
    const profile = await ctx.db.one<ProfileRow>('profiles', { user_id: id });
    if (!profile) throw new HttpError(409, "They haven't opened TinyTown yet, so there's no city to refresh.", 'rejected');
    await ctx.db.remove('timelines', { user_id: id });
    try {
      const t = await userTimeline(ctx, profile);
      return { ok: true, days: t.snapshots.length, mrr: t.snapshots.at(-1)?.mrr ?? null };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'The rebuild failed.' };
    }
  });
}

// ─── Waitlist ─────────────────────────────────────────────────────────────

/** How many invite emails go to the email module at once. */
const NOTIFY_PARALLEL = 20;

/** Hands invites to the email module a batch at a time, recording each batch as sent. */
async function sendInvites(ctx: Hosted, emails: string[]) {
  for (const batch of chunks(emails, NOTIFY_PARALLEL)) {
    await Promise.all(batch.map((email) => notify(ctx, { kind: 'access.invited', email }).catch(() => undefined)));
    await pg(ctx, 'PATCH', 'waitlist', [['email', inList(batch)]], { body: { notified_at: iso(ctx.now) }, prefer: ['return=minimal'] });
  }
}

/**
 * Lets these people in. Only rows still waiting are touched (the update
 * filters on `invited_at is null`), so a repeat or a race between two admins
 * invites, and emails, each person once.
 */
async function invite(ctx: Hosted, emails: string[], wave: number): Promise<string[]> {
  const newly: string[] = [];
  for (const chunk of chunks(emails, 100)) {
    const res = await pg<{ email: string }>(ctx, 'PATCH', 'waitlist', [['email', inList(chunk)], ['invited_at', 'is.null'], ['select', 'email']], {
      body: { invited_at: iso(ctx.now), wave },
      prefer: ['return=representation'],
    });
    newly.push(...res!.rows.map((r) => r.email));
  }
  await sendInvites(ctx, newly);
  // People denied a moment ago get in on their next request (other instances within 20 seconds).
  resetAccessCaches();
  return newly;
}

async function nextWave(ctx: Hosted): Promise<number> {
  const [top] = await select<{ wave: number }>(ctx, 'waitlist', [['select', 'wave'], ['wave', 'not.is.null'], ['order', 'wave.desc'], ['limit', '1']]);
  return Math.max(1, (top?.wave ?? 0) + 1);
}

function sourceOf(body: Record<string, unknown>): string | null {
  if (body.source == null || body.source === '') return null;
  if (typeof body.source !== 'string' || !SOURCE.test(body.source)) throw badRequest("That source name isn't valid.");
  return body.source;
}

async function inviteNext(ctx: Hosted, admin: Admin, body: Record<string, unknown>): Promise<InviteResult> {
  const n = intIn(body.count, 1, INVITE_BATCH_MAX, 'count');
  const source = sourceOf(body);
  const wave = body.wave == null ? await nextWave(ctx) : intIn(body.wave, 0, 10_000, 'wave');
  const scope: Params = source ? [['source', `eq.${source}`]] : [];
  const waiting = () => count(ctx, 'waitlist', 'email', [['invited_at', 'is.null'], ...scope]).then((c) => c ?? 0);
  // Oldest first: the order people joined is the order they're let in.
  const pickNext = () =>
    select<{ email: string; created_at: string }>(ctx, 'waitlist', [['select', 'email,created_at'], ['invited_at', 'is.null'], ...scope, ['order', 'created_at.asc,email.asc'], ['limit', String(n)]]);

  if (body.dryRun === true) {
    const [picks, remaining] = await Promise.all([pickNext(), waiting()]);
    return { invited: picks.length, wave, remaining, from: ms(picks[0]?.created_at), to: ms(picks.at(-1)?.created_at), dryRun: true };
  }
  return change(ctx, admin, body, 'waitlist.invite_next', source, { count: n, source, wave }, async () => {
    const picks = await pickNext();
    const newly = await invite(
      ctx,
      picks.map((p) => p.email),
      wave,
    );
    return { invited: newly.length, wave, remaining: await waiting(), from: ms(picks[0]?.created_at), to: ms(picks.at(-1)?.created_at) };
  });
}

async function inviteEmails(ctx: Hosted, admin: Admin, body: Record<string, unknown>): Promise<InviteEmailsResult> {
  const list = typeof body.emails === 'string' ? body.emails.split(/[\s,;]+/) : Array.isArray(body.emails) ? body.emails : null;
  if (!list) throw badRequest('Send emails as a list.');
  if (list.length > INVITE_EMAILS_MAX) throw badRequest(`Up to ${INVITE_EMAILS_MAX} addresses at a time.`);
  const valid = new Set<string>();
  const invalid: string[] = [];
  for (const raw of list) {
    if (typeof raw === 'string' && !raw.trim()) continue;
    const e = normalizeEmail(raw);
    if (e) valid.add(e);
    else invalid.push(String(raw).slice(0, 80));
  }
  const emails = [...valid];
  if (!emails.length) throw badRequest(invalid.length ? "None of those look like email addresses." : 'Add at least one email address.');
  const wave = body.wave == null ? 0 : intIn(body.wave, 0, 10_000, 'wave');
  return change(ctx, admin, body, 'waitlist.invite_emails', emails.length === 1 ? emails[0]! : `${emails.length} emails`, { emails, wave }, async () => {
    // Anyone not on the list yet joins it by hand ('admin'), then everyone is invited.
    let added = 0;
    for (const chunk of chunks(emails, 100)) {
      const res = await pg(ctx, 'POST', 'waitlist', [['on_conflict', 'email'], ['select', 'email']], {
        body: chunk.map((email) => ({ email, source: 'admin', created_at: iso(ctx.now) })),
        prefer: ['resolution=ignore-duplicates', 'return=representation'],
      });
      added += res!.rows.length;
    }
    const newly = await invite(ctx, emails, wave);
    return { invited: newly.length, already: emails.length - newly.length, added, invalid: invalid.slice(0, 20), wave };
  });
}

/** Sends the invite email again to someone already invited. */
async function resendInvite(ctx: Hosted, admin: Admin, email: string | null, target: string, body: Record<string, unknown>) {
  if (!email) throw badRequest("There's no email address to send to.");
  return change(ctx, admin, body, 'waitlist.resend', target, { email }, async () => {
    const [row] = await select<WaitlistRow>(ctx, 'waitlist', [['select', WAITLIST_COLS], ['email', `eq.${email}`], ['limit', '1']]);
    if (!row?.invited_at) throw new HttpError(409, row ? "They haven't been invited yet. Invite them first." : "They aren't on the waitlist. Invite them by email first.", 'rejected');
    await sendInvites(ctx, [email]);
    return { sent: true };
  });
}

/** Invites that never reached the email module (a batch cut short), sent now. */
async function notifyPending(ctx: Hosted, admin: Admin, body: Record<string, unknown>) {
  return change(ctx, admin, body, 'waitlist.notify_pending', null, {}, async () => {
    const rows = await select<{ email: string }>(ctx, 'waitlist', [['select', 'email'], ['invited_at', 'not.is.null'], ['notified_at', 'is.null'], ['order', 'invited_at.asc'], ['limit', String(INVITE_BATCH_MAX)]]);
    await sendInvites(
      ctx,
      rows.map((r) => r.email),
    );
    return { sent: rows.length };
  });
}

const LIST_LIMIT = 50;

async function waitlistPage(ctx: Hosted): Promise<WaitlistPage> {
  const p = ctx.url.searchParams;
  const status = p.get('status') ?? 'all';
  const source = p.get('source') || null;
  if (source && !SOURCE.test(source)) throw badRequest("That source name isn't valid.");
  const term = (p.get('q') ?? '').toLowerCase().replace(/[^a-z0-9@._+-]/g, '').slice(0, 120);
  const offset = Math.max(0, Math.min(Number(p.get('offset')) || 0, 1_000_000));
  const filters: Params = [];
  if (status === 'waiting') filters.push(['invited_at', 'is.null']);
  else if (status === 'invited') filters.push(['invited_at', 'not.is.null']);
  else if (status === 'joined') filters.push(['signed_up_at', 'not.is.null']);
  else if (status !== 'all') throw badRequest('status is all, waiting, invited or joined.');
  if (source) filters.push(['source', `eq.${source}`]);
  if (term) filters.push(['email', `ilike.*${term}*`]);
  // Waiting: the queue in order. Otherwise the most recent first.
  const order = status === 'waiting' ? 'created_at.asc,email.asc' : status === 'all' ? 'created_at.desc,email.asc' : status === 'joined' ? 'signed_up_at.desc' : 'invited_at.desc,email.asc';

  const [page, rows, paying] = await Promise.all([
    pg<WaitlistRow>(ctx, 'GET', 'waitlist', [['select', WAITLIST_COLS], ...filters, ['order', order], ['limit', String(LIST_LIMIT)], ['offset', String(offset)]], { count: true }),
    all<WaitlistRow>(ctx, 'waitlist', [['select', 'source,invited_at,wave,notified_at,signed_up_at,user_id,created_at,email'], ['order', 'created_at.asc']]),
    payingRows(ctx),
  ]);
  const paidIds = new Set(paying.filter((r) => !r.comp).map((r) => r.user_id));
  const sources = new Map<string, { source: string; total: number; waiting: number }>();
  const waves = new Map<number, WaitlistPage['waves'][number]>();
  for (const r of rows!) {
    const s = sources.get(r.source) ?? { source: r.source, total: 0, waiting: 0 };
    s.total++;
    if (!r.invited_at) s.waiting++;
    sources.set(r.source, s);
    if (r.invited_at) {
      const w = r.wave ?? 0;
      const row = waves.get(w) ?? { wave: w, invited: 0, signedUp: 0, paid: 0, at: null };
      row.invited++;
      if (r.signed_up_at) row.signedUp++;
      if (r.user_id && paidIds.has(r.user_id)) row.paid++;
      const at = ms(r.invited_at)!;
      row.at = row.at == null ? at : Math.min(row.at, at);
      waves.set(w, row);
    }
  }
  return {
    rows: page!.rows.map(entry),
    total: page!.total ?? page!.rows.length,
    offset,
    limit: LIST_LIMIT,
    funnel: funnel(rows!, paidIds),
    sources: [...sources.values()].sort((a, b) => b.total - a.total),
    waves: [...waves.values()].sort((a, b) => a.wave - b.wave),
  };
}

async function auditLog(ctx: Hosted): Promise<{ entries: AuditEntry[] }> {
  const target = ctx.url.searchParams.get('target');
  const limit = Math.max(1, Math.min(Number(ctx.url.searchParams.get('limit')) || 100, 500));
  const rows = await select<AuditRow>(ctx, 'admin_audit', [
    ['select', 'id,at,admin_email,action,target,status,detail'],
    ...(target ? ([['target', `eq.${target.slice(0, 200)}`]] as Params) : []),
    ['order', 'at.desc'],
    ['limit', String(limit)],
  ]);
  return { entries: rows.map(auditEntry) };
}

// ─── Routing ──────────────────────────────────────────────────────────────

type Handler = (ctx: Hosted, admin: Admin, params: string[]) => Promise<Response>;
interface Route {
  method: string;
  path: RegExp;
  write: boolean;
  run: Handler;
}

const USER = '([0-9a-fA-F-]{36})';
const ok = (body: unknown) => json(body);

/** Reads log themselves after serving; `target` is what they looked at. */
const read =
  (action: string, fn: (ctx: Hosted, params: string[], admin: Admin) => Promise<unknown>, target: (ctx: Hosted, params: string[]) => string | null = () => null): Handler =>
  async (ctx, admin, params) => {
    const body = await fn(ctx, params, admin);
    await auditRead(ctx, admin, action, target(ctx, params), ctx.url.search ? { query: ctx.url.search.slice(0, 200) } : {});
    return ok(body);
  };

const ROUTES: Route[] = [
  {
    method: 'GET',
    path: /^\/me$/,
    write: false,
    run: read('console.open', async (ctx, _params, admin) => ({ email: admin.email, access: accessMode(ctx), now: ctx.now }) satisfies AdminMe),
  },
  { method: 'GET', path: /^\/overview$/, write: false, run: read('overview.read', overview) },
  { method: 'GET', path: /^\/users$/, write: false, run: read('users.search', (ctx) => searchUsers(ctx, ctx.url.searchParams.get('q') ?? '')) },
  { method: 'GET', path: new RegExp(`^/users/${USER}$`), write: false, run: read('user.read', (ctx, [id]) => userDetail(ctx, id!.toLowerCase()), (_ctx, [id]) => id!.toLowerCase()) },
  { method: 'POST', path: new RegExp(`^/users/${USER}/comp$`), write: true, run: async (ctx, admin, [id]) => ok(await grantComp(ctx, admin, id!.toLowerCase(), await readJson(ctx.req))) },
  { method: 'DELETE', path: new RegExp(`^/users/${USER}/comp$`), write: true, run: async (ctx, admin, [id]) => ok(await revokeComp(ctx, admin, id!.toLowerCase(), await readJson(ctx.req))) },
  { method: 'POST', path: new RegExp(`^/users/${USER}/refresh$`), write: true, run: async (ctx, admin, [id]) => ok(await refreshTimeline(ctx, admin, id!.toLowerCase(), await readJson(ctx.req))) },
  {
    method: 'POST',
    path: new RegExp(`^/users/${USER}/resend-invite$`),
    write: true,
    run: async (ctx, admin, [id]) => {
      const body = await readJson(ctx.req);
      const user = await authUser(ctx, id!.toLowerCase());
      if (!user) throw new HttpError(404, 'No account with that id.', 'bad_request');
      return ok(await resendInvite(ctx, admin, normalizeEmail(user.email), id!.toLowerCase(), body));
    },
  },
  { method: 'GET', path: /^\/waitlist$/, write: false, run: read('waitlist.read', waitlistPage) },
  {
    method: 'POST',
    path: /^\/waitlist\/invite$/,
    write: true,
    run: async (ctx, admin) => {
      const body = await readJson(ctx.req);
      const result = await inviteNext(ctx, admin, body);
      if (result.dryRun) await auditRead(ctx, admin, 'waitlist.invite_preview', null, { count: body.count, source: body.source ?? null });
      return ok(result);
    },
  },
  { method: 'POST', path: /^\/waitlist\/invite-emails$/, write: true, run: async (ctx, admin) => ok(await inviteEmails(ctx, admin, await readJson(ctx.req))) },
  {
    method: 'POST',
    path: /^\/waitlist\/resend$/,
    write: true,
    run: async (ctx, admin) => {
      const body = await readJson(ctx.req);
      const email = normalizeEmail(body.email);
      return ok(await resendInvite(ctx, admin, email, email ?? '', body));
    },
  },
  { method: 'POST', path: /^\/waitlist\/notify-pending$/, write: true, run: async (ctx, admin) => ok(await notifyPending(ctx, admin, await readJson(ctx.req))) },
  { method: 'GET', path: /^\/audit$/, write: false, run: read('audit.read', auditLog) },
];

export const adminExtension: Extension = {
  match: (path) => path === PREFIX || path.startsWith(`${PREFIX}/`),
  handle: async (ctx) => {
    // Who first: nothing below, not even "method not allowed", is visible to anyone else.
    const { h, admin } = await authorize(ctx);
    const sub = ctx.url.pathname.replace(/\/+$/, '').slice(PREFIX.length);
    for (const r of ROUTES) {
      const m = r.path.exec(sub);
      if (!m || r.method !== ctx.req.method) continue;
      rateLimit(`admin:${admin.id}`, READS_PER_MINUTE, ctx.now);
      if (r.write) rateLimit(`admin-write:${admin.id}`, WRITES_PER_MINUTE, ctx.now);
      return r.run(h, admin, m.slice(1));
    }
    throw notFound();
  },
};
