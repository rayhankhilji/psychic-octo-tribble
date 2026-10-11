import * as THREE from 'three';
import { GeoBuilder, type ColorLike } from './geo.ts';
import { PALETTE } from './palette.ts';
import { bright, palm, tree, warmth, type Built } from './buildings.ts';
import { campus, deco, pyramid, spire, tower } from './towers.ts';
import { pick, rng } from '../world/rng.ts';

/**
 * Models for things founders buy, their homes, and the state of the city
 * (tents, clouds). Plot models are centred on (x, z) and fill a 2×2 plot;
 * block models fill a 4×4 block.
 */

const NEON = [0xff3fa4, 0x3ff2ff, 0x9d7bff, 0x5dffa0, 0xffb347] as const;

function pad(b: GeoBuilder, x: number, z: number, size: number, color = PALETTE.plaza) {
  b.box(size, 0.035, size, x, 0, z, color);
}

export function itemModel(model: string, x: number, z: number, seed: number): Built {
  const r = rng(seed);
  const b = new GeoBuilder();
  const neon = bright(pick(r, NEON), 2.4);
  switch (model) {
    case 'shops':
      pad(b, x, z, 1.9);
      for (const [dx, dz] of [[-0.45, -0.45], [0.45, -0.45], [-0.45, 0.45]] as const) shopfront(b, r, x + dx, z + dz, neon);
      palm(b, r, x + 0.5, z + 0.5, 0.7, 0.035);
      break;
    case 'coworking': {
      pad(b, x, z, 1.9);
      b.box(1.5, 0.6, 1.2, x, 0.035, z - 0.1, 0xb8604a); // brick
      b.box(1.56, 0.05, 1.26, x, 0.635, z - 0.1, PALETTE.trim);
      b.windows({ w: 1.5, d: 1.2, x, z: z - 0.1, y0: 0.035, rows: 2, rowHeight: 0.3, cols: 4, faces: ['z+', 'x+'] }, r, 0.8, warmth(r), { w: 0.26, h: 0.2 });
      b.box(0.6, 0.03, 0.5, x - 0.3, 0.68, z - 0.2, PALETTE.wood);
      for (let i = 0; i < 3; i++) b.cylinder(0, 0.1, 0.05, x - 0.5 + i * 0.2, 0.86, z - 0.2, pick(r, [0xe85a4a, 0xf2c84b] as const), 8);
      palm(b, r, x + 0.65, z + 0.7, 0.6, 0.035);
      break;
    }
    case 'tower3':
      pad(b, x, z, 1.9);
      tower(b, r, x, z, 3, neon);
      break;
    case 'tower5':
      pad(b, x, z, 1.9);
      tower(b, r, x, z, 5, neon);
      break;
    case 'campus':
      campus(b, r, x, z, neon);
      break;
    case 'pyramid':
      pyramid(b, r, x, z);
      break;
    case 'venture': {
      pad(b, x, z, 1.9);
      b.box(1.2, 0.9, 0.9, x - 0.15, 0.035, z - 0.2, 0x9cc9ea);
      b.box(0.9, 0.8, 1.0, x + 0.2, 0.935, z + 0.05, 0x7db3dd);
      b.box(0.94, 0.05, 1.04, x + 0.2, 1.735, z + 0.05, PALETTE.lawn);
      b.windows({ w: 1.2, d: 0.9, x: x - 0.15, z: z - 0.2, y0: 0.035, rows: 3, rowHeight: 0.3, cols: 4 }, r, 0.7, PALETTE.windowCool, { w: 0.24, h: 0.2 });
      b.windows({ w: 0.9, d: 1.0, x: x + 0.2, z: z + 0.05, y0: 0.935, rows: 3, rowHeight: 0.26, cols: 3 }, r, 0.7, warmth(r), { w: 0.22, h: 0.18 });
      b.box(0.6, 0.12, 0.03, x + 0.2, 1.4, z + 0.57, neon, true);
      break;
    }
    case 'spire':
      spire(b, r, x, z, neon);
      break;
    case 'park':
      pad(b, x, z, 1.9, PALETTE.lawn);
      b.box(1.9, 0.01, 0.2, x, 0.036, z, PALETTE.sand);
      b.box(0.2, 0.01, 1.9, x, 0.036, z, PALETTE.sand);
      b.cylinder(0.3, 0.34, 0.07, x, 0.035, z, PALETTE.concrete, 12);
      b.cylinder(0.25, 0.25, 0.02, x, 0.1, z, PALETTE.pool, 12);
      for (const [dx, dz] of [[-0.55, -0.55], [0.55, -0.55], [-0.55, 0.55], [0.55, 0.55]] as const) tree(b, r, x + dx, z + dz, 0.85, 0.035);
      break;
    case 'garden':
      pad(b, x, z, 1.9, 0x8a6a4a);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
        b.box(0.42, 0.08, 0.3, x - 0.5 + i * 0.5, 0.035, z + 0.2 + j * 0.45, PALETTE.wood);
        b.box(0.38, 0.06, 0.26, x - 0.5 + i * 0.5, 0.11, z + 0.2 + j * 0.45, pick(r, [0x5aa83a, 0x7cbd4c, 0xe85a4a, 0xf2c84b] as const));
      }
      b.box(0.9, 0.4, 0.5, x, 0.035, z - 0.55, 0xd9eef2);
      b.gable(0.9, 0.18, 0.5, x, 0.435, z - 0.55, 0xd9eef2, 0.02);
      break;
    case 'courts':
      pad(b, x, z, 1.9, 0x3aa38e);
      b.box(1.6, 0.012, 0.9, x, 0.036, z - 0.4, 0xd8743a);
      b.box(0.012, 0.014, 0.9, x, 0.05, z - 0.4, PALETTE.trim);
      b.box(1.6, 0.012, 0.7, x, 0.036, z + 0.5, 0x4f7ac8);
      for (const hx of [-0.78, 0.78]) b.box(0.03, 0.3, 0.03, x + hx, 0.035, z - 0.4, PALETTE.steel);
      for (const fx of [-0.95, 0.95]) b.box(0.02, 0.2, 1.9, x + fx, 0.035, z, 0x6f7a86);
      break;
    case 'library': {
      pad(b, x, z, 1.9, PALETTE.lawn);
      b.box(1.5, 0.12, 1.0, x, 0.035, z - 0.2, PALETTE.concrete);
      b.box(1.3, 0.55, 0.8, x, 0.155, z - 0.25, 0xf2ece0);
      for (let i = 0; i < 6; i++) b.cylinder(0.04, 0.04, 0.5, x - 0.55 + i * 0.22, 0.155, z + 0.2, PALETTE.trim, 8);
      b.box(1.36, 0.06, 0.3, x, 0.655, z + 0.12, PALETTE.trim);
      b.gable(1.36, 0.22, 0.3, x, 0.715, z + 0.12, PALETTE.trim, 0.02);
      b.cylinder(0.2, 0.32, 0.3, x, 0.705, z - 0.3, 0x9cb8a8, 12);
      b.windows({ w: 1.3, d: 0.8, x, z: z - 0.25, y0: 0.155, rows: 1, rowHeight: 0.5, cols: 5, faces: ['x+', 'x-'] }, r, 0.8, warmth(r), { w: 0.12, h: 0.28 });
      break;
    }
    case 'stadium':
      stadium(b, r, x, z);
      break;
    case 'university':
      university(b, r, x, z);
      break;
    case 'research': {
      pad(b, x, z, 1.9);
      b.box(1.6, 0.4, 0.6, x, 0.035, z - 0.55, 0xf8f5ee);
      b.windows({ w: 1.6, d: 0.6, x, z: z - 0.55, y0: 0.035, rows: 1, rowHeight: 0.4, cols: 6, faces: ['z+'] }, r, 0.8, PALETTE.windowCool, { w: 0.18, h: 0.2 });
      for (const [dx, rr] of [[-0.45, 0.42], [0.45, 0.32]] as const) {
        b.cylinder(rr, rr, 0.25, x + dx, 0.035, z + 0.35, 0xf8f5ee, 16);
        const dome = new THREE.SphereGeometry(rr, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
        b.transformed(dome, new THREE.Matrix4().makeTranslation(x + dx, 0.285, z + 0.35), 0xe6edf2);
      }
      b.box(0.05, 0.4, 0.4, x + 0.45, 0.42, z + 0.35, 0x2f3c50);
      break;
    }
    case 'foodtrucks':
      pad(b, x, z, 1.9);
      for (const [dx, c] of [[-0.55, 0xe85a4a], [0, 0x3aa3c8], [0.55, 0xf2c84b]] as const) {
        b.box(0.42, 0.22, 0.2, x + dx, 0.035, z - 0.6, c);
        b.box(0.3, 0.08, 0.005, x + dx, 0.15, z - 0.495, warmth(r), true);
        for (const wx of [-0.13, 0.13]) b.cylinder(0.04, 0.04, 0.02, x + dx + wx, 0.035, z - 0.5, 0x222222, 8);
      }
      for (let i = 0; i < 4; i++) b.box(0.32, 0.08, 0.14, x - 0.5 + (i % 2) * 0.9, 0.035, z + 0.1 + Math.floor(i / 2) * 0.45, PALETTE.wood);
      for (let i = 0; i <= 8; i++) b.blob(0.022, x - 0.8 + i * 0.2, 0.6 - Math.sin((i / 8) * Math.PI) * 0.08, z - 0.1, PALETTE.lamp, true);
      palm(b, r, x + 0.75, z + 0.75, 0.7, 0.035);
      break;
    case 'cafe': {
      pad(b, x, z, 1.9);
      b.box(1.1, 0.42, 0.8, x - 0.2, 0.035, z - 0.4, 0xf6e7c8);
      b.box(1.14, 0.04, 0.84, x - 0.2, 0.455, z - 0.4, PALETTE.trim);
      b.quad(0.8, 0.22, x - 0.2, 0.18, z + 0.004, 'z+', warmth(r));
      for (let s = 0; s < 5; s++) b.box(0.22, 0.02, 0.2, x - 0.64 + s * 0.22, 0.32, z + 0.08, s % 2 ? PALETTE.trim : 0x2f8a6a);
      for (const [tx, tz] of [[-0.5, 0.5], [0.1, 0.55], [0.6, 0.2]] as const) {
        b.cylinder(0.008, 0.008, 0.28, x + tx, 0.035, z + tz, PALETTE.steel, 4);
        b.cylinder(0, 0.16, 0.06, x + tx, 0.3, z + tz, pick(r, [0xe85a4a, 0xf8f5ee, 0x2f8a6a] as const), 8);
        b.cylinder(0.08, 0.08, 0.1, x + tx, 0.035, z + tz, PALETTE.trim, 8);
      }
      break;
    }
    case 'deco':
      pad(b, x, z, 1.9);
      deco(b, r, x, z, neon);
      break;
    case 'amusement':
      amusement(b, r, x, z);
      break;
    case 'arena': {
      pad(b, x, z, 1.9);
      b.cylinder(0.85, 0.9, 0.7, x, 0.035, z, 0xe8e2d6, 20);
      b.cylinder(0.86, 0.86, 0.08, x, 0.5, z, neon, 20, true);
      const roof = new THREE.SphereGeometry(0.86, 20, 6, 0, Math.PI * 2, 0, Math.PI / 5);
      b.transformed(roof, new THREE.Matrix4().makeTranslation(x, 0.735 - 0.86 * Math.cos(Math.PI / 5), z), 0xcfd6de);
      break;
    }
    default:
      pad(b, x, z, 1.9);
  }
  return b.build();
}

