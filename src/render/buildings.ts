import * as THREE from 'three';
import { GeoBuilder, glassMaterial, smoothMaterial, solidMaterial, type ColorLike } from './geo.ts';
import { PALETTE } from './palette.ts';
import { pick, rng } from '../world/rng.ts';
import { WORLD_SPEC } from '../world/map.ts';
import {
  BLOCK,
  SETBACK,
  SIDEWALK,
  blockCentre,
  frontage,
  homeLots,
  lotPosition,
  lotRole,
  neighbourhoodRing,
  readHomeSeed,
  treeLots,
  type HomeKind,
  type LotRole,
} from '../world/layout.ts';

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

/**
 * Cheap boxes. Every small part of a home (sills, brackets, fences, bins)
 * goes into one triangle list per builder instead of its own geometry, and
 * drops the faces nobody can see: the bottom (it stands on something) and,
 * for parts fixed to a wall, the back. `seal` flushes the list; call it
 * before `build()`.
 */
const ACC = new WeakMap<GeoBuilder, Tris>();

function acc(b: GeoBuilder): Tris {
  let t = ACC.get(b);
  if (!t) ACC.set(b, (t = new Tris()));
  return t;
}

function seal(b: GeoBuilder) {
  const t = ACC.get(b);
  if (!t) return;
  t.flush(b);
  ACC.delete(b);
}

/** Box standing on y, without a bottom; `attached` also drops the back (its −z face before turning by `ang`). 8–10 triangles. */
function bx(b: GeoBuilder, w: number, h: number, d: number, x: number, y: number, z: number, color: ColorLike, attached = false, ang = 0) {
  const t = acc(b);
  const col = lin(color);
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const P = (px: number, py: number, pz: number): V => [x + px * c + pz * s, y + py, z - px * s + pz * c];
  const N = (nx: number, nz: number): V => [nx * c + nz * s, 0, -nx * s + nz * c];
  const hw = w / 2;
  const hd = d / 2;
  const a = P(-hw, 0, hd), b1 = P(hw, 0, hd), c1 = P(hw, h, hd), d1 = P(-hw, h, hd);
  const e = P(-hw, 0, -hd), f = P(hw, 0, -hd), g = P(hw, h, -hd), k = P(-hw, h, -hd);
  t.quad(a, b1, c1, d1, col, N(0, 1));
  t.quad(b1, f, g, c1, col, N(1, 0));
  t.quad(e, a, d1, k, col, N(-1, 0));
  t.quad(d1, c1, g, k, col, UP);
  if (!attached) t.quad(f, e, k, g, col, N(0, -1));
}

/** A thin ledge on a wall (sill, band, coping): just its top and front, 4 triangles. Front faces +z before turning. */
function ledge(b: GeoBuilder, w: number, h: number, d: number, x: number, y: number, z: number, color: ColorLike, ang = 0) {
  const t = acc(b);
  const col = lin(color);
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const P = (px: number, py: number, pz: number): V => [x + px * c + pz * s, y + py, z - px * s + pz * c];
  const hw = w / 2;
  const hd = d / 2;
  t.quad(P(-hw, 0, hd), P(hw, 0, hd), P(hw, h, hd), P(-hw, h, hd), col, [s, 0, c]);
  t.quad(P(-hw, h, hd), P(hw, h, hd), P(hw, h, -hd), P(-hw, h, -hd), col, UP);
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

/**
 * Who's home tonight. `lit` is the share of windows that light up after
 * dark (a few homes are away and stay nearly dark); `warm` tints the whole
 * home's lamps a little warmer or cooler than its neighbours'.
 */
interface Lights {
  lit: number;
  warm: number;
}

function lightsFor(r: () => number): Lights {
  return { lit: r() < 0.1 ? 0.1 : 0.4 + r() * 0.32, warm: 0.88 + r() * 0.22 };
}

/** One window's lamp: mostly warm incandescent, some dim or curtained, a few cool LEDs, a television now and then. */
function lampColor(L: Lights, r: () => number): RGB {
  const v = L.warm * (0.86 + r() * 0.24);
  const roll = r();
  if (roll < 0.6) return [1.5 * v, 0.94 * v, 0.42 * v];
  if (roll < 0.84) return [0.95 * v, 0.56 * v, 0.24 * v];
  if (roll < 0.95) return [1.25 * v, 1.1 * v, 0.84 * v];
  return [0.5 * v, 0.76 * v, 1.3 * v];
}

/** When in the dusk this window switches on; 2 means it stays dark tonight. */
function onAt(L: Lights, r: () => number, share = 1): number {
  return r() < L.lit * share ? 0.12 + 0.86 * r() : 2;
}

/** Window: trim surround, glass that lights at night, sash bars, sill and an optional header. */
interface WinOpts {
  w: number;
  h: number;
  L: Lights;
  /** Scales the chance this window is lit (bathrooms and stairwells less, living rooms more). */
  share?: number;
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
  const rand = onAt(o.L, r, o.share);
  const light = lampColor(o.L, r);
  if (o.frame !== undefined) {
    const [fx, fz] = at(0.002);
    if (o.arch) archPanel(b, o.w + 0.024, o.h + 0.024, o.arch + 0.012, fx, y, fz, ang, o.frame);
    else panel(b, o.w + 0.024, o.h + 0.024, fx, y, fz, ang, o.frame);
  }
  const [gx, gz] = at(0.004);
  if (o.arch) archPanel(b, o.w, o.h, o.arch, gx, y, gz, ang, light, 'glow', rand);
  else panel(b, o.w, o.h, gx, y, gz, ang, light, 'glow', rand);
  const bar = o.frame ?? PALETTE.trim;
  if (o.bars) {
    const [bx2, bz2] = at(0.0055);
    panel(b, o.w, 0.007, bx2, y + o.h * 0.06 - (o.arch ? o.arch * 0.5 : 0), bz2, ang, bar);
    if (o.w > 0.085) panel(b, 0.007, o.h, bx2, y, bz2, ang, bar);
  }
  if (o.sill !== undefined) {
    const [kx, kz] = at(0.01);
    ledge(b, o.w + 0.03, 0.012, 0.02, kx, y - o.h / 2 - 0.018, kz, o.sill, ang);
  }
  if (o.head !== undefined) {
    const [hx, hz] = at(0.009);
    ledge(b, o.w + 0.034, 0.016, 0.018, hx, y + o.h / 2 + 0.004, hz, o.head, ang);
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
  L: Lights;
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
    for (const f of faces) win(b, r, f.cx, row.y, f.cz, f.ang, { w: f.w, h: row.h, L: o.L, share: 1.15, frame: o.trim, bars: true });
    if (o.accent !== undefined) panel(b, o.wf * 0.7, 0.03, o.x, row.y - row.h / 2 - 0.03, o.z + o.p + 0.003, 0, o.accent);
  }
  for (const y of o.bands ?? []) prismY(b, growBay(o.x, o.z, o.wf, o.p, 0.008), y - 0.008, y + 0.008, o.trim, [3]);
  prismY(b, growBay(o.x, o.z, o.wf, o.p, 0.018), o.y1, o.y1 + 0.022, o.trim, [3]);
  if (o.brackets) {
    for (const s of [-1, 1]) bx(b, 0.016, 0.03, o.p * 0.8, o.x + s * (o.wf / 2 - 0.01), o.y0 - 0.03, o.z + o.p * 0.4, o.trim, true);
  }
}

/**
 * Heavy cornice along a facade centred on (x, z): frieze band, a row of
 * brackets, and a crown that overhangs. `ang` turns it to face another way
 * (0 faces +z), so it can be carried round a corner.
 */
function cornice(b: GeoBuilder, x: number, w: number, y: number, z: number, proj: number, crown: ColorLike, bracket: ColorLike, n: number, frieze?: ColorLike, ang = 0) {
  const at = (u: number, v: number) => onFace(x, z, ang, u, v);
  if (frieze !== undefined) {
    const [fx, fz] = at(0, 0.004);
    ledge(b, w, 0.045, 0.008, fx, y - 0.05, fz, frieze, ang);
  }
  for (let k = 0; k < n; k++) {
    const [kx, kz] = at(-w / 2 + ((k + 0.5) * w) / n, (proj - 0.01) / 2);
    bx(b, 0.014, 0.036, proj - 0.01, kx, y - 0.036, kz, bracket, true, ang);
  }
  const [cx, cz] = at(0, (proj - 0.012) / 2);
  bx(b, w + 0.016, 0.024, proj + 0.012, cx, y, cz, crown, false, ang);
  const [tx, tz] = at(0, (proj - 0.012) / 2 + 0.005);
  bx(b, w + 0.026, 0.009, proj + 0.022, tx, y + 0.024, tz, crown, false, ang);
}

/** Straight stair rising along z from its foot (at zFoot, ground) to its head. Solid masonry or timber. */
function stairZ(b: GeoBuilder, x: number, w: number, zFoot: number, zHead: number, rise: number, n: number, color: ColorLike, y0 = G, tread?: ColorLike) {
  for (let k = 0; k < n; k++) {
    const za = zFoot + ((zHead - zFoot) * k) / n;
    const zb = zFoot + ((zHead - zFoot) * (k + 1)) / n;
    const h = (rise * (k + 1)) / n;
    bx(b, w, h, Math.abs(zb - za) + 0.001, x, y0, (za + zb) / 2, k % 2 ? color : mul(color, 0.95));
    if (tread !== undefined) b.decal(w, Math.abs(zb - za), x, y0 + h + 0.0008, (za + zb) / 2, tread);
  }
}

/** Straight stair rising along x. */
function stairX(b: GeoBuilder, z: number, d: number, xFoot: number, xHead: number, rise: number, n: number, color: ColorLike, y0 = G, tread?: ColorLike) {
  for (let k = 0; k < n; k++) {
    const xa = xFoot + ((xHead - xFoot) * k) / n;
    const xb = xFoot + ((xHead - xFoot) * (k + 1)) / n;
    const h = (rise * (k + 1)) / n;
    bx(b, Math.abs(xb - xa) + 0.001, h, d, (xa + xb) / 2, y0, z, k % 2 ? color : mul(color, 0.95));
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
 * tree); 'ficus' clipped Indian laurel fig; 'eucalyptus' tall blue gum;
 * 'pine' a tidy conifer (Monterey pine, coast redwood) in stacked tiers.
 *
 * Every crown is a rounded low-poly mass (an icosahedron split once), lit
 * two-tone like the references: sunlit tops, shaded undersides.
 */
export type TreeKind = 'palm' | 'round' | 'cypress' | 'plane' | 'ficus' | 'eucalyptus' | 'pine';

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
      // London plane: pale mottled trunk, a fork, and a tall rounded crown of fresh green (~118 triangles).
      limb(b, [x, y, z], [x, y + 0.3 * s, z], 0.036 * s, 0.026 * s, 0xb9b096);
      limb(b, [x, y + 0.22 * s, z], [x + ox * 0.09 * s, y + 0.38 * s, z + oz * 0.09 * s], 0.016 * s, 0.01 * s, 0xc9c2a2, 4);
      const c = pick(r, [0x79a845, 0x86b44c, 0x6d9c40] as const);
      crown(b, x, y + 0.5 * s, z, 0.2 * s, 0.22 * s, 0.2 * s, c, 1);
      crown(b, x + ox * 0.13 * s, y + 0.4 * s, z + oz * 0.13 * s, 0.1 * s, 0.09 * s, 0.1 * s, mul(c, 0.94));
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
    case 'pine': {
      // Conifer: a straight trunk and three stacked tiers, narrowing to a point (~31 triangles).
      const c = pick(r, PALETTE.pine);
      limb(b, [x, y, z], [x, y + 0.2 * s, z], 0.032 * s, 0.024 * s, 0x6e5640);
      for (let k = 0; k < 3; k++) cone(b, x, y + (0.14 + k * 0.15) * s, z, (0.2 - k * 0.05) * s, (0.26 - k * 0.03) * s, mul(c, 1 + k * 0.07), turn);
      return;
    }
    default: {
      // Round street tree: a short trunk under one full rounded crown, with a smaller mass to one side (~110 triangles).
      const leaves = pick(r, PALETTE.leaves);
      limb(b, [x, y, z], [x, y + 0.28 * s, z], 0.04 * s, 0.03 * s, PALETTE.trunk);
      crown(b, x, y + 0.44 * s, z, 0.22 * s, 0.2 * s, 0.22 * s, leaves, 1);
      crown(b, x + ox * 0.15 * s, y + 0.36 * s, z + oz * 0.15 * s, 0.11 * s, 0.1 * s, 0.11 * s, mul(leaves, 1.08));
    }
  }
}

/** One tier of a conifer: an open cone of seven faces, two-tone like the crowns. */
function cone(b: GeoBuilder, x: number, y: number, z: number, rad: number, h: number, color: ColorLike, spin: number) {
  const t = new Tris();
  const base = lin(color);
  const hi = mix(mul(color, 1.3), [0.9, 0.85, 0.35], 0.1);
  const n = 7;
  const tip: V = [x, y + h, z];
  for (let i = 0; i < n; i++) {
    const a0 = spin + (i / n) * Math.PI * 2;
    const a1 = spin + ((i + 1) / n) * Math.PI * 2;
    const p0: V = [x + Math.cos(a0) * rad, y, z + Math.sin(a0) * rad];
    const p1: V = [x + Math.cos(a1) * rad, y, z + Math.sin(a1) * rad];
    // Faces toward the sun (north-east of the view's south-west lean) catch more light.
    const lit = 0.5 + 0.5 * Math.cos((a0 + a1) / 2 - 0.8);
    const col = mix(mul(base, 0.8), hi, lit * 0.6);
    t.tri(p0, p1, tip, col, col, col, [Math.cos((a0 + a1) / 2), 0.6, Math.sin((a0 + a1) / 2)]);
  }
  t.flush(b);
}

// ─── Homes (one per customer, in lot-local space, door facing +z) ─────────

/** Top of the lot's ground slab. */
const G = 0.03;
/** The street wall: every home's main facade stands here, the same setback on every street. */
const FRONT = 0.5 - SETBACK;
/** Rear wall of the houses; backyards run from here to the rear fence. */
const BACK = -0.3;
/** Where the lot meets the sidewalk. */
const LOT_FRONT = 0.5 - SIDEWALK;
/** The rear fence, where every backyard meets the block's mid-block garden. */
const REAR = -0.49;
/** A mid-row home's width: neighbours leave a hairline between them. Corner homes are drawn at this width and narrowed. */
const FULL = 0.97;

