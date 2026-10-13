/** Types for tools/stripe-setup.mjs, so the tests can import it under strict TypeScript. */

export interface SetupStep {
  thing: string;
  action: string;
  id: string;
}

export interface SetupResult {
  mode: 'test' | 'live';
  account: { id: string; name: string | null; country: string | null } | null;
  appUrl: string;
  dryRun: boolean;
  steps: SetupStep[];
  /** Variable → value; null means "unchanged, keep the one you saved". */
  env: Record<string, string | null>;
  notes: string[];
}

export const PRODUCT: { id: string; name: string; description: string };
export const PRICES: { interval: 'month' | 'year'; lookupKey: string; amount: number; currency: string; nickname: string; env: string }[];
export const WEBHOOK_EVENTS: string[];
export const API_VERSION: string;
export const WEBHOOK_PATH: string;

export function parseArgs(argv: string[]): { appUrl: string | null; dryRun: boolean; live: boolean; help: boolean };
export function keyMode(key: string | undefined, live: boolean): 'test' | 'live';
export function checkAppUrl(raw: string | null | undefined): string;
export function portalParams(appUrl: string, productId: string, priceIds: string[], opts?: { scheduleDowngrades?: boolean }): Record<string, unknown>;
export function setupStripe(opts: {
  key: string | undefined;
  appUrl: string | null | undefined;
  dryRun?: boolean;
  live?: boolean;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}): Promise<SetupResult>;
export function report(result: SetupResult): string;
