#!/usr/bin/env node
/**
 * Provisions hosted TinyTown end to end, in one command:
 *
 *   node tools/launch.mjs --supabase-ref <ref> --vercel-project <name> [--team <slug>] [--domain <domain>] [--live] --dry-run|--apply
 *
 * In order:
 * 1. Vercel: finds the project, sets its production branch (main) and Node 22,
 *    and works out the production address (--domain, a custom domain already
 *    on the project, or <project>.vercel.app);
 * 2. Stripe (tools/stripe-setup.mjs): the $29 yearly price, the $9 first-year
 *    coupon, the webhook and the customer portal, in test mode with
 *    STRIPE_SECRET_KEY, and with --live in live mode too with STRIPE_LIVE_SECRET_KEY;
 * 3. Supabase (tools/supabase-setup.mjs): migrations, Auth settings, email
 *    templates, SMTP through Resend when RESEND_API_KEY and --email-from are
 *    given, and the API keys;
 * 4. Vercel (tools/vercel-setup.mjs): every environment variable for
 *    Production and Preview, generating TinyTown's own secrets once. Preview
 *    always gets test-mode Stripe; Production gets live Stripe only with --live;
 * 5. deploys a Preview (or Production with --production) and checks
 *    /api/config and /api/health on it;
 * 6. prints a checklist of what's done and what's left for the owner.
 *
 * Values move between the steps in memory only: nothing secret is printed or
 * written to a file, and every line printed is scrubbed of the secrets it
 * knows as a last line of defence. Every step reads first and changes only
 * what isn't right yet, so a second run with --apply changes nothing.
 *
 * Reads these from the environment (the cloud secrets, docs/OWNER_STEPS.md):
 *   SUPABASE_ACCESS_TOKEN, VERCEL_TOKEN, STRIPE_SECRET_KEY (sk_test_…), and
 *   when they exist STRIPE_LIVE_SECRET_KEY (with --live), GITHUB_APP_ID,
 *   GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, GITHUB_APP_SLUG,
 *   GITHUB_APP_PRIVATE_KEY, STRIPE_APP_CLIENT_ID, RESEND_API_KEY.
 *
 * Flags (one of --dry-run or --apply is required):
 *   --supabase-ref <ref>     the Supabase project reference
 *   --vercel-project <name>  the Vercel project's name
 *   --team <slug>            the Vercel team that owns it
 *   --domain <domain>        the production domain, once it's on the Vercel project
 *   --live                   also set up live-mode Stripe and give it to Production
 *   --production             deploy to Production instead of a Preview
 *   --branch <name>          the branch to deploy (default: the current one; main for Production)
 *   --no-deploy              set everything up but don't deploy
 *   --email-from <from>      "TinyTown <hello@mail.yourdomain.com>": the verified Resend sender
 *   --admin-emails <list>    ADMIN_EMAILS, who may open /admin.html
 *   --email-rate <n>         Supabase's emails an hour once SMTP is on (default 2000)
 *   --mark-applied <v,…>     migrations that were run by hand, to record without running
 */
import { pathToFileURL } from 'node:url';
import { setupStripe } from './stripe-setup.mjs';
import { setupSupabase } from './supabase-setup.mjs';
import * as vercel from './vercel-setup.mjs';

/** The cloud secrets this reads, and the ones of them that are secret (scrubbed from all output). */
export const CLOUD_ENV = [
  'SUPABASE_ACCESS_TOKEN',
  'VERCEL_TOKEN',
  'STRIPE_SECRET_KEY',
  'STRIPE_LIVE_SECRET_KEY',
  'GITHUB_APP_ID',
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_CLIENT_SECRET',
  'GITHUB_APP_SLUG',
  'GITHUB_APP_PRIVATE_KEY',
  'STRIPE_APP_CLIENT_ID',
  'RESEND_API_KEY',
];
export const CLOUD_SECRETS = ['SUPABASE_ACCESS_TOKEN', 'VERCEL_TOKEN', 'STRIPE_SECRET_KEY', 'STRIPE_LIVE_SECRET_KEY', 'GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_PRIVATE_KEY', 'RESEND_API_KEY'];

