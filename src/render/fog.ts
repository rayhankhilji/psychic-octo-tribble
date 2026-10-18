import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLOW } from './geo.ts';
import { atmosphereAt, type Atmosphere } from '../world/daylight.ts';
import { rng } from '../world/rng.ts';
import type { Built } from './buildings.ts';

/**
 * Karl the Fog over land that isn't open yet: San Francisco's marine layer,
 * low and soft, lying over a block like it does over the Sunset on a June
 * morning. Each bank is a thin, wide haze that spills into the streets and,
 * on it, one rolling surface of broad billows heaped into a crown or two
 * (on a city block, one thin spot where the pavement shows through), with a
 * couple of wisps drifting just above. Over the Hills and the islands the
 * bank lies level on the land's broad lie, so the higher tops poke through.
 *
 * Every bank in a layer is merged into one mesh with one shader, so all the
 * fog in the city costs one draw call. The shader does the look: soft edges
 * where the surface turns away from the camera and where it thins out, folds
 * in shade and crests in light, sunlit tops over blue-violet shade, peach at
 * golden hour, moonlit silver-blue with a warm glow from the streets below at
 * night, and a slow swell (one shared time uniform; nothing per frame on the
 * CPU). When land opens, its bank burns off over 1.2 s: it lifts, spreads
 * and thins, its edges and thin patches clearing first. One uniform per bank
 * drives it.
 */

/** Banks a layer can hold at once (each has a slot in the shader's uniform array). */
const SLOTS = 24;
/** How long a bank takes to burn off, in seconds. */
const BURN = 1.2;
/** Grid spacing of a bank's surface, in map units. */
const STEP = 0.24;

export interface FogSpec {
  /** Centre of the land under the bank. */
  x: number;
  z: number;
  /** Footprint to cover. The fog spills a little past it. */
  w: number;
  d: number;
  /** Plateau height above the ground, before the billows. */
  height?: number;
  /** How far past the footprint the fog spills (into the streets around a block). */
  spill?: number;
  /** Ground height under the bank (the Hills and islands); flat at 0 otherwise. */
  ground?: (x: number, z: number) => number;
  /** Size of the billows on top (1 for a city block). Bigger is calmer: broad swells over open country. */
  billow?: number;
  /**
   * The broad lie of the land the bank rests on (see `smoothGround`). Banks that share one lie
   * flat into each other without seams. Without it, a terrain bank fits a plane to its own ground.
   */
  floor?: (x: number, z: number) => number;
  /** How much of the bank to keep at each point, 0 to 1: a clearing around something that should stand clear of the fog. */
  keep?: (x: number, z: number) => number;
  /** Areas the tooltip answers over, when the bank's shape (`keep`) leaves gaps in its footprint. The whole footprint otherwise. */
  picks?: { x: number; z: number; w: number; d: number }[];
  /** Grid spacing of the surface: coarser for the broad banks over far country, seen from a long way off. */
  step?: number;
  /** How heaped up the top is: 1 for the low marine layer over a block; more for cloud banks with rounded heads. */
  heap?: number;
  /** The thin haze spilling out round the bank's foot (into the streets round a block). On by default. */
  haze?: boolean;
  seed: number;
}

/** One bank's surface, ready to merge: positions, normals, uvs, fog data, triangles. */
interface BankGeo {
  pos: Float32Array;
  nrm: Float32Array;
  uv: Float32Array;
  /** Per vertex: slot, height above the ground, burn order (1 burns first), opacity (below zero for a wisp). */
  fog: Float32Array;
  /** Per vertex: how far in from the bank's outline, 0 at the outline to 1 inside. The shader fades the edges by it. */
  edge: Float32Array;
  index: number[];
  /** The bank's main layer, as triangles of the same vertices: the soft-shadow pass's stand-in (see `shieldMaterial`). */
  solid: number[];
  /** Radius the burn-off measures "edge" against, and the pick volume. */
  radius: number;
  lo: number;
  hi: number;
}

// ─── Light ──────────────────────────────────────────────────────────────────

/** Shared by every fog material, so the hour changes all of them at once. */
const LIGHT = {
  uTime: GLOW.time,
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uLit: { value: new THREE.Color(1, 1, 1) },
  uShade: { value: new THREE.Color(0.7, 0.74, 0.9) },
  uSky: { value: new THREE.Color(0.8, 0.9, 1) },
  uGlow: { value: new THREE.Color(0, 0, 0) },
  uHaze: { value: new THREE.Color(0.84, 0.92, 0.97) },
  uDensity: { value: 0.96 },
};

const WHITE = new THREE.Color(1, 1, 1);
/** Shade under a bank by day: the blue-violet of a cool shadow on white. */
const VIOLET = new THREE.Color(0.42, 0.44, 0.88);
/** Under a full moon: silver-blue tops, deep blue shade. Kept lighter than the land at night, so fogged blocks never read as holes. */
const MOON_LIT = new THREE.Color(0.075, 0.1, 0.18);
const MOON_SHADE = new THREE.Color(0.025, 0.033, 0.07);
/** Sodium streetlight glow on the underside of the fog, at night. */
const CITY_GLOW = new THREE.Color(0.05, 0.025, 0.008);
const tmp = new THREE.Color();
const tmp2 = new THREE.Color();

