import * as THREE from 'three';
import { GeoBuilder, glowMaterial } from './geo.ts';
import { PALETTE } from './palette.ts';
import { palm, tree } from './buildings.ts';
import { cloudBank as cloudPuffs } from './models.ts';
import { hash, pick, rng } from '../world/rng.ts';

/** The flat land the city sits on. Ocean on three sides, hills behind. */
export const LAND = { minX: -22, maxX: 22, minZ: -24, maxZ: 22 } as const;
const BEACH = { x0: 22, x1: 27.5, z0: -22, z1: 22 } as const;
const WATER_Y = -0.4;
const HILL = { x0: -34, x1: 34, z0: -56, z1: -24 } as const;

/** Fixed places for things founders own, outside the city grid. */
export const ISLAND = { x: -13, z: 28.6, r: 3.3 } as const;
export const LAUNCH = { x: -8.9, z: 33.4, r: 2.3 } as const;
export const AIRPORT = { x0: 31, x1: 41, z0: -16, z1: 14 } as const;
/** Planes park on the apron facing the runway (+x). */
export const AIRPORT_SLOTS = [-9, -5, -1, 3].map((z) => ({ x: 34.4, z }));
export const MARINA_SLOTS = [8, 10.6, 13.2].map((z) => ({ x: -27.6, z }));
export const SUPERYACHT = { x: -9.2, z: 25.2 } as const;
/** The founder's lots: one downtown (on the HQ block), one at the top of the Hills. */
export const DOWNTOWN_HOME = { x: -1.5, z: 1.5 } as const;
export const HILLS_HOME = { x: 12, z: -33.4 } as const;
/** TinyTown Hills, the neighbourhood on the slope right of the sign. */
const HILLS_HOOD = { x0: 0, x1: 22, z0: -35, z1: -24 } as const;

