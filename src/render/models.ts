import * as THREE from 'three';
import { GeoBuilder, type ColorLike } from './geo.ts';
import { PALETTE } from './palette.ts';
import { bright, palm, tree, warmth, type Built } from './buildings.ts';
import {
  FX, Kit, LAMP, RED_LIGHT, TINT, beam, bench, bush, campus, cypress, deco, facade, flat, lamp, loft, neonOf, neonRing, ngonPts, obox, people,
  pixelText, planter, prism, profile, put, pyramid, quad4, quadBlob, rectPts, rod, scalePts, shade, slab, spire, tower,
  wall, winOf, wr, type Bucket, type XZ,
} from './towers.ts';
import { pick, rng } from '../world/rng.ts';

/**
 * Models for things founders buy, their homes, their vehicles, and the
 * state of the city (tents, clouds, empty plots). Plot models are centred
 * on (x, z) and fill a 2×2 plot; block models fill a 4×4 block.
 */

const NEON = [0xff3fa4, 0x3ff2ff, 0x9d7bff, 0x5dffa0, 0xffb347] as const;
const POOL: ColorLike = [0.42, 1.45, 1.85];
const BRICK = [0xa8553e, 0xb5654a, 0x9a4a36, 0xb86a4e] as const;
const STEEL_DARK = 0x2b3038;

function pad(b: GeoBuilder, x: number, z: number, size: number, color: ColorLike = PALETTE.plaza) {
  slab(b, x, z, size, size, color);
}

/** A pool: coping and water that glows at night. */
function pool(b: GeoBuilder, x: number, y: number, z: number, w: number, d: number, coping: ColorLike = 0xf2efe8, rotY = 0) {
  b.box(w + 0.05, 0.03, d + 0.05, x, y, z, coping, false, rotY);
  flat(neonOf(b), 'glow', x, y + 0.032, z, w, d, POOL, rotY);
}

/** A striped awning sloping out from a wall facing (nx, nz). */
function awning(b: GeoBuilder, x: number, y: number, z: number, nx: number, nz: number, w: number, depth: number, a: ColorLike, c: ColorLike = 0xf8f5ee) {
  const stripes = Math.max(3, Math.round(w / 0.045));
  const sw = w / stripes;
  const tilt = 0.5;
  const ry = Math.atan2(nx, nz);
  const tx = nz;
  const tz = -nx;
  for (let k = 0; k < stripes; k++) {
    const u = (k + 0.5) / stripes - 0.5;
    const g = new THREE.BoxGeometry(sw + 0.001, 0.006, depth);
    const cx = x + tx * u * w + nx * Math.cos(tilt) * depth * 0.5;
    const cz = z + tz * u * w + nz * Math.cos(tilt) * depth * 0.5;
    put(b, g, cx, y - Math.sin(tilt) * depth * 0.5, cz, k % 2 ? c : a, 'solid', ry, tilt);
    // Valance
    wall(b, 'solid', x + tx * u * w + nx * (Math.cos(tilt) * depth + 0.002), y - Math.sin(tilt) * depth - 0.012, z + tz * u * w + nz * (Math.cos(tilt) * depth + 0.002), nx, nz, sw, 0.024, k % 2 ? c : a);
  }
}

/** A punched window with a trim surround and a sill. */
function punch(b: GeoBuilder, r: () => number, x: number, y: number, z: number, nx: number, nz: number, w: number, h: number, trim: ColorLike, light: ColorLike, tint: number, share = 0.6) {
  wall(b, 'solid', x + nx * 0.003, y, z + nz * 0.003, nx, nz, w + 0.03, h + 0.03, trim);
  wall(winOf(b), 'glow', x + nx * 0.006, y, z + nz * 0.006, nx, nz, w, h, light, wr(r, share, tint));
  b.box(Math.abs(nz) > 0.5 ? w + 0.04 : 0.025, 0.012, Math.abs(nz) > 0.5 ? 0.025 : w + 0.04, x + nx * 0.012, y - h / 2 - 0.016, z + nz * 0.012, trim);
}

/** A steel factory window: glass with a dark muntin grid. */
function steelWindow(b: GeoBuilder, r: () => number, x: number, y: number, z: number, nx: number, nz: number, w: number, h: number, light: ColorLike, share = 0.7, cols = 3, rows = 3) {
  wall(winOf(b), 'glow', x + nx * 0.004, y, z + nz * 0.004, nx, nz, w, h, light, wr(r, share, TINT.green));
  const tx = nz;
  const tz = -nx;
  for (let k = 0; k <= cols; k++) {
    const u = (k / cols - 0.5) * w;
    wall(b, 'solid', x + tx * u + nx * 0.007, y, z + tz * u + nz * 0.007, nx, nz, 0.008, h + 0.008, STEEL_DARK);
  }
  for (let k = 0; k <= rows; k++) {
    const v = (k / rows - 0.5) * h;
    wall(b, 'solid', x + nx * 0.008, y + v, z + nz * 0.008, nx, nz, w + 0.008, 0.008, STEEL_DARK);
  }
}

/** A San Francisco bay window: a three-sided bump with glass on every face. */
function bayWindow(b: GeoBuilder, r: () => number, x: number, y: number, z: number, nx: number, nz: number, w: number, depth: number, h: number, floors: number, wallColor: ColorLike, trim: ColorLike, light: ColorLike, tint: number = TINT.sky) {
  const tx = nz;
  const tz = -nx;
  const pts: XZ[] = [
    [x - tx * w / 2, z - tz * w / 2],
    [x + tx * w / 2, z + tz * w / 2],
    [x + tx * (w / 2 - depth * 0.7) + nx * depth, z + tz * (w / 2 - depth * 0.7) + nz * depth],
    [x - tx * (w / 2 - depth * 0.7) + nx * depth, z - tz * (w / 2 - depth * 0.7) + nz * depth],
  ];
  prism(b, pts, y, h * floors, wallColor);
  const fh = h;
  for (let f = 0; f < floors; f++) {
    facade(b, r, pts, y + f * fh + fh * 0.12, null, y + (f + 1) * fh - fh * 0.08, { floors: 1, bay: w * 0.5, winH: 0.86, winW: 0.74, lit: 0.75, light, tint, edges: (e) => e !== 0, fins: { color: trim, depth: 0.008, width: 0.012 } });
    prism(b, scalePts(pts, 1.06, 1.06, x + nx * depth * 0.5, z + nz * depth * 0.5), y + f * fh, 0.014, trim);
  }
  prism(b, scalePts(pts, 1.1, 1.1, x + nx * depth * 0.5, z + nz * depth * 0.5), y + floors * fh, 0.03, trim);
}

/** Cornice with little brackets along a wall facing (nx, nz). */
function cornice(b: GeoBuilder, x: number, y: number, z: number, nx: number, nz: number, w: number, color: ColorLike) {
  const along = Math.abs(nz) > 0.5;
  b.box(along ? w + 0.04 : 0.06, 0.035, along ? 0.06 : w + 0.04, x + nx * 0.02, y, z + nz * 0.02, color);
  const n = Math.max(2, Math.round(w / 0.08));
  for (let k = 0; k < n; k++) {
    const u = ((k + 0.5) / n - 0.5) * w;
    b.box(along ? 0.016 : 0.03, 0.03, along ? 0.03 : 0.016, x + nz * u + nx * 0.015, y - 0.03, z - nx * u + nz * 0.015, color);
  }
}

/** Little white figures in a sports field or on a stage. */
function figures(b: GeoBuilder, pts: readonly XZ[], y: number, shirt: ColorLike, legs: ColorLike = 0xf4f1ea) {
  for (const [px, pz] of pts) {
    b.box(0.018, 0.024, 0.014, px, y, pz, legs);
    b.box(0.022, 0.022, 0.016, px, y + 0.024, pz, shirt);
    b.blob(0.01, px, y + 0.054, pz, 0xd9a07a, 'smooth');
  }
}

/** An annular sector polygon centred on (cx, cz); angles from +x towards +z. */
function sectorPts(cx: number, cz: number, r0: number, r1: number, a0: number, a1: number, n: number): XZ[] {
  const out: XZ[] = [];
  for (let k = 0; k <= n; k++) {
    const a = a0 + ((a1 - a0) * k) / n;
    out.push([cx + Math.cos(a) * r1, cz + Math.sin(a) * r1]);
  }
  if (r0 <= 1e-4) out.push([cx, cz]);
  else
    for (let k = n; k >= 0; k--) {
      const a = a0 + ((a1 - a0) * k) / n;
      out.push([cx + Math.cos(a) * r0, cz + Math.sin(a) * r0]);
    }
  return out;
}

/** A flat arc of line on the ground (court markings), as thin quads. */
function arcLine(b: GeoBuilder, cx: number, y: number, cz: number, rad: number, a0: number, a1: number, w: number, color: ColorLike, n = 12) {
  for (let k = 0; k < n; k++) {
    const t0 = a0 + ((a1 - a0) * k) / n;
    const t1 = a0 + ((a1 - a0) * (k + 1)) / n;
    const p = (a: number, rr: number) => [cx + Math.cos(a) * rr, y, cz + Math.sin(a) * rr] as const;
    quad4(b, 'solid', [p(t0, rad - w / 2), p(t1, rad - w / 2), p(t1, rad + w / 2), p(t0, rad + w / 2)], color, [0, 1, 0]);
  }
}

/** A string of bulbs sagging between two points. */
function bulbs(b: GeoBuilder, ax: number, ay: number, az: number, cx: number, cy: number, cz: number, n: number, sag = 0.05, color: ColorLike = LAMP, fx: number = FX.shimmer) {
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    quadBlob(neonOf(b), ax + (cx - ax) * t, ay + (cy - ay) * t - Math.sin(t * Math.PI) * sag, az + (cz - az) * t, 0.009, color, fx + ((k * 0.37) % 1));
  }
}

/** A café umbrella over a little round table with chairs. */
function bistro(b: GeoBuilder, r: () => number, x: number, z: number, y: number, canopy: ColorLike, umbrella = true) {
  b.cylinder(0.035, 0.035, 0.006, x, y + 0.045, z, 0xf4f1ea, 10);
  b.cylinder(0.004, 0.006, 0.045, x, y, z, STEEL_DARK, 4);
  for (let k = 0; k < 2; k++) {
    const a = r() * 6 + k * Math.PI;
    b.box(0.022, 0.03, 0.022, x + Math.cos(a) * 0.05, y, z + Math.sin(a) * 0.05, STEEL_DARK);
  }
  if (umbrella) {
    b.cylinder(0.003, 0.003, 0.14, x, y, z, 0xe8e2d6, 4);
    b.cylinder(0, 0.08, 0.035, x, y + 0.13, z, canopy, 8);
  }
}

// ─── Items on plots ────────────────────────────────────────────────────────

export function itemModel(model: string, x: number, z: number, seed: number): Built {
  const r = rng(seed);
  const b = new Kit();
  const neon = bright(pick(r, NEON), 2.4);
  switch (model) {
    case 'shops':
      shops(b, r, x, z);
      break;
    case 'coworking':
      coworking(b, r, x, z, neon);
      break;
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
      pad(b, x, z, 1.9);
      pyramid(b, r, x, z);
      break;
    case 'venture':
      venture(b, r, x, z, neon);
      break;
    case 'spire':
      spire(b, r, x, z, neon);
      break;
    case 'park':
      park(b, r, x, z);
      break;
    case 'garden':
      garden(b, r, x, z);
      break;
    case 'courts':
      courts(b, r, x, z);
      break;
    case 'library':
      library(b, r, x, z);
      break;
    case 'stadium':
      stadium(b, r, x, z);
      break;
    case 'university':
      university(b, r, x, z);
      break;
    case 'research':
      research(b, r, x, z);
      break;
    case 'foodtrucks':
      foodtrucks(b, r, x, z);
      break;
    case 'cafe':
      cafe(b, r, x, z);
      break;
    case 'deco':
      pad(b, x, z, 1.9);
      deco(b, r, x, z, neon);
      break;
    case 'amusement':
      amusement(b, r, x, z);
      break;
    case 'arena':
      arena(b, r, x, z, neon);
      break;
    default:
      pad(b, x, z, 1.9);
  }
  return b.build();
}

// ─── Business ──────────────────────────────────────────────────────────────

const SHOP_NAMES = ['DELI', 'BOOKS', 'PHO', 'TACOS', 'FLOWERS', 'COFFEE', 'RECORDS', 'BAKERY', 'NOODLES', 'BIKES', 'WINE', 'DIM SUM', 'PIZZA', 'VINTAGE', 'BAGELS', 'RAMEN'] as const;
const AWNINGS = [0xe85a4a, 0x2f8fb8, 0x3aa36a, 0xf2a03a, 0x8a3a6a, 0x2a4a7a] as const;

/** One mixed-use corner building: a shop below, flats above with a bay window. */
function shopBuilding(b: GeoBuilder, r: () => number, x: number, z: number, w: number, d: number, storeys: number, fronts: [number, number][], name: string) {
  const wallC = pick(r, [...PALETTE.victorian, ...PALETTE.walls]);
  const trim = PALETTE.trim;
  const gh = 0.24;
  const fh = 0.19;
  const h = gh + (storeys - 1) * fh;
  b.box(w, h, d, x, 0.035, z, wallC);
  const awn = pick(r, AWNINGS);
  const light = warmth(r);
  const signColor = bright(pick(r, NEON), 2.2);
  fronts.forEach(([nx, nz], i) => {
    const span = Math.abs(nz) > 0.5 ? w : d;
    const fx = x + (nx * w) / 2;
    const fz = z + (nz * d) / 2;
    // Storefront: dark frame, big glass, a door
    wall(b, 'solid', fx + nx * 0.003, 0.035 + 0.11, fz + nz * 0.003, nx, nz, span - 0.06, 0.19, 0x2a2f38);
    wall(winOf(b), 'glow', fx + nx * 0.006 - nz * 0.04, 0.035 + 0.11, fz + nz * 0.006 + nx * 0.04, nx, nz, span - 0.2, 0.15, light, wr(r, 0.95, TINT.shop));
    wall(b, 'solid', fx + nx * 0.006 + nz * (span / 2 - 0.08), 0.035 + 0.095, fz + nz * 0.006 - nx * (span / 2 - 0.08), nx, nz, 0.06, 0.15, 0x6b4a3a);
    // Window display: little colourful things on a sill
    for (let k = 0; k < 4; k++) {
      const u = -span / 2 + 0.1 + k * 0.06;
      b.box(0.03, 0.02 + r() * 0.03, 0.012, fx + nx * 0.012 - nz * u, 0.06, fz + nz * 0.012 + nx * u, pick(r, [0xe85a4a, 0xf2c84b, 0x3aa36a, 0x7a5ac8, 0xf4f1ea] as const), false, Math.atan2(nx, nz));
    }
    awning(b, fx, 0.035 + gh - 0.025, fz, nx, nz, span - 0.08, 0.12, awn);
    // Sign band with the shop's name
    wall(b, 'solid', fx + nx * 0.004, 0.035 + gh - 0.0, fz + nz * 0.004, nx, nz, span - 0.04, 0.05, i === 0 ? 0x23262e : shade(awn, 0.6));
    const px = Math.min(0.011, (span - 0.1) / (name.length * 4));
    pixelText(neonOf(b), 'glow', name, fx + nx * 0.008, 0.035 + gh, fz + nz * 0.008, nx, nz, px, signColor);
    // Upper floors: a bay window and a sash window per floor
    if (storeys > 1) {
      bayWindow(b, r, fx - nz * span * 0.18, 0.035 + gh + 0.02, fz + nx * span * 0.18, nx, nz, span * 0.42, 0.06, fh, storeys - 1, wallC, trim, warmth(r));
      for (let f = 0; f < storeys - 1; f++) punch(b, r, fx + nz * span * 0.26, 0.035 + gh + f * fh + fh * 0.55, fz - nx * span * 0.26, nx, nz, 0.07, 0.11, trim, warmth(r), TINT.sky);
    }
    cornice(b, fx, 0.035 + h, fz, nx, nz, span, trim);
    // Sidewalk life: an A-frame board, a planter, flower buckets
    const sx = fx + nx * 0.2 + nz * span * 0.3;
    const sz = fz + nz * 0.2 - nx * span * 0.3;
    b.box(0.04, 0.06, 0.008, sx, 0.035, sz, 0x2a2f38, false, Math.atan2(nx, nz) + 0.2);
    for (let k = 0; k < 3; k++) {
      const bx = fx + nx * 0.1 - nz * (span * 0.1 - k * 0.04);
      const bz = fz + nz * 0.1 + nx * (span * 0.1 - k * 0.04);
      b.cylinder(0.014, 0.012, 0.03, bx, 0.035, bz, 0x5a6a7a, 6);
      b.blob(0.018, bx, 0.075, bz, pick(r, [0xe86a9a, 0xf2c84b, 0xf4f1ea, 0xe85a4a] as const), 'smooth');
    }
  });
  // Roof: a parapet, a vent, maybe a little garden
  b.box(w - 0.06, 0.012, d - 0.06, x, 0.035 + h, z, 0x8e8a84);
  b.box(0.08, 0.06, 0.08, x - w * 0.25, 0.035 + h, z - d * 0.25, 0x9aa3ad);
  if (r() < 0.6) planter(b, r, x + w * 0.15, z - d * 0.2, 0.14, 0.1, 0.035 + h, PALETTE.wood);
}

/** Corner shops: four little mixed-use buildings around a corner. */
function shops(b: GeoBuilder, r: () => number, x: number, z: number) {
  pad(b, x, z, 1.9);
  b.box(1.9, 0.004, 0.26, x, 0.035, z + 0.82, 0xd6cfbf);
  b.box(0.26, 0.004, 1.9, x + 0.82, 0.035, z, 0xd6cfbf);
  const names = [...SHOP_NAMES].sort(() => r() - 0.5);
  shopBuilding(b, r, x + 0.36, z + 0.36, 0.6, 0.6, 2, [[0, 1], [1, 0]], names[0]!);
  shopBuilding(b, r, x - 0.3, z + 0.36, 0.56, 0.6, 3, [[0, 1]], names[1]!);
  shopBuilding(b, r, x - 0.76, z + 0.36, 0.34, 0.6, 2, [[0, 1], [-1, 0]], names[2]!);
  shopBuilding(b, r, x + 0.36, z - 0.32, 0.6, 0.56, 3, [[1, 0]], names[3]!);
  shopBuilding(b, r, x + 0.36, z - 0.78, 0.6, 0.32, 2, [[1, 0], [0, -1]], names[4]!);
  // Back courtyard: a tree, bins, a bench
  b.box(0.95, 0.006, 0.95, x - 0.45, 0.035, z - 0.45, 0xb9b2a4);
  tree(b, r, x - 0.45, z - 0.45, 0.7, 0.04, 'round');
  for (let k = 0; k < 3; k++) b.box(0.04, 0.06, 0.04, x - 0.85 + k * 0.05, 0.035, z - 0.85, [0x2f8a4a, 0x2f6fa8, 0x2a2f38][k]!);
  bench(b, x - 0.2, z - 0.6, 0, 0.04);
  people(b, r, x + 0.3, z + 0.82, 5, 1.2, 0.12, 0.035);
  people(b, r, x + 0.82, z - 0.1, 3, 0.12, 1.0, 0.035);
  lamp(b, x + 0.9, z + 0.9, 0.035);
  tree(b, r, x - 0.55, z + 0.88, 0.5, 0.035, 'round');
}

/** SoMa brick warehouse turned co-working: steel windows, a ghost sign, a roof deck. */
function coworking(b: GeoBuilder, r: () => number, x: number, z: number, neon: ColorLike) {
  pad(b, x, z, 1.9);
  const brick = pick(r, BRICK);
  const trim = 0xd8cdb8;
  const cx = x - 0.1;
  const cz = z - 0.15;
  const W = 1.5;
  const D = 1.15;
  const fh = 0.27;
  const floors = 3;
  const H = fh * floors;
  const y0 = 0.035;
  b.box(W, 0.06, D, cx, y0, cz, trim); // stone base
  b.box(W, H - 0.06, D, cx, y0 + 0.06, cz, brick);
  const light = warmth(r);
  const faces: [number, number, number, number][] = [[0, 1, W, D], [1, 0, D, W], [0, -1, W, D], [-1, 0, D, W]];
  for (const [nx, nz, span, depth] of faces) {
    const fx = cx + (nx * depth) / 2;
    const fz = cz + (nz * depth) / 2;
    const bays = Math.round(span / 0.3);
    for (let k = 0; k < bays; k++) {
      const u = ((k + 0.5) / bays - 0.5) * span;
      const px = fx + nz * u;
      const pz = fz - nx * u;
      // Brick pilasters between bays
      const pu = (k / bays - 0.5) * span;
      b.box(Math.abs(nz) > 0.5 ? 0.04 : 0.02, H, Math.abs(nz) > 0.5 ? 0.02 : 0.04, fx + nz * pu + nx * 0.01, y0, fz - nx * pu + nz * 0.01, shade(brick, 0.88));
      for (let f = 0; f < floors; f++) {
        const wy = y0 + f * fh + fh * 0.52;
        if (f === 0 && nz === 1 && k === Math.floor(bays / 2)) continue; // the entrance
        steelWindow(b, r, px, wy, pz, nx, nz, 0.21, 0.17, light, 0.75, 3, 3);
        b.box(Math.abs(nz) > 0.5 ? 0.24 : 0.02, 0.025, Math.abs(nz) > 0.5 ? 0.02 : 0.24, px + nx * 0.008, wy + 0.1, pz + nz * 0.008, shade(brick, 0.75)); // lintel
      }
    }
    b.box(Math.abs(nz) > 0.5 ? span + 0.04 : 0.04, 0.03, Math.abs(nz) > 0.5 ? 0.04 : span + 0.04, fx, y0 + H, fz, trim);
    for (let f = 1; f < floors; f++) b.box(Math.abs(nz) > 0.5 ? span + 0.01 : 0.015, 0.012, Math.abs(nz) > 0.5 ? 0.015 : span + 0.01, fx, y0 + f * fh, fz, shade(brick, 0.8));
  }
  // Entrance with a steel canopy and a neon sign
  const ez = cz + D / 2;
  wall(winOf(b), 'glow', cx, y0 + 0.12, ez + 0.005, 0, 1, 0.2, 0.2, light, wr(r, 1, TINT.shop));
  b.box(0.36, 0.015, 0.16, cx, y0 + 0.24, ez + 0.08, STEEL_DARK);
  for (const s of [-1, 1]) rod(b, cx + s * 0.16, y0 + 0.25, ez + 0.005, cx + s * 0.16, y0 + 0.33, ez + 0.14, 0.004, STEEL_DARK, 3);
  b.box(0.42, 0.06, 0.012, cx, y0 + 0.255, ez + 0.006, 0x1c1f26);
  pixelText(neonOf(b), 'glow', 'COWORK', cx, y0 + 0.288, ez + 0.014, 0, 1, 0.011, neon);
  // Ghost sign on the side wall, faded paint
  const gx = cx + W / 2 + 0.004;
  wall(b, 'solid', gx, y0 + H - 0.16, cz, 1, 0, 0.9, 0.18, shade(brick, 0.82));
  pixelText(b, 'solid', 'PACIFIC', gx + 0.002, y0 + H - 0.12, cz, 1, 0, 0.016, 0xe9dcc0);
  pixelText(b, 'solid', 'COFFEE CO', gx + 0.002, y0 + H - 0.2, cz, 1, 0, 0.012, 0xd8c8a8);
  // Roof: sawtooth skylights on half, a deck with umbrellas and lights on the rest, a water tower
  const ry = y0 + H + 0.03;
  for (let k = 0; k < 3; k++) {
    const sx = cx - W / 2 + 0.2 + k * 0.22;
    profile(b, [[-0.1, 0], [0.1, 0], [0.1, 0.14], [-0.1, 0]], D - 0.2, sx, ry, cz, Math.PI / 2, 0xd9d2c4);
    wall(winOf(b), 'glow', sx + 0.104, ry + 0.07, cz, 1, 0, D - 0.22, 0.12, PALETTE.windowCool, wr(r, 0.9, TINT.sky));
  }
  b.box(0.7, 0.02, 0.8, cx + 0.32, ry, cz, PALETTE.wood);
  for (const [dx, dz] of [[0.15, -0.2], [0.45, 0.15]] as const) bistro(b, r, cx + dx, cz + dz, ry + 0.02, pick(r, [0xe85a4a, 0xf2c84b, 0x2f8a6a] as const));
  for (let k = 0; k < 2; k++) planter(b, r, cx + 0.62, cz - 0.3 + k * 0.4, 0.06, 0.25, ry + 0.02, PALETTE.wood);
  rod(b, cx + 0.0, ry, cz - 0.38, cx + 0.0, ry + 0.2, cz - 0.38, 0.005, STEEL_DARK, 3);
  rod(b, cx + 0.64, ry, cz + 0.38, cx + 0.64, ry + 0.2, cz + 0.38, 0.005, STEEL_DARK, 3);
  bulbs(b, cx, ry + 0.2, cz - 0.38, cx + 0.64, ry + 0.2, cz + 0.38, 10, 0.04);
  waterTower(b, cx - 0.5, ry, cz - 0.3, 0.6);
  // Street: bikes, a café table or two, a planter with a tree
  for (let k = 0; k < 4; k++) bike(b, r, x + 0.55 + k * 0.08, z + 0.72, Math.PI / 2);
  bistro(b, r, x - 0.6, z + 0.72, 0.035, 0x2f8a6a);
  bistro(b, r, x - 0.3, z + 0.75, 0.035, 0x2f8a6a);
  tree(b, r, x + 0.82, z - 0.3, 0.6, 0.035, 'round');
  people(b, r, x - 0.1, z + 0.75, 4, 1.0, 0.15, 0.035);
  lamp(b, x + 0.86, z + 0.86, 0.035);
}

/** A wooden water tank on steel legs, like on every old SoMa roof. */
function waterTower(b: GeoBuilder, x: number, y: number, z: number, s = 1) {
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) b.box(0.012 * s, 0.16 * s, 0.012 * s, x + dx * 0.07 * s, y, z + dz * 0.07 * s, STEEL_DARK);
  b.box(0.18 * s, 0.01 * s, 0.18 * s, x, y + 0.16 * s, z, STEEL_DARK);
  b.cylinder(0.1 * s, 0.1 * s, 0.18 * s, x, y + 0.17 * s, z, 0x8a6446, 10);
  for (let k = 0; k < 3; k++) b.cylinder(0.103 * s, 0.103 * s, 0.006 * s, x, y + (0.2 + k * 0.05) * s, z, STEEL_DARK, 10);
  b.cylinder(0.005, 0.11 * s, 0.08 * s, x, y + 0.35 * s, z, 0x6a4a34, 10);
}

