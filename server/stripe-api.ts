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
  constructor(status: number, message: string, type?: string, code?: string) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
  }
}

/** One Stripe API call with a secret key or an OAuth access token. Errors keep Stripe's message, never the key. */
export async function stripe<T>(
  key: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  params?: Record<string, FormValue>,
  idempotencyKey?: string,
): Promise<T> {
  const body = params ? form(params) : undefined;
  const url = method === 'GET' && body?.size ? `https://api.stripe.com${path}?${body}` : `https://api.stripe.com${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(method !== 'GET' && body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    ...(method !== 'GET' && body ? { body } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: { message?: string; type?: string; code?: string } };
  if (!res.ok) throw new StripeError(res.status, data.error?.message ?? `Stripe responded ${res.status}`, data.error?.type, data.error?.code);
  return data as T;
}

/** For routes: a Stripe failure the founder can read, as a 502. */
export function stripeFailure(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  const message = err instanceof StripeError ? err.message : 'Stripe could not be reached.';
  return new HttpError(502, `Stripe: ${message}`, 'upstream');
}
