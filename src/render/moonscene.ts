import * as THREE from 'three';
import { GeoBuilder, glassMaterial, type ColorLike } from './geo.ts';
import { rocket } from './models.ts';
import { Exhaust } from './exhaust.ts';
import { BRAND, drawMark } from '../ui/brand.ts';
import { rng } from '../world/rng.ts';
import { ROCKET_IGNITION, ROCKET_LANDING, type City } from './city.ts';
import type { Cinematic, Shot, Stage } from './stage.ts';
import { prefersReducedMotion } from '../ui/dom.ts';

/**
 * The founder's house on the moon: a little lunar set, built the first time
 * someone flies there. A pressurised glass dome and a long white wing on
 * legs, an airlock with a porch light, solar wings turned to the sun, a
 * mast with its dish on the Earth, a rover parked by the deck, a landing
 * pad, a flag with the TinyTown mark and a sign with the city's name. The
 * sun is low, so every rock throws a long hard shadow; the Earth hangs in
 * the black sky with the bay on its terminator, lights just coming on.
 *
 * `update(dt, m)` poses everything for `m` seconds into the visit: the
 * rocket lands, the camera takes a slow walk around the house to the warm
 * windows, then the rocket lifts off for home. Units match the city (the
 * rocket is the same model, at the same size).
 */

/** Seconds into the visit when the rocket touches down. */
export const MOON_TOUCHDOWN = 4.4;
/** Seconds into the visit when the engines light for home. */
export const MOON_IGNITION = 12.9;
/** The visit's length; the picture fades out over its last second. */
export const MOON_END = 16.2;
/** The cut from the close-up at the windows to the wide shot of the lift-off. */
const MOON_CUT = 12.3;

/** Moon units: the ground curves away over a 120-unit radius, so the horizon is close and round. */
const CURVE = 120;
const EXTENT = 48;
/** Towards the sun: low in the west-south-west, so shadows run long across the ground. */
const SUN = new THREE.Vector3(-0.85, 0.27, -0.45).normalize();
/** Towards the Earth: north, 11° up, low enough to share the frame with the house. */
const EARTH = new THREE.Vector3(0.15, 0.2, 0.97).normalize();
const EARTH_DISTANCE = 230;
const EARTH_RADIUS = 13.5;
/** The landing pad, east of the house. */
const PAD = new THREE.Vector2(3.9, -1.5);
/** The radio mast, behind the wing's far end, clear of the Earth all along the camera's walk. */
const MAST = new THREE.Vector2(-2.85, 1.2);
/** Things that stand on the ground, kept clear of craters and boulders. */
const KEEP_CLEAR: readonly [number, number, number][] = [[PAD.x, PAD.y, 1.6], [MAST.x, MAST.y, 0.6], [-2.3, -2.05, 0.8], [-3.5, 0.1, 0.9], [-3.75, 1.75, 0.6], [-2.35, 2.45, 0.6], [2.35, -3.0, 0.5], [-0.7, -2.85, 0.7]];

const WARM: readonly [number, number, number] = [2.3, 1.36, 0.6];
const WARM_SOFT: readonly [number, number, number] = [1.55, 0.92, 0.44];
const WHITE = 0xe9e4da;
const CREAM = 0xd9d0bf;
const SEAM = 0x9d978c;
const DARK = 0x3a3d44;
const STEEL = 0x8d9097;

interface Crater {
  x: number;
  z: number;
  r: number;
  depth: number;
  /** Bright rays of fresh ejecta (young craters). */
  rays: number;
  /** Small, by the yard: not graded flat with it. */
  near?: boolean;
}

const BIG_CRATERS: Crater[] = [
  { x: -11, z: 9, r: 4.6, depth: 0.95, rays: 0 },
  { x: 13, z: 8, r: 6.2, depth: 1.15, rays: 0 },
  { x: -6.5, z: -14, r: 3.2, depth: 0.7, rays: 1 },
  { x: 9.5, z: -11, r: 2.6, depth: 0.55, rays: 0 },
  { x: 2, z: 16, r: 3.4, depth: 0.7, rays: 1 },
  { x: -21, z: -3, r: 7.5, depth: 1.3, rays: 0 },
  { x: 24, z: -6, r: 5, depth: 0.9, rays: 0 },
  { x: -3, z: 30, r: 9, depth: 1.6, rays: 0 },
];