function shopfront(b: GeoBuilder, r: () => number, x: number, z: number, neon: ColorLike) {
  const h = 0.38 + r() * 0.2;
  b.box(0.8, h, 0.8, x, 0.035, z, pick(r, PALETTE.walls));
  b.box(0.84, 0.04, 0.84, x, 0.035 + h, z, PALETTE.trim);
  b.quad(0.56, 0.18, x, 0.14, z + 0.404, 'z+', warmth(r));
  b.quad(0.56, 0.18, x + 0.404, 0.14, z, 'x+', warmth(r));
  const awning = pick(r, [0xe85a4a, 0x2f8fb8, 0x3aa36a, 0xf2a03a] as const);
  for (let s = 0; s < 4; s++) b.box(0.18, 0.02, 0.14, x - 0.27 + s * 0.18, 0.28, z + 0.46, s % 2 ? PALETTE.trim : awning);
  b.box(0.44, 0.07, 0.02, x, 0.035 + h + 0.06, z + 0.3, neon, true);
}

function stadium(b: GeoBuilder, r: () => number, x: number, z: number) {
  b.box(3.9, 0.035, 3.9, x, 0, z, PALETTE.plaza);
  b.cylinder(1.45, 1.45, 0.02, x, 0.035, z, 0x5aa83a, 24);
  b.box(1.6, 0.012, 1.0, x, 0.05, z, 0x6fbf45);
  b.box(0.012, 0.014, 1.0, x, 0.06, z, PALETTE.trim);
  // Stands: a ring of sloped segments
  const n = 24;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const g = new THREE.BoxGeometry(0.42, 0.55, 0.5);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x + Math.cos(a) * 1.7, 0.3, z + Math.sin(a) * 1.7),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -a + Math.PI / 2, 0)),
      new THREE.Vector3(1, 1, 1),
    );
    b.transformed(g, m, k % 2 ? 0xe8e2d6 : 0xd84a4a);
  }
  for (const [dx, dz] of [[-1.7, -1.7], [1.7, -1.7], [-1.7, 1.7], [1.7, 1.7]] as const) {
    b.box(0.06, 1.6, 0.06, x + dx, 0.035, z + dz, PALETTE.steel);
    b.box(0.3, 0.12, 0.05, x + dx, 1.62, z + dz, [3, 3, 2.6], true);
  }
  void r;
}

