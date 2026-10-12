import * as THREE from 'three';
import { GeoBuilder, type ColorLike } from './geo.ts';
import { PALETTE } from './palette.ts';
import { pick, rng } from '../world/rng.ts';
import { BLOCK, blockCentre, homeLots, lotPosition, treeLots, type HomeKind } from '../world/layout.ts';

/**
 * San Francisco homes and the gardens between them.
 *
 * Every home is built in lot-local space: the lot is 1×1, centred on the
 * origin, front door facing +z (the street). Neighbouring lots touch, so
 * homes that fill the lot's width make continuous street walls. Every home
 * shares one setback: the street wall stands at z = FRONT, bays, stoops and
 * garden strips fill the space in front of it, and the block's sidewalk (drawn
 * by `neighbourhoodGrounds`) starts at z = LOT_FRONT. Backyards run from
 * z = BACK to the rear fence and join the block's shared mid-block garden.
 */

export interface Built {
  group: THREE.Group;
  /** Window/neon material; the city blends it between daylight glass and night glow. */
  glow?: THREE.MeshBasicMaterial;
}

export function bright(hex: number, k: number): [number, number, number] {
  const c = new THREE.Color(hex);
  return [c.r * k, c.g * k, c.b * k];
}

export function warmth(r: () => number): ColorLike {
  const w = PALETTE.windowWarm;
  const v = 0.85 + r() * 0.3;
  return [w[0] * v, w[1] * v, w[2] * v];
}

// ─── Geometry helpers ─────────────────────────────────────────────────────

type V = readonly [number, number, number];
type RGB = [number, number, number];
type Bucket = 'solid' | 'glass' | 'smooth' | 'glow';
/** Colour per triangle, from its centroid and face normal. */
type TriColor = (cx: number, cy: number, cz: number, nx: number, ny: number, nz: number) => RGB;

const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const v3 = new THREE.Vector3();
const v3b = new THREE.Vector3();
const one = new THREE.Vector3(1, 1, 1);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const UP: V = [0, 1, 0];
const tc = new THREE.Color();

/** Linear RGB of a hex or triple. */
function lin(c: ColorLike): RGB {
  if (typeof c === 'number') {
    tc.setHex(c);
    return [tc.r, tc.g, tc.b];
  }
  return [c[0], c[1], c[2]];
}

function mul(c: ColorLike, k: number): RGB {
  const [r, g, b] = lin(c);
  return [r * k, g * k, b * k];
}

function mix(a: ColorLike, b: ColorLike, t: number): RGB {
  const x = lin(a);
  const y = lin(b);
  return [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t];
}

