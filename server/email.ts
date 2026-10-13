import { ROUTES } from '../src/api/contract.ts';
import { handleUnsubscribe } from './email/prefs.ts';
import type { Extension } from './extensions.ts';
import { HttpError } from './http.ts';

export { weeklyDigest } from './email/digest.ts';

/**
 * Email links (`/api/email/*`): the unsubscribe link in every non-essential
 * email. Public: the signed token is the authorisation. The weekly digest
 * (`weeklyDigest`) is sent from the weekly cron.
 */
export const emailExtension: Extension = {
  match: (path) => path === ROUTES.unsubscribe,
  handle: async (ctx) => {
    const method = ctx.req.method;
    if (method !== 'GET' && method !== 'POST') throw new HttpError(405, 'Method not allowed.', 'bad_request');
    return handleUnsubscribe(ctx);
  },
};
