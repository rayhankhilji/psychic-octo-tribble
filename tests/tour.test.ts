import { describe, expect, it } from 'vitest';
import { demoTimeline } from '../src/data/demo.ts';
import { demoActions } from '../src/game/demo-script.ts';
import { BUILD_BLOCKS, HOME_TIERS, REGIONS } from '../src/game/catalog.ts';
import { FREE_HOUSED, MRR_PER_USER, RATE, simulate } from '../src/game/economy.ts';
import {
  DOT_STEPS,
  dotIndex,
  fogTarget,
  ladderLine,
  nextStep,
  placeCard,
  regionLine,
  rememberTour,
  shouldOfferTour,
  stepCopy,
  tourFacts,
  tourRequested,
  TOUR_KEY,
  waitsForAction,
  type StepId,
  type TourContext,
  type TourInput,
} from '../src/ui/tour.ts';

const can: TourContext = { canBuild: true };
const cannot: TourContext = { canBuild: false };
const NEXT: TourInput = { type: 'next' };
const BACK: TourInput = { type: 'back' };

/** Presses Next from the welcome card until the tour ends, recording each card. */
function walk(ctx: TourContext): StepId[] {
  const seen: StepId[] = ['welcome'];
  let s: StepId = 'welcome';
  for (let i = 0; i < 30; i++) {
    const to = nextStep(s, NEXT, ctx);
    if (to === s) break;
    if (to === 'done' || to === 'skipped') {
      seen.push(to as StepId);
      if (to === 'done') break;
    }
    s = to as StepId;
    if (seen.at(-1) !== s) seen.push(s);
  }
  return seen;
}

describe('the step machine', () => {
  it('has ten stops, one dot each', () => {
    expect(DOT_STEPS).toHaveLength(10);
    expect(DOT_STEPS[0]).toBe('welcome');
    expect(DOT_STEPS.at(-1)).toBe('done');
  });

  it('walks every stop with Next, through the build menu when something is affordable', () => {
    expect(walk(can)).toEqual(['welcome', 'metrics', 'treasury', 'housing', 'build', 'build-menu', 'fog', 'home', 'timeline', 'share', 'done']);
  });

  it('skips the build menu when nothing is affordable, and the build card stops waiting', () => {
    expect(walk(cannot)).toEqual(['welcome', 'metrics', 'treasury', 'housing', 'build', 'fog', 'home', 'timeline', 'share', 'done']);
    expect(waitsForAction('build', can)).toBe(true);
    expect(waitsForAction('build', cannot)).toBe(false);
  });

  it('Next on the last card ends it as done; Skip ends it from anywhere', () => {
    expect(nextStep('done', NEXT, can)).toBe('done');
    for (const s of [...DOT_STEPS, 'build-menu', 'build-place'] as StepId[]) expect(nextStep(s, { type: 'skip' }, can)).toBe('skipped');
  });

  it('Back retraces the stops and never goes before the welcome', () => {
    expect(nextStep('welcome', BACK, can)).toBe('welcome');
    expect(nextStep('metrics', BACK, can)).toBe('welcome');
    expect(nextStep('home', BACK, can)).toBe('fog');
    expect(nextStep('done', BACK, can)).toBe('share');
    // Out of the build follow-ups, and from the fog, Back returns to the build card itself.
    expect(nextStep('build-menu', BACK, can)).toBe('build');
    expect(nextStep('build-place', BACK, can)).toBe('build');
    expect(nextStep('fog', BACK, can)).toBe('build');
  });

  it('waits for the visitor: opening the build menu, buying, placing', () => {
    // Opening the menu yourself (Build, or B) moves the card on.
    expect(nextStep('build', { type: 'drawer', open: true }, can)).toBe('build-menu');
    // Buying a plot item starts placement.
    expect(nextStep('build-menu', { type: 'placing', on: true }, can)).toBe('build-place');
    // Placing it (or cancelling) moves on to the fog.
    expect(nextStep('build-place', { type: 'placing', on: false }, can)).toBe('fog');
    // Closing the menu without buying moves on too.
    expect(nextStep('build-menu', { type: 'drawer', open: false }, can)).toBe('fog');
    // Buying shuts the menu in the same click: once placing, the menu closing means nothing.
    expect(nextStep('build-place', { type: 'drawer', open: false }, can)).toBe('build-place');
  });

  it('ignores the build menu and placement on cards that are not about building', () => {
    for (const s of ['welcome', 'metrics', 'fog', 'home', 'timeline', 'share', 'done'] as StepId[]) {
      expect(nextStep(s, { type: 'drawer', open: true }, can)).toBe(s);
      expect(nextStep(s, { type: 'drawer', open: false }, can)).toBe(s);
      expect(nextStep(s, { type: 'placing', on: false }, can)).toBe(s);
    }
  });

  it('the build follow-ups light the build dot', () => {
    expect(dotIndex('build-menu')).toBe(dotIndex('build'));
    expect(dotIndex('build-place')).toBe(dotIndex('build'));
    expect(dotIndex('fog')).toBe(dotIndex('build') + 1);
  });
});

