/**
 * Every founder's world, from a seed. Pure data, no geometry queries: the
 * coastlines, the islands, where the Golden Gate crosses, the shape of Twin
 * Peaks, the park plan, which landmarks a city has, and its look. `map.ts`
 * turns this into terrain, blocks and plans, and checks the result (the same
 * plot count, every block on dry land), asking for another attempt if a
 * draw doesn't fit.
 *
 * Seed 0 is the classic map, written out by hand: the demo and every
 * screenshot of it stay exactly as they were.
 *
 * Every world shares the same skeleton, so all of them read as a bay city and
 * every unlock has a place: downtown and Market Street by the Ferry Building,
 * the Bay Bridge to Yerba Buena and Oakland, the airport on its fill, a strait
 * to the ocean with a suspension bridge to the headlands, hills behind the
 * city with the sign on them, a pier and a marina on the north shore, and
 * your island far out in the bay.
 */
import { hash, rng } from './rng.ts';

export type Pt = readonly [number, number];

export interface Island {
  id: string;
  x: number;
  z: number;
  r: number;
  /** Peak height above the water. */
  h: number;
}

/** A hill: centre, radius, height. */
export type Bump = readonly [number, number, number, number];

/** Where the city's big park goes: a long strip from the ocean (Golden Gate Park), or a block of green with a lake. */
export type ParkTemplate = { kind: 'strip'; row: number; length: number } | { kind: 'central'; bx0: number; bz0: number; w: number; h: number };

export interface Look {
  /** Ground: a small hue and lightness shift for lawns and grass, and how dry (golden) the open hills are. */
  grassHue: number;
  grassLight: number;
  dryness: number;
  /** House families by home kind, in pick order (repeats weight a family). */
  houses: { ring2: readonly string[]; inner: readonly string[]; townhouse: readonly string[]; apartment: readonly string[] };
  /** Indices into the painted-lady colour table this city paints with (empty: all of them). */
  paints: readonly number[];
  /** Park and meadow trees, in pick order. */
  parkTrees: readonly string[];
  /** Yard and street trees on the residential blocks, in pick order. */
  yardTrees: readonly string[];
  /** Roofs: slate greys, warm clay, or a mix. */
  roofs: 'classic' | 'slate' | 'clay';
}

export interface WorldSpec {
  seed: number;
  /** The hand-made map: every derived plan keeps its classic, hand-tuned form. */
  classic: boolean;
  /** Where the Golden Gate crosses the strait, along z from the Presidio to Marin. */
  gg: { x: number; z0: number; z1: number };
  mainland: Pt[];
  marin: Pt[];
  eastBay: Pt[];
  islands: Record<'founder' | 'launch' | 'yerba' | 'treasure' | 'angel', Island>;
  /** Your island's layout in its own frame (x offsets turn with `flip`, so the cove can face either way). */
  estate: {
    flip: 1 | -1;
    /** Phase of the island's wobbly outline. */
    wobble: number;
    cove: { dx: number; dz: number; r: number };
    yacht: { dx: number; dz: number };
    knolls: readonly Bump[];
  };
  /** The street grid's extent, in blocks. */
  grid: { bx0: number; bx1: number; bz0: number; bz1: number };
  /** The line Ocean Beach runs along, and the cliff point (the Cliff House) north of it. */
  beachX: number;
  /** Hills inside the city: Telegraph Hill, the Presidio rise, Lands End. */
  cityBumps: Bump[];
  /** The backdrop: San Bruno Mountain and the south, the Marin Headlands, the East Bay hills. */
  farBumps: Bump[];
  /** Twin Peaks: its centre, summits, Mount Sutro and Mount Davidson, the foothill apron. */
  peaks: {
    centre: { x: number; z: number };
    summits: { x: number; z: number; h: number }[];
    sutro: Bump | null;
    davidson: Bump | null;
    /** How far the massif's long face reaches toward the city (classic 15.6). */
    face: number;
  };
  /** The heights the Hills streets hold along their contours. */
  levels: { avenue: number; panorama: number; upper: number; glen: number };
  /** Hairpins up to the higher streets. */
  hillStreets: { upper: boolean; glen: boolean };
  /** Telegraph Hill, if this city has one. */
  telegraph: { x: number; z: number } | null;
  /** Where the sign stands across the face of the peaks: how far along the ridge (south-east) from the end of Market, beyond the classic 10.5. */
  signU: number;
  /** Blocks of Presidio beyond the corner where the Golden Gate lands, along the north row. */
  presidio: { extra: number };
  park: ParkTemplate;
  /** Optional landmarks this city has. */
  has: { coit: boolean; palace: boolean; windmill: boolean; conservatory: boolean; cliffHouse: boolean; sutro: boolean };
  /** The pier (Pier 39) and the Marina, along the north shore. */
  pierX: number;
  marinaX: number;
  /** Backdrop towns: how far each moves from its classic place, and its style. */
  towns: Record<string, { dx: number; dz: number; style?: 'stucco' | 'shingle' }>;
  look: Look;
}

