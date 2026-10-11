import { DAY, startOfDay } from './types.ts';

/** The subset of a Stripe Subscription object TinyTown reads. */
export interface StripeSubscription {
  id: string;
  customer: string | { id: string };
  status: string;
  start_date: number;
  ended_at: number | null;
  trial_end: number | null;
  currency: string;
  items: {
    data: {
      quantity?: number | null;
      price: {
        unit_amount: number | null;
        currency: string;
        recurring: { interval: 'day' | 'week' | 'month' | 'year'; interval_count: number } | null;
      };
    }[];
  };
}

export interface RevenueDay {
  t: number;
  customers: number;
  mrr: number;
}

// https://docs.stripe.com/currencies#zero-decimal
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);

const MONTHS_PER_INTERVAL = { day: 12 / 365, week: 12 / 52, month: 1, year: 12 } as const;

/** Never-paying states: abandoned checkouts. */
const NEVER_PAID = new Set(['incomplete', 'incomplete_expired']);

export function monthlyAmount(sub: StripeSubscription): number {
  const divisor = ZERO_DECIMAL.has(sub.currency.toLowerCase()) ? 1 : 100;
  let total = 0;
  for (const item of sub.items.data) {
    const { unit_amount, recurring } = item.price;
    if (unit_amount == null || !recurring) continue;
    const months = MONTHS_PER_INTERVAL[recurring.interval] * Math.max(1, recurring.interval_count);
    total += (unit_amount * (item.quantity ?? 1)) / months;
  }
  return total / divisor;
}

/** The currency most subscriptions are billed in. Others are left out of MRR. */
export function primaryCurrency(subs: StripeSubscription[]): string {
  const counts = new Map<string, number>();
  for (const s of subs) counts.set(s.currency, (counts.get(s.currency) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'usd';
}

/**
 * Rebuilds daily paying-customer count and MRR from subscription start, trial
 * and end dates, so a newly connected founder still gets their whole history.
 * Discounts and mid-period plan changes are not modelled; MRR uses each
 * subscription's current prices.
 */
export function revenueHistory(subs: StripeSubscription[], now: number): { currency: string; days: RevenueDay[] } {
  const currency = primaryCurrency(subs);
  const spans = subs
    .filter((s) => s.currency === currency && !NEVER_PAID.has(s.status))
    .map((s) => ({
      customer: typeof s.customer === 'string' ? s.customer : s.customer.id,
      from: startOfDay(Math.max(s.start_date, s.trial_end ?? 0) * 1000),
      to: s.ended_at != null ? startOfDay(s.ended_at * 1000) : s.status === 'unpaid' ? -Infinity : Infinity,
      mrr: monthlyAmount(s),
    }))
    .filter((s) => s.to > s.from);

  if (spans.length === 0) return { currency, days: [] };

  const first = Math.min(...spans.map((s) => s.from));
  const last = startOfDay(now);
  const days: RevenueDay[] = [];
  for (let t = first; t <= last; t += DAY) {
    const active = spans.filter((s) => s.from <= t && t < s.to);
    days.push({
      t,
      customers: new Set(active.map((s) => s.customer)).size,
      mrr: Math.round(active.reduce((sum, s) => sum + s.mrr, 0) * 100) / 100,
    });
  }
  return { currency, days };
}
