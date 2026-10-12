// Finds Playwright: a local install if there is one, otherwise the global one
// that Claude Code cloud containers ship with (Chromium at PLAYWRIGHT_BROWSERS_PATH).
export async function launch() {
  let pw;
  for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs']) {
    try {
      pw = await import(spec);
      break;
    } catch {
      /* try the next one */
    }
  }
  if (!pw) throw new Error('Playwright not found. Install it with `npm i -D playwright` (then `npx playwright install chromium` outside the cloud).');
  const chromium = pw.chromium ?? pw.default.chromium;
  // SwiftShader: software WebGL, so it works in headless containers without a GPU (slowly).
  return chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
}

/** Waits until the game has loaded (timeline exists, loader gone). */
export async function waitForGame(page, timeout = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    await page.waitForTimeout(2000);
    const ok = await page
      .evaluate(() => !!document.querySelector('input[type=range]') && !document.body.innerText.includes('Laying out'))
      .catch(() => false);
    if (ok) return Date.now() - t0;
  }
  throw new Error('game did not finish loading');
}

/** Moves the timeline to `day` ('end' or a number). */
export async function scrubTo(page, day) {
  await page.evaluate((d) => {
    const r = document.querySelector('input[type=range]');
    r.value = d === 'end' ? r.max : String(d);
    r.dispatchEvent(new Event('input'));
  }, day);
}
