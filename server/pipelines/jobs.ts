import type { Clock } from './budget.ts';
import { eq, iso, lte, type Rest } from './rest.ts';

/**
 * Leases and cursors for the scheduled jobs, in `cron_jobs`. Vercel can
 * deliver one scheduled run twice, and a run that overruns can meet the
 * next; the lease makes the second one step aside. A run that dies without
 * releasing (killed at the function's time limit) holds the lease only
 * until it expires.
 */

export type JobName = 'hourly' | 'daily' | 'weekly';

export interface JobRow {
  job: JobName;
  lease_until: string;
  cursor: Record<string, unknown> | null;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_ok_at: string | null;
  last_result: Record<string, unknown>;
}

/** Longer than any run (about a minute), much shorter than the gap between runs. */
export const LEASE_MS = 10 * 60_000;

export interface Lease {
  job: JobName;
  until: string;
  /** Where the last run stopped, if it didn't finish. */
  cursor: Record<string, unknown> | null;
  row: JobRow;
}

/** Takes the job's lease, or returns null if another run holds it. One atomic UPDATE … WHERE lease_until <= now. */
export async function claim(rest: Rest, job: JobName, clock: Clock): Promise<Lease | null> {
  const now = clock.now();
  const until = iso(now + LEASE_MS);
  const take = () => rest.patch<JobRow>('cron_jobs', { job: eq(job), lease_until: lte(iso(now)) }, { lease_until: until, last_started_at: iso(now) });
  let rows = await take();
  if (!rows.length) {
    // Either someone holds it, or the row was never made (the migration seeds
    // it, but be forgiving): make it if missing and try once more.
    await rest.upsertMany('cron_jobs', [{ job }], 'job', 'ignore');
    rows = await take();
  }
  const row = rows[0];
  return row ? { job, until, cursor: row.cursor ?? null, row } : null;
}

/** Saves the cursor (null when the work is done) and the run's result, and lets go of the lease. */
export async function release(rest: Rest, lease: Lease, clock: Clock, outcome: { ok: boolean; cursor: Record<string, unknown> | null; result: Record<string, unknown> }) {
  const now = iso(clock.now());
  // Only if we still hold it: a run that overran its lease mustn't stomp on the next one's.
  await rest.patch('cron_jobs', { job: eq(lease.job), lease_until: eq(lease.until) }, {
    lease_until: now,
    cursor: outcome.cursor,
    last_finished_at: now,
    ...(outcome.ok ? { last_ok_at: now } : {}),
    last_result: outcome.result,
  });
}

/** Reads a job's row without taking it (to see whether the daily job left work behind). */
export async function peek(rest: Rest, job: JobName): Promise<JobRow | null> {
  return (await rest.rows<JobRow>('cron_jobs', { where: { job: eq(job) }, limit: 1 }))[0] ?? null;
}
