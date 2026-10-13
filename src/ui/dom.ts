/** Small DOM, motion and formatting helpers shared by the HUD. */

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

export function reducedMotion(): boolean {
  return motionQuery?.matches ?? false;
}

export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/**
 * A number that glides to its new value. Retargeting mid-flight continues
 * from where it is, so a stream of updates during playback stays smooth.
 */
export class Tween {
  private from = 0;
  private to = 0;
  private start = 0;
  private raf = 0;
  value = 0;
  private ready = false;
  private render: (v: number) => void;
  private duration: number;

  constructor(render: (v: number) => void, duration = 650) {
    this.render = render;
    this.duration = duration;
  }

  set(target: number, animate = true) {
    if (!this.ready || !animate || reducedMotion() || !Number.isFinite(this.value)) {
      this.ready = true;
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.value = this.to = target;
      this.render(target);
      return;
    }
    if (target === this.to) return;
    this.from = this.value;
    this.to = target;
    this.start = performance.now();
    if (!this.raf) this.raf = requestAnimationFrame(this.step);
  }

  private step = (now: number) => {
    const t = Math.min(1, (now - this.start) / this.duration);
    this.value = this.from + (this.to - this.from) * easeOutCubic(t);
    this.render(t >= 1 ? this.to : this.value);
    this.raf = t < 1 ? requestAnimationFrame(this.step) : 0;
  };
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
