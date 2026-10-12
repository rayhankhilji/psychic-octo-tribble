import * as THREE from 'three';
import { GeoBuilder, smoothMaterial, solidMaterial, type ColorLike } from './geo.ts';
import { PALETTE } from './palette.ts';
import { palm, tree } from './buildings.ts';
import { cloudBank } from './models.ts';
import { Batch } from './batch.ts';
import {
  bayBridge,
  cityHall,
  cliffHouse,
  coitTower,
  conservatory,
  ferryBuilding,
  goldenGate,
  palaceOfFineArts,
  sign,
  sutroTower,
  windmill,
  type BayBridge,
  type Sign,
  type Windmill,
} from './landmarks.ts';
import { Terrain } from './terrain.ts';
import { hash, pick, rng } from '../world/rng.ts';
import {
  AIRPORT,
  AIRPORT_SLOTS,
  BLOCKS,
  CIVIC_BLOCK,
  HILLS_HOME,
  HILLS_HOOD,
  ISLANDS,
  LANDMARKS,
  MARINA_SLOTS,
  MARKET_END,
  MARKET_START,
  PIER,
  AIRPORT_ROAD,
  BAY_APPROACH,
  EMBARCADERO,
  GREAT_HIGHWAY,
  PRESIDIO_PKWY,
  RUNWAY,
  SEA,
  blockCentre,
  coastDistance,
  terrainHeight,
  type Pt,
} from '../world/map.ts';
import type { Atmosphere } from '../world/daylight.ts';

export { AIRPORT_SLOTS, DOWNTOWN_HOME, HILLS_HOME, MARINA_SLOTS, SUPERYACHT } from '../world/map.ts';
export const ISLAND = ISLANDS.founder;
export const LAUNCH = ISLANDS.launch;
export const hillHeight = terrainHeight;

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

const LAMP: ColorLike = [2.4, 1.75, 0.95];

/** Twin Peaks Boulevard: from the end of Market up through TinyTown Hills. */
const HILL_ROAD: Pt[] = [
  [MARKET_END[0], MARKET_END[1]], [-11.5, -25.6], [-4.6, -26], [-3.6, -27.4], [-10.8, -28], [-12.4, -29.3],
  [-5, -30], [-3.8, -31.4], [-9.2, -32.6],
];

/**
 * Everything around the city that metrics don't drive: terrain and water,
 * the bridges, the waterfront, parks, landmarks, the airport, your island,
 * the Hills, and the suburbs that make the world feel bigger than the grid.
 */
export class Scenery {
  readonly object = new THREE.Group();
  /** Emissive materials the city dims when lamps fail. */
  readonly glows: THREE.MeshBasicMaterial[] = [];
  /** Things with tooltips. */
  readonly pickables: THREE.Object3D[] = [];
  readonly terrain = new Terrain();
  private seed: number;
  private wheel = new THREE.Group();
  private wheelFrame: THREE.Object3D | null = null;
  /** The gondolas: one instanced mesh per material, one instance per cabin. */
  private gondolas: THREE.InstancedMesh[] = [];
  private gondolaAngles: number[] = [];
  private wheelRadius = 1;
  private tmpMatrix = new THREE.Matrix4();
  private wheelSet = new THREE.Group();
  private coaster = new THREE.Group();
  private hood = new THREE.Group();
  private clouds: Record<'hills' | 'island' | 'launch', THREE.Group> = { hills: new THREE.Group(), island: new THREE.Group(), launch: new THREE.Group() };
  private launchPad = new THREE.Group();
  private beam: THREE.Mesh;
  private beamMat: THREE.ShaderMaterial;
  private beamCentre = new THREE.Vector3();
  private sign: Sign;
  private bay: BayBridge;
  private mill: Windmill;
  private rustSolid = solidMaterial.clone();
  private rustSmooth = smoothMaterial.clone();
  /** Sea lions on their docks: one instanced mesh, each rocking on its own. */
  private seaLions: { mesh: THREE.InstancedMesh; at: { x: number; y: number; z: number; yaw: number }[] } | null = null;
  private lionEuler = new THREE.Euler();
  private lionQuat = new THREE.Quaternion();
  private lionPos = new THREE.Vector3();
  private lionScale = new THREE.Vector3(1, 1, 1);
  /** Everything that never moves (static landmarks, roads, parks, the marina…) in a few draw calls. */
  private batch = new Batch(64, 300_000);
  private batchKeys: string[] = [];
  private lampsDimmed = false;
  private flags: THREE.Object3D[] = [];
  /** The Hills road, for the cars that drive it. */
  readonly hillRoad: THREE.CatmullRomCurve3;
  private state: SceneryState = { hills: false, island: false, launch: false, ferris: false, coaster: false, signLit: true, lampsFailing: false, bridgeRusting: false };
  private signFade = 1;