/**
 * Lights the fog for the hour. By day the tops take the sun's colour
 * (white at noon, peach at golden hour) over blue-violet shade; as night
 * falls they go moonlit silver-blue and the streets below warm their
 * undersides. Call every frame with the world's atmosphere.
 */
export function setFogLight(a: Atmosphere) {
  // `night` is already halfway up at golden hour (it switches the windows on): the fog stays sunlit until the sun is really down.
  const n = THREE.MathUtils.smoothstep(a.night, 0.5, 1);
  const [lx, ly, lz] = a.lightDir;
  LIGHT.uSunDir.value.set(lx, ly, lz).normalize();
  // How golden the light is: next to nothing at noon, a little by 17:00, full at 18:30 as the sun goes down.
  const [lr, , lb] = a.lightColor;
  const gold = THREE.MathUtils.smoothstep(lr - lb, 0.35, 0.72) * (1 - n);
  // Sunlit tops: the light's colour, eased toward white so noon fog stays white rather than cream,
  // and taken almost whole (peach and apricot) at golden hour.
  const sun = Math.min(1.15, a.lightIntensity / 2.6);
  tmp.setRGB(...a.lightColor);
  const lit = LIGHT.uLit.value.copy(WHITE).lerp(tmp, 0.6 + 0.3 * gold).multiplyScalar(0.56 + 0.24 * sun + 0.12 * gold);
  lit.lerp(MOON_LIT, n);
  // Shade: the sky's colour pulled toward violet (mauve at golden hour, rosier as the sun sets), then night blue.
  tmp2.setRGB(...a.skyColor);
  LIGHT.uShade.value.copy(tmp2).lerp(VIOLET, 0.65 - 0.2 * gold).multiplyScalar(0.52);
  // Low sun pours through fog: at golden hour even the side turned away glows warm.
  tmp2.copy(tmp).multiplyScalar(0.62);
  LIGHT.uShade.value.lerp(tmp2, 0.45 * gold).lerp(MOON_SHADE, n);
  LIGHT.uSky.value.setRGB(...a.skyColor).multiplyScalar(Math.min(1, a.hemiIntensity / 1.5) * (1 - 0.7 * n));
  LIGHT.uGlow.value.copy(CITY_GLOW).multiplyScalar(n * n);
  LIGHT.uHaze.value.setRGB(...a.fog);
  // A little more see-through at night, so the dark blocks underneath tie the fog to the ground.
  LIGHT.uDensity.value = 0.96 - 0.08 * n;
}

/** The old API: tints by `night` alone (the dev showcase uses it). */
export function setCloudLight(night: number, fog?: THREE.Color) {
  void fog;
  setFogLight(atmosphereAt(13 + 9 * Math.min(1, Math.max(0, night))));
}

const VERT = /* glsl */ `
  attribute vec4 aFog;
  attribute float aEdge;
  uniform float uTime;
  uniform vec4 uBank[SLOTS];
  varying vec3 vN;
  varying float vFacing;
  varying float vH;
  varying float vKeep;
  varying float vKind;
  varying float vDensity;
  varying float vEdge;
  varying vec2 vUv;

  void main() {
    vec4 bank = uBank[int(aFog.x + 0.5)];
    float burn = bank.z;
    float h = aFog.y;
    float kind = aFog.w < 0.0 ? 1.0 : 0.0;
    vec3 p = position;
    // A slow swell: the billows rise and settle, out of step across the bank.
    float t = uTime;
    p.y += h * 0.075 * sin(t * 0.32 + p.x * 0.85 + p.z * 0.6) * (1.0 - kind);
    p.xz += h * 0.05 * vec2(sin(t * 0.21 + p.z * 0.7), cos(t * 0.17 + p.x * 0.6)) * (1.0 - kind);
    // Wisps drift back and forth over the bank.
    float ph = aFog.z * 6.2832;
    p.xz += kind * vec2(sin(t * 0.09 + ph), cos(t * 0.07 + ph * 1.3)) * 0.32;

    // Burning off: the edges and thin parts go first, the rest thins, lifts and spreads as it goes.
    vec2 off = p.xz - bank.xy;
    float edge = clamp(length(off) / bank.w, 0.0, 1.0);
    float order = 0.55 * edge + 0.45 * aFog.z;
    float gone = 0.42 + 0.56 * (1.0 - order);
    vKeep = (1.0 - smoothstep(gone - 0.3, gone, burn)) * (1.0 - 0.2 * burn * burn);
    p.xz = bank.xy + off * (1.0 + burn * 0.22);
    p.y += burn * burn * 0.8 + burn * h * 0.4;

    vN = normal;
    vFacing = (normalMatrix * normal).z;
    vH = h;
    vKind = kind;
    vDensity = abs(aFog.w);
    vEdge = aEdge;
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }`;

