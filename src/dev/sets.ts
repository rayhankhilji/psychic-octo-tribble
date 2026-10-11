import * as THREE from 'three';
import { home, neighbourhoodGrounds } from '../render/buildings.ts';
import { headquarters } from '../render/towers.ts';
import { founderHome, itemModel, plane, rocket, yacht } from '../render/models.ts';
import { CATALOG, HOME_TIERS } from '../game/catalog.ts';
import { blockCentre } from '../world/layout.ts';
import type { HomeKind } from '../world/layout.ts';

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
