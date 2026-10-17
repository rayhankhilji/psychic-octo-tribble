import { drawMark } from './brand.ts';

/**
 * The share image: a postcard of the city framed on warm sand by day, or on
 * deep bay ink by night, with the mark, the city's name, the day and a few
 * numbers. Every number on it is the real one the founder chose to share.
 */

export interface PostcardInfo {
  /** The city's name, in the caption. */
  name: string;
  /** Under the name, e.g. "Day 540 · October 12, 2026". */
  caption: string;
  /** Up to three stat cards, left to right: label, value, and whether the value takes the accent. */
  stats: [label: string, value: string, accent?: boolean][];
}

interface Palette {
  paper: [string, string];
  frame: string;
  ink: string;
  ink3: string;
  accent: string;
  placeholder: string;
  stamp: string;
  card: string;
  cardLine: string;
  shadow: string;
  pictureShadow: string;
  pictureLine: string;
  vignette: string;
}

const DAY: Palette = {
  paper: ['#fbf5ea', '#f1e6d2'],
  frame: 'rgba(27,34,54,0.10)',
  ink: '#1b2236',
  ink3: '#62667a',
  accent: '#e5512b',
  placeholder: '#cfe4f4',
  stamp: 'rgba(253,249,242,0.96)',
  card: 'rgba(253,249,242,0.9)',
  cardLine: 'rgba(27,34,54,0.10)',
  shadow: 'rgba(27,34,54,0.22)',
  pictureShadow: 'rgba(27,34,54,0.28)',
  pictureLine: 'rgba(27,34,54,0.12)',
  vignette: 'rgba(27,34,54,0.16)',
};

/** Night: the same postcard printed on the bay after dark, so a night city isn't framed in daylight. */
const NIGHT: Palette = {
  paper: ['#1a2236', '#0f1424'],
  frame: 'rgba(245,236,219,0.12)',
  ink: '#f6eedf',
  ink3: '#a3a1b0',
  accent: '#ff7a50',
  placeholder: '#1d2439',
  stamp: 'rgba(22,28,47,0.94)',
  card: 'rgba(29,36,57,0.92)',
  cardLine: 'rgba(245,236,219,0.10)',
  shadow: 'rgba(0,0,0,0.45)',
  pictureShadow: 'rgba(0,0,0,0.55)',
  pictureLine: 'rgba(245,236,219,0.14)',
  vignette: 'rgba(5,8,20,0.28)',
};

/** Whether the UI is in its night theme right now (it follows the world's clock). */
export function nightTheme(): boolean {
  return document.documentElement.dataset.theme === 'night';
}

