import * as THREE from 'three';
import { GeoBuilder, type ColorLike } from './geo.ts';
import { PALETTE } from './palette.ts';
import { pick, rng } from '../world/rng.ts';
import {
  BLOCK,
  FRONTAGE_LOTS,
  blockCentre,
  lotPosition,
  treeLots,
  type DistrictDef,
  type HomeKind,
} from '../world/layout.ts';

export interface Built {
  group: THREE.Group;
  /** Window/neon material; scale its colour to switch the lights. */
  glow?: THREE.MeshBasicMaterial;
}

export function bright(hex: number, k: number): [number, number, number] {
  const c = new THREE.Color(hex);
  return [c.r * k, c.g * k, c.b * k];
}

function warmth(r: () => number): ColorLike {
  const w = PALETTE.windowWarm;
  const v = 0.85 + r() * 0.3;
  return [w[0] * v, w[1] * v, w[2] * v];
}

// ─── Trees ────────────────────────────────────────────────────────────────

export function tree(b: GeoBuilder, r: () => number, x: number, z: number, scale = 1, y = 0) {
  const s = scale * (0.8 + r() * 0.4);
  const leaves = pick(r, PALETTE.leaves);
  b.cylinder(0.035 * s, 0.05 * s, 0.22 * s, x, y, z, PALETTE.trunk, 5);
  if (r() < 0.5) {
    b.cylinder(0, 0.22 * s, 0.38 * s, x, y + 0.16 * s, z, leaves, 6);
    b.cylinder(0, 0.16 * s, 0.3 * s, x, y + 0.36 * s, z, leaves, 6);
  } else {
    b.blob(0.2 * s, x, y + 0.36 * s, z, leaves);
    b.blob(0.13 * s, x + 0.08 * s, y + 0.5 * s, z - 0.05 * s, leaves);
  }
}

// ─── Homes (one per customer, in lot-local space, door facing +z) ─────────

export function home(kind: HomeKind, seed: number): Built {
  const r = rng(seed);
  const b = new GeoBuilder();
  const wall = pick(r, PALETTE.walls);
  const roof = pick(r, PALETTE.roofs);

  // Yard, front path and hedge
  b.box(0.96, 0.03, 0.96, 0, 0, 0, PALETTE.lawn);
  b.decal(0.12, 0.24, 0, 0.032, 0.36, PALETTE.sidewalk);

  if (kind === 'house') {
    const w = 0.52 + r() * 0.14;
    const d = 0.46 + r() * 0.08;
    const storeys = r() < 0.35 ? 2 : 1;
    const h = 0.26 * storeys + 0.06;
    const z0 = -0.08;
    b.box(w, h, d, 0, 0.03, z0, wall);
    b.gable(w, 0.2 + r() * 0.08, d, 0, 0.03 + h, z0, roof);
    b.box(0.07, 0.2, 0.07, w * 0.28, 0.03 + h, z0 - d * 0.18, PALETTE.concrete);
    // Door, porch light and windows
    b.quad(0.1, 0.17, 0, 0.03 + 0.085, z0 + d / 2 + 0.004, 'z+', PALETTE.door, false);
    b.blob(0.018, 0.08, 0.03 + 0.2, z0 + d / 2 + 0.02, PALETTE.lamp, true);
    b.windows({ w, d, x: 0, z: z0, y0: 0.03, rows: storeys, rowHeight: 0.26, cols: 2, faces: ['z+'] }, r, 0.85, warmth(r), { w: 0.1, h: 0.1 });
    b.windows({ w, d, x: 0, z: z0, y0: 0.03, rows: storeys, rowHeight: 0.26, cols: 1, faces: ['x+', 'x-'] }, r, 0.5, warmth(r), { w: 0.1, h: 0.1 });
    if (r() < 0.35) {
      // Garage
      const gx = w / 2 + 0.11;
      b.box(0.2, 0.2, 0.3, gx, 0.03, z0 + d / 2 - 0.15, wall);
      b.box(0.24, 0.03, 0.34, gx, 0.23, z0 + d / 2 - 0.15, roof);
      b.quad(0.16, 0.14, gx, 0.03 + 0.07, z0 + d / 2 + 0.004, 'z+', PALETTE.trim, false);
    } else if (r() < 0.6) {
      tree(b, r, -0.36, 0.34, 0.6, 0.03);
    }
    if (r() < 0.4) b.box(0.9, 0.06, 0.04, 0, 0.03, 0.46, PALETTE.trim); // picket fence
  } else if (kind === 'townhouse') {
    const units = 2;
    for (let u = 0; u < units; u++) {
      const x = (u - 0.5) * 0.38;
      const h = 0.62 + r() * 0.18;
      const c = u === 0 ? wall : pick(r, PALETTE.walls);
      b.box(0.36, h, 0.56, x, 0.03, -0.06, c);
      b.gable(0.36, 0.16, 0.56, x, 0.03 + h, -0.06, roof, 0.02);
      b.quad(0.08, 0.15, x, 0.03 + 0.075, 0.224, 'z+', PALETTE.door, false);
      b.windows({ w: 0.36, d: 0.56, x, z: -0.06, y0: 0.03, rows: 3, rowHeight: h / 3, cols: 2, faces: ['z+'] }, r, 0.7, warmth(r), { w: 0.07, h: 0.09 });
    }
  } else {
    const floors = 5 + Math.floor(r() * 3);
    const h = floors * 0.2;
    b.box(0.78, h, 0.7, 0, 0.03, -0.04, wall);
    b.box(0.82, 0.04, 0.74, 0, 0.03 + h, -0.04, PALETTE.trim);
    b.cylinder(0.08, 0.08, 0.14, 0.2, 0.07 + h, -0.15, PALETTE.concrete, 8);
    b.quad(0.14, 0.18, 0, 0.12, 0.314, 'z+', PALETTE.glass, false);
    b.windows({ w: 0.78, d: 0.7, x: 0, z: -0.04, y0: 0.23, rows: floors - 1, rowHeight: 0.2, cols: 4 }, r, 0.6, warmth(r), { w: 0.09, h: 0.1 });
  }

  return b.build();
}

