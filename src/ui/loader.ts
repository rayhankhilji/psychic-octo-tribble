/**
 * The boot screen lives in index.html so it paints before any JavaScript
 * runs. This module narrates progress, and lifts it once the world has
 * actually drawn a few frames.
 */
import { prefersReducedMotion } from './dom.ts';

const LINES = ['Pouring the foundations', 'Planting palms', 'Rolling in the fog', 'Painting the bridge', 'Counting your customers', 'Lighting the sign'];

const boot = () => document.getElementById('boot');
let timer = 0;
let done = false;
let lifted: () => void = () => {};
const liftedPromise = new Promise<void>((r) => (lifted = r));

/** Resolves once the boot screen has gone, so dialogs open over the city rather than the loader. */
export function whenBooted(): Promise<void> {
  return liftedPromise;
}

/**
 * Sets the boot screen's status line. Lines crossfade (the old one drifts up
 * and out as the new one settles in); errors and reduced motion just swap.
 */
export function bootStatus(text: string) {
  const b = boot();
  const s = b?.querySelector('.boot-status');
  if (!b || !s) return;
  const calm = b.classList.contains('failed') || prefersReducedMotion();
  if (calm) {
    s.textContent = text;
    return;
  }
  const lines = [...s.childNodes];
  const now = lines.at(-1);
  if (now?.textContent === text) return;
  for (const n of lines) {
    if (n instanceof HTMLElement) {
      n.classList.add('out');
      window.setTimeout(() => n.remove(), 400);
    } else n.remove();
  }
  const line = document.createElement('span');
  line.textContent = text;
  s.append(line);
}

/** Cycles playful status lines until the world is ready. */
export function narrateBoot() {
  let i = 0;
  window.clearInterval(timer);
  timer = window.setInterval(() => {
    if (done) return window.clearInterval(timer);
    bootStatus(`${LINES[i++ % LINES.length]}…`);
  }, 900);
}

/** Fades the boot screen out. Waits a beat if it has only just appeared, so it never flashes. */
export function hideBoot(minVisibleMs = 900) {
  if (done) return;
  done = true;
  window.clearInterval(timer);
  const b = boot();
  if (!b) {
    if (!document.documentElement.classList.contains('intro')) revealHud();
    return lifted();
  }
  const wait = Math.max(0, minVisibleMs - performance.now());
  window.setTimeout(() => {
    // The progress hairline runs to the end from wherever it got to, then the veil lifts (index.html).
    const bar = b.querySelector<HTMLElement>('.boot-bar i');
    if (bar) {
      bar.style.transform = getComputedStyle(bar).transform;
      bar.style.animation = 'none';
    }
    b.classList.add('done');
    if (bar) requestAnimationFrame(() => (bar.style.transform = 'none'));
    const root = document.documentElement;
    root.classList.add('booted');
    // The front door (first visit) holds the HUD back and reveals it itself.
    if (!root.classList.contains('intro')) {
      // Arriving with the lift: the HUD waits a beat so the city shows first.
      root.classList.add('hud-after-boot');
      revealHud();
    }
    lifted();
    const remove = () => b.remove();
    // Only the overlay's own fade counts (children's transforms bubble up too).
    b.addEventListener('transitionend', (e) => e.target === b && e.propertyName === 'opacity' && remove());
    // Belt and braces: never leave the boot screen up if transitions don't run.
    window.setTimeout(remove, 1500);
  }, wait);
}

/**
 * Brings the HUD in (html.hud-in; styles.css choreographs the entrance). Called
 * when the boot screen lifts, or by the front door when the visitor steps in.
 */
export function revealHud() {
  const root = document.documentElement;
  if (root.classList.contains('hud-in')) return;
  // `hud-entering` scopes the entrance animations, so they never replay later
  // (when a panel's own animation comes and goes) and never fight them.
  root.classList.add('hud-in', 'hud-entering');
  window.setTimeout(() => root.classList.remove('hud-entering', 'hud-after-boot'), 1600);
}

/** Calls `ready` after the renderer has produced `frames` frames. */
export function afterFrames(frames: number, ready: () => void) {
  let n = 0;
  const tick = () => (++n >= frames ? ready() : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}

/** Something went wrong before the world could render: say so plainly. */
export function bootError(message: string) {
  done = true;
  window.clearInterval(timer);
  const b = boot();
  if (!b) return;
  b.classList.add('failed');
  bootStatus(message);
}

/** True when this browser can give us a WebGL 2 context (checked once, then released). */
export function hasWebGL2(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The city can't start at all (no WebGL, or a crash before the first frame):
 * a calm screen that says why, what to try, and who to write to.
 */
export function bootFailure(opts: { title: string; message: string; tips?: string[]; support?: string | null }) {
  done = true;
  window.clearInterval(timer);
  const b = boot();
  if (!b) return;
  b.classList.add('failed');
  b.querySelector('.boot-fail')?.remove();
  const box = document.createElement('div');
  box.className = 'boot-fail';
  box.setAttribute('role', 'alert');
  box.innerHTML = `
    <h1>${esc(opts.title)}</h1>
    <p>${esc(opts.message)}</p>
    ${opts.tips?.length ? `<ul>${opts.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
    <div class="boot-actions">
      <button type="button" class="boot-btn" data-reload>Reload</button>
      ${opts.support ? `<a class="boot-link" href="mailto:${esc(opts.support)}">Email ${esc(opts.support)}</a>` : ''}
    </div>`;
  box.querySelector('[data-reload]')!.addEventListener('click', () => location.reload());
  b.querySelector('.boot-inner')?.append(box);
  box.querySelector<HTMLElement>('[data-reload]')?.focus();
}
