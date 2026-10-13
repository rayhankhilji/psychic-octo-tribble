#!/usr/bin/env node
/**
 * The launch spike, locally: thousands of founders opening their cities at
 * once against the real server and the fake providers (which answer with
 * the latency real ones have). Every founder is signed in, paid up and
 * connected to Stripe (and half to GitHub); each session does what the
 * app does on load (config, me, then timeline and actions together, then
 * lastSeen) and builds a few things.
 *
 *   node tools/loadtest.mjs                         2,000 founders over 2 minutes
 *   node tools/loadtest.mjs --users=10000 --minutes=10 --concurrency=3000
 *   node tools/loadtest.mjs --latency=none          fakes answer instantly (server cost only)
 *   node tools/loadtest.mjs --warm                  timelines already cached (a later day, not launch)
 *   node tools/loadtest.mjs --json=out.json         also write the numbers
 *
 * Reports p50/p95/p99 per route, errors, throughput, and what each request
 * costs upstream (auth lookups, database calls, Stripe and GitHub calls),
 * measured on one founder first so the totals can be scaled to production.
 * This is one Node process: on Vercel the same work spreads over many
 * function instances, so read the server-side numbers as cost per request
 * and the upstream counts as the load the providers will see.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { encrypt } from '../server/crypto.ts';
import { startStack } from '../tests/e2e/harness.mjs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a) => a.replace(/^--/, '').split('='))
    .map(([k, ...v]) => [k, v.length ? v.join('=') : true]),
);
const USERS = Number(args.users ?? 2000);
const MINUTES = Number(args.minutes ?? 2);
const CONCURRENCY = Number(args.concurrency ?? 2000);
const ACTIONS = Math.min(4, Number(args.actions ?? 3));
const GITHUB_SHARE = Number(args.github ?? 0.5);
/** Round trips as seen from a Vercel function in the same region as the providers. */
const REALISTIC = { auth: 35, rest: 12, stripe: 300, github: 120, posthog: 400 };
const latency = args.latency === 'none' ? {} : REALISTIC;

const DAY = 86_400_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** CPU seconds a process has used so far (Linux), or null elsewhere. */
function cpuSeconds(pid) {
  try {
    const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return (Number(f[11]) + Number(f[12])) / 100;
  } catch {
    return null;
  }
}
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);

console.log(`Starting the server and fakes (latency: ${args.latency === 'none' ? 'none' : JSON.stringify(REALISTIC)})…`);
const stack = await startStack({ latency, fakesOptions: { founderSubs: 60 } });
const { fakes, env, appUrl } = stack;

// ─── Seeding: founders who are signed in, paid and connected ──────────────

function seedFounder(i) {
  const email = `load+${i}@nightjar.test`;
  const user = fakes.createUser(email);
  const session = fakes.createSession(user, 6 * 3600);
  const ctx = `${user.id}:stripe`;
  const acct = `acct_load${String(i).padStart(6, '0')}`;
  const tok = fakes.issueStripeTokens(acct);
  const now = Date.now();
  fakes.insert('profiles', { user_id: user.id, seed: 1 + ((i * 2654435761) % 2147483646), joined_at: Math.floor(now / DAY) * DAY - 30 * DAY });
  fakes.insert('subscriptions', { user_id: user.id, stripe_customer_id: `cus_load${i}`, stripe_subscription_id: `sub_load${i}`, status: 'active', price_id: 'price_month', plan_interval: 'month', current_period_end: new Date(now + 20 * DAY).toISOString(), livemode: false });
  fakes.insert('connections', {
    user_id: user.id,
    provider: 'stripe',
    account_id: acct,
    livemode: false,
    secret: encrypt(tok.refresh_token, env.TOKEN_ENCRYPTION_KEY, ctx),
    access_token: encrypt(tok.access_token, env.TOKEN_ENCRYPTION_KEY, ctx),
    access_expires_at: new Date(now + 50 * 60_000).toISOString(),
    token_version: 1,
  });
  if (i % Math.round(1 / Math.max(GITHUB_SHARE, 0.001)) === 0 && GITHUB_SHARE > 0) {
    const inst = fakes.installationFor(`load-org-${i}`);
    fakes.insert('connections', { user_id: user.id, provider: 'github', account_id: String(inst.id), display_name: inst.account.login, metadata: { repo: inst.repos[0].full_name } });
  }
  return { email, token: session.access_token, userId: user.id };
}

// ─── HTTP with timing ─────────────────────────────────────────────────────

