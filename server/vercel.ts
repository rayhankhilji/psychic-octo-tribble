import type { IncomingMessage, ServerResponse } from 'node:http';
import { handle } from './app.ts';
import { reportEnv, type Env } from './env.ts';
import { nodeHandler } from './node.ts';

/**
 * The Vercel Function. `server/build-vercel.mjs` bundles this file (and the
 * game code it imports) into `.vercel/output/functions/api.func/index.mjs`,
 * served by Vercel's Node.js launcher, which calls `(req, res)`.
 *
 * Every `/api/*` path is routed to this one function. Vercel hands a
 * rewritten function the URL the browser asked for; the rewrite also passes
 * that path as `__path`, used only if the function is ever given `/api` itself.
 */
export function vercelHandler(env: Env) {
  return nodeHandler((req) => handle(req, env), {
    // Vercel's edge sets X-Real-IP and X-Forwarded-For itself, overwriting whatever the caller sent.
    behindProxy: true,
    pathOf: (req: IncomingMessage) => {
      // Only when we were handed the rewritten URL itself; a real path always wins.
      const url = new URL(req.url ?? '/', 'http://localhost');
      const p = url.searchParams.get('__path');
      return url.pathname === '/api' && p && /^\/api(\/[\w.\-/]*)?$/.test(p) ? p : undefined;
    },
  });
}

const serve = vercelHandler(process.env);
let checked = false;

const handler = (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  // Once per instance, on its first request: say plainly what's half
  // configured. (The build refuses to ship errors, but this is what the
  // running function actually sees.)
  if (!checked) {
    checked = true;
    reportEnv(process.env);
  }
  return serve(req, res);
};
export default handler;
