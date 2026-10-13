import { isPaid, type Plan, type PlanInterval, type RedirectResponse } from '../src/api/contract.ts';
import type { Ctx, Hosted } from './context.ts';
import { verifyStripeSignature } from './crypto.ts';
import type { Settings } from './env.ts';
import { HttpError, badRequest, notConfigured } from './http.ts';
import { planStatus, type SubscriptionRow } from './store.ts';
import { stripe, stripeFailure } from './stripe-api.ts';
import type { AuthUser } from './supabase.ts';

/**
 * Our own Stripe account: TinyTown's price ($12 a month or $99 a year, no
 * trial), Checkout, the customer portal, and the webhook that records who
 * has paid. Billing buys access to the hosted game, never game money.
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

// ─── Plans for /api/config ────────────────────────────────────────────────

interface StripePrice {
  id: string;
  unit_amount: number | null;
  currency: string;
  recurring: { interval: string } | null;
}

/** The owner's prices, used only if Stripe can't be reached for the real ones. */
const FALLBACK: Plan[] = [
  { interval: 'month', amount: 1200, currency: 'usd' },
  { interval: 'year', amount: 9900, currency: 'usd' },
];
const PRICE_TTL_MS = 10 * 60_000;
let priceCache: { key: string; until: number; plans: Plan[] } | null = null;

export async function plans(ctx: Ctx): Promise<Plan[]> {
  const billing = ctx.s.billing;
  if (!billing) return [];
  const key = `${billing.prices.month}|${billing.prices.year}`;
  if (priceCache && priceCache.key === key && priceCache.until > ctx.now) return priceCache.plans;
  try {
    const out: Plan[] = [];
    for (const interval of ['month', 'year'] as const) {
      const p = await stripe<StripePrice>(billing.secretKey, 'GET', `/v1/prices/${encodeURIComponent(billing.prices[interval])}`);
      if (p.unit_amount == null || p.recurring?.interval !== interval) throw new Error(`Price for ${interval} isn't a ${interval}ly recurring price`);
      out.push({ interval, amount: p.unit_amount, currency: p.currency });
    }
    priceCache = { key, until: ctx.now + PRICE_TTL_MS, plans: out };
    return out;
  } catch (err) {
    console.error(`Couldn't read prices from Stripe: ${err instanceof Error ? err.message : 'unknown error'}`);
    return FALLBACK;
  }
}

export function resetBillingCaches() {
  priceCache = null;
}

// ─── Checkout and the portal ──────────────────────────────────────────────

interface StripeCustomer {
  id: string;
}
interface StripeSession {
  id: string;
  url: string;
}

/** Our Stripe customer for this user, created the first time and remembered. */
async function customerFor(ctx: Hosted, billing: Billing, user: AuthUser, row: SubscriptionRow | null): Promise<string> {
  if (row?.stripe_customer_id) return row.stripe_customer_id;
  // Idempotent per user, so a double click can't make two customers.
  const customer = await stripe<StripeCustomer>(
    billing.secretKey,
    'POST',
    '/v1/customers',
    { ...(user.email ? { email: user.email } : {}), metadata: { user_id: user.id } },
    `tinytown-customer-${user.id}`,
  );
  await ctx.db.upsert('subscriptions', { user_id: user.id, stripe_customer_id: customer.id, updated_at: new Date(ctx.now).toISOString() }, 'user_id');
  return customer.id;
}

export async function checkout(ctx: Hosted, user: AuthUser, body: Record<string, unknown>): Promise<RedirectResponse> {
  const billing = requireBilling(ctx);
  const interval = body.interval;
  if (interval !== 'month' && interval !== 'year') throw badRequest('Choose "month" or "year".');
  const base = appUrl(ctx);
  const row = await ctx.db.one<SubscriptionRow>('subscriptions', { user_id: user.id });
  // Already paying: send them to manage the plan they have instead of buying a second one.
  if (row && isPaid(planStatus(row.status))) return portal(ctx, user);
  try {
    const customer = await customerFor(ctx, billing, user, row);
    const session = await stripe<StripeSession>(billing.secretKey, 'POST', '/v1/checkout/sessions', {
      mode: 'subscription',
      customer,
      client_reference_id: user.id,
      line_items: [{ price: billing.prices[interval as PlanInterval], quantity: 1 }],
      success_url: `${base}/?checkout=success`,
      cancel_url: `${base}/?checkout=cancel`,
      metadata: { user_id: user.id },
      subscription_data: { metadata: { user_id: user.id } },
    });
    return { url: session.url };
  } catch (err) {
    throw stripeFailure(err);
  }
}

