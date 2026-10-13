import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLOW, GeoBuilder, type ColorLike, type Facing } from './geo.ts';
import { PALETTE } from './palette.ts';
import { BAY_APPROACH, EMBARCADERO, LANDMARKS, PRESIDIO_PKWY, SEA, terrainHeight } from '../world/map.ts';
import { rng } from '../world/rng.ts';

const ORANGE = 0xc43a2a;
const ORANGE_DARK = 0x9a2c20;
const STEEL = 0xa7b0ba;
const CONCRETE = 0xd4cfc4;
const LAMP: ColorLike = [2.4, 1.75, 0.95];
const RED_LIGHT: ColorLike = [3, 0.3, 0.2];

const m4 = new THREE.Matrix4();
const qt = new THREE.Quaternion();
const ONE = new THREE.Vector3(1, 1, 1);

/** A thin strut between two points (cables, trusses, legs). */
export function strut(b: GeoBuilder, a: THREE.Vector3, c: THREE.Vector3, w: number, color: ColorLike, bucket: 'solid' | 'smooth' | 'glass' = 'solid') {
  const len = a.distanceTo(c);
  const g = new THREE.BoxGeometry(w, len, w);
  const dir = c.clone().sub(a).normalize();
  qt.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  m4.compose(a.clone().add(c).multiplyScalar(0.5), qt, ONE);
  b.transformed(g, m4, color, bucket);
}

/** Catenary-ish curve through anchor points: each span sags by `sag`. */
function cablePoints(anchors: [number, number][], sags: number[], steps = 18): [number, number][] {
  const out: [number, number][] = [];
  for (let s = 0; s < anchors.length - 1; s++) {
    const [ua, ya] = anchors[s]!;
    const [ub, yb] = anchors[s + 1]!;
    for (let k = s === 0 ? 0 : 1; k <= steps; k++) {
      const t = k / steps;
      out.push([ua + (ub - ua) * t, ya + (yb - ya) * t - sags[s]! * 4 * t * (1 - t)]);
    }
  }
  return out;
}

// ─── Roads in the air: decks, ramps and piers for both bridges ─────────────

type P2 = readonly [number, number];
type Section = readonly P2[];

/** A point on a road's centreline: position, unit heading in plan, distance along it. */
interface Sample {
  x: number;
  y: number;
  z: number;
  tx: number;
  tz: number;
  s: number;
}

/** A road surface on the ground sits just above the grass and the city's own ribbons. */
const GROUND = 0.02;
const ASPHALT = 0x50545c;
const SHADE = 0xbdb6a8;
const WHITE = 0xece9e2;
const IDENTITY = new THREE.Matrix4();

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const smooth01 = (t: number) => {
  const u = clamp(t, 0, 1);
  return u * u * (3 - 2 * u);
};
/** Eases from y0 at s0 to y1 at s1, level beyond either end. */
const ease = (s: number, s0: number, s1: number, y0: number, y1: number) => y0 + (y1 - y0) * smooth01((s - s0) / (s1 - s0));
const rect = (u0: number, u1: number, v0: number, v1: number): Section => [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];

/** A plan polyline with its corners rounded (radius r), sampled about every `step`. */
function planPath(pts: readonly P2[], r: number, step: number): { x: number; z: number }[] {
  const out = [{ x: pts[0]![0], z: pts[0]![1] }];
  const line = (bx: number, bz: number) => {
    const a = out[out.length - 1]!;
    const d = Math.hypot(bx - a.x, bz - a.z);
    if (d < 1e-4) return;
    const n = Math.max(1, Math.ceil(d / step));
    const { x: ax, z: az } = a;
    for (let k = 1; k <= n; k++) out.push({ x: ax + ((bx - ax) * k) / n, z: az + ((bz - az) * k) / n });
  };
  for (let i = 1; i < pts.length - 1; i++) {
    const [ax, az] = pts[i - 1]!;
    const [bx, bz] = pts[i]!;
    const [cx, cz] = pts[i + 1]!;
    const l1 = Math.hypot(bx - ax, bz - az);
    const l2 = Math.hypot(cx - bx, cz - bz);
    const d1x = (bx - ax) / l1;
    const d1z = (bz - az) / l1;
    const d2x = (cx - bx) / l2;
    const d2z = (cz - bz) / l2;
    const turn = Math.acos(clamp(d1x * d2x + d1z * d2z, -1, 1));
    if (turn < 1e-3) {
      line(bx, bz);
      continue;
    }
    // A quadratic fillet: close enough to a circular arc at these angles.
    const t = Math.min(r * Math.tan(turn / 2), l1 * 0.5, l2 * 0.5);
    const [p1x, p1z, p2x, p2z] = [bx - d1x * t, bz - d1z * t, bx + d2x * t, bz + d2z * t];
    line(p1x, p1z);
    const n = Math.max(3, Math.ceil((2 * t) / step));
    for (let k = 1; k <= n; k++) {
      const u = k / n;
      const [a, m, c] = [(1 - u) * (1 - u), 2 * (1 - u) * u, u * u];
      out.push({ x: a * p1x + m * bx + c * p2x, z: a * p1z + m * bz + c * p2z });
    }
  }
  const [ex, ez] = pts[pts.length - 1]!;
  line(ex, ez);
  return out;
}

/** A road: a plan path with a height for each distance along it. */
function road(pts: readonly P2[], r: number, height: (s: number, len: number, x: number, z: number) => number, step = 0.2): Sample[] {
  const p = planPath(pts, r, step);
  const cum = [0];
  for (let i = 1; i < p.length; i++) cum.push(cum[i - 1]! + Math.hypot(p[i]!.x - p[i - 1]!.x, p[i]!.z - p[i - 1]!.z));
  const len = cum[cum.length - 1]!;
  return p.map((q, i) => {
    const a = p[Math.max(0, i - 1)]!;
    const c = p[Math.min(p.length - 1, i + 1)]!;
    const l = Math.hypot(c.x - a.x, c.z - a.z) || 1;
    return { x: q.x, y: height(cum[i]!, len, q.x, q.z), z: q.z, tx: (c.x - a.x) / l, tz: (c.z - a.z) / l, s: cum[i]! };
  });
}

/** Interpolated point at distance s along a road. */
function sampleAt(path: readonly Sample[], s: number): Sample {
  let i = 0;
  while (i < path.length - 2 && path[i + 1]!.s < s) i++;
  const a = path[i]!;
  const b = path[i + 1] ?? a;
  const t = b.s > a.s ? clamp((s - a.s) / (b.s - a.s), 0, 1) : 0;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, tx: a.tx, tz: a.tz, s };
}

/** The samples of a road that satisfy `keep`, plus one either side so pieces meet. */
function part(path: readonly Sample[], keep: (q: Sample) => boolean): Sample[] {
  return path.filter((q, i) => keep(q) || (i > 0 && keep(path[i - 1]!)) || (i < path.length - 1 && keep(path[i + 1]!)));
}

/** The same road driven the other way. */
function reversed(path: readonly Sample[]): Sample[] {
  return [...path].reverse().map((q) => ({ ...q, tx: -q.tx, tz: -q.tz }));
}

const e1 = new THREE.Vector3();
const e2 = new THREE.Vector3();
const nrm = new THREE.Vector3();
const outward = new THREE.Vector3();

/** Pushes a triangle wound so it faces `out`. */
function tri(pos: number[], a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, out: THREE.Vector3) {
  e1.subVectors(b, a);
  e2.subVectors(c, a);
  nrm.crossVectors(e1, e2);
  if (nrm.dot(out) < 0) pos.push(a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z);
  else pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
}

/**
 * Extrudes a convex cross-section along a road: u is to the right of the
 * direction of travel, v up from the road surface. The section may change
 * along the road (a parapet that dies away, an embankment that grows), as
 * long as it keeps the same number of corners.
 */
function sweep(b: GeoBuilder, path: readonly Sample[], section: Section | ((q: Sample) => Section), color: ColorLike, bucket: 'solid' | 'smooth' = 'solid', caps = true) {
  if (path.length < 2) return;
  const sec = typeof section === 'function' ? section : () => section;
  const rings = path.map((q) => sec(q).map(([u, v]) => new THREE.Vector3(q.x - q.tz * u, q.y + v, q.z + q.tx * u)));
  const centre = (ring: THREE.Vector3[]) => ring.reduce((m, p) => m.add(p), new THREE.Vector3()).multiplyScalar(1 / ring.length);
  const pos: number[] = [];
  const mid = new THREE.Vector3();
  for (let i = 0; i < rings.length - 1; i++) {
    const A = rings[i]!;
    const B = rings[i + 1]!;
    mid.addVectors(centre(A), centre(B)).multiplyScalar(0.5);
    for (let k = 0; k < A.length; k++) {
      const k2 = (k + 1) % A.length;
      outward.copy(A[k]!).add(A[k2]!).add(B[k]!).add(B[k2]!).multiplyScalar(0.25).sub(mid);
      tri(pos, A[k]!, A[k2]!, B[k2]!, outward);
      tri(pos, A[k]!, B[k2]!, B[k]!, outward);
    }
  }
  if (caps) {
    for (const [ring, q, sign] of [[rings[0]!, path[0]!, -1], [rings[rings.length - 1]!, path[path.length - 1]!, 1]] as const) {
      outward.set(q.tx * sign, 0, q.tz * sign);
      for (let k = 1; k < ring.length - 1; k++) tri(pos, ring[0]!, ring[k]!, ring[k + 1]!, outward);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  b.transformed(g, IDENTITY, color, bucket);
}

/** Paint on a road: a continuous line, or dashes `dash` long. `o` is its offset from the centre. */
function stripe(b: GeoBuilder, path: readonly Sample[], o: number | ((q: Sample) => number), w: number, color: ColorLike, dash = 0) {
  const off = typeof o === 'function' ? o : () => o;
  const pos: number[] = [];
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] as const;
  const up = new THREE.Vector3(0, 1, 0);
  const quad = (a: Sample, c: Sample) => {
    const [oa, oc] = [off(a), off(c)];
    v[0].set(a.x - a.tz * (oa - w / 2), a.y + 0.004, a.z + a.tx * (oa - w / 2));
    v[1].set(a.x - a.tz * (oa + w / 2), a.y + 0.004, a.z + a.tx * (oa + w / 2));
    v[2].set(c.x - c.tz * (oc + w / 2), c.y + 0.004, c.z + c.tx * (oc + w / 2));
    v[3].set(c.x - c.tz * (oc - w / 2), c.y + 0.004, c.z + c.tx * (oc - w / 2));
    tri(pos, v[0], v[1], v[2], up);
    tri(pos, v[0], v[2], v[3], up);
  };
  const len = path[path.length - 1]!.s;
  if (dash > 0) for (let s = path[0]!.s + 0.2; s + dash < len; s += dash * 2.1) quad(sampleAt(path, s), sampleAt(path, s + dash));
  else for (let i = 0; i < path.length - 1; i++) quad(path[i]!, path[i + 1]!);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  b.transformed(g, IDENTITY, color);
}

interface DeckStyle {
  /** Roadway width (it may change along the road). */
  w: number | ((q: Sample) => number);
  /** Depth of the girder under the slab, and its colour. */
  girder: number;
  beam: ColorLike;
  parapet: ColorLike;
  /** Offsets of the dashed lane lines. */
  dashes: readonly number[];
}

/**
 * A roadway: slab, girder, parapets and paint. Where the road comes down to
 * the ground, the girder and parapets sink away and the ramp sits on a
 * retained embankment instead of piers.
 */
function deck(b: GeoBuilder, path: readonly Sample[], st: DeckStyle) {
  const width = typeof st.w === 'function' ? st.w : () => st.w as number;
  const lift = (q: Sample) => clamp((q.y - GROUND) / 0.3, 0, 1);
  sweep(b, path, (q) => rect(-width(q) / 2, width(q) / 2, -0.07, 0), ASPHALT);
  const air = part(path, (q) => q.y > 0.5);
  sweep(b, air, (q) => rect(-width(q) / 2 + 0.04, width(q) / 2 - 0.04, -0.07 - st.girder * lift(q), -0.07), st.beam);
  for (const s of [-1, 1]) {
    sweep(b, path, (q) => {
      const h = width(q) / 2;
      const ph = 0.075 * lift(q);
      return s > 0 ? rect(h - 0.035, h, 0, ph) : rect(-h, -h + 0.035, 0, ph);
    }, st.parapet);
  }
  // Low down, the ramp rides on an embankment between retaining walls.
  const low = part(path, (q) => q.y > GROUND + 0.005 && q.y < 0.75);
  if (low.length > 1) {
    sweep(b, low, (q) => {
      const h = width(q) / 2 - 0.02;
      const g = terrainHeight(q.x, q.z);
      return rect(-h, h, Math.min(-0.07, g - q.y - 0.06), -0.07);
    }, CONCRETE);
  }
  for (const s of [-1, 1]) stripe(b, path, (q) => s * (width(q) / 2 - 0.08), 0.016, PALETTE.roadLine);
  for (const o of st.dashes) stripe(b, path, o, 0.02, PALETTE.roadLine, 0.24);
}

/** Is (x, z) on one of the city's arterials? Piers keep off them. */
function onArterial(x: number, z: number, d: number, lines: readonly (readonly P2[])[] = [EMBARCADERO, BAY_APPROACH]): boolean {
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i++) {
      const [ax, az] = line[i]!;
      const [bx, bz] = line[i + 1]!;
      const ex = bx - ax;
      const ez = bz - az;
      const t = clamp(((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1), 0, 1);
      if (Math.hypot(x - ax - ex * t, z - az - ez * t) < d) return true;
    }
  }
  return false;
}

/** Hammerhead piers along a road: a column (or two) and a cap beam, on a footing. */
function piers(b: GeoBuilder, path: readonly Sample[], o: { every: number; from?: number; under: number; cap: number; col: number; color: ColorLike; twin?: number; skip?: (q: Sample) => boolean }) {
  const len = path[path.length - 1]!.s;
  for (let s = path[0]!.s + (o.from ?? o.every / 2); s < len - 0.2; s += o.every) {
    const q = sampleAt(path, s);
    if (o.skip?.(q)) continue;
    const top = q.y - o.under;
    const ground = Math.max(terrainHeight(q.x, q.z), SEA - 0.3);
    if (top - ground < 0.45) continue;
    const yaw = Math.atan2(-q.tz, q.tx);
    b.box(0.16, 0.12, o.cap, q.x, top - 0.12, q.z, o.color, false, yaw);
    for (const u of o.twin ? [-o.twin, o.twin] : [0]) {
      const cx = q.x - q.tz * u;
      const cz = q.z + q.tx * u;
      b.box(o.col, top - 0.12 - ground, o.col, cx, ground, cz, o.color, false, yaw);
      b.box(o.col + 0.14, 0.1, o.col + 0.14, cx, ground - 0.04, cz, SHADE, false, yaw);
    }
  }
}

