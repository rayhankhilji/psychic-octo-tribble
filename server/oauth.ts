import { RETURN_PARAMS } from '../src/api/contract.ts';
import type { Ctx, Hosted } from './context.ts';
import { STATE_TTL_MS, randomToken, safeEqual, signState, verifyState, type OAuthState } from './crypto.ts';
import { cookie, notConfigured, redirect } from './http.ts';
import type { AuthUser } from './supabase.ts';

/**
 * The shared half of every "connect" flow. The `state` we hand the provider
 * is HMAC-signed and names the user, the provider and an expiry; it also
 * carries a nonce that we set as an HttpOnly cookie on the same browser.
 * The callback needs both, so a link someone else started (with their own
 * state) can't attach your Stripe account to their city.
 */

const cookieName = (provider: OAuthState['provider']) => `tt_oauth_${provider}`;

function secure(ctx: Ctx): string {
  return (ctx.s.appUrl ?? ctx.url.origin).startsWith('https:') ? '; Secure' : '';
}

export function startState(ctx: Hosted, user: AuthUser, provider: OAuthState['provider'], extra: Partial<OAuthState> = {}) {
  if (!ctx.s.secrets) throw notConfigured('Connections');
  const nonce = randomToken();
  const state = signState({ user: user.id, provider, exp: ctx.now + STATE_TTL_MS, nonce, ...extra }, ctx.s.secrets.stateSecret);
  // SameSite=Lax: sent on the provider's top-level redirect back to us, never on cross-site subrequests.
  const setCookie = `${cookieName(provider)}=${nonce}; Path=/api/connect; HttpOnly; SameSite=Lax; Max-Age=${STATE_TTL_MS / 1000}${secure(ctx)}`;
  return { state, setCookie };
}

/** The verified state for this callback, or null if it's missing, forged, stale or from another browser. */
export function finishState(ctx: Hosted, provider: OAuthState['provider']): OAuthState | null {
  if (!ctx.s.secrets) return null;
  const state = verifyState(ctx.url.searchParams.get('state'), ctx.s.secrets.stateSecret, provider, ctx.now);
  const nonce = cookie(ctx.req, cookieName(provider));
  if (!state || !nonce || !safeEqual(nonce, state.nonce)) return null;
  return state;
}

export type ConnectFailure =
  | 'denied'
  | 'state'
  | 'testmode'
  | 'installation'
  | 'pending_approval'
  | 'not_installed'
  | 'upstream'
  | 'not_configured'
  | 'invalid_request';

const NAMES = { stripe: 'Stripe', github: 'GitHub' } as const;

/**
 * What goes after `provider:` in `connect_error`. The app knows the short
 * codes (denied, state, testmode, installation) and shows any sentence as is.
 */
function failureText(provider: OAuthState['provider'], why: ConnectFailure): string {
  const name = NAMES[provider];
  switch (why) {
    case 'denied':
    case 'state':
    case 'testmode':
    case 'installation':
      return why;
    case 'pending_approval':
      return 'Your organisation owner needs to approve the TinyTown GitHub App. Connect again once they have.';
    case 'not_installed':
      return 'Install the TinyTown GitHub App on your account, then connect again.';
    case 'upstream':
      return `${name} didn't answer properly. Try again in a moment.`;
    case 'not_configured':
      return `Connecting ${name} isn't set up on this server yet.`;
    case 'invalid_request':
      return 'That link was incomplete. Start again from here.';
  }
}

/** Back to the app: `/?connected=stripe` or `/?connect_error=stripe:…`, clearing the flow's cookie. */
export function backHome(ctx: Ctx, provider: OAuthState['provider'], error?: ConnectFailure): Response {
  const headers = new Headers();
  headers.append('Set-Cookie', `${cookieName(provider)}=; Path=/api/connect; HttpOnly; SameSite=Lax; Max-Age=0${secure(ctx)}`);
  const q = error ? `${RETURN_PARAMS.error}=${encodeURIComponent(`${provider}:${failureText(provider, error)}`)}` : `${RETURN_PARAMS.connected}=${provider}`;
  return redirect(`/?${q}`, headers);
}

/** OAuth redirect URIs must match the provider's settings exactly, so they come from APP_URL, never the request. */
export function callbackUrl(ctx: Ctx, path: string, requireHttps: boolean): string {
  const base = ctx.s.appUrl;
  if (!base) throw notConfigured('APP_URL');
  if (requireHttps && !base.startsWith('https://')) throw notConfigured('An https:// APP_URL');
  return `${base}${path}`;
}
