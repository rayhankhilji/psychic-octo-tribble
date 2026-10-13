/**
 * The local stack for end-to-end and load runs: the fake providers
 * (tools/fake-providers.mjs) in this process, and the real `server/index.ts`
 * in a child process with every hosted feature switched on and its fetch
 * calls rewritten onto the fakes. Keys and secrets are made up per run.
 *
 * Not a vitest file (no `.test.ts`): tools/e2e.mjs and tools/loadtest.mjs import it.
 */
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakes } from '../../tools/fake-providers.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** Failure screenshots, the server log and results.json. CI uploads this folder when the job fails. */
export const OUT = resolve(process.env.TT_E2E_OUT ?? join(ROOT, 'e2e-output'));

export function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

/**
 * Starts fakes + server. `env` overrides or adds server variables (set one to
 * '' to switch a feature off). `latency` makes the fakes answer as slowly as
 * real providers do. Resolves once `/api/config` answers.
 */
export async function startStack({ env = {}, latency = {}, port, fakesOptions = {}, quiet = true } = {}) {
  mkdirSync(OUT, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const webhookSecret = `whsec_${randomBytes(16).toString('hex')}`;
  const fakes = await startFakes({ webhookSecret, latency, githubPublicKey: publicKey, log: !quiet, ...fakesOptions });
  const serverPort = port ?? (await freePort());
  const appUrl = `http://127.0.0.1:${serverPort}`;
  fakes.setAppUrl(appUrl);

  const serverEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    PORT: String(serverPort),
    FAKE_PROVIDERS_URL: fakes.url,
    APP_URL: appUrl,
    SUPABASE_URL: fakes.url,
    SUPABASE_ANON_KEY: fakes.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: fakes.serviceKey,
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    STATE_SECRET: randomBytes(24).toString('base64url'),
    STRIPE_BILLING_SECRET_KEY: `sk_test_${randomBytes(12).toString('hex')}`,
    STRIPE_WEBHOOK_SECRET: webhookSecret,
    STRIPE_PRICE_MONTHLY: 'price_month',
    STRIPE_PRICE_YEARLY: 'price_year',
    STRIPE_APP_CLIENT_ID: 'ca_fake_tinytown',
    // A live-mode app key would demand an https:// APP_URL for the callback; locally it's test mode.
    STRIPE_APP_INSTALL_URL: `${fakes.url}/stripe-pages/oauth/v2/authorize`,
    ALLOW_TEST_MODE: '1',
    GITHUB_APP_SLUG: 'tinytown-local',
    GITHUB_APP_ID: '4242',
    GITHUB_APP_CLIENT_ID: 'Iv1.fakeclient',
    GITHUB_APP_CLIENT_SECRET: randomBytes(16).toString('hex'),
    GITHUB_APP_PRIVATE_KEY: Buffer.from(privateKey).toString('base64'),
    CRON_SECRET: randomBytes(16).toString('hex'),
    SUPPORT_EMAIL: 'help@tinytown.test',
    ...env,
  };
  for (const [k, v] of Object.entries(serverEnv)) if (v === '' || v === undefined) delete serverEnv[k];

  const logs = [];
  const runDir = join(OUT, 'run');
  mkdirSync(runDir, { recursive: true });
  // cwd outside the repo: server/index.ts loads a .env from cwd, and a developer's real keys must not leak in.
  const child = spawn(process.execPath, ['--import', join(ROOT, 'tools/fake-providers.mjs'), join(ROOT, 'server/index.ts')], { cwd: runDir, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const onLine = (stream) => (chunk) => {
    for (const line of String(chunk).split('\n').filter(Boolean)) {
      logs.push({ at: Date.now(), stream, line });
      if (logs.length > 5000) logs.shift();
      if (!quiet) console.log(`[server] ${line}`);
    }
  };
  child.stdout.on('data', onLine('out'));
  child.stderr.on('data', onLine('err'));
  let exited = null;
  child.on('exit', (code, signal) => (exited = { code, signal }));

  const t0 = Date.now();
  for (;;) {
    if (exited) throw new Error(`server exited (${JSON.stringify(exited)}):\n${logs.map((l) => l.line).join('\n')}`);
    try {
      const r = await fetch(`${appUrl}/api/config`);
      if (r.ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() - t0 > 30_000) throw new Error(`server didn't answer within 30 s:\n${logs.map((l) => l.line).join('\n')}`);
    await new Promise((r) => setTimeout(r, 150));
  }

  return {
    appUrl,
    fakes,
    pid: child.pid,
    env: serverEnv,
    logs,
    get exited() {
      return exited;
    },
    /** Server log lines that look like failures, since `since` (ms). */
    errors(since = 0) {
      return logs.filter((l) => l.at >= since && (l.stream === 'err' || /failed|error|unhandled/i.test(l.line))).map((l) => l.line);
    },
    async stop() {
      if (!exited) {
        child.kill('SIGTERM');
        await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
      }
      await fakes.close();
    },
  };
}

// ─── An HTTP client that keeps cookies, like a browser on our origin ──────

export class Client {
  constructor(appUrl) {
    this.appUrl = appUrl;
    this.token = null;
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  remember(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (/max-age=0/i.test(c) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  /** A call to our API (relative path) or any absolute URL, without following redirects. */
  async raw(method, path, { body, headers = {}, token = this.token, form } = {}) {
    const url = path.startsWith('http') ? path : `${this.appUrl}${path}`;
    const h = { ...headers };
    if (token && url.startsWith(this.appUrl)) h.Authorization = `Bearer ${token}`;
    if (this.cookies.size && url.startsWith(this.appUrl)) h.Cookie = this.cookieHeader();
    let payload;
    if (form) {
      h['Content-Type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(form).toString();
    } else if (body !== undefined) {
      h['Content-Type'] = 'application/json';
      payload = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await fetch(url, { method, headers: h, body: payload, redirect: 'manual' });
    if (url.startsWith(this.appUrl)) this.remember(res);
    return res;
  }

  /** JSON in, `{ status, body, res }` out. */
  async api(method, path, opts = {}) {
    const res = await this.raw(method, path, opts);
    const text = await res.text();
    let body = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON; keep the text.
    }
    return { status: res.status, body, res };
  }
}

/** Hidden inputs and the action of the first form on a fake provider page. */
export function formOf(html, index = 0) {
  const forms = [...html.matchAll(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)];
  const f = forms[index];
  if (!f) return null;
  const fields = Object.fromEntries([...f[2].matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')]));
  return { action: f[1], fields };
}

export class Skip extends Error {
  constructor(message) {
    super(message);
    this.name = 'Skip';
  }
}

export function assert(cond, message) {
  if (!cond) throw new Error(message);
}