/** Sunset District and Marina stucco, from cream to the pastel mints and pinks. */
const STUCCO = [0xf3e3c3, 0xf2d2b6, 0xedc9c3, 0xcfe3d3, 0xc8d8e8, 0xf1e4a6, 0xdcd0e8, 0xf7f3ea, 0xe8d8b6, 0xbcdad2, 0xf0c7a4, 0xe3e6d0] as const;
const MED = [0xf4e8cf, 0xf2ddc0, 0xefe2cf, 0xf6eee0, 0xecd2bd, 0xe9dcc4, 0xf3d9c9] as const;
const TILE = [0xc8643c, 0xb9563a, 0xd47a4c, 0xa94e32] as const;
const SLATE = [0x4c5563, 0x5d4f4a, 0x56606a, 0x6c5f58, 0x3f4a55] as const;
const SLATE_COOL = [0x4c5563, 0x56606a, 0x3f4a55, 0x505a66] as const;
const SLATE_WARM = [0x5d4f4a, 0x6c5f58, 0x6a5246, 0x5a4c48] as const;
const DOORS = [0x7a2e2a, 0x2f4f6f, 0x2f6a5a, 0x6b4a3a, 0x24272c, 0xc8962e, 0x5a3f6e] as const;
const WHITE = 0xfbf8f2;
const CONCRETE = 0xd6d0c3;
const IRON = 0x26282d;
/** Flat roofs: pale cool-roof coatings and weathered tar. */
const ROOF_TAR = [0xcfc9bf, 0xc2bcb2, 0xdcd7ce, 0xb6b0a7, 0xd2cbbd] as const;
const FENCE = 0xb0906a;
const SOIL = 0x6b5238;
const FLOWERS = [0xe0607a, 0xf0c040, 0x9b7fd8, 0xf08a4b, 0xffffff, 0x6fa8e8, 0xd94f4f] as const;
/** San Francisco's three bins: landfill, recycling, compost. */
const BINS = [0x2b2e33, 0x2f6fb5, 0x3f8f4a] as const;

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

type Family = 'sunset' | 'marina' | 'cottage' | 'italianate' | 'queen' | 'stick' | 'edwardian' | 'brick' | 'deco';

/**
 * One block's style: everything that should match all along a street. A
 * block is one family (a row of painted ladies, a block of Sunset stucco,
 * a block of Edwardian flats) at one height, with doors on the same side;
 * colours and small details vary home to home, as they do in the city.
 */
interface Street {
  family: Family;
  /** Which side doors and stairs are on, the same for every home, so garages and stoops keep a rhythm. */
  s: 1 | -1;
  /** A per-street choice within the family: parapet, roof form, bay type. */
  variant: number;
  floors: number;
  roof: ColorLike;
  tile: ColorLike;
  garage: boolean;
  lawn: RGB;
  yardTree: TreeKind;
  /** Canopies, shutters and awnings. */
  accent: ColorLike;
}

function streetStyle(kind: HomeKind, seed: number, ring: number): Street {
  const r = rng(seed);
  // Each world has its own character: which families line its streets, its paint, its roofs, its trees.
  const look = WORLD_SPEC.look;
  const H = look.houses;
  const family = pick(r, kind === 'apartment' ? H.apartment : kind === 'townhouse' ? H.townhouse : ring === 2 ? H.ring2 : H.inner) as Family;
  return {
    family,
    s: r() < 0.5 ? 1 : -1,
    variant: Math.floor(r() * 3),
    floors: kind === 'apartment' ? 4 + Math.floor(r() * 2) : family === 'queen' ? 2 : 3,
    roof: pick(r, look.roofs === 'slate' ? SLATE_COOL : look.roofs === 'clay' ? SLATE_WARM : SLATE),
    tile: pick(r, TILE),
    garage: r() < 0.45,
    lawn: mix(PALETTE.lawn, PALETTE.grassDark, 0.25 + r() * 0.25),
    yardTree: pick(r, look.yardTrees) as TreeKind,
    accent: pick(r, [0x3f5f7f, 0x6b3a3a, 0x2f5a4a, 0x7a6a3a, 0x4a4a5a] as const),
  };
}

/** This world's painted-lady colours: a run of the full table, or all of it in the classic city. */
function ladyPaints(): readonly Scheme[] {
  const paints = WORLD_SPEC.look.paints;
  return paints.length ? paints.map((i) => LADIES[i % LADIES.length]!) : LADIES;
}

/** Which family a street seed builds, for the showcase. */
export function streetFamily(kind: HomeKind, seed: number, ring: number): string {
  return streetStyle(kind, seed, ring).family;
}

/** What a family tells the rest of the lot about the building it put up. */
interface Massing {
  wall: ColorLike;
  trim: ColorLike;
  /** Window rows for a finished side wall: centre y and glass height. */
  rows: { y: number; h: number }[];
  /** Rear wall. */
  zB: number;
  /** Top of the walls. */
  top: number;
  /** Detached houses finish their own sides. */
  detached?: boolean;
  /** Side-wall window width, and how many to a wall (deco runs ribbon windows). */
  sideWin?: { w: number; cols: number };
  /** A corner shop on the ground floor, to wrap round onto the side street. */
  shop?: { awning: ColorLike; glow: ColorLike; h: number };
  /** A cornice to carry round a corner. */
  cornice?: { y: number; proj: number; crown: ColorLike; bracket: ColorLike };
  /** A Queen Anne corner turret. */
  turret?: { y0: number; y1: number; roof: ColorLike; body: ColorLike; accent: ColorLike };
  /** Flats keep a paved yard for bins and bikes; houses a garden. */
  yard: 'garden' | 'paved';
}

interface HomeCtx {
  st: Street;
  L: Lights;
  role: LotRole;
}

function porchLight(b: GeoBuilder, x: number, y: number, z: number) {
  b.box(0.016, 0.02, 0.016, x, y, z, PALETTE.lamp, true);
  ledge(b, 0.022, 0.006, 0.022, x, y + 0.02, z, IRON);
}

/** A wall-mounted mailbox and brass house numbers beside a door. */
function mailbox(b: GeoBuilder, x: number, y: number, z: number, color: ColorLike) {
  bx(b, 0.028, 0.03, 0.012, x, y, z + 0.006, color, true);
  ledge(b, 0.032, 0.004, 0.016, x, y + 0.03, z + 0.008, mul(color, 0.7));
  panel(b, 0.024, 0.012, x, y + 0.05, z + 0.002, 0, 0xc9a24a);
}

/** The three bins, out on the front strip (not every home's put them out). */
function bins(b: GeoBuilder, x: number, z: number, dir: number) {
  BINS.forEach((c, k) => {
    bx(b, 0.026, 0.042, 0.028, x + dir * k * 0.03, G, z, c);
    ledge(b, 0.028, 0.004, 0.03, x + dir * k * 0.03, G + 0.042, z, mul(c, 0.8));
  });
}

export function home(kind: HomeKind, seed: number): Built {
  const info = readHomeSeed(seed);
  const st = streetStyle(kind, info.street, info.ring);
  const role = info.role;
  const r = rng(seed);
  const L = lightsFor(r);
  const b = new GeoBuilder();
  const { x0, x1 } = frontage(role);
  // The lot: lawn from the rear fence to the sidewalk, and on a corner to the side street's sidewalk.
  const lx0 = role.street < 0 ? -LOT_FRONT : -0.5;
  const lx1 = role.street > 0 ? LOT_FRONT : 0.5;
  bx(b, lx1 - lx0, G, LOT_FRONT + 0.5, (lx0 + lx1) / 2, 0, (LOT_FRONT - 0.5) / 2, mul(st.lawn, 0.96 + r() * 0.08));

  // Every family is designed at full width; a corner home is the same design, narrowed to the side street's building line.
  const k = (x1 - x0) / FULL;
  const body = k < 0.999 ? new GeoBuilder() : b;
  const ctx: HomeCtx = { st, L, role };
  const m = FAMILIES[st.family](body, r, ctx);
  if (body !== b) squeeze(b, body, k, (x0 + x1) / 2);
  if (!m.detached) {
    if (role.street) sideFacade(b, r, ctx, m, role.street > 0 ? x1 : x0, role.street, true);
    if (role.open) sideFacade(b, r, ctx, m, role.open > 0 ? x1 : x0, role.open, false);
  }
  backyard(b, r, ctx, m, x0, x1);
  seal(b);
  return b.build();
}

/** Moves a finished model into `dst`, narrowed to `k` of its width and shifted by `dx`. */
function squeeze(dst: GeoBuilder, src: GeoBuilder, k: number, dx: number) {
  seal(src);
  const { group } = src.build();
  m4.makeScale(k, 1, 1).setPosition(dx, 0, 0);
  for (const child of group.children) {
    const mesh = child as THREE.Mesh;
    mesh.geometry.applyMatrix4(m4);
    const mat = mesh.material;
    dst.raw(mesh.geometry, mat === solidMaterial ? 'solid' : mat === glassMaterial ? 'glass' : mat === smoothMaterial ? 'smooth' : 'glow');
  }
}

/**
 * A finished side wall at x, facing `side`: on a corner it's a second street
 * front (windows on every floor, corner boards, the cornice and the shop
 * carried round, a turret); over a pocket park, a few windows.
 */
function sideFacade(b: GeoBuilder, r: () => number, ctx: HomeCtx, m: Massing, x: number, side: number, street: boolean) {
  const ang = (side * Math.PI) / 2;
  const zF = FRONT;
  const d = zF - m.zB;
  const cols = m.sideWin ? m.sideWin.cols : street ? Math.min(3, Math.max(2, Math.round(d / 0.19))) : 2;
  const ww = m.sideWin?.w ?? 0.068;
  const shopTop = m.shop && street ? G + m.shop.h : -1;
  for (const row of m.rows) {
    if (row.y < shopTop) continue;
    for (let c = 0; c < cols; c++) {
      const z = m.zB + ((c + 0.5) / cols) * d;
      if (m.turret && street && z > zF - 0.17) continue;
      win(b, r, x, row.y, z, ang, { w: ww, h: row.h, L: ctx.L, frame: m.trim, bars: !m.sideWin, sill: m.sideWin ? undefined : m.trim, share: street ? 1 : 0.7 });
    }
  }
  if (!street) return;
  // Corner boards up both edges.
  for (const z of [zF - 0.008, m.zB + 0.008]) bx(b, 0.02, m.top - G, 0.02, x - side * 0.006, G, z, m.trim);
  if (m.cornice) cornice(b, x, d, m.cornice.y, (zF + m.zB) / 2, m.cornice.proj, m.cornice.crown, m.cornice.bracket, Math.round(d / 0.11), undefined, ang);
  if (m.shop) {
    // The shop window and awning turn the corner, with a side door.
    const sh = m.shop.h;
    const len = Math.min(0.36, d - 0.1);
    const zc = zF - 0.03 - len / 2;
    bx(b, len + 0.01, 0.035, 0.016, x + side * 0.008, G, zc, mul(m.shop.awning, 0.6), true, ang);
    panel(b, len - 0.02, sh - 0.11, x + side * 0.012, G + 0.035 + (sh - 0.11) / 2, zc, ang, m.shop.glow, 'glow', 0.03);
    for (let k = 1; k < 3; k++) panel(b, 0.008, sh - 0.11, x + side * 0.0145, G + 0.035 + (sh - 0.11) / 2, zc - len / 2 + (k * len) / 3, ang, mul(m.shop.awning, 0.6));
    const t = new Tris();
    const xo = x + side * 0.1;
    tiles(t, [xo, G + sh - 0.06, zc - len / 2], [xo, G + sh - 0.06, zc + len / 2], [x + side * 0.004, G + sh - 0.01, zc + len / 2], [x + side * 0.004, G + sh - 0.01, zc - len / 2], 7, m.shop.awning, r, 0.004, 0xf4efe4);
    t.flush(b);
    panel(b, 0.07, 0.15, x + side * 0.004, G + 0.075, m.zB + 0.1, ang, 0x3a2e28);
  }
  if (m.turret) turret(b, r, ctx, m, x, side);
}

/** A Queen Anne corner turret: a round tower with a ring of windows per floor under a witch's-hat roof. */
function turret(b: GeoBuilder, r: () => number, ctx: HomeCtx, m: Massing, x: number, side: number) {
  const t = m.turret!;
  const rad = 0.1;
  const cx = x - side * 0.045;
  const cz = FRONT - 0.025;
  const n = 8;
  const h = t.y1 - t.y0;
  const g = new THREE.CylinderGeometry(rad, rad, h, n, 1, true);
  g.translate(cx, t.y0 + h / 2, cz);
  add(b, g, mix(t.body, 0xffffff, 0.08));
  // Corbelled base, a band at each floor and a moulded eave.
  b.cylinder(rad, rad * 0.3, 0.08, cx, t.y0 - 0.08, cz, mul(t.body, 0.85), n);
  b.cylinder(rad + 0.008, rad + 0.008, 0.012, cx, t.y0, cz, m.trim, n);
  b.cylinder(rad + 0.014, rad + 0.014, 0.026, cx, t.y1 - 0.026, cz, m.trim, n);
  // Windows on the five faces that look out over the streets.
  const floors = Math.max(1, Math.round(h / 0.22));
  for (let f = 0; f < floors; f++) {
    const y = t.y0 + (f + 0.55) * (h / floors);
    for (let i = 0; i < n; i++) {
      const a = ((i + 0.5) / n) * Math.PI * 2;
      const fx = Math.sin(a);
      const fz = Math.cos(a);
      if (fz < -0.3 || fx * side < -0.3) continue;
      const rr = rad * Math.cos(Math.PI / n) + 0.001;
      win(b, r, cx + fx * rr, y, cz + fz * rr, a, { w: 0.045, h: 0.12, L: ctx.L, frame: m.trim, share: 1.2 });
    }
  }
  // Witch's-hat roof and a finial.
  b.cylinder(0, rad + 0.032, 0.27, cx, t.y1, cz, t.roof, n);
  b.cylinder(0.004, 0.004, 0.07, cx, t.y1 + 0.26, cz, 0xc9a24a, 4);
  b.blob(0.011, cx, t.y1 + 0.335, cz, 0xc9a24a);
}

/** Low planting in front of a facade: a hedge or a bed of flowers between x0 and x1. */
function frontGarden(b: GeoBuilder, r: () => number, x0: number, x1: number, z0 = FRONT, z1 = LOT_FRONT - 0.01) {
  const w = x1 - x0;
  if (w < 0.05) return;
  const zc = (z0 + z1) / 2;
  if (r() < 0.45) {
    bx(b, w - 0.01, 0.04, Math.min(0.05, z1 - z0 - 0.01), (x0 + x1) / 2, G, zc, pick(r, [0x4f8f3e, 0x5c9c46, 0x3f7f3a] as const));
  } else {
    b.decal(w - 0.01, z1 - z0 - 0.01, (x0 + x1) / 2, G + 0.002, zc, SOIL);
    const n = Math.max(1, Math.min(4, Math.floor(w / 0.07)));
    for (let k = 0; k < n; k++) shrub(b, x0 + ((k + 0.5) * w) / n, G + 0.004, zc + (r() - 0.5) * 0.02, 0.022 + r() * 0.01, k % 2 ? pick(r, FLOWERS) : 0x5c9c46);
  }
}

