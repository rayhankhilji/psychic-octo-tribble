import * as THREE from 'three';

/**
 * A rocket engine's exhaust: a soft layered flame under the engines and a
 * cloud of particles in one draw call. In air (`'air'`, the bay) the
 * particles are steam and smoke: they billow out flat across the pad at
 * ignition, then hang behind the climbing rocket as a column. In vacuum
 * (`'vacuum'`, the moon) there is nothing to billow in: the plume is wide and
 * faint, and the dust it kicks up flies out in straight, low ballistic arcs
 * and drops, with no cloud at all.
 *
 * The owner sets `thrust` (0–1) and calls `update` with the engines' position
 * and the ground beneath them each frame. Works under the orthographic city
 * camera and the moon's perspective camera alike.
 */
export class Exhaust {
  readonly object = new THREE.Group();
  /** 0 = engines off, 1 = full thrust. */
  thrust = 0;
  /** Light on the smoke (the sky's colour by day, blue-grey at night). Air only. */
  readonly ambient = new THREE.Color(0.92, 0.9, 0.86);
  private mode: 'air' | 'vacuum';
  private flame: THREE.Mesh;
  private core: THREE.Mesh;
  private points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private size: Float32Array;
  private grow: Float32Array;
  private alpha: Float32Array;
  private tint: Float32Array;
  private heat: Float32Array;
  private next = 0;
  private carry = 0;
  private time = 0;
  private alive = 0;
  private uPx = { value: 400 };
  private tmp = new THREE.Vector2();

