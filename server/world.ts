import { isPaid, simOptionsFor, type ActionsResponse, type MeResponse, type WorldInfo } from '../src/api/contract.ts';
import type { Action } from '../src/game/economy.ts';
import { track } from './analytics.ts';
import { hasAccess } from './billing.ts';
import type { Hosted } from './context.ts';
import { checkAction, parseAction } from './game.ts';
import { HttpError, badRequest } from './http.ts';
import { userTimeline } from './hosted-timeline.ts';
import { offerFor } from './offer.ts';
import { userState } from './state.ts';
import { connectionsOf, planOf, worldInfo, type ProfileRow, type WorldRow } from './store.ts';
import type { AuthUser } from './supabase.ts';

/** `GET /api/me`: everything the shell needs to decide what to show. Creates the profile on first sight. */
export async function me(ctx: Hosted, user: AuthUser): Promise<MeResponse> {
  const { profile, subscription: sub, connections = [] } = await userState(ctx, user, ['connections']);
  if (ctx.userState?.created) await track(ctx, user.id, 'signed_up');
  const plan = planOf(sub);
  // Agree with requirePaid: a plan cancelled at period end shows as ended once that period is over, even if its last webhook was lost.
  if (sub && isPaid(plan.status) && !hasAccess(sub, ctx.now)) plan.status = 'canceled';
  const conn = connectionsOf(profile, connections);
  // The offer is only ever offered to founders without a plan; for everyone else, no Stripe call.
  const offer = isPaid(plan.status) ? null : await offerFor(ctx, profile, sub);
  return { user: { id: user.id, email: user.email }, plan, connections: conn, world: worldInfo(profile), setup: { complete: !!conn.stripe }, offer };
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
  // The profile was read with the plan (server/state.ts): a write that changes nothing isn't sent.
  const profile = (await userState(ctx, user)).profile;
  const current: Record<string, unknown> = { name: profile.name, last_seen: profile.last_seen };
  if (Object.keys(patch).every((k) => patch[k] === current[k])) return worldInfo(profile);
  const [updated] = await ctx.db.update<ProfileRow>('profiles', { user_id: user.id }, { ...patch, updated_at: new Date(ctx.now).toISOString() });
  // Gone between the read and the write: the account was deleted.
  if (!updated) throw new HttpError(401, 'Your session has expired. Sign in again.', 'unauthenticated');
  return worldInfo(updated);
}

/** `GET /api/world/actions`. A founder who hasn't built yet has no row, which reads as no actions (nothing is written). */
export async function getActions(ctx: Hosted, user: AuthUser): Promise<ActionsResponse> {
  return { actions: (await userState(ctx, user, ['world'])).world?.actions ?? [] };
}

/**
 * `POST /api/world/actions { action }`. Checked against the server's own
 * copy of the founder's metrics, then saved only onto the exact version it
 * was checked against: two purchases racing from two tabs can't both spend
 * the same money. On a clash we re-check against the new state.
 */
export async function postAction(ctx: Hosted, user: AuthUser, body: Record<string, unknown>): Promise<ActionsResponse> {
  const action: Action = parseAction(body.action);
  // Profile, world and cached timeline came with the plan check, in one read.
  const state = await userState(ctx, user, ['world', 'timeline']);
  const timeline = await userTimeline(ctx, state.profile, state);
  const opts = simOptionsFor(state.profile.joined_at);
  let row = state.world ?? null;
  for (let attempt = 0; attempt < 3; attempt++) {
    // After a clash, the row as the other tab left it.
    if (attempt > 0) row = await ctx.db.one<WorldRow>('worlds', { user_id: user.id });
    const before = row?.actions ?? [];
    const verdict = checkAction(timeline.snapshots, before, action, opts);
    if (!verdict.ok) throw new HttpError(409, verdict.reason, 'rejected');
    const actions = [...before, action];
    const stamp = new Date(ctx.now).toISOString();
    // A founder's first build makes their row; `ignore` means another tab made it first, which counts as a clash.
    const saved = row
      ? (await ctx.db.update<WorldRow>('worlds', { user_id: user.id, version: row.version }, { actions, version: row.version + 1, updated_at: stamp })).length > 0
      : !!(await ctx.db.upsert<WorldRow>('worlds', { user_id: user.id, actions, version: 1, updated_at: stamp }, 'user_id', 'ignore'));
    if (saved) {
      if (before.length === 0) await track(ctx, user.id, 'first_build', { kind: action.kind, ...(action.kind === 'build' ? { item: action.item } : { tier: action.tier }) });
      return { actions };
    }
  }
  throw new HttpError(409, 'Your city changed in another tab. Reload and try again.', 'rejected');
}
