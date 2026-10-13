/**
 * A stand-in for `/api/admin/*` so the console can be built, reviewed and
 * screenshotted without a database: a believable launch two waves in, about
 * 10,000 people on the list. Loaded only with `?mock` in development or with
 * `?debug` (main.ts), in its own chunk, and it never talks to a server.
 * Invites and comps change its in-memory state, so the flows can be tried.
 */
import type { AuditEntry, InviteResult, Overview, UserDetail, UserHit, WaitlistEntry, WaitlistPage } from './types.ts';
import { INVITE_BATCH_MAX } from './types.ts';

const DAY = 86_400_000;
const NOW = Date.now();

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261013);

const FIRST = ['maya', 'jon', 'priya', 'leo', 'ana', 'sam', 'kenji', 'ruth', 'omar', 'tess', 'ivan', 'nora', 'eli', 'zara', 'theo', 'lin', 'aisha', 'ben', 'cleo', 'dev', 'fern', 'hugo', 'ines', 'jude'];
const DOMAIN = ['loopwise.dev', 'tallyho.app', 'gmail.com', 'quillstack.io', 'fernhq.com', 'hey.com', 'orbitly.co', 'mintmark.so', 'outlook.com', 'parcel.run', 'brightbase.ai', 'proton.me'];
/** Where people came from, as cumulative shares. */
const SOURCES: [string, number][] = [
  ['import', 0.86],
  ['producthunt', 0.95],
  ['twitter', 0.988],
  ['signin', 1],
];
const hex = (len: number) => Array.from({ length: len }, () => Math.floor(rand() * 16).toString(16)).join('');

// ─── The waitlist ─────────────────────────────────────────────────────────

