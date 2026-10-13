// Screenshot the game or the showcase.
//
//   node tools/shot.mjs "<url>" out.png [--day=end|N] [--after=ms] [--size=1440x900] [--hide-ui] [--wait=ms]
//
// Examples (with `npm run dev` or `npx vite preview` running):
//   node tools/shot.mjs "http://localhost:5173/?demo&fresh&time=13:00&quality=high" day.png --day=end --after=12000
//   node tools/shot.mjs "http://localhost:5173/?demo&fresh&time=22:00&view=-11.5,-9.2,0.46" night.png --day=end --hide-ui
//   node tools/shot.mjs "http://localhost:5173/showcase.html?set=homes&zoom=4&time=13" homes.png --wait=8000
//
// Showcase pages have no timeline, so pass --wait instead of --day.
// Software rendering is slow: expect 30–120 s per shot.
import { launch, scrubTo, waitForGame } from './playwright.mjs';

const [url, out, ...rest] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node tools/shot.mjs "<url>" out.png [--day=end|N] [--after=ms] [--size=WxH] [--hide-ui] [--wait=ms]');
  process.exit(1);
}
const opt = Object.fromEntries(rest.map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const [w, h] = String(opt.size ?? '1440x900').split('x').map(Number);

const browser = await launch();
const page = await browser.newPage({ viewport: { width: w, height: h } });
page.setDefaultTimeout(240000);
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('useProgram')) errors.push(`[console] ${m.text().slice(0, 300)}`);
});
// &debug exposes window.__stage in builds, so scrubTo can wait for the city to finish building.
const target = new URL(url);
if (!target.pathname.includes('showcase')) target.searchParams.set('debug', '');
await page.goto(target.toString(), { timeout: 180000, waitUntil: 'domcontentloaded' });
if (opt.wait) await page.waitForTimeout(+opt.wait);
else console.log('ready after', await waitForGame(page), 'ms');
if (opt.day) {
  await scrubTo(page, opt.day);
  await page.waitForTimeout(+(opt.after ?? 10000));
}
if (opt['hide-ui']) await page.addStyleTag({ content: 'body > *:not(#world) { display: none !important; }' });
await page.screenshot({ path: out, timeout: 240000 });
if (errors.length) console.log(errors.slice(0, 20).join('\n'));
console.log('saved', out);
await browser.close();
