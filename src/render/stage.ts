import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { City, Pick, Tip } from './city.ts';
import { Post, type Quality } from './post.ts';
import { setEnvironment } from './geo.ts';
import { WORLD } from '../world/map.ts';
import { onSettings, reportGraphics, settings, startQuality, type QualityMode } from '../ui/settings-store.ts';
import { prefersReducedMotion } from '../ui/dom.ts';

/** Isometric: looking down 35.26° from the horizontal. */
const ISO_POLAR = Math.acos(1 / Math.sqrt(3));
const VIEW = 26;
const LIMIT = { x0: WORLD.x0 - 8, x1: WORLD.x1 + 16, z0: WORLD.z0 - 16, z1: WORLD.z1 + 8 };
const QUALITIES: Quality[] = ['low', 'medium', 'high'];
/** How far the camera sits from what it looks at. Far enough that nothing is ever behind the near plane. */
const DISTANCE = 240;

/** A set to draw instead of the city for a while (the moon), through its own camera. */
export interface Shot {
  scene: THREE.Scene;
  camera: THREE.Camera;
  exposure: number;
  look: { bloom: number; night: number; tilt: number; focusY: number; warmth: number };
}

/**
 * A sequence that takes the screen (the moon trip). Each frame it moves
 * things along and says what to draw: a `Shot`, or null for the city
 * through the usual camera, which it may steer with `follow()`. Input to
 * the map is off until it's `done`.
 */
export interface Cinematic {
  update(dt: number, time: number): Shot | null;
  readonly done: boolean;
}

function requestedQuality(): Quality | null {
  const q = new URLSearchParams(location.search).get('quality');
  return q === 'low' || q === 'medium' || q === 'high' ? q : null;
}

