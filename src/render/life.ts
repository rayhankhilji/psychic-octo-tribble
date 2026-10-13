import * as THREE from 'three';
import { GeoBuilder, glowMaterial, type ColorLike } from './geo.ts';
import { densify } from './effects.ts';
import { Batch } from './batch.ts';
import { LANDMARKS, MARINA, PIER, RUNWAY, SEA, type Pt } from '../world/map.ts';
import { bayRoutes } from '../world/routes.ts';
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

// Routes on the water come from `world/routes.ts`: this world's own, at least a unit offshore.

/** Powell Street cable car: from the turntable at Market up to the wharf. */
const CABLE_LINE = { x: -2.5, z0: -11.9, z1: 7.2 };

interface Mover {
  obj: THREE.Object3D;
  wake?: Wake;
  update(dt: number, time: number): void;
}

/** A model drawn through the batch: `obj` is its proxy, `key` its batch entry. */
interface Batched {
  obj: THREE.Object3D;
  key: string;
}

export class Life {
  readonly object = new THREE.Group();
  private movers: Mover[] = [];
  private fog: { sprite: THREE.Sprite; base: THREE.Vector3; speed: number; phase: number; mat: THREE.SpriteMaterial }[] = [];
  private shadows: { obj: THREE.Object3D; speed: number }[] = [];
  private gulls: Gulls;
  /** Every boat, airliner, cable car and kite in a few draw calls. */
  private batch = new Batch(64, 80_000);
  private batched: Batched[] = [];
  private cableCarObjs: THREE.Object3D[] = [];
  private fogTint = new THREE.Color();
  private white = new THREE.Color(1, 1, 1);

  constructor(seed: number) {
    const r = rng(hash(seed, 'life'));
    this.object.add(this.batch.object);
    const routes = bayRoutes();
    // Ferries back and forth; the Oakland one ducks under the Bay Bridge.
    this.ferry(routes.sausalito, 0.55, 0.1, 0x2f6a4f);
    this.ferry(routes.oakland, 0.6, 0.55, 0x2a5a8a);
    // A container ship sailing in through the Golden Gate, bound for Oakland.
    this.ship(routes.shipping, 0.42);
    // A tug pottering along the waterfront between the Ferry Building and the wharf.
    this.harbourTug(routes.tug, 0.2);
    // Sloops tacking round their loops; the last keeps a steady course.
    const loops = routes.sails;
    for (let i = 0; i < loops.length - 1; i++) {
      const [cx, cz, rx, rz] = loops[i]!;
      this.sailboat(cx, cz, rx, rz, r() * Math.PI * 2, (r() < 0.5 ? -1 : 1) * (0.05 + r() * 0.03), r);
    }
    const last = loops.at(-1);
    if (last) this.sailboat(last[0], last[1], last[2], last[3], 2, 0.06, r);
    this.airliners(seed);
    this.cableCars();
    this.kites(r);
    this.gulls = new Gulls(r);
    this.object.add(this.gulls.object);
    this.karl(r);
    this.cloudShadows(r);
  }

  // ─── Boats ──────────────────────────────────────────────────────────────

  /**
   * Moves a boat along a route, back and forth (ferries) or round and round
   * (the container ship), easing into the piers. Its wake trails from the bow.
   */
  private sail(obj: THREE.Object3D, wake: Wake, route: Pt[], o: { speed: number; start: number; loop: boolean; length: number; bob: number; dwell?: number; lag?: number; side?: number }) {
    const path = new THREE.CatmullRomCurve3(densify(route, 2).map(([x, z]) => new THREE.Vector3(x, SEA, z)), false, 'centripetal');
    const len = path.getLength();
    let d = o.start * len;
    let dir = 1;
    let wait = 0;
    const tmp = new THREE.Vector3();
    const bow = new THREE.Vector3();
    const last = new THREE.Vector3();
    this.movers.push({
      obj,
      wake,
      update: (dt, time) => {
        let respawn = false;
        if (wait > 0) wait -= dt;
        else if (o.loop) {
          d += o.speed * dt;
          if (d > len) d -= len;
        } else {
          // Ease into and out of the piers.
          const edge = Math.min(d, len - d);
          d += dir * o.speed * THREE.MathUtils.clamp(edge / 3, 0.2, 1) * dt;
          if (d > len || d < 0) {
            d = THREE.MathUtils.clamp(d, 0, len);
            dir = -dir;
            wait = o.dwell ?? 6;
          }
        }
        // An escort keeps station a little behind and to one side of its ship.
        const at = o.lag ? (d - o.lag + len) % len : d;
        const u = THREE.MathUtils.clamp(at / len, 0, 1);
        last.copy(obj.position);
        path.getPointAt(u, obj.position);
        path.getTangentAt(u, tmp);
        if (dir < 0) tmp.negate();
        if (o.side) {
          obj.position.x -= tmp.z * o.side;
          obj.position.z += tmp.x * o.side;
        }
        if (obj.position.distanceToSquared(last) > 4) respawn = true;
        obj.rotation.y = Math.atan2(-tmp.z, tmp.x);
        obj.position.y = SEA + 0.02 + Math.sin(time * 1.1 + o.start * 9) * o.bob;
        obj.rotation.z = Math.sin(time * 0.8 + o.start * 5) * o.bob * 1.6;
        obj.rotation.x = Math.sin(time * 0.6 + o.start * 3) * o.bob;
        if (respawn) wake.reset();
        bow.copy(obj.position).addScaledVector(tmp, o.length / 2);
        wake.update(dt, bow, wait > 0 ? 0 : 1);
      },
    });
  }

