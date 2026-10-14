/**
 * The guided tour: ten short cards that walk someone round the HUD, each
 * beside a spotlight on the thing it explains. The rest of the screen dims;
 * the cut-out glides and reshapes from one target to the next; where the
 * card wants you to do something (open the build menu) a "Press here" hint
 * pulses on it and the card waits until you have.
 *
 * Who starts it: the demo offers it as a chip after the replay (or on the
 * first interaction), the founder's inauguration starts it, settings can
 * replay it, and `?tour` forces it. Finished or skipped is remembered in
 * `tinytown:tour`.
 *
 * It only touches the DOM: it finds the HUD by stable selectors, presses its
 * buttons like a person would, and learns about the city (real numbers, where
 * the fog is on screen) through a small `TourWorld` that main.ts registers.
 * Everything above the "DOM" line is pure, for the tests.
 */
import './tour.css';
import { formatMoney } from '../data/types.ts';
import { BUILD_BLOCKS, CATALOG, HOME_TIERS, REGIONS, type Region } from '../game/catalog.ts';
import { canBuy, FREE_HOUSED, money, MRR_PER_USER, RATE, type GameState } from '../game/economy.ts';
import { BLOCK, blockCentre, HQ_BLOCK } from '../world/layout.ts';
import { RAIN_STARTS } from '../world/history.ts';
import { HILLS_HOME, ISLANDS, MARINA, PIER } from '../world/map.ts';
import { CLIP_SECONDS } from './recap-plan.ts';
import { markSvg } from './brand.ts';
import { el, escape, prefersReducedMotion, shortMrr } from './dom.ts';
import { ICON, type IconName } from './icons.ts';
import { whenBooted } from './loader.ts';

export const TOUR_KEY = 'tinytown:tour';

// ─── Steps ──────────────────────────────────────────────────────────────────

export type StepId = 'welcome' | 'metrics' | 'treasury' | 'housing' | 'build' | 'build-menu' | 'build-place' | 'fog' | 'home' | 'timeline' | 'share' | 'done';

/** The ten stops, one dot each. The build stop has two follow-ups that share its dot. */
export const DOT_STEPS: readonly StepId[] = ['welcome', 'metrics', 'treasury', 'housing', 'build', 'fog', 'home', 'timeline', 'share', 'done'];

export type TourInput =
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'skip' }
  /** The build menu opened or closed (by the visitor, a shortcut, or the tour). */
  | { type: 'drawer'; open: boolean }
  /** Placement mode (pick a glowing plot) started or ended. */
  | { type: 'placing'; on: boolean };

export interface TourContext {
  /** Something in the build menu can be bought right now. */
  canBuild: boolean;
}

export type TourEnd = 'done' | 'skipped';

/**
 * Pure: where the tour goes from `step` on `input`. Returns the next step,
 * the same step when the input means nothing here, or how the tour ended.
 *
 * The build stop waits for the menu to open (or opens it on Next); inside
 * the menu, buying a plot item moves on to placement, and placing it (or
 * cancelling) moves on to the fog. With nothing affordable it's a plain card.
 */
export function nextStep(step: StepId, input: TourInput, ctx: TourContext): StepId | TourEnd {
  if (input.type === 'skip') return 'skipped';
  if (input.type === 'drawer') {
    if (step === 'build' && input.open) return 'build-menu';
    if (step === 'build-menu' && !input.open) return 'fog';
    return step;
  }
  if (input.type === 'placing') {
    if ((step === 'build' || step === 'build-menu') && input.on) return 'build-place';
    if (step === 'build-place' && !input.on) return 'fog';
    return step;
  }
  if (input.type === 'back') {
    if (step === 'build-menu' || step === 'build-place' || step === 'fog') return 'build';
    const i = DOT_STEPS.indexOf(step);
    return i > 0 ? DOT_STEPS[i - 1]! : step;
  }
  // Next.
  if (step === 'build') return ctx.canBuild ? 'build-menu' : 'fog';
  if (step === 'build-menu' || step === 'build-place') return 'fog';
  if (step === 'done') return 'done';
  return DOT_STEPS[DOT_STEPS.indexOf(step) + 1]!;
}

/** Which dot a step lights (the build follow-ups share the build dot). */
export function dotIndex(step: StepId): number {
  return DOT_STEPS.indexOf(step === 'build-menu' || step === 'build-place' ? 'build' : step);
}

/** Whether a card waits for the visitor to do something, rather than for Next. */
export function waitsForAction(step: StepId, ctx: TourContext): boolean {
  return (step === 'build' && ctx.canBuild) || step === 'build-place';
}

// ─── Facts: the real numbers the cards quote ─────────────────────────────────

export interface FogTarget {
  kind: 'block' | 'region';
  name: string;
  /** Peak MRR it opens at. */
  gate: number;
  /** True when MRR is there and the block only waits for the open plots to be built on. */
  waitsForPlots: boolean;
  /** World footprint to spotlight (x/z centre and half-size), height up to `top`. */
  x: number;
  z: number;
  half: number;
  top: number;
}

export interface TourFacts {
  name: string;
  demo: boolean;
  currency: string;
  /** 1-based day of the story on screen. */
  day: number;
  mrr: number;
  customers: number;
  /** Monthly active users; equals customers when no user source is connected. */
  users: number;
  usersAreCustomers: boolean;
  treasury: number;
  incomePerDay: number;
  satisfaction: number;
  /** Real MRR needed to house everyone. */
  housingNeed: number;
  unhoused: number;
  canBuild: boolean;
  home: string;
  nextHome: { name: string; mrr: number } | null;
  fog: FogTarget | null;
}

/**
 * Pure: the fog worth pointing at. The next downtown block to clear (it sits
 * by HQ, right in view), else the next region, else none: all land is open.
 */
export function fogTarget(game: Pick<GameState, 'openBlocks' | 'regions' | 'peakMrr'>): FogTarget | null {
  // The camera looks from the north-east, so a block straight behind HQ (same x − z) hides under its tower:
  // prefer one off that line, in the order they open.
  const locked = BUILD_BLOCKS.filter((b) => !game.openBlocks.includes(b.id));
  const block = locked.find((b) => b.bx - b.bz !== HQ_BLOCK.bx - HQ_BLOCK.bz) ?? locked[0];
  if (block) {
    const c = blockCentre(block);
    // The fog spills half a street past the block on every side.
    return { kind: 'block', name: block.name, gate: block.gate, waitsForPlots: block.gate <= game.peakMrr, x: c.x, z: c.z, half: BLOCK / 2 + 0.5, top: 1.2 };
  }
  const order: Region[] = ['hills', 'pier', 'marina', 'island', 'launchpad'];
  const region = order.find((r) => !game.regions[r]);
  if (!region) return null;
  const at: Record<Region, { x: number; z: number; half: number }> = {
    hills: { x: HILLS_HOME.x, z: HILLS_HOME.z, half: 4 },
    pier: { x: (PIER.x0 + PIER.x1) / 2, z: (PIER.z0 + PIER.z1) / 2, half: 3 },
    marina: { x: MARINA.x, z: MARINA.z, half: 3 },
    island: { x: ISLANDS.founder.x, z: ISLANDS.founder.z, half: 4 },
    launchpad: { x: ISLANDS.launch.x, z: ISLANDS.launch.z, half: 2.5 },
  };
  const p = at[region];
  return { kind: 'region', name: REGIONS[region].name, gate: REGIONS[region].gate, waitsForPlots: false, ...p, top: 2 };
}

