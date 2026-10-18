import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { disposeGroup, GeoBuilder, type ColorLike } from './geo.ts';
import { Kit, people, quadBlob } from './towers.ts';
import { blockCentre, CIVIC_BLOCK, LANDMARKS, terrainHeight } from '../world/map.ts';
import { pick, rng } from '../world/rng.ts';
import { drawMark } from '../ui/brand.ts';
import { prefersReducedMotion } from '../ui/dom.ts';
import type { City } from './city.ts';
import type { Cinematic, Shot, Stage } from './stage.ts';

/**
 * The grand opening: the first time a founder's own city opens with their
 * real numbers, Civic Center Plaza holds a ribbon cutting. A stage with a
 * podium in front of a banner with the city's name, bunting between the
 * plane trees, a crowd on the lawns and a Golden Gate–orange ribbon. The
 * camera glides down to it, the ribbon is cut, confetti flies, the TINYTOWN
 * sign switches on and fireworks go up, then the camera eases back to the
 * city. About 16 seconds, skippable, and everything is taken down after.
 *
 * `CeremonySet` is the set on the plaza; `Ceremony` is the sequence, a
 * `Cinematic` that stays in the main scene and steers the usual camera.
 */

/** When things happen, in seconds from the start. */
export const BEATS = {
  /** The camera has arrived over the plaza. */
  arrive: 3.4,
  /** The title card comes up. */
  card: 2.6,
  /** Snip. */
  cut: 8.6,
  /** Fireworks from behind the stage. */
  volley: 9.7,
  /** The camera starts to pull back toward the sign. */
  pull: 9.4,
  /** The camera has the plaza and the sign in one frame. */
  wide: 12.0,
  /** The TINYTOWN sign switches on. */
  sign: 10.7,
  /** The title card goes (phones: earlier, it covers the bottom of the frame). */
  cardOut: 12.2,
  cardOutNarrow: 10.3,
  /** Fireworks over the bay, for the way home. */
  bay: 12.8,
  /** The camera starts home. */
  leave: 12.6,
  /** The bars go and the HUD comes back. */
  bars: 15.0,
  /** Home, and done. */
  end: 15.8,
} as const;

/** Reduced motion: a fade to the plaza after the cut, the card over a still, a fade back. */
const STILL = { fade: 0.35, hold: 4.6 } as const;

const GATE: ColorLike = 0xe5512b;
const GOLD: ColorLike = 0xd4af37;
const INK: ColorLike = 0x1b2236;
const CREAM: ColorLike = 0xf6eedf;
const BUNTING = [0xe5512b, 0xf6b53d, 0x2c6fb7, 0xf6eedf, 0x2f8f5b] as const;
const CONFETTI = [0xe5512b, 0xf6b53d, 0x2c6fb7, 0xf6eedf, 0x2f8f5b, 0xff8a5c, 0xd4af37] as const;
const BULB: ColorLike = [2.6, 1.9, 1.0];

/**
 * Where everything stands on the plaza, read from the civic block when it's
 * asked for (the block moves with the world seed). Plaza layout from
 * `cityHall()` in landmarks.ts: lawns either side of the fountain, plane
 * trees in two rows along x = px ± 0.68, flagpoles to the east.
 */
export function plazaLayout() {
  const c = blockCentre(CIVIC_BLOCK);
  const px = c.x + 1.05;
  const z = c.z;
  return {
    px,
    z,
    /** The stage on the south lawn, facing north across the plaza. */
    stage: { x: px + 0.05, z: z - 1.31, w: 0.78, d: 0.3, h: 0.055 },
    /** The banner behind it, between the tree rows. */
    banner: { x: px + 0.05, z: z - 1.5, w: 0.98, h: 0.3, y: 0.14 },
    /** The ribbon across the plaza in front of the stage, post to post. */
    ribbon: { x0: px - 0.45, x1: px + 0.55, z: z - 1.06, y: 0.05 },
    /** What the camera looks at over the plaza. */
    subject: new THREE.Vector3(px + 0.05, 0.1, z - 0.95),
  };
}

// ─── The set ──────────────────────────────────────────────────────────────

/** A tidy crowd: people on the lawns and the walks, clear of the fountain, the trees and the stage. */
function crowd(b: GeoBuilder, r: () => number, px: number, z: number) {
  const ok = (x: number, pz: number) => Math.hypot(x - (px + 0.05), pz - z) > 0.32 && Math.abs(Math.abs(x - px) - 0.68) > 0.1;
  let placed = 0;
  for (let i = 0; placed < 84 && i < 600; i++) {
    const x = px - 0.58 + r() * 1.2;
    const pz = z - 0.94 + r() ** 1.35 * 2.5;
    if (!ok(x, pz)) continue;
    people(b, r, x, pz, 1, 0, 0, 0.02);
    placed++;
  }
  // The front row, pressed up to the ribbon.
  for (let i = 0; i < 16; i++) people(b, r, px - 0.42 + i * 0.062 + (r() - 0.5) * 0.02, z - 0.97 + (r() - 0.5) * 0.03, 1, 0, 0, 0.02);
}

