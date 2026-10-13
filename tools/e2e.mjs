#!/usr/bin/env node
/**
 * End-to-end: the real built app and the real server against fake
 * providers (tools/fake-providers.mjs), driven two ways:
 *
 * - API journeys (tests/e2e/api-journeys.mjs): every hosted flow through
 *   HTTP, exactly as the browser calls it. Fast, and independent of the UI.
 * - UI journeys (tests/e2e/ui-journeys.mjs): the same flows clicked through
 *   in Chromium. A journey whose UI isn't built yet is skipped with the
 *   reason, so the suite stays green while the client lands, and tightens
 *   as it does.
 *
 *   node tools/e2e.mjs                 build, then everything
 *   node tools/e2e.mjs --no-build      use the dist/ that's there
 *   node tools/e2e.mjs --api           API journeys only (no build, no browser)
 *   node tools/e2e.mjs --only=checkout run journeys whose name contains this
 *   node tools/e2e.mjs --verbose       print the server's and the fakes' logs
 *
 * Exits 1 if any journey failed. Failure screenshots, the server log and
 * results.json go to e2e-output/ (TT_E2E_OUT to move it), which CI uploads
 * when the job fails. Playwright comes from a local install (CI:
 * `npm i --no-save playwright` + `npx playwright install chromium`) or the
 * cloud container's global one with its preinstalled Chromium; this script
 * never downloads a browser.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { API_JOURNEYS } from '../tests/e2e/api-journeys.mjs';
import { OUT, ROOT, Skip, startStack } from '../tests/e2e/harness.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const apiOnly = flag('api');
const only = option('only');
const verbose = flag('verbose');

mkdirSync(OUT, { recursive: true });

function build() {
  if (apiOnly || flag('no-build')) return;
  console.log('Building the client (vite build)…');
  const r = spawnSync(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('The client build failed; nothing to test.');
    process.exit(1);
  }
}

const results = [];

async function runAll(journeys, makeT, label) {
  const passed = new Set();
  const t = await makeT();
  for (const j of journeys) {
    if (only && !j.name.includes(only)) continue;
    const t0 = Date.now();
    const result = { suite: label, name: j.name, status: 'pass', ms: 0, note: '' };
    // A journey whose predecessor didn't pass can often set itself up another way (`prepare`).
    const blocked = j.needs && !passed.has(j.needs);
    if (blocked && !j.prepare) {
      result.status = 'skip';
      result.note = `needs "${j.needs}"`;
    } else {
      try {
        if (blocked) {
          result.note = 'set up through the API';
          await j.prepare(t);
        }
        await j.run(t);
        passed.add(j.name);
      } catch (err) {
        if (err instanceof Skip) {
          result.status = 'skip';
          result.note = err.message;
          // A skipped journey's dependants can still run if it set up what they need.
          if (err.provides) passed.add(j.name);
        } else {
          result.status = 'fail';
          result.note = err instanceof Error ? err.message : String(err);
          if (verbose && err instanceof Error) console.error(err.stack);
          await t.onFail?.(j, err);
        }
      }
    }
    result.ms = Date.now() - t0;
    results.push(result);
    const mark = result.status === 'pass' ? 'ok  ' : result.status === 'skip' ? 'skip' : 'FAIL';
    console.log(`${mark} ${j.name}${result.note ? ` (${result.note})` : ''} ${result.status === 'skip' ? '' : `${(result.ms / 1000).toFixed(1)}s`}`);
  }
  await t.close?.();
}

let stack;
try {
  build();
  if (!apiOnly && !existsSync(join(ROOT, 'dist/index.html'))) {
    console.error('dist/index.html is missing: run without --no-build.');
    process.exit(1);
  }
  stack = await startStack({ quiet: !verbose });
  console.log(`Server ${stack.appUrl} · fakes ${stack.fakes.url}\n`);

  await runAll(API_JOURNEYS, () => ({ stack }), 'api');

  if (!apiOnly) {
    const { UI_JOURNEYS, uiContext } = await import('../tests/e2e/ui-journeys.mjs');
    await runAll(UI_JOURNEYS, () => uiContext(stack), 'ui');
  }
} catch (err) {
  results.push({ suite: 'harness', name: 'start the stack', status: 'fail', ms: 0, note: err instanceof Error ? err.message : String(err) });
  console.error(err);
} finally {
  const serverErrors = stack?.errors() ?? [];
  writeFileSync(join(OUT, 'server.log'), (stack?.logs ?? []).map((l) => `${new Date(l.at).toISOString()} ${l.stream} ${l.line}`).join('\n'));
  const fakeStats = stack?.fakes.stats();
  writeFileSync(join(OUT, 'results.json'), JSON.stringify({ results, serverErrors, unhandled: fakeStats?.unhandled, sink: fakeStats?.sink }, null, 2));
  await stack?.stop();

  const count = (s) => results.filter((r) => r.status === s).length;
  console.log(`\n${count('pass')} passed, ${count('skip')} skipped, ${count('fail')} failed. Details: ${join(OUT, 'results.json')}`);
  if (fakeStats?.unhandled?.length) {
    console.log('\nCalls the fakes do not implement (a provider route the server uses that the fakes should learn):');
    for (const u of fakeStats.unhandled) console.log(`  ${u.service} ${u.method} ${u.path}: ${u.why}`);
  }
  if (fakeStats?.sink?.length) {
    console.log('\nOutside hosts the server called (answered by the sink, never the real thing):');
    for (const host of new Set(fakeStats.sink.map((s) => `${s.host} ${s.method} ${s.path.split('?')[0]}`))) console.log(`  ${host}`);
  }
  if (serverErrors.length && (verbose || count('fail'))) {
    console.log('\nServer errors during the run:');
    for (const line of serverErrors.slice(-30)) console.log(`  ${line}`);
  }
  process.exit(count('fail') ? 1 : 0);
}
