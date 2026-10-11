import { describe, expect, it } from 'vitest';
import { shippingActivity } from '../src/data/github.ts';
import { mergeHistory } from '../src/data/merge.ts';
import { monthlyAmount, revenueHistory, type StripeSubscription } from '../src/data/stripe.ts';
import { demoTimeline } from '../src/data/demo.ts';
import { staticPath } from '../server/static.ts';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const sec = (day: number) => (T0 + day * DAY) / 1000;

function sub(over: Partial<StripeSubscription> & { amount?: number; interval?: 'month' | 'year' | 'week' } = {}): StripeSubscription {
  const { amount = 2900, interval = 'month', ...rest } = over;
  return {
    id: `sub_${Math.random()}`,
    customer: 'cus_1',
    status: 'active',
    start_date: sec(0),
    ended_at: null,
    trial_end: null,
    currency: 'usd',
    items: { data: [{ quantity: 1, price: { unit_amount: amount, currency: 'usd', recurring: { interval, interval_count: 1 } } }] },
    ...rest,
  };
}

describe('Stripe', () => {
  it('normalises every billing interval to monthly revenue', () => {
    expect(monthlyAmount(sub({ amount: 2900 }))).toBe(29);
    expect(monthlyAmount(sub({ amount: 120000, interval: 'year' }))).toBe(100);
    expect(monthlyAmount(sub({ amount: 1000, interval: 'week' }))).toBeCloseTo(43.33, 2);
    expect(monthlyAmount({ ...sub({ amount: 5000 }), currency: 'jpy' })).toBe(5000);
  });

  it('multiplies by seat quantity', () => {
    const s = sub();
    s.items.data[0]!.quantity = 3;
    expect(monthlyAmount(s)).toBe(87);
  });

  it('rebuilds daily customers and MRR from start, trial and end dates', () => {
    const subs = [
      sub({ customer: 'a', start_date: sec(0) }),
      sub({ customer: 'b', start_date: sec(2), ended_at: sec(4), status: 'canceled' }),
      sub({ customer: 'c', start_date: sec(0), trial_end: sec(3) }),
      sub({ customer: 'd', start_date: sec(1), status: 'incomplete_expired' }),
    ];
    const { currency, days } = revenueHistory(subs, T0 + 5 * DAY);
    expect(currency).toBe('usd');
    expect(days.map((d) => d.customers)).toEqual([1, 1, 2, 3, 2, 2]);
    expect(days[3]!.mrr).toBe(87);
  });

  it('counts a customer with two subscriptions once', () => {
    const { days } = revenueHistory([sub({ customer: 'a' }), sub({ customer: 'a', amount: 1000 })], T0);
    expect(days[0]).toMatchObject({ customers: 1, mrr: 39 });
  });

  it('uses the most common currency and leaves the others out', () => {
    const { currency, days } = revenueHistory([sub(), sub({ customer: 'b' }), { ...sub({ customer: 'c' }), currency: 'eur' }], T0);
    expect(currency).toBe('usd');
    expect(days[0]!.customers).toBe(2);
  });
});

describe('GitHub + merge', () => {
  it('joins revenue and shipping into one cumulative snapshot per day', () => {
    const activity = shippingActivity(
      [
        { commit: { committer: { date: new Date(T0 + 1 * DAY + 5000).toISOString() }, author: null } },
        { commit: { committer: { date: new Date(T0 + 1 * DAY + 9000).toISOString() }, author: null } },
        { commit: { committer: null, author: { date: new Date(T0 + 3 * DAY).toISOString() } } },
      ],
      [
        { name: 'Launch', tag_name: 'v1.0.0', draft: false, published_at: new Date(T0 + 2 * DAY).toISOString() },
        { name: null, tag_name: 'v1.1.0', draft: true, published_at: null },
      ],
    );
    const snapshots = mergeHistory([{ t: T0 + 2 * DAY, customers: 1, mrr: 29 }], activity, T0 + 3 * DAY);
    expect(snapshots.map((s) => [s.commits, s.releases, s.customers])).toEqual([
      [2, 0, 0],
      [2, 1, 1],
      [3, 1, 0],
    ]);
    expect(snapshots[1]!.release).toBe('Launch');
  });

  it('returns nothing when there is no data at all', () => {
    expect(mergeHistory([], null, T0)).toEqual([]);
  });
});

describe('demo timeline', () => {
  it('is deterministic and tells a complete story', () => {
    const a = demoTimeline({ end: T0 });
    expect(a).toEqual(demoTimeline({ end: T0 }));
    const last = a.snapshots.at(-1)!;
    expect(a.snapshots).toHaveLength(540);
    expect(last.customers).toBeGreaterThan(300);
    expect(last.mrr).toBeGreaterThan(10_000);
    expect(a.snapshots.some((s) => s.release === 'v1.0 · Public launch')).toBe(true);
  });
});

describe('static file server', () => {
  const root = '/srv/tinytown/dist';
  it('serves files inside dist', () => {
    expect(staticPath(root, '/assets/app.js')).toBe('/srv/tinytown/dist/assets/app.js');
  });
  it('refuses to escape dist', () => {
    for (const p of ['/../package.json', '/..%2f..%2f.env', '/%2e%2e/%2e%2e/etc/passwd', '/assets/%00.js', '/%E0%A4%A']) {
      const resolved = staticPath(root, p);
      expect(resolved === null || resolved.startsWith(root + '/')).toBe(true);
    }
    expect(staticPath(root, '/assets/%00.js')).toBeNull();
  });
});
