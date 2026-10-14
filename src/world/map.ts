/**
 * The Bay: a stylised San Francisco peninsula. Pure geometry, no rendering.
 *
 * Compass: +x east, −x west, +z north, −z south. The isometric camera sits
 * to the north-east looking south-west, so the bay and the waterfront are in
 * the foreground, Market Street runs straight up the screen from the Ferry
 * Building to Twin Peaks, and the Pacific is behind the city on the left.
 *
 * City blocks sit on a 5-unit lattice (4×4 lots plus a 1-unit road), with
 * block (0,0) downtown by the Ferry Building.
 */

import { onWorldSeed, worldSeed } from './seed.ts';
import { generateWorld, type Bump, type Island, type Look, type Pt, type WorldSpec } from './worldgen.ts';

export type { Island, Look, Pt, WorldSpec };

/** Math.hypot is slow in V8, and these run hundreds of thousands of times while the terrain is built. */
const len2 = (x: number, z: number) => Math.sqrt(x * x + z * z);

export const PITCH = 5;
export const BLOCK = 4;

// Everything below that depends on the world's seed is a live binding (`export let`), assigned by
// `applyWorld` when the module loads and again whenever the seed changes (see `seed.ts`). Read
// them at use, never copy them into module-level constants elsewhere.

/** The world being shown: what `worldgen.ts` drew for this seed. */
export let WORLD_SPEC: WorldSpec;

/** The grid the city can occupy. */
export let GRID: { readonly bx0: number; readonly bx1: number; readonly bz0: number; readonly bz1: number };

// ─── Coastlines ─────────────────────────────────────────────────────────────

/** San Francisco and the peninsula south of it. */
export let MAINLAND: readonly Pt[];

/** The Marin Headlands, across the Golden Gate. */
export let MARIN: readonly Pt[];

/** The East Bay, mostly off to the right. */
export let EAST_BAY: readonly Pt[];

export let ISLANDS: Readonly<Record<'founder' | 'launch' | 'yerba' | 'treasure' | 'angel', Island>>;

// ─── Geometry helpers ───────────────────────────────────────────────────────

/** Signed distance to a polygon: negative inside, positive outside. */
export function polygonDistance(poly: readonly Pt[], x: number, z: number): number {
  let d2 = Infinity;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const p = poly[i]!;
    const q = poly[j]!;
    const xi = p[0];
    const zi = p[1];
    const xj = q[0];
    const zj = q[1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    const ex = xj - xi;
    const ez = zj - zi;
    const t = Math.max(0, Math.min(1, ((x - xi) * ex + (z - zi) * ez) / (ex * ex + ez * ez || 1)));
    const dx = x - xi - ex * t;
    const dz = z - zi - ez * t;
    const e = dx * dx + dz * dz;
    if (e < d2) d2 = e;
  }
  const d = Math.sqrt(d2);
  return inside ? -d : d;
}

/** Distance to the nearest coast: negative on land, positive in the water. */
export function coastDistance(x: number, z: number): number {
  let d = Math.min(mainlandDistance(x, z), polygonDistance(AIRPORT_FILL, x, z));
  for (const id of ISLAND_IDS) {
    const isl = ISLANDS[id];
    // Every island's outline stays within r + 3 of its centre.
    if (len2(x - isl.x, z - isl.z) - isl.r - 3 > d) continue;
    d = Math.min(d, islandDistance(id, x, z));
  }
  return d;
}

/** San Francisco, Marin and the East Bay. */
function mainlandDistance(x: number, z: number): number {
  return Math.min(polygonDistance(MAINLAND, x, z), polygonDistance(MARIN, x, z), polygonDistance(EAST_BAY, x, z));
}

// ─── Island shapes ─────────────────────────────────────────────────────────

const ISLAND_IDS = ['founder', 'launch', 'yerba', 'treasure', 'angel'] as const;
type IslandId = (typeof ISLAND_IDS)[number];

/**
 * Yerba Buena: a rocky, wooded ridge running east-west, highest along the
 * Bay Bridge tunnel (z ≈ −6.5), with the Coast Guard point to the south-east.
 */
const YERBA_COAST: readonly Pt[] = [
  [29.75, -5.5], [30.3, -4.7], [31.4, -4.2], [32.6, -4.05], [33.9, -4.15], [35.0, -4.55], [35.9, -5.3], [36.3, -6.3],
  [36.55, -7.4], [37.1, -8.3], [37.0, -9.05], [36.1, -9.25], [35.0, -9.05], [33.8, -9.6], [32.5, -9.55], [31.3, -9.0],
  [30.4, -8.2], [29.85, -7.3], [29.7, -6.5],
];

/** Treasure Island: flat 1930s landfill behind a seawall, chamfered corners, a causeway to Yerba Buena. */
export const TREASURE_COAST: readonly Pt[] = [
  [32.4, -2.2], [33.0, -2.8], [38.8, -2.8], [39.4, -2.2], [39.4, 2.3], [38.8, 2.9], [33.0, 2.9], [32.4, 2.3],
];

/** The airport on fill: a runway strip out into the bay, terminals and aprons, behind a riprap seawall. */
export const AIRPORT_FILL: readonly Pt[] = [
  [14.6, -33.6], [22.9, -33.6], [23.9, -34.4], [28.9, -34.4], [29.5, -35.0], [29.5, -53.0], [28.9, -53.6], [15.6, -53.6], [14.6, -52.6],
];

/** Your island's outline: a rough circle, a cove on one side (the east, classically, facing the camera) for the superyacht's jetty. */
export let ISLAND_COVE: { readonly x: number; readonly z: number; readonly r: number };

const wobble = (a: number, seed: number) => 0.32 * Math.sin(3 * a + seed) + 0.18 * Math.sin(5 * a + seed * 2.1) + 0.1 * Math.sin(9 * a + seed * 0.7);

/** Signed distance to an island's coast (approximate for the wobbly ones): negative on land. */
function islandDistance(id: IslandId, x: number, z: number): number {
  const isl = ISLANDS[id];
  switch (id) {
    case 'yerba':
      return polygonDistance(YERBA_COAST, x, z);
    case 'treasure':
      return polygonDistance(TREASURE_COAST, x, z);
    case 'founder': {
      const a = Math.atan2(z - isl.z, x - isl.x);
      const d = len2(x - isl.x, z - isl.z) - isl.r - wobble(a, WORLD_SPEC.estate.wobble) * 0.8;
      // Carve the cove, rounding off its two headlands.
      const cove = ISLAND_COVE.r - len2(x - ISLAND_COVE.x, z - ISLAND_COVE.z);
      return smoothMax(d, cove, 0.5);
    }
    case 'launch': {
      const a = Math.atan2(z - isl.z, x - isl.x);
      return len2(x - isl.x, z - isl.z) - isl.r - wobble(a, 4.1) * 0.5;
    }
    default: {
      const a = Math.atan2(z - isl.z, x - isl.x);
      return len2(x - isl.x, z - isl.z) - isl.r - wobble(a, 2.6) * 1.4;
    }
  }
}

/** A max with a rounded crease of width k. */
function smoothMax(a: number, b: number, k: number): number {
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (a - b)) / k));
  return b + (a - b) * h + k * h * (1 - h);
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const bump = (x: number, z: number, cx: number, cz: number, r: number, h: number) => {
  const d = len2(x - cx, z - cz) / r;
  return d >= 1 ? 0 : h * (1 - d * d) ** 2;
};

// ─── City blocks ────────────────────────────────────────────────────────────

export interface BlockCoord {
  bx: number;
  bz: number;
}

/** What a block is: downtown, a street of homes, Market Street's flatirons, a park (`park` the big one, `square` a little one), the Presidio, too steep (`hill`), City Hall. */
export type BlockUse = 'hq' | 'city' | 'market' | 'park' | 'square' | 'presidio' | 'hill' | 'civic';

export const HQ_BLOCK: BlockCoord = { bx: 0, bz: 0 };
/** Civic Center: City Hall and its plaza, just off Market. */
export let CIVIC_BLOCK: BlockCoord;

/** Market Street runs along x − z = MARKET_K, from the Ferry Building to Twin Peaks. */
export const MARKET_K = 10;
export const MARKET_START: Pt = [10.6, 0.6];
/** Where Market ends at the foot of the hills (Twin Peaks Boulevard climbs on from here). */
export let MARKET_END: Pt;

export function blockCentre(b: BlockCoord): { x: number; z: number } {
  return { x: b.bx * PITCH, z: b.bz * PITCH };
}

/** The big hill behind the city: the sign arcs across its north-east face. */
export let TWIN_PEAKS: { readonly x: number; readonly z: number; readonly r: number; readonly h: number };

/**
 * The hills as the block plan sees them (which blocks are too steep to build
 * on). Frozen for the classic map: the terrain itself is `relief`, which adds
 * the detail, so re-sculpting it never moves a block. Other worlds use the
 * same recipe around their own peaks.
 */
function hills(x: number, z: number): number {
  if (WORLD_SPEC.classic) {
    return (
      // Twin Peaks and Mount Sutro
      bump(x, z, TWIN_PEAKS.x, TWIN_PEAKS.z, TWIN_PEAKS.r, TWIN_PEAKS.h) +
      bump(x, z, -8, -40, 8, 4.5) +
      bump(x, z, -23, -35, 8, 5) +
      // Telegraph Hill
      bump(x, z, -5, 6, 3.4, 2.4) +
      // The Presidio
      bump(x, z, -36, 3, 9, 1.4) +
      // Lands End
      bump(x, z, -44, 2, 5, 2.6) +
      // San Bruno Mountain and the south
      bump(x, z, -6, -66, 26, 11) +
      bump(x, z, -40, -52, 16, 5) +
      bump(x, z, 12, -58, 14, 4) +
      // Marin Headlands
      bump(x, z, -48, 34, 22, 13) +
      bump(x, z, -30, 40, 14, 9) +
      bump(x, z, -70, 30, 18, 10) +
      // East Bay hills
      bump(x, z, 92, -10, 40, 16) +
      bump(x, z, 80, 40, 30, 12)
    );
  }
  const P = WORLD_SPEC.peaks;
  let h = bump(x, z, TWIN_PEAKS.x, TWIN_PEAKS.z, TWIN_PEAKS.r, TWIN_PEAKS.h) + bump(x, z, P.centre.x + 6, P.centre.z - 4, 8, 4.5);
  if (P.sutro) h += bump(x, z, P.sutro[0], P.sutro[1], 8, 5);
  for (const b of [...WORLD_SPEC.cityBumps, ...WORLD_SPEC.farBumps]) h += bump(x, z, b[0], b[1], b[2], b[3]);
  return h;
}

/** Every grid block that exists, with what it's used for. */
export let BLOCKS: readonly (BlockCoord & { use: BlockUse })[];

export function blockUse(b: BlockCoord): BlockUse | null {
  return BLOCKS.find((x) => x.bx === b.bx && x.bz === b.bz)?.use ?? null;
}

/** Downtown build blocks, in the order they open (ids are stable save keys). The same in every world. */
export const BUILD_BLOCK_COORDS: readonly (BlockCoord & { id: string; name: string })[] = [
  { id: 'market', name: 'Embarcadero', bx: 1, bz: 0 },
  { id: 'arcade', name: 'North Beach', bx: 0, bz: 1 },
  { id: 'techpark', name: 'SoMa', bx: 1, bz: -2 },
  { id: 'midtown', name: 'Union Square', bx: -1, bz: 0 },
  { id: 'skyline', name: 'Financial District', bx: 0, bz: -1 },
  { id: 'financial', name: 'Rincon Hill', bx: 1, bz: -3 },
  { id: 'megacorp', name: 'Nob Hill', bx: -1, bz: -1 },
  { id: 'moonshot', name: 'Transbay', bx: 0, bz: -3 },
];

const isBuild = (b: BlockCoord) => BUILD_BLOCK_COORDS.some((x) => x.bx === b.bx && x.bz === b.bz);

/** How many residential blocks every world has: the same housing for every founder. */
export const NEIGHBOURHOOD_COUNT = 34;

/** Residential blocks, nearest downtown first. */
export let NEIGHBOURHOOD_BLOCKS: readonly BlockCoord[];

/** A park: its blocks (joined across the streets between them), and what kind it is. */
export interface Park {
  kind: 'park' | 'square';
  blocks: BlockCoord[];
  name: string;
}

/** The city's parks: the big one first, then the squares. */
export let PARKS: readonly Park[];

/** The Presidio Parkway meets the grid here, mid-block on a north-south street. */
export let PKWY_JOIN: Pt;

/** Is (x, z) inside a block or on the road ring of one that's part of the city plan? */
function cityFlatness(x: number, z: number): number {
  // Far outside the grid, the distance to its bounding box is close enough.
  const ox = Math.max(0, GRID.bx0 * PITCH - 2.6 - x, x - GRID.bx1 * PITCH - 2.6);
  const oz = Math.max(0, GRID.bz0 * PITCH - 2.6 - z, z - GRID.bz1 * PITCH - 2.6);
  if (ox > 14 || oz > 14) return len2(ox, oz);
  let d2 = Infinity;
  for (const c of FLAT_CENTRES) {
    const dx = Math.max(0, Math.abs(x - c[0]) - 2.6);
    const dz = Math.max(0, Math.abs(z - c[1]) - 2.6);
    const e = dx * dx + dz * dz;
    if (e < d2) d2 = e;
  }
  return Math.sqrt(d2);
}

/** Centres of the blocks the city levels (every block but the hill ones). */
let FLAT_CENTRES: readonly Pt[] = [];

/** Like `cityFlatness`, but rounded in the grid's inside corners, so slopes rising from the city have no creases. */
function softCityDistance(x: number, z: number): number {
  let sum = 0;
  const k = 1.2;
  for (const c of FLAT_CENTRES) {
    const dx = Math.max(0, Math.abs(x - c[0]) - 2.6);
    const dz = Math.max(0, Math.abs(z - c[1]) - 2.6);
    if (dx > 12 || dz > 12) continue;
    const d = len2(dx, dz);
    if (d < 12) sum += Math.exp(-d / k);
  }
  return sum > 0 ? Math.max(0, -k * Math.log(sum)) : 12;
}

// ─── Terrain ───────────────────────────────────────────────────────────────

