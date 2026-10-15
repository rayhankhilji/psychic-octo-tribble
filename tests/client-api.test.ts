import { afterEach, describe, expect, it, vi } from 'vitest';
import { Api, ApiRequestError, filenameFrom, toApiError } from '../src/api/client.ts';
import { describeRedirectError, describeSignInError } from '../src/api/auth.ts';
import { HOME_TIERS } from '../src/game/catalog.ts';
import { MRR_PER_USER, RATE } from '../src/game/economy.ts';
import { shortMrr } from '../src/ui/dom.ts';
import { frontDoorBeats } from '../src/ui/frontdoor.ts';
import { climb, offerEnds, teaserStats } from '../src/ui/plans.ts';
import { previewOf, residentsOf } from '../src/api/preview.ts';
import { ctaPrice, defaultInterval, formatPrice, inWords, perInterval, priceLine, priceSheet } from '../src/api/pricing.ts';
import type { Plan } from '../src/api/contract.ts';

describe('toApiError', () => {
  it("keeps the server's code and sentence", () => {
    const e = toApiError(409, { error: 'Not enough money in the treasury.', code: 'rejected' });
    expect(e).toBeInstanceOf(ApiRequestError);
    expect(e.status).toBe(409);
    expect(e.code).toBe('rejected');
    expect(e.message).toBe('Not enough money in the treasury.');
  });

  it('infers the code from the status when the server sends none', () => {
    expect(toApiError(401, {}).code).toBe('unauthenticated');
    expect(toApiError(402, null).code).toBe('payment_required');
    expect(toApiError(409, 'nope').code).toBe('rejected');
    expect(toApiError(503, {}).code).toBe('not_configured');
    expect(toApiError(500, {}).code).toBe('upstream');
    expect(toApiError(502, {}).code).toBe('upstream');
    expect(toApiError(400, {}).code).toBe('bad_request');
    expect(toApiError(404, {}).code).toBe('bad_request');
  });

  it('ignores unknown codes and blank messages, falling back to plain words', () => {
    const e = toApiError(402, { error: '   ', code: 'wat' });
    expect(e.code).toBe('payment_required');
    expect(e.message).toMatch(/plan/);
  });

  it('a 409 not_connected stays not_connected (the timeline with no Stripe)', () => {
    expect(toApiError(409, { error: 'Connect Stripe', code: 'not_connected' }).code).toBe('not_connected');
  });
});

describe('Api', () => {
  const real = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = real;
  });

  const respond = (status: number, body: unknown) =>
    vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

  it('sends the bearer token and JSON body', async () => {
    const f = respond(200, { url: 'https://checkout.stripe.com/x' });
    globalThis.fetch = f as unknown as typeof fetch;
    const api = new Api({ token: async () => 'tok' });
    const out = await api.checkout('year');
    expect(out.url).toContain('stripe');
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('/api/billing/checkout');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(String(init?.body))).toEqual({ interval: 'year' });
  });

  it('calls the 401 and 402 hooks once, in one place', async () => {
    const onUnauthenticated = vi.fn();
    const onPaymentRequired = vi.fn();
    const api = new Api({ token: async () => 'tok', onUnauthenticated, onPaymentRequired });
    globalThis.fetch = respond(401, { error: 'Sign in', code: 'unauthenticated' }) as unknown as typeof fetch;
    await expect(api.me()).rejects.toMatchObject({ code: 'unauthenticated' });
    globalThis.fetch = respond(402, { error: 'No plan', code: 'payment_required' }) as unknown as typeof fetch;
    await expect(api.timeline()).rejects.toMatchObject({ code: 'payment_required' });
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    expect(onPaymentRequired).toHaveBeenCalledTimes(1);
  });

  it('turns a failed fetch into a network error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const api = new Api({ token: async () => null });
    await expect(api.actions()).rejects.toMatchObject({ code: 'network', status: 0 });
  });

  it('config is null without an API (static host, or the old local server)', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Not found', { status: 404 })) as unknown as typeof fetch;
    expect(await new Api({ token: async () => null }).config()).toBeNull();
    globalThis.fetch = vi.fn(async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch;
    expect(await new Api({ token: async () => null }).config()).toBeNull();
  });

  it('unwraps actions', async () => {
    globalThis.fetch = respond(200, { actions: [{ t: 1, kind: 'build', item: 'park' }] }) as unknown as typeof fetch;
    const api = new Api({ token: async () => 't' });
    expect(await api.addAction({ t: 1, kind: 'build', item: 'park' })).toHaveLength(1);
  });
});

