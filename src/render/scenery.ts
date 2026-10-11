import * as THREE from 'three';
import { GeoBuilder, glowMaterial } from './geo.ts';
import { PALETTE } from './palette.ts';
import { palm, tree } from './buildings.ts';
import { hash, pick, rng } from '../world/rng.ts';

/** The flat land the city sits on. Ocean on three sides, hills behind. */
export const LAND = { minX: -22, maxX: 22, minZ: -24, maxZ: 22 } as const;
const BEACH = { x0: 22, x1: 27.5, z0: -22, z1: 22 } as const;
const WATER_Y = -0.4;
const HILL = { x0: -34, x1: 34, z0: -56, z1: -24 } as const;

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

  constructor(seed: number) {
    this.seed = seed;
    this.normals = waterNormals();
    this.object.add(this.ocean(), this.land(), this.hills(), this.pier(), this.bridge(), this.island(), this.coastline());
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
      if (h < 0.2 || inSignArea(x, z)) continue;
      if (r() > 0.85 - h * 0.08) continue;
      tree(b, r, x, z, 1.3, h - 0.05, r() < 0.55 ? 'cypress' : r() < 0.7 ? 'round' : 'palm');
    }
    // Hillside villas
    for (let i = 0; i < 18; i++) {
      const x = -26 + r() * 52;
      const z = LAND.minZ - 1.5 - r() * 6;
      const h = hillHeight(x, z);
      if (h < 0.3 || inSignArea(x, z)) continue;
      b.box(0.7, 0.35, 0.55, x, h - 0.1, z, pick(r, [0xf8f5ee, 0xf6e7c8, 0xf3c6a2] as const));
      b.box(0.78, 0.04, 0.63, x, h + 0.25, z, PALETTE.trim);
      b.quad(0.5, 0.18, x, h + 0.08, z + 0.28, 'z+', [1.6, 1.05, 0.5], true);
      b.box(0.4, 0.015, 0.3, x + 0.6, h - 0.05, z + 0.1, PALETTE.pool);
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
    const height = 1.9;
    const gap = 0.32;
    const widths = [...letters].map((ch) => LETTER_WIDTH[ch]! * height);
    const total = widths.reduce((a, b) => a + b, 0) + gap * (letters.length - 1);
    const right = new THREE.Vector3(Math.SQRT1_2, 0, -Math.SQRT1_2);
    const centre = new THREE.Vector3(SIGN.x, 0, SIGN.z);
    let u = -total / 2;
    [...letters].forEach((ch, i) => {
      const w = widths[i]!;
      const p = centre.clone().addScaledVector(right, u + w / 2);
      const y = hillHeight(p.x, p.z);
      const shape = letterShape(ch, height);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.14, bevelEnabled: false });
      geo.translate(-w / 2, 0, 0);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.position.set(p.x, y - 0.15 + Math.sin(i * 1.7) * 0.12, p.z);
      mesh.rotation.set(-0.12, Math.PI / 4 + Math.sin(i * 2.3) * 0.04, 0, 'YXZ');
      g.add(mesh);
      for (const s of [-0.3, 0.3]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, height * 0.9, 0.06), post);
        const q = p.clone().addScaledVector(right, s * w).add(new THREE.Vector3(-0.25, 0, -0.25));
        leg.position.set(q.x, hillHeight(q.x, q.z) + height * 0.4, q.z);
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
    g.add(support);

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
    g.add(this.wheel);
    return g;
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
    return this.add(b);
  }

  private island(): THREE.Group {
    const r = rng(hash(this.seed, 'island'));
    const b = new GeoBuilder();
    const x = -44;
    const z = 18;
    b.cylinder(2.6, 3.2, 1.0, x, WATER_Y - 0.6, z, 0x9c8a6e, 9);
    b.cylinder(1.8, 2.5, 0.9, x + 0.3, 0.0, z - 0.2, 0x8a7a62, 8);
    b.cylinder(1.6, 1.8, 0.1, x + 0.3, 0.9, z - 0.2, PALETTE.hillGreen, 8);
    for (let i = 0; i < 6; i++) tree(b, r, x + (r() - 0.5) * 2.6, z + (r() - 0.5) * 2.6, 0.9, 0.95, 'cypress');
    b.box(1.6, 0.5, 0.8, x + 0.8, 1.0, z + 0.4, 0xe9e2d0);
    b.cylinder(0.18, 0.24, 1.3, x - 0.6, 1.0, z - 0.5, PALETTE.trim, 8);
    b.cylinder(0.2, 0.2, 0.12, x - 0.6, 2.3, z - 0.5, 0xe85a4a, 8);
    b.blob(0.14, x - 0.6, 2.5, z - 0.5, [3, 2.6, 1.6], true);
    b.cylinder(0.02, 0.22, 0.2, x - 0.6, 2.62, z - 0.5, 0xe85a4a, 8);
    this.beamCentre.set(x - 0.6, 2.5, z - 0.5);
    return this.add(b);
  }
  private beamCentre = new THREE.Vector3();

  // ─── Boats ──────────────────────────────────────────────────────────────

  private addBoats() {
    const r = rng(hash(this.seed, 'boats'));
    const loops: [number, number, number, number][] = [
      [-32, 4, 6, 4],
      [-11, 40, 8, 3],
      [34, 0, 3, 13],
      [12, 37, 9, 3.5],
      [-30, 30, 7, 4],
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
    const bpt = new THREE.Vector3(-41, WATER_Y, 21.5);
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

    this.signMat.emissiveIntensity = 0.55 * night;
    this.beamMat.opacity = 0.22 * night;
    this.beam.visible = night > 0.05;
    this.beam.position.copy(this.beamCentre);
    this.beam.rotation.y = time * 0.8;
  }
}

// ─── Small parts ──────────────────────────────────────────────────────────

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

const SIGN = { x: -13, z: -28.6 } as const;

function inSignArea(x: number, z: number): boolean {
  // The sign runs along the screen-right diagonal through SIGN.
  const u = (x - SIGN.x - (z - SIGN.z)) * Math.SQRT1_2;
  const v = (x - SIGN.x + (z - SIGN.z)) * Math.SQRT1_2;
  return Math.abs(u) < 8.5 && v > -2.2 && v < 1.6;
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
    ctx.ellipse(px(-44), pz(18), (3.4 / span) * size, (3.4 / span) * size, 0, 0, Math.PI * 2);
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
