import * as THREE from 'three';
import { disposeGroup, glassMaterial, glowMaterial, smoothMaterial, solidMaterial } from './geo.ts';
import { neonMaterial, screenMaterial, windowMaterial } from './towers.ts';
import type { Built } from './buildings.ts';

/** The shared buckets, plus the lit layers (glow, Kit windows, neon, LED screens). */
type Bucket = 'solid' | 'glass' | 'smooth' | 'glow' | 'win' | 'neon' | 'screen';
const BUCKETS: Bucket[] = ['solid', 'glass', 'smooth', 'glow', 'win', 'neon', 'screen'];
const LIT: Bucket[] = ['glow', 'win', 'neon', 'screen'];
/** Lit materials are recognised by their shader's cache key. */
const LIT_KEYS: Record<string, Bucket> = { 'tinytown-glow-3': 'glow', 'tinytown-win-1': 'win', 'tinytown-neon-1': 'neon', 'tinytown-screen-1': 'screen' };

interface Entry {
  /** Geometry and instance id per bucket the model uses. */
  ids: Partial<Record<Bucket, { geometry: number; instance: number }>>;
  /** Drives the instance transform: animate its position/rotation/scale, then call `touch`. */
  proxy: THREE.Object3D;
  tip: unknown;
  glow: number;
}

/** Which bucket a mesh can join, or null if it has to stay a mesh of its own. */
function bucketOf(mesh: THREE.Mesh): Bucket | null {
  const m = mesh.material;
  if (m === solidMaterial) return 'solid';
  if (m === glassMaterial) return 'glass';
  if (m === smoothMaterial) return 'smooth';
  // Lit layers merge when they are the stock material: vertex colours, opaque, colour still white.
  if (!(m instanceof THREE.MeshBasicMaterial) || !m.vertexColors || m.transparent || m.map) return null;
  const bucket = LIT_KEYS[m.customProgramCacheKey()];
  if (!bucket || m.color.r !== 1 || m.color.g !== 1 || m.color.b !== 1) return null;
  return bucket;
}

const IDENTITY = new THREE.Matrix4();

/**
 * Draws many GeoBuilder models (homes, grounds, boats) in a handful of draw
 * calls. Each model is split by material into one BatchedMesh per bucket,
 * with its own transform (for pop-in animations), its own light level (glow
 * fades) and its own tooltip.
 *
 * Anything that can't be merged (custom materials, sprites, lines) stays a
 * real object, moved onto the model's proxy: add the proxy to the scene for
 * those parts to show and follow it.
 */
export class Batch {
  readonly object = new THREE.Group();
  private meshes: Partial<Record<Bucket, THREE.BatchedMesh>> = {};
  private entries = new Map<string, Entry>();
  /** instance id → key, per bucket, for picking. */
  private byInstance = {} as Record<Bucket, Map<number, string>>;
  private dirty = new Set<Entry>();
  private white = new THREE.Color(1, 1, 1);
  private tmp = new THREE.Color();
  /** Vertex capacity per mesh (BatchedMesh doesn't expose it). */
  private capacity = new Map<THREE.BatchedMesh, number>();
  private instances: number;
  private vertices: number;

  constructor(instances = 512, vertices = 400_000) {
    this.instances = instances;
    this.vertices = vertices;
    for (const b of BUCKETS) this.byInstance[b] = new Map();
  }

  /** The bucket's mesh, made the first time a model needs it. */
  private mesh(b: Bucket): THREE.BatchedMesh {
    const have = this.meshes[b];
    if (have) return have;
    const lit = LIT.includes(b);
    const material =
      b === 'solid' ? solidMaterial
      : b === 'glass' ? glassMaterial
      : b === 'smooth' ? smoothMaterial
      : b === 'win' ? windowMaterial()
      : b === 'neon' ? neonMaterial()
      : b === 'screen' ? screenMaterial()
      : glowMaterial();
    const size = lit ? this.vertices / 4 : this.vertices;
    const m = new THREE.BatchedMesh(this.instances, size, size, material);
    this.capacity.set(m, size);
    m.castShadow = !lit;
    m.receiveShadow = !lit;
    m.sortObjects = false;
    // Instances come and go all over the map: cull each one, never the batch as a whole.
    m.frustumCulled = false;
    m.perObjectFrustumCulled = true;
    m.userData.batch = this;
    m.userData.bucket = b;
    this.meshes[b] = m;
    this.object.add(m);
    return m;
  }

  /** The tooltip for a raycast hit on one of the batch meshes. */
  tipAt(mesh: THREE.Object3D, batchId: number): unknown {
    const key = this.byInstance[mesh.userData.bucket as Bucket]?.get(batchId);
    return key ? this.entries.get(key)?.tip : undefined;
  }

  has(key: string) {
    return this.entries.has(key);
  }

  keys() {
    return this.entries.keys();
  }

