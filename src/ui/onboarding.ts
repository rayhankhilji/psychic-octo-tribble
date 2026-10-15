/**
 * Setup, free and before paying (or after, for a founder who paid first):
 * connect Stripe (required), GitHub (optional, then pick a repository), and
 * say where active users come from. Each connector is a
 * card that says, exactly and before anything is installed, what TinyTown
 * reads and what it never can (the lists match the server code: see
 * docs/CONNECTORS.md), then shows what the connection found, from the same
 * timeline the city is built from. Installs leave for Stripe or GitHub and
 * come back to `/?connected=…`, which reopens this at the next step.
 */
import { ApiRequestError, type Api } from '../api/client.ts';
import type { ConfigResponse, Connections, MeResponse, PreviewResponse, ReposResponse, RevenueFacts, UsersRequest } from '../api/contract.ts';
import { FREE_HOUSED, MRR_PER_USER, RATE } from '../game/economy.ts';
import { brandMark, brandTile, type BrandName } from './brand-icons.ts';
import { busy, focusFirst, makeDialog, message } from './dialogs.ts';
import { compact, escape, showModal } from './dom.ts';
import { ICON } from './icons.ts';

type Step = 1 | 2 | 3;
type Repo = ReposResponse['repos'][number];

/**
 * Google Analytics comes through Composio and only exists once the server
 * offers it (see docs/CONNECTORS.md); until the contract carries it, its
 * calls arrive through `OnboardingDeps.ga4` and its source is read here.
 */
type Ga4Source = { source: 'ga4'; property: string; propertyName: string | null; connectedAt: number };
type AnyUsersSource = Connections['users'] | Ga4Source;
type UsersChoice = AnyUsersSource['source'];
export interface Ga4Property {
  id: string;
  name: string;
  account: string;
}

/** What "Test connection" answers (server/users.ts `UsersTestResult`). */
export interface UsersTest {
  ok: true;
  source: 'posthog' | 'ga4';
  monthlyActiveUsers: number | null;
  asOf: number | null;
  days: number;
}

export interface OnboardingDeps {
  api: Api;
  config: ConfigResponse;
  me(): MeResponse;
  /** The connections changed: keep the shell's copy of /api/me current. */
  onConnections(c: Connections): void;
  go(url: string): void;
  /** "Build my city" (or "Back to my city" when it's already open behind us). */
  finish(): void;
  /** True when the founder's city is already on screen. */
  inWorld: boolean;
  /** Google Analytics through Composio, when the server offers it. */
  ga4?: {
    connect(): Promise<{ url: string }>;
    properties(): Promise<Ga4Property[]>;
    save(property: Ga4Property, test: boolean): Promise<Connections | UsersTest>;
  };
}

// ─── What each connector reads, from the server code ────────────────────

type Via = 'native' | 'composio';

/** How this server connects a provider (`config.connect.via`, when the server says; otherwise our own apps). */
export function viaOf(config: ConfigResponse, provider: 'stripe' | 'github'): Via {
  const via = (config.connect as ConfigResponse['connect'] & { via?: Partial<Record<'stripe' | 'github', Via>> }).via;
  return via?.[provider] === 'composio' ? 'composio' : 'native';
}

export interface ConnectorFacts {
  brand: BrandName;
  name: string;
  /** What it powers, in a line. */
  powers: string;
  reads: string[];
  never: string[];
  /** The exact grant, for people who check. */
  grant: string;
  readOnly: boolean;
  time: string;
}

export function stripeFacts(via: Via): ConnectorFacts {
  const common = {
    brand: 'stripe' as const,
    name: 'Stripe',
    powers: 'Your MRR and paying customers: the money and the people in your city.',
    reads: [
      'Your subscriptions: price, quantity, currency and status',
      'When each one started, left its trial or ended, back to your first',
    ],
    time: 'About a minute',
  };
  if (via === 'composio')
    return {
      ...common,
      never: ['Charges, refunds or changes: TinyTown only ever lists subscriptions', 'Your card and bank details'],
      grant: 'Through Composio: Stripe Connect read_write (Stripe offers no read-only access to new apps)',
      readOnly: false,
    };
  return {
    ...common,
    never: ["Customers' names, emails or cards: the app has no permission to read them", 'Charge, refund, cancel or change anything'],
    grant: 'Stripe App permissions: subscription_read, plan_read',
    readOnly: true,
  };
}

export function githubFacts(via: Via): ConnectorFacts {
  const common = {
    brand: 'github' as const,
    name: 'GitHub',
    powers: 'Every release adds a floor to your HQ; commits speed up the train.',
    reads: ['Release names and dates, and commit dates, from the one repository you pick', 'The list of repositories, so you can pick'],
    time: 'About a minute',
  };
  if (via === 'composio')
    return {
      ...common,
      never: ['Your code: TinyTown asks only for release and commit dates', 'Push, open issues or pull requests, or change settings'],
      grant: 'Through Composio: GitHub OAuth with the repo scope (read and write; GitHub has no read-only scope for private repositories)',
      readOnly: false,
    };
  return {
    ...common,
    never: ["Repositories you don't share with the app", 'Push code, open issues or pull requests, or change settings'],
    grant: 'GitHub App permissions: Contents read-only, Metadata read-only',
    readOnly: true,
  };
}

export const POSTHOG_FACTS: ConnectorFacts = {
  brand: 'posthog',
  name: 'PostHog',
  powers: 'Monthly active users: everyone who uses your product, paying or not.',
  reads: ['One number a day: people active in the last 30 days, from a single trends query over the past year'],
  never: ['Events, people, properties or recordings: the query returns only a count per day', 'Your key, once saved: it is stored encrypted and never shown again'],
  grant: 'A personal API key with the Query: Read scope',
  readOnly: true,
  time: 'About two minutes',
};

export const GA4_FACTS: ConnectorFacts = {
  brand: 'ga4',
  name: 'Google Analytics',
  powers: 'Monthly active users from one GA4 property.',
  reads: ['One number a day: active users over the last 28 days, for the property you pick'],
  never: ['Pages, events, audiences or anything about one person: the report is counts only'],
  // The auth config must request only this scope (docs/CONNECTORS.md), or "Read-only" isn't true.
  grant: 'Through Composio: Google scope analytics.readonly',
  readOnly: true,
  time: 'About a minute',
};

// ─── What a connection found (the timeline the city is built from) ──────

function money(n: number, currency: string, cents = false): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: cents ? 2 : 0, minimumFractionDigits: cents ? 2 : 0 }).format(n);
  } catch {
    return `${n.toLocaleString('en-US', { maximumFractionDigits: cents ? 2 : 0 })} ${currency.toUpperCase()}`;
  }
}

const monthYear = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

// The facts themselves are worked out by src/api/preview.ts (the server sends them as `GET /api/preview`);
// re-exported so the account dialog and tests can read a full timeline the same way.
export { revenueFacts, shippingFacts, type RevenueFacts, type ShippingFacts } from '../api/preview.ts';

/** The MRR it takes to house everyone (the game's rule: $0.20 each beyond the first 100). */
export function housingNeed(users: number): number {
  return users <= FREE_HOUSED ? 0 : Math.round(users * MRR_PER_USER * 100) / 100;
}

/** A tiny MRR line: honest (every point is a real day), no axes, scaled to its own range. */
function sparkline(values: number[]): string {
  if (values.length < 2) return '';
  const w = 120;
  const h = 32;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 2 - (v / max) * (h - 6)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path class="spark-area" d="${line}L${w} ${h}L0 ${h}Z"/><path class="spark-line" d="${line}"/></svg>`;
}

// ─── Small pieces ───────────────────────────────────────────────────────

const POSTHOG_HOSTS = [
  { id: 'us', label: 'US cloud', host: 'https://us.posthog.com' },
  { id: 'eu', label: 'EU cloud', host: 'https://eu.posthog.com' },
  { id: 'self', label: 'Self-hosted', host: '' },
] as const;

/** "acct_1PxN…ghtjar": enough to recognise, not the whole thing. */
export function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 9)}…${id.slice(-4)}` : id;
}