const LAUNCH = NOW - 9 * DAY;
const rows: WaitlistEntry[] = [];
for (let i = 0; i < 10_043; i++) {
  const r = rand();
  const source = SOURCES.find(([, p]) => r < p)![0];
  const email = `${FIRST[i % FIRST.length]}${i > FIRST.length ? i : ''}@${DOMAIN[Math.floor(rand() * DOMAIN.length)]}`;
  rows.push({ email, source, createdAt: NOW - 220 * DAY + i * 1_700_000, invitedAt: null, wave: null, notifiedAt: null, signedUpAt: null, userId: null });
}
function letIn(from: number, count: number, wave: number, at: number, signUp: number) {
  for (const r of rows.slice(from, from + count)) {
    r.invitedAt = at;
    r.wave = wave;
    r.notifiedAt = at + 60_000;
    if (rand() < signUp) {
      r.signedUpAt = at + rand() * (NOW - at);
      r.userId = `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
    }
  }
}
letIn(0, 500, 1, LAUNCH, 0.82);
letIn(500, 1500, 2, NOW - 2 * DAY, 0.55);
// Three invites from wave 2 that never reached the email module.
for (const r of rows.slice(1997, 2000)) r.notifiedAt = null;
const paidUsers = new Set(rows.filter((r) => r.userId && rand() < 0.52).map((r) => r.userId!));

// ─── Founders ─────────────────────────────────────────────────────────────

const STARTUPS = ['Loopwise', 'Tallyho', 'Quillstack', 'Fern', 'Orbitly', 'Mintmark', 'Parcel', 'Brightbase', 'Hearth', 'Signal Peak', 'Kiln', 'Driftwood'];
const people: (UserHit & { name: string })[] = rows
  .filter((r) => r.userId)
  .slice(0, 60)
  .map((r, i) => ({
    id: r.userId!,
    email: r.email,
    name: STARTUPS[i % STARTUPS.length]!,
    createdAt: r.signedUpAt,
    lastSignInAt: NOW - rand() * 3 * DAY,
    plan: paidUsers.has(r.userId!) ? (i % 17 === 5 ? 'past_due' : 'active') : i % 9 === 4 ? 'canceled' : 'none',
    comp: false,
  }));
people[3]!.comp = true;
people[3]!.plan = 'active';
const comps = new Map<string, { reason: string; by: string; at: number }>([[people[3]!.id, { reason: 'Design partner: gave feedback on the first build', by: 'owner@tinytown.dev', at: NOW - 6 * DAY }]]);

const audit: AuditEntry[] = [];
let auditId = 900;
function log(action: string, target: string | null, detail: Record<string, unknown> = {}) {
  audit.unshift({ id: auditId++, at: Date.now(), adminEmail: 'owner@tinytown.dev', action, target, status: 'ok', detail });
}
log('waitlist.invite_next', null, { input: { count: 500, wave: 1 }, result: { invited: 500 } });
audit[0]!.at = LAUNCH;
log('comp.grant', people[3]!.id, { input: { reason: comps.get(people[3]!.id)!.reason } });
audit[0]!.at = NOW - 6 * DAY;
for (let i = 0; i < 3; i++) {
  log('waitlist.invite_next', null, { input: { count: 500, wave: 2 }, result: { invited: 500 } });
  audit[0]!.at = NOW - 2 * DAY + i * 40_000;
}
log('user.read', people[0]!.id);
audit[0]!.at = NOW - 3 * 3600_000;
log('overview.read', null);
audit[0]!.at = NOW - 40 * 60_000;

// ─── Answers ──────────────────────────────────────────────────────────────

function funnel() {
  const invited = rows.filter((r) => r.invitedAt);
  const signedUp = invited.filter((r) => r.signedUpAt);
  return {
    total: rows.length,
    waiting: rows.length - invited.length,
    invited: invited.length,
    signedUp: signedUp.length,
    paid: signedUp.filter((r) => paidUsers.has(r.userId!)).length,
    unnotified: invited.filter((r) => !r.notifiedAt).length,
    lastWave: Math.max(0, ...invited.map((r) => r.wave ?? 0)) || null,
  };
}

function overview(): Overview {
  const monthly = Math.round(paidUsers.size * 0.76);
  const yearly = paidUsers.size - monthly;
  const series = Array.from({ length: 30 }, (_, i) => {
    const day = NOW - (29 - i) * DAY;
    const since = Math.max(0, (day - LAUNCH) / DAY + 1);
    const paying = Math.round(Math.min(paidUsers.size, since * since * 8.5));
    return { day, mrr: Math.round(paying * 0.76 * 1200 + paying * 0.24 * 825), paying, accounts: Math.round(paying * 1.9) };
  });
  return {
    generatedAt: Date.now(),
    source: 'product_daily',
    access: 'waitlist',
    accounts: { total: rows.filter((r) => r.signedUpAt).length + 14, d1: 96, d7: 1_104, d30: rows.filter((r) => r.signedUpAt).length },
    paying: { total: paidUsers.size + comps.size, monthly, yearly, comp: comps.size, pastDue: 9, cancelling: 14 },
    mrr: { amount: monthly * 1200 + Math.round((yearly * 9900) / 12), currency: 'usd' },
    movement: { d1: { started: 38, ended: 1 }, d7: { started: paidUsers.size - 61, ended: 6 }, d30: { started: paidUsers.size + 4, ended: 11 } },
    waitlist: funnel(),
    connections: {
      stripe: { total: 702, live: 689, test: 13, broken: 4 },
      github: { total: 512, noRepo: 23 },
      posthog: 88,
      broken: [
        { userId: people[7]!.id, reason: 'Stripe refused the token' },
        { userId: people[12]!.id, reason: 'Connected in test mode' },
        { userId: people[19]!.id, reason: 'Connected in test mode' },
        { userId: people[21]!.id, reason: 'No refresh token stored' },
      ],
    },
    series,
  };
}

function waitlistPage(p: URLSearchParams): WaitlistPage {
  const status = p.get('status') ?? 'all';
  const q = (p.get('q') ?? '').toLowerCase();
  const source = p.get('source');
  const offset = Number(p.get('offset') ?? 0);
  let list = rows.filter((r) => (status === 'waiting' ? !r.invitedAt : status === 'invited' ? !!r.invitedAt : status === 'joined' ? !!r.signedUpAt : true));
  if (source) list = list.filter((r) => r.source === source);
  if (q) list = list.filter((r) => r.email.includes(q));
  list = status === 'waiting' ? list : [...list].sort((a, b) => (b.invitedAt ?? b.createdAt) - (a.invitedAt ?? a.createdAt));
  const sources = new Map<string, { source: string; total: number; waiting: number }>();
  const waves = new Map<number, WaitlistPage['waves'][number]>();
  for (const r of rows) {
    const s = sources.get(r.source) ?? { source: r.source, total: 0, waiting: 0 };
    s.total++;
    if (!r.invitedAt) s.waiting++;
    sources.set(r.source, s);
    if (r.invitedAt) {
      const w = waves.get(r.wave!) ?? { wave: r.wave!, invited: 0, signedUp: 0, paid: 0, at: r.invitedAt };
      w.invited++;
      if (r.signedUpAt) w.signedUp++;
      if (r.userId && paidUsers.has(r.userId)) w.paid++;
      w.at = Math.min(w.at!, r.invitedAt);
      waves.set(r.wave!, w);
    }
  }
  return {
    rows: list.slice(offset, offset + 50),
    total: list.length,
    offset,
    limit: 50,
    funnel: funnel(),
    sources: [...sources.values()].sort((a, b) => b.total - a.total),
    waves: [...waves.values()].sort((a, b) => a.wave - b.wave),
  };
}

function detail(id: string): UserDetail | null {
  const p = people.find((x) => x.id === id);
  if (!p) return null;
  const w = rows.find((r) => r.userId === id) ?? null;
  const comp = comps.get(id) ?? null;
  const paid = p.plan !== 'none';
  return {
    user: { id, email: p.email, createdAt: p.createdAt, lastSignInAt: p.lastSignInAt, providers: id.endsWith('0') ? ['github'] : ['email'], confirmed: true },
    profile: { name: p.name, seed: 1_204_331, joinedAt: (p.createdAt ?? NOW) - ((p.createdAt ?? NOW) % DAY), lastSeen: NOW - (NOW % DAY), createdAt: p.createdAt },
    plan: paid
      ? {
          status: p.plan,
          interval: comp ? 'year' : 'month',
          renewsAt: comp ? null : NOW + 21 * DAY,
          cancelAtPeriodEnd: false,
          livemode: comp ? null : true,
          stripeCustomer: comp ? null : 'cus_R2kq8XjT0bLw1e',
          stripeSubscription: comp ? null : 'sub_1Q8xyZK2hT0pA3cv',
          comp: comp ? { reason: comp.reason, by: comp.by, at: comp.at } : null,
        }
      : null,
    connections: paid
      ? [
          { provider: 'stripe', account: 'acct_1PzT9xK2hT0pA3cv', name: `${p.name} Inc.`, livemode: true, connectedAt: (p.createdAt ?? NOW) + 3600_000, detail: null, health: 'ok' },
          { provider: 'github', account: '51723094', name: null, livemode: null, connectedAt: (p.createdAt ?? NOW) + 7200_000, detail: `${p.name.toLowerCase().replace(/\s/g, '')}/app`, health: 'ok' },
        ]
      : [],
    world: paid
      ? {
          actions: 23,
          built: 19,
          homeMoves: 4,
          version: 23,
          recent: [
            { t: NOW - DAY, what: 'Built ferry-terminal on b7-2' },
            { t: NOW - DAY, what: 'Moved house: victorian (tier 3)' },
            { t: NOW - 2 * DAY, what: 'Built coffee-cart on b3-1' },
            { t: NOW - 3 * DAY, what: 'Built park on b2-0' },
            { t: NOW - 4 * DAY, what: 'Built apartments on b4-3' },
          ],
        }
      : null,
    timeline: paid ? { fetchedAt: NOW - 11 * 60_000, days: 412, mrr: 4_280, customers: 167 } : null,
    waitlist: w,
    history: paid ? [{ at: comp?.at ?? (p.createdAt ?? NOW) + 900_000, change: 'started', status: 'active', interval: comp ? 'year' : 'month', comp: !!comp }] : [],
    audit: audit.filter((a) => a.target === id),
  };
}

// ─── The fetch ────────────────────────────────────────────────────────────

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const delay = () => new Promise((r) => setTimeout(r, 120 + Math.random() * 160));

export async function mockFetch(input: string, init: RequestInit = {}): Promise<Response> {
  await delay();
  const url = new URL(input, location.origin);
  const path = url.pathname.replace(/^\/api\/admin/, '');
  const method = init.method ?? 'GET';
  const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

  if (new URLSearchParams(location.search).has('mfa') && sessionStorage.getItem('tt-mock-aal2') !== '1') {
    return new Response(JSON.stringify({ error: 'Confirm it’s you with your authenticator app to open the console.', code: 'mfa_required' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }
  if (path === '/me') return ok({ email: 'owner@tinytown.dev', access: 'waitlist', now: Date.now() });
  if (path === '/overview') return ok(overview());
  if (path === '/waitlist' && method === 'GET') return ok(waitlistPage(url.searchParams));
  if (path === '/audit') return ok({ entries: audit });
  if (path === '/users') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const users = (q ? people.filter((p) => p.email!.includes(q) || p.id === q) : people).slice(0, 25).map(({ name: _name, ...u }) => ({ ...u, comp: comps.has(u.id) }));
    return ok({ q, users, waitlist: q ? rows.filter((r) => !r.userId && r.email.includes(q)).slice(0, 10) : [] });
  }
  if (path === '/waitlist/invite') {
    const count = Math.min(Number(body.count), INVITE_BATCH_MAX);
    const source = (body.source as string | null) || null;
    const waiting = rows.filter((r) => !r.invitedAt && (!source || r.source === source));
    const picks = waiting.slice(0, count);
    const wave = typeof body.wave === 'number' ? body.wave : (funnel().lastWave ?? 0) + 1;
    const res: InviteResult = { invited: picks.length, wave, remaining: waiting.length - (body.dryRun ? 0 : picks.length), from: picks[0]?.createdAt ?? null, to: picks.at(-1)?.createdAt ?? null };
    if (body.dryRun) return ok({ ...res, remaining: waiting.length, dryRun: true });
    for (const r of picks) Object.assign(r, { invitedAt: Date.now(), wave, notifiedAt: Date.now() });
    log('waitlist.invite_next', source, { input: { count, wave }, result: res });
    return ok(res);
  }
  if (path === '/waitlist/invite-emails') {
    const list = String(body.emails ?? '')
      .split(/[\s,;]+/)
      .filter(Boolean);
    const invalid = list.filter((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    const valid = [...new Set(list.filter((e) => !invalid.includes(e)).map((e) => e.toLowerCase()))];
    let invited = 0;
    let added = 0;
    for (const email of valid) {
      let r = rows.find((x) => x.email === email);
      if (!r) {
        r = { email, source: 'admin', createdAt: Date.now(), invitedAt: null, wave: null, notifiedAt: null, signedUpAt: null, userId: null };
        rows.push(r);
        added++;
      }
      if (!r.invitedAt) {
        Object.assign(r, { invitedAt: Date.now(), wave: 0, notifiedAt: Date.now() });
        invited++;
      }
    }
    log('waitlist.invite_emails', valid.length === 1 ? valid[0]! : `${valid.length} emails`, { result: { invited } });
    return ok({ invited, already: valid.length - invited, added, invalid, wave: 0 });
  }
  if (path === '/waitlist/notify-pending') {
    const pending = rows.filter((r) => r.invitedAt && !r.notifiedAt);
    for (const r of pending) r.notifiedAt = Date.now();
    log('waitlist.notify_pending', null, { result: { sent: pending.length } });
    return ok({ sent: pending.length });
  }
  if (path === '/waitlist/resend') {
    log('waitlist.resend', String(body.email));
    return ok({ sent: true });
  }
  const m = /^\/users\/([^/]+)(\/[\w-]+)?$/.exec(path);
  if (m) {
    const id = decodeURIComponent(m[1]!);
    const person = people.find((p) => p.id === id);
    if (!person) return ok({ error: 'No account with that id.' }, 404);
    if (!m[2]) return ok(detail(id));
    if (m[2] === '/comp' && method === 'POST') {
      if (person.plan === 'active' && !comps.has(id)) return ok({ error: 'They already pay through Stripe (monthly). Cancel that in Stripe first if you want to comp them instead.' }, 409);
      comps.set(id, { reason: String(body.reason), by: 'owner@tinytown.dev', at: Date.now() });
      person.plan = 'active';
      person.comp = true;
      log('comp.grant', id, { input: { reason: body.reason } });
      return ok({ comp: true });
    }
    if (m[2] === '/comp' && method === 'DELETE') {
      comps.delete(id);
      person.plan = 'canceled';
      person.comp = false;
      log('comp.revoke', id, { input: { reason: body.reason } });
      return ok({ comp: false });
    }
    if (m[2] === '/refresh') {
      log('timeline.refresh', id);
      return ok({ ok: true, days: 412, mrr: 4_280 });
    }
    if (m[2] === '/resend-invite') {
      log('waitlist.resend', id);
      return ok({ sent: true });
    }
  }
  return ok({ error: 'Not found.' }, 404);
}