/** Water level; land at 0 is the city's ground. */
export const SEA = -0.55;

// Value noise: smooth, deterministic, cheap. Used for the ruggedness of the hills.
function hash2(ix: number, iz: number): number {
  let h = Math.imul(ix | 0, 374761393) + Math.imul(iz | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
}
/** Fractal noise in −1..1. */
export function fbm(x: number, z: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += noise(x, z) * amp;
    norm += amp;
    amp *= 0.5;
    const nx = x * 1.6 - z * 1.2 + 3.1;
    z = x * 1.2 + z * 1.6 - 1.7;
    x = nx;
  }
  return sum / norm;
}
/** Ridged noise in 0..1: sharp crests and soft valleys, for rocky ridgelines and gullies. */
function ridged(x: number, z: number, octaves = 3): number {
  let sum = 0;
  let amp = 0.55;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(noise(x, z));
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    const nx = x * 1.7 - z * 1.1 + 5.3;
    z = x * 1.1 + z * 1.7 + 2.9;
    x = nx;
  }
  return sum / norm;
}

/** Distance from (x, z) to segment a–b, and how far along it (0..1). */
function segment(x: number, z: number, ax: number, az: number, bx: number, bz: number): { d: number; t: number } {
  const ex = bx - ax;
  const ez = bz - az;
  const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
  return { d: len2(x - ax - ex * t, z - az - ez * t), t };
}

/**
 * Twin Peaks: two grassy summits with rocky crowns on a shared massif. The
 * long north-east face drops to the city in spurs and ravines; TinyTown
 * Hills climbs it, and the sign sits on it below the saddle.
 */
export let TWIN_PEAKS_SUMMITS: readonly { x: number; z: number; h: number }[];

function peak(x: number, z: number, px: number, pz: number, h: number, face: number): number {
  const dx = x - px;
  const dz = z - pz;
  // u along the ridge (north-west to south-east), v down the face toward the city (north-east).
  const u = (dx - dz) * Math.SQRT1_2;
  const v = (dx + dz) * Math.SQRT1_2;
  const e = Math.sqrt((u / 9) ** 2 + (v / (v > 0 ? face : 10)) ** 2 + 0.002);
  return e >= 1 ? 0 : h * (1 - e) ** 1.3;
}

function twinPeaks(x: number, z: number): number {
  const P = WORLD_SPEC.peaks;
  const S = TWIN_PEAKS_SUMMITS;
  let h = peak(x, z, S[0]!.x, S[0]!.z, S[0]!.h, P.face);
  for (let i = 1; i < S.length; i++) h = smoothMax(h, peak(x, z, S[i]!.x, S[i]!.z, S[i]!.h, P.face), 1.2);
  // The foothills: a steady apron rising from the edge of the city grid, so the lowest Hills
  // streets run parallel to the grid and curve where it steps, then climb into the peaks.
  const cx = P.centre.x + 14;
  const cz = P.centre.z + 36;
  const apron = Math.min(softCityDistance(x, z) * 0.42, 3.4) * smooth(-20.5 + cz, -23.5 + cz, z) * smooth(8 + cx, 3 + cx, x) * smooth(-48 + cz, -40 + cz, z);
  h = smoothMax(h, apron, 1.0);
  // Mount Sutro (forested) to the west and Mount Davidson to the south-east.
  h += (P.sutro ? bump(x, z, P.sutro[0], P.sutro[1], P.sutro[2], P.sutro[3]) : 0) + (P.davidson ? bump(x, z, P.davidson[0], P.davidson[1], P.davidson[2], P.davidson[3]) : 0);
  // Rocky crowns and ribs on the upper slopes; the lower face stays smooth enough to build on.
  const high = smooth(5, 9, h);
  h += high * (ridged(x * 0.45, z * 0.45) - 0.45) * 1.1;
  return h;
}

/** Hills of the mainland, Marin and the East Bay, before the city is levelled into them. */
function relief(x: number, z: number): number {
  // Telegraph Hill, the Presidio and Lands End: gentle, inside the city.
  let near = 0;
  for (const b of WORLD_SPEC.cityBumps) near += bump(x, z, b[0], b[1], b[2], b[3]);
  let h = near + twinPeaks(x, z);
  // The backdrop: San Bruno Mountain and the south, the Marin Headlands, the East Bay hills.
  let far = 0;
  for (const b of WORLD_SPEC.farBumps) far += bump(x, z, b[0], b[1], b[2], b[3]);
  // Ridges and gullies, stronger the higher the ground: the lowlands stay gentle for towns.
  const rugged = smooth(1.5, 7, far) * (1 - 0.85 * townCalm(x, z));
  h += far + rugged * (ridged(x * 0.11, z * 0.11) - 0.45) * (1.2 + far * 0.35) + fbm(x * 0.07, z * 0.07, 3) * 0.6 * smooth(0.5, 3, far) * (1 - 0.7 * townCalm(x, z));
  return h;
}

/** Where the towns stand the ground is calmer: no crags under the streets. 0 outside, 1 well inside. */
function townCalm(x: number, z: number): number {
  let k = 0;
  for (const [x0, x1, z0, z1] of TOWN_GROUND) {
    const d = Math.max(x0 - x, x - x1, z0 - z, z - z1);
    if (d < 2) k = Math.max(k, 1 - smooth(-2, 2, d));
  }
  return k;
}

/** The ground under each backdrop town (x0, x1, z0, z1), calmed so its streets can follow the contours. */
export let TOWN_GROUND: readonly [number, number, number, number][];
const CLASSIC_TOWN_GROUND: readonly [number, number, number, number][] = [
  [-32, 4.5, -61, -45.5],
  [-61, -42, -67, -41],
  [-32, -22.5, 22, 33],
  [60, 75, -45, 37],
  [56, 67, -67, 39],
];
/** Which town each patch of calm ground belongs to (it moves with it). */
const TOWN_GROUND_OF = ['excelsior', 'westlake', 'sausalito', 'east', 'flats'] as const;

/** Height of an island at (x, z), `depth` inland from its coast. */
function islandHeight(id: IslandId, x: number, z: number, depth: number): number {
  switch (id) {
    case 'founder': {
      // A low plateau for the estate, rocky knolls to the north-west where the lighthouse stands.
      const isl = ISLANDS.founder;
      // Low dunes and lawns: a quick rise from the strand, then the plateau.
      let h = isl.h * smooth(0, 1.3, depth) + 0.06 * fbm(x * 0.9, z * 0.9, 2);
      const [k1, k2] = WORLD_SPEC.estate.knolls as [Bump, Bump];
      h += bump(x, z, isl.x + k1[0], isl.z + k1[1], k1[2], k1[3]) + bump(x, z, isl.x + k2[0], isl.z + k2[1], k2[2], k2[3]);
      h += smooth(0.3, 1.2, depth) * Math.max(0, ridged(x * 0.8, z * 0.8) - 0.55) * 0.5 * (1 - smooth(1.5, 3.2, len2(x - isl.x, z - isl.z)));
      return h;
    }
    case 'launch':
      return ISLANDS.launch.h * smooth(0, 0.9, depth);
    case 'treasure':
      // Landfill behind a seawall: flat right to the edge.
      return 0.28 * smooth(0, 0.3, depth);
    case 'yerba': {
      // A rounded, wooded hill: a dome over the middle with spurs down to the shore, steep where
      // it meets the water, and high enough over the Bay Bridge tunnel (z −6.5).
      const dx = (x - 33.2) / 4.1;
      const dz = (z + 6.75) / 3.3;
      const dome = 4.5 * (1 - Math.min(1, dx * dx + dz * dz) ** 1.6);
      const shore = 4.5 * (1 - (1 - Math.min(1, depth / 3.0)) ** 1.5);
      let h = Math.min(dome, shore) + 0.25 * fbm(x * 0.8, z * 0.8, 2);
      h += smooth(0.4, 1.4, depth) * (ridged(x * 0.9, z * 0.9) - 0.5) * 0.6;
      return h;
    }
    default: {
      // Angel Island: Mount Livermore with ridges falling to coves.
      const isl = ISLANDS.angel;
      const e = Math.min(1, len2(x - isl.x, z - isl.z) / (isl.r + 0.6));
      return isl.h * (1 - e) ** 1.25 * smooth(0, 1.5, depth) + smooth(0.5, 2, depth) * (ridged(x * 0.35, z * 0.35) - 0.45) * 1.6;
    }
  }
}

/** The ground before any grading: hills, flattened under the city and the airport; islands; the sea floor. */
export function naturalHeight(x: number, z: number): number {
  return natural(x, z);
}
function natural(x: number, z: number): number {
  const main = mainlandDistance(x, z);
  const fill = polygonDistance(AIRPORT_FILL, x, z);
  let coast = Math.min(main, fill);
  let island: IslandId | null = null;
  for (const id of ISLAND_IDS) {
    const isl = ISLANDS[id];
    if (len2(x - isl.x, z - isl.z) - isl.r - 3 > coast) continue;
    const d = islandDistance(id, x, z);
    if (d < coast) {
      coast = d;
      island = id;
    }
  }
  if (coast >= 0) {
    // Seawalls (the airport, Treasure Island) drop straight into deep water; natural shores shelve away.
    const wall = fill <= coast + 1e-6 || island === 'treasure';
    return wall ? SEA - 0.32 - Math.min(2.8, coast * 0.5) : SEA + 0.12 - Math.min(3, coast * 0.35);
  }
  let h = -Infinity;
  if (main < 0) {
    const flat = smooth(0.2, 2.6, cityFlatness(x, z)) * smooth(0, 3, Math.max(0, fill));
    let m = relief(x, z) * flat;
    // Gentle rolling everywhere outside the city.
    m += flat * 0.25 * (Math.sin(x * 0.31) * Math.cos(z * 0.27) + 0.5 * Math.sin(x * 0.7 + z * 0.5));
    if (!WORLD_SPEC.classic) {
      // The north waterfront's points and headlands stay low and smooth, so the shore road can run round them.
      if (z > 8.5 && x > WORLD_SPEC.gg.x + 2 && x < 10) m *= smooth(1.2, 4.5, -main);
    }
    // On land: ease down to a beach at the waterline.
    const shore = smooth(0, 2.2, -main);
    h = SEA + 0.12 + (Math.max(0, m) + (0 - SEA - 0.12)) * shore;
  }
  if (fill < 0) h = Math.max(h, SEA + 0.12 + (0 - SEA - 0.12) * smooth(0, 0.3, -fill));
  for (const id of ISLAND_IDS) {
    const isl = ISLANDS[id];
    if (id !== island && len2(x - isl.x, z - isl.z) - isl.r - 3 > 0) continue;
    const d = id === island ? coast : islandDistance(id, x, z);
    if (d < 0) h = Math.max(h, SEA + 0.12 + (islandHeight(id, x, z, -d) - SEA - 0.12) * smooth(0, id === 'treasure' || id === 'yerba' ? 0.3 : 0.9, -d));
  }
  // The Bay Bridge tunnel runs through Yerba Buena at z −6.5: at least 3.0 of rock over the deck between the portals.
  if (island === 'yerba' && x > 30.25 && x < 35.75) {
    const band = 1 - smooth(0.9, 1.6, Math.abs(z + 6.5));
    if (band > 0) h = Math.max(h, 3.05 + (h - 3.05) * (1 - band));
  }
  return h;
}

/** Level pads cut into the ground: [x, z, core radius, blend radius, height]. */
function pads(): readonly [number, number, number, number, number][] {
  return (PADS ??= [
    // Your Hills house: a level lot about 2.4 × 2.4, turned π/4.
    [HILLS_HOME.x, HILLS_HOME.z, 1.8, 2.7, natural(HILLS_HOME.x, HILLS_HOME.z)],
    // Your island estate: about 3 × 3, level with the plateau.
    [ISLANDS.founder.x, ISLANDS.founder.z, 2.3, 3.3, ISLANDS.founder.h],
    [ISLANDS.launch.x, ISLANDS.launch.z, 1.6, 2.2, ISLANDS.launch.h],
  ]);
}
let PADS: [number, number, number, number, number][] | null = null;

/**
 * Terrain height. The city is flat at 0; hills rise around it; beaches and
 * cliffs meet the bay; the sea floor drops away offshore. Roads and lots in
 * TinyTown Hills, and the founder's pads, are graded into the slope.
 */
export function terrainHeight(x: number, z: number): number {
  let h = natural(x, z);
  for (const [px, pz, core, blend, top] of pads()) {
    const d = len2(x - px, z - pz);
    if (d < blend) h = top + (h - top) * smooth(core, blend, d);
  }
  return gradeHills(x, z, h);
}

/** Beach (sand) rather than grass: low, close to the sea, not in the city, not behind a seawall. */
export function isBeach(x: number, z: number): boolean {
  const main = Math.min(mainlandDistance(x, z), polygonDistance(AIRPORT_FILL, x, z));
  if (polygonDistance(AIRPORT_FILL, x, z) < 0.6 || polygonDistance(TREASURE_COAST, x, z) < 0.6) return false;
  let island = Infinity;
  let rocky = false;
  for (const id of ISLAND_IDS) {
    const isl = ISLANDS[id];
    if (len2(x - isl.x, z - isl.z) - isl.r - 3 > Math.min(island, 2.5)) continue;
    const d = islandDistance(id, x, z);
    if (d < island) {
      island = d;
      rocky = id === 'yerba' || id === 'angel';
    }
  }
  if (island < main) {
    // Your island has a real beach in the cove and a strand around the south; Yerba Buena and Angel Island, rocky shores.
    const cove = len2(x - ISLAND_COVE.x, z - ISLAND_COVE.z) < ISLAND_COVE.r + 1.3;
    return island < 0 && island > -(cove ? 1.2 : rocky ? 0.25 : 0.35);
  }
  return main < 0 && main > -2.4 && cityFlatness(x, z) > 0.5;
}

// ─── Landmarks and sites ────────────────────────────────────────────────────

