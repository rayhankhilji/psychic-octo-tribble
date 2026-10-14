/**
 * Share: a postcard of today, or a growth clip. The clip is 15 seconds of
 * the founder's own replay, day one to today, filmed from the city with a
 * slow camera move and a branded overlay (their real MRR ticking, the date,
 * the customers, the MRR line, then an end card), as an MP4 for X, LinkedIn
 * and Stories.
 *
 * It's filmed frame by frame, not in real time: the live render loop
 * pauses, each frame steps the replay and the city by exactly 1/30 s, is
 * drawn and handed to the video encoder with its own timestamp. A slow
 * laptop takes longer to make the clip, never a choppier one. Afterwards
 * the day, the playing state, the camera, the canvas size and the HUD are
 * put back exactly.
 */
import './recap.css';
import * as THREE from 'three';
import type { City } from '../render/city.ts';
import type { Stage } from '../render/stage.ts';
import type { Snapshot } from '../data/types.ts';
import { el, escape, reducedMotion, returnFocusOnClose, showModal } from './dom.ts';
import { ICON } from './icons.ts';
import { nightTheme } from './postcard.ts';
import { ClipCard, loadClipFonts, type ClipFacts } from './recap-card.ts';
import { CLIP_FORMATS, CLIP_FPS, CLIP_SECONDS, cameraBasis, clipCamera, clipSchedule, fitView, type ClipFormat, type ClipShape } from './recap-plan.ts';
import { containerFor, muxMp4, muxWebm, type EncodedSample, type TrackColour } from './mux.ts';

/** What the clip needs from the app. */
export interface ClipHost {
  stage: Stage;
  city: City;
  name: string;
  demo: boolean;
  currency: string;
  snapshots: Snapshot[];
  /** The timeline index on screen now. */
  today: number;
  /** Pauses the replay and hands over the city. The function it returns puts the day, the playing state and the HUD back. */
  hold(): () => void;
  /** Shows timeline day `i` in the city alone (no HUD, no feed). `animate`: arrive as a replay step, with pop-ins and celebrations. */
  showDay(i: number, animate: boolean): void;
}

export interface ShareSheetOptions {
  /** The frame on screen, for the thumbnails. */
  frame: HTMLCanvasElement;
  /** Opens the postcard dialog. */
  postcard(): void;
  clip: ClipHost;
  /** Which choice starts selected. */
  pick?: 'postcard' | 'clip';
  /** Clip length in seconds (15; shorter for quick tests). */
  seconds?: number;
  /** File name for the clip, without the extension. */
  file: string;
}

interface Clip {
  blob: Blob;
  url: string;
  ext: 'mp4' | 'webm';
  mime: string;
  format: ClipFormat;
  seconds: number;
}

const params = new URLSearchParams(location.search);

// ─── The share sheet ─────────────────────────────────────────────────────

let open: HTMLDialogElement | null = null;

