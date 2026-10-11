import * as THREE from 'three';
import { SEA, coastDistance, isBeach, terrainHeight } from '../world/map.ts';
import type { Atmosphere } from '../world/daylight.ts';

/** Area the terrain mesh covers; beyond it, open water. */
const AREA = { x0: -110, x1: 120, z0: -120, z1: 95 } as const;
/** Area the water shader knows the shoreline for. */
const DEPTH = { x0: -110, z0: -120, w: 230, d: 215 } as const;

const GRASS = new THREE.Color(0x7fbf55);
const PARK = new THREE.Color(0x6aae47);
const GOLD = new THREE.Color(0xcdb46a);
const DRY = new THREE.Color(0xb39457);
const ROCK = new THREE.Color(0x9b8e7c);
const SAND = new THREE.Color(0xf0dcab);
const WET = new THREE.Color(0xc7b48a);
const SEABED = new THREE.Color(0x7aa7a0);

/**
 * The ground and the bay. One sculpted mesh for every coast, hill and
 * island, and a water shader with sky reflection, sun glints, depth colour
 * and surf that breaks along the shore.
 */
export class Terrain {
  readonly object = new THREE.Group();
  private water: THREE.ShaderMaterial;

  constructor() {
    this.object.add(this.ground());
    this.water = waterMaterial(depthTexture());
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(900, 900, 1, 1).rotateX(-Math.PI / 2), this.water);
    sea.position.y = SEA;
    sea.renderOrder = -1;
    this.object.add(sea);
  }

  private ground(): THREE.Mesh {
    const step = 0.9;
    const nx = Math.round((AREA.x1 - AREA.x0) / step);
    const nz = Math.round((AREA.z1 - AREA.z0) / step);
    const geo = new THREE.PlaneGeometry(AREA.x1 - AREA.x0, AREA.z1 - AREA.z0, nx, nz).rotateX(-Math.PI / 2);
    geo.translate((AREA.x0 + AREA.x1) / 2, 0, (AREA.z0 + AREA.z1) / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    const heights = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = terrainHeight(x, z);
      heights[i] = h;
      pos.setY(i, h);
    }
    // Slope from neighbours, for rock on cliffs.
    const at = (ix: number, iz: number) => heights[Math.max(0, Math.min(nz, iz)) * (nx + 1) + Math.max(0, Math.min(nx, ix))]!;
    for (let i = 0; i < pos.count; i++) {
      const ix = i % (nx + 1);
      const iz = Math.floor(i / (nx + 1));
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = heights[i]!;
      const slope = Math.hypot(at(ix + 1, iz) - at(ix - 1, iz), at(ix, iz + 1) - at(ix, iz - 1)) / (2 * step);
      const noise = 0.5 + 0.5 * Math.sin(x * 0.53 + Math.sin(z * 0.31) * 3) * Math.cos(z * 0.47 - x * 0.12);
      if (h < SEA + 0.05) {
        c.copy(SEABED).lerp(WET, Math.max(0, 1 + (h - SEA) * 2));
      } else if (isBeach(x, z) || h < SEA + 0.25) {
        c.copy(SAND).lerp(WET, Math.max(0, 1 - (h - SEA) * 3));
      } else {
        // Green near the city and on north faces, gold on the high dry hills.
        c.copy(Math.abs(h) < 0.05 ? PARK : GRASS);
        c.lerp(GOLD, Math.min(1, Math.max(0, (h - 1.2) / 6 + (noise - 0.5) * 0.7)));
        if (h > 6) c.lerp(DRY, 0.35);
        c.lerp(ROCK, Math.min(1, Math.max(0, (slope - 0.75) * 1.4)));
        c.offsetHSL(0, 0, (noise - 0.5) * 0.05);
      }
      colors.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
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
    u.uLight!.value = 0.32 + 0.68 * Math.min(1, a.hemiIntensity / 1.5) * (1 - a.night * 0.55);
    u.uNight!.value = a.night;
  }
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
