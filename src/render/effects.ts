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

// ─── Elevated train: loops the town; its speed tracks shipping velocity ───

export class Train {
  readonly object = new THREE.Group();
  private curve: THREE.CatmullRomCurve3;
  private cars: THREE.Group[] = [];
  private t = 0;
  speed = 0.02;
  private boost = 0;

  constructor(half: number, height = 1.1) {
    const c = half;
    const k = 1.6; // corner rounding
    const pts: THREE.Vector3[] = [];
    for (const [x, z] of [[c, c - k], [c, -c + k], [c - k, -c], [-c + k, -c], [-c, -c + k], [-c, c - k], [-c + k, c], [c - k, c]] as const) {
      pts.push(new THREE.Vector3(x, height, z));
    }
    this.curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');

    // Track: a beam on pillars
    const beam = new THREE.TubeGeometry(this.curve, 240, 0.09, 4, true);
    const track = new THREE.Mesh(beam, new THREE.MeshStandardMaterial({ color: 0xc9c6bd, roughness: 0.6, flatShading: true }));
    track.castShadow = true;
    track.position.y = -0.06;
    this.object.add(track);
    const pillars = new GeoBuilder();
    const length = this.curve.getLength();
    for (let d = 0; d < length; d += 2.4) {
      const p = this.curve.getPointAt(d / length);
      pillars.box(0.12, height - 0.12, 0.12, p.x, 0, p.z, 0xb9b5ab);
    }
    this.object.add(pillars.build().group);

    for (let i = 0; i < 4; i++) this.cars.push(this.car(i === 0));
    this.object.add(...this.cars);
  }

  private car(lead: boolean): THREE.Group {
    const b = new GeoBuilder();
    b.box(0.9, 0.26, 0.3, 0, 0.02, 0, 0xf6f4ee);
    b.box(0.92, 0.04, 0.32, 0, 0.0, 0, 0x3a3d48);
    b.box(0.91, 0.05, 0.31, 0, 0.05, 0, 0xd8402e);
    b.box(0.9, 0.03, 0.31, 0, 0.26, 0, 0xd8402e);
    for (const side of [1, -1]) {
      for (let w = 0; w < 4; w++) b.quad(0.14, 0.08, -0.33 + w * 0.22, 0.12, side * 0.155, side > 0 ? 'z+' : 'z-', PALETTE.windowWarm);
    }
    if (lead) b.quad(0.18, 0.06, 0.455, 0.1, 0, 'x+', [3, 3, 2.6]);
    const { group } = b.build();
    group.traverse((o) => (o.castShadow = true));
    return group;
  }

  /** A deploy just happened: the train sprints a lap. */
  pulse() {
    this.boost = 2.5;
  }

  update(dt: number) {
    this.boost = Math.max(0, this.boost - dt);
    this.t = (this.t + dt * this.speed * (1 + this.boost * 1.5)) % 1;
    const len = this.curve.getLength();
    this.cars.forEach((car, i) => {
      const u = (this.t - (i * 0.98) / len + 1) % 1;
      const p = this.curve.getPointAt(u);
      const ahead = this.curve.getPointAt((u + 0.002) % 1);
      car.position.copy(p);
      car.rotation.y = Math.atan2(-(ahead.z - p.z), ahead.x - p.x);
    });
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
    const light = new THREE.BoxGeometry(0.02, 0.035, 0.14);
    this.heads = new THREE.InstancedMesh(light.clone().translate(0.171, 0.11, 0), glowMaterial({ color: new THREE.Color(3, 2.8, 2.2) }), max);
    this.tails = new THREE.InstancedMesh(light.translate(-0.171, 0.11, 0), glowMaterial({ color: new THREE.Color(2.6, 0.2, 0.15) }), max);
    for (let i = 0; i < max; i++) this.bodies.setColorAt(i, new THREE.Color(CAR_COLOURS[i % CAR_COLOURS.length]!));
    for (const m of [this.bodies, this.heads, this.tails]) {
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
      this.bodies.setMatrixAt(i, this.dummy.matrix);
      this.heads.setMatrixAt(i, this.dummy.matrix);
      this.tails.setMatrixAt(i, this.dummy.matrix);
    });
    for (const m of [this.bodies, this.heads, this.tails]) {
      m.count = this.cars.length;
      m.instanceMatrix.needsUpdate = true;
    }
  }
}
