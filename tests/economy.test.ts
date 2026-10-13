import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../src/data/types.ts';
import { CATALOG, HOME_TIERS, ITEMS } from '../src/game/catalog.ts';
import {
  FREE_HOUSED,
  RATE,
  STARTING_GRANT,
  canBuy,
  decayOf,
  diffGame,
  freePlots,
  money,
  simulate,
  type Action,
} from '../src/game/economy.ts';
import { demoActions } from '../src/game/demo-script.ts';
import { demoTimeline } from '../src/data/demo.ts';

const DAY = 86_400_000;
const days = (n: number, f: (d: number) => Partial<Snapshot>): Snapshot[] =>
  Array.from({ length: n }, (_, d) => ({ t: d * DAY, customers: 0, mrr: 0, releases: 0, commits: 0, ...f(d) }));
const build = (d: number, item: string, plot?: string): Action => ({ t: d * DAY, kind: 'build', item, ...(plot ? { plot } : {}) });

describe('money', () => {
  it('pays $10,000 per real dollar, once a day', () => {
    const tl = days(31, () => ({ mrr: 300, customers: 3 }));
    const g = simulate(tl, [], 29);
    expect(g.incomePerDay).toBe((300 * RATE) / 30);
    expect(g.treasury).toBeCloseTo(STARTING_GRANT + 300 * RATE, 0);
  });

  it('only credits income from the back-pay window on', () => {
    const tl = days(200, () => ({ mrr: 100, customers: 2 }));
    const g = simulate(tl, [], 199, { incomeFrom: 110 * DAY });
    expect(g.treasury).toBeCloseTo(STARTING_GRANT + 90 * ((100 * RATE) / 30), 0);
  });

  it('formats big numbers', () => {
    expect(money(1_500_000)).toBe('$1.5M');
    expect(money(2_000_000_000)).toBe('$2B');
    expect(money(80_000)).toBe('$80k');
    expect(money(950)).toBe('$950');
  });
});

describe('building', () => {
  it('buys onto an open plot and charges for it', () => {
    const tl = days(5, () => ({}));
    const g = simulate(tl, [build(1, 'park', 'market:0')], 4);
    expect(g.plots.find((p) => p.id === 'market:0')?.item).toBe('park');
    expect(g.treasury).toBeLessThan(STARTING_GRANT - 50_000 + 1);
    expect(g.rejected).toEqual([]);
  });

  it('refuses locked, unaffordable or misplaced builds without half-applying them', () => {
    const tl = days(5, () => ({}));
    const g = simulate(
      tl,
      [build(1, 'office-tower', 'market:0'), build(1, 'park', 'techpark:0'), build(1, 'park', 'market:0'), build(2, 'garden', 'market:0')],
      4,
    );
    expect(g.rejected.map((r) => r.reason)).toEqual(['Unlocks at $1,000 MRR', 'Pick an open plot', 'That plot is taken']);
    expect(g.owned).toHaveLength(1);
  });

  it('opens the next block only once the current land is full and MRR allows', () => {
    const tl = days(10, (d) => ({ mrr: d >= 8 ? 150 : 0, customers: 1 }));
    const fill = ['market:0', 'market:1', 'market:2', 'market:3'].map((p, i) => build(1 + i, 'garden', p));
    expect(simulate(tl, fill.slice(0, 3), 9).openBlocks).toEqual(['market']);
    expect(simulate(tl, fill, 6).openBlocks).toEqual(['market', 'arcade']);
    const arcade = ['arcade:0', 'arcade:1', 'arcade:2', 'arcade:3'].map((p) => build(6, 'garden', p));
    // Tech Park needs $100 MRR: closed on day 7, open from day 8.
    expect(simulate(tl, [...fill, ...arcade], 7).openBlocks).toEqual(['market', 'arcade']);
    expect(simulate(tl, [...fill, ...arcade], 9).openBlocks).toContain('techpark');
  });

  it('puts whole-block items on an empty block only', () => {
    const tl = days(400, () => ({ mrr: 20_000, customers: 300 }));
    const ok = simulate(tl, [build(390, 'stadium', 'market:2')], 399);
    expect(ok.plots.filter((p) => p.block === 'market').every((p) => p.item === 'stadium')).toBe(true);
    const blocked = simulate(tl, [build(380, 'park', 'market:0'), build(390, 'stadium', 'market:2')], 399);
    expect(blocked.rejected[0]?.reason).toBe('Needs a whole empty block');
  });

  it('upgrades HQ one level at a time or more, never down', () => {
    const tl = days(100, () => ({ mrr: 2_000, customers: 40 }));
    const g = simulate(tl, [build(80, 'hq-campus'), build(90, 'hq-office')], 99);
    expect(g.hqLevel).toBe(2);
    expect(g.rejected).toHaveLength(1);
  });

  it('keeps the airport free and pier rides behind the pier opening', () => {
    const tl = days(300, () => ({ mrr: 2_000, customers: 40 }));
    const g = simulate(tl, [build(280, 'prop-plane'), build(281, 'ferris-wheel')], 299);
    expect(g.owned.map((o) => o.item)).toEqual(['prop-plane']);
    expect(g.rejected[0]?.reason).toBe('Unlocks at $3,000 MRR');
  });
});

