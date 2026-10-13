import { afterEach, describe, expect, it, vi } from 'vitest';
import { Api, ApiRequestError, filenameFrom, toApiError } from '../src/api/client.ts';
import { describeRedirectError, describeSignInError } from '../src/api/auth.ts';
import { defaultInterval, formatPrice, perInterval, priceSheet } from '../src/api/pricing.ts';
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
  const plans: Plan[] = [
    { interval: 'month', amount: 1200, currency: 'usd' },
    { interval: 'year', amount: 9900, currency: 'usd' },
  ];

  it('quotes the real prices', () => {
    expect(formatPrice(1200, 'usd')).toBe('$12');
    expect(formatPrice(9900, 'usd')).toBe('$99');
    expect(formatPrice(825, 'usd')).toBe('$8.25');
    expect(perInterval(plans[0]!)).toBe('$12/month');
  });

  it('works out the yearly saving from the plans on sale: $45', () => {
    const s = priceSheet(plans);
    expect(s.yearlySaving).toBe(4500);
    expect(s.yearlyPerMonth).toBe(825);
  });

  it('never invents a saving', () => {
    expect(priceSheet([plans[1]!]).yearlySaving).toBe(0);
    expect(priceSheet([{ interval: 'month', amount: 500, currency: 'usd' }, { interval: 'year', amount: 9900, currency: 'usd' }]).yearlySaving).toBe(0);
    expect(priceSheet([{ interval: 'month', amount: 1200, currency: 'usd' }, { interval: 'year', amount: 9900, currency: 'eur' }]).yearlySaving).toBe(0);
  });

  it('selects monthly first, the price the call to action quotes', () => {
    expect(defaultInterval(priceSheet(plans))).toBe('month');
    expect(defaultInterval(priceSheet([plans[1]!]))).toBe('year');
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