/** Street lights along a road edge, every `every`. */
function roadLamps(b: GeoBuilder, path: readonly Sample[], u: number, every: number) {
  const len = path[path.length - 1]!.s;
  for (let s = path[0]!.s + every / 2; s < len; s += every) {
    const q = sampleAt(path, s);
    for (const side of [-1, 1]) {
      const x = q.x - q.tz * u * side;
      const z = q.z + q.tx * u * side;
      b.cylinder(0.009, 0.012, 0.3, x, q.y, z, 0x6b6f78, 4);
      b.blob(0.03, x, q.y + 0.31, z, LAMP, true);
    }
  }
}

/** A carriageway for traffic: where cars drive, each lane's offset, and where they're out of sight. */
interface Way {
  x: number;
  y: number;
  z: number;
  tx: number;
  tz: number;
  /** Half the spacing between the two lanes. */
  w: number;
  hide: boolean;
}

const way = (path: readonly Sample[], w: number, hide = false, shift = 0): Way[] =>
  path.map((q) => ({ x: q.x - q.tz * shift, y: q.y, z: q.z + q.tx * shift, tx: q.tx, tz: q.tz, w, hide }));

/** Joins carriageway pieces, dropping points where they overlap. */
function join(...pieces: Way[][]): Way[] {
  const out: Way[] = [];
  for (const p of pieces) {
    for (const q of p) {
      const last = out[out.length - 1];
      if (last && Math.hypot(q.x - last.x, q.y - last.y, q.z - last.z) < 0.08) continue;
      out.push(q);
    }
  }
  return out;
}

/** A straight, level run (tunnels, the main spans). */
function straight(ax: number, az: number, bx: number, bz: number, y: number, step = 0.5): Sample[] {
  return road([[ax, az], [bx, bz]], 0, () => y, step);
}

export interface BridgeLane {
  /** Flat xyz polyline, in the direction of travel. */
  xyz: number[];
  /** Distances along it between which cars are out of sight (the Yerba Buena tunnel). */
  hide: [number, number] | null;
}

/** The two lanes of a carriageway, driving on the right. */
function lanes(w: Way[]): BridgeLane[] {
  return [-1, 1].map((side) => {
    const xyz: number[] = [];
    let s = 0;
    let h0 = -1;
    let h1 = -1;
    for (let i = 0; i < w.length; i++) {
      const q = w[i]!;
      const o = q.w * side;
      const x = q.x - q.tz * o;
      const z = q.z + q.tx * o;
      if (i > 0) s += Math.hypot(x - xyz[xyz.length - 3]!, q.y - xyz[xyz.length - 2]!, z - xyz[xyz.length - 1]!);
      xyz.push(x, q.y, z);
      if (q.hide) {
        if (h0 < 0) h0 = s;
        h1 = s;
      }
    }
    return { xyz, hide: h0 >= 0 ? [h0, h1] : null };
  });
}

interface PortalStyle {
  /** Headwall width, and its base and top. */
  ww: number;
  base: number;
  top: number;
  /** The opening: width, springing line y0..y1, and the rise of its arched head. */
  ow: number;
  y0: number;
  y1: number;
  rise: number;
  color: ColorLike;
  trim: ColorLike;
}

/** An arch-headed outline: a flat sill from y0, straight jambs to y1, a half-ellipse of `rise` above. */
function archOutline(path: THREE.Path, half: number, y0: number, y1: number, rise: number, clockwise: boolean) {
  const pts: [number, number][] = [[-half, y0], [half, y0]];
  for (let k = 0; k <= 14; k++) {
    const a = (k / 14) * Math.PI;
    pts.push([Math.cos(a) * half, y1 + Math.sin(a) * rise]);
  }
  if (clockwise) pts.reverse();
  path.moveTo(pts[0]![0], pts[0]![1]);
  for (const [u, v] of pts.slice(1)) path.lineTo(u, v);
  path.closePath();
}

/**
 * A tunnel mouth: a concrete headwall with an arch-headed opening, a proud
 * arch ring, pilasters and a cornice, and the dark bore behind with lamps
 * along its crown. Built facing local +x (u across = local z), placed by `m`.
 */
function portal(b: GeoBuilder, m: THREE.Matrix4, o: PortalStyle) {
  const put = (g: THREE.BufferGeometry, color: ColorLike, glow: boolean | 'solid' = false) => b.transformed(g, m, color, glow);
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, color: ColorLike) => put(new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z), color);
  // Shape space is (u, v) = (local −z, y); extruded toward local +x.
  const face = (shape: THREE.Shape, depth: number, front: number, color: ColorLike) => {
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
    g.rotateY(Math.PI / 2);
    g.translate(front - depth, 0, 0);
    put(g, color);
  };
  const wall = new THREE.Shape();
  wall.moveTo(-o.ww / 2, o.base);
  wall.lineTo(o.ww / 2, o.base);
  wall.lineTo(o.ww / 2, o.top);
  wall.lineTo(-o.ww / 2, o.top);
  wall.closePath();
  const hole = new THREE.Path();
  archOutline(hole, o.ow / 2, o.y0, o.y1, o.rise, true);
  wall.holes.push(hole);
  face(wall, 0.4, 0, o.color);
  const ring = new THREE.Shape();
  archOutline(ring, o.ow / 2 + 0.1, o.y0, o.y1, o.rise + 0.1, false);
  const inner = new THREE.Path();
  archOutline(inner, o.ow / 2, o.y0, o.y1, o.rise, true);
  ring.holes.push(inner);
  face(ring, 0.06, 0.05, o.trim);
  // Cornice, plinth and pilasters
  box(0.14, 0.09, o.ww + 0.12, 0.02, o.top - 0.03, 0, o.trim);
  box(0.1, 0.06, o.ww, 0.03, o.top - 0.2, 0, o.trim);
  for (const s of [-1, 1]) {
    box(0.08, o.top - o.base - 0.12, 0.22, 0.04, o.base, s * (o.ww / 2 - 0.14), o.trim);
    box(0.06, o.top - o.base - 0.3, 0.1, 0.06, o.base, s * (o.ow / 2 + 0.32), o.trim);
  }
  // The bore: darkness at the back of the reveals (a face, not a box, so nothing pokes up
  // through a thin ridge), and lamps along the crown just inside the mouth.
  put(new THREE.PlaneGeometry(o.ow + 0.1, o.y1 + o.rise - o.y0 + 0.1).rotateY(Math.PI / 2).translate(-0.39, (o.y0 + o.y1 + o.rise) / 2, 0), 0x1d2024);
  for (const s of [-1, 1]) put(new THREE.IcosahedronGeometry(0.022, 0).translate(-0.22, o.y1 + o.rise * 0.55, s * o.ow * 0.3), LAMP, true);
}

/** A retaining wall from a headwall back into the hill, its coping easing down to the slope. */
function wingWall(b: GeoBuilder, ax: number, az: number, bx: number, bz: number, cap: number, color: ColorLike) {
  const path = road([[ax, az], [bx, bz]], 0, () => 0, 0.15);
  const len = path[path.length - 1]!.s;
  const top = (q: Sample) => Math.max(terrainHeight(q.x, q.z) + 0.1, cap - (cap - terrainHeight(q.x, q.z)) * smooth01(q.s / len));
  sweep(b, path, (q) => rect(-0.07, 0.07, terrainHeight(q.x, q.z) - 0.5, top(q)), color);
  sweep(b, path, (q) => rect(-0.09, 0.09, top(q), top(q) + 0.04), SHADE);
}

// ─── Golden Gate Bridge ─────────────────────────────────────────────────────

const GG_DECK = 2.25;
const GG_TOWERS = [11.4, 19.6] as const;
/** Where the suspended deck reaches the Presidio: the south anchorage and its pylons. */
const GG_SOUTH = 9.0;
/** Lanes: two each way, a quarter of the deck either side of the median. */
const GG_WAY = 0.31;
const GG_LANE = 0.14;

interface GGLayout {
  x: number;
  /** The Waldo Tunnel portal in the Marin headland. */
  north: number;
  anchorN: number;
  /** From the south anchorage down over the Presidio to the toll plaza on Presidio Parkway. */
  south: Sample[];
  /** Where the toll plaza stands along it. */
  plaza: number;
}

let ggCache: GGLayout | null = null;
function ggLayout(): GGLayout {
  if (ggCache) return ggCache;
  const { x } = LANDMARKS.goldenGate;
  // Marin: the deck runs on until the headland rises to meet it, then dives into the hill.
  let north = 23.4;
  for (let z = 21.5; z < 27; z += 0.05) {
    if (Math.max(terrainHeight(x - 0.4, z), terrainHeight(x, z), terrainHeight(x + 0.4, z)) >= GG_DECK + 0.02) {
      north = z;
      break;
    }
  }
  const touch = 8.6;
  const south = road([[x, GG_SOUTH], ...PRESIDIO_PKWY], 1.4, (s) => ease(s, 0.3, touch, GG_DECK, GROUND));
  ggCache = { x, north, anchorN: Math.min(22.4, north - 1.0), south, plaza: touch + 1.5 };
  return ggCache;
}

/** Runs along z at x = goldenGate.x, from the Presidio to Marin. */
export function goldenGate(): THREE.Group {
  const b = new GeoBuilder();
  const L = ggLayout();
  const { x } = L;
  const deckY = GG_DECK;
  const z0 = GG_SOUTH;
  const z1 = L.north + 0.4;
  const towers = GG_TOWERS;
  const top = 8.4;
  const cable = 0.72;
  const leg = 0.86;
  const mid = (z0 + z1) / 2;
  const len = z1 - z0;

  // Deck: asphalt, paint, the zipper barrier, the orange stiffening trusses
  b.box(1.3, 0.1, len, x, deckY - 0.1, mid, ASPHALT);
  b.box(0.035, 0.035, len, x, deckY, mid, 0xe2b23a);
  for (const s of [-1, 1]) {
    b.decal(0.016, len, x + s * 0.57, deckY + 0.004, mid, PALETTE.roadLine);
    for (let z = z0 + 0.3; z < z1; z += 0.55) b.decal(0.02, 0.25, x + s * GG_WAY, deckY + 0.004, z, PALETTE.roadLine);
    const tx = x + s * 0.69;
    b.box(0.06, 0.06, len, tx, deckY - 0.06, mid, ORANGE); // top chord
    b.box(0.06, 0.06, len, tx, deckY - 0.5, mid, ORANGE); // bottom chord
    for (let z = z0; z < z1 - 0.01; z += 0.5) {
      b.box(0.04, 0.38, 0.04, tx, deckY - 0.44, z, ORANGE);
      strut(b, new THREE.Vector3(tx, deckY - 0.46, z), new THREE.Vector3(tx, deckY - 0.08, z + 0.5), 0.025, ORANGE_DARK);
    }
    b.box(0.03, 0.08, len, x + s * 0.64, deckY, mid, ORANGE); // railing
  }
  // Floor beams under the deck, seen from the water
  for (let z = z0 + 0.25; z < z1; z += 1.0) b.box(1.4, 0.05, 0.05, x, deckY - 0.5, z, ORANGE_DARK);

  // Towers: tapering legs either side of the deck, stacked portals, art deco recesses
  for (const tz of towers) {
    for (const s of [-1, 1]) {
      const legs: [number, number, number][] = [
        [SEA - 0.4, deckY + 1.8, 0.36],
        [deckY + 1.8, deckY + 4.2, 0.32],
        [deckY + 4.2, top, 0.28],
      ];
      for (const [y0, y1, w] of legs) {
        const lx = x + s * (leg + (0.36 - w) / 2);
        b.box(w, y1 - y0, w * 1.15, lx, y0, tz, ORANGE);
        for (const f of [-1, 1]) b.box(w * 0.42, y1 - y0 - 0.2, 0.02, lx, y0 + 0.1, tz + f * ((w * 1.15) / 2 + 0.006), ORANGE_DARK);
      }
      b.blob(0.07, x + s * leg, top + 0.12, tz, RED_LIGHT, true);
    }
    for (const py of [deckY + 1.8, deckY + 3.6, deckY + 5.0, top - 0.3]) {
      b.box(leg * 2 + 0.2, 0.3, 0.32, x, py - 0.15, tz, ORANGE);
      for (let k = -1; k <= 1; k++) for (const f of [-1, 1]) b.box(0.18, 0.18, 0.02, x + k * 0.36, py - 0.09, tz + f * 0.17, ORANGE_DARK);
    }
    // Cable saddles, the portal under the deck, the fender pier
    for (const s of [-1, 1]) b.box(0.16, 0.12, 0.42, x + s * cable, top, tz, ORANGE_DARK);
    b.box(leg * 2 + 0.2, 0.28, 0.32, x, deckY - 0.85, tz, ORANGE);
    b.box(2.3, 0.7, 1.0, x, SEA - 0.4, tz, CONCRETE);
    b.box(2.4, 0.06, 1.1, x, SEA + 0.3, tz, SHADE);
  }

  // Main cables, suspenders and deck lights
  const anchors: [number, number][] = [[z0 + 0.1, deckY + 0.5], [towers[0], top + 0.08], [towers[1], top + 0.08], [L.anchorN, deckY + 0.5]];
  const pts = cablePoints(anchors, [0.35, 5.3, 0.35], 22);
  for (const s of [-1, 1]) {
    const curve = new THREE.CatmullRomCurve3(pts.map(([z, y]) => new THREE.Vector3(x + s * cable, y, z)));
    b.transformed(new THREE.TubeGeometry(curve, 160, 0.055, 6), new THREE.Matrix4(), ORANGE, 'smooth');
    for (let i = 1; i < pts.length - 1; i++) {
      const [z, y] = pts[i]!;
      if (y - deckY > 0.25 && Math.abs(z - towers[0]) > 0.3 && Math.abs(z - towers[1]) > 0.3) b.box(0.018, y - deckY, 0.018, x + s * cable, deckY, z, ORANGE_DARK);
    }
    for (let z = z0 + 0.3; z < z1; z += 0.85) {
      b.cylinder(0.01, 0.01, 0.34, x + s * 0.62, deckY, z, 0x6b6f78, 4);
      b.blob(0.035, x + s * 0.62, deckY + 0.36, z, LAMP, true);
    }
  }

  // Anchorages: an art deco pylon either side of the deck at each end, the cables running into them
  for (const az of [z0, L.anchorN]) {
    for (const s of [-1, 1]) {
      const px = x + s * 0.98;
      const g = Math.max(SEA - 0.3, Math.min(terrainHeight(px, az), deckY - 0.6)) - 0.2;
      b.box(0.62, deckY + 0.55 - g, 0.9, px, g, az, CONCRETE);
      b.box(0.5, 0.35, 0.78, px, deckY + 0.55, az, CONCRETE);
      b.box(0.36, 0.25, 0.62, px, deckY + 0.9, az, CONCRETE);
      for (let k = -1; k <= 1; k++) b.box(0.02, deckY + 0.3 - g, 0.12, px + s * 0.315, g + 0.2, az + k * 0.26, SHADE);
      b.box(0.66, 0.06, 0.94, px, deckY + 0.5, az, SHADE);
    }
    // The deck rests on a pier between them.
    const g = Math.max(SEA - 0.3, terrainHeight(x, az));
    b.box(1.2, deckY - 0.5 - g, 0.5, x, g, az, CONCRETE);
  }
  // Side-span piers over the shallows
  for (const zz of [20.7, 21.6]) {
    if (zz > L.anchorN - 0.5) continue;
    const g = Math.max(SEA - 0.3, terrainHeight(x, zz));
    for (const s of [-1, 1]) b.box(0.26, deckY - 0.5 - g, 0.26, x + s * 0.5, g, zz, CONCRETE);
    b.box(1.3, 0.12, 0.3, x, deckY - 0.62, zz, CONCRETE);
  }

  // Fort Point arch: a steel arch over the old fort carries the deck from the shore to the tower.
  const a0 = z0 + 0.15;
  const a1 = towers[0] - 0.55;
  for (const s of [-1, 1]) {
    const ax = x + s * 0.55;
    const arc: THREE.Vector3[] = [];
    const ground0 = Math.max(SEA, terrainHeight(ax, a0));
    const ground1 = Math.max(SEA, terrainHeight(ax, a1));
    for (let k = 0; k <= 10; k++) {
      const t = k / 10;
      const base = ground0 + (ground1 - ground0) * t;
      arc.push(new THREE.Vector3(ax, base + (deckY - 0.6 - base) * Math.sin(t * Math.PI) ** 0.7, a0 + (a1 - a0) * t));
    }
    for (let k = 0; k < arc.length - 1; k++) strut(b, arc[k]!, arc[k + 1]!, 0.09, ORANGE);
    for (let k = 1; k < arc.length - 1; k++) b.box(0.035, deckY - 0.5 - arc[k]!.y, 0.035, ax, arc[k]!.y, arc[k]!.z, ORANGE_DARK);
  }

  // The Presidio: down a viaduct over the trees to the toll plaza
  const south = L.south;
  deck(b, south, { w: 1.3, girder: 0.16, beam: CONCRETE, parapet: ORANGE, dashes: [-GG_WAY, GG_WAY] });
  sweep(b, south, rect(-0.018, 0.018, 0, 0.035), 0xe2b23a);
  piers(b, south, { every: 1.15, from: 0.9, under: 0.23, cap: 1.35, col: 0.13, color: CONCRETE, twin: 0.56, skip: (q) => onArterial(q.x, q.z, 0.75, [EMBARCADERO]) });
  roadLamps(b, part(south, (q) => q.s > 0.4), 0.6, 1.2);
  tollPlaza(b, south, L.plaza);

  // Marin: the deck dives into the Waldo Tunnel, rainbow painted round its mouth.
  waldoTunnel(b, x, L.north, deckY);

  const { group } = b.build();
  group.traverse((o) => (o.castShadow = true));
  group.userData.tip = { title: 'Golden Gate Bridge', detail: 'Free infrastructure. Rusts if upkeep falls short.' };
  return group;
}

