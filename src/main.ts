import './ui/styles.css';
import { demoTimeline } from './data/demo.ts';
import { formatMoney, type Timeline } from './data/types.ts';
import { describe, diffMoments, type Moment } from './world/events.ts';
import { momentsOf } from './world/history.ts';
import { planWorld } from './world/layout.ts';
import { hash } from './world/rng.ts';
import { setWorldSeed } from './world/seed.ts';
import { parseHour } from './world/daylight.ts';
import { City } from './render/city.ts';
import { Stage } from './render/stage.ts';
import { Hud } from './ui/hud.ts';
import { GameUI } from './ui/game-ui.ts';
import { DAY } from './data/types.ts';
import { ITEMS, type Item } from './game/catalog.ts';
import { demoActions } from './game/demo-script.ts';
import { describeGame, diffGame, freePlots, money, simulate, type Action, type GameState, type SimOptions } from './game/economy.ts';
import { clearActions, joinedAt, lastSeen, loadActions, markSeen, saveActions } from './game/save.ts';
import { awaySummary, snapshotIndexAt } from './game/away.ts';
import { HOME_TIERS } from './game/catalog.ts';
import { composePostcard } from './ui/postcard.ts';
import type { ClipHost } from './ui/recap.ts';
import { afterFrames, bootFailure, hasWebGL2, hideBoot, narrateBoot, whenBooted } from './ui/loader.ts';
import { measurePerf, reportWebGL, setTelemetry, startTelemetry } from './telemetry.ts';
import { setThumbnailContext } from './ui/thumbnails.ts';
import { Api, ApiRequestError } from './api/client.ts';
import type { AuthProvider } from './api/auth.ts';
import { cleanSearch, decideBoot, decideOpening, readReturn, type BootScreen } from './api/boot.ts';
import { BACK_PAY_DAYS, isPaid, simOptionsFor, type ConfigResponse, type MeResponse, type WorldInfo } from './api/contract.ts';
import { formatPrice, priceSheet } from './api/pricing.ts';
import { FrontDoor, frontDoorInset, frontDoorSeen, holdHud, releaseHud, wantsFrontDoor } from './ui/frontdoor.ts';

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

/** The founder's own city, saved on the server. */
interface HostedWorld {
  api: Api;
  world: WorldInfo;
  actions: Action[];
}

interface AppOptions {
  timeline: Timeline;
  notice?: string;
  /** The map layout (see src/world/seed.ts). */
  seed: number;
  /** Signed in and paid: saves go to the server, which re-checks every action. */
  hosted?: HostedWorld;
  /** Hosted accounts are on: the city name and "Connect" open the account flow instead of the `.env` help. */
  accounts?: boolean;
  /** The front door is up: open on the grown city (the last day), the camera drifting, until `enter()`. */
  intro?: boolean;
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
  private seed: number;
  private preview: { label: string; hour: number } | null = null;
  private clockTimer = 0;
  private game!: GameState;
  private gameUI: GameUI;
  private actions: Action[] = [];
  private saveKey = '';
  private sim: SimOptions = {};
  private placing: Item | null = null;
  private hosted: HostedWorld | null;
  /** Saves still on their way to the server, in order. */
  private saving: Promise<void> = Promise.resolve();
  private unsaved = 0;
  /** Set by the hosted shell: where the city name and "Connect" lead. */
  onConnect: (() => void) | null = null;
  readonly hud: Hud;