function university(b: GeoBuilder, r: () => number, x: number, z: number) {
  b.box(3.9, 0.035, 3.9, x, 0, z, PALETTE.lawn);
  b.box(3.9, 0.01, 0.25, x, 0.036, z, PALETTE.sand);
  b.box(0.25, 0.01, 3.9, x, 0.036, z, PALETTE.sand);
  const brick = 0xc9785a;
  for (const [dx, dz, w, d] of [[0, -1.5, 3.2, 0.7], [-1.5, 0.3, 0.7, 2.4], [1.5, 0.3, 0.7, 2.4]] as const) {
    b.box(w, 0.7, d, x + dx, 0.035, z + dz, brick);
    b.gable(w, 0.24, d, x + dx, 0.735, z + dz, 0x6a5040, 0.03, w < d ? Math.PI / 2 : 0);
    b.windows({ w, d, x: x + dx, z: z + dz, y0: 0.035, rows: 2, rowHeight: 0.33, cols: Math.round(Math.max(w, d) * 3) }, r, 0.7, warmth(r), { w: 0.1, h: 0.16 });
  }
  // Clock tower in the quad
  b.box(0.45, 1.8, 0.45, x, 0.035, z - 0.6, 0xe0d4bc);
  b.cylinder(0.12, 0.12, 0.02, x, 1.45, z - 0.37, PALETTE.trim, 16);
  b.cylinder(0, 0.36, 0.5, x, 1.835, z - 0.6, 0x5a6a5a, 4, false, Math.PI / 4);
  for (const [dx, dz] of [[-0.8, 0.9], [0.8, 0.9], [-0.8, 1.6], [0.8, 1.6]] as const) tree(b, r, x + dx, z + dz, 1, 0.035, 'round');
}

