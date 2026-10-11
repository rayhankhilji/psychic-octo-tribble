import { describe, expect, it } from 'vitest';
import { atmosphereAt, parseHour, phaseOf } from '../src/world/daylight.ts';

describe('time of day', () => {
  it('is broad daylight at lunchtime with the sun high', () => {
    const a = atmosphereAt(13);
    expect(a.phase).toBe('day');
    expect(a.night).toBe(0);
    expect(a.lightDir[1]).toBeGreaterThan(0.75);
    expect(a.lightIntensity).toBeGreaterThan(2.5);
  });

  it('has a golden evening with the sun low and the first lights coming on', () => {
    const a = atmosphereAt(18.5);
    expect(a.phase).toBe('evening');
    expect(a.night).toBeGreaterThan(0.2);
    expect(a.night).toBeLessThan(0.7);
    expect(a.lightDir[1]).toBeLessThan(0.45);
    // Warm light: much more red than blue
    expect(a.lightColor[0]).toBeGreaterThan(a.lightColor[2] * 1.5);
  });

  it('is night late in the evening and before dawn', () => {
    for (const h of [22.5, 0, 3]) {
      expect(phaseOf(h)).toBe('night');
      expect(atmosphereAt(h).night).toBe(1);
    }
  });

  it('changes smoothly through the whole day', () => {
    let prev = atmosphereAt(0);
    for (let h = 0.05; h < 24; h += 0.05) {
      const a = atmosphereAt(h);
      expect(Math.abs(a.night - prev.night)).toBeLessThan(0.06);
      expect(Math.abs(a.lightIntensity - prev.lightIntensity)).toBeLessThan(0.15);
      const turn = Math.acos(Math.min(1, a.lightDir[0] * prev.lightDir[0] + a.lightDir[1] * prev.lightDir[1] + a.lightDir[2] * prev.lightDir[2]));
      expect(turn).toBeLessThan(0.12);
      prev = a;
    }
  });

  it('turns a rainy afternoon overcast and dimmer', () => {
    const dry = atmosphereAt(14);
    const wet = atmosphereAt(14, 1);
    expect(wet.lightIntensity).toBeLessThan(dry.lightIntensity * 0.5);
  });

  it('parses ?time= overrides', () => {
    expect(parseHour('13:30')).toBe(13.5);
    expect(parseHour('7pm')).toBe(19);
    expect(parseHour('12am')).toBe(0);
    expect(parseHour('9')).toBe(9);
    expect(parseHour('noon')).toBeNull();
    expect(parseHour('25:00')).toBeNull();
    expect(parseHour(null)).toBeNull();
  });
});
