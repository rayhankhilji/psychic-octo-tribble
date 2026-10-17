import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_DELETED_COMMENT } from '../server/account.ts';
import { hasAccess, planChanges, reconcileSubscriptions, subscriptionOf, WEBHOOK_EVENTS } from '../server/billing.ts';
import { hosted } from '../server/context.ts';
import { stripeSignatureHeader } from '../server/crypto.ts';
import { settings } from '../server/env.ts';
import { setStripeRetryScale, STRIPE_API_VERSION } from '../server/stripe-api.ts';
import { ENV, FakeSupabase, USER, call, form, givePlan, setup, stubFetch, type Call } from './server-helpers.ts';

/**
 * Billing end to end with Stripe mocked: Checkout (idempotency, the owner's
 * optional switches, who gets sent where), the portal, every webhook event
 * we handle and what it does to `subscriptions`, the emails and funnel
 * events it announces (once), out-of-order and concurrent delivery, and the
 * access rules.
 */

const notify = vi.hoisted(() => vi.fn(async () => {}));
const track = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../server/notify.ts', async (original) => ({ ...(await original<object>()), notify }));
vi.mock('../server/analytics.ts', async (original) => ({ ...(await original<object>()), track }));

const json = (body: unknown, status = 200) => Response.json(body, { status });
const header = (c: Call, name: string) => new Headers(c.init.headers).get(name);
const PERIOD_END = 1_900_000_000; // seconds; well after the test clock
const iso = (s: number) => new Date(s * 1000).toISOString();

let db: FakeSupabase;
beforeEach(() => {
  db = setup();
  setStripeRetryScale(0);
  notify.mockClear();
  track.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setStripeRetryScale(1);
});

/** A subscription as Stripe returns it on the pinned API version (period end on the item). */
const subscription = (over: Record<string, unknown> = {}) => ({
  id: 'sub_9',
  object: 'subscription',
  customer: 'cus_9',
  status: 'active',
  livemode: true,
  cancel_at_period_end: false,
  cancel_at: null,
  cancellation_details: { reason: null, feedback: null },
  latest_invoice: 'in_1',
  metadata: { user_id: USER.id },
  items: { data: [{ current_period_end: PERIOD_END, price: { id: 'price_month', lookup_key: 'tinytown_monthly', recurring: { interval: 'month' } } }] },
  ...over,
});

