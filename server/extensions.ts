import type { Ctx } from './context.ts';
import { accountExtension } from './account.ts';
import { adminExtension } from './admin.ts';
import { cronExtension } from './cron.ts';
import { emailExtension } from './email.ts';
import { healthExtension } from './health.ts';

/**
 * Routes that live in their own modules, so each area (accounts, admin,
 * scheduled jobs, email, health and telemetry) owns its file instead of
 * everyone editing the router. The router asks each in turn before its own
 * table; the first whose `match` says yes handles the request, including its
 * own auth (`hosted` and `requireUser` in context.ts, `requirePaid` in state.ts).
 */
export interface Extension {
  match(path: string, method: string): boolean;
  handle(ctx: Ctx): Promise<Response>;
}

export const EXTENSIONS: Extension[] = [healthExtension, cronExtension, emailExtension, accountExtension, adminExtension];
