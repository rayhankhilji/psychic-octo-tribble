import { formatMoney, runningPeak, type Snapshot, type Timeline } from '../data/types.ts';
import type { Tip } from '../render/city.ts';
import { HOME_TIERS, REGIONS } from '../game/catalog.ts';
import { markSvg } from './brand.ts';
import { compact, dateLabel, el, escape, reducedMotion, setHtml, setText, shortMrr, Tween } from './dom.ts';
import { ICON, type IconName } from './icons.ts';

export { el, escape } from './dom.ts';

export interface HudHandlers {
  onTogglePlay(): void;
  onSeek(index: number): void;
  onSpeed(): void;
  onReplay(): void;
  onRotate(): void;
  onResetView(): void;
  onShare(): void;
  onRename(name: string): void;
  onCycleTime(): void;
}

type Tone = 'good' | 'info' | 'warn' | 'bad' | 'brand' | 'muted';

/** How each feed event looks: icon, tone, a short kicker and how long it stays. */
const FEED: Record<string, { icon: IconName; tone: Tone; kicker: string; linger?: number }> = {
  'customers.joined': { icon: 'user', tone: 'good', kicker: 'Customers' },
  'customers.left': { icon: 'userMinus', tone: 'muted', kicker: 'Churn' },
  'customers.milestone': { icon: 'users', tone: 'brand', kicker: 'Milestone', linger: 7000 },
  'district.unlocked': { icon: 'flag', tone: 'brand', kicker: 'Milestone', linger: 7000 },
  'release.shipped': { icon: 'tag', tone: 'info', kicker: 'Release', linger: 6000 },
  'weather.changed': { icon: 'cloudRain', tone: 'info', kicker: 'Weather' },
  'game.build': { icon: 'build', tone: 'brand', kicker: 'Built' },
  'game.error': { icon: 'alert', tone: 'bad', kicker: 'Not quite' },
  'game.moon': { icon: 'rocket', tone: 'brand', kicker: 'Moon trip', linger: 7000 },
  'game.land.opened': { icon: 'map', tone: 'good', kicker: 'New land', linger: 7000 },
  'game.region.opened': { icon: 'cloudSun', tone: 'good', kicker: 'Clouds cleared', linger: 7000 },
  'game.home.moved': { icon: 'home', tone: 'brand', kicker: 'You moved', linger: 7000 },
  'game.sign.dark': { icon: 'bulbOff', tone: 'bad', kicker: 'Upkeep' },
  'game.sign.lit': { icon: 'bulb', tone: 'good', kicker: 'Lights on' },
  'game.decay': { icon: 'wrench', tone: 'warn', kicker: 'Upkeep' },
  'game.homeless.appeared': { icon: 'tent', tone: 'bad', kicker: 'Housing' },
  'game.homeless.cleared': { icon: 'home', tone: 'good', kicker: 'Housing' },
};

const LEGEND: { icon: IconName; tone: Tone; title: string; text: string }[] = [
  { icon: 'coin', tone: 'brand', title: 'Every $1 you earn is $10,000 to spend.', text: 'Paid daily into your treasury. Build offices, parks, towers, rides and planes on your plots.' },
  { icon: 'users', tone: 'info', title: 'Your users live here.', text: 'Each needs $0.20 of MRR to be housed: 1,000 users need $200. Short of that, people end up in tents.' },
  { icon: 'bulbOff', tone: 'bad', title: 'Upkeep keeps the lights on.', text: "Buildings cost upkeep. Short of it, the TINYTOWN sign goes dark first, then lamps fail, the bridge rusts and the train stops." },
  { icon: 'home', tone: 'brand', title: 'Your home moves up', text: 'with every extra digit of MRR: hacker house, studio, the Hills, an island, the moon.' },
  { icon: 'map', tone: 'good', title: 'Land opens', text: 'as you fill your plots and grow MRR: clouds clear over new blocks, the Hills, the pier, the marina and your island.' },
  { icon: 'cloudRain', tone: 'info', title: 'Rain', text: 'when MRR falls more than 1% in a week. HQ gains a floor per release; the train speeds up with commits.' },
];

/** Paying-customer counts worth a moment of their own. */
const CUSTOMER_MILESTONES = [10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000];

const SUNRISE = 6.1;
const SUNSET = 19.7;

interface Milestone {
  i: number;
  label: string;
  detail: string;
  kind: 'mrr' | 'customer' | 'release';
}

/** What each MRR milestone unlocks, for the timeline's hover labels. */
function unlocksAt(mrr: number): string {
  const bits: string[] = [];
  const tier = HOME_TIERS.find((h) => h.mrr === mrr);
  if (tier) bits.push(tier.options.map((o) => o.name).join(' or '));
  for (const r of Object.values(REGIONS)) if (r.gate === mrr) bits.push(`${r.name} opens`);
  return bits.join(' · ');
}

export class Hud {
  /** Containers the game UI mounts into. */
  readonly sideEl: HTMLElement;
  readonly toolsEl: HTMLElement;
  readonly mapEl: HTMLElement;
  private root: HTMLElement;
  private h: HudHandlers;
  private timeline: Timeline | null = null;
  private index = 0;

