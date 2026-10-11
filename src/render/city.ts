import * as THREE from 'three';
import { disposeGroup, GeoBuilder } from './geo.ts';
import { PALETTE } from './palette.ts';
import { district, headquarters, home, neighbourhoodGrounds, tree, type Built, type HQ } from './buildings.ts';
import { Fireworks, Rain, Traffic, Train, type Run } from './effects.ts';
import { hash, rng } from '../world/rng.ts';
import {
  BLOCK,
  DISTRICTS,
  PITCH,
  RADIUS,
  blockCentre,
  type BlockCoord,
  type WorldPlan,
} from '../world/layout.ts';
import type { WorldEvent } from '../world/events.ts';

export interface Tip {
  title: string;
  detail: string;
}

interface Anim {
  obj: THREE.Object3D;
  t: number;
  dur: number;
  delay: number;
  grow: boolean;
  axis: 'xyz' | 'y';
  from: number;
  done?: () => void;
}

interface Fade {
  mat: THREE.MeshBasicMaterial;
  base: THREE.Color;
  level: number;
  target: number;
}

const HALF = RADIUS * PITCH + BLOCK / 2 + 1; // outer edge of the outermost road
const PLATE = HALF + 4;

const easeOutBack = (t: number) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/**
 * Owns everything in the scene and reconciles it against a WorldPlan.
 * Only differences are rebuilt, so a new customer costs one small house.
 */
export class City {
  readonly scene = new THREE.Scene();
  readonly fireworks = new Fireworks();
  readonly rain = new Rain(HALF + 2);
  readonly train = new Train(HALF + 1.6);
  readonly traffic = new Traffic(46);
  /** Objects with `userData.tip` for hover tooltips. */
  readonly pickables: THREE.Object3D[] = [];

  private name: string;
  private seed: number;
  private homes = new Map<string, THREE.Group>();
  private grounds = new Map<number, THREE.Group>();
  private districts = new Map<string, { group: THREE.Group; fade?: Fade }>();
  private teaser: THREE.Group | null = null;
  private teaserId = '';
  private hq: (HQ & { floors: number }) | null = null;
  private roadsKey = '';
  private roadLayer = new THREE.Group();
  private anims: Anim[] = [];
  private fades = new Set<Fade>();
  private homeFades = new Map<string, Fade>();
  private beaconLevel = 0;
  private moon: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private plan: WorldPlan | null = null;

  constructor(name: string, seed = 1) {
    this.name = name;
    this.seed = seed;
    this.scene.fog = new THREE.Fog(PALETTE.fog, 60, 140);

    this.hemi = new THREE.HemisphereLight(0x8a9ce0, 0x2a1d33, 1.6);
    this.moon = new THREE.DirectionalLight(0xb9c8ff, 1.9);
    this.moon.position.set(-22, 34, 14);
    this.moon.castShadow = true;
    this.moon.shadow.mapSize.set(2048, 2048);
    const sc = this.moon.shadow.camera;
    sc.left = sc.bottom = -PLATE;
    sc.right = sc.top = PLATE;
    sc.near = 1;
    sc.far = 90;
    this.moon.shadow.bias = -0.0006;
    this.moon.shadow.normalBias = 0.02;
    const warm = new THREE.PointLight(0xffb070, 18, 9, 1.6);
    warm.position.set(0, 2.5, 0);
    this.scene.add(this.hemi, this.moon, warm, new THREE.AmbientLight(0x30365a, 0.6));

    this.scene.add(this.plate(), this.roadLayer, this.fireworks.object, this.rain.object, this.train.object, this.traffic.object);
    this.scene.add(this.outskirts());
  }

  // ─── Static scenery ─────────────────────────────────────────────────────

