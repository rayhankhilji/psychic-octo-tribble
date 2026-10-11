import * as THREE from 'three';
import { GeoBuilder, glowMaterial, type ColorLike } from './geo.ts';
import { PALETTE } from './palette.ts';
import { ISLANDS, LANDMARKS, SEA, terrainHeight } from '../world/map.ts';
import { rng } from '../world/rng.ts';

const ORANGE = 0xc43a2a;
const ORANGE_DARK = 0x9a2c20;
const STEEL = 0xa7b0ba;
const CONCRETE = 0xd4cfc4;
const LAMP: ColorLike = [2.4, 1.75, 0.95];
const RED_LIGHT: ColorLike = [3, 0.3, 0.2];

const m4 = new THREE.Matrix4();
const qt = new THREE.Quaternion();
const ONE = new THREE.Vector3(1, 1, 1);

/** A thin strut between two points (cables, trusses, legs). */
export function strut(b: GeoBuilder, a: THREE.Vector3, c: THREE.Vector3, w: number, color: ColorLike, bucket: 'solid' | 'smooth' | 'glass' = 'solid') {
  const len = a.distanceTo(c);
  const g = new THREE.BoxGeometry(w, len, w);
  const dir = c.clone().sub(a).normalize();
  qt.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  m4.compose(a.clone().add(c).multiplyScalar(0.5), qt, ONE);
  b.transformed(g, m4, color, bucket);
}

/** Catenary-ish curve through anchor points: each span sags by `sag`. */
function cablePoints(anchors: [number, number][], sags: number[], steps = 18): [number, number][] {
  const out: [number, number][] = [];
  for (let s = 0; s < anchors.length - 1; s++) {
    const [ua, ya] = anchors[s]!;
    const [ub, yb] = anchors[s + 1]!;
    for (let k = s === 0 ? 0 : 1; k <= steps; k++) {
      const t = k / steps;
      out.push([ua + (ub - ua) * t, ya + (yb - ya) * t - sags[s]! * 4 * t * (1 - t)]);
    }
  }
  return out;
}

// ─── Golden Gate Bridge ─────────────────────────────────────────────────────

