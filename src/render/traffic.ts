import * as THREE from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLOW, glassMaterial } from './geo.ts';
import { bridgeLanes } from './landmarks.ts';
import { PITCH, blockCentre, type BlockCoord } from '../world/layout.ts';
import { AIRPORT_ROAD, BAY_APPROACH, EMBARCADERO, GREAT_HIGHWAY, MARKET_START, PRESIDIO_PKWY, coastDistance, terrainHeight, type Pt } from '../world/map.ts';
import { rng } from '../world/rng.ts';

/**
 * Street life: cars, buses and cabs on a lane graph with all-way stops,
 * streams of commuters over both bridges, and people on the pavements.
 *
 * Every vehicle model is a handful of InstancedMeshes (tinted paint, trim,
 * glass, lights), so the whole city's traffic is a few dozen draw calls.
 * Cars only appear or vanish at the edges of the network (the bridges, the
 * airport, the Great Highway) or by fading in and out in place.
 */

// ═══ Models ════════════════════════════════════════════════════════════════

type V2 = readonly [number, number];
type Bucket = 'paint' | 'detail' | 'glass' | 'lights';
type Rgb = readonly [number, number, number];
const tmpC = new THREE.Color();

const TYRE = 0x1b1c20;
const TRIM = 0x26282d;
const CHROME = 0xc9ccd2;
const RIM = 0xaeb3ba;
const PLATE = 0xeeeee6;
const GLASS = 0x1c2733;
/** Lights are HDR: dimmed to plastic by day, blooming at night. */
const HEAD: Rgb = [3.0, 2.85, 2.4];
const TAIL: Rgb = [2.6, 0.12, 0.08];
const AMBER: Rgb = [2.8, 1.5, 0.2];

/** Collects parts per material bucket and merges them. Models face +x and rest on y = 0. */
class Parts {
  readonly b: Record<Bucket, THREE.BufferGeometry[]> = { paint: [], detail: [], glass: [], lights: [] };

  add(bucket: Bucket, g: THREE.BufferGeometry, color: number | Rgb, tail = 0) {
    const geo = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal') geo.deleteAttribute(k);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    if (typeof color === 'number') tmpC.setHex(color);
    else tmpC.setRGB(color[0], color[1], color[2]);
    const n = geo.attributes.position!.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([tmpC.r, tmpC.g, tmpC.b], i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (bucket === 'lights') geo.setAttribute('aTail', new THREE.BufferAttribute(new Float32Array(n).fill(tail), 1));
    this.b[bucket].push(geo);
  }

  /** Box centred on (x, y, z). */
  box(bucket: Bucket, w: number, h: number, d: number, x: number, y: number, z: number, color: number | Rgb, tail = 0) {
    this.add(bucket, new THREE.BoxGeometry(w, h, d).translate(x, y, z), color, tail);
  }

  /** A flat four-cornered panel, wound to face `out`. */
  quad(bucket: Bucket, c: readonly (readonly [number, number, number])[], out: readonly [number, number, number], color: number | Rgb, tail = 0) {
    const a = c[0]!, b = c[1]!, cc = c[2]!, d = c[3]!;
    const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!, uz = b[2]! - a[2]!;
    const vx = cc[0]! - a[0]!, vy = cc[1]! - a[1]!, vz = cc[2]! - a[2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const flip = nx * out[0] + ny * out[1] + nz * out[2] < 0;
    const order = flip ? [a, cc, b, a, d, cc] : [a, b, cc, a, cc, d];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(order.flatMap((p) => [p[0]!, p[1]!, p[2]!]), 3));
    g.computeVertexNormals();
    this.add(bucket, g, color, tail);
  }

  /** A flat polygon in the x-y plane on the side of the car at ±z, facing outward. */
  pane(bucket: Bucket, poly: readonly V2[], z: number, color: number | Rgb) {
    for (const s of [1, -1]) {
      const shape = new THREE.Shape(poly.map(([x, y]) => new THREE.Vector2(x * s, y)));
      const g = new THREE.ShapeGeometry(shape);
      if (s < 0) g.rotateY(Math.PI);
      g.translate(0, 0, z * s);
      this.add(bucket, g, color);
    }
  }

  build(): Record<Bucket, THREE.BufferGeometry> {
    const out = {} as Record<Bucket, THREE.BufferGeometry>;
    for (const k of ['paint', 'detail', 'glass', 'lights'] as const) {
      out[k] = this.b[k].length ? mergeGeometries(this.b[k])! : new THREE.BufferGeometry();
    }
    return out;
  }
}

function area(poly: readonly V2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i]!;
    const [x1, y1] = poly[(i + 1) % poly.length]!;
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/** Offsets a simple polygon outward (d > 0) or inward (d < 0) with mitred corners. */
function offsetPoly(poly: readonly V2[], d: number): V2[] {
  const s = area(poly) > 0 ? 1 : -1;
  const n = poly.length;
  return poly.map(([x, y], i) => {
    const [ax, ay] = poly[(i - 1 + n) % n]!;
    const [cx, cy] = poly[(i + 1) % n]!;
    let e1x = x - ax, e1y = y - ay;
    let e2x = cx - x, e2y = cy - y;
    const l1 = Math.hypot(e1x, e1y) || 1, l2 = Math.hypot(e2x, e2y) || 1;
    e1x /= l1; e1y /= l1; e2x /= l2; e2y /= l2;
    // Outward normals: (dy, -dx) for a counter-clockwise polygon.
    const n1x = e1y * s, n1y = -e1x * s, n2x = e2y * s, n2y = -e2x * s;
    let mx = n1x + n2x, my = n1y + n2y;
    const ml = Math.hypot(mx, my) || 1;
    mx /= ml; my /= ml;
    const k = d / Math.max(0.35, mx * n1x + my * n1y);
    return [x + mx * k, y + my * k] as const;
  });
}

/** Clips a polygon to x0 ≤ x ≤ x1 (Sutherland–Hodgman). */
function clipX(poly: readonly V2[], x0: number, x1: number): V2[] {
  let out: V2[] = [...poly];
  for (const [edge, keep] of [[x0, 1], [x1, -1]] as const) {
    const inp = out;
    out = [];
    for (let i = 0; i < inp.length; i++) {
      const p = inp[i]!;
      const q = inp[(i + 1) % inp.length]!;
      const pin = (p[0] - edge) * keep >= 0;
      const qin = (q[0] - edge) * keep >= 0;
      if (pin) out.push(p);
      if (pin !== qin) {
        const t = (edge - p[0]) / (q[0] - p[0]);
        out.push([edge, p[1] + (q[1] - p[1]) * t]);
      }
    }
  }
  return out;
}

/** A side profile extruded across the car, with rounded (bevelled, crease-smoothed) edges. */
function extrude(profile: readonly V2[], width: number, bevel: number, segments: number): THREE.BufferGeometry {
  const inner = offsetPoly(profile, -bevel);
  const shape = new THREE.Shape(inner.map(([x, y]) => new THREE.Vector2(x, y)));
  const depth = Math.max(0.002, width - 2 * bevel);
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: segments, curveSegments: 3, steps: 1 });
  g.translate(0, 0, -depth / 2);
  g.deleteAttribute('uv');
  return toCreasedNormals(g, 0.95);
}

interface Spec {
  L: number;
  W: number;
  /** Wheel radius, ground clearance, axle positions. */
  rw: number;
  clear: number;
  axles: number[];
  /** Upper silhouette from the rear bottom corner over the top to the front bottom corner. */
  top: V2[];
  /** Greenhouse (pillars and roof), closed polygon; null when the body includes it. */
  cabin: V2[] | null;
  cabinW: number;
  /** Side windows split at these x (B/C pillars). */
  pillars: number[];
  /** Rims: chrome, dark or aero. */
  rim: number;
  /** Glass roof (EVs). */
  glassRoof?: boolean;
}

/** Bottom edge from the front back to the rear, with a wheel arch over each axle. */
function bottom(s: Spec): V2[] {
  const out: V2[] = [];
  const ra = s.rw + 0.006;
  for (const ax of [...s.axles].sort((a, b) => b - a)) {
    out.push([ax + ra, s.clear]);
    for (let k = 0; k <= 4; k++) {
      const a = (k / 4) * Math.PI;
      out.push([ax + ra * Math.cos(a), s.rw * 0.92 + ra * Math.sin(a)]);
    }
    out.push([ax - ra, s.clear]);
  }
  return out;
}

/** Glass on each slanted or flat face of a profile polygon (windscreen, rear window, roof). */
function faceGlass(p: Parts, poly: readonly V2[], halfW: number, inset: number, roof: boolean) {
  const cx = poly.reduce((a, q) => a + q[0], 0) / poly.length;
  const cy = poly.reduce((a, q) => a + q[1], 0) / poly.length;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const l = Math.hypot(ex, ey);
    if (l < 0.012) continue;
    let nx = ey / l, ny = -ex / l;
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }
    const isRoof = ny > 0.85;
    const isGlass = Math.abs(nx) > 0.3 && ny > -0.2 && Math.min(a[1], b[1]) > cy - 0.04;
    if (!(isGlass || (roof && isRoof))) continue;
    const t = Math.min(inset, l * 0.2) / l;
    const ax = a[0] + ex * t + nx * 0.0012, ay = a[1] + ey * t + ny * 0.0012;
    const bx = b[0] - ex * t + nx * 0.0012, by = b[1] - ey * t + ny * 0.0012;
    const hw = halfW - inset;
    p.quad('glass', [[ax, ay, -hw], [bx, by, -hw], [bx, by, hw], [ax, ay, hw]], [nx, ny, 0], GLASS);
  }
}

function wheels(p: Parts, s: Spec) {
  const tw = Math.min(0.03, s.W * 0.16);
  for (const ax of s.axles) {
    for (const side of [1, -1]) {
      const z = side * (s.W / 2 - tw / 2 - 0.004);
      p.add('detail', new THREE.CylinderGeometry(s.rw, s.rw, tw, 10, 1, true).rotateX(Math.PI / 2).translate(ax, s.rw, z), TYRE);
      const face = new THREE.CircleGeometry(s.rw * 0.98, 10);
      const hub = new THREE.CircleGeometry(s.rw * 0.62, 8);
      if (side < 0) { face.rotateY(Math.PI); hub.rotateY(Math.PI); }
      p.add('detail', face.translate(ax, s.rw, z + side * tw / 2), TYRE);
      p.add('detail', hub.translate(ax, s.rw, z + side * (tw / 2 + 0.0012)), s.rim);
    }
  }
}

/** Body, greenhouse, side glass, wheels and the common trim. */
function car(p: Parts, s: Spec, opts: { bevel?: number; paint?: number } = {}) {
  const bevel = opts.bevel ?? 0.011;
  const profile = [...s.top, ...bottom(s)];
  p.add('paint', extrude(profile, s.W, bevel, 1), opts.paint ?? 0xffffff);
  if (s.cabin) {
    const cb = 0.008;
    p.add('paint', extrude(s.cabin, s.cabinW, cb, 2), opts.paint ?? 0xffffff);
    // Side windows: the greenhouse's flat side, inset to leave pillars, split at the B/C pillars.
    const inner = offsetPoly(s.cabin, -(cb + 0.004));
    const belt = Math.min(...s.cabin.map((q) => q[1]));
    const winPoly = inner.map(([x, y]) => [x, Math.max(y, belt + 0.006)] as const);
    const xs = [Math.min(...winPoly.map((q) => q[0])) - 1, ...s.pillars, Math.max(...winPoly.map((q) => q[0])) + 1];
    for (let i = 0; i < xs.length - 1; i++) {
      const piece = clipX(winPoly, xs[i]! + (i ? 0.005 : 0), xs[i + 1]! - (i < xs.length - 2 ? 0.005 : 0));
      if (piece.length >= 3 && Math.abs(area(piece)) > 1e-5) p.pane('glass', piece, s.cabinW / 2 + 0.0009, GLASS);
    }
    faceGlass(p, s.cabin, s.cabinW / 2 - cb, 0.008, !!s.glassRoof);
    // A dark belt-line trim where the greenhouse meets the body.
    const xs0 = Math.min(...s.cabin.map((q) => q[0])) + 0.004;
    const xs1 = Math.max(...s.cabin.map((q) => q[0])) - 0.004;
    for (const side of [1, -1]) {
      const z = side * (s.cabinW / 2 + 0.001);
      p.quad('detail', [[xs0, belt + 0.001, z], [xs1, belt + 0.001, z], [xs1, belt + 0.006, z], [xs0, belt + 0.006, z]], [0, 0, side], TRIM);
    }
  }
  wheels(p, s);
}

/** Lamps: boxes set into the nose and tail at (x, y), mirrored across the car. */
function lamps(p: Parts, x: number, y: number, z: number, w: number, h: number, color: Rgb, tail: number, depth = 0.012) {
  for (const side of [1, -1]) p.box('lights', depth, h, w, x, y, side * z, color, tail);
}

/** Bumpers, plates and mirrors. */
function trim(p: Parts, s: Spec, o: { front: number; rear: number; plateY: number; mirrorX: number; mirrorY: number; bumper?: number }) {
  const bw = s.W * 0.94;
  p.box('detail', 0.016, 0.014, bw, o.front - 0.006, s.clear + 0.008, 0, o.bumper ?? TRIM);
  p.box('detail', 0.016, 0.014, bw, o.rear + 0.006, s.clear + 0.008, 0, o.bumper ?? TRIM);
  p.box('detail', 0.004, 0.011, 0.034, o.front + 0.001, o.plateY, 0, PLATE);
  p.box('detail', 0.004, 0.011, 0.034, o.rear - 0.001, o.plateY, 0, PLATE);
  // Door mirrors hang off the greenhouse (or the cab of a van) just above the belt.
  const mz = (s.cabin ? s.cabinW / 2 : s.W / 2) + 0.005;
  for (const side of [1, -1]) {
    p.box('paint', 0.012, 0.009, 0.016, o.mirrorX, o.mirrorY, side * mz, 0xffffff);
    p.box('detail', 0.003, 0.006, 0.011, o.mirrorX - 0.0065, o.mirrorY, side * (mz + 0.002), TRIM);
  }
}

/** Dark sills between the wheels. */
function sills(p: Parts, s: Spec, color = TRIM) {
  const [a, b] = [Math.min(...s.axles), Math.max(...s.axles)];
  const ra = s.rw + 0.012;
  for (const side of [1, -1]) {
    const z = side * (s.W / 2 + 0.0008);
    const y0 = s.clear + 0.001, y1 = s.clear + 0.011;
    p.quad('detail', [[a + ra, y0, z], [b - ra, y0, z], [b - ra, y1, z], [a + ra, y1, z]], [0, 0, side], color);
  }
}

