/**
 * Everything a founder can buy, the house ladder and the land. Prices are
 * in game dollars: $10,000 for every real dollar of revenue.
 */

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
  { id: 'coworking', name: 'Co-working space', category: 'business', unlock: 100, price: 1_500_000, upkeep: 0.02, amenity: 1, placement: plot(), model: 'coworking', blurb: 'Hot desks, cold brew, ambitious people.' },
  { id: 'office-tower', name: 'Office tower', category: 'business', unlock: 1_000, price: 25_000_000, upkeep: 0.02, amenity: 2, placement: plot(), model: 'tower3', blurb: 'Blue glass and white bands.' },
  { id: 'tech-campus', name: 'Tech campus', category: 'business', unlock: 1_000, price: 40_000_000, upkeep: 0.02, amenity: 3, placement: plot(), model: 'campus', blurb: 'Low glass buildings, solar roofs, palm-lined lawns.' },
  { id: 'skyscraper', name: 'Skyscraper', category: 'business', unlock: 10_000, price: 250_000_000, upkeep: 0.02, amenity: 3, placement: plot(), model: 'tower5', blurb: 'A proper skyline starts here.' },
  { id: 'pyramid', name: 'Pyramid tower', category: 'business', unlock: 25_000, price: 800_000_000, upkeep: 0.02, amenity: 5, placement: plot(), model: 'pyramid', blurb: 'The pointy one. Every skyline needs one.' },
  { id: 'venture-studio', name: 'Venture studio', category: 'business', unlock: 25_000, price: 1_000_000_000, upkeep: 0.02, amenity: 4, placement: plot(), model: 'venture', blurb: 'Where your next startups get launched.' },
  { id: 'supertall', name: 'Supertall', category: 'business', unlock: 100_000, price: 3_000_000_000, upkeep: 0.02, amenity: 8, placement: plot(4), model: 'spire', blurb: 'Takes a whole block. Visible from the moon.' },

  // Civic: parks, learning, sport
  { id: 'park', name: 'Pocket park', category: 'civic', unlock: 0, price: 50_000, upkeep: 0.02, amenity: 2, placement: plot(), model: 'park', blurb: 'Lawn, palms and a fountain.' },
  { id: 'garden', name: 'Community garden', category: 'civic', unlock: 0, price: 40_000, upkeep: 0.02, amenity: 1, placement: plot(), model: 'garden', blurb: 'Raised beds and a greenhouse.' },
  { id: 'courts', name: 'Basketball courts', category: 'civic', unlock: 100, price: 200_000, upkeep: 0.02, amenity: 2, placement: plot(), model: 'courts', blurb: 'Pickup games till the lights come on.' },
  { id: 'library', name: 'Public library', category: 'civic', unlock: 1_000, price: 8_000_000, upkeep: 0.02, amenity: 4, placement: plot(), model: 'library', blurb: 'Columns, steps and a reading lawn.' },
  { id: 'stadium', name: 'Stadium', category: 'civic', unlock: 10_000, price: 500_000_000, upkeep: 0.02, amenity: 15, placement: plot(4), model: 'stadium', blurb: 'Takes a whole block. Floodlights at night.' },
  { id: 'university', name: 'University', category: 'civic', unlock: 25_000, price: 1_500_000_000, upkeep: 0.02, amenity: 25, placement: plot(4), model: 'university', blurb: 'A top university: quad, clock tower, libraries.' },
  { id: 'research', name: 'Research institute', category: 'civic', unlock: 100_000, price: 2_000_000_000, upkeep: 0.02, amenity: 20, placement: plot(), model: 'research', blurb: 'Big domes, bigger questions.' },

  // Fun
  { id: 'food-trucks', name: 'Food truck court', category: 'fun', unlock: 0, price: 120_000, upkeep: 0.02, amenity: 2, placement: plot(), model: 'foodtrucks', blurb: 'Tacos, string lights, picnic tables.' },
  { id: 'cafe', name: 'Café & bookshop', category: 'fun', unlock: 100, price: 300_000, upkeep: 0.02, amenity: 2, placement: plot(), model: 'cafe', blurb: 'Where half your users write their seed decks.' },
  { id: 'theatre', name: 'Neon theatre', category: 'fun', unlock: 1_000, price: 15_000_000, upkeep: 0.02, amenity: 4, placement: plot(), model: 'deco', blurb: 'Art deco, pastel, very Sunset Strip.' },
  { id: 'ferris-wheel', name: 'Ferris wheel', category: 'fun', unlock: 3_000, price: 20_000_000, upkeep: 0.02, amenity: 6, placement: site('pier', 1), model: 'ferris', blurb: 'On the pier. Lights up after dark.' },
  { id: 'coaster', name: 'Pier roller coaster', category: 'fun', unlock: 3_000, price: 45_000_000, upkeep: 0.02, amenity: 6, placement: site('pier', 1), model: 'coaster', blurb: 'Loops out over the sea.' },
  { id: 'amusement-park', name: 'Amusement park', category: 'fun', unlock: 10_000, price: 300_000_000, upkeep: 0.02, amenity: 12, placement: plot(4), model: 'amusement', blurb: 'Takes a whole block: coaster, carousel, drop tower.' },
  { id: 'arena', name: 'Concert arena', category: 'fun', unlock: 25_000, price: 900_000_000, upkeep: 0.02, amenity: 12, placement: plot(), model: 'arena', blurb: 'Sold out every night.' },

  // Vehicles: bought, never free
  { id: 'prop-plane', name: 'Prop plane', category: 'vehicles', unlock: 1_000, price: 1_000_000, upkeep: 0.03, amenity: 0, placement: site('airport', 4), model: 'prop', blurb: 'Your first plane. Lets you fly to other cities (coming soon).' },
  { id: 'gulfstream', name: 'Gulfstream-style jet', category: 'vehicles', unlock: 10_000, price: 70_000_000, upkeep: 0.03, amenity: 0, placement: site('airport', 4), model: 'jet', blurb: 'Faster flights, nicer seats.' },
  { id: 'day-yacht', name: 'Day yacht', category: 'vehicles', unlock: 10_000, price: 30_000_000, upkeep: 0.03, amenity: 1, placement: site('marina', 3), model: 'yacht', blurb: 'Moored at the marina.' },
  { id: 'long-range', name: 'Long-range jet', category: 'vehicles', unlock: 100_000, price: 120_000_000, upkeep: 0.03, amenity: 0, placement: site('airport', 4), model: 'jet-long', blurb: 'Anywhere, non-stop.' },
  { id: 'supersonic', name: 'Supersonic jet', category: 'vehicles', unlock: 1_000_000, price: 500_000_000, upkeep: 0.03, amenity: 0, placement: site('airport', 4), model: 'jet-super', blurb: 'Sonic boom on take-off.' },
  { id: 'rocket', name: 'Rocket', category: 'vehicles', unlock: 1_000_000, price: 2_000_000_000, upkeep: 0.03, amenity: 0, placement: site('launchpad', 1), model: 'rocket', blurb: 'Your ride to your house on the moon.' },

  // HQ upgrades: each replaces the last
  { id: 'hq-office', name: 'HQ: office building', category: 'hq', unlock: 100, price: 500_000, upkeep: 0.02, amenity: 0, placement: { kind: 'hq', level: 1 }, model: 'hq', blurb: 'Out of the garage. Real desks.' },
  { id: 'hq-campus', name: 'HQ: campus', category: 'hq', unlock: 1_000, price: 20_000_000, upkeep: 0.02, amenity: 1, placement: { kind: 'hq', level: 2 }, model: 'hq', blurb: 'Room for twelve release floors and a rooftop garden.' },
  { id: 'hq-tower', name: 'HQ: tower', category: 'hq', unlock: 10_000, price: 200_000_000, upkeep: 0.02, amenity: 2, placement: { kind: 'hq', level: 3 }, model: 'hq', blurb: 'Your logo, visible from the hills.' },
  { id: 'hq-landmark', name: 'HQ: landmark tower', category: 'hq', unlock: 100_000, price: 2_000_000_000, upkeep: 0.02, amenity: 4, placement: { kind: 'hq', level: 4 }, model: 'hq', blurb: 'The tallest thing in town, with a crown.' },
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
  {
    mrr: 100,
    where: 'downtown',
    value: 1_000_000,
    options: [
      { id: 'bungalow', name: 'Bungalow', blurb: 'A little house with a yard and a lemon tree.' },
      { id: 'loft', name: 'Loft apartment', blurb: 'Exposed brick, big windows, city views.' },
    ],
  },
  { mrr: 1_000, where: 'hills', value: 0, options: [{ id: 'hills-modern', name: 'Hills mid-century modern', blurb: 'Your first house in TinyTown Hills, with a pool.' }] },
  {
    mrr: 10_000,
    where: 'hills',
    value: 200_000_000,
    options: [
      { id: 'villa', name: 'Spanish villa', blurb: 'Terracotta, courtyards, a fountain.' },
      { id: 'cliffside', name: 'Glass cliffside house', blurb: 'Cantilevered over the canyon.' },
      { id: 'compound', name: 'Modernist compound', blurb: 'Three pavilions and an infinity pool.' },
    ],
  },
  { mrr: 100_000, where: 'island', value: 0, yacht: true, options: [{ id: 'island-estate', name: 'Island estate', blurb: 'Your own island in the bay, with a superyacht.' }] },
  { mrr: 1_000_000, where: 'moon', value: 0, options: [{ id: 'moon-house', name: 'Moon house', blurb: 'Buy a rocket to fly there.' }] },
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

