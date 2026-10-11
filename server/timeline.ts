import { shippingActivity } from '../src/data/github.ts';
import { mergeHistory } from '../src/data/merge.ts';
import { revenueHistory } from '../src/data/stripe.ts';
import type { Timeline } from '../src/data/types.ts';
import { fetchGithub, fetchStripeSubscriptions } from './sources.ts';

export interface Config {
  name: string;
  stripeKey?: string;
  githubRepo?: string;
  githubToken?: string;
}

export function readConfig(env: NodeJS.ProcessEnv): Config {
  return {
    name: env.TINYTOWN_NAME?.trim() || 'Your Startup',
    stripeKey: env.STRIPE_SECRET_KEY?.trim() || undefined,
    githubRepo: env.GITHUB_REPO?.trim() || undefined,
    githubToken: env.GITHUB_TOKEN?.trim() || undefined,
  };
}

export async function buildTimeline(config: Config, now = Date.now()): Promise<Timeline | null> {
  if (!config.stripeKey && !config.githubRepo) return null;

  const [stripe, github] = await Promise.all([
    config.stripeKey ? fetchStripeSubscriptions(config.stripeKey) : null,
    config.githubRepo ? fetchGithub(config.githubRepo, config.githubToken) : null,
  ]);
  const revenue = stripe ? revenueHistory(stripe, now) : { currency: 'usd', days: [] };
  const shipping = github ? shippingActivity(github.commits, github.releases) : null;

  return {
    name: config.name,
    currency: revenue.currency,
    source: 'live',
    integrations: { stripe: !!stripe, github: !!github },
    snapshots: mergeHistory(revenue.days, shipping, now),
  };
}
