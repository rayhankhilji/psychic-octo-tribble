/**
 * What the city sounds like, as plain numbers: which sound each feed event
 * makes, how the ambience is mixed for an hour and a zoom, and the gate that
 * keeps a 12-days-a-second replay from turning into a slot machine.
 * No Web Audio here, so it can be tested.
 */
import { atmosphereAt } from '../world/daylight.ts';

export type SoundId =
  | 'pluck' // a new customer: one soft marimba note
  | 'pluckLow' // churn: a lower, muted note
  | 'chime' // a small good thing: three rising bell notes
  | 'milestone' // an MRR milestone or a move up the ladder: a longer arpeggio
  | 'release' // a release shipped: a two-note bell
  | 'place' // you built something: a wooden knock and a note
  | 'error' // not quite: two short muted notes
  | 'swell' // the fog lifts: a warm pad that opens up
  | 'decay' // upkeep slipping: a low, soft falling third
  | 'flourish' // the TINYTOWN sign relights: a switch, a run and a chord
  | 'clear' // the rain has cleared
  | 'launch' // rocket lift-off: a low rumble
  | 'heliUp' // rotor spinning up
  | 'heliDown'; // rotor winding down

export interface Cue {
  sound: SoundId;
  /** 0: everyday (needs a token), 1: notable, 2: a moment (always plays, its own gap allowing). */
  priority: 0 | 1 | 2;
  /** Seconds before this same cue can sound again. */
  gap: number;
}

const cue = (sound: SoundId, priority: Cue['priority'], gap: number): Cue => ({ sound, priority, gap });

/** Feed kinds (see `FEED` in src/ui/hud.ts) to cues. Anything missing stays silent. */
const CUES: Record<string, Cue> = {
  'customers.joined': cue('pluck', 0, 0.55),
  'customers.left': cue('pluckLow', 0, 1.4),
  'customers.milestone': cue('chime', 1, 2),
  'district.unlocked': cue('milestone', 2, 2.5),
  'release.shipped': cue('release', 1, 1.5),
  'game.build': cue('place', 2, 0.15),
  'game.error': cue('error', 2, 0.6),
  'game.land.opened': cue('swell', 1, 3),
  'game.region.opened': cue('swell', 2, 3),
  'game.home.moved': cue('milestone', 2, 2.5),
  'game.sign.dark': cue('decay', 1, 4),
  'game.sign.lit': cue('flourish', 2, 4),
  'game.decay': cue('decay', 1, 4),
  'game.homeless.appeared': cue('decay', 1, 4),
  'game.homeless.cleared': cue('chime', 1, 2),
  'account.welcome': cue('flourish', 2, 4),
};

/**
 * The sound for a feed event. `text` refines a few kinds the same way the
 * feed's own icons do (the first customer, the rain clearing, which way the
 * helicopter or rocket is going).
 */
export function cueFor(kind: string, text = ''): Cue | null {
  if (kind === 'customers.joined' && /first/i.test(text)) return cue('chime', 2, 2);
  if (kind === 'weather.changed') return /clear/i.test(text) ? cue('clear', 1, 3) : null; // rain is a bed, not a ding
  if (kind === 'game.moon') return /back/i.test(text) ? cue('chime', 2, 2) : cue('launch', 2, 6);
  if (kind === 'game.heli') return /touched down|back on the pad/i.test(text) ? cue('heliDown', 2, 2) : cue('heliUp', 2, 2);
  return CUES[kind] ?? null;
}

/**
 * Rate limiting for event sounds. Everyday cues spend from a small bucket
 * (`burst` tokens, refilled at `perSecond`), so a replay plays a gentle
 * sprinkle of notes rather than one per day. Each cue also waits its own
 * gap, and everyday cues step aside for a moment after a big one, so a
 * milestone is never trodden on by a customer pluck.
 */
export class Gate {
  private tokens: number;
  private at = -Infinity;
  private last = new Map<string, number>();
  private bigUntil = -Infinity;
  private readonly perSecond: number;
  private readonly burst: number;

  constructor(perSecond = 2.5, burst = 3) {
    this.perSecond = perSecond;
    this.burst = burst;
    this.tokens = burst;
  }

