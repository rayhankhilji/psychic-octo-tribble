import { BUILD_BLOCK_COORDS } from '../world/map.ts';

/**
 * Everything a founder can buy, the house ladder and the land. Prices are
 * in game dollars: $10,000 for every real dollar of revenue.
 *
 * 2026-10-14: the ladder was made much easier to climb. Every MRR gate in
 * these tables is `easeMrr(old gate)`, rounded to a friendly number, and every
 * gated price is `old price × new gate / old gate`, so a thing still takes
 * about as many days of income to afford once it unlocks. Ungated starter
 * items, the starting grant and the exchange rate are unchanged. See
 * docs/GAME_DESIGN.md for the before and after.
 */

/**
 * The owner's curve, from the old MRR gates (one per digit) to the new ones:
 * the house ladder's rungs. Piecewise log-linear between anchors, so a gate
 * halfway (in digits) between two rungs lands halfway between their new values.
 */
export const EASE_ANCHORS: readonly (readonly [old: number, now: number])[] = [
  [0, 0],
  [10, 10],
  [100, 50],
  [1_000, 250],
  [10_000, 1_000],
  [100_000, 5_000],
  [1_000_000, 10_000],
];

/** The new MRR gate for an old one ($3k → ~$484, shown as $500). Exact, not rounded. */
export function easeMrr(old: number): number {
  if (old <= 10) return Math.max(0, old);
  for (let i = 2; i < EASE_ANCHORS.length; i++) {
    const [a, na] = EASE_ANCHORS[i - 1]!;
    const [b, nb] = EASE_ANCHORS[i]!;
    if (old <= b || i === EASE_ANCHORS.length - 1) return na * (nb / na) ** (Math.log(old / a) / Math.log(b / a));
  }
  return old;
}

export type Category = 'business' | 'civic' | 'fun' | 'vehicles' | 'hq';

/** Where an item goes: a city plot (one quadrant or a whole block) or a fixed site. */
export type Placement =
  | { kind: 'plot'; size: 1 | 4 }
  | { kind: 'site'; site: Site; slots: number }
  | { kind: 'hq'; level: number };

export type Site = 'pier' | 'marina' | 'airport' | 'launchpad';

export interface Item {
  id: string;
  name: string;
  category: Category;
  /** Real MRR needed to buy it. */
  unlock: number;
  /** Game dollars. */
  price: number;
  /** Monthly upkeep as a fraction of price. */
  upkeep: number;
  /** Contribution to the amenities part of satisfaction. */
  amenity: number;
  placement: Placement;
  /** Render model key. */
  model: string;
  blurb: string;
}

const plot = (size: 1 | 4 = 1): Placement => ({ kind: 'plot', size });
const site = (s: Site, slots: number): Placement => ({ kind: 'site', site: s, slots });

