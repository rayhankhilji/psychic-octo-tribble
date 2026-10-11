import * as THREE from 'three';
import { GeoBuilder, type ColorLike } from './geo.ts';
import { PALETTE } from './palette.ts';
import { pick, rng } from '../world/rng.ts';
import { BLOCK, blockCentre, lotPosition, treeLots, type HomeKind } from '../world/layout.ts';

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

const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const e = new THREE.Euler();
const v3 = new THREE.Vector3();
const one = new THREE.Vector3(1, 1, 1);

// ─── Vegetation ───────────────────────────────────────────────────────────

export type TreeKind = 'palm' | 'round' | 'cypress';

export function palm(b: GeoBuilder, r: () => number, x: number, z: number, scale = 1, y = 0) {
  const s = scale * (0.85 + r() * 0.4);
  const h = 1.05 * s;
  const lean = r() * Math.PI * 2;
  const lx = Math.cos(lean) * 0.05 * s;
  const lz = Math.sin(lean) * 0.05 * s;
  for (let k = 0; k < 3; k++) {
    const rr = 0.032 * s * (1 - k * 0.18);
    b.cylinder(rr * 0.9, rr, h / 3 + 0.01, x + lx * k * k * 0.5, y + (k * h) / 3, z + lz * k * k * 0.5, PALETTE.palmTrunk, 5);
  }
  const tx = x + lx * 2;
  const ty = y + h;
  const tz = z + lz * 2;
  const frond = pick(r, PALETTE.fronds);
  const n = 7;
  for (let i = 0; i < n; i++) {
    const len = (0.36 + r() * 0.1) * s;
    const g = new THREE.BoxGeometry(len, 0.012 * s, 0.09 * s);
    g.translate(len / 2, 0, 0);
    e.set(0, (i / n) * Math.PI * 2 + r() * 0.4, -(0.35 + r() * 0.35), 'YZX');
    q.setFromEuler(e);
    m4.compose(v3.set(tx, ty, tz), q, one);
    b.transformed(g, m4, frond);
  }
  b.blob(0.035 * s, tx, ty - 0.02, tz, 0x7a5a32);
}

export function tree(b: GeoBuilder, r: () => number, x: number, z: number, scale = 1, y = 0, kind?: TreeKind) {
  const k: TreeKind = kind ?? (r() < 0.45 ? 'palm' : r() < 0.75 ? 'round' : 'cypress');
  if (k === 'palm') return palm(b, r, x, z, scale, y);
  const s = scale * (0.8 + r() * 0.4);
  if (k === 'cypress') {
    const c = pick(r, PALETTE.pine);
    b.cylinder(0.03 * s, 0.04 * s, 0.15 * s, x, y, z, PALETTE.trunk, 5);
    b.cylinder(0, 0.16 * s, 0.6 * s, x, y + 0.1 * s, z, c, 6);
    return;
  }
  const leaves = pick(r, PALETTE.leaves);
  b.cylinder(0.035 * s, 0.05 * s, 0.24 * s, x, y, z, PALETTE.trunk, 5);
  b.blob(0.21 * s, x, y + 0.38 * s, z, leaves);
  b.blob(0.15 * s, x + 0.1 * s, y + 0.5 * s, z - 0.06 * s, leaves);
  b.blob(0.13 * s, x - 0.1 * s, y + 0.46 * s, z + 0.07 * s, leaves);
}

// ─── Homes (one per customer, in lot-local space, door facing +z) ─────────

export function home(kind: HomeKind, seed: number): Built {
  const r = rng(seed);
  const b = new GeoBuilder();
  b.box(0.96, 0.03, 0.96, 0, 0, 0, PALETTE.lawn);
  b.decal(0.12, 0.26, 0.18, 0.032, 0.35, PALETTE.sidewalk);

  if (kind === 'house') {
    const style = r();
    if (style < 0.45) spanish(b, r);
    else if (style < 0.75) modern(b, r);
    else craftsman(b, r);
  } else if (kind === 'townhouse') {
    for (let u = 0; u < 2; u++) victorian(b, r, (u - 0.5) * 0.44);
  } else {
    apartment(b, r);
  }
  return b.build();
}

function spanish(b: GeoBuilder, r: () => number) {
  const w = 0.5 + r() * 0.12;
  const d = 0.42 + r() * 0.06;
  const storeys = r() < 0.3 ? 2 : 1;
  const h = 0.25 * storeys + 0.06;
  const z0 = -0.02;
  b.box(w, h, d, 0, 0.03, z0, pick(r, [0xf6e7c8, 0xf3c6a2, 0xf8f5ee, 0xf4a6a0, 0xf6df8c] as const));
  if (r() < 0.5) b.hip(w, 0.16, d, 0, 0.03 + h, z0, pick(r, PALETTE.roofs.slice(0, 3)));
  else b.gable(w, 0.18, d, 0, 0.03 + h, z0, pick(r, PALETTE.roofs.slice(0, 3)));
  b.quad(0.1, 0.16, 0.12, 0.03 + 0.08, z0 + d / 2 + 0.004, 'z+', PALETTE.door, false);
  b.windows({ w, d, x: 0, z: z0, y0: 0.03, rows: storeys, rowHeight: 0.25, cols: 2, faces: ['z+', 'x+', 'x-'] }, r, 0.75, warmth(r), { w: 0.09, h: 0.1 });
  if (r() < 0.3) b.box(0.42, 0.012, 0.15, 0, 0.03, -0.37, PALETTE.pool); // backyard pool
  if (r() < 0.6) palm(b, r, -0.38, 0.36, 0.55, 0.03);
}

