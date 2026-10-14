/**
 * The city's ambience: a few always-on beds (the bay, the streets, the wind,
 * rain, crickets) whose levels follow `AmbienceMix`, plus calls scheduled now
 * and then (gulls, a cable-car bell, the Golden Gate's foghorn).
 *
 * Built once when sound is switched on: about fifty native nodes, three
 * looping noise buffers and no per-frame JavaScript. `update()` runs four
 * times a second and only moves gain and filter targets.
 */
import type { AmbienceMix } from './cues.ts';
import { bell, colouredNoise, type Rig } from './sfx.ts';

const db = (v: number) => 10 ** (v / 20);

/** Bed levels at mix 1, in dBFS before the master: a quiet room, never a wall of noise. */
const LEVEL = { water: -24, city: -30, wind: -33, rain: -28, crickets: -38 };

export class Ambience {
  private r: Rig;
  private out: GainNode;
  private water: GainNode;
  private city: GainNode;
  private cityTone: BiquadFilterNode[];
  private wind: GainNode;
  private rain: GainNode;
  private crickets: GainNode;
  private sources: AudioScheduledSourceNode[] = [];
  private gullLevel = 0;
  private bellLevel = 0;
  private lastHorn = -Infinity;

  constructor(r: Rig, dest: AudioNode) {
    this.r = r;
    const ctx = r.ctx;
    this.out = ctx.createGain();
    this.out.connect(dest);
    const brown = this.loop(colouredNoise(ctx, 'brown', 5));
    const pinkA = this.loop(colouredNoise(ctx, 'pink', 4));
    const pinkB = this.loop(colouredNoise(ctx, 'pink', 4.6));

    // ── The bay: low swells with a lighter wash riding each one ─────────
    this.water = this.bus();
    const swell = this.filter('lowpass', 420, 0.5);
    const swellAmp = ctx.createGain();
    swellAmp.gain.value = 0.62;
    brown.connect(swell).connect(swellAmp).connect(this.water);
    const wash = this.filter('bandpass', 1150, 0.55);
    const washAmp = ctx.createGain();
    washAmp.gain.value = 0.25;
    pinkA.connect(wash).connect(washAmp).connect(this.water);
    // Two slow, unrelated cycles, so the waves never fall into a metronome. The wash
    // follows each swell a couple of seconds later, as a wave breaks after it rises.
    this.lfo(0.12, 0.28, swellAmp.gain, washAmp.gain, 0.15, 1.8);
    this.lfo(0.193, 0.16, swellAmp.gain, washAmp.gain, 0.09, 1.1);
    const waterSend = ctx.createGain();
    waterSend.gain.value = 0.15;
    this.water.connect(waterSend).connect(r.wet);

    // ── The streets: a soft band of distant traffic, darker at night ─────
    this.city = this.bus();
    // Two low-passes in a row: a steep slope, so it reads as far-off engines, not hiss.
    this.cityTone = [this.filter('lowpass', 1100, 0.5), this.filter('lowpass', 1100, 0.5)];
    const rumbleCut = this.filter('highpass', 90, 0.5);
    const cityAmp = ctx.createGain();
    cityAmp.gain.value = 0.85;
    pinkB.connect(this.cityTone[0]!).connect(this.cityTone[1]!).connect(rumbleCut).connect(cityAmp).connect(this.city);
    this.lfo(0.037, 0.15, cityAmp.gain);

    // ── Wind: open air with a slowly wandering whistle ───────────────────
    this.wind = this.bus();
    const gust = this.filter('bandpass', 560, 1.4);
    const windAmp = ctx.createGain();
    windAmp.gain.value = 0.8;
    pinkB.connect(gust).connect(windAmp).connect(this.wind);
    this.lfo(0.061, 260, gust.frequency);
    this.lfo(0.047, 0.25, windAmp.gain);

    // ── Rain: when MRR falls more than 1% in a week ─────────────────────
    this.rain = this.bus();
    const hiss = this.filter('highpass', 1400, 0.5);
    const soft = this.filter('lowpass', 6500, 0.4);
    pinkA.connect(hiss).connect(soft).connect(this.rain);

    // ── Crickets: two field crickets in the grass, out of step ───────────
    this.crickets = this.bus();
    this.cricket(4480, 1.7, -0.5);
    this.cricket(4760, 2.3, 0.45);
  }