function amusement(b: GeoBuilder, r: () => number, x: number, z: number) {
  b.box(3.9, 0.035, 3.9, x, 0, z, PALETTE.plaza);
  // Coaster: a looping track on stilts
  const pts: THREE.Vector3[] = [];
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    pts.push(new THREE.Vector3(x + Math.cos(a) * 1.5, 0.6 + 0.5 * Math.sin(a * 2) + (k === 6 ? 0.6 : 0), z + Math.sin(a) * 1.2));
  }
  const curve = new THREE.CatmullRomCurve3(pts, true);
  b.transformed(new THREE.TubeGeometry(curve, 120, 0.04, 5, true), new THREE.Matrix4(), 0xe85a4a);
  for (let k = 0; k < 24; k += 2) {
    const p = curve.getPointAt(k / 24);
    b.box(0.03, p.y, 0.03, p.x, 0.035, p.z, PALETTE.trim);
  }
  // Carousel and drop tower
  b.cylinder(0.4, 0.4, 0.25, x - 0.4, 0.035, z + 0.2, 0xf8f5ee, 12);
  b.cylinder(0.02, 0.45, 0.25, x - 0.4, 0.285, z + 0.2, 0x3aa3c8, 12);
  b.box(0.18, 2.4, 0.18, x + 0.6, 0.035, z - 0.1, 0xf2c84b);
  b.box(0.34, 0.1, 0.34, x + 0.6, 1.6, z - 0.1, 0xe85a4a);
  for (let k = 0; k < 10; k++) b.blob(0.03, x + 0.6, 0.2 + k * 0.24, z - 0.01, [2.6, 2, 0.8], true);
  palm(b, r, x - 1.6, z + 1.6, 0.9, 0.035);
  palm(b, r, x + 1.6, z + 1.6, 0.9, 0.035);
}

// ─── The founder's homes ──────────────────────────────────────────────────