export class MoonScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.05, 700);
  private exhaust = new Exhaust('vacuum');
  private rocket: THREE.Object3D;
  private padTop: number;
  private sun: THREE.DirectionalLight;
  private beacon: THREE.MeshBasicMaterial;
  private textures: THREE.Texture[] = [];
  private craters: Crater[];
  private nozzle = new THREE.Vector3();
  private look = new THREE.Vector3();
  private time = 0;
  private lastM = 0;

  /** `name`: the city's name, for the sign. `ship`: the founder's rocket to copy, if they have one. */
  constructor(name: string, ship: THREE.Object3D | null) {
    const r = rng(1969);
    this.craters = [...BIG_CRATERS];
    // Small craters everywhere but the yard, smaller near the house.
    for (let i = 0; i < 90; i++) {
      const a = r() * Math.PI * 2;
      const d = 6.5 + r() ** 0.7 * 36;
      const rad = 0.25 + r() ** 2 * (d < 12 ? 1 : 2.2);
      this.craters.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, r: rad, depth: rad * (0.22 + r() * 0.12), rays: r() < 0.08 ? 1 : 0 });
    }
    // And little ones right up to the edge of the yard, so the near ground isn't a plain.
    for (let i = 0; i < 46; i++) {
      const a = r() * Math.PI * 2;
      const d = 3.3 + r() * 5;
      const x = 0.4 + Math.cos(a) * d;
      const z = -0.5 + Math.sin(a) * d;
      const rad = 0.12 + r() ** 2 * 0.4;
      if (KEEP_CLEAR.some(([kx, kz, kr]) => Math.hypot(x - kx, z - kz) < kr + rad)) continue;
      this.craters.push({ x, z, r: rad, depth: rad * (0.25 + r() * 0.1), rays: 0, near: true });
    }

    const s = this.scene;
    s.background = new THREE.Color(0x020306);
    // Hard white sunlight; a faint blue earthshine from the north; a little sky in the shadows so they stay readable.
    this.sun = new THREE.DirectionalLight(0xfff8ee, 3.3);
    this.sun.position.copy(SUN).multiplyScalar(60);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -15;
    sc.right = sc.top = 15;
    sc.near = 20;
    sc.far = 110;
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.02;
    const earthshine = new THREE.DirectionalLight(0x7d9ee0, 0.32);
    earthshine.position.copy(EARTH).multiplyScalar(60);
    const fill = new THREE.HemisphereLight(0x27304a, 0x2b2824, 0.42);
    // The house's own light, spilling warm out of the glass onto the regolith.
    const hearth = new THREE.PointLight(0xffb36b, 1.6, 5, 1.6);
    hearth.position.set(0, 1.0, 0);
    s.add(this.sun, this.sun.target, earthshine, fill, hearth);

    s.add(this.terrain());
    s.add(stars());
    s.add(this.earth());

    const set = new GeoBuilder();
    const lit = new THREE.MeshBasicMaterial({ vertexColors: true });
    this.rocks(set, r);
    this.house(set);
    this.pad(set);
    this.mast(set);
    this.solar(set);
    this.yard(set);
    const built = set.build(lit);
    built.group.traverse((o) => {
      o.castShadow = true;
      o.receiveShadow = true;
    });
    s.add(built.group);
    s.add(this.dome());
    s.add(this.rover());
    s.add(this.flag());
    s.add(this.sign(name));

    // The beacon on the mast blinks on its own material.
    this.beacon = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.25, 0.15) });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), this.beacon);
    bulb.position.set(MAST.x, this.ground(MAST.x, MAST.y) + 1.49, MAST.y);
    s.add(bulb);

    this.padTop = this.ground(PAD.x, PAD.y) + 0.06;
    this.rocket = ship ? ship.clone() : rocket(7).group;
    this.rocket.traverse((o) => (o.castShadow = true));
    this.rocket.position.set(PAD.x, this.padTop, PAD.y);
    s.add(this.rocket);
    this.exhaust.ambient.set(0.5, 0.48, 0.44);
    s.add(this.exhaust.object);
  }

  /** Ground height at (x, z): flat in the yard, cratered beyond, curving away to the horizon. */
  ground(x: number, z: number): number {
    let h = 0.22 * Math.sin(x * 0.21 + 1.3) * Math.sin(z * 0.17 + 0.4) + 0.12 * Math.sin(x * 0.53 - z * 0.41) + 0.035 * Math.sin(x * 1.7 + z * 1.3) * Math.sin(z * 2.1 - x * 0.3);
    let near = 0;
    for (const c of this.craters) {
      const dx = x - c.x;
      const dz = z - c.z;
      const d2 = (dx * dx + dz * dz) / (c.r * c.r);
      if (d2 > 9) continue;
      const d = Math.sqrt(d2);
      // A bowl, a raised rim, ejecta tailing off outside, and a central peak in the big ones.
      let k = d < 1 ? -c.depth * (1 - d2) : 0;
      k += 0.26 * c.depth * Math.exp(-(((d - 1) / (d < 1 ? 0.13 : 0.32)) ** 2));
      if (c.r > 5) k += 0.32 * c.depth * Math.exp(-((d / 0.16) ** 2));
      if (c.near) near += k;
      else h += k;
    }
    // The yard is graded flat (the little craters by it are newer than the grading).
    const yard = Math.hypot(x - 0.4, z + 0.5);
    h *= THREE.MathUtils.smoothstep(yard, 5.6, 9.5);
    return h + near - (x * x + z * z) / (2 * CURVE);
  }

  /** Regolith: cream-grey highlands, darker mare, darker crater floors, bright rims and rays. */
  private terrain(): THREE.Mesh {
    const rings = 96;
    const segs = 200;
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const high = new THREE.Color(0xbcb5a7);
    const mare = new THREE.Color(0x85817a);
    const c = new THREE.Color();
    const tmp = new THREE.Color();
    const r = rng(7);
    for (let i = 0; i <= rings; i++) {
      const rad = EXTENT * (i / rings) ** 1.55;
      for (let j = 0; j <= segs; j++) {
        const a = (j / segs) * Math.PI * 2;
        // A little jitter, so the rings don't show as lines in the grazing light.
        const jit = i > 2 && i < rings ? (r() - 0.5) * 0.35 * (rad / rings) : 0;
        const x = Math.cos(a) * (rad + jit);
        const z = Math.sin(a) * (rad + jit);
        pos.push(x, this.ground(x, z), z);
        // Colour
        const m = THREE.MathUtils.smoothstep(0.5 + 0.5 * Math.sin(x * 0.085 + 2) * Math.sin(z * 0.1 - 1) + 0.15 * Math.sin(x * 0.31 + z * 0.22), 0.45, 0.85);
        c.copy(high).lerp(mare, m * 0.75);
        let shade = 1 + (r() - 0.5) * 0.07;
        for (const k of this.craters) {
          const dx = x - k.x;
          const dz = z - k.z;
          const d = Math.sqrt(dx * dx + dz * dz) / k.r;
          if (d > 4) continue;
          if (d < 0.9) shade *= 0.9;
          shade *= 1 + 0.12 * Math.exp(-(((d - 1) / 0.2) ** 2));
          if (k.rays && d > 1) shade *= 1 + 0.22 * Math.abs(Math.sin(Math.atan2(dz, dx) * 7 + k.x)) ** 10 * Math.exp(-(d - 1) / 1.2);
        }
        // Scorched round the pad; packed down along the paths.
        const pd = Math.hypot(x - PAD.x, z - PAD.y);
        if (pd < 3.2) shade *= 1 - 0.32 * THREE.MathUtils.smoothstep(pd, 3.2, 1.2) * (0.75 + 0.25 * Math.sin(Math.atan2(z - PAD.y, x - PAD.x) * 9));
        c.multiplyScalar(shade);
        tmp.copy(c);
        col.push(tmp.r, tmp.g, tmp.b);
      }
    }
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < segs; j++) {
        const a = i * (segs + 1) + j;
        const b = a + segs + 1;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }));
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    return mesh;
  }

  /** Boulders, half sunk in the dust: big ones out in the plain, pebbles by the paths. */
  private rocks(b: GeoBuilder, r: () => number) {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const add = (x: number, z: number, size: number) => {
      if (KEEP_CLEAR.some(([kx, kz, kr]) => Math.hypot(x - kx, z - kz) < kr + size)) return;
      if ([...WALK, ...LIFT].some((k) => Math.hypot(x - k.pos.x, z - k.pos.z) < 1.2 + size * 2)) return;
      e.set(r() * 3, r() * 3, r() * 3);
      q.setFromEuler(e);
      const sx = size * (0.8 + r() * 0.5);
      m.compose(new THREE.Vector3(x, this.ground(x, z) + size * 0.25, z), q, new THREE.Vector3(sx, size * (0.55 + r() * 0.3), size * (0.8 + r() * 0.4)));
      const tone = 0.42 + r() * 0.2;
      b.transformed(new THREE.IcosahedronGeometry(1, 0), m, [tone, tone * 0.97, tone * 0.92]);
    };
    for (const [x, z, s] of [[-4.6, -3.3, 0.42], [-5.2, -2.6, 0.18], [5.9, -3.9, 0.3], [6.4, 1.8, 0.5], [-3.9, 3.6, 0.36], [1.5, -5.2, 0.16], [-1.9, -4.6, 0.12], [3.2, 3.5, 0.22]] as const) add(x, z, s);
    for (let i = 0; i < 70; i++) {
      const a = r() * Math.PI * 2;
      const d = 5 + r() * 30;
      add(Math.cos(a) * d, Math.sin(a) * d, 0.08 + r() ** 3 * 0.9);
    }
    for (let i = 0; i < 40; i++) {
      const a = r() * Math.PI * 2;
      const d = 2.4 + r() * 4;
      const x = 0.4 + Math.cos(a) * d;
      const z = -0.5 + Math.sin(a) * d;
      if (Math.hypot(x - PAD.x, z - PAD.y) < 1.5) continue;
      add(x, z, 0.03 + r() * 0.05);
    }
  }

  /** The wing, the dome's drum and its interior, the airlock and the deck (the glass is its own mesh). */
  private house(b: GeoBuilder) {
    const y0 = this.ground(0, 0);
    // Dome: a sintered plinth, a low white drum with a ribbon of warm glass, then the glass dome.
    b.cylinder(1.24, 1.3, 0.08, 0, y0, 0, CREAM, 40);
    b.cylinder(1.06, 1.06, 0.12, 0, y0 + 0.08, 0, WHITE, 40, 'smooth');
    put(b, new THREE.CylinderGeometry(1.066, 1.066, 0.045, 40, 1, true), 0, y0 + 0.14, 0, WARM_SOFT, 'glow');
    for (let k = 0; k < 20; k++) {
      const a = (k / 20) * Math.PI * 2;
      b.box(0.022, 0.05, 0.03, Math.cos(a) * 1.068, y0 + 0.115, Math.sin(a) * 1.068, WHITE, false, -a);
    }
    b.cylinder(1.09, 1.09, 0.025, 0, y0 + 0.2, 0, WHITE, 40, 'smooth');
    // The dome's frame: meridians and rings over the glass, and an oculus ring at the top.
    const R = 1.05;
    const at = (i: number, j: number) => {
      const phi = (i / 12) * Math.PI * 2;
      const th = (j / 5) * (Math.PI / 2);
      return new THREE.Vector3(-(R + 0.006) * Math.cos(phi) * Math.sin(th), y0 + 0.2 + (R + 0.006) * Math.cos(th), (R + 0.006) * Math.sin(phi) * Math.sin(th));
    };
    for (let i = 0; i < 12; i++) {
      for (let j = 1; j <= 5; j++) {
        strut(b, at(i, j - 1 || 0.6), at(i, j), 0.022, WHITE);
        strut(b, at(i, j), at(i + 1, j), 0.02, WHITE);
      }
    }
    b.cylinder(0.2, 0.22, 0.05, 0, y0 + 0.2 + R - 0.02, 0, WHITE, 16, 'smooth');
    b.cylinder(0.12, 0.12, 0.03, 0, y0 + 0.2 + R + 0.03, 0, [1.6, 1.1, 0.6], 16, 'glow');

    // Inside: a warm wood floor, a rug, a sofa facing the Earth, a lemon tree, a desk and a lamp.
    const f = y0 + 0.226;
    b.cylinder(1.02, 1.02, 0.02, 0, f, 0, 0x9a6d47, 32);
    b.cylinder(0.42, 0.42, 0.006, 0.1, f + 0.02, 0.2, 0xb24a2c, 24);
    b.rbox(0.5, 0.1, 0.2, 0.1, f + 0.02, -0.05, 0xd7a35f, 0.03);
    b.rbox(0.5, 0.16, 0.06, 0.1, f + 0.02, -0.16, 0xd7a35f, 0.03);
    b.cylinder(0.11, 0.09, 0.12, -0.55, f + 0.02, 0.35, 0xe7dfd0, 12, 'smooth');
    b.cylinder(0.018, 0.022, 0.3, -0.55, f + 0.14, 0.35, 0x6b4a32, 6);
    for (const [x, y, z, s] of [[-0.55, 0.55, 0.35, 0.2], [-0.45, 0.62, 0.3, 0.13], [-0.64, 0.6, 0.42, 0.13], [-0.52, 0.72, 0.4, 0.11]] as const) b.blob(s, x, f + y, z, 0x4f7f3c, 'smooth', 1);
    for (const [x, y, z] of [[-0.42, 0.5, 0.25], [-0.66, 0.52, 0.27], [-0.5, 0.68, 0.24], [-0.6, 0.45, 0.5], [-0.38, 0.62, 0.42]] as const) b.blob(0.03, x, f + y, z, [1.4, 1.05, 0.15], 'glow');
    b.box(0.46, 0.02, 0.2, 0.55, f + 0.2, 0.45, 0x2a2420);
    for (const dx of [-0.2, 0.2]) b.box(0.02, 0.2, 0.18, 0.55 + dx, f + 0.0, 0.45, 0x2a2420);
    b.box(0.2, 0.13, 0.012, 0.55, f + 0.22, 0.52, 0x1b1d22);
    put(b, new THREE.PlaneGeometry(0.18, 0.11).rotateY(Math.PI), 0.55, f + 0.285, 0.512, [0.9, 1.35, 1.9], 'glow');
    // Arc lamp over the sofa
    b.cylinder(0.05, 0.06, 0.02, 0.72, f + 0.02, -0.25, 0x2a2420, 12);
    strut(b, new THREE.Vector3(0.72, f + 0.03, -0.25), new THREE.Vector3(0.62, f + 0.62, -0.18), 0.012, 0x2a2420);
    strut(b, new THREE.Vector3(0.62, f + 0.62, -0.18), new THREE.Vector3(0.28, f + 0.56, -0.08), 0.012, 0x2a2420);
    b.blob(0.045, 0.28, f + 0.53, -0.08, WARM, 'glow', 1);

    // The wing: a long white bar on short legs, ribbon windows both sides, a thin roof slab.
    const wx0 = -2.95;
    const wx1 = -1.42;
    const wy = this.ground(-2.2, 0);
    const legs = 0.16;
    for (const x of [wx0 + 0.15, wx1 - 0.15]) for (const z of [-0.32, 0.32]) b.cylinder(0.03, 0.04, legs, x, wy, z, DARK, 8);
    b.box(wx1 - wx0, 0.04, 0.82, (wx0 + wx1) / 2, wy + legs, 0, SEAM);
    b.box(wx1 - wx0, 0.44, 0.78, (wx0 + wx1) / 2, wy + legs + 0.04, 0, WHITE);
    for (let x = wx0 + 0.25; x < wx1 - 0.1; x += 0.25) {
      for (const s of [-1, 1]) b.box(0.006, 0.44, 0.006, x, wy + legs + 0.04, s * 0.392, SEAM);
    }
    for (const s of [-1, 1] as const) {
      const n = 5;
      for (let k = 0; k < n; k++) {
        const x = wx0 + 0.18 + ((wx1 - wx0 - 0.36) * (k + 0.5)) / n;
        const tone = k === 2 ? WARM_SOFT : WARM;
        b.panel((wx1 - wx0 - 0.36) / n - 0.04, 0.16, x, wy + legs + 0.27, s * 0.394, s > 0 ? 0 : Math.PI, tone, 'glow');
      }
      b.box(wx1 - wx0 - 0.3, 0.012, 0.05, (wx0 + wx1) / 2, wy + legs + 0.178, s * 0.405, WHITE);
    }
    b.box(wx1 - wx0 + 0.24, 0.045, 1.02, (wx0 + wx1) / 2 - 0.04, wy + legs + 0.48, 0, CREAM);
    b.box(wx1 - wx0 + 0.24, 0.012, 1.02, (wx0 + wx1) / 2 - 0.04, wy + legs + 0.525, 0, SEAM);
    // Radiator fins on the roof
    for (let k = 0; k < 4; k++) b.box(0.3, 0.12, 0.012, wx0 + 0.35 + k * 0.32, wy + legs + 0.53, 0.25, 0xf2efe8);
    // The tube to the dome
    put(b, new THREE.CylinderGeometry(0.15, 0.15, 0.6, 16).rotateZ(Math.PI / 2), -1.18, wy + 0.38, 0, WHITE, 'smooth');
    for (const x of [-1.38, -0.98]) put(b, new THREE.CylinderGeometry(0.165, 0.165, 0.035, 16).rotateZ(Math.PI / 2), x, wy + 0.38, 0, SEAM);

    // The deck at the west end, a lounge chair turned to the Earth, a side table with a mug.
    const dx = -3.5;
    const dy = this.ground(dx, 0.1);
    b.box(0.9, 0.035, 1.0, dx, dy, 0.1, 0x8a6a4a);
    for (let k = 0; k < 6; k++) b.box(0.9, 0.004, 0.006, dx, dy + 0.035, -0.35 + k * 0.18, 0x6d5238);
    b.rbox(0.18, 0.05, 0.26, dx - 0.05, dy + 0.06, 0.15, 0x3b2a22, 0.02);
    b.transformed(new THREE.BoxGeometry(0.18, 0.05, 0.22), new THREE.Matrix4().makeRotationX(-0.95).setPosition(dx - 0.05, dy + 0.16, 0.0), 0x3b2a22, 'smooth');
    b.cylinder(0.015, 0.05, 0.06, dx - 0.05, dy + 0.035, 0.1, 0x2a2420, 6);
    b.rbox(0.14, 0.05, 0.12, dx - 0.05, dy + 0.035, 0.38, 0x3b2a22, 0.02);
    b.cylinder(0.06, 0.06, 0.012, dx + 0.17, dy + 0.12, 0.2, 0xe9e4da, 12);
    b.cylinder(0.008, 0.008, 0.09, dx + 0.17, dy + 0.035, 0.2, DARK, 6);
    b.cylinder(0.014, 0.014, 0.03, dx + 0.18, dy + 0.132, 0.2, 0xf6eedf, 8);

    // Airlock on the south side of the dome: a rounded vestibule, a round hatch with a lit porthole, a porch light, a ramp.
    const az = -1.14;
    b.rbox(0.46, 0.4, 0.4, 0.05, y0 + 0.06, az, WHITE, 0.07);
    b.rbox(0.5, 0.05, 0.44, 0.05, y0 + 0.44, az, CREAM, 0.02);
    put(b, new THREE.CylinderGeometry(0.15, 0.15, 0.03, 24).rotateX(Math.PI / 2), 0.05, y0 + 0.24, az - 0.2, SEAM);
    put(b, new THREE.CylinderGeometry(0.13, 0.13, 0.03, 24).rotateX(Math.PI / 2), 0.05, y0 + 0.24, az - 0.21, 0xcfc8bb, 'smooth');
    put(b, new THREE.CircleGeometry(0.045, 16).rotateY(Math.PI), 0.05, y0 + 0.27, az - 0.227, WARM_SOFT, 'glow');
    for (let k = 0; k < 4; k++) b.box(0.05, 0.022, 0.006, -0.12 + k * 0.035 + 0.04, y0 + 0.08, az - 0.202, k % 2 ? 0x1b1d22 : 0xf2b234, false, 0.6);
    b.box(0.07, 0.025, 0.04, 0.05, y0 + 0.4, az - 0.22, [2.2, 1.65, 1.0], 'glow');
    b.transformed(new THREE.BoxGeometry(0.3, 0.025, 0.42), new THREE.Matrix4().makeRotationX(-0.17).setPosition(0.05, y0 + 0.035, az - 0.4), CREAM);
  }

  /** The transparent dome itself, after everything solid so the room shows through. */
  private dome(): THREE.Mesh {
    const y0 = this.ground(0, 0);
    const g = new THREE.SphereGeometry(1.05, 12, 5, 0, Math.PI * 2, 0, Math.PI / 2);
    g.translate(0, y0 + 0.2, 0);
    const m = new THREE.MeshStandardMaterial({
      color: 0xcfe3f2,
      emissive: 0x1e130a,
      transparent: true,
      opacity: 0.16,
      roughness: 0.06,
      metalness: 0.2,
      flatShading: true,
      depthWrite: false,
      envMap: glassMaterial.envMap,
      envMapIntensity: 0.45,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.renderOrder = 2;
    return mesh;
  }

  /** The landing pad: sintered dark, a cream ring, orange chevrons, and guide lights. */
  private pad(b: GeoBuilder) {
    const y = this.ground(PAD.x, PAD.y);
    b.cylinder(1.12, 1.18, 0.06, PAD.x, y - 0.005, PAD.y, 0x55524d, 40);
    put(b, new THREE.RingGeometry(0.86, 0.93, 48).rotateX(-Math.PI / 2), PAD.x, y + 0.056, PAD.y, 0xd9d0bf);
    put(b, new THREE.RingGeometry(0.3, 0.33, 32).rotateX(-Math.PI / 2), PAD.x, y + 0.056, PAD.y, 0xd9d0bf);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      const sh = new THREE.Shape([new THREE.Vector2(-0.09, 0), new THREE.Vector2(0, 0.09), new THREE.Vector2(0.09, 0), new THREE.Vector2(0.09, 0.04), new THREE.Vector2(0, 0.13), new THREE.Vector2(-0.09, 0.04)]);
      const g = new THREE.ShapeGeometry(sh).rotateX(-Math.PI / 2).rotateY(-a + Math.PI / 2);
      put(b, g, PAD.x + Math.cos(a) * 0.62, y + 0.057, PAD.y + Math.sin(a) * 0.62, 0xe5512b);
    }
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      b.box(0.04, 0.025, 0.04, PAD.x + Math.cos(a) * 1.06, y + 0.05, PAD.y + Math.sin(a) * 1.06, [2.6, 1.7, 0.7], 'glow');
    }
  }

  /** A lattice mast with its dish turned to the Earth, and a red beacon on top (its own mesh). */
  private mast(b: GeoBuilder) {
    const x = MAST.x;
    const z = MAST.y;
    const y = this.ground(x, z);
    const h = 1.45;
    const legs = [0, 1, 2].map((k) => (k / 3) * Math.PI * 2 + 0.3);
    const leg = (k: number, u: number) => {
      const a = legs[k % 3]!;
      const rr = 0.16 * (1 - u) + 0.04 * u;
      return new THREE.Vector3(x + Math.cos(a) * rr, y + h * u, z + Math.sin(a) * rr);
    };
    for (let k = 0; k < 3; k++) strut(b, leg(k, 0), leg(k, 1), 0.018, STEEL, 'glass');
    for (let s = 0; s < 8; s++) {
      for (let k = 0; k < 3; k++) {
        strut(b, leg(k, s / 8), leg(k + 1, (s + 1) / 8), 0.008, STEEL);
        strut(b, leg(k, s / 8), leg(k + 1, s / 8), 0.008, STEEL);
      }
    }
    b.box(0.28, 0.03, 0.28, x, y, z, 0x6d6a64);
    // Dish
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), EARTH);
    const centre = new THREE.Vector3(x, y + h - 0.12, z).addScaledVector(EARTH, 0.08);
    const m = new THREE.Matrix4().compose(centre, q, new THREE.Vector3(1, 1, 1));
    const pts: [number, number][] = [];
    for (let k = 0; k <= 8; k++) {
      const rr = (k / 8) * 0.34;
      pts.push([rr, rr * rr * 0.9]);
    }
    const dish = new THREE.LatheGeometry(pts.map(([a, c]) => new THREE.Vector2(a, c)), 24);
    b.transformed(dish, m, 0xe9e6df);
    const back = new THREE.LatheGeometry(pts.map(([a, c]) => new THREE.Vector2(a, c - 0.012)), 24);
    b.transformed(back, m, 0xa29d94);
    b.transformed(new THREE.CylinderGeometry(0.006, 0.006, 0.34, 6).translate(0, 0.17, 0), m, STEEL);
    b.transformed(new THREE.CylinderGeometry(0.025, 0.02, 0.05, 8).translate(0, 0.35, 0), m, 0xd9d4ca);
    strut(b, new THREE.Vector3(x, y + h - 0.1, z), centre, 0.03, DARK);
    strut(b, new THREE.Vector3(x, y + h, z), new THREE.Vector3(x, y + h + 0.22, z), 0.012, STEEL);
  }

  /** Two solar wings, square on to the sun. */
  private solar(b: GeoBuilder) {
    const n = SUN;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
    // Keep the panels' long side level.
    const yaw = Math.atan2(-n.z, n.x);
    for (const [x, z] of [[-3.75, 1.75], [-2.35, 2.45]] as const) {
      const y = this.ground(x, z);
      const c = new THREE.Vector3(x, y + 0.5, z);
      b.cylinder(0.025, 0.035, 0.5, x, y, z, STEEL, 8);
      b.box(0.16, 0.025, 0.16, x, y, z, DARK);
      const m = new THREE.Matrix4().compose(c, q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)), new THREE.Vector3(1, 1, 1));
      b.transformed(new THREE.BoxGeometry(1.1, 0.025, 0.62), m, 0xb9bcc2, 'glass');
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 3; j++) {
          const g = new THREE.PlaneGeometry(0.165, 0.18).rotateX(-Math.PI / 2).translate(-0.4625 + i * 0.185, 0.0135, -0.2 + j * 0.2);
          b.transformed(g, m, 0x1d2f5c, 'glass');
        }
      }
    }
  }

  /** The yard: footprints from the airlock to the pad and the flag, rover tracks, and the mailbox. */
  private yard(b: GeoBuilder) {
    const print = (x: number, z: number, a: number) => {
      const g = new THREE.CircleGeometry(1, 10).scale(0.026, 0.05, 1).rotateX(-Math.PI / 2).rotateY(a);
      put(b, g, x, this.ground(x, z) + 0.004, z, 0x77736c);
    };
    const walk = (x0: number, z0: number, x1: number, z1: number, bend: number) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const n = Math.floor(len / 0.13);
      for (let k = 0; k < n; k++) {
        const u = k / n;
        const x = x0 + (x1 - x0) * u - (z1 - z0) * bend * Math.sin(Math.PI * u) / len;
        const z = z0 + (z1 - z0) * u + (x1 - x0) * bend * Math.sin(Math.PI * u) / len;
        const a = Math.atan2(x1 - x0, z1 - z0);
        const side = k % 2 ? 1 : -1;
        print(x + Math.cos(a) * 0.04 * side, z - Math.sin(a) * 0.04 * side, a);
      }
    };
    walk(0.05, -1.75, 2.85, -1.75, 0.35);
    walk(2.95, -2.15, 2.4, -2.85, 0.1);
    walk(0.0, -1.75, -0.55, -2.6, -0.1);
    // Rover tracks: two treads curving away west behind where it's parked.
    const rx = -2.3;
    const rz = -2.05;
    for (const off of [-0.17, 0.17]) {
      for (let k = 0; k < 70; k++) {
        const u = k / 70;
        const x = rx - 0.3 - u * 6;
        const z = rz + Math.sin(u * 2.4) * 1.6 * u + off * Math.cos(u * 1.2);
        const x2 = rx - 0.3 - (u + 1 / 70) * 6;
        const z2 = rz + Math.sin((u + 1 / 70) * 2.4) * 1.6 * (u + 1 / 70) + off * Math.cos((u + 1 / 70) * 1.2);
        const a = Math.atan2(x2 - x, z2 - z);
        const g = new THREE.PlaneGeometry(0.075, 0.07).rotateX(-Math.PI / 2).rotateY(a);
        put(b, g, x, this.ground(x, z) + 0.004, z, k % 2 ? 0x6e6a63 : 0x7c7870);
      }
    }
    // The mailbox: Golden Gate orange on a post, flag up. Nobody delivers here.
    const mx = -0.95;
    const mz = -2.75;
    const my = this.ground(mx, mz);
    b.box(0.035, 0.3, 0.035, mx, my, mz, DARK);
    b.rbox(0.13, 0.08, 0.22, mx, my + 0.3, mz, 0xe5512b, 0.01);
    put(b, new THREE.CylinderGeometry(0.065, 0.065, 0.22, 16, 1, false, 0, Math.PI).rotateX(Math.PI / 2).rotateZ(Math.PI / 2), mx, my + 0.38, mz, 0xe5512b, 'smooth');
    b.box(0.012, 0.13, 0.025, mx + 0.072, my + 0.33, mz + 0.06, 0xc8382b);
    b.box(0.012, 0.025, 0.06, mx + 0.072, my + 0.44, mz + 0.085, 0xc8382b);
  }

  /** A six-wheeled rover with a glass cab, parked by the deck, headlights on. */
  private rover(): THREE.Group {
    const b = new GeoBuilder();
    const wheel = (x: number, z: number) => {
      put(b, new THREE.CylinderGeometry(0.1, 0.1, 0.07, 16).rotateX(Math.PI / 2), x, 0.1, z, 0x2a2c31, 'smooth');
      put(b, new THREE.CylinderGeometry(0.05, 0.05, 0.075, 10).rotateX(Math.PI / 2), x, 0.1, z, 0xb8b4ac);
    };
    for (const x of [-0.3, 0, 0.3]) for (const z of [-0.22, 0.22]) wheel(x, z);
    b.rbox(0.82, 0.07, 0.36, 0, 0.13, 0, 0xe2ddd3, 0.02);
    for (const x of [-0.3, 0, 0.3]) for (const s of [-1, 1]) b.rbox(0.2, 0.03, 0.09, x, 0.2, s * 0.215, 0xd9d0bf, 0.012);
    b.box(0.82, 0.012, 0.02, 0, 0.2, 0.181, 0xe5512b);
    b.box(0.82, 0.012, 0.02, 0, 0.2, -0.181, 0xe5512b);
    // Cab: a pressurised bubble up front, a cargo rack behind with a crate.
    b.rbox(0.36, 0.12, 0.32, 0.18, 0.2, 0, 0xeeeae2, 0.04);
    b.lathe([[0, 0.17], [0.1, 0.16], [0.15, 0.1], [0.165, 0.02], [0.16, 0]], 0.2, 0.32, 0, 0x8fb4d6, 16, 'glass');
    b.box(0.3, 0.03, 0.3, -0.22, 0.2, 0, DARK);
    b.rbox(0.16, 0.11, 0.14, -0.25, 0.23, 0.04, 0xc9a15a, 0.015);
    strut(b, new THREE.Vector3(-0.32, 0.23, -0.1), new THREE.Vector3(-0.32, 0.62, -0.1), 0.01, STEEL);
    b.lathe([[0, 0], [0.04, 0.008], [0.08, 0.03]], -0.32, 0.6, -0.1, 0xe9e6df, 12, 'solid');
    b.box(0.02, 0.03, 0.05, 0.415, 0.17, 0.11, [3.4, 3.2, 2.8], 'glow');
    b.box(0.02, 0.03, 0.05, 0.415, 0.17, -0.11, [3.4, 3.2, 2.8], 'glow');
    b.box(0.015, 0.02, 0.04, -0.415, 0.17, 0.13, [2.4, 0.2, 0.12], 'glow');
    b.box(0.015, 0.02, 0.04, -0.415, 0.17, -0.13, [2.4, 0.2, 0.12], 'glow');
    const built = b.build(new THREE.MeshBasicMaterial({ vertexColors: true }));
    built.group.traverse((o) => {
      o.castShadow = true;
      o.receiveShadow = true;
    });
    const x = -2.3;
    const z = -2.05;
    built.group.position.set(x, this.ground(x, z), z);
    built.group.rotation.y = 0.35;
    return built.group;
  }

  /** The TinyTown flag, Apollo style: a rod along the top holds it out, since there's no wind to. */
  private flag(): THREE.Group {
    const x = 2.35;
    const z = -3.0;
    const y = this.ground(x, z);
    const g = new THREE.Group();
    const b = new GeoBuilder();
    b.cylinder(0.009, 0.011, 0.95, 0, 0, 0, 0xd9d6cf, 8, 'glass');
    put(b, new THREE.CylinderGeometry(0.006, 0.006, 0.5, 6).rotateZ(Math.PI / 2), 0.25, 0.93, 0, 0xd9d6cf, 'glass');
    b.blob(0.016, 0, 0.955, 0, 0xd9d6cf, 'smooth', 1);
    const pole = b.build();
    g.add(pole.group);
    // The cloth: sand, with the mark; crumpled a little where it was folded for the flight.
    const tex = canvasTexture(320, 208, (ctx, w, h) => {
      ctx.fillStyle = BRAND.sand;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = BRAND.sandDeep;
      ctx.fillRect(0, h - 10, w, 10);
      drawMark(ctx, w / 2 - 78, h / 2 - 84, 156);
    });
    this.textures.push(tex);
    const cloth = new THREE.PlaneGeometry(0.5, 0.32, 12, 4);
    const p = cloth.attributes.position!;
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i) / 0.5 + 0.5;
      const v = p.getY(i) / 0.32 + 0.5;
      p.setZ(i, 0.012 * Math.sin(u * 13) * (0.3 + u) + 0.01 * Math.sin(u * 5 + v * 3) * (1 - v));
    }
    cloth.computeVertexNormals();
    const m = new THREE.Mesh(cloth, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, side: THREE.DoubleSide }));
    m.position.set(0.25, 0.77, 0);
    m.castShadow = true;
    g.add(m);
    g.traverse((o) => (o.castShadow = true));
    g.position.set(x, y, z);
    // Turned so the mark faces the walk up from the house.
    g.rotation.y = 0.25;
    return g;
  }

  /** A low sintered slab by the path with the city's name on it, like a house number at the gate. */
  private sign(name: string): THREE.Group {
    const x = -0.45;
    const z = -2.95;
    const y = this.ground(x, z);
    const g = new THREE.Group();
    const b = new GeoBuilder();
    b.box(0.74, 0.3, 0.08, 0, 0, 0, 0xe4ddd0);
    b.box(0.8, 0.03, 0.12, 0, 0.3, 0, CREAM);
    b.box(0.6, 0.02, 0.16, 0, -0.01, 0, 0x8d877d);
    // A little warm light washing the face from below.
    b.box(0.4, 0.012, 0.012, 0, 0.012, -0.065, [3, 2.1, 1.1], 'glow');
    const slab = b.build(new THREE.MeshBasicMaterial({ vertexColors: true }));
    g.add(slab.group);
    const draw = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = BRAND.ink;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      const label = name.toUpperCase();
      let size = 118;
      ctx.font = `800 ${size}px 'Bricolage Grotesque', Geist, system-ui, sans-serif`;
      while (ctx.measureText(label).width > w * 0.86 && size > 40) {
        size -= 4;
        ctx.font = `800 ${size}px 'Bricolage Grotesque', Geist, system-ui, sans-serif`;
      }
      ctx.fillText(label, w / 2, h * 0.56);
      ctx.font = `500 30px 'Geist Mono', ui-monospace, monospace`;
      (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '5px';
      ctx.fillStyle = 'rgba(27,34,54,0.72)';
      ctx.fillText('1 SEA OF TRANQUILITY · THE MOON', w / 2, h * 0.83);
      (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0px';
      ctx.fillStyle = BRAND.gate;
      ctx.fillRect(w / 2 - 34, h * 0.14, 68, 6);
    };
    const tex = canvasTexture(1024, 400, draw);
    this.textures.push(tex);
    // The fonts may still be arriving the first time: draw again once they're in.
    void document.fonts?.ready.then(() => {
      const c = tex.image as HTMLCanvasElement;
      draw(c.getContext('2d')!, c.width, c.height);
      tex.needsUpdate = true;
    });
    const face = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.27), new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.7 }));
    face.position.set(0, 0.15, 0.041);
    g.add(face);
    g.traverse((o) => {
      o.castShadow = true;
      o.receiveShadow = true;
    });
    g.position.set(x, y, z);
    // Faces the path and the camera's walk from the south-east.
    g.rotation.y = Math.PI + 0.55;
    return g;
  }

  /**
   * The Earth: oceans in Bay blue, the Americas, cloud, a thin blue rim of
   * atmosphere, lit by the same sun as the house. San Francisco sits just
   * inside the night side, its lights on.
   */
  private earth(): THREE.Group {
    const g = new THREE.Group();
    const day = canvasTexture(2048, 1024, drawEarth);
    const night = canvasTexture(1024, 512, drawCityLights);
    this.textures.push(day, night);
    const sunUniform = { value: SUN.clone() };
    const mat = new THREE.ShaderMaterial({
      uniforms: { tDay: { value: day }, tNight: { value: night }, uSun: sunUniform },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vN;
        varying vec3 vView;
        void main() {
          vUv = uv;
          vN = normalize(mat3(modelMatrix) * normal);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vView = normalize(cameraPosition - wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDay;
        uniform sampler2D tNight;
        uniform vec3 uSun;
        varying vec2 vUv;
        varying vec3 vN;
        varying vec3 vView;
        void main() {
          vec3 n = normalize(vN);
          float l = dot(n, uSun);
          vec4 day = texture2D(tDay, vUv);
          vec3 col = day.rgb * (smoothstep(-0.08, 0.5, l) * 1.6 + 0.012);
          // Sun glint on the oceans (the blue pixels).
          vec3 h = normalize(uSun + vView);
          float water = smoothstep(0.04, 0.14, day.b - day.r);
          col += vec3(1.0, 0.95, 0.85) * pow(max(dot(n, h), 0.0), 180.0) * water * 0.4 * step(0.0, l);
          // City lights where it's night.
          col += texture2D(tNight, vUv).rgb * smoothstep(0.06, -0.12, l) * 5.0;
          // Atmosphere: a blue rim, brightest on the day side.
          float rim = pow(1.0 - max(dot(n, vView), 0.0), 2.6);
          col += vec3(0.32, 0.58, 1.0) * rim * (smoothstep(-0.25, 0.4, l) * 1.6 + 0.05);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const ball = new THREE.Mesh(new THREE.SphereGeometry(EARTH_RADIUS, 64, 48), mat);
    g.add(ball);
    // A halo just outside the limb.
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_RADIUS * 1.045, 48, 32),
      new THREE.ShaderMaterial({
        uniforms: { uSun: sunUniform },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        vertexShader: /* glsl */ `
          varying vec3 vN;
          varying vec3 vView;
          void main() {
            vN = normalize(mat3(modelMatrix) * normal);
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vView = normalize(cameraPosition - wp.xyz);
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uSun;
          varying vec3 vN;
          varying vec3 vView;
          void main() {
            // Seen from inside, the shell's far side shows only as a ring around the limb:
            // strongest against the planet, nothing at its outer edge; brighter on the day side.
            vec3 n = normalize(vN);
            float a = pow(clamp(abs(dot(n, vView)) / 0.29, 0.0, 1.0), 2.0);
            a *= smoothstep(-0.3, 0.5, dot(n, uSun));
            gl_FragColor = vec4(vec3(0.3, 0.55, 1.0) * a * 0.8, 1.0);
          }`,
      }),
    );
    g.add(halo);
    g.position.copy(EARTH).multiplyScalar(EARTH_DISTANCE);
    // Turn it so San Francisco faces the house, just past the terminator, with north up.
    const toMoon = EARTH.clone().negate();
    const sunPerp = SUN.clone().addScaledVector(EARTH, -SUN.dot(EARTH)).normalize();
    const dark = sunPerp.clone().negate();
    const sf = toMoon.clone().multiplyScalar(Math.cos(0.74)).addScaledVector(dark, Math.sin(0.74)).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    sf.addScaledVector(up.clone().addScaledVector(toMoon, -up.dot(toMoon)).normalize(), 0.22).normalize();
    g.quaternion.copy(alignLocal(latLon(37.8, -122.4), new THREE.Vector3(0, 1, 0), sf, up));
    return g;
  }

  /** Poses the set for `m` seconds into the visit. */
  update(dt: number, m: number, aspect: number) {
    this.time += dt;
    // A jump in time (a preview seeking) leaves no dust hanging from the moment before.
    if (Math.abs(m - this.lastM - dt) > 0.5) this.exhaust.clear();
    this.lastM = m;
    // Rocket: down onto the pad, quiet while you look around, then off home.
    let y = 0;
    let thrust = 0;
    if (m < MOON_TOUCHDOWN) {
      const u = m / MOON_TOUCHDOWN;
      y = 15 * (1 - u) ** 2.3;
      thrust = 0.7 + 0.3 * u;
    } else if (m < MOON_TOUCHDOWN + 0.4) thrust = 1 - (m - MOON_TOUCHDOWN) / 0.4;
    else if (m > MOON_IGNITION) {
      const c = Math.max(0, m - MOON_IGNITION - 0.7);
      y = 0.6 * c * c + 0.35 * c * c * c;
      thrust = Math.min(1, (m - MOON_IGNITION) / 0.3);
    }
    this.rocket.position.y = this.padTop + y;
    this.exhaust.thrust = thrust;
    this.nozzle.set(PAD.x, this.padTop + y, PAD.y);
    this.exhaust.update(dt, this.nozzle, this.padTop);
    // The mast's beacon: a short blink every second and a half.
    this.beacon.color.setRGB(3, 0.25, 0.15).multiplyScalar((this.time % 1.5) < 0.16 ? 1 : 0.04);
    this.shoot(m, aspect);
  }

  /**
   * The camera: down low watching the rocket come in, then a slow walk
   * round the south side (the sign, the rover, the deck) that ends close on
   * the dome's warm glass; a cut to a wide low shot for the lift-off.
   */
  private shoot(m: number, aspect: number) {
    const c = this.camera;
    // Portrait screens see less across: widen the lens a little and stand further back.
    const fov = THREE.MathUtils.clamp((2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(29)) / aspect) * 180) / Math.PI, 36, 62);
    const back = aspect < 1 ? 1 + (1 - aspect) * 0.9 : 1;
    if (c.fov !== fov || c.aspect !== aspect) {
      c.fov = fov;
      c.aspect = aspect;
      c.updateProjectionMatrix();
    }
    const keys = m < MOON_CUT ? WALK : LIFT;
    sample(keys, m, c.position, this.look);
    if (m < MOON_TOUCHDOWN + 0.6) {
      // Keep the descending rocket in the frame.
      const k = 1 - THREE.MathUtils.smoothstep(m, MOON_TOUCHDOWN - 1.2, MOON_TOUCHDOWN + 0.6);
      this.look.y += k * (this.rocket.position.y - this.padTop) * 0.2;
    }
    if (m >= MOON_CUT && m > MOON_IGNITION) {
      // Tilt up after the rocket as it climbs.
      this.look.y += Math.min(6, (this.rocket.position.y - this.padTop) * 0.5);
    }
    if (back !== 1) c.position.sub(this.look).multiplyScalar(back).add(this.look);
    c.lookAt(this.look);
  }

  /** Lets go of the shadow map between visits (the set itself stays, small). */
  rest() {
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    this.exhaust.clear();
  }
}

