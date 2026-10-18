/**
 * A pretend TinyTown API, for seeing every hosted state without a backend.
 * Dev server only (or a build made with `--mode mockapi`, for frozen
 * screenshots); main.ts imports it behind a compile-time guard, so a normal
 * production build never contains it.
 *
 *   /?mockapi=signedout          hosted, not signed in (the demo with "Make it yours")
 *   /?mockapi=unpaid             signed in, never paid, nothing connected (setup opens: it's free)
 *   /?mockapi=setup-stripe       never paid, Stripe connected mid-setup (step 2; add `&connected=stripe`)
 *   /?mockapi=setup-github       never paid, Stripe and GitHub installed, no repository picked
 *   /?mockapi=ready              never paid, set up: the paywall leads with their numbers; closing it shows the offer
 *   /?mockapi=offer              the same, with the first-year offer open (shown 3 hours ago)
 *   /?mockapi=offer-expired      the same, 48 hours on: the offer has ended and the paywall is the standard price
 *   /?mockapi=canceled           signed in, plan ended
 *   /?mockapi=paid-unconnected   paid, nothing connected (onboarding step 1)
 *   /?mockapi=paid-stripe        paid, Stripe connected (no world yet without ?connected; step 2)
 *   /?mockapi=paid-github        paid, Stripe and GitHub installed, no repository picked
 *   /?mockapi=connected          your own city on (demo-shaped) live data
 *   /?mockapi=pastdue            your city, with the last payment failed
 *   /?mockapi=local              no hosted accounts (today's behaviour)
 *   /?mockapi=waitlist           signed in, but the waitlist hasn't reached this email (403 not_invited)
 *   /?mockapi=stripe-broken      Stripe connected, but its access has died (timeline 409 not_connected: reconnect)
 *   /?mockapi=stripe-test        Stripe connected in test mode (setup warns that test data never moves the city)
 *   /?mockapi=github-gone        the GitHub App was uninstalled on GitHub (repositories 409: install again)
 *   /?mockapi=manual             your city, counting a number you set
 *   /?mockapi=composio           connected, with this server connecting Stripe and GitHub through Composio
 *   /?mockapi=ga4                your city, with Google Analytics offered (through Composio) in step 3; add
 *                                `&connected=ga4` to land back from Google with properties to pick
 *
 * Extras: `&mockerr=checkout|portal|signin|repos|users|connect|timeline|link` makes that call fail;
 * `&mockerr=posthog-key|posthog-project|repo|preview` fail the PostHog check, the repository pick, or
 * the numbers behind the setup cards; `&mockempty` gives a Stripe account with no subscriptions yet;
 * `&mocknodata` connects Stripe with no history yet (the paywall says the numbers are on their way);
 * `&mocknooffer` is a server with no offer configured.
 * `&mockreject` makes the server refuse the next build (409), to see the rollback.
 * `&mockcaptcha` turns on Turnstile with Cloudflare's always-pass test key.
 */
import { demoTimeline } from '../data/demo.ts';
import { demoActions } from '../game/demo-script.ts';
import type { Action } from '../game/economy.ts';
import type { AuthProvider, AuthSession, OAuthProvider } from './auth.ts';
import { AuthError } from './auth.ts';
import { OFFER_WINDOW_MS, ROUTES, type ConfigResponse, type Connections, type MeResponse, type Offer, type PlanStatus, type UsersRequest } from './contract.ts';
import { previewOf } from './preview.ts';

