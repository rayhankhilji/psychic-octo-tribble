import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storedKey } from '../server/ratelimit.ts';
import { ENV, FakeSupabase, USER, call, givePlan, setup, stubFetch, type Call } from './server-helpers.ts';

/*
 * What one founder's session costs the database (server/state.ts and
 * migration 0007): the caller's profile, plan and the rows a route needs come
 * back in one call, and that answer lives only as long as the request.
 */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 13, 12);
const TODAY = Date.UTC(2026, 9, 13);

const timeline = () => ({
  name: 'Acme',
  currency: 'usd',
  source: 'live',
  integrations: { stripe: true, github: false },
  snapshots: Array.from({ length: 5 }, (_, i) => ({ t: TODAY - (4 - i) * DAY, customers: 5, mrr: 100, releases: 0, commits: 0 })),
});

let db: FakeSupabase;
let calls: Call[];

/** Database calls since the last mark, as "METHOD /path". */
let mark = 0;
function dbCalls(): string[] {
  const out = calls.slice(mark).filter((c) => c.url.origin === ENV.SUPABASE_URL && c.url.pathname.startsWith('/rest/v1/'));
  mark = calls.length;
  return out.map((c) => `${c.init.method ?? 'GET'} ${c.url.pathname.replace('/rest/v1', '')}`);
}

function start(fake = setup()) {
  db = fake;
  givePlan(db);
  db.tables.profiles!.push({ user_id: USER.id, seed: 7, name: 'Acme', joined_at: TODAY - 30 * DAY, last_seen: TODAY - DAY, users_source: 'customers', users_manual: [], created_at: new Date(NOW).toISOString() });
  db.tables.timelines!.push({ user_id: USER.id, timeline: timeline(), fetched_at: new Date(NOW).toISOString() });
  calls = stubFetch(db);
  mark = 0;
}

