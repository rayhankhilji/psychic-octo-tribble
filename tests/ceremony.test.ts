import { describe, expect, it } from 'vitest';
import { ceremonyKey, openingCard, wantsCeremony, type CeremonyFacts } from '../src/ui/ceremony.ts';
import { BEATS, between, poseAt, type Pose } from '../src/render/ceremony.ts';

const first: CeremonyFacts = { preview: false, hosted: true, lastSeen: null, played: false, days: 30 };

describe('wantsCeremony', () => {
  it('plays on the first open of a founder’s own city', () => {
    expect(wantsCeremony(first)).toBe(true);
  });

  it('plays once: not after the server has recorded a day as seen', () => {
    expect(wantsCeremony({ ...first, lastSeen: Date.UTC(2026, 9, 14) })).toBe(false);
  });

  it('plays once per browser, even before the server has caught up', () => {
    expect(wantsCeremony({ ...first, played: true })).toBe(false);
  });

  it('never plays on the demo or a local city', () => {
    expect(wantsCeremony({ ...first, hosted: false })).toBe(false);
  });

  it('stays out of the way of browser automation', () => {
    expect(wantsCeremony({ ...first, automated: true })).toBe(false);
  });

  it('waits for real numbers', () => {
    expect(wantsCeremony({ ...first, days: 0 })).toBe(false);
  });

  it('always plays as a preview', () => {
    expect(wantsCeremony({ preview: true, hosted: false, lastSeen: 1, played: true, days: 0 })).toBe(true);
  });

  it('remembers per city', () => {
    expect(ceremonyKey('user-1')).toBe('tinytown:inaugurated:user-1');
    expect(ceremonyKey(42)).not.toBe(ceremonyKey(43));
  });
});

describe('openingCard', () => {
  const today = new Date(2026, 9, 14, 12).getTime();

  it('quotes the real numbers, people to house when there is a user source', () => {
    const c = openingCard({ name: 'Acme', currency: 'usd', mrr: 4320, customers: 120, users: 900, today });
    expect(c.founded).toBe('Founded October 14, 2026');
    expect(c.stats).toEqual([
      { value: '$4,320', label: 'MRR' },
      { value: '120', label: 'customers' },
      { value: '900', label: 'people to house' },
    ]);
    expect(c.line).toBe('$4,320 MRR · 120 customers · 900 people to house');
  });

  it('leaves out people to house when the customers are the people', () => {
    const c = openingCard({ name: 'Acme', currency: 'eur', mrr: 12, customers: 1, today });
    expect(c.stats.map((s) => s.label)).toEqual(['MRR', 'customer']);
    expect(c.stats[0]!.value).toBe('€12');
  });
});

describe('the camera', () => {
  const start: Pose = { x: -10, z: -8, zoom: 0.5, az: Math.PI / 4 };
  const shots = {
    start,
    plaza: { x: -14, z: -20, zoom: 5, az: 0.35 },
    push: { x: -14, z: -20, zoom: 6, az: 0.43 },
    wide: { x: -12, z: -26, zoom: 1.5, az: -0.34 },
    home: start,
  };

  it('starts where the camera was and ends at home', () => {
    expect(poseAt(0, shots)).toEqual(start);
    expect(poseAt(BEATS.end, shots)).toEqual(start);
    expect(poseAt(BEATS.end + 5, shots)).toEqual(start);
  });

  it('is over the plaza when it arrives and wide by the time the sign is on screen', () => {
    expect(poseAt(BEATS.arrive, shots).zoom).toBeCloseTo(5, 6);
    expect(poseAt(BEATS.wide, shots)).toEqual(shots.wide);
  });

  it('moves smoothly: no jumps between frames', () => {
    let prev = poseAt(0, shots);
    for (let t = 1 / 60; t < BEATS.end + 0.5; t += 1 / 60) {
      const p = poseAt(t, shots);
      expect(Math.hypot(p.x - prev.x, p.z - prev.z)).toBeLessThan(0.6);
      expect(Math.abs(Math.log(p.zoom / prev.zoom))).toBeLessThan(0.06);
      expect(Math.abs(p.az - prev.az)).toBeLessThan(0.03);
      prev = p;
    }
  });

  it('turns the short way round', () => {
    const p = between({ x: 0, z: 0, zoom: 1, az: 0.1 }, { x: 0, z: 0, zoom: 1, az: Math.PI * 2 - 0.1 }, 0.5);
    expect(Math.abs(p.az)).toBeLessThan(1e-9);
  });

  it('eases zoom on a log scale', () => {
    expect(between({ x: 0, z: 0, zoom: 1, az: 0 }, { x: 0, z: 0, zoom: 4, az: 0 }, 0.5).zoom).toBeCloseTo(2, 9);
  });
});