/** Flat roof membrane, party-wall copings, a skylight or solar panels, and a vent. */
function flatRoof(b: GeoBuilder, r: () => number, w: number, z0: number, z1: number, y: number, coping: ColorLike, x = 0) {
  const d = z1 - z0;
  const zc = (z0 + z1) / 2;
  b.decal(w - 0.02, d - 0.02, x, y + 0.004, zc, pick(r, ROOF_TAR));
  for (const s of [-1, 1]) bx(b, 0.018, 0.024, d, x + s * (w / 2 - 0.009), y, zc, coping);
  bx(b, w, 0.024, 0.018, x, y, z0 + 0.009, coping);
  const span = w / 2 - 0.12;
  if (r() < 0.45) {
    // Solar panels, tilted to the south (−z)
    for (let k = 0; k < 2; k++) {
      const g = new THREE.PlaneGeometry(0.2, 0.12);
      g.rotateX(-Math.PI / 2 + 0.35);
      g.translate(x + (k - 0.5) * Math.min(0.24, w * 0.45), y + 0.04, zc - 0.05);
      add(b, g, 0x2a3f66, 'glass');
      bx(b, 0.2, 0.03, 0.01, x + (k - 0.5) * Math.min(0.24, w * 0.45), y, zc - 0.1, 0x9aa0a8);
    }
  } else {
    const sx = x + (r() - 0.5) * 2 * span;
    bx(b, 0.08, 0.02, 0.08, sx, y, zc - 0.05, 0xd8d4cc);
    b.decal(0.06, 0.06, sx, y + 0.022, zc - 0.05, 0x8fb4d0, 'glass');
  }
  b.cylinder(0.008, 0.008, 0.05, x + (r() - 0.5) * 2 * span, y, zc + 0.1, 0x9aa0a8, 4);
}

/** Backs of the homes: windows across a rear wall at x from -span/2..span/2. */
function rearWindows(b: GeoBuilder, r: () => number, L: Lights, rows: number[], cols: number, span: number, z: number, h: number, frame?: ColorLike, xc = 0) {
  for (const y of rows) {
    for (let c = 0; c < cols; c++) win(b, r, xc + ((c + 0.5) / cols - 0.5) * span, y, z, Math.PI, { w: 0.075, h, L, frame, share: 0.8 });
  }
}

/**
 * The backyard: a redwood fence along the back (where it meets the
 * mid-block garden) and down one side, and a little life in between. Flats
 * keep a paved yard with the bins.
 */
function backyard(b: GeoBuilder, r: () => number, ctx: HomeCtx, m: Massing, x0: number, x1: number) {
  const { st, role } = ctx;
  const zW = m.zB;
  const fx0 = role.street < 0 ? x0 : -0.5;
  const fx1 = role.street > 0 ? x1 : 0.5;
  fence(b, fx0, REAR, fx1, REAR);
  // Each home fences its own +x side; a corner home also walls its yard off from the side street.
  if (role.street <= 0) fence(b, 0.494, zW, 0.494, REAR);
  if (role.street) fence(b, role.street > 0 ? x1 : x0, zW, role.street > 0 ? x1 : x0, REAR, 0.1);
  const ya = fx0 + 0.04;
  const yb = fx1 - 0.04;
  const zm = (REAR + zW) / 2;
  const dz = zW - REAR - 0.03;
  if (dz < 0.05) return;
  if (m.yard === 'paved') {
    b.decal(yb - ya, dz, (ya + yb) / 2, G + 0.0015, zm, 0xc9c2b4);
    bins(b, ya + 0.03, REAR + 0.03, 1);
    if (r() < 0.6) {
      b.cylinder(0.03, 0.024, 0.04, yb - 0.06, G, zm, 0xc0643c, 6);
      tree(b, r, yb - 0.06, zm, 0.4, G + 0.04, st.yardTree === 'palm' ? 'ficus' : st.yardTree);
    }
    return;
  }
  const roll = r();
  const span = yb - ya;
  if (roll < 0.25) {
    // Patio, table and umbrella
    b.decal(0.34, dz, ya + 0.2, G + 0.0015, zm, 0xcfc4b4);
    b.cylinder(0.04, 0.04, 0.006, ya + 0.2, G + 0.045, zm, 0xf4f1ea, 8);
    b.cylinder(0.005, 0.005, 0.12, ya + 0.2, G, zm, IRON, 4);
    b.cylinder(0.003, 0.09, 0.035, ya + 0.2, G + 0.11, zm, pick(r, [0xd9534f, 0x2f8f9d, 0xf2c84b, 0xf4f1ea] as const), 6);
  } else if (roll < 0.5) {
    // Raised vegetable beds
    for (const u of [0.25, 0.6]) {
      const x = ya + span * u;
      bx(b, 0.2, 0.035, 0.08, x, G, zm, 0x9a7650);
      for (let k = 0; k < 3; k++) shrub(b, x - 0.06 + k * 0.06, G + 0.03, zm, 0.026, k % 2 ? 0x6fb84a : 0x4f9a3a, 0.6);
    }
  } else if (roll < 0.72) {
    // A small timber deck with a bench and a barbecue
    bx(b, 0.4, 0.02, dz, ya + 0.22, G, zm, 0xa27a54);
    bx(b, 0.16, 0.03, 0.04, ya + 0.24, G + 0.02, zm - 0.03, 0x7a5a3a);
    b.cylinder(0.022, 0.018, 0.05, ya + 0.36, G + 0.02, zm + 0.02, IRON, 6);
  } else if (roll < 0.85) {
    // A garden shed
    const sx = yb - 0.1;
    bx(b, 0.14, 0.11, 0.12, sx, G, zm, pick(r, [0x7a8f6a, 0xb08a62, 0x8a9aa8] as const));
    gableRoof(b, sx, 0.14, G + 0.11, 0.05, zm - 0.07, zm + 0.07, 0x5a4a44, 0.015, 0.012);
    panel(b, 0.045, 0.08, sx, G + 0.04, zm + 0.061, 0, 0x5a4a3a);
  } else {
    // A washing line
    for (const x of [ya + 0.05, yb - 0.05]) bx(b, 0.008, 0.12, 0.008, x, G, zm, 0x9aa0a8);
    beam(b, [ya + 0.05, G + 0.115, zm], [yb - 0.05, G + 0.115, zm], 0.003, 0.003, 0xe8e4dc);
    for (let k = 0; k < 4; k++) panel(b, 0.04, 0.05, ya + 0.12 + k * (span - 0.2) / 4, G + 0.09, zm, 0, pick(r, [0xf4f1ea, 0x6fa8e8, 0xe0607a, 0xf0c040] as const));
  }
  if (r() < 0.55) tree(b, r, roll < 0.72 ? yb - 0.12 : ya + 0.12, zm, 0.45 + r() * 0.15, G, st.yardTree);
}

/** A redwood board fence from (xa, za) to (xb, zb), axis-aligned, with a cap rail. */
function fence(b: GeoBuilder, xa: number, za: number, xb: number, zb: number, h = 0.075) {
  const along = Math.abs(xb - xa) > Math.abs(zb - za);
  const len = along ? Math.abs(xb - xa) : Math.abs(zb - za);
  const ang = along ? 0 : Math.PI / 2;
  const x = (xa + xb) / 2;
  const z = (za + zb) / 2;
  bx(b, len, h, 0.012, x, G, z, FENCE, false, ang);
  bx(b, len + 0.004, 0.008, 0.02, x, G + h, z, mul(FENCE, 0.8), false, ang);
}

/**
 * Sunset District "Doelger" row house: garage at the street, the living
 * floor above with a bay or picture window, stairs along the facade to an
 * arched door, and a parapet the whole street shares: Spanish tile, stepped
 * mission, or a storybook gable.
 */
function sunset(b: GeoBuilder, r: () => number, { st, L }: HomeCtx): Massing {
  const wall = pick(r, STUCCO);
  const trim: ColorLike = r() < 0.7 ? WHITE : mul(wall, 0.72);
  const tile = st.tile;
  const s = st.s;
  const w = FULL;
  const gH = 0.19;
  const lH = 0.25;
  const yL = G + gH;
  const top = yL + lH;
  const d = FRONT - BACK;
  bx(b, w, top - G, d, 0, G, 0, wall);
  bx(b, w + 0.004, 0.024, d + 0.004, 0, G, 0, mul(wall, 0.8));
  ledge(b, w + 0.008, 0.014, 0.012, 0, yL - 0.012, FRONT + 0.004, trim);

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
  const stepCol = st.variant === 1 ? 0x8a8f96 : st.variant === 2 ? 0xd8cfc0 : 0xb4563c;
  const stairWall = mul(wall, 0.9);
  stairX(b, FRONT + sd / 2, sd, s * 0.02, s * 0.36, gH, 7, stairWall, G, stepCol);
  bx(b, 0.125, gH, sd, s * 0.4225, G, FRONT + sd / 2, stairWall, true);
  b.decal(0.125, sd, s * 0.4225, yL + 0.0008, FRONT + sd / 2, stepCol);
  const railZ = FRONT + sd - 0.004;
  beam(b, [s * 0.02, G + gH / 7 + 0.055, railZ], [s * 0.36, yL + 0.055, railZ], 0.006, 0.008, IRON);
  beam(b, [s * 0.36, yL + 0.055, railZ], [s * 0.485, yL + 0.055, railZ], 0.006, 0.008, IRON);
  for (const px of [0.02, 0.19, 0.36, 0.48]) {
    const py = px <= 0.36 ? G + (gH * (px - 0.02)) / 0.34 + gH / 7 : yL;
    bx(b, 0.006, 0.055, 0.006, s * px, Math.max(G, py), railZ, IRON);
  }
  // Arched front door with a tiled hood, a lamp and the mailbox
  const xd = s * 0.43;
  archPanel(b, 0.095, 0.16, 0.04, xd, yL + 0.08, FRONT + 0.002, 0, trim);
  archPanel(b, 0.07, 0.14, 0.03, xd, yL + 0.07, FRONT + 0.004, 0, pick(r, DOORS));
  porchLight(b, s * 0.375, yL + 0.1, FRONT + 0.01);
  mailbox(b, s * 0.335, yL + 0.06, FRONT, IRON);
  {
    const t = new Tris();
    tiles(t, [xd - 0.07, yL + 0.165, FRONT + 0.04], [xd + 0.07, yL + 0.165, FRONT + 0.04], [xd + 0.07, yL + 0.19, FRONT], [xd - 0.07, yL + 0.19, FRONT], 5, tile, r, 0.004);
    t.flush(b);
  }

  // Living floor: an angled bay or a big picture window over the garage
  const pictured = r() < 0.4;
  if (!pictured) {
    bay(b, r, { x: gx, z: FRONT, y0: yL + 0.01, y1: top - 0.04, wf: 0.2, p: 0.055, wall, trim, rows: [{ y: yL + 0.11, h: 0.13 }], L, brackets: true });
  } else {
    const pw = 0.3;
    const ph = 0.14;
    const py = yL + 0.11;
    panel(b, pw + 0.03, ph + 0.03, gx, py, FRONT + 0.002, 0, trim);
    panel(b, pw, ph, gx, py, FRONT + 0.004, 0, lampColor(L, r), 'glow', onAt(L, r, 1.3));
    for (const m of [-1, 1]) panel(b, 0.009, ph, gx + (m * pw) / 6, py, FRONT + 0.006, 0, trim);
    ledge(b, pw + 0.05, 0.014, 0.025, gx, py - ph / 2 - 0.022, FRONT + 0.012, trim);
  }
  win(b, r, s * 0.2, yL + 0.12, FRONT, 0, { w: 0.06, h: 0.11, arch: 0.025, frame: trim, L, sill: trim });
  bx(b, 0.012, top - G, 0.012, -s * 0.478, G, FRONT + 0.006, mul(wall, 0.78), true);

  // Roof line: the street's parapet
  flatRoof(b, r, w, BACK, FRONT - 0.03, top, mul(wall, 0.9));
  if (st.variant === 0) {
    // Spanish tile pent roof along the parapet, and a tiled hat on the bay
    bx(b, w, 0.05, 0.035, 0, top, FRONT - 0.0175, wall);
    const t = new Tris();
    tiles(t, [-w / 2 - 0.005, top - 0.012, FRONT + 0.052], [w / 2 + 0.005, top - 0.012, FRONT + 0.052], [w / 2 + 0.005, top + 0.05, FRONT - 0.002], [-w / 2 - 0.005, top + 0.05, FRONT - 0.002], 16, tile, r);
    t.flush(b);
    ledge(b, w + 0.01, 0.012, 0.012, 0, top - 0.024, FRONT + 0.046, mul(tile, 0.7));
  } else if (st.variant === 1) {
    // Stepped mission parapet with coping
    bx(b, w, 0.04, 0.03, 0, top, FRONT - 0.015, wall);
    bx(b, 0.36, 0.04, 0.03, gx, top + 0.04, FRONT - 0.015, wall);
    bx(b, 0.2, 0.025, 0.03, gx, top + 0.08, FRONT - 0.015, wall);
    ledge(b, w + 0.012, 0.01, 0.038, 0, top + 0.04, FRONT - 0.015, trim);
    ledge(b, 0.37, 0.01, 0.038, gx, top + 0.08, FRONT - 0.015, trim);
    ledge(b, 0.21, 0.01, 0.038, gx, top + 0.105, FRONT - 0.015, trim);
    const t = new Tris();
    tiles(t, [gx - 0.18, top - 0.016, FRONT + 0.085], [gx + 0.18, top - 0.016, FRONT + 0.085], [gx + 0.18, top + 0.022, FRONT], [gx - 0.18, top + 0.022, FRONT], 8, tile, r);
    t.flush(b);
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
    win(b, r, gx, top + 0.07, FRONT, 0, { w: 0.05, h: 0.06, arch: 0.025, frame: trim, L, share: 0.6 });
    bx(b, w - gw2, 0.04, 0.03, s * (gw2 / 2), top, FRONT - 0.015, wall);
    ledge(b, w - gw2 + 0.01, 0.01, 0.036, s * (gw2 / 2), top + 0.04, FRONT - 0.015, trim);
  }
  bx(b, 0.05, 0.09, 0.05, s * 0.36, top, BACK + 0.06, mul(wall, 0.85));
  ledge(b, 0.06, 0.01, 0.06, s * 0.36, top + 0.09, BACK + 0.06, 0x8a8f96);
  if (r() < 0.35) {
    // A satellite dish on the parapet, aimed south
    const dish = new THREE.ConeGeometry(0.028, 0.012, 7, 1, true);
    dish.rotateX(1.2);
    dish.translate(-s * 0.3, top + 0.06, BACK + 0.05);
    add(b, dish, 0xe8e6e0);
    bx(b, 0.006, 0.05, 0.006, -s * 0.3, top, BACK + 0.06, 0x9aa0a8);
  }
  // A planter box under the living-room window
  bx(b, 0.24, 0.025, 0.03, gx, yL + 0.012, FRONT + (pictured ? 0.015 : 0.07), mul(trim, 0.92), true);
  for (let k = 0; k < 4; k++) shrub(b, gx - 0.09 + k * 0.06, yL + 0.03, FRONT + (pictured ? 0.016 : 0.071), 0.016, k % 2 ? pick(r, FLOWERS) : 0x4f9a3a, 1);

  // Back: windows, a back door and timber stairs down to the yard
  rearWindows(b, r, L, [yL + 0.13], 3, w * 0.75, BACK, 0.11, trim);
  panel(b, 0.07, 0.13, -s * 0.3, G + 0.065, BACK - 0.003, Math.PI, pick(r, DOORS));
  stairZ(b, s * 0.36, 0.07, BACK - 0.13, BACK - 0.06, gH, 5, 0xa27a54);
  bx(b, 0.1, 0.012, 0.06, s * 0.36, yL - 0.012, BACK - 0.03, 0xa27a54, true, Math.PI);
  for (const k of [-1, 1]) bx(b, 0.01, gH - 0.012, 0.01, s * 0.36 + k * 0.045, G, BACK - 0.055, 0x8a6440);

  // Front planting beside the driveway, and the bins out on collection night
  const gardenX0 = s > 0 ? -0.485 : gx + gw / 2 + 0.02;
  const gardenX1 = s > 0 ? gx - gw / 2 - 0.02 : 0.485;
  if (r() < 0.5) bins(b, s > 0 ? -0.47 : 0.47, LOT_FRONT - 0.03, s);
  else frontGarden(b, r, gardenX0, gardenX1);
  return { wall, trim, rows: [{ y: G + 0.11, h: 0.07 }, { y: yL + 0.13, h: 0.12 }], zB: BACK, top, yard: 'garden' };
}

