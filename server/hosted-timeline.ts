import { shippingActivity } from '../src/data/github.ts';
import { mergeHistory } from '../src/data/merge.ts';
import { revenueHistory } from '../src/data/stripe.ts';
import type { Timeline } from '../src/data/types.ts';
import type { Hosted } from './context.ts';
import { founderGithub } from './github-app.ts';
import { HttpError } from './http.ts';
import type { ConnectionRow, ProfileRow, TimelineRow } from './store.ts';
import { founderSubscriptions } from './stripe-app.ts';
import { applyUsers } from './users.ts';

/**
 * A founder's real metrics, built from their connections with the same code
 * the local server uses, and cached in `timelines` for 15 minutes. If a
 * rebuild fails and an older copy exists, the older copy is served: it's
 * still their real numbers, just from a little earlier.
 */

export const TIMELINE_TTL_MS = 15 * 60_000;
/** After a failed rebuild, wait this long before asking the providers again. */
const RETRY_AFTER_MS = 60_000;

const building = new Map<string, Promise<Timeline>>();
const failedAt = new Map<string, { at: number; err: HttpError }>();

export function resetTimelineCaches() {
  building.clear();
  failedAt.clear();
}

export async function userTimeline(ctx: Hosted, profile: ProfileRow): Promise<Timeline> {
  const userId = profile.user_id;
  const cached = await ctx.db.one<TimelineRow>('timelines', { user_id: userId });
  const named = (t: Timeline): Timeline => ({ ...t, name: profile.name });
  if (cached && Date.parse(cached.fetched_at) > ctx.now - TIMELINE_TTL_MS) return named(cached.timeline);

  const failed = failedAt.get(userId);
  if (failed && ctx.now - failed.at < RETRY_AFTER_MS) {
    if (cached) return named(cached.timeline);
    throw failed.err;
  }

  let pending = building.get(userId);
  if (!pending) {
    pending = build(ctx, profile).finally(() => building.delete(userId));
    building.set(userId, pending);
  }
  try {
    const t = await pending;
    failedAt.delete(userId);
    return named(t);
  } catch (err) {
    // "Not connected" (nothing linked, or a token that only reconnecting can fix)
    // is for the founder to act on, so it's never hidden behind a cached copy.
    const notConnected = err instanceof HttpError && err.code === 'not_connected';
    const failure = err instanceof HttpError ? err : new HttpError(502, err instanceof Error ? err.message : 'Your data could not be loaded.', 'upstream');
    if (!notConnected) failedAt.set(userId, { at: ctx.now, err: failure });
    if (cached && !notConnected) {
      console.error(`Timeline rebuild failed for ${userId}; serving the cached copy: ${err instanceof Error ? err.message : 'unknown'}`);
      return named(cached.timeline);
    }
    throw failure;
  }
}

async function build(ctx: Hosted, profile: ProfileRow): Promise<Timeline> {
  const rows = await ctx.db.many<ConnectionRow>('connections', { user_id: profile.user_id });
  // Test-mode Stripe never drives the economy, unless ALLOW_TEST_MODE=1 (development).
  const stripeRow = rows.find((r) => r.provider === 'stripe' && (r.livemode || ctx.s.allowTestMode));
  const githubRow = rows.find((r) => r.provider === 'github' && typeof r.metadata.repo === 'string');
  if (!stripeRow && !githubRow) {
    throw new HttpError(409, 'Connect Stripe or choose a GitHub repository to build your city.', 'not_connected');
  }

  const [subs, github] = await Promise.all([
    stripeRow ? founderSubscriptions(ctx, stripeRow) : null,
    githubRow ? founderGithub(ctx, githubRow) : null,
  ]);
  const revenue = subs ? revenueHistory(subs, ctx.now) : { currency: 'usd', days: [] };
  const shipping = github ? shippingActivity(github.commits, github.releases) : null;
  const snapshots = await applyUsers(ctx, profile, rows, mergeHistory(revenue.days, shipping, ctx.now));

  const timeline: Timeline = {
    name: profile.name,
    currency: revenue.currency,
    source: 'live',
    integrations: { stripe: !!subs, github: !!github },
    snapshots,
  };
  await ctx.db.upsert('timelines', { user_id: profile.user_id, timeline, fetched_at: new Date(ctx.now).toISOString() }, 'user_id');
  return timeline;
}
