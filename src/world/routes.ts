/**
 * Routes on the water for this world: the Sausalito ferry, the harbour tug,
 * the container ship in through the Golden Gate, and the sailing loops. The
 * classic map keeps its hand-drawn routes; every other world finds its own
 * with a path search over the bay, clear of the shore, the piers and the
 * bridge towers, then pulls the path straight and rounds its corners.
 */
import { hash, rng } from './rng.ts';
import { ISLANDS, LANDMARKS, MARIN, MARINA, PIER, WORLD_SPEC, coastDistance, type Pt } from './map.ts';

export interface BayRoutes {
  sausalito: Pt[];
  oakland: Pt[];
  tug: Pt[];
  shipping: Pt[];
  /** Sailing loops: centre and radii. */
  sails: [number, number, number, number][];
}

const CLASSIC: BayRoutes = {
  sausalito: [[13.6, -1.2], [16, 5], [9, 14.5], [4.5, 22], [3.5, 32], [-10, 31.5], [-20, 29.5], [-24.2, 27.6]],
  oakland: [[13.6, -2.2], [20, -10.5], [33, -12.6], [45, -11], [54, -8]],
  tug: [[13.4, -4.2], [14.6, -1.2], [13.6, 3.5], [11.2, 8.4], [6, 11.6]],
  shipping: [[-110, 14], [-60, 14.5], [-34.6, 15.4], [-22, 18.5], [-13.5, 23], [-11, 30], [4, 30.5], [22, 29], [40, 18], [53.5, 12]],
  sails: [[10, 20, 6, 5], [-18, 18.5, 5, 2.5], [20, 8, 4, 3], [12, 24, 4.5, 3.5], [10, 20, 4.2, 3.2]],
};

let cache: { seed: number; routes: BayRoutes } | null = null;

/** The routes for the world being shown. */
export function bayRoutes(): BayRoutes {
  const seed = WORLD_SPEC.seed;
  if (cache?.seed === seed) return cache.routes;
  const routes = WORLD_SPEC.classic ? CLASSIC : findRoutes();
  cache = { seed, routes };
  return routes;
}

/** Things in the water boats keep clear of: the piers, the marina, the bridge towers. */
function obstacle(x: number, z: number): number {
  let d = Infinity;
  const box = (x0: number, x1: number, z0: number, z1: number) => Math.hypot(Math.max(0, x0 - x, x - x1), Math.max(0, z0 - z, z - z1));
  d = Math.min(d, box(PIER.x0 - 1.4, PIER.x1 + 0.4, PIER.z0, PIER.z1 + 0.4));
  d = Math.min(d, Math.hypot(x - MARINA.x, z - MARINA.z - 1.2) - 3.6);
  // The Embarcadero's finger piers north and south of the Ferry Building.
  for (const [pz, len] of [[3.6, 5.2], [6.2, 4.6], [-10.6, 5.6], [-13.8, 5.4], [-17, 5.8]] as const) d = Math.min(d, box(11.2, 11.2 + len, pz - 0.7, pz + 0.7));
  const gg = LANDMARKS.goldenGate;
  for (const tz of [11.4, 19.6]) d = Math.min(d, Math.hypot(x - gg.x, z - tz) - 1.4);
  return d;
}

/** The search grid: the bay and the strait, in cells of CELL units. */
const CELL = 1.25;
const X0 = -46;
const Z0 = -16;
const NX = 84;
const NZ = 54;

