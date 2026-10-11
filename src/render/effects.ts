import * as THREE from 'three';
import { GeoBuilder, glowMaterial } from './geo.ts';
import { PALETTE } from './palette.ts';
import { bright } from './buildings.ts';
import { rng } from '../world/rng.ts';

// ─── Rain ─────────────────────────────────────────────────────────────────

export class Rain {
  readonly object: THREE.LineSegments;
  private positions: Float32Array;
  private speeds: Float32Array;
  private material: THREE.LineBasicMaterial;
  /** 0 = clear, 1 = full downpour; eased toward `target`. */
  intensity = 0;
  target = 0;
  private extent: number;

  constructor(extent = 24, count = 2200) {
    this.extent = extent;
    const r = rng(99);
    this.positions = new Float32Array(count * 6);
    this.speeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      this.reset(i, r() * 22, r);
      this.speeds[i] = 16 + r() * 8;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.material = new THREE.LineBasicMaterial({ color: 0x9fb8e8, transparent: true, opacity: 0, depthWrite: false });
    this.object = new THREE.LineSegments(geo, this.material);
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  private reset(i: number, y: number, r: () => number = Math.random) {
    const x = (r() - 0.5) * this.extent * 2;
    const z = (r() - 0.5) * this.extent * 2;
    this.positions.set([x, y, z, x - 0.04, y + 0.45, z - 0.04], i * 6);
  }

  update(dt: number) {
    this.intensity += (this.target - this.intensity) * Math.min(1, dt * 1.2);
    this.object.visible = this.intensity > 0.01;
    if (!this.object.visible) return;
    this.material.opacity = 0.55 * this.intensity;
    for (let i = 0; i < this.speeds.length; i++) {
      const dy = this.speeds[i]! * dt;
      const o = i * 6;
      this.positions[o + 1]! -= dy;
      this.positions[o + 4]! -= dy;
      if (this.positions[o + 1]! < 0) this.reset(i, 18 + Math.random() * 4);
    }
    this.object.geometry.attributes.position!.needsUpdate = true;
  }
}

// ─── Fireworks ────────────────────────────────────────────────────────────

const FIREWORK_COLOURS = [0xff4fd8, 0x4ff2ff, 0xffd23f, 0x7dff8a, 0xff7a3f, 0xb48cff];

interface Burst {
  points: THREE.Points;
  velocities: Float32Array;
  age: number;
  life: number;
  rocket: THREE.Vector3 | null;
  apex: number;
}

export class Fireworks {
  readonly object = new THREE.Group();
  private bursts: Burst[] = [];
  private queue: { delay: number; at: THREE.Vector3; colour: number }[] = [];

  /** Launches `count` rockets around a point, staggered. */
  launch(at: THREE.Vector3, count = 3, spread = 1.5) {
    for (let i = 0; i < count; i++) {
      const p = at.clone().add(new THREE.Vector3((Math.random() - 0.5) * spread, 0, (Math.random() - 0.5) * spread));
      const colour = FIREWORK_COLOURS[Math.floor(Math.random() * FIREWORK_COLOURS.length)]!;
      this.queue.push({ delay: i * 0.35 + Math.random() * 0.2, at: p, colour });
    }
  }