interface Key {
  t: number;
  pos: THREE.Vector3;
  look: THREE.Vector3;
}

const key = (t: number, p: [number, number, number], l: [number, number, number]): Key => ({ t, pos: new THREE.Vector3(...p), look: new THREE.Vector3(...l) });

/** The walk round the house, from the landing to the close-up at the glass. */
const WALK: Key[] = [
  key(0, [10.2, 1.7, -11.0], [2.4, 2.4, -0.8]),
  key(MOON_TOUCHDOWN, [8.6, 1.25, -9.6], [1.6, 1.5, -0.6]),
  key(7.4, [1.6, 0.85, -6.2], [0.1, 0.75, -0.6]),
  key(10.0, [-2.4, 0.8, -5.6], [-0.7, 0.6, -0.6]),
  key(MOON_CUT, [-1.4, 0.64, -2.65], [-0.3, 0.55, -0.4]),
];

/** Low and wide for the lift-off: the house on the left, the rocket on the right, the Earth above. */
const LIFT: Key[] = [key(MOON_CUT, [-0.6, 0.45, -8.4], [1.9, 1.9, -0.6]), key(MOON_END, [-1.0, 0.42, -9.0], [2.2, 2.2, -0.8])];

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

/** Smooth path through the keys (Catmull-Rom on the key times, so speed carries across keys), eased in and out at the ends. */
function sample(keys: Key[], t: number, pos: THREE.Vector3, look: THREE.Vector3) {
  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  const T = THREE.MathUtils.clamp(t, first.t, last.t);
  let i = 0;
  while (i < keys.length - 2 && T > keys[i + 1]!.t) i++;
  const k0 = keys[Math.max(0, i - 1)]!;
  const k1 = keys[i]!;
  const k2 = keys[i + 1]!;
  const k3 = keys[Math.min(keys.length - 1, i + 2)]!;
  const span = k2.t - k1.t;
  let u = (T - k1.t) / span;
  // Ease into the first key's start and out of the last.
  if (i === 0) u = u * u * (2 - u) * 0.5 + u * 0.5;
  if (i === keys.length - 2) u = 1 - (1 - u) * (1 - u) * (1 + u) * 0.5 - (1 - u) * 0.5;
  for (const [out, f] of [[pos, 'pos'], [look, 'look']] as const) {
    const p0 = k0[f];
    const p1 = k1[f];
    const p2 = k2[f];
    const p3 = k3[f];
    // Tangents scaled to this segment's duration.
    const m1 = tmpA.copy(p2).sub(p0).multiplyScalar(span / Math.max(1e-3, k2.t - k0.t));
    const m2 = tmpB.copy(p3).sub(p1).multiplyScalar(span / Math.max(1e-3, k3.t - k1.t));
    const u2 = u * u;
    const u3 = u2 * u;
    out
      .copy(p1)
      .multiplyScalar(2 * u3 - 3 * u2 + 1)
      .addScaledVector(m1, u3 - 2 * u2 + u)
      .addScaledVector(p2, -2 * u3 + 3 * u2)
      .addScaledVector(m2, u3 - u2);
  }
}

