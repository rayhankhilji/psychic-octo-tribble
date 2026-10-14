import { describe, expect, it } from 'vitest';
import type { Timeline } from '../src/data/types.ts';
import { brandMark, brandTile } from '../src/ui/brand-icons.ts';
import { githubFacts, housingNeed, revenueFacts, shippingFacts, stripeFacts, viaOf } from '../src/ui/onboarding.ts';
import type { ConfigResponse } from '../src/api/contract.ts';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

function timeline(days: { mrr: number; customers: number; releases?: number; commits?: number; release?: string; users?: number }[], integrations = { stripe: true, github: true }): Timeline {
  return {
    name: 'Test',
    currency: 'usd',
    source: 'live',
    integrations,
    snapshots: days.map((d, i) => ({ t: T0 + i * DAY, releases: 0, commits: 0, ...d })),
  };
}

describe('setup cards: what a connection found', () => {
  it('reads MRR, paying customers and the first paying day from the timeline the city runs on', () => {
    const t = timeline([
      { mrr: 0, customers: 0 },
      { mrr: 49, customers: 1 },
      { mrr: 98, customers: 2 },
    ]);
    const r = revenueFacts(t)!;
    expect(r).toMatchObject({ mrr: 98, customers: 2, currency: 'usd', since: T0 + DAY });
    expect(r.spark).toEqual([49, 98]);
    expect(revenueFacts(timeline([{ mrr: 0, customers: 0 }]))!.since).toBeNull();
    expect(revenueFacts(timeline([{ mrr: 10, customers: 1 }], { stripe: false, github: true }))).toBeNull();
  });

  it('counts releases, the latest one, and commits in the last 30 days', () => {
    const days = Array.from({ length: 40 }, (_, i) => ({ mrr: 0, customers: 0, releases: i >= 35 ? 2 : 1, commits: i * 3, ...(i === 35 ? { release: 'v2.0' } : {}) }));
    expect(shippingFacts(timeline(days))).toEqual({ releases: 2, latest: { name: 'v2.0', t: T0 + 35 * DAY }, commits30: 90 });
  });

  it("houses users by the game's rule: the first 100 free, then $0.20 each", () => {
    expect(housingNeed(100)).toBe(0);
    expect(housingNeed(101)).toBe(20.2);
    expect(housingNeed(2_340)).toBe(468);
  });
});

describe('setup cards: honest about access', () => {
  it('calls our own apps read-only, and says plainly when Composio needs read and write', () => {
    const native = { connect: { stripe: true, github: true, posthog: true } } as ConfigResponse;
    const composio = { connect: { stripe: true, github: true, posthog: true, via: { stripe: 'composio', github: 'composio' } } } as unknown as ConfigResponse;
    expect(viaOf(native, 'stripe')).toBe('native');
    expect(viaOf(composio, 'github')).toBe('composio');
    expect(stripeFacts('native')).toMatchObject({ readOnly: true, grant: 'Stripe App permissions: subscription_read, plan_read' });
    expect(stripeFacts('composio').readOnly).toBe(false);
    expect(githubFacts('native').grant).toContain('Contents read-only, Metadata read-only');
    expect(githubFacts('composio').readOnly).toBe(false);
  });
});

describe('brand marks', () => {
  it('draws each mark with its official colours and a label, and keeps gradient ids unique', () => {
    expect(brandMark('stripe')).toContain('#635bff');
    expect(brandTile('github')).toContain('aria-label="GitHub"');
    const a = brandMark('posthog');
    const b = brandMark('posthog');
    const id = (s: string) => /id="(ph\d+)-0"/.exec(s)![1];
    expect(id(a)).not.toBe(id(b));
    expect(brandMark('ga4')).toContain('#f9ab00');
  });
});