/** Opens the share sheet: postcard or growth clip. */
export function openShareSheet(o: ShareSheetOptions) {
  if (open?.open) return;
  open?.remove();
  const seconds = Math.max(2, Math.min(60, o.seconds ?? CLIP_SECONDS));
  const host = o.clip;
  const dialog = el('dialog', { class: 'dialog recap-dialog', 'aria-labelledby': 'recap-title', tabindex: '-1' });
  open = dialog;
  let pick: 'postcard' | 'clip' = o.pick ?? 'postcard';
  let shape: ClipShape = 'square';
  let metrics = true;
  let clip: Clip | null = null;
  let recording: { cancel: boolean } | null = null;
  const who = host.demo ? `${host.name}, a demo startup,` : host.name;
  const length = `0:${String(Math.round(seconds)).padStart(2, '0')}`;
  const thumb = thumbnail(o.frame);

  const setState = (state: 'pick' | 'record' | 'done' | 'error') => {
    dialog.dataset.state = state;
  };

  const renderPick = (error?: string) => {
    setState(error ? 'error' : 'pick');
    dialog.innerHTML = `
      <div class="dialog-body">
        <header class="dialog-head">
          <span class="tile tone-brand">${ICON.share}</span>
          <div><h2 id="recap-title">Share your city</h2><p>${error ? `<span class="recap-error">${escape(error)}</span> Your city is just as you left it.` : `A postcard of today, or ${escape(who)} growing from day 1 to today in ${Math.round(seconds)} seconds.`}</p></div>
          <button class="btn ghost icon-only close" data-act="close" aria-label="Close">${ICON.close}</button>
        </header>
        <div class="recap-pick" role="radiogroup" aria-label="What to share">
          <button type="button" class="recap-choice" role="radio" data-kind="postcard">
            <span class="recap-thumb"><img alt="" src="${thumb}"></span>
            <span class="recap-choice-text"><b>Postcard</b><small>Your city today, as a picture</small></span>
            <span class="recap-tag">PNG</span>
          </button>
          <button type="button" class="recap-choice" role="radio" data-kind="clip">
            <span class="recap-thumb"><img alt="" data-clip-thumb src="${thumb}"><span class="recap-badge">${ICON.play}<span class="num">${length}</span></span></span>
            <span class="recap-choice-text"><b>Growth clip</b><small>Day 1 to today, as a video</small></span>
            <span class="recap-tag">Video</span>
          </button>
        </div>
        <div class="recap-options" data-clip-only>
          <fieldset class="recap-shapes">
            <legend class="eyebrow">Shape</legend>
            ${(['square', 'vertical'] as const)
              .map((id) => {
                const f = CLIP_FORMATS[id];
                return `<label class="recap-shape"><input type="radio" name="shape" value="${id}"${id === shape ? ' checked' : ''}><i class="recap-aspect ${id}" aria-hidden="true"></i><span><b>${f.label}</b><small>${f.hint}</small></span></label>`;
              })
              .join('')}
          </fieldset>
          <label class="switch"><input type="checkbox" name="metrics" role="switch"${metrics ? ' checked' : ''}><span class="switch-track"><i></i></span><span><b>Show real numbers</b><small>MRR, customers and the MRR line. Off: just the days.</small></span></label>
        </div>
        <div class="dialog-actions">
          <span class="recap-note" data-clip-only>${ICON.info}<span>It takes a little while to film. Your city is put back exactly as it was.</span></span>
          <button class="btn ghost" data-act="close">Cancel</button>
          <button class="btn primary" data-act="go"></button>
        </div>
      </div>`;
    const go = dialog.querySelector<HTMLButtonElement>('[data-act=go]')!;
    const choices = [...dialog.querySelectorAll<HTMLButtonElement>('.recap-choice')];
    const sync = () => {
      for (const c of choices) {
        const on = c.dataset.kind === pick;
        c.setAttribute('aria-checked', String(on));
        c.tabIndex = on ? 0 : -1;
      }
      for (const e of dialog.querySelectorAll<HTMLElement>('[data-clip-only]')) e.hidden = pick !== 'clip';
      go.innerHTML = pick === 'clip' ? `${ICON.play}<span>Record clip</span>` : `${ICON.share}<span>Open postcard</span>`;
    };
    for (const c of choices) {
      c.addEventListener('click', () => {
        pick = c.dataset.kind as typeof pick;
        sync();
      });
      // Arrow keys move between the two choices, like any radio group.
      c.addEventListener('keydown', (e) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        e.preventDefault();
        pick = pick === 'clip' ? 'postcard' : 'clip';
        sync();
        choices.find((x) => x.dataset.kind === pick)?.focus();
      });
    }
    for (const r of dialog.querySelectorAll<HTMLInputElement>('input[name=shape]')) r.addEventListener('change', () => (shape = r.value as ClipShape));
    const refreshThumb = () =>
      void clipThumbnail(o.frame, host, metrics).then((src) => {
        const img = dialog.querySelector<HTMLImageElement>('[data-clip-thumb]');
        if (img && src) img.src = src;
      });
    dialog.querySelector<HTMLInputElement>('input[name=metrics]')!.addEventListener('change', (e) => {
      metrics = (e.target as HTMLInputElement).checked;
      refreshThumb();
    });
    for (const b of dialog.querySelectorAll('[data-act=close]')) b.addEventListener('click', () => dialog.close());
    go.addEventListener('click', () => {
      if (pick === 'postcard') {
        dialog.close();
        o.postcard();
      } else void record();
    });
    sync();
    // The clip's thumbnail: today's frame with the overlay it will carry.
    refreshThumb();
  };

  const record = async () => {
    const format = CLIP_FORMATS[shape];
    const run = { cancel: false };
    recording = run;
    const fullSeconds = Math.round(seconds);
    setState('record');
    dialog.innerHTML = `
      <div class="dialog-body">
        <header class="dialog-head">
          <span class="tile tone-brand">${ICON.play}</span>
          <div><h2 id="recap-title">Recording your clip</h2><p>${escape(host.demo ? `${host.name}, a demo startup` : host.name)}, day 1 to day ${(host.snapshots.length).toLocaleString('en-US')}.</p></div>
        </header>
        <div class="recap-live ${format.id}"><canvas width="${format.width / 4}" height="${format.height / 4}" aria-hidden="true"></canvas></div>
        <div class="recap-progress" role="progressbar" aria-label="Recording progress" aria-valuemin="0" aria-valuemax="${fullSeconds}" aria-valuenow="0"><i></i></div>
        <div class="recap-status">
          <p aria-live="polite"><b>Recording your clip…</b> <span class="num" data-at>0 s</span> <span class="recap-of">of ${fullSeconds} s</span></p>
          <button class="btn ghost" data-act="cancel">Cancel</button>
        </div>
      </div>`;
    const live = dialog.querySelector('canvas')!;
    const lctx = live.getContext('2d')!;
    const bar = dialog.querySelector<HTMLElement>('.recap-progress')!;
    const at = dialog.querySelector<HTMLElement>('[data-at]')!;
    dialog.querySelector('[data-act=cancel]')!.addEventListener('click', () => (run.cancel = true));
    dialog.querySelector<HTMLButtonElement>('[data-act=cancel]')!.focus();
    let lastSecond = -1;
    try {
      const facts: ClipFacts = { name: host.name, demo: host.demo, currency: host.currency, snapshots: host.snapshots, metrics, site: location.host, night: nightTheme() };
      const made = await recordClip(host, format, facts, seconds, {
        cancelled: () => run.cancel,
        progress: (f, frames, canvas) => {
          bar.style.setProperty('--p', String(f / frames));
          const s = Math.floor((f / frames) * seconds);
          if (s !== lastSecond) {
            lastSecond = s;
            at.textContent = `${s} s`;
            bar.setAttribute('aria-valuenow', String(s));
          }
          // A live look at the clip, every other frame (cheap: a downscaled copy).
          if (f % 2 === 0 || f === frames) lctx.drawImage(canvas, 0, 0, live.width, live.height);
        },
      });
      recording = null;
      if (!made) return renderPick();
      clip = made;
      renderDone(made);
    } catch (err) {
      recording = null;
      console.error(err);
      renderPick(`Couldn't record the clip (${err instanceof Error ? err.message.replace(/\.$/, '') : 'unknown error'}).`);
    }
  };

  const renderDone = (c: Clip) => {
    setState('done');
    const mb = (c.blob.size / 1e6).toFixed(c.blob.size < 1e7 ? 1 : 0);
    const name = `${o.file}.${c.ext}`;
    const file = new File([c.blob], name, { type: c.mime });
    const canShare = !!navigator.canShare?.({ files: [file] });
    dialog.innerHTML = `
      <div class="dialog-body">
        <header class="dialog-head">
          <span class="tile tone-brand">${ICON.play}</span>
          <div><h2 id="recap-title">Your growth clip</h2><p>${escape(who)} from day 1 to day ${host.snapshots.length.toLocaleString('en-US')}. Every number in it is real.</p></div>
          <button class="btn ghost icon-only close" data-act="close" aria-label="Close">${ICON.close}</button>
        </header>
        <div class="recap-player ${c.format.id}"><video src="${c.url}" ${reducedMotion() ? '' : 'autoplay'} muted loop playsinline controls aria-label="Your growth clip"></video></div>
        <div class="dialog-actions">
          <span class="recap-note"><span class="num">${c.ext.toUpperCase()} · ${c.format.width} × ${c.format.height} · ${Math.round(c.seconds)} s · ${mb} MB</span></span>
          <button class="btn ghost" data-act="again">${ICON.replay}<span>Record again</span></button>
          ${canShare ? `<button class="btn ghost" data-act="share">${ICON.share}<span>Share</span></button>` : ''}
          <button class="btn primary" data-act="download">${ICON.download}<span>Download ${c.ext.toUpperCase()}</span></button>
        </div>
      </div>`;
    dialog.querySelector('[data-act=close]')!.addEventListener('click', () => dialog.close());
    dialog.querySelector('[data-act=again]')!.addEventListener('click', () => {
      forget();
      pick = 'clip';
      renderPick();
    });
    dialog.querySelector('[data-act=download]')!.addEventListener('click', () => {
      const a = document.createElement('a');
      a.download = name;
      a.href = c.url;
      a.click();
    });
    dialog.querySelector('[data-act=share]')?.addEventListener('click', () => {
      const text = host.demo
        ? `${host.name}, a demo startup, growing in TinyTown. Every customer is a resident.`
        : `${host.name}, from day 1 to today in TinyTown. Every customer is a resident.`;
      void navigator.share({ files: [file], title: `${host.name} on TinyTown`, text: `${text} ${location.origin}` }).catch(() => {
        // Dismissed, or the target refused the file: the download is still there.
      });
    });
    dialog.querySelector<HTMLButtonElement>('[data-act=download]')!.focus({ preventScroll: true });
  };

  const forget = () => {
    if (clip) URL.revokeObjectURL(clip.url);
    clip = null;
  };

  // Esc while recording cancels the recording (and the city comes back); otherwise it closes.
  dialog.addEventListener('cancel', (e) => {
    if (!recording) return;
    e.preventDefault();
    recording.cancel = true;
  });
  dialog.addEventListener('click', (e) => e.target === dialog && !recording && dialog.close());
  returnFocusOnClose(dialog, () => {
    forget();
    setState('pick');
    setTimeout(() => dialog.remove(), 400);
    if (open === dialog) open = null;
  });
  document.body.append(dialog);
  renderPick();
  showModal(dialog);
  dialog.querySelector<HTMLButtonElement>(`.recap-choice[data-kind=${pick}]`)?.focus({ preventScroll: true });
}