describe('housing and decay', () => {
  it('houses $0.20 of MRR worth of users each, plus the first 100 free', () => {
    const tl = days(2, () => ({ mrr: 200, customers: 10, users: 1_500 }));
    const g = simulate(tl, [], 1);
    expect(g.housed).toBe(1_000);
    expect(g.unhoused).toBe(500);
    expect(g.housingNeed).toBe(300);
    expect(simulate(days(2, () => ({ users: 80 })), [], 1).unhoused).toBe(0);
  });

  it('falls back to paying customers when there is no user data', () => {
    const g = simulate(days(2, () => ({ mrr: 10, customers: 300 })), [], 1);
    expect(g.population).toBe(300);
  });

  it('runs the city down during a homelessness crisis, then recovers', () => {
    const tl = days(120, (d) => ({ mrr: d < 60 ? 100 : 5_000, customers: 5, users: 10_000 }));
    const crisis = simulate(tl, [], 59);
    expect(crisis.maintenance).toBeLessThan(60);
    expect(decayOf(crisis.maintenance)).toMatchObject({ signDark: true, bridgeRusting: true, trainStopped: true });
    const recovered = simulate(tl, [], 119);
    expect(recovered.unhoused).toBe(0);
    expect(recovered.maintenance).toBe(100);
  });

  it('decays when upkeep outruns income and the treasury is empty', () => {
    // Spend almost everything, then revenue disappears: savings cover upkeep for a while, then decay.
    const tl = days(400, (d) => ({ mrr: d < 34 ? 1_000 : 0, customers: 1 }));
    const spend = [build(33, 'library', 'market:0'), build(33, 'coworking', 'market:1'), build(33, 'cafe', 'market:2'), build(33, 'courts', 'market:3')];
    expect(simulate(tl, spend, 100).maintenance).toBe(100);
    const g = simulate(tl, spend, 399);
    expect(g.rejected).toEqual([]);
    expect(g.treasury).toBe(0);
    expect(g.maintenance).toBeLessThan(10);
  });

  it('reports what changed between two days', () => {
    const tl = days(120, (d) => ({ mrr: d < 60 ? 100 : 5_000, customers: 5, users: d === 0 ? 50 : 10_000 }));
    const types = diffGame(simulate(tl, [], 0), simulate(tl, [], 59)).map((e) => e.type);
    expect(types).toContain('sign.dark');
    expect(types).toContain('homeless.appeared');
    expect(diffGame(simulate(tl, [], 59), simulate(tl, [], 119)).map((e) => e.type)).toContain('sign.lit');
  });
});

describe('satisfaction', () => {
  it('rewards housing, upkeep, amenities and growth, and nothing else', () => {
    const tl = days(60, (d) => ({ mrr: 100 + d * 10, customers: 10, users: 200 }));
    const bare = simulate(tl, [], 59);
    const parks = simulate(tl, [build(10, 'park', 'market:0'), build(11, 'park', 'market:1')], 59);
    expect(parks.satisfaction.score).toBeGreaterThan(bare.satisfaction.score);
    expect(bare.satisfaction.momentum).toBe(1);
    expect(parks.satisfaction.score).toBeLessThanOrEqual(100);
  });
});

