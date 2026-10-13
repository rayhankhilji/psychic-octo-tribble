import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripeSignatureHeader } from '../server/crypto.ts';
import { ENV, FakeSupabase, USER, call, form, givePlan, setup, stubFetch } from './server-helpers.ts';

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** Our Stripe account's prices, for /api/config. */
const prices = (url: URL) => {
  if (url.host !== 'api.stripe.com' || !url.pathname.startsWith('/v1/prices/')) return undefined;
  const year = url.pathname.endsWith('price_year');
  return json({ id: year ? 'price_year' : 'price_month', unit_amount: year ? 9900 : 1200, currency: 'usd', recurring: { interval: year ? 'year' : 'month' } });
};

let db: FakeSupabase;
beforeEach(() => {
  db = setup();
});
afterEach(() => vi.unstubAllGlobals());

describe('/api/config', () => {
  it('says hosted: false without Supabase, and serves no plans or keys', async () => {
    stubFetch(db);
    const res = await call('GET', '/api/config', { env: {} });
    expect(await res.json()).toEqual({ hosted: false, supabase: null, plans: [], connect: { stripe: false, github: false, posthog: false } });
  });

  it('exposes only the Supabase URL and anon key, plus prices read from Stripe', async () => {
    stubFetch(db, prices);
    const res = await call('GET', '/api/config', { token: null });
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      hosted: true,
      supabase: { url: ENV.SUPABASE_URL, anonKey: 'anon' },
      plans: [
        { interval: 'month', amount: 1200, currency: 'usd' },
        { interval: 'year', amount: 9900, currency: 'usd' },
      ],
      connect: { stripe: true, github: true, posthog: true },
    });
    for (const secret of [ENV.SUPABASE_SERVICE_ROLE_KEY, ENV.STRIPE_BILLING_SECRET_KEY, ENV.STATE_SECRET, ENV.TOKEN_ENCRYPTION_KEY, ENV.GITHUB_APP_CLIENT_SECRET, 'whsec_test']) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('auth gates', () => {
  it('503 for account routes in local mode', async () => {
    stubFetch(db);
    const res = await call('GET', '/api/me', { env: {} });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'not_configured' });
  });

  it('401 without a token or with one Supabase rejects', async () => {
    stubFetch(db);
    expect((await call('GET', '/api/me', { token: null })).status).toBe(401);
    const res = await call('GET', '/api/me', { token: 'forged' });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'unauthenticated' });
  });

  it('402 on data routes without a paid plan, but /api/me works', async () => {
    stubFetch(db);
    for (const [method, path] of [
      ['GET', '/api/timeline'],
      ['GET', '/api/world/actions'],
      ['POST', '/api/world/actions'],
      ['PATCH', '/api/world'],
      ['POST', '/api/connect/stripe'],
      ['PUT', '/api/connect/users'],
      ['DELETE', '/api/connect/github'],
    ] as const) {
      const res = await call(method, path, { body: method === 'GET' || method === 'DELETE' ? undefined : {} });
      expect(res.status, `${method} ${path}`).toBe(402);
      expect(await res.json()).toMatchObject({ code: 'payment_required' });
    }
    givePlan(db, 'canceled');
    expect((await call('GET', '/api/timeline')).status).toBe(402);
    expect((await call('GET', '/api/me')).status).toBe(200);
  });

  it('caches a sign-in briefly instead of asking Supabase on every call', async () => {
    stubFetch(db);
    await call('GET', '/api/me');
    await call('GET', '/api/me');
    expect(db.authCalls).toBe(1);
  });

  it('404 for unknown API paths and 405 for wrong methods', async () => {
    stubFetch(db);
    expect((await call('GET', '/api/nope')).status).toBe(404);
    expect((await call('DELETE', '/api/me')).status).toBe(405);
  });
});

describe('/api/me', () => {
  it('creates the profile with a world seed on first sight, and reports no plan', async () => {
    stubFetch(db);
    const res = await call('GET', '/api/me');
    const me = await res.json();
    expect(me).toMatchObject({
      user: { id: USER.id, email: USER.email },
      plan: { status: 'none', interval: null, renewsAt: null, cancelAtPeriodEnd: false },
      connections: { stripe: null, github: null, users: { source: 'customers' } },
      world: { name: 'Your Startup', joinedAt: null, lastSeen: null },
    });
    expect(me.world.seed).toBeGreaterThanOrEqual(1);
    expect(me.world.seed).toBeLessThan(2 ** 31);
    expect(db.tables.profiles).toHaveLength(1);
    await call('GET', '/api/me');
    expect(db.tables.profiles).toHaveLength(1);
  });

  it('PATCH /api/world cleans the name and checks lastSeen', async () => {
    stubFetch(db);
    givePlan(db);
    const ok = await call('PATCH', '/api/world', { body: { name: '  Acme‮  Labs\n', lastSeen: Date.UTC(2026, 9, 12) } });
    expect(await ok.json()).toMatchObject({ name: 'Acme Labs', lastSeen: Date.UTC(2026, 9, 12) });
    expect((await call('PATCH', '/api/world', { body: { name: '' } })).status).toBe(400);
    expect((await call('PATCH', '/api/world', { body: { name: 'x'.repeat(41) } })).status).toBe(400);
    expect((await call('PATCH', '/api/world', { body: { lastSeen: 'yesterday' } })).status).toBe(400);
    expect((await call('PATCH', '/api/world', { body: 'not json' })).status).toBe(400);
  });
});