/** A small JPEG of the frame on screen, cropped to the thumbnails' 16:10. */
function thumbnail(frame: HTMLCanvasElement, w = 520): string {
  const h = Math.round(w / 1.6);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  cover(c.getContext('2d')!, frame, w, h);
  return c.toDataURL('image/jpeg', 0.86);
}

/** Today's frame with the clip's overlay on it, so the choice shows what you'll get. */
async function clipThumbnail(frame: HTMLCanvasElement, host: ClipHost, metrics: boolean): Promise<string | null> {
  await loadClipFonts();
  const format = CLIP_FORMATS.square;
  const c = document.createElement('canvas');
  c.width = format.width;
  c.height = Math.round(format.width / 1.6);
  const ctx = c.getContext('2d')!;
  cover(ctx, frame, c.width, c.height);
  const card = new ClipCard({ name: host.name, demo: host.demo, currency: host.currency, snapshots: host.snapshots, metrics, site: location.host, night: nightTheme() }, { ...format, height: c.height });
  card.draw(ctx, 0, { fps: 30, frames: 2, day: [host.today, host.today], start: 0, arrive: 0, endCard: 2 }, host.today);
  const out = document.createElement('canvas');
  out.width = 520;
  out.height = Math.round(520 / 1.6);
  out.getContext('2d')!.drawImage(c, 0, 0, out.width, out.height);
  return out.toDataURL('image/jpeg', 0.86);
}

