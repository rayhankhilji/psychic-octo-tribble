import type { Snapshot } from '../data/types.ts';
import { blockCentre } from '../world/layout.ts';
import {
  BUILD_BLOCKS,
  HOME_TIERS,
  ITEMS,
  QUADRANTS,
  REGIONS,
  SITE_REGION,
  SWAP_FEE,
  type Item,
  type Region,
  type Site,
} from './catalog.ts';

/** Game dollars per real dollar. */
export const RATE = 10_000;
/** Treasury on day one, so pre-revenue founders can still build a little. */
export const STARTING_GRANT = 500_000;
/** Users housed for free, so a pre-launch city isn't a tent city. */
export const FREE_HOUSED = 100;
/** Real MRR each user needs to be housed: 1,000 users need $200. */
export const MRR_PER_USER = 0.2;
/** Game dollars per housed resident per month (beyond the free ones). */
export const HOUSING_UPKEEP = 1_000;
/** How hard a homelessness crisis strains the city: 100% homeless knocks 60 points off maintenance. */
export const HOMELESS_STRAIN = 0.6;
/** How much maintenance can fall or recover per day, in points. */
const DECAY_PER_DAY = 2;
const REPAIR_PER_DAY = 4;
const DAYS_PER_MONTH = 30;

export type Action =
  | { t: number; kind: 'build'; item: string; plot?: string }
  | { t: number; kind: 'home'; tier: number; choice: string };

export interface PlotState {
  id: string;
  block: string;
  x: number;
  z: number;
  open: boolean;
  /** Item built here. For whole-block items every plot of the block points at it. */
  item?: string;
  /** True on the plot that renders a whole-block item. */
  anchor?: boolean;
}

export interface Owned {
  item: string;
  plot?: string;
  site?: Site;
  t: number;
}

export interface Satisfaction {
  score: number;
  housing: number;
  upkeep: number;
  amenities: number;
  momentum: number;
}

export interface GameState {
  t: number;
  mrr: number;
  peakMrr: number;
  treasury: number;
  incomePerDay: number;
  upkeepPerDay: number;
  /** Running totals since day one: income credited and upkeep actually paid. */
  earned: number;
  upkeepPaid: number;
  /** 0–100: how much of the city's upkeep is being paid. */
  maintenance: number;
  population: number;
  housed: number;
  unhoused: number;
  /** Real MRR needed to house everyone. */
  housingNeed: number;
  satisfaction: Satisfaction;
  owned: Owned[];
  hqLevel: number;
  plots: PlotState[];
  openBlocks: string[];
  regions: Record<Region, boolean>;
  /** `explicit` lists the tiers where the founder chose (the rest use the first option). */
  home: { tier: number; option: string; picks: Record<number, string>; explicit: number[] };
  /** Actions that couldn't be applied (unaffordable, locked, no space). */
  rejected: { action: Action; reason: string }[];
}

export interface Decay {
  signDark: boolean;
  lampsFailing: boolean;
  bridgeRusting: boolean;
  trainStopped: boolean;
  shopsBoarded: boolean;
  housingFailing: boolean;
}

/** What upkeep shortfall looks like, worst last. */
export function decayOf(maintenance: number): Decay {
  return {
    signDark: maintenance < 95,
    lampsFailing: maintenance < 85,
    bridgeRusting: maintenance < 75,
    trainStopped: maintenance < 60,
    shopsBoarded: maintenance < 50,
    housingFailing: maintenance < 35,
  };
}

export function plotsOf(blockId: string): PlotState[] {
  const block = BUILD_BLOCKS.find((b) => b.id === blockId)!;
  const c = blockCentre(block);
  return QUADRANTS.map(([qx, qz], q) => ({ id: `${blockId}:${q}`, block: blockId, x: c.x + qx, z: c.z + qz, open: false }));
}

export function populationOf(s: Snapshot): number {
  return Math.max(0, Math.floor(s.users ?? s.customers));
}

export function homeTierFor(peakMrr: number): number {
  let tier = 0;
  HOME_TIERS.forEach((h, i) => {
    if (peakMrr >= h.mrr) tier = i;
  });
  return tier;
}

export interface SimOptions {
  /** Only credit income from this day on (back pay window for newly connected founders). */
  incomeFrom?: number;
}

/**
 * Replays the economy day by day up to `upto` (an index into snapshots).
 * Pure: same timeline and actions, same city. Invalid actions are skipped
 * and reported, never half-applied.
 */
