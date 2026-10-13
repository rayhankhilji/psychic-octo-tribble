import { HttpError } from '../http.ts';
import type { SupabaseConfig } from '../supabase.ts';

/**
 * The slice of Supabase the email module needs beyond `Db`: bulk reads with
 * `in.(…)` filters and keyset paging (for the weekly digest), a bulk insert
 * that reports which rows it actually claimed (for dedupe), and the Auth
 * admin API to find a user's address. Same service-role rules as
 * server/supabase.ts: errors are logged by status, never by body.
 */

function headers(cfg: SupabaseConfig, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { apikey: cfg.serviceKey, 'Content-Type': 'application/json', ...extra };
  // New-style secret keys (`sb_secret_…`) aren't JWTs and go in `apikey` only.
  if (!cfg.serviceKey.startsWith('sb_')) h.Authorization = `Bearer ${cfg.serviceKey}`;
  return h;
}

async function rest<T>(cfg: SupabaseConfig, method: string, path: string, body?: unknown, prefer?: string): Promise<T> {
  const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
    method,
    headers: headers(cfg, prefer ? { Prefer: prefer } : {}),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    console.error(`database ${method} ${path.split('?')[0]} → ${res.status}`);
    throw new HttpError(502, 'The database is unavailable. Try again in a moment.', 'upstream');
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** Ids and dedupe keys only: uuids and hex. Anything else is a bug, not input. */
const SAFE = /^[A-Za-z0-9_-]{1,128}$/;

/** `in.("a","b")` for a PostgREST filter, URL-encoded. */
export function inList(values: string[]): string {
  for (const v of values) if (!SAFE.test(v)) throw new Error('Unsafe value in a filter');
  return encodeURIComponent(`in.(${values.map((v) => `"${v}"`).join(',')})`);
}

export function select<T>(cfg: SupabaseConfig, table: string, query: string): Promise<T[]> {
  return rest<T[]>(cfg, 'GET', `${table}?${query}`);
}

/**
 * Inserts rows, skipping any whose `onConflict` key already exists, and
 * returns only the rows it inserted: the ones this caller now owns.
 */
export async function insertNew<T>(cfg: SupabaseConfig, table: string, rows: Record<string, unknown>[], onConflict: string): Promise<T[]> {
  if (!rows.length) return [];
  return (await rest<T[]>(cfg, 'POST', `${table}?on_conflict=${onConflict}`, rows, 'resolution=ignore-duplicates,return=representation')) ?? [];
}

/** Inserts or merges rows by `onConflict`. */
export async function upsertMany(cfg: SupabaseConfig, table: string, rows: Record<string, unknown>[], onConflict: string): Promise<void> {
  if (!rows.length) return;
  await rest(cfg, 'POST', `${table}?on_conflict=${onConflict}`, rows, 'resolution=merge-duplicates,return=minimal');
}

export async function removeWhere(cfg: SupabaseConfig, table: string, query: string): Promise<void> {
  await rest(cfg, 'DELETE', `${table}?${query}`, undefined, 'return=minimal');
}

// ─── Auth admin: who to write to ──────────────────────────────────────────

interface AdminUser {
  id?: unknown;
  email?: unknown;
  banned_until?: unknown;
  deleted_at?: unknown;
}

/** An address we'd actually send to: one line, one @, nothing that could smuggle a header. */
export function sendable(email: unknown): email is string {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[^\s@<>()",;:\\]+$/.test(email);
}

function addressOf(u: AdminUser, now: number): string | null {
  if (u.deleted_at) return null;
  if (typeof u.banned_until === 'string' && Date.parse(u.banned_until) > now) return null;
  return sendable(u.email) ? u.email : null;
}

/** One user's email address, or null if they're gone, banned or have none. */
export async function userEmail(cfg: SupabaseConfig, userId: string, now: number): Promise<string | null> {
  if (!SAFE.test(userId)) return null;
  const res = await fetch(`${cfg.url}/auth/v1/admin/users/${userId}`, { headers: headers(cfg) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`auth admin lookup → ${res.status}`);
  return addressOf((await res.json()) as AdminUser, now);
}

/** Auth's admin list pages; 1,000 a page keeps a 10,000-user launch to ten calls. */
const PER_PAGE = 1_000;
const MAX_PAGES = 1_000;

/** Addresses for a set of users, read from the admin list a page at a time. Stops early once all are found. */
export async function userEmails(cfg: SupabaseConfig, wanted: Set<string>, now: number): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!wanted.size) return out;
  let found = 0;
  for (let page = 1; page <= MAX_PAGES && found < wanted.size; page++) {
    const res = await fetch(`${cfg.url}/auth/v1/admin/users?page=${page}&per_page=${PER_PAGE}`, { headers: headers(cfg) });
    if (!res.ok) throw new Error(`auth admin list → ${res.status}`);
    const body = (await res.json()) as { users?: AdminUser[] };
    const users = body.users ?? [];
    for (const u of users) {
      if (typeof u.id !== 'string' || !wanted.has(u.id)) continue;
      found++;
      const email = addressOf(u, now);
      if (email) out.set(u.id, email);
    }
    if (users.length < PER_PAGE) break;
  }
  return out;
}
