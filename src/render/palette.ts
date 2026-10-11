/**
 * Golden Coast: a sunny cross between San Francisco and Los Angeles.
 * Stucco and painted-lady houses, terracotta roofs, palms, glass towers,
 * a turquoise bay and golden hills.
 */
export const PALETTE = {
  grass: 0x74b84c,
  grassDark: 0x5c9c3e,
  lawn: 0x82c757,
  earth: 0x9a7650,
  seawall: 0xe4dccb,
  sand: 0xf1dba4,
  sandWet: 0xd8bd84,
  water: 0x1c7cc2,
  waterDeep: 0x135f9e,
  shallows: '#4fd6d6',
  pool: 0x48d0e6,
  hillGreen: 0x6aa548,
  hillGold: 0xc8b064,
  hillDry: 0xa98b52,

  road: 0x5d616c,
  roadLine: 0xf5f1e4,
  roadYellow: 0xf2c84b,
  sidewalk: 0xdcd6c8,
  plaza: 0xe6e0d2,
  wood: 0xa77a50,

  walls: [0xf6e7c8, 0xf3c6a2, 0xf4a6a0, 0xbfe4d0, 0xf6df8c, 0xf8f5ee, 0xc6dcf2, 0xeab6cf] as const,
  /** SF painted ladies: stronger colours. */
  victorian: [0x7fb7d8, 0xe78a8a, 0xf0c45a, 0x8fcf9f, 0xc79ad8, 0xf2a35e, 0x6fa0a8] as const,
  roofs: [0xd4683a, 0xc4552f, 0xe07b45, 0x9a5038, 0x5f6c7c, 0xb94b38] as const,
  trim: 0xfbf8f2,
  door: 0x6b4a3a,
  glass: 0x7aa8d0,
  darkGlass: 0x3f6588,

  officeWalls: [0x7db3dd, 0x5e98c8, 0xdcd3c3, 0xb9c6d2, 0x9cc9ea, 0xece6da] as const,
  concrete: 0xcfcabd,
  steel: 0x8b95a3,

  leaves: [0x4f9d3b, 0x63b347, 0x3f8b3a, 0x7cbd4c] as const,
  pine: [0x2f7a45, 0x3a8a4c, 0x2a6a3e] as const,
  fronds: [0x5aa83a, 0x6fbf45, 0x4c9a34] as const,
  trunk: 0x8a6646,
  palmTrunk: 0xb79466,

  bridge: 0xc8402e,

  /** Emissive colours, deliberately > 1 so bloom catches them at night. */
  windowWarm: [1.6, 1.05, 0.5] as const,
  windowCool: [0.8, 1.1, 1.6] as const,
  lamp: [2.4, 1.7, 0.9] as const,
  /** What a "lit" window looks like in daylight: sky reflected in glass. */
  dayGlass: [0.52, 0.7, 0.86] as const,
};
