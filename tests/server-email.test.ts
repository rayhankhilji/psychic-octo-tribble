import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hosted, type Hosted } from '../server/context.ts';
import { weeklyDigest } from '../server/email.ts';
import { digestNumbers, isoWeek } from '../server/email/digest.ts';
import { readUnsubscribeToken, unsubscribeToken } from '../server/email/prefs.ts';
import { EmailError, resend, resetEmailPacing, type EmailProvider } from '../server/email/provider.ts';
import { STALE_CLAIM_MS, dedupeKey } from '../server/email/send.ts';
import { settings } from '../server/env.ts';
import { notify, type NotifyEvent } from '../server/notify.ts';
import { DAY, type Snapshot, type Timeline } from '../src/data/types.ts';
import { simulate, type Action } from '../src/game/economy.ts';
import { ENV, FakeSupabase, USER, call, setup, stubFetch, type Call } from './server-helpers.ts';

type Row = Record<string, unknown>;

/**
 * The shared fake Supabase knows the 0001 tables and `eq.` filters. Email
 * also uses `in.(…)`, `gt.`, `order`, column lists, bulk inserts and the
 * Auth admin API, so this one answers all of /rest/v1 itself.
 */
class EmailDb extends FakeSupabase {
  /** Auth's users, as the admin API returns them. */
  auth = new Map<string, Row>();
  adminListCalls = 0;

  constructor() {
    super(ENV.SUPABASE_URL);
    this.tables.email_prefs = [];
    this.tables.email_log = [];
  }

  addUser(id: string, email: string | null, extra: Row = {}) {
    this.auth.set(id, { id, email, ...extra });
  }

  override async handle(url: URL, init: RequestInit): Promise<Response | undefined> {
    if (url.origin !== this.url) return undefined;
    const headers = new Headers(init.headers);
    const admin = /^\/auth\/v1\/admin\/users(?:\/([\w-]+))?$/.exec(url.pathname);
    if (admin) {
      if (headers.get('apikey') !== 'service') return Response.json({}, { status: 401 });
      if (admin[1]) {
        const u = this.auth.get(admin[1]);
        return u ? Response.json(u) : Response.json({ msg: 'User not found' }, { status: 404 });
      }
      this.adminListCalls++;
      const page = Number(url.searchParams.get('page'));
      const per = Number(url.searchParams.get('per_page'));
      return Response.json({ users: [...this.auth.values()].slice((page - 1) * per, page * per), aud: 'authenticated' });
    }
    const m = /^\/rest\/v1\/(\w+)$/.exec(url.pathname);
    if (!m) return super.handle(url, init);
    if (headers.get('apikey') !== 'service') return Response.json({ message: 'no' }, { status: 401 });
    const name = m[1]!;
    const table = (this.tables[name] ??= []);
    const method = init.method ?? 'GET';
    const prefer = headers.get('Prefer') ?? '';

    const tests: ((r: Row) => boolean)[] = [];
    for (const [k, v] of url.searchParams) {
      if (['select', 'order', 'limit', 'on_conflict'].includes(k)) continue;
      if (v.startsWith('eq.')) tests.push((r) => String(r[k]) === v.slice(3));
      else if (v.startsWith('gt.')) tests.push((r) => String(r[k]) > v.slice(3));
      else if (v.startsWith('in.(')) {
        const set = new Set(v.slice(4, -1).split(',').map((x) => x.replace(/^"|"$/g, '')));
        tests.push((r) => set.has(String(r[k])));
      } else throw new Error(`fake: unsupported filter ${k}=${v}`);
    }
    const matches = (r: Row) => tests.every((t) => t(r));

    if (method === 'GET') {
      let rows = table.filter(matches);
      const order = url.searchParams.get('order');
      if (order) {
        const col = order.split('.')[0]!;
        rows = [...rows].sort((a, b) => String(a[col]).localeCompare(String(b[col])));
      }
      rows = rows.slice(0, Number(url.searchParams.get('limit') ?? 1e9));
      const cols = url.searchParams.get('select');
      if (cols && cols !== '*') rows = rows.map((r) => Object.fromEntries(cols.split(',').map((c) => [c, r[c]])));
      return Response.json(rows);
    }
    if (method === 'POST') {
      const keys = url.searchParams.get('on_conflict')!.split(',');
      const body = JSON.parse(String(init.body)) as Row | Row[];
      const out: Row[] = [];
      for (const row of Array.isArray(body) ? body : [body]) {
        const existing = table.find((r) => keys.every((k) => r[k] === row[k]));
        if (existing) {
          if (prefer.includes('ignore-duplicates')) continue;
          Object.assign(existing, row);
          out.push(existing);
        } else {
          const fresh = { ...EMAIL_DEFAULTS[name]?.(), ...row };
          table.push(fresh);
          out.push(fresh);
        }
      }
      return prefer.includes('return=minimal') ? new Response(null, { status: 201 }) : Response.json(out);
    }
    if (method === 'PATCH') {
      const rows = table.filter(matches);
      for (const r of rows) Object.assign(r, JSON.parse(String(init.body)));
      return Response.json(rows);
    }
    if (method === 'DELETE') {
      this.tables[name] = table.filter((r) => !matches(r));
      return new Response(null, { status: 204 });
    }
    return Response.json({}, { status: 405 });
  }
}

