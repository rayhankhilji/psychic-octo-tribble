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

// Cloud banks with the hour's moonlit tint applied, as the city does each frame: `?set=tt-clouds&time=22`.
import { setCloudLight } from '../render/models.ts';
import { atmosphereAt } from '../world/daylight.ts';
Object.assign(SETS, {
  'tt-clouds': (): ShowItem[] => {
    const a = atmosphereAt(Number(new URLSearchParams(location.search).get('time') ?? 13));
    const fog = new THREE.Color(...a.fog);
    return [
      { label: 'clouds', object: group(cloudBank(0, 0, 4.6, 4.6, 9)), size: 5, update: () => setCloudLight(a.night, fog) },
      { label: 'block cloud', object: group(cloudBank(0, 0, 4.6, 4.6, 21)), size: 5 },
    ];
  },
} satisfies Record<string, () => ShowItem[]>);

// One tall model, centred on its middle rather than its base: `?set=tt-tall&what=rocket&zoom=4` (same `what` as tt-one).
Object.assign(SETS, {
  'tt-tall': (): ShowItem[] => {
    const [item] = SETS['tt-one']!();
    const h = new THREE.Box3().setFromObject(item!.object).max.y;
    // The iso camera looks down at atan(√2) from vertical, so a point h/2 up lines up with a ground point h/2·√2 further away.
    const g = new THREE.Group();
    item!.object.position.set(h / 2, 0, h / 2);
    g.add(item!.object);
    return [{ ...item!, object: g }];
  },
} satisfies Record<string, () => ShowItem[]>);

// TinyTown Hills houses, every style with two seeds: `?set=tt-hillshouses` (az=225 for the back).
import { hillsHouse, type HillsStyle } from '../render/hills.ts';
Object.assign(SETS, {
  'tt-hillshouses': (): ShowItem[] =>
    (['midcentury', 'spanish', 'modern', 'canyon'] as HillsStyle[]).flatMap((style) =>
      [11, 24].map((seed) => ({ label: `${style} ${seed}`, object: group(hillsHouse(style, seed)), size: 1.4 })),
    ),
} satisfies Record<string, () => ShowItem[]>);
// One Hills house up close: `?set=tt-hills1&style=spanish&seed=11&zoom=14`.
Object.assign(SETS, {
  'tt-hills1': (): ShowItem[] => {
    const p = new URLSearchParams(location.search);
    const style = (p.get('style') ?? 'midcentury') as HillsStyle;
    return [{ label: style, object: group(hillsHouse(style, Number(p.get('seed') ?? 11))), size: 1.2 }];
  },
} satisfies Record<string, () => ShowItem[]>);

// ─── Downtown quality pass: `dt-*` sets ────────────────────────────────────
// Every tower style at both tiers: `?set=dt-towers&zoom=1.2` (add `&tier=5`).
import { Kit as DtKit, slab as dtSlab, tower as dtTower, TOWER_STYLES } from '../render/towers.ts';
Object.assign(SETS, {
  'dt-towers': (): ShowItem[] => {
    const tier = Number(new URLSearchParams(location.search).get('tier') ?? 3);
    return Array.from({ length: TOWER_STYLES }, (_, s) => {
      const k = new DtKit();
      dtSlab(k, 0, 0, 1.9, 1.9);
      dtTower(k, rng(40 + s * 7), 0, 0, tier, [2.4, 1.8, 1.0], s);
      return { label: `tier ${tier} style ${s}`, object: group(k.build()), size: 2.2 };
    });
  },
} satisfies Record<string, () => ShowItem[]>);
// One tower style up close, centred on its middle: `?set=dt-tower&style=4&tier=5&zoom=3`.
Object.assign(SETS, {
  'dt-tower': (): ShowItem[] => {
    const p = new URLSearchParams(location.search);
    const k = new DtKit();
    dtSlab(k, 0, 0, 1.9, 1.9);
    dtTower(k, rng(Number(p.get('seed') ?? 40)), 0, 0, Number(p.get('tier') ?? 3), [2.4, 1.8, 1.0], Number(p.get('style') ?? 4));
    const o = group(k.build());
    const h = new THREE.Box3().setFromObject(o).max.y * Number(p.get('focus') ?? 0.5);
    o.position.set(h, 0, h);
    const g = new THREE.Group();
    g.add(o);
    return [{ label: `tower style ${p.get('style') ?? 4}`, object: g, size: 2 }];
  },
} satisfies Record<string, () => ShowItem[]>);
// Plot items by name, in a row: `?set=dt-items&list=shops,cafe&seed=21`.
Object.assign(SETS, {
  'dt-items': (): ShowItem[] => {
    const p = new URLSearchParams(location.search);
    const seed = Number(p.get('seed') ?? 21);
    return (p.get('list') ?? 'shops').split(',').map((m) => ({ label: m, object: group(itemModel(m, 0, 0, seed)), size: ['stadium', 'university', 'amusement', 'spire'].includes(m) ? 4 : 2 }));
  },
} satisfies Record<string, () => ShowItem[]>);

// Any `tt-one` model, framed on a point `focus` of the way up: `?set=dt-focus&what=hq:3&focus=0.9&zoom=6`.
Object.assign(SETS, {
  'dt-focus': (): ShowItem[] => {
    const [item] = SETS['tt-one']!();
    const k = Number(new URLSearchParams(location.search).get('focus') ?? 0.5);
    const h = new THREE.Box3().setFromObject(item!.object).max.y * k;
    const g = new THREE.Group();
    item!.object.position.set(h, 0, h);
    g.add(item!.object);
    return [{ ...item!, object: g }];
  },
} satisfies Record<string, () => ShowItem[]>);
// The founder's mansions you can choose and rebuild: `?set=dt-mansions` (az=225 for the back).
Object.assign(SETS, {
  'dt-mansions': (): ShowItem[] =>
    ['hills-modern', 'hills-spanish', 'hills-canyon', 'island-estate', 'island-modern', 'island-tropical'].map((id) => ({ label: id, object: group(founderHome(id, 3)), size: 3.2 })),
} satisfies Record<string, () => ShowItem[]>);
// The founder's helicopter, rotor turning (and once more from the other side): `?set=dt-heli&zoom=14`.
import { helicopter, HELI_ROTOR } from '../render/models.ts';
Object.assign(SETS, {
  'dt-heli': (): ShowItem[] =>
    [0, 1].map((i) => {
      const { body, rotor } = helicopter(7);
      const g = new THREE.Group();
      g.add(body.group, rotor.group);
      rotor.group.position.set(HELI_ROTOR.x, HELI_ROTOR.y, HELI_ROTOR.z);
      g.rotation.y = i * Math.PI;
      return { label: i ? 'helicopter (back)' : 'helicopter', object: g, size: 0.9, update: (dt: number) => (rotor.group.rotation.y += dt * 9) };
    }),
} satisfies Record<string, () => ShowItem[]>);

