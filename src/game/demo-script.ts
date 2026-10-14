import type { Snapshot } from '../data/types.ts';
import type { Action } from './economy.ts';
import { ITEMS } from './catalog.ts';

/**
 * What the fictional Nightjar founder built over 18 months, so the demo
 * replay shows a city being built. Your own actions are saved on top.
 * Every entry is affordable in the plain demo, which climbs the whole ladder:
 * the island on day 307 ($5k MRR) and the moon on day 404 ($10k MRR), with
 * the rocket on the pad a week later.
 */
const SCRIPT: [day: number, item: string, plot?: string][] = [
  [3, 'park', 'market:0'],
  [6, 'food-trucks', 'market:1'],
  [10, 'garden', 'market:2'],
  [16, 'corner-shops', 'market:3'],
  [45, 'park', 'arcade:0'],
  [60, 'cafe', 'arcade:1'],
  [70, 'courts', 'arcade:2'],
  [80, 'hq-office'],
  [92, 'coworking', 'arcade:3'],
  [100, 'prop-plane'],
  [115, 'theatre', 'techpark:0'],
  [140, 'ferris-wheel'],
  [158, 'library', 'techpark:1'],
  [180, 'hq-campus'],
  [200, 'office-tower', 'techpark:2'],
  [212, 'coaster'],
  [230, 'tech-campus', 'techpark:3'],
  [240, 'day-yacht'],
  [255, 'office-tower', 'midtown:0'],
  [275, 'hq-tower'],
  [295, 'gulfstream'],
  [320, 'skyscraper', 'midtown:1'],
  [350, 'pyramid', 'midtown:2'],
  [385, 'venture-studio', 'midtown:3'],
  [411, 'rocket'],
  [425, 'long-range'],
  [450, 'university', 'skyline:0'],
  [490, 'hq-landmark'],
  [520, 'supersonic'],
];

export function demoActions(snapshots: Snapshot[]): Action[] {
  // Shorter or reseeded timelines may not reach every gate: skip what isn't unlocked yet.
  const peak = (d: number) => Math.max(...snapshots.slice(0, d + 1).map((s) => s.mrr));
  return SCRIPT.filter(([d, item]) => snapshots[d] && (ITEMS.get(item)?.unlock ?? 0) <= peak(d)).map(([d, item, plot]) => ({
    t: snapshots[d]!.t,
    kind: 'build' as const,
    item,
    ...(plot ? { plot } : {}),
  }));
}
