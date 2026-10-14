/**
 * TinyTown's sound: off until the visitor turns it on, remembered per
 * browser, quiet by default, silent while the tab is hidden. Everything is
 * synthesised with the Web Audio API (no files), and the AudioContext isn't
 * created until a click asks for sound, so a muted visit costs nothing.
 *
 * The HUD feeds it: `setHour()` from the clock (four times a second), `cue()`
 * for every feed event, `ui()` for clicks and dialogs. `listen()` adds the
 * camera zoom and the weather when the app provides them.
 */
import { ambienceMix, cueFor, Gate, nextStep, type AmbienceMix } from './cues.ts';
import { Ambience } from './ambience.ts';
import { crackleBuffer, firework, hello, impulse, play, tick, whiteNoise, whoosh, type Rig } from './sfx.ts';

const KEY = 'tinytown:sound';
/** Master level. Every sound is mixed well under full scale; this keeps the whole thing a background. */
const VOLUME = 0.9;
const UPDATE_MS = 250;

export interface SoundScene {
  /** Camera zoom (Stage's orthographic zoom). */
  zoom?: number;
  rain?: boolean;
}

interface Stored {
  on: boolean;
  volume: number;
}

function load(): Stored {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Stored> | null;
    return { on: s?.on === true, volume: typeof s?.volume === 'number' ? Math.max(0, Math.min(1, s.volume)) : VOLUME };
  } catch {
    return { on: false, volume: VOLUME };
  }
}

export class Sound {
  /** Called when sound turns on or off (the HUD's button listens). */
  onChange: ((on: boolean) => void) | null = null;
  private stored = load();
  private ctx: AudioContext | null = null;
  private rig: Rig | null = null;
  private master: GainNode | null = null;
  private ambience: Ambience | null = null;
  private timer = 0;
  private last = 0;
  private hour = 12;
  private rain = false;
  private source: (() => SoundScene) | null = null;
  private gate = new Gate();
  private fireworks = new Gate(3, 4);
  private uiAt = 0;
  private step = 5;

  constructor() {
    document.addEventListener('visibilitychange', () => this.visibility());
    // Remembered "on" from an earlier visit: browsers only let audio start after a
    // gesture, so wake on the first one. (Off stays off until the button says so.)
    if (this.stored.on) {
      const wake = () => {
        window.removeEventListener('pointerdown', wake, true);
        window.removeEventListener('keydown', wake, true);
        if (this.stored.on) this.start(false);
      };
      window.addEventListener('pointerdown', wake, true);
      window.addEventListener('keydown', wake, true);
    }
  }

  get on(): boolean {
    return this.stored.on;
  }

  /** Turns sound on or off. Call from a click or key press, so the browser allows audio. */
  toggle(on = !this.stored.on) {
    this.stored.on = on;
    this.save();
    if (on) this.start(true);
    else this.stop();
    this.onChange?.(on);
  }

  /** The world's hour (from the HUD clock). */
  setHour(hour: number) {
    this.hour = hour;
  }

  /** Lets the app share the camera zoom and the weather with the ambience. */
  listen(source: () => SoundScene) {
    this.source = source;
  }

  /** A feed event. `quiet` (scrubbing the timeline) skips it. */
  cue(kind: string, text: string, quiet = false) {
    if (kind === 'weather.changed') this.rain = !/clear/i.test(text);
    const t = this.now();
    if (t === null || quiet) return;
    const c = cueFor(kind, text);
    if (!c || !this.gate.allow(c, t)) return;
    if (c.sound === 'pluck' || c.sound === 'pluckLow') this.step = nextStep(this.step, Math.random());
    play(this.rig!, c.sound, t + 0.02, this.step);
  }

  /** A firework bursting. A show stays a show: at most a few booms a second, softer when crowded. */
  firework() {
    const t = this.now();
    if (t === null || !this.fireworks.allow({ sound: 'launch', priority: 1, gap: 0.08 }, t)) return;
    firework(this.rig!, t + 0.01, 0.7 + Math.random() * 0.3);
  }