describe('sign-in messages', () => {
  it('explains an expired magic link', () => {
    expect(describeRedirectError(new URLSearchParams('error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired'))).toMatch(/expired/);
  });

  it('says nothing when the redirect is clean', () => {
    expect(describeRedirectError(new URLSearchParams('access_token=x'))).toBeNull();
  });

  it('a cancelled consent is not an error to worry about', () => {
    expect(describeRedirectError(new URLSearchParams('error=access_denied'))).toMatch(/cancelled/);
  });

  it('maps rate limits and bad addresses', () => {
    expect(describeSignInError({ status: 429, message: 'Email rate limit exceeded' })).toMatch(/minute/);
    expect(describeSignInError({ code: 'email_address_invalid', message: 'x' })).toMatch(/doesn't look right/);
    expect(describeSignInError({ message: 'Something odd' })).toMatch(/Try again/);
  });
});

describe('pricing', () => {
  // What's on sale: $29 a year, nothing else.
  const yearly: Plan = { interval: 'year', amount: 2900, currency: 'usd' };
  // A server that still has a monthly price configured (the old pricing), to show nothing breaks.
  const both: Plan[] = [{ interval: 'month', amount: 1200, currency: 'usd' }, { interval: 'year', amount: 9900, currency: 'usd' }];

  it('quotes the real price', () => {
    expect(formatPrice(2900, 'usd')).toBe('$29');
    expect(formatPrice(242, 'usd')).toBe('$2.42');
    expect(perInterval(yearly)).toBe('$29/year');
    expect(inWords(yearly)).toBe('$29 a year');
    expect(ctaPrice([yearly])).toBe('$29/yr');
    expect(priceLine([yearly])).toBe('$29 a year');
  });

  it('spreads the year over twelve months without understating it: $2.42', () => {
    const s = priceSheet([yearly]);
    expect(s.month).toBeNull();
    expect(s.yearlyPerMonth).toBe(242);
    expect(s.yearlyPerMonth! * 12).toBeGreaterThanOrEqual(2900);
    expect(priceSheet(both).yearlyPerMonth).toBe(825);
  });

  it('never invents a saving', () => {
    expect(priceSheet([yearly]).yearlySaving).toBe(0);
    expect(priceSheet(both).yearlySaving).toBe(4500);
    expect(priceSheet([{ interval: 'month', amount: 500, currency: 'usd' }, { interval: 'year', amount: 9900, currency: 'usd' }]).yearlySaving).toBe(0);
    expect(priceSheet([{ interval: 'month', amount: 1200, currency: 'usd' }, { interval: 'year', amount: 9900, currency: 'eur' }]).yearlySaving).toBe(0);
  });

  it('quotes and selects the plan on sale', () => {
    expect(defaultInterval(priceSheet([yearly]))).toBe('year');
    // With a monthly price configured too, the smaller charge leads.
    expect(defaultInterval(priceSheet(both))).toBe('month');
    expect(ctaPrice(both)).toBe('$12/mo');
    expect(priceLine(both)).toBe('$12 a month or $99 a year');
  });

  it('says nothing when nothing is on sale', () => {
    expect(ctaPrice([])).toBeNull();
    expect(priceLine([])).toBeNull();
  });
});

describe('the paywall quotes the game, not a copy of it', () => {
  it("climbs the founder's house from HOME_TIERS: the start, the Hills, the island, the moon", () => {
    const first = (where: string) => HOME_TIERS.find((t) => t.where === where)!;
    expect(climb()).toEqual([
      [shortMrr(HOME_TIERS[0]!.mrr), 'Hacker house'],
      [shortMrr(first('hills').mrr), 'The Hills'],
      [shortMrr(first('island').mrr), 'An island'],
      [shortMrr(first('moon').mrr), 'The moon'],
    ]);
  });

  it("the front door's three rules come from the economy's constants", () => {
    const [money, housing, moon] = frontDoorBeats();
    expect(money!.fig).toBe(`$${RATE.toLocaleString('en-US')}`);
    expect(housing!.fig).toBe(`${Math.round(MRR_PER_USER * 100)}¢`);
    expect(moon!.fig).toBe(shortMrr(HOME_TIERS.find((t) => t.where === 'moon')!.mrr));
    expect(moon!.text).toMatch(/^MRR takes you from a hacker house to a house on the moon/);
  });
});

describe('filenameFrom', () => {
  it('reads Content-Disposition in its common forms', () => {
    expect(filenameFrom('attachment; filename="tinytown-acme.json"', 'x.json')).toBe('tinytown-acme.json');
    expect(filenameFrom('attachment; filename=plain.json', 'x.json')).toBe('plain.json');
    expect(filenameFrom("attachment; filename*=UTF-8''caf%C3%A9.json", 'x.json')).toBe('café.json');
    expect(filenameFrom(null, 'x.json')).toBe('x.json');
  });
});

describe('the preview and the paywall teaser', () => {
  const DAY = 86_400_000;
  const T0 = Date.UTC(2026, 0, 1);
  const timeline = (users?: number) => ({
    name: 'Acme',
    currency: 'usd',
    source: 'live' as const,
    integrations: { stripe: true, github: true },
    snapshots: Array.from({ length: 60 }, (_, i) => ({ t: T0 + i * DAY, mrr: i < 10 ? 0 : 4320 * (i / 59), customers: i < 10 ? 0 : Math.round(120 * (i / 59)), releases: Math.floor(i / 4), commits: i * 2, ...(users && i > 50 ? { users } : {}) })),
  });

  it('only the headline numbers, never the days', () => {
    const p = previewOf(timeline(2400));
    expect(p).toMatchObject({ name: 'Acme', ready: true, days: 60, asOf: T0 + 59 * DAY, users: 2400 });
    expect(p.revenue).toMatchObject({ mrr: 4320, customers: 120, since: T0 + 10 * DAY });
    expect(p.shipping).toMatchObject({ releases: 14, commits30: 60 });
    expect(JSON.stringify(p)).not.toContain('snapshots');
    expect(residentsOf(p)).toBe(2400);
    // No users source: the residents are the paying customers.
    expect(residentsOf(previewOf(timeline()))).toBe(120);
    expect(previewOf({ ...timeline(), snapshots: [] })).toMatchObject({ ready: false, revenue: null, asOf: null });
  });

  it('the teaser quotes the real numbers', () => {
    expect(teaserStats(previewOf(timeline(2400)))).toEqual([
      ['$4,320', 'MRR'],
      ['2,400', 'residents'],
      ['14', 'releases for HQ'],
    ]);
    const noGithub = previewOf({ ...timeline(), integrations: { stripe: true, github: false } });
    expect(teaserStats(noGithub).at(-1)).toEqual(['Jan 2026', 'history from']);
    expect(teaserStats(previewOf({ ...timeline(), snapshots: [] }))).toEqual([]);
  });

  it('says when the offer closes, from the real time, never a made-up countdown', () => {
    const now = Date.UTC(2026, 9, 15, 12);
    expect(offerEnds(now + 47.5 * 3_600_000, now).left).toBe('47 hours left');
    expect(offerEnds(now + 90 * 60_000, now).left).toBe('1 hour left');
    expect(offerEnds(now + 20 * 60_000, now).left).toBe('less than an hour left');
    expect(offerEnds(now - 1, now).left).toBe('closed');
    expect(offerEnds(now + 3_600_000, now).when).toMatch(/day \d{1,2}:\d{2} [AP]M$/);
  });

  it('asks the server for the offer with the checkout, and nothing else', async () => {
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body ?? '') });
      return new Response(JSON.stringify({ url: 'https://checkout.stripe.com/x', offer: null }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = new Api({ token: async () => 't' });
    await api.checkout('year', { offer: true });
    await api.checkout('year');
    await api.offerSeen();
    expect(calls.map((c) => [c.url, c.body])).toEqual([
      ['/api/billing/checkout', '{"interval":"year","offer":true}'],
      ['/api/billing/checkout', '{"interval":"year"}'],
      ['/api/billing/offer/seen', '{}'],
    ]);
  });
});
