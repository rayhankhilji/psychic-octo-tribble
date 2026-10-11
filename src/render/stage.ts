import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { PALETTE } from './palette.ts';
import type { City, Tip } from './city.ts';
import { PITCH } from '../world/layout.ts';

/** Isometric: looking down 35.26° from the horizontal. */
const ISO_POLAR = Math.acos(1 / Math.sqrt(3));
const VIEW = 26;
const LIMIT = 24;

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

    city.scene.background = skyTexture();

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
    this.camera.position.set(60, 60, 60);
    this.camera.zoom = 2.2;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.minPolarAngle = this.controls.maxPolarAngle = ISO_POLAR;
    this.controls.minZoom = 0.6;
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
    this.controls.target.set(0, 0, 0);
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

  /** Zoom that comfortably frames a city reaching `reach` blocks from HQ. */
  private framingZoom(): number {
    const side = (this.city.reach * 2 + 1) * PITCH + 1;
    const aspect = this.host.clientWidth / Math.max(1, this.host.clientHeight);
    // A square of side s, seen isometrically, is s·√2 wide and s·√2·sin(35.26°) tall.
    const fitWidth = (VIEW * aspect) / (side * Math.SQRT2 * 1.08);
    const fitHeight = VIEW / (side * 0.8165 * 1.25 + 5);
    return THREE.MathUtils.clamp(Math.min(fitWidth, fitHeight), 0.7, 3.2);
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
    }

    this.controls.update();
    this.city.update(dt, time);
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

function skyTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 1024;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, c.height);
  g.addColorStop(0, PALETTE.skyTop);
  g.addColorStop(0.55, PALETTE.skyMid);
  g.addColorStop(1, PALETTE.skyHorizon);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.width, c.height);

  // Stars, denser toward the top
  let seed = 3;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 700; i++) {
    const y = r() ** 1.6 * c.height * 0.85;
    const a = 0.25 + r() * 0.75 * (1 - y / c.height);
    ctx.fillStyle = `rgba(255,255,255,${a.toFixed(2)})`;
    const s = r() < 0.08 ? 2 : 1;
    ctx.fillRect(r() * c.width, y, s, s);
  }

  // Moon with a soft halo, upper left (where the moonlight comes from)
  const mx = c.width * 0.16;
  const my = c.height * 0.14;
  const halo = ctx.createRadialGradient(mx, my, 0, mx, my, 140);
  halo.addColorStop(0, 'rgba(200,215,255,0.35)');
  halo.addColorStop(1, 'rgba(200,215,255,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(mx - 140, my - 140, 280, 280);
  ctx.fillStyle = '#f2f0e6';
  ctx.beginPath();
  ctx.arc(mx, my, 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(160,170,200,0.25)';
  for (const [dx, dy, rr] of [[-8, -6, 6], [9, 7, 4], [3, -12, 3]]) {
    ctx.beginPath();
    ctx.arc(mx + dx!, my + dy!, rr!, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