export type CarModel = 'sedan' | 'hatch' | 'suv' | 'pickup' | 'taxi' | 'van' | 'bus' | 'sports' | 'ev';
export const CAR_MODELS: readonly CarModel[] = ['sedan', 'hatch', 'suv', 'pickup', 'taxi', 'van', 'bus', 'sports', 'ev'];

const SEDAN: Spec = {
  L: 0.34, W: 0.165, rw: 0.031, clear: 0.022, axles: [-0.105, 0.11],
  top: [[-0.17, 0.03], [-0.172, 0.062], [-0.166, 0.079], [-0.12, 0.084], [-0.085, 0.086], [0.06, 0.086], [0.14, 0.078], [0.166, 0.068], [0.172, 0.046], [0.168, 0.03]],
  cabin: [[-0.094, 0.082], [-0.056, 0.121], [0.0, 0.124], [0.02, 0.122], [0.07, 0.082]],
  cabinW: 0.148, pillars: [-0.022], rim: RIM,
};

function sedanLike(p: Parts, s: Spec) {
  car(p, s);
  trim(p, s, { front: s.L / 2, rear: -s.L / 2, plateY: 0.042, mirrorX: 0.058, mirrorY: 0.09 });
  sills(p, s);
  // Grille between the headlights
  p.box('detail', 0.006, 0.014, 0.056, 0.169, 0.056, 0, TRIM);
  p.box('detail', 0.003, 0.002, 0.058, 0.172, 0.064, 0, CHROME);
  lamps(p, 0.165, 0.062, 0.058, 0.03, 0.011, HEAD, 0);
  lamps(p, -0.166, 0.068, 0.058, 0.034, 0.012, TAIL, 1);
}

function buildModel(kind: CarModel): Record<Bucket, THREE.BufferGeometry> {
  const p = new Parts();
  switch (kind) {
    case 'sedan':
      sedanLike(p, SEDAN);
      break;
    case 'taxi': {
      sedanLike(p, SEDAN);
      // Roof sign (lit at night), a checker band and the company number.
      p.box('detail', 0.03, 0.004, 0.012, -0.018, 0.126, 0, TRIM);
      p.box('lights', 0.03, 0.016, 0.07, -0.018, 0.136, 0, [2.8, 2.5, 1.6]);
      for (const side of [1, -1]) {
        const z = side * (SEDAN.W / 2 + 0.0012);
        for (let k = 0; k < 8; k++) {
          const x0 = -0.07 + k * 0.016;
          for (const row of [0, 1]) {
            if ((k + row) % 2) continue;
            const y0 = 0.058 + row * 0.006;
            p.quad('detail', [[x0, y0, z], [x0 + 0.016, y0, z], [x0 + 0.016, y0 + 0.006, z], [x0, y0 + 0.006, z]], [0, 0, side], 0x15161a);
          }
        }
      }
      break;
    }
    case 'hatch': {
      const s: Spec = {
        L: 0.29, W: 0.158, rw: 0.03, clear: 0.022, axles: [-0.092, 0.09],
        top: [[-0.145, 0.03], [-0.147, 0.068], [-0.142, 0.085], [0.045, 0.087], [0.112, 0.079], [0.14, 0.066], [0.146, 0.044], [0.141, 0.03]],
        cabin: [[-0.144, 0.083], [-0.13, 0.122], [0.0, 0.127], [0.012, 0.126], [0.056, 0.083]],
        cabinW: 0.132, pillars: [-0.038], rim: RIM,
      };
      car(p, s);
      trim(p, s, { front: s.L / 2, rear: -s.L / 2, plateY: 0.044, mirrorX: 0.046, mirrorY: 0.09 });
      sills(p, s);
      p.box('detail', 0.006, 0.012, 0.05, 0.143, 0.052, 0, TRIM);
      lamps(p, 0.137, 0.064, 0.054, 0.03, 0.012, HEAD, 0);
      lamps(p, -0.142, 0.078, 0.06, 0.022, 0.016, TAIL, 1, 0.014);
      p.box('detail', 0.03, 0.005, 0.11, -0.13, 0.126, 0, TRIM); // roof spoiler
      break;
    }
    case 'suv': {
      const s: Spec = {
        L: 0.36, W: 0.178, rw: 0.036, clear: 0.03, axles: [-0.116, 0.118],
        top: [[-0.178, 0.036], [-0.18, 0.086], [-0.175, 0.099], [0.06, 0.101], [0.14, 0.095], [0.174, 0.086], [0.18, 0.052], [0.176, 0.036]],
        cabin: [[-0.176, 0.097], [-0.168, 0.148], [0.022, 0.151], [0.036, 0.149], [0.078, 0.097]],
        cabinW: 0.152, pillars: [-0.036, -0.118], rim: RIM,
      };
      car(p, s);
      trim(p, s, { front: s.L / 2, rear: -s.L / 2, plateY: 0.05, mirrorX: 0.07, mirrorY: 0.106 });
      sills(p, s);
      // Black wheel-arch cladding, roof rails, grille, spare-wheel cover
      for (const ax of s.axles) {
        for (const side of [1, -1]) {
          const z = side * (s.W / 2 + 0.0009);
          const ra = s.rw + 0.016;
          p.quad('detail', [[ax - ra, s.rw + ra * 0.9, z], [ax + ra, s.rw + ra * 0.9, z], [ax + ra, s.rw + ra * 0.9 + 0.006, z], [ax - ra, s.rw + ra * 0.9 + 0.006, z]], [0, 0, side], TRIM);
        }
      }
      for (const side of [1, -1]) p.box('detail', 0.18, 0.006, 0.008, -0.07, 0.154, side * 0.06, CHROME);
      p.box('detail', 0.006, 0.026, 0.07, 0.178, 0.068, 0, TRIM);
      p.box('detail', 0.004, 0.003, 0.072, 0.181, 0.074, 0, CHROME);
      lamps(p, 0.172, 0.084, 0.06, 0.034, 0.012, HEAD, 0);
      lamps(p, -0.176, 0.092, 0.066, 0.024, 0.024, TAIL, 1);
      break;
    }
    case 'pickup': {
      const s: Spec = {
        L: 0.38, W: 0.176, rw: 0.036, clear: 0.03, axles: [-0.122, 0.12],
        top: [[-0.19, 0.036], [-0.192, 0.098], [-0.034, 0.1], [0.07, 0.1], [0.15, 0.094], [0.184, 0.084], [0.19, 0.05], [0.186, 0.036]],
        cabin: [[-0.04, 0.097], [-0.036, 0.146], [0.03, 0.148], [0.046, 0.146], [0.088, 0.097]],
        cabinW: 0.152, pillars: [], rim: CHROME,
      };
      car(p, s);
      trim(p, s, { front: s.L / 2, rear: -s.L / 2, plateY: 0.05, mirrorX: 0.082, mirrorY: 0.106, bumper: CHROME });
      sills(p, s);
      // The bed: a dark liner set into the top of the body, a tailgate seam and a rear cab window.
      p.box('detail', 0.142, 0.004, s.W - 0.028, -0.114, 0.0995, 0, 0x2c2e33);
      p.box('detail', 0.004, 0.004, s.W - 0.02, -0.188, 0.099, 0, TRIM);
      p.box('detail', 0.03, 0.03, 0.074, 0.186, 0.066, 0, CHROME); // big grille
      lamps(p, 0.183, 0.082, 0.064, 0.03, 0.014, HEAD, 0);
      lamps(p, -0.19, 0.084, 0.078, 0.014, 0.03, TAIL, 1, 0.01);
      break;
    }
    case 'van': {
      // A tall delivery van: the body is the whole silhouette, glass only on the cab.
      const s: Spec = {
        L: 0.4, W: 0.178, rw: 0.034, clear: 0.026, axles: [-0.13, 0.135],
        top: [[-0.2, 0.032], [-0.201, 0.18], [-0.194, 0.192], [0.085, 0.192], [0.102, 0.186], [0.146, 0.112], [0.18, 0.1], [0.198, 0.086], [0.2, 0.046], [0.196, 0.032]],
        cabin: null, cabinW: 0, pillars: [], rim: RIM,
      };
      car(p, s, { bevel: 0.012 });
      trim(p, s, { front: s.L / 2, rear: -s.L / 2, plateY: 0.05, mirrorX: 0.13, mirrorY: 0.13 });
      sills(p, s);
      p.quad('glass', [[0.1035 + 0.001, 0.182, -0.077], [0.144 + 0.001, 0.116, -0.077], [0.144 + 0.001, 0.116, 0.077], [0.1035 + 0.001, 0.182, 0.077]], [0.85, 0.52, 0], GLASS);
      p.pane('glass', [[0.06, 0.118], [0.128, 0.118], [0.096, 0.172], [0.06, 0.172]], s.W / 2 + 0.0009, GLASS);
      // Sliding door seam and rear door split
      for (const side of [1, -1]) {
        const z = side * (s.W / 2 + 0.001);
        p.quad('detail', [[0.035, 0.04, z], [0.039, 0.04, z], [0.039, 0.18, z], [0.035, 0.18, z]], [0, 0, side], TRIM);
        p.quad('detail', [[-0.07, 0.04, z], [-0.066, 0.04, z], [-0.066, 0.18, z], [-0.07, 0.18, z]], [0, 0, side], TRIM);
      }
      p.box('detail', 0.004, 0.14, 0.003, -0.201, 0.11, 0, TRIM);
      p.box('detail', 0.006, 0.016, 0.07, 0.198, 0.07, 0, TRIM);
      lamps(p, 0.192, 0.088, 0.066, 0.03, 0.013, HEAD, 0);
      lamps(p, -0.2, 0.07, 0.08, 0.012, 0.05, TAIL, 1, 0.008);
      break;
    }
    case 'bus': {
      // A Muni bus: white, with the red skirt, black window band and the destination sign.
      const s: Spec = {
        L: 0.66, W: 0.19, rw: 0.034, clear: 0.024, axles: [-0.19, 0.2],
        top: [[-0.33, 0.032], [-0.332, 0.19], [-0.325, 0.205], [0.318, 0.205], [0.33, 0.193], [0.334, 0.1], [0.332, 0.032]],
        cabin: null, cabinW: 0, pillars: [], rim: RIM,
      };
      car(p, s, { bevel: 0.014 });
      const red = 0xc8202e;
      const hw = s.W / 2 + 0.0009;
      for (const side of [1, -1]) {
        const z = side * hw;
        // Red skirt along the bottom, and a thin red line under the windows
        p.quad('paint', [[-0.318, 0.034, z], [0.32, 0.034, z], [0.32, 0.078, z], [-0.318, 0.078, z]], [0, 0, side], red);
        p.quad('paint', [[-0.318, 0.088, z], [0.32, 0.088, z], [0.32, 0.093, z], [-0.318, 0.093, z]], [0, 0, side], red);
        // Window band, split into panes
        for (let k = 0; k < 8; k++) {
          const x0 = -0.3 + k * 0.071;
          if (side > 0 && (k === 4 || k === 7)) continue; // doors
          p.quad('glass', [[x0, 0.104, z], [x0 + 0.065, 0.104, z], [x0 + 0.065, 0.176, z], [x0, 0.176, z]], [0, 0, side], GLASS);
        }
      }
      // Doors on the kerb side (+z is the right in our world)
      for (const x0 of [-0.016, 0.197]) p.quad('glass', [[x0, 0.04, hw + 0.0003], [x0 + 0.062, 0.04, hw + 0.0003], [x0 + 0.062, 0.176, hw + 0.0003], [x0, 0.176, hw + 0.0003]], [0, 0, 1], 0x2a3a48);
      // Front: windscreen, sign, red bumper face; rear window and engine grille
      p.quad('glass', [[0.3355, 0.1, -0.084], [0.3355, 0.1, 0.084], [0.3355, 0.178, 0.084], [0.3355, 0.178, -0.084]], [1, 0, 0], GLASS);
      p.quad('lights', [[0.336, 0.182, -0.06], [0.336, 0.182, 0.06], [0.336, 0.195, 0.06], [0.336, 0.195, -0.06]], [1, 0, 0], AMBER);
      p.quad('paint', [[0.3352, 0.034, -0.09], [0.3352, 0.034, 0.09], [0.3352, 0.07, 0.09], [0.3352, 0.07, -0.09]], [1, 0, 0], red);
      p.quad('glass', [[-0.3335, 0.12, -0.06], [-0.3335, 0.12, 0.06], [-0.3335, 0.175, 0.06], [-0.3335, 0.175, -0.06]], [-1, 0, 0], GLASS);
      p.quad('paint', [[-0.3335, 0.034, -0.09], [-0.3335, 0.034, 0.09], [-0.3335, 0.07, 0.09], [-0.3335, 0.07, -0.09]], [-1, 0, 0], red);
      p.box('detail', 0.012, 0.012, s.W * 0.96, 0.33, 0.03, 0, TRIM);
      p.box('detail', 0.012, 0.012, s.W * 0.96, -0.33, 0.03, 0, TRIM);
      // Roof: air-conditioning pod and hybrid battery box
      p.box('detail', 0.16, 0.018, 0.13, -0.18, 0.212, 0, 0xd9dcdf);
      p.box('detail', 0.12, 0.014, 0.12, 0.08, 0.21, 0, 0xd9dcdf);
      // Bike rack on the nose
      p.box('detail', 0.014, 0.022, 0.12, 0.343, 0.06, 0, 0x3a3d44);
      lamps(p, 0.33, 0.05, 0.072, 0.022, 0.012, HEAD, 0);
      lamps(p, -0.331, 0.09, 0.074, 0.016, 0.03, TAIL, 1, 0.008);
      for (const side of [1, -1]) p.box('detail', 0.008, 0.04, 0.006, 0.31, 0.16, side * (s.W / 2 + 0.006), TRIM); // mirrors
      wheels(p, { ...s, axles: [] });
      break;
    }
    case 'sports': {
      const s: Spec = {
        L: 0.36, W: 0.18, rw: 0.032, clear: 0.016, axles: [-0.112, 0.116],
        top: [[-0.18, 0.026], [-0.182, 0.058], [-0.176, 0.071], [-0.13, 0.074], [-0.06, 0.077], [0.05, 0.071], [0.13, 0.058], [0.172, 0.045], [0.18, 0.032], [0.176, 0.02]],
        cabin: [[-0.09, 0.07], [-0.042, 0.094], [0.0, 0.097], [0.014, 0.096], [0.078, 0.066]],
        cabinW: 0.13, pillars: [], rim: 0x34363b,
      };
      car(p, s, { bevel: 0.012 });
      trim(p, s, { front: s.L / 2, rear: -s.L / 2, plateY: 0.04, mirrorX: 0.072, mirrorY: 0.08 });
      sills(p, s, 0x111215);
      // Side intakes, a rear wing on two posts, quad exhausts and a splitter
      p.pane('detail', [[-0.07, 0.042], [-0.035, 0.042], [-0.035, 0.062], [-0.06, 0.062]], s.W / 2 + 0.0011, 0x111215);
      p.box('detail', 0.03, 0.005, 0.17, -0.168, 0.086, 0, 0x111215);
      for (const side of [1, -1]) p.box('detail', 0.006, 0.012, 0.006, -0.162, 0.076, side * 0.06, 0x111215);
      for (const side of [1, -1]) for (const k of [0.02, 0.036]) p.box('detail', 0.006, 0.008, 0.008, -0.182, 0.03, side * k, CHROME);
      p.box('detail', 0.02, 0.004, s.W * 0.9, 0.172, 0.019, 0, 0x111215);
      lamps(p, 0.166, 0.05, 0.062, 0.03, 0.007, HEAD, 0, 0.022);
      lamps(p, -0.179, 0.062, 0.05, 0.05, 0.008, TAIL, 1);
      break;
    }
    case 'ev': {
      // A smooth fastback with a glass roof, no grille and light bars.
      const s: Spec = {
        L: 0.35, W: 0.168, rw: 0.031, clear: 0.02, axles: [-0.11, 0.116],
        top: [[-0.175, 0.03], [-0.177, 0.066], [-0.17, 0.082], [-0.132, 0.087], [0.06, 0.085], [0.145, 0.074], [0.172, 0.06], [0.177, 0.04], [0.171, 0.028]],
        cabin: [[-0.138, 0.083], [-0.076, 0.113], [-0.02, 0.124], [0.03, 0.122], [0.072, 0.082]],
        cabinW: 0.142, pillars: [-0.028], rim: 0xd2d5da, glassRoof: true,
      };
      car(p, s);
      trim(p, s, { front: s.L / 2, rear: -s.L / 2, plateY: 0.044, mirrorX: 0.062, mirrorY: 0.088 });
      sills(p, s);
      p.box('detail', 0.004, 0.008, 0.06, 0.175, 0.034, 0, TRIM); // lower intake only
      lamps(p, 0.164, 0.065, 0.058, 0.032, 0.007, HEAD, 0, 0.016);
      p.box('lights', 0.01, 0.007, s.W * 0.86, -0.172, 0.076, 0, TAIL, 1); // full-width light bar
      break;
    }
  }
  return p.build();
}

