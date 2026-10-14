#!/usr/bin/env node
/**
 * Fake providers for local end-to-end and load runs: one HTTP server that
 * impersonates just enough of Supabase (Auth and PostgREST), Stripe (our
 * billing account, Checkout, the portal, webhooks, and the Stripe App's
 * OAuth with rolling refresh tokens), GitHub (the App, installations,
 * repositories, commits and releases) and PostHog for the real
 * `server/index.ts` to run every hosted flow with no network and no keys.
 *
 * Three ways in:
 *
 *   node tools/fake-providers.mjs [--port 8790] [--app http://127.0.0.1:8787]
 *     Runs the fakes on their own. Prints the env the server needs.
 *
 *   FAKE_PROVIDERS_URL=http://127.0.0.1:8790 node --import ./tools/fake-providers.mjs server/index.ts
 *     As a preload: rewrites the server's fetch calls to api.stripe.com,
 *     api.github.com, github.com and PostHog Cloud onto the fakes. Every
 *     other outside host goes to a sink that records it and answers `{}`,
 *     so a local run can never reach a real provider.
 *
 *   import { startFakes } from './fake-providers.mjs'
 *     In-process, for tools/e2e.mjs and tools/loadtest.mjs, which also read
 *     the fakes' state (the mailbox, the tables, call counts) directly.
 *
 * PostgREST tables come from supabase/migrations/*.sql: columns, defaults,
 * primary keys, unique columns, foreign keys to auth.users and the
 * "skip rows of deleted users" triggers. Unknown tables and columns fail the
 * way PostgREST does (404 PGRST205, 400 PGRST204/42703), so a query against
 * a table no migration creates shows up here rather than in production.
 *
 * Nothing in here is secret: every key, token and code is made up per run.
 */
import { createHmac, createHash, randomBytes, randomUUID, createVerify, createPublicKey } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86_400_000;

// ─── Fetch rewriting (the preload) ────────────────────────────────────────

/** Provider origins and where they live on the fake server. */
export const REWRITES = [
  ['https://api.stripe.com', '/stripe'],
  ['https://api.github.com', '/github-api'],
  ['https://github.com', '/github'],
  ['https://us.posthog.com', '/posthog'],
  ['https://eu.posthog.com', '/posthog'],
  ['https://marketplace.stripe.com', '/stripe-pages'],
];

const isLocalHost = (h) => h === '127.0.0.1' || h === 'localhost' || h === '[::1]';

/** The fake URL for a provider URL; unknown outside hosts go to the sink. Local URLs pass through. */
export function rewriteUrl(href, base) {
  const u = new URL(href);
  if (isLocalHost(u.hostname)) return href;
  for (const [origin, prefix] of REWRITES) {
    if (u.origin === origin) return `${base}${prefix}${u.pathname}${u.search}`;
  }
  return `${base}/__sink/${u.host}${u.pathname}${u.search}`;
}

/** Replaces global fetch so every outside call lands on the fakes. */
export function installFetchInterceptor(base) {
  const real = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    if (input instanceof Request) {
      const to = rewriteUrl(input.url, base);
      return real(to === input.url ? input : new Request(to, input), init);
    }
    return real(rewriteUrl(String(input), base), init);
  };
  return () => (globalThis.fetch = real);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (!isMain && process.env.FAKE_PROVIDERS_URL) installFetchInterceptor(process.env.FAKE_PROVIDERS_URL.replace(/\/+$/, ''));

// ─── Small helpers ────────────────────────────────────────────────────────

const id = (prefix, bytes = 12) => `${prefix}${randomBytes(bytes).toString('hex').slice(0, bytes * 2)}`;
const nowS = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** A deterministic PRNG (mulberry32), so a fake Stripe account has the same history every run. */
export function prng(seed) {
  let a = typeof seed === 'number' ? seed >>> 0 : [...createHash('sha256').update(String(seed)).digest()].slice(0, 4).reduce((s, b) => (s << 8) | b, 0) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Stripe's form encoding back into objects: `line_items[0][price]=p` → `{ line_items: [{ price: 'p' }] }`. */
export function parseStripeForm(text) {
  const out = {};
  for (const [key, value] of new URLSearchParams(text)) {
    const parts = key.split(/\[|\]\[|\]/).filter((p) => p !== '');
    let node = out;
    parts.forEach((p, i) => {
      const last = i === parts.length - 1;
      const nextIsIndex = !last && /^\d+$/.test(parts[i + 1]);
      if (last) node[p] = value;
      else node = node[p] ??= nextIsIndex ? [] : {};
    });
  }
  return out;
}

// ─── The schema, read from the migrations ─────────────────────────────────

/** Splits on commas that aren't inside parentheses or quotes. */
function splitTop(s) {
  const out = [];
  let depth = 0;
  let quote = false;
  let cur = '';
  for (const ch of s) {
    if (ch === "'") quote = !quote;
    if (!quote && ch === '(') depth++;
    if (!quote && ch === ')') depth--;
    if (!quote && depth === 0 && ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The text inside the parenthesis that opens at `start`. */
function balanced(s, start) {
  let depth = 0;
  let quote = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") quote = !quote;
    if (quote) continue;
    if (ch === '(') depth++;
    if (ch === ')' && --depth === 0) return { inner: s.slice(start + 1, i), end: i };
  }
  return { inner: s.slice(start + 1), end: s.length };
}

const KEYWORDS = /\s+(not\s+null|null|check|references|primary\s+key|unique|generated|constraint|collate)\b/i;

/** A column default as a function that makes the value. */
function defaultFn(expr) {
  const e = expr.trim().replace(/^\((.*)\)$/s, '$1').trim();
  if (/^(now\(\)|current_timestamp|timezone\()/i.test(e)) return () => new Date().toISOString();
  if (/gen_random_uuid\(\)|uuid_generate_v4\(\)/i.test(e)) return () => randomUUID();
  if (/random\(\)/i.test(e)) return () => 1 + Math.floor(Math.random() * 2147483646);
  if (/^(true|false)$/i.test(e)) return () => e.toLowerCase() === 'true';
  if (/^-?\d+(\.\d+)?$/.test(e)) return () => Number(e);
  if (/^array\[\]/i.test(e)) return () => [];
  const lit = /^'((?:[^']|'')*)'(::[\w\[\]]+)?$/s.exec(e);
  if (lit) {
    const text = lit[1].replace(/''/g, "'");
    const type = (lit[2] ?? '').toLowerCase();
    if (text === 'epoch') return () => new Date(0).toISOString();
    if (type.startsWith('::json')) return () => JSON.parse(text);
    if (type.endsWith('[]')) return () => (text === '{}' ? [] : text.replace(/^\{|\}$/g, '').split(','));
    return () => text;
  }
  return () => null;
}

function parseColumn(def) {
  const m = /^"?(\w+)"?\s+(.+)$/s.exec(def);
  if (!m) return null;
  const [, name, rest] = m;
  const col = { name, type: rest.split(/\s+/)[0].toLowerCase(), notNull: /not\s+null/i.test(rest) || /primary\s+key/i.test(rest), default: null, identity: false, references: null };
  if (/generated\s+(always|by\s+default)\s+as\s+identity/i.test(rest) || /^(big)?serial/i.test(col.type)) col.identity = true;
  const d = /\bdefault\s+/i.exec(rest);
  if (d) {
    // The default runs until the next column keyword at the top level.
    const tail = rest.slice(d.index + d[0].length);
    let depth = 0;
    let quote = false;
    let cut = tail.length;
    for (let i = 0; i < tail.length; i++) {
      const ch = tail[i];
      if (ch === "'") quote = !quote;
      if (quote) continue;
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (depth === 0 && KEYWORDS.test(tail.slice(i)) && KEYWORDS.exec(tail.slice(i)).index === 0) {
        cut = i;
        break;
      }
    }
    col.default = defaultFn(tail.slice(0, cut));
  }
  const ref = /references\s+(?:(\w+)\.)?(\w+)\s*\((\w+)\)(?:\s+on\s+delete\s+(cascade|set\s+null|restrict|no\s+action))?/i.exec(rest);
  if (ref) col.references = { schema: ref[1] ?? 'public', table: ref[2], column: ref[3], onDelete: (ref[4] ?? 'no action').toLowerCase().replace(/\s+/, ' ') };
  return { col, pk: /primary\s+key/i.test(rest), unique: /\bunique\b/i.test(rest) };
}

/** Tables, columns, keys and triggers from a set of migrations, in order. */
export function parseSchema(sql) {
  const tables = {};
  const functions = new Set();
  const skipFunctions = new Set();
  // Function bodies first: they hold SQL we mustn't read as DDL.
  sql = sql.replace(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?(\w+)[\s\S]*?\$(\w*)\$([\s\S]*?)\$\2\$/gi, (all, name, _tag, body) => {
    functions.add(name);
    if (/auth\.users/i.test(body) && /return\s+null/i.test(body)) skipFunctions.add(name);
    return `/*function ${name}*/`;
  });
  sql = sql.replace(/--[^\n]*/g, '');

  const ensure = (name) => (tables[name] ??= { name, columns: {}, pk: [], uniques: [], skipDeleted: false });
  const addItem = (t, item) => {
    const lower = item.toLowerCase();
    const pk = /^(?:constraint\s+\w+\s+)?primary\s+key\s*\(([^)]+)\)/i.exec(item);
    if (pk) return void (t.pk = pk[1].split(',').map((c) => c.trim()));
    const uq = /^(?:constraint\s+\w+\s+)?unique\s*\(([^)]+)\)/i.exec(item);
    if (uq) return void t.uniques.push(uq[1].split(',').map((c) => c.trim()));
    if (/^(constraint|check|foreign\s+key|exclude)\b/.test(lower)) return;
    const parsed = parseColumn(item);
    if (!parsed) return;
    t.columns[parsed.col.name] = parsed.col;
    if (parsed.pk) t.pk = [parsed.col.name];
    if (parsed.unique) t.uniques.push([parsed.col.name]);
  };

  const create = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?(\w+)"?\s*\(/gi;
  for (let m; (m = create.exec(sql)); ) {
    const t = ensure(m[1]);
    const { inner } = balanced(sql, m.index + m[0].length - 1);
    for (const item of splitTop(inner)) addItem(t, item);
  }
  const alter = /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?"?(\w+)"?\s+([\s\S]*?);/gi;
  for (let m; (m = alter.exec(sql)); ) {
    const t = tables[m[1]];
    if (!t) continue;
    for (const action of splitTop(m[2])) {
      const add = /^add\s+column\s+(?:if\s+not\s+exists\s+)?([\s\S]+)$/i.exec(action);
      if (add) addItem(t, add[1]);
      const con = /^add\s+(constraint\s+\w+\s+)?((?:primary\s+key|unique)\s*\([^)]+\))/i.exec(action);
      if (con) addItem(t, con[2]);
      const drop = /^drop\s+column\s+(?:if\s+exists\s+)?"?(\w+)"?/i.exec(action);
      if (drop) delete t.columns[drop[1]];
    }
  }
  const uidx = /create\s+unique\s+index\s+(?:if\s+not\s+exists\s+)?\w+\s+on\s+(?:public\.)?(\w+)\s*(?:using\s+\w+\s*)?\(([^)]+)\)([^;]*);/gi;
  for (let m; (m = uidx.exec(sql)); ) if (tables[m[1]] && !/where/i.test(m[3])) tables[m[1]].uniques.push(m[2].split(',').map((c) => c.trim()));
  const trig = /create\s+trigger\s+\w+\s+before\s+insert[\s\S]*?on\s+(?:public\.)?(\w+)[\s\S]*?execute\s+(?:function|procedure)\s+(?:public\.)?(\w+)/gi;
  for (let m; (m = trig.exec(sql)); ) if (tables[m[1]] && skipFunctions.has(m[2])) tables[m[1]].skipDeleted = true;
  return { tables, functions };
}