  private brandCity: HTMLElement;
  private brandSource: HTMLElement;
  private clockBtn: HTMLButtonElement;
  private clockTime: HTMLElement;
  private clockLabel: HTMLElement;
  private clockArc: SVGSVGElement;
  private metrics = new Map<string, { value: HTMLElement; delta: HTMLElement; tween: Tween; row: HTMLElement }>();
  private sourceBadge: HTMLElement;
  private asOf: HTMLElement;
  private miniMrr: HTMLElement;
  private miniMrrTween: Tween;

  private feedEl: HTMLElement;
  private noticeEl: HTMLElement;

  private dateEl: HTMLElement;
  private dayEl: HTMLElement;
  private scrubWrap: HTMLElement;
  private scrub: HTMLInputElement;
  private chart: HTMLCanvasElement;
  private chartPast: HTMLCanvasElement | null = null;
  private chartFuture: HTMLCanvasElement | null = null;
  private chartY: number[] = [];
  private thumb: HTMLElement;
  private hover: HTMLElement;
  private markers: HTMLElement;
  private milestones: Milestone[] = [];
  private playBtn: HTMLButtonElement;
  private speedBtn: HTMLButtonElement;

  private tip: HTMLElement;
  private uitip: HTMLElement;
  private connect: HTMLDialogElement;
  private share: HTMLDialogElement;
  private help: HTMLDetailsElement;