/**
 * Marina-style Mediterranean: cream stucco, red tile, arched windows and
 * doors, iron balconettes, two floors over an arched garage. The street
 * shares its roof form and its bay.
 */
function marina(b: GeoBuilder, r: () => number, { st, L }: HomeCtx): Massing {
  const wall = pick(r, MED);
  const trim: ColorLike = r() < 0.55 ? 0xfbf6ea : mul(wall, 0.86);
  const tile = st.tile;
  const shutters = st.variant !== 1 ? mix(st.accent, 0x4f7a6a, 0.4) : undefined;
  const s = st.s;
  const w = FULL;
  const gH = 0.19;
  const f1 = 0.24;
  const f2 = 0.22;
  const y1 = G + gH;
  const y2 = y1 + f1;
  const top = y2 + f2;
  const d = FRONT - BACK;
  bx(b, w, top - G, d, 0, G, 0, wall);
  bx(b, w + 0.004, 0.026, d + 0.004, 0, G, 0, mul(wall, 0.8));
  ledge(b, w + 0.008, 0.016, 0.014, 0, y1 - 0.008, FRONT + 0.003, trim);

  // Arched garage door, timber planks
  const gx = -s * 0.2;
  archPanel(b, 0.33, 0.175, 0.05, gx, G + 0.0875, FRONT + 0.002, 0, trim);
  const wood = pick(r, [0x8a6440, 0x6e4e34, 0x9a7a58, 0x4f5a4f] as const);
  archPanel(b, 0.3, 0.16, 0.04, gx, G + 0.08, FRONT + 0.004, 0, wood);
  for (let k = -2; k <= 2; k++) panel(b, 0.005, 0.12, gx + k * 0.05, G + 0.065, FRONT + 0.0055, 0, mul(wood, 0.7));
  b.decal(0.34, LOT_FRONT - FRONT, gx, G + 0.0012, (FRONT + LOT_FRONT) / 2, 0xcbbfae);

  // Arched entry portal with steps, two lanterns and the mailbox
  const ex = s * 0.32;
  archPanel(b, 0.16, 0.19, 0.075, ex, G + 0.095 + 0.02, FRONT + 0.001, 0, trim);
  archPanel(b, 0.13, 0.17, 0.06, ex, G + 0.085 + 0.02, FRONT + 0.002, 0, 0x5a4a3e);
  panel(b, 0.07, 0.12, ex, G + 0.08, FRONT + 0.004, 0, pick(r, DOORS));
  archPanel(b, 0.07, 0.035, 0.03, ex, G + 0.158, FRONT + 0.004, 0, lampColor(L, r), 'glow', 0.15 + r() * 0.3);
  bx(b, 0.18, 0.02, 0.07, ex, G, FRONT + 0.035, 0xb4563c, true);
  bx(b, 0.18, 0.01, 0.095, ex, G, FRONT + 0.0475, 0xa64e36, true);
  for (const k of [-1, 1]) porchLight(b, ex + k * 0.1, G + 0.13, FRONT + 0.012);
  mailbox(b, ex + s * 0.13, G + 0.09, FRONT, 0x3a3a3a);
  // Small grilled window between them
  const mx = s * 0.08;
  win(b, r, mx, G + 0.11, FRONT, 0, { w: 0.06, h: 0.08, frame: trim, L, share: 0.5 });
  for (let k = -1; k <= 1; k++) panel(b, 0.005, 0.08, mx + k * 0.02, G + 0.11, FRONT + 0.008, 0, IRON);

  // First floor: a tiled box bay, or a triple arcade with a balconette (the street's choice)
  if (st.garage) {
    bx(b, 0.4, f1 - 0.05, 0.05, gx, y1 + 0.025, FRONT + 0.025, wall, true);
    for (let k = -1; k <= 1; k++) win(b, r, gx + k * 0.115, y1 + 0.115, FRONT + 0.05, 0, { w: 0.08, h: 0.13, arch: 0.03, frame: trim, L, bars: true, share: 1.2 });
    for (const k of [-1, 1]) bx(b, 0.03, 0.03, 0.04, gx + k * 0.17, y1 - 0.005, FRONT + 0.02, trim, true);
    const t = new Tris();
    tiles(t, [gx - 0.22, y2 - 0.03, FRONT + 0.075], [gx + 0.22, y2 - 0.03, FRONT + 0.075], [gx + 0.22, y2 + 0.012, FRONT], [gx - 0.22, y2 + 0.012, FRONT], 9, tile, r);
    t.flush(b);
  } else {
    for (let k = -1; k <= 1; k++) win(b, r, gx + k * 0.11, y1 + 0.12, FRONT, 0, { w: 0.085, h: 0.15, arch: 0.04, frame: trim, L, bars: true, share: 1.2 });
    bx(b, 0.36, 0.008, 0.04, gx, y1 + 0.035, FRONT + 0.02, IRON, true);
    ledge(b, 0.36, 0.006, 0.005, gx, y1 + 0.085, FRONT + 0.038, IRON);
    for (let k = 0; k <= 6; k++) panel(b, 0.004, 0.05, gx - 0.18 + k * 0.06, y1 + 0.06, FRONT + 0.038, 0, IRON);
  }
  win(b, r, ex, y1 + 0.12, FRONT, 0, { w: 0.085, h: 0.15, arch: 0.045, frame: trim, L, bars: true, sill: trim });
  // Second floor: shuttered windows, a shared balconette in the middle
  for (const x of [-0.36, -0.13, 0.13, 0.36]) win(b, r, x, y2 + 0.11, FRONT, 0, { w: 0.075, h: 0.12, frame: trim, L, bars: true, sill: trim, shutters });
  bx(b, 0.38, 0.008, 0.035, 0, y2 + 0.04, FRONT + 0.0175, IRON, true);
  ledge(b, 0.38, 0.005, 0.005, 0, y2 + 0.085, FRONT + 0.033, IRON);
  for (let k = 0; k <= 4; k++) panel(b, 0.004, 0.045, -0.19 + k * 0.095, y2 + 0.0625, FRONT + 0.033, 0, IRON);

  // Roof: the street's tiled hip over a moulded cornice, or a parapet with a tiled pent
  if (st.variant !== 2) {
    bx(b, w + 0.014, 0.022, d + 0.014, 0, top - 0.022, 0, trim);
    tileHip(b, r, 0, w, 0, d, top, 0.13, tile, 0.04);
  } else {
    flatRoof(b, r, w, BACK, FRONT - 0.03, top, mul(wall, 0.9));
    bx(b, w, 0.06, 0.035, 0, top, FRONT - 0.0175, wall);
    const t = new Tris();
    tiles(t, [-w / 2 - 0.005, top - 0.008, FRONT + 0.05], [w / 2 + 0.005, top - 0.008, FRONT + 0.05], [w / 2 + 0.005, top + 0.06, FRONT - 0.004], [-w / 2 - 0.005, top + 0.06, FRONT - 0.004], 16, tile, r);
    t.flush(b);
    ledge(b, w + 0.01, 0.014, 0.012, 0, top - 0.022, FRONT + 0.045, mul(tile, 0.7));
  }
  bx(b, 0.06, 0.12, 0.06, s * 0.38, top, BACK + 0.08, wall);
  bx(b, 0.075, 0.016, 0.075, s * 0.38, top + 0.12, BACK + 0.08, tile);

  rearWindows(b, r, L, [y1 + 0.12, y2 + 0.11], 3, w * 0.7, BACK, 0.11);
  panel(b, 0.07, 0.13, -s * 0.3, G + 0.065, BACK - 0.003, Math.PI, pick(r, DOORS));

  // Clipped hedge with terracotta pots
  const hx0 = s > 0 ? -0.485 : gx + 0.19;
  const hx1 = s > 0 ? gx - 0.19 : 0.485;
  if (hx1 - hx0 > 0.04) bx(b, hx1 - hx0, 0.045, 0.045, (hx0 + hx1) / 2, G, FRONT + 0.03, 0x4a8a3c, true);
  for (const k of [-1, 1]) {
    b.cylinder(0.018, 0.013, 0.03, ex + k * 0.11, G, FRONT + 0.07, 0xc0643c, 6);
    shrub(b, ex + k * 0.11, G + 0.025, FRONT + 0.07, 0.024, 0x3f7f3a, 1.3);
  }
  return { wall, trim, rows: [{ y: y1 + 0.12, h: 0.12 }, { y: y2 + 0.11, h: 0.11 }], zB: BACK, top, yard: 'garden' };
}

/**
 * Victorian cottage, detached: raised on a basement, a steep street-facing
 * gable with a shingled face and bargeboards, an angled bay, a porch with
 * stairs, a side path to the garden gate. The street shares its width,
 * its roof and which side the porch is on.
 */