/** The bits of a timeline the facts need. */
export interface TourTimeline {
  name: string;
  source: 'demo' | 'live' | string;
  currency: string;
  snapshots: readonly { t: number; customers: number; users?: number; mrr: number }[];
}

/** Pure: the real numbers behind the city on screen, for the cards. */
export function tourFacts(game: GameState, timeline: TourTimeline): TourFacts {
  const snaps = timeline.snapshots;
  let i = snaps.findIndex((s) => s.t === game.t);
  if (i < 0) i = snaps.length - 1;
  const snap = snaps[i];
  const tier = HOME_TIERS[game.home.tier] ?? HOME_TIERS[0]!;
  const next = HOME_TIERS[game.home.tier + 1];
  return {
    name: timeline.name,
    demo: timeline.source === 'demo',
    currency: timeline.currency,
    day: i + 1,
    mrr: game.mrr,
    customers: snap?.customers ?? 0,
    users: game.population,
    usersAreCustomers: snap?.users === undefined,
    treasury: game.treasury,
    incomePerDay: game.incomePerDay,
    satisfaction: game.satisfaction.score,
    housingNeed: game.housingNeed,
    unhoused: game.unhoused,
    canBuild: CATALOG.some((item) => !canBuy(game, item)),
    home: tier.options.find((o) => o.id === game.home.option)?.name ?? tier.options[0]!.name,
    nextHome: next ? { name: next.options.length > 1 ? `${next.options[0]!.name} or ${next.options.length - 1} more` : next.options[0]!.name, mrr: next.mrr } : null,
    fog: fogTarget(game),
  };
}

// ─── Copy ───────────────────────────────────────────────────────────────────

export interface StepCopy {
  icon: IconName;
  eyebrow: string;
  title: string;
  body: string;
  /** The real numbers, with each figure in {braces} (shown bold). */
  fact?: string;
  /** Keys worth knowing here. */
  keys?: { key: string; what: string }[];
  /** The primary button's label. */
  primary: string;
  /** "Press here" (an action) or a lighter nudge (hover the fog). */
  hint?: { text: string; mode: 'press' | 'hover' };
}

const n = (v: number) => Math.round(v).toLocaleString('en-US');

/*
 * Every threshold and price in the copy comes from the game's own constants
 * (HOME_TIERS, REGIONS, RATE, MRR_PER_USER, FREE_HOUSED), so retuning the
 * economy can't leave a card quoting an old number.
 */

/** "the Hills open at $1k MRR, the pier at $3k, …" from REGIONS, in gate order. */
export function regionLine(): string {
  const names: Record<Region, string> = { hills: 'the Hills', pier: 'the pier', marina: 'the marina', island: 'your island', launchpad: 'the launch site' };
  const list = (Object.keys(REGIONS) as Region[]).sort((a, b) => REGIONS[a].gate - REGIONS[b].gate);
  const parts = list.map((r, i) => `${names[r]} ${i === 0 ? 'open at ' : 'at '}${shortMrr(REGIONS[r].gate)}${i === 0 ? ' MRR' : ''}`);
  const line = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** "a studio at $10, a bungalow or loft at $50, the Hills at …" from HOME_TIERS, one phrase per rung. */
export function ladderLine(): string {
  const parts: string[] = [];
  let hills = 0;
  HOME_TIERS.forEach((t, i) => {
    if (i === 0) return;
    let label: string | null = null;
    if (t.where === 'downtown') label = i === 1 ? 'a studio' : t.options.length > 1 ? `a ${t.options.map((o) => o.name.split(' ')[0]!.toLowerCase()).join(' or ')}` : null;
    else if (t.where === 'hills') label = hills++ === 0 ? 'the Hills' : 'an estate';
    else if (t.where === 'island') label = 'an island';
    else if (t.where === 'moon') label = 'a house on the moon';
    if (label) parts.push(`${label} at ${shortMrr(t.mrr)}`);
  });
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '');
}

