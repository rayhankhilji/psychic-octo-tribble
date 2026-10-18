/**
 * The visitor's settings: graphics, motion and the time of day the city
 * opens at. Remembered per browser as versioned JSON, read once at boot
 * (before the renderer builds its pipeline) and broadcast when they change,
 * so the Stage, the HUD and the settings panel never need to know about
 * each other. Sound keeps its own store (src/audio/engine.ts).
 *
 * Everything above the `localStorage` line is pure, for the tests.
 */
import type { Quality } from '../render/post.ts';

export const SETTINGS_KEY = 'tinytown:settings';
const VERSION = 1;

/** `auto` is today's behaviour: start at the device's level and step down if frames run long. */
export type QualityMode = 'auto' | Quality;
/** `full` keeps the camera sway and counting numbers even when the system asks for less. */
export type MotionMode = 'system' | 'reduce' | 'full';

/** The fixed times the clock chip previews, and that the city can be held at. */
export const TIME_PREVIEWS: readonly { label: string; hour: number }[] = [
  { label: 'Morning', hour: 8.5 },
  { label: 'Midday', hour: 13 },
  { label: 'Golden hour', hour: 18.5 },
  { label: 'Night', hour: 22.5 },
];

export interface Settings {
  quality: QualityMode;
  /** The miniature blur at the top and bottom of the view. */
  tiltShift: boolean;
  /** The sun's shadow pass. */
  shadows: boolean;
  motion: MotionMode;
  /** A `TIME_PREVIEWS` label to hold the city at, or null to follow the local clock. */
  time: string | null;
}

export const DEFAULTS: Readonly<Settings> = { quality: 'auto', tiltShift: true, shadows: true, motion: 'system', time: null };

const QUALITY_MODES: readonly QualityMode[] = ['auto', 'high', 'medium', 'low'];
const MOTION_MODES: readonly MotionMode[] = ['system', 'reduce', 'full'];

/** What people call each level. "Medium" and "low" are the code's words, not theirs. */
export const QUALITY_NAMES: Record<QualityMode, string> = { auto: 'Automatic', high: 'High', medium: 'Balanced', low: 'Battery saver' };

/**
 * Reads stored settings, keeping every field that's valid and defaulting the
 * rest, so a damaged or older entry never costs the visitor the choices that
 * survived. Unknown future versions are read the same way (fields only grow).
 */
export function parseSettings(raw: string | null | undefined): Settings {
  let o: Record<string, unknown> = {};
  try {
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    if (v && typeof v === 'object' && !Array.isArray(v)) o = v as Record<string, unknown>;
  } catch {
    // Not JSON: defaults.
  }
  const pick = <T>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback);
  const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
  return {
    quality: pick(o.quality, QUALITY_MODES, DEFAULTS.quality),
    tiltShift: bool(o.tiltShift, DEFAULTS.tiltShift),
    shadows: bool(o.shadows, DEFAULTS.shadows),
    motion: pick(o.motion, MOTION_MODES, DEFAULTS.motion),
    time: TIME_PREVIEWS.some((p) => p.label === o.time) ? (o.time as string) : null,
  };
}

export function serializeSettings(s: Settings): string {
  return JSON.stringify({ v: VERSION, ...s });
}

/**
 * Where the renderer starts and whether it may adapt. A `?quality=` in the
 * address wins (screenshots and support links); Automatic starts at High on
 * a desktop and Balanced on a touch screen, then adapts.
 */
export function startQuality(mode: QualityMode, opts: { coarse: boolean; forced: Quality | null }): { level: Quality; adaptive: boolean } {
  if (opts.forced) return { level: opts.forced, adaptive: false };
  if (mode === 'auto') return { level: opts.coarse ? 'medium' : 'high', adaptive: true };
  return { level: mode, adaptive: false };
}

/** The line under Automatic: what it's running at right now, and why when it stepped down. */
export function autoStatus(level: Quality, coarse: boolean): string {
  // It only ever steps down from where it started (and back up as far as that).
  const start: Quality = coarse ? 'medium' : 'high';
  return level === start ? `Running at ${QUALITY_NAMES[level]}` : `Running at ${QUALITY_NAMES[level]} to keep it smooth`;
}

/** Reduced motion, given the setting and what the system asks for. */
export function motionReduced(mode: MotionMode, systemReduce: boolean): boolean {
  return mode === 'reduce' || (mode === 'system' && systemReduce);
}

// ── The live store ─────────────────────────────────────────────────────

function read(): Settings {
  try {
    return parseSettings(localStorage.getItem(SETTINGS_KEY));
  } catch {
    return { ...DEFAULTS };
  }
}

let current: Settings = read();
const listeners = new Set<(s: Settings, changed: (keyof Settings)[]) => void>();

export function settings(): Readonly<Settings> {
  return current;
}

/** Changes some settings, saves them, and tells everyone listening which ones moved. */
export function updateSettings(patch: Partial<Settings>) {
  const next = { ...current, ...patch };
  const changed = (Object.keys(next) as (keyof Settings)[]).filter((k) => next[k] !== current[k]);
  if (!changed.length) return;
  current = next;
  try {
    localStorage.setItem(SETTINGS_KEY, serializeSettings(current));
  } catch {
    // Storage blocked (private mode): the choice lasts for this visit.
  }
  for (const fn of listeners) fn(current, changed);
}

/** Hears every change; returns the unsubscribe. */
export function onSettings(fn: (s: Settings, changed: (keyof Settings)[]) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * What the renderer is actually doing, published by the Stage: the level it
 * runs at (Automatic moves it), and whether `?quality=` pinned it.
 */
export interface GraphicsStatus {
  level: Quality;
  forced: Quality | null;
  coarse: boolean;
}

let status: GraphicsStatus | null = null;
const statusListeners = new Set<(s: GraphicsStatus) => void>();

export function graphicsStatus(): GraphicsStatus | null {
  return status;
}

export function reportGraphics(s: GraphicsStatus) {
  status = s;
  for (const fn of statusListeners) fn(s);
}

export function onGraphics(fn: (s: GraphicsStatus) => void): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}
