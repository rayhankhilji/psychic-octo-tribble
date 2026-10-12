import { describe, expect, it } from 'vitest';
import {
  AIRPORT,
  BLOCKS,
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
