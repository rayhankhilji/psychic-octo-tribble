import { createHmac, randomBytes } from 'node:crypto';
import { ROUTES, type TelemetryReport } from '../src/api/contract.ts';
import { rateLimit, type Ctx } from './context.ts';
import { githubAppJwt, safeEqual } from './crypto.ts';
import { keyIsLive } from './env.ts';
import type { Extension } from './extensions.ts';
import { HttpError, badRequest, bearer, json, readJson } from './http.ts';
import { clip, keepAlive, log, redact, releaseOf, requestId, sendToSentry } from './log.ts';
import { fetchWithRetry } from './retry.ts';
import { serviceHeaders } from './supabase.ts';

/** Health checks and browser telemetry (`/api/health`, `/api/telemetry`). */
export const healthExtension: Extension = {
  match: (path) => path === ROUTES.health || path === ROUTES.telemetry,
  handle: async (ctx) => {
    const path = ctx.url.pathname.replace(/\/+$/, '');
    const method = ctx.req.method;
    if (path === ROUTES.health) {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed.', 'bad_request');
      const res = ctx.url.searchParams.get('deep') === '1' ? await deep(ctx) : json({ ok: true, release: releaseOf(ctx.env), time: new Date(ctx.now).toISOString() });
      return method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res;
    }
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed.', 'bad_request');
    return telemetry(ctx);
  },
};

// ─── GET /api/health?deep=1 ───────────────────────────────────────────────

/**
 * One line per dependency. `critical` ones failing make the whole answer a
 * 503, which is what uptime monitors alert on; the rest show up in the body
 * as `degraded` without paging anyone. `detail` is written for the owner and
 * never holds a secret or an upstream response body: a status code, a
 * variable's name, a mode.
 */
export interface Check {
  ok: boolean;
  critical: boolean;
  ms: number;
  detail?: string;
}

const CHECK_TIMEOUT_MS = 3_000;

class Failed extends Error {}

async function timed(critical: boolean, run: () => Promise<string | void>): Promise<Check> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  try {
    const detail = await run();
    return { ok: true, critical, ms: ms(), ...(detail ? { detail } : {}) };
  } catch (err) {
    const detail = err instanceof Failed ? err.message : err instanceof Error && err.name === 'UpstreamTimeout' ? 'timed out' : 'unreachable';
    return { ok: false, critical, ms: ms(), detail };
  }
}

/** One quick read, no retries: a health check measures, it doesn't paper over. */
async function probe(url: string, headers: Record<string, string>): Promise<Response> {
  return fetchWithRetry(url, { headers }, { timeoutMs: CHECK_TIMEOUT_MS, retries: 0 });
}

