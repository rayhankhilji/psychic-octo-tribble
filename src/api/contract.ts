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

export type ErrorCode = 'unauthenticated' | 'payment_required' | 'rejected' | 'not_configured' | 'not_connected' | 'upstream' | 'bad_request' | 'not_invited' | 'rate_limited';

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
  /** Which ways to connect data are set up on this server. */
  connect: { stripe: boolean; github: boolean; posthog: boolean };
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
  /** The account's email, typed again, so a stray click can't delete a city. */
  confirm: string;
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
}

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
  | { source: 'posthog'; host: string; projectId: string; connectedAt: number };

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

/** `POST /api/billing/checkout` { interval } → { url } (Stripe Checkout). */
export interface CheckoutRequest {
  interval: PlanInterval;
}

/** Any call that hands back a page to send the browser to. */
export interface RedirectResponse {
  url: string;
}

/** `POST /api/billing/portal` → RedirectResponse (Stripe customer portal: change plan, cancel, invoices). */
/** `POST /api/billing/webhook`: Stripe only, signature-checked. */

/** `POST /api/connect/stripe` → RedirectResponse (Stripe App install link). Callback: `GET /api/connect/stripe/callback`. */
/** `POST /api/connect/github` → RedirectResponse (GitHub App install). Callback: `GET /api/connect/github/callback`. */
/** `DELETE /api/connect/:provider` → { ok: true }. Disconnecting PostHog puts the population back on customers. */
export type Provider = 'stripe' | 'github' | 'posthog';

/** `GET /api/connect/github/repos` → { repos } (repositories the installation can see). */
export interface ReposResponse {
  repos: { fullName: string; private: boolean; defaultBranch: string }[];
}

/** `PUT /api/connect/github/repo` { repo } → Connections */
export interface RepoRequest {
  repo: string;
}

/** `PUT /api/connect/users` → Connections. Manual number, PostHog (key stays server-side), or back to customers. */
export type UsersRequest =
  | { source: 'customers' }
  | { source: 'manual'; value: number }
  | { source: 'posthog'; host: string; projectId: string; apiKey: string };

/** Where an OAuth callback sends the browser back to: `/?connected=stripe`, or `/?connect_error=...`. */
export const RETURN_PARAMS = { connected: 'connected', error: 'connect_error', checkout: 'checkout' } as const;

export const ROUTES = {
  config: '/api/config',
  me: '/api/me',
  world: '/api/world',
  actions: '/api/world/actions',
  timeline: '/api/timeline',
  checkout: '/api/billing/checkout',
  portal: '/api/billing/portal',
  webhook: '/api/billing/webhook',
  connectStripe: '/api/connect/stripe',
  stripeCallback: '/api/connect/stripe/callback',
  connectGithub: '/api/connect/github',
  githubCallback: '/api/connect/github/callback',
  githubRepos: '/api/connect/github/repos',
  githubRepo: '/api/connect/github/repo',
  users: '/api/connect/users',
  account: '/api/account',
  accountExport: '/api/account/export',
  telemetry: '/api/telemetry',
  health: '/api/health',
  /** `GET /api/email/unsubscribe?token=…` (public, signed link in every non-essential email). */
  unsubscribe: '/api/email/unsubscribe',
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
