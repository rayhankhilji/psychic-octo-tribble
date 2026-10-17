import { HttpError, badRequest, upstream } from './http.ts';

/**
 * PostHog as the population source: monthly active users (people seen in
 * the trailing 30 days) for every day of the last year, from the Query API's
 * trends query with `math: monthly_active`, so PostHog does the heavy
 * counting. Needs a personal API key with the "Query: read" scope.
 * https://posthog.com/docs/api/queries
 */

/** PostHog Cloud's ingestion and legacy hosts point at the API host for the same region. */
const ALIASES: Record<string, string> = {
  'us.i.posthog.com': 'us.posthog.com',
  'eu.i.posthog.com': 'eu.posthog.com',
  'app.posthog.com': 'us.posthog.com',
};

/**
 * The API origin for what the founder typed, or a 400. Only HTTPS hosts on
 * the allow-list (PostHog Cloud by default, `POSTHOG_HOSTS` for self-hosted)
 * are accepted, so the server can't be pointed at internal addresses.
 */
export function posthogOrigin(input: string, allowed: string[]): string {
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  } catch {
    throw badRequest('That PostHog address doesn’t look right. Try https://us.posthog.com.');
  }
  const host = ALIASES[url.hostname.toLowerCase()] ?? url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.port || url.username || !allowed.includes(host)) {
    throw badRequest(`Use your PostHog Cloud address (${allowed.join(' or ')}).`);
  }
  return `https://${host}`;
}

export const PROJECT_ID = /^\d{1,12}$/;
export const PERSONAL_KEY = /^phx_[A-Za-z0-9_-]{16,200}$/;

interface TrendsResult {
  results?: { days?: string[]; data?: number[] }[];
}

/** day (UTC ms) → monthly active users. */
export async function monthlyActiveUsers(origin: string, projectId: string, apiKey: string): Promise<Map<number, number>> {
  const res = await fetch(`${origin}/api/projects/${projectId}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'TinyTown monthly active users',
      query: {
        kind: 'TrendsQuery',
        series: [{ kind: 'EventsNode', event: null, name: 'All events', math: 'monthly_active' }],
        interval: 'day',
        dateRange: { date_from: '-365d' },
      },
    }),
  });
  if (res.status === 401 || res.status === 403) throw new HttpError(409, "PostHog didn't accept the API key. Check it has Query read access.", 'not_connected');
  if (res.status === 404) throw new HttpError(409, "PostHog couldn't find that project id.", 'not_connected');
  if (!res.ok) throw upstream(`PostHog responded ${res.status}.`);
  const body = (await res.json()) as TrendsResult;
  const series = body.results?.[0];
  const out = new Map<number, number>();
  if (!series?.days || !series.data) return out;
  series.days.forEach((d, i) => {
    const t = Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
    const v = series.data![i];
    if (Number.isFinite(t) && typeof v === 'number' && v >= 0) out.set(t, Math.round(v));
  });
  return out;
}