/** The toll plaza: the road widens round a row of booths under a long canopy. */
function tollPlaza(b: GeoBuilder, path: readonly Sample[], at: number) {
  const pad = part(path, (q) => Math.abs(q.s - at) < 1.4);
  const w = (q: Sample) => 1.3 + 1.5 * smooth01((1.4 - Math.abs(q.s - at)) / 0.8);
  sweep(b, pad, (q) => rect(-w(q) / 2, w(q) / 2, -0.06, 0.003), 0x585c66);
  const q = sampleAt(path, at);
  const yaw = Math.atan2(-q.tz, q.tx);
  const across = (u: number, along = 0): [number, number] => [q.x - q.tz * u + q.tx * along, q.z + q.tx * u + q.tz * along];
  for (let k = -3; k <= 3; k++) {
    const [bx, bz] = across(k * 0.38);
    b.box(0.5, 0.03, 0.09, bx, q.y, bz, 0xd9d4c8, false, yaw); // kerbed island
    b.box(0.13, 0.13, 0.07, bx, q.y + 0.03, bz, 0xf4f1ea, false, yaw); // booth
    b.box(0.135, 0.05, 0.075, bx, q.y + 0.09, bz, 0x3f6588, 'glass', yaw);
    b.box(0.15, 0.02, 0.09, bx, q.y + 0.16, bz, ORANGE, false, yaw);
    const [px, pz] = across(k * 0.38, 0.12);
    b.box(0.03, 0.3, 0.03, px, q.y + 0.03, pz, 0xc9c4b8, false, yaw);
    if (k < 3) {
      const [lx, lz] = across(k * 0.38 + 0.19, 0.14);
      b.blob(0.016, lx, q.y + 0.3, lz, [0.3, 3, 0.6], true);
    }
  }
  // The canopy, and the plaza office beside the road
  const [cx, cz] = across(0, 0.05);
  b.box(0.5, 0.05, 2.8, cx, q.y + 0.33, cz, 0xf2efe8, false, yaw);
  b.box(0.52, 0.02, 2.82, cx, q.y + 0.38, cz, ORANGE, false, yaw);
  const [ox, oz] = across(2.0, 0.4);
  b.box(0.6, 0.3, 0.45, ox, q.y - 0.05, oz, 0xf2ece0, false, yaw);
  b.box(0.66, 0.04, 0.5, ox, q.y + 0.25, oz, 0x9a8f80, false, yaw);
}

  /** The Waldo Tunnel's south portal, its arch painted as a rainbow, and a short cut-and-cover hood into the headland. */
function waldoTunnel(b: GeoBuilder, x: number, z: number, deckY: number) {
  const top = deckY + 1.1;
  // Local +x faces the bridge (world −z).
  const m = new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(x, 0, z);
  const y1 = deckY + 0.42;
  portal(b, m, { ww: 2.3, base: deckY - 1.4, top, ow: 1.36, y0: deckY - 0.08, y1, rise: 0.4, color: 0xd8d2c4, trim: 0xece6d8 });
  // The rainbow painted round the arch, from violet inside to red outside
  [0x8a5ab8, 0x3a7ac8, 0x5aa85a, 0xf2c84b, 0xe8873a, 0xd8423a].forEach((c, i) => {
    const r0 = 0.69 + i * 0.045;
    const ring = new THREE.Shape();
    ring.absarc(0, 0, r0 + 0.045, 0, Math.PI, false);
    ring.lineTo(-r0, 0);
    ring.absarc(0, 0, r0, Math.PI, 0, true);
    ring.closePath();
    const g = new THREE.ExtrudeGeometry(ring, { depth: 0.012, bevelEnabled: false, curveSegments: 18 });
    g.scale(1, 0.59, 1);
    g.rotateY(Math.PI / 2);
    g.translate(0.055, y1, 0);
    b.transformed(g, m, c);
    // …and down the jambs
    for (const s of [-1, 1]) b.transformed(new THREE.BoxGeometry(0.012, y1 - deckY, 0.045).translate(0.061, (y1 + deckY) / 2, s * (r0 + 0.0225)), m, c);
  });
  // A short concrete hood back into the hill, where the headland is too low to cover the bore
  let hood = 0.6;
  for (let d = 0.6; d < 1.2; d += 0.1) {
    hood = d;
    if (terrainHeight(x, z + d) > top - 0.2) break;
  }
  b.transformed(new THREE.BoxGeometry(hood, top - deckY + 0.2, 1.9).translate(-0.4 - hood / 2, (top + deckY - 0.4) / 2, 0), m, 0xcfc8b8);
  b.transformed(new THREE.BoxGeometry(hood + 0.04, 0.05, 2.0).translate(-0.4 - hood / 2, top - 0.15, 0), m, 0xb8b0a0);
  for (const s of [-1, 1]) wingWall(b, x + s * 1.1, z - 0.05, x + s * 2.1, z + 0.7, top - 0.1, 0xd8d2c4);
}

// ─── Bay Bridge ─────────────────────────────────────────────────────────────

export interface BayBridge {
  group: THREE.Group;
  /** The Bay Lights: LED points that shimmer along the suspenders at night. */
  lights: THREE.ShaderMaterial;
}

const BB_UP = 2.35;
const BB_LOW = 1.9;
/** Rincon Point: the west anchorage, where the cables come down at the shore. */
const BB_WEST = 12.3;
const BB_CENTRAL = 22.0;
/** East of the island the decks run side by side, this far either side of the line. */
const BB_SPLIT = 0.36;

interface BBLayout {
  z: number;
  /** The Yerba Buena tunnel's west and east portals. */
  xw: number;
  xe: number;
  /** West span towers. */
  towers: number[];
  /** The self-anchored span's tower. */
  sx: number;
  /** Where the skyway lands in Oakland. */
  xl: number;
  /** SF approach: the upper deck (westbound) and lower deck (eastbound) down to Rincon Hill. */
  upper: Sample[];
  lower: Sample[];
  /** East of the tunnel: the westbound deck (south) and eastbound deck (north), portal to Oakland. */
  wb: Sample[];
  eb: Sample[];
  /** Oakland: the roads they split into on the shore. */
  wbOak: Sample[];
  ebOak: Sample[];
}

let bbCache: BBLayout | null = null;
function bbLayout(): BBLayout {
  if (bbCache) return bbCache;
  const { z } = LANDMARKS.bayBridge;
  // The portals sit where Yerba Buena's ridge rises to meet the lower deck.
  const ridge = (x: number) => Math.max(terrainHeight(x, z - 0.6), terrainHeight(x, z), terrainHeight(x, z + 0.6));
  let xw = 31;
  let xe = 35.2;
  for (let x = 29; x < 33; x += 0.05) if (ridge(x) >= BB_LOW - 0.2) { xw = x; break; }
  for (let x = 38; x > 33; x -= 0.05) if (ridge(x) >= BB_LOW - 0.2) { xe = x; break; }
  xw = clamp(xw, 30, 32);
  xe = clamp(xe, 34.4, 36.4);
  const towers = [14.5, 19.3, 24.7, Math.min(29.2, xw - 1.3)];
  const sx = xe + 6.8;
  const sasE = sx + 2.4;
  // Oakland: the skyway eases down to meet the shore.
  let xl = 59.5;
  for (let x = 56; x < 63; x += 0.05) if (terrainHeight(x, z) >= BB_LOW - 0.05) { xl = x; break; }
  const yl = terrainHeight(xl, z) + GROUND;
  const sky = (x: number) => ease(x, sasE, xl, BB_UP, yl);

  // San Francisco: both decks come down off Rincon Hill on ramps that turn south over the strip
  // between the Embarcadero and the city's edge, and touch down onto the street at z = −17.5.
  const upper = road([[BB_WEST, z], [8.7, z], [8.7, -17.25], [7.85, -17.25]], 0.6, (s, len) => ease(s, 0, len - 2.3, BB_UP, GROUND));
  const lower = road([[BB_WEST, z], [9.45, z], [9.45, -17.95], [7.85, -17.95]], 1.0, (s, len) => ease(s, 0, len - 2.9, BB_LOW, GROUND));
  for (const q of lower) if (Math.abs(q.z + 17.95) < 0.05 && q.x < 8.2) q.y = GROUND;

  const portalOut = xe - 0.7;
  const wb = road([[portalOut, z], [xe + 0.3, z], [xe + 1.9, z - BB_SPLIT], [xl, z - BB_SPLIT]], 2, () => 0);
  for (const q of wb) q.y = sky(q.x);
  const eb = road([[portalOut, z], [xe + 0.3, z], [xe + 1.9, z + BB_SPLIT], [xl, z + BB_SPLIT]], 2, () => 0);
  for (const q of eb) q.y = q.x < xe + 3.4 ? ease(q.x, xe + 1.9, xe + 3.4, BB_LOW, BB_UP) : sky(q.x);
  const onGround = (_s: number, _l: number, x: number, zz: number) => terrainHeight(x, zz) + GROUND;
  const wbOak = road([[xl - 0.2, z - BB_SPLIT], [xl + 1.4, z - BB_SPLIT], [xl + 1.4, z - 5]], 1.1, onGround);
  const ebOak = road([[xl - 0.2, z + BB_SPLIT], [xl + 1.4, z + BB_SPLIT], [xl + 1.4, z + 4.5]], 1.1, onGround);
  bbCache = { z, xw, xe, towers, sx, xl, upper, lower, wb, eb, wbOak, ebOak };
  return bbCache;
}

/**
 * Traffic lanes over both bridges, in the direction of travel: the Golden
 * Gate (two lanes each way) and the Bay Bridge (westbound on the upper deck,
 * eastbound below, side by side east of Yerba Buena), each running from the
 * ground at one end to the ground at the other.
 */
