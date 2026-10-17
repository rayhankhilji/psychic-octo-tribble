import type { Snapshot } from '../data/types.ts';
import { CATALOG, type Item } from './catalog.ts';
import { diffGame, type GameEvent, type GameState } from './economy.ts';

const DAY = 86_400_000;

/** A number at the last visit and now. */
export interface Change {
  from: number;
  to: number;
}

/**
 * "While you were away": what happened to the city since the founder last
 * looked. Every figure is a real number from the timeline or the economy.
 */
export interface AwaySummary {
  /** Whole days since the last visit. */
  days: number;
  /** Game money credited from real revenue, and upkeep paid out of it. */
  earned: number;
  upkeep: number;
  treasury: Change;
  mrr: Change;
  customers: Change;
  population: Change;
  satisfaction: Change;
  /** Land, regions, the house ladder, decay and recovery. */
  events: GameEvent[];
  /** Things that became buyable, cheapest first. */
  unlocked: Item[];
}

/**
 * Compares the city at the last visit (`before`, on snapshot `from`) with
 * the city now. Null if less than a day has passed: nothing to tell.
 */
export function awaySummary(before: GameState, now: GameState, from: Snapshot, to: Snapshot): AwaySummary | null {
  const days = Math.round((to.t - from.t) / DAY);
  if (days < 1) return null;
  return {
    days,
    earned: now.earned - before.earned,
    upkeep: now.upkeepPaid - before.upkeepPaid,
    treasury: { from: before.treasury, to: now.treasury },
    mrr: { from: from.mrr, to: to.mrr },
    customers: { from: from.customers, to: to.customers },
    population: { from: before.population, to: now.population },
    satisfaction: { from: before.satisfaction.score, to: now.satisfaction.score },
    events: diffGame(before, now),
    unlocked: CATALOG.filter((i) => i.unlock > before.peakMrr && i.unlock <= now.peakMrr).sort((a, b) => a.price - b.price),
  };
}

/** The index of the last snapshot on or before `t` (the day the founder last looked), or -1. */
export function snapshotIndexAt(snapshots: Snapshot[], t: number): number {
  let i = -1;
  for (let k = 0; k < snapshots.length && snapshots[k]!.t <= t; k++) i = k;
  return i;
}
