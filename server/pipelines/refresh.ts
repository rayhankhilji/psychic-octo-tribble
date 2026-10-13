import { DAY, startOfDay, type Timeline } from '../../src/data/types.ts';
import type { Hosted } from '../context.ts';
import { decrypt } from '../crypto.ts';
import { decryptionKeys } from '../env.ts';
import { installationToken } from '../github-app.ts';
import { userTimeline } from '../hosted-timeline.ts';
import { HttpError } from '../http.ts';
import { notify } from '../notify.ts';
import { monthlyActiveUsers, posthogOrigin } from '../posthog.ts';
import type { ConnectionRow, ProfileRow, Provider, TimelineRow } from '../store.ts';
import { accessToken } from '../stripe-app.ts';
import { TIMED_OUT, pool, withinBudget, type Budget } from './budget.ts';
import { eq, gte, iso, lt, type Rest } from './rest.ts';
import { recordSnapshots } from './snapshots.ts';

/**
 * The hourly refresh: paying founders' timelines rebuilt before they ask,
 * so the city opens on fresh numbers and every day gets written down. Uses
 * the same `userTimeline` the app does (its cache, its single-flight, its
 * fallback to the cached copy). Founders who visited in the last 14 days come
 * first, oldest refresh first; then, with time to spare, every other paying
 * founder not yet refreshed today, so their history has no gaps either.
 */

export const ACTIVE_DAYS = 14;
/** Refreshed this recently: leave it. Under an hour, so an hourly run never skips a founder by a few seconds. */
export const STALE_AFTER_MS = 45 * 60_000;
/** At most this many founders per run; the rest wait for the next one. */
export const MAX_PER_RUN = 400;
/** A rebuild usually takes a second or two; don't start one with less than this left. */
const RESERVE_MS = 8_000;
/** This many provider failures in a row and the run stops: something upstream is unhappy (or limiting us). */
export const TRIP_AFTER = 8;
/** After a broken connection, wait a day before trying again (a visit after reconnecting rebuilds sooner). */
const BROKEN_RETRY_MS = DAY;

interface QueueRow {
  user_id: string;
  touched_at: string;
  failures: number;
}

export interface RefreshResult {
  candidates: number;
  refreshed: number;
  failed: number;
  broken: number;
  timedOut: number;
  snapshotRows: number;
  /** Founders left for the next run (out of time, or stopped early). */
  left: number;
  tripped: boolean;
}

export async function refreshQueue(rest: Rest, now: number): Promise<QueueRow[]> {
  const select = 'user_id,touched_at,failures';
  const common = { retry_at: lt(iso(now)) };
  const order = 'touched_at.asc,user_id.asc';
  const active = await rest.rows<QueueRow>('pipeline_refresh_queue', {
    select,
    where: { ...common, last_seen: gte(startOfDay(now) - ACTIVE_DAYS * DAY), touched_at: lt(iso(now - STALE_AFTER_MS)) },
    order,
    limit: MAX_PER_RUN,
  });
  if (active.length >= MAX_PER_RUN) return active;
  const seen = new Set(active.map((r) => r.user_id));
  const rest_ = await rest.rows<QueueRow>('pipeline_refresh_queue', {
    select,
    where: { ...common, touched_at: lt(iso(startOfDay(now))) },
    order,
    limit: MAX_PER_RUN,
  });
  return [...active, ...rest_.filter((r) => !seen.has(r.user_id))].slice(0, MAX_PER_RUN);
}

export async function refreshTimelines(ctx: Hosted, rest: Rest, budget: Budget, concurrency: number): Promise<RefreshResult> {
  const queue = await refreshQueue(rest, ctx.now);
  const out: RefreshResult = { candidates: queue.length, refreshed: 0, failed: 0, broken: 0, timedOut: 0, snapshotRows: 0, left: 0, tripped: false };
  let failuresInARow = 0;

  const { left } = await pool(queue, { limit: concurrency, budget, reserveMs: RESERVE_MS }, async (row, stop) => {
    const outcome = await refreshOne(ctx, rest, budget, row);
    if (outcome.kind === 'ok') {
      out.refreshed++;
      out.snapshotRows += outcome.snapshotRows;
      failuresInARow = 0;
      return;
    }
    if (outcome.kind === 'broken') out.broken++;
    else if (outcome.kind === 'timeout') out.timedOut++;
    else out.failed++;
    // A broken connection is the founder's to fix; it says nothing about the provider.
    if (outcome.kind !== 'broken' && ++failuresInARow >= TRIP_AFTER) {
      out.tripped = true;
      stop();
    }
  });
  out.left = left;
  return out;
}

type Outcome = { kind: 'ok'; snapshotRows: number } | { kind: 'broken' | 'failed' | 'timeout' | 'skipped' };

