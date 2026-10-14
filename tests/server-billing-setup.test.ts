import { describe, expect, it } from 'vitest';
import { WEBHOOK_EVENTS as HANDLED } from '../server/billing.ts';
import { STRIPE_API_VERSION } from '../server/stripe-api.ts';
import { API_VERSION, WEBHOOK_EVENTS, checkAppUrl, keyMode, parseArgs, report, setupStripe } from '../tools/stripe-setup.mjs';

/**
 * tools/stripe-setup.mjs against an in-memory Stripe: a first run creates
 * everything (one $29 yearly price), a second changes nothing, an account
 * set up for the old $12/$99 pricing gets the new price without losing the
 * old ones, a dry run only reads, and live keys need --live.
 */

type Obj = Record<string, unknown> & { id: string };
const APP = 'https://tinytown.example';

/** Just enough of Stripe: products, prices, webhook endpoints and portal configurations. */
function fakeStripe(seed: Partial<Record<'products' | 'prices' | 'webhook_endpoints' | 'configurations', Obj[]>> = {}) {
  const store = { products: [...(seed.products ?? [])], prices: [...(seed.prices ?? [])], webhook_endpoints: [...(seed.webhook_endpoints ?? [])], configurations: [...(seed.configurations ?? [])] };
  const calls: { method: string; path: string; body: Record<string, string>; headers: Headers }[] = [];
  let n = 0;
  const list = (data: Obj[]) => Response.json({ object: 'list', data, has_more: false });
  const fetch = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const body = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
    calls.push({ method, path: url.pathname, body, headers: new Headers(init.headers) });
    const p = url.pathname;
    const arr = (prefix: string) => Object.entries(body).filter(([k]) => k.startsWith(`${prefix}[`)).map(([, v]) => v);
    if (method === 'GET') {
      if (p === '/v1/account') return Response.json({ id: 'acct_1', country: 'US', settings: { dashboard: { display_name: 'TinyTown Ltd' } } });
      if (p === '/v1/prices') {
        const keys = [...url.searchParams].filter(([k]) => k.startsWith('lookup_keys')).map(([, v]) => v);
        return list(store.prices.filter((x) => keys.includes(String(x.lookup_key))));
      }
      if (p.startsWith('/v1/products/')) {
        const found = store.products.find((x) => x.id === p.split('/').at(-1));
        return found ? Response.json(found) : Response.json({ error: { message: 'No such product', code: 'resource_missing' } }, { status: 404 });
      }
      if (p === '/v1/products') return list(store.products);
      if (p === '/v1/webhook_endpoints') return list(store.webhook_endpoints);
      if (p === '/v1/billing_portal/configurations') return list(store.configurations);
    }
    if (method === 'POST') {
      if (p === '/v1/products') {
        const o = { id: body.id ?? `prod_${++n}`, name: body.name, active: true };
        store.products.push(o);
        return Response.json(o);
      }
      if (p === '/v1/prices') {
        const taken = store.prices.find((x) => x.lookup_key === body.lookup_key);
        // Stripe refuses a lookup key that's in use unless asked to move it.
        if (taken && body.transfer_lookup_key !== 'true') return Response.json({ error: { message: 'A price with this lookup key already exists.' } }, { status: 400 });
        if (taken) taken.lookup_key = null;
        const o = { id: `price_${++n}`, product: body.product, lookup_key: body.lookup_key, unit_amount: Number(body.unit_amount), currency: body.currency, recurring: { interval: body['recurring[interval]'] }, active: true };
        store.prices.push(o);
        return Response.json(o);
      }
      if (p === '/v1/webhook_endpoints') {
        const o = { id: `we_${++n}`, url: body.url, enabled_events: arr('enabled_events'), api_version: body.api_version, status: 'enabled', secret: 'whsec_shown_once' };
        store.webhook_endpoints.push(o);
        return Response.json(o);
      }
      const we = /^\/v1\/webhook_endpoints\/(\w+)$/.exec(p);
      if (we) {
        const o = store.webhook_endpoints.find((x) => x.id === we[1])!;
        Object.assign(o, { enabled_events: arr('enabled_events'), status: body.disabled === 'false' ? 'enabled' : o.status });
        return Response.json(o);
      }
      if (p === '/v1/billing_portal/configurations') {
        const o = { id: `bpc_${++n}`, metadata: { tinytown: body['metadata[tinytown]'] }, active: true };
        store.configurations.push(o);
        return Response.json(o);
      }
      const bpc = /^\/v1\/billing_portal\/configurations\/(\w+)$/.exec(p);
      if (bpc) return Response.json(store.configurations.find((x) => x.id === bpc[1]));
    }
    return Response.json({ error: { message: `Unexpected ${method} ${p}` } }, { status: 500 });
  };
  return { fetch, calls, store, posts: () => calls.filter((c) => c.method === 'POST') };
}