/** Draws `src` to fill a w×h canvas, cropping the middle (like CSS object-fit: cover). */
function cover(ctx: CanvasRenderingContext2D, src: CanvasImageSource & { width: number; height: number }, w: number, h: number) {
  const k = Math.max(w / src.width, h / src.height);
  const sw = w / k;
  const sh = h / k;
  ctx.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, w, h);
}

// ─── Filming ─────────────────────────────────────────────────────────────

interface RecordUi {
  cancelled(): boolean;
  /** `f` frames of `frames` done; `canvas` is the latest frame of the clip. */
  progress(f: number, frames: number, canvas: HTMLCanvasElement): void;
}

const yieldToBrowser = () => new Promise<void>((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolves after the browser has drawn `n` more frames (with a timeout, for hidden tabs). */
function frames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 200 * n + 400);
    const step = () => (n-- <= 0 ? (clearTimeout(timer), resolve()) : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
}

/**
 * Films the clip. Pauses the app's render loop, sizes the stage to the
 * clip, then for each frame: steps the replay to that frame's day, moves
 * the camera, advances the city by exactly one frame, renders, paints the
 * overlay and hands the frame to the encoder. Returns null if cancelled.
 * Everything is put back whatever happens.
 */
async function recordClip(host: ClipHost, format: ClipFormat, facts: ClipFacts, seconds: number, ui: RecordUi): Promise<Clip | null> {
  const { stage, city } = host;
  const { width: W, height: H } = format;
  const fps = CLIP_FPS;
  const schedule = clipSchedule(host.snapshots.length, seconds, fps);
  const card = new ClipCard(facts, format);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false })!;
  await loadClipFonts();
  const encoder = await openEncoder(canvas, W, H, fps);

  const camera = stage.camera;
  const controls = stage.controls;
  const saved = { position: camera.position.clone(), target: controls.target.clone(), zoom: camera.zoom, up: camera.up.clone() };
  const distance = camera.position.distanceTo(controls.target);
  const world = stage.renderer.domElement.parentElement!;
  const style = world.getAttribute('style');
  const root = document.documentElement;
  const release = host.hold();
  root.classList.add('recording');
  try {
    // The stage at the clip's size: the canvas is W×H device pixels, so nothing is upscaled.
    const pr = stage.renderer.getPixelRatio();
    world.style.cssText = `${style ?? ''};inset:auto;left:0;top:0;width:${W / pr}px;height:${H / pr}px`;
    const sized = () => Math.abs(stage.renderer.domElement.width - W) <= 2 && Math.abs(stage.renderer.domElement.height - H) <= 2;
    for (let i = 0; i < 30 && !sized(); i++) await frames(1);

    // Day one, built whole, with the camera on its first mark.
    host.showDay(schedule.day[0]!, false);
    city.finishBuilding();
    const rig = new Rig(stage, city, format, schedule, distance);
    rig.place(0, 1 / fps, true);
    // Two frames of the live loop set the look (tilt-shift, bloom, exposure) for this view; then the loop pauses.
    await frames(2);
    if (ui.cancelled()) return null;
    stage.renderer.setAnimationLoop(null);

    const dt = 1 / fps;
    let time = performance.now() / 1000;
    // A second of settling on day one: fog, traffic and boats find their places.
    for (let i = 0; i < fps; i++) {
      rig.place(0, dt, true);
      city.update(dt, (time += dt));
    }

    let shown = schedule.day[0]!;
    const t0 = performance.now();
    for (let f = 0, prev = -1; f < schedule.frames; ) {
      if (ui.cancelled()) {
        encoder.close();
        return null;
      }
      const day = schedule.day[f]!;
      if (day !== shown) {
        host.showDay(day, true);
        shown = day;
      }
      // Every frame complete, whatever the device's speed (the live city spreads building over frames).
      city.finishBuilding();
      // Frame by frame, one step; in real time (the fallback), however many frames the clock says have passed.
      for (let k = prev < 0 ? 1 : f - prev; k > 0; k--) {
        rig.place(f, dt, false);
        city.update(dt, (time += dt));
      }
      stage.renderer.toneMappingExposure = city.atmosphere.exposure;
      const frame = stage.capture();
      cover(ctx, frame, W, H);
      card.draw(ctx, f, schedule, day);
      await encoder.add(f);
      ui.progress(f + 1, schedule.frames, canvas);
      await yieldToBrowser();
      prev = f;
      f = encoder.realtime ? Math.max(f + 1, Math.floor(((performance.now() - t0) / 1000) * fps)) : f + 1;
    }
    // Real time: keep showing the last frame until the clip's full length has passed (and at least a beat).
    if (encoder.realtime) {
      do {
        await encoder.add(schedule.frames - 1);
        await sleep(1000 / fps);
      } while (performance.now() - t0 < (schedule.frames / fps) * 1000);
    }
    const made = await encoder.finish();
    return { ...made, url: URL.createObjectURL(made.blob), format, seconds: schedule.frames / fps };
  } finally {
    encoder.close();
    if (style === null) world.removeAttribute('style');
    else world.setAttribute('style', style);
    release();
    city.finishBuilding();
    // The render loop again (start() reframes the camera, so the saved view goes back after it).
    stage.start();
    camera.up.copy(saved.up);
    camera.position.copy(saved.position);
    controls.target.copy(saved.target);
    camera.lookAt(saved.target);
    camera.zoom = saved.zoom;
    camera.updateProjectionMatrix();
    root.classList.remove('recording');
  }
}