export const CATALOG: readonly Item[] = [
  // Business: offices and towers, the skyline
  { id: 'corner-shops', name: 'Corner shops', category: 'business', unlock: 0, price: 80_000, upkeep: 0.02, amenity: 1, placement: plot(), model: 'shops', blurb: 'A row of little shops with striped awnings.' },
  { id: 'coworking', name: 'Co-working space', category: 'business', unlock: 50, price: 750_000, upkeep: 0.02, amenity: 1, placement: plot(), model: 'coworking', blurb: 'Hot desks, cold brew, ambitious people.' },
  { id: 'office-tower', name: 'Office tower', category: 'business', unlock: 250, price: 6_000_000, upkeep: 0.02, amenity: 2, placement: plot(), model: 'tower3', blurb: 'Blue glass and white bands.' },
  { id: 'tech-campus', name: 'Tech campus', category: 'business', unlock: 250, price: 10_000_000, upkeep: 0.02, amenity: 3, placement: plot(), model: 'campus', blurb: 'Low glass buildings, solar roofs, palm-lined lawns.' },
  { id: 'skyscraper', name: 'Skyscraper', category: 'business', unlock: 1_000, price: 25_000_000, upkeep: 0.02, amenity: 3, placement: plot(), model: 'tower5', blurb: 'A proper skyline starts here.' },
  { id: 'pyramid', name: 'Pyramid tower', category: 'business', unlock: 2_000, price: 65_000_000, upkeep: 0.02, amenity: 5, placement: plot(), model: 'pyramid', blurb: 'The pointy one. Every skyline needs one.' },
  { id: 'venture-studio', name: 'Venture studio', category: 'business', unlock: 2_000, price: 80_000_000, upkeep: 0.02, amenity: 4, placement: plot(), model: 'venture', blurb: 'Where your next startups get launched.' },
  { id: 'supertall', name: 'Supertall', category: 'business', unlock: 5_000, price: 150_000_000, upkeep: 0.02, amenity: 8, placement: plot(4), model: 'spire', blurb: 'Takes a whole block. Visible from the moon.' },

  // Civic: parks, learning, sport
  { id: 'park', name: 'Pocket park', category: 'civic', unlock: 0, price: 50_000, upkeep: 0.02, amenity: 2, placement: plot(), model: 'park', blurb: 'Lawn, palms and a fountain.' },
  { id: 'garden', name: 'Community garden', category: 'civic', unlock: 0, price: 40_000, upkeep: 0.02, amenity: 1, placement: plot(), model: 'garden', blurb: 'Raised beds and a greenhouse.' },
  { id: 'courts', name: 'Basketball courts', category: 'civic', unlock: 50, price: 100_000, upkeep: 0.02, amenity: 2, placement: plot(), model: 'courts', blurb: 'Pickup games till the lights come on.' },
  { id: 'library', name: 'Public library', category: 'civic', unlock: 250, price: 2_000_000, upkeep: 0.02, amenity: 4, placement: plot(), model: 'library', blurb: 'Columns, steps and a reading lawn.' },
  { id: 'stadium', name: 'Stadium', category: 'civic', unlock: 1_000, price: 50_000_000, upkeep: 0.02, amenity: 15, placement: plot(4), model: 'stadium', blurb: 'Takes a whole block. Floodlights at night.' },
  { id: 'university', name: 'University', category: 'civic', unlock: 2_000, price: 120_000_000, upkeep: 0.02, amenity: 25, placement: plot(4), model: 'university', blurb: 'A top university: quad, clock tower, libraries.' },
  { id: 'research', name: 'Research institute', category: 'civic', unlock: 5_000, price: 100_000_000, upkeep: 0.02, amenity: 20, placement: plot(), model: 'research', blurb: 'Big domes, bigger questions.' },

  // Fun
  { id: 'food-trucks', name: 'Food truck court', category: 'fun', unlock: 0, price: 120_000, upkeep: 0.02, amenity: 2, placement: plot(), model: 'foodtrucks', blurb: 'Tacos, string lights, picnic tables.' },
  { id: 'cafe', name: 'Café & bookshop', category: 'fun', unlock: 50, price: 150_000, upkeep: 0.02, amenity: 2, placement: plot(), model: 'cafe', blurb: 'Where half your users write their seed decks.' },
  { id: 'theatre', name: 'Neon theatre', category: 'fun', unlock: 250, price: 4_000_000, upkeep: 0.02, amenity: 4, placement: plot(), model: 'deco', blurb: 'Art deco, pastel, very Sunset Strip.' },
  { id: 'ferris-wheel', name: 'Ferris wheel', category: 'fun', unlock: 500, price: 3_500_000, upkeep: 0.02, amenity: 6, placement: site('pier', 1), model: 'ferris', blurb: 'On the pier. Lights up after dark.' },
  { id: 'coaster', name: 'Pier roller coaster', category: 'fun', unlock: 500, price: 7_500_000, upkeep: 0.02, amenity: 6, placement: site('pier', 1), model: 'coaster', blurb: 'Loops out over the sea.' },
  { id: 'amusement-park', name: 'Amusement park', category: 'fun', unlock: 1_000, price: 30_000_000, upkeep: 0.02, amenity: 12, placement: plot(4), model: 'amusement', blurb: 'Takes a whole block: coaster, carousel, drop tower.' },
  { id: 'arena', name: 'Concert arena', category: 'fun', unlock: 2_000, price: 70_000_000, upkeep: 0.02, amenity: 12, placement: plot(), model: 'arena', blurb: 'Sold out every night.' },

  // Vehicles: bought, never free. The long-range jet, supersonic jet and rocket cost more than the
  // price rule gives (it would make each plane cheaper than the one below it); see GAME_DESIGN.md.
  { id: 'prop-plane', name: 'Prop plane', category: 'vehicles', unlock: 250, price: 250_000, upkeep: 0.03, amenity: 0, placement: site('airport', 4), model: 'prop', blurb: 'Your first plane. Lets you fly to other cities (coming soon).' },
  { id: 'gulfstream', name: 'Gulfstream-style jet', category: 'vehicles', unlock: 1_000, price: 7_000_000, upkeep: 0.03, amenity: 0, placement: site('airport', 4), model: 'jet', blurb: 'Faster flights, nicer seats.' },
  { id: 'day-yacht', name: 'Day yacht', category: 'vehicles', unlock: 1_000, price: 3_000_000, upkeep: 0.03, amenity: 1, placement: site('marina', 3), model: 'yacht', blurb: 'Moored at the marina.' },
  { id: 'long-range', name: 'Long-range jet', category: 'vehicles', unlock: 5_000, price: 12_000_000, upkeep: 0.03, amenity: 0, placement: site('airport', 4), model: 'jet-long', blurb: 'Anywhere, non-stop.' },
  { id: 'supersonic', name: 'Supersonic jet', category: 'vehicles', unlock: 10_000, price: 30_000_000, upkeep: 0.03, amenity: 0, placement: site('airport', 4), model: 'jet-super', blurb: 'Sonic boom on take-off.' },
  { id: 'rocket', name: 'Rocket', category: 'vehicles', unlock: 10_000, price: 50_000_000, upkeep: 0.03, amenity: 0, placement: site('launchpad', 1), model: 'rocket', blurb: 'Your ride to your house on the moon.' },

  // HQ upgrades: each replaces the last
  { id: 'hq-office', name: 'HQ: office building', category: 'hq', unlock: 50, price: 250_000, upkeep: 0.02, amenity: 0, placement: { kind: 'hq', level: 1 }, model: 'hq', blurb: 'Out of the garage. Real desks.' },
  { id: 'hq-campus', name: 'HQ: campus', category: 'hq', unlock: 250, price: 5_000_000, upkeep: 0.02, amenity: 1, placement: { kind: 'hq', level: 2 }, model: 'hq', blurb: 'Room for twelve release floors and a rooftop garden.' },
  { id: 'hq-tower', name: 'HQ: tower', category: 'hq', unlock: 1_000, price: 20_000_000, upkeep: 0.02, amenity: 2, placement: { kind: 'hq', level: 3 }, model: 'hq', blurb: 'Your logo, visible from the hills.' },
  { id: 'hq-landmark', name: 'HQ: landmark tower', category: 'hq', unlock: 5_000, price: 100_000_000, upkeep: 0.02, amenity: 4, placement: { kind: 'hq', level: 4 }, model: 'hq', blurb: 'The tallest thing in town, with a crown.' },
];

