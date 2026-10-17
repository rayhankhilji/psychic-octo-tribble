import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OFFER_WINDOW_MS } from '../src/api/contract.ts';
import { stripeSignatureHeader } from '../server/crypto.ts';
import { firstYearPrice, offerStatus, paidBefore } from '../server/offer.ts';
import { ENV, FakeSupabase, USER, call, form, givePlan, setup, stubFetch, type Call } from './server-helpers.ts';

/**
 * Setup before paying, and the introductory offer: connecting data and the
 * preview are free to any signed-in founder (with their rate limits); the
 * offer ($9 for the first year, then $29) is shown once, open for 48 hours
 * from then, for founders who have never paid, decided by the server alone
 * and applied by Checkout as a one-off coupon; the webhook marks it used.
 */

const track = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../server/analytics.ts', async (original) => ({ ...(await original<object>()), track }));

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 15, 12);
const HOUR = 3_600_000;
const COUPON = 'tinytown_first_year_9';
/** One yearly price at $29, as the owner's account has it, and the offer's coupon. */
const OFFER_ENV = { ...ENV, STRIPE_PRICE_MONTHLY: undefined, STRIPE_OFFER_COUPON: COUPON };
const json = (body: unknown, status = 200) => Response.json(body, { status });

let db: FakeSupabase;
let coupon: Record<string, unknown>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db = setup();
  track.mockClear();
  coupon = { id: COUPON, valid: true, duration: 'once', percent_off: 68.97, amount_off: null, currency: null };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Our Stripe account: the $29 price, the coupon, customers, Checkout, and subscriptions as given. */