const CLASSIC_LOOK: Look = {
  grassHue: 0,
  grassLight: 0,
  dryness: 1,
  houses: {
    ring2: ['cottage', 'marina', 'cottage', 'sunset'],
    inner: ['sunset', 'sunset', 'marina', 'cottage'],
    townhouse: ['italianate', 'queen', 'queen', 'stick'],
    apartment: ['edwardian', 'edwardian', 'brick', 'deco'],
  },
  paints: [],
  parkTrees: ['round', 'cypress', 'palm'],
  yardTrees: ['round', 'plane', 'ficus', 'palm', 'round', 'pine'],
  roofs: 'classic',
};

/** The classic map, exactly as it was drawn by hand. */
export function classicWorld(): WorldSpec {
  return {
    seed: 0,
    classic: true,
    gg: { x: -34.6, z0: 10.2, z1: 21.2 },
    mainland: [
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
    ],
    marin: [
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
    ],
    eastBay: [
      [64, 60],
      [58, 30],
      [56, 0],
      [57, -30],
      [62, -70],
      [70, -110],
      [140, -110],
      [140, 60],
    ],
    islands: {
      // Your island sits well out in the bay, north of the shipping lane: you fly there (helicopter or jet).
      founder: { id: 'founder', x: 12, z: 39, r: 4.5, h: 1.2 },
      // South-west of the estate, behind it from the north-east camera, so the rocket never stands in front of the house.
      launch: { id: 'launch', x: 7.7, z: 34.5, r: 2.6, h: 0.25 },
      yerba: { id: 'yerba', x: 33, z: -7, r: 3.6, h: 3.2 },
      treasure: { id: 'treasure', x: 35.5, z: -0.5, r: 3.2, h: 0.25 },
      angel: { id: 'angel', x: -16, z: 38, r: 6.5, h: 6 },
    },
    estate: {
      // The cove faces east, towards the camera, so the jetty and the superyacht are in view.
      flip: -1,
      wobble: 1.3,
      cove: { dx: 4.75, dz: -1.15, r: 1.75 },
      yacht: { dx: 5.1, dz: -1.4 },
      knolls: [
        [-3.0, 2.9, 1.9, 0.75],
        [-1.4, 3.6, 1.6, 0.35],
      ],
    },
    grid: { bx0: -7, bx1: 1, bz0: -6, bz1: 1 },
    beachX: -44.2,
    cityBumps: [
      [-5, 6, 3.4, 2.4], // Telegraph Hill
      [-36, 3, 9, 1.4], // the Presidio
      [-44, 2, 5, 2.6], // Lands End
    ],
    farBumps: [
      [-6, -66, 26, 11],
      [-40, -52, 16, 5],
      [12, -58, 14, 4],
      [-48, 34, 22, 13],
      [-30, 40, 14, 9],
      [-70, 30, 18, 10],
      [92, -10, 40, 16],
      [80, 40, 30, 12],
    ],
    peaks: {
      centre: { x: -14, z: -36 },
      summits: [
        { x: -16.4, z: -35.4, h: 9.6 },
        { x: -11.8, z: -39.8, h: 9.1 },
      ],
      sutro: [-23, -35, 6.5, 4.4],
      davidson: [-5, -44.5, 6.5, 3.4],
      face: 15.6,
    },
    levels: { avenue: 1.15, panorama: 2.05, upper: 3.15, glen: 2.45 },
    hillStreets: { upper: true, glen: true },
    telegraph: { x: -5, z: 6 },
    signU: 0,
    presidio: { extra: 1 },
    park: { kind: 'strip', row: -3, length: 5 },
    has: { coit: true, palace: true, windmill: true, conservatory: true, cliffHouse: true, sutro: true },
    pierX: -8.4,
    marinaX: -21.4,
    towns: {},
    look: CLASSIC_LOOK,
  };
}