export interface SceneryState {
  hills: boolean;
  island: boolean;
  launch: boolean;
  ferris: boolean;
  coaster: boolean;
  /** The TINYTOWN sign's lights are paid for. */
  signLit: boolean;
  lampsFailing: boolean;
  bridgeRusting: boolean;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Height of the hills behind town. 0 at the edge of the flat land, dropping into the sea at the sides. */
export function hillHeight(x: number, z: number): number {
  const d = LAND.minZ - z;
  if (d <= 0) return 0;
  const ridge = 5.6 + 1.6 * Math.sin(x * 0.17 + 0.5) + 0.9 * Math.sin(x * 0.41 + 2) + 0.5 * Math.sin(x * 0.9);
  const rise = smoothstep(0, 10, d);
  const fall = 1 - smoothstep(20, 32, d);
  const xmask = smoothstep(HILL.x0 + 1, HILL.x0 + 9, x) * (1 - smoothstep(HILL.x1 - 9, HILL.x1 - 1, x));
  const bumps = 0.35 * Math.sin(x * 1.3) * Math.sin(z * 1.1) * rise;
  return -0.7 + (ridge * rise * fall + bumps + 0.7) * xmask;
}

/**
 * Everything around the city that isn't driven by metrics: the coast, the
 * bay, the hills and their sign, the pier, the bridge, boats.
 */
export class Scenery {
  readonly object = new THREE.Group();
  private normals: THREE.Texture;
  private wheel = new THREE.Group();
  private beam: THREE.Mesh;
  private beamMat: THREE.MeshBasicMaterial;
  private signMat: THREE.MeshStandardMaterial;
  private boats: { obj: THREE.Object3D; path: (t: number) => [number, number, number]; t: number; speed: number }[] = [];
  /** Emissive materials for the city to drive between day and night. */
  readonly glows: THREE.MeshBasicMaterial[] = [];
  private seed: number;
  private coaster = new THREE.Group();
  private wheelSet = new THREE.Group();
  private bridgeMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.82, metalness: 0.05 });
  private hood = new THREE.Group();
  private hillCars: { obj: THREE.Object3D; t: number; speed: number }[] = [];
  private hillRoad!: THREE.CatmullRomCurve3;
  private clouds: Record<'hills' | 'island' | 'launch', THREE.Group> = { hills: new THREE.Group(), island: new THREE.Group(), launch: new THREE.Group() };
  private islandExtras = new THREE.Group();
  private launchPad = new THREE.Group();
  private state: SceneryState = { hills: false, island: false, launch: false, ferris: false, coaster: false, signLit: true, lampsFailing: false, bridgeRusting: false };
  private signFlicker = 0;

  constructor(seed: number) {
    this.seed = seed;
    this.normals = waterNormals();
    this.object.add(this.ocean(), this.land(), this.hills(), this.pier(), this.bridge(), this.island(), this.coastline(), this.airport());
    this.object.add(this.hood, this.clouds.hills, this.clouds.island, this.clouds.launch, this.islandExtras, this.launchPad);
    this.buildHood();
    this.buildClouds();
    this.signMat = this.sign();
    this.beamMat = glowMaterial({ color: 0xfff2c0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.beam = new THREE.Mesh(new THREE.ConeGeometry(1.2, 9, 12, 1, true).rotateZ(Math.PI / 2).translate(-4.5, 0, 0), this.beamMat);
    this.beam.position.set(-44, 2.3, 18);
    this.object.add(this.beam);
    this.addBoats();
  }

  private add(b: GeoBuilder, receive = true): THREE.Group {
    const { group, glow } = b.build();
    group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.receiveShadow = receive;
    });
    if (glow) this.glows.push(glow);
    return group;
  }

  // ─── Water ──────────────────────────────────────────────────────────────

  private ocean(): THREE.Group {
    const g = new THREE.Group();
    const deep = new THREE.Mesh(
      new THREE.PlaneGeometry(600, 600).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: PALETTE.water, roughness: 0.18, metalness: 0.15, normalMap: this.normals, normalScale: new THREE.Vector2(0.3, 0.3) }),
    );
    deep.position.y = WATER_Y - 0.02;
    deep.receiveShadow = true;

    const shallows = new THREE.Mesh(
      new THREE.PlaneGeometry(160, 160).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: shallowsTexture(), transparent: true, roughness: 0.22, metalness: 0.1, normalMap: this.normals, normalScale: new THREE.Vector2(0.3, 0.3), depthWrite: false }),
    );
    shallows.position.set(0, WATER_Y - 0.01, -10);
    shallows.receiveShadow = true;
    g.add(deep, shallows);
    return g;
  }

  // ─── Land, beach, promenade ─────────────────────────────────────────────

  private land(): THREE.Group {
    const g = new THREE.Group();
    const w = LAND.maxX - LAND.minX;
    const d = LAND.maxZ - LAND.minZ;
    const top = new THREE.MeshStandardMaterial({ color: PALETTE.grass, roughness: 1 });
    const wall = new THREE.MeshStandardMaterial({ color: PALETTE.seawall, roughness: 0.9 });
    const slab = new THREE.Mesh(new THREE.BoxGeometry(w, 1.6, d), [wall, wall, top, wall, wall, wall]);
    slab.position.set((LAND.minX + LAND.maxX) / 2, -0.8, (LAND.minZ + LAND.maxZ) / 2);
    slab.receiveShadow = true;
    g.add(slab);

    // Beach: a sand ramp from the promenade into the sea.
    const profile = new THREE.Shape([
      new THREE.Vector2(0, -1.6),
      new THREE.Vector2(BEACH.x1 - BEACH.x0, -1.6),
      new THREE.Vector2(BEACH.x1 - BEACH.x0, WATER_Y - 0.15),
      new THREE.Vector2(1.6, -0.03),
      new THREE.Vector2(0, -0.03),
    ]);
    const ramp = new THREE.ExtrudeGeometry(profile, { depth: BEACH.z1 - BEACH.z0, bevelEnabled: false });
    ramp.translate(BEACH.x0, 0, BEACH.z0);
    const sand = new THREE.Mesh(ramp, new THREE.MeshStandardMaterial({ color: PALETTE.sand, roughness: 1 }));
    sand.receiveShadow = true;
    g.add(sand);
    return g;
  }

  /** Promenade, palms, beach furniture and lamps along the coast. */
  private coastline(): THREE.Group {
    const r = rng(hash(this.seed, 'coast'));
    const b = new GeoBuilder();
    // Promenade paths along the bay (−x and +z) and the beach (+x)
    b.box(0.9, 0.02, LAND.maxZ - LAND.minZ, LAND.minX + 0.5, 0, (LAND.minZ + LAND.maxZ) / 2, PALETTE.sidewalk);
    b.box(LAND.maxX - LAND.minX, 0.02, 0.9, 0, 0, LAND.maxZ - 0.5, PALETTE.sidewalk);
    b.box(1.0, 0.02, BEACH.z1 - BEACH.z0, LAND.maxX + 0.5, -0.02, 0, PALETTE.sidewalk);
    for (let u = LAND.minZ + 1; u < LAND.maxZ; u += 0.5) b.box(0.03, 0.12, 0.03, LAND.minX + 0.05, 0, u, PALETTE.trim);
    for (let u = LAND.minX + 1; u < LAND.maxX; u += 0.5) b.box(0.03, 0.12, 0.03, u, 0, LAND.maxZ - 0.05, PALETTE.trim);
    b.box(0.03, 0.03, LAND.maxZ - LAND.minZ, LAND.minX + 0.05, 0.12, (LAND.minZ + LAND.maxZ) / 2, PALETTE.trim);
    b.box(LAND.maxX - LAND.minX, 0.03, 0.03, 0, 0.12, LAND.maxZ - 0.05, PALETTE.trim);

    // Lamps along the promenades
    for (let u = LAND.minZ + 2; u < LAND.maxZ - 1; u += 3.2) lamp(b, LAND.minX + 0.9, u);
    for (let u = LAND.minX + 2; u < LAND.maxX - 1; u += 3.2) lamp(b, u, LAND.maxZ - 0.9);
    for (let u = BEACH.z0 + 1; u < BEACH.z1 - 1; u += 3.2) lamp(b, LAND.maxX + 0.9, u);

    // Green strip between the city and the coast: palms and trees
    const inStrip = (x: number, z: number) =>
      (Math.abs(x) > 20.4 || Math.abs(z) > 20.4 || z < -20.4) && x > LAND.minX + 1.3 && x < LAND.maxX - 0.3 && z > LAND.minZ + 0.3 && z < LAND.maxZ - 1.3;
    for (let i = 0; i < 700; i++) {
      const x = LAND.minX + r() * (LAND.maxX - LAND.minX);
      const z = LAND.minZ + r() * (LAND.maxZ - LAND.minZ);
      if (!inStrip(x, z)) continue;
      if (Math.abs(Math.abs(x) - 19.6) < 0.5 || Math.abs(Math.abs(z) - 19.6) < 0.5) continue; // train pillars
      tree(b, r, x, z, 1.1);
    }
    // A row of palms along the beach promenade
    for (let u = BEACH.z0 + 0.8; u < BEACH.z1; u += 1.6) palm(b, r, LAND.maxX + 1.2, u + (r() - 0.5) * 0.4, 1.5, -0.02);

    // Beach life: umbrellas, towels, a lifeguard tower, volleyball
    for (let i = 0; i < 26; i++) {
      const x = BEACH.x0 + 2.2 + r() * 2.2;
      const z = BEACH.z0 + 1 + r() * (BEACH.z1 - BEACH.z0 - 2);
      const y = beachY(x);
      const c = pick(r, [0xe85a4a, 0xf2c84b, 0x3aa3c8, 0xf28ab2, 0x5ac46a, 0xffffff] as const);
      b.cylinder(0.01, 0.01, 0.34, x, y, z, PALETTE.trim, 4);
      b.cylinder(0, 0.24, 0.09, x, y + 0.3, z, c, 8);
      b.box(0.14, 0.006, 0.26, x + 0.18, y + 0.005, z + 0.05, pick(r, [0xf2c84b, 0x3aa3c8, 0xe85a4a, 0xffffff] as const));
    }
    for (const z of [-12, 6]) {
      const x = BEACH.x0 + 3.2;
      const y = beachY(x);
      for (const [lx, lz] of [[-0.15, -0.15], [0.15, -0.15], [-0.15, 0.15], [0.15, 0.15]] as const) b.box(0.03, 0.5, 0.03, x + lx, y, z + lz, PALETTE.trim);
      b.box(0.4, 0.3, 0.4, x, y + 0.5, z, 0xf2c84b);
      b.gable(0.48, 0.14, 0.48, x, y + 0.8, z, 0xe85a4a, 0.02);
      b.box(0.5, 0.03, 0.12, x + 0.3, y + 0.5, z, PALETTE.wood);
    }
    b.box(0.015, 0.3, 0.015, BEACH.x0 + 3, beachY(BEACH.x0 + 3), -3, PALETTE.trim);
    b.box(0.015, 0.3, 0.015, BEACH.x0 + 3, beachY(BEACH.x0 + 3), -1.6, PALETTE.trim);
    b.box(0.01, 0.1, 1.4, BEACH.x0 + 3, beachY(BEACH.x0 + 3) + 0.2, -2.3, 0xf5f5f5);

    // Marina at the bay corner, with moored boats
    for (let k = 0; k < 4; k++) {
      const z = 8 + k * 2.6;
      b.box(4.5, 0.08, 0.35, LAND.minX - 2.25, WATER_Y + 0.12, z, PALETTE.wood);
      for (let s = 0; s < 3; s++) moored(b, r, LAND.minX - 1.2 - s * 1.3, z + 0.55);
    }
    return this.add(b);
  }

  // ─── Hills and the sign ─────────────────────────────────────────────────

  private hills(): THREE.Group {
    const r = rng(hash(this.seed, 'hills'));
    const w = HILL.x1 - HILL.x0;
    const d = HILL.z1 - HILL.z0;
    const geo = new THREE.PlaneGeometry(w, d, 96, 48).rotateX(-Math.PI / 2);
    geo.translate((HILL.x0 + HILL.x1) / 2, 0, (HILL.z0 + HILL.z1) / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const green = new THREE.Color(PALETTE.hillGreen);
    const gold = new THREE.Color(PALETTE.hillGold);
    const dry = new THREE.Color(PALETTE.hillDry);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = hillHeight(x, z);
      pos.setY(i, h);
      const patch = 0.5 + 0.5 * Math.sin(x * 0.7 + Math.sin(z * 0.5) * 2) * Math.cos(z * 0.6);
      c.copy(green).lerp(gold, Math.min(1, Math.max(0, h / 6 + (patch - 0.5) * 0.6)));
      if (h > 5.5) c.lerp(dry, 0.4);
      if (h < 0.05) c.set(PALETTE.sand);
      colors.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const hill = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 }));
    hill.receiveShadow = true;
    hill.castShadow = true;

    const b = new GeoBuilder();
    // Trees thicken in the gullies; keep the sign's slope clear.
    let peak = { x: 0, z: 0, h: 0 };
    for (let i = 0; i < 520; i++) {
      const x = HILL.x0 + 4 + r() * (w - 8);
      const z = HILL.z0 + 4 + r() * (d - 4);
      const h = hillHeight(x, z);
      if (h > peak.h) peak = { x, z, h };
      if (h < 0.2 || inSignArea(x, z) || inHood(x, z)) continue;
      if (r() > 0.85 - h * 0.08) continue;
      tree(b, r, x, z, 1.3, h - 0.05, r() < 0.55 ? 'cypress' : r() < 0.7 ? 'round' : 'palm');
    }
    // Radio tower on the highest point, with a red warning light
    for (const [lx, lz] of [[-0.2, -0.2], [0.2, -0.2], [0, 0.2]] as const) b.cylinder(0.03, 0.05, 3.2, peak.x + lx, peak.h - 0.1, peak.z + lz, 0xd0d4dc, 4);
    for (let k = 0; k < 6; k++) b.box(0.4, 0.03, 0.4, peak.x, peak.h + 0.3 + k * 0.5, peak.z, 0xe85a4a);
    b.blob(0.08, peak.x, peak.h + 3.2, peak.z, [3, 0.3, 0.2], true);

    const g = new THREE.Group();
    g.add(hill, this.add(b));
    return g;
  }

  /** TINYTOWN, Hollywood style, on the slope facing town. */
  private sign(): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({ color: 0xfafaf5, roughness: 0.6, emissive: 0xfff4dc, emissiveIntensity: 0 });
    const post = new THREE.MeshStandardMaterial({ color: 0x55504a, roughness: 0.9 });
    const g = new THREE.Group();
    const letters = 'TINYTOWN';
    const height = 2.6;
    const gap = 0.42;
    const widths = [...letters].map((ch) => LETTER_WIDTH[ch]! * height);
    const total = widths.reduce((a, b) => a + b, 0) + gap * (letters.length - 1);
    const right = new THREE.Vector3(Math.SQRT1_2, 0, -Math.SQRT1_2);
    const centre = new THREE.Vector3(SIGN.x, 0, SIGN.z);
    const centreY = hillHeight(SIGN.x, SIGN.z);
    let u = -total / 2;
    [...letters].forEach((ch, i) => {
      const w = widths[i]!;
      const p = centre.clone().addScaledVector(right, u + w / 2);
      // Follow the slope, but only partly, so the letters read as one line.
      const y = Math.max(hillHeight(p.x, p.z) - 0.25, hillHeight(p.x, p.z) * 0.3 + centreY * 0.7);
      const shape = letterShape(ch, height);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.14, bevelEnabled: false });
      geo.translate(-w / 2, 0, 0);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.position.set(p.x, y - 0.1 + Math.sin(i * 1.7) * 0.1, p.z);
      mesh.rotation.set(-0.12, Math.PI / 4 + Math.sin(i * 2.3) * 0.04, 0, 'YXZ');
      g.add(mesh);
      for (const s of [-0.3, 0.3]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, height * 0.9, 0.06), post);
        const q = p.clone().addScaledVector(right, s * w).add(new THREE.Vector3(-0.25, 0, -0.25));
        leg.position.set(q.x, y + height * 0.35, q.z);
        g.add(leg);
      }
      u += w + gap;
    });
    this.object.add(g);
    return mat;
  }

  // ─── Pier and Ferris wheel ──────────────────────────────────────────────

  private pier(): THREE.Group {
    const r = rng(hash(this.seed, 'pier'));
    const b = new GeoBuilder();
    const x0 = -6.2;
    const x1 = -2.2;
    const z0 = LAND.maxZ - 0.2;
    const z1 = LAND.maxZ + 13;
    const y = 0.15;
    b.box(x1 - x0, 0.1, z1 - z0, (x0 + x1) / 2, y, (z0 + z1) / 2, PALETTE.wood);
    for (let z = z0 + 0.6; z < z1; z += 1.1) {
      for (const x of [x0 + 0.2, (x0 + x1) / 2, x1 - 0.2]) b.cylinder(0.06, 0.06, y - WATER_Y + 0.4, x, WATER_Y - 0.4, z, 0x6b5340, 5);
    }
    for (let z = z0 + 0.4; z < z1; z += 0.45) {
      b.box(0.03, 0.14, 0.03, x0 + 0.03, y + 0.1, z, PALETTE.trim);
      b.box(0.03, 0.14, 0.03, x1 - 0.03, y + 0.1, z, PALETTE.trim);
    }
    // Arcade huts and a carousel tent
    for (let k = 0; k < 4; k++) {
      const z = z0 + 1.2 + k * 1.3;
      const c = pick(r, [0xf28ab2, 0x3aa3c8, 0xf2c84b, 0x5ac46a] as const);
      b.box(1.0, 0.5, 0.9, x0 + 0.8, y + 0.1, z, c);
      b.gable(1.0, 0.18, 0.9, x0 + 0.8, y + 0.6, z, PALETTE.trim, 0.04);
      b.quad(0.6, 0.18, x0 + 1.31, y + 0.32, z, 'x+', [1.8, 1.3, 0.6]);
    }
    b.cylinder(0.75, 0.75, 0.4, x1 - 1.2, y + 0.1, z0 + 3.2, 0xf8f5ee, 12);
    b.cylinder(0.02, 0.85, 0.5, x1 - 1.2, y + 0.5, z0 + 3.2, 0xe85a4a, 12);
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      b.blob(0.03, x1 - 1.2 + Math.cos(a) * 0.8, y + 0.5, z0 + 3.2 + Math.sin(a) * 0.8, PALETTE.lamp, true);
    }
    for (let z = z0 + 1; z < z1; z += 2.4) lamp(b, x1 - 0.25, z, y + 0.05);

    const g = new THREE.Group();
    g.add(this.add(b));

    // The wheel
    const cx = (x0 + x1) / 2 + 0.3;
    const cz = z1 - 3.2;
    const radius = 1.9;
    const hub = radius + 0.55;
    const frame = new GeoBuilder();
    for (const s of [-1, 1]) {
      for (const lean of [-0.55, 0.55]) {
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3(lean * 0.5, hub / 2 + y, s * 0.28),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, lean * 0.45)),
          new THREE.Vector3(1, 1, 1),
        );
        frame.transformed(new THREE.BoxGeometry(0.08, hub + 0.1, 0.08), m, 0xf2f2f2);
      }
    }
    frame.box(1.6, 0.12, 0.9, 0, y, 0, 0xe85a4a);
    const support = this.add(frame);
    support.position.set(cx, 0, cz);
    support.rotation.y = Math.PI / 4;
    this.wheelSet.add(support);

    const wb = new GeoBuilder();
    const spokes = 16;
    for (let k = 0; k < spokes; k++) {
      const a = (k / spokes) * Math.PI * 2;
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3((Math.cos(a) * radius) / 2, (Math.sin(a) * radius) / 2, 0),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, a)),
        new THREE.Vector3(1, 1, 1),
      );
      wb.transformed(new THREE.BoxGeometry(radius, 0.03, 0.03), m, 0xf2f2f2);
      wb.blob(0.035, Math.cos(a) * radius, Math.sin(a) * radius, 0, [2.6, 1.2, 2.2], true);
      wb.blob(0.03, Math.cos(a + Math.PI / spokes) * radius, Math.sin(a + Math.PI / spokes) * radius, 0, [1.2, 2.2, 2.6], true);
    }
    const rim = new THREE.TorusGeometry(radius, 0.04, 6, 48);
    wb.transformed(rim, new THREE.Matrix4(), 0xf2f2f2);
    const wheel = this.add(wb, false);
    this.wheel.add(wheel);
    // Gondolas hang below the rim and stay upright as it turns.
    for (let k = 0; k < spokes; k += 2) {
      const gondola = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.2, 0.2), new THREE.MeshStandardMaterial({ color: pick(r, [0xe85a4a, 0xf2c84b, 0x3aa3c8, 0x5ac46a] as const), roughness: 0.5 }));
      gondola.userData.angle = (k / spokes) * Math.PI * 2;
      gondola.userData.radius = radius;
      gondola.castShadow = true;
      this.wheel.add(gondola);
    }
    this.wheel.position.set(cx, hub + y, cz);
    this.wheel.rotation.y = Math.PI / 4;
    this.wheelSet.add(this.wheel);
    this.buildCoaster(x1, z0, y);
    g.add(this.wheelSet, this.coaster);
    return g;
  }

  /** Pier roller coaster: a looping track over the right half of the pier. */
  private buildCoaster(x1: number, z0: number, y: number) {
    const b = new GeoBuilder();
    const cx = x1 - 1.0;
    const cz = z0 + 6.6;
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k < 20; k++) {
      const a = (k / 20) * Math.PI * 2;
      pts.push(new THREE.Vector3(cx + Math.cos(a) * 0.75, y + 0.7 + 0.55 * Math.sin(a * 2) + (k === 5 ? 0.9 : 0), cz + Math.sin(a) * 2.1));
    }
    const curve = new THREE.CatmullRomCurve3(pts, true);
    b.transformed(new THREE.TubeGeometry(curve, 120, 0.045, 5, true), new THREE.Matrix4(), 0x2f8fd8);
    for (let k = 0; k < 20; k += 2) {
      const p = curve.getPointAt(k / 20);
      b.box(0.035, p.y - y, 0.035, p.x, y + 0.05, p.z, PALETTE.trim);
    }
    for (let k = 0; k < 16; k++) {
      const p = curve.getPointAt(k / 16);
      b.blob(0.03, p.x, p.y + 0.06, p.z, [2.6, 1.6, 0.6], true);
    }
    this.coaster.add(this.add(b, false));
  }

  // ─── Suspension bridge across the bay ───────────────────────────────────

  private bridge(): THREE.Group {
    const b = new GeoBuilder();
    const z = -9.5;
    const deckY = 2.4;
    const start = LAND.minX - 0.5;
    const end = -110;
    const towers = [-36, -76];
    const towerTop = 10;
    const half = 0.75;
    const red = PALETTE.bridge;

    // Approach viaduct up from the promenade
    const ramp = new THREE.BoxGeometry(6, 0.3, 1.5);
    const tilt = new THREE.Matrix4().compose(
      new THREE.Vector3(start - 2.6, deckY / 2 - 0.05, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -Math.atan2(deckY, 5.2))),
      new THREE.Vector3(1, 1, 1),
    );
    b.transformed(ramp, tilt, PALETTE.concrete);
    b.box(start - 5.4 - end, 0.22, 1.5, (start - 5.4 + end) / 2, deckY - 0.22, z, 0x55585f);
    b.box(start - 5.4 - end, 0.25, 0.08, (start - 5.4 + end) / 2, deckY - 0.45, z - half, red);
    b.box(start - 5.4 - end, 0.25, 0.08, (start - 5.4 + end) / 2, deckY - 0.45, z + half, red);
    for (const tx of towers) {
      for (const s of [-1, 1]) b.box(0.32, towerTop - WATER_Y, 0.28, tx, WATER_Y, z + s * half, red);
      for (const hy of [deckY + 1.5, deckY + 4, towerTop - 0.4]) b.box(0.28, 0.35, half * 2 + 0.28, tx, hy, z, red);
      b.box(1.2, 0.6, 2.4, tx, WATER_Y - 0.3, z, PALETTE.concrete);
    }
    for (let x = start - 6; x > end; x -= 2.6) b.box(0.3, deckY - WATER_Y - 0.4, 0.3, x, WATER_Y, z, PALETTE.concrete);

    // Main cables: catenaries between anchorage, towers and the far end
    const anchors: [number, number][] = [[start - 5, deckY + 0.2], [towers[0]!, towerTop], [towers[1]!, towerTop], [end + 10, deckY + 1.5]];
    for (const s of [-1, 1]) {
      const pts: THREE.Vector3[] = [];
      for (let seg = 0; seg < anchors.length - 1; seg++) {
        const [xa, ya] = anchors[seg]!;
        const [xb, yb] = anchors[seg + 1]!;
        const sag = seg === 1 ? 6.5 : 1.2;
        for (let k = 0; k <= 16; k++) {
          const t = k / 16;
          pts.push(new THREE.Vector3(xa + (xb - xa) * t, ya + (yb - ya) * t - sag * 4 * t * (1 - t), z + s * half));
        }
      }
      const cable = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 160, 0.06, 5);
      b.transformed(cable, new THREE.Matrix4(), red);
      for (let i = 1; i < pts.length - 1; i += 1) {
        const p = pts[i]!;
        const len = p.y - deckY;
        if (len > 0.15) b.box(0.025, len, 0.025, p.x, deckY, p.z, red);
      }
      for (let x = start - 6; x > end; x -= 2.2) b.blob(0.05, x, deckY + 0.15, z + s * (half - 0.05), PALETTE.lamp, true);
    }
    for (const tx of towers) b.blob(0.09, tx, towerTop + 0.1, z, [3, 0.3, 0.2], true);
    const g = this.add(b);
    g.traverse((o) => {
      if (o instanceof THREE.Mesh && !(o.material instanceof THREE.MeshBasicMaterial)) {
        o.material = this.bridgeMat;
        o.castShadow = true;
      }
    });
    return g;
  }

  private island(): THREE.Group {
    const r = rng(hash(this.seed, 'island'));
    const b = new GeoBuilder();
    const { x, z, r: rad } = ISLAND;
    b.cylinder(rad, rad + 0.6, 1.0, x, WATER_Y - 0.6, z, 0x9c8a6e, 11);
    b.cylinder(rad - 0.1, rad + 0.2, 0.5, x, -0.45, z, 0xd8c08a, 11);
    b.cylinder(rad - 0.3, rad - 0.1, 0.06, x, 0.02, z, PALETTE.hillGreen, 11);
    // Launch lobe
    b.cylinder(LAUNCH.r, LAUNCH.r + 0.5, 1.0, LAUNCH.x, WATER_Y - 0.6, LAUNCH.z, 0x9c8a6e, 9);
    b.cylinder(LAUNCH.r - 0.1, LAUNCH.r + 0.15, 0.5, LAUNCH.x, -0.45, LAUNCH.z, 0xbdb6a8, 9);
    for (let i = 0; i < 7; i++) {
      const a = r() * Math.PI * 2;
      const d = rad - 0.6 - r() * 0.5;
      palm(b, r, x + Math.cos(a) * d, z + Math.sin(a) * d, 0.9, 0.06);
    }
    // Lighthouse on the far point
    const lx = x - rad + 0.6;
    const lz = z + 0.9;
    b.cylinder(0.18, 0.24, 1.3, lx, 0.06, lz, PALETTE.trim, 8);
    b.cylinder(0.2, 0.2, 0.12, lx, 1.36, lz, 0xe85a4a, 8);
    b.blob(0.14, lx, 1.56, lz, [3, 2.6, 1.6], true);
    b.cylinder(0.02, 0.22, 0.2, lx, 1.68, lz, 0xe85a4a, 8);
    this.beamCentre.set(lx, 1.56, lz);

    // Launch site, revealed at $1M MRR
    const pad = new GeoBuilder();
    pad.cylinder(1.3, 1.3, 0.08, LAUNCH.x, 0.05, LAUNCH.z, PALETTE.concrete, 16);
    pad.cylinder(0.5, 0.5, 0.02, LAUNCH.x, 0.13, LAUNCH.z, 0x2a2a30, 12);
    pad.box(0.3, 3.2, 0.3, LAUNCH.x + 0.9, 0.13, LAUNCH.z - 0.5, 0xd8402e);
    for (let k = 0; k < 6; k++) pad.box(0.32, 0.03, 0.32, LAUNCH.x + 0.9, 0.5 + k * 0.5, LAUNCH.z - 0.5, PALETTE.trim);
    pad.box(0.6, 0.05, 0.06, LAUNCH.x + 0.6, 2.6, LAUNCH.z - 0.35, 0xd8402e);
    pad.blob(0.06, LAUNCH.x + 0.9, 3.4, LAUNCH.z - 0.5, [3, 0.3, 0.2], true);
    this.launchPad.add(this.add(pad));
    return this.add(b);
  }
  private beamCentre = new THREE.Vector3();

  // ─── Airport: free infrastructure for every city ────────────────────────

  private airport(): THREE.Group {
    const r = rng(hash(this.seed, 'airport'));
    const g = new THREE.Group();
    const { x0, x1, z0, z1 } = AIRPORT;
    const land = new THREE.Mesh(
      new THREE.BoxGeometry(x1 - x0, 1.6, z1 - z0),
      [0, 0, 1, 0, 0, 0].map((i) => new THREE.MeshStandardMaterial({ color: i ? PALETTE.grass : PALETTE.seawall, roughness: 1 })),
    );
    land.position.set((x0 + x1) / 2, -0.8, (z0 + z1) / 2);
    land.receiveShadow = true;
    g.add(land);

    const b = new GeoBuilder();
    // Causeway from the beach
    b.box(BEACH.x1 - BEACH.x0 + (x0 - BEACH.x1) + 0.5, 0.3, 1.2, (BEACH.x0 + x0) / 2 + 0.2, -0.28, -6, PALETTE.concrete);
    b.box(x0 - BEACH.x0 + 0.5, 0.02, 0.8, (BEACH.x0 + x0) / 2 + 0.2, 0.02, -6, PALETTE.road);
    // Runway with markings
    const rx = 38.4;
    b.box(1.8, 0.02, z1 - z0 - 1.5, rx, 0, (z0 + z1) / 2, 0x4a4e58);
    for (let z = z0 + 2.5; z < z1 - 2.5; z += 1.4) b.box(0.08, 0.005, 0.7, rx, 0.022, z, PALETTE.trim);
    for (const end of [z0 + 1.2, z1 - 1.2]) for (let k = -3; k <= 3; k++) b.box(0.1, 0.005, 0.6, rx + k * 0.22, 0.022, end, PALETTE.trim);
    // Taxiway and apron
    b.box(0.9, 0.02, 16, 36.6, 0, -3, 0x5d616c);
    b.box(2.4, 0.02, 15, 34.4, 0, -3, 0x6a6e78);
    for (const s of AIRPORT_SLOTS) b.box(1.6, 0.004, 0.03, s.x, 0.022, s.z + 1.0, 0xf2c84b);
    // Terminal, tower, hangars
    b.box(1.6, 0.6, 4.2, 32.2, 0, 2.6, 0xe9eef2);
    b.box(1.7, 0.06, 4.3, 32.2, 0.6, 2.6, PALETTE.trim);
    b.windows({ w: 1.6, d: 4.2, x: 32.2, z: 2.6, y0: 0, rows: 1, rowHeight: 0.6, cols: 10, faces: ['x+', 'z+'] }, r, 0.9, PALETTE.windowCool, { w: 0.3, h: 0.36 });
    b.cylinder(0.22, 0.28, 2.2, 32.4, 0, 6.2, PALETTE.trim, 8);
    b.cylinder(0.5, 0.42, 0.4, 32.4, 2.2, 6.2, 0x7db3dd, 8);
    b.cylinder(0.52, 0.52, 0.05, 32.4, 2.6, 6.2, PALETTE.trim, 8);
    b.blob(0.06, 32.4, 2.75, 6.2, [3, 0.3, 0.2], true);
    for (const hz of [-12.5, -9.4]) {
      b.box(2.2, 0.9, 2.4, 32.6, 0, hz, 0xd9dde4);
      const roof = new THREE.CylinderGeometry(1.2, 1.2, 2.4, 12, 1, false, 0, Math.PI).rotateX(Math.PI / 2).rotateY(Math.PI / 2).scale(0.92, 0.5, 1);
      b.transformed(roof, new THREE.Matrix4().makeTranslation(32.6, 0.9, hz), 0xb9c0ca);
    }
    b.box(0.03, 0.6, 0.03, 40.4, 0, 9, PALETTE.steel);
    b.box(0.3, 0.08, 0.08, 40.55, 0.55, 9, 0xf28a3a); // windsock
    for (let z = z0 + 1; z < z1; z += 2) {
      b.blob(0.035, rx - 1.0, 0.05, z, [3, 2.6, 1.6], true);
      b.blob(0.035, rx + 1.0, 0.05, z, [3, 2.6, 1.6], true);
    }
    for (let i = 0; i < 18; i++) palm(b, r, x0 + 0.4 + r() * 0.6, z0 + 1 + r() * (z1 - z0 - 2), 1.0);
    g.add(this.add(b));
    return g;
  }

  // ─── TinyTown Hills ─────────────────────────────────────────────────────

  /** A switchback road up the slope with villas either side; hidden until the Hills open. */
  private buildHood() {
    const r = rng(hash(this.seed, 'hood'));
    const way: [number, number][] = [[3, -24.3], [19, -25.6], [20.4, -27.1], [5, -28.2], [3.6, -29.7], [19.5, -30.8], [20.6, -32.2], [14, -33.6]];
    const pts = way.map(([x, z]) => new THREE.Vector3(x, hillHeight(x, z) + 0.04, z));
    this.hillRoad = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const n = 220;
    const pos: number[] = [];
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i <= n; i++) {
      const p = this.hillRoad.getPointAt(i / n);
      const t = this.hillRoad.getTangentAt(i / n);
      const side = new THREE.Vector3().crossVectors(t, up).normalize().multiplyScalar(0.28);
      const l = p.clone().add(side);
      const rr = p.clone().sub(side);
      l.y = hillHeight(l.x, l.z) + 0.05;
      rr.y = hillHeight(rr.x, rr.z) + 0.05;
      pos.push(l.x, l.y, l.z, rr.x, rr.y, rr.z);
    }
    const idx: number[] = [];
    for (let i = 0; i < n; i++) idx.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
    const road = new THREE.BufferGeometry();
    road.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    road.setIndex(idx);
    road.computeVertexNormals();
    const roadMesh = new THREE.Mesh(road, new THREE.MeshStandardMaterial({ color: PALETTE.road, roughness: 0.6, side: THREE.DoubleSide }));
    roadMesh.receiveShadow = true;
    this.hood.add(roadMesh);

    const b = new GeoBuilder();
    for (let i = 1; i < 28; i++) {
      const u = i / 28;
      const p = this.hillRoad.getPointAt(u);
      const t = this.hillRoad.getTangentAt(u);
      const s = i % 2 ? 1 : -1;
      const off = new THREE.Vector3(-t.z, 0, t.x).normalize().multiplyScalar(s * 1.05);
      const x = p.x + off.x;
      const z = p.z + off.z;
      if (Math.hypot(x - HILLS_HOME.x, z - HILLS_HOME.z) < 2.2 || !inHood(x, z)) continue;
      const h = hillHeight(x, z);
      const wall = pick(r, [0xf8f5ee, 0xf6e7c8, 0xf3c6a2, 0xe8e2d6] as const);
      b.box(1.1, 0.06, 0.9, x, h - 0.12, z, 0xe8e2d6);
      b.box(0.8, 0.34, 0.55, x, h - 0.06, z, wall);
      if (r() < 0.5) b.hip(0.8, 0.14, 0.55, x, h + 0.28, z, PALETTE.roofs[0]);
      else b.box(0.88, 0.04, 0.63, x, h + 0.28, z, PALETTE.trim);
      b.quad(0.5, 0.16, x, h + 0.1, z + 0.279, 'z+', [1.6, 1.05, 0.5], true);
      b.box(0.36, 0.015, 0.22, x + 0.35, h - 0.06, z + 0.3, PALETTE.pool);
      palm(b, r, x - 0.45, z + 0.35, 0.8, h - 0.06);
    }
    this.hood.add(this.add(b));

    // Nice cars on the hill road
    for (let i = 0; i < 4; i++) {
      const car = luxuryCar(r);
      this.hood.add(car);
      this.hillCars.push({ obj: car, t: r(), speed: (0.018 + r() * 0.01) * (i % 2 ? 1 : -1) });
    }
  }

  private buildClouds() {
    const bank = (target: THREE.Group, x: number, z: number, w: number, d: number, y: number, key: string) => {
      const { group } = cloudPuffs(x, z, w, d, hash(this.seed, key), y);
      target.add(group);
    };
    bank(this.clouds.hills, (HILLS_HOOD.x0 + HILLS_HOOD.x1) / 2, (HILLS_HOOD.z0 + HILLS_HOOD.z1) / 2, 22, 10, 3.2, 'hills');
    bank(this.clouds.island, ISLAND.x, ISLAND.z, 8, 8, 0.6, 'island');
    bank(this.clouds.launch, LAUNCH.x, LAUNCH.z, 5, 5, 0.8, 'launch');
  }

  /** Reflect the game: what's open, what's built, what's falling apart. */
  setState(next: SceneryState) {
    this.state = next;
    this.hood.visible = next.hills;
    this.clouds.hills.visible = !next.hills;
    this.clouds.island.visible = !next.island;
    this.clouds.launch.visible = !next.launch;
    this.launchPad.visible = next.launch;
    this.wheelSet.visible = next.ferris;
    this.coaster.visible = next.coaster;
    this.bridgeMat.color.set(next.bridgeRusting ? 0x9a7a62 : 0xffffff);
    this.bridgeMat.roughness = next.bridgeRusting ? 1 : 0.82;
  }

  // ─── Boats ──────────────────────────────────────────────────────────────

  private addBoats() {
    const r = rng(hash(this.seed, 'boats'));
    const loops: [number, number, number, number][] = [
      [-32, 4, 6, 4],
      [-14, 41, 8, 3],
      [34, 0, 3, 13],
      [12, 37, 9, 3.5],
      [-32, 30, 6, 4],
    ];
    for (const [cx, cz, rx, rz] of loops) {
      const obj = sailboat(r);
      this.object.add(obj);
      this.boats.push({ obj, path: (t) => [cx + Math.cos(t) * rx, WATER_Y, cz + Math.sin(t) * rz], t: r() * Math.PI * 2, speed: (0.05 + r() * 0.04) * (r() < 0.5 ? 1 : -1) });
    }
    const { group: ferry, glow } = ferryBoat();
    if (glow) this.glows.push(glow);
    this.object.add(ferry);
    const a = new THREE.Vector3(-4, WATER_Y, LAND.maxZ + 15);
    const bpt = new THREE.Vector3(-29, WATER_Y, 18.5);
    this.boats.push({
      obj: ferry,
      path: (t) => {
        const u = 0.5 - 0.5 * Math.cos(t);
        return [a.x + (bpt.x - a.x) * u, WATER_Y, a.z + (bpt.z - a.z) * u];
      },
      t: 0,
      speed: 0.04,
    });
  }

  update(dt: number, time: number, night: number) {
    this.normals.offset.set((time * 0.006) % 1, (time * 0.004) % 1);

    const turn = time * 0.12;
    for (const child of this.wheel.children) {
      if (child.userData.angle === undefined) {
        child.rotation.z = turn;
      } else {
        const a = child.userData.angle + turn;
        child.position.set(Math.cos(a) * child.userData.radius, Math.sin(a) * child.userData.radius - 0.16, 0);
      }
    }

    for (const boat of this.boats) {
      boat.t += dt * boat.speed;
      const [x, y, z] = boat.path(boat.t);
      const [nx, , nz] = boat.path(boat.t + 0.01 * Math.sign(boat.speed));
      boat.obj.position.set(x, y + Math.sin(time * 1.6 + x) * 0.03, z);
      if (Math.hypot(nx - x, nz - z) > 1e-5) boat.obj.rotation.y = Math.atan2(-(nz - z), nx - x);
      boat.obj.rotation.z = Math.sin(time * 1.3 + z) * 0.04;
    }

    for (const car of this.hillCars) {
      car.t = (((car.t + dt * car.speed) % 1) + 1) % 1;
      const p = this.hillRoad.getPointAt(car.t);
      const ahead = this.hillRoad.getPointAt(Math.min(0.999, Math.max(0.001, car.t + 0.004 * Math.sign(car.speed))));
      const side = new THREE.Vector3(-(ahead.z - p.z), 0, ahead.x - p.x).normalize().multiplyScalar(0.12);
      car.obj.position.set(p.x + side.x, p.y, p.z + side.z);
      car.obj.rotation.y = Math.atan2(-(ahead.z - p.z), ahead.x - p.x);
    }
    for (const g of Object.values(this.clouds)) g.position.y = Math.sin(time * 0.4) * 0.08;

    // The sign is the first thing cut when upkeep runs short: it sputters, then goes dark.
    this.signFlicker = this.state.signLit ? 0 : Math.min(1, this.signFlicker + dt * 0.4);
    const sputter = this.signFlicker > 0 && this.signFlicker < 1 && Math.random() < 0.3 ? 0.6 : 0;
    this.signMat.emissiveIntensity = (this.state.signLit ? 0.55 : sputter) * night;
    for (const m of this.glows) m.color.setScalar(this.state.lampsFailing ? 0.35 : 1);
    this.beamMat.opacity = 0.22 * night;
    this.beam.visible = night > 0.05;
    this.beam.position.copy(this.beamCentre);
    this.beam.rotation.y = time * 0.8;
  }
}

