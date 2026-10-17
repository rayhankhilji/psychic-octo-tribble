/**
 * The grand opening's chrome and rules (the 3D side is src/render/ceremony.ts).
 *
 * When a founder's own city opens for the first time with their real numbers,
 * it gets an inauguration: letterbox bars, a title card ("Grand opening", the
 * city's name, the day it was founded, its real numbers on day one), a Skip
 * pill, and the veil the cuts happen under. The pure parts (whether it plays,
 * what the card says) are tested in tests/ceremony.test.ts.
 */
import './ceremony.css';
import { formatMoney } from '../data/types.ts';
import { el, escape } from './dom.ts';
import { releaseHud } from './frontdoor.ts';
import type { CeremonyUi } from '../render/ceremony.ts';

// ─── Whether it plays ────────────────────────────────────────────────────

export interface CeremonyFacts {
  /** `?inaugurate` in a dev build or with `&debug`: play it on whatever city is showing, every time. */
  preview: boolean;
  /** The founder's own city (signed in, paid, connected), not the demo or a local `.env` city. */
  hosted: boolean;
  /** The server's record of the last day this city was shown; null means it never has been. */
  lastSeen: number | null;
  /** This browser has already played it for this city. */
  played: boolean;
  /** Days of real numbers the city has. */
  days: number;
  /** Browser automation (the e2e suite): no unasked-for ceremony over the HUD. */
  automated?: boolean;
}

/**
 * Pure: whether the grand opening plays. Once per city: the first time the
 * founder's own city opens with real numbers (the server has never recorded
 * a day as seen), and not again in a browser that has played it. Previews
 * always play.
 */
export function wantsCeremony(f: CeremonyFacts): boolean {
  if (f.preview) return true;
  return !f.automated && f.hosted && f.lastSeen === null && !f.played && f.days > 0;
}

/** The browser's record, per city: `tinytown:inaugurated:<user id, or the city's seed>`. */
export function ceremonyKey(id: string | number): string {
  return `tinytown:inaugurated:${id}`;
}

export function ceremonyPlayed(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    // No storage: the server's first-open record still keeps it to once.
    return false;
  }
}

export function markCeremony(key: string, at = Date.now()) {
  try {
    localStorage.setItem(key, String(at));
  } catch {
    // Without storage, the server's record is the only guard; that's enough.
  }
}

// ─── What the card says ────────────────────────────────────────────────────

export interface OpeningNumbers {
  name: string;
  currency: string;
  /** The city's latest day: real numbers only. */
  mrr: number;
  customers: number;
  /** Monthly active users, when there's a source for them. Without one, the customers are the people. */
  users?: number;
  /** When the city opens (now), for "Founded …". */
  today: number;
}

export interface OpeningCard {
  name: string;
  founded: string;
  stats: { value: string; label: string }[];
  /** One line for screen readers and the feed. */
  line: string;
}

const count = (n: number) => Math.round(n).toLocaleString('en-US');

/** Pure: the card's words, quoting the real numbers behind the city on day one. */
export function openingCard(n: OpeningNumbers): OpeningCard {
  const date = new Date(n.today).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const stats = [
    { value: formatMoney(n.mrr, n.currency), label: 'MRR' },
    { value: count(n.customers), label: n.customers === 1 ? 'customer' : 'customers' },
  ];
  // Everyone using the product needs a home; with no user source the customers are the people, already counted.
  if (n.users !== undefined) stats.push({ value: count(n.users), label: n.users === 1 ? 'person to house' : 'people to house' });
  return { name: n.name, founded: `Founded ${date}`, stats, line: stats.map((s) => `${s.value} ${s.label}`).join(' · ') };
}

// ─── When it can start ─────────────────────────────────────────────────────

/**
 * Resolves once nothing else has the screen: no dialog open (onboarding
 * after connecting Stripe, say) and no front door. It checks a few times
 * in a row, so a dialog that's about to open has its chance first.
 */
export function untilCalm(): Promise<void> {
  const busy = () => !!document.querySelector('dialog[open], .frontdoor');
  return new Promise((resolve) => {
    let calm = 0;
    const tick = () => {
      calm = busy() ? 0 : calm + 1;
      if (calm >= 3) resolve();
      else window.setTimeout(tick, 250);
    };
    window.setTimeout(tick, 250);
  });
}

// ─── The overlay ─────────────────────────────────────────────────────────────

/**
 * Letterbox bars, the title card, the Skip pill and the veil. The HUD steps
 * aside while it's up and comes back (with its usual entrance) at `hide()`.
 * While it plays, the keyboard belongs to it: Esc skips, nothing reaches the
 * city or the HUD.
 */
export class CeremonyOverlay implements CeremonyUi {
  private root: HTMLDivElement;
  private veilEl: HTMLDivElement;
  private cardEl: HTMLElement;
  private eyebrow: HTMLElement;
  private skipEl: HTMLButtonElement;
  private hud: HTMLElement | null;
  private onKey: (e: KeyboardEvent) => void;
  private hidden = false;
  level = 0;