/** Pennant strings and bulbs across the plaza, tree to tree, sagging a little. */
function bunting(b: GeoBuilder, r: () => number, px: number, z: number) {
  const tri = (x: number, y: number, pz: number, w: number, h: number, color: ColorLike) => {
    const g = new THREE.BufferGeometry();
    // Both windings, so it reads from either side of the string.
    g.setAttribute('position', new THREE.Float32BufferAttribute([x - w / 2, y, pz, x + w / 2, y, pz, x, y - h, pz, x + w / 2, y, pz, x - w / 2, y, pz, x, y - h, pz], 3));
    g.computeVertexNormals();
    b.transformed(g, new THREE.Matrix4(), color);
  };
  for (let s = 1; s < 7; s++) {
    const sz = z - 1.55 + s * 0.52;
    const n = 14;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = px - 0.68 + t * 1.36;
      const y = 0.36 - 0.07 * Math.sin(Math.PI * t);
      if (i < n) {
        // The string itself, a hair of dark cord.
        const t1 = (i + 1) / n;
        const y1 = 0.36 - 0.07 * Math.sin(Math.PI * t1);
        const len = Math.hypot(1.36 / n, y1 - y);
        const g = new THREE.BoxGeometry(len, 0.003, 0.003);
        g.rotateZ(Math.atan2(y1 - y, 1.36 / n));
        g.translate(x + 0.68 / n, (y + y1) / 2, sz);
        b.transformed(g, new THREE.Matrix4(), 0x3a3f4a);
        tri(x + 0.68 / n, (y + y1) / 2 - 0.002, sz, 0.036, 0.042, pick(r, BUNTING));
      }
      if (i % 2 === 0) quadBlob(b, x, y - 0.006, sz, 0.007, BULB, ((i + s) % 5) / 6);
    }
  }
}

/** The stage: a low platform with a navy skirt, a podium, two speaker stacks, lamps, and the people giving speeches. */
function stage(b: GeoBuilder, r: () => number, s: ReturnType<typeof plazaLayout>['stage']) {
  const y0 = 0.02;
  b.box(s.w, s.h, s.d, s.x, y0, s.z, 0x283049);
  b.box(s.w + 0.01, 0.008, s.d + 0.01, s.x, y0 + s.h, s.z, 0xe9d9bb);
  // A cream trim along the front, and three steps up the middle.
  b.box(s.w + 0.004, 0.006, 0.004, s.x, y0 + s.h - 0.014, s.z + s.d / 2, CREAM);
  for (let k = 0; k < 3; k++) b.box(0.16, 0.018 * (k + 1), 0.022, s.x - 0.22, y0, s.z + s.d / 2 + 0.055 - k * 0.022, 0x3a4157);
  // The podium, front and centre, with the mark's sun on its face.
  const top = y0 + s.h + 0.008;
  const pz = s.z + s.d / 2 - 0.06;
  b.box(0.07, 0.07, 0.045, s.x, top, pz, INK);
  b.box(0.08, 0.008, 0.06, s.x, top + 0.07, pz + 0.004, 0x3a4157);
  b.box(0.026, 0.026, 0.002, s.x, top + 0.035, pz + 0.0235, 0xf6b53d);
  b.cylinder(0.0015, 0.0015, 0.03, s.x, top + 0.078, pz + 0.012, 0x2a2f38, 4);
  // Speaker stacks at the front corners.
  for (const e of [-1, 1]) {
    const x = s.x + e * (s.w / 2 - 0.035);
    b.box(0.045, 0.085, 0.04, x, top, s.z + s.d / 2 - 0.035, 0x1e2430);
    b.cylinder(0.012, 0.012, 0.002, x, top + 0.055, s.z + s.d / 2 - 0.0145, 0x3a4157, 10);
  }
  // Lamps on poles at the back corners: warm pools of light by night.
  for (const e of [-1, 1]) {
    const x = s.x + e * (s.w / 2 + 0.02);
    b.cylinder(0.004, 0.005, 0.36, x, y0, s.z - s.d / 2 + 0.02, 0x2a2f38, 5);
    b.box(0.03, 0.022, 0.02, x, y0 + 0.36, s.z - s.d / 2 + 0.03, 0x2a2f38);
    quadBlob(b, x, y0 + 0.37, s.z - s.d / 2 + 0.042, 0.01, [3, 2.5, 1.7]);
  }
  // Whoever is giving the speeches, either side of the podium.
  for (const dx of [-0.17, -0.11, 0.12, 0.19]) people(b, r, s.x + dx, s.z + (r() - 0.5) * 0.06, 1, 0, 0, top);
  people(b, r, s.x, pz - 0.04, 1, 0, 0, top);
}