const build = (plot: string) => call('POST', '/api/world/actions', { body: { action: { t: TODAY, kind: 'build', item: 'park', plot } } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('one round trip per request', () => {
  beforeEach(() => start());

  it('a page load and three builds cost 11 database calls', async () => {
    expect((await call('GET', '/api/me')).status).toBe(200);
    expect(dbCalls()).toEqual(['POST /rpc/user_state']);
    expect(await (await call('GET', '/api/world/actions')).json()).toEqual({ actions: [] });
    expect(dbCalls()).toEqual(['POST /rpc/user_state']);
    expect((await call('GET', '/api/timeline')).status).toBe(200);
    expect(dbCalls()).toEqual(['POST /rpc/user_state']);
    expect((await call('PATCH', '/api/world', { body: { lastSeen: TODAY } })).status).toBe(200);
    expect(dbCalls()).toEqual(['POST /rpc/user_state', 'PATCH /profiles']);
    // The first build makes the world row; later ones update it on its version.
    expect((await build('market:0')).status).toBe(200);
    expect(dbCalls()).toEqual(['POST /rpc/user_state', 'POST /worlds']);
    expect((await build('market:1')).status).toBe(200);
    expect(dbCalls()).toEqual(['POST /rpc/user_state', 'PATCH /worlds']);
    expect((await build('market:2')).status).toBe(200);
    expect(dbCalls()).toEqual(['POST /rpc/user_state', 'PATCH /worlds']);
    expect(db.row('worlds', { user_id: USER.id })).toMatchObject({ version: 3 });
  });

  it('asks the function for only what each route needs', async () => {
    const parts = () =>
      calls
        .filter((c) => c.url.pathname === '/rest/v1/rpc/user_state')
        .map((c) => JSON.parse(c.body) as { p_parts: string[]; p_rate_key: string | null })
        .map((b) => [b.p_parts.join(','), b.p_rate_key ? 'rate' : '']);
    await call('GET', '/api/me');
    await call('GET', '/api/world/actions');
    await call('GET', '/api/timeline');
    await call('PATCH', '/api/world', { body: { lastSeen: TODAY } });
    await build('market:0');
    expect(parts()).toEqual([
      ['connections', ''],
      ['world', ''],
      ['timeline,connections', ''],
      ['', 'rate'],
      ['world,timeline', 'rate'],
    ]);
  });

  it('reading the world writes nothing, and a lastSeen that has not changed is not written', async () => {
    await call('GET', '/api/world/actions');
    expect(db.row('worlds', { user_id: USER.id })).toBeUndefined();
    dbCalls();
    const res = await call('PATCH', '/api/world', { body: { lastSeen: TODAY - DAY, name: 'Acme' } });
    expect(await res.json()).toEqual({ seed: 7, name: 'Acme', joinedAt: TODAY - 30 * DAY, lastSeen: TODAY - DAY });
    expect(dbCalls()).toEqual(['POST /rpc/user_state']);
  });

  it('GET /api/world answers from the same call', async () => {
    expect(await (await call('GET', '/api/world')).json()).toEqual({ seed: 7, name: 'Acme', joinedAt: TODAY - 30 * DAY, lastSeen: TODAY - DAY });
    expect(dbCalls()).toEqual(['POST /rpc/user_state']);
  });

  it('a stale timeline is rebuilt from the connections that came with it, without reading them again', async () => {
    db.tables.timelines![0]!.fetched_at = new Date(NOW - DAY).toISOString();
    // No connections: the rebuild says so, having asked the database nothing more.
    const res = await call('GET', '/api/timeline');
    expect(res.status).toBe(409);
    expect(dbCalls()).toEqual(['POST /rpc/user_state']);
  });
});

describe('has paid is read fresh on every request', () => {
  beforeEach(() => start());

  it('a plan that ends between two requests closes the next one', async () => {
    expect((await call('GET', '/api/world/actions')).status).toBe(200);
    db.row('subscriptions', { user_id: USER.id })!.status = 'canceled';
    expect((await call('GET', '/api/world/actions')).status).toBe(402);
    expect((await build('market:0')).status).toBe(402);
    db.row('subscriptions', { user_id: USER.id })!.status = 'active';
    expect((await call('GET', '/api/world/actions')).status).toBe(200);
  });

  it('a revoked comp loses access at once', async () => {
    Object.assign(db.row('subscriptions', { user_id: USER.id })!, { comp: true, status: 'active', stripe_subscription_id: null });
    expect((await call('GET', '/api/timeline')).status).toBe(200);
    Object.assign(db.row('subscriptions', { user_id: USER.id })!, { comp: false, status: 'canceled' });
    expect((await call('GET', '/api/timeline')).status).toBe(402);
  });
});

describe('the shared rate limit rides along', () => {
  beforeEach(() => start());

  it('counts a write in the same call, and refuses once other instances used the window up', async () => {
    const key = storedKey(`POST /api/world/actions:${USER.id}`);
    expect((await build('market:0')).status).toBe(200);
    expect(db.rateHits.get(key)).toBe(1);
    db.rateHits.set(key, 60);
    const res = await build('market:1');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(dbCalls().filter((c) => c.includes('rate_hit'))).toEqual([]);
    expect(db.row('worlds', { user_id: USER.id })!.version).toBe(1);
  });

  it('says "pick a plan" before "slow down"', async () => {
    db.rateHits.set(storedKey(`POST /api/world/actions:${USER.id}`), 999);
    db.row('subscriptions', { user_id: USER.id })!.status = 'canceled';
    expect((await build('market:0')).status).toBe(402);
  });

  it('reads are limited in memory only, never in the database', async () => {
    await call('GET', '/api/timeline');
    expect([...db.rateHits.keys()]).toEqual([]);
  });
});

describe('first sight and first build', () => {
  it('makes the profile in the same call, once', async () => {
    db = setup();
    calls = stubFetch(db);
    mark = 0;
    const res = await call('GET', '/api/me');
    expect(res.status).toBe(200);
    expect(dbCalls()).toEqual(['POST /rpc/user_state']);
    const seed = db.row('profiles', { user_id: USER.id })!.seed as number;
    expect(seed).toBeGreaterThanOrEqual(1);
    expect((await res.json()).world.seed).toBe(seed);
    // Seen again: the same profile.
    expect((await (await call('GET', '/api/me')).json()).world.seed).toBe(seed);
    expect(db.tables.profiles).toHaveLength(1);
  });

  it('a deleted account riding a cached sign-in gets 401, not a new profile', async () => {
    class Guarded extends FakeSupabase {
      override async handle(url: URL, init: RequestInit) {
        if (url.origin === this.url && url.pathname === '/rest/v1/profiles' && init.method === 'POST') return Response.json([]);
        return super.handle(url, init);
      }
    }
    db = new Guarded(ENV.SUPABASE_URL);
    db.users = setup().users;
    calls = stubFetch(db);
    expect((await call('GET', '/api/me')).status).toBe(401);
    expect(db.tables.profiles).toHaveLength(0);
  });

  it('two tabs making the first build at once: the second re-checks against the first', async () => {
    let raced = false;
    class Racing extends FakeSupabase {
      override async handle(url: URL, init: RequestInit) {
        // Another tab's first build lands between our read and our insert.
        if (!raced && url.origin === this.url && url.pathname === '/rest/v1/worlds' && init.method === 'POST') {
          raced = true;
          this.tables.worlds!.push({ user_id: USER.id, actions: [{ t: TODAY, kind: 'build', item: 'park', plot: 'market:0' }], version: 1 });
        }
        return super.handle(url, init);
      }
    }
    const fake = new Racing(ENV.SUPABASE_URL);
    fake.users = setup().users;
    start(fake);
    const res = await build('market:0');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'That plot is taken' });
    expect((await build('market:1')).status).toBe(200);
    expect(db.row('worlds', { user_id: USER.id })).toMatchObject({ version: 2 });
  });
});

