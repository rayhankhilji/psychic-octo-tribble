import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { City, Pick, Tip } from './city.ts';
import { Post, type Quality } from './post.ts';
import { setEnvironment } from './geo.ts';
import { WORLD } from '../world/map.ts';

/** Isometric: looking down 35.26° from the horizontal. */
const ISO_POLAR = Math.acos(1 / Math.sqrt(3));
const VIEW = 26;
const LIMIT = { x0: WORLD.x0 - 8, x1: WORLD.x1 + 16, z0: WORLD.z0 - 16, z1: WORLD.z1 + 8 };
const QUALITIES: Quality[] = ['low', 'medium', 'high'];
/** How far the camera sits from what it looks at. Far enough that nothing is ever behind the near plane. */
const DISTANCE = 240;

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
      this.userZoomed = true;
      this.glide = null;
      this.dragging = true;
      this.wake();
    });
    this.controls.addEventListener('end', () => (this.dragging = false));
    this.controls.addEventListener('change', () => this.clampTarget());

    const forced = requestedQuality();
    const quality: Quality = forced ?? (matchMedia('(pointer: coarse)').matches ? 'medium' : 'high');
    this.perf = { frames: 0, time: 0, locked: forced !== null, calm: 0, stepsDown: 0, stepsUp: 0 };
    this.post = new Post(this.renderer, city.scene, this.camera, quality);
    this.applyQuality(quality);

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
      this.down = { x: e.clientX, y: e.clientY };
      this.wake();
    });
    el.addEventListener('wheel', () => this.wake(), { passive: true });
    el.addEventListener('pointerup', (e) => {
      const d = this.down;
      this.down = null;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || e.button !== 0) return;
      const rect = el.getBoundingClientRect();
      const p = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      this.raycaster.setFromCamera(p, this.camera);
      this.onPick(this.pickAt());
    });
    window.addEventListener('keydown', (e) => {
      this.wake();
      if (e.target instanceof HTMLInputElement) return;
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
  }

  /** Quarter turn around the current focus. */
  rotate(dir: 1 | -1) {
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
    this.userZoomed = true;
    this.glide = { target: target.clone(), zoom, t: 0, fromT: this.controls.target.clone(), fromZ: this.camera.zoom };
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
    const aspect = w / Math.max(1, this.host.clientHeight);
    // On wide screens the stats panels cover the left edge: frame the city in what's left.
    const inset = w > 900 ? Math.min(320, w * 0.24) : 0;
    const usable = (w - inset) / w;
    // The HUD covers roughly the top 12% and the dock the bottom 14%: centre a little high.
    const zoom = THREE.MathUtils.clamp(Math.min((VIEW * aspect * usable) / ((r1 - r0) * 1.04), VIEW / ((u1 - u0) * 1.3)), this.controls.minZoom, 3.2);
    const visibleH = VIEW / zoom;
    const visibleW = (VIEW * aspect) / zoom;
    const target = c
      .clone()
      .addScaledVector(right, (r0 + r1) / 2 - (visibleW * inset) / w / 2)
      .addScaledVector(up, (u0 + u1) / 2 - visibleH * 0.03);
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
    const calm = !this.active && !this.spin && !this.glide && !this.easing && !this.city.lively && now - this.lastInput > 4000;
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

    if (this.glide) {
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
    const a = this.city.atmosphere;
    this.renderer.toneMappingExposure = a.exposure;
    // The miniature look is strongest at the overview and fades as you zoom in close.
    const tilt = THREE.MathUtils.clamp(1.25 - this.camera.zoom * 0.28, 0.25, 1);
    const evening = Math.max(0, 1 - Math.abs(a.hour - 18.6) / 1.6);
    this.post.update(time, { bloom: a.bloom, night: a.night, tilt, focusY: 0.47, warmth: evening });
    this.onFrame(dt);

    // Hover picks raycast hundreds of models: ten times a second is plenty, and none while dragging.
    if (this.pointerDirty && !this.dragging && now - this.lastPick > 100) {
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