  constructor(card: OpeningCard, onSkip: () => void) {
    const coarse = matchMedia('(pointer: coarse)').matches;
    this.root = el('div', { class: 'cer', role: 'dialog', 'aria-label': `The grand opening of ${card.name}` });
    this.root.innerHTML = `
      <div class="cer-bar cer-top" aria-hidden="true"></div>
      <div class="cer-bar cer-bottom" aria-hidden="true"></div>
      <div class="cer-card-wrap">
        <section class="cer-card" aria-live="polite">
          <p class="cer-eyebrow"><span class="cer-dot" aria-hidden="true"></span><span class="cer-eyebrow-text"><span class="cer-was">Grand opening</span><span class="cer-now" aria-hidden="true">Now open</span></span></p>
          <h1 class="cer-title"><span class="cer-line"><span>${escape(card.name)}</span></span></h1>
          <p class="cer-founded">${escape(card.founded)}</p>
          <div class="cer-tear" aria-hidden="true"></div>
          <dl class="cer-stats">${card.stats.map((s) => `<div class="cer-stat"><dt>${escape(s.label)}</dt><dd class="num">${escape(s.value)}</dd></div>`).join('')}</dl>
        </section>
      </div>
      <button class="cer-skip" type="button" aria-label="Skip the grand opening">Skip${coarse ? '' : '<kbd>Esc</kbd>'}</button>
      <div class="cer-veil" aria-hidden="true"></div>`;
    this.veilEl = this.root.querySelector('.cer-veil')!;
    this.cardEl = this.root.querySelector('.cer-card-wrap')!;
    this.eyebrow = this.root.querySelector('.cer-eyebrow')!;
    this.skipEl = this.root.querySelector('.cer-skip')!;
    this.skipEl.addEventListener('click', onSkip);
    this.hud = document.getElementById('ui');
    this.onKey = (e) => {
      if (e.key === 'Escape') onSkip();
      if (e.key === 'Tab' || ((e.key === 'Enter' || e.key === ' ') && e.target === this.skipEl)) return;
      e.stopImmediatePropagation();
      e.preventDefault();
    };
  }

  show() {
    document.body.append(this.root);
    window.addEventListener('keydown', this.onKey, true);
    this.placeTear();
    if (this.hud) {
      this.hud.classList.add('cer-hud-away');
      this.hud.setAttribute('aria-hidden', 'true');
      this.hud.inert = true;
    }
    // Lay the bars out where they start (off screen) first, so they slide in from there.
    void this.root.offsetWidth;
    this.root.classList.add('is-on');
    this.skipEl.focus({ preventScroll: true });
  }

  /** The ticket's notches sit on the tear line, wherever the card's text puts it. */
  private placeTear() {
    const card = this.root.querySelector<HTMLElement>('.cer-card')!;
    const tear = this.root.querySelector<HTMLElement>('.cer-tear')!;
    card.style.setProperty('--tear-y', `${tear.offsetTop}px`);
  }

  free(w: number, h: number, card: boolean): { x0: number; x1: number; y0: number; y1: number } {
    // Measured from the card itself (it's laid out, just not shown yet).
    this.placeTear();
    const bar = this.root.querySelector<HTMLElement>('.cer-top')!.getBoundingClientRect().height / h;
    const rect = { x0: 0.03, x1: 0.97, y0: bar + 0.03, y1: 1 - bar - 0.03 };
    if (!card) return rect;
    const r = this.cardEl.getBoundingClientRect();
    // Wide screens: the card sits at the bottom left, so the picture takes the space to its right.
    if (w >= 700) return { ...rect, x0: Math.min(0.5, r.right / w + 0.02) };
    // Phones: the card runs along the bottom, so the picture takes the space above it.
    return { ...rect, y1: Math.max(0.4, r.top / h - 0.02) };
  }

  card(on: boolean, animate = true) {
    this.cardEl.classList.toggle('no-motion', !animate);
    this.cardEl.classList.toggle('is-in', on);
    this.cardEl.classList.toggle('is-out', !on && this.cardEl.classList.contains('was-in'));
    if (on) this.cardEl.classList.add('was-in');
  }

  opened(animate = true) {
    this.eyebrow.classList.toggle('no-motion', !animate);
    this.eyebrow.classList.add('is-open');
    this.eyebrow.querySelector('.cer-was')!.setAttribute('aria-hidden', 'true');
    this.eyebrow.querySelector('.cer-now')!.removeAttribute('aria-hidden');
  }

  veil(k: number) {
    this.level = Math.min(1, Math.max(0, k));
    this.veilEl.style.opacity = this.level.toFixed(3);
  }

  hide() {
    if (this.hidden) return;
    this.hidden = true;
    this.root.classList.remove('is-on');
    this.restoreHud();
  }

  private restoreHud() {
    if (this.hud) {
      this.hud.classList.remove('cer-hud-away');
      this.hud.removeAttribute('aria-hidden');
      this.hud.inert = false;
    }
    // If the HUD was held back from the start (html.intro), this brings it in with its usual entrance.
    releaseHud();
  }

  remove() {
    window.removeEventListener('keydown', this.onKey, true);
    this.hide();
    // Let the bars finish leaving before the overlay goes.
    window.setTimeout(() => this.root.remove(), 700);
  }
}
