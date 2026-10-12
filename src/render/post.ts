import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

export type Quality = 'low' | 'medium' | 'high';

/**
 * GTAO that ignores see-through things. Its normal/depth pre-pass draws every
 * mesh with a normal material, so sprites (the fog), wakes and other
 * transparent effects would turn into solid slabs that cast AO "shadows".
 */
class SolidAO extends GTAOPass {
  private hidden: THREE.Object3D[] = [];

  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget, deltaTime: number, maskActive: boolean) {
    this.scene.traverseVisible((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if ((o as THREE.Sprite).isSprite || (m && !Array.isArray(m) && m.transparent)) this.hidden.push(o);
    });
    for (const o of this.hidden) o.visible = false;
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
    for (const o of this.hidden) o.visible = true;
    this.hidden.length = 0;
  }
}

/**
 * The final look: a miniature you could pick up. Soft contact shadows
 * (GTAO), bloom on lights after dark, a tilt-shift blur at the top and
 * bottom of the frame, and a gentle filmic grade with a vignette.
 */
export class Post {
  readonly composer: EffectComposer;
  private ao: SolidAO;
  private bloom: UnrealBloomPass;
  private grade: ShaderPass;
  quality: Quality;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, quality: Quality) {
    this.quality = quality;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));

    this.ao = new SolidAO(scene, camera, size.x, size.y);
    this.ao.updateGtaoMaterial({ radius: 0.55, distanceExponent: 1.6, thickness: 1.4, scale: 1.15, samples: 12, distanceFallOff: 1, screenSpaceRadius: false });
    this.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
    this.ao.blendIntensity = 0.85;
    this.composer.addPass(this.ao);

    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.85, 0.55, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.setQuality(quality);
  }

  setQuality(q: Quality) {
    this.quality = q;
    this.ao.enabled = q === 'high';
    this.grade.uniforms.uTiltSamples!.value = q === 'low' ? 0 : 1;
  }

  setSize(w: number, h: number, pixelRatio: number) {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(w, h);
    this.grade.uniforms.uResolution!.value.set(w * pixelRatio, h * pixelRatio);
  }

  /**
   * Per-frame look. `night` 0–1; `tilt` is how strong the miniature blur is
   * (stronger when zoomed out); `focusY` is where in the frame (0 bottom,
   * 1 top) the band of sharp focus sits.
   */
  update(time: number, look: { bloom: number; night: number; tilt: number; focusY: number; warmth: number }) {
    // Daylight barely blooms (just glints); night lights glow properly.
    this.bloom.strength = look.bloom * (0.2 + 0.8 * look.night);
    this.bloom.threshold = 0.9 + (1 - look.night) * 0.6;
    this.bloom.radius = 0.5 + look.night * 0.2;
    const u = this.grade.uniforms;
    u.uTime!.value = time;
    u.uTilt!.value = look.tilt;
    u.uFocus!.value = look.focusY;
    u.uNight!.value = look.night;
    u.uWarm!.value = look.warmth;
  }

  render(dt: number) {
    this.composer.render(dt);
  }
}

/** Tilt-shift, grade and vignette, in one pass over the tone-mapped image. */
const GradeShader = {
  name: 'TinyTownGrade',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uTilt: { value: 1 },
    uTiltSamples: { value: 1 },
    uFocus: { value: 0.5 },
    uNight: { value: 0 },
    uWarm: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uTime, uTilt, uTiltSamples, uFocus, uNight, uWarm;
    varying vec2 vUv;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

    vec3 tiltShift(vec2 uv) {
      // Sharp band through the focus line; blur grows toward the top and bottom edges.
      float d = abs(uv.y - uFocus);
      float amount = smoothstep(0.16, 0.62, d) * uTilt;
      vec3 c = texture2D(tDiffuse, uv).rgb;
      if (uTiltSamples < 0.5 || amount < 0.02) return c;
      vec2 px = 1.0 / uResolution;
      float r = amount * 3.2;
      vec3 acc = c;
      float wsum = 1.0;
      // Golden-angle spiral: smooth bokeh with few taps.
      for (int i = 0; i < 14; i++) {
        float fi = float(i) + 0.5;
        float a = fi * 2.39996;
        float rr = sqrt(fi / 14.0) * r;
        vec2 o = vec2(cos(a), sin(a)) * rr * px * uResolution.y / 900.0 * 2.2;
        vec3 s = texture2D(tDiffuse, uv + o).rgb;
        float w = 1.0 + dot(s, vec3(0.3)) * 0.6;
        acc += s * w;
        wsum += w;
      }
      return acc / wsum;
    }

    void main() {
      vec2 uv = vUv;
      vec3 col = tiltShift(uv);

      // Grade: a touch more contrast and saturation, warm highlights, cool shadows.
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, 1.08 + uNight * 0.06);
      col = (col - 0.5) * 1.04 + 0.5;
      vec3 warm = vec3(1.035, 1.0, 0.95);
      vec3 cool = vec3(0.95, 0.99, 1.06);
      col *= mix(cool, warm, smoothstep(0.15, 0.85, l) * (0.6 + uWarm * 0.4));

      // Vignette, a little stronger at night.
      vec2 q = uv - 0.5;
      q.x *= uResolution.x / uResolution.y;
      float v = smoothstep(1.15, 0.35, length(q) * (1.0 + uNight * 0.15));
      col *= mix(0.72, 1.0, v);

      // Fine grain so gradients don't band.
      col += (hash(uv * uResolution + fract(uTime) * 97.0) - 0.5) * 0.012;
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`,
};