/** Along the ridge of the peaks (north-west to south-east) and down its face toward the city (north-east). */
const U: Pt = [Math.SQRT1_2, -Math.SQRT1_2];
const V: Pt = [Math.SQRT1_2, Math.SQRT1_2];

/**
 * A seeded world. `attempt` re-draws a layout that didn't fit (map.ts checks
 * every draw and asks again); the same seed and attempt always give the same world.
 */
export function generateWorld(seed: number, attempt = 0): WorldSpec {
  if (seed === 0) return classicWorld();
  const r = rng(hash('world', seed, attempt));
  const range = (a: number, b: number) => a + (b - a) * r();
  const chance = (p: number) => r() < p;
  const choose = <T>(items: readonly T[]): T => items[Math.floor(r() * items.length)]!;
  const base = classicWorld();

  // ─── The strait and the Golden Gate ──────────────────────────────────────
  const gx = -34.6 + range(-2.6, 4.4);
  const dg = gx + 34.6;

  // ─── The ocean shore: Ocean Beach, the cliffs, Lands End ─────────────────
  // Some cities run a block further west (a wider Sunset and Richmond), with the beach out beyond.
  const wide = chance(0.3);
  const xb = wide ? range(-47.4, -46.3) : range(-45.6, -42.9);
  const lands = range(-0.8, 1.2);
  const west: Pt[] = [
    [-52 + range(-2, 2), -44], // Fort Funston
    [-46.5 + (xb + 44.2) * 0.7, -34],
  ];
  // A point of rocks halfway up the beach, or a long straight strand.
  if (chance(0.45)) {
    const zp = range(-24, -14);
    west.push([xb - 0.2, zp - 3.5], [xb - range(1.0, 1.8), zp], [xb - 0.1, zp + 3.2]);
  } else west.push([xb - 0.3, -20]);
  west.push([xb, -6], [xb - 3.3, -1]); // the Cliff House point

  // ─── The north shore: Crissy Field, the Marina, Fort Mason, the Wharf ────
  // Now and then the shore runs out into a broad point with a row of homes on it, the pier off its tip (North Point).
  const point = chance(0.35) ? choose([-2, -1]) : null;
  const marinaX = point === -1 ? range(-24.2, -17.2) : point === -2 ? range(-24.2, -22.2) : range(-24.2, -18.6);
  const pierX = point !== null ? 5 * point + range(-0.4, 0.4) : range(-12.8, -5.2);
  const hm = range(1.1, 2.4);
  // Features along the shore: [x, height above the base line]; the line is smoothed afterwards.
  const north: [number, number][] = [
    [gx + 5.6, -0.4], // Crissy Field
    [marinaX - 3.4, 0],
    [marinaX + 0.4, hm], // the Marina
    [marinaX + 2.9, hm - range(0.1, 0.5)], // Fort Mason
    [marinaX + 4.9, 0],
  ];
  if (point !== null) {
    // The point: broad enough for its block, the Embarcadero round it, and a beach.
    const xl = 5 * point - 2.5;
    const xr = 5 * point + 2.5;
    north.push([xl - 6.6, 0], [xl - 4.4, 3.9], [xl - 2.0, 5.3], [(xl + xr) / 2, 5.5], [xr + 2.0, 5.3], [xr + 4.4, 3.9], [xr + 6.6, 0]);
  } else {
    // A headland: a wooded point between the Presidio and the Marina, or past the pier.
    if (chance(0.6)) {
      const westward = chance(0.5) && marinaX - 3.4 - (gx + 5.6) > 6;
      const cx = westward ? (gx + 5.6 + marinaX - 3.4) / 2 : pierX + range(5.5, 8);
      const w = range(1.8, 2.8);
      north.push([cx - w, 0.1], [cx, range(1.8, 3.4)], [cx + w, 0.1]);
    }
    north.push([pierX - 3.2, -0.2], [pierX - 0.6, 0.4], [pierX + 2.6, 0.4]);
  }
  north.push([4, 0]);
  north.sort((a, b) => a[0] - b[0]);
  // Drop features that crowd each other, and end at the corner by the Ferry Building.
  const shore: [number, number][] = [];
  for (const p of north) if (p[0] < 6.5 && (!shore.length || p[0] - shore.at(-1)![0] > 1.2)) shore.push(p);
  shore.push([8.6, -1.2]);
  const northPts = smoothShore(shore.map(([x, h]) => [x, 10.6 + h] as Pt), gx + 0.6);

  const mainland: Pt[] = [
    [xb - 1.8 + lands, 3.5], // Lands End
    [gx - 8.9 + range(-0.6, 0.6), 7.5],
    [gx - 3.9, 10.2],
    [gx + 0.6, 10.8], // Fort Point
    ...northPts,
    [11, 6.6],
    [11.6, 1],
    [11.8, -6],
    [11.4, -14],
    [12.6, -22],
    [15.5 + range(-0.6, 1.2), -28],
    [17.5 + range(-0.5, 1.2), -34],
    [24, -40],
    [26, -52],
    [32, -70],
    [36, -110],
    [-70, -110],
    [-64, -60],
    ...west,
  ];

  // ─── Marin: the headlands, Sausalito, maybe Tiburon reaching into the bay ─
  const sx = range(-1.4, 1.6);
  const sz = range(-0.8, 0.8);
  const marin: Pt[] = [
    [-95, 18],
    [-60, 17.5 + range(-1, 1)],
    [gx - 9.4, 19.6 + range(-0.3, 0.5)],
    [gx - 0.9, 20],
    [gx + 4.6 + sx * 0.5, 22.5 + range(-0.4, 0.6)],
    [gx + 9.1 + sx, 27 + sz], // Sausalito
  ];
  const tiburon = chance(0.4);
  if (tiburon) marin.push([gx + 10.6 + sx, 31], [gx + 15.5 + range(0, 2), 33.6], [gx + 13.2 + sx, 36.2]);
  else marin.push([gx + 11.6 + range(-1, 1), 34]);
  marin.push([gx + 7.6, 46], [-40, 80], [-95, 80]);

  // ─── The East Bay ─────────────────────────────────────────────────────────
  const eastBay: Pt[] = [
    [64 + range(-2, 1.5), 60],
    [58 + range(-1.5, 0.8), 30],
    [56, 0],
    [57 + range(-1, 0.8), -30],
    [62 + range(-2, 1.5), -70],
    [70, -110],
    [140, -110],
    [140, 60],
  ];

  // ─── Islands: Angel Island off Marin, yours far out in the bay ───────────
  const angel = { id: 'angel', x: gx + range(13, 22) + (tiburon ? 2.5 : 0), z: range(35.5, 40.5), r: range(5.2, 6.8), h: range(4.6, 6.6) };
  // Clear of the pier's end (further out when it stands on the point).
  const tip = point !== null ? 26.8 : 22;
  if (Math.abs(angel.x - pierX) < angel.r + 3) angel.z = Math.max(angel.z, tip + angel.r + 3.5);
  const fr = range(4.2, 4.8);
  const flip: 1 | -1 = chance(0.5) ? 1 : -1;
  let fx = range(4, 18.5);
  // Keep a wide channel between your island and Angel Island.
  if (Math.abs(fx - angel.x) < angel.r + fr + 6) fx = angel.x + angel.r + fr + 6;
  const founder = { id: 'founder', x: Math.min(19, fx), z: range(37.5, 40.2), r: fr, h: range(1.1, 1.3) };
  // The launch site: round the estate's far side, never between the north-east camera and the house.
  let turn = range(-0.35, 0.35);
  const lx = 4.3 * flip;
  const lz = -4.5;
  const scale = fr / 4.5;
  // Turned away from the camera's side, never toward it (with the cove west, that means clockwise).
  if (flip === 1) turn = -Math.abs(turn);
  const launch = {
    id: 'launch',
    x: founder.x + (lx * Math.cos(turn) - lz * Math.sin(turn)) * scale,
    z: founder.z + (lx * Math.sin(turn) + lz * Math.cos(turn)) * scale,
    r: 2.6,
    h: 0.25,
  };

  // ─── Twin Peaks ──────────────────────────────────────────────────────────
  const pu = range(-3.2, 3.2);
  const pv = range(-1.4, 0.3);
  const centre = { x: -14 + pu * U[0] + pv * V[0], z: -36 + pu * U[1] + pv * V[1] };
  const at = (u: number, v: number) => ({ x: centre.x + u * U[0] + v * V[0], z: centre.z + u * U[1] + v * V[1] });
  const a = range(1.6, 3.6);
  const b = range(3.2, 5.0);
  const summits = [
    { ...at(-a, range(-1.6, -0.8)), h: range(8.8, 10.4) },
    { ...at(b, range(-1.6, -0.8)), h: range(8.4, 10.0) },
  ];
  // Now and then a third, lower summit at one end of the ridge.
  if (chance(0.3)) {
    const end = chance(0.5) ? -a - range(3.2, 4.2) : b + range(3.2, 4.2);
    summits.push({ ...at(end, range(-1.2, 0)), h: range(6.8, 7.8) });
  }
  const sutroEnd = chance(0.75) ? -1 : 1;
  const sutroAt = at(sutroEnd < 0 ? -range(6.5, 8.2) : range(8, 9.5), -range(4.5, 6.2));
  const sutro: Bump | null = chance(0.85) ? [sutroAt.x, sutroAt.z, range(5.8, 7), range(3.8, 4.8)] : null;
  const davidAt = at(sutroEnd < 0 ? range(10.5, 13) : -range(9, 11), range(-0.5, 1));
  const davidson: Bump | null = chance(0.7) ? [davidAt.x, davidAt.z, range(5.5, 7), range(2.8, 3.8)] : null;

  const avenue = range(1.0, 1.3);
  const panorama = avenue + range(0.82, 1.0);
  const levels = { avenue, panorama, upper: panorama + range(1.0, 1.2), glen: avenue + range(1.15, 1.45) };

  // ─── Inside the city ─────────────────────────────────────────────────────
  const telegraph = chance(0.75) ? { x: 5 * choose([-4, -3, -2, -1]), z: 6 } : null;
  const cityBumps: Bump[] = [];
  if (telegraph) cityBumps.push([telegraph.x, telegraph.z, 3.4, range(2.0, 2.7)]);
  // The Presidio's rolling ground: kept west of the street the Presidio Parkway comes down to, so that corner stays flat.
  const pkwy = 5 * Math.round((gx - 0.4) / 5) + 2.5;
  cityBumps.push([Math.min(gx - 1.4, pkwy - 3.6), 3, 9, range(1.0, 1.4)], [xb + 0.2, 2, 5, range(2.2, 3.0)]);

  // The backdrop hills move and grow a little; the East Bay's (where Oakland and Berkeley climb) hardly at all.
  const vary = (bp: Bump, dx: number, k: number): Bump => [bp[0] + dx + range(-3, 3) * k, bp[1] + range(-3, 3) * k, bp[2], bp[3] * (1 + range(-0.15, 0.15) * k)];
  const farBumps = base.farBumps.map((bp, i) => vary(bp, i >= 3 && i <= 5 ? dg : 0, i >= 6 ? 0.25 : 1));

  // ─── Parks ───────────────────────────────────────────────────────────────
  const park: ParkTemplate = chance(0.62)
    ? { kind: 'strip', row: choose([-4, -3, -3, -2, -2]), length: choose([4, 5, 5, 6]) }
    : { kind: 'central', bx0: choose([-6, -5, -5, -4]), bz0: choose([-4, -3, -2, -1]), w: 2, h: choose([2, 2, 3]) };

  // ─── Landmarks: every city gets a few, never quite the same set ──────────
  const has = {
    coit: !!telegraph && chance(0.8),
    palace: chance(0.6),
    windmill: park.kind === 'strip' && chance(0.75),
    conservatory: chance(0.65),
    cliffHouse: chance(0.6),
    sutro: !!sutro && chance(0.85),
  };
  // At least three of them, never all six: every city is recognisably itself.
  const eligible = (['palace', 'conservatory', 'cliffHouse', 'coit', 'windmill', 'sutro'] as const).filter((k) => (k !== 'coit' || telegraph) && (k !== 'windmill' || park.kind === 'strip') && (k !== 'sutro' || sutro));
  const count = () => Object.values(has).filter(Boolean).length;
  for (let i = 0; count() < 3 && i < 12; i++) has[choose(eligible)] = true;
  while (count() > 5) has[choose(eligible)] = false;

  const towns: WorldSpec['towns'] = {
    excelsior: { dx: pu * U[0] * 0.6 + range(-1.5, 1.5), dz: pu * U[1] * 0.6 + range(-1, 1), style: chance(0.25) ? 'shingle' : 'stucco' },
    westlake: { dx: (xb + 44.2) * 0.5 + range(-1, 1), dz: range(-1.5, 1.5) },
    sausalito: { dx: dg + sx, dz: sz, style: chance(0.2) ? 'stucco' : 'shingle' },
    'oakland-hills': { dx: 0, dz: 0, style: chance(0.3) ? 'shingle' : 'stucco' },
    'berkeley-hills': { dx: 0, dz: 0, style: chance(0.3) ? 'stucco' : 'shingle' },
  };

  return {
    seed,
    classic: false,
    gg: { x: gx, z0: 10.2, z1: 21.2 },
    mainland,
    marin,
    eastBay,
    islands: { founder, launch, yerba: base.islands.yerba, treasure: base.islands.treasure, angel },
    estate: {
      flip,
      wobble: range(0, Math.PI * 2),
      cove: { dx: -4.75 * flip, dz: -1.15, r: 1.75 },
      yacht: { dx: -5.1 * flip, dz: -1.4 },
      knolls: [
        [-3.0 * flip + range(-0.4, 0.4), 2.9, range(1.6, 2.1), range(0.55, 0.9)],
        [-1.4 * flip + range(-0.5, 0.5), 3.6, range(1.3, 1.8), range(0.25, 0.45)],
      ],
    },
    grid: { bx0: wide ? -8 : -7, bx1: 1, bz0: -6, bz1: point !== null ? 2 : 1 },
    beachX: xb,
    cityBumps,
    farBumps,
    peaks: { centre, summits, sutro, davidson, face: range(14.5, 16.5) },
    levels,
    hillStreets: { upper: chance(0.7), glen: chance(0.75) },
    telegraph,
    signU: range(-0.9, 0.9),
    presidio: { extra: choose([0, 1, 1, 2]) },
    park,
    has,
    pierX,
    marinaX,
    towns,
    look: lookFor(r),
  };
}

