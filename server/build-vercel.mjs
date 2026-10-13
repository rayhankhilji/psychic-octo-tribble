// Packages the app for Vercel using the Build Output API v3
// (https://vercel.com/docs/build-output-api), run after `vite build`:
//
//   .vercel/output/config.json                routes (with security and cache headers) and crons
//   .vercel/output/static/                    the Vite build (dist/)
//   .vercel/output/functions/api.func/        one Node.js function: server/vercel.ts bundled
//
// Vercel uses .vercel/output as-is when the build command leaves it behind,
// so nothing here depends on how Vercel would compile TypeScript itself (our
// sources import each other with `.ts` extensions). That also means
// vercel.json's own `headers`, `crons` and `functions` would be ignored:
// they all live here. The bundle is made with Vite (already a dependency)
// and loaded once at the end as a smoke test.
//
// Before anything is built, the environment is checked (server/env.ts): a
// half-configured deploy (say, a billing key without its webhook secret)
// fails here with a plain explanation instead of taking money it can't
// record. ENV_CHECK=warn downgrades that to warnings.
//
// Usage: node server/build-vercel.mjs   (after `npm run build`)
import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkEnv } from './env.ts';
import { BASE_SECURITY_HEADERS, siteCsp } from './http.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.vercel/output');
const dist = join(root, 'dist');
const fn = join(out, 'functions/api.func');

/**
 * The scheduled jobs (server/cron.ts). Vercel calls each path with GET and
 * `Authorization: Bearer $CRON_SECRET`, on the production deployment only.
 * Times are UTC and deliberately off the hour, when Vercel's crons bunch up.
 * Hobby plans may only run crons once a day, and refuse to deploy an hourly
 * one: CRON_HOURLY=off leaves it out until the project is on Pro.
 */
export function crons(env = process.env) {
  return [
    ...(env.CRON_HOURLY === 'off' ? [] : [{ path: '/api/cron/hourly', schedule: '7 * * * *' }]),
    { path: '/api/cron/daily', schedule: '17 3 * * *' },
    { path: '/api/cron/weekly', schedule: '23 15 * * 1' },
  ];
}

/** `.vercel/output/config.json`. Pure, so tests can check it without building. */
export function outputConfig(env = process.env) {
  const site = {
    ...BASE_SECURITY_HEADERS,
    'Content-Security-Policy': siteCsp({ supabaseUrl: env.SUPABASE_URL, vercelToolbar: env.VERCEL_ENV === 'preview' }),
  };
  return {
    version: 3,
    routes: [
      // Every page and file of the site gets the security headers. The API
      // sets its own (stricter) ones in server/node.ts.
      { src: '^/(?!api(?:/|$)).*$', headers: site, continue: true },
      // Hashed build assets never change.
      { src: '^/assets/(.*)$', headers: { 'Cache-Control': 'public, max-age=31536000, immutable' }, continue: true },
      // Pages always revalidate, so a deploy shows at once (they're small, and everything they load is hashed).
      { src: '^/(?:.*\\.html)?$', headers: { 'Cache-Control': 'no-cache' }, continue: true },
      // Real files (the Vite build) first, as Vercel's own framework adapters do.
      // The brand and press page is a folder with its own index.
      { src: '^/brand/?$', dest: '/brand/index.html' },
      { handle: 'filesystem' },
      // Every API path goes to the one function; the original path rides along.
      { src: '^(/api(?:/.*)?)$', dest: '/api?__path=$1' },
      // Missing files and legal pages get the branded 404 rather than the app shell.
      { src: '^/legal/.*$', status: 404, dest: '/404.html' },
      { src: '^/.*\\.[a-zA-Z0-9]+$', status: 404, dest: '/404.html' },
      // Single-page app: anything else is the app shell.
      { src: '^/(.*)$', dest: '/index.html', headers: { 'Cache-Control': 'no-cache' } },
    ],
    crons: crons(env),
  };
}

