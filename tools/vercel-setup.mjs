#!/usr/bin/env node
/**
 * Sets up TinyTown's Vercel project through the REST API, in one command:
 *
 *   VERCEL_TOKEN=… node tools/vercel-setup.mjs --project tinytown --team my-team --apply
 *
 * It reads first and only changes what isn't right yet:
 * - finds the project (imported from GitHub by the owner) and sets its
 *   production branch to `main` and Node.js to 22.x;
 * - upserts the environment variables TinyTown needs, separately for
 *   Production and Preview: values handed over by tools/launch.mjs or
 *   tools/supabase-setup.mjs, the provider values in this process's
 *   environment (the cloud secrets), and four secrets it generates itself
 *   (TOKEN_ENCRYPTION_KEY, STATE_SECRET, CRON_SECRET, HEALTH_SECRET: 32 random
 *   bytes, base64). A generated secret is made only when Vercel has none, and a
 *   re-run never rotates it: a new TOKEN_ENCRYPTION_KEY would lock every
 *   founder out of their stored connections. Secrets are stored as Sensitive;
 *   a live Stripe key never goes to Preview;
 * - a feature whose variables would end up half set (say, the billing key
 *   without its webhook secret) is held back, because the build refuses a
 *   half-set feature (server/env.ts) and would fail the deploy;
 * - with --deploy, deploys the GitHub branch (Preview, or Production with
 *   --production), waits until it's READY or fails, and checks /api/config
 *   (hosted, and no secret in it) and /api/health.
 *
 * Values are never printed: only names and what happened to them ("set",
 * "unchanged", "kept"). Vercel can't show a Sensitive value back, so each
 * managed variable carries a short fingerprint of its value in its comment,
 * which is how a re-run knows it has nothing to change.
 *
 * Dry run by default: nothing changes without --apply.
 *
 * Flags:
 *   --project <name>   the Vercel project's name (or id)
 *   --team <slug>      the team that owns it (its slug, or a team_ id)
 *   --domain <domain>  the production domain, for APP_URL (otherwise Vercel's own address is used)
 *   --deploy           deploy after setting the variables (Preview unless --production)
 *   --production       deploy to Production
 *   --branch <name>    the branch to deploy (default: the current git branch; main for Production)
 *   --apply            make the changes (otherwise a dry run that only reads)
 *
 * Plain fetch, no dependencies.
 */
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readPem } from '../server/env.ts';

export const API = 'https://api.vercel.com';
export const TARGETS = ['production', 'preview'];
export const PRODUCTION_BRANCH = 'main';
export const NODE_VERSION = '22.x';

/** Made here when Vercel has none; never replaced afterwards. */
export const GENERATED = ['TOKEN_ENCRYPTION_KEY', 'STATE_SECRET', 'CRON_SECRET', 'HEALTH_SECRET'];

/** Stored as Sensitive: nobody can read them back, not even in Vercel's dashboard. */
export const SECRET_NAMES = new Set([
  ...GENERATED,
  'TOKEN_ENCRYPTION_KEY_OLD',
  'SUPABASE_SERVICE_ROLE_KEY',
  'STRIPE_BILLING_SECRET_KEY',
  'STRIPE_APP_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'GITHUB_APP_CLIENT_SECRET',
  'GITHUB_APP_PRIVATE_KEY',
  'RESEND_API_KEY',
]);

/**
 * The features that need all of their variables or none (GROUPS in
 * server/env.ts; tests/tools-vercel-setup.test.ts checks they agree). The
 * build stops on a half-set one, so a half-set plan is held back instead.
 */
