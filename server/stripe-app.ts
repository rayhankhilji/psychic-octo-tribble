import { randomInt } from 'node:crypto';
import { ROUTES, type RedirectResponse } from '../src/api/contract.ts';
import type { StripeSubscription } from '../src/data/stripe.ts';
import { startOfDay } from '../src/data/types.ts';
import { track } from './analytics.ts';
import { composioAccount, composioFor, connectLink, ensureActive, stripeAccount, stripeSubscriptions, verifiedAccount } from './composio.ts';
import type { Ctx, Hosted } from './context.ts';
import { decrypt, encrypt } from './crypto.ts';
import { decryptionKeys, type Settings } from './env.ts';
import { HttpError, notConfigured, upstream } from './http.ts';
import { backHome, callbackUrl, finishState, startState } from './oauth.ts';
import { fetchStripeSubscriptions } from './sources.ts';
import { hasAccess } from './billing.ts';
import type { ConnectionRow, ProfileRow, SubscriptionRow } from './store.ts';
import type { AuthUser } from './supabase.ts';

/**
 * The founder's own Stripe account, through the TinyTown Stripe App (OAuth
 * 2.0, read-only permissions). No pasted keys: the founder approves the app
 * on Stripe, we keep an encrypted refresh token, and trade it for an
 * access token (one hour) whenever we need their subscriptions.
 * https://docs.stripe.com/stripe-apps/api-authentication/oauth
 */

type StripeApp = NonNullable<Settings['stripeApp']>;

export function requireStripeApp(ctx: Ctx): StripeApp & { secrets: NonNullable<Settings['secrets']> } {
  if (!ctx.s.stripeApp || !ctx.s.secrets) throw notConfigured('Connecting Stripe');
  return { ...ctx.s.stripeApp, secrets: ctx.s.secrets };
}

