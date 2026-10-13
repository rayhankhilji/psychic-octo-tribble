/**
 * Test doubles for the hosted server: an in-memory Supabase (Auth plus the
 * slice of PostgREST we use) and a fetch router, so every route can run end
 * to end with no network.
 */
import { generateKeyPairSync } from 'node:crypto';
import { vi } from 'vitest';
import { handle, resetCaches } from '../server/app.ts';

type Row = Record<string, unknown>;

const DEFAULTS: Record<string, () => Row> = {
  profiles: () => ({ seed: 12345, name: 'Your Startup', joined_at: null, last_seen: null, users_source: 'customers', users_manual: [], created_at: new Date().toISOString() }),
  subscriptions: () => ({ stripe_customer_id: null, stripe_subscription_id: null, status: 'none', price_id: null, plan_interval: null, current_period_end: null, cancel_at_period_end: false, livemode: null }),
  connections: () => ({ display_name: null, livemode: null, secret: null, access_token: null, access_expires_at: null, token_version: 0, metadata: {}, connected_at: new Date().toISOString() }),
  worlds: () => ({ actions: [], version: 0 }),
  timelines: () => ({ fetched_at: new Date().toISOString() }),
};

export class FakeSupabase {
  tables: Record<string, Row[]> = { profiles: [], subscriptions: [], connections: [], worlds: [], timelines: [] };
  /** access token → user */
  users = new Map<string, { id: string; email: string | null }>();
  authCalls = 0;
  /** Called before each PATCH; lets a test change the row underneath (a race). */
  beforePatch: ((table: string) => void) | null = null;

  url: string;
  constructor(url: string) {
    this.url = url;
  }

  row(table: string, where: Row): Row | undefined {
    return this.tables[table]!.find((r) => Object.entries(where).every(([k, v]) => r[k] === v));
  }

  async handle(url: URL, init: RequestInit): Promise<Response | undefined> {
    if (url.origin !== this.url) return undefined;
    if (url.pathname === '/auth/v1/user') {
      this.authCalls++;
      const token = /^Bearer (.+)$/.exec(new Headers(init.headers).get('Authorization') ?? '')?.[1];
      const user = token ? this.users.get(token) : undefined;
      return user ? Response.json(user) : Response.json({ msg: 'invalid JWT' }, { status: 401 });
    }
    const m = /^\/rest\/v1\/(\w+)$/.exec(url.pathname);
    if (!m) return Response.json({}, { status: 404 });
    if (new Headers(init.headers).get('apikey') !== 'service') return Response.json({ message: 'no' }, { status: 401 });
    const table = this.tables[m[1]!]!;
    const where: Row = {};
    for (const [k, v] of url.searchParams) {
      if (v.startsWith('eq.')) where[k] = v.slice(3);
    }
    const matches = (r: Row) => Object.entries(where).every(([k, v]) => String(r[k]) === v);
    const method = init.method ?? 'GET';
    const body = init.body ? (JSON.parse(String(init.body)) as Row) : {};

    if (method === 'GET') return Response.json(table.filter(matches).slice(0, Number(url.searchParams.get('limit') ?? 1e9)));
    if (method === 'POST') {
      const keys = url.searchParams.get('on_conflict')!.split(',');
      const existing = table.find((r) => keys.every((k) => r[k] === body[k]));
      const prefer = new Headers(init.headers).get('Prefer') ?? '';
      if (existing) {
        if (prefer.includes('ignore-duplicates')) return Response.json([]);
        Object.assign(existing, body);
        return Response.json([existing]);
      }
      const row = { ...DEFAULTS[m[1]!]!(), ...body };
      table.push(row);
      return Response.json([row]);
    }
    if (method === 'PATCH') {
      this.beforePatch?.(m[1]!);
      const rows = table.filter(matches);
      for (const r of rows) Object.assign(r, body);
      return Response.json(rows);
    }
    if (method === 'DELETE') {
      this.tables[m[1]!] = table.filter((r) => !matches(r));
      return new Response(null, { status: 204 });
    }
    return Response.json({}, { status: 405 });
  }
}

export type Route = (url: URL, init: RequestInit) => Response | undefined | Promise<Response | undefined>;
export interface Call {
  url: URL;
  init: RequestInit;
  body: string;
}

/** Stubs global fetch with the fake Supabase plus per-test routes. Unrouted calls fail the test loudly. */
export function stubFetch(db: FakeSupabase, ...routes: Route[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init, body: init.body ? String(init.body) : '' });
    const fromDb = await db.handle(url, init);
    if (fromDb) return fromDb;
    for (const r of routes) {
      const res = await r(url, init);
      if (res) return res;
    }
    throw new Error(`Unexpected fetch: ${init.method ?? 'GET'} ${url}`);
  });
  return calls;
}

export const { privateKey: GITHUB_PEM, publicKey: GITHUB_PUBLIC } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

export const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

export const ENV = {
  APP_URL: 'https://tinytown.test',
  SUPABASE_URL: 'https://db.test',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
  STATE_SECRET: 'state-secret',
  STRIPE_BILLING_SECRET_KEY: 'sk_test_billing',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  STRIPE_PRICE_MONTHLY: 'price_month',
  STRIPE_PRICE_YEARLY: 'price_year',
  STRIPE_APP_CLIENT_ID: 'ca_app',
  STRIPE_APP_SECRET_KEY: 'sk_live_app',
  GITHUB_APP_SLUG: 'tinytown-test',
  GITHUB_APP_ID: '4242',
  GITHUB_APP_CLIENT_ID: 'Iv1.client',
  GITHUB_APP_CLIENT_SECRET: 'gh-client-secret',
  GITHUB_APP_PRIVATE_KEY: GITHUB_PEM,
};

export const USER = { id: '6f1c2b7e-0000-4000-8000-000000000001', email: 'founder@example.com' };
export const TOKEN = 'user-access-token';

/** A fresh fake database with one signed-in user, and every cache cleared. */
export function setup(): FakeSupabase {
  resetCaches();
  const db = new FakeSupabase(ENV.SUPABASE_URL);
  db.users.set(TOKEN, USER);
  return db;
}

export function givePlan(db: FakeSupabase, status = 'active') {
  db.tables.subscriptions!.push({ ...DEFAULTS.subscriptions!(), user_id: USER.id, stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', status, plan_interval: 'month' });
}

export async function call(
  method: string,
  path: string,
  opts: { token?: string | null; body?: unknown; headers?: Record<string, string>; env?: Record<string, string | undefined> } = {},
): Promise<Response> {
  const headers = new Headers(opts.headers);
  const token = opts.token === undefined ? TOKEN : opts.token;
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (opts.body !== undefined) headers.set('Content-Type', 'application/json');
  return handle(
    new Request(`https://tinytown.test${path}`, { method, headers, ...(opts.body !== undefined ? { body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body) } : {}) }),
    opts.env ?? ENV,
  );
}

export const form = (body: string) => Object.fromEntries(new URLSearchParams(body));