export function bridgeLanes(): { goldenGate: BridgeLane[]; bayBridge: BridgeLane[] } {
  const G = ggLayout();
  const ggMain = straight(G.x, GG_SOUTH, G.x, G.north + 0.5, GG_DECK, 0.5);
  const north = join(way(reversed(G.south), GG_LANE, false, GG_WAY), way(ggMain, GG_LANE, false, GG_WAY));
  const south = join(way(reversed(ggMain), GG_LANE, false, GG_WAY), way(G.south, GG_LANE, false, GG_WAY));

  const B = bbLayout();
  const tunnel = straight(B.xe - 0.6, B.z, B.xw, B.z, 0, 0.5);
  const hidden = (y: number) => way(tunnel.map((q) => ({ ...q, y })), 0.2, true);
  const westSpans = (y: number) => straight(B.xw, B.z, BB_WEST, B.z, y, 0.5);
  const westbound = join(
    way(reversed(B.wbOak), 0.15),
    way(reversed(B.wb), 0.15),
    hidden(BB_UP),
    way(westSpans(BB_UP), 0.2),
    way(B.upper, 0.15),
  );
  const eastbound = join(
    way(reversed(B.lower), 0.15),
    way(reversed(westSpans(BB_LOW)), 0.2),
    reversedWay(hidden(BB_LOW)),
    way(B.eb, 0.15),
    way(B.ebOak, 0.15),
  );
  return { goldenGate: [...lanes(north), ...lanes(south)], bayBridge: [...lanes(westbound), ...lanes(eastbound)] };
}

const reversedWay = (w: Way[]): Way[] => [...w].reverse().map((q) => ({ ...q, tx: -q.tx, tz: -q.tz }));

/**
 * A massive concrete anchorage the double deck passes through: a pier to the
 * lower deck, walls either side rising past both decks, a lintel the cables
 * run into, fluted faces and a stepped cornice.
 */
function anchorage(b: GeoBuilder, x: number, z: number, base: number) {
  const w = 1.5;
  b.box(w + 0.3, 0.3, 2.7, x, base - 0.2, z, SHADE);
  b.box(w, BB_LOW - 0.32 - base, 2.3, x, base, z, CONCRETE);
  for (const s of [-1, 1]) {
    const wz = z + s * 0.94;
    b.box(w, BB_UP + 1.0 - base, 0.44, x, base, wz, CONCRETE);
    // Fluting on the outer face and the ends
    for (let k = -2; k <= 2; k++) b.box(0.1, BB_UP + 0.6 - base, 0.03, x + k * 0.28, base + 0.2, z + s * 1.165, SHADE);
    for (const e of [-1, 1]) b.box(0.03, BB_UP + 0.6 - base, 0.12, x + e * (w / 2 + 0.01), base + 0.2, wz, SHADE);
  }
  b.box(w, 0.5, 2.32, x, BB_UP + 0.5, z, CONCRETE);
  b.box(w + 0.1, 0.07, 2.42, x, BB_UP + 1.0, z, SHADE);
  b.box(w - 0.2, 0.12, 2.1, x, BB_UP + 1.07, z, CONCRETE);
  // Cable housings on top, where the main cables bed into the concrete
  for (const s of [-1, 1]) b.box(0.6, 0.16, 0.26, x, BB_UP + 1.19, z + s * 0.68, 0xb4ada0);
}

/** Runs along x at z = bayBridge.z, from Rincon Hill to Yerba Buena and on to Oakland. */
export function bayBridge(): BayBridge {
  const b = new GeoBuilder();
  const L = bbLayout();
  const { z, xw, xe, sx, towers } = L;
  const top = 7.2;
  const cab = 0.66;
  const legZ = 0.8;
  const lightPos: number[] = [];

  // ── West spans: two decks inside a stiffening truss, Rincon Point to Yerba Buena
  const x0 = BB_WEST;
  const x1 = xw + 0.5;
  const len = x1 - x0;
  const mid = (x0 + x1) / 2;
  for (const [y, w] of [[BB_UP, 1.2], [BB_LOW, 1.1]] as const) {
    b.box(len, 0.09, w, mid, y - 0.09, z, ASPHALT);
    for (const s of [-1, 1]) b.decal(len, 0.016, mid, y + 0.004, z + s * (w / 2 - 0.08), PALETTE.roadLine);
    for (let x = x0 + 0.3; x < x1; x += 0.5) b.decal(0.24, 0.02, x, y + 0.004, z, PALETTE.roadLine);
  }
  for (const s of [-1, 1]) {
    const tz = z + s * 0.64;
    b.box(len, 0.07, 0.07, mid, BB_UP - 0.07, tz, STEEL);
    b.box(len, 0.07, 0.07, mid, BB_LOW - 0.17, tz, STEEL);
    for (let x = x0 + 0.25; x < x1 - 0.2; x += 0.6) {
      b.box(0.04, BB_UP - BB_LOW + 0.1, 0.04, x, BB_LOW - 0.1, tz, STEEL);
      strut(b, new THREE.Vector3(x, BB_LOW - 0.12, tz), new THREE.Vector3(x + 0.6, BB_UP - 0.04, tz), 0.028, 0x8c949e);
    }
    b.box(len, 0.06, 0.03, mid, BB_UP, z + s * 0.6, 0x9aa3ad); // railing
  }
  for (let x = x0 + 0.25; x < x1; x += 1.2) b.box(0.05, 0.05, 1.32, x, BB_LOW - 0.17, z, 0x8c949e); // floor beams

  // Towers: steel legs outside the truss, X-braced above the deck, on concrete caissons
  for (const tx of towers) {
    for (const s of [-1, 1]) {
      b.box(0.24, BB_LOW - 0.3 - SEA, 0.26, tx, SEA, z + s * legZ, STEEL);
      b.box(0.2, top - (BB_LOW - 0.3), 0.22, tx, BB_LOW - 0.3, z + s * legZ, STEEL);
      b.box(0.22, 0.04, 0.24, tx, BB_UP + 0.25, z + s * legZ, 0x8c949e);
      b.blob(0.06, tx, top + 0.18, z + s * legZ, RED_LIGHT, true);
    }
    const ys = [BB_UP + 0.5, BB_UP + 2.0, BB_UP + 3.4, top - 0.25];
    for (const y of ys) b.box(0.16, 0.16, legZ * 2, tx, y - 0.08, z, STEEL);
    for (let i = 0; i < ys.length - 1; i++) {
      strut(b, new THREE.Vector3(tx, ys[i]!, z - legZ), new THREE.Vector3(tx, ys[i + 1]! - 0.16, z + legZ), 0.045, 0x8c949e);
      strut(b, new THREE.Vector3(tx, ys[i]!, z + legZ), new THREE.Vector3(tx, ys[i + 1]! - 0.16, z - legZ), 0.045, 0x8c949e);
    }
    b.box(0.2, 0.2, legZ * 2 + 0.24, tx, BB_LOW - 0.5, z, STEEL); // strut under the decks
    strut(b, new THREE.Vector3(tx, SEA + 0.3, z - legZ), new THREE.Vector3(tx, BB_LOW - 0.5, z + legZ), 0.045, 0x8c949e);
    strut(b, new THREE.Vector3(tx, SEA + 0.3, z + legZ), new THREE.Vector3(tx, BB_LOW - 0.5, z - legZ), 0.045, 0x8c949e);
    for (const s of [-1, 1]) b.box(0.3, 0.14, 0.36, tx, top, z + s * cab, 0x8c949e); // cable saddles
    b.box(1.0, 0.75, 2.2, tx, SEA - 0.5, z, CONCRETE);
    b.box(1.1, 0.06, 2.3, tx, SEA + 0.25, z, SHADE);
  }
  anchorage(b, BB_WEST, z, SEA - 0.3);
  anchorage(b, BB_CENTRAL, z, SEA - 0.4);

  // Main cables and suspenders, the Bay Lights strung down the north side
  const spans: [number, number][][] = [
    [[BB_WEST + 0.1, BB_UP + 1.12], [towers[0]!, top + 0.08], [towers[1]!, top + 0.08], [BB_CENTRAL - 0.1, BB_UP + 1.12]],
    [[BB_CENTRAL + 0.1, BB_UP + 1.12], [towers[2]!, top + 0.08], [towers[3]!, top + 0.08], [xw - 0.15, BB_UP + 1.1]],
  ];
  for (const anchors of spans) {
    const pts = cablePoints(anchors, [0.3, 4.2, 0.3], 18);
    for (const s of [-1, 1]) {
      const curve = new THREE.CatmullRomCurve3(pts.map(([x, y]) => new THREE.Vector3(x, y, z + s * cab)));
      b.transformed(new THREE.TubeGeometry(curve, 120, 0.045, 5), new THREE.Matrix4(), STEEL, 'smooth');
      for (let i = 1; i < pts.length - 1; i++) {
        const [x, y] = pts[i]!;
        if (y - BB_UP < 0.25 || Math.abs(x - BB_CENTRAL) < 0.85 || Math.abs(x - BB_WEST) < 0.85 || towers.some((t) => Math.abs(x - t) < 0.2)) continue;
        b.box(0.014, y - BB_UP, 0.014, x, BB_UP, z + s * cab, 0x8c949e);
        if (s > 0) for (let k = 0; k < 6; k++) lightPos.push(x, BB_UP + ((y - BB_UP) * (k + 0.5)) / 6, z + cab + 0.03);
      }
    }
  }
  for (let x = x0 + 0.6; x < xw - 0.3; x += 1.1) {
    if (Math.abs(x - BB_CENTRAL) < 0.9) continue;
    for (const s of [-1, 1]) {
      b.cylinder(0.008, 0.01, 0.28, x, BB_UP, z + s * 0.56, 0x6b6f78, 4);
      b.blob(0.03, x, BB_UP + 0.29, z + s * 0.56, LAMP, true);
    }
  }

  // ── Rincon Hill: off the anchorage, the decks come down to the city on two ramps.
  const narrowU = (q: Sample) => ease(q.s, 0.6, 2.6, 1.2, 0.66);
  const narrowL = (q: Sample) => ease(q.s, 0.6, 2.4, 1.1, 0.66);
  deck(b, L.upper, { w: narrowU, girder: 0.15, beam: CONCRETE, parapet: 0xd9d4c8, dashes: [0] });
  deck(b, L.lower, { w: narrowL, girder: 0.15, beam: CONCRETE, parapet: 0xd9d4c8, dashes: [0] });
  // One bent carries both decks over the beach; then each ramp has its own piers.
  {
    const bx = 11.65;
    const u = sampleAt(L.upper, BB_WEST - bx);
    const l = sampleAt(L.lower, BB_WEST - bx);
    const g = Math.max(terrainHeight(bx, z), SEA - 0.3);
    for (const s of [-1, 1]) {
      b.box(0.16, u.y - 0.22 - g, 0.16, bx, g, z + s * 0.74, CONCRETE);
      b.box(0.3, 0.1, 0.3, bx, g - 0.05, z + s * 0.74, SHADE);
    }
    b.box(0.18, 0.12, 1.66, bx, u.y - 0.34, z, CONCRETE);
    b.box(0.18, 0.12, 1.66, bx, l.y - 0.34, z, CONCRETE);
  }
  const clearOfLower = (q: Sample) => L.lower.every((p) => Math.hypot(p.x - q.x, p.z - q.z) > 0.55);
  piers(b, L.upper, { every: 1.3, from: 4.3, under: 0.22, cap: 0.7, col: 0.14, color: CONCRETE, skip: (q) => onArterial(q.x, q.z, 0.75) || !clearOfLower(q) });
  piers(b, L.lower, { every: 1.3, from: 3.9, under: 0.22, cap: 0.7, col: 0.14, color: CONCRETE, skip: (q) => onArterial(q.x, q.z, 0.75) });
  roadLamps(b, part(L.upper, (q) => q.s > 3), 0.36, 1.6);
  roadLamps(b, part(L.lower, (q) => q.s > 3.2), 0.36, 1.6);

  // ── Yerba Buena: both decks go into the tunnel, through portals in the rock with retaining walls.
  const portalStyle = (top: number): PortalStyle => ({ ww: 2.4, base: SEA - 0.4, top, ow: 1.3, y0: BB_LOW - 0.36, y1: BB_UP + 0.22, rise: 0.3, color: 0xd6d0c2, trim: 0xe9e3d5 });
  portal(b, new THREE.Matrix4().makeRotationY(Math.PI).setPosition(xw, 0, z), portalStyle(BB_UP + 1.15));
  portal(b, new THREE.Matrix4().setPosition(xe, 0, z), portalStyle(BB_UP + 1.15));
  for (const s of [-1, 1]) {
    wingWall(b, xw - 0.2, z + s * 1.15, xw + 0.8, z + s * 2.0, BB_UP + 1.0, 0xd6d0c2);
    wingWall(b, xe + 0.2, z + s * 1.15, xe - 0.8, z + s * 2.0, BB_UP + 1.0, 0xd6d0c2);
  }
  // Out of the east portal the double deck becomes two decks side by side: the lower one
  // steps north and climbs to the upper one's level.
  const east = { girder: 0.17, beam: WHITE, parapet: 0xf2efe8, dashes: [0] } as const;
  deck(b, L.wb, { ...east, w: 0.64 });
  deck(b, L.eb, { ...east, w: 0.64 });
  deck(b, L.wbOak, { ...east, w: 0.64 });
  deck(b, L.ebOak, { ...east, w: 0.64 });
  roadLamps(b, part(L.wb, (q) => q.x > xe + 2), 0.3, 1.25);
  roadLamps(b, part(L.eb, (q) => q.x > xe + 3.4), 0.3, 1.25);

  // The skyway: a tapered column under each deck, a shared pile cap in the water
  for (let x = xe + 2.3; x < L.xl - 0.6; x += 1.6) {
    if (Math.abs(x - sx) < 1.3) continue;
    let wet = true;
    for (const s of [-1, 1]) {
      const path = s < 0 ? L.wb : L.eb;
      const q = path.reduce((best, p) => (Math.abs(p.x - x) < Math.abs(best.x - x) ? p : best), path[0]!);
      const dz = q.z;
      const g = Math.max(terrainHeight(x, dz), SEA);
      if (g > SEA + 0.05) wet = false;
      const yb = q.y - 0.07 - 0.17;
      b.cylinder(0.1, 0.14, yb - 0.1 - g, x, g, dz, WHITE, 6);
      b.box(0.24, 0.1, 0.6, x, yb - 0.1, dz, WHITE);
      if (!wet) b.box(0.36, 0.1, 0.36, x, g - 0.05, dz, SHADE);
    }
    if (wet) b.box(0.5, 0.14, 1.5, x, SEA - 0.08, z, CONCRETE);
  }
  // Oakland: an abutment where the skyway meets the shore
  {
    const g = terrainHeight(L.xl, z);
    b.box(0.4, 0.4, 1.7, L.xl - 0.1, g - 0.35, z, CONCRETE);
  }

  // The self-anchored suspension span: one tower of four tapered legs between the decks
  const towerTop = 8.4;
  for (const lx of [-0.16, 0.16]) {
    for (const lz of [-0.07, 0.07]) {
      const leg = new THREE.CylinderGeometry(0.05, 0.085, towerTop - SEA, 5);
      b.transformed(leg, new THREE.Matrix4().makeTranslation(sx + lx, SEA + (towerTop - SEA) / 2, z + lz), WHITE);
    }
  }
  for (let y = BB_UP + 0.5; y < towerTop - 0.2; y += 0.7) b.box(0.42, 0.04, 0.2, sx, y, z, 0xd9d5cc);
  b.box(0.44, 0.12, 0.24, sx, towerTop, z, WHITE);
  b.box(1.4, 0.6, 1.9, sx, SEA - 0.4, z, CONCRETE);
  b.blob(0.05, sx, towerTop + 0.18, z, RED_LIGHT, true);
  // Main cables: from the west end over the tower saddle and down to the east end,
  // one along the inside edge of each deck, with suspenders every few steps.
  const west = sx - 3.4;
  const eastEnd = sx + 2.4;
  for (const s of [-1, 1]) {
    const cz = z + s * 0.1;
    const pts = cablePoints([[west, BB_UP + 0.05], [sx, towerTop + 0.05], [eastEnd, BB_UP + 0.05]], [0.9, 0.7], 22);
    const curve = new THREE.CatmullRomCurve3(pts.map(([x, y]) => new THREE.Vector3(x, y, cz)));
    b.transformed(new THREE.TubeGeometry(curve, 60, 0.035, 5), new THREE.Matrix4(), WHITE, 'smooth');
    for (const [x, y] of pts) if (y - BB_UP > 0.25 && Math.abs(x - sx) > 0.25) b.box(0.01, y - BB_UP, 0.01, x, BB_UP, cz, 0xd0ccc4);
  }

  const { group } = b.build();
  group.traverse((o) => (o.castShadow = true));
  group.userData.tip = { title: 'Bay Bridge', detail: 'Free infrastructure. The Bay Lights come on after dark.' };

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(lightPos, 3));
  const lights = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uNight: { value: 0 }, uScale: { value: 3 } },
    vertexShader: /* glsl */ `
      uniform float uTime; uniform float uScale;
      varying float vI;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float wave = sin(position.x * 1.7 - uTime * 2.3) * 0.5 + 0.5;
        float ripple = sin(position.y * 6.0 + position.x * 0.6 + uTime * 3.1) * 0.5 + 0.5;
        vI = 0.25 + 0.75 * wave * ripple;
        gl_PointSize = uScale;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uNight;
      varying float vI;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d) * vI * uNight;
        gl_FragColor = vec4(vec3(1.0, 0.97, 0.9) * 2.4, a);
      }`,
  });
  group.add(new THREE.Points(geo, lights));
  return { group, lights };
}

