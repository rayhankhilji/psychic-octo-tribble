import { describe, expect, it } from 'vitest';
import { ambienceMix, closenessOf, cueFor, Gate, nextStep, pentatonic } from '../src/audio/cues.ts';

describe('sound cues', () => {
  it('gives every game moment its own sound', () => {
    expect(cueFor('game.build')?.sound).toBe('place');
    expect(cueFor('game.sign.lit')?.sound).toBe('flourish');
    expect(cueFor('game.region.opened')?.sound).toBe('swell');
    expect(cueFor('district.unlocked')?.sound).toBe('milestone');
    expect(cueFor('game.decay')?.sound).toBe('decay');
    expect(cueFor('game.sign.dark')?.sound).toBe('decay');
    expect(cueFor('game.error')?.sound).toBe('error');
  });

  it('reads the text where the feed does', () => {
    expect(cueFor('customers.joined', '3 new customers · 40 total')?.sound).toBe('pluck');
    expect(cueFor('customers.joined', 'Your first paying customer!')?.sound).toBe('chime');
    expect(cueFor('weather.changed', 'Rain over the city · MRR -2.0% this week')).toBeNull();
    expect(cueFor('weather.changed', 'The rain has cleared.')?.sound).toBe('clear');
    expect(cueFor('game.moon', 'Lift-off! Flying to your house on the moon')?.sound).toBe('launch');
    expect(cueFor('game.moon', 'Back from your moon house. Worth every penny.')?.sound).toBe('chime');
    expect(cueFor('game.heli', 'Wheels up from the airport, off to your island')?.sound).toBe('heliUp');
    expect(cueFor('game.heli', 'Touched down on your island')?.sound).toBe('heliDown');
  });

  it('stays silent for anything it does not know', () => {
    expect(cueFor('something.new')).toBeNull();
  });
});

describe('the gate', () => {
  it('turns a 12-days-a-second replay into a sprinkle, not a roll', () => {
    const g = new Gate();
    const pluck = cueFor('customers.joined')!;
    let played = 0;
    // Ten seconds of replay, a new customer every day at 12 days a second.
    for (let i = 0; i < 120; i++) if (g.allow(pluck, i / 12)) played++;
    expect(played).toBeGreaterThan(8);
    expect(played).toBeLessThanOrEqual(20);
  });

  it('never lets one cue play faster than its gap', () => {
    const g = new Gate();
    const decay = cueFor('game.decay')!;
    expect(g.allow(decay, 0)).toBe(true);
    expect(g.allow(decay, 1)).toBe(false);
    expect(g.allow(decay, 4.1)).toBe(true);
  });

  it('lets the big moments through even when the bucket is empty', () => {
    const g = new Gate(1, 1);
    const pluck = cueFor('customers.joined')!;
    expect(g.allow(pluck, 0)).toBe(true);
    expect(g.allow(cueFor('release.shipped')!, 0.01)).toBe(false); // notable, but no tokens left
    expect(g.allow(cueFor('game.sign.lit')!, 0.02)).toBe(true);
    // …and everyday sounds step aside for a moment afterwards.
    expect(g.allow(pluck, 1.1)).toBe(false);
    expect(g.allow(pluck, 1.5)).toBe(true);
  });

  it('caps a fireworks finale at a few booms a second', () => {
    const g = new Gate(3, 4);
    const boom = { sound: 'launch' as const, priority: 1 as const, gap: 0.08 };
    let played = 0;
    for (let i = 0; i < 40; i++) if (g.allow(boom, i * 0.05)) played++; // 40 bursts in 2 s
    expect(played).toBeLessThanOrEqual(11);
    expect(played).toBeGreaterThanOrEqual(8);
  });
});

describe('the ambience', () => {
  it('is a lively city by day and crickets by night', () => {
    const noon = ambienceMix(13, 1, false);
    const night = ambienceMix(23, 1, false);
    expect(noon.crickets).toBe(0);
    expect(night.crickets).toBeGreaterThan(0.3);
    expect(noon.city).toBeGreaterThan(night.city * 2);
    expect(noon.gulls).toBeGreaterThan(0.5);
    expect(night.gulls).toBe(0);
    expect(night.cityTone).toBeLessThan(noon.cityTone);
    expect(night.water).toBeLessThan(noon.water);
  });

  it('sits in between at golden hour', () => {
    const noon = ambienceMix(13, 1, false);
    const golden = ambienceMix(18.6, 1, false);
    const night = ambienceMix(23, 1, false);
    expect(golden.city).toBeLessThan(noon.city);
    expect(golden.city).toBeGreaterThan(night.city);
    // The fog comes in through the Gate in the evening: more horns.
    expect(golden.foghorn).toBeGreaterThan(noon.foghorn);
  });

  it('hears the streets close up and wind and water far out', () => {
    const close = ambienceMix(13, 4, false);
    const far = ambienceMix(13, 0.4, false);
    expect(close.city).toBeGreaterThan(far.city);
    expect(close.bells).toBeGreaterThan(far.bells);
    expect(far.wind).toBeGreaterThan(close.wind * 3);
    expect(far.water).toBeGreaterThan(close.water);
  });

  it('rains when the city is sad, and the crickets go quiet', () => {
    const dry = ambienceMix(23, 1, false);
    const wet = ambienceMix(23, 1, true);
    expect(dry.rain).toBe(0);
    expect(wet.rain).toBe(1);
    expect(wet.crickets).toBeLessThan(dry.crickets);
  });

  it('keeps every level in range for any hour and zoom', () => {
    for (let h = 0; h < 24; h += 0.25)
      for (const z of [0.2, 0.32, 0.5, 1, 2, 5, 14]) {
        const m = ambienceMix(h, z, h > 12);
        for (const k of ['city', 'water', 'crickets', 'rain'] as const) {
          expect(m[k]).toBeGreaterThanOrEqual(0);
          expect(m[k]).toBeLessThanOrEqual(1);
        }
        expect(m.wind).toBeLessThanOrEqual(1.25);
        expect(m.gulls).toBeGreaterThanOrEqual(0);
      }
  });

  it('maps zoom to closeness on a log scale', () => {
    expect(closenessOf(0.32)).toBe(0);
    expect(closenessOf(14)).toBe(1);
    expect(closenessOf(1)).toBeGreaterThan(0.3);
    expect(closenessOf(1)).toBeLessThan(0.5);
  });
});

describe('the scale', () => {
  it('is D major pentatonic', () => {
    expect(pentatonic(0)).toBeCloseTo(293.66, 1);
    expect(pentatonic(3)).toBeCloseTo(440, 0);
    expect(pentatonic(5)).toBeCloseTo(587.33, 1);
    expect(pentatonic(-5)).toBeCloseTo(146.83, 1);
  });

  it('walks customer plucks around a comfortable range', () => {
    let n = 5;
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      n = nextStep(n, (i * 0.618) % 1);
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(9);
      seen.add(n);
    }
    expect(seen.size).toBeGreaterThan(4);
  });
});