export const MODEL_LENGTH: Record<CarModel, number> = { sedan: 0.345, hatch: 0.295, suv: 0.365, pickup: 0.385, taxi: 0.345, van: 0.405, bus: 0.68, sports: 0.365, ev: 0.355 };

// ─── Materials ───────────────────────────────────────────────────────────

/** Screen-door fade: per-instance `aFade` dithers the mesh in and out, no sorting needed. */
function fading<T extends THREE.Material>(m: T, key: string, vert = '', frag = ''): T {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = GLOW.night;
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `attribute float aFade;\nvarying float vFade;\n${vert ? vert.split('@@')[0] : ''}\nvoid main() {\n\tvFade = aFade;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${vert ? vert.split('@@')[1] : ''}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `uniform float uNight;\nvarying float vFade;\n${frag ? frag.split('@@')[0] : ''}\nvoid main() {\n\tif (vFade < 0.999 && vFade < fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))))) discard;`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${frag ? frag.split('@@')[1] : ''}`);
  };
  m.customProgramCacheKey = () => `tinytown-traffic-${key}`;
  return m;
}

const LIGHT_VERT = 'attribute float aTail;\nattribute float aBrake;\nvarying float vTail;\nvarying float vBrake;@@vTail = aTail; vBrake = aBrake;';
const LIGHT_FRAG = 'varying float vTail;\nvarying float vBrake;@@diffuseColor.rgb *= mix(0.3, 1.0, uNight) * (1.0 + vTail * vBrake * mix(2.6, 1.2, uNight));';

function vehicleMaterials() {
  return {
    paint: fading(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.26, metalness: 0.32, envMapIntensity: 0.9, shadowSide: THREE.DoubleSide }), 'paint'),
    detail: fading(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.15, shadowSide: THREE.DoubleSide }), 'detail'),
    glass: fading(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.06, metalness: 0.7, flatShading: true, envMapIntensity: 1.3, shadowSide: THREE.DoubleSide }), 'glass'),
    lights: fading(new THREE.MeshBasicMaterial({ vertexColors: true }), 'lights', LIGHT_VERT, LIGHT_FRAG),
    // The shadow pass dithers too, so a car fading in or out casts a fading shadow.
    depth: fading(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), 'depth'),
  };
}
type VehicleMaterials = ReturnType<typeof vehicleMaterials>;

/** Instanced meshes for one model, sharing their per-instance buffers. */
class Fleet {
  readonly meshes: THREE.InstancedMesh[] = [];
  readonly matrix: THREE.InstancedBufferAttribute;
  readonly fade: THREE.InstancedBufferAttribute;
  readonly brake: THREE.InstancedBufferAttribute;
  readonly color: THREE.InstancedBufferAttribute;
  count = 0;
  readonly tris: number;

  constructor(kind: CarModel, cap: number, mats: VehicleMaterials) {
    const geos = buildModel(kind);
    this.tris = Object.values(geos).reduce((a, g) => a + (g.attributes.position ? g.attributes.position.count / 3 : 0), 0);
    this.matrix = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
    this.matrix.setUsage(THREE.DynamicDrawUsage);
    this.fade = new THREE.InstancedBufferAttribute(new Float32Array(cap).fill(1), 1).setUsage(THREE.DynamicDrawUsage);
    this.brake = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage);
    this.color = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3).setUsage(THREE.DynamicDrawUsage);
    for (const k of ['paint', 'detail', 'glass', 'lights'] as const) {
      const g = geos[k];
      if (!g.attributes.position) continue;
      g.setAttribute('aFade', this.fade);
      if (k === 'lights') g.setAttribute('aBrake', this.brake);
      const m = new THREE.InstancedMesh(g, mats[k], cap);
      m.instanceMatrix = this.matrix;
      if (k === 'paint') m.instanceColor = this.color;
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = k !== 'lights';
      m.receiveShadow = k !== 'lights';
      m.customDepthMaterial = mats.depth;
      m.name = `${kind}-${k}`;
      this.meshes.push(m);
    }
  }

  commit() {
    for (const m of this.meshes) m.count = this.count;
    if (!this.count) return;
    this.matrix.clearUpdateRanges();
    this.matrix.addUpdateRange(0, this.count * 16);
    this.matrix.needsUpdate = true;
    for (const [a, n] of [[this.fade, 1], [this.brake, 1], [this.color, 3]] as const) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.count * n);
      a.needsUpdate = true;
    }
  }
}

// ─── Colours ─────────────────────────────────────────────────────────────

type Palette = readonly (readonly [number, number])[];
/** Real-world car colours: mostly white, black, grey and silver. */
const EVERYDAY: Palette = [
  [0xf1f1ee, 23], [0x18191c, 18], [0x6b6f75, 14], [0xb8bcc2, 13], [0x29467a, 7], [0x1d2a45, 4], [0xa3242a, 7], [0x5a1d25, 2],
  [0x2c4636, 2], [0x8c7b62, 2], [0x5f86aa, 2], [0xd9a72c, 1], [0xd0662a, 1], [0x6f9a3c, 1], [0x7b5c3e, 1],
];
const SPORTY: Palette = [[0xc8161c, 6], [0xf0bf2a, 3], [0x141518, 4], [0xf3f3f0, 3], [0x1b5cc0, 3], [0xe8661c, 2], [0xa7abb2, 2], [0x86c23a, 1], [0x1c4a34, 1]];
const ELECTRIC: Palette = [[0xf3f3f0, 30], [0x141518, 20], [0x5c6066, 16], [0xb3b7bd, 10], [0x214a8c, 10], [0x9c1520, 10]];
const TAXI: Palette = [[0xf5c518, 5], [0xf2b705, 3], [0xf7d23a, 1]];
const VANS: Palette = [[0xf4f4f1, 14], [0xb8bcc2, 3], [0x5b3a20, 2], [0x2f3a4a, 2], [0x6b6f75, 2]];
const TRUCKS: Palette = [[0xf1f1ee, 5], [0x18191c, 5], [0x6b6f75, 3], [0xa3242a, 3], [0x29467a, 3], [0x7a6a52, 2], [0x3d4f3a, 2]];
const BUS: Palette = [[0xf4f4f2, 1]];
const PALETTES: Record<CarModel, Palette> = { sedan: EVERYDAY, hatch: EVERYDAY, suv: EVERYDAY, pickup: TRUCKS, taxi: TAXI, van: VANS, bus: BUS, sports: SPORTY, ev: ELECTRIC };

function weighted<T>(items: readonly (readonly [T, number])[], r: number): T {
  const total = items.reduce((a, [, w]) => a + w, 0);
  let x = r * total;
  for (const [v, w] of items) if ((x -= w) < 0) return v;
  return items[items.length - 1]![0];
}

// ═══ Lane graph ═══════════════════════════════════════════════════════════

/** A road cell from the city's street grid. */
export interface RoadCell {
  x: number;
  z: number;
  kind: 'x' | 'z' | 'cross';
}

interface GNode {
  x: number;
  z: number;
  y: number;
  /** All-way stop: every car stops, then goes in turn. */
  stop: boolean;
  /** Traffic signals (Market Street): two phases, offset along Market for a green wave. */
  signal: boolean;
  offset: number;
  /** Edge of the network: cars appear and vanish here. */
  spawn: boolean;
  roads: Road[];
  conns: Path[];
  inside: Car[];
  waiting: Car[];
  /** A pedestrian is on a crossing here until this time. */
  pedUntil: number;
  /** A car is moving through or about to: pedestrians wait. */
  busyUntil: number;
}

interface Road {
  a: GNode;
  b: GNode;
  /** Centre line from a to b. */
  pts: Pt[];
  hw: number;
  lane: number;
  speed: number;
  y: (x: number, z: number) => number;
  smooth: boolean;
  kind: 'grid' | 'market' | 'art';
}

const LANE = 0;
const CONN = 1;

interface Path {
  kind: typeof LANE | typeof CONN;
  pts: Float32Array;
  cum: Float32Array;
  /** Speed limit at each point (curvature, then smoothed backwards for braking). */
  vlim: Float32Array;
  vmin: number;
  len: number;
  speed: number;
  from: GNode | null;
  to: GNode | null;
  /** For a lane: the connectors leaving its end. For a connector: [the lane it joins]. */
  outs: Path[];
  /** Connector only: where it starts, and which other connectors it crosses. */
  inLane: Path | null;
  conflicts: Set<Path>;
  turn: number;
  weight: number;
  /** Lane only: its signal phase at the node it leads to, and the distance from its centre to the kerb. */
  phase: number;
  kerb: number;
  bridge: boolean;
  /** Bridge tunnel: hidden between these distances. */
  hide: [number, number] | null;
  /** Cars on this path this frame, sorted by s. */
  cars: Car[];
  /** Bridge spawning: distance the last car must have travelled before the next. */
  nextGap: number;
}

const BRAKE = 1.25;
const HARD_BRAKE = 6;
const LAT = 0.55;
const BRIDGE_SPACING = 2.0;

function mkPath(kind: Path['kind'], xyz: number[], speed: number, from: GNode | null, to: GNode | null): Path {
  const n = xyz.length / 3;
  const pts = new Float32Array(xyz);
  const cum = new Float32Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1]! + Math.hypot(pts[i * 3]! - pts[i * 3 - 3]!, pts[i * 3 + 1]! - pts[i * 3 - 2]!, pts[i * 3 + 2]! - pts[i * 3 - 1]!);
  const vlim = new Float32Array(n).fill(speed);
  // Curvature limit at interior points: heading change over the mean segment length.
  for (let i = 1; i < n - 1; i++) {
    const ax = pts[i * 3]! - pts[i * 3 - 3]!, az = pts[i * 3 + 2]! - pts[i * 3 - 1]!;
    const bx = pts[i * 3 + 3]! - pts[i * 3]!, bz = pts[i * 3 + 5]! - pts[i * 3 + 2]!;
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la < 1e-6 || lb < 1e-6) continue;
    const ang = Math.acos(Math.max(-1, Math.min(1, (ax * bx + az * bz) / (la * lb))));
    const k = ang / ((la + lb) / 2);
    if (k > 1e-3) vlim[i] = Math.min(speed, Math.max(0.22, Math.sqrt(LAT / k)));
  }
  for (let i = n - 2; i >= 0; i--) vlim[i] = Math.min(vlim[i]!, Math.sqrt(vlim[i + 1]! ** 2 + 2 * BRAKE * (cum[i + 1]! - cum[i]!)));
  let vmin = speed;
  for (let i = 0; i < n; i++) vmin = Math.min(vmin, vlim[i]!);
  return {
    kind, pts, cum, vlim, vmin, len: cum[n - 1]!, speed, from, to, outs: [], inLane: null, conflicts: new Set(), turn: 0, weight: 1,
    phase: 0, kerb: 0.3, bridge: false, hide: null, cars: [], nextGap: 1,
  };
}

