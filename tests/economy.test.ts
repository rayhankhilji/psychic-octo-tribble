import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../src/data/types.ts';
import { CATALOG, EASE_ANCHORS, HOME_TIERS, ITEMS, REGIONS, easeMrr } from '../src/game/catalog.ts';
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
    expect(g.treasury).toBeLessThan(STARTING_GRANT - ITEMS.get('park')!.price + 1);
    expect(g.rejected).toEqual([]);
  });

  it('refuses locked, unaffordable or misplaced builds without half-applying them', () => {
    const tl = days(5, () => ({}));
    const g = simulate(
      tl,
      [build(1, 'office-tower', 'market:0'), build(1, 'park', 'techpark:0'), build(1, 'park', 'market:0'), build(2, 'garden', 'market:0')],
      4,
    );
    expect(g.rejected.map((r) => r.reason)).toEqual(['Unlocks at $250 MRR', 'Pick an open plot', 'That plot is taken']);
    expect(g.owned).toHaveLength(1);
  });

  it('opens the next block only once the current land is full and MRR allows', () => {
    const tl = days(10, (d) => ({ mrr: d >= 8 ? 60 : 0, customers: 1 }));
    const fill = ['market:0', 'market:1', 'market:2', 'market:3'].map((p, i) => build(1 + i, 'garden', p));
    expect(simulate(tl, fill.slice(0, 3), 9).openBlocks).toEqual(['market']);
    expect(simulate(tl, fill, 6).openBlocks).toEqual(['market', 'arcade']);
    const arcade = ['arcade:0', 'arcade:1', 'arcade:2', 'arcade:3'].map((p) => build(6, 'garden', p));
    // SoMa (techpark) needs $50 MRR: closed on day 7, open from day 8.
    expect(simulate(tl, [...fill, ...arcade], 7).openBlocks).toEqual(['market', 'arcade']);
    expect(simulate(tl, [...fill, ...arcade], 9).openBlocks).toContain('techpark');
  });

  it('puts whole-block items on an empty block only', () => {
    const tl = days(400, () => ({ mrr: 2_000, customers: 300 }));
    const ok = simulate(tl, [build(390, 'stadium', 'market:2')], 399);
    expect(ok.plots.filter((p) => p.block === 'market').every((p) => p.item === 'stadium')).toBe(true);
    const blocked = simulate(tl, [build(380, 'park', 'market:0'), build(390, 'stadium', 'market:2')], 399);
    expect(blocked.rejected[0]?.reason).toBe('Needs a whole empty block');
  });

  it('upgrades HQ one level at a time or more, never down', () => {
    const tl = days(100, () => ({ mrr: 300, customers: 4 }));
    const g = simulate(tl, [build(80, 'hq-campus'), build(90, 'hq-office')], 99);
    expect(g.hqLevel).toBe(2);
    expect(g.rejected).toHaveLength(1);
  });

  it('keeps the airport free and pier rides behind the pier opening', () => {
    const tl = days(300, () => ({ mrr: 300, customers: 4 }));
    const g = simulate(tl, [build(280, 'prop-plane'), build(281, 'ferris-wheel')], 299);
    expect(g.owned.map((o) => o.item)).toEqual(['prop-plane']);
    expect(g.rejected[0]?.reason).toBe('Unlocks at $500 MRR');
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
    const tl = days(400, (d) => ({ mrr: d < 34 ? 250 : 0, customers: 1 }));
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
  it('moves you up a home at each peak-MRR milestone, and keeps it after a dip', () => {
    const at = (mrr: number) => simulate(days(2, () => ({ mrr, customers: 1 })), [], 1).home;
    expect(at(0).option).toBe('hacker-house');
    expect(at(10).option).toBe('studio');
    expect(at(50).option).toBe('bungalow');
    expect(at(250).option).toBe('hills-modern');
    expect(at(1_000).option).toBe('villa');
    expect(at(4_999).option).toBe('villa');
    expect(at(5_000).option).toBe('island-estate');
    expect(at(9_999).option).toBe('island-estate');
    expect(at(10_000).option).toBe('moon-house');
    const dip = simulate(days(3, (d) => ({ mrr: d === 0 ? 250 : 5, customers: 1 })), [], 2);
    expect(dip.home.option).toBe('hills-modern');
  });

  it('makes the first pick free and charges 25% to swap later', () => {
    const tl = days(40, () => ({ mrr: 60, customers: 3 }));
    const first = simulate(tl, [{ t: 5 * DAY, kind: 'home', tier: 2, choice: 'loft' }], 39);
    const free = simulate(tl, [], 39);
    expect(first.home.option).toBe('loft');
    expect(first.treasury).toBeCloseTo(free.treasury, 0);
    const swapped = simulate(tl, [{ t: 5 * DAY, kind: 'home', tier: 2, choice: 'loft' }, { t: 30 * DAY, kind: 'home', tier: 2, choice: 'bungalow' }], 39);
    expect(free.treasury - swapped.treasury).toBeCloseTo(HOME_TIERS[2]!.value * 0.25, 0);
  });

  it('lets you rebuild your Hills house and your island estate, for a renovation fee', () => {
    for (const [tier, mrr, a, b] of [[3, 300, 'hills-spanish', 'hills-canyon'], [5, 7_500, 'island-modern', 'island-tropical']] as const) {
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
  it('opens each region with the rung of the ladder that lives there', () => {
    const moon = HOME_TIERS.find((h) => h.where === 'moon')!;
    expect(moon.mrr).toBe(10_000);
    expect(HOME_TIERS.find((h) => h.where === 'island')!.mrr).toBe(5_000);
    expect(REGIONS.launchpad.gate).toBe(moon.mrr);
    expect(REGIONS.island.gate).toBe(HOME_TIERS.find((h) => h.where === 'island')!.mrr);
    expect(REGIONS.hills.gate).toBe(HOME_TIERS.find((h) => h.where === 'hills')!.mrr);
    expect(ITEMS.get('rocket')!.unlock).toBe(moon.mrr);
    // Rungs climb, and so do their values (the renovation fee is a quarter of it).
    for (let i = 1; i < HOME_TIERS.length; i++) expect(HOME_TIERS[i]!.mrr).toBeGreaterThan(HOME_TIERS[i - 1]!.mrr);
  });

  it('eases every old gate along the owner’s curve, one rung per old digit', () => {
    for (const [old, now] of EASE_ANCHORS) expect(easeMrr(old)).toBeCloseTo(now, 6);
    // The house ladder is the curve itself: studio $10, then one rung per old digit.
    HOME_TIERS.slice(1).forEach((h, i) => expect(h.mrr).toBe(easeMrr(10 ** (i + 1))));
    // In between, it's log-linear: the old $3k pier gate lands near $484 (shown as $500).
    expect(easeMrr(3_000)).toBeCloseTo(484, 0);
    expect(REGIONS.pier.gate).toBe(500);
    for (let k = 1; k < 1e6; k *= 3) expect(easeMrr(k * 3)).toBeGreaterThan(easeMrr(k));
  });

  it('never makes a better plane cheaper than the one below it, and the rocket a few weeks of moon income at most', () => {
    const planes = CATALOG.filter((i) => i.placement.kind === 'site' && i.placement.site === 'airport').sort((a, b) => a.unlock - b.unlock);
    for (let i = 1; i < planes.length; i++) expect(planes[i]!.price).toBeGreaterThan(planes[i - 1]!.price);
    const rocket = ITEMS.get('rocket')!;
    expect(rocket.price).toBeLessThanOrEqual(rocket.unlock * RATE);
    expect(rocket.price).toBeGreaterThan(planes.at(-1)!.price);
  });

  it('has unique ids, sensible prices and something to buy at every tier', () => {
    expect(new Set(CATALOG.map((i) => i.id)).size).toBe(CATALOG.length);
    for (const tier of [0, 50, 250, 500, 1_000, 2_000, 5_000, 10_000]) {
      expect(CATALOG.some((i) => i.unlock === tier)).toBe(true);
    }
    // Every item at a tier costs at most ~2 years of that tier's income.
    for (const i of CATALOG) if (i.unlock > 0) expect(i.price).toBeLessThanOrEqual(i.unlock * RATE * 24);
  });

  it('explains why something cannot be bought yet', () => {
    const g = simulate(days(2, () => ({})), [], 1);
    expect(canBuy(g, ITEMS.get('park')!)).toBeNull();
    expect(canBuy(g, ITEMS.get('skyscraper')!)).toBe('Unlocks at $1,000 MRR');
    expect(canBuy(g, ITEMS.get('prop-plane')!)).toBe('Unlocks at $250 MRR');
    expect(freePlots(g, 1)).toHaveLength(4);
  });

  it('runs the scripted demo founder without a single rejected action, all the way to the moon', () => {
    const t = demoTimeline({ end: Date.UTC(2026, 9, 11) });
    const actions = demoActions(t.snapshots);
    const g = simulate(t.snapshots, actions, t.snapshots.length - 1);
    expect(g.rejected).toEqual([]);
    // Every scripted build is unlocked and affordable in the plain demo, not only a boosted one.
    expect(g.owned.length).toBe(actions.length);
    expect(g.owned.length).toBeGreaterThan(25);
    expect(g.home.option).toBe('moon-house');
    expect(g.owned.some((o) => o.item === 'rocket' && o.site === 'launchpad')).toBe(true);
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
