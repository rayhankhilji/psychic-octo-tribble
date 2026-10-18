/**
 * The growth clip's script, as pure functions: which day of the timeline
 * each video frame shows, how the camera moves, and how to frame the city
 * in a square or vertical picture. No DOM and no three.js, so it's tested
 * (tests/recap.test.ts) and the same founder always gets the same clip.
 */

export type ClipShape = 'square' | 'vertical';

export interface ClipFormat {
  id: ClipShape;
  width: number;
  height: number;
  label: string;
  /** Where it fits, for the share sheet. */
  hint: string;
  /**
   * How much of the frame the overlay covers at the top and bottom
   * (fractions of the height), so the camera frames the city in what's left.
   */
  inset: { top: number; bottom: number };
  /** Vertical frames crop the sides of the city a little rather than float it in sky. */
  fill: number;
}

export const CLIP_FORMATS: Record<ClipShape, ClipFormat> = {
  square: { id: 'square', width: 1080, height: 1080, label: 'Square', hint: '1080 × 1080 · X, LinkedIn', inset: { top: 0.06, bottom: 0.24 }, fill: 1 },
  vertical: { id: 'vertical', width: 1080, height: 1920, label: 'Vertical', hint: '1080 × 1920 · Stories, Reels', inset: { top: 0.15, bottom: 0.4 }, fill: 1.5 },
};

export const CLIP_FPS = 30;
export const CLIP_SECONDS = 15;

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/**
 * Replay pacing: a slow start so day one reads, a fast middle, a slow
 * settle onto today. Mostly an in-out cubic, with a little linear mixed in
 * so the opening days never quite stand still.
 */
export function easeReplay(t: number): number {
  const x = clamp01(t);
  const cubic = x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2;
  return 0.3 * x + 0.7 * cubic;
}

/** Smooth in and out, for the camera. */
export function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * clamp01(t)) - 1) / 2;
}

export function easeOutCubic(t: number): number {
  return 1 - (1 - clamp01(t)) ** 3;
}

export interface ClipSchedule {
  fps: number;
  frames: number;
  /** The timeline index (0 = day one) each frame shows. Never goes backwards. */
  day: number[];
  /** First frame of the replay, after a beat on day one. */
  start: number;
  /** First frame that shows today. */
  arrive: number;
  /** First frame of the end card. */
  endCard: number;
}

/**
 * Which day each frame shows: a beat on day one (0.8 s), the replay to
 * today, a beat on today (1 s) and the end card (2 s). The beats shrink in
 * proportion for clips shorter than 15 s (quick test recordings).
 */
export function clipSchedule(days: number, seconds = CLIP_SECONDS, fps = CLIP_FPS): ClipSchedule {
  const frames = Math.max(2, Math.round(seconds * fps));
  const k = Math.min(1, seconds / CLIP_SECONDS);
  const hold = Math.round(0.8 * k * fps);
  const settle = Math.round(1 * k * fps);
  const card = Math.round(2 * k * fps);
  const run = Math.max(1, frames - hold - settle - card);
  const last = Math.max(0, Math.floor(days) - 1);
  const day: number[] = [];
  for (let f = 0; f < frames; f++) {
    if (f < hold) day.push(0);
    else if (f < hold + run) day.push(Math.round(easeReplay((f - hold + 1) / run) * last));
    else day.push(last);
  }
  const arrive = day.indexOf(last);
  return { fps, frames, day, start: hold, arrive: arrive < 0 ? frames - 1 : arrive, endCard: Math.min(frames - 1, Math.max(hold + run, frames - card)) };
}

/** The camera swings this far round to the classic angle over the clip. */
export const CLIP_SWING = (14 * Math.PI) / 180;
/** It starts this much closer than the whole city's framing, near HQ, and pulls back. */
export const CLIP_PUSH = 1.55;

export interface ClipCamera {
  /** Radians to add to the final azimuth (it ends at 0, on the classic view). */
  turn: number;
  /** Zoom multiplier over the city's framing: starts close, ends at 1. */
  push: number;
  /** 0 = looking at HQ, 1 = looking at the middle of the whole city. */
  focus: number;
}

/**
 * The camera's move on frame `f`: a slow swing round to the classic iso
 * angle while pulling back from HQ to the whole city, timed across the
 * replay and the beat on today, then still for the end card.
 */
