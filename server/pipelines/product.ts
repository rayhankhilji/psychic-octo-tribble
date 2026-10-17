import { DAY } from '../../src/data/types.ts';
import type { Hosted } from '../context.ts';
import { keyIsLive } from '../env.ts';
import { StripeError, stripe } from '../stripe-api.ts';
import { retrying, type Budget } from './budget.ts';
import { dayMs, dayString, eq, gt, gte, ifPresent, iso, isIn, lt, type Rest } from './rest.ts';
import { PAID_STATUSES } from './snapshots.ts';

/**
 * TinyTown's own numbers, one row per UTC day in `product_daily`. Event
 * counts (signups, new paid, churned) are exact for any past day, so a day
 * the job missed is filled in later. State (paying founders, MRR, connected,
 * active) can only be measured now, so it's written for the day just ended
 * and left null on a missed day rather than guessed.
 */

export interface ProductDay {
  day: string;
  signups: number;
  new_paid: number | null;
  churned: number | null;
  paying_monthly: number | null;
  paying_yearly: number | null;
  comped: number | null;
  mrr_cents: number | null;
  currency: string | null;
  stripe_connected: number | null;
  github_connected: number | null;
  dau: number | null;
  wau: number | null;
  mau: number | null;
  measured_at: string;
}

/** Missed days are filled in this far back. */
export const BACKFILL_DAYS = 7;

interface SubRow {
  user_id: string;
  status: string;
  price_id: string | null;
  plan_interval: string | null;
  livemode: boolean | null;
  /** From 0004: a plan given by hand, not paid for. Absent before that migration. */
  comp?: boolean;
}

interface StripePrice {
  id: string;
  unit_amount: number | null;
  currency: string;
  recurring: { interval: 'day' | 'week' | 'month' | 'year'; interval_count: number } | null;
}

/** Months per billing interval, for turning a price into a monthly amount. */
const PER_MONTH: Record<string, number> = { day: 365 / 12, week: 52 / 12, month: 1, year: 1 / 12 };

/** `stripe()` already retries quickly (0.3 s, 0.9 s); a job can afford to wait longer on top when Stripe is limiting us. */
const stripeRetryable = (err: unknown) => (err instanceof StripeError && (err.status === 429 || err.status >= 500)) || err instanceof TypeError;

/** Every paying founder's plan row, a page at a time. */
async function paidPlans(rest: Rest): Promise<SubRow[]> {
  const out: SubRow[] = [];
  let after: string | null = null;
  for (;;) {
    // select=* so the query works with or without 0004's `comp` column.
    const page: SubRow[] = await rest.rows<SubRow>('subscriptions', {
      where: { status: isIn(PAID_STATUSES), ...(after ? { user_id: gt(after) } : {}) },
      order: 'user_id.asc',
      limit: 1000,
    });
    out.push(...page);
    if (page.length < 1000) return out;
    after = page.at(-1)!.user_id;
  }
}

/**
 * List-price MRR in cents from our own Stripe prices. Null (never a guess)
 * when billing isn't set up, a plan has no price, a price can't be read, or
 * plans are in more than one currency.
 */
async function mrr(ctx: Hosted, budget: Budget, paying: SubRow[]): Promise<{ cents: number | null; currency: string | null }> {
  const billing = ctx.s.billing;
  if (!billing) return { cents: null, currency: null };
  if (!paying.length) return { cents: 0, currency: null };
  const counts = new Map<string, number>();
  for (const s of paying) {
    if (!s.price_id) return { cents: null, currency: null };
    counts.set(s.price_id, (counts.get(s.price_id) ?? 0) + 1);
  }
  let total = 0;
  const currencies = new Set<string>();
  for (const [id, n] of counts) {
    let price: StripePrice;
    try {
      price = await retrying(() => stripe<StripePrice>(billing.secretKey, 'GET', `/v1/prices/${encodeURIComponent(id)}`), { budget, tries: 3, baseMs: 2_000, retryable: stripeRetryable });
    } catch (err) {
      console.error(`Couldn't read price ${id} for product metrics: ${err instanceof Error ? err.message : 'unknown'}`);
      return { cents: null, currency: null };
    }
    const per = price.recurring ? PER_MONTH[price.recurring.interval] : undefined;
    if (price.unit_amount == null || per === undefined) return { cents: null, currency: null };
    total += (n * price.unit_amount * per) / Math.max(1, price.recurring!.interval_count);
    currencies.add(price.currency);
  }
  if (currencies.size !== 1) return { cents: null, currency: currencies.size ? 'mixed' : null };
  return { cents: Math.round(total), currency: [...currencies][0]! };
}

/** One day's row. `measureState` only for the day just ended. */
export async function productDay(ctx: Hosted, rest: Rest, budget: Budget, day: number, measureState: boolean): Promise<ProductDay> {
  const range = [gte(iso(day)), lt(iso(day + DAY))];
  const changes = (change: string) => ifPresent<number | null>(() => rest.count('plan_changes', { change: eq(change), at: range }), null);
  const row: ProductDay = {
    day: dayString(day),
    signups: await rest.count('profiles', { created_at: range }),
    new_paid: await changes('started'),
    churned: await changes('ended'),
    paying_monthly: null,
    paying_yearly: null,
    comped: null,
    mrr_cents: null,
    currency: null,
    stripe_connected: null,
    github_connected: null,
    dau: null,
    wau: null,
    mau: null,
    measured_at: iso(ctx.now),
  };
  if (!measureState) return row;

  // Our own test-mode subscriptions don't count when billing runs on live keys.
  const live = ctx.s.billing ? keyIsLive(ctx.s.billing.secretKey) : null;
  const plans = (await paidPlans(rest)).filter((s) => s.comp || live === null || s.livemode === live);
  const paying = plans.filter((s) => !s.comp);
  const money = await mrr(ctx, budget, paying);
  const seenSince = (days: number) => rest.count('profiles', { last_seen: gte(day - (days - 1) * DAY) });
  return {
    ...row,
    paying_monthly: paying.filter((s) => s.plan_interval === 'month').length,
    paying_yearly: paying.filter((s) => s.plan_interval === 'year').length,
    comped: plans.length - paying.length,
    mrr_cents: money.cents,
    currency: money.currency,
    stripe_connected: await rest.count('connections', { provider: eq('stripe') }),
    github_connected: await rest.count('connections', { provider: eq('github') }),
    dau: await seenSince(1),
    wau: await seenSince(7),
    mau: await seenSince(30),
  };
}

/**
 * Writes the day just ended, plus any of the last week's days that have no
 * row (event counts only). Re-running is harmless: the same day gets the
 * same counts, and its state is measured again.
 */
export async function recordProductDays(ctx: Hosted, rest: Rest, budget: Budget, yesterday: number): Promise<string[]> {
  const from = yesterday - (BACKFILL_DAYS - 1) * DAY;
  const have = new Set((await rest.rows<{ day: string }>('product_daily', { select: 'day', where: { day: gte(dayString(from)) } })).map((r) => dayMs(r.day)));
  // The day just ended first: it's the one that matters if time is short.
  const days = [yesterday];
  for (let d = yesterday - DAY; d >= from; d -= DAY) if (!have.has(d)) days.push(d);
  const written: string[] = [];
  for (const d of days) {
    if (!budget.has(3_000)) break;
    const row = await productDay(ctx, rest, budget, d, d === yesterday);
    await rest.upsertMany('product_daily', [{ ...row }], 'day', 'merge');
    written.push(row.day);
  }
  return written;
}
