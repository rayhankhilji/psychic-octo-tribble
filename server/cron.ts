import { hosted, type Ctx, type Hosted } from './context.ts';
import { safeEqual, sha256 } from './crypto.ts';
import type { Extension } from './extensions.ts';
import { HttpError, bearer, json, notConfigured } from './http.ts';
import { runDaily, runHourly, runWeekly, type JobResult } from './pipelines/run.ts';

/**
 * Scheduled jobs, called by Vercel Cron (schedules in vercel.json):
 *
 *   GET /api/cron/hourly   minute 7 of every hour   refresh paying founders' timelines
 *   GET /api/cron/daily    03:17 UTC                metric history, our own numbers, tidying
 *   GET /api/cron/weekly   Mondays 15:23 UTC        the weekly digest email
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET`. Without CRON_SECRET the
 * jobs don't run at all (503), so a forgotten variable can't leave them open.
 * The work itself is in server/pipelines/.
 */

const JOBS: Record<string, (ctx: Hosted) => Promise<JobResult>> = {
  '/api/cron/hourly': (ctx) => runHourly(ctx),
  '/api/cron/daily': (ctx) => runDaily(ctx),
  '/api/cron/weekly': (ctx) => runWeekly(ctx),
};

/** Vercel recommends at least 16 random characters; anything shorter is refused rather than trusted. */
const MIN_SECRET_LENGTH = 16;

/** 503 without a usable CRON_SECRET, 401 unless the caller presents it. Compared as hashes, so neither length nor content leaks through timing. */
export function authorizeCron(ctx: Ctx) {
  const secret = ctx.env.CRON_SECRET?.trim();
  if (!secret || secret.length < MIN_SECRET_LENGTH) throw notConfigured('Scheduled jobs');
  const token = bearer(ctx.req);
  if (!token || !safeEqual(sha256(token), sha256(secret))) throw new HttpError(401, 'Not authorised.', 'unauthenticated');
}

export const cronExtension: Extension = {
  match: (path) => path === '/api/cron' || path.startsWith('/api/cron/'),
  handle: async (ctx) => {
    // The secret first: nothing about the jobs is told to anyone else.
    authorizeCron(ctx);
    const job = JOBS[ctx.url.pathname.replace(/\/+$/, '')];
    if (!job) throw new HttpError(404, 'Not found.', 'bad_request');
    if (ctx.req.method !== 'GET') throw new HttpError(405, 'Method not allowed.', 'bad_request');
    const result = await job(hosted(ctx));
    return json(result);
  },
};
