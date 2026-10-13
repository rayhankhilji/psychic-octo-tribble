import type { Extension } from './extensions.ts';

/** Scheduled jobs (`/api/cron/*`), called by Vercel Cron with CRON_SECRET. */
export const cronExtension: Extension = {
  match: () => false,
  handle: async () => new Response(null, { status: 404 }),
};
