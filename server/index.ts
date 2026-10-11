import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Timeline } from '../src/data/types.ts';
import { staticPath } from './static.ts';
import { buildTimeline, readConfig } from './timeline.ts';

try {
  process.loadEnvFile();
} catch {
  // No .env file; environment variables or demo mode.
}

const config = readConfig(process.env);
const port = Number(process.env.PORT ?? 8787);
const root = resolve(fileURLToPath(new URL('../dist', import.meta.url)));
const CACHE_MS = 60_000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

let cached: { at: number; timeline: Promise<Timeline | null> } | undefined;

function timeline(): Promise<Timeline | null> {
  if (!cached || Date.now() - cached.at > CACHE_MS) {
    const pending = buildTimeline(config);
    cached = { at: Date.now(), timeline: pending };
    pending.catch(() => (cached = undefined));
  }
  return cached.timeline;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/api/timeline') {
    try {
      const t = await timeline();
      if (!t) return json(res, 404, { error: 'No integrations configured. Add STRIPE_SECRET_KEY or GITHUB_REPO to .env.' });
      return json(res, 200, t);
    } catch (err) {
      console.error(err);
      return json(res, 502, { error: err instanceof Error ? err.message : 'Upstream error' });
    }
  }

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
  const live = [config.stripeKey && 'Stripe', config.githubRepo && `GitHub (${config.githubRepo})`].filter(Boolean);
  console.log(`TinyTown on http://localhost:${port} · ${live.length ? `live: ${live.join(', ')}` : 'demo mode (no integrations configured)'}`);
});
