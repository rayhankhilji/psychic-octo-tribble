import { createHash } from 'node:crypto';
import { LEGAL, isPaid, type Plan, type PlanInterval, type RedirectResponse } from '../src/api/contract.ts';
import { ACCOUNT_DELETED_COMMENT } from './account.ts';
import { track } from './analytics.ts';
import type { Ctx, Hosted } from './context.ts';
import { verifyStripeSignature } from './crypto.ts';
import type { Settings } from './env.ts';
import { HttpError, badRequest, notConfigured } from './http.ts';
import { notify } from './notify.ts';
import { planStatus, type SubscriptionRow } from './store.ts';
import { STRIPE_API_VERSION, StripeError, stripe, stripeFailure } from './stripe-api.ts';
import type { AuthUser } from './supabase.ts';

/**
 * Our own Stripe account: TinyTown's price ($29 a year, no monthly plan, no
 * trial, no refunds), Checkout, the customer portal, and the webhook that
 * records who has paid. Billing buys access to the hosted game, never game
 * money. Checkout shows the price in the customer's own currency where
 * Stripe can (Adaptive Pricing); we still charge and record it in USD.
 *
 * Optional switches, each `1` to turn on (all off by default, except where
 * noted):
 * - STRIPE_AUTOMATIC_TAX: Stripe Tax works out sales tax and VAT from the
 *   billing address, and business customers can add a tax ID.
 * - STRIPE_TERMS_CONSENT: Checkout asks people to accept the Terms (the URL
 *   is set in the Stripe Dashboard's public details).
 * - STRIPE_PROMO_CODES: Checkout has a promotion code box.
 * - STRIPE_ADAPTIVE_PRICING: on unless set to `0`. Checkout offers the
 *   customer's local currency at Stripe's exchange rate (they pay Stripe's
 *   2–4% conversion; paying in USD stays an option on the page).
 * - STRIPE_PORTAL_CONFIGURATION (bpc_…): the portal settings made by
 *   tools/stripe-setup.mjs; without it the Dashboard's default portal is used.
 */

type Billing = NonNullable<Settings['billing']>;

export function requireBilling(ctx: Ctx): Billing {
  if (!ctx.s.billing) throw notConfigured('Billing');
  return ctx.s.billing;
}

/** Where Stripe sends people back to. Live keys need HTTPS; localhost may be plain HTTP while testing. */
export function appUrl(ctx: Ctx): string {
  const base = ctx.s.appUrl ?? ctx.url.origin;
  const u = new URL(base);
  if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) {
    throw new HttpError(503, 'APP_URL must be an https:// address.', 'not_configured');
  }
  return base.replace(/\/+$/, '');
}

const flag = (ctx: Ctx, name: string) => ctx.env[name]?.trim() === '1';
const apiVersion = (ctx: Ctx) => ctx.env.STRIPE_API_VERSION?.trim() || STRIPE_API_VERSION;
const shortHash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// ─── Prices ───────────────────────────────────────────────────────────────

interface StripePrice {
  id: string;
  unit_amount: number | null;
  currency: string;
  lookup_key?: string | null;
  product?: string | { id: string } | null;
  metadata?: Record<string, string> | null;
  recurring: { interval: string } | null;
}

/**
 * STRIPE_PRICE_YEARLY (and, only if the owner ever sells monthly again,
 * STRIPE_PRICE_MONTHLY) take either a price id (`price_…`) or a lookup key
 * (`tinytown_yearly`). Lookup keys are the same in test and live mode, so one
 * value works for both.
 */
const isPriceId = (ref: string) => /^(price|plan)_/.test(ref);

/** The intervals on sale: whatever prices are configured, and nothing else (normally just the year). */
function onSale(billing: Billing): PlanInterval[] {
  return (['month', 'year'] as const).filter((i) => !!billing.prices[i]);
}