export const ENV_GROUPS = [
  { name: 'Supabase (accounts)', vars: ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] },
  { name: 'Secrets for connections', vars: ['TOKEN_ENCRYPTION_KEY', 'STATE_SECRET'] },
  { name: 'Billing', vars: ['STRIPE_BILLING_SECRET_KEY', 'STRIPE_PRICE_YEARLY', 'STRIPE_WEBHOOK_SECRET'] },
  { name: 'The GitHub App', vars: ['GITHUB_APP_SLUG', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_PRIVATE_KEY'] },
];

export const newSecret = () => randomBytes(32).toString('base64');
const isLiveStripeKey = (v) => typeof v === 'string' && /^(sk|rk)_live_/.test(v);

// ─── Arguments ────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const out = { project: null, team: null, domain: null, deploy: false, production: false, branch: null, apply: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const eq = raw.indexOf('=');
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const take = () => {
      if (eq > 0) return raw.slice(eq + 1);
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value.`);
      return v;
    };
    if (flag === '--apply') out.apply = true;
    else if (flag === '--dry-run') out.apply = false;
    else if (flag === '--deploy') out.deploy = true;
    else if (flag === '--production') out.production = true;
    else if (flag === '--help' || flag === '-h') out.help = true;
    else if (flag === '--project') out.project = take();
    else if (flag === '--team') out.team = take();
    else if (flag === '--domain') out.domain = take();
    else if (flag === '--branch') out.branch = take();
    else throw new Error(`Unknown argument: ${raw}`);
  }
  return out;
}

/** A bare domain ("tinytown.app") or an https address → "https://tinytown.app". */
export function domainUrl(raw) {
  if (!raw) return null;
  let u;
  try {
    u = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error(`--domain isn't a domain: ${raw}`);
  }
  if (u.protocol !== 'https:') throw new Error('--domain must be served over https.');
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) throw new Error('--domain is the domain alone, like tinytown.app.');
  return u.origin;
}

// ─── Vercel over fetch ────────────────────────────────────────────────────

export class VercelSetupError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function messageOf(status, data) {
  const m = data?.error?.message ?? (typeof data?.message === 'string' ? data.message : null);
  if (status === 401) return 'Vercel refused VERCEL_TOKEN (401). Make a new token under Account Settings → Tokens, scoped to the team.';
  if (status === 403) return `VERCEL_TOKEN can't do this (403)${m ? `: ${m}` : ''}. Check the token's scope includes the team, and pass --team <slug>.`;
  return m ?? `Vercel responded ${status}`;
}

/**
 * `api(method, path, { body, query })`, scoped to the team. Everything but
 * creating a deployment is safe to repeat, so it's retried on a network
 * error, a 429 or a 5xx; a deployment only on a 429.
 */
export function vercelClient({ token, team = null, fetch: fetchImpl = globalThis.fetch, retryDelayMs = 500 }) {
  if (!token) throw new Error('Set VERCEL_TOKEN to a Vercel access token (Account Settings → Tokens, scoped to the team).');
  const scope = team ? (team.startsWith('team_') ? { teamId: team } : { slug: team }) : {};
  async function api(method, path, { body, query = {} } = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...query, ...scope })) if (v !== undefined && v !== null) q.set(k, String(v));
    const url = `${API}${path}${q.size ? `?${q}` : ''}`;
    const repeatable = !(method === 'POST' && path.startsWith('/v13/deployments'));
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(url, {
          method,
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (err) {
        if (repeatable && attempt < 2) {
          await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
          continue;
        }
        throw new VercelSetupError(0, `Vercel could not be reached (${err?.message ?? 'network error'}).`);
      }
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      if (res.ok) return data;
      if (attempt < 2 && (res.status === 429 || (repeatable && res.status >= 500))) {
        await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
        continue;
      }
      throw new VercelSetupError(res.status, messageOf(res.status, data), data?.error?.code);
    }
  }
  api.team = team;
  return api;
}

// ─── The project ──────────────────────────────────────────────────────────

export async function findProject(api, name) {
  if (!name) throw new Error('Pass --project <name>: the Vercel project imported from GitHub.');
  return api('GET', `/v9/projects/${encodeURIComponent(name)}`).catch((err) => {
    if (err.status === 404) {
      throw new Error(`No Vercel project called "${name}"${api.team ? ` in the team ${api.team}` : ' in your personal account (pass --team <slug> for a team)'}. Import the repository at vercel.com/new first.`);
    }
    throw err;
  });
}

/** The team's slug, for the preview redirect pattern (https://*-<slug>.vercel.app). */
export async function teamSlug(api) {
  if (!api.team) return null;
  if (!api.team.startsWith('team_')) return api.team;
  const t = await api('GET', `/v2/teams/${api.team}`).catch(() => null);
  return t?.slug ?? null;
}

/**
 * The production address: a custom domain on the project if there is one,
 * else Vercel's own. APP_URL falls back to the same on Vercel.
 */
export async function productionUrl(api, project) {
  const res = await api('GET', `/v9/projects/${project.id}/domains`, { query: { production: 'true' } }).catch(() => null);
  const domains = (res?.domains ?? []).filter((d) => !d.redirect && !d.gitBranch && d.verified !== false);
  const custom = domains.find((d) => !d.name.endsWith('.vercel.app'));
  const own = domains.find((d) => d.name.endsWith('.vercel.app'));
  return `https://${(custom ?? own)?.name ?? `${project.name}.vercel.app`}`;
}

