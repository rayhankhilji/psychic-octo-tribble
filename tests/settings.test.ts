import { describe, expect, it } from 'vitest';
import {
  autoStatus,
  DEFAULTS,
  motionReduced,
  onSettings,
  parseSettings,
  QUALITY_NAMES,
  serializeSettings,
  settings,
  startQuality,
  TIME_PREVIEWS,
  updateSettings,
} from '../src/ui/settings-store.ts';

describe('settings store', () => {
  it('defaults to today’s behaviour when nothing is stored', () => {
    for (const raw of [null, undefined, '', 'null']) expect(parseSettings(raw)).toEqual(DEFAULTS);
    expect(DEFAULTS).toEqual({ quality: 'auto', tiltShift: true, shadows: true, motion: 'system', time: null });
  });

  it('survives damaged entries', () => {
    for (const raw of ['{', 'not json', '[1,2]', '42', '"high"', 'true']) expect(parseSettings(raw)).toEqual(DEFAULTS);
  });

  it('keeps every valid field and defaults the rest', () => {
    const s = parseSettings(JSON.stringify({ v: 1, quality: 'low', tiltShift: 'yes', shadows: false, motion: 'sideways', time: 'Night' }));
    expect(s).toEqual({ quality: 'low', tiltShift: true, shadows: false, motion: 'system', time: 'Night' });
  });

  it('only holds the city at a time the clock chip knows', () => {
    expect(parseSettings(JSON.stringify({ time: 'Golden hour' })).time).toBe('Golden hour');
    expect(parseSettings(JSON.stringify({ time: '13:00' })).time).toBeNull();
    expect(parseSettings(JSON.stringify({ time: 13 })).time).toBeNull();
    expect(TIME_PREVIEWS.map((p) => p.label)).toEqual(['Morning', 'Midday', 'Golden hour', 'Night']);
  });

  it('reads newer versions field by field', () => {
    expect(parseSettings(JSON.stringify({ v: 7, quality: 'medium', somethingNew: 1 })).quality).toBe('medium');
  });

  it('round-trips through storage with a version', () => {
    const s = { quality: 'high', tiltShift: false, shadows: true, motion: 'reduce', time: 'Morning' } as const;
    const raw = serializeSettings(s);
    expect(JSON.parse(raw).v).toBe(1);
    expect(parseSettings(raw)).toEqual(s);
  });

  it('applies and broadcasts changes, even where storage is blocked', () => {
    const seen: string[][] = [];
    const off = onSettings((_, changed) => seen.push(changed));
    updateSettings({ quality: 'low', shadows: false });
    updateSettings({ quality: 'low' });
    expect(settings().quality).toBe('low');
    expect(seen).toEqual([['quality', 'shadows']]);
    off();
    updateSettings({ ...DEFAULTS });
    expect(seen).toHaveLength(1);
    expect(settings()).toEqual(DEFAULTS);
  });
});

describe('quality mapping', () => {
  it('Automatic is exactly the old behaviour: High on desktop, Balanced on touch, adaptive', () => {
    expect(startQuality('auto', { coarse: false, forced: null })).toEqual({ level: 'high', adaptive: true });
    expect(startQuality('auto', { coarse: true, forced: null })).toEqual({ level: 'medium', adaptive: true });
  });

  it('a fixed choice stays put', () => {
    expect(startQuality('high', { coarse: true, forced: null })).toEqual({ level: 'high', adaptive: false });
    expect(startQuality('medium', { coarse: false, forced: null })).toEqual({ level: 'medium', adaptive: false });
    expect(startQuality('low', { coarse: false, forced: null })).toEqual({ level: 'low', adaptive: false });
  });

  it('?quality= in the address still wins', () => {
    expect(startQuality('low', { coarse: false, forced: 'high' })).toEqual({ level: 'high', adaptive: false });
    expect(startQuality('auto', { coarse: true, forced: 'low' })).toEqual({ level: 'low', adaptive: false });
  });

  it('names the levels the way people do', () => {
    expect(QUALITY_NAMES).toEqual({ auto: 'Automatic', high: 'High', medium: 'Balanced', low: 'Battery saver' });
  });

  it('says what Automatic is running at, and why when it stepped down', () => {
    expect(autoStatus('high', false)).toBe('Running at High');
    expect(autoStatus('medium', false)).toBe('Running at Balanced to keep it smooth');
    expect(autoStatus('medium', true)).toBe('Running at Balanced');
    expect(autoStatus('low', true)).toBe('Running at Battery saver to keep it smooth');
  });
});

describe('reduced motion', () => {
  it('follows the system unless the visitor chose', () => {
    expect(motionReduced('system', true)).toBe(true);
    expect(motionReduced('system', false)).toBe(false);
    expect(motionReduced('reduce', false)).toBe(true);
    expect(motionReduced('full', true)).toBe(false);
  });
});