describe('the founder home ladder', () => {
  it('moves you up a home with every extra digit of peak MRR, and keeps it after a dip', () => {
    const at = (mrr: number) => simulate(days(2, () => ({ mrr, customers: 1 })), [], 1).home;
    expect(at(0).option).toBe('hacker-house');
    expect(at(10).option).toBe('studio');
    expect(at(100).option).toBe('bungalow');
    expect(at(1_000).option).toBe('hills-modern');
    expect(at(10_000).option).toBe('villa');
    expect(at(100_000).option).toBe('island-estate');
    expect(at(1_000_000).option).toBe('moon-house');
    const dip = simulate(days(3, (d) => ({ mrr: d === 0 ? 1_000 : 50, customers: 1 })), [], 2);
    expect(dip.home.option).toBe('hills-modern');
  });

  it('makes the first pick free and charges 25% to swap later', () => {
    const tl = days(40, () => ({ mrr: 150, customers: 3 }));
    const first = simulate(tl, [{ t: 5 * DAY, kind: 'home', tier: 2, choice: 'loft' }], 39);
    const free = simulate(tl, [], 39);
    expect(first.home.option).toBe('loft');
    expect(first.treasury).toBeCloseTo(free.treasury, 0);
    const swapped = simulate(tl, [{ t: 5 * DAY, kind: 'home', tier: 2, choice: 'loft' }, { t: 30 * DAY, kind: 'home', tier: 2, choice: 'bungalow' }], 39);
    expect(free.treasury - swapped.treasury).toBeCloseTo(HOME_TIERS[2]!.value * 0.25, 0);
  });

  it('lets you rebuild your Hills house and your island estate, for a renovation fee', () => {
    for (const [tier, mrr, a, b] of [[3, 1_500, 'hills-spanish', 'hills-canyon'], [5, 150_000, 'island-modern', 'island-tropical']] as const) {
      const tl = days(40, () => ({ mrr, customers: 3 }));
      const pick = { t: 5 * DAY, kind: 'home' as const, tier, choice: a };
      const once = simulate(tl, [pick], 39);
      const twice = simulate(tl, [pick, { t: 30 * DAY, kind: 'home', tier, choice: b }], 39);
      expect(HOME_TIERS[tier]!.options.length).toBe(3);
      expect(twice.home.option).toBe(b);
      expect(twice.rejected).toEqual([]);
      expect(once.treasury - twice.treasury).toBeCloseTo(HOME_TIERS[tier]!.value * 0.25, 0);
    }
  });
});

describe('catalogue', () => {
  it('has unique ids, sensible prices and something to buy at every tier', () => {
    expect(new Set(CATALOG.map((i) => i.id)).size).toBe(CATALOG.length);
    for (const tier of [0, 100, 1_000, 10_000, 100_000, 1_000_000]) {
      expect(CATALOG.some((i) => i.unlock === tier)).toBe(true);
    }
    // Every item at a tier costs at most ~2 years of that tier's income.
    for (const i of CATALOG) if (i.unlock > 0) expect(i.price).toBeLessThanOrEqual(i.unlock * RATE * 24);
  });

  it('explains why something cannot be bought yet', () => {
    const g = simulate(days(2, () => ({})), [], 1);
    expect(canBuy(g, ITEMS.get('park')!)).toBeNull();
    expect(canBuy(g, ITEMS.get('skyscraper')!)).toBe('Unlocks at $10,000 MRR');
    expect(canBuy(g, ITEMS.get('prop-plane')!)).toBe('Unlocks at $1,000 MRR');
    expect(freePlots(g, 1)).toHaveLength(4);
  });

  it('runs the scripted demo founder without a single rejected action', () => {
    const t = demoTimeline({ end: Date.UTC(2026, 9, 11) });
    const g = simulate(t.snapshots, demoActions(t.snapshots), t.snapshots.length - 1);
    expect(g.rejected).toEqual([]);
    expect(g.owned.length).toBeGreaterThan(15);
    expect(FREE_HOUSED).toBe(100);
  });

  it('ends the boosted demo with a rocket on the launch pad', () => {
    const t = demoTimeline({ boost: 40 });
    const g = simulate(t.snapshots, demoActions(t.snapshots), t.snapshots.length - 1);
    expect(g.rejected).toEqual([]);
    expect(g.regions.launchpad).toBe(true);
    expect(g.owned.some((o) => o.item === 'rocket' && o.site === 'launchpad')).toBe(true);
  });
});
