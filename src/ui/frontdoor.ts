/**
 * The front door: a title card over the grown demo city for someone's first
 * visit. It says what TinyTown is in three real rules, then gets out of the
 * way: "Watch a startup grow" starts the demo from day one, "Make it yours"
 * opens the plan picker, Esc or a click on the city just lets them look.
 *
 * Only this module sets `html.intro`, which holds the HUD back (loader.ts
 * doesn't reveal it when the boot screen lifts); leaving reveals it.
 */
import './frontdoor.css';
import { HOME_TIERS } from '../game/catalog.ts';
import { MRR_PER_USER, RATE } from '../game/economy.ts';
import { markSvg } from './brand.ts';
import { el, escape, shortMrr } from './dom.ts';
import { ICON } from './icons.ts';
import { revealHud, whenBooted } from './loader.ts';

const SEEN_KEY = 'tinytown:frontdoor-seen';

/** Any of these in the URL means a link with a purpose (a preview, a test, a pinned view): go straight in. */
const PURPOSEFUL = ['demo', 'debug', 'fresh', 'time', 'view', 'away', 'replay', 'seed', 'mockapi', 'quality', 'recap', 'moon'];

export interface FrontDoorFacts {
  /** The page's query string. `?intro` always shows the front door (previews, screenshots). */
  search: string | URLSearchParams;
  /** This browser has been through the front door before. */
  seen: boolean;
  /** The world on screen is the demo, not live data or the founder's own city. */
  demo: boolean;
  /** Someone is signed in: they know what TinyTown is. */
  signedIn: boolean;
  /** The dialog boot decided opens by itself (a sign-in or checkout return), once that's known. */
  dialog?: string;
}

/**
 * Pure: whether the front door shows. First visit to the demo only, signed
 * out, never over a dialog that's opening by itself, and never on a link
 * with a purpose. `?intro` forces it.
 */
export function wantsFrontDoor(f: FrontDoorFacts): boolean {
  const p = typeof f.search === 'string' ? new URLSearchParams(f.search) : f.search;
  if (p.has('intro')) return true;
  if (f.seen || !f.demo || f.signedIn) return false;
  if (f.dialog && f.dialog !== 'none') return false;
  return !PURPOSEFUL.some((k) => p.has(k));
}

export function frontDoorSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) !== null;
  } catch {
    // No storage: they'd see it on every visit, so treat it as seen.
    return true;
  }
}

function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // Without storage it shows again next time; nothing else to do.
  }
}

/** Holds the HUD back while the front door is up. Call before the boot screen lifts. */
export function holdHud() {
  document.documentElement.classList.add('intro');
}

/** The front door isn't showing after all (a dialog is opening): let the HUD in. */
export function releaseHud() {
  document.documentElement.classList.remove('intro');
  revealHud();
}

/**
 * How much of the screen the card covers, as fractions, so the stage can
 * frame the city in the rest: the left column on wide screens, the bottom
 * half on phones.
 */
export function frontDoorInset(w: number, h: number): { left: number; bottom: number } {
  if (w >= 900 && w / h > 1.05) return { left: Math.min(620, Math.max(460, w * 0.4)) / w, bottom: 0 };
  return { left: 0, bottom: h < 700 ? 0.62 : 0.56 };
}

export interface FrontDoorOptions {
  /** The real numbers behind the city on screen. */
  caption: { name: string; day: number; mrr: string; people: number; of: string };
  /** The button's price, "$29/yr", or null when no plans are on sale. */
  price: string | null;
  /** Another plan on sale, in words, for the small print ("or $99 a year"). Normally null: TinyTown is sold by the year. */
  yearly: string | null;
  /** Hosted accounts are on: "Make it yours" and "Sign in" lead somewhere. */
  accounts: boolean;
  /** Leaving: watch the demo grow from day one, or stay on its last day behind a dialog. */
  onEnter: (watch: boolean) => void;
  onMakeItYours?: () => void;
  onSignIn?: () => void;
}

type Exit = 'watch' | 'make' | 'signin';

/** "$29/yr" → "$29 a year", for a sentence. */
const spoken = (price: string) => price.replace('/mo', ' a month').replace('/yr', ' a year');

/**
 * The three rules on the card, from the game's own constants, so retuning
 * the economy can't leave the front door quoting an old number: the money
 * per $1 of MRR, the housing cost per user, and the MRR that reaches the
 * moon (one rung per digit while every rung is ten times the last).
 */
export function frontDoorBeats(): { fig: string; text: string }[] {
  const moon = HOME_TIERS.find((t) => t.where === 'moon') ?? HOME_TIERS.at(-1)!;
  const paid = HOME_TIERS.filter((t) => t.mrr > 0);
  const perDigit = paid.every((t, i) => i === 0 || t.mrr === paid[i - 1]!.mrr * 10);
  return [
    { fig: `$${RATE.toLocaleString('en-US')}`, text: 'to build with for every $1 of MRR. Parks, towers, a stadium, a jet.' },
    { fig: `${Math.round(MRR_PER_USER * 100)}¢`, text: 'of MRR houses each active user. Fall short and the sign goes dark, then the bridge rusts.' },
    { fig: shortMrr(moon.mrr), text: `MRR takes you from a hacker house to a house on the moon${perDigit ? ', one rung per digit' : ''}.` },
  ];
}

