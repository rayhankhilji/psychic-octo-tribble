import type { Connections, RedirectResponse } from '../src/api/contract.ts';
import { startOfDay, type Snapshot } from '../src/data/types.ts';
import { GA4_PROPERTY, composioAccount, composioFor, connectLink, ga4ActiveUsers, ga4Properties, verifiedAccount } from './composio.ts';
import type { Hosted } from './context.ts';
import { encrypt, openSecret, type OAuthState } from './crypto.ts';
import { decryptionKeys } from './env.ts';
import { HttpError, badRequest, notConfigured } from './http.ts';
import { callbackUrl, finishState, startState } from './oauth.ts';
import { PERSONAL_KEY, PROJECT_ID, monthlyActiveUsers, posthogOrigin } from './posthog.ts';
import { awayTo } from './stripe-app.ts';
import { userState } from './state.ts';
import { connectionsOf, ensureProfile, type ConnectionRow, type ProfileRow } from './store.ts';
import type { AuthUser } from './supabase.ts';

/**
 * Where the city's population comes from: paying customers (the default),
 * a number the founder types in, or PostHog's monthly active users.
 */

/**
 * What "Test connection" answers: the source was reached and this is what it
 * says today, but nothing was saved. `PUT /api/connect/users` with
 * `test: true` (PostHog, or Google Analytics through Composio).
 */
export interface UsersTestResult {
  ok: true;
  source: 'posthog' | 'ga4';
  /** The latest day's monthly active users, or null if the source has no days yet. */
  monthlyActiveUsers: number | null;
  /** That day (UTC ms). */
  asOf: number | null;
  /** How many days of history the source returned. */
  days: number;
}

function testResult(source: UsersTestResult['source'], mau: Map<number, number>): UsersTestResult {
  const last = [...mau.keys()].sort((a, b) => a - b).at(-1) ?? null;
  return { ok: true, source, monthlyActiveUsers: last == null ? null : mau.get(last)!, asOf: last, days: mau.size };
}

/**
 * Google Analytics isn't in the database's provider list or users_source
 * until migration 0008 (see docs/CONNECTORS.md); these keep the code honest
 * about that in one place.
 */
const GA4 = 'ga4' as unknown as ConnectionRow['provider'];
const GA4_SOURCE = 'ga4' as unknown as ProfileRow['users_source'];
const GA4_STATE = 'ga4' as unknown as OAuthState['provider'];
export const GA4_CALLBACK = '/api/connect/ga4/callback';

const MAX_MANUAL = 1_000_000_000;
/** Manual entries kept, one per day at most. */
const MANUAL_HISTORY = 400;