/** Cheap deterministic noise for per-triangle colour jitter (keeps the seeded rng sequence untouched). */
function noise(a: number, b: number, c: number): number {
  const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Same contract as GeoBuilder's private `prepare`: non-indexed, coloured, with `winRand`. */
function prep(g: THREE.BufferGeometry, color: ColorLike | TriColor, rand = 0): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  for (const name of Object.keys(geo.attributes)) if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const pos = geo.attributes.position!;
  const n = pos.count;
  const colors = new Float32Array(n * 3);
  if (typeof color === 'function') {
    const p = pos.array as ArrayLike<number>;
    for (let i = 0; i + 2 < n; i += 3) {
      const o = i * 3;
      const ax = p[o]!, ay = p[o + 1]!, az = p[o + 2]!;
      const bx = p[o + 3]!, by = p[o + 4]!, bz = p[o + 5]!;
      const cx = p[o + 6]!, cy = p[o + 7]!, cz = p[o + 8]!;
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      const col = color((ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3, nx, ny, nz);
      for (let k = 0; k < 3; k++) colors.set(col, o + k * 3);
    }
  } else {
    const col = lin(color);
    for (let i = 0; i < n; i++) colors.set(col, i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('winRand', new THREE.BufferAttribute(new Float32Array(n).fill(rand), 1));
  return geo;
}

function add(b: GeoBuilder, g: THREE.BufferGeometry, color: ColorLike | TriColor, bucket: Bucket = 'solid', rand = 0) {
  b.raw(prep(g, color, rand), bucket);
}

/** Hand-built triangles with per-vertex colour; `hint` orients each triangle to face that way. */
class Tris {
  private pos: number[] = [];
  private col: number[] = [];

  tri(a: V, b: V, c: V, ca: RGB, cb: RGB = ca, cc: RGB = ca, hint?: V, both = false) {
    if (hint) {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * hint[0] + ny * hint[1] + nz * hint[2] < 0) {
        [b, c] = [c, b];
        [cb, cc] = [cc, cb];
      }
    }
    this.pos.push(...a, ...b, ...c);
    this.col.push(...ca, ...cb, ...cc);
    if (both) {
      this.pos.push(...a, ...c, ...b);
      this.col.push(...ca, ...cc, ...cb);
    }
  }

  quad(a: V, b: V, c: V, d: V, col: RGB, hint?: V, both = false) {
    this.tri(a, b, c, col, col, col, hint, both);
    this.tri(a, c, d, col, col, col, hint, both);
  }

  flush(b: GeoBuilder, bucket: Bucket = 'solid', rand = 0) {
    if (!this.pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.computeVertexNormals();
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('winRand', new THREE.BufferAttribute(new Float32Array(this.pos.length / 3).fill(rand), 1));
    b.raw(g, bucket);
    this.pos = [];
    this.col = [];
  }
}

/** A flat panel facing `ang` (rotation about Y; 0 faces +z). */
function panel(b: GeoBuilder, w: number, h: number, x: number, y: number, z: number, ang: number, color: ColorLike, bucket: Bucket = 'solid', rand = 0) {
  const g = new THREE.PlaneGeometry(w, h);
  if (ang) g.rotateY(ang);
  g.translate(x, y, z);
  add(b, g, color, bucket, rand);
}

/** Rectangle with a segmental arch on top (`rise` tall), centred on (0,0). */
function archShape(w: number, h: number, rise: number): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, -h / 2);
  s.lineTo(w / 2, -h / 2);
  s.lineTo(w / 2, h / 2 - rise);
  s.absellipse(0, h / 2 - rise, w / 2, rise, 0, Math.PI, false, 0);
  s.lineTo(-w / 2, -h / 2);
  return s;
}

function archPanel(b: GeoBuilder, w: number, h: number, rise: number, x: number, y: number, z: number, ang: number, color: ColorLike, bucket: Bucket = 'solid', rand = 0) {
  const g = new THREE.ShapeGeometry(archShape(w, h, rise), 5);
  if (ang) g.rotateY(ang);
  g.translate(x, y, z);
  add(b, g, color, bucket, rand);
}

/** A box from point a to point c (`tw` wide, `th` thick): rails, beams, stair stringers. */
function beam(b: GeoBuilder, a: V, c: V, tw: number, th: number, color: ColorLike, bucket: Bucket = 'solid') {
  v3.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  const len = v3.length();
  if (len < 1e-5) return;
  v3.divideScalar(len);
  q.setFromUnitVectors(X_AXIS, v3);
  m4.compose(v3b.set((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2), q, one);
  b.transformed(new THREE.BoxGeometry(len, th, tw), m4, color, bucket);
}

/** An open-ended tapered cylinder from a to c: trunks and branches (10 triangles at 5 sides). */
function limb(b: GeoBuilder, a: V, c: V, r0: number, r1: number, color: ColorLike, sides = 5) {
  v3.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  const len = v3.length();
  v3.divideScalar(len);
  const g = new THREE.CylinderGeometry(r1, r0, len, sides, 1, true);
  g.translate(0, len / 2, 0);
  q.setFromUnitVectors(Y_AXIS, v3);
  m4.compose(v3b.set(a[0], a[1], a[2]), q, one);
  b.transformed(g, m4, color);
}

/** A convex footprint (x,z points) extruded from y0 to y1; `skip` drops side faces by edge index. */
function prismY(b: GeoBuilder, pts: readonly (readonly [number, number])[], y0: number, y1: number, color: ColorLike, skip: number[] = [], bucket: Bucket = 'solid') {
  const t = new Tris();
  const col = lin(color);
  const n = pts.length;
  let cx = 0;
  let cz = 0;
  for (const [x, z] of pts) {
    cx += x / n;
    cz += z / n;
  }
  for (let i = 0; i < n; i++) {
    if (skip.includes(i)) continue;
    const [ax, az] = pts[i]!;
    const [bx, bz] = pts[(i + 1) % n]!;
    t.quad([ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az], col, [(ax + bx) / 2 - cx, 0, (az + bz) / 2 - cz]);
  }
  for (let i = 1; i < n - 1; i++) t.tri([pts[0]![0], y1, pts[0]![1]], [pts[i]![0], y1, pts[i]![1]], [pts[i + 1]![0], y1, pts[i + 1]![1]], col, col, col, UP);
  t.flush(b, bucket);
}

/** A convex profile (x,y points) extruded along z from z0 to z1: gable ends, pediments. */
function prismZ(b: GeoBuilder, pts: readonly (readonly [number, number])[], z0: number, z1: number, color: ColorLike, bucket: Bucket = 'solid') {
  const t = new Tris();
  const col = lin(color);
  const n = pts.length;
  let cx = 0;
  let cy = 0;
  for (const [x, y] of pts) {
    cx += x / n;
    cy += y / n;
  }
  for (let i = 0; i < n; i++) {
    const [ax, ay] = pts[i]!;
    const [bx, by] = pts[(i + 1) % n]!;
    t.quad([ax, ay, z0], [bx, by, z0], [bx, by, z1], [ax, ay, z1], col, [(ax + bx) / 2 - cx, (ay + by) / 2 - cy, 0]);
  }
  for (const [z, dir] of [[z1, 1], [z0, -1]] as const) {
    for (let i = 1; i < n - 1; i++) t.tri([pts[0]![0], pts[0]![1], z], [pts[i]![0], pts[i]![1], z], [pts[i + 1]![0], pts[i + 1]![1], z], col, col, col, [0, 0, dir]);
  }
  t.flush(b, bucket);
}

const lerp3 = (a: V, b: V, t: number): V => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * Barrel tiles (or awning stripes) on a roof face: A→B is the eave, D→C the
 * top edge (D above A). Each strip is a shallow crest, so flat shading draws
 * the courses; colours jitter per strip, or alternate if `alt` is given.
 */
function tiles(t: Tris, A: V, B: V, C: V, D: V, n: number, base: ColorLike, r: () => number, crest = 0.006, alt?: ColorLike) {
  const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
  const vx = D[0] - A[0], vy = D[1] - A[1], vz = D[2] - A[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  const sgn = ny < 0 ? -1 : 1;
  nx = (nx / l) * sgn;
  ny = (ny / l) * sgn;
  nz = (nz / l) * sgn;
  const N: V = [nx, ny, nz];
  const bc = lin(base);
  const ac = alt ? lin(alt) : null;
  for (let i = 0; i < n; i++) {
    const a0 = lerp3(A, B, i / n);
    const a1 = lerp3(A, B, (i + 1) / n);
    const d0 = lerp3(D, C, i / n);
    const d1 = lerp3(D, C, (i + 1) / n);
    const mb = lerp3(a0, a1, 0.5);
    const mt = lerp3(d0, d1, 0.5);
    const m0: V = [mb[0] + nx * crest, mb[1] + ny * crest, mb[2] + nz * crest];
    const m1: V = [mt[0] + nx * crest, mt[1] + ny * crest, mt[2] + nz * crest];
    const k = 0.86 + r() * 0.24;
    const col: RGB = ac && i % 2 ? ac : [bc[0] * k, bc[1] * k, bc[2] * k];
    t.tri(a0, m0, m1, col, col, col, N);
    t.tri(a0, m1, d0, col, col, col, N);
    t.tri(m0, a1, d1, col, col, col, N);
    t.tri(m0, d1, m1, col, col, col, N);
  }
}

/** Two roof slabs meeting at a ridge that runs along z (a street-facing gable). */
function gableRoof(b: GeoBuilder, x: number, w: number, yE: number, rise: number, z0: number, z1: number, color: ColorLike, over = 0.035, t = 0.02) {
  const half = w / 2;
  const len = Math.hypot(half, rise);
  const ux = half / len;
  const uy = rise / len;
  const lift = t / 2 / ux + 0.001;
  const zc = (z0 + z1) / 2;
  for (const sd of [-1, 1]) {
    beam(b, [x + sd * (half + over * ux), yE - over * uy + lift, zc], [x, yE + rise + lift, zc], z1 - z0, t, color);
  }
}

/** Hip roof of barrel tiles over a w×d footprint (ridge along x), with fascia and ridge caps. */
function tileHip(b: GeoBuilder, r: () => number, x: number, w: number, z: number, d: number, y0: number, rise: number, tile: ColorLike, over = 0.04) {
  const W = w + over * 2;
  const D = d + over * 2;
  const L = Math.max(W - D, 0.04);
  const A: V = [x - W / 2, y0, z + D / 2];
  const B: V = [x + W / 2, y0, z + D / 2];
  const C: V = [x + W / 2, y0, z - D / 2];
  const E: V = [x - W / 2, y0, z - D / 2];
  const R1: V = [x - L / 2, y0 + rise, z];
  const R2: V = [x + L / 2, y0 + rise, z];
  const t = new Tris();
  tiles(t, A, B, R2, R1, 11, tile, r);
  tiles(t, C, E, R1, R2, 11, tile, r);
  tiles(t, B, C, R2, R2, 4, tile, r);
  tiles(t, E, A, R1, R1, 4, tile, r);
  t.flush(b);
  const cap = mul(tile, 0.8);
  beam(b, [R1[0] - 0.01, R1[1] + 0.006, z], [R2[0] + 0.01, R2[1] + 0.006, z], 0.024, 0.016, cap);
  for (const [p, e] of [[R1, A], [R1, E], [R2, B], [R2, C]] as const) beam(b, [p[0], p[1] + 0.006, p[2]], [e[0], e[1] + 0.006, e[2]], 0.016, 0.012, cap);
  b.box(W, 0.014, 0.01, x, y0 - 0.014, z + D / 2 - 0.005, mul(tile, 0.65));
  b.box(W, 0.014, 0.01, x, y0 - 0.014, z - D / 2 + 0.005, mul(tile, 0.65));
}

/** Window: trim surround, glass that lights at night, sash bars, sill and an optional header. */
interface WinOpts {
  w: number;
  h: number;
  lit: number;
  light: ColorLike;
  frame?: ColorLike;
  /** Segmental arch rise. */
  arch?: number;
  bars?: boolean;
  sill?: ColorLike;
  head?: ColorLike;
  shutters?: ColorLike;
}

function win(b: GeoBuilder, r: () => number, x: number, y: number, z: number, ang: number, o: WinOpts) {
  const sx = Math.sin(ang);
  const sz = Math.cos(ang);
  const at = (d: number): [number, number] => [x + sx * d, z + sz * d];
  const rand = r() < o.lit ? 0.12 + 0.86 * r() : 2;
  if (o.frame !== undefined) {
    const [fx, fz] = at(0.002);
    if (o.arch) archPanel(b, o.w + 0.024, o.h + 0.024, o.arch + 0.012, fx, y, fz, ang, o.frame);
    else panel(b, o.w + 0.024, o.h + 0.024, fx, y, fz, ang, o.frame);
  }
  const [gx, gz] = at(0.004);
  if (o.arch) archPanel(b, o.w, o.h, o.arch, gx, y, gz, ang, o.light, 'glow', rand);
  else panel(b, o.w, o.h, gx, y, gz, ang, o.light, 'glow', rand);
  const bar = o.frame ?? PALETTE.trim;
  if (o.bars) {
    const [bx, bz] = at(0.0055);
    panel(b, o.w, 0.007, bx, y + o.h * 0.06 - (o.arch ? o.arch * 0.5 : 0), bz, ang, bar);
    if (o.w > 0.085) panel(b, 0.007, o.h, bx, y, bz, ang, bar);
  }
  if (o.sill !== undefined) {
    const [kx, kz] = at(0.01);
    b.box(o.w + 0.03, 0.012, 0.02, kx, y - o.h / 2 - 0.018, kz, o.sill, false, ang);
  }
  if (o.head !== undefined) {
    const [hx, hz] = at(0.009);
    b.box(o.w + 0.034, 0.016, 0.018, hx, y + o.h / 2 + 0.012, hz, o.head, false, ang);
  }
  if (o.shutters !== undefined) {
    for (const s of [-1, 1]) {
      const [px, pz] = at(0.003);
      panel(b, o.w * 0.42, o.h + 0.01, px + Math.cos(ang) * s * (o.w * 0.71 + 0.012), y, pz - Math.sin(ang) * s * (o.w * 0.71 + 0.012), ang, o.shutters);
    }
  }
}

/** Offsets the 45° bay trapezoid outward by d (for bands and caps). */
function growBay(x: number, z: number, wf: number, p: number, d: number): [number, number][] {
  const wb = wf + 2 * p;
  const k = d * (Math.SQRT2 - 1);
  return [
    [x - wb / 2 - d * Math.SQRT2, z],
    [x - wf / 2 - k, z + p + d],
    [x + wf / 2 + k, z + p + d],
    [x + wb / 2 + d * Math.SQRT2, z],
  ];
}

interface BayOpts {
  x: number;
  /** Wall face the bay stands on. */
  z: number;
  y0: number;
  y1: number;
  /** Front face width and projection; the sides are at 45°. */
  wf: number;
  p: number;
  wall: ColorLike;
  trim: ColorLike;
  accent?: ColorLike;
  /** Window rows: centre y and glass height. */
  rows: { y: number; h: number }[];
  bands?: number[];
  lit: number;
  light: ColorLike;
  brackets?: boolean;
  /** Side windows narrower than the front ones (0..1 of the face). */
  share?: number;
}

/** The San Francisco bay window: three angled faces, stacked floor over floor. */
function bay(b: GeoBuilder, r: () => number, o: BayOpts) {
  const wb = o.wf + 2 * o.p;
  prismY(b, growBay(o.x, o.z, o.wf, o.p, 0), o.y0, o.y1, o.wall, [3]);
  const sideW = o.p * Math.SQRT2;
  const faces = [
    { cx: o.x - (wb + o.wf) / 4, cz: o.z + o.p / 2, ang: -Math.PI / 4, w: sideW * (o.share ?? 0.62) },
    { cx: o.x, cz: o.z + o.p, ang: 0, w: o.wf * 0.66 },
    { cx: o.x + (wb + o.wf) / 4, cz: o.z + o.p / 2, ang: Math.PI / 4, w: sideW * (o.share ?? 0.62) },
  ];
  for (const row of o.rows) {
    for (const f of faces) win(b, r, f.cx, row.y, f.cz, f.ang, { w: f.w, h: row.h, lit: o.lit, light: o.light, frame: o.trim, bars: true });
    if (o.accent !== undefined) panel(b, o.wf * 0.7, 0.03, o.x, row.y - row.h / 2 - 0.03, o.z + o.p + 0.003, 0, o.accent);
  }
  for (const y of o.bands ?? []) prismY(b, growBay(o.x, o.z, o.wf, o.p, 0.008), y - 0.008, y + 0.008, o.trim, [3]);
  prismY(b, growBay(o.x, o.z, o.wf, o.p, 0.018), o.y1, o.y1 + 0.022, o.trim, [3]);
  if (o.brackets) {
    for (const s of [-1, 1]) b.box(0.016, 0.03, o.p * 0.8, o.x + s * (o.wf / 2 - 0.01), o.y0 - 0.03, o.z + o.p * 0.4, o.trim);
  }
}

/** Heavy cornice: frieze band, a row of brackets, and a crown that overhangs the facade. */
function cornice(b: GeoBuilder, x: number, w: number, y: number, z: number, proj: number, crown: ColorLike, bracket: ColorLike, n: number, frieze?: ColorLike) {
  if (frieze !== undefined) b.box(w, 0.045, 0.008, x, y - 0.05, z + 0.004, frieze);
  for (let k = 0; k < n; k++) {
    const bx = x - w / 2 + ((k + 0.5) * w) / n;
    b.box(0.014, 0.036, proj - 0.01, bx, y - 0.036, z + (proj - 0.01) / 2, bracket);
  }
  b.box(w + 0.016, 0.024, proj + 0.012, x, y, z + (proj - 0.012) / 2, crown);
  b.box(w + 0.026, 0.009, proj + 0.022, x, y + 0.024, z + (proj - 0.012) / 2 + 0.005, crown);
}

/** Straight stair rising along z from its foot (at zFoot, ground) to its head. Solid masonry or timber. */
function stairZ(b: GeoBuilder, x: number, w: number, zFoot: number, zHead: number, rise: number, n: number, color: ColorLike, y0 = G, tread?: ColorLike) {
  for (let k = 0; k < n; k++) {
    const za = zFoot + ((zHead - zFoot) * k) / n;
    const zb = zFoot + ((zHead - zFoot) * (k + 1)) / n;
    const h = (rise * (k + 1)) / n;
    b.box(w, h, Math.abs(zb - za) + 0.001, x, y0, (za + zb) / 2, k % 2 ? color : mul(color, 0.95));
    if (tread !== undefined) b.decal(w, Math.abs(zb - za), x, y0 + h + 0.0008, (za + zb) / 2, tread);
  }
}

/** Straight stair rising along x. */
function stairX(b: GeoBuilder, z: number, d: number, xFoot: number, xHead: number, rise: number, n: number, color: ColorLike, y0 = G, tread?: ColorLike) {
  for (let k = 0; k < n; k++) {
    const xa = xFoot + ((xHead - xFoot) * k) / n;
    const xb = xFoot + ((xHead - xFoot) * (k + 1)) / n;
    const h = (rise * (k + 1)) / n;
    b.box(Math.abs(xb - xa) + 0.001, h, d, (xa + xb) / 2, y0, z, k % 2 ? color : mul(color, 0.95));
    if (tread !== undefined) b.decal(Math.abs(xb - xa), d, (xa + xb) / 2, y0 + h + 0.0008, z, tread);
  }
}

/** A foliage mass: a flat-shaded icosahedron, two-tone (sunlit tops, shaded undersides) with leafy jitter. */
function crown(b: GeoBuilder, x: number, y: number, z: number, rx: number, ry: number, rz: number, color: ColorLike, detail = 0, light?: ColorLike) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  g.scale(rx, ry, rz);
  g.translate(x, y, z);
  const base = lin(color);
  const hi = light === undefined ? mix(mul(color, 1.25), [0.9, 0.85, 0.35], 0.12) : lin(light);
  add(b, g, (cx, cy, cz, _nx, ny) => {
    const t = Math.max(0, ny) * 0.75;
    const k = 0.78 + 0.18 * (ny * 0.5 + 0.5) + (noise(cx, cy, cz) - 0.5) * 0.16;
    return [(base[0] + (hi[0] - base[0]) * t) * k, (base[1] + (hi[1] - base[1]) * t) * k, (base[2] + (hi[2] - base[2]) * t) * k];
  });
}

/** Small shrub/flower clump (8 triangles). */
function shrub(b: GeoBuilder, x: number, y: number, z: number, rad: number, color: ColorLike, squash = 0.8) {
  const g = new THREE.OctahedronGeometry(1);
  g.scale(rad, rad * squash, rad);
  g.rotateY(0.4);
  g.translate(x, y + rad * squash * 0.7, z);
  const base = lin(color);
  add(b, g, (_x, _y, _z, _nx, ny) => mul(base, 0.8 + 0.3 * Math.max(0, ny)));
}

// ─── Vegetation ───────────────────────────────────────────────────────────

/**
 * 'palm' Canary/Mexican fan palm; 'round' generic street tree; 'cypress'
 * wind-shaped Monterey cypress; 'plane' London plane (the downtown street
 * tree); 'ficus' clipped Indian laurel fig; 'eucalyptus' tall blue gum.
 */
export type TreeKind = 'palm' | 'round' | 'cypress' | 'plane' | 'ficus' | 'eucalyptus';

/** Prevailing wind off the Pacific: Monterey cypresses stream east. */
const WIND = { x: 0.96, z: 0.28 };

/** ~110 triangles: curved ringed trunk, crown shaft, coconuts, seven arching fronds (one may hang dead). */
export function palm(b: GeoBuilder, r: () => number, x: number, z: number, scale = 1, y = 0) {
  const s = scale * (0.85 + r() * 0.4);
  const h = 1.05 * s;
  const lean = r() * Math.PI * 2;
  const bend = (0.05 + r() * 0.1) * h;
  const lx = Math.cos(lean);
  const lz = Math.sin(lean);
  const pt = (t: number): V => [x + lx * bend * t * t, y + h * t, z + lz * bend * t * t];
  const segs = 4;
  for (let k = 0; k < segs; k++) {
    const t0 = k / segs;
    const t1 = (k + 1) / segs;
    limb(b, pt(t0), pt(Math.min(1, t1 + 0.012)), 0.036 * s * (1 - t0 * 0.38) + (k === 0 ? 0.008 * s : 0), 0.036 * s * (1 - t1 * 0.38), k % 2 ? PALETTE.palmTrunk : mul(PALETTE.palmTrunk, 0.84));
  }
  const top = pt(1);
  limb(b, [top[0], top[1] - 0.05 * s, top[2]], [top[0], top[1] + 0.02 * s, top[2]], 0.03 * s, 0.02 * s, 0x6e7a3c);
  const nut = new THREE.OctahedronGeometry(0.032 * s);
  nut.translate(top[0], top[1] - 0.03 * s, top[2]);
  add(b, nut, 0x9a6e2c);

  const t = new Tris();
  const frond = pick(r, PALETTE.fronds);
  const c0 = mul(frond, 0.62);
  const c1 = lin(frond);
  const c2 = mix(mul(frond, 1.18), [0.85, 0.85, 0.3], 0.18);
  const deadC = lin(0xb59a5c);
  const n = 7;
  const spin = r() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const az = spin + (i / n) * Math.PI * 2 + r() * 0.45;
    const dead = i === 0 && r() < 0.45;
    const L = (0.34 + r() * 0.1) * s;
    const a1 = dead ? -0.9 : 0.25 + r() * 0.35;
    const a2 = dead ? -1.35 : -(0.3 + r() * 0.35);
    const fx = Math.cos(az);
    const fz = Math.sin(az);
    const P0: V = [top[0] + fx * 0.012 * s, top[1] + 0.012 * s, top[2] + fz * 0.012 * s];
    const P1: V = [P0[0] + fx * Math.cos(a1) * L * 0.48, P0[1] + Math.sin(a1) * L * 0.48, P0[2] + fz * Math.cos(a1) * L * 0.48];
    const P2: V = [P1[0] + fx * Math.cos(a2) * L * 0.56, P1[1] + Math.sin(a2) * L * 0.56, P1[2] + fz * Math.cos(a2) * L * 0.56];
    const hw = (dead ? 0.025 : 0.056) * s;
    const fold = hw * 0.5;
    const E1L: V = [P1[0] - fz * hw, P1[1] - fold, P1[2] + fx * hw];
    const E1R: V = [P1[0] + fz * hw, P1[1] - fold, P1[2] - fx * hw];
    const w0 = 0.012 * s;
    const E0L: V = [P0[0] - fz * w0, P0[1], P0[2] + fx * w0];
    const E0R: V = [P0[0] + fz * w0, P0[1], P0[2] - fx * w0];
    const a = dead ? deadC : c0;
    const m = dead ? deadC : c1;
    const e = dead ? mul(deadC, 0.85) : c2;
    t.tri(P0, E0L, E1L, a, a, m, UP, dead);
    t.tri(P0, E1L, P1, a, m, m, UP, dead);
    t.tri(P0, P1, E1R, a, m, m, UP, dead);
    t.tri(P0, E1R, E0R, a, m, a, UP, dead);
    t.tri(P1, E1L, P2, m, m, e, undefined, true);
    t.tri(P1, P2, E1R, m, e, m, undefined, true);
  }
  t.flush(b);
}

export function tree(b: GeoBuilder, r: () => number, x: number, z: number, scale = 1, y = 0, kind?: TreeKind) {
  const k: TreeKind = kind ?? (r() < 0.45 ? 'palm' : r() < 0.75 ? 'round' : 'cypress');
  if (k === 'palm') return palm(b, r, x, z, scale, y);
  const s = scale * (0.8 + r() * 0.4);
  const turn = r() * Math.PI * 2;
  const ox = Math.cos(turn);
  const oz = Math.sin(turn);
  switch (k) {
    case 'cypress': {
      // Monterey cypress: a short twisting trunk and flat, wind-sheared tiers streaming downwind.
      const c = pick(r, PALETTE.pine);
      const mid: V = [x + WIND.x * 0.03 * s, y + 0.2 * s, z + WIND.z * 0.03 * s];
      limb(b, [x, y, z], mid, 0.045 * s, 0.032 * s, 0x6e5640);
      limb(b, mid, [x + WIND.x * 0.09 * s, y + 0.36 * s, z + WIND.z * 0.09 * s], 0.032 * s, 0.018 * s, PALETTE.trunk);
      limb(b, mid, [x - WIND.x * 0.06 * s + oz * 0.03 * s, y + 0.3 * s, z - WIND.z * 0.06 * s - ox * 0.03 * s], 0.022 * s, 0.012 * s, PALETTE.trunk, 4);
      crown(b, x + WIND.x * 0.1 * s, y + 0.4 * s, z + WIND.z * 0.1 * s, 0.25 * s, 0.085 * s, 0.19 * s, c);
      crown(b, x + WIND.x * 0.2 * s, y + 0.33 * s, z + WIND.z * 0.2 * s + oz * 0.04 * s, 0.16 * s, 0.07 * s, 0.14 * s, mul(c, 1.08));
      crown(b, x - WIND.x * 0.07 * s, y + 0.32 * s, z - WIND.z * 0.07 * s, 0.14 * s, 0.07 * s, 0.13 * s, mul(c, 0.9));
      return;
    }
    case 'plane': {
      // London plane: pale mottled trunk, forked limbs, a tall rounded crown of fresh green.
      const top: V = [x, y + 0.3 * s, z];
      limb(b, [x, y, z], [x, y + 0.16 * s, z], 0.036 * s, 0.03 * s, 0x8f8670);
      limb(b, [x, y + 0.16 * s, z], top, 0.03 * s, 0.024 * s, 0xc9c2a2);
      limb(b, top, [x + ox * 0.08 * s, y + 0.44 * s, z + oz * 0.08 * s], 0.018 * s, 0.01 * s, 0xc9c2a2, 4);
      limb(b, top, [x - ox * 0.07 * s, y + 0.46 * s, z - oz * 0.07 * s], 0.018 * s, 0.01 * s, 0xb5ad8f, 4);
      const c = pick(r, [0x79a845, 0x86b44c, 0x6d9c40] as const);
      crown(b, x, y + 0.5 * s, z, 0.17 * s, 0.19 * s, 0.17 * s, c);
      crown(b, x + ox * 0.1 * s, y + 0.44 * s, z + oz * 0.1 * s, 0.12 * s, 0.11 * s, 0.12 * s, mul(c, 1.06));
      crown(b, x - ox * 0.09 * s, y + 0.6 * s, z - oz * 0.09 * s, 0.1 * s, 0.1 * s, 0.1 * s, mul(c, 1.1));
      return;
    }
    case 'ficus': {
      // Indian laurel fig: short trunk, a dense, clipped, glossy dome.
      limb(b, [x, y, z], [x, y + 0.2 * s, z], 0.034 * s, 0.026 * s, 0x7d7465);
      const c = pick(r, [0x3e7a38, 0x447f3a, 0x37703a] as const);
      crown(b, x, y + 0.32 * s, z, 0.17 * s, 0.14 * s, 0.17 * s, c, 1, mix(c, 0xb8d870, 0.35));
      return;
    }
    case 'eucalyptus': {
      // Blue gum: tall pale trunk, sparse blue-grey tufts.
      const lean = 0.06 * s;
      const mid: V = [x + ox * lean * 0.4, y + 0.42 * s, z + oz * lean * 0.4];
      const top: V = [x + ox * lean, y + 0.78 * s, z + oz * lean];
      limb(b, [x, y, z], mid, 0.034 * s, 0.026 * s, 0xb8ab90);
      limb(b, mid, top, 0.026 * s, 0.014 * s, 0xd9d0bb);
      limb(b, mid, [x - ox * 0.12 * s, y + 0.6 * s, z - oz * 0.1 * s], 0.014 * s, 0.008 * s, 0xcfc5ad, 4);
      const c = pick(r, [0x7f9e86, 0x6f9177, 0x8aa88c] as const);
      crown(b, top[0], top[1] - 0.04 * s, top[2], 0.13 * s, 0.17 * s, 0.11 * s, c);
      crown(b, x - ox * 0.13 * s, y + 0.58 * s, z - oz * 0.11 * s, 0.1 * s, 0.13 * s, 0.09 * s, mul(c, 0.92));
      crown(b, mid[0] + oz * 0.1 * s, y + 0.47 * s, mid[2] - ox * 0.1 * s, 0.08 * s, 0.11 * s, 0.075 * s, mul(c, 1.05));
      return;
    }
    default: {
      // Round street tree: forked trunk and a layered, two-tone canopy.
      const leaves = pick(r, PALETTE.leaves);
      limb(b, [x, y, z], [x, y + 0.26 * s, z], 0.042 * s, 0.03 * s, PALETTE.trunk);
      limb(b, [x, y + 0.2 * s, z], [x + ox * 0.08 * s, y + 0.34 * s, z + oz * 0.08 * s], 0.018 * s, 0.01 * s, PALETTE.trunk, 4);
      crown(b, x, y + 0.4 * s, z, 0.21 * s, 0.17 * s, 0.21 * s, leaves);
      crown(b, x + ox * 0.11 * s, y + 0.5 * s, z + oz * 0.11 * s - 0.03 * s, 0.14 * s, 0.13 * s, 0.14 * s, mul(leaves, 1.1));
      crown(b, x - ox * 0.1 * s + 0.02 * s, y + 0.47 * s, z - oz * 0.1 * s + 0.05 * s, 0.13 * s, 0.11 * s, 0.13 * s, mul(leaves, 0.92));
    }
  }
}

// ─── Homes (one per customer, in lot-local space, door facing +z) ─────────

/** Top of the lot's ground slab. */
const G = 0.03;
/** The street wall: every home's main facade stands here. */
const FRONT = 0.3;
/** Rear wall of the houses; backyards run from here to the rear fence. */
const BACK = -0.3;
/** Where the lot meets the sidewalk. */
const LOT_FRONT = 0.4;

/** Sunset District and Marina stucco, from cream to the pastel mints and pinks. */
const STUCCO = [0xf3e3c3, 0xf2d2b6, 0xedc9c3, 0xcfe3d3, 0xc8d8e8, 0xf1e4a6, 0xdcd0e8, 0xf7f3ea, 0xe8d8b6, 0xbcdad2, 0xf0c7a4, 0xe3e6d0] as const;
const MED = [0xf4e8cf, 0xf2ddc0, 0xefe2cf, 0xf6eee0, 0xecd2bd, 0xe9dcc4, 0xf3d9c9] as const;
const TILE = [0xc8643c, 0xb9563a, 0xd47a4c, 0xa94e32] as const;
const SLATE = [0x4c5563, 0x5d4f4a, 0x56606a, 0x6c5f58, 0x3f4a55] as const;
const DOORS = [0x7a2e2a, 0x2f4f6f, 0x2f6a5a, 0x6b4a3a, 0x24272c, 0xc8962e, 0x5a3f6e] as const;
const WHITE = 0xfbf8f2;
const CONCRETE = 0xd6d0c3;
const IRON = 0x26282d;
/** Flat roofs: pale cool-roof coatings and weathered tar. */
const ROOF_TAR = [0xcfc9bf, 0xc2bcb2, 0xdcd7ce, 0xb6b0a7, 0xd2cbbd] as const;
const FENCE = 0xb0906a;
const SOIL = 0x6b5238;
const FLOWERS = [0xe0607a, 0xf0c040, 0x9b7fd8, 0xf08a4b, 0xffffff, 0x6fa8e8, 0xd94f4f] as const;

/** Painted-lady colour schemes: body, trim, accent. */
interface Scheme {
  body: number;
  trim: number;
  accent: number;
}
const LADIES: readonly Scheme[] = [
  { body: 0x8fb8a0, trim: 0xf5ecd7, accent: 0x8a3b3b },
  { body: 0x7fa7cf, trim: 0xfbf8f2, accent: 0xd9a441 },
  { body: 0xe7a7b4, trim: 0xfbf3e4, accent: 0x7d3c5a },
  { body: 0xf2cf6b, trim: 0xffffff, accent: 0x3f7d5a },
  { body: 0xb9a3d6, trim: 0xfbf8f2, accent: 0x4d7f8f },
  { body: 0x5f9ea0, trim: 0xf3e3c3, accent: 0xb5523b },
  { body: 0xeaa271, trim: 0xfbf3e4, accent: 0x355c7d },
  { body: 0xdfe6ea, trim: 0x2f4858, accent: 0xc0392b },
  { body: 0x4a6b8a, trim: 0xf5ecd7, accent: 0xd9a441 },
  { body: 0x9fb07a, trim: 0xf2e6c9, accent: 0x7a3b2e },
  { body: 0xd96c5f, trim: 0xf8efdc, accent: 0x2f4f4f },
];

function windowLight(r: () => number): ColorLike {
  // Mostly warm lamps; now and then the blue of a television.
  return r() < 0.12 ? mul(PALETTE.windowCool, 0.9 + r() * 0.2) : warmth(r);
}

function porchLight(b: GeoBuilder, x: number, y: number, z: number) {
  b.box(0.016, 0.02, 0.016, x, y, z, PALETTE.lamp, true);
  b.box(0.022, 0.006, 0.022, x, y + 0.02, z, IRON);
}

export function home(kind: HomeKind, seed: number): Built {
  const r = rng(seed);
  const b = new GeoBuilder();
  // The lot: lawn from the rear fence up to the sidewalk.
  b.box(1, G, LOT_FRONT + 0.5, 0, 0, (LOT_FRONT - 0.5) / 2, mix(PALETTE.lawn, PALETTE.grassDark, 0.35 + r() * 0.3));

  if (kind === 'house') {
    const style = r();
    if (style < 0.45) sunset(b, r);
    else if (style < 0.7) marina(b, r);
    else cottage(b, r);
    backyard(b, r, BACK);
  } else if (kind === 'townhouse') {
    townhouses(b, r);
    backyard(b, r, BACK);
  } else {
    apartment(b, r);
  }
  return b.build();
}

/** Rear fence, a side fence, and a little life: a lemon tree, a patio, raised beds, a deck. */
function backyard(b: GeoBuilder, r: () => number, zWall: number) {
  const z0 = -0.49;
  b.box(1, 0.07, 0.012, 0, G, z0, FENCE);
  b.box(0.012, 0.07, zWall - z0, 0.494, G, (z0 + zWall) / 2, mul(FENCE, 0.92));
  const zm = (z0 + zWall) / 2;
  const roll = r();
  if (roll < 0.3) {
    // Patio, table and umbrella
    b.decal(0.34, zWall - z0 - 0.04, -0.2, G + 0.001, zm, 0xcfc4b4);
    b.cylinder(0.04, 0.04, 0.006, -0.2, G + 0.045, zm, 0xf4f1ea, 8);
    b.cylinder(0.005, 0.005, 0.12, -0.2, G, zm, IRON, 4);
    b.cylinder(0.003, 0.09, 0.035, -0.2, G + 0.11, zm, pick(r, [0xd9534f, 0x2f8f9d, 0xf2c84b, 0xf4f1ea] as const), 6);
  } else if (roll < 0.55) {
    // Raised vegetable beds
    for (const bx of [-0.25, 0.05]) {
      b.box(0.22, 0.035, 0.08, bx, G, zm, 0x9a7650);
      for (let k = 0; k < 3; k++) shrub(b, bx - 0.07 + k * 0.07, G + 0.03, zm, 0.028, k % 2 ? 0x6fb84a : 0x4f9a3a, 0.6);
    }
  } else if (roll < 0.75) {
    // A small timber deck with a bench
    b.box(0.4, 0.02, zWall - z0 - 0.02, 0.1, G, zm, 0xa27a54);
    b.box(0.16, 0.03, 0.04, 0.12, G + 0.02, zm - 0.03, 0x7a5a3a);
  }
  if (r() < 0.6) tree(b, r, -0.32 + r() * 0.6, zm, 0.45 + r() * 0.15, G, pick(r, ['round', 'round', 'plane', 'ficus', 'palm'] as const));
}

/** Low planting in front of a facade: a hedge or a bed of flowers between x0 and x1. */
function frontGarden(b: GeoBuilder, r: () => number, x0: number, x1: number, z0 = FRONT, z1 = LOT_FRONT - 0.01) {
  const w = x1 - x0;
  if (w < 0.05) return;
  const zc = (z0 + z1) / 2;
  if (r() < 0.45) {
    b.box(w - 0.01, 0.04, Math.min(0.05, z1 - z0 - 0.01), (x0 + x1) / 2, G, zc, pick(r, [0x4f8f3e, 0x5c9c46, 0x3f7f3a] as const));
  } else {
    b.box(w - 0.01, 0.012, z1 - z0 - 0.01, (x0 + x1) / 2, G, zc, SOIL);
    const n = Math.max(1, Math.floor(w / 0.06));
    for (let k = 0; k < n; k++) shrub(b, x0 + ((k + 0.5) * w) / n, G + 0.01, zc + (r() - 0.5) * 0.02, 0.022 + r() * 0.01, k % 2 ? pick(r, FLOWERS) : 0x5c9c46);
  }
}

/** Flat roof membrane, party-wall copings, a skylight and sometimes solar panels. */
function flatRoof(b: GeoBuilder, r: () => number, w: number, z0: number, z1: number, y: number, coping: ColorLike, x = 0) {
  const d = z1 - z0;
  const zc = (z0 + z1) / 2;
  b.box(w - 0.02, 0.006, d - 0.02, x, y, zc, pick(r, ROOF_TAR));
  for (const s of [-1, 1]) b.box(0.018, 0.024, d, x + s * (w / 2 - 0.009), y, zc, coping);
  b.box(w, 0.024, 0.018, x, y, z0 + 0.009, coping);
  const span = w / 2 - 0.12;
  if (r() < 0.45) {
    // Solar panels, tilted to the south (−z)
    for (let k = 0; k < 2; k++) {
      const g = new THREE.BoxGeometry(0.2, 0.006, 0.12);
      g.rotateX(0.35);
      g.translate(x + (k - 0.5) * Math.min(0.24, w * 0.45), y + 0.04, zc - 0.05);
      add(b, g, 0x2a3f66, 'glass');
    }
  } else {
    const sx = x + (r() - 0.5) * 2 * span;
    b.box(0.08, 0.02, 0.08, sx, y, zc - 0.05, 0xd8d4cc);
    b.decal(0.06, 0.06, sx, y + 0.022, zc - 0.05, 0x8fb4d0, 'glass');
  }
  b.cylinder(0.008, 0.008, 0.05, x + (r() - 0.5) * 2 * span, y, zc + 0.1, 0x9aa0a8, 4);
}

/**
 * Sunset District "Doelger" home: garage at the street, the living floor above
 * with a bay or picture window, stairs along the facade to an arched door, and
 * a parapet: Spanish tile, stepped mission, or a storybook gable.
 */
function sunset(b: GeoBuilder, r: () => number) {
  const wall = pick(r, STUCCO);
  const trim: ColorLike = r() < 0.65 ? WHITE : mul(wall, 0.72);
  const tile = pick(r, TILE);
  const light = windowLight(r);
  const s = r() < 0.5 ? 1 : -1;
  const w = 0.97;
  const gH = 0.19;
  const lH = 0.25;
  const yL = G + gH;
  const top = yL + lH;
  const d = FRONT - BACK;
  b.box(w, top - G, d, 0, G, 0, wall);
  b.box(w + 0.004, 0.024, d + 0.004, 0, G, 0, mul(wall, 0.8));
  b.box(w + 0.008, 0.014, 0.012, 0, yL - 0.012, FRONT + 0.004, trim);

  // Garage
  const gx = -s * 0.2;
  const gw = 0.3;
  const gh = 0.15;
  const gcol = pick(r, [WHITE, 0xd9cdb8, 0x9c7a58, 0x6f7f8f] as const);
  panel(b, gw + 0.036, gh + 0.02, gx, G + (gh + 0.02) / 2, FRONT + 0.002, 0, trim);
  panel(b, gw, gh, gx, G + gh / 2, FRONT + 0.004, 0, gcol);
  for (let k = 1; k < 4; k++) panel(b, gw, 0.005, gx, G + (gh * k) / 4, FRONT + 0.0055, 0, mul(gcol, 0.72));
  if (r() < 0.6) for (let k = 0; k < 4; k++) panel(b, 0.052, 0.022, gx + (k - 1.5) * 0.07, G + gh * 0.83, FRONT + 0.006, 0, PALETTE.darkGlass);
  b.decal(gw + 0.04, LOT_FRONT - FRONT, gx, G + 0.0012, (FRONT + LOT_FRONT) / 2, CONCRETE);
  porchLight(b, gx + (gw / 2 + 0.035) * s, G + 0.13, FRONT + 0.01);

  // Stairs climb along the facade to the living floor.
  const sd = 0.075;
  const stepCol = r() < 0.55 ? 0xb4563c : r() < 0.5 ? 0x8a8f96 : 0xd8cfc0;
  const stairWall = mul(wall, 0.9);
  stairX(b, FRONT + sd / 2, sd, s * 0.02, s * 0.36, gH, 7, stairWall, G, stepCol);
  b.box(0.125, gH, sd, s * 0.4225, G, FRONT + sd / 2, stairWall);
  b.decal(0.125, sd, s * 0.4225, yL + 0.0008, FRONT + sd / 2, stepCol);
  const railZ = FRONT + sd - 0.004;
  beam(b, [s * 0.02, G + gH / 7 + 0.055, railZ], [s * 0.36, yL + 0.055, railZ], 0.006, 0.008, IRON);
  beam(b, [s * 0.36, yL + 0.055, railZ], [s * 0.485, yL + 0.055, railZ], 0.006, 0.008, IRON);
  for (const px of [0.02, 0.19, 0.36, 0.48]) {
    const py = px <= 0.36 ? G + (gH * (px - 0.02)) / 0.34 + gH / 7 : yL;
    b.box(0.006, 0.055, 0.006, s * px, Math.max(G, py), railZ, IRON);
  }
  // Arched front door with a tiled hood and a lamp
  const xd = s * 0.43;
  archPanel(b, 0.095, 0.16, 0.04, xd, yL + 0.08, FRONT + 0.002, 0, trim);
  archPanel(b, 0.07, 0.14, 0.03, xd, yL + 0.07, FRONT + 0.004, 0, pick(r, DOORS));
  porchLight(b, s * 0.375, yL + 0.1, FRONT + 0.01);
  {
    const t = new Tris();
    tiles(t, [xd - 0.07, yL + 0.165, FRONT + 0.04], [xd + 0.07, yL + 0.165, FRONT + 0.04], [xd + 0.07, yL + 0.19, FRONT], [xd - 0.07, yL + 0.19, FRONT], 5, tile, r, 0.004);
    t.flush(b);
  }

  // Living floor: an angled bay or a big picture window over the garage
  const pictured = r() < 0.45;
  if (!pictured) {
    bay(b, r, { x: gx, z: FRONT, y0: yL + 0.01, y1: top - 0.04, wf: 0.2, p: 0.055, wall, trim, rows: [{ y: yL + 0.11, h: 0.13 }], lit: 0.75, light, brackets: true });
  } else {
    const pw = 0.3;
    const ph = 0.14;
    const py = yL + 0.11;
    panel(b, pw + 0.03, ph + 0.03, gx, py, FRONT + 0.002, 0, trim);
    panel(b, pw, ph, gx, py, FRONT + 0.004, 0, light, 'glow', r() < 0.8 ? 0.12 + r() * 0.6 : 2);
    for (const m of [-1, 1]) panel(b, 0.009, ph, gx + (m * pw) / 6, py, FRONT + 0.006, 0, trim);
    b.box(pw + 0.05, 0.014, 0.025, gx, py - ph / 2 - 0.022, FRONT + 0.012, trim);
  }
  win(b, r, s * 0.2, yL + 0.12, FRONT, 0, { w: 0.06, h: 0.11, arch: 0.025, frame: trim, lit: 0.6, light, sill: trim });
  b.box(0.012, top - G, 0.012, -s * 0.478, G, FRONT + 0.006, mul(wall, 0.78));
  b.box(0.026, 0.032, 0.014, s * 0.475, yL + 0.07, FRONT + 0.007, pick(r, [IRON, 0xb08d57] as const));

  // Roof line
  flatRoof(b, r, w, BACK, FRONT - 0.03, top, mul(wall, 0.9));
  const style = r();
  if (!pictured && style >= 0.4 && r() < 0.6) {
    // A tiled hat on the bay
    const t = new Tris();
    tiles(t, [gx - 0.18, top - 0.016, FRONT + 0.085], [gx + 0.18, top - 0.016, FRONT + 0.085], [gx + 0.18, top + 0.022, FRONT], [gx - 0.18, top + 0.022, FRONT], 8, tile, r);
    t.flush(b);
  }
  if (style < 0.4) {
    // Spanish tile pent roof along the parapet
    b.box(w, 0.05, 0.035, 0, top, FRONT - 0.0175, wall);
    const t = new Tris();
    tiles(t, [-w / 2 - 0.005, top - 0.012, FRONT + 0.052], [w / 2 + 0.005, top - 0.012, FRONT + 0.052], [w / 2 + 0.005, top + 0.05, FRONT - 0.002], [-w / 2 - 0.005, top + 0.05, FRONT - 0.002], 16, tile, r);
    t.flush(b);
    b.box(w + 0.01, 0.012, 0.012, 0, top - 0.024, FRONT + 0.046, mul(tile, 0.7));
  } else if (style < 0.75) {
    // Stepped mission parapet with coping
    b.box(w, 0.04, 0.03, 0, top, FRONT - 0.015, wall);
    b.box(0.36, 0.04, 0.03, gx, top + 0.04, FRONT - 0.015, wall);
    b.box(0.2, 0.025, 0.03, gx, top + 0.08, FRONT - 0.015, wall);
    b.box(w + 0.012, 0.01, 0.038, 0, top + 0.04, FRONT - 0.015, trim);
    b.box(0.37, 0.01, 0.038, gx, top + 0.08, FRONT - 0.015, trim);
    b.box(0.21, 0.01, 0.038, gx, top + 0.105, FRONT - 0.015, trim);
    if (pictured) {
      const t = new Tris();
      tiles(t, [gx - 0.2, yL + 0.205, FRONT + 0.045], [gx + 0.2, yL + 0.205, FRONT + 0.045], [gx + 0.2, yL + 0.235, FRONT], [gx - 0.2, yL + 0.235, FRONT], 8, tile, r);
      t.flush(b);
    }
  } else {
    // Storybook: a steep tiled gable over the garage half
    const gw2 = 0.48;
    const rise = 0.2;
    const zb = FRONT - 0.32;
    prismZ(b, [[gx - gw2 / 2, top], [gx + gw2 / 2, top], [gx, top + rise]], zb, FRONT, wall);
    const t = new Tris();
    const ov = 0.035;
    for (const sd2 of [-1, 1]) {
      const ex = gx + sd2 * (gw2 / 2 + ov);
      const ey = top - (ov * rise) / (gw2 / 2) + 0.008;
      tiles(t, [ex, ey, FRONT + 0.035], [ex, ey, zb - 0.02], [gx, top + rise + 0.012, zb - 0.02], [gx, top + rise + 0.012, FRONT + 0.035], 9, tile, r);
    }
    t.flush(b);
    for (const sd2 of [-1, 1]) beam(b, [gx + sd2 * (gw2 / 2 + 0.02), top - 0.012, FRONT + 0.028], [gx, top + rise + 0.004, FRONT + 0.028], 0.014, 0.022, trim);
    win(b, r, gx, top + 0.07, FRONT, 0, { w: 0.05, h: 0.06, arch: 0.025, frame: trim, lit: 0.4, light });
    b.box(w - gw2, 0.04, 0.03, s * (gw2 / 2), top, FRONT - 0.015, wall);
    b.box(w - gw2 + 0.01, 0.01, 0.036, s * (gw2 / 2), top + 0.04, FRONT - 0.015, trim);
  }
  b.box(0.05, 0.09, 0.05, s * 0.36, top, BACK + 0.06, mul(wall, 0.85));

  // Back: windows, a back door and timber stairs down to the yard
  b.windows({ w, d, x: 0, z: 0, y0: yL, rows: 1, rowHeight: lH, cols: 3, faces: ['z-'] }, r, 0.6, light, { w: 0.09, h: 0.11 }, trim);
  panel(b, 0.07, 0.13, -s * 0.3, G + 0.065, BACK - 0.003, Math.PI, pick(r, DOORS));
  stairZ(b, s * 0.36, 0.07, BACK - 0.13, BACK - 0.06, gH, 5, 0xa27a54);
  b.box(0.1, 0.012, 0.06, s * 0.36, yL - 0.012, BACK - 0.03, 0xa27a54);
  for (const k of [-1, 1]) b.box(0.01, gH - 0.012, 0.01, s * 0.36 + k * 0.045, G, BACK - 0.055, 0x8a6440);

  // Front planting beside the driveway
  if (s > 0) frontGarden(b, r, -0.485, gx - gw / 2 - 0.02);
  else frontGarden(b, r, gx + gw / 2 + 0.02, 0.485);
}

/**
 * Marina-style Mediterranean: cream stucco, red tile, arched windows and
 * doors, iron balconettes and shutters, two floors over an arched garage.
 */
function marina(b: GeoBuilder, r: () => number) {
  const wall = pick(r, MED);
  const trim: ColorLike = r() < 0.55 ? 0xfbf6ea : mul(wall, 0.86);
  const tile = pick(r, TILE);
  const light = windowLight(r);
  const shutters = r() < 0.5 ? pick(r, [0x4f7a6a, 0x3f5f7f, 0x6b4a3a, 0x7a8f5a] as const) : undefined;
  const s = r() < 0.5 ? 1 : -1;
  const w = 0.97;
  const gH = 0.19;
  const f1 = 0.24;
  const f2 = 0.22;
  const y1 = G + gH;
  const y2 = y1 + f1;
  const top = y2 + f2;
  const d = FRONT - BACK;
  b.box(w, top - G, d, 0, G, 0, wall);
  b.box(w + 0.004, 0.026, d + 0.004, 0, G, 0, mul(wall, 0.8));
  b.box(w + 0.008, 0.016, 0.014, 0, y1 - 0.008, FRONT + 0.003, trim);

  // Arched garage door, timber planks
  const gx = -s * 0.2;
  archPanel(b, 0.33, 0.175, 0.05, gx, G + 0.0875, FRONT + 0.002, 0, trim);
  const wood = pick(r, [0x8a6440, 0x6e4e34, 0x9a7a58, 0x4f5a4f] as const);
  archPanel(b, 0.3, 0.16, 0.04, gx, G + 0.08, FRONT + 0.004, 0, wood);
  for (let k = -2; k <= 2; k++) panel(b, 0.005, 0.12, gx + k * 0.05, G + 0.065, FRONT + 0.0055, 0, mul(wood, 0.7));
  b.decal(0.34, LOT_FRONT - FRONT, gx, G + 0.0012, (FRONT + LOT_FRONT) / 2, 0xcbbfae);

  // Arched entry portal with steps and two lanterns
  const ex = s * 0.32;
  archPanel(b, 0.16, 0.19, 0.075, ex, G + 0.095 + 0.02, FRONT + 0.001, 0, trim);
  archPanel(b, 0.13, 0.17, 0.06, ex, G + 0.085 + 0.02, FRONT + 0.002, 0, 0x5a4a3e);
  panel(b, 0.07, 0.12, ex, G + 0.08, FRONT + 0.004, 0, pick(r, DOORS));
  archPanel(b, 0.07, 0.035, 0.03, ex, G + 0.158, FRONT + 0.004, 0, light, 'glow', 0.15 + r() * 0.3);
  b.box(0.18, 0.02, 0.07, ex, G, FRONT + 0.035, 0xb4563c);
  b.box(0.18, 0.01, 0.095, ex, G, FRONT + 0.0475, 0xa64e36);
  for (const k of [-1, 1]) porchLight(b, ex + k * 0.1, G + 0.13, FRONT + 0.012);
  // Small grilled window between them
  const mx = s * 0.08;
  win(b, r, mx, G + 0.11, FRONT, 0, { w: 0.06, h: 0.08, frame: trim, lit: 0.4, light });
  for (let k = -1; k <= 1; k++) panel(b, 0.005, 0.08, mx + k * 0.02, G + 0.11, FRONT + 0.008, 0, IRON);

  // First floor: a tiled box bay, or a triple arcade with a balconette
  if (r() < 0.5) {
    b.box(0.4, f1 - 0.05, 0.05, gx, y1 + 0.025, FRONT + 0.025, wall);
    for (let k = -1; k <= 1; k++) win(b, r, gx + k * 0.115, y1 + 0.115, FRONT + 0.05, 0, { w: 0.08, h: 0.13, arch: 0.03, frame: trim, lit: 0.7, light, bars: true });
    for (const k of [-1, 1]) b.box(0.03, 0.03, 0.04, gx + k * 0.17, y1 - 0.005, FRONT + 0.02, trim);
    const t = new Tris();
    tiles(t, [gx - 0.22, y2 - 0.03, FRONT + 0.075], [gx + 0.22, y2 - 0.03, FRONT + 0.075], [gx + 0.22, y2 + 0.012, FRONT], [gx - 0.22, y2 + 0.012, FRONT], 9, tile, r);
    t.flush(b);
  } else {
    for (let k = -1; k <= 1; k++) win(b, r, gx + k * 0.11, y1 + 0.12, FRONT, 0, { w: 0.085, h: 0.15, arch: 0.04, frame: trim, lit: 0.7, light, bars: true });
    b.box(0.36, 0.008, 0.04, gx, y1 + 0.035, FRONT + 0.02, IRON);
    b.box(0.36, 0.006, 0.005, gx, y1 + 0.085, FRONT + 0.038, IRON);
    for (let k = 0; k <= 6; k++) b.box(0.004, 0.05, 0.004, gx - 0.18 + k * 0.06, y1 + 0.035, FRONT + 0.038, IRON);
  }
  win(b, r, ex, y1 + 0.12, FRONT, 0, { w: 0.085, h: 0.15, arch: 0.045, frame: trim, lit: 0.6, light, bars: true, sill: trim });
  // Second floor: shuttered windows, a shared balconette in the middle
  for (const x of [-0.36, -0.13, 0.13, 0.36]) win(b, r, x, y2 + 0.11, FRONT, 0, { w: 0.075, h: 0.12, frame: trim, lit: 0.6, light, bars: true, sill: trim, shutters });
  b.box(0.38, 0.008, 0.035, 0, y2 + 0.04, FRONT + 0.0175, IRON);
  b.box(0.38, 0.005, 0.005, 0, y2 + 0.085, FRONT + 0.033, IRON);
  for (let k = 0; k <= 4; k++) b.box(0.004, 0.045, 0.004, -0.19 + k * 0.095, y2 + 0.04, FRONT + 0.033, IRON);

  // Roof: tiled hip over a moulded cornice, or a parapet with a tiled pent
  if (r() < 0.6) {
    b.box(w + 0.014, 0.022, d + 0.014, 0, top - 0.022, 0, trim);
    tileHip(b, r, 0, w, 0, d, top, 0.13, tile, 0.04);
  } else {
    flatRoof(b, r, w, BACK, FRONT - 0.03, top, mul(wall, 0.9));
    b.box(w, 0.06, 0.035, 0, top, FRONT - 0.0175, wall);
    const t = new Tris();
    tiles(t, [-w / 2 - 0.005, top - 0.008, FRONT + 0.05], [w / 2 + 0.005, top - 0.008, FRONT + 0.05], [w / 2 + 0.005, top + 0.06, FRONT - 0.004], [-w / 2 - 0.005, top + 0.06, FRONT - 0.004], 16, tile, r);
    t.flush(b);
    b.box(w + 0.01, 0.014, 0.012, 0, top - 0.022, FRONT + 0.045, mul(tile, 0.7));
  }
  b.box(0.06, 0.12, 0.06, s * 0.38, top, BACK + 0.08, wall);
  b.box(0.075, 0.016, 0.075, s * 0.38, top + 0.12, BACK + 0.08, tile);

  b.windows({ w, d, x: 0, z: 0, y0: y1, rows: 2, rowHeight: f1, cols: 3, faces: ['z-'] }, r, 0.55, light, { w: 0.08, h: 0.11 });
  panel(b, 0.07, 0.13, -s * 0.3, G + 0.065, BACK - 0.003, Math.PI, pick(r, DOORS));

  // Clipped hedge with terracotta pots
  const hx0 = s > 0 ? -0.485 : gx + 0.19;
  const hx1 = s > 0 ? gx - 0.19 : 0.485;
  if (hx1 - hx0 > 0.04) b.box(hx1 - hx0, 0.045, 0.045, (hx0 + hx1) / 2, G, FRONT + 0.03, 0x4a8a3c);
  for (const k of [-1, 1]) {
    b.cylinder(0.018, 0.013, 0.03, ex + k * 0.11, G, FRONT + 0.07, 0xc0643c, 6);
    shrub(b, ex + k * 0.11, G + 0.025, FRONT + 0.07, 0.024, 0x3f7f3a, 1.3);
  }
}

/**
 * Edwardian/Victorian cottage: raised on a basement, a steep street-facing
 * gable with shingled face and bargeboards, an angled bay, a porch with stairs.
 */
function cottage(b: GeoBuilder, r: () => number) {
  const sch = pick(r, LADIES);
  const body = mix(sch.body, 0xffffff, 0.12);
  const trim = sch.trim;
  const accent = sch.accent;
  const roof = pick(r, SLATE);
  const light = windowLight(r);
  const w = 0.76 + r() * 0.08;
  const side = r() < 0.5 ? 1 : -1;
  const xo = -side * (0.485 - w / 2);
  const zF = FRONT - 0.04;
  const baseH = 0.085;
  const mH = 0.27;
  const eave = G + baseH + mH;
  const rise = 0.25;
  const d = zF - BACK;
  const zc = (zF + BACK) / 2;
  b.box(w, baseH, d, xo, G, zc, mul(body, 0.72));
  b.box(w, mH, d, xo, G + baseH, zc, body);
  prismZ(b, [[xo - w / 2, eave], [xo + w / 2, eave], [xo, eave + rise]], BACK, zF, body);
  // Shingled gable face with a trim band
  prismZ(b, [[xo - w / 2 + 0.03, eave + 0.012], [xo + w / 2 - 0.03, eave + 0.012], [xo, eave + rise - 0.025]], zF, zF + 0.006, mix(accent, body, 0.35));
  b.box(w * 0.55, 0.012, 0.012, xo, eave + rise * 0.42, zF + 0.009, trim);
  b.box(w + 0.02, 0.022, 0.028, xo, eave - 0.012, zF + 0.01, trim);
  for (let k = 0; k < 5; k++) b.box(0.012, 0.026, 0.024, xo - w / 2 + 0.03 + (k * (w - 0.06)) / 4, eave - 0.038, zF + 0.012, accent);
  gableRoof(b, xo, w, eave, rise, BACK - 0.035, zF + 0.05, roof, 0.045, 0.02);
  gableRoof(b, xo, w, eave - 0.008, rise, zF + 0.03, zF + 0.05, trim, 0.04, 0.03);
  b.box(0.012, 0.06, 0.012, xo, eave + rise - 0.01, zF + 0.04, trim);
  win(b, r, xo, eave + 0.1, zF + 0.006, 0, { w: 0.055, h: 0.07, arch: 0.027, frame: trim, lit: 0.45, light, bars: true });
  for (const [f, k] of [[0.2, 0.7], [0.66, 0.26]] as const) panel(b, w * k, 0.014, xo, eave + rise * f, zF + 0.0068, 0, mix(accent, body, 0.12));
  {
    const cx = xo - side * (w / 2 - 0.1);
    const roofAt = eave + (rise * 0.1) / (w / 2);
    b.box(0.06, roofAt + 0.13 - eave, 0.06, cx, eave, zc - 0.08, 0xa0523d);
    b.box(0.072, 0.014, 0.072, cx, roofAt + 0.13, zc - 0.08, 0x8a8f96);
  }

  // Angled bay on one side, porch and stair on the other
  const bx = xo - side * (w / 2 - 0.16);
  bay(b, r, { x: bx, z: zF, y0: G, y1: eave - 0.03, wf: 0.15, p: 0.055, wall: body, trim, accent, rows: [{ y: G + baseH + 0.13, h: 0.15 }], bands: [G + baseH], lit: 0.7, light });
  const ex = xo + side * (w / 2 - 0.095);
  const stepCol = r() < 0.5 ? mul(body, 0.7) : CONCRETE;
  b.box(0.15, baseH, 0.06, ex, G, zF + 0.03, stepCol);
  stairZ(b, ex, 0.12, LOT_FRONT - 0.005, zF + 0.06, baseH, 3, stepCol);
  for (const k of [-1, 1]) {
    const px = ex + k * 0.068;
    beam(b, [px, G + baseH / 3 + 0.05, LOT_FRONT - 0.01], [px, G + baseH + 0.05, zF + 0.06], 0.008, 0.008, trim);
    b.box(0.014, 0.19, 0.014, px, G + baseH, zF + 0.055, trim);
    b.box(0.02, 0.06, 0.02, px, G + baseH / 3, LOT_FRONT - 0.012, trim);
  }
  b.box(0.17, 0.018, 0.08, ex, G + baseH + 0.19, zF + 0.035, trim);
  b.box(0.13, 0.014, 0.01, ex, G + baseH + 0.168, zF + 0.055, accent);
  prismZ(b, [[ex - 0.09, G + baseH + 0.208], [ex + 0.09, G + baseH + 0.208], [ex, G + baseH + 0.26]], zF, zF + 0.078, roof);
  panel(b, 0.09, 0.17, ex, G + baseH + 0.085, zF + 0.002, 0, trim);
  panel(b, 0.068, 0.13, ex, G + baseH + 0.065, zF + 0.004, 0, pick(r, DOORS));
  panel(b, 0.068, 0.025, ex, G + baseH + 0.15, zF + 0.004, 0, light, 'glow', 0.1 + r() * 0.3);
  porchLight(b, ex - side * 0.05, G + baseH + 0.14, zF + 0.012);
  // A window between the bay and the porch
  const mx = (bx + side * 0.145 + ex - side * 0.08) / 2;
  if (Math.abs(ex - bx) > 0.34) win(b, r, mx, G + baseH + 0.13, zF, 0, { w: 0.065, h: 0.15, frame: trim, lit: 0.65, light, bars: true, sill: trim, head: trim });

  // Detached: windows down both sides and across the back
  b.windows({ w, d, x: xo, z: zc, y0: G + baseH, rows: 1, rowHeight: mH, cols: 3, faces: ['x+', 'x-'] }, r, 0.55, light, { w: 0.06, h: 0.11 }, trim);
  b.windows({ w, d, x: xo, z: zc, y0: G + baseH, rows: 1, rowHeight: mH, cols: 2, faces: ['z-'] }, r, 0.55, light, { w: 0.07, h: 0.12 }, trim);
  b.box(0.16, baseH, 0.07, xo + side * 0.2, G, BACK - 0.035, 0xa27a54);

  // Side path to a garden gate, and the front garden
  const pathX = side * (w / 2);
  const pw = 0.97 - w - 0.01;
  b.decal(pw, LOT_FRONT - BACK, pathX, G + 0.0012, (LOT_FRONT + BACK) / 2, CONCRETE);
  b.box(pw, 0.08, 0.012, pathX, G, zF - 0.02, FENCE);
  b.decal(0.12, LOT_FRONT - zF - 0.08, ex, G + 0.0012, (zF + LOT_FRONT + 0.08) / 2, CONCRETE);
  frontGarden(b, r, Math.min(bx, ex) + (side > 0 ? 0.15 : 0.09), Math.max(bx, ex) - (side > 0 ? 0.09 : 0.15), zF + 0.065);
  if (r() < 0.35) tree(b, r, bx, LOT_FRONT - 0.04, 0.4, G, pick(r, ['ficus', 'round'] as const));
}

/** A pair of painted ladies sharing the lot. */
function townhouses(b: GeoBuilder, r: () => number) {
  const style = pick(r, ['italianate', 'queen', 'queen', 'stick'] as const);
  const roof = pick(r, SLATE);
  const s1 = pick(r, LADIES);
  let s2 = pick(r, LADIES);
  if (s2 === s1) s2 = LADIES[(LADIES.indexOf(s1) + 3) % LADIES.length]!;
  const paired = r() < 0.6;
  const garage = r() < 0.35;
  const light = windowLight(r);
  lady(b, r, -0.2425, paired ? 1 : -1, s1, style, garage, roof, light);
  lady(b, r, 0.2425, paired ? -1 : 1, s2, style, garage, roof, light);
}

/**
 * One painted lady, uw wide: a garden level, two or three floors with a
 * stacked angled bay, a recessed porch reached by a stoop, and either a heavy
 * bracketed cornice (Italianate/Stick) or a steep shingled gable (Queen Anne).
 */
function lady(b: GeoBuilder, r: () => number, xc: number, mir: number, sch: Scheme, style: 'italianate' | 'queen' | 'stick', garage: boolean, roof: ColorLike, light: ColorLike) {
  const { body, trim, accent } = sch;
  const uw = 0.485;
  const ew = 0.15;
  const gl = 0.12;
  const fh = 0.22;
  const floors = style === 'queen' ? 2 : 3;
  const y1 = G + gl;
  const eave = y1 + floors * fh;
  const d = FRONT - BACK;
  const ex = xc + mir * (uw / 2 - ew / 2);
  const px = xc - (mir * ew) / 2;
  const pw = uw - ew;
  const rec = 0.05;
  b.box(pw - 0.002, eave - G, d, px, G, 0, body);
  b.box(ew, gl, d, ex, G, 0, body);
  b.box(ew, fh, d - rec, ex, y1, -rec / 2, body);
  b.box(ew, eave - y1 - fh, d, ex, y1 + fh, 0, body);
  b.box(uw - 0.002, 0.022, d + 0.004, xc, G, 0, mul(body, 0.72));
  // Floor bands across the facade
  for (let f = 1; f < floors; f++) b.box(uw - 0.002, 0.012, 0.01, xc, y1 + f * fh - 0.006, FRONT + 0.005, trim);

  // The bay
  const by0 = garage ? y1 + 0.004 : G;
  const rows = [] as { y: number; h: number }[];
  for (let f = 0; f < floors; f++) rows.push({ y: y1 + f * fh + fh * 0.52, h: 0.14 });
  const bands = [] as number[];
  for (let f = garage ? 1 : 0; f < floors; f++) bands.push(y1 + f * fh);
  bay(b, r, { x: px, z: FRONT, y0: by0, y1: eave - 0.035, wf: 0.15, p: 0.065, wall: body, trim, accent, rows, bands, lit: 0.72, light, brackets: garage });
  if (garage) {
    const gc = mix(accent, trim, 0.3);
    panel(b, 0.23, 0.11, px, G + 0.055, FRONT + 0.002, 0, trim);
    panel(b, 0.2, 0.095, px, G + 0.0475, FRONT + 0.004, 0, gc);
    for (let k = 1; k < 3; k++) panel(b, 0.2, 0.004, px, G + (0.095 * k) / 3, FRONT + 0.005, 0, mul(gc, 0.7));
    b.decal(0.22, LOT_FRONT - FRONT, px, G + 0.0012, (FRONT + LOT_FRONT) / 2, CONCRETE);
  } else {
    frontGarden(b, r, px - pw / 2 + 0.005, px + pw / 2 - 0.005, FRONT + 0.07);
  }

  // Top: bracketed cornice, or the Queen Anne gable
  if (style !== 'queen') {
    cornice(b, xc, uw - 0.004, eave, FRONT, 0.06, trim, accent, 6, mix(accent, body, 0.5));
    b.box(uw - 0.004, 0.035, 0.02, xc, eave + 0.033, FRONT - 0.01, body);
    flatRoof(b, r, uw, BACK, FRONT - 0.02, eave, mul(body, 0.85), xc);
    if (style === 'stick') {
      prismZ(b, [[px - 0.14, eave + 0.033], [px + 0.14, eave + 0.033], [px, eave + 0.13]], FRONT - 0.02, FRONT + 0.03, trim);
      prismZ(b, [[px - 0.11, eave + 0.042], [px + 0.11, eave + 0.042], [px, eave + 0.115]], FRONT + 0.03, FRONT + 0.034, accent);
    }
  } else {
    const rise = 0.25;
    b.box(uw, 0.024, 0.032, xc, eave - 0.012, FRONT + 0.01, trim);
    for (let k = 0; k < 4; k++) b.box(0.012, 0.028, 0.026, xc - uw / 2 + 0.04 + (k * (uw - 0.08)) / 3, eave - 0.04, FRONT + 0.013, accent);
    prismZ(b, [[xc - uw / 2 + 0.001, eave], [xc + uw / 2 - 0.001, eave], [xc, eave + rise]], BACK, FRONT, body);
    prismZ(b, [[xc - uw / 2 + 0.03, eave + 0.014], [xc + uw / 2 - 0.03, eave + 0.014], [xc, eave + rise - 0.024]], FRONT, FRONT + 0.006, mix(accent, body, 0.4));
    b.box(uw * 0.56, 0.012, 0.012, xc, eave + rise * 0.4, FRONT + 0.009, trim);
    gableRoof(b, xc, uw, eave, rise, BACK - 0.02, FRONT + 0.05, roof, 0.03, 0.018);
    gableRoof(b, xc, uw, eave - 0.008, rise, FRONT + 0.032, FRONT + 0.052, trim, 0.026, 0.028);
    b.box(0.012, 0.07, 0.012, xc, eave + rise - 0.01, FRONT + 0.04, trim);
    const chx = xc - mir * (uw / 2 - 0.07);
    const roofAt = eave + (rise * 0.07) / (uw / 2);
    b.box(0.05, roofAt + 0.12 - eave, 0.05, chx, eave, -0.12, 0x9a4e3a);
    b.box(0.06, 0.012, 0.06, chx, roofAt + 0.12, -0.12, 0x8a8f96);
    archPanel(b, 0.14, 0.04, 0.04, xc, eave + 0.135, FRONT + 0.007, 0, trim);
    win(b, r, xc, eave + 0.09, FRONT + 0.006, 0, { w: 0.08, h: 0.085, arch: 0.03, frame: accent, lit: 0.5, light, bars: true });
  }

  // Recessed porch: columns, a hood with a little pediment, door with a lit transom
  const hoodY = y1 + fh * 0.86;
  for (const k of [-1, 1]) b.box(0.016, hoodY - y1, 0.016, ex + k * (ew / 2 - 0.012), y1, FRONT - 0.008, trim);
  b.box(ew + 0.012, 0.03, 0.04, ex, hoodY, FRONT - 0.004, trim);
  prismZ(b, [[ex - ew / 2 - 0.004, hoodY + 0.03], [ex + ew / 2 + 0.004, hoodY + 0.03], [ex, hoodY + 0.075]], FRONT - 0.02, FRONT + 0.016, accent);
  const zDoor = FRONT - rec;
  panel(b, 0.088, 0.165, ex, y1 + 0.0825, zDoor + 0.002, 0, trim);
  panel(b, 0.07, 0.12, ex, y1 + 0.06, zDoor + 0.004, 0, accent);
  panel(b, 0.07, 0.03, ex, y1 + 0.142, zDoor + 0.004, 0, light, 'glow', 0.1 + r() * 0.25);
  porchLight(b, ex, hoodY - 0.04, FRONT - rec / 2);
  // The stoop, with rails and newel posts
  const stoopW = ew - 0.035;
  stairZ(b, ex, stoopW, LOT_FRONT - 0.004, FRONT, gl, 5, r() < 0.5 ? mul(body, 0.65) : 0xb9b2a5);
  for (const k of [-1, 1]) {
    const rx = ex + k * (stoopW / 2 + 0.004);
    beam(b, [rx, G + gl / 5 + 0.06, LOT_FRONT - 0.012], [rx, y1 + 0.06, FRONT - 0.005], 0.008, 0.009, trim);
    b.box(0.018, 0.07, 0.018, rx, G + gl / 5, LOT_FRONT - 0.012, accent);
    b.box(0.02, 0.008, 0.02, rx, G + gl / 5 + 0.07, LOT_FRONT - 0.012, trim);
  }
  // Tall windows above the door
  for (let f = 1; f < floors; f++) {
    win(b, r, ex, y1 + f * fh + fh * 0.52, FRONT, 0, { w: 0.065, h: 0.14, frame: trim, lit: 0.65, light, bars: true, sill: trim, head: style === 'italianate' ? trim : accent });
  }
  // Back
  b.windows({ w: uw, d, x: xc, z: 0, y0: y1, rows: floors, rowHeight: fh, cols: 2, faces: ['z-'] }, r, 0.55, light, { w: 0.07, h: 0.12 });
}

/**
 * Apartments: Edwardian flats with stacked bays, a brick walk-up, or a
 * streamline deco block; black fire escapes, a heavy cornice, an entrance
 * canopy, sometimes a corner shop, and a busy roof.
 */
function apartment(b: GeoBuilder, r: () => number) {
  const floors = 4 + Math.floor(r() * 3);
  const gH = 0.25;
  const fh = 0.21;
  const y1 = G + gH;
  const top = y1 + (floors - 1) * fh;
  const w = 0.97;
  const zB = -0.38;
  const d = FRONT - zB;
  const zc = (FRONT + zB) / 2;
  const roll = r();
  const style = roll < 0.45 ? 'edwardian' : roll < 0.75 ? 'brick' : 'deco';
  const wall: ColorLike =
    style === 'brick'
      ? pick(r, [0xa8553f, 0xb8674a, 0xc79a6b, 0x9a4a3a] as const)
      : style === 'deco'
        ? pick(r, [0xeee4d0, 0xdfe8e0, 0xf1e0d6, 0xe6e2d8] as const)
        : pick(r, [0xeee3cb, 0xf4f1ea, 0xf1e2a8, 0xb9c6cf, 0xc3d3bd, 0xe8c4bd, 0xd8cfe0] as const);
  const trim: ColorLike = style === 'brick' ? pick(r, [0xefe6d2, 0xd8d2c4] as const) : r() < 0.6 ? WHITE : mul(wall, 0.75);
  const accent: ColorLike = pick(r, [0x3f5f7f, 0x6b3a3a, 0x2f5a4a, 0x7a6a3a, 0x4a4a5a] as const);
  const light = windowLight(r);
  const lit = 0.55 + r() * 0.2;
  b.box(w, top - G, d, 0, G, zc, wall);
  b.box(w + 0.006, gH, 0.012, 0, G, FRONT + 0.003, style === 'brick' ? 0x6f6a64 : mul(wall, 0.82));
  b.box(w + 0.012, 0.02, 0.022, 0, y1 - 0.012, FRONT + 0.008, trim);
  if (style !== 'deco') for (const s of [-1, 1]) b.box(0.03, top - y1, 0.012, s * (w / 2 - 0.015), y1, FRONT + 0.006, trim);

  const ups: number[] = [];
  for (let f = 1; f < floors; f++) ups.push(y1 + (f - 1) * fh);
  let escapeX = 0;
  let escapeW = 0.22;
  if (style === 'edwardian') {
    for (const s of [-1, 1]) {
      bay(b, r, { x: s * 0.28, z: FRONT, y0: y1 + 0.006, y1: top - 0.03, wf: 0.17, p: 0.06, wall, trim, rows: ups.map((y) => ({ y: y + fh * 0.5, h: 0.13 })), bands: ups.slice(1), lit, light, brackets: true });
    }
    for (const y of ups) win(b, r, 0, y + fh * 0.5, FRONT, 0, { w: 0.08, h: 0.13, frame: trim, lit, light, bars: true, sill: trim });
    cornice(b, 0, w, top + 0.002, FRONT, 0.075, trim, trim, 9, accent);
  } else if (style === 'brick') {
    for (const y of ups) {
      for (const x of [-0.36, -0.13, 0.13, 0.36]) win(b, r, x, y + fh * 0.5, FRONT, 0, { w: 0.085, h: 0.13, frame: trim, lit, light, bars: true, sill: trim });
      // Stone lintels, one course across the facade
      for (const x of [-0.245, 0.245]) panel(b, 0.36, 0.018, x, y + fh * 0.5 + 0.083, FRONT + 0.0015, 0, trim);
    }
    for (let f = 2; f < floors; f += 2) b.box(w, 0.014, 0.018, 0, y1 + (f - 1) * fh - 0.007, FRONT + 0.009, trim);
    escapeX = r() < 0.5 ? -0.245 : 0.245;
    escapeW = 0.36;
    cornice(b, 0, w, top + 0.002, FRONT, 0.07, trim, trim, 8, trim);
  } else {
    // Deco: vertical fins over the entrance, ribbon windows with spandrels
    for (const k of [-1, 0, 1]) b.box(0.022, top + 0.12 - y1, 0.035, k * 0.045, y1, FRONT + 0.0175, trim);
    for (const y of ups) {
      for (const s of [-1, 1]) {
        win(b, r, s * 0.29, y + fh * 0.52, FRONT, 0, { w: 0.24, h: 0.12, frame: trim, lit, light });
        panel(b, 0.24, 0.006, s * 0.29, y + fh * 0.52, FRONT + 0.006, 0, trim);
        panel(b, 0.26, 0.04, s * 0.29, y + 0.02, FRONT + 0.003, 0, accent);
      }
    }
    b.box(w + 0.01, 0.04, 0.03, 0, top, FRONT - 0.005, trim);
    b.box(0.3, 0.07, 0.03, 0, top + 0.04, FRONT - 0.005, wall);
    b.box(0.31, 0.012, 0.036, 0, top + 0.11, FRONT - 0.005, trim);
    escapeX = r() < 0.5 ? -0.29 : 0.29;
    escapeW = 0.3;
  }
  fireEscape(b, escapeX, escapeW, ups.map((y) => y + 0.004), FRONT);

  // Ground floor: a corner shop, or garages and the lobby
  const shopSide = r() < 0.5 ? -1 : 1;
  const lobbyX = -shopSide * 0.33;
  if (r() < 0.5) {
    const sx = shopSide * 0.16;
    const sw = 0.6;
    const awn = pick(r, [0x2f6b4f, 0xb33a3a, 0x2f4a6b, 0x8a4a2a, 0x1f3a3a] as const);
    const glowC: ColorLike = r() < 0.6 ? [1.7, 1.25, 0.75] : [1.3, 1.5, 1.6];
    b.box(sw + 0.01, 0.035, 0.016, sx, G, FRONT + 0.008, mul(awn, 0.6));
    panel(b, sw - 0.02, 0.125, sx, G + 0.035 + 0.0625, FRONT + 0.012, 0, glowC, 'glow', 0.03);
    for (let k = 1; k < 4; k++) panel(b, 0.008, 0.125, sx - sw / 2 + (k * sw) / 4, G + 0.0975, FRONT + 0.0145, 0, mul(awn, 0.6));
    b.box(sw + 0.01, 0.045, 0.014, sx, G + 0.17, FRONT + 0.007, mul(awn, 0.55));
    panel(b, sw * 0.5, 0.016, sx, G + 0.1925, FRONT + 0.016, 0, pick(r, [[2.2, 1.6, 0.7], [2.0, 0.7, 1.2], [0.7, 1.8, 2.0]] as const), 'glow', 0.02);
    const t = new Tris();
    tiles(t, [sx - sw / 2, G + 0.165, FRONT + 0.11], [sx + sw / 2, G + 0.165, FRONT + 0.11], [sx + sw / 2, G + 0.215, FRONT + 0.004], [sx - sw / 2, G + 0.215, FRONT + 0.004], 10, awn, r, 0.004, 0xf4efe4);
    t.flush(b);
    b.box(sw, 0.022, 0.006, sx, G + 0.143, FRONT + 0.11, awn);
    // Café tables on the sidewalk strip
    for (const k of [-1, 1]) {
      b.cylinder(0.022, 0.022, 0.006, sx + k * 0.15, G + 0.045, FRONT + 0.065, 0xe8e2d6, 6);
      b.cylinder(0.004, 0.004, 0.045, sx + k * 0.15, G, FRONT + 0.065, IRON, 4);
    }
  } else {
    const gx = shopSide * 0.2;
    panel(b, 0.3, 0.17, gx, G + 0.085, FRONT + 0.011, 0, trim);
    panel(b, 0.27, 0.15, gx, G + 0.075, FRONT + 0.013, 0, 0x5b6068);
    for (let k = 1; k < 5; k++) panel(b, 0.27, 0.004, gx, G + 0.03 * k, FRONT + 0.0145, 0, 0x454a52);
    b.decal(0.3, LOT_FRONT - FRONT, gx, G + 0.0012, (FRONT + LOT_FRONT) / 2, CONCRETE);
    win(b, r, shopSide * 0.0, G + 0.13, FRONT + 0.012, 0, { w: 0.06, h: 0.08, frame: trim, lit: 0.5, light });
  }
  // Lobby: glazed door, transom, canopy and lamps
  panel(b, 0.11, 0.2, lobbyX, G + 0.1, FRONT + 0.011, 0, trim);
  panel(b, 0.085, 0.15, lobbyX, G + 0.075, FRONT + 0.013, 0, 0x3a2e28);
  panel(b, 0.05, 0.1, lobbyX, G + 0.085, FRONT + 0.0145, 0, light, 'glow', 0.05);
  panel(b, 0.085, 0.03, lobbyX, G + 0.175, FRONT + 0.013, 0, light, 'glow', 0.08);
  b.box(0.17, 0.014, 0.1, lobbyX, G + 0.205, FRONT + 0.05, accent);
  b.box(0.17, 0.02, 0.006, lobbyX, G + 0.2, FRONT + 0.1, mul(accent, 0.7));
  for (const k of [-1, 1]) porchLight(b, lobbyX + k * 0.075, G + 0.13, FRONT + 0.02);
  stairZ(b, lobbyX, 0.12, LOT_FRONT - 0.01, FRONT + 0.012, 0.03, 2, CONCRETE);

  // Sides near the back (light wells) and the back
  b.windows({ w, d: d * 0.5, x: 0, z: zB + d * 0.25, y0: y1, rows: floors - 1, rowHeight: fh, cols: 2, faces: ['x+', 'x-'] }, r, lit * 0.8, light, { w: 0.07, h: 0.1 });
  b.windows({ w, d, x: 0, z: zc, y0: y1, rows: floors - 1, rowHeight: fh, cols: 4, faces: ['z-'] }, r, lit, light, { w: 0.08, h: 0.11 });
  b.box(1, 0.07, 0.012, 0, G, -0.49, FENCE);
  for (let k = 0; k < 3; k++) b.box(0.04, 0.05, 0.04, -0.4 + k * 0.05, G, zB - 0.04, pick(r, [0x2f6a3a, 0x3a5a8a, 0x5a5f66] as const));
  if (style !== 'deco') rearPorches(b, r() < 0.5 ? -0.24 : 0.24, ups, zB, light);

  // Roof
  const rt = top;
  flatRoof(b, r, w, zB, FRONT - 0.04, rt, mul(wall, 0.88));
  const back = zB + 0.12;
  const pside = r() < 0.5 ? -1 : 1;
  b.box(0.17, 0.14, 0.15, pside * 0.33, rt, back, mul(wall, 0.92));
  b.box(0.19, 0.014, 0.17, pside * 0.33, rt + 0.14, back, 0x6f6a66);
  panel(b, 0.06, 0.1, pside * 0.33, rt + 0.05, back + 0.076, 0, 0x4a4038);
  porchLight(b, pside * 0.33, rt + 0.11, back + 0.08);
  if (r() < 0.45) {
    // Timber water tank on a steel stand
    const tx = -pside * 0.3;
    const tz = back + 0.02;
    for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) b.box(0.008, 0.06, 0.008, tx + lx * 0.04, rt, tz + lz * 0.04, IRON);
    b.box(0.11, 0.008, 0.11, tx, rt + 0.06, tz, IRON);
    b.cylinder(0.055, 0.055, 0.11, tx, rt + 0.068, tz, 0x8a6a4a, 8);
    b.cylinder(0.057, 0.057, 0.008, tx, rt + 0.1, tz, IRON, 8);
    b.cylinder(0, 0.062, 0.045, tx, rt + 0.178, tz, 0x5a4a3a, 8);
  } else {
    for (let k = 0; k < 2; k++) {
      const hx = -pside * (0.15 + k * 0.17);
      b.box(0.12, 0.06, 0.08, hx, rt, back, 0xc4c8cc);
      b.cylinder(0.025, 0.025, 0.004, hx, rt + 0.06, back, 0x4a4e54, 8);
    }
  }
  if (r() < 0.6) {
    // Roof deck: boards, planters, an umbrella and string lights
    const dz = FRONT - 0.2;
    b.box(0.5, 0.012, 0.22, 0, rt, dz, 0xa27a54);
    for (const s of [-1, 1]) {
      b.box(0.04, 0.04, 0.2, s * 0.23, rt + 0.012, dz, 0x7a5a3a);
      for (let k = 0; k < 3; k++) shrub(b, s * 0.23, rt + 0.04, dz - 0.07 + k * 0.07, 0.03, k % 2 ? 0x4f9a3a : pick(r, FLOWERS));
    }
    b.cylinder(0.004, 0.004, 0.13, 0.05, rt + 0.012, dz, IRON, 4);
    b.cylinder(0.003, 0.1, 0.035, 0.05, rt + 0.13, dz, pick(r, [0xd9534f, 0x2f8f9d, 0xf2c84b, 0xf4f1ea] as const), 6);
    for (let k = 0; k < 6; k++) {
      const u = k / 5;
      b.box(0.012, 0.012, 0.012, -0.2 + u * 0.4, rt + 0.13 - Math.sin(u * Math.PI) * 0.025, dz + 0.1, [2.2, 1.7, 0.9], true);
    }
    beam(b, [-0.2, rt + 0.13, dz + 0.1], [0.2, rt + 0.13, dz + 0.1], 0.003, 0.003, IRON);
  }
}