/** Adds a geometry to a builder at (x, y, z). */
function put(b: GeoBuilder, g: THREE.BufferGeometry, x: number, y: number, z: number, color: ColorLike, bucket: 'solid' | 'glass' | 'smooth' | 'glow' = 'solid') {
  b.transformed(g, new THREE.Matrix4().makeTranslation(x, y, z), color, bucket === 'glow' ? true : bucket === 'solid' ? false : bucket);
}

const UP = new THREE.Vector3(0, 1, 0);

/** A square bar from a to c. */
function strut(b: GeoBuilder, a: THREE.Vector3, c: THREE.Vector3, t: number, color: ColorLike, bucket: 'solid' | 'glass' = 'solid') {
  const len = a.distanceTo(c);
  if (len < 1e-4) return;
  const dir = tmpA.copy(c).sub(a).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir);
  const m = new THREE.Matrix4().compose(tmpB.copy(a).add(c).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
  b.transformed(new THREE.BoxGeometry(t, len + t * 0.5, t), m, color, bucket === 'solid' ? false : bucket);
}

/** Unit vector for a latitude and longitude, in a three.js sphere's own space (matching its UVs). */
function latLon(lat: number, lon: number): THREE.Vector3 {
  const phi = ((lon + 180) / 360) * Math.PI * 2;
  const th = ((90 - lat) / 180) * Math.PI;
  return new THREE.Vector3(-Math.cos(phi) * Math.sin(th), Math.cos(th), Math.sin(phi) * Math.sin(th));
}