const FRAG = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uLit;
  uniform vec3 uShade;
  uniform vec3 uSky;
  uniform vec3 uGlow;
  uniform vec3 uHaze;
  uniform float uDensity;
  varying vec3 vN;
  varying float vFacing;
  varying float vH;
  varying float vKeep;
  varying float vKind;
  varying float vDensity;
  varying float vEdge;
  varying vec2 vUv;

  void main() {
    // Drawn from both sides, so a steep far slope fades out instead of being cut off at a hard,
    // jagged line; seen from behind, it's lit as the side it is.
    vec3 N = normalize(gl_FrontFacing ? vN : -vN);
    // Soft terminator: fog scatters light deep into its shade.
    // The light rakes a little lower than the real sun, so the billows show their shape even at noon.
    vec3 L = normalize(vec3(uSunDir.x * 2.0, uSunDir.y, uSunDir.z * 2.0));
    float sun = smoothstep(-0.4, 0.65, dot(N, L));
    // Billows read as round: brightest where they face you, cooler as they turn away.
    float limb = smoothstep(0.05, 0.75, gl_FrontFacing ? vFacing : -vFacing);
    // The crowns catch the light; lower down the bank is in its own shade.
    float top = smoothstep(0.0, 0.7, vH);
    // Folds between billows fall into shade; crests catch a little extra light.
    float fold = smoothstep(0.0, -0.09, vUv.y);
    float crest = smoothstep(0.0, 0.08, vUv.y);
    float light = sun * mix(0.72, 1.0, top) * mix(0.68, 1.0, limb) * (1.0 - 0.45 * fold);
    vec3 col = mix(uShade, uLit, clamp(light + 0.15 * crest, 0.0, 1.0));
    // The thin haze at the foot of the bank is light and even, never a dark rim.
    col = mix(col, mix(uLit, uShade, 0.4), (1.0 - smoothstep(0.0, 0.22, vH)) * 0.7);
    col += uSky * max(N.y, 0.0) * 0.07;
    // At night the streets light the fog from below.
    col += uGlow * (1.0 - top * 0.75);
    col = mix(col, uHaze, 0.07);

    float a;
    if (vKind < 0.5) {
      // Soft at the outline: a smooth falloff across the bank's edge band, measured over the ground
      // rather than from the surface's slope, so the silhouette never breaks into streaks. Also thin
      // where the layer thins or the ground reaches up into it (uv.x).
      a = vDensity * uDensity * smoothstep(0.0, 0.55, vEdge) * smoothstep(0.0, 1.0, vUv.x);
    } else {
      float r = length(vUv - 0.5) * 2.0;
      a = vDensity * uDensity * (1.0 - smoothstep(0.1, 1.0, r));
    }
    a *= vKeep;
    if (a < 0.003) discard;
    gl_FragColor = vec4(col, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

function fogMaterial(): THREE.ShaderMaterial {
  const bank = Array.from({ length: SLOTS }, () => new THREE.Vector4(0, 0, 0, 1));
  const m = new THREE.ShaderMaterial({
    name: 'KarlTheFog',
    defines: { SLOTS },
    uniforms: { ...LIGHT, uBank: { value: bank } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  return m;
}

// ─── Geometry ───────────────────────────────────────────────────────────────

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

interface Stratum {
  /** Centre offset from the bank's centre, and half-sizes of its outline. */
  ox: number;
  oz: number;
  hx: number;
  hz: number;
  /** Height of its underside above the ground, and its thickness before the billows. */
  base: number;
  thick: number;
  /** How far its edge wanders in and out. */
  wander: number;
  /** Billows on its top: [x, z, radius, height], relative to the bank's centre. */
  bumps: [number, number, number, number][];
  /** Opacity at its thickest. */
  density: number;
  /** How wide its edge is, from nothing to full height: wide for haze, narrow for a bank with a rounded shoulder. */
  edge: number;
  /** It stands in for the whole bank in the soft-shadow pass (one smooth surface, so no creases where layers cross). */
  solid?: boolean;
}

/** Arrays a bank's strata and wisps are written into. */
class Out {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  fog: number[] = [];
  edge: number[] = [];
  index: number[] = [];
  solid: number[] = [];
  lo = Infinity;
  hi = -Infinity;
}

/**
 * One layer of fog: a soft-edged lens over part of the footprint, its top
 * a rolling surface. `uv.x` carries its thickness, which the shader fades
 * the edges by.
 */
function stratum(out: Out, spec: FogSpec, s: Stratum, slot: number, order: (x: number, z: number) => number, floor: (x: number, z: number) => number, r: () => number) {
  const ground = spec.ground ?? (() => 0);
  const corner = Math.min(s.hx, s.hz) * 0.55;
  const wob = [r() * 6.28, r() * 6.28, r() * 6.28];
  const ex = s.hx + 0.5;
  const ez = s.hz + 0.5;
  const step = spec.step ?? STEP;
  const nx = Math.max(4, Math.ceil((2 * ex) / step));
  const nz = Math.max(4, Math.ceil((2 * ez) / step));
  const cols = nx + 1;
  const first = out.pos.length / 3;
  const pos: number[] = [];
  const mask: number[] = [];
  const thick: number[] = [];
  /** How much fog actually stands over the ground at each point (less where a hilltop pokes up into it). */
  const depth: number[] = [];
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const u = -ex + (i / nx) * 2 * ex;
      const v = -ez + (j / nz) * 2 * ez;
      // Signed distance to a rounded rectangle, its edge pushed in and out.
      const ang = Math.atan2(v / s.hz, u / s.hx);
      const wander = s.wander * (Math.sin(3 * ang + wob[0]!) * 0.55 + Math.sin(5 * ang + wob[1]!) * 0.3 + Math.sin(9 * ang + wob[2]!) * 0.15);
      const qx = Math.abs(u) - (s.hx - corner);
      const qz = Math.abs(v) - (s.hz - corner);
      const sd = Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - corner - wander;
      const bx = s.ox + u;
      const bz = s.oz + v;
      const m = smoothstep(0.15, 0.15 - s.edge, sd) * (spec.keep ? spec.keep(spec.x + bx, spec.z + bz) : 1);
      let bumps = 0;
      for (const [x, z, rad, amp] of s.bumps) {
        const q = ((bx - x) ** 2 + (bz - z) ** 2) / (rad * rad);
        if (q < 9) bumps += amp * Math.exp(-q);
      }
      const t = Math.max(0, Math.sqrt(m) * (s.thick + bumps));
      const x = spec.x + bx;
      const z = spec.z + bz;
      // The fog lies level over the land's broad lie (`floor`), not over every bump in it; a rise that
      // reaches up into the bank thins it, and a top that pokes through is left bare.
      const g = ground(x, z);
      const y = Math.max(floor(x, z) + s.base + t, g + 0.04);
      pos.push(x, y, z);
      mask.push(m);
      thick.push(t);
      depth.push(y - g);
      out.fog.push(slot, s.base + t, order(x, z), s.density);
      out.edge.push(m);
      out.lo = Math.min(out.lo, g);
      out.hi = Math.max(out.hi, y);
    }
  }
  // uv.y: how far each point stands above or sinks below its surroundings (the shader darkens the
  // folds between billows and brightens their crests). uv.x: how solid the fog is there, from 0 to 1:
  // thin where the layer thins, and where the ground rises up into it. The ground's depth is averaged
  // over its neighbours, so gullies running down a hillside don't comb the fog into streaks.
  const R = 4;
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      let sum = 0;
      let deep = 0;
      let n = 0;
      for (let dj = -R; dj <= R; dj++) {
        for (let di = -R; di <= R; di++) {
          const jj = Math.min(nz, Math.max(0, j + dj));
          const ii = Math.min(nx, Math.max(0, i + di));
          sum += thick[jj * cols + ii]!;
          deep += depth[jj * cols + ii]!;
          n++;
        }
      }
      const t = thick[j * cols + i]!;
      // (And gone wherever it actually lies on the ground, so it never flickers against the slope.)
      const here = depth[j * cols + i]!;
      out.uv.push(Math.min(t / 0.16, deep / n / 0.4, (here - 0.04) / 0.12, 1), t - sum / n);
    }
  }
  const index: number[] = [];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      // Skip the bare ground around the lens.
      if (mask[a]! < 0.02 && mask[b]! < 0.02 && mask[c]! < 0.02 && mask[d]! < 0.02) continue;
      index.push(a, c, b, b, c, d);
      if (s.solid) out.solid.push(first + a, first + c, first + b, first + b, first + c, first + d);
    }
  }
  // Smooth normals over the surface.
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  const nrm = (g.getAttribute('normal') as THREE.BufferAttribute).array;
  g.dispose();
  for (let k = 0; k < pos.length; k++) {
    out.pos.push(pos[k]!);
    out.nrm.push(nrm[k]!);
  }
  for (const i of index) out.index.push(first + i);
}

