import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkEnv, readPem } from '../server/env.ts';
import {
  ENV_GROUPS,
  GENERATED,
  deploy,
  domainUrl,
  ensureProject,
  findProject,
  fingerprint,
  planEnv,
  productionUrl,
  scrub,
  smokeCheck,
  syncEnv,
  tinytownEnv,
  vercelClient,
  type DesiredEnv,
  type ExistingEnv,
} from '../tools/vercel-setup.mjs';
import { combine, fakeVercel } from './tools-fakes.ts';

/**
 * tools/vercel-setup.mjs against an in-memory Vercel: variables are set per
 * target, a re-run changes nothing (Sensitive values compared by
 * fingerprint), generated secrets are made once and never rotated, a
 * half-set feature is held back, a live Stripe key never reaches Preview,
 * and the smoke checks catch a secret in /api/config.
 */

const client = (v: ReturnType<typeof fakeVercel>) => {
  const net = combine(v);
  return { net, api: vercelClient({ token: 'vercel_token', team: 'my-team', fetch: net.fetch as never, retryDelayMs: 0 }) };
};
const both = (value: string | null) => ({ production: value, preview: value });
const STRIPE_TEST = { mode: 'test' as const, key: ['sk', 'test', 'TESTKEYtestkey123456'].join('_'), env: { STRIPE_PRICE_YEARLY: 'price_test_1', STRIPE_OFFER_COUPON: 'tinytown_first_year_9', STRIPE_WEBHOOK_SECRET: 'whsec_TESTsecret123456', STRIPE_PORTAL_CONFIGURATION: 'bpc_1' } };