export function loadSchema(dir = join(ROOT, 'supabase/migrations')) {
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    // No migrations: every table is unknown.
  }
  return { ...parseSchema(files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n;\n')), files };
}

// ─── PostgREST filters ────────────────────────────────────────────────────

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns', 'or', 'and']);

function coerce(raw, sample) {
  if (raw === 'null') return null;
  if (typeof sample === 'number') return Number(raw);
  if (typeof sample === 'boolean') return raw === 'true';
  return raw;
}

function cmp(a, b) {
  if (typeof a === 'string' && typeof b === 'string' && /^\d{4}-\d\d-\d\d/.test(a) && /^\d{4}-\d\d-\d\d/.test(b)) return Date.parse(a) - Date.parse(b);
  if (typeof a === 'number' || typeof b === 'number') return Number(a) - Number(b);
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/** `in.(a,"b c")` → ['a', 'b c'] */
function listOf(s) {
  const inner = s.replace(/^\(|\)$/g, '');
  return splitTop(inner).map((v) => v.replace(/^"(.*)"$/, '$1'));
}

function likeToRegex(pattern, flags) {
  const re = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[*%]/g, '.*');
  return new RegExp(`^${re}$`, flags);
}

/** One `op.value` test against a row's value. */
function test(value, expr) {
  const neg = expr.startsWith('not.');
  if (neg) expr = expr.slice(4);
  const dot = expr.indexOf('.');
  const op = expr.slice(0, dot);
  const raw = expr.slice(dot + 1);
  let ok;
  switch (op) {
    case 'eq':
      ok = value != null && (String(value) === String(coerce(raw, value)) || (/^\d{4}-\d\d-\d\d/.test(String(value)) && cmp(String(value), raw) === 0));
      break;
    case 'neq':
      ok = value !== null && value !== undefined && String(value) !== String(coerce(raw, value));
      break;
    case 'gt':
      ok = value != null && cmp(value, coerce(raw, value)) > 0;
      break;
    case 'gte':
      ok = value != null && cmp(value, coerce(raw, value)) >= 0;
      break;
    case 'lt':
      ok = value != null && cmp(value, coerce(raw, value)) < 0;
      break;
    case 'lte':
      ok = value != null && cmp(value, coerce(raw, value)) <= 0;
      break;
    case 'like':
      ok = value != null && likeToRegex(raw, '').test(String(value));
      break;
    case 'ilike':
      ok = value != null && likeToRegex(raw, 'i').test(String(value));
      break;
    case 'is':
      ok = raw === 'null' ? value == null : raw === 'true' ? value === true : raw === 'false' ? value === false : false;
      break;
    case 'in':
      ok = value != null && listOf(raw).some((v) => String(coerce(v, value)) === String(value));
      break;
    case 'cs': {
      const want = raw.startsWith('[') || raw.startsWith('{"') ? JSON.parse(raw) : listOf(raw.replace(/^\{|\}$/g, ''));
      ok = Array.isArray(value) ? (Array.isArray(want) ? want : [want]).every((w) => value.some((v) => JSON.stringify(v) === JSON.stringify(w) || String(v) === String(w))) : value && typeof value === 'object' && Object.entries(want).every(([k, v]) => JSON.stringify(value[k]) === JSON.stringify(v));
      break;
    }
    default:
      throw pgError(400, 'PGRST100', `"${op}" is not an operator the fake PostgREST knows`);
  }
  return neg ? !ok : ok;
}

/** `or=(a.eq.1,b.is.null)` */
function logic(kind, expr) {
  const parts = splitTop(expr.replace(/^\(|\)$/g, ''));
  const preds = parts.map((p) => {
    const nested = /^(or|and)(\(.*\))$/.exec(p);
    if (nested) return logic(nested[1], nested[2]);
    const dot = p.indexOf('.');
    const col = p.slice(0, dot);
    const rest = p.slice(dot + 1);
    return (row) => test(row[col], rest);
  });
  return kind === 'or' ? (row) => preds.some((f) => f(row)) : (row) => preds.every((f) => f(row));
}

class PgError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;
    this.body = { code, details, hint: null, message };
  }
}
const pgError = (status, code, message, details) => new PgError(status, code, message, details);

// ─── Founder data: deterministic Stripe and GitHub histories ──────────────

/** A believable subscription history for a founder's Stripe account: steady growth, some churn. */
export function founderSubscriptions(account, { count = 90, days = 420, now = Date.now() } = {}) {
  const rnd = prng(account);
  const prices = [1900, 2900, 2900, 4900, 4900, 9900];
  const subs = [];
  for (let i = 0; i < count; i++) {
    // More customers recently: growth.
    const age = Math.floor(days * Math.sqrt(rnd()));
    const start = Math.floor((now - age * DAY) / 1000) - Math.floor(rnd() * 86_400);
    const churned = rnd() < 0.22 && age > 30;
    const ended = churned ? start + Math.floor((0.2 + rnd() * 0.7) * age * 86_400) : null;
    const yearly = rnd() < 0.12;
    const unit = yearly ? prices[Math.floor(rnd() * prices.length)] * 10 : prices[Math.floor(rnd() * prices.length)];
    subs.push({
      id: `sub_f${createHash('sha1').update(`${account}:${i}`).digest('hex').slice(0, 14)}`,
      object: 'subscription',
      customer: `cus_f${createHash('sha1').update(`${account}:c${i}`).digest('hex').slice(0, 14)}`,
      status: churned ? 'canceled' : 'active',
      start_date: start,
      created: start,
      ended_at: ended,
      trial_end: null,
      currency: 'usd',
      livemode: false,
      items: { object: 'list', data: [{ id: `si_f${i}`, quantity: 1, price: { id: yearly ? 'price_f_year' : 'price_f_month', unit_amount: unit, currency: 'usd', recurring: { interval: yearly ? 'year' : 'month', interval_count: 1 } } }] },
    });
  }
  // Newest first, like Stripe's list.
  return subs.sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1));
}

export function founderCommits(repo, { days = 300, now = Date.now() } = {}) {
  const rnd = prng(`commits:${repo}`);
  const out = [];
  for (let d = 0; d < days; d++) {
    const day = now - d * DAY;
    const weekend = [0, 6].includes(new Date(day).getUTCDay());
    const n = Math.floor(rnd() * (weekend ? 2 : 7));
    for (let k = 0; k < n; k++) {
      const date = new Date(day - Math.floor(rnd() * 36_000_000)).toISOString().replace(/\.\d+Z$/, 'Z');
      out.push({ sha: createHash('sha1').update(`${repo}:${d}:${k}`).digest('hex'), commit: { message: `Change ${d}.${k}`, author: { name: 'Founder', date }, committer: { name: 'Founder', date } } });
    }
  }
  return out;
}

export function founderReleases(repo, { days = 300, now = Date.now() } = {}) {
  const rnd = prng(`releases:${repo}`);
  const out = [];
  let minor = 0;
  for (let d = days; d > 0; d -= 12 + Math.floor(rnd() * 14)) {
    minor++;
    out.push({ id: minor, tag_name: `v0.${minor}.0`, name: `v0.${minor}`, draft: false, prerelease: false, published_at: new Date(now - d * DAY).toISOString().replace(/\.\d+Z$/, 'Z') });
  }
  return out.reverse();
}

// ─── The fake server ──────────────────────────────────────────────────────

/**
 * Starts the fakes. Options:
 * - `port` (0 = any free port), `host`
 * - `appUrl`: where our server lives (the GitHub App's callback and Stripe's webhook hang off it)
 * - `webhookSecret`: STRIPE_WEBHOOK_SECRET, to sign webhook deliveries
 * - `anonKey`, `serviceKey`: what Supabase accepts
 * - `prices`: `{ price_month: { amount: 1200, interval: 'month' }, … }`
 * - `latency`: ms per service, `{ auth, rest, stripe, github, posthog }`, to imitate real round trips
 * - `githubPublicKey`: PEM; when given, App JWTs are signature-checked
 * - `founderSubs`: subscriptions per founder Stripe account (default 90)
 * - `log`: print each request
 */