  constructor(root: HTMLElement, h: HudHandlers) {
    this.root = root;
    this.h = h;

    // ── Top bar ────────────────────────────────────────────────────────
    const top = el('header', { class: 'topbar' });
    const brand = el(
      'div',
      { class: 'brand card' },
      `${markSvg({ cls: 'brand-mark' })}
       <span class="wordmark" aria-label="TinyTown">TinyTown</span>
       <span class="brand-sep" aria-hidden="true"></span>
       <button class="brand-city" type="button" data-tip-title="Your city" data-tip="Name it after your startup. Click to rename or connect live data.">
         <span class="brand-city-name"></span>
         <span class="brand-source"></span>
       </button>`,
    );
    this.brandCity = brand.querySelector('.brand-city-name')!;
    this.brandSource = brand.querySelector('.brand-source')!;
    brand.querySelector('.brand-city')!.addEventListener('click', () => this.openConnect(true));

    this.clockBtn = el('button', { class: 'clock card', type: 'button', 'aria-label': 'Time of day' });
    this.clockBtn.innerHTML = `
      <svg class="clock-arc" viewBox="0 0 48 26" aria-hidden="true">
        <path class="arc-track" d="M4 22a20 20 0 0 1 40 0"/>
        <path class="arc-done" d="M4 22a20 20 0 0 1 40 0" pathLength="100"/>
        <path class="arc-horizon" d="M1 22.5h46"/>
        <g class="arc-body"><circle class="arc-glow" r="5.5"/><circle class="arc-sun" r="3.4"/><path class="arc-moon" d="M1.6-2.6A3.4 3.4 0 1 0 2.9 2 2.7 2.7 0 0 1 1.6-2.6Z"/></g>
      </svg>
      <span class="clock-text"><b class="clock-time num"></b><small class="clock-label"></small></span>`;
    this.clockTime = this.clockBtn.querySelector('.clock-time')!;
    this.clockLabel = this.clockBtn.querySelector('.clock-label')!;
    this.clockArc = this.clockBtn.querySelector('.clock-arc')!;
    this.clockBtn.dataset.tipTitle = 'Time of day';
    this.clockBtn.dataset.tip = 'Follows your local clock. Click to preview morning, midday, golden hour and night.';
    this.clockBtn.addEventListener('click', () => h.onCycleTime());

    const tools = el('nav', { class: 'toolbar card', 'aria-label': 'Actions' });
    this.toolsEl = tools;
    tools.append(
      this.button('plug', 'Connect', () => this.openConnect(false), 'ghost icon-only', 'Connect your startup: Stripe, GitHub, your city name'),
      this.button('share', 'Share', () => h.onShare(), 'ghost', 'Share a snapshot of your city'),
    );
    top.append(brand, this.clockBtn, el('div', { class: 'grow' }), tools);

    // ── Left rail: real metrics (the game UI adds the city card) ──────────
    const side = el('section', { class: 'rail', 'aria-label': 'Your numbers' });
    this.sideEl = side;
    const mini = el(
      'button',
      { class: 'mini card', type: 'button', 'aria-expanded': 'false', 'aria-label': 'Show details' },
      `<span class="mini-stat"><small>MRR</small><b class="num" data-mini="mrr">–</b></span>
       <span class="mini-stat"><small>Treasury</small><b class="num" data-mini="treasury">–</b></span>
       <span class="mini-stat mini-sat" data-mini="sat"></span>
       <span class="mini-chev">${ICON.chevron}</span>`,
    );
    mini.addEventListener('click', () => {
      const open = side.classList.toggle('expanded');
      mini.setAttribute('aria-expanded', String(open));
    });
    this.miniMrr = mini.querySelector('[data-mini=mrr]')!;
    this.miniMrrTween = new Tween((v) => setText(this.miniMrr, this.money(v, true)));

    const metrics = el(
      'div',
      { class: 'metrics card' },
      `<div class="card-head">
         <span class="eyebrow">Real metrics</span>
         <span class="source-badge"></span>
       </div>
       <div class="hero-metric" data-key="mrr">
         <span class="hero-label">MRR</span>
         <span class="hero-row"><b class="hero-value num metric-value">–</b><span class="chip metric-delta"></span></span>
       </div>
       <div class="metric-grid"></div>
       <div class="as-of"></div>`,
    );
    this.sourceBadge = metrics.querySelector('.source-badge')!;
    this.asOf = metrics.querySelector('.as-of')!;
    const heroRow = metrics.querySelector<HTMLElement>('.hero-metric')!;
    this.addMetric('mrr', heroRow, (v) => this.money(v, false));
    const grid = metrics.querySelector('.metric-grid')!;
    for (const [key, label] of [['customers', 'Customers'], ['users', 'Active users'], ['releases', 'Releases'], ['commits', 'Commits']] as const) {
      const row = el('div', { class: 'metric', 'data-key': key }, `<span class="metric-label">${label}</span><b class="metric-value num">–</b><span class="metric-delta"></span>`);
      this.addMetric(key, row, (v) => Math.round(v).toLocaleString('en-US'));
      grid.append(row);
    }
    metrics.querySelector('[data-key=users]')!.setAttribute('data-tip', 'Monthly active users, paying or not. Everyone needs a home.');
    heroRow.dataset.tipTitle = 'Monthly recurring revenue';
    heroRow.dataset.tip = 'Straight from Stripe. Every $1 is $10,000 a month for your city, paid daily.';
    side.append(mini, metrics);

    // ── How to play ────────────────────────────────────────────────────
    this.help = el('details', { class: 'help card' });
    this.help.innerHTML = `
      <summary><span class="help-pill">${ICON.help}<span>How to play</span></span><span class="help-chev">${ICON.chevron}</span></summary>
      <p class="help-lede">The only way to grow your city is to grow your startup.</p>
      <ul>${LEGEND.map((l) => `<li><span class="tile tone-${l.tone}">${ICON[l.icon]}</span><span><b>${l.title}</b> ${l.text}</span></li>`).join('')}</ul>
      <div class="keys">
        <span><kbd>Space</kbd> play</span><span><kbd>←</kbd><kbd>→</kbd> day</span><span><kbd>B</kbd> build</span><span><kbd>Q</kbd><kbd>E</kbd> rotate</span><span><kbd>+</kbd><kbd>−</kbd> zoom</span>
      </div>`;

    this.feedEl = el('div', { class: 'feed', 'aria-live': 'polite', 'aria-label': 'What happened' });
    this.noticeEl = el('div', { class: 'notices' });

    // ── Map controls ───────────────────────────────────────────────────
    this.mapEl = el('div', { class: 'mapctl card', role: 'toolbar', 'aria-label': 'Map' });
    this.mapEl.append(this.button('rotate', 'Rotate', () => h.onRotate(), 'ghost icon-only', 'Rotate (Q / E)'), this.button('recenter', 'Recenter', () => h.onResetView(), 'ghost icon-only', 'Back to the overview'));

    // ── Dock: playback and the timeline ───────────────────────────────
    const dock = el('footer', { class: 'dock card', 'aria-label': 'Timeline' });
    this.playBtn = this.button('play', 'Play', () => h.onTogglePlay(), 'play icon-only', 'Play / pause (Space)');
    const date = el('div', { class: 'dock-date' }, '<b class="num"></b><small class="num"></small>');
    this.dateEl = date.querySelector('b')!;
    this.dayEl = date.querySelector('small')!;
    this.scrubWrap = el('div', { class: 'scrub' });
    this.chart = el('canvas', { 'aria-hidden': 'true' });
    this.markers = el('div', { class: 'scrub-markers', 'aria-hidden': 'true' });
    this.hover = el('div', { class: 'scrub-hover', hidden: '' }, '<span class="scrub-bubble"></span>');
    this.thumb = el('div', { class: 'scrub-thumb', 'aria-hidden': 'true' }, '<i></i>');
    this.scrub = el('input', { type: 'range', min: '0', max: '0', value: '0', step: '1', 'aria-label': 'Day' });
    this.scrub.addEventListener('input', () => h.onSeek(Number(this.scrub.value)));
    this.scrubWrap.append(this.chart, this.markers, this.thumb, this.hover, this.scrub);
    this.scrubWrap.addEventListener('pointermove', (e) => this.onScrubHover(e));
    this.scrubWrap.addEventListener('pointerleave', () => (this.hover.hidden = true));
    this.speedBtn = el('button', { class: 'btn ghost speed num', type: 'button', 'aria-label': 'Playback speed', 'data-tip': 'Playback speed' }, '1×');
    this.speedBtn.addEventListener('click', () => h.onSpeed());
    const replay = this.button('replay', 'Replay', () => h.onReplay(), 'ghost', 'Replay your story from day one');
    dock.append(this.playBtn, date, this.scrubWrap, this.speedBtn, replay);

    // ── Floating bits ──────────────────────────────────────────────────
    this.tip = el('div', { class: 'tip', role: 'tooltip', hidden: '' }, '<div class="tip-title"></div><div class="tip-detail"></div>');
    this.uitip = el('div', { class: 'uitip', role: 'tooltip', hidden: '' });
    this.connect = el('dialog', { class: 'dialog connect-dialog', 'aria-labelledby': 'connect-title' });
    this.connect.addEventListener('click', (e) => e.target === this.connect && this.connect.close());
    this.share = el('dialog', { class: 'dialog share-dialog', 'aria-labelledby': 'share-title' });
    this.share.addEventListener('click', (e) => e.target === this.share && this.share.close());

    const lower = el('div', { class: 'lower' });
    lower.append(this.noticeEl, this.feedEl);
    root.append(top, side, this.help, lower, this.mapEl, dock);
    document.body.append(this.tip, this.uitip, this.connect, this.share);

    this.wireTooltips();
    window.addEventListener('keydown', (e) => this.onKey(e));
    new ResizeObserver(() => this.drawChart()).observe(this.scrubWrap);
  }

