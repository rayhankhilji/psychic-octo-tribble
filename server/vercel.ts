import type { IncomingMessage, ServerResponse } from 'node:http';
import { handle } from './app.ts';
import type { Env } from './env.ts';
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
  return nodeHandler(
    (req) => handle(req, env),
    (req: IncomingMessage) => {
      // Only when we were handed the rewritten URL itself; a real path always wins.
      const url = new URL(req.url ?? '/', 'http://localhost');
      const p = url.searchParams.get('__path');
      return url.pathname === '/api' && p && /^\/api(\/[\w.\-/]*)?$/.test(p) ? p : undefined;
    },
  );
}

const handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> = vercelHandler(process.env);
export default handler;