/** Build blocks, in the order they open. Each has four plots. */
export const BUILD_BLOCKS: readonly BuildBlock[] = [
  { id: 'market', name: 'Market Street', bx: 1, bz: 0, gate: 0 },
  { id: 'arcade', name: 'Sunset Row', bx: 0, bz: 1, gate: 0 },
  { id: 'techpark', name: 'Tech Park', bx: -1, bz: 0, gate: 100 },
  { id: 'midtown', name: 'Midtown', bx: 0, bz: -1, gate: 1_000 },
  { id: 'skyline', name: 'Skyline', bx: -1, bz: -1, gate: 5_000 },
  { id: 'financial', name: 'Financial District', bx: -2, bz: -1, gate: 10_000 },
  { id: 'megacorp', name: 'Megacorp Heights', bx: -1, bz: -2, gate: 25_000 },
  { id: 'moonshot', name: 'Moonshot Square', bx: -2, bz: -2, gate: 100_000 },
];

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
  hills: { name: 'TinyTown Hills', gate: 1_000 },
  pier: { name: 'The pier', gate: 3_000 },
  marina: { name: 'Harbour & marina', gate: 10_000 },
  island: { name: 'Your island', gate: 100_000 },
  launchpad: { name: 'Launch site', gate: 1_000_000 },
};

export const SITE_REGION: Record<Site, Region | null> = {
  pier: 'pier',
  marina: 'marina',
  airport: null, // free infrastructure, always there
  launchpad: 'launchpad',
};