function cottage(b: GeoBuilder, r: () => number, { st, L }: HomeCtx): Massing {
  const sch = pick(r, ladyPaints());
  const body = mix(sch.body, 0xffffff, 0.12);
  const trim = sch.trim;
  const accent = sch.accent;
  const roof = st.roof;
  const w = 0.8;
  const side = st.s;
  const xo = -side * (0.485 - w / 2);
  const zF = FRONT - 0.04;
  const baseH = 0.085;
  const mH = 0.27;
  const eave = G + baseH + mH;
  const rise = 0.25;
  const d = zF - BACK;
  const zc = (zF + BACK) / 2;
  bx(b, w, baseH, d, xo, G, zc, mul(body, 0.72));
  bx(b, w, mH, d, xo, G + baseH, zc, body);
  prismZ(b, [[xo - w / 2, eave], [xo + w / 2, eave], [xo, eave + rise]], BACK, zF, body);
  // Shingled gable face with a trim band
  prismZ(b, [[xo - w / 2 + 0.03, eave + 0.012], [xo + w / 2 - 0.03, eave + 0.012], [xo, eave + rise - 0.025]], zF, zF + 0.006, mix(accent, body, 0.35));
  ledge(b, w * 0.55, 0.012, 0.012, xo, eave + rise * 0.42, zF + 0.009, trim);
  bx(b, w + 0.02, 0.022, 0.028, xo, eave - 0.012, zF + 0.01, trim, true);
  for (let k = 0; k < 5; k++) bx(b, 0.012, 0.026, 0.024, xo - w / 2 + 0.03 + (k * (w - 0.06)) / 4, eave - 0.038, zF + 0.012, accent, true);
  gableRoof(b, xo, w, eave, rise, BACK - 0.035, zF + 0.05, roof, 0.045, 0.02);
  gableRoof(b, xo, w, eave - 0.008, rise, zF + 0.03, zF + 0.05, trim, 0.04, 0.03);
  bx(b, 0.012, 0.06, 0.012, xo, eave + rise - 0.01, zF + 0.04, trim);
  win(b, r, xo, eave + 0.1, zF + 0.006, 0, { w: 0.055, h: 0.07, arch: 0.027, frame: trim, L, bars: true, share: 0.6 });
  for (const [f, k] of [[0.2, 0.7], [0.66, 0.26]] as const) panel(b, w * k, 0.014, xo, eave + rise * f, zF + 0.0068, 0, mix(accent, body, 0.12));
  {
    const cx = xo - side * (w / 2 - 0.1);
    const roofAt = eave + (rise * 0.1) / (w / 2);
    bx(b, 0.06, roofAt + 0.13 - eave, 0.06, cx, eave, zc - 0.08, 0xa0523d);
    ledge(b, 0.072, 0.014, 0.072, cx, roofAt + 0.13, zc - 0.08, 0x8a8f96);
  }
  // A gabled dormer on the slope away from the chimney, the same side all along the street.
  {
    const ds = side;
    const dxF = xo + ds * (w / 2 - 0.1);
    const yb = eave + rise * 0.18;
    const dh = 0.12;
    bx(b, 0.16, dh, 0.15, dxF - ds * 0.05, yb, zc + 0.02, body);
    b.gable(0.2, 0.06, 0.17, dxF - ds * 0.05, yb + dh, zc + 0.02, roof, 0.012);
    win(b, r, dxF + ds * 0.03, yb + dh * 0.55, zc + 0.02, (ds * Math.PI) / 2, { w: 0.07, h: 0.07, frame: trim, L, bars: true, share: 0.7 });
  }

  // Angled bay on one side, porch and stair on the other
  const bxx = xo - side * (w / 2 - 0.16);
  bay(b, r, { x: bxx, z: zF, y0: G, y1: eave - 0.03, wf: 0.15, p: 0.055, wall: body, trim, accent, rows: [{ y: G + baseH + 0.13, h: 0.15 }], bands: [G + baseH], L });
  const ex = xo + side * (w / 2 - 0.095);
  const stepCol = st.variant === 0 ? mul(body, 0.7) : CONCRETE;
  bx(b, 0.15, baseH, 0.06, ex, G, zF + 0.03, stepCol, true);
  stairZ(b, ex, 0.12, LOT_FRONT - 0.005, zF + 0.06, baseH, 3, stepCol);
  for (const k of [-1, 1]) {
    const px = ex + k * 0.068;
    beam(b, [px, G + baseH / 3 + 0.05, LOT_FRONT - 0.01], [px, G + baseH + 0.05, zF + 0.06], 0.008, 0.008, trim);
    bx(b, 0.014, 0.19, 0.014, px, G + baseH, zF + 0.055, trim);
    bx(b, 0.02, 0.06, 0.02, px, G + baseH / 3, LOT_FRONT - 0.012, trim);
  }
  bx(b, 0.17, 0.018, 0.08, ex, G + baseH + 0.19, zF + 0.035, trim, true);
  ledge(b, 0.13, 0.014, 0.01, ex, G + baseH + 0.168, zF + 0.055, accent);
  prismZ(b, [[ex - 0.09, G + baseH + 0.208], [ex + 0.09, G + baseH + 0.208], [ex, G + baseH + 0.26]], zF, zF + 0.078, roof);
  panel(b, 0.09, 0.17, ex, G + baseH + 0.085, zF + 0.002, 0, trim);
  panel(b, 0.068, 0.13, ex, G + baseH + 0.065, zF + 0.004, 0, pick(r, DOORS));
  panel(b, 0.068, 0.025, ex, G + baseH + 0.15, zF + 0.004, 0, lampColor(L, r), 'glow', 0.1 + r() * 0.3);
  porchLight(b, ex - side * 0.05, G + baseH + 0.14, zF + 0.012);
  mailbox(b, ex + side * 0.05, G + baseH + 0.07, zF, accent);
  // A window between the bay and the porch
  const mx = (bxx + side * 0.145 + ex - side * 0.08) / 2;
  if (Math.abs(ex - bxx) > 0.34) win(b, r, mx, G + baseH + 0.13, zF, 0, { w: 0.065, h: 0.15, frame: trim, L, bars: true, sill: trim, head: trim });

  // Detached: windows down both sides and across the back
  for (const sd of [-1, 1]) {
    for (let c = 0; c < 3; c++) win(b, r, xo + sd * (w / 2), G + baseH + 0.15, BACK + ((c + 0.5) / 3) * d, (sd * Math.PI) / 2, { w: 0.06, h: 0.11, frame: trim, L, sill: trim, share: 0.8 });
  }
  rearWindows(b, r, L, [G + baseH + 0.15], 2, w * 0.6, BACK, 0.12, trim, xo);
  bx(b, 0.16, baseH, 0.07, xo + side * 0.2, G, BACK - 0.035, 0xa27a54, true, Math.PI);

  // Side path to a garden gate, the front garden, and a tree by the walk
  const pathX = side * (w / 2);
  const pw = FULL - w - 0.01;
  b.decal(pw, LOT_FRONT - BACK, pathX, G + 0.0012, (LOT_FRONT + BACK) / 2, CONCRETE);
  bx(b, pw, 0.08, 0.012, pathX, G, zF - 0.02, FENCE);
  b.decal(0.12, LOT_FRONT - zF - 0.08, ex, G + 0.0012, (zF + LOT_FRONT + 0.08) / 2, CONCRETE);
  frontGarden(b, r, Math.min(bxx, ex) + (side > 0 ? 0.15 : 0.09), Math.max(bxx, ex) - (side > 0 ? 0.09 : 0.15), zF + 0.065);
  // A picket fence along the front, with a gap for the walk
  const fz = LOT_FRONT - 0.012;
  const fa = xo - w / 2;
  const fb = ex - side * 0.07;
  const [p0, p1] = side > 0 ? [fa, fb] : [fb, xo + w / 2];
  if (p1 - p0 > 0.05) {
    bx(b, p1 - p0, 0.045, 0.008, (p0 + p1) / 2, G, fz, WHITE);
    ledge(b, p1 - p0, 0.006, 0.014, (p0 + p1) / 2, G + 0.045, fz, WHITE);
  }
  if (r() < 0.4) bins(b, pathX - side * 0.02, LOT_FRONT - 0.03, -side);
  return { wall: body, trim, rows: [{ y: G + baseH + 0.15, h: 0.11 }], zB: BACK, top: eave, detached: true, yard: 'garden' };
}

/** Painted ladies: two to a lot; on a corner, one wide house with a turret. The street shares one style, its height and its roof. */
function ladies(b: GeoBuilder, r: () => number, { st, L, role }: HomeCtx): Massing {
  const style = st.family as 'italianate' | 'queen' | 'stick';
  const roof = st.roof;
  const paints = ladyPaints();
  const s1 = pick(r, paints);
  let s2 = pick(r, paints);
  if (s2 === s1) s2 = paints[(paints.indexOf(s1) + 3) % paints.length]!;
  const paired = st.variant !== 0;
  const fh = 0.22;
  const gl = 0.12;
  const y1 = G + gl;
  const floors = st.floors;
  const eave = y1 + floors * fh;
  if (role.street) {
    // One wide corner house: the entry on the inner side, the bay mid-front, a turret on the corner.
    lady(b, r, 0, FULL, -role.street, s1, style, st.garage, roof, L, true);
  } else {
    lady(b, r, -FULL / 4, FULL / 2, paired ? st.s : -st.s, s1, style, st.garage, roof, L, false);
    lady(b, r, FULL / 4, FULL / 2, paired ? -st.s : -st.s, s2, style, st.garage, roof, L, false);
  }
  const outer = !role.street && role.open > 0 ? s2 : s1;
  const rows = Array.from({ length: floors }, (_, f) => ({ y: y1 + f * fh + fh * 0.52, h: 0.12 }));
  return {
    wall: outer.body,
    trim: outer.trim,
    rows,
    zB: BACK,
    top: eave,
    yard: 'garden',
    cornice: style === 'queen' ? undefined : { y: eave, proj: 0.05, crown: outer.trim, bracket: outer.accent },
    turret: role.street && style !== 'italianate' ? { y0: y1 + fh * 0.1, y1: eave + 0.06, roof, body: outer.body, accent: outer.accent } : undefined,
  };
}

/**
 * One painted lady, uw wide: a garden level, two or three floors with a
 * stacked angled bay, a recessed porch reached by a stoop, and either a
 * heavy bracketed cornice (Italianate/Stick) or a steep shingled gable
 * (Queen Anne).
 */
function lady(b: GeoBuilder, r: () => number, xc: number, uw: number, mir: number, sch: Scheme, style: 'italianate' | 'queen' | 'stick', garage: boolean, roof: ColorLike, L: Lights, corner: boolean) {
  const { body, trim, accent } = sch;
  const ew = 0.15;
  const gl = 0.12;
  const fh = 0.22;
  const floors = style === 'queen' ? 2 : 3;
  const y1 = G + gl;
  const eave = y1 + floors * fh;
  const d = FRONT - BACK;
  const ex = xc + mir * (uw / 2 - ew / 2);
  const pw = uw - ew;
  const px = corner ? xc - mir * (ew / 2 + 0.02) : xc - (mir * ew) / 2;
  const rec = 0.05;
  // Party walls run full depth; the porch is recessed into the entry bay.
  bx(b, pw - 0.002, eave - G, d, xc - (mir * ew) / 2, G, 0, body);
  bx(b, ew, gl, d, ex, G, 0, body);
  bx(b, ew, fh, d - rec, ex, y1, -rec / 2, body);
  bx(b, ew, eave - y1 - fh, d, ex, y1 + fh, 0, body);
  bx(b, uw - 0.002, 0.022, d + 0.004, xc, G, 0, mul(body, 0.72));
  for (let f = 1; f < floors; f++) ledge(b, uw - 0.002, 0.012, 0.01, xc, y1 + f * fh - 0.006, FRONT + 0.005, trim);

  // The bay
  const by0 = garage ? y1 + 0.004 : G;
  const rows = [] as { y: number; h: number }[];
  for (let f = 0; f < floors; f++) rows.push({ y: y1 + f * fh + fh * 0.52, h: 0.14 });
  const bands = [] as number[];
  for (let f = garage ? 1 : 0; f < floors; f++) bands.push(y1 + f * fh);
  bay(b, r, { x: px, z: FRONT, y0: by0, y1: eave - 0.035, wf: 0.15, p: 0.065, wall: body, trim, accent, rows, bands, L, brackets: garage });
  if (garage) {
    const gc = mix(accent, trim, 0.3);
    panel(b, 0.23, 0.11, px, G + 0.055, FRONT + 0.002, 0, trim);
    panel(b, 0.2, 0.095, px, G + 0.0475, FRONT + 0.004, 0, gc);
    for (let k = 1; k < 3; k++) panel(b, 0.2, 0.004, px, G + (0.095 * k) / 3, FRONT + 0.005, 0, mul(gc, 0.7));
    b.decal(0.22, LOT_FRONT - FRONT, px, G + 0.0012, (FRONT + LOT_FRONT) / 2, CONCRETE);
  } else {
    frontGarden(b, r, px - 0.16, px + 0.16, FRONT + 0.07);
  }
  // On a wide corner house, a column of windows between the bay and the porch.
  if (corner) {
    const wx = (px + mir * 0.16 + ex - mir * (ew / 2 + 0.01)) / 2;
    for (let f = 0; f < floors; f++) win(b, r, wx, y1 + f * fh + fh * 0.52, FRONT, 0, { w: 0.065, h: 0.14, frame: trim, L, bars: true, sill: trim, head: accent });
  }

  // Top: bracketed cornice, or the Queen Anne gable
  if (style !== 'queen') {
    cornice(b, xc, uw - 0.004, eave, FRONT, 0.06, trim, accent, Math.round(uw / 0.08), mix(accent, body, 0.5));
    bx(b, uw - 0.004, 0.035, 0.02, xc, eave + 0.033, FRONT - 0.01, body);
    flatRoof(b, r, uw, BACK, FRONT - 0.02, eave, mul(body, 0.85), xc);
    if (style === 'stick') {
      prismZ(b, [[px - 0.14, eave + 0.033], [px + 0.14, eave + 0.033], [px, eave + 0.13]], FRONT - 0.02, FRONT + 0.03, trim);
      prismZ(b, [[px - 0.11, eave + 0.042], [px + 0.11, eave + 0.042], [px, eave + 0.115]], FRONT + 0.03, FRONT + 0.034, accent);
    }
  } else {
    const rise = corner ? 0.3 : 0.25;
    bx(b, uw, 0.024, 0.032, xc, eave - 0.012, FRONT + 0.01, trim, true);
    for (let k = 0; k < 4; k++) bx(b, 0.012, 0.028, 0.026, xc - uw / 2 + 0.04 + (k * (uw - 0.08)) / 3, eave - 0.04, FRONT + 0.013, accent, true);
    prismZ(b, [[xc - uw / 2 + 0.001, eave], [xc + uw / 2 - 0.001, eave], [xc, eave + rise]], BACK, FRONT, body);
    prismZ(b, [[xc - uw / 2 + 0.03, eave + 0.014], [xc + uw / 2 - 0.03, eave + 0.014], [xc, eave + rise - 0.024]], FRONT, FRONT + 0.006, mix(accent, body, 0.4));
    ledge(b, uw * 0.56, 0.012, 0.012, xc, eave + rise * 0.4, FRONT + 0.009, trim);
    gableRoof(b, xc, uw, eave, rise, BACK - 0.02, FRONT + 0.05, roof, 0.03, 0.018);
    gableRoof(b, xc, uw, eave - 0.008, rise, FRONT + 0.032, FRONT + 0.052, trim, 0.026, 0.028);
    bx(b, 0.012, 0.07, 0.012, xc, eave + rise - 0.01, FRONT + 0.04, trim);
    const chx = xc - mir * (uw / 2 - 0.07);
    const roofAt = eave + (rise * 0.07) / (uw / 2);
    bx(b, 0.05, roofAt + 0.12 - eave, 0.05, chx, eave, -0.12, 0x9a4e3a);
    ledge(b, 0.06, 0.012, 0.06, chx, roofAt + 0.12, -0.12, 0x8a8f96);
    archPanel(b, 0.14, 0.04, 0.04, xc, eave + 0.135, FRONT + 0.007, 0, trim);
    win(b, r, xc, eave + 0.09, FRONT + 0.006, 0, { w: 0.08, h: 0.085, arch: 0.03, frame: accent, L, bars: true, share: 0.6 });
  }

  // Recessed porch: columns, a hood with a little pediment, door with a lit transom
  const hoodY = y1 + fh * 0.86;
  for (const k of [-1, 1]) bx(b, 0.016, hoodY - y1, 0.016, ex + k * (ew / 2 - 0.012), y1, FRONT - 0.008, trim);
  bx(b, ew + 0.012, 0.03, 0.04, ex, hoodY, FRONT - 0.004, trim, true);
  prismZ(b, [[ex - ew / 2 - 0.004, hoodY + 0.03], [ex + ew / 2 + 0.004, hoodY + 0.03], [ex, hoodY + 0.075]], FRONT - 0.02, FRONT + 0.016, accent);
  const zDoor = FRONT - rec;
  panel(b, 0.088, 0.165, ex, y1 + 0.0825, zDoor + 0.002, 0, trim);
  panel(b, 0.07, 0.12, ex, y1 + 0.06, zDoor + 0.004, 0, accent);
  panel(b, 0.07, 0.03, ex, y1 + 0.142, zDoor + 0.004, 0, lampColor(L, r), 'glow', 0.1 + r() * 0.25);
  porchLight(b, ex, hoodY - 0.04, FRONT - rec / 2);
  mailbox(b, ex + mir * 0.05, y1 + 0.07, zDoor, IRON);
  // The stoop, with rails and newel posts
  const stoopW = ew - 0.035;
  stairZ(b, ex, stoopW, LOT_FRONT - 0.004, FRONT, gl, 5, style === 'italianate' ? 0xb9b2a5 : mul(body, 0.65));
  for (const k of [-1, 1]) {
    const rx = ex + k * (stoopW / 2 + 0.004);
    beam(b, [rx, G + gl / 5 + 0.06, LOT_FRONT - 0.012], [rx, y1 + 0.06, FRONT - 0.005], 0.008, 0.009, trim);
    bx(b, 0.018, 0.07, 0.018, rx, G + gl / 5, LOT_FRONT - 0.012, accent);
    ledge(b, 0.02, 0.008, 0.02, rx, G + gl / 5 + 0.07, LOT_FRONT - 0.012, trim);
  }
  // Tall windows above the door
  for (let f = 1; f < floors; f++) {
    win(b, r, ex, y1 + f * fh + fh * 0.52, FRONT, 0, { w: 0.065, h: 0.14, frame: trim, L, bars: true, sill: trim, head: style === 'italianate' ? trim : accent });
  }
  // Back
  const backRows = Array.from({ length: floors }, (_, f) => y1 + f * fh + fh * 0.55);
  rearWindows(b, r, L, backRows, corner ? 3 : 2, uw * 0.6, BACK, 0.12, undefined, xc);
}