export function parseArgs(argv) {
  const out = {
    supabaseRef: null,
    vercelProject: null,
    team: null,
    domain: null,
    live: false,
    production: false,
    branch: null,
    deploy: true,
    emailFrom: null,
    adminEmails: null,
    emailRate: 2000,
    markApplied: [],
    dryRun: false,
    apply: false,
    help: false,
  };
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
    if (flag === '--dry-run') out.dryRun = true;
    else if (flag === '--apply') out.apply = true;
    else if (flag === '--live') out.live = true;
    else if (flag === '--production') out.production = true;
    else if (flag === '--no-deploy') out.deploy = false;
    else if (flag === '--help' || flag === '-h') out.help = true;
    else if (flag === '--supabase-ref') out.supabaseRef = take();
    else if (flag === '--vercel-project') out.vercelProject = take();
    else if (flag === '--team') out.team = take();
    else if (flag === '--domain') out.domain = take();
    else if (flag === '--branch') out.branch = take();
    else if (flag === '--email-from') out.emailFrom = take();
    else if (flag === '--admin-emails') out.adminEmails = take();
    else if (flag === '--email-rate') out.emailRate = Number(take());
    else if (flag === '--mark-applied') out.markApplied = take().split(',').map((v) => v.trim()).filter(Boolean);
    else throw new Error(`Unknown argument: ${raw}`);
  }
  if (out.help) return out;
  if (out.dryRun === out.apply) throw new Error('Pass --dry-run to see what would happen, or --apply to do it.');
  if (!out.supabaseRef) throw new Error('Pass --supabase-ref <ref>: the id in supabase.com/dashboard/project/<ref>.');
  if (!out.vercelProject) throw new Error('Pass --vercel-project <name>: the Vercel project imported from GitHub.');
  if (!Number.isInteger(out.emailRate) || out.emailRate < 1) throw new Error('--email-rate is a whole number of emails an hour.');
  return out;
}

/** The Stripe keys, checked before anything is called: test for Preview, live only with --live. */
export function stripeKeys(env, live) {
  const test = env.STRIPE_SECRET_KEY?.trim() || null;
  const liveKey = env.STRIPE_LIVE_SECRET_KEY?.trim() || null;
  if (!test) throw new Error('Set STRIPE_SECRET_KEY to the test-mode secret key (sk_test_…).');
  if (/^(sk|rk)_live_/.test(test)) throw new Error('STRIPE_SECRET_KEY holds a live key, but it is the test-mode key (Preview runs on it). Put the live key in STRIPE_LIVE_SECRET_KEY and pass --live.');
  if (!/^(sk|rk)_test_/.test(test)) throw new Error('STRIPE_SECRET_KEY doesn’t look like a Stripe test secret key (sk_test_…).');
  if (!live) return { test, live: null };
  if (!liveKey) throw new Error('--live needs STRIPE_LIVE_SECRET_KEY (sk_live_…) in the environment.');
  if (!/^(sk|rk)_live_/.test(liveKey)) throw new Error('STRIPE_LIVE_SECRET_KEY should be a live secret key (sk_live_…).');
  return { test, live: liveKey };
}

/** Stripe's notes that don't apply when the values go straight into Vercel. */
const STRIPE_NOTES_HANDLED = [/Copy STRIPE_WEBHOOK_SECRET now/, /sold by the year only: remove/, /signing secret isn’t shown again/];

/**
 * Runs everything. `args` is `parseArgs()`'s result. Prints as it goes
 * through `log` (scrubbed) and returns `{ dryRun, failed, checks, done, todo }`.
 */
