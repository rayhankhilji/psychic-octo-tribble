/**
 * Fuzzing the game's one source of truth from both sides: random founders
 * (random metrics histories) making random choices, sensible and not. For
 * every choice:
 *
 * - the server's verdict (`checkAction`, and `POST /api/world/actions` end
 *   to end) equals what the browser's own `simulate()` allows, so a founder
 *   is never refused something the screen offered, nor allowed something it
 *   didn't;
 * - money never goes below zero, and the books balance: the treasury is
 *   exactly the grant plus income, less upkeep paid and everything bought;
 * - replaying the saved actions (after a JSON round trip, as they come back
 *   from Postgres) rebuilds the same city, with nothing refused.
 *
 * Seeded, so every failure reproduces: FUZZ_SEED=<n> picks the run,
 * FUZZ_RUNS=<n> makes it longer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { simOptionsFor } from '../src/api/contract.ts';
import { DAY, type Snapshot, type Timeline } from '../src/data/types.ts';
import { BUILD_BLOCKS, CATALOG, HOME_TIERS, QUADRANTS, SWAP_FEE, ITEMS } from '../src/game/catalog.ts';
import { STARTING_GRANT, canBuy, freePlots, simulate, type Action, type GameState, type SimOptions } from '../src/game/economy.ts';
import { checkAction, parseAction } from '../server/game.ts';
import { FakeSupabase, USER, call, givePlan, setup, stubFetch } from './server-helpers.ts';
import { resetCaches } from '../server/app.ts';

const SEED = Number(process.env.FUZZ_SEED ?? 20261013);
const RUNS = Number(process.env.FUZZ_RUNS ?? 25);
/** Replaying a year of history per choice is the slow part: generous, and scaled with FUZZ_RUNS. */
const TIMEOUT_MS = 60_000 + RUNS * 4_000;

/** mulberry32: small, fast, and the same everywhere. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rnd = () => number;
const pick = <T>(r: Rnd, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const int = (r: Rnd, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

/** A founder's history: flat, growing, crashing, spiking, pre-revenue, or a unicorn. */
export function randomTimeline(r: Rnd): Snapshot[] {
  const days = int(r, 2, 420);
  const today = Date.UTC(2026, 9, 13);
  const start = today - (days - 1) * DAY;
  const shape = pick(r, ['flat', 'grow', 'crash', 'spiky', 'zero', 'rocket'] as const);
  let mrr = shape === 'zero' ? 0 : shape === 'rocket' ? int(r, 1_000, 50_000) : int(r, 0, 3_000) * pick(r, [0.01, 0.1, 1, 1, 1, 10]);
  let commits = 0;
  let releases = 0;
  const out: Snapshot[] = [];
  for (let i = 0; i < days; i++) {
    if (shape === 'grow') mrr *= 1 + r() * 0.02;
    if (shape === 'rocket') mrr *= 1 + r() * 0.05;
    if (shape === 'crash' && i === Math.floor(days / 2)) mrr *= r() * 0.2;
    if (shape === 'spiky' && r() < 0.05) mrr = r() < 0.5 ? mrr * 4 : mrr / 4;
    if (shape !== 'zero' && r() < 0.01) mrr = 0;
    mrr = Math.max(0, Math.round(mrr * 100) / 100);
    commits += int(r, 0, 6);
    if (r() < 0.03) releases++;
    const customers = Math.floor(mrr / (20 + r() * 40));
    out.push({ t: start + i * DAY, customers, mrr, releases, commits, ...(r() < 0.3 ? { users: customers * int(r, 1, 50) } : {}) });
  }
  return out;
}

const PLOT_IDS = BUILD_BLOCKS.flatMap((b) => QUADRANTS.map((_, q) => `${b.id}:${q}`));

/** A choice: usually one the screen would offer, sometimes nonsense a script might send. */
function randomAction(r: Rnd, game: GameState, today: number): Action {
  const roll = r();
  if (roll < 0.55) {
    const buyable = CATALOG.filter((i) => !canBuy(game, i));
    if (buyable.length) {
      const item = pick(r, buyable);
      const plot = item.placement.kind === 'plot' ? pick(r, freePlots(game, item.placement.size))?.id : undefined;
      return { t: today, kind: 'build', item: item.id, ...(plot ? { plot } : {}) };
    }
  }
  if (roll < 0.7) {
    const tier = int(r, 0, Math.min(HOME_TIERS.length - 1, game.home.tier + 1));
    return { t: today, kind: 'home', tier, choice: pick(r, HOME_TIERS[tier]!.options).id };
  }
  const t = pick(r, [today, today, today, today - DAY, today - 2 * DAY, today + DAY]);
  if (roll < 0.9) {
    const item = r() < 0.05 ? { id: 'gold-plated-tower' } : pick(r, CATALOG);
    return { t, kind: 'build', item: item.id, ...(r() < 0.8 ? { plot: pick(r, PLOT_IDS) } : {}) };
  }
  const tier = int(r, 0, HOME_TIERS.length);
  return { t, kind: 'home', tier, choice: pick(r, HOME_TIERS.flatMap((h) => h.options)).id };
}