function modern(b: GeoBuilder, r: () => number) {
  const w = 0.46;
  const d = 0.46;
  const x0 = -0.2;
  const tall = r() < 0.5;
  b.box(w, 0.26, d, x0, 0.03, -0.04, PALETTE.trim);
  b.box(w + 0.08, 0.025, d + 0.08, x0, 0.29, -0.04, 0xe9e4da);
  if (tall) {
    b.box(w * 0.7, 0.22, d * 0.8, x0 - 0.05, 0.315, -0.06, PALETTE.trim);
    b.box(w * 0.7 + 0.06, 0.025, d * 0.8 + 0.06, x0 - 0.05, 0.535, -0.06, 0xe9e4da);
    b.quad(0.24, 0.14, x0 - 0.05, 0.42, -0.06 + (d * 0.8) / 2 + 0.004, 'z+', warmth(r));
  }
  b.box(0.1, 0.24, 0.02, x0 + 0.17, 0.03, -0.04 + d / 2 + 0.01, PALETTE.wood);
  b.quad(0.26, 0.17, x0 - 0.06, 0.03 + 0.11, -0.04 + d / 2 + 0.004, 'z+', warmth(r)); // big glass wall
  b.quad(0.3, 0.14, x0 + w / 2 + 0.004, 0.15, -0.04, 'x+', warmth(r));
  // Pool and deck in the side yard: very LA.
  b.box(0.36, 0.015, 0.7, 0.28, 0.03, -0.02, 0xe8e2d6);
  b.box(0.26, 0.016, 0.52, 0.28, 0.031, -0.04, PALETTE.pool);
  if (r() < 0.7) palm(b, r, 0.36, 0.38, 0.6, 0.03);
}

function craftsman(b: GeoBuilder, r: () => number) {
  const w = 0.56;
  const d = 0.46;
  const z0 = -0.04;
  const wall = pick(r, PALETTE.walls);
  b.box(w, 0.3, d, 0, 0.03, z0, wall);
  b.gable(w, 0.2, d, 0, 0.33, z0, pick(r, PALETTE.roofs.slice(3)));
  b.box(w, 0.025, 0.14, 0, 0.03, z0 + d / 2 + 0.07, PALETTE.wood); // porch
  b.box(w, 0.02, 0.16, 0, 0.27, z0 + d / 2 + 0.07, PALETTE.trim);
  for (const px of [-w / 2 + 0.03, w / 2 - 0.03]) b.box(0.03, 0.22, 0.03, px, 0.05, z0 + d / 2 + 0.13, PALETTE.trim);
  b.quad(0.09, 0.16, 0, 0.03 + 0.08, z0 + d / 2 + 0.004, 'z+', PALETTE.door, false);
  b.windows({ w, d, x: 0, z: z0, y0: 0.03, rows: 1, rowHeight: 0.3, cols: 3, faces: ['z+', 'x+', 'x-'] }, r, 0.7, warmth(r), { w: 0.09, h: 0.1 });
  if (r() < 0.6) tree(b, r, -0.36, 0.36, 0.6, 0.03, 'round');
}

/** San Francisco painted lady: narrow, tall, bay window, street-facing gable. */
function victorian(b: GeoBuilder, r: () => number, x: number) {
  const w = 0.42;
  const d = 0.6;
  const h = 0.72 + r() * 0.12;
  const z0 = -0.06;
  b.box(w, h, d, x, 0.03, z0, pick(r, PALETTE.victorian));
  b.box(w + 0.03, 0.03, d + 0.02, x, 0.03 + h, z0, PALETTE.trim); // cornice
  b.box(w + 0.01, 0.02, d + 0.01, x, 0.03 + h * 0.48, z0, PALETTE.trim); // belt course
  b.gable(d, 0.24, w, x, 0.06 + h, z0, pick(r, PALETTE.roofs), 0.02, Math.PI / 2);
  // Bay window on the street face
  const front = z0 + d / 2;
  b.box(0.24, h * 0.8, 0.08, x - 0.05, 0.1, front + 0.04, pick(r, PALETTE.victorian));
  b.box(0.27, 0.025, 0.1, x - 0.05, 0.1 + h * 0.8, front + 0.04, PALETTE.trim);
  for (let row = 0; row < 2; row++) {
    const y = 0.22 + row * h * 0.4;
    b.quad(0.16, 0.14, x - 0.05, y, front + 0.084, 'z+', r() < 0.7 ? warmth(r) : PALETTE.darkGlass, true);
  }
  b.box(0.1, 0.05, 0.12, x + 0.13, 0.03, front + 0.05, PALETTE.trim); // stoop
  b.quad(0.07, 0.15, x + 0.13, 0.17, front + 0.004, 'z+', PALETTE.door, false);
}