/** Canvas for the banner: "Grand opening", the city's name, the date it was founded. */
function bannerCanvas(name: string, founded: string): HTMLCanvasElement {
  const W = 1024;
  const H = 314;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const draw = () => {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#f6eedf';
    ctx.fillRect(0, 0, W, H);
    // A thin orange frame and a band along the foot, like a shopfront's grand-opening banner.
    ctx.strokeStyle = '#e5512b';
    ctx.lineWidth = 6;
    ctx.strokeRect(16, 16, W - 32, H - 32);
    ctx.fillStyle = '#e5512b';
    ctx.fillRect(16, H - 74, W - 32, 58);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    // Eyebrow, with the mark in front of it.
    ctx.font = '500 30px "Geist Mono", ui-monospace, monospace';
    trySpacing(ctx, '6px');
    const eyebrow = 'GRAND OPENING';
    const ew = ctx.measureText(eyebrow).width;
    drawMark(ctx, W / 2 - ew / 2 - 46, 44, 36);
    ctx.fillStyle = '#a83818';
    ctx.fillText(eyebrow, W / 2 + 6, 76);
    // The name, as big as the banner allows.
    trySpacing(ctx, '-3px');
    tryStretch(ctx);
    let size = 128;
    const fit = () => (ctx.font = `800 ${size}px "Bricolage Grotesque", "Geist", system-ui, sans-serif`);
    fit();
    while (size > 40 && ctx.measureText(name).width > W - 120) {
      size -= 4;
      fit();
    }
    ctx.fillStyle = '#1b2236';
    ctx.fillText(name, W / 2, 112 + (size * 0.74 + 128 * 0.74) / 2);
    // The band: when it was founded.
    trySpacing(ctx, '5px');
    ctx.font = '500 26px "Geist Mono", ui-monospace, monospace';
    ctx.fillStyle = '#fdf9f2';
    ctx.fillText(founded.toUpperCase(), W / 2, H - 35);
  };
  draw();
  return c;
}

function trySpacing(ctx: CanvasRenderingContext2D, v: string) {
  if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = v;
}

function tryStretch(ctx: CanvasRenderingContext2D) {
  if ('fontStretch' in ctx) (ctx as CanvasRenderingContext2D & { fontStretch: string }).fontStretch = 'semi-condensed';
}

/** One piece of confetti's flight: where it starts, how it's thrown, how it spins. */
interface Piece {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  spin: THREE.Vector3;
  phase: number;
  delay: number;
  rest: number;
}

const DRAG = 3.2;
const GRAVITY = 1.5;
const N_RIBBON = 24;

/**
 * The ceremony's set on Civic Center Plaza. Static parts are one GeoBuilder
 * model (three draw calls); the banner, the ribbon, its bow, the scissors
 * and the confetti move or carry a texture, so they're their own meshes.
 * `update(cut)` poses everything for `cut` seconds after the snip (negative:
 * before it), so any moment can be shown exactly.
 */
export class CeremonySet {
  readonly group = new THREE.Group();
  private layout = plazaLayout();
  private ribbon: THREE.Mesh;
  private ribbonPos: Float32Array;
  private bow: THREE.Group;
  private blades: THREE.Mesh[] = [];
  private confetti: THREE.InstancedMesh;
  private pieces: Piece[] = [];
  private bannerTex: THREE.CanvasTexture;
  private bannerMat: THREE.MeshStandardMaterial;
  private confettiGlow = { value: 0 };
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private w = new THREE.Vector3();
  private lastCut = NaN;
  private disposed = false;

  constructor(name: string, founded: string, seed: number) {
    const L = this.layout;
    const r = rng(seed);

    // Everything that stands still: stage, crowd, bunting, the ribbon's posts, the banner's frame.
    const b = new Kit();
    stage(b, r, L.stage);
    crowd(b, r, L.px, L.z);
    bunting(b, r, L.px, L.z);
    const R = L.ribbon;
    for (const x of [R.x0, R.x1]) {
      b.cylinder(0.006, 0.008, R.y + 0.012, x, 0.02, R.z, GOLD, 8, 'smooth');
      b.blob(0.011, x, R.y + 0.036, R.z, GOLD, 'smooth', 1);
      b.cylinder(0.014, 0.016, 0.006, x, 0.02, R.z, 0x8a6a2a, 10);
    }
    const B = L.banner;
    for (const e of [-1, 1]) b.cylinder(0.005, 0.006, B.y + B.h + 0.02, B.x + e * (B.w / 2 + 0.006), 0.02, B.z, 0x2a2f38, 5);
    b.box(B.w + 0.02, B.h + 0.02, 0.008, B.x, B.y - 0.01, B.z - 0.006, 0xe9d9bb);
    // The founder, behind the bow, to hold a pair of giant gold scissors (it's tradition).
    const mid = (R.x0 + R.x1) / 2;
    people(b, rng(seed + 7), mid + 0.035, R.z - 0.045, 1, 0, 0, 0.02);
    const fixed = b.build();
    this.group.add(fixed.group);

    // The banner: its face is a canvas, floodlit at night (emissive scaled by the dark).
    this.bannerTex = new THREE.CanvasTexture(bannerCanvas(name, founded));
    this.bannerTex.colorSpace = THREE.SRGBColorSpace;
    this.bannerTex.anisotropy = 8;
    this.bannerMat = new THREE.MeshStandardMaterial({ map: this.bannerTex, emissiveMap: this.bannerTex, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.92 });
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(B.w, B.h), this.bannerMat);
    banner.position.set(B.x, B.y + B.h / 2, B.z - 0.001);
    banner.receiveShadow = true;
    this.group.add(banner);
    // Fonts may still be on their way: draw the face again once they've arrived.
    void document.fonts?.ready.then(() => {
      if (this.disposed) return;
      const fresh = bannerCanvas(name, founded);
      (this.bannerTex.image as HTMLCanvasElement).getContext('2d')!.drawImage(fresh, 0, 0);
      this.bannerTex.needsUpdate = true;
    });

