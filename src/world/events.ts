import { formatMoney, type Snapshot } from '../data/types.ts';
import { DISTRICTS, type Weather } from './layout.ts';

export type WorldEvent =
  | { type: 'customers.joined'; count: number; total: number }
  | { type: 'customers.left'; count: number; total: number }
  | { type: 'district.unlocked'; id: string; name: string; threshold: number }
  | { type: 'district.dimmed'; id: string; name: string }
  | { type: 'district.relit'; id: string; name: string }
  | { type: 'release.shipped'; name: string }
  | { type: 'code.pushed'; commits: number }
  | { type: 'weather.changed'; weather: Weather; weeklyChange: number };

export interface Moment {
  snapshot: Snapshot;
  peakMrr: number;
  weather: Weather;
  weeklyChange: number;
}

/** What happened between two consecutive days, in the order it should be shown. */
export function diffMoments(prev: Moment, next: Moment): WorldEvent[] {
  const a = prev.snapshot;
  const b = next.snapshot;
  const events: WorldEvent[] = [];

  for (const d of DISTRICTS) {
    if (prev.peakMrr < d.threshold && next.peakMrr >= d.threshold) {
      events.push({ type: 'district.unlocked', id: d.id, name: d.name, threshold: d.threshold });
    } else if (prev.peakMrr >= d.threshold) {
      if (a.mrr >= d.threshold && b.mrr < d.threshold) events.push({ type: 'district.dimmed', id: d.id, name: d.name });
      if (a.mrr < d.threshold && b.mrr >= d.threshold) events.push({ type: 'district.relit', id: d.id, name: d.name });
    }
  }

  if (b.releases > a.releases) events.push({ type: 'release.shipped', name: b.release ?? `Release ${b.releases}` });
  if (b.customers > a.customers) events.push({ type: 'customers.joined', count: b.customers - a.customers, total: b.customers });
  if (b.customers < a.customers) events.push({ type: 'customers.left', count: a.customers - b.customers, total: b.customers });
  if (prev.weather !== next.weather) events.push({ type: 'weather.changed', weather: next.weather, weeklyChange: next.weeklyChange });
  if (b.commits > a.commits) events.push({ type: 'code.pushed', commits: b.commits - a.commits });

  return events;
}

/** Human copy for the event feed. Always quotes the real number behind the visual. */
export function describe(e: WorldEvent, currency: string): string | undefined {
  switch (e.type) {
    case 'customers.joined':
      return e.total === 1
        ? 'Your first customer moved in.'
        : `${plural(e.count, 'new customer')} moved in · ${e.total.toLocaleString('en-US')} total`;
    case 'customers.left':
      return `${plural(e.count, 'customer')} moved out · ${e.total.toLocaleString('en-US')} total`;
    case 'district.unlocked':
      return e.threshold <= 1
        ? `First revenue! ${e.name} opened.`
        : `${e.name} unlocked · MRR passed ${formatMoney(e.threshold, currency)}`;
    case 'district.dimmed':
      return `${e.name} went dark · MRR slipped below its milestone`;
    case 'district.relit':
      return `${e.name} lit up again`;
    case 'release.shipped':
      return `Shipped ${e.name}. HQ grew a floor.`;
    case 'weather.changed':
      return e.weather === 'rain'
        ? `Rain over the city · MRR ${(e.weeklyChange * 100).toFixed(1)}% this week`
        : 'The rain has cleared.';
    case 'code.pushed':
      return undefined; // Too frequent for the feed; the HQ beacon pulses instead.
  }
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}