// ─── Waterfront and city landmarks ──────────────────────────────────────────

const WARM: ColorLike = [1.6, 1.15, 0.6];
const FACING: Record<Facing, number> = { 'z+': 0, 'x+': Math.PI / 2, 'z-': Math.PI, 'x-': -Math.PI / 2 };

/** A round-headed arch, w wide and h tall to its crown, standing on y, flat on a face. */
function arch(b: GeoBuilder, w: number, h: number, x: number, y: number, z: number, facing: Facing, color: ColorLike, glow: boolean | 'solid' = false, rand = 0) {
  const r = w / 2;
  const s = new THREE.Shape();
  s.moveTo(-r, 0);
  s.lineTo(r, 0);
  s.lineTo(r, h - r);
  s.absarc(0, h - r, r, 0, Math.PI, false);
  s.closePath();
  const g = new THREE.ShapeGeometry(s, 6);
  g.rotateY(FACING[facing]);
  g.translate(x, y, z);
  b.raw(prepared(g, color, rand), glow);
}

const tmpCol = new THREE.Color();
/** A geometry made ready for a GeoBuilder bucket by hand, so a glowing part keeps its own moment of dusk (`rand`). */
function prepared(src: THREE.BufferGeometry, color: ColorLike, rand: number): THREE.BufferGeometry {
  const g = src.index ? src.toNonIndexed() : src;
  for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
  g.computeVertexNormals();
  const n = g.attributes.position!.count;
  if (typeof color === 'number') tmpCol.setHex(color);
  else tmpCol.setRGB(color[0], color[1], color[2]);
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i += 3) c.set([tmpCol.r, tmpCol.g, tmpCol.b], i);
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g.setAttribute('winRand', new THREE.BufferAttribute(new Float32Array(n).fill(rand), 1));
  return g;
}

/** Where a point `out` in front of face `f` of a box (centre x, z; size w × d) lies, `u` along it. */
function onFace(f: Facing, x: number, z: number, w: number, d: number, u: number, out: number): [number, number] {
  return f === 'x+' ? [x + w / 2 + out, z - u] : f === 'x-' ? [x - w / 2 - out, z + u] : f === 'z+' ? [x + u, z + d / 2 + out] : [x - u, z - d / 2 - out];
}

/**
 * The Ferry Building: a long two-storey arcade along the shore, arches on
 * the city side and ferry gates on the bay side, a skylit nave under a zinc
 * roof, and the clock tower rising in stages over Market Street.
 */
export function ferryBuilding(): THREE.Group {
  const b = new GeoBuilder();
  const r = rng(11);
  const { x, z } = LANDMARKS.ferryBuilding;
  const stone = 0xece4d2;
  const trim = 0xf6f0e2;
  const W = 1.3;
  const L = 5.0;
  b.box(2.1, 0.12, 5.8, x + 0.1, -0.12, z, CONCRETE);
  // Ground floor arcade and upper storey, belt course and cornice
  b.box(W, 0.36, L, x, 0, z, stone);
  b.box(W + 0.04, 0.04, L + 0.04, x, 0.34, z, trim);
  b.box(W - 0.02, 0.26, L - 0.02, x, 0.38, z, stone);
  b.box(W + 0.08, 0.05, L + 0.08, x, 0.64, z, trim);
  for (const f of ['x-', 'x+'] as const) {
    for (let k = 0; k < 17; k++) {
      const u = -L / 2 + 0.2 + k * ((L - 0.4) / 16);
      const [ax, az] = onFace(f, x, z, W, L, u, 0.006);
      // Arcade on the city side; tall gate doors on the bay side
      arch(b, 0.18, 0.28, ax, 0.02, az, f, f === 'x-' ? WARM : [1.4, 1.1, 0.7], true, 0.12 + r() * 0.5);
      const [px, pz] = onFace(f, x, z, W, L, u + (L - 0.4) / 32, 0.012);
      if (k < 16) b.box(f === 'x-' ? 0.03 : 0.06, 0.34, f === 'x-' ? 0.06 : 0.03, px, 0, pz, trim);
      const [wx, wz] = onFace(f, x, z, W - 0.02, L - 0.02, u, 0.006);
      arch(b, 0.07, 0.15, wx, 0.43, wz, f, WARM, true, r() < 0.7 ? 0.15 + r() * 0.8 : 2);
    }
  }
  for (const f of ['z+', 'z-'] as const) {
    for (let k = -1; k <= 1; k++) {
      const [ax, az] = onFace(f, x, z, W, L, k * 0.38, 0.006);
      arch(b, 0.2, 0.3, ax, 0.02, az, f, WARM, true, 0.2 + r() * 0.4);
      const [wx, wz] = onFace(f, x, z, W - 0.02, L - 0.02, k * 0.38, 0.006);
      arch(b, 0.08, 0.16, wx, 0.43, wz, f, WARM, true, 0.2 + r() * 0.6);
    }
  }
  // Zinc roof with the long skylight down the nave, and taller end pavilions with hipped roofs
  b.gable(L - 0.9, 0.24, W, x, 0.69, z, 0x8f9a98, 0.03, Math.PI / 2);
  b.box(0.22, 0.12, L - 1.2, x, 0.78, z, 0x6d8aa0, 'glass');
  b.box(0.26, 0.02, L - 1.16, x, 0.9, z, 0x8f9a98);
  for (const s of [-1, 1]) {
    const pz = z + s * (L / 2 - 0.3);
    b.box(W + 0.06, 0.78, 0.6, x, 0, pz, stone);
    b.box(W + 0.12, 0.05, 0.66, x, 0.76, pz, trim);
    b.hip(W + 0.06, 0.24, 0.6, x, 0.81, pz, 0x8f9a98, 0.03, 0.2);
  }
  // Bay side: a canopy over the gates, the slips and gangways
  b.box(0.22, 0.03, L - 1.4, x + W / 2 + 0.11, 0.33, z, 0x5f6c78);
  for (let k = 0; k < 7; k++) b.box(0.02, 0.32, 0.02, x + W / 2 + 0.2, 0.01, z - L / 2 + 0.85 + k * 0.55, 0x5f6c78);
  for (const dz of [-2.2, -0.7, 0.7, 2.2]) {
    b.box(1.3, 0.06, 0.32, x + 1.55, -0.18, z + dz, PALETTE.wood);
    b.box(0.5, 0.04, 0.14, x + 0.98, -0.06, z + dz, 0x9aa3ad);
    for (const e of [-1, 1]) b.cylinder(0.035, 0.035, 0.3, x + 2.15, SEA - 0.1, z + dz + e * 0.22, 0x5a4636, 6);
  }
  // City side: the central pavilion the tower rises from
  const tx = x - 0.05;
  const tz = z;
  b.box(0.3, 0.72, 0.9, x - W / 2 - 0.08, 0, tz, stone);
  b.box(0.34, 0.05, 0.94, x - W / 2 - 0.08, 0.7, tz, trim);
  arch(b, 0.28, 0.46, x - W / 2 - 0.235, 0.02, tz, 'x-', WARM, true, 0.15);

  // The clock tower: shaft, clock stage, open belfry, lantern and a pyramid cap
  const shaft = (y0: number, y1: number, w: number) => {
    b.box(w, y1 - y0, w, tx, y0, tz, stone);
    for (const cx of [-1, 1]) for (const cz of [-1, 1]) b.box(0.06, y1 - y0, 0.06, tx + cx * (w / 2 - 0.02), y0, tz + cz * (w / 2 - 0.02), trim);
    b.box(w + 0.06, 0.05, w + 0.06, tx, y1 - 0.05, tz, trim);
  };
  shaft(0.6, 2.35, 0.56);
  for (const f of ['x+', 'x-', 'z+', 'z-'] as const) {
    for (const u of [-0.11, 0.11]) {
      for (const [y, h] of [[0.95, 0.42], [1.55, 0.48]] as const) {
        const [ax, az] = onFace(f, tx, tz, 0.56, 0.56, u, 0.006);
        arch(b, 0.09, h, ax, y, az, f, WARM, true, 0.25 + r() * 0.6);
      }
    }
  }
  shaft(2.35, 2.95, 0.62);
  for (const f of ['x+', 'x-', 'z+', 'z-'] as const) {
    const [cx, cz] = onFace(f, tx, tz, 0.62, 0.62, 0, 0.008);
    const disc = new THREE.CircleGeometry(0.2, 24).rotateY(FACING[f]).translate(cx, 2.65, cz);
    // Backlit clock faces: a warm glow that reads as a clock, not a floodlight.
    b.transformed(disc, IDENTITY, [1.35, 1.25, 1.0], true);
    const [hx, hz] = onFace(f, tx, tz, 0.62, 0.62, 0, 0.014);
    b.transformed(new THREE.BoxGeometry(0.018, 0.15, 0.006).translate(0, 0.06, 0).rotateZ(-0.6).rotateY(FACING[f]).translate(hx, 2.65, hz), IDENTITY, 0x2a2a2e);
    b.transformed(new THREE.BoxGeometry(0.02, 0.1, 0.006).translate(0, 0.04, 0).rotateZ(1.9).rotateY(FACING[f]).translate(hx, 2.65, hz), IDENTITY, 0x2a2a2e);
  }
  shaft(2.95, 3.42, 0.5);
  for (const f of ['x+', 'x-', 'z+', 'z-'] as const) {
    for (const u of [-0.12, 0, 0.12]) {
      const [ax, az] = onFace(f, tx, tz, 0.5, 0.5, u, 0.006);
      arch(b, 0.09, 0.3, ax, 3.02, az, f, 0x3a3631);
    }
  }
  b.box(0.58, 0.05, 0.58, tx, 3.42, tz, trim);
  shaft(3.47, 3.78, 0.36);
  for (const f of ['x+', 'x-', 'z+', 'z-'] as const) {
    const [ax, az] = onFace(f, tx, tz, 0.36, 0.36, 0, 0.006);
    arch(b, 0.12, 0.22, ax, 3.52, az, f, 0x3a3631);
  }
  b.cylinder(0.02, 0.25, 0.42, tx, 3.78, tz, 0x7a9a8a, 4, false, Math.PI / 4);
  b.cylinder(0.008, 0.008, 0.36, tx, 4.18, tz, 0xd4af37, 4);
  flag(b, tx, 4.52, tz, 0.16);
  const { group } = b.build();
  group.traverse((o) => (o.castShadow = true));
  group.userData.tip = { title: 'Ferry Building', detail: 'Market Street starts here.' };
  return group;
}

/** The Stars and Stripes, flying east from a staff at (x, y, z). */
function flag(b: GeoBuilder, x: number, y: number, z: number, w: number) {
  const h = w * 0.56;
  b.box(w, h, 0.006, x + w / 2, y - h, z, 0xf4f2ec);
  for (let k = 0; k < 4; k++) b.box(w, h / 7, 0.008, x + w / 2, y - h + k * ((2 * h) / 7), z, 0xc8302a);
  b.box(w * 0.42, h * 0.54, 0.01, x + w * 0.21, y - h * 0.54, z, 0x2a3a7a);
}

/**
 * San Francisco City Hall on the Civic Center block: a Beaux-Arts palace with
 * a colonnaded drum and a gold-trimmed dome, facing east across its plaza
 * toward Market Street. Centred on the block at (cx, cz).
 */
