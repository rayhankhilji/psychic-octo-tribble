import { HttpError } from './http.ts';

type FormValue = string | number | boolean | null | undefined | FormValue[] | { [k: string]: FormValue };

/** Stripe's form encoding: `{ line_items: [{ price: 'p' }] }` → `line_items[0][price]=p`. */
export function form(params: Record<string, FormValue>): URLSearchParams {
  const out = new URLSearchParams();
  const walk = (prefix: string, v: FormValue) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${prefix}[${i}]`, x));
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(`${prefix}[${k}]`, x);
    else out.append(prefix, String(v));
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out;
}

export class StripeError extends Error {
  status: number;
  type: string | undefined;
  code: string | undefined;
  /** The request parameter Stripe objected to, e.g. `customer` for a deleted customer. */
  param: string | undefined;
  constructor(status: number, message: string, type?: string, code?: string, param?: string) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
    this.param = param;
  }
}

/**
 * The API version every call is made with, so a newer account default can't
 * change the shapes we read. Overridable with STRIPE_API_VERSION (the webhook
 * endpoint should be created with the same one; tools/stripe-setup.mjs does).
 */
export const STRIPE_API_VERSION = '2025-03-31.basil';

export interface StripeCallOptions {
  /** Makes a POST safe to repeat: Stripe replays the first answer for 24 hours. */
  idempotencyKey?: string;
  /** Pins the API version for this call (our own account). Founders' accounts use their own default. */
  apiVersion?: string;
}

/** Retries are short so a webhook or a click never waits long: two more tries after 0.3s and 0.9s. */
const RETRY_DELAYS_MS = [300, 900];
const TIMEOUT_MS = 10_000;
let retryScale = 1;

/** For tests: shrink (or remove) the pause between retries. */
export function setStripeRetryScale(scale: number) {
  retryScale = scale;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms * retryScale));

/**
 * One Stripe API call with a secret key or an OAuth access token. Errors keep
 * Stripe's message, never the key.
 *
 * Reads, and writes that carry an idempotency key, are retried on the
 * failures Stripe says are worth retrying: a dropped connection, a 409 while
 * the same key is still in flight, a 429 and a 5xx (or whatever the
 * `Stripe-Should-Retry` header says). A write without a key is never retried,
 * because it might have happened. A timeout isn't retried either, to keep
 * the total wait bounded; the caller's own retry (or Stripe's, for webhooks)
 * picks it up.
 */
export async function stripe<T>(
  key: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  params?: Record<string, FormValue>,
  options: string | StripeCallOptions = {},
): Promise<T> {
  const opts: StripeCallOptions = typeof options === 'string' ? { idempotencyKey: options } : options;
  const body = params ? form(params) : undefined;
  const url = method === 'GET' && body?.size ? `https://api.stripe.com${path}?${body}` : `https://api.stripe.com${path}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (method !== 'GET' && body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  if (opts.apiVersion) headers['Stripe-Version'] = opts.apiVersion;
  const retryable = method === 'GET' || !!opts.idempotencyKey;

  for (let attempt = 0; ; attempt++) {
    const canRetry = retryable && attempt < RETRY_DELAYS_MS.length;
    let res: Response;
    try {
      res = await fetch(url, { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS), ...(method !== 'GET' && body ? { body } : {}) });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      if (canRetry && !timedOut) {
        await pause(RETRY_DELAYS_MS[attempt]!);
        continue;
      }
      throw new StripeError(0, timedOut ? 'Stripe took too long to answer.' : 'Stripe could not be reached.');
    }
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string; type?: string; code?: string; param?: string } };
    if (res.ok) return data as T;
    const should = res.headers.get('Stripe-Should-Retry');
    const worthRetrying = should === 'true' || (should !== 'false' && (res.status === 409 || res.status === 429 || res.status >= 500));
    if (canRetry && worthRetrying) {
      await pause(RETRY_DELAYS_MS[attempt]!);
      continue;
    }
    throw new StripeError(res.status, data.error?.message ?? `Stripe responded ${res.status}`, data.error?.type, data.error?.code, data.error?.param);
  }
}

/** For routes: a Stripe failure the founder can read, as a 502. */
export function stripeFailure(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  // Status 0: we never got an answer, and the message already says so.
  if (err instanceof StripeError && err.status === 0) return new HttpError(502, err.message, 'upstream');
  const message = err instanceof StripeError ? err.message : 'Stripe could not be reached.';
  return new HttpError(502, `Stripe: ${message}`, 'upstream');
}
