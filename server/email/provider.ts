import type { Env } from '../env.ts';

/**
 * Sending email, behind a small interface so Resend could be swapped for
 * Postmark (or anything with an HTTP API) by writing one more `EmailProvider`.
 * Resend is called over plain fetch: https://resend.com/docs/api-reference.
 *
 * Nothing here logs addresses, subjects or bodies: failures are logged by
 * status and error type only.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Extra headers, e.g. List-Unsubscribe on non-essential mail. */
  headers?: Record<string, string>;
  /** Provider-side labels for filtering logs (ASCII letters, digits, `_` and `-`). */
  tags?: Record<string, string>;
}

export interface EmailProvider {
  readonly name: string;
  /** Sends one message. `idempotencyKey` makes a retried call a no-op at the provider. */
  send(msg: EmailMessage, idempotencyKey: string): Promise<string>;
  /** Sends up to `maxBatch` messages in one call; ids come back in the same order. */
  sendBatch(msgs: EmailMessage[], idempotencyKey: string): Promise<string[]>;
  readonly maxBatch: number;
}

export interface EmailSettings {
  apiKey: string;
  /** `TinyTown <hello@mail.example.com>` */
  from: string;
  replyTo: string | null;
}

/** A failed send. `retryable` is false when trying again can't help (a bad address, a spent quota). */
export class EmailError extends Error {
  status: number;
  retryable: boolean;
  /** From a 429's Retry-After, capped. */
  waitMs: number;
  constructor(message: string, status: number, retryable: boolean, waitMs = 1_000) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.waitMs = waitMs;
  }
}

const trimmed = (env: Env, name: string) => env[name]?.trim() || null;

/** Sending is on only when both the key and a From address are set. */
export function emailSettings(env: Env): EmailSettings | null {
  const apiKey = trimmed(env, 'RESEND_API_KEY');
  const from = trimmed(env, 'EMAIL_FROM');
  if (!apiKey || !from) return null;
  return { apiKey, from, replyTo: trimmed(env, 'EMAIL_REPLY_TO') };
}

export function providerFor(env: Env, opts: { sleep?: (ms: number) => Promise<void> } = {}): EmailProvider | null {
  const s = emailSettings(env);
  return s ? resend(s, opts.sleep) : null;
}

// ─── Resend ────────────────────────────────────────────────────────────────

const RESEND = 'https://api.resend.com';
/** Resend takes at most 100 messages per batch call. */
const RESEND_BATCH = 100;
/** Tries per call: the first plus retries on 429, 5xx and network errors. */
const ATTEMPTS = 4;
/** Never wait longer than this between tries, whatever Retry-After says. */
const MAX_WAIT_MS = 10_000;

export const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Resend allows 10 requests a second for the whole team. Each server keeps
 * itself to 8, so a burst (an invite wave handing over 20 at a time) queues
 * here for a moment instead of bouncing off 429s. Slots are reserved before
 * waiting, so concurrent callers line up in order.
 */
const MIN_GAP_MS = 125;
let nextSlot = 0;

/** For tests: forget the pacing slot, so one test's sends don't make the next one wait. */
export function resetEmailPacing() {
  nextSlot = 0;
}

async function pace(sleep: (ms: number) => Promise<void>) {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + MIN_GAP_MS;
  if (at > now) await sleep(at - now);
}

const TAG = /[^A-Za-z0-9_-]/g;

export function resend(s: EmailSettings, sleep: (ms: number) => Promise<void> = realSleep): EmailProvider {
  const body = (m: EmailMessage) => ({
    from: s.from,
    to: [m.to],
    subject: m.subject,
    html: m.html,
    text: m.text,
    ...(s.replyTo ? { reply_to: s.replyTo } : {}),
    ...(m.headers ? { headers: m.headers } : {}),
    ...(m.tags ? { tags: Object.entries(m.tags).map(([name, value]) => ({ name: name.replace(TAG, '_'), value: value.replace(TAG, '_').slice(0, 256) })) } : {}),
  });

  async function post<T>(path: string, payload: unknown, idempotencyKey: string): Promise<T> {
    let last: EmailError | null = null;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (last) await sleep(last.status === 429 ? last.waitMs : 500 * 2 ** (attempt - 1));
      await pace(sleep);
      let res: Response;
      try {
        res = await fetch(`${RESEND}${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${s.apiKey}`,
            'Content-Type': 'application/json',
            // The same key on every retry: if an earlier try actually went
            // through, Resend answers with the original id and sends nothing.
            'Idempotency-Key': idempotencyKey,
            'User-Agent': 'tinytown-server',
          },
          body: JSON.stringify(payload),
        });
      } catch {
        last = new EmailError('network error', 0, true);
        continue;
      }
      if (res.ok) return (await res.json()) as T;
      last = await failure(res);
      if (!last.retryable) break;
    }
    throw last!;
  }

  return {
    name: 'resend',
    maxBatch: RESEND_BATCH,
    async send(msg, key) {
      const r = await post<{ id?: unknown }>('/emails', body(msg), key);
      return typeof r.id === 'string' ? r.id : '';
    },
    async sendBatch(msgs, key) {
      if (msgs.length > RESEND_BATCH) throw new EmailError(`batch of ${msgs.length} is over ${RESEND_BATCH}`, 0, false);
      const r = await post<{ data?: { id?: unknown }[] }>('/emails/batch', msgs.map(body), key);
      return msgs.map((_, i) => {
        const id = r.data?.[i]?.id;
        return typeof id === 'string' ? id : '';
      });
    },
  };
}

/**
 * Turns an error response into an EmailError. Resend's body is
 * `{ name, message, statusCode }`; only `name` (the error type, e.g.
 * `validation_error`) is kept, because messages can quote addresses.
 */
async function failure(res: Response): Promise<EmailError> {
  let name = 'error';
  try {
    const b = (await res.json()) as { name?: unknown };
    if (typeof b.name === 'string' && /^[a-z_]{1,64}$/.test(b.name)) name = b.name;
  } catch {
    // Not JSON; the status says enough.
  }
  const quota = name === 'daily_quota_exceeded' || name === 'monthly_quota_exceeded';
  // 409 concurrent_idempotent_requests: the first try is still in flight; asking again shortly is safe.
  const retryable = (res.status === 429 && !quota) || res.status >= 500 || name === 'concurrent_idempotent_requests';
  const after = Number(res.headers.get('retry-after'));
  const waitMs = Math.min(MAX_WAIT_MS, Number.isFinite(after) && after > 0 ? after * 1000 : 1_000);
  return new EmailError(`resend ${res.status} ${name}`, res.status, retryable, waitMs);
}
