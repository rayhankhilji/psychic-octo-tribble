import { randomInt } from 'node:crypto';
import type { Connections, PlanInterval, PlanStatus, UsersSource, WorldInfo } from '../src/api/contract.ts';
import type { Action } from '../src/game/economy.ts';
import type { Timeline } from '../src/data/types.ts';
import { HttpError } from './http.ts';
import type { Db } from './supabase.ts';

/** Rows as they live in Postgres (see supabase/migrations). */
export interface ProfileRow {
  user_id: string;
  seed: number;
  name: string;
  joined_at: number | null;
  last_seen: number | null;
  users_source: 'customers' | 'manual' | 'posthog' | 'ga4';
  users_manual: { t: number; value: number }[];
  created_at: string;
}

export interface SubscriptionRow {
  user_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  status: string;
  price_id: string | null;
  plan_interval: PlanInterval | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  livemode: boolean | null;
  /** A plan the owner gave away from the admin console (no Stripe subscription). */
  comp?: boolean;
}

export type Provider = 'stripe' | 'github' | 'posthog' | 'ga4';

export interface ConnectionRow {
  user_id: string;
  provider: Provider;
  account_id: string;
  display_name: string | null;
  livemode: boolean | null;
  secret: string | null;
  access_token: string | null;
  access_expires_at: string | null;
  token_version: number;
  metadata: Record<string, unknown>;
  connected_at: string;
}

export interface WorldRow {
  user_id: string;
  actions: Action[];
  version: number;
}

export interface TimelineRow {
  user_id: string;
  timeline: Timeline;
  fetched_at: string;
}

const ms = (iso: string | null) => (iso ? Date.parse(iso) : null);

/**
 * The founder's profile, created on first sight with a random world seed.
 * `onCreate` runs only for the request whose insert actually made the row.
 */
export async function ensureProfile(db: Db, userId: string, onCreate?: () => Promise<void>): Promise<ProfileRow> {
  const existing = await db.one<ProfileRow>('profiles', { user_id: userId });
  if (existing) return existing;
  // `ignore` keeps whichever row won if two first requests race; the loser gets nothing back.
  const inserted = await db.upsert('profiles', { user_id: userId, seed: randomInt(1, 2 ** 31) }, 'user_id', 'ignore');
  if (inserted && onCreate) await onCreate();
  const created = await db.one<ProfileRow>('profiles', { user_id: userId });
  // 0006 drops inserts for users who no longer exist: a deleted account whose sign-in is still cached.
  if (!created) throw new HttpError(401, 'Your session has expired. Sign in again.', 'unauthenticated');
  return created;
}

export function worldInfo(p: ProfileRow): WorldInfo {
  return { seed: p.seed, name: p.name, joinedAt: p.joined_at, lastSeen: p.last_seen };
}

/**
 * Stripe's subscription statuses folded into the contract's. `unpaid` and
 * `incomplete_expired` mean no access; `paused` (a trial that ended without
 * a card) needs the founder to finish paying.
 */
export function planStatus(stripeStatus: string | undefined): PlanStatus {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
    case 'past_due':
    case 'canceled':
    case 'incomplete':
      return stripeStatus;
    case 'unpaid':
    case 'incomplete_expired':
      return 'canceled';
    case 'paused':
      return 'incomplete';
    default:
      return 'none';
  }
}

export function planOf(sub: SubscriptionRow | null) {
  return {
    status: planStatus(sub?.status),
    interval: sub?.plan_interval ?? null,
    renewsAt: ms(sub?.current_period_end ?? null),
    cancelAtPeriodEnd: sub?.cancel_at_period_end ?? false,
  };
}

export function usersSourceOf(p: ProfileRow, posthog: ConnectionRow | undefined, ga4?: ConnectionRow): UsersSource {
  if (p.users_source === 'manual' && p.users_manual.length) {
    const last = p.users_manual.at(-1)!;
    return { source: 'manual', value: last.value, updatedAt: last.t };
  }
  if (p.users_source === 'posthog' && posthog) {
    return { source: 'posthog', host: String(posthog.metadata.host ?? ''), projectId: posthog.account_id, connectedAt: ms(posthog.connected_at)! };
  }
  if (p.users_source === 'ga4' && ga4 && typeof ga4.metadata.property === 'string') {
    const name = ga4.metadata.propertyName;
    return { source: 'ga4', property: ga4.metadata.property, propertyName: typeof name === 'string' ? name : null, connectedAt: ms(ga4.connected_at)! };
  }
  return { source: 'customers' };
}

export function connectionsOf(p: ProfileRow, rows: ConnectionRow[]): Connections {
  const by = (provider: Provider) => rows.find((r) => r.provider === provider);
  const stripe = by('stripe');
  const github = by('github');
  return {
    stripe: stripe ? { account: stripe.account_id, name: stripe.display_name, livemode: !!stripe.livemode, connectedAt: ms(stripe.connected_at)! } : null,
    github: github
      ? { installationId: /^\d+$/.test(github.account_id) ? Number(github.account_id) : 0, repo: typeof github.metadata.repo === 'string' ? github.metadata.repo : null, connectedAt: ms(github.connected_at)! }
      : null,
    users: usersSourceOf(p, by('posthog'), by('ga4')),
  };
}