/** The owner's prices, used only if Stripe can't be reached for the real ones (and only for the plans configured). */
const FALLBACK: Record<PlanInterval, Plan> = {
  year: { interval: 'year', amount: 2900, currency: 'usd' },
  // No longer sold; kept so a server still configured with the old monthly price quotes it.
  month: { interval: 'month', amount: 1200, currency: 'usd' },
};
const PRICE_TTL_MS = 10 * 60_000;
type Prices = Partial<Record<PlanInterval, StripePrice>>;
let priceCache: { key: string; until: number; prices: Prices } | null = null;

/** A price lookup already on its way: requests that arrive meanwhile share it instead of each asking Stripe. */
let pricesInFlight: { key: string; prices: Promise<Prices> } | null = null;

/** The configured prices as Stripe has them, checked to be what they say they are, and cached for ten minutes. */
async function resolvePrices(ctx: Ctx, billing: Billing): Promise<Prices> {
  const key = `${billing.prices.month ?? ''}|${billing.prices.year}`;
  if (priceCache && priceCache.key === key && priceCache.until > ctx.now) return priceCache.prices;
  if (pricesInFlight?.key === key) return pricesInFlight.prices;
  const prices = fetchPrices(ctx, billing, key);
  pricesInFlight = { key, prices };
  return prices.finally(() => {
    if (pricesInFlight?.prices === prices) pricesInFlight = null;
  });
}

async function fetchPrices(ctx: Ctx, billing: Billing, key: string): Promise<Prices> {
  const found: Prices = {};
  const intervals = onSale(billing);
  const byLookup = intervals.filter((i) => !isPriceId(billing.prices[i]!));
  if (byLookup.length) {
    const list = await stripe<{ data: StripePrice[] }>(
      billing.secretKey,
      'GET',
      '/v1/prices',
      { lookup_keys: byLookup.map((i) => billing.prices[i]!), active: true, limit: 10 },
      { apiVersion: apiVersion(ctx) },
    );
    for (const i of byLookup) {
      const p = list.data.find((x) => x.lookup_key === billing.prices[i]);
      if (!p) throw new Error(`No active price has the lookup key "${billing.prices[i]}"`);
      found[i] = p;
    }
  }
  for (const i of intervals) {
    if (!found[i]) found[i] = await stripe<StripePrice>(billing.secretKey, 'GET', `/v1/prices/${encodeURIComponent(billing.prices[i]!)}`, undefined, { apiVersion: apiVersion(ctx) });
    const p = found[i]!;
    if (p.unit_amount == null || p.recurring?.interval !== i) throw new Error(`Price for ${i} isn't a ${i}ly recurring price`);
  }
  priceCache = { key, until: ctx.now + PRICE_TTL_MS, prices: found };
  return found;
}

/** The price id to sell: as configured, or looked up from its lookup key. */
async function priceId(ctx: Ctx, billing: Billing, interval: PlanInterval): Promise<string> {
  const ref = billing.prices[interval];
  if (!ref) throw new Error(`No ${interval}ly price is configured`);
  return isPriceId(ref) ? ref : (await resolvePrices(ctx, billing))[interval]!.id;
}

/** For /api/config: the plans on sale, which is exactly the prices configured (normally one, yearly). */
export async function plans(ctx: Ctx): Promise<Plan[]> {
  const billing = ctx.s.billing;
  if (!billing) return [];
  const intervals = onSale(billing);
  try {
    const prices = await resolvePrices(ctx, billing);
    return intervals.map((interval) => ({ interval, amount: prices[interval]!.unit_amount!, currency: prices[interval]!.currency }));
  } catch (err) {
    console.error(`Couldn't read prices from Stripe: ${err instanceof Error ? err.message : 'unknown error'}`);
    return intervals.map((i) => FALLBACK[i]);
  }
}

const productOf = (p: { product?: string | { id: string } | null }) => (typeof p.product === 'string' ? p.product : (p.product?.id ?? null));

/**
 * A TinyTown plan, whichever way it was configured. Beyond the prices on
 * sale, this also recognises plans bought on a price we've stopped selling
 * (the old monthly and yearly prices), so their renewals, cancellations and
 * card failures still reach the right founder: any price on the same
 * product as ours, or one tools/stripe-setup.mjs made (`tinytown: 1`).
 */