  /**
   * Adds a built model; its group's transform is the initial transform. The
   * group's mergeable meshes are disposed; anything else moves to the proxy.
   */
  add(key: string, built: Built, tip: unknown): THREE.Object3D {
    this.remove(key);
    const g = built.group;
    const entry: Entry = { ids: {}, proxy: new THREE.Object3D(), tip, glow: 1 };
    // Parts that ride on the proxy find their tooltip on it.
    entry.proxy.userData.tip = tip ?? undefined;
    entry.proxy.position.copy(g.position);
    entry.proxy.quaternion.copy(g.quaternion);
    entry.proxy.scale.copy(g.scale);
    // Bake each mesh's transform relative to the model, at any depth.
    g.position.set(0, 0, 0);
    g.quaternion.identity();
    g.scale.set(1, 1, 1);
    g.updateMatrixWorld(true);
    const merged: [THREE.Mesh, Bucket][] = [];
    g.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || !child.visible || child instanceof THREE.InstancedMesh) return;
      const bucket = bucketOf(child);
      // One geometry per bucket per model: a second mesh in the same bucket stays a mesh.
      if (!bucket || merged.some(([, b]) => b === bucket)) return;
      merged.push([child, bucket]);
    });
    for (const [child, bucket] of merged) {
      const mesh = this.mesh(bucket);
      const geo = child.geometry as THREE.BufferGeometry;
      if (!child.matrixWorld.equals(IDENTITY)) geo.applyMatrix4(child.matrixWorld);
      this.reserve(mesh, geo.attributes.position!.count);
      const geometry = mesh.addGeometry(geo);
      const instance = mesh.addInstance(geometry);
      entry.ids[bucket] = { geometry, instance };
      this.byInstance[bucket].set(instance, key);
      if (LIT.includes(bucket)) {
        mesh.setColorAt(instance, this.white);
        (child.material as THREE.Material).dispose();
      }
      geo.dispose();
      child.removeFromParent();
    }
    // Whatever couldn't merge rides along on the proxy.
    for (const rest of [...g.children]) entry.proxy.add(rest);
    this.entries.set(key, entry);
    this.sync(entry);
    return entry.proxy;
  }

  /** Make room for `count` more vertices (compacting first, then growing). */
  private reserve(mesh: THREE.BatchedMesh, count: number) {
    if (mesh.unusedVertexCount >= count && mesh.instanceCount < mesh.maxInstanceCount) return;
    mesh.optimize();
    if (mesh.unusedVertexCount < count) {
      const cap = this.capacity.get(mesh)!;
      const size = Math.max(cap * 2, cap - mesh.unusedVertexCount + count * 4);
      mesh.setGeometrySize(size, size);
      this.capacity.set(mesh, size);
    }
    if (mesh.instanceCount >= mesh.maxInstanceCount) mesh.setInstanceCount(mesh.maxInstanceCount * 2);
  }

  /** Removes a model, and disposes whatever rode along on its proxy. */
  remove(key: string) {
    const e = this.entries.get(key);
    if (!e) return;
    for (const b of BUCKETS) {
      const id = e.ids[b];
      if (!id) continue;
      this.meshes[b]!.deleteInstance(id.instance);
      this.meshes[b]!.deleteGeometry(id.geometry);
      this.byInstance[b].delete(id.instance);
    }
    for (const rest of [...e.proxy.children]) {
      e.proxy.remove(rest);
      disposeGroup(rest);
    }
    e.proxy.removeFromParent();
    this.dirty.delete(e);
    this.entries.delete(key);
  }

  proxy(key: string): THREE.Object3D | undefined {
    return this.entries.get(key)?.proxy;
  }

  setTip(key: string, tip: unknown) {
    const e = this.entries.get(key);
    if (!e) return;
    e.tip = tip;
    e.proxy.userData.tip = tip ?? undefined;
  }

  /** Light level for one model's windows, neon and screens (0 = dark, 1 = normal). */
  setGlow(key: string, level: number) {
    const e = this.entries.get(key);
    if (!e) return;
    e.glow = level;
    this.tmp.setScalar(level);
    for (const b of LIT) {
      const id = e.ids[b];
      if (id) this.meshes[b]!.setColorAt(id.instance, this.tmp);
    }
  }

  /** Show or hide one model (and whatever rides on its proxy). */
  setVisible(key: string, visible: boolean) {
    const e = this.entries.get(key);
    if (!e) return;
    for (const b of BUCKETS) {
      const id = e.ids[b];
      if (id) this.meshes[b]!.setVisibleAt(id.instance, visible);
    }
    e.proxy.visible = visible;
  }

  /** Mark a model's proxy transform as changed. */
  touch(key: string) {
    const e = this.entries.get(key);
    if (e) this.dirty.add(e);
  }

  private sync(e: Entry) {
    e.proxy.updateMatrix();
    for (const b of BUCKETS) {
      const id = e.ids[b];
      if (id) this.meshes[b]!.setMatrixAt(id.instance, e.proxy.matrix);
    }
  }

  /** Writes changed transforms; call once per frame. */
  update() {
    for (const e of this.dirty) this.sync(e);
    this.dirty.clear();
  }
}