/**
 * The camera during the clip: a slow swing round to the classic iso angle
 * while it pulls back from HQ to the whole city as the city grows. Framing
 * follows the city's own box (it grows as land opens), eased so a block
 * opening never jolts the shot.
 */
class Rig {
  private x = 0;
  private z = 0;
  private zoom = 1;
  private target = new THREE.Vector3();
  private readonly stage: Stage;
  private readonly city: City;
  private readonly format: ClipFormat;
  private readonly schedule: ReturnType<typeof clipSchedule>;
  private readonly distance: number;

  constructor(stage: Stage, city: City, format: ClipFormat, schedule: ReturnType<typeof clipSchedule>, distance: number) {
    this.stage = stage;
    this.city = city;
    this.format = format;
    this.schedule = schedule;
    this.distance = distance;
  }

  place(f: number, dt: number, snap: boolean) {
    const camera = this.stage.camera;
    const view = camera.top - camera.bottom;
    const aspect = (camera.right - camera.left) / view;
    const move = clipCamera(f, this.schedule);
    const az = Math.PI / 4 + move.turn;
    const fmt = this.format;
    const whole = fitView(this.city.framing, az, aspect, view, fmt.inset, fmt.fill);
    const zoom = whole.zoom * move.push;
    // HQ, framed in the band the overlay leaves free, at this zoom.
    const hq = fitView({ x0: -3, x1: 3, z0: -3, z1: 3 }, az, aspect, view, fmt.inset, fmt.fill, zoom);
    const tx = hq.x + (whole.x - hq.x) * move.focus;
    const tz = hq.z + (whole.z - hq.z) * move.focus;
    const k = snap ? 1 : 1 - Math.exp(-dt * 3);
    this.x += (tx - this.x) * k;
    this.z += (tz - this.z) * k;
    this.zoom += (zoom - this.zoom) * k;

    const { forward } = cameraBasis(az);
    this.target.set(this.x, 0, this.z);
    camera.up.set(0, 1, 0);
    camera.position.set(this.x - forward[0] * this.distance, -forward[1] * this.distance, this.z - forward[2] * this.distance);
    camera.lookAt(this.target);
    camera.zoom = this.zoom;
    camera.updateProjectionMatrix();
    this.stage.controls.target.copy(this.target);
    // Shadows and rain follow what's on screen, as in the live loop.
    this.city.setView(this.target, Math.hypot(view * aspect, view * 1.75) / this.zoom / 2, this.distance, camera);
  }
}

