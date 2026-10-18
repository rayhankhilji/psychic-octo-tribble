import { ROUTES, type EmailPrefs } from '../src/api/contract.ts';
import { hosted, rateLimit, requireUser } from './context.ts';
import { DEFAULT_PREFS, handleUnsubscribe, type EmailPrefsRow } from './email/prefs.ts';
import type { Extension } from './extensions.ts';
import { HttpError, badRequest, json, notConfigured, readJson } from './http.ts';

export { weeklyDigest } from './email/digest.ts';

/**
 * Email routes (`/api/email/*`): the unsubscribe link in every non-essential
 * email (public: the signed token is the authorisation), and the signed-in
 * founder's preferences from the account menu. The weekly digest
 * (`weeklyDigest`) is sent from the weekly cron.
 */
export const emailExtension: Extension = {
  match: (path) => path === ROUTES.unsubscribe || path === ROUTES.emailPrefs,
  handle: async (ctx) => {
    const method = ctx.req.method;
    if (ctx.url.pathname.replace(/\/+$/, '') === ROUTES.emailPrefs) {
      if (method !== 'GET' && method !== 'PUT') throw new HttpError(405, 'Method not allowed.', 'bad_request');
      if (!ctx.s.supabase) throw notConfigured('Accounts');
      // Any signed-in founder, paid or not: turning email off never needs a plan.
      const h = hosted(ctx);
      const user = await requireUser(h);
      if (method === 'PUT') {
        await rateLimit(`email-prefs:${user.id}`, 30, ctx.now, { ctx });
        const body = await readJson(ctx.req);
        const patch: Partial<EmailPrefsRow> = {};
        for (const [key, column] of [['weeklyDigest', 'weekly_digest'], ['productUpdates', 'product_updates']] as const) {
          if (body[key] === undefined) continue;
          if (typeof body[key] !== 'boolean') throw badRequest(`${key} should be true or false.`);
          patch[column] = body[key];
        }
        if (Object.keys(patch).length) await h.db.upsert('email_prefs', { user_id: user.id, ...patch, updated_at: new Date(ctx.now).toISOString() }, 'user_id');
      }
      const row = await h.db.one<EmailPrefsRow>('email_prefs', { user_id: user.id });
      const prefs: EmailPrefs = { weeklyDigest: row?.weekly_digest ?? DEFAULT_PREFS.weekly_digest, productUpdates: row?.product_updates ?? DEFAULT_PREFS.product_updates };
      return json(prefs);
    }
    if (method !== 'GET' && method !== 'POST') throw new HttpError(405, 'Method not allowed.', 'bad_request');
    return handleUnsubscribe(ctx);
  },
};
