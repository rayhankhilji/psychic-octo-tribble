import * as THREE from 'three';
import { home, neighbourhoodGrounds, tree, type TreeKind } from '../render/buildings.ts';
import { GeoBuilder } from '../render/geo.ts';
import { homeLots, lotPosition } from '../world/layout.ts';
import { rng } from '../world/rng.ts';
import { headquarters } from '../render/towers.ts';
import { founderHome, itemModel, plane, rocket, yacht } from '../render/models.ts';
import { CATALOG, HOME_TIERS } from '../game/catalog.ts';
import { blockCentre } from '../world/layout.ts';
import type { HomeKind } from '../world/layout.ts';
import { carShowcase, peopleShowcase } from '../render/traffic.ts';

export interface ShowItem {
  label: string;
  object: THREE.Object3D;
  /** Footprint in world units, for spacing. */
  size?: number;
  update?: (dt: number, time: number) => void;
}

const group = (o: { group: THREE.Group }) => o.group;

/** Model sets for the showcase. Add a set when you work on a family of models. */
export const SETS: Record<string, () => ShowItem[]> = {
  homes: () => {
    const out: ShowItem[] = [];
    for (const kind of ['house', 'townhouse', 'apartment'] as HomeKind[]) {
      for (let i = 0; i < 6; i++) out.push({ label: `${kind} ${i}`, object: group(home(kind, 1000 + i * 37)), size: 1.2 });
    }
    return out;
  },
  /** One home kind at a time, for close-ups: `?set=house&zoom=9`. */
  ...Object.fromEntries(
    (['house', 'townhouse', 'apartment'] as HomeKind[]).map((kind) => [
      kind,
      () => Array.from({ length: 6 }, (_, i) => ({ label: `${kind} ${i}`, object: group(home(kind, 2000 + i * 53)), size: 1.2 })),
    ]),
  ),
  /** Whole neighbourhood blocks: grounds plus ten homes on their real lots and rotations. */
  street: () =>
    (['house', 'townhouse', 'apartment', 'house'] as HomeKind[]).map((kind, n) => {
      const g = new THREE.Group();
      const c = blockCentre({ bx: 0, bz: 0 });
      g.add(group(neighbourhoodGrounds(0, 0, n, 91 + n)));
      homeLots(n).forEach((lot, k) => {
        const p = lotPosition({ bx: 0, bz: 0 }, lot);
        const h = group(home(kind, 5000 + n * 101 + k * 13));
        h.position.set(p.x, 0, p.z);
        h.rotation.y = lot.rot;
        g.add(h);
      });
      g.position.set(-c.x, 0, -c.z);
      const o = new THREE.Group();
      o.add(g);
      return { label: `${kind} block ${n}`, object: o, size: 5 };
    }),
  trees: () =>
    (['palm', 'round', 'cypress', 'plane', 'ficus', 'eucalyptus'] as TreeKind[]).map((kind, i) => {
      const b = new GeoBuilder();
      const r = rng(300 + i);
      for (let k = 0; k < 4; k++) tree(b, r, (k % 2) * 0.7 - 0.35, Math.floor(k / 2) * 0.7 - 0.35, 1, 0, kind);
      return { label: kind, object: group(b.build()), size: 1.6 };
    }),
  grounds: () =>
    [0, 1, 2].map((n) => {
      const g = group(neighbourhoodGrounds(0, 0, n, 77 + n));
      const c = blockCentre({ bx: 0, bz: 0 });
      g.position.set(-c.x, 0, -c.z);
      return { label: `grounds ${n}`, object: g, size: 5 };
    }),
  towers: () => [
    ...CATALOG.filter((i) => i.category === 'business').map((i) => ({ label: i.name, object: group(itemModel(i.model, 0, 0, 11)), size: i.placement.kind === 'plot' && i.placement.size === 4 ? 4 : 2 })),
    ...[0, 1, 2, 3, 4].map((level) => ({ label: `HQ level ${level}`, object: headquarters('Nightjar', 12, 5, level).group, size: 4 })),
  ],
  items: () =>
    CATALOG.filter((i) => i.placement.kind === 'plot' && i.category !== 'business').map((i) => ({
      label: i.name,
      object: group(itemModel(i.model, 0, 0, 21)),
      size: i.placement.kind === 'plot' && i.placement.size === 4 ? 4 : 2,
    })),
  founder: () =>
    HOME_TIERS.flatMap((t) => t.options)
      .filter((o) => o.id !== 'moon-house')
      .map((o) => ({ label: o.name, object: group(founderHome(o.id, 3)), size: 2.4 })),
  vehicles: () => [
    ...['prop', 'jet', 'jet-long', 'jet-super'].map((m) => ({ label: m, object: group(plane(m, 4)), size: 2 })),
    { label: 'day yacht', object: group(yacht('day', 2)), size: 2 },
    { label: 'superyacht', object: group(yacht('super', 2)), size: 3 },
    { label: 'rocket', object: group(rocket(1)), size: 1.5 },
  ],
};

// ─── Downtown and everything you can buy (towers.ts / models.ts) ───────────
import { airliner, cloudBank, encampment, plotMarker } from '../render/models.ts';
import { hash as ttHash, rng as ttRng } from '../world/rng.ts';

