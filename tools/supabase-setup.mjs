#!/usr/bin/env node
/**
 * Sets up TinyTown's Supabase project through the Management API, in one command:
 *
 *   SUPABASE_ACCESS_TOKEN=sbp_… node tools/supabase-setup.mjs --ref <project-ref> --site-url https://tinytown.example --apply
 *
 * It reads first and only changes what isn't right yet:
 * - checks the project exists and is up (not paused, not still starting);
 * - applies supabase/migrations/*.sql in order, each file in one request with
 *   its row in Supabase's own migration history
 *   (supabase_migrations.schema_migrations, the table `supabase db push` and
 *   the CI "Migrate database" workflow read), so the two always agree. Files
 *   already in the history are skipped; the first one that fails stops the run;
 * - sets Auth: the site URL, the redirect allow-list (the site, /admin.html,
 *   localhost:5173 for development, and Vercel previews), email sign-in with
 *   confirmation on and hour-long links, the six branded email templates with
 *   their subjects, and, given a Resend key and a from-address, custom SMTP
 *   through Resend with the launch rate limits (supabase/templates/README.md);
 * - reads the project's API keys. They're never printed: with --to-vercel they
 *   go straight into the Vercel project's environment variables
 *   (tools/vercel-setup.mjs), and tools/launch.mjs passes them on in memory.
 *
 * Dry run by default: nothing changes without --apply. Running it again with
 * --apply changes nothing that's already right.
 *
 * Flags:
 *   --ref <ref>             the project reference (supabase.com/dashboard/project/<ref>)
 *   --site-url <url>        the app's address (APP_URL); needed for Auth
 *   --preview-urls <glob>   extra redirect pattern for previews, e.g. https://*-team.vercel.app/**
 *   --email-from <from>     "TinyTown <hello@mail.example.com>": custom SMTP, with RESEND_API_KEY set
 *   --email-rate <n>        emails an hour for the whole project once SMTP is on (default 2000)
 *   --mark-applied <v,…>    record migrations that were run by hand, without running them
 *   --to-vercel             write the API keys into Vercel (with --vercel-project, --team, VERCEL_TOKEN)
 *   --apply                 make the changes (otherwise a dry run that only reads)
 *
 * Plain fetch, no dependencies. The logic is `setupSupabase()`, exported for tests.
 */
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { authTemplates } from '../server/email/auth-templates.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const API = 'https://api.supabase.com';
export const MIGRATIONS_DIR = join(ROOT, 'supabase/migrations');
export const TEMPLATES_DIR = join(ROOT, 'supabase/templates');

/** The launch values from supabase/templates/README.md, section 3. */
export const LAUNCH_LIMITS = { emailsPerHour: 2000, signInsPer5Min: 60, verificationsPer5Min: 60 };
/** Resend's SMTP settings (supabase/templates/README.md, section 2). */
export const RESEND_SMTP = { host: 'smtp.resend.com', port: '465', user: 'resend', minIntervalSeconds: 60 };
export const DEV_REDIRECT = 'http://localhost:5173/**';

/** The Management API's names for each template file in supabase/templates/. */
export const TEMPLATE_KINDS = {
  'confirmation.html': 'confirmation',
  'invite.html': 'invite',
  'magic_link.html': 'magic_link',
  'email_change.html': 'email_change',
  'recovery.html': 'recovery',
  'reauthentication.html': 'reauthentication',
};

