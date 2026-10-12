// Draw calls and triangles for the end-state city (dev builds expose window.__stage).
//
//   node tools/perf.mjs "http://localhost:5173/?demo&fresh&time=13:00&quality=high"
import { launch, scrubTo, waitForGame } from './playwright.mjs';

const [url] = process.argv.slice(2);
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(url, { timeout: 180000, waitUntil: 'domcontentloaded' });
await waitForGame(page);
await scrubTo(page, 'end');
await page.waitForTimeout(10000);
const info = await page.evaluate(() => {
  const s = window.__stage;
  if (!s) return { error: 'window.__stage missing: run against the dev server (import.meta.env.DEV)' };
  s.renderer.info.autoReset = false;
  s.renderer.info.reset();
  const t0 = performance.now();
  s.renderer.render(s.city.scene, s.camera);
  const ms = performance.now() - t0;
  const r = s.renderer.info.render;
  const out = { drawCalls: r.calls, triangles: r.triangles, programs: s.renderer.info.programs.length, geometries: s.renderer.info.memory.geometries, renderMsSwiftShader: Math.round(ms) };
  s.renderer.info.autoReset = true;
  return out;
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
