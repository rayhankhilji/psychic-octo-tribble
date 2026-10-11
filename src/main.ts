import './ui/styles.css';
import { demoTimeline } from './data/demo.ts';
import { formatMoney, type Timeline } from './data/types.ts';
import { describe, diffMoments, type Moment } from './world/events.ts';
import { momentsOf } from './world/history.ts';
import { planWorld } from './world/layout.ts';
import { hash } from './world/rng.ts';
import { parseHour } from './world/daylight.ts';
import { City } from './render/city.ts';
import { Stage } from './render/stage.ts';
import { Hud } from './ui/hud.ts';
import { GameUI } from './ui/game-ui.ts';
import { DAY } from './data/types.ts';
import type { Item } from './game/catalog.ts';
import { demoActions } from './game/demo-script.ts';
import { describeGame, diffGame, freePlots, money, simulate, type Action, type GameState, type SimOptions } from './game/economy.ts';
import { clearActions, joinedAt, loadActions, saveActions } from './game/save.ts';

const SPEEDS = [
  { label: '1×', daysPerSecond: 12 },
  { label: '3×', daysPerSecond: 36 },
  { label: '½×', daysPerSecond: 4 },
];
const POLL_MS = 60_000;
const NAME_KEY = 'tinytown:name';

const params = new URLSearchParams(location.search);

/** Click-through previews for the clock chip; null = follow the local clock. */
const TIME_PREVIEWS: { label: string; hour: number }[] = [
  { label: 'Morning', hour: 8.5 },
  { label: 'Midday', hour: 13 },
  { label: 'Golden hour', hour: 18.5 },
  { label: 'Night', hour: 22.5 },
];

function storedName(): string | null {
  try {
    return localStorage.getItem(NAME_KEY);
  } catch {
    return null;
  }
}