    // The ribbon: two halves meeting under the bow, a satin strip whose shape is worked out every frame.
    const verts = 2 * (N_RIBBON + 1) * 2;
    this.ribbonPos = new Float32Array(verts * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.ribbonPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(verts * 3).fill(0), 3));
    const index: number[] = [];
    for (let h = 0; h < 2; h++) {
      const o = h * (N_RIBBON + 1) * 2;
      for (let i = 0; i < N_RIBBON; i++) {
        const a = o + i * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    g.setIndex(index);
    this.ribbon = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: GATE as number, roughness: 0.38, metalness: 0.08, side: THREE.DoubleSide, flatShading: true }));
    this.ribbon.castShadow = true;
    this.ribbon.frustumCulled = false;
    this.group.add(this.ribbon);

    // The bow over the join.
    const bow = new Kit();
    for (const e of [-1, 1]) {
      bow.rbox(0.034, 0.024, 0.008, e * 0.018, -0.012, 0, GATE, 0.006, 'solid', 0);
      bow.box(0.008, 0.04, 0.004, e * 0.008, -0.05, 0.001, GATE, false, e * 0.25);
    }
    bow.rbox(0.014, 0.016, 0.012, 0, -0.008, 0.002, 0xc8402e, 0.004, 'solid');
    this.bow = bow.build().group;
    this.group.add(this.bow);

    // The scissors: two gold blades, each with its finger loop, that pivot to snip.
    const gold = new THREE.MeshStandardMaterial({ color: GOLD as number, roughness: 0.3, metalness: 0.85 });
    for (const e of [-1, 1]) {
      const blade = new THREE.BoxGeometry(0.075, 0.006, 0.003).translate(-0.032, 0, 0).toNonIndexed();
      const loop = new THREE.TorusGeometry(0.009, 0.0025, 4, 10).translate(0.012, e * 0.006, 0).toNonIndexed();
      for (const g of [blade, loop]) for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
      const m = new THREE.Mesh(mergeGeometries([blade, loop]), gold);
      blade.dispose();
      loop.dispose();
      m.position.set(mid + 0.04, R.y + 0.006, R.z - 0.008);
      m.userData.side = e;
      this.blades.push(m);
      this.group.add(m);
    }

    // Confetti, thrown up from the posts and the founder's spot, settling over the crowd.
    const piece = new THREE.PlaneGeometry(0.026, 0.016);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.1, side: THREE.DoubleSide });
    const glow = this.confettiGlow;
    // Lit by the stage lamps at night: each piece glows a little in its own colour.
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uGlow = glow;
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', 'uniform float uGlow;\nvoid main() {')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * uGlow;');
    };
    mat.customProgramCacheKey = () => 'tinytown-confetti-1';
    const N = 420;
    this.confetti = new THREE.InstancedMesh(piece, mat, N);
    this.confetti.frustumCulled = false;
    this.confetti.count = 0;
    const c = new THREE.Color();
    const from = [
      { x: R.x0, z: R.z, dir: 1 },
      { x: R.x1, z: R.z, dir: -1 },
      { x: mid, z: R.z - 0.02, dir: 0 },
    ];
    for (let i = 0; i < N; i++) {
      const e = from[i % 3]!;
      const up = 1.7 + r() * 1.3;
      const a = r() * Math.PI * 2;
      const side = 0.25 + r() * 0.55;
      this.pieces.push({
        x: e.x + (r() - 0.5) * 0.02,
        y: (e.dir ? R.y + 0.04 : 0.09) + r() * 0.01,
        z: e.z + (r() - 0.5) * 0.02,
        // The cannons on the posts throw in toward the middle; the centre throws every way.
        vx: e.dir ? e.dir * (0.5 + r() * 0.7) : Math.cos(a) * side,
        vy: up,
        vz: e.dir ? (r() - 0.35) * 1.1 : Math.sin(a) * side + 0.25,
        spin: new THREE.Vector3((r() - 0.5) * 18, (r() - 0.5) * 14, (r() - 0.5) * 18),
        phase: r() * Math.PI * 2,
        delay: r() * 0.08 + (e.dir ? 0 : 0.05),
        rest: 0.021 + r() * 0.012,
      });
      this.confetti.setColorAt(i, c.setHex(pick(r, CONFETTI)));
    }
    this.group.add(this.confetti);
    this.update(-1, 0);
  }

  /** The plaza point the camera frames. */
  get subject(): THREE.Vector3 {
    return this.layout.subject;
  }

  /** Where the fireworks go up from: the walk behind the banner. */
  get launchAt(): THREE.Vector3 {
    return new THREE.Vector3(this.layout.px + 0.05, 0.3, this.layout.z - 2.3);
  }

  /** Poses the ribbon, bow, scissors and confetti for `cut` seconds after the snip. `night` 0–1 lights the banner and confetti. */
  update(cut: number, night: number) {
    this.bannerMat.emissiveIntensity = 0.5 * night;
    this.confettiGlow.value = 0.35 * night;
    if (cut === this.lastCut) return;
    this.lastCut = cut;
    this.poseRibbon(cut);
    this.poseScissors(cut);
    this.poseConfetti(cut);
  }

  private poseRibbon(cut: number) {
    const R = this.layout.ribbon;
    const mid = (R.x0 + R.x1) / 2;
    const half = mid - R.x0;
    const bandH = 0.034;
    const top = R.y + 0.012;
    const pos = this.ribbonPos;
    const w = this.w;
    for (let h = 0; h < 2; h++) {
      const dir = h === 0 ? 1 : -1;
      const post = h === 0 ? R.x0 : R.x1;
      for (let i = 0; i <= N_RIBBON; i++) {
        const s = (i / N_RIBBON) * half;
        const u = (post + dir * s - R.x0) / (R.x1 - R.x0);
        // At rest: taut, with the faintest sag.
        const rx = post + dir * s;
        const ry = R.y - 0.006 * Math.sin(Math.PI * u);
        // Fallen: hanging down the post, then lying on the plaza toward the middle.
        const hang = Math.min(s, top - 0.026);
        const lie = Math.max(0, s - hang);
        const fx = post + dir * (0.006 + lie * 0.82);
        const fy = lie > 0 ? 0.026 : top - hang;
        const fz = R.z + Math.sin(s * 47) * 0.012 * Math.min(1, lie * 10);
        // The free end goes first; each point drops, then settles out along the ground, with a little bounce.
        const delay = (1 - s / half) * 0.16;
        const k = cut <= 0 ? 0 : THREE.MathUtils.clamp((cut - delay) / 0.5, 0, 1);
        const ky = bounce(k);
        const kx = k * k * (3 - 2 * k);
        const x = rx + (fx - rx) * kx;
        const y = Math.max(0.024, ry + (fy - ry) * ky);
        const z = R.z + (fz - R.z) * kx;
        // The band turns from upright to flat (or hangs sideways down the post).
        if (lie > 0) w.set(0, 1 - kx, kx);
        else w.set(kx, 1 - kx, 0);
        w.normalize().multiplyScalar(bandH / 2);
        const o = ((h * (N_RIBBON + 1) + i) * 2) * 3;
        pos[o] = x + w.x;
        pos[o + 1] = y + w.y;
        pos[o + 2] = z + w.z;
        pos[o + 3] = x - w.x;
        pos[o + 4] = Math.max(0.0215, y - w.y);
        pos[o + 5] = z - w.z;
      }
    }
    const attr = this.ribbon.geometry.attributes.position as THREE.BufferAttribute;
    attr.needsUpdate = true;
    // The bow drops straight down and topples onto the plaza.
    const fall = cut <= 0 ? 0 : cut;
    const y = Math.max(0.032, R.y + 0.014 - 0.5 * 6 * fall * fall);
    const k = THREE.MathUtils.clamp(fall / 0.32, 0, 1);
    this.bow.position.set(mid + k * 0.02, y, R.z + 0.006 + k * 0.03);
    this.bow.rotation.set(-k * 1.35, 0, k * 0.5);
  }

  /** The blades open wide while the speeches finish, then close: snip. */
  private poseScissors(cut: number) {
    const open = cut < -0.45 ? 0.42 : cut < 0 ? 0.42 * (-cut / 0.45) ** 0.6 : 0;
    // After the snip, the founder lowers them.
    const lower = THREE.MathUtils.clamp(cut / 0.6, 0, 1);
    for (const b of this.blades) {
      const e = b.userData.side as number;
      b.rotation.set(0, 0, e * open * 0.5 - 0.45 - lower * 0.6);
      b.position.y = this.layout.ribbon.y + 0.006 - lower * 0.02;
    }
  }

  private poseConfetti(cut: number) {
    const mesh = this.confetti;
    if (cut <= 0) {
      mesh.count = 0;
      return;
    }
    mesh.count = this.pieces.length;
    const { m, q, e, p, s } = this;
    s.set(1, 1, 1);
    for (let i = 0; i < this.pieces.length; i++) {
      const c = this.pieces[i]!;
      const a = Math.max(0, cut - c.delay);
      // Thrown up against air drag, then drifting down at a fluttering terminal speed.
      const ex = (1 - Math.exp(-DRAG * a)) / DRAG;
      const fy = c.y + (c.vy + GRAVITY / DRAG) * ex - (GRAVITY / DRAG) * a;
      const flutter = 0.025 * Math.sin(a * 7 + c.phase) * (1 - Math.exp(-a * 2));
      const landed = fy <= c.rest && a > 0.2;
      p.set(c.x + c.vx * ex + (landed ? 0 : flutter), landed ? c.rest : Math.max(c.rest, fy), c.z + c.vz * ex);
      if (landed) e.set(-Math.PI / 2, c.phase, 0);
      else e.set(c.spin.x * a, c.spin.y * a, c.spin.z * a);
      q.setFromEuler(e);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.group.removeFromParent();
    disposeGroup(this.group);
    this.bannerTex.dispose();
    this.disposed = true;
  }
}

