import { randomBytes } from 'node:crypto';
import type { Ctx } from './context.ts';
import type { Env } from './env.ts';

/**
 * What the server says about itself: one JSON line per event on stdout
 * (info) or stderr (warn, error), which Vercel's log viewer and any log
 * drain (Better Stack, Axiom, Datadog) can filter by field. Lines carry a
 * request id, the route, the status, the time taken and the signed-in user's
 * id: never an email, a token, a header or a request body. Unexpected
 * failures also go to Sentry when `SENTRY_DSN` is set.
 */

// ─── Redaction ────────────────────────────────────────────────────────────

/**
 * Patterns for things that must never reach a log line or a third party,
 * whatever string they turn up in: an error message that echoes a URL, a
 * browser stack trace, a value someone typed.
 */
const SCRUB: [RegExp, string][] = [
  // Query and fragment parameters that carry credentials (Supabase puts tokens in the hash after a magic link).
  [/([?&#](?:access_token|refresh_token|id_token|provider_token|token|code|state|key|api_key|apikey|password|secret|signature|sig)=)[^&#\s"'<>]+/gi, '$1[redacted]'],
  [/\b(Bearer|Basic|token)\s+[\w.~+/=-]{8,}/gi, '$1 [redacted]'],
  [/\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}/g, '[jwt]'],
  // Stripe, GitHub, Supabase, PostHog, Resend and Sentry key shapes.
  [/\b(?:sk|rk|pk)_(?:live|test)_\w{6,}|\bwhsec_\w{6,}|\bgh[pousr]_\w{16,}|\bgithub_pat_\w{16,}|\bsb_(?:secret|publishable)_[\w-]{8,}|\bph[cx]_\w{16,}|\bre_\w{16,}/g, '[key]'],
  [/-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|$)/g, '[pem]'],
  [/[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi, '[email]'],
  // Long opaque runs are almost always tokens; identifiers and file names are shorter.
  [/(?<![\w/.-])[A-Za-z0-9_-]{40,}={0,2}(?![\w/.-])/g, '[redacted]'],
];

/** `text` with anything that looks like a secret or an email replaced. */
export function redact(text: string): string {
  let out = text;
  for (const [re, sub] of SCRUB) out = out.replace(re, sub);
  return out;
}

export const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Field names whose values are dropped outright, whatever they hold. */
const SENSITIVE_KEY = /pass(?:word)?|secret|token|authori[sz]ation|cookie|api[-_]?key|private[-_]?key|signature|e-?mail|^body$|^dsn$|^ip$/i;

/**
 * A copy of `value` that's safe to log: sensitive keys dropped, strings
 * redacted and clipped, errors reduced to their type, message and stack,
 * and nesting and lists kept short so one line stays one line.
 */
export function scrub(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string') return clip(redact(value), 2000);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    return { type: value.name, message: clip(redact(value.message), 500), ...(value.stack ? { stack: clip(redact(value.stack), 4000) } : {}) };
  }
  if (depth >= 3 || typeof value !== 'object') return typeof value === 'object' ? '[object]' : undefined;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value).slice(0, 40)) {
    if (v === undefined) continue;
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : scrub(v, depth + 1);
  }
  return out;
}

// ─── Lines ────────────────────────────────────────────────────────────────

export type Level = 'info' | 'warn' | 'error';
export type Fields = Record<string, unknown>;

function emit(level: Level, msg: string, fields: Fields = {}) {
  const line = { level, time: new Date().toISOString(), msg: clip(redact(msg), 300), ...(scrub(fields) as Fields) };
  const text = JSON.stringify(line);
  if (level === 'info') console.log(text);
  else console.error(text);
}

export const log = {
  info: (msg: string, fields?: Fields) => emit('info', msg, fields),
  warn: (msg: string, fields?: Fields) => emit('warn', msg, fields),
  error: (msg: string, fields?: Fields) => emit('error', msg, fields),
};

// ─── Requests ─────────────────────────────────────────────────────────────

const requestIds = new WeakMap<Request, string>();
const requestUsers = new WeakMap<Request, string>();

/** Vercel's id for this request (it's in Vercel's own logs too), or one of ours. Stable for the request's life. */
export function requestId(req: Request): string {
  let id = requestIds.get(req);
  if (!id) {
    const given = req.headers.get('x-vercel-id');
    id = given && /^[\w:.-]{1,128}$/.test(given) ? given : randomBytes(8).toString('hex');
    requestIds.set(req, id);
  }
  return id;
}

