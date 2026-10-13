import * as THREE from 'three';
import { GeoBuilder, smoothMaterial, solidMaterial, type ColorLike } from './geo.ts';
import { PALETTE } from './palette.ts';
import { palm, tree, type TreeKind } from './buildings.ts';
import { airliner, cloudBank } from './models.ts';
import { Kit, neonOf, pixelText, shade, tower, wall, winOf } from './towers.ts';
import { gum, hillsHouse, hillsLots, hillsStreets, oak, pine, rock, scrub, strip, type HillsStyle } from './hills.ts';
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
  AIRPORT_FILL,
  AIRPORT_SLOTS,
  HELIPAD,
  HAS,
  ISLAND_COVE,
  TREASURE_COAST,
  BLOCKS,
  CIVIC_BLOCK,
  GRID,
  HILLS_HOME,
  ISLANDS,
  LANDMARKS,
  MARINA,
  MARINA_SLOTS,
  MARKET_END,
  MARKET_START,
  PARKS,
  PIER,
  AIRPORT_ROAD,
  BAY_APPROACH,
  EMBARCADERO,
  GREAT_HIGHWAY,
  PRESIDIO_PKWY,
  RUNWAY,
  SEA,
  SUPERYACHT,
  TWIN_PEAKS_SUMMITS,
  WORLD_SPEC,
  blockCentre,
  type BlockCoord,
  type Park,
  coastDistance,
  fbm,
  gradeWeight,
  hillsPlan,
  inSignZone,
  isBeach,
  naturalHeight,
  shoreZ,
  terrainHeight,
  TOWN_STREET,
  backdropTowns,
  type Pt,
} from '../world/map.ts';
import type { Atmosphere } from '../world/daylight.ts';