// ─── Small parts ──────────────────────────────────────────────────────────

/** A low sports car for the Hills, facing +x. */
function luxuryCar(r: () => number): THREE.Group {
  const b = new GeoBuilder();
  const c = pick(r, [0xd8402e, 0xf2c84b, 0x1c1c24, 0xf4f4f0, 0x2f6fa8] as const);
  b.box(0.42, 0.08, 0.2, 0, 0.04, 0, c);
  b.box(0.2, 0.06, 0.16, -0.04, 0.12, 0, 0x2a3442);
  for (const [x, z] of [[0.13, 0.1], [-0.13, 0.1], [0.13, -0.1], [-0.13, -0.1]] as const) b.cylinder(0.04, 0.04, 0.03, x, 0.0, z, 0x111111, 8);
  b.box(0.01, 0.03, 0.14, 0.211, 0.07, 0, [3, 2.8, 2.2], true);
  const { group } = b.build();
  group.traverse((o) => (o.castShadow = true));
  return group;
}

function beachY(x: number): number {
  const t = (x - BEACH.x0 - 1.6) / (BEACH.x1 - BEACH.x0 - 1.6);
  return x <= BEACH.x0 + 1.6 ? -0.03 : -0.03 + (WATER_Y - 0.15 + 0.03) * t;
}

