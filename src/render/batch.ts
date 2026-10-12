import * as THREE from 'three';
import { glassMaterial, glowMaterial, smoothMaterial, solidMaterial } from './geo.ts';
import type { Built } from './buildings.ts';

type Bucket = 'solid' | 'glass' | 'smooth' | 'glow';
const BUCKETS: Bucket[] = ['solid', 'glass', 'smooth', 'glow'];

interface Entry {
  /** Geometry and instance id per bucket the model uses. */
  ids: Partial<Record<Bucket, { geometry: number; instance: number }>>;
  /** Drives the instance transform: animate its position/rotation/scale, then call `sync`. */
  proxy: THREE.Object3D;
  tip: unknown;
  glow: number;
}

/**
 * Draws many small models (the homes) in a handful of draw calls. Each model
 * built by GeoBuilder is split by material into one BatchedMesh per bucket,
 * with its own transform (for pop-in animations), its own light level (glow
 * fades) and its own tooltip.
 */
export class Batch {
  readonly object = new THREE.Group();
  private meshes = {} as Record<Bucket, THREE.BatchedMesh>;
  private entries = new Map<string, Entry>();
  /** instance id → key, per bucket, for picking. */
  private byInstance = {} as Record<Bucket, Map<number, string>>;
  private dirty = new Set<Entry>();
  private white = new THREE.Color(1, 1, 1);
  private tmp = new THREE.Color();
  /** Vertex capacity per mesh (BatchedMesh doesn't expose it). */
  private capacity = new Map<THREE.BatchedMesh, number>();

  constructor(instances = 512, vertices = 400_000) {
    const glow = glowMaterial();
    const mats: Record<Bucket, THREE.Material> = { solid: solidMaterial, glass: glassMaterial, smooth: smoothMaterial, glow };
    for (const b of BUCKETS) {
      const size = b === 'glow' ? vertices / 4 : vertices;
      const m = new THREE.BatchedMesh(instances, size, size, mats[b]);
      this.capacity.set(m, size);
      m.castShadow = b !== 'glow';
      m.receiveShadow = b !== 'glow';
      m.sortObjects = false;
      // Instances come and go all over the map: cull each one, never the batch as a whole.
      m.frustumCulled = false;
      m.perObjectFrustumCulled = true;
      m.userData.batch = this;
      m.userData.bucket = b;
      this.meshes[b] = m;
      this.byInstance[b] = new Map();
      this.object.add(m);
    }
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

  /** Adds a built model; its group's transform is the initial transform. The group is disposed. */
  add(key: string, built: Built, tip: unknown): THREE.Object3D {
    this.remove(key);
    const g = built.group;
    g.updateMatrix();
    const entry: Entry = { ids: {}, proxy: new THREE.Object3D(), tip, glow: 1 };
    entry.proxy.position.copy(g.position);
    entry.proxy.quaternion.copy(g.quaternion);
    entry.proxy.scale.copy(g.scale);
    for (const child of g.children) {
      if (!(child instanceof THREE.Mesh)) continue;
      const bucket: Bucket =
        child.material === solidMaterial ? 'solid' : child.material === glassMaterial ? 'glass' : child.material === smoothMaterial ? 'smooth' : 'glow';
      const mesh = this.meshes[bucket];
      const geo = child.geometry as THREE.BufferGeometry;
      if (child.matrix && !child.matrix.equals(new THREE.Matrix4())) geo.applyMatrix4(child.matrix);
      this.reserve(mesh, geo.attributes.position!.count);
      const geometry = mesh.addGeometry(geo);
      const instance = mesh.addInstance(geometry);
      entry.ids[bucket] = { geometry, instance };
      this.byInstance[bucket].set(instance, key);
      if (bucket === 'glow') mesh.setColorAt(instance, this.white);
      geo.dispose();
      if (bucket === 'glow') (child.material as THREE.Material).dispose();
    }
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

  remove(key: string) {
    const e = this.entries.get(key);
    if (!e) return;
    for (const b of BUCKETS) {
      const id = e.ids[b];
      if (!id) continue;
      this.meshes[b].deleteInstance(id.instance);
      this.meshes[b].deleteGeometry(id.geometry);
      this.byInstance[b].delete(id.instance);
    }
    this.dirty.delete(e);
    this.entries.delete(key);
  }

  proxy(key: string): THREE.Object3D | undefined {
    return this.entries.get(key)?.proxy;
  }

  setTip(key: string, tip: unknown) {
    const e = this.entries.get(key);
    if (e) e.tip = tip;
  }

  /** Window light level for one model (0 = dark, 1 = normal). */
  setGlow(key: string, level: number) {
    const e = this.entries.get(key);
    const id = e?.ids.glow;
    if (!e || !id) return;
    e.glow = level;
    this.meshes.glow.setColorAt(id.instance, this.tmp.setScalar(level));
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
      if (id) this.meshes[b].setMatrixAt(id.instance, e.proxy.matrix);
    }
  }

  /** Writes changed transforms; call once per frame. */
  update() {
    for (const e of this.dirty) this.sync(e);
    this.dirty.clear();
  }
}
