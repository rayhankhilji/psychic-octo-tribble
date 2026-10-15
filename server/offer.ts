import { OFFER_WINDOW_MS, isPaid, type Offer, type Plan } from '../src/api/contract.ts';
import { track } from './analytics.ts';
import { apiVersion, plans } from './billing.ts';
import { memoryLimit, type Ctx, type Hosted } from './context.ts';
import { HttpError } from './http.ts';
import { userState } from './state.ts';
import { planStatus, type ProfileRow, type SubscriptionRow } from './store.ts';
import { stripe } from './stripe-api.ts';
import type { AuthUser } from './supabase.ts';

/**
 * The introductory offer: the first year cheaper (the owner's $9), then the
 * standard yearly price. It's shown once, the first time a founder closes the
 * paywall, and stays open for OFFER_WINDOW_MS (48 hours) from that moment.
 *
 * Everything that decides it lives here, on the server: the window starts in
 * `profiles.offer_shown_at` and ends for good in `offer_used_at`
 * (supabase/migrations/0009), so clearing storage or opening a new browser
 * never brings it back. Only founders who have never paid can have it.
 *
 * The discount is a Stripe coupon (STRIPE_OFFER_COUPON, made by
 * tools/stripe-setup.mjs) with `duration: once`, so it comes off the first
 * invoice and every renewal is the full price. tools/stripe-setup.mjs makes
 * it as a percentage off rather than an amount off: Adaptive Pricing shows
 * the price in local currencies, and a percentage comes off whatever the
 * local price is, so the first year is the local equivalent of $9 everywhere.
 * An amount-off coupon in the price's currency works too. The first-year
 * price quoted to the founder is worked out from the coupon Stripe actually
 * has, never from a number written here.
 */

/** What the offer is in each state, or `ineligible` (paid before, or comped). */
export type OfferStatus = Offer['status'] | 'ineligible';

/**
 * Has paid for TinyTown at some point: a plan that ever started (live or
 * ended), or a comp. An unfinished first payment (3D Secure abandoned,
 * `incomplete` or `incomplete_expired`) never charged anything, so it
 * doesn't count.
 */
export function paidBefore(sub: Pick<SubscriptionRow, 'status' | 'stripe_subscription_id' | 'comp'> | null): boolean {
  if (!sub) return false;
  if (sub.comp || isPaid(planStatus(sub.status))) return true;
  return !!sub.stripe_subscription_id && !['incomplete', 'incomplete_expired', 'none'].includes(sub.status);
}

/** Pure: the offer's state for this founder right now. */
export function offerStatus(profile: Pick<ProfileRow, 'offer_shown_at' | 'offer_used_at'>, sub: Pick<SubscriptionRow, 'status' | 'stripe_subscription_id' | 'comp'> | null, now: number): OfferStatus {
  if (profile.offer_used_at) return 'used';
  if (paidBefore(sub)) return 'ineligible';
  const shown = profile.offer_shown_at ? Date.parse(profile.offer_shown_at) : NaN;
  if (!Number.isFinite(shown)) return 'unseen';
  return now < shown + OFFER_WINDOW_MS ? 'open' : 'expired';
}

// ─── The coupon, as Stripe has it ─────────────────────────────────────────

interface StripeCoupon {
  id: string;
  valid: boolean;
  duration: string;
  percent_off: number | null;
  amount_off: number | null;
  currency: string | null;
}

/** Pure: the first year's price with this coupon, or null if it doesn't fit this plan (wrong currency, a repeating discount, nothing off). */
export function firstYearPrice(plan: Plan, coupon: Pick<StripeCoupon, 'valid' | 'duration' | 'percent_off' | 'amount_off' | 'currency'>): number | null {
  // Anything but a one-off would discount the renewals too, and the copy promises the standard price after the first year.
  if (!coupon.valid || coupon.duration !== 'once' || plan.interval !== 'year') return null;
  let off = 0;
  if (coupon.percent_off != null) off = Math.round((plan.amount * coupon.percent_off) / 100);
  else if (coupon.amount_off != null && coupon.currency?.toLowerCase() === plan.currency.toLowerCase()) off = coupon.amount_off;
  const price = plan.amount - off;
  return off > 0 && price > 0 ? price : null;
}

const COUPON_TTL_MS = 10 * 60_000;
let couponCache: { id: string; until: number; coupon: StripeCoupon | null } | null = null;
let couponInFlight: { id: string; coupon: Promise<StripeCoupon | null> } | null = null;

export function resetOfferCaches() {
  couponCache = null;
  couponInFlight = null;
}

