import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GeoBuilder, glassMaterial, smoothMaterial, solidMaterial } from '../render/geo.ts';
import { founderHome, itemModel, plane, rocket, yacht } from '../render/models.ts';
import { headquarters } from '../render/towers.ts';
import { PALETTE } from '../render/palette.ts';
import { HQ_FLOOR_CAP, ITEMS } from '../game/catalog.ts';

/**
 * Real 3D thumbnails for the build menu and the home ladder: each model is
 * rendered once, offscreen, from the same isometric angle as the city, in
 * midday light, then cached as a data URL. One small renderer, created on
 * first use, renders one model per frame so opening a menu never stalls.
 *
 * Keys: `item:<item id>` or `home:<home option id>`.
 */

const W = 360;
const H = 240;

let context = { name: 'TinyTown', seed: 1 };
const cache = new Map<string, string | null>();
const waiting = new Map<string, ((url: string | null) => void)[]>();
const queue: string[] = [];
let pumping = false;

/** City name (for the HQ sign) and seed, so thumbnails match your world. */
export function setThumbnailContext(name: string, seed: number) {
  if (name !== context.name) for (const k of [...cache.keys()]) if (k.startsWith('item:hq-')) cache.delete(k);
  context = { name, seed };
}

/** Resolves with a PNG data URL, or null if this device can't render one. */
export function thumbnail(key: string): Promise<string | null> {
  if (cache.has(key)) return Promise.resolve(cache.get(key)!);
  return new Promise((resolve) => {
    const list = waiting.get(key);
    if (list) return list.push(resolve);
    waiting.set(key, [resolve]);
    queue.push(key);
    pump();
  });
}

/** Renders thumbnails in idle time, one at a time, so menus open with pictures ready. */
export function prewarmThumbnails(keys: string[]) {
  const idle = (cb: () => void) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(cb, { timeout: 4000 }) : setTimeout(cb, 200));
  const next = () => {
    const key = keys.shift();
    if (!key) return;
    if (cache.has(key) || waiting.has(key)) return next();
    void thumbnail(key).then(() => idle(next));
  };
  idle(next);
}

let observer: IntersectionObserver | null = null;

/** Fills `img` with the thumbnail once it scrolls into view. */
export function lazyThumbnail(img: HTMLImageElement, key: string) {
  const cached = cache.get(key);
  if (cached) {
    img.src = cached;
    img.closest('.thumb')?.classList.add('ready');
    return;
  }
  img.dataset.thumb = key;
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const target = e.target as HTMLImageElement;
        observer!.unobserve(target);
        const k = target.dataset.thumb!;
        void thumbnail(k).then((url) => {
          const frame = target.closest('.thumb');
          if (url) {
            target.src = url;
            target.decode?.().catch(() => {}).finally(() => frame?.classList.add('ready'));
          } else frame?.classList.add('failed');
        });
      }
    },
    { rootMargin: '120px' },
  );
  observer.observe(img);
}

function pump() {
  if (pumping) return;
  pumping = true;
  const step = () => {
    const start = performance.now();
    // A frame's worth of work at most, then yield to the city.
    while (queue.length && performance.now() - start < 14) {
      const key = queue.shift()!;
      let url: string | null = null;
      try {
        url = studio()?.render(key) ?? null;
      } catch (err) {
        console.warn('thumbnail failed', key, err);
      }
      cache.set(key, url);
      for (const done of waiting.get(key) ?? []) done(url);
      waiting.delete(key);
    }
    if (queue.length) requestAnimationFrame(step);
    else pumping = false;
  };
  requestAnimationFrame(step);
}

// ─── The photo studio ─────────────────────────────────────────────────────

interface Studio {
  render(key: string): string | null;
}

let studioInstance: Studio | null | undefined;

function studio(): Studio | null {
  if (studioInstance !== undefined) return studioInstance;
  try {
    studioInstance = createStudio();
  } catch (err) {
    console.warn('thumbnail studio unavailable', err);
    studioInstance = null;
  }
  return studioInstance;
}

