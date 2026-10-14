import { ROUTES, type Connections, type RedirectResponse, type ReposResponse } from '../src/api/contract.ts';
import { track } from './analytics.ts';
import type { Ctx, Hosted } from './context.ts';
import { githubAppJwt } from './crypto.ts';
import type { Settings } from './env.ts';
import { HttpError, badRequest, notConfigured, upstream } from './http.ts';
import { backHome, callbackUrl, finishState, startState } from './oauth.ts';
import { fetchGithub } from './sources.ts';
import { userState } from './state.ts';
import { connectionsOf, type ConnectionRow } from './store.ts';
import { markJoined } from './stripe-app.ts';
import type { AuthUser } from './supabase.ts';

/**
 * The TinyTown GitHub App: read-only Contents and Metadata on the
 * repositories the founder picks. Releases and commits drive HQ and the
 * train. The App is set to "Request user authorization (OAuth) during
 * installation", so the callback carries a user code we use to prove the
 * installation belongs to whoever is connecting (an `installation_id` in a
 * URL proves nothing on its own).
 */

type GithubApp = NonNullable<Settings['githubApp']>;

export function requireGithubApp(ctx: Ctx): GithubApp {
  if (!ctx.s.githubApp) throw notConfigured('Connecting GitHub');
  return ctx.s.githubApp;
}

const HEADERS = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'tinytown' };

export function installLink(ctx: Hosted, user: AuthUser): { body: RedirectResponse; setCookie: string } {
  const app = requireGithubApp(ctx);
  const { state, setCookie } = startState(ctx, user, 'github');
  return { body: { url: `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new?state=${encodeURIComponent(state)}` }, setCookie };
}

interface Installation {
  id: number;
  account: { login: string } | null;
}

/** Installations of our App that this GitHub user can access. */
async function userInstallations(userToken: string): Promise<Installation[]> {
  const out: Installation[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(`https://api.github.com/user/installations?per_page=100&page=${page}`, { headers: { ...HEADERS, Authorization: `Bearer ${userToken}` } });
    if (!res.ok) throw upstream(`GitHub responded ${res.status} listing installations.`);
    const body = (await res.json()) as { installations: Installation[] };
    out.push(...body.installations);
    if (body.installations.length < 100) break;
  }
  return out;
}

async function exchangeCode(app: GithubApp, code: string): Promise<string> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'tinytown' },
    body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, code }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !body.access_token) throw upstream(`GitHub wouldn't authorize (${body.error ?? res.status}).`);
  return body.access_token;
}