export function installLink(ctx: Hosted, user: AuthUser): { body: RedirectResponse; setCookie: string } {
  if (composioFor(ctx.env, 'stripe')) {
    // Through Composio: the browser first comes back to our own callback with
    // the signed state (and the cookie this response sets), which asks
    // Composio for the link. Starting there keeps this route synchronous and
    // the whole flow tied to the browser that began it.
    const { state, setCookie } = startState(ctx, user, 'stripe');
    const url = new URL(callbackUrl(ctx, ROUTES.stripeCallback, false));
    url.searchParams.set('state', state);
    url.searchParams.set('via', 'composio');
    return { body: { url: url.toString() }, setCookie };
  }
  const app = requireStripeApp(ctx);
  // Stripe requires HTTPS redirect URIs in live mode.
  const redirectUri = callbackUrl(ctx, ROUTES.stripeCallback, app.livemode);
  const { state, setCookie } = startState(ctx, user, 'stripe', { live: app.livemode });
  const url = new URL(app.installUrl);
  url.searchParams.set('client_id', app.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  return { body: { url: url.toString() }, setCookie };
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  livemode: boolean;
  stripe_user_id: string;
  scope?: string;
}

/** POST /v1/oauth/token, authenticated with our app developer account's secret key. */
async function tokenRequest(appKey: string, params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch('https://api.stripe.com/v1/oauth/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${appKey}:`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string | { message?: string }; error_description?: string };
  if (!res.ok || typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string' || typeof body.stripe_user_id !== 'string') {
    const reason = typeof body.error === 'string' ? body.error : (body.error?.message ?? `status ${res.status}`);
    // 400/401 mean the code or refresh token is spent or revoked: only reconnecting fixes that.
    const dead = res.status === 400 || res.status === 401;
    throw new HttpError(dead ? 409 : 502, `Stripe wouldn't issue a token (${reason}).`, dead ? 'not_connected' : 'upstream');
  }
  return body as TokenResponse;
}

/** Access tokens last an hour; we refresh a little early. */
const ACCESS_TTL_MS = 55 * 60_000;

/** `GET /api/connect/stripe/callback?code=…&state=…`: Stripe sends the founder back here after they approve the app. */
export async function callback(ctx: Hosted): Promise<Response> {
  if (composioFor(ctx.env, 'stripe')) return composioCallback(ctx);
  const app = ctx.s.stripeApp && ctx.s.secrets ? requireStripeApp(ctx) : null;
  if (!app) return backHome(ctx, 'stripe', 'not_configured');
  const state = finishState(ctx, 'stripe');
  if (!state) return backHome(ctx, 'stripe', 'state');
  if (ctx.url.searchParams.get('error')) return backHome(ctx, 'stripe', 'denied');
  const code = ctx.url.searchParams.get('code');
  if (!code || code.length > 512) return backHome(ctx, 'stripe', 'invalid_request');
  // The link was made for one mode; the code must be exchanged with that mode's key.
  if (state.live !== app.livemode) return backHome(ctx, 'stripe', 'state');

  let token: TokenResponse;
  try {
    token = await tokenRequest(app.secretKey, { grant_type: 'authorization_code', code });
  } catch (err) {
    console.error(`Stripe App code exchange failed: ${err instanceof Error ? err.message : 'unknown'}`);
    return backHome(ctx, 'stripe', 'upstream');
  }
  // Test-mode data never drives a real city (honest metrics), except while developing.
  if (!token.livemode && !ctx.s.allowTestMode) return backHome(ctx, 'stripe', 'testmode');

  const user = state.user;
  const enc = (s: string) => encrypt(s, app.secrets.encryptionKey, `${user}:stripe`);
  await ctx.db.upsert(
    'connections',
    {
      user_id: user,
      provider: 'stripe',
      account_id: token.stripe_user_id,
      display_name: null,
      livemode: token.livemode,
      secret: enc(token.refresh_token),
      access_token: enc(token.access_token),
      access_expires_at: new Date(ctx.now + ACCESS_TTL_MS).toISOString(),
      // A fresh version, so a refresh racing against this reconnect can't overwrite it.
      token_version: randomInt(1, 1_000_000_000),
      metadata: {},
      connected_at: new Date(ctx.now).toISOString(),
      updated_at: new Date(ctx.now).toISOString(),
    },
    'user_id,provider',
  );
  await markJoined(ctx, user);
  await ctx.db.remove('timelines', { user_id: user });
  await track(ctx, user, 'connected_stripe', { livemode: token.livemode });
  return backHome(ctx, 'stripe');
}

/**
 * The Composio flow, both legs: `?via=composio` (from installLink) goes out
 * to Composio's link; `?status=…&connected_account_id=…` is Composio sending
 * the founder back. Either way the signed state and its cookie must match.
 */
async function composioCallback(ctx: Hosted): Promise<Response> {
  if (!ctx.s.secrets) return backHome(ctx, 'stripe', 'not_configured');
  const state = finishState(ctx, 'stripe');
  if (!state) return backHome(ctx, 'stripe', 'state');
  const q = ctx.url.searchParams;
  const accountId = q.get('connected_account_id');
  if (q.get('via') === 'composio' && !accountId) {
    const back = new URL(callbackUrl(ctx, ROUTES.stripeCallback, false));
    back.searchParams.set('state', q.get('state')!);
    const { url } = await connectLink(ctx, 'stripe', state.user, back.toString());
    return awayTo(url);
  }
  if (q.get('status') !== 'success' || !accountId) return backHome(ctx, 'stripe', 'denied');
  if (!(await verifiedAccount(ctx, 'stripe', state.user, accountId))) return backHome(ctx, 'stripe', 'state');

  const account = await stripeAccount(ctx, accountId);
  if (!account.livemode && !ctx.s.allowTestMode) return backHome(ctx, 'stripe', 'testmode');
  const stamp = new Date(ctx.now).toISOString();
  await ctx.db.upsert(
    'connections',
    {
      user_id: state.user,
      provider: 'stripe',
      account_id: account.id,
      display_name: account.name,
      livemode: account.livemode,
      // Composio holds the tokens; we keep only which of its accounts is this founder's.
      secret: null,
      access_token: null,
      access_expires_at: null,
      token_version: randomInt(1, 1_000_000_000),
      metadata: { via: 'composio', composio: accountId },
      connected_at: stamp,
      updated_at: stamp,
    },
    'user_id,provider',
  );
  await markJoined(ctx, state.user);
  await ctx.db.remove('timelines', { user_id: state.user });
  await track(ctx, state.user, 'connected_stripe', { livemode: account.livemode, via: 'composio' });
  return backHome(ctx, 'stripe');
}

/** Off to a provider's page (Composio's link): https only, never cached, no Referer. */
export function awayTo(url: string): Response {
  if (!/^https:\/\//.test(url)) throw upstream("Couldn't start connecting. Try again in a moment.");
  return new Response(null, { status: 302, headers: { Location: url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

/**
 * The day the founder's city opens starts their back-pay window (see
 * GAME_DESIGN, "Back pay"): connecting Stripe with a plan, or paying with
 * Stripe already connected (billing.ts), whichever comes second. Setup is
 * free, so connecting without a plan starts nothing yet.
 */
export async function markJoined(ctx: Hosted, userId: string, opts: { paid?: boolean } = {}) {
  const [profile, sub] = await Promise.all([
    ctx.db.one<ProfileRow>('profiles', { user_id: userId }),
    opts.paid ? null : ctx.db.one<SubscriptionRow>('subscriptions', { user_id: userId }),
  ]);
  if (!opts.paid && !hasAccess(sub, ctx.now)) return;
  if (profile && profile.joined_at == null) {
    await ctx.db.update('profiles', { user_id: userId }, { joined_at: startOfDay(ctx.now), updated_at: new Date(ctx.now).toISOString() });
  }
}

// ─── Access tokens, with rolling refresh tokens ───────────────────────────

const refreshing = new Map<string, Promise<string>>();

/**
 * A valid access token for the founder's account. Refresh tokens roll on
 * every use (the old one dies), so the new one must be stored every time,
 * and two servers must not both spend the same one. Within an instance,
 * concurrent callers share one refresh; across instances, the write only
 * lands on the version we read, and a loser re-reads the winner's token.
 */
export function accessToken(ctx: Hosted, row: ConnectionRow): Promise<string> {
  // A Composio connection has no token of ours: Composio refreshes it. This
  // only checks it still works, for the hourly look for broken connections.
  if (composioAccount(row)) return ensureActive(ctx, 'stripe', row).then(() => '');
  const app = requireStripeApp(ctx);
  const ctxKey = `${row.user_id}:stripe`;
  // Any key still in rotation opens it; every refresh re-seals under the current key.
  const dec = (s: string) => decrypt(s, decryptionKeys(app.secrets), ctxKey);
  if (row.access_token && row.access_expires_at && Date.parse(row.access_expires_at) > ctx.now + 2 * 60_000) {
    return Promise.resolve(dec(row.access_token));
  }
  const pending = refreshing.get(row.user_id);
  if (pending) return pending;
  const run = (async () => {
    if (!row.secret) throw reconnect();
    if (!!row.livemode !== app.livemode) throw reconnect();
    let refreshToken: string;
    try {
      refreshToken = dec(row.secret);
    } catch {
      // Sealed under a different TOKEN_ENCRYPTION_KEY: only reconnecting can fix it.
      throw reconnect();
    }
    let token: TokenResponse;
    try {
      token = await tokenRequest(app.secretKey, { grant_type: 'refresh_token', refresh_token: refreshToken });
    } catch (err) {
      // Another server may have just spent this refresh token; use what it stored.
      const latest = await ctx.db.one<ConnectionRow>('connections', { user_id: row.user_id, provider: 'stripe' });
      if (latest && latest.token_version !== row.token_version && latest.access_token && latest.access_expires_at && Date.parse(latest.access_expires_at) > ctx.now) {
        return dec(latest.access_token);
      }
      if (err instanceof HttpError && err.code === 'not_connected') throw reconnect();
      throw err;
    }
    const patch = {
      secret: encrypt(token.refresh_token, app.secrets.encryptionKey, ctxKey),
      access_token: encrypt(token.access_token, app.secrets.encryptionKey, ctxKey),
      access_expires_at: new Date(ctx.now + ACCESS_TTL_MS).toISOString(),
      token_version: row.token_version + 1,
      updated_at: new Date(ctx.now).toISOString(),
    };
    // The old refresh token is dead now: losing the new one would disconnect
    // the founder, so retry the write a couple of times before giving up.
    // An empty result means another server stored a newer token first; ours still works for this request.
    for (let attempt = 1; ; attempt++) {
      try {
        await ctx.db.update('connections', { user_id: row.user_id, provider: 'stripe', token_version: row.token_version }, patch);
        break;
      } catch {
        if (attempt >= 3) {
          console.error(`Couldn't store a rolled Stripe refresh token for user ${row.user_id}`);
          break;
        }
      }
    }
    return token.access_token;
  })();
  refreshing.set(row.user_id, run);
  return run.finally(() => refreshing.delete(row.user_id));
}

const reconnect = () => new HttpError(409, 'Your Stripe connection has expired. Connect Stripe again.', 'not_connected');

/** Every subscription on the founder's account, read with their access token. */
export async function founderSubscriptions(ctx: Hosted, row: ConnectionRow): Promise<StripeSubscription[]> {
  const viaComposio = composioAccount(row);
  if (viaComposio) return stripeSubscriptions(ctx, viaComposio);
  const token = await accessToken(ctx, row);
  return fetchStripeSubscriptions(token);
}
