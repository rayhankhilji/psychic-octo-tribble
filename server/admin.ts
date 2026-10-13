import type { Extension } from './extensions.ts';

/** The internal admin console's API (`/api/admin/*`), for ADMIN_EMAILS only. */
export const adminExtension: Extension = {
  match: () => false,
  handle: async () => new Response(null, { status: 404 }),
};