/** Our Stripe account: what each test's subscriptions look like right now. */
function fakeStripe(subs: Map<string, unknown> = new Map()) {
  return (url: URL) => {
    if (url.host !== 'api.stripe.com') return undefined;
    const m = /^\/v1\/subscriptions\/(\w+)$/.exec(url.pathname);
    if (m) return subs.has(m[1]!) ? json(subs.get(m[1]!)) : json({ error: { message: `No such subscription: '${m[1]}'`, type: 'invalid_request_error', code: 'resource_missing' } }, 404);
    if (url.pathname === '/v1/customers') return json({ id: 'cus_new' });
    if (url.pathname === '/v1/checkout/sessions') return json({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' });
    if (url.pathname === '/v1/billing_portal/sessions') return json({ id: 'bps_1', url: 'https://billing.stripe.com/p/session/1' });
    return undefined;
  };
}

const send = (event: unknown) => {
  const payload = JSON.stringify(event);
  const sig = stripeSignatureHeader(payload, ENV.STRIPE_WEBHOOK_SECRET, Math.floor(Date.now() / 1000));
  return call('POST', '/api/billing/webhook', { token: null, body: payload, headers: { 'Stripe-Signature': sig } });
};
let evtN = 0;
const event = (type: string, object: Record<string, unknown>) => ({ id: `evt_${++evtN}`, object: 'event', type, data: { object } });
const subEvent = (type: string, id = 'sub_9') => event(type, { id, object: 'subscription' });

const row = () => db.row('subscriptions', { user_id: USER.id });
const kinds = () => (notify.mock.calls as unknown as [unknown, { kind: string }][]).map(([, e]) => e.kind);
const funnel = () => (track.mock.calls as unknown as [unknown, string, string][]).map(([, , e]) => e);

// ─── Checkout ─────────────────────────────────────────────────────────────

describe('checkout', () => {
  const sessions = (calls: Call[]) => calls.filter((c) => c.url.pathname === '/v1/checkout/sessions');

  it('puts an idempotency key on every POST, and a double click gets the same keys', async () => {
    const calls = stubFetch(db, fakeStripe());
    await call('POST', '/api/billing/checkout', { body: { interval: 'month' } });
    // The customer row exists now, so the second click only makes a session.
    await call('POST', '/api/billing/checkout', { body: { interval: 'month' } });
    const posts = calls.filter((c) => c.url.host === 'api.stripe.com' && c.init.method === 'POST');
    expect(posts.length).toBe(3);
    for (const p of posts) {
      expect(header(p, 'Idempotency-Key')).toMatch(/^tinytown-/);
      expect(header(p, 'Stripe-Version')).toBe(STRIPE_API_VERSION);
    }
    const [a, b] = sessions(calls);
    expect(header(a!, 'Idempotency-Key')).toBe(header(b!, 'Idempotency-Key'));
    expect(header(a!, 'Idempotency-Key')).toContain(USER.id);
    // A different choice is a different intent, so a different key.
    await call('POST', '/api/billing/checkout', { body: { interval: 'year' } });
    expect(header(sessions(calls)[2]!, 'Idempotency-Key')).not.toBe(header(a!, 'Idempotency-Key'));
    expect(funnel()).toEqual(['checkout_started', 'checkout_started', 'checkout_started']);
  });

  it('leaves tax, terms and promotion codes off unless the owner turns them on', async () => {
    const calls = stubFetch(db, fakeStripe());
    await call('POST', '/api/billing/checkout', { body: { interval: 'month' } });
    const off = form(sessions(calls)[0]!.body);
    for (const k of Object.keys(off)) expect(k).not.toMatch(/automatic_tax|tax_id_collection|customer_update|consent_collection|allow_promotion_codes/);

    const env = { ...ENV, STRIPE_AUTOMATIC_TAX: '1', STRIPE_TERMS_CONSENT: '1', STRIPE_PROMO_CODES: '1' };
    await call('POST', '/api/billing/checkout', { body: { interval: 'month' }, env });
    expect(form(sessions(calls)[1]!.body)).toMatchObject({
      'automatic_tax[enabled]': 'true',
      'tax_id_collection[enabled]': 'true',
      'customer_update[address]': 'auto',
      'customer_update[name]': 'auto',
      'consent_collection[terms_of_service]': 'required',
      allow_promotion_codes: 'true',
    });
    // Different settings, different request: the key follows.
    expect(header(sessions(calls)[1]!, 'Idempotency-Key')).not.toBe(header(sessions(calls)[0]!, 'Idempotency-Key'));

    // Each switch works on its own.
    await call('POST', '/api/billing/checkout', { body: { interval: 'month' }, env: { ...ENV, STRIPE_PROMO_CODES: '1' } });
    const promo = form(sessions(calls)[2]!.body);
    expect(promo.allow_promotion_codes).toBe('true');
    expect(promo).not.toHaveProperty('automatic_tax[enabled]');
    expect(promo).not.toHaveProperty('consent_collection[terms_of_service]');
  });

  it('with terms consent on, shows the Terms and the no-refund policy before payment', async () => {
    const calls = stubFetch(db, fakeStripe());
    await call('POST', '/api/billing/checkout', { body: { interval: 'month' }, env: { ...ENV, STRIPE_TERMS_CONSENT: '1' } });
    const body = form(sessions(calls)[0]!.body);
    expect(body['consent_collection[terms_of_service]']).toBe('required');
    expect(body['custom_text[terms_of_service_acceptance][message]']).toBe(
      'I agree to the [Terms](https://tinytown.test/legal/terms.html). My plan renews automatically until I cancel, and payments are non-refundable ([refund policy](https://tinytown.test/legal/refunds.html)).',
    );
    expect(body['custom_text[submit][message]']).toBe('Cancel any time from Manage billing in TinyTown. You keep your city until the end of the period you’ve paid for.');
    // Off by default: no custom text either.
    await call('POST', '/api/billing/checkout', { body: { interval: 'month' } });
    expect(Object.keys(form(sessions(calls)[1]!.body)).some((k) => k.startsWith('custom_text'))).toBe(false);
  });

  it('never offers a trial', async () => {
    const calls = stubFetch(db, fakeStripe());
    await call('POST', '/api/billing/checkout', { body: { interval: 'year' }, env: { ...ENV, STRIPE_AUTOMATIC_TAX: '1', STRIPE_PROMO_CODES: '1' } });
    expect(Object.keys(form(sessions(calls)[0]!.body)).some((k) => k.includes('trial'))).toBe(false);
  });

  it.each(['active', 'trialing', 'past_due', 'unpaid', 'paused'])('sends a founder whose plan is %s to the portal, not a second Checkout', async (status) => {
    const calls = stubFetch(db, fakeStripe());
    givePlan(db, status);
    row()!.current_period_end = iso(PERIOD_END);
    const res = await call('POST', '/api/billing/checkout', { body: { interval: 'year' } });
    expect(await res.json()).toEqual({ url: 'https://billing.stripe.com/p/session/1' });
    expect(sessions(calls)).toHaveLength(0);
  });

  it('lets a plan that ran out (its last webhook lost) buy again', async () => {
    const calls = stubFetch(db, fakeStripe());
    givePlan(db, 'active');
    Object.assign(row()!, { cancel_at_period_end: true, current_period_end: new Date(Date.now() - 3 * 86_400_000).toISOString() });
    expect(await (await call('POST', '/api/billing/checkout', { body: { interval: 'month' } })).json()).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_1' });
    expect(sessions(calls)).toHaveLength(1);
  });

  it('sends an unfinished first payment back to its invoice, and starts afresh once it has expired', async () => {
    const subs = new Map<string, unknown>([['sub_1', { ...subscription({ id: 'sub_1', status: 'incomplete' }), latest_invoice: { id: 'in_1', status: 'open', hosted_invoice_url: 'https://invoice.stripe.com/i/in_1' } }]]);
    const calls = stubFetch(db, fakeStripe(subs));
    givePlan(db, 'incomplete');
    expect(await (await call('POST', '/api/billing/checkout', { body: { interval: 'month' } })).json()).toEqual({ url: 'https://invoice.stripe.com/i/in_1' });
    expect(calls.find((c) => c.url.pathname === '/v1/subscriptions/sub_1')!.url.searchParams.get('expand[0]')).toBe('latest_invoice');
    expect(sessions(calls)).toHaveLength(0);

    subs.set('sub_1', { ...subscription({ id: 'sub_1', status: 'incomplete_expired' }), latest_invoice: { id: 'in_1', status: 'void' } });
    expect(await (await call('POST', '/api/billing/checkout', { body: { interval: 'month' } })).json()).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_1' });
    expect(row()!.status).toBe('incomplete_expired');
  });

  it('makes a new customer once if ours was deleted in the Dashboard', async () => {
    let first = true;
    const calls = stubFetch(db, (url) => {
      if (url.pathname === '/v1/checkout/sessions' && first) {
        first = false;
        return json({ error: { message: "No such customer: 'cus_gone'", type: 'invalid_request_error', code: 'resource_missing', param: 'customer' } }, 400);
      }
      return fakeStripe()(url);
    });
    db.tables.subscriptions!.push({ user_id: USER.id, stripe_customer_id: 'cus_gone', stripe_subscription_id: null, status: 'none', cancel_at_period_end: false });
    expect(await (await call('POST', '/api/billing/checkout', { body: { interval: 'month' } })).json()).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_1' });
    const customer = calls.find((c) => c.url.pathname === '/v1/customers')!;
    expect(header(customer, 'Idempotency-Key')).toBe(`tinytown-customer-${USER.id}-cus_gone`);
    expect(row()!.stripe_customer_id).toBe('cus_new');
    expect(form(sessions(calls)[1]!.body).customer).toBe('cus_new');
  });

  it('retries a keyed POST through a Stripe hiccup with the same key, and gives up readably', async () => {
    let n = 0;
    const calls = stubFetch(db, (url) => {
      if (url.pathname === '/v1/checkout/sessions' && n++ === 0) return json({ error: { message: 'An unknown error occurred', type: 'api_error' } }, 500);
      return fakeStripe()(url);
    });
    expect((await call('POST', '/api/billing/checkout', { body: { interval: 'month' } })).status).toBe(200);
    const [a, b] = sessions(calls);
    expect(header(a!, 'Idempotency-Key')).toBe(header(b!, 'Idempotency-Key'));

    // A card error isn't worth retrying.
    stubFetch(db, (url) => (url.pathname === '/v1/checkout/sessions' ? json({ error: { message: 'Invalid price', type: 'invalid_request_error' } }, 400) : fakeStripe()(url)));
    const res = await call('POST', '/api/billing/checkout', { body: { interval: 'month' } });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Stripe: Invalid price', code: 'upstream' });
  });

  it('accepts lookup keys instead of price ids, for Checkout and the prices on sale', async () => {
    const env = { ...ENV, STRIPE_PRICE_MONTHLY: 'tinytown_monthly', STRIPE_PRICE_YEARLY: 'tinytown_yearly' };
    const calls = stubFetch(db, (url) => {
      if (url.pathname === '/v1/prices') {
        return json({
          data: [
            { id: 'price_m1', lookup_key: 'tinytown_monthly', unit_amount: 1200, currency: 'usd', recurring: { interval: 'month' } },
            { id: 'price_y1', lookup_key: 'tinytown_yearly', unit_amount: 9900, currency: 'usd', recurring: { interval: 'year' } },
          ],
        });
      }
      return fakeStripe()(url);
    });
    await call('POST', '/api/billing/checkout', { body: { interval: 'year' }, env });
    expect(form(sessions(calls)[0]!.body)['line_items[0][price]']).toBe('price_y1');
    const lookup = calls.find((c) => c.url.pathname === '/v1/prices')!;
    expect(lookup.url.searchParams.getAll('lookup_keys[0]')).toEqual(['tinytown_monthly']);
    expect(lookup.url.searchParams.get('lookup_keys[1]')).toBe('tinytown_yearly');

    const config = await (await call('GET', '/api/config', { token: null, env })).json();
    expect(config.plans).toEqual([
      { interval: 'month', amount: 1200, currency: 'usd' },
      { interval: 'year', amount: 9900, currency: 'usd' },
    ]);
    // Cached: one lookup served both.
    expect(calls.filter((c) => c.url.pathname === '/v1/prices')).toHaveLength(1);
  });
});

// ─── Sold by the year ─────────────────────────────────────────────────────

describe('sold by the year', () => {
  // The owner's setup: one yearly price, no STRIPE_PRICE_MONTHLY.
  const { STRIPE_PRICE_MONTHLY: _, ...YEARLY_ONLY } = ENV;
  const sessions = (calls: Call[]) => calls.filter((c) => c.url.pathname === '/v1/checkout/sessions');
  const yearPrice = { id: 'price_year', object: 'price', product: 'prod_tinytown', unit_amount: 2900, currency: 'usd', recurring: { interval: 'year' } };
  const prices = (url: URL) => (url.pathname === '/v1/prices/price_year' ? json(yearPrice) : undefined);
  const sendTo = (e: unknown) => {
    const payload = JSON.stringify(e);
    const sig = stripeSignatureHeader(payload, ENV.STRIPE_WEBHOOK_SECRET, Math.floor(Date.now() / 1000));
    return call('POST', '/api/billing/webhook', { token: null, body: payload, headers: { 'Stripe-Signature': sig }, env: YEARLY_ONLY });
  };

  it('puts one plan on sale: $29 a year, read from Stripe', async () => {
    const calls = stubFetch(db, prices, fakeStripe());
    const config = await (await call('GET', '/api/config', { token: null, env: YEARLY_ONLY })).json();
    expect(config.plans).toEqual([{ interval: 'year', amount: 2900, currency: 'usd' }]);
    // Only the configured price was asked for.
    expect(calls.filter((c) => c.url.pathname.startsWith('/v1/prices')).map((c) => c.url.pathname)).toEqual(['/v1/prices/price_year']);
  });

  it("falls back to the owner's yearly price alone when Stripe can't be reached", async () => {
    stubFetch(db, (url) => (url.pathname.startsWith('/v1/prices') ? json({ error: { message: 'down', type: 'api_error' } }, 500) : undefined), fakeStripe());
    const config = await (await call('GET', '/api/config', { token: null, env: YEARLY_ONLY })).json();
    expect(config.plans).toEqual([{ interval: 'year', amount: 2900, currency: 'usd' }]);
  });

  it('turns a monthly checkout away plainly, before touching Stripe', async () => {
    const calls = stubFetch(db, prices, fakeStripe());
    const res = await call('POST', '/api/billing/checkout', { body: { interval: 'month' }, env: YEARLY_ONLY });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "There's no monthly plan: TinyTown is paid for by the year.", code: 'bad_request' });
    expect(calls.filter((c) => c.url.host === 'api.stripe.com')).toEqual([]);
    expect(funnel()).toEqual([]);
  });

  it('sells the year, with Checkout in local currencies unless the owner turns that off', async () => {
    const calls = stubFetch(db, prices, fakeStripe());
    expect(await (await call('POST', '/api/billing/checkout', { body: { interval: 'year' }, env: YEARLY_ONLY })).json()).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_1' });
    const on = form(sessions(calls)[0]!.body);
    expect(on['line_items[0][price]']).toBe('price_year');
    expect(on['adaptive_pricing[enabled]']).toBe('true');
    expect(Object.keys(on).some((k) => k.includes('trial') || k.startsWith('currency'))).toBe(false);

    await call('POST', '/api/billing/checkout', { body: { interval: 'year' }, env: { ...YEARLY_ONLY, STRIPE_ADAPTIVE_PRICING: '0' } });
    expect(form(sessions(calls)[1]!.body)['adaptive_pricing[enabled]']).toBe('false');
  });

  it('still looks after a founder on the old monthly price: renewals, failures and cancellation', async () => {
    // A price no longer on sale, on the same product as the yearly one.
    const legacy = { id: 'price_old_month', product: 'prod_tinytown', lookup_key: null, recurring: { interval: 'month' } };
    const subs = new Map([['sub_9', subscription({ items: { data: [{ current_period_end: PERIOD_END, price: legacy }] } })]]);
    stubFetch(db, prices, fakeStripe(subs));
    expect((await sendTo(subEvent('customer.subscription.created'))).status).toBe(200);
    expect(row()).toMatchObject({ status: 'active', plan_interval: 'month', price_id: 'price_old_month' });
    subs.set('sub_9', subscription({ status: 'past_due', latest_invoice: 'in_2', items: { data: [{ current_period_end: PERIOD_END, price: legacy }] } }));
    await sendTo(event('invoice.payment_failed', { id: 'in_2', subscription: 'sub_9' }));
    subs.set('sub_9', subscription({ status: 'canceled', items: { data: [{ current_period_end: PERIOD_END, price: legacy }] } }));
    await sendTo(subEvent('customer.subscription.deleted'));
    expect(row()!.status).toBe('canceled');
    expect(kinds()).toEqual(['plan.started', 'plan.payment_failed', 'plan.ended']);
  });

  it('recognises a price tools/stripe-setup.mjs made even without its product in hand, and ignores anything else sold on the account', async () => {
    const tagged = { id: 'price_old_year', product: 'prod_elsewhere', metadata: { tinytown: '1' }, recurring: { interval: 'year' } };
    const other = { id: 'price_mug', product: 'prod_mugs', recurring: { interval: 'year' } };
    const subs = new Map([
      ['sub_9', subscription({ items: { data: [{ current_period_end: PERIOD_END, price: tagged }] } })],
      ['sub_8', subscription({ id: 'sub_8', items: { data: [{ current_period_end: PERIOD_END, price: other }] } })],
    ]);
    stubFetch(db, prices, fakeStripe(subs));
    expect((await sendTo(subEvent('customer.subscription.created', 'sub_8'))).status).toBe(200);
    expect(row()).toBeUndefined();
    expect((await sendTo(subEvent('customer.subscription.created'))).status).toBe(200);
    expect(row()).toMatchObject({ status: 'active', plan_interval: 'year', price_id: 'price_old_year' });
  });
});