/** The north shore through its features, as a smooth line west to east, starting just east of Fort Point. */
function smoothShore(ctrl: readonly Pt[], x0: number): Pt[] {
  const pts = ctrl.filter(([x]) => x > x0 + 1.5);
  const out: Pt[] = [];
  const P = (i: number) => pts[Math.max(0, Math.min(pts.length - 1, i))]!;
  for (let i = 0; i < pts.length - 1; i++) {
    const [p0, p1, p2, p3] = [P(i - 1), P(i), P(i + 1), P(i + 2)];
    const n = Math.max(2, Math.ceil((p2[0] - p1[0]) / 0.9));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      // Never below the line the Embarcadero needs (east of the Wharf the shore turns south toward the Ferry Building).
      const x = f(p0[0], p1[0], p2[0], p3[0]);
      out.push([x, Math.max(x < 4.5 ? 10.25 : 9.4, f(p0[1], p1[1], p2[1], p3[1]))]);
    }
  }
  out.push(pts.at(-1)!);
  return out;
}

/** A city's character: its greens, its houses, its paint, its trees. */
function lookFor(r: () => number): Look {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(r() * items.length)]!;
  const character = pick(['sunset', 'victorian', 'mediterranean', 'edwardian', 'garden'] as const);
  const houses: Look['houses'] = {
    sunset: {
      ring2: ['sunset', 'cottage', 'sunset', 'marina'],
      inner: ['sunset', 'sunset', 'sunset', 'marina'],
      townhouse: ['italianate', 'stick', 'queen', 'italianate'],
      apartment: ['deco', 'edwardian', 'deco', 'brick'],
    },
    victorian: {
      ring2: ['cottage', 'cottage', 'marina', 'sunset'],
      inner: ['cottage', 'marina', 'cottage', 'sunset'],
      townhouse: ['queen', 'queen', 'stick', 'queen'],
      apartment: ['edwardian', 'edwardian', 'edwardian', 'brick'],
    },
    mediterranean: {
      ring2: ['marina', 'marina', 'sunset', 'cottage'],
      inner: ['marina', 'sunset', 'marina', 'marina'],
      townhouse: ['italianate', 'italianate', 'queen', 'stick'],
      apartment: ['deco', 'deco', 'edwardian', 'brick'],
    },
    edwardian: {
      ring2: ['cottage', 'sunset', 'cottage', 'marina'],
      inner: ['sunset', 'cottage', 'marina', 'sunset'],
      townhouse: ['stick', 'italianate', 'stick', 'queen'],
      apartment: ['brick', 'edwardian', 'brick', 'deco'],
    },
    garden: {
      ring2: ['cottage', 'cottage', 'cottage', 'marina'],
      inner: ['sunset', 'cottage', 'marina', 'cottage'],
      townhouse: ['queen', 'italianate', 'stick', 'stick'],
      apartment: ['edwardian', 'brick', 'edwardian', 'deco'],
    },
  }[character];
  // Paint: a run of the painted-lady colours (12 in all), so each city has its own scheme.
  const start = Math.floor(r() * 12);
  const paints = Array.from({ length: 7 }, (_, i) => (start + i * (r() < 0.5 ? 1 : 5)) % 12);
  const trees = pick([
    { park: ['round', 'cypress', 'palm', 'round'], yard: ['round', 'plane', 'ficus', 'palm'] },
    { park: ['round', 'round', 'cypress', 'plane'], yard: ['plane', 'plane', 'round', 'pine'] },
    { park: ['cypress', 'pine', 'round', 'cypress'], yard: ['pine', 'round', 'plane', 'ficus'] },
    { park: ['palm', 'round', 'palm', 'ficus'], yard: ['palm', 'ficus', 'palm', 'round'] },
    { park: ['eucalyptus', 'round', 'cypress', 'eucalyptus'], yard: ['ficus', 'round', 'plane', 'round'] },
  ] as const);
  return {
    grassHue: (r() - 0.5) * 0.035,
    grassLight: (r() - 0.5) * 0.04,
    dryness: 0.62 + r() * 0.76,
    houses,
    paints,
    parkTrees: trees.park,
    yardTrees: trees.yard,
    roofs: pick(['classic', 'slate', 'clay'] as const),
  };
}
