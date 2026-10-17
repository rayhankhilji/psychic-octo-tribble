import { BRAND, drawMark } from './brand.ts';
import { formatMoney, type Snapshot } from '../data/types.ts';
import { endCardIn, sampleSeries, type ClipFormat, type ClipSchedule } from './recap-plan.ts';

/**
 * The growth clip's overlay, painted with Canvas2D over each frame of the
 * city: the TinyTown stamp in a corner, a lower card with the city's name,
 * its real MRR ticking up day by day, the date, the customer count and the
 * MRR line so far, and a two-second end card. Every number is the real one
 * for the day on screen; the demo is labelled as the demo.
 */

export interface ClipFacts {
  name: string;
  /** The demo world: labelled "a demo startup" wherever the name appears. */
  demo: boolean;
  currency: string;
  snapshots: Snapshot[];
  /** Show MRR, customers and users. Off: the days and dates only. */
  metrics: boolean;
  /** Where people can find TinyTown, e.g. "tinytown.app". */
  site: string;
  night: boolean;
}

interface Palette {
  card: string;
  cardLine: string;
  ink: string;
  ink2: string;
  ink3: string;
  accent: string;
  accentText: string;
  fill: string;
  rule: string;
  shadow: string;
  wash: string;
  stamp: string;
}

const DAY: Palette = {
  card: 'rgba(253,249,242,0.94)',
  cardLine: 'rgba(27,34,54,0.08)',
  ink: '#1b2236',
  ink2: '#4b5168',
  ink3: '#62667a',
  accent: '#e5512b',
  accentText: '#a83818',
  fill: 'rgba(229,81,43,0.16)',
  rule: 'rgba(27,34,54,0.12)',
  shadow: 'rgba(27,34,54,0.26)',
  wash: 'rgba(245,236,219,0.62)',
  stamp: 'rgba(253,249,242,0.95)',
};

const NIGHT: Palette = {
  card: 'rgba(22,28,47,0.93)',
  cardLine: 'rgba(245,236,219,0.1)',
  ink: '#f6eedf',
  ink2: '#c8c2b6',
  ink3: '#a3a1b0',
  accent: '#ff7a50',
  accentText: '#ff7a50',
  fill: 'rgba(255,122,80,0.2)',
  rule: 'rgba(245,236,219,0.14)',
  shadow: 'rgba(0,0,0,0.5)',
  wash: 'rgba(15,20,36,0.6)',
  stamp: 'rgba(22,28,47,0.94)',
};

const DISPLAY = '"Bricolage Grotesque", Geist, system-ui, sans-serif';
const UI = 'Geist, system-ui, sans-serif';
const MONO = '"Geist Mono", ui-monospace, Menlo, monospace';

/** The faces the overlay draws with, loaded before the first frame (or given up on after a few seconds). */
export async function loadClipFonts() {
  const faces = [`800 96px ${DISPLAY}`, `750 40px ${DISPLAY}`, `500 24px ${UI}`, `600 24px ${UI}`, `500 20px ${MONO}`];
  await Promise.race([Promise.all(faces.map((f) => document.fonts.load(f).catch(() => []))), new Promise((r) => setTimeout(r, 4000))]);
}

const dateOf = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const count = (n: number) => n.toLocaleString('en-US');

export class ClipCard {
  private p: Palette;
  private W: number;
  private H: number;
  /** Everything is laid out for 1080 wide and scaled by this. */
  private K: number;
  private vertical: boolean;
  private series: { i: number; v: number }[];
  private peak: number;
  private digit = new Map<string, number>();

  private readonly facts: ClipFacts;

  constructor(facts: ClipFacts, format: ClipFormat) {
    this.facts = facts;
    this.p = facts.night ? NIGHT : DAY;
    this.W = format.width;
    this.H = format.height;
    this.K = format.width / 1080;
    this.vertical = format.height > format.width;
    this.series = sampleSeries(facts.snapshots.map((s) => s.mrr));
    this.peak = Math.max(1, ...facts.snapshots.map((s) => s.mrr));
  }

  /** Paints the overlay for frame `f`, showing timeline day `i`. */
  draw(ctx: CanvasRenderingContext2D, f: number, s: ClipSchedule, i: number) {
    const end = endCardIn(f, s);
    ctx.save();
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    if (end < 1) {
      ctx.globalAlpha = 1 - end;
      this.stamp(ctx);
      this.lower(ctx, i);
      ctx.globalAlpha = 1;
    }
    if (end > 0) this.endCard(ctx, end);
    ctx.restore();
  }