  constructor(opts: AppOptions) {
    const { timeline, notice } = opts;
    this.hosted = opts.hosted ?? null;
    const name = (this.hosted?.world.name || null) ?? (storedName() || timeline.name);
    this.seed = hash(name);
    // The map's layout, set before anything reads the map: the founder's own seed, or the classic map (0) for the demo (`?seed=N` previews another).
    setWorldSeed(opts.seed);
    setThumbnailContext(name, this.seed);
    this.city = new City(name, this.seed);
    const fixed = parseHour(params.get('time'));
    if (fixed !== null) {
      this.city.targetHour = fixed;
      this.preview = { label: params.get('time')!, hour: fixed };
    }
    this.stage = new Stage(document.getElementById('world')!, this.city);
    // Dev and ?debug: the app on window, for screenshot scripts (tools/, tests/e2e).
    if (import.meta.env.DEV || params.has('debug')) (window as unknown as { __app: App }).__app = this;
    this.hud = new Hud(document.getElementById('ui')!, {
      ...(opts.accounts ? { onConnect: () => this.onConnect?.() } : {}),
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
        if (this.hosted) {
          void this.hosted.api.patchWorld({ name: n }).then(() => location.reload(), (err: Error) => this.hud.feed('game.error', err.message, this.today));
          return;
        }
        try {
          if (n) localStorage.setItem(NAME_KEY, n);
          else localStorage.removeItem(NAME_KEY);
        } catch {
          // Storage unavailable; the name lasts for this visit.
        }
        location.reload();
      },
    });
    // Sound: the ambience hears the camera zoom and the weather; fireworks boom as they burst.
    this.hud.sound.listen(() => ({ zoom: this.stage.camera.zoom, rain: this.moments[this.index]?.weather === 'rain' }));
    this.city.fireworks.onBurst = () => this.hud.sound.firework();
    // The moon trip (Your home → Fly to the moon), loaded on first use: most cities never get there.
    // `hold` freezes it at that many seconds in, for previews (`?moon=<seconds>`).
    const flyToMoon = (hold?: number) => {
      if (this.stage.playing) return;
      this.setPlaying(false);
      void import('./render/moonscene.ts').then(({ MoonTrip }) => {
        const trip = new MoonTrip({ stage: this.stage, city: this.city, name: this.timeline.name, hold, onDone: (landed) => landed && this.hud.feed('game.moon', 'Back from your moon house. Worth every penny.', this.today) });
        if (trip.start()) this.hud.feed('game.moon', 'Lift-off! Flying to your house on the moon', this.today);
      });
    };
    this.gameUI = new GameUI(document.getElementById('ui')!, this.hud.sideEl, this.hud.toolsEl, {
      onBuild: (item, plot) => this.startBuild(item, plot),
      onPickHome: (tier, choice) => this.act({ t: this.today, kind: 'home', tier, choice }),
      onFlyToMoon: () => flyToMoon(),
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
    const today = timeline.snapshots.at(-1)?.t ?? Date.now();
    if (this.hosted) {
      // The server's copy is the truth, and both sides simulate with exactly the same options.
      this.actions = this.hosted.actions;
      this.sim = simOptionsFor(this.hosted.world.joinedAt);
    } else {
      this.actions = loadActions(this.saveKey) ?? (timeline.source === 'demo' ? demoActions(timeline.snapshots) : []);
      if (timeline.source === 'live') this.sim = { incomeFrom: joinedAt(this.saveKey, today) - BACK_PAY_DAYS * DAY };
    }
    if (params.has('fresh') && !this.hosted) {
      clearActions(this.saveKey);
      this.actions = timeline.source === 'demo' ? demoActions(timeline.snapshots) : [];
    }
    if (notice) this.hud.notice(notice);
    // Demo opens with the story from day one; a live world opens on today.
    // `?away=N` previews the welcome-back card as if you last looked N days ago.
    if (opts.intro) {
      this.show(this.last, false);
      this.stage.attract(true, frontDoorInset);
    } else if ((timeline.source === 'demo' && !params.has('away')) || params.has('replay')) this.replay();
    else this.show(this.last, false);
    this.stage.start();
    // Dev preview: `?moon` flies the trip on the last day; `?moon=<seconds>` holds it at that moment.
    if (params.has('moon') && (import.meta.env.DEV || params.has('debug'))) {
      this.show(this.last, false);
      const at = params.get('moon');
      flyToMoon(at ? Number(at) : undefined);
    }
    this.refreshClock();
    // Lift the boot screen once the world has drawn its first few frames, then say what changed.
    afterFrames(3, () => {
      hideBoot();
      this.welcomeBack();
      // `?recap` opens the share sheet on the growth clip (`?recap=3` films a 3-second test clip).
      if (params.has('recap')) whenBooted().then(() => this.share('clip'));
    });

    if (timeline.source === 'live') window.setInterval(() => this.poll(), POLL_MS);
  }

  /**
   * The visitor stepped through the front door: the camera settles back to
   * its angle and, to watch, the demo replays from day one. Otherwise (a
   * dialog is opening) the grown city stays as the backdrop.
   */
  enter(watch: boolean) {
    this.stage.attract(false, undefined, { settle: true });
    if (watch) this.replay();
  }

  /** The real numbers behind the city on screen, for the front door's caption. */
  get caption() {
    const s = this.moments[this.last]!.snapshot;
    const users = s.users !== undefined;
    return { name: this.timeline.name, day: this.last + 1, mrr: formatMoney(s.mrr, this.timeline.currency), people: users ? s.users! : s.customers, of: users ? 'users' : 'customers' };
  }

  /** "While you were away": what happened since this browser last showed the city. */
  private welcomeBack() {
    const snaps = this.timeline.snapshots;
    const now = snaps.length - 1;
    const forced = Number(params.get('away'));
    const preview = params.has('away') && forced > 0;
    if (now < 1 || (this.timeline.source === 'demo' && !preview)) return;
    const seen = preview ? snaps[Math.max(0, now - forced)]!.t : this.hosted ? this.hosted.world.lastSeen : lastSeen(this.saveKey);
    if (!preview) {
      // Only when there's a newer day to record: a second visit the same day costs the server nothing.
      if (this.hosted) {
        if (this.hosted.world.lastSeen !== snaps[now]!.t) void this.hosted.api.patchWorld({ lastSeen: snaps[now]!.t }).catch(() => {});
      }
      else markSeen(this.saveKey, snaps[now]!.t);
    }
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
    // The server only takes choices made today (or yesterday, around midnight): no building in the past.
    if (this.hosted && this.index < this.last) {
      this.hud.feed('game.error', 'You can only build on today. Jump to the end of the timeline, then try again.', this.today);
      return;
    }
    const next = [...this.actions, action];
    const result = simulate(this.timeline.snapshots, next, this.index, this.sim);
    const failed = result.rejected.find((r) => r.action === action);
    if (failed) {
      this.hud.feed('game.error', `Couldn't do that: ${failed.reason}`, this.today);
      return;
    }
    this.actions = next;
    if (this.hosted) this.persist(action);
    else saveActions(this.saveKey, this.actions);
    if (action.kind === 'build') {
      this.hud.feed('game.build', `Bought for ${money(this.game.treasury - result.treasury)}`, this.today);
    }
    this.show(this.index, true, true);
  }

  /**
   * Sends a choice to the server, after any still on their way. The city
   * already shows it; if the server says no, it's undone and we say why.
   */
  private persist(action: Action) {
    const api = this.hosted!.api;
    this.unsaved++;
    this.saving = this.saving.then(async () => {
      try {
        const saved = await api.addAction(action);
        // Nothing else in flight: adopt the server's list, which is the truth.
        if (this.unsaved === 1 && JSON.stringify(saved) !== JSON.stringify(this.actions)) {
          this.actions = saved;
          this.show(this.index, false);
        }
      } catch (err) {
        this.rollback(action, err);
      } finally {
        this.unsaved--;
      }
    });
  }

  private rollback(action: Action, err: unknown) {
    this.actions = this.actions.filter((a) => a !== action);
    this.show(this.index, false);
    const what = action.kind === 'build' ? `the ${ITEMS.get(action.item)?.name ?? 'building'}` : 'your move';
    const e = err instanceof ApiRequestError ? err : null;
    const reason = e?.message.replace(/\.$/, '');
    const text =
      e?.code === 'rejected'
        ? `Couldn't save ${what}. ${reason}. It's been undone, and nothing was spent.`
        : e?.code === 'unauthenticated'
          ? `Couldn't save ${what}: you're signed out. It's been undone; sign in and try again.`
          : e?.code === 'payment_required'
            ? `Couldn't save ${what}: your plan isn't active. It's been undone.`
            : `Couldn't reach TinyTown to save ${what}, so it's been undone. Nothing was spent.`;
    if (action.kind === 'build') this.hud.retract('game.build');
    this.hud.feed('game.error', text, this.today);
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
      for (const e of events) {
        // The sign coming back on is earned by paying the city's upkeep again: on
        // the live day, fly over for the fireworks and offer a postcard of it.
        if (e.type === 'sign.lit' && i === this.last) {
          this.stage.focus(this.city.signFocus(), 1.25);
          this.hud.feed(`game.${e.type}`, describeGame(e), game.t, { label: 'Share this', icon: 'share', run: () => setTimeout(() => this.share(), 400) });
        } else this.hud.feed(`game.${e.type}`, describeGame(e), game.t);
      }
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
      let t: Timeline;
      if (this.hosted) t = await this.hosted.api.timeline();
      else {
        const res = await fetch('/api/timeline');
        if (!res.ok) return;
        t = (await res.json()) as Timeline;
      }
      if (!t.snapshots?.length) return;
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

  /**
   * The share sheet: a postcard of the city on screen (day or night, real
   * numbers only when asked), or the growth clip (src/ui/recap.ts, loaded
   * on first use).
   */
  private share(pick: 'postcard' | 'clip' = 'postcard') {
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
    const postcard = () => this.hud.openShare(frame, compose, `tinytown-${slug}-day-${day}.png`);
    const seconds = Number(params.get('recap')) || undefined;
    import('./ui/recap.ts').then(
      ({ openShareSheet }) => openShareSheet({ frame, postcard, clip: this.clipHost(), pick, file: `tinytown-${slug}-growth`, ...(seconds ? { seconds } : {}) }),
      // The clip's code didn't arrive (offline, a new deploy): the postcard still works.
      () => postcard(),
    );
  }

  /**
   * What the growth clip needs: the city to film, the real numbers, and a
   * way to step the replay without the HUD, the feed or the saved day
   * noticing. `hold()` hands back a function that restores all of it.
   */
  private clipHost(): ClipHost {
    let prev: { i: number; game: GameState } | null = null;
    return {
      stage: this.stage,
      city: this.city,
      name: this.timeline.name,
      demo: this.timeline.source === 'demo',
      currency: this.timeline.currency,
      snapshots: this.timeline.snapshots,
      // The clip always runs to the latest day, wherever the replay happens to be.
      today: this.last,
      hold: () => {
        const index = this.index;
        const playing = this.playing;
        this.setPlaying(false);
        return () => {
          this.show(index, false);
          if (playing) {
            this.playing = true;
            this.stage.active = true;
            this.hud.setPlaying(true);
          }
        };
      },
      showDay: (i, animate) => {
        const game = simulate(this.timeline.snapshots, this.actions, i, this.sim);
        this.city.setWorld(this.plan(i, game), game, animate);
        if (animate && prev && prev.i !== i) {
          this.city.celebrateGame(diffGame(prev.game, game));
          this.city.celebrate(diffMoments(this.moments[prev.i]!, this.moments[i]!));
        }
        const weekAgo = this.moments[Math.max(0, i - 7)]!;
        this.city.setShippingPace(this.moments[i]!.snapshot.commits - weekAgo.snapshot.commits);
        prev = { i, game };
      },
    };
  }
}

/** Dev and `--mode mockapi` builds only: `?mockapi=<state>` stubs the API (see src/api/mock.ts). */
async function loadMock(): Promise<{ auth: AuthProvider | null; signedOutUrl: string } | null> {
  // A compile-time constant: production builds drop this branch and the mock with it.
  if (!(import.meta.env.DEV || import.meta.env.MODE === 'mockapi')) return null;
  const state = params.get('mockapi');
  if (!state) return null;
  const mock = await import('./api/mock.ts');
  return { auth: mock.installMockApi(state as Parameters<typeof mock.installMockApi>[0]), signedOutUrl: mock.signedOutHref() };
}

/**
 * Not hosted: exactly as before (the demo, or a local `.env` timeline).
 * Hosted: restore the session, ask the server who this is, then either open
 * the founder's own city or show the demo with the right next step.
 */
/** Who to write to when something breaks (from the server's config, when it has one). */
let supportEmail: string | null = null;

/** Opens the front door over the city once the boot screen lifts. */
function openFrontDoor(app: App, config: ConfigResponse | null, shell?: { primary(): void; openSignIn(): void }) {
  const sheet = priceSheet(config?.plans ?? []);
  const price = sheet.month ? `${formatPrice(sheet.month.amount, sheet.month.currency)}/mo` : sheet.year ? `${formatPrice(sheet.year.amount, sheet.year.currency)}/yr` : null;
  const yearly = sheet.month && sheet.year ? `${formatPrice(sheet.year.amount, sheet.year.currency)} a year` : null;
  void new FrontDoor({
    caption: app.caption,
    price,
    yearly,
    accounts: !!shell,
    onEnter: (watch) => app.enter(watch),
    onMakeItYours: () => shell?.primary(),
    onSignIn: () => shell?.openSignIn(),
  }).open();
}

const NO_WEBGL = {
  title: 'Your browser has 3D turned off',
  message: 'TinyTown draws your city with WebGL 2, and this browser has it switched off or blocked.',
  tips: ['Use a recent Chrome, Edge, Firefox or Safari.', 'Turn on hardware acceleration (graphics acceleration) in your browser settings, then reload.', 'On a work computer, the graphics driver may be blocked: try another device.'],
};

async function boot() {
  const mock = await loadMock();
  const api = new Api({ token: async () => null });
  const config = await api.config();
  supportEmail = config?.supportEmail ?? null;
  // Reports go only to a hosted server that takes them (never from local, demo-only or mock builds).
  setTelemetry(!!config?.hosted && !mock);
  if (!hasWebGL2()) {
    reportWebGL('WebGL 2 unavailable at boot');
    return bootFailure({ ...NO_WEBGL, support: supportEmail });
  }
  const demoSeed = Number(params.get('seed')) || 0;
  if (!config?.hosted || !config.supabase) {
    const { timeline, notice } = await loadTimeline();
    const intro = wantsFrontDoor({ search: params, seen: frontDoorSeen(), demo: timeline.source === 'demo', signedIn: false });
    if (intro) holdHud();
    const app = new App({ timeline, notice, seed: demoSeed, intro });
    if (intro) openFrontDoor(app, null);
    return;
  }

  // The account UI is its own chunk: local and demo-only visitors never download it.
  const shellModule = import('./ui/hosted.ts');
  const auth = mock?.auth ?? new (await import('./api/auth.ts')).SupabaseAuth(config.supabase);
  api.setHooks({ token: () => auth.token() });
  const session = await auth.restore();
  let me: MeResponse | null = null;
  let notice: string | undefined;
  /** Signed in, but the waitlist hasn't reached this email yet. */
  let waitlisted = false;
  if (session) {
    try {
      me = await api.me();
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'not_invited') waitlisted = true;
      else if (err instanceof ApiRequestError && err.code === 'unauthenticated') {
        await auth.signOut();
        notice = 'Your session ended. Sign in again to open your city.';
      } else {
        notice = "Couldn't reach your account just now, so this is the demo. Reload to try again.";
      }
    }
  }

  // Read the redirect's news, then tidy it out of the address bar.
  const ret = readReturn(location.search);
  const clean = location.pathname + cleanSearch(location.search) + location.hash;
  if (clean !== location.pathname + location.search + location.hash) history.replaceState(history.state, '', clean);

  let screen: BootScreen = decideBoot(config, me, { forceDemo: params.has('demo'), waitlisted });
  let app: App | null = null;
  /** The city couldn't load because a connection needs redoing: open setup at that step. */
  let reconnect: string | null = null;
  /** Connected, but no history yet: the notice says so, and nothing else pops up. */
  let waiting = false;
  if (screen.kind === 'world' && me) {
    try {
      const [actions, timeline] = await Promise.all([api.actions(), api.timeline()]);
      if (timeline.snapshots?.length) app = new App({ timeline, seed: me.world.seed, hosted: { api, world: me.world, actions }, accounts: true });
      else {
        waiting = true;
        notice = "Stripe is connected, and your first numbers are still on their way. Here's the demo until they land.";
      }
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'not_connected') {
        reconnect = "Your city couldn't reach your Stripe data: the connection has stopped working. Reconnect Stripe and your city comes straight back.";
      } else notice = `Couldn't load your city (${err instanceof Error ? err.message.replace(/\.$/, '') : 'unknown error'}). Here's the demo for now; reload to try again.`;
    }
    if (!app) screen = { kind: 'demo', cta: 'onboard' };
  }
  // A first visit to the demo opens on the front door (unless a dialog opens by itself: see below).
  const intro = !app && wantsFrontDoor({ search: params, seen: frontDoorSeen(), demo: true, signedIn: !!session });
  if (intro) holdHud();
  app ??= new App({ timeline: demoTimeline({ boost: Number(params.get('boost')) || 1 }), notice, seed: demoSeed, accounts: true, intro });

