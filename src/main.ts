import './ui/styles.css';
import { demoTimeline } from './data/demo.ts';
import { formatMoney, type Timeline } from './data/types.ts';
import { describe, diffMoments, type Moment } from './world/events.ts';
import { momentsOf } from './world/history.ts';
import { planWorld } from './world/layout.ts';
import { hash } from './world/rng.ts';
import { City } from './render/city.ts';
import { Stage } from './render/stage.ts';
import { Hud } from './ui/hud.ts';

const SPEEDS = [
  { label: '1×', daysPerSecond: 12 },
  { label: '3×', daysPerSecond: 36 },
  { label: '½×', daysPerSecond: 4 },
];
const POLL_MS = 60_000;
const NAME_KEY = 'tinytown:name';

const params = new URLSearchParams(location.search);

function storedName(): string | null {
  try {
    return localStorage.getItem(NAME_KEY);
  } catch {
    return null;
  }
}

/** Live data from the server if it's configured, else the demo, with a note when live data failed. */
async function loadTimeline(): Promise<{ timeline: Timeline; notice?: string }> {
  if (params.has('demo')) return { timeline: demoTimeline() };
  try {
    const res = await fetch('/api/timeline');
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.snapshots?.length) return { timeline: body as Timeline };
    if (res.ok) return { timeline: demoTimeline(), notice: 'Connected, but there is no history yet. Showing the demo world for now.' };
    if (res.status >= 500 && body.error) {
      return { timeline: demoTimeline(), notice: `Couldn't load your live data (${body.error}). Showing the demo world.` };
    }
  } catch {
    // No server running: demo world.
  }
  return { timeline: demoTimeline() };
}

class App {
  private timeline!: Timeline;
  private moments: Moment[] = [];
  private index = 0;
  private playing = false;
  private speed = 0;
  private carry = 0;
  private city: City;
  private stage: Stage;
  private hud: Hud;
  private seed: number;

  constructor(timeline: Timeline, notice?: string) {
    const name = storedName() || timeline.name;
    this.seed = hash(name);
    this.city = new City(name, this.seed);
    this.stage = new Stage(document.getElementById('world')!, this.city);
    this.hud = new Hud(document.getElementById('ui')!, {
      onTogglePlay: () => this.setPlaying(!this.playing),
      onSeek: (i) => {
        this.setPlaying(false);
        this.show(i, false);
      },
      onSpeed: () => {
        this.speed = (this.speed + 1) % SPEEDS.length;
        this.hud.setSpeed(SPEEDS[this.speed]!.label);
      },
      onReplay: () => this.replay(),
      onRotate: () => this.stage.rotate(1),
      onResetView: () => this.stage.resetView(),
      onShare: () => this.share(),
      onRename: (n) => {
        try {
          if (n) localStorage.setItem(NAME_KEY, n);
          else localStorage.removeItem(NAME_KEY);
        } catch {
          // Storage unavailable; the name lasts for this visit.
        }
        location.reload();
      },
    });
    this.stage.onHover = (tip, x, y) => this.hud.showTip(tip, x, y);
    this.stage.onFrame = (dt) => this.tick(dt);

    this.load({ ...timeline, name });
    if (notice) this.hud.notice(notice);
    // Demo opens with the story from day one; a live world opens on today.
    if (timeline.source === 'demo' || params.has('replay')) this.replay();
    else this.show(this.last, false);
    this.stage.start();

    if (timeline.source === 'live') window.setInterval(() => this.poll(), POLL_MS);
  }

  private get last() {
    return this.moments.length - 1;
  }

  private load(t: Timeline) {
    this.timeline = t;
    this.moments = momentsOf(t);
    this.hud.setTimeline(t);
  }

  private plan(i: number) {
    const m = this.moments[i]!;
    return planWorld(m.snapshot, { peakMrr: m.peakMrr, weather: m.weather, seed: this.seed });
  }

