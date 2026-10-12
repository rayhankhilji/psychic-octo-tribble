// Draw calls and triangles for the end-state city (window.__stage: dev server, or any build with &debug).
//
//   node tools/perf.mjs "http://localhost:5173/?demo&fresh&time=13:00&quality=high" [--top=30]
//   node tools/perf.mjs "http://localhost:5220/?demo&fresh&time=13:00&quality=high&debug"   (frozen preview)
//
// Prints totals for one render (shadow pass included), then the objects that
// cost the most draw calls, so a perf pass can go after the biggest wins.
import { launch, scrubTo, waitForGame } from './playwright.mjs';

const [url, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(url, { timeout: 180000, waitUntil: 'domcontentloaded' });
await waitForGame(page);
await scrubTo(page, 'end');
await page.waitForTimeout(10000);
const info = await page.evaluate((top) => {
  const s = window.__stage;
  if (!s) return { error: 'window.__stage missing: use the dev server, or add &debug to the URL' };
  const scene = s.city.scene;
  // Name an object by what the game calls it: its tooltip, its name, or its type.
  const label = (o) => o.userData?.tip?.title ?? (o.name || o.type);
  // Attribute each draw to the scene's direct child, and to that child's child for big containers.
  // Unnamed containers fall back to their position in the tree, so they can still be found.
  const owner = (o) => {
    const chain = [];
    for (let p = o; p && p !== scene; p = p.parent) chain.unshift(p);
    const named = chain.find((p) => p.userData?.tip?.title || p.name);
    if (named) return label(named);
    return chain.slice(0, 3).map((p) => `${p.type}[${p.parent.children.indexOf(p)}]`).join(' › ');
  };
  const r = s.renderer;
  const calls = new Map();
  const orig = r.renderBufferDirect.bind(r);
  r.renderBufferDirect = (camera, sc, geometry, material, object, group) => {
    const pass = camera === s.camera ? 'main' : 'shadow';
    const key = owner(object);
    const c = calls.get(key) ?? { main: 0, shadow: 0, tris: 0 };
    c[pass]++;
    if (pass === 'main') {
      const n = geometry.index ? geometry.index.count : geometry.attributes.position?.count ?? 0;
      const inst = object.isInstancedMesh ? object.count : 1;
      c.tris += object.isBatchedMesh ? 0 : Math.round((n / 3) * inst);
    }
    calls.set(key, c);
    return orig(camera, sc, geometry, material, object, group);
  };
  r.info.autoReset = false;
  r.info.reset();
  const t0 = performance.now();
  r.render(scene, s.camera);
  const ms = performance.now() - t0;
  r.renderBufferDirect = orig;
  const i = r.info.render;
  const out = {
    drawCalls: i.calls,
    triangles: i.triangles,
    programs: r.info.programs.length,
    geometries: r.info.memory.geometries,
    renderMsSwiftShader: Math.round(ms),
    sceneChildren: scene.children.length,
    top: [...calls].sort((a, b) => b[1].main + b[1].shadow - (a[1].main + a[1].shadow)).slice(0, top).map(([k, c]) => `${String(c.main + c.shadow).padStart(4)}  (${c.main} main, ${c.shadow} shadow, ~${c.tris} tris)  ${k}`),
  };
  r.info.autoReset = true;
  return out;
}, Number(opt.top ?? 30));
const { top, ...totals } = info;
console.log(JSON.stringify(totals, null, 2));
if (top) console.log('\nMost draw calls:\n' + top.join('\n'));
await browser.close();