/** Falls, hits the ground and bounces once, a little. */
function bounce(k: number): number {
  if (k < 0.62) return (k / 0.62) ** 2;
  const b = (k - 0.62) / 0.38;
  return 1 - 0.12 * Math.sin(Math.PI * b) * (1 - b);
}

// ─── The sequence ─────────────────────────────────────────────────────────

/** Where the camera looks: a point on the ground, a zoom, and the compass angle it looks from. */
export interface Pose {
  x: number;
  z: number;
  zoom: number;
  /** Azimuth in radians: π/4 is the usual view from the north-east. */
  az: number;
}

/** Pure: a point between two poses. Zoom eases on a log scale, the angle the short way round. */
export function between(a: Pose, b: Pose, k: number): Pose {
  if (k <= 0) return a;
  if (k >= 1) return b;
  let d = (b.az - a.az) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return {
    x: a.x + (b.x - a.x) * k,
    z: a.z + (b.z - a.z) * k,
    zoom: Math.exp(Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * k),
    az: a.az + d * k,
  };
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const easeSine = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * t);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const DEG = Math.PI / 180;
/** The TINYTOWN sign's two ends (it runs about 15 units along its ridge, south-east to north-west of its centre), for framing it whole. */
const SIGN_SPAN: [number, number][] = [[5.4, -5.4], [-5.4, 5.4]];
/** The camera's angle down from the vertical (isometric), so its height above the ground for a distance. */
const ISO_POLAR = Math.acos(1 / Math.sqrt(3));