/** Stacked timber back porches with a stair zig-zagging between them: the backs of SF flats. */
function rearPorches(b: GeoBuilder, x: number, ys: number[], z: number, light: ColorLike) {
  const pw = 0.3;
  const pd = 0.07;
  const wood = 0xb08a62;
  ys.forEach((y, i) => {
    b.box(pw, 0.01, pd, x, y, z - pd / 2, wood);
    b.box(pw, 0.006, 0.008, x, y + 0.055, z - pd + 0.004, wood);
    panel(b, 0.05, 0.09, x + (i % 2 ? -0.08 : 0.08), y + 0.055, z - 0.003, Math.PI, light, 'glow', i % 3 === 0 ? 2 : 0.2 + i * 0.12);
    const yb = i === 0 ? G : ys[i - 1]! + 0.01;
    const dir = i % 2 ? 1 : -1;
    beam(b, [x + dir * (pw / 2 - 0.08), y + 0.008, z - pd * 0.5], [x - dir * (pw / 2 - 0.03), yb, z - pd * 0.5], 0.035, 0.008, mul(wood, 0.9));
  });
  const top = ys[ys.length - 1]! + 0.06;
  for (const s of [-1, 1]) b.box(0.01, top - G, 0.01, x + s * (pw / 2 - 0.005), G, z - pd + 0.005, mul(wood, 0.8));
}