export function cityHall(cx: number, cz: number): THREE.Group {
  const b = new GeoBuilder();
  const r = rng(29);
  const stone = 0xece6d6;
  const shade = 0xd9d0bc;
  const gold = 0xd4af37;
  const dome = 0x8aa39a;
  const warm: ColorLike = [1.7, 1.2, 0.65];
  const x = cx - 0.75;
  const z = cz;
  const W = 1.5; // east–west depth
  const L = 3.3; // north–south length
  // Plinth, rusticated ground floor, piano nobile with colonnade, attic
  b.box(W + 0.24, 0.08, L + 0.24, x, 0, z, shade);
  b.box(W, 0.32, L, x, 0.08, z, shade);
  b.box(W - 0.04, 0.42, L - 0.04, x, 0.4, z, stone);
  b.box(W + 0.03, 0.05, L + 0.03, x, 0.82, z, shade);
  b.box(W - 0.08, 0.16, L - 0.08, x, 0.87, z, stone);
  b.box(W, 0.04, L, x, 1.03, z, shade);
  b.windows({ w: W, d: L, x, z, y0: 0.08, rows: 1, rowHeight: 0.32, cols: 16, faces: ['x+', 'x-'] }, r, 0.7, warm, { w: 0.08, h: 0.12 });
  b.windows({ w: W, d: L, x, z, y0: 0.08, rows: 1, rowHeight: 0.32, cols: 6, faces: ['z+', 'z-'] }, r, 0.7, warm, { w: 0.08, h: 0.12 });
  b.windows({ w: W - 0.04, d: L - 0.04, x, z, y0: 0.42, rows: 1, rowHeight: 0.38, cols: 18, faces: ['x+', 'x-'] }, r, 0.75, warm, { w: 0.07, h: 0.2 });
  // Giant-order columns along the long façades
  for (const side of [1, -1]) {
    for (let k = 0; k < 18; k++) {
      const zz = z - L / 2 + 0.12 + (k * (L - 0.24)) / 17;
      b.cylinder(0.026, 0.03, 0.4, x + side * (W / 2 + 0.01), 0.42, zz, 0xf6f1e4, 6);
    }
  }
  // Central pavilion with a pedimented portico facing the plaza (east, +x)
  b.box(0.5, 0.95, 1.1, x + W / 2 + 0.1, 0.08, z, stone);
  for (let k = 0; k < 6; k++) b.cylinder(0.035, 0.04, 0.62, x + W / 2 + 0.33, 0.32, z - 0.42 + k * 0.168, 0xf6f1e4, 8);
  b.box(0.18, 0.08, 1.14, x + W / 2 + 0.3, 0.94, z, shade);
  b.gable(1.1, 0.2, 0.22, x + W / 2 + 0.3, 1.02, z, stone, 0.03, Math.PI / 2);
  for (let k = 0; k < 5; k++) b.box(0.42 - k * 0.04, 0.03, 0.9, x + W / 2 + 0.55 - k * 0.04, 0.08 - k * 0.0, z, shade); // grand stair
  b.panel(0.36, 0.42, x + W / 2 + 0.355, 0.55, z, Math.PI / 2, warm, true, 0.2);
  // End pavilions
  for (const s of [1, -1]) {
    b.box(W + 0.1, 1.0, 0.5, x, 0.08, z + s * (L / 2 - 0.25), stone);
    b.box(W + 0.14, 0.05, 0.54, x, 1.08, z + s * (L / 2 - 0.25), shade);
  }
  // Rotunda: square base, colonnaded drum, ribbed dome, lantern
  b.box(1.0, 0.25, 1.0, x, 1.07, z, stone);
  b.cylinder(0.5, 0.52, 0.08, x, 1.32, z, shade, 24);
  b.cylinder(0.44, 0.44, 0.5, x, 1.4, z, stone, 24);
  for (let k = 0; k < 20; k++) {
    const a = (k / 20) * Math.PI * 2;
    b.cylinder(0.022, 0.025, 0.46, x + Math.cos(a) * 0.47, 1.42, z + Math.sin(a) * 0.47, 0xf6f1e4, 6);
  }
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2 + 0.13;
    b.panel(0.08, 0.2, x + Math.cos(a) * 0.445, 1.65, z + Math.sin(a) * 0.445, Math.PI / 2 - a, warm, true, 0.15 + (k % 4) * 0.2);
  }
  b.cylinder(0.5, 0.5, 0.06, x, 1.9, z, gold, 24);
  b.lathe([[0.47, 0], [0.46, 0.12], [0.42, 0.3], [0.33, 0.48], [0.2, 0.6], [0.08, 0.66], [0, 0.67]], x, 1.96, z, dome, 28);
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const rib = new THREE.TorusGeometry(0.46, 0.008, 3, 12, Math.PI / 2.1).rotateZ(0).rotateY(-a);
    b.transformed(rib, new THREE.Matrix4().makeTranslation(x, 1.96, z), gold);
  }
  b.cylinder(0.07, 0.08, 0.2, x, 2.62, z, stone, 10);
  b.lathe([[0.08, 0], [0.05, 0.08], [0.0, 0.12]], x, 2.82, z, gold, 10);
  b.cylinder(0.008, 0.012, 0.18, x, 2.92, z, gold, 4);
  b.blob(0.03, x, 3.1, z, [3, 2.6, 1.6], true);
  // Civic Center Plaza: lawns, rows of clipped plane trees, a fountain, flagpoles
  const px = cx + 1.05;
  b.box(1.7, 0.02, L + 0.4, px, 0, z, 0xe6dfcf);
  for (const s of [-1, 1]) b.box(0.6, 0.03, 1.2, px + 0.05, 0.005, z + s * 0.9, 0x86c55a);
  for (const s of [-1, 1]) {
    for (let k = 0; k < 7; k++) {
      const tz = z - 1.55 + k * 0.52;
      const tx = px + s * 0.68;
      b.cylinder(0.018, 0.022, 0.18, tx, 0.02, tz, 0x7a5a42, 5);
      b.rbox(0.26, 0.2, 0.26, tx, 0.18, tz, 0x4f8f3e, 0.06, 'smooth');
    }
  }
  b.cylinder(0.24, 0.26, 0.05, px + 0.05, 0.02, z, shade, 16);
  b.cylinder(0.2, 0.2, 0.01, px + 0.05, 0.07, z, 0x6fcfe0, 16, 'glass');
  for (const s of [-1, 1]) {
    b.cylinder(0.008, 0.01, 0.7, px + 0.6, 0.02, z + s * 0.25, 0xd8d8d8, 4);
    b.box(0.003, 0.09, 0.15, px + 0.6, 0.6, z + s * 0.25 + 0.075, s > 0 ? 0xc8402e : 0x2f5aa8);
  }
  const { group } = b.build();
  group.traverse((o) => {
    o.castShadow = true;
    o.receiveShadow = true;
  });
  group.userData.tip = { title: 'City Hall', detail: 'Beaux-Arts, gold-leafed dome, a little taller than the one in Washington.' };
  return group;
}

/**
 * Coit Tower on Telegraph Hill: a fluted concrete column on a lobby with an
 * arched entrance on every side, a ring of tall arches round the viewing
 * gallery, Pioneer Park's circle round its foot and Columbus out front.
 */
export function coitTower(): THREE.Group {
  const b = new GeoBuilder();
  const r = rng(17);
  const { x, z } = LANDMARKS.coitTower;
  const y = terrainHeight(x, z);
  const conc = 0xf0ebdf;
  const trim = 0xe2dccd;
  // Pioneer Park: the turning circle and its low wall
  b.cylinder(0.92, 0.98, 0.14, x, y - 0.1, z, 0xc9c4b8, 24);
  b.cylinder(0.94, 0.94, 0.06, x, y + 0.02, z, 0xd9d3c5, 24);
  b.cylinder(0.86, 0.86, 0.065, x, y + 0.02, z, 0xb4aea2, 24);
  // The lobby: a square plinth with arched doorways, a cornice
  b.box(0.7, 0.32, 0.7, x, y + 0.04, z, conc);
  b.box(0.76, 0.05, 0.76, x, y + 0.34, z, trim);
  for (const f of ['x+', 'x-', 'z+', 'z-'] as const) {
    for (const u of [-0.18, 0, 0.18]) {
      const [ax, az] = onFace(f, x, z, 0.7, 0.7, u, 0.006);
      arch(b, u === 0 ? 0.12 : 0.08, u === 0 ? 0.22 : 0.16, ax, y + 0.06, az, f, WARM, true, 0.2 + r() * 0.5);
    }
  }
  // The fluted shaft
  const y0 = y + 0.39;
  const H = 2.05;
  b.cylinder(0.25, 0.27, H, x, y0, z, conc, 16);
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    b.box(0.04, H - 0.05, 0.04, x + Math.cos(a) * 0.262, y0, z + Math.sin(a) * 0.262, trim, false, -a);
  }
  // The viewing gallery: a ring of tall arches, lit warm at night, under a flared crown
  const g0 = y0 + H;
  b.cylinder(0.29, 0.29, 0.05, x, g0 - 0.02, z, trim, 16);
  b.cylinder(0.27, 0.27, 0.34, x, g0 + 0.03, z, conc, 16);
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2 + 0.13;
    const ax = x + Math.cos(a) * 0.272;
    const az = z + Math.sin(a) * 0.272;
    const s = new THREE.Shape();
    s.moveTo(-0.035, 0);
    s.lineTo(0.035, 0);
    s.lineTo(0.035, 0.2);
    s.absarc(0, 0.2, 0.035, 0, Math.PI, false);
    s.closePath();
    const geo = new THREE.ShapeGeometry(s, 4).rotateY(Math.PI / 2 - a).translate(ax, g0 + 0.07, az);
    b.raw(prepared(geo, [1.7, 1.3, 0.7], 0.15 + (k % 4) * 0.18), true);
  }
  b.cylinder(0.31, 0.28, 0.07, x, g0 + 0.37, z, trim, 16);
  b.cylinder(0.24, 0.3, 0.06, x, g0 + 0.44, z, conc, 16);
  b.cylinder(0.22, 0.22, 0.03, x, g0 + 0.5, z, trim, 16);
  b.blob(0.045, x, g0 + 0.58, z, RED_LIGHT, true);
  // Columbus on his pedestal, looking out over the bay
  const cx = x + 0.62;
  const cz = z + 0.22;
  b.box(0.1, 0.14, 0.1, cx, y + 0.02, cz, 0xd9d3c5);
  b.cylinder(0.025, 0.03, 0.14, cx, y + 0.16, cz, 0x6f7f6a, 6);
  b.blob(0.025, cx, y + 0.33, cz, 0x6f7f6a);
  const { group } = b.build();
  group.traverse((o) => (o.castShadow = true));
  group.userData.tip = { title: 'Coit Tower', detail: 'On Telegraph Hill.' };
  return group;
}

/**
 * The Palace of Fine Arts: an open rotunda of paired columns under a
 * terracotta dome, the long colonnade curving behind it with its planter
 * boxes, and the lagoon in front with a pair of swans.
 */
export function palaceOfFineArts(): THREE.Group {
  const b = new GeoBuilder();
  const { x, z } = LANDMARKS.palaceOfFineArts;
  const salmon = 0xdba586;
  const stone = 0xe9c4a6;
  const deep = 0xc08a6c;
  // The lagoon, its stone edge and the lawn round it
  const lagoon = new THREE.CircleGeometry(1.5, 28).rotateX(-Math.PI / 2).scale(1.35, 1, 0.8);
  b.transformed(lagoon.clone().scale(1.06, 1, 1.08), new THREE.Matrix4().makeTranslation(x + 0.7, 0.012, z + 1.0), 0xd8cdb8);
  b.transformed(lagoon, new THREE.Matrix4().makeTranslation(x + 0.7, 0.03, z + 1.0), 0x3a9fb4, 'glass');
  for (const [sx, sz] of [[x + 1.2, z + 1.4], [x + 1.35, z + 1.3]] as const) {
    b.blob(0.04, sx, 0.05, sz, 0xfbfaf6, 'smooth');
    b.cylinder(0.006, 0.008, 0.06, sx + 0.03, 0.05, sz, 0xfbfaf6, 4);
  }
  // Rotunda: eight piers of paired columns on a stepped plinth, an entablature, a drum and the dome
  b.cylinder(0.78, 0.82, 0.06, x, 0, z, 0xd9c8b0, 8, false, Math.PI / 8);
  b.cylinder(0.72, 0.74, 0.04, x, 0.06, z, stone, 8, false, Math.PI / 8);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    for (const d of [-0.07, 0.07]) {
      const px = x + Math.cos(a) * 0.6 - Math.sin(a) * d;
      const pz = z + Math.sin(a) * 0.6 + Math.cos(a) * d;
      b.cylinder(0.04, 0.048, 0.78, px, 0.1, pz, salmon, 8);
      b.box(0.1, 0.05, 0.1, px, 0.86, pz, stone);
    }
  }
  b.cylinder(0.7, 0.7, 0.14, x, 0.9, z, stone, 8, false, Math.PI / 8);
  b.cylinder(0.73, 0.73, 0.04, x, 1.03, z, deep, 8, false, Math.PI / 8);
  b.cylinder(0.56, 0.58, 0.18, x, 1.07, z, salmon, 16);
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    b.box(0.05, 0.12, 0.02, x + Math.cos(a) * 0.575, 1.1, z + Math.sin(a) * 0.575, deep, false, -a + Math.PI / 2);
  }
  b.lathe([[0.56, 0], [0.54, 0.14], [0.46, 0.32], [0.32, 0.46], [0.14, 0.54], [0, 0.56]], x, 1.25, z, 0xc8805e, 24);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const rib = new THREE.TorusGeometry(0.55, 0.012, 3, 10, Math.PI / 2.05).rotateY(-a);
    b.transformed(rib, new THREE.Matrix4().makeTranslation(x, 1.25, z), deep);
  }
  b.cylinder(0.06, 0.08, 0.12, x, 1.78, z, stone, 8);
  b.lathe([[0.07, 0], [0.04, 0.06], [0, 0.08]], x, 1.9, z, deep, 8);
  // The colonnade: paired columns on a curve behind, an entablature, planter boxes on top
  const R = 2.2;
  const ox = x + 0.4;
  const oz = z + 0.5;
  const a0 = Math.PI * 0.88;
  const a1 = Math.PI * 1.72;
  const n = 18;
  for (let k = 0; k <= n; k++) {
    const a = a0 + (k / n) * (a1 - a0);
    for (const dr of [-0.09, 0.09]) {
      b.cylinder(0.032, 0.038, 0.56, ox + Math.cos(a) * (R + dr), 0.02, oz + Math.sin(a) * (R + dr), salmon, 6);
    }
    if (k % 3 === 0) b.box(0.18, 0.16, 0.16, ox + Math.cos(a) * R, 0.7, oz + Math.sin(a) * R, deep, false, -a);
  }
  for (const [rr, h, y, c] of [[R, 0.1, 0.58, stone], [R, 0.03, 0.68, deep]] as const) {
    const ring = new THREE.Shape();
    ring.absarc(0, 0, rr + 0.14, a0 - 0.02, a1 + 0.02, false);
    ring.absarc(0, 0, rr - 0.14, a1 + 0.02, a0 - 0.02, true);
    const g = new THREE.ExtrudeGeometry(ring, { depth: h, bevelEnabled: false, curveSegments: 24 }).rotateX(Math.PI / 2).translate(0, y + h, 0);
    b.transformed(g, new THREE.Matrix4().makeTranslation(ox, 0, oz), c);
  }
  const { group } = b.build();
  group.traverse((o) => (o.castShadow = true));
  group.userData.tip = { title: 'Palace of Fine Arts', detail: 'Rotunda, colonnade and lagoon.' };
  return group;
}

