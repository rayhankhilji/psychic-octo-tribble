/**
 * Event sounds, synthesised on the spot: soft bells, a wooden knock, a warm
 * pad, distant fireworks. Every melodic sound is on the same D major
 * pentatonic scale, so two that overlap still sound like one piece. Each
 * call builds a few short-lived nodes that stop and disconnect themselves.
 *
 * Levels are set for a quiet room. Measured offline through the master
 * (OfflineAudioContext): a customer's pluck peaks near −31 dBFS, a build
 * near −20, and the biggest moment (the sign relighting) near −12. The UI
 * tick sits around −42, under an ambience of about −38 dBFS RMS.
 */
import { pentatonic, type SoundId } from './cues.ts';

/** Where a sound goes: the dry bus, the reverb send, and shared noise. */
export interface Rig {
  ctx: BaseAudioContext;
  dry: AudioNode;
  wet: AudioNode;
  /** A few seconds of looping-safe white noise (stereo). */
  noise: AudioBuffer;
  /** Sparse random clicks with a decaying density: fireworks crackle. */
  crackle: AudioBuffer;
}

const db = (v: number) => 10 ** (v / 20);

/** Stops and disconnects a sound's nodes once it's done, so nothing piles up. */
function retire(stopAt: number, sources: AudioScheduledSourceNode[], nodes: AudioNode[]) {
  for (const s of sources) s.stop(stopAt);
  const first = sources[0];
  if (first)
    first.onended = () => {
      for (const n of [...sources, ...nodes]) n.disconnect();
    };
}

/** A gain node with a 0 → peak → 0 envelope (exponential tail). */
function envelope(r: Rig, t: number, peak: number, attack: number, decay: number): GainNode {
  const g = r.ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.setTargetAtTime(0, t + attack, decay / 4);
  return g;
}

/**
 * A soft FM bell or mallet. `ratio` 1–2 is woody and warm (marimba, Rhodes);
 * 3.5 is glassier (celesta). The brightness (modulation index) dies away
 * faster than the note, which is what makes it sound struck.
 */
export function bell(r: Rig, t: number, freq: number, opts: { level?: number; decay?: number; ratio?: number; index?: number; wet?: number; pan?: number; attack?: number } = {}) {
  const { level = -26, decay = 1.6, ratio = 2, index = 1.2, wet = 0.35, pan = 0, attack = 0.005 } = opts;
  const ctx = r.ctx;
  const car = ctx.createOscillator();
  car.frequency.value = freq;
  const mod = ctx.createOscillator();
  mod.frequency.value = freq * ratio;
  const depth = ctx.createGain();
  depth.gain.setValueAtTime(freq * index, t);
  depth.gain.setTargetAtTime(freq * index * 0.08, t, decay / 6);
  mod.connect(depth).connect(car.frequency);
  const env = envelope(r, t, db(level), attack, decay);
  const p = ctx.createStereoPanner();
  p.pan.value = pan;
  const send = ctx.createGain();
  send.gain.value = wet;
  car.connect(env).connect(p);
  p.connect(r.dry);
  p.connect(send).connect(r.wet);
  car.start(t);
  mod.start(t);
  retire(t + decay * 1.6 + 0.1, [car, mod], [depth, env, p, send]);
}

/** A burst of filtered noise: clicks, breaths, whooshes, rain on the glass. */
function noise(r: Rig, t: number, opts: { level: number; attack: number; decay: number; type?: BiquadFilterType; freq: number; to?: number; q?: number; wet?: number; rate?: number; buffer?: AudioBuffer; pan?: number }) {
  const ctx = r.ctx;
  const src = ctx.createBufferSource();
  src.buffer = opts.buffer ?? r.noise;
  src.playbackRate.value = opts.rate ?? 1;
  const f = ctx.createBiquadFilter();
  f.type = opts.type ?? 'bandpass';
  f.frequency.setValueAtTime(opts.freq, t);
  if (opts.to) f.frequency.exponentialRampToValueAtTime(opts.to, t + opts.attack + opts.decay * 0.6);
  f.Q.value = opts.q ?? 0.8;
  const env = envelope(r, t, db(opts.level), opts.attack, opts.decay);
  const p = ctx.createStereoPanner();
  p.pan.value = opts.pan ?? 0;
  src.connect(f).connect(env).connect(p);
  p.connect(r.dry);
  const nodes: AudioNode[] = [f, env, p];
  if (opts.wet) {
    const send = ctx.createGain();
    send.gain.value = opts.wet;
    p.connect(send).connect(r.wet);
    nodes.push(send);
  }
  // Plain noise starts somewhere random so repeats never sound identical; shaped buffers start at the top.
  src.start(t, opts.buffer ? 0 : Math.random() * Math.max(0, src.buffer.duration - opts.attack - opts.decay * 1.6 - 0.05));
  retire(t + opts.attack + opts.decay * 1.6 + 0.05, [src], nodes);
}