/** The coupon, cached for ten minutes per instance (and shared by requests that arrive while it's being read). Null if Stripe can't be read. */
async function couponOf(ctx: Ctx, secretKey: string, id: string): Promise<StripeCoupon | null> {
  if (couponCache?.id === id && couponCache.until > ctx.now) return couponCache.coupon;
  if (couponInFlight?.id === id) return couponInFlight.coupon;
  const pending = stripe<StripeCoupon>(secretKey, 'GET', `/v1/coupons/${encodeURIComponent(id)}`, undefined, { apiVersion: apiVersion(ctx) }).then(
    (c) => {
      couponCache = { id, until: ctx.now + COUPON_TTL_MS, coupon: c };
      return c;
    },
    (err: unknown) => {
      // No offer for now (a missing coupon, or Stripe down); ask again in a minute rather than on every request.
      console.error(`Couldn't read the offer coupon ${id}: ${err instanceof Error ? err.message : 'unknown error'}`);
      couponCache = { id, until: ctx.now + 60_000, coupon: null };
      return null;
    },
  );
  couponInFlight = { id, coupon: pending };
  return pending.finally(() => {
    if (couponInFlight?.coupon === pending) couponInFlight = null;
  });
}

/** The coupon id to apply, when this server has an offer at all. */
export function offerCoupon(ctx: Ctx): string | null {
  const id = ctx.s.billing?.offerCoupon?.trim();
  return id && /^[\w-]{1,200}$/.test(id) ? id : null;
}

/**
 * The offer as this founder sees it, or null when there's none for them: no
 * coupon on this server, a database without migration 0009, a founder who
 * has paid before, or a coupon Stripe won't confirm.
 */
export async function offerFor(ctx: Hosted, profile: ProfileRow, sub: SubscriptionRow | null): Promise<Offer | null> {
  const id = offerCoupon(ctx);
  const billing = ctx.s.billing;
  // `undefined` (not null) means the column isn't there: 0009 hasn't run, so nothing could be remembered.
  if (!id || !billing || profile.offer_shown_at === undefined) return null;
  const status = offerStatus(profile, sub, ctx.now);
  if (status === 'ineligible') return null;
  const year = (await plans(ctx)).find((p) => p.interval === 'year');
  const coupon = year ? await couponOf(ctx, billing.secretKey, id) : null;
  const amount = year && coupon ? firstYearPrice(year, coupon) : null;
  if (!year || amount == null) return null;
  const shown = profile.offer_shown_at ? Date.parse(profile.offer_shown_at) : NaN;
  return {
    status,
    available: status === 'unseen' || status === 'open',
    expiresAt: Number.isFinite(shown) ? shown + OFFER_WINDOW_MS : null,
    amount,
    regular: year.amount,
    currency: year.currency,
  };
}

// ─── Routes and hooks ─────────────────────────────────────────────────────

/** `POST /api/billing/offer/seen`: the first call starts the window; later ones change nothing. */
export async function offerSeen(ctx: Hosted, user: AuthUser): Promise<{ offer: Offer | null }> {
  memoryLimit(`offer-seen:${user.id}`, 20, ctx.now);
  const { profile, subscription } = await userState(ctx, user);
  let offer = await offerFor(ctx, profile, subscription);
  if (offer?.status === 'unseen') {
    const stamp = new Date(ctx.now).toISOString();
    const [updated] = await ctx.db.update<ProfileRow>('profiles', { user_id: user.id }, { offer_shown_at: stamp, updated_at: stamp });
    if (!updated) throw new HttpError(401, 'Your session has expired. Sign in again.', 'unauthenticated');
    offer = await offerFor(ctx, updated, subscription);
    await track(ctx, user.id, 'offer_shown', { amount: offer?.amount ?? 0, currency: offer?.currency ?? 'usd' });
  }
  return { offer };
}

/**
 * For Checkout with `offer: true`: the coupon to apply, or 409 with the
 * plain reason. Checked here, never trusted from the browser.
 */
export async function claimOffer(ctx: Hosted, user: AuthUser): Promise<string> {
  const { profile, subscription } = await userState(ctx, user);
  const offer = await offerFor(ctx, profile, subscription);
  const id = offerCoupon(ctx);
  if (!offer || !id) {
    const status = offerStatus(profile, subscription, ctx.now);
    throw new HttpError(409, status === 'ineligible' ? 'The first-year offer is for new founders only.' : "There's no first-year offer right now. The standard price is still on sale.", 'rejected');
  }
  if (offer.status === 'used') throw new HttpError(409, "You've already had the first-year offer. The standard price is still on sale.", 'rejected');
  if (offer.status === 'expired') throw new HttpError(409, 'That offer ended 48 hours after it was first shown. The standard price is still on sale.', 'rejected');
  if (offer.status !== 'open') throw new HttpError(409, "That offer isn't open yet. Reload and try again.", 'rejected');
  return id;
}

/** The webhook saw a plan bought with the offer start: it's used, for good. */
export async function markOfferUsed(ctx: Hosted, userId: string): Promise<void> {
  const profile = await ctx.db.one<ProfileRow>('profiles', { user_id: userId });
  if (!profile || profile.offer_used_at) return;
  const stamp = new Date(ctx.now).toISOString();
  await ctx.db.update('profiles', { user_id: userId }, { offer_used_at: stamp, updated_at: stamp });
}
