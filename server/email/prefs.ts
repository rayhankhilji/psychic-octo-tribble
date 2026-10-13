import { createHmac } from 'node:crypto';
import { hosted, rateLimit, type Ctx } from '../context.ts';
import { safeEqual, sha256 } from '../crypto.ts';
import { HttpError } from '../http.ts';
import { page } from './templates.ts';

/**
 * Email preferences and the unsubscribe link.
 *
 * Transactional mail (payments, plan changes, broken connections, account
 * changes) always goes out. The weekly digest and product updates are on by
 * default and each has a one-click way out: a link in the footer and the
 * List-Unsubscribe headers Gmail and Yahoo show as "Unsubscribe".
 *
 * The link carries an HMAC-signed token (under STATE_SECRET) naming the user
 * and the list, so no sign-in is needed and nobody can unsubscribe someone
 * else. Tokens don't expire: an unsubscribe link has to keep working.
 */

export type List = 'digest' | 'updates' | 'all';
const LISTS: readonly List[] = ['digest', 'updates', 'all'];

export interface EmailPrefsRow {
  user_id: string;
  product_updates: boolean;
  weekly_digest: boolean;
}

export const DEFAULT_PREFS = { product_updates: true, weekly_digest: true };

// ─── Tokens ───────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The purpose is bound into the MAC, so this can never be confused with an OAuth state signed by the same secret.
const mac = (secret: string, userId: string, list: List) => createHmac('sha256', secret).update(`tinytown-unsubscribe\n${userId}\n${list}`).digest('base64url');

export function unsubscribeToken(secret: string, userId: string, list: List): string {
  return `${userId}.${list}.${mac(secret, userId, list)}`;
}

export function readUnsubscribeToken(secret: string, token: string | null): { userId: string; list: List } | null {
  if (!token || token.length > 200) return null;
  const [userId, list, sig, extra] = token.split('.');
  if (!userId || !list || !sig || extra !== undefined) return null;
  if (!UUID.test(userId) || !LISTS.includes(list as List)) return null;
  return safeEqual(sig, mac(secret, userId, list as List)) ? { userId, list: list as List } : null;
}

export function unsubscribeUrl(appUrl: string, secret: string, userId: string, list: List): string {
  return `${appUrl}/api/email/unsubscribe?token=${encodeURIComponent(unsubscribeToken(secret, userId, list))}`;
}

/** RFC 2369 and RFC 8058 one-click: mail clients POST `List-Unsubscribe=One-Click` to the URL. */
export function unsubscribeHeaders(url: string): Record<string, string> {
  return { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}

// ─── The link ─────────────────────────────────────────────────────────────

const WHAT: Record<List, string> = {
  digest: 'the weekly digest',
  updates: 'product updates',
  all: 'all non-essential email from TinyTown',
};

function patchFor(list: List, on: boolean): Partial<EmailPrefsRow> {
  if (list === 'digest') return { weekly_digest: on };
  if (list === 'updates') return { product_updates: on };
  return { weekly_digest: on, product_updates: on };
}

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  // The token is in the URL; keep it out of Referer headers and search engines.
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

function htmlPage(status: number, appUrl: string, title: string, body: string[], form?: { action: string; label: string }): Response {
  return new Response(page({ appUrl, title, body, ...(form ? { form } : {}) }), { status, headers: PAGE_HEADERS });
}

const MAX_FORM_BYTES = 1024;

/**
 * `GET /api/email/unsubscribe?token=…`: turns the list off and says so, with
 * a button to turn it back on. `POST` to the same URL is either a mail
 * client's one-click unsubscribe (`List-Unsubscribe=One-Click`) or that
 * button (`action=resubscribe`).
 */
export async function handleUnsubscribe(ctx: Ctx): Promise<Response> {
  const appUrl = ctx.s.appUrl ?? ctx.url.origin;
  const secret = ctx.env.STATE_SECRET?.trim();
  if (!ctx.s.supabase || !secret) return htmlPage(503, appUrl, 'Email settings aren’t available', ['This server isn’t set up to change email settings yet. Try again later.']);
  const raw = ctx.url.searchParams.get('token');
  // A speed bump per link against anyone hammering the endpoint.
  rateLimit(`unsubscribe:${sha256(raw ?? '').slice(0, 24)}`, 20, ctx.now);
  const token = readUnsubscribeToken(secret, raw);
  if (!token) return htmlPage(400, appUrl, 'That link doesn’t work', ['This unsubscribe link is incomplete or has been changed. Use the link from the latest email, or reply to any TinyTown email and we’ll sort it out.']);

  let on = false;
  let oneClick = false;
  if (ctx.req.method === 'POST') {
    const text = await ctx.req.text();
    if (text.length > MAX_FORM_BYTES) throw new HttpError(413, 'That request is too large.', 'bad_request');
    const form = new URLSearchParams(text);
    oneClick = form.get('List-Unsubscribe') === 'One-Click';
    on = !oneClick && form.get('action') === 'resubscribe';
  }

  const h = hosted(ctx);
  try {
    await h.db.upsert('email_prefs', { user_id: token.userId, ...patchFor(token.list, on), updated_at: new Date(ctx.now).toISOString() }, 'user_id');
  } catch {
    return htmlPage(502, appUrl, 'That didn’t work', ['We couldn’t update your email settings just now. Try the link again in a minute.']);
  }
  console.log(`email prefs: ${token.list} ${on ? 'on' : 'off'} for ${token.userId}`);
  // Mail clients only need the status.
  if (oneClick) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });

  const action = `${ctx.url.pathname}?token=${encodeURIComponent(raw!)}`;
  if (on) {
    return htmlPage(200, appUrl, 'You’re subscribed again', [`You’ll get ${WHAT[token.list]} again.`]);
  }
  return htmlPage(
    200,
    appUrl,
    'You’re unsubscribed',
    [`You won’t get ${WHAT[token.list]} any more.`, 'We’ll still email you about your account and plan, like a failed payment or a connection that needs fixing.'],
    { action, label: 'Subscribe again' },
  );
}