async function refreshOne(ctx: Hosted, rest: Rest, budget: Budget, row: QueueRow): Promise<Outcome> {
  const userId = row.user_id;
  try {
    const profile = await ctx.db.one<ProfileRow>('profiles', { user_id: userId });
    if (!profile) return { kind: 'skipped' };
    const result = await withinBudget(
      userTimeline(ctx, profile).then(
        (timeline) => ({ timeline }),
        (err: unknown) => ({ err }),
      ),
      budget,
    );
    if (result === TIMED_OUT) {
      await recordFailure(rest, ctx.now, row, 'timeout');
      return { kind: 'timeout' };
    }
    if ('err' in result) {
      const err = result.err;
      if (err instanceof HttpError && err.code === 'not_connected') {
        await recordFailure(rest, ctx.now, row, 'not_connected', BROKEN_RETRY_MS);
        await noticeBreaks(ctx, profile);
        return { kind: 'broken' };
      }
      await recordFailure(rest, ctx.now, row, 'upstream');
      return { kind: 'failed' };
    }
    // `userTimeline` serves the cached copy when a rebuild fails; only a row
    // stamped by this run counts as fresh.
    const fresh = await rest.rows<Pick<TimelineRow, 'fetched_at'>>('timelines', { select: 'fetched_at', where: { user_id: eq(userId) }, limit: 1 });
    if (!fresh[0] || Date.parse(fresh[0].fetched_at) < ctx.now) {
      await recordFailure(rest, ctx.now, row, 'upstream');
      return { kind: 'failed' };
    }
    return { kind: 'ok', snapshotRows: await recordSnapshots(rest, userId, result.timeline as Timeline, ctx.now) };
  } catch (err) {
    // Our own database failing for one founder: note it and move on.
    console.error(`Refresh for ${userId} failed: ${err instanceof Error ? err.message : 'unknown'}`);
    return { kind: 'failed' };
  }
}

/** Backs off a failing founder: 1, 2, 4, 8… hours, at most a day. */
export function retryDelay(failures: number): number {
  return Math.min(DAY, 30 * 60_000 * 2 ** Math.min(failures, 10));
}

async function recordFailure(rest: Rest, now: number, row: QueueRow, code: string, delay?: number) {
  const failures = row.failures + 1;
  await rest.upsertMany(
    'timeline_refresh',
    [{ user_id: row.user_id, attempted_at: iso(now), failures, retry_at: iso(now + (delay ?? retryDelay(failures))), error_code: code }],
    'user_id',
  );
}

// ─── Broken connections ───────────────────────────────────────────────────

/**
 * Which of the founder's connections can no longer be used. The timeline
 * error doesn't say which one failed, so each is asked directly with the same
 * calls the build makes; only an answer of "reconnect" counts, never a
 * provider being down.
 */
async function brokenProviders(ctx: Hosted, profile: ProfileRow, rows: ConnectionRow[]): Promise<ConnectionRow[]> {
  const broken: ConnectionRow[] = [];
  const dead = (err: unknown) => err instanceof HttpError && err.code === 'not_connected';
  for (const row of rows) {
    try {
      if (row.provider === 'stripe') {
        // Test-mode connections are ignored by the build (unless ALLOW_TEST_MODE), not broken.
        if (!(row.livemode || ctx.s.allowTestMode) || !ctx.s.stripeApp) continue;
        await accessToken(ctx, row);
      } else if (row.provider === 'github') {
        if (!ctx.s.githubApp || typeof row.metadata.repo !== 'string') continue;
        await installationToken(ctx.s.githubApp, row.account_id, ctx.now);
      } else if (row.provider === 'posthog') {
        // Only counts while it's the population source; otherwise the build never uses it.
        if (profile.users_source !== 'posthog' || !row.secret || !ctx.s.secrets) continue;
        let key: string;
        try {
          key = decrypt(row.secret, decryptionKeys(ctx.s.secrets), `${row.user_id}:posthog`);
        } catch {
          broken.push(row);
          continue;
        }
        await monthlyActiveUsers(posthogOrigin(String(row.metadata.host), ctx.s.posthog.hosts), row.account_id, key);
      }
    } catch (err) {
      if (dead(err)) broken.push(row);
    }
  }
  return broken;
}

/**
 * Records each newly broken connection and tells the founder once. The row
 * in `connection_breaks` is keyed by the connection's `connected_at`, and
 * only the run whose insert lands sends the notice, so overlapping runs and
 * later runs stay quiet until the founder reconnects and it breaks again.
 */
export async function noticeBreaks(ctx: Hosted, profile: ProfileRow): Promise<Provider[]> {
  const userId = profile.user_id;
  const rows = await ctx.db.many<ConnectionRow>('connections', { user_id: userId });
  const told: Provider[] = [];
  for (const row of await brokenProviders(ctx, profile, rows)) {
    const inserted = await ctx.db.upsert(
      'connection_breaks',
      { user_id: userId, provider: row.provider, connected_at: row.connected_at, detected_at: iso(ctx.now) },
      'user_id,provider,connected_at',
      'ignore',
    );
    if (!inserted) continue;
    // The connection's own start as the email's reference, so the email module dedupes the same way.
    await notify(ctx, { kind: 'connection.broken', userId, provider: row.provider, ref: `c${Date.parse(row.connected_at)}` });
    await ctx.db.update('connection_breaks', { user_id: userId, provider: row.provider, connected_at: row.connected_at }, { notified_at: iso(ctx.now) });
    told.push(row.provider);
  }
  return told;
}
