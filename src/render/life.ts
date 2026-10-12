import * as THREE from 'three';
import { GeoBuilder, glowMaterial, type ColorLike } from './geo.ts';
import { densify } from './effects.ts';
import { LANDMARKS, RUNWAY, SEA, type Pt } from '../world/map.ts';
import { hash, pick, rng } from '../world/rng.ts';
import type { Atmosphere } from '../world/daylight.ts';

/**
 * Ambient life that metrics don't drive: ferries and sailboats with wakes,
 * a container ship, airliners landing and taking off, gulls over the
 * wharf, Karl the Fog rolling through the Golden Gate, cloud shadows
 * drifting over the city, kites on the Marina Green and the Powell
 * Street cable cars.
 */

/** Things on this layer cast shadows but are never drawn (cloud shadows). */
export const SHADOW_ONLY_LAYER = 1;

const NAV_RED: ColorLike = [3, 0.25, 0.2];
const NAV_GREEN: ColorLike = [0.3, 3, 0.6];
const NAV_WHITE: ColorLike = [3, 3, 2.8];
const CABIN: ColorLike = [1.7, 1.2, 0.65];

// ─── Routes on the water (checked against the coastline: ≥1 unit offshore) ──

const FERRY_SAUSALITO: Pt[] = [[13.6, -1.2], [16, 5], [9, 14.5], [4.5, 22], [3.5, 32], [-10, 31.5], [-20, 29.5], [-24.2, 27.6]];
const FERRY_OAKLAND: Pt[] = [[13.6, -2.2], [20, -10.5], [33, -12.6], [45, -11], [54, -8]];
const SHIPPING_LANE: Pt[] = [[-110, 14], [-60, 14.5], [-34.6, 15.4], [-22, 18.5], [-13.5, 23], [-11, 30], [4, 34], [22, 29], [40, 18], [53.5, 12]];
/** Sailing loops: centre, radii. */
const SAIL_LOOPS: [number, number, number, number][] = [[10, 20, 6, 5], [-18, 18.5, 5, 2.5], [20, 8, 4, 3], [12, 24, 4.5, 3.5]];
/** Powell Street cable car: from the turntable at Market up to the wharf. */
const CABLE_LINE = { x: -2.5, z0: -11.9, z1: 7.2 };

interface Mover {
  obj: THREE.Object3D;
  wake?: Wake;
  update(dt: number, time: number): void;
}

export class Life {
  readonly object = new THREE.Group();
  private movers: Mover[] = [];
  private fog: { sprite: THREE.Sprite; base: THREE.Vector3; speed: number; phase: number; mat: THREE.SpriteMaterial }[] = [];
  private shadows: { obj: THREE.Object3D; speed: number }[] = [];
  private gulls: Gulls;

  constructor(seed: number) {
    const r = rng(hash(seed, 'life'));
    // Ferries back and forth; the Oakland one ducks under the Bay Bridge.
    this.ferry(FERRY_SAUSALITO, 0.55, 0.1, 0x2f6a4f);
    this.ferry(FERRY_OAKLAND, 0.6, 0.55, 0x2a5a8a);
    // A container ship sailing in through the Golden Gate, bound for Oakland.
    this.ship(SHIPPING_LANE, 0.42);
    for (let i = 0; i < SAIL_LOOPS.length; i++) {
      const [cx, cz, rx, rz] = SAIL_LOOPS[i]!;
      this.sailboat(cx, cz, rx, rz, r() * Math.PI * 2, (r() < 0.5 ? -1 : 1) * (0.05 + r() * 0.03), r);
    }
    this.sailboat(10, 20, 4.2, 3.2, 2, 0.06, r);
    this.airliners(seed);
    this.cableCars();
    this.kites(r);
    this.gulls = new Gulls(r);
    this.object.add(this.gulls.object);
    this.karl(r);
    this.cloudShadows(r);
  }

  // ─── Boats ──────────────────────────────────────────────────────────────