/**
 * Flats: Edwardian with stacked bays, a brick walk-up, or a streamline deco
 * block; the street shares the style and the height, so the cornices line
 * up. Black fire escapes, an entrance canopy, garages or a shop at street
 * level (always a corner shop on the corner), and a busy roof.
 */
function flats(b: GeoBuilder, r: () => number, { st, L, role }: HomeCtx): Massing {
  const floors = st.floors;
  const gH = 0.25;
  const fh = 0.21;
  const y1 = G + gH;
  const top = y1 + (floors - 1) * fh;
  const w = FULL;
  const zB = -0.38;
  const d = FRONT - zB;
  const zc = (FRONT + zB) / 2;
  const style = st.family as 'edwardian' | 'brick' | 'deco';
  const wall: ColorLike =
    style === 'brick'
      ? pick(r, [0xa8553f, 0xb8674a, 0xc79a6b, 0x9a4a3a] as const)
      : style === 'deco'
        ? pick(r, [0xeee4d0, 0xdfe8e0, 0xf1e0d6, 0xe6e2d8] as const)
        : pick(r, [0xeee3cb, 0xf4f1ea, 0xf1e2a8, 0xb9c6cf, 0xc3d3bd, 0xe8c4bd, 0xd8cfe0] as const);
  const trim: ColorLike = style === 'brick' ? 0xefe6d2 : st.variant === 0 ? mul(wall, 0.75) : WHITE;
  const accent = st.accent;
  bx(b, w, top - G, d, 0, G, zc, wall);
  bx(b, w + 0.006, gH, 0.012, 0, G, FRONT + 0.003, style === 'brick' ? 0x6f6a64 : mul(wall, 0.82), true);
  bx(b, w + 0.012, 0.02, 0.022, 0, y1 - 0.012, FRONT + 0.008, trim, true);
  if (style !== 'deco') for (const s of [-1, 1]) bx(b, 0.03, top - y1, 0.012, s * (w / 2 - 0.015), y1, FRONT + 0.006, trim, true);

  const ups: number[] = [];
  for (let f = 1; f < floors; f++) ups.push(y1 + (f - 1) * fh);
  let escapeX = 0;
  let escapeW = 0.22;
  let cornY = top + 0.002;
  let proj = 0.075;
  if (style === 'edwardian') {
    for (const s of [-1, 1]) {
      bay(b, r, { x: s * 0.28, z: FRONT, y0: y1 + 0.006, y1: top - 0.03, wf: 0.17, p: 0.06, wall, trim, rows: ups.map((y) => ({ y: y + fh * 0.5, h: 0.13 })), bands: ups.slice(1), L, brackets: true });
    }
    for (const y of ups) win(b, r, 0, y + fh * 0.5, FRONT, 0, { w: 0.08, h: 0.13, frame: trim, L, bars: true, sill: trim, share: 0.7 });
    cornice(b, 0, w, cornY, FRONT, proj, trim, trim, 8, accent);
  } else if (style === 'brick') {
    for (const y of ups) {
      for (const x of [-0.36, -0.13, 0.13, 0.36]) win(b, r, x, y + fh * 0.5, FRONT, 0, { w: 0.085, h: 0.13, frame: trim, L, bars: true, sill: trim });
      // Stone lintels, one course across the facade
      for (const x of [-0.245, 0.245]) panel(b, 0.36, 0.018, x, y + fh * 0.5 + 0.083, FRONT + 0.0015, 0, trim);
    }
    for (let f = 2; f < floors; f += 2) ledge(b, w, 0.014, 0.018, 0, y1 + (f - 1) * fh - 0.007, FRONT + 0.009, trim);
    escapeX = st.s * 0.245;
    escapeW = 0.36;
    proj = 0.07;
    cornice(b, 0, w, cornY, FRONT, proj, trim, trim, 8, trim);
  } else {
    // Deco: vertical fins over the entrance, ribbon windows with spandrels
    for (const k of [-1, 0, 1]) bx(b, 0.022, top + 0.12 - y1, 0.035, k * 0.045, y1, FRONT + 0.0175, trim, true);
    for (const y of ups) {
      for (const s of [-1, 1]) {
        win(b, r, s * 0.29, y + fh * 0.52, FRONT, 0, { w: 0.24, h: 0.12, frame: trim, L });
        panel(b, 0.24, 0.006, s * 0.29, y + fh * 0.52, FRONT + 0.006, 0, trim);
        panel(b, 0.26, 0.04, s * 0.29, y + 0.02, FRONT + 0.003, 0, accent);
      }
    }
    bx(b, w + 0.01, 0.04, 0.03, 0, top, FRONT - 0.005, trim);
    bx(b, 0.3, 0.07, 0.03, 0, top + 0.04, FRONT - 0.005, wall);
    ledge(b, 0.31, 0.012, 0.036, 0, top + 0.11, FRONT - 0.005, trim);
    escapeX = st.s * 0.29;
    escapeW = 0.3;
    cornY = -1;
  }
  fireEscape(b, escapeX, escapeW, ups.map((y) => y + 0.004), FRONT);

  // Ground floor: a shop (always, on a corner, on the side-street end) or garages and the lobby
  const corner = role.street !== 0;
  const shopSide = corner ? role.street : st.s;
  const lobbyX = -shopSide * 0.33;
  let shop: Massing['shop'];
  if (corner || r() < 0.3) {
    const sx = shopSide * 0.16;
    const sw = 0.6;
    const awn = corner ? st.accent : pick(r, [0x2f6b4f, 0xb33a3a, 0x2f4a6b, 0x8a4a2a, 0x1f3a3a] as const);
    const glowC: ColorLike = r() < 0.6 ? [1.7, 1.25, 0.75] : [1.3, 1.5, 1.6];
    shop = { awning: awn, glow: glowC, h: 0.215 };
    bx(b, sw + 0.01, 0.035, 0.016, sx, G, FRONT + 0.008, mul(awn, 0.6), true);
    panel(b, sw - 0.02, 0.125, sx, G + 0.035 + 0.0625, FRONT + 0.012, 0, glowC, 'glow', 0.03);
    for (let k = 1; k < 4; k++) panel(b, 0.008, 0.125, sx - sw / 2 + (k * sw) / 4, G + 0.0975, FRONT + 0.0145, 0, mul(awn, 0.6));
    bx(b, sw + 0.01, 0.045, 0.014, sx, G + 0.17, FRONT + 0.007, mul(awn, 0.55), true);
    panel(b, sw * 0.5, 0.016, sx, G + 0.1925, FRONT + 0.016, 0, pick(r, [[2.2, 1.6, 0.7], [2.0, 0.7, 1.2], [0.7, 1.8, 2.0]] as const), 'glow', 0.02);
    const t = new Tris();
    tiles(t, [sx - sw / 2, G + 0.165, FRONT + 0.09], [sx + sw / 2, G + 0.165, FRONT + 0.09], [sx + sw / 2, G + 0.215, FRONT + 0.004], [sx - sw / 2, G + 0.215, FRONT + 0.004], 10, awn, r, 0.004, 0xf4efe4);
    t.flush(b);
    // A bench and a sandwich board in the front strip
    bx(b, 0.12, 0.02, 0.03, sx - shopSide * 0.12, G + 0.025, FRONT + 0.06, 0x8a6440);
    bx(b, 0.1, 0.025, 0.02, sx - shopSide * 0.12, G, FRONT + 0.06, IRON);
    const g = new THREE.ConeGeometry(0.03, 0.06, 4, 1, true);
    g.rotateY(Math.PI / 4);
    g.scale(1, 1, 0.4);
    g.translate(sx + shopSide * 0.18, G + 0.03, FRONT + 0.07);
    add(b, g, 0x2a2a2a);
  } else {
    const gx = shopSide * 0.2;
    panel(b, 0.3, 0.17, gx, G + 0.085, FRONT + 0.011, 0, trim);
    panel(b, 0.27, 0.15, gx, G + 0.075, FRONT + 0.013, 0, 0x5b6068);
    for (let k = 1; k < 5; k++) panel(b, 0.27, 0.004, gx, G + 0.03 * k, FRONT + 0.0145, 0, 0x454a52);
    b.decal(0.3, LOT_FRONT - FRONT, gx, G + 0.0012, (FRONT + LOT_FRONT) / 2, CONCRETE);
    win(b, r, 0, G + 0.13, FRONT + 0.012, 0, { w: 0.06, h: 0.08, frame: trim, L, share: 0.5 });
    bins(b, gx + shopSide * 0.12, LOT_FRONT - 0.03, -shopSide);
  }
  // Lobby: glazed door, transom, canopy, lamps and a bank of mailboxes
  panel(b, 0.11, 0.2, lobbyX, G + 0.1, FRONT + 0.011, 0, trim);
  panel(b, 0.085, 0.15, lobbyX, G + 0.075, FRONT + 0.013, 0, 0x3a2e28);
  panel(b, 0.05, 0.1, lobbyX, G + 0.085, FRONT + 0.0145, 0, lampColor(L, r), 'glow', 0.05);
  panel(b, 0.085, 0.03, lobbyX, G + 0.175, FRONT + 0.013, 0, lampColor(L, r), 'glow', 0.08);
  bx(b, 0.17, 0.014, 0.1, lobbyX, G + 0.205, FRONT + 0.05, accent, true);
  ledge(b, 0.17, 0.02, 0.006, lobbyX, G + 0.198, FRONT + 0.1, mul(accent, 0.7));
  for (const k of [-1, 1]) porchLight(b, lobbyX + k * 0.075, G + 0.13, FRONT + 0.02);
  panel(b, 0.05, 0.04, lobbyX - shopSide * 0.11, G + 0.1, FRONT + 0.013, 0, 0xb08d57);
  stairZ(b, lobbyX, 0.12, LOT_FRONT - 0.01, FRONT + 0.012, 0.03, 2, CONCRETE);
  for (const k of [-1, 1]) {
    b.cylinder(0.02, 0.016, 0.035, lobbyX + k * 0.1, G, FRONT + 0.06, 0x8a8f96, 6);
    shrub(b, lobbyX + k * 0.1, G + 0.03, FRONT + 0.06, 0.024, 0x3f7f3a, 1.4);
  }

  // The back: windows, and stacked timber porches
  rearWindows(b, r, L, ups.map((y) => y + fh * 0.55), 4, w * 0.8, zB, 0.11);
  if (style !== 'deco') rearPorches(b, st.s * 0.24, ups, zB, L, r);

  // Roof: the stair penthouse, a water tank or HVAC, and a deck or a TV mast
  const rt = top;
  flatRoof(b, r, w, zB, FRONT - 0.04, rt, mul(wall, 0.88));
  const back = zB + 0.12;
  const pside = -st.s;
  bx(b, 0.17, 0.14, 0.15, pside * 0.33, rt, back, mul(wall, 0.92));
  ledge(b, 0.19, 0.014, 0.17, pside * 0.33, rt + 0.14, back, 0x6f6a66);
  panel(b, 0.06, 0.1, pside * 0.33, rt + 0.05, back + 0.076, 0, 0x4a4038);
  porchLight(b, pside * 0.33, rt + 0.11, back + 0.08);
  const tank = r() < 0.45;
  if (tank && !corner) {
    // Timber water tank on a steel stand
    const tx = -pside * 0.3;
    const tz = back + 0.02;
    for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) bx(b, 0.008, 0.06, 0.008, tx + lx * 0.04, rt, tz + lz * 0.04, IRON);
    ledge(b, 0.11, 0.008, 0.11, tx, rt + 0.06, tz, IRON);
    b.cylinder(0.055, 0.055, 0.11, tx, rt + 0.068, tz, 0x8a6a4a, 8);
    b.cylinder(0, 0.062, 0.045, tx, rt + 0.178, tz, 0x5a4a3a, 8);
  } else {
    for (let k = 0; k < 2; k++) {
      const hx = -pside * (0.15 + k * 0.17);
      bx(b, 0.12, 0.06, 0.08, hx, rt, back, 0xc4c8cc);
      b.decal(0.05, 0.05, hx, rt + 0.0605, back, 0x4a4e54);
    }
  }
  // A corner building has its shop and a second street front; its roof stays plain.
  const deckRoll = corner ? 1 : r();
  if (deckRoll < 0.38) {
    // Roof deck: boards, planters, an umbrella and string lights
    const dz = FRONT - 0.2;
    bx(b, 0.5, 0.012, 0.22, 0, rt, dz, 0xa27a54);
    for (const s of [-1, 1]) {
      bx(b, 0.04, 0.04, 0.2, s * 0.23, rt + 0.012, dz, 0x7a5a3a);
      for (let k = 0; k < 3; k++) shrub(b, s * 0.23, rt + 0.04, dz - 0.07 + k * 0.07, 0.03, k % 2 ? 0x4f9a3a : pick(r, FLOWERS));
    }
    b.cylinder(0.004, 0.004, 0.13, 0.05, rt + 0.012, dz, IRON, 4);
    b.cylinder(0.003, 0.1, 0.035, 0.05, rt + 0.13, dz, pick(r, [0xd9534f, 0x2f8f9d, 0xf2c84b, 0xf4f1ea] as const), 6);
    for (let k = 0; k < 6; k++) {
      const u = k / 5;
      b.box(0.012, 0.012, 0.012, -0.2 + u * 0.4, rt + 0.13 - Math.sin(u * Math.PI) * 0.025, dz + 0.1, [2.2, 1.7, 0.9], true);
    }
    beam(b, [-0.2, rt + 0.13, dz + 0.1], [0.2, rt + 0.13, dz + 0.1], 0.003, 0.003, IRON);
  } else if (deckRoll < 0.62) {
    // A TV mast, a satellite dish and a row of potted plants
    const ax = (r() - 0.5) * 0.5;
    b.cylinder(0.004, 0.004, 0.2, ax, rt, FRONT - 0.15, 0x9aa0a8, 4);
    for (let k = 0; k < 3; k++) bx(b, 0.09 - k * 0.022, 0.004, 0.004, ax, rt + 0.12 + k * 0.03, FRONT - 0.15, 0x9aa0a8);
    const dish = new THREE.ConeGeometry(0.03, 0.014, 8, 1, true);
    dish.rotateX(-1.1);
    dish.translate(ax + 0.12, rt + 0.04, FRONT - 0.12);
    add(b, dish, 0xe8e6e0);
    for (let k = 0; k < 4; k++) {
      b.cylinder(0.016, 0.012, 0.024, -0.3 + k * 0.08, rt, FRONT - 0.07, 0xc0643c, 6);
      shrub(b, -0.3 + k * 0.08, rt + 0.02, FRONT - 0.07, 0.022, k % 2 ? 0x4f9a3a : 0x6fb84a, 1.2);
    }
  }
  return {
    wall,
    trim,
    rows: ups.map((y) => ({ y: y + fh * 0.5, h: 0.12 })),
    zB,
    top,
    shop: corner ? shop : undefined,
    sideWin: style === 'deco' ? { w: 0.2, cols: 2 } : undefined,
    cornice: cornY > 0 ? { y: cornY, proj, crown: trim, bracket: trim } : undefined,
    yard: 'paved',
  };
}

