/** Types for tools/supabase-setup.mjs, so the tests can import it under strict TypeScript. */
import type { SetupStep } from './stripe-setup.d.mts';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export type SupabaseApi = (method: string, path: string, body?: unknown) => Promise<any>;

export interface Migration {
  file: string;
  version: string;
  name: string;
  sql: string;
}

export interface SupabaseKeys {
  url: string;
  anonKey: string;
  serviceKey: string;
  kind: string;
}

export interface SupabaseResult {
  project: { ref: string; name: string; region: string | null; status: string } | null;
  dryRun: boolean;
  steps: SetupStep[];
  notes: string[];
  /** Why the run stopped (a migration failed), or null. */
  failed: string | null;
  /** In memory only: report() never shows them. */
  keys: SupabaseKeys | null;
}

export const API: string;
export const MIGRATIONS_DIR: string;
export const TEMPLATES_DIR: string;
export const LAUNCH_LIMITS: { emailsPerHour: number; signInsPer5Min: number; verificationsPer5Min: number };
export const RESEND_SMTP: { host: string; port: string; user: string; minIntervalSeconds: number };
export const DEV_REDIRECT: string;
export const TEMPLATE_KINDS: Record<string, string>;
export const HISTORY_TABLE: string;
export const HISTORY_DDL: string;

export function parseArgs(argv: string[]): {
  ref: string | null;
  siteUrl: string | null;
  previewUrls: string | null;
  emailFrom: string | null;
  emailRate: number;
  markApplied: string[];
  toVercel: boolean;
  vercelProject: string | null;
  team: string | null;
  apply: boolean;
  help: boolean;
};
export function checkRef(ref: string | null | undefined): string;
export function checkSiteUrl(raw: string | null | undefined): string;
export function parseFrom(raw: string | null | undefined): { name: string; email: string } | null;
export class SupabaseSetupError extends Error {
  status: number;
}
export function supabaseClient(token: string | undefined, fetch?: Fetch, opts?: { retryDelayMs?: number }): SupabaseApi;
export function checkProject(api: SupabaseApi, ref: string): Promise<{ ref: string; name: string; region: string | null; status: string }>;
export function readMigrations(dir?: string): Promise<Migration[]>;
export function migrationQuery(m: Migration): string;
export function applyMigrations(api: SupabaseApi, ref: string, migrations: Migration[], opts: { dryRun: boolean; markApplied?: string[] }): Promise<{ steps: SetupStep[]; failed: string | null }>;
export function loadTemplates(dir?: string): Promise<{ kind: string; name: string; subject: string; html: string }[]>;
export function redirectList(existing: string | null | undefined, siteUrl: string, previewUrls?: string | null): string;
export function planAuth(
  current: Record<string, unknown>,
  opts: { siteUrl: string; previewUrls?: string | null; templates: { kind: string; name: string; subject: string; html: string }[]; smtp: { name: string; email: string; password: string } | null; emailRate: number; dryRun: boolean },
): { patch: Record<string, unknown>; steps: SetupStep[]; notes: string[] };
export function fetchApiKeys(api: SupabaseApi, ref: string): Promise<SupabaseKeys>;
export function setupSupabase(opts: {
  token: string | undefined;
  ref: string | null | undefined;
  siteUrl: string | null | undefined;
  previewUrls?: string | null;
  resendKey?: string | null;
  emailFrom?: string | null;
  emailRate?: number;
  markApplied?: string[];
  dryRun?: boolean;
  withKeys?: boolean;
  fetch?: Fetch;
  migrationsDir?: string;
  templatesDir?: string;
  retryDelayMs?: number;
}): Promise<SupabaseResult>;
export function report(r: SupabaseResult): string;
export function supabaseEnv(keys: SupabaseKeys): { key: string; secret: boolean; values: { production?: string | null; preview?: string | null } }[];