/** Runs along z at x = goldenGate.x, from the Presidio to Marin. */
export function goldenGate(): THREE.Group {
  const b = new GeoBuilder();
  const { x } = LANDMARKS.goldenGate;
  const deckY = 2.25;
  const z0 = 5.2;
  const z1 = 24.2;
  const towers = [11.4, 19.6];
  const top = 8.4;
  const half = 0.6;

  // Deck: asphalt, orange stiffening truss with diagonals, lane lines
  b.box(1.35, 0.1, z1 - z0, x, deckY - 0.1, (z0 + z1) / 2, 0x4b4f58);
  for (const s of [-1, 1]) {
    b.box(0.06, 0.32, z1 - z0, x + s * 0.66, deckY - 0.42, (z0 + z1) / 2, ORANGE);
    b.box(0.08, 0.05, z1 - z0, x + s * 0.66, deckY - 0.02, (z0 + z1) / 2, ORANGE);
    for (let z = z0; z < z1; z += 0.5) {
      strut(b, new THREE.Vector3(x + s * 0.68, deckY - 0.42, z), new THREE.Vector3(x + s * 0.68, deckY - 0.1, z + 0.5), 0.025, ORANGE_DARK);
    }
    b.box(0.03, 0.08, z1 - z0, x + s * 0.62, deckY, (z0 + z1) / 2, ORANGE); // railing
  }
  for (let z = z0 + 0.4; z < z1; z += 0.9) b.box(0.03, 0.004, 0.4, x, deckY + 0.001, z, PALETTE.trim);

  // Towers: tapering legs, stacked portals, art deco recesses
  for (const tz of towers) {
    for (const s of [-1, 1]) {
      const legs: [number, number, number][] = [
        [SEA - 0.4, deckY + 1.8, 0.38],
        [deckY + 1.8, deckY + 4.2, 0.33],
        [deckY + 4.2, top, 0.28],
      ];
      for (const [y0, y1, w] of legs) {
        b.box(w, y1 - y0, w * 1.15, x + s * half, y0, tz, ORANGE);
        b.box(w * 0.42, y1 - y0 - 0.2, 0.02, x + s * half, y0 + 0.1, tz + (w * 1.15) / 2 + 0.006, ORANGE_DARK);
        b.box(w * 0.42, y1 - y0 - 0.2, 0.02, x + s * half, y0 + 0.1, tz - (w * 1.15) / 2 - 0.006, ORANGE_DARK);
      }
    }
    for (const py of [deckY + 1.8, deckY + 3.6, deckY + 5.0, top - 0.3]) {
      b.box(half * 2 + 0.2, 0.3, 0.32, x, py - 0.15, tz, ORANGE);
      for (let k = -1; k <= 1; k++) b.box(0.16, 0.18, 0.02, x + k * 0.32, py - 0.09, tz + 0.17, ORANGE_DARK);
    }
    b.box(1.8, 0.7, 0.9, x, SEA - 0.4, tz, CONCRETE); // fender pier
    for (const s of [-1, 1]) b.blob(0.07, x + s * half, top + 0.12, tz, RED_LIGHT, true);
  }

  // Main cables and suspenders
  const anchors: [number, number][] = [[z0 + 0.6, deckY + 0.25], [towers[0]!, top + 0.05], [towers[1]!, top + 0.05], [z1 - 0.6, deckY + 0.25]];
  const pts = cablePoints(anchors, [0.4, 5.3, 0.4], 22);
  for (const s of [-1, 1]) {
    const curve = new THREE.CatmullRomCurve3(pts.map(([z, y]) => new THREE.Vector3(x + s * (half + 0.02), y, z)));
    b.transformed(new THREE.TubeGeometry(curve, 160, 0.055, 6), new THREE.Matrix4(), ORANGE, 'smooth');
    for (let i = 1; i < pts.length - 1; i++) {
      const [z, y] = pts[i]!;
      if (y - deckY > 0.2) b.box(0.018, y - deckY, 0.018, x + s * (half + 0.02), deckY, z, ORANGE_DARK);
    }
    for (let z = z0 + 0.3; z < z1; z += 0.85) {
      b.cylinder(0.01, 0.01, 0.34, x + s * 0.7, deckY, z, 0x6b6f78, 4);
      b.blob(0.035, x + s * 0.7, deckY + 0.36, z, LAMP, true);
    }
  }
  // Approach viaducts and anchorages
  for (const z of [z0 + 0.6, z1 - 0.6]) b.box(1.7, deckY + 0.6 - (terrainHeight(x, z) - 0.2), 1.4, x, terrainHeight(x, z) - 0.2, z, CONCRETE);
  for (let z = z0 + 1.4; z < towers[0]! - 0.6; z += 1.1) b.box(0.3, deckY - SEA, 0.3, x, SEA, z, CONCRETE);
  for (let z = towers[1]! + 0.8; z < z1 - 1; z += 1.1) b.box(0.3, deckY - SEA, 0.3, x, SEA, z, CONCRETE);

  const { group } = b.build();
  group.traverse((o) => (o.castShadow = true));
  group.userData.tip = { title: 'Golden Gate Bridge', detail: 'Free infrastructure. Rusts if upkeep falls short.' };
  return group;
}

// ─── Bay Bridge ─────────────────────────────────────────────────────────────

export interface BayBridge {
  group: THREE.Group;
  /** The Bay Lights: LED points that shimmer along the suspenders at night. */
  lights: THREE.ShaderMaterial;
}

