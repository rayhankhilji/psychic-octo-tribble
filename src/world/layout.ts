import { hash } from './rng.ts';
import type { Snapshot } from '../data/types.ts';

import {
  BLOCK,
  BUILD_BLOCK_COORDS,
  HQ_BLOCK,
  NEIGHBOURHOOD_BLOCKS,
  PITCH,
  blockCentre,
  type BlockCoord,
} from './map.ts';

export { BLOCK, HQ_BLOCK, NEIGHBOURHOOD_BLOCKS, PITCH, blockCentre, type BlockCoord };
export const HOMES_PER_NEIGHBOURHOOD = 10;

export type Weather = 'clear' | 'rain';
export type HomeKind = 'house' | 'townhouse' | 'apartment';

export interface DistrictDef extends BlockCoord {
  id: string;
  name: string;
  /** MRR (major units) at which the district is built. */
  threshold: number;
  /** 0 = little shops … 7 = supertall. */
  tier: number;
  /** Neon accent, hex. */
  neon: number;
}

export interface DistrictPlan extends DistrictDef {
  /** Built: MRR has reached the threshold at some point. */
  unlocked: boolean;
  /** Lights on: MRR is at or above the threshold today. */
  lit: boolean;
}

export interface NeighbourhoodPlan extends BlockCoord {
  index: number;
  name: string;
}

export interface HomePlan {
  /** Stable identity for reconciliation: same lot + same building type. */
  key: string;
  /** 0 = first customer's home. */
  index: number;
  neighbourhood: number;
  x: number;
  z: number;
  /** Rotation about Y so the front door faces the street. */
  rot: number;
  kind: HomeKind;
  seed: number;
}

export interface WorldPlan {
  homes: HomePlan[];
  neighbourhoods: NeighbourhoodPlan[];
  districts: DistrictPlan[];
  /** Customers represented by each home (1 until the residential land fills). */
  residentsPerHome: number;
  hqFloors: number;
  weather: Weather;
  /** Cars on the road. */
  traffic: number;
  /** Blocks that have been developed (HQ, districts, neighbourhoods). */
  activeBlocks: BlockCoord[];
}

/** MRR milestones, celebrated in the feed. Placed on the downtown build blocks. */
export const DISTRICTS: readonly DistrictDef[] = [
  { id: 'market', name: 'First revenue', threshold: 1, tier: 0, neon: 0xffb347 },
  { id: 'arcade', name: '$1k MRR', threshold: 1_000, tier: 1, neon: 0xff3fa4 },
  { id: 'techpark', name: '$5k MRR', threshold: 5_000, tier: 2, neon: 0x3ff2ff },
  { id: 'midtown', name: '$10k MRR', threshold: 10_000, tier: 3, neon: 0x9d7bff },
  { id: 'skyline', name: '$25k MRR', threshold: 25_000, tier: 4, neon: 0x4fa8ff },
  { id: 'financial', name: '$50k MRR', threshold: 50_000, tier: 5, neon: 0x5dffa0 },
  { id: 'megacorp', name: '$100k MRR', threshold: 100_000, tier: 6, neon: 0xff5f5f },
  { id: 'moonshot', name: '$1M MRR', threshold: 1_000_000, tier: 7, neon: 0xfff27a },
].map((d) => ({ ...BUILD_BLOCK_COORDS.find((b) => b.id === d.id)!, ...d }));

const NEIGHBOURHOOD_NAMES = [
  'Russian Slope', 'Hayes Hollow', 'Cow Hollow', 'Lower Haight', 'Cole Valley', 'Duboce Row',
  'Noe Terrace', 'Glen Canyon', 'Dolores Heights', 'Bernal Rise', 'Potrero Steps', 'Inner Sunset',
  'Outer Sunset', 'Inner Richmond', 'Outer Richmond', 'Laurel Court', 'Jordan Park', 'Lake Street',
  'Sea Cliff', 'Parkside', 'Forest Knolls', 'Miraloma', 'Castro Row', 'Mission Dolores',
  'Valencia Corner', 'Dogpatch', 'Mission Bay', 'Sunnyside', 'Excelsior', 'Portola',
  'Golden Gate Heights', 'Ingleside', 'Merced Manor', 'St. Francis Wood', 'West Portal',
  'Midtown Terrace', 'Diamond Heights', 'Twin Lakes', 'Ocean View', 'Visitacion'
];

export const HOME_CAPACITY = NEIGHBOURHOOD_BLOCKS.length * HOMES_PER_NEIGHBOURHOOD;

export interface Lot {
  i: number;
  j: number;
  rot: number;
}

