import { DAY, type Snapshot } from '../src/data/types.ts';
import { simulate, type Action, type SimOptions } from '../src/game/economy.ts';
import { badRequest } from './http.ts';

/**
 * The server's half of the game: it replays the founder's real metrics with
 * their saved actions plus the new one, and keeps the action only if the
 * game itself allows it. Treasury is never stored; it is always the result
 * of this replay.
 */

/** Saved actions per world. Generous (a full city is a few hundred) but bounded. */
export const MAX_ACTIONS = 5_000;

const ID = /^[a-z0-9-]{1,64}$/;
const PLOT = /^[\w-]{1,64}:[0-3]$/;

/** A well-formed action, rebuilt field by field so nothing extra is ever stored. */
export function parseAction(raw: unknown): Action {
  if (!raw || typeof raw !== 'object') throw badRequest('Expected an action.');
  const a = raw as Record<string, unknown>;
  if (typeof a.t !== 'number' || !Number.isSafeInteger(a.t) || a.t % DAY !== 0) throw badRequest('An action needs a day (t).');
  if (a.kind === 'build') {
    if (typeof a.item !== 'string' || !ID.test(a.item)) throw badRequest('Unknown item.');
    if (a.plot !== undefined && (typeof a.plot !== 'string' || !PLOT.test(a.plot))) throw badRequest('Unknown plot.');
    return { t: a.t, kind: 'build', item: a.item, ...(a.plot !== undefined ? { plot: a.plot as string } : {}) };
  }
  if (a.kind === 'home') {
    if (typeof a.tier !== 'number' || !Number.isInteger(a.tier) || a.tier < 0 || a.tier > 32) throw badRequest('Unknown home tier.');
    if (typeof a.choice !== 'string' || !ID.test(a.choice)) throw badRequest('Unknown home option.');
    return { t: a.t, kind: 'home', tier: a.tier, choice: a.choice };
  }
  throw badRequest('Unknown kind of action.');
}

export type Verdict = { ok: true } | { ok: false; reason: string };

/**
 * Whether `action` may be added to `saved`. Accepted means all of:
 *
 * 1. It happens on a real day of the timeline, today or yesterday (a page
 *    left open across midnight still works), and not before the last saved
 *    action: history can't be rewritten.
 * 2. Replaying everything up to today with `simulate()` applies it: it isn't
 *    in `rejected` (money, unlocks, land and placement rules all apply).
 *    Because it's the latest action it runs last on its day, so it can't
 *    change how any earlier action played out; we check that anyway.
 */
export function checkAction(snapshots: Snapshot[], saved: Action[], action: Action, opts: SimOptions): Verdict {
  const last = snapshots.length - 1;
  if (last < 0) return { ok: false, reason: 'Your city has no history yet' };
  const today = snapshots[last]!.t;
  if (!snapshots.some((s) => s.t === action.t) || action.t > today || action.t < today - DAY) {
    return { ok: false, reason: 'That day has passed. Reload to see today' };
  }
  if (saved.some((a) => a.t > action.t)) return { ok: false, reason: 'That day has passed. Reload to see today' };
  if (saved.length >= MAX_ACTIONS) return { ok: false, reason: 'This city has reached its limit of saved changes' };

  const before = simulate(snapshots, saved, last, opts).rejected.length;
  const after = simulate(snapshots, [...saved, action], last, opts);
  const failed = after.rejected.find((r) => r.action === action);
  if (failed) return { ok: false, reason: failed.reason };
  if (after.rejected.length !== before) return { ok: false, reason: 'That would undo something you already built' };
  return { ok: true };
}
