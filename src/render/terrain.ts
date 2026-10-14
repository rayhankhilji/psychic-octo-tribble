import * as THREE from 'three';
import { AIRPORT_FILL, BLOCKS, GRID, ISLAND_COVE, ISLANDS, LANDMARKS, MARINA, SEA, inSignZone, TOWN_GROUND, TREASURE_COAST, WORLD_SPEC, coastDistance, fbm, gradeWeight, hillsPlan, isBeach, naturalHeight, polygonDistance, terrainHeight } from '../world/map.ts';
import type { Atmosphere } from '../world/daylight.ts';

/** Area the terrain mesh covers; beyond it, open water. */
const AREA = { x0: -110.4, x1: 120, z0: -120, z1: 96 } as const;
/** Area the water shader knows the shoreline for. */
const DEPTH = { x0: -110, z0: -120, w: 230, d: 215 } as const;
/** Terrain tiles: square, each with its own grid resolution. */
const TILE = 4.8;

const GRASS = new THREE.Color(0x86bd58);
const PARK = new THREE.Color(0x6aae47);
/** California hills in summer: golden dry grass, sage and coyote brush, oak in the folds, grey rock. */
const GOLD = new THREE.Color(0xd2b56e);
const STRAW = new THREE.Color(0xc8a862);
const SAGE = new THREE.Color(0x98a568);
const OAK = new THREE.Color(0x5f8a45);
const DRY = new THREE.Color(0xb39457);
const ROCK = new THREE.Color(0x9a9184);
const ROCK_DARK = new THREE.Color(0x7d766c);
/** Chamise and scrub oak on the sign's slope. */
const CHAPARRAL = new THREE.Color(0x7f8a50);
/** Cut banks and road shoulders: decomposed granite. */
const EARTH = new THREE.Color(0xc2a682);
const SAND = new THREE.Color(0xf0dcab);
const WET = new THREE.Color(0xc7b48a);
const SEABED = new THREE.Color(0x7aa7a0);
const VERGE = new THREE.Color(0x8fbf62);
const GARDEN = new THREE.Color(0x7ab650);
const FOREST = new THREE.Color(0x6a8a4a);
/** The estate's mown lawn: the same green as the lawn under the house. */
const LAWN = new THREE.Color(0x82c757);

/** How finely each part of the world is meshed: cells per tile side (a power of two). */
function tileCells(x0: number, z0: number): number {
  const x1 = x0 + TILE;
  const z1 = z0 + TILE;
  const overlaps = (ax0: number, ax1: number, az0: number, az1: number) => x1 > ax0 && x0 < ax1 && z1 > az0 && z0 < az1;
  // Twin Peaks and TinyTown Hills: the closest look anyone takes at bare ground (wherever this world put them).
  const { x: px, z: pz } = WORLD_SPEC.peaks.centre;
  if (overlaps(-30 + Math.min(0, px + 14), 10 + Math.max(0, px + 14), -48 + Math.min(0, pz + 36), -21.5)) return 16;
  // Your island, up close whenever you visit it: fine enough that its beaches and lawns have clean edges.
  const F = ISLANDS.founder;
  if (overlaps(F.x - F.r - 1, F.x + F.r + 1, F.z - F.r - 1, F.z + F.r + 1)) return 32;
  // The Marina Green and the harbour's shore, in the default view: a crisp lawn edge, not a smear.
  if (MARINA.green && overlaps(MARINA.green.x - 4.5, MARINA.green.x + 4.5, MARINA.green.z - 1, MARINA.z + 1.5)) return 16;
  // Islands, the Presidio and Lands End, the airport, Sausalito and the Golden Gate headlands.
  const A = ISLANDS.angel;
  const dg = LANDMARKS.goldenGate.x + 34.6;
  if (overlaps(4, 42, -12, 48) || overlaps(-50, -18 + Math.max(0, dg), -6, 34) || overlaps(12, 31, -56, -31) || overlaps(-24, -8, 30, 46)) return 8;
  if (overlaps(F.x - 6.5, F.x + 6.5, F.z - 6.5, F.z + 6.5) || overlaps(A.x - A.r - 2, A.x + A.r + 2, A.z - A.r - 2, A.z + A.r + 2)) return 8;
  // The towns, whose streets are graded into the ground.
  if (TOWN_GROUND.some(([ax0, ax1, az0, az1]) => overlaps(ax0, ax1, az0, az1))) return 8;
  // Wherever the coast runs inside the playable world: beaches need a fine edge.
  const cx = x0 + TILE / 2;
  const cz = z0 + TILE / 2;
  const near = cx > -64 && cx < 72 && cz > -72 && cz < 62;
  if (near && Math.abs(coastDistance(cx, cz)) < TILE) return 8;
  if (near) return 4;
  return 2;
}