/**
 * Renderer, camera and input. Orthographic isometric camera; drag to pan,
 * right-drag or Q/E to rotate, scroll or pinch to zoom.
 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.OrthographicCamera;
  readonly controls: OrbitControls;
  private post: Post;
  private timer = new THREE.Timer();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2(2, 2);
  private pointerDirty = false;
  private userZoomed = false;
  private spin: { from: number; to: number; t: number } | null = null;
  onHover: (tip: Tip | null, x: number, y: number) => void = () => {};
  onPick: (pick: Pick | null) => void = () => {};
  private down: { x: number; y: number } | null = null;
  private glide: { target: THREE.Vector3; zoom: number; t: number; fromT: THREE.Vector3; fromZ: number } | null = null;
  onFrame: (dt: number) => void = () => {};
  private lastClient = { x: 0, y: 0 };
  private host: HTMLElement;
  private city: City;
  /** Adaptive quality: frame times are sampled in windows for the whole session. */
  private perf: { frames: number; time: number; locked: boolean; calm: number; stepsDown: number; stepsUp: number };
  /** `?quality=` pins the level for screenshots until the visitor picks one in Settings. */
  private forced: Quality | null;
  /** A touch screen: Automatic starts a level lower. */
  private coarse: boolean;
  /** Bumped when shadows turn on or off; each scene remembers the last one it was brought in line with. */
  private shadowEpoch = 0;
  private shadowBuilt = new WeakMap<THREE.Scene, number>();
  /** Lights we stopped casting (shadows off), to switch back on later. */
  private muted = new WeakSet<THREE.Light>();
  private maxPixelRatio = 2;
  /** Something is playing (the replay): keep the full frame rate. Set by the app. */
  active = false;
  /** Frame pacing: 60 fps while anything moves or you interact, 30 fps once the scene is calm. */
  private lastFrame = 0;
  private lastInput = 0;
  private easing = true;
  private dragging = false;
  private lastPick = 0;
  private wasCalm = false;
  private following: { target: () => THREE.Vector3; zoom: number; height: boolean; snap: boolean } | null = null;
  private cinema: Cinematic | null = null;
  private tmpStep = new THREE.Vector3();
  /**
   * Attract mode (the front door): the camera sways slowly around the city
   * until the visitor touches anything. `inset` is the share of the screen
   * the title card covers, so the framing keeps the city in what's left.
   */
  private drift: { home: number; t: number; on: boolean } | null = null;
  private attractInset: ((w: number, h: number) => { left: number; bottom: number }) | null = null;

  constructor(host: HTMLElement, city: City) {
    this.host = host;
    this.city = city;
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    host.appendChild(this.renderer.domElement);

    // Image-based light so glass, paint and water pick up a soft studio sky.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    setEnvironment(pmrem.fromScene(new RoomEnvironment(), 0.04).texture);
    pmrem.dispose();

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, DISTANCE * 2.6);
    this.camera.position.setScalar(DISTANCE / Math.sqrt(3));
    this.camera.zoom = 1;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.minPolarAngle = this.controls.maxPolarAngle = ISO_POLAR;
    this.controls.minZoom = 0.32;
    this.controls.maxZoom = 14;
    this.controls.zoomToCursor = true;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    this.controls.addEventListener('start', () => {
      this.stopDrift();
      this.userZoomed = true;
      this.glide = null;
      this.dragging = true;
      this.following = null;
      this.wake();
    });
    this.controls.addEventListener('end', () => (this.dragging = false));
    this.controls.addEventListener('change', () => this.clampTarget());

    // The visitor's settings apply before the first frame, so the pipeline is built once at the right level.
    const prefs = settings();
    this.forced = requestedQuality();
    this.coarse = matchMedia('(pointer: coarse)').matches;
    const start = startQuality(prefs.quality, { coarse: this.coarse, forced: this.forced });
    this.perf = { frames: 0, time: 0, locked: !start.adaptive, calm: 0, stepsDown: 0, stepsUp: 0 };
    this.renderer.shadowMap.enabled = prefs.shadows;
    this.post = new Post(this.renderer, city.scene, this.camera, start.level);
    this.post.setTiltShift(prefs.tiltShift);
    this.applyQuality(start.level);
    onSettings((s, changed) => {
      if (changed.includes('quality')) this.setQualityMode(s.quality);
      if (changed.includes('tiltShift')) this.post.setTiltShift(s.tiltShift);
      if (changed.includes('shadows')) this.setShadows(s.shadows);
      this.wake();
    });

    const el = this.renderer.domElement;
    el.addEventListener('pointermove', (e) => {
      const rect = el.getBoundingClientRect();
      this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      this.lastClient = { x: e.clientX, y: e.clientY };
      this.pointerDirty = true;
      this.wake();
    });
    el.addEventListener('pointerleave', () => {
      this.pointer.set(2, 2);
      this.onHover(null, 0, 0);
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      this.stopDrift();
      this.down = { x: e.clientX, y: e.clientY };
      this.wake();
    });
    el.addEventListener(
      'wheel',
      () => {
        this.stopDrift();
        this.wake();
      },
      { passive: true },
    );
    el.addEventListener('pointerup', (e) => {
      const d = this.down;
      this.down = null;
      if (!d || this.cinema || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || e.button !== 0) return;
      const rect = el.getBoundingClientRect();
      const p = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      this.raycaster.setFromCamera(p, this.camera);
      this.onPick(this.pickAt());
    });
    window.addEventListener('keydown', (e) => {
      this.wake();
      // Moving focus around the title card isn't touching the city.
      if (e.key !== 'Tab' && e.key !== 'Shift') this.stopDrift();
      if (e.target instanceof HTMLInputElement || this.cinema) return;
      if (e.key === 'q' || e.key === 'Q') this.rotate(-1);
      if (e.key === 'e' || e.key === 'E') this.rotate(1);
    });

    // Dev tools (tools/perf.mjs) reach the stage here; `?debug` exposes it in a build too.
    if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) (window as unknown as { __stage: Stage }).__stage = this;
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  private applyQuality(q: Quality) {
    this.post.setQuality(q);
    // Retina screens at full density cost 4× the pixels; past 1.5 the tilt-shift and MSAA hide the difference.
    this.maxPixelRatio = q === 'high' ? 1.5 : q === 'medium' ? 1.25 : 1;
    const size = q === 'high' ? 4096 : q === 'medium' ? 2048 : 1536;
    this.city.setShadowQuality(size);
    this.resize();
    reportGraphics({ level: q, forced: this.forced, coarse: this.coarse });
  }

  /**
   * A choice from Settings, live: Automatic starts over from the device's
   * level and adapts as it always has; a fixed level stays put. Either way
   * the visitor's pick now outranks a `?quality=` in the address.
   */
  private setQualityMode(mode: QualityMode) {
    this.forced = null;
    const start = startQuality(mode, { coarse: this.coarse, forced: null });
    Object.assign(this.perf, { frames: 0, time: 0, locked: !start.adaptive, calm: 0, stepsDown: 0, stepsUp: 0 });
    this.applyQuality(start.level);
  }

  /** The sun's shadow pass on or off: a real saving (one less pass over the city), at the cost of a one-off shader rebuild. */
  private setShadows(on: boolean) {
    if (this.renderer.shadowMap.enabled === on) return;
    this.renderer.shadowMap.enabled = on;
    this.shadowEpoch++;
  }

  /**
   * Brings a scene's lights in line with the shadow setting before it's drawn.
   * With shadows off, its shadow-casting lights stop casting: that changes the
   * renderer's light state, so three.js rebuilds every lit shader without the
   * shadow lookups by itself, including models that are off stage right now.
   * Each scene is checked once per change (the moon set is built later).
   */
  private syncShadows(scene: THREE.Scene) {
    if (this.shadowBuilt.get(scene) === this.shadowEpoch) return;
    this.shadowBuilt.set(scene, this.shadowEpoch);
    const on = this.renderer.shadowMap.enabled;
    scene.traverse((o) => {
      const light = o as THREE.DirectionalLight;
      if (!light.isLight || !light.shadow) return;
      if (!on && light.castShadow) {
        light.castShadow = false;
        this.muted.add(light);
      } else if (on && this.muted.delete(light)) light.castShadow = true;
    });
  }

  /**
   * Attract mode for the front door: a slow sway of a couple of degrees a
   * second either side of the current view, framed around the title card
   * (`inset`, fractions of the screen it covers). It stops dead on any
   * pointer, wheel or key input, and gives way to `focus()`, `follow()` and
   * `rotate()`. Off, the framing goes back to the HUD's and, with `settle`,
   * the camera eases back to the isometric angle it started from. Reduced
   * motion keeps the framing and skips the sway.
   */
  attract(on: boolean, inset?: (w: number, h: number) => { left: number; bottom: number }, opts: { settle?: boolean } = {}) {
    if (on) {
      this.attractInset = inset ?? null;
      const still = prefersReducedMotion();
      this.drift = { home: this.snapAzimuth(this.controls.getAzimuthalAngle()), t: 0, on: !still };
      return;
    }
    const d = this.drift;
    this.attractInset = null;
    this.drift = null;
    if (d && opts.settle && !this.spin && !this.glide && !this.following) {
      const from = this.controls.getAzimuthalAngle();
      if (Math.abs(from - d.home) > 1e-3) this.spin = { from, to: d.home, t: 0 };
    }
  }

  /** The visitor touched something: the sway stops where it is. */
  private stopDrift() {
    if (this.drift) this.drift.on = false;
  }

  /** The nearest of the four isometric angles (45° + quarter turns). */
  private snapAzimuth(az: number) {
    const quarter = Math.PI / 2;
    return Math.round((az - Math.PI / 4) / quarter) * quarter + Math.PI / 4;
  }

  /** Quarter turn around the current focus. */
  rotate(dir: 1 | -1) {
    this.stopDrift();
    const from = this.controls.getAzimuthalAngle();
    const quarter = Math.PI / 2;
    const to = Math.round((from + dir * quarter - Math.PI / 4) / quarter) * quarter + Math.PI / 4;
    this.spin = { from, to, t: 0 };
  }

  /** Zoom in (>1) or out (<1) around the current focus. */
  zoomBy(factor: number) {
    this.userZoomed = true;
    const zoom = THREE.MathUtils.clamp(this.camera.zoom * factor, this.controls.minZoom, this.controls.maxZoom);
    this.glide = { target: this.controls.target.clone(), zoom, t: 0, fromT: this.controls.target.clone(), fromZ: this.camera.zoom };
  }

  /** Smoothly fly the camera to look at a point. */
  focus(target: THREE.Vector3, zoom = 2.4) {
    this.stopDrift();
    this.userZoomed = true;
    this.following = null;
    this.glide = { target: target.clone(), zoom, t: 0, fromT: this.controls.target.clone(), fromZ: this.camera.zoom };
  }

  /**
   * Keeps the camera on something that moves (a helicopter on its way to
   * your island), easing towards it each frame, until `stopFollowing()`
   * or the user grabs the controls. With `height`, the view also rises and
   * falls with it (a rocket), as far as the camera's limits allow; `snap`
   * starts it there instead of easing over (for a cut).
   */
  follow(target: () => THREE.Vector3, zoom: number, height = false, snap = false) {
    this.stopDrift();
    this.userZoomed = true;
    this.glide = null;
    this.following = { target, zoom, height, snap };
  }

  /**
   * Hands the screen to a cinematic (or back, with null): the map stops
   * taking input, and each frame draws what the cinematic says until it's
   * done.
   */
  play(c: Cinematic | null) {
    this.cinema = c;
    this.controls.enabled = !c;
    if (c) {
      this.stopDrift();
      this.spin = null;
      this.pointer.set(2, 2);
      this.onHover(null, 0, 0);
    } else this.post.setView(this.city.scene, this.camera);
    this.wake();
  }

  /** A cinematic has the screen. */
  get playing(): boolean {
    return this.cinema !== null;
  }

  stopFollowing() {
    this.following = null;
  }

  /** Back to the overview that frames the whole developed city. */
  resetView() {
    this.userZoomed = false;
    const offset = this.camera.position.clone().sub(this.controls.target);
    const d = offset.length();
    const az = Math.PI / 4;
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3(Math.sin(az) * Math.sin(ISO_POLAR) * d, Math.cos(ISO_POLAR) * d, Math.cos(az) * Math.sin(ISO_POLAR) * d));
    this.camera.lookAt(this.controls.target);
    const { target, zoom } = this.framing();
    this.glide = { target, zoom, t: 0, fromT: this.controls.target.clone(), fromZ: this.camera.zoom };
    this.userZoomed = false;
  }

  private clampTarget() {
    const t = this.controls.target;
    t.x = THREE.MathUtils.clamp(t.x, LIMIT.x0, LIMIT.x1);
    t.z = THREE.MathUtils.clamp(t.z, LIMIT.z0, LIMIT.z1);
    t.y = THREE.MathUtils.clamp(t.y, -2, 8);
  }

  private resize() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    const aspect = w / Math.max(1, h);
    this.camera.left = (-VIEW * aspect) / 2;
    this.camera.right = (VIEW * aspect) / 2;
    this.camera.top = VIEW / 2;
    this.camera.bottom = -VIEW / 2;
    this.camera.updateProjectionMatrix();
    const pr = Math.min(window.devicePixelRatio, this.maxPixelRatio);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h);
    this.post?.setSize(w, h, pr);
    this.city.setPixelRatio(pr);
  }

  /**
   * Target and zoom that fit the city's framing box on screen, seen from the
   * current angle, with room for the HUD at the top and the dock at the bottom.
   */
  private framing(): { target: THREE.Vector3; zoom: number } {
    const box = this.city.framing;
    const q = this.camera.quaternion;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const c = new THREE.Vector3((box.x0 + box.x1) / 2, 0, (box.z0 + box.z1) / 2);
    let r0 = Infinity;
    let r1 = -Infinity;
    let u0 = Infinity;
    let u1 = -Infinity;
    const p = new THREE.Vector3();
    for (const x of [box.x0, box.x1]) {
      for (const z of [box.z0, box.z1]) {
        for (const y of [0, 2.5]) {
          p.set(x, y, z).sub(c);
          const r = p.dot(right);
          const u = p.dot(up);
          r0 = Math.min(r0, r);
          r1 = Math.max(r1, r);
          u0 = Math.min(u0, u);
          u1 = Math.max(u1, u);
        }
      }
    }
    const w = this.host.clientWidth;
    const h = Math.max(1, this.host.clientHeight);
    const aspect = w / h;
    // The front door's title card says how much of the screen it covers; otherwise
    // the stats panels cover the left edge on wide screens. Frame the city in what's left.
    const card = this.attractInset?.(w, h) ?? null;
    const inset = card ? card.left * w : w > 900 ? Math.min(320, w * 0.24) : 0;
    const below = card ? card.bottom : 0;
    const usable = (w - inset) / w;
    // The HUD covers roughly the top 12% and the dock the bottom 14%: centre a little high.
    // The title card has no dock, so the city can fill more of the height it leaves.
    const zoom = THREE.MathUtils.clamp(Math.min((VIEW * aspect * usable) / ((r1 - r0) * 1.04), (VIEW * (1 - below)) / ((u1 - u0) * (card ? 1.14 : 1.3))), this.controls.minZoom, 3.2);
    const visibleH = VIEW / zoom;
    const visibleW = (VIEW * aspect) / zoom;
    const target = c
      .clone()
      .addScaledVector(right, (r0 + r1) / 2 - (visibleW * inset) / w / 2)
      .addScaledVector(up, (u0 + u1) / 2 - (card ? (visibleH * below) / 2 : visibleH * 0.03));
    // Slide along the view ray back to the ground plane.
    target.addScaledVector(fwd, -target.y / fwd.y);
    return { target, zoom };
  }

  start() {
    let { target, zoom } = this.framing();
    // `?view=x,z,zoom` pins the camera (handy for screenshots and links).
    const view = new URLSearchParams(location.search).get('view')?.split(',').map(Number);
    if (view && view.length >= 2 && view.every(Number.isFinite)) {
      target = new THREE.Vector3(view[0], 0, view[1]);
      zoom = view[2] ?? 2.4;
      this.userZoomed = true;
    }
    this.camera.position.add(target.clone().sub(this.controls.target));
    this.controls.target.copy(target);
    this.camera.zoom = zoom;
    this.camera.updateProjectionMatrix();
    this.timer.connect(document);
    this.renderer.setAnimationLoop((now) => this.frame(now));
  }

  /** Someone touched the controls: full frame rate for a while. */
  wake() {
    this.lastInput = performance.now();
  }

  private frame(now: number) {
    // A calm city (no input, no replay, nothing moving the camera, nothing popping in) draws at
    // 30 fps: the miniature still breathes, at half the CPU and GPU. Skipped frames fold into dt.
    const calm = !this.active && !this.cinema && !this.drift?.on && !this.spin && !this.glide && !this.following && !this.easing && !this.city.lively && now - this.lastInput > 4000;
    if (this.lastFrame && now - this.lastFrame < (calm ? 1000 / 30 : 1000 / 60) - 2) return;
    this.lastFrame = now;
    const paced = calm || this.wasCalm;
    this.wasCalm = calm;
    this.timer.update(now);
    const raw = this.timer.getDelta();
    const dt = Math.min(0.05, raw);
    const time = this.timer.getElapsed();
    // Calm frames are slow on purpose: only full-rate frames say anything about the machine.
    if (!paced) this.adapt(raw);
    // A cinematic moves first, so the camera follows where things are this frame.
    const shot = this.cinema ? this.cinema.update(dt, time) : null;
    if (this.cinema?.done) this.play(null);

    if (this.drift?.on && !this.spin && !this.glide && !this.following) {
      // A slow sway either side of the start angle: 22° each way over 76 s
      // (under 2° a second at its fastest), easing in over the first 4 s.
      const d = this.drift;
      d.t += dt;
      const ramp = Math.min(1, d.t / 4);
      const az = d.home + THREE.MathUtils.degToRad(22) * Math.sin((d.t * Math.PI * 2) / 76) * ramp * ramp * (3 - 2 * ramp);
      const offset = this.camera.position.clone().sub(this.controls.target);
      const r = Math.hypot(offset.x, offset.z);
      offset.x = Math.sin(az) * r;
      offset.z = Math.cos(az) * r;
      this.camera.position.copy(this.controls.target).add(offset);
    }

    if (this.spin) {
      this.spin.t = Math.min(1, this.spin.t + dt / 0.6);
      const k = 1 - (1 - this.spin.t) ** 3;
      const az = this.spin.from + (this.spin.to - this.spin.from) * k;
      const offset = this.camera.position.clone().sub(this.controls.target);
      const r = Math.hypot(offset.x, offset.z);
      offset.x = Math.sin(az) * r;
      offset.z = Math.cos(az) * r;
      this.camera.position.copy(this.controls.target).add(offset);
      if (this.spin.t >= 1) this.spin = null;
    }

    if (this.following) {
      // Ride along: ease the view onto the moving target, ground level beneath it.
      const f = this.following;
      const at = f.target();
      const k = f.snap ? 1 : Math.min(1, dt * 3);
      const t = this.controls.target;
      const step = this.tmpStep.set(at.x - t.x, f.height ? at.y - t.y : 0, at.z - t.z).multiplyScalar(k);
      // Within the camera's limits (a rocket climbs far above them): move the camera only as far as the target goes.
      step.y = THREE.MathUtils.clamp(t.y + step.y, -2, 8) - t.y;
      t.add(step);
      this.camera.position.add(step);
      this.camera.zoom += (f.zoom - this.camera.zoom) * (f.snap ? 1 : Math.min(1, dt * 1.5));
      this.camera.updateProjectionMatrix();
      f.snap = false;
    } else if (this.glide) {
      const g = this.glide;
      g.t = Math.min(1, g.t + dt / 1.1);
      const k = g.t < 0.5 ? 4 * g.t ** 3 : 1 - (-2 * g.t + 2) ** 3 / 2;
      const next = g.fromT.clone().lerp(g.target, k);
      this.camera.position.add(next.clone().sub(this.controls.target));
      this.controls.target.copy(next);
      this.camera.zoom = g.fromZ + (g.zoom - g.fromZ) * k;
      this.camera.updateProjectionMatrix();
      if (g.t >= 1) this.glide = null;
    } else if (!this.userZoomed) {
      const { target, zoom } = this.framing();
      const k = Math.min(1, dt * 1.2);
      this.camera.zoom += (zoom - this.camera.zoom) * k;
      this.camera.updateProjectionMatrix();
      const step = target.sub(this.controls.target).multiplyScalar(k);
      this.controls.target.add(step);
      this.camera.position.add(step);
      this.easing = Math.abs(zoom - this.camera.zoom) > 0.003 || step.lengthSq() > 1e-5;
    } else this.easing = false;

    this.controls.update();
    const aspect = this.host.clientWidth / Math.max(1, this.host.clientHeight);
    // Ground visible on screen: the frame's width, and its height stretched by the iso tilt.
    this.city.setView(this.controls.target, Math.hypot(VIEW * aspect, VIEW * 1.75) / this.camera.zoom / 2, DISTANCE, this.camera);
    this.city.update(dt, time);
    this.syncShadows(shot ? shot.scene : this.city.scene);
    if (shot) {
      this.renderer.toneMappingExposure = shot.exposure;
      this.post.setView(shot.scene, shot.camera);
      this.post.update(time, shot.look);
    } else {
      const a = this.city.atmosphere;
      this.renderer.toneMappingExposure = a.exposure;
      this.post.setView(this.city.scene, this.camera);
      // The miniature look is strongest at the overview and fades as you zoom in close.
      const tilt = THREE.MathUtils.clamp(1.25 - this.camera.zoom * 0.28, 0.25, 1);
      const evening = Math.max(0, 1 - Math.abs(a.hour - 18.6) / 1.6);
      this.post.update(time, { bloom: a.bloom, night: a.night, tilt, focusY: 0.47, warmth: evening });
    }
    this.onFrame(dt);

    // Hover picks raycast hundreds of models: ten times a second is plenty, and none while dragging.
    if (this.pointerDirty && !this.dragging && !this.cinema && now - this.lastPick > 100) {
      this.pointerDirty = false;
      this.lastPick = now;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const pick = this.pickAt();
      this.renderer.domElement.style.cursor = pick?.plot ? 'pointer' : '';
      this.onHover(pick?.tip ?? null, this.lastClient.x, this.lastClient.y);
    }

    this.post.render(dt);
  }

  /** What the raycaster (already aimed) hits: a plot, or something with a tooltip. */
  private pickAt(): Pick | null {
    const hit = this.raycaster.intersectObjects(this.city.clickables, true)[0];
    if (!hit) return null;
    // Batched models (homes) keep their tooltips per instance.
    const batch = hit.object.userData.batch as { tipAt(mesh: THREE.Object3D, id: number): unknown } | undefined;
    if (batch && hit.batchId !== undefined) {
      const tip = batch.tipAt(hit.object, hit.batchId) as Tip | undefined;
      return tip ? { tip } : null;
    }
    let o: THREE.Object3D | null = hit.object;
    while (o && !o.userData.tip && !o.userData.plot) o = o.parent;
    return o ? { tip: o.userData.tip as Tip | undefined, plot: o.userData.plot as string | undefined } : null;
  }

  /**
   * Keeps the frame rate smooth for the whole session: steps quality down
   * when frames run long (under ~48 fps), and back up after a long spell of
   * headroom. If it ever steps up and then has to step down again, it stays
   * at the lower level rather than flickering between the two.
   */
  private adapt(raw: number) {
    const p = this.perf;
    if (p.locked || document.hidden || raw > 0.5) return;
    p.frames++;
    p.time += raw;
    if (p.frames < 60) return;
    const avg = p.time / p.frames;
    p.frames = 0;
    p.time = 0;
    const i = QUALITIES.indexOf(this.post.quality);
    if (avg > 1 / 48) {
      p.calm = 0;
      if (i > 0) {
        this.applyQuality(QUALITIES[i - 1]!);
        p.stepsDown++;
        if (p.stepsUp > 0) p.locked = true;
      }
    } else if (avg < 1 / 100 && i < QUALITIES.length - 1 && p.stepsDown > 0) {
      // Roughly ten seconds of easy frames before trying the next level up.
      if (++p.calm >= 10) {
        p.calm = 0;
        p.stepsUp++;
        this.applyQuality(QUALITIES[i + 1]!);
      }
    } else p.calm = 0;
  }

  /** Renders a fresh frame and copies it onto a 2D canvas (for sharing). */
  capture(): HTMLCanvasElement {
    this.post.render(0);
    const src = this.renderer.domElement;
    const out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    out.getContext('2d')!.drawImage(src, 0, 0);
    return out;
  }
}