function lamp(b: GeoBuilder, x: number, z: number, y = 0) {
  b.cylinder(0.015, 0.022, 0.55, x, y, z, 0x3c4048, 5);
  b.blob(0.045, x, y + 0.58, z, PALETTE.lamp, true);
}

function moored(b: GeoBuilder, r: () => number, x: number, z: number) {
  const y = WATER_Y;
  b.box(0.75, 0.12, 0.26, x, y, z, PALETTE.trim);
  b.box(0.3, 0.1, 0.18, x - 0.05, y + 0.12, z, pick(r, [0x3aa3c8, 0xe85a4a, 0xf8f5ee] as const));
  b.cylinder(0.01, 0.012, 0.9, x + 0.08, y + 0.12, z, PALETTE.trim, 4);
}

function sailboat(r: () => number): THREE.Group {
  const b = new GeoBuilder();
  b.box(0.8, 0.14, 0.28, 0, 0, 0, PALETTE.trim);
  b.box(0.2, 0.15, 0.22, 0.42, -0.01, 0, PALETTE.trim, false, Math.PI / 4);
  b.box(0.82, 0.03, 0.3, 0, 0.1, 0, pick(r, [0x2f6fa8, 0xe85a4a, 0x2f8a6a] as const));
  b.cylinder(0.012, 0.015, 1.2, 0.05, 0.14, 0, PALETTE.trim, 4);
  const sail = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(-0.55, 0), new THREE.Vector2(0, 1.05)]);
  b.transformed(new THREE.ExtrudeGeometry(sail, { depth: 0.01, bevelEnabled: false }), new THREE.Matrix4().makeTranslation(0.03, 0.24, 0), 0xfbfaf6);
  const jib = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0.38, 0), new THREE.Vector2(0, 0.85)]);
  b.transformed(new THREE.ExtrudeGeometry(jib, { depth: 0.01, bevelEnabled: false }), new THREE.Matrix4().makeTranslation(0.07, 0.26, 0.01), 0xfbfaf6);
  const { group } = b.build();
  group.traverse((o) => (o.castShadow = true));
  return group;
}