/** Production branch `main` and Node 22. Returns `{ steps, notes }`. */
export async function ensureProject(api, project, { dryRun }) {
  const steps = [];
  const notes = [];
  const link = project.link;
  if (!link?.type) {
    steps.push({ thing: 'Git repository', action: 'not connected', id: 'deploys need it' });
    notes.push('The project isn’t connected to a Git repository: Settings → Git → Connect Git Repository, then run this again.');
  } else {
    steps.push({ thing: 'Git repository', action: 'connected', id: `${link.type}: ${[link.org, link.repo].filter(Boolean).join('/') || link.repoId}` });
    if (link.productionBranch === PRODUCTION_BRANCH) steps.push({ thing: 'Production branch', action: 'unchanged', id: PRODUCTION_BRANCH });
    else if (dryRun) steps.push({ thing: 'Production branch', action: 'would set', id: `${PRODUCTION_BRANCH} (now ${link.productionBranch ?? 'unset'})` });
    else {
      // Not in Vercel's documented API: this is the route its dashboard uses. If it's refused, say how to do it by hand.
      const ok = await api('PATCH', `/v9/projects/${project.id}/branch`, { body: { branch: PRODUCTION_BRANCH } }).then(
        () => true,
        () => false,
      );
      if (ok) steps.push({ thing: 'Production branch', action: 'set', id: PRODUCTION_BRANCH });
      else {
        steps.push({ thing: 'Production branch', action: 'by hand', id: `${PRODUCTION_BRANCH} (now ${link.productionBranch ?? 'unset'})` });
        notes.push(`Vercel's API wouldn't change the production branch. Set it by hand: the project → Settings → Git → Production Branch → ${PRODUCTION_BRANCH}.`);
      }
    }
  }
  if (project.nodeVersion === NODE_VERSION) steps.push({ thing: 'Node.js version', action: 'unchanged', id: NODE_VERSION });
  else {
    if (!dryRun) await api('PATCH', `/v9/projects/${project.id}`, { body: { nodeVersion: NODE_VERSION } });
    steps.push({ thing: 'Node.js version', action: dryRun ? 'would set' : 'set', id: `${NODE_VERSION} (was ${project.nodeVersion ?? 'unset'})` });
  }
  return { steps, notes };
}

// ─── Environment variables ────────────────────────────────────────────────

/** A short one-way fingerprint of a value, kept in the variable's comment so a re-run can tell it's unchanged. */
export function fingerprint(key, value) {
  return createHash('sha256').update(`tinytown-env:${key}:${value}`).digest('hex').slice(0, 16);
}
const FP = /\bfp:([0-9a-f]{16})\b/;
const commentFor = (key, value, generated) =>
  generated
    ? key === 'TOKEN_ENCRYPTION_KEY'
      ? `Generated by TinyTown's setup. Never change it: founders' stored connections are sealed with it (docs/SECURITY.md to rotate). fp:${fingerprint(key, value)}`
      : `Generated by TinyTown's setup; a re-run keeps it. fp:${fingerprint(key, value)}`
    : `Set by TinyTown's setup (tools/vercel-setup.mjs). fp:${fingerprint(key, value)}`;

/** Does this existing variable already hold `value`? Readable ones are compared; Sensitive ones by fingerprint. */
function holds(record, key, value) {
  if (record.type === 'plain' || record.decrypted === true) return record.value === value;
  return FP.exec(record.comment ?? '')?.[1] === fingerprint(key, value);
}

/** The variables Vercel has now: every one with a target, leaving out branch-only and custom-environment ones. */
export async function listEnv(api, project) {
  const res = await api('GET', `/v10/projects/${project.id}/env`, { query: { decrypt: 'true' } });
  return (res?.envs ?? []).filter((e) => !e.gitBranch && !(e.customEnvironmentIds?.length) && Array.isArray(e.target) && e.target.length);
}

/**
 * Turns what's there (`existing`) and what's wanted (`desired`) into
 * operations, without calling anything. Each desired entry is
 * `{ key, secret, values: { production?, preview? }, generate?, remove? }`:
 * a string sets that value, `null` keeps whatever is there (say, a webhook
 * secret Stripe shows only once), `generate` lists targets that get a fresh
 * secret only if they have none, `remove` lists targets to take it off.
 *
 * Returns `{ ops, status, heldBack, generated }`: `status` maps
 * `KEY` → `target` → what happens, for the report; `generated` holds new
 * values in memory (`target` → `KEY` → value).
 */
