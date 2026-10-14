#!/usr/bin/env node
/**
 * Sets up TinyTown's own Stripe account for billing, in one command:
 *
 *   STRIPE_SECRET_KEY=sk_test_… node tools/stripe-setup.mjs --app-url https://tinytown.example
 *
 * It creates, or finds and reuses, everything server/billing.ts needs:
 * - the "TinyTown" product (id `tinytown`);
 * - the price: $29 a year (TinyTown is sold by the year only), found by its
 *   lookup key `tinytown_yearly`. An older yearly price holding that key (the
 *   $99 one) hands it over to the new price and is otherwise left alone, as
 *   is any old $12 monthly price (`tinytown_monthly`): neither is sold any
 *   more, but anyone already on one keeps it;
 * - the webhook endpoint <app-url>/api/billing/webhook, subscribed to exactly
 *   the events the server handles;
 * - a customer portal configuration: cancel at period end, update the card,
 *   see invoices. No refunds, and no plan switching (there's one plan).
 *
 * Then it prints the environment variables to set. Running it again changes
 * nothing that's already right, so it's safe to re-run after a mistake.
 *
 * Flags:
 *   --app-url <url>   where TinyTown lives (https), the same as APP_URL
 *   --dry-run         read only: show what would be created or changed
 *   --live            allow a live key (sk_live_/rk_live_); refused without it
 *
 * Plain fetch, no dependencies. The logic is `setupStripe()`, exported for tests.
 */
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const PRODUCT = { id: 'tinytown', name: 'TinyTown', description: 'Your startup as a living city, driven by your real metrics.' };

/** What's on sale: one yearly price. Checkout shows it in local currencies itself (Adaptive Pricing, server/billing.ts). */
export const PRICES = [{ interval: 'year', lookupKey: 'tinytown_yearly', amount: 2900, currency: 'usd', nickname: 'TinyTown yearly', env: 'STRIPE_PRICE_YEARLY' }];

/** Prices TinyTown used to sell. Found and reported, never changed: anyone on one keeps it until they cancel. */
export const RETIRED_PRICES = [{ interval: 'month', lookupKey: 'tinytown_monthly', env: 'STRIPE_PRICE_MONTHLY' }];

/** Must match WEBHOOK_EVENTS in server/billing.ts (tests/server-billing-setup.test.ts checks). */
export const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.payment_action_required',
];

/** Must match STRIPE_API_VERSION in server/stripe-api.ts, so webhook payloads have the shapes the server reads. */
export const API_VERSION = '2025-03-31.basil';

export const WEBHOOK_PATH = '/api/billing/webhook';
/** Public pages (src/api/contract.ts LEGAL), shown in the portal. */
const TERMS_PATH = '/legal/terms.html';
const PRIVACY_PATH = '/legal/privacy.html';

// ─── Arguments and safety checks ──────────────────────────────────────────

export function parseArgs(argv) {
  const out = { appUrl: null, dryRun: false, live: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--live') out.live = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--app-url') out.appUrl = argv[++i] ?? null;
    else if (a.startsWith('--app-url=')) out.appUrl = a.slice('--app-url='.length);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

/** test or live, from the key's prefix. Live keys need --live, so a test run can't touch real money by accident. */
export function keyMode(key, live) {
  if (!key) throw new Error('Set STRIPE_SECRET_KEY to the secret key of TinyTown’s own Stripe account (sk_test_… to start).');
  const m = /^(sk|rk)_(test|live)_/.exec(key);
  if (!m) throw new Error('STRIPE_SECRET_KEY doesn’t look like a Stripe secret key (sk_test_… or sk_live_…).');
  if (m[2] === 'live' && !live) throw new Error('That is a live key. Run again with --live if you mean to set up live mode.');
  return m[2];
}

/** The app's address: https, no localhost (Stripe must reach it; locally, use `stripe listen` instead). */
export function checkAppUrl(raw) {
  if (!raw) throw new Error('Pass --app-url https://your-domain (the same address as APP_URL).');
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`--app-url isn’t a URL: ${raw}`);
  }
  if (u.protocol !== 'https:') throw new Error('--app-url must start with https:// (Stripe only sends webhooks to HTTPS).');
  if (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
    throw new Error('Stripe can’t reach localhost. For local testing run `stripe listen --forward-to localhost:8787/api/billing/webhook` instead.');
  }
  if (u.search || u.hash) throw new Error('--app-url should be just the address, with no ? or #.');
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}