/**
 * One bank, in layers: a thin, wide haze that spills into the streets, the
 * bank itself over the land (billows and crowns on one surface, so nothing
 * in it crosses), and wisps drifting just above. Translucent where it thins,
 * so the ground underneath shows through at the edges.
 */
function bankGeometry(spec: FogSpec, slot: number): BankGeo {
  const r = rng(spec.seed);
  const H = spec.height ?? 0.5;
  const spill = spec.spill ?? 0.55;
  const hx = spec.w / 2;
  const hz = spec.d / 2;
  // Burn order: a smooth field, so the fog breaks up into a few soft patches rather than speckle.
  const bo = [r() * 6.28, r() * 6.28, 1.1 + r() * 0.6, 1.0 + r() * 0.6];
  const order = (x: number, z: number) => 0.5 + 0.5 * Math.sin(x * bo[2]! + bo[0]!) * Math.sin(z * bo[3]! + bo[1]!);
  const bumps = (n: number, w: number, d: number, rad: [number, number], amp: [number, number]) =>
    Array.from({ length: n }, () => [(r() - 0.5) * w, (r() - 0.5) * d, rad[0] + r() * (rad[1] - rad[0]), amp[0] + r() * (amp[1] - amp[0])] as [number, number, number, number]);

  // The broad lie of the land under the bank: flat for a city block; a plane fitted to the slope
  // for the Hills and the islands, so the bank lies on the hillside like a sheet rather than
  // draping every fold of it like snow.
  let floor = spec.floor ?? ((_x: number, _z: number) => 0);
  if (spec.ground && !spec.floor) {
    const ground = spec.ground;
    let n = 0, sg = 0, sx = 0, sz = 0, sxx = 0, szz = 0, sxg = 0, szg = 0;
    const samples: [number, number, number][] = [];
    for (let i = 0; i <= 8; i++) {
      for (let j = 0; j <= 8; j++) {
        const u = (i / 8 - 0.5) * spec.w;
        const v = (j / 8 - 0.5) * spec.d;
        const g = ground(spec.x + u, spec.z + v);
        samples.push([u, v, g]);
        n++;
        sg += g;
        sx += u;
        sz += v;
        sxx += u * u;
        szz += v * v;
        sxg += u * g;
        szg += v * g;
      }
    }
    // Least squares on a symmetric grid: the slopes separate.
    const mean = sg / n;
    const bxs = (sxg - (sx * sg) / n) / (sxx - (sx * sx) / n);
    const bzs = (szg - (sz * sg) / n) / (szz - (sz * sz) / n);
    // Then raised until it lies over all but the highest few rises, so the land under it stays hidden.
    const above = samples.map(([u, v, g]) => g - (mean + bxs * u + bzs * v)).sort((a, b) => a - b);
    const lift = Math.max(0, above[Math.floor(above.length * 0.9)]!);
    floor = (x, z) => mean + lift + bxs * (x - spec.x) + bzs * (z - spec.z);
  }

  const out = new Out();
  // Low stratus: wide and thin, out over the streets.
  if (spec.haze !== false) stratum(out, spec, { ox: 0, oz: 0, hx: hx + spill, hz: hz + spill, base: 0, thick: H * 0.35, wander: 0.35, bumps: bumps(5, spec.w, spec.d, [0.6, 1.2], [0.02, 0.06]), density: 0.5, edge: 1.1 }, slot, order, floor, r);
  // The bank itself: a sea of low billows over the land, reaching halfway across the streets,
  // heaped up here and there into crowns that catch the sun. One surface, so nothing in it crosses.
  const holes = spec.ground ? [] : bumps(1, spec.w * 0.5, spec.d * 0.5, [0.35, 0.5], [-H * 0.8, -H * 0.6]);
  const B = spec.billow ?? 1;
  const heap = spec.heap ?? 1;
  // A dozen billows to a city block's worth of fog, however big the bank.
  const area = (spec.w * spec.d) / 16;
  const billows = bumps(Math.round((12 * area) / (B * B)), spec.w, spec.d, [0.55 * B, 0.95 * B], [(H * 0.35 * heap) / B, (H * 0.9 * heap) / B]);
  const crowns = bumps(Math.max(1, Math.round((2 * Math.sqrt(area) * heap) / B)), spec.w * (heap > 1 ? 0.9 : 0.6), spec.d * (heap > 1 ? 0.9 : 0.6), [0.6 * B, 0.9 * B], [H * 0.8, H * 1.2]);
  stratum(out, spec, { ox: 0, oz: 0, hx: hx + spill * 0.85, hz: hz + spill * 0.85, base: H * 0.1, thick: H * 0.45, wander: 0.3, bumps: [...billows, ...crowns, ...holes], density: 0.95, edge: 0.6, solid: true }, slot, order, floor, r);

  // Wisps: thin, soft sheets lying just over the bank, drifting. Density below zero marks a wisp.
  const ground = spec.ground ?? (() => 0);
  // (Not over hills: a flat sheet would cut into the slope.)
  const wisps = spec.ground ? 0 : 2 + (r() < 0.5 ? 1 : 0);
  for (let i = 0; i < wisps; i++) {
    const cx = spec.x + (r() - 0.5) * spec.w * 0.7;
    const cz = spec.z + (r() - 0.5) * spec.d * 0.7;
    const y = ground(cx, cz) + H * 1.2 + r() * 0.25;
    const sx = (1.5 + r() * 1.3) * Math.min(1, spec.w / 4.6) ** 0.5;
    const sz = sx * (0.42 + r() * 0.2);
    const rot = r() * Math.PI;
    const c = Math.cos(rot);
    const sn = Math.sin(rot);
    const base = out.pos.length / 3;
    const o = 0.6 + 0.4 * r();
    for (const [du, dv] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      const lx = du * sx;
      const lz = dv * sz;
      out.pos.push(cx + c * lx - sn * lz, y, cz + sn * lx + c * lz);
      out.nrm.push(0, 1, 0);
      out.uv.push((du + 1) / 2, (dv + 1) / 2);
      out.fog.push(slot, H * 1.4, o, -0.3);
      out.edge.push(1);
    }
    out.index.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    out.hi = Math.max(out.hi, y);
  }
  return {
    pos: new Float32Array(out.pos),
    nrm: new Float32Array(out.nrm),
    uv: new Float32Array(out.uv),
    fog: new Float32Array(out.fog),
    edge: new Float32Array(out.edge),
    index: out.index,
    solid: out.solid,
    radius: Math.max(hx, hz) + spill,
    lo: out.lo,
    hi: out.hi,
  };
}