  constructor(seed: number) {
    this.seed = seed;
    this.object.add(this.terrain.object);
    this.hillRoad = new THREE.CatmullRomCurve3(HILL_ROAD.map(([x, z]) => new THREE.Vector3(x, terrainHeight(x, z) + 0.05, z)), false, 'centripetal');

    const gg = goldenGate();
    this.bay = bayBridge();
    for (const bridge of [gg, this.bay.group]) {
      bridge.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        if (o.material === solidMaterial) o.material = this.rustSolid;
        if (o.material === smoothMaterial) o.material = this.rustSmooth;
      });
    }
    this.sign = sign();
    this.mill = windmill();
    const civic = blockCentre(CIVIC_BLOCK);
    // Landmarks with moving or custom-lit parts stay objects of their own; the rest are batched.
    for (const l of [gg, this.bay.group, this.mill.group, this.sign.group]) {
      this.object.add(l);
      this.pickables.push(l);
      this.collectGlows(l);
    }
    this.glows.push(this.sign.floodlights);
    this.object.add(this.batch.object);
    this.pickables.push(this.batch.object);
    for (const l of [cityHall(civic.x, civic.z), ferryBuilding(), coitTower(), palaceOfFineArts(), sutroTower(), conservatory(-16.5, -14.6), cliffHouse()]) this.fix(l);
    for (const part of [this.roads(), this.marketPlazas(), this.parks(), this.marina(), this.airport(), this.island(), this.suburbs()]) this.fix(part);
    this.object.add(this.waterfront());
    this.object.add(this.hood, this.clouds.hills, this.clouds.island, this.clouds.launch, this.launchPad);
    this.buildHood();
    this.buildClouds();

    this.beamMat = lighthouseBeamMaterial();
    // Narrow at the lamp, widening out to sea along +x.
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(BEAM.spread, 0.05, BEAM.length, 20, 1, true).rotateZ(-Math.PI / 2).translate(BEAM.length / 2, 0, 0), this.beamMat);
    this.beam.renderOrder = 3;
    this.object.add(this.beam);
  }

  /** Moves a static model into the batch (its tooltip comes too). */
  private fix(group: THREE.Group) {
    const i = this.pickables.indexOf(group);
    if (i >= 0) this.pickables.splice(i, 1);
    const key = `s:${this.batchKeys.length}`;
    const proxy = this.batch.add(key, { group }, group.userData.tip);
    this.batchKeys.push(key);
    // Anything that couldn't merge rides on the proxy.
    if (proxy.children.length) {
      this.object.add(proxy);
      this.pickables.push(proxy);
      this.collectGlows(proxy);
    }
  }

  private collectGlows(g: THREE.Object3D) {
    g.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshBasicMaterial && !this.glows.includes(o.material)) this.glows.push(o.material);
    });
  }

  private add(b: GeoBuilder, tip?: { title: string; detail: string }): THREE.Group {
    const { group, glow } = b.build();
    group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.receiveShadow = true;
        o.castShadow = true;
      }
    });
    if (glow) this.glows.push(glow);
    if (tip) {
      group.userData.tip = tip;
      this.pickables.push(group);
    }
    return group;
  }

  // ─── Roads ───────────────────────────────────────────────────────────────

  private roads(): THREE.Group {
    const b = new GeoBuilder();
    // Market Street: wide, with a palm median and streetcar tracks.
    ribbon(b, [MARKET_START, MARKET_END], 1.5, PALETTE.road, 0.014);
    ribbon(b, [MARKET_START, MARKET_END], 0.18, 0x8fae6a, 0.03);
    for (const off of [-0.42, -0.3, 0.3, 0.42]) ribbon(b, [MARKET_START, MARKET_END], 0.025, 0x9a9ea6, 0.032, off);
    const [mx0, mz0] = MARKET_START;
    const [mx1, mz1] = MARKET_END;
    const len = Math.hypot(mx1 - mx0, mz1 - mz0);
    const r = rng(hash(this.seed, 'market'));
    for (let d = 1.2; d < len - 0.5; d += 1.25) {
      const t = d / len;
      palm(b, r, mx0 + (mx1 - mx0) * t, mz0 + (mz1 - mz0) * t, 0.8, 0.03);
    }
    for (let d = 0.6; d < len; d += 2.5) {
      const t = d / len;
      for (const s of [-1, 1]) {
        const x = mx0 + (mx1 - mx0) * t + s * 0.72 * Math.SQRT1_2;
        const z = mz0 + (mz1 - mz0) * t - s * 0.72 * Math.SQRT1_2;
        b.cylinder(0.012, 0.016, 0.5, x, 0, z, 0x2f6a4f, 6);
        b.blob(0.04, x, 0.52, z, LAMP, true);
      }
    }
    // Embarcadero with its palms; the Great Highway; bridge approaches; the airport road; Twin Peaks Blvd.
    ribbon(b, EMBARCADERO, 1.0, PALETTE.road, 0.012, 0, true);
    for (let i = 0; i < EMBARCADERO.length - 1; i += 1) {
      const [ax, az] = EMBARCADERO[i]!;
      const [bx, bz] = EMBARCADERO[i + 1]!;
      const n = Math.max(1, Math.floor(Math.hypot(bx - ax, bz - az) / 1.6));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        const x = ax + (bx - ax) * t;
        const z = az + (bz - az) * t;
        const nx = -(bz - az);
        const nz = bx - ax;
        const l = Math.hypot(nx, nz);
        const side = coastDistance(x + (nx / l) * 0.8, z + (nz / l) * 0.8) > coastDistance(x - (nx / l) * 0.8, z - (nz / l) * 0.8) ? 1 : -1;
        palm(b, r, x + (side * nx * 0.75) / l, z + (side * nz * 0.75) / l, 0.9, terrainHeight(x, z));
      }
    }
    ribbon(b, GREAT_HIGHWAY, 0.9, PALETTE.road, 0.012, 0, true);
    ribbon(b, PRESIDIO_PKWY, 0.9, PALETTE.road, 0.012, 0, true);
    ribbon(b, BAY_APPROACH, 1.1, PALETTE.road, 0.015, 0, true);
    ribbon(b, AIRPORT_ROAD, 0.9, PALETTE.road, 0.012, 0, true);
    return this.add(b);
  }

  /**
   * Market cuts the blocks it crosses into triangles. Most become flatirons
   * (wedge buildings whose prows point along Market, taller toward the
   * Financial District); two stay open as plazas.
   */
  private marketPlazas(): THREE.Group {
    const b = new GeoBuilder();
    const r = rng(hash(this.seed, 'plazas'));
    for (const blk of BLOCKS.filter((x) => x.use === 'market')) {
      const c = blockCentre(blk);
      for (const s of [-1, 1] as const) {
        // s = −1: north of Market; s = 1: south (SoMa). Reflecting across Market swaps x and z offsets.
        const at = (dx: number, dz: number): Pt => (s < 0 ? [c.x + dx, c.z + dz] : [c.x + dz, c.z + dx]);
        const R = at(-2, 2);
        const tri = [at(-2, -2), R, at(2, 2)];
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(tri.flatMap(([x, z]) => [x, 0.012, z]), 3));
        g.setIndex(s < 0 ? [0, 2, 1] : [0, 1, 2]);
        g.computeVertexNormals();
        b.transformed(g, new THREE.Matrix4(), PALETTE.sidewalk);
        const plaza = (blk.bx === 1 && s < 0) || (blk.bx === -2 && s > 0);
        if (plaza) {
          const corner = at(-0.9, 0.9);
          b.transformed(new THREE.CircleGeometry(1.0, 20).rotateX(-Math.PI / 2), new THREE.Matrix4().makeTranslation(corner[0], 0.016, corner[1]), PALETTE.plaza);
          for (let k = 0; k < 6; k++) {
            const [tx, tz] = at(-1.6 + (k % 3) * 0.55, 1.6 - Math.floor(k / 3) * 0.55 - (k % 3) * 0.1);
            tree(b, r, tx, tz, 0.85, 0.012, k % 2 ? 'round' : 'palm');
          }
          for (let k = 0; k < 3; k++) {
            const [bx, bz] = at(-0.4 + k * 0.35, 0.3 + k * 0.35);
            b.box(0.24, 0.04, 0.07, bx, 0.012, bz, PALETTE.wood, false, Math.PI / 4);
          }
          const [kx, kz] = at(-1.5, 0.4);
          b.box(0.3, 0.24, 0.22, kx, 0.012, kz, pick(r, [0x2f6a4f, 0x7a3a2c] as const));
          b.box(0.34, 0.03, 0.26, kx, 0.25, kz, PALETTE.trim);
          if (blk.bx === 1) {
            // A Vaillancourt-ish fountain of jumbled concrete tubes
            const [fx, fz] = at(-1.0, 1.0);
            b.cylinder(0.55, 0.6, 0.06, fx, 0.012, fz, 0xbab3a6, 16);
            b.cylinder(0.5, 0.5, 0.01, fx, 0.07, fz, 0x5fc7d6, 16, 'glass');
            for (let k = 0; k < 6; k++) b.box(0.11, 0.3 + k * 0.07, 0.11, fx - 0.15 + (k % 3) * 0.13, 0.07, fz - 0.1 + Math.floor(k / 3) * 0.16, 0xa79f92, false, k * 0.4);
          }
          continue;
        }
        // Two flatirons per triangle, split where a line from the corner meets Market at right angles.
        const Rp = at(-1.88, 1.88);
        const Ap = at(-1.88, -0.68);
        const Bp = at(0.68, 1.88);
        const M: Pt = [(Ap[0] + Bp[0]) / 2, (Ap[1] + Bp[1]) / 2];
        const tall = [1, 0.82, 0.55, 0.4][1 - blk.bx] ?? 0.4;
        for (const part of [[Rp, Ap, M], [Rp, M, Bp]] as Pt[][]) {
          const h = (0.8 + r() * 1.6) * tall * 1.6 + 0.45;
          flatiron(b, r, part, h, blk.bx === 1 && s > 0 && part[1] === M);
        }
      }
    }
    return this.add(b, { title: 'Market Street', detail: 'Flatirons, plazas and the F-line, from the Ferry Building to the Castro.' });
  }

  // ─── Parks and forests ──────────────────────────────────────────────────

  private parks(): THREE.Group {
    const b = new GeoBuilder();
    const r = rng(hash(this.seed, 'parks'));
    // Golden Gate Park: dense trees, meadows, Stow Lake, a pagoda and the de Young's copper tower.
    const park = { x0: -37.5, x1: -12.5, z0: -17.5, z1: -12.5 };
    b.box(park.x1 - park.x0, 0.012, park.z1 - park.z0, (park.x0 + park.x1) / 2, 0, (park.z0 + park.z1) / 2, 0x6aae47);
    const lake = new THREE.CircleGeometry(1.4, 28).rotateX(-Math.PI / 2).scale(1.4, 1, 0.8);
    b.transformed(lake, new THREE.Matrix4().makeTranslation(-27, 0.02, -15.2), 0x3d9fb0, 'glass');
    b.cylinder(0.55, 0.6, 0.08, -27, 0.02, -15.2, 0x6aae47, 12);
    for (let i = 0; i < 6; i++) tree(b, r, -27 + (r() - 0.5) * 0.8, -15.2 + (r() - 0.5) * 0.6, 0.7, 0.1, 'round');
    b.box(0.4, 0.3, 0.4, -21.5, 0.01, -16.2, 0xc8402e);
    for (let k = 0; k < 3; k++) b.hip(0.55 - k * 0.12, 0.12, 0.55 - k * 0.12, -21.5, 0.31 + k * 0.16, -16.2, 0x3a3a3a, 0.08, 0.1);
    const cu = new THREE.BoxGeometry(0.6, 1.4, 0.6);
    cu.translate(0, 0.7, 0);
    cu.applyMatrix4(new THREE.Matrix4().makeShear(0, 0, 0.12, 0, 0, 0));
    cu.rotateY(0.3);
    b.transformed(cu, new THREE.Matrix4().makeTranslation(-19.8, 0.01, -13.6), 0xa86a3e);
    b.box(2.2, 0.35, 1.0, -19.6, 0.01, -14.6, 0xa86a3e);
    for (let i = 0; i < 300; i++) {
      const x = park.x0 + 0.6 + r() * (park.x1 - park.x0 - 1.2);
      const z = park.z0 + 0.5 + r() * (park.z1 - park.z0 - 1);
      if (Math.hypot((x + 27) / 1.6, (z + 15.2) / 1.1) < 1.4) continue; // lake
      if (Math.abs(x + 16.5) < 1.7 && Math.abs(z + 14.6) < 1.1) continue; // conservatory
      if (Math.abs(x + 20) < 1.4 && Math.abs(z + 14.3) < 1.2) continue; // museum
      if (Math.hypot(x + 32, z + 15) < 1.3 || Math.hypot(x + 23.5, z + 14) < 0.9) continue; // meadows
      tree(b, r, x, z, 0.8 + r() * 0.6, 0.01, r() < 0.45 ? 'round' : r() < 0.85 ? 'cypress' : 'palm');
    }
    // The Presidio and Lands End: cypress and eucalyptus on rolling ground
    for (let i = 0; i < 520; i++) {
      const x = -47 + r() * 22;
      const z = -4 + r() * 14;
      if (coastDistance(x, z) > -0.8) continue;
      if (Math.hypot(x - LANDMARKS.palaceOfFineArts.x, z - LANDMARKS.palaceOfFineArts.z) < 3) continue;
      if (x > -37.6 && z < -2.4) continue;
      const blk = BLOCKS.find((q) => Math.abs(q.bx * 5 - x) <= 3 && Math.abs(q.bz * 5 - z) <= 3);
      if (blk && blk.use !== 'presidio' && blk.use !== 'hill') continue;
      if (Math.abs(x + 34.6) < 0.8 && z > 0) continue; // parkway
      if (Math.abs(x + 39.8) < 0.7) continue; // highway
      const y = terrainHeight(x, z);
      eucalyptus(b, r, x, z, y, r() < 0.5);
    }
    // Telegraph Hill and Twin Peaks: scattered trees on the slopes
    for (let i = 0; i < 70; i++) {
      const a = r() * Math.PI * 2;
      const d = 0.8 + r() * 2.4;
      const x = LANDMARKS.coitTower.x + Math.cos(a) * d;
      const z = LANDMARKS.coitTower.z + Math.sin(a) * d;
      if (d < 1.1) continue;
      tree(b, r, x, z, 0.8, terrainHeight(x, z) - 0.03, r() < 0.6 ? 'round' : 'cypress');
    }
    for (let i = 0; i < 260; i++) {
      const x = -34 + r() * 34;
      const z = -48 + r() * 24;
      const h = terrainHeight(x, z);
      if (h < 0.6 || inSign(x, z) || inHood(x, z)) continue;
      const blk = BLOCKS.find((q) => Math.abs(q.bx * 5 - x) <= 2.6 && Math.abs(q.bz * 5 - z) <= 2.6);
      if (blk && blk.use !== 'hill') continue;
      if (r() > 0.55) continue;
      tree(b, r, x, z, 1, h - 0.05, r() < 0.5 ? 'cypress' : 'round');
    }
    // Marina Green
    b.box(7, 0.012, 1.3, -20.5, 0.005, 9.6, 0x7fc252);
    return this.add(b);
  }

  // ─── Waterfront: piers, wharf, sea lions, rides ─────────────────────────

  private waterfront(): THREE.Group {
    const b = new GeoBuilder();
    const r = rng(hash(this.seed, 'waterfront'));
    const g = new THREE.Group();
    // Embarcadero finger piers with numbered sheds
    const piers: [number, number][] = [[3.6, 5.2], [6.2, 4.6], [-10.6, 5.6], [-13.8, 5.4], [-17, 5.8]];
    piers.forEach(([pz, len], i) => {
      const x0 = 11.2;
      b.box(len, 0.12, 1.3, x0 + len / 2, SEA + 0.3, pz, 0x9b9488);
      b.box(len - 0.4, 0.5, 1.0, x0 + len / 2 + 0.1, SEA + 0.42, pz, pick(r, [0xe8e1cf, 0xd9cdb2, 0xe2d8c3] as const));
      b.gable(len - 0.4, 0.16, 1.0, x0 + len / 2 + 0.1, SEA + 0.92, pz, 0x7a828c, 0.03);
      b.box(0.04, 0.52, 0.7, x0 + 0.38, SEA + 0.42, pz, 0xc9bfa6);
      b.quad(0.26, 0.12, x0 + 0.35, SEA + 0.82, pz, 'x-', 0x2f5a46, false);
      b.windows({ w: len - 0.4, d: 1.0, x: x0 + len / 2 + 0.1, z: pz, y0: SEA + 0.42, rows: 1, rowHeight: 0.5, cols: Math.round(len * 1.6), faces: ['z+', 'z-'] }, r, 0.5, [1.6, 1.15, 0.6], { w: 0.12, h: 0.18 });
      for (let x = x0 + 0.4; x < x0 + len; x += 0.8) for (const s of [-0.6, 0.6]) b.cylinder(0.05, 0.05, 0.6, x, SEA - 0.4, pz + s, 0x6b5340, 5);
      void i;
    });
    // Fisherman's Wharf: the pier with rides (Pier 39), sea lion docks, the crab sign
    const { x0, x1, z0, z1 } = PIER;
    const y = 0.1;
    b.box(x1 - x0, 0.1, z1 - z0, (x0 + x1) / 2, y - 0.05, (z0 + z1) / 2, PALETTE.wood);
    for (let z = z0 + 0.6; z < z1; z += 1.1) for (const x of [x0 + 0.2, (x0 + x1) / 2, x1 - 0.2]) b.cylinder(0.06, 0.06, y - SEA + 0.4, x, SEA - 0.4, z, 0x6b5340, 5);
    for (let z = z0 + 0.3; z < z1; z += 0.4) for (const x of [x0 + 0.03, x1 - 0.03]) b.box(0.03, 0.14, 0.03, x, y + 0.05, z, PALETTE.trim);
    // Two-storey shops along the pier
    for (let k = 0; k < 5; k++) {
      const z = z0 + 0.9 + k * 1.15;
      const c = pick(r, [0xc8a77a, 0xb98f62, 0xd8bc90] as const);
      b.box(1.1, 0.62, 0.9, x0 + 0.75, y + 0.05, z, c);
      b.gable(1.1, 0.22, 0.9, x0 + 0.75, y + 0.67, z, 0x6d5a48, 0.04);
      b.box(1.12, 0.03, 0.18, x0 + 0.75, y + 0.36, z + 0.5, PALETTE.wood);
      b.windows({ w: 1.1, d: 0.9, x: x0 + 0.75, z, y0: y + 0.05, rows: 2, rowHeight: 0.3, cols: 3, faces: ['x+'] }, r, 0.9, [1.7, 1.25, 0.7], { w: 0.16, h: 0.16 }, 0xf2ede0);
      for (let i = 0; i < 6; i++) b.blob(0.025, x0 + 1.32, y + 0.62 - (i % 2) * 0.04, z - 0.45 + i * 0.18, [2.6, 2, 1], true);
    }
    // Carousel
    b.cylinder(0.72, 0.72, 0.12, x1 - 1.15, y + 0.05, z0 + 2.6, 0xf8f5ee, 20);
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      b.cylinder(0.02, 0.02, 0.4, x1 - 1.15 + Math.cos(a) * 0.62, y + 0.17, z0 + 2.6 + Math.sin(a) * 0.62, 0xd4af37, 6);
      b.box(0.1, 0.08, 0.04, x1 - 1.15 + Math.cos(a) * 0.5, y + 0.3, z0 + 2.6 + Math.sin(a) * 0.5, pick(r, [0xffffff, 0xf2c84b, 0xc84a4a] as const), false, -a);
    }
    b.lathe([[0.82, 0], [0.7, 0.14], [0.35, 0.36], [0.04, 0.5], [0, 0.52]], x1 - 1.15, y + 0.57, z0 + 2.6, 0xe85a4a, 20);
    for (let k = 0; k < 20; k++) {
      const a = (k / 20) * Math.PI * 2;
      b.blob(0.025, x1 - 1.15 + Math.cos(a) * 0.8, y + 0.58, z0 + 2.6 + Math.sin(a) * 0.8, LAMP, true);
    }
    for (let z = z0 + 1; z < z1; z += 2.2) {
      b.cylinder(0.012, 0.016, 0.5, x1 - 0.2, y, z, 0x2f3540, 5);
      b.blob(0.035, x1 - 0.2, y + 0.52, z, LAMP, true);
    }
    // Sea lion docks beside the pier
    for (let k = 0; k < 4; k++) b.box(1.0, 0.06, 0.6, x0 - 1.0, SEA + 0.08, z0 + 4 + k * 0.85, 0x9c8f78);
    // Crab wheel sign at the foot of the wharf
    const sx = -12.6;
    const sz = 10.2;
    b.cylinder(0.02, 0.02, 0.9, sx, 0, sz, 0x2a2a2a, 6);
    const ring = new THREE.TorusGeometry(0.35, 0.045, 6, 24);
    ring.rotateY(Math.PI / 4);
    b.transformed(ring, new THREE.Matrix4().makeTranslation(sx, 1.2, sz), 0x2a6db8);
    const crab = new THREE.CircleGeometry(0.26, 18).rotateY(Math.PI / 4);
    b.transformed(crab, new THREE.Matrix4().makeTranslation(sx + 0.01, 1.2, sz + 0.01), 0xe85a2a, true);
    g.add(this.add(b, { title: "Fisherman's Wharf", detail: 'Buy a Ferris wheel and a roller coaster for the pier from $3k MRR.' }));

    // Sea lions: little brown blobs that occasionally shuffle
    const lionMat = new THREE.MeshStandardMaterial({ color: 0x6b4a32, roughness: 0.6 });
    const lions = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.06, 0.16, 3, 6).rotateZ(Math.PI / 2), lionMat, 14);
    lions.castShadow = true;
    const at: { x: number; y: number; z: number; yaw: number }[] = [];
    for (let k = 0; k < 14; k++) at.push({ x: x0 - 1.4 + r() * 0.8, y: SEA + 0.18, z: z0 + 3.8 + Math.floor(k / 4) * 0.85 + r() * 0.3, yaw: r() * Math.PI });
    this.seaLions = { mesh: lions, at };
    this.rockLions(0);
    lions.computeBoundingSphere();
    g.add(lions);

    // The Ferris wheel and the roller coaster: bought in-game
    this.buildWheel(x0, x1, z1, y);
    this.buildCoaster(x1, z0, y);
    g.add(this.wheelSet, this.coaster);
    return g;
  }

  private buildWheel(x0: number, x1: number, z1: number, y: number) {
    const r = rng(hash(this.seed, 'wheel'));
    const cx = (x0 + x1) / 2;
    const cz = z1 - 2.4;
    const radius = 1.9;
    const hub = radius + 0.6;
    const frame = new GeoBuilder();
    for (const s of [-1, 1]) {
      for (const lean of [-0.55, 0.55]) {
        const m = new THREE.Matrix4().compose(new THREE.Vector3(lean * 0.5, hub / 2 + y, s * 0.3), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, lean * 0.42)), new THREE.Vector3(1, 1, 1));
        frame.transformed(new THREE.BoxGeometry(0.08, hub + 0.1, 0.08), m, 0xf2f2f2);
      }
    }
    frame.cylinder(0.08, 0.08, 0.7, 0, hub + y - 0.35, 0, 0xd8d8d8, 8);
    frame.rbox(1.6, 0.14, 1.0, 0, y, 0, 0xe85a4a, 0.04, 'solid');
    const support = this.add(frame);
    support.position.set(cx, 0, cz);
    support.rotation.y = Math.PI / 4;
    this.wheelSet.add(support);

    const wb = new GeoBuilder();
    const spokes = 18;
    for (const side of [-0.06, 0.06]) {
      wb.transformed(new THREE.TorusGeometry(radius, 0.035, 6, 64), new THREE.Matrix4().makeTranslation(0, 0, side), 0xf4f4f4, 'smooth');
      wb.transformed(new THREE.TorusGeometry(radius * 0.55, 0.02, 4, 48), new THREE.Matrix4().makeTranslation(0, 0, side), 0xf4f4f4, 'smooth');
    }
    for (let k = 0; k < spokes; k++) {
      const a = (k / spokes) * Math.PI * 2;
      for (const side of [-0.06, 0.06]) {
        const m = new THREE.Matrix4().compose(new THREE.Vector3((Math.cos(a) * radius) / 2, (Math.sin(a) * radius) / 2, side), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, a)), new THREE.Vector3(1, 1, 1));
        wb.transformed(new THREE.BoxGeometry(radius, 0.02, 0.02), m, 0xe8e8e8);
      }
      const colour: ColorLike = k % 3 === 0 ? [2.6, 1.2, 2.2] : k % 3 === 1 ? [1.2, 2.2, 2.6] : [2.6, 2.2, 1.0];
      wb.blob(0.035, Math.cos(a) * radius, Math.sin(a) * radius, 0.08, colour, true);
      wb.blob(0.03, Math.cos(a) * radius * 0.55, Math.sin(a) * radius * 0.55, 0.08, colour, true);
    }
    wb.cylinder(0.12, 0.12, 0.2, 0, -0.1, 0, 0xcfcfcf, 12);
    this.wheelFrame = this.add(wb);
    this.wheel.add(this.wheelFrame);
    // The gondolas only orbit (they hang level), so one cabin is drawn many times.
    // The cabin body is white and takes each gondola's paint as its instance colour.
    const gb = new GeoBuilder();
    gb.rbox(0.22, 0.2, 0.2, 0, -0.22, 0, 0xffffff, 0.04);
    gb.box(0.24, 0.03, 0.22, 0, -0.03, 0, PALETTE.trim);
    gb.box(0.01, 0.2, 0.01, 0, -0.03, 0, 0x777777);
    gb.quad(0.14, 0.08, 0, -0.1, 0.101, 'z+', [1.8, 1.4, 0.8], true, 0.3);
    const cabin = gb.build();
    if (cabin.glow) this.glows.push(cabin.glow);
    for (let k = 0; k < spokes; k += 2) this.gondolaAngles.push((k / spokes) * Math.PI * 2);
    this.wheelRadius = radius;
    const paint = new THREE.Color();
    for (const part of cabin.group.children as THREE.Mesh[]) {
      const inst = new THREE.InstancedMesh(part.geometry, part.material, this.gondolaAngles.length);
      inst.castShadow = inst.receiveShadow = part.material !== cabin.glow;
      if (part.material === smoothMaterial) {
        for (let i = 0; i < this.gondolaAngles.length; i++) inst.setColorAt(i, paint.setHex(pick(r, [0xe85a4a, 0xf2c84b, 0x3aa3c8, 0x5ac46a, 0xb97ad8] as const)));
      }
      this.gondolas.push(inst);
      this.wheel.add(inst);
    }
    this.placeGondolas(0);
    for (const g of this.gondolas) g.computeBoundingSphere();
    this.wheel.position.set(cx, hub + y, cz);
    this.wheel.rotation.y = Math.PI / 4;
    this.wheelSet.add(this.wheel);
    this.wheelSet.userData.tip = { title: 'Ferris wheel', detail: 'Yours. Lights up after dark.' };
    this.pickables.push(this.wheelSet);
  }

  /** Each sea lion rocks on its dock. */
  private rockLions(time: number) {
    const l = this.seaLions;
    if (!l) return;
    const m = this.tmpMatrix;
    l.at.forEach((a, i) => {
      this.lionQuat.setFromEuler(this.lionEuler.set(0, a.yaw, Math.sin(time * 0.8 + i * 1.7) * 0.15));
      l.mesh.setMatrixAt(i, m.compose(this.lionPos.set(a.x, a.y, a.z), this.lionQuat, this.lionScale));
    });
    l.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Hang each gondola from its point on the turning rim. */
  private placeGondolas(turn: number) {
    const m = this.tmpMatrix;
    for (let i = 0; i < this.gondolaAngles.length; i++) {
      const a = this.gondolaAngles[i]! + turn;
      m.makeTranslation(Math.cos(a) * this.wheelRadius, Math.sin(a) * this.wheelRadius, 0);
      for (const g of this.gondolas) g.setMatrixAt(i, m);
    }
    for (const g of this.gondolas) g.instanceMatrix.needsUpdate = true;
  }

  private buildCoaster(x1: number, z0: number, y: number) {
    const b = new GeoBuilder();
    const cx = x1 - 1.0;
    const cz = z0 + 6.4;
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      pts.push(new THREE.Vector3(cx + Math.cos(a) * 0.75, y + 0.75 + 0.55 * Math.sin(a * 2) + (k === 6 ? 1.0 : k === 5 || k === 7 ? 0.5 : 0), cz + Math.sin(a) * 2.2));
    }
    const curve = new THREE.CatmullRomCurve3(pts, true);
    for (const off of [-0.05, 0.05]) {
      const rail = curve.getPoints(160).map((p) => p.clone().add(new THREE.Vector3(off, 0, 0)));
      b.transformed(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rail, true), 200, 0.022, 5, true), new THREE.Matrix4(), 0x2f8fd8, 'smooth');
    }
    for (let k = 0; k < 40; k++) {
      const p = curve.getPointAt(k / 40);
      if (k % 2 === 0) b.box(0.03, p.y - y, 0.03, p.x, y, p.z, PALETTE.trim);
      b.box(0.14, 0.015, 0.03, p.x, p.y - 0.02, p.z, 0x555555);
      if (k % 3 === 0) b.blob(0.025, p.x, p.y + 0.06, p.z, [2.6, 1.6, 0.6], true);
    }
    // A little train of cars
    for (let k = 0; k < 4; k++) {
      const p = curve.getPointAt(0.3 + k * 0.018);
      b.rbox(0.13, 0.08, 0.1, p.x, p.y, p.z, [0xe85a4a, 0xf2c84b][k % 2]!, 0.03);
    }
    this.coaster.add(this.add(b, { title: 'Pier roller coaster', detail: 'Yours. Loops out over the bay.' }));
  }

  // ─── Marina, airport, island ────────────────────────────────────────────

  private marina(): THREE.Group {
    const b = new GeoBuilder();
    const r = rng(hash(this.seed, 'marina'));
    // Breakwater and floating docks in front of the Marina Green
    const bw = new THREE.TorusGeometry(3.2, 0.18, 4, 24, Math.PI * 0.7).rotateX(Math.PI / 2).rotateY(Math.PI * 0.15);
    b.transformed(bw, new THREE.Matrix4().makeTranslation(-21.4, SEA + 0.1, 12.2), 0xb4ab9c);
    for (let k = 0; k < 5; k++) {
      const x = -24 + k * 1.2;
      b.box(0.14, 0.05, 2.6, x, SEA + 0.12, 13.4, PALETTE.wood);
      for (let j = 0; j < 3; j++) b.box(0.6, 0.05, 0.1, x + 0.36, SEA + 0.12, 12.6 + j * 0.8, PALETTE.wood);
      for (let j = 0; j < 3; j++) if (r() < 0.75) moored(b, r, x + 0.35, 12.95 + j * 0.8);
    }
    for (const s of MARINA_SLOTS) b.box(0.1, 0.05, 1.4, s.x - 0.55, SEA + 0.12, s.z, PALETTE.wood);
    return this.add(b, { title: 'The Marina', detail: 'Yacht berths open at $10k MRR.' });
  }

  private airport(): THREE.Group {
    const r = rng(hash(this.seed, 'airport'));
    const b = new GeoBuilder();
    const { x0, x1, z0, z1 } = AIRPORT;
    b.box(x1 - x0, 0.012, z1 - z0, (x0 + x1) / 2, 0, (z0 + z1) / 2, 0x86b860);
    // Runway with markings, taxiway, apron
    const rx = RUNWAY.x;
    b.box(1.8, 0.016, RUNWAY.z1 - RUNWAY.z0, rx, 0, (RUNWAY.z0 + RUNWAY.z1) / 2, 0x4a4e58);
    for (let z = RUNWAY.z0 + 1.6; z < RUNWAY.z1 - 1.6; z += 1.2) b.box(0.07, 0.004, 0.6, rx, 0.017, z, PALETTE.trim);
    for (const end of [RUNWAY.z0 + 0.6, RUNWAY.z1 - 0.6]) for (let k = -3; k <= 3; k++) b.box(0.1, 0.004, 0.55, rx + k * 0.22, 0.017, end, PALETTE.trim);
    for (const s of [-1, 1]) b.box(0.04, 0.004, RUNWAY.z1 - RUNWAY.z0, rx + s * 0.86, 0.017, (RUNWAY.z0 + RUNWAY.z1) / 2, PALETTE.trim);
    b.box(0.8, 0.014, RUNWAY.z1 - RUNWAY.z0 - 2, rx - 2.1, 0, (RUNWAY.z0 + RUNWAY.z1) / 2, 0x5d616c);
    b.box(2.6, 0.014, 11, 19.6, 0, -43, 0x6a6e78);
    for (const s of AIRPORT_SLOTS) b.box(1.8, 0.004, 0.03, s.x, 0.016, s.z + 1.1, 0xf2c84b);
    for (let z = RUNWAY.z0; z <= RUNWAY.z1; z += 1) for (const s of [-1, 1]) b.blob(0.03, rx + s * 1.0, 0.05, z, [2.6, 2.4, 1.6], true);
    // Terminal with a curved roof and glass front, control tower, hangars
    b.box(1.6, 0.55, 6, 17.3, 0, -43, 0xe9eef2);
    const roof = new THREE.CylinderGeometry(3.2, 3.2, 1.7, 24, 1, false, -0.35, 0.7).rotateZ(Math.PI / 2).scale(1, 0.18, 1.02);
    b.transformed(roof, new THREE.Matrix4().makeTranslation(17.3, 0.0, -43), 0xc9d2dc, 'glass');
    b.windows({ w: 1.6, d: 6, x: 17.3, z: -43, y0: 0, rows: 1, rowHeight: 0.55, cols: 14, faces: ['x+'] }, r, 0.95, PALETTE.windowCool, { w: 0.34, h: 0.4 });
    b.cylinder(0.2, 0.26, 2.6, 17.4, 0, -38.6, PALETTE.trim, 10);
    b.cylinder(0.55, 0.42, 0.45, 17.4, 2.6, -38.6, 0x6f9fc8, 10, 'glass');
    b.cylinder(0.58, 0.58, 0.06, 17.4, 3.05, -38.6, PALETTE.trim, 10);
    b.blob(0.06, 17.4, 3.25, -38.6, [3, 0.3, 0.2], true);
    for (const hz of [-48.6, -46]) {
      b.box(2.3, 0.85, 2.1, 17.6, 0, hz, 0xd9dde4);
      const vault = new THREE.CylinderGeometry(1.15, 1.15, 2.1, 16, 1, false, 0, Math.PI).rotateX(Math.PI / 2).rotateY(Math.PI / 2).scale(1, 0.45, 1);
      b.transformed(vault, new THREE.Matrix4().makeTranslation(17.6, 0.85, hz), 0xb9c0ca, 'glass');
      b.quad(1.6, 0.7, 18.76, 0.38, hz, 'x+', 0x4a515c, false);
    }
    b.box(0.03, 0.6, 0.03, 27.2, 0, -37, PALETTE.steel);
    b.box(0.3, 0.08, 0.08, 27.35, 0.55, -37, 0xf28a3a);
    for (let i = 0; i < 26; i++) palm(b, r, x0 + 0.3 + r() * 0.5, z0 + 0.6 + r() * (z1 - z0 - 1.2), 1.0, 0);
    return this.add(b, { title: 'Airport', detail: 'Free infrastructure for every city. Planes are what you buy.' });
  }

  private island(): THREE.Group {
    const r = rng(hash(this.seed, 'island'));
    const b = new GeoBuilder();
    const isl = ISLANDS.founder;
    // Lighthouse on the far point
    const lx = isl.x - isl.r + 0.7;
    const lz = isl.z + 0.9;
    const ly = terrainHeight(lx, lz);
    b.cylinder(0.16, 0.22, 1.3, lx, ly, lz, PALETTE.trim, 10);
    b.cylinder(0.19, 0.19, 0.1, lx, ly + 1.3, lz, 0x2a2a2a, 10);
    b.cylinder(0.14, 0.14, 0.2, lx, ly + 1.4, lz, 0xbfe0ff, 10, 'glass');
    b.blob(0.12, lx, ly + 1.5, lz, [3, 2.6, 1.6], true);
    b.cylinder(0.02, 0.2, 0.18, lx, ly + 1.6, lz, 0xc84a3a, 10);
    this.beamCentre.set(lx, ly + 1.5, lz);
    for (let i = 0; i < 9; i++) {
      const a = r() * Math.PI * 2;
      const d = isl.r - 0.7 - r() * 0.6;
      const x = isl.x + Math.cos(a) * d;
      const z = isl.z + Math.sin(a) * d;
      tree(b, r, x, z, 0.85, terrainHeight(x, z) - 0.03, r() < 0.5 ? 'cypress' : 'palm');
    }
    // Launch site (revealed at $1M MRR)
    const L = ISLANDS.launch;
    const pad = new GeoBuilder();
    const py = terrainHeight(L.x, L.z);
    pad.cylinder(1.4, 1.5, 0.12, L.x, py - 0.05, L.z, 0xcfcac0, 20);
    pad.cylinder(0.55, 0.55, 0.02, L.x, py + 0.07, L.z, 0x2a2a30, 16);
    pad.box(0.32, 3.4, 0.32, L.x + 0.95, py + 0.07, L.z - 0.5, 0xd23a2c);
    for (let k = 0; k < 7; k++) pad.box(0.34, 0.03, 0.34, L.x + 0.95, py + 0.4 + k * 0.45, L.z - 0.5, PALETTE.trim);
    pad.box(0.62, 0.05, 0.06, L.x + 0.62, py + 2.8, L.z - 0.36, 0xd23a2c);
    pad.blob(0.06, L.x + 0.95, py + 3.6, L.z - 0.5, [3, 0.3, 0.2], true);
    for (const a of [0.6, 2.4, 4.2]) pad.box(0.35, 0.3, 0.35, L.x + Math.cos(a) * 1.15, py + 0.07, L.z + Math.sin(a) * 1.15, 0xe8e2d6);
    this.launchPad.add(this.add(pad, { title: 'Launch site', detail: 'Buy a rocket to fly to your house on the moon.' }));
    return this.add(b, { title: 'Your island', detail: 'Clears at $100k MRR: an estate and a superyacht.' });
  }

  // ─── Suburbs, Sausalito, Oakland, Treasure Island ───────────────────────

  private suburbs(): THREE.Group {
    const b = new GeoBuilder();
    const r = rng(hash(this.seed, 'suburbs'));
    const walls = [0xf6ecd8, 0xf3c6a2, 0xc6dcf2, 0xbfe4d0, 0xf6df8c, 0xeab6cf, 0xf8f5ee] as const;
    // "Little boxes on the hillside": pastel stucco with a garage at street level and a lit window above.
    // Low roofs in warm greys, not white trim: from afar a row should read as roofs, not dots.
    const roofs = [0xd6cfc2, 0xcbc3b4, 0xded7ca, 0xc2b8a8] as const;
    const house = (x: number, z: number, rot: number, s = 1, width = 0.55) => {
      const y = terrainHeight(x, z);
      const w = width * s;
      const d = 0.5 * s;
      const h = 0.34 * s;
      const c = Math.cos(rot);
      const sn = Math.sin(rot);
      const at = (fx: number, fz: number): [number, number] => [x + fx * c + fz * sn, z - fx * sn + fz * c];
      b.box(w, h, d, x, y - 0.05, z, pick(r, walls), false, rot);
      b.box(w + 0.02, 0.035, d + 0.03, x, y - 0.05 + h, z, pick(r, roofs), false, rot);
      // A few pitched roofs in sun-faded tile and slate; the suburbs are backdrop, not the show.
      if (r() < 0.18) b.hip(w, 0.1 * s, d, x, y - 0.05 + h + 0.03, z, pick(r, [0xc49a80, 0xb7a99a, 0xa59a92, 0xc8ab8e] as const), 0.03);
      const [gx, gz] = at(-0.1 * s, d / 2 + 0.003);
      b.panel(0.2 * s, 0.13 * s, gx, y + 0.02 * s, gz, rot, 0xe8e2d6, false);
      const [wx, wz] = at(0.12 * s, d / 2 + 0.004);
      b.panel(0.14 * s, 0.09 * s, wx, y + 0.17 * s, wz, rot, PALETTE.windowWarm, true, 0.1 + r() * 0.9);
    };
    // Ticky-tacky terraces, wall to wall, each row on its own street over the hills.
    const terraces = (x0: number, x1: number, z0: number, z1: number, coast: number, allowed: (x: number, z: number) => boolean) => {
      for (let z = z1; z > z0; z -= 1.15) {
        let run: number[] = [];
        const street = () => {
          if (run.length >= 3) ribbon(b, [[run[0]! - 0.36, z + 0.5], [run.at(-1)! + 0.36, z + 0.5]], 0.26, PALETTE.road, 0.03);
          run = [];
        };
        for (let x = x0; x < x1; x += 0.68) {
          const h = terrainHeight(x, z);
          const slope = Math.abs(terrainHeight(x + 0.5, z) - terrainHeight(x - 0.5, z)) + Math.abs(terrainHeight(x, z + 0.5) - terrainHeight(x, z - 0.5));
          if (h < 0.15 || h > 7.5 || coastDistance(x, z) > coast || slope > 1.1 || !allowed(x, z)) {
            street();
            continue;
          }
          run.push(x);
          // Now and then an empty lot with a tree, so the row breathes.
          if (r() < 0.06) {
            tree(b, r, x, z, 0.8, h - 0.05, 'round');
            continue;
          }
          house(x, z, 0, 0.9, 0.74);
          // Backyard trees between the rows
          if (r() < 0.16) {
            const tx = x + (r() - 0.5) * 0.4;
            tree(b, r, tx, z - 0.52, 0.7, terrainHeight(tx, z - 0.52) - 0.05, r() < 0.6 ? 'round' : 'cypress');
          }
        }
        street();
      }
    };
    // Daly City and the south
    terraces(-46, 12, -62, -37, -1.5, (x, z) =>
      Math.hypot(x - LANDMARKS.sutroTower.x, z - LANDMARKS.sutroTower.z) >= 3 && !inSign(x, z) && !inHood(x, z) && !(x > AIRPORT.x0 - 2 && z > AIRPORT.z0 - 2));
    // Sausalito on the Marin slope, and boats in Richardson Bay
    for (let i = 0; i < 70; i++) {
      const x = -30 + r() * 7;
      const z = 22.5 + r() * 9;
      if (coastDistance(x, z) > -0.6) continue;
      const h = terrainHeight(x, z);
      if (h > 6) continue;
      house(x, z, Math.PI / 4, 0.9);
    }
    // Oakland: a hazy skyline across the bay, and houses up the hills
    for (let i = 0; i < 14; i++) {
      const x = 58 + r() * 6;
      const z = -10 + r() * 9;
      const h = 1.5 + r() * 4;
      b.box(0.9, h, 0.9, x, terrainHeight(x, z) - 0.1, z, pick(r, [0xc9d2dc, 0xb9c4cf, 0xdcd3c3] as const));
      b.windows({ w: 0.9, d: 0.9, x, z, y0: terrainHeight(x, z), rows: Math.floor(h / 0.3), rowHeight: 0.3, cols: 3, faces: ['x-', 'z+'] }, r, 0.5, [1.6, 1.15, 0.6], { w: 0.14, h: 0.12 });
    }
    // The Oakland and Berkeley flats and hills, behind the downtown towers
    terraces(57, 75, -60, 40, -0.8, (x, z) => !(x < 65 && z > -10 && z < -1));
    // Treasure Island and Yerba Buena
    const t = ISLANDS.treasure;
    for (let i = 0; i < 10; i++) b.box(0.8, 0.35, 0.5, t.x - 1.8 + (i % 5) * 0.8, terrainHeight(t.x, t.z), t.z - 0.8 + Math.floor(i / 5) * 1.4, 0xe2d8c3);
    const yb = ISLANDS.yerba;
    for (let i = 0; i < 26; i++) {
      const a = r() * Math.PI * 2;
      const d = r() * (yb.r - 0.6);
      const x = yb.x + Math.cos(a) * d;
      const z = yb.z + Math.sin(a) * d;
      tree(b, r, x, z, 0.9, terrainHeight(x, z) - 0.05, 'cypress');
    }
    // Chaparral: low clumps of scrub on the open hills, thicker in the folds.
    const scrub = [0x5f7f3a, 0x6f8a42, 0x4f6e36, 0x7d8a4a] as const;
    for (let i = 0; i < 1400; i++) {
      const x = -95 + r() * 215;
      const z = -110 + r() * 190;
      const h = terrainHeight(x, z);
      if (h < 0.8 || coastDistance(x, z) > -1.5) continue;
      if (x > -40 && x < 14 && z > -30 && z < 12) continue; // the city
      if (inSign(x, z) || inHood(x, z)) continue;
      const fold = 0.5 + 0.5 * Math.sin(x * 0.45 + Math.cos(z * 0.33) * 2);
      if (r() > 0.35 + fold * 0.5) continue;
      const k = 0.12 + r() * 0.16;
      const g = new THREE.IcosahedronGeometry(k, 0).scale(1.3, 0.6, 1.1);
      b.transformed(g, new THREE.Matrix4().makeTranslation(x, h + k * 0.25, z), pick(r, scrub), 'smooth');
    }
    // Angel Island and the Marin hills: sparse trees
    for (let i = 0; i < 220; i++) {
      const x = -70 + r() * 55;
      const z = 18 + r() * 40;
      const h = terrainHeight(x, z);
      if (h < 0.5 || r() < 0.55) continue;
      tree(b, r, x, z, 1.1, h - 0.05, r() < 0.6 ? 'cypress' : 'round');
    }
    return this.add(b);
  }

  // ─── TinyTown Hills ─────────────────────────────────────────────────────

  private buildHood() {
    const r = rng(hash(this.seed, 'hood'));
    const b = new GeoBuilder();
    const curve = this.hillRoad;
    // The road surface itself, following the slope
    const n = 260;
    const pos: number[] = [];
    for (let i = 0; i <= n; i++) {
      const p = curve.getPointAt(i / n);
      const t = curve.getTangentAt(i / n);
      const side = new THREE.Vector3(-t.z, 0, t.x).normalize().multiplyScalar(0.32);
      for (const s of [1, -1]) {
        const x = p.x + side.x * s;
        const z = p.z + side.z * s;
        pos.push(x, terrainHeight(x, z) + 0.05, z);
      }
    }
    const idx: number[] = [];
    for (let i = 0; i < n; i++) idx.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
    const road = new THREE.BufferGeometry();
    road.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    road.setIndex(idx);
    road.computeVertexNormals();
    b.transformed(road, new THREE.Matrix4(), PALETTE.road);
    // Villas on terraces either side of the switchbacks
    for (let i = 1; i < 34; i++) {
      const u = i / 34;
      const p = curve.getPointAt(u);
      const t = curve.getTangentAt(u);
      const s = i % 2 ? 1 : -1;
      const off = new THREE.Vector3(-t.z, 0, t.x).normalize().multiplyScalar(s * 1.0);
      const x = p.x + off.x;
      const z = p.z + off.z;
      if (Math.hypot(x - HILLS_HOME.x, z - HILLS_HOME.z) < 2.2 || !inHood(x, z) || inSign(x, z)) continue;
      const near = [...Array(n).keys()].some((k) => curve.getPointAt(k / n).distanceTo(new THREE.Vector3(x, curve.getPointAt(k / n).y, z)) < 0.6);
      if (near) continue;
      villa(b, r, x, z, terrainHeight(x, z));
    }
    for (let i = 0; i < 30; i++) {
      const x = HILLS_HOOD.x0 + r() * (HILLS_HOOD.x1 - HILLS_HOOD.x0);
      const z = HILLS_HOOD.z0 + r() * (HILLS_HOOD.z1 - HILLS_HOOD.z0);
      if (inSign(x, z)) continue;
      palm(b, r, x, z, 1.0, terrainHeight(x, z) - 0.04);
    }
    this.hood.add(this.add(b, { title: 'TinyTown Hills', detail: 'Opens at $1k MRR, when you move into your first Hills house.' }));
  }

  private buildClouds() {
    const bank = (target: THREE.Group, x: number, z: number, w: number, d: number, y: number, key: string, tip: string) => {
      const { group } = cloudBank(x, z, w, d, hash(this.seed, key), y);
      group.userData.tip = { title: 'Under cloud', detail: tip };
      this.pickables.push(group);
      target.add(group);
    };
    const hx = (HILLS_HOOD.x0 + HILLS_HOOD.x1) / 2;
    const hz = (HILLS_HOOD.z0 + HILLS_HOOD.z1) / 2;
    bank(this.clouds.hills, hx, hz, 11, 9, terrainHeight(hx, hz) + 1.4, 'hills', 'TinyTown Hills clear at $1k MRR');
    bank(this.clouds.island, ISLANDS.founder.x, ISLANDS.founder.z, 7.5, 7.5, 1.2, 'island', 'Your island clears at $100k MRR');
    bank(this.clouds.launch, ISLANDS.launch.x, ISLANDS.launch.z, 5, 5, 1, 'launch', 'The launch site clears at $1M MRR');
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
    for (const m of [this.rustSolid, this.rustSmooth]) {
      m.color.set(next.bridgeRusting ? 0x8f735e : 0xffffff);
      m.roughness = next.bridgeRusting ? 1 : m === this.rustSolid ? 0.78 : 0.6;
    }
  }

  update(dt: number, time: number, a: Atmosphere, sunDir: THREE.Vector3) {
    this.terrain.update(time, a, sunDir);
    const night = a.night;
    const turn = time * 0.12;
    if (this.wheelSet.visible) {
      if (this.wheelFrame) this.wheelFrame.rotation.z = turn;
      this.placeGondolas(turn);
    }
    this.mill.sails.rotation.z -= dt * 0.6;
    this.rockLions(time);
    void this.flags;

    // The sign is the first thing cut when upkeep runs short: it sputters, then goes dark.
    this.signFade += (this.state.signLit ? 1 : -0.35) * dt;
    this.signFade = Math.min(1, Math.max(0, this.signFade));
    const sputter = this.signFade > 0 && this.signFade < 1 && Math.random() < 0.35 ? 0.4 : 1;
    this.sign.material.emissiveIntensity = 0.65 * night * this.signFade * sputter;
    this.sign.floodlights.color.setScalar(2.4 * this.signFade * sputter);
    for (const m of this.glows) if (m !== this.sign.floodlights) m.color.setScalar(this.state.lampsFailing ? 0.35 : 1);
    if (this.lampsDimmed !== this.state.lampsFailing) {
      this.lampsDimmed = this.state.lampsFailing;
      for (const key of this.batchKeys) this.batch.setGlow(key, this.lampsDimmed ? 0.35 : 1);
    }
    this.bay.lights.uniforms.uTime!.value = time;
    this.bay.lights.uniforms.uNight!.value = night * (this.state.lampsFailing ? 0.3 : 1);

    // The lighthouse only shines once the island is yours.
    this.beamMat.uniforms.uLevel!.value = 0.55 * night * (this.state.lampsFailing ? 0.3 : 1);
    this.beam.visible = night > 0.05 && this.state.island;
    this.beam.position.copy(this.beamCentre);
    this.beam.rotation.y = time * 0.8;
  }

  /** Point size for the Bay Lights, which needs the drawing buffer's pixel ratio. */
  setPixelRatio(pr: number) {
    this.bay.lights.uniforms.uScale!.value = 3 * pr;
  }
}

