import * as THREE from 'three';
import { GeoBuilder, type ColorLike } from './geo.ts';
import { PALETTE } from './palette.ts';
import { pick, rng } from '../world/rng.ts';
import {
  BLOCK,
  FRONTAGE_LOTS,
  blockCentre,
  lotPosition,
  treeLots,
  type DistrictDef,
  type HomeKind,
} from '../world/layout.ts';

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

// ─── Commercial districts, unlocked by MRR milestones ─────────────────────

export function district(def: DistrictDef, seed: number): Built {
  const r = rng(seed);
  const b = new GeoBuilder();
  const c = blockCentre(def);
  const neon = bright(def.neon, 2.4);
  b.box(BLOCK, 0.03, BLOCK, c.x, 0, c.z, PALETTE.plaza);

  if (def.tier === 0) {
    shops(b, r, def, neon);
  } else if (def.tier === 7) {
    spire(b, r, c.x, c.z, neon);
  } else {
    const quads = [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const;
    quads.forEach(([qx, qz], i) => {
      const x = c.x + qx;
      const z = c.z + qz;
      if (def.tier === 1) deco(b, r, x, z, neon);
      else if (def.tier === 2) campus(b, r, x, z, neon);
      else if (def.tier === 5 && i === 0) pyramid(b, r, x, z);
      else tower(b, r, x, z, def.tier, neon);
    });
  }
  return b.build();
}

function shops(b: GeoBuilder, r: () => number, def: DistrictDef, neon: ColorLike) {
  const c = blockCentre(def);
  for (const [px, pz] of [[0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]] as const) palm(b, r, c.x + px, c.z + pz, 0.8, 0.03);
  for (let i = 0; i <= 8; i++) b.blob(0.025, c.x - 0.8 + i * 0.2, 0.62 - Math.sin((i / 8) * Math.PI) * 0.08, c.z, PALETTE.lamp, true);
  // Food truck and café umbrellas
  b.box(0.42, 0.22, 0.2, c.x, 0.03, c.z + 0.25, 0xf4f1ea);
  b.box(0.42, 0.04, 0.2, c.x, 0.25, c.z + 0.25, 0xe85a4a);
  b.quad(0.24, 0.08, c.x, 0.16, c.z + 0.354, 'z+', neon);
  for (const [ux, uz] of [[-0.35, -0.3], [0.3, -0.35]] as const) {
    b.cylinder(0.008, 0.008, 0.26, c.x + ux, 0.03, c.z + uz, PALETTE.steel, 4);
    b.cylinder(0.0, 0.17, 0.07, c.x + ux, 0.26, c.z + uz, pick(r, [0xe85a4a, 0xf2c84b, 0x3aa3c8] as const), 8);
  }

  for (const lot of FRONTAGE_LOTS) {
    const p = lotPosition(def, lot);
    const parts = new GeoBuilder();
    const h = 0.38 + r() * 0.3;
    const wall = pick(r, PALETTE.walls);
    const awning = pick(r, [0xe85a4a, 0x2f8fb8, 0x3aa36a, 0xf2a03a] as const);
    parts.box(0.86, h, 0.7, 0, 0.03, -0.08, wall);
    parts.box(0.9, 0.05, 0.74, 0, 0.03 + h, -0.08, PALETTE.trim);
    parts.quad(0.62, 0.2, 0, 0.15, 0.274, 'z+', warmth(r));
    for (let s = 0; s < 4; s++) parts.box(0.2, 0.02, 0.16, -0.3 + s * 0.2, 0.3, 0.33, s % 2 ? PALETTE.trim : awning); // striped awning
    parts.box(0.5, 0.08, 0.02, 0, 0.03 + h + 0.06, 0.2, neon, true); // sign
    const built = parts.build();
    const g = new THREE.Group();
    g.add(built.group);
    g.rotation.y = lot.rot;
    g.position.set(p.x, 0, p.z);
    g.updateMatrixWorld(true);
    bake(b, built.group);
  }
}

/** Art deco pastels with neon blades, Sunset Strip style. */
export function deco(b: GeoBuilder, r: () => number, x: number, z: number, neon: ColorLike) {
  const h = 1.1 + r() * 0.8;
  const w = 1.5;
  const wall = pick(r, [0xf3c6a2, 0xbfe4d0, 0xf8f5ee, 0xeab6cf, 0xf6df8c] as const);
  b.box(w, h, w, x, 0.03, z, wall);
  b.box(w * 0.6, 0.3, w * 0.6, x, 0.03 + h, z, wall);
  b.box(w * 0.3, 0.25, w * 0.3, x, 0.33 + h, z, PALETTE.trim);
  for (let f = 1; f < Math.floor(h / 0.24); f++) b.box(w + 0.02, 0.025, w + 0.02, x, 0.03 + f * 0.24, z, PALETTE.trim);
  b.windows({ w, d: w, x, z, y0: 0.4, rows: Math.floor((h - 0.4) / 0.24), rowHeight: 0.24, cols: 4 }, r, 0.55, r() < 0.5 ? warmth(r) : PALETTE.windowCool);
  for (const f of ['x+', 'z+'] as const) {
    const [qx, qz] = f === 'x+' ? [x + w / 2 + 0.005, z] : [x, z + w / 2 + 0.005];
    b.quad(1.2, 0.18, qx, 0.2, qz, f, neon);
  }
  b.box(0.06, h * 0.6, 0.3, x + w / 2 + 0.03, h * 0.3, z + 0.35, neon, true);
  b.box(0.3, h * 0.6, 0.06, x - 0.35, h * 0.35, z + w / 2 + 0.03, bright(0xffd23f, 2.2), true);
}

export function campus(b: GeoBuilder, r: () => number, x: number, z: number, neon: ColorLike) {
  const h = 0.6 + r() * 0.5;
  b.box(1.6, 0.03, 1.6, x, 0.03, z, PALETTE.lawn);
  b.box(1.3, h, 1.0, x, 0.06, z - 0.15, PALETTE.glass);
  b.box(1.36, 0.05, 1.06, x, 0.06 + h, z - 0.15, PALETTE.trim);
  b.windows({ w: 1.3, d: 1.0, x, z: z - 0.15, y0: 0.06, rows: Math.round(h / 0.22), rowHeight: 0.22, cols: 6 }, r, 0.75, PALETTE.windowCool, { w: 0.17, h: 0.12 });
  for (let i = 0; i < 3; i++) b.box(0.3, 0.02, 0.18, x - 0.4 + i * 0.4, 0.11 + h, z - 0.15, 0x2a3f66);
  b.quad(0.7, 0.08, x, 0.06 + h - 0.08, z + 0.354, 'z+', neon);
  palm(b, r, x + 0.55, z + 0.6, 0.7, 0.06);
  palm(b, r, x - 0.55, z + 0.6, 0.7, 0.06);
}

/** Blue glass tower with white floor bands. */
export function tower(b: GeoBuilder, r: () => number, x: number, z: number, tier: number, neon: ColorLike) {
  const h = (tier - 1) * (0.9 + r() * 0.5) + 0.8;
  const w = 1.1 + r() * 0.35;
  const glassy = r() < 0.7;
  const wall = glassy ? pick(r, [0x7db3dd, 0x5e98c8, 0x9cc9ea] as const) : pick(r, [0xdcd3c3, 0xece6da, 0xb9c6d2] as const);
  const band = glassy ? PALETTE.trim : 0x9a8f80;
  const light = r() < 0.6 ? warmth(r) : PALETTE.windowCool;
  const podium = 0.35;
  b.box(w + 0.3, podium, w + 0.3, x, 0.03, z, PALETTE.concrete);
  const lower = h * (0.6 + r() * 0.15);
  const w2 = w * 0.74;
  const y2 = 0.03 + podium + lower;
  const upper = h - lower;
  for (const [bw, by, bh] of [[w, 0.03 + podium, lower], [w2, y2, upper]] as const) {
    b.box(bw, bh, bw, x, by, z, wall);
    const rows = Math.floor(bh / 0.2);
    b.windows({ w: bw, d: bw, x, z, y0: by, rows, rowHeight: 0.2, cols: glassy ? 3 : 4 }, r, 0.55, light, { w: glassy ? 0.2 : 0.14, h: 0.1 });
    for (let f = 0; f <= rows; f += glassy ? 2 : 1) b.box(bw + 0.015, 0.022, bw + 0.015, x, by + f * 0.2, z, band);
    for (const [cx, cz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) b.box(0.035, bh, 0.035, x + (cx * bw) / 2, by, z + (cz * bw) / 2, band);
  }
  b.box(w2 + 0.02, 0.05, w2 + 0.02, x, y2 + upper - 0.12, z, neon, true);
  if (tier >= 5) {
    b.cylinder(w2 * 0.4, w2 * 0.4, 0.04, x, y2 + upper, z, 0x55606e, 16);
    b.box(0.16, 0.005, 0.03, x, y2 + upper + 0.04, z, PALETTE.trim); // helipad "H"
  } else {
    b.box(w2 * 0.6, 0.15, w2 * 0.6, x, y2 + upper, z, PALETTE.concrete);
  }
  b.cylinder(0.012, 0.02, 0.5, x + w2 * 0.3, y2 + upper, z - w2 * 0.3, PALETTE.steel, 4);
  b.blob(0.035, x + w2 * 0.3, y2 + upper + 0.52, z - w2 * 0.3, bright(0xff2a2a, 3), true);
}

/** A Transamerica-style pyramid for the Financial District. */
export function pyramid(b: GeoBuilder, r: () => number, x: number, z: number) {
  const h = 6.2;
  b.box(1.7, 0.3, 1.7, x, 0.03, z, PALETTE.concrete);
  b.cylinder(0.08, 0.95, h, x, 0.33, z, 0xf2efe8, 4, false, Math.PI / 4);
  for (let f = 1; f < 26; f++) {
    const y = 0.33 + f * (h / 28);
    const half = 0.95 - (0.87 * (y - 0.33)) / h;
    for (const face of ['x+', 'z+', 'x-', 'z-'] as const) {
      const [dx, dz] = face === 'x+' ? [half * Math.SQRT1_2, 0] : face === 'x-' ? [-half * Math.SQRT1_2, 0] : face === 'z+' ? [0, half * Math.SQRT1_2] : [0, -half * Math.SQRT1_2];
      b.quad(half * 0.9, 0.06, x + dx + Math.sign(dx) * 0.012, y, z + dz + Math.sign(dz) * 0.012, face, r() < 0.6 ? warmth(r) : PALETTE.darkGlass, true);
    }
  }
  // Side "wings" with the elevator shafts
  b.box(0.22, h * 0.55, 0.12, x, 0.33 + h * 0.35, z + 0.42, 0xf2efe8);
  b.box(0.12, h * 0.55, 0.22, x + 0.42, 0.33 + h * 0.35, z, 0xf2efe8);
  b.cylinder(0.01, 0.06, 1.0, x, 0.33 + h - 0.1, z, 0xf2efe8, 4, false, Math.PI / 4);
}

export function spire(b: GeoBuilder, r: () => number, x: number, z: number, neon: ColorLike) {
  b.box(3.2, 0.4, 3.2, x, 0.03, z, PALETTE.concrete);
  let w = 2.0;
  let y = 0.43;
  for (let s = 0; s < 6; s++) {
    const h = 1.6 - s * 0.12;
    b.box(w, h, w, x, y, z, 0x7db3dd);
    b.windows({ w, d: w, x, z, y0: y, rows: Math.floor(h / 0.2), rowHeight: 0.2, cols: Math.max(3, Math.round(w * 3)) }, r, 0.7, PALETTE.windowCool, { w: 0.12, h: 0.1 });
    b.box(w + 0.04, 0.05, w + 0.04, x, y + h - 0.05, z, neon, true);
    b.box(w + 0.03, 0.03, w + 0.03, x, y, z, PALETTE.trim);
    y += h;
    w *= 0.8;
  }
  b.cylinder(0.02, 0.1, 2.4, x, y, z, PALETTE.steel, 6);
  b.blob(0.12, x, y + 2.5, z, neon, true, 1);
}

/** Copies the meshes of a built group into another builder, keeping world transforms. */
function bake(into: GeoBuilder, group: THREE.Group) {
  group.updateMatrixWorld(true);
  group.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const g = (o.geometry as THREE.BufferGeometry).clone().applyMatrix4(o.matrixWorld);
    const glow = o.material instanceof THREE.MeshBasicMaterial;
    into.raw(g, glow);
    (o.geometry as THREE.BufferGeometry).dispose();
    if (glow) (o.material as THREE.Material).dispose();
  });
}

