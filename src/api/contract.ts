/**
 * The contract between the browser and the TinyTown API: every route, what
 * it takes and what it returns. Both sides import these types, so a change
 * here is a change to both. See docs/INFRA.md for the design.
 *
 * Conventions:
 * - JSON in and out. Signed-in calls send `Authorization: Bearer <Supabase
 *   access token>`; the server checks it with Supabase on every request.
 * - Errors are `{ error: string, code?: ErrorCode }` with a matching status:
 *   401 not signed in, 402 no active plan, 409 a game rule said no, 503 the
 *   hosted services aren't configured on this server (local/demo mode).
 * - The browser never talks to Stripe, GitHub or PostHog directly, and never
 *   holds a secret. OAuth callbacks land on the server and redirect home.
 */
import { DAY, type Timeline } from '../data/types.ts';
import type { Action, SimOptions } from '../game/economy.ts';

export type ErrorCode = 'unauthenticated' | 'payment_required' | 'rejected' | 'not_configured' | 'not_connected' | 'upstream' | 'bad_request' | 'not_invited' | 'rate_limited' | 'mfa_required';

export interface ApiError {
  error: string;
  code?: ErrorCode;
}

/** `GET /api/config` (public). What this server can do, and the public keys the browser needs. */
export interface ConfigResponse {
  /** Accounts and saves are hosted (Supabase configured). False in local/demo mode. */
  hosted: boolean;
  supabase: { url: string; anonKey: string } | null;
  /** Plans on sale. Amounts in minor units (cents). Empty when billing isn't configured. */
  plans: Plan[];
  /**
   * Which ways to connect data are set up on this server. `via` says whether
   * Stripe and GitHub go through our own apps (native) or Composio, so the
   * setup screens can say exactly what access is granted (docs/CONNECTORS.md).
   * `ga4`: Google Analytics, through Composio, as a source of active users.
   */
  connect: { stripe: boolean; github: boolean; posthog: boolean; ga4?: boolean; via?: { stripe: ConnectVia; github: ConnectVia } };
  /** Bot check on sign-in (Supabase's captcha support), when configured. The browser passes the token to Supabase. */
  captcha?: { provider: 'turnstile'; siteKey: string } | null;
  /** `open`: anyone can sign up and pay. `waitlist`: only invited emails can (403 `not_invited` otherwise). */
  access?: 'open' | 'waitlist';
  /** Where to write for help. */
  supportEmail?: string | null;
}

/** Public pages every screen can link to (static files in public/). */
export const LEGAL = { terms: '/legal/terms.html', privacy: '/legal/privacy.html', refunds: '/legal/refunds.html', contact: '/legal/contact.html' } as const;

/** `GET /api/account/export` → a JSON download of everything we hold about the signed-in founder. */
/** `DELETE /api/account` { confirm: email } → { ok: true }: cancels the plan, disconnects everything, deletes the account. */
export interface DeleteAccountRequest {
  /** The account's email, typed again, so a stray click can't delete a city ("DELETE" for an account with no email). */
  confirm: string;
}

/** `DELETE /api/account` → this: our apps the founder still has to remove on their side, and where. */
export interface DeleteAccountResponse {
  ok: true;
  stillInstalled: { provider: 'stripe' | 'github'; url: string }[];
}

/** Which optional emails the founder gets. */
export interface EmailPrefs {
  weeklyDigest: boolean;
  productUpdates: boolean;
}

/** `POST /api/telemetry` (public, rate-limited): a browser error report. No personal data. */
export interface TelemetryReport {
  kind: 'error' | 'unhandledrejection' | 'webgl' | 'perf';
  message: string;
  stack?: string;
  url?: string;
  /** Build id, so reports map to a release. */
  release?: string;
  /** Free-form numbers (fps, draw calls, boot ms). */
  data?: Record<string, number | string | boolean>;
}

export type PlanInterval = 'month' | 'year';

export type ConnectVia = 'native' | 'composio';

export interface Plan {
  interval: PlanInterval;
  amount: number;
  currency: string;
}

export type PlanStatus = 'none' | 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete';

/** `GET /api/me`. Everything the shell needs to decide what to show. */
export interface MeResponse {
  user: { id: string; email: string | null };
  plan: { status: PlanStatus; interval: PlanInterval | null; renewsAt: number | null; cancelAtPeriodEnd: boolean };
  connections: Connections;
  world: WorldInfo;
  /**
   * Setup is free and comes before paying: `complete` once Stripe is
   * connected, which is what a city needs. Optional, so a browser that's
   * ahead of its server still reads an older answer.
   */
  setup?: { complete: boolean };
  /** The one-time introductory offer, when this founder can still have it (null otherwise, or on a server without one). */
  offer?: Offer | null;
}