  /** A ferry shuttling to and fro along its route. */
  private ferry(route: Pt[], speed: number, start: number, trim: number) {
    const b = ferryBoat(trim);
    const obj = this.built(b);
    const wake = new Wake(0.2, 1.1, 0.5);
    this.object.add(obj, wake.mesh);
    this.sail(obj, wake, route, { speed, start, loop: false, length: 1.36, bob: 0.008 });
  }

  /** A container ship bound for Oakland, in through the Golden Gate, with a tug off her quarter. */
  private ship(route: Pt[], speed: number) {
    const b = containerShip();
    const obj = this.built(b);
    const wake = new Wake(0.5, 1.6, 1.4);
    this.object.add(obj, wake.mesh);
    this.sail(obj, wake, route, { speed, start: 0.35, loop: true, length: 4.6, bob: 0.003 });
    // A tug escorts her in, off her quarter
    const tugObj = this.tug(0xb8352a, 0x1c1c20);
    const tugWake = new Wake(0.1, 0.8, 0.4);
    this.object.add(tugObj, tugWake.mesh);
    this.sail(tugObj, tugWake, route, { speed, start: 0.35, loop: true, length: 0.56, bob: 0.01, lag: 3.4, side: 0.75 });
  }

  private tug(hullColour: number, boot: number): THREE.Object3D {
    const b = tugBoat(hullColour, boot);
    return this.built(b);
  }

  /** A sloop tacking round its loop. */
  private sailboat(cx: number, cz: number, rx: number, rz: number, phase: number, rate: number, r: () => number) {
    const b = sloop(r);
    const obj = this.built(b);
    const wake = new Wake(0.06, 0.7, 0.3);
    this.object.add(obj, wake.mesh);
    let a = phase;
    const bow = new THREE.Vector3();
    this.movers.push({
      obj,
      wake,
      update: (dt, time) => {
        a += rate * dt;
        const x = cx + Math.cos(a) * rx + Math.sin(a * 3) * 0.3;
        const z = cz + Math.sin(a) * rz;
        const dx = -Math.sin(a) * rx * Math.sign(rate);
        const dz = Math.cos(a) * rz * Math.sign(rate);
        const heading = Math.atan2(-dz, dx);
        obj.position.set(x, SEA + 0.02, z);
        // Heel away from the wind and pitch over the chop.
        obj.rotation.set(0.18 + Math.sin(time * 0.7 + phase) * 0.04, heading, Math.sin(time * 1.6 + phase) * 0.03, 'YXZ');
        const l = Math.hypot(dx, dz) || 1;
        bow.set(x + (dx / l) * 0.31, SEA, z + (dz / l) * 0.31);
        wake.update(dt, bow, 0.7);
      },
    });
  }