/** The rotation that takes `a` onto `b`, keeping `aUp` as close to `bUp` as it can. */
function alignLocal(a: THREE.Vector3, aUp: THREE.Vector3, b: THREE.Vector3, bUp: THREE.Vector3): THREE.Quaternion {
  const basis = (f: THREE.Vector3, u: THREE.Vector3) => {
    const x = f.clone().normalize();
    const y = u.clone().addScaledVector(x, -u.dot(x)).normalize();
    const z = x.clone().cross(y);
    return new THREE.Matrix4().makeBasis(x, y, z);
  };
  const from = basis(a, aUp);
  const to = basis(b, bUp);
  return new THREE.Quaternion().setFromRotationMatrix(to.multiply(from.transpose()));
}

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Stars: thousands of points, a band of the Milky Way, a few tinted ones. They don't twinkle: there's no air. */
function stars(): THREE.Points {
  const r = rng(42);
  const n = 3200;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const size = new Float32Array(n);
  const v = new THREE.Vector3();
  // The galaxy's plane, tilted across the sky.
  const pole = new THREE.Vector3(0.5, 0.35, -0.8).normalize();
  for (let i = 0; i < n; i++) {
    const band = i < n * 0.4;
    v.set(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1);
    if (v.lengthSq() > 1 || v.lengthSq() < 0.01) {
      i--;
      continue;
    }
    v.normalize();
    if (band) v.addScaledVector(pole, -v.dot(pole) * (0.85 + r() * 0.14)).normalize();
    pos.set([v.x * 420, v.y * 420, v.z * 420], i * 3);
    const bright = band ? 0.25 + r() * 0.5 : r() ** 3 * 1.8 + 0.2;
    const tint = r();
    const c = tint < 0.15 ? [1, 0.82, 0.62] : tint < 0.3 ? [0.72, 0.84, 1] : [1, 0.97, 0.92];
    col.set([c[0]! * bright, c[1]! * bright, c[2]! * bright], i * 3);
    size[i] = band ? 1 + r() * 0.8 : 1.1 + r() ** 4 * 2.6;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('size', new THREE.BufferAttribute(size, 1));
  const m = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uScale: { value: Math.min(2, window.devicePixelRatio) } },
    vertexShader: /* glsl */ `
      attribute float size;
      attribute vec3 color;
      uniform float uScale;
      varying vec3 vColor;
      void main() {
        vColor = color;
        gl_PointSize = size * uScale;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        vec2 p = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.1, length(p));
        gl_FragColor = vec4(vColor * a, 1.0);
      }`,
  });
  const p = new THREE.Points(g, m);
  p.frustumCulled = false;
  p.renderOrder = -1;
  return p;
}

