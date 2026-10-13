import { ROUTES, type ConfigResponse, type Provider } from '../src/api/contract.ts';
import type { Timeline } from '../src/data/types.ts';
import { checkAccess, resetAccessCaches } from './access.ts';
import { appUrl, checkout, plans, portal, resetBillingCaches, webhook } from './billing.ts';
import { hosted, rateLimit, requirePaid, requireUser, resetContextCaches, type Ctx, type Hosted } from './context.ts';
import { settings, type Env } from './env.ts';
import { EXTENSIONS } from './extensions.ts';
import * as github from './github-app.ts';
import { userTimeline, resetTimelineCaches } from './hosted-timeline.ts';
import { HttpError, errorResponse, json, notConfigured, readJson } from './http.ts';
import { finishRequest, log, reportError } from './log.ts';
import { backHome } from './oauth.ts';
import { ensureProfile, type ProfileRow } from './store.ts';
import * as stripeApp from './stripe-app.ts';
import { buildTimeline, readConfig } from './timeline.ts';
import { setUsersSource } from './users.ts';
import { getActions, me, patchWorld, postAction } from './world.ts';

/**
 * The TinyTown API: one web-standard handler for every `/api` route in
 * `ROUTES` (src/api/contract.ts). `server/index.ts` serves it locally and
 * `server/vercel.ts` on Vercel. Without Supabase configured it runs in local
 * mode: `/api/config` says `hosted: false` and `/api/timeline` serves the
 * `.env` integrations exactly as the original local server did.
 */
export async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const ctx: Ctx = { req, url, env, s: settings(env), now: Date.now() };
  const started = performance.now();
  let res: Response;
  try {
    res = await route(ctx);
  } catch (err) {
    if (err instanceof HttpError) res = errorResponse(err);
    else {
      // Unexpected: logged (scrubbed, with the request id) and sent to Sentry if it's set up.
      await reportError(ctx, err);
      res = errorResponse(new HttpError(500, 'Something went wrong on our side. Try again in a moment.'));
    }
  }
  // One line per request: id, route, status, time taken, user.
  return finishRequest(ctx, res, started);
}

const methodNotAllowed = () => new HttpError(405, 'Method not allowed.', 'bad_request');

async function route(ctx: Ctx): Promise<Response> {
  const { pathname } = ctx.url;
  const method = ctx.req.method;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;

  if (path === ROUTES.config) {
    if (method !== 'GET') throw methodNotAllowed();
    // Nothing in it is per-user: let Vercel's edge serve it, so a launch spike doesn't fan out to Stripe's price API.
    return json(await config(ctx), 200, { 'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600' });
  }
  // Health, cron, email links, accounts and admin: each module checks its own auth.
  for (const ext of EXTENSIONS) if (ext.match(path, method)) return ext.handle(ctx);
  if (!ctx.s.supabase) {
    if (path === ROUTES.timeline && method === 'GET') return localTimeline(ctx);
    throw notConfigured('Accounts');
  }
  const h = hosted(ctx);

  // Called by Stripe and by the providers' redirects, not by the signed-in app.
  if (path === ROUTES.webhook) {
    if (method !== 'POST') throw methodNotAllowed();
    return json(await webhook(h));
  }
  // A browser lands on these, so failures go home with a message rather than as JSON.
  if (path === ROUTES.stripeCallback || path === ROUTES.githubCallback) {
    if (method !== 'GET') throw methodNotAllowed();
    const provider = path === ROUTES.stripeCallback ? 'stripe' : 'github';
    try {
      return await (provider === 'stripe' ? stripeApp.callback(h) : github.callback(h));
    } catch (err) {
      await reportError(ctx, err, `${provider} callback failed`);
      return backHome(h, provider, 'upstream');
    }
  }

  const handler = ROUTE_TABLE[path];
  const connectDelete = /^\/api\/connect\/(stripe|github|posthog)$/.exec(path);
  if (!handler && !(connectDelete && method === 'DELETE')) throw new HttpError(404, 'Not found.', 'bad_request');

  const user = await requireUser(h);
  await checkAccess(h, user);
  if (connectDelete && method === 'DELETE') {
    await requirePaid(h, user);
    await rateLimit(`connect:${user.id}`, 20, ctx.now, { ctx: h });
    return json(await disconnect(h, user.id, connectDelete[1] as Provider));
  }
  const fn = handler![method];
  if (!fn) throw methodNotAllowed();
  return fn(h, user);
}

type Handler = (ctx: Hosted, user: { id: string; email: string | null }) => Promise<Response>;

/** Every signed-in route. `paid` ones answer 402 without an active plan. */
const paid =
  (limit: number | null, fn: Handler): Handler =>
  async (ctx, user) => {
    await requirePaid(ctx, user);
    // Writes are counted in Postgres across every instance; reads only in this
    // instance's memory, which stops a loop without a database call per page load.
    if (limit !== null) await rateLimit(`${ctx.req.method} ${ctx.url.pathname}:${user.id}`, limit, ctx.now, ctx.req.method === 'GET' ? {} : { ctx });
    return fn(ctx, user);
  };