export function simulate(snapshots: Snapshot[], actions: Action[], upto: number, opts: SimOptions = {}): GameState {
  const queue = [...actions].sort((a, b) => a.t - b.t);
  let qi = 0;
  const plots = new Map<string, PlotState>();
  for (const b of BUILD_BLOCKS) for (const p of plotsOf(b.id)) plots.set(p.id, p);
  const openBlocks: string[] = [];
  const owned: Owned[] = [];
  const rejected: GameState['rejected'] = [];
  const picks: Record<number, string> = {};

  let treasury = STARTING_GRANT;
  let earned = 0;
  let upkeepPaid = 0;
  let maintenance = 100;
  let peak = 0;
  let hqLevel = 0;
  let incomePerDay = 0;
  let upkeepPerDay = 0;
  let housed = 0;
  let population = 0;
  const last = Math.min(upto, snapshots.length - 1);

  const regionsAt = (p: number) =>
    Object.fromEntries(Object.entries(REGIONS).map(([k, r]) => [k, p >= r.gate])) as Record<Region, boolean>;

  const openLand = () => {
    for (let k = openBlocks.length; k < BUILD_BLOCKS.length; k++) {
      const b = BUILD_BLOCKS[k]!;
      const prevFull = openBlocks.every((id) => [...plots.values()].filter((p) => p.block === id).every((p) => p.item));
      if (peak < b.gate || (k > 0 && !prevFull)) break;
      openBlocks.push(b.id);
      for (const p of plots.values()) if (p.block === b.id) p.open = true;
    }
  };

  const apply = (a: Action, s: Snapshot) => {
    if (a.kind === 'home') {
      const tier = HOME_TIERS[a.tier];
      if (!tier || peak < tier.mrr) return rejected.push({ action: a, reason: 'Not unlocked yet' });
      if (!tier.options.some((o) => o.id === a.choice)) return rejected.push({ action: a, reason: 'Unknown option' });
      const current = picks[a.tier];
      if (current === a.choice) return;
      const fee = current ? tier.value * SWAP_FEE : 0;
      if (treasury < fee) return rejected.push({ action: a, reason: 'Not enough money for the renovation' });
      treasury -= fee;
      picks[a.tier] = a.choice;
      return;
    }
    const item = ITEMS.get(a.item);
    if (!item) return rejected.push({ action: a, reason: 'Unknown item' });
    const why = blocker(item, a.plot, s.mrr);
    if (why) return rejected.push({ action: a, reason: why });
    treasury -= item.price;
    place(item, a);
  };

  const blocker = (item: Item, plotId: string | undefined, mrr: number): string | null => {
    if (mrr < item.unlock) return `Unlocks at $${item.unlock.toLocaleString('en-US')} MRR`;
    if (treasury < item.price) return 'Not enough money';
    const pl = item.placement;
    if (pl.kind === 'hq') return pl.level > hqLevel ? null : 'HQ is already at this level or higher';
    if (pl.kind === 'site') {
      const region = SITE_REGION[pl.site];
      if (region && !regionsAt(peak)[region]) return `${REGIONS[region].name} isn't open yet`;
      const used = owned.filter((o) => o.site === pl.site && ITEMS.get(o.item)?.placement.kind === 'site').length;
      const capacity = siteCapacity(pl.site);
      if (used >= capacity) return 'No space left there';
      if (pl.site === 'pier' && owned.some((o) => o.item === item.id)) return 'Already built';
      return null;
    }
    const p = plotId ? plots.get(plotId) : undefined;
    if (!p || !p.open) return 'Pick an open plot';
    if (pl.size === 1) return p.item ? 'That plot is taken' : null;
    const block = [...plots.values()].filter((q) => q.block === p.block);
    return block.every((q) => !q.item) ? null : 'Needs a whole empty block';
  };

  const place = (item: Item, a: Extract<Action, { kind: 'build' }>) => {
    const pl = item.placement;
    if (pl.kind === 'hq') {
      hqLevel = pl.level;
      owned.push({ item: item.id, t: a.t });
    } else if (pl.kind === 'site') {
      owned.push({ item: item.id, site: pl.site, t: a.t });
    } else {
      const p = plots.get(a.plot!)!;
      if (pl.size === 1) {
        p.item = item.id;
        p.anchor = true;
      } else {
        for (const q of plots.values()) if (q.block === p.block) q.item = item.id;
        const anchor = plots.get(`${p.block}:0`)!;
        anchor.anchor = true;
      }
      owned.push({ item: item.id, plot: pl.size === 1 ? p.id : `${p.block}:0`, t: a.t });
    }
  };

  for (let i = 0; i <= last; i++) {
    const s = snapshots[i]!;
    peak = Math.max(peak, s.mrr);
    openLand();

    incomePerDay = opts.incomeFrom === undefined || s.t >= opts.incomeFrom ? (s.mrr * RATE) / DAYS_PER_MONTH : 0;
    treasury += incomePerDay;
    earned += incomePerDay;

    while (qi < queue.length && queue[qi]!.t <= s.t) {
      apply(queue[qi++]!, s);
      // Filling the last plot opens the next block straight away, as the build menu already shows.
      openLand();
    }

    population = populationOf(s);
    const capacity = Math.max(FREE_HOUSED, Math.floor(s.mrr / MRR_PER_USER));
    const failing = maintenance < 35 ? maintenance / 35 : 1;
    housed = Math.min(population, Math.floor(Math.max(Math.min(FREE_HOUSED, population), capacity * failing)));

    const buildingUpkeep = owned.reduce((sum, o) => sum + ITEMS.get(o.item)!.price * ITEMS.get(o.item)!.upkeep, 0);
    upkeepPerDay = (Math.max(0, housed - FREE_HOUSED) * HOUSING_UPKEEP + buildingUpkeep) / DAYS_PER_MONTH;
    const paid = Math.min(upkeepPerDay, treasury);
    treasury -= paid;
    upkeepPaid += paid;
    // Unpaid upkeep runs the city down, and so does a homelessness crisis:
    // poor conversion shows up in the streets, not just in the tents.
    const funded = upkeepPerDay > 0 ? (paid / upkeepPerDay) * 100 : 100;
    const crisis = population > 0 ? (population - housed) / population : 0;
    const target = funded * (1 - HOMELESS_STRAIN * crisis);
    maintenance += Math.max(-DECAY_PER_DAY, Math.min(REPAIR_PER_DAY, target - maintenance));
  }

  const s = snapshots[last];
  const mrr = s?.mrr ?? 0;
  const monthAgo = snapshots[Math.max(0, last - 28)]?.mrr ?? 0;
  const amenityPoints = owned.reduce((sum, o) => sum + ITEMS.get(o.item)!.amenity, 0);
  const sat = {
    housing: population > 0 ? housed / population : 1,
    upkeep: maintenance / 100,
    amenities: Math.min(1, amenityPoints / (4 + population / 250)),
    momentum: monthAgo > 0 ? clamp01(0.5 + ((mrr - monthAgo) / monthAgo) * 2.5) : mrr > 0 ? 1 : 0.5,
  };
  const score = Math.round(100 * (0.35 * sat.housing + 0.25 * sat.upkeep + 0.2 * sat.amenities + 0.2 * sat.momentum));

  const tier = homeTierFor(peak);
  const explicit = Object.keys(picks).map(Number);
  for (let k = 0; k <= tier; k++) picks[k] ??= HOME_TIERS[k]!.options[0]!.id;

  return {
    t: s?.t ?? 0,
    mrr,
    peakMrr: peak,
    treasury: Math.max(0, treasury),
    incomePerDay,
    upkeepPerDay,
    earned,
    upkeepPaid,
    maintenance: Math.round(maintenance * 10) / 10,
    population,
    housed,
    unhoused: population - housed,
    housingNeed: population * MRR_PER_USER,
    satisfaction: { score, ...sat },
    owned,
    hqLevel,
    plots: [...plots.values()],
    openBlocks,
    regions: regionsAt(peak),
    home: { tier, option: picks[tier]!, picks, explicit },
    rejected,
  };
}

