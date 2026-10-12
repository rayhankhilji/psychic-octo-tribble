import * as THREE from 'three';
import { rng } from '../world/rng.ts';

/**
 * The moon, rising in the top corner of the frame while the rocket flies to
 * it. It is pinned to the screen rather than the world, like a painted
 * backdrop, so it stays put as the camera pans. Once the founder lives on
 * the moon a tiny lit dome sits on its terminator.
 */
export class Moon {
  readonly object: THREE.Sprite;
  private material: THREE.SpriteMaterial;
  private plain = moonTexture(false);
  private settled = moonTexture(true);
  private ndc = new THREE.Vector3();
  private level = 0;

  constructor() {
    this.material = new THREE.SpriteMaterial({ map: this.plain, transparent: true, depthTest: false, depthWrite: false, fog: false, opacity: 0 });
    this.object = new THREE.Sprite(this.material);
    this.object.renderOrder = 20;
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  /** Show the moon house (the founder has moved to the moon). */
  set home(on: boolean) {
    this.material.map = on ? this.settled : this.plain;
  }

  /** `night` 0–1 from the atmosphere; `force` keeps it up during a rocket flight. */
  update(dt: number, camera: THREE.OrthographicCamera, night: number, force = false) {
    const want = force ? 1 : THREE.MathUtils.smoothstep(night, 0.35, 0.85);
    this.level += (want - this.level) * Math.min(1, dt * 1.5);
    this.object.visible = this.level > 0.01;
    if (!this.object.visible) return;
    this.material.opacity = this.level;
    // Top right of the frame, clear of the HUD's top bar.
    const aspect = (camera.right - camera.left) / (camera.top - camera.bottom);
    this.ndc.set(aspect > 1 ? 0.6 : 0.45, 0.66, 0.2).unproject(camera);
    this.object.position.copy(this.ndc);
    const h = (camera.top - camera.bottom) / camera.zoom;
    this.object.scale.setScalar(h * (aspect > 1 ? 0.16 : 0.12));
    this.material.color.setScalar(1 + 0.6 * this.level);
  }
}

/** A cratered disc with a soft halo, lit from the west so it reads as a waxing gibbous. */
function moonTexture(home: boolean): THREE.Texture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  const cx = S / 2;
  const R = S * 0.24;

  const halo = ctx.createRadialGradient(cx, cx, R * 0.8, cx, cx, S / 2);
  halo.addColorStop(0, 'rgba(255,244,214,0.32)');
  halo.addColorStop(0.35, 'rgba(255,240,210,0.1)');
  halo.addColorStop(1, 'rgba(255,240,210,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, S, S);

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cx, R, 0, Math.PI * 2);
  ctx.clip();
  const body = ctx.createRadialGradient(cx - R * 0.3, cx - R * 0.3, R * 0.1, cx, cx, R);
  body.addColorStop(0, '#fffaf0');
  body.addColorStop(1, '#e9dfc8');
  ctx.fillStyle = body;
  ctx.fillRect(0, 0, S, S);
  // Maria and craters
  const r = rng(1969);
  ctx.fillStyle = 'rgba(150,145,140,0.28)';
  for (const [x, y, s] of [[-0.25, -0.2, 0.32], [0.15, -0.3, 0.22], [0.05, 0.1, 0.28], [-0.35, 0.25, 0.18], [0.3, 0.3, 0.15]] as const) {
    ctx.beginPath();
    ctx.ellipse(cx + x * R, cx + y * R, s * R, s * R * 0.8, r() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 26; i++) {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * R * 0.9;
    const s = 1.5 + r() * 5;
    const x = cx + Math.cos(a) * d;
    const y = cx + Math.sin(a) * d;
    ctx.fillStyle = 'rgba(120,115,110,0.3)';
    ctx.beginPath();
    ctx.arc(x, y, s, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.arc(x - s * 0.3, y - s * 0.3, s * 0.55, 0, Math.PI * 2);
    ctx.fill();
  }
  // Shadowed limb on the east side
  const shade = ctx.createLinearGradient(cx - R, 0, cx + R, 0);
  shade.addColorStop(0, 'rgba(20,30,60,0)');
  shade.addColorStop(0.62, 'rgba(20,30,60,0)');
  shade.addColorStop(1, 'rgba(20,30,60,0.55)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, S, S);
  ctx.restore();

  if (home) {
    // A little glass dome with a warm window, and a glint around it.
    const hx = cx + R * 0.38;
    const hy = cx - R * 0.42;
    const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, 16);
    g.addColorStop(0, 'rgba(255,214,140,0.95)');
    g.addColorStop(1, 'rgba(255,214,140,0)');
    ctx.fillStyle = g;
    ctx.fillRect(hx - 16, hy - 16, 32, 32);
    ctx.fillStyle = '#cfe6ff';
    ctx.beginPath();
    ctx.arc(hx, hy + 1, 5, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = '#ffc561';
    ctx.fillRect(hx - 1.5, hy - 2, 3, 3);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