function isOurPrice(billing: Billing, price: { id: string; lookup_key?: string | null; product?: string | { id: string } | null; metadata?: Record<string, string> | null }): boolean {
  const refs = onSale(billing).map((i) => billing.prices[i]!);
  if (refs.includes(price.id) || (!!price.lookup_key && refs.includes(price.lookup_key))) return true;
  if (price.metadata?.tinytown === '1') return true;
  const cached = Object.values(priceCache?.prices ?? {});
  // A lookup key moved to a newer price still leaves earlier subscribers on the old id.
  if (cached.some((p) => p.id === price.id)) return true;
  const product = productOf(price);
  return !!product && cached.some((p) => productOf(p) === product);
}

export function resetBillingCaches() {
  priceCache = null;
}

// ─── Who has access ───────────────────────────────────────────────────────

/** A cancelled plan's last hour, so a clock a little ahead of Stripe's doesn't cut anyone off early. */
const PERIOD_END_GRACE_MS = 60 * 60_000;

/**
 * Whether a plan row opens the hosted game right now:
 * - `active` and `trialing` are paid up;
 * - `past_due` keeps access while Stripe retries the card (Smart Retries);
 * - a plan cancelled at period end stays `active` until the period ends, when
 *   Stripe ends it; if that webhook is ever lost, the period end still closes
 *   the door;
 * - `unpaid`, `canceled`, `incomplete`, `incomplete_expired` and `paused`
 *   have no access.
 */
export function hasAccess(row: Pick<SubscriptionRow, 'status' | 'cancel_at_period_end' | 'current_period_end'> | null, now: number): boolean {
  if (!row || !isPaid(planStatus(row.status))) return false;
  if (row.cancel_at_period_end && row.current_period_end) {
    const end = Date.parse(row.current_period_end);
    if (Number.isFinite(end) && end + PERIOD_END_GRACE_MS < now) return false;
  }
  return true;
}

// ─── Checkout and the portal ──────────────────────────────────────────────

interface StripeCustomer {
  id: string;
}
interface StripeSession {
  id: string;
  url: string;
}

/**
 * Our Stripe customer for this user, created the first time and remembered.
 * The idempotency key is per user, so a double click (or a retry after the
 * database write failed) gets the same customer back rather than a second.
 */
async function customerFor(ctx: Hosted, billing: Billing, user: AuthUser, row: SubscriptionRow | null, replacing?: string): Promise<string> {
  if (row?.stripe_customer_id && !replacing) return row.stripe_customer_id;
  const params = { ...(user.email ? { email: user.email } : {}), metadata: { user_id: user.id } };
  const create = (idempotencyKey: string) => stripe<StripeCustomer>(billing.secretKey, 'POST', '/v1/customers', params, { idempotencyKey, apiVersion: apiVersion(ctx) });
  const base = replacing ? `tinytown-customer-${user.id}-${replacing}` : `tinytown-customer-${user.id}`;
  let customer: StripeCustomer;
  try {
    customer = await create(base);
  } catch (err) {
    // The same key with different details (the email changed within 24 hours): a fresh key for the new details.
    if (!(err instanceof StripeError && err.type === 'idempotency_error')) throw err;
    customer = await create(`${base}-${shortHash(JSON.stringify(params))}`);
  }
  await ctx.db.upsert('subscriptions', { user_id: user.id, stripe_customer_id: customer.id, updated_at: new Date(ctx.now).toISOString() }, 'user_id');
  return customer.id;
}

interface StripeSubscriptionWithInvoice {
  id: string;
  status: string;
  latest_invoice: { status: string | null; hosted_invoice_url?: string | null } | string | null;
}

/**
 * Someone who already has a subscription mustn't buy a second one. Paying
 * founders (and those whose card is being retried) go to the portal; one
 * whose first payment is still unfinished goes back to that invoice.
 * Returns null when a new Checkout is the right thing.
 */