export class FrontDoor {
  private root: HTMLElement;
  private opts: FrontDoorOptions;
  private gone = false;
  private ui = document.getElementById('ui');
  private onKey = (e: KeyboardEvent) => this.key(e);

  constructor(opts: FrontDoorOptions) {
    this.opts = opts;
    const { caption: c, price, accounts } = opts;
    const nf = (n: number) => n.toLocaleString('en-US');
    const small = accounts && price ? `Watching is free. Your own city is ${escape(spoken(price))}${opts.yearly ? ` or ${escape(opts.yearly)}` : ''}, with no free trial.` : '';
    this.root = el(
      'section',
      { class: 'frontdoor', 'aria-labelledby': 'fd-title' },
      `<div class="fd-scrim" aria-hidden="true"></div>
      <header class="fd-top">
        <span class="fd-brand fd-in" style="--i:0">${markSvg({ cls: 'fd-mark' })}<span class="fd-word">TinyTown</span></span>
        ${accounts ? `<button class="fd-signin fd-in" style="--i:0" type="button" data-go="signin">Sign in</button>` : ''}
      </header>
      <div class="fd-card">
        <p class="fd-eyebrow fd-in" style="--i:1"><span class="fd-sun" aria-hidden="true"></span>A Tamagotchi for your startup</p>
        <h1 class="fd-title" id="fd-title">
          <span class="fd-line"><span class="fd-in" style="--i:2">Your startup,</span></span>
          <span class="fd-line"><span class="fd-in fd-accent" style="--i:3">as a city.</span></span>
        </h1>
        <p class="fd-lede fd-in" style="--i:4">Connect Stripe and your real revenue builds a tiny San&nbsp;Francisco by the bay. There's one way to grow it: grow the startup.</p>
        <ol class="fd-beats">${frontDoorBeats()
          .map((b, i) => `<li class="fd-in" style="--i:${5 + i}"><b class="fd-fig">${b.fig}</b><span>${b.text}</span></li>`)
          .join('')}</ol>
        <div class="fd-actions fd-in" style="--i:8">
          <button class="fd-btn fd-primary" type="button" data-go="watch"><span class="fd-play" aria-hidden="true">${ICON.play}</span>Watch a startup grow</button>
          ${accounts ? `<button class="fd-btn fd-secondary" type="button" data-go="make">Make it yours${price ? `<span class="fd-price num">${escape(price)}</span>` : ''}</button>` : ''}
        </div>
        ${small ? `<p class="fd-small fd-in" style="--i:9">${small}</p>` : ''}
      </div>
      <p class="fd-caption fd-in" style="--i:9"><span class="fd-live" aria-hidden="true"></span><span><b>${escape(c.name)}</b>, a made-up startup, on day ${nf(c.day)}: <span class="num">${escape(c.mrr)}</span> MRR, <span class="num">${nf(c.people)}</span> ${escape(c.of)}.</span></p>`,
    );
    this.root.addEventListener('click', (e) => {
      const go = (e.target as HTMLElement).closest<HTMLElement>('[data-go]')?.dataset.go as Exit | undefined;
      if (go) this.leave(go);
    });
    // A press or a scroll on the city itself (anywhere but the words and buttons) means "let me look".
    const onCity = (e: Event) => !(e.target as HTMLElement).closest('.fd-card > *, .fd-top > *, .fd-caption');
    this.root.addEventListener('pointerdown', (e) => onCity(e) && this.leave('watch'));
    this.root.addEventListener('wheel', (e) => onCity(e) && this.leave('watch'), { passive: true });
    document.body.append(this.root);
    // The hidden HUD can't be tabbed to or clicked while the card is up.
    if (this.ui) this.ui.inert = true;
    window.addEventListener('keydown', this.onKey, true);
  }

  /** Brings the card in as the boot screen lifts. */
  async open() {
    await whenBooted();
    if (this.gone) return;
    // No autofocus: a focus ring on arrival reads as a form. With the HUD inert, the card is all Tab reaches.
    this.root.classList.add('is-in');
  }

  private key(e: KeyboardEvent) {
    if (this.gone || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Tab' || e.key === 'Shift' || /^F\d+$/.test(e.key)) return;
    // Enter and Space press the focused button, as usual.
    if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof HTMLButtonElement && this.root.contains(e.target)) return;
    // Anything else (Esc, Space, a shortcut) steps in to watch; the HUD's shortcuts would act on a hidden HUD.
    e.preventDefault();
    e.stopImmediatePropagation();
    this.leave('watch');
  }

  private leave(to: Exit) {
    if (this.gone) return;
    this.gone = true;
    markSeen();
    window.removeEventListener('keydown', this.onKey, true);
    if (this.ui) this.ui.inert = false;
    const r = this.root;
    r.classList.add('is-leaving');
    r.setAttribute('aria-hidden', 'true');
    // The HUD arrives as the card recedes (styles.css choreographs html.hud-in).
    revealHud();
    this.opts.onEnter(to === 'watch');
    if (to === 'make') this.opts.onMakeItYours?.();
    if (to === 'signin') this.opts.onSignIn?.();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      r.remove();
      document.documentElement.classList.remove('intro');
    };
    r.addEventListener('transitionend', (e) => e.target === r && finish());
    window.setTimeout(finish, 900);
  }
}
