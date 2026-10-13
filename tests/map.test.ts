import { describe, expect, it } from 'vitest';
import {
  AIRPORT,
  AIRPORT_SLOTS,
  BLOCKS,
  HELIPAD,
  ISLANDS,
  SUPERYACHT,
  backdropTowns,
  hillsPlan,
  inSignZone,
  BUILD_BLOCK_COORDS,
  HILLS_HOME,
  LANDMARKS,
  NEIGHBOURHOOD_BLOCKS,
  blockCentre,
  coastDistance,
  terrainHeight,
} from '../src/world/map.ts';

describe('the Bay map', () => {
  it('has room for downtown, HQ and plenty of neighbourhoods', () => {
    expect(BLOCKS.filter((b) => b.use === 'hq')).toHaveLength(1);
    expect(NEIGHBOURHOOD_BLOCKS.length).toBeGreaterThanOrEqual(34);
    for (const b of BUILD_BLOCK_COORDS) expect(BLOCKS.find((x) => x.bx === b.bx && x.bz === b.bz)?.use).toBe('city');
  });

  it('cuts Market Street diagonally through the grid from the waterfront', () => {
    const market = BLOCKS.filter((b) => b.use === 'market');
    expect(market.length).toBeGreaterThanOrEqual(4);
    for (const b of market) expect(b.bx - b.bz).toBe(2);
  });

  it('keeps every city block on dry, flat land', () => {
    for (const b of BLOCKS.filter((x) => x.use === 'city' || x.use === 'hq' || x.use === 'civic')) {
      const c = blockCentre(b);
      for (const [dx, dz] of [[0, 0], [2.5, 2.5], [-2.5, -2.5], [2.5, -2.5], [-2.5, 2.5]] as const) {
        expect(coastDistance(c.x + dx, c.z + dz)).toBeLessThan(0);
        expect(Math.abs(terrainHeight(c.x + dx, c.z + dz))).toBeLessThan(0.02);
      }
    }
  });

  it('puts the hills, the sign and the airport where they belong', () => {
    expect(terrainHeight(LANDMARKS.sutroTower.x, LANDMARKS.sutroTower.z)).toBeGreaterThan(5);
    expect(terrainHeight(LANDMARKS.sign.x, LANDMARKS.sign.z)).toBeGreaterThan(3);
    expect(terrainHeight(HILLS_HOME.x, HILLS_HOME.z)).toBeGreaterThan(2);
    const ax = (AIRPORT.x0 + AIRPORT.x1) / 2;
    const az = (AIRPORT.z0 + AIRPORT.z1) / 2;
    expect(coastDistance(ax, az)).toBeLessThan(0);
    expect(Math.abs(terrainHeight(ax, az))).toBeLessThan(0.05);
    expect(coastDistance(0, 20)).toBeGreaterThan(0); // the bay
  });
});

describe('TinyTown Hills and the landscape', () => {
  const level = (x: number, z: number, r: number) => {
    const hs: number[] = [];
    for (let a = 0; a < 8; a++) for (const d of [0, r / 2, r]) hs.push(terrainHeight(x + Math.cos(a) * d, z + Math.sin(a) * d));
    return Math.max(...hs) - Math.min(...hs);
  };

  it('lays out a real neighbourhood: houses on every street, none on a road or the sign', () => {
    const { streets, lots } = hillsPlan();
    expect(lots.length).toBeGreaterThanOrEqual(35);
    expect(lots.length).toBeLessThanOrEqual(70);
    expect(streets.filter((s) => s.cul).length).toBeGreaterThanOrEqual(2);
    for (const l of lots) {
      expect(inSignZone(l.x, l.z)).toBe(false);
      // Clear of every street's asphalt
      for (const s of streets) for (const [x, z] of s.pts) expect(Math.hypot(x - l.x, z - l.z)).toBeGreaterThan(s.w / 2 + 0.3);
      // Level terrace under the house
      expect(Math.abs(terrainHeight(l.x, l.z) - l.y)).toBeLessThan(0.02);
    }
    // Consistent spacing: no two houses closer than a lot apart
    for (let i = 0; i < lots.length; i++) for (let j = i + 1; j < lots.length; j++) expect(Math.hypot(lots[i]!.x - lots[j]!.x, lots[i]!.z - lots[j]!.z)).toBeGreaterThan(1.3);
  });

  it('connects the Hills to the city grid and keeps your lot level', () => {
    const ends = hillsPlan().streets.flatMap((s) => [s.pts[0]!, s.pts.at(-1)!]).filter((p) => Math.abs(p[2]) < 0.01);
    expect(ends.length).toBeGreaterThanOrEqual(4);
    expect(level(HILLS_HOME.x, HILLS_HOME.z, 1.6)).toBeLessThan(0.02);
  });

  it('gives the island a level estate, the airport helipad level ground and the superyacht open water', () => {
    expect(level(ISLANDS.founder.x, ISLANDS.founder.z, 2.1)).toBeLessThan(0.02);
    expect(level(HELIPAD.x, HELIPAD.z, 0.7)).toBeLessThan(0.02);
    expect(coastDistance(HELIPAD.x, HELIPAD.z)).toBeLessThan(-0.5);
    expect(coastDistance(SUPERYACHT.x, SUPERYACHT.z)).toBeGreaterThan(0.2);
    // The launch site: on land, level, and never between the north-east camera and the estate.
    const L = ISLANDS.launch;
    expect(coastDistance(L.x, L.z)).toBeLessThan(-1.5);
    expect(level(L.x, L.z, 1.4)).toBeLessThan(0.02);
    expect(L.x - ISLANDS.founder.x + (L.z - ISLANDS.founder.z)).toBeLessThan(0);
    for (const s of AIRPORT_SLOTS) expect(Math.abs(terrainHeight(s.x, s.z))).toBeLessThan(0.02);
  });

  it('keeps rock over the Bay Bridge tunnel through Yerba Buena', () => {
    for (let x = 30.4; x <= 35.6; x += 0.2) expect(terrainHeight(x, -6.5)).toBeGreaterThanOrEqual(3);
  });

  it('builds the towns around the bay on streets, at the city’s scale', () => {
    const towns = backdropTowns();
    const lots = towns.reduce((n, t) => n + t.lots.length, 0);
    expect(lots).toBeGreaterThan(300);
    expect(lots).toBeLessThan(1200);
    for (const t of towns) expect(t.lots.length).toBeGreaterThan(5);
  });
});
