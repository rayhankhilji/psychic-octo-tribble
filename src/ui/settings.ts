/**
 * Settings: graphics, sound, the time of day, motion and help, in one
 * dialog (a bottom sheet on phones). Every change applies as it's made and is
 * remembered in this browser: graphics and motion through the settings store
 * (the Stage and the motion helpers listen), sound through the sound engine.
 * Loaded the first time someone opens it.
 */
import './settings.css';
import type { Sound } from '../audio/engine.ts';
import { makeDialog } from './dialogs.ts';
import { escape, showModal } from './dom.ts';
import { ICON } from './icons.ts';
import { GEAR_ICON as GEAR } from './hud.ts';
import {
  autoStatus,
  DEFAULTS,
  graphicsStatus,
  onGraphics,
  onSettings,
  QUALITY_NAMES,
  settings,
  TIME_PREVIEWS,
  updateSettings,
  type GraphicsStatus,
  type MotionMode,
  type QualityMode,
} from './settings-store.ts';

export interface SettingsDeps {
  sound: Sound;
  /** Holds the city at a time (a `TIME_PREVIEWS` label) or hands it back to the clock; null when the app can't. */
  setTime: ((label: string | null) => void) | null;
  /** What the clock chip is previewing right now, if anything. */
  previewing(): string | null;
}

/** The tour (src/ui/tour.ts), if this build has one. A glob, so a build without it still compiles. */
const tour: (() => Promise<{ startTour?: () => unknown }>) | undefined = import.meta.glob<{ startTour?: () => unknown }>('./tour.ts')['./tour.ts'];

const coarse = () => matchMedia('(pointer: coarse)').matches;

/** One honest line per level: what it actually turns on and off (Stage.applyQuality, Post.setQuality). */
function qualityLines(): Record<QualityMode, string> {
  return {
    auto: coarse() ? 'Starts at Balanced on this screen and steps down if frames run long.' : 'Starts at High and steps down if frames run long.',
    high: 'Soft contact shadows, the smoothest edges, the crispest sun shadows.',
    medium: 'Everything but the contact shadows, at about half the work.',
    low: 'Fewer pixels, rougher edges, lighter shadows, no blur.',
  };
}

const MOTION: { value: MotionMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'reduce', label: 'Reduce' },
  { value: 'full', label: 'Full' },
];

const SHORTCUTS: [keys: string[], what: string][] = [
  [['Space'], 'Play or pause'],
  [['←', '→'], 'A day back or on'],
  [['Shift', '←'], 'A week back'],
  [['B'], 'Build'],
  [['H'], 'Your home'],
  [['G'], 'Go to a place'],
  [['Q', 'E'], 'Rotate'],
  [['+', '−'], 'Zoom'],
  [['M'], 'Sound on or off'],
  [['?'], 'How to play'],
  [[','], 'Settings'],
  [['Esc'], 'Close'],
];

/** "6:30 PM", kept on one line. */
const hourLabel = (hour: number) =>
  new Date(2000, 0, 1, Math.floor(hour), Math.round((hour % 1) * 60)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, '\u00a0');

const systemReduces = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

let panel: SettingsPanel | null = null;

export function openSettings(deps: SettingsDeps) {
  panel ??= new SettingsPanel(deps);
  panel.open();
}

class SettingsPanel {
  private d: HTMLDialogElement;
  private deps: SettingsDeps;
  private live: HTMLElement;
  private stop: (() => void)[] = [];