// ─── Neighbourhood grounds: pavements, a little park, corner trees ────────

export function neighbourhoodGrounds(bx: number, bz: number, n: number, seed: number): Built {
  const r = rng(seed);
  const b = new GeoBuilder();
  const c = blockCentre({ bx, bz });
  b.box(BLOCK, 0.02, BLOCK, c.x, 0, c.z, PALETTE.sidewalk);

  // Park in the middle 2×2
  b.box(1.9, 0.04, 1.9, c.x, 0.02, c.z, PALETTE.lawn);
  b.cylinder(0.42, 0.42, 0.02, c.x - 0.3, 0.06, c.z + 0.25, PALETTE.water, 12);
  b.cylinder(0.46, 0.46, 0.015, c.x - 0.3, 0.055, c.z + 0.25, PALETTE.sidewalk, 12);
  for (let i = 0; i < 4; i++) tree(b, r, c.x + (r() - 0.2) * 1.4, c.z + (r() - 0.6) * 1.4, 0.85, 0.06);
  b.box(0.3, 0.05, 0.08, c.x + 0.45, 0.06, c.z + 0.6, PALETTE.trunk); // bench
  b.cylinder(0.012, 0.012, 0.36, c.x + 0.7, 0.06, c.z + 0.7, PALETTE.concrete, 4);
  b.blob(0.035, c.x + 0.7, 0.44, c.z + 0.7, PALETTE.lamp, true);

  for (const lot of treeLots(n)) {
    const p = lotPosition({ bx, bz }, lot);
    b.box(0.96, 0.03, 0.96, p.x, 0.02, p.z, PALETTE.lawn);
    tree(b, r, p.x - 0.15, p.z - 0.1, 1.1, 0.05);
    tree(b, r, p.x + 0.2, p.z + 0.18, 0.8, 0.05);
  }
  return b.build();
}

// ─── Commercial districts, unlocked by MRR milestones ─────────────────────

