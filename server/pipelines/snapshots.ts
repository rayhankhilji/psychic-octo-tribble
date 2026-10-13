import { DAY, startOfDay, type Snapshot, type Timeline } from '../../src/data/types.ts';
import type { Hosted } from '../context.ts';
import type { TimelineRow } from '../store.ts';
import { pool, type Budget } from './budget.ts';
import { dayMs, dayString, eq, gt, gte, iso, isIn, type Rest } from './rest.ts';

/**
 * Each founder's numbers, written down a day at a time in
 * `metric_snapshots`, so the city never forgets a day: not when Stripe's
 * data changes later (a refund, a deleted subscription), not when a
 * connection breaks, not when GitHub's history window slides past old
 * commits. Only complete days (yesterday and earlier) are written. The last
 * `SETTLE_DAYS` may be rewritten while late data settles; older days are
 * never changed once stored.
 */

export const SETTLE_DAYS = 2;
export const PAID_STATUSES = ['active', 'trialing', 'past_due'] as const;

export interface SnapshotRow {
  user_id: string;
  day: string;
  mrr: number;
  currency: string;
  customers: number;
  users: number | null;
  releases: number;
  commits: number;
  release: string | null;
  stripe: boolean;
  github: boolean;
}

const int = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);

export function toRow(userId: string, t: Timeline, s: Snapshot): SnapshotRow {
  return {
    user_id: userId,
    day: dayString(s.t),
    mrr: Math.max(0, Math.round(s.mrr * 100) / 100),
    currency: t.currency.slice(0, 8),
    customers: int(s.customers),
    users: s.users === undefined ? null : int(s.users),
    releases: int(s.releases),
    commits: int(s.commits),
    release: s.release ? s.release.slice(0, 200) : null,
    stripe: t.integrations.stripe,
    github: t.integrations.github,
  };
}

/** A settled row is only replaced by a build that knows at least as much (no zeros after Stripe is disconnected). */
const knowsAsMuch = (incoming: SnapshotRow, stored: Pick<SnapshotRow, 'stripe' | 'github'>) => (incoming.stripe || !stored.stripe) && (incoming.github || !stored.github);

/**
 * Writes the days of `timeline` that aren't stored yet, plus the settling
 * days, for one founder. Idempotent: running it twice on the same timeline
 * writes the same rows. Returns how many rows were sent.
 */
export async function recordSnapshots(rest: Rest, userId: string, timeline: Timeline, now: number): Promise<number> {
  const yesterday = startOfDay(now) - DAY;
  const settleFrom = yesterday - (SETTLE_DAYS - 1) * DAY;
  const complete = timeline.snapshots.filter((s) => s.t <= yesterday);
  if (!complete.length) return 0;

  type Stored = Pick<SnapshotRow, 'day' | 'stripe' | 'github'>;
  const [first] = await rest.rows<Stored>('metric_snapshots', { select: 'day,stripe,github', where: { user_id: eq(userId) }, order: 'day.asc', limit: 1 });
  const [last] = await rest.rows<Stored>('metric_snapshots', { select: 'day,stripe,github', where: { user_id: eq(userId) }, order: 'day.desc', limit: 1 });
  const settling = first
    ? await rest.rows<Stored>('metric_snapshots', { select: 'day,stripe,github', where: { user_id: eq(userId), day: gte(dayString(settleFrom)) } })
    : [];
  const settled = new Map(settling.map((r) => [dayMs(r.day), r]));
  const firstDay = first ? dayMs(first.day) : Infinity;
  const lastDay = last ? dayMs(last.day) : -Infinity;

  const rows: SnapshotRow[] = [];
  for (const s of complete) {
    const row = toRow(userId, timeline, s);
    if (s.t < firstDay || s.t > lastDay) {
      // Never stored: before the first day we have (a newly connected repo with
      // older history) or after the last (new days, or a gap while away).
      rows.push(row);
    } else if (s.t >= settleFrom) {
      const stored = settled.get(s.t);
      if (!stored || knowsAsMuch(row, stored)) rows.push(row);
    }
  }
  if (!rows.length) return 0;
  const recordedAt = iso(now);
  await rest.upsertMany(
    'metric_snapshots',
    rows.map((r) => ({ ...r, recorded_at: recordedAt })),
    'user_id,day',
    'merge',
  );
  return rows.length;
}

// ─── The daily pass ───────────────────────────────────────────────────────

const PAGE = 100;

export interface SnapshotPassResult {
  users: number;
  rows: number;
  failed: number;
  /** The last user done, if the pass ran out of time; null when finished. */
  after: string | null;
}

/**
 * Records every paying founder's cached timeline, in user-id order from
 * `after`, until done or out of time. The hourly job already records the
 * founders it refreshes; this catches everyone whose timeline was rebuilt by
 * a visit instead.
 */
