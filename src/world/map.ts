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
  launch: { id: 'launch', x: 16.8, z: 42.8, r: 2.6, h: 0.25 },
  yerba: { id: 'yerba', x: 33, z: -7, r: 3.6, h: 3.2 },
  treasure: { id: 'treasure', x: 35.5, z: -0.5, r: 3.2, h: 0.25 },
  angel: { id: 'angel', x: -16, z: 38, r: 6.5, h: 6 },
};

// ─── Geometry helpers ───────────────────────────────────────────────────────

/** Signed distance to a polygon: negative inside, positive outside. */
export function polygonDistance(poly: readonly Pt[], x: number, z: number): number {
  let d = Infinity;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!;
    const [xj, zj] = poly[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    const ex = xj - xi;
    const ez = zj - zi;
    const t = Math.max(0, Math.min(1, ((x - xi) * ex + (z - zi) * ez) / (ex * ex + ez * ez || 1)));
    d = Math.min(d, Math.hypot(x - xi - ex * t, z - zi - ez * t));
  }
  return inside ? -d : d;
}

/** Distance to the nearest coast: negative on land, positive in the water. */
export function coastDistance(x: number, z: number): number {
  let d = Math.min(polygonDistance(MAINLAND, x, z), polygonDistance(MARIN, x, z), polygonDistance(EAST_BAY, x, z));
  for (const isl of Object.values(ISLANDS)) d = Math.min(d, Math.hypot(x - isl.x, z - isl.z) - isl.r);
  return d;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const bump = (x: number, z: number, cx: number, cz: number, r: number, h: number) => {
  const d = Math.hypot(x - cx, z - cz) / r;
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

/** Raw hills before they are flattened under the city. */
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
  .sort((a, b) => Math.hypot(a.bx, a.bz * 1.15) - Math.hypot(b.bx, b.bz * 1.15) || a.bx - b.bx || a.bz - b.bz);

/** Is (x, z) inside a block or on the road ring of one that's part of the city plan? */
function cityFlatness(x: number, z: number): number {
  let d = Infinity;
  for (const b of BLOCKS) {
    if (b.use === 'hill') continue;
    const c = blockCentre(b);
    const dx = Math.max(0, Math.abs(x - c.x) - 2.6);
    const dz = Math.max(0, Math.abs(z - c.z) - 2.6);
    d = Math.min(d, Math.hypot(dx, dz));
  }
  return d;
}

// ─── Terrain ───────────────────────────────────────────────────────────────

/** Water level; land at 0 is the city's ground. */
export const SEA = -0.55;

/**
 * Terrain height. The city is flat at 0; hills rise around it; beaches and
 * cliffs meet the bay; the sea floor drops away offshore.
 */
export function terrainHeight(x: number, z: number): number {
  const coast = coastDistance(x, z);
  const airport = Math.hypot(Math.max(0, AIRPORT.x0 - 1 - x, x - AIRPORT.x1 - 1), Math.max(0, AIRPORT.z0 - 1 - z, z - AIRPORT.z1 - 1));
  const flat = smooth(0.2, 2.6, cityFlatness(x, z)) * smooth(0, 3, airport);
  let h = hills(x, z) * flat;
  for (const isl of Object.values(ISLANDS)) {
    // Your island and its launch site are flat-topped rock (room for an estate and a pad); the rest are hills.
    const d = Math.hypot(x - isl.x, z - isl.z) / isl.r;
    h += isl.id === 'founder' || isl.id === 'launch' ? isl.h * (1 - smooth(0.62, 1, d)) : bump(x, z, isl.x, isl.z, isl.r, isl.h);
  }
  // Gentle rolling everywhere outside the city.
  h += flat * 0.25 * (Math.sin(x * 0.31) * Math.cos(z * 0.27) + 0.5 * Math.sin(x * 0.7 + z * 0.5));
  if (coast < 0) {
    // On land: ease down to a beach at the waterline.
    const shore = smooth(0, 2.2, -coast);
    return SEA + 0.12 + (Math.max(0, h) + (0 - SEA - 0.12)) * shore;
  }
  // Under water: shelve away.
  return SEA + 0.12 - Math.min(3, coast * 0.35);
}

/** Beach (sand) rather than grass: low, close to the sea, not in the city. */
export function isBeach(x: number, z: number): boolean {
  const c = coastDistance(x, z);
  // Islands get a narrow strand; the mainland, proper beaches.
  const island = Math.min(...Object.values(ISLANDS).map((i) => Math.hypot(x - i.x, z - i.z) - i.r));
  const band = island <= c + 0.01 ? 0.7 : 2.4;
  return c < 0 && c > -band && cityFlatness(x, z) > 0.5;
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
/** SFO-ish, on fill by the bay to the south-east. Free for everyone. */
export const AIRPORT = { x0: 16, x1: 28, z0: -50, z1: -36 } as const;
export const AIRPORT_SLOTS = [-47, -44.4, -41.8, -39.2].map((z) => ({ x: 19.2, z }));
export const RUNWAY = { x: 25.2, z0: -49.5, z1: -36.5 } as const;
/** Founder lots: on the HQ block, on Twin Peaks, on your island. */
export const DOWNTOWN_HOME = { x: -1.5, z: 1.5 } as const;
export const HILLS_HOME = { x: -6.6, z: -31.6 } as const;
/** TinyTown Hills: the slope of Twin Peaks below the sign, facing the city. */
export const HILLS_HOOD = { x0: -14, x1: -2, z0: -34, z1: -25 } as const;

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