  private ferry(route: Pt[], speed: number, start: number, trim: number) {
    const b = new GeoBuilder();
    // Twin-hull catamaran: two slim hulls, a white double-deck cabin, green trim.
    for (const s of [-1, 1]) b.rbox(1.1, 0.1, 0.16, 0, -0.06, s * 0.12, 0xf4f4f0, 0.04);
    b.rbox(1.0, 0.04, 0.46, 0, 0.03, 0, trim, 0.02);
    b.rbox(0.82, 0.16, 0.4, -0.04, 0.06, 0, 0xf8f8f4, 0.03);
    b.rbox(0.52, 0.12, 0.34, -0.1, 0.22, 0, 0xf8f8f4, 0.03);
    b.box(0.86, 0.02, 0.44, -0.04, 0.22, 0, trim);
    b.box(0.16, 0.06, 0.2, 0.1, 0.34, 0, 0xf8f8f4);
    b.quad(0.14, 0.04, 0.181, 0.37, 0, 'x+', [0.4, 0.55, 0.7], true, 0.2);
    for (const s of [1, -1] as const) {
      for (let k = 0; k < 9; k++) b.quad(0.06, 0.06, -0.4 + k * 0.085, 0.15, s * 0.201, s > 0 ? 'z+' : 'z-', CABIN, true, 0.12 + (k % 4) * 0.2);
      for (let k = 0; k < 5; k++) b.quad(0.06, 0.05, -0.3 + k * 0.085, 0.29, s * 0.171, s > 0 ? 'z+' : 'z-', CABIN, true, 0.15 + (k % 3) * 0.2);
    }
    b.cylinder(0.006, 0.006, 0.14, 0.12, 0.36, 0, 0x333333, 4);
    b.blob(0.02, 0.12, 0.5, 0, NAV_WHITE, true);
    b.blob(0.015, 0.0, 0.24, 0.23, NAV_GREEN, true);
    b.blob(0.015, 0.0, 0.24, -0.23, NAV_RED, true);
    const obj = this.built(b);
    const path = new THREE.CatmullRomCurve3(densify(route, 2).map(([x, z]) => new THREE.Vector3(x, SEA, z)), false, 'centripetal');
    const len = path.getLength();
    const wake = new Wake(0.22, 1);
    this.object.add(obj, wake.mesh);
    let d = start * len;
    let dir = 1;
    let wait = 0;
    const tmp = new THREE.Vector3();
    this.movers.push({
      obj,
      wake,
      update: (dt, time) => {
        if (wait > 0) wait -= dt;
        else {
          // Ease into and out of the piers.
          const edge = Math.min(d, len - d);
          const v = speed * THREE.MathUtils.clamp(edge / 3, 0.2, 1);
          d += dir * v * dt;
          if (d > len || d < 0) {
            d = THREE.MathUtils.clamp(d, 0, len);
            dir = -dir;
            wait = 6;
          }
        }
        const u = d / len;
        path.getPointAt(u, obj.position);
        path.getTangentAt(u, tmp);
        if (dir < 0) tmp.negate();
        obj.rotation.y = Math.atan2(-tmp.z, tmp.x);
        obj.position.y = SEA + 0.02 + Math.sin(time * 1.3 + start * 9) * 0.008;
        obj.rotation.z = Math.sin(time * 0.9 + start) * 0.015;
        wake.update(dt, obj.position, wait > 0 ? 0 : 1);
      },
    });
  }

  private ship(route: Pt[], speed: number) {
    const b = new GeoBuilder();
    const L = 4.4;
    // Hull: dark red bottom, navy topsides, a raked bow, the bridge aft.
    const hull = new THREE.Shape([
      new THREE.Vector2(-L / 2, -0.28),
      new THREE.Vector2(L / 2 - 0.3, -0.28),
      new THREE.Vector2(L / 2, 0.02),
      new THREE.Vector2(L / 2 + 0.06, 0.2),
      new THREE.Vector2(-L / 2 + 0.05, 0.2),
      new THREE.Vector2(-L / 2, 0.05),
    ]);
    const g = new THREE.ExtrudeGeometry(hull, { depth: 0.62, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.03, bevelSegments: 1 });
    g.translate(0, 0, -0.31);
    b.transformed(g, new THREE.Matrix4(), 0x22324a);
    b.box(L - 0.1, 0.1, 0.7, 0, -0.28, 0, 0x8a2a24);
    b.box(L * 0.92, 0.02, 0.62, 0, 0.2, 0, 0x6b6f78);
    const r = rng(77);
    const colours = [0xc84a3a, 0x2f6fa8, 0x2f8a6a, 0xe0a030, 0x6a6a72, 0xd8d0c0, 0x8a3a6a] as const;
    for (let i = 0; i < 12; i++) {
      for (let j = 0; j < 3; j++) {
        const h = 1 + Math.floor(r() * 3);
        for (let k = 0; k < h; k++) b.box(0.24, 0.12, 0.17, -L / 2 + 0.95 + i * 0.26, 0.22 + k * 0.125, -0.19 + j * 0.19, pick(r, colours));
      }
    }
    b.box(0.42, 0.55, 0.6, -L / 2 + 0.38, 0.22, 0, 0xf2f0ea);
    b.box(0.5, 0.05, 0.72, -L / 2 + 0.4, 0.77, 0, 0xf2f0ea);
    b.windows({ w: 0.42, d: 0.6, x: -L / 2 + 0.38, z: 0, y0: 0.22, rows: 4, rowHeight: 0.13, cols: 4, faces: ['x+', 'z+', 'z-'] }, r, 0.7, CABIN, { w: 0.06, h: 0.05 });
    b.box(0.12, 0.3, 0.14, -L / 2 + 0.25, 0.82, 0, 0x2a2a2e);
    b.box(0.13, 0.05, 0.15, -L / 2 + 0.25, 1.0, 0, 0xc84a3a);
    b.blob(0.03, -L / 2 + 0.38, 0.95, 0, NAV_WHITE, true);
    b.blob(0.03, L / 2, 0.42, 0, NAV_WHITE, true);
    const obj = this.built(b);
    const path = new THREE.CatmullRomCurve3(densify(route, 3).map(([x, z]) => new THREE.Vector3(x, SEA, z)), false, 'centripetal');
    const len = path.getLength();
    const wake = new Wake(0.6, 1.4);
    this.object.add(obj, wake.mesh);
    let d = len * 0.35;
    const tmp = new THREE.Vector3();
    this.movers.push({
      obj,
      wake,
      update: (dt, time) => {
        d += speed * dt;
        let respawn = false;
        if (d > len) {
          d = 0;
          respawn = true;
        }
        const u = d / len;
        path.getPointAt(u, obj.position);
        path.getTangentAt(u, tmp);
        obj.rotation.y = Math.atan2(-tmp.z, tmp.x);
        obj.position.y = SEA + 0.04 + Math.sin(time * 0.6) * 0.01;
        if (respawn) wake.reset();
        wake.update(dt, obj.position, 1);
      },
    });
  }

