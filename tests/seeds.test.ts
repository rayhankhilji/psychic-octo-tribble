import { afterAll, describe, expect, it } from 'vitest';
import { setWorldSeed } from '../src/world/seed.ts';
import {
  AIRPORT_SLOTS,
  BLOCKS,
  BUILD_BLOCK_COORDS,
  CIVIC_BLOCK,
  EMBARCADERO,
  GREAT_HIGHWAY,
  GRID,
  HAS,
  HELIPAD,
  HILLS_HOME,
  ISLANDS,
  LANDMARKS,
  MARINA_SLOTS,
  MARKET_END,
  NEIGHBOURHOOD_BLOCKS,
  NEIGHBOURHOOD_COUNT,
  PARKS,
  PIER,
  PRESIDIO_PKWY,
  SUPERYACHT,
  WORLD,
  WORLD_SPEC,
  backdropTowns,
  blockCentre,
  coastDistance,
  hillsPlan,
  inSignZone,
  terrainHeight,
} from '../src/world/map.ts';
import { bayRoutes } from '../src/world/routes.ts';
import { HOME_CAPACITY, planWorld } from '../src/world/layout.ts';
import { BUILD_BLOCKS, REGIONS } from '../src/game/catalog.ts';
import { simulate, type Action } from '../src/game/economy.ts';
import type { Snapshot } from '../src/data/types.ts';

/** Fifty worlds, plus a few far-off seeds. */
const SEEDS = [...Array.from({ length: 50 }, (_, i) => i + 1), 977, 31337, 2 ** 31 - 1];

const level = (x: number, z: number, r: number) => {
  const hs: number[] = [];
  for (let a = 0; a < 8; a++) for (const d of [0, r / 2, r]) hs.push(terrainHeight(x + Math.cos(a) * d, z + Math.sin(a) * d));
  return Math.max(...hs) - Math.min(...hs);
};

const STREET_USES = new Set(['city', 'market', 'hq', 'civic']);

/** How far (x, z) is inside the nearest street block's footprint and its ring of road (positive: inside). */
const intoStreets = (x: number, z: number) => {
  let worst = -Infinity;
  for (const b of BLOCKS) {
    if (!STREET_USES.has(b.use)) continue;
    const c = blockCentre(b);
    worst = Math.max(worst, 3 - Math.max(Math.abs(x - c.x), Math.abs(z - c.z)));
  }
  return worst;
};

afterAll(() => setWorldSeed(0));

