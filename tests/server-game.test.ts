import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { simOptionsFor } from '../src/api/contract.ts';
import type { Snapshot } from '../src/data/types.ts';
import type { Action } from '../src/game/economy.ts';
import { checkAction, parseAction } from '../server/game.ts';
import { FakeSupabase, USER, call, givePlan, setup, stubFetch } from './server-helpers.ts';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 9);
const NOW = Date.UTC(2026, 9, 13, 12);
const TODAY = Date.UTC(2026, 9, 13);

/** Five days at a steady MRR. */
const days = (mrr: number): Snapshot[] => Array.from({ length: 5 }, (_, i) => ({ t: T0 + i * DAY, customers: 5, mrr, releases: 0, commits: 0 }));

describe('checkAction', () => {
  const today = T0 + 4 * DAY;
  const park = (plot: string, t = today): Action => ({ t, kind: 'build', item: 'park', plot });

  it('accepts what the game applies', () => {
    expect(checkAction(days(100), [], park('market:0'), {})).toEqual({ ok: true });
    expect(checkAction(days(100), [park('market:0')], park('market:1'), {})).toEqual({ ok: true });
  });

  it('refuses with the game’s own reason: locked, unaffordable, taken, unknown', () => {
    expect(checkAction(days(100), [], { t: today, kind: 'build', item: 'hq-tower' }, {})).toEqual({ ok: false, reason: 'Unlocks at $1,000 MRR' });
    expect(checkAction(days(1_000), [], { t: today, kind: 'build', item: 'hq-tower' }, {})).toEqual({ ok: false, reason: 'Not enough money' });
    expect(checkAction(days(100), [park('market:0')], park('market:0'), {})).toEqual({ ok: false, reason: 'That plot is taken' });
    expect(checkAction(days(100), [], { t: today, kind: 'build', item: 'gold-plated-tower' }, {})).toEqual({ ok: false, reason: 'Unknown item' });
    expect(checkAction(days(100), [], { t: today, kind: 'home', tier: 4, choice: 'villa' }, {})).toEqual({ ok: false, reason: 'Not unlocked yet' });
  });

  it('counts money the same way as the browser, back-pay window included', () => {
    // Joined today: the back-pay window reaches 90 days back, so all five days of income count.
    const joinedToday = simOptionsFor(today);
    expect(joinedToday.incomeFrom).toBe(today - 90 * DAY);
    const pricey: Action = { t: today, kind: 'build', item: 'cafe', plot: 'market:0' };
    expect(checkAction(days(100), [], pricey, joinedToday)).toEqual({ ok: true });
    expect(checkAction(days(100), [], pricey, { incomeFrom: today + DAY })).toEqual({ ok: true });
    // With no income credited, the starting grant pays for three cafés but not four.
    const cafes = [0, 1, 2, 3].map((q) => ({ ...pricey, plot: `market:${q}` }));
    expect(checkAction(days(100), cafes.slice(0, 2), cafes[2]!, { incomeFrom: today + DAY })).toEqual({ ok: true });
    expect(checkAction(days(100), cafes.slice(0, 3), cafes[3]!, { incomeFrom: today + DAY })).toEqual({ ok: false, reason: 'Not enough money' });
  });

  it('only allows today or yesterday, and never before an already-saved action', () => {
    expect(checkAction(days(100), [], park('market:0', today - DAY), {})).toEqual({ ok: true });
    expect(checkAction(days(100), [], park('market:0', today - 2 * DAY), {}).ok).toBe(false);
    expect(checkAction(days(100), [], park('market:0', today + DAY), {}).ok).toBe(false);
    expect(checkAction(days(100), [park('market:0', today)], park('market:1', today - DAY), {}).ok).toBe(false);
    expect(checkAction([], [], park('market:0'), {}).ok).toBe(false);
  });
});

describe('parseAction', () => {
  it('keeps only known fields', () => {
    expect(parseAction({ t: T0, kind: 'build', item: 'park', plot: 'market:0', treasury: 1e12 })).toEqual({ t: T0, kind: 'build', item: 'park', plot: 'market:0' });
    expect(parseAction({ t: T0, kind: 'home', tier: 1, choice: 'studio', extra: true })).toEqual({ t: T0, kind: 'home', tier: 1, choice: 'studio' });
  });

  it('rejects malformed actions', () => {
    for (const bad of [null, 'park', { t: T0 }, { t: T0 + 1, kind: 'build', item: 'park' }, { t: T0, kind: 'build', item: '<script>' }, { t: T0, kind: 'build', item: 'park', plot: 'x' }, { t: T0, kind: 'home', tier: -1, choice: 'a' }, { t: T0, kind: 'grant', amount: 1e9 }]) {
      expect(() => parseAction(bad)).toThrow();
    }
  });
});

describe('POST /api/world/actions', () => {
  let db: FakeSupabase;
  const timeline = (mrr: number) => ({
    name: 'Acme',
    currency: 'usd',
    source: 'live',
    integrations: { stripe: true, github: false },
    snapshots: Array.from({ length: 5 }, (_, i) => ({ t: TODAY - (4 - i) * DAY, customers: 5, mrr, releases: 0, commits: 0 })),
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    db = setup();
    givePlan(db);
    stubFetch(db);
    // A fresh cached timeline: the server checks against its own copy of the founder's metrics.
    db.tables.timelines!.push({ user_id: USER.id, timeline: timeline(100), fetched_at: new Date(NOW).toISOString() });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const post = (action: unknown) => call('POST', '/api/world/actions', { body: { action } });

  it('saves an action the game allows and returns the saved list', async () => {
    const a = { t: TODAY, kind: 'build', item: 'park', plot: 'market:0' };
    const res = await post(a);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ actions: [a] });
    expect(await (await call('GET', '/api/world/actions')).json()).toEqual({ actions: [a] });
    expect(db.row('worlds', { user_id: USER.id })).toMatchObject({ version: 1 });
  });

  it('refuses with 409 and the reason, and saves nothing', async () => {
    const res = await post({ t: TODAY, kind: 'build', item: 'hq-tower' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Unlocks at $1,000 MRR', code: 'rejected' });
    expect(await (await call('GET', '/api/world/actions')).json()).toEqual({ actions: [] });
  });

  it("re-checks when another tab saved first, so two purchases can't spend the same money", async () => {
    await post({ t: TODAY, kind: 'build', item: 'cafe', plot: 'market:0' });
    // Another tab sneaks a purchase in between our read and our write.
    let raced = false;
    db.beforePatch = (table) => {
      if (table !== 'worlds' || raced) return;
      raced = true;
      const w = db.row('worlds', { user_id: USER.id })!;
      w.actions = [...(w.actions as Action[]), { t: TODAY, kind: 'build', item: 'park', plot: 'market:1' }];
      w.version = Number(w.version) + 1;
    };
    const res = await post({ t: TODAY, kind: 'build', item: 'park', plot: 'market:1' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'That plot is taken', code: 'rejected' });
    expect((db.row('worlds', { user_id: USER.id })!.actions as Action[]).length).toBe(2);
  });

  it('400 for a malformed action', async () => {
    expect((await post({ t: 'today', kind: 'build', item: 'park' })).status).toBe(400);
  });
});