/** The env vars each feature needs, all of which must be set for it to switch on (see env.ts). */
const FEATURES: { name: string; critical: boolean; vars: string[] }[] = [
  { name: 'accounts', critical: true, vars: ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] },
  { name: 'secrets', critical: true, vars: ['TOKEN_ENCRYPTION_KEY', 'STATE_SECRET'] },
  { name: 'billing', critical: true, vars: ['STRIPE_BILLING_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_MONTHLY', 'STRIPE_PRICE_YEARLY'] },
  { name: 'stripe_app', critical: true, vars: ['STRIPE_APP_CLIENT_ID'] },
  { name: 'github_app', critical: true, vars: ['GITHUB_APP_SLUG', 'GITHUB_APP_ID', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_PRIVATE_KEY'] },
  { name: 'cron', critical: false, vars: ['CRON_SECRET'] },
  { name: 'email', critical: false, vars: ['RESEND_API_KEY'] },
  { name: 'observability', critical: false, vars: ['SENTRY_DSN', 'POSTHOG_PROJECT_KEY'] },
];

const has = (ctx: Ctx, name: string) => !!ctx.env[name]?.trim();

/** Names of what's missing or wrong, per feature. Never values. */
function configChecks(ctx: Ctx): Record<string, Check> {
  const out: Record<string, Check> = {};
  const production = ctx.env.VERCEL_ENV === 'production';
  for (const f of FEATURES) {
    const problems = f.vars.filter((v) => !has(ctx, v)).map((v) => `${v} is not set`);
    if (f.name === 'accounts' && !ctx.s.appUrl) problems.push('APP_URL is not set');
    if (f.name === 'accounts' && production && ctx.s.appUrl && !ctx.s.appUrl.startsWith('https://')) problems.push('APP_URL is not https');
    if (f.name === 'secrets' && has(ctx, 'TOKEN_ENCRYPTION_KEY') && Buffer.from(ctx.env.TOKEN_ENCRYPTION_KEY!.trim(), 'base64').length !== 32) {
      problems.push('TOKEN_ENCRYPTION_KEY is not 32 bytes of base64');
    }
    // Test data must never drive a real city, and a test key can't take real money.
    if (f.name === 'billing' && production) {
      if (ctx.env.ALLOW_TEST_MODE?.trim() === '1') problems.push('ALLOW_TEST_MODE is on in production');
      if (ctx.s.billing && !keyIsLive(ctx.s.billing.secretKey)) problems.push('STRIPE_BILLING_SECRET_KEY is a test key in production');
    }
    if (f.name === 'stripe_app' && production && ctx.s.stripeApp && !ctx.s.stripeApp.livemode) problems.push('the Stripe App key is a test key in production');
    if (f.name === 'email' && has(ctx, 'RESEND_API_KEY') && !ctx.env.RESEND_API_KEY!.trim().startsWith('re_')) problems.push("RESEND_API_KEY doesn't look like a Resend key");
    out[`config_${f.name}`] = { ok: problems.length === 0, critical: f.critical, ms: 0, ...(problems.length ? { detail: problems.join('; ') } : {}) };
  }
  return out;
}

async function stripePrice(key: string, id: string, interval: 'month' | 'year'): Promise<boolean> {
  const res = await probe(`https://api.stripe.com/v1/prices/${encodeURIComponent(id)}`, { Authorization: `Bearer ${key}` });
  if (res.status === 401) throw new Failed('Stripe rejected STRIPE_BILLING_SECRET_KEY (401)');
  if (res.status === 403) throw new Failed('STRIPE_BILLING_SECRET_KEY lacks read access to Prices (403)');
  if (res.status === 404) throw new Failed(`the ${interval}ly price doesn't exist in this Stripe account and mode (404)`);
  if (!res.ok) throw new Failed(`Stripe responded ${res.status}`);
  const p = (await res.json()) as { active?: boolean; livemode?: boolean; recurring?: { interval?: string } | null };
  if (p.recurring?.interval !== interval) throw new Failed(`the ${interval}ly price isn't a ${interval}ly recurring price`);
  if (p.active === false) throw new Failed(`the ${interval}ly price is archived`);
  return !!p.livemode;
}

async function deep(ctx: Ctx): Promise<Response> {
  const token = bearer(ctx.req) ?? '';
  const secrets = [ctx.env.HEALTH_SECRET?.trim(), ctx.env.CRON_SECRET?.trim()].filter((s): s is string => !!s);
  if (!secrets.length) throw new HttpError(503, 'Deep health checks need HEALTH_SECRET (or CRON_SECRET) on the server.', 'not_configured');
  // Check every secret, so the time taken doesn't say which one matched.
  let authed = false;
  for (const s of secrets) authed = safeEqual(token, s) || authed;
  if (!authed) throw new HttpError(401, 'Deep health checks need the health secret.', 'unauthenticated');

  const s = ctx.s;
  const pending: Record<string, Promise<Check>> = {};
  if (s.supabase) {
    const sb = s.supabase;
    pending.supabase_rest = timed(true, async () => {
      // Reads one id with the service key: proves the key works and the migration ran.
      const res = await probe(`${sb.url}/rest/v1/profiles?select=user_id&limit=1`, serviceHeaders(sb));
      if (res.status === 401 || res.status === 403) throw new Failed(`Supabase rejected SUPABASE_SERVICE_ROLE_KEY (${res.status})`);
      if (res.status === 404) throw new Failed('the profiles table is missing (run the migrations)');
      if (!res.ok) throw new Failed(`Supabase REST responded ${res.status}`);
      await res.body?.cancel();
    });
    pending.supabase_auth = timed(true, async () => {
      const res = await probe(`${sb.url}/auth/v1/health`, { apikey: sb.anonKey });
      if (res.status === 401 || res.status === 403) throw new Failed(`Supabase Auth rejected SUPABASE_ANON_KEY (${res.status})`);
      if (!res.ok) throw new Failed(`Supabase Auth responded ${res.status}`);
      await res.body?.cancel();
    });
  }
  if (s.billing) {
    const billing = s.billing;
    pending.stripe_billing = timed(true, async () => {
      const [month, year] = await Promise.all([stripePrice(billing.secretKey, billing.prices.month, 'month'), stripePrice(billing.secretKey, billing.prices.year, 'year')]);
      if (month !== year) throw new Failed("the two prices aren't in the same mode");
      if (month !== keyIsLive(billing.secretKey)) throw new Failed("the prices aren't in the key's mode");
      return month ? 'live mode' : 'test mode';
    });
  }
  if (s.stripeApp) {
    const app = s.stripeApp;
    pending.stripe_app = timed(true, async () => {
      // Refreshing founders' tokens needs a full secret key; a restricted key can't read the balance.
      const res = await probe('https://api.stripe.com/v1/balance', { Authorization: `Bearer ${app.secretKey}` });
      if (res.status === 401) throw new Failed('Stripe rejected the Stripe App secret key (401)');
      if (res.status === 403) throw new Failed('the Stripe App key is a restricted key; it needs the full secret key (403)');
      if (!res.ok) throw new Failed(`Stripe responded ${res.status}`);
      await res.body?.cancel();
      return app.livemode ? 'live mode' : 'test mode';
    });
  }
  if (s.githubApp) {
    const gh = s.githubApp;
    pending.github_app = timed(true, async () => {
      let jwt: string;
      try {
        jwt = githubAppJwt(gh.appId ?? gh.clientId, gh.privateKey, ctx.now);
      } catch {
        throw new Failed("GITHUB_APP_PRIVATE_KEY isn't a readable RSA private key");
      }
      const res = await probe('https://api.github.com/app', {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'tinytown',
        Authorization: `Bearer ${jwt}`,
      });
      if (res.status === 401) throw new Failed("GitHub rejected the app's JWT: GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY don't match (401)");
      if (!res.ok) throw new Failed(`GitHub responded ${res.status}`);
      const body = (await res.json()) as { slug?: string };
      if (body.slug && body.slug !== gh.slug) throw new Failed(`GITHUB_APP_SLUG doesn't match the app's slug`);
    });
  }

  const checks: Record<string, Check> = { ...configChecks(ctx) };
  const names = Object.keys(pending);
  const results = await Promise.all(names.map((n) => pending[n]!));
  names.forEach((n, i) => (checks[n] = results[i]!));

  const ok = Object.values(checks).every((c) => c.ok || !c.critical);
  const degraded = Object.values(checks).some((c) => !c.ok && !c.critical);
  if (!ok) log.error('health check failed', { request_id: requestId(ctx.req), failing: Object.keys(checks).filter((k) => !checks[k]!.ok) });
  return json({ ok, degraded, release: releaseOf(ctx.env), time: new Date(ctx.now).toISOString(), checks }, ok ? 200 : 503);
}

// ─── POST /api/telemetry ──────────────────────────────────────────────────

const KINDS = new Set<TelemetryReport['kind']>(['error', 'unhandledrejection', 'webgl', 'perf']);
const MAX_MESSAGE = 500;
const MAX_STACK = 4 * 1024;
const MAX_DATA_KEYS = 20;
const PER_MINUTE = 20;

/**
 * IPs are only ever held as a keyed hash for the rate limit. The key is
 * random per instance (the limit is per instance anyway), so a hash can't be
 * reversed by trying all four billion IPv4 addresses.
 */
const IP_KEY = randomBytes(32);

function clientIp(req: Request): string {
  return (req.headers.get('x-forwarded-for')?.split(',')[0] ?? req.headers.get('x-real-ip') ?? 'unknown').trim();
}

const ipHash = (req: Request) => createHmac('sha256', IP_KEY).update(clientIp(req)).digest('hex').slice(0, 24);

/** A page address without its query or fragment (magic-link tokens arrive in the fragment). */
function pageOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 2048) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
    return clip(redact(`${u.origin}${u.pathname}`), 300);
  } catch {
    return undefined;
  }
}