function createStudio(): Studio {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  // Our own copies of the city's shared materials, lit by our environment.
  // Clones carry the city's envMap, which belongs to the other GL context: replace it.
  const solid = solidMaterial.clone();
  solid.envMap = null;
  const glass = glassMaterial.clone();
  glass.envMap = env;
  glass.envMapIntensity = 1.1;
  const smooth = smoothMaterial.clone();
  smooth.envMap = env;
  smooth.envMapIntensity = 0.2;
  const dayGlass = new THREE.MeshStandardMaterial({ color: new THREE.Color(...PALETTE.dayGlass), roughness: 0.18, metalness: 0.45, envMap: env, envMapIntensity: 1.1, flatShading: true });
  const swap = new Map<THREE.Material, THREE.Material>([
    [solidMaterial, solid],
    [glassMaterial, glass],
    [smoothMaterial, smooth],
  ]);

  const scene = new THREE.Scene();
  const hemi = new THREE.HemisphereLight(0xcde6ff, 0x8a9a6e, 1.45);
  const sun = new THREE.DirectionalLight(0xfff3e0, 2.9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 3;
  scene.add(hemi, sun, sun.target);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ opacity: 0.2 }));
  floor.receiveShadow = true;
  scene.add(floor);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -100, 100);
  const view = new THREE.Vector3(1, 1, 1).normalize();
  const sunDir = new THREE.Vector3(-0.45, 1, 0.75).normalize();

  return {
    render(key: string) {
      const group = build(key);
      if (!group) return null;
      group.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const m = o.material as THREE.Material;
        const mine = swap.get(m);
        if (mine) o.material = mine;
        else if (m instanceof THREE.MeshBasicMaterial && m.vertexColors) o.material = dayGlass;
        o.castShadow = true;
        o.receiveShadow = true;
      });
      scene.add(group);
      group.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(group);
      if (box.isEmpty()) {
        scene.remove(group);
        return null;
      }
      const centre = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const radius = Math.max(size.x, size.y, size.z);

      // Camera: the city's isometric angle, framed tight on the model.
      camera.position.copy(centre).addScaledVector(view, 20);
      camera.up.set(0, 1, 0);
      camera.lookAt(centre);
      camera.updateMatrixWorld(true);
      const inv = camera.matrixWorldInverse;
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      const p = new THREE.Vector3();
      for (const x of [box.min.x, box.max.x])
        for (const y of [box.min.y, box.max.y])
          for (const z of [box.min.z, box.max.z]) {
            p.set(x, y, z).applyMatrix4(inv);
            x0 = Math.min(x0, p.x);
            x1 = Math.max(x1, p.x);
            y0 = Math.min(y0, p.y);
            y1 = Math.max(y1, p.y);
          }
      const pad = 1.12;
      let w = (x1 - x0) * pad;
      let h = (y1 - y0) * pad;
      const aspect = W / H;
      if (w / h > aspect) h = w / aspect;
      else w = h * aspect;
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2 - h * 0.01;
      camera.left = cx - w / 2;
      camera.right = cx + w / 2;
      camera.top = cy + h / 2;
      camera.bottom = cy - h / 2;
      camera.near = -radius * 4 - 40;
      camera.far = radius * 4 + 40;
      camera.updateProjectionMatrix();

      // Sun and its shadow box sized to the model; a shadow catcher just below it.
      sun.position.copy(centre).addScaledVector(sunDir, radius * 3 + 4);
      sun.target.position.copy(centre);
      const sc = sun.shadow.camera;
      sc.left = sc.bottom = -radius * 1.2;
      sc.right = sc.top = radius * 1.2;
      sc.near = 0.1;
      sc.far = radius * 8 + 10;
      sc.updateProjectionMatrix();
      floor.position.set(centre.x, box.min.y + 0.002, centre.z);
      floor.scale.setScalar(radius * 4);

      renderer.render(scene, camera);
      const url = canvas.toDataURL('image/png');
      scene.remove(group);
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          const m = o.material as THREE.Material;
          if (m !== solid && m !== glass && m !== smooth && m !== dayGlass) m.dispose();
        }
      });
      return url;
    },
  };
}

function build(key: string): THREE.Group | null {
  const [kind, id] = key.split(':') as [string, string];
  const seed = context.seed;
  if (kind === 'home') {
    if (id === 'moon-house') return moonHouse();
    return founderHome(id, seed).group;
  }
  const item = ITEMS.get(id);
  if (!item) return null;
  if (item.placement.kind === 'hq') {
    const level = item.placement.level;
    return headquarters(context.name, HQ_FLOOR_CAP[level] ?? 8, seed, level).group;
  }
  switch (item.model) {
    case 'prop':
    case 'jet':
    case 'jet-long':
    case 'jet-super':
      return plane(item.model, seed).group;
    case 'yacht':
      return yacht('day', seed).group;
    case 'rocket': {
      const g = rocket(seed).group;
      const pad = new GeoBuilder();
      pad.cylinder(0.62, 0.7, 0.12, 0, -0.12, 0, PALETTE.concrete, 20);
      pad.box(0.08, 3.1, 0.08, 0.5, -0.02, 0, 0xc8402e);
      for (let k = 0; k < 6; k++) pad.box(0.3, 0.025, 0.025, 0.36, 0.3 + k * 0.48, 0, 0xc8402e);
      g.add(pad.build().group);
      return g;
    }
    case 'ferris':
      return ferris();
    case 'coaster':
      return coaster();
    default: {
      const g = itemModel(item.model, 0, 0, seed).group;
      return g.children.length ? g : null;
    }
  }
}

// ─── Studio-only models for things that live inside the scenery ───────────

