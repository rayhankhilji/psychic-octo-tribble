import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTimeline, readConfig } from '../server/timeline.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 10, 12);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const subscription = (id: string, customer: string, startDay: number) => ({
  id,
  customer,
  status: 'active',
  start_date: (NOW - startDay * DAY) / 1000,
  ended_at: null,
  trial_end: null,
  currency: 'usd',
  items: { data: [{ quantity: 1, price: { unit_amount: 4900, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } } }] },
});

afterEach(() => vi.unstubAllGlobals());

describe('buildTimeline', () => {
  it('returns null when nothing is configured', async () => {
    expect(await buildTimeline(readConfig({}))).toBeNull();
  });

  it('pages through Stripe and GitHub and merges them', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(`${url.host}${url.pathname}?${url.searchParams}`);
      if (url.host === 'api.stripe.com') {
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer rk_test_123');
        return url.searchParams.get('starting_after')
          ? json({ data: [subscription('sub_2', 'cus_b', 1)], has_more: false })
          : json({ data: [subscription('sub_1', 'cus_a', 3)], has_more: true });
      }
      if (url.pathname.endsWith('/commits')) {
        return json([{ commit: { committer: { date: new Date(NOW - DAY).toISOString() }, author: null } }]);
      }
      if (url.pathname.endsWith('/releases')) {
        return json([{ name: 'v2', tag_name: 'v2.0.0', draft: false, published_at: new Date(NOW).toISOString() }]);
      }
      return json({}, 404);
    });

    const t = await buildTimeline(readConfig({ STRIPE_SECRET_KEY: 'rk_test_123', GITHUB_REPO: 'acme/app', TINYTOWN_NAME: 'Acme' }), NOW);
    expect(t).not.toBeNull();
    expect(t!.name).toBe('Acme');
    expect(t!.integrations).toEqual({ stripe: true, github: true });
    expect(calls.filter((c) => c.startsWith('api.stripe.com'))).toHaveLength(2);
    expect(calls.some((c) => c.includes('starting_after=sub_1'))).toBe(true);

    const last = t!.snapshots.at(-1)!;
    expect(t!.snapshots).toHaveLength(4);
    expect(last).toMatchObject({ customers: 2, mrr: 98, releases: 1, commits: 1, release: 'v2' });
  });

  it('surfaces upstream errors instead of inventing data', async () => {
    vi.stubGlobal('fetch', async () => json({ error: { message: 'Invalid API Key' } }, 401));
    await expect(buildTimeline(readConfig({ STRIPE_SECRET_KEY: 'rk_bad' }), NOW)).rejects.toThrow('Stripe responded 401: Invalid API Key');
  });

  it('explains GitHub rate limits briefly', async () => {
    vi.stubGlobal('fetch', async () =>
      json({ message: "API rate limit exceeded for 1.2.3.4. (But here's the good news: …)", documentation_url: 'https://docs.github.com' }, 403),
    );
    await expect(buildTimeline(readConfig({ GITHUB_REPO: 'acme/app' }), NOW)).rejects.toThrow(
      'GitHub responded 403: API rate limit exceeded for 1.2.3.4. Setting GITHUB_TOKEN raises the rate limit.',
    );
  });

  it('rejects malformed repository names before calling GitHub', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(buildTimeline(readConfig({ GITHUB_REPO: 'https://github.com/acme/app' }), NOW)).rejects.toThrow(/owner\/repo/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