/** Runs along x at z = bayBridge.z, from SoMa to Yerba Buena and on to Oakland. */
export function bayBridge(): BayBridge {
  const b = new GeoBuilder();
  const { z, x0, x1 } = LANDMARKS.bayBridge;
  const yb = ISLANDS.yerba;
  const deckY = 2.35;
  const top = 7.2;
  const half = 0.55;
  const westEnd = yb.x - yb.r + 0.6;

  // Double deck with a truss between
  for (const [y, w] of [[deckY, 1.25], [deckY - 0.45, 1.15]] as const) b.box(westEnd - x0, 0.09, w, (x0 + westEnd) / 2, y - 0.09, z, 0x50545c);
  for (const s of [-1, 1]) {
    b.box(westEnd - x0, 0.05, 0.05, (x0 + westEnd) / 2, deckY - 0.04, z + s * 0.6, STEEL);
    b.box(westEnd - x0, 0.05, 0.05, (x0 + westEnd) / 2, deckY - 0.5, z + s * 0.6, STEEL);
    for (let x = x0; x < westEnd; x += 0.55) strut(b, new THREE.Vector3(x, deckY - 0.5, z + s * 0.6), new THREE.Vector3(x + 0.55, deckY - 0.04, z + s * 0.6), 0.025, 0x8c949e);
  }

  const towers = [14.6, 19.4, 25.0, 29.8];
  const anchorX = 22.2;
  const lightPos: number[] = [];
  for (const tx of towers) {
    for (const s of [-1, 1]) {
      b.box(0.24, top - SEA, 0.24, tx, SEA, z + s * half, STEEL);
      for (let y = deckY + 0.6; y < top; y += 1.1) strut(b, new THREE.Vector3(tx, y, z - half), new THREE.Vector3(tx, y + 1.1, z + half), 0.04, 0x8c949e);
    }
    for (const y of [deckY + 0.2, top - 0.1]) b.box(0.26, 0.18, half * 2 + 0.24, tx, y, z, STEEL);
    b.box(1.4, 0.6, 1.8, tx, SEA - 0.4, z, CONCRETE);
    b.blob(0.06, tx, top + 0.1, z, RED_LIGHT, true);
  }
  b.box(2.2, deckY + 0.6 - SEA, 2.4, anchorX, SEA, z, CONCRETE); // central anchorage
  b.box(2.4, 0.3, 2.6, anchorX, deckY + 0.6, z, 0xc6c0b4);

  const spans: [number, number][][] = [
    [[x0 + 0.4, deckY + 0.3], [towers[0]!, top], [towers[1]!, top], [anchorX, deckY + 0.9]],
    [[anchorX, deckY + 0.9], [towers[2]!, top], [towers[3]!, top], [westEnd, deckY + 0.6]],
  ];
  for (const anchors of spans) {
    const pts = cablePoints(anchors, [0.3, 4.2, 0.3], 18);
    for (const s of [-1, 1]) {
      const curve = new THREE.CatmullRomCurve3(pts.map(([x, y]) => new THREE.Vector3(x, y, z + s * half)));
      b.transformed(new THREE.TubeGeometry(curve, 120, 0.045, 5), new THREE.Matrix4(), STEEL, 'smooth');
      for (let i = 1; i < pts.length - 1; i++) {
        const [x, y] = pts[i]!;
        if (y - deckY < 0.2) continue;
        b.box(0.014, y - deckY, 0.014, x, deckY, z + s * half, 0x8c949e);
        // Bay Lights: LEDs strung down the north-side suspenders
        if (s > 0) for (let k = 0; k < 6; k++) lightPos.push(x, deckY + ((y - deckY) * (k + 0.5)) / 6, z + half + 0.03);
      }
    }
  }
  // Tunnel portal into Yerba Buena, then the white east span
  b.box(0.5, 0.9, 1.5, westEnd + 0.2, deckY - 0.55, z, CONCRETE);
  const eastStart = yb.x + yb.r - 0.6;
  b.box(x1 - eastStart, 0.1, 1.5, (eastStart + x1) / 2, deckY - 0.1, z, 0xe9e6df);
  for (let x = eastStart + 1; x < x1; x += 1.6) b.box(0.3, deckY - SEA, 0.6, x, SEA, z, 0xe9e6df);
  const sx = eastStart + 4.5;
  b.box(0.35, 9 - SEA, 0.35, sx, SEA, z, 0xf2efe8);
  for (let k = -6; k <= 6; k++) {
    if (!k) continue;
    for (const s of [-1, 1]) strut(b, new THREE.Vector3(sx, 8.6, z), new THREE.Vector3(sx + k * 0.45, deckY, z + s * 0.7), 0.02, 0xf2efe8);
  }
  for (let x = x0 + 0.5; x < x1; x += 1.1) {
    for (const s of [-1, 1]) b.blob(0.03, x, deckY + 0.3, z + s * 0.68, LAMP, true);
  }
  const { group } = b.build();
  group.traverse((o) => (o.castShadow = true));
  group.userData.tip = { title: 'Bay Bridge', detail: 'Free infrastructure. The Bay Lights come on after dark.' };

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(lightPos, 3));
  const lights = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uNight: { value: 0 }, uScale: { value: 3 } },
    vertexShader: /* glsl */ `
      uniform float uTime; uniform float uScale;
      varying float vI;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float wave = sin(position.x * 1.7 - uTime * 2.3) * 0.5 + 0.5;
        float ripple = sin(position.y * 6.0 + position.x * 0.6 + uTime * 3.1) * 0.5 + 0.5;
        vI = 0.25 + 0.75 * wave * ripple;
        gl_PointSize = uScale;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uNight;
      varying float vI;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d) * vI * uNight;
        gl_FragColor = vec4(vec3(1.0, 0.97, 0.9) * 2.4, a);
      }`,
  });
  group.add(new THREE.Points(geo, lights));
  return { group, lights };
}

