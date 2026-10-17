import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase, USER, call, setup, stubFetch } from './server-helpers.ts';

let db: FakeSupabase;
beforeEach(() => {
  db = setup();
  // The shared fake knows 0001's tables; 0005 adds this one.
  db.tables.email_prefs = [];
});
afterEach(() => vi.unstubAllGlobals());

describe('/api/email/prefs', () => {
  it('needs a sign-in, but not a plan', async () => {
    stubFetch(db);
    expect((await call('GET', '/api/email/prefs', { token: null })).status).toBe(401);
    // No subscription row: still allowed, because turning email off never needs a plan.
    const res = await call('GET', '/api/email/prefs');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ weeklyDigest: true, productUpdates: true });
  });

  it('saves what changed and leaves the rest', async () => {
    stubFetch(db);
    const res = await call('PUT', '/api/email/prefs', { body: { weeklyDigest: false } });
    expect(await res.json()).toEqual({ weeklyDigest: false, productUpdates: true });
    expect(db.tables.email_prefs).toEqual([expect.objectContaining({ user_id: USER.id, weekly_digest: false })]);
    expect(await (await call('PUT', '/api/email/prefs', { body: { productUpdates: false } })).json()).toEqual({ weeklyDigest: false, productUpdates: false });
    expect(await (await call('GET', '/api/email/prefs')).json()).toEqual({ weeklyDigest: false, productUpdates: false });
  });

  it('refuses anything but true or false', async () => {
    stubFetch(db);
    const res = await call('PUT', '/api/email/prefs', { body: { weeklyDigest: 'no' } });
    expect(res.status).toBe(400);
    expect(db.tables.email_prefs).toEqual([]);
    expect((await call('POST', '/api/email/prefs', { body: {} })).status).toBe(405);
  });
});
