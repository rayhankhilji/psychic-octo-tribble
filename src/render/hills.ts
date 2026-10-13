import * as THREE from 'three';
import { GeoBuilder, type ColorLike } from './geo.ts';
import { PALETTE } from './palette.ts';
import { palm, tree, warmth, type Built } from './buildings.ts';
import {
  FX, Kit, LAMP, TINT, beam, bush, cypress, facade, fin, flat, neonOf, ngonPts, prism, put, quad4, quadBlob, rectPts, rod, shade, wall, winOf, wr,
  type XZ,
} from './towers.ts';
import { pick, rng } from '../world/rng.ts';

/**
 * Houses for TinyTown Hills, the slopes under the sign: four styles of
 * real LA and SF hillside houses. Each is built in local space on a level
 * pad (origin at its centre, y = 0) inside 1.1 × 0.95, with its view side
 * (glass, decks, pool) facing +z, so the city can turn +z downhill.
 * Under about 2.5k triangles, standard buckets and Kit layers only.
 */

export type HillsStyle = 'midcentury' | 'spanish' | 'modern' | 'canyon';

/** Pool water: a soft cyan that glows at night. */
const POOL: ColorLike = [0.3, 0.9, 1.1];
/** Lamp-lit rooms behind floor-to-ceiling glass: softer than a punched window. */
const GLASS_LIGHT: ColorLike = [1.35, 0.92, 0.5];
const STEEL = 0x2a2f38;
const WHITE = 0xf4f2ec;

export function hillsHouse(style: HillsStyle, seed: number): Built {
  const r = rng(seed);
  const b = new Kit();
  // Which side the pool (or tub) sits: everything is laid out for +1 and mirrored in x for −1
  const m = r() < 0.5 ? 1 : -1;
  switch (style) {
    case 'midcentury':
      midcentury(b, r, m);
      break;
    case 'spanish':
      spanish(b, r, m);
      break;
    case 'modern':
      modern(b, r, m);
      break;
    default:
      canyon(b, r, m);
  }
  const built = b.build();
  built.group.traverse((o) => (o.castShadow = true));
  return built;
}

// ─── Shared bits ───────────────────────────────────────────────────────────

/** A glass room: dark glazing, floor-to-ceiling windows with slim mullions on the chosen edges. */
function glassRoom(b: GeoBuilder, r: () => number, pts: readonly XZ[], y: number, h: number, edges: (e: number) => boolean, mullion: ColorLike = STEEL, bay = 0.13) {
  prism(b, pts, y, h, 0x3a4656, 'glass');
  facade(b, r, pts, y, null, y + h, { floors: 1, bay, winH: 0.94, winW: 0.92, lit: 0.85, light: GLASS_LIGHT, tint: TINT.sky, edges, fins: { color: mullion, depth: 0.008, width: 0.008 } });
}

/** A rectangular pool sunk in the terrace: coping, a darker tile band, glowing water. */
function pool(b: GeoBuilder, x: number, z: number, w: number, d: number, coping: ColorLike = 0xeeeae0) {
  b.box(w + 0.05, 0.016, d + 0.05, x, 0, z, coping);
  flat(b, 'solid', x, 0.0165, z, w + 0.002, d + 0.002, 0x2f6f8a);
  flat(neonOf(b), 'glow', x, 0.017, z, w - 0.014, d - 0.014, POOL);
}

/** A kidney pool: a smooth blob outline in coping, the water inside. */
function kidneyPool(b: GeoBuilder, x: number, z: number, w: number, d: number, m: number) {
  const outline = (k: number): XZ[] =>
    Array.from({ length: 18 }, (_, i) => {
      const a = (i / 18) * Math.PI * 2;
      // A bean: an ellipse pinched in on one long side
      const pinch = 1 - 0.32 * Math.max(0, Math.sin(a)) ** 3;
      return [x + m * Math.cos(a) * (w / 2) * k, z + Math.sin(a) * (d / 2) * k * pinch] as XZ;
    });
  const o = outline(1.12);
  prism(b, m > 0 ? o : [...o].reverse(), 0, 0.016, 0xeeeae0);
  const wtr = outline(0.98);
  prism(neonOf(b), m > 0 ? wtr : [...wtr].reverse(), 0.012, 0.006, POOL, 'glow');
}

/** A punched window with a trim surround and a sill, glass in the window layer. */
function punch(b: GeoBuilder, r: () => number, x: number, y: number, z: number, nx: number, nz: number, w: number, h: number, trim: ColorLike, share = 0.6) {
  wall(b, 'solid', x + nx * 0.003, y, z + nz * 0.003, nx, nz, w + 0.024, h + 0.024, trim);
  wall(winOf(b), 'glow', x + nx * 0.006, y, z + nz * 0.006, nx, nz, w, h, warmth(r), wr(r, share, TINT.sky));
  b.box(Math.abs(nz) > 0.5 ? w + 0.03 : 0.02, 0.01, Math.abs(nz) > 0.5 ? 0.02 : w + 0.03, x + nx * 0.01, y - h / 2 - 0.014, z + nz * 0.01, trim);
}

/** A round-headed arch on a wall facing (nx, nz): a rectangle and a half disc. */
function arch(b: GeoBuilder, bucket: 'solid' | 'glow', x: number, y: number, z: number, nx: number, nz: number, w: number, h: number, color: ColorLike, rand = 0) {
  wall(b, bucket, x, y + (h - w / 2) / 2, z, nx, nz, w, h - w / 2, color, rand);
  // The round head as a fan of quads (each a triangle), so it keeps the window's switch-on time
  const tx = nz;
  const tz = -nx;
  const cy = y + h - w / 2;
  const P = (a: number) => [x + tx * Math.cos(a) * (w / 2), cy + Math.sin(a) * (w / 2), z + tz * Math.cos(a) * (w / 2)] as const;
  for (let k = 0; k < 4; k++) {
    const a0 = (k / 4) * Math.PI;
    const a1 = ((k + 1) / 4) * Math.PI;
    quad4(b, bucket, [[x, cy, z], P(a0), P(a1), P(a1)], color, [nx, 0, nz], rand);
  }
}