/** Remembers who is calling, so the request's log line can say. Called once the token checks out. */
export function noteUser(req: Request, userId: string) {
  requestUsers.set(req, userId);
}

/** The route without its query string (queries carry OAuth codes and states). */
export function routeOf(url: URL): string {
  const p = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  return clip(p, 120);
}

export function requestFields(ctx: Ctx): Fields {
  const user = requestUsers.get(ctx.req);
  return { request_id: requestId(ctx.req), method: ctx.req.method, route: routeOf(ctx.url), ...(user ? { user_id: user } : {}) };
}

/**
 * Logs the request's one line and stamps its id on the response, so a
 * founder's bug report ("X-Request-Id: iad1::…") leads straight to the line.
 */
export function finishRequest(ctx: Ctx, res: Response, startedAt: number): Response {
  const duration = Math.max(0, Math.round(performance.now() - startedAt));
  emit(res.status >= 500 ? 'error' : 'info', 'request', { ...requestFields(ctx), status: res.status, duration_ms: duration });
  try {
    res.headers.set('X-Request-Id', requestId(ctx.req));
  } catch {
    // A response with immutable headers (Response.redirect): the log line is enough.
  }
  return res;
}

/** An unexpected failure: logged with the request's fields and sent to Sentry. Never throws. */
export function reportError(ctx: Ctx, err: unknown, msg = 'unhandled error'): Promise<void> {
  emit('error', msg, { ...requestFields(ctx), err });
  const sent = captureException(ctx, err);
  return keepAlive(sent) ? Promise.resolve() : sent;
}

// ─── Work that outlives the response ──────────────────────────────────────

/**
 * Lets a send (Sentry, PostHog) finish after the response has gone. On
 * Vercel that's the platform's `waitUntil`, found the same way the
 * `@vercel/functions` package finds it. True when the platform took it, so
 * the caller needn't wait; false elsewhere (the local server, tests), where
 * the caller should await the send itself.
 */
export function keepAlive(p: Promise<unknown>): boolean {
  const holder = (globalThis as Record<symbol, { get?: () => { waitUntil?: (p: Promise<unknown>) => void } | undefined } | undefined>)[
    Symbol.for('@vercel/request-context')
  ];
  try {
    const waitUntil = holder?.get?.()?.waitUntil;
    if (!waitUntil) return false;
    waitUntil(p.catch(() => {}));
    return true;
  } catch {
    return false;
  }
}

/** Which build is running: `RELEASE`, else the deployment's commit, else "dev". */
export function releaseOf(env: Env): string {
  const r = env.RELEASE?.trim() || env.VERCEL_GIT_COMMIT_SHA?.trim().slice(0, 12) || 'dev';
  return /^[\w.@+-]{1,64}$/.test(r) ? r : 'dev';
}

// ─── Sentry, over its envelope endpoint (no SDK) ──────────────────────────

/** `https://<public key>@<host>/<project>` → where envelopes go and the key that signs them. */
export function parseDsn(dsn: string | undefined): { url: string; publicKey: string } | null {
  if (!dsn?.trim()) return null;
  try {
    const u = new URL(dsn.trim());
    const m = /^(.*)\/(\d+)$/.exec(u.pathname);
    if (u.protocol !== 'https:' || !u.username || !m) return null;
    return { url: `https://${u.host}${m[1]}/api/${m[2]}/envelope/`, publicKey: decodeURIComponent(u.username) };
  } catch {
    return null;
  }
}

/** Per instance: at most this many events a minute, and this many of any one kind. */
const SENTRY_PER_MINUTE = 20;
const SENTRY_PER_FINGERPRINT = 3;
const SENTRY_TIMEOUT_MS = 2_000;

let sentryWindow = { start: 0, count: 0, seen: new Map<string, number>() };
/** Set when Sentry answers 429: it's telling us to stop for a while. */
let sentryMutedUntil = 0;

function sampleRate(env: Env): number {
  const n = Number(env.SENTRY_SAMPLE_RATE ?? '1');
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
}