/**
 * Merges banks into one geometry, lowest first so the tops draw over the
 * shade beneath, and a second one over the same vertices with just their
 * main layers.
 */
function merge(banks: BankGeo[]): { fog: THREE.BufferGeometry; solid: THREE.BufferGeometry } {
  let verts = 0;
  let tris = 0;
  for (const b of banks) {
    verts += b.pos.length / 3;
    tris += b.index.length;
  }
  const pos = new Float32Array(verts * 3);
  const nrm = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);
  const fog = new Float32Array(verts * 4);
  const edge = new Float32Array(verts);
  const index = new Uint32Array(tris);
  const solid: number[] = [];
  let v = 0;
  let t = 0;
  for (const b of banks) {
    pos.set(b.pos, v * 3);
    nrm.set(b.nrm, v * 3);
    uv.set(b.uv, v * 2);
    fog.set(b.fog, v * 4);
    edge.set(b.edge, v);
    for (const i of b.index) index[t++] = i + v;
    for (const i of b.solid) solid.push(i + v);
    v += b.pos.length / 3;
  }
  // Order triangles by height: from above, the higher fog is nearer the camera in every rotation.
  const order = Array.from({ length: tris / 3 }, (_, i) => i);
  const yOf = (i: number) => pos[index[i * 3]! * 3 + 1]! + pos[index[i * 3 + 1]! * 3 + 1]! + pos[index[i * 3 + 2]! * 3 + 1]!;
  const ys = order.map(yOf);
  order.sort((a, b) => ys[a]! - ys[b]!);
  const sorted = new Uint32Array(tris);
  order.forEach((tri, k) => sorted.set(index.subarray(tri * 3, tri * 3 + 3), k * 3));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aFog', new THREE.BufferAttribute(fog, 4));
  g.setAttribute('aEdge', new THREE.BufferAttribute(edge, 1));
  g.setIndex(new THREE.BufferAttribute(sorted, 1));
  g.computeBoundingSphere();
  // Shares the vertex buffers: only the triangle list is new.
  const h = new THREE.BufferGeometry();
  h.setAttribute('position', g.getAttribute('position'));
  h.setAttribute('normal', g.getAttribute('normal'));
  h.setIndex(new THREE.BufferAttribute(new Uint32Array(solid), 1));
  return { fog: g, solid: h };
}