const FAMILIES: Record<Family, (b: GeoBuilder, r: () => number, ctx: HomeCtx) => Massing> = {
  sunset,
  marina,
  cottage,
  italianate: ladies,
  queen: ladies,
  stick: ladies,
  edwardian: flats,
  brick: flats,
  deco: flats,
};

/** Stacked timber back porches with a stair zig-zagging between them: the backs of SF flats. */
function rearPorches(b: GeoBuilder, x: number, ys: number[], z: number, L: Lights, r: () => number) {
  const pw = 0.3;
  const pd = 0.07;
  const wood = 0xb08a62;
  ys.forEach((y, i) => {
    bx(b, pw, 0.01, pd, x, y, z - pd / 2, wood, true, Math.PI);
    ledge(b, pw, 0.006, 0.008, x, y + 0.055, z - pd + 0.004, wood, Math.PI);
    panel(b, 0.05, 0.09, x + (i % 2 ? -0.08 : 0.08), y + 0.055, z - 0.003, Math.PI, lampColor(L, r), 'glow', onAt(L, r, 0.6));
    const yb = i === 0 ? G : ys[i - 1]! + 0.01;
    const dir = i % 2 ? 1 : -1;
    beam(b, [x + dir * (pw / 2 - 0.08), y + 0.008, z - pd * 0.5], [x - dir * (pw / 2 - 0.03), yb, z - pd * 0.5], 0.035, 0.008, mul(wood, 0.9));
  });
  const top = ys[ys.length - 1]! + 0.06;
  for (const s of [-1, 1]) bx(b, 0.01, top - G, 0.01, x + s * (pw / 2 - 0.005), G, z - pd + 0.005, mul(wood, 0.8));
}

/** Black zig-zag fire escape: platforms with railings at each floor, stairs between, a drop ladder. */
function fireEscape(b: GeoBuilder, x: number, fw: number, ys: number[], z: number) {
  const fd = 0.055;
  ys.forEach((y, i) => {
    bx(b, fw, 0.008, fd, x, y, z + fd / 2, IRON, true);
    ledge(b, fw, 0.006, 0.006, x, y + 0.052, z + fd - 0.003, IRON);
    for (const s of [-1, 1]) panel(b, fd, 0.058, x + s * (fw / 2 - 0.0025), y + 0.029, z + fd / 2, Math.PI / 2, IRON);
    // Railing balusters, read as a thin screen
    panel(b, fw, 0.05, x, y + 0.03, z + fd - 0.002, 0, mix(IRON, 0x8a8f96, 0.15));
    if (i < ys.length - 1) {
      const dir = i % 2 ? 1 : -1;
      beam(b, [x + dir * (fw / 2 - 0.035), y + 0.008, z + fd * 0.45], [x - dir * (fw / 2 - 0.075), ys[i + 1]!, z + fd * 0.45], 0.03, 0.008, IRON);
    }
  });
  const y0 = ys[0]!;
  for (const s of [-1, 1]) bx(b, 0.004, 0.13, 0.004, x + fw / 2 - 0.035 + s * 0.012, y0 - 0.13, z + fd - 0.01, IRON);
}

// ─── Neighbourhood grounds: sidewalks, street trees, the mid-block garden ─

/** Width of the block's sidewalk band, and of its curb. */
const SW = SIDEWALK;
const CURB = 0.018;

/** Street-tree species, one per block, varied block to block like real SF streets. */
const STREET_TREES: readonly TreeKind[] = ['plane', 'ficus', 'round', 'palm', 'plane', 'pine', 'ficus', 'round'];

/**
 * Everything on a neighbourhood block that isn't a home, in world space:
 * a sidewalk and granite curb right round the block, street trees in tree
 * wells at every lot line, a lamp on each corner, the shared garden in the
 * middle (pools in the outer ring), and the two corner lots: pocket parks,
 * or a corner store on every third block.
 */
export function neighbourhoodGrounds(bx0: number, bz0: number, n: number, seed: number): Built {
  const r = rng(seed);
  const b = new GeoBuilder();
  const c = blockCentre({ bx: bx0, bz: bz0 });
  const H = BLOCK / 2;
  const ring = neighbourhoodRing(n);
  bx(b, BLOCK, 0.02, BLOCK, c.x, 0, c.z, PALETTE.sidewalk);

  const walk = mix(PALETTE.sidewalk, 0xffffff, 0.12);
  const joint = mul(PALETTE.sidewalk, 0.82);
  const granite = 0xc9c3b6;
  const inner = H - SW;
  // Sidewalks all the way round: north and south bands run the full length, east and west fill between.
  for (const s of [-1, 1]) {
    bx(b, BLOCK, 0.01, SW, c.x, 0.02, c.z + s * (H - SW / 2), walk);
    bx(b, SW, 0.01, BLOCK - 2 * SW, c.x + s * (H - SW / 2), 0.02, c.z, walk);
    for (let k = 1; k < BLOCK * 4; k++) {
      b.decal(0.006, SW - CURB, c.x - H + k * 0.25, 0.0302, c.z + s * (H - (SW + CURB) / 2), joint);
      b.decal(SW - CURB, 0.006, c.x + s * (H - (SW + CURB) / 2), 0.0302, c.z - H + k * 0.25, joint);
    }
    bx(b, BLOCK, 0.036, CURB, c.x, 0, c.z + s * (H - CURB / 2), granite);
    bx(b, CURB, 0.036, BLOCK - 2 * CURB, c.x + s * (H - CURB / 2), 0, c.z, granite);
  }

  // Vacant home lots wait as rough grass until the house goes up (the home's own lawn covers this).
  for (const lot of homeLots(n)) {
    const p = lotPosition({ bx: bx0, bz: bz0 }, lot);
    const role = lotRole(n, lot);
    const lx0 = role.street < 0 ? -(0.5 - SW) : -0.5;
    const lx1 = role.street > 0 ? 0.5 - SW : 0.5;
    const pts = [[lx0, -0.5], [lx1, -0.5], [lx1, 0.5 - SW], [lx0, 0.5 - SW]].map(([x, z]) => [p.x + x! * Math.cos(lot.rot) + z! * Math.sin(lot.rot), p.z - x! * Math.sin(lot.rot) + z! * Math.cos(lot.rot)]);
    const xs = pts.map((q) => q[0]!);
    const zs = pts.map((q) => q[1]!);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const z0 = Math.min(...zs);
    const z1 = Math.max(...zs);
    b.decal(x1 - x0 - 0.004, z1 - z0 - 0.004, (x0 + x1) / 2, 0.026, (z0 + z1) / 2, 0xa9c27a);
  }

  // Street trees in tree wells on every lot line, all one species, all one size: a tidy avenue.
  const avenue = WORLD_SPEC.classic ? STREET_TREES : (WORLD_SPEC.look.yardTrees as readonly TreeKind[]);
  const species = avenue[n % avenue.length]!;
  const scale = species === 'palm' ? 0.6 : species === 'pine' ? 0.62 : 0.58;
  const well = mul(PALETTE.sidewalk, 0.7);
  for (const s of [-1, 1]) {
    for (const u of [-1, 0, 1]) {
      for (const [x, z] of [[c.x + u, c.z + s * (H - SW * 0.5)], [c.x + s * (H - SW * 0.5), c.z + u]] as const) {
        b.decal(0.07, 0.07, x, 0.031, z, SOIL);
        ledge(b, 0.074, 0.004, 0.006, x, 0.03, z + 0.034, well);
        ledge(b, 0.074, 0.004, 0.006, x, 0.03, z - 0.034, well, Math.PI);
        tree(b, r, x, z, scale, 0.03, species);
      }
    }
  }

  // A lamp on every corner, its arm reaching over the street.
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) lamp(b, c.x + sx * (H - 0.05), c.z + sz * (H - 0.05), sz);
  // A white-topped San Francisco hydrant, and a blue mailbox on one corner.
  {
    const hx = c.x + (n % 2 ? -1 : 1) * 0.5;
    const hz = c.z + (n % 4 < 2 ? -1 : 1) * (H - 0.04);
    b.cylinder(0.014, 0.017, 0.045, hx, 0.03, hz, 0xf2efe8, 6);
    b.cylinder(0.011, 0.015, 0.014, hx, 0.075, hz, pick(r, [0x3a6fd8, 0xe8c040, 0xd84a3a] as const), 6);
    bx(b, 0.042, 0.01, 0.01, hx, 0.055, hz, 0xf2efe8);
    const mx = c.x - (n % 2 ? -1 : 1) * (H - 0.16);
    const mz = c.z + (n % 4 < 2 ? 1 : -1) * (H - 0.045);
    bx(b, 0.04, 0.05, 0.035, mx, 0.04, mz, 0x2f5fa8);
    b.cylinder(0.02, 0.02, 0.035, mx, 0.072, mz, 0x2f5fa8, 8, false, Math.PI / 2);
    for (const k of [-1, 1]) bx(b, 0.006, 0.01, 0.006, mx + k * 0.015, 0.03, mz, IRON);
  }

  // The mid-block garden (2×2 lots behind the homes): pools in the outer ring, shared gardens further in.
  b.decal(2, 2, c.x, 0.025, c.z, mix(PALETTE.lawn, PALETTE.grassDark, 0.2));
  midBlock(b, r, c.x, c.z, ring === 2 ? 4 : ring === 0 ? (n % 2 ? 2 : 0) : n % 3 === 0 ? 1 : n % 3 === 1 ? 0 : 3);

  // The two corner lots: pocket parks, or a corner store and a park.
  treeLots(n).forEach((lot, k) => {
    const p = lotPosition({ bx: bx0, bz: bz0 }, lot);
    const sx = Math.sign(lot.i - (BLOCK - 1) / 2);
    const sz = Math.sign(lot.j - (BLOCK - 1) / 2);
    if (k === 0 && n % 3 === 1) {
      cornerStore(b, r, p.x, p.z, sx, sz);
      return;
    }
    const x0 = Math.max(p.x - 0.5, c.x - inner);
    const x1 = Math.min(p.x + 0.5, c.x + inner);
    const z0 = Math.max(p.z - 0.5, c.z - inner);
    const z1 = Math.min(p.z + 0.5, c.z + inner);
    pocketPark(b, r, x0, x1, z0, z1, sx, sz, (n + k) % 3);
  });
  seal(b);
  return b.build();
}

/** Green-painted SF street lamp with an arm over the street and a glowing lantern. */
function lamp(b: GeoBuilder, x: number, z: number, out: number) {
  const pole = 0x2f4a3e;
  bx(b, 0.034, 0.04, 0.034, x, 0.03, z, pole);
  bx(b, 0.016, 0.5, 0.016, x, 0.03, z, pole);
  beam(b, [x, 0.52, z], [x, 0.53, z + out * 0.1], 0.01, 0.012, pole);
  ledge(b, 0.05, 0.012, 0.05, x, 0.52, z + out * 0.1, pole);
  b.box(0.036, 0.03, 0.036, x, 0.49, z + out * 0.1, PALETTE.lamp, true);
  bx(b, 0.012, 0.012, 0.012, x, 0.532, z + out * 0.1, pole);
}

function bench(b: GeoBuilder, x: number, y: number, z: number, rotY: number) {
  bx(b, 0.16, 0.012, 0.05, x, y + 0.03, z, 0x8a6440, false, rotY);
  bx(b, 0.16, 0.035, 0.008, x - Math.sin(rotY) * 0.024, y + 0.042, z - Math.cos(rotY) * 0.024, 0x8a6440, false, rotY);
  bx(b, 0.14, 0.03, 0.04, x, y, z, IRON, false, rotY);
}

/** A point on a building face: `u` along it, `v` out from it, for a face looking along `ang` (0 faces +z). */
function onFace(x: number, z: number, ang: number, u: number, v: number): [number, number] {
  return [x + u * Math.cos(ang) + v * Math.sin(ang), z - u * Math.sin(ang) + v * Math.cos(ang)];
}

/**
 * The corner store: two floors on the corner lot, flush with both street
 * walls. A lit shopfront and a striped awning on each street face, the
 * door on the corner, a sign band, the flat upstairs under a cornice, and
 * newspaper boxes and a bench out front.
 */