/** The report, validated, cut to size and scrubbed of anything personal. Throws a 400 if it isn't a report at all. */
export function cleanReport(body: Record<string, unknown>): TelemetryReport {
  const kind = body.kind as TelemetryReport['kind'];
  if (!KINDS.has(kind)) throw badRequest('Unknown report kind.');
  if (typeof body.message !== 'string' || !body.message.trim()) throw badRequest('A report needs a message.');
  const report: TelemetryReport = { kind, message: clip(redact(body.message.trim()), MAX_MESSAGE) };
  if (typeof body.stack === 'string' && body.stack) report.stack = clip(redact(body.stack.slice(0, MAX_STACK * 2)), MAX_STACK);
  const url = pageOf(body.url);
  if (url) report.url = url;
  if (typeof body.release === 'string' && /^[\w.@+-]{1,64}$/.test(body.release)) report.release = body.release;
  if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
    const data: Record<string, number | string | boolean> = {};
    for (const [k, v] of Object.entries(body.data as Record<string, unknown>).slice(0, MAX_DATA_KEYS)) {
      if (!/^[a-z][\w.-]{0,39}$/i.test(k)) continue;
      if (typeof v === 'number' && Number.isFinite(v)) data[k] = v;
      else if (typeof v === 'boolean') data[k] = v;
      else if (typeof v === 'string') data[k] = clip(redact(v), 200);
    }
    if (Object.keys(data).length) report.data = data;
  }
  return report;
}

