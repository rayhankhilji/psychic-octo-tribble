import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { PALETTE } from './palette.ts';

export type ColorLike = number | readonly [number, number, number];

export type Facing = 'x+' | 'x-' | 'z+' | 'z-';

const FACING_ROT: Record<Facing, number> = { 'z+': 0, 'x+': Math.PI / 2, 'z-': Math.PI, 'x-': -Math.PI / 2 };

const tmpColor = new THREE.Color();

/** Non-indexed, coloured, with a per-vertex `rand` used to stagger window lights. */
function prepare(g: THREE.BufferGeometry, color: ColorLike, rand = 0): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  if (geo !== g) g.dispose();
  for (const name of Object.keys(geo.attributes)) if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
  if (!geo.attributes.normal) geo.computeVertexNormals();
  if (typeof color === 'number') tmpColor.setHex(color);
  else tmpColor.setRGB(color[0], color[1], color[2]);
  const n = geo.attributes.position!.count;
  const colors = new Float32Array(n * 3);
  // Plain writes: this runs for every vertex of every model, so no per-vertex arrays.
  const { r: cr, g: cg, b: cb } = tmpColor;
  for (let i = 0; i < n * 3; i += 3) {
    colors[i] = cr;
    colors[i + 1] = cg;
    colors[i + 2] = cb;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('winRand', new THREE.BufferAttribute(new Float32Array(n).fill(rand), 1));
  return geo;
}

/**
 * Shared by every emissive material. `night` blends from daylight glass
 * (windows reflecting the sky) to the material's own glow colour; each
 * window's `rand` decides when in the dusk it switches on.
 */
export const GLOW = {
  night: { value: 1 },
  time: { value: 0 },
  day: { value: new THREE.Color(...PALETTE.dayGlass) },
  /** Height in pixels of whatever is being drawn into (see `LIGHT_POINTS`). */
  viewH: { value: 900 },
};

/**
 * Light points (bulbs, aviation lights, lanterns) are often far smaller than
 * a pixel. A point that small is either caught by a pixel's samples or
 * missed, so as the camera drifts or the light moves it pops on and off, and
 * bloom turns each pop into a flash: the city twinkles like a fault. So a lit
 * point carries its radius (in its rand, see `pointRand`) and a normal
 * pointing out from its centre; at night the vertex shader grows any point
 * under LIGHT_POINT_PX pixels across to that size and dims it to match, so
 * it shows much the same light, steadily.
 */
const LIGHT_POINT_PX = 1.6;
/** Rand values at or above this carry a light point's radius, in units of `POINT_UNIT`. */
const POINT_FLAG = 1000;
const POINT_UNIT = 0.0005;

/** The rand for a light point of radius r: `rand` as usual, plus its radius when it can be smaller than a pixel. */
export function pointRand(r: number, rand = 0): number {
  return r < 0.06 ? rand + POINT_FLAG * Math.max(1, Math.round(r / POINT_UNIT)) : rand;
}

/** GLSL pieces for `LIGHT_POINTS`: declarations, and the code that replaces `#include <begin_vertex>`. */
export const LIGHT_POINTS = {
  decl: `uniform float uViewH;\nuniform float uNight;\nvarying float vDim;`,
  vertex: `#include <begin_vertex>
  vDim = 1.0;
  float pointK = floor(winRand / ${POINT_FLAG.toFixed(1)});
  vRand = winRand - pointK * ${POINT_FLAG.toFixed(1)};
  if (pointK > 0.5 && uNight > 0.0) {
    float r = pointK * ${POINT_UNIT};
    mat4 toWorld = modelMatrix;
    #ifdef USE_BATCHING
      toWorld = toWorld * batchingMatrix;
    #endif
    #ifdef USE_INSTANCING
      toWorld = toWorld * instanceMatrix;
    #endif
    vec4 c = projectionMatrix * viewMatrix * toWorld * vec4(transformed - normal * r, 1.0);
    // World units per pixel at the point (c.w is 1 for the iso camera), then into model units.
    float px = 2.0 * c.w / (abs(projectionMatrix[1][1]) * uViewH) / max(length(toWorld[0].xyz), 1e-5);
    float want = mix(r, ${(LIGHT_POINT_PX / 2).toFixed(2)} * px, uNight);
    if (want > r) {
      transformed += normal * (want - r);
      // Dimmed by the width it gained rather than the area: steady, but a string of bulbs still sparkles.
      vDim = r / want;
    }
  }`,
};

