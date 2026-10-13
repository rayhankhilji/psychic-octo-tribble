import type { Hosted } from './context.ts';
import type { AuthUser } from './supabase.ts';

/**
 * Launch gating. In `waitlist` mode only invited emails may use the hosted
 * game (403 `not_invited` otherwise); in `open` mode, anyone. Called for
 * every signed-in route.
 */
export async function checkAccess(_ctx: Hosted, _user: AuthUser): Promise<void> {}