const EMAIL_DEFAULTS: Record<string, () => Row> = {
  email_prefs: () => ({ product_updates: true, weekly_digest: true }),
  email_log: () => ({ status: 'sending', provider: null, provider_id: null, sent_at: null, created_at: new Date().toISOString() }),
};

const MAIL_ENV = { ...ENV, RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'TinyTown <hello@mail.tinytown.test>', EMAIL_REPLY_TO: 'help@tinytown.test' };
const NOW = Date.UTC(2026, 9, 12, 15, 23); // a Monday, the weekly cron's slot

function ctxFor(env: Record<string, string | undefined> = MAIL_ENV, now = NOW): Hosted {
  const url = new URL('https://tinytown.test/api/cron/weekly');
  return hosted({ req: new Request(url), url, env, s: settings(env), now });
}

interface Sent {
  path: string;
  key: string | null;
  body: Row | Row[];
}

/** Resend's API: records every call; `fail` decides a response per call. */
function resendApi(sent: Sent[], fail: (path: string, n: number) => Response | null = () => null): (url: URL, init: RequestInit) => Response | undefined {
  let n = 0;
  return (url, init) => {
    if (url.host !== 'api.resend.com') return undefined;
    const body = JSON.parse(String(init.body)) as Row | Row[];
    const failure = fail(url.pathname, n++);
    if (failure) return failure;
    sent.push({ path: url.pathname, key: new Headers(init.headers).get('Idempotency-Key'), body });
    if (url.pathname === '/emails/batch') return Response.json({ data: (body as Row[]).map((_, i) => ({ id: `batch-${n}-${i}` })) });
    return Response.json({ id: `msg-${n}` });
  };
}