export { AIRPORT_SLOTS, DOWNTOWN_HOME, HILLS_HOME, MARINA_SLOTS, SUPERYACHT } from '../world/map.ts';
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
/** A city block's width (4 lots). */
const BLOCK_SIZE = 4;

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
  /** Batch keys of everything in TinyTown Hills that clears with the cloud. */
  private hillKeys: string[] = [];
  private clouds: Record<'hills' | 'island' | 'launch', THREE.Group> = { hills: new THREE.Group(), island: new THREE.Group(), launch: new THREE.Group() };
  private launchKey = '';
  private beam: THREE.Mesh;
  private beamMat: THREE.ShaderMaterial;
  private beamCentre = new THREE.Vector3();
  private sign: Sign;
  private bay: BayBridge;
  private mill: Windmill | null = null;
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
  /** Twin Peaks Boulevard, for anything that drives it. */
  readonly hillRoad: THREE.CatmullRomCurve3;
  private state: SceneryState = { hills: false, island: false, launch: false, ferris: false, coaster: false, signLit: true, lampsFailing: false, bridgeRusting: false };
  private signFade = 1;

  constructor(seed: number) {
    this.seed = seed;
    this.object.add(this.terrain.object);
    this.hillRoad = new THREE.CatmullRomCurve3(hillsPlan().streets[0]!.pts.filter((_, i) => i % 3 === 0).map(([x, z, y]) => new THREE.Vector3(x, y + 0.05, z)), false, 'centripetal');

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
    if (HAS.windmill) this.mill = windmill();
    const civic = blockCentre(CIVIC_BLOCK);
    // Landmarks with moving or custom-lit parts stay objects of their own; the rest are batched.
    for (const l of [gg, this.bay.group, this.mill?.group, this.sign.group]) {
      if (!l) continue;
      this.object.add(l);
      this.pickables.push(l);
      this.collectGlows(l);
    }
    this.glows.push(this.sign.floodlights);
    this.object.add(this.batch.object);
    this.pickables.push(this.batch.object);
    // Every city has City Hall and the Ferry Building; the rest of the landmarks are this world's own selection.
    const { conservatory: cons } = LANDMARKS;
    const optional = [HAS.coit && coitTower, HAS.palace && palaceOfFineArts, HAS.sutro && sutroTower, HAS.conservatory && (() => conservatory(cons.x, cons.z)), HAS.cliffHouse && cliffHouse];
    for (const l of [cityHall(civic.x, civic.z), ferryBuilding(), ...optional.filter((f): f is () => THREE.Group => !!f).map((f) => f())]) this.fix(l);
    for (const part of [this.roads(), this.marketPlazas(), this.parks(), this.marina(), this.airport(), this.island(), this.suburbs()]) this.fix(part);
    this.object.add(this.waterfront());
    this.object.add(this.clouds.hills, this.clouds.island, this.clouds.launch);
    this.buildHood();
    this.buildClouds();

    this.beamMat = lighthouseBeamMaterial();
    // Narrow at the lamp, widening out to sea along +x.
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(BEAM.spread, 0.05, BEAM.length, 20, 1, true).rotateZ(-Math.PI / 2).translate(BEAM.length / 2, 0, 0), this.beamMat);
    this.beam.renderOrder = 3;
    this.object.add(this.beam);
  }

  /** Moves a static model into the batch (its tooltip comes too). Returns its batch key. */
  private fix(group: THREE.Group): string {
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
    return key;
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
    const market = BLOCKS.filter((x) => x.use === 'market');
    const lastBx = Math.min(...market.map((x) => x.bx));
    for (const blk of market) {
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
        // A plaza at each end: at the Ferry Building (north side) and where Market meets the hills (south side).
        const plaza = (blk.bx === 1 && s < 0) || (blk.bx === lastBx && s > 0);
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
    const classic = WORLD_SPEC.classic;
    const parkTrees = WORLD_SPEC.look.parkTrees as readonly TreeKind[];
    const big = PARKS.find((p) => p.kind === 'park');
    if (big) {
      if (big.blocks.every((q) => q.bz === big.blocks[0]!.bz)) this.stripPark(b, r, big, parkTrees);
      else this.centralPark(b, r, big, parkTrees);
    }
    for (const sq of PARKS.filter((p) => p.kind === 'square')) this.square(sq);
    // The Presidio and Lands End: cypress and eucalyptus on rolling ground
    const gx = LANDMARKS.goldenGate.x;
    const presidioEast = Math.max(-25, ...BLOCKS.filter((q) => q.use === 'presidio').map((q) => q.bx * 5 + 2.5));
    const xr = classic ? 22 : presidioEast + 47;
    const westEdge = GRID.bx0 * 5 - 2.5;
    for (let i = 0; i < (classic ? 520 : Math.round(520 * (xr / 22))); i++) {
      const x = -47 + r() * xr;
      const z = -4 + r() * 14;
      if (coastDistance(x, z) > -0.8) continue;
      if (HAS.palace && Math.hypot(x - LANDMARKS.palaceOfFineArts.x, z - LANDMARKS.palaceOfFineArts.z) < 3) continue;
      if (x > westEdge - 0.1 && z < -2.4) continue;
      const blk = BLOCKS.find((q) => Math.abs(q.bx * 5 - x) <= 3 && Math.abs(q.bz * 5 - z) <= 3);
      if (blk && blk.use !== 'presidio' && blk.use !== 'hill') continue;
      if (Math.abs(x - gx) < 0.8 && z > 0) continue; // the Golden Gate viaduct
      if (nearPath(PRESIDIO_PKWY, x, z, 0.9)) continue; // and the parkway it comes down onto
      if (HAS.cliffHouse && hidesCliffHouse(x, z)) continue;
      if (classic ? Math.abs(x + 39.8) < 0.7 : nearPath(GREAT_HIGHWAY, x, z, 0.75)) continue; // highway
      if (!classic && (nearPath(EMBARCADERO, x, z, 0.8) || (HAS.windmill && Math.hypot(x - LANDMARKS.windmill.x, z - LANDMARKS.windmill.z) < 1.6))) continue;
      const y = terrainHeight(x, z);
      eucalyptus(b, r, x, z, y, r() < 0.5);
    }
    // Telegraph Hill: scattered trees on the slopes (all over it when there's no tower on top)
    if (WORLD_SPEC.telegraph) {
      for (let i = 0; i < 70; i++) {
        const a = r() * Math.PI * 2;
        const d = 0.8 + r() * 2.4;
        const x = LANDMARKS.coitTower.x + Math.cos(a) * d;
        const z = LANDMARKS.coitTower.z + Math.sin(a) * d;
        if (d < 1.1 && HAS.coit) continue;
        tree(b, r, x, z, 0.8, terrainHeight(x, z) - 0.03, r() < 0.6 ? 'round' : 'cypress');
      }
    }
    // The waterfront's points and headlands: Monterey cypress in windblown clumps, lawn between.
    if (!classic) {
      for (let gx2 = gx + 3; gx2 < 8; gx2 += 0.55) {
        for (let gz = 8.8; gz < 18; gz += 0.55) {
          const x = gx2 + (r() - 0.5) * 0.5;
          const z = gz + (r() - 0.5) * 0.5;
          if (coastDistance(x, z) > -0.9 || isBeach(x, z)) continue;
          if (BLOCKS.some((q) => Math.max(Math.abs(q.bx * 5 - x), Math.abs(q.bz * 5 - z)) < 3.3)) continue;
          if (nearPath(EMBARCADERO, x, z, 0.95) || nearPath(PRESIDIO_PKWY, x, z, 0.9)) continue;
          if (x > PIER.x0 - 1.2 && x < PIER.x1 + 1.2 && z < PIER.z0 + 1.5) continue;
          const g = MARINA.green;
          if (g && Math.abs(x - g.x) < g.w / 2 + 0.3 && Math.abs(z - g.z) < g.d / 2 + 0.3) continue;
          if (Math.abs(x - LANDMARKS.goldenGate.x) < 1.0) continue;
          const clump = 0.5 + 0.5 * fbm(x * 0.5 + 7, z * 0.5 - 3, 2);
          if (r() > (clump - 0.42) * 1.6) continue;
          tree(b, r, x, z, 0.8 + r() * 0.4, terrainHeight(x, z) - 0.02, r() < 0.7 ? 'cypress' : 'round');
        }
      }
    }
    // Marina Green
    const green = MARINA.green;
    if (green) b.box(green.w, 0.012, green.d, green.x, 0.005, green.z, 0x7fc252);
    return this.add(b);
  }

  /**
   * Golden Gate Park: a long strip from the ocean, dense with trees, with
   * meadows, Stow Lake, a pagoda and the de Young's copper tower.
   */
  private stripPark(b: GeoBuilder, r: () => number, big: Park, kinds: readonly TreeKind[]) {
    const xs = big.blocks.map((q) => q.bx * 5);
    const zc = big.blocks[0]!.bz * 5;
    const park = { x0: Math.min(...xs) - 2.5, x1: Math.max(...xs) + 2.5, z0: zc - 2.5, z1: zc + 2.5 };
    const W = park.x1 - park.x0;
    // Where things stand along the park: the classic map's spots, or the same proportions on another length.
    const classic = WORLD_SPEC.classic;
    const at = (classicDx: number, share: number) => park.x0 + (classic ? classicDx : W * share);
    const lake = { x: at(10.5, 0.42), z: zc - 0.2 };
    const pagoda = { x: at(16, 0.62), z: zc - 1.2 };
    const museum = { x: at(17.7, 0.66), z: zc + 1.4 };
    const cons = LANDMARKS.conservatory;
    const meadows = [{ x: at(5.5, 0.22), z: zc }, { x: at(14, 0.54), z: zc + 1 }];
    b.box(park.x1 - park.x0, 0.012, park.z1 - park.z0, (park.x0 + park.x1) / 2, 0, (park.z0 + park.z1) / 2, 0x6aae47);
    const lakeGeo = new THREE.CircleGeometry(1.4, 28).rotateX(-Math.PI / 2).scale(1.4, 1, 0.8);
    b.transformed(lakeGeo, new THREE.Matrix4().makeTranslation(lake.x, 0.02, lake.z), 0x3d9fb0, 'glass');
    b.cylinder(0.55, 0.6, 0.08, lake.x, 0.02, lake.z, 0x6aae47, 12);
    for (let i = 0; i < 6; i++) tree(b, r, lake.x + (r() - 0.5) * 0.8, lake.z + (r() - 0.5) * 0.6, 0.7, 0.1, 'round');
    b.box(0.4, 0.3, 0.4, pagoda.x, 0.01, pagoda.z, 0xc8402e);
    for (let k = 0; k < 3; k++) b.hip(0.55 - k * 0.12, 0.12, 0.55 - k * 0.12, pagoda.x, 0.31 + k * 0.16, pagoda.z, 0x3a3a3a, 0.08, 0.1);
    const cu = new THREE.BoxGeometry(0.6, 1.4, 0.6);
    cu.translate(0, 0.7, 0);
    cu.applyMatrix4(new THREE.Matrix4().makeShear(0, 0, 0.12, 0, 0, 0));
    cu.rotateY(0.3);
    b.transformed(cu, new THREE.Matrix4().makeTranslation(museum.x, 0.01, museum.z), 0xa86a3e);
    b.box(2.2, 0.35, 1.0, museum.x + 0.2, 0.01, museum.z - 1.0, 0xa86a3e);
    for (let i = 0; i < (classic ? 300 : Math.round(60 * big.blocks.length)); i++) {
      const x = park.x0 + 0.6 + r() * (park.x1 - park.x0 - 1.2);
      const z = park.z0 + 0.5 + r() * (park.z1 - park.z0 - 1);
      if (Math.hypot((x - lake.x) / 1.6, (z - lake.z) / 1.1) < 1.4) continue; // lake
      if (HAS.conservatory && Math.abs(x - cons.x) < 1.7 && Math.abs(z - cons.z) < 1.1) continue; // conservatory
      if (Math.abs(x - museum.x + 0.2) < 1.4 && Math.abs(z - museum.z + 0.7) < 1.2) continue; // museum
      if (Math.hypot(x - meadows[0]!.x, z - meadows[0]!.z) < 1.3 || Math.hypot(x - meadows[1]!.x, z - meadows[1]!.z) < 0.9) continue; // meadows
      if (!classic && Math.hypot(x - pagoda.x, z - pagoda.z) < 0.5) continue;
      const scale = 0.8 + r() * 0.6;
      tree(b, r, x, z, scale, 0.01, classic ? (r() < 0.45 ? 'round' : r() < 0.85 ? 'cypress' : 'palm') : kinds[Math.floor(r() * kinds.length)]!);
    }
  }

  /**
   * A park of a few blocks: lawns round a lake with a boathouse, paths, a
   * bandshell, dense woods round the edge (and the Conservatory, if this city has one).
   */
  private centralPark(b: GeoBuilder, r: () => number, big: Park, kinds: readonly TreeKind[]) {
    const xs = big.blocks.map((q) => q.bx * 5);
    const zs = big.blocks.map((q) => q.bz * 5);
    const x0 = Math.min(...xs) - 2.5;
    const x1 = Math.max(...xs) + 2.5;
    const z0 = Math.min(...zs) - 2.5;
    const z1 = Math.max(...zs) + 2.5;
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    b.box(x1 - x0, 0.012, z1 - z0, cx, 0, cz, 0x6aae47);
    // The lake: long, a little off centre, an island with a gazebo.
    const lake = { x: cx - 0.6, z: cz - 0.4, rx: (x1 - x0) * 0.24, rz: Math.min(1.6, (z1 - z0) * 0.16) };
    const lakeGeo = new THREE.CircleGeometry(1, 32).rotateX(-Math.PI / 2).scale(lake.rx, 1, lake.rz);
    b.transformed(lakeGeo.clone().scale(1.06, 1, 1.12), new THREE.Matrix4().makeTranslation(lake.x, 0.014, lake.z), 0xd8cdb8);
    b.transformed(lakeGeo, new THREE.Matrix4().makeTranslation(lake.x, 0.022, lake.z), 0x3d9fb0, 'glass');
    b.cylinder(0.38, 0.42, 0.06, lake.x + lake.rx * 0.35, 0.02, lake.z, 0x6aae47, 12);
    b.cylinder(0.14, 0.16, 0.16, lake.x + lake.rx * 0.35, 0.08, lake.z, 0xf2ede2, 8);
    b.cylinder(0, 0.2, 0.1, lake.x + lake.rx * 0.35, 0.24, lake.z, 0x6a3a2a, 8);
    // The boathouse on the north shore, rowing boats tied up.
    const bh = { x: lake.x - lake.rx * 0.45, z: lake.z + lake.rz + 0.35 };
    b.box(0.8, 0.26, 0.42, bh.x, 0.012, bh.z, 0xe8dcc4);
    b.gable(0.8, 0.14, 0.42, bh.x, 0.27, bh.z, 0x7a4a36, 0.04);
    for (let k = 0; k < 3; k++) b.rbox(0.22, 0.04, 0.08, bh.x - 0.25 + k * 0.25, SEA * 0 + 0.03, bh.z - 0.45, pick(r, [0xe85a2a, 0xf2efe8, 0x2a6db8] as const), 0.02, 'smooth', 0.3);
    // Paths: a loop round the lake and a cross walk.
    const loop: Pt[] = [];
    for (let k = 0; k <= 32; k++) {
      const a = (k / 32) * Math.PI * 2;
      loop.push([lake.x + Math.cos(a) * (lake.rx + 0.75), lake.z + Math.sin(a) * (lake.rz + 0.7)]);
    }
    ribbon(b, loop, 0.14, 0xd9cdb2, 0.018);
    ribbon(b, [[x0 + 0.3, cz + 1.9], [x1 - 0.3, cz + 1.9]], 0.16, 0xd9cdb2, 0.018);
    ribbon(b, [[cx + 1.2, z0 + 0.3], [cx + 1.2, z1 - 0.3]], 0.16, 0xd9cdb2, 0.018);
    // A bandshell facing a meadow in the south-west.
    const bs = { x: x0 + 2.2, z: z0 + 1.6 };
    b.box(1.0, 0.06, 0.6, bs.x, 0.012, bs.z, 0xd8d2c4);
    const shell = new THREE.SphereGeometry(0.5, 14, 8, 0, Math.PI, 0, Math.PI / 2).rotateY(-Math.PI * 0.75);
    b.transformed(shell, new THREE.Matrix4().makeTranslation(bs.x, 0.07, bs.z), 0xf4f1ea, 'smooth');
    const cons = LANDMARKS.conservatory;
    const n = Math.round(62 * big.blocks.length);
    for (let i = 0; i < n; i++) {
      const x = x0 + 0.5 + r() * (x1 - x0 - 1);
      const z = z0 + 0.5 + r() * (z1 - z0 - 1);
      if (Math.hypot((x - lake.x) / (lake.rx + 1.0), (z - lake.z) / (lake.rz + 0.95)) < 1) continue; // lake and its path
      if (Math.abs(z - cz - 1.9) < 0.3 || Math.abs(x - cx - 1.2) < 0.3) continue; // paths
      if (HAS.conservatory && Math.abs(x - cons.x) < 1.8 && Math.abs(z - cons.z) < 1.0) continue;
      if (Math.hypot(x - bs.x, z - bs.z - 0.9) < 1.5) continue; // the meadow in front of the bandshell
      if (Math.hypot(x - bh.x, z - bh.z) < 0.7) continue;
      // Woods round the edges, open lawn in the middle.
      const edge = Math.min(x - x0, x1 - x, z - z0, z1 - z);
      if (edge > 2.2 && r() < 0.55) continue;
      tree(b, r, x, z, 0.8 + r() * 0.6, 0.01, kinds[Math.floor(r() * kinds.length)]!);
    }
  }

  /** A square: one block of lawn with paths, trees round the edge and something to do in the middle. */
  private square(park: Park) {
    const blk: BlockCoord = park.blocks[0]!;
    const r = rng(hash(this.seed, 'square', blk.bx, blk.bz));
    const b = new GeoBuilder();
    const { x, z } = blockCentre(blk);
    const kinds = WORLD_SPEC.look.parkTrees as readonly TreeKind[];
    b.box(BLOCK_SIZE, 0.02, BLOCK_SIZE, x, 0, z, PALETTE.sidewalk);
    b.box(BLOCK_SIZE - 0.3, 0.03, BLOCK_SIZE - 0.3, x, 0, z, 0x7cbc52);
    const path = 0xe0d6c2;
    const style = hash(WORLD_SPEC.seed, 'square-style', blk.bx, blk.bz) % 4;
    if (style === 0) {
      // Diagonal walks to a fountain.
      for (const s of [-1, 1]) ribbon(b, [[x - 1.75, z - 1.75 * s], [x + 1.75, z + 1.75 * s]], 0.16, path, 0.034);
      b.cylinder(0.42, 0.46, 0.08, x, 0.03, z, 0xd8d2c4, 18);
      b.cylinder(0.36, 0.36, 0.01, x, 0.1, z, 0x5fc7d6, 18, 'glass');
      b.cylinder(0.05, 0.08, 0.3, x, 0.1, z, 0xd8d2c4, 8);
    } else if (style === 1) {
      // A cross of walks and a bandstand.
      ribbon(b, [[x - 1.8, z], [x + 1.8, z]], 0.16, path, 0.034);
      ribbon(b, [[x, z - 1.8], [x, z + 1.8]], 0.16, path, 0.034);
      b.cylinder(0.4, 0.42, 0.08, x, 0.03, z, 0xd8d2c4, 10);
      for (let k = 0; k < 8; k++) b.cylinder(0.012, 0.012, 0.26, x + Math.cos((k / 8) * Math.PI * 2) * 0.34, 0.11, z + Math.sin((k / 8) * Math.PI * 2) * 0.34, 0xf4f1ea, 4);
      b.cylinder(0, 0.46, 0.16, x, 0.37, z, 0x3f6a5a, 10);
    } else if (style === 2) {
      // Tennis courts on one half, a lawn on the other.
      for (const dx of [-0.75, 0.75]) {
        b.box(1.3, 0.008, 2.2, x + dx, 0.03, z - 0.5, 0x4f8a6a);
        b.box(1.1, 0.004, 1.9, x + dx, 0.038, z - 0.5, 0x3f6f9a);
        b.box(1.12, 0.06, 0.012, x + dx, 0.04, z - 0.5, 0xf2efe8);
      }
      ribbon(b, [[x - 1.8, z + 1.2], [x + 1.8, z + 1.2]], 0.14, path, 0.034);
    } else {
      // A playground under the trees, a meandering path.
      ribbon(b, [[x - 1.8, z - 0.9], [x - 0.6, z + 0.3], [x + 0.6, z - 0.2], [x + 1.8, z + 1.0]], 0.16, path, 0.034);
      b.box(1.2, 0.01, 0.9, x + 0.4, 0.03, z + 1.0, 0xd9b47a);
      b.box(0.5, 0.26, 0.12, x + 0.2, 0.04, z + 1.0, 0xe85a4a);
      b.box(0.08, 0.3, 0.08, x + 0.65, 0.04, z + 1.15, 0x2a6db8);
      b.box(0.36, 0.03, 0.06, x + 0.65, 0.3, z + 0.95, 0xf2c84b, false, 0.6);
    }
    // Trees round the edge, evenly spaced, and a few on the lawn.
    for (let k = 0; k < 16; k++) {
      const side = k % 4;
      const t = -1.5 + Math.floor(k / 4);
      const [tx, tz] = side === 0 ? [x + t, z - 1.62] : side === 1 ? [x + t + 1, z + 1.62] : side === 2 ? [x - 1.62, z + t + 1] : [x + 1.62, z + t];
      if (r() < 0.15) continue;
      tree(b, r, tx, tz, 0.8 + r() * 0.3, 0.03, kinds[Math.floor(r() * kinds.length)]!);
    }
    for (let k = 0; k < 4; k++) {
      const tx = x + (r() - 0.5) * 2.4;
      const tz = z + (r() - 0.5) * 2.4;
      if (Math.hypot(tx - x, tz - z) < 0.9) continue;
      tree(b, r, tx, tz, 0.9, 0.03, kinds[Math.floor(r() * kinds.length)]!);
    }
    const group = this.add(b, { title: park.name, detail: 'A neighbourhood park. Every city has a few, in different places.' });
    this.fix(group);
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
    // On the shore at the foot of the wharf, west of the pier.
    const sx = x0 - 2.2;
    const sz = WORLD_SPEC.classic ? 10.2 : shoreZ(sx) - 0.4;
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
    const { x: mx, z: mz } = MARINA;
    const bw = new THREE.TorusGeometry(3.2, 0.18, 4, 24, Math.PI * 0.7).rotateX(Math.PI / 2).rotateY(Math.PI * 0.15);
    b.transformed(bw, new THREE.Matrix4().makeTranslation(mx, SEA + 0.1, mz), 0xb4ab9c);
    for (let k = 0; k < 5; k++) {
      const x = mx - 2.6 + k * 1.2;
      b.box(0.14, 0.05, 2.6, x, SEA + 0.12, mz + 1.2, PALETTE.wood);
      for (let j = 0; j < 3; j++) b.box(0.6, 0.05, 0.1, x + 0.36, SEA + 0.12, mz + 0.4 + j * 0.8, PALETTE.wood);
      for (let j = 0; j < 3; j++) if (r() < 0.75) moored(b, r, x + 0.35, mz + 0.75 + j * 0.8);
    }
    for (const s of MARINA_SLOTS) b.box(0.1, 0.05, 1.4, s.x - 0.55, SEA + 0.12, s.z, PALETTE.wood);
    return this.add(b, { title: 'The Marina', detail: 'Yacht berths open at $10k MRR.' });
  }

  /**
   * The airport, SFO-style, on fill out into the bay behind a riprap seawall:
   * one long runway with its markings, lights and approach lights out over
   * the water on piers; a parallel taxiway; a terminal under a wing of a
   * roof with two boarding piers, jet bridges and airliners at the gates; the
   * private apron where the founder's jets park; the control tower, hangars,
   * a parking garage, and the helipad.
   */
  private airport(): THREE.Group {
    const r = rng(hash(this.seed, 'airport'));
    const b = new Kit();
    const rx = RUNWAY.x;
    const y = 0.0;
    const asphalt = 0x4c5059;
    const concrete = 0xc9c4b8;
    const yellow = PALETTE.roadYellow;
    const white = PALETTE.trim;
    const EDGE: ColorLike = [2.6, 2.3, 1.5];
    const BLUE: ColorLike = [0.5, 1.0, 2.8];
    const GREEN: ColorLike = [0.5, 2.6, 0.9];
    const RED: ColorLike = [2.8, 0.35, 0.25];
    const paint = (w: number, d: number, x: number, z: number, color: ColorLike, lift = 0.018, rot = 0) => b.box(w, 0.003, d, x, y + lift, z, color, false, rot);
    // Seawall: riprap where the fill meets the bay, a concrete coping along the top.
    seawall(b, r, AIRPORT_FILL);
    // The runway: grooved asphalt, blast pads, piano keys, touchdown bars, aiming points, centreline, edge lines.
    const z0 = RUNWAY.z0;
    const z1 = RUNWAY.z1;
    b.box(1.8, 0.016, z1 - z0 + 1.6, rx, y, (z0 + z1) / 2, asphalt);
    for (const end of [z0 - 0.8, z1 + 0.8]) {
      for (let k = 0; k < 5; k++) paint(1.5, 0.05, rx, end + (end < z0 ? 1 : -1) * (-0.3 + k * 0.15), yellow, 0.018, 0);
    }
    for (const [end, dir] of [[z0, 1], [z1, -1]] as const) {
      for (let k = -3; k <= 3; k++) if (k !== 0) paint(0.11, 0.6, rx + k * 0.21, end + dir * 0.4, white);
      paint(1.7, 0.05, rx, end, white);
      runwayNumber(b, dir > 0 ? '36' : '18', rx, y + 0.019, end + dir * 1.15, dir);
      // Aiming points and touchdown bars
      for (const s of [-1, 1]) {
        paint(0.16, 0.9, rx + s * 0.42, end + dir * 2.6, white);
        for (let k = 0; k < 3; k++) paint(0.06, 0.4, rx + s * 0.38, end + dir * (1.8 + k * 0.0) + dir * (k * 0.6 + 1.4), white);
      }
    }
    for (let z = z0 + 3.2; z < z1 - 3.2; z += 0.9) paint(0.05, 0.5, rx, z, white);
    for (const s of [-1, 1]) paint(0.035, z1 - z0, rx + s * 0.84, (z0 + z1) / 2, white);
    // Runway lights: white edges, green thresholds, red ends; approach lights out over the bay on piers.
    for (let z = z0; z <= z1 + 0.01; z += 0.8) for (const s of [-1, 1]) b.blob(0.028, rx + s * 0.95, y + 0.04, z, EDGE, true);
    for (let k = -4; k <= 4; k++) {
      b.blob(0.03, rx + k * 0.2, y + 0.04, z0 - 0.08, GREEN, true);
      b.blob(0.03, rx + k * 0.2, y + 0.04, z1 + 0.08, GREEN, true);
    }
    for (let z = z0 - 1.4; z > -56.4; z -= 0.75) {
      const over = z < AIRPORT_FILL[6]![1];
      if (over) {
        b.box(0.06, 0.6, 0.06, rx, SEA - 0.1, z, 0x8f8a80);
        b.box(0.7, 0.04, 0.05, rx, SEA + 0.5, z, 0x8f8a80);
      }
      const ly = over ? SEA + 0.55 : y + 0.04;
      for (let k = -2; k <= 2; k++) b.blob(0.026, rx + k * 0.14, ly, z, k === 0 ? EDGE : [2.6, 2.4, 2.0], true);
    }
    // Taxiway A, parallel to the runway, and the turn-offs the airliners use.
    const tx = rx - 2.1;
    b.box(0.72, 0.014, 11.6, tx, y, -43.2, 0x5a5e68);
    paint(0.03, 11.4, tx, -43.2, yellow, 0.016);
    for (const link of [[[rx - 0.2, -38.3], [tx + 0.6, -38.8], [tx, -39.6]], [[tx, -46.8], [tx + 0.5, -48.6], [rx - 0.2, -49.2]]] as const) {
      const pts = link.map(([x, z]) => [x, z, y + 0.002] as const);
      strip(b, pts, 0.72, 0x5a5e68, 0.012);
      strip(b, pts, 0.03, yellow, 0.015);
    }
    for (let z = -48.8; z <= -37.8; z += 1) for (const s of [-1, 1]) b.blob(0.022, tx + s * 0.4, y + 0.035, z, BLUE, true);
    // The private apron, where your jets park nose-out: stands with lead-in lines and stop bars.
    b.box(4.6, 0.014, 10.4, 20.3, y, -43.1, concrete);
    for (let k = 0; k < 5; k++) paint(4.6, 0.012, 20.3, -48.3 + k * 2.6, 0xb5b0a4, 0.016);
    for (const slot of AIRPORT_SLOTS) {
      paint(3.6, 0.03, slot.x + 1.5, slot.z, yellow, 0.017);
      paint(0.03, 0.5, slot.x + 1.02, slot.z, yellow, 0.017);
      b.box(0.08, 0.14, 0.08, 18.15, y, slot.z + 0.85, 0x3a3f4a);
      b.blob(0.025, 18.15, y + 0.16, slot.z + 0.85, [1.6, 2.4, 1.2], true);
    }
    // The terminal: a long hall under a wing of a roof, glass to the airfield, a lit name along the top.
    const tw = 2.6;
    const tl = 10.6;
    const tcx = 16.3;
    const tcz = -43.0;
    b.box(tw + 0.6, 0.012, tl + 0.8, tcx, y, tcz, 0xd8d2c4);
    b.box(tw, 0.62, tl, tcx, y, tcz, 0xe9eef2);
    b.windows({ w: tw, d: tl, x: tcx, z: tcz, y0: y + 0.04, rows: 2, rowHeight: 0.28, cols: 30, faces: ['x+', 'x-'] }, r, 0.92, PALETTE.windowCool, { w: 0.3, h: 0.22 });
    b.windows({ w: tw, d: tl, x: tcx, z: tcz, y0: y + 0.04, rows: 2, rowHeight: 0.28, cols: 7, faces: ['z+', 'z-'] }, r, 0.92, PALETTE.windowCool, { w: 0.28, h: 0.22 });
    // The roof: a shallow vault along the hall, overhanging the glass on the airfield side, ribbed, with skylights.
    const R = 3.4;
    const half = 0.5;
    const roof = new THREE.CylinderGeometry(R, R, tl + 0.6, 28, 1, true, Math.PI - half, half * 2).rotateX(Math.PI / 2).translate(0, -R, 0).scale(1, 0.55, 1);
    const lift = y + 0.62 + R * (1 - Math.cos(half)) * 0.55;
    b.transformed(roof, new THREE.Matrix4().makeTranslation(tcx + 0.25, lift, tcz), 0xdfe5ea, 'smooth');
    const under = roof.clone().scale(1, 1, 1);
    b.transformed(under.applyMatrix4(new THREE.Matrix4().makeScale(-1, 1, 1)), new THREE.Matrix4().makeTranslation(tcx + 0.25, lift - 0.02, tcz), 0x9aa4ae, 'smooth');
    for (let k = 0; k < 12; k++) {
      const zk = tcz - tl / 2 + 0.4 + k * ((tl - 0.8) / 11);
      b.box(R * 2 * Math.sin(half) + 0.04, 0.025, 0.05, tcx + 0.25, lift + 0.005, zk, 0xb8c2cc);
      if (k % 3 === 1) b.box(0.5, 0.02, 0.6, tcx + 0.25, lift + 0.01, zk + 0.45, 0x8fb8d8, 'glass');
    }
    for (let k = 0; k < 9; k++) b.box(0.04, 0.05, 0.04, tcx + tw / 2 + 0.25, y + 0.62, tcz - tl / 2 + 0.6 + k * 1.18, 0xb8c0c8);
    pixelText(neonOf(b), 'glow', 'TINYTOWN INTL', tcx + tw / 2 + 0.012, y + 0.48, tcz, 1, 0, 0.034, [2.2, 2.0, 1.6]);
    // Two boarding piers with gates, jet bridges and airliners nosed in.
    const piers: { z: number; side: number; gates: number[] }[] = [
      { z: -37.2, side: 1, gates: [18.9] },
      { z: -49.0, side: -1, gates: [18.9, 21.3] },
    ];
    for (const pier of piers) {
      const px0 = tcx + tw / 2;
      const px1 = pier.gates.at(-1)! + 0.9;
      b.box(px1 - px0, 0.34, 0.56, (px0 + px1) / 2, y, pier.z, 0xe4e9ee);
      b.box(px1 - px0 + 0.06, 0.04, 0.62, (px0 + px1) / 2, y + 0.34, pier.z, 0xb8c0c8);
      b.windows({ w: px1 - px0, d: 0.56, x: (px0 + px1) / 2, z: pier.z, y0: y + 0.06, rows: 1, rowHeight: 0.22, cols: Math.round((px1 - px0) * 4), faces: ['z+', 'z-'] }, r, 0.95, PALETTE.windowCool, { w: 0.18, h: 0.16 });
      for (const gx of pier.gates) {
        // The airliner: nose to the pier, on its stand line.
        const plane = airliner(hash(this.seed, 'gate', gx, pier.z));
        plane.group.position.set(gx, y + 0.02, pier.z + pier.side * (0.28 + 1.33));
        plane.group.rotation.y = pier.side > 0 ? -Math.PI / 2 : Math.PI / 2;
        plane.group.userData.tip = { title: 'At the gate', detail: 'Boarding for the other founders’ cities. Flights are coming soon.' };
        this.fix(plane.group);
        paint(0.03, 2.4, gx, pier.z + pier.side * 1.5, yellow, 0.017);
        // Jet bridge: a rotunda on the pier, a telescoping tunnel to the forward door.
        const fz = pier.z + pier.side * 0.28;
        const doorZ = pier.z + pier.side * (0.28 + 0.62);
        const rxx = gx - 0.55;
        b.cylinder(0.1, 0.1, 0.3, rxx, y, fz + pier.side * 0.12, 0xd8dde2, 10);
        const bl = Math.hypot(gx - 0.16 - rxx, doorZ - (fz + pier.side * 0.12));
        const ang = Math.atan2(gx - 0.16 - rxx, doorZ - (fz + pier.side * 0.12));
        b.box(0.1, 0.1, bl, (rxx + gx - 0.16) / 2, y + 0.17, (fz + pier.side * 0.12 + doorZ) / 2, 0xc8ced6, false, ang);
        b.box(0.04, 0.17, 0.04, (rxx + gx - 0.16) / 2, y, (fz + pier.side * 0.12 + doorZ) / 2, 0x6a7078);
      }
    }
    // Control tower: a slender shaft, a flared cab with tinted glass, a beacon.
    const cx = 17.1;
    const cz = -35.4;
    b.cylinder(0.32, 0.38, 0.3, cx, y, cz, 0xd8dde2, 12);
    b.cylinder(0.16, 0.22, 2.9, cx, y, cz, 0xe8ecef, 12);
    b.cylinder(0.42, 0.24, 0.22, cx, y + 2.9, cz, 0xd8dde2, 12);
    b.cylinder(0.44, 0.4, 0.3, cx, y + 3.12, cz, 0x5a8ab0, 12, 'glass');
    b.cylinder(0.48, 0.48, 0.05, cx, y + 3.42, cz, 0xd8dde2, 12);
    b.cylinder(0.02, 0.02, 0.3, cx, y + 3.47, cz, 0x8a9098, 4);
    b.blob(0.06, cx, y + 3.8, cz, RED, true);
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      b.quad(0.2, 0.18, cx + Math.cos(a) * 0.43, y + 3.27, cz + Math.sin(a) * 0.43, Math.abs(Math.cos(a)) > Math.abs(Math.sin(a)) ? (Math.cos(a) > 0 ? 'x+' : 'x-') : Math.sin(a) > 0 ? 'z+' : 'z-', [0.9, 1.5, 1.4], true, 0.5);
    }
    // Hangars across the runway: barrel roofs, big doors to the airfield, a fire station between.
    for (const hz of [-47.2, -44.0]) {
      const hx = 28.0;
      b.box(2.0, 0.7, 2.7, hx, y, hz, 0xdfe3e8);
      // A barrel roof spanning the door, its axis running back from the airfield.
      const vault = new THREE.CylinderGeometry(1.35, 1.35, 2.0, 18, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).scale(1, 0.4, 1);
      b.transformed(vault, new THREE.Matrix4().makeTranslation(hx, y + 0.7, hz), 0xaab4be, 'smooth');
      for (const end of [-1, 1]) {
        const cap = new THREE.CircleGeometry(1.35, 18, 0, Math.PI).rotateY(end > 0 ? Math.PI / 2 : -Math.PI / 2).scale(1, 0.4, 1);
        b.transformed(cap, new THREE.Matrix4().makeTranslation(hx + end * 1.0, y + 0.7, hz), 0xd0d6dc);
      }
      b.quad(2.3, 0.62, hx - 1.005, y + 0.32, hz, 'x-', 0x59616c, false);
      for (let k = 0; k < 6; k++) b.quad(0.02, 0.6, hx - 1.008, y + 0.32, hz - 1.1 + k * 0.44, 'x-', 0x8a929c, false);
      b.box(0.9, 0.012, 2.6, hx - 1.45, y, hz, concrete);
    }
    b.box(1.0, 0.36, 1.2, 28.1, y, -40.8, 0xc8402e);
    b.box(1.04, 0.04, 1.24, 28.1, y + 0.36, -40.8, 0xe8e2d6);
    for (let k = 0; k < 3; k++) b.quad(0.26, 0.24, 27.59, y + 0.14, -41.2 + k * 0.4, 'x-', 0xe8e2d6, false);
    // Landside: the road in from the city, the kerb, a parking garage full of cars.
    const land: Pt[] = [AIRPORT_ROAD.at(-1)!, [15.2, -37.0], [14.6, -38.4], [14.6, -47.8], [15.2, -48.8], [16.0, -49.0]];
    ribbon(b, land, 0.6, PALETTE.road, 0.02, 0, true);
    b.box(0.4, 0.06, tl - 0.4, tcx - tw / 2 - 0.25, y, tcz, 0xe8e2d6);
    for (let k = 0; k < 8; k++) b.box(0.012, 0.42, 0.012, tcx - tw / 2 - 0.4, y, tcz - tl / 2 + 0.8 + k * 1.3, 0x8a929c);
    b.box(0.5, 0.03, tl - 0.4, tcx - tw / 2 - 0.4, y + 0.42, tcz, 0xd4dbe2);
    const gx0 = 12.5;
    const gz0 = -46.4;
    for (let lvl = 0; lvl < 3; lvl++) {
      b.box(1.6, 0.04, 5.6, gx0 + 0.8, y + lvl * 0.22, gz0 + 2.8, 0xb8b2a6);
      for (let k = 0; k < 9; k++) if (r() < 0.8) b.box(0.18, 0.08, 0.32, gx0 + (k % 2 ? 0.45 : 1.15), y + lvl * 0.22 + 0.04, gz0 + 0.5 + Math.floor(k / 2) * 1.1 + (k % 2) * 0.5, pick(r, [0xc8402e, 0xf2efe8, 0x2a2f38, 0x3a6ab0, 0x9aa4ae] as const));
    }
    for (const [dx, dz] of [[0, 0], [1.6, 0], [0, 5.6], [1.6, 5.6]] as const) b.box(0.08, 0.66, 0.08, gx0 + dx, y, gz0 + dz, 0xa8a296);
    b.box(1.64, 0.03, 5.64, gx0 + 0.8, y + 0.66, gz0 + 2.8, 0xd8d2c4);
    // Floodlight masts on the aprons
    for (const [mx, mz] of [[18.0, -38.4], [18.0, -48.4], [22.4, -43.2], [20.0, -50.6]] as const) {
      b.cylinder(0.02, 0.03, 1.1, mx, y, mz, 0x8a929c, 5);
      b.box(0.16, 0.05, 0.08, mx, y + 1.1, mz, 0x3a3f4a);
      b.blob(0.04, mx, y + 1.08, mz, [2.6, 2.4, 1.9], true);
    }
    // The helipad: a concrete square, a yellow touchdown circle, the H, edge lights and a windsock.
    const hp = HELIPAD;
    b.box(1.5, 0.03, 1.5, hp.x, y, hp.z, 0xbdb8ac);
    b.transformed(new THREE.RingGeometry(0.52, 0.58, 28).rotateX(-Math.PI / 2), new THREE.Matrix4().makeTranslation(hp.x, y + 0.033, hp.z), yellow);
    helipadH(b, hp.x, y + 0.034, hp.z, 0.5, white);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      b.blob(0.026, hp.x + Math.cos(a) * 0.68, y + 0.06, hp.z + Math.sin(a) * 0.68, [1.2, 2.6, 1.0], true);
    }
    windsock(b, hp.x + 0.95, y, hp.z - 0.6);
    // Palms along the road in, and the verge
    for (let k = 0; k < 12; k++) palm(b, r, 13.9 + (k % 2) * 0.1, -36.6 - k * 1.0, 1.0, terrainHeight(13.9, -36.6 - k));
    const { group } = b.build();
    group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.receiveShadow = true;
        o.castShadow = true;
      }
    });
    group.userData.tip = { title: 'Airport', detail: 'Free infrastructure for every city. Planes are what you buy.' };
    this.pickables.push(group);
    return group;
  }

  /**
   * Your island: a low green plateau for the estate, a sandy cove on the west
   * with a jetty for the superyacht, a rocky north-west point with the
   * lighthouse, palms along the beaches and pines on the rocks; the launch
   * site waits under cloud at the far end.
   */
  private island(): THREE.Group {
    const r = rng(hash(this.seed, 'island'));
    const b = new Kit();
    const isl = ISLANDS.founder;
    const stone = 0xe2d9c6;
    // The island's own frame: offsets from its centre, mirrored east-west when its cove faces east.
    const f = WORLD_SPEC.estate.flip;
    const X = (dx: number) => isl.x + dx * f;
    const Z = (dz: number) => isl.z + dz;
    const local = (x: number) => (x - isl.x) * f;
    // Lighthouse on the rocky north point: a white tower, a gallery, the lantern, a keeper's cottage.
    const lx = X(-3.0);
    const lz = Z(2.9);
    const ly = terrainHeight(lx, lz);
    b.cylinder(0.3, 0.34, 0.08, lx, ly - 0.04, lz, 0xbdb4a2, 12);
    b.cylinder(0.15, 0.21, 1.3, lx, ly, lz, PALETTE.trim, 12);
    for (const band of [0.42, 0.86]) b.cylinder(0.2 - band * 0.05, 0.2 - band * 0.05, 0.1, lx, ly + band, lz, 0xc84a3a, 12);
    b.cylinder(0.21, 0.21, 0.05, lx, ly + 1.3, lz, 0x2a2f38, 12);
    b.cylinder(0.12, 0.12, 0.22, lx, ly + 1.35, lz, 0xbfe0ff, 12, 'glass');
    b.blob(0.11, lx, ly + 1.46, lz, [3, 2.6, 1.6], true);
    b.cylinder(0.02, 0.15, 0.16, lx, ly + 1.57, lz, 0xc84a3a, 12);
    this.beamCentre.set(lx, ly + 1.46, lz);
    const kx = X(-2.3);
    const kz = Z(2.3);
    const ky = terrainHeight(kx, kz);
    b.box(0.5, 0.22, 0.36, kx, ky - 0.03, kz, 0xf6f2ea, false, -0.6 * f);
    b.gable(0.5, 0.11, 0.36, kx, ky + 0.19, kz, 0xc84a3a, 0.03, -0.6 * f);
    // The jetty: a boardwalk out across the cove's beach to a quay alongside the superyacht.
    const qx = SUPERYACHT.x + 0.48 * f;
    const deck = SEA + 0.32;
    b.box(0.22, 0.05, 2.5, qx, deck, SUPERYACHT.z, PALETTE.wood);
    for (let k = 0; k < 6; k++) for (const sx of [-0.09, 0.09]) b.cylinder(0.025, 0.025, 0.42, qx + sx, SEA - 0.12, SUPERYACHT.z - 1.15 + k * 0.46, 0x6b5340, 5);
    for (const bz of [SUPERYACHT.z - 0.9, SUPERYACHT.z + 0.9]) b.cylinder(0.025, 0.03, 0.05, qx - 0.08 * f, deck + 0.05, bz, 0x2a2f38, 6);
    const walkTo = X(-2.9);
    b.box(Math.abs(walkTo - qx), 0.05, 0.2, (qx + walkTo) / 2, deck, ISLAND_COVE.z, PALETTE.wood);
    for (let d = 0.4; d < Math.abs(walkTo - qx); d += 0.45) for (const sz of [-0.08, 0.08]) b.cylinder(0.022, 0.022, 0.4, qx + d * f, SEA - 0.1, ISLAND_COVE.z + sz, 0x6b5340, 5);
    for (let d = 0.3; d < Math.abs(walkTo - qx); d += 0.6) {
      b.cylinder(0.006, 0.008, 0.2, qx + d * f, deck + 0.05, ISLAND_COVE.z + 0.11, 0x2a2f38, 4);
      b.blob(0.016, qx + d * f, deck + 0.26, ISLAND_COVE.z + 0.11, [2.4, 1.8, 1.0], true);
    }
    // The beach in the cove: a cabana, loungers and umbrellas, a kayak.
    const by = Math.max(SEA + 0.25, terrainHeight(X(-2.8), Z(-2.0)));
    b.box(0.36, 0.2, 0.3, X(-2.75), by, Z(-2.2), 0xf6f2ea);
    b.box(0.44, 0.03, 0.38, X(-2.75), by + 0.2, Z(-2.2), 0xc9a77a);
    for (let k = 0; k < 3; k++) {
      const ux = X(-3.3 + k * 0.32);
      const uz = Z(-0.2 + k * 0.12);
      const uy = Math.max(SEA + 0.22, terrainHeight(ux, uz));
      b.cylinder(0.004, 0.004, 0.16, ux, uy, uz, 0xdddddd, 4);
      b.cylinder(0, 0.1, 0.035, ux, uy + 0.15, uz, pick(r, [0xf2efe8, 0x2a6db8, 0xe8c25a] as const), 8);
      b.box(0.05, 0.014, 0.12, ux + 0.08 * f, uy, uz - 0.08, 0xf6f2ea);
    }
    b.rbox(0.32, 0.04, 0.07, X(-3.1), SEA + 0.24, Z(-1.75), 0xe85a2a, 0.02, 'smooth', 0.4 * f);
    // Paths from the estate: down to the jetty and up to the lighthouse.
    for (const path of [[[X(-1.8), Z(-0.4)], [X(-2.4), Z(-0.8)], [walkTo, ISLAND_COVE.z]], [[X(-1.2), Z(1.5)], [X(-1.8), Z(2.2)], [kx, kz - 0.25]]] as Pt[][]) {
      ribbon(b, path, 0.16, stone, 0.03);
    }
    // Planting: palms on the beaches, pines and cypress on the rocks, a hedge of oleander round the estate.
    const clearOf = (x: number, z: number) =>
      Math.hypot(x - isl.x, z - isl.z) > 2.15 && Math.hypot(x - lx, z - lz) > 0.45 && Math.hypot(x - kx, z - kz) > 0.45 && Math.hypot(x - ISLANDS.launch.x, z - ISLANDS.launch.z) > ISLANDS.launch.r + 0.3;
    for (let i = 0; i < 260; i++) {
      const a = r() * Math.PI * 2;
      const d = 1.8 + r() * 3.4;
      const x = isl.x + Math.cos(a) * d;
      const z = isl.z + Math.sin(a) * d;
      if (coastDistance(x, z) > -0.15 || !clearOf(x, z)) continue;
      if (Math.abs(z - ISLAND_COVE.z) < 0.3 && local(x) < -2.4) continue;
      const y = terrainHeight(x, z);
      const beach = isBeach(x, z);
      const north = z > isl.z + 1.4 || local(x) < -2.6;
      if (beach) {
        if (r() < 0.3) palm(b, r, x, z, 0.95, y - 0.02);
      } else if (north && r() < 0.35) {
        if (r() < 0.6) pine(b, r, x, y, z, 0.95);
        else rock(b, r, x, y, z, 1.4);
      } else if (r() < 0.16) {
        if (r() < 0.5) palm(b, r, x, z, 1.0, y - 0.02);
        else oak(b, r, x, y, z, 0.8);
      } else if (r() < 0.08) scrub(b, r, x, y, z, 1);
    }
    // Launch site (revealed at $1M MRR): the pad and flame trench, the service tower, tanks, the bunker.
    const L = ISLANDS.launch;
    const pad = new Kit();
    const py = terrainHeight(L.x, L.z);
    pad.cylinder(1.45, 1.55, 0.12, L.x, py - 0.05, L.z, 0xcfcac0, 28);
    pad.cylinder(0.55, 0.55, 0.02, L.x, py + 0.07, L.z, 0x2a2a30, 20);
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      pad.box(0.08, 0.004, 0.3, L.x + Math.cos(a) * 1.05, py + 0.072, L.z + Math.sin(a) * 1.05, 0xf2c84b, false, -a + Math.PI / 2);
    }
    pad.box(0.5, 0.06, 1.6, L.x - 0.2, py + 0.02, L.z + 1.5, 0x8a857a);
    // The tower: a steel lattice (four legs, a ring every level, cross-bracing), the swing arm, a beacon.
    const twx = L.x + 0.95;
    const twz = L.z - 0.5;
    const steel = 0x4a4f58;
    for (const [dx, dz] of [[-0.15, -0.15], [0.15, -0.15], [-0.15, 0.15], [0.15, 0.15]] as const) pad.box(0.035, 3.45, 0.035, twx + dx, py + 0.07, twz + dz, steel);
    for (let k = 0; k < 8; k++) {
      const ky = py + 0.07 + k * 0.45;
      for (const [w, d, dx, dz] of [[0.32, 0.02, 0, -0.15], [0.32, 0.02, 0, 0.15], [0.02, 0.32, -0.15, 0], [0.02, 0.32, 0.15, 0]] as const) pad.box(w, 0.025, d, twx + dx, ky, twz + dz, steel);
      if (k < 7) {
        for (const [dx, dz, rot] of [[0, -0.15, 0], [0, 0.15, 0], [-0.15, 0, Math.PI / 2], [0.15, 0, Math.PI / 2]] as const) {
          const g = new THREE.BoxGeometry(0.42, 0.016, 0.016).rotateZ(k % 2 ? 0.95 : -0.95).rotateY(rot);
          pad.transformed(g, new THREE.Matrix4().makeTranslation(twx + dx, ky + 0.225, twz + dz), steel);
        }
      }
    }
    pad.box(0.36, 0.08, 0.36, twx, py + 3.52, twz, 0x2a2f38);
    pad.box(0.64, 0.06, 0.08, L.x + 0.62, py + 2.8, L.z - 0.36, 0xd8d2c4, false, -0.45);
    pad.box(0.5, 0.04, 0.08, L.x + 0.66, py + 1.9, L.z - 0.38, 0xd8d2c4, false, -0.45);
    pad.blob(0.06, twx, py + 3.66, twz, [3, 0.3, 0.2], true);
    // Lightning masts, propellant spheres, a water tower for the deluge, the blockhouse
    for (const [mx, mz] of [[L.x - 1.3, L.z - 0.9], [L.x + 1.3, L.z + 0.9], [L.x - 1.1, L.z + 1.2]] as const) {
      pad.cylinder(0.02, 0.035, 2.6, mx, terrainHeight(mx, mz), mz, 0xe8e2d6, 5);
      pad.blob(0.04, mx, terrainHeight(mx, mz) + 2.62, mz, [3, 0.3, 0.2], true);
    }
    for (const [tx, tz] of [[L.x + 1.9, L.z - 1.3], [L.x + 2.2, L.z - 0.6]] as const) {
      const ty = terrainHeight(tx, tz);
      pad.blob(0.26, tx, ty + 0.34, tz, 0xf2efe8, 'smooth', 1);
      for (const [dx, dz] of [[-0.16, -0.16], [0.16, -0.16], [-0.16, 0.16], [0.16, 0.16]] as const) pad.box(0.03, 0.2, 0.03, tx + dx, ty, tz + dz, 0x8a929c);
    }
    const wx = L.x - 1.8;
    const wz = L.z - 0.4;
    const wy = terrainHeight(wx, wz);
    pad.cylinder(0.2, 0.2, 0.3, wx, wy + 0.7, wz, 0xe8e2d6, 12);
    for (const [dx, dz] of [[-0.12, -0.12], [0.12, -0.12], [-0.12, 0.12], [0.12, 0.12]] as const) pad.box(0.025, 0.7, 0.025, wx + dx, wy, wz + dz, 0x8a929c);
    pad.box(0.6, 0.18, 0.4, L.x - 0.6, terrainHeight(L.x - 0.6, L.z - 1.9) - 0.02, L.z - 1.9, 0xb8b2a6);
    pad.box(0.62, 0.04, 0.42, L.x - 0.6, terrainHeight(L.x - 0.6, L.z - 1.9) + 0.16, L.z - 1.9, 0x8a857a);
    for (let k = 0; k < 3; k++) wall(winOf(pad), 'glow', L.x - 0.75 + k * 0.15, terrainHeight(L.x - 0.6, L.z - 1.9) + 0.1, L.z - 1.69, 0, 1, 0.08, 0.04, PALETTE.windowCool, 0.5);
    const { group: launch } = pad.build();
    launch.userData.tip = { title: 'Launch site', detail: 'Buy a rocket to fly to your house on the moon.' };
    this.launchKey = this.fix(launch);
    this.batch.setVisible(this.launchKey, false);
    const { group } = b.build();
    group.userData.tip = { title: 'Your island', detail: 'Clears at $100k MRR: an estate and a superyacht.' };
    return group;
  }

  // ─── Suburbs, Sausalito, Oakland, Treasure Island ───────────────────────

  private suburbs(): THREE.Group {
    const b = new GeoBuilder();
    const r = rng(hash(this.seed, 'suburbs'));
    const chunks = new Chunks();
    this.towns(chunks, r);
    // Downtown Oakland across the bay: real towers (the same families as ours), each on the ground.
    const spots: [number, number, number][] = [[59, -9, 6], [61.2, -8.6, 4], [59.4, -6.6, 4], [61.6, -6.2, 6], [63.6, -7.8, 4], [60, -4, 4], [62.4, -3.6, 4]];
    for (const [x, z, tier] of spots) {
      const k = new Kit();
      tower(k, r, 0, 0, tier, [2.4, 1.8, 1.0]);
      const { group } = k.build();
      group.position.set(x, Math.max(0, terrainHeight(x, z)) - 0.03, z);
      group.userData.tip = { title: 'Downtown Oakland', detail: 'Across the bay. Someday, a district of your own over there.' };
      this.fix(group);
    }
    this.wildBackdrop(chunks, r);
    for (const g of chunks.all()) this.fix(this.add(g));
    // Treasure Island and Yerba Buena
    this.treasureIsland(b, r);
    this.yerbaBuena(b, r);
    return this.add(b);
  }

  /**
   * The towns around the bay (planned in `backdropTowns`): streets graded into
   * the hills, a house on every lot facing its street, at the city's scale,
   * and street trees on the verges.
   */
  private towns(chunks: Chunks, r: () => number) {
    const palettes = {
      stucco: { walls: [0xf3e6cf, 0xf1d4b8, 0xd8e4ec, 0xd4e6d6, 0xf2e2a8, 0xecd0d8, 0xf6f2ea, 0xe8d8c4], roofs: [0xc4704a, 0xb85e44, 0x9a5a48, 0x7a7068, 0x8a8478, 0xa86a50] },
      shingle: { walls: [0xf6f2ea, 0xe8dcc8, 0xd8e2e6, 0xe9d4c0, 0xc8d4c0, 0xb9a48a], roofs: [0x5a6068, 0x7a5a48, 0x8a7a6a, 0x4a5058] },
    } as const;
    for (const town of backdropTowns()) {
      const { walls, roofs } = palettes[town.style];
      for (const line of town.streets) strip(chunks.at(line[0]![0], line[0]![1]), line, TOWN_STREET, PALETTE.road, 0.03);
      for (const l of town.lots) {
        const g = chunks.at(l.x, l.z);
        if (l.empty) oak(g, r, l.x, l.y, l.z, 0.85);
        else townHouse(g, r, l.x, l.y, l.z, l.rot, walls, roofs);
      }
      for (const [x, z, y] of town.trees) {
        const g = chunks.at(x, z);
        if (town.style === 'shingle' && r() < 0.4) pine(g, r, x, y, z, 0.6);
        else oak(g, r, x, y, z, 0.55);
      }
    }
  }

  /**
   * The open country around the towns: golden grass and coyote brush on the
   * Marin Headlands and San Bruno Mountain, oak in the ravines, eucalyptus and
   * pine forest over the Oakland hills and Angel Island, rock on the crests.
   */
  private wildBackdrop(chunks: Chunks, r: () => number) {
    const step = 1.0;
    const classic = WORLD_SPEC.classic;
    const F = ISLANDS.founder;
    // Twin Peaks' own builder covers the hills behind the city, wherever this world put them.
    const hz0 = Math.min(-50, WORLD_SPEC.peaks.centre.z - 14);
    for (let gx = -80; gx < 86; gx += step) {
      for (let gz = -92; gz < 66; gz += step) {
        // The city, Twin Peaks (done in detail) and the islands are left to their own builders.
        if (gx > -36 && gx < 12 && gz > hz0 && gz < 14) continue;
        if (classic ? gx > 4 && gx < 42 && gz > -14 && gz < 48 : (gx > 28 && gx < 41 && gz > -12 && gz < 4) || Math.hypot(gx - F.x, gz - F.z) < F.r + 2.5) continue;
        if (gx > 12 && gx < 31 && gz > -56 && gz < -31) continue;
        const x = gx + (r() - 0.5) * step;
        const z = gz + (r() - 0.5) * step;
        const y = terrainHeight(x, z);
        if (y < 0.4 || coastDistance(x, z) > -0.8 || gradeWeight(x, z) > 0) continue;
        if (hidesCliffHouse(x, z)) continue;
        const e = 0.4;
        const ex = terrainHeight(x + e, z) + terrainHeight(x - e, z);
        const ez = terrainHeight(x, z + e) + terrainHeight(x, z - e);
        const slope = Math.hypot(terrainHeight(x + e, z) - terrainHeight(x - e, z), terrainHeight(x, z + e) - terrainHeight(x, z - e)) / (2 * e);
        // Positive in the folds of the hills, negative on the crests.
        const curve = ex + ez - 4 * y;
        const grove = 0.5 + 0.5 * fbm(x * 0.09 + 13, z * 0.09 + 5, 3);
        const patch = 0.5 + 0.5 * fbm(x * 0.25 - 31, z * 0.25 + 9, 2);
        const g = chunks.at(x, z);
        const eastHills = x > 60;
        const angel = Math.hypot(x - ISLANDS.angel.x, z - ISLANDS.angel.z) < ISLANDS.angel.r + 1;
        // Woods: oak down the ravines, groves of pine, eucalyptus over the Oakland hills and Angel Island.
        const wood = eastHills ? smoothstep(4.5, 7.5, y) * 0.8 + (grove - 0.55) * 1.5 : angel ? 0.55 + (grove - 0.5) * 1.5 : (grove - 0.62) * 3 + Math.max(0, curve - 0.05) * 2.5;
        if (wood > 0 && r() < Math.min(0.7, wood * 0.8)) {
          if (eastHills) (r() < 0.6 ? gum : pine)(g, r, x, y, z, 1.25);
          else if (angel) (r() < 0.55 ? oak : pine)(g, r, x, y, z, 1.15);
          else (curve > 0.04 || r() < 0.5 ? oak : pine)(g, r, x, y, z, 1.2);
          continue;
        }
        // Rock outcrops on the steepest crests only, in little groups.
        if (slope > 1.25 && curve < -0.05 && r() < 0.18) {
          const k = 1.5 + r();
          rock(g, r, x, y, z, k);
          if (r() < 0.6) rock(g, r, x + (r() - 0.5) * 0.35, y, z + (r() - 0.5) * 0.35, k * 0.6);
          continue;
        }
        // Coyote brush in patches, open grass between.
        if (patch > 0.66 && r() < 0.2) scrub(g, r, x, y, z, 1.8);
        else if (r() < 0.006) oak(g, r, x, y, z, 1.1);
      }
    }
  }

  // ─── TinyTown Hills ─────────────────────────────────────────────────────

  /**
   * TinyTown Hills: Twin Peaks Boulevard up from the end of Market, avenues
   * along the contours, hairpins and turning circles, and a house on a
   * terrace on every lot (see `hillsPlan`). Everything here clears with the
   * cloud at $1k MRR; the wild slopes around it are always there.
   */
  private buildHood() {
    const r = rng(hash(this.seed, 'hood'));
    const plan = hillsPlan();
    const b = new GeoBuilder();
    hillsStreets(b, r, plan, naturalHeight);
    hillsLots(b, r, plan, naturalHeight);
    // Your lot's driveway carries on level across the pad to the front of the house.
    const [edge] = plan.homeDrive;
    if (edge) {
      const ux = (edge[0] - HILLS_HOME.x) / 1.85;
      const uz = (edge[1] - HILLS_HOME.z) / 1.85;
      strip(b, [[HILLS_HOME.x + ux * 0.6, HILLS_HOME.z + uz * 0.6, edge[2]], [edge[0] + ux * 0.05, edge[1] + uz * 0.05, edge[2]]], 0.26, 0xd6cfc0, 0.035);
    }
    const group = this.add(b);
    group.userData.tip = { title: 'TinyTown Hills', detail: 'Opens at $1k MRR, when you move into your first Hills house.' };
    this.hillKeys.push(this.fix(group));
    this.placeHillHouses();
    this.wildHills();
  }

  /** A house on every terrace: a mix of the four Hills styles, batched, shown once the Hills open. */
  private placeHillHouses() {
    const styles: HillsStyle[] = ['midcentury', 'spanish', 'modern', 'canyon'];
    const names: Record<HillsStyle, string> = { midcentury: 'A mid-century house', spanish: 'A Spanish Revival house', modern: 'A modern house', canyon: 'A canyon house' };
    let last: HillsStyle | null = null;
    hillsPlan().lots.forEach((lot, i) => {
      // Neighbours differ: never the same style twice in a row along a street.
      let style = styles[hash(this.seed, 'hills-style', i) % styles.length]!;
      if (style === last) style = styles[(styles.indexOf(style) + 1 + (i % 3)) % styles.length]!;
      last = style;
      const { group } = hillsHouse(style, hash(this.seed, 'hills-house', i));
      group.position.set(lot.x, lot.y, lot.z);
      group.rotation.y = lot.rot;
      group.userData.tip = { title: names[style], detail: 'TinyTown Hills: your neighbours made it too' };
      this.hillKeys.push(this.fix(group));
    });
    for (const key of this.hillKeys) this.batch.setVisible(key, this.state.hills);
  }

  /**
   * Twin Peaks and its foothills: golden grass with sage scrub, pines and oaks
   * in clusters, eucalyptus on Mount Sutro, grey rock on the crowns and the
   * steepest faces, and only low scrub and rocks on the sign's slope.
   */
  private wildHills() {
    const r = rng(hash(this.seed, 'wild'));
    const chunks = new Map<string, GeoBuilder>();
    const at = (x: number, z: number) => {
      const key = `${Math.floor(x / 12)},${Math.floor(z / 12)}`;
      let g = chunks.get(key);
      if (!g) chunks.set(key, (g = new GeoBuilder()));
      return g;
    };
    const summits = TWIN_PEAKS_SUMMITS;
    const step = 0.42;
    // The classic hills' extent, moved with this world's peaks.
    const ox = WORLD_SPEC.peaks.centre.x + 14;
    const oz = WORLD_SPEC.peaks.centre.z + 36;
    const sutroAt = WORLD_SPEC.peaks.sutro ? { x: WORLD_SPEC.peaks.sutro[0], z: WORLD_SPEC.peaks.sutro[1] } : null;
    for (let gx = -33 + Math.min(0, ox); gx < 10 + Math.max(0, ox); gx += step) {
      for (let gz = -49 + Math.min(0, oz); gz < -21; gz += step) {
        const x = gx + (r() - 0.5) * step * 0.9;
        const z = gz + (r() - 0.5) * step * 0.9;
        const y = terrainHeight(x, z);
        if (y < 0.12 || coastDistance(x, z) > -0.6) continue;
        if (gradeWeight(x, z) > 0) continue;
        if (Math.hypot(x - HILLS_HOME.x, z - HILLS_HOME.z) < 2.8) continue;
        if (HAS.sutro && Math.hypot(x - LANDMARKS.sutroTower.x, z - LANDMARKS.sutroTower.z) < 1.3) continue;
        const e = 0.3;
        const slope = Math.hypot(terrainHeight(x + e, z) - terrainHeight(x - e, z), terrainHeight(x, z + e) - terrainHeight(x, z - e)) / (2 * e);
        const sign = inSignZone(x, z, 0.6);
        const g = at(x, z);
        let summit = Infinity;
        for (const p of summits) summit = Math.min(summit, Math.hypot(x - p.x, z - p.z));
        // Rock: the crowns of the peaks, the steepest faces, scattered on the sign's slope.
        const rocky = Math.max(0, 1 - summit / 3) * 0.45 + Math.max(0, slope - 1.2) * 0.3 + (sign ? 0.04 : 0.015);
        if (r() < rocky) {
          // Outcrops: a big stone with a smaller one or two leaning on it.
          const k = 0.7 + r() * 0.6 + (summit < 1.6 ? 0.4 : 0);
          rock(g, r, x, y, z, k);
          if (r() < 0.6) rock(g, r, x + (r() - 0.5) * 0.2, y - 0.02, z + (r() - 0.5) * 0.2, k * 0.55);
          continue;
        }
        if (sign) {
          // Keep the letters clear: only low scrub on their slope, none right in front.
          const { x: sx, z: sz } = LANDMARKS.sign;
          const v = (x - sx + (z - sz)) * Math.SQRT1_2;
          if (v > -0.7 && v < 1.4) continue;
          if (r() < 0.3) scrub(g, r, x, y, z, 0.9);
          continue;
        }
        // Forest where the noise says so, densest on Mount Sutro; oaks in the ravines.
        const sutro = sutroAt ? Math.max(0, 1 - Math.hypot(x - sutroAt.x, z - sutroAt.z) / 6.5) : 0;
        const grove = 0.5 + 0.5 * fbm(x * 0.21 + 40, z * 0.21 - 7, 3);
        const forest = Math.max(sutro * 1.4, (grove - 0.56) * 2.6) * (summit < 2.5 ? 0.2 : 1);
        if (r() < forest * 0.55) {
          if (sutro > 0.15 && r() < 0.8) gum(g, r, x, y, z, 1.0);
          else if (r() < 0.55) pine(g, r, x, y, z, 1.0);
          else oak(g, r, x, y, z, 1.0);
          continue;
        }
        if (r() < 0.02) {
          oak(g, r, x, y, z, 0.9);
          continue;
        }
        // Sage in patches, open golden grass between.
        const patch = 0.5 + 0.5 * fbm(x * 0.5 - 31, z * 0.5 + 9, 2);
        if (patch > 0.58 && r() < 0.4) scrub(g, r, x, y, z, 1);
      }
    }
    for (const g of chunks.values()) this.fix(this.add(g));
  }

  /**
   * Yerba Buena: a steep, wooded ridge with rocky cliffs at both ends of the
   * Bay Bridge tunnel, a lane up to the old officers' houses on the crest, the
   * Coast Guard station and its light on the south-east point, and the
   * causeway across to Treasure Island.
   */
  private yerbaBuena(b: GeoBuilder, r: () => number) {
    const yb = ISLANDS.yerba;
    const deck = (x: number, z: number) => Math.abs(z - LANDMARKS.bayBridge.z) < 1.15 && terrainHeight(x, z) < 3.7;
    // The lane: up from the causeway, round the north slope to the crest.
    const lane: Pt[] = [[34.1, -3.6], [34.3, -4.5], [35.3, -5.1], [35.6, -5.6], [34.6, -5.5], [33.4, -5.2], [32.2, -5.1], [31.4, -5.4]];
    const lanePts = lane.map(([x, z]) => [x, z, terrainHeight(x, z)] as const);
    ribbon(b, lane, 0.2, PALETTE.road, 0.03);
    // The officers' quarters on the crest: white clapboard, grey roofs, a flagpole.
    for (const [hx, hz, rot] of [[32.4, -5.6, 0.1], [33.5, -5.75, -0.05], [31.6, -5.95, 0.3]] as const) {
      const y = terrainHeight(hx, hz);
      b.box(0.5, 0.06, 0.4, hx, y - 0.05, hz, 0xc9bfa8, false, rot);
      b.box(0.42, 0.24, 0.32, hx, y, hz, 0xf4f1ea, false, rot);
      b.gable(0.42, 0.11, 0.32, hx, y + 0.24, hz, 0x6a7078, 0.03, rot);
      b.panel(0.3, 0.06, hx + Math.sin(rot) * 0.165, y + 0.14, hz + Math.cos(rot) * 0.165, rot, PALETTE.windowWarm, true, 0.3);
    }
    void lanePts;
    const fy = terrainHeight(32.9, -5.3);
    b.cylinder(0.006, 0.008, 0.5, 32.9, fy, -5.3, 0xe8e8e8, 4);
    b.box(0.1, 0.06, 0.004, 32.95, fy + 0.42, -5.3, 0x2a4a8a);
    // Coast Guard station: a white light on the point, a boathouse and a pier.
    const cx = 36.55;
    const cz = -8.55;
    const cy = terrainHeight(cx, cz);
    b.cylinder(0.09, 0.11, 0.5, cx, cy, cz, 0xf6f4ee, 8);
    b.cylinder(0.11, 0.11, 0.03, cx, cy + 0.5, cz, 0x2a2f38, 8);
    b.cylinder(0.07, 0.07, 0.1, cx, cy + 0.53, cz, 0xbfe0ff, 8, 'glass');
    b.blob(0.05, cx, cy + 0.58, cz, [3, 2.6, 1.6], true);
    b.cylinder(0.0, 0.09, 0.08, cx, cy + 0.63, cz, 0xc8402e, 8);
    const bx = 35.6;
    const bz = -9.2;
    const by = Math.max(SEA + 0.35, terrainHeight(bx, bz));
    b.box(0.7, 0.26, 0.4, bx, by, bz, 0xf6f4ee);
    b.gable(0.7, 0.12, 0.4, bx, by + 0.26, bz, 0xc8402e, 0.03);
    b.box(0.12, 0.03, 1.2, 35.9, SEA + 0.25, -10.0, PALETTE.wood);
    moored(b, r, 36.15, -10.1);
    // The causeway to Treasure Island: a road on a rock embankment.
    b.box(0.9, 0.5, 1.6, 34.1, SEA - 0.2, -3.45, 0x8f877a);
    ribbon(b, [[34.1, -4.3], [34.1, -2.6]], 0.3, PALETTE.road, 0.32);
    // Woods: Monterey pine, eucalyptus and oak over the ridge; rock on the cliffs; nothing near the bridge deck.
    for (let i = 0; i < 1500; i++) {
      const x = yb.x - 4 + r() * 8.5;
      const z = yb.z - 3.5 + r() * 7;
      if (coastDistance(x, z) > -0.25) continue;
      const y = terrainHeight(x, z);
      const e = 0.25;
      const slope = Math.hypot(terrainHeight(x + e, z) - terrainHeight(x - e, z), terrainHeight(x, z + e) - terrainHeight(x, z - e)) / (2 * e);
      if (lane.some(([lx, lz]) => Math.hypot(lx - x, lz - z) < 0.35)) continue;
      if (Math.hypot(x - 32.5, z + 5.7) < 1.4 || Math.hypot(x - cx, z - cz) < 0.5 || Math.hypot(x - bx, z - bz) < 0.6) continue;
      if (slope > 2.8 || y < 0.25) {
        if (r() < 0.35) rock(b, r, x, y, z, 1.2 + r() * 0.8);
        continue;
      }
      if (deck(x, z)) {
        if (r() < 0.3) scrub(b, r, x, y, z, 1);
        continue;
      }
      const k = r();
      if (k < 0.32) pine(b, r, x, y, z, 1.05);
      else if (k < 0.5) gum(b, r, x, y, z, 1.0);
      else if (k < 0.66) oak(b, r, x, y, z, 1.0);
      else if (k < 0.8) scrub(b, r, x, y, z, 1.1);
    }
  }

  /**
   * Treasure Island: 1930s landfill behind a seawall. The Avenue of the Palms
   * along the west shore facing the city, Building One (the Art Deco
   * terminal of the 1939 fair) with the three seaplane hangars beside it on
   * Clipper Cove, a street grid of navy-era houses to the north, the ball
   * field, and boats in the cove.
   */
  private treasureIsland(b: GeoBuilder, r: () => number) {
    const y = 0.28;
    const road = (pts: Pt[], w = 0.3) => ribbon(b, pts, w, PALETTE.road, 0.03);
    // Seawall: riprap all round, a concrete coping on top.
    seawall(b, r, TREASURE_COAST);
    // Streets: the Avenue of the Palms, a ring road, and a little grid.
    const ax = 32.95;
    road([[ax, -2.35], [ax, 2.45]], 0.34);
    road([[ax, 2.45], [38.95, 2.45], [38.95, -2.35], [ax, -2.35]]);
    for (const z of [-0.45, 1.0]) road([[ax, z], [38.95, z]]);
    for (const x of [35.0, 37.0]) road([[x, -0.45], [x, 2.45]]);
    road([[34.1, -2.8], [34.1, -2.35]], 0.3);
    for (let k = 0; k < 9; k++) {
      const pz = -2.1 + k * 0.56;
      palm(b, r, ax - 0.3, pz, 0.95, y - 0.02);
      if (k % 2 === 0) {
        b.cylinder(0.006, 0.009, 0.26, ax + 0.22, y, pz + 0.28, 0x3a4048, 5);
        b.blob(0.018, ax + 0.22, y + 0.27, pz + 0.28, LAMP, true);
      }
    }
    // Building One: a long cream block facing the city, a stepped central tower, gold trim, wings either side.
    const cream = 0xeee5d0;
    const gold = 0xc9a24a;
    const bx = 33.75;
    const bz = -1.4;
    b.box(0.62, 0.36, 1.6, bx, y, bz, cream);
    b.box(0.66, 0.03, 1.64, bx, y + 0.36, bz, gold);
    for (const [w, h, yy] of [[0.46, 0.24, 0.36], [0.34, 0.18, 0.6], [0.22, 0.13, 0.78]] as const) {
      b.box(w, h, w, bx, y + yy, bz, cream);
      b.box(w + 0.02, 0.016, w + 0.02, bx, y + yy + h, bz, gold);
    }
    b.cylinder(0.008, 0.012, 0.16, bx, y + 0.91, bz, gold, 6);
    b.windows({ w: 0.62, d: 1.6, x: bx, z: bz, y0: y, rows: 2, rowHeight: 0.16, cols: 10, faces: ['x-', 'x+', 'z+', 'z-'] }, r, 0.6, [1.6, 1.15, 0.6], { w: 0.07, h: 0.09 });
    for (const sgn of [-1, 1]) b.box(0.42, 0.26, 0.42, bx + 0.42, y, bz + sgn * 0.62, cream);
    b.box(0.5, 0.012, 0.7, bx - 0.55, y, bz, 0xd8d2c4);
    // Three seaplane hangars on Clipper Cove: barrel roofs, doors to the water.
    for (let k = 0; k < 3; k++) {
      const hx = 35.4 + k * 1.2;
      const hz = -1.45;
      b.box(0.95, 0.3, 1.2, hx, y, hz, 0xd9d4c8);
      const vault = new THREE.CylinderGeometry(0.475, 0.475, 1.2, 14, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).rotateY(Math.PI / 2).scale(1, 0.5, 1);
      b.transformed(vault, new THREE.Matrix4().makeTranslation(hx, y + 0.3, hz), 0x9aa5a0, 'smooth');
      b.quad(0.7, 0.26, hx, y + 0.13, hz - 0.601, 'z-', 0x5a646a, false);
      b.quad(0.04, 0.06, hx, y + 0.34, hz - 0.602, 'z-', [1.6, 1.3, 0.8], true, 0.3);
    }
    // Houses: navy-era duplexes along the grid, a lot apiece like the city's, street trees between.
    const walls = [0xf3e9d8, 0xe9dcc4, 0xd8e2e6, 0xf0d9c0, 0xe2e8d8] as const;
    const roofs = [0x8a8478, 0x9a5a48, 0x6a7078, 0xb06a4a] as const;
    for (const [x0, x1] of [[35.5, 36.6], [37.5, 38.6]] as const) {
      for (let x = x0; x <= x1 + 0.01; x += 1.0) {
        // Both sides of the street at z = 1: fronts to the street.
        for (const [z, rot] of [[0.42, 0], [1.58, Math.PI]] as const) townHouse(b, r, x, y, z, rot, walls, roofs);
        if (r() < 0.7) oak(b, r, x + 0.5, y, 1.0 + (r() < 0.5 ? 0.32 : -0.32), 0.55);
      }
    }
    // The ball field and a lawn by Building One, a grove at the north-west corner
    const fx = 34.1;
    const fz = 1.0;
    b.box(1.5, 0.012, 1.7, fx, y, fz, 0x7fbf55);
    b.box(0.5, 0.006, 0.5, fx - 0.3, y + 0.012, fz - 0.4, 0xc9a77a, false, Math.PI / 4);
    for (const sgn of [-1, 1]) b.box(0.012, 0.18, 0.012, fx + sgn * 0.7, y, fz + 0.8, 0xe8e8e8);
    for (let k = 0; k < 7; k++) (k % 2 ? pine : oak)(b, r, 33.4 + (k % 3) * 0.4, y, 2.0 - Math.floor(k / 3) * 0.35, 0.8);
    // Clipper Cove: a marina on the south shore, between Treasure Island and Yerba Buena.
    for (let k = 0; k < 3; k++) {
      const dx = 35.4 + k * 1.2;
      b.box(0.1, 0.04, 0.9, dx, SEA + 0.1, -3.3, PALETTE.wood);
      for (let j = 0; j < 2; j++) moored(b, r, dx + 0.32, -3.05 - j * 0.42);
    }
    b.box(3.0, 0.04, 0.12, 36.6, SEA + 0.1, -2.95, PALETTE.wood);
  }

  private buildClouds() {
    const bank = (target: THREE.Group, x: number, z: number, w: number, d: number, y: number, key: string, tip: string) => {
      const { group } = cloudBank(x, z, w, d, hash(this.seed, key), y);
      group.userData.tip = { title: 'Under cloud', detail: tip };
      this.pickables.push(group);
      target.add(group);
    };
    // The Hills: a bank over each cluster of lots (the streets and lots are hidden until they clear).
    const cells = new Map<string, number>();
    const plan = hillsPlan();
    const cell = (x: number, z: number) => `${Math.floor((x + 2) / 6.5)},${Math.floor((z + 1) / 6)}`;
    for (const l of plan.lots) cells.set(cell(l.x, l.z), (cells.get(cell(l.x, l.z)) ?? 0) + 1);
    for (const [key, n] of cells) {
      if (n < 3) continue;
      const [i, j] = key.split(',').map(Number) as [number, number];
      const x = i * 6.5 - 2 + 3.25;
      const z = j * 6 - 1 + 3;
      bank(this.clouds.hills, x, z, 6.2, 5.2, Math.max(0.6, terrainHeight(x, z)) + 1.1, `hills-${key}`, 'TinyTown Hills clear at $1k MRR');
    }
    bank(this.clouds.island, ISLANDS.founder.x - 0.3, ISLANDS.founder.z - 0.2, 10.6, 10.4, 1.5, 'island', 'Your island clears at $100k MRR');
    // Offset away from the estate, so the cloud never sits on the house or its helipad.
    bank(this.clouds.launch, ISLANDS.launch.x + 0.35, ISLANDS.launch.z - 0.35, 6.0, 6.0, 1.1, 'launch', 'The launch site clears at $1M MRR');
  }

  /** Reflect the game: what's open, what's built, what's falling apart. */
  setState(next: SceneryState) {
    this.state = next;
    for (const key of this.hillKeys) this.batch.setVisible(key, next.hills);
    this.clouds.hills.visible = !next.hills;
    this.clouds.island.visible = !next.island;
    this.clouds.launch.visible = !next.launch;
    if (this.launchKey) this.batch.setVisible(this.launchKey, next.launch);
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
    if (this.mill) this.mill.sails.rotation.z -= dt * 0.6;
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
  if (tall) {
    gum(b, r, x, y, z, 1.25);
    return;
  }
  // Wind-sculpted Monterey cypress: flat, wide, leaning (low-poly, ~50 triangles)
  const s = 0.8 + r() * 0.4;
  b.cylinder(0.035 * s, 0.05 * s, 0.35 * s, x, y, z, PALETTE.trunk, 5);
  const g = new THREE.IcosahedronGeometry(0.32 * s, 0).scale(1.4, 0.55, 1.1);
  b.transformed(g, new THREE.Matrix4().makeTranslation(x + 0.06 * s, y + 0.45 * s, z), pick(r, [0x2f6a45, 0x3a7a4c, 0x2a5e3e] as const), 'smooth');
  const g2 = new THREE.IcosahedronGeometry(0.22 * s, 0).scale(1.3, 0.5, 1.1);
  b.transformed(g2, new THREE.Matrix4().makeTranslation(x - 0.12 * s, y + 0.6 * s, z + 0.05 * s), pick(r, [0x2f6a45, 0x3a7a4c] as const), 'smooth');
}