  /** Moves every bed toward `m` over a second or two (no jumps when you zoom or the hour turns). */
  update(m: AmbienceMix, t: number) {
    const to = (g: GainNode, v: number, level: number) => g.gain.setTargetAtTime(v * db(level), t, 1.2);
    to(this.water, m.water, LEVEL.water);
    to(this.city, m.city, LEVEL.city);
    to(this.wind, m.wind, LEVEL.wind);
    to(this.rain, m.rain, LEVEL.rain);
    to(this.crickets, m.crickets, LEVEL.crickets);
    for (const f of this.cityTone) f.frequency.setTargetAtTime(m.cityTone, t, 2);
    this.gullLevel = Math.min(1, 0.4 + m.water * 0.6);
    this.bellLevel = Math.min(1, 0.3 + m.city);
  }

  /** Rolls the dice for the occasional calls over the last `dt` seconds. */
  calls(m: AmbienceMix, t: number, dt: number, rand = Math.random) {
    const chance = (perMinute: number) => rand() < 1 - Math.exp((-perMinute * dt) / 60);
    if (chance(m.gulls)) this.gulls(t + rand() * 0.2);
    if (chance(m.bells)) this.cableCar(t + rand() * 0.2);
    // The horns are slow and far apart: at least forty seconds between blasts.
    if (t - this.lastHorn > 40 && chance(m.foghorn)) {
      this.lastHorn = t;
      this.foghorn(t + 0.1);
    }
  }

  /** Fades the beds in from silence (when sound is switched on). */
  fadeIn(t: number) {
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(0, t);
    this.out.gain.linearRampToValueAtTime(1, t + 2.5);
  }

  dispose() {
    for (const s of this.sources) s.stop();
    this.out.disconnect();
  }

  // ── Calls ──────────────────────────────────────────────────────────────

