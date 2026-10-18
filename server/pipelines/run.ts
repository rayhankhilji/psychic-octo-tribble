import { DAY, startOfDay } from '../../src/data/types.ts';
import { reconcileSubscriptions } from '../billing.ts';
import type { Hosted } from '../context.ts';
import { Budget, DEFAULT_BUDGET_MS, realClock, type Clock } from './budget.ts';
import { cleanup, type CleanupResult } from './cleanup.ts';
import { claim, peek, release, type JobName, type Lease } from './jobs.ts';
import { recordProductDays } from './product.ts';
import { refreshTimelines } from './refresh.ts';
import { Rest, dayMs, dayString } from './rest.ts';
import { snapshotPass } from './snapshots.ts';

/**
 * The three scheduled jobs. Each takes its lease (a duplicate delivery steps
 * aside), works to a time budget, and saves a cursor if it runs out, so the
 * next run carries on. Every step is idempotent: running a job twice, or
 * re-running a day, leaves the same rows behind.
 */

export interface RunOptions {
  clock?: Clock;
  budgetMs?: number;
  /** Timeline rebuilds at once. Each founder's Stripe and GitHub limits are their own; ours are the token endpoints and the database. */
  concurrency?: number;
  /** The weekly digest; by default `weeklyDigest` from server/email/digest.ts, if that module exists. */
  digest?: () => Promise<DigestFn | null>;
}

export type DigestFn = (ctx: Hosted, now: number) => Promise<unknown>;

export const CONCURRENCY = 4;
/** The weekly job's slot in vercel.json: Mondays at 15:23 UTC. */
const WEEKLY_AT_MS = (15 * 60 + 23) * 60_000;
/** Plans re-read from Stripe per daily run (one call each, about a third of a second); there are rarely more than a handful. */
const RECONCILE_LIMIT = 40;
/** When the hourly job finds the daily job unfinished, it gives it at most this much of its own time. */
const DAILY_CATCH_UP_MS = 20_000;

export type JobResult = Record<string, unknown> & { job: JobName; ok: boolean };

function setup(ctx: Hosted, opts: RunOptions) {
  const clock = opts.clock ?? realClock;
  return { clock, rest: new Rest(ctx.supabase), budget: new Budget(clock, opts.budgetMs ?? DEFAULT_BUDGET_MS), concurrency: opts.concurrency ?? CONCURRENCY };
}

/** Holds the lease for `fn`, always lets go of it, and records the outcome. */
async function leased(
  rest: Rest,
  clock: Clock,
  job: JobName,
  fn: (lease: Lease) => Promise<{ result: Record<string, unknown>; cursor: Record<string, unknown> | null }>,
): Promise<JobResult> {
  const started = clock.now();
  const lease = await claim(rest, job, clock);
  if (!lease) return { job, ok: true, skipped: 'already running' };
  try {
    const { result, cursor } = await fn(lease);
    const out = { job, ok: true, ...result, ms: clock.now() - started };
    await release(rest, lease, clock, { ok: true, cursor, result: out });
    return out;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    // Keep the cursor as it was, so the next run retries from the same place.
    await release(rest, lease, clock, { ok: false, cursor: lease.cursor, result: { job, ok: false, error: message.slice(0, 200), ms: clock.now() - started } }).catch(() => {});
    throw err;
  }
}

// ─── Hourly ───────────────────────────────────────────────────────────────

/** Another job's leftovers, run inside the hourly job; its failure is reported, not the hourly job's. */
async function catchUp(job: JobName, fn: () => Promise<JobResult>): Promise<JobResult> {
  try {
    return await fn();
  } catch (err) {
    console.error(`Catching up the ${job} job failed: ${err instanceof Error ? err.message : 'unknown'}`);
    return { job, ok: false, error: err instanceof Error ? err.message.slice(0, 200) : 'unknown' };
  }
}

export async function runHourly(ctx: Hosted, opts: RunOptions = {}): Promise<JobResult> {
  const { clock, rest, budget, concurrency } = setup(ctx, opts);
  return leased(rest, clock, 'hourly', async () => {
    // A daily run that ran out of time carries on here, before the refresh.
    let daily: JobResult | null = null;
    const state = await peek(rest, 'daily');
    const cursor = state?.cursor as DailyCursor | null | undefined;
    if (cursor && cursor.phase !== 'done' && cursor.day === dayString(startOfDay(ctx.now) - DAY)) {
      daily = await catchUp('daily', () => runDaily(ctx, { ...opts, clock, budgetMs: Math.min(DAILY_CATCH_UP_MS, budget.left()) }));
    }
    const refresh = await refreshTimelines(ctx, rest, budget, concurrency);
    // Likewise a weekly digest that failed or was cut off, for a day after its slot.
    let weekly: JobResult | null = null;
    const slot = dayMs(weekOf(ctx.now)) + WEEKLY_AT_MS;
    if (ctx.now >= slot && ctx.now < slot + DAY && budget.has(15_000)) {
      const w = await peek(rest, 'weekly');
      if ((w?.cursor as { week?: string } | null)?.week !== weekOf(ctx.now)) weekly = await catchUp('weekly', () => runWeekly(ctx, { ...opts, clock, budgetMs: budget.left() }));
    }
    return { result: { refresh, ...(daily ? { daily } : {}), ...(weekly ? { weekly } : {}) }, cursor: null };
  });
}

