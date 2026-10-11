import { el, escape } from './hud.ts';
import { CATALOG, HOME_TIERS, HQ_LEVEL_NAMES, ITEMS, SWAP_FEE, type Category, type Item } from '../game/catalog.ts';
import { canBuy, decayOf, money, type GameState } from '../game/economy.ts';

export interface GameHandlers {
  onBuild(item: Item, plot?: string): void;
  onPickHome(tier: number, choice: string): void;
  onFlyToMoon(): void;
  onZoom(factor: number): void;
  onCancelPlacement(): void;
  onFocus(what: 'airport' | 'marina' | 'pier' | 'hills' | 'island' | 'launchpad'): void;
}

const ICONS = {
  build: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M2.5 13.5V7l4-3 4 3v6.5z"/><path d="M10.5 9h3v4.5h-3M5.2 13.5v-3h2.6v3"/></svg>',
  home: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M2.5 7.5 8 3l5.5 4.5V13h-11z"/><path d="M6.5 13V9.5h3V13"/></svg>',
  plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg>',
  minus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3.5 8h9"/></svg>',
};

const TABS: { id: Category | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'business', label: 'Business' },
  { id: 'civic', label: 'Civic' },
  { id: 'fun', label: 'Fun' },
  { id: 'vehicles', label: 'Vehicles' },
  { id: 'hq', label: 'HQ' },
];

const SITE_LABEL = { pier: 'On the pier', marina: 'At the marina', airport: 'At your airport', launchpad: 'On the launch site' } as const;

/**
 * The game layer of the HUD: treasury and satisfaction, the build menu,
 * your home, and placement mode.
 */
export class GameUI {
  private panel: HTMLElement;
  private drawer: HTMLElement;
  private homeDialog: HTMLDialogElement;
  private banner: HTMLElement;
  private state: GameState | null = null;
  private tab: Category | 'all' = 'all';
  private plot: string | undefined;
  private h: GameHandlers;
  private ownsRocket = false;