export interface Landmarks {
  ferryBuilding: { readonly x: number; readonly z: number };
  /** Telegraph Hill's top: Coit Tower stands here when the city has it (see `HAS`). */
  coitTower: { readonly x: number; readonly z: number };
  palaceOfFineArts: { readonly x: number; readonly z: number };
  sutroTower: { readonly x: number; readonly z: number };
  windmill: { readonly x: number; readonly z: number };
  conservatory: { readonly x: number; readonly z: number };
  cliffHouse: { readonly x: number; readonly z: number };
  /** Centre of the sign: tangent to the hill's contour, so the letters arch along the ridge. */
  sign: { readonly x: number; readonly z: number };
  goldenGate: { readonly x: number; readonly z0: number; readonly z1: number };
  bayBridge: { readonly z: number; readonly x0: number; readonly x1: number };
}

export let LANDMARKS: Landmarks;

/** Which of the optional landmarks this city has (the Ferry Building, City Hall, both bridges and the sign are in every one). */
export let HAS: Readonly<WorldSpec['has']>;

/** The pier with rides (Pier 39-ish), sticking out into the bay. */
export let PIER: { readonly x0: number; readonly x1: number; readonly z0: number; readonly z1: number };
/** The Marina: its basin's centre on the shore, and the Marina Green between the Embarcadero and the city. */
export let MARINA: { readonly x: number; readonly z: number; readonly green: { x: number; z: number; w: number; d: number } | null };
/** Yacht berths at the Marina. */
export let MARINA_SLOTS: readonly { x: number; z: number }[];
export let SUPERYACHT: { readonly x: number; readonly z: number };
/** The airport's helipad, north of the terminal: the founder's helicopter flies to the island from here. */
export const HELIPAD = { x: 21.9, z: -35.3 } as const;
/** SFO-ish, on fill by the bay to the south-east. Free for everyone. */
export const AIRPORT = { x0: 16, x1: 28, z0: -50, z1: -36 } as const;
export const AIRPORT_SLOTS = [-47, -44.4, -41.8, -39.2].map((z) => ({ x: 19.2, z }));
export const RUNWAY = { x: 25.2, z0: -49.5, z1: -36.5 } as const;
/** Founder lots: on the HQ block, on Twin Peaks, on your island. */
export const DOWNTOWN_HOME = { x: -1.5, z: 1.5 } as const;
export let HILLS_HOME: { readonly x: number; readonly z: number };
/** TinyTown Hills: the slope of Twin Peaks below the sign, facing the city. */
export let HILLS_HOOD: { readonly x0: number; readonly x1: number; readonly z0: number; readonly z1: number };

// ─── TinyTown Hills: the street plan ────────────────────────────────────────

export type HillsStreetKind = 'boulevard' | 'street' | 'track';

export interface HillsStreet {
  id: string;
  name: string;
  kind: HillsStreetKind;
  /** Width of the asphalt (or gravel). */
  w: number;
  /** Centreline samples about 0.3 apart: x, z and the graded road height. */
  pts: [number, number, number][];
  /** Ends in a turning circle. */
  cul: boolean;
}

export interface HillsLot {
  x: number;
  z: number;
  /** Top of the level pad. */
  y: number;
  /** House rotation: its +z (the view side) faces downhill. */
  rot: number;
  /** Pad size along the house's x and z. */
  w: number;
  d: number;
  /** The street it's on, and where its driveway meets the street's edge. */
  street: number;
  drive: [number, number, number];
  /** Lowest and highest natural ground around the pad: how tall its retaining walls are. */
  low: number;
  high: number;
}

export interface HillsPlan {
  streets: HillsStreet[];
  lots: HillsLot[];
  /** Your Hills house's lot: its driveway down to the street. */
  homeDrive: [number, number, number][];
}

type XZ = readonly [number, number];

const naturalGrad = (x: number, z: number): [number, number] => {
  const e = 0.05;
  return [(natural(x + e, z) - natural(x - e, z)) / (2 * e), (natural(x, z + e) - natural(x, z - e)) / (2 * e)];
};

/** Moves (x, z) onto the contour at height h. */
export function snapToContour(x: number, z: number, h: number): [number, number] {
  for (let i = 0; i < 6; i++) {
    const err = natural(x, z) - h;
    if (Math.abs(err) < 2e-4) break;
    const [gx, gz] = naturalGrad(x, z);
    const g2 = gx * gx + gz * gz;
    if (g2 < 1e-5) break;
    const f = Math.max(-0.5, Math.min(0.5, err / g2));
    x -= f * gx;
    z -= f * gz;
  }
  return [x, z];
}

/** Follows the contour at height h from (x, z), keeping uphill on the left (dir 1) or right (−1). */
export function traceContour(x: number, z: number, h: number, dir: number, len: number, stop?: (x: number, z: number) => boolean): XZ[] {
  [x, z] = snapToContour(x, z, h);
  const out: XZ[] = [[x, z]];
  const step = 0.3;
  for (let s = 0; s < len; s += step) {
    const [gx, gz] = naturalGrad(x, z);
    const g = len2(gx, gz) || 1;
    const nx = x + (gz / g) * step * dir;
    const nz = z - (gx / g) * step * dir;
    [x, z] = snapToContour(nx, nz, h);
    if (stop?.(x, z)) break;
    out.push([x, z]);
  }
  return out;
}