export function siteCapacity(site: Site): number {
  return site === 'pier' ? 2 : site === 'marina' ? 3 : site === 'airport' ? 4 : 1;
}

/** Why an item can't be bought right now, or null if it can (ignoring which plot). */
export function canBuy(state: GameState, item: Item): string | null {
  if (state.mrr < item.unlock) return `Unlocks at $${item.unlock.toLocaleString('en-US')} MRR`;
  if (state.treasury < item.price) return `Need ${money(item.price - state.treasury)} more`;
  const pl = item.placement;
  if (pl.kind === 'hq') return pl.level > state.hqLevel ? null : 'Already built';
  if (pl.kind === 'site') {
    const region = SITE_REGION[pl.site];
    if (region && !state.regions[region]) return `Opens at $${REGIONS[region].gate.toLocaleString('en-US')} MRR`;
    if (pl.site === 'pier' && state.owned.some((o) => o.item === item.id)) return 'Already built';
    if (state.owned.filter((o) => o.site === pl.site).length >= siteCapacity(pl.site)) return 'No space left';
    return null;
  }
  const free = freePlots(state, pl.size);
  return free.length ? null : pl.size === 4 ? 'Needs a whole empty block' : 'No free plots. Fill them all to open more land';
}

/** Plots an item of this size could go on. For whole-block items, one plot per empty block. */
export function freePlots(state: GameState, size: 1 | 4): PlotState[] {
  const open = state.plots.filter((p) => p.open);
  if (size === 1) return open.filter((p) => !p.item);
  const blocks = new Set(open.map((p) => p.block));
  return [...blocks].filter((b) => open.filter((p) => p.block === b).every((p) => !p.item)).map((b) => open.find((p) => p.block === b)!);
}