  private spawn(at: THREE.Vector3, colour: number) {
    const n = 90;
    const positions = new Float32Array(n * 3);
    const velocities = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      positions.set([at.x, at.y, at.z], i * 3);
      // Uniform-ish sphere
      const u = Math.random() * 2 - 1;
      const t = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const speed = 2.2 + Math.random() * 0.6;
      velocities.set([s * Math.cos(t) * speed, u * speed, s * Math.sin(t) * speed], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: new THREE.Color(...bright(colour, 3)),
      size: 3.2 * Math.min(2, window.devicePixelRatio),
      sizeAttenuation: false,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const points = new THREE.Points(geo, material);
    points.frustumCulled = false;
    this.object.add(points);
    const apex = at.y + 4 + Math.random() * 2;
    this.bursts.push({ points, velocities, age: 0, life: 1.8, rocket: at.clone(), apex });
  }

  update(dt: number) {
    for (const q of this.queue) q.delay -= dt;
    for (const q of this.queue.filter((q) => q.delay <= 0)) this.spawn(q.at, q.colour);
    this.queue = this.queue.filter((q) => q.delay > 0);

    for (const b of this.bursts) {
      const pos = b.points.geometry.attributes.position as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      const mat = b.points.material as THREE.PointsMaterial;
      if (b.rocket) {
        // Rising trail: all particles travel together until the apex.
        b.rocket.y += dt * 9;
        for (let i = 0; i < arr.length; i += 3) arr.set([b.rocket.x, b.rocket.y, b.rocket.z], i);
        mat.size = 2.5;
        if (b.rocket.y >= b.apex) b.rocket = null;
      } else {
        b.age += dt;
        for (let i = 0; i < arr.length; i += 3) {
          b.velocities[i + 1]! -= 2.6 * dt;
          b.velocities[i]! *= 1 - dt * 0.9;
          b.velocities[i + 1]! *= 1 - dt * 0.9;
          b.velocities[i + 2]! *= 1 - dt * 0.9;
          arr[i]! += b.velocities[i]! * dt;
          arr[i + 1]! += b.velocities[i + 1]! * dt;
          arr[i + 2]! += b.velocities[i + 2]! * dt;
        }
        mat.opacity = Math.max(0, 1 - b.age / b.life);
        mat.size = 3.2 * Math.min(2, window.devicePixelRatio);
      }
      pos.needsUpdate = true;
    }
    for (const b of this.bursts.filter((b) => b.age >= b.life)) {
      this.object.remove(b.points);
      b.points.geometry.dispose();
      (b.points.material as THREE.Material).dispose();
    }
    this.bursts = this.bursts.filter((b) => b.age < b.life);
  }
}

// ─── The F-line: vintage streetcars; their speed tracks shipping velocity ──

const LIVERIES: [number, number][] = [
  [0x2f6a4f, 0xefe6cc], // Muni green and cream
  [0xe0742c, 0xf3ead2], // Milan orange
  [0xf2c84b, 0xf8f5ee], // Philadelphia yellow
  [0x7a2f3a, 0xeadfc4], // maroon
];

/** Resample a polyline into evenly spaced points so a spline through it stays straight on the straights. */
export function densify(path: readonly (readonly [number, number])[], step: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const [ax, az] = path[i]!;
    const [bx, bz] = path[i + 1]!;
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / step));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  out.push([...path.at(-1)!]);
  return out;
}

export class Train {
  readonly object = new THREE.Group();
  private curve: THREE.CatmullRomCurve3;
  private length: number;
  private cars: { group: THREE.Group; d: number; dir: 1 | -1; wait: number }[] = [];
  /** Share of the line per second (kept for the old loop's units). */
  speed = 0.02;
  private boost = 0;

  constructor(path: readonly (readonly [number, number])[], height: (x: number, z: number) => number = () => 0) {
    const pts = densify(path, 1).map(([x, z]) => new THREE.Vector3(x, height(x, z), z));
    this.curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    this.length = this.curve.getLength();
    LIVERIES.slice(0, 3).forEach(([body, band], i) => {
      const group = this.car(body, band);
      this.cars.push({ group, d: (this.length * (i + 0.3)) / 3, dir: i % 2 ? -1 : 1, wait: 0 });
      this.object.add(group);
    });
  }