// ─── Daily ────────────────────────────────────────────────────────────────

interface DailyCursor extends Record<string, unknown> {
  /** The day being recorded (the one that just ended). */
  day: string;
  phase: 'product' | 'snapshots' | 'cleanup' | 'done';
  /** Snapshot pass: the last founder done. */
  after?: string | null;
}

export async function runDaily(ctx: Hosted, opts: RunOptions = {}): Promise<JobResult> {
  const { clock, rest, budget, concurrency } = setup(ctx, opts);
  const yesterday = startOfDay(ctx.now) - DAY;
  const day = dayString(yesterday);
  return leased(rest, clock, 'daily', async (lease) => {
    const saved = lease.cursor as DailyCursor | null;
    // A cursor from an earlier day is abandoned: today's pass covers the same ground.
    let cursor: DailyCursor = saved?.day === day ? saved : { day, phase: 'product' };
    if (cursor.phase === 'done') return { result: { day, skipped: 'already done' }, cursor };
    const result: Record<string, unknown> = { day };

    if (cursor.phase === 'product') {
      // First billing's safety net for lost webhooks, so the day's plan counts are current.
      result.reconcile = await reconcileSubscriptions(ctx, RECONCILE_LIMIT).catch((err: unknown) => {
        console.error(`Reconciling plans failed: ${err instanceof Error ? err.message : 'unknown'}`);
        return { error: true };
      });
      result.product = await recordProductDays(ctx, rest, budget, yesterday);
      cursor = { day, phase: 'snapshots', after: null };
    }
    if (cursor.phase === 'snapshots') {
      const pass = await snapshotPass(ctx, rest, budget, cursor.after ?? null, concurrency);
      result.snapshots = pass;
      if (pass.after) return { result: { ...result, partial: true }, cursor: { day, phase: 'snapshots', after: pass.after } };
      cursor = { day, phase: 'cleanup' };
    }
    if (cursor.phase === 'cleanup') {
      const tidy: CleanupResult = await cleanup(rest, budget, ctx.now);
      result.cleanup = tidy;
      // An unfinished sweep of old caches simply carries on tomorrow.
      cursor = { day, phase: 'done' };
    }
    return { result, cursor };
  });
}

// ─── Weekly ───────────────────────────────────────────────────────────────

/**
 * The weekly digest lives in the email module (server/email/digest.ts). It's
 * found through Vite's import.meta.glob, which the Vercel build and the tests
 * resolve at build time (an empty match if the file doesn't exist yet), with
 * a plain dynamic import for the local Node server, which has no Vite.
 */
export async function loadDigest(): Promise<DigestFn | null> {
  let mod: { weeklyDigest?: unknown } | null = null;
  try {
    let loaders: Record<string, () => Promise<unknown>> | null = null;
    try {
      loaders = import.meta.glob('../email/digest.ts');
    } catch {
      // Plain Node: no import.meta.glob.
    }
    if (loaders) {
      const load = loaders['../email/digest.ts'];
      mod = load ? ((await load()) as { weeklyDigest?: unknown }) : null;
    } else {
      const path = new URL('../email/digest.ts', import.meta.url).href;
      mod = (await import(/* @vite-ignore */ path)) as { weeklyDigest?: unknown };
    }
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === 'ERR_MODULE_NOT_FOUND') return null;
    throw err;
  }
  if (!mod) return null;
  if (typeof mod.weeklyDigest !== 'function') throw new Error('server/email/digest.ts has no weeklyDigest export');
  return mod.weeklyDigest as DigestFn;
}

/** Monday of the week `now` is in, as a date: the digest's idempotency key. */
export const weekOf = (now: number) => dayString(startOfDay(now) - ((new Date(now).getUTCDay() + 6) % 7) * DAY);

export async function runWeekly(ctx: Hosted, opts: RunOptions = {}): Promise<JobResult> {
  const { clock, rest } = setup(ctx, opts);
  const week = weekOf(ctx.now);
  return leased(rest, clock, 'weekly', async (lease) => {
    const saved = lease.cursor as { week?: string } | null;
    if (saved?.week === week) return { result: { week, skipped: 'already sent' }, cursor: saved };
    const digest = await (opts.digest ?? loadDigest)();
    if (!digest) {
      console.warn('Weekly digest skipped: server/email/digest.ts is not there yet.');
      // No cursor: once the module ships, the next run sends this week's digest.
      return { result: { week, skipped: 'no digest module' }, cursor: null };
    }
    const summary = (await digest(ctx, ctx.now)) as Record<string, unknown> | null | undefined;
    // A digest that ran out of time says so (`done: false` or founders `left`);
    // the week stays open and the hourly job runs it again (anyone sent is skipped).
    const unfinished = !!summary && (summary.done === false || (typeof summary.left === 'number' && summary.left > 0));
    return { result: { week, digest: summary && typeof summary === 'object' ? summary : { done: true }, ...(unfinished ? { partial: true } : {}) }, cursor: unfinished ? null : { week } };
  });
}