/** A little bicycle, side-on along (cos rot, -sin rot). */
function bike(b: GeoBuilder, r: () => number, x: number, z: number, rot: number, y = 0.035) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  for (const k of [-1, 1]) put(b, new THREE.TorusGeometry(0.022, 0.003, 3, 10), x + c * k * 0.032, y + 0.024, z - s * k * 0.032, 0x1e2026, 'solid', rot);
  b.box(0.065, 0.005, 0.005, x, y + 0.035, z, pick(r, [0xe85a4a, 0x2f6fa8, 0xf2c84b, 0x3aa36a, 0xf4f1ea] as const), false, rot);
  b.box(0.005, 0.03, 0.005, x - c * 0.01, y + 0.025, z + s * 0.01, STEEL_DARK, false, rot);
}

/** Venture studio: cantilevered glass and timber boxes, a roof terrace, a rocket on the plaza. */
function venture(b: GeoBuilder, r: () => number, x: number, z: number, neon: ColorLike) {
  pad(b, x, z, 1.9);
  const light = warmth(r);
  const wood = 0xb9824f;
  const white = 0xf2f0ea;
  const y0 = 0.035;
  // Lower glass box
  const lo = rectPts(1.3, 0.9, x - 0.2, z - 0.35);
  prism(b, lo, y0, 0.52, 0x8fb0c4, 'glass');
  facade(b, r, lo, y0, null, y0 + 0.52, { floors: 2, bay: 0.16, winH: 0.84, winW: 0.92, lit: 0.85, light, tint: TINT.blue, fins: { color: 0x2a2f38, depth: 0.012, width: 0.01 } });
  prism(b, scalePts(lo, 1.03), y0 + 0.52, 0.035, white);
  // Upper timber box, turned and cantilevered over the plaza
  const up = rectPts(1.15, 0.78, x + 0.08, z - 0.05);
  const uy = y0 + 0.555;
  prism(b, up, uy, 0.5, 0x2a3442);
  facade(b, r, up, uy, null, uy + 0.5, { floors: 2, bay: 0.07, winH: 0.9, winW: 0.55, lit: 0.7, light, tint: TINT.smoke, fins: { color: wood, depth: 0.02, width: 0.02 } });
  prism(b, scalePts(up, 1.03), uy + 0.5, 0.03, white);
  // Steel column under the cantilever corner
  b.box(0.04, 0.555, 0.04, x + 0.6, y0, z + 0.3, white);
  // Neon word on the timber
  b.box(0.5, 0.09, 0.01, x + 0.08, uy + 0.32, z + 0.345, 0x1c1f26);
  pixelText(neonOf(b), 'glow', 'LAUNCH', x + 0.08, uy + 0.32, z + 0.352, 0, 1, 0.016, neon);
  b.box(0.01, 0.09, 0.4, x + 0.66, uy + 0.32, z - 0.05, 0x1c1f26);
  pixelText(neonOf(b), 'glow', 'LAUNCH', x + 0.666, uy + 0.32, z - 0.05, 1, 0, 0.014, neon);
  // Roof terrace
  const ty = uy + 0.53;
  b.box(1.0, 0.015, 0.62, x + 0.08, ty, z - 0.05, PALETTE.wood);
  for (let k = 0; k < 3; k++) planter(b, r, x - 0.35, z - 0.28 + k * 0.22, 0.08, 0.18, ty + 0.015, 0x3a3f4a);
  for (const [dx, dz] of [[0.2, -0.2], [0.45, 0.1]] as const) bistro(b, r, x + dx, z + dz, ty + 0.015, 0xf4f1ea);
  neonRing(b, scalePts(up, 1.03), uy + 0.515, 0.012, neon);
  rooftopUnits(b, x - 0.55, y0 + 0.555, z - 0.55);
  // Plaza: seating steps and a rocket sculpture
  for (let k = 0; k < 3; k++) b.box(0.6 - k * 0.1, 0.03 + k * 0.03, 0.08, x - 0.45, y0, z + 0.25 + k * 0.08, 0xd8d2c4);
  const rx = x + 0.62;
  const rz = z + 0.65;
  b.cylinder(0.1, 0.12, 0.05, rx, y0, rz, 0x3a3f4a, 10);
  b.cylinder(0.04, 0.04, 0.3, rx, y0 + 0.05, rz, 0xd8dde2, 10, 'glass');
  b.lathe([[0.04, 0], [0.036, 0.04], [0.022, 0.09], [0, 0.13]], rx, y0 + 0.35, rz, 0xd8dde2, 10, 'glass');
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    b.box(0.012, 0.08, 0.05, rx + Math.cos(a) * 0.045, y0 + 0.06, rz + Math.sin(a) * 0.045, neon, false, -a);
  }
  palm(b, r, x - 0.82, z + 0.8, 0.7, y0);
  people(b, r, x - 0.4, z + 0.55, 6, 0.8, 0.4, y0);
  lamp(b, x + 0.88, z + 0.15, y0);
}

function rooftopUnits(b: GeoBuilder, x: number, y: number, z: number) {
  b.box(0.12, 0.06, 0.1, x, y, z, 0x9aa3ad);
  b.cylinder(0.03, 0.03, 0.008, x, y + 0.06, z, STEEL_DARK, 8);
}

// ─── Civic ─────────────────────────────────────────────────────────────────

/** Pocket park: a lawn, winding paths, a fountain, a playground, trees and lamps. */
function park(b: GeoBuilder, r: () => number, x: number, z: number) {
  pad(b, x, z, 1.9, PALETTE.lawn);
  const path = 0xe8dcc0;
  // Winding gravel paths
  const pts: [number, number][] = [];
  for (let k = 0; k <= 14; k++) {
    const t = k / 14;
    pts.push([x - 0.95 + t * 1.9, z + Math.sin(t * Math.PI * 1.5) * 0.35]);
  }
  for (let k = 0; k < pts.length - 1; k++) {
    const [ax, az] = pts[k]!;
    const [cx, cz] = pts[k + 1]!;
    b.box(Math.hypot(cx - ax, cz - az) + 0.02, 0.006, 0.09, (ax + cx) / 2, 0.035, (az + cz) / 2, path, false, -Math.atan2(cz - az, cx - ax));
  }
  b.box(0.09, 0.006, 0.95, x + 0.05, 0.035, z - 0.47, path);
  // Fountain with jets
  b.cylinder(0.24, 0.27, 0.06, x + 0.05, 0.035, z, 0xcfc8b8, 16);
  b.cylinder(0.21, 0.21, 0.012, x + 0.05, 0.085, z, PALETTE.pool, 16);
  b.cylinder(0.06, 0.08, 0.08, x + 0.05, 0.085, z, 0xe8e2d6, 10);
  b.cylinder(0.012, 0.02, 0.14, x + 0.05, 0.16, z, 0xd8f2fa, 6, 'smooth');
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    quadBlob(neonOf(b), x + 0.05 + Math.cos(a) * 0.16, 0.1, z + Math.sin(a) * 0.16, 0.012, [0.7, 1.5, 2.2], FX.shimmer + k / 6);
    rod(b, x + 0.05 + Math.cos(a) * 0.17, 0.09, z + Math.sin(a) * 0.17, x + 0.05 + Math.cos(a) * 0.1, 0.17, z + Math.sin(a) * 0.1, 0.004, 0xd8f2fa, 3, 'smooth');
  }
  // Playground: a slide, swings, a sandbox
  const px = x + 0.55;
  const pz = z + 0.55;
  b.box(0.5, 0.008, 0.45, px, 0.035, pz, 0xc96a4a);
  b.box(0.18, 0.01, 0.16, px - 0.08, 0.035, pz + 0.08, PALETTE.sand);
  b.box(0.08, 0.14, 0.08, px + 0.12, 0.035, pz - 0.1, 0xf2c84b);
  b.cylinder(0, 0.07, 0.06, px + 0.12, 0.175, pz - 0.1, 0xe85a4a, 4, false, Math.PI / 4);
  put(b, new THREE.BoxGeometry(0.05, 0.008, 0.2), px + 0.12, 0.11, pz + 0.02, 0x3a8fd8, 'solid', 0, -0.62);
  for (const s of [-1, 1]) rod(b, px - 0.2, 0.035, pz - 0.15 + s * 0.08, px - 0.2, 0.2, pz - 0.15, 0.005, 0x3a8fd8, 3);
  for (const s of [-1, 1]) rod(b, px - 0.02, 0.035, pz - 0.15 + s * 0.08, px - 0.02, 0.2, pz - 0.15, 0.005, 0x3a8fd8, 3);
  rod(b, px - 0.2, 0.2, pz - 0.15, px - 0.02, 0.2, pz - 0.15, 0.005, 0x3a8fd8, 3);
  for (const s of [-1, 1]) b.box(0.03, 0.004, 0.02, px - 0.11 + s * 0.04, 0.09, pz - 0.15, 0xe85a4a);
  // Trees, benches, lamps, a picnic blanket, people and a dog
  for (const [dx, dz, k] of [[-0.7, -0.65, 'round'], [-0.25, -0.75, 'cypress'], [0.6, -0.6, 'round'], [-0.75, 0.65, 'round'], [-0.3, 0.75, 'palm'], [0.82, -0.05, 'palm'], [-0.85, -0.05, 'round']] as const) {
    tree(b, r, x + dx, z + dz, 0.75, 0.035, k);
  }
  for (const [dx, dz, a] of [[0.05, 0.3, 0], [-0.35, -0.25, 0], [0.4, -0.2, Math.PI / 2]] as const) bench(b, x + dx, z + dz, a, 0.035);
  for (const [dx, dz] of [[-0.5, 0.15], [0.35, 0.28], [-0.05, -0.5]] as const) lamp(b, x + dx, z + dz, 0.035, 0.28);
  b.box(0.16, 0.004, 0.12, x - 0.45, 0.036, z + 0.45, 0xe85a4a, false, 0.3);
  b.box(0.02, 0.012, 0.02, x - 0.43, 0.04, z + 0.44, 0xa86a3a);
  people(b, r, x - 0.1, z + 0.1, 6, 1.4, 1.2, 0.035);
  b.box(0.035, 0.018, 0.012, x + 0.25, 0.045, z - 0.35, 0xb08a5a);
  b.blob(0.01, x + 0.27, 0.066, z - 0.35, 0xb08a5a, 'smooth');
  for (let k = 0; k < 6; k++) bush(b, r, x - 0.9 + k * 0.08, 0.06, z - 0.92, 0.04);
}

/** Community garden: raised beds, a greenhouse, a shed, sunflowers. */
function garden(b: GeoBuilder, r: () => number, x: number, z: number) {
  pad(b, x, z, 1.9, 0x9a8a62);
  b.box(1.8, 0.004, 1.8, x, 0.035, z, 0xb8a47a);
  // Picket fence
  const post = 0xf4f1ea;
  for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const fx = x + nx * 0.92;
    const fz = z + nz * 0.92;
    const along = Math.abs(nz) > 0.5;
    b.box(along ? 1.84 : 0.012, 0.012, along ? 0.012 : 1.84, fx, 0.09, fz, post);
    for (let k = 0; k <= 22; k++) {
      if (nz === 1 && k >= 10 && k <= 12) continue; // the gate
      const u = (k / 22 - 0.5) * 1.84;
      b.box(0.014, 0.1, 0.008, fx + (along ? u : 0), 0.035, fz + (along ? 0 : u), post);
    }
  }
  // Raised beds with different crops
  const crops = ['lettuce', 'tomato', 'sunflower', 'pumpkin', 'kale', 'flowers'] as const;
  let c = 0;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 2; j++) {
      const bx = x - 0.55 + i * 0.42;
      const bz = z + 0.18 + j * 0.42;
      b.box(0.34, 0.07, 0.26, bx, 0.035, bz, PALETTE.wood);
      b.box(0.3, 0.012, 0.22, bx, 0.095, bz, 0x5a3e28);
      const crop = crops[c++ % crops.length]!;
      for (let k = 0; k < 6; k++) {
        const px = bx - 0.1 + (k % 3) * 0.1;
        const pz = bz - 0.05 + Math.floor(k / 3) * 0.1;
        if (crop === 'lettuce' || crop === 'kale') b.blob(0.03, px, 0.12, pz, crop === 'kale' ? 0x3f7a4a : 0x8fd05a, 'smooth');
        else if (crop === 'tomato') {
          rod(b, px, 0.1, pz, px, 0.22, pz, 0.004, PALETTE.wood, 3);
          b.blob(0.028, px, 0.16, pz, 0x4f9d3b, 'smooth');
          b.blob(0.012, px + 0.02, 0.15, pz + 0.01, 0xe0402e, 'smooth');
        } else if (crop === 'sunflower') {
          rod(b, px, 0.1, pz, px, 0.32, pz, 0.005, 0x5a9a3a, 3);
          b.cylinder(0.03, 0.03, 0.008, px, 0.32, pz + 0.01, 0xf2c23a, 10, false);
          b.cylinder(0.014, 0.014, 0.01, px, 0.322, pz + 0.01, 0x6a4020, 8);
        } else if (crop === 'pumpkin') {
          b.blob(0.03, px, 0.12, pz, 0x4f9d3b, 'smooth');
          b.blob(0.022, px + 0.02, 0.12, pz - 0.02, 0xe8822a, 'smooth', 1);
        } else b.blob(0.02, px, 0.115, pz, pick(r, [0xe86a9a, 0xf2c84b, 0xb07ad8, 0xf4f1ea] as const), 'smooth');
      }
    }
  }
  // Greenhouse: a glass house with white ribs, plants inside
  const gx = x - 0.35;
  const gz = z - 0.55;
  b.box(0.75, 0.3, 0.45, gx, 0.035, gz, 0xbfe0e6, 'glass');
  b.gable(0.75, 0.16, 0.45, gx, 0.335, gz, 0xbfe0e6, 0.0);
  for (let k = 0; k <= 6; k++) {
    const u = gx - 0.375 + k * 0.125;
    b.box(0.01, 0.3, 0.46, u, 0.035, gz, 0xf4f4f0);
    rod(b, u, 0.335, gz - 0.23, u, 0.495, gz, 0.005, 0xf4f4f0, 3);
    rod(b, u, 0.335, gz + 0.23, u, 0.495, gz, 0.005, 0xf4f4f0, 3);
  }
  wall(winOf(b), 'glow', gx, 0.18, gz + 0.228, 0, 1, 0.7, 0.22, [1.2, 1.5, 0.9], wr(r, 0.3, TINT.green));
  // Tool shed, water tank, compost bins, wheelbarrow
  b.box(0.3, 0.26, 0.24, x + 0.55, 0.035, z - 0.6, 0xc0503a);
  b.gable(0.3, 0.1, 0.24, x + 0.55, 0.295, z - 0.6, 0x5f6c7c, 0.03);
  b.box(0.08, 0.17, 0.008, x + 0.55, 0.035, z - 0.475, 0xf4f1ea);
  b.cylinder(0.07, 0.07, 0.18, x + 0.82, 0.035, z - 0.75, 0x2f6fa8, 10);
  for (let k = 0; k < 2; k++) b.box(0.14, 0.12, 0.14, x + 0.78, 0.035, z - 0.3 + k * 0.16, 0x6a5a3a);
  b.box(0.1, 0.04, 0.07, x + 0.25, 0.06, z - 0.15, 0x3aa36a, false, 0.4);
  // Hand-painted sign at the gate
  b.box(0.3, 0.1, 0.012, x, 0.16, z + 0.93, 0xf4ecd8);
  for (const s of [-1, 1]) b.box(0.012, 0.18, 0.012, x + s * 0.13, 0.035, z + 0.93, PALETTE.wood);
  pixelText(b, 'solid', 'GARDEN', x, 0.21, z + 0.937, 0, 1, 0.009, 0x3a7a3a);
  bulbs(b, x - 0.9, 0.3, z + 0.92, x + 0.9, 0.3, z + 0.92, 14, 0.06);
  people(b, r, x - 0.15, z + 0.35, 4, 1.0, 0.6, 0.035);
}

/** Basketball courts with floodlights, bleachers and a chain-link fence. */
function courts(b: GeoBuilder, r: () => number, x: number, z: number) {
  pad(b, x, z, 1.9, 0x4c8c6a);
  const cz = z - 0.15;
  const L = 1.62;
  const Wc = 0.92;
  b.box(L + 0.1, 0.006, Wc + 0.1, x, 0.035, cz, 0x3f6fa8);
  b.box(L, 0.004, Wc, x, 0.041, cz, 0x2f5a96);
  const line = 0xf4f1ea;
  const y = 0.046;
  // Boundary, half-court line and circle
  for (const s of [-1, 1]) {
    flat(b, 'solid', x, y, cz + (s * Wc) / 2, L, 0.01, line);
    flat(b, 'solid', x + (s * L) / 2, y, cz, 0.01, Wc, line);
  }
  flat(b, 'solid', x, y, cz, 0.01, Wc, line);
  arcLine(b, x, y, cz, 0.11, 0, Math.PI * 2, 0.01, line, 16);
  for (const s of [-1, 1]) {
    // Key (painted) and free-throw circle, three-point arc
    flat(b, 'solid', x + s * (L / 2 - 0.12), y - 0.001, cz, 0.24, 0.3, 0xd8743a);
    arcLine(b, x + s * (L / 2 - 0.24), y, cz, 0.1, s > 0 ? Math.PI / 2 : -Math.PI / 2, s > 0 ? Math.PI * 1.5 : Math.PI / 2, 0.01, line, 10);
    arcLine(b, x + s * (L / 2 - 0.05), y, cz, 0.4, s > 0 ? Math.PI * 0.58 : -Math.PI * 0.42, s > 0 ? Math.PI * 1.42 : Math.PI * 0.42, 0.01, line, 16);
    // Hoop: pole, arm, backboard, rim, net
    const hx = x + s * (L / 2 + 0.06);
    b.box(0.025, 0.36, 0.025, hx, 0.035, cz, 0x2a2f38);
    b.box(0.08, 0.02, 0.02, hx - s * 0.04, 0.37, cz, 0x2a2f38);
    b.box(0.01, 0.1, 0.18, hx - s * 0.08, 0.34, cz, 0xf4f4f0);
    b.box(0.011, 0.04, 0.06, hx - s * 0.08, 0.34, cz, 0xd8402e);
    put(b, new THREE.TorusGeometry(0.025, 0.004, 4, 12), hx - s * 0.11, 0.345, cz, 0xe8682a, 'solid', 0, Math.PI / 2);
    b.cylinder(0.025, 0.016, 0.04, hx - s * 0.11, 0.305, cz, 0xf4f1ea, 8);
  }
  // Players and a ball
  figures(b, [[x - 0.3, cz - 0.1], [x - 0.45, cz + 0.12], [x - 0.15, cz + 0.2], [x + 0.2, cz - 0.15], [x - 0.6, cz - 0.05]], 0.046, 0xe85a4a);
  figures(b, [[x - 0.52, cz + 0.02], [x - 0.25, cz - 0.25], [x + 0.05, cz + 0.05]], 0.046, 0x2f6fa8);
  b.blob(0.013, x - 0.58, 0.16, cz + 0.0, 0xe8682a, 'smooth');
  // Chain-link fence: posts and rails
  const fz0 = cz - Wc / 2 - 0.12;
  const fz1 = cz + Wc / 2 + 0.12;
  for (const fx of [x - 0.93, x + 0.93]) {
    for (let k = 0; k <= 6; k++) b.box(0.012, 0.3, 0.012, fx, 0.035, fz0 + ((fz1 - fz0) * k) / 6, 0x8a929c);
    b.box(0.008, 0.008, fz1 - fz0, fx, 0.33, (fz0 + fz1) / 2, 0x8a929c);
    wall(b, 'solid', fx, 0.18, (fz0 + fz1) / 2, fx > x ? 1 : -1, 0, fz1 - fz0, 0.28, 0x9aa3ad);
  }
  for (const fz of [fz0]) {
    for (let k = 0; k <= 8; k++) b.box(0.012, 0.3, 0.012, x - 0.93 + (1.86 * k) / 8, 0.035, fz, 0x8a929c);
    b.box(1.86, 0.008, 0.008, x, 0.33, fz, 0x8a929c);
  }
  // Bleachers along the open side
  for (let k = 0; k < 3; k++) b.box(0.9, 0.03 + k * 0.04, 0.07, x - 0.3, 0.035, z + 0.62 + k * 0.07, 0xb9c2cc);
  people(b, r, x - 0.3, z + 0.72, 6, 0.8, 0.1, 0.12);
  // Floodlights
  for (const [dx, dz] of [[-0.9, fz1 - cz], [0.9, fz1 - cz], [-0.9, fz0 - cz], [0.9, fz0 - cz]] as const) {
    const lx = x + dx;
    const lz = cz + dz;
    rod(b, lx, 0.035, lz, lx, 0.62, lz, 0.008, 0x6a7380, 4);
    b.box(0.08, 0.05, 0.04, lx - Math.sign(dx) * 0.03, 0.6, lz, 0x3a4048);
    wall(neonOf(b), 'glow', lx - Math.sign(dx) * 0.03, 0.625, lz - Math.sign(dz) * 0.021, 0, -Math.sign(dz), 0.07, 0.04, [3, 3, 2.7]);
  }
  // Water fountain, bench, a palm
  b.box(0.04, 0.06, 0.04, x + 0.75, 0.035, z + 0.72, 0x8a929c);
  bench(b, x + 0.5, z + 0.75, 0, 0.035);
  palm(b, r, x + 0.85, z + 0.85, 0.65, 0.035);
}

/** Beaux-arts public library: columns, a pediment, a copper dome, lions on the steps. */
function library(b: GeoBuilder, r: () => number, x: number, z: number) {
  pad(b, x, z, 1.9, PALETTE.lawn);
  const stone = 0xebe4d4;
  const shadeStone = 0xd6cdb8;
  const copper = 0x6fae98;
  const cz = z - 0.28;
  const W = 1.5;
  const D = 0.82;
  const y0 = 0.035;
  const base = 0.12;
  const H = 0.62;
  const light = warmth(r);
  // Podium and the grand stairs
  b.box(W + 0.1, base, D + 0.1, x, y0, cz, shadeStone);
  for (let k = 0; k < 5; k++) b.box(0.7 - k * 0.02, base - k * 0.024, 0.05, x, y0, cz + D / 2 + 0.05 + (4 - k) * 0.05 + 0.025, stone);
  // Body
  b.box(W, H, D, x, y0 + base, cz, stone);
  b.box(W + 0.03, 0.05, D + 0.03, x, y0 + base + H, cz, shadeStone);
  b.box(W + 0.06, 0.025, D + 0.06, x, y0 + base + H + 0.05, cz, stone);
  // Rusticated ground course lines
  for (let k = 1; k < 3; k++) b.box(W + 0.006, 0.006, D + 0.006, x, y0 + base + k * 0.07, cz, shadeStone);
  // Tall arched windows on the wings and sides
  for (const [nx, nz, span] of [[0, 1, W], [1, 0, D], [-1, 0, D], [0, -1, W]] as const) {
    const n = Math.abs(nz) > 0.5 ? 6 : 3;
    for (let k = 0; k < n; k++) {
      const u = ((k + 0.5) / n - 0.5) * span;
      if (nz === 1 && Math.abs(u) < 0.36) continue;
      const fx = x + (nx * W) / 2 + nz * u;
      const fz = cz + (nz * D) / 2 - nx * u;
      wall(b, 'solid', fx + nx * 0.003, y0 + base + 0.34, fz + nz * 0.003, nx, nz, 0.11, 0.34, shadeStone);
      wall(winOf(b), 'glow', fx + nx * 0.006, y0 + base + 0.32, fz + nz * 0.006, nx, nz, 0.08, 0.26, light, wr(r, 0.85, TINT.teal));
      put(b, new THREE.CylinderGeometry(0.04, 0.04, 0.01, 8, 1, false, 0, Math.PI), fx + nx * 0.006, y0 + base + 0.45, fz + nz * 0.006, shadeStone, 'solid', Math.atan2(nx, nz) - Math.PI / 2, Math.PI / 2);
    }
  }
  // Portico: six columns, entablature with the inscription, pediment
  const pz = cz + D / 2 + 0.12;
  b.box(0.76, 0.012, 0.26, x, y0 + base, cz + D / 2 + 0.11, stone);
  for (let k = 0; k < 6; k++) {
    const px = x - 0.32 + k * 0.128;
    b.box(0.06, 0.03, 0.06, px, y0 + base, pz, stone);
    b.lathe([[0.024, 0], [0.022, 0.2], [0.02, 0.4], [0.03, 0.42], [0.036, 0.45]], px, y0 + base + 0.03, pz, stone, 10, 'smooth');
  }
  b.box(0.8, 0.09, 0.28, x, y0 + base + 0.48, cz + D / 2 + 0.11, stone);
  pixelText(b, 'solid', 'PUBLIC LIBRARY', x, y0 + base + 0.525, cz + D / 2 + 0.252, 0, 1, 0.0095, 0x5a5448);
  b.gable(0.84, 0.16, 0.3, x, y0 + base + 0.57, cz + D / 2 + 0.11, stone, 0.01);
  wall(winOf(b), 'glow', x, y0 + base + 0.2, cz + D / 2 + 0.004, 0, 1, 0.5, 0.36, light, wr(r, 1, TINT.shop));
  for (let k = 0; k < 3; k++) wall(b, 'solid', x - 0.18 + k * 0.18, y0 + base + 0.12, cz + D / 2 + 0.007, 0, 1, 0.08, 0.18, 0x5a3a2a);
  // Dome on a drum, with a lantern
  const dy = y0 + base + H + 0.075;
  b.cylinder(0.3, 0.32, 0.08, x, dy, cz, shadeStone, 16);
  b.cylinder(0.26, 0.26, 0.16, x, dy + 0.08, cz, stone, 16);
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    wall(winOf(b), 'glow', x + Math.cos(a) * 0.264, dy + 0.16, cz + Math.sin(a) * 0.264, Math.cos(a), Math.sin(a), 0.06, 0.1, light, wr(r, 0.9, TINT.teal));
    b.box(0.02, 0.16, 0.02, x + Math.cos(a + 0.26) * 0.27, dy + 0.08, cz + Math.sin(a + 0.26) * 0.27, shadeStone, false, -a);
  }
  b.cylinder(0.28, 0.28, 0.025, x, dy + 0.24, cz, shadeStone, 16);
  put(b, new THREE.SphereGeometry(0.26, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), x, dy + 0.265, cz, copper, 'smooth', 0, 0, 0, 1, 0.9, 1);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    put(b, new THREE.TorusGeometry(0.255, 0.006, 3, 16, Math.PI / 2), x, dy + 0.265, cz, shade(copper, 0.8), 'solid', a, 0, 0, 1, 0.9, 1);
  }
  b.cylinder(0.04, 0.05, 0.08, x, dy + 0.49, cz, stone, 8);
  quadBlob(neonOf(b), x, dy + 0.53, cz, 0.022, [2.6, 2.0, 1.1], FX.steady);
  b.cylinder(0, 0.05, 0.06, x, dy + 0.57, cz, copper, 8);
  // Lions on plinths, globe lamps
  for (const s of [-1, 1]) {
    const lx = x + s * 0.43;
    const lz = cz + D / 2 + 0.22;
    b.box(0.1, 0.08, 0.16, lx, y0, lz, shadeStone);
    b.box(0.05, 0.035, 0.11, lx, y0 + 0.08, lz, 0xc9bfa8);
    b.blob(0.03, lx, y0 + 0.14, lz + 0.05, 0xc9bfa8, 'smooth', 1);
    lamp(b, x + s * 0.35, z + 0.45, y0, 0.26);
  }
  // Reading lawn: trees, benches, readers
  for (const [dx, dz] of [[-0.75, 0.55], [0.75, 0.55], [-0.75, -0.8], [0.75, -0.8]] as const) tree(b, r, x + dx, z + dz, 0.8, y0, 'round');
  b.box(0.16, 0.006, 0.9, x, y0, z + 0.55, 0xe8dcc0);
  for (const s of [-1, 1]) bench(b, x + s * 0.2, z + 0.6, Math.PI / 2, y0);
  people(b, r, x, z + 0.55, 6, 1.4, 0.5, y0);
  b.box(0.06, 0.08, 0.05, x + 0.55, y0, z + 0.25, 0x2f6fa8);
}

