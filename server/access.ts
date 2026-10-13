import { isPaid } from '../src/api/contract.ts';
import type { Ctx, Hosted } from './context.ts';
import { HttpError } from './http.ts';
import { planStatus, type SubscriptionRow } from './store.ts';
import type { AuthUser } from './supabase.ts';

/*
 * Launch gating. In `waitlist` mode only invited emails may use the hosted
 * game (403 `not_invited` otherwise); in `open` mode, anyone. Called for
 * every signed-in route.
 *
 * Who gets through in waitlist mode:
 * - an email on the waitlist with `invited_at` set,
 * - an admin (ADMIN_EMAILS),
 * - anyone who already has paid access (a Stripe plan or a comp), so closing
 *   the doors again can never lock out a paying founder.
 *
 * Someone who signs in before their turn is added to the waitlist (source
 * `signin`), so signing in is also a way to join it. An invited person's
 * first pass through the gate records `signed_up_at` and their user id, which
 * is what the admin console's funnel counts. With ACCESS_MODE=open set
 * explicitly (after the last wave) that bookkeeping carries on; with it unset
 * there's no waitlist and the gate costs nothing.
 */

/** A row of `waitlist` (supabase/migrations/0004). */
export interface WaitlistRow {
  email: string;
  source: string;
  created_at: string;
  invited_at: string | null;
  wave: number | null;
  notified_at: string | null;
  signed_up_at: string | null;
  user_id: string | null;
}

export type AccessMode = 'open' | 'waitlist';

export function accessMode(ctx: Ctx): AccessMode {
  return ctx.env.ACCESS_MODE?.trim().toLowerCase() === 'waitlist' ? 'waitlist' : 'open';
}

/** Lowercased and trimmed, or null when it isn't a plausible address. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  // Deliberately plain: one @, something on both sides, a dot in the domain,
  // and none of the characters that would need quoting in a PostgREST filter.
  return /^[^\s@,()"'<>;:\\]+@[^\s@,()"'<>;:\\]+\.[^\s@,()"'<>;:\\]+$/.test(email) ? email : null;
}

/** ADMIN_EMAILS, a comma-separated list, lowercased. */
export function adminEmails(ctx: Ctx): Set<string> {
  return new Set(
    (ctx.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => normalizeEmail(e))
      .filter((e): e is string => !!e),
  );
}

export function isAdmin(ctx: Ctx, user: AuthUser): boolean {
  const email = normalizeEmail(user.email);
  return !!email && adminEmails(ctx).has(email);
}

/** Paid access by any route: a Stripe plan in good standing, or a comp. */
export function hasPaidAccess(sub: (SubscriptionRow & { comp?: boolean }) | null): boolean {
  return !!sub && isPaid(planStatus(sub.status));
}

// ─── Caches ───────────────────────────────────────────────────────────────

/**
 * A yes is remembered for five minutes (every API call passes through here);
 * a no for twenty seconds, so someone invited a moment ago gets in on their
 * next try. Per instance and in memory, like the sign-in cache.
 */
const ALLOW_TTL_MS = 5 * 60_000;
const DENY_TTL_MS = 20_000;
const decisions = new Map<string, { allowed: boolean; until: number }>();

/** In open mode we still note who from the waitlist has signed up, once per user per instance. */
const seen = new Map<string, number>();

/** For tests, and after an admin invites or comps someone (so this instance lets them in at once). */
export function resetAccessCaches(userId?: string) {
  if (userId) {
    decisions.delete(userId);
    seen.delete(userId);
    return;
  }
  decisions.clear();
  seen.clear();
}

function remember(userId: string, allowed: boolean, now: number) {
  if (decisions.size > 20_000) decisions.clear();
  decisions.set(userId, { allowed, until: now + (allowed ? ALLOW_TTL_MS : DENY_TTL_MS) });
}

export const notInvited = () =>
  new HttpError(
    403,
    "You're on the TinyTown waitlist. We're letting founders in a few hundred at a time so every city gets a good start, and we'll email you the moment it's your turn.",
    'not_invited',
  );

// ─── The gate ─────────────────────────────────────────────────────────────

export async function checkAccess(ctx: Hosted, user: AuthUser): Promise<void> {
  const mode = accessMode(ctx);
  if (mode === 'open') {
    // ACCESS_MODE unset means there's no waitlist at all (local, previews): nothing to note.
    if (ctx.env.ACCESS_MODE?.trim()) await noteSignup(ctx, user);
    return;
  }
  const hit = decisions.get(user.id);
  if (hit && hit.until > ctx.now) {
    if (hit.allowed) return;
    throw notInvited();
  }
  const allowed = await decide(ctx, user);
  remember(user.id, allowed, ctx.now);
  if (!allowed) throw notInvited();
}

async function decide(ctx: Hosted, user: AuthUser): Promise<boolean> {
  if (isAdmin(ctx, user)) return true;
  const email = normalizeEmail(user.email);
  const [row, sub] = await Promise.all([
    email ? ctx.db.one<WaitlistRow>('waitlist', { email }) : Promise.resolve(null),
    ctx.db.one<SubscriptionRow>('subscriptions', { user_id: user.id }),
  ]);
  if (row?.invited_at) {
    await markSignedUp(ctx, row, user);
    return true;
  }
  if (hasPaidAccess(sub)) return true;
  // Signing in early puts you in line (unless you're already in it).
  if (email && !row) {
    await ctx.db.upsert('waitlist', { email, source: 'signin', created_at: new Date(ctx.now).toISOString() }, 'email', 'ignore');
  }
  return false;
}

/** Records the first sign-in of someone from the waitlist. Best effort: the gate never fails on bookkeeping. */
async function markSignedUp(ctx: Hosted, row: WaitlistRow, user: AuthUser) {
  if (row.signed_up_at && row.user_id === user.id) return;
  try {
    await ctx.db.update('waitlist', { email: row.email }, { signed_up_at: row.signed_up_at ?? new Date(ctx.now).toISOString(), user_id: user.id });
  } catch {
    // Logged by the database client; the next pass tries again.
  }
}

async function noteSignup(ctx: Hosted, user: AuthUser) {
  const email = normalizeEmail(user.email);
  const last = seen.get(user.id);
  if (!email || (last !== undefined && last > ctx.now)) return;
  if (seen.size > 20_000) seen.clear();
  seen.set(user.id, ctx.now + ALLOW_TTL_MS);
  try {
    const row = await ctx.db.one<WaitlistRow>('waitlist', { email });
    if (row) await markSignedUp(ctx, row, user);
  } catch {
    // Open mode lets everyone in; a bookkeeping failure must not change that.
  }
}
