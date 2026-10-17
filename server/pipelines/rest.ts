import { HttpError } from '../http.ts';
import type { SupabaseConfig } from '../supabase.ts';

/**
 * The slice of PostgREST the scheduled jobs need beyond `Db` (which only
 * matches on equality): ranges, `in` lists, ordering, paging, counts, bulk
 * writes and bulk deletes. Same service-role key, same rule about errors:
 * PostgREST can echo values back, so only the status and code are logged.
 */

/** A PostgREST operator and value: `eq.x`, `gte.2026-10-01`, `in.("a","b")`, `is.null`. */
export type Filter = string;
/** Several filters on one column (a range) are a list: `{ day: [gte(a), lt(b)] }`. */
export type Where = Record<string, Filter | Filter[]>;

export const eq = (v: string | number | boolean) => `eq.${v}`;
export const gt = (v: string | number) => `gt.${v}`;
export const gte = (v: string | number) => `gte.${v}`;
export const lt = (v: string | number) => `lt.${v}`;
export const lte = (v: string | number) => `lte.${v}`;
/** Values are double-quoted, so commas and brackets inside them can't break the list. */
export const isIn = (vs: readonly (string | number)[]) => `in.(${vs.map((v) => `"${String(v).replace(/["\\]/g, '\\$&')}"`).join(',')})`;

export interface Query {
  select?: string;
  where?: Where;
  /** e.g. `touched_at.asc,user_id.asc` */
  order?: string;
  limit?: number;
}

const TIMEOUT_MS = 10_000;

/** The table or column isn't there: a migration that hasn't been run, or another module's table that doesn't exist yet. */
export class MissingRelation extends Error {}

/** Same header rules as server/supabase.ts: new-style secret keys aren't JWTs. */
function headers(cfg: SupabaseConfig, extra: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { apikey: cfg.serviceKey, 'Content-Type': 'application/json', ...extra };
  if (!cfg.serviceKey.startsWith('sb_')) h.Authorization = `Bearer ${cfg.serviceKey}`;
  return h;
}

function append(p: URLSearchParams, where: Where): URLSearchParams {
  for (const [k, v] of Object.entries(where)) for (const f of Array.isArray(v) ? v : [v]) p.append(k, f);
  return p;
}

/** `0-24/310` or `*\/310` → 310; null if the header isn't there. */
function total(res: Response): number | null {
  const m = /\/(\d+)$/.exec(res.headers.get('Content-Range') ?? '');
  return m ? Number(m[1]) : null;
}

export class Rest {
  cfg: SupabaseConfig;
  constructor(cfg: SupabaseConfig) {
    this.cfg = cfg;
  }

  private async send(method: string, table: string, params: URLSearchParams, prefer: string, body?: unknown): Promise<Response> {
    const qs = params.toString();
    let res: Response;
    try {
      res = await fetch(`${this.cfg.url}/rest/v1/${table}${qs ? `?${qs}` : ''}`, {
        method,
        headers: headers(this.cfg, prefer ? { Prefer: prefer } : {}),
        // A job must never hang on one query until the function is killed.
        signal: AbortSignal.timeout(TIMEOUT_MS),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      console.error(`database ${method} ${table} unreachable or timed out`);
      throw new HttpError(502, 'The database is unavailable. Try again in a moment.', 'upstream');
    }
    if (res.ok) return res;
    const code = ((await res.json().catch(() => ({}))) as { code?: unknown }).code;
    // PGRST205 / 42P01: no such table or view. PGRST204 / 42703: no such column.
    if (res.status === 404 || code === '42P01' || code === 'PGRST205' || code === '42703' || code === 'PGRST204') {
      throw new MissingRelation(`${table} is missing (${typeof code === 'string' ? code : res.status})`);
    }
    console.error(`database ${method} ${table} → ${res.status}${typeof code === 'string' ? ` ${code}` : ''}`);
    throw new HttpError(502, 'The database is unavailable. Try again in a moment.', 'upstream');
  }

  private params(q: Query): URLSearchParams {
    const p = new URLSearchParams();
    p.set('select', q.select ?? '*');
    append(p, q.where ?? {});
    if (q.order) p.set('order', q.order);
    if (q.limit !== undefined) p.set('limit', String(q.limit));
    return p;
  }

  async rows<T>(table: string, q: Query = {}): Promise<T[]> {
    const res = await this.send('GET', table, this.params(q), '');
    return (await res.json()) as T[];
  }

  /** How many rows match, without reading them. */
  async count(table: string, where: Where = {}): Promise<number> {
    const p = this.params({ select: '*', where });
    // A HEAD reply has no body; the count rides in Content-Range.
    const n = total(await this.send('HEAD', table, p, 'count=exact'));
    if (n === null) throw new HttpError(502, 'The database did not return a count.', 'upstream');
    return n;
  }

  /** Bulk insert-or-update, in one statement. Returns nothing: callers that need to know what landed use `Db.upsert`. */
  async upsertMany(table: string, rows: Record<string, unknown>[], onConflict: string, mode: 'merge' | 'ignore' = 'merge'): Promise<void> {
    if (!rows.length) return;
    const p = new URLSearchParams({ on_conflict: onConflict });
    await this.send('POST', table, p, `resolution=${mode === 'merge' ? 'merge-duplicates' : 'ignore-duplicates'},return=minimal`, rows);
  }

  /** Updates matching rows and returns them; empty means nothing matched (a lease someone else holds, say). */
  async patch<T>(table: string, where: Where, patch: Record<string, unknown>): Promise<T[]> {
    const p = append(new URLSearchParams(), where);
    const res = await this.send('PATCH', table, p, 'return=representation', patch);
    return (await res.json()) as T[];
  }

  /** Deletes matching rows and says how many went (null if PostgREST didn't say). Refuses an empty filter, which would empty the table. */
  async remove(table: string, where: Where): Promise<number | null> {
    if (!Object.keys(where).length) throw new Error(`Refusing to delete every row of ${table}`);
    const p = append(new URLSearchParams(), where);
    return total(await this.send('DELETE', table, p, 'return=minimal,count=exact'));
  }
}

/** Runs `fn`, or returns `fallback` if the table or column it needs doesn't exist. */
export async function ifPresent<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MissingRelation) return fallback;
    throw err;
  }
}

export const iso = (t: number) => new Date(t).toISOString();
/** A UTC day (ms) as a Postgres `date`: 2026-10-12. */
export const dayString = (t: number) => iso(t).slice(0, 10);
export const dayMs = (d: string) => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