export function district(def: DistrictDef, seed: number): Built {
  const r = rng(seed);
  const b = new GeoBuilder();
  const c = blockCentre(def);
  const neon = bright(def.neon, 2.4);
  b.box(BLOCK, 0.03, BLOCK, c.x, 0, c.z, PALETTE.plaza);

  if (def.tier === 0) {
    shops(b, r, def, neon);
  } else if (def.tier === 7) {
    spire(b, r, c.x, c.z, neon);
  } else {
    for (const [qx, qz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      const x = c.x + qx;
      const z = c.z + qz;
      if (def.tier === 1) arcade(b, r, x, z, neon);
      else if (def.tier === 2) campus(b, r, x, z, neon);
      else tower(b, r, x, z, def.tier, neon);
    }
  }
  return b.build();
}

function shops(b: GeoBuilder, r: () => number, def: DistrictDef, neon: ColorLike) {
  const c = blockCentre(def);
  // Plaza with string lights and a food truck
  for (let i = 0; i < 4; i++) tree(b, r, c.x + (i % 2 ? 0.7 : -0.7), c.z + (i < 2 ? 0.7 : -0.7), 0.7, 0.03);
  for (let i = 0; i <= 8; i++) b.blob(0.025, c.x - 0.8 + i * 0.2, 0.55 - Math.sin((i / 8) * Math.PI) * 0.08, c.z, PALETTE.lamp, true);
  b.box(0.42, 0.22, 0.2, c.x, 0.03, c.z + 0.25, 0xe0e0e8);
  b.quad(0.24, 0.08, c.x, 0.16, c.z + 0.354, 'z+', neon);

  for (const lot of FRONTAGE_LOTS) {
    const p = lotPosition(def, lot);
    const g = new THREE.Group();
    const h = 0.38 + r() * 0.3;
    const wall = pick(r, PALETTE.walls);
    // Build in lot space, then rotate to face the street.
    const parts = new GeoBuilder();
    parts.box(0.86, h, 0.7, 0, 0.03, -0.08, wall);
    parts.box(0.9, 0.05, 0.74, 0, 0.03 + h, -0.08, PALETTE.trim);
    parts.quad(0.62, 0.2, 0, 0.15, 0.274, 'z+', warmth(r));
    parts.box(0.8, 0.02, 0.16, 0, 0.3, 0.33, pick(r, PALETTE.roofs)); // awning
    parts.box(0.5, 0.08, 0.02, 0, 0.03 + h + 0.06, 0.2, neon, true); // neon sign
    const built = parts.build();
    g.add(built.group);
    g.rotation.y = lot.rot;
    g.position.set(p.x, 0, p.z);
    g.updateMatrixWorld(true);
    // Bake into the district builder so the whole block stays two draw calls.
    bake(b, built.group);
  }
}

function arcade(b: GeoBuilder, r: () => number, x: number, z: number, neon: ColorLike) {
  const h = 1.2 + r() * 0.8;
  const w = 1.5;
  b.box(w, h, w, x, 0.03, z, pick(r, PALETTE.officeWalls));
  b.windows({ w, d: w, x, z, y0: 0.4, rows: Math.floor((h - 0.4) / 0.24), rowHeight: 0.24, cols: 4 }, r, 0.55, r() < 0.5 ? warmth(r) : PALETTE.windowCool);
  // Ground-floor glow and vertical blade sign
  for (const f of ['x+', 'z+'] as const) {
    const [qx, qz] = f === 'x+' ? [x + w / 2 + 0.005, z] : [x, z + w / 2 + 0.005];
    b.quad(1.2, 0.18, qx, 0.2, qz, f, neon);
  }
  b.box(0.06, h * 0.6, 0.3, x + w / 2 + 0.03, h * 0.3, z + 0.35, neon, true);
  b.box(0.3, h * 0.6, 0.06, x - 0.35, h * 0.35, z + w / 2 + 0.03, bright(0xffd23f, 2.2), true);
}

function campus(b: GeoBuilder, r: () => number, x: number, z: number, neon: ColorLike) {
  const h = 0.6 + r() * 0.5;
  b.box(1.6, 0.03, 1.6, x, 0.03, z, PALETTE.lawn);
  b.box(1.3, h, 1.0, x, 0.06, z - 0.15, PALETTE.glass);
  b.box(1.36, 0.05, 1.06, x, 0.06 + h, z - 0.15, PALETTE.concrete);
  b.windows({ w: 1.3, d: 1.0, x, z: z - 0.15, y0: 0.06, rows: Math.round(h / 0.22), rowHeight: 0.22, cols: 6 }, r, 0.75, PALETTE.windowCool, { w: 0.17, h: 0.12 });
  for (let i = 0; i < 3; i++) b.box(0.3, 0.02, 0.18, x - 0.4 + i * 0.4, 0.11 + h, z - 0.15, 0x22324f); // solar
  b.quad(0.7, 0.08, x, 0.06 + h - 0.08, z + 0.354, 'z+', neon);
  tree(b, r, x + 0.55, z + 0.6, 0.7, 0.06);
  tree(b, r, x - 0.55, z + 0.6, 0.7, 0.06);
}

function tower(b: GeoBuilder, r: () => number, x: number, z: number, tier: number, neon: ColorLike) {
  const h = (tier - 1) * (0.9 + r() * 0.5) + 0.8;
  const w = 1.1 + r() * 0.35;
  const wall = pick(r, PALETTE.officeWalls);
  const light = r() < 0.6 ? warmth(r) : PALETTE.windowCool;
  const podium = 0.35;
  b.box(w + 0.3, podium, w + 0.3, x, 0.03, z, PALETTE.concrete);
  const lower = h * (0.6 + r() * 0.15);
  b.box(w, lower, w, x, 0.03 + podium, z, wall);
  b.windows({ w, d: w, x, z, y0: 0.03 + podium, rows: Math.floor(lower / 0.2), rowHeight: 0.2, cols: 4 }, r, 0.55, light, { w: 0.14, h: 0.1 });
  const w2 = w * 0.72;
  const y2 = 0.03 + podium + lower;
  const upper = h - lower;
  b.box(w2, upper, w2, x, y2, z, wall);
  b.windows({ w: w2, d: w2, x, z, y0: y2, rows: Math.floor(upper / 0.2), rowHeight: 0.2, cols: 3 }, r, 0.6, light, { w: 0.14, h: 0.1 });
  // Neon crown, roof, antenna with aircraft warning light
  b.box(w2 + 0.02, 0.05, w2 + 0.02, x, y2 + upper - 0.12, z, neon, true);
  b.box(w2 * 0.6, 0.15, w2 * 0.6, x, y2 + upper, z, PALETTE.concrete);
  b.cylinder(0.012, 0.02, 0.5, x, y2 + upper + 0.15, z, PALETTE.concrete, 4);
  b.blob(0.035, x, y2 + upper + 0.66, z, bright(0xff2a2a, 3), true);
}

function spire(b: GeoBuilder, r: () => number, x: number, z: number, neon: ColorLike) {
  b.box(3.2, 0.4, 3.2, x, 0.03, z, PALETTE.concrete);
  let w = 2.0;
  let y = 0.43;
  for (let s = 0; s < 6; s++) {
    const h = 1.6 - s * 0.12;
    b.box(w, h, w, x, y, z, PALETTE.glass);
    b.windows({ w, d: w, x, z, y0: y, rows: Math.floor(h / 0.2), rowHeight: 0.2, cols: Math.max(3, Math.round(w * 3)) }, r, 0.7, PALETTE.windowCool, { w: 0.12, h: 0.1 });
    b.box(w + 0.04, 0.05, w + 0.04, x, y + h - 0.05, z, neon, true);
    y += h;
    w *= 0.8;
  }
  b.cylinder(0.02, 0.1, 2.4, x, y, z, PALETTE.concrete, 6);
  b.blob(0.12, x, y + 2.5, z, neon, true, 1);
}

/** Copies the meshes of a built group into another builder, keeping world transforms. */
function bake(into: GeoBuilder, group: THREE.Group) {
  group.updateMatrixWorld(true);
  group.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const g = (o.geometry as THREE.BufferGeometry).clone().applyMatrix4(o.matrixWorld);
    const glow = o.material instanceof THREE.MeshBasicMaterial;
    into.raw(g, glow);
    (o.geometry as THREE.BufferGeometry).dispose();
    if (glow) (o.material as THREE.Material).dispose();
  });
}