/** Research institute: lab block with fins, two observatory domes, a dish, a glowing ring. */
function research(b: GeoBuilder, r: () => number, x: number, z: number) {
  pad(b, x, z, 1.9);
  b.box(1.2, 0.01, 0.7, x + 0.25, 0.035, z + 0.5, PALETTE.lawn);
  const white = 0xf4f3ef;
  const light = PALETTE.windowCool;
  // Lab block with vertical fins
  const lab = rectPts(1.7, 0.56, x, z - 0.6);
  prism(b, lab, 0.035, 0.46, 0x3a4656);
  facade(b, r, lab, 0.035, null, 0.495, { floors: 2, bay: 0.09, winH: 0.84, winW: 0.62, lit: 0.85, light, tint: TINT.blue, fins: { color: white, depth: 0.04, width: 0.016 } });
  prism(b, scalePts(lab, 1.02), 0.495, 0.035, white);
  for (let k = 0; k < 5; k++) put(b, new THREE.BoxGeometry(0.22, 0.01, 0.14), x - 0.55 + k * 0.27, 0.56, z - 0.6, 0x23345a, 'glass', 0, -0.3);
  b.box(0.18, 0.08, 0.14, x + 0.7, 0.53, z - 0.7, 0x9aa3ad);
  // Observatory domes with open slits
  for (const [dx, dz, rr, rot] of [[-0.45, 0.12, 0.34, 0.5], [0.35, -0.02, 0.24, -0.9]] as const) {
    const ox = x + dx;
    const oz = z + dz;
    b.cylinder(rr, rr + 0.02, 0.2, ox, 0.035, oz, white, 20);
    b.cylinder(rr + 0.01, rr + 0.01, 0.02, ox, 0.235, oz, 0xc9ced6, 20);
    put(b, new THREE.SphereGeometry(rr, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), ox, 0.255, oz, 0xe6edf2, 'smooth');
    // Slit: a dark band over the dome, telescope peeking out
    const g = new THREE.SphereGeometry(rr + 0.004, 4, 8, -0.12, 0.24, 0.05, Math.PI / 2 - 0.15);
    put(b, g, ox, 0.255, oz, 0x1a1e26, 'solid', rot);
    put(b, new THREE.CylinderGeometry(0.03, 0.035, rr * 1.1, 8), ox + Math.sin(rot) * rr * 0.35, 0.255 + rr * 0.55, oz + Math.cos(rot) * rr * 0.35, 0xd8dde2, 'solid', rot, 0.6);
    wall(winOf(b), 'glow', ox, 0.12, oz + rr + 0.025, 0, 1, rr * 0.6, 0.08, light, wr(r, 0.8, TINT.blue));
  }
  // Satellite dish on a pedestal
  const sx = x + 0.75;
  const sz = z + 0.35;
  b.cylinder(0.05, 0.07, 0.25, sx, 0.035, sz, white, 8);
  const dish = new THREE.LatheGeometry([new THREE.Vector2(0.001, 0), new THREE.Vector2(0.08, 0.015), new THREE.Vector2(0.15, 0.05), new THREE.Vector2(0.16, 0.06)], 16);
  put(b, dish, sx, 0.33, sz, 0xf0f2f4, 'smooth', -0.8, -0.8);
  rod(b, sx, 0.33, sz, sx - 0.06, 0.45, sz - 0.06, 0.004, 0x9aa3ad, 3);
  // The ring: a little accelerator on the lawn, glowing cyan
  put(b, new THREE.TorusGeometry(0.22, 0.03, 6, 28), x + 0.25, 0.06, z + 0.55, 0xd8dde2, 'smooth', 0, Math.PI / 2);
  put(neonOf(b), new THREE.TorusGeometry(0.22, 0.012, 4, 28), x + 0.25, 0.09, z + 0.55, [0.4, 2.2, 2.6], 'glow', 0, Math.PI / 2);
  b.box(0.12, 0.08, 0.08, x + 0.25, 0.035, z + 0.33, white);
  people(b, r, x - 0.2, z + 0.65, 5, 0.6, 0.4, 0.035);
  lamp(b, x - 0.85, z + 0.85, 0.035);
  tree(b, r, x - 0.8, z + 0.55, 0.7, 0.035, 'cypress');
  tree(b, r, x + 0.85, z + 0.85, 0.6, 0.035, 'round');
}

/** Ballpark on the bay: brick facade, a seating bowl, the diamond, light towers, the bottle and the glove. */
function stadium(b: GeoBuilder, r: () => number, x: number, z: number) {
  slab(b, x, z, 3.9, 3.9, PALETTE.plaza);
  const hx = x - 1.0;
  const hz = z - 1.0;
  const R = 2.72;
  const y = 0.035;
  const grass = 0x4f9d3b;
  const dirt = 0xc7865a;
  // McCovey Cove beyond right field, with kayaks
  b.box(2.6, 0.01, 0.34, x + 0.6, y, z + 1.76, 0x2a7fc0, 'glass');
  for (let k = 0; k < 5; k++) b.rbox(0.07, 0.015, 0.025, x - 0.4 + k * 0.45 + r() * 0.1, y + 0.01, z + 1.7 + r() * 0.15, pick(r, [0xe85a4a, 0xf2c84b, 0x3aa36a] as const), 0.008, 'smooth', r());
  // Field: foul ground, outfield with mowing arcs, warning track
  prism(b, sectorPts(hx, hz, 0, R + 0.05, -0.2, Math.PI / 2 + 0.2, 20), y, 0.008, grass);
  for (let k = 0; k < 6; k++) {
    const r0 = 1.18 + k * 0.24;
    if (k % 2) prism(b, sectorPts(hx, hz, r0, Math.min(r0 + 0.24, R - 0.1), 0, Math.PI / 2, 16), y + 0.008, 0.002, 0x63b347);
  }
  prism(b, sectorPts(hx, hz, R - 0.1, R, -0.02, Math.PI / 2 + 0.02, 20), y + 0.008, 0.003, dirt);
  // Infield: the dirt arc, the grass diamond, base paths, the mound
  prism(b, sectorPts(hx, hz, 0, 1.15, 0, Math.PI / 2, 12), y + 0.008, 0.003, dirt);
  const bp = 0.72;
  prism(b, [[hx + 0.07, hz + 0.07], [hx + bp - 0.05, hz + 0.07], [hx + bp - 0.05, hz + bp - 0.05], [hx + 0.07, hz + bp - 0.05]], y + 0.011, 0.002, grass);
  b.cylinder(0.07, 0.08, 0.016, hx + 0.36, y + 0.011, hz + 0.36, dirt, 10);
  b.cylinder(0.1, 0.1, 0.003, hx, y + 0.011, hz, dirt, 10);
  for (const [bx, bz] of [[bp, 0], [bp, bp], [0, bp], [0, 0]] as const) b.box(0.03, 0.006, 0.03, hx + bx, y + 0.014, hz + bz, 0xffffff, false, Math.PI / 4);
  // Foul lines and the poles
  flat(b, 'solid', hx + R / 2, y + 0.015, hz, R, 0.012, 0xffffff);
  flat(b, 'solid', hx, y + 0.015, hz + R / 2, 0.012, R, 0xffffff);
  for (const [px, pz] of [[hx + R, hz], [hx, hz + R]] as const) {
    b.box(0.02, 0.5, 0.02, px, y, pz, 0xf2c84b);
    quadBlob(neonOf(b), px, y + 0.5, pz, 0.012, [2.6, 2.2, 0.6]);
  }
  // Players
  figures(b, [[hx + 0.36, hz + 0.36], [hx + 0.72, hz + 0.08], [hx + 0.6, hz + 0.62], [hx + 0.08, hz + 0.72], [hx + 0.58, hz + 0.9], [hx + 1.9, hz + 0.6], [hx + 1.4, hz + 1.4], [hx + 0.6, hz + 1.9], [hx - 0.06, hz - 0.06]], y + 0.012, 0xf4f1ea, 0xf4f1ea);
  figures(b, [[hx + 0.04, hz - 0.03]], y + 0.012, 0x2a2f38);
  // Outfield wall: green in left, brick with arches in right
  const wallSeg = (a0: number, a1: number, h: number, color: ColorLike) => {
    prism(b, sectorPts(hx, hz, R, R + 0.04, a0, a1, Math.max(2, Math.round((a1 - a0) * 12))), y, h, color);
  };
  wallSeg(-0.02, 1.0, 0.1, 0x2f5a3a);
  wallSeg(1.0, Math.PI / 2 + 0.02, 0.26, 0x9a4a36);
  for (let k = 0; k < 8; k++) {
    const a = 1.04 + k * 0.064;
    const px = hx + Math.cos(a) * (R + 0.041);
    const pz = hz + Math.sin(a) * (R + 0.041);
    wall(b, 'solid', px, y + 0.13, pz, Math.cos(a), Math.sin(a), 0.1, 0.14, 0x3a2420);
  }
  // Left-field bleachers, the giant bottle and the old glove
  prism(b, sectorPts(hx, hz, R + 0.06, R + 0.36, -0.02, 0.95, 10), y, 0.12, 0x2f5a3a);
  const bx = x + 1.6;
  const bz = z + 0.12;
  b.lathe([[0.1, 0], [0.11, 0.2], [0.08, 0.35], [0.11, 0.55], [0.1, 0.7], [0.05, 0.85], [0.035, 1.0], [0.04, 1.05], [0, 1.06]], bx, y + 0.12, bz, 0x5a2a1a, 14, 'glass');
  b.cylinder(0.112, 0.112, 0.12, bx, y + 0.36, bz, 0xd8402e, 14);
  put(b, new THREE.TorusGeometry(0.11, 0.012, 4, 14), bx, y + 0.5, bz, 0xf4f1ea, 'solid', 0, Math.PI / 2 - 0.3);
  const gx = x + 1.52;
  const gz = z + 0.72;
  put(b, new THREE.SphereGeometry(0.2, 12, 8), gx, y + 0.32, gz, 0xb07a44, 'smooth', -0.8, 0, 0.3, 1, 1.1, 0.45);
  for (let k = 0; k < 4; k++) put(b, new THREE.CapsuleGeometry(0.035, 0.12, 3, 6), gx - 0.06 + k * 0.045, y + 0.5 + Math.sin(k) * 0.02, gz - 0.02 + k * 0.01, 0xa86e3c, 'smooth', -0.8, 0, 0.25 - k * 0.12);
  b.blob(0.05, gx + 0.05, y + 0.3, gz + 0.06, 0xf4f1ea, 'smooth', 1);
  // Scoreboard in centre field, facing home
  const sa = Math.PI / 4;
  const sr = R + 0.42;
  const sx = hx + Math.cos(sa) * sr;
  const sz = hz + Math.sin(sa) * sr;
  for (const s of [-1, 1]) b.box(0.04, 0.5, 0.04, sx + s * 0.2 * Math.SQRT1_2, y, sz - s * 0.2 * Math.SQRT1_2, 0x3a4048);
  b.box(0.62, 0.34, 0.05, sx, y + 0.5, sz, 0x23262e, false, -Math.PI / 4);
  wall(neonOf(b), 'glow', sx - 0.027, y + 0.68, sz - 0.027, -1, -1, 0.56, 0.24, [0.25, 0.3, 0.35]);
  pixelText(neonOf(b), 'glow', 'HOME 3', sx - 0.03, y + 0.73, sz - 0.03, -1, -1, 0.016, [2.6, 2.1, 0.6]);
  pixelText(neonOf(b), 'glow', 'AWAY 2', sx - 0.03, y + 0.63, sz - 0.03, -1, -1, 0.016, [2.6, 2.6, 2.4]);
  pixelText(b, 'solid', 'BALLPARK', sx + 0.028, y + 0.68, sz + 0.028, 1, 1, 0.018, 0xf2c84b);
  // Seating bowl: behind home and down both lines, stepped rows, an upper deck with a roof
  const path: [number, number, number, number][] = []; // x, z, outward nx, nz
  for (let k = 0; k <= 6; k++) path.push([hx + 2.55 - k * 0.36, hz - 0.18, 0, -1]);
  for (let k = 1; k < 6; k++) {
    const a = -Math.PI / 2 - (k / 6) * (Math.PI / 2);
    path.push([hx + 0.25 + Math.cos(a) * 0.43, hz + 0.25 + Math.sin(a) * 0.43, Math.cos(a), Math.sin(a)]);
  }
  for (let k = 0; k <= 6; k++) path.push([hx - 0.18, hz + 0.39 + k * 0.36, -1, 0]);
  const seat = 0x2c5f45;
  const tiers = 6;
  const row = 0.085;
  const rise = 0.06;
  const P = (k: number, d: number, h: number) => [path[k]![0] + path[k]![2] * d, y + h, path[k]![1] + path[k]![3] * d] as const;
  for (let t = 0; t < tiers; t++) {
    const d0 = t * row;
    const d1 = (t + 1) * row;
    const h = (t + 1) * rise;
    for (let k = 0; k < path.length - 1; k++) {
      quad4(b, 'solid', [P(k, d0, h), P(k + 1, d0, h), P(k + 1, d1, h), P(k, d1, h)], t % 2 ? seat : shade(seat, 1.15), [0, 1, 0]);
      quad4(b, 'solid', [P(k, d0, h - rise), P(k + 1, d0, h - rise), P(k + 1, d0, h), P(k, d0, h)], 0x8a8f96, [-path[k]![2], 0, -path[k]![3]]);
    }
  }
  // Concourse and the upper deck
  const dc = tiers * row;
  const hc = tiers * rise;
  for (let k = 0; k < path.length - 1; k++) {
    quad4(b, 'solid', [P(k, dc, hc), P(k + 1, dc, hc), P(k + 1, dc + 0.06, hc), P(k, dc + 0.06, hc)], 0xd8d2c4, [0, 1, 0]);
    for (let t = 0; t < 3; t++) {
      const d0 = dc + 0.06 + t * 0.06;
      const h = hc + 0.1 + (t + 1) * 0.07;
      quad4(b, 'solid', [P(k, d0, h), P(k + 1, d0, h), P(k + 1, d0 + 0.06, h), P(k, d0 + 0.06, h)], t % 2 ? seat : shade(seat, 1.15), [0, 1, 0]);
      quad4(b, 'solid', [P(k, d0, h - 0.17), P(k + 1, d0, h - 0.17), P(k + 1, d0, h), P(k, d0, h)], 0xe8e2d6, [-path[k]![2], 0, -path[k]![3]]);
    }
    // Roof canopy over the upper deck
    const dr = dc + 0.24;
    quad4(b, 'solid', [P(k, dc + 0.1, hc + 0.5), P(k + 1, dc + 0.1, hc + 0.5), P(k + 1, dr + 0.02, hc + 0.52), P(k, dr + 0.02, hc + 0.52)], 0xf4f4f0, [0, 1, 0]);
  }
  // Brick outer facade with arches, on the two street sides
  const outer = dc + 0.26;
  for (let k = 0; k < path.length - 1; k++) {
    const a = P(k, outer, 0);
    const c = P(k + 1, outer, 0);
    const nx = path[k]![2];
    const nz = path[k]![3];
    quad4(b, 'solid', [[a[0], y, a[2]], [c[0], y, c[2]], [c[0], y + 0.56, c[2]], [a[0], y + 0.56, a[2]]], 0xa4553f, [nx, 0, nz]);
    const mx = (a[0] + c[0]) / 2;
    const mz = (a[2] + c[2]) / 2;
    const segL = Math.hypot(c[0] - a[0], c[2] - a[2]);
    for (const f of [0.14, 0.38]) {
      wall(b, 'solid', mx + nx * 0.003, y + f, mz + nz * 0.003, nx, nz, segL * 0.55, 0.13, 0x3a2420);
      wall(winOf(b), 'glow', mx + nx * 0.005, y + f - 0.02, mz + nz * 0.005, nx, nz, segL * 0.45, 0.07, warmth(r), wr(r, 0.9, TINT.smoke));
    }
    quad4(b, 'solid', [[a[0], y + 0.56, a[2]], [c[0], y + 0.56, c[2]], [c[0] - nx * 0.06, y + 0.56, c[2] - nz * 0.06], [a[0] - nx * 0.06, y + 0.56, a[2] - nz * 0.06]], 0xe8e2d6, [0, 1, 0]);
  }
  // Corner gate: two brick towers with copper caps, flags and a neon sign
  const cx = hx - outer * Math.SQRT1_2 - 0.1;
  const cz = hz - outer * Math.SQRT1_2 - 0.1;
  for (const s of [-1, 1]) {
    const tx = cx + s * 0.28 * Math.SQRT1_2;
    const tz = cz - s * 0.28 * Math.SQRT1_2;
    b.box(0.18, 0.9, 0.18, tx, y, tz, 0x9a4a36, false, Math.PI / 4);
    b.box(0.2, 0.04, 0.2, tx, y + 0.9, tz, 0xe8e2d6, false, Math.PI / 4);
    b.cylinder(0, 0.14, 0.22, tx, y + 0.94, tz, 0x5f9e88, 4);
    rod(b, tx, y + 1.16, tz, tx, y + 1.4, tz, 0.004, 0xe8e2d6, 3);
    b.box(0.08, 0.05, 0.004, tx + 0.04, y + 1.34, tz, 0xd8402e, false, Math.PI / 4);
    wall(winOf(b), 'glow', tx + 0.065, y + 0.7, tz + 0.065, 1, 1, 0.06, 0.14, warmth(r), wr(r, 1, TINT.smoke));
    put(b, new THREE.CylinderGeometry(0.05, 0.05, 0.01, 12), tx + 0.068, y + 0.82, tz + 0.068, 0xf4f1ea, 'solid', Math.PI / 4, Math.PI / 2);
  }
  b.box(0.42, 0.08, 0.03, cx, y + 0.5, cz, 0x1c1f26, false, -Math.PI / 4);
  pixelText(neonOf(b), 'glow', 'BALLPARK', cx - 0.017, y + 0.54, cz - 0.017, -1, -1, 0.012, [2.6, 1.4, 0.4]);
  // Light towers on the bowl's rim
  for (const k of [1, 6, 9, 12, 16]) {
    const [lx, , lz] = P(k, outer - 0.02, 0);
    const nx = path[k]![2];
    const nz = path[k]![3];
    rod(b, lx, y, lz, lx, y + 1.5, lz, 0.016, 0x6a7380, 5, 'solid', 0.012);
    b.box(0.26, 0.16, 0.04, lx, y + 1.46, lz, 0x3a4048, false, Math.atan2(nx, nz));
    for (let row = 0; row < 3; row++) wall(neonOf(b), 'glow', lx - nx * 0.022, y + 1.49 + row * 0.045, lz - nz * 0.022, -nx, -nz, 0.22, 0.03, [3.2, 3.2, 2.9]);
  }
  people(b, r, cx + 0.4, cz + 0.1, 8, 0.4, 0.3, y);
  people(b, r, hx + 1.2, hz - 0.3, 10, 2.0, 0.2, y + 0.3);
  people(b, r, hx - 0.35, hz + 1.2, 10, 0.2, 2.0, y + 0.3);
  palm(b, r, x + 1.75, z - 1.75, 0.9, y);
  palm(b, r, x + 1.4, z - 1.75, 0.8, y);
}

/** University: a sandstone quad with red tile roofs and arcades, a church, a clock tower, Palm Drive. */
function university(b: GeoBuilder, r: () => number, x: number, z: number) {
  slab(b, x, z, 3.9, 3.9, PALETTE.lawn);
  const sand = 0xe4caa0;
  const sandDark = 0xcfb184;
  const tile = 0xb5523a;
  const light = warmth(r);
  const y = 0.035;
  // The quad: four ranges around a courtyard
  const qx = x - 0.55;
  const qz = z - 0.55;
  const Q = 1.7; // courtyard size
  const t = 0.4; // range depth
  b.box(Q, 0.006, Q, qx, y, qz, 0xe8dcc0);
  for (const [dx, dz] of [[-0.4, -0.4], [0.4, -0.4], [-0.4, 0.4], [0.4, 0.4]] as const) {
    b.cylinder(0.18, 0.18, 0.012, qx + dx, y, qz + dz, PALETTE.lawn, 12);
    tree(b, r, qx + dx, qz + dz, 0.6, y + 0.012, dx < 0 && dz < 0 ? 'palm' : 'round');
  }
  const ranges: [number, number, number, number, number, number][] = [
    [qx, qz - Q / 2 - t / 2, Q + 2 * t, t, 0, 1],
    [qx, qz + Q / 2 + t / 2, Q + 2 * t, t, 0, -1],
    [qx - Q / 2 - t / 2, qz, t, Q, 1, 0],
    [qx + Q / 2 + t / 2, qz, t, Q, -1, 0],
  ];
  for (const [cx, cz, w, d, nx, nz] of ranges) {
    const h = 0.34;
    b.box(w, h, d, cx, y, cz, sand);
    b.hip(w, 0.12, d, cx, y + h, cz, tile, 0.04, 0.08);
    // Arcade facing the courtyard: columns and dark arches
    const span = Math.abs(nz) > 0.5 ? Q : Q;
    const fx = cx + (nx * w) / 2;
    const fz = cz + (nz * d) / 2;
    const n = 8;
    for (let k = 0; k < n; k++) {
      const u = ((k + 0.5) / n - 0.5) * span;
      const ax = fx + nz * u;
      const az = fz - nx * u;
      archQuad(b, ax + nx * 0.003, y + 0.02, az + nz * 0.003, nx, nz, 0.14, 0.15, 0x5a4636);
      const pu = (k / n - 0.5) * span;
      b.box(0.025, 0.17, 0.025, fx + nz * pu + nx * 0.01, y, fz - nx * pu + nz * 0.01, sandDark);
      punch(b, r, ax, y + 0.26, az, nx, nz, 0.06, 0.08, sandDark, light, TINT.teal, 0.6);
    }
    b.box(Math.abs(nz) > 0.5 ? span : 0.03, 0.02, Math.abs(nz) > 0.5 ? 0.03 : span, fx + nx * 0.015, y + 0.17, fz + nz * 0.015, sandDark);
    // Outer windows
    const ox = cx - (nx * w) / 2;
    const oz = cz - (nz * d) / 2;
    for (let k = 0; k < 7; k++) {
      const u = ((k + 0.5) / 7 - 0.5) * (Math.abs(nz) > 0.5 ? w : d) * 0.9;
      for (const fy of [0.1, 0.25]) punch(b, r, ox + nz * u, y + fy, oz - nx * u, -nx, -nz, 0.06, 0.08, sandDark, light, TINT.teal, 0.5);
    }
  }
  // Memorial church on the far side of the quad, with its gold mosaic front
  const chx = qx;
  const chz = qz - Q / 2 + 0.3;
  b.box(0.6, 0.5, 0.5, chx, y, chz, sand);
  b.gable(0.5, 0.2, 0.6, chx, y + 0.5, chz, tile, 0.03, Math.PI / 2);
  for (let k = 0; k < 3; k++) archQuad(b, chx - 0.15 + k * 0.15, y + 0.03, chz + 0.253, 0, 1, 0.1, 0.16, 0x5a4636);
  wall(neonOf(b), 'glow', chx, y + 0.36, chz + 0.252, 0, 1, 0.42, 0.18, [1.5, 1.15, 0.45]);
  for (let k = 0; k < 5; k++) wall(b, 'solid', chx - 0.16 + k * 0.08, y + 0.36, chz + 0.255, 0, 1, 0.05, 0.13, pick(r, [0x2f5a8a, 0x8a3a2a, 0xd8b04a] as const));
  put(b, new THREE.CylinderGeometry(0.08, 0.08, 0.01, 12), chx, y + 0.56, chz + 0.26, 0xd4af37, 'solid', 0, Math.PI / 2);
  // The tower: sandstone shaft, belfry, observation deck, red dome
  const tx = x + 0.75;
  const tz = z - 1.25;
  const th = 2.2;
  b.box(0.36, 0.08, 0.36, tx, y, tz, sandDark);
  b.box(0.3, th, 0.3, tx, y + 0.08, tz, sand);
  for (const [nx, nz] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
    for (const s of [-1, 1]) {
      for (let k = 0; k < 9; k++) wall(winOf(b), 'glow', tx + nx * 0.152 + nz * s * 0.06, y + 0.3 + k * 0.17, tz + nz * 0.152 - nx * s * 0.06, nx, nz, 0.035, 0.11, light, wr(r, 0.35, TINT.teal));
    }
    // Belfry: tall arched openings, glowing at night
    archQuad(neonOf(b), tx + nx * 0.152, y + th - 0.2, tz + nz * 0.152, nx, nz, 0.17, 0.2, [2.2, 1.6, 0.8]);
    b.box(0.34, 0.03, 0.34, tx, y + th - 0.24, tz, sandDark);
  }
  b.box(0.36, 0.05, 0.36, tx, y + th + 0.08, tz, sandDark);
  b.box(0.26, 0.08, 0.26, tx, y + th + 0.13, tz, sand);
  put(b, new THREE.SphereGeometry(0.15, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), tx, y + th + 0.21, tz, tile, 'smooth', 0, 0, 0, 1, 1.15, 1);
  b.cylinder(0.025, 0.03, 0.08, tx, y + th + 0.37, tz, sand, 6);
  b.cylinder(0, 0.035, 0.06, tx, y + th + 0.45, tz, tile, 6);
  for (const [nx, nz] of [[1, 0], [0, 1]] as const) {
    put(b, new THREE.CylinderGeometry(0.055, 0.055, 0.01, 14), tx + nx * 0.156, y + th - 0.45, tz + nz * 0.156, 0xf4f1ea, 'solid', Math.atan2(nx, nz), Math.PI / 2);
    wall(b, 'solid', tx + nx * 0.163, y + th - 0.43, tz + nz * 0.163, nx, nz, 0.006, 0.04, 0x2a2f38);
  }
  // The Oval and Palm Drive
  put(b, new THREE.CylinderGeometry(0.62, 0.62, 0.008, 24), x + 0.95, y, z + 0.95, 0x82c757, 'solid', 0, 0, 0, 1, 1, 0.7);
  for (let k = 0; k < 7; k++) {
    const pz = z + 1.85 - k * 0.32;
    if (pz < qz + Q / 2 + t + 0.1) break;
    for (const s of [-1, 1]) palm(b, r, qx + s * 0.22, pz, 0.85, y);
  }
  b.box(0.3, 0.006, 1.9, qx, y, z + 1.0, 0xd8d2c4);
  // Library wing and a fountain on the east
  const lx = x + 1.35;
  const lz = z + 0.0;
  b.box(0.7, 0.4, 1.0, lx, y, lz, sand);
  b.hip(0.7, 0.13, 1.0, lx, y + 0.4, lz, tile, 0.04, 0.1);
  for (let k = 0; k < 5; k++) archQuad(b, lx - 0.353, y + 0.03, lz - 0.4 + k * 0.2, -1, 0, 0.12, 0.28, 0x5a4636);
  for (let k = 0; k < 5; k++) punch(b, r, lx + 0.35, y + 0.2, lz - 0.4 + k * 0.2, 1, 0, 0.08, 0.2, sandDark, light, TINT.teal, 0.8);
  for (let k = 0; k < 3; k++) punch(b, r, lx - 0.2 + k * 0.2, y + 0.2, lz + 0.5, 0, 1, 0.08, 0.2, sandDark, light, TINT.teal, 0.8);
  b.cylinder(0.14, 0.16, 0.04, x + 0.95, y, z + 0.95, sandDark, 14);
  b.cylinder(0.12, 0.12, 0.01, x + 0.95, y + 0.04, z + 0.95, PALETTE.pool, 14);
  people(b, r, x + 0.4, z + 1.0, 12, 1.6, 1.4, y);
  people(b, r, qx, qz, 8, Q, Q, y);
  for (const [dx, dz] of [[1.8, -1.8], [-1.8, 1.8], [1.8, 1.8], [-0.2, 1.7]] as const) tree(b, r, x + dx, z + dz, 0.85, y, 'round');
  for (const [dx, dz] of [[0.3, 0.55], [1.6, 0.55], [0.6, 1.6]] as const) lamp(b, x + dx, z + dz, y);
}

