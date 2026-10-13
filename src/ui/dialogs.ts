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
