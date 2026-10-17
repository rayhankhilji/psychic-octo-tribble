import * as THREE from 'three';
import { GeoBuilder, disposeGroup } from './geo.ts';

const YELLOW = 0xf2b632;
const STEEL = 0x8b95a3;
const NET = 0x3f8a5a;

/**
 * A building site that plays out around a new building: hoarding goes up,
 * a tower crane swings, scaffolding climbs with the floors, dust rolls, and
 * then it all comes down and the finished building is left standing.
 */
export class Construction {
  readonly object = new THREE.Group();
  private target: THREE.Object3D;
  private scaffold: THREE.Group;
  private jib: THREE.Group;
  private crane: THREE.Group;
  private hook: THREE.Mesh;
  private dust: { sprite: THREE.Sprite; v: THREE.Vector3; age: number; life: number }[] = [];
  private dustMat: THREE.SpriteMaterial;
  private size: THREE.Vector3;
  private base: THREE.Vector3;
  private t = 0;
  readonly duration: number;
  private spawn = 0;

  /**
   * `target` must already be in the scene at its final transform. Pass `box`
   * (world space) when the target has no geometry of its own, like a batch proxy.
   */
  constructor(target: THREE.Object3D, duration = 2.6, box?: THREE.Box3) {
    this.target = target;
    this.duration = duration;
    if (!box) {
      target.updateMatrixWorld(true);
      box = new THREE.Box3().setFromObject(target);
    }
    this.size = box.getSize(new THREE.Vector3());
    this.base = box.getCenter(new THREE.Vector3()).setY(box.min.y);
    const w = Math.max(0.6, this.size.x + 0.12);
    const d = Math.max(0.6, this.size.z + 0.12);
    const h = Math.max(0.4, this.size.y);

    // Hoarding and a churned-up site
    const site = new GeoBuilder();
    site.box(w + 0.2, 0.012, d + 0.2, 0, 0, 0, 0x9a7d5a);
    for (const [x, z, sw, sd] of [[0, (d + 0.2) / 2, w + 0.2, 0.02], [0, -(d + 0.2) / 2, w + 0.2, 0.02], [(w + 0.2) / 2, 0, 0.02, d + 0.2], [-(w + 0.2) / 2, 0, 0.02, d + 0.2]] as const) {
      site.box(sw, 0.12, sd, x, 0, z, 0x2f5a46);
    }
    site.box(0.18, 0.1, 0.12, w / 2 - 0.1, 0.012, d / 2 + 0.2, 0xe8e2d6); // site office
    for (let k = 0; k < 3; k++) site.box(0.08, 0.05, 0.08, -w / 2 + 0.1 + k * 0.1, 0.012, -d / 2 - 0.05, [0xc84a3a, 0x2f6fa8, YELLOW][k]!);
    this.object.add(site.build().group);

    // Scaffolding: poles at the corners and along the sides, ledgers every storey, green netting.
    const sc = new GeoBuilder();
    const half = [w / 2 + 0.04, d / 2 + 0.04];
    const poles: [number, number][] = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) poles.push([sx * half[0]!, sz * half[1]!]);
    for (let k = 1; k < Math.max(2, Math.round(w / 0.4)); k++) for (const sz of [-1, 1]) poles.push([-half[0]! + (k * 2 * half[0]!) / Math.max(2, Math.round(w / 0.4)), sz * half[1]!]);
    for (let k = 1; k < Math.max(2, Math.round(d / 0.4)); k++) for (const sx of [-1, 1]) poles.push([sx * half[0]!, -half[1]! + (k * 2 * half[1]!) / Math.max(2, Math.round(d / 0.4))]);
    for (const [x, z] of poles) sc.box(0.012, 1, 0.012, x, 0, z, STEEL);
    const storeys = Math.max(2, Math.round(h / 0.24));
    for (let k = 1; k <= storeys; k++) {
      const y = k / storeys - 0.006;
      sc.box(w + 0.1, 0.008, 0.012, 0, y, half[1]!, STEEL);
      sc.box(w + 0.1, 0.008, 0.012, 0, y, -half[1]!, STEEL);
      sc.box(0.012, 0.008, d + 0.1, half[0]!, y, 0, STEEL);
      sc.box(0.012, 0.008, d + 0.1, -half[0]!, y, 0, STEEL);
    }
    for (const [fw, fd, x, z] of [[w + 0.08, 0.004, 0, half[1]! + 0.01], [0.004, d + 0.08, half[0]! + 0.01, 0]] as const) {
      sc.box(fw, 0.32, fd, x, 0.66, z, NET);
    }
    this.scaffold = sc.build().group;
    this.scaffold.scale.y = 0.001;
    this.object.add(this.scaffold);

