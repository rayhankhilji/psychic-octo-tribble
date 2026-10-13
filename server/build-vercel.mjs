// Packages the app for Vercel using the Build Output API v3
// (https://vercel.com/docs/build-output-api), run after `vite build`:
//
//   .vercel/output/config.json                routes: files, then /api/* → the function, then index.html
//   .vercel/output/static/                    the Vite build (dist/)
//   .vercel/output/functions/api.func/        one Node.js function: server/vercel.ts bundled
//
// Vercel uses .vercel/output as-is when the build command leaves it behind,
// so nothing here depends on how Vercel would compile TypeScript itself (our
// sources import each other with `.ts` extensions). The bundle is made with
// Vite (already a dependency) and loaded once at the end as a smoke test.
//
// Usage: node server/build-vercel.mjs   (after `npm run build`)
import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.vercel/output');
const dist = join(root, 'dist');
const fn = join(out, 'functions/api.func');

if (!(await stat(join(dist, 'index.html')).catch(() => null))) {
  console.error('dist/ is missing: run `npm run build` first.');
  process.exit(1);
}

await rm(out, { recursive: true, force: true });
await mkdir(fn, { recursive: true });
await cp(dist, join(out, 'static'), { recursive: true });

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

await writeFile(
  join(fn, '.vc-config.json'),
  JSON.stringify(
    {
      runtime: 'nodejs22.x',
      handler: 'index.mjs',
      launcherType: 'Nodejs',
      shouldAddHelpers: false,
      shouldAddSourcemapSupport: true,
      maxDuration: 30,
    },
    null,
    2,
  ),
);

await writeFile(
  join(out, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      routes: [
        // Hashed build assets never change.
        { src: '^/assets/(.*)$', headers: { 'Cache-Control': 'public, max-age=31536000, immutable' }, continue: true },
        // Real files (the Vite build) first, as Vercel's own framework adapters do.
        { handle: 'filesystem' },
        // Every API path goes to the one function; the original path rides along.
        { src: '^(/api(?:/.*)?)$', dest: '/api?__path=$1' },
        // Single-page app: anything else is the app shell.
        { src: '^/(.*)$', dest: '/index.html' },
      ],
    },
    null,
    2,
  ),
);

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
    writeHead(status) {
      this.status = status;
      this.headersSent = true;
      return this;
    },
    end(body) {
      done({ status: this.status, body: String(body ?? '') });
    },
  };
  mod.vercelHandler({})(req, res).catch(fail);
});
if (result.status !== 200 || !result.body.includes('"hosted":false')) throw new Error(`Smoke test failed: ${result.status} ${result.body}`);
console.log('Vercel build output ready in .vercel/output (function smoke test passed).');