/** A string of bulbs sagging between two points (neon layer). */
function bulbs(b: GeoBuilder, ax: number, ay: number, az: number, cx: number, cy: number, cz: number, n: number, sag = 0.03) {
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    quadBlob(neonOf(b), ax + (cx - ax) * t, ay + (cy - ay) * t - Math.sin(t * Math.PI) * sag, az + (cz - az) * t, 0.007, LAMP, FX.shimmer + ((k * 0.37) % 1));
  }
}

/** Tile courses on a hip roof built with `GeoBuilder.hip` (same arguments): darker bands up all four slopes. */
function hipCourses(b: GeoBuilder, x: number, y: number, z: number, w: number, h: number, d: number, o: number, top: number, color: ColorLike) {
  const ex = (t: number, s: number) => s * (0.5 + (top * Math.SQRT1_2 - 0.5) * t);
  const W = w + 2 * o;
  const D = d + 2 * o;
  for (const t of [0.12, 0.34, 0.56, 0.78]) {
    const t2 = t + 0.05;
    const lift = 0.003;
    for (const s of [-1, 1]) {
      // Front and back slopes (normal ±z), then the two ends (normal ±x)
      quad4(b, 'solid', [[x - ex(t, W), y + h * t + lift, z + s * ex(t, D)], [x + ex(t, W), y + h * t + lift, z + s * ex(t, D)], [x + ex(t2, W), y + h * t2 + lift, z + s * ex(t2, D)], [x - ex(t2, W), y + h * t2 + lift, z + s * ex(t2, D)]], color, [0, 1, s]);
      quad4(b, 'solid', [[x + s * ex(t, W), y + h * t + lift, z - ex(t, D)], [x + s * ex(t, W), y + h * t + lift, z + ex(t, D)], [x + s * ex(t2, W), y + h * t2 + lift, z + ex(t2, D)], [x + s * ex(t2, W), y + h * t2 + lift, z - ex(t2, D)]], color, [s, 1, 0]);
    }
  }
}

/** Tile courses on a gable roof with its ridge along z (`gable(..., Math.PI / 2)`): bands along both slopes. */
function gableCourses(b: GeoBuilder, x: number, y: number, z: number, len: number, h: number, w: number, o: number, color: ColorLike) {
  const half = w / 2 + o;
  const L = len / 2 + o;
  for (const t of [0.15, 0.4, 0.65]) {
    const t2 = t + 0.07;
    for (const s of [-1, 1]) {
      quad4(b, 'solid', [[x + s * half * (1 - t), y + h * t + 0.003, z - L], [x + s * half * (1 - t), y + h * t + 0.003, z + L], [x + s * half * (1 - t2), y + h * t2 + 0.003, z + L], [x + s * half * (1 - t2), y + h * t2 + 0.003, z - L]], color, [s, 1, 0]);
    }
  }
}

/** A spiky agave. */
function agave(b: GeoBuilder, x: number, y: number, z: number, s = 1) {
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    put(b, new THREE.ConeGeometry(0.01 * s, 0.06 * s, 3), x + Math.cos(a) * 0.01 * s, y + 0.026 * s, z + Math.sin(a) * 0.01 * s, 0x7aa08a, 'solid', -a, 0, 0.6);
  }
}

/** A lounger on the deck, facing +z. */
function lounger(b: GeoBuilder, x: number, y: number, z: number, color: ColorLike = WHITE) {
  b.box(0.045, 0.012, 0.11, x, y + 0.012, z, color);
  put(b, new THREE.BoxGeometry(0.045, 0.01, 0.04), x, y + 0.03, z - 0.06, color, 'solid', 0, 0.6);
}

/** A market umbrella. */
function umbrella(b: GeoBuilder, x: number, y: number, z: number, color: ColorLike) {
  b.cylinder(0.003, 0.003, 0.15, x, y, z, 0xdddddd, 4);
  b.cylinder(0, 0.075, 0.03, x, y + 0.14, z, color, 8);
}

/** Path or garden lights, low and warm. */
function pathLight(b: GeoBuilder, x: number, y: number, z: number) {
  b.box(0.008, 0.025, 0.008, x, y, z, STEEL);
  quadBlob(neonOf(b), x, y + 0.03, z, 0.006, LAMP);
}

/** A clump of magenta bougainvillea spilling over (x, y, z). */
function bougainvillea(b: GeoBuilder, r: () => number, x: number, y: number, z: number, spread: number, n = 5) {
  for (let k = 0; k < n; k++) {
    const t = n > 1 ? k / (n - 1) - 0.5 : 0;
    b.blob(0.022 + r() * 0.012, x + t * spread, y - r() * 0.05, z + (r() - 0.5) * 0.02, pick(r, [0xd8337f, 0xe0479a, 0xc22a72] as const), 'smooth');
  }
  for (let k = 0; k < Math.ceil(n / 2); k++) b.blob(0.02, x + (r() - 0.5) * spread, y - 0.04 - r() * 0.05, z, 0x3f7a3a, 'smooth');
}

// ─── Midcentury: the Stahl House ───────────────────────────────────────────

