/**
 * One day of real business metrics. The world is a pure function of these
 * numbers; nothing in the scene is invented beyond what's derived from them.
 */
export interface Snapshot {
  /** Start of the day, ms since epoch (UTC). */
  t: number;
  /** Paying customers with an active subscription. */
  customers: number;
  /**
   * Monthly active users, paying or not. Optional: without a user source
   * (PostHog, Supabase) the population is just the paying customers.
   */
  users?: number;
  /** Monthly recurring revenue in major currency units (e.g. dollars). */
  mrr: number;
  /** Cumulative published releases. */
  releases: number;
  /** Cumulative commits on the default branch. */
  commits: number;
  /** Name of a release published on this day, if any. */
  release?: string;
}

export interface Timeline {
  name: string;
  currency: string;
  source: 'demo' | 'live';
  integrations: { stripe: boolean; github: boolean };
  /** Chronological, one per day. */
  snapshots: Snapshot[];
}

export const DAY = 86_400_000;

export function startOfDay(t: number): number {
  return Math.floor(t / DAY) * DAY;
}

/** Highest MRR reached at or before each index. Districts stay built once earned. */
export function runningPeak(snapshots: Snapshot[]): number[] {
  let peak = 0;
  return snapshots.map((s) => (peak = Math.max(peak, s.mrr)));
}

/** MRR change over the trailing seven days, as a fraction (-0.05 = down 5%). */
export function weeklyMrrChange(snapshots: Snapshot[], i: number): number {
  const now = snapshots[i];
  const then = snapshots[Math.max(0, i - 7)];
  if (!now || !then || then.mrr <= 0) return 0;
  return (now.mrr - then.mrr) / then.mrr;
}

export function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
    maximumFractionDigits: amount < 100 && !Number.isInteger(amount) ? 2 : 0,
  }).format(amount);
}