/** A pitched thump: a sine falling in pitch (a knock's body, a firework's boom). */
function thump(r: Rig, t: number, from: number, to: number, level: number, decay: number, wet = 0.1) {
  const ctx = r.ctx;
  const o = ctx.createOscillator();
  o.frequency.setValueAtTime(from, t);
  o.frequency.exponentialRampToValueAtTime(to, t + decay * 0.5);
  const env = envelope(r, t, db(level), 0.002, decay);
  o.connect(env).connect(r.dry);
  const send = ctx.createGain();
  send.gain.value = wet;
  env.connect(send).connect(r.wet);
  o.start(t);
  retire(t + decay * 1.6 + 0.05, [o], [env, send]);
}

/**
 * A slow pad chord: detuned triangles through a low-pass that opens and
 * closes. The fog lifting, the base of a celebration.
 */
function pad(r: Rig, t: number, steps: number[], opts: { level: number; attack: number; hold: number; release: number; open: number }) {
  const ctx = r.ctx;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.Q.value = 0.6;
  f.frequency.setValueAtTime(260, t);
  f.frequency.exponentialRampToValueAtTime(opts.open, t + opts.attack + opts.hold * 0.5);
  f.frequency.setTargetAtTime(300, t + opts.attack + opts.hold, opts.release / 3);
  const env = ctx.createGain();
  const end = t + opts.attack + opts.hold;
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(db(opts.level), t + opts.attack);
  env.gain.setValueAtTime(db(opts.level), end);
  env.gain.setTargetAtTime(0, end, opts.release / 4);
  const send = ctx.createGain();
  send.gain.value = 0.6;
  f.connect(env);
  env.connect(r.dry);
  env.connect(send).connect(r.wet);
  const oscs: OscillatorNode[] = [];
  const pans: AudioNode[] = [];
  steps.forEach((s, i) => {
    for (const detune of [-4, 4]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = pentatonic(s);
      o.detune.value = detune + (Math.random() - 0.5) * 4;
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-0.8, Math.min(0.8, (detune > 0 ? 0.35 : -0.35) + (i - steps.length / 2) * 0.12));
      const g = ctx.createGain();
      g.gain.value = 1 / steps.length;
      o.connect(g).connect(p).connect(f);
      o.start(t);
      oscs.push(o);
      pans.push(p, g);
    }
  });
  retire(end + opts.release * 1.5, oscs, [...pans, f, env, send]);
}

