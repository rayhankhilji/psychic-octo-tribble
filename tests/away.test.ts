import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../src/data/types.ts';
import { awaySummary, snapshotIndexAt } from '../src/game/away.ts';
import { RATE, simulate } from '../src/game/economy.ts';

const DAY = 86_400_000;
const days = (n: number, f: (d: number) => Partial<Snapshot>): Snapshot[] =>
  Array.from({ length: n }, (_, d) => ({ t: d * DAY, customers: 0, mrr: 0, releases: 0, commits: 0, ...f(d) }));

describe('while you were away', () => {
  it('says nothing on the same day', () => {
    const tl = days(10, () => ({ mrr: 100, customers: 5 }));
    const g = simulate(tl, [], 5);
    expect(awaySummary(g, g, tl[5]!, tl[5]!)).toBeNull();
  });

  it('counts the days, the income and the real numbers since the last visit', () => {
    const tl = days(40, (d) => ({ mrr: d < 20 ? 300 : 1_200, customers: d < 20 ? 3 : 12 }));
    const before = simulate(tl, [], 10);
    const now = simulate(tl, [], 39);
    const s = awaySummary(before, now, tl[10]!, tl[39]!)!;
    expect(s.days).toBe(29);
    // Income is credited daily: 9 days at $300 MRR and 20 at $1,200, each a 30th of a month.
    expect(s.earned).toBeCloseTo(((9 * 300 + 20 * 1_200) * RATE) / 30, 0);
    expect(s.mrr).toEqual({ from: 300, to: 1_200 });
    expect(s.customers).toEqual({ from: 3, to: 12 });
    expect(s.treasury.to).toBeCloseTo(s.treasury.from + s.earned - s.upkeep, 0);
  });

  it('lists what unlocked and the land that opened', () => {
    const tl = days(40, (d) => ({ mrr: d < 20 ? 50 : 1_500, customers: d < 20 ? 1 : 15 }));
    const s = awaySummary(simulate(tl, [], 10), simulate(tl, [], 39), tl[10]!, tl[39]!)!;
    const ids = s.unlocked.map((i) => i.id);
    expect(ids).toContain('cafe');
    expect(ids).toContain('prop-plane');
    expect(ids).not.toContain('park');
    expect(s.unlocked.map((i) => i.price)).toEqual([...s.unlocked.map((i) => i.price)].sort((a, b) => a - b));
    expect(s.events.some((e) => e.type === 'region.opened' && e.region === 'hills')).toBe(true);
    expect(s.events.some((e) => e.type === 'home.moved')).toBe(true);
  });

  it('finds the last visit in the timeline', () => {
    const tl = days(5, () => ({}));
    expect(snapshotIndexAt(tl, 2 * DAY + 5)).toBe(2);
    expect(snapshotIndexAt(tl, -1)).toBe(-1);
    expect(snapshotIndexAt(tl, 99 * DAY)).toBe(4);
  });
});