/**
 * Sutro Tower: three legs in red and white that pinch at a waist and spread
 * again to three antenna masts, braced by triangular platforms.
 */
export function sutroTower(): THREE.Group {
  const b = new GeoBuilder();
  const { x, z } = LANDMARKS.sutroTower;
  const y = terrainHeight(x, z) - 0.1;
  const RED = 0xd23a2c;
  const WHITE_PAINT = 0xf4f2ee;
  const ring = (r: number, h: number) => [0, 1, 2].map((k) => new THREE.Vector3(x + Math.cos((k / 3) * Math.PI * 2 + 0.3) * r, y + h, z + Math.sin((k / 3) * Math.PI * 2 + 0.3) * r));
  const feet = ring(0.85, 0);
  const waist = ring(0.3, 2.9);
  const tops = ring(0.5, 5.0);
  for (let k = 0; k < 3; k++) {
    // Red and white bands up each leg
    for (let s = 0; s < 6; s++) strut(b, feet[k]!.clone().lerp(waist[k]!, s / 6), feet[k]!.clone().lerp(waist[k]!, (s + 1) / 6), 0.1, s % 2 ? WHITE_PAINT : RED);
    for (let s = 0; s < 4; s++) strut(b, waist[k]!.clone().lerp(tops[k]!, s / 4), waist[k]!.clone().lerp(tops[k]!, (s + 1) / 4), 0.07, s % 2 ? RED : WHITE_PAINT);
    // The antenna mast on top of each leg
    const t = tops[k]!;
    strut(b, t, t.clone().add(new THREE.Vector3(0, 0.75, 0)), 0.035, RED);
    strut(b, t.clone().add(new THREE.Vector3(0, 0.75, 0)), t.clone().add(new THREE.Vector3(0, 1.05, 0)), 0.02, WHITE_PAINT);
    b.blob(0.06, t.x, t.y + 1.1, t.z, RED_LIGHT, true);
    b.box(0.22, 0.1, 0.22, feet[k]!.x, y - 0.02, feet[k]!.z, 0xbdb6a8);
  }
  // Triangular platforms and cross-bracing between the legs
  const at = (t: number) => (k: number) => (t <= 1 ? feet[k]!.clone().lerp(waist[k]!, t) : waist[k]!.clone().lerp(tops[k]!, t - 1));
  for (const t of [0.3, 0.62, 1, 1.45, 1.98]) {
    const p = at(t);
    for (let k = 0; k < 3; k++) strut(b, p(k), p((k + 1) % 3), t === 1 || t === 1.98 ? 0.07 : 0.045, t === 1 || t === 1.98 ? 0xb9b2a6 : 0xd8d2c6);
  }
  for (const [t0, t1] of [[0.3, 0.62], [0.62, 1]] as const) {
    for (let k = 0; k < 3; k++) strut(b, at(t0)(k), at(t1)((k + 1) % 3), 0.03, 0xd8d2c6);
  }
  // The equipment deck at the waist
  b.cylinder(0.42, 0.42, 0.08, x, y + 2.86, z, 0xd8d2c6, 3, false, 0.3 + Math.PI / 6);
  const { group } = b.build();
  group.traverse((o) => (o.castShadow = true));
  group.userData.tip = { title: 'Sutro Tower', detail: 'Keeps an eye on the city.' };
  return group;
}

export interface Windmill {
  group: THREE.Group;
  sails: THREE.Group;
}

/**
 * The Dutch Windmill at the ocean end of Golden Gate Park: a shingled
 * octagonal tower with a reefing stage round its middle, a boat-shaped cap
 * and four lattice sails, in the Queen Wilhelmina tulip garden.
 */
export function windmill(): Windmill {
  const b = new GeoBuilder();
  const { x, z } = LANDMARKS.windmill;
  const y = terrainHeight(x, z);
  const shingle = 0x9a8268;
  const dark = 0x6b5640;
  const white = 0xf2ede2;
  // Tulip garden: beds of colour round a lawn
  b.cylinder(1.25, 1.3, 0.04, x, y - 0.02, z, 0x6faa4a, 12);
  const tulips = [0xe0453a, 0xf2c84b, 0xe85a8a, 0xf08a3a, 0xb04ab0];
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    const bx = x + Math.cos(a) * 0.95;
    const bz = z + Math.sin(a) * 0.95;
    b.box(0.32, 0.04, 0.14, bx, y + 0.01, bz, 0x6b4a32, false, -a + Math.PI / 2);
    b.box(0.28, 0.05, 0.1, bx, y + 0.03, bz, tulips[k % tulips.length]!, false, -a + Math.PI / 2);
  }
  // The tower: a white brick base, then shingles tapering up in courses
  b.cylinder(0.5, 0.52, 0.3, x, y, z, white, 8, false, Math.PI / 8);
  b.cylinder(0.33, 0.48, 1.25, x, y + 0.3, z, shingle, 8, false, Math.PI / 8);
  for (let k = 1; k < 6; k++) {
    const t = k / 6;
    b.cylinder(0.33 + (1 - t) * 0.15 + 0.012, 0.33 + (1 - t) * 0.15 + 0.012, 0.025, x, y + 0.3 + t * 1.25, z, dark, 8, false, Math.PI / 8);
  }
  // Door, windows
  arch(b, 0.14, 0.24, x + 0.36, y + 0.02, z + 0.36, 'x+', 0x5a3e2a);
  b.windows({ w: 0.62, d: 0.62, x, z, y0: y + 0.75, rows: 2, rowHeight: 0.32, cols: 1, faces: ['x+', 'z+', 'x-', 'z-'] }, () => 0.3, 1, WARM, { w: 0.07, h: 0.11 }, white);
  // The reefing stage: a deck on struts with a railing
  const sy = y + 0.62;
  b.cylinder(0.72, 0.72, 0.035, x, sy, z, 0x7a5a3e, 8, false, Math.PI / 8);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    const px = x + Math.cos(a) * 0.68;
    const pz = z + Math.sin(a) * 0.68;
    b.box(0.018, 0.12, 0.018, px, sy + 0.035, pz, white);
    strut(b, new THREE.Vector3(px * 0.75 + x * 0.25, sy, pz * 0.75 + z * 0.25), new THREE.Vector3(x + Math.cos(a) * 0.43, sy - 0.3, z + Math.sin(a) * 0.43), 0.025, dark);
  }
  b.cylinder(0.69, 0.69, 0.02, x, sy + 0.14, z, white, 8, false, Math.PI / 8);
  // The cap, turned into the wind (north-east, toward the city)
  b.cylinder(0.36, 0.36, 0.06, x, y + 1.55, z, white, 8, false, Math.PI / 8);
  b.lathe([[0.37, 0], [0.36, 0.1], [0.28, 0.26], [0.14, 0.36], [0, 0.39]], x, y + 1.61, z, dark, 8);
  const { group } = b.build();

  // The sails: a stock through the windshaft, four lattice sails half-clothed in canvas
  const sb = new GeoBuilder();
  sb.cylinder(0.07, 0.07, 0.16, 0, -0.08, 0, dark, 8);
  for (let k = 0; k < 4; k++) {
    const m = new THREE.Matrix4().makeRotationZ((k / 4) * Math.PI * 2);
    const part = (w: number, h: number, px: number, py: number, color: ColorLike, d = 0.02) => sb.transformed(new THREE.BoxGeometry(w, h, d).translate(px, py, 0), m, color);
    part(0.035, 1.25, 0, 0.62, 0x4a3a2c, 0.035);
    for (const s of [-1, 1]) part(0.016, 0.95, s * 0.1, 0.72, 0xe9e2d2);
    for (let j = 0; j < 9; j++) part(0.22, 0.014, 0, 0.27 + j * 0.11, 0xe9e2d2);
    part(0.09, 0.9, 0.055, 0.72, 0xf4efe2, 0.006);
  }
  const sails = sb.build().group;
  sails.position.set(x + 0.42, y + 1.72, z + 0.42);
  sails.rotation.y = Math.PI / 4;
  const pivot = new THREE.Group();
  pivot.add(sails);
  group.add(pivot);
  group.traverse((o) => (o.castShadow = true));
  group.userData.tip = { title: 'Dutch Windmill', detail: 'At the ocean end of Golden Gate Park.' };
  return { group, sails };
}

/**
 * The Conservatory of Flowers: a white Victorian glasshouse, a domed
 * octagonal pavilion with a cupola between two barrel-vaulted wings, end
 * pavilions, and bedding plants laid out on the lawn in front.
 */
export function conservatory(x: number, z: number): THREE.Group {
  const b = new GeoBuilder();
  const y = terrainHeight(x, z);
  const white = 0xf8f8f4;
  const pane = 0xc8dde4;
  b.box(3.1, 0.05, 1.0, x, y - 0.02, z, 0xd9d3c5);
  // Wings: low white walls, a glass barrel vault ribbed in white
  for (const s of [-1, 1]) {
    const cx = x + s * 0.86;
    b.box(0.9, 0.16, 0.5, cx, y + 0.03, z, white);
    b.windows({ w: 0.9, d: 0.5, x: cx, z, y0: y + 0.03, rows: 1, rowHeight: 0.15, cols: 6, faces: ['z+', 'z-'] }, () => 0.4, 1, [0.9, 1.3, 1.0], { w: 0.1, h: 0.09 });
    const vault = new THREE.CylinderGeometry(0.25, 0.25, 0.9, 12, 1, false, -Math.PI / 2, Math.PI).rotateZ(Math.PI / 2).translate(cx, y + 0.19, z);
    b.transformed(vault, IDENTITY, pane, 'glass');
    for (let k = 0; k <= 5; k++) {
      const rib = new THREE.TorusGeometry(0.255, 0.01, 3, 10, Math.PI).rotateY(Math.PI / 2);
      b.transformed(rib, new THREE.Matrix4().makeTranslation(cx - 0.45 + k * 0.18, y + 0.19, z), white);
    }
    // End pavilion with its little dome
    const ex = x + s * 1.42;
    b.box(0.3, 0.42, 0.6, ex, y + 0.03, z, white);
    b.box(0.26, 0.3, 0.62, ex, y + 0.08, z, pane, 'glass');
    b.box(0.34, 0.04, 0.64, ex, y + 0.45, z, white);
    b.lathe([[0.16, 0], [0.14, 0.08], [0.08, 0.15], [0, 0.17]], ex, y + 0.49, z, pane, 8, 'glass');
  }
  // The central pavilion: an octagon of glass under a ribbed dome and a cupola
  b.cylinder(0.44, 0.46, 0.08, x, y + 0.03, z, white, 8, false, Math.PI / 8);
  b.cylinder(0.42, 0.42, 0.4, x, y + 0.11, z, pane, 8, false, Math.PI / 8, );
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    b.box(0.025, 0.4, 0.025, x + Math.cos(a) * 0.4, y + 0.11, z + Math.sin(a) * 0.4, white);
  }
  b.cylinder(0.46, 0.46, 0.04, x, y + 0.51, z, white, 8, false, Math.PI / 8);
  b.lathe([[0.44, 0], [0.42, 0.14], [0.34, 0.3], [0.2, 0.42], [0, 0.46]], x, y + 0.55, z, pane, 16, 'glass');
  for (let k = 0; k < 8; k++) {
    const rib = new THREE.TorusGeometry(0.44, 0.011, 3, 8, Math.PI / 2.1).rotateY(-(k / 8) * Math.PI * 2);
    b.transformed(rib, new THREE.Matrix4().makeTranslation(x, y + 0.55, z), white);
  }
  b.cylinder(0.1, 0.1, 0.12, x, y + 0.98, z, white, 8);
  b.lathe([[0.11, 0], [0.07, 0.07], [0, 0.1]], x, y + 1.1, z, pane, 8, 'glass');
  b.cylinder(0.006, 0.006, 0.12, x, y + 1.2, z, white, 4);
  // Bedding plants on the lawn in front, and the path up to the doors
  b.box(0.18, 0.012, 1.1, x, y + 0.006, z + 1.05, 0xe6dfcf);
  const beds = [0xe85a8a, 0xf2c84b, 0xe8873a, 0xb97ad8, 0xe0453a];
  for (const s of [-1, 1]) {
    for (let k = 0; k < 3; k++) {
      const bx = x + s * (0.45 + k * 0.42);
      b.box(0.34, 0.03, 0.42, bx, y + 0.005, z + 0.95, 0x5c9c3e);
      b.cylinder(0.12, 0.12, 0.035, bx, y + 0.01, z + 0.95, beds[(k + (s > 0 ? 2 : 0)) % beds.length]!, 10);
      b.box(0.3, 0.035, 0.05, bx, y + 0.01, z + 1.12, beds[(k + 1) % beds.length]!);
    }
  }
  const { group } = b.build();
  group.traverse((o) => (o.castShadow = true));
  group.userData.tip = { title: 'Conservatory of Flowers', detail: 'Golden Gate Park.' };
  return group;
}

/**
 * The Cliff House at Lands End: a white neoclassical restaurant on the
 * cliff with big windows to the ocean, its red sign, the Camera Obscura on
 * the terrace below, Seal Rocks offshore and the ruins of the Sutro Baths.
 */