function stripe(subs = new Map<string, unknown>()) {
  return (url: URL) => {
    if (url.host !== 'api.stripe.com') return undefined;
    if (url.pathname === '/v1/prices/price_year') return json({ id: 'price_year', unit_amount: 2900, currency: 'usd', recurring: { interval: 'year' }, product: 'prod_tt' });
    if (url.pathname === `/v1/coupons/${COUPON}`) return json(coupon);
    if (url.pathname === '/v1/customers') return json({ id: 'cus_new' });
    if (url.pathname === '/v1/checkout/sessions') return json({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' });
    const m = /^\/v1\/subscriptions\/(\w+)$/.exec(url.pathname);
    if (m && subs.has(m[1]!)) return json(subs.get(m[1]!));
    return undefined;
  };
}

const profile = () => db.row('profiles', { user_id: USER.id })!;
const me = async (env: Record<string, string | undefined> = OFFER_ENV) => (await call('GET', '/api/me', { env })).json();
const seen = async () => call('POST', '/api/billing/offer/seen', { env: OFFER_ENV });
const checkout = (body: unknown, env: Record<string, string | undefined> = OFFER_ENV) => call('POST', '/api/billing/checkout', { body, env });
const sessionParams = (calls: Call[]) => form(calls.find((c) => c.url.pathname === '/v1/checkout/sessions')!.body);
const events = () => track.mock.calls.map((c) => (c as unknown[])[2]);

describe('who can have the offer (pure)', () => {
  const shownAgo = (ms: number) => ({ offer_shown_at: new Date(NOW - ms).toISOString(), offer_used_at: null });
  const fresh = { offer_shown_at: null, offer_used_at: null };
  const sub = (status: string, over: Record<string, unknown> = {}) => ({ status, stripe_subscription_id: 'sub_1', comp: false, ...over });

  it('never shown, shown under 48 hours ago, over 48 hours ago, used', () => {
    expect(offerStatus(fresh, null, NOW)).toBe('unseen');
    expect(offerStatus(shownAgo(47 * HOUR), null, NOW)).toBe('open');
    expect(offerStatus(shownAgo(OFFER_WINDOW_MS), null, NOW)).toBe('expired');
    expect(offerStatus(shownAgo(49 * HOUR), null, NOW)).toBe('expired');
    expect(offerStatus({ ...shownAgo(HOUR), offer_used_at: new Date(NOW).toISOString() }, null, NOW)).toBe('used');
    expect(OFFER_WINDOW_MS).toBe(48 * HOUR);
  });

  it('anyone who has paid before is not eligible; an unfinished first payment never charged, so it does not count', () => {
    for (const s of ['active', 'trialing', 'past_due', 'canceled', 'unpaid', 'paused']) expect(paidBefore(sub(s)), s).toBe(true);
    expect(paidBefore(sub('none', { stripe_subscription_id: null, comp: true, status: 'active' }))).toBe(true);
    for (const s of ['incomplete', 'incomplete_expired']) expect(paidBefore(sub(s)), s).toBe(false);
    expect(paidBefore(sub('none', { stripe_subscription_id: null }))).toBe(false);
    expect(paidBefore(null)).toBe(false);
    expect(offerStatus(fresh, sub('canceled'), NOW)).toBe('ineligible');
  });

  it('the first year is worked out from the coupon Stripe has: a one-off discount that leaves something to pay', () => {
    const year = { interval: 'year' as const, amount: 2900, currency: 'usd' };
    const c = { valid: true, duration: 'once', percent_off: 68.97, amount_off: null, currency: null };
    expect(firstYearPrice(year, c)).toBe(900);
    expect(firstYearPrice(year, { ...c, percent_off: null, amount_off: 2000, currency: 'usd' })).toBe(900);
    // An amount in another currency, a repeating discount, a dead coupon, or one that makes it free: no offer.
    expect(firstYearPrice(year, { ...c, percent_off: null, amount_off: 2000, currency: 'eur' })).toBeNull();
    expect(firstYearPrice(year, { ...c, duration: 'forever' })).toBeNull();
    expect(firstYearPrice(year, { ...c, valid: false })).toBeNull();
    expect(firstYearPrice(year, { ...c, percent_off: 100 })).toBeNull();
    expect(firstYearPrice({ ...year, interval: 'month' }, c)).toBeNull();
  });
});

describe('setup is free', () => {
  it('connecting Stripe, GitHub and the users source needs a sign-in, not a plan', async () => {
    stubFetch(db);
    const stripeLink = await call('POST', '/api/connect/stripe');
    expect(stripeLink.status).toBe(200);
    expect(stripeLink.headers.get('Set-Cookie')).toMatch(/^tt_oauth_stripe=/);
    expect((await call('POST', '/api/connect/github')).status).toBe(200);
    const users = await call('PUT', '/api/connect/users', { body: { source: 'manual', value: 120 } });
    expect(users.status).toBe(200);
    expect(((await users.json()) as { users: unknown }).users).toMatchObject({ source: 'manual', value: 120 });
    // Nothing installed on GitHub yet: refused for that reason, never for the plan.
    expect((await call('GET', '/api/connect/github/repos')).status).not.toBe(402);
    expect((await call('DELETE', '/api/connect/posthog')).status).toBe(200);
    // Signed out is still refused, and the city itself still needs the plan.
    expect((await call('POST', '/api/connect/stripe', { token: null })).status).toBe(401);
    expect((await call('GET', '/api/timeline')).status).toBe(402);
    expect((await call('GET', '/api/world/actions')).status).toBe(402);
  });

  it('keeps the rate limits, so an unpaid account cannot hammer a provider', async () => {
    stubFetch(db);
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await call('POST', '/api/connect/github')).status);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it('connecting Stripe without a plan starts nothing: the back-pay window opens when they pay', async () => {
    stubFetch(db, (url) => (url.href === 'https://api.stripe.com/v1/oauth/token' ? json({ access_token: 'at_1', refresh_token: 'rt_1', livemode: true, stripe_user_id: 'acct_f1', scope: 'stripe_apps', token_type: 'bearer' }) : undefined));
    await call('GET', '/api/me');
    const res = await call('POST', '/api/connect/stripe');
    const { url } = (await res.json()) as { url: string };
    const cookie = res.headers.get('Set-Cookie')!.split(';')[0]!;
    const back = await call('GET', `/api/connect/stripe/callback?code=ac_1&state=${new URL(url).searchParams.get('state')}`, { token: null, headers: { Cookie: cookie } });
    expect(back.headers.get('Location')).toBe('/?connected=stripe');
    expect(db.row('connections', { user_id: USER.id, provider: 'stripe' })).toBeTruthy();
    expect(profile().joined_at).toBeNull();
    const body = await me(ENV);
    expect(body.setup).toEqual({ complete: true });
    expect(body.world.joinedAt).toBeNull();
  });
});

describe('GET /api/preview', () => {
  const timeline = {
    name: 'Your Startup',
    currency: 'usd',
    source: 'live',
    integrations: { stripe: true, github: true },
    snapshots: Array.from({ length: 40 }, (_, i) => ({ t: NOW - (39 - i) * DAY, mrr: 100 + i * 10, customers: 10 + i, users: i > 30 ? 1200 : undefined, releases: Math.floor(i / 4), commits: i * 3, ...(i === 36 ? { release: 'v9' } : {}) })),
  };

  it('answers the headline numbers, never the timeline, without a plan', async () => {
    stubFetch(db);
    await call('GET', '/api/me');
    db.tables.timelines!.push({ user_id: USER.id, timeline, fetched_at: new Date(NOW).toISOString() });
    const res = await call('GET', '/api/preview');
    expect(res.status).toBe(200);
    const p = await res.json();
    expect(p).toMatchObject({ name: 'Your Startup', currency: 'usd', ready: true, days: 40, asOf: NOW - 0 * DAY, users: 1200 });
    expect(p.revenue).toMatchObject({ mrr: 490, customers: 49, since: timeline.snapshots[0]!.t });
    expect(p.shipping).toMatchObject({ releases: 9, latest: { name: 'v9' } });
    expect(p.revenue.spark.length).toBeLessThanOrEqual(48);
    expect(p).not.toHaveProperty('snapshots');
  });

  it('409 before anything is connected, and rate-limited', async () => {
    stubFetch(db);
    const first = await call('GET', '/api/preview');
    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({ code: 'not_connected' });
    const codes: number[] = [];
    for (let i = 0; i < 25; i++) codes.push((await call('GET', '/api/preview')).status);
    expect(codes).toContain(429);
  });
});

describe('the offer on /api/me', () => {
  it('none without the coupon configured, and no Stripe call for it', async () => {
    const calls = stubFetch(db);
    const body = await me(ENV);
    expect(body.offer).toBeNull();
    expect(body.setup).toEqual({ complete: false });
    expect(calls.some((c) => c.url.host === 'api.stripe.com')).toBe(false);
  });

  it('a new founder: $9 for the first year, then $29, not yet shown', async () => {
    stubFetch(db, stripe());
    expect((await me()).offer).toEqual({ status: 'unseen', available: true, expiresAt: null, amount: 900, regular: 2900, currency: 'usd' });
  });

  it('none for a paying founder, a founder who paid before, or a database without migration 0009', async () => {
    stubFetch(db, stripe());
    givePlan(db, 'canceled');
    expect((await me()).offer).toBeNull();
    db.tables.subscriptions = [];
    await me();
    delete profile().offer_shown_at;
    expect((await me()).offer).toBeNull();
  });

  it('none when Stripe will not confirm the coupon (gone or no longer valid)', async () => {
    coupon = { ...coupon, valid: false };
    stubFetch(db, stripe());
    expect((await me()).offer).toBeNull();
  });
});

describe('POST /api/billing/offer/seen', () => {
  it('starts the 48 hours the first time, and never again', async () => {
    stubFetch(db, stripe());
    const first = await (await seen()).json();
    expect(first.offer).toMatchObject({ status: 'open', available: true, expiresAt: NOW + 48 * HOUR, amount: 900 });
    expect(profile().offer_shown_at).toBe(new Date(NOW).toISOString());
    vi.setSystemTime(NOW + 5 * HOUR);
    const again = await (await seen()).json();
    expect(again.offer.expiresAt).toBe(NOW + 48 * HOUR);
    expect(profile().offer_shown_at).toBe(new Date(NOW).toISOString());
    expect(events().filter((e) => e === 'offer_shown')).toHaveLength(1);
    // Two days on, it has ended for good, whatever the browser remembers.
    vi.setSystemTime(NOW + 48 * HOUR + 1);
    expect((await (await seen()).json()).offer).toMatchObject({ status: 'expired', available: false });
    expect((await me()).offer).toMatchObject({ status: 'expired', available: false });
  });

  it('starts nothing for a founder who has paid before', async () => {
    stubFetch(db, stripe());
    givePlan(db, 'canceled');
    expect((await (await seen()).json()).offer).toBeNull();
    expect(profile().offer_shown_at).toBeNull();
  });
});

describe('Checkout with the offer', () => {
  it('applies the coupon once, server-checked, with no promotion code box beside it', async () => {
    const calls = stubFetch(db, stripe());
    await seen();
    const res = await checkout({ interval: 'year', offer: true }, { ...OFFER_ENV, STRIPE_PROMO_CODES: '1' });
    expect(res.status).toBe(200);
    const p = sessionParams(calls);
    expect(p['discounts[0][coupon]']).toBe(COUPON);
    expect(p['subscription_data[metadata][offer]']).toBe(COUPON);
    expect(p['line_items[0][price]']).toBe('price_year');
    expect(p).not.toHaveProperty('allow_promotion_codes');
    expect(events()).toEqual(expect.arrayContaining(['offer_shown', 'checkout_started', 'offer_accepted']));
  });

  it('without the offer, the standard price and no discount', async () => {
    const calls = stubFetch(db, stripe());
    await seen();
    expect((await checkout({ interval: 'year' })).status).toBe(200);
    const p = sessionParams(calls);
    expect(Object.keys(p).some((k) => k.startsWith('discounts'))).toBe(false);
    expect(p).not.toHaveProperty('subscription_data[metadata][offer]');
  });

  it('refused (409) before it was shown, after 48 hours, once used, and for anyone who has paid before', async () => {
    stubFetch(db, stripe());
    const reason = async () => {
      const r = await checkout({ interval: 'year', offer: true });
      return [r.status, ((await r.json()) as { error: string }).error];
    };
    expect(await reason()).toEqual([409, expect.stringMatching(/isn't open yet/)]);
    await seen();
    vi.setSystemTime(NOW + 49 * HOUR);
    expect(await reason()).toEqual([409, expect.stringMatching(/ended 48 hours after/)]);
    vi.setSystemTime(NOW + HOUR);
    profile().offer_used_at = new Date(NOW).toISOString();
    expect(await reason()).toEqual([409, expect.stringMatching(/already had the first-year offer/)]);
    profile().offer_used_at = null;
    db.tables.subscriptions!.push({ user_id: USER.id, stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_old', status: 'canceled', cancel_at_period_end: false, current_period_end: null, plan_interval: 'year', price_id: 'price_year', livemode: true });
    expect(await reason()).toEqual([409, expect.stringMatching(/new founders only/)]);
    // A malformed flag is a bad request, and the offer is only on the yearly plan.
    expect((await checkout({ interval: 'year', offer: 'yes' })).status).toBe(400);
  });
});

describe('the webhook', () => {
  const send = (sub: Record<string, unknown>) => {
    const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'customer.subscription.created', data: { object: { id: sub.id, object: 'subscription' } } });
    const sig = stripeSignatureHeader(payload, ENV.STRIPE_WEBHOOK_SECRET, Math.floor(Date.now() / 1000));
    return call('POST', '/api/billing/webhook', { token: null, body: payload, headers: { 'Stripe-Signature': sig }, env: OFFER_ENV });
  };
  const subscription = (metadata: Record<string, string>) => ({
    id: 'sub_9',
    customer: 'cus_9',
    status: 'active',
    livemode: true,
    cancel_at_period_end: false,
    metadata: { user_id: USER.id, ...metadata },
    items: { data: [{ current_period_end: NOW / 1000 + 365 * 86_400, price: { id: 'price_year', recurring: { interval: 'year' } } }] },
  });

  it('a plan bought with the offer uses it up, opens the city today, and says so in the funnel', async () => {
    stubFetch(db, stripe(new Map([['sub_9', subscription({ offer: COUPON })]])));
    await seen();
    // Stripe was connected days ago, during the free setup.
    db.tables.connections!.push({ user_id: USER.id, provider: 'stripe', account_id: 'acct_f1', metadata: {}, connected_at: new Date(NOW - 3 * DAY).toISOString() });
    expect((await send(subscription({ offer: COUPON }))).status).toBe(200);
    expect(profile().offer_used_at).toBe(new Date(NOW).toISOString());
    expect(profile().joined_at).toBe(Date.UTC(2026, 9, 15));
    expect(track).toHaveBeenCalledWith(expect.anything(), USER.id, 'checkout_completed', { plan: 'year', offer: true, livemode: true });
    expect((await me()).offer).toBeNull();
  });

  it('a plan at the standard price leaves the offer alone', async () => {
    stubFetch(db, stripe(new Map([['sub_9', subscription({})]])));
    await me();
    expect((await send(subscription({}))).status).toBe(200);
    expect(profile().offer_used_at).toBeNull();
    expect(profile().joined_at).toBeNull();
    expect(track).toHaveBeenCalledWith(expect.anything(), USER.id, 'checkout_completed', { plan: 'year', offer: false, livemode: true });
  });
});

describe('POST /api/billing/paywall/seen', () => {
  it('counts the paywall in the funnel, and needs no plan', async () => {
    stubFetch(db);
    expect((await call('POST', '/api/billing/paywall/seen', { body: { teaser: true } })).status).toBe(200);
    expect(track).toHaveBeenCalledWith(expect.anything(), USER.id, 'paywall_shown', { teaser: true });
  });
});