/** Index of the segment containing s. */
function seg(p: Path, s: number): number {
  const c = p.cum;
  let lo = 0;
  let hi = c.length - 2;
  if (hi <= 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c[mid]! <= s) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const P = { x: 0, y: 0, z: 0 };
function at(p: Path, s: number, out = P) {
  s = Math.max(0, Math.min(p.len, s));
  const i = seg(p, s);
  const l = p.cum[i + 1]! - p.cum[i]!;
  const t = l > 1e-6 ? (s - p.cum[i]!) / l : 0;
  const a = i * 3;
  out.x = p.pts[a]! + (p.pts[a + 3]! - p.pts[a]!) * t;
  out.y = p.pts[a + 1]! + (p.pts[a + 4]! - p.pts[a + 1]!) * t;
  out.z = p.pts[a + 2]! + (p.pts[a + 5]! - p.pts[a + 2]!) * t;
  return out;
}

function vlimAt(p: Path, s: number): number {
  const i = seg(p, Math.max(0, Math.min(p.len, s)));
  const l = p.cum[i + 1]! - p.cum[i]!;
  const t = l > 1e-6 ? Math.max(0, Math.min(1, (s - p.cum[i]!) / l)) : 0;
  return p.vlim[i]! + (p.vlim[i + 1]! - p.vlim[i]!) * t;
}

/** Resamples a polyline at roughly `step` spacing. */
function resample(pts: readonly Pt[], step: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i]!;
    const [bx, bz] = pts[i + 1]!;
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

/** Offsets a polyline sideways: positive = to the right of travel (our +x → +z). */
function offsetLine(pts: readonly Pt[], d: number): Pt[] {
  return pts.map(([x, z], i) => {
    const [ax, az] = pts[Math.max(0, i - 1)]!;
    const [bx, bz] = pts[Math.min(pts.length - 1, i + 1)]!;
    let tx = bx - ax, tz = bz - az;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l; tz /= l;
    let k = 1;
    if (i > 0 && i < pts.length - 1) {
      // Mitre: keep the offset constant through bends.
      const [px, pz] = pts[i - 1]!;
      const ux = x - px, uz = z - pz;
      const lu = Math.hypot(ux, uz) || 1;
      k = 1 / Math.max(0.5, (ux / lu) * tx + (uz / lu) * tz);
    }
    return [x - tz * d * k, z + tx * d * k] as const;
  });
}

/** Cuts `a` off the start and `b` off the end of a polyline. */
function trimLine(pts: readonly Pt[], a: number, b: number): Pt[] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
  const total = cum[cum.length - 1]!;
  const s0 = Math.min(a, total * 0.45), s1 = Math.max(total - b, total * 0.55);
  const lerp = (s: number): Pt => {
    let i = 0;
    while (i < pts.length - 2 && cum[i + 1]! < s) i++;
    const t = (s - cum[i]!) / (cum[i + 1]! - cum[i]! || 1);
    return [pts[i]![0] + (pts[i + 1]![0] - pts[i]![0]) * t, pts[i]![1] + (pts[i + 1]![1] - pts[i]![1]) * t];
  };
  const out: Pt[] = [lerp(s0)];
  for (let i = 0; i < pts.length; i++) if (cum[i]! > s0 + 1e-4 && cum[i]! < s1 - 1e-4) out.push(pts[i]!);
  out.push(lerp(s1));
  return out;
}

/** Corner cutting that keeps the end points: smooths kinks in drawn arterials. */
function chaikin(pts: readonly Pt[], iterations = 2): Pt[] {
  let cur = [...pts];
  for (let it = 0; it < iterations; it++) {
    if (cur.length < 3) return cur;
    const next: Pt[] = [cur[0]!];
    for (let i = 0; i < cur.length - 1; i++) {
      const [ax, az] = cur[i]!;
      const [bx, bz] = cur[i + 1]!;
      if (i > 0) next.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25]);
      if (i < cur.length - 2) next.push([ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75]);
    }
    next.push(cur[cur.length - 1]!);
    cur = next;
  }
  return cur;
}

const GRID_Y = 0.021;
const groundY = (lift: number) => (x: number, z: number) => Math.max(GRID_Y, Math.max(0, terrainHeight(x, z)) + lift);

/** Streets with no cars: Powell Street belongs to the cable cars. */
const CAR_FREE = [{ x: -2.5, z0: -12.5, z1: 7.5 }];

interface Graph {
  nodes: GNode[];
  lanes: Path[];
  paths: Path[];
  /** City lanes cars can start on, with cumulative lengths for picking. */
  spots: Path[];
  spotCum: number[];
  sources: Path[];
  bridges: Path[];
}

function key(x: number, z: number) {
  return `${Math.round(x * 10)},${Math.round(z * 10)}`;
}

function buildGraph(cells: readonly RoadCell[]): Graph {
  const nodes = new Map<string, GNode>();
  const node = (x: number, z: number, spawn = false): GNode => {
    const k = key(x, z);
    let n = nodes.get(k);
    if (!n) {
      n = { x, z, y: groundY(0.014)(x, z), stop: false, signal: false, offset: 0, spawn, roads: [], conns: [], inside: [], waiting: [], pedUntil: 0, busyUntil: 0 };
      nodes.set(k, n);
    }
    return n;
  };
  const roads: Road[] = [];
  const road = (a: GNode, b: GNode, pts: Pt[], o: { hw: number; lane: number; speed: number; lift?: number; smooth?: boolean; kind?: Road['kind'] }) => {
    const r: Road = { a, b, pts, hw: o.hw, lane: o.lane, speed: o.speed, y: o.lift === undefined ? () => GRID_Y : groundY(o.lift), smooth: !!o.smooth, kind: o.kind ?? 'grid' };
    roads.push(r);
    a.roads.push(r);
    b.roads.push(r);
    return r;
  };

  // The street grid: a node on every crossing, a road between neighbouring crossings.
  const cellSet = new Set(cells.map((c) => key(c.x, c.z)));
  const crosses = cells.filter((c) => c.kind === 'cross');
  for (const c of crosses) node(c.x, c.z);
  // Where the Presidio Parkway joins the grid, mid-block.
  const pkwyJoin: Pt = [-32.5, 0];
  for (const c of crosses) {
    for (const [dx, dz] of [[PITCH, 0], [0, PITCH]] as const) {
      const ex = c.x + dx, ez = c.z + dz;
      if (!nodes.has(key(ex, ez))) continue;
      let ok = true;
      for (let k = 1; k < PITCH; k++) if (!cellSet.has(key(c.x + (dx * k) / PITCH, c.z + (dz * k) / PITCH))) ok = false;
      if (!ok) continue;
      if (dz && CAR_FREE.some((f) => Math.abs(c.x - f.x) < 0.01 && c.z >= f.z0 - 0.01 && ez <= f.z1 + 0.01)) continue;
      const a = nodes.get(key(c.x, c.z))!;
      const b = nodes.get(key(ex, ez))!;
      if (dz && Math.abs(c.x - pkwyJoin[0]) < 0.01 && c.z < pkwyJoin[1] && ez > pkwyJoin[1]) {
        const m = node(pkwyJoin[0], pkwyJoin[1]);
        road(a, m, [[a.x, a.z], [m.x, m.z]], { hw: 0.5, lane: 0.2, speed: 0.85 });
        road(m, b, [[m.x, m.z], [b.x, b.z]], { hw: 0.5, lane: 0.2, speed: 0.85 });
        continue;
      }
      road(a, b, [[a.x, a.z], [b.x, b.z]], { hw: 0.5, lane: 0.2, speed: 0.85 });
    }
  }
  const has = (x: number, z: number) => nodes.has(key(x, z));

  // The Embarcadero, joined to the airport road in the south and the Presidio Parkway in the west,
  // split where Market Street meets it.
  let ji = 0;
  let best = Infinity;
  let J: Pt = MARKET_START;
  for (let i = 0; i < EMBARCADERO.length - 1; i++) {
    const [ax, az] = EMBARCADERO[i]!;
    const [bx, bz] = EMBARCADERO[i + 1]!;
    const t = Math.max(0, Math.min(1, ((MARKET_START[0] - ax) * (bx - ax) + (MARKET_START[1] - az) * (bz - az)) / ((bx - ax) ** 2 + (bz - az) ** 2)));
    const px = ax + (bx - ax) * t, pz = az + (bz - az) * t;
    const d = Math.hypot(px - MARKET_START[0], pz - MARKET_START[1]);
    if (d < best) {
      best = d;
      ji = i;
      J = [px, pz];
    }
  }
  const art = { hw: 0.5, lane: 0.14, speed: 1.2, lift: 0.014, smooth: true, kind: 'art' as const };
  const junction = node(J[0], J[1]);
  const airport = node(...AIRPORT_ROAD[AIRPORT_ROAD.length - 1]!, true);
  road(airport, junction, [...[...AIRPORT_ROAD].reverse(), ...EMBARCADERO.slice(1, ji + 1), J], art);
  if (has(...pkwyJoin)) {
    const pk = PRESIDIO_PKWY.slice(1, -1);
    road(junction, nodes.get(key(...pkwyJoin))!, [J, ...EMBARCADERO.slice(ji + 1), ...pk, [-33.1, 0.4], pkwyJoin], { ...art, lane: 0.16 });
  }

  // Market Street: crossing the grid diagonally through the crossings on x − z = 10.
  const marketNodes: Pt[] = [];
  for (let k = 1; k > -6; k--) {
    const x = 2.5 + PITCH * k;
    if (has(x, x - 10)) marketNodes.push([x, x - 10]);
  }
  const mkt = { hw: 0.75, lane: 0.6, speed: 1.0, lift: 0.014, kind: 'market' as const };
  let prev = junction;
  for (const [x, z] of marketNodes) {
    const n = nodes.get(key(x, z))!;
    road(prev, n, [[prev.x, prev.z], [x, z]], mkt);
    prev = n;
  }

  // The Bay Bridge approach from Second and Harrison-ish, and the Great Highway along Ocean Beach.
  if (has(...BAY_APPROACH[BAY_APPROACH.length - 1]!)) {
    const end = node(...BAY_APPROACH[0]!, true);
    const start = nodes.get(key(...BAY_APPROACH[BAY_APPROACH.length - 1]!))!;
    road(start, end, [...BAY_APPROACH].reverse(), { hw: 0.55, lane: 0.22, speed: 1.1, lift: 0.016, smooth: true });
  }
  road(node(...GREAT_HIGHWAY[0]!, true), node(...GREAT_HIGHWAY[GREAT_HIGHWAY.length - 1]!, true), [...GREAT_HIGHWAY], { hw: 0.45, lane: 0.2, speed: 1.3, lift: 0.014, smooth: true });

  // Lanes: trim each road back from its ends far enough to clear the other roads at the node.
  const dirAt = (r: Road, n: GNode): Pt => {
    const pts = r.a === n ? r.pts : [...r.pts].reverse();
    let i = 1;
    while (i < pts.length - 1 && Math.hypot(pts[i]![0] - pts[0]![0], pts[i]![1] - pts[0]![1]) < 0.4) i++;
    const dx = pts[i]![0] - pts[0]![0], dz = pts[i]![1] - pts[0]![1];
    const l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  };
  const segDist = (pts: readonly Pt[], x: number, z: number) => {
    let d = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i]!;
      const [bx, bz] = pts[i + 1]!;
      const ex = bx - ax, ez = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
      d = Math.min(d, Math.hypot(x - ax - ex * t, z - az - ez * t));
    }
    return d;
  };
  /** How far back from node n (along `line`, which leads away from it) a lane must stop to clear the crossing roads. */
  const trimOf = (r: Road, n: GNode, line: readonly Pt[]) => {
    if (n.spawn) return 0;
    const [dx, dz] = dirAt(r, n);
    const others = n.roads.filter((o) => {
      if (o === r) return false;
      const [ox, oz] = dirAt(o, n);
      const a = Math.acos(Math.max(-1, Math.min(1, dx * ox + dz * oz)));
      return a > Math.PI / 6 && a < (Math.PI * 5) / 6;
    });
    const near = others.map((o) => (o.pts.length > 2 ? o.pts.filter(([x, z]) => Math.hypot(x - n.x, z - n.z) < 5) : o.pts));
    const cum = [0];
    for (let i = 1; i < line.length; i++) cum.push(cum[i - 1]! + Math.hypot(line[i]![0] - line[i - 1]![0], line[i]![1] - line[i - 1]![1]));
    for (let s = 0.3; s < 1.6; s += 0.02) {
      let i = 0;
      while (i < line.length - 2 && cum[i + 1]! < s) i++;
      const t = Math.min(1, (s - cum[i]!) / (cum[i + 1]! - cum[i]! || 1));
      const x = line[i]![0] + (line[i + 1]![0] - line[i]![0]) * t;
      const z = line[i]![1] + (line[i + 1]![1] - line[i]![1]) * t;
      if (others.every((o, k) => near[k]!.length < 2 || segDist(near[k]!, x, z) >= o.hw + 0.035)) return Math.max(0.5, s);
    }
    return 1.6;
  };
  const lanes: Path[] = [];
  for (const r of roads) {
    const base = r.smooth ? resample(r.pts, 0.5) : r.pts;
    for (const dir of [1, -1] as const) {
      let line = offsetLine(dir > 0 ? base : [...base].reverse(), r.lane);
      const from = dir > 0 ? r.a : r.b;
      const to = dir > 0 ? r.b : r.a;
      line = trimLine(line, trimOf(r, from, line), trimOf(r, to, [...line].reverse()));
      if (r.smooth) line = chaikin(line, 3);
      const xyz = line.flatMap(([x, z]) => [x, r.y(x, z), z]);
      const lane = mkPath(LANE, xyz, r.speed, from, to);
      if (r.lane > 0.4) lane.weight = 1.3;
      // Signal phase at the far end: the major road (Embarcadero, else Market) goes first.
      const major = to.roads.some((q) => q.kind === 'art') ? 'art' : 'market';
      lane.phase = r.kind === major ? 0 : 1;
      lane.kerb = r.hw - r.lane;
      lanes.push(lane);
    }
  }

  // Connectors: a cubic through each junction from every lane in to every lane out.
  const conns: Path[] = [];
  for (const n of nodes.values()) {
    n.signal = !n.spawn && n.roads.length >= 3 && n.roads.some((q) => q.kind === 'market');
    n.stop = !n.spawn && !n.signal && n.roads.length >= 3;
    // Green wave down Market from the Embarcadero.
    if (n.signal) n.offset = Math.hypot(n.x - J[0], n.z - J[1]) / 0.95;
    if (n.spawn) continue;
    const ins = lanes.filter((l) => l.to === n);
    const outs = lanes.filter((l) => l.from === n);
    for (const a of ins) {
      for (const b of outs) {
        const ia = (a.pts.length / 3 - 1) * 3;
        const ax = a.pts[ia]!, ay = a.pts[ia + 1]!, az = a.pts[ia + 2]!;
        let d1x = ax - a.pts[ia - 3]!, d1z = az - a.pts[ia - 1]!;
        const l1 = Math.hypot(d1x, d1z);
        d1x /= l1; d1z /= l1;
        const bx = b.pts[0]!, by = b.pts[1]!, bz = b.pts[2]!;
        let d2x = b.pts[3]! - bx, d2z = b.pts[5]! - bz;
        const l2 = Math.hypot(d2x, d2z);
        d2x /= l2; d2z /= l2;
        const dot = d1x * d2x + d1z * d2z;
        // Same road back the way we came: only at a dead end.
        const uturn = dot < -0.9 && Math.hypot(bx - ax, bz - az) < 0.8;
        if (uturn && outs.length > 1) continue;
        const theta = Math.acos(Math.max(-1, Math.min(1, dot)));
        const chord = Math.hypot(bx - ax, bz - az);
        const h = theta < 0.05 ? chord / 3 : chord * ((2 / 3) * Math.tan(theta / 4)) / Math.sin(theta / 2);
        const c1x = ax + d1x * h, c1z = az + d1z * h;
        const c2x = bx - d2x * h, c2z = bz - d2z * h;
        const xyz: number[] = [];
        const N = Math.max(theta < 0.2 ? 3 : 12, Math.ceil(chord / 0.08));
        for (let k = 0; k <= N; k++) {
          const t = k / N;
          const u = 1 - t;
          const x = u * u * u * ax + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * bx;
          const z = u * u * u * az + 3 * u * u * t * c1z + 3 * u * t * t * c2z + t * t * t * bz;
          xyz.push(x, ay + (by - ay) * t, z);
        }
        const c = mkPath(CONN, xyz, Math.min(a.speed, b.speed), n, n);
        c.inLane = a;
        c.outs = [b];
        // Right of travel is (−dz, dx): positive = right turn.
        const side = -d1z * d2x + d1x * d2z;
        c.turn = uturn ? 2 : dot > 0.7 ? 0 : side > 0 ? 1 : -1;
        c.weight = (uturn ? 0.01 : c.turn === 0 ? 1 : c.turn > 0 ? 0.75 : 0.55) * b.weight * (b.to?.spawn ? 0.35 : 1);
        // Traffic gravitates downtown: exits heading toward the Financial District are favoured.
        if (b.to && a.from) c.weight *= Math.exp((downtown(a.from) - downtown(b.to)) * 0.06);
        a.outs.push(c);
        n.conns.push(c);
        conns.push(c);
      }
    }
    // Which connectors cross: any two that come within a car's width, or share an end.
    for (const a of n.conns) {
      for (const b of n.conns) {
        if (a === b) continue;
        if (a.inLane === b.inLane || a.outs[0] === b.outs[0] || minDist(a, b) < 0.28) a.conflicts.add(b);
      }
    }
  }

  // Bridges: the Golden Gate (two lanes each way) and the Bay Bridge (westbound on top, eastbound below),
  // from the ground at one end to the ground at the other, up the ramps and through the Yerba Buena tunnel.
  const bridges: Path[] = [];
  const streams = bridgeLanes();
  for (const [lanes, speed] of [[streams.goldenGate, 1.5], [streams.bayBridge, 1.55]] as const) {
    for (const l of lanes) {
      const p = mkPath(LANE, l.xyz, speed, null, null);
      p.bridge = true;
      p.hide = l.hide;
      bridges.push(p);
    }
  }

  const spots = lanes.filter((l) => !l.from?.spawn && !l.to?.spawn && l.len > 1.6);
  const spotCum: number[] = [];
  let acc = 0;
  for (const l of spots) spotCum.push((acc += l.len * (0.35 + 2.4 * Math.exp(-downtown(l.to!) / 9))));
  return {
    nodes: [...nodes.values()],
    lanes,
    paths: [...lanes, ...conns, ...bridges],
    spots,
    spotCum,
    sources: lanes.filter((l) => l.from?.spawn),
    bridges,
  };
}