/**
 * The function's settings. A minute is far longer than any request should
 * take (most finish in well under a second) and long enough for a batch of
 * the scheduled jobs; anything slower is stuck, and cutting it off caps the
 * bill. Memory isn't set here: Vercel ignores it in favour of the project's
 * Functions settings (2 GB, 1 vCPU by default, which is plenty).
 */
export const FUNCTION_CONFIG = {
  runtime: 'nodejs22.x',
  handler: 'index.mjs',
  launcherType: 'Nodejs',
  // No body parsing: the Stripe webhook needs the exact bytes Stripe signed.
  shouldAddHelpers: false,
  shouldAddSourcemapSupport: true,
  maxDuration: 60,
};

async function main() {
  const problems = checkEnv(process.env);
  for (const p of problems) console[p.level === 'error' ? 'error' : 'warn'](`config ${p.level}: ${p.message}`);
  const errors = problems.filter((p) => p.level === 'error');
  if (errors.length && process.env.ENV_CHECK !== 'warn') {
    console.error(`\nNot deploying: ${errors.length} configuration ${errors.length === 1 ? 'error' : 'errors'} above. Fix the variables in Vercel → Settings → Environment Variables (or set ENV_CHECK=warn to deploy anyway).`);
    process.exit(1);
  }

  if (!(await stat(join(dist, 'index.html')).catch(() => null))) {
    console.error('dist/ is missing: run `npm run build` first.');
    process.exit(1);
  }

  await rm(out, { recursive: true, force: true });
  await mkdir(fn, { recursive: true });
  await cp(dist, join(out, 'static'), { recursive: true });

  const { build } = await import('vite');
  await build({
    root,
    configFile: false,
    logLevel: 'warn',
    publicDir: false,
    build: {
      ssr: 'server/vercel.ts',
      outDir: fn,
      emptyOutDir: false,
      target: 'node22',
      minify: false,
      sourcemap: true,
      rollupOptions: { output: { format: 'esm', entryFileNames: 'index.mjs', inlineDynamicImports: true } },
    },
    // Bundle everything (there are no runtime npm dependencies); Node built-ins stay external.
    ssr: { noExternal: true, target: 'node' },
  });

  await writeFile(join(fn, '.vc-config.json'), JSON.stringify(FUNCTION_CONFIG, null, 2));
  const config = outputConfig(process.env);
  // Every page a route serves must exist, or that route answers with Vercel's bare error page.
  for (const r of config.routes) {
    if (r.dest && !r.dest.startsWith('/api') && !(await stat(join(out, 'static', r.dest)).catch(() => null))) {
      throw new Error(`Route ${r.src} serves ${r.dest}, which isn't in the build (is it in public/?)`);
    }
  }
  await writeFile(join(out, 'config.json'), JSON.stringify(config, null, 2));

  // Smoke test: load the bundle and ask it for /api/config with an empty
  // environment (local mode, no network). A broken bundle fails the deploy here
  // instead of on the first request.
  const mod = await import(pathToFileURL(join(fn, 'index.mjs')).href);
  if (typeof mod.default !== 'function' || typeof mod.vercelHandler !== 'function') throw new Error('Bundle has no handler');
  const { Readable } = await import('node:stream');
  const result = await new Promise((done, fail) => {
    const req = Object.assign(Readable.from([]), { url: '/api?__path=/api/config', method: 'GET', headers: { host: 'localhost' } });
    const res = {
      headersSent: false,
      status: 0,
      headers: {},
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers ?? {};
        this.headersSent = true;
        return this;
      },
      end(body) {
        done({ status: this.status, headers: this.headers, body: String(body ?? '') });
      },
    };
    mod.vercelHandler({})(req, res).catch(fail);
  });
  if (result.status !== 200 || !result.body.includes('"hosted":false')) throw new Error(`Smoke test failed: ${result.status} ${result.body}`);
  if (!String(result.headers['content-security-policy'] ?? '').includes("default-src 'none'")) throw new Error('Smoke test failed: the API sent no security headers');
  console.log(`Vercel build output ready in .vercel/output (function smoke test passed; ${crons().length} crons).`);
}

// Run only as a script, so tests can import the config builders above.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