// ─── Stripe over fetch ────────────────────────────────────────────────────

function form(params) {
  const out = new URLSearchParams();
  const walk = (prefix, v) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${prefix}[${i}]`, x));
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(`${prefix}[${k}]`, x);
    else out.append(prefix, String(v));
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out;
}

class StripeSetupError extends Error {
  constructor(status, message, code, param) {
    super(message);
    this.status = status;
    this.code = code;
    this.param = param;
  }
}

function client(key, fetchImpl, runId) {
  return async function api(method, path, params) {
    const body = params ? form(params) : undefined;
    const url = method === 'GET' && body?.size ? `https://api.stripe.com${path}?${body}` : `https://api.stripe.com${path}`;
    const headers = { Authorization: `Bearer ${key}`, 'Stripe-Version': API_VERSION };
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      // Safe to retry within this run; a later run finds what this one made by reading first.
      headers['Idempotency-Key'] = `tinytown-setup-${runId}-${createHash('sha256').update(`${method} ${path} ${body ?? ''}`).digest('hex').slice(0, 24)}`;
    }
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(url, { method, headers, ...(method !== 'GET' && body ? { body } : {}) });
      } catch (err) {
        if (attempt < 2) continue;
        throw new StripeSetupError(0, `Stripe could not be reached (${err?.message ?? 'network error'}).`);
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;
      if (attempt < 2 && (res.status === 409 || res.status === 429 || res.status >= 500)) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      throw new StripeSetupError(res.status, data?.error?.message ?? `Stripe responded ${res.status}`, data?.error?.code, data?.error?.param);
    }
  };
}

/** Every page of a list endpoint (webhook endpoints and portal configurations are short lists). */
async function listAll(api, path, params = {}) {
  const out = [];
  let after;
  for (let page = 0; page < 20; page++) {
    const res = await api('GET', path, { limit: 100, ...params, ...(after ? { starting_after: after } : {}) });
    out.push(...res.data);
    if (!res.has_more || !res.data.length) break;
    after = res.data.at(-1).id;
  }
  return out;
}

// ─── The setup ────────────────────────────────────────────────────────────

const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