/** `PUT /api/connect/users`. With `test: true` (PostHog, Google Analytics) it only checks the source and saves nothing. */
export async function setUsersSource(ctx: Hosted, user: AuthUser, body: Record<string, unknown>): Promise<Connections | UsersTestResult> {
  const testOnly = body.test === true;
  const profile = (await userState(ctx, user)).profile;
  const stamp = new Date(ctx.now).toISOString();
  switch (body.source) {
    case 'customers':
      await ctx.db.update('profiles', { user_id: user.id }, { users_source: 'customers', updated_at: stamp });
      break;
    case 'manual': {
      const value = body.value;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_MANUAL) {
        throw badRequest('Enter your active users as a whole number.');
      }
      // Each number counts from the day it was entered: earlier days keep what was true then.
      const today = startOfDay(ctx.now);
      const history = profile.users_manual.filter((e) => e.t < today).concat({ t: today, value }).slice(-MANUAL_HISTORY);
      await ctx.db.update('profiles', { user_id: user.id }, { users_source: 'manual', users_manual: history, updated_at: stamp });
      break;
    }
    case 'posthog': {
      if (!ctx.s.secrets) throw notConfigured('Connections');
      const origin = posthogOrigin(String(body.host ?? ''), ctx.s.posthog.hosts);
      const projectId = String(body.projectId ?? '').trim();
      const apiKey = String(body.apiKey ?? '').trim();
      if (!PROJECT_ID.test(projectId)) throw badRequest('The project id is the number in your PostHog project URL.');
      if (!PERSONAL_KEY.test(apiKey)) throw badRequest('Use a PostHog personal API key (it starts with phx_).');
      // Try it now, so a typo shows up here rather than as a broken city later.
      const mau = await monthlyActiveUsers(origin, projectId, apiKey);
      if (testOnly) return testResult('posthog', mau);
      await ctx.db.upsert(
        'connections',
        {
          user_id: user.id,
          provider: 'posthog',
          account_id: projectId,
          display_name: null,
          livemode: null,
          secret: encrypt(apiKey, ctx.s.secrets.encryptionKey, `${user.id}:posthog`),
          metadata: { host: origin },
          connected_at: stamp,
          updated_at: stamp,
        },
        'user_id,provider',
      );
      await ctx.db.update('profiles', { user_id: user.id }, { users_source: 'posthog', updated_at: stamp });
      break;
    }
    case 'ga4': {
      const row = await ga4Row(ctx, user.id);
      const property = String(body.property ?? '').trim();
      if (!GA4_PROPERTY.test(property)) throw badRequest('Pick one of your Google Analytics properties.');
      const mau = await ga4ActiveUsers(ctx, composioAccount(row)!, property);
      if (testOnly) return testResult('ga4', mau);
      const propertyName = typeof body.propertyName === 'string' ? body.propertyName.trim().slice(0, 100) : '';
      await ctx.db.update('connections', { user_id: user.id, provider: GA4 }, { metadata: { ...row.metadata, property, propertyName: propertyName || null }, updated_at: stamp });
      await ctx.db.update('profiles', { user_id: user.id }, { users_source: GA4_SOURCE, updated_at: stamp });
      break;
    }
    default:
      throw badRequest('Choose customers, manual or posthog.');
  }
  await ctx.db.remove('timelines', { user_id: user.id });
  const fresh = await ensureProfile(ctx.db, user.id);
  return connectionsOf(fresh, await ctx.db.many<ConnectionRow>('connections', { user_id: user.id }));
}

/**
 * Fills `users` on each snapshot from the chosen source. Days the source
 * knows nothing about are left without it, so the population falls back to
 * paying customers there instead of inventing a number.
 */
export async function applyUsers(ctx: Hosted, profile: ProfileRow, rows: ConnectionRow[], snapshots: Snapshot[]): Promise<Snapshot[]> {
  if (profile.users_source === 'manual' && profile.users_manual.length) {
    const entries = [...profile.users_manual].sort((a, b) => a.t - b.t);
    return snapshots.map((s) => {
      const e = entries.filter((x) => x.t <= s.t).at(-1);
      return e ? { ...s, users: e.value } : s;
    });
  }
  const ph = rows.find((r) => r.provider === 'posthog');
  if (profile.users_source === 'posthog' && ph?.secret && ctx.s.secrets) {
    const { plain: key, stale } = openSecret(ph.secret, decryptionKeys(ctx.s.secrets), `${profile.user_id}:posthog`);
    // Sealed under the previous key: seal it again under the current one (key rotation, docs/SECURITY.md).
    if (stale) {
      const secret = encrypt(key, ctx.s.secrets.encryptionKey, `${profile.user_id}:posthog`);
      await ctx.db.update('connections', { user_id: profile.user_id, provider: 'posthog' }, { secret }).catch(() => {});
    }
    // Re-checked against today's allow-list, in case POSTHOG_HOSTS has changed since.
    const mau = await monthlyActiveUsers(posthogOrigin(String(ph.metadata.host), ctx.s.posthog.hosts), ph.account_id, key);
    return snapshots.map((s) => (mau.has(s.t) ? { ...s, users: mau.get(s.t)! } : s));
  }
  const ga = rows.find((r) => r.provider === GA4);
  const gaAccount = ga && composioAccount(ga);
  if (profile.users_source === GA4_SOURCE && ga && gaAccount && typeof ga.metadata.property === 'string') {
    const mau = await ga4ActiveUsers(ctx, gaAccount, ga.metadata.property);
    return snapshots.map((s) => (mau.has(s.t) ? { ...s, users: mau.get(s.t)! } : s));
  }
  return snapshots;
}

