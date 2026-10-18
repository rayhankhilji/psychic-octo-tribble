/** Types for tools/vercel-setup.mjs, so the tests can import it under strict TypeScript. */
import type { SetupStep } from './stripe-setup.d.mts';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export type Target = 'production' | 'preview';
export interface VercelApi {
  (method: string, path: string, opts?: { body?: unknown; query?: Record<string, string | undefined | null> }): Promise<any>;
  team: string | null;
}

/** One variable as the tools want it: a string sets it, null keeps what's there. */
export interface DesiredEnv {
  key: string;
  secret: boolean;
  values?: Partial<Record<Target, string | null | undefined>>;
  generate?: Target[];
  remove?: Target[];
}

export interface ExistingEnv {
  id: string;
  key: string;
  type: string;
  target: string[];
  value?: string;
  decrypted?: boolean;
  comment?: string;
  gitBranch?: string | null;
  customEnvironmentIds?: string[];
}

export type EnvOp =
  | { op: 'create'; key: string; targets: string[]; value: string; type: string; comment: string }
  | { op: 'update'; id: string; key: string; targets: string[]; value: string; comment: string }
  | { op: 'retarget'; id: string; key: string; targets: string[] }
  | { op: 'delete'; id: string; key: string };

export interface HeldBack {
  group: string;
  target: Target;
  missing: string[];
  planned: string[];
  alreadyHalfSet: boolean;
}

export const API: string;
export const TARGETS: Target[];
export const PRODUCTION_BRANCH: string;
export const NODE_VERSION: string;
export const GENERATED: string[];
export const SECRET_NAMES: Set<string>;
export const ENV_GROUPS: { name: string; vars: string[] }[];
export function newSecret(): string;
export function parseArgs(argv: string[]): { project: string | null; team: string | null; domain: string | null; deploy: boolean; production: boolean; branch: string | null; apply: boolean; help: boolean };
export function domainUrl(raw: string | null | undefined): string | null;
export class VercelSetupError extends Error {
  status: number;
  code?: string;
}
export function vercelClient(opts: { token: string | undefined; team?: string | null; fetch?: Fetch; retryDelayMs?: number }): VercelApi;
export function findProject(api: VercelApi, name: string | null | undefined): Promise<any>;
export function teamSlug(api: VercelApi): Promise<string | null>;
export function productionUrl(api: VercelApi, project: any): Promise<string>;
export function ensureProject(api: VercelApi, project: any, opts: { dryRun: boolean }): Promise<{ steps: SetupStep[]; notes: string[] }>;
export function fingerprint(key: string, value: string): string;
export function listEnv(api: VercelApi, project: any): Promise<ExistingEnv[]>;
export function planEnv(
  existing: ExistingEnv[],
  desired: DesiredEnv[],
): { ops: EnvOp[]; status: Record<string, Partial<Record<Target, string>>>; heldBack: HeldBack[]; generated: Record<Target, Record<string, string>> };
export function syncEnv(
  api: VercelApi,
  project: any,
  desired: DesiredEnv[],
  opts: { dryRun: boolean },
): Promise<{ steps: SetupStep[]; notes: string[]; heldBack: HeldBack[]; generated: Record<Target, Record<string, string>>; status: Record<string, Partial<Record<Target, string>>> }>;
export function tinytownEnv(opts: {
  supabase?: { url: string; anonKey: string; serviceKey: string } | null;
  stripe?: Partial<Record<Target, { mode: 'test' | 'live'; key: string; env: Record<string, string | null> } | null>>;
  appUrl?: string | null;
  env?: Record<string, string | undefined>;
  emailFrom?: string | null;
  adminEmails?: string | null;
}): { desired: DesiredEnv[]; missing: string[] };
export function currentBranch(): string | null;
export function deploy(
  api: VercelApi,
  project: any,
  opts: { branch: string | null; production?: boolean; timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; onWait?: (state: string) => void },
): Promise<{ id: string; url: string; state: string; inspectorUrl: string | null }>;
export function protectionBypass(api: VercelApi, project: any, opts: { dryRun: boolean }): Promise<{ secret: string | null; step: SetupStep }>;
export function smokeCheck(opts: { baseUrl: string; fetch?: Fetch; secrets?: string[]; bypass?: string | null; healthSecret?: string | null }): Promise<{ name: string; ok: boolean; detail: string }[]>;
export function formatSteps(title: string, steps: SetupStep[]): string;
export function scrub(text: string, secrets: Iterable<string>): string;