describe('portal', () => {
  it('uses the portal configuration from stripe-setup when set, with an idempotency key', async () => {
    const calls = stubFetch(db, fakeStripe());
    givePlan(db);
    await call('POST', '/api/billing/portal', { env: { ...ENV, STRIPE_PORTAL_CONFIGURATION: 'bpc_123' } });
    const p = calls.find((c) => c.url.pathname === '/v1/billing_portal/sessions')!;
    expect(form(p.body)).toEqual({ customer: 'cus_1', return_url: 'https://tinytown.test/', configuration: 'bpc_123' });
    expect(header(p, 'Idempotency-Key')).toMatch(new RegExp(`^tinytown-portal-${USER.id}-`));
  });

  it("400 for someone who hasn't bought anything", async () => {
    stubFetch(db, fakeStripe());
    expect((await call('POST', '/api/billing/portal')).status).toBe(400);
  });
});

// ─── The webhook ──────────────────────────────────────────────────────────

describe('webhook events', () => {
  it('handles exactly the events stripe-setup subscribes to', () => {
    expect([...WEBHOOK_EVENTS].sort()).toEqual(
      [
        'checkout.session.completed',
        'customer.subscription.created',
        'customer.subscription.updated',
        'customer.subscription.deleted',
        'customer.subscription.paused',
        'customer.subscription.resumed',
        'invoice.paid',
        'invoice.payment_failed',
        'invoice.payment_action_required',
      ].sort(),
    );
  });

  it('finds the subscription in each event shape, old and new', () => {
    expect(subscriptionOf(event('checkout.session.completed', { id: 'cs_1', mode: 'subscription', subscription: 'sub_1', client_reference_id: USER.id }) as never)).toEqual({ id: 'sub_1', userHint: USER.id });
    expect(subscriptionOf(event('checkout.session.completed', { id: 'cs_1', mode: 'payment', subscription: null }) as never)).toBeNull();
    for (const t of WEBHOOK_EVENTS.filter((e) => e.startsWith('customer.subscription.'))) expect(subscriptionOf(subEvent(t, 'sub_2') as never)).toEqual({ id: 'sub_2' });
    for (const t of ['invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required']) {
      expect(subscriptionOf(event(t, { id: 'in_1', subscription: 'sub_3' }) as never)).toEqual({ id: 'sub_3' });
      expect(subscriptionOf(event(t, { id: 'in_1', parent: { subscription_details: { subscription: 'sub_4' } } }) as never)).toEqual({ id: 'sub_4' });
    }
    // A one-off invoice, an unknown event, a malformed id.
    expect(subscriptionOf(event('invoice.paid', { id: 'in_1', parent: null }) as never)).toBeNull();
    expect(subscriptionOf(event('charge.refunded', { id: 'ch_1' }) as never)).toBeNull();
    expect(subscriptionOf(subEvent('customer.subscription.updated', '../../v1/customers') as never)).toBeNull();
  });

  it('checkout.session.completed records the plan and announces it once', async () => {
    stubFetch(db, fakeStripe(new Map([['sub_9', subscription()]])));
    expect((await send(event('checkout.session.completed', { id: 'cs_1', mode: 'subscription', subscription: 'sub_9', client_reference_id: USER.id }))).status).toBe(200);
    expect(row()).toMatchObject({ stripe_subscription_id: 'sub_9', status: 'active', plan_interval: 'month', current_period_end: iso(PERIOD_END), livemode: true });
    expect(notify).toHaveBeenCalledWith(expect.anything(), { kind: 'plan.started', userId: USER.id, interval: 'month', ref: 'sub_9' });
    expect(track).toHaveBeenCalledWith(expect.anything(), USER.id, 'plan_started', { interval: 'month', livemode: true });
    // Redelivered: nothing new.
    await send(event('checkout.session.completed', { id: 'cs_1', mode: 'subscription', subscription: 'sub_9', client_reference_id: USER.id }));
    expect(kinds()).toEqual(['plan.started']);
  });

  it('the burst Stripe sends after Checkout (four events at once) announces the plan once', async () => {
    stubFetch(db, fakeStripe(new Map([['sub_9', subscription()]])));
    const res = await Promise.all([
      send(event('checkout.session.completed', { id: 'cs_1', mode: 'subscription', subscription: 'sub_9', client_reference_id: USER.id })),
      send(subEvent('customer.subscription.created')),
      send(subEvent('customer.subscription.updated')),
      send(event('invoice.paid', { id: 'in_1', parent: { subscription_details: { subscription: 'sub_9' } } })),
    ]);
    expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(row()).toMatchObject({ status: 'active', stripe_subscription_id: 'sub_9' });
    expect(kinds()).toEqual(['plan.started']);
    expect(funnel()).toEqual(['plan_started', 'checkout_completed']);
  });

  it('invoice.payment_failed and payment_action_required: past_due keeps access and warns once', async () => {
    const subs = new Map([['sub_9', subscription()]]);
    stubFetch(db, fakeStripe(subs));
    await send(subEvent('customer.subscription.created'));
    subs.set('sub_9', subscription({ status: 'past_due', latest_invoice: 'in_2' }));
    await send(event('invoice.payment_failed', { id: 'in_2', subscription: 'sub_9' }));
    await send(event('invoice.payment_action_required', { id: 'in_2', subscription: 'sub_9' }));
    await send(subEvent('customer.subscription.updated'));
    expect(row()!.status).toBe('past_due');
    expect(kinds()).toEqual(['plan.started', 'plan.payment_failed']);
    expect(notify).toHaveBeenLastCalledWith(expect.anything(), { kind: 'plan.payment_failed', userId: USER.id, ref: 'in_2' });
    expect((await call('GET', '/api/me')).status).toBe(200);
    expect((await call('GET', '/api/world/actions')).status).toBe(200);

    // The retry works: invoice.paid brings it back, with no second welcome.
    subs.set('sub_9', subscription({ status: 'active', items: { data: [{ current_period_end: PERIOD_END + 2_592_000, price: { id: 'price_month', recurring: { interval: 'month' } } }] } }));
    await send(event('invoice.paid', { id: 'in_2', subscription: 'sub_9' }));
    expect(row()).toMatchObject({ status: 'active', current_period_end: iso(PERIOD_END + 2_592_000) });
    expect(kinds()).toEqual(['plan.started', 'plan.payment_failed']);
  });

  it('customer.subscription.updated with cancel at period end keeps access, then deleted ends it', async () => {
    const subs = new Map([['sub_9', subscription()]]);
    stubFetch(db, fakeStripe(subs));
    await send(subEvent('customer.subscription.created'));
    subs.set('sub_9', subscription({ cancel_at_period_end: true, cancellation_details: { reason: 'cancellation_requested', feedback: 'too_expensive' } }));
    await send(subEvent('customer.subscription.updated'));
    expect(row()).toMatchObject({ status: 'active', cancel_at_period_end: true });
    expect(notify).toHaveBeenLastCalledWith(expect.anything(), { kind: 'plan.canceled', userId: USER.id, endsAt: PERIOD_END * 1000, ref: `sub_9:${PERIOD_END * 1000}` });
    expect(track).toHaveBeenLastCalledWith(expect.anything(), USER.id, 'plan_canceled', { when: 'period_end', feedback: 'too_expensive', livemode: true });
    expect((await call('GET', '/api/world/actions')).status).toBe(200);

    subs.set('sub_9', subscription({ status: 'canceled', cancel_at_period_end: true }));
    await send(subEvent('customer.subscription.deleted'));
    expect(row()!.status).toBe('canceled');
    expect(kinds()).toEqual(['plan.started', 'plan.canceled', 'plan.ended']);
    // The cancellation was counted when it was made, not again at the end.
    expect(funnel()).toEqual(['plan_started', 'checkout_completed', 'plan_canceled']);
    expect((await call('GET', '/api/world/actions')).status).toBe(402);
  });

  it('a cancellation set for a date counts as cancelling, and ends access then', async () => {
    const cancelAt = PERIOD_END - 86_400;
    stubFetch(db, fakeStripe(new Map([['sub_9', subscription({ cancel_at: cancelAt })]])));
    await send(subEvent('customer.subscription.updated'));
    expect(row()).toMatchObject({ cancel_at_period_end: true, current_period_end: iso(cancelAt) });
    expect(kinds()).toEqual(['plan.started', 'plan.canceled']);
  });

  it('an immediate cancellation (or failed dunning) ends the plan and counts as a cancellation', async () => {
    const subs = new Map([['sub_9', subscription()]]);
    stubFetch(db, fakeStripe(subs));
    await send(subEvent('customer.subscription.created'));
    subs.set('sub_9', subscription({ status: 'canceled', cancellation_details: { reason: 'payment_failed', feedback: null } }));
    await send(subEvent('customer.subscription.deleted'));
    expect(kinds()).toEqual(['plan.started', 'plan.ended']);
    expect(track).toHaveBeenLastCalledWith(expect.anything(), USER.id, 'plan_canceled', { when: 'now', reason: 'payment_failed', livemode: true });
  });

  it('paused and resumed: access follows the status', async () => {
    const subs = new Map([['sub_9', subscription()]]);
    stubFetch(db, fakeStripe(subs));
    await send(subEvent('customer.subscription.created'));
    subs.set('sub_9', subscription({ status: 'paused' }));
    await send(subEvent('customer.subscription.paused'));
    expect(row()!.status).toBe('paused');
    expect((await call('GET', '/api/world/actions')).status).toBe(402);
    subs.set('sub_9', subscription({ status: 'active' }));
    await send(subEvent('customer.subscription.resumed'));
    expect(row()!.status).toBe('active');
    expect(kinds()).toEqual(['plan.started', 'plan.ended', 'plan.started']);
  });

  it('out-of-order delivery: a late "created" after "deleted" still records the plan as ended', async () => {
    // Stripe's truth now: cancelled. The events arrive newest first.
    stubFetch(db, fakeStripe(new Map([['sub_9', subscription({ status: 'canceled' })]])));
    await send(subEvent('customer.subscription.deleted'));
    await send(subEvent('customer.subscription.updated'));
    await send(subEvent('customer.subscription.created'));
    expect(row()!.status).toBe('canceled');
    // Never paid as far as we saw, so nothing to announce.
    expect(kinds()).toEqual([]);
  });

  it('incomplete first payments have no access; incomplete_expired neither', async () => {
    const subs = new Map([['sub_9', subscription({ status: 'incomplete' })]]);
    stubFetch(db, fakeStripe(subs));
    await send(subEvent('customer.subscription.created'));
    expect(row()!.status).toBe('incomplete');
    expect((await call('GET', '/api/world/actions')).status).toBe(402);
    expect((await (await call('GET', '/api/me')).json()).plan.status).toBe('incomplete');
    subs.set('sub_9', subscription({ status: 'incomplete_expired' }));
    await send(subEvent('customer.subscription.deleted'));
    expect((await (await call('GET', '/api/me')).json()).plan.status).toBe('canceled');
    expect(kinds()).toEqual([]);
  });

  it('acknowledges unknown events and missing subscriptions; a Stripe outage asks for a retry', async () => {
    const calls = stubFetch(db, fakeStripe());
    expect((await send(event('charge.refunded', { id: 'ch_1' }))).status).toBe(200);
    expect(calls.some((c) => c.url.host === 'api.stripe.com')).toBe(false);
    expect((await send(subEvent('customer.subscription.updated', 'sub_gone'))).status).toBe(200);
    expect(row()).toBeUndefined();

    stubFetch(db, () => json({ error: { message: 'down', type: 'api_error' } }, 503));
    expect((await send(subEvent('customer.subscription.updated'))).status).toBe(500);
  });

  it("a deleted founder's subscription is acknowledged without a row, so Stripe stops retrying", async () => {
    // Migration 0006 drops writes for users who are no longer in auth.users: the insert comes back empty.
    const handle = db.handle.bind(db);
    db.handle = async (url, init) => (url.pathname === '/rest/v1/subscriptions' && init.method === 'POST' ? Response.json([]) : handle(url, init));
    const calls = stubFetch(db, fakeStripe(new Map([['sub_9', subscription({ status: 'canceled' })]])));
    expect((await send(subEvent('customer.subscription.deleted'))).status).toBe(200);
    expect(row()).toBeUndefined();
    expect(calls.filter((c) => c.url.pathname === '/rest/v1/subscriptions' && c.init.method === 'POST')).toHaveLength(1);
    expect(kinds()).toEqual([]);
  });

  it('a plan cancelled by account deletion sends no plan emails (the goodbye covers it)', async () => {
    const subs = new Map([['sub_9', subscription()]]);
    stubFetch(db, fakeStripe(subs));
    await send(subEvent('customer.subscription.created'));
    subs.set('sub_9', subscription({ status: 'canceled', cancellation_details: { reason: 'cancellation_requested', feedback: null, comment: ACCOUNT_DELETED_COMMENT } }));
    await send(subEvent('customer.subscription.deleted'));
    expect(row()!.status).toBe('canceled');
    expect(kinds()).toEqual(['plan.started']);

    // The same goes for a cancel-at-period-end carrying the comment.
    db.tables.subscriptions = [];
    notify.mockClear();
    subs.set('sub_9', subscription({ cancel_at_period_end: true, cancellation_details: { reason: 'cancellation_requested', feedback: null, comment: ACCOUNT_DELETED_COMMENT } }));
    await send(subEvent('customer.subscription.updated'));
    expect(kinds()).toEqual(['plan.started']);
  });

  it('rejects a signed body that is not JSON', async () => {
    stubFetch(db, fakeStripe());
    const payload = 'not json';
    const sig = stripeSignatureHeader(payload, ENV.STRIPE_WEBHOOK_SECRET, Math.floor(Date.now() / 1000));
    expect((await call('POST', '/api/billing/webhook', { token: null, body: payload, headers: { 'Stripe-Signature': sig } })).status).toBe(400);
  });
});