// ─── Small parts ──────────────────────────────────────────────────────────

const BEAM = { length: 7, spread: 0.75 };

/**
 * A soft lighthouse beam: brightest at the lamp, fading out along its length
 * and toward its silhouette, so it reads as light in the air, not a solid cone.
 */
function lighthouseBeamMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uLevel: { value: 0 }, uColor: { value: new THREE.Color(1.0, 0.9, 0.66) } },
    vertexShader: `
      varying float vAlong;
      varying vec3 vNormal;
      void main() {
        vAlong = position.x / ${BEAM.length.toFixed(1)};
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform float uLevel;
      uniform vec3 uColor;
      varying float vAlong;
      varying vec3 vNormal;
      void main() {
        // The iso camera is orthographic: it always looks down view-space -z.
        float face = pow(abs(normalize(vNormal).z), 1.4);
        float fall = pow(1.0 - clamp(vAlong, 0.0, 1.0), 2.2);
        gl_FragColor = vec4(uColor * uLevel * face * fall, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

/** A flat strip along a polyline, draped on the terrain (or at `lift` above 0 in the flat city). */
function ribbon(b: GeoBuilder, path: readonly Pt[], width: number, color: ColorLike, lift: number, offset = 0, edgeLines = false) {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const [ax, az] = path[i]!;
    const [bx, bz] = path[i + 1]!;
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.35));
    for (let k = 0; k < n; k++) pts.push(new THREE.Vector3(ax + ((bx - ax) * k) / n, 0, az + ((bz - az) * k) / n));
  }
  pts.push(new THREE.Vector3(path.at(-1)![0], 0, path.at(-1)![1]));
  const pos: number[] = [];
  const lines: number[][] = [[], []];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[Math.min(pts.length - 1, i + 1)]!;
    const o = pts[Math.max(0, i - 1)]!;
    const t = q.clone().sub(o).normalize();
    const nx = -t.z;
    const nz = t.x;
    for (const s of [1, -1]) {
      const x = p.x + nx * (offset + (s * width) / 2);
      const z = p.z + nz * (offset + (s * width) / 2);
      pos.push(x, Math.max(0, terrainHeight(x, z)) + lift, z);
    }
    if (edgeLines) for (const [k, s] of [[0, 1], [1, -1]] as const) {
      const x = p.x + nx * (s * (width / 2 - 0.07));
      const z = p.z + nz * (s * (width / 2 - 0.07));
      lines[k]!.push(x, z);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) idx.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  b.transformed(g, new THREE.Matrix4(), color);
  if (edgeLines && pts.length > 2) {
    // Dashed centre line
    for (let i = 0; i < pts.length - 1; i += 2) {
      const p = pts[i]!;
      const q = pts[i + 1]!;
      const x = (p.x + q.x) / 2;
      const z = (p.z + q.z) / 2;
      const g2 = new THREE.PlaneGeometry(0.04, p.distanceTo(q) * 0.6).rotateX(-Math.PI / 2).rotateY(Math.atan2(q.x - p.x, q.z - p.z));
      b.transformed(g2, new THREE.Matrix4().makeTranslation(x, Math.max(0, terrainHeight(x, z)) + lift + 0.003, z), PALETTE.roadLine);
    }
  }
}

function eucalyptus(b: GeoBuilder, r: () => number, x: number, z: number, y: number, tall: boolean) {
  const s = (tall ? 1.3 : 1) * (0.8 + r() * 0.4);
  if (tall) {
    b.cylinder(0.03 * s, 0.05 * s, 0.9 * s, x, y, z, 0xc9b8a0, 5);
    for (let k = 0; k < 3; k++) {
      const g = new THREE.IcosahedronGeometry(0.2 * s, 1).scale(1, 1.5, 1);
      b.transformed(g, new THREE.Matrix4().makeTranslation(x + (r() - 0.5) * 0.18 * s, y + (0.8 + k * 0.22) * s, z + (r() - 0.5) * 0.18 * s), pick(r, [0x5a8a5a, 0x6a9a68, 0x4f7f55] as const), 'smooth');
    }
  } else {
    // Wind-sculpted Monterey cypress: flat, wide, leaning
    b.cylinder(0.035 * s, 0.05 * s, 0.35 * s, x, y, z, PALETTE.trunk, 5);
    const g = new THREE.IcosahedronGeometry(0.32 * s, 1).scale(1.4, 0.55, 1.1);
    b.transformed(g, new THREE.Matrix4().makeTranslation(x + 0.06 * s, y + 0.45 * s, z), pick(r, [0x2f6a45, 0x3a7a4c, 0x2a5e3e] as const), 'smooth');
    const g2 = new THREE.IcosahedronGeometry(0.22 * s, 1).scale(1.3, 0.5, 1.1);
    b.transformed(g2, new THREE.Matrix4().makeTranslation(x - 0.12 * s, y + 0.6 * s, z + 0.05 * s), pick(r, [0x2f6a45, 0x3a7a4c] as const), 'smooth');
  }
}

function villa(b: GeoBuilder, r: () => number, x: number, z: number, y: number) {
  const wall = pick(r, [0xf8f5ee, 0xf6e7c8, 0xf3c6a2, 0xe8e2d6] as const);
  b.box(1.0, 0.08, 0.8, x, y - 0.15, z, 0xe8e2d6);
  b.box(0.75, 0.3, 0.5, x, y - 0.07, z, wall, false, Math.PI / 4);
  if (r() < 0.5) {
    b.hip(0.75, 0.14, 0.5, x, y + 0.23, z, PALETTE.roofs[0]);
  } else {
    b.box(0.84, 0.035, 0.6, x, y + 0.23, z, PALETTE.trim, false, Math.PI / 4);
    b.box(0.4, 0.22, 0.32, x - 0.1, y + 0.26, z - 0.08, wall, false, Math.PI / 4);
  }
  b.quad(0.42, 0.14, x + 0.19, y + 0.08, z + 0.19, 'z+', [1.6, 1.05, 0.5], true, 0.2 + r() * 0.6);
  b.box(0.36, 0.015, 0.22, x + 0.32, y - 0.06, z - 0.18, PALETTE.pool, 'glass');
}

function moored(b: GeoBuilder, r: () => number, x: number, z: number) {
  const y = SEA;
  b.rbox(0.62, 0.11, 0.22, x, y, z, PALETTE.trim, 0.05, 'smooth', Math.PI / 2);
  b.box(0.18, 0.08, 0.26, x, y + 0.1, z - 0.04, pick(r, [0x3aa3c8, 0xe85a4a, 0xf8f5ee, 0x1c2a3a] as const));
  b.cylinder(0.008, 0.01, 0.75, x, y + 0.1, z + 0.05, PALETTE.trim, 4);
}

function inSign(x: number, z: number): boolean {
  const { x: sx, z: sz } = LANDMARKS.sign;
  const u = (x - sx - (z - sz)) * Math.SQRT1_2;
  const v = (x - sx + (z - sz)) * Math.SQRT1_2;
  return Math.abs(u) < 7.5 && v > -2.2 && v < 1.4;
}

function inHood(x: number, z: number): boolean {
  return x > HILLS_HOOD.x0 && x < HILLS_HOOD.x1 && z > HILLS_HOOD.z0 && z < HILLS_HOOD.z1 && !inSign(x, z);
}

/**
 * A wedge-shaped building on a polygon footprint: stone or glass, with windows
 * on every face, belt courses, a cornice, shopfronts and a rooftop water tank.
 */
function flatiron(b: GeoBuilder, r: () => number, pts: Pt[], h: number, glass: boolean) {
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const cz = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const prism = (poly: Pt[], y: number, height: number, color: ColorLike, grow = 0, bucket: 'solid' | 'glass' = 'solid') => {
    const shape = new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(cx + (x - cx) * (1 + grow), -(cz + (z - cz) * (1 + grow)))));
    const g = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, y, 0);
    b.transformed(g, new THREE.Matrix4(), color, bucket);
  };
  const wall = glass ? pick(r, [0x7fa9c9, 0x8fb5cf] as const) : pick(r, [0xe8dcc4, 0xd9c7a5, 0xc9a27e, 0xb85a3e, 0xf2ece0, 0xd8b48e] as const);
  const trim = glass ? 0xe8edf2 : pick(r, [0xf6f1e4, 0xe0d4bc, 0x9a8f80] as const);
  prism(pts, 0, h, wall, 0, glass ? 'glass' : 'solid');
  prism(pts, 0, 0.26, glass ? 0x5d6f80 : 0x6b5a4a, 0.012);
  prism(pts, h - 0.02, 0.06, trim, 0.05);
  prism(pts, h + 0.04, 0.02, glass ? 0xb9c2cc : 0x8f8a84, -0.04);
  for (let y = 0.26 + 0.6; y < h - 0.3; y += 0.6) prism(pts, y, 0.025, trim, 0.02);
  // Windows on every face, each lit at its own moment of dusk.
  // A glass tower's windows run edge to edge, so fewer are lit and each more softly, or bloom turns it into a lamp.
  const light: ColorLike = glass ? [PALETTE.windowCool[0] * 0.55, PALETTE.windowCool[1] * 0.55, PALETTE.windowCool[2] * 0.55] : PALETTE.windowWarm;
  const share = glass ? 0.35 : 0.6;
  for (let i = 0; i < pts.length; i++) {
    const [px, pz] = pts[i]!;
    const [qx, qz] = pts[(i + 1) % pts.length]!;
    const len = Math.hypot(qx - px, qz - pz);
    let nx = (qz - pz) / len;
    let nz = -(qx - px) / len;
    if (nx * ((px + qx) / 2 - cx) + nz * ((pz + qz) / 2 - cz) < 0) {
      nx = -nx;
      nz = -nz;
    }
    const rot = Math.atan2(nx, nz);
    const cols = Math.max(1, Math.floor(len / 0.17));
    for (let k = 0; k < cols; k++) {
      const u = (k + 0.5) / cols;
      const x = px + (qx - px) * u + nx * 0.007;
      const z = pz + (qz - pz) * u + nz * 0.007;
      // Shopfront at street level
      b.panel(len / cols - 0.04, 0.15, x, 0.11, z, rot, [1.7, 1.2, 0.7], true, 0.1 + r() * 0.3);
      for (let y = 0.4; y < h - 0.12; y += 0.2) {
        b.panel(glass ? len / cols - 0.03 : 0.08, glass ? 0.15 : 0.11, x, y, z, rot, light, true, r() < share ? 0.12 + r() * 0.86 : 2);
      }
    }
  }
  // Water tank on stilts and a stair penthouse
  const [tx, tz] = [cx + (pts[0]![0] - cx) * 0.35, cz + (pts[0]![1] - cz) * 0.35];
  if (!glass) {
    for (const [dx, dz] of [[-0.06, -0.06], [0.06, -0.06], [-0.06, 0.06], [0.06, 0.06]] as const) b.box(0.012, 0.12, 0.012, tx + dx, h + 0.09, tz + dz, 0x4a3a2c);
    b.cylinder(0.1, 0.1, 0.14, tx, h + 0.21, tz, 0x8a6a4a, 10);
    b.cylinder(0.0, 0.11, 0.06, tx, h + 0.35, tz, 0x5a4a3a, 10);
  }
  b.box(0.16, 0.12, 0.16, cx, h + 0.09, cz, glass ? 0xd8dde4 : trim);
}
