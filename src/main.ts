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
import { clearActions, joinedAt, lastSeen, loadActions, markSeen, saveActions } from './game/save.ts';
import { awaySummary, snapshotIndexAt } from './game/away.ts';
import { HOME_TIERS } from './game/catalog.ts';
import { composePostcard } from './ui/postcard.ts';
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
      onFlyHelicopter: () => {
        const ok = this.city.flyHelicopter((at) => {
          this.gameUI.setHelicopter(at);
          this.hud.feed('game.heli', at === 'island' ? 'Touched down on your island' : 'Back on the pad at the airport', this.today);
          // Hold the shot on the pad for a moment while the rotor winds down.
          setTimeout(() => this.stage.stopFollowing(), 1500);
        });
        if (!ok) return;
        this.stage.follow(this.city.helicopterAt, 1.8);
        this.hud.feed('game.heli', this.city.helicopterPad === 'airport' ? 'Wheels up from the airport, off to your island' : 'Leaving the island for the airport', this.today);
      },
      onZoom: (f) => this.stage.zoomBy(f),
      onCancelPlacement: () => this.setPlacing(null),
      // Each place framed whole: the airport and downtown are big, the wharf is close.
      onFocus: (what) => this.stage.focus(this.city.focusOf(what), { downtown: 1.3, hills: 1.5, pier: 2.2, marina: 2.2, airport: 1.4, island: 1.7, launchpad: 2 }[what]),
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
    // `?away=N` previews the welcome-back card as if you last looked N days ago.
    if ((timeline.source === 'demo' && !params.has('away')) || params.has('replay')) this.replay();
    else this.show(this.last, false);
    this.stage.start();
    this.refreshClock();
    // Lift the boot screen once the world has drawn its first few frames, then say what changed.
    afterFrames(3, () => {
      hideBoot();
      this.welcomeBack();
    });

    if (timeline.source === 'live') window.setInterval(() => this.poll(), POLL_MS);
  }

  /** "While you were away": what happened since this browser last showed the city. */
  private welcomeBack() {
    const snaps = this.timeline.snapshots;
    const now = snaps.length - 1;
    const forced = Number(params.get('away'));
    const preview = params.has('away') && forced > 0;
    if (now < 1 || (this.timeline.source === 'demo' && !preview)) return;
    const seen = preview ? snaps[Math.max(0, now - forced)]!.t : lastSeen(this.saveKey);
    if (!preview) markSeen(this.saveKey, snaps[now]!.t);
    if (seen === null) return;
    const from = snapshotIndexAt(snaps, seen);
    if (from < 0 || from >= now) return;
    const before = simulate(snaps, this.actions, from, this.sim);
    const summary = awaySummary(before, this.game, snaps[from]!, snaps[now]!);
    if (summary) this.hud.showAway(summary);
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
    this.stage.active = on;
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

    /** A postcard of the city: day or night to match the world, real numbers only when asked. */
    const compose = (src: HTMLCanvasElement, withMetrics: boolean) =>
      composePostcard(src, {
        name: t.name,
        caption: `Day ${day.toLocaleString('en-US')} · ${date}`,
        stats: withMetrics
          ? [
              ['MRR', formatMoney(s.mrr, t.currency), true],
              ['Customers', s.customers.toLocaleString('en-US')],
              ['Releases', s.releases.toLocaleString('en-US')],
            ]
          : [
              ['Satisfaction', `${g.satisfaction.score}/100`, true],
              ['Built', `${g.owned.length}`],
              ['Home', home],
            ],
      });
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
