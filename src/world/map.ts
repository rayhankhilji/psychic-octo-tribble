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

export type Pt = readonly [number, number];

/** Math.hypot is slow in V8, and these run hundreds of thousands of times while the terrain is built. */
const len2 = (x: number, z: number) => Math.sqrt(x * x + z * z);

export const PITCH = 5;
export const BLOCK = 4;

/** The grid the city can occupy. */
export const GRID = { bx0: -7, bx1: 1, bz0: -6, bz1: 1 } as const;

// ─── Coastlines ─────────────────────────────────────────────────────────────

/** San Francisco and the peninsula south of it. */
export const MAINLAND: readonly Pt[] = [
  [-46, 3.5], // Lands End
  [-43.5, 7.5],
  [-38.5, 10.2],
  [-34, 10.8], // Fort Point (Golden Gate Bridge, south end)
  [-29, 10.2], // Crissy Field
  [-24.5, 10.6],
  [-21, 12.4], // Marina
  [-18.5, 12.2], // Fort Mason
  [-16.5, 10.6],
  [-13.5, 10.4], // Aquatic Park
  [-9, 11],
  [-2, 11], // Fisherman's Wharf
  [4, 10.6],
  [8.6, 9.4],
  [11, 6.6], // North-east corner
  [11.6, 1],
  [11.8, -6], // Ferry Building to the Bay Bridge
  [11.4, -14],
  [12.6, -22], // Mission Bay
  [15.5, -28],
  [17.5, -34],
  [24, -40], // Hunters Point
  [26, -52],
  [32, -70],
  [36, -110],
  [-70, -110],
  [-64, -60],
  [-52, -44], // Fort Funston
  [-46.5, -34],
  [-44.5, -20], // Ocean Beach
  [-44.2, -6],
  [-47.5, -1], // Cliff House
];

/** The Marin Headlands, across the Golden Gate. */
export const MARIN: readonly Pt[] = [
  [-95, 18],
  [-60, 17.5],
  [-44, 19.6],
  [-35.5, 20], // Golden Gate Bridge, north end
  [-30, 22.5],
  [-25.5, 27], // Sausalito
  [-23, 34],
  [-27, 46],
  [-40, 80],
  [-95, 80],
];

/** The East Bay, mostly off to the right. */
export const EAST_BAY: readonly Pt[] = [
  [64, 60],
  [58, 30],
  [56, 0],
  [57, -30],
  [62, -70],
  [70, -110],
  [140, -110],
  [140, 60],
];

export interface Island {
  id: string;
  x: number;
  z: number;
  r: number;
  /** Peak height above the water. */
  h: number;
}

export const ISLANDS: Record<'founder' | 'launch' | 'yerba' | 'treasure' | 'angel', Island> = {
  /** Your island (Alcatraz-ish), unlocked at $100k MRR. */
  // Your island sits well out in the bay, north of the shipping lane: you fly there (helicopter or jet).
  founder: { id: 'founder', x: 12, z: 39, r: 4.5, h: 1.2 },
  /** The clouded end of your island, unlocked at $1M. */
  // South-east of the estate, so from the north-east camera the rocket never stands in front of the house.
  launch: { id: 'launch', x: 16.3, z: 34.5, r: 2.6, h: 0.25 },
  yerba: { id: 'yerba', x: 33, z: -7, r: 3.6, h: 3.2 },
  treasure: { id: 'treasure', x: 35.5, z: -0.5, r: 3.2, h: 0.25 },
  angel: { id: 'angel', x: -16, z: 38, r: 6.5, h: 6 },
};

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

/** Your island's outline: a rough circle, a cove on the west for the superyacht's jetty. */
export const ISLAND_COVE = { x: 7.25, z: 37.85, r: 1.75 } as const;

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
      const d = len2(x - isl.x, z - isl.z) - isl.r - wobble(a, 1.3) * 0.8;
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

export type BlockUse = 'hq' | 'city' | 'market' | 'park' | 'presidio' | 'hill' | 'civic';

export const HQ_BLOCK: BlockCoord = { bx: 0, bz: 0 };
/** Civic Center: City Hall and its plaza, just off Market. */
export const CIVIC_BLOCK: BlockCoord = { bx: -3, bz: -4 };

/** Market Street runs along x − z = MARKET_K, from the Ferry Building to Twin Peaks. */
export const MARKET_K = 10;
export const MARKET_START: Pt = [10.6, 0.6];
export const MARKET_END: Pt = [-13.5, -23.5];