describe('seeded worlds', () => {
  it('give every founder the same economy, whatever the seed', () => {
    const days: Snapshot[] = Array.from({ length: 120 }, (_, t) => ({ t, customers: t * 4, mrr: t * t * 2, releases: Math.floor(t / 20), commits: t }));
    const actions: Action[] = [
      { t: 3, kind: 'build', item: 'corner-shops', plot: 'market:0' },
      { t: 5, kind: 'build', item: 'park', plot: 'market:1' },
      { t: 60, kind: 'build', item: 'coworking', plot: 'arcade:2' },
    ];
    setWorldSeed(0);
    const classic = JSON.stringify(simulate(days, actions, 119));
    const blocks = JSON.stringify(BUILD_BLOCKS);
    for (const seed of [1, 7, 42]) {
      setWorldSeed(seed);
      expect(JSON.stringify(simulate(days, actions, 119))).toBe(classic);
      expect(JSON.stringify(BUILD_BLOCKS)).toBe(blocks);
      expect(HOME_CAPACITY).toBe(NEIGHBOURHOOD_COUNT * 10);
    }
    expect(Object.keys(REGIONS)).toEqual(['hills', 'pier', 'marina', 'island', 'launchpad']);
  }, 60_000);

  it('are deterministic', () => {
    const snap = () => JSON.stringify({ BLOCKS, NEIGHBOURHOOD_BLOCKS, LANDMARKS, PIER, HILLS_HOME, ISLANDS, plan: hillsPlan().streets.map((s) => s.pts.length), EMBARCADERO });
    for (const seed of [3, 17, 4242]) {
      setWorldSeed(seed);
      const a = snap();
      setWorldSeed(seed + 1);
      setWorldSeed(seed);
      expect(snap()).toBe(a);
    }
  }, 60_000);

  it('differ from each other', () => {
    const looks = new Set<string>();
    for (const seed of SEEDS.slice(0, 20)) {
      setWorldSeed(seed);
      expect(WORLD_SPEC.seed).toBe(seed);
      expect(WORLD_SPEC.classic).toBe(false);
      looks.add(BLOCKS.map((b) => b.use[0]).join('') + LANDMARKS.goldenGate.x.toFixed(1));
    }
    expect(looks.size).toBe(20);
  }, 60_000);

  for (const seed of SEEDS) {
    it(`seed ${seed}: same plots, a whole city on dry flat land, every region in place`, () => {
      setWorldSeed(seed);
      // The same land for homes and the same downtown plots in every world.
      expect(NEIGHBOURHOOD_BLOCKS).toHaveLength(NEIGHBOURHOOD_COUNT);
      expect(BLOCKS.filter((b) => b.use === 'hq')).toHaveLength(1);
      for (const b of BUILD_BLOCK_COORDS) expect(BLOCKS.find((x) => x.bx === b.bx && x.bz === b.bz)?.use).toBe('city');
      expect(planWorld({ t: 0, customers: 10_000, mrr: 0, releases: 0, commits: 0 }, { peakMrr: 0, weather: 'clear' }).homes).toHaveLength(HOME_CAPACITY);
      expect(BLOCKS.filter((b) => b.use === 'market').length).toBeGreaterThanOrEqual(3);
      expect(BLOCKS.find((b) => b.bx === CIVIC_BLOCK.bx && b.bz === CIVIC_BLOCK.bz)?.use).toBe('civic');
      expect(PARKS.filter((p) => p.kind === 'park')).toHaveLength(1);

      // Every block on land; the city's own blocks level.
      for (const b of BLOCKS.filter((x) => x.use !== 'hill' && x.use !== 'presidio')) {
        const c = blockCentre(b);
        for (const [dx, dz] of [[0, 0], [2.5, 2.5], [-2.5, -2.5], [2.5, -2.5], [-2.5, 2.5]] as const) {
          expect(coastDistance(c.x + dx, c.z + dz)).toBeLessThan(-1);
          expect(Math.abs(terrainHeight(c.x + dx, c.z + dz))).toBeLessThan(0.02);
        }
      }

      // The shore roads stay off the blocks and on land.
      for (const [i, [x, z]] of EMBARCADERO.entries()) {
        if (x < 9) expect(intoStreets(x, z), `Embarcadero point ${i}`).toBeLessThan(-0.45);
        expect(coastDistance(x, z)).toBeLessThan(-0.3);
      }
      // The Great Highway runs along the beach clear of the blocks, and turns in at both ends to meet
      // the grid's west street at a crossing: it never stops short in the dunes.
      const ends = [GREAT_HIGHWAY[0]!, GREAT_HIGHWAY.at(-1)!];
      for (const [x, z] of ends) {
        expect(x).toBe(GRID.bx0 * 5 - 2.5);
        expect(Math.abs(((z - 2.5) / 5) % 1)).toBeLessThan(1e-9);
        expect(intoStreets(x, z)).toBeCloseTo(0.5);
      }
      for (const [x, z] of GREAT_HIGHWAY) {
        if (ends.every((e) => Math.hypot(x - e[0], z - e[1]) > 2.2)) expect(intoStreets(x, z)).toBeLessThan(-0.4);
        expect(coastDistance(x, z)).toBeLessThan(-0.8);
      }
      // The windmill stands in the park beside the highway, its tulip garden clear of the road and the streets.
      if (HAS.windmill) {
        const m = LANDMARKS.windmill;
        for (const [x, z] of GREAT_HIGHWAY) expect(Math.hypot(x - m.x, z - m.z)).toBeGreaterThan(1.75);
        expect(intoStreets(m.x, m.z)).toBeLessThan(-1.35);
        expect(Math.abs(terrainHeight(m.x, m.z))).toBeLessThan(0.02);
      }
      for (const [x, z] of PRESIDIO_PKWY.slice(0, -1)) expect(intoStreets(x, z)).toBeLessThan(-0.4);

      // TinyTown Hills: streets off the grid's blocks and joined up, homes on terraces clear of the roads.
      const { streets, lots } = hillsPlan();
      expect(lots.length).toBeGreaterThanOrEqual(26);
      for (const st of streets) {
        st.pts.forEach(([x, z], i) => {
          if (i > 3 && i < st.pts.length - 4) expect(intoStreets(x, z), `${st.id} point ${i}`).toBeLessThan(0);
          expect(coastDistance(x, z)).toBeLessThan(-0.5);
        });
      }
      const near = (p: readonly number[], q: readonly (readonly number[])[], d: number) => q.some((o) => Math.hypot(o[0]! - p[0]!, o[1]! - p[1]!) < d);
      const reached = new Set([streets[0]!]);
      for (let pass = 0; pass < streets.length; pass++) {
        for (const st of streets) {
          if (reached.has(st)) continue;
          const ends = [st.pts[0]!, st.pts.at(-1)!];
          if ([...reached].some((o) => ends.some((e) => near(e, o.pts, 0.7)) || near(o.pts[0]!, st.pts, 0.7) || near(o.pts.at(-1)!, st.pts, 0.7))) reached.add(st);
        }
      }
      expect(reached.size, 'every Hills street joins up').toBe(streets.length);
      expect(streets.filter((s) => s.kind !== 'track').flatMap((s) => [s.pts[0]!, s.pts.at(-1)!]).filter((p) => Math.abs(p[2]) < 0.01).length).toBeGreaterThanOrEqual(2);
      for (const l of lots) {
        expect(inSignZone(l.x, l.z)).toBe(false);
        for (const st of streets) for (const [x, z] of st.pts) expect(Math.hypot(x - l.x, z - l.z)).toBeGreaterThan(st.w / 2 + 0.3);
        expect(Math.abs(terrainHeight(l.x, l.z) - l.y)).toBeLessThan(0.02);
      }
      for (let i = 0; i < lots.length; i++) for (let j = i + 1; j < lots.length; j++) expect(Math.hypot(lots[i]!.x - lots[j]!.x, lots[i]!.z - lots[j]!.z)).toBeGreaterThan(1.3);
      expect(level(HILLS_HOME.x, HILLS_HOME.z, 1.6)).toBeLessThan(0.02);
      expect(terrainHeight(HILLS_HOME.x, HILLS_HOME.z)).toBeGreaterThan(1.2);
      expect(terrainHeight(LANDMARKS.sign.x, LANDMARKS.sign.z)).toBeGreaterThan(3);
      if (HAS.sutro) expect(terrainHeight(LANDMARKS.sutroTower.x, LANDMARKS.sutroTower.z)).toBeGreaterThan(4);

      // The waterfront: the pier and the yacht berths out in the water, the airport as it always is.
      expect(coastDistance((PIER.x0 + PIER.x1) / 2, (PIER.z0 + PIER.z1) / 2)).toBeGreaterThan(0.5);
      expect(coastDistance((PIER.x0 + PIER.x1) / 2, PIER.z0 - 0.3)).toBeLessThan(0.2);
      for (const s of MARINA_SLOTS) expect(coastDistance(s.x, s.z)).toBeGreaterThan(0.6);
      for (const s of AIRPORT_SLOTS) expect(Math.abs(terrainHeight(s.x, s.z))).toBeLessThan(0.02);
      expect(level(HELIPAD.x, HELIPAD.z, 0.7)).toBeLessThan(0.02);
      expect(terrainHeight(-6, -6.5)).toBeLessThan(0.02);

      // Your island: far out, level for the estate, the yacht afloat, the launch site on land and off the camera's line.
      const F = ISLANDS.founder;
      const L = ISLANDS.launch;
      expect(Math.hypot(F.x - LANDMARKS.ferryBuilding.x, F.z - LANDMARKS.ferryBuilding.z)).toBeGreaterThan(33);
      expect(Math.hypot(F.x - (PIER.x0 + PIER.x1) / 2, F.z - PIER.z1)).toBeGreaterThan(F.r + 5);
      expect(F.z + F.r + 1).toBeLessThanOrEqual(WORLD.z1 + 0.5);
      expect(level(F.x, F.z, 2.1)).toBeLessThan(0.02);
      expect(coastDistance(SUPERYACHT.x, SUPERYACHT.z)).toBeGreaterThan(0.2);
      expect(coastDistance(L.x, L.z)).toBeLessThan(-1.5);
      expect(level(L.x, L.z, 1.4)).toBeLessThan(0.02);
      expect(L.x - F.x + (L.z - F.z)).toBeLessThan(0);
      expect(Math.hypot(F.x - ISLANDS.angel.x, F.z - ISLANDS.angel.z)).toBeGreaterThan(F.r + ISLANDS.angel.r + 3);

      // Bridges: rock over the Bay Bridge tunnel, a strait under the Golden Gate.
      for (let x = 30.4; x <= 35.6; x += 0.4) expect(terrainHeight(x, -6.5)).toBeGreaterThanOrEqual(3);
      const gg = LANDMARKS.goldenGate;
      for (let z = 11.6; z < 19; z += 0.5) expect(coastDistance(gg.x, z)).toBeGreaterThan(0);
      expect(coastDistance(gg.x, 9.5)).toBeLessThan(0);
      expect(Math.abs(MARKET_END[0] - MARKET_END[1])).toBeCloseTo(10, 6);

      // Boats keep to the water.
      const routes = bayRoutes();
      for (const route of [routes.sausalito, routes.tug, routes.shipping.slice(2)]) {
        for (let i = 0; i < route.length - 1; i++) {
          for (let s = 0; s <= 8; s++) {
            const x = route[i]![0] + ((route[i + 1]![0] - route[i]![0]) * s) / 8;
            const z = route[i]![1] + ((route[i + 1]![1] - route[i]![1]) * s) / 8;
            expect(coastDistance(x, z)).toBeGreaterThan(0.4);
          }
        }
      }
      expect(routes.sails.length).toBeGreaterThanOrEqual(3);

      // The towns round the bay.
      for (const t of backdropTowns()) expect(t.lots.length, t.id).toBeGreaterThan(5);
    }, 30_000);
  }
});