export async function portal(ctx: Hosted, user: AuthUser): Promise<RedirectResponse> {
  const billing = requireBilling(ctx);
  const row = await ctx.db.one<SubscriptionRow>('subscriptions', { user_id: user.id });
  if (!row?.stripe_customer_id) throw badRequest("You don't have a plan to manage yet.");
  try {
    const session = await stripe<StripeSession>(billing.secretKey, 'POST', '/v1/billing_portal/sessions', {
      customer: row.stripe_customer_id,
      return_url: `${appUrl(ctx)}/`,
    });
    return { url: session.url };
  } catch (err) {
    throw stripeFailure(err);
  }
}

// ─── The webhook ──────────────────────────────────────────────────────────

interface StripeSubscriptionObject {
  id: string;
  customer: string | { id: string };
  status: string;
  livemode: boolean;
  cancel_at_period_end: boolean;
  current_period_end?: number;
  metadata?: Record<string, string>;
  items: { data: { current_period_end?: number; price: { id: string; recurring: { interval: string } | null } }[] };
}

interface StripeEvent {
  id: string;
  type: string;
  data: { object: { id: string; mode?: string; subscription?: string | null; client_reference_id?: string | null } };
}

const MAX_WEBHOOK_BYTES = 512 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function webhook(ctx: Hosted): Promise<{ received: true }> {
  const billing = requireBilling(ctx);
  if (!billing.webhookSecret) throw notConfigured('The Stripe webhook');
  const raw = new Uint8Array(await ctx.req.arrayBuffer());
  if (raw.byteLength > MAX_WEBHOOK_BYTES) throw new HttpError(413, 'Payload too large', 'bad_request');
  // The signature covers the exact bytes Stripe sent, so check before parsing anything.
  if (!verifyStripeSignature(raw, ctx.req.headers.get('Stripe-Signature'), billing.webhookSecret, ctx.now)) {
    throw badRequest('Bad signature');
  }
  const event = JSON.parse(new TextDecoder().decode(raw)) as StripeEvent;
  const obj = event.data?.object;
  switch (event.type) {
    case 'checkout.session.completed':
      if (obj.mode === 'subscription' && typeof obj.subscription === 'string') {
        await syncSubscription(ctx, billing, obj.subscription, obj.client_reference_id ?? undefined);
      }
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await syncSubscription(ctx, billing, obj.id);
      break;
    default:
      // Not ours to handle; acknowledge so Stripe doesn't retry.
      break;
  }
  return { received: true };
}

/**
 * Records a subscription as Stripe has it *now*. Webhooks can arrive late or
 * out of order, so instead of trusting the event's copy we fetch the
 * current object, which makes every delivery idempotent.
 */
export async function syncSubscription(ctx: Hosted, billing: Billing, subscriptionId: string, userHint?: string) {
  const sub = await stripe<StripeSubscriptionObject>(billing.secretKey, 'GET', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
  const ours = sub.items.data.find((i) => i.price.id === billing.prices.month || i.price.id === billing.prices.year);
  // Something else sold on the same Stripe account: not a TinyTown plan.
  if (!ours) return;

  const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  let userId = sub.metadata?.user_id ?? userHint;
  if (!userId) userId = (await ctx.db.one<SubscriptionRow>('subscriptions', { stripe_customer_id: customer }))?.user_id;
  if (!userId || !UUID.test(userId)) {
    console.error(`Subscription ${sub.id} has no TinyTown user; skipped`);
    return;
  }

  const existing = await ctx.db.one<SubscriptionRow>('subscriptions', { user_id: userId });
  // A stale or second subscription must not knock out a live one.
  if (existing?.stripe_subscription_id && existing.stripe_subscription_id !== sub.id && isPaid(planStatus(existing.status)) && !isPaid(planStatus(sub.status))) {
    return;
  }
  const periodEnd = sub.current_period_end ?? ours.current_period_end;
  const interval = ours.price.recurring?.interval;
  await ctx.db.upsert(
    'subscriptions',
    {
      user_id: userId,
      stripe_customer_id: customer,
      stripe_subscription_id: sub.id,
      status: sub.status,
      price_id: ours.price.id,
      plan_interval: interval === 'month' || interval === 'year' ? interval : null,
      current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
      cancel_at_period_end: sub.cancel_at_period_end,
      livemode: sub.livemode,
      updated_at: new Date(ctx.now).toISOString(),
    },
    'user_id',
  );
}
