import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { authTemplates } from '../server/email/auth-templates.ts';
import {
  HISTORY_TABLE,
  MIGRATIONS_DIR,
  checkRef,
  checkSiteUrl,
  fetchApiKeys,
  migrationQuery,
  parseArgs,
  parseFrom,
  readMigrations,
  redirectList,
  report,
  setupSupabase,
  supabaseClient,
} from '../tools/supabase-setup.mjs';
import { SB_KEYS, combine, fakeSupabase, type FakeSupabaseOptions } from './tools-fakes.ts';

/**
 * tools/supabase-setup.mjs against an in-memory Management API: migrations
 * run in order and land in Supabase's own history table, applied ones are
 * skipped, the first failure stops the run, Auth is set once (a second run
 * sends nothing), and the API keys are read but never printed.
 */

const SITE = 'https://tinytown.example';
const run = (sb: ReturnType<typeof fakeSupabase>, over: Record<string, unknown> = {}) => {
  const net = combine(sb);
  return { net, result: setupSupabase({ token: 'sbp_token', ref: sb.ref, siteUrl: SITE, dryRun: false, fetch: net.fetch as never, retryDelayMs: 0, ...over }) };
};
const setup = async (o: FakeSupabaseOptions = {}, over: Record<string, unknown> = {}) => {
  const sb = fakeSupabase(o);
  const { net, result } = run(sb, over);
  return { sb, net, r: await result };
};

