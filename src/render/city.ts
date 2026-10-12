import * as THREE from 'three';
import { disposeGroup, GeoBuilder, GLOW, glassMaterial, glowMaterial, setEnvironment } from './geo.ts';
import { PALETTE } from './palette.ts';
import { home, neighbourhoodGrounds, tree, type Built } from './buildings.ts';
import { headquarters, type HQ } from './towers.ts';
import { cloudBank, encampment, setCloudLight, founderHome, itemModel, plane, plotMarker, rocket, yacht } from './models.ts';
import { Fireworks, Rain, Train } from './effects.ts';
import { Moon } from './moon.ts';
import { Traffic } from './traffic.ts';
import { Life, SHADOW_ONLY_LAYER } from './life.ts';
import { Construction } from './construction.ts';
import { festival, protest, protestBanner } from './mood.ts';
import { Batch } from './batch.ts';
import { AIRPORT_SLOTS, DOWNTOWN_HOME, HILLS_HOME, ISLAND, LAUNCH, MARINA_SLOTS, SUPERYACHT, Scenery, hillHeight } from './scenery.ts';
import { BUILD_BLOCKS, HOME_TIERS, HQ_FLOOR_CAP, ITEMS } from '../game/catalog.ts';
import { decayOf, type GameEvent, type GameState } from '../game/economy.ts';
import { atmosphereAt, localHour, type Atmosphere } from '../world/daylight.ts';
import { hash, rng } from '../world/rng.ts';
import { BLOCK, HQ_BLOCK, PITCH, blockCentre, type BlockCoord, type WorldPlan } from '../world/layout.ts';
import { BLOCKS, EMBARCADERO, LANDMARKS, MARKET_END, MARKET_START, WORLD, type Pt } from '../world/map.ts';
import type { WorldEvent } from '../world/events.ts';

export interface Tip {
  title: string;
  detail: string;
}

/** What a click landed on, for the game UI. */
export interface Pick {
  tip?: Tip;
  plot?: string;
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
  /** The object is a batched home's proxy: push its transform to the batch. */
  batchKey?: string;
}

interface Fade {
  mat?: THREE.MeshBasicMaterial;
  base?: THREE.Color;
  /** Alternative to `mat`: apply the level some other way (batched homes). */
  apply?: (level: number) => void;
  level: number;
  target: number;
}

/** Blocks on the street grid: every city block has its streets, built up or not. */
const STREET_BLOCKS: BlockCoord[] = BLOCKS.filter((b) => b.use === 'city' || b.use === 'market' || b.use === 'hq' || b.use === 'civic').map(({ bx, bz }) => ({ bx, bz }));
/** The F-line: vintage streetcars from the Castro down Market and along the Embarcadero to the Wharf. */
const F_LINE: Pt[] = [MARKET_END, MARKET_START, ...EMBARCADERO.slice(EMBARCADERO.findIndex(([, z]) => z > MARKET_START[1]), EMBARCADERO.findIndex(([x]) => x < -9) + 1)];

const easeOutBack = (t: number) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/**
 * Owns everything in the scene and reconciles it against a WorldPlan.
 * Only differences are rebuilt, so a new customer costs one small house.
 */
export class City {
  readonly scene = new THREE.Scene();
  readonly fireworks = new Fireworks();
  readonly rain = new Rain(24);
  readonly moon = new Moon();
  private camera: THREE.OrthographicCamera | null = null;
  readonly train = new Train(F_LINE, (x, z) => Math.max(0, hillHeight(x, z)) + 0.012);
  readonly traffic = new Traffic();
  /** Objects with `userData.tip` for hover tooltips. */
  readonly pickables: THREE.Object3D[] = [];

  private name: string;
  private seed: number;
  private homes = new Map<string, THREE.Object3D>();
  /** Every home and every neighbourhood's grounds, in a few draw calls. */
  private homeBatch = new Batch();
  /** Batch proxies for the neighbourhood grounds, by neighbourhood index. */
  private grounds = new Map<number, THREE.Object3D>();
  private hq: (HQ & { floors: number; level: number }) | null = null;
  private game: GameState | null = null;
  private builds = new Map<string, { group: THREE.Object3D; fade?: Fade; lit: boolean }>();
  private markers = new Map<string, THREE.Group>();
  private bases = new Map<string, THREE.Group>();
  private blockClouds = new Map<string, THREE.Group>();
  private homesOfFounder = new Map<string, THREE.Object3D>();
  private tents: { count: number; group: THREE.Group } | null = null;
  private highlights = new THREE.Group();
  private rocketObj: THREE.Group | null = null;
  private launch: { t: number; done: () => void } | null = null;
  private flame: THREE.Mesh;
  private trainStopped = false;
  private lampsFailing = false;
  private roadsKey = '';
  private roadLayer = new THREE.Group();
  private anims: Anim[] = [];
  private fades = new Set<Fade>();
  private homeFades = new Map<string, Fade>();
  private beaconLevel = 0;
  /** The festival or protest on Civic Center Plaza, if the mood calls for one. */
  private mood: { key: string; proxy: THREE.Object3D } | null = null;
  /** Fireworks waiting their turn in a show. */
  private volleys: { at: THREE.Vector3; count: number; spread: number; delay: number }[] = [];
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private warm: THREE.PointLight;
  private scenery: Scenery;
  private life: Life;
  /** Building sites in progress, keyed by the building going up. */
  private sites = new Map<THREE.Object3D, Construction>();
  /** Bought things drawn through the batch: their proxy → batch key. */
  private batched = new Map<THREE.Object3D, string>();
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
    sc.near = 1;
    sc.far = 260;
    this.setView(new THREE.Vector3(0, 0, -6), 40);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    // A touch of light in the shadows keeps the miniature look bright.
    this.sun.shadow.intensity = 0.88;
    this.sun.target.position.set(0, 0, -6);
    this.warm = new THREE.PointLight(0xffb070, 0, 9, 1.6);
    this.warm.position.set(0, 2.5, 0);
    this.scene.add(this.hemi, this.sun, this.sun.target, this.warm);