export type MockState =
  | 'waitlist'
  | 'signedout'
  | 'unpaid'
  | 'setup-stripe'
  | 'setup-github'
  | 'ready'
  | 'offer'
  | 'offer-expired'
  | 'canceled'
  | 'paid-unconnected'
  | 'paid-stripe'
  | 'paid-github'
  | 'connected'
  | 'pastdue'
  | 'local'
  | 'stripe-broken'
  | 'stripe-test'
  | 'github-gone'
  | 'manual'
  | 'composio'
  | 'ga4';

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
  /** Signed in and never paid: setup is free, the paywall comes when it's done. */
  const unpaid = ['unpaid', 'setup-stripe', 'setup-github', 'ready', 'offer', 'offer-expired'].includes(state);
  const paid = !unpaid && !['signedout', 'canceled', 'local', 'waitlist'].includes(state);
  const status: PlanStatus = state === 'pastdue' ? 'past_due' : state === 'canceled' ? 'canceled' : paid ? 'active' : 'none';
  const timeline = { ...demoTimeline(), source: 'live' as const, integrations: { stripe: true, github: true } };
  let actions: Action[] = demoActions(timeline.snapshots);
  let rejectNext = params.has('mockreject');

  // Back from an install a moment ago (`&connected=…`): the setup dialog celebrates it.
  const justNow = (p: string) => (params.get('connected') === p ? now - 4_000 : now - 40 * DAY);
  const hasStripe = ['paid-stripe', 'paid-github', 'connected', 'pastdue', 'stripe-broken', 'stripe-test', 'github-gone', 'manual', 'composio', 'ga4', 'setup-stripe', 'setup-github', 'ready', 'offer', 'offer-expired'].includes(state);
  const hasGithub = ['paid-github', 'connected', 'pastdue', 'github-gone', 'manual', 'composio', 'ga4', 'setup-github', 'ready', 'offer', 'offer-expired'].includes(state);
  // The first-year offer, as the server keeps it: shown once, open 48 hours from then.
  let offer: Offer | null = unpaid && !params.has('mocknooffer') ? { status: 'unseen', available: true, expiresAt: null, amount: 900, regular: 2900, currency: 'usd' } : null;
  if (offer && state === 'offer') offer = { ...offer, status: 'open', expiresAt: now - 3 * 3_600_000 + OFFER_WINDOW_MS };
  if (offer && state === 'offer-expired') offer = { ...offer, status: 'expired', available: false, expiresAt: now - 3 * 3_600_000 };
  // Google Analytics: linked once back from Google (`&connected=ga4`).
  const ga4Linked = params.get('connected') === 'ga4';
  const connections: Connections = {
    stripe: hasStripe ? { account: 'acct_1PxNightjar', name: state === 'composio' ? 'Nightjar' : null, livemode: state !== 'stripe-test', connectedAt: justNow('stripe') } : null,
    github: hasGithub ? { installationId: 51_204_877, repo: state === 'paid-github' || state === 'setup-github' || state === 'github-gone' ? null : 'nightjar-hq/nightjar', connectedAt: justNow('github') } : null,
    users:
      state === 'connected' || state === 'pastdue' || state === 'composio'
        ? { source: 'posthog', host: 'https://eu.posthog.com', projectId: '48213', connectedAt: now - 38 * DAY }
        : state === 'manual'
          ? { source: 'manual', value: 2_400, updatedAt: now - 12 * DAY }
          : { source: 'customers' },
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
    world: { seed: Number(params.get('seed')) || 0, name: 'Nightjar', joinedAt: unpaid ? null : timeline.snapshots.at(-1)!.t - 40 * DAY, lastSeen: unpaid ? null : timeline.snapshots.at(-6)!.t },
    setup: { complete: !!connections.stripe },
    offer: paid ? null : offer,
  });
  const config: ConfigResponse = {
    hosted: state !== 'local',
    supabase: state !== 'local' ? { url: 'https://mock.supabase.co', anonKey: 'mock-anon-key' } : null,
    // TinyTown is sold by the year. `&mockmonthly` adds the old monthly price, as a server still configured with one would.
    plans: [...(params.has('mockmonthly') ? [{ interval: 'month' as const, amount: 1200, currency: 'usd' }] : []), { interval: 'year', amount: 2900, currency: 'usd' }],
    connect: { stripe: true, github: true, posthog: true, ...(state === 'composio' ? { via: { stripe: 'composio', github: 'composio' } } : {}), ...(state === 'ga4' ? { ga4: true } : {}) } as ConfigResponse['connect'],
    captcha: params.has('mockcaptcha') ? { provider: 'turnstile', siteKey: '1x00000000000000000000AA' } : null,
    access: state === 'waitlist' ? 'waitlist' : 'open',
    supportEmail: 'help@tinytown.example',
  };
  const err = (status: number, error: string, code: string) => json({ error, code }, status);

  const emailPrefs = { weeklyDigest: true, productUpdates: true };
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
      case `GET ${ROUTES.emailPrefs}`:
        return json(emailPrefs);
      case `PUT ${ROUTES.emailPrefs}`:
        if (fail === 'email') return err(502, "Couldn't save that just now. Try again in a moment.", 'upstream');
        Object.assign(emailPrefs, body);
        return json(emailPrefs);
      case `POST ${ROUTES.checkout}`:
        if (fail === 'checkout') return err(502, "Stripe didn't answer. Nothing was charged; try again in a moment.", 'upstream');
        if (body.offer === true && offer?.status !== 'open') return err(409, 'That offer ended 48 hours after it was first shown. The standard price is still on sale.', 'rejected');
        // Set up first (the usual order): paying opens the city. Paid before connecting: setup next.
        return json({ url: connections.stripe ? hrefFor('connected', { checkout: 'success' }) : hrefFor('paid-unconnected', { checkout: 'success' }) });
      case `POST ${ROUTES.offerSeen}`:
        if (offer?.status === 'unseen') offer = { ...offer, status: 'open', expiresAt: Date.now() + OFFER_WINDOW_MS };
        return json({ offer });
      case `POST ${ROUTES.paywallSeen}`:
        return json({ ok: true });
      case `GET ${ROUTES.preview}`: {
        if (fail === 'preview') return err(502, 'Stripe took too long to respond. Try again in a moment.', 'upstream');
        if (state === 'stripe-broken') return err(409, 'Your Stripe connection has expired. Connect Stripe again.', 'not_connected');
        if (!connections.stripe && !connections.github?.repo) return err(409, 'Connect Stripe or choose a GitHub repository to build your city.', 'not_connected');
        if (params.has('mocknodata')) return json({ ...previewOf({ ...timeline, snapshots: [] }), name: 'Nightjar' });
        const snaps = params.has('mockempty') ? timeline.snapshots.map((x) => ({ ...x, mrr: 0, customers: 0 })) : timeline.snapshots;
        const users = connections.users.source === 'manual' ? connections.users.value : connections.users.source === 'customers' ? undefined : null;
        const live = snaps.map((x) => ({ ...x, users: users === undefined ? undefined : (users ?? x.users) }));
        return json({ ...previewOf({ ...timeline, snapshots: live, integrations: { stripe: !!connections.stripe, github: !!connections.github?.repo } }), name: 'Nightjar' });
      }
      case `POST ${ROUTES.portal}`:
        if (fail === 'portal') return err(502, "Couldn't open billing. Try again in a moment.", 'upstream');
        return json({ url: hrefFor(state, { mockportal: '1' }) });
      case `POST ${ROUTES.connectStripe}`:
        if (fail === 'connect') return err(502, "Stripe didn't answer. Try again in a moment.", 'upstream');
        return json({ url: hrefFor(paid ? 'paid-stripe' : 'setup-stripe', { connected: 'stripe' }) });
      case `POST ${ROUTES.connectGithub}`:
        if (fail === 'connect') return err(502, "GitHub didn't answer. Try again in a moment.", 'upstream');
        return json({ url: hrefFor(paid ? 'paid-github' : 'setup-github', { connected: 'github' }) });
      case `GET ${ROUTES.githubRepos}`:
        if (fail === 'repos') return err(502, "GitHub didn't answer. Try again in a moment.", 'upstream');
        if (state === 'github-gone') return err(409, 'The TinyTown GitHub App was uninstalled. Connect GitHub again.', 'not_connected');
        return connections.github ? json({ repos: REPOS }) : err(400, 'Install the GitHub app first.', 'not_connected');
      case `PUT ${ROUTES.githubRepo}`:
        if (!connections.github) return err(400, 'Install the GitHub app first.', 'not_connected');
        if (fail === 'repo') return err(400, "TinyTown can't see that repository. Add it to the app's access on GitHub.", 'bad_request');
        connections.github = { ...connections.github, repo: String(body.repo) };
        return json(connections);
      case `PUT ${ROUTES.users}`: {
        if (fail === 'users') return err(400, "PostHog didn't accept that key. Check it has read access to the project.", 'bad_request');
        if (body.source === 'posthog' && fail === 'posthog-key') return err(409, "PostHog didn't accept the API key. Check it has Query read access.", 'not_connected');
        if (body.source === 'posthog' && fail === 'posthog-project') return err(409, "PostHog couldn't find that project id.", 'not_connected');
        if (body.source === 'ga4') {
          if (!ga4Linked) return err(409, 'Connect Google Analytics first.', 'not_connected');
          if (body.test === true) return json({ ok: true, source: 'ga4', monthlyActiveUsers: 3_910, asOf: now - (now % DAY), days: 364 });
          connections.users = { source: 'ga4', property: String(body.property), propertyName: String(body.propertyName ?? ''), connectedAt: Date.now() } as unknown as Connections['users'];
          return json(connections);
        }
        // `test: true` checks the key and saves nothing (server/users.ts).
        if (body.test === true) return json({ ok: true, source: 'posthog', monthlyActiveUsers: 2_340, asOf: now - (now % DAY), days: 365 });
        const r = body as unknown as UsersRequest;
        connections.users = r.source === 'manual' ? { source: 'manual', value: r.value, updatedAt: Date.now() } : r.source === 'posthog' ? { source: 'posthog', host: r.host, projectId: r.projectId, connectedAt: Date.now() } : { source: 'customers' };
        return json(connections);
      }
      case 'POST /api/connect/ga4':
        return json({ url: hrefFor('ga4', { connected: 'ga4' }) });
      case 'GET /api/connect/ga4/properties':
        if (!ga4Linked) return err(409, 'Connect Google Analytics first.', 'not_connected');
        return json({
          properties: [
            { id: '314159265', name: 'nightjar.dev', account: 'Nightjar' },
            { id: '271828182', name: 'Nightjar app (iOS and Android)', account: 'Nightjar' },
            { id: '161803398', name: 'Mara’s blog', account: 'Mara Okafor' },
          ],
        });
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
        if (fail === 'timeline' || state === 'stripe-broken') return err(409, 'Your Stripe connection has expired. Connect Stripe again.', 'not_connected');
        if (fail === 'preview') return err(502, 'Stripe took too long to respond. Try again in a moment.', 'upstream');
        if (!connections.stripe && !connections.github?.repo) return err(409, 'Connect Stripe or choose a GitHub repository to build your city.', 'not_connected');
        if (params.has('mockempty')) return json({ ...timeline, snapshots: timeline.snapshots.map((x) => ({ ...x, mrr: 0, customers: 0 })) });
        return json({ ...timeline, integrations: { stripe: !!connections.stripe, github: !!connections.github?.repo } });
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