/**
 * Draws nothing in the picture. The soft-shadow pass (GTAO) leaves see-through
 * things out, so without a stand-in it would shade the kerbs and block edges
 * hidden under the fog and lay their outlines over it; this opaque stand-in
 * (each bank's main layer) hides them, and that pass draws every mesh with
 * its own material, so it sees this one as a solid surface.
 */
const shieldMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
shieldMaterial.userData.shared = true;

/**
 * The land's broad lie over an area: its height blurred over `radius`, so a fog bank resting on it
 * follows valleys and slopes but not every fold, and the tops of rises poke up through. Sampled
 * once on a coarse grid, then read back smoothly.
 */
export function smoothGround(ground: (x: number, z: number) => number, x0: number, z0: number, x1: number, z1: number, radius = 2.5, step = 0.5): (x: number, z: number) => number {
  const pad = radius + step;
  const ax = x0 - pad;
  const az = z0 - pad;
  const nx = Math.ceil((x1 - x0 + 2 * pad) / step) + 1;
  const nz = Math.ceil((z1 - z0 + 2 * pad) / step) + 1;
  let grid = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) grid[j * nx + i] = ground(ax + i * step, az + j * step);
  // A box blur, along x then along z.
  const k = Math.round(radius / step);
  for (const along of ['x', 'z'] as const) {
    const out = new Float32Array(nx * nz);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        let sum = 0;
        let n = 0;
        for (let d = -k; d <= k; d++) {
          const ii = along === 'x' ? i + d : i;
          const jj = along === 'z' ? j + d : j;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
          sum += grid[jj * nx + ii]!;
          n++;
        }
        out[j * nx + i] = sum / n;
      }
    }
    grid = out;
  }
  return (x, z) => {
    const fx = Math.min(nx - 1.001, Math.max(0, (x - ax) / step));
    const fz = Math.min(nz - 1.001, Math.max(0, (z - az) / step));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const at = (ii: number, jj: number) => grid[jj * nx + ii]!;
    return (at(i, j) * (1 - tx) + at(i + 1, j) * tx) * (1 - tz) + (at(i, j + 1) * (1 - tx) + at(i + 1, j + 1) * tx) * tz;
  };
}

// ─── Banks ──────────────────────────────────────────────────────────────────

/** Invisible boxes the tooltips pick against: one per bank. */
const pickMaterial = new THREE.MeshBasicMaterial({ visible: false });
pickMaterial.userData.shared = true;
const pickBox = new THREE.BoxGeometry(1, 1, 1);

interface Bank {
  slot: number;
  geo: BankGeo;
  proxy: THREE.Group;
  /** Burn-off progress in seconds, or null while the fog is settled. */
  burn: number | null;
}

/**
 * All the fog in one layer (the city's blocks, or the scenery's regions),
 * drawn as one mesh. Add a bank per locked area; remove it to burn it off.
 */
export class FogBanks {
  readonly object = new THREE.Group();
  private material = fogMaterial();
  private mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
  private shield = new THREE.Mesh(new THREE.BufferGeometry(), shieldMaterial);
  private banks = new Map<string, Bank>();
  private dirty = false;

  constructor() {
    this.mesh.frustumCulled = false;
    // After the city's other see-through things, before Karl's sprites over the ocean.
    this.mesh.renderOrder = 1;
    this.mesh.name = 'Fog';
    this.shield.frustumCulled = false;
    this.shield.name = 'Fog (shadow stand-in)';
    // Only the soft-shadow pass needs it, and that pass draws the scene with an override material:
    // in every other pass (the picture itself) an empty draw range skips the draw call entirely.
    this.shield.onBeforeRender = (_r, scene) => this.shield.geometry.setDrawRange(0, scene.overrideMaterial ? Infinity : 0);
    this.object.add(this.mesh, this.shield);
  }

