/**
 * Time and concurrency for the scheduled jobs. A Vercel Function is stopped
 * at its maximum duration, mid-write if need be, so each job works to a
 * budget well inside it: it stops starting new work near the end, lets what's
 * running finish (or stops waiting for it), saves where it got to, and the
 * next run carries on from there.
 */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
};

/** About 50 seconds of work per run (the function's limit is set to 60; see the report in docs). */
export const DEFAULT_BUDGET_MS = 50_000;

export class Budget {
  clock: Clock;
  deadline: number;
  constructor(clock: Clock, ms: number) {
    this.clock = clock;
    this.deadline = clock.now() + ms;
  }

  left(): number {
    return Math.max(0, this.deadline - this.clock.now());
  }

  /** Whether there's at least `ms` left: enough to start something that takes about that long. */
  has(ms: number): boolean {
    return this.left() >= ms;
  }

  /** A smaller budget inside this one, for one phase of a job. */
  slice(ms: number): Budget {
    return new Budget(this.clock, Math.min(ms, this.left()));
  }
}

export const TIMED_OUT = Symbol('timed out');

/**
 * Waits for `work` until the budget runs out. The work itself can't be
 * cancelled (it may be a provider call deep inside a timeline build), so on
 * a timeout it's left to finish or fail on its own; we just stop waiting.
 */
export async function withinBudget<T>(work: Promise<T>, budget: Budget): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((done) => (timer = setTimeout(() => done(TIMED_OUT), budget.left())));
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface PoolResult {
  /** Items whose work was started (finished, failed or timed out). */
  started: number;
  /** Items never started because time ran out or the run was stopped. */
  left: number;
}

/**
 * Runs `fn` over `items`, at most `limit` at a time, oldest first. A worker
 * only picks up the next item while at least `reserveMs` of the budget is
 * left (the time one item can reasonably take), and `stop()` lets an item
 * end the whole run early (a provider telling us to back off, say).
 */
export async function pool<T>(
  items: readonly T[],
  opts: { limit: number; budget: Budget; reserveMs: number },
  fn: (item: T, stop: () => void) => Promise<void>,
): Promise<PoolResult> {
  let next = 0;
  let stopped = false;
  const stop = () => (stopped = true);
  const worker = async () => {
    while (!stopped && next < items.length && opts.budget.has(opts.reserveMs)) {
      const item = items[next++]!;
      await fn(item, stop);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.limit, items.length)) }, worker));
  return { started: next, left: items.length - next };
}

/**
 * Retries `fn` while `retryable(err)` says so, with exponential backoff and
 * jitter (0.5 s, 1 s, 2 s…), honouring a provider's own wait when it gives
 * one, and never sleeping past the budget.
 */
export async function retrying<T>(
  fn: () => Promise<T>,
  opts: { budget: Budget; tries?: number; baseMs?: number; retryable: (err: unknown) => boolean; waitHint?: (err: unknown) => number | null },
): Promise<T> {
  const tries = opts.tries ?? 4;
  const base = opts.baseMs ?? 500;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= tries || !opts.retryable(err)) throw err;
      const wait = opts.waitHint?.(err) ?? base * 2 ** (attempt - 1) * (0.75 + Math.random() / 2);
      // Not enough time left to wait and try again: give up now, cleanly.
      if (!opts.budget.has(wait + 2_000)) throw err;
      await opts.budget.clock.sleep(wait);
    }
  }
}