function midcentury(b: Kit, r: () => number, m: number) {
  const X = (x: number) => x * m;
  const concrete = pick(r, [0xe4e0d6, 0xdcd8cc, 0xe8e2d2] as const);
  const stone = pick(r, [0xb8ab98, 0xa89a86, 0xc2b49c] as const);
  const accent = pick(r, [0xd88a3a, 0x3a7a8a, 0xc8402e, 0xe8c25a] as const);
  const deep = 0.3 + r() * 0.05; // how far the living room shoots out
  // Terrace: one big concrete slab with expansion joints
  b.box(1.1, 0.008, 0.95, 0, -0.008, 0, concrete);
  for (let k = 1; k < 5; k++) flat(b, 'solid', X(-0.55 + k * 0.11), 0.0005, 0.22, 0.004, 0.5, shade(concrete, 0.88));
  const y0 = 0.0;
  const h = 0.22;
  // Bedroom wing along the back: a solid, board-formed back wall, glass to the terrace
  b.box(0.88, h, 0.05, X(-0.05), y0, -0.425, WHITE);
  glassRoom(b, r, rectPts(0.88, 0.2, X(-0.05), -0.3), y0, h, (e) => e === 2 || e === (m > 0 ? 3 : 1), STEEL, 0.15);
  for (let k = 0; k < 4; k++) wall(winOf(b), 'glow', X(-0.38 + k * 0.21), y0 + h * 0.78, -0.451, 0, -1, 0.14, 0.03, GLASS_LIGHT, wr(r, 0.5, TINT.sky));
  // Stone fireplace wall and its flue, where the wings meet
  b.box(0.1, h + 0.02, 0.1, X(0.24), y0, -0.2, stone);
  for (let k = 1; k < 5; k++) b.box(0.104, 0.004, 0.104, X(0.24), y0 + k * 0.05, -0.2, shade(stone, 0.85));
  b.cylinder(0.014, 0.014, 0.1, X(0.24), y0 + h + 0.02, -0.2, STEEL, 6);
  // Living room: all glass, cantilevered towards the view on thin steel
  const lx = X(0.3);
  const lz = -0.2 + deep / 2 + 0.12;
  const lw = 0.36;
  const ld = deep + 0.24;
  glassRoom(b, r, rectPts(lw, ld, lx, lz), y0, h, () => true, STEEL, 0.12);
  const front = lz + ld / 2;
  for (const s of [-1, 1]) {
    beam(b, lx + s * (lw / 2 - 0.01), y0 - 0.02, front - 0.01, lx + s * (lw / 2 - 0.01), -0.36, front - 0.01, 0.016, STEEL);
    b.box(0.014, h, 0.014, lx + s * (lw / 2 + 0.002), y0, front + 0.002, STEEL);
  }
  b.box(lw + 0.02, 0.03, ld, lx, y0 - 0.03, lz, STEEL); // the steel deck edge under the glass
  // One thin flat roof over both wings with deep overhangs, a timber soffit and a white fascia
  const roofY = y0 + h;
  const over = 0.07;
  const roofs: [number, number, number, number][] = [[X(-0.05), -0.3, 0.98, 0.34], [lx, lz + 0.03, lw + over * 2, ld + over]];
  for (const [rx, rz, rw, rd] of roofs) {
    b.box(rw, 0.008, rd, rx, roofY, rz, 0xa8744a);
    b.box(rw, 0.022, rd, rx, roofY + 0.008, rz, WHITE);
    b.box(rw - 0.06, 0.004, rd - 0.06, rx, roofY + 0.03, rz, 0xcfc8ba);
  }
  // The Stahl House's signature: steel roof beams running out past the glass and the overhang
  for (let k = 0; k < 5; k++) {
    const bz = lz - ld / 2 + 0.06 + k * ((ld - 0.06) / 4);
    fin(b, lx, roofY + 0.04, bz, m, 0, 0, 0, 1, 0, 0.014, lw + over * 2 + 0.03, 0.02, WHITE);
  }
  for (let k = 0; k < 6; k++) fin(b, X(-0.47 + k * 0.17), roofY + 0.04, -0.3, 0, 0, 1, 0, 1, 0, 0.014, 0.37, 0.02, WHITE);
  // Roof: a skylight, a vent, the flue
  b.box(0.08, 0.02, 0.08, X(-0.25), roofY + 0.03, -0.33, 0x9fc0d4, 'glass');
  b.box(0.05, 0.03, 0.05, X(-0.45), roofY + 0.03, -0.36, 0x9aa3ad);
  // Inside the glass: a lamp-lit sofa and a sculptural chair read through the window at dusk
  b.box(0.16, 0.025, 0.05, lx, y0, lz - 0.02, accent);
  // Pool on the open terrace, kidney or rectangular, with loungers and an umbrella
  const px = X(-0.24);
  const pz = 0.14;
  if (r() < 0.5) kidneyPool(b, px, pz, 0.46, 0.26, m);
  else pool(b, px, pz, 0.44, 0.22);
  for (let k = 0; k < 2; k++) lounger(b, X(-0.44 + k * 0.08), 0, 0.36);
  umbrella(b, X(-0.05), 0, 0.37, accent);
  // Dining under the overhang: a long table, wire chairs, a grill against the stone
  b.box(0.16, 0.006, 0.06, X(-0.2), 0.045, -0.15, WHITE);
  b.box(0.008, 0.045, 0.04, X(-0.27), 0, -0.15, STEEL);
  b.box(0.008, 0.045, 0.04, X(-0.13), 0, -0.15, STEEL);
  for (let k = 0; k < 3; k++) for (const s of [-1, 1]) b.box(0.03, 0.025, 0.03, X(-0.25 + k * 0.05), 0, -0.15 + s * 0.05, accent);
  b.box(0.06, 0.05, 0.035, X(0.09), 0, -0.17, STEEL);
  b.box(0.065, 0.006, 0.04, X(0.09), 0.05, -0.17, 0x55595f);
  // A low stone wall along the drop, agaves and a palm, path lights
  b.box(0.62, 0.05, 0.04, X(-0.24), 0, 0.455, stone);
  b.box(0.04, 0.05, 0.4, X(-0.53), 0, 0.27, stone);
  for (const [ax, az] of [[-0.5, -0.06], [-0.44, -0.04], [0.5, 0.05]] as const) agave(b, X(ax), 0, az);
  palm(b, r, X(-0.4), -0.09, 0.45, 0);
  bush(b, r, X(0.5), 0.05, -0.38, 0.05, 0x6a8a5a);
  for (let k = 0; k < 3; k++) pathLight(b, X(0.07), 0, 0.0 + k * 0.14);
}

