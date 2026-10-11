import * as THREE from 'three';
import { disposeGroup, GeoBuilder, GLOW, glowMaterial } from './geo.ts';
import { PALETTE } from './palette.ts';
import { district, headquarters, home, neighbourhoodGrounds, tree, type Built, type HQ } from './buildings.ts';
import { Fireworks, Rain, Traffic, Train, type Run } from './effects.ts';
import { Scenery } from './scenery.ts';
import { atmosphereAt, localHour, type Atmosphere } from '../world/daylight.ts';
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
const SHADOW_SPAN = 42;

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
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private warm: THREE.PointLight;
  private scenery: Scenery;
  private wilds: THREE.Group | null = null;
  private pools: THREE.MeshBasicMaterial | null = null;
  private plan: WorldPlan | null = null;
  /** Local hour shown, eased toward `targetHour`. */
  private hour = localHour();
  /** Fixed hour to show, or null to follow the local clock. */
  targetHour: number | null = null;
  atmosphere: Atmosphere = atmosphereAt(this.hour);

  constructor(name: string, seed = 1) {
    this.name = name;
    this.seed = seed;
    this.scene.fog = new THREE.Fog(0xd6ebf7, 115, 230);
    this.scene.background = new THREE.Color(0xd6ebf7);

    this.hemi = new THREE.HemisphereLight(0xcde6ff, 0x7a9a5e, 1.5);
    this.sun = new THREE.DirectionalLight(0xfff6e6, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -SHADOW_SPAN;
    sc.right = sc.top = SHADOW_SPAN;
    sc.near = 1;
    sc.far = 160;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.sun.target.position.set(0, 0, -6);
    this.warm = new THREE.PointLight(0xffb070, 0, 9, 1.6);
    this.warm.position.set(0, 2.5, 0);
    this.scene.add(this.hemi, this.sun, this.sun.target, this.warm);

    this.scenery = new Scenery(seed);
    this.scene.add(this.scenery.object, this.roadLayer, this.fireworks.object, this.rain.object, this.train.object, this.traffic.object);
  }

  // ─── Reconciliation ─────────────────────────────────────────────────────

  setPlan(plan: WorldPlan, animate: boolean) {
    this.plan = plan;
    this.syncRoads(plan.activeBlocks, plan.districts.find((d) => !d.unlocked));
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
    this.track(hq, 1, 1);
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

  private syncRoads(blocks: BlockCoord[], teaser?: BlockCoord) {
    const key = blocks.map((b) => `${b.bx},${b.bz}`).sort().join(';') + `|${teaser?.bx},${teaser?.bz}`;
    if (key === this.roadsKey) return;
    this.roadsKey = key;
    for (const child of [...this.roadLayer.children]) {
      this.roadLayer.remove(child);
      disposeGroup(child);
    }

    const { cells, runs } = roadNetwork(blocks);
    this.traffic.setRoads(runs);
    this.syncWilds(blocks, teaser);

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
      glowMaterial({ color: new THREE.Color(...PALETTE.lamp) }),
      lampSpots.length,
    );
    const pools = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1.8, 1.8).rotateX(-Math.PI / 2),
      (this.pools = new THREE.MeshBasicMaterial({ map: glowTexture(), color: 0xffb066, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })),
      lampSpots.length,
    );
    // Zebra crossings on every side of every junction
    const zebra = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.2, 0.06).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: PALETTE.roadLine, roughness: 0.8 }),
      lampSpots.length * 24,
    );
    zebra.receiveShadow = true;
    let zi = 0;

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
    const zm = new THREE.Matrix4();
    for (const c of lampSpots) {
      for (const side of [-1, 1]) {
        for (let k = 0; k < 6; k++) {
          const off = -0.3 + k * 0.12;
          zebra.setMatrixAt(zi++, zm.makeTranslation(c.x + side * 0.38, 0.023, c.z + off));
          zebra.setMatrixAt(zi++, zm.makeRotationY(Math.PI / 2).setPosition(c.x + off, 0.023, c.z + side * 0.38));
        }
      }
    }
    zebra.count = zi;
    lampSpots.forEach((c, i) => {
      poles.setMatrixAt(i, m.makeTranslation(c.x + 0.42, 0, c.z + 0.42));
      heads.setMatrixAt(i, m.makeTranslation(c.x + 0.42, 0, c.z + 0.42));
      pools.setMatrixAt(i, m.makeTranslation(c.x + 0.3, 0.03, c.z + 0.3));
    });
    poles.castShadow = true;
    this.roadLayer.add(asphalt, dashes, zebra, poles, heads, pools);
  }

  /** Undeveloped blocks inside city limits: meadow and trees, waiting for growth. */
  private syncWilds(blocks: BlockCoord[], teaser?: BlockCoord) {
    if (this.wilds) {
      this.scene.remove(this.wilds);
      disposeGroup(this.wilds);
    }
    const taken = new Set(blocks.map((b) => `${b.bx},${b.bz}`));
    if (teaser) taken.add(`${teaser.bx},${teaser.bz}`);
    const b = new GeoBuilder();
    for (let bx = -RADIUS; bx <= RADIUS; bx++) {
      for (let bz = -RADIUS; bz <= RADIUS; bz++) {
        if (taken.has(`${bx},${bz}`)) continue;
        const r = rng(hash(this.seed, 'wild', bx, bz));
        const c = blockCentre({ bx, bz });
        const n = 7 + Math.floor(r() * 6);
        for (let i = 0; i < n; i++) tree(b, r, c.x + (r() - 0.5) * 3.6, c.z + (r() - 0.5) * 3.6, 1.1);
      }
    }
    this.wilds = b.build().group;
    this.wilds.traverse((o) => (o.receiveShadow = true));
    this.scene.add(this.wilds);
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

    this.updateSky(dt, time);
    this.rain.update(dt);
    this.fireworks.update(dt);
    this.train.update(dt);
    this.traffic.update(dt);
    this.scenery.update(dt, time, this.atmosphere.night);
  }

  /** Sun, sky and lights for the current hour (local clock unless overridden). */
  private updateSky(dt: number, _time: number) {
    const target = this.targetHour ?? localHour();
    // Ease forward along the clock so previews sweep through the day instead of cutting.
    let delta = (((target - this.hour) % 24) + 24) % 24;
    if (delta > 12) delta -= 24;
    this.hour = Math.abs(delta) < 0.01 ? target : (this.hour + delta * Math.min(1, dt * 2.2) + 24) % 24;

    const a = (this.atmosphere = atmosphereAt(this.hour, this.rain.intensity));
    const [lx, ly, lz] = a.lightDir;
    this.sun.position.set(lx * 70, ly * 70 - 6, lz * 70).add(this.sun.target.position);
    this.sun.color.setRGB(...a.lightColor);
    this.sun.intensity = a.lightIntensity;
    this.hemi.color.setRGB(...a.skyColor);
    this.hemi.groundColor.setRGB(...a.groundColor);
    this.hemi.intensity = a.hemiIntensity;
    const fog = this.scene.fog as THREE.Fog;
    fog.color.setRGB(...a.fog);
    fog.near = 115 - this.rain.intensity * 12;
    fog.far = 230 - this.rain.intensity * 50;
    (this.scene.background as THREE.Color).setRGB(...a.fog);
    GLOW.night.value = a.night;
    if (this.pools) this.pools.opacity = 0.45 * a.night;
    if (this.hq) this.hq.sign.color.setScalar(1 + 1.2 * a.night);
    this.warm.intensity = 8 * a.night;
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
