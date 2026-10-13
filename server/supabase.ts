import { HttpError, upstream } from './http.ts';

/**
 * Supabase over plain fetch: Auth to identify the caller, and PostgREST with
 * the service-role key for our tables. Row-level security is on with no
 * policies, so only this key (server-side) can read or write anything.
 */
export interface SupabaseConfig {
  url: string;
  anonKey: string;
  serviceKey: string;
}

export interface AuthUser {
  id: string;
  email: string | null;
}

/** Who a Supabase access token belongs to, or null if it isn't valid. */
export async function fetchUser(cfg: SupabaseConfig, token: string): Promise<AuthUser | null> {
  const res = await fetch(`${cfg.url}/auth/v1/user`, { headers: { apikey: cfg.anonKey, Authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw upstream(`Sign-in service responded ${res.status}.`);
  const body = (await res.json()) as { id?: unknown; email?: unknown };
  if (typeof body.id !== 'string') return null;
  return { id: body.id, email: typeof body.email === 'string' ? body.email : null };
}

/**
 * Headers for the service role. New-style secret keys (`sb_secret_…`) aren't
 * JWTs and go in `apikey` only; legacy service-role JWTs go in both.
 */
function serviceHeaders(cfg: SupabaseConfig, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { apikey: cfg.serviceKey, 'Content-Type': 'application/json', ...extra };
  if (!cfg.serviceKey.startsWith('sb_')) h.Authorization = `Bearer ${cfg.serviceKey}`;
  return h;
}

/** `{ user_id: 'abc', version: 3 }` → `user_id=eq.abc&version=eq.3`. Values are encoded; columns are ours. */
function filters(where: Record<string, string | number | boolean>): string {
  return Object.entries(where)
    .map(([k, v]) => `${k}=eq.${encodeURIComponent(String(v))}`)
    .join('&');
}

async function rest<T>(cfg: SupabaseConfig, method: string, path: string, body?: unknown, prefer?: string): Promise<T> {
  const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
    method,
    headers: serviceHeaders(cfg, prefer ? { Prefer: prefer } : {}),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    // PostgREST errors can echo values; log the code only, never the body.
    console.error(`database ${method} ${path.split('?')[0]} → ${res.status}`);
    throw new HttpError(502, 'The database is unavailable. Try again in a moment.', 'upstream');
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export class Db {
  cfg: SupabaseConfig;
  constructor(cfg: SupabaseConfig) {
    this.cfg = cfg;
  }

  async one<T>(table: string, where: Record<string, string | number | boolean>): Promise<T | null> {
    const rows = await rest<T[]>(this.cfg, 'GET', `${table}?select=*&${filters(where)}&limit=1`);
    return rows[0] ?? null;
  }

  many<T>(table: string, where: Record<string, string | number | boolean>): Promise<T[]> {
    return rest<T[]>(this.cfg, 'GET', `${table}?select=*&${filters(where)}`);
  }

  /** Insert, or on a key clash either merge into the existing row or leave it alone. */
  async upsert<T>(table: string, row: Record<string, unknown>, onConflict: string, mode: 'merge' | 'ignore' = 'merge'): Promise<T | null> {
    const rows = await rest<T[]>(
      this.cfg,
      'POST',
      `${table}?on_conflict=${onConflict}`,
      row,
      `resolution=${mode === 'merge' ? 'merge-duplicates' : 'ignore-duplicates'},return=representation`,
    );
    return rows[0] ?? null;
  }

  /** Updates matching rows and returns them; an empty list means nothing matched (e.g. a version check failed). */
  update<T>(table: string, where: Record<string, string | number | boolean>, patch: Record<string, unknown>): Promise<T[]> {
    return rest<T[]>(this.cfg, 'PATCH', `${table}?${filters(where)}`, patch, 'return=representation');
  }

  async remove(table: string, where: Record<string, string | number | boolean>): Promise<void> {
    await rest(this.cfg, 'DELETE', `${table}?${filters(where)}`, undefined, 'return=minimal');
  }
}