  private addMetric(key: string, row: HTMLElement, fmt: (v: number) => string) {
    const value = row.querySelector<HTMLElement>('.metric-value')!;
    const delta = row.querySelector<HTMLElement>('.metric-delta')!;
    this.metrics.set(key, { value, delta, row, tween: new Tween((v) => setText(value, fmt(v))) });
  }

  private money(v: number, short: boolean): string {
    const c = this.timeline?.currency ?? 'usd';
    if (short && Math.abs(v) >= 10_000) {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: c.toUpperCase(), notation: 'compact', maximumFractionDigits: 1 }).format(v);
    }
    return formatMoney(v >= 100 ? Math.round(v) : Math.round(v * 100) / 100, c);
  }

  button(icon: IconName, label: string, onClick: () => void, cls = '', tip = label): HTMLButtonElement {
    const b = el('button', { class: `btn ${cls}`, type: 'button', 'aria-label': tip, 'data-tip': tip }, `${ICON[icon]}<span class="label">${escape(label)}</span>`);
    b.addEventListener('click', onClick);
    return b;
  }

  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (t instanceof HTMLInputElement && t.type !== 'range') return;
    if (t instanceof HTMLTextAreaElement || document.querySelector('dialog[open]')) return;
    if (e.code === 'Space' && !(t instanceof HTMLButtonElement)) {
      e.preventDefault();
      this.h.onTogglePlay();
    }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !(t instanceof HTMLInputElement)) {
      e.preventDefault();
      const step = (e.shiftKey ? 7 : 1) * (e.key === 'ArrowLeft' ? -1 : 1);
      this.h.onSeek(Math.max(0, Math.min(Number(this.scrub.max), this.index + step)));
    }
    if (e.key === '?') this.help.open = !this.help.open;
    if (e.key === 'Escape' && this.help.open) this.help.open = false;
  }

  // ── Data ─────────────────────────────────────────────────────────────

  setTimeline(t: Timeline) {
    const first = !this.timeline;
    this.timeline = t;
    setText(this.brandCity, t.name);
    const live = t.source === 'live';
    const sources = [t.integrations.stripe && 'Stripe', t.integrations.github && 'GitHub'].filter(Boolean).join(' + ');
    setHtml(this.brandSource, live ? `<i class="dot live"></i>Live` : `<i class="dot"></i>Demo world`);
    setHtml(this.sourceBadge, live ? `<i class="dot live"></i>${escape(sources || 'Live')}` : 'Demo data');
    this.sourceBadge.dataset.tip = live ? `Synced from ${sources} every minute.` : 'A fictional startup, so you can see a city grow. Connect yours to make it real.';
    this.scrub.max = String(Math.max(0, t.snapshots.length - 1));
    this.computeMilestones();
    this.drawChart();
    this.renderConnect();
    if (first) document.title = `${t.name} · TinyTown`;
  }

  private computeMilestones() {
    const t = this.timeline!;
    const s = t.snapshots;
    const peaks = runningPeak(s);
    const out: Milestone[] = [];
    const thresholds = [1, 10, 100, 1_000, 3_000, 10_000, 100_000, 1_000_000];
    for (const th of thresholds) {
      const i = peaks.findIndex((p) => p >= th);
      if (i < 0) continue;
      const label = th === 1 ? 'First revenue' : `${shortMrr(th)} MRR`;
      out.push({ i, label, detail: th === 1 ? 'The treasury starts filling up' : unlocksAt(th) || 'New things to build', kind: 'mrr' });
    }
    const firstCustomer = s.findIndex((x) => x.customers > 0);
    if (firstCustomer >= 0) out.push({ i: firstCustomer, label: 'First customer', detail: 'Someone paid for the thing you made', kind: 'customer' });
    s.forEach((x, i) => {
      if (x.release && i > 0) out.push({ i, label: x.release, detail: 'Release shipped · HQ grew a floor', kind: 'release' });
    });
    this.milestones = out;
  }

  setIndex(i: number) {
    const t = this.timeline;
    if (!t) return;
    const s = t.snapshots[i];
    if (!s) return;
    const prev = this.index;
    this.index = i;
    // Big jumps (scrubbing) snap; day-by-day playback glides.
    const glide = Math.abs(i - prev) <= 4;
    this.scrub.value = String(i);
    this.scrub.setAttribute('aria-valuetext', `${dateLabel(s.t)}, day ${i + 1}`);
    setText(this.dateEl, dateLabel(s.t));
    setText(this.dayEl, `Day ${(i + 1).toLocaleString('en-US')} of ${t.snapshots.length.toLocaleString('en-US')}`);

    const week = t.snapshots[Math.max(0, i - 7)]!;
    for (const key of ['customers', 'users', 'mrr', 'releases', 'commits'] as const) {
      const m = this.metrics.get(key)!;
      const has =
        key === 'users' ? s.users !== undefined : key === 'mrr' || key === 'customers' ? t.integrations.stripe || t.source === 'demo' : t.integrations.github || t.source === 'demo';
      m.row.classList.toggle('missing', !has);
      const now = s[key] ?? 0;
      if (!has) {
        setText(m.value, '—');
        setText(m.delta, '');
        continue;
      }
      m.tween.set(now, glide);
      const d = now - ((week[key] as number | undefined) ?? 0);
      const neutral = key === 'commits' || key === 'releases';
      const fmt = key === 'mrr' ? (v: number) => this.money(v, true) : (v: number) => compact(v);
      setText(m.delta, d === 0 ? '' : `${d > 0 ? '+' : '−'}${fmt(Math.abs(d))}${key === 'mrr' ? ' · 7d' : ''}`);
      m.delta.dataset.dir = neutral ? 'flat' : d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
    }
    this.miniMrrTween.set(s.mrr, glide);
    if (i === prev + 1) {
      const before = t.snapshots[prev]!.customers;
      const m = CUSTOMER_MILESTONES.find((n) => before < n && s.customers >= n);
      if (m) this.feed('customers.milestone', `${m.toLocaleString('en-US')} paying customers. Every one of them lives here.`, s.t);
    }
    setText(this.asOf, `As of ${dateLabel(s.t)}`);
    this.paintChart();
  }

  /** Shows the world's time of day; `preview` is the label when not following the local clock. */
  setClock(hour: number, phase: string, preview: string | null) {
    const h = Math.floor(hour);
    const m = Math.floor((hour - h) * 60);
    const time = new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const label = phase[0]!.toUpperCase() + phase.slice(1);
    setText(this.clockTime, time);
    setText(this.clockLabel, preview ? `Preview · ${preview}` : `${label} · your time`);
    this.clockBtn.classList.toggle('previewing', !!preview);

    // Sun by day, moon by night, travelling along the arc.
    const day = hour >= SUNRISE && hour < SUNSET;
    const f = day ? (hour - SUNRISE) / (SUNSET - SUNRISE) : (((hour - SUNSET + 24) % 24) / (24 - SUNSET + SUNRISE));
    const a = Math.PI * (1 - f);
    const x = 24 + 20 * Math.cos(a);
    const y = 22 - 20 * Math.sin(a);
    const body = this.clockArc.querySelector('.arc-body')!;
    body.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
    this.clockArc.style.setProperty('--done', String(100 - f * 100));
    this.clockArc.dataset.body = day ? 'sun' : 'moon';

    const night = hour < 6.4 || hour >= 19.4;
    const theme = night ? 'night' : 'day';
    if (document.documentElement.dataset.theme !== theme) document.documentElement.dataset.theme = theme;
  }

  setPlaying(playing: boolean) {
    this.playBtn.innerHTML = `${playing ? ICON.pause : ICON.play}<span class="label">${playing ? 'Pause' : 'Play'}</span>`;
    this.playBtn.classList.toggle('playing', playing);
    this.playBtn.setAttribute('aria-label', playing ? 'Pause (Space)' : 'Play (Space)');
    this.root.classList.toggle('is-playing', playing);
  }

  setSpeed(label: string) {
    setText(this.speedBtn, label);
    this.speedBtn.classList.remove('bump');
    void this.speedBtn.offsetWidth;
    this.speedBtn.classList.add('bump');
  }

  // ── Feed ───────────────────────────────────────────────────────────

  /** Adds a toast to the event feed; repeated kinds collapse into the latest one. */
  feed(kind: string, text: string, t: number) {
    const date = dateLabel(t, { month: 'short', day: 'numeric' });
    const first = kind === 'customers.joined' && /first/i.test(text);
    const spec = first ? { icon: 'sparkle' as const, tone: 'brand' as const, kicker: 'Milestone', linger: 8000 } : (FEED[kind] ?? { icon: 'sparkle', tone: 'info', kicker: 'News' });
    const icon: IconName = kind === 'weather.changed' && /clear/i.test(text) ? 'sun' : spec.icon;
    const last = this.feedEl.firstElementChild as HTMLElement | null;
    if (last && last.dataset.kind === kind && !last.classList.contains('out') && Date.now() - Number(last.dataset.at) < 1800) {
      setText(last.querySelector('.toast-text')!, text);
      setText(last.querySelector('.toast-date')!, date);
      last.classList.remove('bump');
      void last.offsetWidth;
      last.classList.add('bump');
      this.expire(last, spec.linger);
      return;
    }
    const toast = el(
      'div',
      { class: `toast tone-${spec.tone}`, role: 'status' },
      `<span class="tile">${ICON[icon]}</span>
       <span class="toast-body"><span class="toast-kicker">${spec.kicker}<span class="toast-date num"></span></span><span class="toast-text"></span></span>
       <button class="toast-close" type="button" aria-label="Dismiss">${ICON.close}</button>
       <i class="toast-timer"></i>`,
    );
    toast.dataset.kind = kind;
    setText(toast.querySelector('.toast-text')!, text);
    setText(toast.querySelector('.toast-date')!, date);
    toast.querySelector('.toast-close')!.addEventListener('click', () => this.dismiss(toast));
    this.feedEl.prepend(toast);
    const live = [...this.feedEl.children].filter((c) => !c.classList.contains('out'));
    for (const old of live.slice(4)) this.dismiss(old as HTMLElement);
    this.expire(toast, spec.linger);
  }

  /** A message that stays until dismissed. */
  notice(text: string) {
    const toast = el(
      'div',
      { class: 'toast notice tone-warn', role: 'status' },
      `<span class="tile">${ICON.info}</span><span class="toast-body"><span class="toast-kicker">Heads up</span><span class="toast-text"></span></span><button class="toast-close" type="button" aria-label="Dismiss">${ICON.close}</button>`,
    );
    setText(toast.querySelector('.toast-text')!, text);
    toast.querySelector('.toast-close')!.addEventListener('click', () => toast.remove());
    this.noticeEl.append(toast);
  }

  private expire(toast: HTMLElement, linger = 4500) {
    toast.dataset.at = String(Date.now());
    toast.style.setProperty('--linger', `${linger}ms`);
    const timer = toast.querySelector<HTMLElement>('.toast-timer');
    if (timer) {
      timer.style.animation = 'none';
      void timer.offsetWidth;
      timer.style.animation = '';
    }
    clearTimeout(Number(toast.dataset.timer));
    toast.dataset.timer = String(window.setTimeout(() => this.dismiss(toast), linger));
  }

  private dismiss(toast: HTMLElement) {
    if (toast.classList.contains('out')) return;
    clearTimeout(Number(toast.dataset.timer));
    toast.classList.add('out');
    window.setTimeout(() => toast.remove(), reducedMotion() ? 0 : 380);
  }

  clearFeed() {
    this.feedEl.innerHTML = '';
  }

  // ── Tooltips ───────────────────────────────────────────────────────

  showTip(tip: Tip | null, x: number, y: number) {
    if (!tip) {
      this.tip.hidden = true;
      return;
    }
    setText(this.tip.querySelector('.tip-title')!, tip.title);
    setText(this.tip.querySelector('.tip-detail')!, tip.detail);
    const w = 280;
    const flip = x > window.innerWidth - w - 24;
    this.tip.style.left = `${flip ? x - w - 14 : x + 16}px`;
    this.tip.style.top = `${Math.min(y + 16, window.innerHeight - 120)}px`;
    this.tip.hidden = false;
  }

  /** Any element with `data-tip` (and optional `data-tip-title`, or `data-tip-html`) gets a tooltip on hover and focus. */
  private wireTooltips() {
    let current: HTMLElement | null = null;
    let timer = 0;
    const show = (target: HTMLElement) => {
      const html = target.dataset.tipHtml;
      const text = target.dataset.tip;
      if (!html && !text) return;
      const title = target.dataset.tipTitle;
      this.uitip.innerHTML = html ?? `${title ? `<b>${escape(title)}</b>` : ''}<span>${escape(text!)}</span>`;
      this.uitip.hidden = false;
      const r = target.getBoundingClientRect();
      const tw = this.uitip.offsetWidth;
      const th = this.uitip.offsetHeight;
      const below = r.top < th + 24;
      const left = Math.max(10, Math.min(window.innerWidth - tw - 10, r.left + r.width / 2 - tw / 2));
      this.uitip.style.left = `${left}px`;
      this.uitip.style.top = `${below ? r.bottom + 10 : r.top - th - 10}px`;
      this.uitip.dataset.side = below ? 'below' : 'above';
    };
    const hide = () => {
      clearTimeout(timer);
      current = null;
      this.uitip.hidden = true;
    };
    const find = (e: Event) => (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-tip],[data-tip-html]') ?? null;
    document.addEventListener('pointerover', (e) => {
      if ((e as PointerEvent).pointerType === 'touch') return;
      const t = find(e);
      if (t === current) return;
      hide();
      if (!t) return;
      current = t;
      timer = window.setTimeout(() => current === t && show(t), 280);
    });
    document.addEventListener('focusin', (e) => {
      const t = find(e);
      if (!t || !(e.target as HTMLElement).matches(':focus-visible')) return hide();
      current = t;
      show(t);
    });
    document.addEventListener('focusout', hide);
    document.addEventListener('pointerdown', hide);
    document.addEventListener('keydown', (e) => e.key === 'Escape' && hide());
  }

  // ── Timeline chart ─────────────────────────────────────────────────

  private drawChart() {
    const t = this.timeline;
    const c = this.chart;
    const rect = this.scrubWrap.getBoundingClientRect();
    if (!t || rect.width < 10) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(rect.width * dpr));
    const H = Math.max(1, Math.round(rect.height * dpr));
    c.width = W;
    c.height = H;
    const s = t.snapshots;
    const useMrr = s.some((x) => x.mrr > 0);
    const values = s.map((x) => (useMrr ? x.mrr : x.commits));
    const max = Math.max(1, ...values) * 1.04;
    const n = Math.max(1, s.length - 1);
    const top = 10 * dpr;
    const base = H - 9 * dpr;
    const x = (i: number) => (i / n) * W;
    // Square-root scale: early milestones ($10, $100, $1k) stay readable next to later growth.
    const y = (v: number) => base - Math.sqrt(Math.max(0, v) / max) * (base - top);
    this.chartY = values.map((v) => y(v) / dpr);
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue('--chart-line').trim() || '#e5512b';
    const fillTop = css.getPropertyValue('--chart-fill').trim() || 'rgba(229,81,43,.28)';
    const muted = css.getPropertyValue('--chart-muted').trim() || 'rgba(27,34,54,.22)';
    const grid = css.getPropertyValue('--chart-grid').trim() || 'rgba(27,34,54,.08)';

    const paint = (line: string, fill: string, fade: string, width: number) => {
      const cv = document.createElement('canvas');
      cv.width = W;
      cv.height = H;
      const ctx = cv.getContext('2d')!;
      // Baseline and quarter guides
      ctx.fillStyle = grid;
      for (const k of [0.25, 0.5, 0.75]) ctx.fillRect(0, Math.round(base - (base - top) * k), W, Math.max(1, dpr * 0.6));
      const path = new Path2D();
      values.forEach((v, i) => (i ? path.lineTo(x(i), y(v)) : path.moveTo(x(i), y(v))));
      const area = new Path2D(path);
      area.lineTo(W, base);
      area.lineTo(0, base);
      area.closePath();
      // The fill hugs the curve: strongest just under the line's peak, fading to the floor.
      const peakY = Math.min(base - 4 * dpr, ...values.map(y));
      const g = ctx.createLinearGradient(0, peakY, 0, base);
      g.addColorStop(0, fill);
      g.addColorStop(1, fade);
      ctx.fillStyle = g;
      ctx.fill(area);
      ctx.strokeStyle = line;
      ctx.lineWidth = width * dpr;
      ctx.lineJoin = 'round';
      ctx.stroke(path);
      ctx.fillStyle = line;
      ctx.fillRect(0, base, W, Math.max(1, dpr));
      // Release ticks along the floor
      ctx.globalAlpha = 0.7;
      s.forEach((snap, i) => {
        if (snap.release) ctx.fillRect(Math.round(x(i)) - Math.round(dpr / 2), base + 3 * dpr, Math.max(1, Math.round(dpr)), 4 * dpr);
      });
      return cv;
    };
    this.chartPast = paint(accent, fillTop, 'rgba(255,255,255,0)', 2);
    this.chartFuture = paint(muted, muted.replace(/[\d.]+\)$/, '0.10)'), 'rgba(255,255,255,0)', 1.2);

    // Milestone markers (MRR and first customer); releases are the floor ticks.
    this.markers.innerHTML = this.milestones
      .filter((m) => m.kind !== 'release')
      .map((m) => `<i class="ms ms-${m.kind}" style="left:${((m.i / n) * 100).toFixed(3)}%;top:${(this.chartY[m.i] ?? 0).toFixed(1)}px"></i>`)
      .join('');
    this.paintChart();
  }

  private paintChart() {
    const c = this.chart;
    const t = this.timeline;
    if (!t || !this.chartPast || !this.chartFuture) return;
    const ctx = c.getContext('2d')!;
    const n = Math.max(1, t.snapshots.length - 1);
    const px = Math.round((this.index / n) * c.width);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(this.chartFuture, 0, 0);
    ctx.clearRect(0, 0, px, c.height);
    ctx.drawImage(this.chartPast, 0, 0, px, c.height, 0, 0, px, c.height);
    const pct = (this.index / n) * 100;
    this.thumb.style.left = `${pct}%`;
    this.thumb.style.setProperty('--y', `${(this.chartY[this.index] ?? 0).toFixed(1)}px`);
    this.markers.querySelectorAll<HTMLElement>('.ms').forEach((m) => m.classList.toggle('past', parseFloat(m.style.left) <= pct + 0.001));
  }

  private onScrubHover(e: PointerEvent) {
    const t = this.timeline;
    if (!t || e.pointerType === 'touch') return;
    const r = this.scrubWrap.getBoundingClientRect();
    const n = Math.max(1, t.snapshots.length - 1);
    const fx = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    let i = Math.round(fx * n);
    const near = this.milestones
      .map((m) => ({ m, d: Math.abs((m.i / n) * r.width - (e.clientX - r.left)) }))
      .filter((x) => x.d < 7)
      .sort((a, b) => a.d - b.d || (a.m.kind === 'release' ? 1 : -1))[0]?.m;
    if (near) i = near.i;
    const s = t.snapshots[i]!;
    const bubble = this.hover.querySelector('.scrub-bubble')!;
    const money = formatMoney(s.mrr, t.currency);
    bubble.innerHTML = near
      ? `<b>${escape(near.label)}</b><span>${escape(near.detail)}</span><small>${dateLabel(s.t)} · day ${i + 1}</small>`
      : `<b class="num">${money} MRR</b><small>${dateLabel(s.t)} · day ${i + 1}</small>`;
    this.hover.classList.toggle('is-milestone', !!near);
    this.hover.style.left = `${(i / n) * 100}%`;
    const align = fx < 0.12 ? 'start' : fx > 0.88 ? 'end' : 'mid';
    this.hover.dataset.align = align;
    this.hover.hidden = false;
  }

  // ── Dialogs ────────────────────────────────────────────────────────

  private openConnect(focusName: boolean) {
    this.renderConnect();
    this.connect.showModal();
    if (focusName) this.connect.querySelector<HTMLInputElement>('input[name=name]')?.select();
  }

  private renderConnect() {
    const t = this.timeline;
    const status = (on: boolean | undefined, planned = false) =>
      `<span class="status ${on ? 'on' : ''}">${on ? `${ICON.check}Connected` : planned ? 'Coming next' : 'Not connected'}</span>`;
    this.connect.innerHTML = `
      <form method="dialog" class="dialog-body">
        <header class="dialog-head">
          <span class="tile tone-brand">${ICON.plug}</span>
          <div><h2 id="connect-title">Connect your startup</h2><p>Real numbers in, a living city out. Keys stay on a small server you run; they never touch the browser.</p></div>
          <button class="btn ghost icon-only close" value="cancel" aria-label="Close">${ICON.close}</button>
        </header>
        <div class="integrations">
          <div class="integration"><span class="tile">${ICON.card}</span><div><b>Stripe</b><small>Customers and MRR, with full history</small></div>${status(t?.integrations.stripe)}</div>
          <div class="integration"><span class="tile">${ICON.github}</span><div><b>GitHub</b><small>Releases and commits on your default branch</small></div>${status(t?.integrations.github)}</div>
          <div class="integration"><span class="tile">${ICON.users}</span><div><b>PostHog · Supabase</b><small>Active users, so everyone gets a home</small></div>${status(false, true)}</div>
        </div>
        <div class="env">
          <div class="env-head"><span>.env</span><small>then restart <code>npm start</code></small></div>
<pre><span class="k">TINYTOWN_NAME</span>=Your Startup
<span class="k">STRIPE_SECRET_KEY</span>=rk_live_…   <span class="c"># restricted, read-only Subscriptions</span>
<span class="k">GITHUB_REPO</span>=you/your-repo
<span class="k">GITHUB_TOKEN</span>=github_pat_…     <span class="c"># only for private repos</span></pre>
        </div>
        <label class="field"><span>Name on the HQ sign <small>(this browser only)</small></span><input name="name" maxlength="22" autocomplete="off" spellcheck="false" value="${escape(t?.name ?? '')}"></label>
        <div class="dialog-actions">
          <span class="plan">${ICON.sparkle}<span><b>TinyTown Pro</b> · live worlds for $12/month or $99/year</span></span>
          <button class="btn ghost" value="cancel">Close</button>
          <button class="btn primary" value="save">Save name</button>
        </div>
      </form>`;
    const form = this.connect.querySelector('form')!;
    form.addEventListener('submit', (e) => {
      const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
      if (submitter?.value === 'save') this.h.onRename((form.elements.namedItem('name') as HTMLInputElement).value.trim());
    });
  }

  /** Shows the share dialog for a captured frame. */
  openShare(frame: HTMLCanvasElement, compose: (frame: HTMLCanvasElement, withMetrics: boolean) => HTMLCanvasElement, filename: string) {
    this.share.innerHTML = `
      <div class="dialog-body">
        <header class="dialog-head">
          <span class="tile tone-brand">${ICON.share}</span>
          <div><h2 id="share-title">Share your city</h2><p>A postcard from ${escape(this.timeline?.name ?? 'your city')}. Metrics stay private unless you add them.</p></div>
          <button class="btn ghost icon-only close" data-act="close" aria-label="Close">${ICON.close}</button>
        </header>
        <div class="share-frame"><img class="share-preview" alt="Snapshot of your city"></div>
        <label class="switch"><input type="checkbox" name="metrics" role="switch"><span class="switch-track"><i></i></span><span><b>Include real numbers</b><small>Customers, MRR and releases on the card</small></span></label>
        <div class="dialog-actions">
          <button class="btn ghost" data-act="copy">${ICON.copy}<span class="label">Copy image</span></button>
          <button class="btn primary" data-act="download">${ICON.download}<span class="label">Download PNG</span></button>
        </div>
      </div>`;
    const img = this.share.querySelector('img')!;
    const box = this.share.querySelector<HTMLInputElement>('input[name=metrics]')!;
    let out = compose(frame, false);
    const refresh = () => {
      out = compose(frame, box.checked);
      img.src = out.toDataURL('image/png');
    };
    box.addEventListener('change', refresh);
    refresh();
    this.share.querySelector('[data-act=close]')!.addEventListener('click', () => this.share.close());
    this.share.querySelector('[data-act=download]')!.addEventListener('click', () => {
      const a = document.createElement('a');
      a.download = filename;
      a.href = out.toDataURL('image/png');
      a.click();
    });
    const copy = this.share.querySelector<HTMLButtonElement>('[data-act=copy]')!;
    if (!('ClipboardItem' in window)) copy.hidden = true;
    copy.addEventListener('click', () => {
      out.toBlob(async (blob) => {
        if (!blob) return;
        const label = copy.querySelector('.label')!;
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          label.textContent = 'Copied';
          copy.classList.add('done');
        } catch {
          label.textContent = 'Copy failed';
        }
      });
    });
    this.share.showModal();
  }

  /** Snapshot day helper for other UI. */
  snapshot(): Snapshot | undefined {
    return this.timeline?.snapshots[this.index];
  }
}