const ROUTE_TABLE: Record<string, Record<string, Handler>> = {
  [ROUTES.me]: { GET: async (ctx, user) => json(await me(ctx, user)) },
  [ROUTES.checkout]: {
    POST: async (ctx, user) => {
      await rateLimit(`checkout:${user.id}`, 10, ctx.now, { ctx });
      return json(await checkout(ctx, user, await readJson(ctx.req)));
    },
  },
  [ROUTES.portal]: {
    POST: async (ctx, user) => {
      await rateLimit(`portal:${user.id}`, 10, ctx.now, { ctx });
      return json(await portal(ctx, user));
    },
  },
  [ROUTES.world]: {
    GET: paid(null, async (ctx, user) => json((await me(ctx, user)).world)),
    PATCH: paid(30, async (ctx, user) => json(await patchWorld(ctx, user, await readJson(ctx.req)))),
  },
  [ROUTES.actions]: {
    GET: paid(null, async (ctx, user) => json(await getActions(ctx, user))),
    POST: paid(60, async (ctx, user) => json(await postAction(ctx, user, await readJson(ctx.req)))),
  },
  [ROUTES.timeline]: {
    GET: paid(30, async (ctx, user) => json(await userTimeline(ctx, await ensureProfile(ctx.db, user.id)))),
  },
  [ROUTES.connectStripe]: {
    POST: paid(10, async (ctx, user) => {
      const { body, setCookie } = stripeApp.installLink(ctx, user);
      return json(body, 200, { 'Set-Cookie': setCookie });
    }),
  },
  [ROUTES.connectGithub]: {
    POST: paid(10, async (ctx, user) => {
      const { body, setCookie } = github.installLink(ctx, user);
      return json(body, 200, { 'Set-Cookie': setCookie });
    }),
  },
  [ROUTES.githubRepos]: { GET: paid(20, async (ctx, user) => json(await github.repos(ctx, user))) },
  [ROUTES.githubRepo]: { PUT: paid(10, async (ctx, user) => json(await github.setRepo(ctx, user, await readJson(ctx.req)))) },
  [ROUTES.users]: { PUT: paid(10, async (ctx, user) => json(await setUsersSource(ctx, user, await readJson(ctx.req)))) },
};

/** `DELETE /api/connect/:provider`. The provider-side app stays installed; the founder can remove it there. */
async function disconnect(ctx: Hosted, userId: string, provider: Provider): Promise<{ ok: true }> {
  await ctx.db.remove('connections', { user_id: userId, provider });
  if (provider === 'posthog') {
    const profile = await ctx.db.one<ProfileRow>('profiles', { user_id: userId });
    if (profile?.users_source === 'posthog') await ctx.db.update('profiles', { user_id: userId }, { users_source: 'customers' });
  }
  await ctx.db.remove('timelines', { user_id: userId });
  return { ok: true };
}

/** `GET /api/config`: public. Only the Supabase URL and anon key ever leave the server. */
async function config(ctx: Ctx): Promise<ConfigResponse> {
  const s = ctx.s;
  if (!s.supabase) return { hosted: false, supabase: null, plans: [], connect: { stripe: false, github: false, posthog: false }, captcha: null, access: 'open', supportEmail: null };
  let billingReady = !!s.billing;
  try {
    if (billingReady) appUrl(ctx);
  } catch {
    billingReady = false;
  }
  return {
    hosted: true,
    supabase: { url: s.supabase.url, anonKey: s.supabase.anonKey },
    plans: billingReady ? await plans(ctx) : [],
    connect: { stripe: !!s.stripeApp && !!s.appUrl, github: !!s.githubApp && !!s.appUrl, posthog: !!s.secrets },
    captcha: ctx.env.TURNSTILE_SITE_KEY ? { provider: 'turnstile', siteKey: ctx.env.TURNSTILE_SITE_KEY } : null,
    access: ctx.env.ACCESS_MODE === 'waitlist' ? 'waitlist' : 'open',
    supportEmail: ctx.env.SUPPORT_EMAIL || null,
  };
}

// ─── Local mode: the .env integrations, unchanged ─────────────────────────

const LOCAL_CACHE_MS = 60_000;
let localCache: { key: string; at: number; timeline: Promise<Timeline | null> } | undefined;

async function localTimeline(ctx: Ctx): Promise<Response> {
  const cfg = readConfig(ctx.env as NodeJS.ProcessEnv);
  const key = JSON.stringify(cfg);
  if (!localCache || localCache.key !== key || ctx.now - localCache.at > LOCAL_CACHE_MS) {
    const pending = buildTimeline(cfg);
    localCache = { key, at: ctx.now, timeline: pending };
    pending.catch(() => (localCache = undefined));
  }
  try {
    const t = await localCache.timeline;
    if (!t) return json({ error: 'No integrations configured. Add STRIPE_SECRET_KEY or GITHUB_REPO to .env.' }, 404);
    return json(t);
  } catch (err) {
    log.warn('local timeline failed', { err });
    return json({ error: err instanceof Error ? err.message : 'Upstream error' }, 502);
  }
}

/** For tests: drop every in-memory cache. */
export function resetCaches() {
  localCache = undefined;
  resetContextCaches();
  resetAccessCaches();
  resetBillingCaches();
  resetTimelineCaches();
  github.resetGithubCaches();
}