/** The sampling and rate-limit decision, kept apart so a burst of one error can't drown the rest. */
function admit(env: Env, fingerprint: string, now: number): boolean {
  if (now < sentryMutedUntil) return false;
  if (Math.random() >= sampleRate(env)) return false;
  if (now - sentryWindow.start >= 60_000) sentryWindow = { start: now, count: 0, seen: new Map() };
  const same = sentryWindow.seen.get(fingerprint) ?? 0;
  if (sentryWindow.count >= SENTRY_PER_MINUTE || same >= SENTRY_PER_FINGERPRINT) return false;
  sentryWindow.count++;
  sentryWindow.seen.set(fingerprint, same + 1);
  return true;
}

interface Frame {
  function?: string;
  filename: string;
  lineno: number;
  colno: number;
  in_app: boolean;
}

const V8_FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/;
const GECKO_FRAME = /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/;

/** Stack frames as Sentry wants them: oldest call first, file names without query strings. */
export function framesOf(stack: string | undefined): Frame[] | undefined {
  if (!stack) return undefined;
  const frames: Frame[] = [];
  for (const line of stack.split('\n').slice(0, 60)) {
    const m = V8_FRAME.exec(line) ?? GECKO_FRAME.exec(line);
    if (!m) continue;
    const filename = clip(redact(m[2]!.replace(/[?#].*$/, '')), 300);
    frames.push({
      ...(m[1] ? { function: clip(m[1], 120) } : {}),
      filename,
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: !filename.includes('node_modules') && !filename.startsWith('node:'),
    });
  }
  return frames.length ? frames.reverse() : undefined;
}

export interface SentryReport {
  source: 'server' | 'browser';
  type: string;
  message: string;
  stack?: string;
  route: string;
  requestId: string;
  release: string;
  level?: 'error' | 'warning';
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

/** Sends one event to Sentry if a DSN is set and the limits allow. Resolves either way; never throws. */
export async function sendToSentry(env: Env, report: SentryReport, now = Date.now()): Promise<void> {
  const dsn = parseDsn(env.SENTRY_DSN);
  if (!dsn) return;
  const message = clip(redact(report.message), 500);
  if (!admit(env, `${report.source}|${report.type}|${message.slice(0, 120)}|${report.route}`, now)) return;

  const eventId = randomBytes(16).toString('hex');
  const frames = framesOf(report.stack ? redact(report.stack) : undefined);
  const event = {
    event_id: eventId,
    timestamp: now / 1000,
    platform: report.source === 'server' ? 'node' : 'javascript',
    level: report.level ?? 'error',
    logger: report.source,
    release: report.release,
    environment: env.SENTRY_ENVIRONMENT?.trim() || env.VERCEL_ENV?.trim() || 'development',
    transaction: report.route,
    tags: { source: report.source, route: report.route, request_id: report.requestId, ...report.tags },
    exception: { values: [{ type: clip(report.type, 80), value: message, ...(frames ? { stacktrace: { frames } } : {}) }] },
    ...(report.extra ? { extra: scrub(report.extra) } : {}),
  };
  const body = JSON.stringify(event);
  const envelope = `${JSON.stringify({ event_id: eventId, sent_at: new Date(now).toISOString() })}\n${JSON.stringify({ type: 'event', length: Buffer.byteLength(body) })}\n${body}\n`;
  try {
    const res = await fetch(dsn.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${dsn.publicKey}, sentry_client=tinytown-server/1.0`,
      },
      body: envelope,
      signal: AbortSignal.timeout(SENTRY_TIMEOUT_MS),
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get('Retry-After'));
      sentryMutedUntil = now + (Number.isFinite(wait) && wait > 0 ? Math.min(wait, 3600) : 60) * 1000;
    }
    await res.body?.cancel().catch(() => {});
  } catch {
    // Sentry unreachable: the log line already has everything.
  }
}

/** A server exception for Sentry, tagged with the request it broke. */
export function captureException(ctx: Ctx, err: unknown): Promise<void> {
  const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'Non-error thrown');
  return sendToSentry(
    ctx.env,
    { source: 'server', type: e.name || 'Error', message: e.message, stack: e.stack, route: routeOf(ctx.url), requestId: requestId(ctx.req), release: releaseOf(ctx.env), tags: { method: ctx.req.method } },
    ctx.now,
  );
}

/** For tests: forget Sentry's limits. */
export function resetLogState() {
  sentryWindow = { start: 0, count: 0, seen: new Map() };
  sentryMutedUntil = 0;
}