type Poly = readonly (readonly [number, number])[];

const NORTH_AMERICA: Poly = [[-168, 66], [-163, 69], [-156, 71.3], [-141, 69.6], [-128, 70], [-115, 68.6], [-100, 68], [-95, 71.5], [-85, 70], [-80, 63], [-90, 57], [-82, 52], [-78, 57], [-77, 62], [-65, 60], [-60, 55], [-56, 51], [-66, 45], [-70, 42], [-74, 40], [-76, 35], [-81, 31], [-80, 26], [-82, 25.5], [-83, 29], [-89, 30], [-95, 29], [-97, 26], [-97, 22], [-95, 19], [-91, 18.5], [-87, 21.5], [-88, 16], [-84, 15], [-83, 10], [-79, 9], [-77, 8.5], [-80, 7.5], [-84, 9.5], [-86, 12], [-92, 14.5], [-96, 15.8], [-105, 20], [-106, 23.5], [-109.5, 26.5], [-112.5, 29.5], [-114.7, 31.6], [-114, 30], [-111, 25], [-110, 23], [-112, 24.5], [-114.5, 28], [-115.5, 30], [-117, 32.5], [-118.5, 34], [-120.6, 34.6], [-121.9, 36.5], [-122.5, 37.7], [-123, 38], [-124, 40.5], [-124.5, 43], [-124, 46.5], [-124.7, 48.4], [-123, 49], [-127, 50.5], [-131, 53], [-133, 57], [-137, 58.5], [-142, 60], [-147, 61], [-151, 59.5], [-154, 58], [-158, 56.5], [-163, 55], [-158, 58.5], [-162, 60], [-165, 62.5], [-166, 64.5]];
const HUDSON: Poly = [[-95, 60], [-88, 56], [-82, 53], [-79, 55], [-77, 60], [-79, 63], [-86, 64], [-94, 62]];
const GREENLAND: Poly = [[-73, 78], [-60, 82], [-35, 83], [-20, 80], [-20, 72], [-30, 68], [-42, 60], [-50, 63], [-55, 70], [-62, 76]];
const SOUTH_AMERICA: Poly = [[-80, 9], [-75, 11], [-70, 12], [-62, 10.5], [-52, 5], [-50, 0], [-44, -2], [-35, -5], [-35, -9], [-39, -15], [-41, -22], [-48, -26], [-53, -34], [-58, -38.5], [-62, -41], [-65, -45], [-68, -50], [-69, -55], [-72, -53], [-75, -48], [-74, -40], [-73, -30], [-71, -20], [-76, -14], [-81, -6], [-80, -2], [-78, 2], [-77, 7]];
const ASIA: Poly = [[100, 78], [140, 73], [170, 70], [180, 66], [180, 62], [163, 58], [156, 51], [143, 47], [140, 53], [135, 43], [129, 35], [122, 31], [121, 25], [110, 20], [106, 10], [100, 6], [98, 15], [90, 22], [80, 10], [77, 8], [70, 20], [60, 25], [50, 30], [40, 40], [30, 45], [25, 60], [40, 68], [60, 70], [80, 73]];
const CHUKOTKA: Poly = [[-180, 70], [-172, 67], [-170, 65.5], [-176, 64.5], [-180, 65]];
const JAPAN: Poly = [[130, 31], [132, 34], [136, 35], [140, 36], [142, 40], [141, 45], [140, 42], [137, 37], [133, 35], [130, 33]];
const AUSTRALIA: Poly = [[114, -22], [122, -18], [130, -12], [137, -12], [142, -11], [146, -19], [153, -25], [150, -37], [141, -38], [133, -32], [123, -34], [115, -34]];

