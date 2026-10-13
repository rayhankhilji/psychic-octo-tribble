/**
 * The server's configuration, read from environment variables. Every hosted
 * feature is optional: without Supabase the app runs in local/demo mode, and
 * each provider switches on only when all of its variables are set. Values
 * here are secrets unless noted; none of them is ever sent to the browser
 * except the Supabase URL and anon key (see `/api/config`).
 */
export type Env = Record<string, string | undefined>;

function get(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

export interface Settings {
  /** Where the app lives, e.g. https://tinytown.vercel.app. OAuth redirect URIs and Stripe return URLs hang off it. */
  appUrl: string | null;
  supabase: { url: string; anonKey: string; serviceKey: string } | null;
  /** TOKEN_ENCRYPTION_KEY (32 bytes, base64) and STATE_SECRET: needed by every connection flow. */
  secrets: { encryptionKey: string; stateSecret: string } | null;
  billing: { secretKey: string; webhookSecret: string | null; prices: { month: string; year: string } } | null;
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
  const vercelUrl = get(env, 'VERCEL_PROJECT_PRODUCTION_URL');
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

  const secrets = encryptionKey && stateSecret ? { encryptionKey, stateSecret } : null;
  return {
    appUrl,
    supabase: supabaseUrl && anonKey && serviceKey ? { url: supabaseUrl, anonKey, serviceKey } : null,
    secrets,
    billing: billingKey && monthly && yearly ? { secretKey: billingKey, webhookSecret: get(env, 'STRIPE_WEBHOOK_SECRET') ?? null, prices: { month: monthly, year: yearly } } : null,
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
