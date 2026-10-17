import type { Action } from './economy.ts';

/**
 * The founder's choices, saved in this browser for now. The hosted version
 * will keep them server-side and validate every purchase there.
 */
export function loadActions(key: string): Action[] | null {
  try {
    const raw = localStorage.getItem(`tinytown:actions:${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed.filter(isAction) as Action[]) : null;
  } catch {
    return null;
  }
}

export function saveActions(key: string, actions: Action[]) {
  try {
    localStorage.setItem(`tinytown:actions:${key}`, JSON.stringify(actions));
  } catch {
    // Storage full or blocked: the choice still applies for this visit.
  }
}

export function clearActions(key: string) {
  try {
    localStorage.removeItem(`tinytown:actions:${key}`);
  } catch {
    // Nothing to clear.
  }
}

/** First day this browser saw the city, for the back-pay window. */
export function joinedAt(key: string, today: number): number {
  try {
    const k = `tinytown:joined:${key}`;
    const v = Number(localStorage.getItem(k));
    if (v > 0) return v;
    localStorage.setItem(k, String(today));
  } catch {
    // Treat today as day one.
  }
  return today;
}

function isAction(a: unknown): boolean {
  if (!a || typeof a !== 'object') return false;
  const x = a as Record<string, unknown>;
  return typeof x.t === 'number' && ((x.kind === 'build' && typeof x.item === 'string') || (x.kind === 'home' && typeof x.tier === 'number' && typeof x.choice === 'string'));
}

/** The day (snapshot time) this browser last showed the city, for "while you were away". */
export function lastSeen(key: string): number | null {
  try {
    const v = Number(localStorage.getItem(`tinytown:seen:${key}`));
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function markSeen(key: string, t: number) {
  try {
    localStorage.setItem(`tinytown:seen:${key}`, String(t));
  } catch {
    // Blocked storage: every visit is a first visit.
  }
}