describe('before migration 0007 has run', () => {
  beforeEach(() => {
    start();
    db.noUserState = true;
  });

  it('serves every route from separate reads, and asks for the function once a minute', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await call('GET', '/api/me')).status).toBe(200);
    expect(dbCalls()).toEqual(['POST /rpc/user_state', 'GET /profiles', 'GET /subscriptions', 'GET /connections']);
    expect((await call('GET', '/api/world/actions')).status).toBe(200);
    expect(dbCalls()).toEqual(['GET /profiles', 'GET /subscriptions', 'GET /worlds']);
    expect((await call('GET', '/api/timeline')).status).toBe(200);
    expect((await call('PATCH', '/api/world', { body: { lastSeen: TODAY } })).status).toBe(200);
    expect((await build('market:0')).status).toBe(200);
    expect(db.row('profiles', { user_id: USER.id })!.last_seen).toBe(TODAY);
    // The write's shared limit falls back to rate_hit.
    expect(calls.filter((c) => c.url.pathname === '/rest/v1/rpc/rate_hit')).toHaveLength(2);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('user_state'))).toHaveLength(1);
    // A minute later it asks again, and uses the function once it's there.
    db.noUserState = false;
    vi.setSystemTime(NOW + 61_000);
    dbCalls();
    expect((await call('GET', '/api/me')).status).toBe(200);
    expect(dbCalls()).toEqual(['POST /rpc/user_state']);
  });

  it('still refuses an unpaid founder and still makes a new founder a profile', async () => {
    db.row('subscriptions', { user_id: USER.id })!.status = 'canceled';
    expect((await call('GET', '/api/world/actions')).status).toBe(402);
    db.tables.profiles = [];
    expect((await call('GET', '/api/me')).status).toBe(200);
    expect(db.tables.profiles).toHaveLength(1);
  });
});