  /** A PCC streetcar: rounded ends, two-tone livery, trolley pole, along +x. */
  private car(body: number, band: number): THREE.Group {
    const b = new GeoBuilder();
    const L = 0.86;
    const W = 0.24;
    b.rbox(L, 0.12, W, 0, 0.05, 0, body, 0.05);
    b.rbox(L - 0.01, 0.13, W - 0.01, 0, 0.16, 0, band, 0.05);
    b.rbox(L - 0.06, 0.04, W - 0.04, 0, 0.29, 0, 0xd8d3c6, 0.02);
    b.box(L + 0.004, 0.012, W + 0.004, 0, 0.17, 0, body);
    for (const side of [1, -1] as const) {
      for (let w = 0; w < 7; w++) b.quad(0.085, 0.07, -0.3 + w * 0.1, 0.215, side * (W / 2 + 0.002), side > 0 ? 'z+' : 'z-', PALETTE.windowWarm, true, 0.15 + w * 0.1);
    }
    for (const end of [1, -1] as const) {
      b.quad(0.14, 0.07, end * (L / 2 + 0.002), 0.215, 0, end > 0 ? 'x+' : 'x-', [0.5, 0.65, 0.8], true, 0.3);
      b.blob(0.018, end * (L / 2 + 0.005), 0.1, 0, end > 0 ? [3, 2.8, 2.2] : [2.6, 0.25, 0.15], true);
      for (const s of [-1, 1]) b.cylinder(0.035, 0.035, 0.02, end * 0.27, 0.02, s * 0.09, 0x2a2a2e, 8, false);
    }
    b.cylinder(0.006, 0.006, 0.36, 0, 0, 0, 0x2a2a2e, 4);
    const pole = new THREE.CylinderGeometry(0.006, 0.006, 0.42, 4).rotateZ(-1.05).translate(-0.18, 0.43, 0);
    b.transformed(pole, new THREE.Matrix4(), 0x2a2a2e);
    const { group } = b.build();
    group.traverse((o) => {
      o.castShadow = true;
      o.receiveShadow = true;
    });
    return group;
  }

  /** A deploy just happened: the streetcars hurry. */
  pulse() {
    this.boost = 2.5;
  }

  update(dt: number) {
    this.boost = Math.max(0, this.boost - dt);
    const v = this.speed * 40 * (1 + this.boost * 1.5);
    for (const car of this.cars) {
      if (car.wait > 0) {
        car.wait -= dt;
      } else {
        car.d += car.dir * v * dt;
        if (car.d >= this.length || car.d <= 0) {
          // End of the line: a short layover, then back the other way.
          car.d = THREE.MathUtils.clamp(car.d, 0, this.length);
          car.dir = car.dir > 0 ? -1 : 1;
          car.wait = 2.5;
        }
      }
      const u = car.d / this.length;
      const p = this.curve.getPointAt(u);
      const t = this.curve.getTangentAt(u);
      if (car.dir < 0) t.negate();
      // Keep right: each direction has its own track.
      car.group.position.set(p.x + t.z * 0.36, p.y + 0.02, p.z - t.x * 0.36);
      car.group.rotation.y = Math.atan2(-t.z, t.x);
    }
  }
}

// ─── Traffic: little cars on the developed roads ──────────────────────────

/** A straight, contiguous stretch of road a car can drive along. */
export interface Run {
  axis: 'x' | 'z';
  /** Fixed coordinate of the road's centre line. */
  line: number;
  from: number;
  to: number;
}

interface Car {
  run: Run;
  pos: number;
  dir: 1 | -1;
  speed: number;
}

const CAR_COLOURS = [0xf4f2ee, 0xd84a4a, 0x3a7ad8, 0xf2c94c, 0x2f3542, 0x6fcf97, 0xf28a3a, 0xc9ced6];

export class Traffic {
  readonly object = new THREE.Group();
  private bodies: THREE.InstancedMesh;
  /** Low, wide sports cars: their share grows with the city's wealth. */
  private sports: THREE.InstancedMesh;
  private luxury = 0;
  private heads: THREE.InstancedMesh;
  private tails: THREE.InstancedMesh;
  private cars: Car[] = [];
  private runs: Run[] = [];
  private dummy = new THREE.Object3D();
  private max: number;