function ferryBoat(): { group: THREE.Group; glow?: THREE.MeshBasicMaterial } {
  const b = new GeoBuilder();
  b.box(1.9, 0.26, 0.62, 0, -0.05, 0, PALETTE.trim);
  b.box(1.92, 0.06, 0.64, 0, 0.05, 0, 0x2f6fa8);
  b.box(1.3, 0.28, 0.5, -0.1, 0.21, 0, 0xf8f5ee);
  b.box(0.6, 0.18, 0.4, 0.05, 0.49, 0, 0xf8f5ee);
  b.cylinder(0.06, 0.06, 0.22, -0.3, 0.67, 0, 0xe85a4a, 8);
  b.windows({ w: 1.3, d: 0.5, x: -0.1, z: 0, y0: 0.21, rows: 1, rowHeight: 0.28, cols: 6, faces: ['z+', 'z-'] }, () => 0.1, 1, [1.6, 1.1, 0.6], { w: 0.12, h: 0.1 });
  const built = b.build();
  built.group.traverse((o) => (o.castShadow = true));
  return built;
}

const SIGN = { x: -17, z: -27.2 } as const;

function inSignArea(x: number, z: number): boolean {
  // The sign runs along the screen-right diagonal through SIGN.
  const u = (x - SIGN.x - (z - SIGN.z)) * Math.SQRT1_2;
  const v = (x - SIGN.x + (z - SIGN.z)) * Math.SQRT1_2;
  return Math.abs(u) < 9.5 && v > -2.6 && v < 1.8;
}

