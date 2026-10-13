import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from './app.ts';
import { settings } from './env.ts';
import { nodeHandler } from './node.ts';
import { staticPath } from './static.ts';
import { readConfig } from './timeline.ts';

try {
  process.loadEnvFile();
} catch {
  // No .env file; environment variables or demo mode.
}

const port = Number(process.env.PORT ?? 8787);
const root = resolve(fileURLToPath(new URL('../dist', import.meta.url)));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

// Every /api route goes through the same handler Vercel runs.
const api = nodeHandler((req) => handle(req, process.env));

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return api(req, res);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }

  let file = staticPath(root, url.pathname === '/' ? '/index.html' : url.pathname);
  if (!file) {
    res.writeHead(400).end();
    return;
  }
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) file = join(root, 'index.html');
  if (!(await stat(file).catch(() => null))) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Run `npm run build` first, or use `npm run dev`.');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

server.listen(port, () => {
  const s = settings(process.env);
  if (s.supabase) {
    const on = [s.billing && 'billing', s.stripeApp && `Stripe App (${s.stripeApp.livemode ? 'live' : 'test'})`, s.githubApp && 'GitHub App'].filter(Boolean);
    console.log(`TinyTown on http://localhost:${port} · hosted mode${on.length ? `: ${on.join(', ')}` : ''}`);
    return;
  }
  const config = readConfig(process.env);
  const live = [config.stripeKey && 'Stripe', config.githubRepo && `GitHub (${config.githubRepo})`].filter(Boolean);
  console.log(`TinyTown on http://localhost:${port} · ${live.length ? `live: ${live.join(', ')}` : 'demo mode (no integrations configured)'}`);
});
