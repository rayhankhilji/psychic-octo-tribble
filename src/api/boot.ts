/**
 * What to show when the page opens: pure functions of the server's config,
 * the signed-in founder (if any) and the URL, so every case is testable.
 */
import { isPaid, RETURN_PARAMS, type ConfigResponse, type MeResponse, type Provider } from './contract.ts';

/** The call to action on the demo: the next step towards your own city. */
export type Cta = 'signin' | 'plan' | 'onboard' | 'world' | 'waitlist';

export type BootScreen =
  /** No hosted accounts on this server: exactly the old behaviour (the demo, or a local `.env` timeline). */
  | { kind: 'local' }
  /** The demo world, with the next step towards your own. */
  | { kind: 'demo'; cta: Cta }
  /** The founder's own city, on their real numbers. */
  | { kind: 'world'; pastDue: boolean };

/**
 * | config            | signed in | plan                  | Stripe   | screen                 |
 * |-------------------|-----------|-----------------------|----------|------------------------|
 * | missing / !hosted | –         | –                     | –        | local                  |
 * | hosted            | no        | –                     | –        | demo, cta signin       |
 * | hosted            | yes       | none/canceled/incompl.| –        | demo, cta plan         |
 * | hosted            | yes       | active/trialing/past  | no       | demo, cta onboard      |
 * | hosted            | yes       | active/trialing/past  | yes      | world (pastDue flag)   |
 * | … with `?demo`    | yes       | paid                  | yes      | demo, cta world        |
 * | hosted (waitlist) | yes, 403 `not_invited` from /api/me | – | – | demo, cta waitlist |
 */
export function decideBoot(config: ConfigResponse | null, me: MeResponse | null, opts: { forceDemo?: boolean; waitlisted?: boolean } = {}): BootScreen {
  if (!config?.hosted) return { kind: 'local' };
  if (opts.waitlisted && !me) return { kind: 'demo', cta: 'waitlist' };
  if (!me) return { kind: 'demo', cta: 'signin' };
  if (!isPaid(me.plan.status)) return { kind: 'demo', cta: 'plan' };
  if (!me.connections.stripe) return { kind: 'demo', cta: 'onboard' };
  if (opts.forceDemo) return { kind: 'demo', cta: 'world' };
  return { kind: 'world', pastDue: me.plan.status === 'past_due' };
}

/** What a redirect back from Checkout or an OAuth install says. */
export interface ReturnState {
  checkout: 'success' | 'cancel' | null;
  connected: Provider | null;
  connectError: { provider: Provider | null; message: string } | null;
}

const PROVIDERS: readonly Provider[] = ['stripe', 'github', 'posthog', 'ga4'];
const asProvider = (v: string | null | undefined): Provider | null => ((PROVIDERS as readonly string[]).includes(v ?? '') ? (v as Provider) : null);

const NAMES: Record<Provider, string> = { stripe: 'Stripe', github: 'GitHub', posthog: 'PostHog', ga4: 'Google Analytics' };

/** Known reasons an install can fail, in plain words. */
const CONNECT_ERRORS: Record<string, (p: string) => string> = {
  access_denied: (p) => `You cancelled on ${p}, so nothing was connected.`,
  denied: (p) => `You cancelled on ${p}, so nothing was connected.`,
  state: () => 'That connection link expired. Start again from here.',
  expired: () => 'That connection link expired. Start again from here.',
  testmode: () => "That's a test-mode Stripe account. Test data can't grow a real city: install the app in live mode.",
  livemode: () => "That's a test-mode Stripe account. Test data can't grow a real city: install the app in live mode.",
  account_in_use: (p) => `That ${p} account is already connected to another TinyTown city.`,
  installation: () => "That GitHub installation belongs to a different account. Install the app from your own GitHub account.",
};

/**
 * Pure: reads the return parameters. `connect_error` may be a provider
 * (`stripe`), a provider and a reason (`stripe:access_denied`), a bare reason,
 * or a sentence from the server.
 */
