// Regenerates the TinyTown brand kit in public/brand/: the logo lockups (SVG and PNG), the
// avatars, and the social images rendered from the real game. See docs/BRAND.md.
//
//   node tools/brand-assets.mjs logos                      # SVG + PNG lockups, avatars (about 20 s)
//   node tools/brand-assets.mjs social --base=<url>        # city renders + social images (slow)
//   node tools/brand-assets.mjs social --base=<url> --only=x-header,ph-1-day
//   node tools/brand-assets.mjs all --base=<url>
//   node tools/brand-assets.mjs wordmark --font=<BricolageGrotesque[opsz,wdth,wght].ttf>
//
// `--base` is a running copy of the game: `npm run dev` (http://localhost:5173), or better a
// frozen build, so a hot reload can't land mid-shot:
//   npx vite build --outDir /tmp/tt-dist && npx vite preview --outDir /tmp/tt-dist --port 5220
// Software WebGL takes one to four minutes per render, so `social` takes a while. Renders are
// cached in `--cache` (default: your temp folder) and reused with `--reuse`, which makes it
// quick to iterate on the type over them (tools/brand/social/*.html).
//
// The mark comes straight from src/ui/brand.ts (Node 22.18+ imports TypeScript directly), so the
// kit always matches the app. The wordmark is stored as outlines in tools/brand/wordmark.json,
// so no SVG in the kit depends on a web font; `wordmark` rebuilds that file from the variable
// font. It needs fontkit, which the repo doesn't depend on: `npm i --no-save fontkit` first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch, scrubTo, waitForGame } from './playwright.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public/brand');
const TPL = path.join(ROOT, 'tools/brand');
const WORDMARK = path.join(TPL, 'wordmark.json');

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('--')) ?? 'logos';
const opt = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));

const { BRAND, markParts } = await import(pathToFileURL(path.join(ROOT, 'src/ui/brand.ts')).href);

// ── The wordmark ────────────────────────────────────────────────────────────
// Bricolage Grotesque ExtraBold at 88% width, the 44 pt optical size and −0.03 em tracking:
// the boot screen's wordmark, tracked a hair looser so it holds up small.
const WORD_SPEC = { text: 'TinyTown', wght: 800, wdth: 88, opsz: 44, tracking: -0.03 };

async function buildWordmark() {
  if (!opt.font) throw new Error('usage: node tools/brand-assets.mjs wordmark --font=<variable Bricolage Grotesque .ttf>');
  let fontkit;
  try {
    fontkit = await import(opt.fontkit ? pathToFileURL(path.resolve(opt.fontkit, 'dist/module.mjs')).href : 'fontkit');
  } catch {
    throw new Error('fontkit is needed for this step only: `npm i --no-save fontkit` (or pass --fontkit=<path to its folder>).');
  }
  const font = fontkit.openSync(path.resolve(opt.font));
  // fontkit can't make variations of a WOFF2; use the TTF from Google Fonts' download.
  const v = font.getVariation({ wght: WORD_SPEC.wght, wdth: WORD_SPEC.wdth, opsz: WORD_SPEC.opsz });
  const run = v.layout(WORD_SPEC.text);
  const glyphs = [];
  let x = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  run.glyphs.forEach((g, i) => {
    const pos = run.positions[i];
    const p = g.path.scale(1, -1).translate(x + pos.xOffset, -pos.yOffset);
    const bb = p.bbox;
    x0 = Math.min(x0, bb.minX); y0 = Math.min(y0, bb.minY); x1 = Math.max(x1, bb.maxX); y1 = Math.max(y1, bb.maxY);
    glyphs.push({ char: WORD_SPEC.text[i], d: p.toSVG().replace(/(\d+\.\d{2})\d+/g, '$1') });
    x += pos.xAdvance + (i < run.glyphs.length - 1 ? WORD_SPEC.tracking * font.unitsPerEm : 0);
  });
  const data = {
    note: 'TinyTown wordmark as outlines, in font units (y down, baseline at 0). Regenerate with `node tools/brand-assets.mjs wordmark`.',
    spec: { family: 'Bricolage Grotesque', ...WORD_SPEC },
    unitsPerEm: font.unitsPerEm,
    capHeight: v.capHeight,
    xHeight: v.xHeight,
    advance: Math.round(x * 100) / 100,
    bbox: [x0, y0, x1, y1].map((n) => Math.round(n * 100) / 100),
    glyphs,
  };
  fs.writeFileSync(WORDMARK, JSON.stringify(data, null, 2) + '\n');
  console.log('wrote', path.relative(ROOT, WORDMARK));
}

