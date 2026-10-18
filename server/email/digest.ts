import { simOptionsFor } from '../../src/api/contract.ts';
import { DAY, type Timeline } from '../../src/data/types.ts';
import { simulate, type Action } from '../../src/game/economy.ts';
import type { Hosted } from '../context.ts';
import { sha256 } from '../crypto.ts';
import { unsubscribeHeaders, unsubscribeUrl, type EmailPrefsRow } from './prefs.ts';
import { EmailError, providerFor, realSleep, type EmailProvider } from './provider.ts';
import { brandFor, claimMany, dedupeKey, markSent, release, type Outgoing } from './send.ts';
import { inList, select, userEmails } from './store.ts';
import { digest, type DigestNumbers } from './templates.ts';

/**
 * "Your city this week": a Monday email to every paying founder who hasn't
 * turned it off, with the real numbers from their cached timeline (MRR,
 * customers, users, releases, commits), what they built, and what their
 * city has left to spend. Called by the weekly cron.
 *
 * Nothing is invented. The window is the last seven days of the founder's
 * own snapshots; a section appears only when its source is connected; a
 * founder whose numbers haven't moved since last week is skipped rather than
 * sent last week's news. Timelines are the cached ones in `timelines`, kept
 * fresh by the daily pipeline and by founders opening the app.
 */

const PAID = ['active', 'trialing', 'past_due'];
/** Users read per database page. Timelines are the heavy part (a year of days each). */
const PAGE = 200;
/** Two provider calls a second: a fifth of Resend's default 10/s, leaving room for sign-in mail and webhooks. */
const PACE_MS = 500;
/** Stop starting new batches after this long, so the function ends cleanly before Vercel's limit. Rerunning finishes the rest. */
const BUDGET_MS = 240_000;
/**
 * The latest snapshot must be from the last seven days. Anything older was
 * already in last week's email (or the founder's data stopped updating), so
 * they're skipped rather than sent the same numbers twice.
 */
const STALE_MS = 7 * DAY;

// ─── The numbers (pure) ───────────────────────────────────────────────────

/**
 * One founder's week, from their timeline and saved actions. Null when there
 * isn't a week to describe: no snapshots, or the latest is stale.
 */