/** Equirectangular Earth, stylised: Bay-blue oceans, the continents by latitude, ice and cloud. */
function drawEarth(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const px = (lon: number) => ((lon + 180) / 360) * w;
  const py = (lat: number) => ((90 - lat) / 180) * h;
  const path = (p: Poly) => {
    ctx.beginPath();
    p.forEach(([lon, lat], i) => (i ? ctx.lineTo(px(lon), py(lat)) : ctx.moveTo(px(lon), py(lat))));
    ctx.closePath();
  };
  const sea = ctx.createLinearGradient(0, 0, 0, h);
  sea.addColorStop(0, '#2a5d8f');
  sea.addColorStop(0.5, '#1f5a9c');
  sea.addColorStop(1, '#2a5d8f');
  ctx.fillStyle = sea;
  ctx.fillRect(0, 0, w, h);
  // Land, coloured by latitude: tundra, forest, the dry south-west, jungle.
  const land = ctx.createLinearGradient(0, 0, 0, h);
  land.addColorStop(0.1, '#9a9a86');
  land.addColorStop(0.2, '#6f7f57');
  land.addColorStop(0.3, '#5f7a45');
  land.addColorStop(0.36, '#a89a6c');
  land.addColorStop(0.42, '#7d8a52');
  land.addColorStop(0.5, '#4f7a3a');
  land.addColorStop(0.62, '#6c7a46');
  land.addColorStop(0.75, '#8b8a64');
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  for (const p of [NORTH_AMERICA, SOUTH_AMERICA, ASIA, CHUKOTKA, JAPAN, AUSTRALIA, GREENLAND]) {
    path(p);
    ctx.fill();
  }
  ctx.restore();
  ctx.save();
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = land;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
  // Hudson Bay is sea again.
  ctx.fillStyle = '#245b93';
  path(HUDSON);
  ctx.fill();
  // The dry West: deserts from Baja to Utah.
  ctx.fillStyle = 'rgba(196,170,120,0.85)';
  path([[-121, 37], [-116, 41], [-110, 41], [-104, 33], [-105, 27], [-109.5, 26.5], [-114.5, 31], [-117.5, 33.5], [-119.5, 35]]);
  ctx.fill();
  ctx.fillStyle = '#e8eef3';
  path(GREENLAND);
  ctx.fill();
  // Ice caps
  ctx.fillRect(0, 0, w, py(80));
  ctx.fillRect(0, py(-68), w, h);
  // Clouds: soft drifts in bands (the trades, the westerlies), storm swirls, and a few lone puffs.
  const r = rng(2024);
  // (Soft gradients, no canvas blur filter: a blur on every draw is slow enough to stall a software GPU.)
  ctx.save();
  const puff = (x: number, y: number, rx: number, ry: number, a: number) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, rx);
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(0.6, `rgba(255,255,255,${a * 0.55})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, ry / rx);
    ctx.translate(-x, -y);
    ctx.fillStyle = g;
    ctx.fillRect(x - rx, y - rx, rx * 2, rx * 2);
    ctx.restore();
  };
  for (let i = 0; i < 80; i++) {
    const band = [-55, -42, -8, 6, 44, 56][Math.floor(r() * 6)]!;
    const lat = band + (r() - 0.5) * 16;
    const lon = r() * 360 - 180;
    const n = 8 + Math.floor(r() * 14);
    const drift = (r() - 0.5) * 0.5;
    for (let k = 0; k < n; k++) {
      const x = px(lon + k * (1.2 + r() * 1.6));
      const y = py(lat + k * drift + (r() - 0.5) * 4);
      const rx = 14 + r() * 26;
      puff(x, y, rx, rx * (0.3 + r() * 0.25), 0.18 + r() * 0.3);
    }
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineCap = 'round';
  for (let i = 0; i < 9; i++) {
    const cx = px(r() * 360 - 180);
    const cy = py((r() > 0.5 ? 1 : -1) * (38 + r() * 18));
    for (let k = 0; k < 4; k++) {
      ctx.lineWidth = 7 - k;
      ctx.beginPath();
      ctx.ellipse(cx, cy, 8 + k * 9, (8 + k * 9) * 0.55, 0, r() * 6, r() * 6 + 3.2);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Night lights: the bay, glowing, and a few faint neighbours down the coast. */
function drawCityLights(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  const dot = (lat: number, lon: number, r: number, a: number) => {
    const x = ((lon + 180) / 360) * w;
    const y = ((90 - lat) / 180) * h;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,214,150,${a})`);
    g.addColorStop(0.35, `rgba(255,170,90,${a * 0.55})`);
    g.addColorStop(1, 'rgba(255,150,70,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };
  dot(37.8, -122.4, 9, 1);
  dot(37.4, -122.0, 5, 0.7);
  dot(38.6, -121.5, 3, 0.35);
  dot(34.05, -118.25, 6, 0.6);
  dot(45.5, -122.7, 3, 0.35);
  dot(47.6, -122.3, 3.5, 0.4);
}

// ─── The trip ─────────────────────────────────────────────────────────────

/** Seconds from the start of the trip. */
const T_IGNITE = 0.9;
const T_WIPE = T_IGNITE + ROCKET_IGNITION + 2.5;
const T_MOON = T_WIPE + 1.2;
const T_BACK = T_MOON + MOON_END;
const T_HOME = T_BACK + ROCKET_LANDING + 0.6;
const T_END = T_HOME + 1.1;
/** Reduced motion: a fade to a still of the house, and back. */
const R_FADE = 0.45;
const R_HOLD = 4.4;
const R_STILL = 8.2;

/** One set for the whole session: built on the first trip, kept (it's small) for the next. */
let SET: MoonScene | null = null;

export interface MoonTripOptions {
  stage: Stage;
  city: City;
  /** The city's name, for the sign by the house. */
  name: string;
  /** Called once, when the trip is over: `landed` is false if it ended without the rocket (it was scrubbed away). */
  onDone: (landed: boolean) => void;
  /** Preview (`?moon=<seconds>`): hold the trip at this moment. */
  hold?: number;
}

/**
 * The rocket trip to the moon house, as a cinematic of about 30 seconds:
 * ignition and lift-off on the island (the camera rising with it), a
 * wipe up through the sky into space, the landing on the moon and a slow
 * walk round the house, the lift-off for home, and the landing back on the
 * pad. Esc or the Skip pill ends it at once, with the rocket home. Reduced
 * motion gets a fade to a still of the house and back.
 */
export class MoonTrip implements Cinematic {
  done = false;
  private o: MoonTripOptions;
  private t = 0;
  private still = prefersReducedMotion();
  private ending: { t: number; cut: boolean } | null = null;
  /** Which part of the trip is showing. */
  private act: 'start' | 'bay' | 'moon' | 'home' = 'start';
  private ui: TripOverlay;
  private shot: Shot;
  private aspect = new THREE.Vector2();

  constructor(o: MoonTripOptions) {
    this.o = o;
    this.t = o.hold ?? 0;
    this.ui = new TripOverlay(() => this.skip(), !this.still && o.hold === undefined);
    SET ??= new MoonScene(o.name, o.city.rocketModel);
    this.shot = { scene: SET.scene, camera: SET.camera, exposure: 1.05, look: { bloom: 0.36, night: 0.7, tilt: 0.32, focusY: 0.5, warmth: 0.15 } };
    if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) (window as unknown as { __moonTrip: MoonTrip }).__moonTrip = this;
  }

  /** Takes the screen. False (and nothing happens) without a rocket, unless previewing. */
  start(): boolean {
    const { stage, city } = this.o;
    if (stage.playing || (!city.hasRocket && this.o.hold === undefined)) return false;
    // Compile the moon's shaders now, while the HUD fades, not at the cut.
    stage.renderer.compile(SET!.scene, SET!.camera);
    this.ui.show();
    stage.focus(city.rocketAt().clone().setY(1.6), 1.9);
    stage.play(this);
    return true;
  }

  /** Jump to a moment (seconds from lift-off), for previews and tests. */
  seek(t: number) {
    this.t = t;
  }

  skip() {
    if (this.done || this.ending) return;
    // Under the veil if the moon is showing (or about to be); straight away once home.
    this.ending = { t: 0, cut: this.t < T_BACK || this.still };
  }

  update(dt: number): Shot | null {
    if (this.o.hold === undefined) this.t += dt;
    if (this.ending) return this.end(dt);
    // The rocket went (the timeline moved back before it was bought): end here.
    if (!this.o.city.hasRocket && this.o.hold === undefined) {
      this.ending = { t: 0, cut: true };
      return this.end(dt);
    }
    return this.still ? this.stillFrame() : this.frame(dt);
  }

  private frame(dt: number): Shot | null {
    const { city, stage } = this.o;
    const t = this.t;
    // A held preview pins the camera on the rocket every frame, so any moment can be framed exactly.
    const held = this.o.hold !== undefined;
    if (t < T_MOON) {
      // On the bay: ignition, lift-off, and the wipe up into space.
      if ((this.act !== 'bay' || held) && t >= T_IGNITE * 0.8) {
        this.act = 'bay';
        stage.follow(city.rocketAt, 1.9, true, held);
      }
      city.flyRocket(t < T_IGNITE ? null : 'ascent', Math.max(0, t - T_IGNITE));
      this.ui.wipe(THREE.MathUtils.smoothstep(t, T_WIPE, T_MOON));
      return null;
    }
    if (t < T_BACK) {
      const m = t - T_MOON;
      if (this.act !== 'moon') {
        this.act = 'moon';
        city.flyRocket('away', 0);
      }
      SET!.update(dt, m, this.screenAspect());
      // Fade up from black, and back down at the end.
      this.ui.veil(Math.max(1 - m / 0.9, THREE.MathUtils.smoothstep(m, MOON_END - 1, MOON_END)));
      this.ui.caption(m > MOON_TOUCHDOWN + 0.8 && m < MOON_CUT - 0.5);
      return this.shot;
    }
    // Home: the long burn down onto the pad, the camera riding down with it.
    if (this.act !== 'home' || held) {
      if (this.act !== 'home') SET!.rest();
      this.act = 'home';
      stage.follow(city.rocketAt, 1.9, true, true);
    }
    const l = t - T_BACK;
    city.flyRocket('landing', l);
    this.ui.unwipe(THREE.MathUtils.smoothstep(l, 0, 1.3));
    if (t >= T_HOME) this.ui.hide();
    if (t >= T_END) this.finish(true);
    return null;
  }

  /** Reduced motion: a fade to black, the house still, a fade back to the city. Black at both cuts. */
  private stillFrame(): Shot | null {
    const t = this.t;
    const F = R_FADE;
    const away = t >= F && t < F + R_HOLD;
    if (away) {
      this.act = 'moon';
      SET!.update(0, R_STILL, this.screenAspect());
      this.o.city.flyRocket('away', 0);
      this.ui.veil(Math.max(1 - (t - F) / F, (t - (F + R_HOLD - F)) / F));
    } else {
      this.act = t < F ? 'start' : 'home';
      this.o.city.flyRocket(null);
      this.ui.veil(t < F ? t / F : 1 - (t - F - R_HOLD) / F);
    }
    this.ui.caption(away);
    if (t >= F * 2 + R_HOLD) this.finish(true);
    return away ? this.shot : null;
  }

  /** Skipped or cut short: to black (if the moon or the sky is showing), the rocket home, and back. */
  private end(dt: number): Shot | null {
    const e = this.ending!;
    const { city, stage } = this.o;
    e.t += dt;
    if (!e.cut) {
      city.flyRocket(null);
      this.finish(city.hasRocket);
      return null;
    }
    const DOWN = 0.28;
    const UP = 0.45;
    if (e.t < DOWN) {
      // Fade to black over whatever is showing.
      this.ui.veil(Math.max(this.ui.level, e.t / DOWN));
      return this.act === 'moon' ? this.shot : null;
    }
    if (this.act !== 'home') {
      this.act = 'home';
      SET!.rest();
      city.flyRocket(null);
      this.ui.unwipe(1);
      stage.follow(city.rocketAt, 1.9, true, true);
    }
    this.ui.veil(1 - Math.min(1, (e.t - DOWN) / UP));
    this.ui.hide();
    if (e.t >= DOWN + UP) this.finish(city.hasRocket);
    return null;
  }

  private finish(landed: boolean) {
    if (this.done) return;
    this.done = true;
    this.o.city.flyRocket(null);
    this.o.stage.stopFollowing();
    SET?.rest();
    this.ui.remove();
    this.o.onDone(landed);
  }

  private screenAspect(): number {
    this.o.stage.renderer.getSize(this.aspect);
    return this.aspect.x / Math.max(1, this.aspect.y);
  }
}