/** A round-headed arch opening on a wall facing (nx, nz): rectangle plus semicircle. */
function archQuad(b: GeoBuilder, x: number, y: number, z: number, nx: number, nz: number, w: number, h: number, color: ColorLike) {
  wall(b, b instanceof GeoBuilder && color instanceof Array ? 'glow' : 'solid', x, y + (h - w / 2) / 2, z, nx, nz, w, h - w / 2, color);
  const g = new THREE.CircleGeometry(w / 2, 8, 0, Math.PI);
  put(b, g, x, y + h - w / 2, z, color, Array.isArray(color) ? 'glow' : 'solid', Math.atan2(nx, nz));
}

// ─── Fun ───────────────────────────────────────────────────────────────────

/** Food truck court: three trucks, picnic tables, string lights. */
function foodtrucks(b: GeoBuilder, r: () => number, x: number, z: number) {
  pad(b, x, z, 1.9);
  b.box(1.1, 0.008, 0.9, x - 0.2, 0.035, z + 0.3, 0x7cbd4c);
  const menus = [['TACOS', 0xe85a4a], ['BAO', 0x3aa3c8], ['PIZZA', 0xf2c84b], ['BBQ', 0x8a3a2a], ['BOBA', 0xd86aa8], ['CREPES', 0x3aa36a]] as const;
  const order = [...menus].sort(() => r() - 0.5);
  for (let i = 0; i < 3; i++) {
    const [name, color] = order[i]!;
    foodTruck(b, r, x - 0.6 + i * 0.6, z - 0.58, color, name);
  }
  // Picnic tables with umbrellas
  for (const [dx, dz] of [[-0.55, 0.15], [0.05, 0.15], [-0.55, 0.55], [0.05, 0.55]] as const) {
    const tx = x + dx;
    const tz = z + dz;
    b.box(0.22, 0.012, 0.09, tx, 0.085, tz, PALETTE.wood);
    for (const s of [-1, 1]) b.box(0.22, 0.01, 0.035, tx, 0.06, tz + s * 0.075, PALETTE.wood);
    for (const s of [-1, 1]) b.box(0.012, 0.05, 0.16, tx + s * 0.09, 0.035, tz, 0x7a5a3a);
    b.cylinder(0.003, 0.003, 0.18, tx, 0.035, tz, 0xdddddd, 4);
    b.cylinder(0, 0.11, 0.04, tx, 0.21, tz, pick(r, [0xe85a4a, 0xf2c84b, 0x3aa3c8, 0xf4f1ea] as const), 8);
  }
  // String lights zig-zagging over the seating
  const poles: [number, number][] = [[-0.85, -0.05], [0.35, -0.05], [-0.85, 0.75], [0.35, 0.75]];
  for (const [px, pz] of poles) rod(b, x + px, 0.035, z + pz, x + px, 0.38, z + pz, 0.006, 0x5a4a3a, 4);
  bulbs(b, x - 0.85, 0.38, z - 0.05, x + 0.35, 0.38, z + 0.75, 14, 0.06);
  bulbs(b, x + 0.35, 0.38, z - 0.05, x - 0.85, 0.38, z + 0.75, 14, 0.06);
  bulbs(b, x - 0.85, 0.38, z - 0.05, x + 0.35, 0.38, z - 0.05, 12, 0.05);
  // Bins, a palm, a crowd in line
  for (let k = 0; k < 3; k++) b.box(0.05, 0.08, 0.05, x + 0.65 + k * 0.06, 0.035, z + 0.2, [0x2f8a4a, 0x2f6fa8, 0x2a2f38][k]!);
  palm(b, r, x + 0.75, z + 0.75, 0.75, 0.035);
  palm(b, r, x - 0.88, z + 0.88, 0.6, 0.035);
  people(b, r, x - 0.2, z - 0.25, 7, 1.4, 0.1, 0.035);
  people(b, r, x - 0.2, z + 0.35, 6, 0.9, 0.6, 0.035);
}

function foodTruck(b: GeoBuilder, r: () => number, x: number, z: number, color: number, name: string) {
  const y = 0.035;
  for (const [wx, wz] of [[-0.14, -0.08], [0.12, -0.08], [-0.14, 0.08], [0.12, 0.08]] as const) {
    put(b, new THREE.CylinderGeometry(0.03, 0.03, 0.025, 10), x + wx, y + 0.03, z + wz, 0x1e2026, 'solid', 0, Math.PI / 2);
  }
  b.rbox(0.34, 0.2, 0.17, x - 0.04, y + 0.04, z, color, 0.025, 'glass');
  b.rbox(0.1, 0.13, 0.16, x + 0.17, y + 0.04, z, color, 0.03, 'glass');
  wall(b, 'glass', x + 0.222, y + 0.13, z, 1, 0, 0.13, 0.05, 0x1c2a3a);
  // Serving hatch with a propped flap, menu board and the name
  wall(winOf(b), 'glow', x - 0.04, y + 0.15, z + 0.087, 0, 1, 0.2, 0.07, warmth(r), wr(r, 1, TINT.shop));
  put(b, new THREE.BoxGeometry(0.22, 0.008, 0.08), x - 0.04, y + 0.2, z + 0.11, shade(color, 0.85), 'solid', 0, -0.5);
  b.box(0.24, 0.01, 0.04, x - 0.04, y + 0.11, z + 0.1, 0xd8dde2);
  b.box(0.06, 0.08, 0.01, x - 0.19, y + 0.08, z + 0.086, 0x1c1f26);
  for (let k = 0; k < 3; k++) wall(neonOf(b), 'glow', x - 0.19, y + 0.1 - k * 0.02, z + 0.092, 0, 1, 0.04, 0.006, [2.4, 2.2, 1.8]);
  pixelText(b, 'solid', name, x - 0.04, y + 0.065, z + 0.088, 0, 1, 0.008, 0xf4f1ea);
  pixelText(b, 'solid', name, x - 0.04, y + 0.15, z - 0.088, 0, -1, 0.01, 0xf4f1ea);
  b.box(0.06, 0.02, 0.05, x - 0.1, y + 0.24, z, 0xc9ced6);
  // Something fun on the roof
  if (name === 'TACOS') put(b, new THREE.CylinderGeometry(0.06, 0.06, 0.02, 12, 1, false, 0, Math.PI), x - 0.02, y + 0.3, z, 0xf2c84b, 'solid', 0, Math.PI / 2);
  else if (name === 'PIZZA') b.cylinder(0.06, 0.06, 0.01, x - 0.02, y + 0.25, z, 0xf2a03a, 3);
  else b.blob(0.035, x - 0.02, y + 0.28, z, bright(color, 0.7), 'smooth', 1);
  quadBlob(neonOf(b), x + 0.2, y + 0.18, z + 0.07, 0.008, [2.8, 2.4, 1.6]);
}

/** Café and bookshop: two shopfronts, a parklet, bistro tables. */
function cafe(b: GeoBuilder, r: () => number, x: number, z: number) {
  pad(b, x, z, 1.9);
  const wallC = pick(r, [0xf6e7c8, 0xbfe4d0, 0xf3c6a2, 0xc6dcf2] as const);
  const trim = PALETTE.trim;
  const cx = x - 0.12;
  const cz = z - 0.35;
  const W = 1.4;
  const D = 0.8;
  const gh = 0.26;
  const fh = 0.2;
  const H = gh + fh * 2;
  b.box(W, H, D, cx, 0.035, cz, wallC);
  const front = cz + D / 2;
  const light = warmth(r);
  const halves: [number, string, number][] = [[-W / 4, 'CAFE', 0x2f8a6a], [W / 4, 'BOOKS', 0x8a2a3a]];
  for (const [dx, name, awn] of halves) {
    const sx = cx + dx;
    wall(b, 'solid', sx, 0.035 + 0.12, front + 0.003, 0, 1, W / 2 - 0.06, 0.2, 0x2a2f38);
    wall(winOf(b), 'glow', sx - 0.04, 0.035 + 0.12, front + 0.006, 0, 1, W / 2 - 0.22, 0.16, light, wr(r, 1, TINT.shop));
    wall(b, 'solid', sx + W / 4 - 0.09, 0.035 + 0.1, front + 0.006, 0, 1, 0.07, 0.16, 0x6b4a3a);
    awning(b, sx, 0.035 + gh - 0.03, front, 0, 1, W / 2 - 0.1, 0.14, awn);
    b.box(W / 2 - 0.06, 0.05, 0.012, sx, 0.035 + gh - 0.02, front + 0.006, 0x1c1f26);
    pixelText(neonOf(b), 'glow', name, sx, 0.035 + gh + 0.005, front + 0.014, 0, 1, 0.011, name === 'CAFE' ? [2.6, 1.9, 0.9] : [2.4, 1.0, 1.4]);
    // Window displays
    for (let k = 0; k < 6; k++) {
      const u = sx - 0.18 + k * 0.05;
      if (name === 'BOOKS') b.box(0.012, 0.05 + r() * 0.02, 0.035, u, 0.05, front + 0.02, pick(r, [0xe85a4a, 0x2f6fa8, 0xf2c84b, 0x3aa36a, 0x7a5ac8, 0xf4f1ea] as const));
      else if (k % 2 === 0) b.cylinder(0.014, 0.012, 0.03, u, 0.05, front + 0.02, 0xf4f1ea, 6);
    }
  }
  // Flats above: bay windows with flower boxes
  for (const dx of [-W / 4, W / 4]) {
    bayWindow(b, r, cx + dx, 0.035 + gh + 0.01, front, 0, 1, 0.34, 0.06, fh, 2, wallC, trim, warmth(r));
    for (let f = 0; f < 2; f++) b.box(0.3, 0.025, 0.03, cx + dx, 0.035 + gh + f * fh + 0.03, front + 0.075, 0x3aa36a);
  }
  for (const dx of [-0.6, 0, 0.6]) {
    for (let f = 0; f < 2; f++) punch(b, r, cx + W / 2, 0.035 + gh + f * fh + 0.1, cz + dx * 0.5, 1, 0, 0.08, 0.12, trim, warmth(r), TINT.sky);
  }
  cornice(b, cx, 0.035 + H, front, 0, 1, W, trim);
  b.box(0.08, 0.12, 0.08, cx - 0.4, 0.035 + H, cz - 0.15, 0xa8553e);
  // Parklet: a platform with planters, tables and string lights
  const px = x + 0.1;
  const pz = z + 0.72;
  b.box(1.0, 0.03, 0.32, px, 0.035, pz, PALETTE.wood);
  for (const s of [-1, 1]) b.box(0.04, 0.08, 0.3, px + s * 0.5, 0.065, pz, 0x2f8a6a);
  for (let k = 0; k < 3; k++) bistro(b, r, px - 0.3 + k * 0.3, pz, 0.065, 0x2f8a6a, false);
  for (const s of [-1, 1]) rod(b, px + s * 0.5, 0.065, pz - 0.15, px + s * 0.5, 0.32, pz - 0.15, 0.004, STEEL_DARK, 3);
  bulbs(b, px - 0.5, 0.32, pz - 0.15, px + 0.5, 0.32, pz - 0.15, 12, 0.04);
  // Sidewalk tables with umbrellas, chalkboard, bikes
  for (const [dx, dz] of [[-0.6, 0.25], [-0.3, 0.3]] as const) bistro(b, r, x + dx, z + dz, 0.035, 0x2f8a6a);
  b.box(0.05, 0.08, 0.01, x + 0.25, 0.035, z + 0.18, 0x1c1f26, false, 0.3);
  for (let k = 0; k < 3; k++) bike(b, r, x + 0.75, z - 0.2 + k * 0.1, 0);
  tree(b, r, x + 0.75, z + 0.35, 0.6, 0.035, 'round');
  palm(b, r, x - 0.85, z + 0.85, 0.6, 0.035);
  people(b, r, x - 0.2, z + 0.4, 6, 1.0, 0.3, 0.035);
}

/** Playland: a coaster, a carousel, a drop tower, teacups, a log flume and a gate. */
function amusement(b: GeoBuilder, r: () => number, x: number, z: number) {
  slab(b, x, z, 3.9, 3.9, 0xe8dcc8);
  const y = 0.035;
  // Paths
  b.box(3.6, 0.005, 0.2, x, y, z + 0.6, 0xd8c8a8);
  b.box(0.2, 0.005, 3.6, x + 0.2, y, z, 0xd8c8a8);
  // Coaster: a loop of track on white trestles, a train of cars
  const pts: THREE.Vector3[] = [];
  const N = 22;
  for (let k = 0; k < N; k++) {
    const a = (k / N) * Math.PI * 2;
    const hill = 0.35 + 0.55 * Math.max(0, Math.sin(a * 2 + 0.6)) + (k === 4 ? 0.5 : 0) + (k === 5 ? 0.3 : 0);
    pts.push(new THREE.Vector3(x - 0.7 + Math.cos(a) * 1.05, y + hill, z - 0.75 + Math.sin(a) * 0.95));
  }
  const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
  const frames = curve.computeFrenetFrames(160, true);
  for (const s of [-1, 1]) {
    const railPts: THREE.Vector3[] = [];
    for (let k = 0; k < 160; k++) {
      const p = curve.getPointAt(k / 160);
      const side = new THREE.Vector3().crossVectors(curve.getTangentAt(k / 160), UPV).normalize();
      railPts.push(p.add(side.multiplyScalar(s * 0.03)));
    }
    b.transformed(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(railPts, true), 160, 0.008, 4, true), new THREE.Matrix4(), 0xd8402e);
  }
  void frames;
  for (let k = 0; k < 64; k++) {
    const t = k / 64;
    const p = curve.getPointAt(t);
    const tan = curve.getTangentAt(t);
    obox(b, p.x, p.y - 0.008, p.z, -tan.z, 0, tan.x, tan.x, 0, tan.z, 0.012, 0.08, 0.012, 0x5a4a3a);
    if (k % 3 === 0) {
      rod(b, p.x, y, p.z, p.x, p.y - 0.01, p.z, 0.008, 0xf4f1ea, 4);
      if (p.y > 0.6) beam(b, p.x - 0.06, y, p.z, p.x, p.y * 0.6, p.z, 0.008, 0xf4f1ea);
    }
    if (k % 2 === 0) quadBlob(neonOf(b), p.x, p.y + 0.012, p.z, 0.007, [2.8, 2.2, 1.2], FX.chase + (k % 3) / 3);
  }
  for (let k = 0; k < 4; k++) {
    const t = 0.62 + k * 0.012;
    const p = curve.getPointAt(t);
    const tan = curve.getTangentAt(t);
    b.rbox(0.07, 0.04, 0.06, p.x, p.y + 0.004, p.z, pick(r, [0xf2c84b, 0x3aa3c8, 0x3aa36a] as const), 0.012, 'smooth', -Math.atan2(tan.z, tan.x));
  }
  // Carousel: striped canopy, horses on poles, a glowing crown
  const cx = x + 1.05;
  const cz = z - 0.75;
  b.cylinder(0.42, 0.44, 0.06, cx, y, cz, 0xf4f1ea, 20);
  b.cylinder(0.08, 0.08, 0.36, cx, y + 0.06, cz, 0xd4af37, 10);
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    const g = new THREE.CylinderGeometry(0.02, 0.48, 0.18, 2, 1, false, a, (Math.PI * 2) / 12);
    put(b, g, cx, y + 0.5, cz, k % 2 ? 0xe85a4a : 0xf4f1ea);
    const hx = cx + Math.cos(a) * 0.3;
    const hz = cz - Math.sin(a) * 0.3;
    rod(b, hx, y + 0.06, hz, hx, y + 0.41, hz, 0.004, 0xd4af37, 3);
    b.box(0.07, 0.035, 0.02, hx, y + 0.14 + (k % 3) * 0.03, hz, pick(r, [0xf4f1ea, 0x2a2f38, 0xb07a44] as const), false, a + Math.PI / 2);
    quadBlob(neonOf(b), cx + Math.cos(a) * 0.47, y + 0.41, cz - Math.sin(a) * 0.47, 0.01, [2.8, 2.2, 1.2], FX.chase + (k % 3) / 3);
  }
  b.cylinder(0.46, 0.46, 0.05, cx, y + 0.36, cz, 0xd4af37, 20);
  b.blob(0.04, cx, y + 0.62, cz, 0xd4af37, 'smooth', 1);
  // Drop tower: a lattice mast with a ring of seats
  const dx = x + 1.35;
  const dz = z + 1.25;
  b.box(0.16, 2.2, 0.16, dx, y, dz, 0x3a8fd8);
  for (let k = 0; k < 11; k++) b.box(0.17, 0.012, 0.17, dx, y + k * 0.2, dz, 0xf4f1ea);
  b.cylinder(0.16, 0.16, 0.08, dx, y + 1.4, dz, 0xf2c84b, 12);
  b.cylinder(0.1, 0.12, 0.12, dx, y + 2.2, dz, 0xe85a4a, 10);
  for (let k = 0; k < 12; k++) quadBlob(neonOf(b), dx + 0.085, y + 0.15 + k * 0.17, dz + 0.085, 0.012, [2.6, 0.8, 1.8], FX.chase + (k % 3) / 3);
  quadBlob(neonOf(b), dx, y + 2.36, dz, 0.03, RED_LIGHT, FX.blink + 0.4);
  // Teacups
  const ux = x - 0.5;
  const uz = z + 1.3;
  b.cylinder(0.42, 0.42, 0.03, ux, y, uz, 0xb07ad8, 20);
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    const px = ux + Math.cos(a) * 0.26;
    const pz = uz + Math.sin(a) * 0.26;
    b.lathe([[0.05, 0], [0.075, 0.02], [0.08, 0.07], [0.075, 0.075]], px, y + 0.03, pz, pick(r, [0xf2c84b, 0x3aa3c8, 0xe86a9a, 0x5dd0a0] as const), 10, 'smooth');
  }
  // Log flume: a water channel with a big drop and a splash pool
  b.box(1.2, 0.04, 0.16, x - 1.2, y, z + 1.55, 0x8a6446);
  b.box(1.16, 0.01, 0.12, x - 1.2, y + 0.04, z + 1.55, 0x3aa3c8, 'glass');
  put(b, new THREE.BoxGeometry(0.6, 0.04, 0.16), x - 1.6, y + 0.3, z + 1.1, 0x8a6446, 'solid', Math.PI / 2, 0, 0.0);
  put(b, new THREE.BoxGeometry(0.16, 0.04, 0.7), x - 1.6, y + 0.24, z + 1.2, 0x8a6446, 'solid', 0, 0.75);
  b.rbox(0.1, 0.035, 0.06, x - 1.0, y + 0.05, z + 1.55, 0x6a4a34, 0.015);
  for (let k = 0; k < 5; k++) b.blob(0.03, x - 1.65 + r() * 0.1, y + 0.08, z + 1.62 + r() * 0.05, 0xe6f6fa, 'smooth');
  // Entrance gate with the sign
  const gx = x + 0.2;
  const gz = z + 1.85;
  for (const s of [-1, 1]) {
    b.box(0.1, 0.55, 0.1, gx + s * 0.4, y, gz, 0xf4f1ea);
    b.cylinder(0, 0.08, 0.12, gx + s * 0.4, y + 0.55, gz, 0xe85a4a, 4, false, Math.PI / 4);
  }
  b.box(0.9, 0.14, 0.04, gx, y + 0.42, gz, 0x2a2f38);
  pixelText(neonOf(b), 'glow', 'PLAYLAND', gx, y + 0.49, gz + 0.022, 0, 1, 0.022, [2.6, 0.8, 1.6]);
  for (let k = 0; k < 14; k++) quadBlob(neonOf(b), gx - 0.42 + k * 0.065, y + 0.57, gz + 0.022, 0.009, [2.8, 2.2, 1.2], FX.chase + (k % 3) / 3);
  b.box(0.14, 0.16, 0.12, gx + 0.65, y, gz - 0.05, 0xe85a4a);
  b.cylinder(0, 0.12, 0.08, gx + 0.65, y + 0.16, gz - 0.05, 0xf4f1ea, 4, false, Math.PI / 4);
  // Snack tents, balloons, string lights, palms
  for (const [sx, sz, c] of [[x + 1.6, z + 0.25, 0x3aa3c8], [x - 1.6, z + 0.25, 0xf2c84b]] as const) {
    b.box(0.22, 0.14, 0.18, sx, y, sz, 0xf4f1ea);
    b.cylinder(0, 0.18, 0.12, sx, y + 0.14, sz, c, 6);
  }
  for (let k = 0; k < 6; k++) {
    const bx = x + 0.6 + k * 0.05;
    rod(b, bx, y + 0.06, z + 0.75, bx + (k - 2.5) * 0.02, y + 0.3, z + 0.75, 0.001, 0xf4f1ea, 3);
    b.blob(0.025, bx + (k - 2.5) * 0.02, y + 0.32, z + 0.75, pick(r, [0xe85a4a, 0xf2c84b, 0x3aa3c8, 0xe86a9a] as const), 'smooth', 1);
  }
  bulbs(b, x - 1.8, 0.4, z + 0.6, x + 1.8, 0.4, z + 0.6, 28, 0.08);
  for (const [px, pz] of [[-1.8, -1.8], [1.8, -1.8], [-1.8, 0.9], [1.8, 0.75]] as const) palm(b, r, x + px, z + pz, 0.9, y);
  people(b, r, x + 0.2, z + 0.6, 14, 3.4, 0.2, y);
  people(b, r, x + 0.2, z + 0.2, 8, 0.2, 2.6, y);
}

const UPV = new THREE.Vector3(0, 1, 0);