/** Lit materials keep GLOW.viewH set to the height of the target they are drawn into. */
const tmpSize = new THREE.Vector2();
export function trackViewport(m: THREE.Material) {
  m.onBeforeRender = (renderer) => {
    const rt = renderer.getRenderTarget();
    GLOW.viewH.value = rt ? rt.height : renderer.getDrawingBufferSize(tmpSize).y;
  };
}

/**
 * Each window's switch-on time, passed flat: every vertex of a window carries
 * the same value, but interpolating it can still wobble in the last bit from
 * pixel to pixel, and the hash in `lightsOut` turns that wobble into speckle
 * that crawls whenever the camera moves.
 */
export const FLAT_RAND = 'flat varying float vRand;';

/**
 * GLSL: 1 while a lit window has been switched off for a while, else 0.
 * Every couple of minutes each window gets a fresh one-in-sixteen chance of
 * being dark, and a change cross-fades over about two seconds, so across the
 * city a few lights go off and on at a calm pace. (It used to be a hard
 * switch every 23 seconds, which read as flickering.)
 */
export const LIGHTS_OUT = `float lightsOut(float key, float t) {
  float ct = t / 131.0 + key * 17.0;
  float c0 = floor(ct);
  float a = step(0.94, fract(sin(c0 * 12.9898 + key * 78.233) * 43758.5453));
  float b = step(0.94, fract(sin((c0 + 1.0) * 12.9898 + key * 78.233) * 43758.5453));
  return mix(a, b, smoothstep(0.985, 1.0, fract(ct)));
}`;