/**
 * Pure: the camera for second `t` of the ceremony, through its shots: from
 * where it started down to the plaza, a slow push in through the cut, back
 * to take in the plaza and the sign together, then home. Each move starts
 * and settles gently.
 */
export function poseAt(t: number, shots: { start: Pose; plaza: Pose; push: Pose; wide: Pose; home: Pose }): Pose {
  const { start, plaza, push, wide, home } = shots;
  if (t < BEATS.arrive) return between(start, plaza, easeInOut(clamp01(t / BEATS.arrive)));
  if (t < BEATS.pull) return between(plaza, push, easeSine(clamp01((t - BEATS.arrive) / (BEATS.pull - BEATS.arrive))));
  if (t < BEATS.wide) return between(push, wide, easeInOut(clamp01((t - BEATS.pull) / (BEATS.wide - BEATS.pull))));
  if (t < BEATS.leave) return wide;
  return between(wide, home, easeInOut(clamp01((t - BEATS.leave) / (BEATS.end - BEATS.leave))));
}

/** The chrome over the canvas (src/ui/ceremony.ts). */
export interface CeremonyUi {
  /** Bars in, the HUD steps aside, the Skip pill. */
  show(): void;
  /** The title card up or down. */
  card(on: boolean, animate?: boolean): void;
  /** The ribbon is cut: the card says so. */
  opened(animate?: boolean): void;
  /** 0 clear, 1 covered: the cuts happen under this. */
  veil(k: number): void;
  readonly level: number;
  /** Bars away and the HUD back, ahead of the end. */
  hide(): void;
  remove(): void;
  /**
   * The part of the screen the bars (and, with `card`, the title card) leave
   * free for the picture, in fractions of the screen, y down.
   */
  free(w: number, h: number, card: boolean): { x0: number; x1: number; y0: number; y1: number };
}

export interface CeremonyOptions {
  stage: Stage;
  city: City;
  name: string;
  /** "Founded October 14, 2026", for the banner's band. */
  founded: string;
  seed: number;
  ui: CeremonyUi;
  /** Hold at this many seconds in (previews and screenshots). */
  hold?: number;
  /** A feed kind for the sound (see src/audio/cues.ts). */
  onCue: (kind: string, text: string) => void;
  onDone: (skipped: boolean) => void;
}

/**
 * The grand opening's sequence. It owns the plaza set and the camera while it
 * plays, and hands both back when it's done, skipped or anything goes wrong.
 */
export class Ceremony implements Cinematic {
  done = false;
  private o: CeremonyOptions;
  private t: number;
  private set: CeremonySet;
  /** Reduced motion (the system's, or Settings' own switch): a fade to a still and back. */
  private still = prefersReducedMotion();
  private ending: { t: number } | null = null;
  private shots!: { start: Pose; plaza: Pose; push: Pose; wide: Pose; home: Pose };
  private aim = new THREE.Vector3();
  private aimFn = () => this.aim;
  private fired = new Set<string>();
  private cardOn = false;
  private isOpen = false;
  private signWaiting = false;
  private tornDown = false;
  private distance = 240;
  private size = new THREE.Vector2();