/** Distance from the heart of downtown (around Market and Montgomery). */
function downtown(n: { x: number; z: number }): number {
  return Math.hypot(n.x - 1, n.z + 5);
}

function minDist(a: Path, b: Path): number {
  let d = Infinity;
  for (let i = 0; i < a.pts.length; i += 3) {
    for (let j = 0; j < b.pts.length; j += 3) {
      d = Math.min(d, Math.hypot(a.pts[i]! - b.pts[j]!, a.pts[i + 2]! - b.pts[j + 2]!));
    }
  }
  return d;
}

// ═══ Simulation ════════════════════════════════════════════════════════════

interface Car {
  model: number;
  half: number;
  r: number;
  g: number;
  b: number;
  path: Path;
  s: number;
  v: number;
  next: Path | null;
  next2: Path | null;
  /** Junction connector in use (or about to be), for conflict checks. */
  jconn: Path | null;
  pref: number;
  accel: number;
  /** Stopped at a stop line since `arrived`; may go when `stopT` runs out and it's granted. */
  atLine: boolean;
  arrived: number;
  stopT: number;
  granted: boolean;
  bridge: boolean;
  /** Fading in after appearing (0 → 1) or out when leaving. */
  appear: number;
  leaving: boolean;
  fade: number;
  brake: number;
  heading: number;
  yawRate: number;
  lean: number;
  dive: number;
  lastV: number;
  idx: number;
}

/** Signal cycle: phase 0 green, amber, all red, phase 1 green, amber, all red. */
const CYCLE = 15;
const GREEN0 = 6.5;
const GREEN1 = 5;
const AMBER_T = 1.3;
const ALLRED = 0.6;

/** 0 green, 1 amber, 2 red for an approach with this phase. */
function signalState(n: GNode, phase: number, now: number): 0 | 1 | 2 {
  const t = (((now - n.offset) % CYCLE) + CYCLE) % CYCLE;
  const start = phase === 0 ? 0 : GREEN0 + AMBER_T + ALLRED;
  const green = phase === 0 ? GREEN0 : GREEN1;
  const u = t - start;
  if (u >= 0 && u < green) return 0;
  if (u >= green && u < green + AMBER_T) return 1;
  return 2;
}

const SCRATCH = { x: 0, y: 0, z: 0 };
const SCRATCH2 = { x: 0, y: 0, z: 0 };

/**
 * Cars, buses and cabs. `setRoads` builds the lane graph from the city's
 * road cells; `setCount` sets how many drive around town; bridge traffic
 * scales with it. Everything is instanced: per frame only matrices and a
 * few per-instance floats are written.
 */
export class Traffic {
  readonly object = new THREE.Group();
  readonly people: Pedestrians;
  /** Optional: something else (a streetcar) is in the junction at (x, z) within r. */
  blocked: ((x: number, z: number, r: number) => boolean) | null = null;
  private fleets: Fleet[];
  private mats = vehicleMaterials();
  private beams: THREE.InstancedMesh;
  /** Stop signs, stop bars and signal poles; the signal lamps are instanced so they can change. */
  private props = new THREE.Group();
  private lenses: THREE.InstancedMesh | null = null;
  private heads: { node: GNode; phase: number }[] = [];
  private beamMat: THREE.MeshBasicMaterial;
  private graph: Graph | null = null;
  private cars: Car[] = [];
  private pool: Car[] = [];
  private target = 0;
  private luxury = 0;
  private time = 0;
  private fill = true;
  private r = rng(4242);
  private cap: number;

  constructor(cap = 320) {
    this.cap = cap;
    this.fleets = CAR_MODELS.map((m) => new Fleet(m, m === 'bus' ? 12 : cap, this.mats));
    for (const f of this.fleets) for (const m of f.meshes) this.object.add(m);
    this.beamMat = new THREE.MeshBasicMaterial({ color: 0xffe2b0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    this.beams = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.62, 0.3).rotateX(-Math.PI / 2).translate(0.31, 0, 0), this.beamMat, cap);
    this.beams.frustumCulled = false;
    this.beams.count = 0;
    this.beams.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.object.add(this.beams);
    this.object.add(this.props);
    this.people = new Pedestrians();
    this.object.add(this.people.object);
    this.object.name = 'traffic';
  }

  /** For tests and debugging: the live cars and the graph. */
  debug() {
    return { cars: this.cars, graph: this.graph, signalState, time: this.time };
  }

  /** Triangles per model, for the record. */
  stats(): Record<string, number> {
    return Object.fromEntries(CAR_MODELS.map((m, i) => [m, this.fleets[i]!.tris]));
  }

  /** Rebuilds the lane graph from the city's road cells. */
  setRoads(cells: readonly RoadCell[]) {
    this.graph = buildGraph(cells);
    for (const c of this.cars) this.pool.push(c);
    this.cars.length = 0;
    this.fill = true;
    this.people.setNodes(this.graph.nodes);
    this.buildProps(this.graph);
  }

