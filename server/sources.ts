import type { GithubCommit, GithubRelease } from '../src/data/github.ts';
import type { StripeSubscription } from '../src/data/stripe.ts';

/** A readable error from an upstream API response, without dumping its body. */
async function upstreamError(service: string, res: Response): Promise<Error> {
  const text = await res.text();
  let message = text.slice(0, 160);
  try {
    const body = JSON.parse(text) as { message?: string; error?: { message?: string } };
    message = body.error?.message ?? body.message ?? message;
  } catch {
    // Not JSON; keep the start of the text.
  }
  const hint = service === 'GitHub' && res.status === 403 ? ' Setting GITHUB_TOKEN raises the rate limit.' : '';
  return new Error(`${service} responded ${res.status}: ${message.split(' (')[0]!.trim()}${hint}`);
}

const STRIPE_PAGE_LIMIT = 50; // 5,000 subscriptions

export async function fetchStripeSubscriptions(key: string): Promise<StripeSubscription[]> {
  const subs: StripeSubscription[] = [];
  let after: string | undefined;
  for (let page = 0; page < STRIPE_PAGE_LIMIT; page++) {
    const url = new URL('https://api.stripe.com/v1/subscriptions');
    url.searchParams.set('status', 'all');
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('starting_after', after);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw await upstreamError('Stripe', res);
    const body = (await res.json()) as { data: StripeSubscription[]; has_more: boolean };
    subs.push(...body.data);
    if (!body.has_more || body.data.length === 0) break;
    after = body.data.at(-1)!.id;
  }
  return subs;
}

const GITHUB_COMMIT_PAGES = 10; // 1,000 most recent commits

export async function fetchGithub(repo: string, token?: string): Promise<{ commits: GithubCommit[]; releases: GithubRelease[] }> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`GITHUB_REPO should look like owner/repo, got "${repo}"`);
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'tinytown' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const pages = async <T>(path: string, max: number): Promise<T[]> => {
    const out: T[] = [];
    for (let page = 1; page <= max; page++) {
      const res = await fetch(`https://api.github.com/repos/${repo}/${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, { headers });
      if (res.status === 409) break; // empty repository
      if (!res.ok) throw await upstreamError('GitHub', res);
      const batch = (await res.json()) as T[];
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  };

  const [commits, releases] = await Promise.all([
    pages<GithubCommit>('commits', GITHUB_COMMIT_PAGES),
    pages<GithubRelease>('releases', 5),
  ]);
  return { commits, releases };
}