async function existingPlan(ctx: Hosted, billing: Billing, user: AuthUser, row: SubscriptionRow | null): Promise<RedirectResponse | null> {
  if (!row?.stripe_subscription_id) return null;
  switch (row.status) {
    case 'active':
    case 'trialing':
    case 'past_due':
      // A plan that ran out without its webhook arriving can be bought again.
      return hasAccess(row, ctx.now) ? portal(ctx, user) : null;
    case 'unpaid':
    case 'paused':
      // The subscription still exists and owes an invoice: pay it, don't start another.
      return portal(ctx, user);
    case 'incomplete': {
      // The first payment needs finishing (3D Secure, or a bank debit still in flight).
      const sub = await stripe<StripeSubscriptionWithInvoice>(
        billing.secretKey,
        'GET',
        `/v1/subscriptions/${encodeURIComponent(row.stripe_subscription_id)}`,
        { expand: ['latest_invoice'] },
        { apiVersion: apiVersion(ctx) },
      );
      const invoice = typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null;
      if (sub.status === 'incomplete' && invoice?.status === 'open' && invoice.hosted_invoice_url) return { url: invoice.hosted_invoice_url };
      if (sub.status !== row.status) {
        await syncSubscription(ctx, billing, sub.id, user.id);
        if (isPaid(planStatus(sub.status))) return portal(ctx, user);
      }
      // incomplete_expired: nothing was charged, so a fresh Checkout is right.
      return null;
    }
    default:
      return null;
  }
}

/** Checkout's settings for one founder and price, with the owner's optional switches. */
export function checkoutParams(ctx: Ctx, opts: { customer: string; userId: string; price: string; base: string }) {
  const tax = flag(ctx, 'STRIPE_AUTOMATIC_TAX');
  return {
    mode: 'subscription',
    customer: opts.customer,
    client_reference_id: opts.userId,
    line_items: [{ price: opts.price, quantity: 1 }],
    success_url: `${opts.base}/?checkout=success`,
    cancel_url: `${opts.base}/?checkout=cancel`,
    metadata: { user_id: opts.userId },
    subscription_data: { metadata: { user_id: opts.userId } },
    // The price in the customer's own currency where Stripe can, renewals included (we still record USD).
    adaptive_pricing: { enabled: ctx.env.STRIPE_ADAPTIVE_PRICING?.trim() !== '0' },
    ...(flag(ctx, 'STRIPE_PROMO_CODES') ? { allow_promotion_codes: true } : {}),
    // Tax needs an address, and a tax ID needs a name, saved back to our existing customer.
    ...(tax ? { automatic_tax: { enabled: true }, tax_id_collection: { enabled: true }, customer_update: { address: 'auto', name: 'auto' } } : {}),
    // The Terms and the no-refund policy, agreed to before paying, with how to cancel under the button.
    ...(flag(ctx, 'STRIPE_TERMS_CONSENT')
      ? {
          consent_collection: { terms_of_service: 'required' },
          custom_text: {
            terms_of_service_acceptance: {
              message: `I agree to the [Terms](${opts.base}${LEGAL.terms}). My plan renews automatically until I cancel, and payments are non-refundable ([refund policy](${opts.base}${LEGAL.refunds})).`,
            },
            submit: { message: 'Cancel any time from Manage billing in TinyTown. You keep your city until the end of the period you’ve paid for.' },
          },
        }
      : {}),
  };
}

/** A double click inside ten minutes gets the same Checkout page back instead of a second one. */
const CHECKOUT_KEY_WINDOW_MS = 10 * 60_000;

