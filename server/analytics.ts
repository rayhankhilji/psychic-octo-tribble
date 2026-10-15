import type { Ctx } from './context.ts';
import { clip, keepAlive, redact, releaseOf } from './log.ts';

/**
 * Our own product funnel (signed up, started checkout, paid, connected,
 * built), sent server-side so ad blockers don't skew it. Never throws.
 *
 * Goes to PostHog's capture endpoint when `POSTHOG_PROJECT_KEY` (the
 * project's public `phc_…` key, which can only write events) is set, and
 * does nothing otherwise. The distinct id is the Supabase user id, so the
 * browser can `identify` with the same id and the two halves join up. No
 * email, name or company ever goes in an event. Callers can simply await
 * it: on Vercel it returns at once and the send finishes in the background;
 * elsewhere it waits at most 1.5 s.
 * https://posthog.com/docs/api/capture
 *
 * Where each event is sent from:
 * - `signed_up`: the first `/api/me` for a new account (the profile is created).
 * - `paywall_shown`: the browser showed the paywall to a signed-in founder (`POST /api/billing/paywall/seen`).
 * - `offer_shown`: the introductory offer was shown for the first time (`POST /api/billing/offer/seen`).
 * - `checkout_started`: `POST /api/billing/checkout` made a Checkout session (`offer` says which price).
 * - `offer_accepted`: that Checkout carries the introductory offer.
 * - `plan_started`: the webhook saw a subscription become paid for a user who wasn't.
 * - `checkout_completed`: the same moment, with `plan` and whether it was bought with the `offer`.
 * - `plan_canceled`: the webhook saw a paid plan set to cancel, or end.
 * - `connected_stripe`, `connected_github`: the provider's callback saved the connection.
 * - `first_build`: the founder's first saved action in their city.
 * - `account_deleted`: `DELETE /api/account`, before the rows go.
 */
export type FunnelEvent =
  | 'signed_up'
  | 'paywall_shown'
  | 'offer_shown'
  | 'checkout_started'
  | 'offer_accepted'
  | 'plan_started'
  | 'checkout_completed'
  | 'plan_canceled'
  | 'connected_stripe'
  | 'connected_github'
  | 'first_build'
  | 'account_deleted';

const DEFAULT_HOST = 'https://us.i.posthog.com';
const TIMEOUT_MS = 1_500;
const MAX_PROPS = 20;

/** The capture URL, or null if the configured host isn't a plain HTTPS origin. */
export function captureUrl(host: string | undefined): string | null {
  try {
    const u = new URL(host?.trim() || DEFAULT_HOST);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return `${u.origin}/i/v0/e/`;
  } catch {
    return null;
  }
}

/** Primitive props only, a few of them, short and scrubbed. */
function cleanProps(props: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(props).slice(0, MAX_PROPS)) {
    if (!/^[a-z][\w]{0,39}$/i.test(k)) continue;
    if (typeof v === 'string') out[k] = clip(redact(v), 200);
    else if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
  }
  return out;
}

export async function track(ctx: Ctx, userId: string, event: FunnelEvent, props: Record<string, string | number | boolean> = {}): Promise<void> {
  const key = ctx.env.POSTHOG_PROJECT_KEY?.trim();
  if (!key || !userId || userId.length > 64) return;
  const url = captureUrl(ctx.env.POSTHOG_CAPTURE_HOST);
  if (!url) return;
  const send = (async () => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: key,
          event,
          distinct_id: userId,
          timestamp: new Date(ctx.now).toISOString(),
          properties: { ...cleanProps(props), $lib: 'tinytown-server', release: releaseOf(ctx.env), environment: ctx.env.VERCEL_ENV?.trim() || 'development' },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      await res.body?.cancel().catch(() => {});
    } catch {
      // Analytics is never worth failing a request over.
    }
  })();
  // On Vercel the platform holds the send open after the response, so a checkout never waits on analytics.
  if (keepAlive(send)) return;
  return send;
}