/** Founder homes, in lot-local space facing +z. */
export function founderHome(option: string, seed: number, museum = false): Built {
  const r = rng(seed);
  const b = new GeoBuilder();
  switch (option) {
    case 'hacker-house': {
      b.box(0.96, 0.03, 0.96, 0, 0, 0, 0x9a8a6a); // patchy lawn
      b.box(0.56, 0.7, 0.5, 0, 0.03, -0.05, 0xd6c49a);
      b.gable(0.56, 0.2, 0.5, 0, 0.73, -0.05, 0x7a6a5a);
      b.windows({ w: 0.56, d: 0.5, x: 0, z: -0.05, y0: 0.03, rows: 2, rowHeight: 0.33, cols: 2, faces: ['z+', 'x+'] }, r, 1, [1.6, 1.3, 0.8], { w: 0.12, h: 0.12 });
      b.box(0.3, 0.05, 0.2, 0.3, 0.03, 0.32, 0x4a4a52); // old couch
      b.box(0.04, 0.12, 0.04, -0.35, 0.03, 0.35, PALETTE.steel); // whiteboard leg
      b.box(0.22, 0.14, 0.02, -0.35, 0.15, 0.35, PALETTE.trim);
      if (museum) b.box(0.12, 0.1, 0.03, 0.12, 0.03, 0.44, 0xd4af37); // plaque
      break;
    }
    case 'studio':
      b.box(0.96, 0.03, 0.96, 0, 0, 0, PALETTE.sidewalk);
      b.box(0.7, 0.9, 0.6, 0, 0.03, -0.1, 0xf6e7c8);
      b.box(0.74, 0.05, 0.64, 0, 0.93, -0.1, PALETTE.trim);
      b.windows({ w: 0.7, d: 0.6, x: 0, z: -0.1, y0: 0.03, rows: 3, rowHeight: 0.3, cols: 3, faces: ['z+', 'x+'] }, r, 0.5, warmth(r), { w: 0.1, h: 0.12 });
      b.box(0.14, 0.02, 0.06, 0.2, 0.63, 0.23, PALETTE.trim); // your little balcony
      palm(b, r, -0.38, 0.36, 0.5, 0.03);
      break;
    case 'bungalow':
      b.box(0.96, 0.03, 0.96, 0, 0, 0, PALETTE.lawn);
      b.box(0.6, 0.3, 0.5, 0, 0.03, -0.05, 0xf3c6a2);
      b.hip(0.6, 0.18, 0.5, 0, 0.33, -0.05, PALETTE.roofs[0]);
      b.quad(0.1, 0.16, 0, 0.11, 0.204, 'z+', PALETTE.door, false);
      b.windows({ w: 0.6, d: 0.5, x: 0, z: -0.05, y0: 0.03, rows: 1, rowHeight: 0.3, cols: 2, faces: ['z+', 'x+'] }, r, 0.9, warmth(r), { w: 0.1, h: 0.1 });
      tree(b, r, 0.36, 0.36, 0.55, 0.03, 'round');
      b.blob(0.02, 0.3, 0.2, 0.3, 0xf2c84b);
      break;
    case 'loft':
      b.box(0.96, 0.03, 0.96, 0, 0, 0, PALETTE.sidewalk);
      b.box(0.8, 1.0, 0.7, 0, 0.03, -0.08, 0xa8553e);
      b.box(0.84, 0.06, 0.74, 0, 1.03, -0.08, 0x6a3a2c);
      b.windows({ w: 0.8, d: 0.7, x: 0, z: -0.08, y0: 0.03, rows: 3, rowHeight: 0.33, cols: 3, faces: ['z+', 'x+'] }, r, 0.8, warmth(r), { w: 0.18, h: 0.2 });
      b.box(0.2, 0.15, 0.2, 0.2, 1.09, -0.2, 0x7a5a42); // water tower
      break;
    case 'hills-modern':
      b.box(1.6, 0.04, 1.2, 0, 0, 0, 0xe8e2d6);
      b.box(0.9, 0.3, 0.6, -0.2, 0.04, -0.2, PALETTE.trim);
      b.box(1.1, 0.04, 0.8, -0.1, 0.34, -0.15, 0xe8e2d6);
      b.quad(0.7, 0.2, -0.2, 0.17, 0.104, 'z+', warmth(r));
      b.box(0.6, 0.016, 0.35, 0.35, 0.04, 0.35, PALETTE.pool);
      palm(b, r, 0.7, -0.4, 0.8, 0.04);
      break;
    case 'villa':
      b.box(2, 0.04, 1.6, 0, 0, 0, 0xe8dcc4);
      for (const [dx, dz, w, d] of [[0, -0.45, 1.6, 0.5], [-0.6, 0.15, 0.45, 0.7], [0.6, 0.15, 0.45, 0.7]] as const) {
        b.box(w, 0.42, d, dx, 0.04, dz, 0xf6ecd8);
        b.hip(w, 0.18, d, dx, 0.46, dz, PALETTE.roofs[0]);
      }
      b.windows({ w: 1.6, d: 0.5, x: 0, z: -0.45, y0: 0.04, rows: 1, rowHeight: 0.42, cols: 6, faces: ['z+'] }, r, 0.9, warmth(r), { w: 0.12, h: 0.2 });
      b.cylinder(0.16, 0.18, 0.06, 0, 0.04, 0.2, PALETTE.concrete, 12);
      b.cylinder(0.13, 0.13, 0.02, 0, 0.1, 0.2, PALETTE.pool, 12);
      b.box(0.9, 0.016, 0.3, 0, 0.04, 0.6, PALETTE.pool);
      for (const px of [-0.9, 0.9]) palm(b, r, px, 0.65, 1.0, 0.04);
      break;
    case 'cliffside':
      b.box(1.8, 0.04, 1.4, 0, 0, 0, 0x9a9a92);
      b.box(1.2, 0.36, 0.7, -0.1, 0.04, -0.25, 0x9cc9ea);
      b.box(1.0, 0.32, 0.8, 0.2, 0.4, 0.05, 0xb9dcf2);
      b.box(1.06, 0.03, 0.86, 0.2, 0.72, 0.05, PALETTE.trim);
      b.windows({ w: 1.0, d: 0.8, x: 0.2, z: 0.05, y0: 0.4, rows: 1, rowHeight: 0.32, cols: 4 }, r, 0.9, warmth(r), { w: 0.22, h: 0.24 });
      b.box(0.7, 0.016, 0.25, -0.4, 0.04, 0.5, PALETTE.pool);
      break;
    case 'compound':
      b.box(2.2, 0.04, 1.8, 0, 0, 0, 0xe8e2d6);
      for (const [dx, dz] of [[-0.65, -0.45], [0.55, -0.5], [0, 0.35]] as const) {
        b.box(0.7, 0.32, 0.55, dx, 0.04, dz, PALETTE.trim);
        b.box(0.8, 0.03, 0.65, dx, 0.36, dz, 0xd9d2c4);
        b.quad(0.5, 0.2, dx, 0.17, dz + 0.279, 'z+', warmth(r));
      }
      b.box(1.6, 0.016, 0.3, 0, 0.04, 0.8, PALETTE.pool); // infinity pool
      for (const [px, pz] of [[-1, 0.8], [1, 0.8], [1, -0.8]] as const) palm(b, r, px, pz, 1, 0.04);
      break;
    case 'island-estate':
      b.box(2.6, 0.04, 2.2, 0, 0, 0, PALETTE.lawn);
      b.box(1.6, 0.5, 0.8, 0, 0.04, -0.5, 0xf8f5ee);
      b.box(1.0, 0.4, 0.7, 0.2, 0.54, -0.5, 0xf8f5ee);
      b.box(1.1, 0.04, 0.8, 0.2, 0.94, -0.5, PALETTE.trim);
      b.windows({ w: 1.6, d: 0.8, x: 0, z: -0.5, y0: 0.04, rows: 1, rowHeight: 0.5, cols: 6, faces: ['z+', 'x+'] }, r, 0.9, warmth(r), { w: 0.18, h: 0.28 });
      b.box(1.2, 0.016, 0.4, -0.2, 0.04, 0.4, PALETTE.pool);
      b.cylinder(0.4, 0.4, 0.02, 0.8, 0.04, 0.6, 0x55606e, 16); // helipad
      b.box(0.24, 0.005, 0.05, 0.8, 0.065, 0.6, PALETTE.trim);
      for (const [px, pz] of [[-1.1, 0.8], [-1.1, -0.9], [1.1, -0.9], [0.2, 0.9]] as const) palm(b, r, px, pz, 1.1, 0.04);
      break;
    default:
      b.box(0.96, 0.03, 0.96, 0, 0, 0, PALETTE.lawn);
  }
  const built = b.build();
  built.group.traverse((o) => (o.castShadow = true));
  return built;
}

