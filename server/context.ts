import { sha256 } from './crypto.ts';
import type { Env, Settings } from './env.ts';
import { HttpError, bearer, notConfigured } from './http.ts';
import { noteUser } from './log.ts';
import { resetSharedLimiter, sharedHit } from './ratelimit.ts';
import type { UserState } from './state.ts';
import { Db, fetchUser, type AuthUser } from './supabase.ts';

/** Everything a route needs for one request. */
export interface Ctx {
  req: Request;
  url: URL;
  env: Env;
  s: Settings;
  now: number;
}

export interface Hosted extends Ctx {
  db: Db;
  supabase: NonNullable<Settings['supabase']>;
  /**
   * The caller's rows as this request read them (server/state.ts), so each
   * is read at most once per request. Never shared between requests: "has
   * paid" is always read fresh.
   */
  userState?: { userId: string; state: UserState; /** This request made the profile. */ created: boolean };
}

export function hosted(ctx: Ctx): Hosted {
  if (!ctx.s.supabase) throw notConfigured('Accounts');
  return { ...ctx, db: new Db(ctx.s.supabase), supabase: ctx.s.supabase };
}

// ─── Who is calling ───────────────────────────────────────────────────────

/**
 * Supabase is asked about each token, with answers kept for a minute so a
 * page load's handful of calls cost one lookup. Keyed by a hash, so tokens
 * themselves aren't held in memory longer than the request.
 */
const AUTH_TTL_MS = 60_000;
const authCache = new Map<string, { user: AuthUser; until: number }>();

export async function requireUser(ctx: Hosted): Promise<AuthUser> {
  const token = bearer(ctx.req);
  if (!token) throw new HttpError(401, 'Sign in to continue.', 'unauthenticated');
  const key = sha256(token);
  const hit = authCache.get(key);
  if (hit && hit.until > ctx.now) {
    noteUser(ctx.req, hit.user.id);
    return hit.user;
  }
  const user = await fetchUser(ctx.supabase, token);
  if (!user) throw new HttpError(401, 'Your session has expired. Sign in again.', 'unauthenticated');
  // Full: forget the oldest sign-in, not all of them, so a busy instance doesn't send everyone back to Supabase at once.
  if (authCache.size >= 5_000) authCache.delete(authCache.keys().next().value!);
  authCache.set(key, { user, until: ctx.now + AUTH_TTL_MS });
  noteUser(ctx.req, user.id);
  return user;
}

// ─── Rate limits ──────────────────────────────────────────────────────────

export interface LimitOptions {
  /**
   * Also count in Postgres, shared by every server instance (hosted mode
   * only). Without it the limit is this instance's memory alone: on
   * serverless, a speed bump against loops and scripts, not a quota.
   */
  ctx?: Ctx;
  /** Window length in whole seconds, up to a day; a minute by default. */
  windowS?: number;
  /**
   * When the shared count can't be read: refuse (503) instead of allowing.
   * For sign-in and webhooks, where a flood is the attack itself.
   */
  failClosed?: boolean;
}

/** Fixed windows in this instance's memory: the cheap first layer, and the whole limit without `ctx`. */
const windows = new Map<string, { start: number; count: number }>();

export const slowDown = (retryAfter: number) =>
  new HttpError(429, `Slow down a little and try again in ${retryAfter > 90 ? 'a few minutes' : 'a minute'}.`, 'rate_limited', retryAfter);

/**
 * At most `max` hits per `key` per window. Throws 429 (with Retry-After).
 *
 * The in-memory check runs first and throws synchronously, so a call that
 * isn't awaited still gets it (that was the old, memory-only behaviour).
 * Await the result to get the shared count as well:
 *
 *   await rateLimit(`checkout:${user.id}`, 10, ctx.now, { ctx });
 */
export function rateLimit(key: string, max: number, now: number, opts: LimitOptions = {}): Promise<void> {
  const windowS = memoryLimit(key, max, now, opts.windowS);
  const supabase = opts.ctx?.s.supabase;
  if (!supabase) return Promise.resolve();
  const shared = sharedCheck(supabase, key, windowS, max, now, !!opts.failClosed);
  // Marked as handled, so a caller that doesn't await can't crash the process with it.
  shared.catch(() => {});
  return shared;
}

/** The in-memory layer alone: counts one hit, throws 429 when over. Returns the window in whole seconds. */
export function memoryLimit(key: string, max: number, now: number, window = 60): number {
  const windowS = limitWindow(window);
  const windowMs = windowS * 1000;
  const memKey = `${windowMs}:${key}`;
  const w = windows.get(memKey);
  if (!w || now - w.start >= windowMs) {
    if (windows.size > 20_000) windows.clear();
    windows.set(memKey, { start: now, count: 1 });
  } else if (++w.count > max) {
    throw slowDown((w.start + windowMs - now) / 1000);
  }
  return windowS;
}

/** Whole seconds, from one second up to a day. */
export const limitWindow = (windowS = 60) => Math.min(86_400, Math.max(1, Math.round(windowS)));

async function sharedCheck(cfg: NonNullable<Settings['supabase']>, key: string, windowS: number, max: number, now: number, failClosed: boolean) {
  const verdict = await sharedHit(cfg, key, windowS, max, { now, ignoreBreaker: failClosed });
  if (verdict === null) {
    if (failClosed) throw new HttpError(503, "We can't take this request right now. Try again in a minute.", 'upstream', 30);
    return;
  }
  if (!verdict.allowed) throw slowDown(verdict.retryAfter);
}

/** For tests: forget cached sign-ins and rate-limit counters. */
export function resetContextCaches() {
  authCache.clear();
  windows.clear();
  resetSharedLimiter();
}
