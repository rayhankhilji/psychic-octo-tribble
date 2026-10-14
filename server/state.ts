import { randomInt } from 'node:crypto';
import { hasAccess } from './billing.ts';
import { memoryLimit, slowDown, type Hosted } from './context.ts';
import { HttpError } from './http.ts';
import { log } from './log.ts';
import { sharedHit, storedKey } from './ratelimit.ts';
import { ensureProfile, type ConnectionRow, type ProfileRow, type SubscriptionRow, type TimelineRow, type WorldRow } from './store.ts';
import { MissingFunction, type AuthUser } from './supabase.ts';

/**
 * What a signed-in request needs to know about its caller, in one database
 * round trip: `public.user_state()` (supabase/migrations/0007) returns the
 * profile (made on first sight), the plan row and whichever of connections,
 * world and cached timeline the route asks for, and can count the route's
 * shared rate limit in the same call.
 *
 * The answer is kept on the request (`ctx.userState`) and nowhere else, so
 * each row is read at most once per request and "has paid" is still read
 * fresh on every request: a revoked comp or an ended plan loses access at
 * once, on every instance.
 *
 * Until the migration has run, the same answer is put together from separate
 * reads, as before (the code may go live a little ahead of the database).
 */

/** Rows a route can ask for besides the profile and plan, which always come. */
export type Part = 'connections' | 'world' | 'timeline';

export interface UserState {
  profile: ProfileRow;
  subscription: SubscriptionRow | null;
  /** Undefined when not asked for; null when asked for and there's no row. */
  connections?: ConnectionRow[];
  world?: WorldRow | null;
  timeline?: TimelineRow | null;
}

/** A shared rate limit for the route, counted in the same call. */
export interface RouteLimit {
  key: string;
  max: number;
  windowS?: number;
}

interface Loaded {
  state: UserState;
  created: boolean;
  /** The shared limit's verdict; null when it wasn't counted or couldn't be (fail open). */
  rate: { allowed: boolean; retryAfter: number } | null;
}

/** Shape of user_state()'s answer. */
interface Raw {
  profile: ProfileRow | null;
  created: boolean;
  subscription: SubscriptionRow | null;
  connections?: ConnectionRow[];
  world?: WorldRow | null;
  timeline?: TimelineRow | null;
  rate?: { allowed: boolean; retry_after_s: number } | null;
}

const gone = () => new HttpError(401, 'Your session has expired. Sign in again.', 'unauthenticated');

/**
 * The caller's state for this request: read once, then served from the
 * request. Asking later for a part that wasn't loaded reads just that part.
 */
export async function userState(ctx: Hosted, user: AuthUser, parts: Part[] = []): Promise<UserState> {
  const memo = ctx.userState?.userId === user.id ? ctx.userState.state : null;
  if (memo) {
    const missing = parts.filter((p) => memo[p] === undefined);
    if (missing.length) Object.assign(memo, await readParts(ctx, user.id, missing));
    return memo;
  }
  return (await load(ctx, user, parts, null)).state;
}

/**
 * The caller's state, or 402 unless their plan gives access right now
 * (checked against the period end too, billing.ts `hasAccess`, so a plan
 * cancelled at period end closes on time even if its last webhook never
 * arrived). With `rate`, also the route's limit: memory first, so a loop
 * costs no database call, then the shared count in the same round trip.
 */
export async function requirePaid(ctx: Hosted, user: AuthUser, opts: { parts?: Part[]; rate?: RouteLimit } = {}): Promise<UserState> {
  const rate = opts.rate ? { ...opts.rate, windowS: memoryLimit(opts.rate.key, opts.rate.max, ctx.now, opts.rate.windowS) } : null;
  let loaded: Loaded;
  if (ctx.userState?.userId === user.id) {
    // Already read in this request: top up the parts, and count the limit on its own.
    loaded = { state: await userState(ctx, user, opts.parts), created: false, rate: rate ? await countShared(ctx, rate) : null };
  } else {
    loaded = await load(ctx, user, opts.parts ?? [], rate);
  }
  const sub = loaded.state.subscription;
  if (!sub || !hasAccess(sub, ctx.now)) throw new HttpError(402, 'Pick a plan to open your city.', 'payment_required');
  if (loaded.rate && !loaded.rate.allowed) throw slowDown(loaded.rate.retryAfter);
  return loaded.state;
}