  /** Street furniture for the junctions: stop signs and stop bars, and signal heads on Market. */
  private buildProps(g: Graph) {
    for (const o of [...this.props.children]) {
      this.props.remove(o);
      const m = o as THREE.Mesh;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    const parts = new Parts();
    this.heads = [];
    const lensAt: [number, number, number, number, number][] = [];
    const POLE = 0x8f959c;
    const SIGNAL = 0x2f3a33;
    for (const l of g.lanes) {
      const n = l.to;
      if (!n || !(n.stop || n.signal)) continue;
      const k = l.pts.length - 3;
      const ex = l.pts[k]!, ey = l.pts[k + 1]!, ez = l.pts[k + 2]!;
      let hx = ex - l.pts[k - 3]!, hz = ez - l.pts[k - 1]!;
      const hl = Math.hypot(hx, hz);
      hx /= hl; hz /= hl;
      const rx = -hz, rz = hx; // right of travel
      const face = Math.atan2(hx, hz) + Math.PI; // a +z normal turned to face oncoming traffic
      // Stop bar across the lane, just short of the crossing.
      const bar = new THREE.PlaneGeometry(0.035, Math.min(0.36, l.kerb * 2 + 0.05)).rotateX(-Math.PI / 2).rotateY(Math.atan2(-hz, hx));
      parts.add('detail', bar.translate(ex + hx * 0.012, ey + 0.0035, ez + hz * 0.012), 0xf5f1e4);
      const px = ex + rx * (l.kerb + 0.04) - hx * 0.03;
      const pz = ez + rz * (l.kerb + 0.04) - hz * 0.03;
      if (n.stop) {
        parts.add('detail', new THREE.CylinderGeometry(0.0035, 0.004, 0.17, 5, 1, true).translate(px, GRID_Y + 0.085, pz), POLE);
        const disc = (r: number, off: number) => new THREE.CylinderGeometry(r, r, 0.003, 8).rotateY(Math.PI / 8).rotateX(Math.PI / 2).translate(0, 0, off).rotateY(face).translate(px, GRID_Y + 0.165, pz);
        parts.add('detail', disc(0.03, 0), 0xf4f4f0);
        parts.add('detail', disc(0.025, 0.0022), 0xc8202a);
        parts.add('detail', new THREE.BoxGeometry(0.03, 0.006, 0.001).translate(0, 0, 0.004).rotateY(face).translate(px, GRID_Y + 0.165, pz), 0xf4f4f0);
      } else {
        // Mast pole on the kerb with the head over the lane.
        parts.add('detail', new THREE.CylinderGeometry(0.006, 0.008, 0.34, 6, 1, true).translate(px, GRID_Y + 0.17, pz), SIGNAL);
        const arm = l.kerb + 0.04;
        const mx = px - rx * arm / 2, mz = pz - rz * arm / 2;
        parts.add('detail', new THREE.BoxGeometry(arm, 0.008, 0.008).rotateY(Math.atan2(-rz, rx)).translate(mx, GRID_Y + 0.33, mz), SIGNAL);
        const hxp = ex + hx * 0.02, hzp = ez + hz * 0.02;
        const head = new THREE.BoxGeometry(0.024, 0.074, 0.02).rotateY(face).translate(hxp, GRID_Y + 0.285, hzp);
        parts.add('detail', head, 0x1d211f);
        const visor = new THREE.BoxGeometry(0.028, 0.004, 0.012).translate(0, 0, 0.014);
        for (const dy of [0.024, 0, -0.024]) {
          parts.add('detail', visor.clone().translate(0, dy + 0.009, 0).rotateY(face).translate(hxp, GRID_Y + 0.285, hzp), 0x1d211f);
          lensAt.push([hxp, GRID_Y + 0.285 + dy, hzp, face, 0]);
        }
        this.heads.push({ node: n, phase: l.phase });
      }
    }
    const geo = parts.build().detail;
    if (geo.attributes.position) {
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.2 }));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = 'junction-props';
      this.props.add(mesh);
    }
    this.lenses = null;
    if (lensAt.length) {
      const lens = new THREE.CircleGeometry(0.0072, 10).translate(0, 0, 0.0105);
      const m = new THREE.InstancedMesh(lens, new THREE.MeshBasicMaterial(), lensAt.length);
      const mat = new THREE.Matrix4();
      lensAt.forEach(([x, y, z, face], i) => m.setMatrixAt(i, mat.makeRotationY(face).setPosition(x, y, z)));
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(lensAt.length * 3), 3).setUsage(THREE.DynamicDrawUsage);
      m.name = 'signal-lamps';
      this.lenses = m;
      this.props.add(m);
    }
  }

  /** Signal lamps: red, amber, green for each head. */
  private updateLamps() {
    const m = this.lenses;
    if (!m) return;
    const a = m.instanceColor!.array as Float32Array;
    const lit = 1 + GLOW.night.value * 1.5;
    const off = 0.05;
    for (let h = 0; h < this.heads.length; h++) {
      const { node, phase } = this.heads[h]!;
      const st = signalState(node, phase, this.time);
      const o = h * 9;
      a[o] = st === 2 ? 2.4 * lit : off; a[o + 1] = st === 2 ? 0.12 * lit : off; a[o + 2] = st === 2 ? 0.08 * lit : off;
      a[o + 3] = st === 1 ? 2.4 * lit : off; a[o + 4] = st === 1 ? 1.3 * lit : off; a[o + 5] = st === 1 ? 0.1 * lit : off;
      a[o + 6] = st === 0 ? 0.15 * lit : off; a[o + 7] = st === 0 ? 2.2 * lit : off; a[o + 8] = st === 0 ? 1.2 * lit : off;
    }
    m.instanceColor!.needsUpdate = true;
  }

  /** Developed blocks: where people walk. */
  setBlocks(blocks: readonly BlockCoord[]) {
    this.people.setBlocks(blocks);
  }

  /** Share (0–1) of sports cars and EVs: rises with the city's wealth. */
  setLuxury(share: number) {
    this.luxury = Math.min(1, Math.max(0, share));
  }

  /** Cars driving around town (bridge traffic scales with it). */
  setCount(n: number) {
    this.target = Math.max(0, Math.min(160, this.cap - 120, Math.round(n)));
  }

  /** Bridge cars: about one every 2 units of lane in a busy city, thinner in a small one. */
  private get bridgeTarget() {
    if (!this.graph) return 0;
    let len = 0;
    for (const p of this.graph.bridges) len += p.len;
    // The bridges' approach ramps doubled the lane length; keep the bridge traffic about where it was.
    len = Math.min(len, 240);
    return Math.round((len / BRIDGE_SPACING) * (0.35 + 0.65 * Math.min(1, this.target / 100)));
  }

  private pickModel(bridge: boolean): number {
    const L = this.luxury;
    const buses = this.cars.reduce((a, c) => a + (c.model === 6 ? 1 : 0), 0);
    const r = this.r();
    if (r < 0.015 + 0.3 * L) return 7; // sports
    if (r < 0.07 + 0.85 * L) return 8; // EV
    return CAR_MODELS.indexOf(
      weighted<CarModel>(
        [['sedan', 26], ['hatch', 13], ['suv', 20], ['pickup', bridge ? 10 : 6], ['taxi', bridge ? 2 : 8], ['van', 7], ['bus', !bridge && buses < Math.min(8, 1 + this.target / 18) ? 6 : 0]],
        this.r(),
      ),
    );
  }

  private spawn(path: Path, s: number, v: number, bridge: boolean, instant: boolean): Car {
    const model = this.pickModel(bridge);
    const kind = CAR_MODELS[model]!;
    tmpC.setHex(weighted(PALETTES[kind], this.r()));
    const c: Car = this.pool.pop() ?? ({} as Car);
    Object.assign(c, {
      model, half: MODEL_LENGTH[kind] / 2, r: tmpC.r, g: tmpC.g, b: tmpC.b,
      path, s, v, next: null, next2: null, jconn: null,
      pref: 0.85 + this.r() * 0.3, accel: kind === 'bus' ? 0.4 : kind === 'sports' ? 0.95 : 0.65,
      atLine: false, arrived: 0, stopT: 0, granted: false, bridge,
      appear: instant ? 1 : 0, leaving: false, fade: instant ? 1 : 0, brake: 0, heading: NaN, yawRate: 0, lean: 0, dive: 0, lastV: v, idx: 0,
    } satisfies Car);
    if (kind === 'bus') c.pref = 0.8;
    if (kind === 'sports') c.pref = 1.12;
    this.enter(c, path);
    c.s = s;
    this.cars.push(c);
    path.cars.push(c);
    return c;
  }

  /** The car has just entered `p`: plan the next move. */
  private enter(c: Car, p: Path) {
    c.path = p;
    if (p.kind === CONN) {
      c.next = p.outs[0] ?? null;
      c.next2 = null;
      c.jconn = p;
      return;
    }
    c.granted = false;
    c.atLine = false;
    // Choose an exit at the end of this lane.
    if (p.outs.length) {
      let total = 0;
      for (const o of p.outs) total += o.weight;
      let x = this.r() * total;
      let pick = p.outs[0]!;
      for (const o of p.outs) if ((x -= o.weight) < 0) { pick = o; break; }
      c.next = pick;
      c.next2 = pick.outs[0] ?? null;
    } else {
      c.next = null;
      c.next2 = null;
    }
  }

  private release(i: number) {
    const c = this.cars[i]!;
    this.pool.push(c);
    this.cars[i] = this.cars[this.cars.length - 1]!;
    this.cars.pop();
  }

  /** A clear stretch of a city lane: no car within `gap` either side. */
  private freeSpot(): [Path, number] | null {
    const g = this.graph!;
    if (!g.spots.length) return null;
    const x = this.r() * g.spotCum[g.spotCum.length - 1]!;
    let i = 0;
    while (g.spotCum[i]! < x) i++;
    const p = g.spots[i]!;
    const s = 0.9 + this.r() * (p.len - 1.6);
    for (const o of p.cars) if (Math.abs(o.s - s) < o.half + 0.75) return null;
    return [p, s];
  }

  private populate() {
    const g = this.graph!;
    // City cars
    let city = 0;
    for (const c of this.cars) if (!c.bridge && !c.leaving) city++;
    // A big jump (seeking the timeline) refills quickly; day-to-day changes trickle in.
    let tries = this.fill ? this.target * 4 : Math.max(3, Math.ceil((this.target - city) / 3));
    while (city < this.target && tries-- > 0) {
      if (!this.fill && this.r() < 0.35 && g.sources.length) {
        const p = g.sources[Math.floor(this.r() * g.sources.length)]!;
        const first = p.cars[0];
        if (!first || first.s - first.half > 0.9) {
          this.spawn(p, 0, p.speed * 0.8, false, false);
          city++;
        }
        continue;
      }
      const spot = this.freeSpot();
      if (!spot) continue;
      this.spawn(spot[0], spot[1], this.fill ? spot[0].speed * 0.6 : 0, false, this.fill);
      city++;
    }
    if (city > this.target) {
      for (let i = this.cars.length - 1; i >= 0 && city > this.target; i--) {
        const c = this.cars[i]!;
        if (!c.bridge && !c.leaving) {
          c.leaving = true;
          city--;
        }
      }
    }
    // Bridge streams: keep each lane fed from its far end.
    let bridge = 0;
    for (const c of this.cars) if (c.bridge) bridge++;
    const density = this.bridgeTarget / Math.max(1, g.bridges.reduce((a, p) => a + p.len, 0));
    for (const p of g.bridges) {
      const spacing = 1 / Math.max(0.05, density);
      if (this.fill) {
        for (let s = spacing * this.r(); s < p.len - 0.5 && bridge < this.bridgeTarget; s += spacing * (0.6 + this.r() * 0.8)) {
          this.spawn(p, s, p.speed, true, true);
          bridge++;
        }
        continue;
      }
      const first = p.cars[0];
      if (bridge < this.bridgeTarget && (!first || first.s - first.half > p.nextGap)) {
        this.spawn(p, 0, p.speed * 0.9, true, false).appear = 1;
        bridge++;
        p.nextGap = 0.5 + spacing * (0.3 + this.r() * 1.2);
      }
    }
    this.fill = false;
  }

  /** Bumper-to-bumper gap to whoever is ahead (on this path or the next two), and their speed. */
  private leader(c: Car) {
    const L = this.lead;
    const p = c.path;
    const o = p.cars[c.idx + 1];
    L.gap = Infinity;
    L.v = 0;
    if (o) {
      L.gap = o.s - c.s - o.half - c.half;
      L.v = o.v;
      return L;
    }
    let d = p.len - c.s;
    for (let k = 0; k < 2; k++) {
      const q = k ? c.next2 : c.next;
      if (!q) break;
      const f = q.cars[0];
      if (f && f !== c) {
        L.gap = d + f.s - f.half - c.half;
        L.v = f.v;
        return L;
      }
      d += q.len;
      if (d > 3) break;
    }
    return L;
  }
  private lead = { gap: Infinity, v: 0 };

  /** May this car, stopped at the line, go into the junction now? */
  private mayGo(c: Car, n: GNode): boolean {
    const k = c.next!;
    if (n.pedUntil > this.time) return false;
    for (const o of n.inside) if (o !== c && o.jconn && o.jconn !== k && k.conflicts.has(o.jconn)) return false;
    // First come, first served among those stopped at the line (at a signal, those with a green).
    const arrived = c.atLine ? c.arrived : this.time;
    for (const w of n.waiting) {
      if (w === c || w.stopT > 0 || !w.next || !w.atLine) continue;
      if (n.signal && signalState(n, w.path.phase, this.time) === 2) continue;
      if (w.arrived < arrived && k.conflicts.has(w.next) && this.roomAfter(w)) return false;
    }
    if (!this.roomAfter(c)) return false;
    if (this.blocked?.(n.x, n.z, 1.0)) return false;
    return true;
  }

  /** Room on the lane beyond the junction, so nobody stops in the box. */
  private roomAfter(c: Car): boolean {
    const out = c.next?.outs[0];
    if (!out) return true;
    const last = out.cars[0];
    return !last || last.s - last.half > c.half * 2 + 0.12;
  }

  update(dt: number) {
    dt = Math.max(0, Math.min(dt, 0.05));
    this.time += dt;
    const g = this.graph;
    if (!g) return;
    const now = this.time;

    // Who is where: sort each path's cars, and note who is in or waiting at each junction.
    for (const p of g.paths) p.cars.length = 0;
    for (const n of g.nodes) {
      n.inside.length = 0;
      n.waiting.length = 0;
    }
    for (const c of this.cars) c.path.cars.push(c);
    for (const p of g.paths) {
      const a = p.cars;
      for (let i = 1; i < a.length; i++) {
        const x = a[i]!;
        let j = i - 1;
        while (j >= 0 && a[j]!.s > x.s) {
          a[j + 1] = a[j]!;
          j--;
        }
        a[j + 1] = x;
      }
      for (let i = 0; i < a.length; i++) a[i]!.idx = i;
    }
    for (const c of this.cars) {
      const p = c.path;
      if (p.kind === CONN) p.from!.inside.push(c);
      else {
        // Granted and rolling off the line, or its tail still in the junction behind.
        if (c.granted && p.to) p.to.inside.push(c);
        else if (c.atLine && p.to) p.to.waiting.push(c);
        if (c.jconn && p.from && c.s < c.half + 0.08) p.from.inside.push(c);
      }
    }

    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i]!;
      if (!this.step(c, dt, now)) this.release(i);
    }
    this.populate();
    this.people.update(dt, now);
    this.updateLamps();
    this.render(dt);
  }

  /** Advances one car. Returns false when it has left the world. */
  private step(c: Car, dt: number, now: number): boolean {
    const p = c.path;
    let vt = p.speed * c.pref;
    vt = Math.min(vt, vlimAt(p, c.s + c.half * 0.5));
    const dEnd = p.len - c.s;
    if (c.next) {
      vt = Math.min(vt, Math.sqrt(c.next.vmin ** 2 + 2 * BRAKE * Math.max(0, dEnd - c.half * 0.5)));
      if (c.next2 && dEnd + c.next.len < 2.5) vt = Math.min(vt, Math.sqrt(c.next2.vlim[0]! ** 2 + 2 * BRAKE * (dEnd + c.next.len)));
    }
    // Stop line: all-way stops, signals, people on the crossing.
    const n = p.kind === LANE ? p.to : null;
    let stopAt = Infinity;
    if (n && c.next && !c.granted && (n.stop || n.signal || n.pedUntil > now)) {
      stopAt = p.len - c.half - 0.005;
      const d = stopAt - c.s;
      vt = Math.min(vt, Math.sqrt(2 * BRAKE * Math.max(0, d)) * 0.95);
      const stopped = d < 0.025 && c.v < 0.06;
      if (stopped && !c.atLine) {
        c.atLine = true;
        c.arrived = now;
        c.stopT = n.signal ? 0 : 0.35 + this.r() * 0.45;
        n.waiting.push(c);
      }
      if (c.atLine) {
        c.stopT -= dt;
        const waited = now - c.arrived;
        // Gridlock breaker: if the way ahead stays full, take another exit; failing that, pull over and park.
        if (waited > 6 && !this.roomAfter(c)) {
          for (const o of p.outs) {
            if (o === c.next || (o.turn === 2 && p.outs.length > 1)) continue;
            const last = o.outs[0]?.cars[0];
            if (!last || last.s - last.half > c.half * 2 + 0.12) {
              c.next = o;
              c.next2 = o.outs[0] ?? null;
              break;
            }
          }
        }
        if (waited > 30) c.leaving = true;
      }
      // At a signal, roll through on green without stopping; at a stop sign, stop first.
      const go = n.signal
        ? (stopped ? signalState(n, p.phase, now) < 2 : signalState(n, p.phase, now) === 0 && d < 0.9) && p.cars[c.idx + 1] === undefined && this.mayGo(c, n)
        : stopped && c.stopT <= 0 && this.mayGo(c, n);
      if (go) {
        c.granted = true;
        c.atLine = false;
        c.jconn = c.next;
        n.inside.push(c);
        n.busyUntil = now + 0.5;
        stopAt = Infinity;
      }
    }
    if (p.kind === CONN) p.from!.busyUntil = now + 0.3;
    else if (n && dEnd < 0.9 + c.half && c.v > 0.08) n.busyUntil = now + 0.3;
    // Following
    const { gap, v: vl } = this.leader(c);
    const g0 = 0.07 + c.v * 0.32;
    if (gap < Infinity) vt = Math.min(vt, Math.sqrt(vl * vl + 2 * BRAKE * Math.max(0, gap - g0)));
    if (gap < 0.03) vt = 0;
    if (c.leaving || c.appear < 1) vt = Math.min(vt, c.appear < 1 ? 0.4 + c.appear : vt);

    c.lastV = c.v;
    if (vt > c.v) c.v = Math.min(vt, c.v + c.accel * dt);
    else c.v = Math.max(vt, c.v - HARD_BRAKE * dt);
    if (gap < Infinity) c.v = Math.min(c.v, Math.max(0, gap - 0.015) / dt);
    const braking = vt < c.v + 0.02 && (c.v < c.lastV - 0.01 * dt || c.v < 0.03);
    c.brake += ((braking ? 1 : 0) - c.brake) * Math.min(1, dt * 14);

    c.s += c.v * dt;
    if (c.s > stopAt) c.s = stopAt;

    // Onto the next path
    while (c.s >= c.path.len) {
      const over = c.s - c.path.len;
      const nx = c.next;
      if (!nx) return false; // off the edge of the map
      this.enter(c, nx);
      c.s = over;
    }
    if (c.path.kind === LANE && c.jconn && !c.granted && c.s > c.half + 0.1) c.jconn = null;

    // Fades
    if (c.leaving) c.appear -= dt * 1.2;
    else if (c.appear < 1) c.appear = Math.min(1, c.appear + dt * 1.4);
    if (c.leaving && c.appear <= 0) return false;
    const q = c.path;
    let f = Math.max(0, Math.min(1, c.appear));
    if (q.kind === LANE) {
      if (q.from?.spawn) f = Math.min(f, c.s / 0.6);
      if (q.to?.spawn) f = Math.min(f, (q.len - c.s) / 0.6);
      if (q.bridge) f = Math.min(f, c.s / 0.5, (q.len - c.s) / 0.5);
      if (q.hide) f = Math.min(f, Math.max(0, Math.max(q.hide[0] - c.s, c.s - q.hide[1]) / 0.3));
    }
    c.fade = Math.max(0, f);
    return true;
  }

  private render(dt: number) {
    for (const f of this.fleets) f.count = 0;
    const night = GLOW.night.value;
    const beams = night > 0.04;
    if (beams && !this.beamMat.map) {
      this.beamMat.map = beamTexture();
      this.beamMat.needsUpdate = true;
    }
    let nb = 0;
    const bm = this.beams.instanceMatrix.array as Float32Array;
    // Paint and glass follow the scene's environment map.
    for (const m of [this.mats.paint, this.mats.glass]) {
      if (m.envMap !== glassMaterial.envMap) {
        m.envMap = glassMaterial.envMap;
        m.needsUpdate = true;
      }
    }
    this.mats.paint.envMapIntensity = glassMaterial.envMapIntensity * 0.75;
    this.mats.glass.envMapIntensity = glassMaterial.envMapIntensity * 1.1;

    for (const c of this.cars) {
      if (c.fade <= 0.003) continue;
      const fl = this.fleets[c.model]!;
      if (fl.count >= fl.fade.count) continue;
      const i = fl.count++;
      const p = c.path;
      // Heading from either side of the car's centre: smooth through bends.
      const a = at(p, c.s - 0.05, SCRATCH);
      const ax = a.x, ay = a.y, az = a.z;
      const b = at(p, c.s + 0.05, SCRATCH2);
      let fx = b.x - ax, fy = b.y - ay, fz = b.z - az;
      const fl2 = Math.hypot(fx, fy, fz) || 1;
      fx /= fl2; fy /= fl2; fz /= fl2;
      const px = (ax + b.x) / 2, py = (ay + b.y) / 2, pz = (az + b.z) / 2;
      // Body roll in turns, nose dive under braking.
      const h = Math.atan2(-fz, fx);
      let dh = Number.isNaN(c.heading) ? 0 : h - c.heading;
      if (dh > Math.PI) dh -= Math.PI * 2;
      if (dh < -Math.PI) dh += Math.PI * 2;
      c.heading = h;
      if (dt > 0) c.yawRate += (dh / dt - c.yawRate) * Math.min(1, dt * 8);
      const leanT = Math.max(-0.07, Math.min(0.07, c.v * c.yawRate * 0.045));
      const accel = dt > 0 ? (c.v - c.lastV) / dt : 0;
      const diveT = Math.max(-0.025, Math.min(0.035, -accel * 0.02));
      c.lean += (leanT - c.lean) * Math.min(1, dt * 6);
      c.dive += (diveT - c.dive) * Math.min(1, dt * 5);
      // Basis: forward f, right r = f × up, up u = r × f; then tilt.
      let rx = -fz, rz = fx;
      const rl = Math.hypot(rx, rz) || 1;
      rx /= rl; rz /= rl;
      let ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
      // Dive: nose down. Lean: top toward the outside of the turn (+r).
      const d = c.dive, l = c.lean;
      let Fx = fx - ux * d, Fy = fy - uy * d, Fz = fz - uz * d;
      let Ux = ux + fx * d + rx * l, Uy = uy + fy * d, Uz = uz + fz * d + rz * l;
      const Fl = Math.hypot(Fx, Fy, Fz);
      Fx /= Fl; Fy /= Fl; Fz /= Fl;
      // R = F × U, then U = R × F
      let Rx = Fy * Uz - Fz * Uy, Ry = Fz * Ux - Fx * Uz, Rz = Fx * Uy - Fy * Ux;
      const Rl = Math.hypot(Rx, Ry, Rz);
      Rx /= Rl; Ry /= Rl; Rz /= Rl;
      Ux = Ry * Fz - Rz * Fy; Uy = Rz * Fx - Rx * Fz; Uz = Rx * Fy - Ry * Fx;
      const m = fl.matrix.array as Float32Array;
      const o = i * 16;
      m[o] = Fx; m[o + 1] = Fy; m[o + 2] = Fz; m[o + 3] = 0;
      m[o + 4] = Ux; m[o + 5] = Uy; m[o + 6] = Uz; m[o + 7] = 0;
      m[o + 8] = Rx; m[o + 9] = Ry; m[o + 10] = Rz; m[o + 11] = 0;
      m[o + 12] = px; m[o + 13] = py; m[o + 14] = pz; m[o + 15] = 1;
      (fl.fade.array as Float32Array)[i] = c.fade;
      (fl.brake.array as Float32Array)[i] = c.brake;
      const col = fl.color.array as Float32Array;
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      if (beams && nb < this.cap) {
        const k = nb++ * 16;
        const s = c.fade;
        const len = c.model === 6 ? 1.15 : 1;
        bm[k] = fx * s * len; bm[k + 1] = 0; bm[k + 2] = fz * s * len; bm[k + 3] = 0;
        bm[k + 4] = 0; bm[k + 5] = 1; bm[k + 6] = 0; bm[k + 7] = 0;
        bm[k + 8] = rx * s; bm[k + 9] = 0; bm[k + 10] = rz * s; bm[k + 11] = 0;
        bm[k + 12] = px + fx * (c.half - 0.02); bm[k + 13] = py + 0.004; bm[k + 14] = pz + fz * (c.half - 0.02); bm[k + 15] = 1;
      }
    }
    for (const f of this.fleets) f.commit();
    this.beams.count = nb;
    this.beamMat.opacity = Math.min(1, night * 1.1) * 0.5;
    if (nb) this.beams.instanceMatrix.needsUpdate = true;
  }
}