// ── Lockups ─────────────────────────────────────────────────────────────────
// Everything is laid out in the mark's own units: the mark is a 48 × 48 box.
const INK = BRAND.ink;
const CREAM = '#f6eedf'; // the night theme's ink: text on dark
const f2 = (n) => Math.round(n * 100) / 100;

/** The mark's paths, optionally recoloured. */
function markPaths(fill) {
  return markParts().map((m) => `<path d="${m.d}" fill="${fill ?? m.fill}"/>`).join('');
}

/** The mark's ink bounds (it doesn't quite fill its 48 box). */
function markBounds() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const m of markParts()) {
    // Polygons are absolute M/L; the sun is a circle drawn with arcs: take its centre ± r.
    const circle = m.d.match(/^M([\d.-]+) ([\d.-]+)a([\d.]+)/);
    const pts = circle ? [[+circle[1], +circle[2] - +circle[3]], [+circle[1] + 2 * +circle[3], +circle[2] + +circle[3]]] : [...m.d.matchAll(/([\d.-]+) ([\d.-]+)/g)].map((p) => [+p[1], +p[2]]);
    for (const [x, y] of pts) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  return { x0, y0, x1, y1 };
}

function wordmark() {
  if (!fs.existsSync(WORDMARK)) throw new Error('tools/brand/wordmark.json is missing: run `node tools/brand-assets.mjs wordmark --font=…` first.');
  return JSON.parse(fs.readFileSync(WORDMARK, 'utf8'));
}

/** The wordmark as one path, `size` units per em, baseline-left at (x, y). */
function wordPath(w, x, y, size, fill) {
  const k = size / w.unitsPerEm;
  return `<path transform="translate(${f2(x)} ${f2(y)}) scale(${k})" fill="${fill}" d="${w.glyphs.map((g) => g.d).join('')}"/>`;
}

function svgDoc(vb, body, title) {
  const [, , w, h] = vb;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.map(f2).join(' ')}" width="${f2(w * 4)}" height="${f2(h * 4)}" role="img" aria-label="${title}"><title>${title}</title>${body}</svg>\n`;
}

/**
 * Horizontal: mark, then the word. The word is set at 34 units (cap height 47% of the mark's
 * drawn height) with its cap band centred a little below the mark's middle, where the tile's
 * weight sits. Stacked: the word under the mark at 25 units, like the boot screen.
 */
const LOCKUP = { hSize: 34, hGap: 9, hCapMid: 26.6, sSize: 23.5, sGap: 7 };

function horizontal(text) {
  const w = wordmark();
  const mb = markBounds();
  const k = LOCKUP.hSize / w.unitsPerEm;
  const cap = w.capHeight * k;
  const baseline = LOCKUP.hCapMid + cap / 2;
  const wx = mb.x1 + LOCKUP.hGap - w.bbox[0] * k;
  const top = Math.min(mb.y0, baseline + w.bbox[1] * k);
  const bottom = Math.max(mb.y1, baseline + w.bbox[3] * k);
  const right = wx + w.bbox[2] * k;
  const pad = 0.6;
  const vb = [mb.x0 - pad, top - pad, right - mb.x0 + 2 * pad, bottom - top + 2 * pad];
  return svgDoc(vb, `${markPaths()}${wordPath(w, wx, baseline, LOCKUP.hSize, text)}`, 'TinyTown');
}