export async function checkout(ctx: Hosted, user: AuthUser, body: Record<string, unknown>): Promise<RedirectResponse> {
  const billing = requireBilling(ctx);
  const interval = body.interval;
  if (interval !== 'month' && interval !== 'year') throw badRequest('Choose "year".');
  // Only the plans configured are on sale: normally just the yearly one.
  if (!billing.prices[interval]) throw badRequest(interval === 'month' ? "There's no monthly plan: TinyTown is paid for by the year." : 'There\'s no yearly plan on sale right now.');
  const base = appUrl(ctx);
  const row = await ctx.db.one<SubscriptionRow>('subscriptions', { user_id: user.id });
  if (row?.comp && hasAccess(row, ctx.now)) throw new HttpError(409, "Your plan is on the house, so there's nothing to pay for.", 'rejected');
  try {
    const existing = await existingPlan(ctx, billing, user, row);
    if (existing) return existing;
    const price = await priceId(ctx, billing, interval);
    const session = async (customer: string) => {
      const params = checkoutParams(ctx, { customer, userId: user.id, price, base });
      const window = Math.floor(ctx.now / CHECKOUT_KEY_WINDOW_MS);
      const idempotencyKey = `tinytown-checkout-${user.id}-${window}-${shortHash(JSON.stringify(params))}`;
      return stripe<StripeSession>(billing.secretKey, 'POST', '/v1/checkout/sessions', params, { idempotencyKey, apiVersion: apiVersion(ctx) });
    };
    const customer = await customerFor(ctx, billing, user, row);
    let created: StripeSession;
    try {
      created = await session(customer);
    } catch (err) {
      // The customer was deleted in the Dashboard: make a new one and try once more.
      if (!(err instanceof StripeError && err.code === 'resource_missing' && err.param === 'customer')) throw err;
      created = await session(await customerFor(ctx, billing, user, row, customer));
    }
    await track(ctx, user.id, 'checkout_started', { interval });
    return { url: created.url };
  } catch (err) {
    throw stripeFailure(err);
  }
}

export async function portal(ctx: Hosted, user: AuthUser): Promise<RedirectResponse> {
  const billing = requireBilling(ctx);
  const row = await ctx.db.one<SubscriptionRow>('subscriptions', { user_id: user.id });
  if (row?.comp) throw new HttpError(409, "Your plan is on the house, so there's nothing to manage.", 'rejected');
  if (!row?.stripe_customer_id) throw badRequest("You don't have a plan to manage yet.");
  const configuration = ctx.env.STRIPE_PORTAL_CONFIGURATION?.trim();
  const params = {
    customer: row.stripe_customer_id,
    return_url: `${appUrl(ctx)}/`,
    ...(configuration && /^bpc_\w+$/.test(configuration) ? { configuration } : {}),
  };
  try {
    const idempotencyKey = `tinytown-portal-${user.id}-${Math.floor(ctx.now / 60_000)}-${shortHash(JSON.stringify(params))}`;
    const session = await stripe<StripeSession>(billing.secretKey, 'POST', '/v1/billing_portal/sessions', params, { idempotencyKey, apiVersion: apiVersion(ctx) });
    return { url: session.url };
  } catch (err) {
    throw stripeFailure(err);
  }
}

// ─── The webhook ──────────────────────────────────────────────────────────

/**
 * Every event the webhook acts on. tools/stripe-setup.mjs subscribes the
 * endpoint to exactly these (a test keeps the two lists equal).
 */
export const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.payment_action_required',
] as const;

interface StripeSubscriptionObject {
  id: string;
  customer: string | { id: string };
  status: string;
  livemode: boolean;
  cancel_at_period_end: boolean;
  cancel_at?: number | null;
  current_period_end?: number;
  cancellation_details?: { reason?: string | null; feedback?: string | null; comment?: string | null } | null;
  latest_invoice?: string | { id: string } | null;
  metadata?: Record<string, string>;
  items: {
    data: {
      current_period_end?: number;
      price: { id: string; lookup_key?: string | null; product?: string | { id: string } | null; metadata?: Record<string, string> | null; recurring: { interval: string } | null };
    }[];
  };
}

type IdOrObject = string | { id: string } | null | undefined;

interface StripeEvent {
  id: string;
  type: string;
  data: {
    object: {
      id: string;
      object?: string;
      mode?: string;
      subscription?: IdOrObject;
      client_reference_id?: string | null;
      // Invoices on API versions from 2025-03-31 name their subscription here instead.
      parent?: { subscription_details?: { subscription?: IdOrObject } | null } | null;
    };
  };
}