let beamTex: THREE.Texture | null = null;
/** A soft cone of headlight on the road. */
function beamTexture(): THREE.Texture {
  if (beamTex) return beamTex;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 32;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(64, 32);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 64; x++) {
      const u = x / 63; // along the beam
      const v = (y - 15.5) / 15.5; // across
      const spread = 0.25 + 0.75 * u;
      const across = Math.max(0, 1 - (v / spread) ** 2);
      const a = across * Math.min(1, u * 6) * (1 - u) ** 1.4;
      const k = (y * 64 + x) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = 255;
      img.data[k + 3] = Math.round(255 * Math.min(1, a * 1.4));
    }
  }
  ctx.putImageData(img, 0, 0);
  beamTex = new THREE.CanvasTexture(c);
  return beamTex;
}

// ═══ Pedestrians ═══════════════════════════════════════════════════════════

const SHIRTS: Palette = [
  [0x1f2a44, 6], [0x18191c, 6], [0xf1f1ee, 5], [0x7a7f87, 4], [0xb2342f, 3], [0xd9a62e, 2], [0x2f7f7a, 2], [0x5a6b3a, 2], [0xe58fa6, 2],
  [0x7fb2df, 3], [0xfd5a1e, 1], [0x8a5a3c, 2], [0x6b4c9a, 1], [0xc9b79a, 2],
];
const PANTS: Palette = [[0x2c3e5c, 8], [0x18191c, 7], [0x3d4f6e, 4], [0xb9a782, 3], [0x5b5e64, 3], [0x6e4e36, 1], [0xe8e4da, 1]];
const SKIN: Palette = [[0xf1c9a5, 3], [0xe0ac86, 3], [0xc68b5e, 3], [0x9c6640, 2], [0x6b4329, 2], [0xf6d7bd, 2]];
const RUNNING: Palette = [[0xff5a36, 2], [0x39c6f4, 2], [0xc6f432, 1], [0xff3c8e, 1], [0xf1f1ee, 2], [0x18191c, 2]];

/** Sidewalk ring: this far from the block centre. */
const KERB = 1.93;
/** Zebra crossings sit this far from the middle of a junction. */
const ZEBRA = 0.38;

interface Walker {
  /** Block index in `blocks` (−1 for joggers). */
  block: number;
  u: number;
  dir: 1 | -1;
  speed: number;
  state: 0 | 1 | 2 | 3; // walking, pausing, waiting to cross, crossing
  timer: number;
  lateral: number;
  phase: number;
  /** Crossing: along the zebra via four waypoints, distance `t` of `tLen`; then on to block `toBlock` at `toU`. */
  wx: Float32Array;
  wz: Float32Array;
  t: number;
  tLen: number;
  toBlock: number;
  toU: number;
  node: GNode | null;
  jogger: boolean;
  /** Stays out after dark if below the night threshold. */
  nightRank: number;
  fade: number;
  facing: number;
  x: number;
  z: number;
  y: number;
  /** Linear RGB, copied into the instance slot each frame. */
  shirt: number[];
  pants: number[];
  skin: number[];
}

