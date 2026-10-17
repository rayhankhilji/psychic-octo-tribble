/** Small DOM, motion and formatting helpers shared by the HUD. */
import { motionReduced, onSettings, settings } from './settings-store.ts';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (html) e.innerHTML = html;
  return e;
}

export function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Sets text only when it changed, so per-frame updates don't churn layout. */
export function setText(e: Element, text: string) {
  if (e.textContent !== text) e.textContent = text;
}

export function setHtml(e: Element, html: string) {
  if (e.innerHTML !== html) e.innerHTML = html;
}

const motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

/**
 * Reduced motion: the Motion setting (System, Reduce or Full), and with
 * System, what the operating system asks for. Every JS check goes through
 * here; CSS reads `html.reduce-motion` (kept in step below) alongside the
 * prefers-reduced-motion media query.
 */
export function prefersReducedMotion(): boolean {
  return motionReduced(settings().motion, motionQuery?.matches ?? false);
}

/** The older name, kept for the HUD's callers. */
export const reducedMotion = prefersReducedMotion;

if (typeof document !== 'undefined') {
  const sync = () => document.documentElement.classList.toggle('reduce-motion', settings().motion === 'reduce');
  sync();
  onSettings((_, changed) => changed.includes('motion') && sync());
}

export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const easeOutQuart = (t: number) => 1 - (1 - t) ** 4;

/** At most one new count per number this often, however fast the replay runs. */
const RETARGET_MS = 250;

/**
 * A number that counts to its new value: fast at first, settling at the end.
 * Retargeting mid-flight continues from where it is, and a stream of updates
 * (a fast replay sends one per day) is coalesced to one new count every
 * 250 ms, so the figures roll rather than flicker. `onMove` hears the
 * direction of each animated count (not snaps), for a brief tint.
 */
export class Tween {
  private from = 0;
  private to = 0;
  private start = 0;
  private raf = 0;
  private pending: number | null = null;
  value = 0;
  private ready = false;
  private render: (v: number) => void;
  private duration: number;
  onMove: ((dir: 1 | -1) => void) | null = null;

  constructor(render: (v: number) => void, duration = 600) {
    this.render = render;
    this.duration = duration;
  }

  set(target: number, animate = true) {
    if (!this.ready || !animate || reducedMotion() || !Number.isFinite(this.value)) {
      this.ready = true;
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.pending = null;
      this.value = this.to = target;
      this.render(target);
      return;
    }
    if (target === (this.pending ?? this.to)) return;
    const now = performance.now();
    // Still in the first moments of the last count: remember the target and pick it up shortly.
    if (this.raf && now - this.start < RETARGET_MS) {
      this.pending = target;
      return;
    }
    this.retarget(target, now);
    if (!this.raf) this.raf = requestAnimationFrame(this.step);
  }

  private retarget(target: number, now: number) {
    this.pending = null;
    if (target !== this.value) this.onMove?.(target > this.value ? 1 : -1);
    this.from = this.value;
    this.to = target;
    this.start = now;
  }

  private step = (now: number) => {
    if (this.pending !== null && now - this.start >= RETARGET_MS) this.retarget(this.pending, now);
    const t = Math.min(1, (now - this.start) / this.duration);
    this.value = this.from + (this.to - this.from) * easeOutQuart(t);
    this.render(t >= 1 ? this.to : this.value);
    this.raf = t < 1 || this.pending !== null ? requestAnimationFrame(this.step) : 0;
  };
}

/**
 * A brief tint on a number that just moved: `data-tick="up|down|spend"` on
 * `target`, cleared once the number has been still for a moment. The tint
 * holds through a streak in one direction instead of flashing per update,
 * and a reversal within 700 ms is ignored, so a jittery replay never strobes.
 */
export class Tint {
  private dir: string | null = null;
  private at = 0;
  private timer = 0;
  private target: HTMLElement;
  private hold: number;

  constructor(target: HTMLElement, hold = 900) {
    this.target = target;
    this.hold = hold;
  }

  /** `force` switches straight away (a purchase is news, not jitter). */
  show(dir: 'up' | 'down' | 'spend', force = false) {
    if (reducedMotion()) return;
    const now = performance.now();
    if (dir !== this.dir) {
      if (this.dir && !force && now - this.at < 700) return;
      this.dir = dir;
      this.at = now;
      this.target.dataset.tick = dir;
    }
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.clear(), this.hold);
  }

  clear() {
    clearTimeout(this.timer);
    this.dir = null;
    delete this.target.dataset.tick;
  }
}

/**
 * FLIP: measures `items`, runs `change` (which adds, removes or reorders
 * them), then slides each survivor from where it was to where it is now, so
 * a stack never jumps. Uses the `translate` property, which composes with
 * any transform the items already have.
 */
export function flip(items: Iterable<Element>, change: () => void, ms = 320) {
  if (reducedMotion()) return change();
  const before = new Map<Element, number>();
  for (const e of items) before.set(e, e.getBoundingClientRect().top);
  change();
  for (const [e, top] of before) {
    if (!e.isConnected) continue;
    const dy = top - e.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) continue;
    e.animate({ translate: [`0 ${dy}px`, '0 0'] }, { duration: ms, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
  }
}

/** Compact counts: 980, 4.3k, 12k, 1.2M. */
export function compact(n: number): string {
  const abs = Math.abs(n);
  const f = (v: number, s: string) => `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')}${s}`;
  if (abs >= 1e9) return f(n / 1e9, 'B');
  if (abs >= 1e6) return f(n / 1e6, 'M');
  if (abs >= 1e4) return f(n / 1e3, 'k');
  return Math.round(n).toLocaleString('en-US');
}

/** "$1k", "$10k", "$1M": for MRR thresholds. */
export function shortMrr(n: number): string {
  if (n >= 1e6) return `$${n / 1e6}M`;
  if (n >= 1e3) return `$${n / 1e3}k`;
  return `$${n}`;
}

export function dateLabel(t: number, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }): string {
  return new Date(t).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });
}

const openers = new WeakMap<HTMLDialogElement, HTMLElement>();

/** Opens a modal dialog, remembering what had focus so closing can hand it back. */
const trapped = new WeakSet<HTMLDialogElement>();
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';

export function showModal(dialog: HTMLDialogElement) {
  if (dialog.open) return;
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) openers.set(dialog, active);
  if (!trapped.has(dialog)) {
    trapped.add(dialog);
    // A modal dialog already makes the page inert; this also keeps Tab from wandering into the browser's own UI.
    dialog.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
      if (!items.length) return;
      const first = items[0]!;
      const last = items.at(-1)!;
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }
  dialog.showModal();
}

/**
 * Modal dialogs already trap focus and close on Esc; this hands focus back to
 * whatever opened them, unless something else has taken it since.
 */
export function returnFocusOnClose(dialog: HTMLDialogElement, onClose?: () => void) {
  dialog.addEventListener('close', () => {
    onClose?.();
    const back = openers.get(dialog);
    openers.delete(dialog);
    const now = document.activeElement;
    if (back?.isConnected && (!now || now === document.body || dialog.contains(now))) back.focus({ preventScroll: true });
  });
}

/**
 * Restarts an element's CSS animation (adding `cls` the first time) without
 * the `void el.offsetWidth` trick, which forces a synchronous layout. That
 * matters in code that runs 12 times a second during the replay.
 */
export function replayAnimation(e: Element, cls?: string) {
  if (cls && !e.classList.contains(cls)) return void e.classList.add(cls);
  for (const a of e.getAnimations?.() ?? []) {
    a.cancel();
    a.play();
  }
}