export function blockCentre(b: BlockCoord): { x: number; z: number } {
  return { x: b.bx * PITCH, z: b.bz * PITCH };
}

/** The big hill behind the city: the sign arcs across its north-east face. */
export const TWIN_PEAKS = { x: -14, z: -36, r: 14, h: 7.5 } as const;

/**
 * The hills as the block plan sees them (which blocks are too steep to build
 * on). Frozen: the terrain itself is `relief`, which adds the detail.
 */
function hills(x: number, z: number): number {
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

function blockUseRaw(b: BlockCoord): BlockUse | null {
  const { bx, bz } = b;
  if (bx === HQ_BLOCK.bx && bz === HQ_BLOCK.bz) return 'hq';
  if (bx === CIVIC_BLOCK.bx && bz === CIVIC_BLOCK.bz) return 'civic';
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
}

/** Every grid block that exists, with what it's used for. */
export const BLOCKS: readonly (BlockCoord & { use: BlockUse })[] = (() => {
  const out: (BlockCoord & { use: BlockUse })[] = [];
  for (let bx = GRID.bx0; bx <= GRID.bx1; bx++) {
    for (let bz = GRID.bz0; bz <= GRID.bz1; bz++) {
      const use = blockUseRaw({ bx, bz });
      if (use) out.push({ bx, bz, use });
    }
  }
  return out;
})();

export function blockUse(b: BlockCoord): BlockUse | null {
  return BLOCKS.find((x) => x.bx === b.bx && x.bz === b.bz)?.use ?? null;
}

/** Downtown build blocks, in the order they open (ids are stable save keys). */
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

/** Residential blocks, nearest downtown first. */
export const NEIGHBOURHOOD_BLOCKS: readonly BlockCoord[] = BLOCKS.filter((b) => b.use === 'city' && !isBuild(b))
  .map(({ bx, bz }) => ({ bx, bz }))
  .sort((a, b) => len2(a.bx, a.bz * 1.15) - len2(b.bx, b.bz * 1.15) || a.bx - b.bx || a.bz - b.bz);

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
const FLAT_CENTRES: readonly Pt[] = BLOCKS.filter((b) => b.use !== 'hill').map((b) => [b.bx * PITCH, b.bz * PITCH] as const);

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
export const TWIN_PEAKS_SUMMITS: readonly { x: number; z: number; h: number }[] = [
  { x: -16.4, z: -35.4, h: 9.6 },
  { x: -11.8, z: -39.8, h: 9.1 },
];

function peak(x: number, z: number, px: number, pz: number, h: number): number {
  const dx = x - px;
  const dz = z - pz;
  // u along the ridge (north-west to south-east), v down the face toward the city (north-east).
  const u = (dx - dz) * Math.SQRT1_2;
  const v = (dx + dz) * Math.SQRT1_2;
  const e = Math.sqrt((u / 9) ** 2 + (v / (v > 0 ? 15.6 : 10)) ** 2 + 0.002);
  return e >= 1 ? 0 : h * (1 - e) ** 1.3;
}

function twinPeaks(x: number, z: number): number {
  const [n, s] = TWIN_PEAKS_SUMMITS as [{ x: number; z: number; h: number }, { x: number; z: number; h: number }];
  let h = smoothMax(peak(x, z, n.x, n.z, n.h), peak(x, z, s.x, s.z, s.h), 1.2);
  // The foothills: a steady apron rising from the edge of the city grid, so the lowest Hills
  // streets run parallel to the grid and curve where it steps, then climb into the peaks.
  const apron = Math.min(softCityDistance(x, z) * 0.42, 3.4) * smooth(-20.5, -23.5, z) * smooth(8, 3, x) * smooth(-48, -40, z);
  h = smoothMax(h, apron, 1.0);
  // Mount Sutro (forested) to the west and Mount Davidson to the south-east.
  h += bump(x, z, -23, -35, 6.5, 4.4) + bump(x, z, -5, -44.5, 6.5, 3.4);
  // Ravines down the face, the spurs between them left standing.
  for (const [ax, az, bx, bz, depth, width] of HILLS_RAVINES) {
    const { d, t } = segment(x, z, ax, az, bx, bz);
    const k = d / width;
    if (k < 1) h -= depth * (1 - k * k) ** 2 * Math.min(1, t * 4, (1 - t) * 3);
  }
  // Rocky crowns and ribs on the upper slopes; the lower face stays smooth enough to build on.
  const high = smooth(5, 9, h);
  h += high * (ridged(x * 0.45, z * 0.45) - 0.45) * 1.1;
  return h;
}

/** Ravines on the face of the hills, top to bottom: [x0, z0, x1, z1, depth, half-width]. */
const HILLS_RAVINES: readonly [number, number, number, number, number, number][] = [];

/** Hills of the mainland, Marin and the East Bay, before the city is levelled into them. */
function relief(x: number, z: number): number {
  let h =
    // Telegraph Hill, the Presidio and Lands End: gentle, inside the city.
    bump(x, z, -5, 6, 3.4, 2.4) +
    bump(x, z, -36, 3, 9, 1.4) +
    bump(x, z, -44, 2, 5, 2.6) +
    twinPeaks(x, z);
  // The backdrop: San Bruno Mountain and the south, the Marin Headlands, the East Bay hills.
  const far =
    bump(x, z, -6, -66, 26, 11) +
    bump(x, z, -40, -52, 16, 5) +
    bump(x, z, 12, -58, 14, 4) +
    bump(x, z, -48, 34, 22, 13) +
    bump(x, z, -30, 40, 14, 9) +
    bump(x, z, -70, 30, 18, 10) +
    bump(x, z, 92, -10, 40, 16) +
    bump(x, z, 80, 40, 30, 12);
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
export const TOWN_GROUND: readonly [number, number, number, number][] = [
  [-32, 4.5, -61, -45.5],
  [-61, -42, -67, -41],
  [-32, -22.5, 22, 33],
  [60, 75, -45, 37],
  [56, 67, -67, 39],
];

/** Height of an island at (x, z), `depth` inland from its coast. */
function islandHeight(id: IslandId, x: number, z: number, depth: number): number {
  switch (id) {
    case 'founder': {
      // A low plateau for the estate, rocky knolls to the north-west where the lighthouse stands.
      const isl = ISLANDS.founder;
      // Low dunes and lawns: a quick rise from the strand, then the plateau.
      let h = isl.h * smooth(0, 1.3, depth) + 0.06 * fbm(x * 0.9, z * 0.9, 2);
      h += bump(x, z, 9.0, 41.9, 1.9, 0.75) + bump(x, z, 10.6, 42.6, 1.6, 0.35);
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

export const LANDMARKS = {
  ferryBuilding: { x: 12.4, z: -1.2 },
  coitTower: { x: -5, z: 6 },
  palaceOfFineArts: { x: -25, z: 5 },
  sutroTower: { x: -23, z: -35 },
  windmill: { x: -40.5, z: -15 },
  /** Centre of the sign: tangent to the hill's contour, so the letters arch along the ridge. */
  sign: { x: -14 + 5.6 * Math.SQRT1_2, z: -36 + 5.6 * Math.SQRT1_2 },
  goldenGate: { x: -34.6, z0: 10.2, z1: 21.2 },
  bayBridge: { z: -6.5, x0: 11.6, x1: 56 },
} as const;

/** The pier with rides (Pier 39-ish), sticking out into the bay. */
export const PIER = { x0: -10.4, x1: -6.4, z0: 10.6, z1: 22 } as const;
/** Yacht berths at the Marina. */
export const MARINA_SLOTS = [-23.2, -21.4, -19.6].map((x) => ({ x, z: 14.6 }));
export const SUPERYACHT = { x: 6.9, z: 37.6 } as const;
/** The airport's helipad, north of the terminal: the founder's helicopter flies to the island from here. */
export const HELIPAD = { x: 21.9, z: -35.3 } as const;
/** SFO-ish, on fill by the bay to the south-east. Free for everyone. */
export const AIRPORT = { x0: 16, x1: 28, z0: -50, z1: -36 } as const;
export const AIRPORT_SLOTS = [-47, -44.4, -41.8, -39.2].map((z) => ({ x: 19.2, z }));
export const RUNWAY = { x: 25.2, z0: -49.5, z1: -36.5 } as const;
/** Founder lots: on the HQ block, on Twin Peaks, on your island. */
export const DOWNTOWN_HOME = { x: -1.5, z: 1.5 } as const;
export const HILLS_HOME = { x: -6.6, z: -31.6 } as const;
/** TinyTown Hills: the slope of Twin Peaks below the sign, facing the city. */
export const HILLS_HOOD = { x0: -14, x1: -2, z0: -34, z1: -25 } as const;

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
  return (HILLS ??= buildHillsPlan());
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
const HILLS_LEVELS = { avenue: 1.15, panorama: 2.05, upper: 3.15, glen: 2.45 } as const;

/** Lots along every street, both sides, wherever a level terrace fits. */
function finishPlan(streets: HillsStreet[]): HillsPlan {
  const lots: HillsLot[] = [];
  const W = 1.12;
  const D = 1.0;
  const streetDistance = (x: number, z: number, skip = -1) => {
    let best = Infinity;
    streets.forEach((s, si) => {
      if (si === skip) return;
      for (let i = 1; i < s.pts.length; i++) {
        const [ax, az] = s.pts[i - 1]!;
        const [bx, bz] = s.pts[i]!;
        best = Math.min(best, segment(x, z, ax, az, bx, bz).d - s.w / 2);
      }
      if (s.cul) best = Math.min(best, len2(x - s.pts.at(-1)![0], z - s.pts.at(-1)![1]) - CUL_R);
    });
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

const TOWN_SPECS: readonly TownSpec[] = [
  {
    id: 'excelsior', name: 'The Excelsior', style: 'stucco', both: true,
    inside: (x, z) => EXCELSIOR(x, z) && natural(x, z) < 5.2 && natural(x, z) > 0.4,
    seeds: [[-26.5, -51.2], [-19, -56.5], [-16.5, -48.5]], step: 2.35, levels: 6, cross: 7.5,
  },
  {
    id: 'westlake', name: 'Westlake', style: 'stucco', both: true,
    inside: (x, z) => WESTLAKE(x, z) && coastDistance(x, z) < -1.6,
    seeds: [[-51, -54]], step: 2.35, levels: 6, cross: 7,
  },
  {
    id: 'sausalito', name: 'Sausalito', style: 'shingle', both: false,
    inside: (x, z) => x > -31.5 && x < -23 && z > 22.4 && z < 32 && coastDistance(x, z) < -0.5,
    seeds: [[-26.4, 27.0]], step: 1.5, levels: 5, cross: 0, maxFall: 1.3,
  },
  {
    id: 'oakland-hills', name: 'The Oakland hills', style: 'stucco', both: true,
    inside: (x, z) => x > 61 && x < 74 && z > -44 && z < 34 && !(z > -12 && z < 2) && natural(x, z) < 6.4,
    seeds: [[62.5, -22]], step: 2.4, levels: 5, cross: 8,
  },
  {
    id: 'berkeley-hills', name: 'The Berkeley hills', style: 'shingle', both: true,
    inside: (x, z) => x > 61 && x < 74 && z > 4 && z < 36 && natural(x, z) < 6.4,
    seeds: [[62.2, 18]], step: 2.4, levels: 5, cross: 8,
  },
  {
    id: 'flats', name: 'Oakland', style: 'stucco', both: true,
    inside: (x, z) => coastDistance(x, z) < -0.9 && natural(x, z) < 2.6 && !(x < 66 && z > -11.5 && z < 0.5),
    grid: { x0: 57.4, x1: 66, z0: -66, z1: 38, blockX: 2.5, blockZ: 6 },
  },
];
const EXCELSIOR = blob(-20, -52.5, 11.5, 6.6, 1.1);
const WESTLAKE = blob(-51, -54, 8.5, 11, 2.3);

let TOWNS: Town[] | null = null;

/** The towns around the bay: Daly City and the Excelsior, Westlake, Sausalito, Oakland and Berkeley. */
export function backdropTowns(): Town[] {
  return (TOWNS ??= TOWN_SPECS.map(buildTown));
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
  const r = rngFor(spec.id);
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
  for (const [cx, cz] of pts) {
    if (inSignZone(cx, cz, 0.35)) return false;
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
export const EMBARCADERO: Pt[] = [
  [11.2, -21], [10.9, -12], [10.75, -3], [10.6, 3], [9.7, 7.4], [7, 8.8], [2, 9.5], [-4, 9.7], [-10, 9.8],
  [-14, 9.4], [-17, 10.3], [-20.5, 10.8], [-25, 9.6], [-29, 9.1], [-33, 8], [-34.6, 5.4],
];
export const GREAT_HIGHWAY: Pt[] = [[-39.6, -33], [-39.8, -20], [-39.9, -8], [-39, -2], [-37.5, 2]];
export const PRESIDIO_PKWY: Pt[] = [[-34.6, 5.4], [-34.2, 2.6], [-33, 0], [-32.5, -2.5]];
export const BAY_APPROACH: Pt[] = [[11.6, -6.5], [9.5, -6.8], [7.5, -7.5]];
export const AIRPORT_ROAD: Pt[] = [[11.2, -21], [12.6, -26], [14.4, -31], [16.4, -36]];
/** Extent of the world worth framing. */
export const WORLD = { x0: -50, x1: 18, z0: -40, z1: 46 } as const;