// ─── Spanish Revival ───────────────────────────────────────────────────────

function spanish(b: Kit, r: () => number, m: number) {
  const X = (x: number) => x * m;
  const stucco = pick(r, [0xf6efe2, 0xf3e6cc, 0xf1e0c4, 0xf8f2e6] as const);
  const tile = pick(r, [0xc4552f, 0xb94b38, 0xd0663a] as const);
  const trim = shade(stucco, 0.86);
  const iron = 0x23262e;
  const door = pick(r, [0x5a3a2a, 0x2f4a5a, 0x3a5a3a] as const);
  const y0 = 0;
  // Terracotta courtyard pavers and a garden strip
  b.box(1.1, 0.008, 0.95, 0, -0.008, 0, 0xd9b48e);
  for (let k = 1; k < 9; k++) flat(b, 'solid', 0, 0.0005, -0.45 + k * 0.1, 1.08, 0.003, 0xc49a74);
  // Main house: two storeys along the back under a hip roof
  const mw = 0.66;
  const md = 0.3;
  const mx = X(-0.17);
  const mz = -0.285;
  const mh = 0.38;
  b.box(mw, mh, md, mx, y0, mz, stucco);
  b.hip(mw, 0.11, md, mx, y0 + mh, mz, tile, 0.04, 0.2);
  hipCourses(b, mx, y0 + mh, mz, mw, 0.11, md, 0.04, 0.2, shade(tile, 0.82));
  b.box(mw + 0.07, 0.014, md + 0.07, mx, y0 + mh - 0.004, mz, shade(tile, 0.75));
  const mf = mz + md / 2;
  // Ground floor: a loggia of three arches, warm light behind
  for (let k = 0; k < 3; k++) {
    const ax = mx + X(-0.2 + k * 0.13);
    arch(b, 'solid', ax, y0, mf + 0.003, 0, 1, 0.1, 0.16, 0x4a3a30);
    arch(winOf(b), 'glow', ax, y0 + 0.02, mf + 0.004, 0, 1, 0.07, 0.12, warmth(r), wr(r, 0.9, TINT.shop));
  }
  wall(b, 'solid', mx + X(0.24), y0 + 0.09, mf + 0.004, 0, 1, 0.07, 0.17, door);
  b.box(0.014, 0.024, 0.014, mx + X(0.29), y0 + 0.15, mf + 0.012, iron);
  quadBlob(neonOf(b), mx + X(0.29), y0 + 0.16, mf + 0.012, 0.007, LAMP);
  // Upper floor: tall windows, one with a wrought-iron balcony
  for (let k = 0; k < 3; k++) punch(b, r, mx + X(-0.2 + k * 0.17), y0 + 0.29, mf, 0, 1, 0.06, 0.1, trim, 0.7);
  const bx = mx + X(-0.03);
  b.box(0.13, 0.01, 0.05, bx, y0 + 0.235, mf + 0.025, iron);
  for (let k = 0; k <= 6; k++) b.box(0.003, 0.045, 0.003, bx - 0.06 + k * 0.02, y0 + 0.245, mf + 0.048, iron);
  b.box(0.13, 0.004, 0.004, bx, y0 + 0.29, mf + 0.048, iron);
  // Side and back windows, so it's finished all round
  for (const s of [-1, 1]) for (const fy of [0.11, 0.29]) punch(b, r, mx + s * (mw / 2), y0 + fy, mz, s, 0, 0.05, 0.08, trim, 0.5);
  for (let k = 0; k < 3; k++) for (const fy of [0.11, 0.29]) punch(b, r, mx + X(-0.2 + k * 0.2), y0 + fy, mz - md / 2, 0, -1, 0.05, 0.08, trim, 0.5);
  // The stair turret: square, taller, a steep tile cap, a glowing arched opening at the top
  const tx = X(-0.465);
  const tz = -0.15;
  b.box(0.15, 0.52, 0.15, tx, y0, tz, stucco);
  b.box(0.17, 0.016, 0.17, tx, y0 + 0.51, tz, trim);
  put(b, new THREE.ConeGeometry(0.12, 0.11, 4), tx, y0 + 0.581, tz, tile, 'solid', Math.PI / 4);
  for (const [nx, nz] of [[0, 1], [m, 0], [0, -1], [-m, 0]] as const) {
    arch(winOf(b), 'glow', tx + nx * 0.076, y0 + 0.39, tz + nz * 0.076, nx, nz, 0.05, 0.09, [2.2, 1.6, 0.8], wr(r, 1, TINT.shop));
  }
  punch(b, r, tx, y0 + 0.2, tz + 0.075, 0, 1, 0.03, 0.06, trim, 0.6);
  // Guest wing: one storey towards the view, a gable roof with its ridge to the street
  const gx = X(0.33);
  const gz = 0.0;
  const gw = 0.34;
  const gd = 0.44 + r() * 0.06;
  const gh = 0.24;
  b.box(gw, gh, gd, gx, y0, gz, stucco);
  b.gable(gd, 0.1, gw, gx, y0 + gh, gz, tile, 0.035, Math.PI / 2);
  gableCourses(b, gx, y0 + gh, gz, gd, 0.1, gw, 0.035, shade(tile, 0.82));
  const gf = gz + gd / 2;
  arch(winOf(b), 'glow', gx, y0 + 0.03, gf + 0.004, 0, 1, 0.13, 0.17, warmth(r), wr(r, 0.9, TINT.sky));
  b.box(0.16, 0.012, 0.03, gx, y0 + 0.03, gf + 0.015, trim);
  wall(b, 'solid', gx, y0 + gh + 0.05, gf + 0.036, 0, 1, 0.05, 0.018, 0x4a3a30); // attic vent
  for (const dz of [-0.12, 0.08]) punch(b, r, gx + X(gw / 2), y0 + 0.13, gz + dz, m, 0, 0.05, 0.09, trim, 0.6);
  for (const dz of [-0.12, 0.08]) punch(b, r, gx - X(gw / 2), y0 + 0.13, gz + dz, -m, 0, 0.05, 0.09, trim, 0.6);
  // A clay chimney with its little tiled hood
  b.box(0.06, 0.16, 0.06, mx + X(0.22), y0 + mh - 0.02, mz - 0.06, stucco);
  b.box(0.08, 0.014, 0.08, mx + X(0.22), y0 + mh + 0.14, mz - 0.06, tile);
  // Courtyard fountain: a tiled octagon with a glowing basin
  const fx = X(-0.02);
  const fz = -0.03;
  prism(b, ngonPts(8, 0.07, 0.07, fx, fz, Math.PI / 8), y0, 0.035, 0x2f6fa0);
  prism(neonOf(b), ngonPts(8, 0.058, 0.058, fx, fz, Math.PI / 8), y0 + 0.032, 0.004, POOL, 'glow');
  b.cylinder(0.012, 0.018, 0.07, fx, y0, fz, trim, 6);
  b.cylinder(0.03, 0.01, 0.012, fx, y0 + 0.07, fz, trim, 8);
  // Pool on the terrace, blue tile coping
  pool(b, X(-0.25), 0.25, 0.42, 0.2, 0xe8dcc4);
  lounger(b, X(0.05), 0, 0.3, 0xf4ecd8);
  // A low stucco garden wall along the drop, bougainvillea spilling over it and up the turret
  b.box(1.04, 0.06, 0.04, 0, y0, 0.455, stucco);
  b.box(1.06, 0.012, 0.05, 0, y0 + 0.06, 0.455, tile);
  bougainvillea(b, r, X(0.25), y0 + 0.08, 0.465, 0.3, 5);
  bougainvillea(b, r, tx + X(0.085), y0 + 0.28, tz + 0.06, 0.05, 3);
  // Potted lemons, cypresses, a palm
  for (const [px, pz] of [[0.1, 0.12], [-0.1, -0.12]] as const) {
    b.cylinder(0.022, 0.016, 0.035, X(px), y0, pz, 0xc0603a, 6);
    bush(b, r, X(px), y0 + 0.07, pz, 0.035, 0x4f8d3b);
    b.blob(0.007, X(px) + 0.02, y0 + 0.08, pz + 0.015, 0xf6d84a, 'smooth');
  }
  cypress(b, r, X(0.34), -0.42, 0.8, y0);
  cypress(b, r, X(0.48), -0.38, 0.72, y0);
  palm(b, r, X(-0.42), 0.03, 0.45, y0);
}