// ─── City state: tents, clouds, plots ─────────────────────────────────────

/** Tents and sleeping bags at the given spots. */
export function encampment(spots: { x: number; z: number; rot: number }[], seed: number): Built {
  const r = rng(seed);
  const b = new GeoBuilder();
  for (const s of spots) {
    const tarp = pick(r, [0x3a6ad8, 0x2f8a6a, 0xe8873a, 0x8a8f99, 0xc84a4a] as const);
    if (r() < 0.7) {
      const g = new THREE.CylinderGeometry(0.11, 0.11, 0.26, 3, 1);
      g.rotateZ(Math.PI / 2);
      g.rotateX(Math.PI);
      g.translate(0, 0.07, 0);
      b.transformed(g, new THREE.Matrix4().makeRotationY(s.rot).setPosition(s.x, 0, s.z), tarp);
    } else {
      b.box(0.24, 0.04, 0.09, s.x, 0.01, s.z, tarp, false, s.rot);
      b.blob(0.035, s.x + Math.cos(s.rot) * 0.1, 0.06, s.z - Math.sin(s.rot) * 0.1, 0x8a6a4a);
    }
    if (r() < 0.25) b.box(0.07, 0.07, 0.07, s.x + 0.12, 0.01, s.z + 0.1, 0xa88a5a, false, r()); // a cardboard box
  }
  return b.build();
}