export const ITEMS = new Map(CATALOG.map((i) => [i.id, i]));

/** Release floors each HQ level has room for (garage, office, campus, tower, landmark). */
export const HQ_FLOOR_CAP = [2, 8, 12, 24, 30] as const;
export const HQ_LEVEL_NAMES = ['Garage', 'Office building', 'Campus', 'Tower', 'Landmark tower'] as const;

// ─── The founder's home ─────────────────────────────────────────────────────

export interface HomeOption {
  id: string;
  name: string;
  blurb: string;
}

export interface HomeTier {
  /** Real MRR (peak) that unlocks it. */
  mrr: number;
  where: 'downtown' | 'hills' | 'island' | 'moon';
  options: HomeOption[];
  /** Game-dollar value; swapping between options costs 25% of it. */
  value: number;
  /** Comes with a superyacht moored at the island. */
  yacht?: boolean;
}

export const HOME_TIERS: readonly HomeTier[] = [
  { mrr: 0, where: 'downtown', value: 0, options: [{ id: 'hacker-house', name: 'Hacker House', blurb: 'Bunk beds, whiteboards, too many cofounders.' }] },
  { mrr: 10, where: 'downtown', value: 0, options: [{ id: 'studio', name: 'Studio apartment', blurb: 'Your own front door at last.' }] },
  // Values scale like prices (old value × new gate / old gate): about two months of income at the gate.
  {
    mrr: 50,
    where: 'downtown',
    value: 500_000,
    options: [
      { id: 'bungalow', name: 'Bungalow', blurb: 'A little house with a yard and a lemon tree.' },
      { id: 'loft', name: 'Loft apartment', blurb: 'Exposed brick, big windows, city views.' },
    ],
  },
  {
    mrr: 250,
    where: 'hills',
    value: 5_000_000,
    options: [
      { id: 'hills-modern', name: 'Hills mid-century modern', blurb: 'Glass walls, a cantilever over the canyon, a pool.' },
      { id: 'hills-spanish', name: 'Hills Spanish Revival', blurb: 'White stucco, a tile roof, a courtyard fountain.' },
      { id: 'hills-canyon', name: 'Canyon house', blurb: 'Redwood decks, string lights, a hot tub in the trees.' },
    ],
  },
  {
    mrr: 1_000,
    where: 'hills',
    value: 20_000_000,
    options: [
      { id: 'villa', name: 'Spanish villa', blurb: 'Terracotta, courtyards, a fountain.' },
      { id: 'cliffside', name: 'Glass cliffside house', blurb: 'Cantilevered over the canyon.' },
      { id: 'compound', name: 'Modernist compound', blurb: 'Three pavilions and an infinity pool.' },
    ],
  },
  {
    mrr: 5_000,
    where: 'island',
    value: 100_000_000,
    yacht: true,
    options: [
      { id: 'island-estate', name: 'Island estate', blurb: 'A Mediterranean villa on your own island, with a superyacht.' },
      { id: 'island-modern', name: 'Island glass house', blurb: 'White stone and glass, an infinity pool over the sea.' },
      { id: 'island-tropical', name: 'Island compound', blurb: 'Teak pavilions among the palms, a lagoon pool.' },
    ],
  },
  { mrr: 10_000, where: 'moon', value: 0, options: [{ id: 'moon-house', name: 'Moon house', blurb: 'Buy a rocket to fly there.' }] },
];