// ─── Modern: stacked white cubes ───────────────────────────────────────────

function modern(b: Kit, r: () => number, m: number) {
  const X = (x: number) => x * m;
  const white = pick(r, [0xf6f5f0, 0xf2f0ea, 0xeeeeea] as const);
  const stone = pick(r, [0xc9c2b4, 0x9a968c, 0xd8d2c4] as const);
  const wood = pick(r, [0xa8744a, 0x8a5a38, 0xb9824f] as const);
  const y0 = 0;
  // Stone deck over the whole pad
  b.box(1.1, 0.008, 0.95, 0, -0.008, 0, stone);
  for (let k = 1; k < 6; k++) flat(b, 'solid', X(-0.55 + k * 0.18), 0.0005, 0.0, 0.003, 0.94, shade(stone, 0.9));
  // Lower cube: wide, glazed to the view, solid at the back
  const lw = 0.82;
  const ld = 0.42;
  const lx = X(-0.1);
  const lz = -0.22;
  const lh = 0.22;
  b.box(lw, lh, ld - 0.1, lx, y0, lz - 0.05, white);
  glassRoom(b, r, rectPts(lw - 0.04, 0.1, lx, lz + ld / 2 - 0.06), y0, lh, (e) => e === 2, STEEL, 0.14);
  b.box(lw + 0.02, 0.02, ld + 0.02, lx, y0 + lh, lz, white);
  for (let k = 0; k < 3; k++) wall(winOf(b), 'glow', lx + X(-0.3 + k * 0.3), y0 + lh * 0.6, lz - ld / 2 - 0.003, 0, -1, 0.16, 0.035, GLASS_LIGHT, wr(r, 0.5, TINT.smoke));
  wall(winOf(b), 'glow', lx - X(lw / 2) - 0.003 * m, y0 + lh * 0.55, lz - 0.05, -m, 0, 0.2, 0.03, GLASS_LIGHT, wr(r, 0.5, TINT.smoke));
  // Upper cube: offset and cantilevered past the lower one, glazed front, a slatted wood screen on its side
  const ux = X(0.18);
  const uz = -0.2;
  const uw = 0.44 + r() * 0.08;
  const ud = 0.4;
  const uy = y0 + lh + 0.02;
  const uh = 0.19 + r() * 0.03;
  b.box(uw, uh, ud - 0.08, ux, uy, uz - 0.04, white);
  glassRoom(b, r, rectPts(uw - 0.04, 0.08, ux, uz + ud / 2 - 0.05), uy, uh, (e) => e === 2, STEEL, 0.14);
  b.box(uw + 0.02, 0.02, ud + 0.02, ux, uy + uh, uz, white);
  const sx = ux + X(uw / 2) + 0.012 * m;
  for (let k = 0; k < 12; k++) {
    const zz = uz - ud / 2 + 0.02 + k * ((ud - 0.04) / 11);
    fin(b, sx, uy + uh / 2, zz, 0, 1, 0, m, 0, 0, 0.012, uh, 0.016, wood);
  }
  // A timber brise-soleil over the outer half of the upper glazing
  for (let k = 0; k < 9; k++) {
    fin(b, ux + X(0.02 + k * 0.026), uy + uh / 2, uz + ud / 2 + 0.008, 0, 1, 0, 0, 0, 1, 0.01, uh - 0.01, 0.018, wood);
  }
  for (let k = 0; k < 2; k++) wall(winOf(b), 'glow', ux + X(-0.12 + k * 0.24), uy + uh * 0.6, uz - ud / 2 - 0.003, 0, -1, 0.14, 0.03, GLASS_LIGHT, wr(r, 0.5, TINT.smoke));
  // Upper roof: a dark membrane, a skylight, the solar
  b.box(uw - 0.04, 0.004, ud - 0.04, ux, uy + uh + 0.02, uz, 0x8a8a84);
  for (let k = 0; k < 3; k++) put(b, new THREE.BoxGeometry(0.12, 0.006, 0.09), ux + X(-0.14 + k * 0.14), uy + uh + 0.04, uz - 0.09, 0x1f2f52, 'glass', 0, -0.25);
  // Roof terrace on the lower cube: planters, a lounge, a glass balustrade
  const ty = y0 + lh + 0.02;
  const tx = lx - X(0.24);
  b.box(0.3, 0.006, ld - 0.04, tx, ty, lz, wood);
  for (const [nx, nz, w, cx, cz] of [[0, 1, 0.32, tx, lz + ld / 2], [-m, 0, ld, tx - X(0.16), lz]] as const) {
    b.box(Math.abs(nz) > 0 ? w : 0.006, 0.07, Math.abs(nz) > 0 ? 0.006 : w, cx, ty, cz, 0xb8d8e4, 'glass');
    b.box(Math.abs(nz) > 0 ? w : 0.012, 0.006, Math.abs(nz) > 0 ? 0.012 : w, cx, ty + 0.07, cz, STEEL);
    void nx;
  }
  for (let k = 0; k < 3; k++) {
    const pz = lz - 0.14 + k * 0.1;
    b.box(0.04, 0.04, 0.07, tx - X(0.11), ty, pz, 0x3a3f4a);
    bush(b, r, tx - X(0.11), ty + 0.06, pz, 0.03, pick(r, [0x4f8d3b, 0x6a9a5a, 0x3f7a3a] as const));
  }
  lounger(b, tx + X(0.03), ty, lz + 0.02);
  b.box(0.06, 0.02, 0.06, tx + X(0.09), ty, lz + 0.05, 0x3a3f4a);
  // Infinity pool along the view, its far edge vanishing into a glowing spill trough
  const pz = 0.27;
  const pw = 0.84;
  const pd = 0.2;
  b.box(pw + 0.04, 0.02, pd + 0.04, X(-0.02), -0.004, pz, 0x3a3f4a);
  flat(neonOf(b), 'glow', X(-0.02), 0.0165, pz, pw, pd, POOL);
  neonOf(b).box(pw, 0.004, 0.006, X(-0.02), 0.014, pz + pd / 2 + 0.014, [0.5, 1.6, 2.0], true);
  b.box(pw + 0.04, 0.03, 0.02, X(-0.02), -0.03, pz + pd / 2 + 0.03, 0x2a2f38);
  for (let k = 0; k < 2; k++) lounger(b, X(-0.36 + k * 0.09), 0, 0.06);
  // An olive tree in a gravel square, a fire pit, low lights
  b.box(0.16, 0.006, 0.16, X(0.42), 0, 0.03, 0xd8d2c4);
  b.cylinder(0.01, 0.016, 0.1, X(0.42), 0, 0.03, PALETTE.trunk, 5);
  bush(b, r, X(0.42), 0.14, 0.03, 0.07, 0x8aa08a);
  bush(b, r, X(0.45), 0.12, 0.0, 0.05, 0x7a9a7a);
  b.cylinder(0.04, 0.04, 0.02, X(0.18), 0, 0.07, 0x3a3f4a, 10);
  quadBlob(neonOf(b), X(0.18), 0.03, 0.07, 0.016, [2.8, 1.4, 0.4], FX.shimmer + 0.3);
  for (let k = 0; k < 3; k++) pathLight(b, X(0.5), 0, -0.3 + k * 0.12);
  for (const [ax, az] of [[0.5, -0.4], [-0.5, -0.02]] as const) agave(b, X(ax), 0, az);
}