  private sailboat(cx: number, cz: number, rx: number, rz: number, phase: number, rate: number, r: () => number) {
    const b = new GeoBuilder();
    const hull = new THREE.Shape([new THREE.Vector2(-0.24, 0), new THREE.Vector2(0.18, 0), new THREE.Vector2(0.3, 0.07), new THREE.Vector2(-0.26, 0.07)]);
    const g = new THREE.ExtrudeGeometry(hull, { depth: 0.12, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 1 });
    g.translate(0, -0.02, -0.06);
    b.transformed(g, new THREE.Matrix4(), pick(r, [0xf8f8f4, 0x1c2a3a, 0xf8f8f4, 0x8a2a24] as const), 'smooth');
    b.box(0.2, 0.04, 0.1, -0.04, 0.07, 0, 0xe8dcc4);
    b.cylinder(0.006, 0.008, 0.62, 0.02, 0.07, 0, 0xd8d8d8, 4);
    const main = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0, 0.56), new THREE.Vector2(-0.26, 0.02)]);
    b.transformed(new THREE.ShapeGeometry(main), new THREE.Matrix4().makeTranslation(0.015, 0.1, 0), 0xfbfaf6, 'smooth');
    const jib = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0, 0.48), new THREE.Vector2(0.24, 0.0)]);
    b.transformed(new THREE.ShapeGeometry(jib), new THREE.Matrix4().makeTranslation(0.03, 0.1, 0.003), r() < 0.3 ? 0xe85a4a : 0xf4f0e6, 'smooth');
    b.blob(0.012, 0.02, 0.7, 0, NAV_WHITE, true);
    const obj = this.built(b);
    const sails = obj;
    const wake = new Wake(0.08, 0.6);
    this.object.add(obj, wake.mesh);
    let a = phase;
    this.movers.push({
      obj,
      wake,
      update: (dt, time) => {
        a += rate * dt;
        const x = cx + Math.cos(a) * rx + Math.sin(a * 3) * 0.3;
        const z = cz + Math.sin(a) * rz;
        const dx = -Math.sin(a) * rx * Math.sign(rate);
        const dz = Math.cos(a) * rz * Math.sign(rate);
        obj.position.set(x, SEA + 0.02, z);
        obj.rotation.set(0, Math.atan2(-dz, dx), 0);
        // Heel away from the wind and pitch over the chop.
        sails.rotateX(0.18 + Math.sin(time * 0.7 + phase) * 0.04);
        sails.rotateZ(Math.sin(time * 1.6 + phase) * 0.03);
        wake.update(dt, obj.position, 0.7);
      },
    });
  }

  // ─── Airliners ──────────────────────────────────────────────────────────

  private airliners(seed: number) {
    const rx = RUNWAY.x;
    const tx = rx - 2.1;
    const y = 0.03;
    // One cycle: approach from the south, land northbound, taxi back down the
    // parallel taxiway, line up, take off northbound and turn out over the East Bay.
    const keys: [number, number, number, number][] = [
      [0, rx, 15, -130],
      [16, rx, 5.5, -85],
      [24, rx, 1.6, -58],
      [27, rx, y, -49],
      [30, rx, y, -43.5],
      [33, rx, y, -40.2],
      [36, rx - 0.9, y, -38.6],
      [38, tx, y, -39.4],
      [47, tx, y, -46.6],
      [50, tx + 0.6, y, -48.8],
      [52, rx, y, -49.3],
      [60, rx, y, -49.25],
      [64.5, rx, y, -45],
      [67, rx, y, -39.5],
      [69, rx, 0.9, -35],
      [75, rx + 2.5, 4.5, -24],
      [83, 40, 9, -12],
      [95, 62, 16, 8],
      [108, 85, 24, 30],
    ];
    const cycle = 108;
    const pts = keys.map(([, x, yy, z]) => new THREE.Vector3(x, yy, z));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.3);
    const at = (t: number, out: THREE.Vector3) => {
      let i = 0;
      while (i < keys.length - 2 && keys[i + 1]![0] <= t) i++;
      const t0 = keys[i]![0];
      const t1 = keys[i + 1]![0];
      const u = THREE.MathUtils.clamp((t - t0) / (t1 - t0), 0, 1);
      return curve.getPoint((i + u) / (keys.length - 1), out);
    };
    for (const offset of [0, cycle / 2]) {
      const { obj, strobe, beacon } = this.airliner(hash(seed, 'airliner', offset));
      this.object.add(obj);
      const p = new THREE.Vector3();
      const q = new THREE.Vector3();
      let heading = Math.PI / 2;
      let bank = 0;
      this.movers.push({
        obj,
        update: (dt, time) => {
          const t = (time + offset) % cycle;
          at(t, p);
          at(Math.min(cycle - 0.01, t + 0.4), q);
          obj.position.copy(p);
          const dx = q.x - p.x;
          const dz = q.z - p.z;
          const flat = Math.hypot(dx, dz);
          if (flat > 0.004) {
            const h = Math.atan2(-dz, dx);
            let turn = h - heading;
            turn = Math.atan2(Math.sin(turn), Math.cos(turn));
            heading += turn * Math.min(1, dt * 6);
            bank += (THREE.MathUtils.clamp(-turn * 6, -0.5, 0.5) * (p.y > 0.5 ? 1 : 0) - bank) * Math.min(1, dt * 2);
          }
          const pitch = flat > 0.004 ? Math.atan2(q.y - p.y, flat) : 0;
          obj.rotation.set(bank, heading, pitch, 'YZX');
          obj.visible = t < cycle - 4;
          const blink = (time * 1.1 + offset) % 1;
          strobe.color.setScalar(blink < 0.06 ? 3 : 0);
          beacon.color.setRGB(3, 0.2, 0.15).multiplyScalar(blink > 0.5 && blink < 0.58 ? 1 : 0);
        },
      });
    }
  }

  /** A narrow-body airliner along +x, ~2.4 long, with its own strobe and beacon. */
  private airliner(seed: number): { obj: THREE.Group; strobe: THREE.MeshBasicMaterial; beacon: THREE.MeshBasicMaterial } {
    const r = rng(seed);
    const livery = pick(r, [0x1f4e9a, 0xc8302a, 0x2a7a6a, 0x5a2a8a] as const);
    const b = new GeoBuilder();
    const L = 2.4;
    // Fuselage: a lathe profile laid along x.
    const prof: [number, number][] = [[0.0, 0], [0.07, 0.03], [0.12, 0.12], [0.14, 0.3], [0.145, 0.6], [0.145, 1.75], [0.13, 2.0], [0.09, 2.25], [0.03, 2.4], [0, 2.4]];
    const fus = new THREE.LatheGeometry(prof.map(([rr, h]) => new THREE.Vector2(rr, h)), 16).rotateZ(-Math.PI / 2).translate(L / 2, 0.42, 0);
    b.transformed(fus, new THREE.Matrix4(), 0xf6f6f4, 'smooth');
    // Livery cheatline and belly
    b.box(1.9, 0.03, 0.296, -0.05, 0.4, 0, livery);
    b.box(1.7, 0.04, 0.24, -0.05, 0.29, 0, 0xd8dbe2);
    // Window band and cockpit
    for (const s of [1, -1] as const) {
      for (let k = 0; k < 22; k++) b.quad(0.025, 0.025, -0.78 + k * 0.075, 0.46, s * 0.146, s > 0 ? 'z+' : 'z-', CABIN, true, 0.1 + (k % 5) * 0.15);
    }
    b.transformed(new THREE.BoxGeometry(0.08, 0.035, 0.18).rotateZ(-0.5), new THREE.Matrix4().makeTranslation(L / 2 - 0.2, 0.5, 0), 0x2a3440, 'glass');
    // Wings with dihedral, sweep and winglets
    for (const s of [-1, 1]) {
      const wing = new THREE.Shape([new THREE.Vector2(0.28, 0), new THREE.Vector2(-0.22, 0), new THREE.Vector2(-0.62, 1.08), new THREE.Vector2(-0.44, 1.08)]);
      const g = new THREE.ExtrudeGeometry(wing, { depth: 0.025, bevelEnabled: false }).rotateX(Math.PI / 2);
      if (s < 0) g.scale(1, 1, -1);
      g.rotateX(s * -0.08);
      b.transformed(g, new THREE.Matrix4().makeTranslation(0.1, 0.33, s * 0.1), 0xe9ebef, 'solid');
      b.box(0.14, 0.14, 0.012, -0.5, 0.42, s * 1.18, livery);
      // Engines
      const eng = new THREE.CylinderGeometry(0.075, 0.065, 0.32, 12).rotateZ(Math.PI / 2);
      b.transformed(eng, new THREE.Matrix4().makeTranslation(0.08, 0.24, s * 0.42), 0xdcdfe6, 'smooth');
      b.cylinder(0.058, 0.058, 0.01, 0.245, 0.18, s * 0.42, 0x3a3f48, 12, false);
      b.box(0.12, 0.05, 0.03, 0.02, 0.29, s * 0.42, 0xcfd3da);
      b.blob(0.018, -0.52, 0.38, s * 1.2, s > 0 ? NAV_GREEN : NAV_RED, true);
    }
    // Tail: fin in livery, tailplanes
    const fin = new THREE.Shape([new THREE.Vector2(-1.2, 0), new THREE.Vector2(-0.82, 0), new THREE.Vector2(-1.12, 0.52), new THREE.Vector2(-1.26, 0.52)]);
    b.transformed(new THREE.ExtrudeGeometry(fin, { depth: 0.02, bevelEnabled: false }).translate(0, 0, -0.01), new THREE.Matrix4().makeTranslation(0, 0.5, 0), livery);
    for (const s of [-1, 1]) {
      const tp = new THREE.Shape([new THREE.Vector2(-0.95, 0), new THREE.Vector2(-1.15, 0), new THREE.Vector2(-1.25, 0.42), new THREE.Vector2(-1.15, 0.42)]);
      const g = new THREE.ExtrudeGeometry(tp, { depth: 0.015, bevelEnabled: false }).rotateX(Math.PI / 2);
      if (s < 0) g.scale(1, 1, -1);
      b.transformed(g, new THREE.Matrix4().makeTranslation(0, 0.5, s * 0.06), 0xe9ebef);
    }
    // Gear
    for (const [gx, gz] of [[0.9, 0], [0.0, 0.16], [0.0, -0.16]] as const) {
      b.box(0.015, 0.22, 0.015, gx, 0.06, gz, 0x555a62);
      b.cylinder(0.035, 0.035, 0.03, gx, 0.02, gz, 0x1c1c20, 8);
    }
    b.blob(0.02, 0.9, 0.3, 0, NAV_WHITE, true);
    const { group } = b.build();
    group.traverse((o) => {
      o.castShadow = true;
    });
    const strobe = glowMaterial({ color: new THREE.Color(3, 3, 3) });
    const beacon = glowMaterial({ color: new THREE.Color(3, 0.2, 0.15) });
    for (const [x, yy, z, m] of [[-0.5, 0.42, 1.21, strobe], [-0.5, 0.42, -1.21, strobe], [-1.22, 1.03, 0, strobe], [0, 0.58, 0, beacon], [0, 0.26, 0, beacon]] as const) {
      const s = new THREE.Mesh(new THREE.IcosahedronGeometry(0.03, 0), m);
      s.position.set(x, yy, z);
      group.add(s);
    }
    return { obj: group, strobe, beacon };
  }

  // ─── Cable cars ─────────────────────────────────────────────────────────

  private cableCars() {
    const { x, z0, z1 } = CABLE_LINE;
    const rails = new GeoBuilder();
    for (const s of [-0.24, 0.24]) {
      for (const o of [-0.07, 0.07]) rails.box(0.012, 0.006, z1 - z0, x + s + o, 0.021, (z0 + z1) / 2, 0x9a9ea6);
      rails.box(0.008, 0.004, z1 - z0, x + s, 0.021, (z0 + z1) / 2, 0x2a2a2e);
    }
    // The turntable at Powell and Market
    rails.cylinder(0.42, 0.42, 0.012, x, 0.018, z0 - 0.15, 0x8a7a62, 20);
    rails.cylinder(0.36, 0.36, 0.014, x, 0.02, z0 - 0.15, 0x6b5a46, 20);
    this.object.add(this.built(rails));
    for (const [start, lane] of [[0.15, 0.24], [0.65, -0.24]] as const) {
      const car = this.cableCar();
      this.object.add(car);
      let d = start * (z1 - z0);
      let dir = lane > 0 ? 1 : -1;
      let wait = 0;
      this.movers.push({
        obj: car,
        update: (dt, time) => {
          const span = z1 - z0;
          if (wait > 0) wait -= dt;
          else {
            // Cable cars grip at a steady 9.5 mph: no easing, just a jolt at the ends.
            d += dir * 0.42 * dt;
            if (d > span || d < 0) {
              d = THREE.MathUtils.clamp(d, 0, span);
              dir = -dir;
              wait = 5;
            }
          }
          const l = dir > 0 ? -0.24 : 0.24;
          car.position.set(x + l, 0.022, z0 + d);
          car.rotation.y = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
          car.rotation.z = Math.sin(time * 9 + start * 20) * 0.006;
        },
      });
    }
  }

  /** Powell Street cable car along +x: open benches at the ends, closed cabin in the middle. */
  private cableCar(): THREE.Group {
    const b = new GeoBuilder();
    const L = 0.6;
    b.box(L, 0.05, 0.22, 0, 0.03, 0, 0x6b2a22);
    b.box(L * 0.5, 0.16, 0.2, 0, 0.08, 0, 0xc8402e);
    b.box(L * 0.5 + 0.004, 0.035, 0.204, 0, 0.08, 0, 0xf2e2b8);
    for (const s of [1, -1] as const) {
      for (let k = 0; k < 4; k++) b.quad(0.05, 0.06, -0.11 + k * 0.073, 0.19, s * 0.101, s > 0 ? 'z+' : 'z-', CABIN, true, 0.2 + k * 0.15);
      // Open ends: benches and posts
      b.box(0.14, 0.03, 0.18, s * 0.22, 0.08, 0, 0x8a5a32);
      for (const pz of [-0.09, 0.09]) b.box(0.012, 0.18, 0.012, s * 0.29, 0.08, pz, 0x6b2a22);
      b.blob(0.016, s * 0.3, 0.13, 0, s > 0 ? NAV_WHITE : [2.6, 0.3, 0.2], true);
    }
    b.rbox(L + 0.04, 0.035, 0.25, 0, 0.26, 0, 0xf2e2b8, 0.015);
    b.box(L * 0.4, 0.03, 0.18, 0, 0.29, 0, 0x6b2a22);
    // A few riders hanging off the running boards
    const r = rng(3);
    for (let k = 0; k < 5; k++) {
      const px = -0.24 + k * 0.12;
      const pz = k % 2 ? 0.12 : -0.12;
      b.box(0.028, 0.09, 0.028, px, 0.08, pz, pick(r, [0x2f6fa8, 0xe85a4a, 0xf2c84b, 0x3a3a3a, 0x8a5a9a] as const));
      b.blob(0.018, px, 0.19, pz, 0xe0b090);
    }
    for (const wx of [-0.2, 0.2]) for (const wz of [-0.08, 0.08]) b.cylinder(0.03, 0.03, 0.02, wx, 0.0, wz, 0x2a2a2e, 8);
    return this.built(b);
  }

  // ─── Kites, fog, cloud shadows ──────────────────────────────────────────

  private kites(r: () => number) {
    const colours: ColorLike[] = [0xe85a4a, 0xf2c84b, 0x3aa3c8, 0x8a5ad8, 0x5ac46a];
    for (let i = 0; i < 4; i++) {
      const ax = -23 + i * 1.6 + r() * 0.5;
      const az = 9.4 + r() * 0.5;
      const b = new GeoBuilder();
      const diamond = new THREE.Shape([new THREE.Vector2(0, 0.16), new THREE.Vector2(0.09, 0), new THREE.Vector2(0, -0.2), new THREE.Vector2(-0.09, 0)]);
      b.transformed(new THREE.ShapeGeometry(diamond), new THREE.Matrix4(), colours[i % colours.length]!, 'smooth');
      for (let k = 0; k < 5; k++) b.box(0.03, 0.02, 0.005, Math.sin(k) * 0.02, -0.24 - k * 0.06, 0, colours[(i + 2) % colours.length]!);
      const kite = this.built(b);
      kite.traverse((o) => {
        if (o instanceof THREE.Mesh) (o.material as THREE.Material).side = THREE.DoubleSide;
      });
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0xf8f8f8, transparent: true, opacity: 0.6 }));
      this.object.add(kite, line);
      const base = new THREE.Vector3(ax, 0.05, az);
      const phase = r() * 10;
      this.movers.push({
        obj: kite,
        update: (_dt, time) => {
          kite.position.set(ax + 1.1 + Math.sin(time * 0.6 + phase) * 0.35, 2.4 + Math.sin(time * 0.9 + phase) * 0.3, az + 1.2 + Math.cos(time * 0.5 + phase) * 0.25);
          kite.rotation.set(0, Math.PI / 4, Math.sin(time * 1.4 + phase) * 0.35);
          const pos = line.geometry.attributes.position as THREE.BufferAttribute;
          pos.setXYZ(0, base.x, base.y, base.z);
          pos.setXYZ(1, kite.position.x, kite.position.y - 0.1, kite.position.z);
          pos.needsUpdate = true;
        },
      });
    }
  }

  /** Karl the Fog: soft banks over the Pacific that pour through the Golden Gate mornings and evenings. */
  private karl(r: () => number) {
    const tex = puffTexture();
    for (let i = 0; i < 70; i++) {
      // Most of the bank sits offshore and over the Marin Headlands; a tongue reaches through the Gate.
      const tongue = i < 22;
      const x = tongue ? -44 + r() * 26 : -110 + r() * 68;
      const z = tongue ? 12 + r() * 9 : -40 + r() * 80;
      const mat = new THREE.SpriteMaterial({ map: tex, color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, fog: false });
      const sprite = new THREE.Sprite(mat);
      const s = (tongue ? 5 : 9) + r() * 7;
      sprite.scale.set(s, s * 0.45, 1);
      sprite.position.set(x, 1.2 + r() * 2.6, z);
      sprite.renderOrder = 2;
      this.object.add(sprite);
      this.fog.push({ sprite, base: sprite.position.clone(), speed: 0.15 + r() * 0.2, phase: r() * 100, mat });
    }
  }

  /** Invisible clouds high above: they only cast soft shadows that drift across the city. */
  private cloudShadows(r: () => number) {
    const mat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    for (let i = 0; i < 9; i++) {
      const g = new THREE.Group();
      for (let k = 0; k < 4; k++) {
        const m = new THREE.Mesh(new THREE.IcosahedronGeometry(1.1 + r() * 1.1, 1).scale(1.5, 0.3, 1.1), mat);
        m.position.set((r() - 0.5) * 4, 0, (r() - 0.5) * 3);
        m.castShadow = true;
        m.layers.set(SHADOW_ONLY_LAYER);
        g.add(m);
      }
      g.position.set(-70 + r() * 120, 18 + r() * 4, -50 + r() * 90);
      this.object.add(g);
      this.shadows.push({ obj: g, speed: 0.25 + r() * 0.2 });
    }
  }

  private built(b: GeoBuilder): THREE.Group {
    const { group } = b.build();
    group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    return group;
  }

  update(dt: number, time: number, a: Atmosphere) {
    for (const m of this.movers) m.update(dt, time);
    for (const w of this.movers) w.wake?.setLight(a);
    this.gulls.update(dt, time);

    // Fog thickens around dawn and in the evening, and thins at midday.
    const morning = Math.max(0, 1 - Math.abs(a.hour - 7.5) / 3.2);
    const evening = Math.max(0, 1 - Math.abs(a.hour - 19.5) / 3);
    const density = 0.25 + 0.75 * Math.max(morning, evening);
    const tint = new THREE.Color(...a.fog).lerp(new THREE.Color(1, 1, 1), 0.55 - a.night * 0.4);
    for (const f of this.fog) {
      const x = f.base.x + ((time * f.speed + f.phase) % 30);
      // The tongue through the Gate advances and retreats with the density.
      const reach = f.base.z > 11 && f.base.z < 22 && f.base.x > -45 ? density : 1;
      f.sprite.position.set(x - 8 * (1 - reach), f.base.y + Math.sin(time * 0.2 + f.phase) * 0.15, f.base.z);
      const fade = Math.min(1, ((time * f.speed + f.phase) % 30) / 4, (30 - ((time * f.speed + f.phase) % 30)) / 4);
      f.mat.opacity = 0.55 * density * fade * reach;
      f.mat.color.copy(tint);
    }
    // Cloud shadows only read well under a high sun; a low one would smear them across the bay.
    const [lx, ly, lz] = a.lightDir;
    const high = ly / Math.hypot(lx, ly, lz) > 0.72 && a.night < 0.2;
    for (const s of this.shadows) {
      s.obj.position.x += s.speed * dt;
      if (s.obj.position.x > 60) s.obj.position.x -= 140;
      s.obj.visible = high;
    }
  }
}