  constructor(max = 60) {
    this.max = max;
    const body = new THREE.BoxGeometry(0.34, 0.12, 0.18);
    body.translate(0, 0.1, 0);
    this.bodies = new THREE.InstancedMesh(body, new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.3 }), max);
    this.bodies.castShadow = true;
    const sport = new THREE.BoxGeometry(0.4, 0.08, 0.2);
    sport.translate(0, 0.07, 0);
    this.sports = new THREE.InstancedMesh(sport, new THREE.MeshStandardMaterial({ roughness: 0.25, metalness: 0.5 }), max);
    this.sports.castShadow = true;
    const SPORT_COLOURS = [0xd8402e, 0xf2c84b, 0x1c1c24, 0xf4f4f0, 0x2f6fa8];
    for (let i = 0; i < max; i++) this.sports.setColorAt(i, new THREE.Color(SPORT_COLOURS[i % SPORT_COLOURS.length]!));
    const light = new THREE.BoxGeometry(0.02, 0.035, 0.14);
    this.heads = new THREE.InstancedMesh(light.clone().translate(0.171, 0.11, 0), glowMaterial({ color: new THREE.Color(3, 2.8, 2.2) }), max);
    this.tails = new THREE.InstancedMesh(light.translate(-0.171, 0.11, 0), glowMaterial({ color: new THREE.Color(2.6, 0.2, 0.15) }), max);
    for (let i = 0; i < max; i++) this.bodies.setColorAt(i, new THREE.Color(CAR_COLOURS[i % CAR_COLOURS.length]!));
    for (const m of [this.bodies, this.sports, this.heads, this.tails]) {
      m.count = 0;
      m.frustumCulled = false;
      this.object.add(m);
    }
  }

  setRoads(runs: Run[]) {
    this.runs = runs.filter((r) => r.to - r.from >= 2);
    for (const car of this.cars) {
      if (!this.runs.includes(car.run)) this.place(car);
    }
  }

  /** Share of cars (0–1) that are sports cars. */
  setLuxury(share: number) {
    this.luxury = Math.min(1, Math.max(0, share));
  }

  setCount(n: number) {
    n = Math.min(this.max, this.runs.length ? n : 0);
    while (this.cars.length < n) {
      const car = { run: this.runs[0]!, pos: 0, dir: 1 as const, speed: 1 };
      this.place(car);
      this.cars.push(car);
    }
    this.cars.length = n;
  }

  private place(car: Car) {
    const run = this.runs[Math.floor(Math.random() * this.runs.length)];
    if (!run) return;
    car.run = run;
    car.dir = Math.random() < 0.5 ? 1 : -1;
    car.pos = run.from + Math.random() * (run.to - run.from);
    car.speed = 1.1 + Math.random() * 0.8;
  }

  update(dt: number) {
    const regular = this.cars.length - Math.round(this.cars.length * this.luxury);
    this.cars.forEach((car, i) => {
      car.pos += car.dir * car.speed * dt;
      if (car.pos > car.run.to || car.pos < car.run.from) {
        this.place(car);
      }
      const lane = car.dir * 0.2;
      const [x, z] = car.run.axis === 'x' ? [car.pos, car.run.line + lane] : [car.run.line - lane, car.pos];
      this.dummy.position.set(x, 0, z);
      this.dummy.rotation.y = car.run.axis === 'x' ? (car.dir > 0 ? 0 : Math.PI) : car.dir > 0 ? -Math.PI / 2 : Math.PI / 2;
      this.dummy.updateMatrix();
      // The last `sporty` cars are sports cars; the rest are everyday cars.
      if (i >= regular) this.sports.setMatrixAt(i - regular, this.dummy.matrix);
      else this.bodies.setMatrixAt(i, this.dummy.matrix);
      this.heads.setMatrixAt(i, this.dummy.matrix);
      this.tails.setMatrixAt(i, this.dummy.matrix);
    });
    this.bodies.count = regular;
    this.sports.count = this.cars.length - regular;
    for (const m of [this.bodies, this.sports, this.heads, this.tails]) {
      if (m !== this.bodies && m !== this.sports) m.count = this.cars.length;
      m.instanceMatrix.needsUpdate = true;
    }
  }
}