// ─── Reading ──────────────────────────────────────────────────────────────

/** Per instance: after a "no such function", use separate reads for a minute before asking again. */
const FALLBACK_MS = 60_000;
let fallbackUntil = 0;

export function resetStateCaches() {
  fallbackUntil = 0;
}

async function load(ctx: Hosted, user: AuthUser, parts: Part[], rate: Required<RouteLimit> | null): Promise<Loaded> {
  let loaded: Loaded | null = null;
  if (ctx.now >= fallbackUntil) {
    try {
      loaded = await viaFunction(ctx, user.id, parts, rate);
    } catch (err) {
      if (!(err instanceof MissingFunction)) throw err;
      if (fallbackUntil === 0) log.warn('user_state() is missing: run migration 0007. Using separate reads until it is there.');
      fallbackUntil = ctx.now + FALLBACK_MS;
    }
  }
  loaded ??= await viaReads(ctx, user.id, parts, rate);
  ctx.userState = { userId: user.id, state: loaded.state, created: loaded.created };
  return loaded;
}

async function viaFunction(ctx: Hosted, userId: string, parts: Part[], rate: Required<RouteLimit> | null): Promise<Loaded> {
  const raw = await ctx.db.rpc<Raw>(
    'user_state',
    {
      p_user: userId,
      p_seed: randomInt(1, 2 ** 31),
      p_parts: parts,
      p_rate_key: rate ? storedKey(rate.key) : null,
      p_rate_window_s: rate?.windowS ?? 60,
      p_rate_max: rate?.max ?? 1,
    },
    // Mostly a read, and safe to send again: the profile insert is idempotent,
    // and a retry after a failure can at worst count one rate-limit hit twice.
    { read: true },
  );
  // 0006 drops inserts for users who no longer exist: a deleted account whose sign-in is still cached.
  if (!raw?.profile) throw gone();
  const state: UserState = { profile: raw.profile, subscription: raw.subscription ?? null };
  if (parts.includes('connections')) state.connections = raw.connections ?? [];
  if (parts.includes('world')) state.world = raw.world ?? null;
  if (parts.includes('timeline')) state.timeline = raw.timeline ?? null;
  const verdict = rate && raw.rate ? { allowed: raw.rate.allowed, retryAfter: raw.rate.retry_after_s > 0 ? raw.rate.retry_after_s : rate.windowS } : null;
  return { state, created: !!raw.created, rate: verdict };
}

/** The same answer from separate reads, in parallel: for a database without 0007. */
async function viaReads(ctx: Hosted, userId: string, parts: Part[], rate: Required<RouteLimit> | null): Promise<Loaded> {
  let created = false;
  const [profile, subscription, extra, verdict] = await Promise.all([
    ensureProfile(ctx.db, userId, async () => {
      created = true;
    }),
    ctx.db.one<SubscriptionRow>('subscriptions', { user_id: userId }),
    readParts(ctx, userId, parts),
    rate ? countShared(ctx, rate) : null,
  ]);
  return { state: { profile, subscription, ...extra }, created, rate: verdict };
}

/** Just these parts, each its own read. */
async function readParts(ctx: Hosted, userId: string, parts: Part[]): Promise<Partial<UserState>> {
  const where = { user_id: userId };
  const [connections, world, timeline] = await Promise.all([
    parts.includes('connections') ? ctx.db.many<ConnectionRow>('connections', where) : undefined,
    parts.includes('world') ? ctx.db.one<WorldRow>('worlds', where) : undefined,
    parts.includes('timeline') ? ctx.db.one<TimelineRow>('timelines', where) : undefined,
  ]);
  return { ...(connections ? { connections } : {}), ...(world !== undefined ? { world } : {}), ...(timeline !== undefined ? { timeline } : {}) };
}

/** The shared count by itself (public.rate_hit), failing open like every route limit. */
async function countShared(ctx: Hosted, rate: Required<RouteLimit>): Promise<Loaded['rate']> {
  const verdict = await sharedHit(ctx.supabase, rate.key, rate.windowS, rate.max, { now: ctx.now });
  return verdict && { allowed: verdict.allowed, retryAfter: verdict.retryAfter };
}
