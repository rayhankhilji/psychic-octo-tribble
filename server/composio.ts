import type { GithubCommit, GithubRelease } from '../src/data/github.ts';
import type { StripeSubscription } from '../src/data/stripe.ts';
import type { Ctx } from './context.ts';
import type { Env } from './env.ts';
import { HttpError, upstream } from './http.ts';
import { UpstreamTimeout, deadline, fetchWithRetry } from './retry.ts';
import type { ConnectionRow } from './store.ts';

/**
 * Composio (composio.dev) as a second way to connect Stripe, GitHub and
 * Google Analytics, behind `CONNECT_VIA=composio`. The default is our own
 * Stripe App and GitHub App; docs/CONNECTORS.md has the comparison and why.
 *
 * How it works: Composio holds the founder's OAuth tokens. We ask it for a
 * connect link (`POST /connected_accounts/link`), the founder approves on
 * the provider, Composio sends them back to our usual callback, and from then
 * on every read goes through Composio's proxy (`POST /tools/execute/proxy`),
 * which makes the exact request we name with the founder's credentials and
 * hands back the provider's raw response. So the data is identical to the
 * native fetchers' (server/sources.ts) and the pipeline above doesn't change.
 *
 * Plain fetch, no SDK. Settings come straight from the environment:
 *   CONNECT_VIA=composio            off unless set (anything else means native)
 *   COMPOSIO_API_KEY                the project's API key (secret)
 *   COMPOSIO_STRIPE_AUTH_CONFIG     ac_… for the Stripe toolkit (OAuth2)
 *   COMPOSIO_GITHUB_AUTH_CONFIG     ac_… for the GitHub toolkit (OAuth2)
 *   COMPOSIO_GA4_AUTH_CONFIG        ac_… for the Google Analytics toolkit (OAuth2)
 *   COMPOSIO_API_URL                optional, default https://backend.composio.dev/api/v3.1
 * A provider goes through Composio only when its auth config is set.
 */

export type ComposioProvider = 'stripe' | 'github' | 'ga4';

const TOOLKIT: Record<ComposioProvider, string> = { stripe: 'stripe', github: 'github', ga4: 'google_analytics' };
const AUTH_CONFIG_VAR: Record<ComposioProvider, string> = {
  stripe: 'COMPOSIO_STRIPE_AUTH_CONFIG',
  github: 'COMPOSIO_GITHUB_AUTH_CONFIG',
  ga4: 'COMPOSIO_GA4_AUTH_CONFIG',
};
const NAMES: Record<ComposioProvider, string> = { stripe: 'Stripe', github: 'GitHub', ga4: 'Google Analytics' };

export interface ComposioSettings {
  apiKey: string;
  base: string;
  authConfig: string;
}

const val = (env: Env, name: string) => env[name]?.trim() || undefined;

/** Composio's settings for one provider, or null when that provider connects natively. */
export function composioFor(env: Env, provider: ComposioProvider): ComposioSettings | null {
  if (val(env, 'CONNECT_VIA') !== 'composio') return null;
  const apiKey = val(env, 'COMPOSIO_API_KEY');
  const authConfig = val(env, AUTH_CONFIG_VAR[provider]);
  if (!apiKey || !authConfig) return null;
  const base = (val(env, 'COMPOSIO_API_URL') ?? 'https://backend.composio.dev/api/v3.1').replace(/\/+$/, '');
  return { apiKey, base, authConfig };
}

/** A connection made through Composio keeps its Composio account id here. */
export function composioAccount(row: ConnectionRow): string | null {
  return row.metadata.via === 'composio' && typeof row.metadata.composio === 'string' ? row.metadata.composio : null;
}

/** Composio's ids are short and URL-safe (`ca_…`); anything else never reaches a URL. */
export const ACCOUNT_ID = /^[\w-]{4,64}$/;