function pier(b: GeoBuilder, w: number, d: number) {
  b.box(w, 0.08, d, 0, 0, 0, PALETTE.wood);
  for (let i = 0; i < Math.round(w / 0.16); i++) b.box(0.012, 0.004, d, -w / 2 + 0.08 + i * 0.16, 0.08, 0, 0x8a6240);
}

function ferris(): THREE.Group {
  const b = new GeoBuilder();
  pier(b, 2, 1.4);
  const R = 0.85;
  const cy = 1.1;
  const ring = new THREE.TorusGeometry(R, 0.025, 6, 40);
  b.transformed(ring.clone(), new THREE.Matrix4().makeTranslation(0, cy, 0.08), PALETTE.trim);
  b.transformed(ring, new THREE.Matrix4().makeTranslation(0, cy, -0.08), PALETTE.trim);
  const cabins = [0xe5512b, 0xf6b53d, 0x2c6fb7, 0x5fae5a, 0xeab6cf, 0x9cc9ea];
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    const x = Math.cos(a) * R;
    const y = cy + Math.sin(a) * R;
    const spoke = new THREE.CylinderGeometry(0.008, 0.008, R, 4).translate(0, R / 2, 0).rotateZ(a - Math.PI / 2);
    b.transformed(spoke, new THREE.Matrix4().makeTranslation(0, cy, 0), 0xe8e2d6);
    b.rbox(0.13, 0.12, 0.2, x, y - 0.13, 0, cabins[k % cabins.length]!, 0.03);
  }
  for (const s of [-1, 1]) {
    const leg = new THREE.CylinderGeometry(0.03, 0.04, cy * 1.15, 6).rotateZ(s * 0.42);
    b.transformed(leg.clone(), new THREE.Matrix4().makeTranslation(s * 0.24, cy / 2 + 0.06, 0.16), PALETTE.steel);
    b.transformed(leg, new THREE.Matrix4().makeTranslation(s * 0.24, cy / 2 + 0.06, -0.16), PALETTE.steel);
  }
  b.cylinder(0.07, 0.07, 0.4, 0, cy, -0.2, PALETTE.steel, 10, false);
  b.box(0.5, 0.2, 0.3, 0.6, 0.08, 0.45, 0xf8f5ee);
  b.box(0.54, 0.04, 0.34, 0.6, 0.28, 0.45, 0xe5512b);
  return b.build().group;
}

function coaster(): THREE.Group {
  const b = new GeoBuilder();
  pier(b, 2.4, 1.2);
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 80; i++) {
    const t = i / 80;
    const x = -1 + t * 2;
    const loop = Math.exp(-((t - 0.5) ** 2) / 0.012);
    const a = t * Math.PI * 2;
    pts.push(new THREE.Vector3(x - Math.sin(a) * 0.28 * loop, 0.45 + Math.sin(t * Math.PI) * 0.35 + (1 - Math.cos(a)) * 0.38 * loop, Math.sin(t * Math.PI * 2) * 0.25 + 0.15 * loop));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  b.transformed(new THREE.TubeGeometry(curve, 160, 0.035, 6, false), new THREE.Matrix4(), 0xe5512b);
  for (let i = 4; i < 80; i += 8) {
    const p = pts[i]!;
    if (p.y < 0.2) continue;
    b.box(0.03, p.y - 0.08, 0.03, p.x, 0.08, p.z, 0xf0e6d6);
  }
  const car = curve.getPoint(0.14);
  b.rbox(0.22, 0.1, 0.12, car.x, car.y + 0.03, car.z, 0x2c6fb7, 0.03);
  return b.build().group;
}

function moonHouse(): THREE.Group {
  const b = new GeoBuilder();
  const moon = new THREE.SphereGeometry(1.3, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.32).translate(0, -1.3 * Math.cos(Math.PI * 0.32), 0);
  b.transformed(moon, new THREE.Matrix4(), 0xd9d6cf, 'smooth');
  for (const [x, z, r] of [[-0.35, 0.25, 0.12], [0.3, -0.25, 0.09], [0.15, 0.4, 0.06], [-0.2, -0.38, 0.07]] as const) {
    b.cylinder(r, r * 1.15, 0.02, x, 0.36 - (x * x + z * z) * 0.3, z, 0xb8b4ac, 14);
  }
  const dome = new THREE.SphereGeometry(0.32, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  b.transformed(dome, new THREE.Matrix4().makeTranslation(0.05, 0.4, -0.02), 0x9cc9ea, 'glass');
  b.cylinder(0.33, 0.34, 0.06, 0.05, 0.36, -0.02, PALETTE.trim, 20);
  b.rbox(0.22, 0.14, 0.14, 0.38, 0.38, 0.22, PALETTE.trim, 0.04);
  b.box(0.012, 0.32, 0.012, -0.4, 0.33, 0.02, PALETTE.steel);
  b.box(0.16, 0.1, 0.006, -0.32, 0.55, 0.02, 0xe5512b);
  return b.build().group;
}
