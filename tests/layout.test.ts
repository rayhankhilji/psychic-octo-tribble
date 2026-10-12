import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../src/data/types.ts';
import {
  DISTRICTS,
  HOME_CAPACITY,
  HOMES_PER_NEIGHBOURHOOD,
  NEIGHBOURHOOD_BLOCKS,
  homeLots,
  planWorld,
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