/**
 * The ground and the bay. One sculpted mesh for every coast, hill and
 * island, and a water shader with sky reflection, sun glints, depth colour
 * and surf that breaks along the shore.
 */
export class Terrain {
  readonly object = new THREE.Group();
  private water: THREE.ShaderMaterial;

  constructor() {
    // This world's greens: a touch warmer or cooler, lighter or deeper, and its hills more or less golden.
    const look = WORLD_SPEC.look;
    grass = WORLD_SPEC.classic ? GRASS : GRASS.clone().offsetHSL(look.grassHue, 0, look.grassLight);
    park = WORLD_SPEC.classic ? PARK : PARK.clone().offsetHSL(look.grassHue, 0, look.grassLight);
    dryness = look.dryness;
    pointXs = GRID.bz1 >= 2 ? BLOCKS.filter((b) => b.bz === GRID.bz1).map((b) => b.bx * 5) : [];
    this.object.add(this.ground());
    this.water = waterMaterial(depthTexture());
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(900, 900, 1, 1).rotateX(-Math.PI / 2), this.water);
    sea.position.y = SEA;
    sea.renderOrder = -1;
    this.object.add(sea);
  }

  /**
   * Tiles of different resolution. Where a fine tile meets a coarser one, its
   * edge vertices are moved onto the coarse edge, so there are no cracks.
   * Normals come from the height field itself, so tiles shade seamlessly.
   */
  private ground(): THREE.Mesh {
    const tx = Math.round((AREA.x1 - AREA.x0) / TILE);
    const tz = Math.round((AREA.z1 - AREA.z0) / TILE);
    const cells: number[] = [];
    for (let j = 0; j < tz; j++) for (let i = 0; i < tx; i++) cells.push(tileCells(AREA.x0 + i * TILE, AREA.z0 + j * TILE));
    const cellsAt = (i: number, j: number) => (i < 0 || j < 0 || i >= tx || j >= tz ? 2 : cells[j * tx + i]!);
    const pos: number[] = [];
    const nor: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const c = new THREE.Color();
    // Gardens: watered green round each Hills house, against the dry hillside.
    const lotCells = new Map<string, [number, number][]>();
    for (const l of hillsPlan().lots) {
      const key = `${Math.floor(l.x / 2)},${Math.floor(l.z / 2)}`;
      (lotCells.get(key) ?? lotCells.set(key, []).get(key)!).push([l.x, l.z]);
    }
    garden = (x: number, z: number) => {
      let d = Infinity;
      const cx = Math.floor(x / 2);
      const cz = Math.floor(z / 2);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const [lx, lz] of lotCells.get(`${cx + i},${cz + j}`) ?? []) d = Math.min(d, Math.hypot(x - lx, z - lz));
      return 1 - Math.min(1, Math.max(0, (d - 0.75) / 0.5));
    };
    for (let j = 0; j < tz; j++) {
      for (let i = 0; i < tx; i++) {
        const n = cellsAt(i, j);
        const step = TILE / n;
        const x0 = AREA.x0 + i * TILE;
        const z0 = AREA.z0 + j * TILE;
        // Heights with a one-cell border, for normals and curvature.
        const H = new Float32Array((n + 3) * (n + 3));
        for (let b = 0; b < n + 3; b++) for (let a = 0; a < n + 3; a++) H[b * (n + 3) + a] = terrainHeight(x0 + (a - 1) * step, z0 + (b - 1) * step);
        const h = (a: number, b: number) => H[(b + 1) * (n + 3) + (a + 1)]!;
        const base = pos.length / 3;
        for (let b = 0; b <= n; b++) {
          for (let a = 0; a <= n; a++) {
            const x = x0 + a * step;
            const z = z0 + b * step;
            let y = h(a, b);
            // Stitch to a coarser neighbour: put this edge vertex on the neighbour's straight edge.
            const edge = (m: number, k: number, at: (q: number) => number) => {
              if (m >= n) return null;
              const ratio = n / m;
              const q = k / ratio;
              const q0 = Math.floor(q);
              if (q === q0) return null;
              const t = q - q0;
              return at(q0 * ratio) * (1 - t) + at((q0 + 1) * ratio) * t;
            };
            const fix =
              (a === 0 ? edge(cellsAt(i - 1, j), b, (k) => h(0, k)) : null) ??
              (a === n ? edge(cellsAt(i + 1, j), b, (k) => h(n, k)) : null) ??
              (b === 0 ? edge(cellsAt(i, j - 1), a, (k) => h(k, 0)) : null) ??
              (b === n ? edge(cellsAt(i, j + 1), a, (k) => h(k, n)) : null);
            if (fix !== null) y = fix;
            const gx = (h(a + 1, b) - h(a - 1, b)) / (2 * step);
            const gz = (h(a, b + 1) - h(a, b - 1)) / (2 * step);
            const nl = Math.hypot(gx, 1, gz);
            pos.push(x, y, z);
            nor.push(-gx / nl, 1 / nl, -gz / nl);
            const slope = Math.hypot(gx, gz);
            // Curvature: positive in hollows (ravines), negative on crests.
            const curve = (h(a + 1, b) + h(a - 1, b) + h(a, b + 1) + h(a, b - 1) - 4 * y) / (step * step);
            groundColour(c, x, y, z, slope, curve);
            col.push(c.r, c.g, c.b);
          }
        }
        for (let b = 0; b < n; b++) {
          for (let a = 0; a < n; a++) {
            const p = base + b * (n + 1) + a;
            // Alternate the diagonal so long slopes don't show a grain.
            if ((a + b) % 2) idx.push(p, p + n + 1, p + 1, p + 1, p + n + 1, p + n + 2);
            else idx.push(p, p + n + 1, p + n + 2, p, p + n + 2, p + 1);
          }
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, envMapIntensity: 0 }));
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    return mesh;
  }

  update(time: number, a: Atmosphere, sunDir: THREE.Vector3) {
    const u = this.water.uniforms;
    u.uTime!.value = time;
    u.uSunDir!.value.copy(sunDir);
    u.uSunColor!.value.setRGB(...a.lightColor).multiplyScalar(Math.min(1.6, a.lightIntensity * 0.5));
    u.uSky!.value.setRGB(...a.skyColor);
    // Deep navy after dark, so the city lights and their reflections carry the night.
    u.uLight!.value = 0.14 + 0.86 * Math.min(1, a.hemiIntensity / 1.5) * (1 - a.night * 0.72);
    u.uNight!.value = a.night;
  }
}

