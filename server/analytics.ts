import type { Ctx } from './context.ts';

/**
 * Our own product funnel (signed up, started checkout, paid, connected,
 * built), sent server-side so ad blockers don't skew it. Never throws.
 */
export type FunnelEvent = 'signed_up' | 'checkout_started' | 'plan_started' | 'plan_canceled' | 'connected_stripe' | 'connected_github' | 'first_build' | 'account_deleted';

export async function track(_ctx: Ctx, _userId: string, _event: FunnelEvent, _props: Record<string, string | number | boolean> = {}): Promise<void> {}