function moored(b: GeoBuilder, r: () => number, x: number, z: number) {
  const y = SEA;
  b.rbox(0.62, 0.11, 0.22, x, y, z, PALETTE.trim, 0.05, 'smooth', Math.PI / 2);
  b.box(0.18, 0.08, 0.26, x, y + 0.1, z - 0.04, pick(r, [0x3aa3c8, 0xe85a4a, 0xf8f5ee, 0x1c2a3a] as const));
  b.cylinder(0.008, 0.01, 0.75, x, y + 0.1, z + 0.05, PALETTE.trim, 4);
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

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Static scenery in square chunks, so the batch can cull what's off screen. */
class Chunks {
  private map = new Map<string, GeoBuilder>();
  private size: number;
  constructor(size = 12) {
    this.size = size;
  }
  at(x: number, z: number): GeoBuilder {
    const key = `${Math.floor(x / this.size)},${Math.floor(z / this.size)}`;
    let g = this.map.get(key);
    if (!g) this.map.set(key, (g = new GeoBuilder()));
    return g;
  }
  all(): GeoBuilder[] {
    return [...this.map.values()];
  }
}

/**
 * A house in the towns around the bay, at the same scale as the city's: stucco
 * over a garage, a hip, gable or flat roof, a lit window. It faces `rot` (its
 * front is local +z) and steps down the slope on a foundation.
 */
function townHouse(b: GeoBuilder, r: () => number, x: number, y: number, z: number, rot: number, walls: readonly number[], roofs: readonly number[]) {
  const w = 0.62 + r() * 0.12;
  const d = 0.54 + r() * 0.1;
  const h = 0.26 + (r() < 0.35 ? 0.12 : 0);
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const at = (lx: number, lz: number): [number, number] => [x + lx * c + lz * s, z - lx * s + lz * c];
  const wall = pick(r, walls);
  b.box(w, 0.22, d, x, y - 0.22, z, 0x9a9184, false, rot);
  b.box(w, h, d, x, y - 0.01, z, wall, false, rot);
  const roof = pick(r, roofs);
  const kind = r();
  if (kind < 0.5) {
    // Hip roofs turn with the house: build one along the axes and rotate it as a geometry.
    const g = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1).rotateY(Math.PI / 4).scale(w + 0.06, 0.13, d + 0.06).translate(0, 0.065, 0).rotateY(rot);
    b.transformed(g, new THREE.Matrix4().makeTranslation(x, y + h - 0.01, z), roof);
  } else if (kind < 0.8) {
    b.gable(w + 0.04, 0.12, d + 0.06, x, y + h - 0.01, z, roof, 0.03, rot);
  } else {
    b.box(w + 0.02, 0.03, d + 0.02, x, y + h - 0.01, z, shade(wall, 0.85), false, rot);
  }
  const [gx, gz] = at(-w * 0.22, d / 2 + 0.003);
  b.panel(w * 0.4, 0.14, gx, y + 0.06, gz, rot, 0xe8e2d6, false);
  const [wx, wz] = at(w * 0.24, d / 2 + 0.004);
  b.panel(0.14, 0.1, wx, y + h * 0.62, wz, rot, PALETTE.windowWarm, true, 0.1 + r() * 0.9);
  const [bx, bz] = at(w * 0.05, -d / 2 - 0.004);
  b.panel(0.12, 0.08, bx, y + h * 0.6, bz, rot + Math.PI, PALETTE.windowWarm, true, 0.2 + r() * 0.8);
}

