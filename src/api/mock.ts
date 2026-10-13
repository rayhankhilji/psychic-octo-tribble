/**
 * A pretend TinyTown API, for seeing every hosted state without a backend.
 * Dev server only (or a build made with `--mode mockapi`, for frozen
 * screenshots); main.ts imports it behind a compile-time guard, so a normal
 * production build never contains it.
 *
 *   /?mockapi=signedout          hosted, not signed in (the demo with "Make it yours")
 *   /?mockapi=unpaid             signed in, no plan (paywall)
 *   /?mockapi=canceled           signed in, plan ended
 *   /?mockapi=paid-unconnected   paid, nothing connected (onboarding step 1)
 *   /?mockapi=paid-stripe        paid, Stripe connected (no world yet without ?connected; step 2)
 *   /?mockapi=paid-github        paid, Stripe and GitHub installed, no repository picked
 *   /?mockapi=connected          your own city on (demo-shaped) live data
 *   /?mockapi=pastdue            your city, with the last payment failed
 *   /?mockapi=local              no hosted accounts (today's behaviour)
 *   /?mockapi=waitlist           signed in, but the waitlist hasn't reached this email (403 not_invited)
 *
 * Extras: `&mockerr=checkout|portal|signin|repos|users|connect|timeline|link` makes that call fail;
 * `&mockreject` makes the server refuse the next build (409), to see the rollback.
 * `&mockcaptcha` turns on Turnstile with Cloudflare's always-pass test key.
 */
import { demoTimeline } from '../data/demo.ts';
import { demoActions } from '../game/demo-script.ts';
import type { Action } from '../game/economy.ts';
import type { AuthProvider, AuthSession, OAuthProvider } from './auth.ts';
import { AuthError } from './auth.ts';
import { ROUTES, type ConfigResponse, type Connections, type MeResponse, type PlanStatus, type UsersRequest } from './contract.ts';

export type MockState = 'waitlist' | 'signedout' | 'unpaid' | 'canceled' | 'paid-unconnected' | 'paid-stripe' | 'paid-github' | 'connected' | 'pastdue' | 'local';

const DAY = 86_400_000;
const params = new URLSearchParams(location.search);