// ─── Events between two days, for the feed and celebrations ───────────────

export type GameEvent =
  | { type: 'land.opened'; name: string }
  | { type: 'region.opened'; region: Region; name: string }
  | { type: 'home.moved'; name: string; tier: number }
  | { type: 'sign.dark' }
  | { type: 'sign.lit' }
  | { type: 'decay'; what: string }
  | { type: 'homeless.appeared'; count: number }
  | { type: 'homeless.cleared' };

export function diffGame(a: GameState, b: GameState): GameEvent[] {
  const events: GameEvent[] = [];
  for (const id of b.openBlocks) {
    if (!a.openBlocks.includes(id)) events.push({ type: 'land.opened', name: BUILD_BLOCKS.find((x) => x.id === id)!.name });
  }
  for (const r of Object.keys(REGIONS) as Region[]) {
    if (b.regions[r] && !a.regions[r]) events.push({ type: 'region.opened', region: r, name: REGIONS[r].name });
  }
  if (b.home.tier > a.home.tier) {
    const tier = HOME_TIERS[b.home.tier]!;
    events.push({ type: 'home.moved', tier: b.home.tier, name: tier.options.find((o) => o.id === b.home.option)!.name });
  }
  const da = decayOf(a.maintenance);
  const db = decayOf(b.maintenance);
  if (db.signDark && !da.signDark) events.push({ type: 'sign.dark' });
  if (!db.signDark && da.signDark) events.push({ type: 'sign.lit' });
  if (db.bridgeRusting && !da.bridgeRusting) events.push({ type: 'decay', what: 'The bridge is rusting' });
  if (db.trainStopped && !da.trainStopped) events.push({ type: 'decay', what: 'Train service is suspended' });
  if (db.shopsBoarded && !da.shopsBoarded) events.push({ type: 'decay', what: 'Shops are boarding up' });
  if (b.unhoused > 0 && a.unhoused === 0) events.push({ type: 'homeless.appeared', count: b.unhoused });
  if (b.unhoused === 0 && a.unhoused > 0) events.push({ type: 'homeless.cleared' });
  return events;
}

export function describeGame(e: GameEvent): string {
  switch (e.type) {
    case 'land.opened':
      return `New land: ${e.name} is open for building`;
    case 'region.opened':
      return `The clouds cleared over ${e.name}`;
    case 'home.moved':
      return `You moved into your ${e.name}`;
    case 'sign.dark':
      return 'Upkeep is short. The TINYTOWN sign went dark tonight';
    case 'sign.lit':
      return 'The TINYTOWN sign is back on';
    case 'decay':
      return `${e.what}. Upkeep is short`;
    case 'homeless.appeared':
      return `${e.count.toLocaleString('en-US')} people have no home. Housing needs $0.20 MRR per user`;
    case 'homeless.cleared':
      return 'Everyone has a home again';
  }
}

export function money(n: number): string {
  const abs = Math.abs(n);
  const f = (v: number, s: string) => `$${v >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2).replace(/\.?0+$/, '')}${s}`;
  if (abs >= 1e12) return f(n / 1e12, 'T');
  if (abs >= 1e9) return f(n / 1e9, 'B');
  if (abs >= 1e6) return f(n / 1e6, 'M');
  if (abs >= 1e3) return f(n / 1e3, 'k');
  return `$${Math.round(n)}`;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