function stacked(text) {
  const w = wordmark();
  const mb = markBounds();
  const k = LOCKUP.sSize / w.unitsPerEm;
  const ww = (w.bbox[2] - w.bbox[0]) * k;
  // Centre the word under the mark's tile (24 is the tile's centre line), not under the sun.
  const wx = 24 - ww / 2 - w.bbox[0] * k;
  const baseline = mb.y1 + LOCKUP.sGap + w.capHeight * k;
  const left = Math.min(mb.x0, wx + w.bbox[0] * k);
  const right = Math.max(mb.x1, wx + w.bbox[2] * k);
  const bottom = baseline + w.bbox[3] * k;
  const pad = 0.6;
  const vb = [left - pad, mb.y0 - pad, right - left + 2 * pad, bottom - mb.y0 + 2 * pad];
  return svgDoc(vb, `${markPaths()}${wordPath(w, wx, baseline, LOCKUP.sSize, text)}`, 'TinyTown');
}

/** The mark alone, in its 48 box (the same box as /mark.svg and the favicon). */
function markOnly() {
  return svgDoc([0, 0, 48, 48], markPaths(), 'TinyTown');
}

/** The mark on a rounded tile, for app icons and listings. */
function markTile(bg) {
  return svgDoc([0, 0, 48, 48], `<rect width="48" height="48" rx="11" fill="${bg}"/><g transform="translate(4.8 5.2) scale(0.8)">${markPaths()}</g>`, 'TinyTown');
}

/**
 * One colour, for stamps, embossing, single-colour print and watermarks. Every face is solid,
 * separated from the faces behind it by a hairline gap (a mask), so the block still reads as 3D;
 * the tower's windows and the roof garden are cut out.
 */
function markMono(fill) {
  const gap = 1.15;
  const cut = new Set(['rgba(255,250,240,0.55)', 'rgba(255,250,240,0.32)']);
  const parts = markParts();
  // The roof garden is the bay-coloured part drawn after the cream blocks.
  const garden = parts.findIndex((p, i) => p.fill === BRAND.bay && i > parts.findIndex((q) => q.fill === BRAND.cream));
  const mask = parts
    .map((m, i) => {
      if (cut.has(m.fill) || i === garden) return `<path d="${m.d}" fill="#000"/>`;
      return `<path d="${m.d}" fill="#fff" stroke="#000" stroke-width="${gap}" stroke-linejoin="round" paint-order="stroke"/>`;
    })
    .join('');
  return svgDoc([0, 0, 48, 48], `<defs><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="48" height="48"><rect width="48" height="48" fill="#000"/>${mask}</mask></defs><rect width="48" height="48" fill="${fill}" mask="url(#m)"/>`, 'TinyTown');
}

function writeLogos() {
  const dir = path.join(OUT, 'logo');
  fs.mkdirSync(dir, { recursive: true });
  const files = {
    'mark.svg': markOnly(),
    'mark-tile-sand.svg': markTile(BRAND.sand),
    'mark-tile-ink.svg': markTile(INK),
    'mark-mono-ink.svg': markMono(INK),
    'mark-mono-cream.svg': markMono(CREAM),
    'logo-horizontal-light.svg': horizontal(INK),
    'logo-horizontal-dark.svg': horizontal(CREAM),
    'logo-stacked-light.svg': stacked(INK),
    'logo-stacked-dark.svg': stacked(CREAM),
  };
  for (const [name, svg] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), svg);
  console.log('wrote', Object.keys(files).length, 'SVGs to', path.relative(ROOT, dir));
  return files;
}

