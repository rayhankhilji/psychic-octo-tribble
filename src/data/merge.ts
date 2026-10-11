import type { ShippingActivity } from './github.ts';
import type { RevenueDay } from './stripe.ts';
import { DAY, startOfDay, type Snapshot } from './types.ts';

/** Joins revenue and shipping into one snapshot per day, from the earliest data point to today. */
export function mergeHistory(revenue: RevenueDay[], shipping: ShippingActivity | null, now: number): Snapshot[] {
  const starts = [
    ...(revenue.length ? [revenue[0]!.t] : []),
    ...(shipping ? [...shipping.commits.keys(), ...shipping.releases.keys()] : []),
  ];
  if (starts.length === 0) return [];

  const byDay = new Map(revenue.map((d) => [d.t, d]));
  const snapshots: Snapshot[] = [];
  let releases = 0;
  let commits = 0;
  for (let t = Math.min(...starts), end = startOfDay(now); t <= end; t += DAY) {
    const names = shipping?.releases.get(t) ?? [];
    releases += names.length;
    commits += shipping?.commits.get(t) ?? 0;
    const day = byDay.get(t);
    snapshots.push({
      t,
      customers: day?.customers ?? 0,
      mrr: day?.mrr ?? 0,
      releases,
      commits,
      ...(names.length ? { release: names.at(-1)! } : {}),
    });
  }
  return snapshots;
}
