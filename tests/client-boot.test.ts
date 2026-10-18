import { describe, expect, it } from 'vitest';
import { cleanSearch, decideBoot, decideOpening, readReturn, type ReturnState } from '../src/api/boot.ts';
import type { ConfigResponse, MeResponse, PlanStatus } from '../src/api/contract.ts';

const hosted: ConfigResponse = {
  hosted: true,
  supabase: { url: 'https://x.supabase.co', anonKey: 'anon' },
  plans: [
    { interval: 'month', amount: 1200, currency: 'usd' },
    { interval: 'year', amount: 9900, currency: 'usd' },
  ],
  connect: { stripe: true, github: true, posthog: true },
};
const local: ConfigResponse = { hosted: false, supabase: null, plans: [], connect: { stripe: false, github: false, posthog: false } };

function me(status: PlanStatus, stripe = false, repo: string | null = null): MeResponse {
  return {
    user: { id: 'u', email: 'a@b.co' },
    plan: { status, interval: status === 'none' ? null : 'month', renewsAt: null, cancelAtPeriodEnd: false },
    connections: {
      stripe: stripe ? { account: 'acct_1', name: null, livemode: true, connectedAt: 1 } : null,
      github: repo ? { installationId: 1, repo, connectedAt: 1 } : null,
      users: { source: 'customers' },
    },
    world: { seed: 42, name: 'Acme', joinedAt: 1, lastSeen: null },
  };
}

const none: ReturnState = { checkout: null, connected: null, connectError: null };

describe('decideBoot', () => {
  it('no API, or not hosted: exactly the old behaviour', () => {
    expect(decideBoot(null, null)).toEqual({ kind: 'local' });
    expect(decideBoot(local, me('active', true))).toEqual({ kind: 'local' });
  });

  it('signed out: the demo, inviting you to sign in', () => {
    expect(decideBoot(hosted, null)).toEqual({ kind: 'demo', cta: 'signin' });
  });

  it('signed in, new, nothing connected: setup first, for free', () => {
    expect(decideBoot(hosted, me('none'))).toEqual({ kind: 'demo', cta: 'onboard' });
  });

  it('signed in, new, Stripe connected: the paywall, over the demo', () => {
    expect(decideBoot(hosted, me('none', true))).toEqual({ kind: 'demo', cta: 'plan' });
    expect(decideBoot(hosted, me('none', true, 'a/b'))).toEqual({ kind: 'demo', cta: 'plan' });
  });

  it.each<PlanStatus>(['canceled', 'incomplete'])('a plan that ended or never finished (%s): the paywall, connected or not', (s) => {
    expect(decideBoot(hosted, me(s))).toEqual({ kind: 'demo', cta: 'plan' });
    expect(decideBoot(hosted, me(s, true))).toEqual({ kind: 'demo', cta: 'plan' });
  });

  it.each<PlanStatus>(['active', 'trialing', 'past_due'])('paid (%s) but Stripe not connected: setup', (s) => {
    expect(decideBoot(hosted, me(s))).toEqual({ kind: 'demo', cta: 'onboard' });
  });

  it('paid and connected: your own city', () => {
    expect(decideBoot(hosted, me('active', true))).toEqual({ kind: 'world', pastDue: false });
    expect(decideBoot(hosted, me('past_due', true))).toEqual({ kind: 'world', pastDue: true });
  });

  it('?demo shows the demo even to a founder with a city, with a way back', () => {
    expect(decideBoot(hosted, me('active', true), { forceDemo: true })).toEqual({ kind: 'demo', cta: 'world' });
    expect(decideBoot(hosted, null, { forceDemo: true })).toEqual({ kind: 'demo', cta: 'signin' });
  });
});