const run = (stripe: ReturnType<typeof fakeStripe>, over: Record<string, unknown> = {}) =>
  setupStripe({ key: 'sk_test_123', appUrl: APP, fetch: stripe.fetch as never, ...over });

describe('stripe-setup', () => {
  it('subscribes the webhook to exactly the events the server handles, on the same API version', () => {
    expect([...WEBHOOK_EVENTS].sort()).toEqual([...HANDLED].sort());
    expect(API_VERSION).toBe(STRIPE_API_VERSION);
  });

  it('refuses live keys without --live, and anything that is not a secret key', () => {
    expect(keyMode('sk_test_1', false)).toBe('test');
    expect(keyMode('rk_test_1', false)).toBe('test');
    expect(() => keyMode('sk_live_1', false)).toThrow(/--live/);
    expect(keyMode('sk_live_1', true)).toBe('live');
    expect(() => keyMode('pk_test_1', true)).toThrow(/secret key/);
    expect(() => keyMode(undefined, false)).toThrow(/STRIPE_SECRET_KEY/);
  });

  it('wants a public https address', () => {
    expect(checkAppUrl('https://tinytown.example/')).toBe('https://tinytown.example');
    expect(() => checkAppUrl('http://tinytown.example')).toThrow(/https/);
    expect(() => checkAppUrl('https://localhost:5173')).toThrow(/stripe listen/);
    expect(() => checkAppUrl(null)).toThrow(/--app-url/);
    expect(parseArgs(['--app-url', APP, '--dry-run'])).toEqual({ appUrl: APP, dryRun: true, live: false, help: false });
    expect(parseArgs([`--app-url=${APP}`, '--live'])).toMatchObject({ appUrl: APP, live: true });
    expect(() => parseArgs(['--force'])).toThrow(/Unknown/);
  });

  it('a dry run reads but never writes, and says what it would do', async () => {
    const stripe = fakeStripe();
    const r = await run(stripe, { dryRun: true });
    expect(stripe.posts()).toEqual([]);
    expect(r.steps.map((s) => `${s.thing}: ${s.action}`)).toEqual([
      'Product: would create',
      'Price, yearly: would create',
      'Webhook: would create',
      'Customer portal: would create',
    ]);
    const text = report(r);
    expect(text).toContain('Dry run: nothing was changed.');
    expect(text).toContain('TinyTown Ltd (acct_1), test mode');
    for (const v of ['STRIPE_BILLING_SECRET_KEY', 'STRIPE_PRICE_YEARLY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PORTAL_CONFIGURATION']) expect(text).toContain(v);
    expect(r.steps[1]!.id).toBe('tinytown_yearly: $29 a year');
    // The monthly price is only ever mentioned to say it's not sold.
    expect(text).not.toContain('STRIPE_PRICE_MONTHLY=');
    expect(text).toMatch(/sold by the year only: remove STRIPE_PRICE_MONTHLY/);
    expect(text).toContain('Adaptive Pricing');
    expect(text).toContain(`${APP}/api/billing/webhook`);
    expect(text).toContain('Smart Retries');
    expect(text).not.toContain('sk_test_123');
  });

  it('creates the product, the yearly price, the webhook and the portal on a fresh account', async () => {
    const stripe = fakeStripe();
    const r = await run(stripe);
    expect(r.steps.map((s) => s.action)).toEqual(['created', 'created', 'created', 'created']);

    const [product, year, hook, portal] = stripe.posts();
    expect(product!.body).toMatchObject({ id: 'tinytown', name: 'TinyTown' });
    expect(year!.body).toMatchObject({ product: 'tinytown', unit_amount: '2900', currency: 'usd', 'recurring[interval]': 'year', lookup_key: 'tinytown_yearly', 'metadata[tinytown]': '1' });
    expect(year!.body).not.toHaveProperty('transfer_lookup_key');
    // One price: no monthly one is made.
    expect(stripe.posts().filter((c) => c.path === '/v1/prices')).toHaveLength(1);
    // No trial anywhere.
    for (const c of stripe.posts()) expect(Object.keys(c.body).some((k) => k.includes('trial'))).toBe(false);

    expect(hook!.body).toMatchObject({ url: `${APP}/api/billing/webhook`, api_version: API_VERSION });
    expect(Object.entries(hook!.body).filter(([k]) => k.startsWith('enabled_events')).map(([, v]) => v).sort()).toEqual([...HANDLED].sort());

    expect(portal!.body).toMatchObject({
      'features[subscription_cancel][enabled]': 'true',
      'features[subscription_cancel][mode]': 'at_period_end',
      // One plan: nothing to switch to.
      'features[subscription_update][enabled]': 'false',
      'features[payment_method_update][enabled]': 'true',
      'features[invoice_history][enabled]': 'true',
      'business_profile[terms_of_service_url]': `${APP}/legal/terms.html`,
      'business_profile[privacy_policy_url]': `${APP}/legal/privacy.html`,
      default_return_url: `${APP}/`,
      'metadata[tinytown]': '1',
    });
    // Cancelling never refunds.
    expect(Object.keys(portal!.body).some((k) => k.includes('refund'))).toBe(false);

    for (const c of stripe.calls) expect(c.headers.get('Stripe-Version')).toBe(API_VERSION);
    for (const c of stripe.posts()) expect(c.headers.get('Idempotency-Key')).toMatch(/^tinytown-setup-/);

    expect(Object.keys(portal!.body).some((k) => k.startsWith('features[subscription_update][products]'))).toBe(false);
    expect(r.env).toEqual({
      STRIPE_PRICE_YEARLY: expect.stringMatching(/^price_/),
      STRIPE_WEBHOOK_SECRET: 'whsec_shown_once',
      STRIPE_PORTAL_CONFIGURATION: expect.stringMatching(/^bpc_/),
    });
    expect(report(r)).toContain('STRIPE_WEBHOOK_SECRET=whsec_shown_once');
  });

  it('a second run reuses everything and creates nothing', async () => {
    const stripe = fakeStripe();
    const first = await run(stripe);
    const before = stripe.posts().length;
    const second = await run(stripe);
    const newPosts = stripe.posts().slice(before);
    // Only the portal configuration is re-saved (to the same settings); nothing new is made.
    expect(newPosts.map((c) => c.path)).toEqual([`/v1/billing_portal/configurations/${first.env.STRIPE_PORTAL_CONFIGURATION}`]);
    expect(second.steps.map((s) => s.action)).toEqual(['reused', 'reused', 'reused', 'updated']);
    expect(second.env.STRIPE_PRICE_YEARLY).toBe(first.env.STRIPE_PRICE_YEARLY);
    expect(second.env.STRIPE_WEBHOOK_SECRET).toBeNull();
    expect(report(second)).toContain('STRIPE_WEBHOOK_SECRET=<unchanged: keep the one you saved>');
  });

  it('puts an existing endpoint on exactly our events', async () => {
    const stripe = fakeStripe({ webhook_endpoints: [{ id: 'we_old', url: `${APP}/api/billing/webhook`, enabled_events: ['*'], status: 'disabled', api_version: '2024-06-20' }] });
    const r = await run(stripe);
    const update = stripe.posts().find((c) => c.path === '/v1/webhook_endpoints/we_old')!;
    expect(update.body.disabled).toBe('false');
    expect(Object.entries(update.body).filter(([k]) => k.startsWith('enabled_events')).map(([, v]) => v).sort()).toEqual([...HANDLED].sort());
    expect(r.steps.find((s) => s.thing === 'Webhook')!.action).toBe('updated');
    expect(r.notes.join(' ')).toContain('2024-06-20');
  });

  it('moves an account on the old $12/$99 pricing to $29 a year, leaving the old prices for anyone already on them', async () => {
    const old = [
      { id: 'price_m', product: 'prod_1', lookup_key: 'tinytown_monthly', unit_amount: 1200, currency: 'usd', recurring: { interval: 'month' }, active: true },
      { id: 'price_y', product: 'prod_1', lookup_key: 'tinytown_yearly', unit_amount: 9900, currency: 'usd', recurring: { interval: 'year' }, active: true },
    ];
    const dry = fakeStripe({ prices: old.map((p) => ({ ...p })) });
    const preview = await run(dry, { dryRun: true });
    expect(dry.posts()).toEqual([]);
    expect(preview.steps.map((s) => `${s.thing}: ${s.action}`)).toEqual(['Product: reused', 'Price, yearly: would create', 'Price, monthly: left alone', 'Webhook: would create', 'Customer portal: would create']);
    expect(preview.steps[1]!.id).toBe('tinytown_yearly: $29 a year, taking tinytown_yearly from price_y ($99 a year, kept for anyone already on it)');

    const stripe = fakeStripe({ prices: old.map((p) => ({ ...p })) });
    const r = await run(stripe);
    const created = stripe.posts().filter((c) => c.path === '/v1/prices');
    expect(created).toHaveLength(1);
    expect(created[0]!.body).toMatchObject({ product: 'prod_1', unit_amount: '2900', 'recurring[interval]': 'year', lookup_key: 'tinytown_yearly', transfer_lookup_key: 'true' });
    expect(r.env.STRIPE_PRICE_YEARLY).toBe(stripe.store.prices.at(-1)!.id);
    expect(r.env).not.toHaveProperty('STRIPE_PRICE_MONTHLY');
    // Nothing is archived or changed: the old prices keep their subscribers.
    expect(stripe.posts().some((c) => c.path === '/v1/prices/price_m' || c.path === '/v1/prices/price_y')).toBe(false);
    expect(stripe.store.prices.find((p) => p.id === 'price_m')).toMatchObject({ lookup_key: 'tinytown_monthly', active: true });
    expect(stripe.store.prices.find((p) => p.id === 'price_y')).toMatchObject({ lookup_key: null, active: true });
    expect(r.steps.find((s) => s.thing === 'Price, monthly')).toEqual({ thing: 'Price, monthly', action: 'left alone', id: 'price_m ($12 a month, no longer sold)' });

    // Run again: the new price is found by its key and reused.
    const again = await run(stripe);
    expect(again.steps.find((s) => s.thing === 'Price, yearly')!.action).toBe('reused');
    expect(again.env.STRIPE_PRICE_YEARLY).toBe(r.env.STRIPE_PRICE_YEARLY);
    expect(stripe.posts().filter((c) => c.path === '/v1/prices')).toHaveLength(1);
  });

  it('reuses a TinyTown product made by hand in the Dashboard', async () => {
    const stripe = fakeStripe({ products: [{ id: 'prod_hand', name: 'TinyTown', active: true }] });
    const r = await run(stripe);
    expect(r.steps[0]).toEqual({ thing: 'Product', action: 'reused', id: 'prod_hand' });
    expect(stripe.posts().filter((c) => c.path === '/v1/prices').every((c) => c.body.product === 'prod_hand')).toBe(true);
  });

  it('will not run a live key without --live', async () => {
    const stripe = fakeStripe();
    await expect(setupStripe({ key: 'sk_live_123', appUrl: APP, fetch: stripe.fetch as never })).rejects.toThrow(/--live/);
    expect(stripe.calls).toEqual([]);
  });
});
