import { DAY } from '../../src/data/types.ts';
import { isPaid } from '../../src/api/contract.ts';
import { planStatus, type SubscriptionRow } from '../store.ts';
import type { Budget } from './budget.ts';
import { gt, ifPresent, iso, isIn, lt, type Rest } from './rest.ts';

/**
 * Daily tidying. Only caches and logs go: the founder's history
 * (`metric_snapshots`), worlds and profiles are never touched here.
 */

/** A timeline cache is dropped once its founder has been without a plan this long. It's rebuilt if they come back. */
export const LAPSED_DAYS = 30;
/** Sent-email records are kept this long (the email module's table, if it exists). */
export const EMAIL_LOG_DAYS = 180;
/** No rate-limit window is longer than a day (0002); keep two to be safe. */
export const RATE_LIMIT_DAYS = 2;
/** Failed-refresh notes and connection breaks older than these are history nobody reads. */
export const REFRESH_NOTE_DAYS = 30;
export const BREAK_DAYS = 400;

const PAGE = 100;

export interface CleanupResult {
  timelines: number;
  /** Rows removed. Null when the table doesn't exist (or the count wasn't reported). */
  emailLog: number | null;
  rateLimits: number | null;
  refreshNotes: number | null;
  breaks: number | null;
  /** Out of time before the timeline sweep finished; the next run continues. */
  partial: boolean;
}

/** Timeline caches of founders without a plan for `LAPSED_DAYS`, a page at a time in user-id order. */
async function lapsedTimelines(rest: Rest, budget: Budget, now: number): Promise<{ removed: number; partial: boolean }> {
  const cutoff = iso(now - LAPSED_DAYS * DAY);
  let after: string | null = null;
  let removed = 0;
  for (;;) {
    if (!budget.has(3_000)) return { removed, partial: true };
    const page: { user_id: string }[] = await rest.rows<{ user_id: string }>('timelines', {
      select: 'user_id',
      where: { fetched_at: lt(cutoff), ...(after ? { user_id: gt(after) } : {}) },
      order: 'user_id.asc',
      limit: PAGE,
    });
    if (!page.length) return { removed, partial: false };
    after = page.at(-1)!.user_id;
    const ids = page.map((r) => r.user_id);
    const subs = await rest.rows<Pick<SubscriptionRow, 'user_id' | 'status'> & { updated_at: string }>('subscriptions', {
      select: 'user_id,status,updated_at',
      where: { user_id: isIn(ids) },
    });
    const byUser = new Map(subs.map((s) => [s.user_id, s]));
    // No plan, and no plan change in the last LAPSED_DAYS either (a plan that just ended still gets its grace).
    const lapsed = ids.filter((id) => {
      const s = byUser.get(id);
      return !s || (!isPaid(planStatus(s.status)) && Date.parse(s.updated_at) < Date.parse(cutoff));
    });
    if (lapsed.length) {
      // fetched_at again in the delete, so a cache rebuilt a moment ago survives.
      removed += (await rest.remove('timelines', { user_id: isIn(lapsed), fetched_at: lt(cutoff) })) ?? lapsed.length;
    }
    if (page.length < PAGE) return { removed, partial: false };
  }
}

export async function cleanup(rest: Rest, budget: Budget, now: number): Promise<CleanupResult> {
  const before = (days: number) => lt(iso(now - days * DAY));
  const timelines = await lapsedTimelines(rest, budget, now);
  return {
    timelines: timelines.removed,
    emailLog: await ifPresent<number | null>(() => rest.remove('email_log', { created_at: before(EMAIL_LOG_DAYS) }), null),
    rateLimits: await ifPresent<number | null>(() => rest.remove('rate_limits', { window_start: before(RATE_LIMIT_DAYS) }), null),
    refreshNotes: await rest.remove('timeline_refresh', { attempted_at: before(REFRESH_NOTE_DAYS) }),
    breaks: await rest.remove('connection_breaks', { detected_at: before(BREAK_DAYS) }),
    partial: timelines.partial,
  };
}