export function digestNumbers(timeline: Timeline, actions: Action[], joinedAt: number | null, name: string, now: number): DigestNumbers | null {
  const snaps = timeline.snapshots;
  const last = snaps.length - 1;
  if (last < 1) return null;
  const end = snaps[last]!;
  if (now - end.t >= STALE_MS) return null;
  // The latest day at least seven days before the end; or the first day, if history is shorter.
  let i0 = 0;
  for (let i = last - 1; i >= 0; i--) {
    if (snaps[i]!.t <= end.t - 7 * DAY) {
      i0 = i;
      break;
    }
  }
  const start = snaps[i0]!;
  const inWindow = (t: number) => t > start.t && t <= end.t;

  const releaseNames = snaps
    .slice(i0 + 1, last + 1)
    .map((s) => s.release)
    .filter((r): r is string => !!r)
    .slice(-5);

  const counts = new Map<string, number>();
  let movedHome: DigestNumbers['movedHome'] = null;
  for (const a of actions) {
    if (!inWindow(a.t)) continue;
    if (a.kind === 'build') counts.set(a.item, (counts.get(a.item) ?? 0) + 1);
    else movedHome = { tier: a.tier, choice: a.choice };
  }

  let city: DigestNumbers['city'] = null;
  try {
    const state = simulate(snaps, actions, last, simOptionsFor(joinedAt));
    city = { treasury: state.treasury, unhoused: state.unhoused };
  } catch {
    // A replay that can't run leaves the city line out; the real numbers still stand.
  }

  const hasUsers = end.users !== undefined && start.users !== undefined;
  return {
    name,
    currency: timeline.currency,
    from: start.t,
    to: end.t,
    fullWeek: end.t - start.t === 7 * DAY,
    revenue: timeline.integrations.stripe ? { mrr: end.mrr, mrrChange: round2(end.mrr - start.mrr), customers: end.customers, customersChange: end.customers - start.customers } : null,
    users: hasUsers ? { value: end.users!, change: end.users! - start.users! } : null,
    shipping: timeline.integrations.github ? { releases: end.releases - start.releases, releaseNames, commits: end.commits - start.commits } : null,
    built: [...counts].map(([item, count]) => ({ item, count })),
    movedHome,
    city,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** `2026-W42`: the ISO week a run belongs to, so a rerun the same week skips everyone already sent. */
export function isoWeek(now: number): string {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  // ISO weeks are numbered by their Thursday's place in its year.
  const week = 1 + Math.floor((thursday.getTime() - Date.UTC(thursday.getUTCFullYear(), 0, 1)) / (7 * DAY));
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ─── Sending ──────────────────────────────────────────────────────────────

export interface DigestOptions {
  provider?: EmailProvider | null;
  sleep?: (ms: number) => Promise<void>;
  /** Wall clock for the time budget (tests pass a fake). */
  clock?: () => number;
}

interface ProfileBits {
  user_id: string;
  name: string;
  joined_at: number | null;
}

/**
 * `sent`: digests the provider accepted. `skipped`: founders with nothing to
 * send this week (digest off, no address, stale or no numbers, already sent,
 * or an address the provider refused). `left`: founders still owed one,
 * because the run ran out of time or the provider was struggling; `done` is
 * false while any are left, and running again the same ISO week sends only
 * those.
 */
export interface DigestResult {
  sent: number;
  skipped: number;
  left: number;
  done: boolean;
}

export async function weeklyDigest(ctx: Hosted, now: number, opts: DigestOptions = {}): Promise<DigestResult> {
  const provider = opts.provider === undefined ? providerFor(ctx.env) : opts.provider;
  const sleep = opts.sleep ?? realSleep;
  const clock = opts.clock ?? Date.now;
  const started = clock();
  const secret = ctx.env.STATE_SECRET?.trim();
  if (!secret) {
    console.error('weekly digest: STATE_SECRET is not set, so unsubscribe links can’t be signed; nothing sent');
    return { sent: 0, skipped: 0, left: 0, done: true };
  }
  const brand = brandFor(ctx);
  const week = isoWeek(now);
  let sent = 0;
  let skipped = 0;
  let left = 0;
  const result = (): DigestResult => ({ sent, skipped, left, done: left === 0 });

  // 1. Everyone paying, minus anyone who turned the digest off.
  const ids: string[] = [];
  for (let after = ''; ; ) {
    const page = await select<{ user_id: string }>(
      ctx.supabase,
      'subscriptions',
      `select=user_id&status=${inList(PAID)}&order=user_id.asc&limit=${PAGE}${after ? `&user_id=gt.${after}` : ''}`,
    );
    if (!page.length) break;
    const off = new Set(
      (await select<Pick<EmailPrefsRow, 'user_id'>>(ctx.supabase, 'email_prefs', `select=user_id&weekly_digest=eq.false&user_id=${inList(page.map((r) => r.user_id))}`)).map((r) => r.user_id),
    );
    for (const r of page) {
      if (off.has(r.user_id)) skipped++;
      else ids.push(r.user_id);
    }
    if (page.length < PAGE) break;
    after = page.at(-1)!.user_id;
  }
  if (!ids.length) return result();

  if (!provider) {
    for (const id of ids) console.log(`email not configured: would send digest to ${id}`);
    skipped += ids.length;
    return result();
  }

  // 2. Addresses, from Auth.
  const emails = await userEmails(ctx.supabase, new Set(ids), now);

  // 3. A page at a time: read their numbers, claim, send in batches.
  for (let i = 0; i < ids.length; i += PAGE) {
    if (clock() - started > BUDGET_MS) {
      left += ids.length - i;
      console.error(`weekly digest: out of time with ${ids.length - i} founders left; run it again this week to finish (anyone already sent is skipped)`);
      break;
    }
    const chunk = ids.slice(i, i + PAGE).filter((id) => {
      if (emails.has(id)) return true;
      skipped++;
      return false;
    });
    if (!chunk.length) continue;
    const filter = `user_id=${inList(chunk)}`;
    const [timelines, profiles, worlds] = await Promise.all([
      select<{ user_id: string; timeline: Timeline }>(ctx.supabase, 'timelines', `select=user_id,timeline&${filter}`),
      select<ProfileBits>(ctx.supabase, 'profiles', `select=user_id,name,joined_at&${filter}`),
      select<{ user_id: string; actions: Action[] }>(ctx.supabase, 'worlds', `select=user_id,actions&${filter}`),
    ]);
    const tl = new Map(timelines.map((r) => [r.user_id, r.timeline]));
    const pr = new Map(profiles.map((r) => [r.user_id, r]));
    const wo = new Map(worlds.map((r) => [r.user_id, r.actions]));

    const outs: Outgoing[] = [];
    for (const id of chunk) {
      const timeline = tl.get(id);
      const profile = pr.get(id);
      const numbers = timeline ? digestNumbers(timeline, wo.get(id) ?? [], profile?.joined_at ?? null, profile?.name ?? timeline.name, now) : null;
      if (!numbers) {
        skipped++;
        continue;
      }
      const digestUrl = unsubscribeUrl(brand.appUrl, secret, id, 'digest');
      const email = digest(brand, numbers, { digest: digestUrl, all: unsubscribeUrl(brand.appUrl, secret, id, 'all') });
      outs.push({
        kind: 'digest',
        userId: id,
        key: dedupeKey('digest', id, week),
        message: { to: emails.get(id)!, ...email, headers: unsubscribeHeaders(digestUrl), tags: { category: 'digest' } },
      });
    }

    const won = await claimMany(ctx, outs);
    skipped += outs.length - won.size;
    const mine = outs.filter((o) => won.has(o.key));
    for (let j = 0; j < mine.length; j += provider.maxBatch) {
      const batch = mine.slice(j, j + provider.maxBatch);
      const r = await sendBatch(ctx, provider, batch, sleep);
      sent += r.sent;
      left += r.retry;
      skipped += batch.length - r.sent - r.retry;
      await sleep(PACE_MS);
    }
  }
  console.log(`weekly digest ${week}: ${sent} sent, ${skipped} skipped, ${left} left`);
  return result();
}

/**
 * One batch call. If the provider refuses the whole batch for something
 * other than load (one bad address can fail all hundred), each message is
 * tried on its own so one bad row costs only itself. Returns how many went,
 * and how many were released for a rerun because the provider was struggling.
 * A message the provider refuses outright keeps its claim, so the hourly
 * catch-up doesn't retry a bad address all week.
 */
async function sendBatch(ctx: Hosted, provider: EmailProvider, batch: Outgoing[], sleep: (ms: number) => Promise<void>): Promise<{ sent: number; retry: number }> {
  const key = `tt-digest-${sha256(batch.map((o) => o.key).join(','))}`;
  try {
    const ids = await provider.sendBatch(batch.map((o) => o.message), key);
    await markSent(ctx, provider.name, batch.map((out, i) => ({ out, id: ids[i] ?? '' }))).catch(() => console.error('weekly digest: a batch was sent but the log could not be updated'));
    return { sent: batch.length, retry: 0 };
  } catch (err) {
    console.error(`weekly digest: a batch of ${batch.length} failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    if (retryable(err)) {
      // The provider is struggling; let a rerun pick these up.
      await release(ctx, batch.map((o) => o.key)).catch(() => undefined);
      return { sent: 0, retry: batch.length };
    }
  }
  const r = { sent: 0, retry: 0 };
  for (const out of batch) {
    await sleep(PACE_MS);
    try {
      const id = await provider.send(out.message, `tt-${out.key}`);
      await markSent(ctx, provider.name, [{ out, id }]).catch(() => undefined);
      r.sent++;
    } catch (err) {
      console.error(`email digest for ${out.userId} failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      if (retryable(err)) {
        await release(ctx, [out.key]).catch(() => undefined);
        r.retry++;
      }
    }
  }
  return r;
}

const retryable = (err: unknown) => !(err instanceof EmailError) || err.retryable;