function inHood(x: number, z: number): boolean {
  return x > HILLS_HOOD.x0 - 0.5 && x < HILLS_HOOD.x1 + 0.5 && z > HILLS_HOOD.z0 - 0.5 && z < HILLS_HOOD.z1;
}

const LETTER_WIDTH: Record<string, number> = { T: 0.62, I: 0.2, N: 0.62, Y: 0.64, O: 0.66, W: 0.86 };

/** Condensed block capitals, in a box `LETTER_WIDTH[ch] * h` wide and `h` tall. */
function letterShape(ch: string, h: number): THREE.Shape {
  const w = LETTER_WIDTH[ch]! * h;
  const s = 0.13 * h;
  const P = (pts: [number, number][]) => new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  switch (ch) {
    case 'T':
      return P([[0, h], [w, h], [w, h - s], [(w + s) / 2, h - s], [(w + s) / 2, 0], [(w - s) / 2, 0], [(w - s) / 2, h - s], [0, h - s]]);
    case 'I':
      return P([[0, 0], [w, 0], [w, h], [0, h]]);
    case 'N':
      return P([[0, 0], [s, 0], [s, h * 0.66], [w - s, 0], [w, 0], [w, h], [w - s, h], [w - s, h * 0.34], [s, h], [0, h]]);
    case 'Y':
      return P([[0, h], [s * 1.15, h], [w / 2, h * 0.6], [w - s * 1.15, h], [w, h], [w / 2 + s / 2, h * 0.46], [w / 2 + s / 2, 0], [w / 2 - s / 2, 0], [w / 2 - s / 2, h * 0.46]]);
    case 'W':
      return P([[0, h], [s, h], [w * 0.27, h * 0.24], [w * 0.44, h * 0.8], [w * 0.56, h * 0.8], [w * 0.73, h * 0.24], [w - s, h], [w, h], [w * 0.8, 0], [w * 0.66, 0], [w * 0.5, h * 0.58], [w * 0.34, 0], [w * 0.2, 0]]);
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

// ─── Textures ─────────────────────────────────────────────────────────────

/** Tileable ripple normal map; scrolling it makes the sun glint on the water. */
function waterNormals(): THREE.Texture {
  const n = 256;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(n, n);
  const H = (x: number, y: number) => {
    const u = (x / n) * Math.PI * 2;
    const v = (y / n) * Math.PI * 2;
    return Math.sin(u * 3 + Math.sin(v * 2) * 1.5) + 0.6 * Math.sin(v * 5 + u * 2) + 0.35 * Math.sin(u * 9 - v * 7) + 0.25 * Math.sin(u * 13 + v * 11);
  };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = H(x + 1, y) - H(x - 1, y);
      const dy = H(x, y + 1) - H(x, y - 1);
      const len = Math.hypot(dx, dy, 0.35);
      const i = (y * n + x) * 4;
      img.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((0.35 / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(70, 70);
  return t;
}

/** Turquoise shallows and white surf around every shore. */
function shallowsTexture(): THREE.Texture {
  const size = 1024;
  const span = 160;
  const cx = 0;
  const cz = -10;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const px = (x: number) => ((x - cx + span / 2) / span) * size;
  const pz = (z: number) => ((z - cz + span / 2) / span) * size;
  const coast = () => {
    ctx.beginPath();
    ctx.rect(px(LAND.minX), pz(LAND.minZ), px(LAND.maxX) - px(LAND.minX), pz(LAND.maxZ) - pz(LAND.minZ));
    ctx.rect(px(BEACH.x0), pz(BEACH.z0), px(BEACH.x1) - px(BEACH.x0), pz(BEACH.z1) - pz(BEACH.z0));
    // Hill footprint where it is above water
    for (let x = HILL.x0; x <= HILL.x1; x += 0.5) {
      for (let z = HILL.z0; z <= HILL.z1; z += 0.5) {
        if (hillHeight(x, z) > -0.35) ctx.rect(px(x - 0.3), pz(z - 0.3), (0.6 / span) * size, (0.6 / span) * size);
      }
    }
    ctx.rect(px(AIRPORT.x0), pz(AIRPORT.z0), px(AIRPORT.x1) - px(AIRPORT.x0), pz(AIRPORT.z1) - pz(AIRPORT.z0));
    for (const isle of [ISLAND, LAUNCH]) {
      ctx.moveTo(px(isle.x + isle.r + 0.6), pz(isle.z));
      ctx.ellipse(px(isle.x), pz(isle.z), ((isle.r + 0.6) / span) * size, ((isle.r + 0.6) / span) * size, 0, 0, Math.PI * 2);
    }
  };
  ctx.filter = 'blur(28px)';
  ctx.fillStyle = PALETTE.shallows;
  coast();
  ctx.fill();
  ctx.filter = 'blur(10px)';
  ctx.fillStyle = 'rgba(120,235,225,0.9)';
  coast();
  ctx.fill();
  ctx.filter = 'blur(2px)';
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.rect(px(BEACH.x1) - 2, pz(BEACH.z0), 1, pz(BEACH.z1) - pz(BEACH.z0));
  ctx.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
