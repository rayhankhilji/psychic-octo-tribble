import type { ApiError, ErrorCode } from '../src/api/contract.ts';

/** A failure with a status the router turns into `{ error, code }`. Messages are written for the founder. */
export class HttpError extends Error {
  status: number;
  code: ErrorCode | undefined;
  /** For 429 and 503: seconds until it's worth trying again (sent as `Retry-After`). */
  retryAfter: number | undefined;
  constructor(status: number, message: string, code?: ErrorCode, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export const badRequest = (message: string) => new HttpError(400, message, 'bad_request');
export const notConfigured = (what: string) => new HttpError(503, `${what} isn't set up on this server.`, 'not_configured');
export const upstream = (message: string) => new HttpError(502, message, 'upstream');

// ─── Security headers ─────────────────────────────────────────────────────

/**
 * Sent with every response, the static site's and the API's alike. HSTS
 * keeps browsers on HTTPS for two years (no `preload`: that's a one-way
 * door for the owner's whole domain, so it's a launch checklist item, not a
 * default). The rest switch off what TinyTown never uses: framing, MIME
 * sniffing, full referrers to other sites, and powerful device features.
 */
export const BASE_SECURITY_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy':
    'accelerometer=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), serial=(), usb=(), browsing-topics=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

/**
 * API responses are data, never pages: nothing in them may load or run, and
 * other sites may not embed them. An endpoint that renders HTML (an email
 * link landing page, say) sets its own policy, which wins.
 */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** A policy for the odd HTML page the API serves itself: its own inline styles and images, nothing else. */
export const API_HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/**
 * The Content Security Policy for the app itself (index.html and every other
 * page of the Vite build). Each source is here for a reason:
 *
 * - `script-src 'self'`: our bundles, plus Cloudflare Turnstile's script,
 *   loaded only when the sign-in dialog opens. No inline scripts and no
 *   eval: Vite emits none and three.js needs none.
 * - `style-src 'unsafe-inline'`: index.html's boot screen is an inline
 *   `<style>` (it must paint before any file loads) and the HUD's bars and
 *   chart markers are `style="width:…"` attributes. Hashes can't cover
 *   attributes, and a hash would switch `'unsafe-inline'` off for both.
 *   Styles can't run code; with scripts locked down this is the usual trade.
 *   Google Fonts serves the font stylesheet.
 * - `font-src`: the font files themselves, from fonts.gstatic.com.
 * - `img-src data: blob:`: the "share your city" snapshot is a canvas turned
 *   into a data: URL, and the thumbnail studio uses blob: URLs.
 * - `connect-src`: our own `/api`, and Supabase Auth (supabase-js signs in
 *   from the browser). Narrowed to the exact project when SUPABASE_URL is
 *   known at build time; otherwise any `*.supabase.co` project. No `wss:`:
 *   we never use Supabase Realtime.
 * - `frame-src`: Turnstile renders its check in an iframe.
 * - `worker-src 'self' blob:`: three.js loaders and any future off-thread
 *   work run workers from our origin or from blob: URLs.
 * - `frame-ancestors 'none'`: nobody may frame TinyTown (clickjacking).
 * - `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`: shut the
 *   classic injection side doors.
 * - No `upgrade-insecure-requests`: every source above is already HTTPS or
 *   same-origin, HSTS keeps the site itself on HTTPS, and leaving it out
 *   lets the production build be checked over plain HTTP on a LAN address.
 *
 * Preview deployments (only) also allow the Vercel Toolbar, with exactly the
 * sources Vercel documents for it.
 */
export function siteCsp(opts: { supabaseUrl?: string | null; vercelToolbar?: boolean } = {}): string {
  let supabase = 'https://*.supabase.co';
  if (opts.supabaseUrl) {
    try {
      const u = new URL(opts.supabaseUrl);
      if (u.protocol === 'https:') supabase = u.origin;
    } catch {
      // Malformed: keep the wildcard; the env check reports it.
    }
  }
  const turnstile = 'https://challenges.cloudflare.com';
  const live = opts.vercelToolbar ? 'https://vercel.live' : '';
  const src = (...parts: string[]) => parts.filter(Boolean).join(' ');
  return [
    "default-src 'self'",
    src("script-src 'self'", turnstile, live),
    src("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", live),
    src("font-src 'self' https://fonts.gstatic.com", live, live && 'https://assets.vercel.com'),
    src("img-src 'self' data: blob:", live, live && 'https://vercel.com'),
    src("connect-src 'self'", supabase, live, live && 'wss://ws-us3.pusher.com'),
    src('frame-src', turnstile, live),
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

// ─── Responses ────────────────────────────────────────────────────────────

const API_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...API_HEADERS, ...headers } });
}

export function errorResponse(err: HttpError): Response {
  const body: ApiError = { error: err.message, ...(err.code ? { code: err.code } : {}) };
  const retry = err.retryAfter ?? (err.status === 429 ? 60 : undefined);
  return json(body, err.status, retry ? { 'Retry-After': String(Math.max(1, Math.ceil(retry))) } : {});
}

/**
 * A browser redirect after an OAuth callback. Only to a path on this
 * deployment: `//evil.example` and `/\evil.example` are other sites to a
 * browser, so they're refused rather than sent.
 */
export function redirect(location: string, headers: Headers = new Headers()): Response {
  if (!/^\/(?![/\\])/.test(location) || /[\r\n\0]/.test(location)) throw new Error('Redirects stay on this site');
  headers.set('Location', location);
  headers.set('Cache-Control', 'no-store');
  // The callback URL carries a one-time code; keep it out of Referer headers.
  headers.set('Referrer-Policy', 'no-referrer');
  return new Response(null, { status: 302, headers });
}

// ─── Requests ─────────────────────────────────────────────────────────────

/** Most request bodies are tiny; anything bigger than this is a mistake or an attack. */
const MAX_JSON_BYTES = 16 * 1024;

const tooLarge = () => new HttpError(413, 'That request is too large.', 'bad_request');

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  // Refuse an announced oversize body before reading a byte of it.
  const announced = Number(req.headers.get('Content-Length') ?? 0);
  if (announced > MAX_JSON_BYTES) throw tooLarge();
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > MAX_JSON_BYTES) throw tooLarge();
  let body: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    body = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw badRequest('Expected a JSON body.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Expected a JSON object.');
  return body as Record<string, unknown>;
}

export function bearer(req: Request): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('Authorization') ?? '');
  return m ? m[1]! : null;
}

export function cookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get('Cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        // A malformed escape in someone else's cookie isn't our 500.
        return null;
      }
    }
  }
  return null;
}

/**
 * The caller's IP address, for limits on routes nobody has signed in to.
 * Only trustworthy because the adapter in `node.ts` sets `X-Real-IP` itself
 * when there's no proxy in front, and Vercel overwrites it at the edge.
 */
export function clientIp(req: Request): string {
  const ip = req.headers.get('X-Real-IP')?.trim() || req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim();
  return ip && ip.length <= 64 ? ip : 'unknown';
}
