import { ROUTES, isPaid, type DeleteAccountResponse } from '../src/api/contract.ts';
import { track } from './analytics.ts';
import { hosted, rateLimit, requireUser, type Hosted } from './context.ts';
import { githubAppJwt } from './crypto.ts';
import { keyIsLive } from './env.ts';
import type { Extension } from './extensions.ts';
import { HttpError, badRequest, json, readJson } from './http.ts';
import { log } from './log.ts';
import { notify } from './notify.ts';
import { fetchWithRetry } from './retry.ts';
import { planStatus, type ConnectionRow, type SubscriptionRow } from './store.ts';
import { StripeError, stripe } from './stripe-api.ts';
import { serviceHeaders, type AuthUser, type SupabaseConfig } from './supabase.ts';

/**
 * Account lifecycle: export your data (`GET /api/account/export`) and
 * delete your account (`DELETE /api/account`). Both work on any plan, or
 * none, and skip the waitlist gate: a founder can always take their data
 * and leave.
 *
 * Deleting runs in an order that can be retried from any point. The steps
 * that need ids (Stripe, GitHub) run before the rows holding those ids go,
 * and the Supabase user goes last, so until the very end the founder can
 * still sign in and press the button again. A retry repeats only what's left:
 * cancelled subscriptions stay cancelled, deleted rows stay deleted, and a
 * user Supabase no longer has counts as done.
 *
 * What we keep: our Stripe customer and its invoices. Stripe holds them for
 * tax and accounting, and they're needed if a payment is ever disputed. The
 * customer is tagged `tinytown_deleted_at` so support can tell at a glance.
 */
export const accountExtension: Extension = {
  match: (path) => path === ROUTES.account || path === ROUTES.accountExport,
  async handle(ctx) {
    const path = ctx.url.pathname.replace(/\/+$/, '');
    const method = ctx.req.method;
    if (path === ROUTES.accountExport ? method !== 'GET' : method !== 'DELETE') {
      throw new HttpError(405, 'Method not allowed.', 'bad_request');
    }
    const h = hosted(ctx);
    const user = await requireUser(h);
    // Exports read every table and deleting calls three providers: an hourly
    // allowance each, counted across instances.
    if (path === ROUTES.accountExport) {
      await rateLimit(`account-export:${user.id}`, EXPORTS_PER_HOUR, h.now, { ctx: h, windowS: 3600 });
      return exportResponse(h, await exportAccount(h, user));
    }
    await rateLimit(`account-delete:${user.id}`, DELETES_PER_HOUR, h.now, { ctx: h, windowS: 3600 });
    return json(await deleteAccount(h, user, await readJson(h.req)));
  },
};

export const EXPORTS_PER_HOUR = 3;
export const DELETES_PER_HOUR = 5;

// ─── Supabase beyond the table helpers ────────────────────────────────────

const dbDown = () => new HttpError(502, 'The database is unavailable. Try again in a moment.', 'upstream');

/**
 * A SQL function from 0006 through PostgREST. `undefined` means the function
 * isn't there (the migration hasn't been run yet), so callers can fall back.
 */
async function rpc<T>(cfg: SupabaseConfig, fn: string, args: Record<string, unknown>): Promise<T | undefined> {
  const res = await fetchWithRetry(`${cfg.url}/rest/v1/rpc/${fn}`, { method: 'POST', headers: serviceHeaders(cfg), body: JSON.stringify(args) }).catch(() => null);
  if (res?.status === 404) return undefined;
  if (!res?.ok) {
    log.error('database rpc failed', { fn, status: res?.status ?? 'unreachable' });
    throw dbDown();
  }
  return (await res.json()) as T;
}