/** Pure: what a card says. With no facts (no city yet) it states the rules alone. */
export function stepCopy(step: StepId, f: TourFacts | null, opts: { touch?: boolean } = {}): StepCopy {
  const demo = f?.demo ?? false;
  const usd = (v: number) => (f ? formatMoney(Math.round(v), f.currency) : `$${n(v)}`);
  const who = f ? (demo ? f.name : 'You') : 'You';
  const people = f?.usersAreCustomers ? 'customers' : 'active users';
  switch (step) {
    case 'welcome':
      return {
        icon: 'sparkle',
        eyebrow: 'A one-minute tour',
        title: demo ? 'A city that runs on a startup’s real numbers' : 'Your city runs on your real numbers',
        body: demo
          ? `${f!.name} is a made-up startup, but its city follows the rules yours will: MRR, customers, active users and releases build it. Nothing in the game is for sale.`
          : 'MRR and customers from Stripe, active users from your product, releases from GitHub. The city builds itself from them, and nothing in it is for sale.',
        primary: 'Show me around',
      };
    case 'metrics':
      return {
        icon: 'chart',
        eyebrow: 'Real metrics',
        title: 'Every number does something',
        body: `MRR fills the treasury. Each active user needs a home. Releases add floors to HQ, commits speed up the train, and a week where MRR falls more than ${n(-RAIN_STARTS * 100)}% brings rain.`,
        fact: f ? `${f.name}, day {${n(f.day)}}: {${usd(f.mrr)}} MRR · {${n(f.customers)}} customers${f.usersAreCustomers ? '' : ` · {${n(f.users)}} active users`}` : undefined,
        primary: 'Next',
      };
    case 'treasury':
      return {
        icon: 'coin',
        eyebrow: 'City treasury',
        title: `Every $1 of MRR is $${n(RATE)} a month`,
        body: 'It lands a thirtieth at a time, every day. Buildings cost upkeep each month. The ring is satisfaction: housing, upkeep, amenities and momentum. Only real growth moves it.',
        fact: f ? `{${usd(f.mrr)}} MRR pays the city {${money(f.incomePerDay)}} a day. Satisfaction {${f.satisfaction}}/100.` : undefined,
        primary: 'Next',
      };
    case 'housing': {
      let fact: string | undefined;
      if (f) {
        const need = Math.ceil(f.housingNeed);
        const at = demo ? `${f.name} is at` : 'you’re at';
        fact =
          f.unhoused > 0
            ? `{${n(f.users)}} ${people} need {${usd(need)}} MRR; ${at} {${usd(f.mrr)}}, so {${n(f.unhoused)}} are in tents.`
            : f.users > 0
              ? `{${n(f.users)}} ${people} need {${usd(need)}} MRR. At {${usd(f.mrr)}}, everyone has a home.`
              : `No residents yet. The first ${n(FREE_HOUSED)} are always housed.`;
      }
      return {
        icon: 'home',
        eyebrow: 'Housing',
        title: 'Every active user needs a home',
        body: `Each one takes $${MRR_PER_USER.toFixed(2)} of MRR, so 1,000 users need $${n(1000 * MRR_PER_USER)}. The first ${n(FREE_HOUSED)} are on the house. Fall short and people end up in tents, and the city runs down: the TINYTOWN sign goes dark, then the bridge rusts.`,
        fact,
        primary: 'Next',
      };
    }
    case 'build':
      return f && !f.canBuild
        ? {
            icon: 'build',
            eyebrow: 'Build',
            title: 'Spend it on the city',
            body: 'Parks, shops, towers, a stadium, a jet. There’s nothing to build right now: the treasury is saving up, or every open plot is taken. Income lands every day, so look again tomorrow.',
            fact: `The treasury has {${money(f.treasury)}}, and {${money(f.incomePerDay)}} comes in a day.`,
            keys: [{ key: 'B', what: 'build' }],
            primary: 'Next',
          }
        : {
            icon: 'build',
            eyebrow: 'Build',
            title: 'Spend it on the city',
            body: 'Parks, shops, towers, a stadium, a jet. Open the build menu to see what the treasury can buy.',
            fact: f ? `{${money(f.treasury)}} to spend.` : undefined,
            keys: [{ key: 'B', what: 'build' }],
            primary: 'Open it for me',
            hint: { text: 'Press here', mode: 'press' },
          };
    case 'build-menu':
      return {
        icon: 'build',
        eyebrow: 'Build',
        title: 'Pick something you can afford',
        body: 'Cards with a Buy button are ready: press one, then pick a glowing plot for it. Or keep the treasury for later. Locked cards say the MRR that opens them.',
        primary: 'Next',
      };
    case 'build-place':
      return {
        icon: 'pin',
        eyebrow: 'Build',
        title: 'Now pick a glowing plot',
        body: `${opts.touch ? 'Tap' : 'Click'} any glowing plot in the city. Changed your mind? Cancel, and nothing is spent.`,
        keys: opts.touch ? undefined : [{ key: 'Esc', what: 'cancel' }],
        primary: 'Skip this',
      };
    case 'fog': {
      const fog = f?.fog;
      const fact = !f
        ? undefined
        : !fog
          ? 'Every bit of land is open. There’s no more fog to lift.'
          : fog.waitsForPlots
            ? `${fog.name} lifts once every open plot is built on: the {${usd(fog.gate)}} MRR it needs is already there.`
            : `${fog.name} lifts at {${usd(fog.gate)}} MRR.`;
      return {
        icon: 'cloudSun',
        eyebrow: 'The fog',
        title: 'More land opens as you grow',
        body: `Locked land sits under fog. ${regionLine()}. Downtown blocks clear once every open plot is built on and MRR reaches the block’s number.`,
        fact,
        primary: 'Next',
        hint: fog && !opts.touch ? { text: 'Hover the fog', mode: 'hover' } : undefined,
      };
    }
    case 'home':
      return {
        icon: 'home',
        eyebrow: 'Your home',
        title: 'From a hacker house to the moon',
        body: `${demo ? 'The founder moves' : 'You move'} up a rung as MRR grows: ${ladderLine()}. Peak MRR counts, so a bad month never evicts anyone.`,
        fact: f ? `${demo ? `${f.name}’s founder lives` : 'You live'} in the ${f.home}.${f.nextHome ? ` Next: ${f.nextHome.name}, at {${usd(f.nextHome.mrr)}} MRR.` : ' There’s no next move.'}` : undefined,
        keys: [{ key: 'H', what: 'your home' }],
        primary: 'Next',
      };
    case 'timeline':
      return {
        icon: 'calendar',
        eyebrow: 'Timeline',
        title: 'Scrub through the story',
        body: 'Drag along the chart to see any day, from day one to today. The dots are milestones. Replay plays the whole story back.',
        fact: f ? `{${n(f.day)}} ${f.day === 1 ? 'day' : 'days'} of ${f.name} so far.` : undefined,
        keys: [{ key: 'Space', what: 'play' }],
        primary: 'Next',
      };
    case 'share':
      return {
        icon: 'share',
        eyebrow: 'Share',
        title: 'Send a postcard',
        body: `Share makes a postcard of the city, or a ${CLIP_SECONDS}-second clip of it growing from day one. You choose whether the real numbers go on it.`,
        primary: 'Next',
      };
    case 'done':
      return demo
        ? {
            icon: 'check',
            eyebrow: 'That’s the tour',
            title: 'Now picture yours.',
            body: 'Connect your startup and the city is yours. Grow the startup, the city grows.',
            keys: [{ key: '?', what: 'the rules, any time' }],
            primary: 'Back to the city',
          }
        : {
            icon: 'check',
            eyebrow: 'That’s the tour',
            title: 'Your city is yours.',
            body: 'Grow the startup, the city grows.',
            keys: [{ key: '?', what: 'the rules, any time' }],
            primary: 'Start building',
          };
  }
  // Exhaustive above; this keeps the compiler honest if a step is added.
  return { icon: 'info', eyebrow: '', title: who, body: '', primary: 'Next' };
}

// ─── Where the card goes ─────────────────────────────────────────────────────

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Side = 'right' | 'left' | 'below' | 'above' | 'center' | 'over' | 'sheet-top' | 'sheet-bottom';

/** Below this width the card is a sheet along the top or bottom edge. */
export const SHEET_BELOW = 640;

/**
 * Pure: where the card sits for a spotlight at `hole`. On wide screens, the
 * first preferred side where it fits whole, beside the hole; on phones, a
 * sheet on whichever edge the hole leaves clearer. `extra` is room to leave
 * between the hole and the card (for a "Press here" hint).
 */
