import { startOfDay } from './types.ts';

export interface GithubRelease {
  name: string | null;
  tag_name: string;
  draft: boolean;
  published_at: string | null;
}

export interface GithubCommit {
  commit: { committer: { date: string } | null; author: { date: string } | null };
}

export interface ShippingActivity {
  /** day → commits that day */
  commits: Map<number, number>;
  /** day → release names published that day */
  releases: Map<number, string[]>;
}

export function shippingActivity(commits: GithubCommit[], releases: GithubRelease[]): ShippingActivity {
  const activity: ShippingActivity = { commits: new Map(), releases: new Map() };
  for (const c of commits) {
    const date = c.commit.committer?.date ?? c.commit.author?.date;
    if (!date) continue;
    const day = startOfDay(Date.parse(date));
    activity.commits.set(day, (activity.commits.get(day) ?? 0) + 1);
  }
  for (const r of releases) {
    if (r.draft || !r.published_at) continue;
    const day = startOfDay(Date.parse(r.published_at));
    const names = activity.releases.get(day) ?? [];
    names.push(r.name?.trim() || r.tag_name);
    activity.releases.set(day, names);
  }
  return activity;
}