/** Concert arena: a rounded drum wrapped in white ribbons, glass between, an LED band, a plaza screen. */
function arena(b: GeoBuilder, r: () => number, x: number, z: number, neon: ColorLike) {
  pad(b, x, z, 1.9);
  const ax = x - 0.06;
  const az = z - 0.06;
  const rx = 0.82;
  const rz = 0.7;
  const n = 36;
  const ring = (k: number, dx = 0, dz = 0) => ngonPts(n, rx * k, rz * k, ax + dx, az + dz);
  const white = 0xf2f2ee;
  const light = warmth(r);
  // Glass base
  const base = ring(0.97);
  prism(b, base, 0.035, 0.18, 0x3a4656);
  facade(b, r, base, 0.035, null, 0.215, { floors: 1, bay: 0.14, winH: 0.86, winW: 0.9, lit: 0.95, light, tint: TINT.smoke });
  // Ribbons: overlapping white bands that sweep around, with dark glass between
  let y = 0.215;
  const bands = [[1.0, 0.0, 0.0, 0.09], [1.02, 0.02, 0.01, 0.07], [1.0, -0.01, 0.02, 0.08], [0.98, 0.01, -0.01, 0.06]] as const;
  for (const [k, dx, dz, h] of bands) {
    const pts = ring(k, dx, dz);
    loft(b, [{ pts, y }, { pts: ring(k + 0.015, dx, dz), y: y + h }], white, 'solid', false);
    y += h;
    const g = ring(k - 0.04);
    loft(b, [{ pts: g, y }, { pts: g, y: y + 0.035 }], 0x2a3442, 'glass', false);
    facade(b, r, g, y, null, y + 0.035, { floors: 1, bay: 0.12, winH: 0.8, winW: 0.9, lit: 0.8, light, tint: TINT.smoke });
    y += 0.035;
  }
  // LED band under the roof lip
  const led = ring(0.99);
  loft(b, [{ pts: led, y }, { pts: led, y: y + 0.05 }], 0x1a1e26, 'solid', false);
  neonRing(b, led, y + 0.025, 0.04, neon, 0.002);
  y += 0.05;
  // Roof: a low white dome with a skylight ring
  loft(b, [{ pts: ring(1.02), y }, { pts: ring(0.85), y: y + 0.08 }, { pts: ring(0.5), y: y + 0.13 }, { pts: ring(0.15), y: y + 0.15 }], 0xe6e8ea, 'smooth', true);
  loft(b, [{ pts: ring(0.62), y: y + 0.112 }, { pts: ring(0.6), y: y + 0.12 }], 0x6a7a8a, 'glass', false);
  // Plaza: big screen, palms, the crowd
  const sx = x + 0.75;
  const sz = z + 0.75;
  b.box(0.04, 0.42, 0.04, sx, 0.035, sz, 0x3a4048);
  b.box(0.36, 0.22, 0.03, sx - 0.02, 0.3, sz - 0.02, 0x1c1f26, false, Math.PI / 4);
  wall(neonOf(b), 'glow', sx - 0.02 + 0.012, 0.41, sz - 0.02 + 0.012, 1, 1, 0.32, 0.18, shade(neon, 0.7), FX.shimmer + 0.3);
  pixelText(neonOf(b), 'glow', 'LIVE', sx + 0.0, 0.41, sz + 0.0, 1, 1, 0.022, [2.8, 2.8, 2.8]);
  for (const [px, pz] of [[0.85, -0.6], [-0.6, 0.85], [0.85, 0.2]] as const) palm(b, r, x + px, z + pz, 0.8, 0.035);
  people(b, r, x + 0.35, z + 0.75, 12, 1.0, 0.25, 0.035);
  people(b, r, x + 0.75, z + 0.0, 8, 0.25, 1.0, 0.035);
  for (const [lx, lz] of [[0.9, 0.9], [-0.9, 0.9], [0.9, -0.9]] as const) lamp(b, x + lx, z + lz, 0.035);
}

// ─── The founder's homes ───────────────────────────────────────────────────

/** Founder homes, in lot-local space facing +z. */
export function founderHome(option: string, seed: number, museum = false): Built {
  const r = rng(seed);
  const b = new Kit();
  switch (option) {
    case 'hacker-house':
      hackerHouse(b, r, museum);
      break;
    case 'studio':
      studio(b, r);
      break;
    case 'bungalow':
      bungalow(b, r);
      break;
    case 'loft':
      loftHome(b, r);
      break;
    case 'hills-modern':
      hillsModern(b, r);
      break;
    case 'villa':
      villa(b, r);
      break;
    case 'cliffside':
      cliffside(b, r);
      break;
    case 'compound':
      compound(b, r);
      break;
    case 'island-estate':
      islandEstate(b, r);
      break;
    default:
      b.box(0.96, 0.03, 0.96, 0, 0, 0, PALETTE.lawn);
  }
  const built = b.build();
  built.group.traverse((o) => (o.castShadow = true));
  return built;
}

/** The SF three-bin trio. */
function bins(b: GeoBuilder, x: number, z: number, y = 0.03) {
  for (let k = 0; k < 3; k++) {
    b.box(0.04, 0.06, 0.045, x + k * 0.045, y, z, [0x2f8a4a, 0x2f6fa8, 0x2a2f38][k]!);
    b.box(0.044, 0.006, 0.05, x + k * 0.045, y + 0.06, z - 0.002, [0x2a7a40, 0x2a609a, 0x23262e][k]!);
  }
}

/** A worn sofa (for porches). */
function sofa(b: GeoBuilder, x: number, y: number, z: number, color: ColorLike, rot = 0) {
  b.box(0.2, 0.035, 0.08, x, y, z, color, false, rot);
  b.box(0.2, 0.05, 0.02, x - Math.sin(rot) * 0.035, y + 0.035, z - Math.cos(rot) * 0.035, shade(color, 0.85), false, rot);
  for (const s of [-1, 1]) b.box(0.02, 0.05, 0.08, x + Math.cos(rot) * s * 0.1, y, z - Math.sin(rot) * s * 0.1, shade(color, 0.85), false, rot);
}

/** A little car (classic, rounded). Faces +x unless rotated. */
function littleCar(b: GeoBuilder, x: number, y: number, z: number, color: ColorLike, rot = 0) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  b.rbox(0.3, 0.06, 0.14, x, y + 0.025, z, color, 0.025, 'glass', rot);
  b.rbox(0.16, 0.05, 0.12, x - c * 0.02, y + 0.075, z + s * 0.02, color, 0.02, 'glass', rot);
  b.rbox(0.165, 0.035, 0.124, x - c * 0.02, y + 0.082, z + s * 0.02, 0x1c2a3a, 0.012, 'glass', rot);
  for (const [dx, dz] of [[0.09, 0.06], [-0.09, 0.06], [0.09, -0.06], [-0.09, -0.06]] as const) {
    put(b, new THREE.CylinderGeometry(0.025, 0.025, 0.02, 8), x + c * dx + s * dz, y + 0.025, z - s * dx + c * dz, 0x1e2026, 'solid', rot, Math.PI / 2);
  }
  quadBlob(neonOf(b), x + c * 0.15 + s * 0.045, y + 0.05, z - s * 0.15 + c * 0.045, 0.008, [2.6, 2.4, 2]);
  quadBlob(neonOf(b), x + c * 0.15 - s * 0.045, y + 0.05, z - s * 0.15 - c * 0.045, 0.008, [2.6, 2.4, 2]);
}

function hackerHouse(b: Kit, r: () => number, museum: boolean) {
  // Patchy lawn, a cracked path
  b.box(0.96, 0.03, 0.96, 0, 0, 0, 0x8a9a5a);
  for (let k = 0; k < 6; k++) b.box(0.1 + r() * 0.1, 0.004, 0.08 + r() * 0.08, (r() - 0.5) * 0.7, 0.03, 0.2 + r() * 0.25, 0xa09a6a);
  b.box(0.12, 0.006, 0.3, 0.16, 0.03, 0.33, 0xb9b2a4);
  // A faded painted lady: the colour has seen better days
  const paint = shade(pick(r, PALETTE.victorian), 0.82);
  const trim = 0xe8e0cc;
  const W = 0.5;
  const D = 0.6;
  const zc = -0.08;
  const front = zc + D / 2;
  const base = 0.1;
  const fh = 0.26;
  b.box(W, base, D, 0, 0.03, zc, 0x9a948a);
  b.box(W, fh * 2, D, 0, 0.03 + base, zc, paint);
  const top = 0.03 + base + fh * 2;
  // Peeling patches
  for (let k = 0; k < 4; k++) wall(b, 'solid', W / 2 + 0.002, 0.2 + r() * 0.35, zc + (r() - 0.5) * 0.4, 1, 0, 0.04 + r() * 0.04, 0.03, shade(paint, 1.12));
  bayWindow(b, r, -0.1, 0.03 + base + 0.02, front, 0, 1, 0.26, 0.07, fh, 2, paint, trim, [1.6, 1.3, 0.8]);
  cornice(b, 0, top, front, 0, 1, W, trim);
  b.box(W + 0.04, 0.03, D + 0.02, 0, top, zc, trim);
  b.gable(D, 0.24, W, 0, top + 0.03, zc, 0x6a6560, 0.03, Math.PI / 2);
  // Blue tarp over a leak
  put(b, new THREE.BoxGeometry(0.18, 0.004, 0.2), 0.12, top + 0.15, zc - 0.05, 0x2f6fd8, 'solid', 0, 0, -0.75);
  // Antenna and a satellite dish
  rod(b, -0.15, top + 0.2, zc - 0.2, -0.15, top + 0.42, zc - 0.2, 0.004, PALETTE.steel, 3);
  for (let k = 0; k < 3; k++) b.box(0.1 - k * 0.025, 0.004, 0.004, -0.15, top + 0.32 + k * 0.03, zc - 0.2, PALETTE.steel);
  put(b, new THREE.SphereGeometry(0.035, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), 0.2, top + 0.02, zc - 0.25, 0xe8e8e8, 'smooth', 0, -1.1);
  // Front: stairs up to the porch, the door, the old couch
  for (let k = 0; k < 4; k++) b.box(0.14, 0.03, 0.04, 0.16, 0.03 + k * 0.03, front + 0.16 - k * 0.04, 0xb9a88a);
  b.box(0.22, 0.012, 0.14, 0.16, 0.03 + base, front + 0.06, 0x8a6a4a);
  b.box(0.08, 0.18, 0.01, 0.16, 0.03 + base, front + 0.003, 0x4a3a5a);
  wall(winOf(b), 'glow', 0.16, 0.03 + base + 0.15, front + 0.009, 0, 1, 0.05, 0.03, [1.6, 1.3, 0.8], wr(r, 1));
  sofa(b, 0.3, 0.03, front + 0.22, 0x8a6a3a, 0.2);
  b.box(0.06, 0.03, 0.06, 0.3, 0.075, front + 0.22, 0xd8402e); // pizza box
  b.box(0.06, 0.012, 0.06, 0.3, 0.105, front + 0.22, 0xf4f1ea);
  // Bikes against the fence, a whiteboard full of ideas
  for (let k = 0; k < 3; k++) bike(b, r, -0.38 + k * 0.035, 0.36 + k * 0.03, Math.PI / 2 + 0.2, 0.03);
  b.box(0.22, 0.14, 0.01, -0.22, 0.12, 0.42, 0xffffff, false, 0.25);
  for (const s of [-1, 1]) b.box(0.008, 0.22, 0.008, -0.22 + s * 0.1, 0.03, 0.42 - s * 0.025, PALETTE.steel, false, 0.25);
  for (let k = 0; k < 5; k++) b.box(0.03 + r() * 0.08, 0.006, 0.002, -0.27 + r() * 0.1, 0.15 + k * 0.022, 0.427 - (r() - 0.5) * 0.02, pick(r, [0x2f6fa8, 0xe85a4a, 0x3aa36a, 0x2a2f38] as const), false, 0.25);
  // A server glowing blue in the basement window; string lights; the bins
  wall(neonOf(b), 'glow', -0.12, 0.08, front + 0.006, 0, 1, 0.1, 0.04, [0.4, 1.2, 2.6], FX.shimmer + 0.5);
  bulbs(b, -0.25, 0.03 + base + fh - 0.02, front + 0.1, 0.25, 0.03 + base + fh - 0.02, front + 0.1, 8, 0.03);
  bins(b, 0.3, -0.36);
  // A scruffy hedge and a fence
  for (let k = 0; k < 5; k++) bush(b, r, -0.42, 0.06, -0.38 + k * 0.12, 0.05, 0x5c7a3e);
  for (let k = 0; k <= 9; k++) b.box(0.012, 0.08, 0.012, -0.45 + k * 0.1, 0.03, 0.46, 0xc8bca0);
  b.box(0.96, 0.01, 0.01, 0, 0.09, 0.46, 0xc8bca0);
  // A hand-lettered banner
  b.box(0.3, 0.06, 0.004, -0.1, 0.03 + base + fh * 2 - 0.08, front + 0.075, 0xf4ecd8);
  pixelText(b, 'solid', 'HACK', -0.1, 0.03 + base + fh * 2 - 0.08, front + 0.078, 0, 1, 0.009, 0xd8402e);
  if (museum) {
    // It's a museum now: a brass plaque, velvet ropes and a spotlight
    b.box(0.03, 0.12, 0.03, 0.34, 0.03, 0.4, 0x3a3f4a);
    put(b, new THREE.BoxGeometry(0.14, 0.09, 0.01), 0.34, 0.17, 0.41, 0xd4af37, 'glass', 0, -0.5);
    for (let k = 0; k < 3; k++) {
      b.cylinder(0.008, 0.012, 0.08, -0.05 + k * 0.12, 0.03, front + 0.34, 0xd4af37, 6);
      b.blob(0.01, -0.05 + k * 0.12, 0.115, front + 0.34, 0xd4af37, 'smooth');
    }
    for (let k = 0; k < 2; k++) rod(b, -0.05 + k * 0.12, 0.1, front + 0.34, 0.07 + k * 0.12, 0.1, front + 0.34, 0.004, 0x8a1a2a, 3);
    quadBlob(neonOf(b), 0.34, 0.24, 0.42, 0.012, [2.6, 2.2, 1.4]);
  }
}

function studio(b: Kit, r: () => number) {
  b.box(0.96, 0.03, 0.96, 0, 0, 0, PALETTE.sidewalk);
  const wallC = pick(r, [0xf6e7c8, 0xc6dcf2, 0xf3c6a2, 0xe8e2d6, 0xbfe4d0] as const);
  const trim = PALETTE.trim;
  const W = 0.72;
  const D = 0.66;
  const zc = -0.1;
  const front = zc + D / 2;
  const gh = 0.22;
  const fh = 0.2;
  const floors = 3;
  const H = gh + fh * floors;
  b.box(W, H, D, 0, 0.03, zc, wallC);
  // Ground: garage doors and the entry with a little awning
  for (const dx of [-0.2, 0.08]) {
    wall(b, 'solid', dx, 0.03 + 0.09, front + 0.003, 0, 1, 0.2, 0.16, 0xe8e2d6);
    for (let k = 0; k < 3; k++) wall(b, 'solid', dx, 0.03 + 0.04 + k * 0.05, front + 0.005, 0, 1, 0.2, 0.006, 0xc9c2b4);
  }
  wall(b, 'solid', 0.27, 0.03 + 0.1, front + 0.004, 0, 1, 0.08, 0.17, 0x2f4a6a);
  wall(winOf(b), 'glow', 0.27, 0.03 + 0.2, front + 0.006, 0, 1, 0.07, 0.03, [1.6, 1.3, 0.8], wr(r, 1));
  awning(b, 0.27, 0.03 + gh - 0.01, front, 0, 1, 0.14, 0.08, 0x2a4a7a);
  b.box(0.03, 0.04, 0.02, 0.36, 0.13, front + 0.01, 0x3a3f4a); // mailboxes
  // Two stacks of bay windows, sash windows on the side
  for (const dx of [-0.17, 0.17]) bayWindow(b, r, dx, 0.03 + gh, front, 0, 1, 0.26, 0.06, fh, floors, wallC, trim, warmth(r));
  for (let f = 0; f < floors; f++) {
    for (const dz of [-0.2, 0.05]) punch(b, r, W / 2, 0.03 + gh + f * fh + 0.1, zc + dz, 1, 0, 0.07, 0.12, trim, warmth(r), TINT.sky, 0.5);
    for (const dz of [-0.2, 0.05]) punch(b, r, -W / 2, 0.03 + gh + f * fh + 0.1, zc + dz, -1, 0, 0.07, 0.12, trim, warmth(r), TINT.sky, 0.5);
  }
  // Your place: third floor, warm light, a tiny balcony with plants and a heart in the window
  const yy = 0.03 + gh + fh * 2;
  b.box(0.2, 0.012, 0.08, W / 2 + 0.04, yy, zc + 0.2, 0x3a3f4a);
  for (let k = 0; k < 3; k++) {
    b.cylinder(0.014, 0.01, 0.025, W / 2 + 0.0 + k * 0.035, yy + 0.012, zc + 0.22, 0xc0603a, 6);
    b.blob(0.018, W / 2 + 0.0 + k * 0.035, yy + 0.05, zc + 0.22, 0x4f9d3b, 'smooth');
  }
  for (const s of [-1, 1]) rod(b, W / 2 + 0.08, yy + 0.012, zc + 0.2 + s * 0.1, W / 2 + 0.08, yy + 0.06, zc + 0.2 + s * 0.1, 0.003, 0x3a3f4a, 3);
  b.box(0.004, 0.004, 0.2, W / 2 + 0.08, yy + 0.06, zc + 0.2, 0x3a3f4a);
  wall(winOf(b), 'glow', W / 2 + 0.004, yy + 0.1, zc + 0.2, 1, 0, 0.12, 0.13, [2.2, 1.5, 0.8], 0.13);
  pixelText(neonOf(b), 'glow', '*', W / 2 + 0.008, yy + 0.12, zc + 0.2, 1, 0, 0.008, [2.8, 0.6, 1.2]);
  // Fire escape on the other side
  for (let f = 0; f < floors; f++) {
    const fy = 0.03 + gh + f * fh;
    b.box(0.05, 0.008, 0.3, -W / 2 - 0.03, fy, zc - 0.05, 0x2a2f38);
    b.box(0.004, 0.05, 0.3, -W / 2 - 0.055, fy, zc - 0.05, 0x2a2f38);
    rod(b, -W / 2 - 0.03, fy, zc + 0.08, -W / 2 - 0.03, fy + fh, zc - 0.15, 0.004, 0x2a2f38, 3);
  }
  cornice(b, 0, 0.03 + H, front, 0, 1, W, trim);
  b.box(W + 0.04, 0.03, D + 0.02, 0, 0.03 + H, zc, trim);
  b.box(0.12, 0.08, 0.1, -0.18, 0.06 + H, zc - 0.15, 0x9aa3ad);
  b.box(0.24, 0.012, 0.2, 0.15, 0.06 + H, zc - 0.05, PALETTE.wood);
  bins(b, -0.42, 0.38);
  tree(b, r, -0.35, 0.36, 0.5, 0.03, 'round');
  bike(b, r, 0.36, 0.38, 0, 0.03);
}

function bungalow(b: Kit, r: () => number) {
  b.box(0.96, 0.03, 0.96, 0, 0, 0, PALETTE.lawn);
  const wallC = pick(r, [0x8fae8a, 0xc9b88a, 0x9ab8c8, 0xd8a888] as const);
  const trim = 0xf4ecd8;
  const roof = 0x5a4a42;
  const W = 0.58;
  const D = 0.5;
  const zc = -0.08;
  const front = zc + D / 2;
  const H = 0.28;
  // Stone foundation, shingle walls
  b.box(W + 0.02, 0.05, D + 0.02, 0, 0.03, zc, 0x9a948a);
  b.box(W, H, D, 0, 0.08, zc, wallC);
  for (let k = 1; k < 6; k++) b.box(W + 0.004, 0.004, D + 0.004, 0, 0.08 + k * 0.045, zc, shade(wallC, 0.9));
  // Low front gable with deep eaves and exposed rafter tails
  b.gable(D + 0.12, 0.18, W, 0, 0.08 + H, zc + 0.02, roof, 0.07, Math.PI / 2);
  for (let k = 0; k < 6; k++) b.box(0.012, 0.012, 0.06, -W / 2 - 0.04, 0.08 + H - 0.005, zc - 0.2 + k * 0.08, trim);
  const tri = new THREE.Shape([new THREE.Vector2(-W / 2, 0), new THREE.Vector2(W / 2, 0), new THREE.Vector2(0, 0.17)]);
  put(b, new THREE.ExtrudeGeometry(tri, { depth: 0.01, bevelEnabled: false }), 0, 0.08 + H, front + 0.07, shade(wallC, 0.85));
  for (let k = -2; k <= 2; k++) wall(b, 'solid', k * 0.05, 0.08 + H + 0.06, front + 0.081, 0, 1, 0.012, 0.1 - Math.abs(k) * 0.03, trim);
  // Porch: tapered columns on stone piers, a swing, the door
  b.box(W, 0.03, 0.16, 0, 0.05, front + 0.08, PALETTE.wood);
  for (const s of [-1, 1]) {
    b.box(0.06, 0.08, 0.06, s * (W / 2 - 0.04), 0.08, front + 0.13, 0x9a948a);
    b.cylinder(0.018, 0.028, 0.18, s * (W / 2 - 0.04), 0.16, front + 0.13, trim, 4, false, Math.PI / 4);
  }
  b.box(W + 0.02, 0.03, 0.18, 0, 0.08 + H - 0.03, front + 0.08, trim);
  b.box(0.08, 0.17, 0.008, 0.08, 0.08, front + 0.003, 0x7a4a2a);
  wall(winOf(b), 'glow', 0.08, 0.08 + 0.14, front + 0.008, 0, 1, 0.05, 0.03, warmth(r), wr(r, 1));
  b.box(0.12, 0.012, 0.035, -0.14, 0.15, front + 0.14, PALETTE.wood);
  for (const s of [-1, 1]) rod(b, -0.14 + s * 0.05, 0.15, front + 0.14, -0.14 + s * 0.05, 0.08 + H - 0.03, front + 0.14, 0.002, 0x3a3f4a, 3);
  // Windows: three-over-one, trimmed
  punch(b, r, -0.14, 0.2, front, 0, 1, 0.14, 0.13, trim, warmth(r), TINT.sky, 0.85);
  for (const [nx, dz] of [[1, -0.12], [1, 0.08], [-1, -0.12], [-1, 0.08]] as const) punch(b, r, (nx * W) / 2, 0.2, zc + dz, nx, 0, 0.1, 0.12, trim, warmth(r), TINT.sky, 0.6);
  // Stone chimney
  b.box(0.08, 0.5, 0.1, -W / 2 - 0.02, 0.03, zc - 0.1, 0x9a8a7a);
  // Path, picket fence, flower beds, the lemon tree, a mailbox
  b.box(0.1, 0.006, 0.26, 0.08, 0.03, 0.37, 0xd8d2c4);
  for (let k = 0; k <= 18; k++) {
    if (k >= 8 && k <= 10) continue;
    b.box(0.012, 0.06, 0.008, -0.46 + k * 0.051, 0.03, 0.46, 0xf8f5ee);
  }
  b.box(0.92, 0.008, 0.008, 0, 0.075, 0.46, 0xf8f5ee);
  for (let k = 0; k < 8; k++) b.blob(0.02, -0.38 + k * 0.035, 0.05, front + 0.2, pick(r, [0xe86a9a, 0xf2c84b, 0xf4f1ea, 0xb07ad8] as const), 'smooth');
  const lx = 0.33;
  const lz = 0.3;
  b.cylinder(0.014, 0.02, 0.12, lx, 0.03, lz, PALETTE.trunk, 5);
  bush(b, r, lx, 0.2, lz, 0.1, 0x4f9d3b);
  bush(b, r, lx + 0.05, 0.24, lz - 0.04, 0.07, 0x5aa83a);
  for (let k = 0; k < 9; k++) {
    const a = r() * Math.PI * 2;
    const h = r();
    b.blob(0.012, lx + Math.cos(a) * 0.09, 0.15 + h * 0.12, lz + Math.sin(a) * 0.09, 0xf6d84a, 'smooth');
  }
  b.box(0.008, 0.08, 0.008, 0.35, 0.03, 0.43, 0x3a3f4a);
  b.box(0.04, 0.025, 0.025, 0.35, 0.11, 0.43, 0x2f4a6a);
  tree(b, r, -0.35, -0.38, 0.55, 0.03, 'round');
}

function loftHome(b: Kit, r: () => number) {
  b.box(0.96, 0.03, 0.96, 0, 0, 0, PALETTE.sidewalk);
  const brick = pick(r, BRICK);
  const trim = 0xd8cdb8;
  const W = 0.82;
  const D = 0.72;
  const zc = -0.08;
  const front = zc + D / 2;
  const fh = 0.25;
  const floors = 4;
  const H = fh * floors;
  b.box(W, 0.05, D, 0, 0.03, zc, trim);
  b.box(W, H - 0.05, D, 0, 0.08, zc, brick);
  const light = warmth(r);
  for (const [nx, nz, span, depth] of [[0, 1, W, D], [1, 0, D, W], [-1, 0, D, W], [0, -1, W, D]] as const) {
    const fx = (nx * depth) / 2;
    const fz = zc + (nz * depth) / 2;
    const bays = 3;
    for (let k = 0; k < bays; k++) {
      const u = ((k + 0.5) / bays - 0.5) * span;
      for (let f = 0; f < floors; f++) {
        if (f === 0 && nz === 1) continue;
        const top = f === floors - 1;
        steelWindow(b, r, fx + nz * u, 0.03 + f * fh + fh * 0.52, fz - nx * u, nx, nz, span / bays - 0.07, top ? 0.2 : 0.16, top ? [2.2, 1.5, 0.8] : light, top ? 0.95 : 0.6, 3, top ? 4 : 3);
      }
    }
    for (let f = 1; f < floors; f++) b.box(Math.abs(nz) > 0.5 ? span + 0.01 : 0.012, 0.012, Math.abs(nz) > 0.5 ? 0.012 : span + 0.01, fx, 0.03 + f * fh, fz, shade(brick, 0.8));
  }
  // Ground floor: a café behind a roll-up door, a steel canopy
  wall(winOf(b), 'glow', -0.15, 0.13, front + 0.005, 0, 1, 0.34, 0.16, light, wr(r, 1, TINT.shop));
  for (let k = 0; k < 4; k++) wall(b, 'solid', -0.15, 0.17 + k * 0.012, front + 0.007, 0, 1, 0.34, 0.004, STEEL_DARK);
  wall(b, 'solid', 0.25, 0.12, front + 0.004, 0, 1, 0.1, 0.18, 0x2a2f38);
  b.box(0.7, 0.012, 0.12, 0, 0.25, front + 0.06, STEEL_DARK);
  // Ghost sign
  wall(b, 'solid', W / 2 + 0.003, 0.03 + H - 0.14, zc, 1, 0, 0.6, 0.16, shade(brick, 0.85));
  pixelText(b, 'solid', 'SOMA', W / 2 + 0.006, 0.03 + H - 0.11, zc, 1, 0, 0.016, 0xe9dcc0);
  pixelText(b, 'solid', 'LOFTS', W / 2 + 0.006, 0.03 + H - 0.19, zc, 1, 0, 0.011, 0xd8c8a8);
  // Fire escape on the front
  for (let f = 1; f < floors; f++) {
    const fy = 0.03 + f * fh;
    b.box(0.24, 0.008, 0.06, 0.24, fy, front + 0.03, STEEL_DARK);
    b.box(0.24, 0.05, 0.004, 0.24, fy, front + 0.06, STEEL_DARK);
    rod(b, 0.15, fy, front + 0.03, 0.33, fy + fh, front + 0.03, 0.004, STEEL_DARK, 3);
  }
  // Roof: parapet, deck with a lounge, plants, lights, the water tower
  const ry = 0.03 + H;
  b.box(W + 0.03, 0.04, D + 0.03, 0, ry, zc, trim);
  b.box(W - 0.06, 0.02, D - 0.06, 0, ry, zc, 0x6a6560);
  b.box(0.4, 0.015, 0.36, 0.12, ry + 0.02, zc + 0.08, PALETTE.wood);
  sofa(b, 0.12, ry + 0.035, zc + 0.18, 0xe8e2d6, Math.PI);
  for (let k = 0; k < 3; k++) planter(b, r, -0.32, zc - 0.1 + k * 0.14, 0.07, 0.1, ry + 0.02, 0x3a3f4a);
  waterTower(b, -0.2, ry + 0.02, zc - 0.2, 0.7);
  bulbs(b, -0.08, ry + 0.16, zc + 0.27, 0.34, ry + 0.16, zc + 0.27, 8, 0.03);
  for (const s of [-1, 1]) rod(b, 0.12 + s * 0.21, ry + 0.02, zc + 0.27, 0.12 + s * 0.21, ry + 0.16, zc + 0.27, 0.003, STEEL_DARK, 3);
  bins(b, -0.42, 0.38);
  tree(b, r, 0.36, 0.38, 0.5, 0.03, 'round');
}