// ─── Encoding ────────────────────────────────────────────────────────────

interface ClipEncoder {
  /**
   * Frames are stamped with the wall clock (MediaRecorder), so the clip is
   * filmed in real time, dropping frames on a slow device; otherwise every
   * frame carries its own timestamp and the clip is filmed frame by frame.
   */
  realtime: boolean;
  /** Frame `f` is on the canvas: encode it. */
  add(f: number): Promise<void>;
  finish(): Promise<{ blob: Blob; ext: 'mp4' | 'webm'; mime: string }>;
  close(): void;
}

/** Bits per second: enough for a busy little city with fine detail. */
function bitrateFor(w: number, h: number): number {
  return Math.round(w * h * 7.5);
}

/** WebCodecs where it's there (exact timestamps), else MediaRecorder. `?recapvia=mediarecorder` forces the fallback. */
async function openEncoder(canvas: HTMLCanvasElement, w: number, h: number, fps: number): Promise<ClipEncoder> {
  if (params.get('recapvia') !== 'mediarecorder' && 'VideoEncoder' in window) {
    const wc = await webCodecsEncoder(canvas, w, h, fps);
    if (wc) return wc;
  }
  const mr = mediaRecorderEncoder(canvas, w, h);
  if (mr) return mr;
  throw new Error("this browser can't make videos");
}

/**
 * H.264 in MP4 first (X, Instagram, iMessage and LinkedIn all take it),
 * then VP9 or VP8 in WebM for browsers without an H.264 encoder.
 */
const CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'vp09.00.40.08', 'vp8'];