  constructor(o: CeremonyOptions) {
    this.o = o;
    this.t = o.hold ?? 0;
    this.set = new CeremonySet(o.name, o.founded, o.seed);
    if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) (window as unknown as { __ceremony: Ceremony }).__ceremony = this;
  }

  /** Takes the screen. False (and nothing happens) if something else has it. */
  start(): boolean {
    const { stage, city, ui } = this.o;
    if (stage.playing) return false;
    city.scene.add(this.set.group);
    city.setCeremony(true);
    this.signWaiting = city.signLit;
    // Compile the set's shaders now, before the camera arrives.
    stage.renderer.compile(city.scene, stage.camera);
    const target = stage.controls.target;
    const offset = stage.camera.position.clone().sub(target);
    this.distance = offset.length();
    const startAz = Math.atan2(offset.x, offset.z);
    const start = { x: target.x, z: target.z, zoom: stage.camera.zoom, az: startAz };
    // Home is where it started, squared to the nearest of the four isometric angles.
    const quarter = Math.PI / 2;
    const homeAz = Math.round((startAz - Math.PI / 4) / quarter) * quarter + Math.PI / 4;
    // The overlay first: the framing measures the title card.
    ui.show();
    this.shots = { start, home: { ...start, az: homeAz }, ...this.frames() };
    stage.play(this);
    return true;
  }

  /** Jump to a moment (seconds from the start), for previews. */
  seek(t: number) {
    this.t = t;
  }

  skip() {
    if (this.done || this.ending) return;
    this.ending = { t: 0 };
  }

  /**
   * The plaza and wide shots for this screen: each framed to fit what it
   * shows inside the part of the screen the bars and the title card leave.
   */
  private frames(): { plaza: Pose; push: Pose; wide: Pose } {
    const { stage, ui } = this.o;
    stage.renderer.getSize(this.size);
    const w = Math.max(1, this.size.x);
    const h = Math.max(1, this.size.y);
    const L = plazaLayout();
    const B = L.banner;
    const R = L.ribbon;
    const top = B.y + B.h + 0.04;
    // From the north-north-east the plaza is clear of the Market Street flatiron, and City Hall's dome stands beside it.
    const az = 16 * DEG;
    const withCard = ui.free(w, h, true);
    // Arriving: the whole ceremony, from the banner to the back of the crowd.
    const plaza = this.fit([[B.x - B.w / 2, top, B.z], [B.x + B.w / 2, top, B.z], [L.px - 0.62, 0, L.z + 1.2], [L.px + 0.62, 0, L.z + 1.2], [L.px - 0.62, 0, B.z], [L.px + 0.62, 0, B.z]], az, withCard, 1.08);
    // Then in close on the stage and the ribbon for the cut.
    const push = this.fit([[B.x - B.w / 2, top, B.z], [B.x + B.w / 2, top, B.z], [R.x0 - 0.05, 0, R.z + 0.3], [R.x1 + 0.05, 0, R.z + 0.3]], az + 6 * DEG, withCard, 1.24);
    // Wide: the plaza and the sign on its hill in one frame, for the lights and the fireworks.
    const sign = LANDMARKS.sign;
    const sy = Math.max(0, terrainHeight(sign.x, sign.z));
    const narrow = w < 700;
    const wide = this.fit([[B.x, top, B.z], [L.px, 0, L.z + 1.2], ...SIGN_SPAN.map(([dx, dz]): [number, number, number] => [sign.x + dx, sy + 2.8, sign.z + dz]), [sign.x, sy + 6, sign.z]], az + 2 * DEG, narrow ? ui.free(w, h, false) : withCard, 1.1);
    return { plaza, push, wide };
  }

  /**
   * The pose at angle `az` that fits world points inside a rectangle of the
   * screen (fractions, y down), as large as it will go, with `pad` to spare.
   */
  private fit(points: [number, number, number][], az: number, rect: { x0: number; x1: number; y0: number; y1: number }, pad: number): Pose {
    const cam = this.o.stage.camera;
    const viewW = cam.right - cam.left;
    const viewH = cam.top - cam.bottom;
    const sa = Math.sin(az);
    const ca = Math.cos(az);
    const cp = Math.cos(ISO_POLAR);
    const sp = Math.sin(ISO_POLAR);
    // Screen axes for an orthographic camera at this angle: right, and up (ground steps away from the camera rise by cos of the polar angle).
    let a0 = Infinity;
    let a1 = -Infinity;
    let b0 = Infinity;
    let b1 = -Infinity;
    for (const [x, y, z] of points) {
      const a = x * ca - z * sa;
      const b = -(x * sa + z * ca) * cp + y * sp;
      a0 = Math.min(a0, a);
      a1 = Math.max(a1, a);
      b0 = Math.min(b0, b);
      b1 = Math.max(b1, b);
    }
    const fw = rect.x1 - rect.x0;
    const fh = rect.y1 - rect.y0;
    const zoom = THREE.MathUtils.clamp(Math.min((fw * viewW) / ((a1 - a0) * pad), (fh * viewH) / ((b1 - b0) * pad)), 0.6, 12);
    // The box's centre goes to the rectangle's centre: work back to the ground point the camera looks at.
    const ox = ((rect.x0 + rect.x1) / 2 - 0.5) * (viewW / zoom);
    const oy = (0.5 - (rect.y0 + rect.y1) / 2) * (viewH / zoom);
    const ta = (a0 + a1) / 2 - ox;
    const g = -((b0 + b1) / 2 - oy) / cp;
    return { x: ta * ca + g * sa, z: -ta * sa + g * ca, zoom, az };
  }

  update(dt: number): Shot | null {
    if (this.o.hold === undefined) this.t += dt;
    try {
      if (this.ending) return this.end(dt);
      return this.still ? this.stillFrame() : this.frame();
    } catch (err) {
      // Never leave the city stuck behind a broken ceremony.
      console.error(err);
      this.finish(true);
      return null;
    }
  }

  private frame(): Shot | null {
    const { city, ui, stage } = this.o;
    const t = this.t;
    const held = this.o.hold !== undefined;
    this.place(poseAt(t, this.shots));
    this.set.update(t - BEATS.cut, city.atmosphere.night);
    const narrow = stage.renderer.domElement.clientWidth < 700;
    const cardOn = t >= BEATS.card && t < (narrow ? BEATS.cardOutNarrow : BEATS.cardOut);
    if (cardOn !== this.cardOn) {
      this.cardOn = cardOn;
      ui.card(cardOn, !held);
    }
    if (t >= BEATS.cut && !this.isOpen) {
      this.isOpen = true;
      ui.opened(!held);
    }
    // One-shot moments; a held preview fires the ones it lands just after, so a still can catch them.
    const once = (key: string, at: number, run: () => void) => {
      if (this.fired.has(key) || t < at || (held && t - at > 1.6)) return;
      this.fired.add(key);
      run();
    };
    once('cut', BEATS.cut, () => this.o.onCue('district.unlocked', 'Grand opening'));
    once('volley', BEATS.volley, () => city.fireworks.launch(this.set.launchAt, 3, 1.4));
    if (t >= BEATS.sign && this.signWaiting) {
      this.signWaiting = false;
      city.holdSign(false);
      if (!held || t - BEATS.sign < 1.6) this.o.onCue('game.sign.lit', 'The TINYTOWN sign is on');
    }
    once('volley2', BEATS.sign + 0.2, () => city.fireworks.launch(this.set.launchAt.add(new THREE.Vector3(0, 0, -0.6)), 4, 2.2));
    once('bay', BEATS.bay, () => {
      const f = LANDMARKS.ferryBuilding;
      city.fireworksShow(new THREE.Vector3(f.x + 3.5, 0.3, f.z + 1), 2);
    });
    if (t >= BEATS.bars) ui.hide();
    if (t >= BEATS.end && !held) this.finish(false);
    return null;
  }

  /** Reduced motion: fade out, the plaza after the cut as a still with the card, fade back. */
  private stillFrame(): Shot | null {
    const { city, ui } = this.o;
    const t = this.t;
    const F = STILL.fade;
    const H = STILL.hold;
    // Out (F), in on the plaza (F), hold (H), out (F), in on the city (F).
    const back = 3 * F + H;
    if (t >= F && t < back) {
      this.place(this.shots.push);
      this.set.update(30, city.atmosphere.night);
      if (!this.cardOn) {
        this.cardOn = true;
        this.isOpen = true;
        ui.card(true, false);
        ui.opened(false);
      }
      if (this.signWaiting) {
        this.signWaiting = false;
        city.holdSign(false);
      }
    } else if (t >= back) {
      this.teardown();
      this.place(this.shots.home);
    }
    const k = t < F ? t / F : t < 2 * F ? 1 - (t - F) / F : t < 2 * F + H ? 0 : t < back ? (t - 2 * F - H) / F : 1 - (t - back) / F;
    ui.veil(clamp01(k));
    if (t >= back + F && this.o.hold === undefined) this.finish(false);
    return null;
  }

  /** Skipped: a quick fade, everything put back under it, and the fade lifts on the city. */
  private end(dt: number): Shot | null {
    const e = this.ending!;
    const { ui } = this.o;
    e.t += dt;
    const DOWN = 0.28;
    const UP = 0.45;
    if (e.t < DOWN) {
      ui.veil(Math.max(ui.level, e.t / DOWN));
      return null;
    }
    this.teardown();
    this.place(this.shots.home);
    ui.veil(1 - Math.min(1, (e.t - DOWN) / UP));
    if (e.t >= DOWN + UP) this.finish(true);
    return null;
  }

  /** Puts the camera at a pose: the angle set here, the target and zoom through `follow`, snapped. */
  private place(p: Pose) {
    const { stage } = this.o;
    const target = stage.controls.target;
    const r = Math.sin(ISO_POLAR) * this.distance;
    stage.camera.position.set(target.x + Math.sin(p.az) * r, target.y + Math.cos(ISO_POLAR) * this.distance, target.z + Math.cos(p.az) * r);
    this.aim.set(p.x, target.y, p.z);
    stage.follow(this.aimFn, p.zoom, false, true);
  }

  /** Takes the set down and gives the plaza, the sign and the HUD back. Safe to call more than once. */
  private teardown() {
    if (this.tornDown) return;
    this.tornDown = true;
    const { city, ui } = this.o;
    if (this.cardOn) ui.card(false, false);
    this.cardOn = false;
    ui.hide();
    this.signWaiting = false;
    city.setCeremony(false);
    this.set.dispose();
  }

  private finish(skipped: boolean) {
    if (this.done) return;
    this.done = true;
    const { stage, ui } = this.o;
    stage.stopFollowing();
    this.teardown();
    ui.remove();
    // Back on the usual angle: let the overview frame the city again, as it does on any first open.
    if (Math.abs(this.shots.home.az - Math.PI / 4) < 1e-3) stage.resetView();
    this.o.onDone(skipped);
  }
}