  /** Lays fog over an area. Returns the bank's pick proxy (already in `object`); give it a `userData.tip`. */
  add(key: string, spec: FogSpec): THREE.Group {
    const had = this.banks.get(key);
    if (had) {
      // Closed again while burning off (a scrub backwards): let it settle back.
      had.burn = null;
      this.uniform(had.slot).z = 0;
      this.object.add(had.proxy);
      return had.proxy;
    }
    const used = new Set([...this.banks.values()].map((b) => b.slot));
    let slot = 0;
    while (used.has(slot) && slot < SLOTS - 1) slot++;
    const geo = bankGeometry(spec, slot);
    const proxy = new THREE.Group();
    for (const p of spec.picks ?? [{ x: spec.x, z: spec.z, w: spec.w + 0.4, d: spec.d + 0.4 }]) {
      const box = new THREE.Mesh(pickBox, pickMaterial);
      box.visible = false;
      box.scale.set(p.w, geo.hi - geo.lo + 0.1, p.d);
      box.position.set(p.x, (geo.hi + geo.lo) / 2, p.z);
      proxy.add(box);
    }
    this.object.add(proxy);
    this.uniform(slot).set(spec.x, spec.z, 0, geo.radius);
    this.banks.set(key, { slot, geo, proxy, burn: null });
    this.dirty = true;
    return proxy;
  }

  has(key: string): boolean {
    const b = this.banks.get(key);
    return !!b && b.burn === null;
  }

  /** Clears a bank: burning off over a second or so, or at once. */
  remove(key: string, animate: boolean) {
    const b = this.banks.get(key);
    if (!b) return;
    this.object.remove(b.proxy);
    if (animate) {
      b.burn ??= 0;
      return;
    }
    this.banks.delete(key);
    this.dirty = true;
  }

  /** A bank is burning off right now (keep the frame rate up). */
  get busy(): boolean {
    for (const b of this.banks.values()) if (b.burn !== null) return true;
    return false;
  }

