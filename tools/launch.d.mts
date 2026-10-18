/** Types for tools/launch.mjs, so the tests can import it under strict TypeScript. */
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface LaunchArgs {
  supabaseRef: string | null;
  vercelProject: string | null;
  team: string | null;
  domain: string | null;
  live: boolean;
  production: boolean;
  branch: string | null;
  deploy: boolean;
  emailFrom: string | null;
  adminEmails: string | null;
  emailRate: number;
  markApplied: string[];
  dryRun: boolean;
  apply: boolean;
  help: boolean;
}

export interface LaunchResult {
  dryRun: boolean;
  failed: string | null;
  checks: { name: string; ok: boolean; detail: string }[];
  done: string[];
  todo: string[];
}

export const CLOUD_ENV: string[];
export const CLOUD_SECRETS: string[];
export function parseArgs(argv: string[]): LaunchArgs;
export function stripeKeys(env: Record<string, string | undefined>, live: boolean): { test: string; live: string | null };
export function launch(opts: {
  args: LaunchArgs;
  env?: Record<string, string | undefined>;
  fetch?: Fetch;
  log?: (line: string) => void;
  gitBranch?: () => string | null;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  retryDelayMs?: number;
}): Promise<LaunchResult>;
export function checklist(r: LaunchResult): string;
