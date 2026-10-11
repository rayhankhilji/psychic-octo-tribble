import * as THREE from 'three';
import { GeoBuilder, type ColorLike } from './geo.ts';
import { PALETTE } from './palette.ts';
import { bright, palm, warmth, type Built } from './buildings.ts';
import { pick, rng } from '../world/rng.ts';
import { BLOCK } from '../world/layout.ts';

/**
 * Commercial buildings: towers, campuses, the pyramid, the supertall, and
 * your HQ. Positions are world (x, z) at ground level unless noted.
 */

/** Art deco pastels with neon blades, Sunset Strip style. */
export function deco(b: GeoBuilder, r: () => number, x: number, z: number, neon: ColorLike) {
  const h = 1.1 + r() * 0.8;
  const w = 1.5;
  const wall = pick(r, [0xf3c6a2, 0xbfe4d0, 0xf8f5ee, 0xeab6cf, 0xf6df8c] as const);
  b.box(w, h, w, x, 0.03, z, wall);
  b.box(w * 0.6, 0.3, w * 0.6, x, 0.03 + h, z, wall);
  b.box(w * 0.3, 0.25, w * 0.3, x, 0.33 + h, z, PALETTE.trim);
  for (let f = 1; f < Math.floor(h / 0.24); f++) b.box(w + 0.02, 0.025, w + 0.02, x, 0.03 + f * 0.24, z, PALETTE.trim);
  b.windows({ w, d: w, x, z, y0: 0.4, rows: Math.floor((h - 0.4) / 0.24), rowHeight: 0.24, cols: 4 }, r, 0.55, r() < 0.5 ? warmth(r) : PALETTE.windowCool);
  for (const f of ['x+', 'z+'] as const) {
    const [qx, qz] = f === 'x+' ? [x + w / 2 + 0.005, z] : [x, z + w / 2 + 0.005];
    b.quad(1.2, 0.18, qx, 0.2, qz, f, neon);
  }
  b.box(0.06, h * 0.6, 0.3, x + w / 2 + 0.03, h * 0.3, z + 0.35, neon, true);
  b.box(0.3, h * 0.6, 0.06, x - 0.35, h * 0.35, z + w / 2 + 0.03, bright(0xffd23f, 2.2), true);
}

export function campus(b: GeoBuilder, r: () => number, x: number, z: number, neon: ColorLike) {
  const h = 0.6 + r() * 0.5;
  b.box(1.6, 0.03, 1.6, x, 0.03, z, PALETTE.lawn);
  b.box(1.3, h, 1.0, x, 0.06, z - 0.15, PALETTE.glass);
  b.box(1.36, 0.05, 1.06, x, 0.06 + h, z - 0.15, PALETTE.trim);
  b.windows({ w: 1.3, d: 1.0, x, z: z - 0.15, y0: 0.06, rows: Math.round(h / 0.22), rowHeight: 0.22, cols: 6 }, r, 0.75, PALETTE.windowCool, { w: 0.17, h: 0.12 });
  for (let i = 0; i < 3; i++) b.box(0.3, 0.02, 0.18, x - 0.4 + i * 0.4, 0.11 + h, z - 0.15, 0x2a3f66);
  b.quad(0.7, 0.08, x, 0.06 + h - 0.08, z + 0.354, 'z+', neon);
  palm(b, r, x + 0.55, z + 0.6, 0.7, 0.06);
  palm(b, r, x - 0.55, z + 0.6, 0.7, 0.06);
}