// ─── HQ: your company, centre of town ─────────────────────────────────────

export interface HQ extends Built {
  beacon: THREE.MeshBasicMaterial;
  beaconPosition: THREE.Vector3;
  height: number;
}

export function headquarters(name: string, floors: number, seed: number): HQ {
  const r = rng(seed);
  const b = new GeoBuilder();
  b.box(BLOCK, 0.04, BLOCK, 0, 0, 0, PALETTE.plaza);
  // Fountain and plaza trees
  b.cylinder(0.32, 0.36, 0.08, 1.35, 0.04, 1.35, PALETTE.concrete, 12);
  b.cylinder(0.27, 0.27, 0.02, 1.35, 0.1, 1.35, bright(0x3fa9ff, 0.9), 12, true);
  for (const [tx, tz] of [[-1.5, 1.5], [1.5, -1.5], [-1.5, -1.5]] as const) tree(b, r, tx, tz, 0.9, 0.04);

  const floorH = 0.24;
  const w = 1.7;
  const lobby = 0.36;
  b.box(w + 0.3, lobby, w + 0.3, 0, 0.04, 0, PALETTE.concrete);
  b.quad(1.2, 0.24, 0, 0.04 + 0.14, (w + 0.3) / 2 + 0.005, 'z+', warmth(r));
  b.quad(1.2, 0.24, (w + 0.3) / 2 + 0.005, 0.04 + 0.14, 0, 'x+', warmth(r));
  const y0 = 0.04 + lobby;
  const h = floors * floorH;
  b.box(w, h, w, 0, y0, 0, 0x2c3558);
  b.windows({ w, d: w, x: 0, z: 0, y0, rows: floors, rowHeight: floorH, cols: 5 }, r, 0.8, [1.7, 1.25, 0.7], { w: 0.22, h: 0.13 });
  // Corner fins and crown
  for (const [fx, fz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
    b.box(0.08, h + 0.2, 0.08, (fx * w) / 2, y0, (fz * w) / 2, 0x8fa0c8);
  }
  const top = y0 + h;
  b.box(w + 0.1, 0.08, w + 0.1, 0, top, 0, 0x8fa0c8);
  b.box(w * 0.5, 0.3, w * 0.5, 0, top + 0.08, 0, PALETTE.concrete);
  b.cylinder(0.02, 0.04, 0.9, -0.55, top + 0.08, -0.55, PALETTE.concrete, 6);
  const built = b.build();

  // Beacon gets its own material so it can pulse on every push.
  const beacon = new THREE.MeshBasicMaterial({ color: new THREE.Color(...bright(0x6ff2ff, 2)) });
  const beaconPosition = new THREE.Vector3(-0.55, top + 1.06, -0.55);
  const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.09, 1), beacon);
  orb.position.copy(beaconPosition);
  built.group.add(orb);

  // Rooftop neon sign with the company name, angled toward the default camera.
  const sign = neonSign(name);
  sign.position.set(0.15, top + 0.62, 0.15);
  sign.rotation.y = Math.PI / 4;
  built.group.add(sign);

  return { ...built, beacon, beaconPosition, height: top + 1.2 };
}

function neonSign(text: string): THREE.Mesh {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = '700 88px "Space Grotesk", "Avenir Next", system-ui, sans-serif';
  ctx.font = font;
  const label = text.trim().slice(0, 22) || 'HQ';
  canvas.width = Math.ceil(ctx.measureText(label).width + 80);
  canvas.height = 150;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = '#ff4fd8';
  ctx.shadowBlur = 24;
  ctx.fillStyle = '#ffd6f6';
  ctx.fillText(label, canvas.width / 2, canvas.height / 2);
  ctx.shadowBlur = 0;
  ctx.fillText(label, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const height = 0.42;
  const width = (height * canvas.width) / canvas.height;
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    color: new THREE.Color(2.2, 2.2, 2.2),
  });
  material.addEventListener('dispose', () => texture.dispose());
  return new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
}
