import { isPaid } from '../src/api/contract.ts';
import { sha256 } from './crypto.ts';
import type { Env, Settings } from './env.ts';
import { HttpError, bearer, notConfigured } from './http.ts';
import { planStatus, type SubscriptionRow } from './store.ts';
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
  if (hit && hit.until > ctx.now) return hit.user;
  const user = await fetchUser(ctx.supabase, token);
  if (!user) throw new HttpError(401, 'Your session has expired. Sign in again.', 'unauthenticated');
  if (authCache.size > 5_000) authCache.clear();
  authCache.set(key, { user, until: ctx.now + AUTH_TTL_MS });
  return user;
}

/** The caller's plan row; 402 unless it's paid up. */
export async function requirePaid(ctx: Hosted, user: AuthUser): Promise<SubscriptionRow> {
  const sub = await ctx.db.one<SubscriptionRow>('subscriptions', { user_id: user.id });
  if (!sub || !isPaid(planStatus(sub.status))) throw new HttpError(402, 'Pick a plan to open your city.', 'payment_required');
  return sub;
}

// ─── Light rate limits ────────────────────────────────────────────────────

/**
 * A per-user fixed window, in memory. On serverless each instance counts on
 * its own, so this is a speed bump against loops and scripts, not a quota.
 */
const windows = new Map<string, { start: number; count: number }>();

export function rateLimit(key: string, perMinute: number, now: number) {
  const w = windows.get(key);
  if (!w || now - w.start >= 60_000) {
    if (windows.size > 20_000) windows.clear();
    windows.set(key, { start: now, count: 1 });
    return;
  }
  if (++w.count > perMinute) throw new HttpError(429, 'Slow down a little and try again in a minute.', 'rate_limited');
}

/** For tests: forget cached sign-ins and rate-limit counters. */
export function resetContextCaches() {
  authCache.clear();
  windows.clear();
}