/**
 * The trip's chrome, over the canvas: letterbox bars, the veil the cuts
 * happen under (a wipe up through the sky into stars on the way out, a
 * plain fade on the moon), a caption, and the Skip pill. The HUD steps
 * aside while it's up.
 */
class TripOverlay {
  private root: HTMLDivElement;
  private wipeEl: HTMLDivElement;
  private veilEl: HTMLDivElement;
  private bars: HTMLDivElement[];
  private captionEl: HTMLDivElement;
  private skipEl: HTMLButtonElement;
  private hud: HTMLElement | null;
  private onKey: (e: KeyboardEvent) => void;
  private captionOn = false;
  private hidden = false;
  level = 0;

  constructor(onSkip: () => void, animate: boolean) {
    const ease = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
    const dur = animate ? 560 : 1;
    this.root = el('div', 'position:fixed;inset:0;z-index:40;pointer-events:none;overflow:hidden;');
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Flying to your house on the moon');
    // The wipe: stars over black, fading through night blue to clear at its foot. It slides down over the city as the camera "tilts up".
    this.wipeEl = el('div', 'position:absolute;left:0;right:0;top:0;height:200%;transform:translateY(-100%);background:linear-gradient(to bottom, #020306 0%, #020306 50%, #071226 66%, rgba(23,52,98,0.82) 80%, rgba(60,110,170,0) 100%);will-change:transform;visibility:hidden;');
    const mask = 'linear-gradient(to bottom, #000 70%, transparent)';
    this.wipeEl.append(el('div', `position:absolute;left:0;right:0;top:0;height:68%;background:url(${starTile()}) repeat top left/512px 512px;mask-image:${mask};-webkit-mask-image:${mask};`));
    this.veilEl = el('div', 'position:absolute;inset:0;background:#020306;opacity:0;');
    const bar = (top: boolean) => el('div', `position:absolute;left:0;right:0;${top ? 'top' : 'bottom'}:0;height:min(10vh,88px);background:#020306;transform:translateY(${top ? '-100%' : '100%'});transition:transform ${dur}ms ${ease};`);
    this.bars = [bar(true), bar(false)];
    this.captionEl = el('div', `position:absolute;left:max(24px,5vw);bottom:calc(min(10vh,88px) + 22px);color:#f6eedf;opacity:0;transform:translateY(8px);transition:opacity ${dur}ms ${ease},transform ${dur}ms ${ease};text-shadow:0 1px 12px rgba(0,0,0,0.5);`);
    this.captionEl.innerHTML = `<div style="font:500 11px/1.4 var(--font-mono);letter-spacing:0.1em;text-transform:uppercase;color:rgba(246,238,223,0.72)">The moon · 384,400 km from the bay</div><div style="margin-top:6px;font:800 clamp(22px,3.2vw,30px)/1.02 var(--font-display);font-stretch:90%;letter-spacing:-0.03em">Your house on the moon</div>`;
    this.skipEl = document.createElement('button');
    this.skipEl.type = 'button';
    const coarse = matchMedia('(pointer: coarse)').matches;
    this.skipEl.innerHTML = `Skip${coarse ? '' : '<kbd style="margin-left:8px;padding:1px 5px;background:transparent;box-shadow:none;border-radius:5px;border:1px solid rgba(246,238,223,0.28);font:500 10.5px/1.4 var(--font-mono);color:rgba(246,238,223,0.75)">Esc</kbd>'}`;
    this.skipEl.setAttribute('aria-label', 'Skip the trip');
    this.skipEl.style.cssText = `position:absolute;right:max(16px,4vw);bottom:calc((min(10vh,88px) - 32px) / 2);height:32px;display:inline-flex;align-items:center;padding:0 14px;border-radius:999px;border:1px solid rgba(246,238,223,0.2);background:rgba(246,238,223,0.08);color:#f6eedf;font:550 13px/1 var(--font-ui);cursor:pointer;pointer-events:auto;opacity:0;transition:opacity ${dur}ms ${ease},background 120ms;`;
    this.skipEl.addEventListener('click', onSkip);
    this.skipEl.addEventListener('pointerenter', () => (this.skipEl.style.background = 'rgba(246,238,223,0.16)'));
    this.skipEl.addEventListener('pointerleave', () => (this.skipEl.style.background = 'rgba(246,238,223,0.08)'));
    this.root.append(this.wipeEl, this.veilEl, ...this.bars, this.captionEl, this.skipEl);
    this.hud = document.getElementById('ui');
    // While the trip plays, the keyboard belongs to it: Esc skips, nothing else reaches the city or the HUD.
    this.onKey = (e) => {
      if (e.key === 'Escape') onSkip();
      if (e.key === 'Tab' || ((e.key === 'Enter' || e.key === ' ') && e.target === this.skipEl)) return;
      e.stopImmediatePropagation();
      e.preventDefault();
    };
  }

  show() {
    document.body.append(this.root);
    window.addEventListener('keydown', this.onKey, true);
    if (this.hud) {
      this.hud.style.transition = 'opacity 320ms cubic-bezier(0.45, 0, 0.8, 0.3)';
      this.hud.style.opacity = '0';
      this.hud.style.pointerEvents = 'none';
      this.hud.setAttribute('aria-hidden', 'true');
      this.hud.inert = true;
    }
    // Next frame, so the transitions run from their start.
    requestAnimationFrame(() => {
      for (const b of this.bars) b.style.transform = 'translateY(0)';
      this.skipEl.style.opacity = '1';
    });
  }

  /** Bars away and the HUD back, ahead of the end. */
  hide() {
    if (this.hidden) return;
    this.hidden = true;
    this.bars[0]!.style.transform = 'translateY(-100%)';
    this.bars[1]!.style.transform = 'translateY(100%)';
    this.skipEl.style.opacity = '0';
    this.caption(false);
    this.restoreHud();
  }

  private restoreHud() {
    if (!this.hud) return;
    this.hud.style.transition = 'opacity 320ms cubic-bezier(0.2, 0.8, 0.2, 1)';
    this.hud.style.opacity = '';
    this.hud.style.pointerEvents = '';
    this.hud.removeAttribute('aria-hidden');
    this.hud.inert = false;
  }

  /** 0: the city, 1: covered by space (the wipe slid all the way down). */
  wipe(k: number) {
    this.wipeEl.style.visibility = k > 0 ? 'visible' : 'hidden';
    this.wipeEl.style.transform = `translateY(${(-100 + 100 * k).toFixed(2)}%)`;
  }

  /** The way back: the black lifts off the city upwards, as the camera comes down out of the sky. */
  unwipe(k: number) {
    this.veil(0);
    this.wipeEl.style.visibility = k < 1 ? 'visible' : 'hidden';
    this.wipeEl.style.transform = `translateY(${(-100 * k).toFixed(2)}%)`;
  }

  veil(k: number) {
    this.level = THREE.MathUtils.clamp(k, 0, 1);
    this.veilEl.style.opacity = this.level.toFixed(3);
    if (k > 0) this.wipeEl.style.visibility = 'hidden';
  }

  caption(on: boolean) {
    if (on === this.captionOn) return;
    this.captionOn = on;
    this.captionEl.style.opacity = on ? '1' : '0';
    this.captionEl.style.transform = on ? 'translateY(0)' : 'translateY(8px)';
  }

  remove() {
    window.removeEventListener('keydown', this.onKey, true);
    this.restoreHud();
    // Let the bars finish leaving before the overlay goes.
    this.hide();
    setTimeout(() => this.root.remove(), 600);
  }
}

function el(tag: 'div', css: string): HTMLDivElement {
  const e = document.createElement(tag);
  e.style.cssText = css;
  return e;
}

let STAR_TILE: string | null = null;

/** A tile of small stars for the wipe, drawn once. */
function starTile(): string {
  if (STAR_TILE) return STAR_TILE;
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d')!;
  const r = rng(11);
  for (let i = 0; i < 220; i++) {
    const s = r() ** 3 * 1.4 + 0.4;
    ctx.fillStyle = `rgba(255,${240 + Math.floor(r() * 15)},${220 + Math.floor(r() * 35)},${0.35 + r() * 0.6})`;
    ctx.beginPath();
    ctx.arc(r() * 512, r() * 512, s, 0, Math.PI * 2);
    ctx.fill();
  }
  STAR_TILE = c.toDataURL();
  return STAR_TILE;
}
