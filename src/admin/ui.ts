/**
 * Small DOM and formatting helpers for the console. Everything that reaches
 * innerHTML goes through `esc` (emails and reasons are typed by people).
 */
import { ICON } from '../ui/icons.ts';

export { ICON };

export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const nf = new Intl.NumberFormat('en-US');
export const n = (v: number | null | undefined) => (v == null ? '–' : nf.format(v));

/** Minor units → "$4,250" (or "$4,250.50" when there are cents). */
export function money(amount: number | null | undefined, currency = 'usd'): string {
  if (amount == null) return '–';
  const major = amount / 100;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: Number.isInteger(major) ? 0 : 2, minimumFractionDigits: 0 }).format(major);
}

export function pct(part: number, whole: number): string {
  if (!whole) return '–';
  const p = (part / whole) * 100;
  return `${p >= 10 || p === 0 ? Math.round(p) : p.toFixed(1)}%`;
}

const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const shortFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

export function date(t: number | null | undefined, now = Date.now()): string {
  if (t == null) return '–';
  return new Date(t).getFullYear() === new Date(now).getFullYear() ? shortFmt.format(t) : dateFmt.format(t);
}

export function dateTime(t: number | null | undefined, now = Date.now()): string {
  if (t == null) return '–';
  return `${date(t, now)}, ${timeFmt.format(t)}`;
}

/** "at 2:41 PM" today, or a date and time. */
export function timeOf(t: number, now = Date.now()): string {
  return new Date(t).toDateString() === new Date(now).toDateString() ? `at ${timeFmt.format(t)}` : dateTime(t, now);
}

/** "just now", "4 min ago", "3 h ago", "6 days ago", then a date. */
export function ago(t: number | null | undefined, now = Date.now()): string {
  if (t == null) return '–';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86_400 * 14) {
    const d = Math.round(s / 86_400);
    return d === 1 ? 'yesterday' : `${d} days ago`;
  }
  return date(t, now);
}

export function initial(email: string | null | undefined): string {
  return esc((email ?? '?').trim().charAt(0) || '?');
}

/** The plan as a badge: what it means for access, in words, with a matching colour. */
export function planBadge(status: string, comp = false): string {
  if (comp) return '<span class="badge accent">Comped</span>';
  const map: Record<string, [string, string]> = {
    active: ['good', 'Paying'],
    trialing: ['good', 'Trialing'],
    past_due: ['warn', 'Past due'],
    canceled: ['plain', 'Canceled'],
    incomplete: ['warn', 'Incomplete'],
    none: ['plain', 'No plan'],
  };
  const [tone, label] = map[status] ?? ['plain', status];
  return `<span class="badge ${tone}">${esc(label)}</span>`;
}

/** A thin single-series trend line: muted path, the latest point in the accent. */
export function sparkline(values: (number | null)[]): string {
  const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] != null);
  if (pts.length < 2) return '';
  const w = 96;
  const h = 30;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const X = (x: number) => ((x - x0) / Math.max(1, x1 - x0)) * w;
  const Y = (y: number) => h - 2 - ((y - y0) / Math.max(1e-9, y1 - y0 || 1)) * (h - 4);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${X(x).toFixed(1)} ${Y(y).toFixed(1)}`).join('');
  const [lx, ly] = pts.at(-1)!;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${d}" fill="none" stroke="var(--spark)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${X(lx).toFixed(1)}" cy="${Y(ly).toFixed(1)}" r="3" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/></svg>`;
}

let toastTimer = 0;
export function toast(message: string, tone: 'ok' | 'bad' = 'ok') {
  let t = document.querySelector<HTMLDivElement>('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'status');
    t.setAttribute('aria-live', 'polite');
    document.body.append(t);
  }
  t.className = `toast${tone === 'bad' ? ' bad' : ''}`;
  t.textContent = message;
  requestAnimationFrame(() => t!.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t!.classList.remove('show'), tone === 'bad' ? 6000 : 3500);
}

/** Marks a button busy for the length of a promise. */
export async function busy<T>(btn: HTMLButtonElement | null, label: string, work: () => Promise<T>): Promise<T> {
  if (!btn) return work();
  const before = btn.innerHTML;
  btn.setAttribute('aria-busy', 'true');
  btn.textContent = label;
  try {
    return await work();
  } finally {
    btn.removeAttribute('aria-busy');
    btn.innerHTML = before;
  }
}

/**
 * A small confirm-with-input dialog. Resolves with the form's values, or
 * null if dismissed. `fields` is extra HTML inside the form.
 */
export function ask(opts: { title: string; body: string; fields?: string; confirm: string; danger?: boolean; validate?: (data: FormData) => string | null }): Promise<FormData | null> {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.setAttribute('aria-labelledby', 'ask-title');
    d.innerHTML = `
      <form method="dialog">
        <h2 id="ask-title">${esc(opts.title)}</h2>
        <p>${opts.body}</p>
        ${opts.fields ?? ''}
        <div class="form-error" role="alert" hidden></div>
        <div class="actions">
          <button class="btn ghost" value="cancel" type="button" data-cancel>Cancel</button>
          <button class="btn ${opts.danger ? 'danger' : 'primary'}" value="ok" type="submit">${esc(opts.confirm)}</button>
        </div>
      </form>`;
    document.body.append(d);
    const form = d.querySelector('form')!;
    const error = d.querySelector<HTMLElement>('.form-error')!;
    let result: FormData | null = null;
    d.querySelector('[data-cancel]')!.addEventListener('click', () => d.close());
    form.addEventListener('submit', (e) => {
      const data = new FormData(form);
      const problem = opts.validate?.(data) ?? null;
      if (problem) {
        e.preventDefault();
        error.textContent = problem;
        error.hidden = false;
        return;
      }
      result = data;
    });
    d.addEventListener('close', () => {
      d.remove();
      resolve(result);
    });
    d.showModal();
    (d.querySelector<HTMLElement>('[autofocus], textarea, input') ?? d.querySelector<HTMLElement>('button[type=submit]'))?.focus();
  });
}
