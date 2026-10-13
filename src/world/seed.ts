/**
 * The seed of the world being shown. Every founder's map is generated from
 * one: the same size, the same plots and unlocks, a different layout. Seed 0
 * is the classic map (the demo). Set it once at boot, before anything reads
 * the map, and never change it while a city is on screen.
 */
let current = 0;

export function setWorldSeed(seed: number) {
  current = Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) % 2 ** 31 : 0;
}

export function worldSeed(): number {
  return current;
}