/**
 * The introductory offer: a cheaper first year, then the standard yearly
 * price. Shown once, the first time a founder closes the paywall, and
 * claimable for OFFER_WINDOW_MS from that moment (the server keeps the
 * clock, so clearing storage changes nothing). Only for founders who have
 * never paid.
 */
export interface Offer {
  /** `unseen`: not shown yet. `open`: shown, claimable until `expiresAt`. `expired` and `used` are final. */
  status: 'unseen' | 'open' | 'expired' | 'used';
  /** Can be shown or claimed right now (`unseen` or `open`). */
  available: boolean;
  /** When the window closes (UTC ms); null until it has been shown. */
  expiresAt: number | null;
  /** The first year's price, in minor units ($9 = 900). */
  amount: number;
  /** What it renews at every year after that, in minor units. */
  regular: number;
  currency: string;
}

/** How long the introductory offer stays open after it's first shown. */
export const OFFER_WINDOW_MS = 48 * 60 * 60_000;

export interface Connections {
  /** The founder's own Stripe account, installed through our Stripe App (read-only). */
  stripe: { account: string; name: string | null; livemode: boolean; connectedAt: number } | null;
  /** A GitHub App installation and the repository chosen for releases and commits. */
  github: { installationId: number; repo: string | null; connectedAt: number } | null;
  /** Where the population comes from. */
  users: UsersSource;
}

export type UsersSource =
  | { source: 'customers' }
  | { source: 'manual'; value: number; updatedAt: number }
  | { source: 'posthog'; host: string; projectId: string; connectedAt: number }
  | { source: 'ga4'; property: string; propertyName: string | null; connectedAt: number };

export interface WorldInfo {
  /** Seeds the founder's map: same size and plot count as everyone else, a different layout. */
  seed: number;
  /** Shown on HQ's sign. */
  name: string;
  /** Day the founder joined (snapshot time), the start of the back-pay window. */
  joinedAt: number | null;
  /** Last day shown, for "while you were away". */
  lastSeen: number | null;
}

/** `PATCH /api/world` { name?, lastSeen? } → WorldInfo */
export interface WorldPatch {
  name?: string;
  lastSeen?: number;
}

/** `GET /api/world/actions` → { actions } */
export interface ActionsResponse {
  actions: Action[];
}

/**
 * `POST /api/world/actions` { action } → { actions }. The server re-runs the
 * game on its own copy of the founder's metrics and saves the action only if
 * the game allows it (409 `rejected` otherwise, with the reason).
 */
export interface ActionRequest {
  action: Action;
}

/** `GET /api/timeline` → Timeline. The signed-in founder's real metrics (402 without a plan). */
export type TimelineResponse = Timeline;

/**
 * `POST /api/billing/checkout` { interval, offer? } → { url } (Stripe
 * Checkout). With `offer: true` the server checks the founder may still have
 * the introductory offer (409 `rejected` if not) and Checkout applies it.
 */
export interface CheckoutRequest {
  interval: PlanInterval;
  offer?: boolean;
}

/** `POST /api/billing/offer/seen` → { offer }: starts the offer's window the first time (later calls change nothing). */
export interface OfferSeenResponse {
  offer: Offer | null;
}

/** `POST /api/billing/paywall/seen` { teaser } → { ok: true }: the paywall was shown (our own funnel only). */
export interface PaywallSeenRequest {
  /** It led with the founder's own numbers. */
  teaser?: boolean;
}

/**
 * `GET /api/preview` → PreviewResponse. Signed in, no plan needed: the
 * headline numbers from the founder's connected data, for the setup cards and
 * the paywall's "your city is ready". Never the full timeline (the city is
 * what the plan pays for). 409 `not_connected` before anything is connected.
 */
export interface PreviewResponse {
  /** The world's name, as on HQ's sign. */
  name: string;
  currency: string;
  /** False while there's no history to read yet: connected a moment ago, or nothing in it. */
  ready: boolean;
  /** The latest day (UTC ms). */
  asOf: number | null;
  /** Days of history. */
  days: number;
  revenue: RevenueFacts | null;
  shipping: ShippingFacts | null;
  /** Monthly active users from the chosen source; null when the residents are the paying customers. */
  users: number | null;
}

/** What Stripe gave the city: the numbers on the setup card and the paywall. */
export interface RevenueFacts {
  mrr: number;
  customers: number;
  currency: string;
  /** The first day anyone paid. */
  since: number | null;
  /** MRR across the history, a few dozen points for a sparkline. */
  spark: number[];
}

/** What GitHub gave the city. */
export interface ShippingFacts {
  releases: number;
  latest: { name: string; t: number } | null;
  commits30: number;
}