export function portalParams(appUrl, productId, priceIds, { scheduleDowngrades = true } = {}) {
  return {
    business_profile: { privacy_policy_url: `${appUrl}${PRIVACY_PATH}`, terms_of_service_url: `${appUrl}${TERMS_PATH}` },
    default_return_url: `${appUrl}/`,
    features: {
      customer_update: { enabled: true, allowed_updates: ['address', 'tax_id'] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      // Cancelling keeps the plan to the end of what's paid for; nothing is refunded.
      subscription_cancel: {
        enabled: true,
        mode: 'at_period_end',
        cancellation_reason: { enabled: true, options: ['too_expensive', 'missing_features', 'switched_service', 'unused', 'other'] },
      },
      // One plan, so nothing to switch to. With two prices on sale, an upgrade happens now and charges
      // the difference, and a downgrade waits for the period to end.
      subscription_update:
        priceIds.length > 1
          ? {
              enabled: true,
              default_allowed_updates: ['price'],
              products: [{ product: productId, prices: priceIds }],
              proration_behavior: 'always_invoice',
              ...(scheduleDowngrades ? { schedule_at_period_end: { conditions: [{ type: 'shortening_interval' }, { type: 'decreasing_item_amount' }] } } : {}),
            }
          : { enabled: false },
    },
    metadata: { tinytown: '1' },
  };
}

/**
 * Does the work, or with `dryRun` only reads and says what it would do.
 * Returns `{ mode, account, steps, env, notes }` for `report()`.
 */
export async function setupStripe({ key, appUrl: rawAppUrl, dryRun = false, live = false, fetch: fetchImpl = globalThis.fetch }) {
  const mode = keyMode(key, live);
  const appUrl = checkAppUrl(rawAppUrl);
  const api = client(key, fetchImpl, randomBytes(6).toString('hex'));
  const steps = [];
  const notes = [];
  const env = {};
  const step = (thing, action, id) => steps.push({ thing, action, id });
  const would = (verb) => (dryRun ? `would ${verb}` : `${verb}d`);

  let account = null;
  try {
    const a = await api('GET', '/v1/account');
    account = { id: a.id, name: a.settings?.dashboard?.display_name ?? a.business_profile?.name ?? null, country: a.country ?? null };
  } catch {
    // A restricted key may not read the account; nothing below needs it.
  }

  // Prices first: if they exist, their product is the one to use.
  const found = (await api('GET', '/v1/prices', { lookup_keys: [...PRICES, ...RETIRED_PRICES].map((p) => p.lookupKey), limit: 10 })).data;
  const byKey = new Map(found.map((p) => [p.lookup_key, p]));
  const productOf = (p) => (typeof p.product === 'string' ? p.product : (p.product?.id ?? null));
  // A price can't be edited, so one holding our lookup key at another amount (the old $99 a year) is replaced, not changed.
  const matches = (p, want) => p.unit_amount === want.amount && p.currency === want.currency && p.recurring?.interval === want.interval;
  const ours = [...PRICES, ...RETIRED_PRICES].map((w) => byKey.get(w.lookupKey)).filter(Boolean);
  const productOfPrices = [...new Set(ours.map(productOf).filter(Boolean))];
  if (productOfPrices.length > 1) notes.push(`TinyTown's prices belong to different products (${productOfPrices.join(', ')}); the new price goes on ${productOfPrices[0]}.`);

  // The product.
  let productId = productOfPrices[0] ?? null;
  if (productId) {
    step('Product', 'reused', productId);
  } else {
    let product = await api('GET', `/v1/products/${PRODUCT.id}`).catch((err) => {
      if (err.status === 404) return null;
      throw err;
    });
    // A product made by hand in the Dashboard, following the old setup guide.
    if (!product) product = (await listAll(api, '/v1/products', { active: true })).find((p) => p.name?.trim().toLowerCase() === PRODUCT.name.toLowerCase()) ?? null;
    if (product) {
      productId = product.id;
      if (!product.active) {
        if (!dryRun) await api('POST', `/v1/products/${product.id}`, { active: true });
        step('Product', would('reactivate'), product.id);
      } else step('Product', 'reused', product.id);
    } else if (dryRun) {
      productId = PRODUCT.id;
      step('Product', 'would create', PRODUCT.id);
    } else {
      productId = (await api('POST', '/v1/products', { id: PRODUCT.id, name: PRODUCT.name, description: PRODUCT.description, metadata: { tinytown: '1' } })).id;
      step('Product', 'created', productId);
    }
  }

  // The price on sale.
  const priceIds = {};
  const usd = (cents, currency) => `${currency === 'usd' ? '$' : `${currency.toUpperCase()} `}${cents / 100}`;
  for (const want of PRICES) {
    const p = byKey.get(want.lookupKey);
    if (p && matches(p, want)) {
      if (!p.active) {
        if (!dryRun) await api('POST', `/v1/prices/${p.id}`, { active: true });
        step(`Price, ${want.interval}ly`, would('reactivate'), p.id);
      } else step(`Price, ${want.interval}ly`, 'reused', p.id);
      priceIds[want.interval] = p.id;
    } else {
      const was = p ? `${usd(p.unit_amount ?? 0, p.currency)} a ${p.recurring?.interval ?? 'one-off'}` : null;
      const taking = p ? `, taking ${want.lookupKey} from ${p.id} (${was}, kept for anyone already on it)` : '';
      if (dryRun) {
        priceIds[want.interval] = `(new ${want.lookupKey} price)`;
        step(`Price, ${want.interval}ly`, 'would create', `${want.lookupKey}: ${usd(want.amount, want.currency)} a ${want.interval}${taking}`);
      } else {
        const created = await api('POST', '/v1/prices', {
          product: productId,
          currency: want.currency,
          unit_amount: want.amount,
          recurring: { interval: want.interval },
          lookup_key: want.lookupKey,
          // Moves the lookup key off an older price in the same step, so there's never a moment without one.
          ...(p ? { transfer_lookup_key: true } : {}),
          nickname: want.nickname,
          metadata: { tinytown: '1' },
        });
        priceIds[want.interval] = created.id;
        step(`Price, ${want.interval}ly`, 'created', `${created.id}${taking}`);
      }
    }
    env[want.env] = priceIds[want.interval];
  }
  // Retired prices: reported so the owner knows they're there, never changed or sold.
  for (const old of RETIRED_PRICES) {
    const p = byKey.get(old.lookupKey);
    if (p) step(`Price, ${old.interval}ly`, 'left alone', `${p.id} (${usd(p.unit_amount ?? 0, p.currency)} a ${old.interval}, no longer sold)`);
  }
  notes.push(`TinyTown is sold by the year only: remove ${RETIRED_PRICES.map((p) => p.env).join(', ')} from the server if it's set, or that plan goes on sale too.`);

  // The webhook endpoint.
  const webhookUrl = `${appUrl}${WEBHOOK_PATH}`;
  const endpoints = await listAll(api, '/v1/webhook_endpoints');
  const endpoint = endpoints.find((e) => e.url === webhookUrl);
  if (endpoint) {
    const right = sameSet(endpoint.enabled_events ?? [], WEBHOOK_EVENTS) && endpoint.status !== 'disabled';
    if (right) step('Webhook', 'reused', endpoint.id);
    else {
      if (!dryRun) await api('POST', `/v1/webhook_endpoints/${endpoint.id}`, { enabled_events: WEBHOOK_EVENTS, disabled: false });
      step('Webhook', would('update'), `${endpoint.id} (events${endpoint.status === 'disabled' ? ', re-enabled' : ''})`);
    }
    if (endpoint.api_version && endpoint.api_version !== API_VERSION) {
      notes.push(`The webhook endpoint uses API version ${endpoint.api_version}; new endpoints use ${API_VERSION}. The server reads both, so this is fine.`);
    }
    env.STRIPE_WEBHOOK_SECRET = null;
    notes.push('The webhook already existed, so its signing secret isn’t shown again: keep the STRIPE_WEBHOOK_SECRET you saved, or reveal it in the Dashboard (Developers → Webhooks → the endpoint → Signing secret).');
  } else if (dryRun) {
    step('Webhook', 'would create', webhookUrl);
    env.STRIPE_WEBHOOK_SECRET = '(shown once, when it is created)';
  } else {
    const created = await api('POST', '/v1/webhook_endpoints', {
      url: webhookUrl,
      enabled_events: WEBHOOK_EVENTS,
      api_version: API_VERSION,
      description: 'TinyTown billing: plans and payments',
      metadata: { tinytown: '1' },
    });
    step('Webhook', 'created', `${created.id} → ${webhookUrl}`);
    env.STRIPE_WEBHOOK_SECRET = created.secret;
    notes.push('Copy STRIPE_WEBHOOK_SECRET now: Stripe shows it only this once.');
  }
  const strays = endpoints.filter((e) => e.url !== webhookUrl && e.url.endsWith(WEBHOOK_PATH) && e.status !== 'disabled');
  for (const e of strays) notes.push(`Another enabled endpoint also points at a TinyTown webhook: ${e.url} (${e.id}). Disable it if that address is old.`);

  // The customer portal.
  const configs = await listAll(api, '/v1/billing_portal/configurations');
  const config = configs.find((c) => c.metadata?.tinytown === '1');
  const priceList = PRICES.map((p) => priceIds[p.interval]);
  if (dryRun) {
    step('Customer portal', config ? 'would update' : 'would create', config?.id ?? 'cancel at period end, card, invoices');
    env.STRIPE_PORTAL_CONFIGURATION = config?.id ?? '(new bpc_ id)';
  } else {
    const save = (params) => (config ? api('POST', `/v1/billing_portal/configurations/${config.id}`, { ...params, active: true }) : api('POST', '/v1/billing_portal/configurations', params));
    let saved;
    try {
      saved = await save(portalParams(appUrl, productId, priceList));
    } catch (err) {
      // Older accounts may not offer scheduled downgrades; then a switch to monthly happens straight away.
      if (!(err instanceof StripeSetupError && err.status === 400 && /schedule_at_period_end/.test(`${err.param ?? ''} ${err.message}`))) throw err;
      saved = await save(portalParams(appUrl, productId, priceList, { scheduleDowngrades: false }));
      notes.push('This account can’t schedule plan switches for period end, so downgrades happen immediately (with a prorated credit, not a refund).');
    }
    step('Customer portal', config ? 'updated' : 'created', saved.id);
    env.STRIPE_PORTAL_CONFIGURATION = saved.id;
  }

  return { mode, account, appUrl, dryRun, steps, env, notes };
}

/** What to print: what happened, the variables to set, and the settings only the Dashboard can change. */
export function report(r) {
  const lines = [];
  const who = r.account ? ` for ${r.account.name ? `${r.account.name} (${r.account.id})` : r.account.id}` : '';
  lines.push(`TinyTown Stripe setup${who}, ${r.mode} mode${r.dryRun ? '. Dry run: nothing was changed.' : '.'}`, '');
  const w = Math.max(...r.steps.map((s) => s.thing.length));
  const a = Math.max(...r.steps.map((s) => s.action.length));
  for (const s of r.steps) lines.push(`  ${s.thing.padEnd(w)}  ${s.action.padEnd(a)}  ${s.id}`);
  lines.push('', `Set these on the server (Vercel → Settings → Environment Variables${r.mode === 'test' ? ', Preview or Development' : ', Production'}):`, '');
  lines.push(`  STRIPE_BILLING_SECRET_KEY=<the ${r.mode} secret key you ran this with>`);
  for (const [k, v] of Object.entries(r.env)) lines.push(v === null ? `  ${k}=<unchanged: keep the one you saved>` : `  ${k}=${v}`);
  if (r.notes.length) lines.push('', 'Notes:', ...r.notes.map((n) => `  - ${n}`));
  lines.push(
    '',
    'Still to do by hand in the Stripe Dashboard (the API can’t set these):',
    '  - Settings → Billing → Subscriptions and emails → Manage failed payments: turn on Smart Retries,',
    '    and after the last retry *cancel the subscription*.',
    '  - Same page: send emails about failed payments, expiring cards, and payments that need 3D Secure.',
    '  - Settings → Customer emails: successful payments (receipts) and refunds on.',
    `  - Settings → Business → Public details: Terms of service URL ${r.appUrl}${TERMS_PATH} (needed for STRIPE_TERMS_CONSENT=1),`,
    '    support email, and the statement descriptor (e.g. TINYTOWN) customers see on their card statement.',
    '  - If you charge tax: Settings → Tax: add your origin address and registrations, set the default',
    '    product tax code to a SaaS code and the default tax behaviour, then set STRIPE_AUTOMATIC_TAX=1.',
    '  - Settings → Branding: logo, icon and colours for Checkout, the portal, receipts and invoices.',
    '  - Settings → Payments → Adaptive Pricing: on, so Checkout shows the price in local currencies (the server',
    '    also asks for it on each Checkout unless STRIPE_ADAPTIVE_PRICING=0). USD must be a settlement currency.',
  );
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: STRIPE_SECRET_KEY=sk_test_… node tools/stripe-setup.mjs --app-url https://your-domain [--dry-run] [--live]');
    return;
  }
  const result = await setupStripe({ key: process.env.STRIPE_SECRET_KEY?.trim(), appUrl: args.appUrl, dryRun: args.dryRun, live: args.live });
  console.log(report(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\n${err.message}`);
    process.exit(1);
  });
}