/** Live data from the server if it's configured, else the demo, with a note when live data failed. */
async function loadTimeline(): Promise<{ timeline: Timeline; notice?: string }> {
  if (params.has('demo')) return { timeline: demoTimeline({ boost: Number(params.get('boost')) || 1 }) };
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

const BACK_PAY_DAYS = 90;

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
  private preview: { label: string; hour: number } | null = null;
  private clockTimer = 0;
  private game!: GameState;
  private gameUI: GameUI;
  private actions: Action[] = [];
  private saveKey = '';
  private sim: SimOptions = {};
  private placing: Item | null = null;

  constructor(timeline: Timeline, notice?: string) {
    const name = storedName() || timeline.name;
    this.seed = hash(name);
    this.city = new City(name, this.seed);
    const fixed = parseHour(params.get('time'));
    if (fixed !== null) {
      this.city.targetHour = fixed;
      this.preview = { label: params.get('time')!, hour: fixed };
    }
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
      onCycleTime: () => {
        const i = this.preview ? TIME_PREVIEWS.findIndex((p) => p.label === this.preview!.label) : -1;
        this.preview = i + 1 < TIME_PREVIEWS.length ? TIME_PREVIEWS[i + 1]! : null;
        this.city.targetHour = this.preview?.hour ?? null;
        this.refreshClock();
      },
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
    this.gameUI = new GameUI(document.getElementById('ui')!, this.hud.sideEl, this.hud.toolsEl, {
      onBuild: (item, plot) => this.startBuild(item, plot),
      onPickHome: (tier, choice) => this.act({ t: this.today, kind: 'home', tier, choice }),
      onFlyToMoon: () => {
        this.stage.focus(this.city.focusOf('launchpad'), 1.6);
        const ok = this.city.launchRocket(() => this.hud.feed('game.moon', 'Back from your moon house. Worth every penny.', this.today));
        if (ok) this.hud.feed('game.moon', 'Lift-off! Flying to your house on the moon', this.today);
      },
      onZoom: (f) => this.stage.zoomBy(f),
      onCancelPlacement: () => this.setPlacing(null),
      onFocus: (what) => this.stage.focus(this.city.focusOf(what), 2.2),
    });
    this.stage.onPick = (pick) => {
      if (this.placing) {
        if (pick?.plot) this.build(this.placing, pick.plot);
        return;
      }
      if (pick?.plot) this.gameUI.toggleBuild(pick.plot);
    };
    this.stage.onHover = (tip, x, y) => this.hud.showTip(tip, x, y);
    this.stage.onFrame = (dt) => {
      this.tick(dt);
      this.clockTimer -= dt;
      if (this.clockTimer <= 0) {
        this.clockTimer = 0.25;
        this.refreshClock();
      }
    };

    this.load({ ...timeline, name });
    this.saveKey = timeline.source === 'demo' ? 'demo' : String(this.seed);
    this.actions = loadActions(this.saveKey) ?? (timeline.source === 'demo' ? demoActions(timeline.snapshots) : []);
    if (timeline.source === 'live') {
      const joined = joinedAt(this.saveKey, timeline.snapshots.at(-1)?.t ?? Date.now());
      this.sim = { incomeFrom: joined - BACK_PAY_DAYS * DAY };
    }
    if (params.has('fresh')) {
      clearActions(this.saveKey);
      this.actions = timeline.source === 'demo' ? demoActions(timeline.snapshots) : [];
    }
    if (notice) this.hud.notice(notice);
    // Demo opens with the story from day one; a live world opens on today.
    if (timeline.source === 'demo' || params.has('replay')) this.replay();
    else this.show(this.last, false);
    this.stage.start();
    this.refreshClock();

    if (timeline.source === 'live') window.setInterval(() => this.poll(), POLL_MS);
  }

  private refreshClock() {
    const a = this.city.atmosphere;
    this.hud.setClock(this.preview ? this.preview.hour : a.hour, a.phase, this.preview?.label ?? null);
  }

  private get last() {
    return this.moments.length - 1;
  }

  private load(t: Timeline) {
    this.timeline = t;
    this.moments = momentsOf(t);
    this.hud.setTimeline(t);
  }

  /** Homes are drawn for the users your city can house. */
  private plan(i: number, game: GameState) {
    const m = this.moments[i]!;
    return planWorld({ ...m.snapshot, customers: game.housed }, { peakMrr: m.peakMrr, weather: m.weather, seed: this.seed });
  }

  private get today(): number {
    return this.moments[this.index]!.snapshot.t;
  }

  // ─── Building ──────────────────────────────────────────────────────────

  private startBuild(item: Item, plot?: string) {
    if (plot || item.placement.kind !== 'plot') return this.build(item, plot);
    const free = freePlots(this.game, item.placement.size);
    const ids = item.placement.size === 4 ? free.flatMap((p) => this.game.plots.filter((q) => q.block === p.block).map((q) => q.id)) : free.map((p) => p.id);
    this.setPlacing(item, ids);
  }

  private setPlacing(item: Item | null, plots: string[] = []) {
    this.placing = item;
    this.city.setPlacement(item ? plots : null);
    this.gameUI.setPlacing(item);
  }

  private build(item: Item, plot?: string) {
    this.setPlacing(null);
    this.act({ t: this.today, kind: 'build', item: item.id, ...(plot ? { plot } : {}) });
    if (item.placement.kind === 'site') this.stage.focus(this.city.focusOf(item.placement.site), 2.2);
  }

  /** Record a choice at today's date and show its effect straight away. */
  private act(action: Action) {
    const next = [...this.actions, action];
    const result = simulate(this.timeline.snapshots, next, this.index, this.sim);
    const failed = result.rejected.find((r) => r.action === action);
    if (failed) {
      this.hud.feed('game.error', `Couldn't do that: ${failed.reason}`, this.today);
      return;
    }
    this.actions = next;
    saveActions(this.saveKey, this.actions);
    if (action.kind === 'build') {
      this.hud.feed('game.build', `Bought for ${money(this.game.treasury - result.treasury)}`, this.today);
    }
    this.show(this.index, true, true);
  }

  /** Jump to a day. `animate` = arrive as if time passed (pop-ins, celebrations). */
  private show(i: number, animate: boolean, sameDay = false) {
    i = Math.max(0, Math.min(this.last, i));
    const prev = this.index;
    this.index = i;
    const prevGame = this.game;
    const game = (this.game = simulate(this.timeline.snapshots, this.actions, i, this.sim));
    const plan = this.plan(i, game);
    this.city.setWorld(plan, game, animate);
    this.gameUI.setState(game);
    if (prevGame && animate && (i === prev + 1 || sameDay)) {
      const events = diffGame(prevGame, game);
      this.city.celebrateGame(events);
      for (const e of events) this.hud.feed(`game.${e.type}`, describeGame(e), game.t);
    }
    const m = this.moments[i]!;
    const weekAgo = this.moments[Math.max(0, i - 7)]!;
    this.city.setShippingPace(m.snapshot.commits - weekAgo.snapshot.commits);
    this.hud.setIndex(i);

    if (animate && i === prev + 1 && !sameDay) {
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
        : `${day} · satisfaction ${this.game.satisfaction.score} · ${this.game.owned.length} things built`;
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