// ─── Arguments ────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const out = { ref: null, siteUrl: null, previewUrls: null, emailFrom: null, emailRate: LAUNCH_LIMITS.emailsPerHour, markApplied: [], toVercel: false, vercelProject: null, team: null, apply: false, help: false };
  const value = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value.`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].includes('=') ? [argv[i].slice(0, argv[i].indexOf('=')), argv[i].slice(argv[i].indexOf('=') + 1)] : [argv[i], undefined];
    const take = () => inline ?? value(i++, flag);
    if (flag === '--apply') out.apply = true;
    else if (flag === '--dry-run') out.apply = false;
    else if (flag === '--to-vercel') out.toVercel = true;
    else if (flag === '--help' || flag === '-h') out.help = true;
    else if (flag === '--ref') out.ref = take();
    else if (flag === '--site-url') out.siteUrl = take();
    else if (flag === '--preview-urls') out.previewUrls = take();
    else if (flag === '--email-from') out.emailFrom = take();
    else if (flag === '--email-rate') out.emailRate = Number(take());
    else if (flag === '--mark-applied') out.markApplied = take().split(',').map((v) => v.trim()).filter(Boolean);
    else if (flag === '--vercel-project') out.vercelProject = take();
    else if (flag === '--team') out.team = take();
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!Number.isInteger(out.emailRate) || out.emailRate < 1) throw new Error('--email-rate is a whole number of emails an hour.');
  return out;
}

/** Project refs are short lowercase ids; checked so a typo can't wander into another API path. */
export function checkRef(ref) {
  if (!ref) throw new Error('Pass --ref <project-ref>: the id in supabase.com/dashboard/project/<ref>.');
  if (!/^[a-z0-9]{8,40}$/.test(ref)) throw new Error(`--ref should be the project's reference, like abcdefghijklmnopqrst (got "${ref}").`);
  return ref;
}

/** The app's address: https (or localhost), no path. */
export function checkSiteUrl(raw) {
  if (!raw) throw new Error('Pass --site-url https://your-domain (the same address as APP_URL).');
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`--site-url isn't a URL: ${raw}`);
  }
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !local) throw new Error('--site-url must start with https://.');
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) throw new Error('--site-url is the address alone, like https://tinytown.app (no path).');
  return u.origin;
}

/** "TinyTown <hello@mail.example.com>" → { name, email }. */
export function parseFrom(raw) {
  if (!raw) return null;
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^<>\s]+@[^<>\s]+)>\s*$/.exec(raw) ?? /^\s*()([^<>\s]+@[^<>\s]+)\s*$/.exec(raw);
  if (!m) throw new Error(`--email-from should look like "TinyTown <hello@mail.yourdomain.com>" (got "${raw}").`);
  return { name: m[1]?.trim() || 'TinyTown', email: m[2] };
}

// ─── The Management API over fetch ────────────────────────────────────────

export class SupabaseSetupError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function messageOf(status, data) {
  const m = typeof data?.message === 'string' ? data.message : typeof data?.error === 'string' ? data.error : typeof data?.msg === 'string' ? data.msg : null;
  if (status === 401) return `Supabase refused SUPABASE_ACCESS_TOKEN (401). Make a new personal access token at supabase.com/dashboard/account/tokens.${m ? ` (${m})` : ''}`;
  if (status === 403) return `SUPABASE_ACCESS_TOKEN can't do this (403)${m ? `: ${m}` : ''}. Use a personal access token from the account that owns the project.`;
  return m ?? `Supabase responded ${status}`;
}

/**
 * `api(method, path, body)`. Reads and config updates are safe to repeat, so
 * they're retried on a network error, a 429 or a 5xx; a SQL query is retried
 * only on a 429 (refused before it ran), never after it may have run.
 */