async function webCodecsEncoder(canvas: HTMLCanvasElement, w: number, h: number, fps: number): Promise<ClipEncoder | null> {
  let config: VideoEncoderConfig | null = null;
  for (const codec of CODECS) {
    if (params.get('recapcodec') && !codec.startsWith(params.get('recapcodec')!)) continue;
    const c: VideoEncoderConfig = { codec, width: w, height: h, bitrate: bitrateFor(w, h), framerate: fps, latencyMode: 'quality', ...(codec.startsWith('avc') ? { avc: { format: 'avc' } } : {}) };
    const support = await VideoEncoder.isConfigSupported(c).catch(() => null);
    if (support?.supported) {
      config = c;
      break;
    }
  }
  if (!config) return null;
  const frameUs = 1e6 / fps;
  const samples: EncodedSample[] = [];
  let description: Uint8Array | undefined;
  let colour: TrackColour | undefined;
  let failure: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ data, time: chunk.timestamp, duration: chunk.duration ?? frameUs, key: chunk.type === 'key' });
      const dc = meta?.decoderConfig;
      if (dc?.description && !description) description = bytesOf(dc.description);
      if (dc?.colorSpace && !colour) colour = { primaries: dc.colorSpace.primaries, transfer: dc.colorSpace.transfer, matrix: dc.colorSpace.matrix, fullRange: dc.colorSpace.fullRange };
    },
    error: (e) => (failure = e),
  });
  encoder.configure(config);
  const codec = config.codec;
  return {
    realtime: false,
    async add(f) {
      if (failure) throw failure;
      const frame = new VideoFrame(canvas, { timestamp: Math.round(f * frameUs), duration: Math.round(frameUs) });
      // A keyframe every two seconds, so the clip seeks and trims cleanly.
      encoder.encode(frame, { keyFrame: f % (fps * 2) === 0 });
      frame.close();
      while (encoder.encodeQueueSize > 4) await sleep(4);
    },
    async finish() {
      await encoder.flush();
      if (failure) throw failure;
      encoder.close();
      const track = { codec, width: w, height: h, fps, ...(description ? { description } : {}), ...(colour ? { colour } : {}) };
      const { ext, mime } = containerFor(codec);
      const bytes = ext === 'mp4' ? muxMp4(track, samples) : muxWebm(track, samples);
      return { blob: new Blob([bytes.buffer as ArrayBuffer], { type: mime }), ext, mime };
    },
    close() {
      if (encoder.state !== 'closed') encoder.close();
    },
  };
}

function bytesOf(src: AllowSharedBufferSource): Uint8Array {
  if (ArrayBuffer.isView(src)) return new Uint8Array(src.buffer, src.byteOffset, src.byteLength).slice();
  return new Uint8Array(src).slice();
}

/**
 * The fallback, for browsers without WebCodecs: MediaRecorder on the
 * canvas. It stamps frames with the wall clock (and pausing it doesn't take
 * the paused time out), so this films in real time: a slow device drops
 * frames rather than slowing the clip down.
 */
function mediaRecorderEncoder(canvas: HTMLCanvasElement, w: number, h: number): ClipEncoder | null {
  if (typeof MediaRecorder === 'undefined' || !canvas.captureStream) return null;
  const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  // Safari records MP4 well; elsewhere WebM is the native format.
  const safari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  const order = safari ? types : [...types.slice(2), ...types.slice(0, 2)];
  const mimeType = order.find((t) => MediaRecorder.isTypeSupported(t));
  if (!mimeType) return null;
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrateFor(w, h) });
  const parts: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && parts.push(e.data);
  const stop = () => stream.getTracks().forEach((t) => t.stop());
  return {
    realtime: true,
    async add() {
      if (recorder.state === 'inactive') {
        recorder.start();
        // A frame asked for before the recorder is running is lost.
        await sleep(100);
      }
      track.requestFrame();
    },
    async finish() {
      const stopped = new Promise((r) => (recorder.onstop = r));
      // The last frame needs a moment on screen, or it has no length.
      await sleep(100);
      recorder.stop();
      await stopped;
      stop();
      const mime = mimeType.split(';')[0]!;
      const blob = new Blob(parts, { type: mime });
      // A recorder starved of frames (a very slow machine) hands back a header and nothing else.
      if (blob.size < 4096) throw new Error('the browser’s recorder came back empty');
      return { blob, ext: mime === 'video/mp4' ? 'mp4' : 'webm', mime };
    },
    close() {
      if (recorder.state !== 'inactive') recorder.stop();
      stop();
    },
  };
}