describe('vercel-setup', () => {
  it('holds the same feature groups as the server’s boot check', () => {
    // Setting the first variable of each group alone must be what server/env.ts calls half set up, naming the same variables.
    for (const g of ENV_GROUPS) {
      const messages = checkEnv({ [g.vars[0]!]: 'x' }).map((p) => p.message).filter((m) => m.includes('half set up'));
      expect(messages, g.name).toHaveLength(1);
      for (const v of g.vars) expect(messages[0]).toContain(v);
    }
    // And the generated secrets pass its checks (32 bytes, long enough).
    const secrets = Object.fromEntries(GENERATED.map((k) => [k, Buffer.alloc(32, 7).toString('base64')]));
    expect(checkEnv({ ...secrets, VERCEL: '1' }).filter((p) => /32 random bytes|is short/.test(p.message))).toEqual([]);
  });

  it('finds the project, sets the production branch and Node 22, and knows its address', async () => {
    const v = fakeVercel({ domains: [{ name: 'tinytown.vercel.app' }, { name: 'tinytown.app' }] });
    const { api, net } = client(v);
    const project = await findProject(api, 'tinytown');
    const dry = await ensureProject(api, project, { dryRun: true });
    expect(net.writes()).toEqual([]);
    expect(dry.steps.map((s) => `${s.thing}: ${s.action}`)).toEqual(['Git repository: connected', 'Production branch: would set', 'Node.js version: would set']);
    const r = await ensureProject(api, project, { dryRun: false });
    expect(r.steps.map((s) => s.action)).toEqual(['connected', 'set', 'set']);
    expect(v.project.link.productionBranch).toBe('main');
    expect(v.project.nodeVersion).toBe('22.x');
    expect(await productionUrl(api, project)).toBe('https://tinytown.app');
    await expect(findProject(api, 'nope')).rejects.toThrow(/No Vercel project called "nope" in the team my-team/);
    expect(domainUrl('tinytown.app')).toBe('https://tinytown.app');
    expect(() => domainUrl('http://tinytown.app')).toThrow(/https/);
  });

  it('says how to set the production branch by hand when the API refuses', async () => {
    const v = fakeVercel({ branchApi: false });
    const { api } = client(v);
    const r = await ensureProject(api, await findProject(api, 'tinytown'), { dryRun: false });
    expect(r.steps.find((s) => s.thing === 'Production branch')!.action).toBe('by hand');
    expect(r.notes.join(' ')).toContain('Settings → Git → Production Branch → main');
  });

  it('sets every variable once, as Sensitive where secret, and a second run changes nothing', async () => {
    const v = fakeVercel();
    const { api, net } = client(v);
    const project = await findProject(api, 'tinytown');
    const { desired } = tinytownEnv({
      supabase: { url: 'https://ref.supabase.co', anonKey: 'sb_publishable_abc123456789', serviceKey: 'sb_secret_abc123456789' },
      stripe: { production: STRIPE_TEST, preview: STRIPE_TEST },
      appUrl: 'https://tinytown.vercel.app',
      env: {},
    });
    const dry = await syncEnv(api, project, desired, { dryRun: true });
    expect(net.writes()).toEqual([]);
    expect(dry.steps.find((s) => s.thing === 'TOKEN_ENCRYPTION_KEY')).toEqual({ thing: 'TOKEN_ENCRYPTION_KEY', action: 'would generate', id: 'production, preview' });
    expect(dry.generated).toEqual({ production: expect.any(Object), preview: expect.any(Object) });

    const first = await syncEnv(api, project, desired, { dryRun: false });
    const env = (key: string, t: string) => v.state.envs.filter((e) => e.key === key && e.target.includes(t));
    for (const t of ['production', 'preview']) {
      for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'STRIPE_BILLING_SECRET_KEY', 'STRIPE_APP_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_YEARLY', 'STRIPE_OFFER_COUPON', 'STRIPE_PORTAL_CONFIGURATION', 'ALLOW_TEST_MODE', ...GENERATED]) {
        expect(env(k, t), `${k} on ${t}`).toHaveLength(1);
      }
    }
    expect(env('APP_URL', 'production')).toHaveLength(1);
    expect(env('APP_URL', 'preview')).toHaveLength(0);
    expect(env('SUPABASE_SERVICE_ROLE_KEY', 'production')[0]!.type).toBe('sensitive');
    expect(env('SUPABASE_URL', 'production')[0]!.type).toBe('encrypted');
    expect(env('STRIPE_WEBHOOK_SECRET', 'production')[0]!.type).toBe('sensitive');
    // Each target gets its own generated secrets: 32 random bytes, base64.
    for (const k of GENERATED) {
      const [p, q] = [env(k, 'production')[0]!, env(k, 'preview')[0]!];
      expect(p.value).not.toBe(q.value);
      expect(Buffer.from(p.value, 'base64')).toHaveLength(32);
      expect(p.type).toBe('sensitive');
      expect(first.generated.production[k]).toBe(p.value);
    }
    expect(env('TOKEN_ENCRYPTION_KEY', 'production')[0]!.comment).toMatch(/Never change it/);
    // Shared values share one variable; nothing says what a value is.
    expect(env('SUPABASE_URL', 'production')[0]!.target).toEqual(['production', 'preview']);
    expect(JSON.stringify(first.steps)).not.toMatch(/sb_secret_|sk_test_|whsec_|price_test/);

    const before = net.writes().length;
    const snapshot = JSON.stringify(v.state.envs);
    const second = await syncEnv(api, project, desired, { dryRun: false });
    expect(net.writes().slice(before)).toEqual([]);
    expect(JSON.stringify(v.state.envs)).toBe(snapshot);
    expect(new Set(second.steps.map((s) => s.action))).toEqual(new Set(['unchanged', 'kept']));
    expect(second.generated).toEqual({ production: {}, preview: {} });
  });

  it('never replaces a generated secret that is already there, even set by hand', () => {
    const existing: ExistingEnv[] = [
      { id: 'env_a', key: 'TOKEN_ENCRYPTION_KEY', type: 'sensitive', target: ['production'], value: '' },
      { id: 'env_b', key: 'STATE_SECRET', type: 'sensitive', target: ['production', 'preview'], value: '' },
    ];
    const desired: DesiredEnv[] = GENERATED.map((key) => ({ key, secret: true, generate: ['production', 'preview'] }));
    const plan = planEnv(existing, desired);
    expect(plan.status.TOKEN_ENCRYPTION_KEY).toEqual({ production: 'kept', preview: 'generated' });
    expect(plan.status.STATE_SECRET).toEqual({ production: 'kept', preview: 'kept' });
    expect(plan.ops.some((o) => o.op !== 'create')).toBe(false);
    expect(plan.ops.filter((o) => o.key === 'TOKEN_ENCRYPTION_KEY').map((o) => (o as { targets: string[] }).targets)).toEqual([['preview']]);
    expect(Object.keys(plan.generated.production)).toEqual(['CRON_SECRET', 'HEALTH_SECRET']);
  });

  it('updates a value that changed, compares Sensitive values by fingerprint, and splits a shared variable', () => {
    const existing: ExistingEnv[] = [
      { id: 'env_1', key: 'SUPABASE_URL', type: 'encrypted', target: ['production', 'preview'], value: 'https://old.supabase.co', decrypted: true },
      { id: 'env_2', key: 'SUPABASE_SERVICE_ROLE_KEY', type: 'sensitive', target: ['production', 'preview'], value: '', comment: `fp:${fingerprint('SUPABASE_SERVICE_ROLE_KEY', 'sb_secret_same')}` },
      { id: 'env_3', key: 'STRIPE_BILLING_SECRET_KEY', type: 'sensitive', target: ['production', 'preview'], value: '', comment: `fp:${fingerprint('STRIPE_BILLING_SECRET_KEY', 'sk_test_old')}` },
      // The rest of their groups, so nothing is held back.
      { id: 'env_6', key: 'SUPABASE_ANON_KEY', type: 'encrypted', target: ['production', 'preview'], value: 'sb_publishable_x', decrypted: true },
      { id: 'env_7', key: 'STRIPE_PRICE_YEARLY', type: 'encrypted', target: ['production', 'preview'], value: 'price_y', decrypted: true },
      { id: 'env_8', key: 'STRIPE_WEBHOOK_SECRET', type: 'sensitive', target: ['production', 'preview'], value: '' },
      { id: 'env_4', key: 'STRIPE_PRICE_MONTHLY', type: 'encrypted', target: ['production'], value: 'price_m', decrypted: true },
      { id: 'env_5', key: 'ALLOW_TEST_MODE', type: 'encrypted', target: ['production', 'preview'], value: '1', decrypted: true },
    ];
    const plan = planEnv(existing, [
      { key: 'SUPABASE_URL', secret: false, values: both('https://new.supabase.co') },
      { key: 'SUPABASE_SERVICE_ROLE_KEY', secret: true, values: both('sb_secret_same') },
      { key: 'STRIPE_BILLING_SECRET_KEY', secret: true, values: { production: 'sk_live_new', preview: 'sk_test_old' } },
      { key: 'STRIPE_PRICE_MONTHLY', secret: false, remove: ['production', 'preview'] },
      { key: 'ALLOW_TEST_MODE', secret: false, values: { preview: '1' }, remove: ['production'] },
    ]);
    expect(plan.status).toMatchObject({
      SUPABASE_URL: { production: 'updated', preview: 'updated' },
      SUPABASE_SERVICE_ROLE_KEY: { production: 'unchanged', preview: 'unchanged' },
      STRIPE_PRICE_MONTHLY: { production: 'removed' },
      ALLOW_TEST_MODE: { production: 'removed', preview: 'set' },
    });
    expect(plan.ops).toContainEqual(expect.objectContaining({ op: 'update', id: 'env_1', value: 'https://new.supabase.co' }));
    expect(plan.ops).toContainEqual({ op: 'delete', id: 'env_4', key: 'STRIPE_PRICE_MONTHLY' });
    // The billing key now differs by target: the shared variable is split, never overwritten for both.
    const billing = plan.ops.filter((o) => o.key === 'STRIPE_BILLING_SECRET_KEY');
    expect(billing.map((o) => o.op).sort()).toEqual(['create', 'create', 'delete']);
    expect(plan.ops.findIndex((o) => o.op === 'delete')).toBeLessThan(plan.ops.findIndex((o) => o.op === 'create'));
  });

  it('keeps a webhook secret it can’t see, and holds billing back where it would be half set', () => {
    // Stripe shows the secret once; on this run it's already been shown, and Production never got it.
    const existing: ExistingEnv[] = [{ id: 'env_w', key: 'STRIPE_WEBHOOK_SECRET', type: 'sensitive', target: ['preview'], value: '' }];
    const env = { ...STRIPE_TEST, env: { ...STRIPE_TEST.env, STRIPE_WEBHOOK_SECRET: null } };
    const { desired } = tinytownEnv({ stripe: { production: env, preview: env }, env: {} });
    const plan = planEnv(existing, desired);
    expect(plan.status.STRIPE_WEBHOOK_SECRET).toEqual({ production: 'missing', preview: 'kept' });
    expect(plan.status.STRIPE_BILLING_SECRET_KEY).toEqual({ production: 'held back', preview: 'set' });
    expect(plan.status.STRIPE_PRICE_YEARLY).toEqual({ production: 'held back', preview: 'set' });
    expect(plan.heldBack).toEqual([{ group: 'Billing', target: 'production', missing: ['STRIPE_WEBHOOK_SECRET'], planned: ['STRIPE_BILLING_SECRET_KEY', 'STRIPE_PRICE_YEARLY'], alreadyHalfSet: false }]);
    expect(plan.ops.filter((o) => o.op === 'create' && o.targets.includes('production') && o.key.startsWith('STRIPE_BILLING'))).toEqual([]);
  });

  it('never puts a live Stripe key on Preview, or the test-mode switch next to live billing', async () => {
    const v = fakeVercel();
    const { api, net } = client(v);
    const project = await findProject(api, 'tinytown');
    const live = { ...STRIPE_TEST, mode: 'live' as const, key: ['sk', 'live', 'LIVEKEY123456'].join('_') };
    await expect(syncEnv(api, project, tinytownEnv({ stripe: { preview: live }, env: {} }).desired, { dryRun: true })).rejects.toThrow(/live Stripe key in Preview/);
    await expect(syncEnv(api, project, [{ key: 'STRIPE_BILLING_SECRET_KEY', secret: true, values: { production: 'sk_live_x' } }, { key: 'ALLOW_TEST_MODE', secret: false, values: { production: '1' } }], { dryRun: true })).rejects.toThrow(/ALLOW_TEST_MODE=1 on Production/);
    expect(net.writes()).toEqual([]);
    // Live billing on Production takes the test-mode switch off it.
    const { desired } = tinytownEnv({ stripe: { production: live, preview: STRIPE_TEST }, env: {} });
    expect(desired.find((d) => d.key === 'ALLOW_TEST_MODE')).toMatchObject({ values: { preview: '1' }, remove: ['production'] });
  });

  it('passes the GitHub App and Stripe App values through, one-lining the private key, and lists what is missing', () => {
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const env = { GITHUB_APP_ID: '123', GITHUB_APP_CLIENT_ID: 'Iv1.abc', GITHUB_APP_CLIENT_SECRET: 'ghsecret_123456789', GITHUB_APP_SLUG: 'tinytown', GITHUB_APP_PRIVATE_KEY: pem };
    const { desired, missing } = tinytownEnv({ env });
    const key = desired.find((d) => d.key === 'GITHUB_APP_PRIVATE_KEY')!;
    expect(key.secret).toBe(true);
    expect(key.values!.production).not.toContain('\n');
    expect(readPem(key.values!.production!)).toBe(pem.trim());
    expect(missing).toEqual(['STRIPE_APP_CLIENT_ID', 'RESEND_API_KEY', 'EMAIL_FROM (--email-from)', 'ADMIN_EMAILS (--admin-emails)']);
    const bad = tinytownEnv({ env: { ...env, GITHUB_APP_PRIVATE_KEY: 'not a key' } });
    expect(bad.desired.find((d) => d.key === 'GITHUB_APP_PRIVATE_KEY')).toBeUndefined();
    expect(bad.missing[0]).toMatch(/GITHUB_APP_PRIVATE_KEY \(set, but not a readable private key/);
    // An incomplete GitHub App is held back rather than breaking the build.
    const partial = tinytownEnv({ env: { GITHUB_APP_SLUG: 'tinytown', GITHUB_APP_CLIENT_ID: 'Iv1.abc' } });
    expect(planEnv([], partial.desired).heldBack.map((h) => `${h.group} ${h.target}`)).toEqual(['The GitHub App production', 'The GitHub App preview']);
  });

  it('deploys the branch and waits for it, and reports a failed build with its log', async () => {
    const v = fakeVercel();
    const { api } = client(v);
    const project = await findProject(api, 'tinytown');
    const waits: string[] = [];
    const d = await deploy(api, project, { branch: 'claude/x', sleep: async () => {}, onWait: (s) => waits.push(s) });
    expect(d.state).toBe('READY');
    expect(d.url).toBe('https://tinytown-claude-x-my-team.vercel.app');
    expect(v.state.deployments[0]).toMatchObject({ target: null, ref: 'claude/x' });
    expect(waits).toEqual(['QUEUED', 'BUILDING']);
    await deploy(api, project, { branch: 'main', production: true, sleep: async () => {} });
    expect(v.state.deployments[1]).toMatchObject({ target: 'production', ref: 'main' });

    const broken = fakeVercel({ failBuild: true });
    const b = client(broken);
    await expect(deploy(b.api, await findProject(b.api, 'tinytown'), { branch: 'main', sleep: async () => {} })).rejects.toThrow(/deployment failed: Command "npm run build/);
  });

  it('smoke-checks /api/config and /api/health, and fails on a secret in the config', async () => {
    const ok = combine(fakeVercel({ protectedPreviews: false }));
    const checks = await smokeCheck({ baseUrl: 'https://tinytown.vercel.app', fetch: ok.fetch as never, secrets: ['sk_test_never_in_config'] });
    expect(checks.map((c) => [c.name, c.ok])).toEqual([
      ['/api/config', true],
      ['/api/health', true],
    ]);
    expect(checks[0]!.detail).toContain('hosted');

    const leaky = combine(fakeVercel({ protectedPreviews: false, config: { hosted: true, supabase: { anonKey: 'sb_secret_LEAKEDleaked123' } } }));
    const bad = await smokeCheck({ baseUrl: 'https://tinytown.vercel.app', fetch: leaky.fetch as never, secrets: [] });
    expect(bad[0]).toMatchObject({ name: '/api/config', ok: false });
    expect(bad[0]!.detail).toMatch(/contains a secret/);
    expect(bad[0]!.detail).not.toContain('LEAKED');

    const local = combine(fakeVercel({ protectedPreviews: false, config: { hosted: false } }));
    expect((await smokeCheck({ baseUrl: 'https://tinytown.vercel.app', fetch: local.fetch as never }))[0]!.detail).toMatch(/hosted: false/);

    const locked = combine(fakeVercel());
    expect((await smokeCheck({ baseUrl: 'https://tinytown-x-my-team.vercel.app', fetch: locked.fetch as never }))[0]!.detail).toMatch(/401 \(Vercel Deployment Protection/);
  });

  it('scrubs known secrets out of anything it prints', () => {
    expect(scrub('key sk_test_abcdefgh and sk_test_abcdefghij', ['sk_test_abcdefgh', 'sk_test_abcdefghij'])).toBe('key <hidden> and <hidden>');
    expect(scrub('short abc stays', ['abc'])).toBe('short abc stays');
  });
});