/** Tiny people: trousers, shirt and head meshes; limbs swing in the vertex shader. */
class Pedestrians {
  readonly object = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];
  private matrix: THREE.InstancedBufferAttribute;
  private fade: THREE.InstancedBufferAttribute;
  private walk: THREE.InstancedBufferAttribute;
  private colors: THREE.InstancedBufferAttribute[] = [];
  private walkers: Walker[] = [];
  private blocks: { x: number; z: number; bx: number; bz: number }[] = [];
  private blocksKey = '';
  private nodes = new Map<string, GNode>();
  private promenade: { pts: Pt[]; cum: number[]; len: number } | null = null;
  private r = rng(77);
  private cap = 360;
  /** Joggers on the waterfront (0 to turn them off, e.g. in the showcase). */
  joggers = 22;

  constructor() {
    const cap = this.cap;
    this.matrix = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16).setUsage(THREE.DynamicDrawUsage);
    this.fade = new THREE.InstancedBufferAttribute(new Float32Array(cap).fill(1), 1).setUsage(THREE.DynamicDrawUsage);
    this.walk = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2).setUsage(THREE.DynamicDrawUsage);
    const swing = 'attribute vec2 aWalk;\nattribute vec2 aLimb;@@{ float sw = sin(aWalk.x) * aWalk.y * aLimb.x; float cs = cos(sw), sn = sin(sw); vec2 q = vec2(transformed.x, transformed.y - aLimb.y); transformed.x = q.x * cs - q.y * sn; transformed.y = q.x * sn + q.y * cs + aLimb.y; }';
    const mat = fading(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, shadowSide: THREE.DoubleSide }), 'people', swing);
    // Shadows fade with the walker and swing their legs too.
    const depth = fading(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), 'people-depth', swing);
    for (const g of personGeometry()) {
      g.setAttribute('aFade', this.fade);
      g.setAttribute('aWalk', this.walk);
      const m = new THREE.InstancedMesh(g, mat, cap);
      m.instanceMatrix = this.matrix;
      const col = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3).setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = col;
      this.colors.push(col);
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = true;
      m.receiveShadow = true;
      m.customDepthMaterial = depth;
      this.meshes.push(m);
      this.object.add(m);
    }
    this.object.name = 'people';
  }

  get count() {
    return this.walkers.length;
  }

  setNodes(nodes: readonly GNode[]) {
    this.nodes = new Map(nodes.map((n) => [key(n.x, n.z), n]));
  }

  setBlocks(list: readonly BlockCoord[]) {
    const k = list.map((b) => `${b.bx},${b.bz}`).sort().join(';');
    if (k === this.blocksKey) return;
    this.blocksKey = k;
    this.blocks = list.map((b) => ({ ...blockCentre(b), bx: b.bx, bz: b.bz }));
    this.populate();
  }

  private populate() {
    const r = this.r;
    this.walkers.length = 0;
    if (!this.blocks.length) return;
    // Busier downtown and along Market.
    const weights = this.blocks.map((b) => {
      const d = Math.hypot(b.x, b.z * 1.1);
      const market = Math.abs(b.x - b.z - 10) / Math.SQRT2;
      return 0.35 + 2.2 * Math.exp(-d / 9) + 1.2 * Math.exp(-market / 4);
    });
    const total = weights.reduce((a, w) => a + w, 0);
    const n = Math.min(this.cap - this.joggers, Math.round(40 + this.blocks.length * 11));
    for (let i = 0; i < n; i++) {
      let x = r() * total;
      let bi = 0;
      while ((x -= weights[bi]!) > 0 && bi < weights.length - 1) bi++;
      this.walkers.push(this.walker(bi, r() * KERB * 8, false));
    }
    if (this.joggers) {
      this.promenade ??= promenadePath();
      for (let i = 0; i < this.joggers; i++) this.walkers.push(this.walker(-1, r() * this.promenade.len, true));
    }
  }

  private walker(block: number, u: number, jogger: boolean): Walker {
    const r = this.r;
    const colour = (p: Palette) => {
      tmpC.setHex(weighted(p, r()));
      return [tmpC.r, tmpC.g, tmpC.b];
    };
    return {
      block, u, dir: r() < 0.5 ? 1 : -1, speed: jogger ? 0.26 + r() * 0.08 : 0.075 + r() * 0.045, state: 0, timer: 0,
      lateral: (r() - 0.5) * 0.1, phase: r() * 10, wx: new Float32Array(4), wz: new Float32Array(4), t: 0, tLen: 1, toBlock: 0, toU: 0, node: null,
      jogger, nightRank: r(), fade: 1, facing: 0, x: 0, z: 0, y: GRID_Y,
      shirt: colour(jogger ? RUNNING : SHIRTS), pants: colour(jogger ? [[0x18191c, 3], [0x3d4f6e, 1], [0x5b5e64, 1]] : PANTS), skin: colour(SKIN),
    };
  }

  /** Position on a block's sidewalk ring and the walking direction there. */
  private ring(b: { x: number; z: number }, w: Walker) {
    const side = KERB * 2;
    const P8 = side * 4;
    const u = ((w.u % P8) + P8) % P8;
    const k = Math.floor(u / side);
    const t = u - k * side - KERB;
    // Anticlockwise round the block: south edge +x, east edge +z, north edge −x, west edge −z.
    const [x, z, hx, hz] =
      k === 0 ? [b.x + t, b.z - KERB, 1, 0]
      : k === 1 ? [b.x + KERB, b.z + t, 0, 1]
      : k === 2 ? [b.x - t, b.z + KERB, -1, 0]
      : [b.x - KERB, b.z - t, 0, -1];
    // Outward normal is (hz, −hx). Keep to the right of the way we're walking.
    const out = w.lateral + (w.dir > 0 ? -0.03 : 0.03);
    w.x = x + hz * out;
    w.z = z - hx * out;
    w.facing = Math.atan2(-hz * w.dir, hx * w.dir);
  }

  update(dt: number, now: number) {
    const night = GLOW.night.value;
    const outAfterDark = 1 - 0.72 * night;
    const m = this.matrix.array as Float32Array;
    const fadeA = this.fade.array as Float32Array;
    const walkA = this.walk.array as Float32Array;
    const shirtA = this.colors[0]!.array as Float32Array;
    const pantsA = this.colors[1]!.array as Float32Array;
    const skinA = this.colors[2]!.array as Float32Array;
    let n = 0;
    for (const w of this.walkers) {
      const visible = w.nightRank < (w.jogger ? 1 - 0.9 * night : outAfterDark);
      w.fade += ((visible ? 1 : 0) - w.fade) * Math.min(1, dt * 0.8);
      const moving = this.move(w, dt, now);
      if (w.fade < 0.01) continue;
      if (moving) w.phase += dt * (w.jogger ? 15 : 9.5) * (0.85 + w.speed * 1.5);
      const amp = moving ? (w.jogger ? 0.9 : 0.55) : 0;
      const bob = moving ? Math.abs(Math.sin(w.phase)) * (w.jogger ? 0.004 : 0.0022) : 0;
      const sway = moving ? Math.sin(w.phase) * 0.05 : 0;
      const lean = w.jogger ? 0.12 : 0.03;
      // Yaw to the walking direction, a forward lean and a side-to-side sway (small angles).
      const fx = Math.cos(w.facing), fz = -Math.sin(w.facing); // model +x
      const rx = -fz, rz = fx; // model +z
      const o = n * 16;
      m[o] = fx; m[o + 1] = -lean; m[o + 2] = fz; m[o + 3] = 0;
      m[o + 4] = lean * fx + sway * rx; m[o + 5] = 1; m[o + 6] = lean * fz + sway * rz; m[o + 7] = 0;
      m[o + 8] = rx; m[o + 9] = -sway; m[o + 10] = rz; m[o + 11] = 0;
      m[o + 12] = w.x; m[o + 13] = w.y + bob; m[o + 14] = w.z; m[o + 15] = 1;
      fadeA[n] = w.fade;
      walkA[n * 2] = w.phase;
      walkA[n * 2 + 1] = amp;
      shirtA.set(w.shirt, n * 3);
      pantsA.set(w.pants, n * 3);
      skinA.set(w.skin, n * 3);
      n++;
    }
    for (const mesh of this.meshes) mesh.count = n;
    this.matrix.needsUpdate = this.fade.needsUpdate = this.walk.needsUpdate = true;
    for (const a of this.colors) a.needsUpdate = true;
  }

  /** Walks one person on. Returns whether their legs are moving. */
  private move(w: Walker, dt: number, now: number): boolean {
    const r = this.r;
    if (w.jogger) {
      const pr = this.promenade!;
      w.u += w.dir * w.speed * dt;
      if (w.u < 0 || w.u > pr.len) {
        w.dir = w.dir > 0 ? -1 : 1;
        w.u = Math.max(0, Math.min(pr.len, w.u));
      }
      promenadeAt(pr, w.u, w.dir, w.lateral, w);
      return true;
    }
    if (w.state === 3) {
      // Over the zebra, a little brisker, holding the traffic.
      w.t += w.speed * 2 * dt;
      if (w.node) w.node.pedUntil = Math.max(w.node.pedUntil, now + 0.4);
      if (w.t >= w.tLen) {
        w.state = 0;
        w.block = w.toBlock;
        w.u = w.toU;
        w.node = null;
        this.ring(this.blocks[w.block]!, w);
        return true;
      }
      let d = w.t;
      for (let i = 0; i < 3; i++) {
        const l = Math.hypot(w.wx[i + 1]! - w.wx[i]!, w.wz[i + 1]! - w.wz[i]!);
        if (d <= l || i === 2) {
          const t = l > 1e-6 ? Math.min(1, d / l) : 1;
          w.x = w.wx[i]! + (w.wx[i + 1]! - w.wx[i]!) * t;
          w.z = w.wz[i]! + (w.wz[i + 1]! - w.wz[i]!) * t;
          w.facing = Math.atan2(-(w.wz[i + 1]! - w.wz[i]!), w.wx[i + 1]! - w.wx[i]!);
          break;
        }
        d -= l;
      }
      return true;
    }
    const b = this.blocks[w.block]!;
    let moving = true;
    if (w.state === 1) {
      moving = false;
      w.timer -= dt;
      if (w.timer <= 0) w.state = 0;
    } else if (w.state === 2) {
      moving = false;
      w.timer -= dt;
      const nd = w.node;
      let carsReady = false;
      if (nd) for (const c of nd.waiting) if (c.stopT <= 0) carsReady = true;
      // Cross with others already on the zebra, or when the junction is quiet; never ahead of a car that has had its turn coming.
      const joining = !!nd && nd.pedUntil > now + 0.15;
      if (nd && !carsReady && nd.inside.length === 0 && (joining || now > nd.busyUntil)) {
        w.state = 3;
        w.t = 0;
        nd.pedUntil = now + 0.5;
        return true;
      }
      if (w.timer <= 0) {
        w.state = 0; // gave up: on round the block
        w.node = null;
      }
    } else {
      const side = KERB * 2;
      const before = Math.floor(w.u / side);
      w.u += w.dir * w.speed * dt;
      const after = Math.floor(w.u / side);
      if (before !== after) this.corner(w, b, Math.max(before, after) * side);
      else if (r() < dt * 0.035) {
        w.state = 1; // window shopping
        w.timer = 1 + r() * 4;
      }
    }
    this.ring(b, w);
    return moving;
  }

  /** At a corner of block b: maybe cross to a neighbouring developed block over the zebra. */
  private corner(w: Walker, b: { x: number; z: number; bx: number; bz: number }, cornerU: number) {
    const r = this.r;
    if (r() > 0.4) return;
    const side = KERB * 2;
    const P8 = side * 4;
    const k = ((Math.round(cornerU / side) % 4) + 4) % 4;
    // Corner k starts side k: SW(0), SE(1), NE(2), NW(3).
    const cx = k === 0 || k === 3 ? -1 : 1;
    const cz = k === 0 || k === 1 ? -1 : 1;
    const alongX = r() < 0.5;
    const nb = this.blocks.findIndex((q) => q.bx === b.bx + (alongX ? cx : 0) && q.bz === b.bz + (alongX ? 0 : cz));
    if (nb < 0) return;
    const nx = b.x + (cx * PITCH) / 2, nz = b.z + (cz * PITCH) / 2;
    const node = this.nodes.get(key(nx, nz));
    if (!node) return;
    const nbB = this.blocks[nb]!;
    // The matching corner of the neighbour, across the street; walk out to the zebra, over it, and back in.
    const ncx = alongX ? -cx : cx, ncz = alongX ? cz : -cz;
    const x0 = b.x + cx * KERB, z0 = b.z + cz * KERB;
    const x3 = nbB.x + ncx * KERB, z3 = nbB.z + ncz * KERB;
    const zx = alongX ? 0 : 1; // the zebra runs across the street being crossed
    const zebraX = nx - cx * ZEBRA, zebraZ = nz - cz * ZEBRA;
    w.wx.set([x0, zx ? zebraX : x0, zx ? zebraX : x3, x3]);
    w.wz.set([z0, zx ? z0 : zebraZ, zx ? z3 : zebraZ, z3]);
    let len = 0;
    for (let i = 0; i < 3; i++) len += Math.hypot(w.wx[i + 1]! - w.wx[i]!, w.wz[i + 1]! - w.wz[i]!);
    const nk = ncx < 0 && ncz < 0 ? 0 : ncx > 0 && ncz < 0 ? 1 : ncx > 0 && ncz > 0 ? 2 : 3;
    w.state = 2;
    w.timer = 2 + r() * 4;
    w.t = 0;
    w.tLen = len;
    w.toBlock = nb;
    w.toU = nk * side + (r() < 0.5 ? 0.02 : P8 - 0.02);
    w.node = node;
    w.u = cornerU;
    w.dir = r() < 0.5 ? 1 : -1;
  }
}

/** Person facing +x: legs and shoes, torso and arms, head and hair. Limb swing via aLimb (sign, pivot height). */
function personGeometry(): THREE.BufferGeometry[] {
  const build = (parts: [THREE.BufferGeometry, number, number, number][]) => {
    const geos = parts.map(([g, color, swing, pivot]) => {
      const geo = g.index ? g.toNonIndexed() : g;
      geo.deleteAttribute('uv');
      const n = geo.attributes.position!.count;
      tmpC.setHex(color);
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) col.set([tmpC.r, tmpC.g, tmpC.b], i * 3);
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const limb = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) limb.set([swing, pivot], i * 2);
      geo.setAttribute('aLimb', new THREE.BufferAttribute(limb, 2));
      return geo;
    });
    return mergeGeometries(geos)!;
  };
  const hip = 0.026;
  const shoulder = 0.046;
  const legs = build([
    [new THREE.BoxGeometry(0.0075, 0.025, 0.0072).translate(0, 0.0145, 0.0042), 0xffffff, 1, hip],
    [new THREE.BoxGeometry(0.0075, 0.025, 0.0072).translate(0, 0.0145, -0.0042), 0xffffff, -1, hip],
    [new THREE.BoxGeometry(0.0105, 0.0035, 0.0074).translate(0.0012, 0.0018, 0.0042), 0x303030, 1, hip],
    [new THREE.BoxGeometry(0.0105, 0.0035, 0.0074).translate(0.0012, 0.0018, -0.0042), 0x303030, -1, hip],
  ]);
  const torso = build([
    [new THREE.CylinderGeometry(0.0082, 0.0068, 0.022, 6).scale(0.72, 1, 1.1).translate(0, 0.0365, 0), 0xffffff, 0, 0],
    [new THREE.BoxGeometry(0.0048, 0.019, 0.0048).translate(0, 0.0365, 0.0112), 0xffffff, -0.8, shoulder],
    [new THREE.BoxGeometry(0.0048, 0.019, 0.0048).translate(0, 0.0365, -0.0112), 0xffffff, 0.8, shoulder],
  ]);
  const head = build([
    [new THREE.IcosahedronGeometry(0.0066, 1).translate(0.0005, 0.0545, 0), 0xffffff, 0, 0],
    [new THREE.IcosahedronGeometry(0.0069, 0).scale(1, 0.7, 1).translate(-0.0012, 0.0574, 0), 0x3a2a20, 0, 0],
    [new THREE.BoxGeometry(0.004, 0.0035, 0.004).translate(0, 0.0475, 0), 0xffffff, 0, 0],
  ]);
  return [legs, torso, head];
}

/** The waterfront promenade: the Embarcadero on its bay side, offset onto the paving. */
function promenadePath(): { pts: Pt[]; cum: number[]; len: number } {
  const base = resample(EMBARCADERO.slice(0, -1), 0.5);
  const pts: Pt[] = base.map(([x, z], i) => {
    const [ax, az] = base[Math.max(0, i - 1)]!;
    const [bx, bz] = base[Math.min(base.length - 1, i + 1)]!;
    let nx = -(bz - az), nz = bx - ax;
    const l = Math.hypot(nx, nz) || 1;
    nx /= l; nz /= l;
    const side = coastDistance(x + nx, z + nz) > coastDistance(x - nx, z - nz) ? 1 : -1;
    return [x + side * nx * 0.62, z + side * nz * 0.62] as const;
  });
  const smooth = chaikin(pts, 2);
  const cum = [0];
  for (let i = 1; i < smooth.length; i++) cum.push(cum[i - 1]! + Math.hypot(smooth[i]![0] - smooth[i - 1]![0], smooth[i]![1] - smooth[i - 1]![1]));
  return { pts: smooth, cum, len: cum[cum.length - 1]! };
}

function promenadeAt(pr: { pts: Pt[]; cum: number[] }, u: number, dir: number, lateral: number, w: Walker) {
  let lo = 0, hi = pr.cum.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pr.cum[mid]! <= u) lo = mid;
    else hi = mid - 1;
  }
  const a = pr.pts[lo]!, b = pr.pts[lo + 1]!;
  const l = pr.cum[lo + 1]! - pr.cum[lo]! || 1;
  const t = Math.max(0, Math.min(1, (u - pr.cum[lo]!) / l));
  const tx = (b[0] - a[0]) / l, tz = (b[1] - a[1]) / l;
  const lat = lateral * 0.6 + (dir > 0 ? 0.04 : -0.04);
  w.x = a[0] + (b[0] - a[0]) * t - tz * lat;
  w.z = a[1] + (b[1] - a[1]) * t + tx * lat;
  w.y = Math.max(0, terrainHeight(w.x, w.z)) + 0.014;
  w.facing = Math.atan2(-tz * dir, tx * dir);
}

// ═══ Showcase ══════════════════════════════════════════════════════════════

/** Each model on its own, for the dev showcase (`?set=cars`). */
export function carShowcase(): { label: string; object: THREE.Object3D; size: number; update?: (dt: number, time: number) => void }[] {
  const mats = vehicleMaterials();
  const colours: Record<CarModel, number> = { sedan: 0x29467a, hatch: 0xa3242a, suv: 0xf1f1ee, pickup: 0x18191c, taxi: 0xf5c518, van: 0xf4f4f1, bus: 0xf4f4f2, sports: 0xc8161c, ev: 0xb8bcc2 };
  // `&only=sedan,taxi` narrows the set for close-ups.
  const only = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('only')?.split(',');
  return CAR_MODELS.filter((k) => !only || only.includes(k)).map((kind) => {
    const fleet = new Fleet(kind, 1, mats);
    const g = new THREE.Group();
    for (const m of fleet.meshes) g.add(m);
    new THREE.Matrix4().makeRotationY(-Math.PI / 5).toArray(fleet.matrix.array as Float32Array, 0);
    tmpC.setHex(colours[kind]);
    fleet.color.setXYZ(0, tmpC.r, tmpC.g, tmpC.b);
    fleet.count = 1;
    fleet.commit();
    let t = 0;
    return {
      label: `${kind} · ${fleet.tris} tris`,
      object: g,
      size: 0.75,
      update: (dt: number) => {
        // Tap the brakes now and then so the brake lights can be judged.
        t += dt;
        for (const m of [mats.paint, mats.glass]) {
          if (m.envMap !== glassMaterial.envMap) {
            m.envMap = glassMaterial.envMap;
            m.needsUpdate = true;
          }
        }
        mats.paint.envMapIntensity = glassMaterial.envMapIntensity * 0.75;
        mats.glass.envMapIntensity = glassMaterial.envMapIntensity * 1.1;
        (fleet.brake.array as Float32Array)[0] = Math.sin(t * 2) > 0.3 ? 1 : 0;
        fleet.brake.needsUpdate = true;
      },
    };
  });
}

/** People walking round a block, for the showcase (`?set=people`). */
export function peopleShowcase(): { label: string; object: THREE.Object3D; size: number; update: (dt: number, time: number) => void }[] {
  const p = new Pedestrians();
  p.joggers = 0;
  p.setBlocks([{ bx: 0, bz: 0 }]);
  const g = new THREE.Group();
  g.add(p.object);
  let now = 0;
  return [{ label: `${p.count} people`, object: g, size: 4.4, update: (dt) => p.update(dt, (now += dt)) }];
}