  const { HostedShell, takePlanIntent } = await shellModule;
  const shell = new HostedShell({ api, auth, config, me, screen, hud: app.hud, signedOutUrl: mock?.signedOutUrl ?? '/', email: session?.email ?? null });
  app.onConnect = () => shell.primary();

  let wantsPlan = false;
  try {
    wantsPlan = !!localStorage.getItem('tinytown:plan-intent');
  } catch {
    // No storage: no remembered plan.
  }
  const opening = reconnect
    ? ({ dialog: 'onboard', welcome: false, step: 1, error: reconnect, stripeBroken: true } as const)
    : waiting
      ? ({ dialog: 'none' } as const)
      : decideOpening(screen, ret, me, { signInError: auth.redirectError, wantsPlan });
  if (intro) {
    if (wantsFrontDoor({ search: params, seen: frontDoorSeen(), demo: true, signedIn: !!session, dialog: opening.dialog })) openFrontDoor(app, config, shell);
    else {
      // Something opens by itself (a sign-in link that failed, say): no front door, the demo as usual.
      releaseHud();
      app.enter(true);
    }
  }
  await whenBooted();
  measurePerf(performance.now());
  if (ret.checkout === 'success' && me && !isPaid(me.plan.status)) return void shell.confirmCheckout();
  if (ret.checkout === 'success' && opening.dialog === 'none') app.hud.feed('account.welcome', "You're in. Your plan is active, and your city is live.", Date.now());
  // A remembered plan only matters while there's a plan to pick.
  if (opening.dialog !== 'plan' && me && isPaid(me.plan.status)) takePlanIntent();
  shell.handleOpening(opening);
}

startTelemetry();
narrateBoot();
boot().catch((err: unknown) => {
  console.error(err);
  if (!hasWebGL2()) {
    reportWebGL('WebGL 2 failed while starting the city');
    return bootFailure({ ...NO_WEBGL, support: supportEmail });
  }
  // The global handlers don't see this one: it was caught here.
  if (err instanceof Error) window.dispatchEvent(new ErrorEvent('error', { message: err.message, error: err }));
  bootFailure({
    title: "Your city couldn't load",
    message: 'Something went wrong while building it. Reloading usually fixes it; your city and its saves are safe.',
    support: supportEmail,
  });
});