export function planEnv(existing, desired) {
  const ops = [];
  const status = {};
  const generated = { production: {}, preview: {} };
  const mark = (key, t, s) => ((status[key] ??= {})[t] = s);
  const records = (key) => existing.filter((e) => e.key === key);
  const covers = (key, t) => records(key).some((e) => e.target.includes(t));

  // Hold back a feature that would end up half set on a target: the build would refuse it.
  const heldBack = [];
  const byKey = new Map(desired.map((d) => [d.key, d]));
  for (const t of TARGETS) {
    for (const g of ENV_GROUPS) {
      const present = (k) => {
        const d = byKey.get(k);
        if (d?.remove?.includes(t)) return false;
        if (typeof d?.values?.[t] === 'string' || d?.generate?.includes(t)) return true;
        return covers(k, t);
      };
      const missing = g.vars.filter((k) => !present(k));
      if (!missing.length || missing.length === g.vars.length) continue;
      const planned = g.vars.filter((k) => typeof byKey.get(k)?.values?.[t] === 'string');
      for (const k of planned) {
        const d = byKey.get(k);
        byKey.set(k, { ...d, values: { ...d.values, [t]: undefined } });
        mark(k, t, 'held back');
      }
      const stillHalf = g.vars.some((k) => covers(k, t) && !byKey.get(k)?.remove?.includes(t));
      heldBack.push({ group: g.name, target: t, missing, planned, alreadyHalfSet: stillHalf });
    }
  }

  for (const d0 of desired) {
    const d = byKey.get(d0.key);
    const key = d.key;
    const type = d.secret ? 'sensitive' : 'encrypted';
    const recs = records(key);

    if (d.generate?.length) {
      for (const t of d.generate) {
        if (covers(key, t)) mark(key, t, 'kept');
        else {
          const value = newSecret();
          generated[t][key] = value;
          ops.push({ op: 'create', key, targets: [t], value, type: 'sensitive', comment: commentFor(key, value, true) });
          mark(key, t, 'generated');
        }
      }
      continue;
    }

    const values = d.values ?? {};
    const remove = d.remove ?? [];
    const want = TARGETS.filter((t) => typeof values[t] === 'string');
    const keep = TARGETS.filter((t) => values[t] === null);
    const managed = new Set([...want, ...keep, ...remove]);
    const handled = new Set();
    for (const r of recs) {
      const mine = r.target.filter((t) => managed.has(t));
      if (!mine.length) continue;
      if (!mine.some((t) => want.includes(t) || remove.includes(t))) {
        for (const t of mine) mark(key, t, 'kept');
        continue;
      }
      const wanted = mine.filter((t) => want.includes(t));
      const one = new Set(wanted.map((t) => values[t]));
      if (wanted.length === mine.length && one.size === 1) {
        // Every target of ours on this variable wants the same value: change it in place.
        const value = values[wanted[0]];
        if (holds(r, key, value)) for (const t of wanted) mark(key, t, 'unchanged');
        else {
          ops.push({ op: 'update', id: r.id, key, targets: r.target, value, comment: commentFor(key, value, false) });
          for (const t of wanted) mark(key, t, 'updated');
        }
        for (const t of wanted) handled.add(t);
        continue;
      }
      // Shared with a target that keeps its value, gets another value, or loses it: split it.
      const rest = r.target.filter((t) => !want.includes(t) && !remove.includes(t));
      if (rest.length) ops.push({ op: 'retarget', id: r.id, key, targets: rest });
      else ops.push({ op: 'delete', id: r.id, key });
      for (const t of mine) if (remove.includes(t)) mark(key, t, 'removed');
      for (const t of mine) if (keep.includes(t)) mark(key, t, 'kept');
    }
    for (const t of keep) if (!status[key]?.[t]) mark(key, t, covers(key, t) ? 'kept' : 'missing');
    // What's left gets new variables; targets wanting the same value share one.
    const left = want.filter((t) => !handled.has(t));
    const groups = new Map();
    for (const t of left) groups.set(values[t], [...(groups.get(values[t]) ?? []), t]);
    for (const [value, targets] of groups) {
      ops.push({ op: 'create', key, targets, value, type, comment: commentFor(key, value, false) });
      for (const t of targets) mark(key, t, 'set');
    }
  }
  // Fewer moving parts first: shrink and delete before creating, so a create never meets an old copy.
  const order = { retarget: 0, delete: 1, create: 2, update: 3 };
  ops.sort((a, b) => order[a.op] - order[b.op]);
  return { ops, status, heldBack, generated };
}