  /** A herring gull over the water: one long "kee-ow", then a few short laughing calls. */
  gulls(t: number) {
    const ctx = this.r.ctx;
    const pan = Math.random() * 1.4 - 0.7;
    const base = 1250 + Math.random() * 300;
    const level = db(-36) * this.gullLevel;
    const calls = 1 + Math.floor(Math.random() * 4);
    const out = ctx.createStereoPanner();
    out.pan.value = pan;
    const tone = this.filter('bandpass', 1900, 1.1);
    const send = ctx.createGain();
    send.gain.value = 0.55;
    tone.connect(out);
    out.connect(this.out);
    out.connect(send).connect(this.r.wet);
    let at = t;
    let last: OscillatorNode | null = null;
    for (let i = 0; i < calls; i++) {
      const long = i === 0;
      const len = long ? 0.42 : 0.16 + Math.random() * 0.05;
      const f = base * (long ? 1 : 1.12 - i * 0.04);
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f * 0.82, at);
      o.frequency.linearRampToValueAtTime(f * 1.18, at + len * 0.3);
      o.frequency.linearRampToValueAtTime(f * 0.7, at + len);
      const vib = ctx.createOscillator();
      vib.frequency.value = 22;
      const vibDepth = ctx.createGain();
      vibDepth.gain.value = f * 0.02;
      vib.connect(vibDepth).connect(o.frequency);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(level * (long ? 1 : 0.8), at + 0.03);
      env.gain.setValueAtTime(level * (long ? 1 : 0.8), at + len * 0.6);
      env.gain.linearRampToValueAtTime(0, at + len);
      o.connect(env).connect(tone);
      o.start(at);
      vib.start(at);
      o.stop(at + len + 0.02);
      vib.stop(at + len + 0.02);
      o.onended = () => {
        o.disconnect();
        vib.disconnect();
        vibDepth.disconnect();
        env.disconnect();
      };
      last = o;
      at += len + (long ? 0.12 : 0.07 + Math.random() * 0.05);
    }
    if (last) last.addEventListener('ended', () => (tone.disconnect(), out.disconnect(), send.disconnect()));
  }

  /** A cable car's bell a few streets away: the gripman's ding-ding, sometimes a little rhythm. */
  cableCar(t: number) {
    const patterns = [
      [0, 0.2],
      [0, 0.17, 0.5, 0.64],
      [0, 0.13, 0.26, 0.52, 0.65],
    ];
    const p = patterns[Math.floor(Math.random() * patterns.length)]!;
    const pan = Math.random() * 1.2 - 0.6;
    const level = -37 + 6 * Math.log10(this.bellLevel + 0.01);
    for (const d of p) bell(this.r, t + d, 1318, { level: level - (Math.random() * 2), decay: 0.9, ratio: 1.41, index: 1.6, wet: 0.5, pan });
  }

  /**
   * The Golden Gate's horn, far off: a two-tone diaphone ("beee-ohh") that
   * the bay carries for miles. Mostly reverb, a long way to the left.
   */
  foghorn(t: number) {
    const ctx = this.r.ctx;
    const lp = this.filter('lowpass', 380, 0.7);
    const env = ctx.createGain();
    const len = 1.9;
    const level = db(-33);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(level, t + 0.35);
    env.gain.setValueAtTime(level, t + len);
    env.gain.linearRampToValueAtTime(0, t + len + 0.7);
    const pan = ctx.createStereoPanner();
    pan.pan.value = -0.55;
    const send = ctx.createGain();
    send.gain.value = 0.9;
    lp.connect(env).connect(pan);
    pan.connect(this.out);
    pan.connect(send).connect(this.r.wet);
    const oscs: OscillatorNode[] = [];
    for (const detune of [-6, 5]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.detune.value = detune;
      // High tone, then the low "grunt" the diaphone is famous for.
      o.frequency.setValueAtTime(174.6, t);
      o.frequency.setValueAtTime(174.6, t + len * 0.48);
      o.frequency.exponentialRampToValueAtTime(130.8, t + len * 0.56);
      o.frequency.setValueAtTime(130.8, t + len);
      o.frequency.exponentialRampToValueAtTime(118, t + len + 0.7);
      o.connect(lp);
      o.start(t);
      o.stop(t + len + 0.75);
      oscs.push(o);
    }
    oscs[0]!.onended = () => {
      for (const n of [...oscs, lp, env, pan, send]) n.disconnect();
    };
  }

  // ── Building blocks ────────────────────────────────────────────────────

  private bus(): GainNode {
    const g = this.r.ctx.createGain();
    g.gain.value = 0;
    g.connect(this.out);
    return g;
  }

  private filter(type: BiquadFilterType, freq: number, q: number): BiquadFilterNode {
    const f = this.r.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  private loop(buffer: AudioBuffer): AudioBufferSourceNode {
    const s = this.r.ctx.createBufferSource();
    s.buffer = buffer;
    s.loop = true;
    s.start(0, Math.random() * buffer.duration);
    this.sources.push(s);
    return s;
  }

  /** A slow sine nudging one or two params (the second by its own depth, `lag` seconds behind). */
  private lfo(hz: number, depth: number, a: AudioParam, b?: AudioParam, depthB = depth, lag = 0) {
    const ctx = this.r.ctx;
    const o = ctx.createOscillator();
    o.frequency.value = hz;
    const g = ctx.createGain();
    g.gain.value = depth;
    o.connect(g).connect(a);
    if (b) {
      const g2 = ctx.createGain();
      g2.gain.value = depthB;
      const delay = ctx.createDelay(4);
      delay.delayTime.value = lag;
      o.connect(delay).connect(g2).connect(b);
    }
    o.start();
    this.sources.push(o);
  }

  /**
   * One field cricket: a 4.5 kHz tone, trilled at ~30 Hz, gated into short
   * chirps by a sawtooth through a pulse-shaped curve (a fifth of each cycle).
   */
  private cricket(freq: number, chirpsPerSecond: number, pan: number) {
    const ctx = this.r.ctx;
    const tone = ctx.createOscillator();
    tone.frequency.value = freq;
    const trill = ctx.createGain();
    trill.gain.value = 0.5;
    const pulse = ctx.createOscillator();
    pulse.frequency.value = 29 + Math.random() * 6;
    const pulseDepth = ctx.createGain();
    pulseDepth.gain.value = 0.5;
    pulse.connect(pulseDepth).connect(trill.gain);
    const chirp = ctx.createGain();
    chirp.gain.value = 0;
    const clock = ctx.createOscillator();
    clock.type = 'sawtooth';
    clock.frequency.value = chirpsPerSecond;
    const shape = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      // The bump sits mid-ramp, well away from the sawtooth's wrap (its ringing would click).
      curve[i] = Math.abs(x) < 0.2 ? Math.sin((Math.PI * (x + 0.2)) / 0.4) ** 2 : 0;
    }
    shape.curve = curve;
    clock.connect(shape).connect(chirp.gain);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    tone.connect(trill).connect(chirp).connect(p).connect(this.crickets);
    for (const o of [tone, pulse, clock]) {
      o.start();
      this.sources.push(o);
    }
  }
}
