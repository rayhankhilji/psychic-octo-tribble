import * as THREE from 'three';
import { FLAT_RAND, GeoBuilder, GLOW, LIGHT_POINTS, LIGHTS_OUT, pointRand, trackViewport, type ColorLike } from './geo.ts';
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

/**
 * `parts`: the rand is one value per part (a window, a bulb), so it is passed
 * flat (see FLAT_RAND) and light points keep a minimum size (LIGHT_POINTS).
 */
function lit(key: string, decl: string, body: string, params: THREE.MeshBasicMaterialParameters = {}, parts = true): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ vertexColors: true, ...params });
  const rand = parts ? FLAT_RAND : 'varying float vRand;';
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = GLOW.night;
    shader.uniforms.uTime = GLOW.time;
    shader.uniforms.uDay = GLOW.day;
    shader.uniforms.uViewH = GLOW.viewH;
    shader.vertexShader = parts
      ? shader.vertexShader
          .replace('void main() {', `attribute float winRand;\n${rand}\n${LIGHT_POINTS.decl}\nvarying vec3 vP;\nvoid main() {\n\tvP = position;`)
          .replace('#include <begin_vertex>', LIGHT_POINTS.vertex)
      : shader.vertexShader.replace('void main() {', `attribute float winRand;\n${rand}\nvarying vec3 vP;\nvoid main() {\n\tvRand = winRand;\n\tvP = position;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `uniform float uNight;\nuniform float uTime;\nuniform vec3 uDay;\n${rand}\nvarying vec3 vP;\n${parts ? 'varying float vDim;' : ''}\n${LIGHTS_OUT}\n${decl}\nvoid main() {`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${body}${parts ? '\ndiffuseColor.rgb *= vDim;' : ''}`);
  };
  if (parts) trackViewport(m);
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
    on *= 1.0 - lightsOut(f, uTime) * step(0.1, f) * step(f, 1.5);
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
    // Nothing here switches hard: a light that jumps between two levels from one frame to the
    // next reads as a fault, and at 30 fps a short flash lands on one frame or none.
    if (vRand > 2.5 && vRand < 4.0) {
      // Chase: a soft wave running along the bulbs (each carries its place in the run as phase).
      float wave = 0.5 + 0.5 * cos(6.2832 * (uTime * 0.7 - ph));
      on = 0.35 + 0.65 * wave * wave;
    } else if (vRand >= 4.0 && vRand < 6.0) {
      // Aviation lights: one slow beat across the city (every two seconds, two groups half a beat
      // apart), a quick rise and a slower fade like a real lamp, never a strobe.
      float x = fract(uTime * 0.5 + step(0.5, ph) * 0.5);
      on = 0.06 + 0.94 * smoothstep(0.0, 0.05, x) * (1.0 - smoothstep(0.2, 0.42, x));
    } else if (vRand >= 6.0) on = 0.88 + 0.12 * sin(uTime * 1.3 + ph * 40.0);
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
    // The screen's rand runs across each panel (it is the LED column), so it must interpolate.
    false,
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

/**
 * A fin or slat standing proud of a wall: like `obox`, but only the faces
 * the camera can ever see (front, both sides, top). The back sits against
 * the wall and the camera never looks up at the bottom, so this is 8
 * triangles instead of 12. Y is the fin's long axis, Z points out of the wall.
 */
