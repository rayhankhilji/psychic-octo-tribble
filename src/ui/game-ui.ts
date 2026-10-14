import { CATALOG, HOME_TIERS, HQ_LEVEL_NAMES, ITEMS, REGIONS, SWAP_FEE, type Category, type Item, type Region } from '../game/catalog.ts';
import { canBuy, decayOf, FREE_HOUSED, money, MRR_PER_USER, type GameState } from '../game/economy.ts';
import { compact, el, escape, reducedMotion, returnFocusOnClose, setHtml, setText, shortMrr, showModal, Tint, Tween } from './dom.ts';
import { ICON, type IconName } from './icons.ts';
import { lazyThumbnail, prewarmThumbnails, setThumbnailBusy } from './thumbnails.ts';

export type Place = 'downtown' | 'hills' | 'pier' | 'marina' | 'airport' | 'island' | 'launchpad';

const PLACES: { id: Place; name: string; hint: string; icon: IconName; region?: Region }[] = [
  { id: 'downtown', name: 'Downtown', hint: 'Your HQ and Market Street', icon: 'store' },
  { id: 'hills', name: 'TinyTown Hills', hint: 'Under the sign', icon: 'home' },
  { id: 'pier', name: "Fisherman's Wharf", hint: 'The pier and its rides', icon: 'heart' },
  { id: 'marina', name: 'The Marina', hint: 'Yacht berths', icon: 'ship' },
  { id: 'airport', name: 'Airport', hint: 'Planes and the helipad', icon: 'plane' },
  { id: 'island', name: 'Your island', hint: 'Out in the bay', icon: 'sun', region: 'island' },
  { id: 'launchpad', name: 'Launch site', hint: 'The far end of your island', icon: 'rocket', region: 'launchpad' },
];

export interface GameHandlers {
  onBuild(item: Item, plot?: string): void;
  onPickHome(tier: number, choice: string): void;
  onFlyToMoon(): void;
  /** Fly the helicopter between the airport and the island. */
  onFlyHelicopter(): void;
  onZoom(factor: number): void;
  onCancelPlacement(): void;
  onFocus(what: Place): void;
}

type Tab = Category | 'all';

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'all', label: 'All', icon: 'sparkle' },
  { id: 'business', label: 'Business', icon: 'build' },
  { id: 'civic', label: 'Civic', icon: 'heart' },
  { id: 'fun', label: 'Fun', icon: 'sun' },
  { id: 'vehicles', label: 'Vehicles', icon: 'plane' },
  { id: 'hq', label: 'HQ', icon: 'flag' },
];

const CATEGORY_ICON: Record<Category, IconName> = { business: 'build', civic: 'heart', fun: 'sun', vehicles: 'plane', hq: 'flag' };

const SITE_LABEL = { pier: 'On the pier', marina: 'At the marina', airport: 'At your airport', launchpad: 'Launch site' } as const;

const WHERE_LABEL: Record<string, string> = { downtown: 'Downtown', hills: 'TinyTown Hills', island: 'Your island', moon: 'The moon' };

/** What the city looks like as upkeep runs short, worst last. */
const DECAY_STAGES: { key: keyof ReturnType<typeof decayOf>; icon: IconName; title: string; at: number }[] = [
  { key: 'signDark', icon: 'bulbOff', title: 'The TINYTOWN sign is dark', at: 95 },
  { key: 'lampsFailing', icon: 'lamp', title: 'Street lamps are failing', at: 85 },
  { key: 'bridgeRusting', icon: 'bridge', title: 'The bridge is rusting', at: 75 },
  { key: 'trainStopped', icon: 'train', title: 'The train has stopped', at: 60 },
  { key: 'shopsBoarded', icon: 'store', title: 'Shops are boarding up', at: 50 },
  { key: 'housingFailing', icon: 'tent', title: 'Housing is failing', at: 35 },
];

const RING = 2 * Math.PI * 21;

function where(i: Item): string {
  const p = i.placement;
  return p.kind === 'site' ? SITE_LABEL[p.site] : p.kind === 'hq' ? 'Replaces your HQ' : p.size === 4 ? 'Whole block' : 'One plot';
}

function level(v: number, good: number, mid: number): 'good' | 'mid' | 'bad' {
  return v >= good ? 'good' : v >= mid ? 'mid' : 'bad';
}

/**
 * The game layer of the HUD: the city card (treasury, satisfaction,
 * housing, decay), the build menu, your home, and placement mode.
 */
export class GameUI {
  private h: GameHandlers;
  private root: HTMLElement;
  private state: GameState | null = null;
  private tab: Tab = 'all';
  private plot: string | undefined;
  private ownsRocket = false;
  /** Where the founder's helicopter is parked (it comes with the island). */
  private heliAt: 'airport' | 'island' = 'airport';

  private card: HTMLElement;
  private treasury: HTMLElement;
  private treasuryTween: Tween;
  private treasuryTint: Tint;
  /** When the last purchase came off the treasury: its count is tinted as spending, not as a loss. */
  private spentAt = -Infinity;
  private net: HTMLElement;
  private mood: HTMLElement;
  private ring: SVGCircleElement;
  private ringValue: HTMLElement;
  private ringTween: Tween;
  private ringWrap: HTMLElement;
  private parts: Record<'housing' | 'upkeep' | 'amenities' | 'momentum', HTMLElement>;
  private housing: HTMLElement;
  private housingStatus!: HTMLElement;
  private housingFoot!: HTMLElement;
  private meter!: HTMLElement;
  private alerts: HTMLElement;
  private fine: HTMLElement;
  private floaters: HTMLElement;
  private miniTreasury: HTMLElement | null;
  private miniTreasuryTween: Tween;
  private miniSat: HTMLElement | null;
  private miniSatFill: SVGCircleElement | null = null;
  private miniSatValue: HTMLElement | null = null;
  private lastOwned = -1;