  constructor(mode: 'air' | 'vacuum', count = mode === 'air' ? 220 : 360) {
    this.mode = mode;
    const vacuum = mode === 'vacuum';
    // Two nested cones: a wide soft plume and a hot core. Vacuum plumes are broader, paler and bluer.
    this.flame = new THREE.Mesh(flameGeometry(vacuum ? 0.24 : 0.2), flameMaterial(vacuum ? [1.3, 1.0, 1.25] : [3.2, 1.25, 0.35], vacuum ? [0.5, 0.35, 0.3] : [2.2, 0.5, 0.1], vacuum ? 0.2 : 0.85));
    this.core = new THREE.Mesh(flameGeometry(vacuum ? 0.08 : 0.1), flameMaterial([5, 4.2, 3.2], [3.4, 1.6, 0.5], vacuum ? 0.5 : 1));
    for (const m of [this.flame, this.core]) {
      m.frustumCulled = false;
      m.renderOrder = 6;
      this.object.add(m);
    }

    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.age = new Float32Array(count).fill(1e9);
    this.life = new Float32Array(count).fill(1);
    this.size = new Float32Array(count);
    this.grow = new Float32Array(count);
    this.alpha = new Float32Array(count);
    this.tint = new Float32Array(count * 3);
    this.heat = new Float32Array(count);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(new Float32Array(count), 1));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    geo.setAttribute('tint', new THREE.BufferAttribute(this.tint, 3));
    this.points = new THREE.Points(geo, smokeMaterial(this.uPx, vacuum));
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    // Point sizes are in world units: the shader needs the target's height in pixels.
    this.points.onBeforeRender = (renderer) => {
      renderer.getDrawingBufferSize(this.tmp);
      this.uPx.value = this.tmp.y / 2;
    };
    this.object.add(this.points);
    this.object.visible = false;
  }

  /** Particles still in the air (keep animating after the engines stop). */
  get busy(): boolean {
    return this.thrust > 0.001 || this.alive > 0;
  }

  /** Engines at `at` (the plane of the nozzles), ground at height `ground` below them. */
  update(dt: number, at: THREE.Vector3, ground: number) {
    this.time += dt;
    const on = this.thrust > 0.001;
    this.object.visible = on || this.alive > 0;
    if (!this.object.visible) return;

    // Flame: length breathes with thrust and flickers a little, every frame different.
    const flick = 1 + 0.07 * Math.sin(this.time * 47) + 0.05 * Math.sin(this.time * 83 + 1.3) + (Math.random() - 0.5) * 0.08;
    const vacuum = this.mode === 'vacuum';
    const len = this.thrust * (vacuum ? 2.2 : 1.25) * flick;
    // The flame spreads out where it meets the ground instead of going through it
    // (on the bay's pad, a little of it shows down the flame trench).
    const room = Math.max(vacuum ? 0.05 : 0.4, at.y - ground + 0.05);
    for (const [m, k, w] of [[this.flame, 1, 1], [this.core, 0.55, 1]] as const) {
      m.visible = on;
      m.position.copy(at);
      const l = Math.min(len * k, room);
      // Squashed against the pad, an air-breathing plume spreads out; in vacuum it just shortens.
      const spread = vacuum ? 1 : w * (1 + 0.6 * Math.max(0, len * k - room));
      m.scale.set(spread, Math.max(0.001, l), spread);
    }

    // Spawn: billows at ignition and near the ground; a thinner trail once high.
    const height = at.y - ground;
    const near = THREE.MathUtils.clamp(1 - height / (vacuum ? 3.2 : 7), 0, 1);
    const rate = on ? (vacuum ? 260 * near * this.thrust : (26 + 70 * near) * this.thrust) : 0;
    this.carry += rate * dt;
    while (this.carry >= 1) {
      this.carry -= 1;
      this.spawn(at, ground, near);
    }

    // Integrate.
    const n = this.age.length;
    const sizes = this.points.geometry.attributes.size!.array as Float32Array;
    const drag = vacuum ? 0 : 1.8;
    const lift = vacuum ? -1.62 : 0.35;
    const amb = this.ambient;
    let alive = 0;
    for (let i = 0; i < n; i++) {
      const a = (this.age[i]! += dt);
      const life = this.life[i]!;
      if (a >= life) {
        this.alpha[i] = 0;
        sizes[i] = 0;
        continue;
      }
      alive++;
      const o = i * 3;
      const k = Math.exp(-drag * dt);
      this.vel[o]! *= k;
      this.vel[o + 2]! *= k;
      this.vel[o + 1] = this.vel[o + 1]! * k + lift * dt;
      this.pos[o]! += this.vel[o]! * dt;
      this.pos[o + 1]! += this.vel[o + 1]! * dt;
      this.pos[o + 2]! += this.vel[o + 2]! * dt;
      const u = a / life;
      if (vacuum) {
        // Dust falls back and stops dead: no air to hold it up.
        if (this.pos[o + 1]! < ground) {
          this.pos[o + 1] = ground;
          this.vel[o] = this.vel[o + 1] = this.vel[o + 2] = 0;
          this.age[i] = Math.max(a, life - 0.35);
        }
        this.alpha[i] = 0.6 * Math.min(1, a * 8) * Math.min(1, (life - a) / 0.35);
        sizes[i] = this.size[i]!;
      } else {
        if (this.pos[o + 1]! < ground + 0.05) {
          this.pos[o + 1] = ground + 0.05;
          this.vel[o + 1] = Math.abs(this.vel[o + 1]!) * 0.2;
        }
        this.alpha[i] = 0.62 * Math.min(1, a * 5) * (1 - u) ** 1.6;
        sizes[i] = this.size[i]! + this.grow[i]! * Math.sqrt(a);
      }
      // Lit by the sky, and orange where the flame lights it from inside (fading as it drifts off).
      const glow = this.heat[i]! * Math.exp(-a * (vacuum ? 2 : 3.2)) * this.thrust;
      this.tint[o] = amb.r + glow * 2.4;
      this.tint[o + 1] = amb.g + glow * 1.1;
      this.tint[o + 2] = amb.b + glow * 0.3;
    }
    this.alive = alive;
    const g = this.points.geometry.attributes;
    g.position!.needsUpdate = true;
    g.size!.needsUpdate = true;
    g.alpha!.needsUpdate = true;
    g.tint!.needsUpdate = true;
  }

  private spawn(at: THREE.Vector3, ground: number, near: number) {
    const i = this.next;
    this.next = (this.next + 1) % this.age.length;
    const o = i * 3;
    this.age[i] = 0;
    const a = Math.random() * Math.PI * 2;
    if (this.mode === 'vacuum') {
      // Dust sprays out flat from under the plume, fast and low.
      const r = 0.1 + Math.random() * 0.5;
      const sp = 2.5 + Math.random() * 5.5;
      this.pos.set([at.x + Math.cos(a) * r, ground + 0.02, at.z + Math.sin(a) * r], o);
      this.vel.set([Math.cos(a) * sp, 0.3 + Math.random() * 1.2, Math.sin(a) * sp], o);
      this.life[i] = 1.6 + Math.random() * 1.2;
      this.size[i] = 0.018 + Math.random() * 0.035;
      this.grow[i] = 0;
      this.heat[i] = 0.15;
      this.tint.set([this.ambient.r, this.ambient.g, this.ambient.b], o);
      return;
    }
    const low = at.y - ground < 1.2 || Math.random() < near;
    if (low) {
      // Steam off the pad: out sideways along the ground, then up and away.
      const sp = 2.2 + Math.random() * 3.2;
      this.pos.set([at.x + Math.cos(a) * 0.25, ground + 0.1, at.z + Math.sin(a) * 0.25], o);
      this.vel.set([Math.cos(a) * sp, 0.2 + Math.random() * 0.6, Math.sin(a) * sp], o);
      this.life[i] = 2.6 + Math.random() * 2;
      this.size[i] = 0.35 + Math.random() * 0.3;
      this.grow[i] = 0.9 + Math.random() * 0.7;
    } else {
      // The column behind the climb: pushed down by the jet, then left hanging.
      this.pos.set([at.x + Math.cos(a) * 0.12, at.y - 0.6 - Math.random() * 0.8, at.z + Math.sin(a) * 0.12], o);
      this.vel.set([Math.cos(a) * 0.4, -2.5 - Math.random() * 2, Math.sin(a) * 0.4], o);
      this.life[i] = 2 + Math.random() * 1.6;
      this.size[i] = 0.3 + Math.random() * 0.25;
      this.grow[i] = 0.6 + Math.random() * 0.4;
    }
    this.heat[i] = 0.5 + Math.random() * 0.4;
  }

  /** Engines off and every particle gone, at once (a skip). */
  clear() {
    this.thrust = 0;
    this.age.fill(1e9);
    this.alpha.fill(0);
    this.alive = 0;
    this.object.visible = false;
  }

  dispose() {
    for (const m of [this.flame, this.core, this.points]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}

/** A unit-length cone hanging from y = 0 to y = −1, open at the top. `v` runs 0 at the nozzle to 1 at the tip. */
function flameGeometry(radius: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(radius, radius * 0.08, 1, 16, 6, true);
  g.translate(0, -0.5, 0);
  // Bulge just below the nozzle, as an underexpanded plume does.
  const p = g.attributes.position!;
  for (let i = 0; i < p.count; i++) {
    const y = -p.getY(i);
    const k = 1 + 0.35 * Math.sin(Math.min(1, y * 2.2) * Math.PI) * (1 - y);
    p.setX(i, p.getX(i) * k);
    p.setZ(i, p.getZ(i) * k);
  }
  g.computeVertexNormals();
  return g;
}

function flameMaterial(hot: readonly [number, number, number], cool: readonly [number, number, number], opacity: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { uHot: { value: new THREE.Color(...hot) }, uCool: { value: new THREE.Color(...cool) }, uOpacity: { value: opacity } },
    vertexShader: /* glsl */ `
      varying float vAlong;
      varying float vEdge;
      void main() {
        vAlong = clamp(-position.y, 0.0, 1.0);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * normal);
        // Orthographic cameras look straight down -z; perspective ones from the eye.
        vec3 v = projectionMatrix[2][3] == 0.0 ? vec3(0.0, 0.0, 1.0) : normalize(-mv.xyz);
        vEdge = abs(dot(n, v));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uHot;
      uniform vec3 uCool;
      uniform float uOpacity;
      varying float vAlong;
      varying float vEdge;
      void main() {
        // Bright at the nozzle, fading to the tip; soft at the silhouette.
        float a = pow(1.0 - vAlong, 1.4) * smoothstep(0.0, 0.7, vEdge) * uOpacity;
        gl_FragColor = vec4(mix(uHot, uCool, smoothstep(0.0, 0.7, vAlong)) * a, 1.0);
      }`,
  });
}

function smokeMaterial(uPx: { value: number }, dust: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uPx },
    vertexShader: /* glsl */ `
      attribute float size;
      attribute float alpha;
      attribute vec3 tint;
      uniform float uPx;
      varying float vAlpha;
      varying vec3 vTint;
      void main() {
        vAlpha = alpha;
        vTint = tint;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        // World-unit sizes: orthographic projections don't shrink with distance.
        float w = projectionMatrix[2][3] == 0.0 ? 1.0 : -mv.z;
        gl_PointSize = size * projectionMatrix[1][1] * uPx / w;
      }`,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      varying vec3 vTint;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(p, p);
        if (r2 > 1.0) discard;
        float a = (1.0 - r2);
        a *= a;
        ${dust ? 'float lit = 1.0;' : '// Lit from above: brighter crowns, shaded bellies.\n        float lit = 0.84 - 0.2 * p.y;'}
        gl_FragColor = vec4(vTint * lit, vAlpha * a);
      }`,
  });
}