// ─── Waterfront and city landmarks ──────────────────────────────────────────

/** Ferry Building: a long arcade along the shore with the clock tower facing Market. */
export function ferryBuilding(): THREE.Group {
  const b = new GeoBuilder();
  const r = rng(11);
  const { x, z } = LANDMARKS.ferryBuilding;
  const stone = 0xece4d2;
  b.box(1.9, 0.12, 5.6, x, -0.12, z, CONCRETE);
  b.box(1.35, 0.62, 5.0, x, 0, z, stone);
  b.box(1.45, 0.06, 5.1, x, 0.62, z, 0xd8ccb4);
  b.gable(5.0, 0.22, 1.3, x, 0.68, z, 0x8a8f96, 0.04, Math.PI / 2);
  b.box(0.5, 0.05, 4.6, x, 0.86, z, [1.6, 1.6, 1.5], true); // skylight
  // Arcade arches along the city side
  for (let k = 0; k < 13; k++) {
    const az = z - 2.25 + k * 0.375;
    b.quad(0.2, 0.3, x - 0.68, 0.2, az, 'x-', [1.6, 1.15, 0.6], true, 0.15 + r() * 0.5);
    b.cylinder(0.1, 0.1, 0.02, x - 0.68, 0.33, az, stone, 10, false);
  }
  b.windows({ w: 1.35, d: 5.0, x, z, y0: 0.32, rows: 1, rowHeight: 0.28, cols: 14, faces: ['x-', 'x+'] }, r, 0.8, [1.6, 1.15, 0.6], { w: 0.14, h: 0.14 });
  // Clock tower
  const tz = z;
  const tx = x - 0.05;
  b.box(0.55, 2.2, 0.55, tx, 0.6, tz, stone);
  for (let k = 0; k < 4; k++) b.box(0.6, 0.06, 0.6, tx, 1.0 + k * 0.45, tz, 0xd8ccb4);
  b.windows({ w: 0.55, d: 0.55, x: tx, z: tz, y0: 0.7, rows: 3, rowHeight: 0.45, cols: 2 }, r, 0.6, [1.6, 1.15, 0.6], { w: 0.09, h: 0.22 });
  b.box(0.6, 0.55, 0.6, tx, 2.8, tz, stone);
  for (const f of ['x-', 'x+', 'z+', 'z-'] as const) {
    const [cx, cz] = f === 'x-' ? [tx - 0.31, tz] : f === 'x+' ? [tx + 0.31, tz] : f === 'z+' ? [tx, tz + 0.31] : [tx, tz - 0.31];
    const disc = new THREE.CircleGeometry(0.2, 20);
    disc.rotateY(f === 'x-' ? -Math.PI / 2 : f === 'x+' ? Math.PI / 2 : f === 'z+' ? 0 : Math.PI);
    b.transformed(disc, new THREE.Matrix4().makeTranslation(cx, 3.07, cz), [2.4, 2.3, 2.0], true);
  }
  b.box(0.42, 0.4, 0.42, tx, 3.35, tz, stone);
  b.cylinder(0.02, 0.2, 0.45, tx, 3.75, tz, 0x7a8f86, 8);
  b.cylinder(0.012, 0.012, 0.35, tx, 4.2, tz, 0xd4af37, 4);
  // Ferry slips behind
  for (const dz of [-2.2, 0, 2.2]) b.box(1.4, 0.06, 0.3, x + 1.6, -0.18, z + dz, PALETTE.wood);
  const { group } = b.build();
  group.traverse((o) => (o.castShadow = true));
  group.userData.tip = { title: 'Ferry Building', detail: 'Market Street starts here.' };
  return group;
}