/** This world's lawn, park green and how dry its hills are: set when the terrain is built. */
let grass = GRASS;
let park = PARK;
let dryness = 1;

/** The North Point's blocks (their x), if this world has one: set when the terrain is built. */
let pointXs: number[] = [];

/** How much of a watered garden there is at (x, z): set while the ground is built. */
let garden: (x: number, z: number) => number = () => 0;

/** The colour of the ground at a point: sea floor, sand, lawn, dry grass, scrub, oak, rock or a cut bank. */
function groundColour(c: THREE.Color, x: number, h: number, z: number, slope: number, curve: number) {
  const noise = 0.5 + 0.5 * fbm(x * 0.35, z * 0.35, 3);
  const fine = 0.5 + 0.5 * fbm(x * 1.7 + 11, z * 1.7 - 4, 2);
  if (h < SEA + 0.05) {
    c.copy(SEABED).lerp(WET, Math.max(0, 1 + (h - SEA) * 2));
    return;
  }
  // Seawalls: grey riprap at the edge of the fill, never sand.
  const fill = Math.min(polygonDistance(AIRPORT_FILL, x, z), polygonDistance(TREASURE_COAST, x, z));
  if (fill < 0.45 && fill > -0.45) {
    c.copy(ROCK).offsetHSL(0, 0, (fine - 0.5) * 0.08);
    return;
  }
  // The Marina Green: mown lawn from Marina Boulevard down to a thin strip of sand at the water, not a beach.
  const green = marinaGreen(x, z);
  if (green > 0 && h > SEA + 0.04) {
    c.copy(park).offsetHSL(0, 0.02, 0.02 + (fine - 0.5) * 0.03);
    c.lerp(SAND, Math.max(1 - green, 1 - smoothstep(SEA + 0.16, SEA + 0.26, h)));
    return;
  }
  // Your island's strand blends into its lawns instead of stepping, so the edge stays clean up the slopes.
  const F = ISLANDS.founder;
  const L = ISLANDS.launch;
  const isle = Math.hypot(x - F.x, z - F.z) < F.r + 1.5 || Math.hypot(x - L.x, z - L.z) < L.r + 1.2;
  if (!isle && (isBeach(x, z) || h < SEA + 0.25) && !pointLawn(x, z, h)) {
    c.copy(SAND).lerp(WET, Math.max(0, 1 - (h - SEA) * 3));
    return;
  }
  if (polygonDistance(AIRPORT_FILL, x, z) < 0 && h > -0.05) {
    // Mown verges between the runways and taxiways.
    c.copy(VERGE).offsetHSL(0, 0, (fine - 0.5) * 0.04);
    return;
  }
  if (Math.abs(h) < 0.05) {
    c.copy(park);
    return;
  }
  // Green near the city and low down; golden dry grass higher up, with sage scrub in patches.
  c.copy(grass);
  // Your island is watered: lawns and gardens, not dry grass.
  // Telegraph Hill is a city park: green to the top, not the dry gold of the open hills.
  const telegraph = Math.hypot(x - LANDMARKS.coitTower.x, z - LANDMARKS.coitTower.z) < 3.8;
  const lush = Math.hypot(x - ISLANDS.founder.x, z - ISLANDS.founder.z) < 5.6 || Math.hypot(x - ISLANDS.launch.x, z - ISLANDS.launch.z) < 3.4 ? 0.25 : telegraph ? 0.12 : 1;
  const dry = Math.min(1, Math.max(0, (h - 0.25) / 1.5 + (noise - 0.5) * 0.9) * dryness) * lush;
  c.lerp(fine > 0.55 ? GOLD : STRAW, dry);
  c.lerp(SAGE, Math.max(0, Math.min(0.6, (noise - 0.55) * 2.4)) * dry);
  if (h > 6) c.lerp(DRY, 0.3);
  // The sign's slope is thick with chaparral, like Mount Lee under the Hollywood sign: dark sage in clumps.
  if (inSignZone(x, z, 1.5)) {
    const brush = 0.5 + 0.5 * fbm(x * 1.3 + 5, z * 1.3 - 2, 2);
    c.lerp(CHAPARRAL, Math.min(0.75, Math.max(0, brush - 0.38) * 2.2) * dry);
  }
  c.lerp(GARDEN, garden(x, z) * 0.85);
  // Oak and bay laurel down the ravines; bare, rockier crests.
  // (Not on your island's lawns, where every little gully in the wobbly shore would streak the slope.)
  c.lerp(OAK, Math.max(0, Math.min(0.75, curve * 0.9)) * Math.min(1, h / 1.2) * (isle ? 0.2 : 1));
  // Graded ground (cut banks, road shoulders, terraces) shows bare earth.
  const graded = gradeWeight(x, z);
  if (graded > 0.02) {
    const cut = Math.abs(h - naturalHeight(x, z));
    c.lerp(EARTH, Math.min(0.85, graded * 0.5 + cut * 1.5));
  }
  // Wooded islands (Yerba Buena, Angel Island): a forest floor under the trees, rock only on the cliffs.
  const wooded = Math.hypot(x - 33.2, z + 6.8) < 4.6 || Math.hypot(x - ISLANDS.angel.x, z - ISLANDS.angel.z) < ISLANDS.angel.r + 0.9;
  if (wooded) c.lerp(FOREST, 0.75);
  // Rock on the steepest faces and the crests of the peaks.
  const rock = Math.min(1, Math.max(0, (slope - (wooded ? 2.6 : lush < 1 ? 1.8 : 0.85)) * 1.5) + Math.max(0, -curve - 1.2) * 0.25 * Math.min(1, (h - 4) / 2));
  c.lerp(fine > 0.5 ? ROCK : ROCK_DARK, rock);
  c.offsetHSL(0, 0, (noise - 0.5) * 0.06);
  // The estate's lawn runs out from under the house to the edge of the plateau, exactly the lawn's own green
  // (after the noise, so nothing tints it) wherever the house's square base could reach, so its edge doesn't show.
  const estate = Math.hypot(x - F.x, z - F.z);
  if (estate < 3.3) c.lerp(LAWN, 1 - smoothstep(2.35, 3.3, estate));
  if (isle) {
    const inland = -coastDistance(x, z);
    const strand = Math.hypot(x - ISLAND_COVE.x, z - ISLAND_COVE.z) < ISLAND_COVE.r + 1.3 ? 1.2 : 0.35;
    const sand = Math.max(1 - smoothstep(strand - 0.15, strand + 0.35, inland), 1 - smoothstep(SEA + 0.15, SEA + 0.5, h));
    c.lerp(TMP.copy(SAND).lerp(WET, Math.max(0, 1 - (h - SEA) * 3)), sand);
  }
}
/** Scratch colour for the island's strand blend. */
const TMP = new THREE.Color();