export function supabaseClient(token, fetchImpl = globalThis.fetch, { retryDelayMs = 500 } = {}) {
  if (!token) throw new Error('Set SUPABASE_ACCESS_TOKEN to a Supabase personal access token (supabase.com/dashboard/account/tokens).');
  return async function api(method, path, body) {
    const repeatable = method === 'GET' || method === 'PATCH';
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(`${API}${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (err) {
        if (repeatable && attempt < 2) {
          await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
          continue;
        }
        throw new SupabaseSetupError(0, `Supabase could not be reached (${err?.message ?? 'network error'}).`);
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
      throw new SupabaseSetupError(res.status, messageOf(res.status, data));
    }
  };
}

/** Rows from the query endpoint, which answers with an array of row objects. */
const rowsOf = (d) => (Array.isArray(d) ? d : Array.isArray(d?.result) ? d.result : []);

function sqlRunner(api, ref) {
  return (query, readOnly = false) => api('POST', `/v1/projects/${ref}/database/query`, { query, ...(readOnly ? { read_only: true } : {}) }).then(rowsOf);
}

// ─── The project ──────────────────────────────────────────────────────────

const STARTING = new Set(['COMING_UP', 'RESTORING', 'UPGRADING', 'RESTARTING', 'RESIZING', 'INIT_READ_REPLICA']);

/** The project, if it exists and is serving. Anything else stops the run with what to do. */
export async function checkProject(api, ref) {
  const project = await api('GET', `/v1/projects/${ref}`).catch((err) => {
    if (err.status === 404) throw new Error(`No Supabase project with the ref ${ref} in the account this token belongs to. Check the ref in the dashboard address (supabase.com/dashboard/project/<ref>).`);
    throw err;
  });
  const status = project?.status ?? 'UNKNOWN';
  if (status === 'INACTIVE' || status === 'PAUSING' || status === 'PAUSED') {
    throw new Error(`The Supabase project ${ref} is paused (${status}). Restore it from its dashboard page, wait until it's green, and run this again.`);
  }
  if (STARTING.has(status)) throw new Error(`The Supabase project ${ref} isn't ready yet (${status}). Wait a minute and run this again.`);
  if (status !== 'ACTIVE_HEALTHY') throw new Error(`The Supabase project ${ref} isn't healthy (${status}). Check its dashboard page.`);

  // The services TinyTown needs. An older API without this endpoint isn't a reason to stop.
  let unhealthy = [];
  try {
    const services = await api('GET', `/v1/projects/${ref}/health?services=auth&services=db&services=rest`);
    unhealthy = (Array.isArray(services) ? services : []).filter((s) => s.healthy === false).map((s) => `${s.name} (${s.status ?? 'unhealthy'})`);
  } catch (err) {
    if (!(err instanceof SupabaseSetupError) || err.status === 401 || err.status === 403) throw err;
  }
  if (unhealthy.length) throw new Error(`Supabase says these services of ${ref} aren't healthy: ${unhealthy.join(', ')}. Try again in a few minutes.`);
  return { ref, name: project.name ?? ref, region: project.region ?? null, status };
}

// ─── Migrations ───────────────────────────────────────────────────────────

/** supabase/migrations/NNNN_name.sql, in order. Versions are the CLI's: the digits before the first underscore. */
export async function readMigrations(dir = MIGRATIONS_DIR) {
  const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f));
  const out = await Promise.all(
    files.map(async (file) => {
      const [, version, name] = /^(\d+)_(.+)\.sql$/.exec(file);
      return { file, version, name, sql: await readFile(join(dir, file), 'utf8') };
    }),
  );
  return out.sort((a, b) => (BigInt(a.version) < BigInt(b.version) ? -1 : BigInt(a.version) > BigInt(b.version) ? 1 : 0));
}

export const HISTORY_TABLE = 'supabase_migrations.schema_migrations';

/** The CLI's own history table, made the way the CLI makes it, so a later `supabase db push` reads it as its own. */
export const HISTORY_DDL = [
  'create schema if not exists supabase_migrations;',
  `create table if not exists ${HISTORY_TABLE} (version text not null primary key);`,
  `alter table ${HISTORY_TABLE} add column if not exists statements text[];`,
  `alter table ${HISTORY_TABLE} add column if not exists name text;`,
].join('\n');

const literal = (s) => `'${String(s).replace(/'/g, "''")}'`;
/** A dollar-quoted string whose tag can't appear inside it. */
function dollar(s) {
  let tag = '$tinytown_migration$';
  for (let n = 1; s.includes(tag); n++) tag = `$tinytown_migration_${n}$`;
  return `${tag}${s}${tag}`;
}