const MAX_WEBHOOK_BYTES = 512 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUB_ID = /^sub_\w{1,250}$/;

const idOf = (v: IdOrObject) => (typeof v === 'string' ? v : v?.id);

/** The subscription an event is about, if it's one we act on. */
export function subscriptionOf(event: StripeEvent): { id: string; userHint?: string } | null {
  const obj = event.data?.object;
  if (!obj) return null;
  let id: string | undefined;
  let userHint: string | undefined;
  switch (event.type) {
    case 'checkout.session.completed':
      if (obj.mode !== 'subscription') return null;
      id = idOf(obj.subscription);
      userHint = obj.client_reference_id ?? undefined;
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed':
      id = obj.id;
      break;
    case 'invoice.paid':
    case 'invoice.payment_failed':
    case 'invoice.payment_action_required':
      id = idOf(obj.subscription) ?? idOf(obj.parent?.subscription_details?.subscription);
      break;
    default:
      return null;
  }
  return id && SUB_ID.test(id) ? { id, ...(userHint ? { userHint } : {}) } : null;
}

/**
 * Stripe's webhook. Every event we act on comes down to one subscription,
 * which we re-read from Stripe and record as it is now, so repeats and
 * out-of-order deliveries all land in the same place. It answers as soon as
 * the row is written (one Stripe read and a few database calls). A failure
 * answers 5xx, and Stripe tries again for up to three days.
 */
export async function webhook(ctx: Hosted): Promise<{ received: true }> {
  const billing = requireBilling(ctx);
  if (!billing.webhookSecret) throw notConfigured('The Stripe webhook');
  const raw = new Uint8Array(await ctx.req.arrayBuffer());
  if (raw.byteLength > MAX_WEBHOOK_BYTES) throw new HttpError(413, 'Payload too large', 'bad_request');
  // The signature covers the exact bytes Stripe sent, so check before parsing anything.
  if (!verifyStripeSignature(raw, ctx.req.headers.get('Stripe-Signature'), billing.webhookSecret, ctx.now)) {
    throw badRequest('Bad signature');
  }
  let event: StripeEvent;
  try {
    event = JSON.parse(new TextDecoder().decode(raw)) as StripeEvent;
  } catch {
    throw badRequest('Expected a JSON event.');
  }
  const target = event && typeof event === 'object' ? subscriptionOf(event) : null;
  // Anything else isn't ours to handle; acknowledge so Stripe doesn't retry.
  if (target) await syncSubscription(ctx, billing, target.id, target.userHint);
  return { received: true };
}

/** What a webhook write changed that the founder (or our funnel) should hear about. */
export type PlanChange =
  | { kind: 'started'; interval: PlanInterval | null }
  | { kind: 'payment_failed' }
  | { kind: 'canceled'; endsAt: number | null; feedback: string | null }
  | { kind: 'ended'; reason: string | null; wasScheduled: boolean };

type PlanFields = Pick<SubscriptionRow, 'status' | 'cancel_at_period_end' | 'current_period_end' | 'plan_interval'>;

/** Compares the row before and after a write. Pure, so a repeat of the same state changes nothing. */
export function planChanges(before: PlanFields | null, after: PlanFields, details: { reason?: string | null; feedback?: string | null } = {}): PlanChange[] {
  const wasPaid = !!before && isPaid(planStatus(before.status));
  const nowPaid = isPaid(planStatus(after.status));
  const out: PlanChange[] = [];
  if (!wasPaid && nowPaid) out.push({ kind: 'started', interval: after.plan_interval });
  if (wasPaid && nowPaid && before!.status !== 'past_due' && after.status === 'past_due') out.push({ kind: 'payment_failed' });
  if (nowPaid && after.cancel_at_period_end && !(wasPaid && before!.cancel_at_period_end)) {
    out.push({ kind: 'canceled', endsAt: after.current_period_end ? Date.parse(after.current_period_end) : null, feedback: details.feedback ?? null });
  }
  if (wasPaid && !nowPaid) out.push({ kind: 'ended', reason: details.reason ?? null, wasScheduled: !!before!.cancel_at_period_end });
  return out;
}