export function readReturn(search: string | URLSearchParams): ReturnState {
  const p = typeof search === 'string' ? new URLSearchParams(search) : search;
  const c = p.get(RETURN_PARAMS.checkout);
  const raw = p.get(RETURN_PARAMS.error);
  let connectError: ReturnState['connectError'] = null;
  if (raw !== null) {
    const [head, ...tail] = raw.split(':');
    const provider = asProvider(head) ?? asProvider(p.get('provider'));
    const reason = (asProvider(head) ? tail.join(':') : raw).trim();
    const name = provider ? NAMES[provider] : 'that service';
    const known = CONNECT_ERRORS[reason.toLowerCase()];
    const message = known
      ? known(name)
      : /\s/.test(reason)
        ? reason
        : `Couldn't connect ${name}. Try again, and if it keeps happening, reconnect from your account.`;
    connectError = { provider, message };
  }
  return {
    checkout: c === 'success' || c === 'cancel' ? c : null,
    connected: asProvider(p.get(RETURN_PARAMS.connected)),
    connectError,
  };
}

/** Return and sign-in redirect parameters, removed from the address bar once read. */
const TRANSIENT = [RETURN_PARAMS.checkout, RETURN_PARAMS.connected, RETURN_PARAMS.error, 'provider', 'error', 'error_code', 'error_description', 'session_id'];

/** Pure: the query string without the one-shot parameters (keeps `?demo`, `?seed=`, `?time=`…). */
export function cleanSearch(search: string): string {
  const p = new URLSearchParams(search);
  for (const k of TRANSIENT) p.delete(k);
  // `?demo&time=13:00` stays readable: no `demo=` for bare flags.
  const s = [...p.entries()].map(([k, v]) => (v === '' ? encodeURIComponent(k) : `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).replace(/%3A/g, ':')).join('&');
  return s ? `?${s}` : '';
}

export type Opening =
  | { dialog: 'none' }
  | { dialog: 'plan'; note: 'checkout-cancel' | 'canceled' | 'incomplete' | null }
  | { dialog: 'onboard'; welcome: boolean; step: 1 | 2 | 3; error: string | null; stripeBroken?: boolean }
  | { dialog: 'signin'; error: string }
  | { dialog: 'waitlist' };

/**
 * Pure: which dialog (if any) opens by itself. The demo never nags: dialogs
 * open on their own only when the founder is mid-flow (back from Checkout or
 * an install, or paid but not yet connected).
 */
export function decideOpening(screen: BootScreen, ret: ReturnState, me: MeResponse | null, opts: { signInError?: string | null; wantsPlan?: boolean } = {}): Opening {
  if (screen.kind === 'local') return { dialog: 'none' };
  if (screen.kind === 'demo' && screen.cta === 'waitlist') return { dialog: 'waitlist' };
  if (opts.signInError && !me) return { dialog: 'signin', error: opts.signInError };
  if (ret.checkout === 'cancel' && me && !isPaid(me.plan.status)) return { dialog: 'plan', note: 'checkout-cancel' };
  const stepOf = (p: Provider | null): 1 | 2 | 3 => (p === 'github' ? 2 : p === 'posthog' || p === 'ga4' ? 3 : 1);
  if (ret.connectError && me) return { dialog: 'onboard', welcome: false, step: stepOf(ret.connectError.provider), error: ret.connectError.message };
  if (ret.connected && me) {
    // Stripe done: on to GitHub. GitHub installed: stay there to pick a repository.
    const step = ret.connected === 'stripe' ? 2 : ret.connected === 'github' ? 2 : 3;
    return { dialog: 'onboard', welcome: false, step, error: null };
  }
  if (ret.checkout === 'success' && me) {
    if (me.connections.stripe) return { dialog: 'none' };
    return { dialog: 'onboard', welcome: true, step: 1, error: null };
  }
  if (screen.kind === 'demo' && screen.cta === 'onboard') return { dialog: 'onboard', welcome: false, step: 1, error: null };
  if (screen.kind === 'demo' && screen.cta === 'plan' && me) {
    const s = me.plan.status;
    if (s === 'canceled' || s === 'incomplete') return { dialog: 'plan', note: s };
    if (opts.wantsPlan) return { dialog: 'plan', note: null };
  }
  return { dialog: 'none' };
}