  /** Jump to a day. `animate` = arrive as if time passed (pop-ins, celebrations). */
  private show(i: number, animate: boolean) {
    i = Math.max(0, Math.min(this.last, i));
    const prev = this.index;
    this.index = i;
    const plan = this.plan(i);
    this.city.setPlan(plan, animate);
    const m = this.moments[i]!;
    const weekAgo = this.moments[Math.max(0, i - 7)]!;
    this.city.setShippingPace(m.snapshot.commits - weekAgo.snapshot.commits);
    this.hud.setIndex(i);
    this.hud.setPlan(plan.districts, plan.residentsPerHome);

    if (animate && i === prev + 1) {
      const events = diffMoments(this.moments[prev]!, m);
      this.city.celebrate(events);
      for (const e of events) {
        const text = describe(e, this.timeline.currency);
        if (text) this.hud.feed(e.type, text, m.snapshot.t);
      }
    }
  }

  private replay() {
    this.hud.clearFeed();
    this.show(0, false);
    this.carry = 0;
    this.setPlaying(true);
  }

  private setPlaying(on: boolean) {
    if (on && this.index >= this.last) this.show(0, false);
    this.playing = on;
    this.hud.setPlaying(on);
  }

  private tick(dt: number) {
    if (!this.playing) return;
    this.carry += dt * SPEEDS[this.speed]!.daysPerSecond;
    // Never skip days during playback so every event gets its moment.
    let steps = Math.min(4, Math.floor(this.carry));
    this.carry -= Math.floor(this.carry);
    while (steps-- > 0 && this.index < this.last) this.show(this.index + 1, true);
    if (this.index >= this.last) this.setPlaying(false);
  }

  private async poll() {
    try {
      const res = await fetch('/api/timeline');
      if (!res.ok) return;
      const t = (await res.json()) as Timeline;
      const following = this.index >= this.last && !this.playing;
      this.load({ ...t, name: this.timeline.name });
      // If we were watching "today", walk forward through anything new.
      if (following) {
        this.playing = this.index < this.last;
        this.hud.setPlaying(this.playing);
      } else {
        this.hud.setIndex(this.index);
      }
    } catch {
      // Try again next interval.
    }
  }

  private share() {
    const frame = this.stage.capture();
    const s = this.moments[this.index]!.snapshot;
    const t = this.timeline;
    const compose = (src: HTMLCanvasElement, withMetrics: boolean) => {
      const out = document.createElement('canvas');
      out.width = src.width;
      out.height = src.height;
      const ctx = out.getContext('2d')!;
      ctx.drawImage(src, 0, 0);
      const k = out.width / 1200;
      const pad = 28 * k;
      const grad = ctx.createLinearGradient(0, out.height - 160 * k, 0, out.height);
      grad.addColorStop(0, 'rgba(5,8,26,0)');
      grad.addColorStop(1, 'rgba(5,8,26,0.85)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, out.height - 160 * k, out.width, 160 * k);
      ctx.fillStyle = '#eef0ff';
      ctx.font = `700 ${42 * k}px "Space Grotesk", system-ui, sans-serif`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(t.name, pad, out.height - pad - 36 * k);
      ctx.font = `${21 * k}px "Space Grotesk", system-ui, sans-serif`;
      ctx.fillStyle = '#a6abd0';
      const day = `Day ${this.index + 1}`;
      const line = withMetrics
        ? `${day} · ${s.customers.toLocaleString('en-US')} customers · ${formatMoney(s.mrr, t.currency)} MRR · ${s.releases} releases`
        : `${day} · ${this.plan(this.index).neighbourhoods.length} neighbourhoods and counting`;
      ctx.fillText(line, pad, out.height - pad);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#ffb347';
      ctx.fillText('made with TinyTown', out.width - pad, out.height - pad);
      return out;
    };
    const slug = t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'city';
    this.hud.openShare(frame, compose, `tinytown-${slug}-day-${this.index + 1}.png`);
  }
}

loadTimeline().then(({ timeline, notice }) => new App(timeline, notice));