/**
 * Records a subscription as Stripe has it *now*. Webhooks can arrive late or
 * out of order, so instead of trusting the event's copy we fetch the
 * current object, which makes every delivery idempotent.
 *
 * Stripe often sends three or four events for one change at the same
 * moment, so the write is a compare-and-set on the fields that decide
 * emails (status and the cancel flag): only the delivery that actually moved
 * the row announces the change, and the others find nothing new.
 */
export async function syncSubscription(ctx: Hosted, billing: Billing, subscriptionId: string, userHint?: string): Promise<void> {
  let sub: StripeSubscriptionObject;
  try {
    sub = await stripe<StripeSubscriptionObject>(billing.secretKey, 'GET', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, undefined, { apiVersion: apiVersion(ctx) });
  } catch (err) {
    // Gone (a deleted test clock, or the other mode's event): nothing to record, and retrying won't help.
    if (err instanceof StripeError && err.status === 404) {
      console.error(`Subscription ${subscriptionId} not found on Stripe; skipped`);
      return;
    }
    throw err;
  }
  const ourItem = () => sub.items?.data?.find((i) => isOurPrice(billing, i.price));
  let ours = ourItem();
  if (!ours) {
    // A plan on a price we no longer sell is recognised by its product, which needs our prices in hand.
    await resolvePrices(ctx, billing).catch(() => null);
    ours = ourItem();
  }
  // Something else sold on the same Stripe account: not a TinyTown plan.
  if (!ours) return;

  const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  let userId = sub.metadata?.user_id ?? userHint;
  if (!userId) userId = (await ctx.db.one<SubscriptionRow>('subscriptions', { stripe_customer_id: customer }))?.user_id;
  if (!userId || !UUID.test(userId)) {
    console.error(`Subscription ${sub.id} has no TinyTown user; skipped`);
    return;
  }

  const interval = ours.price.recurring?.interval;
  let periodEnd = sub.current_period_end ?? ours.current_period_end ?? null;
  // A cancellation set for a date (rather than "at period end") ends access then.
  if (sub.cancel_at && (!periodEnd || sub.cancel_at < periodEnd)) periodEnd = sub.cancel_at;
  const next = {
    user_id: userId,
    stripe_customer_id: customer,
    stripe_subscription_id: sub.id,
    status: sub.status,
    price_id: ours.price.id,
    plan_interval: (interval === 'month' || interval === 'year' ? interval : null) as PlanInterval | null,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    cancel_at_period_end: sub.cancel_at_period_end || !!sub.cancel_at,
    livemode: sub.livemode,
    updated_at: new Date(ctx.now).toISOString(),
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await ctx.db.one<SubscriptionRow>('subscriptions', { user_id: userId });
    // A comped plan has no Stripe subscription to compare against: news about an
    // old or abandoned subscription must not end it. Paying for real replaces it.
    if (existing?.comp && !isPaid(planStatus(next.status))) {
      console.error(`User ${userId} has a comped plan; Stripe subscription ${sub.id} (${sub.status}) not recorded`);
      return;
    }
    if (existing?.stripe_subscription_id && existing.stripe_subscription_id !== sub.id && isPaid(planStatus(existing.status))) {
      // A stale or second subscription must not knock out a live one.
      if (!isPaid(planStatus(next.status))) return;
      // Two live plans for one founder (two Checkouts paid in two tabs): keep the newest news, and tell the owner.
      console.error(`User ${userId} has two live subscriptions (${existing.stripe_subscription_id}, ${sub.id}); cancel and refund one in Stripe`);
    }
    const wrote = existing
      ? (await ctx.db.update('subscriptions', { user_id: userId, status: existing.status, cancel_at_period_end: existing.cancel_at_period_end }, existing.comp ? { ...next, comp: false } : next)).length > 0
      : (await ctx.db.upsert('subscriptions', next, 'user_id', 'ignore')) !== null;
    if (!wrote) {
      // No row and none could be made: the account was deleted (0006 drops writes for missing users). Done, so Stripe stops retrying.
      if (!existing && !(await ctx.db.one<SubscriptionRow>('subscriptions', { user_id: userId }))) return;
      continue; // Another delivery moved the row first; look again.
    }
    await announce(ctx, userId, sub, planChanges(existing, next, sub.cancellation_details ?? {}));
    return;
  }
  throw new Error(`Subscription ${sub.id} kept changing while being recorded`);
}