/** PNGs of the lockups (transparent), the mark, and the avatars. */
async function writeLogoPngs(browser) {
  const dir = path.join(OUT, 'logo');
  const page = await browser.newPage();
  const png = async (svgFile, out, width) => {
    const svg = fs.readFileSync(path.join(dir, svgFile), 'utf8');
    const [, , vw, vh] = svg.match(/viewBox="([^"]+)"/)[1].split(' ').map(Number);
    const height = Math.round((width * vh) / vw);
    await page.setViewportSize({ width, height });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${width}px;height:${height}px}</style>${svg}`);
    await page.screenshot({ path: path.join(dir, out), omitBackground: true });
  };
  for (const v of ['light', 'dark']) {
    await png(`logo-horizontal-${v}.svg`, `logo-horizontal-${v}.png`, 1024);
    await png(`logo-stacked-${v}.svg`, `logo-stacked-${v}.png`, 1024);
  }
  await png('mark.svg', 'mark-512.png', 512);
  await png('mark.svg', 'mark-1024.png', 1024);
  await png('mark-mono-ink.svg', 'mark-mono-ink-512.png', 512);
  await png('mark-mono-cream.svg', 'mark-mono-cream-512.png', 512);
  await png('mark-tile-sand.svg', 'mark-tile-sand-512.png', 512);
  await png('mark-tile-ink.svg', 'mark-tile-ink-512.png', 512);

  // Avatars: the mark on the boot screen's sunlit sand, and on the night sky. Square, with the
  // mark well inside the circle that X, LinkedIn and Product Hunt crop to.
  const marks = markPaths();
  const avatar = async (out, bg, glow) => {
    await page.setViewportSize({ width: 400, height: 400 });
    await page.setContent(`<style>html,body{margin:0}div{width:400px;height:400px;display:grid;place-items:center;background:${bg}}svg{width:236px;height:236px;margin-top:6px;filter:drop-shadow(0 16px 18px ${glow})}</style><div><svg viewBox="0 0 48 48">${marks}</svg></div>`);
    await page.screenshot({ path: path.join(dir, out) });
  };
  await avatar('avatar-day.png', 'radial-gradient(120% 90% at 50% 0%, #fbf5ea 0%, #f5ecdb 55%, #ecdfc6 100%)', 'rgba(27,34,54,0.16)');
  await avatar('avatar-night.png', 'radial-gradient(120% 90% at 50% 0%, #262e47 0%, #1b2236 50%, #0f1424 100%)', 'rgba(0,0,0,0.4)');
  await page.close();
  console.log('wrote logo PNGs and avatars');
}

// ── Social images ───────────────────────────────────────────────────────────
// Each image is an HTML template in tools/brand/social/ laid over one render of the grown demo
// city (Nightjar, a made-up startup, on its last day). `scale` renders the city larger than
// the image and lets the browser downsample it, for crisp edges.
const DAY = 'time=13:00';
const GOLD = 'time=18:30';
const NIGHT = 'time=22:00';
const SOCIAL = [
  { name: 'x-header', size: [1500, 500], renders: { city: { q: GOLD, view: '-7.70,4.47,1.1' } } },
  { name: 'linkedin-banner', size: [1584, 396], renders: { city: { q: DAY, view: '6.38,-12.22,1.1' } } },
  { name: 'ph-1-day', size: [1270, 760], renders: { city: { q: DAY, view: '-8.98,3.43,0.8' } } },
  { name: 'ph-2-golden', size: [1270, 760], renders: { city: { q: GOLD, view: '-39.80,17.88,0.95' } } },
  { name: 'ph-3-night', size: [1270, 760], renders: { city: { q: NIGHT, view: '-0.46,-1.67,1' } } },
  { name: 'ph-4-hills', size: [1270, 760], renders: { city: { q: GOLD, view: '-15.27,-24.94,1.15' } } },
  // The square post sets the city under the words: its render is the lower 750 px.
  { name: 'square-launch', size: [1080, 1080], renders: { city: { q: GOLD, view: '-3.01,4.13,0.7', size: [1080, 750] } } },
];

async function renderCity(browser, base, { q, view }, [w, h], file) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.setDefaultTimeout(300000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // &debug exposes window.__stage in builds, so scrubTo can wait for the city to finish building.
  await page.goto(`${base}/?demo&fresh&debug&quality=high&${q}&view=${view}`, { timeout: 180000, waitUntil: 'domcontentloaded' });
  await waitForGame(page);
  await scrubTo(page, 'end');
  // Let traffic, boats and the sun settle into place, then read the numbers behind the picture.
  await page.waitForTimeout(+(opt.settle ?? 9000));
  const facts = await page.evaluate(() => {
    const t = (s) => document.querySelector(s)?.textContent?.trim() ?? '';
    const day = Number(document.querySelector('input[type=range]')?.value ?? NaN) + 1;
    return { mrr: t('[data-key="mrr"] .metric-value'), customers: t('[data-key="customers"] .metric-value'), day: Number.isFinite(day) ? day.toLocaleString('en-US') : '' };
  });
  await page.addStyleTag({ content: 'body > *:not(#world) { display: none !important; }' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: file });
  await page.close();
  if (errors.length) console.log('  page errors:', errors.slice(0, 3).join(' | '));
  return facts;
}

/** Saves a composed image: JPEG through ImageMagick if it's installed (smaller, 4:4:4 so the orange type stays sharp), PNG otherwise. */
function finish(pngFile, outBase) {
  // ImageMagick 7 is `magick`; 6 (most Linux distros) is `convert`.
  for (const bin of ['magick', 'convert']) {
    try {
      execFileSync(bin, [pngFile, '-strip', '-quality', '90', '-sampling-factor', '4:4:4', '-interlace', 'JPEG', `${outBase}.jpg`], { stdio: 'ignore' });
      return `${outBase}.jpg`;
    } catch {
      /* try the next one */
    }
  }
  fs.copyFileSync(pngFile, `${outBase}.png`);
  return `${outBase}.png`;
}

async function writeSocial(browser) {
  const base = String(opt.base ?? 'http://localhost:5173').replace(/\/$/, '');
  const cache = path.resolve(String(opt.cache ?? path.join(os.tmpdir(), 'tinytown-brand')));
  const scale = +(opt.scale ?? 1.5);
  const only = opt.only ? String(opt.only).split(',') : null;
  fs.mkdirSync(cache, { recursive: true });
  const dir = path.join(OUT, 'social');
  fs.mkdirSync(dir, { recursive: true });
  // The templates link the kit's own SVG lockups, so the wordmark is the outlined one.
  for (const f of fs.readdirSync(path.join(OUT, 'logo'))) if (f.endsWith('.svg')) fs.copyFileSync(path.join(OUT, 'logo', f), path.join(cache, f));
  const factsFile = path.join(cache, 'facts.json');
  const allFacts = fs.existsSync(factsFile) ? JSON.parse(fs.readFileSync(factsFile, 'utf8')) : {};
  for (const item of SOCIAL) {
    if (only && !only.includes(item.name)) continue;
    const [w, h] = item.size;
    for (const [key, r] of Object.entries(item.renders)) {
      const file = path.join(cache, `${item.name}-${key}.png`);
      if (opt.reuse && fs.existsSync(file)) continue;
      const t0 = Date.now();
      const [rw, rh] = r.size ?? item.size;
      allFacts[item.name] = await renderCity(browser, base, r, [Math.round(rw * scale), Math.round(rh * scale)], file);
      console.log(`  rendered ${item.name}/${key} in ${Math.round((Date.now() - t0) / 1000)} s`);
    }
    fs.writeFileSync(factsFile, JSON.stringify(allFacts, null, 2));
    const facts = allFacts[item.name] ?? {};
    let html = fs.readFileSync(path.join(TPL, 'social', `${item.name}.html`), 'utf8');
    html = html.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in item.renders ? `${item.name}-${k}.png` : (facts[k] ?? '')));
    fs.writeFileSync(path.join(cache, `${item.name}.html`), html.replace('<head>', `<head><style>${fs.readFileSync(path.join(TPL, 'social', 'common.css'), 'utf8')}</style>`));
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.goto(pathToFileURL(path.join(cache, `${item.name}.html`)).href, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    const png = path.join(cache, `${item.name}-final.png`);
    await page.screenshot({ path: png });
    await page.close();
    for (const ext of ['.jpg', '.png']) fs.rmSync(path.join(dir, item.name + ext), { force: true });
    console.log('wrote', path.relative(ROOT, finish(png, path.join(dir, item.name))));
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
if (cmd === 'wordmark') {
  await buildWordmark();
} else {
  const browser = await launch();
  try {
    if (cmd === 'logos' || cmd === 'all') {
      writeLogos();
      await writeLogoPngs(browser);
    }
    if (cmd === 'social' || cmd === 'all') await writeSocial(browser);
  } finally {
    await browser.close();
  }
}