/** A URL for this page in another mock state, keeping the preview params (time, debug, size…). */
function hrefFor(state: MockState, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams(location.search);
  for (const k of ['checkout', 'connected', 'connect_error', 'mockreject', 'mockportal']) p.delete(k);
  p.set('mockapi', state);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return `/?${p.toString().replace(/=(?=&|$)/g, '')}`;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const REPOS = [
  { fullName: 'nightjar-hq/nightjar', private: true, defaultBranch: 'main' },
  { fullName: 'nightjar-hq/nightjar-web', private: true, defaultBranch: 'main' },
  { fullName: 'nightjar-hq/api', private: true, defaultBranch: 'main' },
  { fullName: 'nightjar-hq/ios', private: true, defaultBranch: 'develop' },
  { fullName: 'nightjar-hq/android', private: true, defaultBranch: 'develop' },
  { fullName: 'nightjar-hq/docs', private: false, defaultBranch: 'main' },
  { fullName: 'nightjar-hq/sdk-js', private: false, defaultBranch: 'main' },
  { fullName: 'nightjar-hq/sdk-python', private: false, defaultBranch: 'main' },
  { fullName: 'nightjar-hq/infra', private: true, defaultBranch: 'main' },
  { fullName: 'nightjar-hq/design-system', private: true, defaultBranch: 'main' },
  { fullName: 'mara-okafor/dotfiles', private: false, defaultBranch: 'master' },
  { fullName: 'mara-okafor/blog', private: false, defaultBranch: 'main' },
];

export function installMockApi(state: MockState): AuthProvider | null {
  const now = Date.now();
  const fail = params.get('mockerr');
  const paid = !['signedout', 'unpaid', 'canceled', 'local', 'waitlist'].includes(state);
  const status: PlanStatus = state === 'pastdue' ? 'past_due' : state === 'canceled' ? 'canceled' : paid ? 'active' : 'none';
  const timeline = { ...demoTimeline(), source: 'live' as const, integrations: { stripe: true, github: true } };
  let actions: Action[] = demoActions(timeline.snapshots);
  let rejectNext = params.has('mockreject');

  const connections: Connections = {
    stripe: ['paid-stripe', 'paid-github', 'connected', 'pastdue'].includes(state) ? { account: 'acct_1PxNightjar', name: null, livemode: true, connectedAt: now - 40 * DAY } : null,
    github: ['paid-github', 'connected', 'pastdue'].includes(state) ? { installationId: 51_204_877, repo: state === 'paid-github' ? null : 'nightjar-hq/nightjar', connectedAt: now - 40 * DAY } : null,
    users: state === 'connected' || state === 'pastdue' ? { source: 'posthog', host: 'https://eu.posthog.com', projectId: '48213', connectedAt: now - 38 * DAY } : { source: 'customers' },
  };
  const me = (): MeResponse => ({
    user: { id: 'mock-user', email: 'mara@nightjar.dev' },
    plan: {
      status,
      interval: paid || state === 'canceled' ? 'year' : null,
      renewsAt: state === 'canceled' ? now - 9 * DAY : paid ? now + 318 * DAY : null,
      cancelAtPeriodEnd: false,
    },
    connections,
    world: { seed: Number(params.get('seed')) || 0, name: 'Nightjar', joinedAt: timeline.snapshots.at(-1)!.t - 40 * DAY, lastSeen: timeline.snapshots.at(-6)!.t },
  });
  const config: ConfigResponse = {
    hosted: state !== 'local',
    supabase: state !== 'local' ? { url: 'https://mock.supabase.co', anonKey: 'mock-anon-key' } : null,
    plans: [
      { interval: 'month', amount: 1200, currency: 'usd' },
      { interval: 'year', amount: 9900, currency: 'usd' },
    ],
    connect: { stripe: true, github: true, posthog: true },
    captcha: params.has('mockcaptcha') ? { provider: 'turnstile', siteKey: '1x00000000000000000000AA' } : null,
    access: state === 'waitlist' ? 'waitlist' : 'open',
    supportEmail: 'help@tinytown.example',
  };
  const err = (status: number, error: string, code: string) => json({ error, code }, status);

  const real = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    if (!url.pathname.startsWith('/api/')) return real(input, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const route = `${method} ${url.pathname}`;
    // Long enough to see every loading state.
    await wait(url.pathname === ROUTES.config ? 60 : 450 + Math.random() * 350);
    const signedIn = state !== 'signedout';

    if (route === `GET ${ROUTES.config}`) return state === 'local' ? new Response('Not found', { status: 404 }) : json(config);
    if (route === `POST ${ROUTES.telemetry}`) return json({ ok: true });
    if (!signedIn) return err(401, 'Sign in to carry on.', 'unauthenticated');
    if (state === 'waitlist') return err(403, "TinyTown is invite-only for now, and this email isn't on the list yet.", 'not_invited');
    switch (route) {
      case `GET ${ROUTES.accountExport}`:
        return new Response(JSON.stringify({ user: me().user, plan: me().plan, world: me().world, actions }, null, 2), {
          headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="tinytown-mara-2026-10-13.json"' },
        });
      case `DELETE ${ROUTES.account}`:
        if (String(body.confirm).toLowerCase() !== 'mara@nightjar.dev') return err(400, "That email doesn't match this account.", 'bad_request');
        if (fail === 'delete') return err(502, "We couldn't finish deleting your account. Nothing more will be charged; try again in a moment.", 'upstream');
        return json({ ok: true, stillInstalled: [{ provider: 'stripe', url: 'https://dashboard.stripe.com/settings/apps' }, { provider: 'github', url: 'https://github.com/settings/installations' }] });
      case `GET ${ROUTES.me}`:
        return json(me());
      case `POST ${ROUTES.checkout}`:
        if (fail === 'checkout') return err(502, "Stripe didn't answer. Nothing was charged; try again in a moment.", 'upstream');
        return json({ url: hrefFor('paid-unconnected', { checkout: 'success' }) });
      case `POST ${ROUTES.portal}`:
        if (fail === 'portal') return err(502, "Couldn't open billing. Try again in a moment.", 'upstream');
        return json({ url: hrefFor(state, { mockportal: '1' }) });
      case `POST ${ROUTES.connectStripe}`:
        if (fail === 'connect') return err(502, "Stripe didn't answer. Try again in a moment.", 'upstream');
        return json({ url: hrefFor('paid-stripe', { connected: 'stripe' }) });
      case `POST ${ROUTES.connectGithub}`:
        if (fail === 'connect') return err(502, "GitHub didn't answer. Try again in a moment.", 'upstream');
        return json({ url: hrefFor('paid-github', { connected: 'github' }) });
      case `GET ${ROUTES.githubRepos}`:
        if (fail === 'repos') return err(502, "GitHub didn't answer. Try again in a moment.", 'upstream');
        return connections.github ? json({ repos: REPOS }) : err(400, 'Install the GitHub app first.', 'not_connected');
      case `PUT ${ROUTES.githubRepo}`:
        if (!connections.github) return err(400, 'Install the GitHub app first.', 'not_connected');
        connections.github = { ...connections.github, repo: String(body.repo) };
        return json(connections);
      case `PUT ${ROUTES.users}`: {
        if (fail === 'users') return err(400, "PostHog didn't accept that key. Check it has read access to the project.", 'bad_request');
        const r = body as unknown as UsersRequest;
        connections.users = r.source === 'manual' ? { source: 'manual', value: r.value, updatedAt: Date.now() } : r.source === 'posthog' ? { source: 'posthog', host: r.host, projectId: r.projectId, connectedAt: Date.now() } : { source: 'customers' };
        return json(connections);
      }
      case 'DELETE /api/connect/stripe':
        connections.stripe = null;
        return json({ ok: true });
      case 'DELETE /api/connect/github':
        connections.github = null;
        return json({ ok: true });
      case `PATCH ${ROUTES.world}`:
        return json({ ...me().world, ...body });
    }
    if (!paid) return err(402, 'This needs an active TinyTown plan.', 'payment_required');
    switch (route) {
      case `GET ${ROUTES.timeline}`:
        if (fail === 'timeline') return err(409, 'Stripe is not connected, or its access has expired.', 'not_connected');
        return json(timeline);
      case `GET ${ROUTES.actions}`:
        return json({ actions });
      case `POST ${ROUTES.actions}`:
        if (rejectNext) {
          rejectNext = false;
          return err(409, 'Not enough money: your treasury on another device already spent it', 'rejected');
        }
        actions = [...actions, body.action as Action];
        return json({ actions });
    }
    return err(404, `No mock for ${route}`, 'bad_request');
  };

  if (state === 'local') return null;
  return new MockAuth(state !== 'signedout');
}

class MockAuth implements AuthProvider {
  private signedIn: boolean;
  readonly redirectError: string | null = params.get('mockerr') === 'link' ? 'That sign-in link has expired or was already used. Send yourself a fresh one.' : null;

  constructor(signedIn: boolean) {
    this.signedIn = signedIn;
  }

  async restore(): Promise<AuthSession | null> {
    return this.signedIn ? { email: 'mara@nightjar.dev' } : null;
  }

  async token() {
    return this.signedIn ? 'mock-token' : null;
  }

  async signInWithEmail(email: string, _captchaToken?: string | null) {
    await wait(900);
    if (params.get('mockerr') === 'signin') throw new AuthError('Too many links in a short time. Wait a minute, then try again.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AuthError("That email address doesn't look right.");
  }

  async verifyEmailCode(_email: string, code: string) {
    await wait(700);
    if (code !== '123456') throw new AuthError("That code is wrong or has expired. Check it against the newest email, or send yourself a fresh one.");
    location.assign(hrefFor('unpaid'));
  }

  async signInWithOAuth(_provider: OAuthProvider) {
    await wait(700);
    location.assign(hrefFor('unpaid'));
  }

  async signOut() {
    await wait(300);
    this.signedIn = false;
  }
}

export function signedOutHref(): string {
  return hrefFor('signedout');
}
