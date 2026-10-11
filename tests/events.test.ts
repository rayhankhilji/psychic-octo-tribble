import { describe, expect, it } from 'vitest';
import type { Snapshot, Timeline } from '../src/data/types.ts';
import { describe as describeEvent, diffMoments } from '../src/world/events.ts';
import { momentsOf } from '../src/world/history.ts';

const DAY = 86_400_000;
const timeline = (rows: Partial<Snapshot>[]): Timeline => ({
  name: 'Test',
  currency: 'usd',
  source: 'demo',
  integrations: { stripe: true, github: true },
  snapshots: rows.map((r, i) => ({ t: i * DAY, customers: 0, mrr: 0, releases: 0, commits: 0, ...r })),
});

describe('diffMoments', () => {
  it('reports joins, releases, pushes and district unlocks', () => {
    const m = momentsOf(timeline([
      { customers: 0, mrr: 0 },
      { customers: 3, mrr: 1_200, releases: 1, release: 'v1.0', commits: 4 },
    ]));
    const types = diffMoments(m[0]!, m[1]!).map((e) => e.type);
    expect(types).toEqual(['district.unlocked', 'district.unlocked', 'release.shipped', 'customers.joined', 'code.pushed']);
  });

  it('dims a district when MRR falls below its milestone, and relights it', () => {
    const m = momentsOf(timeline([{ mrr: 1_100 }, { mrr: 900 }, { mrr: 1_050 }]));
    expect(diffMoments(m[0]!, m[1]!)).toContainEqual({ type: 'district.dimmed', id: 'arcade', name: '$1k MRR' });
    expect(diffMoments(m[1]!, m[2]!)).toContainEqual({ type: 'district.relit', id: 'arcade', name: '$1k MRR' });
  });

  it('quotes the real number behind each visual', () => {
    expect(describeEvent({ type: 'customers.joined', count: 1, total: 1 }, 'usd')).toBe('Your first paying customer!');
    expect(describeEvent({ type: 'customers.joined', count: 2, total: 14 }, 'usd')).toBe('2 new customers · 14 total');
    expect(describeEvent({ type: 'district.unlocked', id: 'arcade', name: 'Neon Arcade', threshold: 1000 }, 'usd')).toBe('MRR passed $1,000');
    expect(describeEvent({ type: 'code.pushed', commits: 3 }, 'usd')).toBeUndefined();
  });
});

describe('weather', () => {
  it('rains after a >1% weekly MRR drop and clears once the week is flat or up', () => {
    const mrr = [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 980, 985, 990, 995, 1000, 1000, 1000, 1001];
    const weather = momentsOf(timeline(mrr.map((v) => ({ mrr: v })))).map((m) => m.weather);
    expect(weather.slice(0, 8).every((w) => w === 'clear')).toBe(true);
    expect(weather[8]).toBe('rain');
    // 985 vs 1000 a week earlier is still down: keeps raining rather than flickering.
    expect(weather.slice(9, 12).every((w) => w === 'rain')).toBe(true);
    expect(weather.at(-1)).toBe('clear');
  });
});
