import * as THREE from 'three';
import { GeoBuilder, GLOW, type ColorLike } from './geo.ts';
import { PALETTE } from './palette.ts';
import { bright, palm, tree, warmth, type Built } from './buildings.ts';
import { pick, rng } from '../world/rng.ts';
import { BLOCK } from '../world/layout.ts';

/**
 * Commercial buildings: towers, campuses, the pyramid, the supertall, and
 * your HQ. Positions are world (x, z) at ground level unless noted.
 *
 * The first half of this file is a small modelling kit shared with
 * `models.ts`: a GeoBuilder with three extra lit layers (tinted windows,
 * neon and an LED screen), batched quads, extruded footprints, lofts,
 * curtain-wall facades and a pixel font for signage.
 */

// ─── Kit: materials ────────────────────────────────────────────────────────

export type Bucket = 'solid' | 'glass' | 'smooth' | 'glow';
export type XZ = readonly [number, number];

/** Daytime glass tints for windows (see `wr`). */
export const TINT = { sky: 0, bronze: 1, teal: 2, silver: 3, blue: 4, smoke: 5, green: 6, shop: 7 } as const;

/** Neon behaviours, encoded in a quad's rand: add a phase in [0, 1). */
export const FX = { steady: 0, chase: 3, blink: 4, shimmer: 6 } as const;