/** A spiky agave for dry gardens. */
function agave(b: GeoBuilder, x: number, y: number, z: number, s = 1) {
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    put(b, new THREE.ConeGeometry(0.012 * s, 0.07 * s, 3), x + Math.cos(a) * 0.012 * s, y + 0.03 * s, z + Math.sin(a) * 0.012 * s, 0x7aa08a, 'solid', -a, 0, 0.6);
  }
}

/** Retaining plinth so a hillside house meets sloping ground. */
function plinth(b: GeoBuilder, pts: readonly XZ[], top: number, depth: number, color: ColorLike) {
  prism(b, pts, top - depth, depth, color);
}

function hillsModern(b: Kit, r: () => number) {
  const stone = 0xb8ab98;
  const white = 0xf6f4ee;
  const wood = 0xa8744a;
  // Plinth into the hillside, terrace on top
  plinth(b, rectPts(1.9, 1.3, -0.05, -0.05), 0.04, 0.55, stone);
  for (let k = 0; k < 5; k++) b.box(1.905, 0.006, 1.305, -0.05, -0.45 + k * 0.1, -0.05, shade(stone, 0.9));
  b.box(1.9, 0.012, 1.3, -0.05, 0.04, -0.05, 0xe8e2d6);
  // Main pavilion: glass walls under a thin flat roof with deep overhangs
  const px = -0.3;
  const pz = -0.25;
  const pw = 1.0;
  const pd = 0.6;
  const ph = 0.3;
  const y0 = 0.052;
  prism(b, rectPts(pw, pd, px, pz), y0, ph, 0x3a4656, 'glass');
  facade(b, r, rectPts(pw, pd, px, pz), y0, null, y0 + ph, { floors: 1, bay: 0.14, winH: 0.94, winW: 0.94, lit: 0.9, light: [2.2, 1.5, 0.8], tint: TINT.sky, fins: { color: 0x2a2f38, depth: 0.01, width: 0.01 } });
  b.box(0.12, ph + 0.06, 0.2, px - 0.2, y0, pz - 0.12, stone); // stone fireplace wall
  b.box(pw + 0.3, 0.035, pd + 0.26, px + 0.05, y0 + ph, pz + 0.04, white);
  b.box(pw + 0.3, 0.012, pd + 0.26, px + 0.05, y0 + ph - 0.012, pz + 0.04, wood);
  // Cantilevered living room shooting out over the slope, on steel
  const cx = px + 0.62;
  const cz = pz + 0.48;
  prism(b, rectPts(0.5, 0.6, cx, cz), y0, ph * 0.9, 0x3a4656, 'glass');
  facade(b, r, rectPts(0.5, 0.6, cx, cz), y0, null, y0 + ph * 0.9, { floors: 1, bay: 0.14, winH: 0.94, winW: 0.94, lit: 0.9, light: [2.2, 1.5, 0.8], tint: TINT.sky, fins: { color: 0x2a2f38, depth: 0.01, width: 0.01 } });
  b.box(0.6, 0.03, 0.72, cx + 0.03, y0 + ph * 0.9, cz + 0.03, white);
  b.box(0.52, 0.05, 0.62, cx, y0 - 0.05, cz, white);
  for (const s of [-1, 1]) beam(b, cx + s * 0.2, y0 - 0.05, cz + 0.25, cx + s * 0.2, -0.5, cz - 0.1, 0.022, 0x2a2f38);
  // Pool on the terrace, deck, loungers, an umbrella
  pool(b, px + 0.05, 0.052, pz + 0.55, 0.5, 0.2);
  b.box(0.58, 0.01, 0.12, px + 0.05, 0.052, pz + 0.78, wood);
  for (let k = 0; k < 2; k++) {
    put(b, new THREE.BoxGeometry(0.12, 0.012, 0.045), px - 0.08 + k * 0.16, 0.08, pz + 0.79, white, 'solid', 0, 0, 0.25);
  }
  b.cylinder(0.003, 0.003, 0.16, px + 0.27, 0.062, pz + 0.79, 0xdddddd, 4);
  b.cylinder(0, 0.08, 0.03, px + 0.27, 0.21, pz + 0.79, 0xe85a4a, 8);
  // Carport with a butterfly roof and a classic car
  const kx = px + 0.72;
  const kz = pz - 0.18;
  for (const s of [-1, 1]) put(b, new THREE.BoxGeometry(0.4, 0.015, 0.2), kx, y0 + 0.28 + 0.02, kz + s * 0.095, white, 'solid', 0, s * 0.12);
  for (const [dx, dz] of [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]] as const) b.box(0.012, 0.28, 0.012, kx + dx, y0, kz + dz, 0x2a2f38);
  littleCar(b, kx, y0, kz, pick(r, [0x5fb8b0, 0xe8a03a, 0xd8402e, 0xf2e6c8] as const));
  // Planting: agaves, an olive tree, a palm
  for (const [ax, az] of [[-0.85, 0.45], [-0.75, 0.52], [-0.88, 0.3], [0.75, -0.62]] as const) agave(b, ax, 0.052, az);
  bush(b, r, -0.72, 0.18, -0.6, 0.1, 0x8aa08a);
  b.cylinder(0.012, 0.018, 0.12, -0.72, 0.052, -0.6, PALETTE.trunk, 5);
  palm(b, r, 0.72, 0.4, 0.8, 0.052);
  // Path lights
  for (let k = 0; k < 4; k++) quadBlob(neonOf(b), -0.85 + k * 0.12, 0.07, 0.55, 0.008, LAMP);
}

function villa(b: Kit, r: () => number) {
  const stucco = 0xf6ecd8;
  const tile = pick(r, [0xc4552f, 0xd4683a, 0xb94b38] as const);
  const iron = 0x2a2f38;
  const light = warmth(r);
  plinth(b, rectPts(2.1, 1.7), 0.04, 0.45, 0xd8c8a8);
  b.box(2.1, 0.012, 1.7, 0, 0.04, 0, 0xe8dcc4);
  const y0 = 0.052;
  const h = 0.4;
  // A U of wings around the courtyard
  const wings: [number, number, number, number, number][] = [
    [0, -0.5, 1.6, 0.5, 2],
    [-0.6, 0.1, 0.42, 0.7, 1],
    [0.6, 0.1, 0.42, 0.7, 1],
  ];
  for (const [wx, wz, w, d, storeys] of wings) {
    const wh = storeys === 2 ? h : h * 0.6;
    b.box(w, wh, d, wx, y0, wz, stucco);
    b.hip(w, 0.14, d, wx, y0 + wh, wz, tile, 0.05, 0.25);
    for (let k = 0; k < 3; k++) b.box(w + 0.1 - k * 0.002, 0.006, d + 0.1, wx, y0 + wh + 0.008 + k * 0.004, wz, shade(tile, 0.85));
  }
  // Mirador tower at the corner
  b.box(0.3, 0.72, 0.3, -0.62, y0, -0.55, stucco);
  b.hip(0.3, 0.16, 0.3, -0.62, y0 + 0.72, -0.55, tile, 0.04, 0.05);
  for (const [nx, nz] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) archQuad(winOf(b), -0.62 + nx * 0.152, y0 + 0.5, -0.55 + nz * 0.152, nx, nz, 0.1, 0.16, light);
  // Arcade (loggia) along the courtyard, arched windows outside
  for (let k = 0; k < 5; k++) {
    const ax = -0.4 + k * 0.2;
    archQuad(b, ax, y0 + 0.01, -0.248, 0, 1, 0.13, 0.17, 0x6a4a3a);
    b.box(0.03, 0.2, 0.03, ax + 0.1, y0, -0.24, stucco);
    punch(b, r, ax, y0 + 0.3, -0.25, 0, 1, 0.07, 0.1, 0xe8dcc0, light, TINT.sky, 0.8);
    b.box(0.1, 0.004, 0.025, ax, y0 + 0.255, -0.235, iron);
    for (let j = 0; j < 4; j++) b.box(0.003, 0.03, 0.003, ax - 0.04 + j * 0.027, y0 + 0.255, -0.225, iron);
  }
  for (let k = 0; k < 6; k++) punch(b, r, -0.6 + k * 0.24, y0 + 0.2, -0.75, 0, -1, 0.07, 0.12, 0xe8dcc0, light, TINT.sky, 0.6);
  for (const s of [-1, 1]) {
    for (let k = 0; k < 3; k++) punch(b, r, s * 0.81, y0 + 0.12, -0.1 + k * 0.2, s, 0, 0.06, 0.1, 0xe8dcc0, light, TINT.sky, 0.6);
    for (let k = 0; k < 2; k++) punch(b, r, s * 0.6 + (k - 0.5) * 0.18, y0 + 0.12, 0.45, 0, 1, 0.06, 0.1, 0xe8dcc0, light, TINT.sky, 0.6);
  }
  // Courtyard: terracotta pavers, a tiled fountain, potted lemons, bougainvillea
  b.box(0.76, 0.006, 0.68, 0, y0, 0.06, 0xd8946a);
  const fz = 0.1;
  prism(b, ngonPts(8, 0.14, 0.14, 0, fz, Math.PI / 8), y0, 0.05, 0x3a7aa8);
  flat(neonOf(b), 'glow', 0, y0 + 0.052, fz, 0.2, 0.2, POOL);
  b.cylinder(0.03, 0.04, 0.12, 0, y0, fz, 0xe8dcc0, 8);
  b.cylinder(0.06, 0.02, 0.02, 0, y0 + 0.12, fz, 0xe8dcc0, 8);
  for (const [px, pz] of [[-0.3, -0.15], [0.3, -0.15], [-0.3, 0.35], [0.3, 0.35]] as const) {
    b.cylinder(0.035, 0.025, 0.05, px, y0, pz, 0xc0603a, 8);
    bush(b, r, px, y0 + 0.1, pz, 0.05, 0x4f9d3b);
    for (let k = 0; k < 3; k++) b.blob(0.009, px + (r() - 0.5) * 0.06, y0 + 0.1 + r() * 0.04, pz + (r() - 0.5) * 0.06, 0xf6d84a, 'smooth');
  }
  for (let k = 0; k < 7; k++) b.blob(0.035 + r() * 0.02, -0.82 + r() * 0.05, y0 + 0.08 + r() * 0.2, -0.2 + k * 0.08, pick(r, [0xd83a8a, 0xe85aa8, 0xc8327a] as const), 'smooth');
  for (let k = 0; k < 5; k++) b.blob(0.03 + r() * 0.02, 0.4 + k * 0.08, y0 + h + 0.02, -0.25, pick(r, [0xd83a8a, 0xe85aa8] as const), 'smooth');
  // Pool and garden beyond the courtyard, cypresses and palms
  pool(b, 0, y0, 0.62, 0.9, 0.24, 0xe8dcc0);
  for (let k = 0; k < 3; k++) {
    put(b, new THREE.BoxGeometry(0.12, 0.012, 0.045), -0.3 + k * 0.3, y0 + 0.03, 0.8, 0xf4f1ea, 'solid', 0, 0, 0.2);
  }
  for (const [cx, cz] of [[-0.95, -0.75], [-0.95, -0.45], [0.95, -0.75], [0.95, -0.45]] as const) cypress(b, r, cx, cz, 1.2, y0);
  for (const px of [-0.9, 0.9]) palm(b, r, px, 0.7, 1.0, y0);
  for (let k = 0; k < 6; k++) quadBlob(neonOf(b), -0.5 + k * 0.2, y0 + 0.03, 0.78, 0.008, LAMP);
  // Gravel drive with a fountain and a car
  b.box(0.3, 0.006, 0.5, 0.95, y0, 0.1, 0xd8cdb4);
  littleCar(b, 0.92, y0, 0.15, pick(r, [0x1c2a3a, 0xd8402e, 0xe8e2d6] as const), Math.PI / 2);
}

function cliffside(b: Kit, r: () => number) {
  const rock = 0x8a8a84;
  // Rock outcrop going down the canyon
  plinth(b, rectPts(1.6, 0.9, -0.25, -0.35), 0.04, 0.6, rock);
  for (let k = 0; k < 9; k++) b.blob(0.12 + r() * 0.1, -0.9 + r() * 1.4, -0.3 + r() * 0.2, -0.8 + r() * 0.9, pick(r, [0x8a8a84, 0x7a7a74, 0x9a968c] as const), 'solid', 1);
  for (let k = 0; k < 5; k++) bush(b, r, -0.8 + r() * 1.2, -0.05 + r() * 0.05, 0.1 + r() * 0.1, 0.05, 0x6a8a4a);
  b.box(1.6, 0.012, 0.9, -0.25, 0.04, -0.35, 0xd8d2c4);
  const glass = 0x3a4656;
  const white = 0xf6f4ee;
  const light: ColorLike = [2.2, 1.5, 0.8];
  const y0 = 0.052;
  // Lower box, anchored on the rock
  const lo = rectPts(1.1, 0.6, -0.3, -0.4);
  prism(b, lo, y0, 0.3, glass, 'glass');
  facade(b, r, lo, y0, null, y0 + 0.3, { floors: 1, bay: 0.15, winH: 0.94, winW: 0.94, lit: 0.9, light, tint: TINT.sky, fins: { color: 0x2a2f38, depth: 0.01, width: 0.01 } });
  b.box(1.16, 0.035, 0.66, -0.3, y0 + 0.3, -0.4, white);
  // Upper box, flying far out over the canyon
  const up = rectPts(0.7, 1.15, 0.1, -0.1);
  const uy = y0 + 0.335;
  prism(b, up, uy, 0.28, glass, 'glass');
  facade(b, r, up, uy, null, uy + 0.28, { floors: 1, bay: 0.15, winH: 0.94, winW: 0.94, lit: 0.9, light, tint: TINT.sky, fins: { color: 0x2a2f38, depth: 0.01, width: 0.01 } });
  b.box(0.78, 0.035, 1.23, 0.1, uy + 0.28, -0.1, white);
  b.box(0.72, 0.035, 1.17, 0.1, uy - 0.035, -0.1, white);
  // Infinity-edge pool on the cantilever's roof, a glass balustrade
  pool(b, 0.1, uy + 0.315, 0.12, 0.5, 0.5);
  b.box(0.7, 0.06, 0.006, 0.1, uy + 0.315, 0.49, 0x9fc4d4, 'glass');
  // Steel struts down to the rock
  for (const s of [-1, 1]) beam(b, 0.1 + s * 0.3, uy - 0.035, 0.35, 0.1 + s * 0.2, -0.45, -0.1, 0.02, 0x2a2f38);
  // Stair, deck, a fire pit
  for (let k = 0; k < 6; k++) b.box(0.12, 0.012, 0.05, -0.75, y0 + 0.05 * k, 0.0 - k * 0.05, 0x9a948a);
  b.box(0.5, 0.012, 0.3, -0.55, y0, 0.0, PALETTE.wood);
  b.cylinder(0.05, 0.05, 0.03, -0.55, y0 + 0.012, 0.0, 0x3a3f4a, 10);
  quadBlob(neonOf(b), -0.55, y0 + 0.05, 0.0, 0.02, [2.8, 1.4, 0.4], FX.shimmer + 0.3);
  for (let k = 0; k < 3; k++) b.box(0.08, 0.03, 0.03, -0.55 + Math.cos(k * 2.1) * 0.12, y0 + 0.012, Math.sin(k * 2.1) * 0.12, 0xe8e2d6, false, k * 2.1);
  cypress(b, r, -0.95, -0.7, 1.1, y0);
  cypress(b, r, -0.95, -0.5, 1.0, y0);
}

function compound(b: Kit, r: () => number) {
  const white = 0xf6f4ee;
  const wood = 0xb9824f;
  const light: ColorLike = [2.2, 1.5, 0.8];
  plinth(b, rectPts(2.3, 1.9), 0.04, 0.45, 0xd8d2c4);
  b.box(2.3, 0.012, 1.9, 0, 0.04, 0, 0xe8e2d6);
  b.box(1.0, 0.01, 0.7, 0.2, 0.052, -0.05, PALETTE.lawn);
  const y0 = 0.052;
  // Three pavilions: glass, timber screens, thin white roofs
  const pavs: [number, number, number, number][] = [[-0.62, -0.5, 0.7, 0.55], [0.6, -0.55, 0.65, 0.5], [-0.55, 0.38, 0.6, 0.5]];
  for (const [px, pz, w, d] of pavs) {
    const pts = rectPts(w, d, px, pz);
    prism(b, pts, y0, 0.28, 0x3a4656, 'glass');
    facade(b, r, pts, y0, null, y0 + 0.28, { floors: 1, bay: 0.12, winH: 0.94, winW: 0.94, lit: 0.85, light, tint: TINT.sky, fins: { color: wood, depth: 0.025, width: 0.012, every: 1 } });
    b.box(w + 0.18, 0.03, d + 0.18, px, y0 + 0.28, pz, white);
    b.box(w * 0.5, 0.012, d * 0.6, px, y0 + 0.31, pz, 0x6a8a5a);
  }
  // Covered walkways linking them
  for (const [ax, az, cx, cz] of [[-0.27, -0.5, 0.27, -0.55], [-0.6, -0.22, -0.58, 0.13]] as const) {
    const len = Math.hypot(cx - ax, cz - az);
    const rot = -Math.atan2(cz - az, cx - ax);
    b.box(len, 0.012, 0.16, (ax + cx) / 2, y0 + 0.22, (az + cz) / 2, white, false, rot);
    for (let k = 0; k <= 3; k++) {
      const t = k / 3;
      b.box(0.01, 0.22, 0.01, ax + (cx - ax) * t, y0, az + (cz - az) * t + 0.07, 0x2a2f38);
    }
  }
  // Reflecting pool and the infinity pool along the edge, a sculpture, a fire pit
  pool(b, 0.3, y0, 0.2, 0.7, 0.08, 0x3a3f4a);
  pool(b, 0.1, y0, 0.78, 1.7, 0.26);
  for (let k = 0; k < 4; k++) put(b, new THREE.BoxGeometry(0.12, 0.012, 0.045), 0.65 + (k % 2) * 0.15, y0 + 0.03, 0.4 + Math.floor(k / 2) * 0.12, 0xf4f1ea, 'solid', Math.PI / 2, 0, 0.2);
  put(b, new THREE.TorusKnotGeometry(0.06, 0.016, 32, 5), 0.6, y0 + 0.14, 0.1, 0xc8a04a, 'glass');
  b.box(0.08, 0.06, 0.08, 0.6, y0, 0.1, 0x3a3f4a);
  b.cylinder(0.06, 0.06, 0.025, -0.05, y0, 0.45, 0x3a3f4a, 10);
  quadBlob(neonOf(b), -0.05, y0 + 0.045, 0.45, 0.025, [2.8, 1.4, 0.4], FX.shimmer + 0.2);
  // Olive trees in gravel, lights along the paths
  for (const [ox, oz] of [[1.0, 0.2], [0.95, -0.2], [-1.0, -0.05], [0.1, -0.85]] as const) {
    b.cylinder(0.015, 0.022, 0.12, ox, y0, oz, PALETTE.trunk, 5);
    bush(b, r, ox, y0 + 0.17, oz, 0.1, 0x8aa08a);
  }
  for (let k = 0; k < 6; k++) quadBlob(neonOf(b), -0.9 + k * 0.3, y0 + 0.02, 0.6, 0.008, LAMP);
  palm(b, r, 1.0, 0.75, 1.0, y0);
  palm(b, r, -1.05, 0.8, 0.9, y0);
}

/** A little helicopter, parked. */
function helicopter(b: GeoBuilder, x: number, y: number, z: number, color: ColorLike, rot = 0) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  b.rbox(0.2, 0.09, 0.1, x, y + 0.03, z, color, 0.04, 'glass', rot);
  b.rbox(0.08, 0.06, 0.09, x + c * 0.07, y + 0.05, z - s * 0.07, 0x1c2a3a, 0.03, 'glass', rot);
  rod(b, x - c * 0.08, y + 0.08, z + s * 0.08, x - c * 0.3, y + 0.1, z + s * 0.3, 0.012, color, 5, 'solid', 0.02);
  b.box(0.01, 0.06, 0.04, x - c * 0.3, y + 0.08, z + s * 0.3, color, false, rot);
  for (const sd of [-1, 1]) b.box(0.22, 0.008, 0.008, x - s * sd * 0.05, y, z - c * sd * 0.05, 0x3a3f4a, false, rot);
  b.cylinder(0.01, 0.01, 0.03, x, y + 0.12, z, 0x3a3f4a, 5);
  for (const a of [0.3, 0.3 + Math.PI / 2]) b.box(0.42, 0.004, 0.018, x, y + 0.15, z, 0x2a2f38, false, rot + a);
}

function islandEstate(b: Kit, r: () => number) {
  const white = 0xf6f4ee;
  const stone = 0xd8cdb4;
  const light: ColorLike = [2.2, 1.5, 0.8];
  b.box(2.6, 0.04, 2.2, 0, 0, 0, PALETTE.lawn);
  b.box(1.9, 0.012, 1.0, 0.0, 0.04, -0.45, 0xe8e2d6);
  const y0 = 0.052;
  // Main house: two floors of glass, a stone spine, big cantilevered roof planes
  const lo = rectPts(1.6, 0.7, -0.1, -0.55);
  prism(b, lo, y0, 0.3, 0x3a4656, 'glass');
  facade(b, r, lo, y0, null, y0 + 0.3, { floors: 1, bay: 0.15, winH: 0.94, winW: 0.94, lit: 0.9, light, tint: TINT.sky, fins: { color: 0x2a2f38, depth: 0.01, width: 0.01 } });
  b.box(1.9, 0.035, 0.95, -0.05, y0 + 0.3, -0.5, white);
  const up = rectPts(1.0, 0.6, 0.15, -0.6);
  prism(b, up, y0 + 0.335, 0.27, 0x3a4656, 'glass');
  facade(b, r, up, y0 + 0.335, null, y0 + 0.605, { floors: 1, bay: 0.15, winH: 0.94, winW: 0.94, lit: 0.9, light, tint: TINT.sky, fins: { color: 0x2a2f38, depth: 0.01, width: 0.01 } });
  b.box(1.3, 0.035, 0.85, 0.2, y0 + 0.605, -0.55, white);
  b.box(0.14, 0.7, 0.8, -0.55, y0, -0.55, stone);
  for (let k = 0; k < 6; k++) b.box(0.145, 0.005, 0.805, -0.55, y0 + 0.1 + k * 0.1, -0.55, shade(stone, 0.9));
  // Terrace: infinity pool with a glowing edge, cabanas, loungers
  b.box(1.8, 0.012, 0.5, -0.05, y0, 0.12, 0xe8e2d6);
  pool(b, -0.2, y0, 0.18, 1.2, 0.32);
  neonOf(b).box(1.2, 0.006, 0.01, -0.2, y0 + 0.03, 0.35, [0.6, 1.8, 2.4], true);
  for (let k = 0; k < 4; k++) put(b, new THREE.BoxGeometry(0.12, 0.012, 0.045), -0.6 + k * 0.22, y0 + 0.03, -0.08, 0xf4f1ea, 'solid', Math.PI / 2, 0, 0.2);
  for (const cx of [0.6, 0.85]) {
    for (const [dx, dz] of [[-0.08, -0.08], [0.08, -0.08], [-0.08, 0.08], [0.08, 0.08]] as const) b.box(0.01, 0.18, 0.01, cx + dx, y0, 0.15 + dz, white);
    b.box(0.2, 0.015, 0.2, cx, y0 + 0.18, 0.15, white);
    b.box(0.14, 0.03, 0.14, cx, y0, 0.15, 0xe8e2d6);
  }
  // Helipad with an H, edge lights and the helicopter
  const hx = 0.8;
  const hz = 0.72;
  b.cylinder(0.4, 0.42, 0.035, hx, 0.04, hz, 0x4a525e, 24);
  arcLine(b, hx, 0.077, hz, 0.34, 0, Math.PI * 2, 0.02, 0xf2c84b, 24);
  flat(b, 'solid', hx - 0.07, 0.077, hz, 0.025, 0.2, 0xf4f1ea);
  flat(b, 'solid', hx + 0.07, 0.077, hz, 0.025, 0.2, 0xf4f1ea);
  flat(b, 'solid', hx, 0.077, hz, 0.14, 0.025, 0xf4f1ea);
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    quadBlob(neonOf(b), hx + Math.cos(a) * 0.4, 0.085, hz + Math.sin(a) * 0.4, 0.01, [0.6, 2.4, 0.8]);
  }
  helicopter(b, hx + 0.05, 0.077, hz - 0.02, pick(r, [0x1c2a3a, 0xf4f1ea, 0xd8402e] as const), 0.6);
  // Garden: palms, lawn paths, a beach cabana, lights
  for (const [px, pz] of [[-1.15, 0.85], [-1.15, -0.95], [1.15, -0.95], [0.2, 0.95], [-0.5, 0.9], [1.15, 0.0]] as const) palm(b, r, px, pz, 1.1, 0.04);
  b.box(0.1, 0.006, 0.7, -0.85, 0.04, 0.6, 0xe8dcc0);
  for (let k = 0; k < 5; k++) quadBlob(neonOf(b), -0.92, 0.06, 0.3 + k * 0.14, 0.008, LAMP);
  for (let k = 0; k < 6; k++) bush(b, r, -1.2 + k * 0.08, 0.08, -0.4 + (k % 2) * 0.1, 0.06);
  b.box(0.24, 0.012, 0.18, -0.3, 0.04, 0.85, 0xf1dba4);
  b.cylinder(0.004, 0.004, 0.18, -0.3, 0.052, 0.85, 0xdddddd, 4);
  b.cylinder(0, 0.12, 0.04, -0.3, 0.2, 0.85, 0xf4f1ea, 8);
}