export function shortDate(t: number): string {
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function hostLabel(host: string): string {
  try {
    return new URL(host).host;
  } catch {
    return host;
  }
}

/** The card's header: logo, name, what it powers, and the badges that matter before installing. */
export function connectorHead(f: ConnectorFacts, status: string): string {
  return `
    <div class="cx-head">
      ${brandTile(f.brand, 'lg')}
      <div class="cx-title">
        <b>${f.name}</b>
        <small>${f.powers}</small>
      </div>
      ${status}
    </div>`;
}

/** Reads and never, side by side, and the exact grant underneath. */
export function scopeLists(f: ConnectorFacts): string {
  const li = (icon: string, text: string) => `<li>${icon}<span>${text}</span></li>`;
  return `
    <div class="cx-scope" role="group" aria-label="What TinyTown can see">
      <div class="cx-col can"><span class="cx-label">TinyTown reads</span><ul>${f.reads.map((r) => li(ICON.check, r)).join('')}</ul></div>
      <div class="cx-col cannot"><span class="cx-label">${f.readOnly ? 'It never can' : 'It never does'}</span><ul>${f.never.map((r) => li(ICON.close, r)).join('')}</ul></div>
    </div>
    <p class="cx-grant">${f.readOnly ? ICON.shield : ICON.alert}<span>${escape(f.grant)}</span></p>`;
}

export function badges(f: ConnectorFacts): string {
  return `<span class="cx-badges">${f.readOnly ? `<span class="pill good">${ICON.lock}Read-only</span>` : `<span class="pill warn">${ICON.alert}Read and write</span>`}<span class="pill">${ICON.speed}${f.time}</span></span>`;
}

export type CardState = 'off' | 'connected' | 'broken' | 'pending';

export function statusPill(state: CardState, optional = false): string {
  if (state === 'connected') return `<span class="cx-status on">${ICON.check}Connected</span>`;
  if (state === 'broken') return `<span class="cx-status bad">${ICON.alert}Needs reconnecting</span>`;
  if (state === 'pending') return `<span class="cx-status pending"><i aria-hidden="true"></i>Connecting…</span>`;
  return optional ? '<span class="cx-status">Optional</span>' : '<span class="cx-status req">Required</span>';
}

/** Who's connected: logo, name, the identifying details, and actions. */
export function identityRow(brand: BrandName, name: string, meta: string, actions = ''): string {
  return `
    <div class="cx-who">
      ${brandTile(brand, 'sm')}
      <span class="cx-who-text"><b>${name}</b><small class="num">${meta}</small></span>
      ${actions ? `<span class="cx-who-actions">${actions}</span>` : ''}
    </div>`;
}

/** An error with what to do about it: the server's sentence, and the one button that fixes it. */
function problem(text: string, action = '', tone: 'bad' | 'warn' = 'bad'): string {
  return `<div class="cx-problem tone-${tone}" ${tone === 'bad' ? 'role="alert"' : ''}>${ICON.alert}<div><p>${escape(text)}</p>${action ? `<div class="cx-problem-actions">${action}</div>` : ''}</div></div>`;
}

/** Stats in a row: big number, small label. */
function stats(items: [string, string][], extra = ''): string {
  return `<div class="cx-stats">${items.map(([v, l]) => `<span class="cx-stat"><b class="num">${v}</b><small>${l}</small></span>`).join('')}${extra}</div>`;
}

type PreviewState = { state: 'idle' } | { state: 'loading' } | { state: 'ready'; p: PreviewResponse } | { state: 'error'; err: unknown };

// ─── The dialog ─────────────────────────────────────────────────────────

export class OnboardingDialog {
  private d: HTMLDialogElement;
  private deps: OnboardingDeps;
  private step: Step = 1;
  private welcome = false;
  private error: { step: Step; text: string } | null = null;
  private skippedGithub = false;
  private repos: Repo[] | null = null;
  private reposError: ApiRequestError | Error | null = null;
  private query = '';
  private changingRepo = false;
  private usersChoice: UsersChoice = 'customers';
  private posthogRegion: (typeof POSTHOG_HOSTS)[number]['id'] = 'us';
  private replacingKey = false;
  private saved: Step | null = null;
  private stripeBroken = false;
  private connecting: 'stripe' | 'github' | 'ga4' | null = null;
  private preview: PreviewState = { state: 'idle' };
  /** A step that just finished: its check draws in, and the next step slides up. */
  private fresh: Step | null = null;
  private test: { state: 'idle' } | { state: 'busy' } | { state: 'ok'; result: UsersTest } | { state: 'bad'; text: string; field: string | null } = { state: 'idle' };
  private fieldErrors: Record<string, string> = {};
  private ga4Props: Ga4Property[] | 'loading' | 'none' | { error: string } | null = null;
  private ga4Pick: string | null = null;
  private live: HTMLElement;
  private body: HTMLElement;

  constructor(deps: OnboardingDeps) {
    this.deps = deps;
    this.d = makeDialog('onboard-dialog', 'onboard-title');
    this.body = document.createElement('div');
    this.live = document.createElement('p');
    this.live.className = 'sr-only';
    this.live.setAttribute('role', 'status');
    this.d.append(this.body, this.live);
    this.d.addEventListener('click', (e) => void this.onClick(e));
    this.d.addEventListener('input', (e) => this.onInput(e));
    this.d.addEventListener('change', (e) => this.onChange(e));
    this.d.addEventListener('focusout', (e) => this.onBlur(e));
    this.d.addEventListener('keydown', (e) => this.onKey(e));
    this.d.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.saveUsers(e.target as HTMLFormElement);
    });
  }

  open(opts: { step?: Step; welcome?: boolean; error?: string | null; stripeBroken?: boolean } = {}) {
    const c = this.deps.me().connections;
    this.welcome = !!opts.welcome;
    this.stripeBroken = !!opts.stripeBroken;
    this.step = opts.step ?? (c.stripe ? (c.github?.repo ? 3 : 2) : 1);
    this.error = opts.error ? { step: this.step, text: opts.error } : null;
    this.connecting = null;
    this.test = { state: 'idle' };
    this.fieldErrors = {};
    this.usersChoice = this.users.source;
    if (this.users.source === 'posthog') {
      const host = this.users.host;
      this.posthogRegion = POSTHOG_HOSTS.find((h) => h.host && h.host === host)?.id ?? 'self';
    }
    // Back from an install a moment ago (`?connected=…` lands here): that step's check draws in.
    const recent = (t: number | undefined) => t != null && Date.now() - t < 3 * 60_000;
    this.fresh = !opts.error && this.step === 2 && !c.github && recent(c.stripe?.connectedAt) ? 1 : null;
    this.render();
    showModal(this.d);
    focusFirst(this.d, `[data-step="${this.step}"] [data-autofocus], [data-step="${this.step}"] .step-toggle`);
    if (this.step === 2 && c.github && !c.github.repo) void this.loadRepos();
    if (this.step === 3 && this.usersChoice === 'ga4') void this.loadGa4();
    this.loadPreview();
  }

  private get c(): Connections {
    return this.deps.me().connections;
  }

  private get users(): AnyUsersSource {
    return this.c.users as AnyUsersSource;
  }

  /**
   * The numbers behind the cards, from the timeline the city runs on (the
   * headline numbers only: setup is free, the city isn't). Cached by the
   * server, so cheap.
   */
  private loadPreview(force = false) {
    const c = this.c;
    if (!c.stripe && !c.github?.repo) return;
    if (!force && (this.preview.state === 'loading' || this.preview.state === 'ready')) return;
    this.preview = { state: 'loading' };
    this.deps.api
      .preview()
      .then((p) => {
        this.preview = { state: 'ready', p };
      })
      .catch((err: unknown) => {
        this.preview = { state: 'error', err };
        // The data says the connection is dead: show it as broken, with the way back.
        // (Test mode never feeds a city, so its 409 isn't a break: the test-mode warning already says why.)
        if (err instanceof ApiRequestError && err.code === 'not_connected' && c.stripe?.livemode) this.stripeBroken = true;
      })
      .finally(() => {
        if (this.d.open) this.rerender();
      });
  }

  /** Re-render without losing the reader's place: focus goes back to the same control if it still exists. */
  private rerender() {
    const active = document.activeElement as HTMLElement | null;
    let sel: string | null = null;
    if (active && this.d.contains(active)) {
      const name = active.getAttribute('name');
      if (active.dataset.act) sel = `[data-act="${active.dataset.act}"]`;
      else if (name) sel = `[name="${name}"]${active instanceof HTMLInputElement && active.type === 'radio' ? `[value="${active.value}"]` : ''}`;
      else if (active.dataset.goto) sel = `[data-goto="${active.dataset.goto}"]`;
    }
    // Whatever was typed and not yet saved survives (a key included: it never leaves the page until Save).
    const typed: Record<string, string> = {};
    for (const i of this.d.querySelectorAll<HTMLInputElement>('.users-form input[name]:not([type=radio])')) if (i.value !== i.defaultValue) typed[i.name] = i.value;
    this.render();
    this.restoreFields(typed);
    if (sel) this.d.querySelector<HTMLElement>(sel)?.focus({ preventScroll: true });
  }

  private render() {
    const c = this.c;
    const u = this.users;
    const done = (s: Step) => (s === 1 ? !!c.stripe && !this.stripeBroken : s === 2 ? !!c.github?.repo : u.source !== 'customers' || this.saved === 3);
    const state = (s: Step) => (s === this.step ? 'current' : done(s) ? 'done' : 'todo');
    const node = (s: Step) => `<span class="step-node" aria-hidden="true">${done(s) ? ICON.check : s}</span>`;
    const badge = (s: Step) =>
      s === 1 && this.stripeBroken
        ? '<span class="status bad">Needs reconnecting</span>'
        : done(s)
          ? `<span class="status on">${ICON.check}${s === 3 ? 'Set' : 'Connected'}</span>`
          : s === 1
            ? '<span class="status req">Required</span>'
            : s === 2 && this.skippedGithub
              ? '<span class="status">Skipped</span>'
              : '<span class="status">Optional</span>';
    const summary = (s: Step) => {
      if (s === 1) {
        if (!c.stripe) return '<span>MRR and paying customers, read-only</span>';
        const r = this.preview.state === 'ready' && !this.stripeBroken ? this.preview.p.revenue : null;
        const found = r && r.since != null ? ` · ${money(r.mrr, r.currency)} MRR · ${r.customers.toLocaleString('en-US')} paying` : '';
        return `${brandMark('stripe')}<span>${escape(c.stripe.name ?? `Stripe account ${shortId(c.stripe.account)}`)}${c.stripe.livemode ? '' : ' · test mode'}${found}</span>`;
      }
      if (s === 2) return c.github?.repo ? `${brandMark('github')}<span>${escape(c.github.repo)}</span>` : c.github ? '<span>Installed: pick a repository</span>' : '<span>Releases and commits, read-only</span>';
      if (u.source === 'manual') return `${brandMark('manual')}<span>${u.value.toLocaleString('en-US')} you set</span>`;
      if (u.source === 'posthog') return `${brandMark('posthog')}<span>PostHog · ${escape(hostLabel(u.host))}</span>`;
      if (u.source === 'ga4') return `${brandMark('ga4')}<span>Google Analytics · ${escape(u.propertyName ?? u.property)}</span>`;
      return `${brandMark('customers')}<span>Paying customers</span>`;
    };
    const step = (s: Step, title: string, content: () => string) => `
      <li class="step" data-step="${s}" data-state="${state(s)}" ${this.fresh === s ? 'data-fresh' : ''} ${this.fresh && this.fresh + 1 === s ? 'data-enter' : ''}>
        ${node(s)}
        <div class="step-main">
          <button class="step-toggle" type="button" data-goto="${s}" aria-expanded="${s === this.step}" aria-controls="step-${s}-body">
            <span class="step-title"><b>${title}</b><small>${summary(s)}</small></span>
            ${badge(s)}
          </button>
          <div class="step-body" id="step-${s}-body" ${s === this.step ? '' : 'hidden'}>
            ${s === this.step ? content() : ''}
          </div>
        </div>
      </li>`;
    const ready = !!c.stripe && !this.stripeBroken;
    // Never paid: setup is free, and the plan comes when the city opens ("Build my city" leads there).
    const free = this.deps.me().plan.status === 'none';
    const intro = this.welcome
      ? 'Your plan is active. Three short steps and your city runs on your real numbers.'
      : this.stripeBroken
        ? 'Your city and everything you built are safe. It just needs Stripe again to keep up with your revenue.'
        : free
          ? "Three short steps and your city runs on your real numbers. Free to set up. You'll only pay when you open your city."
          : 'Three short steps and your city runs on your real numbers. About two minutes.';
    const hint = ready
      ? free
        ? 'Stripe is connected. Your city is ready to open.'
        : 'Stripe is connected. You can change any of this later in your account.'
      : this.stripeBroken
        ? 'Reconnect Stripe to bring your city back.'
        : 'Connect Stripe to build your city: it runs on your revenue.';
    this.body.className = 'dialog-body onboard';
    this.body.innerHTML = `
      <header class="dialog-head">
        <span class="tile ${this.welcome ? 'tone-good' : this.stripeBroken ? 'tone-bad' : 'tone-brand'}">${this.welcome ? ICON.check : this.stripeBroken ? ICON.unlink : ICON.plug}</span>
        <div>
          <h2 id="onboard-title">${this.welcome ? "You're in. Thank you." : this.stripeBroken ? 'Reconnect Stripe' : 'Set up your city'}</h2>
          <p>${intro}</p>
        </div>
        <button class="btn ghost icon-only close" type="button" data-act="close" aria-label="Close">${ICON.close}</button>
      </header>
      <ol class="steps">
        ${step(1, 'Connect Stripe', () => this.stripeStep())}
        ${step(2, 'Connect GitHub', () => this.githubStep())}
        ${step(3, 'Where your active users come from', () => this.usersStep())}
      </ol>
      <footer class="dialog-actions onboard-foot">
        <span class="onboard-hint">${ready ? ICON.check : ICON.info}<span>${hint}</span></span>
        <button class="btn primary lg finish" type="button" data-act="finish" ${ready ? '' : 'disabled aria-disabled="true"'}>${ready ? ICON.build : ICON.lock}<span class="label">${this.deps.inWorld ? 'Back to my city' : this.stripeBroken ? 'Open my city' : 'Build my city'}</span></button>
      </footer>`;
  }

  /** A failed call, with the button that recovers from it. */
  private failure(err: unknown, retryAct: string, retryLabel: string): string {
    const text = err instanceof Error ? err.message : "That didn't work. Try again.";
    if (err instanceof ApiRequestError && err.code === 'rate_limited') return problem(text, '', 'warn');
    const help = this.deps.config.supportEmail ? `<a class="linkish" href="mailto:${escape(this.deps.config.supportEmail)}">Write to us</a>` : '';
    return problem(text, `<button class="btn sm" type="button" data-act="${retryAct}">${ICON.refresh}<span class="label">${retryLabel}</span></button>${help}`);
  }

  private stepError(s: Step): string {
    return this.error?.step === s ? this.error.text : '';
  }

  // ── Step 1: Stripe ─────────────────────────────────────────────────────

  private stripeStep(): string {
    const s = this.c.stripe;
    const via = viaOf(this.deps.config, 'stripe');
    const f = stripeFacts(via);
    const installLabel = via === 'composio' ? 'Connect Stripe' : 'Install on Stripe';
    const err = this.stepError(1);
    if (!s) {
      if (!this.deps.config.connect.stripe) return `<div class="cx">${connectorHead(f, '')}${message('info', "Connecting Stripe isn't set up on this server yet.")}</div>`;
      const pending = this.connecting === 'stripe';
      return `
        <div class="cx" ${pending ? 'data-pending' : ''}>
          ${connectorHead(f, pending ? statusPill('pending') : '')}
          ${badges(f)}
          ${scopeLists(f)}
          ${err ? problem(err) : ''}
          <div class="cx-actions">
            <button class="btn primary" type="button" data-act="connect-stripe" data-autofocus>${ICON.external}<span class="label">${installLabel}</span></button>
            <span class="step-aside">${via === 'composio' ? "You'll approve it on Stripe through Composio, then come straight back." : "You'll approve it on Stripe, then come straight back here."}</span>
          </div>
        </div>`;
    }
    const broken = this.stripeBroken;
    const name = escape(s.name ?? 'Your Stripe account');
    const meta = `${escape(shortId(s.account))} · ${s.livemode ? 'Live mode' : 'Test mode'} · since ${shortDate(s.connectedAt)}`;
    return `
      <div class="cx ${broken ? 'is-broken' : 'is-on'}">
        ${identityRow('stripe', name, meta, broken ? '' : `<button class="btn sm ghost" type="button" data-act="connect-stripe">${ICON.refresh}<span class="label">Reconnect</span></button>`)}
        ${
          broken
            ? problem(
                err || "TinyTown can't read your subscriptions any more: the app was removed from your Stripe account, or its access expired.",
                `<button class="btn primary sm" type="button" data-act="connect-stripe" data-autofocus>${ICON.refresh}<span class="label">Reconnect on Stripe</span></button><span class="step-aside">Same app, same read-only access.</span>`,
              )
            : err
              ? problem(err, `<button class="btn sm" type="button" data-act="connect-stripe">${ICON.refresh}<span class="label">Try again</span></button>`)
              : ''
        }
        ${s.livemode ? '' : message('warn', 'This is a test-mode account. Test data never moves your city: install the app in live mode to use your real revenue.')}
        ${broken || !s.livemode ? '' : this.revenuePreview()}
      </div>
      ${broken ? '' : `<div class="step-actions"><button class="btn" type="button" data-goto="2" data-autofocus>Next: GitHub${ICON.arrowRight}</button></div>`}`;
  }

  private revenuePreview(): string {
    const p = this.preview;
    if (p.state === 'loading' || p.state === 'idle')
      return `<div class="cx-found is-loading" aria-busy="true"><span class="cx-found-label">Reading your subscriptions…</span>${stats([['—', 'MRR'], ['—', 'paying customers'], ['—', 'history from']])}</div>`;
    if (p.state === 'error') {
      if (p.err instanceof ApiRequestError && p.err.code === 'not_connected') return '';
      return `<div class="cx-found">${this.failure(p.err, 'retry-preview', 'Read them again')}</div>`;
    }
    const r = p.p.revenue;
    if (!r || r.since == null)
      return `<div class="cx-found"><span class="cx-found-label">${ICON.info}Connected. No paying subscriptions yet, so your city starts small and grows with your first customer.</span></div>`;
    const budget = r.mrr * RATE;
    return `
      <div class="cx-found">
        <span class="cx-found-label">${ICON.sparkle}What your city runs on</span>
        ${stats(
          [
            [money(r.mrr, r.currency), 'MRR'],
            [r.customers.toLocaleString('en-US'), r.customers === 1 ? 'paying customer' : 'paying customers'],
            [monthYear(r.since), 'history from'],
          ],
          sparkline(r.spark),
        )}
        <p class="cx-found-note">Every $1 of MRR is $10,000 to build with: about <b class="num">$${compact(budget)}</b> a month for your city.</p>
      </div>`;
  }

  // ── Step 2: GitHub ─────────────────────────────────────────────────────

  private githubStep(): string {
    const g = this.c.github;
    const via = viaOf(this.deps.config, 'github');
    const f = githubFacts(via);
    const err = this.stepError(2);
    if (!this.deps.config.connect.github) {
      return `<div class="cx">${connectorHead(f, '')}${message('info', "Connecting GitHub isn't set up on this server yet.")}</div><div class="step-actions"><button class="btn" type="button" data-goto="3" data-autofocus>Next${ICON.arrowRight}</button></div>`;
    }
    // Just back from Stripe: what it found leads this step, so the moment of connecting pays off at once.
    const justConnected = this.fresh === 1 && this.c.stripe ? `<div class="cx cx-arrived is-on">${identityRow('stripe', 'Stripe is connected', `${escape(this.c.stripe.name ?? shortId(this.c.stripe.account))} · ${this.c.stripe.livemode ? 'Live mode' : 'Test mode'}`)}${this.revenuePreview()}</div>` : '';
    // The installation is gone (uninstalled on GitHub): the way back is installing again.
    const gone = this.reposError instanceof ApiRequestError && this.reposError.code === 'not_connected';
    if (!g || gone) {
      const pending = this.connecting === 'github';
      const label = via === 'composio' ? 'Connect GitHub' : 'Install on GitHub';
      return `${justConnected}
        <div class="cx" ${pending ? 'data-pending' : ''}>
          ${connectorHead(f, pending ? statusPill('pending') : gone ? statusPill('broken') : '')}
          ${badges(f)}
          ${gone ? problem(this.reposError!.message, '', 'warn') : scopeLists(f)}
          ${err ? problem(err) : ''}
          <div class="cx-actions">
            <button class="btn primary" type="button" data-act="connect-github" data-autofocus>${ICON.github}<span class="label">${label}</span></button>
            ${gone ? '' : '<button class="btn ghost" type="button" data-act="skip-github">Skip for now</button>'}
          </div>
          ${gone ? '' : '<p class="cx-foot">Skip it and your city simply runs on revenue. You can add GitHub later from your account.</p>'}
        </div>`;
    }
    if (g.repo && !this.changingRepo) {
      return `
        <div class="cx is-on">
          ${identityRow('github', escape(g.repo), `Releases and commits · since ${shortDate(g.connectedAt)}`, `<button class="btn sm ghost" type="button" data-act="change-repo">Change</button>`)}
          ${err ? problem(err) : ''}
          ${this.shippingPreview()}
        </div>
        <div class="step-actions"><button class="btn" type="button" data-goto="3" data-autofocus>Next: active users${ICON.arrowRight}</button></div>`;
    }
    return `
      <div class="cx is-picking">
        ${identityRow('github', 'Installed on GitHub', 'Now pick the repository your releases come from.')}
        ${err ? problem(err, `<button class="btn sm" type="button" data-act="connect-github">${ICON.github}<span class="label">Share more on GitHub</span></button>`) : ''}
        ${this.repoPicker()}
      </div>`;
  }

  private shippingPreview(): string {
    const p = this.preview;
    if (p.state === 'loading' || p.state === 'idle')
      return `<div class="cx-found is-loading" aria-busy="true"><span class="cx-found-label">Reading releases and commits…</span>${stats([['—', 'releases'], ['—', 'latest'], ['—', 'commits, 30 days']])}</div>`;
    if (p.state === 'error') return `<div class="cx-found">${this.failure(p.err, 'retry-preview', 'Read them again')}</div>`;
    const s = p.p.shipping;
    if (!s) return '';
    return `
      <div class="cx-found">
        <span class="cx-found-label">${ICON.build}What your HQ is built from</span>
        ${stats([
          [s.releases.toLocaleString('en-US'), s.releases === 1 ? 'release' : 'releases'],
          [s.latest ? escape(s.latest.name) : 'None yet', s.latest ? `latest, ${shortDate(s.latest.t)}` : 'latest release'],
          [s.commits30.toLocaleString('en-US'), 'commits, 30 days'],
        ])}
      </div>`;
  }

  private repoPicker(): string {
    if (this.reposError) return this.failure(this.reposError, 'retry-repos', 'Try again');
    if (!this.repos) {
      return `<div class="repo-picker is-loading" aria-busy="true"><div class="repo-search">${ICON.search}<input type="search" disabled placeholder="Loading your repositories…" aria-label="Find a repository"></div><ul class="repo-list" aria-hidden="true">${'<li class="repo skeleton"><i></i><i></i></li>'.repeat(4)}</ul></div>`;
    }
    if (!this.repos.length) {
      return problem('The app can’t see any repositories yet. Share at least one with it on GitHub.', `<button class="btn sm" type="button" data-act="connect-github">${ICON.github}<span class="label">Choose repositories on GitHub</span></button>`, 'warn');
    }
    return `
      <div class="repo-picker">
        <label class="repo-search">${ICON.search}<input type="search" name="repo-q" placeholder="Find a repository" aria-label="Find a repository" aria-controls="repo-list" autocomplete="off" spellcheck="false" value="${escape(this.query)}" data-autofocus></label>
        <ul class="repo-list" id="repo-list" role="listbox" aria-label="Repositories">${this.repoOptions()}</ul>
        <p class="repo-foot"><span class="num">${this.repos.length.toLocaleString('en-US')} ${this.repos.length === 1 ? 'repository' : 'repositories'} shared with TinyTown.</span> ${
          viaOf(this.deps.config, 'github') === 'native' ? '<button class="linkish" type="button" data-act="connect-github">Share more on GitHub</button>' : ''
        }</p>
      </div>`;
  }

  private repoOptions(): string {
    const q = this.query.toLowerCase();
    const list = (this.repos ?? []).filter((r) => r.fullName.toLowerCase().includes(q));
    if (!list.length) return `<li class="repo-empty" role="presentation">No repository matches “${escape(this.query)}”. Only the ones you shared with the app are listed.</li>`;
    const current = this.c.github?.repo;
    return list
      .map(
        (r, i) => `
        <li class="repo" role="option" id="repo-${i}" tabindex="-1" data-repo="${escape(r.fullName)}" aria-selected="${r.fullName === current}">
          ${ICON.repo}
          <span class="repo-name"><b>${escape(r.fullName.split('/')[1] ?? r.fullName)}</b><small>${escape(r.fullName.split('/')[0] ?? '')} · ${escape(r.defaultBranch)}</small></span>
          <span class="chip">${r.private ? 'Private' : 'Public'}</span>
        </li>`,
      )
      .join('');
  }

  private async loadRepos() {
    this.repos = null;
    this.reposError = null;
    try {
      this.repos = await this.deps.api.githubRepos();
    } catch (err) {
      this.reposError = err instanceof Error ? err : new Error("Couldn't load your repositories.");
    }
    if (this.step === 2 && this.d.open) {
      this.render();
      focusFirst(this.d, '[data-step="2"] input[name=repo-q], [data-step="2"] [data-act=retry-repos], [data-step="2"] [data-act=connect-github]');
    }
  }

  private async pickRepo(li: HTMLElement) {
    const repo = li.dataset.repo!;
    if (li.getAttribute('aria-busy')) return;
    li.setAttribute('aria-busy', 'true');
    li.classList.add('is-busy');
    li.insertAdjacentHTML('beforeend', '<span class="spinner" aria-hidden="true"></span>');
    try {
      const c = await this.deps.api.setGithubRepo(repo);
      this.deps.onConnections(c);
      this.changingRepo = false;
      this.error = null;
      this.step = 3;
      this.fresh = 2;
      this.live.textContent = `Watching ${repo} for releases and commits.`;
      this.loadPreview(true);
      this.render();
      focusFirst(this.d, '[data-step="3"] [data-autofocus]');
    } catch (err) {
      li.removeAttribute('aria-busy');
      li.classList.remove('is-busy');
      li.querySelector('.spinner')?.remove();
      this.error = { step: 2, text: err instanceof Error ? err.message : "Couldn't save that repository." };
      this.render();
    }
  }

  // ── Step 3: active users ───────────────────────────────────────────────

  private usersStep(): string {
    const u = this.users;
    const choice = this.usersChoice;
    const opt = (id: UsersChoice, brand: BrandName, title: string, text: string, extra = '') => `
      <label class="choice-card" data-choice="${id}">
        <input type="radio" name="users" value="${id}" ${choice === id ? 'checked' : ''} ${choice === id ? 'data-autofocus' : ''}>
        <span class="plan-radio" aria-hidden="true"></span>
        ${brandTile(brand, 'sm')}
        <span class="choice-text"><b>${title}</b><small>${text}</small></span>
      </label>${choice === id ? extra : ''}`;
    const saveLabel = this.saved === 3 ? `${ICON.check}<span class="label">Saved</span>` : '<span class="label">Save</span>';
    const testable = choice === 'posthog' ? !(u.source === 'posthog' && !this.replacingKey) : choice === 'ga4' ? !!this.ga4Pick && !(u.source === 'ga4' && u.property === this.ga4Pick) : false;
    const testBtn = testable
      ? `<button class="btn" type="button" data-act="test-users" ${this.test.state === 'busy' ? 'disabled aria-busy="true"' : ''}>${this.test.state === 'busy' ? '<span class="spinner" aria-hidden="true"></span><span class="label">Testing…</span>' : `${ICON.plug}<span class="label">Test connection</span>`}</button>`
      : '';
    return `
      <p class="step-lede">Everyone who uses your product lives in your city. Where should we count them?</p>
      <form class="users-form" novalidate>
        <fieldset class="choices">
          <legend class="sr-only">Count active users from</legend>
          ${opt('customers', 'customers', 'Paying customers', 'No analytics? Your paying customers are your residents.', this.customersPanel())}
          ${opt('manual', 'manual', 'A number you set', 'Your monthly active users, typed in. Update it any time.', this.manualPanel())}
          ${this.deps.config.connect.posthog ? opt('posthog', 'posthog', 'PostHog', 'Monthly active users from your PostHog project, kept up to date.', this.posthogPanel()) : ''}
          ${this.deps.ga4 ? opt('ga4', 'ga4', 'Google Analytics', 'Active users over 28 days from a GA4 property, through Composio.', this.ga4Panel()) : ''}
        </fieldset>
        <div class="users-error"></div>
        <div class="step-actions">${testBtn}<button class="btn ${this.saved === 3 ? 'done' : testable && this.test.state === 'ok' ? 'primary' : ''}" type="submit">${saveLabel}</button>${u.source === 'customers' && choice === 'customers' ? '<span class="step-aside">Paying customers is the default.</span>' : ''}</div>
      </form>`;
  }

  /** The default, spelled out for founders with no analytics at all, with the trade-off. */
  private customersPanel(): string {
    const r = this.preview.state === 'ready' ? this.preview.p.revenue : null;
    return `
      <div class="choice-extra">
        <div class="cx-explain">
          <p>Everyone who pays you lives in the city. It's exact and there's nothing to set up${r ? `: that's <b class="num">${r.customers.toLocaleString('en-US')}</b> residents today` : ''}.</p>
          <p class="cx-tradeoff">${ICON.info}<span>The trade-off: free users don't appear, so the city can't show how well you convert them. Each paying customer brings far more than the $${MRR_PER_USER.toFixed(2)} of MRR a home costs, so nobody ends up without one.</span></p>
        </div>
      </div>`;
  }

  private manualPanel(): string {
    const u = this.users;
    const manualValue = u.source === 'manual' ? String(u.value) : '';
    const r = this.preview.state === 'ready' ? this.preview.p.revenue : null;
    const err = this.fieldErrors.value;
    return `
      <div class="choice-extra">
        <label class="field"><span>Monthly active users</span><input type="number" name="value" min="0" step="1" inputmode="numeric" required value="${manualValue}" placeholder="e.g. 12000" ${err ? 'aria-invalid="true" aria-describedby="err-value"' : ''}></label>
        ${err ? `<p class="field-error" id="err-value">${escape(err)}</p>` : ''}
        <p class="field-help">${ICON.calendar}<span>It counts from today; earlier days keep what was true then. Change it whenever you like, here or in your account.</span></p>
        <p class="cx-house" data-house>${this.houseLine(u.source === 'manual' ? u.value : null, r)}</p>
      </div>`;
  }

  /** "2,340 residents need $468 MRR to all have a home: you have $4,320." The game's own rule, with the real numbers. */
  private houseLine(users: number | null, r: RevenueFacts | null): string {
    if (users == null || !Number.isFinite(users)) return '';
    const need = housingNeed(users);
    const who = `${users.toLocaleString('en-US')} ${users === 1 ? 'resident' : 'residents'}`;
    if (need === 0) return `${ICON.home}<span>${who}: the first ${FREE_HOUSED} always have a home.</span>`;
    const needText = money(need, r?.currency ?? 'usd', need < 100);
    if (!r) return `${ICON.home}<span>${who} need ${needText} of MRR to all have a home.</span>`;
    const ok = r.mrr >= need;
    return `${ICON.home}<span>${who} need <b class="num">${needText}</b> of MRR to all have a home. You have <b class="num">${money(r.mrr, r.currency)}</b>${ok ? ', so everyone does.' : `, so about ${Math.max(0, users - Math.max(FREE_HOUSED, Math.floor(r.mrr / MRR_PER_USER))).toLocaleString('en-US')} would sleep in tents. That's the game: grow revenue to house them.`}</span>`;
  }

  private posthogPanel(): string {
    const u = this.users;
    const ph = u.source === 'posthog' ? u : null;
    const r = this.preview.state === 'ready' ? this.preview.p.revenue : null;
    if (ph && !this.replacingKey) {
      const latest = this.preview.state === 'ready' ? this.preview.p.users : null;
      return `
        <div class="choice-extra">
          <div class="cx is-on">
            ${identityRow('posthog', `Project ${escape(ph.projectId)}`, `${escape(hostLabel(ph.host))} · key saved, never shown · since ${shortDate(ph.connectedAt)}`, `<button class="btn sm ghost" type="button" data-act="replace-key">${ICON.key}<span class="label">Replace key</span></button>`)}
            ${latest != null ? `<p class="cx-house">${ICON.users}<span>PostHog counts <b class="num">${latest.toLocaleString('en-US')}</b> monthly active users.</span></p><p class="cx-house">${this.houseLine(latest, r)}</p>` : ''}
          </div>
        </div>`;
    }
    const fe = this.fieldErrors;
    const field = (name: string, label: string, input: string, cls = '') =>
      `<label class="field ${cls}"><span>${label}</span>${input.replace('<input', `<input ${fe[name] ? `aria-invalid="true" aria-describedby="err-${name}"` : ''}`)}${fe[name] ? `<em class="field-error" id="err-${name}">${escape(fe[name]!)}</em>` : ''}</label>`;
    const t = this.test;
    return `
      <div class="choice-extra">
        <div class="cx cx-form">
          <div class="cx-form-head">${badges(POSTHOG_FACTS)}</div>
          ${scopeLists(POSTHOG_FACTS)}
          <div class="segmented" role="radiogroup" aria-label="PostHog region">${POSTHOG_HOSTS.map((h) => `<label><input type="radio" name="region" value="${h.id}" ${this.posthogRegion === h.id ? 'checked' : ''}><span>${h.label}</span></label>`).join('')}</div>
          ${this.posthogRegion === 'self' ? field('host', 'PostHog address', `<input type="url" name="host" required placeholder="https://posthog.yourstartup.com" value="${escape(ph?.host ?? '')}" spellcheck="false">`) : ''}
          <div class="field-row">
            ${field('projectId', 'Project ID', `<input name="projectId" required inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="12345" value="${escape(ph?.projectId ?? '')}">`)}
            ${field('apiKey', 'Personal API key', '<input type="password" name="apiKey" required autocomplete="off" spellcheck="false" placeholder="phx_…">', 'grow')}
          </div>
          <ol class="cx-how">
            <li>In PostHog, open <b>Settings → Personal API keys</b> and create a key.</li>
            <li>Give it the <b>Query: Read</b> scope, for this project only.</li>
            <li>The project ID is the number in your project's address: <code>/project/<b>12345</b></code>.</li>
          </ol>
          <p class="field-help">${ICON.lock}<span>The key goes straight to our server, is stored encrypted, and is never shown again, not even to you.</span></p>
          ${
            t.state === 'ok'
              ? `<p class="cx-test ok" role="status">${ICON.check}<span>PostHog answered: ${t.result.monthlyActiveUsers != null ? `<b class="num">${t.result.monthlyActiveUsers.toLocaleString('en-US')}</b> monthly active users, ${t.result.days.toLocaleString('en-US')} days of history.` : 'no active users counted yet.'} Save to use it.</span></p>`
              : t.state === 'bad' && !t.field
                ? problem(t.text)
                : ''
          }
        </div>
      </div>`;
  }

  private ga4Panel(): string {
    const u = this.users;
    const props = this.ga4Props;
    const t = this.test;
    if (u.source === 'ga4' && this.ga4Pick === u.property) {
      return `<div class="choice-extra"><div class="cx is-on">${identityRow('ga4', escape(u.propertyName ?? `Property ${u.property}`), `Property ${escape(u.property)} · since ${shortDate(u.connectedAt)}`, '<button class="btn sm ghost" type="button" data-act="ga4-change">Change</button>')}</div></div>`;
    }
    let inner: string;
    if (props === null || props === 'loading') inner = `<div class="cx-found is-loading" aria-busy="true"><span class="cx-found-label">Looking for your properties…</span></div>`;
    else if (props === 'none')
      inner = `${scopeLists(GA4_FACTS)}<div class="cx-actions"><button class="btn primary" type="button" data-act="connect-ga4">${ICON.external}<span class="label">Connect Google Analytics</span></button><span class="step-aside">You'll sign in with Google through Composio, then come back.</span></div>`;
    else if (!Array.isArray(props)) inner = problem(props.error, `<button class="btn sm" type="button" data-act="ga4-retry">${ICON.refresh}<span class="label">Try again</span></button>`);
    else if (!props.length) inner = problem("That Google account can't see any GA4 properties.", `<button class="btn sm" type="button" data-act="connect-ga4">Use another account</button>`, 'warn');
    else
      inner = `<ul class="repo-list ga4-list" role="listbox" aria-label="Google Analytics properties">${props
        .map(
          (p) =>
            `<li class="repo" role="option" tabindex="-1" data-ga4="${escape(p.id)}" aria-selected="${this.ga4Pick === p.id}">${brandMark('ga4')}<span class="repo-name"><b>${escape(p.name)}</b><small>${escape(p.account)} · ${escape(p.id)}</small></span></li>`,
        )
        .join('')}</ul>`;
    return `
      <div class="choice-extra">
        <div class="cx cx-form">
          <div class="cx-form-head">${badges(GA4_FACTS)}</div>
          ${inner}
          ${t.state === 'ok' ? `<p class="cx-test ok" role="status">${ICON.check}<span>Google Analytics answered: ${t.result.monthlyActiveUsers != null ? `<b class="num">${t.result.monthlyActiveUsers.toLocaleString('en-US')}</b> active users over 28 days.` : 'no active users counted yet.'} Save to use it.</span></p>` : t.state === 'bad' ? problem(t.text) : ''}
        </div>
      </div>`;
  }

  private async loadGa4() {
    if (!this.deps.ga4) return;
    this.ga4Props = 'loading';
    if (this.users.source === 'ga4') this.ga4Pick ??= this.users.property;
    this.rerender();
    try {
      this.ga4Props = await this.deps.ga4.properties();
    } catch (err) {
      this.ga4Props = err instanceof ApiRequestError && err.code === 'not_connected' ? 'none' : { error: err instanceof Error ? err.message : "Couldn't list your properties." };
    }
    if (this.d.open) this.rerender();
  }

  /** Inline checks that need no server: the commonest mistakes, caught as you type. */
  private checkField(name: string, value: string): string | null {
    const v = value.trim();
    if (name === 'projectId') {
      if (!v) return 'Enter the project ID.';
      if (!/^\d+$/.test(v)) return 'Numbers only: the ID in your project’s address.';
    }
    if (name === 'apiKey') {
      if (!v) return 'Paste a personal API key.';
      if (/^phc_/.test(v)) return 'That’s a project key (phc_), which can only send events. Use a personal API key (phx_).';
      if (!/^phx_[A-Za-z0-9_-]{16,}$/.test(v)) return 'Personal API keys start with phx_.';
    }
    if (name === 'host' && !/^https:\/\/\S+\.\S+/.test(v)) return 'Enter the full address, starting with https://';
    if (name === 'value') {
      if (!v) return 'Enter how many monthly active users you have.';
      if (!/^\d+$/.test(v)) return 'A whole number, like 12000.';
    }
    return null;
  }

  /** Which field a server sentence is about, so the message lands next to it. */
  private fieldOf(text: string): string | null {
    if (/address|cloud/i.test(text)) return 'host';
    if (/project/i.test(text)) return 'projectId';
    if (/key/i.test(text)) return 'apiKey';
    return null;
  }

  private posthogRequest(form: HTMLFormElement): UsersRequest | null {
    const fd = new FormData(form);
    const host = this.posthogRegion === 'self' ? String(fd.get('host') ?? '').trim() : POSTHOG_HOSTS.find((h) => h.id === this.posthogRegion)!.host;
    const projectId = String(fd.get('projectId') ?? '').trim();
    const apiKey = String(fd.get('apiKey') ?? '').trim();
    this.fieldErrors = {};
    for (const [name, v] of [...(this.posthogRegion === 'self' ? [['host', host]] : []), ['projectId', projectId], ['apiKey', apiKey]] as [string, string][]) {
      const e = this.checkField(name, v);
      if (e) this.fieldErrors[name] = e;
    }
    if (Object.keys(this.fieldErrors).length) {
      const keep = { projectId, apiKey, host };
      this.rerender();
      this.restoreFields(keep);
      this.d.querySelector<HTMLInputElement>('[aria-invalid=true]')?.focus();
      return null;
    }
    return { source: 'posthog', host, projectId, apiKey };
  }

  /** A re-render rebuilds the form: put back what was typed (the key included; it never left the page). */
  private restoreFields(values: Record<string, string>) {
    for (const [name, v] of Object.entries(values)) {
      const input = this.d.querySelector<HTMLInputElement>(`.users-form [name=${name}]`);
      if (input && v) input.value = v;
    }
  }

  private async testUsers(form: HTMLFormElement) {
    if (this.usersChoice === 'ga4') return this.saveGa4(true);
    const req = this.posthogRequest(form);
    if (!req || req.source !== 'posthog') return;
    const keep = { projectId: req.projectId, apiKey: req.apiKey, host: req.host };
    this.test = { state: 'busy' };
    this.rerender();
    this.restoreFields(keep);
    try {
      // The same route as saving, with `test: true`: the server checks the key against PostHog and saves nothing.
      const result = (await this.deps.api.setUsers({ ...req, test: true } as UsersRequest)) as unknown as UsersTest;
      this.test = { state: 'ok', result };
      this.live.textContent = 'PostHog answered. Save to use it.';
    } catch (err) {
      const text = err instanceof Error ? err.message : "Couldn't reach PostHog. Try again.";
      const field = err instanceof ApiRequestError && (err.code === 'bad_request' || err.code === 'not_connected') ? this.fieldOf(text) : null;
      this.test = { state: 'bad', text, field };
      if (field) this.fieldErrors[field] = text;
    }
    this.rerender();
    this.restoreFields(keep);
    if (this.test.state === 'ok') focusFirst(this.d, '.users-form button[type=submit]');
  }

  private async saveGa4(test: boolean) {
    const ga4 = this.deps.ga4;
    const props = Array.isArray(this.ga4Props) ? this.ga4Props : [];
    const p = props.find((x) => x.id === this.ga4Pick);
    if (!ga4 || !p) {
      this.test = { state: 'bad', text: 'Pick one of your Google Analytics properties.', field: null };
      return this.rerender();
    }
    this.test = { state: 'busy' };
    this.rerender();
    try {
      const res = await ga4.save(p, test);
      if (test) this.test = { state: 'ok', result: res as UsersTest };
      else {
        this.deps.onConnections(res as Connections);
        this.test = { state: 'idle' };
        this.markSaved();
      }
    } catch (err) {
      this.test = { state: 'bad', text: err instanceof Error ? err.message : "Couldn't reach Google Analytics. Try again.", field: null };
    }
    this.rerender();
  }

  private markSaved() {
    this.replacingKey = false;
    this.saved = 3;
    this.fresh = 3;
    this.live.textContent = 'Saved. Your city counts its residents from there now.';
    this.loadPreview(true);
  }

  private async saveUsers(form: HTMLFormElement) {
    const slot = form.querySelector('.users-error')!;
    slot.innerHTML = '';
    const fd = new FormData(form);
    let req: UsersRequest;
    if (this.usersChoice === 'manual') {
      const raw = String(fd.get('value') ?? '');
      const e = this.checkField('value', raw);
      if (e) {
        this.fieldErrors = { value: e };
        this.rerender();
        const input = this.d.querySelector<HTMLInputElement>('input[name=value]');
        if (input) (input.value = raw), input.focus();
        return;
      }
      req = { source: 'manual', value: Number(raw.trim()) };
    } else if (this.usersChoice === 'posthog') {
      if (this.users.source === 'posthog' && !this.replacingKey) {
        this.saved = 3;
        return this.render();
      }
      const r = this.posthogRequest(form);
      if (!r) return;
      req = r;
    } else if (this.usersChoice === 'ga4') {
      if (this.users.source === 'ga4' && this.users.property === this.ga4Pick) {
        this.saved = 3;
        return this.render();
      }
      return this.saveGa4(false);
    } else {
      req = { source: 'customers' };
    }
    const keep: Record<string, string> = req.source === 'posthog' ? { projectId: req.projectId, apiKey: req.apiKey, host: req.host } : {};
    const done = busy(form.querySelector<HTMLButtonElement>('button[type=submit]'), req.source === 'posthog' ? 'Checking with PostHog…' : 'Saving…');
    try {
      const c = await this.deps.api.setUsers(req);
      this.deps.onConnections(c);
      this.fieldErrors = {};
      this.test = { state: 'idle' };
      this.markSaved();
      this.render();
      focusFirst(this.d, '[data-act=finish]');
    } catch (err) {
      done();
      const text = err instanceof Error ? err.message : "Couldn't save that. Try again.";
      const field = req.source === 'posthog' && err instanceof ApiRequestError && (err.code === 'bad_request' || err.code === 'not_connected') ? this.fieldOf(text) : req.source === 'manual' && err instanceof ApiRequestError && err.code === 'bad_request' ? 'value' : null;
      if (field) {
        this.fieldErrors[field] = text;
        this.rerender();
        this.restoreFields(keep);
        this.d.querySelector<HTMLInputElement>(`[name=${field}]`)?.focus();
      } else {
        slot.innerHTML = this.failure(err, 'retry-save', 'Try again');
      }
    }
  }

  // ── Events ─────────────────────────────────────────────────────────────

  private async onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const goto = t.closest<HTMLElement>('[data-goto]');
    if (goto) {
      this.step = Number(goto.dataset.goto) as Step;
      this.saved = null;
      this.fresh = null;
      this.render();
      const c = this.c;
      if (this.step === 2 && c.github && (!c.github.repo || this.changingRepo) && !this.repos) void this.loadRepos();
      if (this.step === 3 && this.usersChoice === 'ga4' && !this.ga4Props) void this.loadGa4();
      focusFirst(this.d, `[data-step="${this.step}"] [data-autofocus], [data-step="${this.step}"] .step-toggle`);
      return;
    }
    const repo = t.closest<HTMLElement>('[data-repo]');
    if (repo) return this.pickRepo(repo);
    const prop = t.closest<HTMLElement>('[data-ga4]');
    if (prop) {
      this.ga4Pick = prop.dataset.ga4!;
      this.test = { state: 'idle' };
      return this.rerender();
    }
    const btn = t.closest<HTMLButtonElement>('[data-act]');
    switch (btn?.dataset.act) {
      case 'connect-stripe':
      case 'connect-github':
      case 'connect-ga4': {
        const which = btn.dataset.act === 'connect-stripe' ? 'stripe' : btn.dataset.act === 'connect-github' ? 'github' : 'ga4';
        const name = { stripe: 'Stripe', github: 'GitHub', ga4: 'Google' }[which];
        const done = busy(btn, `Opening ${name}…`);
        this.connecting = which;
        this.d.querySelector(`[data-step="${which === 'ga4' ? 3 : which === 'stripe' ? 1 : 2}"] .cx`)?.setAttribute('data-pending', '');
        try {
          const { url } = which === 'stripe' ? await this.deps.api.connectStripe() : which === 'github' ? await this.deps.api.connectGithub() : await this.deps.ga4!.connect();
          this.live.textContent = `Opening ${name}…`;
          this.deps.go(url);
        } catch (err) {
          done();
          this.connecting = null;
          this.error = { step: which === 'stripe' ? 1 : which === 'github' ? 2 : 3, text: err instanceof Error ? err.message : "Couldn't start connecting. Try again." };
          this.render();
          focusFirst(this.d, `[data-act=${btn.dataset.act}]`);
        }
        return;
      }
      case 'skip-github':
        this.skippedGithub = true;
        this.step = 3;
        this.render();
        focusFirst(this.d, '[data-step="3"] [data-autofocus]');
        return;
      case 'change-repo':
        this.changingRepo = true;
        this.render();
        if (!this.repos) void this.loadRepos();
        else focusFirst(this.d, 'input[name=repo-q]');
        return;
      case 'retry-repos':
        this.render();
        return void this.loadRepos();
      case 'retry-preview':
        this.loadPreview(true);
        return this.rerender();
      case 'retry-save': {
        const form = this.d.querySelector<HTMLFormElement>('.users-form');
        if (form) void this.saveUsers(form);
        return;
      }
      case 'replace-key':
        this.replacingKey = true;
        this.test = { state: 'idle' };
        this.render();
        focusFirst(this.d, 'input[name=projectId]');
        return;
      case 'test-users': {
        const form = this.d.querySelector<HTMLFormElement>('.users-form');
        if (form) void this.testUsers(form);
        return;
      }
      case 'ga4-change':
        this.ga4Pick = null;
        if (!Array.isArray(this.ga4Props)) void this.loadGa4();
        return this.rerender();
      case 'ga4-retry':
        return void this.loadGa4();
      case 'finish':
        if (btn.disabled) return;
        this.d.close();
        this.deps.finish();
        return;
    }
  }

  private onInput(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.name === 'repo-q') {
      this.query = t.value;
      const list = this.d.querySelector('#repo-list');
      if (list) list.innerHTML = this.repoOptions();
    }
    // A field with an error clears it as soon as it's fixed.
    if (this.fieldErrors[t.name] && !this.checkField(t.name, t.value)) {
      delete this.fieldErrors[t.name];
      t.removeAttribute('aria-invalid');
      t.closest('.field')?.querySelector('.field-error')?.remove();
      t.parentElement?.parentElement?.querySelector(`#err-${t.name}`)?.remove();
    }
    // The housing line follows the number as it's typed.
    if (t.name === 'value') {
      const line = this.d.querySelector('[data-house]');
      const r = this.preview.state === 'ready' ? this.preview.p.revenue : null;
      if (line) line.innerHTML = /^\d+$/.test(t.value.trim()) ? this.houseLine(Number(t.value), r) : '';
    }
    if (t.closest('.users-form') && (t.name === 'projectId' || t.name === 'apiKey' || t.name === 'host') && this.test.state !== 'idle' && this.test.state !== 'busy') {
      this.test = { state: 'idle' };
      this.d.querySelector('.cx-test')?.remove();
    }
    if (this.saved === 3 && t.closest('.users-form')) {
      this.saved = null;
      const b = this.d.querySelector<HTMLButtonElement>('.users-form button[type=submit]');
      if (b) {
        b.classList.remove('done');
        b.innerHTML = '<span class="label">Save</span>';
      }
    }
  }

  /** Format checks on leaving a field, never while someone is still typing. */
  private onBlur(e: FocusEvent) {
    const t = e.target as HTMLInputElement;
    if (!(t instanceof HTMLInputElement) || !['projectId', 'apiKey', 'host'].includes(t.name) || !t.value.trim()) return;
    const err = this.checkField(t.name, t.value);
    if (!err || this.fieldErrors[t.name] === err) return;
    this.fieldErrors[t.name] = err;
    t.setAttribute('aria-invalid', 'true');
    t.setAttribute('aria-describedby', `err-${t.name}`);
    t.closest('.field')?.querySelector('.field-error')?.remove();
    t.insertAdjacentHTML('afterend', `<em class="field-error" id="err-${t.name}">${escape(err)}</em>`);
  }

  private onChange(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.name === 'users') {
      this.usersChoice = t.value as UsersChoice;
      this.saved = null;
      this.fieldErrors = {};
      this.test = { state: 'idle' };
      this.render();
      focusFirst(this.d, `input[name=users][value=${t.value}]`);
      if (this.usersChoice === 'ga4' && !this.ga4Props) void this.loadGa4();
    }
    if (t.name === 'region') {
      this.posthogRegion = t.value as typeof this.posthogRegion;
      const form = this.d.querySelector<HTMLFormElement>('.users-form');
      const fd = form ? new FormData(form) : null;
      const keep = { projectId: String(fd?.get('projectId') ?? ''), apiKey: String(fd?.get('apiKey') ?? '') };
      this.render();
      this.restoreFields(keep);
      focusFirst(this.d, this.posthogRegion === 'self' ? 'input[name=host]' : `input[name=region][value=${t.value}]`);
    }
  }

  /** The repository list is a listbox: arrows move, Enter picks, typing goes back to the search. */
  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    const list = t.closest<HTMLElement>('[role=listbox]') ?? this.d.querySelector<HTMLElement>('#repo-list');
    if (!list) return;
    const options = [...list.querySelectorAll<HTMLElement>('[role=option]')];
    if (!options.length) return;
    const i = options.indexOf(t);
    if (t instanceof HTMLInputElement && t.name === 'repo-q' && e.key === 'ArrowDown') {
      e.preventDefault();
      options[0]!.focus();
    } else if (i >= 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const next = options[i + (e.key === 'ArrowDown' ? 1 : -1)];
      if (next) next.focus();
      else if (e.key === 'ArrowUp') this.d.querySelector<HTMLInputElement>('input[name=repo-q]')?.focus();
    } else if (i >= 0 && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      t.click();
    } else if (i >= 0 && e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      this.d.querySelector<HTMLInputElement>('input[name=repo-q]')?.focus();
    }
  }
}

/** For the account dialog: one line on where the population comes from. */
export function usersSummary(u: Connections['users']): string {
  const any = u as AnyUsersSource;
  if (any.source === 'manual') return `${compact(any.value)} active users, set by you on ${shortDate(any.updatedAt)}`;
  if (any.source === 'posthog') return `PostHog project ${any.projectId} on ${hostLabel(any.host)}`;
  if (any.source === 'ga4') return `Google Analytics · ${any.propertyName ?? `property ${any.property}`}`;
  return 'Paying customers from Stripe';
}

/** The brand behind a users source, for the account dialog. */
export function usersBrand(u: Connections['users']): BrandName {
  const s = (u as AnyUsersSource).source;
  return s === 'manual' ? 'manual' : s === 'posthog' ? 'posthog' : s === 'ga4' ? 'ga4' : 'customers';
}