  /** A tug pottering between the piers and the Ferry Building. */
  private harbourTug(route: Pt[], start: number) {
    const obj = this.tug(0x2f6a4f, 0x1c1c20);
    const wake = new Wake(0.1, 0.8, 0.4);
    this.object.add(obj, wake.mesh);
    this.sail(obj, wake, route, { speed: 0.4, start, loop: false, length: 0.56, bob: 0.01, dwell: 10 });
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
  private airliner(seed: number): { obj: THREE.Object3D; strobe: THREE.MeshBasicMaterial; beacon: THREE.MeshBasicMaterial } {
    const r = rng(seed);
    const livery = pick(r, [0x1f4e9a, 0xc8302a, 0x2a7a6a, 0x5a2a8a] as const);
    const b = new GeoBuilder();
    const L = 2.4;
    // Fuselage: a lathe profile laid along x.
    const prof: [number, number][] = [[0.0, 0], [0.07, 0.03], [0.12, 0.12], [0.14, 0.3], [0.145, 0.6], [0.145, 1.75], [0.13, 2.0], [0.09, 2.25], [0.03, 2.4], [0, 2.4]];
    // Nose (h = 0) forward along +x, tail cone aft.
    const fus = new THREE.LatheGeometry(prof.map(([rr, h]) => new THREE.Vector2(rr, h)), 16).rotateZ(Math.PI / 2).translate(L / 2, 0.42, 0);
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
      // Pylon, flap-track fairings under the wing, and a landing light in the wing root
      b.box(0.16, 0.06, 0.02, 0.06, 0.3, s * 0.42, 0xdcdfe6);
      for (const [fx, fz] of [[-0.18, 0.3], [-0.3, 0.62], [-0.42, 0.9]] as const) b.box(0.14, 0.03, 0.025, fx, 0.29, s * fz, 0xd0d3da);
      b.blob(0.016, 0.24, 0.32, s * 0.2, NAV_WHITE, true);
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
    // The body is batched; the blinking lights ride on its proxy.
    const group = this.built(b);
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
      this.cableCarObjs.push(car);
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

  /**
   * A Powell Street cable car along +x: a closed saloon in the middle with
   * its windows, open ends with outward-facing benches and riders on the
   * running boards, a long clerestory roof with destination boards, and the
   * gripman at the front.
   */
  private cableCar(): THREE.Object3D {
    const b = new GeoBuilder();
    const L = 0.62;
    const red = 0xa8282a;
    const cream = 0xf2e6c4;
    const wood = 0x7a4a2a;
    // Trucks, running boards and the floor
    for (const wx of [-0.2, 0.2]) {
      b.box(0.14, 0.03, 0.16, wx, 0.0, 0, 0x2a2a2e);
      for (const wz of [-0.07, 0.07]) b.cylinder(0.026, 0.026, 0.016, wx, 0.008, wz, 0x1c1c20, 8);
    }
    b.box(L, 0.035, 0.2, 0, 0.03, 0, 0x3a2a22);
    b.box(L - 0.04, 0.012, 0.25, 0, 0.05, 0, wood);
    // The saloon: red panels below, cream above, windows all round
    b.box(0.28, 0.07, 0.2, 0, 0.065, 0, red);
    b.box(0.282, 0.012, 0.202, 0, 0.13, 0, 0xd4af37);
    b.box(0.28, 0.1, 0.2, 0, 0.142, 0, cream);
    b.box(0.284, 0.06, 0.204, 0, 0.158, 0, 0x2c3a48, 'glass');
    for (const s of [1, -1] as const) {
      for (let k = 0; k < 4; k++) b.quad(0.052, 0.05, -0.105 + k * 0.07, 0.188, s * 0.103, s > 0 ? 'z+' : 'z-', CABIN, true, 0.15 + k * 0.17);
      b.quad(0.12, 0.05, s * 0.143, 0.188, 0, s > 0 ? 'x+' : 'x-', CABIN, true, 0.3);
    }
    // Open ends: outward-facing benches, a bulkhead and corner posts
    for (const e of [-1, 1]) {
      const ex = e * 0.225;
      b.box(0.15, 0.02, 0.06, ex, 0.09, 0, wood);
      b.box(0.15, 0.06, 0.02, ex, 0.11, 0, wood);
      b.box(0.15, 0.04, 0.2, ex, 0.065, 0, red);
      for (const pz of [-0.095, 0.095]) for (const px of [0.15, 0.3]) b.box(0.012, 0.17, 0.012, e * px, 0.085, pz, red);
      // Destination board, headlamp or tail lamp, and the bell on the roof
      b.box(0.012, 0.035, 0.12, e * 0.305, 0.27, 0, 0xf8f4ea);
      b.box(0.013, 0.012, 0.1, e * 0.305, 0.272, 0, 0x2a3a6a);
      b.blob(0.016, e * 0.31, 0.1, 0, e > 0 ? NAV_WHITE : [2.6, 0.3, 0.2], true);
    }
    // The roof: a long low arch with a clerestory down the middle
    b.rbox(L + 0.04, 0.03, 0.25, 0, 0.255, 0, cream, 0.012, 'solid');
    b.box(L * 0.55, 0.025, 0.12, 0, 0.283, 0, cream);
    b.box(L * 0.55 + 0.004, 0.012, 0.124, 0, 0.29, 0, 0x2c3a48, 'glass');
    b.cylinder(0.012, 0.016, 0.02, 0.22, 0.285, 0, 0xd4af37, 6);
    // Riders on the running boards and benches, and the gripman at the lever
    const r = rng(3);
    const coats = [0x2f6fa8, 0xe85a4a, 0xf2c84b, 0x3a3a3a, 0x8a5a9a, 0x5a8a4a] as const;
    for (let k = 0; k < 6; k++) {
      const px = (k < 3 ? -1 : 1) * (0.18 + (k % 3) * 0.05);
      const pz = k % 2 ? 0.125 : -0.125;
      b.box(0.028, 0.1, 0.028, px, 0.055, pz, pick(r, coats));
      b.blob(0.017, px, 0.17, pz, pick(r, [0xe0b090, 0xb07850, 0x8a5a3a] as const));
    }
    b.box(0.03, 0.1, 0.03, 0.17, 0.055, 0, 0x2a3a5a);
    b.blob(0.017, 0.17, 0.17, 0, 0xe0b090);
    b.box(0.006, 0.08, 0.006, 0.2, 0.06, 0.02, 0x2a2a2e);
    return this.built(b);
  }

  // ─── Kites, fog, cloud shadows ──────────────────────────────────────────

  private kites(r: () => number) {
    const colours: ColorLike[] = [0xe85a4a, 0xf2c84b, 0x3aa3c8, 0x8a5ad8, 0x5ac46a];
    for (let i = 0; i < 4; i++) {
      // On the Marina Green (or the shore by the Marina, if this city has no green).
      const g = MARINA.green;
      const ax = (g ? g.x - 2.5 : MARINA.x - 1.6) + i * 1.6 + r() * 0.5;
      const az = (g ? g.z - 0.2 : MARINA.z - 2.6) + r() * 0.5;
      const b = new GeoBuilder();
      const diamond = new THREE.Shape([new THREE.Vector2(0, 0.16), new THREE.Vector2(0.09, 0), new THREE.Vector2(0, -0.2), new THREE.Vector2(-0.09, 0)]);
      // Both faces of the sail, so it reads from any side without a double-sided material.
      for (const turn of [0, Math.PI]) b.transformed(new THREE.ShapeGeometry(diamond), new THREE.Matrix4().makeRotationY(turn), colours[i % colours.length]!, 'smooth');
      for (let k = 0; k < 5; k++) b.box(0.03, 0.02, 0.005, Math.sin(k) * 0.02, -0.24 - k * 0.06, 0, colours[(i + 2) % colours.length]!);
      const kite = this.built(b);
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
      const gg = LANDMARKS.goldenGate.x + 34.6;
      const x = tongue ? -44 + gg + r() * 26 : -110 + r() * 68;
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

  /** Whether a cable car is within `r` of (x, z): cars wait for it at junctions. */
  blocks(x: number, z: number, r: number): boolean {
    for (const c of this.cableCarObjs) if (Math.hypot(c.position.x - x, c.position.z - z) < r + 0.3) return true;
    return false;
  }

  /** Adds a model to the batch and returns its proxy: move the proxy, and the batch follows each frame. */
  private built(b: GeoBuilder): THREE.Object3D {
    const key = `life:${this.batched.length}`;
    const obj = this.batch.add(key, b.build(), null);
    this.batched.push({ obj, key });
    return obj;
  }

  update(dt: number, time: number, a: Atmosphere) {
    for (const m of this.movers) m.update(dt, time);
    for (const { obj, key } of this.batched) {
      this.batch.setVisible(key, obj.visible);
      this.batch.touch(key);
    }
    this.batch.update();
    for (const w of this.movers) w.wake?.setLight(a);
    this.gulls.update(dt, time);

    // Fog thickens around dawn and in the evening, and thins at midday.
    const morning = Math.max(0, 1 - Math.abs(a.hour - 7.5) / 3.2);
    const evening = Math.max(0, 1 - Math.abs(a.hour - 19.5) / 3);
    const density = 0.25 + 0.75 * Math.max(morning, evening);
    const tint = this.fogTint.setRGB(...a.fog).lerp(this.white, 0.55 - a.night * 0.4);
    for (const f of this.fog) {
      const x = f.base.x + ((time * f.speed + f.phase) % 30);
      // The tongue through the Gate advances and retreats with the density.
      const reach = f.base.z > 11 && f.base.z < 22 && f.base.x > LANDMARKS.goldenGate.x - 10.4 ? density : 1;
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

// ─── Boats ──────────────────────────────────────────────────────────────────

/**
 * A San Francisco Bay ferry along +x: a white hull with its line's colour at
 * the sheer, two passenger decks of windows, an open sundeck aft, the
 * wheelhouse on top, a pennant at the mast and the ensign at the stern.
 */
export function ferryBoat(trim: number): GeoBuilder {
  const b = new GeoBuilder();
  const L = 1.36;
  hull(b, L, 0.42, 0.16, 0.34, 0xf4f4f0, trim, 0x1f2a36);
  // Rubbing strake
  b.box(L - 0.36, 0.02, 0.436, -0.08, 0.1, 0, 0x2a2e36);
  // Main deck cabin with a window band all round
  const cabin = (x0: number, x1: number, y: number, w: number, h: number) => {
    const cx = (x0 + x1) / 2;
    b.rbox(x1 - x0, h, w, cx, y, 0, 0xf8f8f4, 0.025, 'solid');
    b.box(x1 - x0 + 0.004, h * 0.42, w + 0.004, cx, y + h * 0.36, 0, 0x2c3a48, 'glass');
    const n = Math.round((x1 - x0) / 0.07);
    for (const s of [1, -1] as const) {
      for (let k = 0; k < n; k++) b.quad(0.05, h * 0.36, x0 + (k + 0.5) * ((x1 - x0) / n), y + h * 0.57, s * (w / 2 + 0.004), s > 0 ? 'z+' : 'z-', CABIN, true, 0.1 + ((k * 7) % 9) * 0.09);
    }
    b.box(x1 - x0 + 0.02, 0.015, w + 0.02, cx, y + h, 0, 0xdedcd4);
    b.box(x1 - x0 + 0.024, 0.008, w + 0.024, cx, y + h - 0.004, 0, trim);
  };
  cabin(-0.5, 0.36, 0.14, 0.38, 0.14);
  cabin(-0.3, 0.22, 0.295, 0.32, 0.12);
  // Open sundeck aft: railings and a few benches
  for (const s of [-1, 1]) b.box(0.18, 0.04, 0.008, -0.4, 0.31, s * 0.18, 0xe8e8e2);
  b.box(0.008, 0.04, 0.36, -0.49, 0.31, 0, 0xe8e8e2);
  for (const bx of [-0.44, -0.37]) b.box(0.03, 0.025, 0.24, bx, 0.3, 0, 0x8a5a32);
  // Wheelhouse, with windows all round and a visor
  b.rbox(0.16, 0.08, 0.24, 0.12, 0.42, 0, 0xf8f8f4, 0.02, 'solid');
  b.box(0.164, 0.035, 0.244, 0.12, 0.445, 0, 0x22303c, 'glass');
  b.box(0.2, 0.012, 0.3, 0.13, 0.5, 0, trim);
  // Mast with radar, a pennant and the ensign at the stern
  b.cylinder(0.006, 0.008, 0.2, 0.06, 0.51, 0, 0xdedad0, 4);
  b.box(0.08, 0.008, 0.012, 0.06, 0.62, 0, 0x3a3f48);
  b.box(0.06, 0.03, 0.003, 0.03, 0.66, 0, 0xd8423a);
  b.cylinder(0.004, 0.004, 0.14, -0.62, 0.14, 0, 0xdedad0, 4);
  flag(b, -0.64, 0.25, 0.07);
  // Life rings and the name board
  for (const s of [1, -1]) b.box(0.03, 0.03, 0.006, 0.3, 0.2, s * 0.193, 0xe8622c);
  b.blob(0.02, 0.06, 0.73, 0, NAV_WHITE, true);
  b.blob(0.015, 0.12, 0.47, 0.13, NAV_GREEN, true);
  b.blob(0.015, 0.12, 0.47, -0.13, NAV_RED, true);
  return b;
}

/** A container ship along +x: stacks of boxes, a white superstructure with bridge wings aft, its funnel behind. */
export function containerShip(): GeoBuilder {
  const b = new GeoBuilder();
  const L = 4.6;
  const W = 0.66;
  hull(b, L, W, 0.17, 0.7, 0x24344c, 0xf2f0ea, 0x9a2c24, -0.3, 0x6b4a3a);
  // Forecastle and its breakwater
  b.box(0.42, 0.06, W - 0.06, L / 2 - 0.3, 0.15, 0, 0x8a3a30);
  const bw = new THREE.Shape([new THREE.Vector2(-0.3, 0), new THREE.Vector2(0.3, 0), new THREE.Vector2(0, 0.14)]);
  b.transformed(new THREE.ExtrudeGeometry(bw, { depth: 0.12, bevelEnabled: false }).rotateY(Math.PI / 2).translate(L / 2 - 0.52, 0.15, 0), new THREE.Matrix4(), 0xf2f0ea);
  b.cylinder(0.012, 0.014, 0.32, L / 2 - 0.25, 0.21, 0, 0xf2f0ea, 5);
  // Containers: bays of boxes, row by row, tier by tier, with lashing bridges between
  const r = rng(77);
  const colours = [0x3a7fb8, 0x2f8a6a, 0xc84a3a, 0xe0782c, 0x6a6a72, 0xd8d0c0, 0x8a3a6a, 0x3aa0c8, 0xd8a83a, 0x2a4a7a] as const;
  const bays = 10;
  const bayL = 0.28;
  const x0 = -L / 2 + 1.0;
  for (let i = 0; i < bays; i++) {
    const bx = x0 + i * (bayL + 0.035);
    const tall = 2 + Math.floor(r() * 3) - (i === bays - 1 ? 1 : 0);
    for (let j = 0; j < 4; j++) {
      const h = Math.max(1, tall - (j === 0 || j === 3 ? Math.floor(r() * 2) : 0));
      for (let k = 0; k < h; k++) {
        const c = pick(r, colours);
        b.box(bayL - 0.012, 0.11, 0.142, bx, 0.16 + k * 0.115, -0.225 + j * 0.15, c);
        // The door end, a shade darker
        b.box(0.006, 0.09, 0.12, bx + bayL / 2 - 0.004, 0.17 + k * 0.115, -0.225 + j * 0.15, shade(c, 0.78));
      }
    }
    if (i < bays - 1) b.box(0.012, 0.2, W - 0.08, bx + bayL / 2 + 0.017, 0.16, 0, 0x8a8f98);
  }
  // Superstructure aft: accommodation block, bridge deck with wings, mast and radar
  const sx = -L / 2 + 0.55;
  b.box(0.34, 0.6, W - 0.12, sx, 0.15, 0, 0xf4f2ec);
  b.windows({ w: 0.34, d: W - 0.12, x: sx, z: 0, y0: 0.17, rows: 5, rowHeight: 0.11, cols: 4, faces: ['x+', 'z+', 'z-', 'x-'] }, r, 0.6, CABIN, { w: 0.05, h: 0.04 });
  b.box(0.3, 0.1, W + 0.2, sx + 0.04, 0.74, 0, 0xf4f2ec); // bridge and its wings
  b.box(0.304, 0.045, W - 0.1, sx + 0.04, 0.765, 0, 0x22303c, 'glass');
  for (const s of [-1, 1]) b.box(0.08, 0.045, 0.14, sx + 0.12, 0.765, s * (W / 2 + 0.03), 0x22303c, 'glass');
  b.box(0.34, 0.02, W + 0.24, sx + 0.04, 0.84, 0, 0xd8d4cc);
  b.cylinder(0.008, 0.01, 0.26, sx + 0.02, 0.86, 0, 0xf4f2ec, 4);
  b.box(0.12, 0.01, 0.02, sx + 0.02, 1.02, 0, 0x3a3f48);
  // Funnel: company red with a white band, a black top
  const fx = sx - 0.24;
  b.box(0.2, 0.26, W - 0.24, fx, 0.17, 0, 0xe8e6e0); // engine casing
  b.rbox(0.16, 0.36, 0.2, fx, 0.42, 0, 0xc8402e, 0.03, 'solid');
  b.box(0.165, 0.06, 0.205, fx, 0.6, 0, 0xf2f0ea);
  b.box(0.165, 0.05, 0.205, fx, 0.73, 0, 0x1c1c20);
  // Lights: masthead, bridge wings, stern
  b.blob(0.03, sx + 0.02, 1.14, 0, NAV_WHITE, true);
  b.blob(0.03, L / 2 - 0.25, 0.55, 0, NAV_WHITE, true);
  b.blob(0.022, sx + 0.12, 0.8, W / 2 + 0.1, NAV_GREEN, true);
  b.blob(0.022, sx + 0.12, 0.8, -W / 2 - 0.1, NAV_RED, true);
  return b;
}

/** A harbour tug along +x: a short, beamy hull ringed with fenders, a tall wheelhouse, a banded stack. */
export function tugBoat(hullColour: number, boot: number): GeoBuilder {
  const b = new GeoBuilder();
  const L = 0.56;
  hull(b, L, 0.26, 0.14, 0.18, hullColour, 0xf2f0ea, boot);
  b.box(L - 0.06, 0.03, 0.27, -0.01, 0.1, 0, 0x1c1c20); // fender rail
  b.rbox(0.07, 0.06, 0.18, L / 2 - 0.02, 0.06, 0, 0x1c1c20, 0.03); // bow fender
  b.box(0.22, 0.09, 0.18, 0.0, 0.13, 0, 0xf2f0ea); // deckhouse
  b.box(0.13, 0.08, 0.16, 0.05, 0.22, 0, 0xf2f0ea); // wheelhouse
  b.box(0.134, 0.035, 0.164, 0.05, 0.25, 0, 0x22303c, 'glass');
  for (const sd of [1, -1] as const) b.quad(0.09, 0.025, 0.05, 0.268, sd * 0.0825, sd > 0 ? 'z+' : 'z-', CABIN, true, 0.2);
  b.quad(0.12, 0.025, 0.116, 0.268, 0, 'x+', CABIN, true, 0.3);
  b.box(0.16, 0.012, 0.19, 0.05, 0.3, 0, hullColour);
  b.cylinder(0.025, 0.03, 0.14, -0.06, 0.22, 0, 0x1c1c20, 8);
  b.cylinder(0.031, 0.031, 0.03, -0.06, 0.27, 0, hullColour, 8);
  b.cylinder(0.005, 0.005, 0.12, 0.06, 0.31, 0, 0xdedad0, 4);
  b.box(0.03, 0.03, 0.03, -0.2, 0.1, 0, 0x6a6a72); // towing winch
  b.blob(0.014, 0.06, 0.44, 0, NAV_WHITE, true);
  return b;
}

/** A sloop along +x: a sleek hull, cabin top and cockpit, a tall mast with its boom, mainsail and jib. */
export function sloop(r: () => number): GeoBuilder {
  const b = new GeoBuilder();
  const L = 0.62;
  const colour = pick(r, [0xf8f8f4, 0x1c2a3a, 0xf8f8f4, 0x8a2a24, 0x2f5a7a] as const);
  hull(b, L, 0.18, 0.08, 0.2, colour, 0xf8f8f4, colour === 0xf8f8f4 ? 0x2f5a7a : 0xf8f8f4);
  b.box(L - 0.12, 0.012, 0.15, -0.02, 0.07, 0, 0xc8a878); // teak deck
  b.rbox(0.18, 0.04, 0.11, 0.02, 0.075, 0, 0xf2efe6, 0.015, 'solid'); // cabin top
  b.box(0.12, 0.02, 0.1, -0.17, 0.07, 0, 0x8a6a4a); // cockpit
  // Mast, boom and the sails
  const mx = 0.06;
  b.cylinder(0.006, 0.008, 0.78, mx, 0.08, 0, 0xd8d8d8, 4);
  b.box(0.3, 0.01, 0.01, mx - 0.15, 0.16, 0, 0xd8d8d8);
  const main = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0, 0.66), new THREE.Vector2(-0.05, 0.6), new THREE.Vector2(-0.29, 0.01)]);
  const sailColour = 0xfbfaf6;
  for (const turn of [0, Math.PI]) b.transformed(new THREE.ShapeGeometry(main).rotateY(turn), new THREE.Matrix4().makeTranslation(mx - 0.006, 0.17, 0), sailColour, 'smooth');
  const jibColour = r() < 0.35 ? pick(r, [0xe85a4a, 0x3a7ac8, 0xf2c84b] as const) : 0xf4f0e6;
  const jib = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0, 0.58), new THREE.Vector2(0.24, 0.0)]);
  for (const turn of [0, Math.PI]) b.transformed(new THREE.ShapeGeometry(jib).rotateY(turn), new THREE.Matrix4().makeTranslation(mx + 0.012, 0.1, 0.004), jibColour, 'smooth');
  b.box(0.003, 0.003, 0.003, mx, 0.86, 0, 0xd8d8d8);
  b.blob(0.012, mx, 0.87, 0, NAV_WHITE, true);
  return b;
}

// ─── Boat parts ─────────────────────────────────────────────────────────────

const IDENTITY = new THREE.Matrix4();

/**
 * A hull along +x: rounded at the stern, drawn to a point at the bow, sides
 * from `base` (below the waterline) to the deck at `h`, with a boot-top
 * stripe at the waterline and a sheer stripe along the deck edge.
 */
function hull(b: GeoBuilder, L: number, W: number, h: number, bow: number, colour: ColorLike, sheer: ColorLike, boot: ColorLike, base = -0.06, deck: ColorLike = 0xc9c4b8) {
  const outline = (grow: number) => {
    const hw = W / 2 + grow;
    const x0 = -L / 2 - grow;
    const x1 = L / 2 + grow;
    const s = new THREE.Shape();
    s.moveTo(x0 + hw * 0.4, -hw);
    s.lineTo(x1 - bow, -hw);
    s.quadraticCurveTo(x1 - bow * 0.2, -hw * 0.9, x1, 0);
    s.quadraticCurveTo(x1 - bow * 0.2, hw * 0.9, x1 - bow, hw);
    s.lineTo(x0 + hw * 0.4, hw);
    s.quadraticCurveTo(x0, hw, x0, hw * 0.55);
    s.lineTo(x0, -hw * 0.55);
    s.quadraticCurveTo(x0, -hw, x0 + hw * 0.4, -hw);
    return s;
  };
  // A band round the hull: the outline grown by `grow`, with the hull itself cut out of it.
  const slab = (grow: number, y0: number, y1: number, color: ColorLike, band: boolean) => {
    const shape = outline(grow);
    if (band) shape.holes.push(outline(-0.012));
    const g = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false, curveSegments: 5 });
    g.rotateX(-Math.PI / 2);
    g.translate(0, y0, 0);
    b.transformed(g, IDENTITY, color);
  };
  slab(0, base, h - 0.03, colour, false);
  slab(0.004, -0.012, 0.03, boot, true);
  slab(0.005, h - 0.03, h, sheer, true);
  slab(-0.012, h - 0.03, h - 0.018, deck, false);
}

