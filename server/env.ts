/**
 * The server's configuration, read from environment variables. Every hosted
 * feature is optional: without Supabase the app runs in local/demo mode, and
 * each provider switches on only when all of its variables are set. Values
 * here are secrets unless noted; none of them is ever sent to the browser
 * except the Supabase URL and anon key (see `/api/config`).
 */
import { createPrivateKey } from 'node:crypto';

export type Env = Record<string, string | undefined>;

function get(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

export interface Settings {
  /** Where the app lives, e.g. https://tinytown.vercel.app. OAuth redirect URIs and Stripe return URLs hang off it. */
  appUrl: string | null;
  supabase: { url: string; anonKey: string; serviceKey: string } | null;
  /**
   * TOKEN_ENCRYPTION_KEY (32 bytes, base64) and STATE_SECRET: needed by every
   * connection flow. While the key is being rotated, TOKEN_ENCRYPTION_KEY_OLD
   * still opens secrets sealed under the previous one (see docs/SECURITY.md).
   */
  secrets: { encryptionKey: string; oldEncryptionKey: string | null; stateSecret: string } | null;
  /**
   * TinyTown is sold by the year (STRIPE_PRICE_YEARLY). STRIPE_PRICE_MONTHLY is
   * optional and normally unset: when it is set, a monthly plan is on sale too.
   */
  billing: { secretKey: string; webhookSecret: string | null; prices: { month: string | null; year: string } } | null;
  stripeApp: { clientId: string; secretKey: string; installUrl: string; livemode: boolean } | null;
  githubApp: { appId: string | null; slug: string; clientId: string; clientSecret: string; privateKey: string } | null;
  posthog: { hosts: string[] };
  allowTestMode: boolean;
}

/** The Stripe mode a secret or restricted key belongs to. */
export function keyIsLive(key: string): boolean {
  return /^(sk|rk)_live_/.test(key);
}

/** Vercel gives the PEM either with real newlines, with `\n` escapes, or (our advice) base64-encoded. */
export function readPem(raw: string): string {
  let pem = raw.trim();
  if (!pem.startsWith('-----')) {
    try {
      pem = Buffer.from(pem, 'base64').toString('utf8').trim();
    } catch {
      return raw;
    }
  }
  return pem.replace(/\\n/g, '\n');
}

export function settings(env: Env): Settings {
  const supabaseUrl = get(env, 'SUPABASE_URL')?.replace(/\/+$/, '');
  const anonKey = get(env, 'SUPABASE_ANON_KEY');
  const serviceKey = get(env, 'SUPABASE_SERVICE_ROLE_KEY');
  // Vercel's own addresses (no scheme). A preview deployment returns people to
  // itself, not to production: its branch alias if it has one, else its own URL.
  const vercelUrl = get(env, 'VERCEL_ENV') === 'preview' ? (get(env, 'VERCEL_BRANCH_URL') ?? get(env, 'VERCEL_URL')) : get(env, 'VERCEL_PROJECT_PRODUCTION_URL');
  const appUrl = (get(env, 'APP_URL') ?? (vercelUrl ? `https://${vercelUrl}` : undefined))?.replace(/\/+$/, '') ?? null;

  const encryptionKey = get(env, 'TOKEN_ENCRYPTION_KEY');
  const stateSecret = get(env, 'STATE_SECRET');

  const billingKey = get(env, 'STRIPE_BILLING_SECRET_KEY');
  const monthly = get(env, 'STRIPE_PRICE_MONTHLY');
  const yearly = get(env, 'STRIPE_PRICE_YEARLY');

  const appClientId = get(env, 'STRIPE_APP_CLIENT_ID');
  // The code exchange needs the app developer account's full secret key (not
  // a restricted key). Usually that's the same account that bills, so it
  // falls back to the billing key.
  const appKey = get(env, 'STRIPE_APP_SECRET_KEY') ?? billingKey;

  const ghSlug = get(env, 'GITHUB_APP_SLUG');
  const ghClientId = get(env, 'GITHUB_APP_CLIENT_ID');
  const ghClientSecret = get(env, 'GITHUB_APP_CLIENT_SECRET');
  const ghKey = get(env, 'GITHUB_APP_PRIVATE_KEY');

  const secrets = encryptionKey && stateSecret ? { encryptionKey, oldEncryptionKey: get(env, 'TOKEN_ENCRYPTION_KEY_OLD') ?? null, stateSecret } : null;
  return {
    appUrl,
    supabase: supabaseUrl && anonKey && serviceKey ? { url: supabaseUrl, anonKey, serviceKey } : null,
    secrets,
    billing: billingKey && yearly ? { secretKey: billingKey, webhookSecret: get(env, 'STRIPE_WEBHOOK_SECRET') ?? null, prices: { month: monthly ?? null, year: yearly } } : null,
    stripeApp:
      appClientId && appKey && secrets
        ? {
            clientId: appClientId,
            secretKey: appKey,
            installUrl: get(env, 'STRIPE_APP_INSTALL_URL') ?? 'https://marketplace.stripe.com/oauth/v2/authorize',
            livemode: keyIsLive(appKey),
          }
        : null,
    githubApp:
      ghSlug && ghClientId && ghClientSecret && ghKey && secrets
        ? { appId: get(env, 'GITHUB_APP_ID') ?? null, slug: ghSlug, clientId: ghClientId, clientSecret: ghClientSecret, privateKey: readPem(ghKey) }
        : null,
    posthog: {
      hosts: (get(env, 'POSTHOG_HOSTS') ?? 'us.posthog.com,eu.posthog.com')
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    },
    allowTestMode: get(env, 'ALLOW_TEST_MODE') === '1',
  };
}

/** Every key that may open a stored secret, current first. New secrets are always sealed with the current one. */
export function decryptionKeys(secrets: NonNullable<Settings['secrets']>): string[] {
  return secrets.oldEncryptionKey ? [secrets.encryptionKey, secrets.oldEncryptionKey] : [secrets.encryptionKey];
}

// ─── Checking the configuration at boot ───────────────────────────────────

export interface EnvProblem {
  /** `error`: a feature is half set up and would fail in a way founders feel (or pay for). `warning`: worth a look. */
  level: 'error' | 'warning';
  message: string;
}

/** The variables each hosted feature needs all of. Setting some but not all is always a mistake. */
const GROUPS: { name: string; vars: string[] }[] = [
  { name: 'Supabase (accounts)', vars: ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] },
  { name: 'Secrets for connections', vars: ['TOKEN_ENCRYPTION_KEY', 'STATE_SECRET'] },
  // STRIPE_PRICE_MONTHLY isn't in the group: TinyTown is sold by the year, and a monthly price is optional.
  { name: 'Billing', vars: ['STRIPE_BILLING_SECRET_KEY', 'STRIPE_PRICE_YEARLY', 'STRIPE_WEBHOOK_SECRET'] },
  { name: 'The GitHub App', vars: ['GITHUB_APP_SLUG', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_PRIVATE_KEY'] },
];

const isLocal = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

function aesKeyProblem(name: string, value: string): EnvProblem | null {
  const ok = /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, 'base64').length === 32;
  return ok ? null : { level: 'error', message: `${name} must be 32 random bytes, base64-encoded (make one with \`openssl rand -base64 32\`).` };
}

/**
 * Half-finished configuration, explained. A billing key without its webhook
 * secret, say, takes founders' money and never records that they paid. The
 * Vercel build refuses to ship with errors (server/build-vercel.mjs) and the
 * function logs everything once when it starts. Messages name variables,
 * never their values.
 */
export function checkEnv(env: Env): EnvProblem[] {
  const out: EnvProblem[] = [];
  const error = (message: string) => out.push({ level: 'error', message });
  const warn = (message: string) => out.push({ level: 'warning', message });
  const has = (name: string) => get(env, name) !== undefined;

  for (const g of GROUPS) {
    const set = g.vars.filter(has);
    if (set.length && set.length < g.vars.length) {
      const missing = g.vars.filter((v) => !has(v));
      error(`${g.name} is half set up: ${set.join(', ')} ${set.length === 1 ? 'is' : 'are'} set but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing.`);
    }
  }
  if (has('STRIPE_BILLING_SECRET_KEY') && !has('STRIPE_WEBHOOK_SECRET')) {
    // Already in the group message; said plainly because it's the one that costs money.
    error('Without STRIPE_WEBHOOK_SECRET, people could pay and never get in: the webhook is how TinyTown learns about a payment.');
  }

  const s = settings(env);
  const hostedVars = ['STRIPE_BILLING_SECRET_KEY', 'STRIPE_APP_CLIENT_ID', 'GITHUB_APP_SLUG', 'TOKEN_ENCRYPTION_KEY'].filter(has);
  if (!s.supabase && hostedVars.length) {
    error(`${hostedVars.join(', ')} ${hostedVars.length === 1 ? 'is' : 'are'} set, but hosted features need Supabase first (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY).`);
  }

  const supabaseUrl = get(env, 'SUPABASE_URL');
  if (supabaseUrl) {
    try {
      const u = new URL(supabaseUrl);
      if (u.protocol !== 'https:' && !isLocal(u.hostname)) error('SUPABASE_URL must be an https:// address.');
      if (u.pathname.replace(/\/+$/, '') !== '') error('SUPABASE_URL is the project URL alone, like https://abcd.supabase.co (no path).');
    } catch {
      error('SUPABASE_URL is not a URL. Copy the Project URL from Supabase → Project Settings → Data API.');
    }
  }
  const service = get(env, 'SUPABASE_SERVICE_ROLE_KEY');
  if (service && (service === get(env, 'SUPABASE_ANON_KEY') || service.startsWith('sb_publishable_'))) {
    error('SUPABASE_SERVICE_ROLE_KEY holds the public key. Use the secret (service_role) key from Supabase → Project Settings → API Keys.');
  }
  const anon = get(env, 'SUPABASE_ANON_KEY');
  if (anon?.startsWith('sb_secret_')) error('SUPABASE_ANON_KEY holds a secret key, and it is sent to every browser. Use the publishable (anon) key, and roll the secret one now.');

  for (const name of ['TOKEN_ENCRYPTION_KEY', 'TOKEN_ENCRYPTION_KEY_OLD']) {
    const v = get(env, name);
    const p = v && aesKeyProblem(name, v);
    if (p) out.push(p);
  }
  if (has('TOKEN_ENCRYPTION_KEY_OLD') && get(env, 'TOKEN_ENCRYPTION_KEY_OLD') === get(env, 'TOKEN_ENCRYPTION_KEY')) {
    warn('TOKEN_ENCRYPTION_KEY_OLD is the same as TOKEN_ENCRYPTION_KEY: nothing is being rotated, so remove it.');
  }
  const state = get(env, 'STATE_SECRET');
  if (state && state.length < 32) warn('STATE_SECRET is short. Use `openssl rand -base64 32`.');

  if (s.supabase && !s.appUrl) warn('APP_URL is not set, so Stripe and OAuth return addresses fall back to the request host. Set it to the site address.');
  if (s.appUrl) {
    try {
      const u = new URL(s.appUrl);
      if (u.protocol !== 'https:' && !isLocal(u.hostname)) error('APP_URL must be an https:// address (http is only for localhost).');
      if (u.pathname !== '/' || u.search || u.hash) error('APP_URL is the site address alone, like https://tinytown.app (no path).');
    } catch {
      error('APP_URL is not a URL.');
    }
  }

  const billingKey = get(env, 'STRIPE_BILLING_SECRET_KEY');
  if (billingKey && !/^(sk|rk)_(live|test)_/.test(billingKey)) error('STRIPE_BILLING_SECRET_KEY should start with sk_live_, sk_test_, rk_live_ or rk_test_.');
  const whsec = get(env, 'STRIPE_WEBHOOK_SECRET');
  if (whsec && !whsec.startsWith('whsec_')) error("STRIPE_WEBHOOK_SECRET should start with whsec_ (it's the endpoint's signing secret, not an API key).");
  for (const name of ['STRIPE_PRICE_MONTHLY', 'STRIPE_PRICE_YEARLY']) {
    const v = get(env, name);
    if (v && !v.startsWith('price_')) error(`${name} should be a price id (price_…), not a product id or an amount.`);
  }
  if (s.billing?.prices.month) warn('STRIPE_PRICE_MONTHLY is set, so a monthly plan is on sale next to the yearly one. TinyTown is sold by the year: unset it unless you mean to sell monthly.');
  if (has('STRIPE_APP_CLIENT_ID') && !s.stripeApp) error('STRIPE_APP_CLIENT_ID is set, but connecting Stripe also needs TOKEN_ENCRYPTION_KEY, STATE_SECRET and a secret key.');
  const appKey = get(env, 'STRIPE_APP_SECRET_KEY');
  if (appKey && !/^sk_(live|test)_/.test(appKey)) error('STRIPE_APP_SECRET_KEY must be a full secret key (sk_…): Stripe refuses restricted keys for the OAuth code exchange.');

  const production = get(env, 'VERCEL_ENV') === 'production';
  if (production && billingKey && !keyIsLive(billingKey)) warn('Production is billing with a Stripe test key: nobody is really paying.');
  if (production && s.allowTestMode) warn('ALLOW_TEST_MODE=1 in production lets test-mode Stripe data drive real cities.');
  if (billingKey && s.stripeApp && keyIsLive(billingKey) !== s.stripeApp.livemode) {
    warn('The billing key and the Stripe App key are in different modes (one live, one test).');
  }

  const ghKey = get(env, 'GITHUB_APP_PRIVATE_KEY');
  if (ghKey) {
    try {
      createPrivateKey(readPem(ghKey));
    } catch {
      error('GITHUB_APP_PRIVATE_KEY is not a readable private key. Base64-encode the .pem file on one line (see docs/SETUP.md, section 4).');
    }
  }
  if (has('GITHUB_APP_SLUG') && !has('GITHUB_APP_ID')) warn('GITHUB_APP_ID is not set; the GitHub App falls back to its client ID as the token issuer.');

  if (s.supabase && get(env, 'VERCEL') === '1') {
    const cron = get(env, 'CRON_SECRET');
    if (!cron) warn('CRON_SECRET is not set, so the scheduled jobs (/api/cron/*) will refuse Vercel Cron.');
    else if (cron.length < 16) warn('CRON_SECRET is short. Use at least 16 random characters (`openssl rand -hex 32`).');
  }
  const access = get(env, 'ACCESS_MODE');
  if (access && access !== 'open' && access !== 'waitlist') error('ACCESS_MODE is either open or waitlist.');

  const hosts = get(env, 'POSTHOG_HOSTS');
  if (hosts) {
    for (const h of s.posthog.hosts) {
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) || /^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(h)) {
        error(`POSTHOG_HOSTS lists "${h}": only public host names (no scheme, port or private address) belong there.`);
      }
    }
  }
  return out;
}

/** Logs every problem: errors as errors, the rest as warnings. */
export function reportEnv(env: Env, log: Pick<Console, 'error' | 'warn'> = console): EnvProblem[] {
  const problems = checkEnv(env);
  for (const p of problems) (p.level === 'error' ? log.error : log.warn)(`config ${p.level}: ${p.message}`);
  return problems;
}