export function coitTower(): THREE.Group {
  const b = new GeoBuilder();
  const { x, z } = LANDMARKS.coitTower;
  const y = terrainHeight(x, z);
  b.cylinder(0.75, 0.85, 0.12, x, y - 0.06, z, 0xd9d3c5, 20);
  b.cylinder(0.32, 0.36, 0.3, x, y + 0.05, z, 0xece6d8, 16);
  const flutes = new THREE.CylinderGeometry(0.24, 0.26, 2.1, 16);
  flutes.translate(x, y + 0.35 + 1.05, z);
  b.transformed(flutes, new THREE.Matrix4(), 0xf2ede2);
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    b.box(0.035, 2.1, 0.035, x + Math.cos(a) * 0.255, y + 0.35, z + Math.sin(a) * 0.255, 0xe2dccd);
  }
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + 0.2;
    const g = new THREE.PlaneGeometry(0.07, 0.18);
    g.rotateY(-a + Math.PI / 2);
    g.translate(x + Math.cos(a) * 0.245, y + 2.25, z + Math.sin(a) * 0.245);
    b.transformed(g, new THREE.Matrix4(), [1.7, 1.3, 0.7], true);
  }
  b.cylinder(0.27, 0.27, 0.08, x, y + 2.45, z, 0xe2dccd, 16);
  b.cylinder(0.2, 0.25, 0.1, x, y + 2.53, z, 0xe2dccd, 16);
  b.blob(0.05, x, y + 2.7, z, RED_LIGHT, true);
  const { group } = b.build();
  group.traverse((o) => (o.castShadow = true));
  group.userData.tip = { title: 'Coit Tower', detail: 'On Telegraph Hill.' };
  return group;
}

export function palaceOfFineArts(): THREE.Group {
  const b = new GeoBuilder();
  const { x, z } = LANDMARKS.palaceOfFineArts;
  const salmon = 0xdba586;
  const lagoon = new THREE.CircleGeometry(1.5, 24).rotateX(-Math.PI / 2).scale(1.3, 1, 0.8);
  b.transformed(lagoon, new THREE.Matrix4().makeTranslation(x + 0.6, 0.03, z + 0.9), 0x3aa7b8, 'glass');
  // Rotunda on an octagon of columns
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    b.cylinder(0.05, 0.06, 0.8, x + Math.cos(a) * 0.55, 0.02, z + Math.sin(a) * 0.55, salmon, 8);
  }
  b.cylinder(0.66, 0.66, 0.16, x, 0.82, z, salmon, 16);
  b.lathe([[0.62, 0], [0.6, 0.18], [0.5, 0.38], [0.34, 0.52], [0.14, 0.6], [0, 0.62]], x, 0.98, z, 0xc08a6c, 20);
  b.cylinder(0.04, 0.06, 0.12, x, 1.6, z, salmon, 8);
  // Curved colonnade behind
  for (let k = 0; k <= 14; k++) {
    const a = Math.PI * (0.9 + (k / 14) * 0.8);
    b.cylinder(0.035, 0.04, 0.55, x + 0.4 + Math.cos(a) * 2.2, 0.02, z + 0.5 + Math.sin(a) * 2.2, salmon, 6);
  }
  const arc = new THREE.TorusGeometry(2.2, 0.06, 4, 24, Math.PI * 0.8).rotateX(Math.PI / 2).rotateY(-Math.PI * 0.9);
  b.transformed(arc, new THREE.Matrix4().makeTranslation(x + 0.4, 0.6, z + 0.5), salmon);
  const { group } = b.build();
  group.traverse((o) => (o.castShadow = true));
  group.userData.tip = { title: 'Palace of Fine Arts', detail: 'Rotunda, colonnade and lagoon.' };
  return group;
}

