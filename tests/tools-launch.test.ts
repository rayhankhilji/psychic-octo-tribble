import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { launch, parseArgs, stripeKeys } from '../tools/launch.mjs';
import { SB_KEYS, combine, fakeStripe, fakeSupabase, fakeVercel, type FakeSupabaseOptions } from './tools-fakes.ts';

/**
 * tools/launch.mjs end to end against in-memory Stripe, Supabase and Vercel:
 * a dry run writes nothing, a first run provisions everything and deploys a
 * preview that passes its smoke checks, a second run changes nothing, --live
 * keeps test money on Preview, a failing migration stops before Vercel, and
 * no secret value is ever printed.
 */

const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
// Fake keys are joined at runtime so no literal here looks like a real one to secret scanners.
const ENV = {
  SUPABASE_ACCESS_TOKEN: 'sbp_token',
  VERCEL_TOKEN: 'vercel_token',
  STRIPE_SECRET_KEY: ['sk', 'test', 'TESTkeyTESTkey1234567890'].join('_'),
  GITHUB_APP_ID: '123456',
  GITHUB_APP_CLIENT_ID: 'Iv23liABCDEF',
  GITHUB_APP_CLIENT_SECRET: 'ghappsecret_0123456789abcdef0123456789',
  GITHUB_APP_SLUG: 'tinytown',
  GITHUB_APP_PRIVATE_KEY: PEM,
};
const LIVE = ['sk', 'live', 'LIVEkeyLIVEkey1234567890'].join('_');

function world(o: { supabase?: FakeSupabaseOptions } = {}) {
  const stripe = fakeStripe();
  const supabase = fakeSupabase(o.supabase);
  const vercel = fakeVercel();
  const net = combine(stripe, supabase, vercel);
  return { stripe, supabase, vercel, net };
}

async function run(w: ReturnType<typeof world>, argv: string[], env: Record<string, string> = ENV) {
  const lines: string[] = [];
  const args = parseArgs(['--supabase-ref', w.supabase.ref, '--vercel-project', 'tinytown', '--team', 'my-team', ...argv]);
  const r = await launch({ args, env, fetch: w.net.fetch as never, log: (l) => lines.push(l), gitBranch: () => 'claude/launch', sleep: async () => {}, pollMs: 0, retryDelayMs: 0 });
  return { r, out: lines.join('\n') };
}

/** Every secret value anywhere in the fakes: none may appear in what was printed. */
function secretsIn(w: ReturnType<typeof world>, env: Record<string, string> = ENV) {
  const out = [env.SUPABASE_ACCESS_TOKEN!, env.VERCEL_TOKEN!, env.STRIPE_SECRET_KEY!, env.GITHUB_APP_CLIENT_SECRET!, PEM.trim(), Buffer.from(PEM.trim()).toString('base64'), SB_KEYS.secret, SB_KEYS.service];
  if (env.STRIPE_LIVE_SECRET_KEY) out.push(env.STRIPE_LIVE_SECRET_KEY);
  if (env.RESEND_API_KEY) out.push(env.RESEND_API_KEY);
  for (const a of w.stripe.accounts.values()) for (const e of a.webhook_endpoints) out.push(String(e.secret));
  for (const e of w.vercel.state.envs) if (e.type === 'sensitive') out.push(e.value);
  out.push(...Object.keys(w.vercel.project.protectionBypass));
  return out.filter((s) => s.length >= 8);
}
const expectNoSecrets = (out: string, secrets: string[]) => {
  for (const s of secrets) expect(out.includes(s), `printed a secret starting ${s.slice(0, 6)}`).toBe(false);
  // Fragments too: the PEM's body lines and anything shaped like a key.
  expect(out).not.toMatch(/sk_(test|live)_[A-Za-z0-9]{6}|whsec_[A-Za-z0-9]{6}|sb_secret_[A-Za-z0-9]{6}|BEGIN RSA PRIVATE KEY/);
};
const envOf = (w: ReturnType<typeof world>, key: string, target: string) => w.vercel.state.envs.filter((e) => e.key === key && e.target.includes(target));