  private drawer: HTMLElement;
  private drawerTitle: HTMLElement;
  private drawerSub: HTMLElement;
  private tabsEl: HTMLElement;
  private grid: HTMLElement;
  private cards = new Map<string, { root: HTMLElement; action: HTMLElement; sig: string }>();
  private buildBtn: HTMLButtonElement;
  private drawerReturn: HTMLElement | null = null;
  private drawerTimer = 0;

  private homeDialog: HTMLDialogElement;
  private homeBody: HTMLElement;
  private homeLive: HTMLElement;
  private homeSig = '';
  private homeStatus = '';
  /** The renovation waiting for a second click, as `tier:option`. */
  private confirmPick: string | null = null;
  /** The control to focus after the next re-render (`data-key`). */
  private focusAfter: string | undefined;
  private banner: HTMLElement;

  constructor(root: HTMLElement, side: HTMLElement, tools: HTMLElement, h: GameHandlers) {
    this.h = h;
    this.root = root;
    // Thumbnail prewarming waits out the replay (the HUD marks the root while it plays).
    setThumbnailBusy(() => root.classList.contains('is-playing'));

    // ── City card ──────────────────────────────────────────────────────
    this.card = el(
      'div',
      { class: 'city card' },
      `<div class="card-head"><span class="eyebrow" data-tip-title="Your treasury" data-tip="Every $1 of real revenue is $10,000 to build with, paid daily. Nothing in the game makes money: the only way to grow your city is to grow your startup.">City treasury</span><span class="chip mood"></span></div>
       <div class="treasury"><b class="num treasury-value">–</b><span class="chip net num"></span><span class="floaters" aria-hidden="true"></span></div>
       <div class="vitals">
         <div class="ring" tabindex="0" role="img" aria-label="Satisfaction">
           <svg viewBox="0 0 50 50" aria-hidden="true"><circle class="ring-track" cx="25" cy="25" r="21"/><circle class="ring-fill" cx="25" cy="25" r="21" stroke-dasharray="${RING.toFixed(2)}" stroke-dashoffset="${RING.toFixed(2)}"/></svg>
           <span class="ring-value num">–</span>
         </div>
         <div class="parts">
           <span class="ring-label">Satisfaction</span>
           ${(['housing', 'upkeep', 'amenities', 'momentum'] as const).map((k) => `<div class="part" data-part="${k}"><span>${k[0]!.toUpperCase() + k.slice(1)}</span><i><b></b></i></div>`).join('')}
         </div>
       </div>
       <div class="housing" tabindex="0" role="group" aria-label="Housing"></div>
       <div class="alerts"></div>
       <p class="fine num"></p>`,
    );
    this.treasury = this.card.querySelector('.treasury-value')!;
    this.treasuryTween = new Tween((v) => setText(this.treasury, money(v)), 650);
    this.treasuryTint = new Tint(this.card.querySelector('.treasury')!);
    this.treasuryTween.onMove = (d) => performance.now() - this.spentAt > 400 && this.treasuryTint.show(d > 0 ? 'up' : 'down');
    this.net = this.card.querySelector('.net')!;
    this.mood = this.card.querySelector('.mood')!;
    this.ring = this.card.querySelector('.ring-fill')!;
    this.ringValue = this.card.querySelector('.ring-value')!;
    this.ringWrap = this.card.querySelector('.ring')!;
    this.ringTween = new Tween((v) => {
      setText(this.ringValue, String(Math.round(v)));
      this.ring.style.strokeDashoffset = String(RING * (1 - v / 100));
    }, 700);
    const ringTint = new Tint(this.ringWrap);
    this.ringTween.onMove = (d) => ringTint.show(d > 0 ? 'up' : 'down');
    const part = (k: string) => this.card.querySelector<HTMLElement>(`[data-part=${k}]`)!;
    this.parts = { housing: part('housing'), upkeep: part('upkeep'), amenities: part('amenities'), momentum: part('momentum') };
    this.housing = this.card.querySelector('.housing')!;
    // Built once, so the meter's fill can slide to each new value rather than being redrawn.
    this.housing.innerHTML = `<div class="housing-row"><span class="housing-label">${ICON.home}Housing</span><span class="housing-status"></span></div>
       <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-label="Users housed"><i class="meter-housed"></i></div>
       <div class="housing-foot num"></div>`;
    this.housingStatus = this.housing.querySelector('.housing-status')!;
    this.housingFoot = this.housing.querySelector('.housing-foot')!;
    this.meter = this.housing.querySelector('.meter')!;
    this.alerts = this.card.querySelector('.alerts')!;
    this.fine = this.card.querySelector('.fine')!;
    this.floaters = this.card.querySelector('.floaters')!;
    side.append(this.card);
    this.miniTreasury = side.querySelector('[data-mini=treasury]');
    this.miniSat = side.querySelector('[data-mini=sat]');
    this.miniTreasuryTween = new Tween((v) => this.miniTreasury && setText(this.miniTreasury, money(v)));
    if (this.miniTreasury) {
      const tint = new Tint(this.miniTreasury);
      this.miniTreasuryTween.onMove = (d) => performance.now() - this.spentAt > 400 && tint.show(d > 0 ? 'up' : 'down');
    }
    if (this.miniSat) {
      this.miniSat.innerHTML = `<svg viewBox="0 0 50 50" aria-hidden="true"><circle class="ring-track" cx="25" cy="25" r="21"/><circle class="ring-fill" cx="25" cy="25" r="21" stroke-dasharray="${RING.toFixed(2)}" stroke-dashoffset="${RING.toFixed(2)}"/></svg><b class="num"></b>`;
      this.miniSatFill = this.miniSat.querySelector('.ring-fill');
      this.miniSatValue = this.miniSat.querySelector('b');
    }

    // ── Toolbar and map ────────────────────────────────────────────────
    const home = el('button', { class: 'btn ghost', type: 'button', 'aria-label': 'Your home (H)', 'data-tip': 'Your home: the ladder from hacker house to the moon (H)' }, `${ICON.home}<span class="label">Your home</span>`);
    home.addEventListener('click', () => this.openHome());
    this.buildBtn = el('button', { class: 'btn primary build', type: 'button', 'aria-label': 'Build (B)', 'data-tip': 'Spend your treasury (B)' }, `${ICON.build}<span class="label">Build</span>`);
    this.buildBtn.addEventListener('click', () => this.toggleBuild());
    tools.append(el('span', { class: 'tool-sep', 'aria-hidden': 'true' }), home, this.buildBtn);

    const map = root.querySelector('.mapctl') ?? root;
    const zoomIn = el('button', { class: 'btn ghost icon-only', type: 'button', 'aria-label': 'Zoom in (+)', 'data-tip': 'Zoom in (+)' }, ICON.plus);
    const zoomOut = el('button', { class: 'btn ghost icon-only', type: 'button', 'aria-label': 'Zoom out (−)', 'data-tip': 'Zoom out (−)' }, ICON.minus);
    zoomIn.addEventListener('click', () => h.onZoom(1.4));
    zoomOut.addEventListener('click', () => h.onZoom(1 / 1.4));
    map.prepend(zoomIn, zoomOut, el('span', { class: 'map-sep', 'aria-hidden': 'true' }));

    // Places: one click to every corner of the world (the airport and your island are far out).
    this.placesBtn = el('button', { class: 'btn ghost icon-only', type: 'button', 'aria-label': 'Go to a place (G)', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-tip': 'Go to a place (G)' }, ICON.pin);
    this.placesBtn.addEventListener('click', () => this.togglePlaces());
    map.append(this.placesBtn);
    this.placesMenu = el('div', { class: 'places-menu card', role: 'menu', 'aria-label': 'Places', hidden: '' });
    this.placesMenu.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-place]');
      if (!btn) return;
      this.togglePlaces(false);
      h.onFocus(btn.dataset.place as Place);
    });
    this.placesMenu.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.togglePlaces(false);
        this.placesBtn.focus();
      }
    });
    document.addEventListener('pointerdown', (e) => {
      const t = e.target as Node;
      if (!this.placesMenu.hidden && !this.placesMenu.contains(t) && !this.placesBtn.contains(t)) this.togglePlaces(false);
    });
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'g' || e.key === 'G') this.togglePlaces();
    });
    root.append(this.placesMenu);

    // ── Build menu ─────────────────────────────────────────────────────
    this.drawer = el('aside', { class: 'drawer card', role: 'dialog', 'aria-label': 'Build', hidden: '' });
    this.drawer.innerHTML = `
      <span class="sheet-handle" aria-hidden="true"></span>
      <header class="drawer-head">
        <div>
          <h2 class="drawer-title">Build</h2>
          <p class="drawer-sub num"></p>
        </div>
        <button class="btn ghost icon-only" data-act="close" aria-label="Close (Esc)" data-tip="Close (Esc)">${ICON.close}</button>
      </header>
      <nav class="tabs" role="tablist" aria-label="Categories">${TABS.map((t) => `<button class="tab" role="tab" type="button" data-tab="${t.id}" aria-selected="false" aria-controls="build-items"><span>${t.label}</span><small class="num"></small></button>`).join('')}</nav>
      <div class="items" id="build-items" role="list" aria-label="Things to build"></div>
      <p class="drawer-foot">${ICON.coin}<span>Every dollar here came from real revenue.</span></p>`;
    this.drawerTitle = this.drawer.querySelector('.drawer-title')!;
    this.drawerSub = this.drawer.querySelector('.drawer-sub')!;
    this.tabsEl = this.drawer.querySelector('.tabs')!;
    this.grid = this.drawer.querySelector('.items')!;
    this.drawer.addEventListener('click', (e) => this.onDrawerClick(e));
    this.tabsEl.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const i = TABS.findIndex((t) => t.id === this.tab);
      const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!;
      this.setTab(next.id);
      this.tabsEl.querySelector<HTMLElement>(`[data-tab=${next.id}]`)!.focus();
    });
    for (const item of CATALOG) this.grid.append(this.makeCard(item));
    root.append(this.drawer);

    // ── Your home ──────────────────────────────────────────────────────
    this.homeDialog = el('dialog', { class: 'dialog home-dialog', 'aria-labelledby': 'home-title', tabindex: '-1', autofocus: '' });
    // The body re-renders as the city changes; the live region stays put so screen readers hear it.
    this.homeBody = el('div', { class: 'dialog-body' });
    this.homeLive = el('p', { class: 'sr-only', role: 'status' });
    this.homeDialog.append(this.homeBody, this.homeLive);
    this.homeDialog.addEventListener('click', (e) => {
      if (e.target === this.homeDialog) return this.homeDialog.close();
      const btn = (e.target as HTMLElement).closest('button');
      if (!btn) return;
      if (btn.getAttribute('aria-disabled') === 'true') return;
      if (btn.dataset.ask) {
        // Renovations cost real treasury: ask once more before spending it.
        this.confirmPick = btn.dataset.ask;
        this.focusAfter = `confirm:${btn.dataset.ask}`;
        return this.renderHome();
      }
      if (btn.dataset.act === 'keep') {
        this.focusAfter = btn.dataset.key?.replace(/^keep:/, 'pick:');
        this.confirmPick = null;
        return this.renderHome();
      }
      if (btn.dataset.pick) {
        const [tier, choice] = btn.dataset.pick.split(':');
        this.confirmPick = null;
        h.onPickHome(Number(tier), choice!);
        // Rejected (nothing changed): show the buttons again rather than a stale confirm.
        this.renderHome();
      }
      if (btn.dataset.act === 'moon') {
        this.homeDialog.close();
        h.onFlyToMoon();
      }
      if (btn.dataset.act === 'heli') {
        this.homeDialog.close();
        h.onFlyHelicopter();
      }
      if (btn.dataset.act === 'rocket') {
        this.homeDialog.close();
        this.openBuild('vehicles');
      }
      if (btn.dataset.act === 'close') this.homeDialog.close();
      if (btn.dataset.focus) {
        this.homeDialog.close();
        h.onFocus(btn.dataset.focus as never);
      }
    });
    returnFocusOnClose(this.homeDialog, () => {
      this.confirmPick = null;
      this.homeStatus = '';
      setText(this.homeLive, '');
    });
    document.body.append(this.homeDialog);

    // ── Placement ──────────────────────────────────────────────────────
    this.banner = el('div', { class: 'placing card', role: 'status', hidden: '' });
    this.banner.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) h.onCancelPlacement();
    });
    root.append(this.banner);

    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement | null;
      if ((t instanceof HTMLInputElement && t.type !== 'range') || t instanceof HTMLTextAreaElement) return;
      if (document.querySelector('dialog[open]')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'b' || e.key === 'B') this.toggleBuild();
      if (e.key === 'h' || e.key === 'H') this.openHome();
      if (e.key === 'Escape') {
        if (!this.banner.hidden) h.onCancelPlacement();
        else this.closeBuild();
      }
      if (e.key === '+' || e.key === '=') h.onZoom(1.4);
      if (e.key === '-' || e.key === '_') h.onZoom(1 / 1.4);
    });
  }

  private placesBtn!: HTMLButtonElement;
  private placesMenu!: HTMLElement;

  /** Opens or closes the places menu, listing what's open in this city right now. */
  /** The helicopter landed somewhere: the home dialog offers the flight back. */
  setHelicopter(at: 'airport' | 'island') {
    this.heliAt = at;
    if (this.homeDialog.open) this.renderHome();
  }

  togglePlaces(open = this.placesMenu.hidden) {
    if (open) {
      const g = this.state;
      const places = PLACES.filter((p) => !p.region || g?.regions[p.region]);
      this.placesMenu.innerHTML = places
        .map((p) => `<button class="place" type="button" role="menuitem" data-place="${p.id}">${ICON[p.icon]}<span><b>${p.name}</b><small>${p.hint}</small></span></button>`)
        .join('');
    }
    this.placesMenu.hidden = !open;
    this.placesBtn.setAttribute('aria-expanded', String(open));
    if (open) this.placesMenu.querySelector<HTMLButtonElement>('.place')?.focus();
  }

  setState(g: GameState) {
    const prev = this.state;
    if (!prev) {
      // Once the city has settled, quietly photograph everything for the menus.
      window.setTimeout(() => prewarmThumbnails([...CATALOG.map((i) => `item:${i.id}`), ...HOME_TIERS.flatMap((t) => t.options.map((o) => `home:${o.id}`))]), 5000);
    }
    this.state = g;
    this.ownsRocket = g.owned.some((o) => o.item === 'rocket');
    // A purchase: show what it cost, floating off the treasury.
    if (prev && this.lastOwned >= 0 && g.owned.length > this.lastOwned && g.t === prev.t) {
      const spent = g.owned.slice(this.lastOwned).reduce((s, o) => s + (ITEMS.get(o.item)?.price ?? 0), 0);
      if (spent > 0) {
        this.floater(`−${money(spent)}`);
        this.spentAt = performance.now();
        this.treasuryTint.show('spend', true);
      }
    }
    this.lastOwned = g.owned.length;
    if (prev) this.notePick(prev, g);
    this.renderCard(prev);
    if (!this.drawer.hidden) this.refreshDrawer();
    if (this.homeDialog.open) this.renderHome();
  }

  // ─── City card ──────────────────────────────────────────────────────────

  private renderCard(prev: GameState | null) {
    const g = this.state!;
    const glide = !!prev && Math.abs(g.t - prev.t) <= 4 * 86_400_000 && !this.root.classList.contains('is-scrubbing');
    const sat = g.satisfaction;
    const mood = sat.score >= 80 ? 'Thriving' : sat.score >= 60 ? 'Content' : sat.score >= 40 ? 'Uneasy' : 'Unhappy';
    setText(this.mood, mood);
    this.mood.dataset.tone = sat.score >= 60 ? 'good' : sat.score >= 40 ? 'warn' : 'bad';

    this.treasuryTween.set(g.treasury, glide);
    this.miniTreasuryTween.set(g.treasury, glide);
    const net = g.incomePerDay - g.upkeepPerDay;
    setText(this.net, `${net >= 0 ? '+' : '−'}${money(Math.abs(net))}/day`);
    this.net.dataset.dir = net > 0 ? 'up' : net < 0 ? 'down' : 'flat';
    this.net.dataset.tipHtml = `<b>Net per day</b><span>Income ${money(g.incomePerDay)} − upkeep ${money(g.upkeepPerDay)}. Income is your real MRR × $10,000, spread over the month.</span>`;

    this.ringTween.set(sat.score, glide);
    this.ringWrap.dataset.level = level(sat.score, 60, 40);
    this.ringWrap.setAttribute('aria-label', `Satisfaction ${sat.score} out of 100, ${mood}. Housing ${Math.round(sat.housing * 100)}%, upkeep ${Math.round(sat.upkeep * 100)}%, amenities ${Math.round(sat.amenities * 100)}%, momentum ${Math.round(sat.momentum * 100)}%.`);
    this.ringWrap.dataset.tipHtml = `<b>Satisfaction ${sat.score}/100 · ${mood}</b><span>Housing counts 35%, upkeep 25%, amenities 20% and MRR momentum 20%. Only real growth raises it.</span>`;
    for (const [k, v] of Object.entries({ housing: sat.housing, upkeep: sat.upkeep, amenities: sat.amenities, momentum: sat.momentum })) {
      const p = this.parts[k as keyof typeof this.parts];
      p.style.setProperty('--v', `${Math.round(v * 100)}%`);
      p.dataset.level = level(v, 0.75, 0.45);
    }
    if (this.miniSat) {
      this.miniSatFill!.style.strokeDashoffset = (RING * (1 - sat.score / 100)).toFixed(2);
      setText(this.miniSatValue!, String(sat.score));
      this.miniSat.dataset.level = level(sat.score, 60, 40);
    }

    // Housing: housed vs unhoused, the $0.20 rule on hover.
    const pop = g.population;
    const capacity = Math.max(FREE_HOUSED, Math.floor(g.mrr / MRR_PER_USER));
    const housedPct = pop ? (g.housed / pop) * 100 : 100;
    const need = Math.ceil(g.housingNeed);
    const status =
      g.unhoused > 0
        ? `<b class="bad num">${g.unhoused.toLocaleString('en-US')}</b> without a home`
        : pop
          ? `All <b class="num">${pop.toLocaleString('en-US')}</b> housed`
          : 'Waiting for residents';
    const short = need - Math.floor(g.mrr);
    const headroom = g.unhoused > 0 ? (short > 0 ? `Need $${short.toLocaleString('en-US')} more MRR` : 'Homes failing: upkeep is short') : `Room for ${compact(Math.max(0, capacity - pop))} more`;
    setHtml(this.housingStatus, status);
    setHtml(this.housingFoot, `<span>${Math.round(housedPct)}% housed</span><span>${headroom}</span>`);
    // The housed fill slides; whatever it doesn't cover is the striped unhoused share.
    this.meter.style.setProperty('--v', `${housedPct.toFixed(2)}%`);
    this.meter.toggleAttribute('data-short', g.unhoused > 0);
    this.meter.setAttribute('aria-valuenow', String(Math.round(housedPct)));
    this.housing.dataset.state = g.unhoused > 0 ? 'bad' : 'good';
    this.housing.dataset.tipHtml = `<b>$0.20 of MRR houses one user</b><span>${pop.toLocaleString('en-US')} users need $${need.toLocaleString('en-US')} MRR; you're at $${Math.round(g.mrr).toLocaleString('en-US')}. The first ${FREE_HOUSED} are on the house. Short of it, people end up in tents and the city runs down.</span>`;

    // Alerts: homelessness and decay, as one tasteful stack.
    const decay = decayOf(g.maintenance);
    const active = DECAY_STAGES.filter((s) => decay[s.key]);
    const worst = active.at(-1);
    let alerts = '';
    if (worst) {
      alerts += `<div class="alert" data-tone="${g.maintenance < 60 ? 'bad' : 'warn'}">
        <span class="tile">${ICON[worst.icon]}</span>
        <div><b>${worst.title}</b><span>Upkeep ${Math.round(g.maintenance)}% covered.<em class="aside"> Repairs start as soon as it's paid.</em></span>
        <ol class="pips" aria-label="Decay stages">${DECAY_STAGES.map((s) => `<li class="${decay[s.key] ? 'on' : ''}" data-tip="${s.title} below ${s.at}% upkeep">${ICON[s.icon]}<span class="sr-only">${decay[s.key] ? '' : 'Not yet: '}${s.title} below ${s.at}% upkeep</span></li>`).join('')}</ol></div>
      </div>`;
    }
    if (g.unhoused > 0) {
      const why = short > 0 ? `${pop.toLocaleString('en-US')} users need $${need.toLocaleString('en-US')} MRR; you're at $${Math.round(g.mrr).toLocaleString('en-US')}.` : 'Housing fails when upkeep drops below 35%.';
      alerts += `<div class="alert" data-tone="bad"><span class="tile">${ICON.tent}</span><div><b>${g.unhoused.toLocaleString('en-US')} people in tents</b><span>${why}</span></div></div>`;
    }
    setHtml(this.alerts, alerts);
    this.card.classList.toggle('alarmed', !!alerts);
    // Non-breaking spaces keep each separator at the end of its line and "HQ: Tower" in one piece.
    setText(this.fine, `Income ${money(g.incomePerDay)}/day\u00a0· Upkeep ${money(g.upkeepPerDay)}/day\u00a0· HQ:\u00a0${HQ_LEVEL_NAMES[g.hqLevel]}`);
    this.buildBtn.classList.toggle('has-new', CATALOG.some((i) => !canBuy(g, i)));
  }

  private floater(text: string) {
    const f = el('span', { class: 'floater num' });
    f.textContent = text;
    this.floaters.append(f);
    window.setTimeout(() => f.remove(), 1800);
  }

  // ─── Build menu ─────────────────────────────────────────────────────────

  private makeCard(i: Item): HTMLElement {
    const root = el('article', { class: 'item', role: 'listitem', 'data-id': i.id, 'data-cat': i.category });
    root.innerHTML = `
      <div class="thumb">
        <span class="thumb-fallback">${ICON[CATEGORY_ICON[i.category]]}</span>
        <img alt="" draggable="false">
        <span class="where">${where(i)}</span>
      </div>
      <div class="item-body">
        <div class="item-title"><b>${escape(i.name)}</b><span class="price num">${money(i.price)}</span></div>
        <p class="blurb">${escape(i.blurb)}</p>
        <div class="item-meta num">${i.amenity ? `<span class="happy">${ICON.heart}+${i.amenity}</span>` : ''}<span>${money(i.price * i.upkeep)}/mo upkeep</span></div>
        <div class="item-action"></div>
      </div>`;
    this.cards.set(i.id, { root, action: root.querySelector('.item-action')!, sig: '' });
    return root;
  }

  toggleBuild(plot?: string) {
    if (!this.drawer.hidden && !this.drawer.classList.contains('closing') && plot === this.plot) return this.closeBuild();
    this.plot = plot;
    this.openBuild();
  }

  private openBuild(tab?: Tab) {
    if (tab) this.tab = tab;
    else if (this.plot && (this.tab === 'vehicles' || this.tab === 'hq')) this.tab = 'all';
    const closing = this.drawer.classList.contains('closing');
    const wasHidden = this.drawer.hidden || closing;
    if (wasHidden && !closing) this.drawerReturn = document.activeElement as HTMLElement | null;
    clearTimeout(this.drawerTimer);
    this.drawer.classList.remove('closing');
    this.drawer.inert = false;
    this.drawer.hidden = false;
    this.buildBtn.classList.add('on');
    this.buildBtn.setAttribute('aria-expanded', 'true');
    this.refreshDrawer();
    if (wasHidden) {
      this.grid.scrollTop = 0;
      // Keyboard users land in the menu (on the selected category), not back at the top of the page.
      this.tabsEl.querySelector<HTMLElement>('[aria-selected=true]')?.focus({ preventScroll: true });
      for (const c of this.cards.values()) {
        const img = c.root.querySelector('img')!;
        if (!img.dataset.thumb && !img.src) lazyThumbnail(img, `item:${c.root.dataset.id}`);
      }
    }
  }

  closeBuild() {
    if (this.drawer.hidden || this.drawer.classList.contains('closing')) return;
    const hadFocus = this.drawer.contains(document.activeElement);
    // It slides back toward its edge, then hides; `inert` keeps it out of reach meanwhile.
    this.drawer.classList.add('closing');
    this.drawer.inert = true;
    this.drawerTimer = window.setTimeout(
      () => {
        this.drawer.classList.remove('closing');
        this.drawer.inert = false;
        this.drawer.hidden = true;
      },
      reducedMotion() ? 0 : 200,
    );
    if (hadFocus) (this.drawerReturn?.isConnected && this.drawerReturn !== document.body ? this.drawerReturn : this.buildBtn).focus({ preventScroll: true });
    this.drawerReturn = null;
    this.plot = undefined;
    this.buildBtn.classList.remove('on');
    this.buildBtn.setAttribute('aria-expanded', 'false');
  }

  private setTab(tab: Tab) {
    this.tab = tab;
    this.refreshDrawer();
    this.grid.scrollTop = 0;
  }

  private refreshDrawer() {
    const g = this.state;
    if (!g) return;
    setText(this.drawerTitle, this.plot ? 'Build on this plot' : 'Build');
    setHtml(this.drawerSub, `<b>${money(g.treasury)}</b> to spend · earning ${money(g.incomePerDay)}/day`);
    const visible = (i: Item) => !this.plot || i.placement.kind === 'plot';
    for (const t of TABS) {
      const btn = this.tabsEl.querySelector<HTMLElement>(`[data-tab=${t.id}]`)!;
      const items = CATALOG.filter((i) => (t.id === 'all' || i.category === t.id) && visible(i));
      const ready = items.filter((i) => !canBuy(g, i)).length;
      btn.setAttribute('aria-selected', String(t.id === this.tab));
      btn.tabIndex = t.id === this.tab ? 0 : -1;
      btn.hidden = !items.length;
      setText(btn.querySelector('small')!, ready ? String(ready) : '');
    }
    const net = g.incomePerDay - g.upkeepPerDay;
    const order = [...CATALOG].sort((a, b) => a.unlock - b.unlock || a.price - b.price);
    order.forEach((i, k) => {
      const c = this.cards.get(i.id)!;
      const show = visible(i) && (this.tab === 'all' || i.category === this.tab);
      c.root.hidden = !show;
      c.root.style.order = String(k);
      if (!show) return;
      const why = canBuy(g, i);
      const locked = g.mrr < i.unlock;
      const state = !why ? 'buy' : locked ? 'locked' : why.startsWith('Need') ? 'need' : 'blocked';
      let html: string;
      let sig: string;
      if (state === 'buy') {
        sig = `buy|${this.plot ?? ''}`;
        const label = this.plot || i.placement.kind !== 'plot' ? 'Buy' : 'Buy & place';
        html = `<button class="btn primary buy" type="button" data-buy="${i.id}" aria-label="${label} ${escape(i.name)}, ${money(i.price)}">${label}</button>`;
      } else if (state === 'locked') {
        const pct = Math.min(100, (g.mrr / i.unlock) * 100);
        sig = `locked|${Math.round(pct)}`;
        html = `<div class="progress" data-tone="lock"><span class="progress-label">${ICON.lock}Unlocks at ${shortMrr(i.unlock)} MRR</span><i><b style="width:${pct.toFixed(1)}%"></b></i></div>`;
      } else if (state === 'need') {
        const pct = Math.min(100, (g.treasury / i.price) * 100);
        const days = net > 0 ? Math.ceil((i.price - g.treasury) / net) : Infinity;
        const eta = Number.isFinite(days) ? (days <= 1 ? 'tomorrow' : days < 60 ? `in ~${days} days` : days < 730 ? `in ~${Math.round(days / 30)} months` : '') : '';
        sig = `need|${Math.round(pct)}|${eta}`;
        html = `<div class="progress" data-tone="save"><span class="progress-label"><span class="num">${escape(why!)}</span>${eta ? `<small>${eta}</small>` : ''}</span><i><b style="width:${pct.toFixed(1)}%"></b></i></div>`;
      } else {
        sig = `blocked|${why}`;
        html = `<div class="blocked">${why === 'Already built' ? ICON.check : ICON.info}<span>${escape(why!)}</span></div>`;
      }
      c.root.dataset.state = state;
      if (c.sig !== sig) {
        c.sig = sig;
        c.action.innerHTML = html;
      }
    });
  }

  private onDrawerClick(e: MouseEvent) {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;
    if (btn.dataset.act === 'close') return this.closeBuild();
    if (btn.dataset.tab) return this.setTab(btn.dataset.tab as Tab);
    if (btn.dataset.buy) {
      const item = ITEMS.get(btn.dataset.buy)!;
      const plot = this.plot;
      this.closeBuild();
      this.h.onBuild(item, plot);
    }
  }

  setPlacing(item: Item | null) {
    this.banner.hidden = !item;
    document.documentElement.classList.toggle('placing-mode', !!item);
    if (!item) return;
    const block = item.placement.kind === 'plot' && item.placement.size === 4;
    this.banner.innerHTML = `
      <span class="placing-thumb thumb"><img alt=""></span>
      <span class="placing-text"><small>Placing · ${money(item.price)}</small><span>Pick ${block ? 'an empty block' : 'a glowing plot'} for your <b>${escape(item.name)}</b></span></span>
      <kbd>Esc</kbd>
      <button class="btn ghost" type="button">Cancel</button>`;
    lazyThumbnail(this.banner.querySelector('img')!, `item:${item.id}`);
  }

  // ─── Your home ──────────────────────────────────────────────────────────

  openHome() {
    this.homeSig = '';
    this.confirmPick = null;
    this.renderHome();
    if (!this.homeDialog.open) {
      showModal(this.homeDialog);
      const current = this.homeDialog.querySelector<HTMLElement>('.rung.current');
      current?.scrollIntoView({ block: 'center' });
    }
  }

  /** A pick the founder just made: say what it cost, in the dialog and on the treasury. */
  private notePick(prev: GameState, g: GameState) {
    if (g.t !== prev.t) return;
    for (const i of g.home.explicit) {
      if (prev.home.picks[i] === g.home.picks[i] && prev.home.explicit.includes(i)) continue;
      const t = HOME_TIERS[i]!;
      const name = t.options.find((o) => o.id === g.home.picks[i])?.name ?? '';
      const fee = prev.home.explicit.includes(i) ? t.value * SWAP_FEE : 0;
      if (fee) this.floater(`−${money(fee)}`);
      this.homeStatus = fee ? `Renovated into the ${name} for ${money(fee)}.` : `You picked the ${name}. Changing it later costs ${money(t.value * SWAP_FEE)}.`;
      this.focusAfter = `opt:${i}:${g.home.picks[i]}`;
      setText(this.homeLive, this.homeStatus);
    }
  }

  private renderHome() {
    const g = this.state;
    if (!g) return;
    const html = this.homeHtml(g);
    if (html === this.homeSig) return;
    this.homeSig = html;
    const ladder = this.homeDialog.querySelector('.ladder');
    const scroll = ladder?.scrollTop ?? 0;
    // Re-rendering replaces every button: put focus back on the same one (or where a pick landed).
    const active = document.activeElement as HTMLElement | null;
    const key = this.focusAfter ?? (active && this.homeDialog.contains(active) ? active.dataset.key : undefined);
    this.focusAfter = undefined;
    this.homeBody.innerHTML = html;
    this.homeDialog.querySelectorAll<HTMLImageElement>('img[data-home]').forEach((img) => lazyThumbnail(img, `home:${img.dataset.home}`));
    const fresh = this.homeDialog.querySelector('.ladder');
    if (fresh && scroll) fresh.scrollTop = scroll;
    if (key && this.homeDialog.open) this.homeDialog.querySelector<HTMLElement>(`[data-key="${key}"]`)?.focus({ preventScroll: true });
  }

  private homeHtml(g: GameState): string {

    const tier = g.home.tier;
    const next = HOME_TIERS[tier + 1];
    const cur = HOME_TIERS[tier]!;
    const curName = cur.options.find((o) => o.id === g.home.option)?.name ?? cur.options[0]!.name;
    let nextHtml = '';
    if (next) {
      const from = cur.mrr;
      const pct = Math.max(0, Math.min(100, ((g.peakMrr - from) / (next.mrr - from)) * 100));
      nextHtml = `<div class="home-next">
        <div><small>Next move</small><b>${escape(next.options.length > 1 ? `${next.options[0]!.name} + ${next.options.length - 1} more to choose from` : next.options[0]!.name)}</b><span class="num">at ${shortMrr(next.mrr)} MRR · peak so far $${Math.round(g.peakMrr).toLocaleString('en-US')}</span></div>
        <div class="progress" data-tone="brand"><i><b style="width:${pct.toFixed(1)}%"></b></i><span class="num">${Math.round(pct)}%</span></div>
      </div>`;
    } else {
      nextHtml = `<div class="home-next done"><div><small>Top of the ladder</small><b>You live on the moon.</b><span>There is no next move. Enjoy the view.</span></div></div>`;
    }

    const rows = HOME_TIERS.map((t, i) => {
      const reached = tier >= i;
      const current = tier === i;
      const picked = g.home.picks[i];
      const many = t.options.length > 1;
      // The first pick is free; after that, changing your mind is a renovation (see economy.ts).
      const explicit = g.home.explicit.includes(i);
      const fee = t.value * SWAP_FEE;
      const afford = g.treasury >= fee;
      const opts = t.options
        .map((o) => {
          const chosen = picked === o.id && reached;
          const key = `${i}:${o.id}`;
          const canPick = reached && many && !chosen;
          let action = '';
          if (canPick && !explicit) {
            action = `<button class="btn primary sm" type="button" data-pick="${key}" data-key="pick:${key}" aria-describedby="fee-${i}" aria-label="Choose the ${escape(o.name)}, free">Choose</button>`;
          } else if (canPick && this.confirmPick === key) {
            action = `<span class="confirm"><button class="btn primary sm" type="button" data-pick="${key}" data-key="confirm:${key}" aria-describedby="fee-${i}">Spend ${money(fee)} to renovate</button><button class="btn ghost sm" type="button" data-act="keep" data-key="keep:${key}" aria-label="Cancel, keep the ${escape(t.options.find((x) => x.id === picked)?.name ?? 'house you have')}">Cancel</button></span>`;
          } else if (canPick) {
            action = `<button class="btn ghost sm renovate" type="button" data-ask="${key}" data-key="pick:${key}" aria-describedby="fee-${i}" aria-label="Renovate into the ${escape(o.name)} for ${money(fee)}"${afford ? '' : ' aria-disabled="true"'}>${ICON.wrench}<span>Renovate · ${money(fee)}</span></button>`;
          } else if (chosen && many) {
            action = `<span class="chosen-tag">${ICON.check}${explicit ? 'Your pick' : 'Moved in here'}</span>`;
          }
          return `<div class="opt ${chosen ? 'chosen' : ''}"${chosen && many ? ` tabindex="-1" data-key="opt:${key}"` : ''}>
            <span class="thumb"><span class="thumb-fallback">${ICON.home}</span><img alt="" data-home="${o.id}"></span>
            <div class="opt-body"><b>${escape(o.name)}</b><span>${escape(o.blurb)}</span>${action}</div>
          </div>`;
        })
        .join('');
      let feeNote = '';
      if (many && reached) {
        const value = `25% of the house's ${money(t.value)} value`;
        feeNote = !explicit
          ? `<p class="rung-fee" id="fee-${i}">${ICON.info}<span>Your first pick is free. After that, changing your mind is a renovation: ${value}, so <b class="num">${money(fee)}</b> from your treasury.</span></p>`
          : afford
            ? `<p class="rung-fee" id="fee-${i}">${ICON.wrench}<span>Changing your pick is a renovation: <b class="num">${money(fee)}</b>, ${value}. Paid from your treasury, never real money.</span></p>`
            : `<p class="rung-fee" id="fee-${i}" data-tone="short">${ICON.lock}<span>A renovation costs <b class="num">${money(fee)}</b> (${value}). Your treasury has ${money(g.treasury)}, so you're <b class="num">${money(fee - g.treasury)}</b> short.</span></p>`;
      }
      let extra = '';
      if (t.where === 'moon') {
        extra = reached
          ? this.ownsRocket
            ? `<button class="btn primary" type="button" data-act="moon" data-key="moon">${ICON.rocket}<span class="label">Fly to the moon</span></button>`
            : `<button class="btn ghost" type="button" data-act="rocket" data-key="rocket">${ICON.rocket}<span class="label">Buy a rocket to get there · ${money(ITEMS.get('rocket')!.price)}</span></button>`
          : '';
      }
      if (t.yacht && reached) extra = `<span class="perk">${ICON.ship}Came with a superyacht</span>`;
      if (t.where === 'hills' && reached && i === 3) extra = `<button class="btn ghost sm" type="button" data-focus="hills" data-key="focus:hills">${ICON.pin}<span class="label">Show the Hills</span></button>`;
      if (t.where === 'island' && reached) {
        extra += `<button class="btn ghost sm" type="button" data-focus="island" data-key="focus:island">${ICON.pin}<span class="label">Show my island</span></button>`;
        extra += `<button class="btn ghost sm" type="button" data-act="heli" data-key="heli">${ICON.heli}<span class="label">${this.heliAt === 'airport' ? 'Fly there from the airport' : 'Fly back to the airport'}</span></button>`;
      }
      const node = current ? ICON.home : reached ? ICON.check : ICON.lock;
      const region = t.where === 'hills' ? REGIONS.hills : t.where === 'island' ? REGIONS.island : t.where === 'moon' ? REGIONS.launchpad : null;
      return `<li class="rung ${current ? 'current' : reached ? 'past' : 'future'}">
        <span class="node">${node}</span>
        <div class="rung-body">
          <div class="rung-head">
            <span class="rung-mrr num">${t.mrr === 0 ? 'Day one' : `${shortMrr(t.mrr)} MRR`}</span>
            <span class="where-tag">${WHERE_LABEL[t.where]}</span>
            ${current ? '<span class="here">You live here</span>' : reached ? '<span class="lived">Lived here</span>' : ''}
            ${t.options.length > 1 ? `<span class="choice">Pick ${t.options.length === 2 ? 'one of two' : `one of ${t.options.length}`}</span>` : ''}
          </div>
          <div class="opts" data-count="${t.options.length}">${opts}</div>
          ${feeNote}
          ${extra ? `<div class="rung-extra">${extra}</div>` : ''}
          ${!reached && region && region.gate === t.mrr ? `<p class="rung-note">${escape(region.name)} opens at the same time.</p>` : ''}
        </div>
      </li>`;
    }).join('');

    return `
        <header class="dialog-head">
          <span class="tile tone-brand">${ICON.home}</span>
          <div><h2 id="home-title">Your home</h2><p>You live in your <b>${escape(curName)}</b>. Each MRR milestone moves you up, all the way to the moon at ${shortMrr(HOME_TIERS[HOME_TIERS.length - 1]!.mrr)} MRR; peak MRR counts, so a bad month never evicts you.</p></div>
          <button class="btn ghost icon-only close" type="button" data-act="close" data-key="close" aria-label="Close">${ICON.close}</button>
        </header>
        ${nextHtml}
        ${this.homeStatus ? `<p class="home-status">${ICON.check}<span>${escape(this.homeStatus)}</span></p>` : ''}
        <ol class="ladder" aria-label="Your house, one rung per MRR milestone">${rows}</ol>`;
  }
}