  // ─── Pieces ─────────────────────────────────────────────────────────────

  private font(ctx: CanvasRenderingContext2D, font: string, display = false) {
    ctx.font = font;
    // Bricolage is set narrow (88% width) everywhere in the brand; canvases that can't, draw it at 100%.
    if ('fontStretch' in ctx) ctx.fontStretch = display ? 'semi-condensed' : 'normal';
    ctx.letterSpacing = '0px';
  }

  /** The mark and the wordmark on a pill, top-left (lower on vertical, clear of the Stories header). */
  private stamp(ctx: CanvasRenderingContext2D) {
    const { K, p } = this;
    const x = 44 * K;
    const y = (this.vertical ? 236 : 44) * K;
    const h = 64 * K;
    this.font(ctx, `800 ${31 * K}px ${DISPLAY}`, true);
    ctx.letterSpacing = `${-0.9 * K}px`;
    const ww = ctx.measureText('TinyTown').width;
    const w = 12 * K + 44 * K + 12 * K + ww + 24 * K;
    ctx.save();
    ctx.shadowColor = p.shadow;
    ctx.shadowBlur = 22 * K;
    ctx.shadowOffsetY = 6 * K;
    ctx.fillStyle = p.stamp;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, h / 2);
    ctx.fill();
    ctx.restore();
    drawMark(ctx, x + 12 * K, y + 9 * K, 44 * K);
    ctx.fillStyle = p.ink;
    ctx.textBaseline = 'middle';
    ctx.fillText('TinyTown', x + 12 * K + 44 * K + 12 * K, y + h / 2 + 1.5 * K);
    ctx.textBaseline = 'alphabetic';
    ctx.letterSpacing = '0px';
  }

  /**
   * Draws `text` with every digit in a cell as wide as the widest digit,
   * so a ticking number doesn't wobble (canvas has no tabular-nums).
   */
  private tabular(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): number {
    const key = ctx.font;
    let cell = this.digit.get(key);
    if (cell === undefined) {
      cell = Math.max(...'0123456789'.split('').map((d) => ctx.measureText(d).width));
      this.digit.set(key, cell);
    }
    const align = ctx.textAlign;
    let at = x;
    for (const ch of text) {
      if (ch >= '0' && ch <= '9') {
        ctx.textAlign = 'center';
        ctx.fillText(ch, at + cell / 2, y);
        at += cell;
      } else {
        ctx.textAlign = 'left';
        ctx.fillText(ch, at, y);
        at += ctx.measureText(ch).width;
      }
    }
    ctx.textAlign = align;
    return at - x;
  }

  private label(): string {
    return this.facts.demo ? `${this.facts.name} · a demo startup` : this.facts.name;
  }

  /** The lower card: who, the ticking MRR, the day, the customers, and the MRR line so far. */
  private lower(ctx: CanvasRenderingContext2D, i: number) {
    const { K, p, facts } = this;
    const snap = facts.snapshots[i]!;
    const v = this.vertical;
    const x = 44 * K;
    const w = this.W - 88 * K;
    const h = (v ? 480 : 232) * K;
    const y = this.H - (v ? 300 : 44) * K - h;
    const pad = 34 * K;

    ctx.save();
    ctx.shadowColor = p.shadow;
    ctx.shadowBlur = 40 * K;
    ctx.shadowOffsetY = 14 * K;
    ctx.fillStyle = p.card;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 30 * K);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = p.cardLine;
    ctx.lineWidth = 1.5 * K;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 30 * K);
    ctx.stroke();

    // Eyebrow: the city, in mono caps.
    this.font(ctx, `500 ${19 * K}px ${MONO}`);
    ctx.letterSpacing = `${1.9 * K}px`;
    ctx.fillStyle = p.ink3;
    ctx.fillText(this.label().toUpperCase(), x + pad, y + pad + 17 * K);
    ctx.letterSpacing = '0px';

    // The big number: MRR, or the day count when numbers are private.
    const day = i + 1;
    const bigY = y + pad + (v ? 136 : 112) * K;
    const bigSize = (v ? 124 : 96) * K;
    this.font(ctx, `800 ${bigSize}px ${DISPLAY}`, true);
    ctx.letterSpacing = `${-0.03 * bigSize}px`;
    ctx.fillStyle = p.ink;
    const big = facts.metrics ? formatMoney(snap.mrr, facts.currency) : `Day ${count(day)}`;
    const bw = this.tabular(ctx, big, x + pad - 2 * K, bigY);
    ctx.letterSpacing = '0px';
    if (facts.metrics) {
      this.font(ctx, `600 ${(v ? 32 : 27) * K}px ${UI}`);
      ctx.fillStyle = p.ink3;
      ctx.fillText('MRR', x + pad + bw + 14 * K, bigY);
    }

    // The day and the people.
    const lineY = bigY + (v ? 60 : 46) * K;
    this.font(ctx, `500 ${(v ? 30 : 24) * K}px ${UI}`);
    ctx.fillStyle = p.ink2;
    const when = facts.metrics ? `Day ${count(day)} · ${dateOf(snap.t)}` : dateOf(snap.t);
    ctx.fillText(when, x + pad, lineY);
    if (facts.metrics) {
      const people = [`${count(snap.customers)} ${snap.customers === 1 ? 'customer' : 'customers'}`];
      if (snap.users !== undefined) people.push(`${count(snap.users)} users`);
      this.font(ctx, `600 ${(v ? 30 : 24) * K}px ${UI}`);
      ctx.fillStyle = p.ink;
      if (v) ctx.fillText(people.join(' · '), x + pad, lineY + 44 * K);
      else {
        const ww = ctx.measureText(when).width;
        this.font(ctx, `500 ${24 * K}px ${UI}`);
        ctx.fillStyle = p.ink3;
        ctx.fillText(' · ', x + pad + ww, lineY);
        const dot = ctx.measureText(' · ').width;
        this.font(ctx, `600 ${24 * K}px ${UI}`);
        ctx.fillStyle = p.ink;
        ctx.fillText(people[0]!, x + pad + ww + dot, lineY);
      }
    }

    // The MRR line from day one to the day on screen, over the whole timeline's width.
    if (facts.metrics) {
      const cx = v ? x + pad : x + w * 0.6;
      const cw = v ? w - pad * 2 : w * 0.4 - pad;
      const cy = v ? lineY + 80 * K : y + pad + 22 * K;
      const ch = v ? h - (lineY + 80 * K - y) - pad : h - pad * 2 - 22 * K;
      this.chart(ctx, cx, cy, cw, ch, i);
    }
  }

  private chart(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, upto: number) {
    const { K, p } = this;
    const n = Math.max(1, this.facts.snapshots.length - 1);
    const px = (i: number) => x + (i / n) * w;
    const py = (v: number) => y + h - (v / this.peak) * h * 0.92;
    const pts = this.series.filter((s) => s.i <= upto);
    if (!pts.length || pts.at(-1)!.i !== upto) pts.push({ i: upto, v: this.facts.snapshots[upto]!.mrr });

    // A hairline baseline the whole width, so the line has somewhere to go.
    ctx.strokeStyle = p.rule;
    ctx.lineWidth = 1.5 * K;
    ctx.setLineDash([2 * K, 6 * K]);
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x + w, y + h);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    pts.forEach((s, k) => (k ? ctx.lineTo(px(s.i), py(s.v)) : ctx.moveTo(px(s.i), py(s.v))));
    const head = pts.at(-1)!;
    ctx.save();
    ctx.lineTo(px(head.i), y + h);
    ctx.lineTo(px(pts[0]!.i), y + h);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, p.fill);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    pts.forEach((s, k) => (k ? ctx.lineTo(px(s.i), py(s.v)) : ctx.moveTo(px(s.i), py(s.v))));
    ctx.strokeStyle = p.accent;
    ctx.lineWidth = 4 * K;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    // Today's dot, with a soft halo.
    const hx = px(head.i);
    const hy = py(head.v);
    ctx.fillStyle = p.fill;
    ctx.beginPath();
    ctx.arc(hx, hy, 15 * K, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = p.accent;
    ctx.beginPath();
    ctx.arc(hx, hy, 7 * K, 0, Math.PI * 2);
    ctx.fill();
  }

  /** The last two seconds: the city washed back, and a card with the totals and where to find TinyTown. */
  private endCard(ctx: CanvasRenderingContext2D, t: number) {
    const { p, facts, W, H } = this;
    // A tall frame has room for a bigger card.
    const K = this.K * (this.vertical ? 1.18 : 1);
    const last = facts.snapshots.length - 1;
    const snap = facts.snapshots[last]!;
    ctx.globalAlpha = t;
    ctx.fillStyle = p.wash;
    ctx.fillRect(0, 0, W, H);

    const cw = Math.min(W - 88 * K, 820 * K);
    const ch = 560 * K;
    const cx = (W - cw) / 2;
    const cy = (H - ch) / 2 + (1 - t) * 28 * K;
    ctx.save();
    ctx.shadowColor = p.shadow;
    ctx.shadowBlur = 60 * K;
    ctx.shadowOffsetY = 20 * K;
    ctx.fillStyle = p.card;
    ctx.beginPath();
    ctx.roundRect(cx, cy, cw, ch, 36 * K);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = p.cardLine;
    ctx.lineWidth = 1.5 * K;
    ctx.beginPath();
    ctx.roundRect(cx, cy, cw, ch, 36 * K);
    ctx.stroke();

    const mid = W / 2;
    ctx.textAlign = 'center';
    let y = cy + 84 * K;

    // Eyebrow: the honest framing of what you're looking at.
    this.font(ctx, `500 ${19 * K}px ${MONO}`);
    ctx.letterSpacing = `${1.9 * K}px`;
    ctx.fillStyle = p.ink3;
    const days = `Day 1 to day ${count(last + 1)}`;
    ctx.fillText((facts.demo ? `A demo startup · ${days}` : days).toUpperCase(), mid, y);
    ctx.letterSpacing = '0px';

    // The city's name, as big as it fits.
    y += 108 * K;
    let size = 100 * K;
    this.font(ctx, `800 ${size}px ${DISPLAY}`, true);
    ctx.letterSpacing = `${-0.03 * size}px`;
    while (ctx.measureText(facts.name).width > cw - 96 * K && size > 40 * K) {
      size -= 4 * K;
      this.font(ctx, `800 ${size}px ${DISPLAY}`, true);
      ctx.letterSpacing = `${-0.03 * size}px`;
    }
    ctx.fillStyle = p.ink;
    ctx.fillText(facts.name, mid, y);
    ctx.letterSpacing = '0px';

    // The totals: MRR in the accent, then customers.
    y += 66 * K;
    if (facts.metrics) {
      const mrr = `${formatMoney(snap.mrr, facts.currency)} MRR`;
      const rest = ` · ${count(snap.customers)} ${snap.customers === 1 ? 'customer' : 'customers'}`;
      this.font(ctx, `650 ${34 * K}px ${UI}`);
      const a = ctx.measureText(mrr).width;
      const b = ctx.measureText(rest).width;
      ctx.textAlign = 'left';
      ctx.fillStyle = p.accentText;
      ctx.fillText(mrr, mid - (a + b) / 2, y);
      ctx.fillStyle = p.ink2;
      ctx.fillText(rest, mid - (a + b) / 2 + a, y);
      ctx.textAlign = 'center';
    } else {
      this.font(ctx, `600 ${34 * K}px ${UI}`);
      ctx.fillStyle = p.ink2;
      ctx.fillText(`${count(last + 1)} days, ${dateOf(facts.snapshots[0]!.t)} to ${dateOf(snap.t)}`, mid, y);
    }

    // A short rule, then the lockup, the line and the address.
    y += 58 * K;
    ctx.strokeStyle = p.rule;
    ctx.lineWidth = 2 * K;
    ctx.beginPath();
    ctx.moveTo(mid - 60 * K, y);
    ctx.lineTo(mid + 60 * K, y);
    ctx.stroke();

    y += 46 * K;
    const markSize = 58 * K;
    this.font(ctx, `800 ${40 * K}px ${DISPLAY}`, true);
    ctx.letterSpacing = `${-1.2 * K}px`;
    const ww = ctx.measureText('TinyTown').width;
    const gap = 12 * K;
    const lx = mid - (markSize + gap + ww) / 2;
    drawMark(ctx, lx, y, markSize);
    ctx.textAlign = 'left';
    ctx.fillStyle = p.ink;
    ctx.textBaseline = 'middle';
    ctx.fillText('TinyTown', lx + markSize + gap, y + markSize * 0.6);
    ctx.textBaseline = 'alphabetic';
    ctx.letterSpacing = '0px';
    ctx.textAlign = 'center';

    y += markSize + 46 * K;
    this.font(ctx, `500 ${27 * K}px ${UI}`);
    ctx.fillStyle = p.ink2;
    ctx.fillText('A Tamagotchi for your startup.', mid, y);
    y += 42 * K;
    this.font(ctx, `500 ${22 * K}px ${MONO}`);
    ctx.letterSpacing = `${0.6 * K}px`;
    ctx.fillStyle = facts.night ? p.accent : BRAND.bayDeep;
    ctx.fillText(facts.site, mid, y);
    ctx.letterSpacing = '0px';
    ctx.textAlign = 'left';
    ctx.globalAlpha = 1;
  }
}