export function sutroTower(): THREE.Group {
  const b = new GeoBuilder();
  const { x, z } = LANDMARKS.sutroTower;
  const y = terrainHeight(x, z) - 0.1;
  const feet = [0, 1, 2].map((k) => new THREE.Vector3(x + Math.cos((k / 3) * Math.PI * 2) * 0.8, y, z + Math.sin((k / 3) * Math.PI * 2) * 0.8));
  const waist = [0, 1, 2].map((k) => new THREE.Vector3(x + Math.cos((k / 3) * Math.PI * 2) * 0.32, y + 3.0, z + Math.sin((k / 3) * Math.PI * 2) * 0.32));
  const tops = [0, 1, 2].map((k) => new THREE.Vector3(x + Math.cos((k / 3) * Math.PI * 2) * 0.45, y + 5.2, z + Math.sin((k / 3) * Math.PI * 2) * 0.45));
  for (let k = 0; k < 3; k++) {
    // Red and white bands
    for (let s = 0; s < 6; s++) {
      const a = feet[k]!.clone().lerp(waist[k]!, s / 6);
      const c = feet[k]!.clone().lerp(waist[k]!, (s + 1) / 6);
      strut(b, a, c, 0.09, s % 2 ? 0xf4f2ee : 0xd23a2c);
    }
    for (let s = 0; s < 4; s++) {
      const a = waist[k]!.clone().lerp(tops[k]!, s / 4);
      const c = waist[k]!.clone().lerp(tops[k]!, (s + 1) / 4);
      strut(b, a, c, 0.06, s % 2 ? 0xd23a2c : 0xf4f2ee);
    }
    b.blob(0.06, tops[k]!.x, tops[k]!.y + 0.08, tops[k]!.z, RED_LIGHT, true);
  }
  for (const t of [0.35, 1, 1.25]) {
    const p = (i: number) => (t <= 1 ? feet[i]!.clone().lerp(waist[i]!, t) : waist[i]!.clone().lerp(tops[i]!, t - 1));
    for (let k = 0; k < 3; k++) strut(b, p(k), p((k + 1) % 3), 0.05, 0xb9b2a6);
  }
  const { group } = b.build();
  group.traverse((o) => (o.castShadow = true));
  group.userData.tip = { title: 'Sutro Tower', detail: 'Keeps an eye on the city.' };
  return group;
}

export interface Windmill {
  group: THREE.Group;
  sails: THREE.Group;
}

export function windmill(): Windmill {
  const b = new GeoBuilder();
  const { x, z } = LANDMARKS.windmill;
  const y = terrainHeight(x, z);
  b.cylinder(0.32, 0.5, 1.5, x, y, z, 0xe9e0cc, 8);
  b.cylinder(0.52, 0.52, 0.06, x, y + 0.5, z, 0x6b4f3a, 8);
  b.windows({ w: 0.6, d: 0.6, x, z, y0: y + 0.6, rows: 2, rowHeight: 0.35, cols: 1, faces: ['x+', 'z+'] }, () => 0.2, 1, [1.6, 1.15, 0.6], { w: 0.08, h: 0.12 });
  b.lathe([[0.36, 0], [0.34, 0.12], [0.2, 0.32], [0, 0.4]], x, y + 1.5, z, 0x5b4636, 8);
  const { group } = b.build();
  const sb = new GeoBuilder();
  for (let k = 0; k < 4; k++) {
    const g = new THREE.BoxGeometry(0.16, 1.15, 0.02);
    g.translate(0.05, 0.62, 0);
    g.rotateZ((k / 4) * Math.PI * 2);
    sb.transformed(g, new THREE.Matrix4(), 0xf4efe2);
    const spar = new THREE.BoxGeometry(0.03, 1.2, 0.03);
    spar.translate(0, 0.6, 0);
    spar.rotateZ((k / 4) * Math.PI * 2);
    sb.transformed(spar, new THREE.Matrix4(), 0x5b4636);
  }
  const sails = sb.build().group;
  sails.position.set(x + 0.42, y + 1.62, z + 0.42);
  sails.rotation.y = Math.PI / 4;
  const pivot = new THREE.Group();
  pivot.add(sails);
  group.add(pivot);
  group.traverse((o) => (o.castShadow = true));
  group.userData.tip = { title: 'Dutch Windmill', detail: 'At the ocean end of Golden Gate Park.' };
  return { group, sails };
}