// ─── HQ: your company, centre of town ─────────────────────────────────────

export interface HQ extends Built {
  beacon: THREE.MeshBasicMaterial;
  sign: THREE.MeshBasicMaterial;
  height: number;
}

/**
 * Your company. `level` is the HQ upgrade bought (0 garage … 4 landmark);
 * `floors` comes from releases, capped by what the level has room for.
 */
export function headquarters(name: string, floors: number, seed: number, level = 1): HQ {
  const r = rng(seed);
  const b = new GeoBuilder();
  b.box(BLOCK, 0.04, BLOCK, 0, 0, 0, PALETTE.plaza);
  // Fountain, palms, lawn strips (the west corner is the founder's lot)
  b.cylinder(0.34, 0.38, 0.08, 1.35, 0.04, 1.35, PALETTE.concrete, 14);
  b.cylinder(0.29, 0.29, 0.02, 1.35, 0.1, 1.35, PALETTE.pool, 14);
  b.cylinder(0.03, 0.05, 0.22, 1.35, 0.1, 1.35, PALETTE.trim, 6);
  for (const [tx, tz] of [[1.5, -1.5], [-1.5, -1.5], [-0.4, 1.6], [1.6, 0.4]] as const) palm(b, r, tx, tz, 1.0, 0.04);
  b.box(3.6, 0.02, 0.3, 0, 0.04, -1.7, PALETTE.lawn);

  let top: number;
  if (level === 0) {
    // The garage: where it starts
    b.box(1.2, 0.5, 0.9, 0, 0.04, 0, 0xf3c6a2);
    b.gable(1.2, 0.26, 0.9, 0, 0.54, 0, PALETTE.roofs[0]);
    b.quad(0.6, 0.34, 0, 0.21, 0.454, 'z+', 0xe8e2d6, false);
    for (let k = 0; k < 4; k++) b.box(0.6, 0.008, 0.005, 0, 0.08 + k * 0.08, 0.456, 0xc9c2b4);
    b.quad(0.16, 0.12, 0.6 + 0.004, 0.32, 0, 'x+', warmth(r));
    top = 0.8;
  } else {
    const floorH = 0.24;
    const w = [0, 1.3, 1.5, 1.7, 1.85][level]!;
    const lobby = 0.36;
    if (level === 2) {
      // Campus wings
      for (const s of [-1, 1]) {
        b.box(0.7, 0.5, 2.6, s * 1.25, 0.04, 0.2, 0xf8f5ee);
        b.box(0.74, 0.04, 2.64, s * 1.25, 0.54, 0.2, PALETTE.lawn);
        b.windows({ w: 0.7, d: 2.6, x: s * 1.25, z: 0.2, y0: 0.04, rows: 2, rowHeight: 0.25, cols: 6, faces: [s > 0 ? 'x+' : 'x-', 'z+'] }, r, 0.6, warmth(r));
      }
    }
    b.box(w + 0.3, lobby, w + 0.3, 0, 0.04, 0, PALETTE.trim);
    b.quad(w * 0.7, 0.24, 0, 0.04 + 0.14, (w + 0.3) / 2 + 0.005, 'z+', warmth(r));
    b.quad(w * 0.7, 0.24, (w + 0.3) / 2 + 0.005, 0.04 + 0.14, 0, 'x+', warmth(r));
    const y0 = 0.04 + lobby;
    const h = floors * floorH;
    b.box(w, h, w, 0, y0, 0, level >= 3 ? 0x4f8cc4 : 0x5e98c8);
    b.windows({ w, d: w, x: 0, z: 0, y0, rows: floors, rowHeight: floorH, cols: level >= 3 ? 6 : 5 }, r, 0.55, [1.1, 0.8, 0.45], { w: 0.22, h: 0.15 });
    for (let f = 0; f <= floors; f++) b.box(w + 0.02, 0.025, w + 0.02, 0, y0 + f * floorH, 0, PALETTE.trim);
    for (const [fx, fz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      b.box(0.08, h + 0.2, 0.08, (fx * w) / 2, y0, (fz * w) / 2, PALETTE.trim);
    }
    top = y0 + h;
    b.box(w + 0.1, 0.08, w + 0.1, 0, top, 0, PALETTE.trim);
    if (level >= 2) {
      // Roof garden
      b.box(w - 0.1, 0.05, w - 0.1, 0, top + 0.08, 0, PALETTE.lawn);
      palm(b, r, -0.5, 0.5, 0.5, top + 0.13);
      palm(b, r, 0.55, -0.45, 0.45, top + 0.13);
    }
    if (level === 4) {
      // Landmark crown: stepped glass and a spire
      let cw = w * 0.8;
      let cy = top + 0.08;
      for (let k = 0; k < 3; k++) {
        b.box(cw, 0.5, cw, 0, cy, 0, 0x7db3dd);
        b.box(cw + 0.03, 0.04, cw + 0.03, 0, cy + 0.46, 0, [2.2, 1.9, 1.2], true);
        cy += 0.5;
        cw *= 0.72;
      }
      b.cylinder(0.02, 0.07, 2.2, 0, cy, 0, PALETTE.trim, 6);
      top = cy;
    }
  }
  b.cylinder(0.02, 0.04, 0.9, -0.55, top + 0.08, -0.55, PALETTE.steel, 6);
  const built = b.build();

  // Beacon gets its own material so it can pulse on every push.
  const beacon = new THREE.MeshBasicMaterial({ color: new THREE.Color(...bright(0x6ff2ff, 2)) });
  const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.09, 1), beacon);
  orb.position.set(-0.55, top + 1.06, -0.55);
  built.group.add(orb);

  // Rooftop sign with the company name, angled toward the default camera.
  const { mesh, material } = rooftopSign(name);
  mesh.position.set(0.25, top + 0.42, 0.25);
  mesh.rotation.y = Math.PI / 4;
  built.group.add(mesh);

  return { ...built, beacon, sign: material, height: top + 1.2 };
}