/** Runway designation numbers painted flat, reading from the approach (dir: +1 reads from the south). */
function runwayNumber(b: GeoBuilder, text: string, x: number, y: number, z: number, dir: number) {
  // 3 × 5 segment glyphs, each cell 0.1 square
  const glyphs: Record<string, string> = { '1': '010110010010111', '3': '111001111001111', '6': '111100111101111', '8': '111101111101111' };
  const px = 0.1;
  [...text].forEach((ch, i) => {
    const g = glyphs[ch]!;
    const ox = (i - (text.length - 1) / 2) * 0.42;
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if (g[row * 3 + col] !== '1') continue;
        // Reading from the south (dir 1), the top row is farthest north and (in this world's handedness) right is −x.
        const lx = -(ox + (col - 1) * px) * dir;
        const lz = (2 - row) * px * dir * 1.6;
        b.box(px, 0.003, px * 1.6, x + lx, y, z + lz, PALETTE.trim);
      }
    }
  });
}

/** The H on a helipad, flat. */
function helipadH(b: GeoBuilder, x: number, y: number, z: number, s: number, color: ColorLike) {
  for (const k of [-1, 1]) b.box(0.09 * s * 2, 0.003, 0.6 * s, x + k * 0.22 * s, y, z, color);
  b.box(0.44 * s, 0.003, 0.09 * s * 2, x, y, z, color);
}