/**
 * Emails and the funnel. Each email carries a reference to what happened (the
 * subscription, its invoice, its end date), so even a repeat that slipped
 * past the compare-and-set sends once. Both hooks promise not to throw; this
 * guards anyway, since the row is already right.
 */
async function announce(ctx: Hosted, userId: string, sub: StripeSubscriptionObject, changes: PlanChange[]) {
  const livemode = sub.livemode;
  // Cancelled because the founder deleted their account: the goodbye email already covers it.
  const deleted = sub.cancellation_details?.comment === ACCOUNT_DELETED_COMMENT;
  for (const c of changes) {
    try {
      switch (c.kind) {
        case 'started':
          if (c.interval) await notify(ctx, { kind: 'plan.started', userId, interval: c.interval, ref: sub.id });
          await track(ctx, userId, 'plan_started', { interval: c.interval ?? 'unknown', livemode });
          break;
        case 'payment_failed':
          await notify(ctx, { kind: 'plan.payment_failed', userId, ref: idOf(sub.latest_invoice) ?? sub.id });
          break;
        case 'canceled':
          if (!deleted) await notify(ctx, { kind: 'plan.canceled', userId, endsAt: c.endsAt, ref: `${sub.id}:${c.endsAt ?? ''}` });
          await track(ctx, userId, 'plan_canceled', { when: 'period_end', ...(c.feedback ? { feedback: c.feedback } : {}), livemode });
          break;
        case 'ended':
          if (!deleted) await notify(ctx, { kind: 'plan.ended', userId, ref: sub.id });
          // A plan cancelled at period end was counted when it was cancelled.
          if (!c.wasScheduled) await track(ctx, userId, 'plan_canceled', { when: 'now', reason: c.reason ?? 'unknown', livemode });
          break;
      }
    } catch (err) {
      console.error(`Couldn't announce ${c.kind} for ${userId}: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  }
}

// ─── The daily safety net ─────────────────────────────────────────────────

/**
 * Re-reads the plans most likely to be stale if a webhook was ever lost:
 * cancelled plans past their end, cards being retried, and unfinished first
 * payments. Meant for the daily cron. Returns counts for the job's log.
 */
export async function reconcileSubscriptions(ctx: Hosted, limit = 500): Promise<{ checked: number; failed: number }> {
  const billing = ctx.s.billing;
  if (!billing) return { checked: 0, failed: 0 };
  const [ending, pastDue, incomplete] = await Promise.all([
    ctx.db.many<SubscriptionRow>('subscriptions', { status: 'active', cancel_at_period_end: true }),
    ctx.db.many<SubscriptionRow>('subscriptions', { status: 'past_due' }),
    ctx.db.many<SubscriptionRow>('subscriptions', { status: 'incomplete' }),
  ]);
  const ended = ending.filter((r) => r.current_period_end && Date.parse(r.current_period_end) < ctx.now);
  const ids = [...new Set([...ended, ...pastDue, ...incomplete].map((r) => r.stripe_subscription_id).filter((id): id is string => !!id))].slice(0, limit);
  let failed = 0;
  for (const id of ids) {
    try {
      await syncSubscription(ctx, billing, id);
    } catch (err) {
      failed++;
      console.error(`Couldn't reconcile ${id}: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  }
  return { checked: ids.length, failed };
}