export function placeCard(hole: Rect | null, card: { w: number; h: number }, view: { w: number; h: number }, prefer: readonly Side[] = ['right', 'left', 'below', 'above'], extra = 0): { x: number; y: number; side: Side } {
  const edge = view.w < SHEET_BELOW ? 10 : 16;
  const gap = 16 + extra;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  if (view.w < SHEET_BELOW) {
    const bottom = view.h - card.h - edge;
    const top = edge;
    if (!hole) return { x: edge, y: bottom, side: 'sheet-bottom' };
    const overlap = (y: number) => Math.max(0, Math.min(y + card.h, hole.y + hole.h) - Math.max(y, hole.y));
    // Bottom unless the hole is down there and the top is clearer.
    return overlap(bottom) > overlap(top) ? { x: edge, y: top, side: 'sheet-top' } : { x: edge, y: bottom, side: 'sheet-bottom' };
  }
  if (!hole) return { x: Math.round((view.w - card.w) / 2), y: Math.round((view.h - card.h) / 2), side: 'center' };
  const cx = hole.x + hole.w / 2;
  const cy = hole.y + hole.h / 2;
  const midY = clamp(cy - card.h / 2, edge, view.h - card.h - edge);
  const midX = clamp(cx - card.w / 2, edge, view.w - card.w - edge);
  for (const side of prefer) {
    if (side === 'right' && hole.x + hole.w + gap + card.w <= view.w - edge) return { x: hole.x + hole.w + gap, y: midY, side };
    if (side === 'left' && hole.x - gap - card.w >= edge) return { x: hole.x - gap - card.w, y: midY, side };
    if (side === 'below' && hole.y + hole.h + gap + card.h <= view.h - edge) return { x: midX, y: hole.y + hole.h + gap, side };
    if (side === 'above' && hole.y - gap - card.h >= edge) return { x: midX, y: hole.y - gap - card.h, side };
  }
  // Nowhere fits whole (a huge target on a small screen): over it, kept on screen.
  return { x: midX, y: clamp(view.h - card.h - edge, edge, view.h), side: 'over' };
}

// ─── Remembering ────────────────────────────────────────────────────────────

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Whether to offer the tour: never taken, finished, skipped or waved away
 * in this browser. Without storage we can't remember a "no", so we don't ask.
 */
export function shouldOfferTour(store: Store | null = storage()): boolean {
  if (!store) return false;
  try {
    return store.getItem(TOUR_KEY) === null;
  } catch {
    return false;
  }
}

/** Records how the tour went: 'done', 'skipped', or 'dismissed' (the chip was closed). */
export function rememberTour(value: TourEnd | 'dismissed', store: Store | null = storage()) {
  try {
    store?.setItem(TOUR_KEY, value);
  } catch {
    // Private mode: it may be offered again next visit.
  }
}

/** `?tour` in the URL starts it, whatever the browser remembers (previews, screenshots, support). */
export function tourRequested(search: string | URLSearchParams): boolean {
  return (typeof search === 'string' ? new URLSearchParams(search) : search).has('tour');
}

// ─── DOM ────────────────────────────────────────────────────────────────────

/** What the tour needs from the city. main.ts registers one with `setTourWorld`. */
export interface TourWorld {
  /** The real numbers on screen, or null before the city has any. */
  facts(): TourFacts | null;
  /** A world point in viewport pixels, or null when it's off screen. */
  project(x: number, y: number, z: number): { x: number; y: number } | null;
  /** Glide the camera to look at a world point. */
  focus?(x: number, y: number, z: number, zoom: number): void;
  /** Back to the overview framing. */
  resetView?(): void;
}

export interface TourOptions {
  /** Defaults to the one main.ts registered. */
  world?: TourWorld;
  /** Called once when the tour ends. */
  onEnd?(how: TourEnd): void;
}

let registered: TourWorld | null = null;
let running: { promise: Promise<TourEnd>; tour: Tour } | null = null;

/** main.ts calls this once, so anyone can start the tour without plumbing. */
export function setTourWorld(world: TourWorld) {
  registered = world;
}

/** The Motion setting and the system, through dom.ts; the class too, in case settings toggled it this frame. */
const still = () => prefersReducedMotion() || document.documentElement.classList.contains('reduce-motion');

/** Browser automation (the e2e suite) never gets an unasked-for tour over the HUD. */
const automated = () => typeof navigator !== 'undefined' && navigator.webdriver && !tourRequested(location.search);

/** Resolves once the HUD is on screen: the boot screen has lifted and the front door has gone. */
async function hudReady() {
  await whenBooted();
  const root = document.documentElement;
  while (root.classList.contains('intro') || !root.classList.contains('hud-in')) await new Promise((r) => setTimeout(r, 200));
}

/**
 * Starts the tour (or returns the one already running). Resolves with how it
 * ended. Skipped quietly under browser automation unless `?tour` is set.
 */
export function startTour(opts: TourOptions = {}): Promise<TourEnd> {
  if (running) return running.promise;
  if (automated()) return Promise.resolve('skipped');
  hideChip();
  let tour!: Tour;
  const promise = new Promise<TourEnd>((resolve) => {
    tour = new Tour(opts.world ?? registered, (how) => {
      running = null;
      rememberTour(how);
      opts.onEnd?.(how);
      resolve(how);
    });
  });
  running = { promise, tour };
  void hudReady().then(() => tour.open());
  return promise;
}

/** Is a tour on screen? */
export function tourRunning(): boolean {
  return running !== null;
}

// ─── The chip: "Take a 1-minute tour" ───────────────────────────────────────

let chip: HTMLElement | null = null;

/**
 * Offers the tour with a small chip above the timeline, once per browser.
 * Safe to call more than once: it shows at most one chip, never during a
 * tour, and never again after the tour or a "no thanks".
 */
export function offerTour(opts: TourOptions = {}) {
  if (chip || running || !shouldOfferTour() || automated()) return;
  const c = el(
    'div',
    { class: 'tour-chip', role: 'region', 'aria-label': 'Tour' },
    `<button class="tour-chip-go" type="button"><span class="tour-chip-mark" aria-hidden="true">${markSvg({ cls: 'tour-chip-svg' })}</span><span class="tour-chip-text"><b>Take a 1-minute tour</b><small>What every number does to the city</small></span>${ICON.arrowRight}</button>
     <button class="tour-chip-close" type="button" aria-label="No thanks">${ICON.close}</button>`,
  );
  chip = c;
  c.querySelector('.tour-chip-go')!.addEventListener('click', () => {
    hideChip();
    void startTour(opts);
  });
  c.querySelector('.tour-chip-close')!.addEventListener('click', () => {
    rememberTour('dismissed');
    hideChip();
  });
  void hudReady().then(() => {
    if (chip !== c) return;
    (document.getElementById('ui') ?? document.body).append(c);
    requestAnimationFrame(() => c.classList.add('is-in'));
  });
}

function hideChip() {
  const c = chip;
  chip = null;
  if (!c) return;
  c.classList.remove('is-in');
  c.classList.add('is-leaving');
  window.setTimeout(() => c.remove(), still() ? 0 : 260);
}

/**
 * Offers the tour on the visitor's first touch of the city or the HUD (a
 * click, a key), a moment after it, so the chip never lands under a finger.
 */