/** Guards that hold whatever the caller passes: test money on Preview, and no test-mode switch next to live billing. */
function checkDesired(desired) {
  for (const d of desired) {
    if (isLiveStripeKey(d.values?.preview)) throw new Error(`Refusing to put a live Stripe key in Preview (${d.key}). Preview deploys run unreviewed code: they get test keys only.`);
  }
  const billing = desired.find((d) => d.key === 'STRIPE_BILLING_SECRET_KEY')?.values?.production;
  const testMode = desired.find((d) => d.key === 'ALLOW_TEST_MODE')?.values?.production;
  if (isLiveStripeKey(billing) && testMode === '1') throw new Error('Refusing to set ALLOW_TEST_MODE=1 on Production next to a live billing key: test data would drive real cities.');
}

/**
 * Plans and (unless `dryRun`) applies the variables. Returns
 * `{ steps, notes, heldBack, generated }`; nothing in it is a value except
 * `generated`, which stays in memory for the smoke checks.
 */
export async function syncEnv(api, project, desired, { dryRun }) {
  checkDesired(desired);
  const existing = await listEnv(api, project);
  const plan = planEnv(existing, desired);
  if (!dryRun) {
    for (const o of plan.ops) {
      if (o.op === 'retarget') await api('PATCH', `/v9/projects/${project.id}/env/${o.id}`, { body: { target: o.targets } });
      else if (o.op === 'delete') await api('DELETE', `/v9/projects/${project.id}/env/${o.id}`);
      else if (o.op === 'update') await api('PATCH', `/v9/projects/${project.id}/env/${o.id}`, { body: { value: o.value, comment: o.comment } });
      else {
        const res = await api('POST', `/v10/projects/${project.id}/env`, { query: { upsert: 'true' }, body: { key: o.key, value: o.value, type: o.type, target: o.targets, comment: o.comment } });
        const failed = res?.failed ?? [];
        if (failed.length) throw new Error(`Vercel didn't save ${o.key} (${o.targets.join(', ')}): ${failed.map((f) => f.error?.message ?? f.error?.code ?? 'unknown error').join('; ')}`);
      }
    }
  }
  const would = { set: 'would set', updated: 'would update', generated: 'would generate', removed: 'would remove' };
  const steps = [];
  for (const [key, byTarget] of Object.entries(plan.status)) {
    const groups = new Map();
    for (const t of TARGETS) {
      const s = byTarget[t];
      if (!s) continue;
      const label = dryRun ? (would[s] ?? s) : s;
      groups.set(label, [...(groups.get(label) ?? []), t]);
    }
    for (const [action, targets] of groups) steps.push({ thing: key, action, id: targets.join(', ') });
  }
  const notes = [];
  for (const h of plan.heldBack) {
    notes.push(
      `${h.group} held back on ${h.target}: ${h.missing.join(', ')} ${h.missing.length === 1 ? 'is' : 'are'} missing, and a half-set feature fails the build.${h.alreadyHalfSet ? ` Vercel already has part of it on ${h.target}, so the next build there fails until the rest is set.` : ''}`,
    );
  }
  return { steps, notes, heldBack: plan.heldBack, generated: plan.generated, status: plan.status };
}

/**
 * Everything TinyTown's server reads, per target, from what the other steps
 * found and the cloud secrets in `env`. Returns `{ desired, missing }`;
 * `missing` names what the owner still has to provide.
 *
 * - `supabase`: `{ url, anonKey, serviceKey }` (both targets);
 * - `stripe`: `{ production, preview }`, each `{ mode, key, env }` from
 *   tools/stripe-setup.mjs (`env` as `setupStripe()` returns it), or null;
 * - `appUrl`: APP_URL for Production (Preview returns people to itself).
 */