/** Any call that hands back a page to send the browser to. */
export interface RedirectResponse {
  url: string;
}

/** `POST /api/billing/portal` → RedirectResponse (Stripe customer portal: card, cancel, invoices). */
/** `POST /api/billing/webhook`: Stripe only, signature-checked. */

/** `POST /api/connect/stripe` → RedirectResponse (Stripe App install link). Callback: `GET /api/connect/stripe/callback`. */
/** `POST /api/connect/github` → RedirectResponse (GitHub App install). Callback: `GET /api/connect/github/callback`. */
/** `DELETE /api/connect/:provider` → { ok: true }. Disconnecting PostHog puts the population back on customers. */
export type Provider = 'stripe' | 'github' | 'posthog' | 'ga4';

/** `GET /api/connect/github/repos` → { repos } (repositories the installation can see). */
export interface ReposResponse {
  repos: { fullName: string; private: boolean; defaultBranch: string }[];
}

/** `PUT /api/connect/github/repo` { repo } → Connections */
export interface RepoRequest {
  repo: string;
}

/**
 * `PUT /api/connect/users` → Connections. Manual number, PostHog (key stays
 * server-side), a Google Analytics property, or back to customers. With
 * `test: true` (PostHog, GA4) the server checks the source and saves nothing,
 * answering UsersTestResult instead.
 */
export type UsersRequest =
  | { source: 'customers' }
  | { source: 'manual'; value: number }
  | { source: 'posthog'; host: string; projectId: string; apiKey: string; test?: boolean }
  | { source: 'ga4'; property: string; propertyName?: string; test?: boolean };

/** What "Test connection" answers: the source's latest monthly active users, nothing saved. */
export interface UsersTestResult {
  ok: true;
  source: 'posthog' | 'ga4';
  monthlyActiveUsers: number | null;
  /** That day (UTC ms). */
  asOf: number | null;
  /** Days of history the source returned. */
  days: number;
}

/** `GET /api/connect/ga4/properties` → the GA4 properties the founder's Google account can read. */
export interface Ga4PropertiesResponse {
  properties: { id: string; name: string; account: string }[];
}

/** Where an OAuth callback sends the browser back to: `/?connected=stripe`, or `/?connect_error=...`. */
export const RETURN_PARAMS = { connected: 'connected', error: 'connect_error', checkout: 'checkout' } as const;

export const ROUTES = {
  config: '/api/config',
  me: '/api/me',
  world: '/api/world',
  actions: '/api/world/actions',
  timeline: '/api/timeline',
  /** Headline numbers only, for setup and the paywall (no plan needed). */
  preview: '/api/preview',
  checkout: '/api/billing/checkout',
  offerSeen: '/api/billing/offer/seen',
  paywallSeen: '/api/billing/paywall/seen',
  portal: '/api/billing/portal',
  webhook: '/api/billing/webhook',
  connectStripe: '/api/connect/stripe',
  stripeCallback: '/api/connect/stripe/callback',
  connectGithub: '/api/connect/github',
  githubCallback: '/api/connect/github/callback',
  githubRepos: '/api/connect/github/repos',
  githubRepo: '/api/connect/github/repo',
  users: '/api/connect/users',
  /** Google Analytics through Composio: `POST` → RedirectResponse; callback; `GET` properties. */
  connectGa4: '/api/connect/ga4',
  ga4Callback: '/api/connect/ga4/callback',
  ga4Properties: '/api/connect/ga4/properties',
  account: '/api/account',
  accountExport: '/api/account/export',
  telemetry: '/api/telemetry',
  health: '/api/health',
  /** `GET /api/email/unsubscribe?token=…` (public, signed link in every non-essential email). */
  unsubscribe: '/api/email/unsubscribe',
  /** `GET` / `PUT /api/email/prefs` (signed in): EmailPrefs. Transactional email (receipts, payment problems) is always sent. */
  emailPrefs: '/api/email/prefs',
} as const;

/** A plan that unlocks the hosted game. */
export function isPaid(status: PlanStatus): boolean {
  return status === 'active' || status === 'trialing' || status === 'past_due';
}

/**
 * Back pay: a newly connected founder's treasury counts revenue from this
 * many days before they joined (the "grand opening" fund, GAME_DESIGN).
 */
export const BACK_PAY_DAYS = 90;

/**
 * The options every hosted simulation runs with. The browser and the server
 * must use exactly these, or they'd disagree about how much money there is
 * and the server would refuse purchases the browser allowed.
 */
export function simOptionsFor(joinedAt: number | null): SimOptions {
  return joinedAt == null ? {} : { incomeFrom: joinedAt - BACK_PAY_DAYS * DAY };
}