/** A smooth curve through control points (Catmull–Rom), resampled about every `step`. */
function spline(ctrl: readonly XZ[], step = 0.3): XZ[] {
  const dense: XZ[] = [];
  const P = (i: number) => ctrl[Math.max(0, Math.min(ctrl.length - 1, i))]!;
  for (let i = 0; i < ctrl.length - 1; i++) {
    const [p0, p1, p2, p3] = [P(i - 1), P(i), P(i + 1), P(i + 2)];
    const n = Math.max(4, Math.ceil(len2(p2[0] - p1[0], p2[1] - p1[1]) / 0.05));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      dense.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  dense.push(ctrl.at(-1)!);
  return resample(dense, step);
}

/** Evenly spaced points along a polyline. */
function resample(pts: readonly XZ[], step: number): XZ[] {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += len2(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  const n = Math.max(1, Math.round(total / step));
  const out: XZ[] = [pts[0]!];
  let seg = 1;
  let acc = 0;
  for (let k = 1; k < n; k++) {
    const want = (k * total) / n;
    while (seg < pts.length - 1 && acc + len2(pts[seg]![0] - pts[seg - 1]![0], pts[seg]![1] - pts[seg - 1]![1]) < want) {
      acc += len2(pts[seg]![0] - pts[seg - 1]![0], pts[seg]![1] - pts[seg - 1]![1]);
      seg++;
    }
    const [ax, az] = pts[seg - 1]!;
    const [bx, bz] = pts[seg]!;
    const l = len2(bx - ax, bz - az) || 1;
    const t = Math.min(1, (want - acc) / l);
    out.push([ax + (bx - ax) * t, az + (bz - az) * t]);
  }
  out.push(pts.at(-1)!);
  return out;
}

/** Heights along a road that follows the ground, smoothed so it has no humps, pinned at its ends. */
function profile(pts: readonly XZ[], y0?: number, y1?: number): number[] {
  const raw = pts.map(([x, z]) => natural(x, z));
  if (y0 !== undefined) raw[0] = y0;
  if (y1 !== undefined) raw[raw.length - 1] = y1;
  let ys = raw.slice();
  for (let pass = 0; pass < 12; pass++) {
    const next = ys.slice();
    for (let i = 1; i < ys.length - 1; i++) next[i] = (ys[i - 1]! + ys[i]! * 2 + ys[i + 1]!) / 4;
    ys = next;
  }
  return ys;
}

/** A straight-graded link between two heights. */
function ramp(pts: readonly XZ[], y0: number, y1: number): number[] {
  let total = 0;
  const along = [0];
  for (let i = 1; i < pts.length; i++) along.push((total += len2(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1])));
  return along.map((a) => {
    const t = a / (total || 1);
    return y0 + (y1 - y0) * (t * t * (3 - 2 * t) * 0.35 + t * 0.65);
  });
}

/** In the TINYTOWN sign's patch of hillside (u along the letters, v downhill). */
export function inSignZone(x: number, z: number, margin = 0): boolean {
  const { x: sx, z: sz } = LANDMARKS.sign;
  const u = (x - sx - (z - sz)) * Math.SQRT1_2;
  const v = (x - sx + (z - sz)) * Math.SQRT1_2;
  return Math.abs(u) < 7.6 + margin && v > -2.3 - margin && v < 1.5 + margin;
}

let HILLS: HillsPlan | null = null;

/** TinyTown Hills: Twin Peaks Boulevard up from the end of Market, side streets along the contours, lots on terraces. */
export function hillsPlan(): HillsPlan {
  return (HILLS ??= WORLD_SPEC.classic ? buildHillsPlan() : buildSeededHillsPlan());
}

function buildHillsPlan(): HillsPlan {
  const streets: HillsStreet[] = [];
  const add = (id: string, name: string, kind: HillsStreetKind, w: number, pts: readonly XZ[], ys: number[], cul = false) => {
    streets.push({ id, name, kind, w, pts: pts.map(([x, z], i) => [x, z, ys[i]!]), cul });
    return streets.at(-1)!;
  };
  /** The sample on a street nearest (x, z). */
  const on = (pts: readonly (readonly [number, number, ...number[]])[], x: number, z: number): number => {
    let bi = 0;
    pts.forEach((p, i) => {
      if (len2(p[0] - x, p[1] - z) < len2(pts[bi]![0] - x, pts[bi]![1] - z)) bi = i;
    });
    return bi;
  };
  const flat = (pts: readonly XZ[], h: number) => pts.map(() => h);
  /** A link between two points on streets (or the grid), through control points, graded evenly. */
  const link = (id: string, name: string, from: readonly [number, number, number], via: readonly XZ[], to: readonly [number, number, number], w = 0.46) => {
    const pts = spline([[from[0], from[1]], ...via, [to[0], to[1]]]);
    return add(id, name, 'street', w, pts, ramp(pts, from[2], to[2]));
  };

  // Twin Peaks Boulevard: up from the end of Market to a crossroads with the two avenues that
  // run along the hill, on up to the Panorama Drive level, then west along it to Mount Sutro.
  const crossing: XZ = snapToContour(-16.9, -25.3, HILLS_LEVELS.avenue);
  const climb = spline([[MARKET_END[0], MARKET_END[1]], [-15.2, -24.4], crossing, [-18.4, -26.3], [-19.3, -27.5], [-19.7, -28.5]]);
  const top = snapToContour(-19.7, -28.5, HILLS_LEVELS.panorama);
  climb[climb.length - 1] = top;
  const ci = on(climb, crossing[0], crossing[1]);
  const climbYs = [...ramp(climb.slice(0, ci + 1), 0, HILLS_LEVELS.avenue), ...ramp(climb.slice(ci), HILLS_LEVELS.avenue, HILLS_LEVELS.panorama).slice(1)];
  const westward = traceContour(top[0], top[1], HILLS_LEVELS.panorama, 1, 16, (x) => x < -27.0);
  const blvd = [...climb, ...resample(westward, 0.3).slice(1)];
  add('blvd', 'Twin Peaks Boulevard', 'boulevard', 0.54, blvd, [...climbYs, ...flat(westward, HILLS_LEVELS.panorama).slice(1)], true);

  // Mountain Spring Avenue: east from the crossroads below the sign, past your lot, round the
  // south-east slope and down to the grid at Portola.
  const east = traceContour(crossing[0], crossing[1], HILLS_LEVELS.avenue, -1, 40, (x, z) => x > 5.2 || z < -40);
  const eastEnd = east.at(-1)!;
  const e1 = add('e1', 'Mountain Spring Avenue', 'street', 0.46, resample(east, 0.3), flat(resample(east, 0.3), HILLS_LEVELS.avenue));
  const down = spline([[eastEnd[0], eastEnd[1]], [6.4, -38.4], [7.4, -36.2], [7.5, -34.0], [7.5, -33.0]]);
  add('e1-down', 'Mountain Spring Avenue', 'street', 0.46, down, ramp(down, HILLS_LEVELS.avenue, 0));

  // Clarendon Avenue: west from the crossroads, down to the grid at the Sunset.
  const west = traceContour(crossing[0], crossing[1], HILLS_LEVELS.avenue, 1, 16, (x, z) => x < -25.2 || z < -28.6);
  add('w1', 'Clarendon Avenue', 'street', 0.46, resample(west, 0.3), flat(resample(west, 0.3), HILLS_LEVELS.avenue));
  const wEnd = west.at(-1)!;
  // Down to the edge of the grid's junction at (−27.5, −27.5), level for its last stretch.
  const wdown = spline([[wEnd[0], wEnd[1]], [-25.6, -28.1], [-26.4, -27.6], [-27.0, -27.5]]);
  add('w1-down', 'Clarendon Avenue', 'street', 0.46, wdown, ramp(wdown, HILLS_LEVELS.avenue, 0));

  // Short steep streets up from the grid, as in San Francisco.
  const w1 = streets.find((x) => x.id === 'w1')!;
  const e1s = e1.pts;
  const toW = w1.pts[on(w1.pts, -22.5, -26)]!;
  link('c-22', 'Stanyan Street', [-22.5, -23.0, 0], [[-22.5, -24.4]], toW);
  const toE = e1s[on(e1s, -7.5, -26)]!;
  link('c-7', 'Clayton Street', [-7.5, -23.0, 0], [[-7.5, -24.4]], toE);
  const toE2 = e1s[on(e1s, -0.4, -31.9)]!;
  link('c-2', 'Corbett Avenue', [-2.5, -28.0, 0], [[-2.0, -29.2], [-1.1, -30.6]], toE2);

  // Upper Terrace: a hairpin up from Panorama Drive, back east toward the sign, ending in a turning circle.
  const pano = streets[0]!.pts;
  const hp = pano[on(pano, -23.6, -29.6)]!;
  const upper = snapToContour(-22.2, -31.0, HILLS_LEVELS.upper);
  const terrace = traceContour(upper[0], upper[1], HILLS_LEVELS.upper, -1, 8, (x, z) => inSignZone(x, z, 1.4) || x > -16.4);
  link('hairpin-w', 'Upper Terrace', hp, [[-24.8, -30.4], [-24.4, -31.2]], [upper[0], upper[1], HILLS_LEVELS.upper]);
  add('upper', 'Upper Terrace', 'street', 0.44, resample(terrace, 0.3), flat(resample(terrace, 0.3), HILLS_LEVELS.upper), true);

  // Glenview Drive: a hairpin up from Mountain Spring on the south-east slope, then along the hill both ways.
  const from = e1s[on(e1s, 3.6, -36.3)]!;
  const glen = snapToContour(-0.2, -37.4, HILLS_LEVELS.glen);
  link('hairpin-e', 'Glenview Drive', from, [[2.4, -37.2], [1.0, -37.6]], [glen[0], glen[1], HILLS_LEVELS.glen]);
  const glenS = traceContour(glen[0], glen[1], HILLS_LEVELS.glen, -1, 10, (x, z) => z < -45 || x > 5.5);
  add('glen-s', 'Glenview Drive', 'street', 0.44, resample(glenS, 0.3), flat(resample(glenS, 0.3), HILLS_LEVELS.glen), true);
  const glenN = traceContour(glen[0], glen[1], HILLS_LEVELS.glen, 1, 8, (x, z) => inSignZone(x, z, 1.4) || len2(x - HILLS_HOME.x, z - HILLS_HOME.z) < 3.2);
  add('glen-n', 'Glenview Drive', 'street', 0.44, resample(glenN, 0.3), flat(resample(glenN, 0.3), HILLS_LEVELS.glen), true);

  // The sign's service road: gravel, along the slope just above the letters.
  const { x: sx, z: sz } = LANDMARKS.sign;
  const uv = (u: number, v: number): XZ => [sx + (u + v) * Math.SQRT1_2, sz + (v - u) * Math.SQRT1_2];
  const terraceEnd = streets.find((x) => x.id === 'upper')!.pts.at(-1)!;
  const track = spline([[terraceEnd[0], terraceEnd[1]], uv(-6.4, -3.1), uv(-3, -3.0), uv(0, -2.9), uv(3, -2.9), uv(5.4, -2.7)]);
  add('track', 'Sign service road', 'track', 0.3, track, profile(track, terraceEnd[2]));
  return finishPlan(streets);
}

/** The heights the Hills streets hold along their contours. */
let HILLS_LEVELS: WorldSpec['levels'];

/** Across the ridge (north-west to south-east) and down the face of the peaks (toward the city). */
const RIDGE_U: XZ = [Math.SQRT1_2, -Math.SQRT1_2];
const FACE_V: XZ = [Math.SQRT1_2, Math.SQRT1_2];

/**
 * TinyTown Hills for any world, following the same recipe as the classic
 * plan: Twin Peaks Boulevard climbs from the end of Market to a crossroads
 * with the avenue that runs along the hill at one height, on up to the
 * panorama level and along it to a turning circle. Short steep streets come
 * up to the avenue from the grid, wherever a city street meets the hill;
 * hairpins reach higher terraces; your lot sits just below the sign.
 */
function buildSeededHillsPlan(): HillsPlan {
  const L = HILLS_LEVELS;
  const C = WORLD_SPEC.peaks.centre;
  const streets: HillsStreet[] = [];
  const add = (id: string, name: string, kind: HillsStreetKind, w: number, pts: readonly XZ[], ys: number[], cul = false) => {
    streets.push({ id, name, kind, w, pts: pts.map(([x, z], i) => [x, z, ys[i]!]), cul });
    return streets.at(-1)!;
  };
  const flat = (pts: readonly XZ[], h: number) => pts.map(() => h);
  /** Onto the contour, firmly: tracing a contour starts by snapping again, and the two must agree. */
  const settle = (x: number, z: number, h: number): [number, number] => {
    for (let i = 0; i < 4; i++) [x, z] = snapToContour(x, z, h);
    return [x, z];
  };
  const uv = (x: number, z: number) => [(x - C.x) * RIDGE_U[0] + (z - C.z) * RIDGE_U[1], (x - C.x) * FACE_V[0] + (z - C.z) * FACE_V[1]] as const;
  const uphill = (x: number, z: number): XZ => {
    const [gx, gz] = naturalGrad(x, z);
    const g = len2(gx, gz) || 1;
    return [gx / g, gz / g];
  };
  /** How close (x, z) comes to the asphalt of any street so far, skipping `skip`. */
  const clearance = (x: number, z: number, skip?: HillsStreet) => {
    let best = Infinity;
    for (const st of streets) {
      if (st === skip) continue;
      for (const p of st.pts) best = Math.min(best, len2(p[0] - x, p[1] - z) - st.w / 2);
    }
    return best;
  };
  const xMin = GRID.bx0 * PITCH + 9.8;
  const xMax = GRID.bx1 * PITCH + 0.2;
  /** Where a contour street must stop: off the hill, round the back of the peaks, too near the grid, the coast or the sign. */
  const offHill = (x: number, z: number, sign = 1.2) => {
    const [, v] = uv(x, z);
    return x < xMin || x > xMax || v < -2.5 || z < C.z - 6 || coastDistance(x, z) > -2 || cityFlatness(x, z) < 1.0 || inSignZone(x, z, sign);
  };
  /** Climb straight up the slope from (x, z) until the ground reaches height h. */
  const ascend = (x: number, z: number, h: number): XZ => {
    for (let i = 0; i < 600 && natural(x, z) < h; i++) {
      const [ux, uz] = uphill(x, z);
      x += ux * 0.08;
      z += uz * 0.08;
    }
    return settle(x, z, h);
  };

  // Twin Peaks Boulevard: up from the end of Market to the crossroads on the avenue, then on up,
  // bearing away from the sign, to the panorama level, and along it to a turning circle.
  const [mx, mz] = MARKET_END;
  const crossing = ascend(mx - 0.6, mz - 0.6, L.avenue);
  // Along the hill, away from the sign: dir 1 heads north-west (uphill on the left), −1 south-east.
  const away = uv(crossing[0], crossing[1])[0] < uv(LANDMARKS.sign.x, LANDMARKS.sign.z)[0] ? 1 : -1;
  const along = (x: number, z: number, dir: number): XZ => {
    const [ux, uz] = uphill(x, z);
    return [uz * dir, -ux * dir];
  };
  const [ax, az] = along(crossing[0], crossing[1], away);
  const [ux0, uz0] = uphill(crossing[0], crossing[1]);
  const top = settle(crossing[0] + ax * 2.6 + ux0 * 1.4, crossing[1] + az * 2.6 + uz0 * 1.4, L.panorama);
  const lead: XZ = [mx + (crossing[0] - mx) * 0.5 - ax * 0.3, mz + (crossing[1] - mz) * 0.5 - az * 0.3];
  const climb = spline([[mx, mz], lead, crossing, [(crossing[0] + top[0]) / 2 + ux0 * 0.2, (crossing[1] + top[1]) / 2 + uz0 * 0.2], top]);
  let ci = 0;
  climb.forEach((p, i) => {
    if (len2(p[0] - crossing[0], p[1] - crossing[1]) < len2(climb[ci]![0] - crossing[0], climb[ci]![1] - crossing[1])) ci = i;
  });
  const climbYs = [...ramp(climb.slice(0, ci + 1), 0, L.avenue), ...ramp(climb.slice(ci), L.avenue, L.panorama).slice(1)];
  const panoLen = 9 + (WORLD_SPEC.seed % 7);
  const pano = traceContour(top[0], top[1], L.panorama, away, panoLen, (x, z) => offHill(x, z, 1.4) || clearance(x, z) < 0.9);
  const blvd = add('blvd', 'Twin Peaks Boulevard', 'boulevard', 0.54, [...climb, ...resample(pano, 0.3).slice(1)], [...climbYs, ...flat(resample(pano, 0.3), L.panorama).slice(1)], true);

  // The avenue: both ways from the crossroads along the hill at one height.
  const avenues: HillsStreet[] = [];
  for (const dir of [away, -away]) {
    const line = traceContour(crossing[0], crossing[1], L.avenue, dir, dir === away ? 22 : 40, (x, z) => offHill(x, z, 0.3));
    if (line.length < 8) continue;
    const pts = resample(line, 0.3);
    avenues.push(add(dir > 0 ? 'w1' : 'e1', dir > 0 ? 'Clarendon Avenue' : 'Mountain Spring Avenue', 'street', 0.46, pts, flat(pts, L.avenue)));
  }

  // Steep streets up from the grid: wherever a city street runs into the hill, carry it on up to the avenue.
  const stubs = gridStubs();
  const used: XZ[] = [];
  const tryLink = (id: string, name: string, J: XZ, d: XZ, target: readonly [number, number, number]) => {
    const start: XZ = [J[0] + d[0] * 0.5, J[1] + d[1] * 0.5];
    const knee: XZ = [J[0] + d[0] * 1.9, J[1] + d[1] * 1.9];
    const pts = spline([start, knee, [target[0], target[1]]]);
    // Never across another street (but for its ends), never through a block.
    for (let i = 0; i < pts.length; i++) {
      const [x, z] = pts[i]!;
      if (i > 3 && i < pts.length - 3 && clearance(x, z) < 0.55) return null;
      if (i > 2 && cityFlatness(x, z) < 0.35) return null;
      if (coastDistance(x, z) > -1) return null;
    }
    return add(id, name, 'street', 0.46, pts, ramp(pts, 0, target[2]));
  };
  const names = ['Stanyan Street', 'Clayton Street', 'Corbett Avenue', 'Burnett Avenue', 'Palo Alto Avenue', 'Crestline Drive'];
  let li = 0;
  for (const av of avenues) {
    // Candidate links: each stub to its nearest point on this avenue, if it's a reasonable climb.
    const cands: { J: XZ; d: XZ; at: number; len: number }[] = [];
    for (const { J, d } of stubs) {
      let bi = -1;
      let bd = Infinity;
      av.pts.forEach((p, i) => {
        const dx = p[0] - J[0];
        const dz = p[1] - J[1];
        const ahead = dx * d[0] + dz * d[1];
        const dist = len2(dx, dz);
        if (ahead > 1.6 && dist < bd) {
          bd = dist;
          bi = i;
        }
      });
      if (bi < 0 || bd < 2.4 || bd > 7 || L.avenue / bd > 0.5) continue;
      cands.push({ J, d, at: bi, len: bd });
    }
    // The far end first (a street down to the grid instead of a dead end), then the rest, spaced out.
    cands.sort((a, b) => b.at - a.at || a.len - b.len);
    let endLinked = false;
    for (const c of cands) {
      if (used.some(([x, z]) => len2(x - c.J[0], z - c.J[1]) < 0.1)) continue;
      const p = av.pts[c.at]!;
      if (used.some(([x, z]) => len2(x - p[0], z - p[1]) < 5)) continue;
      if (len2(p[0] - crossing[0], p[1] - crossing[1]) < 3.5) continue;
      const link = tryLink(`c-${li}`, names[li % names.length]!, c.J, c.d, p);
      if (!link) continue;
      li++;
      used.push(c.J, [p[0], p[1]]);
      if (c.at > av.pts.length - 8) endLinked = true;
      if (li >= 5) break;
    }
    if (!endLinked) av.cul = true;
  }

  // Your lot, just below the sign: level ground, clear of the streets, with a view over the city.
  HILLS_HOME = chooseHillsHome(avenues.length ? avenues : [blvd], uphill, clearance);

  // Upper Terrace: a hairpin up from the panorama level, back toward the sign, ending in a turning circle.
  if (WORLD_SPEC.hillStreets.upper && pano.length > 14) {
    const from = blvd.pts[blvd.pts.length - Math.floor(pano.length * 0.45)]!;
    const [fx, fz] = along(from[0], from[1], away);
    const [ux, uz] = uphill(from[0], from[1]);
    const upper = settle(from[0] + fx * 1.3 + ux * 2.2, from[1] + fz * 1.3 + uz * 2.2, L.upper);
    if (!offHill(upper[0], upper[1], 1.4) && clearance(upper[0], upper[1]) > 0.9) {
      const hp = link2(from, upper, L.upper, [from[0] + fx * 1.4 + ux * 0.5, from[1] + fz * 1.4 + uz * 0.5], blvd);
      const terrace = traceContour(upper[0], upper[1], L.upper, -away, 8, (x, z) => offHill(x, z, 1.4) || clearance(x, z) < 1.0 || len2(x - HILLS_HOME.x, z - HILLS_HOME.z) < 3.2);
      if (hp && terrace.length > 8) {
        add('hairpin-w', 'Upper Terrace', 'street', 0.46, hp.pts, hp.ys);
        add('upper', 'Upper Terrace', 'street', 0.44, resample(terrace, 0.3), flat(resample(terrace, 0.3), L.upper), true);
      }
    }
  }

  // Glenview Drive: a hairpin up from the longer avenue, then along the hill both ways.
  const long = avenues.reduce<HillsStreet | null>((a, b) => (!a || b.pts.length > a.pts.length ? b : a), null);
  if (WORLD_SPEC.hillStreets.glen && long && long.pts.length > 40) {
    const from = long.pts[Math.floor(long.pts.length * 0.68)]!;
    const dir = long.id === 'e1' ? -1 : 1;
    const [fx, fz] = along(from[0], from[1], dir);
    const [ux, uz] = uphill(from[0], from[1]);
    const glen = settle(from[0] + fx * 1.6 + ux * 2.0, from[1] + fz * 1.6 + uz * 2.0, L.glen);
    if (!offHill(glen[0], glen[1]) && clearance(glen[0], glen[1]) > 1.2 && len2(glen[0] - HILLS_HOME.x, glen[1] - HILLS_HOME.z) > 3.4) {
      const hp = link2(from, glen, L.glen, [from[0] + fx * 1.6 + ux * 0.6, from[1] + fz * 1.6 + uz * 0.6], long);
        const stop = (x: number, z: number) => offHill(x, z, 1.4) || clearance(x, z) < 1.0 || len2(x - HILLS_HOME.x, z - HILLS_HOME.z) < 3.2;
      const lines = ([['glen-s', dir], ['glen-n', -dir]] as const).map(([k, d]) => [k, traceContour(glen[0], glen[1], L.glen, d, 9, stop)] as const).filter(([, line]) => line.length > 6);
      if (hp && lines.length) {
        add('hairpin-e', 'Glenview Drive', 'street', 0.46, hp.pts, hp.ys);
        for (const [k, line] of lines) add(k, 'Glenview Drive', 'street', 0.44, resample(line, 0.3), flat(resample(line, 0.3), L.glen), true);
      }
    }
  }

  // The sign's service road: gravel along the slope just above the letters, from the nearest street end.
  const { x: sx, z: sz } = LANDMARKS.sign;
  const suv = (u: number, v: number): XZ => [sx + (u + v) * Math.SQRT1_2, sz + (v - u) * Math.SQRT1_2];
  let best: [number, number, number] | null = null;
  let bd = 3.2;
  for (const st of streets) {
    if (!st.cul) continue;
    const e = st.pts.at(-1)!;
    for (const u of [-6.4, 6.4]) {
      const [tx, tz] = suv(u, -3.1);
      const d = len2(e[0] - tx, e[1] - tz);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
  }
  if (best) {
    const e = best;
    const u0 = uv(e[0], e[1])[0] - uv(sx, sz)[0] < 0 ? -1 : 1;
    const track = spline([[e[0], e[1]], suv(6.4 * u0, -3.1), suv(3 * u0, -3.0), suv(0, -2.9), suv(-3 * u0, -2.9), suv(-5.4 * u0, -2.7)]);
    add('track', 'Sign service road', 'track', 0.3, track, profile(track, e[2]));
  }
  const plan = finishPlan(streets);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const l of plan.lots) {
    x0 = Math.min(x0, l.x);
    x1 = Math.max(x1, l.x);
    z0 = Math.min(z0, l.z);
    z1 = Math.max(z1, l.z);
  }
  HILLS_HOOD = { x0, x1, z0, z1 };
  return plan;

  /** A hairpin link from a point on a street up to a contour, through a control point. */
  function link2(from: readonly [number, number, number], to: XZ, h: number, via: XZ, source: HillsStreet): { pts: XZ[]; ys: number[] } | null {
    const pts = spline([[from[0], from[1]], via, to]);
    for (let i = 4; i < pts.length - 2; i++) if (clearance(pts[i]![0], pts[i]![1], source) < 0.5 || offHill(pts[i]![0], pts[i]![1], 1.4)) return null;
    return { pts, ys: ramp(pts, from[2], h) };
  }
}

/**
 * Where city streets run into the hills: a junction on the edge of the street
 * grid, and the way the street would carry on (no road there yet, and hill
 * or open ground beyond, not a park, the Presidio or the sea).
 */
function gridStubs(): { J: XZ; d: XZ }[] {
  const street = new Set(BLOCKS.filter((b) => b.use === 'city' || b.use === 'market' || b.use === 'hq' || b.use === 'civic').map((b) => `${b.bx},${b.bz}`));
  const any = new Set(BLOCKS.filter((b) => b.use !== 'hill').map((b) => `${b.bx},${b.bz}`));
  const isStreet = (bx: number, bz: number) => street.has(`${bx},${bz}`);
  const out: { J: XZ; d: XZ }[] = [];
  for (let i = GRID.bx0 - 1; i <= GRID.bx1; i++) {
    for (let j = GRID.bz0 - 1; j <= GRID.bz1; j++) {
      // The junction at the corner shared by blocks (i, j), (i+1, j), (i, j+1), (i+1, j+1).
      if (!isStreet(i, j) && !isStreet(i + 1, j) && !isStreet(i, j + 1) && !isStreet(i + 1, j + 1)) continue;
      const J: XZ = [i * PITCH + 2.5, j * PITCH + 2.5];
      // The four ways out, each with the two blocks that would flank it.
      const ways: [XZ, [number, number], [number, number]][] = [
        [[1, 0], [i + 1, j], [i + 1, j + 1]],
        [[-1, 0], [i, j], [i, j + 1]],
        [[0, 1], [i, j + 1], [i + 1, j + 1]],
        [[0, -1], [i, j], [i + 1, j]],
      ];
      for (const [d, a, b] of ways) {
        if (isStreet(...a) || isStreet(...b)) continue;
        // Beyond: hill blocks or open ground, never a park, the Presidio or another use.
        if (any.has(`${a[0]},${a[1]}`) || any.has(`${b[0]},${b[1]}`)) continue;
        const px = J[0] + d[0] * 2.5;
        const pz = J[1] + d[1] * 2.5;
        if (coastDistance(px, pz) > -1.5) continue;
        out.push({ J, d });
      }
    }
  }
  return out;
}

/** Your Hills lot: just below the sign, off the streets, on ground a terrace can level. */
function chooseHillsHome(avenues: HillsStreet[], uphill: (x: number, z: number) => XZ, clearance: (x: number, z: number) => number): { x: number; z: number } {
  const L = HILLS_LEVELS;
  const { x: sx, z: sz } = LANDMARKS.sign;
  // Classic: 2 along the ridge and 2.7 down the face from the sign's centre.
  const tx = sx + 2 * RIDGE_U[0] + 2.8 * FACE_V[0];
  const tz = sz + 2 * RIDGE_U[1] + 2.8 * FACE_V[1];
  let best = { x: tx, z: tz };
  let score = Infinity;
  for (const av of avenues) {
    for (let i = 3; i < av.pts.length - 3; i += 2) {
      const [px, pz] = av.pts[i]!;
      const [ux, uz] = uphill(px, pz);
      for (const off of [2.2, 2.6, 3.0]) {
        const x = px + ux * off;
        const z = pz + uz * off;
        const h = natural(x, z);
        if (h < L.avenue + 0.6 || h > L.panorama + 1.5) continue;
        if (inSignZone(x, z, 1.0) || clearance(x, z) < 2.0 || cityFlatness(x, z) < 3.1 || coastDistance(x, z) > -2.5) continue;
        const d = len2(x - tx, z - tz);
        if (d < score) {
          score = d;
          best = { x, z };
        }
      }
    }
  }
  return best;
}

/** Lots along every street, both sides, wherever a level terrace fits. */
function finishPlan(streets: HillsStreet[]): HillsPlan {
  const lots: HillsLot[] = [];
  const W = 1.12;
  const D = 1.0;
  // Every street segment (and turning circle), filed under the 1-unit cells within a unit of it, so
  // checking a lot's corners against the streets only looks at the streets nearby.
  const nearby = new Map<number, [number, number, number, number, number][]>();
  const file = (x0: number, x1: number, z0: number, z1: number, seg: [number, number, number, number, number]) => {
    for (let cx = Math.floor(x0 - 1); cx <= Math.floor(x1 + 1); cx++) {
      for (let cz = Math.floor(z0 - 1); cz <= Math.floor(z1 + 1); cz++) {
        const key = cx * 4096 + cz;
        const cell = nearby.get(key);
        if (cell) cell.push(seg);
        else nearby.set(key, [seg]);
      }
    }
  };
  for (const s of streets) {
    for (let i = 1; i < s.pts.length; i++) {
      const [ax, az] = s.pts[i - 1]!;
      const [bx, bz] = s.pts[i]!;
      file(Math.min(ax, bx), Math.max(ax, bx), Math.min(az, bz), Math.max(az, bz), [ax, az, bx, bz, s.w / 2]);
    }
    if (s.cul) {
      const [ex, ez] = s.pts.at(-1)!;
      file(ex, ex, ez, ez, [ex, ez, ex, ez, CUL_R]);
    }
  }
  /** Distance from (x, z) to the nearest street's edge, exact within a unit of the streets (beyond, at least a unit). */
  const streetDistance = (x: number, z: number) => {
    let best = 1;
    for (const [ax, az, bx, bz, r] of nearby.get(Math.floor(x) * 4096 + Math.floor(z)) ?? []) best = Math.min(best, segment(x, z, ax, az, bx, bz).d - r);
    return best;
  };
  streets.forEach((s, si) => {
    if (s.kind === 'track') return;
    const n = s.pts.length;
    for (let i = 4; i < n - (s.cul ? 2 : 4); i++) {
      const [px, pz, py] = s.pts[i]!;
      const [ax, az] = s.pts[i - 1]!;
      const [bx, bz] = s.pts[i + 1]!;
      const tl = len2(bx - ax, bz - az) || 1;
      const tx = (bx - ax) / tl;
      const tz = (bz - az) / tl;
      for (const side of [1, -1]) {
        const nx = -tz * side;
        const nz = tx * side;
        const off = s.w / 2 + 0.3 + D / 2;
        const x = px + nx * off;
        const z = pz + nz * off;
        // Spacing: never closer than a lot and a gap to any other lot.
        if (lots.some((l) => len2(l.x - x, l.z - z) < 1.42)) continue;
        // The house looks downhill: away from the street below it, over the street above it.
        const downhill = natural(x, z) < py;
        const fx = downhill ? nx : -nx;
        const fz = downhill ? nz : -nz;
        const rot = Math.atan2(fx, fz);
        const corner = (cx: number, cz: number): [number, number] => [x + cx * fz + cz * fx, z - cx * fx + cz * fz];
        const pts = [[-W / 2, -D / 2], [W / 2, -D / 2], [W / 2, D / 2], [-W / 2, D / 2], [0, D / 2], [0, -D / 2], [-W / 2, 0], [W / 2, 0]].map(([cx, cz]) => corner(cx!, cz!));
        if (!lotAllowed(x, z, pts)) continue;
        if (pts.some(([cx, cz]) => streetDistance(cx, cz) < 0.16)) continue;
        const ground = pts.slice(0, 4).map(([cx, cz]) => natural(cx, cz));
        const low = Math.min(...ground);
        const high = Math.max(...ground);
        const mean = ground.reduce((a, c) => a + c, 0) / 4;
        const y = Math.max(py - 0.42, Math.min(py + 0.42, mean + (downhill ? 0.04 : -0.06)));
        if (high - y > 0.85 || y - low > 0.85) continue;
        const dx = px + nx * (s.w / 2 - 0.02);
        const dz = pz + nz * (s.w / 2 - 0.02);
        lots.push({ x, z, y, rot, w: W, d: D, street: si, drive: [dx, dz, py], low, high });
      }
    }
  });
  // Your lot's driveway: from the pad's edge down to the nearest street.
  let near: [number, number, number] = [HILLS_HOME.x, HILLS_HOME.z, 0];
  let nd = Infinity;
  for (const s of streets) {
    if (s.kind === 'track') continue;
    for (const p of s.pts) {
      const d = len2(p[0] - HILLS_HOME.x, p[1] - HILLS_HOME.z);
      if (d < nd) {
        nd = d;
        near = p;
      }
    }
  }
  const home = pads()[0]![4];
  const ux = (near[0] - HILLS_HOME.x) / nd;
  const uz = (near[1] - HILLS_HOME.z) / nd;
  // From the edge of the level pad down to the street (scenery carries it on across the pad to the house).
  const homeDrive: [number, number, number][] = [
    [HILLS_HOME.x + ux * 1.85, HILLS_HOME.z + uz * 1.85, home],
    [near[0] - ux * 0.2, near[1] - uz * 0.2, near[2]],
  ];
  return { streets, lots, homeDrive };
}

// ─── The towns around the bay ──────────────────────────────────────────────

export interface TownLot {
  x: number;
  z: number;
  /** Top of the lot's level pad. */
  y: number;
  /** Facing: the house's front (local +z) looks at its street. */
  rot: number;
  /** A garden with a tree rather than a house. */
  empty: boolean;
}

export interface Town {
  id: string;
  name: string;
  style: 'stucco' | 'shingle';
  /** Street centrelines, at their graded heights. */
  streets: [number, number, number][][];
  lots: TownLot[];
  /** Street trees on the verges. */
  trees: [number, number, number][];
}

interface TownSpec {
  id: string;
  name: string;
  style: 'stucco' | 'shingle';
  inside: (x: number, z: number) => boolean;
  /** Contour towns: streets along the slope, `step` apart, walked uphill from each seed; cross streets every `cross`. */
  seeds?: readonly XZ[];
  step?: number;
  levels?: number;
  cross?: number;
  /** Grid towns (on the flats): long streets north-south `blockX` apart, cross streets `blockZ` apart. */
  grid?: { x0: number; x1: number; z0: number; z1: number; blockX: number; blockZ: number };
  /** Houses on both sides of each street, or only the downhill side (a waterfront hillside). */
  both: boolean;
  /** How much the ground may fall across a lot before it's left empty. */
  maxFall?: number;
}

/** Width of a town street, and the size of a town lot's level pad. */
export const TOWN_STREET = 0.34;
const TOWN_PAD = { w: 0.82, d: 0.74 } as const;

/** An organic town outline: an ellipse with a wobbling edge. */
const blob = (cx: number, cz: number, rx: number, rz: number, seed: number) => (x: number, z: number) => {
  const a = Math.atan2((z - cz) / rz, (x - cx) / rx);
  return len2((x - cx) / rx, (z - cz) / rz) < 1 + 0.12 * Math.sin(3 * a + seed) + 0.08 * Math.sin(5 * a + seed * 1.7);
};

/** The towns around the bay, each moved (and restyled) as this world says. */
function townSpecs(): TownSpec[] {
  const T = WORLD_SPEC.towns;
  const o = (id: string) => T[id] ?? { dx: 0, dz: 0 };
  const ex = o('excelsior');
  const wl = o('westlake');
  const sa = o('sausalito');
  const excelsior = blob(-20 + ex.dx, -52.5 + ex.dz, 11.5, 6.6, 1.1 + WORLD_SPEC.seed * 0.37);
  const westlake = blob(-51 + wl.dx, -54 + wl.dz, 8.5, 11, 2.3 + WORLD_SPEC.seed * 0.23);
  const shift = (pts: readonly XZ[], d: { dx: number; dz: number }) => pts.map(([x, z]) => [x + d.dx, z + d.dz] as XZ);
  return [
    {
      id: 'excelsior', name: 'The Excelsior', style: ex.style ?? 'stucco', both: true,
      inside: (x, z) => excelsior(x, z) && natural(x, z) < 5.2 && natural(x, z) > 0.4,
      seeds: shift([[-26.5, -51.2], [-19, -56.5], [-16.5, -48.5]], ex), step: 2.35, levels: 6, cross: 7.5,
    },
    {
      id: 'westlake', name: 'Westlake', style: wl.style ?? 'stucco', both: true,
      inside: (x, z) => westlake(x, z) && coastDistance(x, z) < -1.6,
      seeds: shift([[-51, -54]], wl), step: 2.35, levels: 6, cross: 7,
    },
    {
      id: 'sausalito', name: 'Sausalito', style: sa.style ?? 'shingle', both: false,
      inside: (x, z) => x > -31.5 + sa.dx && x < -23 + sa.dx && z > 22.4 + sa.dz && z < 32 + sa.dz && coastDistance(x, z) < -0.5,
      seeds: shift([[-26.4, 27.0]], sa), step: 1.5, levels: 5, cross: 0, maxFall: 1.3,
    },
    {
      id: 'oakland-hills', name: 'The Oakland hills', style: o('oakland-hills').style ?? 'stucco', both: true,
      inside: (x, z) => x > 61 && x < 74 && z > -44 && z < 34 && !(z > -12 && z < 2) && natural(x, z) < 6.4,
      seeds: [[62.5, -22]], step: 2.4, levels: 5, cross: 8,
    },
    {
      id: 'berkeley-hills', name: 'The Berkeley hills', style: o('berkeley-hills').style ?? 'shingle', both: true,
      inside: (x, z) => x > 61 && x < 74 && z > 4 && z < 36 && natural(x, z) < 6.4,
      seeds: [[62.2, 18]], step: 2.4, levels: 5, cross: 8,
    },
    {
      id: 'flats', name: 'Oakland', style: 'stucco', both: true,
      inside: (x, z) => coastDistance(x, z) < -0.9 && natural(x, z) < 2.6 && !(x < 66 && z > -11.5 && z < 0.5),
      grid: { x0: 57.4, x1: 66, z0: -66, z1: 38, blockX: 2.5, blockZ: 6 },
    },
  ];
}

let TOWNS: Town[] | null = null;

/** The towns around the bay: Daly City and the Excelsior, Westlake, Sausalito, Oakland and Berkeley. */
export function backdropTowns(): Town[] {
  return (TOWNS ??= townSpecs().map(buildTown));
}

function buildTown(spec: TownSpec): Town {
  const streets: [number, number, number][][] = [];
  const crosses: [number, number, number][][] = [];
  const withProfile = (pts: XZ[]) => {
    const ys = profile(pts);
    return pts.map(([x, z], i) => [x, z, ys[i]!] as [number, number, number]);
  };
  if (spec.grid) {
    const g = spec.grid;
    const runs = (pts: XZ[]) => {
      const out: XZ[][] = [];
      let cur: XZ[] = [];
      for (const p of pts) {
        if (spec.inside(p[0], p[1])) cur.push(p);
        else {
          if (cur.length > 4) out.push(cur);
          cur = [];
        }
      }
      if (cur.length > 4) out.push(cur);
      return out;
    };
    for (let x = g.x0; x <= g.x1; x += g.blockX) {
      const pts: XZ[] = [];
      for (let z = g.z0; z <= g.z1; z += 0.3) pts.push([x, z]);
      for (const run of runs(pts)) streets.push(withProfile(run));
    }
    for (let z = g.z0; z <= g.z1; z += g.blockZ) {
      const pts: XZ[] = [];
      for (let x = g.x0; x <= g.x1; x += 0.3) pts.push([x, z]);
      for (const run of runs(pts)) crosses.push(withProfile(run));
    }
  } else {
    const grad = naturalGrad;
    // Walk uphill from each seed, laying a street every `step` along the way (and at least 0.35 higher),
    // so the streets are evenly spaced with room for a lot on each side.
    const levels: [number, number, number][] = [];
    const taken = (x: number, z: number) => streets.some((line) => line.some(([px, pz]) => len2(px - x, pz - z) < spec.step! * 0.8));
    for (const seed of spec.seeds!) {
      let [x, z] = seed;
      let walked = spec.step!;
      let last = -Infinity;
      let count = 0;
      for (let i = 0; i < 1500 && count < spec.levels!; i++) {
        const h = natural(x, z);
        if (walked >= spec.step! && h > last + 0.35) {
          walked = 0;
          last = h;
          count++;
          if (!taken(x, z)) {
            levels.push([x, z, h]);
            const a = traceContour(x, z, h, 1, 40, (px, pz) => !spec.inside(px, pz));
            const c = traceContour(x, z, h, -1, 40, (px, pz) => !spec.inside(px, pz));
            const line = resample([...c.reverse(), ...a.slice(1)], 0.3);
            if (line.length > 12) streets.push(line.map(([px, pz]) => [px, pz, h]));
          }
        }
        const [gx, gz] = grad(x, z);
        const gl = len2(gx, gz);
        if (gl < 0.01 || !spec.inside(x, z)) break;
        x += (gx / gl) * 0.08;
        z += (gz / gl) * 0.08;
        walked += 0.08;
      }
    }
    // Cross streets: straight up the slope from the lowest street, through all the others.
    if (spec.cross && streets.length > 1) {
      const top = Math.max(...levels.map((l) => l[2]));
      const first = streets[0]!;
      for (let i = Math.floor(spec.cross / 0.6); i < first.length - 4; i += Math.floor(spec.cross / 0.3)) {
        let [cx, cz] = first[i]!;
        const line: XZ[] = [[cx, cz]];
        for (let k = 0; k < 200; k++) {
          const [gx, gz] = grad(cx, cz);
          const gl = len2(gx, gz);
          if (gl < 0.01) break;
          cx += (gx / gl) * 0.3;
          cz += (gz / gl) * 0.3;
          if (!spec.inside(cx, cz) || natural(cx, cz) > top + 0.05) break;
          line.push([cx, cz]);
        }
        if (line.length > 5) crosses.push(withProfile(line));
      }
    }
  }
  // Lots along the main streets, clear of every street.
  const all = [...streets, ...crosses];
  const cells = new Map<number, [number, number, number, number][]>();
  for (const line of all) {
    for (let i = 1; i < line.length; i++) {
      const [ax, az] = line[i - 1]!;
      const [bx, bz] = line[i]!;
      const key = Math.floor(ax / 2) * 4096 + Math.floor(az / 2);
      const cell = cells.get(key);
      if (cell) cell.push([ax, az, bx, bz]);
      else cells.set(key, [[ax, az, bx, bz]]);
    }
  }
  const clear = (x: number, z: number, d: number) => {
    const cx = Math.floor(x / 2);
    const cz = Math.floor(z / 2);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const [ax, az, bx, bz] of cells.get((cx + i) * 4096 + cz + j) ?? []) if (segment(x, z, ax, az, bx, bz).d < d) return false;
      }
    }
    return true;
  };
  const r = rngFor(WORLD_SPEC.classic ? spec.id : `${spec.id}|${WORLD_SPEC.seed}`);
  const lots: TownLot[] = [];
  const trees: [number, number, number][] = [];
  const near = new Map<number, XZ[]>();
  const crowded = (x: number, z: number) => {
    const key = Math.floor(x) * 4096 + Math.floor(z);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const [lx, lz] of near.get(key + i * 4096 + j) ?? []) if (len2(lx - x, lz - z) < 0.92) return true;
    return false;
  };
  for (const line of streets) {
    let carry = 0.5;
    for (let i = 1; i < line.length - 1; i++) {
      const [ax, az] = line[i - 1]!;
      const [px, pz, py] = line[i]!;
      const [qx, qz] = line[i + 1]!;
      carry += len2(px - ax, pz - az);
      if (carry < 1.0) continue;
      carry = 0;
      const tl = len2(qx - ax, qz - az) || 1;
      const tx = (qx - ax) / tl;
      const tz = (qz - az) / tl;
      const sides = spec.both ? [1, -1] : [natural(px - tz, pz + tx) < py ? 1 : -1];
      for (const side of sides) {
        const nx = -tz * side;
        const nz = tx * side;
        const x = px + nx * (TOWN_STREET / 2 + 0.5);
        const z = pz + nz * (TOWN_STREET / 2 + 0.5);
        if (!spec.inside(x, z) || coastDistance(x, z) > -0.4 || crowded(x, z)) continue;
        if (!clear(x, z, TOWN_STREET / 2 + 0.42)) continue;
        const ground = natural(x, z);
        const fall = Math.abs(natural(x + nx * 0.4, z + nz * 0.4) - natural(x - nx * 0.4, z - nz * 0.4));
        if (fall > (spec.maxFall ?? 0.75)) continue;
        const y = Math.max(py - 0.3, Math.min(py + 0.3, ground));
        lots.push({ x, z, y, rot: Math.atan2(-nx, -nz), empty: r() < 0.06 });
        const key = Math.floor(x) * 4096 + Math.floor(z);
        const cell = near.get(key);
        if (cell) cell.push([x, z]);
        else near.set(key, [[x, z]]);
        if (r() < 0.5) {
          const sx = px + nx * (TOWN_STREET / 2 + 0.1) + tx * 0.5;
          const sz = pz + nz * (TOWN_STREET / 2 + 0.1) + tz * 0.5;
          if (clear(sx, sz, TOWN_STREET / 2 + 0.04)) trees.push([sx, sz, py]);
        }
      }
    }
  }
  return { id: spec.id, name: spec.name, style: spec.style, streets: all, lots, trees };
}