/** A MeshBasicMaterial that looks like glass by day and glows at night. */
export function glowMaterial(params: THREE.MeshBasicMaterialParameters = { vertexColors: true }): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial(params);
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = GLOW.night;
    shader.uniforms.uDay = GLOW.day;
    shader.uniforms.uTime = GLOW.time;
    shader.uniforms.uViewH = GLOW.viewH;
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `attribute float winRand;\n${FLAT_RAND}\n${LIGHT_POINTS.decl}\nvoid main() {`)
      .replace('#include <begin_vertex>', LIGHT_POINTS.vertex);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `uniform float uNight;\nuniform float uTime;\nuniform vec3 uDay;\n${FLAT_RAND}\nvarying float vDim;\n${LIGHTS_OUT}\nvoid main() {`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float lit = smoothstep(vRand - 0.04, vRand + 0.04, uNight * 1.12 - 0.06);
        lit *= 1.0 - lightsOut(vRand, uTime) * step(0.1, vRand) * step(vRand, 1.5);
        vec3 dayGlass = uDay * (0.78 + 0.4 * fract(vRand * 7.31));
        diffuseColor.rgb = mix(dayGlass, diffuseColor.rgb * max(lit, 0.035), uNight) * vDim;`,
      );
  };
  trackViewport(m);
  m.customProgramCacheKey = () => 'tinytown-glow-3';
  return m;
}

/** Shared by every building: crisp, coloured per vertex. */
export const solidMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.82, metalness: 0.0, envMapIntensity: 0 });
/** Curtain walls, car paint and other shiny things: reflects the sky. */
export const glassMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.14, metalness: 0.55, envMapIntensity: 1.25 });
/** Smooth-shaded parts (car bodies, domes, foliage). */
export const smoothMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05, envMapIntensity: 0.12 });

/**
 * Image-based light for the shiny things only: glass picks up a soft sky,
 * paint gets a sheen, and matte walls keep their colour. `k` scales it with
 * daylight.
 */
export function setEnvironment(tex: THREE.Texture | null, k = 1) {
  for (const [m, base] of [[glassMaterial, 1.25], [smoothMaterial, 0.18]] as const) {
    if (m.envMap !== tex) {
      m.envMap = tex;
      m.needsUpdate = true;
    }
    m.envMapIntensity = base * k;
  }
}

type Bucket = 'solid' | 'glass' | 'smooth' | 'glow';

/**
 * Accumulates parts and merges them into (at most) four meshes: matte,
 * glass, smooth and glow. One building = a handful of draw calls, however
 * detailed it is.
 */
export class GeoBuilder {
  private parts: Record<Bucket, THREE.BufferGeometry[]> = { solid: [], glass: [], smooth: [], glow: [] };

  private add(g: THREE.BufferGeometry, color: ColorLike, glow: boolean | Bucket, rand = 0) {
    const bucket: Bucket = glow === true ? 'glow' : glow === false ? 'solid' : glow;
    this.parts[bucket].push(prepare(g, color, rand));
  }

  /** Adds an already-prepared geometry (see `prepare`). */
  raw(g: THREE.BufferGeometry, glow: boolean | Bucket) {
    const bucket: Bucket = glow === true ? 'glow' : glow === false ? 'solid' : glow;
    if (!g.attributes.winRand) g.setAttribute('winRand', new THREE.BufferAttribute(new Float32Array(g.attributes.position!.count), 1));
    this.parts[bucket].push(g);
  }

  /** Axis-aligned box resting on y. */
  box(w: number, h: number, d: number, x: number, y: number, z: number, color: ColorLike, glow: boolean | Bucket = false, rotY = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rotY) g.rotateY(rotY);
    g.translate(x, y + h / 2, z);
    this.add(g, color, glow);
  }

  /** Box with rounded edges, resting on y. */
  rbox(w: number, h: number, d: number, x: number, y: number, z: number, color: ColorLike, radius = 0.03, bucket: Bucket = 'smooth', rotY = 0) {
    const g = new RoundedBoxGeometry(w, h, d, 2, Math.min(radius, w / 2, h / 2, d / 2));
    if (rotY) g.rotateY(rotY);
    g.translate(x, y + h / 2, z);
    this.add(g, color, bucket);
  }

  /** Any geometry, transformed by a matrix. */
  transformed(g: THREE.BufferGeometry, m: THREE.Matrix4, color: ColorLike, glow: boolean | Bucket = false) {
    g.applyMatrix4(m);
    this.add(g, color, glow);
  }

  /** A profile revolved around Y (domes, columns, fuselages before rotating). */
  lathe(points: [number, number][], x: number, y: number, z: number, color: ColorLike, segments = 16, bucket: Bucket = 'smooth') {
    const g = new THREE.LatheGeometry(points.map(([r, h]) => new THREE.Vector2(r, h)), segments);
    g.translate(x, y, z);
    this.add(g, color, bucket);
  }

  /** Gable roof: a triangular prism with its ridge along x (or z with rotY = π/2), resting on y. */
  gable(w: number, h: number, d: number, x: number, y: number, z: number, color: ColorLike, overhang = 0.06, rotY = 0) {
    const shape = new THREE.Shape([
      new THREE.Vector2(-d / 2 - overhang, 0),
      new THREE.Vector2(d / 2 + overhang, 0),
      new THREE.Vector2(0, h),
    ]);
    const g = new THREE.ExtrudeGeometry(shape, { depth: w + overhang * 2, bevelEnabled: false });
    g.translate(0, 0, -(w + overhang * 2) / 2);
    g.rotateY(Math.PI / 2 + rotY);
    g.translate(x, y, z);
    this.add(g, color, false);
  }

  /** Hip roof: a four-sided pyramid frustum, resting on y. */
  hip(w: number, h: number, d: number, x: number, y: number, z: number, color: ColorLike, overhang = 0.05, top = 0.18) {
    const g = new THREE.CylinderGeometry(top, Math.SQRT1_2, 1, 4, 1);
    g.rotateY(Math.PI / 4);
    g.scale(w + overhang * 2, h, d + overhang * 2);
    g.translate(x, y + h / 2, z);
    this.add(g, color, false);
  }

  cylinder(rTop: number, rBottom: number, h: number, x: number, y: number, z: number, color: ColorLike, segments = 8, glow: boolean | Bucket = false, rotY = 0) {
    const g = new THREE.CylinderGeometry(rTop, rBottom, h, segments);
    if (rotY) g.rotateY(rotY);
    g.translate(x, y + h / 2, z);
    this.add(g, color, glow);
  }

  blob(r: number, x: number, y: number, z: number, color: ColorLike, glow: boolean | Bucket = false, detail = 0) {
    const g = new THREE.IcosahedronGeometry(r, detail);
    const lit = glow === true || glow === 'glow';
    if (lit) {
      // A light point: normals out from the centre, so the shader can grow it (see LIGHT_POINTS).
      const p = g.attributes.position!;
      const n = g.attributes.normal!;
      for (let i = 0; i < p.count; i++) n.setXYZ(i, p.getX(i) / r, p.getY(i) / r, p.getZ(i) / r);
    }
    g.translate(x, y, z);
    this.add(g, color, glow, lit ? pointRand(r) : 0);
  }

  /** A flat quad on the face of a box, facing outward. */
  quad(w: number, h: number, x: number, y: number, z: number, facing: Facing, color: ColorLike, glow: boolean | Bucket = true, rand = 0) {
    const g = new THREE.PlaneGeometry(w, h);
    g.rotateY(FACING_ROT[facing]);
    g.translate(x, y, z);
    this.add(g, color, glow, rand);
  }

  /** A vertical quad facing any direction: `rotY` turns its +z normal (for façades that aren't axis-aligned). */
  panel(w: number, h: number, x: number, y: number, z: number, rotY: number, color: ColorLike, glow: boolean | Bucket = true, rand = 0) {
    const g = new THREE.PlaneGeometry(w, h);
    g.rotateY(rotY);
    g.translate(x, y, z);
    this.add(g, color, glow, rand);
  }

  /** A flat quad lying on the ground. */
  decal(w: number, d: number, x: number, y: number, z: number, color: ColorLike, glow: boolean | Bucket = false) {
    const g = new THREE.PlaneGeometry(w, d);
    g.rotateX(-Math.PI / 2);
    g.translate(x, y, z);
    this.add(g, color, glow);
  }

  /**
   * Grid of windows on faces of a box (centre x,z; base y). Every window is
   * glass by day; at night `lit` of them light up, each at its own moment
   * of dusk. `frame` adds a trim surround and a sill.
   */
  windows(
    o: { w: number; d: number; x: number; z: number; y0: number; rows: number; rowHeight: number; cols: number; faces?: Facing[] },
    r: () => number,
    lit: number,
    light: ColorLike,
    size: { w: number; h: number } = { w: 0.12, h: 0.14 },
    frame?: ColorLike,
  ) {
    const faces = o.faces ?? ['x+', 'x-', 'z+', 'z-'];
    const eps = 0.006;
    for (const f of faces) {
      const span = f[0] === 'x' ? o.d : o.w;
      for (let row = 0; row < o.rows; row++) {
        for (let col = 0; col < o.cols; col++) {
          const u = (col + 0.5) / o.cols - 0.5;
          const y = o.y0 + (row + 0.55) * o.rowHeight;
          const along = u * span;
          const at = (out: number) =>
            f === 'x+' ? [o.x + o.w / 2 + out, o.z - along]
            : f === 'x-' ? [o.x - o.w / 2 - out, o.z + along]
            : f === 'z+' ? [o.x + along, o.z + o.d / 2 + out]
            : [o.x - along, o.z - o.d / 2 - out];
          const [x, z] = at(eps);
          const rand = r() < lit ? 0.12 + 0.86 * r() : 2;
          this.quad(size.w, size.h, x!, y, z!, f, light, true, rand);
          if (frame) {
            const [fx, fz] = at(eps * 0.5);
            this.quad(size.w + 0.035, size.h + 0.035, fx!, y, fz!, f, frame, false);
            const [sx, sz] = at(0.012);
            const g = new THREE.BoxGeometry(size.w + 0.05, 0.016, 0.03);
            g.rotateY(FACING_ROT[f]);
            g.translate(sx!, y - size.h / 2 - 0.012, sz!);
            this.add(g, frame, false);
          }
        }
      }
    }
  }

  /** Merges everything into a group. Returns the glow material so it can be dimmed. */
  build(material?: THREE.Material): { group: THREE.Group; glow?: THREE.MeshBasicMaterial } {
    const group = new THREE.Group();
    const mats: Record<Exclude<Bucket, 'glow'>, THREE.Material> = { solid: solidMaterial, glass: glassMaterial, smooth: smoothMaterial };
    for (const bucket of ['solid', 'glass', 'smooth'] as const) {
      if (!this.parts[bucket].length) continue;
      const mesh = new THREE.Mesh(mergeGeometries(this.parts[bucket]), mats[bucket]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    let glow: THREE.MeshBasicMaterial | undefined;
    if (this.parts.glow.length) {
      glow = (material as THREE.MeshBasicMaterial) ?? glowMaterial();
      group.add(new THREE.Mesh(mergeGeometries(this.parts.glow), glow));
    }
    this.parts = { solid: [], glass: [], smooth: [], glow: [] };
    return { group, glow };
  }
}

const SHARED = new Set<THREE.Material>([solidMaterial, glassMaterial, smoothMaterial]);

export function disposeGroup(obj: THREE.Object3D) {
  obj.traverse((o) => {
    if (o instanceof THREE.Mesh || o instanceof THREE.Points || o instanceof THREE.LineSegments) {
      o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      // Materials many models share (the buckets, or anything marked `userData.shared`) outlive any one model.
      for (const m of mats) if (!SHARED.has(m) && !m.userData.shared) m.dispose();
    }
  });
}
