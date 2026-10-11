/**
 * Time of day for the world, driven by the viewer's local clock.
 * Pure numbers only so it can be tested without a renderer.
 */

export type Rgb = [number, number, number];

export interface Atmosphere {
  /** Local hour, 0–24. */
  hour: number;
  phase: 'night' | 'dawn' | 'morning' | 'day' | 'evening' | 'dusk';
  /** Unit vector pointing *toward* the sun (or moon at night). */
  lightDir: [number, number, number];
  lightColor: Rgb;
  lightIntensity: number;
  skyColor: Rgb;
  groundColor: Rgb;
  hemiIntensity: number;
  /** Haze and background colour. */
  fog: Rgb;
  /** 0 = broad daylight, 1 = full night. Drives window lights, lamps, neon. */
  night: number;
  bloom: number;
  exposure: number;
}

interface Key {
  h: number;
  light: string;
  intensity: number;
  sky: string;
  ground: string;
  hemi: number;
  fog: string;
  night: number;
  bloom: number;
  exposure: number;
}

// Golden Coast: bright Californian days, long golden evenings, moonlit nights.
const KEYS: Key[] = [
  { h: 0, light: '#8fa6ff', intensity: 0.9, sky: '#3a4a86', ground: '#1a1830', hemi: 1.1, fog: '#121a38', night: 1, bloom: 0.7, exposure: 1.15 },
  { h: 5.2, light: '#8fa6ff', intensity: 0.9, sky: '#3a4a86', ground: '#1a1830', hemi: 1.1, fog: '#141c3c', night: 1, bloom: 0.7, exposure: 1.15 },
  { h: 6.3, light: '#ff9a6a', intensity: 1.0, sky: '#e7a6a0', ground: '#4a3a4a', hemi: 1.0, fog: '#e4a79a', night: 0.6, bloom: 0.55, exposure: 1.05 },
  { h: 7.6, light: '#ffe2bf', intensity: 2.4, sky: '#bfdcff', ground: '#6f8a58', hemi: 1.35, fog: '#cfe4f4', night: 0, bloom: 0.18, exposure: 1.0 },
  { h: 12.5, light: '#fff6e6', intensity: 3.0, sky: '#cde6ff', ground: '#7a9a5e', hemi: 1.5, fog: '#d6ebf7', night: 0, bloom: 0.15, exposure: 1.0 },
  { h: 16.6, light: '#ffe6bd', intensity: 2.7, sky: '#cfe0f5', ground: '#7a9058', hemi: 1.4, fog: '#dde6ee', night: 0, bloom: 0.18, exposure: 1.0 },
  { h: 18.4, light: '#ff8a3a', intensity: 2.6, sky: '#ffa877', ground: '#6a4038', hemi: 0.95, fog: '#f2a77c', night: 0.45, bloom: 0.5, exposure: 1.02 },
  { h: 19.5, light: '#e8707a', intensity: 0.9, sky: '#8a72b0', ground: '#2e2440', hemi: 1.0, fog: '#6a5486', night: 0.8, bloom: 0.75, exposure: 1.08 },
  { h: 20.6, light: '#8fa6ff', intensity: 0.9, sky: '#3a4a86', ground: '#1a1830', hemi: 1.1, fog: '#121a38', night: 1, bloom: 0.7, exposure: 1.15 },
  { h: 24, light: '#8fa6ff', intensity: 0.9, sky: '#3a4a86', ground: '#1a1830', hemi: 1.1, fog: '#121a38', night: 1, bloom: 0.7, exposure: 1.15 },
];

const SUNRISE = 6.1;
const SUNSET = 19.7;
/** Half-width, in hours, of the moon ↔ sun hand-over at each end of the day. */
const FADE = 0.8;

export function hex(s: string): Rgb {
  const n = parseInt(s.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
const smooth = (t: number) => t * t * (3 - 2 * t);

export function phaseOf(hour: number): Atmosphere['phase'] {
  if (hour < 5.5 || hour >= 20.3) return 'night';
  if (hour < 7.2) return 'dawn';
  if (hour < 11) return 'morning';
  if (hour < 17.5) return 'day';
  if (hour < 19.4) return 'evening';
  return 'dusk';
}

/**
 * Where the light comes from. The sun rises front-right, stands front-left
 * at midday (one visible face lit, the other in shade, shadows falling up
 * and to the right) and sets low over the bay. At night, a high moon.
 */
function lightDirection(hour: number): [number, number, number] {
  const moon = norm([-0.35, 1, 0.55]);
  if (hour <= SUNRISE - FADE || hour >= SUNSET + FADE) return moon;
  const u = Math.min(1, Math.max(0, (hour - SUNRISE) / (SUNSET - SUNRISE)));
  const az = ((40 + 130 * u) * Math.PI) / 180;
  const el = ((5 + 57 * Math.sin(Math.PI * u)) * Math.PI) / 180;
  const sun = norm([Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)]);
  // Cross-fade sun ↔ moon around sunrise and sunset, while the light is dim.
  const edge = hour < 12 ? (hour - (SUNRISE - FADE)) / (2 * FADE) : (SUNSET + FADE - hour) / (2 * FADE);
  const t = smooth(Math.min(1, Math.max(0, edge)));
  return norm([mix(moon[0], sun[0], t), mix(moon[1], sun[1], t), mix(moon[2], sun[2], t)]);
}

function norm(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** The world's light at a local hour. `wet` (0–1) greys it into an overcast, rainy version. */
export function atmosphereAt(hour: number, wet = 0): Atmosphere {
  const h = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1]!.h <= h) i++;
  const a = KEYS[i]!;
  const b = KEYS[i + 1]!;
  const t = smooth((h - a.h) / (b.h - a.h || 1));

  let lightColor = mixRgb(hex(a.light), hex(b.light), t);
  let skyColor = mixRgb(hex(a.sky), hex(b.sky), t);
  let fog = mixRgb(hex(a.fog), hex(b.fog), t);
  const night = mix(a.night, b.night, t);
  let lightIntensity = mix(a.intensity, b.intensity, t);

  if (wet > 0) {
    const grey = (c: Rgb, k: number): Rgb => {
      const l = (c[0] + c[1] + c[2]) / 3;
      return mixRgb(c, [l * k, l * k * 1.02, l * k * 1.08], wet);
    };
    lightColor = grey(lightColor, 0.9);
    skyColor = grey(skyColor, 0.85);
    fog = grey(fog, 0.8);
    lightIntensity *= 1 - wet * 0.65;
  }

  return {
    hour: h,
    phase: phaseOf(h),
    lightDir: lightDirection(h),
    lightColor,
    lightIntensity,
    skyColor,
    groundColor: mixRgb(hex(a.ground), hex(b.ground), t),
    hemiIntensity: mix(a.hemi, b.hemi, t),
    fog,
    night: Math.min(1, night + wet * 0.25 * (1 - night)),
    bloom: mix(a.bloom, b.bloom, t),
    exposure: mix(a.exposure, b.exposure, t),
  };
}

/** Local time as an hour of the day (e.g. 14.5 for 2:30 pm). */
export function localHour(d = new Date()): number {
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}

/** Parses "14:30", "7", "7pm" style overrides. Returns null if unparseable. */
export function parseHour(s: string | null): number | null {
  if (!s) return null;
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(s.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ampm = m[3]?.toLowerCase();
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  if (h > 24 || min > 59) return null;
  return (h + min / 60) % 24;
}
