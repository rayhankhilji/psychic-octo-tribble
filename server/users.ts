import type { Connections } from '../src/api/contract.ts';
import { startOfDay, type Snapshot } from '../src/data/types.ts';
import type { Hosted } from './context.ts';
import { decrypt, encrypt } from './crypto.ts';
import { badRequest, notConfigured } from './http.ts';
import { PERSONAL_KEY, PROJECT_ID, monthlyActiveUsers, posthogOrigin } from './posthog.ts';
import { connectionsOf, ensureProfile, type ConnectionRow, type ProfileRow } from './store.ts';
import type { AuthUser } from './supabase.ts';

/**
 * Where the city's population comes from: paying customers (the default),
 * a number the founder types in, or PostHog's monthly active users.
 */

const MAX_MANUAL = 1_000_000_000;
/** Manual entries kept, one per day at most. */
const MANUAL_HISTORY = 400;

/** `PUT /api/connect/users` */
export async function setUsersSource(ctx: Hosted, user: AuthUser, body: Record<string, unknown>): Promise<Connections> {
  const profile = await ensureProfile(ctx.db, user.id);
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
      await monthlyActiveUsers(origin, projectId, apiKey);
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
    const key = decrypt(ph.secret, ctx.s.secrets.encryptionKey, `${profile.user_id}:posthog`);
    // Re-checked against today's allow-list, in case POSTHOG_HOSTS has changed since.
    const mau = await monthlyActiveUsers(posthogOrigin(String(ph.metadata.host), ctx.s.posthog.hosts), ph.account_id, key);
    return snapshots.map((s) => (mau.has(s.t) ? { ...s, users: mau.get(s.t)! } : s));
  }
  return snapshots;
}