/** Same-origin only: our own pages post here; anything else is dropped without a word. */
function fromUs(ctx: Ctx): boolean {
  const origin = ctx.req.headers.get('Origin');
  if (!origin) return true;
  return origin === ctx.url.origin || (!!ctx.s.appUrl && origin === new URL(ctx.s.appUrl).origin);
}

async function telemetry(ctx: Ctx): Promise<Response> {
  await rateLimit(`telemetry:${ipHash(ctx.req)}`, PER_MINUTE, ctx.now);
  const noContent = new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  if (!fromUs(ctx)) return noContent;
  const report = cleanReport(await readJson(ctx.req));
  const fields = { request_id: requestId(ctx.req), kind: report.kind, message: report.message, stack: report.stack, page: report.url, release: report.release, data: report.data };
  if (report.kind === 'perf') {
    log.info('client perf', fields);
    return noContent;
  }
  log.warn('client error', fields);
  keepAlive(
    sendToSentry(
      ctx.env,
      {
        source: 'browser',
        type: report.kind === 'webgl' ? 'WebGLError' : report.kind === 'unhandledrejection' ? 'UnhandledRejection' : (/^(\w*Error)\b/.exec(report.message)?.[1] ?? 'Error'),
        message: report.message,
        stack: report.stack,
        route: report.url?.replace(/^https?:\/\/[^/]+/, '') || '/',
        requestId: requestId(ctx.req),
        release: report.release ?? releaseOf(ctx.env),
        level: report.kind === 'webgl' ? 'warning' : 'error',
        tags: { kind: report.kind },
        ...(report.data ? { extra: report.data } : {}),
      },
      ctx.now,
    ),
  );
  return noContent;
}