/** A windsock on a pole. */
function windsock(b: GeoBuilder, x: number, y: number, z: number) {
  b.cylinder(0.01, 0.014, 0.5, x, y, z, 0xe8e8e8, 4);
  const g = new THREE.CylinderGeometry(0.035, 0.018, 0.22, 8, 1, true).rotateZ(-Math.PI / 2 + 0.25);
  b.transformed(g, new THREE.Matrix4().makeTranslation(x + 0.11, y + 0.47, z), 0xf28a3a, 'smooth');
  b.blob(0.02, x, y + 0.52, z, [2.8, 0.4, 0.3], true);
}

/** Riprap along a seawall: rocks heaped where the land meets the water, a concrete coping along the top. */
function seawall(b: GeoBuilder, r: () => number, poly: readonly Pt[], top = 0) {
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i]!;
    const [bx, bz] = poly[(i + 1) % poly.length]!;
    const len = Math.hypot(bx - ax, bz - az);
    // Outward normal: the side of the edge away from the polygon's middle.
    let nx = (bz - az) / len;
    let nz = -(bx - ax) / len;
    const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
    const cz = poly.reduce((s, p) => s + p[1], 0) / poly.length;
    if (nx * ((ax + bx) / 2 - cx) + nz * ((az + bz) / 2 - cz) < 0) {
      nx = -nx;
      nz = -nz;
    }
    const along = Math.atan2(bx - ax, bz - az);
    for (let d = 0.2; d < len - 0.1; d += 0.36) {
      const x = ax + ((bx - ax) * d) / len;
      const z = az + ((bz - az) * d) / len;
      if (terrainHeight(x + nx * 0.5, z + nz * 0.5) > SEA - 0.05) continue;
      rock(b, r, x + nx * 0.06, SEA + 0.1, z + nz * 0.06, 1.7 + r() * 0.6);
      if (r() < 0.6) rock(b, r, x + nx * 0.24, SEA - 0.02, z + nz * 0.24, 1.4 + r() * 0.5);
      b.box(0.14, 0.06, 0.38, x - nx * 0.06, top - 0.02, z - nz * 0.06, 0xd8d2c4, false, along);
    }
  }
}

/** Whether (x, z) is within `d` of a polyline. */
function nearPath(path: readonly Pt[], x: number, z: number, d: number): boolean {
  for (let i = 0; i < path.length - 1; i++) {
    const [ax, az] = path[i]!;
    const [bx, bz] = path[i + 1]!;
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    if (Math.hypot(x - ax - dx * t, z - az - dz * t) < d) return true;
  }
  return false;
}

/** Ground the Cliff House stands on, and the view of it: no trees on the rise between it and the camera (north-east). */
function hidesCliffHouse(x: number, z: number): boolean {
  if (!HAS.cliffHouse) return false;
  const dx = x - LANDMARKS.cliffHouse.x;
  const dz = z - LANDMARKS.cliffHouse.z;
  const along = (dx + dz) / Math.SQRT2;
  const across = (dx - dz) / Math.SQRT2;
  return Math.hypot(dx, dz) < 1.8 || (along > 0 && along < 4.5 && Math.abs(across) < 1.6);
}
