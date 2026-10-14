/**
 * A small typed client for the TinyTown API (see contract.ts). One place
 * adds the bearer token, parses JSON, turns failures into typed errors, and
 * tells the shell when the session has expired (401) or there's no plan (402).
 */
import type { Timeline } from '../data/types.ts';
import type { Action } from '../game/economy.ts';
import {
  ROUTES,
  type ActionsResponse,
  type ConfigResponse,
  type Connections,
  type DeleteAccountRequest,
  type DeleteAccountResponse,
  type EmailPrefs,
  type ErrorCode,
  type MeResponse,
  type PlanInterval,
  type Provider,
  type RedirectResponse,
  type ReposResponse,
  type UsersRequest,
  type UsersTestResult,
  type Ga4PropertiesResponse,
  type WorldInfo,
  type WorldPatch,
} from './contract.ts';

export type { DeleteAccountResponse } from './contract.ts';


/** Pure: the file name from a Content-Disposition header, or a dated default. */
export function filenameFrom(header: string | null, fallback: string): string {
  const star = header?.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim().replace(/^"|"$/g, ''));
    } catch {
      // Fall through to the plain form.
    }
  }
  const plain = header?.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1]!.trim() : fallback;
}

/** Every failed call becomes one of these: a status, a code and a sentence a person can read. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ErrorCode | 'network';

  constructor(status: number, code: ErrorCode | 'network', message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }
}

const CODES: readonly ErrorCode[] = ['unauthenticated', 'payment_required', 'rejected', 'not_configured', 'not_connected', 'upstream', 'bad_request', 'not_invited', 'rate_limited'];

/** The code a status implies when the server didn't send one. */
function codeForStatus(status: number): ErrorCode {
  if (status === 401) return 'unauthenticated';
  if (status === 402) return 'payment_required';
  if (status === 403) return 'not_invited';
  if (status === 429) return 'rate_limited';
  if (status === 409) return 'rejected';
  if (status === 503) return 'not_configured';
  if (status >= 500) return 'upstream';
  return 'bad_request';
}

/** Plain words for when the server gives none. */
const FALLBACK: Record<ErrorCode | 'network', string> = {
  unauthenticated: 'Your session has ended. Sign in again to carry on.',
  payment_required: 'This needs an active TinyTown plan.',
  mfa_required: 'Confirm it’s you with your authenticator app.',
  rejected: "The game didn't allow that.",
  not_configured: "Accounts aren't set up on this server.",
  not_connected: "That account isn't connected yet.",
  upstream: 'Something went wrong on our side. Try again in a moment.',
  bad_request: "That didn't work. Check the details and try again.",
  not_invited: "TinyTown is invite-only for now, and this email isn't on the list yet.",
  rate_limited: 'That was a lot of requests in a short time. Wait a moment, then try again.',
  network: "Couldn't reach TinyTown. Check your connection and try again.",
};

/**
 * Pure: a response status and its parsed body (if any) → the typed error.
 * The server's own `code` wins over the status, and its `error` text over ours.
 */
export function toApiError(status: number, body: unknown): ApiRequestError {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const code = typeof b.code === 'string' && (CODES as readonly string[]).includes(b.code) ? (b.code as ErrorCode) : codeForStatus(status);
  const text = typeof b.error === 'string' && b.error.trim() ? b.error.trim() : FALLBACK[code];
  return new ApiRequestError(status, code, text);
}

export function networkError(): ApiRequestError {
  return new ApiRequestError(0, 'network', FALLBACK.network);
}