  /** True when `c` may play at `now` (seconds); records it if so. */
  allow(c: Cue, now: number, key: string = c.sound): boolean {
    this.tokens = Math.min(this.burst, this.tokens + (now - this.at) * this.perSecond);
    this.at = now;
    const prev = this.last.get(key) ?? -Infinity;
    if (now - prev < c.gap) return false;
    if (c.priority === 0 && now < this.bigUntil) return false;
    if (c.priority < 2) {
      if (this.tokens < 1) return false;
      this.tokens -= 1;
    }
    if (c.priority > 0) this.bigUntil = now + (c.priority === 2 ? 1.2 : 0.5);
    this.last.set(key, now);
    return true;
  }
}

/** The ambience for a moment: bed levels 0–1 and how many of each call per minute. */
export interface AmbienceMix {
  /** Distant traffic hush. */
  city: number;
  /** The bay: slow swells and wash. */
  water: number;
  /** High, open air: more when zoomed out. */
  wind: number;
  crickets: number;
  rain: number;
  /** Low-pass for the city bed in Hz: brighter by day, darker and further at night. */
  cityTone: number;
  /** Calls per minute. */
  gulls: number;
  bells: number;
  foghorn: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Camera zoom (0.32 out over the bay … 14 on a doorstep) to 0 far … 1 close, on a log scale. */
export function closenessOf(zoom: number): number {
  return clamp01((Math.log(Math.max(0.01, zoom)) - Math.log(0.45)) / (Math.log(4) - Math.log(0.45)));
}

/**
 * The mix for a local hour, a camera zoom and the weather. Follows the
 * world's own light (`atmosphereAt(hour).night`), so the sound turns with
 * the picture: lively by day, warmer at golden hour, crickets and a softer
 * bay at night. Close up you hear the streets; far out, wind and water.
 */
export function ambienceMix(hour: number, zoom: number, rain: boolean): AmbienceMix {
  const h = ((hour % 24) + 24) % 24;
  const night = atmosphereAt(h).night;
  const day = 1 - night;
  const close = closenessOf(zoom);
  const far = 1 - close;
  // Fog rolls in through the Gate at dawn and in the evening: that's when the horns sound.
  const foggy = Math.max(Math.exp(-(((h - 6.8) / 1.4) ** 2)), Math.exp(-(((h - 19.6) / 1.8) ** 2)));
  const wet = rain ? 1 : 0;
  return {
    city: (0.3 + 0.7 * day) * (0.4 + 0.6 * close) * (1 - 0.25 * wet),
    water: (0.5 + 0.5 * far) * (1 - 0.3 * night),
    wind: (0.12 + 0.88 * far ** 1.4) * (1 + 0.25 * wet),
    crickets: smoothstep(0.55, 1, night) * (0.35 + 0.65 * close) * (1 - 0.7 * wet),
    rain: wet,
    cityTone: 480 + 720 * day,
    gulls: 2.2 * day * (0.35 + 0.65 * Math.max(close, far * 0.8)) * (1 - 0.7 * wet),
    bells: 1.4 * (0.25 + 0.75 * day) * close ** 1.3 * (1 - 0.5 * wet),
    foghorn: 0.25 + 0.75 * foggy + 0.2 * night,
  };
}

/** D major pentatonic, the key every melodic sound shares so they never clash. */
const PENTA = [0, 2, 4, 7, 9];
const D4 = 293.66;

/** Frequency of pentatonic step `n` (0 = D4, 5 = D5, −5 = D3…). */
export function pentatonic(n: number): number {
  const oct = Math.floor(n / 5);
  const semis = PENTA[((n % 5) + 5) % 5]! + 12 * oct;
  return D4 * 2 ** (semis / 12);
}

/**
 * The next note for a customer pluck: a gentle random walk on the scale,
 * kept within an octave and a half, so a stream of new customers in a replay
 * plays a little tune instead of one note over and over.
 */
export function nextStep(prev: number, r: number): number {
  const moves = [-2, -1, -1, 1, 1, 2, 3];
  let n = prev + moves[Math.floor(r * moves.length) % moves.length]!;
  if (n < 2) n += 3;
  if (n > 9) n -= 4;
  return n;
}