// ─── City state: tents, clouds, plots ──────────────────────────────────────

/** Tents, tarps and carts at the given spots: people making do. */
export function encampment(spots: { x: number; z: number; rot: number }[], seed: number): Built {
  const r = rng(seed);
  const b = new Kit();
  for (const s of spots) {
    const tarp = pick(r, [0x3a6ad8, 0x2f8a6a, 0xe8873a, 0x8a8f99, 0xc84a4a, 0x6a5ac8] as const);
    const c = Math.cos(s.rot);
    const sn = Math.sin(s.rot);
    const roll = r();
    if (roll < 0.55) {
      // Dome tent with a flysheet and an open door
      const g = new THREE.SphereGeometry(0.1, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2);
      put(b, g, s.x, 0.005, s.z, tarp, 'smooth', s.rot, 0, 0, 1.3, 0.75, 1);
      put(b, new THREE.CircleGeometry(0.045, 6, 0, Math.PI), s.x + c * 0.128, 0.006, s.z - sn * 0.128, 0x2a2f38, 'solid', s.rot + Math.PI / 2);
      rod(b, s.x - c * 0.12, 0.005, s.z + sn * 0.12, s.x + c * 0.12, 0.005, s.z - sn * 0.12, 0.002, 0x2a2f38, 3);
    } else if (roll < 0.8) {
      // A tarp lean-to on two poles over a sleeping bag
      for (const k of [-1, 1]) rod(b, s.x - sn * k * 0.1, 0, s.z - c * k * 0.1, s.x - sn * k * 0.1, 0.12, s.z - c * k * 0.1, 0.004, 0x8a6a4a, 3);
      put(b, new THREE.BoxGeometry(0.22, 0.004, 0.18), s.x + c * 0.04, 0.07, s.z - sn * 0.04, tarp, 'solid', s.rot + Math.PI / 2, 0.7);
      b.rbox(0.16, 0.02, 0.06, s.x + c * 0.04, 0.005, s.z - sn * 0.04, pick(r, [0x4a6a3a, 0x8a3a3a, 0x3a4a7a] as const), 0.01, 'smooth', s.rot + Math.PI / 2);
    } else {
      // A shopping cart with belongings and a bedroll
      const cx = s.x;
      const cz = s.z;
      b.box(0.1, 0.004, 0.07, cx, 0.03, cz, 0x9aa3ad, false, s.rot);
      for (const [dx, dz] of [[0.05, 0.035], [-0.05, 0.035], [0.05, -0.035], [-0.05, -0.035]] as const) {
        b.box(0.004, 0.07, 0.004, cx + c * dx + sn * dz, 0.03, cz - sn * dx + c * dz, 0x9aa3ad);
        b.cylinder(0.008, 0.008, 0.006, cx + c * dx + sn * dz, 0.005, cz - sn * dx + c * dz, 0x2a2f38, 5);
      }
      b.box(0.1, 0.004, 0.07, cx, 0.1, cz, 0x9aa3ad, false, s.rot);
      b.blob(0.035, cx, 0.12, cz, pick(r, [0x3a6ad8, 0x2a2f38, 0xe8873a] as const), 'smooth');
      b.rbox(0.14, 0.03, 0.05, cx + sn * 0.1, 0.005, cz + c * 0.1, pick(r, [0x4a6a3a, 0x8a3a3a] as const), 0.012, 'smooth', s.rot);
    }
    if (r() < 0.35) b.box(0.07, 0.06, 0.07, s.x + 0.13, 0.005, s.z + 0.1, 0xa88a5a, false, r()); // a cardboard box
    if (r() < 0.3) {
      // A folding chair and a little potted plant: home is where you make it
      b.box(0.04, 0.004, 0.04, s.x - 0.14, 0.03, s.z + 0.06, pick(r, [0x2f6fa8, 0x3aa36a] as const));
      b.box(0.04, 0.035, 0.004, s.x - 0.14, 0.03, s.z + 0.04, pick(r, [0x2f6fa8, 0x3aa36a] as const));
      b.cylinder(0.012, 0.01, 0.02, s.x - 0.1, 0.005, s.z + 0.12, 0xc0603a, 6);
      b.blob(0.015, s.x - 0.1, 0.035, s.z + 0.12, 0x4f9d3b, 'smooth');
    }
    if (r() < 0.25) quadBlob(neonOf(b), s.x + c * 0.05, 0.03, s.z - sn * 0.05, 0.01, [2.4, 1.6, 0.7], FX.shimmer + r());
  }
  return b.build();
}

/** A bank of soft, layered cumulus over land that isn't open yet. */
export function cloudBank(x: number, z: number, w: number, d: number, seed: number, y = 0.5): Built {
  const r = rng(seed);
  const b = new GeoBuilder();
  const n = Math.max(5, Math.round((w * d) / 1.9));
  const tops = [0xffffff, 0xfdfdfd, 0xf8fbff] as const;
  for (let i = 0; i < n; i++) {
    const cx = x + (r() - 0.5) * w * 0.9;
    const cz = z + (r() - 0.5) * d * 0.9;
    const s = 0.5 + r() * 0.35;
    // Flat, slightly shadowed base
    for (let k = 0; k < 3; k++) {
      const g = new THREE.IcosahedronGeometry(s * (0.8 + r() * 0.3), 1).scale(1.4, 0.42, 1.2);
      put(b, g, cx + (r() - 0.5) * s * 1.2, y, cz + (r() - 0.5) * s * 1.0, [0.82, 0.86, 0.92], 'smooth', r() * 3);
    }
    // Billowing tops
    const puffs = 2 + Math.floor(r() * 3);
    for (let k = 0; k < puffs; k++) {
      const a = r() * Math.PI * 2;
      const rr = s * (0.45 + r() * 0.35);
      const g = new THREE.IcosahedronGeometry(rr, 1).scale(1.05, 0.85 + r() * 0.2, 1.0);
      put(b, g, cx + Math.cos(a) * s * 0.45, y + s * 0.22 + rr * 0.35, cz + Math.sin(a) * s * 0.4, pick(r, tops), 'smooth', r() * 3);
    }
    const g = new THREE.IcosahedronGeometry(s * 0.55, 1).scale(1, 0.95, 1);
    put(b, g, cx, y + s * 0.45, cz, 0xffffff, 'smooth', r() * 3);
  }
  return b.build();
}

/** An empty plot for sale: graded dirt, survey stakes and string, a sign. */
export function plotMarker(x: number, z: number): Built {
  const b = new Kit();
  b.box(1.9, 0.02, 1.9, x, 0, z, 0xbfa77e);
  b.box(1.7, 0.004, 1.7, x, 0.02, z, 0xc9b48a);
  // Tyre tracks across the dirt
  for (const s of [-1, 1]) b.box(1.5, 0.002, 0.04, x - 0.05, 0.024, z - 0.2 + s * 0.06, 0xb09a72, false, 0.25);
  // Survey stakes with orange flagging, string lines between
  const k = 0.88;
  const corners: [number, number][] = [[-k, -k], [k, -k], [k, k], [-k, k]];
  for (const [dx, dz] of corners) {
    b.box(0.018, 0.1, 0.018, x + dx, 0.02, z + dz, 0xd8c09a);
    b.box(0.03, 0.02, 0.004, x + dx + 0.012, 0.105, z + dz, 0xff6a1a);
  }
  for (let i = 0; i < 4; i++) {
    const [ax, az] = corners[i]!;
    const [cx, cz] = corners[(i + 1) % 4]!;
    rod(b, x + ax, 0.09, z + az, x + cx, 0.09, z + cz, 0.002, 0xf4f1ea, 3);
  }
  // A gravel pile and a traffic cone
  b.cylinder(0.02, 0.14, 0.07, x - 0.5, 0.02, z - 0.45, 0x9a948a, 7);
  b.cylinder(0.005, 0.025, 0.07, x - 0.25, 0.02, z - 0.6, 0xff6a1a, 6);
  b.box(0.05, 0.006, 0.05, x - 0.25, 0.02, z - 0.6, 0xff6a1a);
  // The for-sale sign: two posts, a white board, a red header
  const sx = x + 0.5;
  const sz = z + 0.72;
  for (const s of [-1, 1]) b.box(0.022, 0.36, 0.022, sx + s * 0.15, 0.02, sz, 0xf4f1ea);
  b.box(0.36, 0.2, 0.018, sx, 0.2, sz, 0xf8f6f0);
  b.box(0.36, 0.07, 0.02, sx, 0.33, sz, 0xd8402e);
  pixelText(b, 'solid', 'FOR SALE', sx, 0.365, sz + 0.011, 0, 1, 0.01, 0xffffff);
  pixelText(b, 'solid', 'BUILD HERE', sx, 0.28, sz + 0.0095, 0, 1, 0.0075, 0x2a2f38);
  b.box(0.2, 0.012, 0.004, sx, 0.23, sz + 0.009, 0xd8402e);
  pixelText(b, 'solid', 'FOR SALE', sx, 0.365, sz - 0.011, 0, -1, 0.01, 0xffffff);
  return b.build();
}

// ─── Vehicles ──────────────────────────────────────────────────────────────

/** A fuselage from a radius profile along +x (t = 0 tail … 1 nose). */
function fuselage(b: GeoBuilder, len: number, rad: number, y: number, prof: readonly [number, number][], color: ColorLike, segs = 14, squash = 1) {
  const pts = prof.map(([t, k]) => new THREE.Vector2(Math.max(0.0005, k * rad), t * len));
  const g = new THREE.LatheGeometry(pts, segs);
  g.rotateZ(-Math.PI / 2);
  g.scale(1, squash, 1);
  g.translate(-len / 2, y, 0);
  b.transformed(g, new THREE.Matrix4(), color, 'smooth');
}

