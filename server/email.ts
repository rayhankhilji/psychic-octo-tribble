import type { Extension } from './extensions.ts';

/** Email links (`/api/email/*`): unsubscribe. */
export const emailExtension: Extension = {
  match: () => false,
  handle: async () => new Response(null, { status: 404 }),
};