  constructor(root: HTMLElement, side: HTMLElement, tools: HTMLElement, h: GameHandlers) {
    this.h = h;
    this.panel = el('div', { class: 'city panel' });
    side.append(this.panel);

    const build = el('button', { class: 'btn build', type: 'button', title: 'Build (B)' }, `${ICONS.build}<span class="label">Build</span>`);
    build.addEventListener('click', () => this.toggleBuild());
    const home = el('button', { class: 'btn', type: 'button', title: 'Your home' }, `${ICONS.home}<span class="label">Your home</span>`);
    home.addEventListener('click', () => this.openHome());
    const zoomOut = el('button', { class: 'btn icon', type: 'button', title: 'Zoom out (-)', 'aria-label': 'Zoom out' }, ICONS.minus);
    const zoomIn = el('button', { class: 'btn icon', type: 'button', title: 'Zoom in (+)', 'aria-label': 'Zoom in' }, ICONS.plus);
    zoomOut.addEventListener('click', () => h.onZoom(1 / 1.4));
    zoomIn.addEventListener('click', () => h.onZoom(1.4));
    const zoom = el('div', { class: 'zoom panel' });
    zoom.append(zoomIn, zoomOut);
    root.append(zoom);
    tools.insertBefore(home, tools.lastElementChild);
    tools.insertBefore(build, tools.lastElementChild);

    this.drawer = el('aside', { class: 'drawer panel', hidden: '' });
    this.drawer.addEventListener('click', (e) => this.onDrawerClick(e));
    root.append(this.drawer);

    this.homeDialog = el('dialog', { class: 'home-dialog' });
    this.homeDialog.addEventListener('click', (e) => {
      if (e.target === this.homeDialog) this.homeDialog.close();
      const btn = (e.target as HTMLElement).closest('button');
      if (!btn) return;
      if (btn.dataset.pick) {
        const [tier, choice] = btn.dataset.pick.split(':');
        h.onPickHome(Number(tier), choice!);
      }
      if (btn.dataset.act === 'moon') {
        this.homeDialog.close();
        h.onFlyToMoon();
      }
      if (btn.dataset.act === 'close') this.homeDialog.close();
      if (btn.dataset.focus) {
        this.homeDialog.close();
        h.onFocus(btn.dataset.focus as never);
      }
    });
    document.body.append(this.homeDialog);

    this.banner = el('div', { class: 'placing panel', hidden: '' });
    this.banner.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) h.onCancelPlacement();
    });
    root.append(this.banner);

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
      if (e.key === 'b' || e.key === 'B') this.toggleBuild();
      if (e.key === 'Escape') {
        if (!this.banner.hidden) h.onCancelPlacement();
        else this.closeBuild();
      }
      if (e.key === '+' || e.key === '=') h.onZoom(1.4);
      if (e.key === '-' || e.key === '_') h.onZoom(1 / 1.4);
    });
  }

  setState(g: GameState) {
    this.state = g;
    this.ownsRocket = g.owned.some((o) => o.item === 'rocket');
    this.renderPanel();
    if (!this.drawer.hidden) this.renderDrawer();
    if (this.homeDialog.open) this.renderHome();
  }

  // ─── City panel ─────────────────────────────────────────────────────────

  private renderPanel() {
    const g = this.state!;
    const sat = g.satisfaction.score;
    const mood = sat >= 80 ? 'Thriving' : sat >= 60 ? 'Content' : sat >= 40 ? 'Uneasy' : 'Unhappy';
    const decay = decayOf(g.maintenance);
    const warn = decay.housingFailing
      ? 'Housing is failing'
      : decay.shopsBoarded
        ? 'Shops are boarding up'
        : decay.trainStopped
          ? 'The train has stopped'
          : decay.bridgeRusting
            ? 'The bridge is rusting'
            : decay.lampsFailing
              ? 'Street lamps are failing'
              : decay.signDark
                ? 'The TINYTOWN sign is dark at night'
                : '';
    const housed = g.population ? Math.round((g.housed / g.population) * 100) : 100;
    const net = g.incomePerDay - g.upkeepPerDay;
    this.panel.innerHTML = `
      <div class="eyebrow"><span>Your city</span><span class="mood" data-mood="${mood.toLowerCase()}">${mood}</span></div>
      <div class="treasury"><b>${money(g.treasury)}</b><small class="${net >= 0 ? 'up' : 'down'}">${net >= 0 ? '+' : '−'}${money(Math.abs(net))}/day</small></div>
      <div class="bar-row" title="Satisfaction: housing 35%, upkeep 25%, amenities 20%, growth 20%">
        <span>Satisfaction</span><span class="bar"><i style="width:${sat}%" data-level="${sat >= 60 ? 'good' : sat >= 40 ? 'mid' : 'bad'}"></i></span><b>${sat}</b>
      </div>
      <div class="bar-row" title="Each user needs $0.20 of MRR to be housed">
        <span>Housed</span><span class="bar"><i style="width:${housed}%" data-level="${housed >= 100 ? 'good' : housed >= 70 ? 'mid' : 'bad'}"></i></span><b>${housed}%</b>
      </div>
      ${
        g.unhoused > 0
          ? `<p class="alert">${g.unhoused.toLocaleString('en-US')} people without a home. ${g.population.toLocaleString('en-US')} users need $${Math.ceil(g.housingNeed).toLocaleString('en-US')} MRR; you're at $${Math.round(g.mrr).toLocaleString('en-US')}.</p>`
          : ''
      }
      ${warn ? `<p class="alert">${warn}: upkeep is ${Math.round(g.maintenance)}% covered.</p>` : ''}
      <p class="fine">Income ${money(g.incomePerDay)}/day · upkeep ${money(g.upkeepPerDay)}/day · HQ: ${HQ_LEVEL_NAMES[g.hqLevel]}</p>`;
  }

  // ─── Build menu ─────────────────────────────────────────────────────────

  toggleBuild(plot?: string) {
    if (!this.drawer.hidden && plot === this.plot) return this.closeBuild();
    this.plot = plot;
    this.drawer.hidden = false;
    this.renderDrawer();
  }

  closeBuild() {
    this.drawer.hidden = true;
    this.plot = undefined;
  }

  private renderDrawer() {
    const g = this.state;
    if (!g) return;
    const items = CATALOG.filter((i) => (this.tab === 'all' || i.category === this.tab) && (!this.plot || i.placement.kind === 'plot'));
    const sorted = [...items].sort((a, b) => a.unlock - b.unlock || a.price - b.price);
    this.drawer.innerHTML = `
      <header>
        <div>
          <h2>${this.plot ? 'Build on this plot' : 'Build'}</h2>
          <p>${money(g.treasury)} to spend · earning ${money(g.incomePerDay)}/day</p>
        </div>
        <button class="btn icon" data-act="close" title="Close (Esc)" aria-label="Close">×</button>
      </header>
      <nav>${TABS.map((t) => `<button class="tab ${t.id === this.tab ? 'on' : ''}" data-tab="${t.id}">${t.label}</button>`).join('')}</nav>
      <ul class="items">${sorted.map((i) => this.itemRow(i, g)).join('')}</ul>`;
  }

  private itemRow(i: Item, g: GameState): string {
    const why = canBuy(g, i);
    const locked = g.mrr < i.unlock;
    const where =
      i.placement.kind === 'site'
        ? SITE_LABEL[i.placement.site]
        : i.placement.kind === 'hq'
          ? 'Replaces your HQ'
          : i.placement.size === 4
            ? 'Whole block'
            : 'One plot';
    return `<li class="${locked ? 'locked' : ''}">
      <div class="item-main">
        <b>${escape(i.name)}</b>
        <span class="price">${money(i.price)}</span>
      </div>
      <p>${escape(i.blurb)}</p>
      <div class="item-meta">
        <span>${where}</span>
        ${i.amenity ? `<span>+${i.amenity} happiness</span>` : ''}
        <span>upkeep ${money(i.price * i.upkeep)}/mo</span>
      </div>
      <button class="btn ${why ? '' : 'primary'}" data-buy="${i.id}" ${why ? 'disabled' : ''}>${why ? escape(why) : this.plot || i.placement.kind !== 'plot' ? 'Buy' : 'Buy & place'}</button>
    </li>`;
  }

  private onDrawerClick(e: MouseEvent) {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;
    if (btn.dataset.act === 'close') return this.closeBuild();
    if (btn.dataset.tab) {
      this.tab = btn.dataset.tab as Category | 'all';
      return this.renderDrawer();
    }
    if (btn.dataset.buy) {
      const item = ITEMS.get(btn.dataset.buy)!;
      const plot = this.plot;
      this.closeBuild();
      this.h.onBuild(item, plot);
    }
  }

  setPlacing(item: Item | null) {
    this.banner.hidden = !item;
    if (item) {
      this.banner.innerHTML = `<span>Pick ${item.placement.kind === 'plot' && item.placement.size === 4 ? 'an empty block' : 'a plot'} for your <b>${escape(item.name)}</b></span><button class="btn">Cancel</button>`;
    }
  }

  // ─── Your home ──────────────────────────────────────────────────────────

  openHome() {
    this.renderHome();
    if (!this.homeDialog.open) this.homeDialog.showModal();
  }

  private renderHome() {
    const g = this.state;
    if (!g) return;
    const rows = HOME_TIERS.map((tier, i) => {
      const reached = g.home.tier >= i;
      const current = g.home.tier === i;
      const picked = g.home.picks[i];
      const opts = tier.options
        .map((o) => {
          const chosen = picked === o.id;
          const canPick = reached && tier.options.length > 1 && !chosen;
          const fee = g.home.explicit.includes(i) ? tier.value * SWAP_FEE : 0;
          return `<div class="opt ${chosen && reached ? 'chosen' : ''}">
            <b>${escape(o.name)}</b><span>${escape(o.blurb)}</span>
            ${canPick ? `<button class="btn" data-pick="${i}:${o.id}">${fee ? `Switch (${money(fee)})` : 'Choose'}</button>` : ''}
          </div>`;
        })
        .join('');
      const where = tier.where === 'hills' ? 'TinyTown Hills' : tier.where === 'island' ? 'Your island' : tier.where === 'moon' ? 'The moon' : 'Downtown';
      return `<li class="${current ? 'current' : reached ? 'past' : 'future'}">
        <div class="tier-head"><span class="mrr">${tier.mrr === 0 ? 'Start' : `$${tier.mrr.toLocaleString('en-US')} MRR`}</span><span>${where}${current ? ' · you live here' : ''}</span></div>
        <div class="opts">${opts}</div>
      </li>`;
    }).join('');
    const moon = g.home.tier >= 6;
    this.homeDialog.innerHTML = `
      <div class="dialog-body">
        <h2>Your home</h2>
        <p>Every extra digit of MRR moves you up. Homes you've lived in stay in the city. Peak MRR counts, so a bad month never evicts you.</p>
        <ol class="ladder">${rows}</ol>
        <div class="dialog-actions">
          ${g.home.tier >= 3 ? '<button class="btn" data-focus="hills">Show the Hills</button>' : ''}
          ${g.home.tier >= 5 ? '<button class="btn" data-focus="island">Show my island</button>' : ''}
          ${moon ? (this.ownsRocket ? '<button class="btn primary" data-act="moon">Fly to the moon</button>' : '<button class="btn" disabled>Buy a rocket to fly to the moon</button>') : ''}
          <button class="btn" data-act="close">Close</button>
        </div>
      </div>`;
  }
}
