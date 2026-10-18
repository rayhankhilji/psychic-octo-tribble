import { sha256 } from './crypto.ts';
import { serviceHeaders, type SupabaseConfig } from './supabase.ts';

/**
 * The shared half of the rate limiter: one counter per key in Postgres
 * (`public.rate_limits`, `public.rate_hit()` in migration 0002), so a limit
 * holds across every serverless instance instead of each counting alone.
 * `rateLimit()` in context.ts puts a cheap in-memory window in front of it.
 *
 * The database can be slow or down. Most limits then let the request
 * through (fail open), because refusing every founder to stop a hypothetical
 * abuser is the worse outage; limits on sign-in and webhooks fail closed.
 */

export interface SharedVerdict {
  allowed: boolean;
  /** Seconds until the window resets. */
  retryAfter: number;
}

/** How long a hit may take before we stop waiting. A healthy call takes 10 to 30 ms. */
export const SHARED_TIMEOUT_MS = 500;

/** After a failure, fail-open limits skip the database for this long instead of each waiting out the timeout. */
const BREAKER_MS = 30_000;
let brokenUntil = 0;
let lastLog = 0;

/**
 * Keys are hashed before they leave the server: they hold user ids and IP
 * addresses, and the table only ever needs to tell them apart.
 */
export const storedKey = (key: string) => sha256(key).slice(0, 40);

/**
 * Counts one hit against `key` in the shared table. Null when the database
 * couldn't answer in time (the caller decides whether that means yes or no).
 */
export async function sharedHit(
  cfg: SupabaseConfig,
  key: string,
  windowS: number,
  max: number,
  opts: { now?: number; timeoutMs?: number; ignoreBreaker?: boolean } = {},
): Promise<SharedVerdict | null> {
  const now = opts.now ?? Date.now();
  if (!opts.ignoreBreaker && now < brokenUntil) return null;
  try {
    // Plain fetch, not Db: this call has its own short timeout and no retries.
    const res = await fetch(`${cfg.url}/rest/v1/rpc/rate_hit`, {
      method: 'POST',
      headers: serviceHeaders(cfg),
      body: JSON.stringify({ p_key: storedKey(key), p_window_s: windowS, p_max: max }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? SHARED_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = (await res.json()) as unknown;
    // `returns table (...)` comes back as a one-row array.
    const row = (Array.isArray(body) ? body[0] : body) as { allowed?: unknown; retry_after_s?: unknown } | undefined;
    if (typeof row?.allowed !== 'boolean') throw new Error('unexpected answer');
    const retry = typeof row.retry_after_s === 'number' && row.retry_after_s > 0 ? row.retry_after_s : windowS;
    return { allowed: row.allowed, retryAfter: retry };
  } catch (err) {
    brokenUntil = now + BREAKER_MS;
    // One line a minute per instance is enough to notice; a line per request would bury everything else.
    if (now - lastLog > 60_000) {
      lastLog = now;
      const why = err instanceof Error ? (err.name === 'TimeoutError' ? `no answer in ${opts.timeoutMs ?? SHARED_TIMEOUT_MS} ms` : err.message) : 'unknown error';
      console.warn(`rate limit: shared counter unavailable (${why}); using this instance's memory only for ${BREAKER_MS / 1000} s`);
    }
    return null;
  }
}

/** For tests: forget a tripped breaker and the log throttle. */
export function resetSharedLimiter() {
  brokenUntil = 0;
  lastLog = 0;
}