/** One request: the file, then its history row. If any statement fails, the row is never written. */
export function migrationQuery(m) {
  return `${m.sql.trimEnd()}\n;\ninsert into ${HISTORY_TABLE} (version, name, statements) values (${literal(m.version)}, ${literal(m.name)}, array[${dollar(m.sql)}]) on conflict (version) do nothing;`;
}

/**
 * Applies what's missing, in order. Returns `{ steps, applied, failed }`;
 * `failed` is the explanation when a file failed (everything after it is
 * left for the next run).
 */
export async function applyMigrations(api, ref, migrations, { dryRun, markApplied = [] }) {
  const sql = sqlRunner(api, ref);
  const steps = [];
  const step = (thing, action, id) => steps.push({ thing, action, id });
  const known = new Set(migrations.map((m) => m.version));
  for (const v of markApplied) if (!known.has(v)) throw new Error(`--mark-applied ${v}: there's no supabase/migrations/${v}_*.sql.`);

  const present = (await sql(`select to_regclass('${HISTORY_TABLE}') is not null as present`, true))[0]?.present === true;
  const applied = present ? new Set((await sql(`select version from ${HISTORY_TABLE}`, true)).map((r) => String(r.version))) : new Set();
  if (!present) {
    if (!dryRun) await sql(HISTORY_DDL);
    step('Migration history', dryRun ? 'would create' : 'created', HISTORY_TABLE);
  }

  for (const m of migrations) {
    if (applied.has(m.version)) {
      step(`Migration ${m.version}`, 'already applied', m.file);
      continue;
    }
    if (markApplied.includes(m.version)) {
      if (!dryRun) await sql(`insert into ${HISTORY_TABLE} (version, name, statements) values (${literal(m.version)}, ${literal(m.name)}, array[${dollar(m.sql)}]) on conflict (version) do nothing;`);
      step(`Migration ${m.version}`, dryRun ? 'would record' : 'recorded', `${m.file} (run by hand earlier; not run again)`);
      applied.add(m.version);
      continue;
    }
    if (dryRun) {
      step(`Migration ${m.version}`, 'would apply', m.file);
      continue;
    }
    try {
      await sql(migrationQuery(m));
    } catch (err) {
      step(`Migration ${m.version}`, 'FAILED', m.file);
      const byHand = /already exists/i.test(err.message)
        ? ` If ${m.file} was pasted into the SQL Editor earlier, record it instead of running it: --mark-applied ${m.version} (what \`supabase migration repair --status applied ${m.version}\` does).`
        : '';
      return {
        steps,
        failed: `Migration ${m.file} failed, so it isn't recorded and nothing after it ran. Supabase said: ${err.message}.${byHand} Fix it and run this again: the migrations before it stay applied.`,
      };
    }
    step(`Migration ${m.version}`, 'applied', m.file);
    applied.add(m.version);
  }
  return { steps, failed: null };
}

// ─── Auth ─────────────────────────────────────────────────────────────────

/** The six templates: subjects from server/email/auth-templates.ts, bodies from the files generated from it. */
export async function loadTemplates(dir = TEMPLATES_DIR) {
  return Promise.all(
    authTemplates().map(async (t) => {
      const kind = TEMPLATE_KINDS[t.file];
      if (!kind) throw new Error(`No Management API field for supabase/templates/${t.file}.`);
      return { kind, name: t.name, subject: t.subject, html: await readFile(join(dir, t.file), 'utf8') };
    }),
  );
}