export function conservatory(x: number, z: number): THREE.Group {
  const b = new GeoBuilder();
  const y = terrainHeight(x, z);
  b.box(3, 0.04, 1.8, x, y, z, 0xd9d3c5);
  b.box(2.6, 0.45, 0.6, x, y + 0.02, z, 0xf4f6f4);
  b.lathe([[0.55, 0], [0.52, 0.2], [0.42, 0.42], [0.26, 0.58], [0, 0.66]], x, y + 0.46, z, 0xeaf3f5, 16, 'glass');
  for (let k = 0; k < 8; k++) b.box(0.02, 0.43, 0.62, x - 1.2 + k * 0.34, y + 0.02, z, 0xffffff);
  b.cylinder(0.04, 0.04, 0.12, x, y + 1.12, z, 0xffffff, 6);
  for (let k = 0; k < 7; k++) b.blob(0.09, x - 1 + k * 0.33, y + 0.08, z + 0.6, [0xe85a8a, 0xf2c84b, 0xe8873a, 0xb97ad8][k % 4]!, 'smooth', 1);
  const { group } = b.build();
  group.traverse((o) => (o.castShadow = true));
  group.userData.tip = { title: 'Conservatory of Flowers', detail: 'Golden Gate Park.' };
  return group;
}

export function cliffHouse(): THREE.Group {
  const b = new GeoBuilder();
  const x = -46.8;
  const z = -1.6;
  const y = Math.max(0.2, terrainHeight(x, z));
  b.box(1.4, 0.5, 0.9, x, y - 0.1, z, 0xf0ece4);
  b.box(1.5, 0.05, 1.0, x, y + 0.4, z, 0x8a8f96);
  b.windows({ w: 1.4, d: 0.9, x, z, y0: y - 0.1, rows: 1, rowHeight: 0.5, cols: 5, faces: ['x-', 'z+'] }, () => 0.3, 1, [1.6, 1.15, 0.6], { w: 0.2, h: 0.25 });
  // Seal Rocks
  for (const [rx, rz, rr] of [[-50.5, -0.8, 0.6], [-51.3, 0.6, 0.45], [-50.2, 1.4, 0.35]] as const) {
    const g = new THREE.IcosahedronGeometry(rr, 1).scale(1, 0.8, 1);
    b.transformed(g, new THREE.Matrix4().makeTranslation(rx, SEA + 0.1, rz), 0x8f857a);
  }
  // Sutro Baths ruins
  for (let k = 0; k < 4; k++) b.box(0.08, 0.1, 1.6, -47.5 + k * 0.5, SEA, 4.5, 0xbab3a6);
  const { group } = b.build();
  group.traverse((o) => (o.castShadow = true));
  group.userData.tip = { title: 'Cliff House', detail: 'Lands End, above Seal Rocks.' };
  return group;
}

// ─── The sign ───────────────────────────────────────────────────────────────

const LETTER_WIDTH: Record<string, number> = { T: 0.62, I: 0.2, N: 0.62, Y: 0.64, O: 0.66, W: 0.86 };

