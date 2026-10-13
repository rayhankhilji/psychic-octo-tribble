import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../src/data/types.ts';
import {
  BLOCK,
  DISTRICTS,
  HOME_CAPACITY,
  HOMES_PER_NEIGHBOURHOOD,
  NEIGHBOURHOOD_BLOCKS,
  SETBACK,
  SIDEWALK,
  blockCentre,
  frontage,
  homeLots,
  lotRole,
  packHomeSeed,
  planWorld,
  readHomeSeed,
  treeLots,
} from '../src/world/layout.ts';

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({ t: 0, customers: 0, mrr: 0, releases: 0, commits: 0, ...over });
const plan = (over: Partial<Snapshot> = {}, peakMrr = 0) => planWorld(snap(over), { peakMrr, weather: 'clear' });

describe('planWorld', () => {
  it('builds an empty town around HQ before the first customer', () => {
    const p = plan();
    expect(p.homes).toHaveLength(0);
    expect(p.neighbourhoods).toHaveLength(0);
    expect(p.districts.every((d) => !d.unlocked)).toBe(true);
    expect(p.activeBlocks).toEqual([{ bx: 0, bz: 0 }]);
  });

  it('gives each customer a home and opens a neighbourhood every ten', () => {
    expect(plan({ customers: 1 }).homes).toHaveLength(1);
    expect(plan({ customers: 10 }).neighbourhoods).toHaveLength(1);
    expect(plan({ customers: 11 }).neighbourhoods).toHaveLength(2);
    expect(plan({ customers: 11 }).neighbourhoods[1]!.name).toBe('Hayes Hollow');
  });

  it('never moves an existing home when another customer arrives', () => {
    const before = plan({ customers: 37 }).homes;
    const after = plan({ customers: 38 }).homes;
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it('never loses homes as the population grows past the land', () => {
    let prev = 0;
    for (let c = HOME_CAPACITY - 5; c < HOME_CAPACITY * 6; c += 7) {
      const n = plan({ customers: c }).homes.length;
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
    expect(prev).toBe(HOME_CAPACITY);
  });

  it('only rebuilds homes when the whole city steps up a density tier', () => {
    // Home keys carry the kind, so a changed key means a rebuilt model.
    const keysAt = (c: number) => new Set(plan({ customers: c }).homes.map((h) => h.key));
    let changes = 0;
    let prev = keysAt(1);
    for (let c = 2; c < HOME_CAPACITY * 8; c += 3) {
      const now = keysAt(c);
      if ([...prev].some((k) => !now.has(k))) changes++;
      prev = now;
    }
    // Two steps: houses → some townhouses (2+ residents), then → some apartments (5+).
    expect(changes).toBe(2);
  });

  it('is deterministic', () => {
    expect(plan({ customers: 123, mrr: 4000, releases: 5 })).toEqual(plan({ customers: 123, mrr: 4000, releases: 5 }));
  });

  it('never puts two homes on the same lot, or a home on a tree lot', () => {
    const p = plan({ customers: HOME_CAPACITY });
    const spots = new Set(p.homes.map((h) => `${h.x},${h.z}`));
    expect(spots.size).toBe(HOME_CAPACITY);
    for (const h of p.homes) {
      const block = NEIGHBOURHOOD_BLOCKS[h.neighbourhood]!;
      const trees = treeLots(h.neighbourhood).map((l) => `${block.bx * 5 - 1.5 + l.i},${block.bz * 5 - 1.5 + l.j}`);
      expect(trees).not.toContain(`${h.x},${h.z}`);
    }
  });

  it('keeps every neighbourhood at ten homes', () => {
    for (let n = 0; n < 4; n++) expect(homeLots(n)).toHaveLength(HOMES_PER_NEIGHBOURHOOD);
  });

  it('densifies once the land is full, and says so', () => {
    const p = plan({ customers: HOME_CAPACITY * 3 + 1 });
    expect(p.residentsPerHome).toBe(4);
    expect(p.homes.length).toBeLessThanOrEqual(HOME_CAPACITY);
    expect(p.homes[0]!.kind).toBe('townhouse');
    expect(p.homes.at(-1)!.kind).toBe('house');
    const dense = plan({ customers: HOME_CAPACITY * 10 }).homes;
    expect(dense[0]!.kind).toBe('apartment');
    expect(new Set(dense.map((h) => h.kind))).toEqual(new Set(['apartment', 'townhouse', 'house']));
  });

  it('unlocks districts at MRR milestones and keeps them built after a dip', () => {
    const grown = plan({ mrr: 12_000 }, 12_000);
    expect(grown.districts.filter((d) => d.unlocked).map((d) => d.id)).toEqual(['market', 'arcade', 'techpark', 'midtown']);

    const dipped = plan({ mrr: 9_000 }, 12_000);
    const midtown = dipped.districts.find((d) => d.id === 'midtown')!;
    expect(midtown.unlocked).toBe(true);
    expect(midtown.lit).toBe(false);
  });

  it('adds an HQ floor per release, up to a cap', () => {
    expect(plan({ releases: 0 }).hqFloors).toBe(3);
    expect(plan({ releases: 4 }).hqFloors).toBe(7);
    expect(plan({ releases: 500 }).hqFloors).toBe(30);
  });

  it('places every district on its own block, away from homes', () => {
    const blocks = new Set(DISTRICTS.map((d) => `${d.bx},${d.bz}`));
    expect(blocks.size).toBe(DISTRICTS.length);
    for (const b of NEIGHBOURHOOD_BLOCKS) expect(blocks.has(`${b.bx},${b.bz}`)).toBe(false);
  });
});

describe('neighbourhood streets', () => {
  const full = plan({ customers: HOME_CAPACITY });
  const byBlock = new Map<number, typeof full.homes>();
  for (const h of full.homes) byBlock.set(h.neighbourhood, [...(byBlock.get(h.neighbourhood) ?? []), h]);

  /** A home's building in world space: its frontage across the lot, from the rear fence to the street wall. */
  const footprint = (h: (typeof full.homes)[number]) => {
    const { x0, x1 } = frontage(readHomeSeed(h.seed).role);
    const z0 = -0.5;
    const z1 = 0.5 - SETBACK;
    const c = Math.cos(h.rot);
    const s = Math.sin(h.rot);
    // Lot-local (x, z) → world, rotating about Y by h.rot.
    const pts = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(([x, z]) => [h.x + x! * c + z! * s, h.z - x! * s + z! * c] as const);
    return {
      minX: Math.min(...pts.map((p) => p[0])),
      maxX: Math.max(...pts.map((p) => p[0])),
      minZ: Math.min(...pts.map((p) => p[1])),
      maxZ: Math.max(...pts.map((p) => p[1])),
    };
  };

  it('builds every block as one street: its homes share a style seed, and blocks differ', () => {
    const streets = [...byBlock.values()].map((homes) => {
      const seeds = new Set(homes.map((h) => readHomeSeed(h.seed).street));
      expect(seeds.size).toBe(1);
      return [...seeds][0];
    });
    expect(new Set(streets).size).toBeGreaterThan(streets.length * 0.9);
  });

  it('still varies each home on a street', () => {
    for (const homes of byBlock.values()) expect(new Set(homes.map((h) => h.seed)).size).toBe(homes.length);
  });

  it('round-trips a home seed', () => {
    const h = { street: 0x2abcde, ring: 2, lot: 9, role: { street: -1, open: 1 } } as const;
    expect(readHomeSeed(packHomeSeed(h))).toEqual(h);
    expect(readHomeSeed(packHomeSeed({ ...h, role: { street: 0, open: 0 }, ring: 0 })).role).toEqual({ street: 0, open: 0 });
  });

  it('gives each block two corner homes whose side street really is outside the block', () => {
    for (const [n, homes] of byBlock) {
      const corners = homes.filter((h) => readHomeSeed(h.seed).role.street !== 0);
      expect(corners).toHaveLength(2);
      const c = blockCentre(NEIGHBOURHOOD_BLOCKS[n]!);
      for (const h of corners) {
        const side = readHomeSeed(h.seed).role.street;
        // Local +x in world space is (cos rot, −sin rot).
        const dx = Math.cos(h.rot) * side;
        const dz = -Math.sin(h.rot) * side;
        expect(Math.abs(h.x + dx * 0.5 - c.x) + Math.abs(h.z + dz * 0.5 - c.z)).toBeGreaterThan(Math.abs(h.x - c.x) + Math.abs(h.z - c.z));
        expect(Math.max(Math.abs(h.x + dx * 0.5 - c.x), Math.abs(h.z + dz * 0.5 - c.z))).toBeCloseTo(BLOCK / 2);
      }
    }
  });

  it('knows which homes flank a pocket park', () => {
    for (let n = 0; n < 4; n++) {
      const open = homeLots(n).filter((lot) => lotRole(n, lot).open !== 0);
      expect(open).toHaveLength(4);
      for (const lot of open) {
        const d = lotRole(n, lot).open;
        const i = lot.i + Math.round(Math.cos(lot.rot)) * d;
        const j = lot.j + Math.round(-Math.sin(lot.rot)) * d;
        expect(treeLots(n).some((t) => t.i === i && t.j === j)).toBe(true);
      }
    }
  });

  it('keeps every home behind the street wall on every street it touches', () => {
    for (const h of full.homes) {
      const c = blockCentre(NEIGHBOURHOOD_BLOCKS[h.neighbourhood]!);
      const f = footprint(h);
      const inner = BLOCK / 2 - SETBACK + 1e-9;
      expect(f.maxX).toBeLessThanOrEqual(c.x + inner);
      expect(f.minX).toBeGreaterThanOrEqual(c.x - inner);
      expect(f.maxZ).toBeLessThanOrEqual(c.z + inner);
      expect(f.minZ).toBeGreaterThanOrEqual(c.z - inner);
    }
    expect(SIDEWALK).toBeLessThan(SETBACK);
  });

  it('never lets two homes overlap', () => {
    for (const homes of byBlock.values()) {
      const fs = homes.map(footprint);
      for (let a = 0; a < fs.length; a++) {
        for (let b = a + 1; b < fs.length; b++) {
          const A = fs[a]!;
          const B = fs[b]!;
          const overlap = Math.min(A.maxX, B.maxX) - Math.max(A.minX, B.minX) > 1e-6 && Math.min(A.maxZ, B.maxZ) - Math.max(A.minZ, B.minZ) > 1e-6;
          expect(overlap).toBe(false);
        }
      }
    }
  });
});