/** The Supabase Auth Admin API for one user. */
function authAdmin(cfg: SupabaseConfig, method: 'GET' | 'DELETE', userId: string): Promise<Response> {
  return fetchWithRetry(`${cfg.url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, { method, headers: serviceHeaders(cfg) });
}

/** Keys that could hold a credential. Mirrors the column filter in 0006's export_user_data. */
const SECRETISH = /secret|token|password|passwd|hash|cipher|key|nonce|salt|signature|otp/i;

function withoutSecrets(obj: unknown): Record<string, unknown> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  return Object.fromEntries(Object.entries(obj as Record<string, unknown>).filter(([k]) => !SECRETISH.test(k)));
}

// ─── Export ───────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

/** The download. Field names are our column names, so it reads as exactly what we store. */
export interface AccountExport {
  format: 'tinytown-account-export';
  version: 1;
  exportedAt: string;
  notes: string[];
  account: Row;
  profile: Row | null;
  subscription: Row | null;
  connections: Row[];
  world: Row | null;
  timeline: Row | null;
  /** Rows from other tables (email preferences and the like), by table. Null if they couldn't be listed. */
  other: Record<string, Row[]> | null;
}

const pick = (row: Row | null, keys: string[]): Row | null => (row ? Object.fromEntries(keys.filter((k) => k in row).map((k) => [k, row[k]])) : null);

const NOTES = [
  'This is everything TinyTown stores about you, as of exportedAt.',
  'Your Stripe and PostHog keys are not included: we keep them encrypted, only to read your numbers, and they are deleted with your account.',
  'Invoices and payment details live with Stripe, our payment processor. Download them from "Manage plan" (the Stripe customer portal) while your account exists. Stripe keeps them after you delete your account, for tax and accounting.',
  'Your city is rebuilt from your real metrics (timeline) plus your choices (world.actions); the treasury is never stored.',
];

export async function exportAccount(ctx: Hosted, user: AuthUser): Promise<AccountExport> {
  const where = { user_id: user.id };
  const [account, profile, subscription, connections, world, timeline, other] = await Promise.all([
    authAccount(ctx, user),
    ctx.db.one<Row>('profiles', where),
    ctx.db.one<Row>('subscriptions', where),
    ctx.db.many<Row>('connections', where),
    ctx.db.one<Row>('worlds', where),
    ctx.db.one<Row>('timelines', where),
    rpc<Record<string, Row[]>>(ctx.supabase, 'export_user_data', { uid: user.id }),
  ]);
  return {
    format: 'tinytown-account-export',
    version: 1,
    exportedAt: new Date(ctx.now).toISOString(),
    notes: NOTES,
    account,
    profile: pick(profile, ['user_id', 'seed', 'name', 'joined_at', 'last_seen', 'users_source', 'users_manual', 'created_at', 'updated_at']),
    subscription: pick(subscription, [
      'stripe_customer_id',
      'stripe_subscription_id',
      'status',
      'price_id',
      'plan_interval',
      'current_period_end',
      'cancel_at_period_end',
      'livemode',
      'updated_at',
    ]),
    // An allowlist, never the row: connections hold the encrypted tokens.
    connections: connections.map((c) => ({
      ...pick(c, ['provider', 'account_id', 'display_name', 'livemode', 'connected_at', 'updated_at']),
      metadata: withoutSecrets(c.metadata),
    })),
    world: pick(world, ['actions', 'version', 'updated_at']),
    timeline: pick(timeline, ['timeline', 'fetched_at']),
    other: other ?? null,
  };
}

interface AdminUser {
  id: string;
  email?: string | null;
  phone?: string | null;
  created_at?: string;
  last_sign_in_at?: string | null;
  app_metadata?: { providers?: unknown };
  user_metadata?: unknown;
  identities?: { provider?: string; identity_data?: unknown; created_at?: string; last_sign_in_at?: string }[];
}

/** What Supabase Auth holds: sign-in methods and what Google or GitHub shared. Falls back to the basics if Auth is slow. */
async function authAccount(ctx: Hosted, user: AuthUser): Promise<Row> {
  const basics = { id: user.id, email: user.email };
  try {
    const res = await authAdmin(ctx.supabase, 'GET', user.id);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const u = (await res.json()) as AdminUser;
    return {
      ...basics,
      phone: u.phone || null,
      created_at: u.created_at ?? null,
      last_sign_in_at: u.last_sign_in_at ?? null,
      sign_in_methods: Array.isArray(u.app_metadata?.providers) ? u.app_metadata.providers : [],
      profile_from_sign_in: withoutSecrets(u.user_metadata),
      identities: (u.identities ?? []).map((i) => ({
        provider: i.provider ?? null,
        details: withoutSecrets(i.identity_data),
        created_at: i.created_at ?? null,
        last_sign_in_at: i.last_sign_in_at ?? null,
      })),
    };
  } catch (err) {
    log.warn("account export: couldn't read the auth user", { user_id: user.id, err });
    return basics;
  }
}

function exportResponse(ctx: Hosted, data: AccountExport): Response {
  const day = new Date(ctx.now).toISOString().slice(0, 10);
  return new Response(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="tinytown-export-${day}.json"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// ─── Delete ───────────────────────────────────────────────────────────────


/** Typed instead of an email when the account has none (rare: every sign-in method we offer gives one). */
export const CONFIRM_WITHOUT_EMAIL = 'DELETE';

const STRIPE_APPS_PAGE = 'https://dashboard.stripe.com/apps/installed';
const GITHUB_APPS_PAGE = 'https://github.com/settings/installations';

export async function deleteAccount(ctx: Hosted, user: AuthUser, body: Record<string, unknown>): Promise<DeleteAccountResponse> {
  const typed = typeof body.confirm === 'string' && body.confirm.length <= 320 ? body.confirm.trim() : '';
  const expected = user.email ?? CONFIRM_WITHOUT_EMAIL;
  if (!typed || typed.toLowerCase() !== expected.trim().toLowerCase()) {
    throw badRequest(user.email ? "That email doesn't match your account. Type it exactly as you sign in with it." : `Type ${CONFIRM_WITHOUT_EMAIL} to confirm.`);
  }

  const [sub, connections] = await Promise.all([
    ctx.db.one<SubscriptionRow>('subscriptions', { user_id: user.id }),
    ctx.db.many<ConnectionRow>('connections', { user_id: user.id }),
  ]);

  // 1. Stop the money first. If Stripe can't be reached, nothing has been deleted yet.
  const canceled = await endBilling(ctx, user, sub);

  // 2. Our apps on the founder's accounts. Best effort: their data goes either way.
  const stillInstalled: DeleteAccountResponse['stillInstalled'] = [];
  // Stripe Apps can only be uninstalled by the account's own admin; there is
  // no API for the app's developer (Connect's /oauth/deauthorize is for
  // Connect platforms). Deleting our row drops the only copy of the refresh
  // token, and the last access token expires within the hour.
  if (connections.some((c) => c.provider === 'stripe')) stillInstalled.push({ provider: 'stripe', url: STRIPE_APPS_PAGE });
  const github = connections.find((c) => c.provider === 'github');
  if (github && (await uninstallGithub(ctx, github)) === 'installed') stillInstalled.push({ provider: 'github', url: GITHUB_APPS_PAGE });

  // 3. Every row, in one transaction.
  const deleted = await deleteRows(ctx, user.id);

  // 4. The sign-in itself. 0001's foreign keys cascade from here too, and 0006 stops anything writing the user back.
  const res = await authAdmin(ctx.supabase, 'DELETE', user.id).catch(() => null);
  if (!res || (!res.ok && res.status !== 404)) {
    log.error("account delete: couldn't delete the auth user", { user_id: user.id, status: res?.status ?? 'unreachable' });
    throw unfinished();
  }

  const rows = Object.entries(deleted).map(([table, n]) => `${table}:${n}`).join(' ');
  log.info('account deleted', { user_id: user.id, subscriptions_canceled: canceled, rows });
  if (user.email) await notify(ctx, { kind: 'account.deleted', email: user.email }).catch(() => {});
  await track(ctx, user.id, 'account_deleted', { subscriptionsCanceled: canceled, stillInstalled: stillInstalled.length }).catch(() => {});
  return { ok: true, stillInstalled };
}

/** Said whenever a step after billing fails: the plan is already stopped, and pressing the button again finishes the job. */
const unfinished = () =>
  new HttpError(502, "We couldn't finish deleting your account. Nothing more will be charged. Try again in a moment and we'll pick up where we left off.", 'upstream');

async function deleteRows(ctx: Hosted, userId: string): Promise<Record<string, number>> {
  try {
    const counts = await rpc<Record<string, number>>(ctx.supabase, 'delete_user_data', { uid: userId });
    if (counts !== undefined) return counts;
    // Without 0006, delete 0001's tables one by one; deleting the auth user would cascade them anyway.
    for (const table of ['connections', 'timelines', 'worlds', 'subscriptions', 'profiles']) await ctx.db.remove(table, { user_id: userId });
    return {};
  } catch {
    throw unfinished();
  }
}

// ─── Billing ──────────────────────────────────────────────────────────────

interface StripeList<T> {
  data: T[];
}
interface StripeSub {
  id: string;
  status: string;
}

/** Stripe statuses that can still charge, or still could once a card is added. */
const OPEN = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused']);

const stripeDown = () => new HttpError(502, "We couldn't reach Stripe to cancel your plan, so nothing has been deleted yet. Try again in a few minutes.", 'upstream');
const cantCancel = () =>
  new HttpError(503, "Billing isn't set up on this server, so we can't stop your plan from here. Write to us and we'll delete your account by hand.", 'not_configured');

/**
 * Cancels every TinyTown subscription on the founder's Stripe customer, now,
 * with no proration and no refund (the owner's policy). Returns how many it
 * cancelled. Unpaid invoices are left as they are: Stripe stops collecting
 * them when a subscription is cancelled.
 */
async function endBilling(ctx: Hosted, user: AuthUser, row: SubscriptionRow | null): Promise<number> {
  const customer = row?.stripe_customer_id;
  // Never reached Checkout: there's nothing at Stripe to stop.
  if (!customer || !row) return 0;
  const billing = ctx.s.billing;
  const owing = OPEN.has(row.status) || isPaid(planStatus(row.status));
  // A server on the other Stripe mode would find no such customer and wrongly conclude there's nothing to cancel.
  if (!billing || (row.livemode != null && row.livemode !== keyIsLive(billing.secretKey))) {
    if (owing) throw cantCancel();
    return 0;
  }
  const key = billing.secretKey;
  try {
    // An open Checkout page could still start a plan for an account that no longer exists.
    const sessions = await stripe<StripeList<{ id: string }>>(key, 'GET', '/v1/checkout/sessions', { customer, status: 'open', limit: 100 });
    for (const s of sessions.data) {
      await stripe(key, 'POST', `/v1/checkout/sessions/${encodeURIComponent(s.id)}/expire`).catch(ignoreGone);
    }
    // Every subscription, not just the one on our row: a double checkout can leave a second.
    const subs = await stripe<StripeList<StripeSub>>(key, 'GET', '/v1/subscriptions', { customer, status: 'all', limit: 100 });
    let canceled = 0;
    for (const s of subs.data.filter((x) => OPEN.has(x.status))) {
      await cancelNow(key, s.id);
      canceled++;
    }
    await stripe(key, 'POST', `/v1/customers/${encodeURIComponent(customer)}`, { metadata: { tinytown_deleted_at: new Date(ctx.now).toISOString(), tinytown_user_id: user.id } }).catch(ignoreGone);
    return canceled;
  } catch (err) {
    // The customer itself was deleted in the Stripe Dashboard: nothing left to charge.
    // Only that: any other 404 (a wrong path, a proxy) must not pass for "nothing to cancel".
    if (err instanceof StripeError && err.code === 'resource_missing' && err.param === 'customer') return 0;
    log.error('account delete: Stripe step failed', { user_id: user.id, err });
    throw stripeDown();
  }
}

/**
 * Written on every subscription this cancels, so the webhook that follows
 * can tell an account deletion from a founder ending their plan (and not
 * send a "your plan has ended" email on top of the goodbye).
 */
export const ACCOUNT_DELETED_COMMENT = 'TinyTown account deleted';

async function cancelNow(key: string, id: string) {
  const path = `/v1/subscriptions/${encodeURIComponent(id)}`;
  // Parameters in the query: a DELETE has no body.
  const params = new URLSearchParams({ invoice_now: 'false', prorate: 'false', 'cancellation_details[comment]': ACCOUNT_DELETED_COMMENT });
  try {
    await stripe(key, 'DELETE', `${path}?${params}`);
  } catch (err) {
    // A webhook-driven cancel or a second click may have got there first.
    if (!(err instanceof StripeError) || err.status >= 500) throw err;
    const now = await stripe<StripeSub>(key, 'GET', path);
    if (OPEN.has(now.status)) throw err;
  }
}

/** Already gone or already finished (a 400 or 404 from Stripe) is fine; anything else is a real failure. */
function ignoreGone(err: unknown) {
  if (err instanceof StripeError && (err.status === 400 || err.status === 404)) return;
  throw err;
}

// ─── GitHub ───────────────────────────────────────────────────────────────

/**
 * Uninstalls our GitHub App from the founder's account (the App can do this
 * itself, with its JWT), unless another TinyTown founder reads through the
 * same installation, as co-founders in one organisation can.
 */
async function uninstallGithub(ctx: Hosted, row: ConnectionRow): Promise<'removed' | 'shared' | 'installed'> {
  const app = ctx.s.githubApp;
  if (!app || !/^\d{1,20}$/.test(row.account_id)) return 'installed';
  try {
    const users = await ctx.db.many<ConnectionRow>('connections', { provider: 'github', account_id: row.account_id });
    if (users.some((r) => r.user_id !== row.user_id)) return 'shared';
    const res = await fetchWithRetry(`https://api.github.com/app/installations/${row.account_id}`, {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'tinytown',
        Authorization: `Bearer ${githubAppJwt(app.appId ?? app.clientId, app.privateKey, ctx.now)}`,
      },
    });
    // 404: the founder already uninstalled it.
    if (res.ok || res.status === 404) return 'removed';
    log.error('account delete: GitHub uninstall refused', { user_id: row.user_id, status: res.status });
    return 'installed';
  } catch (err) {
    log.error('account delete: GitHub uninstall failed', { user_id: row.user_id, err });
    return 'installed';
  }
}
