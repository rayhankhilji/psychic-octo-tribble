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

// Neighbourhoods: every street family as a whole block on its real lots, and single homes (mid-row, corner, by a park).
// `?set=nb-streets&zoom=1.4`, `?set=nb-homes&zoom=5&cols=6` (az=225 for the backs).
import { streetFamily } from '../render/buildings.ts';
import { lotRole, packHomeSeed } from '../world/layout.ts';
const NB_FAMILIES: [HomeKind, string, 0 | 1 | 2][] = [
  ['house', 'sunset', 1], ['house', 'marina', 2], ['house', 'cottage', 2],
  ['townhouse', 'italianate', 1], ['townhouse', 'queen', 1], ['townhouse', 'stick', 1],
  ['apartment', 'edwardian', 0], ['apartment', 'brick', 0], ['apartment', 'deco', 0],
];
/** The first street seed that builds this family. */
function nbStreet(kind: HomeKind, family: string, ring: number, skip = 0): number {
  for (let i = 0, found = 0; i < 4000; i++) {
    const seed = ttHash('nb-street', i) >>> 10;
    if (streetFamily(kind, seed, ring) === family && found++ === skip) return seed;
  }
  return 1;
}
function nbBlock(kind: HomeKind, street: number, ring: 0 | 1 | 2, n: number): THREE.Group {
  const g = new THREE.Group();
  const c = blockCentre({ bx: 0, bz: 0 });
  g.add(group(neighbourhoodGrounds(0, 0, n, 91 + n)));
  homeLots(n).forEach((lot, k) => {
    const p = lotPosition({ bx: 0, bz: 0 }, lot);
    const h = group(home(kind, packHomeSeed({ street, ring, lot: k, role: lotRole(n, lot) })));
    h.position.set(p.x, 0, p.z);
    h.rotation.y = lot.rot;
    g.add(h);
  });
  g.position.set(-c.x, 0, -c.z);
  const o = new THREE.Group();
  o.add(g);
  return o;
}
Object.assign(SETS, {
  'nb-streets': (): ShowItem[] =>
    NB_FAMILIES.map(([kind, family, ring], i) => ({ label: `${family} (${kind})`, object: nbBlock(kind, nbStreet(kind, family, ring), ring, ring === 2 ? 24 + i : ring === 1 ? 10 + i : i), size: 5 })),
  /** One block, with `?family=queen&n=1`. */
  'nb-one': (): ShowItem[] => {
    const p = new URLSearchParams(location.search);
    const fam = NB_FAMILIES.find((f) => f[1] === (p.get('family') ?? 'sunset'))!;
    const n = Number(p.get('n') ?? 1);
    const o = nbBlock(fam[0], nbStreet(fam[0], fam[1], fam[2], Number(p.get('skip') ?? 0)), fam[2], n);
    // `&at=x,z` centres the view on that point of the block (from its centre), for close-ups.
    const [ax = 0, az = 0] = (p.get('at') ?? '0,0').split(',').map(Number);
    o.position.set(-ax, 0, -az);
    const w = new THREE.Group();
    w.add(o);
    return [{ label: fam[1], object: w, size: 5 }];
  },
  'nb-homes': (): ShowItem[] =>
    NB_FAMILIES.flatMap(([kind, family, ring]) => {
      const street = nbStreet(kind, family, ring);
      const roles = [
        ['mid', { street: 0, open: 0 }],
        ['corner', { street: 1, open: 0 }],
        ['by a park', { street: 0, open: -1 }],
      ] as const;
      return roles.map(([label, role], k) => ({ label: `${family} ${label}`, object: group(home(kind, packHomeSeed({ street, ring, lot: k + 2, role: { ...role } }))), size: 1.2 }));
    }),
  'nb-trees': (): ShowItem[] =>
    (['round', 'plane', 'ficus', 'pine', 'cypress', 'eucalyptus', 'palm'] as TreeKind[]).map((kind, i) => {
      const b = new GeoBuilder();
      const r = rng(300 + i);
      for (let k = 0; k < 4; k++) tree(b, r, (k % 2) * 0.7 - 0.35, Math.floor(k / 2) * 0.7 - 0.35, 1, 0, kind);
      return { label: kind, object: group(b.build()), size: 1.6 };
    }),
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

// ─── The bay: boats and landmarks (`bay-*` sets) ──────────────────────────
// Every boat: `?set=bay-boats&zoom=5` (az=225 for the other side).
import { containerShip, ferryBoat, sloop, tugBoat } from '../render/life.ts';
import { cityHall, cliffHouse, coitTower, conservatory, ferryBuilding, palaceOfFineArts, sutroTower, windmill } from '../render/landmarks.ts';
import { terrainHeight as bayHeight } from '../world/map.ts';
Object.assign(SETS, {
  'bay-boats': (): ShowItem[] => [
    { label: 'ferry (Golden Gate)', object: ferryBoat(0x2f6a4f).build().group, size: 1.6 },
    { label: 'ferry (Bay Ferry)', object: ferryBoat(0x2a5a8a).build().group, size: 1.6 },
    { label: 'tug', object: tugBoat(0xb8352a, 0x1c1c20).build().group, size: 1.6 },
    { label: 'harbour tug', object: tugBoat(0x2f6a4f, 0x1c1c20).build().group, size: 1.6 },
    ...[3, 8, 13].map((seed) => ({ label: `sloop ${seed}`, object: sloop(rng(seed)).build().group, size: 1.6 })),
  ],
  'bay-ship': (): ShowItem[] => [{ label: 'container ship', object: containerShip().build().group, size: 5 }],
  /** The city's landmarks, each moved from its place on the map to the origin: `?set=bay-landmarks&zoom=1.6`. */
  'bay-landmarks': (): ShowItem[] => {
    const here = (label: string, g: THREE.Group, size = 4) => {
      const box = new THREE.Box3().setFromObject(g);
      const c = box.getCenter(new THREE.Vector3());
      const inner = g;
      inner.position.set(-c.x, -Math.max(0, bayHeight(c.x, c.z)), -c.z);
      const o = new THREE.Group();
      o.add(inner);
      return { label, object: o, size };
    };
    return [
      here('Ferry Building', ferryBuilding(), 6),
      here('Coit Tower', coitTower()),
      here('Palace of Fine Arts', palaceOfFineArts(), 6),
      here('City Hall', cityHall(-15, -20), 6),
      here('Cliff House', cliffHouse(), 6),
      here('Dutch Windmill', windmill().group),
      here('Conservatory of Flowers', conservatory(-16.5, -14.6), 5),
      here('Sutro Tower', sutroTower()),
    ];
  },
} satisfies Record<string, () => ShowItem[]>);
// Boats under way with their wakes, circling: `?set=bay-wakes&zoom=2.4`.
import { Wake } from '../render/life.ts';
import { SEA as BAY_SEA } from '../world/map.ts';
Object.assign(SETS, {
  'bay-wakes': (): ShowItem[] =>
    [
      { label: 'ferry', model: ferryBoat(0x2f6a4f), L: 1.36, wake: new Wake(0.2, 1.1, 0.5), r: 2.6, v: 0.55 },
      { label: 'tug', model: tugBoat(0xb8352a, 0x1c1c20), L: 0.56, wake: new Wake(0.1, 0.8, 0.4), r: 1.6, v: 0.45 },
      { label: 'sloop', model: sloop(rng(3)), L: 0.62, wake: new Wake(0.06, 0.7, 0.3), r: 1.8, v: 0.3 },
    ].map(({ label, model, L, wake, r, v }) => {
      // Lifted so the water line sits on the showcase floor.
      const g = new THREE.Group();
      g.position.y = -BAY_SEA + 0.01;
      const boat = model.build().group;
      const water = new THREE.Mesh(new THREE.CircleGeometry(r + 1.6, 40).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x2a86c8, roughness: 0.4 }));
      water.position.y = BAY_SEA + 0.004;
      g.add(water, boat, wake.mesh);
      const bow = new THREE.Vector3();
      let t = 0;
      return {
        label,
        object: g,
        size: 6,
        // Fixed 60 Hz steps, so a slow software renderer still lays the wake down as a real frame rate would.
        update: () => {
          for (let k = 0, steps = t === 0 ? 600 : 8; k < steps; k++) {
            t += 1 / 60;
            const a = (t * v) / r;
            boat.position.set(Math.cos(a) * r, BAY_SEA + 0.02, Math.sin(a) * r);
            boat.rotation.y = -a - Math.PI / 2;
            bow.set(Math.cos(a) * r - Math.sin(a) * L * 0.5, 0, Math.sin(a) * r + Math.cos(a) * L * 0.5);
            wake.update(1 / 60, bow, 1);
          }
        },
      };
    }),
} satisfies Record<string, () => ShowItem[]>);