describe('placing the card', () => {
  const view = { w: 1440, h: 900 };
  const card = { w: 352, h: 240 };

  it('centres it when there is nothing to point at', () => {
    expect(placeCard(null, card, view)).toEqual({ x: 544, y: 330, side: 'center' });
  });

  it('sits beside the rail, below a top-bar button, above the dock', () => {
    const rail = placeCard({ x: 16, y: 80, w: 276, h: 300 }, card, view, ['right']);
    expect(rail.side).toBe('right');
    expect(rail.x).toBeGreaterThan(16 + 276);
    const build = placeCard({ x: 1300, y: 12, w: 90, h: 44 }, card, view, ['below', 'left'], 44);
    expect(build.side).toBe('below');
    expect(build.y).toBeGreaterThanOrEqual(12 + 44 + 44);
    expect(build.x + card.w).toBeLessThanOrEqual(view.w - 16);
    const dock = placeCard({ x: 16, y: 820, w: 1408, h: 70 }, card, view, ['above']);
    expect(dock).toMatchObject({ side: 'above', y: 820 - 16 - 240 });
  });

  it('falls through to the next side that fits, and stays on screen when none does', () => {
    const drawer = placeCard({ x: 1000, y: 70, w: 430, h: 800 }, card, view, ['right', 'left']);
    expect(drawer.side).toBe('left');
    const huge = placeCard({ x: 0, y: 0, w: 1440, h: 900 }, card, view, ['right', 'left', 'below', 'above']);
    expect(huge.side).toBe('over');
    expect(huge.y + card.h).toBeLessThanOrEqual(view.h);
  });

  it('is a sheet on phones, on whichever edge the target leaves clear', () => {
    const phone = { w: 390, h: 844 };
    const sheet = { w: 370, h: 260 };
    expect(placeCard(null, sheet, phone).side).toBe('sheet-bottom');
    expect(placeCard({ x: 300, y: 8, w: 48, h: 48 }, sheet, phone).side).toBe('sheet-bottom');
    // The timeline sits at the bottom of a phone: the sheet goes to the top.
    expect(placeCard({ x: 8, y: 720, w: 374, h: 116 }, sheet, phone)).toEqual({ x: 10, y: 10, side: 'sheet-top' });
  });
});

describe('remembering the tour', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };

  it('offers it until it is finished, skipped or waved away', () => {
    for (const how of ['done', 'skipped', 'dismissed'] as const) {
      const s = memory();
      expect(shouldOfferTour(s)).toBe(true);
      rememberTour(how, s);
      expect(s.m.get(TOUR_KEY)).toBe(how);
      expect(shouldOfferTour(s)).toBe(false);
    }
  });

  it('never asks when storage is missing or throws (it could not remember a no)', () => {
    expect(shouldOfferTour(null)).toBe(false);
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(shouldOfferTour(broken)).toBe(false);
    expect(() => rememberTour('done', broken)).not.toThrow();
  });

  it('?tour forces it', () => {
    expect(tourRequested('?tour')).toBe(true);
    expect(tourRequested('?demo&tour=1')).toBe(true);
    expect(tourRequested('?demo')).toBe(false);
  });
});

