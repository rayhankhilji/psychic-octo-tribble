// Renders the hosted images TinyTown's emails use, into public/email/.
// Email clients don't draw SVG or load our fonts, so the brand goes out as PNG.
//
//   node tools/email-assets.mjs                      # the two mastheads
//   node tools/email-assets.mjs --city=city.png      # and the invite's city picture from a 1200×600 screenshot
//
// The city picture is a screenshot of the demo, for example:
//   node tools/shot.mjs "http://localhost:5173/?demo&fresh&time=18:30&quality=high&view=-11.5,-9.2,0.46" city.png --day=end --hide-ui --size=1200x600
//
// Each masthead is opaque (cream by day, ink by night) with its top corners
// cut to the card's radius. Opaque matters: Gmail and Outlook invert a dark
// mode email's colours but never its images, so a dark wordmark on a
// transparent PNG would vanish on their dark canvas. Clients that honour
// `prefers-color-scheme` swap in the night masthead instead.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { launch } from './playwright.mjs';

const root = new URL('../', import.meta.url);
const out = (f) => new URL(`public/email/${f}`, root);
const opt = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));

// Display size of the masthead: the card is 600 wide with a 1px border each side.
const W = 598;
const H = 112;
const RADIUS = 15;
const PAD = 40;

const mark = readFileSync(new URL('public/mark.svg', root), 'utf8').replace('<svg ', '<svg class="mark" ');

// The one-line skyline from the boot screen (index.html), in a 280×64 box with the ground at y=56.
const SKY = {
  bridge: 'M20 44h96M44 56V14M92 56V14M20 50 44 15Q68 42 92 15L116 50M41 14h6M89 14h6',
  city: 'M0 56q10-14 22-8M118 56V40h8V30h8v-6h4v32M142 56V36h6V28h6v28M156 56l8-44 8 44M174 56V32h10v-8h6v32M192 56V40h8v16M202 56q16-26 40-20 22 6 38 20M223 40.5h2.4M228.5 38.6h2.4M234 37.4h2.4M239.5 36.9h2.4M245 37.2h2.4M250.5 38h2.4',
  sun: 'M252 20a7 7 0 1 0 14 0a7 7 0 1 0-14 0',
  // A crescent where the sun was: the outer disc less a disc nudged up and right.
  moon: 'M259 13a7 7 0 1 0 0 14a3 7 0 0 1 0 -14Z',
};

const THEMES = {
  day: { file: 'header@2x.png', bg: '#fffaf0', ink: '#1b2236', city: '#1b2236', bridge: '#e5512b', water: '#2c6fb7', sun: '#f6b53d', night: false },
  night: { file: 'header-night@2x.png', bg: '#161c2f', ink: '#f6eedf', city: '#c8c2b6', bridge: '#ff6a3d', water: '#78b2ef', sun: '#f6cf7d', night: true },
};

function masthead(t) {
  const scale = 0.96;
  const skyW = 280 * scale;
  const x0 = W - PAD - skyW;
  const ground = 92;
  const y0 = ground - 56 * scale;
  const stars = t.night
    ? [
        [x0 - 34, 24, 1.1],
        [x0 + 30, 16, 0.9],
        [x0 + 128, 10, 1.2],
        [x0 + 196, 22, 0.8],
        [W - PAD - 6, 44, 0.9],
        [x0 - 70, 40, 0.8],
      ]
        .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${t.ink}" opacity="0.55"/>`)
        .join('')
    : '';
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,500..800&display=block" rel="stylesheet">
<style>
  html, body { margin: 0; background: transparent; }
  .m { position: relative; width: ${W}px; height: ${H}px; background: ${t.bg}; border-radius: ${RADIUS}px ${RADIUS}px 0 0; overflow: hidden; }
  .lockup { position: absolute; left: ${PAD - 4}px; top: 29px; display: flex; align-items: center; gap: 10px; }
  .mark { width: 46px; height: 46px; display: block; }
  .word { font: 800 31px/1 'Bricolage Grotesque'; font-variation-settings: 'opsz' 48; font-stretch: 88%; letter-spacing: -0.035em; color: ${t.ink}; padding-top: 2px; }
  svg.sky { position: absolute; inset: 0; }
  .sky path { fill: none; stroke-linecap: round; stroke-linejoin: round; }
</style></head><body>
<div class="m">
  <div class="lockup">${mark}<span class="word">TinyTown</span></div>
  <svg class="sky" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${stars}
    <path d="M${x0} ${ground}H${W - PAD}" stroke="${t.city}" stroke-width="1.4"/>
    <path d="M${PAD} ${ground + 4.5}H${W - PAD}" stroke="${t.water}" stroke-width="1.2" opacity="0.6"/>
    <g transform="translate(${x0} ${y0}) scale(${scale})">
      <path d="${SKY.bridge}" stroke="${t.bridge}" stroke-width="1.6"/>
      <path d="${SKY.city}" stroke="${t.city}" stroke-width="1.4"/>
      ${t.night ? `<path d="${SKY.moon}" style="fill:${t.sun};stroke:none"/>` : `<path d="${SKY.sun}" stroke="${t.sun}" stroke-width="1.6"/>`}
    </g>
  </svg>
</div>
</body></html>`;
}

const browser = await launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });

for (const t of Object.values(THEMES)) {
  await page.setContent(masthead(t), { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.locator('.m').screenshot({ path: out(t.file).pathname, omitBackground: true });
  console.log('wrote', t.file, `${(statSync(out(t.file)).size / 1024).toFixed(1)} KB`);
}

// The invite's picture: the screenshot re-encoded as a JPEG that stays well under 150 KB.
if (typeof opt.city === 'string') {
  const png = readFileSync(opt.city).toString('base64');
  await page.setViewportSize({ width: 1200, height: 600 });
  await page.setContent('<canvas></canvas>');
  let q = 0.82;
  let bytes;
  for (;;) {
    const data = await page.evaluate(
      async ({ png, q }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${png}`;
        await img.decode();
        const c = document.querySelector('canvas');
        c.width = 1200;
        c.height = 600;
        c.getContext('2d').drawImage(img, 0, 0, 1200, 600);
        return c.toDataURL('image/jpeg', q).split(',')[1];
      },
      { png, q },
    );
    bytes = Buffer.from(data, 'base64');
    if (bytes.length < 140 * 1024 || q < 0.5) break;
    q -= 0.04;
  }
  writeFileSync(out('city@2x.jpg'), bytes);
  console.log('wrote city@2x.jpg', `${(bytes.length / 1024).toFixed(1)} KB at quality ${q.toFixed(2)}`);
}

await browser.close();