function letterShape(ch: string, h: number): THREE.Shape {
  const w = LETTER_WIDTH[ch]! * h;
  const s = 0.13 * h;
  const P = (pts: [number, number][]) => new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  switch (ch) {
    case 'T':
      return P([[0, h], [w, h], [w, h - s], [(w + s) / 2, h - s], [(w + s) / 2, 0], [(w - s) / 2, 0], [(w - s) / 2, h - s], [0, h - s]]);
    case 'I':
      return P([[0, 0], [w, 0], [w, h], [0, h]]);
    case 'N':
      return P([[0, 0], [s, 0], [s, h * 0.66], [w - s, 0], [w, 0], [w, h], [w - s, h], [w - s, h * 0.34], [s, h], [0, h]]);
    case 'Y':
      return P([[0, h], [s * 1.15, h], [w / 2, h * 0.6], [w - s * 1.15, h], [w, h], [w / 2 + s / 2, h * 0.46], [w / 2 + s / 2, 0], [w / 2 - s / 2, 0], [w / 2 - s / 2, h * 0.46]]);
    case 'W':
      return P([[0, h], [s, h], [w * 0.27, h * 0.24], [w * 0.44, h * 0.8], [w * 0.56, h * 0.8], [w * 0.73, h * 0.24], [w - s, h], [w, h], [w * 0.8, 0], [w * 0.66, 0], [w * 0.5, h * 0.58], [w * 0.34, 0], [w * 0.2, 0]]);
    case 'O': {
      const shape = new THREE.Shape();
      shape.absellipse(w / 2, h / 2, w / 2, h / 2, 0, Math.PI * 2, false, 0);
      const hole = new THREE.Path();
      hole.absellipse(w / 2, h / 2, w / 2 - s, h / 2 - s, 0, Math.PI * 2, true, 0);
      shape.holes.push(hole);
      return shape;
    }
    default:
      return P([[0, 0], [w, 0], [w, h], [0, h]]);
  }
}

export interface Sign {
  group: THREE.Group;
  material: THREE.MeshStandardMaterial;
  floodlights: THREE.MeshBasicMaterial;
}

/** TINYTOWN, Hollywood style, on Twin Peaks facing the city, with floodlights. */
export function sign(): Sign {
  const material = new THREE.MeshStandardMaterial({ color: 0xfbfaf6, roughness: 0.55, emissive: 0xfff4dc, emissiveIntensity: 0 });
  const post = new THREE.MeshStandardMaterial({ color: 0x55504a, roughness: 0.9 });
  const floodlights = glowMaterial({ color: new THREE.Color(2.6, 2.3, 1.7) });
  const g = new THREE.Group();
  const letters = 'TINYTOWN';
  const height = 2.7;
  const gap = 0.42;
  const widths = [...letters].map((ch) => LETTER_WIDTH[ch]! * height);
  const total = widths.reduce((a, c) => a + c, 0) + gap * (letters.length - 1);
  const right = new THREE.Vector3(Math.SQRT1_2, 0, -Math.SQRT1_2);
  const { x: cx, z: cz } = LANDMARKS.sign;
  const centreY = terrainHeight(cx, cz);
  let u = -total / 2;
  [...letters].forEach((ch, i) => {
    const w = widths[i]!;
    const p = new THREE.Vector3(cx, 0, cz).addScaledVector(right, u + w / 2);
    const ground = terrainHeight(p.x, p.z);
    const y = Math.max(ground - 0.3, ground * 0.35 + centreY * 0.65);
    const geo = new THREE.ExtrudeGeometry(letterShape(ch, height), { depth: 0.12, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 1 });
    geo.translate(-w / 2, 0, 0);
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = true;
    mesh.position.set(p.x, y - 0.05 + Math.sin(i * 1.7) * 0.08, p.z);
    mesh.rotation.set(-0.1, Math.PI / 4 + Math.sin(i * 2.3) * 0.035, 0, 'YXZ');
    g.add(mesh);
    for (const s of [-0.3, 0.3]) {
      const behind = p.clone().addScaledVector(right, s * w).add(new THREE.Vector3(-0.22, 0, -0.22));
      const gy = terrainHeight(behind.x, behind.z);
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, y + height * 0.75 - gy, 0.05), post);
      leg.position.set(behind.x, (gy + y + height * 0.75) / 2, behind.z);
      g.add(leg);
    }
    // A floodlight in front of each letter, pointing up at it
    const f = p.clone().add(new THREE.Vector3(0.6, 0, 0.6));
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.12), floodlights);
    lamp.position.set(f.x, terrainHeight(f.x, f.z) + 0.05, f.z);
    g.add(lamp);
    u += w + gap;
  });
  g.userData.tip = { title: 'The TINYTOWN sign', detail: 'Lit at night while upkeep is paid. It goes dark first when money runs short.' };
  return { group: g, material, floodlights };
}