/** The Stars and Stripes, flying aft from a staff at (x, y). */
function flag(b: GeoBuilder, x: number, y: number, w: number) {
  const h = w * 0.56;
  b.box(w, h, 0.004, x - w / 2, y - h, 0, 0xf4f2ec);
  for (let k = 0; k < 4; k++) b.box(w, h / 7, 0.006, x - w / 2, y - h + k * ((2 * h) / 7), 0, 0xc8302a);
  b.box(w * 0.42, h * 0.54, 0.008, x - w * 0.79, y - h * 0.54, 0, 0x2a3a7a);
}

/** A hex colour a shade darker. */
function shade(c: number, k: number): number {
  return tmpShade.setHex(c).multiplyScalar(k).getHex();
}
const tmpShade = new THREE.Color();

// ─── Wakes ──────────────────────────────────────────────────────────────────

const WAKE_POINTS = 48;

/**
 * A foamy Kelvin wake that spreads and fades behind a moving boat: two
 * bright arms breaking up into flecks, and churned water from the screws
 * down the middle that settles first. It trails from the bow, so the hull
 * sits in its own bow wave.
 */
export class Wake {
  readonly mesh: THREE.Mesh;
  // The trail is a fixed ring of points, newest first: no allocations per frame.
  private xs = new Float32Array(WAKE_POINTS);
  private zs = new Float32Array(WAKE_POINTS);
  private ages = new Float32Array(WAKE_POINTS);
  private seeds = new Float32Array(WAKE_POINTS);
  private n = 0;
  private emitted = 0;
  private every = 0;
  private width: number;
  private life: number;
  private material: THREE.ShaderMaterial;