export function cliffHouse(): THREE.Group {
  const b = new GeoBuilder();
  const x = -46.8;
  const z = -1.6;
  const y = Math.max(0.2, terrainHeight(x, z));
  const white = 0xf2eee6;
  const trim = 0xdcd6ca;
  // Terrace on the cliff edge, the building on it
  b.box(1.9, y - SEA + 0.05, 1.4, x - 0.1, SEA, z, 0xb8b0a2);
  b.box(1.96, 0.04, 1.46, x - 0.1, y + 0.04, z, trim);
  b.box(1.3, 0.56, 0.85, x + 0.15, y + 0.08, z + 0.1, white);
  b.box(1.36, 0.05, 0.91, x + 0.15, y + 0.6, z + 0.1, trim);
  b.box(1.24, 0.08, 0.79, x + 0.15, y + 0.65, z + 0.1, white);
  for (const [f, cols] of [['x-', 5], ['z+', 6], ['x+', 4], ['z-', 6]] as const) {
    b.windows({ w: 1.3, d: 0.85, x: x + 0.15, z: z + 0.1, y0: y + 0.08, rows: 2, rowHeight: 0.25, cols, faces: [f] }, () => 0.3, 1, WARM, { w: 0.14, h: 0.17 }, white);
  }
  // The red sign on the roof
  b.box(0.08, 0.16, 0.7, x - 0.3, y + 0.73, z + 0.1, 0xc8302a);
  b.box(0.085, 0.02, 0.62, x - 0.3, y + 0.8, z + 0.1, 0xf4f0e6);
  // Lower wing toward the sea
  b.box(0.55, 0.32, 0.9, x - 0.62, y + 0.08, z + 0.05, white);
  b.box(0.6, 0.04, 0.95, x - 0.62, y + 0.4, z + 0.05, trim);
  b.windows({ w: 0.55, d: 0.9, x: x - 0.62, z: z + 0.05, y0: y + 0.08, rows: 1, rowHeight: 0.28, cols: 4, faces: ['x-', 'z+'] }, () => 0.25, 1, WARM, { w: 0.15, h: 0.18 });
  // Camera Obscura: a little house with a camera on its roof
  const cx = x - 0.3;
  const cz = z + 0.95;
  b.box(0.26, 0.2, 0.26, cx, y + 0.08, cz, 0xe6c870);
  b.box(0.2, 0.1, 0.16, cx, y + 0.28, cz, 0x3a3a40);
  b.cylinder(0.04, 0.05, 0.08, cx - 0.12, y + 0.29, cz, 0x2a2a2e, 8);
  // Seal Rocks
  for (const [rx, rz, rr] of [[-50.5, -0.8, 0.6], [-51.3, 0.6, 0.45], [-50.2, 1.4, 0.35]] as const) {
    const g = new THREE.IcosahedronGeometry(rr, 1).scale(1, 0.8, 1);
    b.transformed(g, new THREE.Matrix4().makeTranslation(rx, SEA + 0.1, rz), 0x8f857a);
    b.blob(rr * 0.3, rx + rr * 0.2, SEA + 0.1 + rr * 0.72, rz, 0xe8e4dc); // guano
  }
  // Sutro Baths: the concrete footings of the old pools, half full of seawater
  const bx = -47.4;
  const bz = 4.6;
  b.box(1.9, 0.06, 1.3, bx, SEA - 0.02, bz, 0x2f8ea0, 'glass');
  for (let k = 0; k < 5; k++) b.box(0.07, 0.12, 1.3, bx - 0.9 + k * 0.45, SEA, bz, 0xbab3a6);
  for (const s of [-1, 1]) b.box(1.9, 0.12, 0.07, bx, SEA, bz + s * 0.65, 0xbab3a6);
  b.box(0.5, 0.2, 0.08, bx + 0.6, SEA, bz - 0.65, 0xa8a094);
  const { group } = b.build();
  group.traverse((o) => (o.castShadow = true));
  group.userData.tip = { title: 'Cliff House', detail: 'Lands End, above Seal Rocks.' };
  return group;
}

// ─── The sign ───────────────────────────────────────────────────────────────

const LETTER_WIDTH: Record<string, number> = { T: 0.66, I: 0.25, N: 0.68, Y: 0.72, O: 0.7, W: 0.94 };

/** Chunky sans letters, `h` tall, from x = 0 to their width. */
function letterShape(ch: string, h: number): THREE.Shape {
  const w = LETTER_WIDTH[ch]! * h;
  const s = 0.18 * h;
  const P = (pts: [number, number][]) => new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  switch (ch) {
    case 'T':
      return P([[0, h], [0, h - s], [(w - s) / 2, h - s], [(w - s) / 2, 0], [(w + s) / 2, 0], [(w + s) / 2, h - s], [w, h - s], [w, h]]);
    case 'N':
      return P([[0, 0], [s, 0], [s, h * 0.62], [w - s, 0], [w, 0], [w, h], [w - s, h], [w - s, h * 0.38], [s, h], [0, h]]);
    case 'Y':
      return P([[0, h], [w / 2 - s / 2, h * 0.46], [w / 2 - s / 2, 0], [w / 2 + s / 2, 0], [w / 2 + s / 2, h * 0.46], [w, h], [w - s * 1.1, h], [w / 2, h * 0.64], [s * 1.1, h]].reverse() as [number, number][]);
    case 'W':
      return P([[0, h], [w * 0.19, 0], [w * 0.36, 0], [w * 0.5, h * 0.5], [w * 0.64, 0], [w * 0.81, 0], [w, h], [w - s * 0.95, h], [w * 0.72, h * 0.3], [w * 0.57, h * 0.82], [w * 0.43, h * 0.82], [w * 0.28, h * 0.3], [s * 0.95, h]].reverse() as [number, number][]);
    case 'O': {
      const shape = new THREE.Shape();
      shape.absellipse(w / 2, h / 2, w / 2, h / 2, 0, Math.PI * 2, false, 0);
      const hole = new THREE.Path();
      hole.absellipse(w / 2, h / 2, w / 2 - s, h / 2 - s, 0, Math.PI * 2, true, 0);
      shape.holes.push(hole);
      return shape;
    }
    default:
      return P([[0, 0], [w, 0], [w, h], [0, h]]);
  }
}

/** Points round a closed outline every `step`, pulled `inset` in toward the solid. */
function bulbRing(pts: THREE.Vector2[], step: number, inset: number, hole: boolean): { x: number; y: number; d: number }[] {
  const n = pts.length;
  let area = 0;
  for (let i = 0; i < n; i++) area += pts[i]!.x * pts[(i + 1) % n]!.y - pts[(i + 1) % n]!.x * pts[i]!.y;
  // Solid lies to the left of a counter-clockwise outline, and outside a hole.
  const side = (area > 0) !== hole ? 1 : -1;
  const out: { x: number; y: number; d: number }[] = [];
  let d = 0;
  let next = step / 2;
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const len = a.distanceTo(b);
    if (len < 1e-6) continue;
    const ex = (b.x - a.x) / len;
    const ey = (b.y - a.y) / len;
    while (next <= d + len) {
      const t = next - d;
      const x = a.x + ex * t - ey * inset * side;
      const y = a.y + ey * t + ex * inset * side;
      // Keep bulbs off sharp inside corners, where an inset point lands on its neighbour.
      if (!out.some((p) => Math.hypot(p.x - x, p.y - y) < step * 0.6)) out.push({ x, y, d: next });
      next += step;
    }
    d += len;
  }
  return out;
}

/** The marquee bulbs: off-white glass by day; at dusk they come on letter by letter, brighten, and a slow chase runs round each letter. */
function bulbMaterial(): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(2.4, 2.4, 2.4) });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = GLOW.night;
    shader.uniforms.uTime = GLOW.time;
    shader.vertexShader = shader.vertexShader.replace('void main() {', 'attribute vec3 bulb;\nvarying vec3 vBulb;\nvoid main() {\n\tvBulb = bulb;');
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform float uNight;\nuniform float uTime;\nvarying vec3 vBulb;\nvoid main() {')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float at = 0.16 + vBulb.y * 0.05 + vBulb.z * 0.06;
        float on = smoothstep(at, at + 0.05, uNight);
        float level = 0.4 + 0.6 * smoothstep(at, 0.95, uNight);
        float chase = 0.78 + 0.22 * sin(vBulb.x * 0.8 - uTime * 3.0);
        vec3 glass = vec3(0.9, 0.87, 0.8) * (0.8 + 0.2 * vBulb.z);
        diffuseColor.rgb = mix(glass, diffuseColor.rgb * level * chase, on);`,
      );
  };
  m.customProgramCacheKey = () => 'tinytown-bulbs-1';
  return m;
}

export interface Sign {
  group: THREE.Group;
  /** The letters' faces: their emissive glow is driven by the scenery. */
  material: THREE.MeshStandardMaterial;
  /** The bulbs: their colour level is the sign's power (0 when it goes dark). */
  floodlights: THREE.MeshBasicMaterial;
}

/**
 * TINYTOWN, Hollywood style, on Twin Peaks facing the city: chunky sheet
 * letters standing on steel scaffolding with raking braces back into the
 * slope, rows of marquee bulbs round every letter.
 */
export function sign(): Sign {
  const material = new THREE.MeshStandardMaterial({ color: 0xfbfaf6, roughness: 0.55, emissive: 0xd9cbb0, emissiveIntensity: 0 });
  const floodlights = bulbMaterial();
  const steel = new GeoBuilder();
  const letterGeos: THREE.BufferGeometry[] = [];
  const bulbGeos: THREE.BufferGeometry[] = [];
  const letters = 'TINYTOWN';
  const height = 2.6;
  const gap = 0.36;
  const depth = 0.16;
  const widths = [...letters].map((ch) => LETTER_WIDTH[ch]! * height);
  const total = widths.reduce((a, c) => a + c, 0) + gap * (letters.length - 1);
  const right = new THREE.Vector3(Math.SQRT1_2, 0, -Math.SQRT1_2);
  const back = new THREE.Vector3(-Math.SQRT1_2, 0, -Math.SQRT1_2);
  const { x: cx, z: cz } = LANDMARKS.sign;
  const centreY = terrainHeight(cx, cz);
  const r = rng(41);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  const bulb = new THREE.OctahedronGeometry(0.06, 0);
  let u = -total / 2;
  [...letters].forEach((ch, i) => {
    const w = widths[i]!;
    const p = new THREE.Vector3(cx, 0, cz).addScaledVector(right, u + w / 2);
    const ground = terrainHeight(p.x, p.z);
    // Letters step down the slope a little rather than floating level on long legs.
    const y = Math.max(ground - 0.2, ground * 0.65 + centreY * 0.35) + 0.25 + Math.sin(i * 1.7) * 0.06;
    e.set(-0.08, Math.PI / 4 + Math.sin(i * 2.3) * 0.03, 0, 'YXZ');
    q.setFromEuler(e);
    m.compose(new THREE.Vector3(p.x, y, p.z), q, ONE);
    const local = (x: number, yy: number, zz: number) => v.set(x, yy, zz).applyMatrix4(m).clone();

    // The letter: a chunky extruded panel, centred on its local origin.
    const shape = letterShape(ch, height);
    const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSize: 0.025, bevelThickness: 0.025, bevelSegments: 1, curveSegments: 20 });
    geo.translate(-w / 2, 0, 0);
    geo.applyMatrix4(m);
    letterGeos.push(geo);

    // Scaffolding: posts down to the slope, rails, X-bracing and raking struts behind.
    const posts = w > 1 ? [-0.36, 0, 0.36] : [0];
    const zb = -0.08;
    for (const f of posts) {
      const top = local(f * w, height * 0.92, zb);
      const foot = top.clone();
      foot.y = terrainHeight(foot.x, foot.z) - 0.1;
      strut(steel, foot, top, 0.05, 0x5c5852);
      // A raking brace from two-thirds up back down into the hill
      const knee = local(f * w, height * 0.62, zb);
      const toe = knee.clone().addScaledVector(back, 1.1);
      toe.y = terrainHeight(toe.x, toe.z) - 0.05;
      strut(steel, knee, toe, 0.04, 0x6a655e);
      steel.box(0.14, 0.06, 0.14, foot.x, foot.y + 0.06, foot.z, 0xbdb6a8);
      steel.box(0.12, 0.05, 0.12, toe.x, toe.y + 0.03, toe.z, 0xbdb6a8);
    }
    for (const fy of [0.2, 0.55, 0.88]) strut(steel, local(-w * 0.46, height * fy, zb), local(w * 0.46, height * fy, zb), 0.035, 0x6a655e);
    if (w > 1) {
      for (const [a, c] of [[-0.36, 0], [0, 0.36]] as const) {
        strut(steel, local(a * w, height * 0.2, zb), local(c * w, height * 0.55, zb), 0.025, 0x77726a);
        strut(steel, local(c * w, height * 0.2, zb), local(a * w, height * 0.55, zb), 0.025, 0x77726a);
      }
    }
    // A catwalk along the foot of the letter, for the man who changes the bulbs
    strut(steel, local(-w * 0.5, 0.02, 0.18), local(w * 0.5, 0.02, 0.18), 0.03, 0x77726a);

    // Bulbs round every outline, set just proud of the face
    const { shape: outer, holes } = shape.extractPoints(18);
    const rings = [bulbRing(outer, 0.24, 0.1, false), ...holes.map((h) => bulbRing(h, 0.24, 0.1, true))];
    for (const ring of rings) {
      for (const { x, y: by, d } of ring) {
        const g = bulb.clone();
        g.applyMatrix4(new THREE.Matrix4().makeTranslation(x - w / 2, by, depth + 0.05)).applyMatrix4(m);
        const n = g.attributes.position!.count;
        const attr = new Float32Array(n * 3);
        const col = new Float32Array(n * 3);
        const jitter = r();
        for (let k = 0; k < n; k++) {
          attr.set([d / 0.24, i, jitter], k * 3);
          col.set([1, 0.8, 0.5], k * 3);
        }
        g.setAttribute('bulb', new THREE.BufferAttribute(attr, 3));
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        g.deleteAttribute('uv');
        bulbGeos.push(g);
      }
    }
    u += w + gap;
  });

  const g = new THREE.Group();
  const faces = new THREE.Mesh(mergeGeometries(letterGeos), material);
  faces.castShadow = true;
  faces.receiveShadow = true;
  const bulbs = new THREE.Mesh(mergeGeometries(bulbGeos), floodlights);
  g.add(faces, bulbs, steel.build().group);
  g.userData.tip = { title: 'The TINYTOWN sign', detail: 'Its bulbs come on at dusk while upkeep is paid. It goes dark first when money runs short.' };
  return { group: g, material, floodlights };
}