// ─── Wakes ──────────────────────────────────────────────────────────────────

const WAKE_POINTS = 48;

/** A foamy V that spreads and fades behind a moving boat. */
class Wake {
  readonly mesh: THREE.Mesh;
  private trail: THREE.Vector3[] = [];
  private ages: number[] = [];
  private every = 0;
  private width: number;
  private life: number;
  private material: THREE.ShaderMaterial;

  constructor(width: number, life: number) {
    this.width = width;
    this.life = 6 * life;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(WAKE_POINTS * 2 * 3), 3));
    geo.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(WAKE_POINTS * 2), 1));
    geo.setAttribute('side', new THREE.BufferAttribute(new Float32Array(WAKE_POINTS * 2).map((_, i) => (i % 2 ? 1 : -1)), 1));
    const idx: number[] = [];
    for (let i = 0; i < WAKE_POINTS - 1; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    geo.setIndex(idx);
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uColor: { value: new THREE.Color(1, 1, 1) } },
      vertexShader: /* glsl */ `
        attribute float alpha;
        attribute float side;
        varying float vAlpha;
        varying float vSide;
        void main() {
          vAlpha = alpha;
          vSide = side;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vAlpha;
        varying float vSide;
        void main() {
          // Bright edges (the two arms of the V), a softer churn in the middle.
          float edge = smoothstep(0.35, 1.0, abs(vSide));
          gl_FragColor = vec4(uColor, vAlpha * (0.35 + 0.65 * edge));
        }`,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  reset() {
    this.trail = [];
    this.ages = [];
  }

  setLight(a: Atmosphere) {
    this.material.uniforms.uColor!.value.setRGB(1, 1, 1).multiplyScalar(0.35 + 0.65 * (1 - a.night));
  }

  update(dt: number, at: THREE.Vector3, moving: number) {
    for (let i = 0; i < this.ages.length; i++) this.ages[i]! += dt;
    this.every -= dt;
    if (this.every <= 0 && moving > 0) {
      this.every = this.life / WAKE_POINTS;
      this.trail.unshift(at.clone());
      this.ages.unshift(0);
      if (this.trail.length > WAKE_POINTS) {
        this.trail.pop();
        this.ages.pop();
      }
    }
    const pos = this.mesh.geometry.attributes.position as THREE.BufferAttribute;
    const alpha = this.mesh.geometry.attributes.alpha as THREE.BufferAttribute;
    const n = this.trail.length;
    for (let i = 0; i < WAKE_POINTS; i++) {
      if (i >= n) {
        alpha.setX(i * 2, 0);
        alpha.setX(i * 2 + 1, 0);
        continue;
      }
      const p = i === 0 ? at : this.trail[i]!;
      const q = this.trail[Math.min(n - 1, i + 1)] ?? p;
      let dx = p.x - q.x;
      let dz = p.z - q.z;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      const age = this.ages[i]! / this.life;
      const w = this.width * (0.35 + age * 2.2);
      const y = SEA + 0.015;
      pos.setXYZ(i * 2, p.x - dz * w, y, p.z + dx * w);
      pos.setXYZ(i * 2 + 1, p.x + dz * w, y, p.z - dx * w);
      const a = Math.max(0, 1 - age) ** 1.5 * 0.55 * moving * Math.min(1, i / 2);
      alpha.setX(i * 2, a);
      alpha.setX(i * 2 + 1, a);
    }
    pos.needsUpdate = true;
    alpha.needsUpdate = true;
  }
}