export async function startFakes(opts = {}) {
  const schema = opts.schema ?? loadSchema(opts.migrationsDir);
  const anonKey = opts.anonKey ?? 'fake-anon-key';
  const serviceKey = opts.serviceKey ?? 'fake-service-role-key';
  const latency = { auth: 0, rest: 0, stripe: 0, github: 0, posthog: 0, ...(opts.latency ?? {}) };
  const prices = opts.prices ?? { price_month: { amount: 1200, interval: 'month' }, price_year: { amount: 9900, interval: 'year' } };

  const state = {
    appUrl: opts.appUrl ?? null,
    webhookSecret: opts.webhookSecret ?? null,
    auth: { users: new Map(), byEmail: new Map(), sessions: new Map(), refresh: new Map(), otps: new Map() },
    mailbox: [],
    tables: Object.fromEntries(Object.keys(schema.tables).map((t) => [t, []])),
    identity: {},
    rpc: new Map(),
    stripe: {
      customers: new Map(),
      sessions: new Map(),
      subscriptions: new Map(),
      portal: new Map(),
      idempotency: new Map(),
      events: [],
      deliveries: [],
      /** acct → { livemode, name, subs } */
      accounts: new Map(),
      codes: new Map(),
      refreshTokens: new Map(),
      accessTokens: new Map(),
      spentRefreshTokens: new Set(),
      prices: new Map(Object.entries(prices).map(([pid, p]) => [pid, { id: pid, object: 'price', active: true, unit_amount: p.amount, currency: p.currency ?? 'usd', recurring: { interval: p.interval, interval_count: 1 }, product: 'prod_tinytown', livemode: false }])),
    },
    github: { installations: new Map(), codes: new Map(), userTokens: new Map(), instTokens: new Map(), nextInstallation: 4_242_001 },
    sink: [],
    unhandled: [],
    calls: new Map(),
    perSecond: new Map(),
  };

  // ── Bookkeeping ─────────────────────────────────────────────────────────

  const routeKey = (service, method, path) =>
    `${service} ${method} ${path
      .replace(/\/(cus|sub|cs|bps|evt|acct|si|in)_\w+/g, '/:id')
      .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/g, '/:id')
      .replace(/\/\d+(?=\/|$)/g, '/:n')
      .replace(/(\/repos\/)[^/]+\/[^/]+/, '$1:owner/:repo')
      .replace(/(\/apps\/)[^/]+/, '$1:slug')}`;

  function count(service, method, path) {
    const key = routeKey(service, method, path);
    state.calls.set(key, (state.calls.get(key) ?? 0) + 1);
    const sec = nowS();
    const bucket = (state.perSecond.get(service) ?? state.perSecond.set(service, new Map()).get(service));
    bucket.set(sec, (bucket.get(sec) ?? 0) + 1);
  }

  function unhandled(service, method, path, why = 'not implemented') {
    state.unhandled.push({ service, method, path, why, at: Date.now() });
    if (opts.log !== false) console.warn(`[fakes] unhandled ${service} ${method} ${path}: ${why}`);
  }

  /** Requests per service: total, peak and mean per second over the busy window. */
  function stats() {
    const out = {};
    for (const [service, bucket] of state.perSecond) {
      const secs = [...bucket.keys()];
      const total = [...bucket.values()].reduce((a, b) => a + b, 0);
      const span = secs.length ? Math.max(...secs) - Math.min(...secs) + 1 : 1;
      out[service] = { total, peakPerSecond: Math.max(0, ...bucket.values()), meanPerSecond: +(total / span).toFixed(1) };
    }
    return { services: out, routes: Object.fromEntries([...state.calls].sort((a, b) => b[1] - a[1])), unhandled: state.unhandled.slice(-50), sink: state.sink.slice(-50) };
  }

  function resetStats() {
    state.calls.clear();
    state.perSecond.clear();
    state.unhandled.length = 0;
  }

  // ── Responses ───────────────────────────────────────────────────────────

  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Expose-Headers': 'Content-Range, X-Total-Count, Link',
  };

  function send(res, status, body, headers = {}) {
    const isJson = body !== null && body !== undefined && typeof body !== 'string';
    res.writeHead(status, { ...CORS, ...(isJson ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), ...headers });
    res.end(body === null || body === undefined ? undefined : isJson ? JSON.stringify(body) : body);
  }
  const html = (res, body, status = 200) => send(res, status, page(body), { 'Content-Type': 'text/html; charset=utf-8' });
  const redirect = (res, location, status = 302) => send(res, status, null, { Location: location });

  function page(body) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fake provider</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:30rem;margin:4rem auto;padding:0 1rem;color:#1a1f36}h1{font-size:1.4rem}button,a.btn{font:inherit;padding:.6rem 1rem;border-radius:6px;border:1px solid #635bff;background:#635bff;color:#fff;cursor:pointer;text-decoration:none;display:inline-block;margin:.25rem .5rem .25rem 0}button.secondary,a.secondary{background:#fff;color:#635bff}.note{color:#697386;font-size:13px}code{background:#f6f8fa;padding:0 .3em}</style></head><body>${body}<p class="note">This page is a local fake used by TinyTown's end-to-end tests. Nothing here is real.</p></body></html>`;
  }

  // ── Supabase Auth ───────────────────────────────────────────────────────

  function publicUser(u) {
    return {
      id: u.id,
      aud: 'authenticated',
      role: 'authenticated',
      email: u.email,
      email_confirmed_at: u.confirmedAt,
      phone: '',
      confirmed_at: u.confirmedAt,
      last_sign_in_at: u.lastSignIn,
      app_metadata: u.appMetadata,
      user_metadata: u.userMetadata,
      identities: [],
      created_at: u.createdAt,
      updated_at: u.updatedAt,
      banned_until: u.bannedUntil ?? null,
      is_anonymous: false,
    };
  }

  function createUser(email, { confirmed = true, userMetadata = {}, appMetadata = {} } = {}) {
    const key = String(email).trim().toLowerCase();
    const existing = state.auth.byEmail.get(key);
    if (existing) return existing;
    const at = new Date().toISOString();
    const u = { id: randomUUID(), email: key, confirmedAt: confirmed ? at : null, lastSignIn: null, createdAt: at, updatedAt: at, userMetadata, appMetadata: { provider: 'email', providers: ['email'], ...appMetadata }, bannedUntil: null };
    state.auth.users.set(u.id, u);
    state.auth.byEmail.set(key, u);
    return u;
  }

  /** A session as GoTrue makes one. Access tokens are unsigned-looking JWTs; we look them up, never trust them. */
  function createSession(user, ttlS = 3600) {
    const sessionId = randomUUID();
    const exp = nowS() + ttlS;
    const accessToken = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', exp, iat: nowS(), session_id: sessionId })}.${randomBytes(24).toString('base64url')}`;
    const refreshToken = randomBytes(12).toString('base64url');
    state.auth.sessions.set(accessToken, { userId: user.id, sessionId, exp });
    state.auth.refresh.set(refreshToken, { userId: user.id, sessionId });
    user.lastSignIn = new Date().toISOString();
    return { access_token: accessToken, token_type: 'bearer', expires_in: ttlS, expires_at: exp, refresh_token: refreshToken, user: publicUser(user) };
  }

  function sendMagicLink(email, redirectTo, type = 'magiclink') {
    const token = randomBytes(16).toString('hex');
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    state.auth.otps.set(token, { email: email.toLowerCase(), exp: Date.now() + 3600_000, redirectTo, otp, type });
    const link = `${base}/auth/v1/verify?token=${token}&type=${type}&redirect_to=${encodeURIComponent(redirectTo ?? state.appUrl ?? '/')}`;
    state.mailbox.push({ to: email.toLowerCase(), type, link, otp, at: Date.now() });
    return { token, link, otp };
  }

  function userFromBearer(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    if (!m) return { error: [401, { code: 401, error_code: 'no_authorization', msg: 'This endpoint requires a Bearer token' }] };
    const s = state.auth.sessions.get(m[1]);
    if (!s) return { error: [403, { code: 403, error_code: 'bad_jwt', msg: 'invalid JWT: unable to parse or verify signature, token is malformed' }] };
    if (s.exp < nowS()) return { error: [403, { code: 403, error_code: 'bad_jwt', msg: 'invalid JWT: unable to parse or verify signature, token has invalid claims: token is expired' }] };
    const u = state.auth.users.get(s.userId);
    if (!u) return { error: [403, { code: 403, error_code: 'user_not_found', msg: 'User from sub claim in JWT does not exist' }] };
    return { user: u, token: m[1], session: s };
  }

  const isService = (req) => req.headers.apikey === serviceKey || req.headers.authorization === `Bearer ${serviceKey}`;

  /** Deleting an auth user: rows that reference auth.users go with it (or have it set to null). */
  function cascadeUser(userId) {
    for (const t of Object.values(schema.tables)) {
      for (const col of Object.values(t.columns)) {
        if (col.references?.schema !== 'auth' || col.references.table !== 'users') continue;
        const rows = state.tables[t.name];
        if (col.references.onDelete === 'cascade') state.tables[t.name] = rows.filter((r) => r[col.name] !== userId);
        else if (col.references.onDelete === 'set null') for (const r of rows) if (r[col.name] === userId) r[col.name] = null;
      }
    }
  }

  async function auth(req, res, url, body) {
    const p = url.pathname.slice('/auth/v1'.length);
    const json = () => (body.length ? JSON.parse(body.toString('utf8')) : {});
    if (p === '/health') return send(res, 200, { name: 'GoTrue', version: 'fake' });
    if (p === '/settings') return send(res, 200, { external: { email: true, google: true, github: true }, disable_signup: false, mailer_autoconfirm: false, phone_autoconfirm: false });

    if (p === '/otp' && req.method === 'POST') {
      const b = json();
      if (typeof b.email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) return send(res, 400, { code: 400, error_code: 'validation_failed', msg: 'Unable to validate email address: invalid format' });
      if (b.create_user === false && !state.auth.byEmail.has(b.email.toLowerCase())) return send(res, 422, { code: 422, error_code: 'otp_disabled', msg: 'Signups not allowed for otp' });
      createUser(b.email, { confirmed: false, userMetadata: b.data ?? {} });
      sendMagicLink(b.email, url.searchParams.get('redirect_to') ?? state.appUrl);
      return send(res, 200, {});
    }

    if (p === '/verify' && req.method === 'GET') {
      const redirectTo = url.searchParams.get('redirect_to') || state.appUrl || '/';
      const o = state.auth.otps.get(url.searchParams.get('token') ?? '');
      if (!o || o.exp < Date.now()) return redirect(res, `${redirectTo}#error=access_denied&error_code=otp_expired&error_description=${encodeURIComponent('Email link is invalid or has expired')}`, 303);
      state.auth.otps.delete(url.searchParams.get('token'));
      const u = createUser(o.email);
      u.confirmedAt ??= new Date().toISOString();
      const s = createSession(u);
      return redirect(res, `${redirectTo}#access_token=${s.access_token}&expires_at=${s.expires_at}&expires_in=${s.expires_in}&refresh_token=${s.refresh_token}&token_type=bearer&type=${o.type}`, 303);
    }
    if (p === '/verify' && req.method === 'POST') {
      const b = json();
      const entry = [...state.auth.otps].find(([, o]) => o.email === String(b.email ?? '').toLowerCase() && o.otp === String(b.token) && o.exp > Date.now());
      if (!entry) return send(res, 403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
      state.auth.otps.delete(entry[0]);
      return send(res, 200, createSession(createUser(entry[1].email)));
    }

    if (p === '/token' && req.method === 'POST') {
      const b = json();
      if (url.searchParams.get('grant_type') !== 'refresh_token') return send(res, 400, { code: 400, error_code: 'unsupported_grant_type', msg: 'Only refresh_token grants in the fake' });
      const r = state.auth.refresh.get(b.refresh_token);
      const u = r && state.auth.users.get(r.userId);
      if (!u) return send(res, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' });
      state.auth.refresh.delete(b.refresh_token);
      return send(res, 200, createSession(u));
    }

    if (p === '/logout' && req.method === 'POST') {
      const who = userFromBearer(req);
      if (who.user) {
        for (const [tok, s] of state.auth.sessions) if (s.sessionId === who.session.sessionId || url.searchParams.get('scope') === 'global' && s.userId === who.user.id) state.auth.sessions.delete(tok);
      }
      return send(res, 204, null);
    }

    if (p === '/user' && req.method === 'GET') {
      if (req.headers.apikey !== anonKey && req.headers.apikey !== serviceKey) return send(res, 401, { message: 'Invalid API key' });
      const who = userFromBearer(req);
      if (who.error) return send(res, ...who.error);
      if (who.user.bannedUntil && Date.parse(who.user.bannedUntil) > Date.now()) return send(res, 403, { code: 403, error_code: 'user_banned', msg: 'User is banned' });
      return send(res, 200, publicUser(who.user));
    }

    if (p === '/invite' && req.method === 'POST') {
      if (!isService(req)) return send(res, 401, { msg: 'This endpoint requires a valid service role key' });
      const b = json();
      const u = createUser(b.email, { confirmed: false, userMetadata: b.data ?? {} });
      sendMagicLink(b.email, url.searchParams.get('redirect_to') ?? state.appUrl, 'invite');
      return send(res, 200, publicUser(u));
    }

    if (p.startsWith('/admin/')) {
      if (!isService(req)) return send(res, 401, { code: 401, error_code: 'no_authorization', msg: 'This endpoint requires a valid service role key' });
      if (p === '/admin/users' && req.method === 'GET') {
        const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
        const per = Math.min(1000, Math.max(1, Number(url.searchParams.get('per_page') ?? 50)));
        const all = [...state.auth.users.values()];
        const users = all.slice((page - 1) * per, page * per).map(publicUser);
        return send(res, 200, { users, aud: 'authenticated' }, { 'X-Total-Count': String(all.length) });
      }
      if (p === '/admin/users' && req.method === 'POST') {
        const b = json();
        if (state.auth.byEmail.has(String(b.email ?? '').toLowerCase())) return send(res, 422, { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' });
        return send(res, 200, publicUser(createUser(b.email, { confirmed: !!b.email_confirm, userMetadata: b.user_metadata ?? {}, appMetadata: b.app_metadata ?? {} })));
      }
      if (p === '/admin/generate_link' && req.method === 'POST') {
        const b = json();
        const u = createUser(b.email, { confirmed: false });
        const { link, otp, token } = sendMagicLink(b.email, b.redirect_to ?? b.options?.redirectTo ?? state.appUrl, b.type === 'invite' ? 'invite' : 'magiclink');
        return send(res, 200, { ...publicUser(u), action_link: link, email_otp: otp, hashed_token: createHash('sha256').update(token).digest('hex'), verification_type: b.type ?? 'magiclink', redirect_to: b.redirect_to ?? state.appUrl });
      }
      const m = /^\/admin\/users\/([0-9a-f-]{36})$/.exec(p);
      if (m) {
        const u = state.auth.users.get(m[1]);
        if (!u) return send(res, 404, { code: 404, error_code: 'user_not_found', msg: 'User not found' });
        if (req.method === 'GET') return send(res, 200, publicUser(u));
        if (req.method === 'PUT') {
          const b = json();
          if (b.email) {
            state.auth.byEmail.delete(u.email);
            u.email = String(b.email).toLowerCase();
            state.auth.byEmail.set(u.email, u);
          }
          if (b.user_metadata) u.userMetadata = { ...u.userMetadata, ...b.user_metadata };
          if (b.app_metadata) u.appMetadata = { ...u.appMetadata, ...b.app_metadata };
          if (b.ban_duration) u.bannedUntil = b.ban_duration === 'none' ? null : new Date(Date.now() + 100 * 365 * DAY).toISOString();
          u.updatedAt = new Date().toISOString();
          return send(res, 200, publicUser(u));
        }
        if (req.method === 'DELETE') {
          state.auth.users.delete(u.id);
          state.auth.byEmail.delete(u.email);
          for (const [tok, s] of state.auth.sessions) if (s.userId === u.id) state.auth.sessions.delete(tok);
          cascadeUser(u.id);
          return send(res, 200, {});
        }
      }
    }
    unhandled('auth', req.method, p);
    return send(res, 404, { code: 404, error_code: 'not_found', msg: `The fake Supabase Auth has no ${req.method} ${p}` });
  }

  // ── PostgREST ───────────────────────────────────────────────────────────

  function tableOf(name) {
    const t = schema.tables[name];
    if (!t) throw pgError(404, 'PGRST205', `Could not find the table 'public.${name}' in the schema cache`);
    return t;
  }

  function checkColumns(t, keys) {
    for (const k of keys) if (!t.columns[k]) throw pgError(400, 'PGRST204', `Could not find the '${k}' column of '${t.name}' in the schema cache`);
  }

  function predicate(t, params) {
    const preds = [];
    for (const [k, v] of params) {
      if (k === 'or' || k === 'and') {
        preds.push(logic(k, v));
        continue;
      }
      if (RESERVED.has(k)) continue;
      const col = k.split('->')[0];
      if (!t.columns[col]) throw pgError(400, '42703', `column ${t.name}.${col} does not exist`);
      preds.push((row) => test(row[col], v));
    }
    return { hasFilter: preds.length > 0, match: (row) => preds.every((f) => f(row)) };
  }

  function project(rows, select) {
    if (!select || select === '*') return rows;
    const cols = splitTop(select);
    if (cols.some((c) => c.includes('('))) throw pgError(400, 'PGRST100', `The fake PostgREST doesn't embed related tables (select=${select})`);
    return rows.map((r) => Object.fromEntries(cols.map((c) => {
      const [alias, col] = c.includes(':') ? c.split(':') : [c, c];
      return [alias, r[col] ?? null];
    })));
  }

  function order(rows, spec) {
    if (!spec) return rows;
    const keys = spec.split(',').map((s) => {
      const [col, ...mods] = s.split('.');
      return { col, desc: mods.includes('desc'), nullsFirst: mods.includes('nullsfirst') ? true : mods.includes('nullslast') ? false : mods.includes('desc') };
    });
    return [...rows].sort((a, b) => {
      for (const k of keys) {
        const x = a[k.col];
        const y = b[k.col];
        if (x == null && y == null) continue;
        if (x == null) return k.nullsFirst ? -1 : 1;
        if (y == null) return k.nullsFirst ? 1 : -1;
        const c = cmp(x, y);
        if (c) return k.desc ? -c : c;
      }
      return 0;
    });
  }

  function keyCols(t, onConflict) {
    if (onConflict) return onConflict.split(',').map((c) => c.trim());
    return t.pk;
  }

  const sameKey = (cols, a, b) => cols.length > 0 && cols.every((c) => a[c] != null && String(a[c]) === String(b[c]));

  function insertRow(t, input) {
    const row = {};
    for (const col of Object.values(t.columns)) {
      if (col.name in input) row[col.name] = clone(input[col.name]);
      else if (col.identity) row[col.name] = state.identity[`${t.name}.${col.name}`] = (state.identity[`${t.name}.${col.name}`] ?? 0) + 1;
      else if (col.default) row[col.name] = col.default();
      else row[col.name] = null;
    }
    for (const col of Object.values(t.columns)) {
      if (col.notNull && row[col.name] == null) throw pgError(400, '23502', `null value in column "${col.name}" of relation "${t.name}" violates not-null constraint`);
      if (col.references?.schema === 'auth' && row[col.name] != null && !state.auth.users.has(row[col.name])) {
        if (t.skipDeleted) return null;
        throw pgError(409, '23503', `insert or update on table "${t.name}" violates foreign key constraint`, `Key (${col.name})=(${row[col.name]}) is not present in table "users".`);
      }
    }
    const rows = state.tables[t.name];
    for (const cols of [t.pk, ...t.uniques]) {
      if (rows.some((r) => sameKey(cols, r, row))) throw pgError(409, '23505', `duplicate key value violates unique constraint "${t.name}_${cols.join('_')}_key"`);
    }
    rows.push(row);
    return row;
  }

  async function rest(req, res, url, body) {
    const anon = req.headers.apikey === anonKey;
    if (!isService(req) && !anon) return send(res, 401, { message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' });
    const prefer = String(req.headers.prefer ?? '');
    const p = url.pathname.slice('/rest/v1/'.length);

    const rpc = /^rpc\/(\w+)$/.exec(p);
    if (rpc) {
      if (anon) return send(res, 401, { code: '42501', message: `permission denied for function ${rpc[1]}` });
      const args = req.method === 'GET' ? Object.fromEntries(url.searchParams) : body.length ? JSON.parse(body.toString('utf8')) : {};
      const fn = state.rpc.get(rpc[1]);
      if (!fn) {
        unhandled('rest', 'RPC', rpc[1], schema.functions.has(rpc[1]) ? 'in a migration, but not emulated by the fake' : 'no migration defines it');
        return send(res, 404, { code: 'PGRST202', details: null, hint: null, message: `Could not find the function public.${rpc[1]} in the schema cache` });
      }
      return send(res, 200, await fn(args));
    }

    const t = tableOf(p);
    if (anon) throw pgError(401, '42501', `permission denied for table ${t.name}`);
    const where = predicate(t, url.searchParams);
    const rows = state.tables[t.name];
    const wantObject = String(req.headers.accept ?? '').includes('vnd.pgrst.object');
    const representation = prefer.includes('return=representation');
    const countExact = /count=(exact|planned|estimated)/.test(prefer);
    const finish = (status, out, total) => {
      const headers = {};
      if (countExact) headers['Content-Range'] = out.length ? `0-${out.length - 1}/${total ?? out.length}` : `*/${total ?? 0}`;
      if (wantObject) {
        if (out.length !== 1) return send(res, 406, { code: 'PGRST116', details: `The result contains ${out.length} rows`, hint: null, message: 'JSON object requested, multiple (or no) rows returned' });
        return send(res, status, out[0], headers);
      }
      return send(res, status, out, headers);
    };

    if (req.method === 'GET' || req.method === 'HEAD') {
      let out = order(rows.filter(where.match), url.searchParams.get('order'));
      const total = out.length;
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : Infinity;
      out = out.slice(offset, offset + limit);
      if (req.method === 'HEAD') return send(res, 200, null, countExact ? { 'Content-Range': `*/${total}` } : {});
      return finish(200, clone(project(out, url.searchParams.get('select'))), total);
    }

    if (req.method === 'POST') {
      const parsed = JSON.parse(body.toString('utf8') || 'null');
      const input = Array.isArray(parsed) ? parsed : [parsed];
      const merge = prefer.includes('resolution=merge-duplicates');
      const ignore = prefer.includes('resolution=ignore-duplicates');
      const cols = keyCols(t, url.searchParams.get('on_conflict'));
      const written = [];
      for (const r of input) {
        checkColumns(t, Object.keys(r));
        const existing = (merge || ignore) && rows.find((x) => sameKey(cols, x, r));
        if (existing) {
          if (ignore) continue;
          Object.assign(existing, clone(r));
          written.push(existing);
          continue;
        }
        const row = insertRow(t, r);
        if (row) written.push(row);
      }
      if (!representation) return send(res, 201, null);
      return finish(201, clone(project(written, url.searchParams.get('select'))));
    }

    if (req.method === 'PATCH') {
      if (!where.hasFilter) throw pgError(400, '21000', 'UPDATE requires a WHERE clause');
      const patch = JSON.parse(body.toString('utf8') || '{}');
      checkColumns(t, Object.keys(patch));
      const hit = rows.filter(where.match);
      for (const r of hit) Object.assign(r, clone(patch));
      if (!representation) return send(res, 204, null);
      return finish(200, clone(project(hit, url.searchParams.get('select'))));
    }

    if (req.method === 'DELETE') {
      if (!where.hasFilter) throw pgError(400, '21000', 'DELETE requires a WHERE clause');
      const hit = rows.filter(where.match);
      state.tables[t.name] = rows.filter((r) => !where.match(r));
      if (!representation) return send(res, 204, null);
      return finish(200, clone(project(hit, url.searchParams.get('select'))));
    }
    return send(res, 405, { message: 'Method not allowed' });
  }

  // The RPCs our migrations define, emulated.
  const userTables = () => Object.values(schema.tables).filter((t) => t.columns.user_id && /uuid/.test(t.columns.user_id.type)).map((t) => t.name).sort();
  state.rpc.set('user_tables', () => userTables().map((table_name) => ({ table_name })));
  state.rpc.set('delete_user_data', ({ uid }) => {
    if (!uid) throw pgError(400, 'P0001', 'delete_user_data: uid is required');
    const deleted = {};
    for (const name of userTables()) {
      const before = state.tables[name].length;
      state.tables[name] = state.tables[name].filter((r) => r.user_id !== uid);
      if (before !== state.tables[name].length) deleted[name] = before - state.tables[name].length;
    }
    return deleted;
  });
  // 0002: one atomic hit in a fixed window.
  state.rpc.set('rate_hit', ({ p_key, p_window_s, p_max }) => {
    if (!p_key || String(p_key).length > 128 || !(p_window_s >= 1 && p_window_s <= 86_400) || !(p_max >= 1)) throw pgError(400, '22023', 'rate_hit: bad arguments');
    const rows = (state.tables.rate_limits ??= []);
    const now = Date.now();
    let r = rows.find((x) => x.key === p_key);
    if (!r) rows.push((r = { key: p_key, window_start: new Date(now).toISOString(), hits: 0 }));
    if (Date.parse(r.window_start) + p_window_s * 1000 <= now) Object.assign(r, { window_start: new Date(now).toISOString(), hits: 0 });
    r.hits++;
    return [{ allowed: r.hits <= p_max, retry_after_s: Math.max(1, Math.ceil((Date.parse(r.window_start) + p_window_s * 1000 - now) / 1000)) }];
  });
  // 0007: the caller's profile (made on first sight), plan and asked-for rows in one call, plus an optional rate_hit.
  state.rpc.set('user_state', ({ p_user, p_seed, p_parts, p_rate_key, p_rate_window_s, p_rate_max }) => {
    if (!p_user) throw pgError(400, '22023', 'user_state: p_user is required');
    const mine = (name) => state.tables[name].filter((r) => r.user_id === p_user);
    let profile = mine('profiles')[0] ?? null;
    let created = false;
    if (!profile) {
      // insertRow applies 0006's guard: nothing is made for a user Auth no longer has.
      profile = insertRow(schema.tables.profiles, { user_id: p_user, seed: p_seed ?? 1 + Math.floor(Math.random() * 2147483646) });
      created = !!profile;
    }
    const rate = p_rate_key == null ? undefined : state.rpc.get('rate_hit')({ p_key: p_rate_key, p_window_s: p_rate_window_s, p_max: p_rate_max })[0];
    const parts = p_parts ?? [];
    return clone({
      profile,
      created,
      subscription: mine('subscriptions')[0] ?? null,
      ...(rate ? { rate } : {}),
      ...(parts.includes('connections') ? { connections: mine('connections') } : {}),
      ...(parts.includes('world') ? { world: mine('worlds')[0] ?? null } : {}),
      ...(parts.includes('timeline') ? { timeline: mine('timelines')[0] ?? null } : {}),
    });
  });
  state.rpc.set('export_user_data', ({ uid }) => {
    if (!uid) throw pgError(400, 'P0001', 'export_user_data: uid is required');
    const out = {};
    const hidden = /(secret|token|password|passwd|hash|cipher|key|nonce|salt|signature|otp)/i;
    for (const name of userTables()) {
      if (['profiles', 'subscriptions', 'connections', 'worlds', 'timelines'].includes(name)) continue;
      const rows = state.tables[name].filter((r) => r.user_id === uid).map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !hidden.test(k))));
      if (rows.length) out[name] = rows;
    }
    return out;
  });

  // ── Stripe ──────────────────────────────────────────────────────────────

  const stripeError = (res, status, message, type = 'invalid_request_error', code) => send(res, status, { error: { message, type, ...(code ? { code } : {}) } });
  const list = (data, url = '/v1/…', hasMore = false) => ({ object: 'list', data, has_more: hasMore, url });

  /** Which Stripe account a key or OAuth access token opens: our own, or a founder's. */
  function stripeCaller(req) {
    const h = req.headers.authorization ?? '';
    let key = /^Bearer\s+(\S+)$/i.exec(h)?.[1];
    if (!key && /^Basic\s+/i.test(h)) key = Buffer.from(h.replace(/^Basic\s+/i, ''), 'base64').toString('utf8').replace(/:$/, '');
    if (!key) return { error: [401, 'You did not provide an API key.'] };
    if (key.startsWith('fake_at_')) {
      const tok = state.stripe.accessTokens.get(key);
      if (!tok) return { error: [401, 'Invalid API Key provided.'] };
      if (tok.exp < Date.now()) return { error: [401, 'This OAuth access token has expired.', 'expired_api_key'] };
      return { founder: tok.account, key };
    }
    if (!/^(sk|rk)_(test|live)_/.test(key)) return { error: [401, 'Invalid API Key provided.'] };
    return { platform: true, key, live: /_live_/.test(key) };
  }

  function subscriptionObject(s) {
    return clone(s);
  }

  function makeEvent(type, object) {
    const ev = { id: id('evt_'), object: 'event', api_version: '2025-09-30.clover', created: nowS(), livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null }, type, data: { object: clone(object) } };
    state.stripe.events.push(ev);
    return ev;
  }

  /** Delivers one event to our webhook, signed the way Stripe signs. */
  async function deliver(ev, { tamper = false } = {}) {
    if (!state.appUrl || !state.webhookSecret) {
      state.stripe.deliveries.push({ id: ev.id, type: ev.type, status: 0, error: 'no appUrl or webhookSecret configured' });
      return 0;
    }
    const payload = JSON.stringify(ev);
    const t = nowS();
    const sig = createHmac('sha256', tamper ? 'wrong-secret' : state.webhookSecret).update(`${t}.${payload}`).digest('hex');
    try {
      const r = await fetch(`${state.appUrl}/api/billing/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}`, 'User-Agent': 'Stripe/1.0 (+https://stripe.com/docs/webhooks)' }, body: payload });
      const text = await r.text();
      state.stripe.deliveries.push({ id: ev.id, type: ev.type, status: r.status, body: text.slice(0, 300) });
      return r.status;
    } catch (err) {
      state.stripe.deliveries.push({ id: ev.id, type: ev.type, status: 0, error: err.message });
      return 0;
    }
  }

  async function emit(type, object) {
    return deliver(makeEvent(type, object));
  }

  function newSubscription(customer, priceId, metadata) {
    const price = state.stripe.prices.get(priceId);
    const start = nowS();
    const end = start + (price.recurring.interval === 'year' ? 365 : 30) * 86_400;
    const sub = {
      id: id('sub_'),
      object: 'subscription',
      customer,
      status: 'active',
      livemode: false,
      cancel_at_period_end: false,
      canceled_at: null,
      ended_at: null,
      created: start,
      start_date: start,
      current_period_start: start,
      current_period_end: end,
      trial_end: null,
      currency: price.currency,
      metadata: metadata ?? {},
      items: { object: 'list', data: [{ id: id('si_'), object: 'subscription_item', quantity: 1, current_period_start: start, current_period_end: end, price: clone(price) }] },
    };
    state.stripe.subscriptions.set(sub.id, sub);
    return sub;
  }

  async function cancelSubscription(sub) {
    sub.status = 'canceled';
    sub.canceled_at = nowS();
    sub.ended_at = nowS();
    sub.cancel_at_period_end = false;
    await emit('customer.subscription.deleted', sub);
  }

  /** The founder's Stripe account, made the first time it's seen. */
  function founderAccount(acct) {
    let a = state.stripe.accounts.get(acct);
    if (!a) {
      a = { id: acct, name: opts.founderName ?? 'Nightjar Labs', livemode: opts.founderLivemode ?? false, subs: founderSubscriptions(acct, { count: opts.founderSubs ?? 90 }) };
      state.stripe.accounts.set(acct, a);
    }
    return a;
  }

  function issueStripeTokens(acct) {
    const a = founderAccount(acct);
    const access = id('fake_at_', 16);
    const refresh = id('fake_rt_', 16);
    state.stripe.accessTokens.set(access, { account: acct, exp: Date.now() + 3600_000 });
    state.stripe.refreshTokens.set(refresh, acct);
    return { access_token: access, refresh_token: refresh, livemode: a.livemode, stripe_user_id: acct, scope: 'stripe_apps', token_type: 'bearer', stripe_publishable_key: 'pk_test_fake' };
  }

  async function stripeApi(req, res, url, body) {
    const p = url.pathname.slice('/stripe'.length);
    const params = req.method === 'GET' || req.method === 'DELETE' ? parseStripeForm(url.search.slice(1)) : parseStripeForm(body.toString('utf8'));

    if (p === '/v1/oauth/token' && req.method === 'POST') {
      const caller = stripeCaller(req);
      if (caller.error || !caller.platform) return send(res, 401, { error: 'invalid_client', error_description: 'No valid API key provided.' });
      if (params.grant_type === 'authorization_code') {
        const c = state.stripe.codes.get(params.code);
        if (!c || c.exp < Date.now()) return send(res, 400, { error: 'invalid_grant', error_description: `Authorization code does not exist: ${params.code}` });
        state.stripe.codes.delete(params.code);
        return send(res, 200, issueStripeTokens(c.account));
      }
      if (params.grant_type === 'refresh_token') {
        if (state.stripe.spentRefreshTokens.has(params.refresh_token)) return send(res, 400, { error: 'invalid_grant', error_description: 'Refresh token has already been used.' });
        const acct = state.stripe.refreshTokens.get(params.refresh_token);
        if (!acct) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid refresh token.' });
        // Rolling: the old refresh token dies the moment a new one is issued.
        state.stripe.refreshTokens.delete(params.refresh_token);
        state.stripe.spentRefreshTokens.add(params.refresh_token);
        return send(res, 200, issueStripeTokens(acct));
      }
      return send(res, 400, { error: 'unsupported_grant_type' });
    }

    const caller = stripeCaller(req);
    if (caller.error) return stripeError(res, caller.error[0], caller.error[1], 'invalid_request_error', caller.error[2]);

    // A founder's own account, read with their OAuth token: read-only.
    if (caller.founder) {
      const a = founderAccount(caller.founder);
      if (p === '/v1/subscriptions' && req.method === 'GET') {
        const limit = Math.min(100, Number(params.limit ?? 10));
        let subs = a.subs;
        if (params.status && params.status !== 'all') subs = subs.filter((s) => s.status === params.status);
        const from = params.starting_after ? subs.findIndex((s) => s.id === params.starting_after) + 1 : 0;
        const page = subs.slice(from, from + limit);
        return send(res, 200, list(clone(page), '/v1/subscriptions', from + limit < subs.length));
      }
      if ((p === '/v1/account' || p === `/v1/accounts/${a.id}`) && req.method === 'GET') {
        return send(res, 200, { id: a.id, object: 'account', settings: { dashboard: { display_name: a.name } }, business_profile: { name: a.name } });
      }
      if (req.method !== 'GET') return stripeError(res, 403, 'The provided key does not have the required permissions for this endpoint (read-only Stripe App).', 'invalid_request_error', 'secret_key_required');
      unhandled('stripe', `${req.method} (founder)`, p);
      return send(res, 200, list([]));
    }

    // Our own billing account.
    const idem = req.headers['idempotency-key'];
    if (idem && req.method === 'POST') {
      const hit = state.stripe.idempotency.get(`${p}|${idem}`);
      if (hit) return send(res, hit.status, hit.body, { 'Idempotent-Replayed': 'true' });
    }
    const reply = (status, payload) => {
      if (idem && req.method === 'POST') state.stripe.idempotency.set(`${p}|${idem}`, { status, body: payload });
      return send(res, status, payload);
    };

    let m;
    if ((m = /^\/v1\/prices\/([\w-]+)$/.exec(p)) && req.method === 'GET') {
      const price = state.stripe.prices.get(m[1]);
      return price ? send(res, 200, price) : stripeError(res, 404, `No such price: '${m[1]}'`, 'invalid_request_error', 'resource_missing');
    }
    if (p === '/v1/prices' && req.method === 'GET') return send(res, 200, list([...state.stripe.prices.values()], '/v1/prices'));
    if (p === '/v1/prices' && req.method === 'POST') {
      const price = { id: id('price_'), object: 'price', active: true, unit_amount: Number(params.unit_amount), currency: params.currency ?? 'usd', recurring: params.recurring ? { interval: params.recurring.interval, interval_count: 1 } : null, product: params.product, lookup_key: params.lookup_key ?? null, livemode: false };
      state.stripe.prices.set(price.id, price);
      return reply(200, price);
    }
    if (p === '/v1/products' && req.method === 'POST') return reply(200, { id: id('prod_'), object: 'product', name: params.name, active: true, metadata: params.metadata ?? {} });

    if (p === '/v1/customers' && req.method === 'POST') {
      const c = { id: id('cus_'), object: 'customer', email: params.email ?? null, metadata: params.metadata ?? {}, created: nowS(), livemode: false, deleted: false };
      state.stripe.customers.set(c.id, c);
      return reply(200, c);
    }
    if (p === '/v1/customers' && req.method === 'GET') {
      const all = [...state.stripe.customers.values()].filter((c) => !c.deleted && (!params.email || c.email === params.email));
      return send(res, 200, list(all.slice(0, Number(params.limit ?? 10)), '/v1/customers'));
    }
    if ((m = /^\/v1\/customers\/(cus_\w+)$/.exec(p))) {
      const c = state.stripe.customers.get(m[1]);
      if (!c) return stripeError(res, 404, `No such customer: '${m[1]}'`, 'invalid_request_error', 'resource_missing');
      if (req.method === 'GET') return send(res, 200, c.deleted ? { id: c.id, object: 'customer', deleted: true } : c);
      if (req.method === 'POST') {
        if (params.email) c.email = params.email;
        if (params.metadata) c.metadata = { ...c.metadata, ...params.metadata };
        return reply(200, c);
      }
      if (req.method === 'DELETE') {
        c.deleted = true;
        for (const s of state.stripe.subscriptions.values()) if (s.customer === c.id && s.status !== 'canceled') await cancelSubscription(s);
        return send(res, 200, { id: c.id, object: 'customer', deleted: true });
      }
    }

    if (p === '/v1/checkout/sessions' && req.method === 'POST') {
      const item = params.line_items?.[0];
      const price = item && state.stripe.prices.get(item.price);
      if (!price) return stripeError(res, 400, `No such price: '${item?.price}'`, 'invalid_request_error', 'resource_missing');
      if (params.customer && !state.stripe.customers.get(params.customer)) return stripeError(res, 400, `No such customer: '${params.customer}'`, 'invalid_request_error', 'resource_missing');
      if (params.mode !== 'subscription') return stripeError(res, 400, 'The fake only does subscription Checkout.');
      if (!params.success_url || !params.cancel_url) return stripeError(res, 400, 'Missing success_url or cancel_url.');
      const s = { id: id('cs_test_', 20), object: 'checkout.session', mode: 'subscription', status: 'open', payment_status: 'unpaid', customer: params.customer ?? null, client_reference_id: params.client_reference_id ?? null, metadata: params.metadata ?? {}, subscription: null, success_url: params.success_url, cancel_url: params.cancel_url, price: price.id, subscription_data: params.subscription_data ?? {}, livemode: false, created: nowS(), expires_at: nowS() + 86_400 };
      s.url = `${base}/stripe-pages/checkout/${s.id}`;
      state.stripe.sessions.set(s.id, s);
      return reply(200, s);
    }
    if (p === '/v1/checkout/sessions' && req.method === 'GET') {
      let all = [...state.stripe.sessions.values()].sort((a, b) => b.created - a.created);
      if (params.customer) all = all.filter((s) => s.customer === params.customer);
      if (params.status) all = all.filter((s) => s.status === params.status);
      return send(res, 200, list(all.slice(0, Number(params.limit ?? 10)), '/v1/checkout/sessions'));
    }
    if ((m = /^\/v1\/checkout\/sessions\/(cs_\w+)(\/expire)?$/.exec(p))) {
      const s = state.stripe.sessions.get(m[1]);
      if (!s) return stripeError(res, 404, `No such checkout.session: '${m[1]}'`, 'invalid_request_error', 'resource_missing');
      if (req.method === 'GET' && !m[2]) return send(res, 200, s);
      if (req.method === 'POST' && m[2]) {
        if (s.status !== 'open') return stripeError(res, 400, `Only Checkout Sessions with a status of open can be expired (this one is ${s.status}).`);
        s.status = 'expired';
        await emit('checkout.session.expired', s);
        return reply(200, s);
      }
    }

    if (p === '/v1/billing_portal/sessions' && req.method === 'POST') {
      if (!state.stripe.customers.get(params.customer)) return stripeError(res, 400, `No such customer: '${params.customer}'`, 'invalid_request_error', 'resource_missing');
      const s = { id: id('bps_'), object: 'billing_portal.session', customer: params.customer, return_url: params.return_url ?? null, created: nowS(), livemode: false };
      s.url = `${base}/stripe-pages/portal/${s.id}`;
      state.stripe.portal.set(s.id, s);
      return reply(200, s);
    }
    if (p === '/v1/billing_portal/configurations' && req.method === 'POST') return reply(200, { id: id('bpc_'), object: 'billing_portal.configuration', is_default: true });

    if (p === '/v1/subscriptions' && req.method === 'GET') {
      let subs = [...state.stripe.subscriptions.values()].sort((a, b) => b.created - a.created);
      if (params.customer) subs = subs.filter((s) => s.customer === params.customer);
      if (params.status && params.status !== 'all') subs = subs.filter((s) => s.status === params.status);
      else if (!params.status) subs = subs.filter((s) => s.status !== 'canceled');
      const limit = Math.min(100, Number(params.limit ?? 10));
      const from = params.starting_after ? subs.findIndex((s) => s.id === params.starting_after) + 1 : 0;
      return send(res, 200, list(subs.slice(from, from + limit).map(subscriptionObject), '/v1/subscriptions', from + limit < subs.length));
    }
    if ((m = /^\/v1\/subscriptions\/(sub_\w+)$/.exec(p))) {
      const s = state.stripe.subscriptions.get(m[1]);
      if (!s) return stripeError(res, 404, `No such subscription: '${m[1]}'`, 'invalid_request_error', 'resource_missing');
      if (req.method === 'GET') return send(res, 200, subscriptionObject(s));
      if (req.method === 'POST') {
        if (s.status === 'canceled') return stripeError(res, 400, 'A canceled subscription can only update its cancellation_details and metadata.');
        if (params.cancel_at_period_end !== undefined) s.cancel_at_period_end = params.cancel_at_period_end === 'true';
        if (params.metadata) s.metadata = { ...s.metadata, ...params.metadata };
        await emit('customer.subscription.updated', s);
        return reply(200, subscriptionObject(s));
      }
      if (req.method === 'DELETE') {
        if (s.status === 'canceled') return stripeError(res, 400, `No such subscription: '${m[1]}' (already canceled)`, 'invalid_request_error', 'resource_missing');
        await cancelSubscription(s);
        return send(res, 200, subscriptionObject(s));
      }
    }

    if (p === '/v1/invoices' && req.method === 'GET') {
      const subs = [...state.stripe.subscriptions.values()].filter((s) => !params.customer || s.customer === params.customer);
      const invoices = subs.map((s) => ({ id: `in_${s.id.slice(4)}`, object: 'invoice', customer: s.customer, subscription: s.id, status: 'paid', amount_paid: s.items.data[0].price.unit_amount, currency: s.currency, created: s.created, hosted_invoice_url: `${base}/stripe-pages/invoice/${s.id}`, invoice_pdf: null }));
      return send(res, 200, list(invoices.slice(0, Number(params.limit ?? 10)), '/v1/invoices'));
    }
    if (p === '/v1/events' && req.method === 'GET') {
      let evs = [...state.stripe.events].reverse();
      if (params.type) evs = evs.filter((e) => e.type === params.type);
      return send(res, 200, list(evs.slice(0, Number(params.limit ?? 10)), '/v1/events'));
    }
    if (p === '/v1/refunds' && req.method === 'POST') return stripeError(res, 400, 'TinyTown does not refund (owner decision); the fake refuses refunds so a refund path shows up in tests.');

    unhandled('stripe', req.method, p);
    return stripeError(res, 404, `Unrecognized request URL (${req.method}: ${p}). The fake Stripe doesn't implement it.`);
  }

  /** Stripe's hosted pages: Checkout, the customer portal, and the Stripe App install (marketplace OAuth). */
  async function stripePages(req, res, url, body) {
    const p = url.pathname.slice('/stripe-pages'.length);
    let m;
    if ((m = /^\/checkout\/(cs_\w+)$/.exec(p)) && req.method === 'GET') {
      const s = state.stripe.sessions.get(m[1]);
      if (!s || s.status !== 'open') return html(res, '<h1>This checkout has expired</h1>', 404);
      const price = state.stripe.prices.get(s.price);
      const amount = `$${(price.unit_amount / 100).toFixed(2)}`;
      return html(
        res,
        `<h1>Subscribe to TinyTown</h1><p><b>${amount}</b> per ${price.recurring.interval}. Test card <code>4242 4242 4242 4242</code>.</p>
         <form method="post" action="/stripe-pages/checkout/${s.id}/pay"><button type="submit">Pay ${amount}</button></form>
         <form method="post" action="/stripe-pages/checkout/${s.id}/decline"><button class="secondary" type="submit">Use a card that declines</button></form>
         <a class="btn secondary" href="${escapeHtml(s.cancel_url)}">Back</a>`,
      );
    }
    if ((m = /^\/checkout\/(cs_\w+)\/(pay|decline)$/.exec(p)) && req.method === 'POST') {
      const s = state.stripe.sessions.get(m[1]);
      if (!s || s.status !== 'open') return html(res, '<h1>This checkout has expired</h1>', 404);
      if (m[2] === 'decline') return html(res, `<h1>Your card was declined</h1><p>Nothing was charged.</p><a class="btn" href="/stripe-pages/checkout/${s.id}">Try another card</a>`, 402);
      if (!s.customer) {
        const c = { id: id('cus_'), object: 'customer', email: null, metadata: {}, created: nowS(), livemode: false, deleted: false };
        state.stripe.customers.set(c.id, c);
        s.customer = c.id;
      }
      const sub = newSubscription(s.customer, s.price, s.subscription_data?.metadata);
      Object.assign(s, { status: 'complete', payment_status: 'paid', subscription: sub.id });
      // Stripe doesn't promise an order; this is the common one. A delay imitates a slow webhook.
      const fire = async () => {
        await emit('customer.subscription.created', sub);
        await emit('checkout.session.completed', s);
      };
      if (opts.webhookDelayMs) setTimeout(fire, opts.webhookDelayMs);
      else await fire();
      return redirect(res, s.success_url.replace('{CHECKOUT_SESSION_ID}', s.id), 303);
    }
    if ((m = /^\/portal\/(bps_\w+)$/.exec(p)) && req.method === 'GET') {
      const ps = state.stripe.portal.get(m[1]);
      if (!ps) return html(res, '<h1>This link has expired</h1>', 404);
      const subs = [...state.stripe.subscriptions.values()].filter((s) => s.customer === ps.customer);
      const rows = subs
        .map((s) => `<li><b>${s.items.data[0].price.recurring.interval === 'year' ? 'Yearly' : 'Monthly'}</b>, ${s.status}${s.cancel_at_period_end ? ' (cancels at period end)' : ''}
          ${s.status !== 'canceled' ? `<form method="post" action="/stripe-pages/portal/${ps.id}/cancel/${s.id}"><button type="submit" class="secondary">Cancel plan</button></form>` : ''}</li>`)
        .join('');
      return html(res, `<h1>Manage your TinyTown plan</h1><ul>${rows || '<li>No plans</li>'}</ul>${ps.return_url ? `<a class="btn" href="${escapeHtml(ps.return_url)}">Return to TinyTown</a>` : ''}`);
    }
    if ((m = /^\/portal\/(bps_\w+)\/cancel\/(sub_\w+)$/.exec(p)) && req.method === 'POST') {
      const ps = state.stripe.portal.get(m[1]);
      const s = state.stripe.subscriptions.get(m[2]);
      if (!ps || !s || s.customer !== ps.customer) return html(res, '<h1>Not found</h1>', 404);
      s.cancel_at_period_end = true;
      await emit('customer.subscription.updated', s);
      return redirect(res, `/stripe-pages/portal/${ps.id}`, 303);
    }
    // The Stripe App install (STRIPE_APP_INSTALL_URL points here).
    if ((p === '/oauth/v2/authorize' || p === '/oauth/authorize') && req.method === 'GET') {
      const q = url.searchParams;
      if (!q.get('client_id') || !q.get('redirect_uri') || !q.get('state')) return html(res, '<h1>Missing client_id, redirect_uri or state</h1>', 400);
      const acct = q.get('account') ?? opts.founderAccount ?? 'acct_1FakeNightjar';
      const back = new URL(q.get('redirect_uri'));
      back.searchParams.set('state', q.get('state'));
      const deny = new URL(back);
      deny.searchParams.set('error', 'access_denied');
      return html(
        res,
        `<h1>Install TinyTown on your Stripe account</h1><p>TinyTown wants <b>read-only</b> access to subscriptions on <b>${escapeHtml(founderAccount(acct).name)}</b> (<code>${escapeHtml(acct)}</code>).</p>
         <form method="post" action="/stripe-pages/oauth/approve"><input type="hidden" name="account" value="${escapeHtml(acct)}"><input type="hidden" name="redirect_uri" value="${escapeHtml(back.toString())}"><button type="submit">Install app</button></form>
         <a class="btn secondary" href="${escapeHtml(deny.toString())}">Cancel</a>`,
      );
    }
    if (p === '/oauth/approve' && req.method === 'POST') {
      const f = new URLSearchParams(body.toString('utf8'));
      const code = id('ac_', 16);
      state.stripe.codes.set(code, { account: f.get('account'), exp: Date.now() + 5 * 60_000 });
      const back = new URL(f.get('redirect_uri'));
      back.searchParams.set('code', code);
      return redirect(res, back.toString(), 303);
    }
    unhandled('stripe-pages', req.method, p);
    return html(res, `<h1>Not found</h1><p>${escapeHtml(p)}</p>`, 404);
  }

  // ── GitHub ──────────────────────────────────────────────────────────────

  function installationFor(login) {
    for (const i of state.github.installations.values()) if (i.account.login === login) return i;
    const inst = {
      id: state.github.nextInstallation++,
      account: { login, id: 1000 + state.github.installations.size, type: 'User' },
      repos: [`${login}/app`, `${login}/website`, `${login}/docs`].map((full, k) => ({ id: 9000 + k, name: full.split('/')[1], full_name: full, private: k === 0, default_branch: 'main', owner: { login } })),
      suspended: false,
    };
    state.github.installations.set(inst.id, inst);
    return inst;
  }

  function githubUserCode(login) {
    const code = id('', 10);
    state.github.codes.set(code, { login, exp: Date.now() + 10 * 60_000 });
    return code;
  }

  /** `Bearer <JWT>` signed by the App's key (checked when a public key was given). */
  function appJwtOk(req) {
    const tok = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!tok) return false;
    const [h, p, s] = tok.split('.');
    if (!h || !p || !s) return false;
    try {
      const head = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
      const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
      if (head.alg !== 'RS256' || !claims.iss || claims.exp - claims.iat > 600 || claims.exp < nowS()) return false;
      if (opts.githubPublicKey) return createVerify('RSA-SHA256').update(`${h}.${p}`).verify(createPublicKey(opts.githubPublicKey), Buffer.from(s, 'base64url'));
      return true;
    } catch {
      return false;
    }
  }

  const ghHeaders = { 'X-RateLimit-Limit': '5000', 'X-RateLimit-Remaining': '4999', 'X-GitHub-Media-Type': 'github.v3' };
  const ghSend = (res, status, b) => send(res, status, b, ghHeaders);

  async function githubWeb(req, res, url, body) {
    const p = url.pathname.slice('/github'.length);
    let m;
    if ((m = /^\/apps\/([\w-]+)\/installations\/new$/.exec(p)) && req.method === 'GET') {
      const state_ = url.searchParams.get('state') ?? '';
      const login = url.searchParams.get('login') ?? opts.githubLogin ?? 'nightjar-labs';
      return html(
        res,
        `<h1>Install ${escapeHtml(m[1])}</h1><p>Install on <b>@${escapeHtml(login)}</b> with read-only access to selected repositories.</p>
         <form method="post" action="/github/apps/${escapeHtml(m[1])}/installations/approve"><input type="hidden" name="state" value="${escapeHtml(state_)}"><input type="hidden" name="login" value="${escapeHtml(login)}"><button type="submit">Install &amp; Authorize</button></form>`,
      );
    }
    if ((m = /^\/apps\/([\w-]+)\/installations\/approve$/.exec(p)) && req.method === 'POST') {
      const f = new URLSearchParams(body.toString('utf8'));
      if (!state.appUrl) return html(res, '<h1>The fake has no appUrl for the callback</h1>', 500);
      const inst = installationFor(f.get('login'));
      const back = new URL(`${state.appUrl}/api/connect/github/callback`);
      back.searchParams.set('code', githubUserCode(f.get('login')));
      back.searchParams.set('installation_id', String(inst.id));
      back.searchParams.set('setup_action', 'install');
      back.searchParams.set('state', f.get('state'));
      return redirect(res, back.toString(), 302);
    }
    if (p === '/login/oauth/authorize' && req.method === 'GET') {
      const back = new URL(url.searchParams.get('redirect_uri') ?? `${state.appUrl}/api/connect/github/callback`);
      back.searchParams.set('code', githubUserCode(url.searchParams.get('login') ?? opts.githubLogin ?? 'nightjar-labs'));
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      return redirect(res, back.toString(), 302);
    }
    if (p === '/login/oauth/access_token' && req.method === 'POST') {
      const text = body.toString('utf8');
      const b = String(req.headers['content-type'] ?? '').includes('json') ? JSON.parse(text || '{}') : Object.fromEntries(new URLSearchParams(text));
      const c = state.github.codes.get(b.code);
      // GitHub answers 200 with an error field for a bad code.
      if (!b.client_id || !b.client_secret) return ghSend(res, 200, { error: 'incorrect_client_credentials' });
      if (!c || c.exp < Date.now()) return ghSend(res, 200, { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' });
      state.github.codes.delete(b.code);
      const token = id('ghu_', 18);
      state.github.userTokens.set(token, c.login);
      installationFor(c.login);
      return ghSend(res, 200, { access_token: token, token_type: 'bearer', scope: '' });
    }
    unhandled('github-web', req.method, p);
    return html(res, `<h1>Not found</h1><p>${escapeHtml(p)}</p>`, 404);
  }

  async function githubApi(req, res, url) {
    const p = url.pathname.slice('/github-api'.length);
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? null;
    const per = Math.min(100, Number(url.searchParams.get('per_page') ?? 30));
    const pageNo = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    const paged = (all) => all.slice((pageNo - 1) * per, pageNo * per);
    let m;

    if ((m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(p)) && req.method === 'POST') {
      if (!appJwtOk(req)) return ghSend(res, 401, { message: 'A JSON web token could not be decoded', documentation_url: 'https://docs.github.com/rest' });
      const inst = state.github.installations.get(Number(m[1]));
      if (!inst || inst.suspended) return ghSend(res, 404, { message: 'Not Found' });
      const token = id('ghs_', 18);
      const exp = Date.now() + 3600_000;
      state.github.instTokens.set(token, { installation: inst.id, exp });
      return ghSend(res, 201, { token, expires_at: new Date(exp).toISOString().replace(/\.\d+Z$/, 'Z'), permissions: { contents: 'read', metadata: 'read' }, repository_selection: 'selected' });
    }
    if ((m = /^\/app\/installations\/(\d+)$/.exec(p))) {
      if (!appJwtOk(req)) return ghSend(res, 401, { message: 'A JSON web token could not be decoded', documentation_url: 'https://docs.github.com/rest' });
      const inst = state.github.installations.get(Number(m[1]));
      if (!inst) return ghSend(res, 404, { message: 'Not Found' });
      if (req.method === 'GET') return ghSend(res, 200, { id: inst.id, account: inst.account, app_slug: 'tinytown', suspended_at: inst.suspended ? new Date().toISOString() : null });
      if (req.method === 'DELETE') {
        state.github.installations.delete(inst.id);
        return send(res, 204, null);
      }
    }
    if (p === '/user/installations' && req.method === 'GET') {
      const login = bearer && state.github.userTokens.get(bearer);
      if (!login) return ghSend(res, 401, { message: 'Bad credentials' });
      const mine = [...state.github.installations.values()].filter((i) => i.account.login === login);
      return ghSend(res, 200, { total_count: mine.length, installations: paged(mine).map((i) => ({ id: i.id, account: i.account, app_slug: 'tinytown', target_type: 'User' })) });
    }
    if (p === '/user' && req.method === 'GET') {
      const login = bearer && state.github.userTokens.get(bearer);
      return login ? ghSend(res, 200, { login, id: 1 }) : ghSend(res, 401, { message: 'Bad credentials' });
    }

    const inst = (() => {
      const t = bearer && state.github.instTokens.get(bearer);
      return t && t.exp > Date.now() ? state.github.installations.get(t.installation) : null;
    })();
    if (p === '/installation/repositories' && req.method === 'GET') {
      if (!inst) return ghSend(res, 401, { message: 'Bad credentials' });
      return ghSend(res, 200, { total_count: inst.repos.length, repository_selection: 'selected', repositories: paged(inst.repos) });
    }
    if ((m = /^\/repos\/([\w.-]+\/[\w.-]+)(\/commits|\/releases)?$/.exec(p)) && req.method === 'GET') {
      const repo = inst?.repos.find((r) => r.full_name.toLowerCase() === m[1].toLowerCase());
      if (!repo) return ghSend(res, 404, { message: 'Not Found' });
      if (!m[2]) return ghSend(res, 200, repo);
      const all = m[2] === '/commits' ? founderCommits(repo.full_name) : founderReleases(repo.full_name);
      return ghSend(res, 200, paged(all));
    }
    unhandled('github', req.method, p);
    return ghSend(res, 404, { message: 'Not Found (the fake GitHub has no such route)' });
  }

  // ── PostHog ─────────────────────────────────────────────────────────────

  function posthog(req, res, url) {
    const m = /^\/posthog\/api\/projects\/(\d+)\/query\/?$/.exec(url.pathname);
    if (!m || req.method !== 'POST') {
      unhandled('posthog', req.method, url.pathname);
      return send(res, 404, { detail: 'Not found.' });
    }
    const key = /^Bearer\s+(phx_\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!key || key.includes('bad')) return send(res, 401, { detail: 'Invalid personal API key.' });
    const rnd = prng(`posthog:${m[1]}`);
    const days = [];
    const data = [];
    let mau = 400 + Math.floor(rnd() * 400);
    for (let d = 364; d >= 0; d--) {
      days.push(new Date(Date.now() - d * DAY).toISOString().slice(0, 10));
      mau = Math.max(0, Math.round(mau * (1 + (rnd() - 0.4) * 0.02)));
      data.push(mau);
    }
    return send(res, 200, { results: [{ days, data, label: 'All events' }] });
  }

  // ── Control: for tools and tests ────────────────────────────────────────

  async function control(req, res, url, body) {
    const p = url.pathname.slice('/__fake'.length);
    const json = () => (body.length ? JSON.parse(body.toString('utf8')) : {});
    if (p === '/mailbox' && req.method === 'GET') {
      const to = url.searchParams.get('email')?.toLowerCase();
      const mail = state.mailbox.filter((x) => !to || x.to === to);
      return send(res, 200, { messages: mail.slice(-20), latest: mail.at(-1) ?? null });
    }
    if (p === '/stats') return send(res, 200, stats());
    if (p === '/stats/reset' && req.method === 'POST') {
      resetStats();
      return send(res, 200, { ok: true });
    }
    if (p === '/session' && req.method === 'POST') {
      const b = json();
      return send(res, 200, createSession(createUser(b.email)));
    }
    if ((p === '/tables' || p.startsWith('/tables/')) && req.method === 'GET') {
      const name = p.slice('/tables/'.length);
      return send(res, 200, name ? (state.tables[name] ?? null) : Object.fromEntries(Object.entries(state.tables).map(([k, v]) => [k, v.length])));
    }
    if (p === '/stripe' && req.method === 'GET') return send(res, 200, { customers: [...state.stripe.customers.values()], subscriptions: [...state.stripe.subscriptions.values()], deliveries: state.stripe.deliveries });
    return send(res, 404, { error: 'unknown control route' });
  }

  // ── The router ──────────────────────────────────────────────────────────

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    if (req.method === 'OPTIONS') {
      return send(res, 204, null, { 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? '*', 'Access-Control-Max-Age': '600' });
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (opts.log) console.log(`[fakes] ${req.method} ${url.pathname}`);
    const service = url.pathname.startsWith('/auth/v1')
      ? 'auth'
      : url.pathname.startsWith('/rest/v1')
        ? 'rest'
        : url.pathname.startsWith('/stripe-pages')
          ? 'stripe-pages'
          : url.pathname.startsWith('/stripe/')
            ? 'stripe'
            : url.pathname.startsWith('/github-api')
              ? 'github'
              : url.pathname.startsWith('/github/')
                ? 'github-web'
                : url.pathname.startsWith('/posthog')
                  ? 'posthog'
                  : url.pathname.startsWith('/__sink/')
                    ? 'sink'
                    : 'control';
    if (service !== 'control') count(service, req.method, url.pathname.replace(/^\/(auth\/v1|rest\/v1|stripe-pages|stripe|github-api|github|posthog)/, ''));
    const delay = latency[service === 'github-web' ? 'github' : service === 'stripe-pages' ? 'stripe' : service];
    if (delay) await sleep(delay * (0.7 + Math.random() * 0.6));
    try {
      if (service === 'auth') return await auth(req, res, url, body);
      if (service === 'rest') return await rest(req, res, url, body);
      if (service === 'stripe') return await stripeApi(req, res, url, body);
      if (service === 'stripe-pages') return await stripePages(req, res, url, body);
      if (service === 'github') return await githubApi(req, res, url, body);
      if (service === 'github-web') return await githubWeb(req, res, url, body);
      if (service === 'posthog') return posthog(req, res, url);
      if (service === 'sink') {
        const [, , host, ...rest] = url.pathname.split('/');
        state.sink.push({ host, method: req.method, path: `/${rest.join('/')}`, at: Date.now(), bytes: body.length });
        return send(res, 200, { id: id('sink_'), ok: true });
      }
      return await control(req, res, url, body);
    } catch (err) {
      if (err instanceof PgError) return send(res, err.status, err.body);
      if (err instanceof SyntaxError) return send(res, 400, { code: 'PGRST102', message: `Bad JSON: ${err.message}` });
      console.error(`[fakes] ${req.method} ${url.pathname} crashed: ${err.stack ?? err}`);
      return send(res, 500, { message: `fake crashed: ${err.message}` });
    }
  });
  server.keepAliveTimeout = 30_000;
  await new Promise((r) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', r));
  const base = `http://${opts.host ?? '127.0.0.1'}:${server.address().port}`;

  return {
    url: base,
    anonKey,
    serviceKey,
    schema,
    state,
    stats,
    resetStats,
    createUser,
    createSession,
    sendMagicLink,
    founderAccount,
    installationFor,
    githubUserCode,
    issueStripeTokens,
    emit,
    deliver,
    /** The newest magic link sent to this address. */
    latestLink: (email) => state.mailbox.filter((x) => x.to === email.toLowerCase()).at(-1)?.link ?? null,
    rows: (table) => state.tables[table] ?? [],
    /** Inserts a row as PostgREST would (defaults, keys, foreign keys); for seeding. */
    insert: (table, row) => insertRow(tableOf(table), row),
    setAppUrl: (u) => (state.appUrl = u),
    setWebhookSecret: (s) => (state.webhookSecret = s),
    close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(() => r()))),
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────

if (isMain) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const appUrl = arg('app', 'http://127.0.0.1:8787');
  const webhookSecret = arg('webhook-secret', 'whsec_fake_local');
  const latency = Object.fromEntries((arg('latency', '') || '').split(',').filter(Boolean).map((kv) => kv.split('=')).map(([k, v]) => [k, Number(v)]));
  const fakes = await startFakes({ port: Number(arg('port', 8790)), appUrl, webhookSecret, latency, log: process.argv.includes('--log') });
  console.log(`Fake providers on ${fakes.url} (tables from ${fakes.schema.files.length} migrations: ${Object.keys(fakes.schema.tables).join(', ')})`);
  console.log(`
Run the server against them:

  FAKE_PROVIDERS_URL=${fakes.url} \\
  APP_URL=${appUrl} SUPABASE_URL=${fakes.url} SUPABASE_ANON_KEY=${fakes.anonKey} SUPABASE_SERVICE_ROLE_KEY=${fakes.serviceKey} \\
  TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32) STATE_SECRET=local-state-secret \\
  STRIPE_BILLING_SECRET_KEY=sk_test_fake STRIPE_WEBHOOK_SECRET=${webhookSecret} STRIPE_PRICE_MONTHLY=price_month STRIPE_PRICE_YEARLY=price_year \\
  STRIPE_APP_CLIENT_ID=ca_fake STRIPE_APP_INSTALL_URL=${fakes.url}/stripe-pages/oauth/v2/authorize ALLOW_TEST_MODE=1 \\
  GITHUB_APP_SLUG=tinytown-local GITHUB_APP_ID=1 GITHUB_APP_CLIENT_ID=Iv1.fake GITHUB_APP_CLIENT_SECRET=fake GITHUB_APP_PRIVATE_KEY="$(openssl genrsa 2048 2>/dev/null | base64 -w0)" \\
  node --import ./tools/fake-providers.mjs server/index.ts

Magic links: GET ${fakes.url}/__fake/mailbox?email=you@example.com · call counts: GET ${fakes.url}/__fake/stats`);
}