// ─── Access ───────────────────────────────────────────────────────────────

describe('access rules', () => {
  const now = Date.UTC(2026, 9, 13);
  const r = (status: string, over: Partial<{ cancel_at_period_end: boolean; current_period_end: string | null }> = {}) => ({
    status,
    cancel_at_period_end: false,
    current_period_end: new Date(now + 10 * 86_400_000).toISOString(),
    ...over,
  });

  it('paid statuses open the game; the rest do not', () => {
    for (const s of ['active', 'trialing', 'past_due']) expect(hasAccess(r(s), now)).toBe(true);
    for (const s of ['unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'paused', 'none', 'something_new']) expect(hasAccess(r(s), now)).toBe(false);
    expect(hasAccess(null, now)).toBe(false);
  });

  it('a plan cancelled at period end keeps access until the period ends (plus an hour for clocks)', () => {
    const end = now + 1000;
    const cancelling = r('active', { cancel_at_period_end: true, current_period_end: new Date(end).toISOString() });
    expect(hasAccess(cancelling, now)).toBe(true);
    expect(hasAccess(cancelling, end + 30 * 60_000)).toBe(true);
    expect(hasAccess(cancelling, end + 2 * 60 * 60_000)).toBe(false);
    // A renewing plan whose renewal webhook is late keeps access.
    expect(hasAccess(r('active', { current_period_end: new Date(end).toISOString() }), end + 3 * 86_400_000)).toBe(true);
  });

  it('plan changes come from the status and the cancel flag, and a repeat changes nothing', () => {
    const before = { status: 'active', cancel_at_period_end: false, current_period_end: null, plan_interval: 'month' as const };
    expect(planChanges(before, before)).toEqual([]);
    expect(planChanges(null, before)).toEqual([{ kind: 'started', interval: 'month' }]);
    expect(planChanges({ ...before, status: 'canceled' }, before)).toEqual([{ kind: 'started', interval: 'month' }]);
    expect(planChanges(before, { ...before, status: 'past_due' })).toEqual([{ kind: 'payment_failed' }]);
    expect(planChanges({ ...before, status: 'past_due' }, { ...before, status: 'past_due' })).toEqual([]);
    expect(planChanges(before, { ...before, status: 'unpaid' })).toEqual([{ kind: 'ended', reason: null, wasScheduled: false }]);
    expect(planChanges(null, { ...before, status: 'incomplete' })).toEqual([]);
  });
});

// ─── The daily safety net ─────────────────────────────────────────────────

describe('reconcileSubscriptions', () => {
  it('re-reads plans past their cancelled end, past due and unfinished, and nothing else', async () => {
    const day = 86_400_000;
    const users = ['6f1c2b7e-0000-4000-8000-00000000000a', '6f1c2b7e-0000-4000-8000-00000000000b', '6f1c2b7e-0000-4000-8000-00000000000c', '6f1c2b7e-0000-4000-8000-00000000000d'];
    const base = { stripe_customer_id: null, price_id: 'price_month', plan_interval: 'month', livemode: true };
    db.tables.subscriptions!.push(
      { ...base, user_id: users[0], stripe_subscription_id: 'sub_a', status: 'active', cancel_at_period_end: true, current_period_end: new Date(Date.now() - day).toISOString() },
      { ...base, user_id: users[1], stripe_subscription_id: 'sub_b', status: 'past_due', cancel_at_period_end: false, current_period_end: new Date(Date.now() + day).toISOString() },
      { ...base, user_id: users[2], stripe_subscription_id: 'sub_c', status: 'active', cancel_at_period_end: true, current_period_end: new Date(Date.now() + day).toISOString() },
      { ...base, user_id: users[3], stripe_subscription_id: 'sub_d', status: 'active', cancel_at_period_end: false, current_period_end: new Date(Date.now() + day).toISOString() },
    );
    const subs = new Map<string, unknown>([
      ['sub_a', subscription({ id: 'sub_a', status: 'canceled', cancel_at_period_end: true, metadata: { user_id: users[0] } })],
      ['sub_b', subscription({ id: 'sub_b', status: 'unpaid', metadata: { user_id: users[1] } })],
    ]);
    const calls = stubFetch(db, fakeStripe(subs));
    const ctx = hosted({ req: new Request('https://tinytown.test/api/cron/daily'), url: new URL('https://tinytown.test/api/cron/daily'), env: ENV, s: settings(ENV), now: Date.now() });
    expect(await reconcileSubscriptions(ctx)).toEqual({ checked: 2, failed: 0 });
    expect(db.row('subscriptions', { user_id: users[0] })!.status).toBe('canceled');
    expect(db.row('subscriptions', { user_id: users[1] })!.status).toBe('unpaid');
    expect(calls.filter((c) => c.url.host === 'api.stripe.com').map((c) => c.url.pathname).sort()).toEqual(['/v1/subscriptions/sub_a', '/v1/subscriptions/sub_b']);
    expect(kinds()).toEqual(['plan.ended', 'plan.ended']);
  });
});