function rooftopSign(text: string): { mesh: THREE.Group; material: THREE.MeshBasicMaterial } {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = '700 88px "Space Grotesk", "Avenir Next", system-ui, sans-serif';
  ctx.font = font;
  const label = text.trim().slice(0, 22) || 'HQ';
  canvas.width = Math.ceil(ctx.measureText(label).width + 80);
  canvas.height = 150;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = '#ff4fd8';
  ctx.shadowBlur = 18;
  ctx.fillStyle = '#ffe8fb';
  ctx.fillText(label, canvas.width / 2, canvas.height / 2);
  ctx.shadowBlur = 0;
  ctx.fillText(label, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const height = 0.4;
  const width = (height * canvas.width) / canvas.height;
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  material.addEventListener('dispose', () => texture.dispose());
  const g = new THREE.Group();
  const face = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
  face.position.z = 0.03;
  // A dark backing board so the letters read in daylight too.
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(width * 0.92, height * 0.9, 0.04),
    new THREE.MeshStandardMaterial({ color: 0x23304a, roughness: 0.6 }),
  );
  board.castShadow = true;
  for (const lx of [-width * 0.3, width * 0.3]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.3, 0.03), new THREE.MeshStandardMaterial({ color: PALETTE.steel }));
    leg.position.set(lx, -0.3, 0);
    g.add(leg);
  }
  g.add(board, face);
  return { mesh: g, material };
}
