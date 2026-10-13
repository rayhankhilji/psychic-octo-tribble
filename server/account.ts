import type { Extension } from './extensions.ts';

/** Account lifecycle: export your data, delete your account (`/api/account*`). */
export const accountExtension: Extension = {
  match: () => false,
  handle: async () => new Response(null, { status: 404 }),
};