/** A small seeded random stream for the pure world plans. */
function rngFor(key: string): () => number {
  let a = 2166136261;
  for (const ch of key) a = Math.imul(a ^ ch.charCodeAt(0), 16777619);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Turning-circle radius at the end of a cul-de-sac. */
const CUL_R = 0.5;

/** Where a Hills house may stand: on the hill, off the sign's slope, clear of your lot and the city grid. */
function lotAllowed(x: number, z: number, pts: readonly XZ[]): boolean {
  if (len2(x - HILLS_HOME.x, z - HILLS_HOME.z) < 2.75) return false;
  // The letters run a little past the sign's zone at either end: seeded worlds keep a wider berth.
  const berth = WORLD_SPEC.classic ? 0.35 : 1.0;
  for (const [cx, cz] of pts) {
    if (inSignZone(cx, cz, berth)) return false;
    if (cityFlatness(cx, cz) < 0.45) return false;
    if (coastDistance(cx, cz) > -0.5) return false;
  }
  return true;
}

// Grading: each road, driveway and terrace is a feature with a level (or ramped) core and a
// blend band, looked up through a coarse grid so terrainHeight stays cheap.
interface Grade {
  /** Weight and target height at (x, z), or null when out of reach. */
  at(x: number, z: number): [number, number] | null;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

const GRADE_CELL = 1;
let GRADES: Map<number, Grade[]> | null = null;

function grades(): Map<number, Grade[]> {
  if (GRADES) return GRADES;
  const plan = hillsPlan();
  const list: Grade[] = [];
  const weight = (d: number, core: number, blend: number) => 1 - smooth(core, core + blend, d);
  const capsule = (ax: number, az: number, ay: number, bx: number, bz: number, by: number, core: number, blend: number) => {
    const r = core + blend;
    list.push({
      x0: Math.min(ax, bx) - r, x1: Math.max(ax, bx) + r, z0: Math.min(az, bz) - r, z1: Math.max(az, bz) + r,
      at(x, z) {
        const { d, t } = segment(x, z, ax, az, bx, bz);
        return d < r ? [weight(d, core, blend), ay + (by - ay) * t] : null;
      },
    });
  };
  for (const s of plan.streets) {
    const core = s.w / 2 + (s.kind === 'track' ? 0.06 : 0.14);
    for (let i = 1; i < s.pts.length; i++) {
      const [ax, az, ay] = s.pts[i - 1]!;
      const [bx, bz, by] = s.pts[i]!;
      capsule(ax, az, ay, bx, bz, by, core, 0.42);
    }
    if (s.cul) {
      const [ex, ez, ey] = s.pts.at(-1)!;
      capsule(ex, ez, ey, ex, ez, ey, CUL_R + 0.12, 0.4);
    }
  }
  /** A level rectangle turned by `rot`, its edges blending into the slope. */
  const rect = (px: number, pz: number, rot: number, hw: number, hd: number, y: number, blend: number) => {
    const c = Math.cos(rot);
    const sn = Math.sin(rot);
    const r = len2(hw, hd) + blend;
    list.push({
      x0: px - r, x1: px + r, z0: pz - r, z1: pz + r,
      at(x, z) {
        const dx = x - px;
        const dz = z - pz;
        // Into the house's frame: local x along (cos, −sin), local z along (sin, cos).
        const lx = Math.abs(dx * c - dz * sn) - hw;
        const lz = Math.abs(dx * sn + dz * c) - hd;
        const d = len2(Math.max(0, lx), Math.max(0, lz));
        return d < blend ? [weight(d, 0, blend), y] : null;
      },
    });
  };
  for (const l of plan.lots) {
    rect(l.x, l.z, l.rot, l.w / 2 + 0.05, l.d / 2 + 0.05, l.y, 0.26);
    // The driveway: from the street's edge to the middle of the pad's street side.
    const [sx, sz, sy] = l.drive;
    const fx = (l.x - sx) / len2(l.x - sx, l.z - sz);
    const fz = (l.z - sz) / len2(l.x - sx, l.z - sz);
    capsule(sx, sz, sy, l.x - fx * (l.d / 2 - 0.05), l.z - fz * (l.d / 2 - 0.05), l.y, 0.17, 0.22);
  }
  for (let i = 1; i < plan.homeDrive.length; i++) {
    const a = plan.homeDrive[i - 1]!;
    const b = plan.homeDrive[i]!;
    capsule(a[0], a[1], a[2], b[0], b[1], b[2], 0.2, 0.25);
  }
  // The shore roads lie on graded ground in a seeded world (the classic map was shaped round them by hand).
  if (!WORLD_SPEC.classic) {
    for (const [line, w] of [[EMBARCADERO, 1.0], [GREAT_HIGHWAY, 0.9], [PRESIDIO_PKWY.slice(1), 0.9]] as const) {
      for (let i = 1; i < line.length; i++) {
        const [ax, az] = line[i - 1]!;
        const [bx, bz] = line[i]!;
        capsule(ax, az, 0, bx, bz, 0, w / 2 + 0.15, 0.6);
      }
    }
  }
  // The towns: their streets and lots, more lightly (they're seen from afar).
  for (const town of backdropTowns()) {
    for (const line of town.streets) {
      for (let i = 1; i < line.length; i++) {
        const [ax, az, ay] = line[i - 1]!;
        const [bx, bz, by] = line[i]!;
        capsule(ax, az, ay, bx, bz, by, TOWN_STREET / 2 + 0.12, 0.4);
      }
    }
    for (const l of town.lots) rect(l.x, l.z, l.rot, TOWN_PAD.w / 2, TOWN_PAD.d / 2, l.y, 0.24);
  }
  GRADES = new Map();
  for (const g of list) {
    for (let cx = Math.floor(g.x0 / GRADE_CELL); cx <= Math.floor(g.x1 / GRADE_CELL); cx++) {
      for (let cz = Math.floor(g.z0 / GRADE_CELL); cz <= Math.floor(g.z1 / GRADE_CELL); cz++) {
        const key = cx * 4096 + cz;
        const cell = GRADES.get(key);
        if (cell) cell.push(g);
        else GRADES.set(key, [g]);
      }
    }
  }
  return GRADES;
}

/** How strongly the ground at (x, z) is graded for a street, driveway or terrace (0..1). */
export function gradeWeight(x: number, z: number): number {
  const cell = grades().get(Math.floor(x / GRADE_CELL) * 4096 + Math.floor(z / GRADE_CELL));
  let w = 0;
  if (cell) for (const g of cell) w = Math.max(w, g.at(x, z)?.[0] ?? 0);
  return w;
}

/** Grades the streets, driveways and lots of the Hills and the towns into the slope: the strongest feature wins. */
function gradeHills(x: number, z: number, h: number): number {
  const cell = grades().get(Math.floor(x / GRADE_CELL) * 4096 + Math.floor(z / GRADE_CELL));
  if (!cell) return h;
  const hits: [number, number][] = [];
  for (const g of cell) {
    const r = g.at(x, z);
    if (r && r[0] > 0) hits.push(r);
  }
  if (!hits.length) return h;
  hits.sort((p, q) => p[0] - q[0]);
  for (const [w, t] of hits) h += (t - h) * w;
  return h;
}

// ─── Arterials ─────────────────────────────────────────────────────────────

/** Static roads that don't depend on which blocks are developed. */
export let EMBARCADERO: Pt[];
export let GREAT_HIGHWAY: Pt[];
export let PRESIDIO_PKWY: Pt[];
export const BAY_APPROACH: Pt[] = [[11.6, -6.5], [9.5, -6.8], [7.5, -7.5]];
export const AIRPORT_ROAD: Pt[] = [[11.2, -21], [12.6, -26], [14.4, -31], [16.4, -36]];
/** Extent of the world worth framing. */
export const WORLD = { x0: -50, x1: 18, z0: -40, z1: 46 } as const;

/** The Embarcadero from Mission Bay round the Ferry Building to the north-east corner: the same in every world. */
const EMBARCADERO_EAST: Pt[] = [[11.2, -21], [10.9, -12], [10.75, -3], [10.6, 3], [9.7, 7.4], [7, 8.8], [2, 9.5]];

// ─── The world for this seed ──────────────────────────────────────────────

/** Where the north shore is at x: the first water north of the city's edge. */
export function shoreZ(x: number): number {
  return northShore(x);
}
function northShore(x: number): number {
  // Where a line north from the city's edge first crosses the mainland's outline.
  let best = 18;
  for (let i = 0, j = MAINLAND.length - 1; i < MAINLAND.length; j = i++) {
    const [ax, az] = MAINLAND[j]!;
    const [bx, bz] = MAINLAND[i]!;
    if ((ax - x) * (bx - x) > 0 || ax === bx) continue;
    const z = az + ((bz - az) * (x - ax)) / (bx - ax);
    if (z > 8 && z < best) best = z;
  }
  return best;
}

/**
 * Lays out this world: coasts, blocks, parks, landmarks, sites, roads and
 * (for a seeded world) the Hills, from `worldgen`'s draw. A draw that doesn't
 * fit (the wrong number of homes' blocks, a cramped hillside) is redrawn.
 */
function applyWorld(seed: number) {
  for (let attempt = 0; ; attempt++) {
    const spec = generateWorld(seed, attempt);
    if (assign(spec) || attempt >= 60) {
      if (attempt >= 60 && !spec.classic) assign(generateWorld(0));
      return;
    }
  }
}

function assign(spec: WorldSpec): boolean {
  WORLD_SPEC = spec;
  GRID = spec.grid;
  MAINLAND = spec.mainland;
  MARIN = spec.marin;
  EAST_BAY = spec.eastBay;
  ISLANDS = spec.islands;
  const F = spec.islands.founder;
  ISLAND_COVE = spec.classic ? { x: 16.75, z: 37.85, r: 1.75 } : { x: F.x + spec.estate.cove.dx, z: F.z + spec.estate.cove.dz, r: spec.estate.cove.r };
  SUPERYACHT = spec.classic ? { x: 17.1, z: 37.6 } : { x: F.x + spec.estate.yacht.dx, z: F.z + spec.estate.yacht.dz };
  TWIN_PEAKS = { x: spec.peaks.centre.x, z: spec.peaks.centre.z, r: 14, h: 7.5 };
  TWIN_PEAKS_SUMMITS = spec.peaks.summits;
  HILLS_LEVELS = spec.levels;
  TOWN_GROUND = CLASSIC_TOWN_GROUND.map((g, i) => {
    const t = spec.towns[TOWN_GROUND_OF[i]!];
    return t ? ([g[0] + t.dx, g[1] + t.dx, g[2] + t.dz, g[3] + t.dz] as const) : g;
  }) as [number, number, number, number][];
  HILLS = null;
  TOWNS = null;
  GRADES = null;
  PADS = null;

  // The blocks: what each is for, the homes' blocks in order out from downtown, the parks.
  const blocks = spec.classic ? classicBlocks() : seededBlocks();
  if (!blocks) return false;
  BLOCKS = blocks;
  FLAT_CENTRES = BLOCKS.filter((b) => b.use !== 'hill').map((b) => [b.bx * PITCH, b.bz * PITCH] as const);
  NEIGHBOURHOOD_BLOCKS = BLOCKS.filter((b) => b.use === 'city' && !isBuild(b))
    .map(({ bx, bz }) => ({ bx, bz }))
    .sort((a, b) => len2(a.bx, a.bz * 1.15) - len2(b.bx, b.bz * 1.15) || a.bx - b.bx || a.bz - b.bz);
  if (NEIGHBOURHOOD_BLOCKS.length !== NEIGHBOURHOOD_COUNT && !spec.classic) return false;
  PARKS = parksOf(BLOCKS);

  // Roads along the shores.
  const gx = spec.gg.x;
  if (spec.classic) {
    EMBARCADERO = [...EMBARCADERO_EAST, [-4, 9.7], [-10, 9.8], [-14, 9.4], [-17, 10.3], [-20.5, 10.8], [-25, 9.6], [-29, 9.1], [-33, 8], [-34.6, 5.4]];
    GREAT_HIGHWAY = [[-39.6, -33], [-39.8, -20], [-39.9, -8], [-39, -2], [-37.5, 2]];
    PRESIDIO_PKWY = [[-34.6, 5.4], [-34.2, 2.6], [-33, 0], [-32.5, -2.5]];
  } else {
    // The Embarcadero follows the north shore a road's width inland, cutting across the necks of the
    // points, and swings out round any blocks on a point (clear of their streets).
    const out = BLOCKS.filter((b) => b.bz === 2).map((b) => [b.bx * PITCH - 3.6, b.bx * PITCH + 3.6] as const);
    const rise = (x: number) => {
      let z = 0;
      for (const [x0, x1] of out) {
        const d = Math.max(x0 - x, x - x1, 0);
        z = Math.max(z, 13.6 - d * 1.25);
      }
      return z;
    };
    const north: Pt[] = [];
    /** How far north the road may go at each sample: a road's width short of the shore. */
    const room: number[] = [];
    const step = out.length ? 1.1 : 3.4;
    for (let x = 0.4; x > gx + 7; x -= step) {
      if (x > -4 && !out.length) continue;
      let m = Infinity;
      for (const dx of [-1.6, -0.8, 0, 0.8, 1.6]) m = Math.min(m, northShore(x + dx));
      const z = Math.max(8.9, Math.min(10.9, m - 1.15), rise(x));
      if (x > -4 && z < 9.9) continue;
      north.push([x, z]);
      room.push(Math.max(z, m - 1.15));
    }
    north.push([gx + 5.6, Math.max(8.9, Math.min(9.6, northShore(gx + 5.6) - 1.1))]);
    // Ease the line out (never in toward the blocks, never onto the beach), so it sweeps rather than wobbles.
    for (let pass = 0; pass < 2; pass++) {
      const z = north.map((p) => p[1]);
      for (let i = 1; i < north.length - 1; i++) north[i] = [north[i]![0], Math.min(room[i]!, Math.max(z[i]!, (z[i - 1]! + 2 * z[i]! + z[i + 1]!) / 4))];
    }
    EMBARCADERO = [...EMBARCADERO_EAST, ...north, [gx + 1.6, 8], [gx, 5.4]];
    const xh = Math.min(-39.3, GRID.bx0 * PITCH - 3.7, spec.beachX + 4.4);
    // Along the beach, then in toward the Presidio at the grid's north-west corner.
    const edge = GRID.bx0 * PITCH - 2.5;
    GREAT_HIGHWAY = [[xh + 0.2, -33], [xh, -20], [xh - 0.1, -8], [Math.min(xh + 0.8, edge - 1.5), -2], [Math.min(xh + 2.3, edge), 2]];
    const sx = PITCH * Math.round((gx + 2.1 - 2.5) / PITCH) + 2.5;
    PRESIDIO_PKWY = [[gx, 5.4], [gx + 0.4, 2.6], [gx + 1.6, 0], [sx, -2.5]];
  }
  PKWY_JOIN = [PRESIDIO_PKWY.at(-1)![0], 0];

  // Landmarks and the sites things are bought for.
  const presidioTop = BLOCKS.filter((b) => b.use === 'presidio' && b.bz === GRID.bz1).sort((a, b) => b.bx - a.bx)[0];
  const big = PARKS.find((p) => p.kind === 'park');
  const strip = big && big.blocks.every((b) => b.bz === big.blocks[0]!.bz) && big.blocks.some((b) => b.bx === GRID.bx0) ? big : null;
  const C = spec.peaks.centre;
  if (spec.classic) {
    LANDMARKS = {
      ferryBuilding: { x: 12.4, z: -1.2 },
      coitTower: { x: -5, z: 6 },
      palaceOfFineArts: { x: -25, z: 5 },
      sutroTower: { x: -23, z: -35 },
      windmill: { x: -40.5, z: -15 },
      conservatory: { x: -16.5, z: -14.6 },
      cliffHouse: { x: -46.8, z: -1.6 },
      sign: { x: -14 + 5.6 * Math.SQRT1_2, z: -36 + 5.6 * Math.SQRT1_2 },
      goldenGate: { x: -34.6, z0: 10.2, z1: 21.2 },
      bayBridge: { z: -6.5, x0: 11.6, x1: 56 },
    };
    HAS = spec.has;
    PIER = { x0: -10.4, x1: -6.4, z0: 10.6, z1: 22 };
    MARINA = { x: -21.4, z: 12.2, green: { x: -20.5, z: 9.6, w: 7, d: 1.3 } };
    MARINA_SLOTS = [-23.2, -21.4, -19.6].map((x) => ({ x, z: 14.6 }));
    HILLS_HOME = { x: -6.6, z: -31.6 };
    HILLS_HOOD = { x0: -14, x1: -2, z0: -34, z1: -25 };
    return true;
  }
  const xb = spec.beachX;
  const bigCentre = big ? centreOf(big.blocks) : { x: -20, z: -15, x1: -12.5, z1: -12.5 };
  LANDMARKS = {
    ferryBuilding: { x: 12.4, z: -1.2 },
    coitTower: spec.telegraph ?? { x: -5, z: 6 },
    palaceOfFineArts: presidioTop ? { x: presidioTop.bx * PITCH, z: presidioTop.bz * PITCH } : { x: gx + 9.6, z: 5 },
    sutroTower: spec.peaks.sutro ? { x: spec.peaks.sutro[0], z: spec.peaks.sutro[1] } : C,
    windmill: { x: GREAT_HIGHWAY[1]![0] - 0.7, z: strip ? strip.blocks[0]!.bz * PITCH : -15 },
    conservatory: strip ? { x: bigCentre.x1 - 4, z: bigCentre.z + 0.4 } : { x: bigCentre.x1 - 2.6, z: bigCentre.z1 - 1.4 },
    cliffHouse: { x: xb - 2.6, z: -1.6 },
    sign: signSpot(spec.signU),
    goldenGate: { ...spec.gg },
    bayBridge: { z: -6.5, x0: 11.6, x1: 56 },
  };
  HAS = { ...spec.has, palace: spec.has.palace && !!presidioTop, windmill: spec.has.windmill && !!strip, conservatory: spec.has.conservatory && !!big };
  const pz = Math.min(10.6, northShore(spec.pierX) - 0.4);
  const pz0 = BLOCKS.some((b) => b.bz === 2) ? northShore(spec.pierX) - 0.4 : pz;
  PIER = { x0: spec.pierX - 2, x1: spec.pierX + 2, z0: pz0, z1: pz0 + 11.4 };
  const mz = northShore(spec.marinaX);
  const ez = embarcaderoZ(spec.marinaX + 0.9);
  const gd = ez - 0.55 - 8.3;
  MARINA = { x: spec.marinaX, z: mz - 0.2, green: gd > 0.7 ? { x: spec.marinaX + 0.9, z: 8.3 + gd / 2, w: 7, d: gd } : null };
  MARINA_SLOTS = [-1.8, 0, 1.8].map((dx) => ({ x: spec.marinaX + dx, z: mz + 2.2 }));

  // TinyTown Hills, now, so your lot and the hood are known before anything is drawn.
  const plan = hillsPlan();
  // A real neighbourhood: enough homes, a street or two down to the grid besides the boulevard, your lot clear of the city.
  if (plan.lots.length < 26 || plan.streets.length < 4 || !plan.streets.some((st) => st.id.startsWith('c-')) || cityFlatness(HILLS_HOME.x, HILLS_HOME.z) < 3.1) return false;
  // No street cut deep into a steep face: the hill must be gentle enough to build on.
  for (const st of plan.streets) {
    if (st.kind === 'track' || st.id.startsWith('hairpin') || st.id === 'upper') continue;
    let bad = 0;
    for (let i = 1; i < st.pts.length - 1; i++) {
      const [x, z, y] = st.pts[i]!;
      const [ax, az] = st.pts[i - 1]!;
      const [bx, bz] = st.pts[i + 1]!;
      const l = len2(bx - ax, bz - az) || 1;
      const nx = -(bz - az) / l;
      const nz = (bx - ax) / l;
      const cut = Math.max(Math.abs(natural(x + nx * 0.9, z + nz * 0.9) - y), Math.abs(natural(x - nx * 0.9, z - nz * 0.9) - y));
      if (cut > (st.id.startsWith('c-') ? 1.3 : 1.45)) return false;
      if (cut > 0.75) bad++;
    }
    if (bad > st.pts.length * 0.5) return false;
  }
  // The towns round the bay: every one needs streets of houses.
  const towns = backdropTowns();
  return towns.every((t) => t.lots.length > 7) && towns.reduce((n, t) => n + t.lots.length, 0) > 320;
}

/** The Embarcadero's z where it passes x (on the north shore). */
function embarcaderoZ(x: number): number {
  for (let i = 1; i < EMBARCADERO.length; i++) {
    const [ax, az] = EMBARCADERO[i - 1]!;
    const [bx, bz] = EMBARCADERO[i]!;
    if ((x - ax) * (x - bx) <= 0 && ax !== bx) return az + ((bz - az) * (x - ax)) / (bx - ax);
  }
  return 9.6;
}

/** The middle of a group of blocks, and its north-east extent. */
function centreOf(blocks: readonly BlockCoord[]): { x: number; z: number; x1: number; z1: number } {
  const xs = blocks.map((b) => b.bx * PITCH);
  const zs = blocks.map((b) => b.bz * PITCH);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2, x1: Math.max(...xs) + 2.5, z1: Math.max(...zs) + 2.5 };
}

/**
 * The sign: across the face of the peaks, south-east of the end of Market (so
 * Twin Peaks Boulevard climbs clear of it, as in the classic map), as high up
 * as the classic one stands (natural ground 4.0).
 */
function signSpot(du: number): { x: number; z: number } {
  const C = WORLD_SPEC.peaks.centre;
  const u = (MARKET_END[0] - C.x) * RIDGE_U[0] + (MARKET_END[1] - C.z) * RIDGE_U[1] + 10.5 + du;
  const at = (v: number) => ({ x: C.x + u * RIDGE_U[0] + v * FACE_V[0], z: C.z + u * RIDGE_U[1] + v * FACE_V[1] });
  let v = 1;
  while (v < 14 && natural(at(v).x, at(v).z) > 4.02) v += 0.05;
  return at(v);
}

/** The classic block plan, exactly as it was. */
function classicBlocks(): (BlockCoord & { use: BlockUse })[] {
  const raw = (b: BlockCoord): BlockUse | null => {
    const { bx, bz } = b;
    if (bx === HQ_BLOCK.bx && bz === HQ_BLOCK.bz) return 'hq';
    if (bx === -3 && bz === -4) return 'civic';
    if (bx - bz * 1 === MARKET_K / PITCH && bz >= -4) return 'market';
    if (bz === -3 && bx <= -3) return 'park';
    if ((bx <= -6 && bz >= 0) || (bx === -5 && bz === 1)) return 'presidio';
    const c = blockCentre(b);
    // Must sit on land with room for a promenade.
    for (const [dx, dz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]] as const) {
      if (coastDistance(c.x + dx, c.z + dz) > -1.2) return null;
    }
    for (const [dx, dz] of [[0, 0], [-2.5, -2.5], [2.5, -2.5], [-2.5, 2.5], [2.5, 2.5]] as const) {
      if (hills(c.x + dx, c.z + dz) > 0.35) return 'hill';
    }
    return 'city';
  };
  CIVIC_BLOCK = { bx: -3, bz: -4 };
  MARKET_END = [-13.5, -23.5];
  const out: (BlockCoord & { use: BlockUse })[] = [];
  for (let bx = GRID.bx0; bx <= GRID.bx1; bx++) {
    for (let bz = GRID.bz0; bz <= GRID.bz1; bz++) {
      const use = raw({ bx, bz });
      if (use) out.push({ bx, bz, use });
    }
  }
  return out;
}

