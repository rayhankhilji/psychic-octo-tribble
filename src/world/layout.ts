import { hash } from './rng.ts';
import type { Snapshot } from '../data/types.ts';

/** Lots per block edge. Every block is 4×4 lots, ringed by one-lot-wide roads. */
export const BLOCK = 4;
/** Distance between block centres. */
export const PITCH = BLOCK + 1;
/** Blocks extend this far from the HQ block in each direction. */
export const RADIUS = 3;
export const HOMES_PER_NEIGHBOURHOOD = 10;

export type Weather = 'clear' | 'rain';
export type HomeKind = 'house' | 'townhouse' | 'apartment';

export interface BlockCoord {
  bx: number;
  bz: number;
}

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

export const DISTRICTS: readonly DistrictDef[] = [
  { id: 'market', name: 'Market Street', threshold: 1, tier: 0, neon: 0xffb347, bx: 1, bz: 0 },
  { id: 'arcade', name: 'Neon Arcade', threshold: 1_000, tier: 1, neon: 0xff3fa4, bx: 0, bz: 1 },
  { id: 'techpark', name: 'Tech Park', threshold: 5_000, tier: 2, neon: 0x3ff2ff, bx: -1, bz: 0 },
  { id: 'midtown', name: 'Midtown', threshold: 10_000, tier: 3, neon: 0x9d7bff, bx: 0, bz: -1 },
  { id: 'skyline', name: 'Skyline', threshold: 25_000, tier: 4, neon: 0x4fa8ff, bx: -1, bz: -1 },
  { id: 'financial', name: 'Financial District', threshold: 50_000, tier: 5, neon: 0x5dffa0, bx: -2, bz: -1 },
  { id: 'megacorp', name: 'Megacorp Heights', threshold: 100_000, tier: 6, neon: 0xff5f5f, bx: -1, bz: -2 },
  { id: 'moonshot', name: 'Moonshot Spire', threshold: 1_000_000, tier: 7, neon: 0xfff27a, bx: -2, bz: -2 },
];

const NEIGHBOURHOOD_NAMES = [
  'Maple Court', 'Juniper Row', 'Cedar Hollow', 'Lantern Lane', 'Willow Bend', 'Foxglove Close',
  'Harbour View', 'Orchard Rise', 'Birch Terrace', 'Copper Hill', 'Sparrow Green', 'Linden Square',
  'Moonlit Mews', 'Thistle Park', 'Heron Walk', 'Clover Gardens', 'Aspen Yard', 'Rosewood',
  'Pebble Crescent', 'Elm Commons', 'Larkspur', 'Bramble End', 'Saffron Row', 'Kestrel Heights',
  'Poplar Place', 'Wren Hollow', 'Fern Gully', 'Quarry Lane', 'Driftwood', 'Hazel Court',
  'Ivy Bridge', 'Marigold', 'Oakridge', 'Pine Hollow', 'Sorrel Close', 'Tamarind',
  'Umber Street', 'Violet Row', 'Yarrow Fields', 'Zephyr Point',
];

export const HQ_BLOCK: BlockCoord = { bx: 0, bz: 0 };

const sameBlock = (a: BlockCoord, b: BlockCoord) => a.bx === b.bx && a.bz === b.bz;

/** Residential blocks, nearest to downtown first. */
export const NEIGHBOURHOOD_BLOCKS: readonly BlockCoord[] = (() => {
  const blocks: BlockCoord[] = [];
  for (let bx = -RADIUS; bx <= RADIUS; bx++) {
    for (let bz = -RADIUS; bz <= RADIUS; bz++) {
      const b = { bx, bz };
      if (sameBlock(b, HQ_BLOCK) || DISTRICTS.some((d) => sameBlock(d, b))) continue;
      blocks.push(b);
    }
  }
  // Front of the camera (+x,+z) first so early growth is in view, then outwards.
  const angle = (b: BlockCoord) => (Math.atan2(b.bz, b.bx) - Math.PI / 4 + 4 * Math.PI) % (2 * Math.PI);
  return blocks.sort((a, b) => Math.hypot(a.bx, a.bz) - Math.hypot(b.bx, b.bz) || angle(a) - angle(b));
})();

export const HOME_CAPACITY = NEIGHBOURHOOD_BLOCKS.length * HOMES_PER_NEIGHBOURHOOD;

export function blockCentre(b: BlockCoord): { x: number; z: number } {
  return { x: b.bx * PITCH, z: b.bz * PITCH };
}

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
  const homeCount = Math.ceil(customers / residentsPerHome);
  const kind = homeKind(residentsPerHome);
  const lots = homeLots(0).length;

  const homes: HomePlan[] = [];
  for (let index = 0; index < homeCount; index++) {
    const n = Math.floor(index / lots);
    const block = NEIGHBOURHOOD_BLOCKS[n]!;
    const lot = homeLots(n)[index % lots]!;
    const { x, z } = lotPosition(block, lot);
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