/** A bank of white low-poly clouds covering an area that isn't open yet. */
export function cloudBank(x: number, z: number, w: number, d: number, seed: number, y = 0.5): Built {
  const r = rng(seed);
  const b = new GeoBuilder();
  const n = Math.max(6, Math.round((w * d) / 1.6));
  for (let i = 0; i < n; i++) {
    const cx = x + (r() - 0.5) * w;
    const cz = z + (r() - 0.5) * d;
    const s = 0.45 + r() * 0.4;
    const g = new THREE.IcosahedronGeometry(s, 1).scale(1.3, 0.55, 1.1);
    b.transformed(g, new THREE.Matrix4().makeTranslation(cx, y + r() * 0.25, cz), r() < 0.5 ? 0xfdfdfd : 0xeef3f8);
    const g2 = new THREE.IcosahedronGeometry(s * 0.7, 1).scale(1.2, 0.6, 1.1);
    b.transformed(g2, new THREE.Matrix4().makeTranslation(cx + s * 0.6, y + 0.15 + r() * 0.2, cz - s * 0.3), 0xffffff);
  }
  return b.build();
}

/** An empty plot with a for-sale sign; `glow` marks it during placement. */
export function plotMarker(x: number, z: number): Built {
  const b = new GeoBuilder();
  b.box(1.9, 0.02, 1.9, x, 0, z, 0xc9b892);
  for (const [dx, dz, w, d] of [[0, -0.95, 1.9, 0.04], [0, 0.95, 1.9, 0.04], [-0.95, 0, 0.04, 1.9], [0.95, 0, 0.04, 1.9]] as const) {
    b.box(w, 0.025, d, x + dx, 0.01, z + dz, PALETTE.trim);
  }
  b.box(0.03, 0.34, 0.03, x + 0.55, 0.02, z + 0.7, PALETTE.wood);
  b.box(0.32, 0.18, 0.02, x + 0.55, 0.3, z + 0.71, 0xe85a4a);
  b.box(0.24, 0.04, 0.025, x + 0.55, 0.35, z + 0.715, PALETTE.trim);
  return b.build();
}

// ─── Vehicles ─────────────────────────────────────────────────────────────