  private plate(): THREE.Group {
    const g = new THREE.Group();
    const top = new THREE.MeshStandardMaterial({ color: PALETTE.grass, roughness: 1 });
    const side = new THREE.MeshStandardMaterial({ color: PALETTE.earth, roughness: 1, flatShading: true });
    const slab = new THREE.Mesh(new THREE.BoxGeometry(PLATE * 2, 1.4, PLATE * 2), [side, side, top, side, side, side]);
    slab.position.y = -0.7;
    slab.receiveShadow = true;
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(PLATE * 2 - 0.6, 0.8, PLATE * 2 - 0.6),
      new THREE.MeshStandardMaterial({ color: PALETTE.earthDark, roughness: 1 }),
    );
    base.position.y = -1.8;
    g.add(slab, base);
    return g;
  }

  /** Trees and a river between the city limits and the edge of the world. */
  private outskirts(): THREE.Group {
    const r = rng(hash(this.seed, 'outskirts'));
    const b = new GeoBuilder();
    for (let i = 0; i < 140; i++) {
      const edge = Math.floor(r() * 4);
      const along = (r() - 0.5) * (PLATE * 2 - 1.5);
      const depth = HALF + 0.6 + r() * (PLATE - HALF - 1.2);
      const [x, z] = edge === 0 ? [along, depth] : edge === 1 ? [along, -depth] : edge === 2 ? [depth, along] : [-depth, along];
      if (Math.abs(Math.abs(x) - (HALF + 1.6)) < 0.5 || Math.abs(Math.abs(z) - (HALF + 1.6)) < 0.5) continue; // train pillars
      tree(b, r, x, z, 1 + r() * 0.5);
    }
    const g = b.build().group;
    return g;
  }

  // ─── Reconciliation ─────────────────────────────────────────────────────

  setPlan(plan: WorldPlan, animate: boolean) {
    this.plan = plan;
    this.syncRoads(plan.activeBlocks);
    this.syncHQ(plan.hqFloors, animate);
    this.syncNeighbourhoods(plan, animate);
    this.syncHomes(plan, animate);
    this.syncDistricts(plan, animate);
    this.rain.target = plan.weather === 'rain' ? 1 : 0;
    if (!animate) this.rain.intensity = this.rain.target;
    this.traffic.setCount(plan.traffic);
  }

  /** Extra spectacle for things that deserve it. */
  celebrate(events: WorldEvent[]) {
    for (const e of events) {
      if (e.type === 'district.unlocked') {
        const d = DISTRICTS.find((d) => d.id === e.id)!;
        const c = blockCentre(d);
        this.fireworks.launch(new THREE.Vector3(c.x, 2, c.z), 5, 3);
      } else if (e.type === 'release.shipped') {
        this.fireworks.launch(new THREE.Vector3(0, this.hq?.height ?? 4, 0), 3, 2);
        this.beaconLevel = 3;
      } else if (e.type === 'code.pushed') {
        this.beaconLevel = Math.max(this.beaconLevel, 1.6);
        this.train.pulse();
      } else if (e.type === 'customers.joined' && e.total === 1) {
        const first = this.homes.values().next().value;
        if (first) this.fireworks.launch(first.position.clone().setY(1), 1, 0);
      }
    }
  }

  /** Commits in the last week set the train's cruising speed. */
  setShippingPace(commitsPerWeek: number) {
    this.train.speed = 0.008 + Math.min(0.03, commitsPerWeek * 0.0006);
  }

  /** How far (in blocks) the developed city reaches from HQ; used to frame the camera. */
  get reach(): number {
    if (!this.plan) return 1;
    return Math.max(1, ...this.plan.activeBlocks.map((b) => Math.max(Math.abs(b.bx), Math.abs(b.bz))));
  }

  private syncHQ(floors: number, animate: boolean) {
    if (this.hq?.floors === floors) return;
    const prev = this.hq;
    const hq = { ...headquarters(this.name, floors, hash(this.seed, 'hq')), floors };
    hq.group.userData.tip = {
      title: `${this.name} HQ`,
      detail: `${floors - 3} release${floors - 3 === 1 ? '' : 's'} shipped · one floor each`,
    } satisfies Tip;
    this.scene.add(hq.group);
    this.pickables.push(hq.group);
    if (prev) this.remove(prev.group, false);
    if (animate) {
      const from = prev ? prev.height / hq.height : 0.0001;
      hq.group.scale.y = from;
      this.anims.push({ obj: hq.group, t: 0, dur: prev ? 0.9 : 1.2, delay: 0, grow: true, axis: 'y', from });
    }
    this.hq = hq;
  }

  private syncNeighbourhoods(plan: WorldPlan, animate: boolean) {
    const wanted = new Set(plan.neighbourhoods.map((n) => n.index));
    for (const [n, g] of this.grounds) {
      if (!wanted.has(n)) {
        this.grounds.delete(n);
        this.remove(g, animate);
      }
    }
    for (const n of plan.neighbourhoods) {
      if (this.grounds.has(n.index)) continue;
      const { group } = neighbourhoodGrounds(n.bx, n.bz, n.index, hash(this.seed, 'nb', n.index));
      group.userData.tip = { title: n.name, detail: `Neighbourhood ${n.index + 1} · ten homes` } satisfies Tip;
      this.add(group, animate, 'y', 0.6);
      this.grounds.set(n.index, group);
    }
  }

  private syncHomes(plan: WorldPlan, animate: boolean) {
    const wanted = new Map(plan.homes.map((h) => [h.key, h]));
    let i = 0;
    for (const [key, g] of this.homes) {
      if (wanted.has(key)) continue;
      this.homes.delete(key);
      const fade = this.homeFades.get(key);
      if (fade) {
        fade.target = 0;
        this.homeFades.delete(key);
      }
      // Lights go out first, then the house is packed away.
      this.remove(g, animate, animate ? 0.5 + (i++ % 20) * 0.04 : 0);
    }
    const rph = plan.residentsPerHome;
    let stagger = 0;
    for (const h of plan.homes) {
      if (this.homes.has(h.key)) continue;
      const built = home(h.kind, h.seed);
      built.group.position.set(h.x, 0, h.z);
      built.group.rotation.y = h.rot;
      const who = rph === 1 ? `Customer #${h.index + 1}` : `Customers #${h.index * rph + 1}–${(h.index + 1) * rph}`;
      built.group.userData.tip = {
        title: `${who}`,
        detail: `${neighbourhoodLabel(plan, h.neighbourhood)} · ${rph === 1 ? 'one home per customer' : `one home per ${rph} customers`}`,
      } satisfies Tip;
      const delay = animate ? Math.min(stagger++ * 0.06, 1.2) : 0;
      this.add(built.group, animate, 'xyz', 0.7, delay);
      this.homes.set(h.key, built.group);
      if (built.glow) {
        const fade = this.track(built, animate ? 0 : 1, 1);
        if (fade) this.homeFades.set(h.key, fade);
      }
    }
  }

  private syncDistricts(plan: WorldPlan, animate: boolean) {
    let stagger = 0;
    for (const d of plan.districts) {
      const have = this.districts.get(d.id);
      if (d.unlocked && !have) {
        const built = district(d, hash(this.seed, 'district', d.id));
        built.group.userData.tip = districtTip(d.name, d.threshold, d.lit);
        this.add(built.group, animate, 'y', 1.6, animate ? stagger++ * 0.3 : 0);
        const fade = this.track(built, animate ? 0 : d.lit ? 1 : 0.06, d.lit ? 1 : 0.06);
        this.districts.set(d.id, { group: built.group, fade });
      } else if (!d.unlocked && have) {
        this.districts.delete(d.id);
        if (have.fade) this.fades.delete(have.fade);
        this.remove(have.group, animate);
      } else if (have) {
        if (have.fade) have.fade.target = d.lit ? 1 : 0.06;
        if (!animate && have.fade) have.fade.level = have.fade.target;
        have.group.userData.tip = districtTip(d.name, d.threshold, d.lit);
      }
    }

    // A fenced, empty lot for the next milestone, so there's always something to work toward.
    const next = plan.districts.find((d) => !d.unlocked);
    if (next?.id !== this.teaserId) {
      if (this.teaser) this.remove(this.teaser, false);
      this.teaser = null;
      this.teaserId = next?.id ?? '';
      if (next) {
        this.teaser = constructionSite(next);
        this.teaser.userData.tip = { title: next.name, detail: `Opens when MRR reaches ${money(next.threshold)}` } satisfies Tip;
        this.scene.add(this.teaser);
        this.pickables.push(this.teaser);
      }
    }
  }

  private syncRoads(blocks: BlockCoord[]) {
    const key = blocks.map((b) => `${b.bx},${b.bz}`).sort().join(';');
    if (key === this.roadsKey) return;
    this.roadsKey = key;
    for (const child of [...this.roadLayer.children]) {
      this.roadLayer.remove(child);
      disposeGroup(child);
    }

    const { cells, runs } = roadNetwork(blocks);
    this.traffic.setRoads(runs);

    const asphalt = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 0.02, 1),
      new THREE.MeshStandardMaterial({ color: PALETTE.road, roughness: 0.55, metalness: 0.15 }),
      cells.length,
    );
    asphalt.receiveShadow = true;
    const dashes = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.36, 0.04).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: PALETTE.roadLine }),
      cells.length,
    );
    const lampSpots = cells.filter((c) => c.kind === 'cross');
    const poles = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.018, 0.025, 0.6, 5).translate(0, 0.3, 0),
      new THREE.MeshStandardMaterial({ color: 0x2c2e3a, roughness: 0.5 }),
      lampSpots.length,
    );
    const heads = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(0.05, 0).translate(0, 0.62, 0),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(...PALETTE.lamp) }),
      lampSpots.length,
    );
    const pools = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1.8, 1.8).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: glowTexture(), color: 0xffb066, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }),
      lampSpots.length,
    );

    const m = new THREE.Matrix4();
    let dashCount = 0;
    cells.forEach((c, i) => {
      asphalt.setMatrixAt(i, m.makeTranslation(c.x, 0.01, c.z));
      if (c.kind !== 'cross') {
        m.makeRotationY(c.kind === 'z' ? Math.PI / 2 : 0).setPosition(c.x, 0.022, c.z);
        dashes.setMatrixAt(dashCount++, m);
      }
    });
    dashes.count = dashCount;
    lampSpots.forEach((c, i) => {
      poles.setMatrixAt(i, m.makeTranslation(c.x + 0.42, 0, c.z + 0.42));
      heads.setMatrixAt(i, m.makeTranslation(c.x + 0.42, 0, c.z + 0.42));
      pools.setMatrixAt(i, m.makeTranslation(c.x + 0.3, 0.03, c.z + 0.3));
    });
    poles.castShadow = true;
    this.roadLayer.add(asphalt, dashes, poles, heads, pools);
  }

  // ─── Animation plumbing ─────────────────────────────────────────────────

  private add(obj: THREE.Object3D, animate: boolean, axis: 'xyz' | 'y', dur: number, delay = 0) {
    this.scene.add(obj);
    this.pickables.push(obj);
    if (!animate) return;
    if (axis === 'xyz') obj.scale.setScalar(0.0001);
    else obj.scale.y = 0.0001;
    this.anims.push({ obj, t: 0, dur, delay, grow: true, axis, from: 0 });
  }

  private remove(obj: THREE.Object3D, animate: boolean, delay = 0) {
    const i = this.pickables.indexOf(obj);
    if (i >= 0) this.pickables.splice(i, 1);
    this.anims = this.anims.filter((a) => a.obj !== obj);
    const done = () => {
      this.scene.remove(obj);
      disposeGroup(obj);
    };
    if (animate) this.anims.push({ obj, t: 0, dur: 0.45, delay, grow: false, axis: 'xyz', from: 1, done });
    else done();
  }

  private track(built: Built, level: number, target: number): Fade | undefined {
    if (!built.glow) return undefined;
    const fade = { mat: built.glow, base: built.glow.color.clone(), level, target };
    built.glow.color.copy(fade.base).multiplyScalar(level);
    this.fades.add(fade);
    return fade;
  }

  update(dt: number, time: number) {
    for (const a of this.anims) {
      if (a.delay > 0) {
        a.delay -= dt;
        continue;
      }
      a.t = Math.min(1, a.t + dt / a.dur);
      const k = a.grow ? a.from + (1 - a.from) * (a.axis === 'xyz' ? easeOutBack(a.t) : easeOutCubic(a.t)) : 1 - easeOutCubic(a.t);
      const s = Math.max(0.0001, k);
      if (a.axis === 'xyz') a.obj.scale.setScalar(s);
      else a.obj.scale.y = s;
      if (a.t >= 1) a.done?.();
    }
    this.anims = this.anims.filter((a) => a.t < 1);

    for (const f of this.fades) {
      if (Math.abs(f.level - f.target) < 0.001) {
        if (f.target === 0 && f.level === 0) this.fades.delete(f);
        continue;
      }
      // Lights come on with a flicker, go off smoothly.
      const step = f.target > f.level ? dt * 1.4 : -dt * 2;
      f.level = f.target > f.level ? Math.min(f.target, f.level + step) : Math.max(f.target, f.level + step);
      const flicker = f.target > f.level && f.level > 0.2 && Math.random() < 0.15 ? 0.3 : 1;
      f.mat.color.copy(f.base).multiplyScalar(f.level * flicker);
    }

    // HQ beacon: a slow heartbeat, flaring on pushes and releases.
    if (this.hq) {
      this.beaconLevel = Math.max(0, this.beaconLevel - dt * 1.5);
      const beat = 0.6 + 0.4 * Math.sin(time * 2.2);
      this.hq.beacon.color.setRGB(0.4, 1.9, 2.0).multiplyScalar(beat + this.beaconLevel);
    }

    // Weather dims the moon and thickens the air.
    const wet = this.rain.intensity;
    this.moon.intensity = 1.9 - wet * 1.1;
    this.hemi.intensity = 1.6 - wet * 0.6;
    const fog = this.scene.fog as THREE.Fog;
    fog.color.lerpColors(new THREE.Color(PALETTE.fog), new THREE.Color(PALETTE.fogRain), wet);
    fog.near = 60 - wet * 25;

    this.rain.update(dt);
    this.fireworks.update(dt);
    this.train.update(dt);
    this.traffic.update(dt);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function neighbourhoodLabel(plan: WorldPlan, n: number): string {
  return plan.neighbourhoods.find((x) => x.index === n)?.name ?? 'Neighbourhood';
}

function money(n: number): string {
  return '$' + n.toLocaleString('en-US');
}

function districtTip(name: string, threshold: number, lit: boolean): Tip {
  return {
    title: name,
    detail: `${threshold <= 1 ? 'Opened with your first revenue' : `Unlocked at ${money(threshold)} MRR`}${lit ? '' : ' · lights off while MRR is below it'}`,
  };
}

function constructionSite(d: { bx: number; bz: number; neon: number }): THREE.Group {
  const b = new GeoBuilder();
  const c = blockCentre(d);
  b.box(BLOCK - 0.2, 0.02, BLOCK - 0.2, c.x, 0, c.z, 0x3b3226);
  const fence = 0xc9a13b;
  for (let i = 0; i < 9; i++) {
    const u = -1.8 + i * 0.45;
    for (const [x, z] of [[c.x + u, c.z - 1.85], [c.x + u, c.z + 1.85], [c.x - 1.85, c.z + u], [c.x + 1.85, c.z + u]] as const) {
      b.box(0.04, 0.22, 0.04, x, 0, z, fence);
    }
  }
  for (const [x, z, w, d2] of [[c.x, c.z - 1.85, 3.7, 0.02], [c.x, c.z + 1.85, 3.7, 0.02], [c.x - 1.85, c.z, 0.02, 3.7], [c.x + 1.85, c.z, 0.02, 3.7]] as const) {
    b.box(w, 0.03, d2, x, 0.16, z, fence);
  }
  // A crane, waiting.
  b.box(0.12, 2.6, 0.12, c.x - 1, 0, c.z - 1, 0xe0b040);
  b.box(2.2, 0.08, 0.08, c.x - 0.2, 2.6, c.z - 1, 0xe0b040);
  b.blob(0.05, c.x + 0.85, 2.7, c.z - 1, [2.8, 0.3, 0.2], true);
  b.box(0.5, 0.3, 0.5, c.x + 0.6, 0.02, c.z + 0.4, 0x6a5a48);
  return b.build().group;
}

let glowTex: THREE.Texture | null = null;
function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

interface RoadCell {
  x: number;
  z: number;
  /** 'x' = road runs along x, 'z' = along z, 'cross' = intersection. */
  kind: 'x' | 'z' | 'cross';
}

const onLine = (v: number) => Math.abs((((v - PITCH / 2) % PITCH) + PITCH) % PITCH) < 1e-6;

/** Road cells ringing every developed block, plus the straight runs cars can use. */
export function roadNetwork(blocks: BlockCoord[]): { cells: RoadCell[]; runs: Run[] } {
  const seen = new Map<string, RoadCell>();
  const h = BLOCK / 2 + 0.5;
  for (const b of blocks) {
    const c = blockCentre(b);
    for (let u = -h; u <= h + 1e-6; u += 1) {
      for (const [x, z] of [[c.x + u, c.z - h], [c.x + u, c.z + h], [c.x - h, c.z + u], [c.x + h, c.z + u]] as const) {
        const key = `${x},${z}`;
        if (seen.has(key)) continue;
        const kind = onLine(x) && onLine(z) ? 'cross' : onLine(z) ? 'x' : 'z';
        seen.set(key, { x, z, kind });
      }
    }
  }
  const cells = [...seen.values()];

  const runs: Run[] = [];
  for (const axis of ['x', 'z'] as const) {
    const lines = new Map<number, number[]>();
    for (const c of cells) {
      if (c.kind !== axis && c.kind !== 'cross') continue;
      const line = axis === 'x' ? c.z : c.x;
      const along = axis === 'x' ? c.x : c.z;
      if (!lines.has(line)) lines.set(line, []);
      lines.get(line)!.push(along);
    }
    for (const [line, values] of lines) {
      values.sort((a, b) => a - b);
      let start = values[0]!;
      for (let i = 1; i <= values.length; i++) {
        if (i === values.length || values[i]! - values[i - 1]! > 1.01) {
          runs.push({ axis, line, from: start - 0.5, to: values[i - 1]! + 0.5 });
          start = values[i]!;
        }
      }
    }
  }
  return { cells, runs };
}