/** Black zig-zag fire escape: platforms with railings at each floor, stairs between, a drop ladder. */
function fireEscape(b: GeoBuilder, x: number, fw: number, ys: number[], z: number) {
  const fd = 0.055;
  ys.forEach((y, i) => {
    b.box(fw, 0.008, fd, x, y, z + fd / 2, IRON);
    b.box(fw, 0.006, 0.006, x, y + 0.058, z + fd - 0.003, IRON);
    for (const s of [-1, 1]) b.box(0.005, 0.058, fd, x + s * (fw / 2 - 0.0025), y, z + fd / 2, IRON);
    if (i < ys.length - 1) {
      const dir = i % 2 ? 1 : -1;
      beam(b, [x + dir * (fw / 2 - 0.035), y + 0.008, z + fd * 0.45], [x - dir * (fw / 2 - 0.075), ys[i + 1]!, z + fd * 0.45], 0.03, 0.008, IRON);
    }
  });
  const y0 = ys[0]!;
  for (const s of [-1, 1]) b.box(0.004, 0.13, 0.004, x + fw / 2 - 0.035 + s * 0.012, y0 - 0.13, z + fd - 0.01, IRON);
}

// ─── Neighbourhood grounds: sidewalks, street trees, the mid-block garden ─

/** Width of the block's sidewalk band, and of its curb. */
const SW = 0.1;
const CURB = 0.018;