/** Planes face +x. */
export function plane(model: string, seed: number): Built {
  const r = rng(seed);
  const b = new GeoBuilder();
  const livery = pick(r, [0x2f6fa8, 0xd8402e, 0x2f8a6a, 0x1c1c24] as const);
  const len = model === 'prop' ? 0.9 : model === 'jet' ? 1.4 : model === 'jet-long' ? 1.8 : 1.9;
  const fuselage = new THREE.CylinderGeometry(0.08, 0.1, len, 10).rotateZ(Math.PI / 2);
  b.transformed(fuselage, new THREE.Matrix4().makeTranslation(0, 0.22, 0), PALETTE.trim);
  b.blob(0.09, len / 2, 0.22, 0, PALETTE.trim);
  b.box(len * 0.9, 0.02, 0.2, 0, 0.16, 0, livery);
  const wing = (span: number, sweep: number, x: number, y: number, chord: number) => {
    for (const s of [-1, 1]) {
      const g = new THREE.BoxGeometry(chord, 0.02, span);
      g.translate(0, 0, (s * span) / 2);
      b.transformed(g, new THREE.Matrix4().compose(new THREE.Vector3(x, y, 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, s * sweep, 0)), new THREE.Vector3(1, 1, 1)), 0xe6e9ee);
    }
  };
  if (model === 'prop') {
    wing(0.6, 0, 0.1, 0.3, 0.16);
    b.box(0.02, 0.24, 0.02, len / 2 + 0.05, 0.1, 0, 0x222222);
    wing(0.22, 0, -len / 2 + 0.05, 0.24, 0.1);
  } else if (model === 'jet-super') {
    const delta = new THREE.Shape([new THREE.Vector2(0.5, 0), new THREE.Vector2(-0.7, 0.55), new THREE.Vector2(-0.7, -0.55)]);
    const g = new THREE.ExtrudeGeometry(delta, { depth: 0.02, bevelEnabled: false }).rotateX(Math.PI / 2);
    b.transformed(g, new THREE.Matrix4().makeTranslation(0, 0.2, 0), 0xe6e9ee);
  } else {
    wing(len * 0.42, 0.45, 0, 0.17, 0.26);
    for (const s of [-1, 1]) b.cylinder(0.05, 0.05, 0.22, -len * 0.32, 0.26, s * 0.13, 0xd0d4dc, 8);
    b.box(0.2, 0.3, 0.02, -len / 2 + 0.08, 0.3, 0, livery);
    wing(0.26, 0.4, -len / 2 + 0.06, 0.45, 0.12);
  }
  for (const [x, z] of [[len * 0.3, 0], [-0.1, 0.1], [-0.1, -0.1]] as const) b.box(0.02, 0.12, 0.02, x, 0, z, 0x333333);
  const built = b.build();
  built.group.traverse((o) => (o.castShadow = true));
  return built;
}

/** Yachts face +x. */
export function yacht(size: 'day' | 'super', seed: number): Built {
  const r = rng(seed);
  const b = new GeoBuilder();
  const k = size === 'super' ? 2.2 : 1;
  b.box(1.2 * k, 0.16 * k, 0.36 * k, 0, 0, 0, PALETTE.trim);
  b.box(0.3 * k, 0.15 * k, 0.28 * k, 0.65 * k, 0, 0, PALETTE.trim, false, Math.PI / 4);
  b.box(1.22 * k, 0.03 * k, 0.37 * k, 0, 0.06 * k, 0, 0x1c2a3a);
  b.box(0.6 * k, 0.14 * k, 0.28 * k, -0.1 * k, 0.16 * k, 0, 0xf8f5ee);
  b.windows({ w: 0.6 * k, d: 0.28 * k, x: -0.1 * k, z: 0, y0: 0.16 * k, rows: 1, rowHeight: 0.14 * k, cols: 4, faces: ['z+', 'z-'] }, r, 1, warmth(r), { w: 0.1 * k, h: 0.06 * k });
  if (size === 'super') {
    b.box(0.35 * k, 0.12 * k, 0.22 * k, -0.2 * k, 0.3 * k, 0, 0xf8f5ee);
    b.cylinder(0.05, 0.05, 0.2, -0.2 * k, 0.42 * k, 0, PALETTE.steel, 6);
    b.cylinder(0.25, 0.25, 0.02, -0.45 * k, 0.16 * k, 0, 0x55606e, 12);
  }
  const built = b.build();
  built.group.traverse((o) => (o.castShadow = true));
  return built;
}

export function rocket(seed: number): Built {
  void seed;
  const b = new GeoBuilder();
  b.cylinder(0.22, 0.22, 2.6, 0, 0.3, 0, 0xf4f4f0, 16);
  b.cylinder(0.005, 0.22, 0.7, 0, 2.9, 0, 0xf4f4f0, 16);
  b.cylinder(0.225, 0.225, 0.25, 0, 2.0, 0, 0x1c1c24, 16);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    b.box(0.04, 0.5, 0.3, Math.cos(a) * 0.24, 0.3, Math.sin(a) * 0.24, 0xd8402e, false, -a);
  }
  b.cylinder(0.16, 0.12, 0.3, 0, 0, 0, 0x55606e, 12);
  const built = b.build();
  built.group.traverse((o) => (o.castShadow = true));
  return built;
}