describe('launch', () => {
  it('wants --dry-run or --apply, the project names, and the three tokens', async () => {
    expect(() => parseArgs(['--supabase-ref', 'abcdefghijklmnopqrst', '--vercel-project', 'tinytown'])).toThrow(/--dry-run .* or --apply/);
    expect(() => parseArgs(['--supabase-ref', 'abcdefghijklmnopqrst', '--vercel-project', 'tinytown', '--dry-run', '--apply'])).toThrow(/--dry-run/);
    expect(() => parseArgs(['--vercel-project', 'tinytown', '--apply'])).toThrow(/--supabase-ref/);
    expect(parseArgs(['--supabase-ref=abcdefghijklmnopqrst', '--vercel-project=tinytown', '--apply', '--no-deploy', '--live'])).toMatchObject({ apply: true, deploy: false, live: true });
    const w = world();
    await expect(run(w, ['--apply'], { STRIPE_SECRET_KEY: ENV.STRIPE_SECRET_KEY })).rejects.toThrow(/Missing from the environment: SUPABASE_ACCESS_TOKEN, VERCEL_TOKEN/);
    expect(w.net.calls).toEqual([]);
    expect(() => stripeKeys({ STRIPE_SECRET_KEY: LIVE }, false)).toThrow(/STRIPE_LIVE_SECRET_KEY/);
    expect(() => stripeKeys({ STRIPE_SECRET_KEY: ENV.STRIPE_SECRET_KEY }, true)).toThrow(/--live needs STRIPE_LIVE_SECRET_KEY/);
    expect(stripeKeys({ STRIPE_SECRET_KEY: ENV.STRIPE_SECRET_KEY, STRIPE_LIVE_SECRET_KEY: LIVE }, true)).toEqual({ test: ENV.STRIPE_SECRET_KEY, live: LIVE });
  });

  it('a dry run reads everything and writes nothing', async () => {
    const w = world();
    const { r, out } = await run(w, ['--dry-run']);
    const writes = w.net.writes().filter((c) => !(c.path.endsWith('/database/query') && c.body.read_only));
    expect(writes).toEqual([]);
    expect(r.todo[0]).toMatch(/dry run/);
    expect(out).toContain('DRY RUN');
    expect(out).toMatch(/TOKEN_ENCRYPTION_KEY\s+would generate\s+production, preview/);
    expect(out).toMatch(/Deployment\s+would deploy\s+claude\/launch to preview/);
    expectNoSecrets(out, secretsIn(w));
  });

  it('provisions everything, deploys a preview that passes its checks, and prints no secret', async () => {
    const w = world();
    const env = { ...ENV, RESEND_API_KEY: 're_RESENDkeyRESENDkey12345', STRIPE_APP_CLIENT_ID: 'ca_ABCDEF123' };
    const { r, out } = await run(w, ['--apply', '--email-from', 'TinyTown <hello@mail.tinytown.example>', '--admin-emails', 'owner@tinytown.example'], env);
    expect(r.failed).toBeNull();

    // Stripe test mode made the price, coupon, webhook and portal, pointed at the production address.
    const test = w.stripe.accounts.get(ENV.STRIPE_SECRET_KEY)!;
    expect(test.webhook_endpoints.map((e) => e.url)).toEqual(['https://tinytown.vercel.app/api/billing/webhook']);
    // Supabase: every migration, Auth at the same address, previews of the team allowed back in.
    expect(w.supabase.state.history).toHaveLength(9);
    expect(w.supabase.state.auth.site_url).toBe('https://tinytown.vercel.app');
    expect(String(w.supabase.state.auth.uri_allow_list)).toContain('https://*-my-team.vercel.app/**');
    expect(w.supabase.state.auth.smtp_host).toBe('smtp.resend.com');

    // Vercel: the values moved across in memory, onto the app's own names.
    for (const t of ['production', 'preview']) {
      expect(envOf(w, 'STRIPE_BILLING_SECRET_KEY', t)[0]!.value).toBe(ENV.STRIPE_SECRET_KEY);
      expect(envOf(w, 'STRIPE_APP_SECRET_KEY', t)[0]!.value).toBe(ENV.STRIPE_SECRET_KEY);
      expect(envOf(w, 'STRIPE_WEBHOOK_SECRET', t)[0]!.value).toBe(test.webhook_endpoints[0]!.secret);
      expect(envOf(w, 'STRIPE_PRICE_YEARLY', t)[0]!.value).toBe(test.prices[0]!.id);
      expect(envOf(w, 'SUPABASE_SERVICE_ROLE_KEY', t)[0]!.value).toBe(SB_KEYS.secret);
      expect(envOf(w, 'ALLOW_TEST_MODE', t)[0]!.value).toBe('1');
      expect(envOf(w, 'RESEND_API_KEY', t)[0]!.type).toBe('sensitive');
      expect(envOf(w, 'GITHUB_APP_SLUG', t)[0]!.value).toBe('tinytown');
      expect(envOf(w, 'STRIPE_APP_CLIENT_ID', t)[0]!.value).toBe('ca_ABCDEF123');
    }
    expect(envOf(w, 'APP_URL', 'production')[0]!.value).toBe('https://tinytown.vercel.app');
    expect(w.vercel.project.link.productionBranch).toBe('main');

    // A preview of the current branch, opened through a bypass for automation, checked deep with its own HEALTH_SECRET.
    expect(w.vercel.state.deployments).toEqual([expect.objectContaining({ target: null, ref: 'claude/launch', readyState: 'READY' })]);
    expect(r.checks.map((c) => [c.name, c.ok])).toEqual([
      ['/api/config', true],
      ['/api/health', true],
      ['/api/health?deep=1', true],
    ]);
    expect(out).toMatch(/Protection bypass\s+created/);
    expect(r.done.at(-1)).toMatch(/Deployed claude\/launch to preview/);
    // Nothing the owner provided is still missing except going live and the by-hand settings.
    expect(r.todo.join('\n')).not.toMatch(/GitHub App \(|STRIPE_APP_CLIENT_ID|RESEND_API_KEY|--admin-emails/);
    expect(r.todo.join('\n')).toMatch(/STRIPE_LIVE_SECRET_KEY/);
    expect(out).toContain('Still to do:');
    expectNoSecrets(out, secretsIn(w, env));
  });

  it('a second run changes nothing but deploying again', async () => {
    const w = world();
    await run(w, ['--apply']);
    const before = w.net.calls.length;
    const envs = JSON.stringify(w.vercel.state.envs);
    const auth = w.supabase.state.patches.length;
    const { r, out } = await run(w, ['--apply']);
    const writes = w.net.calls.slice(before).filter((c) => c.method !== 'GET' && !(c.path.endsWith('/database/query') && c.body.read_only));
    // Stripe re-saves its portal settings (to the same values); Vercel only gets the new deployment.
    expect(writes.map((c) => `${c.host} ${c.method} ${c.path.replace(/bpc_\w+/, 'bpc_')}`)).toEqual(['api.stripe.com POST /v1/billing_portal/configurations/bpc_', 'api.vercel.com POST /v13/deployments']);
    expect(JSON.stringify(w.vercel.state.envs)).toBe(envs);
    expect(w.supabase.state.patches).toHaveLength(auth);
    expect(out).not.toMatch(/\b(set|updated|generated|created)\b +(production|preview)/);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    // No new HEALTH_SECRET this time, and the existing one can't be read back: the deep check is left to the monitor.
    expect(r.checks.map((c) => c.name)).toEqual(['/api/config', '/api/health']);
    expectNoSecrets(out, secretsIn(w));
  });

  it('with --live, Production gets live Stripe and Preview keeps test money', async () => {
    const w = world();
    await run(w, ['--apply', '--no-deploy']);
    const env = { ...ENV, STRIPE_LIVE_SECRET_KEY: LIVE };
    const { r, out } = await run(w, ['--apply', '--live', '--production'], env);
    expect(r.failed).toBeNull();
    const live = w.stripe.accounts.get(LIVE)!;
    const test = w.stripe.accounts.get(ENV.STRIPE_SECRET_KEY)!;
    expect(envOf(w, 'STRIPE_BILLING_SECRET_KEY', 'production').map((e) => e.value)).toEqual([LIVE]);
    expect(envOf(w, 'STRIPE_BILLING_SECRET_KEY', 'preview').map((e) => e.value)).toEqual([ENV.STRIPE_SECRET_KEY]);
    expect(envOf(w, 'STRIPE_WEBHOOK_SECRET', 'production').map((e) => e.value)).toEqual([live.webhook_endpoints[0]!.secret]);
    expect(envOf(w, 'STRIPE_WEBHOOK_SECRET', 'preview').map((e) => e.value)).toEqual([test.webhook_endpoints[0]!.secret]);
    expect(envOf(w, 'STRIPE_PRICE_YEARLY', 'production')[0]!.value).toMatch(/^price_live_/);
    expect(envOf(w, 'ALLOW_TEST_MODE', 'production')).toEqual([]);
    expect(envOf(w, 'ALLOW_TEST_MODE', 'preview')).toHaveLength(1);
    // Generated secrets survived the switch.
    expect(out).toMatch(/TOKEN_ENCRYPTION_KEY\s+kept\s+production, preview/);
    // A live key never reached Preview.
    for (const e of w.vercel.state.envs) if (e.target.includes('preview')) expect(e.value).not.toMatch(/^(sk|rk)_live_/);
    expect(w.vercel.state.deployments.at(-1)).toMatchObject({ target: 'production', ref: 'main' });
    expect(r.todo.join('\n')).not.toMatch(/Live payments/);
    expectNoSecrets(out, secretsIn(w, env));
  });

  it('stops at a failing migration before touching Vercel’s variables or deploying', async () => {
    const w = world({ supabase: { failOn: '0003' } });
    const { r, out } = await run(w, ['--apply']);
    expect(r.failed).toMatch(/0003_pipelines\.sql failed/);
    expect(w.vercel.state.envs).toEqual([]);
    expect(w.vercel.state.deployments).toEqual([]);
    expect(out).toContain('Stopped: Migration 0003_pipelines.sql failed');
    expect(r.todo[0]).toMatch(/Fix the migration/);
  });

  it('says how to recover a webhook secret Stripe will not show again', async () => {
    const w = world();
    await run(w, ['--apply', '--no-deploy']);
    // Say the first run died before Vercel saved it.
    w.vercel.state.envs = w.vercel.state.envs.filter((e) => e.key !== 'STRIPE_WEBHOOK_SECRET');
    const { r, out } = await run(w, ['--apply', '--no-deploy']);
    expect(r.todo.join('\n')).toMatch(/Billing on production needs STRIPE_WEBHOOK_SECRET.*Signing secret.*or delete that endpoint/);
    expect(out).toMatch(/STRIPE_BILLING_SECRET_KEY\s+held back\s+production, preview/);
    expect(out).toMatch(/already has part of it on production, so the next build there fails/);
    expectNoSecrets(out, secretsIn(w));
  });

  it('lists what the owner still has to provide when the optional secrets are missing', async () => {
    const w = world();
    const { r } = await run(w, ['--apply', '--no-deploy'], { SUPABASE_ACCESS_TOKEN: 'sbp_token', VERCEL_TOKEN: 'vercel_token', STRIPE_SECRET_KEY: ENV.STRIPE_SECRET_KEY });
    const todo = r.todo.join('\n');
    expect(todo).toMatch(/The GitHub App \(docs\/OWNER_STEPS.md step 6\): add GITHUB_APP_ID, GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY/);
    expect(todo).toMatch(/STRIPE_APP_CLIENT_ID/);
    expect(todo).toMatch(/RESEND_API_KEY/);
    expect(todo).toMatch(/--admin-emails/);
    expect(todo).toMatch(/Deploy: run again without --no-deploy/);
    expect(envOf(w, 'GITHUB_APP_SLUG', 'production')).toEqual([]);
  });
});