/** Blue glass tower with white floor bands. */
export function tower(b: GeoBuilder, r: () => number, x: number, z: number, tier: number, neon: ColorLike) {
  const h = (tier - 1) * (0.9 + r() * 0.5) + 0.8;
  const w = 1.1 + r() * 0.35;
  const glassy = r() < 0.7;
  const wall = glassy ? pick(r, [0x7db3dd, 0x5e98c8, 0x9cc9ea] as const) : pick(r, [0xdcd3c3, 0xece6da, 0xb9c6d2] as const);
  const band = glassy ? PALETTE.trim : 0x9a8f80;
  const light = r() < 0.6 ? warmth(r) : PALETTE.windowCool;
  const podium = 0.35;
  b.box(w + 0.3, podium, w + 0.3, x, 0.03, z, PALETTE.concrete);
  const lower = h * (0.6 + r() * 0.15);
  const w2 = w * 0.74;
  const y2 = 0.03 + podium + lower;
  const upper = h - lower;
  for (const [bw, by, bh] of [[w, 0.03 + podium, lower], [w2, y2, upper]] as const) {
    b.box(bw, bh, bw, x, by, z, wall);
    const rows = Math.floor(bh / 0.2);
    b.windows({ w: bw, d: bw, x, z, y0: by, rows, rowHeight: 0.2, cols: glassy ? 3 : 4 }, r, 0.55, light, { w: glassy ? 0.2 : 0.14, h: 0.1 });
    for (let f = 0; f <= rows; f += glassy ? 2 : 1) b.box(bw + 0.015, 0.022, bw + 0.015, x, by + f * 0.2, z, band);
    for (const [cx, cz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) b.box(0.035, bh, 0.035, x + (cx * bw) / 2, by, z + (cz * bw) / 2, band);
  }
  b.box(w2 + 0.02, 0.05, w2 + 0.02, x, y2 + upper - 0.12, z, neon, true);
  if (tier >= 5) {
    b.cylinder(w2 * 0.4, w2 * 0.4, 0.04, x, y2 + upper, z, 0x55606e, 16);
    b.box(0.16, 0.005, 0.03, x, y2 + upper + 0.04, z, PALETTE.trim); // helipad "H"
  } else {
    b.box(w2 * 0.6, 0.15, w2 * 0.6, x, y2 + upper, z, PALETTE.concrete);
  }
  b.cylinder(0.012, 0.02, 0.5, x + w2 * 0.3, y2 + upper, z - w2 * 0.3, PALETTE.steel, 4);
  b.blob(0.035, x + w2 * 0.3, y2 + upper + 0.52, z - w2 * 0.3, bright(0xff2a2a, 3), true);
}

/** A Transamerica-style pyramid for the Financial District. */
export function pyramid(b: GeoBuilder, r: () => number, x: number, z: number) {
  const h = 6.2;
  b.box(1.7, 0.3, 1.7, x, 0.03, z, PALETTE.concrete);
  b.cylinder(0.08, 0.95, h, x, 0.33, z, 0xf2efe8, 4, false, Math.PI / 4);
  for (let f = 1; f < 26; f++) {
    const y = 0.33 + f * (h / 28);
    const half = 0.95 - (0.87 * (y - 0.33)) / h;
    for (const face of ['x+', 'z+', 'x-', 'z-'] as const) {
      const [dx, dz] = face === 'x+' ? [half * Math.SQRT1_2, 0] : face === 'x-' ? [-half * Math.SQRT1_2, 0] : face === 'z+' ? [0, half * Math.SQRT1_2] : [0, -half * Math.SQRT1_2];
      b.quad(half * 0.9, 0.06, x + dx + Math.sign(dx) * 0.012, y, z + dz + Math.sign(dz) * 0.012, face, r() < 0.6 ? warmth(r) : PALETTE.darkGlass, true);
    }
  }
  // Side "wings" with the elevator shafts
  b.box(0.22, h * 0.55, 0.12, x, 0.33 + h * 0.35, z + 0.42, 0xf2efe8);
  b.box(0.12, h * 0.55, 0.22, x + 0.42, 0.33 + h * 0.35, z, 0xf2efe8);
  b.cylinder(0.01, 0.06, 1.0, x, 0.33 + h - 0.1, z, 0xf2efe8, 4, false, Math.PI / 4);
}

export function spire(b: GeoBuilder, r: () => number, x: number, z: number, neon: ColorLike) {
  b.box(3.2, 0.4, 3.2, x, 0.03, z, PALETTE.concrete);
  let w = 2.0;
  let y = 0.43;
  for (let s = 0; s < 6; s++) {
    const h = 1.6 - s * 0.12;
    b.box(w, h, w, x, y, z, 0x7db3dd);
    b.windows({ w, d: w, x, z, y0: y, rows: Math.floor(h / 0.2), rowHeight: 0.2, cols: Math.max(3, Math.round(w * 3)) }, r, 0.7, PALETTE.windowCool, { w: 0.12, h: 0.1 });
    b.box(w + 0.04, 0.05, w + 0.04, x, y + h - 0.05, z, neon, true);
    b.box(w + 0.03, 0.03, w + 0.03, x, y, z, PALETTE.trim);
    y += h;
    w *= 0.8;
  }
  b.cylinder(0.02, 0.1, 2.4, x, y, z, PALETTE.steel, 6);
  b.blob(0.12, x, y + 2.5, z, neon, true, 1);
}

// ─── HQ: your company, centre of town ─────────────────────────────────────

export interface HQ extends Built {
  beacon: THREE.MeshBasicMaterial;
  sign: THREE.MeshBasicMaterial;
  height: number;
}

/**
 * Your company. `level` is the HQ upgrade bought (0 garage … 4 landmark);
 * `floors` comes from releases, capped by what the level has room for.
 */
export function headquarters(name: string, floors: number, seed: number, level = 1): HQ {
  const r = rng(seed);
  const b = new GeoBuilder();
  b.box(BLOCK, 0.04, BLOCK, 0, 0, 0, PALETTE.plaza);
  // Fountain, palms, lawn strips (the west corner is the founder's lot)
  b.cylinder(0.34, 0.38, 0.08, 1.35, 0.04, 1.35, PALETTE.concrete, 14);
  b.cylinder(0.29, 0.29, 0.02, 1.35, 0.1, 1.35, PALETTE.pool, 14);
  b.cylinder(0.03, 0.05, 0.22, 1.35, 0.1, 1.35, PALETTE.trim, 6);
  for (const [tx, tz] of [[1.5, -1.5], [-1.5, -1.5], [-0.4, 1.6], [1.6, 0.4]] as const) palm(b, r, tx, tz, 1.0, 0.04);
  b.box(3.6, 0.02, 0.3, 0, 0.04, -1.7, PALETTE.lawn);

  let top: number;
  if (level === 0) {
    // The garage: where it starts
    b.box(1.2, 0.5, 0.9, 0, 0.04, 0, 0xf3c6a2);
    b.gable(1.2, 0.26, 0.9, 0, 0.54, 0, PALETTE.roofs[0]);
    b.quad(0.6, 0.34, 0, 0.21, 0.454, 'z+', 0xe8e2d6, false);
    for (let k = 0; k < 4; k++) b.box(0.6, 0.008, 0.005, 0, 0.08 + k * 0.08, 0.456, 0xc9c2b4);
    b.quad(0.16, 0.12, 0.6 + 0.004, 0.32, 0, 'x+', warmth(r));
    top = 0.8;
  } else {
    const floorH = 0.24;
    const w = [0, 1.3, 1.5, 1.7, 1.85][level]!;
    const lobby = 0.36;
    if (level === 2) {
      // Campus wings
      for (const s of [-1, 1]) {
        b.box(0.7, 0.5, 2.6, s * 1.25, 0.04, 0.2, 0xf8f5ee);
        b.box(0.74, 0.04, 2.64, s * 1.25, 0.54, 0.2, PALETTE.lawn);
        b.windows({ w: 0.7, d: 2.6, x: s * 1.25, z: 0.2, y0: 0.04, rows: 2, rowHeight: 0.25, cols: 6, faces: [s > 0 ? 'x+' : 'x-', 'z+'] }, r, 0.6, warmth(r));
      }
    }
    b.box(w + 0.3, lobby, w + 0.3, 0, 0.04, 0, PALETTE.trim);
    b.quad(w * 0.7, 0.24, 0, 0.04 + 0.14, (w + 0.3) / 2 + 0.005, 'z+', warmth(r));
    b.quad(w * 0.7, 0.24, (w + 0.3) / 2 + 0.005, 0.04 + 0.14, 0, 'x+', warmth(r));
    const y0 = 0.04 + lobby;
    const h = floors * floorH;
    b.box(w, h, w, 0, y0, 0, level >= 3 ? 0x4f8cc4 : 0x5e98c8);
    b.windows({ w, d: w, x: 0, z: 0, y0, rows: floors, rowHeight: floorH, cols: level >= 3 ? 6 : 5 }, r, 0.55, [1.1, 0.8, 0.45], { w: 0.22, h: 0.15 });
    for (let f = 0; f <= floors; f++) b.box(w + 0.02, 0.025, w + 0.02, 0, y0 + f * floorH, 0, PALETTE.trim);
    for (const [fx, fz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      b.box(0.08, h + 0.2, 0.08, (fx * w) / 2, y0, (fz * w) / 2, PALETTE.trim);
    }
    top = y0 + h;
    b.box(w + 0.1, 0.08, w + 0.1, 0, top, 0, PALETTE.trim);
    if (level >= 2) {
      // Roof garden
      b.box(w - 0.1, 0.05, w - 0.1, 0, top + 0.08, 0, PALETTE.lawn);
      palm(b, r, -0.5, 0.5, 0.5, top + 0.13);
      palm(b, r, 0.55, -0.45, 0.45, top + 0.13);
    }
    if (level === 4) {
      // Landmark crown: stepped glass and a spire
      let cw = w * 0.8;
      let cy = top + 0.08;
      for (let k = 0; k < 3; k++) {
        b.box(cw, 0.5, cw, 0, cy, 0, 0x7db3dd);
        b.box(cw + 0.03, 0.04, cw + 0.03, 0, cy + 0.46, 0, [2.2, 1.9, 1.2], true);
        cy += 0.5;
        cw *= 0.72;
      }
      b.cylinder(0.02, 0.07, 2.2, 0, cy, 0, PALETTE.trim, 6);
      top = cy;
    }
  }
  b.cylinder(0.02, 0.04, 0.9, -0.55, top + 0.08, -0.55, PALETTE.steel, 6);
  const built = b.build();

  // Beacon gets its own material so it can pulse on every push.
  const beacon = new THREE.MeshBasicMaterial({ color: new THREE.Color(...bright(0x6ff2ff, 2)) });
  const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.09, 1), beacon);
  orb.position.set(-0.55, top + 1.06, -0.55);
  built.group.add(orb);

  // Rooftop sign with the company name, angled toward the default camera.
  const { mesh, material } = rooftopSign(name);
  mesh.position.set(0.25, top + 0.42, 0.25);
  mesh.rotation.y = Math.PI / 4;
  built.group.add(mesh);

  return { ...built, beacon, sign: material, height: top + 1.2 };
}

function rooftopSign(text: string): { mesh: THREE.Group; material: THREE.MeshBasicMaterial } {
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
  ctx.shadowBlur = 18;
  ctx.fillStyle = '#ffe8fb';
  ctx.fillText(label, canvas.width / 2, canvas.height / 2);
  ctx.shadowBlur = 0;
  ctx.fillText(label, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const height = 0.4;
  const width = (height * canvas.width) / canvas.height;
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  material.addEventListener('dispose', () => texture.dispose());
  const g = new THREE.Group();
  const face = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
  face.position.z = 0.03;
  // A dark backing board so the letters read in daylight too.
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(width * 0.92, height * 0.9, 0.04),
    new THREE.MeshStandardMaterial({ color: 0x23304a, roughness: 0.6 }),
  );
  board.castShadow = true;
  for (const lx of [-width * 0.3, width * 0.3]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.3, 0.03), new THREE.MeshStandardMaterial({ color: PALETTE.steel }));
    leg.position.set(lx, -0.3, 0);
    g.add(leg);
  }
  g.add(board, face);
  return { mesh: g, material };
}
