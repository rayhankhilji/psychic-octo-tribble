import * as THREE from 'three';
import { GeoBuilder } from './geo.ts';
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

const FIREWORK_COLOURS = [0xff4fd8, 0x4ff2ff, 0xffd23f, 0x7dff8a, 0xff7a3f, 0xb48cff, 0xfff4e0];
const SPARKS = 160;

type Shape = 'peony' | 'ring' | 'palm' | 'willow';

interface Burst {
  points: THREE.Points;
  velocities: Float32Array;
  age: number;
  life: number;
  rocket: THREE.Vector3 | null;
  apex: number;
  drag: number;
  gravity: number;
  trail: number;
}

/**
 * Celebration fireworks: a rocket climbs with a sparkling trail and bursts
 * into a peony, a ring, a palm or a willow, sometimes in two colours, with
 * a crackle as the sparks die.
 */
export class Fireworks {
  readonly object = new THREE.Group();
  private bursts: Burst[] = [];
  private queue: { delay: number; at: THREE.Vector3; colour: number }[] = [];
  private material: THREE.ShaderMaterial;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uScale: { value: Math.min(2, window.devicePixelRatio) } },
      vertexShader: /* glsl */ `
        attribute vec3 tint;
        attribute float alpha;
        attribute float size;
        uniform float uScale;
        varying vec3 vTint;
        varying float vAlpha;
        void main() {
          vTint = tint;
          vAlpha = alpha;
          gl_PointSize = size * uScale;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vTint;
        varying float vAlpha;
        void main() {
          vec2 p = gl_PointCoord - 0.5;
          float d = length(p);
          float core = smoothstep(0.5, 0.0, d);
          gl_FragColor = vec4(vTint * (core * 1.4 + 0.2), vAlpha * core);
        }`,
    });
  }

  /** Launches `count` rockets around a point, staggered. */
  launch(at: THREE.Vector3, count = 3, spread = 1.5) {
    for (let i = 0; i < count; i++) {
      const p = at.clone().add(new THREE.Vector3((Math.random() - 0.5) * spread, 0, (Math.random() - 0.5) * spread));
      const colour = FIREWORK_COLOURS[Math.floor(Math.random() * FIREWORK_COLOURS.length)]!;
      this.queue.push({ delay: i * 0.35 + Math.random() * 0.2, at: p, colour });
    }
  }

  private spawn(at: THREE.Vector3, colour: number) {
    const shapes: Shape[] = ['peony', 'peony', 'ring', 'palm', 'willow'];
    const shape = shapes[Math.floor(Math.random() * shapes.length)]!;
    const second = Math.random() < 0.4 ? FIREWORK_COLOURS[Math.floor(Math.random() * FIREWORK_COLOURS.length)]! : colour;
    const positions = new Float32Array(SPARKS * 3);
    const velocities = new Float32Array(SPARKS * 3);
    const tints = new Float32Array(SPARKS * 3);
    const alphas = new Float32Array(SPARKS).fill(1);
    const sizes = new Float32Array(SPARKS);
    const a = new THREE.Color(...bright(colour, 2.6));
    const b = new THREE.Color(...bright(second, 2.6));
    const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 1.2 - 0.6, Math.random() * Math.PI, Math.random() * 1.2 - 0.6));
    const v = new THREE.Vector3();
    for (let i = 0; i < SPARKS; i++) {
      positions.set([at.x, at.y, at.z], i * 3);
      const u = Math.random() * 2 - 1;
      const t = Math.random() * Math.PI * 2;
      const sq = Math.sqrt(1 - u * u);
      if (shape === 'ring') {
        v.set(Math.cos(t), 0, Math.sin(t)).multiplyScalar(2.6).applyQuaternion(tilt);
      } else if (shape === 'palm') {
        // A few thick fronds that droop.
        const frond = Math.floor(Math.random() * 7);
        const fa = (frond / 7) * Math.PI * 2;
        v.set(Math.cos(fa) * 0.8, 0.9 + Math.random() * 0.25, Math.sin(fa) * 0.8).multiplyScalar(2.2 * (0.6 + Math.random() * 0.4));
      } else {
        v.set(sq * Math.cos(t), u, sq * Math.sin(t)).multiplyScalar((shape === 'willow' ? 1.8 : 2.4) * (0.85 + Math.random() * 0.2));
      }
      velocities.set([v.x, v.y, v.z], i * 3);
      const c = i % 2 ? a : b;
      tints.set([c.r, c.g, c.b], i * 3);
      sizes[i] = 2.4 + Math.random() * 1.6;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('tint', new THREE.BufferAttribute(tints, 3));
    geo.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));
    geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    const points = new THREE.Points(geo, this.material);
    points.frustumCulled = false;
    this.object.add(points);
    const apex = at.y + 4 + Math.random() * 2;
    const willow = shape === 'willow';
    this.bursts.push({ points, velocities, age: 0, life: willow ? 2.8 : shape === 'palm' ? 2.2 : 1.8, rocket: at.clone(), apex, drag: willow ? 1.6 : 0.9, gravity: willow ? 1.2 : 2.6, trail: 0 });
  }

  update(dt: number) {
    for (const q of this.queue) q.delay -= dt;
    for (const q of this.queue.filter((q) => q.delay <= 0)) this.spawn(q.at, q.colour);
    this.queue = this.queue.filter((q) => q.delay > 0);

    for (const b of this.bursts) {
      const geo = b.points.geometry;
      const pos = geo.attributes.position as THREE.BufferAttribute;
      const alpha = geo.attributes.alpha as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      if (b.rocket) {
        // The climb: the head is spark 0; the rest trail below it, flickering.
        b.rocket.y += dt * 9;
        b.trail += dt;
        for (let i = 0; i < SPARKS; i++) {
          const k = Math.min(1, (i / SPARKS) * 3);
          arr[i * 3] = b.rocket.x + (Math.random() - 0.5) * 0.05 * k;
          arr[i * 3 + 1] = b.rocket.y - k * Math.min(1.6, b.trail * 9);
          arr[i * 3 + 2] = b.rocket.z + (Math.random() - 0.5) * 0.05 * k;
          alpha.setX(i, i === 0 ? 1 : (1 - k) * 0.6 * (Math.random() < 0.6 ? 1 : 0.2));
        }
        if (b.rocket.y >= b.apex) {
          for (let i = 0; i < SPARKS; i++) arr.set([b.rocket.x, b.rocket.y, b.rocket.z], i * 3);
          b.rocket = null;
        }
      } else {
        b.age += dt;
        const k = b.age / b.life;
        const drag = 1 - dt * b.drag;
        for (let i = 0; i < arr.length; i += 3) {
          b.velocities[i + 1]! -= b.gravity * dt;
          b.velocities[i]! *= drag;
          b.velocities[i + 1]! *= drag;
          b.velocities[i + 2]! *= drag;
          arr[i]! += b.velocities[i]! * dt;
          arr[i + 1]! += b.velocities[i + 1]! * dt;
          arr[i + 2]! += b.velocities[i + 2]! * dt;
          // Fade out, crackling (random twinkle) toward the end.
          const crackle = k > 0.6 && Math.random() < 0.35 ? 0.15 : 1;
          alpha.setX(i / 3, Math.max(0, 1 - k * k) * crackle);
        }
      }
      pos.needsUpdate = true;
      alpha.needsUpdate = true;
    }
    for (const b of this.bursts.filter((b) => b.age >= b.life)) {
      this.object.remove(b.points);
      b.points.geometry.dispose();
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

  /** Whether a running streetcar is within `r` of (x, z): cars wait for it at junctions. */
  blocks(x: number, z: number, r: number): boolean {
    // A suspended line's parked cars don't hold up traffic forever.
    if (this.speed <= 0) return false;
    for (const c of this.cars) if (Math.hypot(c.group.position.x - x, c.group.position.z - z) < r + 0.45) return true;
    return false;
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