export interface ApiHooks {
  /** The Supabase access token, or null when signed out. */
  token(): Promise<string | null>;
  /** A signed-in call came back 401: the session is gone. */
  onUnauthenticated?(err: ApiRequestError): void;
  /** A data call came back 402: no active plan. */
  onPaymentRequired?(err: ApiRequestError): void;
  /** 403 `not_invited`: the waitlist is on and this email's spot hasn't opened yet. */
  onNotInvited?(err: ApiRequestError): void;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export class Api {
  private hooks: ApiHooks;

  constructor(hooks: ApiHooks) {
    this.hooks = hooks;
  }

  /** Swap the hooks once the shell knows how to handle 401 and 402. */
  setHooks(hooks: Partial<ApiHooks>) {
    this.hooks = { ...this.hooks, ...hooks };
  }

  private async call<T>(method: Method, path: string, body?: unknown, signedIn = true): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (signedIn) {
      const token = await this.hooks.token();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    let res: Response;
    try {
      res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
    } catch {
      throw networkError();
    }
    const parsed: unknown = await res.json().catch(() => null);
    if (res.ok) return parsed as T;
    throw this.failed(toApiError(res.status, parsed));
  }

  /** The one place 401, 402 and 403 `not_invited` reach the shell. */
  private failed(err: ApiRequestError): ApiRequestError {
    if (err.code === 'unauthenticated') this.hooks.onUnauthenticated?.(err);
    if (err.code === 'payment_required') this.hooks.onPaymentRequired?.(err);
    if (err.code === 'not_invited') this.hooks.onNotInvited?.(err);
    return err;
  }

  /** Public: what this server can do. Null when there's no API at all (a static host, or the old local server). */
  async config(): Promise<ConfigResponse | null> {
    try {
      const res = await fetch(ROUTES.config, { headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      const body = (await res.json()) as ConfigResponse;
      return body && typeof body.hosted === 'boolean' ? body : null;
    } catch {
      return null;
    }
  }

  me() {
    return this.call<MeResponse>('GET', ROUTES.me);
  }

  patchWorld(patch: WorldPatch) {
    return this.call<WorldInfo>('PATCH', ROUTES.world, patch);
  }

  async actions(): Promise<Action[]> {
    return (await this.call<ActionsResponse>('GET', ROUTES.actions)).actions;
  }

  async addAction(action: Action): Promise<Action[]> {
    return (await this.call<ActionsResponse>('POST', ROUTES.actions, { action })).actions;
  }

  timeline() {
    return this.call<Timeline>('GET', ROUTES.timeline);
  }

  checkout(interval: PlanInterval) {
    return this.call<RedirectResponse>('POST', ROUTES.checkout, { interval });
  }

  portal() {
    return this.call<RedirectResponse>('POST', ROUTES.portal);
  }

  connectStripe() {
    return this.call<RedirectResponse>('POST', ROUTES.connectStripe);
  }

  connectGithub() {
    return this.call<RedirectResponse>('POST', ROUTES.connectGithub);
  }

  disconnect(provider: Provider) {
    return this.call<{ ok: true }>('DELETE', `/api/connect/${provider}`);
  }

  async githubRepos(): Promise<ReposResponse['repos']> {
    return (await this.call<ReposResponse>('GET', ROUTES.githubRepos)).repos;
  }

  setGithubRepo(repo: string) {
    return this.call<Connections>('PUT', ROUTES.githubRepo, { repo });
  }

  setUsers(req: UsersRequest) {
    return this.call<Connections>('PUT', ROUTES.users, req);
  }

  /** Checks a users source (PostHog key, GA4 property) without saving it. */
  testUsers(req: Extract<UsersRequest, { source: 'posthog' | 'ga4' }>) {
    return this.call<UsersTestResult>('PUT', ROUTES.users, { ...req, test: true });
  }

  connectGa4() {
    return this.call<RedirectResponse>('POST', ROUTES.connectGa4);
  }

  async ga4Properties(): Promise<Ga4PropertiesResponse['properties']> {
    return (await this.call<Ga4PropertiesResponse>('GET', ROUTES.ga4Properties)).properties;
  }

  /** Everything we hold about the founder, as a file to save (named by the server). */
  async exportAccount(): Promise<{ blob: Blob; filename: string }> {
    const token = await this.hooks.token();
    let res: Response;
    try {
      res = await fetch(ROUTES.accountExport, { headers: token ? { Authorization: `Bearer ${token}` } : {}, credentials: 'same-origin' });
    } catch {
      throw networkError();
    }
    if (!res.ok) throw this.failed(toApiError(res.status, await res.json().catch(() => null)));
    const filename = filenameFrom(res.headers.get('Content-Disposition'), `tinytown-account-${new Date().toISOString().slice(0, 10)}.json`);
    return { blob: await res.blob(), filename };
  }

  emailPrefs() {
    return this.call<EmailPrefs>('GET', ROUTES.emailPrefs);
  }

  setEmailPrefs(patch: Partial<EmailPrefs>) {
    return this.call<EmailPrefs>('PUT', ROUTES.emailPrefs, patch);
  }

  /** Cancels the plan at once, disconnects everything and deletes the account. `confirm` is the email typed again (or "DELETE" without one). */
  deleteAccount(confirm: string) {
    return this.call<DeleteAccountResponse>('DELETE', ROUTES.account, { confirm } satisfies DeleteAccountRequest);
  }
}