export const SWAP_FEE = 0.25;

// ─── Land ─────────────────────────────────────────────────────────────────

export interface BuildBlock {
  id: string;
  name: string;
  bx: number;
  bz: number;
  /** Peak real MRR at which it can open. */
  gate: number;
}

const GATES: Record<string, number> = {
  market: 0,
  arcade: 0,
  techpark: 50,
  midtown: 250,
  skyline: 750, // easeMrr($5k) ≈ $660
  financial: 1_000,
  megacorp: 2_000, // easeMrr($25k) ≈ $1,900
  moonshot: 5_000,
};

/** Downtown build blocks, in the order they open. Each has four plots. */
export const BUILD_BLOCKS: readonly BuildBlock[] = BUILD_BLOCK_COORDS.map((b) => ({ ...b, gate: GATES[b.id] ?? 0 }));

/** Plot offsets within a block (2×2 lots each). */
export const QUADRANTS = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
] as const;

export type Region = 'hills' | 'pier' | 'marina' | 'island' | 'launchpad';

/** Areas outside the grid that clear their clouds at a peak-MRR milestone. */
export const REGIONS: Record<Region, { name: string; gate: number }> = {
  // The Hills, the island and the launch site open with the rung of the house ladder that lives there.
  hills: { name: 'TinyTown Hills', gate: HOME_TIERS[3]!.mrr },
  pier: { name: 'The pier', gate: 500 }, // easeMrr($3k) ≈ $484
  marina: { name: 'Harbour & marina', gate: 1_000 },
  island: { name: 'Your island', gate: HOME_TIERS[5]!.mrr },
  launchpad: { name: 'Launch site', gate: HOME_TIERS[6]!.mrr },
};

export const SITE_REGION: Record<Site, Region | null> = {
  pier: 'pier',
  marina: 'marina',
  airport: null, // free infrastructure, always there
  launchpad: 'launchpad',
};