/** Street-tree species planted along each block, varied block to block like real SF streets. */
const STREET_TREES: readonly TreeKind[] = ['plane', 'ficus', 'round', 'palm', 'plane', 'ficus'];

export function neighbourhoodGrounds(bx: number, bz: number, n: number, seed: number): Built {
  const r = rng(seed);
  const b = new GeoBuilder();
  const c = blockCentre({ bx, bz });
  const H = BLOCK / 2;
  b.box(BLOCK, 0.02, BLOCK, c.x, 0, c.z, PALETTE.sidewalk);

  const corner = (lot: { i: number; j: number }) => `${Math.sign(lot.i - (BLOCK - 1) / 2)},${Math.sign(lot.j - (BLOCK - 1) / 2)}`;
  const treeCorners = new Set(treeLots(n).map(corner));
  const walk = mix(PALETTE.sidewalk, 0xffffff, 0.12);
  const joint = mul(PALETTE.sidewalk, 0.82);
  const inner = H - SW;

  // Sidewalk bands: full length on the north/south streets; on the east/west
  // streets only where homes face them (corner homes run to the curb) or
  // where a corner garden needs one.
  for (const s of [-1, 1]) {
    b.box(BLOCK, 0.01, SW, c.x, 0.02, c.z + s * (H - SW / 2), walk);
    for (let k = 1; k < BLOCK * 4; k++) b.decal(0.006, SW - CURB, c.x - H + k * 0.25, 0.0302, c.z + s * (H - (SW + CURB) / 2), joint);
    const lo = treeCorners.has(`${s},-1`) ? -inner : -1;
    const hi = treeCorners.has(`${s},1`) ? inner : 1;
    b.box(SW, 0.01, hi - lo, c.x + s * (H - SW / 2), 0.02, c.z + (lo + hi) / 2, walk);
    for (let v = Math.ceil(lo * 4 + 0.01); v < hi * 4; v++) b.decal(SW - CURB, 0.006, c.x + s * (H - (SW + CURB) / 2), 0.0302, c.z + v / 4, joint);
    // Curbs, the full perimeter
    b.box(BLOCK, 0.036, CURB, c.x, 0, c.z + s * (H - CURB / 2), 0xc9c3b6);
    b.box(CURB, 0.036, BLOCK - 2 * CURB, c.x + s * (H - CURB / 2), 0, c.z, 0xc9c3b6);
  }

  // Vacant home lots wait as rough grass until the house goes up (the home's slab covers this).
  for (const lot of homeLots(n)) {
    const p = lotPosition({ bx, bz }, lot);
    const cs = Math.cos(lot.rot);
    const sn = Math.sin(lot.rot);
    const lz = (LOT_FRONT - 0.5) / 2;
    const dx = Math.abs(sn) * (LOT_FRONT + 0.5) + Math.abs(cs) * 1;
    const dz = Math.abs(cs) * (LOT_FRONT + 0.5) + Math.abs(sn) * 1;
    b.box(dx - 0.004, 0.006, dz - 0.004, p.x + sn * lz, 0.02, p.z + cs * lz, 0xa9c27a);
  }

  // Street trees in tree wells, between lots that face the street
  const species = STREET_TREES[n % STREET_TREES.length]!;
  const spots: [number, number][] = [];
  for (const s of [-1, 1]) {
    for (const u of [-1, 0, 1]) spots.push([u, s * (H - SW * 0.5)]);
    spots.push([s * (H - SW * 0.5), 0]);
  }
  spots.forEach(([u, v]) => {
    const x = c.x + u;
    const z = c.z + v;
    if (r() > 0.85) return;
    b.box(0.07, 0.004, 0.07, x, 0.03, z, SOIL);
    b.box(0.074, 0.006, 0.006, x, 0.03, z + 0.034, mul(PALETTE.sidewalk, 0.7));
    b.box(0.074, 0.006, 0.006, x, 0.03, z - 0.034, mul(PALETTE.sidewalk, 0.7));
    tree(b, r, x, z, species === 'palm' ? 0.55 : 0.6, 0.03, species);
  });

  // Street lamps at the corners (the junction lamp covers the south-west one),
  // and a white-topped San Francisco hydrant.
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1]] as const) {
    lamp(b, c.x + sx * (H - 0.06), c.z + sz * (H - 0.05), sz);
  }
  {
    const hx = c.x + (r() < 0.5 ? -1 : 1) * 0.5;
    const hz = c.z + (r() < 0.5 ? -1 : 1) * (H - 0.04);
    b.cylinder(0.014, 0.017, 0.045, hx, 0.03, hz, 0xf2efe8, 6);
    b.cylinder(0.011, 0.015, 0.014, hx, 0.075, hz, pick(r, [0x3a6fd8, 0xe8c040, 0xd84a3a] as const), 6);
    b.box(0.042, 0.01, 0.01, hx, 0.055, hz, 0xf2efe8);
  }

  // The mid-block garden (2×2 lots behind the homes)
  b.box(2, 0.01, 2, c.x, 0.02, c.z, mix(PALETTE.lawn, PALETTE.grassDark, 0.2));
  midBlock(b, r, c.x, c.z, n);

  // Pocket parks on the two corner lots
  treeLots(n).forEach((lot, k) => {
    const p = lotPosition({ bx, bz }, lot);
    const x0 = Math.max(p.x - 0.5, c.x - inner);
    const x1 = Math.min(p.x + 0.5, c.x + inner);
    const z0 = Math.max(p.z - 0.5, c.z - inner);
    const z1 = Math.min(p.z + 0.5, c.z + inner);
    const sx = Math.sign(lot.i - (BLOCK - 1) / 2);
    const sz = Math.sign(lot.j - (BLOCK - 1) / 2);
    pocketPark(b, r, x0, x1, z0, z1, sx, sz, (n + k) % 3);
  });
  return b.build();
}