const samples = [];
async function hit(label, method, path, token, body) {
  const t0 = performance.now();
  let status = 0;
  let text = '';
  try {
    const res = await fetch(`${appUrl}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    status = res.status;
    text = await res.text();
  } catch (err) {
    text = err.message;
  }
  const ms = performance.now() - t0;
  samples.push({ label, status, ms, at: Date.now() });
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON.
  }
  return { status, json, text };
}

/** What the app does when a founder opens their city, then a few builds. */
async function session(f) {
  await hit('GET /api/config', 'GET', '/api/config');
  const me = await hit('GET /api/me', 'GET', '/api/me', f.token);
  if (me.status !== 200) return;
  const [tl] = await Promise.all([hit('GET /api/timeline', 'GET', '/api/timeline', f.token), hit('GET /api/world/actions', 'GET', '/api/world/actions', f.token)]);
  if (tl.status !== 200 || !tl.json?.snapshots?.length) return;
  const today = tl.json.snapshots.at(-1).t;
  await hit('PATCH /api/world', 'PATCH', '/api/world', f.token, { lastSeen: today });
  for (let k = 0; k < ACTIONS; k++) {
    await sleep(300 + Math.random() * 1200);
    await hit('POST /api/world/actions', 'POST', '/api/world/actions', f.token, { action: { t: today, kind: 'build', item: k % 2 ? 'park' : 'corner-shops', plot: `market:${k}` } });
  }
}

// ─── 1. Cost per request, on one founder ──────────────────────────────────

function routeDelta(before, after) {
  const out = {};
  for (const [k, v] of Object.entries(after)) if (v - (before[k] ?? 0)) out[k] = v - (before[k] ?? 0);
  return out;
}
const summarise = (delta) => {
  const by = { auth: 0, rest: 0, stripe: 0, github: 0, posthog: 0 };
  for (const [k, v] of Object.entries(delta)) by[k.split(' ')[0]] = (by[k.split(' ')[0]] ?? 0) + v;
  return by;
};

console.log('Measuring what one founder costs upstream…');
const probe = seedFounder(999_999);
const cost = {};
for (const [label, method, path, body] of [
  ['GET /api/config', 'GET', '/api/config'],
  ['GET /api/me (first, cold auth cache)', 'GET', '/api/me'],
  ['GET /api/me (again)', 'GET', '/api/me'],
  ['GET /api/timeline (cold: built from Stripe/GitHub)', 'GET', '/api/timeline'],
  ['GET /api/timeline (cached)', 'GET', '/api/timeline'],
  ['GET /api/world/actions', 'GET', '/api/world/actions'],
  ['PATCH /api/world', 'PATCH', '/api/world', { lastSeen: Math.floor(Date.now() / DAY) * DAY }],
  ['POST /api/world/actions', 'POST', '/api/world/actions', { action: { t: Math.floor(Date.now() / DAY) * DAY, kind: 'build', item: 'park', plot: 'market:3' } }],
]) {
  const before = { ...fakes.stats().routes };
  const r = await hit(label, method, path, probe.token, body);
  cost[label] = { status: r.status, ms: Math.round(samples.at(-1).ms), upstream: summarise(routeDelta(before, fakes.stats().routes)) };
}
samples.length = 0;

// A GitHub-connected founder's cold timeline, too.
const ghProbe = (() => {
  for (let i = 0; i < 4; i++) {
    const f = seedFounder(999_000 + i);
    if (fakes.rows('connections').some((r) => r.user_id === f.userId && r.provider === 'github')) return f;
  }
  return null;
})();
if (ghProbe) {
  const before = { ...fakes.stats().routes };
  await hit('probe', 'GET', '/api/timeline', ghProbe.token);
  cost['GET /api/timeline (cold, Stripe + GitHub)'] = { status: samples.at(-1).status, ms: Math.round(samples.at(-1).ms), upstream: summarise(routeDelta(before, fakes.stats().routes)) };
  samples.length = 0;
}
console.table(Object.fromEntries(Object.entries(cost).map(([k, v]) => [k, { status: v.status, ms: v.ms, ...v.upstream }])));

// ─── 2. The spike ─────────────────────────────────────────────────────────

console.log(`Seeding ${USERS.toLocaleString()} founders…`);
const founders = Array.from({ length: USERS }, (_, i) => seedFounder(i));
if (args.warm) {
  console.log('Warming timelines…');
  for (let i = 0; i < founders.length; i += 50) await Promise.all(founders.slice(i, i + 50).map((f) => hit('warm', 'GET', '/api/timeline', f.token)));
  samples.length = 0;
}
fakes.resetStats();

console.log(`${USERS.toLocaleString()} founders arriving over ${MINUTES} min (${(USERS / (MINUTES * 60)).toFixed(1)}/s), at most ${CONCURRENCY} at once, ${ACTIONS} builds each…`);
const t0 = Date.now();
const cpu0 = cpuSeconds(stack.pid);
const ownCpu0 = process.cpuUsage();
let inFlight = 0;
let peakInFlight = 0;
let started = 0;
const sessions = [];
const spacing = (MINUTES * 60_000) / USERS;
const ticker = setInterval(() => {
  const done = samples.length;
  process.stdout.write(`\r  ${((Date.now() - t0) / 1000).toFixed(0)}s · ${started} started · ${inFlight} in flight · ${done} requests   `);
}, 2000);
for (const f of founders) {
  const due = t0 + started * spacing;
  if (due > Date.now()) await sleep(due - Date.now());
  while (inFlight >= CONCURRENCY) await sleep(5);
  started++;
  inFlight++;
  peakInFlight = Math.max(peakInFlight, inFlight);
  sessions.push(
    session(f)
      .catch(() => {})
      .finally(() => inFlight--),
  );
}
await Promise.all(sessions);
clearInterval(ticker);
const elapsed = (Date.now() - t0) / 1000;
const cpu1 = cpuSeconds(stack.pid);
const ownCpu = process.cpuUsage(ownCpu0);
process.stdout.write('\n');

// ─── Report ───────────────────────────────────────────────────────────────

const byLabel = new Map();
for (const s of samples) (byLabel.get(s.label) ?? byLabel.set(s.label, []).get(s.label)).push(s);
const table = {};
for (const [label, list] of byLabel) {
  const ms = list.map((s) => s.ms).sort((a, b) => a - b);
  const statuses = {};
  for (const s of list) statuses[s.status] = (statuses[s.status] ?? 0) + 1;
  table[label] = {
    n: list.length,
    p50: Math.round(pct(ms, 50)),
    p95: Math.round(pct(ms, 95)),
    p99: Math.round(pct(ms, 99)),
    max: Math.round(ms.at(-1)),
    statuses: Object.entries(statuses)
      .map(([k, v]) => `${k}:${v}`)
      .join(' '),
  };
}
const perSecond = new Map();
for (const s of samples) perSecond.set(Math.floor(s.at / 1000), (perSecond.get(Math.floor(s.at / 1000)) ?? 0) + 1);
const errors = samples.filter((s) => s.status === 0 || s.status >= 500 || s.status === 429);
const upstream = fakes.stats();
const authLookups = Object.entries(upstream.routes).filter(([k]) => k.startsWith('auth GET /user')).reduce((a, [, v]) => a + v, 0);
const signedIn = samples.filter((s) => s.label !== 'GET /api/config').length;

console.log('\nLatency by route (ms):');
console.table(table);
console.log(`Requests: ${samples.length.toLocaleString()} in ${elapsed.toFixed(1)} s · mean ${(samples.length / elapsed).toFixed(1)}/s · peak ${Math.max(...perSecond.values())}/s · peak sessions in flight ${peakInFlight}`);
if (cpu0 !== null && cpu1 !== null) console.log(`Server CPU: ${(cpu1 - cpu0).toFixed(1)} s over ${elapsed.toFixed(0)} s (${(((cpu1 - cpu0) / elapsed) * 100).toFixed(0)}% of one core) · ${(((cpu1 - cpu0) * 1000) / Math.max(1, samples.length)).toFixed(1)} ms CPU per request`);
// The fakes and the load generator share this process: if it's pegged, latency is ours, not the server's.
console.log(`Load generator + fakes CPU: ${((ownCpu.user + ownCpu.system) / 1e6).toFixed(1)} s (${(((ownCpu.user + ownCpu.system) / 1e6 / elapsed) * 100).toFixed(0)}% of one core)`);
console.log(`Errors (network, 5xx, 429): ${errors.length} (${((errors.length / Math.max(1, samples.length)) * 100).toFixed(2)}%)`);
console.log(`Auth lookups: ${authLookups.toLocaleString()} for ${signedIn.toLocaleString()} signed-in requests (cache hit ${(100 - (authLookups / Math.max(1, signedIn)) * 100).toFixed(1)}%)`);
console.log('\nUpstream load (what the providers saw):');
console.table(upstream.services);
console.log('Busiest upstream routes:');
console.table(Object.fromEntries(Object.entries(upstream.routes).slice(0, 12).map(([k, v]) => [k, { calls: v, perSession: +(v / USERS).toFixed(2) }])));
if (upstream.unhandled.length) console.log('Unhandled by the fakes:', upstream.unhandled.slice(0, 10));
const serverErrors = stack.errors(t0);
if (serverErrors.length) {
  // Structured log lines differ by time and ids; group them by what went wrong.
  const counts = {};
  for (const l of serverErrors) {
    let key = l.replace(/[0-9a-f-]{36}/g, '<id>').slice(0, 140);
    try {
      const j = JSON.parse(l);
      key = [j.msg, j.method, j.table ?? j.route, j.status, j.err?.type, j.err?.message?.slice(0, 60)].filter((x) => x !== undefined).join(' · ');
    } catch {
      // A plain line.
    }
    counts[key] = (counts[key] ?? 0) + 1;
  }
  console.log('Server log errors:');
  console.table(counts);
}

if (args.json) {
  writeFileSync(String(args.json), JSON.stringify({ users: USERS, minutes: MINUTES, concurrency: CONCURRENCY, latency, elapsed, cost, table, errors: errors.length, requests: samples.length, serverCpuS: cpu0 !== null && cpu1 !== null ? cpu1 - cpu0 : null, generatorCpuS: (ownCpu.user + ownCpu.system) / 1e6, peakRps: Math.max(...perSecond.values()), authLookups, upstream: upstream.services, routes: upstream.routes }, null, 2));
  console.log(`Wrote ${args.json}`);
}
await stack.stop();