    // A tower crane on the back corner, taller than the building.
    const craneH = h + 0.7;
    const cb = new GeoBuilder();
    cb.box(0.22, 0.06, 0.22, 0, 0, 0, 0xb9b5ab);
    for (let y = 0.06; y < craneH; y += 0.16) {
      cb.box(0.1, 0.16, 0.1, 0, y, 0, YELLOW);
      cb.box(0.104, 0.012, 0.104, 0, y, 0, 0xd99a1a);
    }
    this.crane = cb.build().group;
    const jb = new GeoBuilder();
    const reach = Math.max(w, d) * 0.9 + 0.4;
    jb.box(reach, 0.06, 0.06, reach / 2 - 0.15, 0, 0, YELLOW);
    jb.box(0.5, 0.06, 0.06, -0.4, 0, 0, YELLOW);
    jb.box(0.18, 0.14, 0.14, -0.55, -0.12, 0, 0x8a8f99); // counterweight
    jb.box(0.12, 0.12, 0.12, -0.05, -0.12, 0, 0x2a3440); // cab
    jb.cylinder(0.01, 0.03, 0.26, 0, 0.03, 0, YELLOW, 4);
    this.jib = jb.build().group;
    this.jib.position.y = craneH;
    this.crane.add(this.jib);
    this.hook = new THREE.Mesh(new THREE.BoxGeometry(0.006, 1, 0.006).translate(0, -0.5, 0), new THREE.MeshBasicMaterial({ color: 0x333333 }));
    this.hook.position.set(reach * 0.6, -0.02, 0);
    this.jib.add(this.hook);
    const load = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.05, 0.08), new THREE.MeshStandardMaterial({ color: STEEL }));
    load.position.y = -1;
    this.hook.add(load);
    this.crane.position.set(-w / 2 - 0.22, 0, -d / 2 - 0.22);
    this.object.add(this.crane);

    this.dustMat = new THREE.SpriteMaterial({ map: dustTexture(), color: 0xd9c7a8, transparent: true, depthWrite: false, opacity: 0.8 });
    this.object.position.copy(this.base);
    this.object.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    target.scale.y = 0.0001;
  }

  /** Advances the site; returns false once it has been cleared away. */
  update(dt: number): boolean {
    this.t += dt;
    const D = this.duration;
    const u = this.t / D;
    const h = Math.max(0.4, this.size.y);
    // 0–15%: site and crane appear. 15–80%: the building rises inside climbing scaffolding. 80–100%: strike.
    const appear = THREE.MathUtils.smoothstep(u, 0, 0.15);
    this.crane.scale.set(1, Math.max(0.001, appear), 1);
    const rise = THREE.MathUtils.clamp((u - 0.15) / 0.65, 0, 1);
    const eased = 1 - (1 - rise) ** 2.2;
    this.target.scale.y = Math.max(0.0001, eased);
    this.scaffold.scale.y = Math.max(0.001, h * Math.min(1, eased + 0.12));
    this.jib.rotation.y = Math.sin(this.t * 1.3) * 1.1 + this.t * 0.4;
    this.hook.scale.y = 0.4 + 0.3 * Math.sin(this.t * 2.1);
    const strike = THREE.MathUtils.clamp((u - 0.82) / 0.18, 0, 1);
    if (strike > 0) {
      this.scaffold.scale.y = Math.max(0.001, h * (1 - strike));
      this.crane.scale.y = Math.max(0.001, 1 - strike);
    }

    // Dust rolls out from the base while the frame goes up.
    this.spawn -= dt;
    if (u < 0.85 && this.spawn <= 0) {
      this.spawn = 0.07;
      const s = new THREE.Sprite(this.dustMat.clone());
      const a = Math.random() * Math.PI * 2;
      const rr = Math.max(this.size.x, this.size.z) * 0.5;
      s.position.set(Math.cos(a) * rr, 0.08, Math.sin(a) * rr);
      s.scale.setScalar(0.2);
      this.object.add(s);
      this.dust.push({ sprite: s, v: new THREE.Vector3(Math.cos(a) * 0.35, 0.18 + Math.random() * 0.15, Math.sin(a) * 0.35), age: 0, life: 1.1 + Math.random() * 0.5 });
    }
    for (const p of this.dust) {
      p.age += dt;
      p.sprite.position.addScaledVector(p.v, dt);
      p.v.multiplyScalar(1 - dt * 1.5);
      const k = p.age / p.life;
      p.sprite.scale.setScalar(0.2 + k * 0.55);
      (p.sprite.material as THREE.SpriteMaterial).opacity = 0.7 * (1 - k);
    }
    for (const p of this.dust.filter((q) => q.age >= q.life)) {
      this.object.remove(p.sprite);
      p.sprite.material.dispose();
    }
    this.dust = this.dust.filter((q) => q.age < q.life);

    if (u >= 1 && this.dust.length === 0) {
      this.target.scale.y = 1;
      return false;
    }
    if (u >= 1) this.target.scale.y = 1;
    return true;
  }

  /** Jump to the end (e.g. when the world is rebuilt without animation). */
  finish() {
    this.target.scale.y = 1;
  }

  dispose() {
    this.object.removeFromParent();
    this.dustMat.dispose();
    for (const p of this.dust) p.sprite.material.dispose();
    disposeGroup(this.object);
  }
}

let dustTex: THREE.Texture | null = null;
function dustTexture(): THREE.Texture {
  if (dustTex) return dustTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  dustTex = new THREE.CanvasTexture(c);
  dustTex.colorSpace = THREE.SRGBColorSpace;
  return dustTex;
}