// ─── Landscape: the flora and rock of the open hills: `?set=ls-flora&zoom=6` ──
import { gum as lsGum, oak as lsOak, pine as lsPine, rock as lsRock, scrub as lsScrub } from '../render/hills.ts';
Object.assign(SETS, {
  'ls-flora': (): ShowItem[] => {
    const kinds = { pine: lsPine, oak: lsOak, gum: lsGum, scrub: lsScrub, rock: lsRock } as const;
    return Object.entries(kinds).map(([label, f]) => {
      const b = new GeoBuilder();
      const r = rng(label.length * 97);
      b.box(1.1, 0.02, 1.1, 0, -0.02, 0, 0xc8a862);
      for (let i = 0; i < 6; i++) f(b, r, -0.35 + (i % 3) * 0.35, 0, -0.25 + Math.floor(i / 3) * 0.5, label === 'rock' ? 1.6 : 1);
      return { label, object: b.build().group, size: 1.4 };
    });
  },
} satisfies Record<string, () => ShowItem[]>);

// ─── Landscape: the parks seeded cities lay out: `?set=ls-squares&zoom=5`, `?set=ls-parks` ──
import { centralPark, squarePark } from '../render/scenery.ts';
Object.assign(SETS, {
  'ls-squares': (): ShowItem[] =>
    ['fountain', 'bandstand', 'tennis', 'playground'].map((label, style) => {
      const b = new GeoBuilder();
      squarePark(b, rng(31 + style), 0, 0, style, ['round', 'plane', 'cypress', 'palm']);
      return { label, object: b.build().group, size: 4.4 };
    }),
  'ls-parks': (): ShowItem[] =>
    [
      { label: 'central park, 3 × 2 blocks', w: 3, d: 2 },
      { label: 'central park, 2 × 2 blocks', w: 2, d: 2 },
    ].map(({ label, w, d }, i) => {
      const b = new GeoBuilder();
      const rect = { x0: -w * 2.5, x1: w * 2.5, z0: -d * 2.5, z1: d * 2.5 };
      centralPark(b, rng(7 + i), rect, ['round', 'plane', 'pine', 'cypress'], null);
      return { label, object: b.build().group, size: 16 };
    }),
} satisfies Record<string, () => ShowItem[]>);

// ─── Landscape: the land past the edge of the world: `?set=ls-unexplored&zoom=3` (and `&time=22`) ──
import { FogBanks as UxFog, Unknowns as UxUnknowns, setFogLight as uxFogLight } from '../render/fog.ts';
Object.assign(SETS, {
  'ls-unexplored': (): ShowItem[] => {
    const a = atmosphereAt(Number(new URLSearchParams(location.search).get('time') ?? 13));
    return [0, 1].map((i) => {
      const fog = new UxFog();
      fog.add('far', { x: 0, z: 0, w: 9, d: 9, height: 1.6, spill: 0, billow: 5, heap: 3, haze: false, step: 0.6, seed: 5 + i });
      fog.update(0);
      const unknowns = new UxUnknowns([{ x: 0, y: 4.6, z: 0, size: 2.6 }], { title: 'Unexplored', detail: '?' });
      const g = new THREE.Group();
      g.add(fog.object, unknowns.object);
      return { label: i ? 'unexplored (another seed)' : 'unexplored', object: g, size: 10, update: (_dt: number, time: number) => (uxFogLight(a), unknowns.update(a.night, time)) };
    });
  },
} satisfies Record<string, () => ShowItem[]>);