export function fin(b: GeoBuilder, cx: number, cy: number, cz: number, yx: number, yy: number, yz: number, zx: number, zy: number, zz: number, w: number, len: number, d: number, color: ColorLike, bucket: Bucket = 'solid') {
  const Y = va.set(yx, yy, yz).normalize();
  const Z = vb.set(zx, zy, zz);
  Z.addScaledVector(Y, -Z.dot(Y)).normalize();
  const X = vc.crossVectors(Y, Z).normalize();
  const [Xx, Xy, Xz, Yx, Yy, Yz, Zx, Zy, Zz] = [X.x, X.y, X.z, Y.x, Y.y, Y.z, Z.x, Z.y, Z.z];
  quad3(b, bucket, cx + (Zx * d) / 2, cy + (Zy * d) / 2, cz + (Zz * d) / 2, Xx, Xy, Xz, Yx, Yy, Yz, w, len, color);
  for (const s of [-1, 1]) quad3(b, bucket, cx + (s * Xx * w) / 2, cy + (s * Xy * w) / 2, cz + (s * Xz * w) / 2, -s * Zx, -s * Zy, -s * Zz, Yx, Yy, Yz, d, len, color);
  quad3(b, bucket, cx + (Yx * len) / 2, cy + (Yy * len) / 2, cz + (Yz * len) / 2, Xx, Xy, Xz, -Zx, -Zy, -Zz, w, d, color);
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

/** A round rod from a to c. `open` leaves off the end caps: right for thin struts, chains and wires whose ends meet something. */
export function rod(b: GeoBuilder, ax: number, ay: number, az: number, cx: number, cy: number, cz: number, r: number, color: ColorLike, segments = 5, bucket: Bucket = 'solid', r2 = r, open = false) {
  va.set(cx - ax, cy - ay, cz - az);
  const len = va.length();
  if (len < 1e-6) return;
  qt.setFromUnitVectors(UP, va.normalize());
  const g = new THREE.CylinderGeometry(r2, r, len, segments, 1, open);
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
        fin(b, (lo[0] + hi[0]) / 2 + (hx * d) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2 + (hz * d) / 2, hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], hx, 0, hz, fw, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]), d, o.fins.color, o.fins.bucket ?? 'solid');
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
  // A light point: each vertex's normal points out from the centre and the rand carries the
  // radius, so the shader can keep it from shrinking below a pixel (see LIGHT_POINTS).
  const w = pointRand(r, rand);
  for (const f of F) {
    for (const i of f) {
      const v = P[i]!;
      q.p.push(x + v[0]!, y + v[1]!, z + v[2]!);
      q.n.push(v[0]! / r, v[1]! / r, v[2]! / r);
      q.c.push(cr, cg, cb);
      q.w.push(w);
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

/**
 * A box standing on y without its bottom, which nothing can see: 10 triangles
 * (8 with `top = false`, for a post under a beam or legs under a body).
 * Batched on a Kit; a plain builder gets an ordinary box.
 */
export function post(b: GeoBuilder, w: number, h: number, d: number, x: number, y: number, z: number, color: ColorLike, rotY = 0, top = true) {
  if (!(b instanceof Kit)) {
    b.box(w, h, d, x, y, z, color, false, rotY);
    return;
  }
  const c = Math.cos(rotY);
  const s = Math.sin(rotY);
  // Local +x turns to (c, 0, −s) and local +z to (s, 0, c), as Object3D.rotateY does.
  for (const [lx, lz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const nx = lx * c + lz * s;
    const nz = -lx * s + lz * c;
    const off = lx ? w / 2 : d / 2;
    wall(b, 'solid', x + nx * off, y + h / 2, z + nz * off, nx, nz, lx ? d : w, h, color);
  }
  if (top) flat(b, 'solid', x, y + h, z, w, d, color, rotY);
}

const OCTA = new THREE.OctahedronGeometry(1);
// Normals straight out from the centre, so eight faces shade like a ball (a stock
// octahedron, like a stock icosahedron, comes flat-shaded).
OCTA.setAttribute('normal', OCTA.attributes.position!.clone());

/** A little round head (or ball, bulb, balloon): a smooth-shaded octahedron, 8 triangles. */
export function ball(b: GeoBuilder, rad: number, x: number, y: number, z: number, color: ColorLike, bucket: Bucket = 'smooth', sy = 1) {
  const g = OCTA.clone();
  g.scale(rad, rad * sy, rad);
  g.translate(x, y, z);
  b.transformed(g, new THREE.Matrix4(), color, bucket);
}

/** A small crowd: little figures in bright clothes. 26 triangles each. */
export function people(b: GeoBuilder, r: () => number, x: number, z: number, n: number, sx: number, sz: number, y = 0) {
  const clothes = [0xe85a4a, 0x2f6fa8, 0xf2c84b, 0x3aa36a, 0xf4f1ea, 0x2a2f38, 0xd86aa8, 0x7a5ac8] as const;
  const skin = [0xf1c6a0, 0xd9a07a, 0xa8714f, 0x6e4a32, 0xf5d5b5] as const;
  for (let i = 0; i < n; i++) {
    const px = x + (r() - 0.5) * sx;
    const pz = z + (r() - 0.5) * sz;
    const h = 0.05 + r() * 0.012;
    post(b, 0.022, h * 0.45, 0.016, px, y, pz, 0x3a3f4a, r() * 3, false);
    post(b, 0.026, h * 0.38, 0.018, px, y + h * 0.45, pz, pick(r, clothes), r() * 3);
    ball(b, 0.011, px, y + h * 0.9, pz, pick(r, skin));
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

// ─── Kit: rooftops ─────────────────────────────────────────────────────────
//
// Roofs are what the iso camera sees most, so every flat roof gets the kit a
// real one has: a membrane inside a parapet with a coping, plant (AC units,
// ducts, vents, a stair house, sometimes a water tank), and on the nicer
// buildings a terrace with people. All plain buckets, so it all batches.

export const ROOF_MEMBRANE = 0xa29e96;
const MECH = 0xd3d7db;
const MECH_SHADE = 0xb7bdc3;
const GRILLE = 0x4a5059;

/** Offsets a convex footprint inwards by `t` (a parapet's inner edge). */
export function insetPts(pts: readonly XZ[], t: number): XZ[] {
  const n = pts.length;
  const ccw = area(pts) > 0;
  const lines = pts.map((p, i) => {
    const q = pts[(i + 1) % n]!;
    const dx = q[0] - p[0];
    const dz = q[1] - p[1];
    const l = Math.hypot(dx, dz) || 1;
    // Inward normal: left of the edge for a counter-clockwise ring (in x, z)
    const nx = ccw ? -dz / l : dz / l;
    const nz = ccw ? dx / l : -dx / l;
    return { px: p[0] + nx * t, pz: p[1] + nz * t, dx, dz };
  });
  return lines.map((a, i) => {
    const c = lines[(i + n - 1) % n]!;
    // Intersect the previous edge's offset line with this one's
    const den = c.dx * a.dz - c.dz * a.dx;
    if (Math.abs(den) < 1e-9) return [a.px, a.pz] as XZ;
    const s = ((a.px - c.px) * a.dz - (a.pz - c.pz) * a.dx) / den;
    return [c.px + c.dx * s, c.pz + c.dz * s] as XZ;
  });
}

/** A wall ring: the footprint `outer` minus `inner`, extruded (parapets, balconies, rims). */
export function ringPrism(b: GeoBuilder, outer: readonly XZ[], inner: readonly XZ[], y: number, h: number, color: ColorLike, bucket: Bucket = 'solid') {
  const shape = new THREE.Shape(outer.map(([px, pz]) => new THREE.Vector2(px, -pz)));
  shape.holes.push(new THREE.Path(inner.map(([px, pz]) => new THREE.Vector2(px, -pz))));
  const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 1 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  b.transformed(g, new THREE.Matrix4(), color, bucket);
}

/**
 * A flat roof on a footprint at height y: the membrane, a parapet `h` tall
 * and `t` thick, and a coping that oversails it a little.
 */
export function roofEdge(b: GeoBuilder, pts: readonly XZ[], y: number, color: ColorLike, coping: ColorLike = 0xeeeeea, h = 0.06, t = 0.035) {
  const inner = insetPts(pts, t);
  prism(b, inner, y, 0.004, ROOF_MEMBRANE);
  ringPrism(b, pts, inner, y, h, color);
  ringPrism(b, insetPts(pts, -0.008), insetPts(pts, t + 0.006), y + h, 0.016, coping);
}

/** A rooftop condenser: a louvred box with two fans on top. Long side along local x. */
export function acUnit(b: GeoBuilder, x: number, y: number, z: number, s = 1, rotY = 0) {
  const w = 0.13 * s;
  const h = 0.07 * s;
  const d = 0.09 * s;
  const c = Math.cos(rotY);
  const sn = Math.sin(rotY);
  b.box(w, h, d, x, y, z, MECH, false, rotY);
  b.box(w + 0.01 * s, 0.012 * s, d + 0.01 * s, x, y, z, MECH_SHADE, false, rotY);
  for (const k of [-1, 1]) {
    const fx = x + c * k * w * 0.25;
    const fz = z - sn * k * w * 0.25;
    flat(b, 'solid', fx, y + h + 0.001, fz, 0.048 * s, 0.048 * s, GRILLE, rotY);
    quad3(b, 'solid', fx, y + h + 0.002, fz, 1, 0, 0, 0, 0, -1, 0.012 * s, 0.012 * s, 0x9aa3ad);
    // Louvres along both long sides
    wall(b, 'solid', x + sn * k * (d / 2 + 0.001), y + h * 0.55, z + c * k * (d / 2 + 0.001), sn * k, c * k, w * 0.82, h * 0.55, MECH_SHADE);
  }
}

/** A mushroom vent. */
export function vent(b: GeoBuilder, x: number, y: number, z: number, s = 1) {
  b.cylinder(0.012 * s, 0.012 * s, 0.05 * s, x, y, z, 0xb3b9bf, 6);
  b.cylinder(0.024 * s, 0.018 * s, 0.014 * s, x, y + 0.05 * s, z, 0x8f979f, 6);
}

/** A wooden water tank on a steel stand, like on every old SoMa roof. */
export function waterTank(b: GeoBuilder, x: number, y: number, z: number, s = 1) {
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) post(b, 0.012 * s, 0.16 * s, 0.012 * s, x + dx * 0.07 * s, y, z + dz * 0.07 * s, 0x2b3038, 0, false);
  b.box(0.18 * s, 0.01 * s, 0.18 * s, x, y + 0.16 * s, z, 0x2b3038);
  // The staves, the hoops and the cap are open tubes: their ends sit on the deck or under the cap
  tube(b, 0.1 * s, 0.1 * s, 0.18 * s, x, y + 0.17 * s, z, 0x8a6446, 10);
  for (let k = 0; k < 3; k++) tube(b, 0.103 * s, 0.103 * s, 0.006 * s, x, y + (0.2 + k * 0.05) * s, z, 0x2b3038, 10);
  tube(b, 0.005, 0.11 * s, 0.08 * s, x, y + 0.35 * s, z, 0x6a4a34, 10);
}

/** A cylinder resting on y without its end caps, for parts whose ends are hidden (2 triangles a segment). */
export function tube(b: GeoBuilder, rTop: number, rBottom: number, h: number, x: number, y: number, z: number, color: ColorLike, segments = 8, bucket: Bucket = 'solid') {
  const g = new THREE.CylinderGeometry(rTop, rBottom, h, segments, 1, true);
  g.translate(x, y + h / 2, z);
  b.transformed(g, new THREE.Matrix4(), color, bucket);
}

/** A stair house (roof access) with its door facing (nx, nz). */
export function stairHouse(b: GeoBuilder, x: number, y: number, z: number, w: number, d: number, h: number, nx: number, nz: number, color: ColorLike = 0xd9d6cf) {
  b.box(w, h, d, x, y, z, color);
  b.box(w + 0.02, 0.014, d + 0.02, x, y + h, z, shade(color, 0.78));
  const off = Math.abs(nz) > 0.5 ? d / 2 : w / 2;
  wall(b, 'solid', x + nx * (off + 0.002), y + 0.055, z + nz * (off + 0.002), nx, nz, 0.05, 0.1, 0x45505c);
  quadBlob(neonOf(b), x + nx * (off + 0.006), y + 0.12, z + nz * (off + 0.006), 0.007, LAMP);
}

/**
 * Plant on a flat roof, laid out in a w × d zone centred on (x, z): a row
 * of condensers on a duct, vents, a stair house, sometimes a water tank.
 * `level` 0 is a light scatter, 2 is a big office's plant deck.
 */
export function roofPlant(b: GeoBuilder, r: () => number, x: number, y: number, z: number, w: number, d: number, level = 1, tank = false) {
  const along = w >= d; // the row runs along the longer side
  const L = along ? w : d;
  const S = along ? d : w;
  const P = (u: number, v: number): [number, number] => (along ? [x + u, z + v] : [x + v, z + u]);
  const rot = along ? 0 : Math.PI / 2;
  const units = Math.max(1, Math.min(level + 2, Math.floor((L - 0.1) / 0.16)));
  const v0 = -S / 2 + 0.08;
  // The duct the condensers sit on
  const [dx, dz] = P(-L / 2 + 0.05 + (units * 0.16) / 2, v0 + 0.07);
  b.box(along ? units * 0.16 : 0.03, 0.025, along ? 0.03 : units * 0.16, dx, y, dz, MECH_SHADE);
  for (let k = 0; k < units; k++) {
    const [ax, az] = P(-L / 2 + 0.13 + k * 0.16, v0 + 0.02);
    acUnit(b, ax, y, az, 1, rot);
  }
  if (level >= 1 && S > 0.32) {
    // A second, bigger air handler with its duct running back into the roof
    const [hx, hz] = P(L / 2 - 0.16, -S / 2 + 0.14);
    b.box(along ? 0.22 : 0.16, 0.11, along ? 0.16 : 0.22, hx, y, hz, MECH);
    for (let k = 0; k < 3; k++) {
      const [lx, lz] = P(L / 2 - 0.16, -S / 2 + 0.14 + 0.081);
      const u = (k - 1) * 0.05;
      wall(b, 'solid', lx + (along ? u : 0) + (along ? 0 : 0.0) , y + 0.06, lz + (along ? 0 : u), along ? 0 : 1, along ? 1 : 0, 0.035, 0.07, GRILLE);
    }
    const [ex, ez] = P(L / 2 - 0.16, -S / 2 + 0.3);
    b.box(along ? 0.06 : 0.12, 0.05, along ? 0.12 : 0.06, ex, y, ez, MECH_SHADE);
  }
  // Vents dotted about
  const nv = 2 + level;
  for (let k = 0; k < nv; k++) {
    const [vx, vz] = P((r() - 0.5) * (L - 0.2), (r() * 0.5 + 0.1) * (S / 2 - 0.06));
    vent(b, vx, y, vz, 0.9 + r() * 0.3);
  }
  if (level >= 1) {
    const [sx, sz] = P(-L / 2 + 0.12, S / 2 - 0.13);
    stairHouse(b, sx, y, sz, along ? 0.16 : 0.13, along ? 0.13 : 0.16, 0.14, along ? 1 : 0, along ? 0 : 1);
  }
  if (tank) {
    const [tx, tz] = P(L / 2 - 0.16, S / 2 - 0.16);
    waterTank(b, tx, y, tz, 0.75);
  }
}

/** A rooftop helipad: a dark disc with the yellow ring, the H, edge lights and a windsock. */
export function helipad(b: GeoBuilder, x: number, y: number, z: number, rad: number, lights: ColorLike = [0.6, 2.4, 0.8]) {
  b.cylinder(rad, rad, 0.03, x, y, z, 0x4a525e, 20);
  b.cylinder(rad + 0.03, rad + 0.03, 0.012, x, y, z, 0x3a3f4a, 20);
  const yy = y + 0.031;
  const ring = new THREE.RingGeometry(rad * 0.78, rad * 0.86, 24);
  put(b, ring, x, yy, z, 0xf2c84b, 'solid', 0, -Math.PI / 2);
  const s = rad / 0.42;
  flat(b, 'solid', x - 0.07 * s, yy + 0.001, z, 0.03 * s, 0.24 * s, 0xf4f1ea);
  flat(b, 'solid', x + 0.07 * s, yy + 0.001, z, 0.03 * s, 0.24 * s, 0xf4f1ea);
  flat(b, 'solid', x, yy + 0.001, z, 0.14 * s, 0.03 * s, 0xf4f1ea);
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    quadBlob(neonOf(b), x + Math.cos(a) * (rad + 0.012), y + 0.035, z + Math.sin(a) * (rad + 0.012), 0.011, lights, k % 2 ? FX.steady : FX.blink + k / 10);
  }
  // Windsock on a short mast at the edge
  const wx = x + rad * 0.95;
  const wz = z - rad * 0.4;
  rod(b, wx, y, wz, wx, y + 0.16, wz, 0.004, 0xd8dce0, 4);
  rod(b, wx, y + 0.15, wz, wx - 0.07, y + 0.14, wz - 0.03, 0.012, 0xff7a2a, 6, 'solid', 0.006);
}

/** A ping-pong table (every startup roof has one). */
export function pingPong(b: GeoBuilder, x: number, y: number, z: number, rotY = 0) {
  b.box(0.15, 0.008, 0.085, x, y + 0.05, z, 0x2f6a8a, false, rotY);
  b.box(0.15, 0.002, 0.004, x, y + 0.058, z, 0xf4f1ea, false, rotY);
  b.box(0.004, 0.014, 0.09, x, y + 0.058, z, 0xe8e8e4, false, rotY);
  for (const s of [-1, 1]) b.box(0.01, 0.05, 0.07, x + Math.cos(rotY) * s * 0.055, y, z - Math.sin(rotY) * s * 0.055, 0x2a2f38, false, rotY);
}

/** A sun lounger (local x along its length). */
export function lounger(b: GeoBuilder, x: number, y: number, z: number, rotY = 0, color: ColorLike = 0xf4f1ea) {
  const c = Math.cos(rotY);
  const s = Math.sin(rotY);
  b.box(0.1, 0.012, 0.04, x, y + 0.02, z, color, false, rotY);
  put(b, new THREE.BoxGeometry(0.045, 0.01, 0.04), x - c * 0.06, y + 0.04, z + s * 0.06, color, 'solid', rotY, 0, 0.6);
}

/** A café umbrella over a small table. */
export function parasol(b: GeoBuilder, x: number, y: number, z: number, color: ColorLike, rad = 0.08) {
  b.cylinder(0.03, 0.03, 0.006, x, y + 0.045, z, 0xf4f1ea, 8);
  b.cylinder(0.003, 0.003, 0.15, x, y, z, 0xe8e2d6, 4);
  b.cylinder(0, rad, 0.035, x, y + 0.13, z, color, 8);
}

/**
 * A roof terrace in a w × d zone: timber deck, a glass balustrade on the
 * open sides, planters, seats under parasols, people, and string lights.
 * `rail` picks which sides get the balustrade (x+, x-, z+, z-).
 */
export function roofTerrace(b: GeoBuilder, r: () => number, x: number, y: number, z: number, w: number, d: number, accent: ColorLike, rail: readonly Facing4[] = ['x+', 'z+'], crowd = 4) {
  b.box(w, 0.012, d, x, y, z, PALETTE.wood);
  for (let k = 1; k < Math.round(d / 0.06); k++) flat(b, 'solid', x, y + 0.0125, z - d / 2 + k * 0.06, w - 0.01, 0.003, shade(PALETTE.wood, 0.82));
  const yy = y + 0.012;
  for (const f of rail) {
    const ax = f[0] === 'x';
    const s = f[1] === '+' ? 1 : -1;
    const len = ax ? d : w;
    const px = ax ? x + s * (w / 2 - 0.01) : x;
    const pz = ax ? z : z + s * (d / 2 - 0.01);
    b.box(ax ? 0.008 : len, 0.07, ax ? len : 0.008, px, yy, pz, 0x9fc4d4, 'glass');
    b.box(ax ? 0.014 : len + 0.006, 0.008, ax ? len + 0.006 : 0.014, px, yy + 0.07, pz, 0xe8ecef);
  }
  // Planters along the back, seats under parasols, people
  const n = Math.max(1, Math.round(w / 0.3));
  for (let k = 0; k < n; k++) planter(b, r, x - w / 2 + (k + 0.5) * (w / n), z - d / 2 + 0.05, Math.min(0.16, w / n - 0.04), 0.06, yy, 0x3a3f4a);
  const seats = Math.max(1, Math.round((w * d) / 0.18));
  for (let k = 0; k < Math.min(seats, 3); k++) {
    const sx = x - w / 2 + ((k + 0.5) / Math.min(seats, 3)) * w;
    parasol(b, sx, yy, z + d * 0.12, k % 2 ? accent : 0xf4f1ea);
  }
  people(b, r, x, z + d * 0.05, crowd, w * 0.7, d * 0.5, yy);
}
export type Facing4 = 'x+' | 'x-' | 'z+' | 'z-';

// ─── Kit: signage ──────────────────────────────────────────────────────────
//
// A 5 × 7 font for anything big enough to read at a glance (rooftop letters,
// logo boards, marquees). The 3 × 5 `pixelText` stays for the tiny stuff.

const FONT7: Record<string, string> = {
  A: '01110100011000111111100011000110001', B: '11110100011000111110100011000111110', C: '01110100011000010000100001000101110',
  D: '11110100011000110001100011000111110', E: '11111100001000011110100001000011111', F: '11111100001000011110100001000010000',
  G: '01110100011000010111100011000101111', H: '10001100011000111111100011000110001', I: '01110001000010000100001000010001110',
  J: '00111000100001000010000101001001100', K: '10001100101010011000101001001010001', L: '10000100001000010000100001000011111',
  M: '10001110111010110101100011000110001', N: '10001100011100110101100111000110001', O: '01110100011000110001100011000101110',
  P: '11110100011000111110100001000010000', Q: '01110100011000110001101011001001101', R: '11110100011000111110101001001010001',
  S: '01111100001000001110000010000111110', T: '11111001000010000100001000010000100', U: '10001100011000110001100011000101110',
  V: '10001100011000110001100010101000100', W: '10001100011000110101101011010101010', X: '10001100010101000100010101000110001',
  Y: '10001100010101000100001000010000100', Z: '11111000010001000100010001000011111',
  '0': '01110100011001110101110011000101110', '1': '00100011000010000100001000010001110', '2': '01110100010000100010001000100011111',
  '3': '11111000100010000010000011000101110', '4': '00010001100101010010111110001000010', '5': '11111100001111000001000011000101110',
  '6': '00110010001000011110100011000101110', '7': '11111000010001000100010000100001000', '8': '01110100011000101110100011000101110',
  '9': '01110100011000101111000010001001100', ' ': '00000000000000000000000000000000000', '&': '01100100101010001000101011001001101',
  '-': '00000000000000011111000000000000000', '.': '00000000000000000000000000110001100', '!': '00100001000010000100001000000000100',
  "'": '00100001000100000000000000000000000', '+': '00000001000010011111001000010000000', $: '00100011111010001110001011111000100',
};

/** Width of a line of sign text. */
export const signWidth = (text: string, px: number) => (text.length * 6 - 1) * px;

/** Runs of lit pixels in a 5 × 7 glyph, row by row: [row, col0, col1). */
function glyphRuns(ch: string): [number, number, number][] {
  const g = FONT7[ch] ?? FONT7[' ']!;
  const out: [number, number, number][] = [];
  for (let row = 0; row < 7; row++) {
    let c0 = -1;
    for (let col = 0; col <= 5; col++) {
      const on = col < 5 && g[row * 5 + col] === '1';
      if (on && c0 < 0) c0 = col;
      if (!on && c0 >= 0) {
        out.push([row, c0, col]);
        c0 = -1;
      }
    }
  }
  return out;
}

/** Flat sign lettering on a face facing (nx, nz), centred on (x, y, z). */
export function signText(b: GeoBuilder, bucket: Bucket, text: string, x: number, y: number, z: number, nx: number, nz: number, px: number, color: ColorLike, rand = 0) {
  const l = Math.hypot(nx, nz) || 1;
  const rx = nz / l;
  const rz = -nx / l;
  const chars = text.toUpperCase().split('');
  const x0 = -signWidth(text, px) / 2;
  chars.forEach((ch, i) => {
    for (const [row, c0, c1] of glyphRuns(ch)) {
      const cx = x0 + (i * 6 + (c0 + c1) / 2) * px;
      const cy = (3 - row) * px;
      quad3(b, bucket, x + rx * cx, y + cy, z + rz * cx, rx, 0, rz, 0, 1, 0, (c1 - c0) * px, px, color, rand);
    }
  });
}

/**
 * Channel letters: chunky 3D lettering standing on a roof or fixed to a
 * wall, facing (nx, nz). Returns and sides are solid in `side`; the faces
 * are on the neon layer in `face`, so they read as paint by day and light
 * up at night. `back` closes the letters off behind (for free-standing ones).
 */
export function blockText(b: GeoBuilder, text: string, x: number, y: number, z: number, nx: number, nz: number, px: number, depth: number, face: ColorLike, side: ColorLike, rand = 0, back = false) {
  const l = Math.hypot(nx, nz) || 1;
  const ux = nx / l;
  const uz = nz / l;
  const rx = uz;
  const rz = -ux;
  const chars = text.toUpperCase().split('');
  const x0 = -signWidth(text, px) / 2;
  const n = neonOf(b);
  chars.forEach((ch, i) => {
    for (const [row, c0, c1] of glyphRuns(ch)) {
      const cx = x0 + (i * 6 + (c0 + c1) / 2) * px;
      const cy = y + (3 - row) * px;
      const w = (c1 - c0) * px;
      const bx = x + rx * cx - ux * (depth / 2);
      const bz = z + rz * cx - uz * (depth / 2);
      // The letter body: front, sides and top (the back sits against the wall or faces away)
      fin(b, bx, cy, bz, 0, 1, 0, ux, 0, uz, w, px, depth, side);
      quad3(n, 'glow', x + rx * cx + ux * 0.002, cy, z + rz * cx + uz * 0.002, rx, 0, rz, 0, 1, 0, w, px, face, rand);
      // Free-standing letters (on a roof) need a back, or they vanish when the camera swings round
      if (back) quad3(b, 'solid', x + rx * cx - ux * depth, cy, z + rz * cx - uz * depth, -rx, 0, -rz, 0, 1, 0, w, px, side);
    }
  });
}

/**
 * A round logo sign (a disc with a rim) facing (nx, nz), lit at night, with
 * a one- or two-letter mark. `both` puts the face on the back too, for
 * signs on poles.
 */
export function logoDisc(b: GeoBuilder, x: number, y: number, z: number, nx: number, nz: number, rad: number, rim: ColorLike, face: ColorLike, mark: string, markColor: ColorLike, both = false) {
  const ry = Math.atan2(nx, nz);
  const l = Math.hypot(nx, nz) || 1;
  const ux = nx / l;
  const uz = nz / l;
  const t = Math.max(0.02, rad * 0.16);
  put(b, new THREE.CylinderGeometry(rad, rad, t, 20), x, y, z, rim, 'solid', ry, Math.PI / 2);
  const n = neonOf(b);
  for (const s of both ? [1, -1] : [1]) {
    put(n, new THREE.CircleGeometry(rad * 0.86, 20), x + ux * s * (t / 2 + 0.002), y, z + uz * s * (t / 2 + 0.002), face, 'glow', s > 0 ? ry : ry + Math.PI);
    const px = Math.min((rad * 1.1) / (mark.length * 6 - 1), rad * 0.2);
    signText(n, 'glow', mark, x + ux * s * (t / 2 + 0.005), y, z + uz * s * (t / 2 + 0.005), ux * s, uz * s, px, markColor);
  }
}

/** A sign board on two posts (or legs on a roof) with lettering on both faces, facing ±(nx, nz). */
export function signBoard(b: GeoBuilder, text: string, x: number, y: number, z: number, nx: number, nz: number, px: number, board: ColorLike, letters: ColorLike, legs = 0.1) {
  const w = signWidth(text, px) + px * 4;
  const h = px * 11;
  const ry = Math.atan2(nx, nz);
  const c = Math.cos(ry);
  const s = Math.sin(ry);
  b.box(w, h, 0.02, x, y + legs, z, board, false, ry);
  b.box(w + 0.01, 0.012, 0.03, x, y + legs + h, z, shade(board, 0.8), false, ry);
  for (const k of [-1, 1]) b.box(0.014, legs, 0.014, x + c * k * (w / 2 - 0.04), y, z - s * k * (w / 2 - 0.04), 0x5b6470, false, ry);
  const l = Math.hypot(nx, nz) || 1;
  for (const k of [1, -1]) signText(neonOf(b), 'glow', text, x + (k * nx * 0.0115) / l, y + legs + h / 2, z + (k * nz * 0.0115) / l, k * nx, k * nz, px, letters);
}

/** Fictional companies for the logos around town. */
export const BRANDS = ['NIMBLR', 'BYTEBAY', 'FOGLINE', 'QUBIT', 'ZEPHYR', 'KITELY', 'LOOPR', 'PIXL', 'HELIX', 'MOSAIC', 'VECTR', 'SOLACE'] as const;

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
export function canopy(b: GeoBuilder, x: number, z: number, nx: number, nz: number, w: number, y: number, color: ColorLike = 0xe8ecef) {
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
  // Cooling towers with fans, condensers on a duct, vents
  for (let k = 0; k < 2; k++) {
    const cx = x - w * 0.28 + k * 0.17;
    const cz = z + d * 0.28;
    b.box(0.14, 0.1, 0.14, cx, y, cz, 0x9aa3ad);
    for (let j = 0; j < 2; j++) wall(b, 'solid', cx + 0.071, y + 0.05, cz + (j - 0.5) * 0.06, 1, 0, 0.05, 0.07, GRILLE);
    b.cylinder(0.05, 0.05, 0.012, cx, y + 0.1, cz, 0x3a4048, 10);
  }
  if (w > 0.5 && d > 0.45) {
    acUnit(b, x + w * 0.3, y, z + d * 0.3, 0.9, Math.PI / 2);
    acUnit(b, x + w * 0.3, y, z + d * 0.08, 0.9, Math.PI / 2);
  }
  vent(b, x - w * 0.38, y, z - d * 0.3);
  vent(b, x + w * 0.05, y, z + d * 0.38);
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

/** A brand's sign colour: lit red, blue, green, orange or white letters. */
const SIGN_COLORS: ColorLike[] = [[2.6, 0.32, 0.24], [0.45, 1.1, 2.8], [0.4, 2.2, 1.1], [2.8, 1.3, 0.3], [2.4, 2.4, 2.3]];

/**
 * "Blue glass and white bands": a corporate slab with rounded corners,
 * ribbon windows between white spandrels, a setback with a terrace on the
 * taller ones, and the company's name on the parapet.
 */
function bandTower(b: GeoBuilder, r: () => number, x: number, z: number, H: number) {
  const W = 1.3;
  const D = 1.02;
  const white = pick(r, [0xf3f2ee, 0xeceae4, 0xf5f1e8] as const);
  const tint = r() < 0.6 ? TINT.blue : TINT.teal;
  const light = officeLight(r);
  const brand = pick(r, BRANDS);
  // Coloured letters (never white on the white band, which wouldn't read by day)
  const signC = SIGN_COLORS[Math.floor(r() * 4)]!;
  const y0 = 0.035;
  const lob = 0.34;
  const base = roundPts(W, D, 0.14, 2, x, z);
  lobby(b, r, roundPts(W - 0.1, D - 0.1, 0.1, 2, x, z), y0, lob, 0x3a4048, light);
  // Pilotis: the white frame carries down to the ground at the corners and mid-bays
  for (const [px, pz] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 1], [1, 0], [0, -1], [-1, 0]] as const) b.box(0.06, lob, 0.06, x + px * (W / 2 - 0.05), y0, z + pz * (D / 2 - 0.05), white);
  canopy(b, x, z + D / 2 - 0.04, 0, 1, 0.46, y0 + 0.24, 0x2a2f38);
  const ys = y0 + lob;
  const fh = 0.2;
  const tall = H > 3.6;
  const yStep = tall ? ys + Math.round(((H - ys) * 0.7) / fh) * fh : H - 0.12;
  const shaft = (pts: XZ[], ya: number, yb: number) => {
    prism(b, pts, ya, yb - ya, white);
    facade(b, r, pts, ya, null, yb, { floors: Math.max(1, Math.round((yb - ya) / fh)), bay: 0.13, winH: 0.56, winW: 0.97, lit: 0.5, light, tint });
  };
  shaft(base, ys, yStep);
  let top = yStep;
  let roofPts = base;
  if (tall) {
    // The upper block steps back from the street corner; a terrace on the step
    const up = roundPts(W * 0.78, D * 0.8, 0.12, 2, x - W * 0.11, z - D * 0.1);
    roofEdge(b, base, yStep, white, 0xf8f8f6, 0.07, 0.03);
    roofTerrace(b, r, x + W * 0.36, yStep + 0.004, z + D * 0.02, W * 0.22, D * 0.86, signC as ColorLike, ['x+'], 3);
    b.box(W * 0.74, 0.012, D * 0.18, x - W * 0.11, yStep + 0.004, z + D * 0.4, PALETTE.lawn);
    for (let k = 0; k < 3; k++) bush(b, r, x - W * 0.38 + k * W * 0.27, yStep + 0.05, z + D * 0.4, 0.05);
    shaft(up, yStep, H - 0.12);
    roofPts = up;
    top = H - 0.12;
  }
  // The crown: a deep white parapet band carrying the name on every side
  const [cx, cz] = centroid(roofPts);
  prism(b, roofPts, top, 0.16, white);
  const xs = roofPts.map((p) => p[0]);
  const zs = roofPts.map((p) => p[1]);
  const hw = (Math.max(...xs) - Math.min(...xs)) / 2;
  const hd = (Math.max(...zs) - Math.min(...zs)) / 2;
  const n = neonOf(b);
  for (const [nx, nz, span] of [[1, 0, hd * 2], [-1, 0, hd * 2], [0, 1, hw * 2], [0, -1, hw * 2]] as const) {
    const px = Math.min(0.02, (span * 0.7) / (brand.length * 6));
    signText(n, 'glow', brand, cx + nx * (hw + 0.004), top + 0.08, cz + nz * (hd + 0.004), nx, nz, px, signC);
  }
  roofEdge(b, roofPts, top + 0.16, white, 0xf8f8f6, 0.05, 0.03);
  neonRing(b, insetPts(roofPts, -0.008), top + 0.225, 0.008, NIGHT_WHITE);
  const ry = top + 0.164;
  if (tall && H > 4.8) helipad(b, cx + 0.12, ry, cz + 0.08, 0.3);
  else roofPlant(b, r, cx, ry, cz, hw * 2 - 0.14, hd * 2 - 0.14, 2);
  if (tall && H > 4.8) {
    acUnit(b, cx - hw + 0.16, ry, cz - hd + 0.14);
    acUnit(b, cx - hw + 0.16, ry, cz - hd + 0.28);
    stairHouse(b, cx - hw + 0.18, ry, cz + hd - 0.16, 0.16, 0.14, 0.14, 1, 0);
  }
}

/** A round office tower: ribbon windows around a drum, a podium, a lit crown and a rooftop plant drum. */
function roundTower(b: GeoBuilder, r: () => number, x: number, z: number, H: number) {
  const R = 0.56;
  const white = pick(r, [0xefeee9, 0xe9e4da, 0xdfe3e6] as const);
  const glassTint = r() < 0.5 ? TINT.blue : TINT.silver;
  const light = officeLight(r);
  const y0 = 0.035;
  const segs = 22;
  // Podium: two low floors on a rounded square, glass all round, a green roof
  const pod = roundPts(1.5, 1.5, 0.3, 3, x, z);
  const ph = 0.42;
  prism(b, pod, y0, ph, 0xd9d6cf);
  facade(b, r, pod, y0, null, y0 + ph, { floors: 2, bay: 0.15, winH: 0.66, winW: 0.9, lit: 0.85, light: warmth(r), tint: TINT.shop });
  roofEdge(b, pod, y0 + ph, 0xd9d6cf, 0xf2f0ea, 0.05, 0.03);
  b.box(0.36, 0.012, 0.36, x + 0.48, y0 + ph + 0.004, z - 0.48, PALETTE.lawn);
  b.box(0.36, 0.012, 0.36, x - 0.48, y0 + ph + 0.004, z + 0.48, PALETTE.lawn);
  for (const [dx, dz] of [[0.48, -0.48], [-0.48, 0.48]] as const) bush(b, r, x + dx, y0 + ph + 0.06, z + dz, 0.07);
  acUnit(b, x + 0.5, y0 + ph + 0.004, z + 0.5, 1, Math.PI / 4);
  acUnit(b, x - 0.5, y0 + ph + 0.004, z - 0.5, 1, Math.PI / 4);
  canopy(b, x, z + 0.73, 0, 1, 0.5, y0 + 0.26, 0x2a2f38);
  canopy(b, x + 0.73, z, 1, 0, 0.5, y0 + 0.26, 0x2a2f38);
  // The drum
  const ring = ngonPts(segs, R, R, x, z);
  const ys = y0 + ph;
  const fh = 0.19;
  const floors = Math.max(4, Math.round((H - 0.2 - ys) / fh));
  const top = ys + floors * fh;
  prism(b, ring, ys, top - ys, white);
  facade(b, r, ring, ys, null, top, { floors, bay: 0.1, winH: 0.58, winW: 0.98, lit: 0.5, light, tint: glassTint });
  // Crown: a glass lantern band lit from within, then the parapet and the plant drum
  const crown = ngonPts(segs, R - 0.04, R - 0.04, x, z);
  prism(b, crown, top, 0.16, 0x2a3442);
  facade(b, r, crown, top, null, top + 0.16, { floors: 1, bay: 0.1, winH: 0.8, winW: 0.9, lit: 1, light: [1.7, 1.55, 1.25], tint: TINT.smoke });
  roofEdge(b, ngonPts(segs, R + 0.01, R + 0.01, x, z), top + 0.16, white, 0xf6f6f2, 0.05, 0.03);
  neonRing(b, ngonPts(segs, R + 0.02, R + 0.02, x, z), top + 0.218, 0.008, NIGHT_WHITE);
  const ry = top + 0.164;
  b.cylinder(0.24, 0.24, 0.16, x - 0.05, ry, z - 0.05, MECH, 14);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    wall(b, 'solid', x - 0.05 + Math.cos(a) * 0.242, ry + 0.08, z - 0.05 + Math.sin(a) * 0.242, Math.cos(a), Math.sin(a), 0.1, 0.1, MECH_SHADE);
  }
  b.cylinder(0.25, 0.25, 0.014, x - 0.05, ry + 0.16, z - 0.05, 0x8f979f, 14);
  for (const [dx, dz] of [[0.3, 0.12], [0.12, 0.3], [-0.3, -0.18]] as const) acUnit(b, x + dx, ry, z + dz, 0.9, Math.atan2(dx, dz));
  rod(b, x - 0.05, ry + 0.17, z - 0.05, x - 0.05, ry + 0.55, z - 0.05, 0.01, PALETTE.steel, 4, 'solid', 0.005);
  quadBlob(neonOf(b), x - 0.05, ry + 0.57, z - 0.05, 0.022, RED_LIGHT, FX.blink + r());
  // A logo disc on the podium corner, on its own short mast
  const brand = pick(r, BRANDS);
  const lx = x + 0.62;
  const lz = z + 0.62;
  rod(b, lx, y0 + ph, lz, lx, y0 + ph + 0.3, lz, 0.012, 0xd8dce0, 5);
  logoDisc(b, lx, y0 + ph + 0.36, lz, 1, 1, 0.13, 0xf4f4f0, shade(pick(r, SIGN_COLORS), 0.7), brand.slice(0, 1), [2.6, 2.6, 2.5], true);
}

/** How many tower styles there are (see `tower`). */
export const TOWER_STYLES = 6;

/**
 * Office towers and skyscrapers (tier 3 or 5). Mid-rise offices are mostly
 * the white-band and round corporate types; skyscrapers mostly the four San
 * Francisco classics. `style` forces one (0–5) for the showcase.
 */
export function tower(b: GeoBuilder, r: () => number, x: number, z: number, tier: number, neon: ColorLike, style?: number) {
  void neon;
  const roll = r();
  const s = style ?? (tier >= 5 ? [0, 1, 2, 3, 4, 5, 0, 2][Math.floor(roll * 8)]! : [4, 4, 5, 5, 0, 1, 2, 3][Math.floor(roll * 8)]!);
  const H = tier >= 5 ? 4.6 + r() * 1.2 : 2.4 + r() * 0.8;
  towerPlaza(b, r, x, z);
  if (s === 0) graniteTower(b, r, x - 0.08, z - 0.08, H);
  else if (s === 1) taperTower(b, r, x - 0.08, z - 0.08, H);
  else if (s === 2) bracedTower(b, r, x - 0.08, z - 0.08, H);
  else if (s === 3) decoTower(b, r, x - 0.08, z - 0.08, H);
  else if (s === 4) bandTower(b, r, x - 0.08, z - 0.08, H);
  else roundTower(b, r, x - 0.08, z - 0.08, H);
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
  const finC = 0xdcdcd6;
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
      floors: Math.round((c.y - a.y) / 0.19),
      bay: 0.16,
      winH: 0.8,
      winW: 0.78,
      lit: 0.6,
      light,
      tint: TINT.silver,
      fins: { color: finC, depth: 0.026, width: 0.016, every: 1 },
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
      if (j % 2 === 0) beam(b, p0[0], a.y, p0[1], q0[0], c.y, q0[1], 0.016, finC);
    }
    loft(b, [{ pts: c.pts, y: c.y - 0.03 }, { pts: c.pts, y: c.y }], finC, 'solid', false);
  }
  // A roof deep inside the crown with a glowing core
  prism(b, scalePts(c0.pts, 0.9, 0.9, tx, tz), c0.y - 0.02, 0.03, 0x3a4250);
  b.box(0.4, 0.16, 0.3, tx - 0.1, c0.y, tz - 0.1, 0x59616c);
  b.cylinder(0.12, 0.12, 0.1, tx + 0.22, c0.y, tz + 0.15, 0x8a929c, 10);
  rod(b, tx, 9.3, tz, tx, 9.75, tz, 0.012, finC, 5, 'solid', 0.005);
  quadBlob(neonOf(b), tx, 9.77, tz, 0.04, RED_LIGHT, FX.blink + 0.5);
  for (const [px, pz] of [[0.55, 0.55], [-0.55, -0.55], [0.55, -0.55], [-0.55, 0.55]] as const) quadBlob(neonOf(b), tx + px * 0.75, 9.36, tz + pz * 0.75, 0.025, RED_LIGHT, FX.blink + 0.5);

  // Transit center: a long hall in a white, wavy perforated skin, a park on its roof
  const px0 = x;
  const pz0 = z + 1.18;
  const pw = 3.8;
  const pd = 1.4;
  const ph = 0.5;
  b.box(pw - 0.08, ph, pd - 0.08, px0, y0, pz0, 0xe9e7e1);
  // Slats only show their front, sides and top, so they're fins, not boxes
  const sh = ph - 0.06;
  const sy = y0 + 0.03 + sh / 2;
  for (let k = 0; k <= 48; k++) {
    const u = k / 48;
    const sx = px0 - pw / 2 + u * pw;
    const depth = 0.02 + 0.035 * (0.5 + 0.5 * Math.sin(u * Math.PI * 7));
    fin(b, sx, sy, pz0 + pd / 2 - 0.04, 0, 1, 0, 0, 0, 1, 0.028, sh, depth, 0xf6f5f0);
    if (k % 2 === 0) fin(b, sx, sy, pz0 - pd / 2 + 0.04, 0, 1, 0, 0, 0, -1, 0.028, sh, depth, 0xf6f5f0);
  }
  for (let k = 0; k <= 14; k++) {
    const u = k / 14;
    const sz = pz0 - pd / 2 + u * pd;
    const depth = 0.02 + 0.035 * (0.5 + 0.5 * Math.sin(u * Math.PI * 3));
    for (const s of [-1, 1]) fin(b, px0 + s * (pw / 2 - 0.04), sy, sz, 0, 1, 0, s, 0, 0, 0.028, sh, depth, 0xf6f5f0);
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
    flat(b, 'solid', px0 - pw / 2 + 0.2 + u * (pw - 0.4), ry + 0.064, pz0 + Math.sin(u * Math.PI * 3) * 0.35, 0.34, 0.07, 0xe8dcc4, Math.cos(u * Math.PI * 3) * 0.6);
  }
  // Amphitheatre and the bus fountain
  for (let k = 0; k < 3; k++) b.box(0.42 - k * 0.08, 0.02 + k * 0.02, 0.06, px0 + 1.25, ry + 0.06, pz0 - 0.4 + k * 0.06, 0xcfc8b8);
  b.box(1.2, 0.012, 0.06, px0 - 0.4, ry + 0.062, pz0 - 0.5, 0x6fb9d6);
  for (let k = 0; k < 10; k++) quadBlob(neonOf(b), px0 - 0.95 + k * 0.12, ry + 0.1, pz0 - 0.5, 0.012, [0.7, 1.4, 2.2], FX.shimmer + k * 0.1);
  for (let k = 0; k < 8; k++) {
    const u = k / 7;
    tree(b, r, px0 - pw / 2 + 0.25 + u * (pw - 0.5), pz0 + (k % 2 ? 0.45 : 0.1) + (r() - 0.5) * 0.1, 0.62, ry + 0.06, k % 3 === 0 ? 'cypress' : 'round');
  }
  for (let k = 0; k < 4; k++) lamp(b, px0 - 1.5 + k * 1.0, pz0 + 0.62, ry + 0.06, 0.18);
  people(b, r, px0, pz0, 8, pw - 0.6, pd - 0.6, ry + 0.06);
  // The little gondola from the street
  rod(b, px0 - 1.75, 0.035, pz0 - 0.78, px0 - 1.75, ry + 0.25, pz0 - 0.78, 0.012, 0xe9e7e1, 5);
  beam(b, px0 - 1.75, ry + 0.25, pz0 - 0.78, px0 - 1.45, ry + 0.25, pz0 - 0.55, 0.008, 0x3a4048);
  {
    // The cabin: a red box with a band of windows all round (no draws from r, so the plaza keeps its layout)
    const gx = px0 - 1.62;
    const gz = pz0 - 0.68;
    b.box(0.09, 0.08, 0.07, gx, ry + 0.12, gz, 0xd8402e);
    b.box(0.1, 0.01, 0.08, gx, ry + 0.2, gz, 0xe9e7e1);
    for (const [nx, nz, w] of [[1, 0, 0.05], [-1, 0, 0.05], [0, 1, 0.07], [0, -1, 0.07]] as const) {
      wall(winOf(b), 'glow', gx + nx * 0.0455, ry + 0.17, gz + nz * 0.0355, nx, nz, w, 0.03, [1.35, 0.95, 0.55], TINT.sky * 10 + 0.3 + nx * 0.1 + nz * 0.2);
    }
  }
  // Plaza on the Fremont Street side: water steps, sculpture, people
  b.box(0.7, 0.03, 0.5, x + 1.3, 0.035, z - 1.2, 0xcfc8b8);
  b.box(0.62, 0.012, 0.42, x + 1.3, 0.065, z - 1.2, PALETTE.pool);
  b.box(0.06, 0.32, 0.06, x + 1.3, 0.035, z - 0.6, 0xd8402e);
  put(b, new THREE.TorusGeometry(0.1, 0.018, 5, 14), x + 1.3, 0.42, z - 0.6, 0xd8402e, 'smooth', Math.PI / 4);
  for (const [dx, dz] of [[1.75, -1.75], [1.75, -0.2], [0.4, -1.75], [-1.75, -0.4]] as const) {
    planter(b, r, x + dx, z + dz, 0.14, 0.14, 0.035);
    tree(b, r, x + dx, z + dz, 0.55, 0.09, 'round');
  }
  for (const [dx, dz] of [[1.75, -1.0], [0.9, -1.75], [-1.75, 0.3]] as const) lamp(b, x + dx, z + dz, 0.035);
  people(b, r, x + 1.1, z - 0.5, 5, 0.8, 1.6, 0.035);
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
  // Solar arrays at the back of the long wing; the company's letters stand along its front edge
  for (let i = 0; i < 4; i++) {
    const g = new THREE.BoxGeometry(0.3, 0.012, 0.16);
    put(b, g, x - 0.6 + i * 0.36, ya + 0.05, z - 0.76, 0x23345a, 'glass', 0, -0.35);
    put(b, new THREE.BoxGeometry(0.31, 0.004, 0.004), x - 0.6 + i * 0.36, ya + 0.052, z - 0.76, 0xc8d0d8, 'solid', 0, -0.35);
  }
  const brand = pick(r, BRANDS);
  // (clear of the atrium cube, which pokes up through the west end)
  const px = Math.min(0.026, 0.92 / signWidth(brand, 1));
  blockText(b, brand, x + 0.26, ya + 0.03 + px * 3.5, z - 0.4, 0, 1, px, 0.024, bright(accent, 2.2), shade(accent, 0.55), FX.steady, true);
  for (const s of [-1, 1]) b.box(0.012, 0.03, 0.012, x + 0.26 + s * (signWidth(brand, px) / 2 - 0.05), ya, z - 0.41, 0x3a4048);
  acUnit(b, x + 0.62, ya, z - 0.5, 0.9);
  b.box(0.48, 0.02, 0.98, x - 0.62, yb, z + 0.2, PALETTE.lawn);
  for (let k = 0; k < 4; k++) bush(b, r, x - 0.72 + (k % 2) * 0.2, yb + 0.04, z - 0.1 + k * 0.2, 0.05);
  acUnit(b, x - 0.62, yb + 0.02, z + 0.6, 0.9, Math.PI / 2);
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
  // Roof: the team's deck (ping-pong, parasols, people) at the back, plant beside it
  roofEdge(b, rectPts(W + 0.08, D + 0.08), top + 0.06, stone, 0xf6f2ea, 0.05, 0.03);
  roofTerrace(b, r, -0.32, top + 0.064, -0.2, 0.7, 0.66, brand, ['x-', 'z-'], 4);
  pingPong(b, -0.3, top + 0.076, -0.05, 0.1);
  roofPlant(b, r, 0.38, top + 0.064, -0.3, 0.56, 0.5, 1);
  // A two-storey glass annex (the canteen) on the south-west corner, with its own roof terrace
  const ax = -1.15;
  const az = -1.05;
  const ap = rectPts(0.76, 0.62, ax, az);
  prism(b, ap, y0, 0.48, 0x8fb0c4, 'glass');
  facade(b, r, ap, y0, null, y0 + 0.48, { floors: 2, bay: 0.15, winH: 0.84, winW: 0.92, lit: 0.9, light: warmth(r), tint: TINT.blue, fins: { color: stone, depth: 0.02, width: 0.014 }, bands: { color: stone, every: 1, depth: 0.03, h: 0.02 } });
  roofEdge(b, ap, y0 + 0.48, stone, 0xf6f2ea, 0.04, 0.025);
  roofTerrace(b, r, ax + 0.06, y0 + 0.484, az + 0.06, 0.56, 0.42, brand, ['x+', 'z+'], 3);
  acUnit(b, ax - 0.26, y0 + 0.484, az - 0.2, 0.85, Math.PI / 2);
  canopy(b, ax, az + 0.31, 0, 1, 0.3, y0 + 0.22, 0x2a2f38);
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
    facade(b, r, pts, y0, null, y0 + h, { floors: n, bay: 0.18, winH: 0.82, winW: 0.9, lit: 0.7, light, tint: TINT.blue, fins: { color: 0xc08a5a, depth: 0.03, width: 0.018, every: 2 }, bands: { color: white, every: 1, depth: 0.06 } });
    prism(b, scalePts(pts, 1.03), y0 + h, 0.03, white);
    const [cx, cz] = centroid(pts);
    b.box(Math.abs(pts[1]![0] - pts[0]![0]) - 0.06, 0.02, Math.abs(pts[2]![1] - pts[1]![1]) - 0.06, cx, y0 + h + 0.03, cz, PALETTE.lawn);
    return y0 + h + 0.05;
  };
  const yn = wing(rectPts(2.6, 0.6, -0.2, -1.25), 2);
  const yw = wing(rectPts(0.6, 1.5, -1.25, -0.2), 2);
  for (let k = 0; k < 3; k++) bush(b, r, -1.2 + k * 0.6, yn + 0.03, -1.25 + (k % 2 ? 0.1 : -0.12), 0.065);
  for (let k = 0; k < 2; k++) bush(b, r, -1.25 + (k % 2 ? 0.12 : -0.1), yw + 0.03, -0.5 + k * 0.5, 0.065);
  for (let k = 0; k < 2; k++) acUnit(b, -1.25, yw - 0.02, 0.15 + k * 0.17, 0.85, Math.PI / 2);
  stairHouse(b, -1.1, yn - 0.02, -1.25, 0.16, 0.14, 0.13, 0, 1);
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
      for (let k = 0; k < 2; k++) bush(b, r, ox - w / 2 + 0.25 + k * 0.7, y + 0.08, oz + w / 2 - 0.1, 0.055);
      parasol(b, ox + w / 2 - 0.1, y + 0.045, oz + w / 2 - 0.1, brand, 0.07);
      people(b, r, ox + w / 2 - 0.1, oz + 0.1, 2, 0.06, w * 0.5, y + 0.045);
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
  roofEdge(b, chamferPts(W - 0.06, W - 0.06, c * 0.9), hy, 0xe6eaee, 0xf6f8fa, 0.04, 0.03);
  helipad(b, 0.2, hy + 0.004, 0.2, 0.42);
  acUnit(b, -0.48, hy + 0.004, -0.2, 0.9, Math.PI / 2);
  acUnit(b, -0.2, hy + 0.004, -0.48, 0.9);
  stairHouse(b, -0.42, hy + 0.004, 0.36, 0.16, 0.14, 0.14, 1, 0);
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