// ─── Gulls ──────────────────────────────────────────────────────────────────

/** Gulls wheeling over the wharf, the piers and the Ferry Building: instanced, flapping. */
class Gulls {
  readonly object = new THREE.Group();
  private body: THREE.InstancedMesh;
  private wings: [THREE.InstancedMesh, THREE.InstancedMesh];
  private birds: { cx: number; cz: number; r: number; y: number; speed: number; phase: number; flap: number }[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);

  constructor(r: () => number) {
    const spots: [number, number, number][] = [
      [-8.4, 16, 10],
      [12.4, -1.2, 6],
      [-20.5, 12.5, 6],
      [-2, 12, 6],
      [LANDMARKS.coitTower.x, LANDMARKS.coitTower.z, 4],
    ];
    for (const [cx, cz, n] of spots) {
      for (let i = 0; i < n; i++) {
        this.birds.push({ cx: cx + (r() - 0.5) * 3, cz: cz + (r() - 0.5) * 3, r: 0.8 + r() * 2.2, y: 1.4 + r() * 2.2, speed: (0.35 + r() * 0.35) * (r() < 0.5 ? -1 : 1), phase: r() * Math.PI * 2, flap: 5 + r() * 3 });
      }
    }
    const mat = new THREE.MeshStandardMaterial({ color: 0xf6f6f2, roughness: 0.8, side: THREE.DoubleSide });
    this.body = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.018, 0.06, 2, 6).rotateZ(Math.PI / 2), mat, this.birds.length);
    const wing = (s: number) => {
      const shape = new THREE.Shape([new THREE.Vector2(0.03, 0), new THREE.Vector2(-0.03, 0), new THREE.Vector2(-0.06, 0.14), new THREE.Vector2(-0.02, 0.15)]);
      const g = new THREE.ShapeGeometry(shape).rotateX(s * Math.PI / 2);
      if (s < 0) g.scale(1, 1, 1);
      return g;
    };
    const wingMat = new THREE.MeshStandardMaterial({ color: 0xe6e8ec, roughness: 0.8, side: THREE.DoubleSide });
    this.wings = [new THREE.InstancedMesh(wing(1), wingMat, this.birds.length), new THREE.InstancedMesh(wing(-1), wingMat, this.birds.length)];
    for (const m of [this.body, ...this.wings]) {
      m.frustumCulled = false;
      m.castShadow = true;
      this.object.add(m);
    }
  }

  update(_dt: number, time: number) {
    this.birds.forEach((b, i) => {
      const a = b.phase + time * b.speed;
      this.p.set(b.cx + Math.cos(a) * b.r, b.y + Math.sin(time * 0.7 + b.phase) * 0.25, b.cz + Math.sin(a) * b.r);
      const heading = Math.atan2(-Math.cos(a) * Math.sign(b.speed), -Math.sin(a) * Math.sign(b.speed));
      const bank = 0.35 * Math.sign(b.speed);
      this.e.set(bank, heading, 0, 'YXZ');
      this.q.setFromEuler(this.e);
      this.m.compose(this.p, this.q, this.s);
      this.body.setMatrixAt(i, this.m);
      // Flap in bursts, then glide.
      const gliding = Math.sin(time * 0.4 + b.phase * 3) > 0.2;
      const flap = gliding ? 0.15 : Math.sin(time * b.flap + b.phase) * 0.6;
      for (const [k, w] of this.wings.entries()) {
        const side = k === 0 ? -1 : 1;
        this.e.set(bank + side * flap, heading, 0, 'YXZ');
        this.q.setFromEuler(this.e);
        this.m.compose(this.p, this.q, this.s);
        w.setMatrixAt(i, this.m);
      }
    });
    this.body.instanceMatrix.needsUpdate = true;
    for (const w of this.wings) w.instanceMatrix.needsUpdate = true;
  }
}

let puff: THREE.Texture | null = null;
function puffTexture(): THREE.Texture {
  if (puff) return puff;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  // Several overlapping soft blobs make a lumpy, cloud-like puff.
  const r = rng(5);
  for (let i = 0; i < 9; i++) {
    const x = 34 + r() * 60;
    const y = 44 + r() * 40;
    const rad = 22 + r() * 22;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.22)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  }
  puff = new THREE.CanvasTexture(c);
  puff.colorSpace = THREE.SRGBColorSpace;
  return puff;
}