export function armTourOffer(opts: TourOptions = {}) {
  if (!shouldOfferTour()) return;
  void hudReady().then(() => {
    const go = () => {
      window.removeEventListener('pointerdown', go, true);
      window.removeEventListener('keydown', go, true);
      window.setTimeout(() => offerTour(opts), 1200);
    };
    window.addEventListener('pointerdown', go, true);
    window.addEventListener('keydown', go, true);
  });
}

// ─── The tour itself ────────────────────────────────────────────────────────

/** Where each step points, as selectors tried in order (a `data-tour` hook first, where the HUD has one). */
const TARGETS: Partial<Record<StepId, { parts: string[]; prefer: Side[]; pad?: number }>> = {
  metrics: { parts: ['[data-tour=metrics], .rail .metrics'], prefer: ['right', 'below'] },
  treasury: { parts: ['.rail .city > .card-head', '.rail .city .treasury', '.rail .city .vitals'], prefer: ['right', 'below'] },
  housing: { parts: ['.rail .city .housing', '.rail .city .alerts:not(:empty)'], prefer: ['right', 'below'] },
  build: { parts: ['[data-tour=build], .toolbar .btn.build'], prefer: ['below', 'left'], pad: 5 },
  'build-menu': { parts: ['.drawer'], prefer: ['left', 'below'], pad: 4 },
  'build-place': { parts: ['.placing'], prefer: ['below', 'above'], pad: 5 },
  home: { parts: ['[data-tour=home], .toolbar .btn[aria-label^="Your home"]'], prefer: ['below', 'left'], pad: 5 },
  timeline: { parts: ['[data-tour=timeline], .dock'], prefer: ['above'], pad: 6 },
  share: { parts: ['[data-tour=share], .toolbar .btn[aria-label^="Share"]'], prefer: ['below', 'left'], pad: 5 },
};

/** Steps whose targets live in the left rail, which a phone folds behind the mini bar. */
const RAIL_STEPS: ReadonlySet<StepId> = new Set(['metrics', 'treasury', 'housing']);

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}

/** A soft spring (no overshoot to speak of), so the cut-out glides and settles rather than snapping. */
const OMEGA = 15;

class Tour {
  private world: TourWorld | null;
  private finish: (how: TourEnd) => void;
  private step: StepId = 'welcome';
  private ctx: TourContext = { canBuild: true };
  private facts: TourFacts | null = null;
  private gone = false;

  private root: HTMLElement;
  private hole: HTMLElement;
  private blocks: HTMLElement[];
  private hint: HTMLElement;
  private card: HTMLElement;
  private pages: HTMLElement;
  private dots: HTMLElement;
  private count: HTMLElement;
  private back: HTMLButtonElement;
  private next: HTMLButtonElement;
  private skip: HTMLButtonElement;
  private live: HTMLElement;

  /** The cut-out as drawn, its velocity, and where it's heading. */
  private box: Box | null = null;
  /** The cut-out as last written to the page, so a resting one costs nothing. */
  private drawn = '';
  private vel: Box = { x: 0, y: 0, w: 0, h: 0, r: 0 };
  private raf = 0;
  private last = 0;
  private cardAt = { x: NaN, y: NaN, w: 0, h: 0, side: '' as Side | '' };
  private paused = false;
  private drawerOpen = false;
  private placing = false;
  /** What the tour changed, to put back: the phone's rail, the camera. */
  private expandedRail = false;
  private movedCamera = false;
  private returnFocus: HTMLElement | null = null;
  private onKey = (e: KeyboardEvent) => this.key(e);
  private onResize = () => (this.cardAt.w = -1);