export async function snapshotPass(ctx: Hosted, rest: Rest, budget: Budget, after: string | null, concurrency: number): Promise<SnapshotPassResult> {
  const out: SnapshotPassResult = { users: 0, rows: 0, failed: 0, after };
  for (;;) {
    if (!budget.has(5_000)) return out;
    const page = await rest.rows<{ user_id: string }>('subscriptions', {
      select: 'user_id',
      where: { status: isIn(PAID_STATUSES), ...(out.after ? { user_id: gt(out.after) } : {}) },
      order: 'user_id.asc',
      limit: PAGE,
    });
    if (!page.length) return { ...out, after: null };
    const done = new Set<string>();
    await pool(page, { limit: concurrency, budget, reserveMs: 2_000 }, async ({ user_id }) => {
      try {
        const cached = (await rest.rows<Pick<TimelineRow, 'timeline'>>('timelines', { select: 'timeline', where: { user_id: eq(user_id) }, limit: 1 }))[0];
        if (cached) out.rows += await recordSnapshots(rest, user_id, cached.timeline, ctx.now);
        out.users++;
      } catch (err) {
        out.failed++;
        console.error(`Snapshot for ${user_id} failed: ${err instanceof Error ? err.message : 'unknown'}`);
      }
      done.add(user_id);
    });
    // Resume after the last user of the unbroken run of finished ones, so
    // nobody is skipped when workers finish out of order.
    let i = 0;
    while (i < page.length && done.has(page[i]!.user_id)) i++;
    if (i > 0) out.after = page[i - 1]!.user_id;
    if (i < page.length) return out;
    if (page.length < PAGE) return { ...out, after: null };
  }
}

// ─── Preferring stored history (for hosted-timeline.ts) ───────────────────

const HISTORY_PAGE = 500;

/** Every stored day for one founder, oldest first, a page at a time (PostgREST caps rows per request). */
export async function storedHistory(rest: Rest, userId: string): Promise<SnapshotRow[]> {
  const out: SnapshotRow[] = [];
  for (;;) {
    const page = await rest.rows<SnapshotRow>('metric_snapshots', {
      where: { user_id: eq(userId), ...(out.length ? { day: gt(out.at(-1)!.day) } : {}) },
      order: 'day.asc',
      limit: HISTORY_PAGE,
    });
    out.push(...page);
    if (page.length < HISTORY_PAGE) return out;
  }
}

/**
 * Puts stored days in place of freshly built ones. Settled days (before the
 * settling window) come from `stored` where it has them; everything else
 * from `live`. Releases and commits are running totals, and a live build only
 * sees GitHub's recent history (1,000 commits, 500 releases), so live totals
 * are shifted to carry on from the last stored total: the day-to-day changes
 * stay exactly what GitHub reports. The result is one snapshot per day, as
 * the game expects; a day neither side knows (a hole in old stored history)
 * repeats the day before.
 */
export function withStoredHistory(live: Snapshot[], stored: SnapshotRow[], now: number): Snapshot[] {
  const settledBefore = startOfDay(now) - SETTLE_DAYS * DAY;
  const kept = new Map<number, Snapshot>();
  for (const r of stored) {
    const t = dayMs(r.day);
    if (t >= settledBefore) continue;
    kept.set(t, {
      t,
      customers: r.customers,
      mrr: Number(r.mrr),
      releases: r.releases,
      commits: r.commits,
      ...(r.users !== null ? { users: r.users } : {}),
      ...(r.release ? { release: r.release } : {}),
    });
  }
  if (!kept.size) return live;
  const lastKept = Math.max(...kept.keys());
  const anchor = kept.get(lastKept)!;
  // The live day the totals are lined up on: the last stored day, or (when the
  // live history starts later, say after switching repository) nothing, so its
  // totals count up from the stored ones.
  const junction = live.find((s) => s.t === lastKept);
  const base = junction ?? (live[0] && live[0].t > lastKept ? { releases: 0, commits: 0 } : null);
  const dReleases = base ? anchor.releases - base.releases : 0;
  const dCommits = base ? anchor.commits - base.commits : 0;
  const liveBy = new Map(live.map((s) => [s.t, { ...s, releases: Math.max(0, s.releases + dReleases), commits: Math.max(0, s.commits + dCommits) }]));

  const days = [...kept.keys(), ...liveBy.keys()];
  const out: Snapshot[] = [];
  for (let t = Math.min(...days), end = Math.max(...days); t <= end; t += DAY) {
    const prev = out.at(-1);
    const s = (t <= lastKept ? kept.get(t) : undefined) ?? liveBy.get(t);
    if (s) out.push(s);
    else if (prev) out.push({ t, customers: prev.customers, mrr: prev.mrr, releases: prev.releases, commits: prev.commits, ...(prev.users !== undefined ? { users: prev.users } : {}) });
  }
  return out;
}
