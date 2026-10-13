import type { Hosted } from './context.ts';
import { sha256 } from './crypto.ts';
import { providerFor } from './email/provider.ts';
import { brandFor, dedupeKey, deliver, type Outgoing } from './email/send.ts';
import { userEmail, sendable } from './email/store.ts';
import * as T from './email/templates.ts';

/**
 * Lifecycle events other modules announce; the email module decides what
 * (if anything) to send. Never throws: a failed email must not fail a
 * webhook or a request.
 *
 * `ref` (optional) is the id of what happened, such as a Stripe subscription
 * or invoice id. Retries of one event carry the same ref and send once; a
 * new event with a new ref sends again. Without one, each kind falls back to
 * a sensible window (see `refFor`).
 */
export type NotifyEvent =
  | { kind: 'plan.started'; userId: string; interval: 'month' | 'year'; ref?: string }
  | { kind: 'plan.payment_failed'; userId: string; ref?: string }
  | { kind: 'plan.canceled'; userId: string; endsAt: number | null; ref?: string }
  | { kind: 'plan.ended'; userId: string; ref?: string }
  | { kind: 'connection.broken'; userId: string; provider: 'stripe' | 'github' | 'posthog'; ref?: string }
  | { kind: 'account.deleted'; email: string }
  | { kind: 'access.invited'; email: string; ref?: string };

const DAY = 86_400_000;
const WEEK = 7 * DAY;

/** The event's own reference, or a window: the welcome once, money and connection nags at most weekly. */
function refFor(e: NotifyEvent, now: number): string {
  const week = `w${Math.floor(now / WEEK)}`;
  switch (e.kind) {
    case 'plan.started':
      return e.ref ?? 'first';
    case 'plan.payment_failed':
    case 'plan.ended':
      return e.ref ?? week;
    case 'plan.canceled':
      return e.ref ?? (e.endsAt !== null ? `ends-${e.endsAt}` : week);
    case 'connection.broken':
      return `${e.provider}:${e.ref ?? week}`;
    case 'access.invited':
      return e.ref ?? 'invite';
    case 'account.deleted':
      return `d${Math.floor(now / DAY)}`;
  }
}

/** Who a log line names: the user id, never an address. */
const subjectOf = (e: NotifyEvent) => ('userId' in e ? e.userId : 'guest');

export async function notify(ctx: Hosted, event: NotifyEvent): Promise<void> {
  try {
    const provider = providerFor(ctx.env);
    if (!provider) {
      console.log(`email not configured: would send ${event.kind} to ${subjectOf(event)}`);
      return;
    }
    const out = await compose(ctx, event);
    if (!out) return;
    // After a deletion nothing about the person is written down: the provider's idempotency key dedupes alone.
    await deliver(ctx, provider, out, event.kind !== 'account.deleted');
  } catch (err) {
    console.error(`email ${event.kind} for ${subjectOf(event)} failed: ${err instanceof Error ? err.message : 'unknown error'}`);
  }
}

/** The message for an event, or null if there's no one to send it to. */
async function compose(ctx: Hosted, e: NotifyEvent): Promise<Outgoing | null> {
  const brand = brandFor(ctx);
  const ref = refFor(e, ctx.now);

  if (e.kind === 'account.deleted' || e.kind === 'access.invited') {
    if (!sendable(e.email)) {
      console.error(`email ${e.kind} for guest skipped: not a usable address`);
      return null;
    }
    const email = e.kind === 'account.deleted' ? T.accountDeleted(brand) : T.accessInvited(brand, { email: e.email });
    return { kind: e.kind, userId: null, key: dedupeKey(e.kind, sha256(e.email.toLowerCase()), ref), message: { to: e.email, ...email, tags: { category: tag(e.kind) } } };
  }

  const to = await userEmail(ctx.supabase, e.userId, ctx.now);
  if (!to) {
    console.log(`email ${e.kind} for ${e.userId} skipped: no address on the account`);
    return null;
  }
  let email: T.Email;
  switch (e.kind) {
    case 'plan.started':
      email = T.welcome(brand, { interval: e.interval });
      break;
    case 'plan.payment_failed': {
      const portal = portalLogin(ctx.env.STRIPE_PORTAL_LOGIN_URL);
      email = T.paymentFailed(brand, { billingUrl: portal ?? brand.appUrl, viaPortal: !!portal });
      break;
    }
    case 'plan.canceled':
      email = T.planCanceled(brand, { endsAt: e.endsAt, now: ctx.now });
      break;
    case 'plan.ended':
      email = T.planEnded(brand);
      break;
    case 'connection.broken':
      email = T.connectionBroken(brand, { provider: e.provider });
      break;
  }
  return { kind: e.kind, userId: e.userId, key: dedupeKey(e.kind, e.userId, ref), message: { to, ...email, tags: { category: tag(e.kind) } } };
}

const tag = (kind: string) => kind.replace(/\./g, '_');

/**
 * Stripe's no-code portal login link (Settings → Billing → Customer portal),
 * which signs the customer in by email. Without it, the email sends people to
 * the app, where "Update card" opens the same portal.
 */
function portalLogin(raw: string | undefined): string | null {
  const url = raw?.trim();
  return url && /^https:\/\/billing\.stripe\.com\/p\/login\/[\w-]+$/.test(url) ? url : null;
}