describe('the cards quote the real numbers', () => {
  const t = demoTimeline();
  const actions = demoActions(t.snapshots);
  const last = t.snapshots.length - 1;
  const game = simulate(t.snapshots, actions, last);
  const facts = tourFacts(game, t);

  it('reads the facts from the game on screen', () => {
    expect(facts.demo).toBe(true);
    expect(facts.name).toBe(t.name);
    expect(facts.day).toBe(last + 1);
    expect(facts.mrr).toBe(game.mrr);
    expect(facts.customers).toBe(t.snapshots[last]!.customers);
    expect(facts.users).toBe(game.population);
    expect(facts.incomePerDay).toBe(game.incomePerDay);
  });

  it('every card has a title and a body, and no card prints undefined or NaN', () => {
    for (const s of [...DOT_STEPS, 'build-menu', 'build-place'] as StepId[]) {
      for (const f of [facts, null, { ...facts, demo: false }, { ...facts, canBuild: false, fog: null, unhoused: 120 }]) {
        const c = stepCopy(s, f);
        expect(c.title.length, s).toBeGreaterThan(3);
        expect(c.body.length, s).toBeGreaterThan(10);
        expect(JSON.stringify(c), s).not.toMatch(/undefined|NaN|null/);
      }
    }
  });

  it('quotes the figures the HUD shows, with the game’s own constants', () => {
    const usd = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;
    expect(stepCopy('metrics', facts).fact).toContain(usd(game.mrr));
    expect(stepCopy('treasury', facts).title).toContain(`$${RATE.toLocaleString('en-US')}`);
    const housing = stepCopy('housing', facts);
    expect(housing.body).toContain(`$${MRR_PER_USER.toFixed(2)}`);
    expect(housing.body).toContain(`first ${FREE_HOUSED}`);
    expect(housing.fact).toContain(usd(Math.ceil(game.housingNeed)));
  });

  it('says so plainly when people are unhoused, and when nothing can be built', () => {
    expect(stepCopy('housing', { ...facts, unhoused: 1234 }).fact).toMatch(/\{1,234\} are in tents/);
    const nothing = stepCopy('build', { ...facts, canBuild: false });
    expect(nothing.hint).toBeUndefined();
    expect(nothing.body).toMatch(/nothing to build right now/);
    expect(stepCopy('build', facts).hint?.text).toBe('Press here');
  });

  it('the ladder and the fog list come from HOME_TIERS and REGIONS', () => {
    const top = HOME_TIERS.at(-1)!;
    expect(ladderLine()).toContain(`a house on the moon at $`);
    // Every rung above the hacker house gets a phrase, in order, at its own MRR.
    const prices = [...ladderLine().matchAll(/at \$([\d.]+)(k|M)?/g)].map((m) => Number(m[1]) * (m[2] === 'M' ? 1e6 : m[2] === 'k' ? 1e3 : 1));
    expect(prices).toEqual(HOME_TIERS.slice(1).map((t) => t.mrr));
    expect(ladderLine()).toMatch(/^a studio at \$\d+, a bungalow or loft at /);
    expect(ladderLine()).toMatch(new RegExp(`moon at \\$${top.mrr >= 1e6 ? top.mrr / 1e6 + 'M' : top.mrr / 1e3 + 'k'}$`));
    for (const r of Object.values(REGIONS)) expect(regionLine()).toContain(r.gate >= 1e6 ? `$${r.gate / 1e6}M` : r.gate >= 1e3 ? `$${r.gate / 1e3}k` : `$${r.gate}`);
    expect(stepCopy('fog', facts).body).toContain(regionLine());
    expect(stepCopy('home', facts).body).toContain(ladderLine());
  });

  it('the welcome is honest that the demo is made up; the founder’s says “your”', () => {
    expect(stepCopy('welcome', facts).body).toContain('made-up startup');
    expect(stepCopy('welcome', { ...facts, demo: false }).title).toBe('Your city runs on your real numbers');
    expect(stepCopy('done', { ...facts, demo: false }).title).toBe('Your city is yours.');
  });
});

describe('fogTarget', () => {
  it('points at the next downtown block under fog', () => {
    const f = fogTarget({ openBlocks: [BUILD_BLOCKS[0]!.id], regions: { hills: false, pier: false, marina: false, island: false, launchpad: false }, peakMrr: 0 });
    expect(f).toMatchObject({ kind: 'block', name: BUILD_BLOCKS[1]!.name, gate: BUILD_BLOCKS[1]!.gate });
  });

  it('knows when a block only waits for the open plots to fill', () => {
    const b = BUILD_BLOCKS.find((x) => x.gate > 0)!;
    const open = BUILD_BLOCKS.filter((x) => x !== b && BUILD_BLOCKS.indexOf(x) < BUILD_BLOCKS.indexOf(b)).map((x) => x.id);
    const regions = { hills: false, pier: false, marina: false, island: false, launchpad: false };
    expect(fogTarget({ openBlocks: open, regions, peakMrr: b.gate - 1 })!.waitsForPlots).toBe(false);
    expect(fogTarget({ openBlocks: open, regions, peakMrr: b.gate })!.waitsForPlots).toBe(true);
  });

  it('moves on to the regions once downtown is open, and to nothing when all land is', () => {
    const all = BUILD_BLOCKS.map((b) => b.id);
    const f = fogTarget({ openBlocks: all, regions: { hills: true, pier: true, marina: false, island: false, launchpad: false }, peakMrr: 0 });
    expect(f).toMatchObject({ kind: 'region', name: REGIONS.marina.name, gate: REGIONS.marina.gate });
    expect(fogTarget({ openBlocks: all, regions: { hills: true, pier: true, marina: true, island: true, launchpad: true }, peakMrr: 0 })).toBeNull();
  });
});