/** What the browser does before sending a choice (main.ts `act`): it acts only on today, and only if its own simulation applies it. */
function browserAllows(snaps: Snapshot[], saved: Action[], action: Action, opts: SimOptions): boolean {
  const last = snaps.length - 1;
  if (action.t !== snaps[last]!.t) return false;
  return !simulate(snaps, [...saved, action], last, opts).rejected.some((x) => x.action === action);
}

/**
 * The books: everything spent, worked out independently of `simulate`'s
 * running total. Buildings cost their price; changing a home pick that was
 * already made costs the swap fee.
 */
function spent(saved: Action[]): number {
  let total = 0;
  const picks = new Map<number, string>();
  for (const a of [...saved].sort((x, y) => x.t - y.t)) {
    if (a.kind === 'build') total += ITEMS.get(a.item)!.price;
    else {
      const current = picks.get(a.tier);
      if (current && current !== a.choice) total += HOME_TIERS[a.tier]!.value * SWAP_FEE;
      picks.set(a.tier, a.choice);
    }
  }
  return total;
}

function checkBooks(game: GameState, saved: Action[], where: string) {
  const ledger = STARTING_GRANT + game.earned - game.upkeepPaid - spent(saved);
  const scale = Math.max(1, STARTING_GRANT + game.earned);
  expect(ledger, `${where}: the books went below zero`).toBeGreaterThan(-1e-6 * scale);
  expect(Math.abs(ledger - game.treasury) / scale, `${where}: treasury ${game.treasury} doesn't match the ledger ${ledger}`).toBeLessThan(1e-9);
  expect(game.treasury).toBeGreaterThanOrEqual(0);
  expect(game.upkeepPaid).toBeLessThanOrEqual(game.earned + STARTING_GRANT + 1e-6 * scale);
}

interface RunResult {
  saved: Action[];
  tried: number;
  accepted: number;
}

/** One founder: up to `steps` choices against the pure checker, with every invariant checked as we go. */
function fuzzOne(seed: number, steps: number): RunResult {
  const r = prng(seed);
  const snaps = randomTimeline(r);
  const last = snaps.length - 1;
  const today = snaps[last]!.t;
  const joinedAt = r() < 0.3 ? null : snaps[int(r, 0, last)]!.t;
  const opts = simOptionsFor(joinedAt);
  let saved: Action[] = [];
  let accepted = 0;
  for (let i = 0; i < steps; i++) {
    const game = simulate(snaps, saved, last, opts);
    const action = randomAction(r, game, today);
    const where = `FUZZ_SEED=${seed} step ${i} ${JSON.stringify(action)}`;
    const verdict = checkAction(snaps, saved, action, opts);
    if (action.t === today) expect(verdict.ok, `${where}: server ${verdict.ok ? 'accepted' : `refused (${(verdict as { reason: string }).reason})`} what the browser ${browserAllows(snaps, saved, action, opts) ? 'allows' : 'refuses'}`).toBe(browserAllows(snaps, saved, action, opts));
    if (!verdict.ok) continue;
    saved = [...saved, parseAction(action)];
    accepted++;
    const after = simulate(snaps, saved, last, opts);
    expect(after.rejected, `${where}: an accepted action left something refused`).toEqual([]);
    checkBooks(after, saved, where);
  }
  // Replaying what Postgres hands back (JSON, re-parsed) rebuilds the same city, day by day.
  const restored = (JSON.parse(JSON.stringify(saved)) as unknown[]).map(parseAction);
  expect(restored).toEqual(saved);
  for (const upto of [0, Math.floor(last / 2), last]) {
    const a = simulate(snaps, saved, upto, opts);
    const b = simulate(snaps, restored, upto, opts);
    expect(b).toEqual(a);
    checkBooks(a, saved.filter((x) => x.t <= snaps[upto]!.t), `FUZZ_SEED=${seed} replay to day ${upto}`);
  }
  return { saved, tried: steps, accepted };
}