function apartment(b: GeoBuilder, r: () => number) {
  const floors = 5 + Math.floor(r() * 3);
  const fh = 0.19;
  const h = floors * fh;
  const wall = pick(r, [0xf6e7c8, 0xf8f5ee, 0xf3c6a2, 0xbfe4d0, 0xc6dcf2] as const);
  b.box(0.8, h, 0.72, 0, 0.03, -0.04, wall);
  b.box(0.84, 0.06, 0.76, 0, 0.03 + h, -0.04, PALETTE.trim);
  b.windows({ w: 0.8, d: 0.72, x: 0, z: -0.04, y0: 0.22, rows: floors - 1, rowHeight: fh, cols: 4 }, r, 0.6, warmth(r), { w: 0.1, h: 0.1 });
  // Balconies on the street face
  for (let f = 1; f < floors; f++) b.box(0.62, 0.02, 0.08, 0, 0.03 + f * fh, 0.36, PALETTE.trim);
  b.quad(0.16, 0.18, 0, 0.12, 0.324, 'z+', PALETTE.glass, false);
  // Roof deck with a planter palm
  b.box(0.3, 0.03, 0.3, -0.18, 0.09 + h, -0.16, PALETTE.wood);
  b.box(0.14, 0.08, 0.12, 0.24, 0.09 + h, 0.12, PALETTE.steel);
  palm(b, r, -0.18, -0.16, 0.45, 0.12 + h);
}

// ─── Neighbourhood grounds: pavements, a park, corner trees ───────────────

export function neighbourhoodGrounds(bx: number, bz: number, n: number, seed: number): Built {
  const r = rng(seed);
  const b = new GeoBuilder();
  const c = blockCentre({ bx, bz });
  b.box(BLOCK, 0.02, BLOCK, c.x, 0, c.z, PALETTE.sidewalk);
  b.box(1.9, 0.04, 1.9, c.x, 0.02, c.z, PALETTE.lawn);

  const variant = n % 3;
  if (variant === 0) {
    b.cylinder(0.42, 0.42, 0.02, c.x - 0.3, 0.06, c.z + 0.25, PALETTE.pool, 14);
    b.cylinder(0.47, 0.47, 0.016, c.x - 0.3, 0.055, c.z + 0.25, PALETTE.sand, 14);
    for (let i = 0; i < 4; i++) tree(b, r, c.x + 0.5 + (r() - 0.5) * 0.6, c.z - 0.5 + (r() - 0.5) * 0.6, 0.8, 0.06);
  } else if (variant === 1) {
    // Basketball court
    b.box(1.2, 0.012, 0.8, c.x - 0.2, 0.06, c.z + 0.2, 0xd8743a);
    b.box(1.0, 0.014, 0.6, c.x - 0.2, 0.06, c.z + 0.2, 0x3aa38e);
    b.box(0.012, 0.016, 0.6, c.x - 0.2, 0.062, c.z + 0.2, PALETTE.trim);
    for (const hx of [-0.65, 0.25]) b.box(0.02, 0.2, 0.02, c.x + hx, 0.06, c.z + 0.2, PALETTE.steel);
    for (let i = 0; i < 3; i++) palm(b, r, c.x + 0.7, c.z - 0.7 + i * 0.5, 0.7, 0.06);
  } else {
    // Playground and picnic lawn
    b.box(0.6, 0.012, 0.6, c.x + 0.4, 0.06, c.z + 0.4, PALETTE.sand);
    b.box(0.08, 0.22, 0.08, c.x + 0.3, 0.06, c.z + 0.35, 0xe85a4a);
    b.box(0.3, 0.03, 0.08, c.x + 0.45, 0.2, c.z + 0.35, 0xf2c84b);
    for (let i = 0; i < 4; i++) tree(b, r, c.x - 0.5 + (r() - 0.5) * 0.7, c.z - 0.3 + (r() - 0.5) * 1.0, 0.85, 0.06);
  }
  b.box(0.3, 0.05, 0.08, c.x + 0.45, 0.06, c.z - 0.75, PALETTE.wood); // bench
  b.cylinder(0.012, 0.012, 0.36, c.x + 0.7, 0.06, c.z + 0.7, PALETTE.steel, 4);
  b.blob(0.035, c.x + 0.7, 0.44, c.z + 0.7, PALETTE.lamp, true);

  for (const lot of treeLots(n)) {
    const p = lotPosition({ bx, bz }, lot);
    b.box(0.96, 0.03, 0.96, p.x, 0.02, p.z, PALETTE.lawn);
    palm(b, r, p.x - 0.15, p.z - 0.1, 1.0, 0.05);
    tree(b, r, p.x + 0.2, p.z + 0.18, 0.8, 0.05, 'round');
  }
  return b.build();
}