  constructor(width: number, life: number, wash = 0.5) {
    this.width = width;
    this.life = 6 * life;
    const geo = new THREE.BufferGeometry();
    const count = WAKE_POINTS * 2;
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geo.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(count), 1));
    geo.setAttribute('trail', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    geo.setAttribute('side', new THREE.BufferAttribute(new Float32Array(count).map((_, i) => (i % 2 ? 1 : -1)), 1));
    const idx: number[] = [];
    for (let i = 0; i < WAKE_POINTS - 1; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    geo.setIndex(idx);
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uColor: { value: new THREE.Color(1, 1, 1) }, uWash: { value: wash } },
      vertexShader: /* glsl */ `
        attribute float alpha;
        attribute float side;
        attribute vec2 trail;
        varying float vAlpha;
        varying float vSide;
        varying vec2 vTrail;
        void main() {
          vAlpha = alpha;
          vSide = side;
          vTrail = trail;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uWash;
        varying float vAlpha;
        varying float vSide;
        varying vec2 vTrail;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        void main() {
          float s = abs(vSide);
          // vTrail: x runs along the wake (fixed to the water), y is the age of the water here (0 to 1).
          float n = noise(vec2(vTrail.x * 0.7, vSide * 3.0)) * 0.6 + noise(vec2(vTrail.x * 2.3, vSide * 9.0)) * 0.4;
          float arms = smoothstep(0.45, 0.8, s) * (1.0 - smoothstep(0.88, 1.0, s));
          arms *= 0.35 + 0.65 * smoothstep(0.2 + vTrail.y * 0.45, 0.75, n);
          float wash = (1.0 - smoothstep(0.05, 0.45, s)) * (1.0 - smoothstep(0.0, 0.6, vTrail.y)) * (0.5 + 0.5 * n) * uWash;
          float foam = max(arms, wash);
          gl_FragColor = vec4(uColor, vAlpha * foam);
        }`,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  reset() {
    this.n = 0;
  }

  setLight(a: Atmosphere) {
    this.material.uniforms.uColor!.value.setRGB(1, 1, 1).multiplyScalar(0.35 + 0.65 * (1 - a.night));
  }

  update(dt: number, at: THREE.Vector3, moving: number) {
    const { xs, zs, ages, seeds } = this;
    for (let i = 0; i < this.n; i++) ages[i]! += dt;
    while (this.n > 0 && ages[this.n - 1]! > this.life) this.n--;
    this.every -= dt;
    if (this.every <= 0 && moving > 0) {
      this.every = this.life / WAKE_POINTS;
      xs.copyWithin(1, 0, WAKE_POINTS - 1);
      zs.copyWithin(1, 0, WAKE_POINTS - 1);
      ages.copyWithin(1, 0, WAKE_POINTS - 1);
      seeds.copyWithin(1, 0, WAKE_POINTS - 1);
      xs[0] = at.x;
      zs[0] = at.z;
      ages[0] = 0;
      seeds[0] = ++this.emitted;
      this.n = Math.min(WAKE_POINTS, this.n + 1);
    }
    const geo = this.mesh.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const alpha = geo.attributes.alpha as THREE.BufferAttribute;
    const trail = geo.attributes.trail as THREE.BufferAttribute;
    const n = this.n;
    const y = SEA + 0.015;
    for (let i = 0; i < WAKE_POINTS; i++) {
      if (i >= n) {
        alpha.setX(i * 2, 0);
        alpha.setX(i * 2 + 1, 0);
        continue;
      }
      const px = i === 0 ? at.x : xs[i]!;
      const pz = i === 0 ? at.z : zs[i]!;
      const j = Math.min(n - 1, i + 1);
      let dx = px - xs[j]!;
      let dz = pz - zs[j]!;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      const age = ages[i]! / this.life;
      // The V opens fast behind the bow, then keeps spreading as it fades.
      const w = this.width * (0.25 + Math.sqrt(age) * 2.1 + age * 1.5);
      pos.setXYZ(i * 2, px - dz * w, y, pz + dx * w);
      pos.setXYZ(i * 2 + 1, px + dz * w, y, pz - dx * w);
      const a = Math.max(0, 1 - age) ** 1.3 * 0.95 * moving * Math.min(1, i / 1.5);
      alpha.setX(i * 2, a);
      alpha.setX(i * 2 + 1, a);
      const along = i === 0 ? this.emitted + 1 : seeds[i]!;
      trail.setXY(i * 2, along, age);
      trail.setXY(i * 2 + 1, along, age);
    }
    pos.needsUpdate = true;
    alpha.needsUpdate = true;
    trail.needsUpdate = true;
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
      [(PIER.x0 + PIER.x1) / 2, PIER.z0 + 5.4, 10],
      [12.4, -1.2, 6],
      [MARINA.x + 0.9, MARINA.z + 0.3, 6],
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
    // Grey-white wings with black tips, like a western gull's.
    const tipped = (g: THREE.BufferGeometry) => {
      const pos = g.attributes.position!;
      const col = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) col.set(Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i)) > 0.1 ? [0.16, 0.17, 0.19] : [0.86, 0.88, 0.9], i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      return g;
    };
    const wingMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide });
    this.wings = [new THREE.InstancedMesh(tipped(wing(1)), wingMat, this.birds.length), new THREE.InstancedMesh(tipped(wing(-1)), wingMat, this.birds.length)];
    for (const m of [this.body, ...this.wings]) {
      m.frustumCulled = false;
      m.castShadow = true;
      this.object.add(m);
    }
  }

  update(_dt: number, time: number) {
    for (let i = 0; i < this.birds.length; i++) {
      const b = this.birds[i]!;
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
      for (let k = 0; k < 2; k++) {
        const w = this.wings[k]!;
        const side = k === 0 ? -1 : 1;
        this.e.set(bank + side * flap, heading, 0, 'YXZ');
        this.q.setFromEuler(this.e);
        this.m.compose(this.p, this.q, this.s);
        w.setMatrixAt(i, this.m);
      }
    }
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