/** Seeds that give each of the four tower styles. */
function ttTowerSeeds(): number[] {
  const out: number[] = [];
  for (let i = 0; out.length < 4 && i < 200; i++) {
    const s = ttHash('tt-tower', i);
    const r = ttRng(s);
    r();
    if (Math.floor(r() * 4) === out.length) out.push(s);
  }
  return out;
}

Object.assign(SETS, {
  'tt-skyline': () => [
    ...ttTowerSeeds().map((s, i) => ({ label: `tower3 style ${i}`, object: group(itemModel('tower3', 0, 0, s)), size: 2 })),
    ...ttTowerSeeds().map((s, i) => ({ label: `tower5 style ${i}`, object: group(itemModel('tower5', 0, 0, s)), size: 2 })),
  ],
  'tt-landmarks': () => [
    { label: 'pyramid', object: group(itemModel('pyramid', 0, 0, 7)), size: 4 },
    { label: 'supertall', object: group(itemModel('spire', 0, 0, 7)), size: 4 },
  ],
  'tt-hq': () => [0, 1, 2, 3, 4].map((level) => ({ label: `HQ ${level}`, object: headquarters('Nightjar Labs', [2, 8, 12, 24, 30][level]!, 5, level).group, size: 4 })),
  'tt-business': () => ['shops', 'coworking', 'campus', 'venture', 'deco', 'cafe', 'foodtrucks', 'arena'].map((m) => ({ label: m, object: group(itemModel(m, 0, 0, ttHash('tt', m))), size: 2 })),
  'tt-civic': () => ['park', 'garden', 'courts', 'library', 'research'].map((m) => ({ label: m, object: group(itemModel(m, 0, 0, ttHash('tt', m))), size: 2 })),
  'tt-blocks': () => ['stadium', 'university', 'amusement'].map((m) => ({ label: m, object: group(itemModel(m, 0, 0, ttHash('tt', m))), size: 4 })),
  'tt-homes': () =>
    HOME_TIERS.flatMap((t) => t.options)
      .filter((o) => o.id !== 'moon-house')
      .map((o) => ({ label: o.name, object: group(founderHome(o.id, 3)), size: 2.4 })),
  'tt-museum': () => [{ label: 'hacker house (museum)', object: group(founderHome('hacker-house', 3, true)), size: 1.2 }, { label: 'hacker house', object: group(founderHome('hacker-house', 3)), size: 1.2 }],
  'tt-vehicles': () => [
    ...['prop', 'jet', 'jet-long', 'jet-super'].map((m) => ({ label: m, object: group(plane(m, 4)), size: 2.4 })),
    { label: 'airliner', object: group(airliner(3)), size: 2.6 },
    { label: 'day yacht', object: group(yacht('day', 2)), size: 2.4 },
    { label: 'superyacht', object: group(yacht('super', 2)), size: 2.8 },
    { label: 'rocket', object: group(rocket(1)), size: 1.5 },
  ],
  'tt-state': () => [
    { label: 'clouds', object: group(cloudBank(0, 0, 4.6, 4.6, 9)), size: 5 },
    { label: 'plot for sale', object: group(plotMarker(0, 0)), size: 2.4 },
    { label: 'encampment', object: group(encampment(Array.from({ length: 8 }, (_, i) => ({ x: (i % 4) * 0.45 - 0.7, z: Math.floor(i / 4) * 0.5 - 0.25, rot: i * 0.7 })), 3)), size: 2.4 },
  ],
} satisfies Record<string, () => ShowItem[]>);

// Street life: every car model (brake lights tap on and off), and people walking round a block.
Object.assign(SETS, {
  cars: () => carShowcase(),
  people: () => peopleShowcase(),
} satisfies Record<string, () => ShowItem[]>);

// One model up close: `?set=tt-one&what=item:stadium&seed=3` (item:, home:, plane:, yacht:, hq:, airliner, rocket, clouds, plot, tents).
Object.assign(SETS, {
  'tt-one': (): ShowItem[] => {
    const p = new URLSearchParams(location.search);
    const what = p.get('what') ?? 'item:tower5';
    const seed = Number(p.get('seed') ?? 7);
    const [kind, arg = ''] = what.split(':');
    const make = (): { group: THREE.Group } => {
      switch (kind) {
        case 'item': return itemModel(arg, 0, 0, seed);
        case 'home': return founderHome(arg, seed, p.has('museum'));
        case 'plane': return plane(arg, seed);
        case 'yacht': return yacht(arg as 'day' | 'super', seed);
        case 'hq': return headquarters(p.get('name') ?? 'Nightjar Labs', Number(p.get('floors') ?? 30), seed, Number(arg));
        case 'airliner': return airliner(seed);
        case 'rocket': return rocket(seed);
        case 'clouds': return cloudBank(0, 0, 4.6, 4.6, seed);
        case 'plot': return plotMarker(0, 0);
        default: return encampment(Array.from({ length: 8 }, (_, i) => ({ x: (i % 4) * 0.45 - 0.7, z: Math.floor(i / 4) * 0.5 - 0.25, rot: i * 0.7 })), seed);
      }
    };
    return [{ label: what, object: make().group, size: Number(p.get('size') ?? 4) }];
  },
} satisfies Record<string, () => ShowItem[]>);
