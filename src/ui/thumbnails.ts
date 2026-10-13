import type { Studio } from './thumbnail-studio.ts';

/**
 * Real 3D thumbnails for the build menu and the home ladder: each model is
 * rendered once, offscreen, from the same isometric angle as the city, in
 * midday light, then cached as a data URL.
 *
 * This module is deliberately light (no three.js): the studio that actually
 * renders lives in `thumbnail-studio.ts`, which is loaded on first use, so it
 * stays out of the first paint.
 *
 * Performance rules (the replay runs at 12 days a second next to this):
 * - at most one model is rendered per idle callback, never inside a frame;
 * - PNGs are encoded with toBlob (off the main thread) into object URLs;
 * - one WebGL context for the session, freed only after the full prewarm
 *   has cached every thumbnail (re-creating it would recompile all shaders);
 * - prewarming waits while `busy()` says the city is replaying.
 *
 * Keys: `item:<item id>` or `home:<home option id>`.
 */

let context = { name: 'TinyTown', seed: 1 };
const cache = new Map<string, string | null>();
const waiting = new Map<string, ((url: string | null) => void)[]>();
const queue: string[] = [];

/** City name (for the HQ sign) and seed, so thumbnails match your world. */
export function setThumbnailContext(name: string, seed: number) {
  if (name !== context.name) for (const k of [...cache.keys()]) if (k.startsWith('item:hq-')) cache.delete(k);
  context = { name, seed };
}

/** Keys someone is looking at (an open menu): rendered first, and soon even if the page is never idle. */
const urgent = new Set<string>();

/** Resolves with an image URL, or null if this device can't render one. `soon` = a menu is waiting for it. */
export function thumbnail(key: string, soon = true): Promise<string | null> {
  if (cache.has(key)) return Promise.resolve(cache.get(key)!);
  if (soon && !urgent.has(key)) {
    urgent.add(key);
    // Jump the queue ahead of prewarming.
    const i = queue.indexOf(key);
    if (i > 0) queue.unshift(...queue.splice(i, 1));
  }
  return new Promise((resolve) => {
    const list = waiting.get(key);
    if (list) {
      list.push(resolve);
      return pump();
    }
    waiting.set(key, [resolve]);
    if (soon) queue.unshift(key);
    else queue.push(key);
    pump();
  });
}

let busy: () => boolean = () => false;

/** Rendering a model hitches a frame: prewarming waits while this says the city is busy (the replay is playing). */
export function setThumbnailBusy(fn: () => boolean) {
  busy = fn;
}

/**
 * Runs `cb` in idle time. Background work (prewarming) waits for a genuinely idle
 * moment with room to spare; work a menu is waiting on gets a deadline instead.
 */
function idle(cb: () => void, soon = false) {
  if (typeof requestIdleCallback !== 'function') return void setTimeout(cb, soon ? 50 : 300);
  const run = (d: IdleDeadline) => (soon || d.didTimeout || d.timeRemaining() > 10 ? cb() : requestIdleCallback(run));
  requestIdleCallback(run, soon ? { timeout: 600 } : undefined);
}

/**
 * Renders every thumbnail in idle time, one per idle callback, so menus open
 * with pictures ready; once all are cached, the studio's WebGL context is freed.
 */
export function prewarmThumbnails(keys: string[]) {
  const all = [...keys];
  const next = () => {
    if (busy()) return void window.setTimeout(() => idle(next), 1500);
    const key = keys.shift();
    if (!key) {
      // Everything's cached (or queued by a menu): free the context once the queue drains.
      if (!all.every((k) => cache.has(k)) || !disposeStudio()) window.setTimeout(() => idle(next), 1000);
      return;
    }
    if (cache.has(key) || waiting.has(key)) return next();
    void thumbnail(key, false).then(() => idle(next));
  };
  idle(next);
}

let observer: IntersectionObserver | null = null;

/** Fills `img` with the thumbnail once it scrolls into view. */
export function lazyThumbnail(img: HTMLImageElement, key: string) {
  const cached = cache.get(key);
  if (cached) {
    img.src = cached;
    img.closest('.thumb')?.classList.add('ready');
    return;
  }
  img.dataset.thumb = key;
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const target = e.target as HTMLImageElement;
        observer!.unobserve(target);
        const k = target.dataset.thumb!;
        void thumbnail(k).then((url) => {
          const frame = target.closest('.thumb');
          if (url) {
            target.src = url;
            target.decode?.().catch(() => {}).finally(() => frame?.classList.add('ready'));
          } else frame?.classList.add('failed');
        });
      }
    },
    { rootMargin: '120px' },
  );
  observer.observe(img);
}

let studioInstance: Studio | null = null;
let studioLoading: Promise<Studio | null> | null = null;
/** Set once the studio has failed (no WebGL, chunk failed) or been retired: thumbnails fall back to icons. */
let studioDone = false;

function loadStudio(): Promise<Studio | null> {
  if (studioInstance) return Promise.resolve(studioInstance);
  if (studioDone) return Promise.resolve(null);
  studioLoading ??= import('./thumbnail-studio.ts')
    .then((m) => (studioInstance = m.createStudio()))
    .catch((err: unknown) => {
      console.warn('thumbnail studio unavailable', err);
      studioDone = true;
      return null;
    })
    .finally(() => (studioLoading = null));
  return studioLoading;
}

/** Frees the second WebGL context for good: every thumbnail is cached by now. */
function disposeStudio(): boolean {
  if (rendering || queue.length) return false;
  studioInstance?.dispose();
  studioInstance = null;
  studioDone = true;
  return true;
}

/** A render in flight, and which kinds of idle slot are already booked. */
let rendering = false;
let bookedSoon = false;
let bookedIdle = false;

/**
 * Books the next render: one per idle callback, so a render never lands inside a busy
 * frame. Background work waits for real idle time; a menu's request books a slot with a
 * deadline even if a background slot is still waiting.
 */
function pump() {
  if (rendering || !queue.length) return;
  const soon = urgent.size > 0;
  if (bookedSoon || (!soon && bookedIdle)) return;
  if (soon) bookedSoon = true;
  else bookedIdle = true;
  idle(() => {
    if (soon) bookedSoon = false;
    else bookedIdle = false;
    step();
  }, soon);
}

function step() {
  if (rendering) return;
  const key = queue.shift();
  if (!key) return;
  urgent.delete(key);
  rendering = true;
  void loadStudio()
    .then((studio) => studio?.render(key, context) ?? null)
    .catch((err: unknown) => {
      console.warn('thumbnail failed', key, err);
      return null;
    })
    .then((url) => {
      cache.set(key, url);
      for (const done of waiting.get(key) ?? []) done(url);
      waiting.delete(key);
      rendering = false;
      pump();
    });
}