  /** Interface sounds: a tick for a press, a breath for a dialog. */
  ui(kind: 'tick' | 'whoosh') {
    const t = this.now();
    if (t === null || t - this.uiAt < 0.04) return;
    this.uiAt = t;
    (kind === 'tick' ? tick : whoosh)(this.rig!, t + 0.005);
  }

  /** The current mix, for tests and debugging. */
  mix(): AmbienceMix {
    const scene = this.source?.() ?? {};
    return ambienceMix(this.hour, scene.zoom ?? 1, scene.rain ?? this.rain);
  }

  // ── Plumbing ─────────────────────────────────────────────────────────

  /** Context time when sound is on, running and visible; null otherwise. */
  private now(): number | null {
    const c = this.ctx;
    if (!this.stored.on || !c || c.state !== 'running' || document.hidden) return null;
    return c.currentTime;
  }

  private start(greet: boolean) {
    if (!this.ctx) {
      try {
        this.build();
      } catch {
        // No Web Audio (very old browsers, some privacy modes): stay silent.
        return;
      }
    }
    const ctx = this.ctx!;
    void ctx.resume().then(() => {
      if (!this.stored.on) return;
      const t = ctx.currentTime;
      this.master!.gain.cancelScheduledValues(t);
      this.master!.gain.setValueAtTime(this.master!.gain.value, t);
      this.master!.gain.linearRampToValueAtTime(this.stored.volume, t + 0.4);
      this.ambience!.update(this.mix(), t);
      this.ambience!.fadeIn(t);
      if (greet) hello(this.rig!, t + 0.05);
      this.run();
    });
  }

  private stop() {
    const ctx = this.ctx;
    this.halt();
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    this.master!.gain.cancelScheduledValues(t);
    this.master!.gain.setValueAtTime(this.master!.gain.value, t);
    this.master!.gain.linearRampToValueAtTime(0, t + 0.3);
    // Let the fade finish, then let the context sleep (no CPU while muted).
    window.setTimeout(() => !this.stored.on && void ctx.suspend(), 400);
  }

  private build() {
    const ctx = new AudioContext({ latencyHint: 'balanced' });
    const g = graph(ctx);
    g.master.gain.value = 0;
    this.rig = g.rig;
    this.ambience = new Ambience(g.rig, g.master);
    this.master = g.master;
    this.ctx = ctx;
  }

  /** The 250 ms loop: move the beds toward the mix and roll for the odd gull or horn. */
  private run() {
    if (this.timer) return;
    this.last = this.ctx!.currentTime;
    this.timer = window.setInterval(() => {
      const t = this.now();
      if (t === null) return;
      const m = this.mix();
      this.ambience!.update(m, t);
      this.ambience!.calls(m, t, Math.min(1, t - this.last));
      this.last = t;
    }, UPDATE_MS);
  }

  private halt() {
    window.clearInterval(this.timer);
    this.timer = 0;
  }

  private visibility() {
    const ctx = this.ctx;
    if (!ctx || !this.stored.on) return;
    if (document.hidden) {
      this.halt();
      void ctx.suspend();
    } else {
      void ctx.resume().then(() => this.stored.on && this.run());
    }
  }

  private save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.stored));
    } catch {
      // Storage blocked: the choice lasts for this visit.
    }
  }
}

/**
 * The shared graph: a master gain into a gentle limiter, and one soft hall
 * every sound can send to. Exported so an OfflineAudioContext can render
 * exactly what the browser plays (to check levels without ears).
 */
export function graph(ctx: BaseAudioContext, volume = VOLUME): { rig: Rig; master: GainNode } {
  const master = ctx.createGain();
  master.gain.value = volume;
  // A safety net: nothing the city does should ever get near full scale.
  const limit = ctx.createDynamicsCompressor();
  limit.threshold.value = -18;
  limit.knee.value = 12;
  limit.ratio.value = 4;
  limit.attack.value = 0.004;
  limit.release.value = 0.3;
  master.connect(limit).connect(ctx.destination);
  const reverb = ctx.createConvolver();
  reverb.buffer = impulse(ctx);
  const wet = ctx.createGain();
  wet.gain.value = 0.32;
  reverb.connect(wet).connect(master);
  return { rig: { ctx, dry: master, wet: reverb, noise: whiteNoise(ctx), crackle: crackleBuffer(ctx) }, master };
}
