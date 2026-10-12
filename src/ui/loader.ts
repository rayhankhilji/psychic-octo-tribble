/**
 * The boot screen lives in index.html so it paints before any JavaScript
 * runs. This module narrates progress, and lifts it once the world has
 * actually drawn a few frames.
 */

const LINES = ['Pouring the foundations', 'Planting palms', 'Rolling in the fog', 'Painting the bridge', 'Counting your customers', 'Lighting the sign'];

const boot = () => document.getElementById('boot');
let timer = 0;
let done = false;

export function bootStatus(text: string) {
  const s = boot()?.querySelector('.boot-status');
  if (s) s.textContent = text;
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
  if (!b) return;
  const wait = Math.max(0, minVisibleMs - performance.now());
  window.setTimeout(() => {
    b.classList.add('done');
    document.documentElement.classList.add('booted');
    const remove = () => b.remove();
    b.addEventListener('transitionend', remove, { once: true });
    window.setTimeout(remove, 1200);
  }, wait);
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