/** Plays an event sound at `t` (context time). `step` picks the pluck's note. */
export function play(r: Rig, sound: SoundId, t: number, step = 5) {
  switch (sound) {
    case 'pluck':
      // A marimba note with a whisper of a woody tap: barely-there, many in a row make a tune.
      bell(r, t, pentatonic(step), { level: -29, decay: 0.9, ratio: 1, index: 0.9, wet: 0.3, pan: (step - 6) * 0.08, attack: 0.007 });
      return;
    case 'pluckLow':
      bell(r, t, pentatonic(step - 5), { level: -31, decay: 0.7, ratio: 1, index: 0.5, wet: 0.25, attack: 0.012 });
      return;
    case 'chime': {
      const notes = [5, 7, 9];
      notes.forEach((n, i) => bell(r, t + i * 0.085, pentatonic(n), { level: -27 - i, decay: 1.8, ratio: 3.5, index: 0.6, wet: 0.45, pan: (i - 1) * 0.25 }));
      return;
    }
    case 'milestone': {
      // Up the scale and settle on a high D, over a short warm chord.
      const notes = [5, 7, 8, 9, 10, 12];
      notes.forEach((n, i) => bell(r, t + i * 0.075, pentatonic(n), { level: -26 - i * 0.5, decay: 2.2, ratio: 3.5, index: 0.7, wet: 0.5, pan: (i / (notes.length - 1) - 0.5) * 0.6 }));
      pad(r, t, [0, 2, 3], { level: -30, attack: 0.25, hold: 0.6, release: 1.6, open: 1400 });
      return;
    }
    case 'release':
      // Ding-dong, a rising fourth, like a shop door in the Mission.
      bell(r, t, pentatonic(8), { level: -26, decay: 2, ratio: 3.5, index: 0.8, wet: 0.45, pan: -0.15 });
      bell(r, t + 0.16, pentatonic(10), { level: -25, decay: 2.6, ratio: 3.5, index: 0.8, wet: 0.5, pan: 0.15 });
      return;
    case 'place':
      // A wooden block set down: a hollow knock with a quick second touch, and a soft note on top.
      thump(r, t, 260, 120, -20, 0.09, 0.05);
      noise(r, t, { level: -28, attack: 0.001, decay: 0.03, freq: 2400, q: 2.2 });
      bell(r, t, 520, { level: -30, decay: 0.12, ratio: 2.7, index: 1.4, wet: 0.1 });
      thump(r, t + 0.085, 300, 150, -27, 0.07, 0.05);
      bell(r, t + 0.09, pentatonic(7), { level: -33, decay: 1.1, ratio: 1, index: 0.8, wet: 0.35 });
      return;
    case 'error':
      // "Hm-mm": two short muted notes stepping down. Polite, not a buzzer.
      bell(r, t, pentatonic(2), { level: -29, decay: 0.25, ratio: 1, index: 0.4, wet: 0.15, attack: 0.01 });
      bell(r, t + 0.11, pentatonic(0), { level: -30, decay: 0.35, ratio: 1, index: 0.3, wet: 0.15, attack: 0.01 });
      return;
    case 'swell':
      // The fog burning off: a breath of air that rises, a chord that opens, one bell at the top.
      noise(r, t, { level: -34, attack: 1.1, decay: 1.6, freq: 500, to: 2600, q: 0.7, wet: 0.6 });
      pad(r, t, [0, 3, 4, 6], { level: -27, attack: 1.2, hold: 0.8, release: 2.4, open: 2200 });
      bell(r, t + 1.25, pentatonic(13), { level: -31, decay: 2.6, ratio: 3.5, index: 0.5, wet: 0.7 });
      return;
    case 'decay':
      // A soft, low falling third: something needs looking after. Never an alarm.
      bell(r, t, pentatonic(-2), { level: -25, decay: 1.4, ratio: 1, index: 0.35, wet: 0.35, attack: 0.03 });
      bell(r, t + 0.32, pentatonic(-3), { level: -26, decay: 1.8, ratio: 1, index: 0.3, wet: 0.4, attack: 0.03 });
      return;
    case 'flourish': {
      // The sign's big switch, then the bulbs chase on: a run up two octaves and a full chord.
      thump(r, t, 140, 60, -22, 0.16, 0.2);
      noise(r, t, { level: -30, attack: 0.001, decay: 0.05, freq: 1800, q: 1.4, wet: 0.2 });
      const run = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      run.forEach((n, i) => bell(r, t + 0.22 + i * 0.055, pentatonic(n + 2), { level: -29 + i * 0.2, decay: 1.6, ratio: 3.5, index: 0.6, wet: 0.5, pan: (i / run.length - 0.5) * 0.9 }));
      const top = t + 0.22 + run.length * 0.055;
      pad(r, top - 0.1, [0, 2, 3, 5, 7], { level: -24, attack: 0.2, hold: 1.2, release: 2.8, open: 2600 });
      for (const [n, d] of [[12, 0], [14, 0.2], [15, 0.45], [17, 0.75]] as const) bell(r, top + d, pentatonic(n), { level: -33, decay: 2.4, ratio: 3.5, index: 0.4, wet: 0.8, pan: Math.random() - 0.5 });
      return;
    }
    case 'clear':
      bell(r, t, pentatonic(7), { level: -30, decay: 1.6, ratio: 3.5, index: 0.5, wet: 0.5 });
      bell(r, t + 0.2, pentatonic(9), { level: -30, decay: 2, ratio: 3.5, index: 0.5, wet: 0.55 });
      return;
    case 'launch':
      // A long low roar across the bay, felt more than heard.
      noise(r, t, { level: -20, attack: 1.4, decay: 5, type: 'lowpass', freq: 160, to: 420, q: 0.5, wet: 0.4, rate: 0.5 });
      noise(r, t + 0.6, { level: -32, attack: 1.2, decay: 3, freq: 900, to: 400, q: 0.6, wet: 0.5 });
      return;
    case 'heliUp':
    case 'heliDown':
      rotor(r, t, sound === 'heliUp');
      return;
  }
}

/** A helicopter's blades, spinning up (or winding down): noise chopped by a falling or rising pulse. */
function rotor(r: Rig, t: number, up: boolean) {
  const ctx = r.ctx;
  const len = up ? 4.5 : 3;
  const src = ctx.createBufferSource();
  src.buffer = r.noise;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = 260;
  f.Q.value = 0.9;
  const chop = ctx.createGain();
  chop.gain.value = 0.5;
  const lfo = ctx.createOscillator();
  lfo.frequency.setValueAtTime(up ? 5 : 12, t);
  lfo.frequency.linearRampToValueAtTime(up ? 12 : 4, t + len * 0.7);
  const depth = ctx.createGain();
  depth.gain.value = 0.5;
  lfo.connect(depth).connect(chop.gain);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(db(-24), t + (up ? 1.2 : 0.2));
  env.gain.setValueAtTime(db(-24), t + len * 0.5);
  env.gain.linearRampToValueAtTime(0, t + len);
  const send = ctx.createGain();
  send.gain.value = 0.3;
  src.connect(f).connect(chop).connect(env);
  env.connect(r.dry);
  env.connect(send).connect(r.wet);
  src.start(t);
  lfo.start(t);
  retire(t + len + 0.05, [src, lfo], [f, chop, depth, env, send]);
}