describe('readReturn', () => {
  it('reads Checkout and install returns', () => {
    expect(readReturn('?checkout=success')).toMatchObject({ checkout: 'success' });
    expect(readReturn('?checkout=cancel')).toMatchObject({ checkout: 'cancel' });
    expect(readReturn('?checkout=bogus').checkout).toBeNull();
    expect(readReturn('?connected=github').connected).toBe('github');
    expect(readReturn('?connected=dropbox').connected).toBeNull();
  });

  it('turns provider:reason errors into plain words', () => {
    const denied = readReturn('?connect_error=stripe:denied').connectError!;
    expect(denied.provider).toBe('stripe');
    expect(denied.message).toMatch(/cancelled on Stripe/);
    expect(readReturn('?connect_error=stripe:testmode').connectError!.message).toMatch(/test-mode/);
    expect(readReturn('?connect_error=github:state').connectError!.message).toMatch(/expired/);
    expect(readReturn('?connect_error=github:installation').connectError!.message).toMatch(/different account/);
  });

  it('shows a sentence from the server as it is', () => {
    const e = readReturn(`?connect_error=${encodeURIComponent('github:Waiting for an organization owner to approve the app.')}`).connectError!;
    expect(e).toEqual({ provider: 'github', message: 'Waiting for an organization owner to approve the app.' });
  });

  it('falls back to a generic line for an unknown code', () => {
    expect(readReturn('?connect_error=stripe:weird_thing').connectError!.message).toMatch(/Couldn't connect Stripe/);
  });
});

describe('cleanSearch', () => {
  it('drops one-shot params and keeps the rest readable', () => {
    expect(cleanSearch('?demo&time=13:00&checkout=success&connected=stripe')).toBe('?demo&time=13:00');
    expect(cleanSearch('?connect_error=stripe:denied')).toBe('');
    expect(cleanSearch('?seed=7&error=access_denied&error_description=x')).toBe('?seed=7');
  });
});

describe('decideOpening', () => {
  it('local and calm demos open nothing by themselves', () => {
    expect(decideOpening({ kind: 'local' }, none, null)).toEqual({ dialog: 'none' });
    expect(decideOpening({ kind: 'demo', cta: 'signin' }, none, null)).toEqual({ dialog: 'none' });
    expect(decideOpening({ kind: 'demo', cta: 'plan' }, none, me('none'))).toEqual({ dialog: 'none' });
  });

  it('signed in with setup to do: setup opens by itself (it is free)', () => {
    const screen = decideBoot(hosted, me('none'));
    expect(decideOpening(screen, none, me('none'))).toEqual({ dialog: 'onboard', welcome: false, step: 1, error: null });
  });

  it('set up but unpaid: the paywall opens by itself, every visit', () => {
    const founder = me('none', true, 'a/b');
    expect(decideOpening(decideBoot(hosted, founder), none, founder)).toEqual({ dialog: 'plan', note: null });
  });

  it('back from connecting Stripe without a plan: on to the next step, not the paywall yet', () => {
    const founder = me('none', true);
    expect(decideOpening(decideBoot(hosted, founder), { ...none, connected: 'stripe' }, founder)).toMatchObject({ dialog: 'onboard', step: 2 });
    expect(decideOpening(decideBoot(hosted, founder), { ...none, connected: 'github' }, founder)).toMatchObject({ dialog: 'onboard', step: 2 });
  });

  it('a failed sign-in link reopens sign-in with the reason', () => {
    expect(decideOpening({ kind: 'demo', cta: 'signin' }, none, null, { signInError: 'expired' })).toEqual({ dialog: 'signin', error: 'expired' });
  });

  it('carries on to checkout after signing in with a plan picked', () => {
    expect(decideOpening({ kind: 'demo', cta: 'plan' }, none, me('none'), { wantsPlan: true })).toEqual({ dialog: 'plan', note: null });
  });

  it('back from a cancelled Checkout: the plans again, nothing charged', () => {
    expect(decideOpening({ kind: 'demo', cta: 'plan' }, { ...none, checkout: 'cancel' }, me('none'))).toEqual({ dialog: 'plan', note: 'checkout-cancel' });
  });

  it('a lapsed plan says so', () => {
    expect(decideOpening({ kind: 'demo', cta: 'plan' }, none, me('canceled'))).toEqual({ dialog: 'plan', note: 'canceled' });
  });

  it('just paid: the welcome and step 1', () => {
    expect(decideOpening({ kind: 'demo', cta: 'onboard' }, { ...none, checkout: 'success' }, me('active'))).toEqual({ dialog: 'onboard', welcome: true, step: 1, error: null });
  });

  it('paid but not connected: setup opens on its own', () => {
    expect(decideOpening({ kind: 'demo', cta: 'onboard' }, none, me('active'))).toEqual({ dialog: 'onboard', welcome: false, step: 1, error: null });
  });

  it('back from installs: the next step, or the error at the right step', () => {
    expect(decideOpening({ kind: 'world', pastDue: false }, { ...none, connected: 'stripe' }, me('active', true))).toMatchObject({ dialog: 'onboard', step: 2 });
    expect(decideOpening({ kind: 'world', pastDue: false }, { ...none, connected: 'github' }, me('active', true))).toMatchObject({ dialog: 'onboard', step: 2 });
    expect(decideOpening({ kind: 'demo', cta: 'onboard' }, { ...none, connectError: { provider: 'github', message: 'nope' } }, me('active'))).toEqual({
      dialog: 'onboard',
      welcome: false,
      step: 2,
      error: 'nope',
    });
  });

  it('a returning subscriber with a city just gets their city', () => {
    expect(decideOpening({ kind: 'world', pastDue: false }, { ...none, checkout: 'success' }, me('active', true, 'a/b'))).toEqual({ dialog: 'none' });
    expect(decideOpening({ kind: 'world', pastDue: true }, none, me('past_due', true))).toEqual({ dialog: 'none' });
  });
});

describe('the waitlist', () => {
  it('signed in but not invited yet: the demo, and the "you\'re on the list" card', () => {
    const screen = decideBoot(hosted, null, { waitlisted: true });
    expect(screen).toEqual({ kind: 'demo', cta: 'waitlist' });
    expect(decideOpening(screen, none, null)).toEqual({ dialog: 'waitlist' });
  });

  it('only applies when hosted', () => {
    expect(decideBoot(local, null, { waitlisted: true })).toEqual({ kind: 'local' });
  });
});