function need(ctx: Ctx, provider: ComposioProvider): ComposioSettings {
  const s = composioFor(ctx.env, provider);
  if (!s) throw new HttpError(503, `Connecting ${NAMES[provider]} through Composio isn't set up on this server.`, 'not_configured');
  return s;
}

/** One call to Composio's own API. Its failures are ours to fix (a key, a config), so they read as "try again" to the founder and are logged. */
async function api<T>(s: ComposioSettings, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, signal?: AbortSignal): Promise<{ status: number; body: T }> {
  let res: Response;
  try {
    res = await fetchWithRetry(
      `${s.base}${path}`,
      { method, headers: { 'x-api-key': s.apiKey, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined },
      // Every call we make is a read (the proxy included), so repeating one is safe.
      { idempotent: true, timeoutMs: 8_000, signal },
    );
  } catch (err) {
    if (err instanceof UpstreamTimeout) throw upstream('Composio took too long to respond. Try again in a moment.');
    throw upstream('Composio could not be reached.');
  }
  const parsed = (await res.json().catch(() => null)) as T;
  if (res.status === 401 || res.status === 403) {
    console.error(`Composio refused our API key (${res.status} on ${path.split('?')[0]})`);
    throw upstream("Connecting through Composio isn't working on our side. Try again in a moment.");
  }
  return { status: res.status, body: parsed };
}

// ─── Connecting ───────────────────────────────────────────────────────────

/**
 * A Composio connect link for this founder. `user_id` is our user id, so the
 * account Composio makes is filed under them and nobody else; the callback
 * is our own (with our signed state), so the flow still ends where we check it.
 */
export async function connectLink(ctx: Ctx, provider: ComposioProvider, userId: string, callbackUrl: string): Promise<{ url: string; accountId: string }> {
  const s = need(ctx, provider);
  const { status, body } = await api<{ redirect_url?: string; connected_account_id?: string; error?: { message?: string } }>(s, 'POST', '/connected_accounts/link', {
    auth_config_id: s.authConfig,
    user_id: userId,
    callback_url: callbackUrl,
  });
  if (status >= 400 || !body?.redirect_url || !body.connected_account_id) {
    console.error(`Composio link for ${provider} failed: ${status} ${body?.error?.message ?? ''}`.trim());
    throw upstream(`Couldn't start connecting ${NAMES[provider]}. Try again in a moment.`);
  }
  return { url: body.redirect_url, accountId: body.connected_account_id };
}

interface AccountItem {
  id: string;
  status?: string;
  status_reason?: string | null;
  toolkit?: { slug?: string };
}

/**
 * The account Composio sent back, if it really is this founder's, for this
 * provider, and finished. Asked with all three filters at once, so an id
 * from someone else's flow (or another toolkit) simply isn't found.
 */
export async function verifiedAccount(ctx: Ctx, provider: ComposioProvider, userId: string, accountId: string): Promise<AccountItem | null> {
  if (!ACCOUNT_ID.test(accountId)) return null;
  const s = need(ctx, provider);
  const q = new URLSearchParams({ connected_account_ids: accountId, user_ids: userId, toolkit_slugs: TOOLKIT[provider], limit: '5' });
  const { status, body } = await api<{ items?: AccountItem[] }>(s, 'GET', `/connected_accounts?${q}`);
  if (status >= 400) throw upstream(`Composio responded ${status} checking the connection.`);
  const item = body?.items?.find((i) => i.id === accountId && (i.toolkit?.slug ?? TOOLKIT[provider]) === TOOLKIT[provider]);
  return item && item.status === 'ACTIVE' ? item : null;
}

/** Still connected? Used where the native code would refresh a token (and by the hourly check for broken connections). */
export async function ensureActive(ctx: Ctx, provider: ComposioProvider, row: ConnectionRow): Promise<void> {
  const id = composioAccount(row);
  if (!id || !ACCOUNT_ID.test(id)) throw reconnect(provider);
  const s = need(ctx, provider);
  const { status, body } = await api<AccountItem>(s, 'GET', `/connected_accounts/${encodeURIComponent(id)}`);
  if (status === 404 || (status < 400 && body?.status !== 'ACTIVE')) throw reconnect(provider);
  if (status >= 400) throw upstream(`Composio responded ${status} checking the connection.`);
}

/** Revokes Composio's copy of the founder's tokens (on disconnect or account deletion). Best effort: a failure is logged, not shown. */
export async function removeAccount(ctx: Ctx, provider: ComposioProvider, row: ConnectionRow): Promise<void> {
  const id = composioAccount(row);
  const s = composioFor(ctx.env, provider);
  if (!id || !s || !ACCOUNT_ID.test(id)) return;
  try {
    const { status } = await api(s, 'DELETE', `/connected_accounts/${encodeURIComponent(id)}`);
    if (status >= 400 && status !== 404) console.error(`Composio wouldn't delete ${provider} account: ${status}`);
  } catch (err) {
    console.error(`Composio delete failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

const reconnect = (provider: ComposioProvider) => new HttpError(409, `Your ${NAMES[provider]} connection has expired. Connect ${NAMES[provider]} again.`, 'not_connected');

// ─── The proxy ────────────────────────────────────────────────────────────

interface ProxyRequest {
  /** An absolute URL on the provider's API. */
  url: string;
  method?: 'GET' | 'POST';
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}

/**
 * One request to the provider, made by Composio with the founder's
 * credentials. Returns the provider's status and raw body. A provider 401/403
 * means the founder's grant is gone (reconnect); Composio refusing the
 * account (404/400/410) means the same.
 */
export async function proxy<T>(ctx: Ctx, provider: ComposioProvider, accountId: string, req: ProxyRequest, signal?: AbortSignal): Promise<{ status: number; data: T }> {
  const s = need(ctx, provider);
  const parameters = [
    ...Object.entries(req.query ?? {}).map(([name, value]) => ({ name, value, type: 'query' })),
    ...Object.entries(req.headers ?? {}).map(([name, value]) => ({ name, value, type: 'header' })),
  ];
  const { status, body } = await api<{ data?: T; status?: number; error?: unknown }>(
    s,
    'POST',
    '/tools/execute/proxy',
    { endpoint: req.url, method: req.method ?? 'GET', connected_account_id: accountId, parameters, ...(req.body !== undefined ? { body: req.body } : {}) },
    signal,
  );
  // Composio answers 404/410 for an account that's gone, and 400 for one that isn't active (expired, revoked).
  const why = JSON.stringify(body?.error ?? '').toLowerCase();
  if (status === 404 || status === 410 || (status === 400 && /account|expired|inactive|not active|revoked/.test(why))) throw reconnect(provider);
  if (status >= 400) {
    console.error(`Composio proxy ${status}: ${why.slice(0, 200)}`);
    throw upstream(`Composio responded ${status}.`);
  }
  const upstreamStatus = typeof body?.status === 'number' ? body.status : 200;
  if (upstreamStatus === 401 || upstreamStatus === 403) throw reconnect(provider);
  return { status: upstreamStatus, data: body?.data as T };
}

/** Each history gets the same 15 s budget as the native fetchers. */
const HISTORY_TIMEOUT_MS = 15_000;

function providerError(name: string, status: number, data: unknown): Error {
  const d = data as { error?: { message?: string }; message?: string } | null;
  const message = d?.error?.message ?? d?.message ?? '';
  return new Error(`${name} responded ${status}${message ? `: ${String(message).split(' (')[0]!.trim()}` : ''}`);
}

// ─── Stripe ───────────────────────────────────────────────────────────────

const STRIPE_PAGE_LIMIT = 50; // 5,000 subscriptions, as the native fetcher

/** The same list as `fetchStripeSubscriptions`: every subscription, any status, newest first, 100 a page. */
export async function stripeSubscriptions(ctx: Ctx, accountId: string): Promise<StripeSubscription[]> {
  const signal = deadline(HISTORY_TIMEOUT_MS);
  const subs: StripeSubscription[] = [];
  let after: string | undefined;
  for (let page = 0; page < STRIPE_PAGE_LIMIT; page++) {
    const query: Record<string, string> = { status: 'all', limit: '100', ...(after ? { starting_after: after } : {}) };
    const { status, data } = await proxy<{ data?: StripeSubscription[]; has_more?: boolean }>(ctx, 'stripe', accountId, { url: 'https://api.stripe.com/v1/subscriptions', query }, signal);
    if (status >= 400 || !Array.isArray(data?.data)) throw providerError('Stripe', status, data);
    subs.push(...data.data);
    if (!data.has_more || data.data.length === 0) break;
    after = data.data.at(-1)!.id;
  }
  return subs;
}

/** Who the founder connected: the account id, its name, and live or test mode. */
export async function stripeAccount(ctx: Ctx, accountId: string): Promise<{ id: string; name: string | null; livemode: boolean }> {
  const [account, balance] = await Promise.all([
    proxy<{ id?: string; settings?: { dashboard?: { display_name?: string | null } }; business_profile?: { name?: string | null } }>(ctx, 'stripe', accountId, { url: 'https://api.stripe.com/v1/account' }),
    // The balance is the cheapest object that says which mode the token is for.
    proxy<{ livemode?: boolean }>(ctx, 'stripe', accountId, { url: 'https://api.stripe.com/v1/balance' }),
  ]);
  if (account.status >= 400 || typeof account.data?.id !== 'string') throw providerError('Stripe', account.status, account.data);
  const name = account.data.settings?.dashboard?.display_name || account.data.business_profile?.name || null;
  return { id: account.data.id, name, livemode: balance.data?.livemode === true };
}

// ─── GitHub ───────────────────────────────────────────────────────────────

const GITHUB = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
const GITHUB_COMMIT_PAGES = 10; // 1,000 most recent commits, as the native fetcher
/** owner/name, neither half `.` or `..` (the same rule as github-app.ts). */
const REPO = /^(?!\.{1,2}\/)[\w.-]{1,100}\/(?!\.{1,2}$)[\w.-]{1,100}$/;

/** The same shape as `fetchGithub`: recent commits and releases for one repository. */
export async function githubHistory(ctx: Ctx, accountId: string, repo: string): Promise<{ commits: GithubCommit[]; releases: GithubRelease[] }> {
  if (!REPO.test(repo)) throw new Error(`A repository looks like owner/name, got "${repo}"`);
  const signal = deadline(HISTORY_TIMEOUT_MS);
  const pages = async <T>(path: string, max: number): Promise<T[]> => {
    const out: T[] = [];
    for (let page = 1; page <= max; page++) {
      const { status, data } = await proxy<T[]>(ctx, 'github', accountId, { url: `https://api.github.com/repos/${repo}/${path}`, query: { per_page: '100', page: String(page) }, headers: GITHUB }, signal);
      if (status === 409) break; // empty repository
      if (status >= 400 || !Array.isArray(data)) throw providerError('GitHub', status, data);
      out.push(...data);
      if (data.length < 100) break;
    }
    return out;
  };
  const [commits, releases] = await Promise.all([pages<GithubCommit>('commits', GITHUB_COMMIT_PAGES), pages<GithubRelease>('releases', 5)]);
  return { commits, releases };
}

/** The founder's login, to name the connection. */
export async function githubLogin(ctx: Ctx, accountId: string): Promise<string | null> {
  const { status, data } = await proxy<{ login?: string }>(ctx, 'github', accountId, { url: 'https://api.github.com/user', headers: GITHUB });
  return status < 400 && typeof data?.login === 'string' ? data.login : null;
}

/** Repositories the founder can read: theirs, ones they collaborate on, and their organisations'. */
export async function githubRepos(ctx: Ctx, accountId: string): Promise<{ fullName: string; private: boolean; defaultBranch: string }[]> {
  const out: { fullName: string; private: boolean; defaultBranch: string }[] = [];
  for (let page = 1; page <= 10; page++) {
    const { status, data } = await proxy<{ full_name: string; private: boolean; default_branch: string }[]>(ctx, 'github', accountId, {
      url: 'https://api.github.com/user/repos',
      query: { per_page: '100', page: String(page), sort: 'pushed', affiliation: 'owner,collaborator,organization_member' },
      headers: GITHUB,
    });
    if (status >= 400 || !Array.isArray(data)) throw upstream(`GitHub responded ${status} listing repositories.`);
    out.push(...data.map((r) => ({ fullName: r.full_name, private: r.private, defaultBranch: r.default_branch })));
    if (data.length < 100) break;
  }
  return out;
}

/** The repository's canonical name if the founder can read it, else null. */
export async function githubRepo(ctx: Ctx, accountId: string, repo: string): Promise<string | null> {
  if (!REPO.test(repo)) return null;
  const { status, data } = await proxy<{ full_name?: string }>(ctx, 'github', accountId, { url: `https://api.github.com/repos/${repo}`, headers: GITHUB });
  if (status === 404 || status === 403) return null;
  if (status >= 400 || typeof data?.full_name !== 'string') throw upstream(`GitHub responded ${status}.`);
  return data.full_name;
}

// ─── Google Analytics 4 ───────────────────────────────────────────────────

export const GA4_PROPERTY = /^\d{1,15}$/;

/** Every GA4 property the founder can read, with its account's name. */
export async function ga4Properties(ctx: Ctx, accountId: string): Promise<{ id: string; name: string; account: string }[]> {
  const out: { id: string; name: string; account: string }[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page++) {
    const { status, data } = await proxy<{ accountSummaries?: { displayName?: string; propertySummaries?: { property?: string; displayName?: string }[] }[]; nextPageToken?: string }>(
      ctx,
      'ga4',
      accountId,
      { url: 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries', query: { pageSize: '200', ...(pageToken ? { pageToken } : {}) } },
    );
    if (status >= 400) throw upstream(`Google Analytics responded ${status} listing properties.`);
    for (const a of data?.accountSummaries ?? []) {
      for (const p of a.propertySummaries ?? []) {
        const id = p.property?.replace(/^properties\//, '') ?? '';
        if (GA4_PROPERTY.test(id)) out.push({ id, name: p.displayName ?? `Property ${id}`, account: a.displayName ?? '' });
      }
    }
    pageToken = data?.nextPageToken || undefined;
    if (!pageToken) break;
  }
  return out;
}

/**
 * day (UTC ms) → people active in the 28 days up to and including that day,
 * for the last year. GA4's `active28DayUsers` is its own rolling monthly
 * count (PostHog's is 30 days; both are "monthly active users").
 */
export async function ga4ActiveUsers(ctx: Ctx, accountId: string, propertyId: string): Promise<Map<number, number>> {
  if (!GA4_PROPERTY.test(propertyId)) throw new HttpError(400, 'Pick one of your Google Analytics properties.', 'bad_request');
  const { status, data } = await proxy<{ rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[] }>(ctx, 'ga4', accountId, {
    url: `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
    method: 'POST',
    body: {
      dateRanges: [{ startDate: '364daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'active28DayUsers' }],
      limit: 400,
    },
  });
  if (status === 404) throw new HttpError(409, "Google Analytics couldn't find that property any more. Pick it again.", 'not_connected');
  if (status >= 400) throw upstream(`Google Analytics responded ${status}.`);
  const out = new Map<number, number>();
  for (const r of data?.rows ?? []) {
    const d = r.dimensionValues?.[0]?.value ?? '';
    const v = Number(r.metricValues?.[0]?.value);
    const t = /^\d{8}$/.test(d) ? Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) : NaN;
    if (Number.isFinite(t) && Number.isFinite(v) && v >= 0) out.set(t, Math.round(v));
  }
  return out;
}