/**
 * A seeded block plan. Downtown is fixed (HQ, the eight build blocks); Market
 * Street runs down the diagonal to the foot of the hills, City Hall beside its
 * end; the Presidio fills the corner where the Golden Gate lands; the big park
 * goes where the world drew it; land too steep is left to the hills. Exactly
 * NEIGHBOURHOOD_COUNT blocks are left for homes: any land over that becomes
 * squares (little parks), and a draw without enough land is redrawn.
 */
function seededBlocks(): (BlockCoord & { use: BlockUse })[] | null {
  const S = WORLD_SPEC;
  const G = GRID;
  const k = (bx: number, bz: number) => `${bx},${bz}`;
  const inGrid = (bx: number, bz: number) => bx >= G.bx0 && bx <= G.bx1 && bz >= G.bz0 && bz <= G.bz1;
  const landCache = new Map<string, boolean>();
  const onLand = (bx: number, bz: number) => {
    const key = k(bx, bz);
    let v = landCache.get(key);
    if (v === undefined) {
      v = [[-3, -3], [3, -3], [-3, 3], [3, 3]].every(([dx, dz]) => coastDistance(bx * PITCH + dx!, bz * PITCH + dz!) <= -1.2);
      landCache.set(key, v);
    }
    return v;
  };
  const hillAt = (bx: number, bz: number) => [[0, 0], [-2.5, -2.5], [2.5, -2.5], [-2.5, 2.5], [2.5, 2.5]].some(([dx, dz]) => hills(bx * PITCH + dx!, bz * PITCH + dz!) > 0.35);
  const use = new Map<string, BlockUse>();
  use.set(k(HQ_BLOCK.bx, HQ_BLOCK.bz), 'hq');
  for (const b of BUILD_BLOCK_COORDS) {
    if (!onLand(b.bx, b.bz)) return null;
    use.set(k(b.bx, b.bz), 'city');
  }
  const fixed = new Set(use.keys());

  // Market Street: down the diagonal from the Ferry Building until the hills begin.
  const market: BlockCoord[] = [];
  for (let bx = 1, bz = -1; inGrid(bx, bz) && onLand(bx, bz) && !hillAt(bx, bz) && !fixed.has(k(bx, bz)); bx--, bz--) market.push({ bx, bz });
  if (market.length < 3) return null;
  for (const b of market) use.set(k(b.bx, b.bz), 'market');
  const last = market.at(-1)!;
  MARKET_END = [last.bx * PITCH - 3.5, last.bz * PITCH - 3.5];
  const civic = [
    { bx: last.bx - 1, bz: last.bz },
    { bx: market.at(-2)!.bx - 1, bz: market.at(-2)!.bz },
    { bx: last.bx + 1, bz: last.bz },
  ].find((b) => inGrid(b.bx, b.bz) && onLand(b.bx, b.bz) && !hillAt(b.bx, b.bz) && !use.has(k(b.bx, b.bz)));
  if (!civic) return null;
  CIVIC_BLOCK = civic;
  use.set(k(civic.bx, civic.bz), 'civic');

  // Telegraph Hill, then the Presidio round the Golden Gate's landing.
  const tele = S.telegraph ? k(S.telegraph.x / PITCH, 1) : null;
  if (tele) use.set(tele, 'hill');
  const bxg = Math.round(S.gg.x / PITCH);
  const presidio = (bx: number, bz: number) => {
    const key = k(bx, bz);
    if (inGrid(bx, bz) && onLand(bx, bz) && !use.has(key)) use.set(key, 'presidio');
  };
  for (let bx = G.bx0; bx <= bxg + 1; bx++) for (let bz = 0; bz <= 1; bz++) presidio(bx, bz);
  for (let e = 0; e < S.presidio.extra; e++) presidio(bxg + 2 + e, 1);

  // The big park.
  const P = S.park;
  if (P.kind === 'strip') {
    let n = 0;
    for (let bx = G.bx0; bx <= G.bx1 && n < P.length; bx++, n++) {
      if (use.has(k(bx, P.row)) || !onLand(bx, P.row)) break;
      use.set(k(bx, P.row), 'park');
    }
    if (n < 3) return null;
  } else {
    for (let i = 0; i < P.w; i++) {
      for (let j = 0; j < P.h; j++) {
        const bx = P.bx0 + i;
        const bz = P.bz0 + j;
        if (!inGrid(bx, bz) || use.has(k(bx, bz)) || !onLand(bx, bz)) return null;
        use.set(k(bx, bz), 'park');
      }
    }
  }

  // The rest: too steep, or homes.
  for (let bx = G.bx0; bx <= G.bx1; bx++) {
    for (let bz = G.bz0; bz <= G.bz1; bz++) {
      const key = k(bx, bz);
      if (use.has(key) || !onLand(bx, bz)) continue;
      use.set(key, hillAt(bx, bz) ? 'hill' : 'city');
    }
  }

  // Exactly NEIGHBOURHOOD_COUNT blocks of homes: the land left over becomes squares, spread out.
  let homes = [...use.entries()].filter(([key, u]) => u === 'city' && !fixed.has(key)).map(([key]) => key.split(',').map(Number) as [number, number]);
  // Short of land: give the big strip park back, block by block from its east end (it keeps at least three).
  if (P.kind === 'strip') {
    const strip = [...use.entries()].filter(([, u]) => u === 'park').map(([key]) => key.split(',').map(Number) as [number, number]).sort((a, b) => b[0] - a[0]);
    while (homes.length < NEIGHBOURHOOD_COUNT && strip.length > 3) {
      const [bx, bz] = strip.shift()!;
      const u = hillAt(bx, bz) ? 'hill' : 'city';
      use.set(k(bx, bz), u);
      if (u === 'city') homes = [...homes, [bx, bz]];
    }
  }
  // Land to spare: the big park grows (east along its row, or by a column), before any squares.
  const isHome = (bx: number, bz: number) => use.get(k(bx, bz)) === 'city' && !fixed.has(k(bx, bz));
  const parkBlocks = () => [...use.entries()].filter(([, u]) => u === 'park').map(([key]) => key.split(',').map(Number) as [number, number]);
  for (let grow = 0; grow < 4 && homes.length - NEIGHBOURHOOD_COUNT > 4; grow++) {
    const pb = parkBlocks();
    const xs = pb.map((q) => q[0]);
    const zs = pb.map((q) => q[1]);
    const cols = (bx: number) => [...new Set(zs)].map((bz) => [bx, bz] as [number, number]);
    const options = P.kind === 'strip' ? [[[Math.max(...xs) + 1, P.row] as [number, number]]] : [cols(Math.max(...xs) + 1), cols(Math.min(...xs) - 1)];
    const add = options.find((o) => o.every(([bx, bz]) => isHome(bx, bz)));
    if (!add) break;
    for (const [bx, bz] of add) use.set(k(bx, bz), 'park');
    homes = homes.filter(([bx, bz]) => !add.some(([ax, az]) => ax === bx && az === bz));
  }
  const surplus = homes.length - NEIGHBOURHOOD_COUNT;
  if (surplus < 0 || surplus > 6) return null;
  const r = rngFor(`squares|${S.seed}`);
  const near = (bx: number, bz: number, uses: BlockUse[]) => {
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if ((i || j) && uses.includes(use.get(k(bx + i, bz + j))!)) return true;
    return false;
  };
  const order = homes.map((b) => ({ b, key: r() })).sort((a, b) => a.key - b.key);
  let made = 0;
  for (const { b } of order) {
    if (made >= surplus) break;
    const [bx, bz] = b;
    // Not right against downtown, another square or the big park.
    if (len2(bx, bz) < 1.5 || near(bx, bz, ['square', 'park'])) continue;
    use.set(k(bx, bz), 'square');
    made++;
  }
  if (made < surplus) return null;

  // A point drawn for a row of homes must have room for one.
  if (G.bz1 === 2 && ![...use.keys()].some((key) => key.endsWith(',2'))) return null;
  // The Presidio Parkway must meet a city street where it comes down to the grid.
  const sx = PITCH * Math.round((S.gg.x + 2.1 - 2.5) / PITCH) + 2.5;
  const i = Math.round((sx - 2.5) / PITCH);
  const street = (bx: number, bz: number) => ['city', 'market', 'hq', 'civic'].includes(use.get(k(bx, bz)) ?? '');
  if (!street(i, -1) && !street(i + 1, -1)) return null;

  const out: (BlockCoord & { use: BlockUse })[] = [];
  for (let bx = G.bx0; bx <= G.bx1; bx++) {
    for (let bz = G.bz0; bz <= G.bz1; bz++) {
      const u = use.get(k(bx, bz));
      if (u) out.push({ bx, bz, use: u });
    }
  }
  return out;
}

const SQUARE_NAMES = ['Dolores Park', 'Alamo Square', 'Lafayette Park', 'Washington Square', 'Duboce Park', 'Alta Plaza', 'Jefferson Square', 'Mission Square'];

/** The parks: the big one (its blocks joined up), then each square. */
function parksOf(blocks: readonly (BlockCoord & { use: BlockUse })[]): Park[] {
  const park = blocks.filter((b) => b.use === 'park').map(({ bx, bz }) => ({ bx, bz }));
  const out: Park[] = [];
  if (park.length) {
    const strip = park.every((b) => b.bz === park[0]!.bz);
    out.push({ kind: 'park', blocks: park, name: strip ? 'Golden Gate Park' : 'Buena Vista Park' });
  }
  blocks
    .filter((b) => b.use === 'square')
    .forEach((b, i) => out.push({ kind: 'square', blocks: [{ bx: b.bx, bz: b.bz }], name: SQUARE_NAMES[(i + WORLD_SPEC.seed) % SQUARE_NAMES.length]! }));
  return out;
}

applyWorld(worldSeed());
onWorldSeed(applyWorld);