describe('fuzz: the server and the browser agree on every purchase', () => {
  it(`${RUNS} random founders, 40 choices each (FUZZ_SEED=${SEED})`, () => {
    let accepted = 0;
    let tried = 0;
    for (let k = 0; k < RUNS; k++) {
      const res = fuzzOne(SEED + k, 40);
      accepted += res.accepted;
      tried += res.tried;
    }
    // A fuzz that never builds anything proves nothing.
    expect(accepted).toBeGreaterThan(tried * 0.15);
  }, TIMEOUT_MS);

  it('a long-lived city: 300 choices on one founder', () => {
    const res = fuzzOne(SEED ^ 0x5eed, 300);
    expect(res.accepted).toBeGreaterThan(10);
  }, TIMEOUT_MS);
});

describe('fuzz: POST /api/world/actions end to end', () => {
  let db: FakeSupabase;
  afterEach(() => vi.unstubAllGlobals());

  it('accepts exactly what the browser allows, saves it, and the saved list replays', async () => {
    const runs = Math.max(4, Math.floor(RUNS / 5));
    let accepted = 0;
    for (let k = 0; k < runs; k++) {
      const seed = SEED + 1000 + k;
      const r = prng(seed);
      db = setup();
      givePlan(db);
      stubFetch(db);
      const snaps = randomTimeline(r);
      const last = snaps.length - 1;
      const today = snaps[last]!.t;
      const joinedAt = r() < 0.3 ? null : snaps[int(r, 0, last)]!.t;
      const opts = simOptionsFor(joinedAt);
      const timeline: Timeline = { name: 'Fuzz', currency: 'usd', source: 'live', integrations: { stripe: true, github: false }, snapshots: snaps };
      db.tables.profiles!.push({ user_id: USER.id, seed: 7, name: 'Fuzz', joined_at: joinedAt, last_seen: null, users_source: 'customers', users_manual: [], created_at: new Date().toISOString() });
      // A fresh cached timeline: the server checks against exactly these numbers.
      db.tables.timelines!.push({ user_id: USER.id, timeline, fetched_at: new Date().toISOString() });

      let saved: Action[] = [];
      for (let i = 0; i < 40; i++) {
        // The per-user limit is 60 a minute; a fuzz is not a founder.
        if (i % 50 === 49) resetCaches();
        const game = simulate(snaps, saved, last, opts);
        const action = randomAction(r, game, today);
        const where = `FUZZ_SEED=${seed} step ${i} ${JSON.stringify(action)}`;
        const res = await call('POST', '/api/world/actions', { body: { action } });
        const body = (await res.json()) as { actions?: Action[]; error?: string; code?: string };
        expect([200, 409], `${where}: ${res.status} ${JSON.stringify(body)}`).toContain(res.status);
        if (action.t === today) expect(res.status === 200, `${where}: answered ${res.status} (${body.error ?? ''})`).toBe(browserAllows(snaps, saved, action, opts));
        if (res.status === 409) {
          expect(body.code).toBe('rejected');
          continue;
        }
        saved = [...saved, parseAction(action)];
        expect(body.actions).toEqual(saved);
        accepted++;
      }
      const stored = db.row('worlds', { user_id: USER.id }) as { actions: Action[]; version: number } | undefined;
      expect(stored?.actions ?? []).toEqual(saved);
      expect(stored?.version ?? 0).toBe(saved.length);
      const replay = simulate(snaps, stored?.actions ?? [], last, opts);
      expect(replay.rejected).toEqual([]);
      checkBooks(replay, saved, `FUZZ_SEED=${seed} stored world`);
    }
    expect(accepted).toBeGreaterThan(0);
  }, TIMEOUT_MS);
});

/**
 * Found by the end-to-end run: land that opens because today's builds filled
 * the last block shows as open (`freePlots`, `canBuy` and the placement
 * highlights all offer it), so `simulate` must open it straight away too, or
 * building there today is refused with "Pick an open plot".
 */
describe('land opened today', () => {
  it('can be built on the same day it opens', () => {
    const T0 = Date.UTC(2026, 9, 1);
    const snaps: Snapshot[] = Array.from({ length: 5 }, (_, i) => ({ t: T0 + i * DAY, customers: 5, mrr: 500, releases: 0, commits: 0 }));
    const today = snaps[4]!.t;
    const filled: Action[] = [0, 1, 2, 3].map((q) => ({ t: today, kind: 'build', item: 'park', plot: `market:${q}` }));
    const game = simulate(snaps, filled, 4);
    const offered = freePlots(game, 1)[0]!;
    expect(offered.block).not.toBe('market');
    const next: Action = { t: today, kind: 'build', item: 'park', plot: offered.id };
    expect(checkAction(snaps, filled, next, {})).toEqual({ ok: true });
  });
});