/** One wing (side ±1): root at (x, y, 0), planform from chords and sweep, with dihedral. */
function wing(b: GeoBuilder, side: number, x: number, y: number, rootZ: number, span: number, root: number, tip: number, sweep: number, dihedral: number, thick: number, color: ColorLike, bucket: Bucket = 'smooth') {
  const s = side;
  const pts: XZ[] = [
    [0, 0],
    [-root, 0],
    [-sweep - tip, s * span],
    [-sweep, s * span],
  ];
  const shape = new THREE.Shape(pts.map(([px, pz]) => new THREE.Vector2(px, -pz)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  g.translate(0, -thick / 2, 0);
  put(b, g, x, y, rootZ * s, color, bucket, 0, -s * dihedral);
}

/** Wingtip position for a wing built by `wing`. */
function tipOf(side: number, x: number, y: number, rootZ: number, span: number, sweep: number, tip: number, dihedral: number): [number, number, number] {
  return [x - sweep - tip / 2, y + Math.sin(dihedral) * span, side * (rootZ + Math.cos(dihedral) * span)];
}

/** A turbofan nacelle along +x. */
function nacelle(b: GeoBuilder, x: number, y: number, z: number, len: number, rad: number, color: ColorLike) {
  const g = new THREE.LatheGeometry([new THREE.Vector2(rad * 0.7, 0), new THREE.Vector2(rad * 0.95, len * 0.2), new THREE.Vector2(rad, len * 0.6), new THREE.Vector2(rad * 0.92, len * 0.95), new THREE.Vector2(rad * 0.85, len)], 12);
  g.rotateZ(-Math.PI / 2);
  g.translate(x - len / 2, y, z);
  b.transformed(g, new THREE.Matrix4(), color, 'smooth');
  // Intake: dark fan face
  put(b, new THREE.CircleGeometry(rad * 0.82, 12), x + len / 2 + 0.001, y, z, 0x2a2f38, 'solid', Math.PI / 2);
  put(b, new THREE.CircleGeometry(rad * 0.3, 8), x + len / 2 + 0.003, y, z, 0xc9ced6, 'solid', Math.PI / 2);
  put(b, new THREE.CircleGeometry(rad * 0.6, 10), x - len / 2 - 0.001, y, z, 0x3a3f4a, 'solid', -Math.PI / 2);
}

/** Cabin windows along both sides, lit at night. */
function cabinWindows(b: GeoBuilder, r: () => number, x0: number, x1: number, y: number, rad: number, n: number, size: number, round = false) {
  for (let k = 0; k < n; k++) {
    const wx = x0 + ((x1 - x0) * (k + 0.5)) / n;
    for (const s of [-1, 1]) {
      if (round) put(winOf(b), new THREE.CircleGeometry(size / 2, 8), wx, y, s * (rad + 0.002), [2.2, 1.6, 0.9], 'glow', s > 0 ? 0 : Math.PI);
      else wall(winOf(b), 'glow', wx, y, s * (rad + 0.002), 0, s, size, size * 1.2, [2.2, 1.6, 0.9], wr(r, 0.85, TINT.smoke));
    }
  }
}

/** Landing gear leg with wheels at (x, z), reaching up to y. */
function gear(b: GeoBuilder, x: number, z: number, y: number, wheel: number, pair = true) {
  b.box(0.012, y - wheel, 0.012, x, wheel, z, 0xc9ced6);
  for (const s of pair ? [-1, 1] : [0]) put(b, new THREE.CylinderGeometry(wheel, wheel, 0.016, 10), x, wheel, z + s * 0.014, 0x1e2026, 'solid', 0, Math.PI / 2);
}

/** Navigation lights: red port (−z), green starboard (+z), white tail, red beacon. */
function navLights(b: GeoBuilder, left: [number, number, number], right: [number, number, number], tail: [number, number, number], beaconAt: [number, number, number]) {
  quadBlob(neonOf(b), left[0], left[1], left[2], 0.012, [3.2, 0.3, 0.2]);
  quadBlob(neonOf(b), right[0], right[1], right[2], 0.012, [0.3, 3.0, 0.6]);
  quadBlob(neonOf(b), tail[0], tail[1], tail[2], 0.01, [3, 3, 3], FX.blink + 0.5);
  quadBlob(neonOf(b), beaconAt[0], beaconAt[1], beaconAt[2], 0.012, RED_LIGHT, FX.blink);
}

const LIVERIES = [
  { body: 0xf6f6f2, main: 0x1c2a4a, accent: 0xd4af37 },
  { body: 0xf6f6f2, main: 0xd8402e, accent: 0x2a2f38 },
  { body: 0x1c1f26, main: 0xd4af37, accent: 0xf6f6f2 },
  { body: 0xf6f6f2, main: 0x2f8a6a, accent: 0xf2c84b },
  { body: 0xe9edf2, main: 0x2f6fa8, accent: 0x8fd0f2 },
] as const;

/** Planes face +x and rest on their wheels at y = 0. */
export function plane(model: string, seed: number): Built {
  const r = rng(seed);
  const b = new Kit();
  const liv = pick(r, LIVERIES);
  if (model === 'prop') propPlane(b, r, liv);
  else if (model === 'jet-super') supersonic(b, r, liv);
  else bizJet(b, r, liv, model === 'jet-long' ? 1.85 : 1.4);
  const built = b.build();
  built.group.traverse((o) => (o.castShadow = true));
  return built;
}

type Livery = (typeof LIVERIES)[number];

/** King Air-ish twin turboprop with a T-tail. */
function propPlane(b: Kit, r: () => number, liv: Livery) {
  const len = 1.0;
  const rad = 0.062;
  const y = 0.15;
  fuselage(b, len, rad, y, [[0, 0.15], [0.08, 0.45], [0.3, 0.92], [0.6, 1], [0.8, 0.95], [0.9, 0.75], [0.97, 0.4], [1, 0.05]], liv.body, 14);
  // Cheatline and belly
  wall(b, 'solid', 0.0, y - 0.01, rad + 0.001, 0, 1, len * 0.75, 0.014, liv.main);
  wall(b, 'solid', 0.0, y - 0.01, -rad - 0.001, 0, -1, len * 0.75, 0.014, liv.main);
  wall(b, 'solid', 0.0, y - 0.025, rad - 0.004, 0, 1, len * 0.7, 0.006, liv.accent);
  wall(b, 'solid', 0.0, y - 0.025, -rad + 0.004, 0, -1, len * 0.7, 0.006, liv.accent);
  cabinWindows(b, r, -0.18, 0.15, y + 0.015, rad * 0.95, 5, 0.022, true);
  // Windscreen
  for (const s of [-1, 1]) put(b, new THREE.PlaneGeometry(0.06, 0.03), 0.33, y + 0.03, s * rad * 0.62, 0x1c2a3a, 'glass', s > 0 ? -0.75 : Math.PI + 0.75, -0.5);
  // Low wings with engines and props
  for (const s of [-1, 1]) {
    wing(b, s, 0.12, y - 0.04, rad * 0.6, 0.55, 0.17, 0.08, 0.04, 0.08, 0.016, liv.body);
    const ez = s * 0.2;
    nacelle(b, 0.08, y - 0.02, ez, 0.26, 0.034, liv.body);
    put(b, new THREE.ConeGeometry(0.02, 0.05, 8), 0.235, y - 0.02, ez, liv.main, 'smooth', 0, 0, -Math.PI / 2);
    for (let k = 0; k < 4; k++) put(b, new THREE.BoxGeometry(0.006, 0.17, 0.016), 0.215, y - 0.02, ez, 0x2a2f38, 'solid', 0, (k * Math.PI) / 4, 0);
    put(b, new THREE.CylinderGeometry(0.09, 0.09, 0.002, 18), 0.218, y - 0.02, ez, [0.5, 0.52, 0.55], 'glass', 0, 0, Math.PI / 2);
    gear(b, 0.06, ez, y - 0.05, 0.024);
  }
  const tl = tipOf(-1, 0.12, y - 0.04, rad * 0.6, 0.55, 0.04, 0.08, 0.08);
  const tr = tipOf(1, 0.12, y - 0.04, rad * 0.6, 0.55, 0.04, 0.08, 0.08);
  // T-tail
  profile(b, [[0, 0], [0.12, 0], [0.06, 0.18], [-0.02, 0.18]], 0.012, -len / 2 + 0.06, y + 0.02, 0, 0, liv.main);
  for (const s of [-1, 1]) wing(b, s, -len / 2 + 0.05, y + 0.2, 0.004, 0.17, 0.07, 0.04, 0.03, 0, 0.01, liv.body);
  gear(b, 0.4, 0, y - 0.05, 0.018, false);
  navLights(b, [tl[0], tl[1], tl[2]], [tr[0], tr[1], tr[2]], [-len / 2, y + 0.04, 0], [0, y + rad + 0.01, 0]);
}

/** Gulfstream / Global-style business jet: swept wings with winglets, T-tail, rear engines. */
function bizJet(b: Kit, r: () => number, liv: Livery, len: number) {
  const rad = len * 0.058;
  const y = 0.17;
  fuselage(b, len, rad, y, [[0, 0.08], [0.06, 0.4], [0.2, 0.85], [0.35, 1], [0.75, 1], [0.86, 0.9], [0.94, 0.62], [0.985, 0.25], [1, 0.02]], liv.body, 16);
  // Livery: a swoosh along the side, a painted tail
  for (const s of [-1, 1]) {
    quad4(b, 'solid', [[-len * 0.45, y - rad * 0.2, s * rad * 0.99], [len * 0.1, y - rad * 0.75, s * rad * 0.7], [len * 0.1, y - rad * 0.6, s * rad * 0.82], [-len * 0.45, y + rad * 0.05, s * rad * 1.0]], liv.main, [0, 0, s]);
    quad4(b, 'solid', [[-len * 0.45, y + rad * 0.05, s * rad * 1.0], [len * 0.1, y - rad * 0.6, s * rad * 0.82], [len * 0.1, y - rad * 0.52, s * rad * 0.87], [-len * 0.45, y + rad * 0.15, s * rad * 1.0]], liv.accent, [0, 0, s]);
  }
  cabinWindows(b, r, -len * 0.18, len * 0.24, y + rad * 0.18, rad * 0.985, len > 1.6 ? 8 : 6, rad * 0.42, true);
  // Cockpit glass
  for (const s of [-1, 1]) put(b, new THREE.PlaneGeometry(rad * 1.1, rad * 0.4), len * 0.4, y + rad * 0.42, s * rad * 0.58, 0x1c2a3a, 'glass', s > 0 ? -0.65 : Math.PI + 0.65, -0.55);
  // Swept wings, winglets
  const span = len * 0.5;
  const wx = len * 0.08;
  const sweep = span * 0.55;
  for (const s of [-1, 1]) {
    wing(b, s, wx, y - rad * 0.6, rad * 0.7, span, len * 0.2, len * 0.06, sweep, 0.07, 0.014, 0xe6e9ee);
    const t = tipOf(s, wx, y - rad * 0.6, rad * 0.7, span, sweep, len * 0.06, 0.07);
    profile(b, [[0, 0], [len * 0.06, 0], [len * 0.01, len * 0.06], [-len * 0.02, len * 0.06]], 0.006, t[0] - len * 0.03, t[1], t[2], 0, liv.main);
  }
  const tl = tipOf(-1, wx, y - rad * 0.6, rad * 0.7, span, sweep, len * 0.06, 0.07);
  const tr = tipOf(1, wx, y - rad * 0.6, rad * 0.7, span, sweep, len * 0.06, 0.07);
  // Rear engines on pylons
  for (const s of [-1, 1]) {
    nacelle(b, -len * 0.3, y + rad * 0.35, s * (rad + 0.05), len * 0.17, rad * 0.5, liv.body);
    b.box(len * 0.08, 0.01, 0.05, -len * 0.3, y + rad * 0.3, s * (rad + 0.015), liv.body);
    wall(b, 'solid', -len * 0.3, y + rad * 0.35, s * (rad + 0.05 + rad * 0.5 + 0.001), 0, s, len * 0.1, 0.008, liv.main);
  }
  // T-tail: swept fin with the stabiliser on top
  const fh = len * 0.2;
  profile(b, [[0, 0], [len * 0.16, 0], [len * 0.02, fh], [-len * 0.05, fh]], 0.014, -len / 2 + len * 0.06, y + rad * 0.5, 0, 0, liv.main);
  for (const s of [-1, 1]) wing(b, s, -len / 2 + len * 0.02, y + rad * 0.5 + fh, 0.006, len * 0.15, len * 0.07, len * 0.035, len * 0.06, -0.05, 0.01, liv.main);
  pixelText(b, 'solid', 'N' + String(100 + Math.floor(r() * 899)) + 'TT', -len / 2 + len * 0.13, y + rad * 0.5 + fh * 0.4, 0.008, 0, 1, 0.005, liv.accent);
  pixelText(b, 'solid', 'N' + String(100 + Math.floor(r() * 899)) + 'TT', -len / 2 + len * 0.13, y + rad * 0.5 + fh * 0.4, -0.008, 0, -1, 0.005, liv.accent);
  // Gear
  gear(b, len * 0.36, 0, y - rad, 0.018, false);
  for (const s of [-1, 1]) gear(b, wx - len * 0.12, s * (rad + 0.05), y - rad * 0.6, 0.024);
  navLights(b, [tl[0], tl[1], tl[2]], [tr[0], tr[1], tr[2]], [-len / 2 + 0.02, y + rad * 0.5 + fh, 0], [0, y + rad + 0.006, 0]);
}

/** Concorde-like: slender body, ogival delta, droop nose, four engines in two nacelles. */
function supersonic(b: Kit, r: () => number, liv: Livery) {
  const len = 2.0;
  const rad = 0.06;
  const y = 0.26;
  fuselage(b, len * 0.88, rad, y, [[0, 0.1], [0.05, 0.55], [0.15, 0.95], [0.75, 1], [0.86, 0.85], [0.94, 0.55], [1, 0.3]], liv.body, 14);
  // Drooped nose
  const nose = new THREE.LatheGeometry([new THREE.Vector2(rad * 0.3, 0), new THREE.Vector2(rad * 0.22, len * 0.06), new THREE.Vector2(rad * 0.1, len * 0.11), new THREE.Vector2(0.001, len * 0.13)], 10);
  nose.rotateZ(-Math.PI / 2);
  put(b, nose, len * 0.44 - 0.005, y + 0.0, 0, liv.body, 'smooth', 0, 0, -0.18);
  for (const s of [-1, 1]) put(b, new THREE.PlaneGeometry(0.06, 0.018), len * 0.41, y + rad * 0.55, s * rad * 0.55, 0x1c2a3a, 'glass', s > 0 ? -0.6 : Math.PI + 0.6, -0.5);
  for (const s of [-1, 1]) wall(b, 'solid', -0.1, y + rad * 0.05, s * (rad + 0.001), 0, s, len * 0.6, 0.012, liv.main);
  cabinWindows(b, r, -0.6, 0.35, y + rad * 0.3, rad * 0.98, 14, 0.014);
  // Ogival delta wing
  const half: XZ[] = [];
  for (let k = 0; k <= 10; k++) {
    const t = k / 10;
    half.push([0.45 - t * 1.0, 0.03 + Math.pow(t, 0.75) * 0.5]);
  }
  const outline: XZ[] = [[0.5, 0], ...half, [-0.62, 0.53], [-0.68, 0.45], [-0.66, 0]];
  const full: XZ[] = [...outline, ...outline.slice(1, -1).reverse().map(([px, pz]) => [px, -pz] as XZ)];
  const shape = new THREE.Shape(full.map(([px, pz]) => new THREE.Vector2(px, -pz)));
  const wg = new THREE.ExtrudeGeometry(shape, { depth: 0.018, bevelEnabled: false });
  wg.rotateX(-Math.PI / 2);
  put(b, wg, 0, y - rad * 0.7, 0, 0xeef0f2, 'smooth');
  // Engine nacelles (two pairs, boxy) under the wing
  for (const s of [-1, 1]) {
    b.rbox(0.42, 0.05, 0.12, -0.42, y - rad * 0.7 - 0.05, s * 0.2, 0xd8dce0, 0.012, 'smooth');
    for (const k of [-1, 1]) put(b, new THREE.CircleGeometry(0.02, 8), -0.632, y - rad * 0.7 - 0.025, s * 0.2 + k * 0.03, 0x3a3f4a, 'solid', -Math.PI / 2);
    gear(b, -0.3, s * 0.2, y - rad * 0.7 - 0.05, 0.03);
  }
  gear(b, 0.6, 0, y - rad, 0.022, true);
  // Tall swept fin
  profile(b, [[0, 0], [0.32, 0], [0.08, 0.3], [-0.02, 0.3]], 0.014, -len * 0.44 + 0.04, y + rad * 0.6, 0, 0, liv.main);
  wall(b, 'solid', -len * 0.44 + 0.2, y + rad * 0.6 + 0.12, 0.008, 0, 1, 0.12, 0.012, liv.accent);
  wall(b, 'solid', -len * 0.44 + 0.2, y + rad * 0.6 + 0.12, -0.008, 0, -1, 0.12, 0.012, liv.accent);
  navLights(b, [-0.62, y - rad * 0.7, -0.53], [-0.62, y - rad * 0.7, 0.53], [-len * 0.44, y + rad * 0.6, 0], [0, y + rad + 0.006, 0]);
}

const AIRLINES = [
  { name: 'BAY AIR', body: 0xf6f6f2, tail: 0x1aa0a0, stripe: 0xf2b53a },
  { name: 'PACIFICA', body: 0xf6f6f2, tail: 0x1c2a5a, stripe: 0xd8402e },
  { name: 'FOGLINE', body: 0xe9edf2, tail: 0x6a5ac8, stripe: 0xff8ab0 },
  { name: 'GOLDEN GATE', body: 0xf6f6f2, tail: 0xc8402e, stripe: 0xd4af37 },
  { name: 'SURFBIRD', body: 0xf6f6f2, tail: 0x2f8fd8, stripe: 0x5dd0a0 },
] as const;

/** An A320/737-class airliner facing +x, ~2.4 long, wheels at y = 0, in a seeded airline livery. */
export function airliner(seed: number): Built {
  const r = rng(seed);
  const b = new Kit();
  const al = pick(r, AIRLINES);
  const len = 2.4;
  const rad = 0.13;
  const y = 0.25;
  fuselage(b, len, rad, y, [[0, 0.06], [0.04, 0.3], [0.14, 0.82], [0.22, 1], [0.84, 1], [0.92, 0.85], [0.97, 0.55], [0.995, 0.2], [1, 0.02]], al.body, 18);
  // Belly and the cheatline stripes
  for (const s of [-1, 1]) {
    quad4(b, 'solid', [[-len * 0.42, y - rad * 0.32, s * rad * 0.95], [len * 0.4, y - rad * 0.32, s * rad * 0.95], [len * 0.4, y - rad * 0.22, s * rad * 0.98], [-len * 0.42, y - rad * 0.22, s * rad * 0.98]], al.stripe, [0, 0, s]);
    quad4(b, 'solid', [[-len * 0.42, y - rad * 0.2, s * rad * 0.985], [len * 0.4, y - rad * 0.2, s * rad * 0.985], [len * 0.4, y - rad * 0.16, s * rad * 0.99], [-len * 0.42, y - rad * 0.16, s * rad * 0.99]], al.tail, [0, 0, s]);
    pixelText(b, 'solid', al.name, len * 0.05, y + rad * 0.62, s * rad * 0.8, 0, s, 0.012, al.tail);
  }
  put(b, new THREE.CylinderGeometry(rad * 0.96, rad * 0.96, len * 0.6, 14, 1, true, Math.PI * 0.65, Math.PI * 0.7), 0, y, 0, 0xc9ced6, 'smooth', 0, 0, Math.PI / 2);
  cabinWindows(b, r, -len * 0.32, len * 0.33, y + rad * 0.2, rad * 0.985, 26, 0.016);
  for (const s of [-1, 1]) {
    wall(b, 'solid', len * 0.36, y, s * rad * 0.99, 0, s, 0.04, 0.09, 0xd8dce0);
    wall(b, 'solid', -len * 0.33, y, s * rad * 0.97, 0, s, 0.04, 0.09, 0xd8dce0);
  }
  for (const s of [-1, 1]) put(b, new THREE.PlaneGeometry(0.07, 0.035), len * 0.455, y + rad * 0.42, s * rad * 0.55, 0x1c2a3a, 'glass', s > 0 ? -0.7 : Math.PI + 0.7, -0.45);
  // Wings with dihedral and sharklets; flap track fairings
  const span = 1.0;
  const wx = len * 0.08;
  const sweep = 0.42;
  const dih = 0.1;
  for (const s of [-1, 1]) {
    wing(b, s, wx, y - rad * 0.65, rad * 0.75, span, 0.52, 0.14, sweep, dih, 0.024, 0xe6e9ee);
    const t = tipOf(s, wx, y - rad * 0.65, rad * 0.75, span, sweep, 0.14, dih);
    profile(b, [[0, 0], [0.14, 0], [0.04, 0.12], [-0.02, 0.12]], 0.008, t[0] - 0.06, t[1], t[2], 0, al.tail);
    for (let k = 1; k < 4; k++) {
      const u = k / 4;
      b.rbox(0.12, 0.02, 0.018, wx - 0.45 - sweep * u + 0.05, y - rad * 0.65 - 0.02 + Math.sin(dih) * span * u, s * (rad * 0.75 + span * u), 0xd8dce0, 0.008);
    }
    // Underwing turbofan on a pylon
    const ez = s * (rad * 0.75 + span * 0.36);
    const ex = wx - sweep * 0.36 + 0.12;
    const ey = y - rad * 0.65 + Math.sin(dih) * span * 0.36 - 0.075;
    nacelle(b, ex, ey, ez, 0.32, 0.068, al.body);
    wall(b, 'solid', ex + 0.06, ey, ez + s * 0.0685, 0, s, 0.14, 0.035, al.tail);
    b.box(0.2, 0.06, 0.016, ex - 0.04, ey + 0.04, ez, al.body);
    // Main gear
    gear(b, wx - 0.3, s * (rad + 0.08), y - rad * 0.7, 0.04);
  }
  const tl = tipOf(-1, wx, y - rad * 0.65, rad * 0.75, span, sweep, 0.14, dih);
  const tr = tipOf(1, wx, y - rad * 0.65, rad * 0.75, span, sweep, 0.14, dih);
  // Tail: fin with the airline colour, stabilisers on the fuselage, APU cone
  const fh = 0.44;
  profile(b, [[0, 0], [0.42, 0], [0.12, fh], [-0.02, fh]], 0.02, -len / 2 + 0.12, y + rad * 0.5, 0, 0, al.tail);
  put(b, new THREE.CircleGeometry(0.06, 14), -len / 2 + 0.33, y + rad * 0.5 + fh * 0.45, 0.0105, al.stripe, 'solid', 0);
  put(b, new THREE.CircleGeometry(0.06, 14), -len / 2 + 0.33, y + rad * 0.5 + fh * 0.45, -0.0105, al.stripe, 'solid', Math.PI);
  for (const s of [-1, 1]) wing(b, s, -len / 2 + 0.3, y + rad * 0.1, rad * 0.4, 0.36, 0.24, 0.09, 0.2, 0.08, 0.016, 0xe6e9ee);
  gear(b, len * 0.36, 0, y - rad, 0.03, true);
  navLights(b, [tl[0], tl[1], tl[2]], [tr[0], tr[1], tr[2]], [-len / 2, y, 0], [0, y + rad + 0.008, 0]);
  quadBlob(neonOf(b), 0, y - rad - 0.006, 0, 0.012, RED_LIGHT, FX.blink + 0.5);
  // Landing lights
  for (const s of [-1, 1]) quadBlob(neonOf(b), wx - 0.05, y - rad * 0.65, s * (rad + 0.12), 0.012, [3, 3, 2.6]);
  const built = b.build();
  built.group.traverse((o) => (o.castShadow = true));
  return built;
}

/** A sleek hull: stations from stern to bow, waterline at y = 0. */
function hull(b: GeoBuilder, len: number, beam: number, free: number, draft: number, top: ColorLike, bottom: ColorLike, boot: ColorLike, deckColor: ColorLike, sheer = 0.04) {
  const N = 14;
  const st: { x: number; hb: number; dk: number; kl: number }[] = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const hb = (beam / 2) * (u < 0.55 ? 0.94 + 0.06 * Math.sin((u / 0.55) * Math.PI * 0.5) : Math.sqrt(Math.max(0, 1 - Math.pow((u - 0.55) / 0.45, 2.2))));
    st.push({ x: -len / 2 + u * len, hb: Math.max(hb, 0.002), dk: free + sheer * u * u, kl: -draft * (u < 0.8 ? 1 : Math.max(0.05, (1 - u) / 0.2)) });
  }
  // Section points from deck edge down to keel (for one side), by fraction
  const sec = (s: (typeof st)[number], side: number) => [
    [s.hb, s.dk],
    [s.hb * 0.99, s.dk * 0.5],
    [s.hb * 0.95, 0.0],
    [s.hb * 0.93, -0.012],
    [s.hb * 0.7, s.kl * 0.6],
    [0, s.kl],
  ].map(([z, y]) => [s.x, y!, side * z!] as [number, number, number]);
  for (const side of [-1, 1]) {
    const rows = st.map((s) => sec(s, side));
    const band = (c0: number, c1: number, color: ColorLike) => {
      for (let i = 0; i < N; i++) {
        for (let c = c0; c < c1; c++) {
          const p00 = rows[i]![c]!;
          const p01 = rows[i]![c + 1]!;
          const p10 = rows[i + 1]![c]!;
          const p11 = rows[i + 1]![c + 1]!;
          quad4(b, 'smooth', [p00, p10, p11, p01], color, [0, -0.2, side]);
        }
      }
    };
    band(0, 2, top);
    band(2, 3, boot);
    band(3, 5, bottom);
  }
  // Deck and transom
  for (let i = 0; i < N; i++) {
    const a = st[i]!;
    const c = st[i + 1]!;
    quad4(b, 'solid', [[a.x, a.dk, -a.hb], [c.x, c.dk, -c.hb], [c.x, c.dk, c.hb], [a.x, a.dk, a.hb]], deckColor, [0, 1, 0]);
  }
  const s0 = st[0]!;
  const tr = sec(s0, 1);
  const tl = sec(s0, -1);
  for (let c = 0; c < 5; c++) quad4(b, 'solid', [tl[c]!, tl[c + 1]!, tr[c + 1]!, tr[c]!], top, [-1, 0, 0]);
  return st;
}

/** Yachts face +x, waterline at y = 0. */
export function yacht(size: 'day' | 'super', seed: number): Built {
  const r = rng(seed);
  const b = new Kit();
  if (size === 'super') superyacht(b, r);
  else dayYacht(b, r);
  const built = b.build();
  built.group.traverse((o) => (o.castShadow = true));
  return built;
}

function dayYacht(b: Kit, r: () => number) {
  const len = 1.3;
  const beam = 0.36;
  const hullC = pick(r, [0xf6f6f2, 0x1c2a4a, 0xe9e2d0, 0x2a3a3a] as const);
  const dark = hullC === 0x1c2a4a || hullC === 0x2a3a3a;
  hull(b, len, beam, 0.13, 0.08, hullC, 0x1a1e26, dark ? 0xd4af37 : 0x1c2a4a, 0xb9895a, 0.05);
  const teak = 0xb9895a;
  const white = 0xf6f6f2;
  // Swim platform
  b.box(0.08, 0.015, beam * 0.86, -len / 2 - 0.035, 0.03, 0, teak);
  // Low cabin with a raked windscreen and a hardtop
  const y = 0.135;
  loft(b, [
    { pts: [[-0.25, -0.15], [0.12, -0.14], [0.26, -0.06], [0.28, 0.0], [0.26, 0.06], [0.12, 0.14], [-0.25, 0.15]], y },
    { pts: [[-0.24, -0.13], [0.05, -0.12], [0.14, -0.05], [0.15, 0.0], [0.14, 0.05], [0.05, 0.12], [-0.24, 0.13]], y: y + 0.08 },
  ], white, 'smooth');
  loft(b, [
    { pts: [[0.0, -0.135], [0.13, -0.125], [0.25, -0.055], [0.265, 0.0], [0.25, 0.055], [0.13, 0.125], [0.0, 0.135]], y: y + 0.02 },
    { pts: [[0.0, -0.125], [0.06, -0.115], [0.145, -0.048], [0.155, 0.0], [0.145, 0.048], [0.06, 0.115], [0.0, 0.125]], y: y + 0.075 },
  ], 0x1c2a3a, 'glass', false);
  for (const s of [-1, 1]) wall(winOf(b), 'glow', -0.12, y + 0.045, s * 0.146, 0, s, 0.18, 0.03, [2.2, 1.6, 0.9], wr(r, 1, TINT.smoke));
  b.box(0.36, 0.012, 0.28, -0.12, y + 0.17, 0, white);
  for (const s of [-1, 1]) rod(b, -0.28, y + 0.0, s * 0.12, -0.2, y + 0.17, s * 0.12, 0.006, 0xd8dce0, 4);
  rod(b, -0.05, y + 0.17, 0, -0.05, y + 0.24, 0, 0.004, 0xd8dce0, 3);
  b.box(0.04, 0.012, 0.012, -0.05, y + 0.24, 0, 0xf4f1ea);
  // Bow sunpad, cockpit seating, rails
  b.rbox(0.18, 0.025, 0.16, 0.38, 0.14, 0, 0xf4ecd8, 0.012);
  b.rbox(0.08, 0.04, 0.24, -0.38, 0.13, 0, 0xf4ecd8, 0.015);
  b.box(0.12, 0.02, 0.06, -0.3, 0.14, 0.08, 0xf4ecd8);
  for (const s of [-1, 1]) {
    const pts: [number, number, number][] = [];
    for (let k = 0; k <= 4; k++) {
      const u = 0.6 + k * 0.09;
      const hb = (beam / 2) * Math.sqrt(Math.max(0, 1 - Math.pow((u - 0.55) / 0.45, 2.2))) * 0.92;
      pts.push([-len / 2 + u * len, 0.13 + 0.05 * u * u + 0.04, s * hb]);
    }
    for (let k = 0; k < pts.length - 1; k++) rod(b, ...pts[k]!, ...pts[k + 1]!, 0.003, 0xd8dce0, 3);
    for (const p of pts) rod(b, p[0], p[1] - 0.04, p[2], p[0], p[1], p[2], 0.002, 0xd8dce0, 3);
  }
  // Outboards
  for (const s of [-1, 1]) b.rbox(0.05, 0.1, 0.04, -len / 2 - 0.02, 0.0, s * 0.06, 0x2a2f38, 0.012);
  // Nav lights and an underwater glow
  quadBlob(neonOf(b), 0.0, 0.15, -0.15, 0.008, [3.2, 0.3, 0.2]);
  quadBlob(neonOf(b), 0.0, 0.15, 0.15, 0.008, [0.3, 3.0, 0.6]);
  quadBlob(neonOf(b), -0.05, y + 0.25, 0, 0.008, [3, 3, 3]);
}

function superyacht(b: Kit, r: () => number) {
  const len = 2.6;
  const beam = 0.5;
  const hullC = pick(r, [0x1c2a3a, 0xf6f6f2, 0x2a2f38] as const);
  hull(b, len, beam, 0.17, 0.12, hullC, 0x1a1e26, 0xd4af37, 0xb9895a, 0.06);
  const white = 0xf6f6f2;
  const glass = 0x1c2a3a;
  // A deck outline in plan: aft square, sides, a rounded/pointed front
  const outline = (x0: number, x1: number, hw: number, nose: number): XZ[] => {
    const pts: XZ[] = [[x0, -hw]];
    for (let k = 0; k <= 6; k++) {
      const a = -Math.PI / 2 + (k / 6) * Math.PI;
      pts.push([x1 - nose + Math.cos(a) * nose, Math.sin(a) * hw]);
    }
    pts.push([x0, hw]);
    return pts;
  };
  const decks: [number, number, number, number, number][] = [
    // x0, x1, half width, height, nose
    [-0.95, 0.55, 0.22, 0.11, 0.3],
    [-0.75, 0.32, 0.2, 0.1, 0.28],
    [-0.45, 0.12, 0.17, 0.09, 0.24],
  ];
  let y = 0.17;
  decks.forEach(([x0, x1, hw, h, nose], i) => {
    const lo = outline(x0, x1, hw, nose);
    const hi = outline(x0 + 0.02, x1 - 0.06, hw * 0.98, nose * 0.9);
    loft(b, [{ pts: lo, y }, { pts: hi, y: y + h }], white, 'solid', false);
    // Tinted glass band wrapping the deck, lit at night
    const band = scalePts(lo, 1.004, 1.03, (x0 + x1) / 2, 0);
    loft(b, [{ pts: band, y: y + h * 0.3 }, { pts: scalePts(hi, 1.004, 1.03, (x0 + x1) / 2, 0), y: y + h * 0.8 }], glass, 'glass', false);
    facade(b, r, band, y + h * 0.3, scalePts(hi, 1.004, 1.03, (x0 + x1) / 2, 0), y + h * 0.8, { floors: 1, bay: 0.08, winH: 0.9, winW: 0.9, lit: 0.85, light: [2.2, 1.6, 0.9], tint: TINT.smoke, out: 0.003 });
    // Overhanging deck slab
    prism(b, outline(x0 - 0.08, x1 + 0.03, hw + 0.02, nose + 0.03), y + h, 0.018, white);
    if (i < 2) neonRing(b, outline(x0 - 0.08, x1 + 0.03, hw + 0.02, nose + 0.03), y + h + 0.009, 0.008, [2.4, 2.2, 1.8]);
    y += h + 0.018;
  });
  // Bridge with wraparound dark glass, radar mast and domes
  const bx = 0.05;
  b.box(0.16, 0.06, 0.26, bx, y, 0, glass, 'glass');
  b.box(0.2, 0.012, 0.3, bx, y + 0.06, 0, white);
  profile(b, [[-0.06, 0], [0.06, 0], [0.0, 0.18], [-0.05, 0.18]], 0.03, bx - 0.02, y + 0.07, 0, 0, white);
  b.box(0.2, 0.008, 0.02, bx - 0.04, y + 0.2, 0, white);
  for (const s of [-1, 1]) b.blob(0.03, bx - 0.04, y + 0.24, s * 0.06, white, 'smooth', 1);
  quadBlob(neonOf(b), bx - 0.04, y + 0.27, 0, 0.01, [3, 3, 3], FX.blink + 0.2);
  // Sundeck: a jacuzzi and loungers
  pool(b, -0.3, y, 0, 0.12, 0.12);
  for (let k = 0; k < 3; k++) put(b, new THREE.BoxGeometry(0.1, 0.01, 0.04), -0.2 + k * 0.0, y + 0.01, -0.12 + k * 0.12, 0xf4ecd8, 'solid', 0, 0, 0.15);
  // Foredeck helipad
  const hx = 0.82;
  b.cylinder(0.16, 0.16, 0.01, hx, 0.23 + 0.01, 0, 0x4a525e, 20);
  arcLine(b, hx, 0.252, 0, 0.13, 0, Math.PI * 2, 0.012, 0xf2c84b, 20);
  flat(b, 'solid', hx - 0.03, 0.252, 0, 0.1, 0.012, 0xf4f1ea, Math.PI / 2);
  flat(b, 'solid', hx + 0.03, 0.252, 0, 0.1, 0.012, 0xf4f1ea, Math.PI / 2);
  flat(b, 'solid', hx, 0.252, 0, 0.012, 0.06, 0xf4f1ea, Math.PI / 2);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    quadBlob(neonOf(b), hx + Math.cos(a) * 0.16, 0.255, Math.sin(a) * 0.16, 0.006, [0.6, 2.4, 0.8]);
  }
  // Stern: swim platform, the tender in its garage door, steps
  b.box(0.12, 0.02, beam * 0.8, -len / 2 - 0.05, 0.04, 0, 0xb9895a);
  b.rbox(0.28, 0.05, 0.1, -len / 2 + 0.1, 0.18, 0.12, 0x2a2f38, 0.025, 'smooth');
  b.rbox(0.24, 0.03, 0.09, -len / 2 + 0.1, 0.2, 0.12, 0xf4f1ea, 0.015, 'smooth');
  for (let k = 0; k < 3; k++) b.box(0.03, 0.02, 0.2, -len / 2 + 0.02 + k * 0.03, 0.06 + k * 0.03, -0.08, 0xb9895a);
  // Nav lights
  quadBlob(neonOf(b), 0.3, 0.3, -0.24, 0.01, [3.2, 0.3, 0.2]);
  quadBlob(neonOf(b), 0.3, 0.3, 0.24, 0.01, [0.3, 3.0, 0.6]);
  quadBlob(neonOf(b), -len / 2, 0.2, 0, 0.01, [3, 3, 3]);
}

/** Starship-like stack: stainless booster with grid fins, hot-stage ring, ship with flaps; engines at y = 0. */
export function rocket(seed: number): Built {
  void seed;
  const b = new Kit();
  const steel = 0xc9ced6;
  const rad = 0.17;
  const tile = 0x1e2026;
  // Engine skirt and bells
  b.cylinder(rad * 0.96, rad * 0.9, 0.12, 0, 0.0, 0, 0x8a929c, 20, 'glass');
  for (let k = 0; k < 9; k++) {
    const a = (k / 8) * Math.PI * 2;
    const rr = k === 8 ? 0 : rad * 0.55;
    b.cylinder(0.022, 0.04, 0.07, Math.cos(a) * rr, -0.02, Math.sin(a) * rr, 0x5a5f68, 8);
  }
  // Booster with weld lines
  const bh = 2.5;
  b.cylinder(rad, rad, bh, 0, 0.12, 0, steel, 24, 'glass');
  for (let k = 1; k < 10; k++) b.cylinder(rad + 0.002, rad + 0.002, 0.004, 0, 0.12 + k * (bh / 10), 0, 0xaab2bc, 24);
  // Chines and grid fins near the top of the booster
  for (const s of [-1, 1]) b.box(0.02, 0.9, 0.03, 0, 0.3, s * (rad + 0.012), 0xaab2bc);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    const g = new THREE.BoxGeometry(0.14, 0.1, 0.012);
    put(b, g, Math.cos(a) * (rad + 0.06), 0.12 + bh - 0.22, Math.sin(a) * (rad + 0.06), 0x6a7380, 'solid', -a + Math.PI / 2);
    for (let j = 0; j < 3; j++) put(b, new THREE.BoxGeometry(0.004, 0.1, 0.014), Math.cos(a) * (rad + 0.06) - Math.sin(a) * (j - 1) * 0.04, 0.12 + bh - 0.22, Math.sin(a) * (rad + 0.06) + Math.cos(a) * (j - 1) * 0.04, 0x3a3f4a, 'solid', -a + Math.PI / 2);
  }
  // Hot-staging ring: vented, dark
  const hy = 0.12 + bh;
  b.cylinder(rad, rad, 0.1, 0, hy, 0, 0x3a3f4a, 24);
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    wall(b, 'solid', Math.cos(a) * (rad + 0.002), hy + 0.05, Math.sin(a) * (rad + 0.002), Math.cos(a), Math.sin(a), 0.05, 0.06, 0x8a929c);
  }
  // Ship: steel, heat-shield tiles on the windward side, flaps, nose
  const sy = hy + 0.1;
  const sh = 1.45;
  b.cylinder(rad, rad, sh, 0, sy, 0, steel, 24, 'glass');
  put(b, new THREE.CylinderGeometry(rad + 0.003, rad + 0.003, sh, 24, 1, true, Math.PI * 0.5, Math.PI), 0, sy + sh / 2, 0, tile);
  for (let k = 1; k < 6; k++) b.cylinder(rad + 0.002, rad + 0.002, 0.004, 0, sy + k * (sh / 6), 0, 0xaab2bc, 24);
  const nose = new THREE.LatheGeometry([new THREE.Vector2(rad, 0), new THREE.Vector2(rad * 0.98, 0.12), new THREE.Vector2(rad * 0.88, 0.28), new THREE.Vector2(rad * 0.66, 0.44), new THREE.Vector2(rad * 0.36, 0.58), new THREE.Vector2(0.002, 0.66)], 24);
  put(b, nose, 0, sy + sh, 0, steel, 'glass');
  const nt = new THREE.LatheGeometry([new THREE.Vector2(rad + 0.003, 0), new THREE.Vector2(rad * 0.98 + 0.003, 0.12), new THREE.Vector2(rad * 0.88 + 0.003, 0.28), new THREE.Vector2(rad * 0.66 + 0.003, 0.44), new THREE.Vector2(rad * 0.36 + 0.002, 0.58), new THREE.Vector2(0.004, 0.66)], 12, Math.PI * 0.5, Math.PI);
  put(b, nt, 0, sy + sh, 0, tile);
  // Aft flaps (big) and forward flaps (small), on the tiled side's edges
  for (const s of [-1, 1]) {
    profile(b, [[0, 0], [0.16, 0], [0.12, 0.34], [0, 0.4]], 0.016, s * (rad + 0.05), sy + 0.05, 0, Math.PI / 2, 0x2a2f38);
    profile(b, [[0, 0], [0.1, 0], [0.07, 0.2], [0, 0.24]], 0.012, s * (rad * 0.8 + 0.035), sy + sh + 0.18, 0, Math.PI / 2, 0x2a2f38);
  }
  // A small flag and the name, a light on top
  b.box(0.004, 0.05, 0.08, rad + 0.001, sy + sh * 0.6, -0.0, 0x2f4a8a);
  pixelText(b, 'solid', 'TINYTOWN', -rad - 0.002, sy + sh * 0.55, 0, -1, 0, 0.008, 0x1c1f26, { vertical: true });
  quadBlob(neonOf(b), 0, sy + sh + 0.68, 0, 0.015, RED_LIGHT, FX.blink + 0.1);
  const built = b.build();
  built.group.traverse((o) => (o.castShadow = true));
  return built;
}

