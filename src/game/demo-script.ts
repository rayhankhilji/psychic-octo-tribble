import type { Snapshot } from '../data/types.ts';
import type { Action } from './economy.ts';

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
];

export function demoActions(snapshots: Snapshot[]): Action[] {
  return SCRIPT.filter(([d]) => snapshots[d]).map(([d, item, plot]) => ({ t: snapshots[d]!.t, kind: 'build' as const, item, ...(plot ? { plot } : {}) }));
}