/** Green-painted SF street lamp with an arm over the street and a glowing lantern. */
function lamp(b: GeoBuilder, x: number, z: number, out: number) {
  const pole = 0x2f4a3e;
  b.box(0.034, 0.04, 0.034, x, 0.03, z, pole);
  b.box(0.016, 0.5, 0.016, x, 0.03, z, pole);
  beam(b, [x, 0.52, z], [x, 0.53, z + out * 0.1], 0.01, 0.012, pole);
  b.box(0.05, 0.012, 0.05, x, 0.52, z + out * 0.1, pole);
  b.box(0.036, 0.03, 0.036, x, 0.49, z + out * 0.1, PALETTE.lamp, true);
  b.box(0.012, 0.012, 0.012, x, 0.532, z + out * 0.1, pole);
}

function bench(b: GeoBuilder, x: number, y: number, z: number, rotY: number) {
  b.box(0.16, 0.012, 0.05, x, y + 0.03, z, 0x8a6440, false, rotY);
  b.box(0.16, 0.035, 0.008, x - Math.sin(rotY) * 0.024, y + 0.042, z - Math.cos(rotY) * 0.024, 0x8a6440, false, rotY);
  b.box(0.14, 0.03, 0.04, x, y, z, IRON, false, rotY);
}

/** Shared backyard space in the middle of the block; one of four layouts. */
function midBlock(b: GeoBuilder, r: () => number, cx: number, cz: number, n: number) {
  const y = 0.03;
  const v = n % 4;
  if (v === 0) {
    // Commons: a stepping-stone path, a deck with lights, flower borders, shade trees
    for (let k = 0; k < 11; k++) {
      const u = k / 10;
      b.decal(0.07, 0.06, cx - 0.8 + u * 1.5, y + 0.001, cz + 0.6 - u * 1.3 + Math.sin(u * 5) * 0.12, 0xd8d0c0);
    }
    b.box(0.6, 0.025, 0.42, cx + 0.42, y, cz + 0.45, 0xa27a54);
    for (let k = 1; k < 6; k++) b.decal(0.004, 0.42, cx + 0.12 + k * 0.1, y + 0.0255, cz + 0.45, 0x8a6440);
    b.box(0.2, 0.012, 0.1, cx + 0.42, y + 0.07, cz + 0.45, 0x7a5a3a);
    b.box(0.03, 0.045, 0.03, cx + 0.42, y + 0.025, cz + 0.45, IRON);
    bench(b, cx + 0.42, y + 0.025, cz + 0.33, 0);
    bench(b, cx + 0.42, y + 0.025, cz + 0.57, Math.PI);
    for (const s of [-1, 1]) b.box(0.01, 0.24, 0.01, cx + 0.42 + s * 0.28, y + 0.025, cz + 0.66, IRON);
    beam(b, [cx + 0.14, y + 0.26, cz + 0.66], [cx + 0.7, y + 0.26, cz + 0.66], 0.003, 0.003, IRON);
    for (let k = 0; k < 7; k++) {
      const u = k / 6;
      b.box(0.014, 0.014, 0.014, cx + 0.15 + u * 0.54, y + 0.25 - Math.sin(u * Math.PI) * 0.04, cz + 0.66, [2.2, 1.6, 0.8], true);
    }
    b.box(0.7, 0.03, 0.12, cx - 0.4, y, cz - 0.82, SOIL);
    for (let k = 0; k < 9; k++) shrub(b, cx - 0.72 + k * 0.08, y + 0.02, cz - 0.82 + (r() - 0.5) * 0.04, 0.03, pick(r, FLOWERS));
    tree(b, r, cx - 0.55, cz - 0.4, 1.0, y, 'plane');
    tree(b, r, cx + 0.6, cz - 0.55, 1.0, y, 'round');
    tree(b, r, cx - 0.65, cz + 0.6, 0.75, y, 'ficus');
    tree(b, r, cx + 0.05, cz - 0.1, 0.6, y, 'round');
  } else if (v === 1) {
    // Community garden: gravel, raised beds, greenhouse, tool shed, fruit trees
    b.decal(1.5, 1.2, cx, y + 0.001, cz + 0.15, 0xd9ccb0);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const x = cx - 0.45 + i * 0.36;
        const z = cz - 0.25 + j * 0.34;
        b.box(0.28, 0.045, 0.16, x, y, z, 0x9a7650);
        b.box(0.25, 0.006, 0.13, x, y + 0.045, z, SOIL);
        const crop = pick(r, [0x6fb84a, 0x4f9a3a, 0x8fcf5a, 0x7a9a3a] as const);
        for (let k = 0; k < 4; k++) shrub(b, x - 0.09 + k * 0.06, y + 0.045, z, 0.026, k % 2 && r() < 0.4 ? 0xd84a3a : crop, 0.7);
      }
    }
    // Greenhouse
    b.box(0.34, 0.14, 0.24, cx + 0.55, y, cz - 0.7, 0xcfe6f0, 'glass');
    prismZ(b, [[cx + 0.38, y + 0.14], [cx + 0.72, y + 0.14], [cx + 0.55, y + 0.23]], cz - 0.82, cz - 0.58, 0xcfe6f0, 'glass');
    for (let k = 0; k < 4; k++) b.box(0.008, 0.14, 0.244, cx + 0.38 + k * 0.113, y, cz - 0.7, WHITE);
    // Shed
    b.box(0.2, 0.15, 0.16, cx - 0.65, y, cz - 0.72, 0x7a8f6a);
    gableRoof(b, cx - 0.65, 0.2, y + 0.15, 0.07, cz - 0.82, cz - 0.62, 0x5a4a44, 0.025, 0.014);
    panel(b, 0.06, 0.11, cx - 0.65, y + 0.055, cz - 0.639, 0, 0x5a4a3a);
    b.cylinder(0.03, 0.03, 0.07, cx - 0.5, y, cz - 0.65, 0x2f5a8a, 8);
    tree(b, r, cx - 0.7, cz + 0.72, 0.7, y, 'round');
    tree(b, r, cx + 0.7, cz + 0.7, 0.7, y, 'round');
    tree(b, r, cx + 0.05, cz + 0.75, 0.6, y, 'ficus');
  } else if (v === 2) {
    // Playground: soft surface, swings, a slide tower, picnic tables
    b.decal(0.9, 0.7, cx + 0.35, y + 0.001, cz + 0.3, 0xc96a4a);
    for (const s of [-1, 1]) {
      beam(b, [cx + 0.1, y, cz + 0.2 + s * 0.04], [cx + 0.1, y + 0.24, cz + 0.2], 0.012, 0.012, 0x3a6fd8);
      beam(b, [cx + 0.5, y, cz + 0.2 + s * 0.04], [cx + 0.5, y + 0.24, cz + 0.2], 0.012, 0.012, 0x3a6fd8);
    }
    beam(b, [cx + 0.08, y + 0.24, cz + 0.2], [cx + 0.52, y + 0.24, cz + 0.2], 0.014, 0.014, 0x3a6fd8);
    for (const sx of [0.2, 0.4]) {
      for (const s of [-1, 1]) b.box(0.003, 0.17, 0.003, cx + sx + s * 0.025, y + 0.07, cz + 0.2, 0x9aa0a8);
      b.box(0.06, 0.008, 0.03, cx + sx, y + 0.065, cz + 0.2, 0xe85a4a);
    }
    b.box(0.14, 0.18, 0.14, cx + 0.45, y, cz + 0.5, 0xf2c84b);
    gableRoof(b, cx + 0.45, 0.16, y + 0.24, 0.07, cz + 0.42, cz + 0.58, 0xe85a4a, 0.02, 0.012);
    for (const [px, pz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) b.box(0.012, 0.06, 0.012, cx + 0.45 + px * 0.065, y + 0.18, cz + 0.5 + pz * 0.065, 0xf2c84b);
    beam(b, [cx + 0.38, y + 0.18, cz + 0.5], [cx + 0.16, y + 0.01, cz + 0.5], 0.06, 0.012, 0x3aa38e);
    b.box(0.4, 0.015, 0.4, cx - 0.4, y, cz + 0.45, PALETTE.sand);
    for (const [px, pz] of [[-0.4, -0.35], [0.35, -0.45]] as const) {
      b.box(0.2, 0.012, 0.08, cx + px, y + 0.05, cz + pz, 0x8a6440);
      for (const s of [-1, 1]) b.box(0.2, 0.01, 0.03, cx + px, y + 0.03, cz + pz + s * 0.065, 0x8a6440);
      b.box(0.16, 0.05, 0.06, cx + px, y, cz + pz, IRON);
    }
    tree(b, r, cx - 0.7, cz - 0.7, 0.95, y, 'round');
    tree(b, r, cx + 0.75, cz - 0.75, 0.9, y, 'eucalyptus');
    tree(b, r, cx - 0.75, cz + 0.05, 0.8, y, 'plane');
  } else {
    // Private backyards: four fenced gardens
    b.box(2, 0.07, 0.012, cx, y, cz, FENCE);
    b.box(0.012, 0.07, 2, cx, y, cz, FENCE);
    // NE: patio and barbecue
    b.decal(0.5, 0.4, cx + 0.5, y + 0.001, cz + 0.5, 0xcfc4b4);
    b.box(0.07, 0.06, 0.05, cx + 0.3, y, cz + 0.4, IRON);
    for (const k of [-1, 1]) b.box(0.05, 0.04, 0.05, cx + 0.55 + k * 0.1, y, cz + 0.5, 0xf4f1ea);
    b.cylinder(0.045, 0.045, 0.006, cx + 0.55, y + 0.06, cz + 0.5, 0xf4f1ea, 8);
    // SE: hot tub on a deck
    b.box(0.5, 0.025, 0.4, cx + 0.5, y, cz - 0.5, 0xa27a54);
    b.box(0.2, 0.06, 0.2, cx + 0.55, y + 0.025, cz - 0.5, 0x7a5a3a);
    b.decal(0.17, 0.17, cx + 0.55, y + 0.086, cz - 0.5, PALETTE.pool, 'glass');
    // SW: vegetable beds
    for (let k = 0; k < 3; k++) {
      b.box(0.5, 0.035, 0.1, cx - 0.5, y, cz - 0.7 + k * 0.2, 0x9a7650);
      for (let j = 0; j < 6; j++) shrub(b, cx - 0.7 + j * 0.08, y + 0.03, cz - 0.7 + k * 0.2, 0.024, j % 3 ? 0x5fae42 : 0xd84a3a, 0.6);
    }
    // NW: lawn and a trampoline
    b.cylinder(0.16, 0.16, 0.05, cx - 0.5, y, cz + 0.5, 0x3a3e46, 10);
    b.cylinder(0.17, 0.17, 0.008, cx - 0.5, y + 0.05, cz + 0.5, 0x3a6fd8, 10);
    tree(b, r, cx - 0.8, cz + 0.15, 0.8, y, 'round');
    tree(b, r, cx + 0.2, cz - 0.2, 0.75, y, 'plane');
    tree(b, r, cx - 0.2, cz - 0.3, 0.55, y, 'palm');
  }
}

