import { formatMoney, type Snapshot, type Timeline } from '../data/types.ts';
import type { DistrictPlan } from '../world/layout.ts';
import type { Tip } from '../render/city.ts';

const ICONS = {
  play: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5v11l9-5.5z"/></svg>',
  pause: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="3.5" y="2.5" width="3" height="11" rx="1"/><rect x="9.5" y="2.5" width="3" height="11" rx="1"/></svg>',
  rotate: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.5v3h-3"/></svg>',
  home: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M2.5 7.5 8 3l5.5 4.5V13h-11z"/></svg>',
  share: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10V2.5M5 5.5l3-3 3 3"/><path d="M3 9v4h10V9"/></svg>',
  plug: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3"/></svg>',
  replay: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 8a5 5 0 1 0 1.6-3.7"/><path d="M3 2.5v3h3"/></svg>',
};

const CLOCK_ICONS = {
  sun: '<svg viewBox="0 0 16 16" fill="none" stroke="#ffc24a" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="3" fill="#ffc24a"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/></svg>',
  set: '<svg viewBox="0 0 16 16" fill="none" stroke="#ff8a4a" stroke-width="1.5" stroke-linecap="round"><path d="M4 11a4 4 0 0 1 8 0" fill="#ff8a4a"/><path d="M1.5 11h13M3 13.5h10M8 3v2M3.2 5.6l1.2 1M12.8 5.6l-1.2 1"/></svg>',
  moon: '<svg viewBox="0 0 16 16"><path d="M10.5 2a6 6 0 1 0 3.5 10.7A5 5 0 0 1 10.5 2z" fill="#c9d4ff"/></svg>',
};