function lit(key: string, decl: string, body: string, params: THREE.MeshBasicMaterialParameters = {}): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ vertexColors: true, ...params });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = GLOW.night;
    shader.uniforms.uTime = GLOW.time;
    shader.uniforms.uDay = GLOW.day;
    shader.vertexShader = shader.vertexShader.replace(
      'void main() {',
      'attribute float winRand;\nvarying float vRand;\nvarying vec3 vP;\nvoid main() {\n\tvRand = winRand;\n\tvP = position;',
    );
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `uniform float uNight;\nuniform float uTime;\nuniform vec3 uDay;\nvarying float vRand;\nvarying vec3 vP;\n${decl}\nvoid main() {`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${body}`);
  };
  m.customProgramCacheKey = () => key;
  return m;
}

/**
 * Windows with a daytime tint: rand = tint × 10 + switch-on time (or 5+ for
 * a window that stays dark). Reflective tinted glass by day, staggered
 * lights at dusk.
 */
export function windowMaterial(): THREE.MeshBasicMaterial {
  return lit(
    'tinytown-win-1',
    `const vec3 TINTS[8] = vec3[8](vec3(0.52, 0.70, 0.86), vec3(0.40, 0.32, 0.25), vec3(0.27, 0.46, 0.52), vec3(0.50, 0.60, 0.70), vec3(0.24, 0.38, 0.60), vec3(0.17, 0.20, 0.25), vec3(0.45, 0.62, 0.60), vec3(0.36, 0.29, 0.22));`,
    `float k = floor(vRand / 10.0);
    float f = vRand - k * 10.0;
    float on = smoothstep(f - 0.04, f + 0.04, uNight * 1.12 - 0.06);
    float cycle = floor(uTime / 23.0 + f * 17.0);
    float flick = step(0.93, fract(sin(cycle * 12.9898 + f * 78.233) * 43758.5453));
    on *= 1.0 - flick * step(0.1, f) * step(f, 1.5);
    vec3 tint = k < 0.5 ? uDay : TINTS[int(clamp(k, 0.0, 7.0))];
    float shade = 0.8 + 0.34 * fract(f * 7.31 + k * 0.37);
    vec3 dayGlass = tint * shade * (0.9 + 0.22 * smoothstep(0.0, 7.0, vP.y));
    diffuseColor.rgb = mix(dayGlass, diffuseColor.rgb * max(on, 0.03), uNight);`,
  );
}

/** Neon, bulbs and lit paint: their own colour by day, glowing at night. */
export function neonMaterial(): THREE.MeshBasicMaterial {
  return lit(
    'tinytown-neon-1',
    '',
    `vec3 vc = vColor.rgb;
    float peak = max(max(vc.r, vc.g), vc.b);
    vec3 dayTone = vc / max(peak, 1.0) * 0.9;
    float ph = fract(vRand);
    float on = 1.0;
    if (vRand > 2.5 && vRand < 4.0) on = 0.2 + 0.8 * step(0.62, fract(uTime * 2.2 + ph));
    else if (vRand >= 4.0 && vRand < 6.0) on = 0.08 + 0.92 * step(0.84, fract(uTime * 0.55 + ph));
    else if (vRand >= 6.0) on = 0.72 + 0.28 * sin(uTime * 2.6 + ph * 40.0);
    diffuseColor.rgb = mix(dayTone, diffuseColor.rgb * on, uNight);`,
  );
}

/** An LED screen (the supertall's crown): pale lattice by day, slow drifting light at night. */
export function screenMaterial(): THREE.MeshBasicMaterial {
  return lit(
    'tinytown-screen-1',
    '',
    `vec2 uv = vec2(vRand * 72.0, vP.y * 30.0);
    vec2 cell = floor(uv);
    vec2 fc = fract(uv) - 0.5;
    float t = uTime;
    float w1 = sin(cell.x * 0.19 - t * 0.55 + sin(cell.y * 0.16 + t * 0.21) * 2.4);
    float w2 = sin(cell.y * 0.29 + t * 0.37 - cell.x * 0.06);
    float w3 = sin((cell.x - cell.y) * 0.11 + t * 0.8);
    float v = smoothstep(0.08, 0.95, 0.5 + 0.32 * w1 + 0.22 * w2 + 0.14 * w3);
    float led = 0.45 + 0.55 * smoothstep(0.5, 0.2, length(fc));
    vec3 col = mix(vec3(0.12, 0.24, 0.75), vec3(1.7, 1.55, 1.3), v) * (0.08 + 0.95 * v) * led;
    diffuseColor.rgb = mix(vColor.rgb, col * diffuse, uNight);`,
    { side: THREE.DoubleSide },
  );
}

// ─── Kit: builder ──────────────────────────────────────────────────────────

/**
 * A GeoBuilder with extra lit layers: `win` (tinted windows), `neon`
 * (signs, bulbs, aviation lights) and `screen` (LED). `build()` merges them
 * into one group; the returned `glow` drives all of them (fade-ins and
 * lights-out share its colour).
 */
export class Kit extends GeoBuilder {
  readonly win = new GeoBuilder();
  readonly neon = new GeoBuilder();
  readonly screen = new GeoBuilder();

  build(material?: THREE.Material): { group: THREE.Group; glow?: THREE.MeshBasicMaterial } {
    for (const g of [this, this.win, this.neon, this.screen]) flush(g);
    const main = super.build(material);
    let glow = main.glow;
    const layers: [GeoBuilder, () => THREE.MeshBasicMaterial][] = [
      [this.win, windowMaterial],
      [this.neon, neonMaterial],
      [this.screen, screenMaterial],
    ];
    for (const [g, make] of layers) {
      const mat = make();
      const part = g.build(mat);
      if (part.glow) {
        if (glow) mat.color = glow.color;
        else glow = mat;
      } else mat.dispose();
      for (const c of [...part.group.children]) main.group.add(c);
    }
    return { group: main.group, glow };
  }
}

/** The window layer of a Kit (or the builder itself). */
export const winOf = (b: GeoBuilder): GeoBuilder => (b instanceof Kit ? b.win : b);
/** The neon layer of a Kit (or the builder itself). */
export const neonOf = (b: GeoBuilder): GeoBuilder => (b instanceof Kit ? b.neon : b);
/** The screen layer of a Kit (or the builder itself). */
export const screenOf = (b: GeoBuilder): GeoBuilder => (b instanceof Kit ? b.screen : b);

/** A window's rand: daytime tint, and when (if ever) it lights up at dusk. */
export function wr(r: () => number, share: number, tint: number = TINT.sky): number {
  return tint * 10 + (r() < share ? 0.12 + 0.86 * r() : 5 + r() * 0.99);
}

// ─── Kit: batched quads ────────────────────────────────────────────────────

interface Batch {
  p: number[];
  n: number[];
  c: number[];
  w: number[];
}
const BATCHES = new WeakMap<GeoBuilder, Map<Bucket, Batch>>();

function batchOf(b: GeoBuilder, bucket: Bucket): Batch {
  let m = BATCHES.get(b);
  if (!m) BATCHES.set(b, (m = new Map()));
  let q = m.get(bucket);
  if (!q) m.set(bucket, (q = { p: [], n: [], c: [], w: [] }));
  return q;
}

/** Moves batched quads into the builder's buckets (Kit.build does this). */
export function flush(b: GeoBuilder) {
  const m = BATCHES.get(b);
  if (!m) return;
  for (const [bucket, q] of m) {
    if (!q.p.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(q.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(q.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(q.c, 3));
    g.setAttribute('winRand', new THREE.Float32BufferAttribute(q.w, 1));
    b.raw(g, bucket);
  }
  BATCHES.delete(b);
}

const tmpC = new THREE.Color();
export function rgb(c: ColorLike): [number, number, number] {
  if (typeof c === 'number') {
    tmpC.setHex(c);
    return [tmpC.r, tmpC.g, tmpC.b];
  }
  return [c[0], c[1], c[2]];
}

/** Scales a colour (hex or linear) into a linear triple. */
export function shade(c: ColorLike, k: number): [number, number, number] {
  const [r, g, b] = rgb(c);
  return [r * k, g * k, b * k];
}

/** A quad centred on (cx, cy, cz) spanning R (width) and U (height); it faces R × U. */
export function quad3(
  b: GeoBuilder, bucket: Bucket,
  cx: number, cy: number, cz: number,
  rx: number, ry: number, rz: number,
  ux: number, uy: number, uz: number,
  w: number, h: number, color: ColorLike, rand = 0, rand2 = rand,
) {
  const q = batchOf(b, bucket);
  let nx = ry * uz - rz * uy;
  let ny = rz * ux - rx * uz;
  let nz = rx * uy - ry * ux;
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl;
  ny /= nl;
  nz /= nl;
  const hw = w / 2;
  const hh = h / 2;
  const corner = (sr: number, su: number) => [cx + rx * hw * sr + ux * hh * su, cy + ry * hw * sr + uy * hh * su, cz + rz * hw * sr + uz * hh * su];
  const bl = corner(-1, -1);
  const br = corner(1, -1);
  const tr = corner(1, 1);
  const tl = corner(-1, 1);
  const [cr, cg, cb] = rgb(color);
  for (const [v, rr] of [[bl, rand], [br, rand2], [tr, rand2], [bl, rand], [tr, rand2], [tl, rand]] as const) {
    q.p.push(v[0]!, v[1]!, v[2]!);
    q.n.push(nx, ny, nz);
    q.c.push(cr, cg, cb);
    q.w.push(rr);
  }
}

type P3 = readonly [number, number, number];

/** A quad through four points in order; turned to face `face` (if given). */
export function quad4(b: GeoBuilder, bucket: Bucket, p: readonly [P3, P3, P3, P3], color: ColorLike, face?: P3, rand = 0) {
  const q = batchOf(b, bucket);
  const [p0, p1, p2, p3] = p;
  const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
  let nx = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
  let ny = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
  let nz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
  let order = [p0, p1, p2, p0, p2, p3];
  if (face && nx * face[0] + ny * face[1] + nz * face[2] < 0) {
    order = [p0, p2, p1, p0, p3, p2];
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  const nl = Math.hypot(nx, ny, nz) || 1;
  const [cr, cg, cb] = rgb(color);
  for (const v of order) {
    q.p.push(v[0], v[1], v[2]);
    q.n.push(nx / nl, ny / nl, nz / nl);
    q.c.push(cr, cg, cb);
    q.w.push(rand);
  }
}

/** A vertical quad facing (nx, nz). */
export function wall(b: GeoBuilder, bucket: Bucket, x: number, y: number, z: number, nx: number, nz: number, w: number, h: number, color: ColorLike, rand = 0) {
  const l = Math.hypot(nx, nz) || 1;
  quad3(b, bucket, x, y, z, nz / l, 0, -nx / l, 0, 1, 0, w, h, color, rand);
}

/** A horizontal quad facing up (or down with `down`). */
export function flat(b: GeoBuilder, bucket: Bucket, x: number, y: number, z: number, w: number, d: number, color: ColorLike, rotY = 0, rand = 0, down = false) {
  const c = Math.cos(rotY);
  const s = Math.sin(rotY);
  if (down) quad3(b, bucket, x, y, z, c, 0, -s, s, 0, c, w, d, color, rand);
  else quad3(b, bucket, x, y, z, c, 0, -s, -s, 0, -c, w, d, color, rand);
}

// ─── Kit: solids ───────────────────────────────────────────────────────────

const m4 = new THREE.Matrix4();
const qt = new THREE.Quaternion();
const eu = new THREE.Euler();
const va = new THREE.Vector3();
const vb = new THREE.Vector3();
const vc = new THREE.Vector3();
const vs = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Places a geometry: position, rotation (yaw, pitch, roll; 'YXZ') and scale. */
export function put(b: GeoBuilder, g: THREE.BufferGeometry, x: number, y: number, z: number, color: ColorLike, bucket: Bucket = 'solid', ry = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  eu.set(rx, ry, rz, 'YXZ');
  qt.setFromEuler(eu);
  m4.compose(va.set(x, y, z), qt, vs.set(sx, sy, sz));
  b.transformed(g, m4.clone(), color, bucket);
}

/** Box with its local Y along (yx, yy, yz) and local Z as close to (zx, zy, zz) as possible. */
export function obox(b: GeoBuilder, cx: number, cy: number, cz: number, yx: number, yy: number, yz: number, zx: number, zy: number, zz: number, w: number, len: number, d: number, color: ColorLike, bucket: Bucket = 'solid') {
  const Y = va.set(yx, yy, yz).normalize();
  const Z = vb.set(zx, zy, zz);
  Z.addScaledVector(Y, -Z.dot(Y));
  if (Z.lengthSq() < 1e-8) Z.set(Math.abs(Y.y) < 0.9 ? 0 : 1, Math.abs(Y.y) < 0.9 ? 1 : 0, 0).addScaledVector(Y, -(Math.abs(Y.y) < 0.9 ? Y.y : Y.x));
  Z.normalize();
  const X = vc.crossVectors(Y, Z).normalize();
  const m = new THREE.Matrix4().makeBasis(X, Y, Z).setPosition(cx, cy, cz);
  b.transformed(new THREE.BoxGeometry(w, len, d), m, color, bucket);
}

/** A square-section beam from a to c. */
export function beam(b: GeoBuilder, ax: number, ay: number, az: number, cx: number, cy: number, cz: number, w: number, color: ColorLike, bucket: Bucket = 'solid', d = w) {
  const dx = cx - ax;
  const dy = cy - ay;
  const dz = cz - az;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return;
  const vertical = Math.hypot(dx, dz) < 1e-6;
  obox(b, (ax + cx) / 2, (ay + cy) / 2, (az + cz) / 2, dx, dy, dz, vertical ? 0 : -dz, 0, vertical ? 1 : dx, w, len, d, color, bucket);
}

/** A round rod from a to c. */
export function rod(b: GeoBuilder, ax: number, ay: number, az: number, cx: number, cy: number, cz: number, r: number, color: ColorLike, segments = 5, bucket: Bucket = 'solid', r2 = r) {
  va.set(cx - ax, cy - ay, cz - az);
  const len = va.length();
  if (len < 1e-6) return;
  qt.setFromUnitVectors(UP, va.normalize());
  const g = new THREE.CylinderGeometry(r2, r, len, segments, 1);
  m4.compose(vb.set((ax + cx) / 2, (ay + cy) / 2, (az + cz) / 2), qt, vs.set(1, 1, 1));
  b.transformed(g, m4.clone(), color, bucket);
}

/** A footprint polygon (world x, z) extruded from y to y + h. */
export function prism(b: GeoBuilder, pts: readonly XZ[], y: number, h: number, color: ColorLike, bucket: Bucket = 'solid') {
  const shape = new THREE.Shape(pts.map(([px, pz]) => new THREE.Vector2(px, -pz)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 1 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  b.transformed(g, new THREE.Matrix4(), color, bucket);
}

/** A side profile (x, y in the local plane) extruded `depth` along local z, then yawed and placed. */
export function profile(b: GeoBuilder, pts: readonly [number, number][], depth: number, x: number, y: number, z: number, rotY: number, color: ColorLike, bucket: Bucket = 'solid') {
  const shape = new THREE.Shape(pts.map(([px, py]) => new THREE.Vector2(px, py)));
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, -depth / 2);
  put(b, g, x, y, z, color, bucket, rotY);
}

function area(pts: readonly XZ[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Side walls through a stack of rings (same vertex count), with caps. */
export function loft(b: GeoBuilder, rings: { pts: readonly XZ[]; y: number }[], color: ColorLike, bucket: Bucket = 'solid', capTop = true, capBottom = false) {
  const n = rings[0]!.pts.length;
  const flip = area(rings[0]!.pts) > 0;
  const pos: number[] = [];
  const idx: number[] = [];
  for (const ring of rings) for (const [px, pz] of ring.pts) pos.push(px, ring.y, pz);
  for (let k = 0; k < rings.length - 1; k++) {
    for (let j = 0; j < n; j++) {
      const a = k * n + j;
      const b2 = k * n + ((j + 1) % n);
      const c = (k + 1) * n + ((j + 1) % n);
      const d = (k + 1) * n + j;
      if (!flip) idx.push(a, b2, c, a, c, d);
      else idx.push(a, c, b2, a, d, c);
    }
  }
  const cap = (ring: { pts: readonly XZ[]; y: number }, up: boolean) => {
    const base = pos.length / 3;
    const contour = ring.pts.map(([px, pz]) => new THREE.Vector2(px, pz));
    for (const [px, pz] of ring.pts) pos.push(px, ring.y, pz);
    for (const f of THREE.ShapeUtils.triangulateShape(contour, [])) {
      const [i0, i1, i2] = f as [number, number, number];
      const p0 = ring.pts[i0]!;
      const p1 = ring.pts[i1]!;
      const p2 = ring.pts[i2]!;
      const ny = (p1[1] - p0[1]) * (p2[0] - p0[0]) - (p1[0] - p0[0]) * (p2[1] - p0[1]);
      if (ny > 0 === up) idx.push(base + i0, base + i1, base + i2);
      else idx.push(base + i0, base + i2, base + i1);
    }
  };
  if (capTop) cap(rings[rings.length - 1]!, true);
  if (capBottom) cap(rings[0]!, false);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  b.transformed(g, new THREE.Matrix4(), color, bucket);
}

// ─── Kit: footprints ───────────────────────────────────────────────────────

export function rectPts(w: number, d: number, x = 0, z = 0): XZ[] {
  return [[x - w / 2, z - d / 2], [x + w / 2, z - d / 2], [x + w / 2, z + d / 2], [x - w / 2, z + d / 2]];
}

/** Rectangle with 45° chamfered corners (8 points; even edges are the main faces). */
export function chamferPts(w: number, d: number, c: number, x = 0, z = 0): XZ[] {
  const a = w / 2;
  const e = d / 2;
  return [
    [x - a + c, z - e], [x + a - c, z - e], [x + a, z - e + c], [x + a, z + e - c],
    [x + a - c, z + e], [x - a + c, z + e], [x - a, z + e - c], [x - a, z - e + c],
  ];
}

/** Rectangle with notched (re-entrant) corners, art deco style (12 points). */
export function notchPts(w: number, d: number, c: number, x = 0, z = 0): XZ[] {
  const a = w / 2;
  const e = d / 2;
  return [
    [x - a + c, z - e], [x + a - c, z - e], [x + a - c, z - e + c], [x + a, z - e + c],
    [x + a, z + e - c], [x + a - c, z + e - c], [x + a - c, z + e], [x - a + c, z + e],
    [x - a + c, z + e - c], [x - a, z + e - c], [x - a, z - e + c], [x - a + c, z - e + c],
  ];
}

/** Rounded rectangle (4 × (seg + 1) points). */
export function roundPts(w: number, d: number, rad: number, seg: number, x = 0, z = 0): XZ[] {
  const out: XZ[] = [];
  const rr = Math.min(rad, w / 2 - 1e-3, d / 2 - 1e-3);
  const corners: [number, number, number][] = [[w / 2 - rr, d / 2 - rr, 0], [-(w / 2 - rr), d / 2 - rr, Math.PI / 2], [-(w / 2 - rr), -(d / 2 - rr), Math.PI], [w / 2 - rr, -(d / 2 - rr), Math.PI * 1.5]];
  for (const [cx, cz, a0] of corners) {
    for (let k = 0; k <= seg; k++) {
      const a = a0 + (k / seg) * (Math.PI / 2);
      out.push([x + cx + Math.cos(a) * rr, z + cz + Math.sin(a) * rr]);
    }
  }
  return out;
}

export function ngonPts(n: number, rx: number, rz: number, x = 0, z = 0, rot = 0): XZ[] {
  return Array.from({ length: n }, (_, k) => {
    const a = rot + (k / n) * Math.PI * 2;
    return [x + Math.cos(a) * rx, z + Math.sin(a) * rz] as XZ;
  });
}

export function scalePts(pts: readonly XZ[], k: number, kz = k, x = 0, z = 0): XZ[] {
  return pts.map(([px, pz]) => [x + (px - x) * k, z + (pz - z) * kz] as XZ);
}

export function shiftPts(pts: readonly XZ[], dx: number, dz: number): XZ[] {
  return pts.map(([px, pz]) => [px + dx, pz + dz] as XZ);
}

function centroid(pts: readonly XZ[]): XZ {
  let x = 0;
  let z = 0;
  for (const [px, pz] of pts) {
    x += px;
    z += pz;
  }
  return [x / pts.length, z / pts.length];
}

// ─── Kit: facades ──────────────────────────────────────────────────────────

export interface FacadeOpts {
  floors: number;
  /** Target bay width. */
  bay: number;
  /** Share of the floor height that is glazed. */
  winH?: number;
  /** Share of the bay width that is glazed. */
  winW?: number;
  /** Share of windows lit at night, their colour and daytime tint. */
  lit: number;
  light: ColorLike;
  tint: number;
  /** Vertical fins/mullions at bay lines. */
  fins?: { color: ColorLike; depth: number; width?: number; every?: number; bucket?: Bucket; corners?: boolean };
  /** Horizontal bands every n floors. */
  bands?: { color: ColorLike; every: number; depth: number; h?: number; bucket?: Bucket };
  /** Which edges get windows. */
  edges?: (edge: number, length: number) => boolean;
  skip?: (floor: number, bay: number, edge: number) => boolean;
  /** Per-window colour override (e.g. a lit crown). */
  light2?: (floor: number) => ColorLike | undefined;
  out?: number;
}

/**
 * Windows (and fins and bands) on every edge of a footprint between ring A
 * at yA and ring B at yB (B = null: vertical walls). Faces may lean, so
 * tapering towers work too.
 */
export function facade(b: GeoBuilder, r: () => number, A: readonly XZ[], yA: number, B: readonly XZ[] | null, yB: number, o: FacadeOpts) {
  const Bp = B ?? A;
  const n = A.length;
  const [cx, cz] = centroid(A);
  const H = yB - yA;
  const fh = H / o.floors;
  const winH = o.winH ?? 0.62;
  const winW = o.winW ?? 0.82;
  const out = o.out ?? 0.004;
  const w = winOf(b);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a0 = A[i]!;
    const a1 = A[j]!;
    const b0 = Bp[i]!;
    const b1 = Bp[j]!;
    const L = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]);
    if (L < 1e-4) continue;
    if (o.edges && !o.edges(i, L)) continue;
    const bays = Math.max(1, Math.round(L / o.bay));
    // Outward horizontal normal of this edge
    let hx = a1[1] - a0[1];
    let hz = -(a1[0] - a0[0]);
    const mx = (a0[0] + a1[0]) / 2;
    const mz = (a0[1] + a1[1]) / 2;
    if (hx * (mx - cx) + hz * (mz - cz) < 0) {
      hx = -hx;
      hz = -hz;
    }
    const hl = Math.hypot(hx, hz);
    hx /= hl;
    hz /= hl;
    const at = (u: number, t: number): [number, number, number] => {
      const lx = a0[0] + (a1[0] - a0[0]) * u;
      const lz = a0[1] + (a1[1] - a0[1]) * u;
      const ux = b0[0] + (b1[0] - b0[0]) * u;
      const uz = b0[1] + (b1[1] - b0[1]) * u;
      return [lx + (ux - lx) * t, yA + H * t, lz + (uz - lz) * t];
    };
    for (let f = 0; f < o.floors; f++) {
      const t = (f + 0.5 + (1 - winH) * 0.12) / o.floors;
      for (let k = 0; k < bays; k++) {
        if (o.skip?.(f, k, i)) continue;
        const u = (k + 0.5) / bays;
        const p = at(u, t);
        const lo = at(u, 0);
        const hi = at(u, 1);
        let ux = hi[0] - lo[0];
        let uy = hi[1] - lo[1];
        let uz = hi[2] - lo[2];
        const ul = Math.hypot(ux, uy, uz);
        ux /= ul;
        uy /= ul;
        uz /= ul;
        const e0 = at(0, t);
        const e1 = at(1, t);
        let rx = e1[0] - e0[0];
        let rz = e1[2] - e0[2];
        const rl = Math.hypot(rx, rz);
        const ew = rl / bays;
        rx /= rl;
        rz /= rl;
        // R × U must point outward
        const nx = 0 * uz - rz * uy;
        const nz = rx * uy - 0 * ux;
        if (nx * hx + nz * hz < 0) {
          rx = -rx;
          rz = -rz;
        }
        const nnx = -rz * uy;
        const nny = rz * ux - rx * uz;
        const nnz = rx * uy;
        const nl = Math.hypot(nnx, nny, nnz) || 1;
        const color = o.light2?.(f) ?? o.light;
        quad3(w, 'glow', p[0] + (nnx / nl) * out, p[1] + (nny / nl) * out, p[2] + (nnz / nl) * out, rx, 0, rz, ux, uy, uz, ew * winW, (fh * winH) / uy, color, wr(r, o.light2?.(f) ? 1 : o.lit, o.tint));
      }
    }
    if (o.fins) {
      const fw = o.fins.width ?? 0.014;
      const every = o.fins.every ?? 1;
      for (let k = o.fins.corners === false ? 1 : 0; k < bays; k += every) {
        const u = k / bays;
        const lo = at(u, 0);
        const hi = at(u, 1);
        const d = o.fins.depth;
        obox(b, (lo[0] + hi[0]) / 2 + (hx * d) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2 + (hz * d) / 2, hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], hx, 0, hz, fw, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]), d, o.fins.color, o.fins.bucket ?? 'solid');
      }
    }
    if (o.bands) {
      const bh = o.bands.h ?? 0.022;
      for (let f = o.bands.every; f < o.floors; f += o.bands.every) {
        const t = f / o.floors;
        const e0 = at(0, t);
        const e1 = at(1, t);
        const len = Math.hypot(e1[0] - e0[0], e1[2] - e0[2]);
        const d = o.bands.depth;
        obox(b, (e0[0] + e1[0]) / 2 + (hx * d) / 2, e0[1], (e0[2] + e1[2]) / 2 + (hz * d) / 2, e1[0] - e0[0], 0, e1[2] - e0[2], hx, 0, hz, bh, len + d * 1.2, d, o.bands.color, o.bands.bucket ?? 'solid');
      }
    }
  }
}

/** A vertical neon outline along the edges of a footprint at height y. */
export function neonRing(b: GeoBuilder, pts: readonly XZ[], y: number, h: number, color: ColorLike, rand = 0, out = 0.006) {
  const n = neonOf(b);
  const [cx, cz] = centroid(pts);
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const c = pts[(i + 1) % pts.length]!;
    const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
    if (L < 1e-4) continue;
    let nx = c[1] - a[1];
    let nz = -(c[0] - a[0]);
    const mx = (a[0] + c[0]) / 2;
    const mz = (a[1] + c[1]) / 2;
    if (nx * (mx - cx) + nz * (mz - cz) < 0) {
      nx = -nx;
      nz = -nz;
    }
    const l = Math.hypot(nx, nz);
    wall(n, 'glow', mx + (nx / l) * out, y, mz + (nz / l) * out, nx, nz, L + 0.004, h, color, rand);
  }
}

// ─── Kit: pixel font ───────────────────────────────────────────────────────

const FONT: Record<string, string> = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
  P: '110101110100100', Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111', '0': '111101101101111', '1': '010110010010111', '2': '110001010100111', '3': '110001010001110',
  '4': '101101111001001', '5': '111100110001110', '6': '011100111101111', '7': '111001010010010', '8': '111101111101111',
  '9': '111101111001110', ' ': '000000000000000', '&': '010101010101011', $: '011110010011110', '!': '010010010000010',
  '-': '000000111000000', '.': '000000000000010', "'": '010010000000000', '*': '000101010101000', '+': '000010111010000',
};

/** Width of a line of pixel text. */
export const textWidth = (text: string, px: number) => (text.length * 4 - 1) * px;

/**
 * Pixel-font text on a vertical face facing (nx, nz), centred on (x, y, z).
 * `vertical` stacks the letters like a blade sign.
 */
export function pixelText(b: GeoBuilder, bucket: Bucket, text: string, x: number, y: number, z: number, nx: number, nz: number, px: number, color: ColorLike, o: { vertical?: boolean; rand?: number; dot?: number } = {}) {
  const l = Math.hypot(nx, nz) || 1;
  const rx = nz / l;
  const rz = -nx / l;
  const s = o.dot ?? 1;
  const chars = text.toUpperCase().split('');
  const n = chars.length;
  chars.forEach((ch, i) => {
    const glyph = FONT[ch] ?? FONT[' ']!;
    const gx = o.vertical ? -1.5 * px : -textWidth(text, px) / 2 + i * 4 * px;
    const gy = o.vertical ? ((n - 1) / 2) * 6 * px - i * 6 * px + 2 * px : 2 * px;
    for (let row = 0; row < 5; row++) {
      let c0 = -1;
      for (let col = 0; col <= 3; col++) {
        const on = col < 3 && glyph[row * 3 + col] === '1';
        if (on && c0 < 0) c0 = col;
        if (!on && c0 >= 0) {
          const cx = gx + ((c0 + col) / 2) * px;
          const cy = gy - row * px;
          quad3(b, bucket, x + rx * cx, y + cy, z + rz * cx, rx, 0, rz, 0, 1, 0, (col - c0) * px - px * (1 - s), px * s, color, o.rand ?? 0);
          c0 = -1;
        }
      }
    }
  });
}

// ─── Kit: street furniture and greenery ────────────────────────────────────

export const LAMP: ColorLike = [2.6, 2.05, 1.35];
export const RED_LIGHT: ColorLike = [3.2, 0.25, 0.18];

/** Street lamp with a glowing head. */
export function lamp(b: GeoBuilder, x: number, z: number, y = 0, h = 0.34, color: ColorLike = LAMP) {
  b.cylinder(0.008, 0.012, h, x, y, z, 0x3a4048, 5);
  b.box(0.05, 0.018, 0.05, x, y + h, z, 0x3a4048);
  neonOf(b).blob(0.02, x, y + h - 0.012, z, color, true);
}

/** A tiny octahedron of light (cheap, rand-capable). */
export function quadBlob(b: GeoBuilder, x: number, y: number, z: number, r: number, color: ColorLike, rand = 0) {
  const q = batchOf(b, 'glow');
  const [cr, cg, cb] = rgb(color);
  const P = [[r, 0, 0], [-r, 0, 0], [0, r, 0], [0, -r, 0], [0, 0, r], [0, 0, -r]];
  const F = [[0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0], [4, 3, 0], [1, 3, 4], [5, 3, 1], [0, 3, 5]];
  for (const f of F) {
    const [a, bb, c] = f.map((i) => P[i]!) as [number[], number[], number[]];
    const nx = a[0]! + bb[0]! + c[0]!;
    const ny = a[1]! + bb[1]! + c[1]!;
    const nz = a[2]! + bb[2]! + c[2]!;
    const nl = Math.hypot(nx, ny, nz);
    for (const v of [a, bb, c]) {
      q.p.push(x + v[0]!, y + v[1]!, z + v[2]!);
      q.n.push(nx / nl, ny / nl, nz / nl);
      q.c.push(cr, cg, cb);
      q.w.push(rand);
    }
  }
}

export function bench(b: GeoBuilder, x: number, z: number, rotY = 0, y = 0) {
  b.box(0.12, 0.012, 0.035, x, y + 0.03, z, PALETTE.wood, false, rotY);
  b.box(0.12, 0.03, 0.008, x - Math.sin(rotY) * 0.016, y + 0.042, z - Math.cos(rotY) * 0.016, PALETTE.wood, false, rotY);
  for (const s of [-1, 1]) b.box(0.008, 0.03, 0.03, x + Math.cos(rotY) * s * 0.05, y, z - Math.sin(rotY) * s * 0.05, 0x3a4048, false, rotY);
}

export function planter(b: GeoBuilder, r: () => number, x: number, z: number, w: number, d: number, y = 0, color: ColorLike = 0xb9b2a4) {
  b.box(w, 0.06, d, x, y, z, color);
  b.box(w - 0.02, 0.012, d - 0.02, x, y + 0.055, z, 0x6a4e34);
  const n = Math.max(1, Math.round((w * d) / 0.012));
  for (let i = 0; i < Math.min(n, 6); i++) {
    b.blob(0.03 + r() * 0.02, x + (r() - 0.5) * (w - 0.06), y + 0.08, z + (r() - 0.5) * (d - 0.06), pick(r, PALETTE.leaves), 'smooth');
  }
}

/** A small crowd: little figures in bright clothes. */
export function people(b: GeoBuilder, r: () => number, x: number, z: number, n: number, sx: number, sz: number, y = 0) {
  const clothes = [0xe85a4a, 0x2f6fa8, 0xf2c84b, 0x3aa36a, 0xf4f1ea, 0x2a2f38, 0xd86aa8, 0x7a5ac8] as const;
  const skin = [0xf1c6a0, 0xd9a07a, 0xa8714f, 0x6e4a32, 0xf5d5b5] as const;
  for (let i = 0; i < n; i++) {
    const px = x + (r() - 0.5) * sx;
    const pz = z + (r() - 0.5) * sz;
    const h = 0.05 + r() * 0.012;
    b.box(0.022, h * 0.45, 0.016, px, y, pz, 0x3a3f4a, false, r() * 3);
    b.box(0.026, h * 0.38, 0.018, px, y + h * 0.45, pz, pick(r, clothes), false, r() * 3);
    b.blob(0.011, px, y + h * 0.9, pz, pick(r, skin), 'smooth');
  }
}

/** Coast redwood: tall, narrow, layered. */
export function redwood(b: GeoBuilder, r: () => number, x: number, z: number, s = 1, y = 0) {
  const k = s * (0.85 + r() * 0.3);
  b.cylinder(0.022 * k, 0.034 * k, 0.3 * k, x, y, z, 0x8a4a30, 5);
  const greens = [0x2f5a3a, 0x355f3c, 0x284f33] as const;
  for (let i = 0; i < 4; i++) {
    const r0 = (0.14 - i * 0.025) * k;
    b.cylinder(r0 * 0.25, r0, 0.32 * k, x, y + (0.18 + i * 0.2) * k, z, pick(r, greens), 7, false, r() * 2);
  }
}

/** Italian cypress. */
export function cypress(b: GeoBuilder, r: () => number, x: number, z: number, s = 1, y = 0) {
  const k = s * (0.85 + r() * 0.3);
  b.cylinder(0.012 * k, 0.016 * k, 0.06 * k, x, y, z, PALETTE.trunk, 4);
  const g = new THREE.SphereGeometry(0.07 * k, 7, 6);
  put(b, g, x, y + 0.28 * k, z, pick(r, PALETTE.pine), 'smooth', 0, 0, 0, 1, 3.4, 1);
}

/** A rounded shrub or tree crown. */
export function bush(b: GeoBuilder, r: () => number, x: number, y: number, z: number, s: number, color?: ColorLike) {
  const g = new THREE.IcosahedronGeometry(s, 1);
  put(b, g, x, y, z, color ?? pick(r, PALETTE.leaves), 'smooth', r() * 3, 0, 0, 1, 0.85, 1);
}

/** Paving: a slab with a curb line. */
export function slab(b: GeoBuilder, x: number, z: number, w: number, d: number, color: ColorLike = PALETTE.plaza, y = 0, h = 0.035) {
  b.box(w, h, d, x, y, z, color);
  b.box(w + 0.02, h * 0.6, d + 0.02, x, y, z, 0xa9a397);
}

// ─── Towers ────────────────────────────────────────────────────────────────

const NIGHT_WHITE: ColorLike = [1.5, 1.4, 1.2];

/** Office lights: dimmer than homes, since curtain walls have so much glass. */
function officeLight(r: () => number): ColorLike {
  const v = 0.8 + r() * 0.3;
  return r() < 0.6 ? [1.0 * v, 0.7 * v, 0.38 * v] : [0.58 * v, 0.78 * v, 1.05 * v];
}

/** Street level: plaza details around a tower's footprint (inside a 1.9 plot). */
function towerPlaza(b: GeoBuilder, r: () => number, x: number, z: number) {
  // Pavers: a lighter border and joint lines
  b.box(1.9, 0.004, 0.02, x, 0.035, z + 0.6, 0xcbc4b4);
  b.box(0.02, 0.004, 1.9, x + 0.6, 0.035, z, 0xcbc4b4);
  for (const [dx, dz] of [[0.82, 0.82], [0.82, -0.6], [-0.6, 0.82]] as const) {
    planter(b, r, x + dx, z + dz, 0.16, 0.16, 0.035);
    tree(b, r, x + dx, z + dz, 0.5, 0.09, 'round');
  }
  lamp(b, x + 0.86, z + 0.15, 0.035);
  lamp(b, x + 0.15, z + 0.86, 0.035);
  bench(b, x + 0.86, z - 0.25, Math.PI / 2, 0.035);
  bench(b, x - 0.25, z + 0.86, 0, 0.035);
  people(b, r, x + 0.55, z + 0.75, 3, 0.5, 0.2, 0.035);
}

/** Lobby: double-height glass with mullions, set in a stone or metal frame. */
function lobby(b: GeoBuilder, r: () => number, pts: readonly XZ[], y: number, h: number, frame: ColorLike, light: ColorLike = warmth(r)) {
  prism(b, pts, y, h, 0x2b323c);
  facade(b, r, pts, y, null, y + h, { floors: 1, bay: 0.16, winH: 0.86, winW: 0.9, lit: 0.95, light, tint: TINT.shop, fins: { color: frame, depth: 0.02, width: 0.018 } });
  prism(b, scalePts(pts, 1.03), y + h, 0.035, frame);
}

/** Entrance canopy on a face (normal nx, nz) with a light pool beneath. */
function canopy(b: GeoBuilder, x: number, z: number, nx: number, nz: number, w: number, y: number, color: ColorLike = 0xe8ecef) {
  const d = 0.16;
  b.box(Math.abs(nz) > 0.5 ? w : d, 0.02, Math.abs(nz) > 0.5 ? d : w, x + (nx * d) / 2, y, z + (nz * d) / 2, color);
  neonOf(b).decal(Math.abs(nz) > 0.5 ? w * 0.9 : d * 1.2, Math.abs(nz) > 0.5 ? d * 1.2 : w * 0.9, x + nx * d * 0.6, 0.038, z + nz * d * 0.6, [0.95, 0.82, 0.62], true);
  neonOf(b).box(Math.abs(nz) > 0.5 ? w * 0.9 : 0.012, 0.006, Math.abs(nz) > 0.5 ? 0.012 : w * 0.9, x + nx * (d - 0.01), y - 0.004, z + nz * (d - 0.01), LAMP, true);
}

/** Rooftop: mechanical penthouse, cooling towers, a window-washing crane, masts. */
function rooftop(b: GeoBuilder, r: () => number, x: number, y: number, z: number, w: number, d: number, color: ColorLike, masts = 1) {
  const pw = w * (0.45 + r() * 0.15);
  const pd = d * (0.4 + r() * 0.15);
  const ox = (r() - 0.5) * (w - pw) * 0.5;
  const oz = (r() - 0.5) * (d - pd) * 0.5;
  b.box(pw, 0.2, pd, x + ox, y, z + oz, color);
  for (let k = 0; k < 4; k++) b.box(pw + 0.006, 0.012, pd + 0.006, x + ox, y + 0.04 + k * 0.04, z + oz, 0x5b6470); // louvres
  // Cooling towers with fans
  for (let k = 0; k < 2; k++) {
    const cx = x - w * 0.28 + k * 0.17;
    const cz = z + d * 0.28;
    b.box(0.14, 0.1, 0.14, cx, y, cz, 0x9aa3ad);
    b.cylinder(0.05, 0.05, 0.012, cx, y + 0.1, cz, 0x3a4048, 10);
  }
  // Window-washing gantry
  b.box(0.04, 0.12, 0.04, x + w * 0.3, y, z - d * 0.3, 0xe8e2d6);
  b.box(0.32, 0.03, 0.03, x + w * 0.3 - 0.12, y + 0.12, z - d * 0.3, 0xe8e2d6);
  for (let k = 0; k < masts; k++) {
    const mx = x + (k ? -1 : 1) * w * 0.22;
    const mz = z + (k ? 1 : -1) * d * 0.1;
    const mh = 0.35 + r() * 0.35;
    rod(b, mx, y, mz, mx, y + mh, mz, 0.012, PALETTE.steel, 4, 'solid', 0.006);
    quadBlob(neonOf(b), mx, y + mh + 0.02, mz, 0.022, RED_LIGHT, FX.blink + r());
  }
}

/** 555 California: dark granite, sawtooth bay windows from street to sky. */
function graniteTower(b: GeoBuilder, r: () => number, x: number, z: number, H: number) {
  const W = 1.24;
  const D = 0.94;
  const granite = pick(r, [0x5a3f39, 0x4d3c3a, 0x634538] as const);
  const y0 = 0.035;
  const lob = 0.34;
  const light = officeLight(r);
  // Recessed lobby behind a granite arcade
  lobby(b, r, rectPts(W - 0.14, D - 0.14, x, z), y0, lob, 0x2a2224, light);
  for (const [px, pz] of rectPts(W, D, x, z)) b.box(0.07, lob, 0.07, px + (px < x ? 0.035 : -0.035), y0, pz + (pz < z ? 0.035 : -0.035), granite);
  for (let k = 1; k < 5; k++) {
    for (const s of [-1, 1]) {
      b.box(0.045, lob, 0.045, x - W / 2 + (k * W) / 5, y0, z + s * (D / 2 - 0.03), granite);
      b.box(0.045, lob, 0.045, x + s * (W / 2 - 0.03), y0, z - D / 2 + (k * D) / 5, granite);
    }
  }
  const ys = y0 + lob;
  prism(b, rectPts(W, D, x, z), ys, H - ys, granite);
  // The bays
  const floors = Math.round((H - ys - 0.16) / 0.2);
  const fh = (H - ys - 0.16) / floors;
  const dep = 0.05;
  const edges: [XZ, XZ, number, number][] = [
    [[x - W / 2, z + D / 2], [x + W / 2, z + D / 2], 0, 1],
    [[x + W / 2, z + D / 2], [x + W / 2, z - D / 2], 1, 0],
    [[x + W / 2, z - D / 2], [x - W / 2, z - D / 2], 0, -1],
    [[x - W / 2, z - D / 2], [x - W / 2, z + D / 2], -1, 0],
  ];
  const w = winOf(b);
  for (const [a, c, nx, nz] of edges) {
    const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const n = Math.round(L / 0.19);
    const tx = (c[0] - a[0]) / L;
    const tz = (c[1] - a[1]) / L;
    for (let k = 0; k < n; k++) {
      const s0 = (k / n) * L + 0.016;
      const s1 = ((k + 1) / n) * L - 0.016;
      const p0: XZ = [a[0] + tx * s0, a[1] + tz * s0];
      const p1: XZ = [a[0] + tx * s1, a[1] + tz * s1];
      const q: XZ = [(p0[0] + p1[0]) / 2 + nx * dep, (p0[1] + p1[1]) / 2 + nz * dep];
      prism(b, [p0, p1, q], ys + 0.04, floors * fh + 0.02, granite);
      for (const [e0, e1] of [[p0, q], [q, p1]] as const) {
        let fx = e1[1] - e0[1];
        let fz = -(e1[0] - e0[0]);
        if (fx * nx + fz * nz < 0) {
          fx = -fx;
          fz = -fz;
        }
        const fl = Math.hypot(fx, fz);
        const ew = Math.hypot(e1[0] - e0[0], e1[1] - e0[1]);
        for (let f = 0; f < floors; f++) {
          wall(w, 'glow', (e0[0] + e1[0]) / 2 + (fx / fl) * 0.003, ys + 0.04 + (f + 0.55) * fh, (e0[1] + e1[1]) / 2 + (fz / fl) * 0.003, fx, fz, ew * 0.78, fh * 0.64, light, wr(r, 0.5, TINT.bronze));
        }
      }
    }
  }
  // Parapet, crown lights, rooftop
  prism(b, rectPts(W + 0.11, D + 0.11, x, z), H - 0.1, 0.1, shade(granite, 0.8));
  neonRing(b, rectPts(W + 0.11, D + 0.11, x, z), H - 0.035, 0.016, NIGHT_WHITE);
  rooftop(b, r, x, H, z, W * 0.9, D * 0.9, shade(granite, 0.9), 2);
  // The Banker's Heart: a polished black sculpture on the plaza
  const heart = new THREE.IcosahedronGeometry(0.1, 1);
  put(b, heart, x + 0.72, 0.1, z + 0.62, 0x15161a, 'glass', 0.6, 0.2, 0.4, 1.3, 0.75, 0.9);
  b.box(0.3, 0.02, 0.22, x + 0.72, 0.035, z + 0.62, 0x4a3f3c);
}

/** Millennium-ish: rounded silver glass, stepping back towards the top. */
function taperTower(b: GeoBuilder, r: () => number, x: number, z: number, H: number) {
  const W = 1.16;
  const D = 0.98;
  const rad = 0.34;
  const glass = pick(r, [0xa9bccb, 0x9eb6c8, 0xb8c6d0] as const);
  const tint = r() < 0.5 ? TINT.silver : TINT.blue;
  const light = officeLight(r);
  const y0 = 0.035;
  const lob = 0.4;
  lobby(b, r, roundPts(W - 0.06, D - 0.06, rad, 3, x, z), y0, lob, 0xd8dde2, light);
  canopy(b, x, z + D / 2 - 0.02, 0, 1, 0.4, y0 + 0.24);
  canopy(b, x + W / 2 - 0.02, z, 1, 0, 0.4, y0 + 0.24);
  const ys = y0 + lob + 0.035;
  const main = ys + (H - ys) * 0.74;
  const fh = 0.19;
  const shaft = (pts: XZ[], ya: number, yb: number) => {
    prism(b, pts, ya, yb - ya, glass, 'glass');
    const floors = Math.max(1, Math.round((yb - ya) / fh));
    facade(b, r, pts, ya, null, yb, { floors, bay: 0.13, winH: 0.74, winW: 0.92, lit: 0.45, light, tint, bands: { color: 0xe4e9ee, every: 4, depth: 0.012, h: 0.016 } });
  };
  const base = roundPts(W, D, rad, 3, x, z);
  shaft(base, ys, main);
  // Stepped crown: each step smaller, sliding back so the terraces face the street
  let y = main;
  let prev = base;
  const steps = 3;
  for (let s = 1; s <= steps; s++) {
    const k = 1 - s * 0.13;
    const pts = roundPts(W * k, D * k, rad * k, 3, x - s * 0.06, z - s * 0.05);
    prism(b, prev, y, 0.02, 0xe4e9ee); // terrace slab
    neonRing(b, prev, y + 0.01, 0.012, NIGHT_WHITE);
    const hgt = ((H - main) / steps) * (s === steps ? 1.2 : 1);
    shaft(pts, y + 0.02, y + hgt);
    y += hgt;
    prev = pts;
  }
  prism(b, scalePts(prev, 1.02, 1.02, x - steps * 0.06, z - steps * 0.05), y, 0.05, 0xe4e9ee);
  neonRing(b, scalePts(prev, 1.02, 1.02, x - steps * 0.06, z - steps * 0.05), y + 0.03, 0.02, NIGHT_WHITE);
  rooftop(b, r, x - steps * 0.06, y + 0.05, z - steps * 0.05, W * 0.55, D * 0.55, 0xc9d0d6, 1);
  // Glass pavilion at the corner
  b.box(0.3, 0.2, 0.3, x + 0.68, 0.035, z + 0.66, glass, 'glass');
  b.box(0.34, 0.02, 0.34, x + 0.68, 0.235, z + 0.66, 0xe4e9ee);
}

/** 181 Fremont: tapering glass with diagonal steel bracing and a sloped crown. */
function bracedTower(b: GeoBuilder, r: () => number, x: number, z: number, H: number) {
  const W = 1.14;
  const c = 0.2;
  const glass = pick(r, [0x7f9fb8, 0x86a8bf, 0x6f93ad] as const);
  const brace = 0xeef0f2;
  const light = officeLight(r);
  const y0 = 0.035;
  const lob = 0.42;
  lobby(b, r, chamferPts(W - 0.12, W - 0.12, c, x, z), y0, lob, 0xd5dade, light);
  canopy(b, x, z + (W - 0.12) / 2, 0, 1, 0.5, y0 + 0.26);
  const ys = y0 + lob + 0.035;
  const top = H - 0.2;
  const A = chamferPts(W, W, c, x, z);
  const B = chamferPts(W * 0.84, W * 0.84, c * 0.8, x, z);
  loft(b, [{ pts: A, y: ys }, { pts: B, y: top }], glass, 'glass', false);
  const floors = Math.round((top - ys) / 0.19);
  facade(b, r, A, ys, B, top, { floors, bay: 0.13, winH: 0.76, winW: 0.9, lit: 0.45, light, tint: TINT.teal });
  // X braces on the main faces, one module every ~1.3 units
  const modules = Math.max(2, Math.round((top - ys) / 1.25));
  for (let e = 0; e < 8; e += 2) {
    const a0 = A[e]!;
    const a1 = A[(e + 1) % 8]!;
    const b0 = B[e]!;
    const b1 = B[(e + 1) % 8]!;
    let nx = a1[1] - a0[1];
    let nz = -(a1[0] - a0[0]);
    const mx = (a0[0] + a1[0]) / 2 - x;
    const mz = (a0[1] + a1[1]) / 2 - z;
    if (nx * mx + nz * mz < 0) {
      nx = -nx;
      nz = -nz;
    }
    const nl = Math.hypot(nx, nz);
    const ox = (nx / nl) * 0.022;
    const oz = (nz / nl) * 0.022;
    const pt = (u: number, t: number): [number, number, number] => {
      const lx = a0[0] + (a1[0] - a0[0]) * u;
      const lz = a0[1] + (a1[1] - a0[1]) * u;
      const ux = b0[0] + (b1[0] - b0[0]) * u;
      const uz = b0[1] + (b1[1] - b0[1]) * u;
      return [lx + (ux - lx) * t + ox, ys + (top - ys) * t, lz + (uz - lz) * t + oz];
    };
    for (let m = 0; m < modules; m++) {
      const t0 = m / modules;
      const t1 = (m + 1) / modules;
      const p00 = pt(0, t0);
      const p10 = pt(1, t0);
      const p01 = pt(0, t1);
      const p11 = pt(1, t1);
      beam(b, p00[0], p00[1], p00[2], p11[0], p11[1], p11[2], 0.03, brace);
      beam(b, p10[0], p10[1], p10[2], p01[0], p01[1], p01[2], 0.03, brace);
      beam(b, p00[0], p00[1], p00[2], p10[0], p10[1], p10[2], 0.022, brace);
    }
    for (const u of [0, 1]) {
      const lo = pt(u, 0);
      const hi = pt(u, 1);
      beam(b, lo[0], lo[1], lo[2], hi[0], hi[1], hi[2], 0.028, brace);
    }
  }
  // Sloped, faceted crown rising to the street corner, then a mast
  const C = chamferPts(W * 0.84, W * 0.84, c * 0.8, x, z);
  const tipX = x + 0.18;
  const tipZ = z + 0.18;
  const D2 = chamferPts(W * 0.2, W * 0.2, 0.05, tipX, tipZ);
  loft(b, [{ pts: C, y: top }, { pts: scalePts(C, 0.86, 0.86, x + 0.05, z + 0.05), y: top + 0.35 }, { pts: D2, y: top + 0.95 }], glass, 'glass');
  facade(b, r, C, top, scalePts(C, 0.86, 0.86, x + 0.05, z + 0.05), top + 0.35, { floors: 2, bay: 0.13, winH: 0.8, winW: 0.9, lit: 1, light: NIGHT_WHITE, tint: TINT.silver });
  for (let e = 0; e < 8; e++) {
    const p = C[e]!;
    const q = D2[e]!;
    beam(b, p[0], top, p[1], q[0], top + 0.95, q[1], 0.018, brace);
    rod(neonOf(b), p[0], top + 0.02, p[1], q[0], top + 0.93, q[1], 0.006, NIGHT_WHITE, 3, 'glow');
  }
  rod(b, tipX, top + 0.95, tipZ, tipX, top + 1.75, tipZ, 0.016, 0xd8dce0, 5, 'solid', 0.006);
  quadBlob(neonOf(b), tipX, top + 1.77, tipZ, 0.03, RED_LIGHT, FX.blink + r());
}

/** Shell Building-ish: buff terracotta setbacks, deco piers, a lit copper crown. */
function decoTower(b: GeoBuilder, r: () => number, x: number, z: number, H: number) {
  const stone = pick(r, [0xe0cfac, 0xd8c19c, 0xd2bfa2, 0xe6d8bd] as const);
  const trim = shade(stone, 0.82);
  const copper = 0x5f9e88;
  const light = officeLight(r);
  const y0 = 0.035;
  const lob = 0.36;
  const W = 1.26;
  lobby(b, r, notchPts(W - 0.1, W - 0.1, 0.12, x, z), y0, lob, 0x8a6a3a, light);
  canopy(b, x, z + (W - 0.1) / 2, 0, 1, 0.36, y0 + 0.24, 0x2f3a46);
  canopy(b, x + (W - 0.1) / 2, z, 1, 0, 0.36, y0 + 0.24, 0x2f3a46);
  const tiers: [number, number][] = [[W, 0.58], [W * 0.8, 0.24], [W * 0.6, 0.18]];
  let y = y0 + lob;
  const span = H - y;
  for (const [tw, share] of tiers) {
    const pts = notchPts(tw, tw, tw * 0.1, x, z);
    const h = span * share;
    prism(b, pts, y, h, stone);
    const floors = Math.max(1, Math.round(h / 0.2));
    facade(b, r, pts, y, null, y + h - 0.06, { floors, bay: 0.12, winH: 0.66, winW: 0.5, lit: 0.5, light, tint: TINT.teal, fins: { color: stone, depth: 0.024, width: 0.03 } });
    prism(b, scalePts(pts, 1.04, 1.04, x, z), y + h - 0.05, 0.05, trim);
    y += h;
  }
  // Copper hip crown with a lantern and finial, lit gold at night
  const cw = W * 0.6;
  b.hip(cw * 0.95, 0.34, cw * 0.95, x, y, z, copper, 0.02, 0.3);
  const lw = 0.14;
  b.box(lw, 0.16, lw, x, y + 0.3, z, stone);
  facade(b, r, rectPts(lw, lw, x, z), y + 0.3, null, y + 0.46, { floors: 1, bay: 0.1, winH: 0.7, winW: 0.6, lit: 1, light: [2.4, 1.7, 0.7], tint: TINT.bronze });
  b.cylinder(0, 0.06, 0.16, x, y + 0.46, z, copper, 4, false, Math.PI / 4);
  rod(b, x, y + 0.6, z, x, y + 0.95, z, 0.01, 0xd4af37, 4);
  quadBlob(neonOf(b), x, y + 0.97, z, 0.028, RED_LIGHT, FX.blink + r());
  neonRing(b, notchPts(cw, cw, cw * 0.1, x, z), y + 0.01, 0.02, [2.6, 1.9, 0.9]);
}

/** Office towers and skyscrapers (tier 3 or 5), one of four San Francisco types. */
export function tower(b: GeoBuilder, r: () => number, x: number, z: number, tier: number, neon: ColorLike) {
  void neon;
  const style = Math.floor(r() * 4);
  const H = tier >= 5 ? 4.6 + r() * 1.2 : 2.4 + r() * 0.8;
  towerPlaza(b, r, x, z);
  if (style === 0) graniteTower(b, r, x - 0.08, z - 0.08, H);
  else if (style === 1) taperTower(b, r, x - 0.08, z - 0.08, H);
  else if (style === 2) bracedTower(b, r, x - 0.08, z - 0.08, H);
  else decoTower(b, r, x - 0.08, z - 0.08, H);
}

// ─── The pyramid ───────────────────────────────────────────────────────────

/** The Transamerica Pyramid, with its wings, spire and Redwood Park. */
export function pyramid(b: GeoBuilder, r: () => number, x: number, z: number) {
  const cx = x - 0.14;
  const cz = z - 0.14;
  const hb = 0.62;
  const apex = 6.5;
  const white = 0xf1eee6;
  const half = (y: number) => hb * (1 - y / apex);
  const yb = 0.38; // top of the base
  // Base: recessed lobby behind the slanted truss
  b.box(hb * 1.5, yb, hb * 1.5, cx, 0.035, cz, 0x2b323c);
  facade(b, r, rectPts(hb * 1.5, hb * 1.5, cx, cz), 0.035, null, yb, { floors: 1, bay: 0.12, winH: 0.8, winW: 0.86, lit: 0.95, light: warmth(r), tint: TINT.shop });
  const faces: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  for (const [nx, nz] of faces) {
    const tx = -nz;
    const tz = nx;
    const hw = half(yb);
    const n = 5;
    for (let k = 0; k <= n; k++) {
      const u = (k / n - 0.5) * 2;
      const gx = cx + nx * hb * 0.98 + tx * u * hb * 0.98;
      const gz = cz + nz * hb * 0.98 + tz * u * hb * 0.98;
      for (const s of [-1, 1]) {
        const v = Math.max(-1, Math.min(1, u + s * (1 / n)));
        beam(b, gx, 0.035, gz, cx + nx * hw + tx * v * hw, yb, cz + nz * hw + tz * v * hw, 0.03, white);
      }
    }
  }
  // The pyramid itself: four tapering faces (a square frustum to the spire tip)
  const g = new THREE.CylinderGeometry(0, Math.SQRT2 * half(yb), apex - yb, 4, 1);
  g.rotateY(Math.PI / 4);
  put(b, g, cx, yb + (apex - yb) / 2, cz, white);
  // Windows: deep-set, one per bay per floor, on the sloped faces
  const top = apex * 0.8;
  const floorH = 0.105;
  const slope = hb / apex;
  const w = winOf(b);
  const light = officeLight(r);
  for (const [nx, nz] of faces) {
    const tx = -nz;
    const tz = nx;
    const ul = Math.hypot(slope, 1);
    for (let y = yb + 0.08; y < top; y += floorH) {
      const hw = half(y);
      const cols = Math.floor((hw * 2 - 0.04) / 0.075);
      for (let k = 0; k < cols; k++) {
        const u = ((k + 0.5) / cols - 0.5) * (hw * 2 - 0.05);
        const off = 0.004;
        quad3(w, 'glow', cx + nx * (hw + off) + tx * u, y, cz + nz * (hw + off) + tz * u, nz === 0 ? 0 : nz > 0 ? 1 : -1, 0, nx === 0 ? 0 : nx > 0 ? -1 : 1, (-nx * slope) / ul, 1 / ul, (-nz * slope) / ul, 0.045, 0.062, light, wr(r, 0.5, TINT.smoke));
      }
    }
  }
  // The wings ("ears"): elevator shafts on the east and west faces
  const ys = apex * 0.47;
  const ye = apex * 0.83;
  for (const s of [-1, 1]) {
    const hw = half(ys);
    const pts: [number, number][] = [[0, ys], [hw, ys], [hw, ye], [hw * 0.55, ye + 0.32], [0, ye + 0.32]];
    profile(b, pts.map(([px, py]) => [px, py - ys] as [number, number]), 0.24, cx, ys, cz, s > 0 ? 0 : Math.PI, white);
    for (let y = ys + 0.25; y < ye - 0.1; y += 0.32) wall(w, 'glow', cx + s * (hw + 0.004), y, cz, s, 0, 0.05, 0.09, light, wr(r, 0.7, TINT.smoke));
  }
  // The spire: lit from within at night, with the red light on top
  const sy = apex * 0.86;
  for (const [nx, nz] of faces) {
    const hw = half(sy + 0.25);
    quad3(neonOf(b), 'glow', cx + nx * (hw + 0.006), sy + 0.25, cz + nz * (hw + 0.006), nz === 0 ? 0 : nz > 0 ? 1 : -1, 0, nx === 0 ? 0 : nx > 0 ? -1 : 1, -nx * slope, 1, -nz * slope, hw * 1.1, 0.35, [1.6, 1.45, 1.2], FX.shimmer + 0.2);
  }
  rod(b, cx, apex - 0.02, cz, cx, apex + 0.25, cz, 0.008, white, 4);
  quadBlob(neonOf(b), cx, apex + 0.27, cz, 0.035, RED_LIGHT, FX.blink + 0.1);
  // Redwood Park: a grove, a fountain with frogs, benches, paths
  b.box(1.9, 0.012, 0.42, x, 0.035, z + 0.74, PALETTE.lawn);
  b.box(0.42, 0.012, 1.48, x + 0.74, 0.035, z - 0.21, PALETTE.lawn);
  b.box(1.9, 0.006, 0.07, x, 0.047, z + 0.62, 0xd8cdb4);
  b.box(0.07, 0.006, 1.48, x + 0.62, 0.047, z - 0.21, 0xd8cdb4);
  for (const [dx, dz] of [[0.82, -0.8], [0.72, -0.45], [0.86, -0.1], [0.74, 0.25], [0.84, 0.82], [0.4, 0.84], [0.05, 0.76], [-0.35, 0.84], [-0.78, 0.76]] as const) {
    redwood(b, r, x + dx, z + dz, 0.95, 0.045);
  }
  b.cylinder(0.12, 0.13, 0.04, x + 0.42, 0.045, z + 0.42, 0xcfc8b8, 12);
  b.cylinder(0.1, 0.1, 0.01, x + 0.42, 0.075, z + 0.42, PALETTE.pool, 12);
  for (let k = 0; k < 3; k++) b.blob(0.014, x + 0.42 + Math.cos(k * 2.1) * 0.06, 0.09, z + 0.42 + Math.sin(k * 2.1) * 0.06, 0x4f8a3a, 'smooth');
  bench(b, x + 0.42, z + 0.6, 0, 0.045);
  bench(b, x + 0.6, z + 0.2, Math.PI / 2, 0.045);
  lamp(b, x + 0.6, z + 0.6, 0.045);
  people(b, r, x + 0.3, z + 0.62, 4, 0.5, 0.06, 0.045);
}

// ─── The supertall ─────────────────────────────────────────────────────────

/** Salesforce Tower-ish: rounded glass shaft, pale fins, an LED crown; the transit park at its feet. */
export function spire(b: GeoBuilder, r: () => number, x: number, z: number, neon: ColorLike) {
  void neon;
  const tx = x - 0.6;
  const tz = z - 0.6;
  slab(b, x, z, 3.9, 3.9, PALETTE.plaza);
  const y0 = 0.035;
  const lob = 0.5;
  const glass = 0x9fb3c4;
  const fin = 0xdcdcd6;
  const light = officeLight(r);
  const ring = (k: number, y: number) => ({ pts: roundPts(1.58 * k, 1.58 * k, 0.48 * k + (1 - k) * 0.9, 4, tx, tz), y });
  // Lobby: a tall glass base with a wide canopy
  lobby(b, r, roundPts(1.5, 1.5, 0.44, 4, tx, tz), y0, lob, 0xe6e4de, warmth(r));
  canopy(b, tx + 0.74, tz, 1, 0, 0.8, y0 + 0.36, 0xe6e4de);
  canopy(b, tx, tz + 0.74, 0, 1, 0.8, y0 + 0.36, 0xe6e4de);
  // Shaft: gently tapering, the corners rounding more towards the top
  const ys = y0 + lob + 0.035;
  const stations = [ring(1, ys), ring(0.97, 2.6), ring(0.92, 5.0), ring(0.84, 7.1), ring(0.76, 8.0)];
  loft(b, stations, glass, 'glass', true);
  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i]!;
    const c = stations[i + 1]!;
    facade(b, r, a.pts, a.y, c.pts, c.y, {
      floors: Math.round((c.y - a.y) / 0.17),
      bay: 0.13,
      winH: 0.8,
      winW: 0.78,
      lit: 0.6,
      light,
      tint: TINT.silver,
      fins: { color: fin, depth: 0.026, width: 0.016, every: 1 },
    });
  }
  // Crown: the facade continues past the roof as an open lattice, lit by the LED screen
  const c0 = stations[stations.length - 1]!;
  const crown = [c0, ring(0.66, 8.75), ring(0.5, 9.35)];
  const scr = screenOf(b);
  for (let i = 0; i < crown.length - 1; i++) {
    const a = crown[i]!;
    const c = crown[i + 1]!;
    const n = a.pts.length;
    let perim = 0;
    for (let j = 0; j < n; j++) perim += Math.hypot(a.pts[(j + 1) % n]![0] - a.pts[j]![0], a.pts[(j + 1) % n]![1] - a.pts[j]![1]);
    let s = 0;
    for (let j = 0; j < n; j++) {
      const p0 = a.pts[j]!;
      const p1 = a.pts[(j + 1) % n]!;
      const q0 = c.pts[j]!;
      const q1 = c.pts[(j + 1) % n]!;
      const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      const u0 = s / perim;
      s += L;
      const u1 = s / perim;
      // Two triangles per segment, both sides visible (the material is double-sided)
      const tri = (pa: number[], pb: number[], pc: number[], ra: number, rb: number, rc: number) => {
        const q = batchOf(scr, 'glow');
        const e1 = [pb[0]! - pa[0]!, pb[1]! - pa[1]!, pb[2]! - pa[2]!];
        const e2 = [pc[0]! - pa[0]!, pc[1]! - pa[1]!, pc[2]! - pa[2]!];
        const nn = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
        const nl = Math.hypot(nn[0]!, nn[1]!, nn[2]!) || 1;
        const [cr, cg, cb] = rgb(0xdfe4e8);
        for (const [v, rr] of [[pa, ra], [pb, rb], [pc, rc]] as const) {
          q.p.push(v[0]!, v[1]!, v[2]!);
          q.n.push(nn[0]! / nl, nn[1]! / nl, nn[2]! / nl);
          q.c.push(cr, cg, cb);
          q.w.push(rr);
        }
      };
      const A0 = [p0[0], a.y, p0[1]];
      const A1 = [p1[0], a.y, p1[1]];
      const B0 = [q0[0], c.y, q0[1]];
      const B1 = [q1[0], c.y, q1[1]];
      tri(A0, B1, A1, u0, u1, u1);
      tri(A0, B0, B1, u0, u0, u1);
      // Fins of the lattice
      if (j % 2 === 0) beam(b, p0[0], a.y, p0[1], q0[0], c.y, q0[1], 0.016, fin);
    }
    loft(b, [{ pts: c.pts, y: c.y - 0.03 }, { pts: c.pts, y: c.y }], fin, 'solid', false);
  }
  // A roof deep inside the crown with a glowing core
  prism(b, scalePts(c0.pts, 0.9, 0.9, tx, tz), c0.y - 0.02, 0.03, 0x3a4250);
  b.box(0.4, 0.16, 0.3, tx - 0.1, c0.y, tz - 0.1, 0x59616c);
  b.cylinder(0.12, 0.12, 0.1, tx + 0.22, c0.y, tz + 0.15, 0x8a929c, 10);
  rod(b, tx, 9.3, tz, tx, 9.75, tz, 0.012, fin, 5, 'solid', 0.005);
  quadBlob(neonOf(b), tx, 9.77, tz, 0.04, RED_LIGHT, FX.blink + 0.5);
  for (const [px, pz] of [[0.55, 0.55], [-0.55, -0.55], [0.55, -0.55], [-0.55, 0.55]] as const) quadBlob(neonOf(b), tx + px * 0.75, 9.36, tz + pz * 0.75, 0.025, RED_LIGHT, FX.blink + 0.5);

  // Transit center: a long hall in a white, wavy perforated skin, a park on its roof
  const px0 = x;
  const pz0 = z + 1.18;
  const pw = 3.8;
  const pd = 1.4;
  const ph = 0.5;
  b.box(pw - 0.08, ph, pd - 0.08, px0, y0, pz0, 0xe9e7e1);
  for (let k = 0; k <= 64; k++) {
    const u = k / 64;
    const sx = px0 - pw / 2 + u * pw;
    const depth = 0.02 + 0.035 * (0.5 + 0.5 * Math.sin(u * Math.PI * 7));
    b.box(0.025, ph - 0.06, depth, sx, y0 + 0.03, pz0 + pd / 2 - 0.04 + depth / 2, 0xf6f5f0);
    if (k % 2 === 0) b.box(0.025, ph - 0.06, depth, sx, y0 + 0.03, pz0 - pd / 2 + 0.04 - depth / 2, 0xf6f5f0);
  }
  for (let k = 0; k <= 16; k++) {
    const u = k / 16;
    const sz = pz0 - pd / 2 + u * pd;
    const depth = 0.02 + 0.035 * (0.5 + 0.5 * Math.sin(u * Math.PI * 3));
    for (const s of [-1, 1]) b.box(depth, ph - 0.06, 0.025, px0 + s * (pw / 2 - 0.04 + depth / 2), y0 + 0.03, sz, 0xf6f5f0);
  }
  // Glowing hall seen between the slats
  for (const s of [-1, 1]) wall(winOf(b), 'glow', px0, y0 + 0.25, pz0 + s * (pd / 2 - 0.035), 0, s, pw - 0.2, 0.36, warmth(r), wr(r, 1, TINT.smoke));
  // The rooftop park
  const ry = y0 + ph;
  b.box(pw, 0.05, pd, px0, ry, pz0, 0xd9d4c8);
  b.box(pw - 0.12, 0.012, pd - 0.12, px0, ry + 0.05, pz0, PALETTE.lawn);
  // Winding path
  for (let k = 0; k < 12; k++) {
    const u = k / 11;
    b.box(0.34, 0.006, 0.07, px0 - pw / 2 + 0.2 + u * (pw - 0.4), ry + 0.062, pz0 + Math.sin(u * Math.PI * 3) * 0.35, 0xe8dcc4, false, Math.cos(u * Math.PI * 3) * 0.6);
  }
  // Amphitheatre and the bus fountain
  for (let k = 0; k < 3; k++) b.box(0.42 - k * 0.08, 0.02 + k * 0.02, 0.06, px0 + 1.25, ry + 0.06, pz0 - 0.4 + k * 0.06, 0xcfc8b8);
  b.box(1.2, 0.012, 0.06, px0 - 0.4, ry + 0.062, pz0 - 0.5, 0x6fb9d6);
  for (let k = 0; k < 10; k++) quadBlob(neonOf(b), px0 - 0.95 + k * 0.12, ry + 0.1, pz0 - 0.5, 0.012, [0.7, 1.4, 2.2], FX.shimmer + k * 0.1);
  for (let k = 0; k < 9; k++) {
    const u = k / 8;
    tree(b, r, px0 - pw / 2 + 0.25 + u * (pw - 0.5), pz0 + (k % 2 ? 0.45 : 0.1) + (r() - 0.5) * 0.1, 0.6, ry + 0.06, k % 3 === 0 ? 'cypress' : 'round');
  }
  for (let k = 0; k < 5; k++) lamp(b, px0 - 1.6 + k * 0.8, pz0 + 0.62, ry + 0.06, 0.18);
  people(b, r, px0, pz0, 10, pw - 0.6, pd - 0.6, ry + 0.06);
  // The little gondola from the street
  rod(b, px0 - 1.75, 0.035, pz0 - 0.78, px0 - 1.75, ry + 0.25, pz0 - 0.78, 0.012, 0xe9e7e1, 5);
  beam(b, px0 - 1.75, ry + 0.25, pz0 - 0.78, px0 - 1.45, ry + 0.25, pz0 - 0.55, 0.008, 0x3a4048);
  b.rbox(0.09, 0.08, 0.07, px0 - 1.62, ry + 0.12, pz0 - 0.68, 0xd8402e, 0.02);
  // Plaza on the Fremont Street side: water steps, sculpture, people
  b.box(0.7, 0.03, 0.5, x + 1.3, 0.035, z - 1.2, 0xcfc8b8);
  b.box(0.62, 0.012, 0.42, x + 1.3, 0.065, z - 1.2, PALETTE.pool);
  b.box(0.06, 0.32, 0.06, x + 1.3, 0.035, z - 0.6, 0xd8402e);
  put(b, new THREE.TorusGeometry(0.1, 0.018, 6, 16), x + 1.3, 0.42, z - 0.6, 0xd8402e, 'smooth', Math.PI / 4);
  for (const [dx, dz] of [[1.75, -1.75], [1.75, -0.2], [0.4, -1.75], [-1.0, -1.75], [-1.75, -1.0], [-1.75, 0.2]] as const) {
    planter(b, r, x + dx, z + dz, 0.14, 0.14, 0.035);
    tree(b, r, x + dx, z + dz, 0.55, 0.09, 'round');
  }
  for (const [dx, dz] of [[1.75, -1.0], [0.9, -1.75], [-1.75, -0.4]] as const) lamp(b, x + dx, z + dz, 0.035);
  people(b, r, x + 1.1, z - 0.5, 6, 0.8, 1.6, 0.035);
}

// ─── Campus and theatre ────────────────────────────────────────────────────

/** Tech campus: an L of low glass and timber, solar roofs, a courtyard with palms. */
export function campus(b: GeoBuilder, r: () => number, x: number, z: number, neon: ColorLike) {
  slab(b, x, z, 1.9, 1.9, PALETTE.plaza);
  b.box(1.0, 0.012, 1.0, x + 0.38, 0.035, z + 0.38, PALETTE.lawn);
  const accent = pick(r, [0xff6a3d, 0x3a8ff2, 0x2fbf8f, 0xf2b53a, 0x9d6bff] as const);
  const wood = 0xc08a5a;
  const light = officeLight(r);
  const fh = 0.2;
  const wing = (pts: XZ[], floors: number) => {
    const h = floors * fh;
    prism(b, pts, 0.035, h, 0x9fb7c6, 'glass');
    facade(b, r, pts, 0.035, null, 0.035 + h, { floors, bay: 0.14, winH: 0.82, winW: 0.9, lit: 0.7, light, tint: TINT.blue, fins: { color: wood, depth: 0.03, width: 0.016 }, bands: { color: 0xf4f2ee, every: 1, depth: 0.05, h: 0.02 } });
    prism(b, scalePts(pts, 1.04), 0.035 + h, 0.03, 0xf4f2ee);
    return 0.065 + h;
  };
  const ya = wing(rectPts(1.7, 0.56, x - 0.05, z - 0.62), 3);
  const yb = wing(rectPts(0.56, 1.08, x - 0.62, z + 0.2), 2);
  // Solar arrays and a green roof
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 2; j++) {
      const g = new THREE.BoxGeometry(0.3, 0.012, 0.16);
      put(b, g, x - 0.6 + i * 0.36, ya + 0.05, z - 0.72 + j * 0.2, 0x23345a, 'glass', 0, -0.35);
      put(b, new THREE.BoxGeometry(0.31, 0.004, 0.004), x - 0.6 + i * 0.36, ya + 0.052, z - 0.72 + j * 0.2, 0xc8d0d8, 'solid', 0, -0.35);
    }
  }
  b.box(0.48, 0.02, 0.98, x - 0.62, yb, z + 0.2, PALETTE.lawn);
  for (let k = 0; k < 4; k++) bush(b, r, x - 0.72 + (k % 2) * 0.2, yb + 0.04, z - 0.1 + k * 0.2, 0.05);
  // Atrium cube at the corner with the logo
  const ax = x - 0.62;
  const az = z - 0.62;
  b.box(0.5, 0.78, 0.5, ax, 0.035, az, 0x8fb0c4, 'glass');
  facade(b, r, rectPts(0.5, 0.5, ax, az), 0.035, null, 0.8, { floors: 2, bay: 0.12, winH: 0.9, winW: 0.92, lit: 0.9, light, tint: TINT.blue });
  b.box(0.54, 0.03, 0.54, ax, 0.815, az, 0xf4f2ee);
  const n = neonOf(b);
  n.cylinder(0.11, 0.11, 0.025, ax, 0.86, az, bright(accent, 1.8), 16, true);
  n.box(0.035, 0.12, 0.035, ax, 0.88, az, bright(accent, 2.4), true);
  // Courtyard: palms, picnic tables with umbrellas, bikes, a sculpture
  palm(b, r, x + 0.75, z + 0.1, 0.7, 0.047);
  palm(b, r, x + 0.1, z + 0.8, 0.7, 0.047);
  for (const [dx, dz] of [[0.35, 0.3], [0.62, 0.62]] as const) {
    b.box(0.14, 0.03, 0.08, x + dx, 0.05, z + dz, PALETTE.wood);
    b.cylinder(0.005, 0.005, 0.16, x + dx, 0.05, z + dz, 0xdddddd, 4);
    b.cylinder(0, 0.09, 0.04, x + dx, 0.2, z + dz, accent, 8);
  }
  for (let k = 0; k < 5; k++) {
    const bx = x + 0.82;
    const bz = z + 0.45 + k * 0.08;
    b.box(0.07, 0.035, 0.008, bx, 0.06, bz, pick(r, [0xf2c84b, 0x3aa36a, 0xe85a4a, 0x2f6fa8] as const));
    put(b, new THREE.TorusGeometry(0.018, 0.004, 4, 10), bx - 0.03, 0.065, bz, 0x222222, 'solid', Math.PI / 2);
    put(b, new THREE.TorusGeometry(0.018, 0.004, 4, 10), bx + 0.03, 0.065, bz, 0x222222, 'solid', Math.PI / 2);
  }
  b.box(0.06, 0.24, 0.06, x + 0.25, 0.047, z + 0.7, accent);
  b.blob(0.07, x + 0.25, 0.33, z + 0.7, accent, 'smooth', 1);
  // Monolith sign at the corner
  b.box(0.3, 0.14, 0.05, x + 0.7, 0.035, z + 0.9, 0x2a2f38);
  neonOf(b).box(0.24, 0.025, 0.004, x + 0.7, 0.11, z + 0.926, neon, true);
  lamp(b, x + 0.9, z + 0.3, 0.035);
  people(b, r, x + 0.4, z + 0.45, 5, 0.7, 0.6, 0.047);
}

/** The neon theatre: a Castro-style picture palace with a blade sign and a chasing marquee. */
export function deco(b: GeoBuilder, r: () => number, x: number, z: number, neon: ColorLike) {
  const wall0 = pick(r, [0xf3c6a2, 0xbfe4d0, 0xf8f0e0, 0xeab6cf, 0xf6df8c] as const);
  const trim = pick(r, [0xd4af37, 0xc87a3a, 0x3fa7a0] as const);
  const dark = 0x3a2f3a;
  const name = pick(r, ['BIJOU', 'ROXIE', 'ASTRA', 'REGENT', 'LUX', 'RIALTO'] as const);
  const n = neonOf(b);
  // Auditorium block behind
  b.box(1.36, 0.95, 1.05, x, 0.035, z - 0.38, shade(wall0, 0.92));
  for (let k = 0; k < 6; k++) {
    for (const s of [-1, 1]) b.box(0.05, 0.9, 0.03, x + s * 0.69, 0.035, z - 0.82 + k * 0.17, shade(wall0, 0.8));
  }
  b.box(1.4, 0.04, 1.09, x, 0.985, z - 0.38, trim);
  b.box(1.3, 0.006, 1.0, x, 1.025, z - 0.38, 0x8e8a84);
  b.box(0.22, 0.1, 0.16, x - 0.35, 1.025, z - 0.6, 0x9aa3ad);
  b.box(0.16, 0.08, 0.14, x + 0.3, 1.025, z - 0.7, 0x9aa3ad);
  // Exit doors and their lamps on the sides and back
  for (const s of [-1, 1]) {
    for (const dz of [-0.75, -0.2]) {
      wall(b, 'solid', x + s * 0.682, 0.13, z + dz, s, 0, 0.1, 0.19, 0x5a3a4a);
      quadBlob(neonOf(b), x + s * 0.69, 0.25, z + dz, 0.01, [2.4, 1.8, 1.0]);
    }
  }
  wall(b, 'solid', x, 0.13, z - 0.906, 0, -1, 0.3, 0.19, 0x5a3a4a);
  wall(b, 'solid', x, 0.62, z - 0.906, 0, -1, 0.8, 0.22, shade(wall0, 0.8));
  pixelText(b, 'solid', name, x, 0.62, z - 0.909, 0, -1, 0.03, trim);
  // Front facade: a tall stepped deco front
  const fz = z + 0.18;
  b.box(1.5, 1.1, 0.14, x, 0.035, fz, wall0);
  b.box(0.8, 0.22, 0.14, x, 1.135, fz, wall0);
  b.box(0.42, 0.18, 0.14, x, 1.355, fz, wall0);
  b.box(0.16, 0.14, 0.14, x, 1.535, fz, trim);
  for (const s of [-1, 1]) {
    b.box(0.08, 1.2, 0.18, x + s * 0.38, 0.035, fz, wall0);
    b.box(0.06, 0.08, 0.2, x + s * 0.38, 1.235, fz, trim);
  }
  // Vertical fluting and a sunburst over the centre
  for (let k = -3; k <= 3; k++) b.box(0.025, 0.42, 0.012, x + k * 0.07, 0.62, fz + 0.075, shade(wall0, 0.85));
  for (let k = 0; k < 7; k++) {
    const a = (k / 6) * Math.PI;
    const g = new THREE.BoxGeometry(0.012, 0.16, 0.01);
    g.translate(0, 0.08, 0);
    put(b, g, x, 1.06, fz + 0.075, trim, 'solid', 0, 0, a - Math.PI / 2);
  }
  // Entrance: glass doors, poster cases, ticket booth
  const fw = winOf(b);
  for (let k = -2; k <= 2; k++) wall(fw, 'glow', x + k * 0.12, 0.14, fz + 0.072, 0, 1, 0.1, 0.2, warmth(r), wr(r, 1, TINT.shop));
  for (const s of [-1, 1]) {
    wall(n, 'glow', x + s * 0.58, 0.18, fz + 0.072, 0, 1, 0.12, 0.18, pick(r, [[2, 1.2, 0.5], [0.6, 1.4, 2], [2, 0.6, 1.2]] as const));
    b.box(0.15, 0.01, 0.02, x + s * 0.58, 0.28, fz + 0.075, trim);
  }
  b.box(0.16, 0.2, 0.12, x, 0.035, fz + 0.2, trim);
  wall(fw, 'glow', x, 0.15, fz + 0.261, 0, 1, 0.1, 0.07, warmth(r), wr(r, 1, TINT.shop));
  b.cylinder(0.1, 0.1, 0.02, x, 0.235, fz + 0.2, dark, 10);
  // Marquee: a deep box over the doors with chasing bulbs and letters
  const my = 0.32;
  const md = 0.32;
  b.box(1.1, 0.16, md, x, my, fz + 0.07 + md / 2, dark);
  b.box(1.14, 0.02, md + 0.04, x, my + 0.16, fz + 0.07 + md / 2, trim);
  const mz = fz + 0.07 + md;
  wall(n, 'glow', x, my + 0.08, mz + 0.003, 0, 1, 1.0, 0.12, [1.9, 1.85, 1.6]);
  pixelText(b, 'solid', 'NOW SHOWING', x, my + 0.085, mz + 0.006, 0, 1, 0.012, 0x1a1a22);
  for (const s of [-1, 1]) {
    wall(n, 'glow', x + s * 0.553, my + 0.08, fz + 0.07 + md / 2, s, 0, md - 0.02, 0.12, [1.9, 1.85, 1.6]);
    pixelText(b, 'solid', name, x + s * 0.556, my + 0.085, fz + 0.07 + md / 2, s, 0, 0.012, 0x1a1a22);
  }
  for (let k = 0; k < 28; k++) {
    const u = (k / 27 - 0.5) * 1.08;
    quadBlob(n, x + u, my + 0.165, mz + 0.012, 0.009, [2.8, 2.2, 1.2], FX.chase + (k % 3) / 3);
    quadBlob(n, x + u, my - 0.004, mz + 0.012, 0.009, [2.8, 2.2, 1.2], FX.chase + ((k + 1) % 3) / 3);
  }
  // The vertical blade sign
  const bx = x + 0.48;
  const bz = fz + 0.3;
  const top = 1.62;
  const bot = 0.56;
  b.box(0.05, top - bot, 0.3, bx, bot, bz, 0xf4f0e6);
  b.box(0.06, 0.03, 0.32, bx, top, bz, trim);
  b.box(0.06, 0.03, 0.32, bx, bot - 0.03, bz, trim);
  const mid = (top + bot) / 2;
  const px = Math.min(0.03, (top - bot - 0.08) / (name.length * 6));
  for (const s of [-1, 1]) {
    pixelText(n, 'glow', name, bx + s * 0.03, mid, bz, s, 0, px, neon, { vertical: true });
  }
  neonRing(b, rectPts(0.05, 0.3, bx, bz), top - 0.01, 0.01, [2.6, 2.3, 1.6]);
  for (let k = 0; k < 12; k++) quadBlob(n, bx, bot + 0.04 + k * ((top - bot - 0.08) / 11), bz + 0.155, 0.009, [2.8, 2.2, 1.2], FX.chase + (k % 3) / 3);
  b.box(0.02, 0.02, 0.2, bx, top - 0.2, fz + 0.12, 0x3a4048);
  // Neon outline along the stepped crown
  neonRing(b, rectPts(0.8, 0.14, x, fz), 1.35, 0.014, neon);
  neonRing(b, rectPts(0.42, 0.14, x, fz), 1.53, 0.014, neon);
  // Sidewalk: stars, a palm, a queue
  b.box(1.9, 0.004, 0.5, x, 0.035, z + 0.7, 0xc9b9a6);
  for (let k = 0; k < 5; k++) b.box(0.05, 0.003, 0.05, x - 0.6 + k * 0.3, 0.039, z + 0.85, 0xd4af37, false, Math.PI / 4);
  palm(b, r, x - 0.82, z + 0.82, 0.7, 0.035);
  palm(b, r, x + 0.84, z - 0.1, 0.7, 0.035);
  people(b, r, x - 0.25, z + 0.6, 6, 0.6, 0.12, 0.035);
  lamp(b, x + 0.8, z + 0.85, 0.035);
}

// ─── HQ: your company, centre of town ──────────────────────────────────────

export interface HQ extends Built {
  beacon: THREE.MeshBasicMaterial;
  sign: THREE.MeshBasicMaterial;
  height: number;
}

/**
 * Your company. `level` is the HQ upgrade bought (0 garage … 4 landmark);
 * `floors` comes from releases, capped by what the level has room for.
 * The block's west corner lot (−1.5, +1.5) is left clear for the founder's home.
 */
export function headquarters(name: string, floors: number, seed: number, level = 1): HQ {
  const r = rng(seed);
  const b = new Kit();
  const brand = pick(r, [0x6ff2ff, 0xff6ad5, 0x9d7bff, 0x5dffa0, 0xffb347] as const);
  const brandGlow = bright(brand, 2.2);
  hqGrounds(b, r, level);
  const signs: SignSpot[] = [];
  let top: number;
  let mast: [number, number] = [-0.55, -0.55];
  const fl = Math.max(1, floors);
  if (level <= 0) {
    top = garage(b, r, signs);
    mast = [-0.25, -0.35];
  } else if (level === 1) {
    top = officeHQ(b, r, fl, signs, brandGlow);
  } else if (level === 2) {
    top = campusHQ(b, r, fl, signs, brandGlow);
  } else if (level === 3) {
    top = towerHQ(b, r, fl, signs, brandGlow);
    mast = [-0.4, -0.4];
  } else {
    top = landmarkHQ(b, r, fl, signs, brandGlow);
    mast = [0, 0];
  }
  if (level > 0) {
    rod(b, mast[0], top, mast[1], mast[0], top + 0.9, mast[1], 0.022, PALETTE.steel, 6, 'solid', 0.01);
    for (let k = 1; k < 4; k++) b.cylinder(0.035, 0.035, 0.01, mast[0], top + k * 0.2, mast[1], PALETTE.steel, 6);
  }
  const built = b.build();

  // Beacon gets its own material so it can pulse on every push.
  const beacon = new THREE.MeshBasicMaterial({ color: new THREE.Color(...bright(0x6ff2ff, 2)) });
  const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.09, 1), beacon);
  orb.position.set(mast[0], level > 0 ? top + 1.0 : top + 0.12, mast[1]);
  built.group.add(orb);

  // The name: backlit letters on the building, a plaque at street level.
  const label = name.trim().slice(0, 22) || 'HQ';
  const tex = nameTexture(label, level === 0 ? 'painted' : 'backlit', brand);
  const material = new THREE.MeshBasicMaterial({ map: tex.texture, transparent: level > 0, depthWrite: level === 0, side: THREE.FrontSide, toneMapped: true });
  material.addEventListener('dispose', () => tex.texture.dispose());
  const boardMat = new THREE.MeshStandardMaterial({ color: 0x1e2430, roughness: 0.5, metalness: 0.3 });
  for (const s of signs) {
    const width = Math.min(s.h * tex.aspect, s.maxW);
    const height = width / tex.aspect;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
    mesh.position.set(s.x, s.y, s.z);
    mesh.rotation.y = s.ry;
    built.group.add(mesh);
    if (s.board) {
      // A slim dark board behind the letters so they read by day
      const board = new THREE.Mesh(new THREE.BoxGeometry(width + 0.06, height + 0.03, 0.025), boardMat);
      board.position.set(s.x - Math.sin(s.ry) * 0.016, s.y, s.z - Math.cos(s.ry) * 0.016);
      board.rotation.y = s.ry;
      board.castShadow = true;
      built.group.add(board);
    }
  }
  built.group.add(plaque(label, brand));

  return { ...built, beacon, sign: material, height: (level > 0 ? top + 1.1 : top + 0.2) };
}

/** Plaza, palms, fountain and lawns; the founder's corner lot stays clear. */
function hqGrounds(b: Kit, r: () => number, level: number) {
  b.box(BLOCK, 0.04, BLOCK, 0, 0, 0, PALETTE.plaza);
  // Paving pattern: a lighter cross and borders
  b.box(BLOCK - 0.1, 0.004, 0.06, 0, 0.04, 1.15, 0xd3ccbd);
  b.box(0.06, 0.004, BLOCK - 0.1, 1.15, 0.04, 0, 0xd3ccbd);
  // Fountain: a basin, a jet, and lights in the water
  b.cylinder(0.36, 0.4, 0.07, 1.35, 0.04, 1.35, 0xcfc8b8, 18);
  b.cylinder(0.32, 0.32, 0.015, 1.35, 0.1, 1.35, PALETTE.pool, 18);
  b.cylinder(0.08, 0.1, 0.12, 1.35, 0.1, 1.35, 0xe8e2d6, 10);
  b.cylinder(0.02, 0.03, 0.12, 1.35, 0.22, 1.35, PALETTE.pool, 6, 'smooth');
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    quadBlob(neonOf(b), 1.35 + Math.cos(a) * 0.24, 0.12, 1.35 + Math.sin(a) * 0.24, 0.014, [0.8, 1.6, 2.4], FX.shimmer + k / 8);
  }
  // Lawns with palms along the street sides
  b.box(0.36, 0.02, 2.4, 1.78, 0.04, -0.5, PALETTE.lawn);
  b.box(2.2, 0.02, 0.36, -0.1, 0.04, -1.78, PALETTE.lawn);
  for (const [tx, tz] of [[1.78, -1.6], [1.78, -0.6], [1.78, 0.4], [-0.6, -1.78], [0.4, -1.78], [-1.6, -1.78]] as const) palm(b, r, tx, tz, 0.95, 0.06);
  for (const [lx, lz] of [[1.8, 1.0], [0.9, 1.8], [-0.6, 1.8], [-1.8, -0.6], [-1.8, 0.4]] as const) lamp(b, lx, lz, 0.04);
  for (const [bx, bz, a] of [[1.0, 1.6, 0], [1.6, 0.9, Math.PI / 2]] as const) bench(b, bx, bz, a, 0.04);
  people(b, r, 0.9, 1.15, level === 0 ? 3 : 8, 1.2, 0.5, 0.04);
}

type SignSpot = { x: number; y: number; z: number; ry: number; h: number; maxW: number; board?: boolean };

/** Level 0: the garage under a painted lady, where it all started. */
function garage(b: Kit, r: () => number, signs: SignSpot[]): number {
  const paint = pick(r, PALETTE.victorian);
  const accent = pick(r, PALETTE.victorian);
  const trim = PALETTE.trim;
  const W = 0.86;
  const D = 1.1;
  const y0 = 0.04;
  const gh = 0.34; // garage storey
  const fh = 0.3;
  const zf = 0.35; // front face
  const zc = zf - D / 2;
  // Driveway and a little front garden
  b.box(0.5, 0.012, 0.5, -0.12, y0, zf + 0.25, 0xa9a397);
  b.box(0.26, 0.02, 0.36, 0.3, y0, zf + 0.2, PALETTE.lawn);
  for (let k = 0; k < 4; k++) bush(b, r, 0.22 + (k % 2) * 0.14, y0 + 0.05, zf + 0.1 + Math.floor(k / 2) * 0.16, 0.04, pick(r, [0x63b347, 0xe86a9a, 0xf2c84b] as const));
  // Body
  b.box(W, gh + fh * 2, D, 0, y0, zc, paint);
  const yTop = y0 + gh + fh * 2;
  // Garage door: half open, light spilling out, a desk inside
  const gw = 0.42;
  const gx = -0.14;
  b.box(gw + 0.06, gh - 0.02, 0.012, gx, y0, zf + 0.004, trim);
  wall(winOf(b), 'glow', gx, y0 + 0.08, zf + 0.012, 0, 1, gw, 0.15, [2.2, 1.6, 0.9], wr(r, 1, TINT.shop));
  b.box(gw, 0.14, 0.02, gx, y0 + 0.16, zf + 0.012, 0xf1ede2);
  for (let k = 0; k < 3; k++) b.box(gw, 0.004, 0.024, gx, y0 + 0.18 + k * 0.04, zf + 0.012, 0xd9d2c2);
  b.box(0.2, 0.06, 0.08, gx, y0, zf - 0.08, PALETTE.wood);
  neonOf(b).box(0.07, 0.04, 0.005, gx - 0.04, y0 + 0.07, zf - 0.11, [0.6, 1.4, 2.2], true);
  neonOf(b).box(0.07, 0.04, 0.005, gx + 0.05, y0 + 0.07, zf - 0.11, [0.6, 1.4, 2.2], true);
  // Entry stairs up the side to the front door
  for (let k = 0; k < 6; k++) b.box(0.16, 0.05, 0.06, 0.28, y0 + k * 0.05, zf + 0.34 - k * 0.06, 0xe8e2d6);
  b.box(0.18, 0.02, 0.12, 0.28, y0 + gh, zf + 0.0, 0xe8e2d6);
  b.box(0.12, 0.2, 0.012, 0.28, y0 + gh + 0.02, zf + 0.004, accent);
  wall(winOf(b), 'glow', 0.28, y0 + gh + 0.17, zf + 0.012, 0, 1, 0.07, 0.05, warmth(r), wr(r, 1, TINT.sky));
  for (const s of [-1, 1]) rod(b, 0.28 + s * 0.09, y0 + 0.05, zf + 0.34, 0.28 + s * 0.09, y0 + gh + 0.08, zf - 0.02, 0.006, trim, 4);
  // Bay window over the garage, two storeys
  const bayW = 0.4;
  const bx = -0.14;
  const bay: XZ[] = [[bx - bayW / 2, zf], [bx + bayW / 2, zf], [bx + bayW / 2 - 0.07, zf + 0.12], [bx - bayW / 2 + 0.07, zf + 0.12]];
  prism(b, bay, y0 + gh, fh * 2, paint);
  for (let f = 0; f < 2; f++) {
    const y = y0 + gh + f * fh;
    prism(b, scalePts(bay, 1.06, 1.06, bx, zf + 0.06), y, 0.02, trim);
    facade(b, r, bay, y + 0.04, null, y + fh - 0.02, { floors: 1, bay: 0.2, winH: 0.75, winW: 0.72, lit: 0.9, light: warmth(r), tint: TINT.sky, edges: (e) => e !== 0, fins: { color: trim, depth: 0.012, width: 0.016 } });
  }
  prism(b, scalePts(bay, 1.1, 1.1, bx, zf + 0.06), y0 + gh + fh * 2, 0.04, trim);
  // Cornice with brackets, then the front gable with fish-scale shingles
  b.box(W + 0.06, 0.05, D + 0.04, 0, yTop, zc, trim);
  for (let k = 0; k < 7; k++) b.box(0.025, 0.05, 0.05, -W / 2 + 0.05 + k * ((W - 0.1) / 6), yTop - 0.05, zf + 0.02, trim);
  b.gable(D + 0.02, 0.32, W, 0, yTop + 0.05, zc, pick(r, [0x5f6c7c, 0x6a5040, 0x4a5560] as const), 0.03, Math.PI / 2);
  const tri = new THREE.Shape([new THREE.Vector2(-W / 2 + 0.03, 0), new THREE.Vector2(W / 2 - 0.03, 0), new THREE.Vector2(0, 0.29)]);
  const tg = new THREE.ExtrudeGeometry(tri, { depth: 0.01, bevelEnabled: false });
  put(b, tg, 0, yTop + 0.05, zf + 0.012, accent);
  wall(winOf(b), 'glow', 0, yTop + 0.14, zf + 0.024, 0, 1, 0.1, 0.08, warmth(r), wr(r, 0.9, TINT.sky));
  rod(b, 0, yTop + 0.37, zf + 0.02, 0, yTop + 0.47, zf + 0.02, 0.008, trim, 4);
  // Side and back windows with trim
  for (const s of [-1, 1]) {
    for (let f = 0; f < 2; f++) {
      for (let k = 0; k < 3; k++) {
        const wz = zc - 0.3 + k * 0.3;
        const wy = y0 + gh + f * fh + 0.15;
        b.box(0.012, 0.16, 0.11, s * (W / 2 + 0.004), wy - 0.08, wz, trim);
        wall(winOf(b), 'glow', s * (W / 2 + 0.012), wy, wz, s, 0, 0.08, 0.13, warmth(r), wr(r, 0.6, TINT.sky));
      }
    }
  }
  for (let k = 0; k < 3; k++) wall(winOf(b), 'glow', -0.25 + k * 0.25, y0 + gh + 0.2, zc - D / 2 - 0.004, 0, -1, 0.09, 0.14, warmth(r), wr(r, 0.6, TINT.sky));
  // Life on the street: bikes, a whiteboard, a moving box, string lights
  for (let k = 0; k < 2; k++) {
    const bx2 = -0.42 + k * 0.08;
    b.box(0.006, 0.04, 0.11, bx2, y0 + 0.03, zf + 0.12, pick(r, [0xe85a4a, 0x2f6fa8] as const));
    for (const s of [-1, 1]) put(b, new THREE.TorusGeometry(0.026, 0.004, 4, 10), bx2, y0 + 0.03, zf + 0.12 + s * 0.045, 0x222222, 'solid', Math.PI / 2);
  }
  b.box(0.2, 0.13, 0.012, 0.05, y0 + 0.1, zf + 0.4, 0xffffff);
  for (const s of [-1, 1]) b.box(0.008, 0.22, 0.008, 0.05 + s * 0.09, y0, zf + 0.4, PALETTE.steel);
  for (let k = 0; k < 3; k++) b.box(0.12 - k * 0.03, 0.004, 0.002, 0.03, y0 + 0.2 - k * 0.025, zf + 0.408, pick(r, [0x2f6fa8, 0xe85a4a, 0x2a2f38] as const));
  b.box(0.08, 0.06, 0.06, -0.4, y0, zf + 0.3, 0xb08a5a, 'solid', 0.4);
  for (let k = 0; k <= 8; k++) quadBlob(neonOf(b), -0.38 + k * 0.06, y0 + gh - 0.02 - Math.sin((k / 8) * Math.PI) * 0.04, zf + 0.06, 0.008, LAMP, FX.shimmer + k * 0.13);
  // The hand-painted sign over the garage
  // Hung from the bay window on two chains, right over the garage door
  const sy = y0 + gh - 0.07;
  b.box(0.44, 0.1, 0.016, gx, sy - 0.05, zf + 0.13, 0x6a4a32);
  for (const s of [-1, 1]) rod(b, gx + s * 0.18, sy + 0.05, zf + 0.13, gx + s * 0.18, sy + 0.07, zf + 0.13, 0.003, 0x3a3f4a, 3);
  signs.push({ x: gx, y: sy, z: zf + 0.139, ry: 0, h: 0.085, maxW: 0.41 });
  rod(b, -0.25, yTop + 0.2, -0.35, -0.25, yTop + 0.5, -0.35, 0.006, PALETTE.steel, 4);
  return yTop + 0.42;
}

/** Level 1: a six-to-eight storey brick-and-glass office. */
function officeHQ(b: Kit, r: () => number, floors: number, signs: SignSpot[], brand: ColorLike): number {
  const fh = 0.24;
  const W = 1.5;
  const D = 1.3;
  const y0 = 0.04;
  const lob = 0.36;
  const brick = pick(r, [0xb5654a, 0xa85a44, 0xc27352] as const);
  const stone = 0xe8e0d0;
  lobby(b, r, rectPts(W - 0.06, D - 0.06), y0, lob, stone, warmth(r));
  canopy(b, 0, D / 2 - 0.03, 0, 1, 0.5, y0 + 0.24, 0x2a2f38);
  canopy(b, W / 2 - 0.03, 0, 1, 0, 0.5, y0 + 0.24, 0x2a2f38);
  const ys = y0 + lob + 0.035;
  const h = floors * fh;
  prism(b, rectPts(W, D), ys, h, brick);
  facade(b, r, rectPts(W, D), ys, null, ys + h, { floors, bay: 0.19, winH: 0.66, winW: 0.66, lit: 0.5, light: officeLight(r), tint: TINT.blue, fins: { color: stone, depth: 0.018, width: 0.02, every: 2 } });
  const top = ys + h;
  prism(b, rectPts(W + 0.08, D + 0.08), top, 0.06, stone);
  // Corner glass bay with brand stripe
  b.box(0.3, h, 0.3, W / 2 - 0.12, ys, D / 2 - 0.12, 0x8fb0c4, 'glass');
  facade(b, r, rectPts(0.3, 0.3, W / 2 - 0.12, D / 2 - 0.12), ys, null, ys + h, { floors, bay: 0.15, winH: 0.84, winW: 0.9, lit: 0.6, light: officeLight(r), tint: TINT.blue, edges: (e) => e === 1 || e === 2 });
  neonOf(b).box(0.31, 0.03, 0.31, W / 2 - 0.12, top - 0.04, D / 2 - 0.12, brand, true);
  // Roof deck
  b.box(0.6, 0.02, 0.5, -0.3, top + 0.06, -0.25, PALETTE.wood);
  for (let k = 0; k < 3; k++) b.cylinder(0, 0.08, 0.04, -0.45 + k * 0.15, top + 0.22, -0.25, pick(r, [0xe85a4a, 0xf4f1ea] as const), 8);
  for (let k = 0; k < 3; k++) b.cylinder(0.004, 0.004, 0.16, -0.45 + k * 0.15, top + 0.08, -0.25, 0xdddddd, 4);
  rooftop(b, r, 0.3, top + 0.06, -0.3, 0.6, 0.5, 0x8f969e, 0);
  // Name on top, angled to the street corner, on a slim frame
  const sy = top + 0.3;
  b.box(1.1, 0.02, 0.02, 0.2, top + 0.06, 0.45, PALETTE.steel, false, Math.PI / 4);
  for (const s of [-1, 1]) b.box(0.02, 0.2, 0.02, 0.2 + s * 0.35, top + 0.06, 0.45 - s * 0.35, PALETTE.steel);
  signs.push({ x: 0.22, y: sy, z: 0.47, ry: Math.PI / 4, h: 0.3, maxW: 1.05, board: true });
  return top + 0.06;
}

/** Level 2: a mid-rise with terraces, low wings with green roofs, a courtyard. */
function campusHQ(b: Kit, r: () => number, floors: number, signs: SignSpot[], brand: ColorLike): number {
  const fh = 0.24;
  const y0 = 0.04;
  const light = officeLight(r);
  const white = 0xf2f0ea;
  // Wings: north and west, clear of the founder's corner
  const wing = (pts: XZ[], n: number) => {
    const h = n * 0.25;
    prism(b, pts, y0, h, 0xa7bfcc, 'glass');
    facade(b, r, pts, y0, null, y0 + h, { floors: n, bay: 0.15, winH: 0.82, winW: 0.9, lit: 0.7, light, tint: TINT.blue, fins: { color: 0xc08a5a, depth: 0.03, width: 0.016 }, bands: { color: white, every: 1, depth: 0.06 } });
    prism(b, scalePts(pts, 1.03), y0 + h, 0.03, white);
    const [cx, cz] = centroid(pts);
    b.box(Math.abs(pts[1]![0] - pts[0]![0]) - 0.06, 0.02, Math.abs(pts[2]![1] - pts[1]![1]) - 0.06, cx, y0 + h + 0.03, cz, PALETTE.lawn);
    return y0 + h + 0.05;
  };
  const yn = wing(rectPts(2.6, 0.6, -0.2, -1.25), 2);
  const yw = wing(rectPts(0.6, 1.5, -1.25, -0.2), 2);
  for (let k = 0; k < 5; k++) bush(b, r, -1.2 + k * 0.45, yn + 0.03, -1.25 + (k % 2 ? 0.1 : -0.12), 0.06);
  for (let k = 0; k < 3; k++) bush(b, r, -1.25 + (k % 2 ? 0.12 : -0.1), yw + 0.03, -0.6 + k * 0.4, 0.06);
  for (let i = 0; i < 4; i++) {
    put(b, new THREE.BoxGeometry(0.28, 0.012, 0.16), 0.4 + i * 0.3, yn + 0.08, -1.25, 0x23345a, 'glass', 0, -0.35);
  }
  // Main building with stepped terraces facing the plaza
  const W = 1.6;
  const lob = 0.4;
  lobby(b, r, rectPts(W - 0.06, W - 0.06, 0.1, 0.1), y0, lob, white, light);
  canopy(b, 0.1, 0.1 + W / 2 - 0.03, 0, 1, 0.6, y0 + 0.26);
  canopy(b, 0.1 + W / 2 - 0.03, 0.1, 1, 0, 0.6, y0 + 0.26);
  let y = y0 + lob + 0.035;
  let w = W;
  let ox = 0.1;
  let oz = 0.1;
  const steps = Math.max(1, Math.ceil(floors / 4));
  let left = floors;
  for (let s = 0; s < steps; s++) {
    const n = Math.min(4, left);
    left -= n;
    const pts = rectPts(w, w, ox, oz);
    const h = n * fh;
    prism(b, pts, y, h, 0xe9e6de);
    facade(b, r, pts, y, null, y + h, { floors: n, bay: 0.16, winH: 0.72, winW: 0.84, lit: 0.6, light, tint: TINT.blue, fins: { color: white, depth: 0.03, width: 0.022 }, bands: { color: white, every: 1, depth: 0.035, h: 0.03 } });
    y += h;
    prism(b, scalePts(pts, 1.02, 1.02, ox, oz), y, 0.035, white);
    if (s < steps - 1) {
      // Terrace garden on the step
      const nw = w - 0.2;
      const nox = ox - 0.1;
      const noz = oz - 0.1;
      b.box(w - 0.04, 0.02, 0.18, ox, y + 0.035, oz + w / 2 - 0.11, PALETTE.lawn);
      b.box(0.18, 0.02, w - 0.04, ox + w / 2 - 0.11, y + 0.035, oz, PALETTE.lawn);
      for (let k = 0; k < 3; k++) bush(b, r, ox - w / 2 + 0.2 + k * 0.45, y + 0.08, oz + w / 2 - 0.1, 0.05);
      neonRing(b, rectPts(w * 1.02, w * 1.02, ox, oz), y + 0.02, 0.01, brand);
      w = nw;
      ox = nox;
      oz = noz;
    }
    y += 0.035;
  }
  const top = y;
  // Roof garden with palms, the sign, a skybridge to the north wing
  b.box(w - 0.12, 0.04, w - 0.12, ox, top, oz, PALETTE.lawn);
  palm(b, r, ox - w / 2 + 0.2, oz + w / 2 - 0.2, 0.5, top + 0.04);
  palm(b, r, ox + w / 2 - 0.2, oz - w / 2 + 0.2, 0.45, top + 0.04);
  b.box(0.4, 0.2, 0.5, -0.4, y0 + 0.5, -0.7, 0x9fb7c6, 'glass');
  b.box(0.42, 0.02, 0.52, -0.4, y0 + 0.7, -0.7, white);
  signs.push({ x: ox + 0.12, y: top + 0.3, z: oz + 0.12, ry: Math.PI / 4, h: 0.3, maxW: 1.05, board: true });
  for (const s of [-1, 1]) b.box(0.02, 0.22, 0.02, ox + 0.12 + s * 0.35, top + 0.04, oz + 0.12 - s * 0.35, PALETTE.steel);
  // Courtyard: lawn, picnic tables, a bright sculpture
  b.box(0.7, 0.012, 0.5, -0.6, y0, 0.7, PALETTE.lawn);
  b.blob(0.08, -0.6, y0 + 0.2, 0.7, brand, 'smooth', 1);
  b.box(0.04, 0.14, 0.04, -0.6, y0, 0.7, 0x2a2f38);
  return top + 0.04;
}

/** Level 3: a chamfered glass tower with fins and a lit crown. */
function towerHQ(b: Kit, r: () => number, floors: number, signs: SignSpot[], brand: ColorLike): number {
  const fh = 0.24;
  const y0 = 0.04;
  const W = 1.7;
  const c = 0.32;
  const light = officeLight(r);
  const lob = 0.5;
  // Podium
  prism(b, chamferPts(2.0, 2.0, 0.5), y0, 0.05, 0xd8d4ca);
  lobby(b, r, chamferPts(W - 0.06, W - 0.06, c), y0 + 0.05, lob, 0xe8ecef, light);
  canopy(b, 0, W / 2 - 0.03, 0, 1, 0.7, y0 + 0.35);
  canopy(b, W / 2 - 0.03, 0, 1, 0, 0.7, y0 + 0.35);
  const ys = y0 + 0.05 + lob + 0.035;
  const h = floors * fh;
  const pts = chamferPts(W, W, c);
  prism(b, pts, ys, h, 0x6f93ad, 'glass');
  facade(b, r, pts, ys, null, ys + h, {
    floors,
    bay: 0.15,
    winH: 0.8,
    winW: 0.9,
    lit: 0.45,
    light,
    tint: TINT.blue,
    fins: { color: 0xe6eaee, depth: 0.03, width: 0.014, every: 2 },
    bands: { color: 0xe6eaee, every: 6, depth: 0.025, h: 0.03 },
  });
  // Brand light lines up the chamfered corners
  for (let e = 1; e < 8; e += 2) {
    const a = pts[e]!;
    const q = pts[(e + 1) % 8]!;
    const mx = (a[0] + q[0]) / 2;
    const mz = (a[1] + q[1]) / 2;
    const l = Math.hypot(mx, mz);
    wall(neonOf(b), 'glow', mx + (mx / l) * 0.008, ys + h / 2, mz + (mz / l) * 0.008, mx, mz, 0.03, h, brand);
  }
  // Crown: a taller glass parapet hiding the plant, with signs on all four sides
  const top = ys + h;
  const crownH = 0.7;
  prism(b, chamferPts(W + 0.04, W + 0.04, c), top, 0.04, 0xe6eaee);
  prism(b, chamferPts(W - 0.1, W - 0.1, c * 0.9), top + 0.04, crownH, 0x2a3442);
  facade(b, r, chamferPts(W - 0.1, W - 0.1, c * 0.9), top + 0.04, null, top + 0.04 + crownH, { floors: 2, bay: 0.12, winH: 0.9, winW: 0.5, lit: 1, light: shade(brand, 0.5), tint: TINT.smoke, edges: (e) => e % 2 === 1 });
  prism(b, chamferPts(W - 0.06, W - 0.06, c * 0.9), top + 0.04 + crownH, 0.04, 0xe6eaee);
  neonRing(b, chamferPts(W - 0.06, W - 0.06, c * 0.9), top + 0.06 + crownH, 0.02, brand);
  for (const [nx, nz] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
    signs.push({ x: nx * ((W - 0.1) / 2 + 0.008), y: top + 0.04 + crownH / 2, z: nz * ((W - 0.1) / 2 + 0.008), ry: Math.atan2(nx, nz), h: crownH * 0.8, maxW: 0.98 });
  }
  // Helipad
  const hy = top + 0.08 + crownH;
  b.cylinder(0.42, 0.42, 0.03, 0.2, hy, 0.2, 0x4a525e, 20);
  flat(b, 'solid', 0.2, hy + 0.032, 0.2, 0.05, 0.22, 0xf4f1ea);
  flat(b, 'solid', 0.2, hy + 0.032, 0.2, 0.18, 0.04, 0xf4f1ea);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    quadBlob(neonOf(b), 0.2 + Math.cos(a) * 0.4, hy + 0.04, 0.2 + Math.sin(a) * 0.4, 0.012, [0.6, 2.4, 0.8], FX.steady);
  }
  return hy + 0.03;
}

/** Level 4: the landmark. A twisting glass tower and a lantern crown with a spire. */
function landmarkHQ(b: Kit, r: () => number, floors: number, signs: SignSpot[], brand: ColorLike): number {
  const fh = 0.24;
  const y0 = 0.04;
  const W = 1.8;
  const light = officeLight(r);
  const lob = 0.6;
  prism(b, chamferPts(2.0, 2.0, 0.55), y0, 0.05, 0xd8d4ca);
  lobby(b, r, roundPts(W - 0.04, W - 0.04, 0.4, 3), y0 + 0.05, lob, 0xe8ecef, light);
  canopy(b, 0, W / 2 - 0.02, 0, 1, 0.8, y0 + 0.42);
  canopy(b, W / 2 - 0.02, 0, 1, 0, 0.8, y0 + 0.42);
  // Twisting shaft: modules of three floors, each turned a little more, shrinking slightly
  let y = y0 + 0.05 + lob + 0.035;
  const modules = Math.max(1, Math.ceil(floors / 3));
  const twist = Math.PI / 4 / Math.max(6, modules - 1);
  let left = floors;
  let k = 1;
  for (let m = 0; m < modules; m++) {
    const n = Math.min(3, left);
    left -= n;
    k = 1 - (m / Math.max(8, modules)) * 0.18;
    const a = m * twist;
    const base = chamferPts(W * k, W * k, 0.42 * k);
    const pts = base.map(([px, pz]) => [px * Math.cos(a) - pz * Math.sin(a), px * Math.sin(a) + pz * Math.cos(a)] as XZ);
    const h = n * fh;
    prism(b, pts, y, h, 0x7aa0bd, 'glass');
    facade(b, r, pts, y, null, y + h, { floors: n, bay: 0.15, winH: 0.84, winW: 0.9, lit: 0.45, light, tint: TINT.blue, fins: { color: 0xeef1f4, depth: 0.022, width: 0.012, every: 2 } });
    prism(b, scalePts(pts, 1.025), y + h - 0.01, 0.025, 0xeef1f4);
    y += h;
  }
  // A dark band at the top of the shaft carries the name on all four sides
  const bw = W * k * 0.9;
  prism(b, roundPts(bw, bw, 0.28, 3), y, 0.48, 0x1e2530);
  prism(b, roundPts(bw + 0.05, bw + 0.05, 0.3, 3), y + 0.48, 0.035, 0xeef1f4);
  neonRing(b, roundPts(bw + 0.05, bw + 0.05, 0.3, 3), y + 0.5, 0.012, brand);
  for (const [nx, nz] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
    signs.push({ x: nx * (bw / 2 + 0.006), y: y + 0.24, z: nz * (bw / 2 + 0.006), ry: Math.atan2(nx, nz), h: 0.38, maxW: bw - 0.6 });
  }
  const top = y + 0.515;
  // Lantern crown: a glowing glass drum inside a lattice, signs around it, a spire
  const cr = W * k * 0.42;
  const crownH = 1.1;
  b.cylinder(cr * 0.9, cr * 1.05, crownH, 0, top, 0, 0x2a3442, 16);
  const cw = winOf(b);
  for (let j = 0; j < 16; j++) {
    const a = (j / 16) * Math.PI * 2;
    for (let f = 0; f < 3; f++) {
      const t = (f + 0.5) / 3;
      const rr = cr * 1.05 + (cr * 0.9 - cr * 1.05) * t + 0.004;
      wall(cw, 'glow', Math.cos(a) * rr, top + t * crownH, Math.sin(a) * rr, Math.cos(a), Math.sin(a), rr * 0.32, crownH / 3 - 0.06, shade(brand, 0.7), wr(r, 1, TINT.smoke));
    }
  }
  const ring = (y2: number, rr: number) => {
    b.cylinder(rr, rr, 0.03, 0, y2, 0, 0xeef1f4, 24);
    neonOf(b).cylinder(rr + 0.004, rr + 0.004, 0.01, 0, y2 + 0.01, 0, brand, 24, true);
  };
  for (let j = 0; j < 12; j++) {
    const a = (j / 12) * Math.PI * 2;
    beam(b, Math.cos(a) * (cr + 0.12), top, Math.sin(a) * (cr + 0.12), Math.cos(a) * 0.06, top + crownH + 0.9, Math.sin(a) * 0.06, 0.02, 0xeef1f4);
  }
  ring(top, cr + 0.12);
  ring(top + crownH * 0.5, cr * 0.82 + 0.06);
  ring(top + crownH, cr * 0.55);
  const spireTop = top + crownH + 1.6;
  rod(b, 0, top + crownH, 0, 0, spireTop, 0, 0.05, 0xeef1f4, 8, 'smooth', 0.008);
  quadBlob(neonOf(b), 0, spireTop + 0.02, 0, 0.04, RED_LIGHT, FX.blink + 0.25);
  return spireTop - 0.9;
}

/** The company name as a texture: backlit letters, or hand-painted for the garage. */
function nameTexture(text: string, style: 'backlit' | 'painted', brand: number): { texture: THREE.CanvasTexture; aspect: number } {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const painted = style === 'painted';
  const font = painted ? 'italic 700 92px Georgia, "Times New Roman", serif' : '700 96px "Space Grotesk", "Avenir Next", system-ui, sans-serif';
  ctx.font = font;
  const tw = ctx.measureText(text).width;
  canvas.width = Math.ceil(tw + (painted ? 120 : 90));
  canvas.height = 160;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cx = canvas.width / 2;
  const cy = canvas.height / 2 + 4;
  const hex = `#${new THREE.Color(brand).getHexString()}`;
  if (painted) {
    ctx.fillStyle = '#f1e4c2';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#7a2a1c';
    ctx.lineWidth = 10;
    ctx.strokeRect(14, 14, canvas.width - 28, canvas.height - 28);
    ctx.fillStyle = '#2a1a14';
    ctx.fillText(text, cx + 3, cy + 3);
    ctx.fillStyle = '#b8321e';
    ctx.fillText(text, cx, cy);
  } else {
    // Halo: the letters' glow on the wall behind, then crisp faces with a thin rim
    ctx.shadowColor = hex;
    ctx.shadowBlur = 28;
    ctx.fillStyle = hex;
    ctx.fillText(text, cx, cy);
    ctx.shadowBlur = 10;
    ctx.fillText(text, cx, cy);
    ctx.shadowBlur = 0;
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(20,24,32,0.85)';
    ctx.strokeText(text, cx, cy);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, cx, cy);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return { texture, aspect: canvas.width / canvas.height };
}