  update(dt: number) {
    for (const [key, b] of this.banks) {
      if (b.burn === null) continue;
      b.burn += dt;
      const t = Math.min(1, b.burn / BURN);
      // Even progress: the shader eases the lift and staggers the dissolve itself.
      this.uniform(b.slot).z = t;
      if (t >= 1) {
        this.banks.delete(key);
        this.dirty = true;
      }
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.mesh.geometry.dispose();
    this.shield.geometry.dispose();
    const { fog, solid } = merge([...this.banks.values()].map((b) => b.geo));
    this.mesh.geometry = fog;
    this.shield.geometry = solid;
    this.mesh.visible = this.shield.visible = this.banks.size > 0;
  }

  private uniform(slot: number): THREE.Vector4 {
    return (this.material.uniforms.uBank!.value as THREE.Vector4[])[slot]!;
  }
}

/** One standalone bank as a model (the dev showcase). */
export function cloudBank(x: number, z: number, w: number, d: number, seed: number, y = 0.5): Built {
  void y;
  const fog = new FogBanks();
  fog.add('bank', { x, z, w, d, seed });
  fog.update(0);
  return { group: fog.object };
}

// ─── Unexplored land ────────────────────────────────────────────────────────

/** The brand's cream, and the deeper sand of its sides, so the glyph keeps its shape against white fog. */
const CREAM = new THREE.Color(0xf6eedf);
const CREAM_SIDE = new THREE.Color(0xd6bb8e);
/** Its faint warm glow after dark. */
const EMBER = new THREE.Color(0xffc98a);

/**
 * A question mark, 1 tall, centred on the origin and facing +z: the hook and
 * stem as one rounded stroke (a circle's arc easing into a short straight
 * stem), and the dot under it, extruded with a soft bevel. The faces are
 * cream and the bevelled sides a deeper sand.
 */
function questionGeometry(): THREE.BufferGeometry {
  const W = 0.15;
  const cy = 0.69;
  const R = 0.19;
  // The stroke's centreline: round over the top from the left, in toward the middle, then down.
  const line: [number, number][] = [];
  for (let k = 0; k <= 22; k++) {
    const a = THREE.MathUtils.degToRad(166 - (k / 22) * 211);
    line.push([Math.cos(a) * R, cy + Math.sin(a) * R]);
  }
  const [ex, ey] = line.at(-1)!;
  for (let k = 1; k <= 8; k++) {
    const t = k / 8;
    const u = 1 - t;
    line.push([u * u * ex + 2 * u * t * 0.004, u * u * ey + 2 * u * t * 0.47 + t * t * 0.4]);
  }
  line.push([0, 0.36]);
  const left: THREE.Vector2[] = [];
  const right: THREE.Vector2[] = [];
  for (let i = 0; i < line.length; i++) {
    const [px, py] = line[i]!;
    const [ax, ay] = line[Math.max(0, i - 1)]!;
    const [bx, by] = line[Math.min(line.length - 1, i + 1)]!;
    const tl = Math.hypot(bx - ax, by - ay) || 1;
    const nx = -(by - ay) / tl;
    const ny = (bx - ax) / tl;
    left.push(new THREE.Vector2(px + (nx * W) / 2, py + (ny * W) / 2));
    right.push(new THREE.Vector2(px - (nx * W) / 2, py - (ny * W) / 2));
  }
  // Round caps at both ends.
  const cap = (p: [number, number], from: THREE.Vector2): THREE.Vector2[] => {
    const a0 = Math.atan2(from.y - p[1], from.x - p[0]);
    return Array.from({ length: 7 }, (_, k) => new THREE.Vector2(p[0] + Math.cos(a0 - ((k + 1) / 8) * Math.PI) * (W / 2), p[1] + Math.sin(a0 - ((k + 1) / 8) * Math.PI) * (W / 2)));
  };
  const outline = [...left, ...cap(line.at(-1)!, left.at(-1)!), ...right.reverse(), ...cap(line[0]!, right.at(-1)!)];
  const hook = new THREE.Shape(outline);
  const dot = new THREE.Shape().absarc(0, 0.08, 0.085, 0, Math.PI * 2, false);
  const geo = new THREE.ExtrudeGeometry([hook, dot], { depth: 0.07, bevelEnabled: true, bevelThickness: 0.035, bevelSize: 0.026, bevelSegments: 2, curveSegments: 12 });
  // Caps cream, sides (the bevel) deeper sand: ExtrudeGeometry puts the caps in group 0 and the sides in group 1.
  const n = geo.getAttribute('position').count;
  const color = new Float32Array(n * 3);
  for (const g of geo.groups) {
    const c = g.materialIndex === 0 ? CREAM : CREAM_SIDE;
    for (let i = g.start; i < g.start + g.count; i++) color.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
  const caps = geo.groups.filter((g) => g.materialIndex === 0).map((g) => [g.start, g.start + g.count] as const);
  geo.clearGroups();
  geo.translate(0, -0.5, -0.035);
  // Smooth round the bevel; the faces stay dead flat (they're fans of long thin triangles off the outline, and any
  // bevel normal blended into them would streak across the face).
  const out = toCreasedNormals(geo, Math.PI / 3.2);
  const nrm = out.getAttribute('normal') as THREE.BufferAttribute;
  const pos = out.getAttribute('position') as THREE.BufferAttribute;
  for (const [a, b] of caps) for (let i = a; i < b; i++) nrm.setXYZ(i, 0, 0, pos.getZ(i) > 0 ? 1 : -1);
  return out;
}

/** A spot for a question mark: where it floats (its middle), and how tall it is. */
export interface UnknownSpot {
  x: number;
  y: number;
  z: number;
  size: number;
}

/**
 * Question marks over the land past the edge of the world: a few rounded
 * cream glyphs floating over its fog, turned to whoever is looking, bobbing
 * and swaying slowly out of step, with a faint warm glow after dark. All of
 * them are one instanced mesh, solid, so the soft-shadow pass sees them as
 * they're drawn (a see-through glyph would take on the shading of the fog
 * behind it). Each has an invisible box the tooltip picks against.
 */
export class Unknowns {
  readonly object = new THREE.Group();
  /** Tooltip targets, one per question mark (each already has its `userData.tip`). */
  readonly picks: THREE.Group[] = [];
  private material: THREE.MeshStandardMaterial;
  private mesh: THREE.InstancedMesh;
  private spots: readonly UnknownSpot[];
  private time = 0;
  private dir = new THREE.Vector3();
  private euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private quat = new THREE.Quaternion();
  private at = new THREE.Vector3();
  private scale = new THREE.Vector3();
  private matrix = new THREE.Matrix4();

  constructor(spots: readonly UnknownSpot[], tip: { title: string; detail: string }) {
    this.spots = spots;
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0, emissive: CREAM, emissiveIntensity: 0.16 });
    this.mesh = new THREE.InstancedMesh(questionGeometry(), this.material, Math.max(1, spots.length));
    this.mesh.count = spots.length;
    this.mesh.name = 'Unexplored (question marks)';
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // A handful of glyphs that move every frame: cheaper to draw than to keep a bounding sphere current.
    this.mesh.frustumCulled = false;
    // Turned to the camera as it's drawn, whichever way the view has been rotated: leaned most of the way
    // back toward its height, so it reads square-on and still stands like a thing in the world.
    this.mesh.onBeforeRender = (_r, _s, camera) => {
      camera.getWorldDirection(this.dir);
      const yaw = Math.atan2(-this.dir.x, -this.dir.z);
      const pitch = 0.75 * Math.asin(Math.min(1, Math.max(-1, -this.dir.y)));
      this.place(yaw, pitch);
    };
    this.place(Math.PI / 4, 0.45);
    this.object.add(this.mesh);
    for (const s of spots) {
      const proxy = new THREE.Group();
      const box = new THREE.Mesh(pickBox, pickMaterial);
      box.visible = false;
      box.scale.set(s.size * 0.8, s.size * 1.1, s.size * 0.8);
      box.position.set(s.x, s.y, s.z);
      proxy.add(box);
      proxy.userData.tip = tip;
      this.picks.push(proxy);
      this.object.add(proxy);
    }
  }

  /** Each glyph faces the camera, bobbing and swaying out of step with the others (its phase from where it floats). */
  private place(yaw: number, pitch: number) {
    const t = this.time;
    for (let i = 0; i < this.spots.length; i++) {
      const s = this.spots[i]!;
      const phase = s.x * 0.37 + s.z * 0.61;
      this.euler.set(-pitch, yaw + 0.08 * Math.sin(t * 0.55 + phase * 1.7), 0);
      this.quat.setFromEuler(this.euler);
      this.at.set(s.x, s.y + 0.07 * s.size * Math.sin(t * 0.8 + phase), s.z);
      this.scale.setScalar(s.size);
      this.mesh.setMatrixAt(i, this.matrix.compose(this.at, this.quat, this.scale));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** A faint warm glow as night falls (bloom picks it up); by day a touch of its own cream, so it reads against white fog from afar. */
  update(night: number, time: number) {
    this.time = time;
    const n = smoothstep(0.35, 0.9, night);
    this.material.emissive.copy(CREAM).lerp(EMBER, n);
    this.material.emissiveIntensity = 0.16 + 0.16 * n;
  }
}
