import type { Snapshot } from '../data/types.ts';
import type { Action } from './economy.ts';
import { ITEMS } from './catalog.ts';

/**
 * What the fictional Nightjar founder built over 18 months, so the demo
 * replay shows a city being built. Your own actions are saved on top.
 */
const SCRIPT: [day: number, item: string, plot?: string][] = [
  [3, 'park', 'market:0'],
  [6, 'food-trucks', 'market:1'],
  [10, 'garden', 'market:2'],
  [16, 'corner-shops', 'market:3'],
  [45, 'park', 'arcade:0'],
  [100, 'cafe', 'arcade:1'],
  [112, 'courts', 'arcade:2'],
  [126, 'hq-office'],
  [150, 'coworking', 'arcade:3'],
  [215, 'theatre', 'techpark:0'],
  [240, 'library', 'techpark:1'],
  [262, 'hq-campus'],
  [285, 'prop-plane'],
  [300, 'office-tower', 'techpark:2'],
  [330, 'ferris-wheel'],
  [375, 'tech-campus', 'techpark:3'],
  [410, 'office-tower', 'midtown:0'],
  [440, 'coaster'],
  [470, 'office-tower', 'midtown:1'],
  [495, 'day-yacht'],
  [515, 'skyscraper', 'midtown:2'],
  [530, 'hq-tower'],
  // Only affordable in a boosted demo (?demo&boost=40): the rest are skipped.
  [520, 'gulfstream'],
  [533, 'long-range'],
  [536, 'rocket'],
];

export function demoActions(snapshots: Snapshot[]): Action[] {
  // Big-ticket items only appear when the (boosted) numbers have unlocked them.
  const peak = (d: number) => Math.max(...snapshots.slice(0, d + 1).map((s) => s.mrr));
  return SCRIPT.filter(([d, item]) => snapshots[d] && (ITEMS.get(item)?.unlock ?? 0) <= peak(d)).map(([d, item, plot]) => ({
    t: snapshots[d]!.t,
    kind: 'build' as const,
    item,
    ...(plot ? { plot } : {}),
  }));
}
