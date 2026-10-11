/** Midnight Valley: a tiny Silicon Valley town, late at night. */
export const PALETTE = {
  skyTop: '#05081a',
  skyMid: '#111739',
  skyHorizon: '#33204a',
  fog: 0x161a35,
  fogRain: 0x1a2236,

  grass: 0x29503a,
  grassDark: 0x162b20,
  lawn: 0x35603f,
  earth: 0x3a2a20,
  earthDark: 0x1d1512,
  water: 0x10233f,

  road: 0x23242f,
  roadLine: 0x8a8060,
  sidewalk: 0x555869,
  plaza: 0x474959,

  walls: [0xd8c3a0, 0xa9bdd2, 0xcf957f, 0x97b8a2, 0xe0d0a8, 0xb4a2cc, 0xc2b08f, 0xe8dccb] as const,
  roofs: [0x6a3e3c, 0x3f4e66, 0x584436, 0x2f5048, 0x7a4c3a, 0x48405e] as const,
  trim: 0xefe6d6,
  door: 0x3a2a24,
  glass: 0x1c2848,

  officeWalls: [0x2b3150, 0x353c5e, 0x232842, 0x3c3a52, 0x2a3a4e] as const,
  concrete: 0x55576a,

  leaves: [0x2f6b46, 0x3c7d4f, 0x285c3e, 0x4a7a3a] as const,
  trunk: 0x4a3326,

  /** Window light, deliberately > 1 so bloom picks it up. */
  windowWarm: [1.6, 1.05, 0.5] as const,
  windowCool: [0.8, 1.1, 1.6] as const,
  lamp: [2.4, 1.7, 0.9] as const,
};
