/**
 * The TinyTown mark: a little isometric city block on a sand tile, sides
 * washed in Bay blue, a Golden Gate–orange tower and a sun behind it.
 * Geometry is computed once, so the same paths draw the SVG in the HUD,
 * the favicon (see `scripts`-free generation in `faviconSvg`) and the
 * share card (via Path2D).
 */

export interface MarkPart {
  d: string;
  fill: string;
  /** Group used by the loading animation: 0 tile, 1 back tower, 2 front block, 3 sun. */
  layer: number;
}

const COS = Math.cos(Math.PI / 6);
const SIN = 0.5;

/** Brand colours, mirrored in the CSS tokens. */
export const BRAND = {
  ink: '#1b2236',
  sand: '#f5ecdb',
  sandDeep: '#e9d9bb',
  bay: '#2c6fb7',
  bayDeep: '#1d4f8a',
  gate: '#e5512b',
  gateDeep: '#b83c1c',
  gateLight: '#ff8a5c',
  sun: '#f6b53d',
  cream: '#fffaf0',
  creamMid: '#f0e2c6',
  creamDeep: '#d5bd93',
} as const;

function iso(cx: number, cy: number, k: number) {
  return (x: number, y: number, z: number): [number, number] => [cx + (x - z) * k * COS, cy + (x + z) * k * SIN - y * k];
}

const f = (n: number) => Math.round(n * 100) / 100;

function poly(pts: [number, number][]): string {
  return `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join('L')}Z`;
}

/** Top, left (+z) and right (+x) faces of a box, far to near. */
function box(p: ReturnType<typeof iso>, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, top: string, left: string, right: string, layer: number): MarkPart[] {
  return [
    { layer, fill: left, d: poly([p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)]) },
    { layer, fill: right, d: poly([p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1)]) },
    { layer, fill: top, d: poly([p(x0, y1, z0), p(x1, y1, z0), p(x1, y1, z1), p(x0, y1, z1)]) },
  ];
}

function circle(cx: number, cy: number, r: number): string {
  return `M${f(cx - r)} ${f(cy)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`;
}

let cached: MarkPart[] | null = null;

/** The mark in a 48×48 box. */
export function markParts(): MarkPart[] {
  if (cached) return cached;
  const p = iso(24, 30.2, 11.6);
  const B = BRAND;
  const parts: MarkPart[] = [];
  // Sun, peeking over the skyline.
  parts.push({ layer: 3, fill: B.sun, d: circle(38.4, 12.2, 4.7) });
  // The tile: sand on top, the bay on its sides.
  parts.push(...box(p, -1, 1, -1, 1, -0.32, 0, B.sand, B.bay, B.bayDeep, 0));
  // Tall tower at the back, International Orange.
  parts.push(...box(p, -0.78, -0.08, -0.78, -0.08, 0, 1.62, B.gateLight, B.gate, B.gateDeep, 1));
  // Window bands on the tower.
  for (const y of [0.5, 0.86, 1.22]) {
    parts.push({ layer: 1, fill: 'rgba(255,250,240,0.55)', d: poly([p(-0.78, y, -0.08), p(-0.08, y, -0.08), p(-0.08, y + 0.1, -0.08), p(-0.78, y + 0.1, -0.08)]) });
    parts.push({ layer: 1, fill: 'rgba(255,250,240,0.32)', d: poly([p(-0.08, y, -0.78), p(-0.08, y + 0.1, -0.78), p(-0.08, y + 0.1, -0.08), p(-0.08, y, -0.08)]) });
  }
  // A cream block in front, with a little roof garden.
  parts.push(...box(p, 0.12, 0.8, -0.78, -0.08, 0, 0.86, B.cream, B.creamMid, B.creamDeep, 2));
  parts.push(...box(p, -0.78, -0.08, 0.14, 0.8, 0, 0.52, B.cream, B.creamMid, B.creamDeep, 2));
  parts.push({ layer: 2, fill: B.bay, d: poly([p(-0.62, 0.52, 0.3), p(-0.24, 0.52, 0.3), p(-0.24, 0.52, 0.64), p(-0.62, 0.52, 0.64)]) });
  // A palm-green lawn corner.
  parts.push({ layer: 2, fill: '#5fae5a', d: poly([p(0.14, 0.001, 0.12), p(0.86, 0.001, 0.12), p(0.86, 0.001, 0.86), p(0.14, 0.001, 0.86)]) });
  const [tx, ty] = p(0.5, 0, 0.5);
  parts.push({ layer: 2, fill: '#3f8a49', d: circle(tx, ty - 3.2, 2.6) });
  cached = parts;
  return parts;
}

/** Inline SVG of the mark. */
export function markSvg(opts: { size?: number; cls?: string; bg?: boolean; title?: string } = {}): string {
  const { size, cls = 'brand-mark', bg = false, title } = opts;
  const dims = size ? ` width="${size}" height="${size}"` : '';
  const parts = markParts()
    .map((m) => `<path class="mk mk-${m.layer}" d="${m.d}" fill="${m.fill}"/>`)
    .join('');
  const back = bg ? `<rect width="48" height="48" rx="11" fill="${BRAND.ink}"/><g transform="translate(4.8 5.6) scale(0.8)">` : '';
  const close = bg ? '</g>' : '';
  const label = title ? `<title>${title}</title>` : '';
  return `<svg class="${cls}" viewBox="0 0 48 48"${dims} role="img" aria-label="${title ?? 'TinyTown'}" xmlns="http://www.w3.org/2000/svg">${label}${back}${parts}${close}</svg>`;
}

/** Draws the mark on a 2D canvas, top-left at (x, y), `size` px square. */
export function drawMark(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 48, size / 48);
  for (const m of markParts()) {
    ctx.fillStyle = m.fill;
    ctx.fill(new Path2D(m.d));
  }
  ctx.restore();
}

/** Standalone favicon (ink tile behind the mark). */
export function faviconSvg(): string {
  return markSvg({ bg: true, cls: 'favicon', title: 'TinyTown' });
}
