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
import { HOME_TIERS } from './game/catalog.ts';
import { drawMark } from './ui/brand.ts';
import { afterFrames, bootError, hideBoot, narrateBoot } from './ui/loader.ts';
import { setThumbnailContext } from './ui/thumbnails.ts';

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
    setThumbnailContext(name, this.seed);
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
    // Lift the boot screen once the world has drawn its first few frames.
    afterFrames(3, () => hideBoot());

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
    const g = this.game;
    const day = this.index + 1;
    const date = new Date(s.t).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    const tier = HOME_TIERS[g.home.tier]!;
    const home = tier.options.find((o) => o.id === g.home.option)?.name ?? tier.options[0]!.name;

    /** A postcard: the city framed on warm sand, the mark, the name, the day and a few numbers. */
    const compose = (src: HTMLCanvasElement, withMetrics: boolean) => {
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
      const ink = '#1b2236';
      const ink3 = '#7c7f8e';
      const display = '"Bricolage Grotesque", Geist, system-ui, sans-serif';
      const ui = 'Geist, system-ui, sans-serif';

      // Paper
      const paper = ctx.createLinearGradient(0, 0, 0, OH);
      paper.addColorStop(0, '#fbf5ea');
      paper.addColorStop(1, '#f1e6d2');
      ctx.fillStyle = paper;
      ctx.fillRect(0, 0, OW, OH);
      ctx.strokeStyle = 'rgba(27,34,54,0.10)';
      ctx.lineWidth = 2 * K;
      ctx.strokeRect(16 * K, 16 * K, OW - 32 * K, OH - 32 * K);

      // The picture, cropped to the chosen aspect, with a soft shadow.
      let sw = src.width;
      let sh = src.height;
      if (sw / sh > aspect) sw = sh * aspect;
      else sh = sw / aspect;
      const r = 20 * K;
      ctx.save();
      ctx.shadowColor = 'rgba(27,34,54,0.28)';
      ctx.shadowBlur = 36 * K;
      ctx.shadowOffsetY = 14 * K;
      ctx.fillStyle = '#cfe4f4';
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
      vg.addColorStop(0, 'rgba(27,34,54,0)');
      vg.addColorStop(1, 'rgba(27,34,54,0.16)');
      ctx.fillStyle = vg;
      ctx.fillRect(pad, pad, iw, ih);
      ctx.restore();
      ctx.strokeStyle = 'rgba(27,34,54,0.12)';
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
      ctx.shadowColor = 'rgba(27,34,54,0.22)';
      ctx.shadowBlur = 18 * K;
      ctx.shadowOffsetY = 6 * K;
      ctx.fillStyle = 'rgba(253,249,242,0.96)';
      ctx.beginPath();
      ctx.roundRect(sx, sy, 16 * K + 40 * K + 12 * K + ww + 22 * K, sH, sH / 2);
      ctx.fill();
      ctx.restore();
      drawMark(ctx, sx + 12 * K, sy + 9 * K, 42 * K);
      ctx.fillStyle = ink;
      ctx.textBaseline = 'middle';
      ctx.fillText(word, sx + 16 * K + 40 * K + 10 * K, sy + sH / 2 + 1 * K);

      // Caption: city name and the day.
      const by = pad + ih;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.fillStyle = ink;
      ctx.font = `800 ${50 * K}px ${display}`;
      ctx.fillText(t.name, pad + 4 * K, by + 86 * K);
      ctx.font = `500 ${23 * K}px ${ui}`;
      ctx.fillStyle = ink3;
      ctx.fillText(`Day ${day.toLocaleString('en-US')} · ${date}`, pad + 6 * K, by + 124 * K);

      // Stats on the right, as little cards.
      const stats: [string, string][] = withMetrics
        ? [
            ['MRR', formatMoney(s.mrr, t.currency)],
            ['Customers', s.customers.toLocaleString('en-US')],
            ['Releases', s.releases.toLocaleString('en-US')],
          ]
        : [
            ['Satisfaction', `${g.satisfaction.score}/100`],
            ['Built', `${g.owned.length}`],
            ['Home', home],
          ];
      let x = OW - pad;
      const ch = 84 * K;
      const cy = by + 34 * K;
      for (const [label, value] of [...stats].reverse()) {
        ctx.font = `750 ${30 * K}px ${display}`;
        const vw = ctx.measureText(value).width;
        ctx.font = `600 ${14 * K}px ${ui}`;
        const lw = ctx.measureText(label.toUpperCase()).width * 1.1;
        const cw = Math.max(vw, lw) + 40 * K;
        x -= cw;
        ctx.fillStyle = 'rgba(253,249,242,0.9)';
        ctx.strokeStyle = 'rgba(27,34,54,0.10)';
        ctx.lineWidth = 1.5 * K;
        ctx.beginPath();
        ctx.roundRect(x, cy, cw, ch, 16 * K);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = ink3;
        ctx.font = `600 ${14 * K}px ${ui}`;
        ctx.letterSpacing = `${1.4 * K}px`;
        ctx.fillText(label.toUpperCase(), x + 20 * K, cy + 32 * K);
        ctx.letterSpacing = '0px';
        ctx.fillStyle = label === 'MRR' || label === 'Satisfaction' ? '#e5512b' : ink;
        ctx.font = `750 ${30 * K}px ${display}`;
        ctx.fillText(value, x + 20 * K, cy + 66 * K);
        x -= 12 * K;
      }
      return out;
    };
    const slug = t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'city';
    this.hud.openShare(frame, compose, `tinytown-${slug}-day-${day}.png`);
  }
}

narrateBoot();
loadTimeline()
  .then(({ timeline, notice }) => new App(timeline, notice))
  .catch((err: unknown) => {
    console.error(err);
    const gl = (() => {
      try {
        return !!document.createElement('canvas').getContext('webgl2');
      } catch {
        return false;
      }
    })();
    bootError(gl ? "Your city couldn't load. Try reloading the page." : 'TinyTown needs WebGL 2, which this browser has turned off.');
  });
