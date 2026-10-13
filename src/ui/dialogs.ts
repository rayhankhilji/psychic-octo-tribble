/** Shared bits for the hosted dialogs: creation, busy buttons, inline messages. */
import { el, escape, returnFocusOnClose } from './dom.ts';
import { ICON } from './icons.ts';

/** A modal dialog that closes on a backdrop click or any `[data-act=close]`, and hands focus back. */
export function makeDialog(cls: string, labelledBy: string, onClose?: () => void): HTMLDialogElement {
  const d = el('dialog', { class: `dialog ${cls}`, 'aria-labelledby': labelledBy, tabindex: '-1' });
  d.addEventListener('click', (e) => {
    if (e.target === d || (e.target as HTMLElement).closest('[data-act=close]')) d.close();
  });
  returnFocusOnClose(d, onClose);
  document.body.append(d);
  return d;
}

/**
 * Shows a button as working: a spinner, a new label, disabled, `aria-busy`.
 * Returns a function that puts it back.
 */
export function busy(btn: HTMLButtonElement | null, label: string): () => void {
  if (!btn) return () => {};
  const html = btn.innerHTML;
  const wasDisabled = btn.disabled;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.classList.add('is-busy');
  btn.innerHTML = `<span class="spinner" aria-hidden="true"></span><span class="label">${escape(label)}</span>`;
  return () => {
    if (!btn.isConnected) return;
    btn.innerHTML = html;
    btn.disabled = wasDisabled;
    btn.removeAttribute('aria-busy');
    btn.classList.remove('is-busy');
  };
}

/** An inline message: `role=alert` for errors so they're read out at once. */
export function message(tone: 'bad' | 'warn' | 'good' | 'info', text: string, extra = ''): string {
  const icon = tone === 'good' ? ICON.check : tone === 'info' ? ICON.info : ICON.alert;
  return `<p class="inline-msg tone-${tone}" ${tone === 'bad' ? 'role="alert"' : ''}>${icon}<span>${escape(text)}${extra}</span></p>`;
}

/**
 * The brand's one-line San Francisco (the boot screen's skyline): the Golden
 * Gate, downtown with the Transamerica, Twin Peaks and the sun, over the bay.
 * Strokes take their colours from tokens (hosted.css), so it follows day and
 * night; at night the sun pales to a moon, a few stars come out and the
 * office windows light up. Each stroke has `pathLength=1` so it can draw in.
 */
export function skylineSvg(cls = ''): string {
  const windows = [
    [121, 44], [121, 50], [129.5, 34], [129.5, 41], [135, 28], [145, 39], [145, 46], [150, 31], [150, 38], [177.5, 36], [177.5, 43], [185.5, 28], [185.5, 35], [195, 44],
  ]
    .map(([x, y]) => `<rect x="${x}" y="${y}" width="2" height="2.4" rx="0.4"/>`)
    .join('');
  const stars = [
    [18, 9], [62, 5], [108, 12], [146, 6], [196, 10], [228, 4], [276, 12],
  ]
    .map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="${i % 3 ? 0.7 : 1}"/>`)
    .join('');
  return `<svg class="skyline ${cls}" viewBox="0 0 280 64" preserveAspectRatio="xMidYMax meet" aria-hidden="true" focusable="false">
    <g class="sky-stars">${stars}</g>
    <g class="sky-windows">${windows}</g>
    <path class="sky-water" pathLength="1" d="M-40 60.5h360"/>
    <path class="sky-bridge" pathLength="1" d="M20 44h96M44 56V14M92 56V14M20 50 44 15Q68 42 92 15L116 50M41 14h6M89 14h6"/>
    <path class="sky-city" pathLength="1" d="M-40 56h40q10-14 22-8M118 56V40h8V30h8v-6h4v32M142 56V36h6V28h6v28M156 56l8-44 8 44M174 56V32h10v-8h6v32M192 56V40h8v16M202 56q16-26 40-20 22 6 38 20h40M223 40.5h2.4M228.5 38.6h2.4M234 37.4h2.4M239.5 36.9h2.4M245 37.2h2.4M250.5 38h2.4M0 56h280"/>
    <path class="sky-sun" pathLength="1" d="M252 20a7 7 0 1 0 14 0a7 7 0 1 0-14 0"/>
  </svg>`;
}

/** "October 12, 2027": dates people read, in the same style as the rest of the HUD. */
export function longDate(t: number): string {
  return new Date(t).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Focus the first thing worth focusing in a freshly rendered dialog. Comma-separated
 * selectors are tried in order of preference (not document order).
 */
export function focusFirst(root: HTMLElement, selector = '[data-autofocus]') {
  let target: HTMLElement | null = null;
  for (const sel of selector.split(/,\s*/)) if ((target = root.querySelector<HTMLElement>(sel))) break;
  target ??= root.querySelector<HTMLElement>('input:not([type=hidden]), button:not([data-act=close])');
  target?.focus({ preventScroll: true });
}