/** A granite plaque with brass letters at the plaza corner. */
function plaque(text: string, brand: number): THREE.Group {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  canvas.width = 512;
  canvas.height = 160;
  ctx.fillStyle = '#2b2f36';
  ctx.fillRect(0, 0, 512, 160);
  ctx.strokeStyle = '#c9a85a';
  ctx.lineWidth = 6;
  ctx.strokeRect(10, 10, 492, 140);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let size = 64;
  const font = (s: number) => `700 ${s}px "Space Grotesk", "Avenir Next", system-ui, sans-serif`;
  ctx.font = font(size);
  while (ctx.measureText(text).width > 450 && size > 20) ctx.font = font((size -= 4));
  ctx.fillStyle = '#e8d7a0';
  ctx.fillText(text, 256, 72);
  ctx.font = '600 22px "Space Grotesk", system-ui, sans-serif';
  ctx.fillStyle = `#${new THREE.Color(brand).getHexString()}`;
  ctx.fillText('HEADQUARTERS', 256, 126);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const face = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.5, emissive: 0xffffff, emissiveMap: texture, emissiveIntensity: 0.35 });
  face.addEventListener('dispose', () => texture.dispose());
  const stone = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.45, metalness: 0.2 });
  const g = new THREE.Group();
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.03, 0.12), new THREE.MeshStandardMaterial({ color: 0xcfc8b8, roughness: 0.8 }));
  plinth.position.y = 0.015;
  const block = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.15, 0.06), stone);
  block.position.y = 0.105;
  block.castShadow = plinth.castShadow = true;
  g.add(plinth, block);
  for (const s of [1, -1]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.13), face);
    m.position.set(0, 0.105, s * 0.0305);
    m.rotation.y = s > 0 ? 0 : Math.PI;
    g.add(m);
  }
  g.position.set(0.95, 0.04, 0.95);
  g.rotation.y = Math.PI / 4;
  return g;
}
