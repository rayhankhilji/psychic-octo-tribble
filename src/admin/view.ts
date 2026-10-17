import type { AdminApi } from './api.ts';
import type { AdminMe } from './types.ts';

/** What each page of the console gets from the shell. */
export interface View {
  api: AdminApi;
  me: AdminMe;
  root: HTMLElement;
  /** The page title, and an optional crumb back to a parent page. */
  title(text: string, crumb?: { label: string; href: string }): void;
  /** The "as of" note at the top right. */
  stamp(text: string): void;
  /** True once the person has moved to another page: late answers are dropped. */
  stale(): boolean;
}

export function failure(root: HTMLElement, err: unknown) {
  root.innerHTML = `<div class="card"><div class="empty">${err instanceof Error ? err.message.replace(/[<>&]/g, '') : 'Something went wrong.'}</div></div>`;
}

export function skeleton(root: HTMLElement, rows = 3) {
  root.innerHTML = `<div class="grid kpis">${'<div class="skeleton" style="height:118px"></div>'.repeat(4)}</div>${'<div class="skeleton section" style="height:180px"></div>'.repeat(rows - 1)}`;
}
