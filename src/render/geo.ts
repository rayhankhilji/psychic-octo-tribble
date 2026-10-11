import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PALETTE } from './palette.ts';

export type ColorLike = number | readonly [number, number, number];

export type Facing = 'x+' | 'x-' | 'z+' | 'z-';

const FACING_ROT: Record<Facing, number> = { 'z+': 0, 'x+': Math.PI / 2, 'z-': Math.PI, 'x-': -Math.PI / 2 };

const tmpColor = new THREE.Color();

function prepare(g: THREE.BufferGeometry, color: ColorLike): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  if (geo !== g) g.dispose();
  geo.deleteAttribute('uv');
  if (typeof color === 'number') tmpColor.setHex(color);
  else tmpColor.setRGB(color[0], color[1], color[2]);
  const n = geo.attributes.position!.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colors.set([tmpColor.r, tmpColor.g, tmpColor.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

/**
 * Shared by every emissive material. `night` blends from daylight glass
 * (windows reflecting the sky) to the material's own glow colour.
 */
export const GLOW = {
  night: { value: 1 },
  day: { value: new THREE.Color(...PALETTE.dayGlass) },
};

/** A MeshBasicMaterial that looks like glass by day and glows at night. */
export function glowMaterial(params: THREE.MeshBasicMaterialParameters = { vertexColors: true }): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial(params);
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = GLOW.night;
    shader.uniforms.uDay = GLOW.day;
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform float uNight;\nuniform vec3 uDay;\nvoid main() {')
      .replace('#include <color_fragment>', '#include <color_fragment>\n\tdiffuseColor.rgb = mix(uDay, diffuseColor.rgb, uNight);');
  };
  m.customProgramCacheKey = () => 'tinytown-glow';
  return m;
}

/** Shared by every building: flat-shaded, coloured per vertex. */
export const solidMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.82, metalness: 0.05 });

/**
 * Accumulates simple low-poly parts and merges them into (at most) two
 * meshes: a lit solid one and an emissive "glow" one for windows and neon.
 * One building = two draw calls, however detailed it is.
 */
export class GeoBuilder {
  private solid: THREE.BufferGeometry[] = [];
  private glow: THREE.BufferGeometry[] = [];

  private add(g: THREE.BufferGeometry, color: ColorLike, glow: boolean) {
    (glow ? this.glow : this.solid).push(prepare(g, color));
  }

  /** Adds an already-coloured, non-indexed geometry (see `prepare`). */
  raw(g: THREE.BufferGeometry, glow: boolean) {
    (glow ? this.glow : this.solid).push(g);
  }

  /** Axis-aligned box resting on y. */
  box(w: number, h: number, d: number, x: number, y: number, z: number, color: ColorLike, glow = false, rotY = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rotY) g.rotateY(rotY);
    g.translate(x, y + h / 2, z);
    this.add(g, color, glow);
  }

  /** Any geometry, transformed by a matrix (for tilted parts like palm fronds). */
  transformed(g: THREE.BufferGeometry, m: THREE.Matrix4, color: ColorLike, glow = false) {
    g.applyMatrix4(m);
    this.add(g, color, glow);
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
  hip(w: number, h: number, d: number, x: number, y: number, z: number, color: ColorLike, overhang = 0.05) {
    const g = new THREE.CylinderGeometry(0.18, Math.SQRT1_2, 1, 4, 1);
    g.rotateY(Math.PI / 4);
    g.scale(w + overhang * 2, h, d + overhang * 2);
    g.translate(x, y + h / 2, z);
    this.add(g, color, false);
  }

  cylinder(rTop: number, rBottom: number, h: number, x: number, y: number, z: number, color: ColorLike, segments = 8, glow = false, rotY = 0) {
    const g = new THREE.CylinderGeometry(rTop, rBottom, h, segments);
    if (rotY) g.rotateY(rotY);
    g.translate(x, y + h / 2, z);
    this.add(g, color, glow);
  }

  blob(r: number, x: number, y: number, z: number, color: ColorLike, glow = false, detail = 0) {
    const g = new THREE.IcosahedronGeometry(r, detail);
    g.translate(x, y, z);
    this.add(g, color, glow);
  }

  /** A flat quad on the face of a box, facing outward. */
  quad(w: number, h: number, x: number, y: number, z: number, facing: Facing, color: ColorLike, glow = true) {
    const g = new THREE.PlaneGeometry(w, h);
    g.rotateY(FACING_ROT[facing]);
    g.translate(x, y, z);
    this.add(g, color, glow);
  }

  /** A flat quad lying on the ground. */
  decal(w: number, d: number, x: number, y: number, z: number, color: ColorLike, glow = false) {
    const g = new THREE.PlaneGeometry(w, d);
    g.rotateX(-Math.PI / 2);
    g.translate(x, y, z);
    this.add(g, color, glow);
  }

  /**
   * Grid of windows on the four faces of a box (centre x,z; base y).
   * Unlit windows are dark glass in the solid mesh; lit ones glow.
   */
  windows(
    o: { w: number; d: number; x: number; z: number; y0: number; rows: number; rowHeight: number; cols: number; faces?: Facing[] },
    r: () => number,
    lit: number,
    light: ColorLike,
    size: { w: number; h: number } = { w: 0.12, h: 0.14 },
  ) {
    const faces = o.faces ?? ['x+', 'x-', 'z+', 'z-'];
    const eps = 0.004;
    for (const f of faces) {
      const span = f[0] === 'x' ? o.d : o.w;
      for (let row = 0; row < o.rows; row++) {
        for (let col = 0; col < o.cols; col++) {
          const u = (col + 0.5) / o.cols - 0.5;
          const y = o.y0 + (row + 0.55) * o.rowHeight;
          const along = u * span;
          const [x, z] =
            f === 'x+' ? [o.x + o.w / 2 + eps, o.z - along]
            : f === 'x-' ? [o.x - o.w / 2 - eps, o.z + along]
            : f === 'z+' ? [o.x + along, o.z + o.d / 2 + eps]
            : [o.x - along, o.z - o.d / 2 - eps];
          const on = r() < lit;
          this.quad(size.w, size.h, x, y, z, f, on ? light : PALETTE.darkGlass, on);
        }
      }
    }
  }

  /** Merges everything into a group. Returns the glow material so it can be dimmed. */
  build(material?: THREE.Material): { group: THREE.Group; glow?: THREE.MeshBasicMaterial } {
    const group = new THREE.Group();
    if (this.solid.length) {
      const mesh = new THREE.Mesh(mergeGeometries(this.solid), solidMaterial);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    let glow: THREE.MeshBasicMaterial | undefined;
    if (this.glow.length) {
      glow = (material as THREE.MeshBasicMaterial) ?? glowMaterial();
      const mesh = new THREE.Mesh(mergeGeometries(this.glow), glow);
      group.add(mesh);
    }
    this.solid = [];
    this.glow = [];
    return { group, glow };
  }
}

export function disposeGroup(obj: THREE.Object3D) {
  obj.traverse((o) => {
    if (o instanceof THREE.Mesh || o instanceof THREE.Points || o instanceof THREE.LineSegments) {
      o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m !== solidMaterial) m.dispose();
    }
  });
}