export async function launch({ args, env = process.env, fetch: fetchImpl = globalThis.fetch, log = console.log, gitBranch = vercel.currentBranch, pollMs, sleep, retryDelayMs }) {
  const dryRun = !args.apply;
  const secrets = new Set(CLOUD_SECRETS.map((k) => env[k]?.trim()).filter(Boolean));
  const pem = env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (pem?.startsWith('-----')) secrets.add(Buffer.from(pem.replace(/\\n/g, '\n'), 'utf8').toString('base64'));
  const say = (text) => log(vercel.scrub(text, secrets));
  const section = (title, steps, notes = []) => {
    say(`\n${vercel.formatSteps(title, steps)}`);
    if (notes.length) say(notes.map((n) => `  - ${n}`).join('\n'));
  };
  const done = [];
  const todo = [];
  const result = { dryRun, failed: null, checks: [], done, todo };

  const missing = ['SUPABASE_ACCESS_TOKEN', 'VERCEL_TOKEN', 'STRIPE_SECRET_KEY'].filter((k) => !env[k]?.trim());
  if (missing.length) throw new Error(`Missing from the environment: ${missing.join(', ')}. Add ${missing.length === 1 ? 'it' : 'them'} to the cloud environment's secrets (docs/OWNER_STEPS.md, step 4) and start a new session.`);
  const keys = stripeKeys(env, args.live);

  say(`TinyTown launch setup${dryRun ? ': DRY RUN, nothing will be changed' : ''}. Stripe: ${args.live ? 'live for Production, test for Preview' : 'test mode everywhere'}.`);

  // 1. The Vercel project, and the address everything else points at.
  const api = vercel.vercelClient({ token: env.VERCEL_TOKEN.trim(), team: args.team, fetch: fetchImpl, retryDelayMs });
  const project = await vercel.findProject(api, args.vercelProject);
  const proj = await vercel.ensureProject(api, project, { dryRun });
  const appUrl = vercel.domainUrl(args.domain) ?? (await vercel.productionUrl(api, project));
  const slug = await vercel.teamSlug(api);
  const previewUrls = slug ? `https://*-${slug}.vercel.app/**` : null;
  section(`Vercel project ${project.name} (production address ${appUrl})`, proj.steps, proj.notes);
  todo.push(...proj.notes.filter((n) => /by hand|Connect Git/.test(n)));

  // 2. Stripe, test mode always (Preview), live with --live (Production).
  const runStripe = async (key, live) => {
    const r = await setupStripe({ key, appUrl, dryRun, live, fetch: fetchImpl });
    for (const v of Object.values(r.env)) if (typeof v === 'string' && v.startsWith('whsec_')) secrets.add(v);
    const who = r.account ? ` for ${r.account.name ?? r.account.id}` : '';
    section(`Stripe, ${r.mode} mode${who}`, r.steps, r.notes.filter((n) => !STRIPE_NOTES_HANDLED.some((re) => re.test(n))));
    return r;
  };
  const stripeTest = await runStripe(keys.test, false);
  const stripeLive = keys.live ? await runStripe(keys.live, true) : null;
  done.push(`Stripe ${stripeLive ? 'test and live mode' : 'test mode'}: the $29 yearly price, the $9 first-year coupon, the webhook and the customer portal.`);

  // 3. Supabase.
  const sb = await setupSupabase({
    token: env.SUPABASE_ACCESS_TOKEN.trim(),
    ref: args.supabaseRef,
    siteUrl: appUrl,
    previewUrls,
    resendKey: env.RESEND_API_KEY?.trim() || null,
    emailFrom: args.emailFrom,
    emailRate: args.emailRate,
    markApplied: args.markApplied,
    dryRun,
    fetch: fetchImpl,
    retryDelayMs,
  });
  if (sb.keys) secrets.add(sb.keys.serviceKey);
  section(`Supabase ${sb.project?.name ?? args.supabaseRef}`, sb.steps, sb.notes);
  if (sb.failed) {
    result.failed = sb.failed;
    say(`\nStopped: ${sb.failed}`);
    todo.unshift(`Fix the migration and run this again (${sb.failed.split('.')[0]}).`);
    say(checklist(result));
    return result;
  }
  const migrations = sb.steps.filter((s) => /^Migration \d/.test(s.thing));
  const inPlace = migrations.filter((s) => /applied|recorded|would apply|would record/.test(s.action)).length;
  done.push(`Supabase: ${inPlace} of ${migrations.length} migrations in place and recorded in Supabase's own history (so \`supabase db push\` and CI agree), Auth URLs, email sign-in and the six branded templates.`);

  // 4. Vercel's environment variables.
  const stripeFor = (r, key) => ({ mode: r.mode, key, env: r.env });
  const { desired, missing: notProvided } = vercel.tinytownEnv({
    supabase: sb.keys,
    stripe: { preview: stripeFor(stripeTest, keys.test), production: stripeLive ? stripeFor(stripeLive, keys.live) : stripeFor(stripeTest, keys.test) },
    appUrl,
    env,
    emailFrom: args.emailFrom,
    adminEmails: args.adminEmails,
  });
  for (const d of desired) if (d.secret) for (const v of Object.values(d.values ?? {})) if (typeof v === 'string') secrets.add(v);
  const synced = await vercel.syncEnv(api, project, desired, { dryRun });
  for (const t of vercel.TARGETS) for (const v of Object.values(synced.generated[t])) secrets.add(v);
  section('Vercel environment variables (values never shown)', synced.steps, synced.notes);
  const count = (s) => synced.steps.filter((x) => x.action === s || x.action === `would ${s}`).length;
  done.push(`Vercel: Production and Preview variables (${count('set') + count('update') + count('updated')} set or updated, ${count('generate') + count('generated')} secrets generated, the rest unchanged or kept).`);
  todo.push(...synced.notes);
  for (const h of synced.heldBack.filter((x) => x.group === 'Billing' && x.missing.includes('STRIPE_WEBHOOK_SECRET'))) {
    // Stripe shows a webhook's signing secret only when the endpoint is made, so a lost one can't be read back.
    todo.push(
      `Billing on ${h.target} needs STRIPE_WEBHOOK_SECRET, which Stripe showed once and Vercel doesn't have. Either reveal it (Stripe Dashboard → Developers → Webhooks → ${appUrl}/api/billing/webhook → Signing secret) and add it to Vercel for ${h.target} as Sensitive, or delete that endpoint and run this again so a new one is made and stored.`,
    );
  }

  // 5. Deploy and check.
  const target = args.production ? 'production' : 'preview';
  if (!args.deploy) {
    todo.push(`Deploy: run again without --no-deploy, or push to the branch (Vercel builds it).`);
  } else {
    const branch = args.branch ?? (args.production ? vercel.PRODUCTION_BRANCH : gitBranch());
    if (dryRun) section('Deploy', [{ thing: 'Deployment', action: 'would deploy', id: `${branch ?? '(no branch: pass --branch)'} to ${target}, then check /api/config and /api/health` }]);
    else {
      try {
        const d = await vercel.deploy(api, project, { branch, production: args.production, pollMs, sleep });
        const fresh = await vercel.findProject(api, project.id);
        // Production is checked on its own address, which Deployment Protection leaves open; a preview may need the bypass.
        const bypass = args.production ? { secret: Object.entries(fresh.protectionBypass ?? {}).find(([, v]) => v?.scope === 'automation-bypass')?.[0] ?? null, step: null } : await vercel.protectionBypass(api, fresh, { dryRun });
        if (bypass.secret) secrets.add(bypass.secret);
        const base = args.production ? appUrl : d.url;
        result.checks = await vercel.smokeCheck({ baseUrl: base, fetch: fetchImpl, secrets: [...secrets], bypass: bypass.secret, healthSecret: synced.generated[target].HEALTH_SECRET ?? null });
        section(`Deployed ${branch} to ${target}: ${d.url}`, [
          ...(bypass.step ? [bypass.step] : []),
          ...result.checks.map((c) => ({ thing: c.name, action: c.ok ? 'ok' : 'FAILED', id: c.detail })),
        ]);
        if (result.checks.every((c) => c.ok)) done.push(`Deployed ${branch} to ${target} (${base}): /api/config is hosted with no secrets in it, /api/health is ok.`);
        else todo.push(...result.checks.filter((c) => !c.ok).map((c) => `Smoke check ${c.name} failed on ${base}: ${c.detail}.`));
        if (!synced.generated[target].HEALTH_SECRET) todo.push('The deep health check (/api/health?deep=1) needs the HEALTH_SECRET already in Vercel, which this run did not generate and cannot read: point the uptime monitor at it (docs/SETUP.md §7.4).');
      } catch (err) {
        result.failed = err.message;
        say(`\nDeploy failed: ${err.message}`);
        todo.unshift(`Deploy: ${err.message}`);
      }
    }
  }

  // 6. What only the owner can do.
  const gh = notProvided.filter((n) => n.startsWith('GITHUB_APP_'));
  if (gh.length) todo.push(`The GitHub App (docs/OWNER_STEPS.md step 6): add ${gh.join(', ')} to the cloud secrets, then run this again.`);
  if (notProvided.includes('STRIPE_APP_CLIENT_ID')) todo.push('The Stripe App (docs/OWNER_STEPS.md step 7): upload it, add STRIPE_APP_CLIENT_ID to the cloud secrets, run this again, and submit it for review. While it is in review, founders connect through its External test link (STRIPE_APP_INSTALL_URL, docs/SETUP.md §3).');
  if (notProvided.includes('RESEND_API_KEY') || !args.emailFrom) {
    todo.push(`Email (docs/OWNER_STEPS.md step 8): ${notProvided.includes('RESEND_API_KEY') ? 'add RESEND_API_KEY to the cloud secrets and ' : ''}pass --email-from "TinyTown <hello@mail.yourdomain.com>" once the sending domain is verified. Until then Supabase's built-in mailer sends 2 sign-in emails an hour, only to your team.`);
  }
  if (!args.adminEmails) todo.push('Pass --admin-emails you@yourdomain.com so /admin.html opens for you (it asks for an authenticator code).');
  if (!stripeLive) todo.push('Live payments (docs/OWNER_STEPS.md step 10): activate Stripe, add STRIPE_LIVE_SECRET_KEY to the cloud secrets, and run this again with --live --apply. Production bills in test mode until then.');
  todo.push(
    'Stripe Dashboard, by hand (both modes): Smart Retries, then cancel after the last retry; failed-payment and receipt emails; Public details (Terms URL, support email, statement descriptor TINYTOWN); Adaptive Pricing on; branding.',
    "Supabase, by hand: Google and GitHub sign-in providers (docs/SETUP.md §1.5), Turnstile under Auth → Bot protection, and the Pro plan before launch (the free plan pauses after a quiet week).",
    'Preview uses the same Supabase project as Production. Before real founders arrive, give previews a staging project (docs/RELEASE.md, "Preview deploys").',
    'GitHub → Settings → Environments → production: SUPABASE_ACCESS_TOKEN, SUPABASE_DB_PASSWORD and SUPABASE_PROJECT_REF, so the Migrate database workflow applies future migrations (docs/RELEASE.md §4). No `migration repair` is needed: this run recorded the history.',
    'Before the first invite: ACCESS_MODE=waitlist and SUPPORT_EMAIL in Vercel (docs/SETUP.md §7).',
  );
  if (dryRun) todo.unshift('This was a dry run. Run the same command with --apply to do it.');
  say(checklist(result));
  return result;
}

export function checklist(r) {
  const lines = ['', 'Done:'];
  lines.push(...(r.done.length ? r.done.map((d) => `  - ${r.dryRun ? '(would be) ' : ''}${d}`) : ['  - nothing yet']));
  lines.push('', 'Still to do:', ...r.todo.map((t) => `  - ${t}`));
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node tools/launch.mjs --supabase-ref <ref> --vercel-project <name> [--team <slug>] [--domain <domain>] [--live] [--production] [--no-deploy] [--email-from "TinyTown <hello@…>"] [--admin-emails you@…] --dry-run|--apply');
    return;
  }
  const r = await launch({ args });
  if (r.failed || r.checks.some((c) => !c.ok)) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secrets = CLOUD_SECRETS.map((k) => process.env[k]?.trim()).filter(Boolean);
  main().catch((err) => {
    console.error(`\n${vercel.scrub(err.message, secrets)}`);
    process.exit(1);
  });
}
