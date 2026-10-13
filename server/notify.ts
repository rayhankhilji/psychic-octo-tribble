import type { Hosted } from './context.ts';

/**
 * Lifecycle events other modules announce; the email module decides what
 * (if anything) to send. Never throws: a failed email must not fail a
 * webhook or a request.
 */
export type NotifyEvent =
  | { kind: 'plan.started'; userId: string; interval: 'month' | 'year' }
  | { kind: 'plan.payment_failed'; userId: string }
  | { kind: 'plan.canceled'; userId: string; endsAt: number | null }
  | { kind: 'plan.ended'; userId: string }
  | { kind: 'connection.broken'; userId: string; provider: 'stripe' | 'github' | 'posthog' }
  | { kind: 'account.deleted'; email: string }
  | { kind: 'access.invited'; email: string };

export async function notify(_ctx: Hosted, _event: NotifyEvent): Promise<void> {}