// ─── Google Analytics, through Composio ───────────────────────────────────

async function ga4Row(ctx: Hosted, userId: string): Promise<ConnectionRow> {
  const row = await ctx.db.one<ConnectionRow>('connections', { user_id: userId, provider: GA4 });
  if (!row || !composioAccount(row)) throw new HttpError(409, 'Connect Google Analytics first.', 'not_connected');
  return row;
}

/** `POST /api/connect/ga4` → the first leg of the Composio flow (as stripe-app.ts). */
export function ga4Link(ctx: Hosted, user: AuthUser): { body: RedirectResponse; setCookie: string } {
  if (!composioFor(ctx.env, 'ga4')) throw notConfigured('Connecting Google Analytics');
  const { state, setCookie } = startState(ctx, user, GA4_STATE);
  const url = new URL(callbackUrl(ctx, GA4_CALLBACK, false));
  url.searchParams.set('state', state);
  url.searchParams.set('via', 'composio');
  return { body: { url: url.toString() }, setCookie };
}

/** Home again, clearing the flow's cookie: `/?connected=ga4` or `/?connect_error=ga4:…`. */
function ga4Home(ctx: Hosted, error?: string): Response {
  const secure = (ctx.s.appUrl ?? ctx.url.origin).startsWith('https:') ? '; Secure' : '';
  const q = error ? `connect_error=${encodeURIComponent(`ga4:${error}`)}` : 'connected=ga4';
  return new Response(null, {
    status: 302,
    headers: { Location: `/?${q}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Set-Cookie': `tt_oauth_ga4=; Path=/api/connect; HttpOnly; SameSite=Lax; Max-Age=0${secure}` },
  });
}

/** `GET /api/connect/ga4/callback`: out to Composio's link, then back with the account. The property is picked afterwards. */
export async function ga4Callback(ctx: Hosted): Promise<Response> {
  if (!ctx.s.secrets || !composioFor(ctx.env, 'ga4')) return ga4Home(ctx, "Connecting Google Analytics isn't set up on this server yet.");
  const state = finishState(ctx, GA4_STATE);
  if (!state) return ga4Home(ctx, 'state');
  const q = ctx.url.searchParams;
  const accountId = q.get('connected_account_id');
  if (q.get('via') === 'composio' && !accountId) {
    const back = new URL(callbackUrl(ctx, GA4_CALLBACK, false));
    back.searchParams.set('state', q.get('state')!);
    return awayTo((await connectLink(ctx, 'ga4', state.user, back.toString())).url);
  }
  if (q.get('status') !== 'success' || !accountId) return ga4Home(ctx, 'denied');
  if (!(await verifiedAccount(ctx, 'ga4', state.user, accountId))) return ga4Home(ctx, 'state');
  const stamp = new Date(ctx.now).toISOString();
  await ctx.db.upsert(
    'connections',
    {
      user_id: state.user,
      provider: GA4,
      account_id: `composio:${accountId}`,
      display_name: null,
      livemode: null,
      secret: null,
      metadata: { via: 'composio', composio: accountId },
      connected_at: stamp,
      updated_at: stamp,
    },
    'user_id,provider',
  );
  return ga4Home(ctx);
}

/** `GET /api/connect/ga4/properties`: the properties the founder can read, to pick one. */
export async function ga4PropertyList(ctx: Hosted, user: AuthUser): Promise<{ properties: { id: string; name: string; account: string }[] }> {
  const row = await ga4Row(ctx, user.id);
  return { properties: await ga4Properties(ctx, composioAccount(row)!) };
}