/** Composes the postcard around a captured frame of the city. `night` defaults to the UI's current theme. */
export function composePostcard(src: HTMLCanvasElement, info: PostcardInfo, night = nightTheme()): HTMLCanvasElement {
  const p = night ? NIGHT : DAY;
  // Never upscale a small (phone) capture much: blur reads worse than a smaller card.
  const OW = Math.round(Math.min(1600, Math.max(960, src.width * 1.12)));
  const K = OW / 1600;
  const pad = 44 * K;
  const band = 168 * K;
  // Keep the picture between portrait 4:5 and wide 2:1, cropping the middle.
  const aspect = Math.min(2, Math.max(0.8, src.width / src.height));
  const iw = OW - pad * 2;
  const ih = Math.round(iw / aspect);
  const OH = Math.round(pad + ih + band);
  const out = document.createElement('canvas');
  out.width = OW;
  out.height = OH;
  const ctx = out.getContext('2d')!;
  const display = '"Bricolage Grotesque", Geist, system-ui, sans-serif';
  const ui = 'Geist, system-ui, sans-serif';

  // Paper
  const paper = ctx.createLinearGradient(0, 0, 0, OH);
  paper.addColorStop(0, p.paper[0]);
  paper.addColorStop(1, p.paper[1]);
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, OW, OH);
  ctx.strokeStyle = p.frame;
  ctx.lineWidth = 2 * K;
  ctx.strokeRect(16 * K, 16 * K, OW - 32 * K, OH - 32 * K);

  // The picture, cropped to the chosen aspect, with a soft shadow.
  let sw = src.width;
  let sh = src.height;
  if (sw / sh > aspect) sw = sh * aspect;
  else sh = sw / aspect;
  const r = 20 * K;
  ctx.save();
  ctx.shadowColor = p.pictureShadow;
  ctx.shadowBlur = 36 * K;
  ctx.shadowOffsetY = 14 * K;
  ctx.fillStyle = p.placeholder;
  ctx.beginPath();
  ctx.roundRect(pad, pad, iw, ih, r);
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(pad, pad, iw, ih, r);
  ctx.clip();
  ctx.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, pad, pad, iw, ih);
  // A whisper of vignette so the frame reads as a print.
  const vg = ctx.createRadialGradient(OW / 2, pad + ih / 2, ih * 0.45, OW / 2, pad + ih / 2, iw * 0.75);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, p.vignette);
  ctx.fillStyle = vg;
  ctx.fillRect(pad, pad, iw, ih);
  ctx.restore();
  ctx.strokeStyle = p.pictureLine;
  ctx.lineWidth = 1.5 * K;
  ctx.beginPath();
  ctx.roundRect(pad, pad, iw, ih, r);
  ctx.stroke();

  // Stamp: the mark and wordmark, pinned to the picture's corner.
  ctx.font = `800 ${30 * K}px ${display}`;
  const word = 'TinyTown';
  const ww = ctx.measureText(word).width;
  const sx = pad + 22 * K;
  const sy = pad + 22 * K;
  const sH = 60 * K;
  ctx.save();
  ctx.shadowColor = p.shadow;
  ctx.shadowBlur = 18 * K;
  ctx.shadowOffsetY = 6 * K;
  ctx.fillStyle = p.stamp;
  ctx.beginPath();
  ctx.roundRect(sx, sy, 16 * K + 40 * K + 12 * K + ww + 22 * K, sH, sH / 2);
  ctx.fill();
  ctx.restore();
  drawMark(ctx, sx + 12 * K, sy + 9 * K, 42 * K);
  ctx.fillStyle = p.ink;
  ctx.textBaseline = 'middle';
  ctx.fillText(word, sx + 16 * K + 40 * K + 10 * K, sy + sH / 2 + 1 * K);

  // Caption: city name and the day.
  const by = pad + ih;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = p.ink;
  ctx.font = `800 ${50 * K}px ${display}`;
  ctx.fillText(info.name, pad + 4 * K, by + 86 * K);
  ctx.font = `500 ${23 * K}px ${ui}`;
  ctx.fillStyle = p.ink3;
  ctx.fillText(info.caption, pad + 6 * K, by + 124 * K);

  // Stats on the right, as little cards.
  let x = OW - pad;
  const ch = 84 * K;
  const cy = by + 34 * K;
  for (const [label, value, accent] of [...info.stats].reverse()) {
    ctx.font = `750 ${30 * K}px ${display}`;
    const vw = ctx.measureText(value).width;
    ctx.font = `600 ${14 * K}px ${ui}`;
    const lw = ctx.measureText(label.toUpperCase()).width * 1.1;
    const cw = Math.max(vw, lw) + 40 * K;
    x -= cw;
    ctx.fillStyle = p.card;
    ctx.strokeStyle = p.cardLine;
    ctx.lineWidth = 1.5 * K;
    ctx.beginPath();
    ctx.roundRect(x, cy, cw, ch, 16 * K);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = p.ink3;
    ctx.font = `600 ${14 * K}px ${ui}`;
    ctx.letterSpacing = `${1.4 * K}px`;
    ctx.fillText(label.toUpperCase(), x + 20 * K, cy + 32 * K);
    ctx.letterSpacing = '0px';
    ctx.fillStyle = accent ? p.accent : p.ink;
    ctx.font = `750 ${30 * K}px ${display}`;
    ctx.fillText(value, x + 20 * K, cy + 66 * K);
    x -= 12 * K;
  }
  return out;
}