const LEGEND_ICONS = {
  home: '<svg viewBox="0 0 16 16"><path d="M3 8 8 4l5 4v5H3z" fill="#d8c3a0"/><path d="M2 8.5 8 3.5l6 5" stroke="#6a3e3c" stroke-width="1.8" fill="none"/><rect x="6" y="9" width="2" height="2" fill="#ffb347"/></svg>',
  district: '<svg viewBox="0 0 16 16"><rect x="3" y="4" width="4" height="10" fill="#353c5e"/><rect x="8" y="1.5" width="5" height="12.5" fill="#2b3150"/><rect x="8" y="3" width="5" height="1" fill="#ff3fa4"/><rect x="4" y="6" width="1" height="1" fill="#ffb347"/><rect x="10" y="6" width="1" height="1" fill="#4ff2ff"/><rect x="10" y="9" width="1" height="1" fill="#4ff2ff"/></svg>',
  hq: '<svg viewBox="0 0 16 16"><rect x="5" y="4" width="6" height="11" fill="#2c3558"/><path d="M5 6h6M5 8h6M5 10h6M5 12h6" stroke="#ffc870" stroke-width=".9"/><circle cx="8" cy="2" r="1.4" fill="#6ff2ff"/></svg>',
  train: '<svg viewBox="0 0 16 16"><rect x="1.5" y="6" width="13" height="5" rx="1.5" fill="#d8dbe8"/><rect x="1.5" y="6" width="13" height="1" fill="#ff4fd8"/><path d="M3.5 8.5h2M7 8.5h2M10.5 8.5h2" stroke="#ffb347" stroke-width="1.2"/></svg>',
  rain: '<svg viewBox="0 0 16 16" stroke="#9fb8e8" stroke-width="1.3" stroke-linecap="round"><path d="M4 3 3 6M8 2 7 5M12 3l-1 3M5 8 4 11M9 8l-1 3M12 9l-1 3M6 12l-.6 2"/></svg>',
  dark: '<svg viewBox="0 0 16 16"><rect x="4" y="2" width="8" height="12" fill="#232842"/><rect x="6" y="4" width="1.4" height="1.4" fill="#141a2c"/><rect x="9" y="4" width="1.4" height="1.4" fill="#141a2c"/><rect x="6" y="7" width="1.4" height="1.4" fill="#141a2c"/><rect x="9" y="10" width="1.4" height="1.4" fill="#141a2c"/></svg>',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.innerHTML = html;
  return e;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

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

export class Hud {
  private brandName: HTMLElement;
  private brandSub: HTMLElement;
  private metricValues = new Map<string, { value: HTMLElement; delta: HTMLElement }>();
  private milestonesEl: HTMLElement;
  private feedEl: HTMLElement;
  private clockBtn: HTMLButtonElement;
  private noticeEl: HTMLElement;
  private dateEl: HTMLElement;
  private scrub: HTMLInputElement;
  private spark: HTMLCanvasElement;
  private playBtn: HTMLButtonElement;
  private speedBtn: HTMLButtonElement;
  private tip: HTMLElement;
  private connect: HTMLDialogElement;
  private share: HTMLDialogElement;
  private timeline: Timeline | null = null;
  private h: HudHandlers;

  constructor(root: HTMLElement, h: HudHandlers) {
    this.h = h;
    // Top bar
    const top = el('div', { class: 'topbar' });
    const brand = el(
      'div',
      { class: 'brand panel' },
      `<svg class="brand-mark" viewBox="0 0 32 32"><path d="M16 6 27 12.5 16 19 5 12.5Z" fill="#2a4a33"/><path d="M5 12.5 16 19v7L5 19.5Z" fill="#1d1512"/><path d="M27 12.5 16 19v7l11-6.5Z" fill="#2e211b"/><path d="M13 9.5h4v6l-2 1.2-2-1.2Z" fill="#ffb347"/><path d="M18 8h3v8.5l-1.5.9-1.5-.9Z" fill="#ff3fa4"/></svg>
       <div><div class="brand-name"></div><div class="brand-sub"></div></div>`,
    );
    this.brandName = brand.querySelector('.brand-name')!;
    this.brandSub = brand.querySelector('.brand-sub')!;
    const tools = el('div', { class: 'toolbar panel' });
    tools.append(
      this.button(`${ICONS.rotate}`, 'Rotate (Q / E)', () => h.onRotate(), 'icon'),
      this.button(`${ICONS.home}`, 'Reset view', () => h.onResetView(), 'icon'),
      this.button(`${ICONS.plug}<span class="label">Connect</span>`, 'Connect your startup', () => this.connect.showModal()),
      this.button(`${ICONS.share}<span class="label">Share</span>`, 'Share a snapshot', () => h.onShare(), 'primary'),
    );
    this.clockBtn = this.button('', 'Time of day: follows your local clock. Click to preview other times.', () => h.onCycleTime(), 'clock');
    const clock = el('div', { class: 'clock-wrap panel' });
    clock.append(this.clockBtn);
    top.append(brand, clock, tools);

    // Metrics (real numbers, always)
    const side = el('div', { class: 'side' });
    const metrics = el('div', { class: 'metrics panel' }, `<div class="eyebrow"><span>Real metrics</span><span class="as-of"></span></div><div class="metric-list"></div>`);
    const list = metrics.querySelector('.metric-list')!;
    for (const [key, label] of [['customers', 'Customers'], ['mrr', 'MRR'], ['releases', 'Releases'], ['commits', 'Commits']] as const) {
      const row = el('div', { class: 'metric' }, `<span class="metric-label">${label}</span><span><span class="metric-value">–</span><span class="metric-delta"></span></span>`);
      this.metricValues.set(key, { value: row.querySelector('.metric-value')!, delta: row.querySelector('.metric-delta')! });
      list.append(row);
    }
    metrics.append(el('div', { class: 'honesty' }, 'The city is an illustration of these numbers. It never invents progress: every home, tower and raindrop maps to the data above.'));
    side.append(metrics);

    // Legend
    const legend = el('details', { class: 'legend panel' });
    legend.innerHTML = `
      <summary><div class="eyebrow"><span>How to read your city</span><span>▾</span></div></summary>
      <ul>
        <li><span class="swatch">${LEGEND_ICONS.home}</span><span><b>A home</b> for every paying customer. Ten homes make a neighbourhood. <span class="rph"></span></span></li>
        <li><span class="swatch">${LEGEND_ICONS.district}</span><span><b>Districts</b> open at MRR milestones:<span class="milestones"></span></span></li>
        <li><span class="swatch">${LEGEND_ICONS.hq}</span><span><b>HQ</b> gains a floor for each GitHub release. The beacon flares on every push.</span></li>
        <li><span class="swatch">${LEGEND_ICONS.train}</span><span><b>The train</b> runs faster the more you shipped this week.</span></li>
        <li><span class="swatch">${LEGEND_ICONS.rain}</span><span><b>Rain</b> starts when MRR falls more than 1% in a week, and clears when the week is back to flat or up.</span></li>
        <li><span class="swatch">${LEGEND_ICONS.dark}</span><span><b>A district dark after sunset</b>: MRR has slipped below its milestone.</span></li>
      </ul>`;
    this.milestonesEl = legend.querySelector('.milestones')!;

    this.feedEl = el('div', { class: 'feed', 'aria-live': 'polite' });
    this.noticeEl = el('div', { class: 'notices' });

    // Timeline
    const tl = el('div', { class: 'timeline panel' });
    this.playBtn = this.button(ICONS.play, 'Play / pause (space)', () => h.onTogglePlay(), 'icon');
    this.dateEl = el('div', { class: 'timeline-date' });
    const scrubWrap = el('div', { class: 'scrub' });
    this.spark = el('canvas');
    this.scrub = el('input', { type: 'range', min: '0', max: '0', value: '0', 'aria-label': 'Timeline' });
    this.scrub.addEventListener('input', () => h.onSeek(Number(this.scrub.value)));
    scrubWrap.append(this.spark, this.scrub);
    this.speedBtn = this.button('1×', 'Playback speed', () => h.onSpeed(), 'speed');
    tl.append(this.playBtn, this.dateEl, scrubWrap, this.speedBtn, this.button(`${ICONS.replay}<span class="label">Replay</span>`, 'Replay from day one', () => h.onReplay()));

    this.tip = el('div', { class: 'tip panel', hidden: '' }, '<div class="tip-title"></div><div class="tip-detail"></div>');

    this.connect = this.connectDialog();
    this.share = el('dialog');

    const left = el('div', { class: 'left' });
    side.append(this.noticeEl);
    left.append(side, this.feedEl);
    root.append(top, left, legend, tl);
    document.body.append(this.tip, this.connect, this.share);

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
      if (e.code === 'Space') {
        e.preventDefault();
        h.onTogglePlay();
      }
    });
    new ResizeObserver(() => this.drawSpark()).observe(scrubWrap);
  }

  private button(html: string, title: string, onClick: () => void, cls = ''): HTMLButtonElement {
    const b = el('button', { class: `btn ${cls}`, title, 'aria-label': title, type: 'button' }, html);
    b.addEventListener('click', onClick);
    return b;
  }

  setTimeline(t: Timeline) {
    this.timeline = t;
    this.brandName.textContent = t.name;
    const live = t.source === 'live';
    const sources = [t.integrations.stripe && 'Stripe', t.integrations.github && 'GitHub'].filter(Boolean).join(' + ');
    this.brandSub.innerHTML = `<span class="source-pill ${live ? 'live' : ''}">${live ? `Live · ${escape(sources)}` : 'Demo world · fictional startup'}</span>`;
    this.scrub.max = String(Math.max(0, t.snapshots.length - 1));
    this.drawSpark();
    this.renderConnect();
  }

  setIndex(i: number) {
    const t = this.timeline;
    if (!t) return;
    const s = t.snapshots[i];
    if (!s) return;
    this.scrub.value = String(i);
    const date = new Date(s.t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    this.dateEl.innerHTML = `${date}<small>Day ${(i + 1).toLocaleString('en-US')} of ${t.snapshots.length.toLocaleString('en-US')}</small>`;

    const week = t.snapshots[Math.max(0, i - 7)]!;
    const fmt = (key: keyof Snapshot, v: number) => (key === 'mrr' ? formatMoney(v, t.currency) : v.toLocaleString('en-US'));
    for (const key of ['customers', 'mrr', 'releases', 'commits'] as const) {
      const m = this.metricValues.get(key)!;
      const has = key === 'mrr' || key === 'customers' ? t.integrations.stripe || t.source === 'demo' : t.integrations.github || t.source === 'demo';
      m.value.textContent = has ? fmt(key, s[key]) : '—';
      const d = s[key] - week[key];
      m.delta.textContent = has && d !== 0 ? `${d > 0 ? '+' : '−'}${fmt(key, Math.abs(d))} 7d` : '';
      m.delta.className = `metric-delta ${key === 'commits' || key === 'releases' ? '' : d > 0 ? 'up' : d < 0 ? 'down' : ''}`;
    }
  }

  setPlan(districts: DistrictPlan[], residentsPerHome: number) {
    this.milestonesEl.innerHTML = districts
      .map((d) => `<span class="milestone ${d.unlocked ? 'done' : ''}" style="${d.unlocked ? `color:#${d.neon.toString(16).padStart(6, '0')}` : ''}" title="${escape(d.name)}">${shortMoney(d.threshold)}</span>`)
      .join('');
    const rph = document.querySelector('.legend .rph');
    if (rph) rph.textContent = residentsPerHome > 1 ? `Your town is full, so each home now houses ${residentsPerHome} customers.` : '';
  }

  /** Shows the world's time of day; `preview` is the label when not following the local clock. */
  setClock(hour: number, phase: string, preview: string | null) {
    const h = Math.floor(hour);
    const m = Math.floor((hour - h) * 60);
    const time = new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const icon = phase === 'night' || phase === 'dusk' ? CLOCK_ICONS.moon : phase === 'evening' || phase === 'dawn' ? CLOCK_ICONS.set : CLOCK_ICONS.sun;
    const label = phase[0]!.toUpperCase() + phase.slice(1);
    const html = `${icon}<span class="clock-text"><b>${time}</b><small>${preview ? `Preview · ${preview}` : `${label} · local time`}</small></span>`;
    if (this.clockBtn.innerHTML !== html) this.clockBtn.innerHTML = html;
  }

  setPlaying(playing: boolean) {
    this.playBtn.innerHTML = playing ? ICONS.pause : ICONS.play;
  }

  setSpeed(label: string) {
    this.speedBtn.textContent = label;
  }

  /** Adds a line to the event feed; repeated kinds collapse into the latest line. */
  feed(kind: string, text: string, t: number) {
    const date = new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const last = this.feedEl.firstElementChild as HTMLElement | null;
    if (last && last.dataset.kind === kind && !last.classList.contains('out') && Date.now() - Number(last.dataset.at) < 1800) {
      last.querySelector('.toast-text')!.textContent = text;
      last.querySelector('.toast-date')!.textContent = date;
      this.expire(last);
      return;
    }
    const toast = el('div', { class: `toast panel ${kind.split('.').pop()}` }, `<span class="toast-dot"></span><span class="toast-text"></span><span class="toast-date"></span>`);
    toast.dataset.kind = kind;
    toast.querySelector('.toast-text')!.textContent = text;
    toast.querySelector('.toast-date')!.textContent = date;
    this.feedEl.prepend(toast);
    while (this.feedEl.children.length > 5) this.feedEl.lastElementChild!.remove();
    this.expire(toast);
  }

  /** A message that stays until dismissed. */
  notice(text: string) {
    const toast = el('div', { class: 'toast panel notice', role: 'status' }, `<span class="toast-dot"></span><span class="toast-text"></span>`);
    toast.querySelector('.toast-text')!.textContent = text;
    const close = this.button('×', 'Dismiss', () => toast.remove(), 'icon');
    toast.append(close);
    this.noticeEl.append(toast);
  }

  private expire(toast: HTMLElement) {
    toast.dataset.at = String(Date.now());
    clearTimeout(Number(toast.dataset.timer));
    const linger = toast.classList.contains('district') || toast.classList.contains('release') ? 7000 : 4500;
    toast.dataset.timer = String(
      window.setTimeout(() => {
        toast.classList.add('out');
        window.setTimeout(() => toast.remove(), 600);
      }, linger),
    );
  }

  clearFeed() {
    this.feedEl.innerHTML = '';
  }

  showTip(tip: Tip | null, x: number, y: number) {
    if (!tip) {
      this.tip.hidden = true;
      return;
    }
    this.tip.querySelector('.tip-title')!.textContent = tip.title;
    this.tip.querySelector('.tip-detail')!.textContent = tip.detail;
    const flip = x > window.innerWidth - 290;
    this.tip.style.left = `${flip ? x - 290 : x}px`;
    this.tip.style.top = `${y}px`;
    this.tip.hidden = false;
  }

  /** MRR sparkline behind the scrubber, with release ticks. */
  private drawSpark() {
    const t = this.timeline;
    const c = this.spark;
    const rect = c.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio);
    c.width = Math.max(1, Math.round(rect.width * dpr));
    c.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    if (!t || t.snapshots.length < 2) return;
    const s = t.snapshots;
    const useMrr = s.some((x) => x.mrr > 0);
    const values = s.map((x) => (useMrr ? x.mrr : x.commits));
    const max = Math.max(1, ...values);
    const x = (i: number) => (i / (s.length - 1)) * c.width;
    const y = (v: number) => c.height - 2 * dpr - (v / max) * (c.height - 6 * dpr);

    const grad = ctx.createLinearGradient(0, 0, 0, c.height);
    grad.addColorStop(0, 'rgba(255,179,71,0.35)');
    grad.addColorStop(1, 'rgba(255,179,71,0)');
    ctx.beginPath();
    ctx.moveTo(0, c.height);
    values.forEach((v, i) => ctx.lineTo(x(i), y(v)));
    ctx.lineTo(c.width, c.height);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    values.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.strokeStyle = 'rgba(255,179,71,0.8)';
    ctx.lineWidth = 1.2 * dpr;
    ctx.stroke();

    ctx.fillStyle = 'rgba(79,242,255,0.75)';
    s.forEach((snap, i) => {
      if (snap.release) ctx.fillRect(x(i) - 0.5 * dpr, 0, 1 * dpr, 5 * dpr);
    });
  }

  // ─── Dialogs ────────────────────────────────────────────────────────────

  private connectDialog(): HTMLDialogElement {
    const d = el('dialog');
    d.addEventListener('click', (e) => e.target === d && d.close());
    return d;
  }

  private renderConnect() {
    const t = this.timeline;
    const status = (on: boolean | undefined) => `<span class="status ${on ? 'on' : ''}">${on ? 'Connected' : 'Not connected'}</span>`;
    this.connect.innerHTML = `
      <form method="dialog" class="dialog-body">
        <h2>Connect your startup</h2>
        <p>TinyTown reads your metrics on a small server you run, so API keys never touch the browser. Add them to <code>.env</code> and restart <code>npm start</code>.</p>
        <div class="integrations">
          <div class="integration"><div>Stripe<small>Customers and MRR, with full history</small></div>${status(t?.integrations.stripe)}</div>
          <div class="integration"><div>GitHub<small>Releases and commits on the default branch</small></div>${status(t?.integrations.github)}</div>
          <div class="integration"><div>PostHog · Supabase<small>Coming next</small></div><span class="status">Planned</span></div>
        </div>
<pre>TINYTOWN_NAME=Your Startup
STRIPE_SECRET_KEY=rk_live_…   # restricted, read-only Subscriptions
GITHUB_REPO=you/your-repo
GITHUB_TOKEN=github_pat_…     # only for private repos</pre>
        <label class="field"><span>Name on the HQ sign (this browser only)</span><input name="name" maxlength="22" value="${escape(t?.name ?? '')}"></label>
        <div class="dialog-actions"><button class="btn" value="cancel">Close</button><button class="btn primary" value="save">Save name</button></div>
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
        <h2>Share your city</h2>
        <img class="share-preview" alt="Snapshot of your city">
        <label class="check"><input type="checkbox" name="metrics"> Include real numbers (customers, MRR) in the image</label>
        <p class="hint">Metrics stay private unless you tick the box.</p>
        <div class="dialog-actions">
          <button class="btn" data-act="close">Close</button>
          <button class="btn" data-act="copy">Copy image</button>
          <button class="btn primary" data-act="download">Download PNG</button>
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
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          copy.textContent = 'Copied';
        } catch {
          copy.textContent = 'Copy failed';
        }
      });
    });
    this.share.showModal();
  }
}

function shortMoney(n: number): string {
  if (n >= 1_000_000) return `$${n / 1_000_000}M`;
  if (n >= 1000) return `$${n / 1000}k`;
  return n <= 1 ? 'first $' : `$${n}`;
}
