import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { City, Tip } from './city.ts';
import { PITCH } from '../world/layout.ts';

/** Isometric: looking down 35.26° from the horizontal. */
const ISO_POLAR = Math.acos(1 / Math.sqrt(3));
const VIEW = 26;
const LIMIT = 40;

/**
 * Renderer, camera and input. Orthographic isometric camera; drag to pan,
 * right-drag or Q/E to rotate, scroll or pinch to zoom.
 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.OrthographicCamera;
  readonly controls: OrbitControls;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private timer = new THREE.Timer();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2(2, 2);
  private pointerDirty = false;
  private userZoomed = false;
  private spin: { from: number; to: number; t: number } | null = null;
  onHover: (tip: Tip | null, x: number, y: number) => void = () => {};
  onFrame: (dt: number) => void = () => {};
  private lastClient = { x: 0, y: 0 };
  private host: HTMLElement;
  private city: City;

  constructor(host: HTMLElement, city: City) {
    this.host = host;
    this.city = city;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    host.appendChild(this.renderer.domElement);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
    this.camera.position.set(60, 60, 60);
    this.camera.zoom = 2.2;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.minPolarAngle = this.controls.maxPolarAngle = ISO_POLAR;
    this.controls.minZoom = 0.4;
    this.controls.maxZoom = 8;
    this.controls.zoomToCursor = true;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    this.controls.addEventListener('start', () => (this.userZoomed = true));
    this.controls.addEventListener('change', () => this.clampTarget());

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(city.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.85, 0.55, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    const el = this.renderer.domElement;
    el.addEventListener('pointermove', (e) => {
      const rect = el.getBoundingClientRect();
      this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      this.lastClient = { x: e.clientX, y: e.clientY };
      this.pointerDirty = true;
    });
    el.addEventListener('pointerleave', () => {
      this.pointer.set(2, 2);
      this.onHover(null, 0, 0);
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'q' || e.key === 'Q') this.rotate(-1);
      if (e.key === 'e' || e.key === 'E') this.rotate(1);
    });

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  /** Quarter turn around the current focus. */
  rotate(dir: 1 | -1) {
    const from = this.controls.getAzimuthalAngle();
    const quarter = Math.PI / 2;
    const to = Math.round((from + dir * quarter - Math.PI / 4) / quarter) * quarter + Math.PI / 4;
    this.spin = { from, to, t: 0 };
  }

  /** Back to the overview that frames the whole developed city. */
  resetView() {
    this.userZoomed = false;
    this.controls.target.copy(this.framingTarget());
    const d = this.camera.position.clone().sub(this.controls.target).length();
    const az = Math.PI / 4;
    this.camera.position.set(Math.sin(az) * Math.sin(ISO_POLAR) * d, Math.cos(ISO_POLAR) * d, Math.cos(az) * Math.sin(ISO_POLAR) * d);
  }

  private clampTarget() {
    const t = this.controls.target;
    t.x = THREE.MathUtils.clamp(t.x, -LIMIT, LIMIT);
    t.z = THREE.MathUtils.clamp(t.z, -LIMIT, LIMIT);
    t.y = THREE.MathUtils.clamp(t.y, -2, 6);
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
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
  }

  /** Zoom that frames the developed city plus some coast and hills around it. */
  private framingZoom(): number {
    const reach = this.city.reach;
    const side = (reach * 2 + 1) * PITCH + 5 + reach * 4.5;
    const aspect = this.host.clientWidth / Math.max(1, this.host.clientHeight);
    // A square of side s, seen isometrically, is s·√2 wide and s·√2·sin(35.26°) tall.
    const fitWidth = (VIEW * aspect) / (side * Math.SQRT2 * 1.02);
    const fitHeight = VIEW / (side * 0.8165 * 1.1 + 4);
    return THREE.MathUtils.clamp(Math.min(fitWidth, fitHeight), 0.45, 3.2);
  }

  /** Where the overview looks: drifts toward the hills as the city grows so the sign stays in shot. */
  private framingTarget(): THREE.Vector3 {
    const k = Math.min(1, (this.city.reach - 1) / 2);
    return new THREE.Vector3(-3.5 * k, 0, -7.5 * k);
  }

  start() {
    this.camera.zoom = this.framingZoom();
    this.camera.updateProjectionMatrix();
    this.timer.connect(document);
    this.renderer.setAnimationLoop((now) => this.frame(now));
  }

  private frame(now: number) {
    this.timer.update(now);
    const dt = Math.min(0.05, this.timer.getDelta());
    const time = this.timer.getElapsed();

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

    if (!this.userZoomed) {
      const target = this.framingZoom();
      this.camera.zoom += (target - this.camera.zoom) * Math.min(1, dt * 1.5);
      this.camera.updateProjectionMatrix();
      const focus = this.framingTarget();
      const step = focus.sub(this.controls.target).multiplyScalar(Math.min(1, dt * 1.5));
      this.controls.target.add(step);
      this.camera.position.add(step);
    }

    this.controls.update();
    this.city.update(dt, time);
    const a = this.city.atmosphere;
    this.bloom.strength = a.bloom;
    this.bloom.threshold = 0.92 + (1 - a.night) * 0.25;
    this.renderer.toneMappingExposure = a.exposure;
    this.onFrame(dt);

    if (this.pointerDirty) {
      this.pointerDirty = false;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const hit = this.raycaster.intersectObjects(this.city.pickables, true)[0];
      let o: THREE.Object3D | null = hit?.object ?? null;
      while (o && !o.userData.tip) o = o.parent;
      this.onHover((o?.userData.tip as Tip) ?? null, this.lastClient.x, this.lastClient.y);
    }

    this.composer.render(dt);
  }

  /** Renders a fresh frame and copies it onto a 2D canvas (for sharing). */
  capture(): HTMLCanvasElement {
    this.composer.render(0);
    const src = this.renderer.domElement;
    const out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    out.getContext('2d')!.drawImage(src, 0, 0);
    return out;
  }
}