const smoothstep = (e0: number, e1: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * On a North Point (a block out on the shore, in some worlds) the beach all
 * round it would be as wide as anywhere else and swamp the point: keep it to
 * a strip at the water, with grass behind.
 */
function pointLawn(x: number, z: number, h: number): boolean {
  if (!pointXs.length || h < SEA + 0.3 || !pointXs.some((px) => Math.abs(px - x) < 9.5)) return false;
  return coastDistance(x, z) < -1.0;
}

/** How much of the Marina Green (0–1) there is at (x, z): its span along the shore, fading at the ends. */
function marinaGreen(x: number, z: number): number {
  const g = MARINA.green;
  // From the green itself down to the water (never across the strait to Marin).
  if (!g || z < g.z - g.d / 2 - 0.3 || z > MARINA.z + 4) return 0;
  const edge = g.w / 2 + 0.4 - Math.abs(x - g.x);
  return Math.min(1, Math.max(0, edge / 0.9));
}

/** Distance to shore, 0 at the coast and 1 in deep water, as a texture the water samples. */
function depthTexture(): THREE.DataTexture {
  const n = 512;
  const data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = DEPTH.x0 + ((i + 0.5) / n) * DEPTH.w;
      const z = DEPTH.z0 + ((j + 0.5) / n) * DEPTH.d;
      const d = coastDistance(x, z);
      const v = Math.max(0, Math.min(1, d / 14));
      const k = (j * n + i) * 4;
      data[k] = Math.round(Math.sqrt(v) * 255);
      data[k + 1] = data[k + 2] = 0;
      data[k + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

function waterMaterial(depth: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.4) },
        uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
        uSky: { value: new THREE.Color(0.8, 0.9, 1) },
        uShallow: { value: new THREE.Color(0x3fd2cf) },
        uMid: { value: new THREE.Color(0x1d97c9) },
        uDeep: { value: new THREE.Color(0x0f5b98) },
        uFoam: { value: new THREE.Color(0xf6fbff) },
        uLight: { value: 1 },
        uNight: { value: 0 },
        uDepth: { value: depth },
        uRect: { value: new THREE.Vector4(DEPTH.x0, DEPTH.z0, DEPTH.w, DEPTH.d) },
      },
    ]),
    vertexShader: /* glsl */ `
      #include <fog_pars_vertex>
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform float uTime, uLight, uNight;
      uniform vec3 uSunDir, uSunColor, uSky, uShallow, uMid, uDeep, uFoam;
      uniform sampler2D uDepth;
      uniform vec4 uRect;
      varying vec3 vWorld;

      vec2 waveGrad(vec2 p, float t) {
        vec2 g = vec2(0.0);
        vec2 d;
        d = vec2(0.6, 0.8);   g += d * cos(dot(p, d) * 1.1 + t * 0.9) * 0.10;
        d = vec2(-0.8, 0.55); g += d * cos(dot(p, d) * 1.9 + t * 1.3) * 0.07;
        d = vec2(0.28, -0.96);g += d * cos(dot(p, d) * 3.3 + t * 1.9) * 0.05;
        d = vec2(-0.5, -0.86);g += d * cos(dot(p, d) * 5.7 + t * 2.6) * 0.03;
        d = vec2(0.92, -0.4); g += d * cos(dot(p, d) * 9.1 + t * 3.4) * 0.02;
        return g;
      }

      void main() {
        vec2 uv = (vWorld.xz - uRect.xy) / uRect.zw;
        float depth = texture2D(uDepth, uv).r;
        float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
        depth = mix(1.0, depth, inside);

        vec2 g = waveGrad(vWorld.xz, uTime) * mix(0.45, 1.0, smoothstep(0.0, 0.4, depth));
        vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
        vec3 view = normalize(cameraPosition - vWorld);

        vec3 base = mix(uShallow, uMid, smoothstep(0.02, 0.35, depth));
        base = mix(base, uDeep, smoothstep(0.35, 0.95, depth));
        float fres = 0.04 + 0.5 * pow(1.0 - max(dot(n, view), 0.0), 4.0);
        vec3 col = mix(base * uLight, uSky * mix(uLight, 0.4, uNight), fres);

        vec3 h = normalize(uSunDir + view);
        float spec = pow(max(dot(n, h), 0.0), 260.0) * 3.0 + pow(max(dot(n, h), 0.0), 40.0) * 0.12;
        col += uSunColor * spec * step(0.0, uSunDir.y);

        // Surf: a bright edge at the shore and bands rolling in.
        float edge = 1.0 - smoothstep(0.0, 0.055, depth);
        float band = sin(depth * 110.0 - uTime * 1.7 + sin(vWorld.x * 0.35 + vWorld.z * 0.2) * 2.0);
        float bands = smoothstep(0.55, 1.0, band) * (1.0 - smoothstep(0.03, 0.16, depth));
        float speckle = smoothstep(0.82, 1.0, sin(vWorld.x * 7.1 + uTime) * sin(vWorld.z * 6.3 - uTime * 1.3)) * (1.0 - smoothstep(0.0, 0.25, depth)) * 0.4;
        col = mix(col, uFoam * uLight, clamp(edge * 0.85 + bands * 0.55 + speckle, 0.0, 1.0));

        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}