  constructor(world: TourWorld | null, finish: (how: TourEnd) => void) {
    this.world = world;
    this.finish = finish;
    this.root = el('div', { class: 'tour', 'data-step': 'welcome' });
    this.hole = el('div', { class: 'tour-hole', 'aria-hidden': 'true' }, '<i class="tour-ring"></i><i class="tour-ripple"></i><i class="tour-ripple"></i>');
    // Four panes around the cut-out catch clicks on the dimmed screen; the cut-out itself lets them through.
    this.blocks = [0, 1, 2, 3].map(() => el('div', { class: 'tour-block', 'aria-hidden': 'true' }));
    this.hint = el('div', { class: 'tour-hint', 'aria-hidden': 'true' });
    this.card = el(
      'section',
      { class: 'tour-card', role: 'dialog', tabindex: '-1', 'aria-modal': 'false', 'aria-labelledby': 'tour-title', 'aria-describedby': 'tour-body' },
      `<header class="tour-head">
         <ol class="tour-dots" aria-hidden="true">${DOT_STEPS.map(() => '<li></li>').join('')}</ol>
         <span class="tour-count num"></span>
       </header>
       <div class="tour-pages"></div>
       <footer class="tour-foot">
         <button class="tour-skip" type="button">Skip tour</button>
         <span class="tour-grow"></span>
         <button class="btn ghost sm tour-back" type="button">Back</button>
         <button class="btn primary sm tour-next" type="button"><span class="label">Next</span>${ICON.arrowRight}</button>
       </footer>`,
    );
    this.pages = this.card.querySelector('.tour-pages')!;
    this.dots = this.card.querySelector('.tour-dots')!;
    this.count = this.card.querySelector('.tour-count')!;
    this.back = this.card.querySelector('.tour-back')!;
    this.next = this.card.querySelector('.tour-next')!;
    this.skip = this.card.querySelector('.tour-skip')!;
    this.live = el('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
    this.back.addEventListener('click', () => this.input({ type: 'back' }));
    this.next.addEventListener('click', () => this.input({ type: 'next' }));
    this.skip.addEventListener('click', () => this.input({ type: 'skip' }));
    // A press on the dimmed screen: the ring flashes to say "over here", nothing else happens.
    for (const b of this.blocks) b.addEventListener('pointerdown', (e) => (e.preventDefault(), this.nudge()));
    this.root.append(this.hole, ...this.blocks, this.hint, this.card, this.live);
  }

  open() {
    if (this.gone) return;
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.append(this.root);
    document.documentElement.classList.add('touring');
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('resize', this.onResize);
    this.readUi();
    this.go('welcome', true);
    requestAnimationFrame(() => this.root.classList.add('is-in'));
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
    // Dev only: screenshot scripts step the frame loop by hand to film the cut-out moving.
    if (import.meta.env.DEV) (window as unknown as { __tour?: Tour }).__tour = this;
  }

  // ── Input ───────────────────────────────────────────────────────────────

  private input(i: TourInput) {
    if (this.gone) return;
    this.refreshFacts();
    const to = nextStep(this.step, i, this.ctx);
    if (to === 'done' && this.step === 'done') return this.end('done');
    if (to === 'skipped') return this.end('skipped');
    if (to === 'done') return this.go('done');
    if (to !== this.step) this.go(to);
  }

  private key(e: KeyboardEvent) {
    if (this.gone || this.paused || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if ((t instanceof HTMLInputElement && t.type !== 'range') || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
    // Keys belong to the tour when focus is on its card or nowhere in particular; a control elsewhere keeps its own.
    const ours = !t || t === document.body || this.root.contains(t);
    const stop = () => (e.preventDefault(), e.stopImmediatePropagation());
    if (e.key === 'Escape') {
      // While placing, Esc cancels the placement (the card then moves on by itself).
      if (this.step === 'build-place') return;
      stop();
      this.input({ type: 'skip' });
    } else if (e.key === 'ArrowRight' && ours) {
      stop();
      this.input({ type: 'next' });
    } else if (e.key === 'ArrowLeft' && ours) {
      stop();
      this.input({ type: 'back' });
    } else if (e.key === 'Enter' && ours && !(t instanceof HTMLButtonElement)) {
      stop();
      this.input({ type: 'next' });
    }
  }

  // ── Steps ───────────────────────────────────────────────────────────────

  private refreshFacts() {
    this.facts = this.world?.facts() ?? null;
    // Without facts, read the build button's own "something's ready" mark.
    this.ctx = { canBuild: this.facts ? this.facts.canBuild : !!document.querySelector('.toolbar .btn.build.has-new') };
  }

  private go(step: StepId, first = false) {
    const from = this.step;
    this.step = step;
    this.refreshFacts();
    this.prepare(from, step);
    this.root.dataset.step = step;
    const copy = stepCopy(step, this.facts, { touch: matchMedia('(pointer: coarse)').matches });
    const action = waitsForAction(step, this.ctx);
    this.root.classList.toggle('is-action', action);
    this.root.classList.toggle('is-hero', step === 'welcome' || step === 'done');
    // While placing, the city must stay clickable and bright enough to see the glowing plots.
    this.root.classList.toggle('is-open', step === 'build-place');
    this.render(copy, from, first);
    this.renderHint(copy);
    this.cardAt.w = -1;
    if (step === 'done' && !first) this.flourish();
  }

  /** Puts the HUD in the state a step needs: the build menu open or shut, the phone's rail out, the camera on the fog. */
  private prepare(from: StepId, to: StepId) {
    const drawer = document.querySelector<HTMLElement>('.drawer');
    const drawerOpen = !!drawer && !drawer.hidden && !drawer.classList.contains('closing');
    if (to !== 'build-place' && this.isPlacing()) document.querySelector<HTMLButtonElement>('.placing button')?.click();
    if (to === 'build-menu' && !drawerOpen) document.querySelector<HTMLButtonElement>('.toolbar .btn.build')?.click();
    if (to !== 'build-menu' && to !== 'build-place' && drawerOpen) drawer!.querySelector<HTMLButtonElement>('[data-act=close]')?.click();
    // Our own changes aren't the visitor's: don't let them count as events.
    this.readUi();

    const mini = document.querySelector<HTMLElement>('.rail .mini');
    const rail = document.querySelector<HTMLElement>('.rail');
    const folded = !!mini && mini.offsetParent !== null && getComputedStyle(mini).display !== 'none';
    if (RAIL_STEPS.has(to) && folded && rail && !rail.classList.contains('expanded')) {
      mini!.click();
      this.expandedRail = true;
    } else if (!RAIL_STEPS.has(to) && this.expandedRail) {
      if (rail?.classList.contains('expanded')) mini?.click();
      this.expandedRail = false;
    }
    if (RAIL_STEPS.has(to)) {
      const t = this.targetElements(to)[0];
      // On a phone the rail scrolls: bring the part we're talking about to the top of it.
      if (t && rail && rail.scrollHeight > rail.clientHeight + 2) t.scrollIntoView({ block: 'start', behavior: still() ? 'auto' : 'smooth' });
    }

    const fog = this.facts?.fog;
    if (to === 'fog' && fog && this.world?.focus) {
      this.world.focus(fog.x, 0, fog.z, fog.kind === 'block' ? 1.7 : 1.4);
      this.movedCamera = true;
    } else if (from === 'fog' && this.movedCamera) {
      this.world?.resetView?.();
      this.movedCamera = false;
    }
  }

  private isPlacing() {
    const b = document.querySelector<HTMLElement>('.placing');
    return !!b && !b.hidden;
  }

  /** Notes the build menu and placement as they are now. */
  private readUi() {
    const d = document.querySelector<HTMLElement>('.drawer');
    this.drawerOpen = !!d && !d.hidden && !d.classList.contains('closing');
    this.placing = this.isPlacing();
  }

  private render(copy: StepCopy, from: StepId, first: boolean) {
    const i = dotIndex(this.step);
    this.dots.querySelectorAll('li').forEach((li, k) => {
      li.classList.toggle('on', k === i);
      li.classList.toggle('past', k < i);
    });
    this.count.textContent = `${i + 1} / ${DOT_STEPS.length}`;
    this.back.hidden = this.step === 'welcome';
    this.skip.hidden = this.step === 'done';
    this.skip.textContent = this.step === 'welcome' ? 'Not now' : 'Skip tour';
    this.next.querySelector('.label')!.textContent = copy.primary;
    this.next.classList.toggle('is-final', this.step === 'done');

    const fact = copy.fact ? `<p class="tour-fact">${escape(copy.fact).replace(/\{([^}]*)\}/g, '<b class="num">$1</b>')}</p>` : '';
    const keys = copy.keys?.length ? `<p class="tour-keys">${copy.keys.map((k) => `<span><kbd>${escape(k.key)}</kbd>${escape(k.what)}</span>`).join('')}</p>` : '';
    const hero = this.step === 'welcome' || this.step === 'done';
    const art = hero
      ? `<div class="tour-art" aria-hidden="true">${this.step === 'done' ? burstSvg() : ''}${markSvg({ cls: 'tour-mark' })}</div>`
      : '';
    const page = el(
      'div',
      { class: 'tour-page' },
      `${art}<p class="tour-kicker">${hero ? '' : `<span class="tile tone-brand">${ICON[copy.icon]}</span>`}<span class="eyebrow">${escape(copy.eyebrow)}</span></p>
       <h2 class="tour-title" id="tour-title">${escape(copy.title)}</h2>
       <p class="tour-body" id="tour-body">${escape(copy.body)}</p>
       ${fact}${keys}`,
    );
    const old = this.pages.querySelector<HTMLElement>('.tour-page:not(.is-out)');
    // The old page slides out the way we're going, the new one in from the other side; the card's height follows.
    const forward = DOT_STEPS.indexOf(this.step) >= DOT_STEPS.indexOf(from) || dotIndex(this.step) > dotIndex(from);
    this.pages.dataset.dir = forward ? 'fwd' : 'back';
    if (old && !first && !still()) {
      const h0 = this.pages.offsetHeight;
      old.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
      old.classList.add('is-out');
      old.style.width = `${old.offsetWidth}px`;
      window.setTimeout(() => old.remove(), 260);
      this.pages.append(page);
      const h1 = page.offsetHeight;
      this.pages.style.height = `${h0}px`;
      void this.pages.offsetHeight;
      this.pages.style.height = `${h1}px`;
      window.setTimeout(() => {
        if (page.isConnected && !page.classList.contains('is-out')) this.pages.style.height = '';
      }, 360);
    } else {
      this.pages.replaceChildren(page);
    }
    this.card.classList.toggle('is-hero', hero);
    this.live.textContent = `Step ${i + 1} of ${DOT_STEPS.length}. ${copy.title}`;
    // Focus the card, not its button: no focus ring on arrival (it reads as a form), and Enter still goes on.
    this.card.focus({ preventScroll: true });
  }

  private renderHint(copy: StepCopy) {
    const h = copy.hint;
    this.hint.dataset.mode = h?.mode ?? '';
    this.hint.hidden = !h;
    if (!h) return;
    this.hint.innerHTML =
      h.mode === 'press'
        ? `<svg class="tour-caret" viewBox="0 0 14 8" aria-hidden="true"><path d="M1 7.5 7 1.5l6 6"/></svg><span>${escape(h.text)}</span>`
        : `<svg class="tour-cursor" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 3.2v12.4l3.3-3.1 2.2 4.9 2.1-.9-2.2-4.8h4.5Z"/></svg><span>${escape(h.text)}</span>`;
  }

  /** The ring flashes: "the tour is over here". */
  private nudge() {
    this.hole.classList.remove('is-nudged');
    void this.hole.offsetWidth;
    this.hole.classList.add('is-nudged');
    this.card.classList.remove('is-nudged');
    void this.card.offsetWidth;
    this.card.classList.add('is-nudged');
  }

  /** A little burst of sun and Golden Gate around the mark: you finished. */
  private flourish() {
    this.root.classList.remove('is-celebrating');
    void this.root.offsetWidth;
    this.root.classList.add('is-celebrating');
  }

  // ── Targets ─────────────────────────────────────────────────────────────

  private targetElements(step: StepId): HTMLElement[] {
    const spec = TARGETS[step];
    if (!spec) return [];
    const out: HTMLElement[] = [];
    for (const sel of spec.parts) {
      const e = document.querySelector<HTMLElement>(sel);
      if (e && e.getClientRects().length && !e.hidden) out.push(e);
    }
    return out;
  }

  /** Where the cut-out should be now, in viewport pixels, or null for none (a centred card). */
  private target(): Box | null {
    const step = this.step;
    if (step === 'fog') return this.fogBox();
    const els = this.targetElements(step);
    if (!els.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const e of els) {
      const r = e.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      x0 = Math.min(x0, r.left);
      y0 = Math.min(y0, r.top);
      x1 = Math.max(x1, r.right);
      y1 = Math.max(y1, r.bottom);
    }
    if (!Number.isFinite(x0)) return null;
    // A rail card scrolled partly out of its rail: spotlight only what's visible.
    if (RAIL_STEPS.has(step)) {
      const rail = document.querySelector('.rail')?.getBoundingClientRect();
      if (rail) {
        y0 = Math.max(y0, rail.top);
        y1 = Math.min(y1, rail.bottom);
        if (y1 - y0 < 8) return null;
      }
    }
    const pad = TARGETS[step]?.pad ?? 8;
    const radius = els.length === 1 ? parseFloat(getComputedStyle(els[0]!).borderTopLeftRadius) || 10 : 14;
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2, r: Math.min(radius + pad, 26) };
  }

  /** The fog bank, from its footprint's corners projected onto the screen. */
  private fogBox(): Box | null {
    const fog = this.facts?.fog;
    const w = this.world;
    if (!fog || !w) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const dx of [-1, 1]) {
      for (const dz of [-1, 1]) {
        for (const y of [0, fog.top]) {
          const p = w.project(fog.x + dx * fog.half, y, fog.z + dz * fog.half);
          if (!p) continue;
          x0 = Math.min(x0, p.x);
          y0 = Math.min(y0, p.y);
          x1 = Math.max(x1, p.x);
          y1 = Math.max(y1, p.y);
        }
      }
    }
    if (!Number.isFinite(x0)) return null;
    const vw = innerWidth, vh = innerHeight;
    x0 = Math.max(8, x0 - 10);
    y0 = Math.max(8, y0 - 10);
    x1 = Math.min(vw - 8, x1 + 10);
    y1 = Math.min(vh - 8, y1 + 10);
    if (x1 - x0 < 24 || y1 - y0 < 24) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, r: Math.min(28, (x1 - x0) / 4) };
  }