let db: EmailDb;
let logs: string[];
beforeEach(() => {
  setup();
  resetEmailPacing();
  db = new EmailDb();
  db.addUser(USER.id, USER.email);
  logs = [];
  const record = (...args: unknown[]) => void logs.push(args.map(String).join(' '));
  vi.spyOn(console, 'log').mockImplementation(record);
  vi.spyOn(console, 'error').mockImplementation(record);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── notify ───────────────────────────────────────────────────────────────

describe('notify', () => {
  it('without RESEND_API_KEY, logs the kind and user id only and calls nobody', async () => {
    const calls = stubFetch(db);
    await notify(ctxFor(ENV), { kind: 'plan.started', userId: USER.id, interval: 'month' });
    await notify(ctxFor(ENV), { kind: 'access.invited', email: 'new@example.com' });
    expect(calls).toHaveLength(0);
    expect(logs).toEqual([`email not configured: would send plan.started to ${USER.id}`, 'email not configured: would send access.invited to guest']);
    expect(logs.join()).not.toContain('@');
  });

  it('sends the welcome to the address Auth has, with an idempotency key, and logs it', async () => {
    const sent: Sent[] = [];
    const calls = stubFetch(db, resendApi(sent));
    await notify(ctxFor(), { kind: 'plan.started', userId: USER.id, interval: 'year' });
    expect(sent).toHaveLength(1);
    const body = sent[0]!.body as Row;
    expect(body).toMatchObject({ from: MAIL_ENV.EMAIL_FROM, to: [USER.email], subject: 'Welcome to TinyTown', reply_to: 'help@tinytown.test' });
    expect(body.html).toContain('yearly plan is active');
    expect(body.text).toContain('Connect Stripe');
    expect(sent[0]!.key).toBe(`tt-${dedupeKey('plan.started', USER.id, 'first')}`);
    // Transactional: no unsubscribe headers.
    expect(body.headers).toBeUndefined();
    const auth = calls.find((c) => c.url.pathname.startsWith('/auth/v1/admin/users/'))!;
    expect(new Headers(auth.init.headers).get('Authorization')).toBe('Bearer service');
    expect(db.tables.email_log).toEqual([expect.objectContaining({ user_id: USER.id, kind: 'plan.started', status: 'sent', provider: 'resend', provider_id: 'msg-1' })]);
    // No address is stored anywhere.
    expect(JSON.stringify(db.tables.email_log)).not.toContain('@');
  });

  it('sends once per event: webhook retries are skipped, a new ref sends again', async () => {
    const sent: Sent[] = [];
    stubFetch(db, resendApi(sent));
    const ctx = ctxFor();
    const failed: NotifyEvent = { kind: 'plan.payment_failed', userId: USER.id, ref: 'in_1' };
    await notify(ctx, failed);
    await notify(ctx, failed);
    await Promise.all([notify(ctx, failed), notify(ctx, failed)]);
    expect(sent).toHaveLength(1);
    await notify(ctx, { ...failed, ref: 'in_2' });
    expect(sent).toHaveLength(2);
  });

  it('without a ref, nags about the same thing at most once a week', async () => {
    const sent: Sent[] = [];
    stubFetch(db, resendApi(sent));
    const broken: NotifyEvent = { kind: 'connection.broken', userId: USER.id, provider: 'stripe' };
    await notify(ctxFor(), broken);
    await notify(ctxFor(MAIL_ENV, NOW + DAY), broken);
    await notify(ctxFor(), { ...broken, provider: 'github' });
    expect(sent.map((s) => (s.body as Row).subject)).toEqual(['Reconnect Stripe to keep your city growing', 'Reconnect GitHub to keep your city growing']);
    await notify(ctxFor(MAIL_ENV, NOW + 8 * DAY), broken);
    expect(sent).toHaveLength(3);
  });

  it('maps every kind to its email', async () => {
    const sent: Sent[] = [];
    stubFetch(db, resendApi(sent));
    const env = { ...MAIL_ENV, STRIPE_PORTAL_LOGIN_URL: 'https://billing.stripe.com/p/login/test_abc123' };
    const ctx = ctxFor(env);
    const ends = Date.UTC(2026, 10, 12);
    await notify(ctx, { kind: 'plan.payment_failed', userId: USER.id });
    await notify(ctx, { kind: 'plan.canceled', userId: USER.id, endsAt: ends });
    await notify(ctx, { kind: 'plan.canceled', userId: USER.id, endsAt: null });
    await notify(ctx, { kind: 'plan.ended', userId: USER.id });
    await notify(ctx, { kind: 'connection.broken', userId: USER.id, provider: 'posthog' });
    await notify(ctx, { kind: 'account.deleted', email: 'gone@example.com' });
    await notify(ctx, { kind: 'access.invited', email: 'wave2@example.com' });
    const bodies = sent.map((s) => s.body as Row);
    expect(bodies.map((b) => b.subject)).toEqual([
      'Your TinyTown payment didn’t go through',
      'Your TinyTown plan won’t renew',
      'Your TinyTown plan is canceled',
      'Your TinyTown plan has ended',
      'Reconnect PostHog to keep your city growing',
      'Your TinyTown account is deleted',
      'Your spot in TinyTown is open',
    ]);
    expect(bodies[0]!.html).toContain('href="https://billing.stripe.com/p/login/test_abc123"');
    expect(bodies[0]!.text).toContain('keeps running while Stripe tries the card again');
    expect(bodies[1]!.html).toContain('November 12, 2026');
    expect(bodies[5]!.to).toEqual(['gone@example.com']);
    expect(bodies[6]!.html).toContain('wave2@example.com');
    // After a deletion nothing about the person is written; the invite is logged without a user.
    expect(db.tables.email_log!.filter((r) => r.kind === 'account.deleted')).toEqual([]);
    expect(db.tables.email_log!.filter((r) => r.kind === 'access.invited')).toEqual([expect.objectContaining({ user_id: null, status: 'sent' })]);
  });

  it('invites an address once, however the waitlist tool retries', async () => {
    const sent: Sent[] = [];
    stubFetch(db, resendApi(sent));
    await notify(ctxFor(), { kind: 'access.invited', email: 'Wave@Example.com' });
    await notify(ctxFor(), { kind: 'access.invited', email: 'wave@example.com' });
    expect(sent).toHaveLength(1);
  });

  it('without a portal login link, sends people to the app to update their card', async () => {
    const sent: Sent[] = [];
    stubFetch(db, resendApi(sent));
    await notify(ctxFor({ ...MAIL_ENV, STRIPE_PORTAL_LOGIN_URL: 'javascript:alert(1)' }), { kind: 'plan.payment_failed', userId: USER.id });
    const html = String((sent[0]!.body as Row).html);
    expect(html).toContain('choose Update card');
    expect(html).not.toContain('javascript:');
  });

  it('skips users Auth no longer has, and never sends to an unusable address', async () => {
    const sent: Sent[] = [];
    stubFetch(db, resendApi(sent));
    await notify(ctxFor(), { kind: 'plan.ended', userId: '6f1c2b7e-0000-4000-8000-00000000dead' });
    await notify(ctxFor(), { kind: 'access.invited', email: 'a@b.c\r\nBcc: everyone@example.com' });
    expect(sent).toEqual([]);
    expect(db.tables.email_log).toEqual([]);
  });

  it('never throws: a refused send is logged by user id, and the claim is released for a retry', async () => {
    const sent: Sent[] = [];
    let refuse = true;
    stubFetch(db, resendApi(sent, () => (refuse ? Response.json({ name: 'validation_error', message: 'founder@example.com is invalid', statusCode: 422 }, { status: 422 }) : null)));
    await expect(notify(ctxFor(), { kind: 'plan.started', userId: USER.id, interval: 'month' })).resolves.toBeUndefined();
    expect(logs.join('\n')).toContain(`email plan.started for ${USER.id} failed: resend 422 validation_error`);
    expect(logs.join('\n')).not.toContain('founder@example.com');
    expect(db.tables.email_log).toEqual([]);
    refuse = false;
    await notify(ctxFor(), { kind: 'plan.started', userId: USER.id, interval: 'month' });
    expect(sent).toHaveLength(1);
  });

  it('never throws when the database or Auth is down', async () => {
    vi.stubGlobal('fetch', async () => new Response('down', { status: 503 }));
    await expect(notify(ctxFor(), { kind: 'plan.ended', userId: USER.id })).resolves.toBeUndefined();
    expect(logs.join('\n')).toContain(`email plan.ended for ${USER.id} failed`);
  });

  it('takes over a claim left behind by a server that died mid-send, but not a fresh one', async () => {
    const sent: Sent[] = [];
    stubFetch(db, resendApi(sent));
    const key = dedupeKey('plan.ended', USER.id, 'sub_1');
    db.tables.email_log!.push({ dedupe_key: key, user_id: USER.id, kind: 'plan.ended', status: 'sending', created_at: new Date(NOW - 5 * 60_000).toISOString() });
    await notify(ctxFor(), { kind: 'plan.ended', userId: USER.id, ref: 'sub_1' });
    expect(sent).toHaveLength(0);
    db.tables.email_log![0]!.created_at = new Date(NOW - STALE_CLAIM_MS - 60_000).toISOString();
    await notify(ctxFor(), { kind: 'plan.ended', userId: USER.id, ref: 'sub_1' });
    expect(sent).toHaveLength(1);
    // The same idempotency key as the dead attempt, so Resend drops it if that one did go out.
    expect(sent[0]!.key).toBe(`tt-${key}`);
    expect(db.tables.email_log![0]).toMatchObject({ status: 'sent' });
  });
});

// ─── The Resend provider ──────────────────────────────────────────────────

describe('resend provider', () => {
  const settingsFor = { apiKey: 're_test_key', from: 'TinyTown <hello@mail.tinytown.test>', replyTo: null };
  const msg = { to: 'a@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' };

  it('waits out a 429 and retries with the same idempotency key', async () => {
    const sent: Sent[] = [];
    const calls = stubFetch(db, resendApi(sent, (_p, n) => (n === 0 ? new Response(JSON.stringify({ name: 'rate_limit_exceeded' }), { status: 429, headers: { 'retry-after': '2' } }) : null)));
    const waits: number[] = [];
    const id = await resend(settingsFor, async (ms) => void waits.push(ms)).send(msg, 'tt-key-1');
    expect(id).toBe('msg-2');
    // Retry-After says 2 s (the rest is the provider's own pacing).
    expect(waits).toContain(2000);
    expect(calls.map((c) => new Headers(c.init.headers).get('Idempotency-Key'))).toEqual(['tt-key-1', 'tt-key-1']);
    expect(new Headers(calls[0]!.init.headers).get('Authorization')).toBe('Bearer re_test_key');
  });

  it('does not retry a spent quota or a bad request', async () => {
    const calls = stubFetch(db, () => Response.json({ name: 'monthly_quota_exceeded' }, { status: 429 }));
    const p = resend(settingsFor, async () => undefined);
    await expect(p.send(msg, 'k')).rejects.toMatchObject({ status: 429, retryable: false });
    expect(calls).toHaveLength(1);
  });

  it('gives up after a few server errors', async () => {
    const calls = stubFetch(db, () => new Response('oops', { status: 502 }));
    const err = await resend(settingsFor, async () => undefined)
      .send(msg, 'k')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailError);
    expect(calls).toHaveLength(4);
  });

  it('sends a batch in one call and returns ids in order; refuses more than 100', async () => {
    const sent: Sent[] = [];
    stubFetch(db, resendApi(sent));
    const p = resend(settingsFor, async () => undefined);
    expect(await p.sendBatch([msg, { ...msg, to: 'b@example.com', headers: { 'List-Unsubscribe': '<https://x>' } }], 'b1')).toEqual(['batch-1-0', 'batch-1-1']);
    expect((sent[0]!.body as Row[])[1]).toMatchObject({ to: ['b@example.com'], headers: { 'List-Unsubscribe': '<https://x>' } });
    await expect(p.sendBatch(Array(101).fill(msg), 'b2')).rejects.toBeInstanceOf(EmailError);
  });
});

// ─── Unsubscribe ──────────────────────────────────────────────────────────

describe('/api/email/unsubscribe', () => {
  const link = (token: string) => `/api/email/unsubscribe?token=${encodeURIComponent(token)}`;
  const token = (list: 'digest' | 'updates' | 'all' = 'digest') => unsubscribeToken(ENV.STATE_SECRET, USER.id, list);

  it('reads its own tokens back, and nothing else', () => {
    expect(readUnsubscribeToken('s', unsubscribeToken('s', USER.id, 'all'))).toEqual({ userId: USER.id, list: 'all' });
    const [id, , sig] = unsubscribeToken('s', USER.id, 'digest').split('.');
    expect(readUnsubscribeToken('s', `${id}.all.${sig}`)).toBeNull();
    expect(readUnsubscribeToken('other', unsubscribeToken('s', USER.id, 'digest'))).toBeNull();
    expect(readUnsubscribeToken('s', `6f1c2b7e-0000-4000-8000-000000000002.digest.${sig}`)).toBeNull();
    expect(readUnsubscribeToken('s', `${id}.digest.${sig}x`)).toBeNull();
    expect(readUnsubscribeToken('s', `${id}.digest.${sig}.extra`)).toBeNull();
    expect(readUnsubscribeToken('s', null)).toBeNull();
    expect(readUnsubscribeToken('s', 'x'.repeat(500))).toBeNull();
  });

  it('turns the digest off with one click and says so on a small, locked-down page', async () => {
    stubFetch(db);
    const res = await call('GET', link(token()), { token: null });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    const html = await res.text();
    expect(html).toContain('You’re unsubscribed');
    expect(html).toContain('the weekly digest');
    expect(html).toContain('name="action" value="resubscribe"');
    expect(db.tables.email_prefs).toEqual([expect.objectContaining({ user_id: USER.id, weekly_digest: false, product_updates: true })]);
  });

  it('"all" turns off every non-essential list', async () => {
    stubFetch(db);
    await call('GET', link(token('all')), { token: null });
    expect(db.tables.email_prefs).toEqual([expect.objectContaining({ weekly_digest: false, product_updates: false })]);
  });

  it('rejects a tampered token without touching anything', async () => {
    stubFetch(db);
    const [id, , sig] = token('digest').split('.');
    for (const bad of [`${id}.all.${sig}`, `${id}.digest.${sig!.slice(0, -2)}AA`, unsubscribeToken('wrong-secret', USER.id, 'digest'), '']) {
      const res = await call('GET', link(bad), { token: null });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('That link doesn’t work');
    }
    expect(db.tables.email_prefs).toEqual([]);
  });

  it('answers a mail client’s one-click POST (RFC 8058) with 204', async () => {
    stubFetch(db);
    const res = await call('POST', link(token()), { token: null, body: 'List-Unsubscribe=One-Click', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    expect(res.status).toBe(204);
    expect(db.tables.email_prefs![0]).toMatchObject({ weekly_digest: false });
  });

  it('turns it back on from the page’s button', async () => {
    stubFetch(db);
    await call('GET', link(token()), { token: null });
    const res = await call('POST', link(token()), { token: null, body: 'action=resubscribe', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('You’re subscribed again');
    expect(db.tables.email_prefs![0]).toMatchObject({ weekly_digest: true });
  });

  it('says it isn’t available without Supabase or STATE_SECRET', async () => {
    stubFetch(db);
    expect((await call('GET', link(token()), { token: null, env: {} })).status).toBe(503);
    expect((await call('GET', link(token()), { token: null, env: { ...ENV, STATE_SECRET: '' } })).status).toBe(503);
    expect((await call('DELETE', link(token()), { token: null })).status).toBe(405);
  });
});

// ─── The weekly digest ────────────────────────────────────────────────────

const END = Date.UTC(2026, 9, 12); // the latest snapshot day

/** `days` snapshots ending on END, with MRR, customers and shipping growing as given. */
function timeline(days: number, at: (i: number) => Partial<Snapshot>, integrations = { stripe: true, github: true }): Timeline {
  const snapshots: Snapshot[] = [];
  for (let i = 0; i < days; i++) {
    snapshots.push({ t: END - (days - 1 - i) * DAY, customers: 0, mrr: 0, releases: 0, commits: 0, ...at(i) });
  }
  return { name: 'Acme', currency: 'usd', source: 'live', integrations, snapshots };
}

const growing = timeline(30, (i) => ({
  mrr: 1000 + i * 20,
  customers: 40 + i,
  releases: Math.floor(i / 5),
  commits: i * 3,
  ...(i === 27 ? { release: 'v2.1 <beta>' } : {}),
}));

describe('digest numbers', () => {
  it('compares the last day with seven days earlier, from the timeline alone', () => {
    const actions: Action[] = [
      { t: END - 20 * DAY, kind: 'build', item: 'park' },
      { t: END - 3 * DAY, kind: 'build', item: 'park' },
      { t: END - 2 * DAY, kind: 'build', item: 'park' },
      { t: END - DAY, kind: 'build', item: 'cafe' },
    ];
    const d = digestNumbers(growing, actions, null, 'Acme', NOW)!;
    expect(d.from).toBe(END - 7 * DAY);
    expect(d.to).toBe(END);
    expect(d.fullWeek).toBe(true);
    expect(d.revenue).toEqual({ mrr: 1580, mrrChange: 140, customers: 69, customersChange: 7 });
    expect(d.shipping).toEqual({ releases: 5 - 4, releaseNames: ['v2.1 <beta>'], commits: 21 });
    expect(d.users).toBeNull();
    expect(d.built).toEqual([
      { item: 'park', count: 2 },
      { item: 'cafe', count: 1 },
    ]);
    const state = simulate(growing.snapshots, actions, 29, {});
    expect(d.city).toEqual({ treasury: state.treasury, unhoused: state.unhoused });
  });

  it('leaves out what isn’t connected and only says "week" when there is one', () => {
    const shipOnly = timeline(4, (i) => ({ commits: i, users: 100 + i }), { stripe: false, github: true });
    const d = digestNumbers(shipOnly, [], null, 'Acme', NOW)!;
    expect(d.revenue).toBeNull();
    expect(d.users).toEqual({ value: 103, change: 3 });
    expect(d.fullWeek).toBe(false);
    expect(d.from).toBe(END - 3 * DAY);
  });

  it('has nothing to say about stale or empty history', () => {
    expect(digestNumbers(growing, [], null, 'Acme', END + 9 * DAY)).toBeNull();
    expect(digestNumbers(timeline(1, () => ({})), [], null, 'Acme', NOW)).toBeNull();
  });

  it('numbers ISO weeks the way calendars do', () => {
    expect(isoWeek(Date.UTC(2026, 9, 12))).toBe('2026-W42');
    expect(isoWeek(Date.UTC(2026, 9, 18, 23))).toBe('2026-W42');
    expect(isoWeek(Date.UTC(2027, 0, 1))).toBe('2026-W53');
    expect(isoWeek(Date.UTC(2021, 0, 3))).toBe('2020-W53');
    expect(isoWeek(Date.UTC(2024, 11, 30))).toBe('2025-W01');
  });
});

describe('weeklyDigest', () => {
  const ID = (n: number) => `6f1c2b7e-0000-4000-8000-${String(n).padStart(12, '0')}`;

  function founder(n: number, opts: { status?: string; digest?: boolean; timeline?: Timeline | null } = {}) {
    const id = ID(n);
    db.addUser(id, `founder${n}@example.com`);
    db.tables.subscriptions!.push({ user_id: id, status: opts.status ?? 'active' });
    db.tables.profiles!.push({ user_id: id, name: `Startup ${n}`, joined_at: null });
    if (opts.timeline !== null) db.tables.timelines!.push({ user_id: id, timeline: opts.timeline ?? growing, fetched_at: new Date(NOW).toISOString() });
    if (opts.digest === false) db.tables.email_prefs!.push({ user_id: id, weekly_digest: false, product_updates: true });
    return id;
  }

  const quick = { sleep: async () => undefined };

  it('sends paying founders with digests on their real week, in batches with one-click unsubscribe', async () => {
    const yes = founder(1);
    founder(2, { digest: false });
    founder(3, { timeline: null });
    founder(4, { status: 'canceled' });
    const pastDue = founder(5, { status: 'past_due' });
    db.tables.worlds!.push({ user_id: yes, actions: [{ t: END - DAY, kind: 'build', item: 'cafe' }] });
    const sent: Sent[] = [];
    stubFetch(db, resendApi(sent));

    expect(await weeklyDigest(ctxFor(), NOW, quick)).toEqual({ sent: 2, skipped: 2, left: 0, done: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.path).toBe('/emails/batch');
    const batch = sent[0]!.body as Row[];
    expect(batch.map((m) => m.to)).toEqual([['founder1@example.com'], ['founder5@example.com']]);
    const first = batch[0]!;
    expect(first.subject).toBe('Your city this week: MRR up $140 to $1,580');
    expect(first.html).toContain('v2.1 &lt;beta&gt;');
    expect(first.html).toContain('Café &amp; bookshop');
    expect(first.text).toContain('Paying customers: 69 (+7)');
    expect(first.text).toContain('Commits this week: 21');
    const headers = first.headers as Record<string, string>;
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const url = new URL(/^<(.+)>$/.exec(headers['List-Unsubscribe']!)![1]!);
    expect(url.origin + url.pathname).toBe('https://tinytown.test/api/email/unsubscribe');
    expect(readUnsubscribeToken(ENV.STATE_SECRET, url.searchParams.get('token'))).toEqual({ userId: yes, list: 'digest' });
    expect(db.tables.email_log!.filter((r) => r.status === 'sent').map((r) => r.user_id).sort()).toEqual([yes, pastDue]);
  });

  it('a rerun in the same week sends nobody twice; next week sends again', async () => {
    founder(1);
    const sent: Sent[] = [];
    stubFetch(db, resendApi(sent));
    await weeklyDigest(ctxFor(), NOW, quick);
    expect(await weeklyDigest(ctxFor(), NOW + 3 * 3600_000, quick)).toEqual({ sent: 0, skipped: 1, left: 0, done: true });
    expect(sent).toHaveLength(1);
    // Next week, with a fresh timeline.
    db.tables.timelines![0]!.timeline = timeline(30, (i) => ({ mrr: 2000 + i }));
    expect(await weeklyDigest(ctxFor(MAIL_ENV, NOW + 7 * DAY), NOW + 7 * DAY, quick)).toEqual({ sent: 0, skipped: 1, left: 0, done: true });
    // ...which was stale (END didn't move), so skipped. Move it and it goes.
    db.tables.timelines![0]!.timeline = { ...growing, snapshots: growing.snapshots.map((s) => ({ ...s, t: s.t + 7 * DAY })) };
    expect(await weeklyDigest(ctxFor(MAIL_ENV, NOW + 7 * DAY), NOW + 7 * DAY, quick)).toEqual({ sent: 1, skipped: 0, left: 0, done: true });
  });

  it('pages through thousands of founders and batches 100 at a time, at a gentle pace', async () => {
    for (let n = 1; n <= 250; n++) founder(n);
    const sent: Sent[] = [];
    stubFetch(db, resendApi(sent));
    const waits: number[] = [];
    expect(await weeklyDigest(ctxFor(), NOW, { sleep: async (ms) => void waits.push(ms) })).toEqual({ sent: 250, skipped: 0, left: 0, done: true });
    expect(sent.map((s) => (s.body as Row[]).length)).toEqual([100, 100, 50]);
    expect(new Set(sent.map((s) => s.key)).size).toBe(3);
    expect(waits.every((w) => w >= 500)).toBe(true);
    expect(db.adminListCalls).toBe(1);
  });

  it('when a batch is refused, tries each message alone so one bad row costs only itself', async () => {
    founder(1);
    founder(2);
    const sent: Sent[] = [];
    stubFetch(
      db,
      resendApi(sent, (path, n) => {
        if (path === '/emails/batch') return Response.json({ name: 'validation_error' }, { status: 422 });
        return n === 1 ? Response.json({ name: 'validation_error' }, { status: 422 }) : null;
      }),
    );
    expect(await weeklyDigest(ctxFor(), NOW, quick)).toEqual({ sent: 1, skipped: 1, left: 0, done: true });
    expect(sent.map((s) => s.path)).toEqual(['/emails']);
    // The refused address keeps its claim, so the hourly catch-up doesn't retry it all week.
    expect(db.tables.email_log!.map((r) => r.status)).toEqual(['sending', 'sent']);
    expect(await weeklyDigest(ctxFor(), NOW, quick)).toEqual({ sent: 0, skipped: 2, left: 0, done: true });
  });

  it('without a key, logs who it would send to and sends nothing', async () => {
    const id = founder(1);
    const calls = stubFetch(db);
    expect(await weeklyDigest(ctxFor(ENV), NOW, quick)).toEqual({ sent: 0, skipped: 1, left: 0, done: true });
    expect(logs).toContain(`email not configured: would send digest to ${id}`);
    expect(calls.some((c: Call) => c.url.host === 'api.resend.com')).toBe(false);
    expect(db.tables.email_log).toEqual([]);
  });

  it('stops starting batches when its time is up', async () => {
    for (let n = 1; n <= 250; n++) founder(n);
    const sent: Sent[] = [];
    stubFetch(db, resendApi(sent));
    let t = 0;
    const result = await weeklyDigest(ctxFor(), NOW, { sleep: async () => void (t += 200_000), clock: () => t });
    expect(result).toEqual({ sent: 200, skipped: 0, left: 50, done: false });
    expect(logs.join('\n')).toContain('run it again this week to finish');
    // The hourly catch-up sends only the rest.
    expect(await weeklyDigest(ctxFor(), NOW + 3600_000, quick)).toEqual({ sent: 50, skipped: 200, left: 0, done: true });
    expect(sent.reduce((n, s) => n + (s.body as Row[]).length, 0)).toBe(250);
    // 250 founders, each replayed through the game: slow when the whole suite shares the machine.
  }, 30_000);

  it('keeps the week open when the provider is struggling, and finishes on the next run', async () => {
    founder(1);
    founder(2);
    const sent: Sent[] = [];
    let down = true;
    stubFetch(db, resendApi(sent, () => (down ? new Response('unavailable', { status: 503 }) : null)));
    const fast = { sleep: async () => undefined, provider: resend({ apiKey: 'k', from: 'TinyTown <a@b.co>', replyTo: null }, async () => undefined) };
    expect(await weeklyDigest(ctxFor(), NOW, fast)).toEqual({ sent: 0, skipped: 0, left: 2, done: false });
    expect(db.tables.email_log).toEqual([]);
    down = false;
    expect(await weeklyDigest(ctxFor(), NOW + 3600_000, fast)).toEqual({ sent: 2, skipped: 0, left: 0, done: true });
  });

  it('won’t send without STATE_SECRET, since the unsubscribe link can’t be signed', async () => {
    founder(1);
    const calls = stubFetch(db);
    expect(await weeklyDigest(ctxFor({ ...MAIL_ENV, STATE_SECRET: undefined }), NOW, quick)).toEqual({ sent: 0, skipped: 0, left: 0, done: true });
    expect(calls).toEqual([]);
  });

  it('uses the provider it is given (any EmailProvider will do)', async () => {
    founder(1);
    stubFetch(db);
    const got: string[] = [];
    const fake: EmailProvider = {
      name: 'fake',
      maxBatch: 1,
      send: async () => 'one',
      sendBatch: async (msgs) => msgs.map((m) => (got.push(m.to), 'id')),
    };
    expect(await weeklyDigest(ctxFor(), NOW, { ...quick, provider: fake })).toEqual({ sent: 1, skipped: 0, left: 0, done: true });
    expect(got).toEqual(['founder1@example.com']);
    expect(db.tables.email_log![0]).toMatchObject({ provider: 'fake', status: 'sent' });
  });
});

describe('resend pacing', () => {
  it('spaces a burst of concurrent sends to stay under Resend’s 10 a second', async () => {
    const sent: Sent[] = [];
    stubFetch(db, resendApi(sent));
    const waits: number[] = [];
    const p = resend({ apiKey: 'k', from: 'TinyTown <a@b.co>', replyTo: null }, async (ms) => void waits.push(ms));
    await Promise.all(Array.from({ length: 20 }, (_, i) => p.send({ to: `${i}@example.com`, subject: 's', html: 'h', text: 't' }, `k${i}`)));
    expect(sent).toHaveLength(20);
    // Each send after the first waits for its own slot, 125 ms apart.
    expect(Math.max(...waits)).toBeGreaterThanOrEqual(19 * 125 - 50);
  });
});