    this.scenery = new Scenery(seed);
    this.life = new Life(seed);
    // Cars give way to the F-line streetcars and the Powell cable cars.
    this.traffic.blocked = (x, z, r) => this.train.blocks(x, z, r) || this.life.blocks(x, z, r);
    this.scene.add(this.life.object);
    this.scene.add(this.homeBatch.object);
    this.pickables.push(this.homeBatch.object);
    sc.layers.enable(SHADOW_ONLY_LAYER);
    this.flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.2, 1.2, 10).rotateX(Math.PI).translate(0, -0.5, 0),
      glowMaterial({ color: new THREE.Color(3, 1.6, 0.4), transparent: true, opacity: 0.9 }),
    );
    this.flame.visible = false;
    this.scene.add(this.scenery.object, this.roadLayer, this.fireworks.object, this.rain.object, this.moon.object, this.train.object, this.traffic.object, this.highlights);
  }

  // ─── Reconciliation ─────────────────────────────────────────────────────

  /** Bring the scene in line with today's numbers and the founder's city. */
  setWorld(plan: WorldPlan, game: GameState, animate: boolean) {
    this.plan = plan;
    this.game = game;
    const open = BUILD_BLOCKS.filter((b) => game.openBlocks.includes(b.id));
    this.activeBlocks = [HQ_BLOCK, ...plan.neighbourhoods.map(({ bx, bz }) => ({ bx, bz })), ...open.map(({ bx, bz }) => ({ bx, bz }))];
    this.syncRoads(STREET_BLOCKS);
    this.syncWilds(this.activeBlocks);
    const level = game.hqLevel;
    this.syncHQ(level === 0 ? 1 : Math.min(HQ_FLOOR_CAP[level]!, plan.hqFloors - 2), level, animate);
    this.syncNeighbourhoods(plan, animate);
    this.syncHomes(plan, animate);
    this.syncLand(game, animate);
    this.syncBuilds(game, animate);
    this.syncFounder(game, animate);
    this.syncVehicles(game, animate);
    this.syncTents(game.unhoused);
    this.syncMood(game, animate);

    const decay = decayOf(game.maintenance);
    this.trainStopped = decay.trainStopped;
    this.lampsFailing = decay.lampsFailing;
    this.scenery.setState({
      hills: game.regions.hills,
      island: game.regions.island,
      launch: game.regions.launchpad,
      ferris: game.owned.some((o) => o.item === 'ferris-wheel'),
      coaster: game.owned.some((o) => o.item === 'coaster'),
      signLit: !decay.signDark,
      lampsFailing: decay.lampsFailing,
      bridgeRusting: decay.bridgeRusting,
    });
    for (const [key, b] of this.builds) {
      if (!b.fade) continue;
      const item = ITEMS.get(key.split('|')[1]!);
      const commercial = item?.category === 'business' || item?.category === 'fun';
      b.fade.target = decay.shopsBoarded && commercial ? 0.08 : 1;
    }
    this.traffic.setLuxury(Math.min(0.5, Math.max(0, (Math.log10(Math.max(1, game.peakMrr)) - 1) / 10)));

    this.rain.target = plan.weather === 'rain' ? 1 : 0;
    if (!animate) this.rain.intensity = this.rain.target;
    // plan.traffic tops out at 46; the lane graph is happy with up to ~120 cars.
    this.traffic.setCount(Math.round(plan.traffic * 2.6));
    this.traffic.setBlocks(this.activeBlocks);
  }

  private activeBlocks: BlockCoord[] = [HQ_BLOCK];

  /** Highlights the plots an item could go on; null to stop. */
  setPlacement(plots: string[] | null) {
    for (const child of [...this.highlights.children]) {
      this.highlights.remove(child);
      disposeGroup(child);
    }
    if (!plots || !this.game) return;
    const mat = new THREE.MeshBasicMaterial({ color: 0xffc24a, transparent: true, opacity: 0.32, depthWrite: false });
    for (const id of plots) {
      const p = this.game.plots.find((q) => q.id === id);
      if (!p) continue;
      // A column of light over the plot, easy to spot and to click.
      const beam = new THREE.Mesh(new THREE.BoxGeometry(1.8, 2.4, 1.8).translate(0, 1.2, 0), mat);
      beam.position.set(p.x, 0.02, p.z);
      beam.userData.plot = id;
      beam.userData.tip = { title: 'Build here', detail: 'Click to place' } satisfies Tip;
      this.highlights.add(beam);
    }
  }

  /** Objects you can click: plots and placement highlights first. */
  get clickables(): THREE.Object3D[] {
    return [...this.highlights.children, ...this.markers.values(), ...this.pickables, ...this.scenery.pickables];
  }

  /** Fly the rocket up out of sight and back. Calls `done` when it has landed. */
  launchRocket(done: () => void): boolean {
    if (!this.rocketObj || this.launch) return false;
    this.launch = { t: 0, done };
    this.rocketObj.add(this.flame);
    this.flame.visible = true;
    return true;
  }

  /** Where to point the camera for a site. */
  focusOf(what: 'airport' | 'marina' | 'pier' | 'hills' | 'island' | 'launchpad'): THREE.Vector3 {
    switch (what) {
      case 'airport':
        return new THREE.Vector3(21.5, 0, -43);
      case 'marina':
        return new THREE.Vector3(-21.4, 0, 12.8);
      case 'pier':
        return new THREE.Vector3(-8.4, 0, 16);
      case 'hills':
        return new THREE.Vector3(HILLS_HOME.x, hillHeight(HILLS_HOME.x, HILLS_HOME.z), HILLS_HOME.z);
      case 'island':
        return new THREE.Vector3(ISLAND.x, hillHeight(ISLAND.x, ISLAND.z), ISLAND.z);
      case 'launchpad':
        return new THREE.Vector3(LAUNCH.x, 1, LAUNCH.z);
    }
  }

  /** Extra spectacle for things that deserve it. */
  celebrate(events: WorldEvent[]) {
    for (const e of events) {
      if (e.type === 'release.shipped') {
        this.fireworks.launch(new THREE.Vector3(0, this.hq?.height ?? 4, 0), 3, 2);
        this.beaconLevel = 3;
      } else if (e.type === 'code.pushed') {
        this.beaconLevel = Math.max(this.beaconLevel, 1.6);
        this.train.pulse();
      } else if (e.type === 'customers.joined' && e.total === 1) {
        const first = this.homes.values().next().value;
        if (first) this.fireworks.launch(first.position.clone().setY(1), 1, 0);
      } else if (e.type === 'customers.joined' && CUSTOMER_MILESTONES.some((m) => e.total >= m && e.total - e.count < m)) {
        this.show(new THREE.Vector3(1, 0.5, -2), 1);
      } else if (e.type === 'district.unlocked') {
        // An MRR milestone: fired from barges in the bay off the Ferry Building, like New Year's Eve in SF.
        // The bigger the number, the bigger the show. (Rockets climb 4–6 units before they burst.)
        const pier = LANDMARKS.ferryBuilding;
        this.show(new THREE.Vector3(pier.x + 3.5, 0.3, pier.z + 1), e.threshold >= 10_000 ? 3 : e.threshold >= 1_000 ? 2 : 1);
      }
    }
  }

  /** A short fireworks show: volleys across a few seconds that build to a finale. */
  private show(at: THREE.Vector3, size: 1 | 2 | 3) {
    const volleys = 2 + size * 2;
    for (let i = 0; i < volleys; i++) {
      const last = i === volleys - 1;
      const a = (i / volleys) * Math.PI * 2;
      const r = last ? 0 : 1.2 + size * 0.6;
      this.volleys.push({
        at: new THREE.Vector3(at.x + Math.cos(a) * r, at.y + (i % 2) * 0.8, at.z + Math.sin(a) * r),
        count: last ? 3 + size * 2 : 1 + (i % 2),
        spread: last ? 2.5 + size : 1.5,
        delay: i * 0.45 + (last ? 0.5 : 0),
      });
    }
  }

  /** Celebrations for game moments. */
  celebrateGame(events: GameEvent[]) {
    for (const e of events) {
      if (e.type === 'land.opened') {
        const b = BUILD_BLOCKS.find((x) => x.name === e.name);
        if (b) this.fireworks.launch(new THREE.Vector3(blockCentre(b).x, 1.5, blockCentre(b).z), 3, 2.5);
      } else if (e.type === 'home.moved' || e.type === 'sign.lit') {
        const where = HOME_TIERS[this.game?.home.tier ?? 0]!.where;
        const at = e.type === 'sign.lit' ? new THREE.Vector3(LANDMARKS.sign.x, hillHeight(LANDMARKS.sign.x, LANDMARKS.sign.z) + 2, LANDMARKS.sign.z) : where === 'hills' ? new THREE.Vector3(HILLS_HOME.x, hillHeight(HILLS_HOME.x, HILLS_HOME.z) + 1, HILLS_HOME.z) : where === 'island' || where === 'moon' ? new THREE.Vector3(ISLAND.x, 2, ISLAND.z) : new THREE.Vector3(DOWNTOWN_HOME.x, 1.5, DOWNTOWN_HOME.z);
        this.fireworks.launch(at, 4, 2);
      } else if (e.type === 'region.opened') {
        const at = this.focusOf(e.region === 'launchpad' ? 'launchpad' : e.region === 'pier' ? 'pier' : e.region === 'marina' ? 'marina' : e.region === 'hills' ? 'hills' : 'island');
        this.fireworks.launch(at.clone().setY(at.y + 2), 4, 3);
      }
    }
  }

  /** Commits in the last week set the train's cruising speed. */
  setShippingPace(commitsPerWeek: number) {
    this.train.speed = this.trainStopped ? 0 : 0.008 + Math.min(0.03, commitsPerWeek * 0.0006);
  }

  /**
   * The part of the world the overview should frame: the developed city,
   * the sign on the hill, and whatever else the founder has opened up.
   */
  get framing(): { x0: number; x1: number; z0: number; z1: number } {
    const box = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
    const add = (x: number, z: number, pad = 0) => {
      box.x0 = Math.min(box.x0, x - pad);
      box.x1 = Math.max(box.x1, x + pad);
      box.z0 = Math.min(box.z0, z - pad);
      box.z1 = Math.max(box.z1, z + pad);
    };
    for (const b of this.activeBlocks) add(b.bx * PITCH, b.bz * PITCH, PITCH * 0.6);
    // The waterfront and the sign are always part of the picture, and even day one shows a bit of the Bay.
    add(-14, -12);
    add(15, 13);
    add(LANDMARKS.ferryBuilding.x, LANDMARKS.ferryBuilding.z, 1);
    add(LANDMARKS.coitTower.x, LANDMARKS.coitTower.z + 3);
    if (this.activeBlocks.length > 6) add(LANDMARKS.sign.x, LANDMARKS.sign.z, 3);
    if (this.game?.regions.island) add(ISLAND.x, ISLAND.z, ISLAND.r + 1);
    if (this.game?.regions.marina) add(-21, 13, 2);
    return { x0: Math.max(WORLD.x0, box.x0), x1: Math.min(WORLD.x1, box.x1), z0: Math.max(WORLD.z0, box.z0), z1: Math.min(WORLD.z1, box.z1) };
  }

  setShadowQuality(size: number) {
    if (this.sun.shadow.mapSize.x === size) return;
    this.sun.shadow.mapSize.set(size, size);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
  }

  setPixelRatio(pr: number) {
    this.scenery.setPixelRatio(pr);
  }

  /** Point the sun's shadow camera at what's on screen, so shadows stay crisp when zoomed in. */
  setView(target: THREE.Vector3, halfSpan: number, cameraDistance = 104, camera?: THREE.OrthographicCamera) {
    this.cameraDistance = cameraDistance;
    if (camera) this.camera = camera;
    // Rain only falls around what's on screen, sized to the view so it reads the same at any zoom.
    this.rain.object.position.set(target.x, 0, target.z);
    this.rain.object.scale.setScalar(THREE.MathUtils.clamp(halfSpan / 22, 0.3, 2.4));
    const span = THREE.MathUtils.clamp(Math.ceil(halfSpan * 1.05), 10, 90);
    const sc = this.sun.shadow.camera;
    // Snap to whole texels so shadow edges don't crawl as the camera pans.
    const texel = (span * 2) / this.sun.shadow.mapSize.x;
    const snap = (v: number) => Math.round(v / (texel * 8)) * texel * 8;
    const t = new THREE.Vector3(snap(target.x), 0, snap(target.z));
    if (sc.right !== span) {
      sc.left = sc.bottom = -span;
      sc.right = sc.top = span;
      sc.updateProjectionMatrix();
    }
    this.sun.target.position.copy(t);
  }

  private syncHQ(floors: number, level: number, animate: boolean) {
    if (this.hq?.floors === floors && this.hq.level === level) return;
    const prev = this.hq;
    const hq = { ...headquarters(this.name, floors, hash(this.seed, 'hq'), level), floors, level };
    const releases = (this.plan?.hqFloors ?? 3) - 3;
    hq.group.userData.tip = {
      title: `${this.name} HQ`,
      detail:
        level === 0
          ? `Still in the garage · ${releases} release${releases === 1 ? '' : 's'} shipped · upgrade it from Build`
          : `${releases} release${releases === 1 ? '' : 's'} shipped · one floor each (room for ${HQ_FLOOR_CAP[level]})`,
    } satisfies Tip;
    this.scene.add(hq.group);
    this.pickables.push(hq.group);
    this.track(hq, 1, 1);
    if (prev) this.remove(prev.group, false);
    if (animate && prev && prev.level !== level) {
      // A new HQ goes up behind scaffolding.
      this.construct(hq.group, 3.2);
    } else if (animate) {
      const from = prev ? prev.height / hq.height : 0.0001;
      hq.group.scale.y = from;
      this.anims.push({ obj: hq.group, t: 0, dur: prev ? 0.9 : 1.2, delay: 0, grow: true, axis: 'y', from });
    }
    this.hq = hq;
  }

  private syncNeighbourhoods(plan: WorldPlan, animate: boolean) {
    const wanted = new Set(plan.neighbourhoods.map((n) => n.index));
    for (const [n, proxy] of this.grounds) {
      if (wanted.has(n)) continue;
      this.grounds.delete(n);
      const key = `nb:${n}`;
      const done = () => this.homeBatch.remove(key);
      this.anims = this.anims.filter((a) => a.obj !== proxy);
      // Grounds are built in world space around the origin, so they only ever scale in y.
      if (animate) this.anims.push({ obj: proxy, t: 0, dur: 0.45, delay: 0, grow: false, axis: 'y', from: 1, done, batchKey: key });
      else done();
    }
    for (const n of plan.neighbourhoods) {
      if (this.grounds.has(n.index)) continue;
      const key = `nb:${n.index}`;
      const tip = { title: n.name, detail: `Neighbourhood ${n.index + 1} · ten homes` } satisfies Tip;
      const proxy = this.homeBatch.add(key, neighbourhoodGrounds(n.bx, n.bz, n.index, hash(this.seed, 'nb', n.index)), tip);
      this.grounds.set(n.index, proxy);
      if (animate) {
        proxy.scale.y = 0.0001;
        this.homeBatch.touch(key);
        this.anims.push({ obj: proxy, t: 0, dur: 0.6, delay: 0, grow: true, axis: 'y', from: 0, batchKey: key });
      }
    }
  }

  private syncHomes(plan: WorldPlan, animate: boolean) {
    const wanted = new Map(plan.homes.map((h) => [h.key, h]));
    let i = 0;
    for (const [key, proxy] of this.homes) {
      if (wanted.has(key)) continue;
      this.homes.delete(key);
      const fade = this.homeFades.get(key);
      if (fade) {
        fade.target = 0;
        this.homeFades.delete(key);
      }
      // Lights go out first, then the house is packed away.
      const done = () => {
        this.homeBatch.remove(key);
        if (fade) this.fades.delete(fade);
      };
      this.anims = this.anims.filter((a) => a.obj !== proxy);
      if (animate) this.anims.push({ obj: proxy, t: 0, dur: 0.45, delay: 0.5 + (i++ % 20) * 0.04, grow: false, axis: 'xyz', from: 1, done, batchKey: key });
      else done();
    }
    const rph = plan.residentsPerHome;
    let stagger = 0;
    for (const h of plan.homes) {
      if (this.homes.has(h.key)) continue;
      const built = home(h.kind, h.seed);
      built.group.position.set(h.x, 0, h.z);
      built.group.rotation.y = h.rot;
      const tip = {
        title: rph === 1 ? 'A home' : `Home of ${rph.toLocaleString('en-US')} residents`,
        detail: `${neighbourhoodLabel(plan, h.neighbourhood)} · your users live here while MRR covers $0.20 each`,
      } satisfies Tip;
      const hasGlow = !!built.glow;
      const key = h.key;
      const proxy = this.homeBatch.add(key, built, tip);
      this.homes.set(key, proxy);
      if (animate) {
        proxy.scale.setScalar(0.0001);
        this.homeBatch.touch(key);
        this.anims.push({ obj: proxy, t: 0, dur: 0.7, delay: Math.min(stagger++ * 0.06, 1.2), grow: true, axis: 'xyz', from: 0, batchKey: key });
      }
      if (hasGlow) {
        const fade: Fade = { apply: (level) => this.homeBatch.setGlow(key, level), level: animate ? 0 : 1, target: 1 };
        fade.apply!(fade.level);
        this.fades.add(fade);
        this.homeFades.set(key, fade);
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

    const { cells } = roadNetwork(blocks);
    this.traffic.setRoads(cells);

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

  /** City blocks nobody lives on yet: a meadow with trees, waiting for growth. */
  private wildsKey = '';
  private syncWilds(blocks: BlockCoord[]) {
    const taken = new Set([...blocks, ...BUILD_BLOCKS].map((b) => `${b.bx},${b.bz}`));
    const key = [...taken].sort().join(';');
    if (key === this.wildsKey) return;
    this.wildsKey = key;
    if (this.wilds) {
      this.scene.remove(this.wilds);
      disposeGroup(this.wilds);
    }
    const b = new GeoBuilder();
    for (const { bx, bz } of BLOCKS) {
      if (taken.has(`${bx},${bz}`) || BLOCKS.find((q) => q.bx === bx && q.bz === bz)?.use !== 'city') continue;
      const r = rng(hash(this.seed, 'wild', bx, bz));
      const c = blockCentre({ bx, bz });
      b.box(BLOCK, 0.02, BLOCK, c.x, 0, c.z, PALETTE.sidewalk);
      b.box(BLOCK - 0.3, 0.035, BLOCK - 0.3, c.x, 0, c.z, 0x8cc65e);
      const n = 6 + Math.floor(r() * 5);
      for (let i = 0; i < n; i++) tree(b, r, c.x + (r() - 0.5) * 3.2, c.z + (r() - 0.5) * 3.2, 1.0, 0.035, r() < 0.55 ? 'round' : r() < 0.6 ? 'cypress' : 'palm');
    }
    this.wilds = b.build().group;
    this.wilds.traverse((o) => (o.receiveShadow = true));
    this.scene.add(this.wilds);
  }

  // ─── The founder's city ─────────────────────────────────────────────────

  /** Pavements under open build blocks, for-sale signs on empty plots, clouds over closed land. */
  private syncLand(game: GameState, animate: boolean) {
    for (const block of BUILD_BLOCKS) {
      const open = game.openBlocks.includes(block.id);
      const c = blockCentre(block);
      const base = this.bases.get(block.id);
      const cloud = this.blockClouds.get(block.id);
      if (open && !base) {
        const b = new GeoBuilder();
        b.box(BLOCK, 0.02, BLOCK, c.x, 0, c.z, PALETTE.sidewalk);
        const g = b.build().group;
        g.traverse((o) => (o.receiveShadow = true));
        g.userData.tip = { title: block.name, detail: 'Build on its four plots' } satisfies Tip;
        this.scene.add(g);
        this.bases.set(block.id, g);
      } else if (!open && base) {
        this.scene.remove(base);
        disposeGroup(base);
        this.bases.delete(block.id);
      }
      if (!open && !cloud) {
        const g = cloudBank(c.x, c.z, BLOCK + 0.6, BLOCK + 0.6, hash(this.seed, 'cloud', block.id), 0.5).group;
        g.userData.tip = {
          title: `${block.name} (under cloud)`,
          detail: block.gate > game.peakMrr ? `Clears at $${block.gate.toLocaleString('en-US')} MRR` : 'Clears once every open plot is built on',
        } satisfies Tip;
        this.scene.add(g);
        this.pickables.push(g);
        this.blockClouds.set(block.id, g);
      } else if (open && cloud) {
        this.blockClouds.delete(block.id);
        this.remove(cloud, animate);
      } else if (cloud) {
        cloud.userData.tip.detail = block.gate > game.peakMrr ? `Clears at $${block.gate.toLocaleString('en-US')} MRR` : 'Clears once every open plot is built on';
      }
    }

    const empty = new Set(game.plots.filter((p) => p.open && !p.item).map((p) => p.id));
    for (const [id, g] of this.markers) {
      if (empty.has(id)) continue;
      this.markers.delete(id);
      this.scene.remove(g);
      disposeGroup(g);
    }
    for (const p of game.plots) {
      if (!empty.has(p.id) || this.markers.has(p.id)) continue;
      const g = plotMarker(p.x, p.z).group;
      g.userData.plot = p.id;
      g.userData.tip = { title: 'Empty plot', detail: 'Click to build here' } satisfies Tip;
      this.scene.add(g);
      this.markers.set(p.id, g);
    }
  }

  /** Everything bought onto plots. */
  private syncBuilds(game: GameState, animate: boolean) {
    const wanted = new Map<string, { x: number; z: number; item: string }>();
    for (const p of game.plots) {
      if (!p.item || !p.anchor) continue;
      const item = ITEMS.get(p.item)!;
      const block = item.placement.kind === 'plot' && item.placement.size === 4;
      const c = block ? blockCentre(BUILD_BLOCKS.find((b) => b.id === p.block)!) : p;
      wanted.set(`${p.id}|${p.item}`, { x: c.x, z: c.z, item: p.item });
    }
    for (const [key, b] of this.builds) {
      if (key.startsWith('plot:') || wanted.has(key)) continue;
      if (key.includes(':') && !key.startsWith('site:') && !key.startsWith('plot:')) {
        this.builds.delete(key);
        if (b.fade) this.fades.delete(b.fade);
        this.remove(b.group, animate);
      }
    }
    for (const [key, w] of wanted) {
      if (this.builds.has(key)) continue;
      const item = ITEMS.get(w.item)!;
      const built = itemModel(item.model, w.x, w.z, hash(this.seed, key));
      const { proxy, box, fade } = this.place(key, built, { title: item.name, detail: `${item.blurb} · upkeep ${short(item.price * item.upkeep)}/mo` }, animate ? 0 : 1);
      if (animate) this.construct(proxy, item.placement.kind === 'plot' && item.placement.size === 4 ? 3.4 : 2.6, box);
      this.builds.set(key, { group: proxy, fade, lit: true });
      if (animate) this.fireworks.launch(new THREE.Vector3(w.x, 1.5, w.z), 1, 0.5);
    }
  }

  /** Your homes: where you live now, and the ones you moved out of. */
  private syncFounder(game: GameState, animate: boolean) {
    const tier = game.home.tier;
    const picks = game.home.picks;
    const wanted = new Map<string, { option: string; x: number; y: number; z: number; rot: number; museum?: boolean; title: string; detail: string }>();
    const name = (t: number) => HOME_TIERS[t]!.options.find((o) => o.id === picks[t])!;
    if (tier <= 2) {
      const o = name(tier);
      wanted.set(`dt|${o.id}`, { option: o.id, ...DOWNTOWN_HOME, y: 0.04, rot: 0, title: `Your home: ${o.name}`, detail: o.blurb });
    } else {
      wanted.set('dt|museum', { option: 'hacker-house', ...DOWNTOWN_HOME, y: 0.04, rot: 0, museum: true, title: 'The Hacker House', detail: 'Where it all started. There is a plaque.' });
      const hillsTier = Math.min(tier, 4);
      const o = name(hillsTier);
      const live = tier <= 4;
      wanted.set(`hills|${o.id}`, {
        option: o.id,
        x: HILLS_HOME.x,
        y: hillHeight(HILLS_HOME.x, HILLS_HOME.z) - 0.05,
        z: HILLS_HOME.z,
        rot: Math.PI / 4,
        title: live ? `Your home: ${o.name}` : `Your Hills house: ${o.name}`,
        detail: o.blurb,
      });
    }
    if (tier >= 5) {
      const o = name(5);
      wanted.set(`island|${o.id}`, { option: o.id, x: ISLAND.x, y: hillHeight(ISLAND.x, ISLAND.z) - 0.02, z: ISLAND.z, rot: Math.PI / 4, title: tier === 5 ? `Your home: ${o.name}` : 'Your island estate', detail: tier === 6 ? 'You live on the moon now. Buy a rocket to visit.' : o.blurb });
    }
    for (const [key, g] of this.homesOfFounder) {
      if (wanted.has(key)) continue;
      this.homesOfFounder.delete(key);
      this.remove(g, animate);
    }
    for (const [key, w] of wanted) {
      const have = this.homesOfFounder.get(key);
      if (have) {
        this.homeBatch.setTip(this.batched.get(have)!, { title: w.title, detail: w.detail } satisfies Tip);
        continue;
      }
      const built = founderHome(w.option, hash(this.seed, key), w.museum);
      built.group.position.set(w.x, w.y, w.z);
      built.group.rotation.y = w.rot;
      const { proxy } = this.place(`founder|${key}`, built, { title: w.title, detail: w.detail }, animate ? 0 : 1);
      this.grow(proxy, animate, 'xyz', 0.9);
      this.homesOfFounder.set(key, proxy);
    }
  }

  /** Planes on the apron, yachts at the marina, the superyacht and the rocket. */
  private syncVehicles(game: GameState, animate: boolean) {
    const wanted = new Map<string, () => Built & { at: THREE.Vector3; rot: number; title: string; detail: string }>();
    let plane_ = 0;
    let yacht_ = 0;
    game.owned.forEach((o, i) => {
      const item = ITEMS.get(o.item)!;
      if (o.site === 'airport') {
        const slot = AIRPORT_SLOTS[plane_++];
        if (slot) wanted.set(`site:airport:${i}|${o.item}`, () => ({ ...plane(item.model, hash(this.seed, i)), at: new THREE.Vector3(slot.x, 0.02, slot.z), rot: 0, title: item.name, detail: 'Parked at your airport. Flights to other founders are coming soon.' }));
      } else if (o.site === 'marina') {
        const slot = MARINA_SLOTS[yacht_++];
        if (slot) wanted.set(`site:marina:${i}|${o.item}`, () => ({ ...yacht('day', hash(this.seed, i)), at: new THREE.Vector3(slot.x, -0.36, slot.z), rot: Math.PI, title: item.name, detail: item.blurb }));
      } else if (o.site === 'launchpad') {
        wanted.set(`site:launch|rocket`, () => ({ ...rocket(i), at: new THREE.Vector3(LAUNCH.x, this.rocketBase, LAUNCH.z), rot: 0, title: 'Your rocket', detail: 'Open Your home to fly to the moon.' }));
      }
    });
    if (game.home.tier >= 5) {
      wanted.set('site:superyacht|yacht', () => ({ ...yacht('super', 7), at: new THREE.Vector3(SUPERYACHT.x, -0.34, SUPERYACHT.z), rot: Math.PI / 2, title: 'Your superyacht', detail: 'Came with the island.' }));
    }
    for (const [key, b] of this.builds) {
      if (!key.startsWith('site:') || wanted.has(key)) continue;
      this.builds.delete(key);
      if (b.fade) this.fades.delete(b.fade);
      if (b.group === this.rocketObj) this.rocketObj = null;
      this.remove(b.group, animate);
    }
    for (const [key, make] of wanted) {
      if (this.builds.has(key)) continue;
      const v = make();
      v.group.position.copy(v.at);
      v.group.rotation.y = v.rot;
      const tip = { title: v.title, detail: v.detail } satisfies Tip;
      if (key.startsWith('site:launch')) {
        // The rocket flies, flame and all, so it stays a real object.
        v.group.userData.tip = tip;
        this.add(v.group, animate, 'xyz', 0.8);
        this.builds.set(key, { group: v.group, fade: this.track(v, animate ? 0 : 1, 1), lit: true });
        this.rocketObj = v.group;
        continue;
      }
      const { proxy, fade } = this.place(key, v, tip, animate ? 0 : 1);
      this.grow(proxy, animate, 'xyz', 0.8);
      this.builds.set(key, { group: proxy, fade, lit: true });
    }
  }

  /** A street festival when the city is happy, a protest at City Hall when it isn't. */
  private syncMood(game: GameState, animate: boolean) {
    const sat = game.satisfaction;
    const parts = (['housing', 'upkeep', 'amenities', 'momentum'] as const).map((k) => [k, sat[k]] as const);
    const weakest = parts.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
    const want = sat.score >= MOOD.festival ? 'festival' : sat.score < MOOD.protest ? `protest:${weakest}` : null;
    if (this.mood?.key === want) {
      if (this.mood) this.homeBatch.setTip(this.batched.get(this.mood.proxy)!, moodTip(game, weakest));
      return;
    }
    if (this.mood) {
      this.remove(this.mood.proxy, animate);
      this.mood = null;
    }
    if (!want) return;
    const built = want === 'festival' ? festival(hash(this.seed, 'festival')) : protest(hash(this.seed, 'protest'), protestBanner(weakest));
    const { proxy } = this.place(`mood|${want}`, built, moodTip(game, weakest), animate ? 0 : 1);
    this.grow(proxy, animate, 'y', 0.8);
    this.mood = { key: want, proxy };
  }

  /** Tents for the people your city can't house. More people, more tents (up to a point). */
  private syncTents(unhoused: number) {
    const count = unhoused <= 0 ? 0 : Math.min(TENT_SPOTS.length, Math.max(2, Math.round(Math.sqrt(unhoused) * 1.4)));
    if (this.tents?.count === count) {
      if (this.tents) this.tents.group.userData.tip = tentTip(unhoused);
      return;
    }
    if (this.tents) {
      this.scene.remove(this.tents.group);
      const i = this.pickables.indexOf(this.tents.group);
      if (i >= 0) this.pickables.splice(i, 1);
      disposeGroup(this.tents.group);
      this.tents = null;
    }
    if (!count) return;
    const g = encampment(TENT_SPOTS.slice(0, count), hash(this.seed, 'tents')).group;
    g.userData.tip = tentTip(unhoused);
    this.scene.add(g);
    this.pickables.push(g);
    this.tents = { count, group: g };
  }

  // ─── Animation plumbing ─────────────────────────────────────────────────

  private add(obj: THREE.Object3D, animate: boolean, axis: 'xyz' | 'y', dur: number, delay = 0) {
    this.scene.add(obj);
    this.pickables.push(obj);
    this.grow(obj, animate, axis, dur, delay);
  }

  /** Pop an object in from nothing. */
  private grow(obj: THREE.Object3D, animate: boolean, axis: 'xyz' | 'y', dur: number, delay = 0) {
    if (!animate) return;
    if (axis === 'xyz') obj.scale.setScalar(0.0001);
    else obj.scale.y = 0.0001;
    this.touchBatched(obj);
    this.anims.push({ obj, t: 0, dur, delay, grow: true, axis, from: 0 });
  }

  /**
   * Draws a bought model through the shared batch (a few draw calls for the
   * whole city). Returns its proxy, already in the scene and pickable, its
   * world box for building sites, and a fade for its lights.
   */
  private place(key: string, built: Built, tip: Tip, level: number): { proxy: THREE.Object3D; box: THREE.Box3; fade?: Fade } {
    const box = new THREE.Box3().setFromObject(built.group);
    const hasLights = !!built.glow;
    const batchKey = `b:${key}`;
    const proxy = this.homeBatch.add(batchKey, built, tip);
    this.batched.set(proxy, batchKey);
    // Parts that couldn't be merged ride on the proxy, so it lives in the scene.
    this.scene.add(proxy);
    this.pickables.push(proxy);
    let fade: Fade | undefined;
    if (hasLights) {
      fade = { apply: (l) => this.homeBatch.setGlow(batchKey, l), level, target: 1 };
      fade.apply!(level);
      this.fades.add(fade);
    }
    return { proxy, box, fade };
  }

  /** A batched model's proxy moved: copy it to the batch. */
  private touchBatched(obj: THREE.Object3D) {
    const key = this.batched.get(obj);
    if (key) this.homeBatch.touch(key);
  }

  /** Raise a building behind scaffolding, with a crane and dust. */
  private construct(obj: THREE.Object3D, duration: number, box?: THREE.Box3) {
    this.sites.get(obj)?.dispose();
    const site = new Construction(obj, duration, box);
    this.scene.add(site.object);
    this.sites.set(obj, site);
  }

  private remove(obj: THREE.Object3D, animate: boolean, delay = 0) {
    const site = this.sites.get(obj);
    if (site) {
      site.dispose();
      this.sites.delete(obj);
    }
    const i = this.pickables.indexOf(obj);
    if (i >= 0) this.pickables.splice(i, 1);
    this.anims = this.anims.filter((a) => a.obj !== obj);
    const key = this.batched.get(obj);
    const done = () => {
      if (key) {
        this.homeBatch.remove(key);
        this.batched.delete(obj);
      } else {
        this.scene.remove(obj);
        disposeGroup(obj);
      }
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
      if (a.batchKey) this.homeBatch.touch(a.batchKey);
      else this.touchBatched(a.obj);
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
      if (f.apply) f.apply(f.level * flicker);
      else f.mat!.color.copy(f.base!).multiplyScalar(f.level * flicker);
    }

    // HQ beacon: a slow heartbeat, flaring on pushes and releases.
    if (this.hq) {
      this.beaconLevel = Math.max(0, this.beaconLevel - dt * 1.5);
      const beat = 0.6 + 0.4 * Math.sin(time * 2.2);
      this.hq.beacon.color.setRGB(0.4, 1.9, 2.0).multiplyScalar(beat + this.beaconLevel);
    }

    for (const [obj, site] of this.sites) {
      const going = site.update(dt);
      this.touchBatched(obj);
      if (going) continue;
      site.dispose();
      this.sites.delete(obj);
    }
    // After the animations and building sites have moved their proxies.
    this.homeBatch.update();

    this.updateSky(dt, time);
    this.updateLaunch(dt);
    for (const h of this.highlights.children) (h as THREE.Mesh).scale.y = 1 + 0.12 * Math.sin(time * 4);
    this.rain.update(dt);
    this.moon.home = (this.game?.home.tier ?? 0) >= 6;
    // The iso view has no sky, so the moon only rises for rocket flights, as their destination.
    if (this.camera) this.moon.update(dt, this.camera, 0, !!this.launch && this.launch.t > 2 && this.launch.t < 11);
    if (this.volleys.length) {
      for (const v of this.volleys) if ((v.delay -= dt) <= 0) this.fireworks.launch(v.at, v.count, v.spread);
      this.volleys = this.volleys.filter((v) => v.delay > 0);
    }
    this.fireworks.update(dt);
    this.train.update(dt);
    this.traffic.update(dt);
    this.scenery.update(dt, time, this.atmosphere, this.sunDir);
    this.life.update(dt, time, this.atmosphere);
  }

  /** Top of the launch pad, where the rocket stands. */
  private get rocketBase(): number {
    return hillHeight(LAUNCH.x, LAUNCH.z) + 0.07;
  }

  private updateLaunch(dt: number) {
    const l = this.launch;
    const r = this.rocketObj;
    if (!l || !r) return;
    l.t += dt;
    const base = this.rocketBase;
    if (l.t < 6) {
      // Lift-off: slow, then fast, out of sight
      r.position.y = base + 0.4 * l.t * l.t * l.t;
      this.flame.scale.setScalar(1 + Math.random() * 0.3);
      if (Math.random() < 0.5) this.fireworks.launch(new THREE.Vector3(LAUNCH.x, base + 0.1, LAUNCH.z), 0, 0);
    } else if (l.t < 9) {
      r.visible = false;
    } else if (l.t < 14) {
      // Coming home: a gentle powered landing
      r.visible = true;
      const u = (l.t - 9) / 5;
      r.position.y = base + 40 * (1 - u) ** 3;
    } else {
      r.position.y = base;
      r.remove(this.flame);
      this.flame.visible = false;
      this.launch = null;
      l.done();
    }
  }

  /** Sun, sky and lights for the current hour (local clock unless overridden). */
  private sunDir = new THREE.Vector3(0, 1, 0);
  private cameraDistance = 104;
  private skyStarted = false;

  private updateSky(dt: number, time: number) {
    const target = this.targetHour ?? localHour();
    // Ease forward along the clock so previews sweep through the day instead of cutting.
    if (!this.skyStarted) {
      // First frame: start at the requested time instead of sweeping there from the local clock.
      this.skyStarted = true;
      this.hour = target;
    }
    let delta = (((target - this.hour) % 24) + 24) % 24;
    if (delta > 12) delta -= 24;
    this.hour = Math.abs(delta) < 0.01 ? target : (this.hour + delta * Math.min(1, dt * 2.2) + 24) % 24;

    const a = (this.atmosphere = atmosphereAt(this.hour, this.rain.intensity));
    const [lx, ly, lz] = a.lightDir;
    this.sunDir.set(lx, ly, lz).normalize();
    this.sun.position.copy(this.sunDir).multiplyScalar(110).add(this.sun.target.position);
    this.sun.color.setRGB(...a.lightColor);
    this.sun.intensity = a.lightIntensity;
    this.hemi.color.setRGB(...a.skyColor);
    this.hemi.groundColor.setRGB(...a.groundColor);
    this.hemi.intensity = a.hemiIntensity;
    const fog = this.scene.fog as THREE.Fog;
    fog.color.setRGB(...a.fog);
    // Haze starts a little beyond what the camera looks at, so distant hills and the far shore soften.
    fog.near = this.cameraDistance + 46 - this.rain.intensity * 25;
    fog.far = this.cameraDistance + 186 - this.rain.intensity * 70;
    (this.scene.background as THREE.Color).setRGB(...a.fog);
    GLOW.night.value = a.night;
    GLOW.time.value = time;
    setEnvironment(glassMaterial.envMap, 0.25 + 0.75 * (1 - a.night));
    // Clouds over locked land go moonlit blue-grey instead of glowing white.
    setCloudLight(a.night, fog.color);
    if (this.pools) this.pools.opacity = 0.45 * a.night * (this.lampsFailing ? 0.25 : 1);
    if (this.hq) this.hq.sign.color.setScalar(1 + 1.2 * a.night);
    this.warm.intensity = 8 * a.night;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Satisfaction scores that bring people out onto Civic Center Plaza. */
const MOOD = { festival: 85, protest: 40 };

/** The mood's tooltip always quotes the real score, and the real reason behind a protest. */
function moodTip(game: GameState, weakest: 'housing' | 'upkeep' | 'amenities' | 'momentum'): Tip {
  const score = game.satisfaction.score;
  if (score >= MOOD.festival) return { title: 'Street festival', detail: `Satisfaction ${score}/100. People love living here.` };
  const why = {
    housing: `${game.unhoused.toLocaleString('en-US')} people have no home. Housing needs $0.20 MRR per user`,
    upkeep: `Upkeep is only ${Math.round(game.maintenance)}% funded`,
    amenities: 'Too few parks and places to go for the people here',
    momentum: game.satisfaction.momentum < 0.5 ? 'MRR fell over the last four weeks' : 'MRR has barely grown in four weeks',
  }[weakest];
  return { title: 'Protest at City Hall', detail: `Satisfaction ${score}/100. ${why}.` };
}

/** Paying-customer counts worth a fireworks show. */
const CUSTOMER_MILESTONES = [10, 100, 1_000, 10_000, 100_000];

function neighbourhoodLabel(plan: WorldPlan, n: number): string {
  return plan.neighbourhoods.find((x) => x.index === n)?.name ?? 'Neighbourhood';
}

function short(n: number): string {
  if (n >= 1e9) return `$${+(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}k`;
  return `$${Math.round(n)}`;
}

function tentTip(unhoused: number): Tip {
  return {
    title: `${unhoused.toLocaleString('en-US')} people without a home`,
    detail: `Housing needs $0.20 MRR per user: $${Math.ceil(unhoused * 0.2).toLocaleString('en-US')} more MRR would house them all`,
  };
}

/** Where tents go: under the bridge, along the bay and by the tracks. Fixed so they don't jump around. */
const TENT_SPOTS: { x: number; z: number; rot: number }[] = (() => {
  const r = rng(424242);
  const spots: { x: number; z: number; rot: number }[] = [];
  const add = (x0: number, x1: number, z0: number, z1: number, n: number) => {
    for (let i = 0; i < n; i++) spots.push({ x: x0 + r() * (x1 - x0), z: z0 + r() * (z1 - z0), rot: r() * Math.PI });
  };
  // Under the Bay Bridge approach, then along the Embarcadero, then by Civic Center.
  add(8.3, 9.7, -9.5, -4.5, 16);
  add(8.3, 9.6, -20, 4, 34);
  add(-11.8, -9.6, -21.2, -19.4, 20);
  return spots.sort((a, b) => Math.hypot(a.x - 9, a.z + 7) - Math.hypot(b.x - 9, b.z + 7));
})();

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

/** Road cells ringing every developed block (the traffic module builds its lane graph from them). */
export function roadNetwork(blocks: BlockCoord[]): { cells: RoadCell[] } {
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
  return { cells: [...seen.values()] };
}
