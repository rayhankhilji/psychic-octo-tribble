import type { Extension } from './extensions.ts';

/** Health checks and browser telemetry (`/api/health`, `/api/telemetry`). */
export const healthExtension: Extension = {
  match: () => false,
  handle: async () => new Response(null, { status: 404 }),
};
