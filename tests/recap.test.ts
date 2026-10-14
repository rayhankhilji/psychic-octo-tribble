import { describe, expect, it } from 'vitest';
import { CLIP_FORMATS, CLIP_PUSH, CLIP_SWING, cameraBasis, clipCamera, clipSchedule, easeReplay, endCardIn, fitView, sampleSeries } from '../src/ui/recap-plan.ts';

describe('growth clip pacing', () => {
  it('eases from 0 to 1, never backwards', () => {
    expect(easeReplay(0)).toBe(0);
    expect(easeReplay(1)).toBe(1);
    expect(easeReplay(-1)).toBe(0);
    expect(easeReplay(2)).toBe(1);
    let last = 0;
    for (let t = 0; t <= 1; t += 0.01) {
      const v = easeReplay(t);
      expect(v).toBeGreaterThanOrEqual(last - 1e-12);
      last = v;
    }
  });

  it('starts slow, runs fast in the middle and settles slowly onto today', () => {
    const slope = (t: number) => (easeReplay(t + 0.005) - easeReplay(t - 0.005)) / 0.01;
    expect(slope(0.05)).toBeLessThan(0.6);
    expect(slope(0.5)).toBeGreaterThan(2);
    expect(slope(0.95)).toBeLessThan(0.6);
    // Symmetric: the settle mirrors the start.
    expect(easeReplay(0.2) + easeReplay(0.8)).toBeCloseTo(1, 10);
    // Day one never stands still: some speed from the first frame.
    expect(slope(0.005)).toBeGreaterThan(0.25);
  });

  it('films 15 seconds at 30 fps, day one first and today last', () => {
    const s = clipSchedule(540);
    expect(s.frames).toBe(450);
    expect(s.fps).toBe(30);
    expect(s.day).toHaveLength(450);
    expect(s.day[0]).toBe(0);
    expect(s.day.at(-1)).toBe(539);
    for (let f = 1; f < s.frames; f++) expect(s.day[f]!).toBeGreaterThanOrEqual(s.day[f - 1]!);
    // A beat on day one, the replay, a beat on today, then two seconds of end card.
    expect(s.start).toBe(24);
    expect(s.day.slice(0, s.start).every((d) => d === 0)).toBe(true);
    expect(s.endCard).toBe(390);
    expect(s.day[s.arrive]).toBe(539);
    expect(s.day[s.arrive - 1]).toBeLessThan(539);
    expect(s.endCard - s.arrive).toBeGreaterThanOrEqual(30);
  });

  it('moves fastest through the middle of the timeline', () => {
    const s = clipSchedule(540);
    const step = (f: number) => s.day[f + 1]! - s.day[f]!;
    const mid = Math.round((s.start + s.arrive) / 2);
    expect(step(mid)).toBeGreaterThan(step(s.start + 2));
    expect(step(mid)).toBeGreaterThan(step(s.arrive - 3));
    // Every day of a short timeline gets at least a frame.
    const short = clipSchedule(40);
    for (let d = 0; d < 40; d++) expect(short.day).toContain(d);
  });

  it('copes with tiny and huge timelines and short test clips', () => {
    const one = clipSchedule(1);
    expect(one.day.every((d) => d === 0)).toBe(true);
    const two = clipSchedule(2);
    expect(two.day[0]).toBe(0);
    expect(two.day.at(-1)).toBe(1);
    const long = clipSchedule(3650);
    expect(long.day.at(-1)).toBe(3649);
    const test = clipSchedule(540, 3);
    expect(test.frames).toBe(90);
    expect(test.day[0]).toBe(0);
    expect(test.day.at(-1)).toBe(539);
    expect(test.endCard).toBeGreaterThan(test.start);
    expect(test.frames - test.endCard).toBe(12);
  });

  it('brings the end card in over a beat and holds it', () => {
    const s = clipSchedule(540);
    expect(endCardIn(s.endCard - 1, s)).toBe(0);
    expect(endCardIn(s.endCard, s)).toBeGreaterThan(0);
    expect(endCardIn(s.endCard, s)).toBeLessThan(1);
    expect(endCardIn(s.endCard + 20, s)).toBe(1);
  });
});