/** A corner pocket park: a big shade tree and benches, a palm garden, or a parklet with a heart sculpture. */
function pocketPark(b: GeoBuilder, r: () => number, x0: number, x1: number, z0: number, z1: number, sx: number, sz: number, v: number) {
  const y = 0.03;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const w = x1 - x0;
  const d = z1 - z0;
  b.box(w, 0.01, d, cx, 0.02, cz, mix(PALETTE.lawn, PALETTE.grass, 0.3));
  // A low hedge along the two sides that meet neighbouring homes
  b.box(w, 0.05, 0.04, cx, y, sz > 0 ? z0 + 0.02 : z1 - 0.02, 0x4a8a3c);
  b.box(0.04, 0.05, d - 0.04, sx > 0 ? x0 + 0.02 : x1 - 0.02, y, cz, 0x4a8a3c);
  // A diagonal path in from the street corner
  const ox = cx + sx * w * 0.25;
  const oz = cz + sz * d * 0.25;
  if (v === 0) {
    const g = new THREE.PlaneGeometry(0.16, 0.9);
    g.rotateX(-Math.PI / 2);
    g.rotateY(Math.atan2(sx, sz));
    g.translate(cx + sx * 0.12, y + 0.0015, cz + sz * 0.12);
    add(b, g, 0xd8d0c0);
    b.cylinder(0.14, 0.14, 0.03, cx - sx * 0.08, y, cz - sz * 0.08, 0xb9b2a5, 10);
    b.cylinder(0.12, 0.12, 0.032, cx - sx * 0.08, y, cz - sz * 0.08, SOIL, 10);
    tree(b, r, cx - sx * 0.08, cz - sz * 0.08, 1.15, y + 0.03, r() < 0.5 ? 'cypress' : 'plane');
    bench(b, ox + sx * 0.05, y, cz - sz * 0.26, sz > 0 ? 0 : Math.PI);
    bench(b, cx - sx * 0.26, y, oz + sz * 0.05, sx > 0 ? Math.PI / 2 : -Math.PI / 2);
    // A Little Free Library on a post
    b.box(0.012, 0.09, 0.012, ox, y, oz - sz * 0.15, 0x6b4a3a);
    b.box(0.06, 0.05, 0.045, ox, y + 0.09, oz - sz * 0.15, 0xc0392b);
    gableRoof(b, ox, 0.06, y + 0.14, 0.025, oz - sz * 0.15 - 0.025, oz - sz * 0.15 + 0.025, 0x3f4a55, 0.01, 0.008);
  } else if (v === 1) {
    // Canary palms over a flower meadow
    for (let k = 0; k < 10; k++) shrub(b, x0 + 0.1 + r() * (w - 0.2), y, z0 + 0.1 + r() * (d - 0.2), 0.03, pick(r, FLOWERS));
    palm(b, r, cx - sx * 0.12, cz - sz * 0.15, 1.0, y);
    palm(b, r, cx + sx * 0.05, cz - sz * 0.3, 0.85, y);
    palm(b, r, cx - sx * 0.3, cz + sz * 0.02, 0.9, y);
    bench(b, ox + sx * 0.05, y, oz + sz * 0.08, sz > 0 ? Math.PI : 0);
  } else {
    // Parklet: picnic lawn, a pair of ficus, a bike rack and a painted heart
    tree(b, r, cx - sx * 0.25, cz - sz * 0.2, 0.9, y, 'ficus');
    tree(b, r, cx + sx * 0.05, cz - sz * 0.32, 0.8, y, 'round');
    b.box(0.07, 0.035, 0.07, ox, y, oz, 0xe6e0d2);
    const heart = pick(r, [0xe0405a, 0xf08a4b, 0x9b7fd8, 0x3aa3c8] as const);
    for (const s of [-1, 1]) b.blob(0.03, ox + s * 0.022, y + 0.12, oz, heart, 'smooth', 1);
    const g = new THREE.ConeGeometry(0.05, 0.07, 4);
    g.rotateZ(Math.PI);
    g.rotateY(Math.PI / 4);
    g.scale(1, 1, 0.5);
    g.translate(ox, y + 0.085, oz);
    add(b, g, heart, 'smooth');
    for (let k = 0; k < 3; k++) beam(b, [ox - sx * 0.2 + k * 0.04 * sx, y, oz - sz * 0.02], [ox - sx * 0.2 + k * 0.04 * sx, y + 0.05, oz - sz * 0.02], 0.006, 0.006, 0x9aa0a8);
    bench(b, cx - sx * 0.05, y, cz + sz * 0.05, sz > 0 ? 0 : Math.PI);
  }
}