export function clipCamera(f: number, s: ClipSchedule): ClipCamera {
  const p = clamp01((f - s.start) / Math.max(1, s.endCard - s.start));
  const e = easeInOutSine(p);
  return { turn: -CLIP_SWING * (1 - e), push: 1 + (CLIP_PUSH - 1) * (1 - easeOutCubic(p)), focus: e };
}

/** How far into the end card's entrance we are, 0..1 over 0.45 s, eased out. */
export function endCardIn(f: number, s: ClipSchedule): number {
  if (f < s.endCard) return 0;
  return easeOutCubic((f - s.endCard + 1) / Math.max(1, Math.round(0.45 * s.fps)));
}

export interface Box {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** Isometric: the camera looks down 35.26° from the horizontal (matches Stage). */
export const ISO_POLAR = Math.acos(1 / Math.sqrt(3));

/** The camera's right, up and forward vectors for an azimuth, at the iso tilt. */
export function cameraBasis(azimuth: number) {
  const sp = Math.sin(ISO_POLAR);
  const cp = Math.cos(ISO_POLAR);
  const sa = Math.sin(azimuth);
  const ca = Math.cos(azimuth);
  return {
    right: [ca, 0, -sa] as const,
    up: [-sa * cp, sp, -ca * cp] as const,
    forward: [-sa * sp, -cp, -ca * sp] as const,
  };
}

/**
 * Where to aim an orthographic iso camera, and how far to zoom, so a box of
 * the city (and anything up to 2.5 units tall on it) fills a frame of this
 * `aspect` whose visible height at zoom 1 is `view` units, leaving `inset`
 * of the height free at the top and bottom for the overlay. `fill` > 1
 * zooms past "contain" (vertical frames crop the sides). The target sits on
 * the ground plane, like the Stage's own framing. Pass `zoom` to aim at the
 * box at that zoom instead of fitting it.
 */
export function fitView(box: Box, azimuth: number, aspect: number, view: number, inset = { top: 0, bottom: 0 }, fill = 1, zoomAt?: number): { x: number; z: number; zoom: number } {
  const { right, up, forward } = cameraBasis(azimuth);
  const cx = (box.x0 + box.x1) / 2;
  const cz = (box.z0 + box.z1) / 2;
  let r0 = Infinity;
  let r1 = -Infinity;
  let u0 = Infinity;
  let u1 = -Infinity;
  for (const x of [box.x0, box.x1]) {
    for (const z of [box.z0, box.z1]) {
      for (const y of [0, 2.5]) {
        const px = x - cx;
        const pz = z - cz;
        const r = px * right[0] + y * right[1] + pz * right[2];
        const u = px * up[0] + y * up[1] + pz * up[2];
        r0 = Math.min(r0, r);
        r1 = Math.max(r1, r);
        u0 = Math.min(u0, u);
        u1 = Math.max(u1, u);
      }
    }
  }
  const usable = Math.max(0.2, 1 - inset.top - inset.bottom);
  const margin = 1.06;
  const contain = Math.min((view * aspect) / ((r1 - r0) * margin), (view * usable) / ((u1 - u0) * margin));
  const zoom = zoomAt ?? Math.min(6, Math.max(0.12, contain * fill));
  // Centre the box in the band the overlay leaves free.
  const shift = ((inset.bottom - inset.top) / 2) * (view / zoom);
  const rc = (r0 + r1) / 2;
  const uc = (u0 + u1) / 2 - shift;
  const tx = cx + right[0] * rc + up[0] * uc;
  const ty = right[1] * rc + up[1] * uc;
  const tz = cz + right[2] * rc + up[2] * uc;
  // Slide along the view ray back down to the ground.
  const k = -ty / forward[1];
  return { x: tx + forward[0] * k, z: tz + forward[2] * k, zoom };
}

/** Up to `max` evenly spaced points of a series (the MRR line on the overlay), always keeping the last. */
export function sampleSeries(values: number[], max = 360): { i: number; v: number }[] {
  const n = values.length;
  if (n <= max) return values.map((v, i) => ({ i, v }));
  const out: { i: number; v: number }[] = [];
  for (let k = 0; k < max; k++) {
    const i = Math.round((k / (max - 1)) * (n - 1));
    out.push({ i, v: values[i]! });
  }
  return out;
}