/** `GET /api/connect/github/callback?code=…&installation_id=…&setup_action=install&state=…` */
export async function callback(ctx: Hosted): Promise<Response> {
  if (!ctx.s.githubApp) return backHome(ctx, 'github', 'not_configured');
  const app = ctx.s.githubApp;
  const state = finishState(ctx, 'github');
  if (!state) return backHome(ctx, 'github', 'state');
  const q = ctx.url.searchParams;
  if (q.get('error')) return backHome(ctx, 'github', 'denied');
  // An organisation member asked an owner to approve the install; nothing to connect yet.
  if (q.get('setup_action') === 'request') return backHome(ctx, 'github', 'pending_approval');

  const code = q.get('code');
  if (!code) {
    // Already installed (GitHub skipped the authorization step): ask the user to
    // authorize so we can see which installations are theirs. Same state, same cookie.
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', app.clientId);
    url.searchParams.set('redirect_uri', callbackUrl(ctx, ROUTES.githubCallback, false));
    url.searchParams.set('state', q.get('state')!);
    return new Response(null, { status: 302, headers: { Location: url.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  }

  let installations: Installation[];
  try {
    installations = await userInstallations(await exchangeCode(app, code));
  } catch (err) {
    console.error(`GitHub callback failed: ${err instanceof Error ? err.message : 'unknown'}`);
    return backHome(ctx, 'github', 'upstream');
  }
  const asked = q.get('installation_id');
  const chosen = asked ? installations.find((i) => String(i.id) === asked) : installations[0];
  if (!chosen) return backHome(ctx, 'github', asked ? 'installation' : 'not_installed');

  const existing = await ctx.db.one<ConnectionRow>('connections', { user_id: state.user, provider: 'github' });
  const keepRepo = existing?.account_id === String(chosen.id) ? existing.metadata.repo : undefined;
  await ctx.db.upsert(
    'connections',
    {
      user_id: state.user,
      provider: 'github',
      account_id: String(chosen.id),
      display_name: chosen.account?.login ?? null,
      livemode: null,
      secret: null,
      metadata: keepRepo ? { repo: keepRepo } : {},
      connected_at: new Date(ctx.now).toISOString(),
      updated_at: new Date(ctx.now).toISOString(),
    },
    'user_id,provider',
  );
  await markJoined(ctx, state.user);
  await ctx.db.remove('timelines', { user_id: state.user });
  await track(ctx, state.user, 'connected_github', { reconnect: !!existing });
  return backHome(ctx, 'github');
}

// ─── Installation tokens ──────────────────────────────────────────────────

const tokens = new Map<string, { token: string; until: number }>();

/** A token for one installation (GitHub issues them for an hour); cached until five minutes before expiry. */
export async function installationToken(app: GithubApp, installationId: string, now = Date.now()): Promise<string> {
  const hit = tokens.get(installationId);
  if (hit && hit.until > now) return hit.token;
  const jwt = githubAppJwt(app.appId ?? app.clientId, app.privateKey, now);
  const res = await fetch(`https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    method: 'POST',
    headers: { ...HEADERS, Authorization: `Bearer ${jwt}` },
  });
  if (res.status === 404) throw new HttpError(409, 'The TinyTown GitHub App was uninstalled. Connect GitHub again.', 'not_connected');
  if (!res.ok) throw upstream(`GitHub responded ${res.status} for an installation token.`);
  const body = (await res.json()) as { token: string; expires_at: string };
  tokens.set(installationId, { token: body.token, until: Date.parse(body.expires_at) - 5 * 60_000 });
  return body.token;
}

export function resetGithubCaches() {
  tokens.clear();
}

async function githubRow(ctx: Hosted, user: AuthUser): Promise<ConnectionRow> {
  const row = await ctx.db.one<ConnectionRow>('connections', { user_id: user.id, provider: 'github' });
  if (!row) throw new HttpError(409, 'Connect GitHub first.', 'not_connected');
  return row;
}

/** `GET /api/connect/github/repos`: the repositories the installation can see. */
export async function repos(ctx: Hosted, user: AuthUser): Promise<ReposResponse> {
  const app = requireGithubApp(ctx);
  const token = await installationToken(app, (await githubRow(ctx, user)).account_id, ctx.now);
  const out: ReposResponse['repos'] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`https://api.github.com/installation/repositories?per_page=100&page=${page}`, { headers: { ...HEADERS, Authorization: `Bearer ${token}` } });
    if (!res.ok) throw upstream(`GitHub responded ${res.status} listing repositories.`);
    const body = (await res.json()) as { repositories: { full_name: string; private: boolean; default_branch: string }[] };
    out.push(...body.repositories.map((r) => ({ fullName: r.full_name, private: r.private, defaultBranch: r.default_branch })));
    if (body.repositories.length < 100) break;
  }
  return { repos: out };
}

// Neither half may be `.` or `..`: the name goes into an api.github.com path, and `../..` would walk out of /repos.
export const REPO_NAME = /^(?!\.{1,2}\/)[\w.-]{1,100}\/(?!\.{1,2}$)[\w.-]{1,100}$/;

/** `PUT /api/connect/github/repo { repo }`: choose the repository whose releases and commits count. */
export async function setRepo(ctx: Hosted, user: AuthUser, body: Record<string, unknown>): Promise<Connections> {
  const app = requireGithubApp(ctx);
  const repo = typeof body.repo === 'string' ? body.repo.trim() : '';
  if (!REPO_NAME.test(repo)) throw badRequest('Pick a repository like owner/name.');
  const row = await githubRow(ctx, user);
  const token = await installationToken(app, row.account_id, ctx.now);
  // The installation token only sees repositories the founder granted, so this is the access check.
  const res = await fetch(`https://api.github.com/repos/${repo}`, { headers: { ...HEADERS, Authorization: `Bearer ${token}` } });
  if (res.status === 404 || res.status === 403) throw badRequest("TinyTown can't see that repository. Add it to the app's access on GitHub.");
  if (!res.ok) throw upstream(`GitHub responded ${res.status}.`);
  const fullName = ((await res.json()) as { full_name: string }).full_name;
  await ctx.db.update('connections', { user_id: user.id, provider: 'github' }, { metadata: { ...row.metadata, repo: fullName }, updated_at: new Date(ctx.now).toISOString() });
  await ctx.db.remove('timelines', { user_id: user.id });
  // The profile as this request read it with the plan: choosing a repository doesn't change it.
  const profile = (await userState(ctx, user)).profile;
  return connectionsOf(profile, await ctx.db.many<ConnectionRow>('connections', { user_id: user.id }));
}

/** Releases and commits for the chosen repository, with the installation's token. */
export async function founderGithub(ctx: Hosted, row: ConnectionRow) {
  const repo = typeof row.metadata.repo === 'string' ? row.metadata.repo : null;
  if (!repo) return null;
  const token = await installationToken(requireGithubApp(ctx), row.account_id, ctx.now);
  return fetchGithub(repo, token);
}