export function tinytownEnv({ supabase = null, stripe = {}, appUrl = null, env = process.env, emailFrom = null, adminEmails = null }) {
  const map = new Map();
  const entry = (key) => {
    if (!map.has(key)) map.set(key, { key, secret: SECRET_NAMES.has(key), values: {}, remove: [] });
    return map.get(key);
  };
  const set = (key, t, value) => (entry(key).values[t] = value);
  const both = (key, value) => TARGETS.forEach((t) => set(key, t, value));
  const missing = [];
  const get = (name) => env[name]?.trim() || null;

  if (supabase) {
    both('SUPABASE_URL', supabase.url);
    both('SUPABASE_ANON_KEY', supabase.anonKey);
    both('SUPABASE_SERVICE_ROLE_KEY', supabase.serviceKey);
  }
  for (const key of GENERATED) entry(key).generate = [...TARGETS];
  if (appUrl) set('APP_URL', 'production', appUrl);

  for (const t of TARGETS) {
    const s = stripe[t];
    if (!s) continue;
    set('STRIPE_BILLING_SECRET_KEY', t, s.key);
    // The Stripe App's code exchange needs a full secret key; a restricted one falls back to nothing.
    if (/^sk_/.test(s.key)) set('STRIPE_APP_SECRET_KEY', t, s.key);
    for (const k of ['STRIPE_PRICE_YEARLY', 'STRIPE_OFFER_COUPON', 'STRIPE_PORTAL_CONFIGURATION']) if (typeof s.env[k] === 'string') set(k, t, s.env[k]);
    // Stripe shows a webhook's secret once, when it's made; otherwise keep the one Vercel has.
    set('STRIPE_WEBHOOK_SECRET', t, typeof s.env.STRIPE_WEBHOOK_SECRET === 'string' ? s.env.STRIPE_WEBHOOK_SECRET : null);
    // Sold by the year only: a monthly price in the environment would go on sale.
    entry('STRIPE_PRICE_MONTHLY').remove.push(t);
    // Test-mode Stripe data may drive a city only where billing is in test mode too.
    if (s.mode === 'test') set('ALLOW_TEST_MODE', t, '1');
    else entry('ALLOW_TEST_MODE').remove.push(t);
  }

  const gh = ['GITHUB_APP_ID', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_SLUG', 'GITHUB_APP_PRIVATE_KEY'];
  for (const k of gh) {
    let v = get(k);
    if (!v) {
      missing.push(k);
      continue;
    }
    if (k === 'GITHUB_APP_PRIVATE_KEY') {
      try {
        createPrivateKey(readPem(v));
      } catch {
        missing.push(`${k} (set, but not a readable private key: paste the whole .pem file, BEGIN and END lines included)`);
        continue;
      }
      // One line, so it survives any copy and paste; server/env.ts readPem() takes it either way.
      if (v.startsWith('-----')) v = Buffer.from(readPem(v), 'utf8').toString('base64');
    }
    both(k, v);
  }
  const clientId = get('STRIPE_APP_CLIENT_ID');
  if (clientId) both('STRIPE_APP_CLIENT_ID', clientId);
  else missing.push('STRIPE_APP_CLIENT_ID');
  const resend = get('RESEND_API_KEY');
  if (resend) both('RESEND_API_KEY', resend);
  else missing.push('RESEND_API_KEY');
  if (emailFrom) both('EMAIL_FROM', emailFrom);
  else missing.push('EMAIL_FROM (--email-from)');
  if (adminEmails) both('ADMIN_EMAILS', adminEmails);
  else missing.push('ADMIN_EMAILS (--admin-emails)');

  const desired = [...map.values()].map((d) => (d.remove.length ? d : { ...d, remove: undefined }));
  return { desired, missing };
}

// ─── Deploying and checking ───────────────────────────────────────────────

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** The current local branch, for a preview deploy of what's checked out. */
export function currentBranch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Deploys `branch` from the project's GitHub repository and waits for it.
 * Returns `{ id, url, state, inspectorUrl }`; throws if the build fails.
 */
export async function deploy(api, project, { branch, production = false, timeoutMs = 20 * 60_000, pollMs = 5_000, sleep = sleepMs, onWait = () => {} }) {
  const link = project.link;
  if (link?.type !== 'github' || !link.repoId) throw new Error('The project isn’t connected to a GitHub repository, so there is nothing to deploy from (Settings → Git).');
  if (!branch) throw new Error('No branch to deploy: pass --branch <name>.');
  const created = await api('POST', '/v13/deployments', {
    body: { name: project.name, project: project.id, gitSource: { type: 'github', repoId: link.repoId, ref: branch }, ...(production ? { target: 'production' } : {}) },
  });
  const started = Date.now();
  let d = created;
  for (;;) {
    const state = d.readyState ?? d.status;
    if (state === 'READY') return { id: d.id, url: `https://${d.url}`, state, inspectorUrl: d.inspectorUrl ?? null };
    if (state === 'ERROR' || state === 'CANCELED') {
      throw new Error(`The ${production ? 'production' : 'preview'} deployment ${state === 'ERROR' ? 'failed' : 'was cancelled'}${d.errorMessage ? `: ${d.errorMessage}` : ''}. Build log: ${d.inspectorUrl ?? `https://${d.url}`}`);
    }
    if (Date.now() - started > timeoutMs) throw new Error(`The deployment is still ${state} after ${Math.round(timeoutMs / 60_000)} minutes. Follow it at ${d.inspectorUrl ?? `https://${d.url}`}.`);
    onWait(state);
    await sleep(pollMs);
    d = await api('GET', `/v13/deployments/${created.id}`);
  }
}

/**
 * A secret for Vercel's "Protection Bypass for Automation", so the smoke
 * checks can open a protected preview. Reuses one the project has; makes one
 * only with `dryRun` off. The secret stays in memory.
 */
export async function protectionBypass(api, project, { dryRun }) {
  const existing = Object.entries(project.protectionBypass ?? {}).find(([, v]) => v?.scope === 'automation-bypass')?.[0];
  if (existing) return { secret: existing, step: { thing: 'Protection bypass', action: 'reused', id: 'for automation (not shown)' } };
  if (!project.ssoProtection && !project.passwordProtection) return { secret: null, step: { thing: 'Protection bypass', action: 'not needed', id: 'deployments are not protected' } };
  if (dryRun) return { secret: null, step: { thing: 'Protection bypass', action: 'would create', id: 'for automation, so the smoke checks can open a protected preview' } };
  const res = await api('PATCH', `/v1/projects/${project.id}/protection-bypass`, { body: { generate: { note: 'TinyTown setup smoke checks' } } });
  const secret = Object.entries(res?.protectionBypass ?? {}).find(([, v]) => v?.scope === 'automation-bypass')?.[0] ?? null;
  return { secret, step: { thing: 'Protection bypass', action: secret ? 'created' : 'unavailable', id: 'for automation (not shown)' } };
}

/** Anything that looks like a secret key, as a last line of defence on top of the exact values. */
const SECRET_SHAPES = /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|\bwhsec_[A-Za-z0-9]{8,}|\bsb_secret_[A-Za-z0-9_-]{8,}|\bre_[A-Za-z0-9]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/**
 * `/api/config` (hosted, and no secret in it) and `/api/health` (and the
 * deep check, given HEALTH_SECRET). Returns `[{ name, ok, detail }]`.
 */
export async function smokeCheck({ baseUrl, fetch: fetchImpl = globalThis.fetch, secrets = [], bypass = null, healthSecret = null }) {
  const headers = bypass ? { 'x-vercel-protection-bypass': bypass } : {};
  const checks = [];
  const get = async (path, extra = {}) => {
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, { headers: { ...headers, ...extra }, redirect: 'manual' });
      return { status: res.status, text: await res.text() };
    } catch (err) {
      return { status: 0, text: '', error: err?.message ?? 'network error' };
    }
  };
  const blocked = (r) => (r.status === 401 || r.status === 403 ? ' (Vercel Deployment Protection? Re-run with --apply to make a bypass for automation)' : '');

  const cfg = await get('/api/config');
  let parsed = null;
  try {
    parsed = JSON.parse(cfg.text);
  } catch {
    parsed = null;
  }
  const leaked = secrets.filter((s) => typeof s === 'string' && s.length >= 8 && cfg.text.includes(s)).length;
  if (cfg.status !== 200 || !parsed) checks.push({ name: '/api/config', ok: false, detail: `answered ${cfg.status || cfg.error}${blocked(cfg)}` });
  else if (leaked || SECRET_SHAPES.test(cfg.text)) checks.push({ name: '/api/config', ok: false, detail: `contains a secret${leaked ? ` (${leaked} of the values just set)` : ''}. Take the site down and roll that key` });
  else if (parsed.hosted !== true) checks.push({ name: '/api/config', ok: false, detail: 'says hosted: false (the Supabase variables did not reach this deployment)' });
  else {
    const on = Object.entries(parsed.connect ?? {}).filter(([, v]) => v === true).map(([k]) => k);
    checks.push({ name: '/api/config', ok: true, detail: `hosted, ${parsed.plans?.length ?? 0} plan(s), connect: ${on.length ? on.join(', ') : 'none yet'}, no secrets` });
  }

  const health = await get('/api/health');
  let h = null;
  try {
    h = JSON.parse(health.text);
  } catch {
    h = null;
  }
  checks.push(health.status === 200 && h?.ok === true ? { name: '/api/health', ok: true, detail: `ok${h.release ? `, release ${h.release}` : ''}` } : { name: '/api/health', ok: false, detail: `answered ${health.status || health.error}${blocked(health)}` });

  if (healthSecret) {
    const deep = await get('/api/health?deep=1', { Authorization: `Bearer ${healthSecret}` });
    let body = null;
    try {
      body = JSON.parse(deep.text);
    } catch {
      body = null;
    }
    const failing = Object.entries(body?.checks ?? {}).filter(([, c]) => c && c.ok === false).map(([k, c]) => `${k}${c.detail ? ` (${c.detail})` : ''}`);
    checks.push({ name: '/api/health?deep=1', ok: deep.status === 200, detail: deep.status === 200 ? (failing.length ? `degraded: ${failing.join(', ')}` : 'every dependency ok') : `answered ${deep.status || deep.error}${failing.length ? `: ${failing.join(', ')}` : ''}` });
  }
  return checks;
}

// ─── Reporting ────────────────────────────────────────────────────────────

export function formatSteps(title, steps) {
  const w = Math.max(0, ...steps.map((s) => s.thing.length));
  const a = Math.max(0, ...steps.map((s) => s.action.length));
  return [title, '', ...steps.map((s) => `  ${s.thing.padEnd(w)}  ${s.action.padEnd(a)}  ${s.id}`.trimEnd())].join('\n');
}

/** Replaces any of `secrets` in `text` with a placeholder: everything printed goes through this. */
export function scrub(text, secrets) {
  let out = String(text);
  for (const s of [...secrets].filter((v) => typeof v === 'string' && v.length >= 8).sort((a, b) => b.length - a.length)) out = out.split(s).join('<hidden>');
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: VERCEL_TOKEN=… node tools/vercel-setup.mjs --project <name> [--team <slug>] [--domain <domain>] [--deploy [--production] [--branch <name>]] [--apply]');
    return;
  }
  const dryRun = !args.apply;
  const api = vercelClient({ token: process.env.VERCEL_TOKEN?.trim(), team: args.team });
  const project = await findProject(api, args.project);
  const proj = await ensureProject(api, project, { dryRun });
  const appUrl = domainUrl(args.domain);
  // Standalone, it sets what the cloud secrets hold and the generated secrets; tools/launch.mjs adds Stripe and Supabase.
  const { desired, missing } = tinytownEnv({ appUrl, env: process.env });
  const synced = await syncEnv(api, project, desired, { dryRun });
  const secrets = [...desired.filter((d) => d.secret).flatMap((d) => Object.values(d.values ?? {})), ...TARGETS.flatMap((t) => Object.values(synced.generated[t])), process.env.VERCEL_TOKEN].filter((v) => typeof v === 'string');
  const print = (s) => console.log(scrub(s, secrets));
  print(`TinyTown Vercel setup for ${project.name}${dryRun ? '. Dry run: nothing was changed (add --apply).' : '.'}\n`);
  print(formatSteps('Project', proj.steps));
  print(`\n${formatSteps('Environment variables', synced.steps)}`);
  const notes = [...proj.notes, ...synced.notes, ...(missing.length ? [`Not in this environment, so not set: ${missing.join(', ')}.`] : [])];
  if (notes.length) print(`\nNotes:\n${notes.map((n) => `  - ${n}`).join('\n')}`);
  if (!args.deploy) return;
  const branch = args.branch ?? (args.production ? PRODUCTION_BRANCH : currentBranch());
  if (dryRun) {
    print(`\nWould deploy ${branch} to ${args.production ? 'Production' : 'Preview'}, then check /api/config and /api/health.`);
    return;
  }
  const d = await deploy(api, project, { branch, production: args.production, onWait: (s) => process.stdout.write(`  ${s.toLowerCase()}…\r`) });
  print(`\nDeployed: ${d.url}`);
  const bypass = await protectionBypass(api, await findProject(api, project.id), { dryRun });
  const base = args.production ? (appUrl ?? (await productionUrl(api, project))) : d.url;
  const checks = await smokeCheck({ baseUrl: base, secrets, bypass: bypass.secret, healthSecret: synced.generated[args.production ? 'production' : 'preview'].HEALTH_SECRET ?? null });
  for (const c of checks) print(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}: ${c.detail}`);
  if (checks.some((c) => !c.ok)) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\n${err.message}`);
    process.exit(1);
  });
}
