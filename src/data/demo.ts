import { DAY, startOfDay, type Snapshot, type Timeline } from './types.ts';
import { pick, poisson, rng } from '../world/rng.ts';

const PLANS = [19, 19, 19, 19, 19, 19, 49, 49, 49, 199] as const;

/**
 * A fictional 18-month startup story, used when no integrations are
 * connected. Includes a launch, steady growth and one rough patch, so every
 * kind of world event shows up during a replay.
 */
export function demoTimeline(options: { days?: number; end?: number; seed?: number } = {}): Timeline {
  const days = options.days ?? 540;
  const end = startOfDay(options.end ?? Date.now());
  const r = rng(options.seed ?? 7);

  const roughPatch = (d: number) => d >= 330 && d < 352;
  const accounts: number[] = [];
  const snapshots: Snapshot[] = [];
  let releases = 0;
  let commits = 0;
  let minor = 0;
  let major = 0;
  let nextRelease = 34;

  for (let d = 0; d < days; d++) {
    const t = end - (days - 1 - d) * DAY;

    if (d >= 19) {
      const demand = 2.6 / (1 + Math.exp(-(d - 300) / 60)) + 0.09;
      const signups = poisson(r, roughPatch(d) ? demand * 0.15 : demand);
      const priceRise = d >= 400 ? 1.25 : 1;
      for (let i = 0; i < signups; i++) accounts.push(pick(r, PLANS) * priceRise);
      if (d === 19 && accounts.length === 0) accounts.push(PLANS[0]);

      const churn = poisson(r, accounts.length * (roughPatch(d) ? 0.008 : 0.0011));
      for (let i = 0; i < churn && accounts.length > 1; i++) {
        accounts.splice(Math.floor(r() * accounts.length), 1);
      }
    }

    const weekday = new Date(t).getUTCDay() % 6 !== 0;
    commits += poisson(r, weekday ? 7 : 1.5);

    let release: string | undefined;
    if (d === nextRelease) {
      releases++;
      if (d >= 90 && major === 0) {
        major = 1;
        minor = 0;
        release = 'v1.0 · Public launch';
      } else {
        minor++;
        release = `v${major}.${minor}`;
      }
      nextRelease += 22 + Math.floor(r() * 18);
      if (major === 0 && nextRelease > 90) nextRelease = 90;
    }

    snapshots.push({
      t,
      customers: accounts.length,
      mrr: Math.round(accounts.reduce((sum, a) => sum + a, 0)),
      releases,
      commits,
      ...(release ? { release } : {}),
    });
  }

  return {
    name: 'Nightjar',
    currency: 'usd',
    source: 'demo',
    integrations: { stripe: false, github: false },
    snapshots,
  };
}