function cornerStore(b: GeoBuilder, r: () => number, px: number, pz: number, sx: number, sz: number) {
  const wall = pick(r, [0xe9dcc4, 0xd8c4a8, 0xc9d6c8, 0xe8c4b0, 0xb9c6cf] as const);
  const trim = WHITE;
  const awn = pick(r, [0x2f6b4f, 0xb33a3a, 0x2f4a6b, 0x8a4a2a] as const);
  const sign: ColorLike = pick(r, [[2.2, 1.5, 0.6], [2.0, 0.6, 0.9], [0.7, 1.7, 2.0]] as const);
  const shopGlow: ColorLike = [1.7, 1.25, 0.75];
  const L: Lights = { lit: 0.6, warm: 1 };
  const edge = 0.5 - SETBACK;
  // Footprint: from the street walls back to 0.1 short of the lot's inner edges.
  const xa = px - sx * 0.4;
  const xb = px + sx * edge;
  const za = pz - sz * 0.4;
  const zb = pz + sz * edge;
  const cx = (xa + xb) / 2;
  const cz = (za + zb) / 2;
  const w = Math.abs(xb - xa);
  const d = Math.abs(zb - za);
  const gH = 0.24;
  const top = G + gH + 0.22;
  b.decal(1 - SW, 1 - SW, px - (sx * SW) / 2, 0.026, pz - (sz * SW) / 2, 0xc9c2b4);
  bx(b, w, top - G, d, cx, G, cz, wall);
  bx(b, w + 0.006, 0.024, d + 0.006, cx, G, cz, mul(wall, 0.75));
  flatRoof(b, r, w, cz - d / 2, cz + d / 2, top, mul(wall, 0.88), cx);
  bx(b, 0.12, 0.06, 0.08, cx - sx * 0.1, top, cz - sz * 0.1, 0xc4c8cc);
  // The two street faces.
  const faces = [
    { fx: xb, fz: cz, ang: (sx * Math.PI) / 2, len: d },
    { fx: cx, fz: zb, ang: sz > 0 ? 0 : Math.PI, len: w },
  ];
  for (const f of faces) {
    const at = (u: number, v: number) => onFace(f.fx, f.fz, f.ang, u, v);
    // Kickplate, shop glass with mullions, a sign band over it
    const gl = f.len - 0.12;
    {
      const [x, z] = at(0, 0.008);
      bx(b, gl + 0.01, 0.035, 0.016, x, G, z, mul(awn, 0.6), true, f.ang);
    }
    {
      const [x, z] = at(0, 0.012);
      panel(b, gl - 0.02, 0.13, x, G + 0.035 + 0.065, z, f.ang, shopGlow, 'glow', 0.03);
    }
    for (let k = 1; k < 4; k++) {
      const [x, z] = at(-gl / 2 + (k * gl) / 4, 0.0145);
      panel(b, 0.008, 0.13, x, G + 0.1, z, f.ang, mul(awn, 0.6));
    }
    {
      const [x, z] = at(0, 0.007);
      bx(b, f.len, 0.05, 0.014, x, G + 0.175, z, mul(awn, 0.55), true, f.ang);
      const [sx2, sz2] = at(0, 0.016);
      panel(b, f.len * 0.55, 0.022, sx2, G + 0.2, sz2, f.ang, sign, 'glow', 0.02);
    }
    // Striped awning
    {
      const A = at(-gl / 2, 0.1);
      const B = at(gl / 2, 0.1);
      const C = at(gl / 2, 0.004);
      const D = at(-gl / 2, 0.004);
      const t = new Tris();
      tiles(t, [A[0], G + 0.16, A[1]], [B[0], G + 0.16, B[1]], [C[0], G + 0.215, C[1]], [D[0], G + 0.215, D[1]], 9, awn, r, 0.004, 0xf4efe4);
      t.flush(b);
    }
    // Upstairs: two windows over the shop, and the cornice
    for (const u of [-0.17, 0.12]) {
      const [x, z] = at(u, 0);
      win(b, r, x, G + gH + 0.11, z, f.ang, { w: 0.075, h: 0.12, frame: trim, L, bars: true, sill: trim });
    }
    cornice(b, f.fx, f.len, top, f.fz, 0.05, trim, trim, 6, undefined, f.ang);
    // Out front: newspaper boxes or a bench
    const [ox, oz] = at(-gl / 4, 0.17);
    if (f.ang === faces[0]!.ang) {
      for (let k = 0; k < 2; k++) {
        const [nx, nz] = at(-gl / 4 + k * 0.045, 0.17);
        bx(b, 0.035, 0.06, 0.03, nx, 0.03, nz, k ? 0xd84a3a : 0x2f6fb5, false, f.ang);
      }
    } else bench(b, ox, 0.03, oz, f.ang);
  }
  // The door at the corner end of one face, under a lamp
  const doorF = faces[1]!;
  const du = (doorF.len / 2 - 0.045) * (sz > 0 ? sx : -sx);
  {
    const [x, z] = onFace(doorF.fx, doorF.fz, doorF.ang, du, 0.013);
    panel(b, 0.07, 0.15, x, G + 0.075, z, doorF.ang, 0x3a2e28);
    porchLight(b, x, G + 0.16, z);
  }
  // The inner faces: a window each upstairs, and the bins in the side yard
  for (const f of [
    { fx: xa, fz: cz, ang: (-sx * Math.PI) / 2 },
    { fx: cx, fz: za, ang: sz > 0 ? Math.PI : 0 },
  ]) {
    win(b, r, f.fx, G + gH + 0.11, f.fz, f.ang, { w: 0.07, h: 0.11, frame: trim, L, sill: trim, share: 0.6 });
  }
  bins(b, xa - sx * 0.05, za + sz * 0.15, sz);
}

/** Shared backyard space in the middle of the block; one of five layouts. */
function midBlock(b: GeoBuilder, r: () => number, cx: number, cz: number, v: number) {
  const y = 0.03;
  if (v === 0) {
    // Commons: a stepping-stone path, a deck with lights, flower borders, shade trees
    for (let k = 0; k < 11; k++) {
      const u = k / 10;
      b.decal(0.07, 0.06, cx - 0.8 + u * 1.5, y + 0.001, cz + 0.6 - u * 1.3 + Math.sin(u * 5) * 0.12, 0xd8d0c0);
    }
    bx(b, 0.6, 0.025, 0.42, cx + 0.42, y, cz + 0.45, 0xa27a54);
    for (let k = 1; k < 6; k++) b.decal(0.004, 0.42, cx + 0.12 + k * 0.1, y + 0.0255, cz + 0.45, 0x8a6440);
    bx(b, 0.2, 0.012, 0.1, cx + 0.42, y + 0.07, cz + 0.45, 0x7a5a3a);
    bx(b, 0.03, 0.045, 0.03, cx + 0.42, y + 0.025, cz + 0.45, IRON);
    bench(b, cx + 0.42, y + 0.025, cz + 0.33, 0);
    bench(b, cx + 0.42, y + 0.025, cz + 0.57, Math.PI);
    for (const s of [-1, 1]) bx(b, 0.01, 0.24, 0.01, cx + 0.42 + s * 0.28, y + 0.025, cz + 0.66, IRON);
    beam(b, [cx + 0.14, y + 0.26, cz + 0.66], [cx + 0.7, y + 0.26, cz + 0.66], 0.003, 0.003, IRON);
    for (let k = 0; k < 7; k++) {
      const u = k / 6;
      b.box(0.014, 0.014, 0.014, cx + 0.15 + u * 0.54, y + 0.25 - Math.sin(u * Math.PI) * 0.04, cz + 0.66, [2.2, 1.6, 0.8], true);
    }
    bx(b, 0.7, 0.03, 0.12, cx - 0.4, y, cz - 0.82, SOIL);
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
        bx(b, 0.28, 0.045, 0.16, x, y, z, 0x9a7650);
        b.decal(0.25, 0.13, x, y + 0.046, z, SOIL);
        const crop = pick(r, [0x6fb84a, 0x4f9a3a, 0x8fcf5a, 0x7a9a3a] as const);
        for (let k = 0; k < 4; k++) shrub(b, x - 0.09 + k * 0.06, y + 0.045, z, 0.026, k % 2 && r() < 0.4 ? 0xd84a3a : crop, 0.7);
      }
    }
    // Greenhouse
    b.box(0.34, 0.14, 0.24, cx + 0.55, y, cz - 0.7, 0xcfe6f0, 'glass');
    prismZ(b, [[cx + 0.38, y + 0.14], [cx + 0.72, y + 0.14], [cx + 0.55, y + 0.23]], cz - 0.82, cz - 0.58, 0xcfe6f0, 'glass');
    for (let k = 0; k < 4; k++) bx(b, 0.008, 0.14, 0.244, cx + 0.38 + k * 0.113, y, cz - 0.7, WHITE);
    // Shed
    bx(b, 0.2, 0.15, 0.16, cx - 0.65, y, cz - 0.72, 0x7a8f6a);
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
      for (const s of [-1, 1]) bx(b, 0.003, 0.17, 0.003, cx + sx + s * 0.025, y + 0.07, cz + 0.2, 0x9aa0a8);
      bx(b, 0.06, 0.008, 0.03, cx + sx, y + 0.065, cz + 0.2, 0xe85a4a);
    }
    bx(b, 0.14, 0.18, 0.14, cx + 0.45, y, cz + 0.5, 0xf2c84b);
    gableRoof(b, cx + 0.45, 0.16, y + 0.24, 0.07, cz + 0.42, cz + 0.58, 0xe85a4a, 0.02, 0.012);
    for (const [px, pz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) bx(b, 0.012, 0.06, 0.012, cx + 0.45 + px * 0.065, y + 0.18, cz + 0.5 + pz * 0.065, 0xf2c84b);
    beam(b, [cx + 0.38, y + 0.18, cz + 0.5], [cx + 0.16, y + 0.01, cz + 0.5], 0.06, 0.012, 0x3aa38e);
    bx(b, 0.4, 0.015, 0.4, cx - 0.4, y, cz + 0.45, PALETTE.sand);
    for (const [px, pz] of [[-0.4, -0.35], [0.35, -0.45]] as const) {
      bx(b, 0.2, 0.012, 0.08, cx + px, y + 0.05, cz + pz, 0x8a6440);
      for (const s of [-1, 1]) bx(b, 0.2, 0.01, 0.03, cx + px, y + 0.03, cz + pz + s * 0.065, 0x8a6440);
      bx(b, 0.16, 0.05, 0.06, cx + px, y, cz + pz, IRON);
    }
    tree(b, r, cx - 0.7, cz - 0.7, 0.95, y, 'round');
    tree(b, r, cx + 0.75, cz - 0.75, 0.9, y, 'eucalyptus');
    tree(b, r, cx - 0.75, cz + 0.05, 0.8, y, 'plane');
  } else if (v === 3) {
    // Private backyards: four fenced gardens
    fenceW(b, cx, cz, 2, 0);
    fenceW(b, cx, cz, 2, Math.PI / 2);
    // NE: patio and barbecue
    b.decal(0.5, 0.4, cx + 0.5, y + 0.001, cz + 0.5, 0xcfc4b4);
    bx(b, 0.07, 0.06, 0.05, cx + 0.3, y, cz + 0.4, IRON);
    for (const k of [-1, 1]) bx(b, 0.05, 0.04, 0.05, cx + 0.55 + k * 0.1, y, cz + 0.5, 0xf4f1ea);
    b.cylinder(0.045, 0.045, 0.006, cx + 0.55, y + 0.06, cz + 0.5, 0xf4f1ea, 8);
    // SE: hot tub on a deck
    bx(b, 0.5, 0.025, 0.4, cx + 0.5, y, cz - 0.5, 0xa27a54);
    bx(b, 0.2, 0.06, 0.2, cx + 0.55, y + 0.025, cz - 0.5, 0x7a5a3a);
    b.decal(0.17, 0.17, cx + 0.55, y + 0.086, cz - 0.5, PALETTE.pool, 'glass');
    // SW: vegetable beds
    for (let k = 0; k < 3; k++) {
      bx(b, 0.5, 0.035, 0.1, cx - 0.5, y, cz - 0.7 + k * 0.2, 0x9a7650);
      for (let j = 0; j < 6; j++) shrub(b, cx - 0.7 + j * 0.08, y + 0.03, cz - 0.7 + k * 0.2, 0.024, j % 3 ? 0x5fae42 : 0xd84a3a, 0.6);
    }
    // NW: lawn and a trampoline
    b.cylinder(0.16, 0.16, 0.05, cx - 0.5, y, cz + 0.5, 0x3a3e46, 10);
    b.cylinder(0.17, 0.17, 0.008, cx - 0.5, y + 0.05, cz + 0.5, 0x3a6fd8, 10);
    tree(b, r, cx - 0.8, cz + 0.15, 0.8, y, 'round');
    tree(b, r, cx + 0.2, cz - 0.2, 0.75, y, 'plane');
    tree(b, r, cx - 0.2, cz - 0.3, 0.55, y, 'palm');
  } else {
    // The outer ring's big gardens: fenced into four, two pools with loungers, a lawn and a summer house
    fenceW(b, cx, cz, 2, 0);
    fenceW(b, cx, cz, 2, Math.PI / 2);
    for (const [qx, qz, long] of [[1, 1, true], [-1, -1, false]] as const) {
      const px = cx + qx * 0.5;
      const pz = cz + qz * 0.5;
      const pw = long ? 0.56 : 0.36;
      const pd = long ? 0.3 : 0.4;
      bx(b, pw + 0.24, 0.006, pd + 0.2, px, y, pz, 0xe6dccb);
      bx(b, pw + 0.04, 0.012, pd + 0.04, px, y + 0.006, pz, 0xf4efe4);
      b.decal(pw, pd, px, y + 0.0185, pz, PALETTE.pool, 'glass');
      b.decal(pw * 0.92, 0.012, px, y + 0.019, pz + pd / 2 - 0.01, mix(PALETTE.pool, 0xffffff, 0.45), 'glass');
      // Loungers along one side and an umbrella
      for (let k = 0; k < 2; k++) {
        const lx = px - pw / 2 + 0.07 + k * 0.1;
        const lz = pz - qz * (pd / 2 + 0.07);
        bx(b, 0.06, 0.012, 0.12, lx, y + 0.012, lz, 0xf4f1ea);
        bx(b, 0.06, 0.03, 0.012, lx, y + 0.012, lz - qz * 0.055, 0xf4f1ea);
      }
      b.cylinder(0.004, 0.004, 0.13, px + pw / 2 + 0.05, y, pz - qz * (pd / 2 + 0.06), IRON, 4);
      b.cylinder(0.003, 0.09, 0.035, px + pw / 2 + 0.05, y + 0.12, pz - qz * (pd / 2 + 0.06), pick(r, [0xd9534f, 0x2f8f9d, 0xf2c84b, 0xf4f1ea] as const), 6);
      palm(b, r, px - qx * 0.38, pz + qz * 0.36, 0.6, y);
    }
    // NW: lawn with a summer house
    bx(b, 0.24, 0.13, 0.2, cx - 0.55, y, cz + 0.55, 0xf4efe4);
    gableRoof(b, cx - 0.55, 0.24, y + 0.13, 0.07, cz + 0.43, cz + 0.67, 0x5a6470, 0.02, 0.012);
    panel(b, 0.1, 0.09, cx - 0.55, y + 0.06, cz + 0.451 - 0.0, Math.PI, [1.4, 0.95, 0.5], 'glow', 0.3);
    tree(b, r, cx - 0.25, cz + 0.3, 0.8, y, 'round');
    // SE: an orchard and beds
    for (let k = 0; k < 3; k++) tree(b, r, cx + 0.25 + k * 0.25, cz - 0.3 - (k % 2) * 0.35, 0.55, y, 'ficus');
    bx(b, 0.5, 0.035, 0.1, cx + 0.5, y, cz - 0.85, 0x9a7650);
  }
}

/** A long garden fence through (x, z), `len` long, turned by `ang`. */
function fenceW(b: GeoBuilder, x: number, z: number, len: number, ang: number) {
  bx(b, len, 0.07, 0.012, x, 0.03, z, FENCE, false, ang);
  bx(b, len + 0.004, 0.008, 0.02, x, 0.1, z, mul(FENCE, 0.8), false, ang);
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
    palm(b, r, cx - sx * 0.12, cz - sz * 0.15, 0.8, y);
    palm(b, r, cx + sx * 0.05, cz - sz * 0.3, 0.65, y);
    palm(b, r, cx - sx * 0.3, cz + sz * 0.02, 0.7, y);
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