  constructor(deps: SettingsDeps) {
    this.deps = deps;
    this.d = makeDialog('settings-dialog', 'settings-title', () => this.closed());
    this.d.innerHTML = this.markup();
    this.live = this.d.querySelector('[data-slot=live]')!;
    this.d.addEventListener('change', (e) => this.onChange(e.target as HTMLInputElement));
    this.d.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.name === 'volume') this.onVolume(t, false);
    });
    this.d.addEventListener('scroll', () => this.d.classList.toggle('is-scrolled', this.d.scrollTop > 4), { passive: true });
    this.d.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'reset') this.reset();
      if (act === 'tour') this.startTour();
    });
  }

  open() {
    this.sync();
    this.stop.push(
      onSettings(() => this.sync()),
      onGraphics((s) => this.syncGraphics(s)),
    );
    showModal(this.d);
    // Focus lands on the chosen quality, the first thing people come here for.
    this.d.querySelector<HTMLInputElement>('input[name=quality]:checked')?.focus({ preventScroll: true });
  }

  private closed() {
    for (const fn of this.stop.splice(0)) fn();
  }

  // ── Markup ───────────────────────────────────────────────────────────

  private markup(): string {
    const lines = qualityLines();
    const option = (value: QualityMode) => `
      <label class="set-option">
        <input type="radio" name="quality" value="${value}">
        <span class="set-radio" aria-hidden="true"></span>
        <span class="set-text">
          <b>${QUALITY_NAMES[value]}${value === 'auto' ? '<span class="set-tag">Recommended</span>' : ''}</b>
          <small>${lines[value]}</small>
          ${value === 'auto' ? '<small class="set-status" data-slot="auto-status"></small>' : ''}
        </span>
      </label>`;
    const toggle = (name: string, title: string, about: string) => `
      <label class="switch set-switch">
        <input type="checkbox" role="switch" name="${name}">
        <span class="switch-track"><i></i></span>
        <span><b>${title}</b><small data-slot="${name}-about">${about}</small></span>
      </label>`;
    const seg = (name: string, label: string, items: { value: string; label: string; sub?: string }[]) => `
      <div class="set-seg" role="radiogroup" aria-label="${label}" data-n="${items.length}">
        ${items
          .map(
            (it) => `<label class="set-seg-item">
              <input type="radio" name="${name}" value="${it.value}">
              <span><b>${it.label}</b>${it.sub ? `<small class="num">${it.sub}</small>` : ''}</span>
            </label>`,
          )
          .join('')}
      </div>`;
    const keys = SHORTCUTS.map(([k, what]) => `<div class="set-key"><span class="set-kbds">${k.map((x) => `<kbd>${escape(x)}</kbd>`).join('')}</span><span>${what}</span></div>`).join('');
    return `
      <div class="dialog-body settings">
        <header class="dialog-head">
          <span class="tile" aria-hidden="true">${GEAR}</span>
          <div><h2 id="settings-title">Settings</h2><p>Changes apply as you make them and stay in this browser.</p></div>
          <button class="btn ghost icon-only close" type="button" data-act="close" aria-label="Close">${ICON.close}</button>
        </header>

        <section class="set-section" aria-labelledby="set-graphics">
          <h3 id="set-graphics">Graphics</h3>
          <div class="set-card" role="radiogroup" aria-labelledby="set-graphics">
            ${(['auto', 'high', 'medium', 'low'] as const).map(option).join('')}
          </div>
          <p class="set-note" data-slot="forced" hidden></p>
          <div class="set-card set-pad">
            ${toggle('tiltShift', 'Tilt-shift blur', 'The miniature look: the top and bottom of the view go soft.')}
            ${toggle('shadows', 'Sun shadows', 'Buildings, trees and boats cast shadows. Off saves a whole pass over the city.')}
          </div>
        </section>

        <section class="set-section" aria-labelledby="set-sound">
          <h3 id="set-sound">Sound</h3>
          <div class="set-card set-pad">
            ${toggle('sound', 'Sound', 'The bay’s ambience, and a soft note for each thing that happens.')}
            <label class="set-slider">
              <span class="set-slider-label">Volume</span>
              <input type="range" name="volume" min="0" max="100" step="1" aria-describedby="set-volume-out">
              <output class="num" id="set-volume-out" data-slot="volume"></output>
            </label>
          </div>
        </section>

        <section class="set-section" aria-labelledby="set-time" data-slot="time-section">
          <h3 id="set-time">Time of day</h3>
          ${seg('time', 'Time of day', [{ value: '', label: 'My clock', sub: 'Local' }, ...TIME_PREVIEWS.map((p) => ({ value: p.label, label: p.label, sub: hourLabel(p.hour) }))])}
          <p class="set-note" data-slot="time-note"></p>
        </section>

        <section class="set-section" aria-labelledby="set-motion">
          <h3 id="set-motion">Reduce motion</h3>
          ${seg('motion', 'Reduce motion', MOTION)}
          <p class="set-note" data-slot="motion-note"></p>
        </section>

        <section class="set-section" aria-labelledby="set-help">
          <h3 id="set-help">Help</h3>
          ${
            tour
              ? `<div class="set-card set-pad set-row">
                  <span><b>The tour</b><small>A minute around the city: what the numbers mean and what to build.</small></span>
                  <button class="btn sm set-quiet" type="button" data-act="tour">${ICON.replay}<span class="label">Replay the tour</span></button>
                </div>`
              : ''
          }
          <div class="set-card set-keys" aria-label="Keyboard shortcuts" role="group">${keys}</div>
        </section>

        <footer class="set-foot">
          <button class="btn sm ghost" type="button" data-act="reset">Reset to defaults</button>
          <button class="btn sm set-quiet" type="button" data-act="close">Done</button>
        </footer>
        <p class="sr-only" role="status" data-slot="live"></p>
      </div>`;
  }

  // ── State → controls ─────────────────────────────────────────────────

  private input(name: string, value?: string): HTMLInputElement | null {
    return this.d.querySelector<HTMLInputElement>(`input[name="${name}"]${value === undefined ? '' : `[value="${value}"]`}`);
  }

  private slot(name: string): HTMLElement {
    return this.d.querySelector<HTMLElement>(`[data-slot="${name}"]`)!;
  }

  private sync() {
    const s = settings();
    this.input('quality', s.quality)!.checked = true;
    this.input('tiltShift')!.checked = s.tiltShift;
    this.input('shadows')!.checked = s.shadows;
    this.input('motion', s.motion)!.checked = true;

    const sound = this.deps.sound;
    this.input('sound')!.checked = sound.on;
    const vol = this.input('volume')!;
    vol.value = String(Math.round(sound.volume * 100));
    vol.disabled = !sound.on;
    this.onVolume(vol, false);

    const time = this.slot('time-section');
    time.hidden = !this.deps.setTime;
    this.input('time', s.time ?? '')!.checked = true;
    const held = TIME_PREVIEWS.find((p) => p.label === s.time);
    const now = hourLabel(new Date().getHours() + new Date().getMinutes() / 60);
    const preview = this.deps.previewing();
    let note = held ? `TinyTown opens at ${held.label.toLowerCase()} (${hourLabel(held.hour)}) every time.` : `The city follows your local clock, day into night. It’s ${now} here.`;
    if (preview && preview !== (s.time ?? null)) note += ` The clock chip is previewing ${preview.toLowerCase()} for now.`;
    this.slot('time-note').textContent = note;

    const sys = systemReduces();
    this.slot('motion-note').textContent =
      s.motion === 'system'
        ? sys
          ? 'Your system asks for less motion, so the camera stays still, numbers snap and panels appear without sliding.'
          : 'Following your system, which allows full motion.'
        : s.motion === 'reduce'
          ? 'The camera stays still, numbers snap into place and panels appear without sliding.'
          : sys
            ? 'The camera drifts and numbers count, even though your system asks for less. Panels still follow your system.'
            : 'The camera drifts, numbers count and panels slide.';
    this.syncGraphics(graphicsStatus());
  }

  private syncGraphics(g: GraphicsStatus | null) {
    if (!g) return;
    const s = settings();
    const status = this.slot('auto-status');
    status.textContent = s.quality === 'auto' && !g.forced ? autoStatus(g.level, g.coarse) : '';
    status.hidden = !status.textContent;
    const forced = this.slot('forced');
    forced.hidden = !g.forced;
    if (g.forced) forced.innerHTML = `${ICON.info}<span>The page address sets ${QUALITY_NAMES[g.forced]} (<code>?quality=${g.forced}</code>) until you pick one here.</span>`;
    // Battery saver draws no blur at all, so the switch has nothing to do there.
    const low = g.level === 'low';
    const tilt = this.input('tiltShift')!;
    tilt.disabled = low;
    tilt.closest('label')!.classList.toggle('is-off', low);
    this.slot('tiltShift-about').textContent = low ? `${QUALITY_NAMES.low} leaves it out to save work.` : 'The miniature look: the top and bottom of the view go soft.';
  }

  // ── Controls → state ─────────────────────────────────────────────────

  private onChange(t: HTMLInputElement) {
    switch (t.name) {
      case 'quality': {
        const q = t.value as QualityMode;
        updateSettings({ quality: q });
        this.say(`Graphics: ${QUALITY_NAMES[q]}.`);
        break;
      }
      case 'tiltShift':
        updateSettings({ tiltShift: t.checked });
        break;
      case 'shadows':
        updateSettings({ shadows: t.checked });
        break;
      case 'sound':
        this.deps.sound.toggle(t.checked);
        this.sync();
        break;
      case 'volume':
        this.onVolume(t, true);
        break;
      case 'time': {
        const label = t.value || null;
        updateSettings({ time: label });
        this.deps.setTime?.(label);
        this.sync();
        this.say(label ? `Time of day: held at ${label.toLowerCase()}.` : 'Time of day: following your clock.');
        break;
      }
      case 'motion':
        updateSettings({ motion: t.value as MotionMode });
        break;
    }
  }

  /** Dragging sets the level as it goes; letting go plays a tick at the new level. */
  private onVolume(t: HTMLInputElement, done: boolean) {
    const v = Number(t.value);
    this.slot('volume').textContent = `${v}%`;
    t.style.setProperty('--fill', `${v}%`);
    if (t.disabled) return;
    this.deps.sound.setVolume(v / 100);
    if (done) this.deps.sound.ui('tick');
  }

  private reset() {
    updateSettings({ ...DEFAULTS });
    this.deps.setTime?.(null);
    this.deps.sound.setVolume(1);
    this.sync();
    this.say('Settings reset to their defaults.');
  }

  private startTour() {
    if (!tour) return;
    this.d.close();
    void tour()
      .then((m) => m.startTour?.())
      .catch(() => {});
  }

  private say(text: string) {
    this.live.textContent = text;
  }
}
