import { blockCentre } from '../world/layout.ts';
import { CIVIC_BLOCK } from '../world/map.ts';
import { pick, rng } from '../world/rng.ts';
import type { Built } from './buildings.ts';
import type { ColorLike } from './geo.ts';
import { FX, Kit, neonOf, people, pixelText, quadBlob } from './towers.ts';

/**
 * The city's mood, on Civic Center Plaza in front of City Hall: a street
 * festival when satisfaction is high, a protest when it's low. Both are
 * built around the plaza's layout in `landmarks.ts` (`cityHall`): lawns
 * either side of the fountain, two rows of plane trees, flagpoles to the east.
 */

/** The plaza's centre line (x) and middle (z). */
function plaza() {
  const c = blockCentre(CIVIC_BLOCK);
  return { x: c.x + 1.05, z: c.z };
}

const BUNTING = [0xe85a4a, 0xf2c84b, 0x3aa3c8, 0x3aa36a, 0xf4f1ea] as const;
const BULB: ColorLike = [2.6, 1.9, 1.0];

/** Strings of bulbs and bunting between the tree rows, food stalls, a little stage and a crowd. */
export function festival(seed: number): Built {
  const k = new Kit();
  const r = rng(seed);
  const { x: px, z } = plaza();
  // Seven strands across the plaza, tree to tree, sagging a little.
  for (let s = 0; s < 7; s++) {
    const sz = z - 1.55 + s * 0.52;
    const n = 12;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = px - 0.68 + t * 1.36;
      const y = 0.34 - 0.06 * Math.sin(Math.PI * t);
      quadBlob(neonOf(k), x, y, sz, 0.008, BULB, FX.chase + ((i + s) % 4) / 4);
      // A pennant under every other bulb, for the daytime.
      if (i % 2 && i < n) k.box(0.03, 0.03, 0.003, x + 0.05, y - 0.035, sz, pick(r, BUNTING), false, Math.PI / 4);
    }
  }
  // Food stalls along the walk in front of City Hall: striped roofs, a lit counter.
  for (const sz of [z - 1.25, z - 0.85, z + 0.85, z + 1.25]) {
    const sx = px - 0.44;
    const [a, b] = pick(r, [[0xe85a4a, 0xf4f1ea], [0x2f6fa8, 0xf4f1ea], [0x3aa36a, 0xf2e2b8]] as const);
    k.box(0.16, 0.07, 0.13, sx, 0.02, sz, 0xd8c8a8);
    for (let j = 0; j < 4; j++) k.box(0.18, 0.012, 0.0375, sx, 0.15, sz - 0.056 + j * 0.0375, j % 2 ? a : b);
    for (const dz of [-0.06, 0.06]) for (const dx of [-0.075, 0.075]) k.box(0.008, 0.13, 0.008, sx + dx, 0.02, sz + dz, 0x3a3f4a);
    neonOf(k).box(0.14, 0.012, 0.004, sx + 0.081, 0.08, sz, [1.8, 1.3, 0.7], true);
  }
  // A small stage between the flagpoles, facing the crowd, with a lit backdrop.
  const stx = px + 0.47;
  k.box(0.2, 0.05, 0.42, stx, 0.02, z, 0x2a2f38);
  k.box(0.02, 0.2, 0.42, stx + 0.09, 0.07, z, 0x1e2430);
  for (let j = 0; j < 6; j++) quadBlob(neonOf(k), stx + 0.078, 0.12 + (j % 2) * 0.08, z - 0.17 + j * 0.068, 0.01, pick(r, [[2.8, 0.9, 1.6], [0.9, 2.2, 2.8], [2.8, 2.2, 0.9]] as const), FX.shimmer + j * 0.1);
  people(k, r, stx - 0.02, z, 3, 0.1, 0.3, 0.07);
  // The crowd: on the lawns, around the fountain, queueing at the stalls.
  people(k, r, px + 0.05, z - 0.9, 16, 0.5, 1.1, 0.03);
  people(k, r, px + 0.05, z + 0.9, 16, 0.5, 1.1, 0.03);
  people(k, r, px - 0.3, z, 10, 0.12, 2.8, 0.02);
  return k.build();
}

/**
 * People on the steps of City Hall with placards and a banner that names
 * what's wrong. Shown with dignity: an orderly crowd, not a riot.
 */
export function protest(seed: number, banner: string): Built {
  const k = new Kit();
  const r = rng(seed);
  const { x: px, z } = plaza();
  const cx = px - 0.42;
  const placards = [0xf4f1ea, 0xf2e2b8, 0xf2c84b, 0xe8e2d6] as const;
  // The crowd faces City Hall (west); some hold placards up on sticks.
  for (let i = 0; i < 26; i++) {
    const x = cx + (r() - 0.5) * 0.3;
    const pz = z + (r() - 0.5) * 1.1;
    people(k, r, x, pz, 1, 0, 0, 0.02);
    if (r() < 0.55) {
      k.box(0.004, 0.06, 0.004, x, 0.06, pz, 0x8a6a4a);
      k.box(0.006, 0.04, 0.06, x, 0.1, pz, pick(r, placards), false, (r() - 0.5) * 0.4);
      // A few marker strokes on the side facing the plaza
      k.box(0.001, 0.006, 0.04, x + 0.0035, 0.125, pz, 0x2a2f38);
      k.box(0.001, 0.006, 0.03, x + 0.0035, 0.112, pz, 0xc8402e);
    }
  }
  // The banner, held across the front of the crowd toward the plaza.
  const bx = cx + 0.2;
  for (const s of [-1, 1]) k.box(0.006, 0.14, 0.006, bx, 0.02, z + s * 0.22, 0x8a6a4a);
  k.box(0.004, 0.065, 0.46, bx, 0.085, z, 0xf4f1ea);
  pixelText(k, 'solid', banner, bx + 0.0025, 0.118, z, 1, 0, 0.0055, 0xc8402e);
  people(k, r, bx - 0.02, z, 4, 0.02, 0.44, 0.02);
  return k.build();
}

/** What the placards say: the weakest part of satisfaction. */
export function protestBanner(weakest: 'housing' | 'upkeep' | 'amenities' | 'momentum'): string {
  return { housing: 'HOMES FOR ALL', upkeep: 'FIX OUR CITY', amenities: 'MORE PARKS', momentum: 'GROW OR GO' }[weakest];
}
