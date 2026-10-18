/**
 * Browser error and performance reports for the hosted app: uncaught errors,
 * unhandled rejections and WebGL context loss (at most five a page load),
 * plus one performance report a session (boot time and average frame rate).
 * No personal data: no emails, no query strings or hashes, no metrics.
 * Reports wait until boot knows the server takes them (hosted only), so a
 * local or static build never posts anywhere.
 */
import { ROUTES, type TelemetryReport } from './api/contract.ts';

const MAX_REPORTS = 5;
const PERF_AFTER_MS = 30_000;
const PERF_KEY = 'tinytown:perf-sent';
const release: string = (import.meta.env.VITE_RELEASE as string | undefined) ?? 'dev';

let enabled: boolean | null = null;
let sent = 0;
const queue: TelemetryReport[] = [];

/** Strips anything that could identify someone: emails, tokens in URLs, long hex ids. */
export function scrub(text: string): string {
  return text
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]')
    .replace(/([?#&](access_token|refresh_token|token|code|state|key)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(sk|rk|pk|phx|phc|ghp|github_pat)_[A-Za-z0-9_]+/g, '[key]');
}

function post(r: TelemetryReport) {
  const body = JSON.stringify(r);
  try {
    if (navigator.sendBeacon?.(ROUTES.telemetry, new Blob([body], { type: 'application/json' }))) return;
  } catch {
    // Fall through to fetch.
  }
  void fetch(ROUTES.telemetry, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
}

function report(r: Omit<TelemetryReport, 'release' | 'url'>, counted = true) {
  if (enabled === false) return;
  if (counted) {
    if (sent >= MAX_REPORTS) return;
    sent++;
  }
  const full: TelemetryReport = {
    ...r,
    message: scrub(r.message).slice(0, 500),
    ...(r.stack ? { stack: scrub(r.stack).slice(0, 4000) } : {}),
    url: location.pathname,
    release,
  };
  if (enabled) post(full);
  else queue.push(full);
}

/** Starts listening. Call first thing; nothing is sent until `setTelemetry(true)`. */
export function startTelemetry() {
  window.addEventListener('error', (e) => {
    // Resource load failures (an image, a font) have no message and aren't ours to chase here.
    if (!e.message) return;
    report({ kind: 'error', message: e.message, stack: e.error instanceof Error ? e.error.stack : `${e.filename}:${e.lineno}:${e.colno}` });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r: unknown = e.reason;
    report({ kind: 'unhandledrejection', message: r instanceof Error ? r.message : String(r), stack: r instanceof Error ? r.stack : undefined });
  });
  // The event doesn't bubble, but a capturing listener on the document still sees it.
  document.addEventListener(
    'webglcontextlost',
    () => report({ kind: 'webgl', message: 'WebGL context lost', data: { visible: document.visibilityState === 'visible' } }),
    true,
  );
}

/** Boot has decided: hosted servers take reports, anything else drops them. */
export function setTelemetry(on: boolean) {
  enabled = on;
  if (on) for (const r of queue.splice(0)) post(r);
  else queue.length = 0;
}

/** A WebGL failure before the city could start, reported once. */
export function reportWebGL(message: string) {
  report({ kind: 'webgl', message });
}

/**
 * One performance report a session: how long boot took, and the average
 * frame rate over the next 30 seconds (skipped if the tab was hidden, since
 * browsers throttle hidden tabs).
 */
export function measurePerf(bootMs: number) {
  try {
    if (sessionStorage.getItem(PERF_KEY)) return;
    sessionStorage.setItem(PERF_KEY, '1');
  } catch {
    return;
  }
  let frames = 0;
  let hidden = document.visibilityState !== 'visible';
  const start = performance.now();
  const onVis = () => document.visibilityState !== 'visible' && (hidden = true);
  document.addEventListener('visibilitychange', onVis);
  const tick = (now: number) => {
    frames++;
    if (now - start < PERF_AFTER_MS) return void requestAnimationFrame(tick);
    document.removeEventListener('visibilitychange', onVis);
    if (hidden) return;
    report(
      {
        kind: 'perf',
        message: 'boot',
        data: {
          bootMs: Math.round(bootMs),
          fps: Math.round((frames / ((now - start) / 1000)) * 10) / 10,
          width: window.innerWidth,
          height: window.innerHeight,
          dpr: Math.round(window.devicePixelRatio * 100) / 100,
          cores: navigator.hardwareConcurrency || 0,
        },
      },
      false,
    );
  };
  requestAnimationFrame(tick);
}