// ─── Canyon: a Laurel Canyon wood house ────────────────────────────────────

function canyon(b: Kit, r: () => number, m: number) {
  const X = (x: number) => x * m;
  const siding = pick(r, [0x8a5a3a, 0x6f5a48, 0x5f6a58, 0x9a7a5a] as const);
  const roof = pick(r, [0x4a4f48, 0x5a4a3a, 0x3f4a4a] as const);
  const trimC = pick(r, [0xe8dcc0, 0xd8c8a0, 0x2f3a3a] as const);
  const deckC = pick(r, [0xa77a50, 0x9a6e48, 0xb08458] as const);
  const y0 = 0;
  // A rough pad of earth, leaf litter and gravel
  b.box(1.1, 0.008, 0.95, 0, -0.008, 0, 0x8a7a5a);
  // House: board siding, a low shed roof rising towards the view
  const hw = 0.66 + r() * 0.07;
  const hd = 0.44;
  const hx = X(-0.12);
  const hz = -0.21;
  const hBack = 0.22;
  const hFront = 0.28 + r() * 0.04;
  profileShed(b, hx, hz, hw, hd, y0, hBack, hFront, siding);
  // Board-and-batten lines on the long faces
  for (let k = 0; k <= 12; k++) {
    const bxk = hx - hw / 2 + 0.02 + k * ((hw - 0.04) / 12);
    wall(b, 'solid', bxk, y0 + hFront / 2, hz + hd / 2 + 0.003, 0, 1, 0.006, hFront - 0.01, shade(siding, 0.8));
    wall(b, 'solid', bxk, y0 + hBack / 2, hz - hd / 2 - 0.003, 0, -1, 0.006, hBack - 0.01, shade(siding, 0.8));
  }
  // Roof: a sheet laid on the slope with an overhang, a fascia
  const slope = Math.atan2(hFront - hBack, hd);
  put(b, new THREE.BoxGeometry(hw + 0.1, 0.018, Math.hypot(hd, hFront - hBack) + 0.08), hx, y0 + (hBack + hFront) / 2 + 0.01, hz + 0.01, roof, 'solid', 0, -slope);
  // A sleeping loft riding the back of the roof, its own shed roof tipped the other way, a clerestory between
  const lw = 0.36;
  const lxx = hx - X(0.12);
  const lzz = hz - 0.08;
  const ld = 0.22;
  b.box(lw, 0.17, ld, lxx, y0 + hBack, lzz, siding);
  put(b, new THREE.BoxGeometry(lw + 0.07, 0.016, ld + 0.08), lxx, y0 + hBack + 0.19, lzz, roof, 'solid', 0, 0.22);
  for (let k = 0; k < 4; k++) {
    const cxk = lxx - lw / 2 + 0.05 + k * ((lw - 0.1) / 3);
    wall(b, 'solid', cxk, y0 + hBack + 0.11, lzz + ld / 2 + 0.003, 0, 1, 0.075, 0.07, trimC);
    wall(winOf(b), 'glow', cxk, y0 + hBack + 0.11, lzz + ld / 2 + 0.006, 0, 1, 0.062, 0.058, warmth(r), wr(r, 0.8, TINT.sky));
  }
  for (let k = 0; k <= 8; k++) wall(b, 'solid', lxx - lw / 2 + 0.02 + k * ((lw - 0.04) / 8), y0 + hBack + 0.085, lzz - ld / 2 - 0.003, 0, -1, 0.006, 0.16, shade(siding, 0.8));
  // Big view windows: a corner of glass and a row of wood-framed panes
  const front = hz + hd / 2;
  for (let k = 0; k < 3; k++) {
    const wx = hx + X(0.1 + k * 0.1);
    wall(b, 'solid', wx, y0 + 0.14, front + 0.004, 0, 1, 0.09, 0.2, trimC);
    wall(winOf(b), 'glow', wx, y0 + 0.14, front + 0.007, 0, 1, 0.075, 0.185, warmth(r), wr(r, 0.85, TINT.sky));
  }
  wall(b, 'solid', hx - X(0.2), y0 + 0.09, front + 0.004, 0, 1, 0.07, 0.17, trimC);
  wall(b, 'solid', hx - X(0.2), y0 + 0.09, front + 0.006, 0, 1, 0.056, 0.16, shade(deckC, 0.6));
  wall(winOf(b), 'glow', hx - X(0.2), y0 + 0.13, front + 0.008, 0, 1, 0.03, 0.06, warmth(r), wr(r, 0.9));
  for (const dz of [-0.1, 0.06]) {
    for (const s of [-1, 1]) {
      const sx2 = hx + s * (hw / 2);
      wall(b, 'solid', sx2 + s * 0.003, y0 + 0.14, hz + dz, s, 0, 0.08, 0.1, trimC);
      wall(winOf(b), 'glow', sx2 + s * 0.006, y0 + 0.14, hz + dz, s, 0, 0.066, 0.086, warmth(r), wr(r, 0.6, TINT.sky));
    }
  }
  for (let k = 0; k < 2; k++) {
    wall(b, 'solid', hx + X(-0.15 + k * 0.3), y0 + 0.15, hz - hd / 2 - 0.004, 0, -1, 0.09, 0.08, trimC);
    wall(winOf(b), 'glow', hx + X(-0.15 + k * 0.3), y0 + 0.15, hz - hd / 2 - 0.007, 0, -1, 0.076, 0.066, warmth(r), wr(r, 0.6, TINT.sky));
  }
  // River-stone chimney up the side
  const cx = hx - X(hw / 2 + 0.03);
  b.box(0.07, hFront + 0.12, 0.09, cx, y0, hz - 0.05, 0x8a8478);
  for (let k = 1; k < 7; k++) b.box(0.074, 0.004, 0.094, cx, y0 + k * 0.06, hz - 0.05, 0x6a665e);
  // Deck on posts, out over the slope: boards, a railing with balusters, stairs down
  const dy = 0.05;
  const dz0 = front;
  const dz1 = 0.44;
  const dw = 1.0;
  b.box(dw, 0.014, dz1 - dz0, X(-0.04), dy, (dz0 + dz1) / 2, deckC);
  for (let k = 1; k < 8; k++) flat(b, 'solid', X(-0.04), dy + 0.0145, dz0 + k * ((dz1 - dz0) / 8), dw, 0.003, shade(deckC, 0.8));
  for (const px of [-0.52, -0.04, 0.44]) {
    for (const pz of [dz0 + 0.04, dz1 - 0.015]) beam(b, X(px), dy, pz, X(px), -0.34, pz, 0.018, shade(deckC, 0.7));
  }
  // Railing: posts, a top rail, balusters on the view side
  const railH = 0.07;
  for (let k = 0; k <= 10; k++) b.box(0.006, railH, 0.006, X(-0.52 + k * 0.096), dy + 0.014, dz1 - 0.006, shade(deckC, 0.85));
  b.box(dw, 0.008, 0.014, X(-0.04), dy + 0.014 + railH, dz1 - 0.006, deckC);
  for (const s of [-1, 1]) b.box(0.014, 0.008, dz1 - dz0, X(-0.04) + s * (dw / 2 - 0.007), dy + 0.014 + railH, (dz0 + dz1) / 2, deckC);
  for (let k = 0; k < 3; k++) b.box(0.08, 0.012, 0.03, X(0.5), dy - 0.02 - k * 0.025, dz0 + 0.06 + k * 0.03, deckC);
  // String lights zig-zagging between tall posts over the deck
  const lp: [number, number][] = [[-0.52, dz0 + 0.04], [0.44, dz0 + 0.04], [-0.52, dz1 - 0.015], [0.44, dz1 - 0.015]];
  for (const [px, pz] of lp) rod(b, X(px), dy, pz, X(px), dy + 0.2, pz, 0.004, shade(deckC, 0.7), 3);
  bulbs(b, X(-0.52), dy + 0.2, dz0 + 0.04, X(0.44), dy + 0.2, dz1 - 0.015, 10, 0.04);
  bulbs(b, X(0.44), dy + 0.2, dz0 + 0.04, X(-0.52), dy + 0.2, dz1 - 0.015, 10, 0.04);
  // Deck life: two chairs, a table, a hot tub on the pool side, plants in pots
  for (const [ax, rot] of [[-0.36, 0.3], [-0.24, -0.25]] as const) {
    b.box(0.045, 0.016, 0.05, X(ax), dy + 0.014, 0.33, 0xe8dcc0, false, rot * m);
    put(b, new THREE.BoxGeometry(0.045, 0.045, 0.008), X(ax) - Math.sin(rot * m) * 0.024, dy + 0.045, 0.33 - Math.cos(rot * m) * 0.024, 0xe8dcc0, 'solid', rot * m, -0.3);
  }
  b.cylinder(0.025, 0.025, 0.006, X(-0.3), dy + 0.04, 0.38, deckC, 8);
  b.cylinder(0.005, 0.005, 0.026, X(-0.3), dy + 0.014, 0.38, STEEL, 4);
  const tubX = X(0.25);
  const tubZ = 0.3;
  b.cylinder(0.075, 0.075, 0.05, tubX, dy + 0.014, tubZ, shade(deckC, 0.75), 12);
  for (let k = 0; k < 2; k++) b.cylinder(0.077, 0.077, 0.004, tubX, dy + 0.024 + k * 0.02, tubZ, STEEL, 12);
  prism(neonOf(b), ngonPts(12, 0.064, 0.064, tubX, tubZ), dy + 0.06, 0.004, POOL, 'glow');
  for (const [px, pz] of [[0.0, 0.42], [-0.48, 0.24], [0.42, 0.42]] as const) {
    b.cylinder(0.02, 0.014, 0.03, X(px), dy + 0.014, pz, 0xc0603a, 6);
    bush(b, r, X(px), dy + 0.07, pz, 0.028, pick(r, [0x4f8d3b, 0x3f7a3a, 0x6a9a4a] as const));
  }
  // Greenery all round: a eucalyptus and an oak beside the house, ivy on the railing, ferns in the shade
  tree(b, r, X(0.4), -0.36, 0.6, y0, 'eucalyptus');
  tree(b, r, X(0.44), -0.12, 0.48, y0, 'round');
  for (let k = 0; k < 7; k++) {
    const vx = X(-0.5 + k * 0.155);
    b.blob(0.022 + r() * 0.01, vx, dy + 0.06 + r() * 0.03, dz1 + 0.004, pick(r, [0x3f7a3a, 0x4f8d3b, 0x2f6a34] as const), 'smooth');
  }
  for (const [fx, fz] of [[0.32, -0.02], [0.4, 0.02], [-0.52, -0.46]] as const) bush(b, r, X(fx), y0 + 0.025, fz, 0.035, pick(r, [0x3f7a3a, 0x5a8a4a] as const));
  for (let k = 0; k < 2; k++) {
    // Hanging planters from the roof edge
    const px = hx + X(-0.05 + k * 0.33);
    rod(b, px, y0 + hFront, front + 0.04, px, y0 + hFront - 0.06, front + 0.04, 0.0015, 0x3a3f4a, 3);
    b.blob(0.022, px, y0 + hFront - 0.075, front + 0.04, 0x4f8d3b, 'smooth');
  }
}

/** A shed-roofed box: walls rising from hBack at the back to hFront at the front. */
function profileShed(b: GeoBuilder, x: number, z: number, w: number, d: number, y0: number, hBack: number, hFront: number, color: ColorLike) {
  const shape = new THREE.Shape([new THREE.Vector2(-d / 2, 0), new THREE.Vector2(d / 2, 0), new THREE.Vector2(d / 2, hFront), new THREE.Vector2(-d / 2, hBack)]);
  const g = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, -w / 2);
  // Shape x is depth (towards +z), so turn it a quarter: shape x → world z, extrusion → world x
  put(b, g, x, y0, z, color, 'solid', -Math.PI / 2);
}
