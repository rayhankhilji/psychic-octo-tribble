/**
 * The headline numbers of a founder's connected data: what the setup cards
 * show as each connection lands, and what the paywall leads with ("your
 * city is ready"). Pure, and shared: the server makes `GET /api/preview`
 * with it, so neither the setup screens nor the paywall need the full
 * timeline (which stays behind the plan), and the browser's cards read the
 * same shapes.
 */
import { DAY, type Timeline } from '../data/types.ts';
import type { PreviewResponse, RevenueFacts, ShippingFacts } from './contract.ts';

export type { RevenueFacts, ShippingFacts } from './contract.ts';

export function revenueFacts(t: Timeline): RevenueFacts | null {
  if (!t.integrations.stripe || !t.snapshots.length) return null;
  const last = t.snapshots.at(-1)!;
  const first = t.snapshots.find((s) => s.customers > 0 || s.mrr > 0);
  const from = first ? t.snapshots.indexOf(first) : t.snapshots.length - 1;
  const span = t.snapshots.slice(from);
  const n = Math.min(48, span.length);
  const spark = Array.from({ length: n }, (_, i) => span[Math.round((i * (span.length - 1)) / Math.max(1, n - 1))]!.mrr);
  return { mrr: last.mrr, customers: last.customers, currency: t.currency, since: first?.t ?? null, spark };
}

export function shippingFacts(t: Timeline): ShippingFacts | null {
  if (!t.integrations.github || !t.snapshots.length) return null;
  const last = t.snapshots.at(-1)!;
  const monthAgo = t.snapshots.find((s) => s.t >= last.t - 30 * DAY) ?? t.snapshots[0]!;
  const latest = [...t.snapshots].reverse().find((s) => s.release);
  return { releases: last.releases, latest: latest ? { name: latest.release!, t: latest.t } : null, commits30: Math.max(0, last.commits - monthAgo.commits) };
}

/** The preview of a timeline: today's numbers and the little that describes the history, nothing day by day. */
export function previewOf(t: Timeline): PreviewResponse {
  const last = t.snapshots.at(-1) ?? null;
  const users = [...t.snapshots].reverse().find((s) => s.users != null)?.users ?? null;
  return {
    name: t.name,
    currency: t.currency,
    ready: !!last,
    asOf: last?.t ?? null,
    days: t.snapshots.length,
    revenue: revenueFacts(t),
    shipping: shippingFacts(t),
    users,
  };
}

/** The people in the city: monthly active users when a source gives them, otherwise the paying customers. */
export function residentsOf(p: PreviewResponse): number | null {
  return p.users ?? p.revenue?.customers ?? null;
}