function findRoutes(): BayRoutes {
  // The distance to anything a boat must avoid, on a 1-unit grid over the bay.
  const field = new Float32Array(NX * NZ);
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) field[j * NX + i] = Math.min(coastDistance(X0 + i * CELL, Z0 + j * CELL), obstacle(X0 + i * CELL, Z0 + j * CELL));
  const clearAt = (x: number, z: number) => Math.min(coastDistance(x, z), obstacle(x, z));

  /** Pushes a point out to open water (at least `clear` from anything), searching outward. */
  const toWater = (p: Pt, clear: number): Pt => {
    if (clearAt(p[0], p[1]) >= clear) return p;
    for (let r = 0.3; r < 12; r += 0.3) {
      for (let a = 0; a < 16; a++) {
        const x = p[0] + Math.cos((a / 16) * Math.PI * 2) * r;
        const z = p[1] + Math.sin((a / 16) * Math.PI * 2) * r;
        if (clearAt(x, z) >= clear) return [x, z];
      }
    }
    return p;
  };

  /** The shortest comfortable way across the water from a to b; through a narrower channel if that's all there is. */
  const route = (a: Pt, b: Pt, clear: number): Pt[] => {
    for (const c of [clear, 1.4, 1.0, 0.7]) {
      if (c > clear) continue;
      const found = search(a, b, c);
      if (found) return found;
    }
    return [a, b];
  };

  /** A path search over the grid, pulled straight, corners rounded; null if there's no way through. */
  const search = (a: Pt, b: Pt, clear: number): Pt[] | null => {
    const cell = (p: Pt) => [Math.max(0, Math.min(NX - 1, Math.round((p[0] - X0) / CELL))), Math.max(0, Math.min(NZ - 1, Math.round((p[1] - Z0) / CELL)))] as const;
    const [si, sj] = cell(a);
    const [ti, tj] = cell(b);
    const open = (i: number, j: number) => i >= 0 && j >= 0 && i < NX && j < NZ && field[j * NX + i]! >= clear;
    const g = new Float32Array(NX * NZ).fill(Infinity);
    const from = new Int32Array(NX * NZ).fill(-1);
    const heap: [number, number][] = [];
    const push = (f: number, k: number) => {
      heap.push([f, k]);
      let n = heap.length - 1;
      while (n > 0) {
        const p = (n - 1) >> 1;
        if (heap[p]![0] <= heap[n]![0]) break;
        [heap[p], heap[n]] = [heap[n]!, heap[p]!];
        n = p;
      }
    };
    const pop = () => {
      const top = heap[0]!;
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let n = 0;
        for (;;) {
          const l = n * 2 + 1;
          const r = l + 1;
          let m = n;
          if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
          if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
          if (m === n) break;
          [heap[m], heap[n]] = [heap[n]!, heap[m]!];
          n = m;
        }
      }
      return top;
    };
    const start = sj * NX + si;
    g[start] = 0;
    push(0, start);
    const goal = tj * NX + ti;
    while (heap.length) {
      const [, k] = pop();
      if (k === goal) break;
      const i = k % NX;
      const j = (k - i) / NX;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
        const ni = i + di;
        const nj = j + dj;
        if (!open(ni, nj) && !(ni === ti && nj === tj)) continue;
        const nk = nj * NX + ni;
        // Prefer open water: cost rises close to the shore.
        const step = Math.hypot(di, dj) * CELL * (1 + 2.5 / (Math.max(0, field[nk]! - clear) + 0.8));
        const ng = g[k]! + step;
        if (ng < g[nk]!) {
          g[nk] = ng;
          from[nk] = k;
          push(ng + Math.hypot(ti - ni, tj - nj) * CELL, nk);
        }
      }
    }
    const cells: Pt[] = [];
    for (let k = goal; k >= 0; k = from[k]!) {
      const i = k % NX;
      cells.push([X0 + i * CELL, Z0 + ((k - i) / NX) * CELL]);
      if (k === start) break;
    }
    if (cells.length < 2 || from[goal] < 0) return null;
    cells.reverse();
    cells[0] = a;
    cells[cells.length - 1] = b;
    // Pull the path straight: from each point, on to the farthest one in clear sight.
    const sight = (p: Pt, q: Pt) => {
      const n = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 0.3);
      for (let s = 1; s < n; s++) if (clearAt(p[0] + ((q[0] - p[0]) * s) / n, p[1] + ((q[1] - p[1]) * s) / n) < clear) return false;
      return true;
    };
    const pulled: Pt[] = [cells[0]!];
    for (let i = 0; i < cells.length - 1; ) {
      let j = cells.length - 1;
      while (j > i + 1 && !sight(cells[i]!, cells[j]!)) j--;
      pulled.push(cells[j]!);
      i = j;
    }
    // Round the corners (Chaikin), keeping the rounding only where it stays clear.
    let pts = pulled;
    for (let pass = 0; pass < 2; pass++) {
      const next: Pt[] = [pts[0]!];
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, az] = pts[i]!;
        const [bx, bz] = pts[i + 1]!;
        const q: Pt = [ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25];
        const r: Pt = [ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75];
        if (i > 0) next.push(q);
        if (i < pts.length - 2) next.push(r);
      }
      next.push(pts.at(-1)!);
      if (next.every((p, i) => i === 0 || sight(next[i - 1]!, p))) pts = next;
    }
    return pts;
  };

  // The Sausalito ferry: from the Ferry Building's slip to the landing below the town.
  const town = MARIN[5]!;
  const landing = toWater([town[0] + 1.3, town[1] + 0.6], 0.8);
  const sausalito = route([13.6, -1.2], landing, 1.2);
  // The tug: from the Ferry Building round the corner to the Wharf.
  const tug = route([13.4, -4.2], toWater([6, 11.6], 1.0), 0.9);
  // The container ship: in from the Pacific under the Golden Gate, across to the Port of Oakland.
  const gg = LANDMARKS.goldenGate.x;
  const shipping: Pt[] = [[-110, 14], [-60, 14.5], ...route([gg, 15.4], [53.5, 12], 2.0)];

  // Sailing loops wherever there's room for one, spread round the bay.
  const r = rng(hash('sails', WORLD_SPEC.seed));
  const sails: [number, number, number, number][] = [];
  const F = ISLANDS.founder;
  for (let tries = 0; tries < 400 && sails.length < 5; tries++) {
    const cx = -22 + r() * 48;
    const cz = 12 + r() * 22;
    const rx = 3 + r() * 3;
    const rz = 2.4 + r() * 2.4;
    if (sails.some(([x, z]) => Math.hypot(x - cx, z - cz) < 6)) continue;
    if (Math.hypot(cx - F.x, cz - F.z) < F.r + rx + 1) continue;
    let ok = true;
    for (let a = 0; a < 24 && ok; a++) {
      const t = (a / 24) * Math.PI * 2;
      if (clearAt(cx + Math.cos(t) * rx + Math.sin(t * 3) * 0.3, cz + Math.sin(t) * rz) < 1.6) ok = false;
    }
    if (ok) sails.push([cx, cz, rx, rz]);
  }
  return { sausalito, oakland: CLASSIC.oakland, tug, shipping, sails };
}