/** The redirect URLs TinyTown needs, after any already there (an address added by hand stays). */
export function redirectList(existing, siteUrl, previewUrls) {
  const current = String(existing ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const wanted = [`${siteUrl}/**`, `${siteUrl}/admin.html`, DEV_REDIRECT, ...(previewUrls ? [previewUrls] : [])];
  return [...current, ...wanted.filter((u) => !current.includes(u))].join(',');
}

const same = (a, b) => (a ?? null) === (b ?? null) || String(a ?? '') === String(b ?? '');

/**
 * What to PATCH, worked out from the current config: only the fields that
 * differ, so a re-run sends nothing. Returns `{ patch, steps, notes }`.
 */
export function planAuth(current, { siteUrl, previewUrls, templates, smtp, emailRate, dryRun }) {
  const steps = [];
  const notes = [];
  const patch = {};
  const verb = (v) => (dryRun ? `would ${v}` : `${v.replace(/e$/, '')}ed`);
  const group = (thing, want, id) => {
    const diff = Object.entries(want).filter(([k, v]) => !same(current[k], v));
    for (const [k, v] of diff) patch[k] = v;
    steps.push({ thing, action: diff.length ? verb('update') : 'unchanged', id });
    return diff.length;
  };

  group('Site URL', { site_url: siteUrl }, siteUrl);
  const list = redirectList(current.uri_allow_list, siteUrl, previewUrls);
  group('Redirect URLs', { uri_allow_list: list }, list.split(',').join(', '));
  // Magic links and one-time codes by email; new addresses confirm first; links last an hour (the emails say so).
  group('Email sign-in', { external_email_enabled: true, mailer_autoconfirm: false, mailer_otp_exp: 3600 }, 'magic link on, confirm email on, links expire in an hour');

  const tpl = {};
  for (const t of templates) {
    tpl[`mailer_subjects_${t.kind}`] = t.subject;
    tpl[`mailer_templates_${t.kind}_content`] = t.html;
  }
  const changed = templates.filter((t) => !same(current[`mailer_subjects_${t.kind}`], t.subject) || !same(current[`mailer_templates_${t.kind}_content`], t.html));
  for (const [k, v] of Object.entries(tpl)) if (!same(current[k], v)) patch[k] = v;
  steps.push({ thing: 'Email templates', action: changed.length ? verb('update') : 'unchanged', id: changed.length ? changed.map((t) => t.name).join(', ') : `all ${templates.length}` });

  if (smtp) {
    const want = { smtp_host: RESEND_SMTP.host, smtp_port: RESEND_SMTP.port, smtp_user: RESEND_SMTP.user, smtp_admin_email: smtp.email, smtp_sender_name: smtp.name, smtp_max_frequency: RESEND_SMTP.minIntervalSeconds };
    const n = group('Custom SMTP', want, `Resend, from ${smtp.name} <${smtp.email}>`);
    // The password (the Resend key) is never read back, so it's sent only with a change, or the first time.
    if (n || !current.smtp_host) patch.smtp_pass = smtp.password;
    else notes.push('Custom SMTP was already on Resend with this sender, so its password (the Resend key) was left as it is.');
  } else if (current.smtp_host) {
    steps.push({ thing: 'Custom SMTP', action: 'left alone', id: `${current.smtp_host} (set up already)` });
  } else {
    steps.push({ thing: 'Custom SMTP', action: 'not set up', id: 'needs RESEND_API_KEY and --email-from' });
    notes.push("Sign-in emails go through Supabase's built-in mailer: 2 an hour, and only to your team's addresses. Set RESEND_API_KEY and --email-from to switch to Resend before inviting anyone.");
  }
  // Supabase only takes a higher email limit once custom SMTP is on.
  if (smtp || current.smtp_host) {
    group('Rate limits', { rate_limit_email_sent: emailRate, rate_limit_otp: LAUNCH_LIMITS.signInsPer5Min, rate_limit_verify: LAUNCH_LIMITS.verificationsPer5Min }, `${emailRate} emails an hour; ${LAUNCH_LIMITS.signInsPer5Min} sign-ins and verifications per 5 minutes per IP`);
  } else {
    group('Rate limits', { rate_limit_otp: LAUNCH_LIMITS.signInsPer5Min, rate_limit_verify: LAUNCH_LIMITS.verificationsPer5Min }, `${LAUNCH_LIMITS.signInsPer5Min} sign-ins and verifications per 5 minutes per IP (the email limit needs custom SMTP)`);
  }
  return { patch, steps, notes };
}

// ─── API keys ─────────────────────────────────────────────────────────────

/** A key that came back masked (the token can't reveal secrets) has dots or stars where the key should be. */
const masked = (k) => !k || /[•·*…]/.test(k) || k.length < 20;

/**
 * The project URL and keys, for the server's SUPABASE_* variables. New-style
 * keys (sb_publishable_/sb_secret_) when the project has them, as Supabase
 * recommends; otherwise the legacy anon and service_role JWTs. Never printed.
 */
export async function fetchApiKeys(api, ref) {
  const keys = await api('GET', `/v1/projects/${ref}/api-keys?reveal=true`);
  const list = Array.isArray(keys) ? keys : [];
  const publishable = list.find((k) => k.type === 'publishable');
  const secret = list.find((k) => k.type === 'secret');
  const anon = list.find((k) => k.type === 'legacy' && k.name === 'anon') ?? list.find((k) => k.name === 'anon');
  const service = list.find((k) => k.type === 'legacy' && k.name === 'service_role') ?? list.find((k) => k.name === 'service_role');
  const useNew = publishable && secret && !masked(secret.api_key);
  const anonKey = useNew ? publishable.api_key : anon?.api_key;
  const serviceKey = useNew ? secret.api_key : service?.api_key;
  if (!anonKey || !serviceKey) throw new Error(`Supabase returned no usable API keys for ${ref}. Open Project Settings → API Keys once in the dashboard, then run this again.`);
  if (masked(serviceKey)) throw new Error('Supabase returned the secret key masked: the access token needs permission to read secrets (a personal access token of the project owner).');
  if (anonKey.startsWith('sb_secret_') || serviceKey.startsWith('sb_publishable_') || anonKey === serviceKey) throw new Error('Supabase returned the API keys the wrong way round; stopping rather than sending a secret key to browsers.');
  return { url: `https://${ref}.supabase.co`, anonKey, serviceKey, kind: useNew ? 'publishable and secret keys' : 'legacy anon and service_role keys' };
}

// ─── The setup ────────────────────────────────────────────────────────────

/**
 * Does the work, or with `dryRun` only reads and says what it would do.
 * Returns `{ project, dryRun, steps, notes, failed, keys }`. `keys` holds the
 * API keys for the next step in memory; `report()` never shows them.
 */
export async function setupSupabase({
  token,
  ref: rawRef,
  siteUrl: rawSiteUrl,
  previewUrls = null,
  resendKey = null,
  emailFrom = null,
  emailRate = LAUNCH_LIMITS.emailsPerHour,
  markApplied = [],
  dryRun = true,
  withKeys = true,
  fetch: fetchImpl = globalThis.fetch,
  migrationsDir = MIGRATIONS_DIR,
  templatesDir = TEMPLATES_DIR,
  retryDelayMs,
}) {
  const ref = checkRef(rawRef);
  const siteUrl = checkSiteUrl(rawSiteUrl);
  const from = parseFrom(emailFrom);
  const api = supabaseClient(token, fetchImpl, { retryDelayMs });
  const notes = [];
  const result = { project: null, dryRun, steps: [], notes, failed: null, keys: null };

  result.project = await checkProject(api, ref);
  result.steps.push({ thing: 'Project', action: 'healthy', id: `${result.project.name} (${ref}${result.project.region ? `, ${result.project.region}` : ''})` });

  const migrations = await readMigrations(migrationsDir);
  const m = await applyMigrations(api, ref, migrations, { dryRun, markApplied });
  result.steps.push(...m.steps);
  if (m.failed) {
    result.failed = m.failed;
    return result;
  }

  const smtp = resendKey && from ? { ...from, password: resendKey } : null;
  if (resendKey && !from) notes.push('RESEND_API_KEY is set but there is no --email-from, so custom SMTP was not set up. Pass the verified sender, e.g. --email-from "TinyTown <hello@mail.yourdomain.com>".');
  if (from && !resendKey) notes.push('--email-from was given without RESEND_API_KEY, so custom SMTP was not set up.');
  const current = (await api('GET', `/v1/projects/${ref}/config/auth`)) ?? {};
  const plan = planAuth(current, { siteUrl, previewUrls, templates: await loadTemplates(templatesDir), smtp, emailRate, dryRun });
  if (!dryRun && Object.keys(plan.patch).length) await api('PATCH', `/v1/projects/${ref}/config/auth`, plan.patch);
  result.steps.push(...plan.steps);
  notes.push(...plan.notes);

  if (withKeys) {
    result.keys = await fetchApiKeys(api, ref);
    result.steps.push({ thing: 'API keys', action: 'read', id: `${result.keys.kind} (not shown)` });
  }
  return result;
}

/** What to print: what happened and what's left. Never a key. */
export function report(r) {
  const lines = [`TinyTown Supabase setup${r.project ? ` for ${r.project.name} (${r.project.ref})` : ''}${r.dryRun ? '. Dry run: nothing was changed (add --apply).' : '.'}`, ''];
  const w = Math.max(0, ...r.steps.map((s) => s.thing.length));
  const a = Math.max(0, ...r.steps.map((s) => s.action.length));
  for (const s of r.steps) lines.push(`  ${s.thing.padEnd(w)}  ${s.action.padEnd(a)}  ${s.id}`);
  if (r.failed) lines.push('', `Stopped: ${r.failed}`);
  if (r.notes.length) lines.push('', 'Notes:', ...r.notes.map((n) => `  - ${n}`));
  return lines.join('\n');
}

/** The server's three Supabase variables, for tools/vercel-setup.mjs, on both Production and Preview. */
export function supabaseEnv(keys) {
  const both = (v) => ({ production: v, preview: v });
  return [
    { key: 'SUPABASE_URL', secret: false, values: both(keys.url) },
    { key: 'SUPABASE_ANON_KEY', secret: false, values: both(keys.anonKey) },
    { key: 'SUPABASE_SERVICE_ROLE_KEY', secret: true, values: both(keys.serviceKey) },
  ];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      'Usage: SUPABASE_ACCESS_TOKEN=… node tools/supabase-setup.mjs --ref <ref> --site-url https://your-domain [--email-from "TinyTown <hello@mail.…>"] [--to-vercel --vercel-project <name> [--team <slug>]] [--apply]',
    );
    return;
  }
  if (args.toVercel && !args.vercelProject) throw new Error('--to-vercel needs --vercel-project <name> (and VERCEL_TOKEN).');
  const dryRun = !args.apply;
  const r = await setupSupabase({
    token: process.env.SUPABASE_ACCESS_TOKEN?.trim(),
    ref: args.ref,
    siteUrl: args.siteUrl,
    previewUrls: args.previewUrls,
    resendKey: process.env.RESEND_API_KEY?.trim() || null,
    emailFrom: args.emailFrom,
    emailRate: args.emailRate,
    markApplied: args.markApplied,
    dryRun,
    withKeys: true,
  });
  console.log(report(r));
  if (r.failed) process.exit(1);
  if (args.toVercel && r.keys) {
    const vercel = await import('./vercel-setup.mjs');
    const api = vercel.vercelClient({ token: process.env.VERCEL_TOKEN?.trim(), team: args.team });
    const project = await vercel.findProject(api, args.vercelProject);
    const synced = await vercel.syncEnv(api, project, supabaseEnv(r.keys), { dryRun });
    console.log(`\n${vercel.formatSteps(`Vercel environment variables for ${project.name}`, synced.steps)}`);
    for (const n of synced.notes) console.log(`  - ${n}`);
  } else if (r.keys) {
    console.log('\nThe API keys were read but not shown. Pass --to-vercel --vercel-project <name> to write them into Vercel, or run tools/launch.mjs.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\n${err.message}`);
    process.exit(1);
  });
}