  // ── The frame loop: events, the cut-out, the card ───────────────────────

  private frame(now: number) {
    if (this.gone) return;
    this.raf = requestAnimationFrame((t) => this.frame(t));
    // Real time, up to a quarter second: a slow device sees the same glide in fewer frames, not a slower one.
    const dt = Math.min(0.25, Math.max(0, (now - this.last) / 1000));
    this.last = now;

    // A dialog (your home, share) opened over everything: step aside until it closes.
    const paused = !!document.querySelector('dialog[open]');
    if (paused !== this.paused) {
      this.paused = paused;
      this.root.classList.toggle('is-paused', paused);
      if (!paused) this.card.focus({ preventScroll: true });
    }
    if (paused) return;

    // What the visitor did: placement first (buying closes the menu in the same click).
    const d = document.querySelector<HTMLElement>('.drawer');
    const drawerOpen = !!d && !d.hidden && !d.classList.contains('closing');
    const placing = this.isPlacing();
    if (placing !== this.placing) {
      this.placing = placing;
      this.input({ type: 'placing', on: placing });
    }
    if (drawerOpen !== this.drawerOpen) {
      this.drawerOpen = drawerOpen;
      this.input({ type: 'drawer', open: drawerOpen });
    }

    const vw = innerWidth, vh = innerHeight;
    const goal = this.target();
    // No target: the cut-out closes to a point where the card is, so the next one opens out of it.
    const fallback: Box = { x: vw / 2, y: vh / 2, w: 0, h: 0, r: 0 };
    const g = goal ?? (this.box ? { x: this.box.x + this.box.w / 2, y: this.box.y + this.box.h / 2, w: 0, h: 0, r: 0 } : fallback);
    if (!this.box || still()) {
      this.box = { ...g };
      this.vel = { x: 0, y: 0, w: 0, h: 0, r: 0 };
    } else {
      const k = OMEGA * OMEGA, c = 2 * OMEGA;
      // Fixed small steps keep the spring stable however long the frame was.
      for (let left = dt; left > 1e-6; left -= 1 / 120) {
        const h = Math.min(1 / 120, left);
        for (const key of ['x', 'y', 'w', 'h', 'r'] as const) {
          this.vel[key] += ((g[key] - this.box[key]) * k - this.vel[key] * c) * h;
          this.box[key] += this.vel[key] * h;
        }
      }
    }
    // At rest, nothing is rewritten: the veil only repaints while the cut-out moves.
    const b = this.box;
    const sig = `${b.x.toFixed(1)},${b.y.toFixed(1)},${b.w.toFixed(1)},${b.h.toFixed(1)},${b.r.toFixed(1)},${vw},${vh}`;
    if (sig !== this.drawn) {
      this.drawn = sig;
      this.drawHole(b, vw, vh);
    }
    const resting = Math.abs(this.vel.x) + Math.abs(this.vel.y) + Math.abs(this.vel.w) + Math.abs(this.vel.h) < 0.5 && Math.abs(g.x - b.x) + Math.abs(g.y - b.y) + Math.abs(g.w - b.w) + Math.abs(g.h - b.h) < 1;
    this.root.toggleAttribute('data-settled', resting);
    this.placeCardFor(goal, vw, vh);
    this.placeHint(goal);
  }