describe('supabase-setup', () => {
  it('reads every migration file in order, with the CLI’s version numbers', async () => {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const ms = await readMigrations();
    expect(ms.map((m) => m.file)).toEqual(files);
    expect(ms.slice(0, 3).map((m) => [m.version, m.name])).toEqual([
      ['0001', 'init'],
      ['0002', 'platform'],
      ['0003', 'pipelines'],
    ]);
    // The history row rides in the same request as the file, and the file can't break out of its quoting.
    const q = migrationQuery({ file: 'x.sql', version: '0042', name: "it's", sql: 'select $tinytown_migration$;' });
    expect(q).toContain(`insert into ${HISTORY_TABLE} (version, name, statements) values ('0042', 'it''s', array[$tinytown_migration_1$select $tinytown_migration$;$tinytown_migration_1$])`);
  });

  it('checks its inputs before calling anything', () => {
    expect(() => checkRef(undefined)).toThrow(/--ref/);
    expect(() => checkRef('../v1/other')).toThrow(/reference/);
    expect(checkSiteUrl('https://tinytown.example/')).toBe(SITE);
    expect(() => checkSiteUrl('http://tinytown.example')).toThrow(/https/);
    expect(() => checkSiteUrl('https://tinytown.example/app')).toThrow(/no path/);
    expect(parseFrom('TinyTown <hello@mail.tinytown.example>')).toEqual({ name: 'TinyTown', email: 'hello@mail.tinytown.example' });
    expect(parseFrom('hello@mail.tinytown.example')).toEqual({ name: 'TinyTown', email: 'hello@mail.tinytown.example' });
    expect(() => parseFrom('nobody')).toThrow(/--email-from/);
    expect(parseArgs(['--ref', 'abcdefghijklmnopqrst', '--site-url', SITE])).toMatchObject({ apply: false, emailRate: 2000 });
    expect(parseArgs(['--ref=abcdefghijklmnopqrst', '--apply', '--mark-applied', '0001,0002'])).toMatchObject({ apply: true, markApplied: ['0001', '0002'] });
    expect(() => parseArgs(['--force'])).toThrow(/Unknown/);
    expect(() => supabaseClient(undefined)).toThrow(/SUPABASE_ACCESS_TOKEN/);
  });

  it('a dry run only reads, and says what it would do', async () => {
    const { sb, net, r } = await setup({}, { dryRun: true });
    const writes = net.writes().filter((c) => !(c.path.endsWith('/database/query') && c.body.read_only));
    expect(writes).toEqual([]);
    expect(sb.state.history).toBeNull();
    expect(r.steps.find((s) => s.thing === 'Migration history')!.action).toBe('would create');
    expect(r.steps.filter((s) => s.action === 'would apply')).toHaveLength((await readMigrations()).length);
    expect(r.steps.find((s) => s.thing === 'Email templates')!.action).toBe('would update');
    expect(report(r)).toContain('Dry run: nothing was changed (add --apply).');
  });

  it('applies every migration in order into Supabase’s own history, then sets Auth and reads the keys', async () => {
    const { sb, r } = await setup();
    const versions = (await readMigrations()).map((m) => m.version);
    expect(r.failed).toBeNull();
    expect(sb.state.ran).toEqual(versions);
    expect(sb.state.history).toEqual(versions);
    expect(r.steps.find((s) => s.thing === 'Migration history')!.action).toBe('created');

    // Auth: one PATCH with the site, redirects, email sign-in and all six templates.
    expect(sb.state.patches).toHaveLength(1);
    const patch = sb.state.patches[0]!;
    expect(patch).toMatchObject({ site_url: SITE, external_email_enabled: true, mailer_autoconfirm: false, mailer_otp_exp: 3600 });
    expect(String(patch.uri_allow_list).split(',')).toEqual([`${SITE}/**`, `${SITE}/admin.html`, 'http://localhost:5173/**']);
    for (const t of authTemplates()) {
      const kind = t.file.replace('.html', '');
      expect(patch[`mailer_subjects_${kind}`]).toBe(t.subject);
      expect(patch[`mailer_templates_${kind}_content`]).toBe(t.html);
    }
    // No Resend key, so no SMTP and no email limit (Supabase refuses one without custom SMTP).
    expect(patch).not.toHaveProperty('smtp_host');
    expect(patch).not.toHaveProperty('rate_limit_email_sent');
    expect(r.notes.join(' ')).toMatch(/built-in mailer: 2 an hour/);

    // New-style keys, in memory only.
    expect(r.keys).toEqual({ url: `https://${sb.ref}.supabase.co`, anonKey: SB_KEYS.publishable, serviceKey: SB_KEYS.secret, kind: 'publishable and secret keys' });
    const text = report(r);
    for (const v of Object.values(SB_KEYS)) expect(text).not.toContain(v);
    expect(text).toContain('(not shown)');
  });

  it('a second run changes nothing', async () => {
    const sb = fakeSupabase();
    await run(sb).result;
    const { net, result } = run(sb);
    const r = await result;
    const writes = net.writes().filter((c) => !(c.path.endsWith('/database/query') && c.body.read_only));
    expect(writes).toEqual([]);
    expect(r.steps.filter((s) => s.thing.startsWith('Migration ')).every((s) => s.action === 'already applied')).toBe(true);
    expect(r.steps.filter((s) => !s.thing.startsWith('Migration ') && !['Project', 'API keys', 'Custom SMTP'].includes(s.thing)).map((s) => s.action)).toEqual(Array(5).fill('unchanged'));
  });

  it('skips migrations already in the history and runs only the rest', async () => {
    const { sb, r } = await setup({ history: ['0001', '0002', '0003'] });
    expect(sb.state.ran[0]).toBe('0004');
    expect(sb.state.ran).not.toContain('0001');
    expect(r.steps.filter((s) => s.action === 'already applied').map((s) => s.thing)).toEqual(['Migration 0001', 'Migration 0002', 'Migration 0003']);
  });

  it('stops on the first failing migration, records nothing for it, and leaves Auth alone', async () => {
    const { sb, r } = await setup({ history: ['0001', '0002'], failOn: '0004' });
    expect(sb.state.ran).toEqual(['0003']);
    expect(sb.state.history).toEqual(['0001', '0002', '0003']);
    expect(r.failed).toMatch(/0004_admin_waitlist\.sql failed/);
    expect(r.failed).toMatch(/--mark-applied 0004/);
    expect(r.steps.at(-1)).toEqual({ thing: 'Migration 0004', action: 'FAILED', id: '0004_admin_waitlist.sql' });
    expect(sb.state.patches).toEqual([]);
    expect(r.keys).toBeNull();
    expect(report(r)).toContain('Stopped: Migration 0004_admin_waitlist.sql failed');
  });

  it('records a migration that was pasted in by hand without running it', async () => {
    const { sb, r } = await setup({}, { markApplied: ['0001'] });
    expect(sb.state.ran[0]).toBe('0002');
    expect(sb.state.history![0]).toBe('0001');
    expect(r.steps.find((s) => s.thing === 'Migration 0001')!.action).toBe('recorded');
    await expect(setup({}, { markApplied: ['0099'] }).then((x) => x.r)).rejects.toThrow(/no supabase\/migrations\/0099/);
  });

  it('sets up Resend SMTP and the launch email limit given a key and a sender, sending the password only when needed', async () => {
    const sb = fakeSupabase();
    const over = { resendKey: 're_resendKEYresendKEY123456', emailFrom: 'TinyTown <hello@mail.tinytown.example>', emailRate: 2000 };
    const first = await run(sb, over).result;
    expect(sb.state.patches[0]).toMatchObject({ smtp_host: 'smtp.resend.com', smtp_port: '465', smtp_user: 'resend', smtp_admin_email: 'hello@mail.tinytown.example', smtp_sender_name: 'TinyTown', smtp_max_frequency: 60, rate_limit_email_sent: 2000, rate_limit_otp: 60, rate_limit_verify: 60 });
    expect(sb.state.smtpPass).toBe('re_resendKEYresendKEY123456');
    expect(report(first)).not.toContain('re_resendKEY');
    // Again: nothing to change, so the password isn't sent again.
    await run(sb, over).result;
    expect(sb.state.patches).toHaveLength(1);
  });

  it('keeps redirect URLs someone added by hand, and adds the preview pattern', () => {
    expect(redirectList('https://old.example/**,http://localhost:5173/**', SITE, 'https://*-my-team.vercel.app/**').split(',')).toEqual([
      'https://old.example/**',
      'http://localhost:5173/**',
      `${SITE}/**`,
      `${SITE}/admin.html`,
      'https://*-my-team.vercel.app/**',
    ]);
  });

  it('stops on a paused, starting or unhealthy project, and on an unknown ref', async () => {
    await expect(setup({ status: 'INACTIVE' }).then((x) => x.r)).rejects.toThrow(/paused/);
    await expect(setup({ status: 'COMING_UP' }).then((x) => x.r)).rejects.toThrow(/isn't ready yet/);
    await expect(setup({ unhealthy: ['db'] }).then((x) => x.r)).rejects.toThrow(/db \(UNHEALTHY\)/);
    await expect(setup({}, { ref: 'zzzzzzzzzzzzzzzzzzzz' }).then((x) => x.r)).rejects.toThrow(/No Supabase project with the ref zzzz/);
    await expect(setup({}, { token: 'sbp_wrong' }).then((x) => x.r)).rejects.toThrow(/refused SUPABASE_ACCESS_TOKEN/);
  });

  it('falls back to the legacy keys, and refuses masked or swapped ones', async () => {
    const legacy = fakeSupabase({ keys: [{ name: 'anon', type: 'legacy', api_key: SB_KEYS.anon }, { name: 'service_role', type: 'legacy', api_key: SB_KEYS.service }] });
    const api = supabaseClient('sbp_token', combine(legacy).fetch as never);
    expect(await fetchApiKeys(api, legacy.ref)).toMatchObject({ anonKey: SB_KEYS.anon, serviceKey: SB_KEYS.service, kind: 'legacy anon and service_role keys' });
    const masked = fakeSupabase({ keys: [{ name: 'anon', type: 'legacy', api_key: SB_KEYS.anon }, { name: 'service_role', type: 'legacy', api_key: 'eyJ••••' }] });
    await expect(fetchApiKeys(supabaseClient('sbp_token', combine(masked).fetch as never), masked.ref)).rejects.toThrow(/masked/);
    const swapped = fakeSupabase({ keys: [{ name: 'default', type: 'publishable', api_key: SB_KEYS.secret }, { name: 'default', type: 'secret', api_key: SB_KEYS.secret }] });
    await expect(fetchApiKeys(supabaseClient('sbp_token', combine(swapped).fetch as never), swapped.ref)).rejects.toThrow(/wrong way round/);
  });
});