/** One firework bursting far off over the bay: a soft boom, then a crackle. `k` 0–1 scales it. */
export function firework(r: Rig, t: number, k = 1) {
  const pan = (Math.random() - 0.5) * 0.8;
  thump(r, t, 90 + Math.random() * 30, 38, -22 + 4 * (k - 1), 0.5, 0.5);
  noise(r, t, { level: -27 + 4 * (k - 1), attack: 0.003, decay: 0.35, type: 'lowpass', freq: 700, q: 0.4, wet: 0.5, pan });
  noise(r, t + 0.12 + Math.random() * 0.1, { level: -26 + 4 * (k - 1), attack: 0.02, decay: 1.1, type: 'highpass', freq: 1800, q: 0.5, wet: 0.45, buffer: r.crackle, rate: 0.85 + Math.random() * 0.3, pan });
}

/** UI: a tiny tick for a button, and a breath of air for a dialog. Both sit at the edge of hearing. */
export function tick(r: Rig, t: number) {
  noise(r, t, { level: -37, attack: 0.0005, decay: 0.012, freq: 3800, q: 1.6 });
  bell(r, t, 1760, { level: -43, decay: 0.05, ratio: 1, index: 0.2, wet: 0 });
}

export function whoosh(r: Rig, t: number) {
  noise(r, t, { level: -39, attack: 0.09, decay: 0.22, freq: 500, to: 1700, q: 0.9, wet: 0.2 });
}

/** The sound switching on: two soft notes, so you know it works. */
export function hello(r: Rig, t: number) {
  bell(r, t, pentatonic(5), { level: -28, decay: 1.2, ratio: 3.5, index: 0.5, wet: 0.4 });
  bell(r, t + 0.12, pentatonic(8), { level: -28, decay: 1.6, ratio: 3.5, index: 0.5, wet: 0.45 });
}

// ── Buffers ──────────────────────────────────────────────────────────────

/** Stereo white noise; each channel independent so filtered beds sound wide. */
export function whiteNoise(ctx: BaseAudioContext, seconds = 3): AudioBuffer {
  const b = ctx.createBuffer(2, Math.round(ctx.sampleRate * seconds), ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return b;
}

/**
 * Stereo pink-ish noise (Paul Kellet's economy filter) or brown noise, with
 * the loop seam crossfaded so a looping bed never clicks.
 */
export function colouredNoise(ctx: BaseAudioContext, kind: 'pink' | 'brown', seconds = 4): AudioBuffer {
  const n = Math.round(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let b0 = 0, b1 = 0, b2 = 0, last = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'pink') {
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.18;
      } else {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.2;
      }
    }
    // Crossfade the last 50 ms into the first, so the loop point is seamless.
    const fade = Math.round(ctx.sampleRate * 0.05);
    for (let i = 0; i < fade; i++) {
      const k = i / fade;
      d[n - fade + i] = d[n - fade + i]! * (1 - k) + d[i]! * k;
    }
  }
  return b;
}

/** Fireworks crackle: sparse clicks, thick at first and thinning out, each a few samples long. */
export function crackleBuffer(ctx: BaseAudioContext, seconds = 1.6): AudioBuffer {
  const n = Math.round(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let i = 0;
    while (i < n) {
      const age = i / n;
      // Gaps grow from ~4 ms to ~60 ms as the sparks burn out.
      i += Math.round(ctx.sampleRate * (0.004 + age * age * 0.06) * (0.3 + Math.random() * 1.4));
      const amp = (1 - age * 0.7) * (0.4 + Math.random() * 0.6);
      const len = 6 + Math.floor(Math.random() * 30);
      for (let j = 0; j < len && i + j < n; j++) d[i + j] = amp * (Math.random() * 2 - 1) * (1 - j / len);
    }
  }
  return b;
}

/**
 * A soft hall: two seconds of decaying stereo noise that darkens as it fades,
 * like a sound carrying across water. One convolver shared by everything.
 */
export function impulse(ctx: BaseAudioContext, seconds = 2.4): AudioBuffer {
  const n = Math.round(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const k = i / n;
      // A one-pole low-pass whose cutoff falls over the tail: the highs die first.
      const a = 0.65 - 0.6 * k;
      lp += a * (Math.random() * 2 - 1 - lp);
      const pre = i < ctx.sampleRate * 0.012 ? 0 : 1; // a short pre-delay keeps the dry note clear
      d[i] = lp * pre * Math.exp(-k * 5.5) * 0.9;
    }
  }
  return b;
}