  private drawHole(b: Box, vw: number, vh: number) {
    const w = Math.max(0, b.w), h = Math.max(0, b.h);
    const s = this.hole.style;
    s.transform = `translate3d(${b.x.toFixed(1)}px, ${b.y.toFixed(1)}px, 0)`;
    s.width = `${w.toFixed(1)}px`;
    s.height = `${h.toFixed(1)}px`;
    s.borderRadius = `${Math.max(0, Math.min(b.r, w / 2, h / 2)).toFixed(1)}px`;
    this.hole.classList.toggle('is-closed', w < 2 || h < 2);
    // The panes that catch clicks: above, below, left and right of the cut-out.
    const x0 = Math.max(0, b.x), y0 = Math.max(0, b.y), x1 = Math.min(vw, b.x + w), y1 = Math.min(vh, b.y + h);
    const panes: [number, number, number, number][] =
      w < 2 || h < 2
        ? [[0, 0, vw, vh], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]
        : [
            [0, 0, vw, y0],
            [0, y1, vw, vh - y1],
            [0, y0, x0, y1 - y0],
            [x1, y0, vw - x1, y1 - y0],
          ];
    panes.forEach(([x, y, pw, ph], i) => {
      const st = this.blocks[i]!.style;
      st.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      st.width = `${Math.max(0, pw).toFixed(1)}px`;
      st.height = `${Math.max(0, ph).toFixed(1)}px`;
    });
  }

  private placeCardFor(goal: Box | null, vw: number, vh: number) {
    const cw = this.card.offsetWidth, ch = this.card.offsetHeight;
    const prefer = TARGETS[this.step]?.prefer ?? (this.step === 'fog' ? (['right', 'left', 'below', 'above'] as Side[]) : undefined);
    const extra = this.hint.hidden ? 0 : 44;
    const at = placeCard(goal, { w: cw, h: ch }, { w: vw, h: vh }, prefer, extra);
    const moved = Math.abs(at.x - this.cardAt.x) > 1.5 || Math.abs(at.y - this.cardAt.y) > 1.5;
    if (!moved && this.cardAt.side === at.side && this.cardAt.w === cw) return;
    this.cardAt = { x: at.x, y: at.y, w: cw, h: ch, side: at.side };
    this.card.dataset.side = at.side;
    this.card.style.transform = `translate3d(${Math.round(at.x)}px, ${Math.round(at.y)}px, 0)`;
  }

  private placeHint(goal: Box | null) {
    if (this.hint.hidden || !goal) {
      this.hint.classList.remove('is-placed');
      return;
    }
    const hw = this.hint.offsetWidth, hh = this.hint.offsetHeight;
    let x: number, y: number;
    // Under the target (a "Press here" caret points up at it); above it when it sits low on the screen.
    // The fog's nudge goes the same way, so it never covers the bank it's about.
    const below = goal.y + goal.h + 10 + hh < innerHeight - 8;
    this.hint.dataset.at = below ? 'below' : 'above';
    x = goal.x + goal.w / 2 - hw / 2;
    y = below ? goal.y + goal.h + 10 : goal.y - 10 - hh;
    x = Math.max(8, Math.min(innerWidth - hw - 8, x));
    this.hint.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    this.hint.classList.add('is-placed');
  }

  // ── Leaving ─────────────────────────────────────────────────────────────

  private end(how: TourEnd) {
    if (this.gone) return;
    this.gone = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('resize', this.onResize);
    // Put back what the tour changed: the menu it opened, the phone's rail, the camera.
    if (this.step === 'build-menu') document.querySelector<HTMLButtonElement>('.drawer [data-act=close]')?.click();
    if (this.expandedRail && document.querySelector('.rail.expanded')) document.querySelector<HTMLElement>('.rail .mini')?.click();
    if (this.movedCamera) this.world?.resetView?.();
    document.documentElement.classList.remove('touring');
    const r = this.root;
    r.classList.remove('is-in');
    r.classList.add('is-leaving');
    window.setTimeout(() => r.remove(), still() ? 0 : 420);
    const back = this.returnFocus;
    if (back?.isConnected && back !== document.body) back.focus({ preventScroll: true });
    else (document.activeElement as HTMLElement | null)?.blur?.();
    this.finish(how);
  }
}

/** Rays and sparks around the mark on the last card: sun, Golden Gate and Bay, drawn outward once. */
function burstSvg(): string {
  const rays: string[] = [];
  const tones = ['sun', 'gate', 'sun', 'bay'];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 - Math.PI / 2;
    const long = i % 2 === 0;
    const r0 = long ? 38 : 41;
    const r1 = long ? 56 : 50;
    const p = (r: number) => `${(60 + Math.cos(a) * r).toFixed(1)} ${(60 + Math.sin(a) * r).toFixed(1)}`;
    rays.push(`<path class="tour-ray tone-${tones[i % 4]}" style="--i:${i % 4}" d="M${p(r0)}L${p(r1)}" pathLength="1"/>`);
  }
  const sparks = [
    [18, 26],
    [102, 30],
    [12, 82],
    [108, 88],
    [60, 4],
  ]
    .map(([x, y], i) => `<path class="tour-spark" style="--i:${i}" transform="translate(${x} ${y})" d="M0-5C.3-1.4 1.4-.3 5 0 1.4.3.3 1.4 0 5-.3 1.4-1.4.3-5 0-1.4-.3-.3-1.4 0-5Z"/>`)
    .join('');
  return `<svg class="tour-burst" viewBox="0 0 120 120"><circle class="tour-halo" cx="60" cy="60" r="34"/>${rays.join('')}${sparks}</svg>`;
}
