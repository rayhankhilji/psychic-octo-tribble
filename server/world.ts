import { isPaid, simOptionsFor, type ActionsResponse, type MeResponse, type WorldInfo } from '../src/api/contract.ts';
import type { Action } from '../src/game/economy.ts';
import { track } from './analytics.ts';
import { hasAccess } from './billing.ts';
import type { Hosted } from './context.ts';
import { checkAction, parseAction } from './game.ts';
import { HttpError, badRequest } from './http.ts';
import { userTimeline } from './hosted-timeline.ts';
import { connectionsOf, ensureProfile, planOf, worldInfo, type ConnectionRow, type SubscriptionRow, type WorldRow } from './store.ts';
import type { AuthUser } from './supabase.ts';

/** `GET /api/me`: everything the shell needs to decide what to show. Creates the profile on first sight. */
export async function me(ctx: Hosted, user: AuthUser): Promise<MeResponse> {
  const [profile, sub, rows] = await Promise.all([
    ensureProfile(ctx.db, user.id, () => track(ctx, user.id, 'signed_up')),
    ctx.db.one<SubscriptionRow>('subscriptions', { user_id: user.id }),
    ctx.db.many<ConnectionRow>('connections', { user_id: user.id }),
  ]);
  const plan = planOf(sub);
  // Agree with requirePaid: a plan cancelled at period end shows as ended once that period is over, even if its last webhook was lost.
  if (sub && isPaid(plan.status) && !hasAccess(sub, ctx.now)) plan.status = 'canceled';
  return { user: { id: user.id, email: user.email }, plan, connections: connectionsOf(profile, rows), world: worldInfo(profile) };
}

// Control characters and the bidi overrides people use to spoof text.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** `PATCH /api/world { name?, lastSeen? }` */
export async function patchWorld(ctx: Hosted, user: AuthUser, body: Record<string, unknown>): Promise<WorldInfo> {
  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.replace(UNSAFE, '').replace(/\s+/g, ' ').trim() : '';
    if (name.length < 1 || name.length > 40) throw badRequest('Names are 1 to 40 characters.');
    patch.name = name;
  }
  if (body.lastSeen !== undefined) {
    const t = body.lastSeen;
    if (typeof t !== 'number' || !Number.isSafeInteger(t) || t <= 0 || t > ctx.now + 86_400_000) throw badRequest('lastSeen should be a day in the past.');
    patch.last_seen = t;
  }
  const profile = await ensureProfile(ctx.db, user.id);
  if (Object.keys(patch).length === 0) return worldInfo(profile);
  const [updated] = await ctx.db.update<typeof profile>('profiles', { user_id: user.id }, { ...patch, updated_at: new Date(ctx.now).toISOString() });
  return worldInfo(updated ?? profile);
}

async function worldRow(ctx: Hosted, userId: string): Promise<WorldRow> {
  const row = await ctx.db.one<WorldRow>('worlds', { user_id: userId });
  if (row) return row;
  await ctx.db.upsert('worlds', { user_id: userId, actions: [], version: 0 }, 'user_id', 'ignore');
  return (await ctx.db.one<WorldRow>('worlds', { user_id: userId })) ?? { user_id: userId, actions: [], version: 0 };
}

export async function getActions(ctx: Hosted, user: AuthUser): Promise<ActionsResponse> {
  return { actions: (await worldRow(ctx, user.id)).actions };
}

/**
 * `POST /api/world/actions { action }`. Checked against the server's own
 * copy of the founder's metrics, then saved only onto the exact version it
 * was checked against: two purchases racing from two tabs can't both spend
 * the same money. On a clash we re-check against the new state.
 */
export async function postAction(ctx: Hosted, user: AuthUser, body: Record<string, unknown>): Promise<ActionsResponse> {
  const action: Action = parseAction(body.action);
  const profile = await ensureProfile(ctx.db, user.id);
  const timeline = await userTimeline(ctx, profile);
  const opts = simOptionsFor(profile.joined_at);
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await worldRow(ctx, user.id);
    const verdict = checkAction(timeline.snapshots, row.actions, action, opts);
    if (!verdict.ok) throw new HttpError(409, verdict.reason, 'rejected');
    const actions = [...row.actions, action];
    const saved = await ctx.db.update<WorldRow>('worlds', { user_id: user.id, version: row.version }, { actions, version: row.version + 1, updated_at: new Date(ctx.now).toISOString() });
    if (saved.length) {
      if (row.actions.length === 0) await track(ctx, user.id, 'first_build', { kind: action.kind, ...(action.kind === 'build' ? { item: action.item } : { tier: action.tier }) });
      return { actions };
    }
  }
  throw new HttpError(409, 'Your city changed in another tab. Reload and try again.', 'rejected');
}