describe('growth clip camera', () => {
  it('swings round to the classic angle and pulls back from HQ to the whole city', () => {
    const s = clipSchedule(540);
    const first = clipCamera(0, s);
    expect(first.turn).toBeCloseTo(-CLIP_SWING, 10);
    expect(first.push).toBeCloseTo(CLIP_PUSH, 10);
    expect(first.focus).toBeCloseTo(0, 10);
    const end = clipCamera(s.endCard, s);
    expect(end.turn).toBeCloseTo(0, 10);
    expect(end.push).toBeCloseTo(1, 10);
    expect(end.focus).toBeCloseTo(1, 10);
    // Still during the end card.
    expect(clipCamera(s.frames - 1, s)).toEqual(end);
    // Smooth: no frame moves more than a sliver.
    for (let f = 1; f < s.frames; f++) {
      expect(Math.abs(clipCamera(f, s).turn - clipCamera(f - 1, s).turn)).toBeLessThan(0.004);
      expect(Math.abs(clipCamera(f, s).push - clipCamera(f - 1, s).push)).toBeLessThan(0.01);
    }
  });

  it('has an orthonormal camera basis that looks down at the iso angle', () => {
    for (const az of [0, Math.PI / 4, 1, 3]) {
      const { right, up, forward } = cameraBasis(az);
      const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
      expect(dot(right, right)).toBeCloseTo(1, 10);
      expect(dot(up, up)).toBeCloseTo(1, 10);
      expect(dot(forward, forward)).toBeCloseTo(1, 10);
      expect(dot(right, up)).toBeCloseTo(0, 10);
      expect(dot(right, forward)).toBeCloseTo(0, 10);
      expect(dot(up, forward)).toBeCloseTo(0, 10);
      expect(forward[1]).toBeCloseTo(-1 / Math.sqrt(3), 10);
      expect(up[1]).toBeGreaterThan(0);
    }
  });

  /** Where a world point lands on screen, in -1..1 of the frame's half-width and half-height. */
  function project(p: [number, number, number], aim: { x: number; z: number; zoom: number }, az: number, aspect: number, view: number) {
    const { right, up } = cameraBasis(az);
    const d = [p[0] - aim.x, p[1], p[2] - aim.z];
    const r = d[0]! * right[0] + d[1]! * right[1] + d[2]! * right[2];
    const u = d[0]! * up[0] + d[1]! * up[1] + d[2]! * up[2];
    return { sx: r / ((view * aspect) / aim.zoom / 2), sy: u / (view / aim.zoom / 2) };
  }

  it('fits the city box in the frame, clear of the overlay', () => {
    const box = { x0: -20, x1: 18, z0: -25, z1: 16 };
    for (const id of ['square', 'vertical'] as const) {
      const f = CLIP_FORMATS[id];
      const aspect = f.width / f.height;
      const view = 26;
      const az = Math.PI / 4;
      const aim = fitView(box, az, aspect, view, f.inset, 1);
      let top = -Infinity;
      let bottom = Infinity;
      let left = Infinity;
      let right = -Infinity;
      for (const x of [box.x0, box.x1]) {
        for (const z of [box.z0, box.z1]) {
          for (const y of [0, 2.5]) {
            const { sx, sy } = project([x, y, z], aim, az, aspect, view);
            top = Math.max(top, sy);
            bottom = Math.min(bottom, sy);
            left = Math.min(left, sx);
            right = Math.max(right, sx);
          }
        }
      }
      // Inside the frame horizontally, and inside the band the overlay leaves free.
      expect(left).toBeGreaterThanOrEqual(-1);
      expect(right).toBeLessThanOrEqual(1);
      expect(top).toBeLessThanOrEqual(1 - 2 * f.inset.top + 1e-9);
      expect(bottom).toBeGreaterThanOrEqual(-1 + 2 * f.inset.bottom - 1e-9);
      // And it fills it: one pair of edges sits close to the limits.
      const fillsWidth = right - left > 1.85;
      const fillsHeight = top - bottom > (2 - 2 * (f.inset.top + f.inset.bottom)) * 0.93;
      expect(fillsWidth || fillsHeight).toBe(true);
    }
  });

  it('aims at a point at a given zoom, centred in the free band', () => {
    const f = CLIP_FORMATS.square;
    const aim = fitView({ x0: -1, x1: 1, z0: -1, z1: 1 }, Math.PI / 4, 1, 26, f.inset, 1, 2);
    expect(aim.zoom).toBe(2);
    const { sx, sy } = project([0, 1.25, 0], aim, Math.PI / 4, 1, 26);
    expect(sx).toBeCloseTo(0, 6);
    expect(sy).toBeCloseTo(f.inset.bottom - f.inset.top, 6);
  });

  it('crops the sides of the city for vertical frames', () => {
    const box = { x0: -20, x1: 18, z0: -25, z1: 16 };
    const v = CLIP_FORMATS.vertical;
    const contain = fitView(box, Math.PI / 4, 9 / 16, 26, v.inset, 1);
    const filled = fitView(box, Math.PI / 4, 9 / 16, 26, v.inset, v.fill);
    expect(filled.zoom).toBeCloseTo(contain.zoom * v.fill, 10);
  });
});

describe('MRR line sampling', () => {
  it('keeps short series whole and thins long ones, always keeping both ends', () => {
    expect(sampleSeries([1, 2, 3])).toEqual([
      { i: 0, v: 1 },
      { i: 1, v: 2 },
      { i: 2, v: 3 },
    ]);
    const long = Array.from({ length: 2000 }, (_, i) => i * 2);
    const s = sampleSeries(long, 100);
    expect(s).toHaveLength(100);
    expect(s[0]).toEqual({ i: 0, v: 0 });
    expect(s.at(-1)).toEqual({ i: 1999, v: 3998 });
    for (let k = 1; k < s.length; k++) expect(s[k]!.i).toBeGreaterThan(s[k - 1]!.i);
  });
});
