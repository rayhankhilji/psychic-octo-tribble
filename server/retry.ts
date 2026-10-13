/**
 * Every upstream call (Supabase, Stripe, GitHub) goes through here, so none
 * of them can hang a request forever or give up on the first hiccup.
 *
 * - Each attempt has a timeout (8 s by default); a caller can also pass an
 *   overall deadline (`signal`) that covers retries and paging.
 * - Only requests that are safe to repeat are retried: GET, HEAD, PUT and
 *   DELETE, and a POST that carries an `Idempotency-Key`. A plain POST or a
 *   PATCH might have landed before the connection dropped, so it's never sent twice.
 * - Retries happen on 429 and 5xx and on network failures, after a jittered
 *   backoff, or after the `Retry-After` the server asked for if that's
 *   short. A longer `Retry-After` returns the response straight away rather
 *   than holding the founder's request open.
 * - A timed-out attempt isn't retried: something that slow would only make
 *   the founder wait twice as long for the same error.
 */

export interface RetryOptions {
  /** Per attempt, including reading the body. */
  timeoutMs?: number;
  /** Extra attempts after the first. */
  retries?: number;
  /** An overall deadline or cancellation for every attempt and wait. */
  signal?: AbortSignal;
  /** The backoff before retry n is a random wait up to `baseMs * 2^n`. */
  baseMs?: number;
  /** The longest wait we'll do, whether from backoff or `Retry-After`. */
  maxDelayMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 8_000;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

/** Raised when an attempt (or the overall deadline) runs out of time. */
export class UpstreamTimeout extends Error {
  constructor(url: string) {
    super(`${new URL(url).host} took too long to respond.`);
    this.name = 'UpstreamTimeout';
  }
}

export function idempotent(init: RequestInit): boolean {
  const method = (init.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'PUT' || method === 'DELETE' || method === 'OPTIONS') return true;
  return method === 'POST' && new Headers(init.headers).has('Idempotency-Key');
}

/** `Retry-After` in ms: seconds or an HTTP date. Null when absent or unreadable. */
export function retryAfterMs(res: Response, now = Date.now()): number | null {
  const v = res.headers.get('Retry-After')?.trim();
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * A timeout signal built on setTimeout, so tests can drive it with fake
 * timers. Unref'd: a pending timeout never keeps the process alive.
 */
function timeoutSignal(ms: number): AbortSignal {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
  (t as { unref?: () => void }).unref?.();
  return ctrl.signal;
}

/** A deadline for several calls (paging through Stripe, say). */
export const deadline = timeoutSignal;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const isTimeout = (err: unknown) => err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError');

export async function fetchWithRetry(url: string | URL, init: RequestInit = {}, opts: RetryOptions = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 2, baseMs = 300, maxDelayMs = 4_000, signal } = opts;
  const href = String(url);
  const canRetry = idempotent(init);
  for (let attempt = 0; ; attempt++) {
    const last = !canRetry || attempt >= retries;
    const attemptSignal = signal ? AbortSignal.any([timeoutSignal(timeoutMs), signal]) : timeoutSignal(timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: attemptSignal });
    } catch (err) {
      if (isTimeout(err) || attemptSignal.aborted) throw new UpstreamTimeout(href);
      // Connection refused or reset (fetch reports those as a TypeError): worth another go if repeating is safe.
      if (last || !(err instanceof TypeError)) throw err;
      await sleep(Math.random() * baseMs * 2 ** attempt, signal).catch(() => {
        throw new UpstreamTimeout(href);
      });
      continue;
    }
    if (last || !RETRY_STATUS.has(res.status)) return res;
    const asked = retryAfterMs(res);
    if (asked !== null && asked > maxDelayMs) return res;
    const wait = asked ?? Math.min(maxDelayMs, Math.random() * baseMs * 2 ** attempt);
    await res.body?.cancel().catch(() => {});
    await sleep(wait, signal).catch(() => {
      throw new UpstreamTimeout(href);
    });
  }
}