/** The 12 edge lots of a block, walking clockwise; each faces the nearest street. */
const EDGE_LOTS: readonly Lot[] = (() => {
  const lots: Lot[] = [];
  const facing = (i: number, j: number) => {
    if (j === BLOCK - 1) return 0; // +z
    if (j === 0) return Math.PI; // -z
    return i === BLOCK - 1 ? Math.PI / 2 : -Math.PI / 2;
  };
  for (let i = 0; i < BLOCK; i++) lots.push({ i, j: BLOCK - 1, rot: facing(i, BLOCK - 1) });
  for (let j = BLOCK - 2; j >= 1; j--) lots.push({ i: BLOCK - 1, j, rot: facing(BLOCK - 1, j) });
  for (let i = BLOCK - 1; i >= 0; i--) lots.push({ i, j: 0, rot: facing(i, 0) });
  for (let j = 1; j <= BLOCK - 2; j++) lots.push({ i: 0, j, rot: facing(0, j) });
  return lots;
})();

/**
 * Which edge lots in a neighbourhood hold homes. Two opposite corners are
 * left for trees, alternating per block so the town doesn't look stamped.
 */
export function homeLots(n: number): Lot[] {
  const skip = n % 2 === 0 ? [0, 6] : [3, 9];
  return EDGE_LOTS.filter((_, k) => !skip.includes(k));
}

/** The two corner lots of a neighbourhood that are planted with trees instead. */
export function treeLots(n: number): Lot[] {
  return (n % 2 === 0 ? [0, 6] : [3, 9]).map((k) => EDGE_LOTS[k]!);
}

/** Edge lots that aren't corners: shopfronts on Market Street. */
export const FRONTAGE_LOTS: readonly Lot[] = EDGE_LOTS.filter((_, k) => k % 3 !== 0);

export function lotPosition(b: BlockCoord, lot: { i: number; j: number }): { x: number; z: number } {
  const c = blockCentre(b);
  return { x: c.x - (BLOCK - 1) / 2 + lot.i, z: c.z - (BLOCK - 1) / 2 + lot.j };
}

export function homeKind(residentsPerHome: number): HomeKind {
  if (residentsPerHome <= 1) return 'house';
  if (residentsPerHome <= 4) return 'townhouse';
  return 'apartment';
}

export function neighbourhoodName(n: number): string {
  return NEIGHBOURHOOD_NAMES[n] ?? `Block ${n + 1}`;
}

export interface PlanContext {
  /** Highest MRR reached up to this day. */
  peakMrr: number;
  weather: Weather;
  seed?: number;
}

/**
 * Turns one day of metrics into a city. Pure and deterministic: the same
 * numbers always produce the same world, and growth only ever adds to it
 * (customer #12's house never moves when customer #13 arrives).
 */
export function planWorld(s: Snapshot, ctx: PlanContext): WorldPlan {
  const seed = ctx.seed ?? 1;
  const customers = Math.max(0, Math.floor(s.customers));
  const residentsPerHome = customers <= HOME_CAPACITY ? 1 : Math.ceil(customers / HOME_CAPACITY);
  // Once every lot has a home, growth shows as density (residents per home), never as fewer homes.
  const homeCount = Math.min(customers, HOME_CAPACITY);
  const lots = homeLots(0).length;
  const neighbourhoodCount = NEIGHBOURHOOD_BLOCKS.length;
  // Density falls off from downtown: towers of flats near HQ, houses at the edge. It depends only on
  // the neighbourhood's place in the order and the density tier, so a home's kind (and its model)
  // changes only when the whole city steps up a tier, not every time a neighbourhood opens.
  const kindOf = (n: number): HomeKind => {
    const f = n / neighbourhoodCount;
    if (residentsPerHome <= 1) return 'house';
    if (residentsPerHome <= 4) return f < 0.4 ? 'townhouse' : 'house';
    return f < 0.3 ? 'apartment' : f < 0.65 ? 'townhouse' : 'house';
  };

  const homes: HomePlan[] = [];
  for (let index = 0; index < homeCount; index++) {
    const n = Math.floor(index / lots);
    const block = NEIGHBOURHOOD_BLOCKS[n]!;
    const lot = homeLots(n)[index % lots]!;
    const { x, z } = lotPosition(block, lot);
    const kind = kindOf(n);
    homes.push({ key: `home-${index}-${kind}`, index, neighbourhood: n, x, z, rot: lot.rot, kind, seed: hash(seed, 'home', index) });
  }

  const neighbourhoods: NeighbourhoodPlan[] = [];
  for (let n = 0; n < Math.ceil(homeCount / lots); n++) {
    neighbourhoods.push({ ...NEIGHBOURHOOD_BLOCKS[n]!, index: n, name: neighbourhoodName(n) });
  }

  const peak = Math.max(ctx.peakMrr, s.mrr);
  const districts = DISTRICTS.map((d) => ({ ...d, unlocked: peak >= d.threshold, lit: s.mrr >= d.threshold }));

  return {
    homes,
    neighbourhoods,
    districts,
    residentsPerHome,
    hqFloors: 3 + Math.min(s.releases, 27),
    weather: ctx.weather,
    traffic: customers === 0 ? 1 : Math.min(46, Math.round(2 + 2 * Math.sqrt(customers))),
    activeBlocks: [HQ_BLOCK, ...districts.filter((d) => d.unlocked), ...neighbourhoods].map(({ bx, bz }) => ({ bx, bz })),
  };
}