describe('billing', () => {
  const stripeRoutes = (url: URL) => {
    if (url.host !== 'api.stripe.com') return undefined;
    if (url.pathname === '/v1/customers') return json({ id: 'cus_new' });
    if (url.pathname === '/v1/checkout/sessions') return json({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' });
    if (url.pathname === '/v1/billing_portal/sessions') return json({ id: 'bps_1', url: 'https://billing.stripe.com/p/session/1' });
    return undefined;
  };

  it('creates our customer once and a subscription Checkout Session for the chosen price', async () => {
    const calls = stubFetch(db, stripeRoutes);
    const res = await call('POST', '/api/billing/checkout', { body: { interval: 'year' } });
    expect(await res.json()).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_1' });

    const customer = calls.find((c) => c.url.pathname === '/v1/customers')!;
    expect(new Headers(customer.init.headers).get('Authorization')).toBe(`Bearer ${ENV.STRIPE_BILLING_SECRET_KEY}`);
    expect(new Headers(customer.init.headers).get('Idempotency-Key')).toBe(`tinytown-customer-${USER.id}`);
    expect(form(customer.body)).toEqual({ email: USER.email, 'metadata[user_id]': USER.id });

    const session = calls.find((c) => c.url.pathname === '/v1/checkout/sessions')!;
    expect(session.init.method).toBe('POST');
    expect(form(session.body)).toEqual({
      mode: 'subscription',
      customer: 'cus_new',
      client_reference_id: USER.id,
      'line_items[0][price]': 'price_year',
      'line_items[0][quantity]': '1',
      success_url: 'https://tinytown.test/?checkout=success',
      cancel_url: 'https://tinytown.test/?checkout=cancel',
      'metadata[user_id]': USER.id,
      'subscription_data[metadata][user_id]': USER.id,
    });
    expect(form(session.body)).not.toHaveProperty('subscription_data[trial_period_days]');
    expect(db.row('subscriptions', { user_id: USER.id })).toMatchObject({ stripe_customer_id: 'cus_new', status: 'none' });

    // A second checkout reuses the customer.
    await call('POST', '/api/billing/checkout', { body: { interval: 'month' } });
    expect(calls.filter((c) => c.url.pathname === '/v1/customers')).toHaveLength(1);
    expect(form(calls.filter((c) => c.url.pathname === '/v1/checkout/sessions')[1]!.body)['line_items[0][price]']).toBe('price_month');
  });

  it('rejects a bad interval, and sends paying founders to the portal instead of a second plan', async () => {
    const calls = stubFetch(db, stripeRoutes);
    expect((await call('POST', '/api/billing/checkout', { body: { interval: 'week' } })).status).toBe(400);
    givePlan(db);
    const res = await call('POST', '/api/billing/checkout', { body: { interval: 'month' } });
    expect(await res.json()).toEqual({ url: 'https://billing.stripe.com/p/session/1' });
    expect(calls.some((c) => c.url.pathname === '/v1/checkout/sessions')).toBe(false);
    expect(form(calls.find((c) => c.url.pathname === '/v1/billing_portal/sessions')!.body)).toEqual({ customer: 'cus_1', return_url: 'https://tinytown.test/' });
  });

  it('503 when billing is not configured', async () => {
    stubFetch(db);
    const res = await call('POST', '/api/billing/checkout', { body: { interval: 'month' }, env: { ...ENV, STRIPE_BILLING_SECRET_KEY: '' } });
    expect(res.status).toBe(503);
  });
});

describe('Stripe webhook', () => {
  const subscription = (over: Record<string, unknown> = {}) => ({
    id: 'sub_9',
    customer: 'cus_9',
    status: 'active',
    livemode: false,
    cancel_at_period_end: false,
    metadata: { user_id: USER.id },
    items: { data: [{ current_period_end: 1_800_000_000, price: { id: 'price_month', recurring: { interval: 'month' } } }] },
    ...over,
  });

  const send = (event: unknown, opts: { secret?: string; t?: number } = {}) => {
    const payload = JSON.stringify(event);
    const sig = stripeSignatureHeader(payload, opts.secret ?? ENV.STRIPE_WEBHOOK_SECRET, opts.t ?? Math.floor(Date.now() / 1000));
    return call('POST', '/api/billing/webhook', { token: null, body: payload, headers: { 'Stripe-Signature': sig } });
  };

  it('records the subscription as Stripe has it now when checkout completes', async () => {
    const calls = stubFetch(db, (url) => (url.pathname === '/v1/subscriptions/sub_9' ? json(subscription()) : undefined));
    const res = await send({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1', mode: 'subscription', subscription: 'sub_9', client_reference_id: USER.id } } });
    expect(res.status).toBe(200);
    expect(calls.find((c) => c.url.pathname === '/v1/subscriptions/sub_9')!.init.method ?? 'GET').toBe('GET');
    expect(db.row('subscriptions', { user_id: USER.id })).toMatchObject({
      stripe_customer_id: 'cus_9',
      stripe_subscription_id: 'sub_9',
      status: 'active',
      price_id: 'price_month',
      plan_interval: 'month',
      current_period_end: new Date(1_800_000_000_000).toISOString(),
      cancel_at_period_end: false,
    });
    // And the founder now has a plan.
    const me = await (await call('GET', '/api/me')).json();
    expect(me.plan).toEqual({ status: 'active', interval: 'month', renewsAt: 1_800_000_000_000, cancelAtPeriodEnd: false });
  });

  it('updates on customer.subscription.updated/deleted, finding the user by customer when metadata is missing', async () => {
    givePlan(db);
    db.row('subscriptions', { user_id: USER.id })!.stripe_customer_id = 'cus_9';
    let current = subscription({ metadata: {}, cancel_at_period_end: true });
    stubFetch(db, (url) => (url.pathname === '/v1/subscriptions/sub_9' ? json(current) : undefined));
    await send({ id: 'evt_2', type: 'customer.subscription.updated', data: { object: { id: 'sub_9' } } });
    expect(db.row('subscriptions', { user_id: USER.id })).toMatchObject({ stripe_subscription_id: 'sub_9', cancel_at_period_end: true, status: 'active' });
    current = subscription({ metadata: {}, status: 'canceled' });
    await send({ id: 'evt_3', type: 'customer.subscription.deleted', data: { object: { id: 'sub_9' } } });
    expect(db.row('subscriptions', { user_id: USER.id })).toMatchObject({ status: 'canceled' });
    expect((await call('GET', '/api/timeline')).status).toBe(402);
  });

  it("ignores subscriptions that aren't TinyTown plans, and a stale one can't cancel a live one", async () => {
    givePlan(db);
    stubFetch(db, (url) =>
      url.pathname === '/v1/subscriptions/sub_other'
        ? json(subscription({ id: 'sub_other', items: { data: [{ price: { id: 'price_something_else', recurring: { interval: 'month' } } }] } }))
        : url.pathname === '/v1/subscriptions/sub_old'
          ? json(subscription({ id: 'sub_old', status: 'canceled' }))
          : undefined,
    );
    await send({ id: 'evt_4', type: 'customer.subscription.created', data: { object: { id: 'sub_other' } } });
    await send({ id: 'evt_5', type: 'customer.subscription.deleted', data: { object: { id: 'sub_old' } } });
    expect(db.row('subscriptions', { user_id: USER.id })).toMatchObject({ stripe_subscription_id: 'sub_1', status: 'active' });
  });

  it('rejects bad, stale and missing signatures before reading the body', async () => {
    const calls = stubFetch(db);
    const event = { id: 'evt_6', type: 'customer.subscription.updated', data: { object: { id: 'sub_9' } } };
    expect((await send(event, { secret: 'whsec_wrong' })).status).toBe(400);
    expect((await send(event, { t: Math.floor(Date.now() / 1000) - 600 })).status).toBe(400);
    expect((await call('POST', '/api/billing/webhook', { token: null, body: JSON.stringify(event) })).status).toBe(400);
    expect(calls.some((c) => c.url.host === 'api.stripe.com')).toBe(false);
  });

  it('acknowledges events it does not handle', async () => {
    stubFetch(db);
    expect((await send({ id: 'evt_7', type: 'invoice.paid', data: { object: { id: 'in_1' } } })).status).toBe(200);
  });
});

describe('local mode', () => {
  it('serves the .env timeline exactly as before when Supabase is not configured', async () => {
    stubFetch(db);
    const none = await call('GET', '/api/timeline', { env: {}, token: null });
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({ error: 'No integrations configured. Add STRIPE_SECRET_KEY or GITHUB_REPO to .env.' });
  });

  it('builds from GITHUB_REPO and reports upstream errors as 502', async () => {
    stubFetch(db, (url) => {
      if (url.pathname.endsWith('/commits')) return json([{ commit: { committer: { date: new Date().toISOString() }, author: null } }]);
      if (url.pathname.endsWith('/releases')) return json([]);
      return undefined;
    });
    const ok = await call('GET', '/api/timeline', { env: { GITHUB_REPO: 'acme/app', TINYTOWN_NAME: 'Acme' }, token: null });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ name: 'Acme', source: 'live', integrations: { stripe: false, github: true } });

    stubFetch(db, () => json({ error: { message: 'Invalid API Key' } }, 401));
    const bad = await call('GET', '/api/timeline', { env: { STRIPE_SECRET_KEY: 'rk_bad' }, token: null });
    expect(bad.status).toBe(502);
    expect(await bad.json()).toEqual({ error: 'Stripe responded 401: Invalid API Key' });
  });
});
