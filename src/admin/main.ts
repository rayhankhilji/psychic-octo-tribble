/**
 * The admin console (admin.html): sign in with the game's Supabase session,
 * then Overview, Waitlist, Users and the Audit log, routed by the URL hash.
 * Plain TypeScript and DOM. Keyboard: `/` searches, `g` then o, w, u or a
 * moves between pages, Escape closes dialogs.
 *
 * `?mock` swaps the API for an in-memory launch (mock.ts) in development or
 * with `?debug`, so the console can be reviewed without a database.
 * `?theme=day|night` pins the theme (for screenshots).
 */
import './admin.css';
import type { ConfigResponse } from '../api/contract.ts';
import { AdminApi, AdminError, type FetchLike } from './api.ts';
import { auditPage } from './audit.ts';
import { mockAuth, supabaseAuth, type ConsoleAuth } from './auth.ts';
import { overviewPage } from './overview.ts';
import type { AdminMe } from './types.ts';
import { ICON, esc, initial, toast } from './ui.ts';
import { userPage, usersPage } from './users.ts';
import type { View } from './view.ts';
import { waitlistPage } from './waitlist.ts';

const params = new URLSearchParams(location.search);
const useMock = params.has('mock') && (import.meta.env.DEV || params.has('debug'));
const app = document.getElementById('app')!;

// ─── Theme ────────────────────────────────────────────────────────────────

const THEME_KEY = 'tinytown-admin-theme';
function savedTheme(): string | null {
  const forced = params.get('theme');
  if (forced === 'day' || forced === 'night') return forced;
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}
function applyTheme(theme: string | null) {
  if (theme === 'day' || theme === 'night') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
function isNight(): boolean {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'night' : matchMedia('(prefers-color-scheme: dark)').matches;
}
applyTheme(savedTheme());

// ─── Boot ─────────────────────────────────────────────────────────────────

async function boot() {
  let auth: ConsoleAuth;
  let fetchImpl: FetchLike | undefined;
  if (useMock) {
    const { mockFetch } = await import('./mock.ts');
    auth = mockAuth();
    fetchImpl = mockFetch;
  } else {
    let cfg: ConfigResponse;
    try {
      cfg = (await (await fetch('/api/config')).json()) as ConfigResponse;
    } catch {
      return gate('Can’t reach the server', '<p>The TinyTown API didn’t answer. Check the deployment, then reload.</p>');
    }
    if (!cfg.hosted || !cfg.supabase) return gate('Accounts aren’t set up here', '<p>This server runs without Supabase, so there’s nothing to administer. See docs/SETUP.md.</p>');
    auth = supabaseAuth(cfg);
  }

  const email = await auth.email();
  if (!email) return signIn(auth);
  const api = new AdminApi(() => auth.token(), fetchImpl);
  let me: AdminMe;
  try {
    me = await api.me();
  } catch (err) {
    if (err instanceof AdminError && (err.status === 404 || err.status === 401)) {
      return gate(
        'Not an admin account',
        `<p>You’re signed in as <b>${esc(email)}</b>, which isn’t on this server’s admin list (ADMIN_EMAILS).</p><button class="btn" type="button" data-signout>Sign out</button>`,
        auth,
      );
    }
    return gate('The console didn’t load', `<p>${esc(err instanceof Error ? err.message : 'Unknown error')}</p>`);
  }
  shell(api, me, auth);
}

function gate(title: string, body: string, auth?: ConsoleAuth) {
  app.innerHTML = `<div class="gate"><div class="card gate-card"><img src="/mark.svg" alt="" /><h1>${title}</h1>${body}</div></div>`;
  app.querySelector('[data-signout]')?.addEventListener('click', async () => {
    await auth?.signOut();
    location.reload();
  });
}

function signIn(auth: ConsoleAuth) {
  gate(
    'TinyTown admin',
    `<p>Sign in with an admin account.</p>
     ${auth.redirectError ? `<p class="form-error" role="alert">${esc(auth.redirectError)}</p>` : ''}
     <div style="display:grid;gap:8px">
       <button class="btn" type="button" data-oauth="google">Continue with Google</button>
       <button class="btn" type="button" data-oauth="github">${ICON.github}Continue with GitHub</button>
     </div>
     ${
       auth.emailAllowed
         ? `<div class="or">or</div>
            <form data-email>
              <label class="field"><span>Email</span><input class="input" type="email" name="email" required autocomplete="email" /></label>
              <button class="btn primary" type="submit">Email me a sign-in link</button>
              <p class="form-error" role="alert" hidden></p>
            </form>`
         : '<p class="note">Email links need the bot check, which lives in the app: sign in on TinyTown and come back here.</p>'
     }`,
  );
  app.querySelectorAll<HTMLButtonElement>('[data-oauth]').forEach((b) =>
    b.addEventListener('click', () => auth.signInWithOAuth(b.dataset.oauth as 'google' | 'github').catch((err) => toast(err.message, 'bad'))),
  );
  app.querySelector<HTMLFormElement>('[data-email]')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const error = form.querySelector<HTMLElement>('.form-error')!;
    const email = String(new FormData(form).get('email') ?? '').trim();
    try {
      await auth.signInWithEmail(email);
      form.innerHTML = `<p>If <b>${esc(email)}</b> has an account, a sign-in link is on its way. Open it in this browser.</p>`;
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : 'That didn’t work.';
      error.hidden = false;
    }
  });
}

// ─── The shell ────────────────────────────────────────────────────────────

const NAV: { key: string; href: string; label: string; icon: string }[] = [
  { key: 'o', href: '#/overview', label: 'Overview', icon: ICON.chart },
  { key: 'w', href: '#/waitlist', label: 'Waitlist', icon: ICON.flag },
  { key: 'u', href: '#/users', label: 'Users', icon: ICON.users },
  { key: 'a', href: '#/audit', label: 'Audit log', icon: ICON.shield },
];

function shell(api: AdminApi, me: AdminMe, auth: ConsoleAuth) {
  document.title = 'TinyTown admin';
  app.innerHTML = `
    <div class="shell">
      <aside class="side">
        <a class="brand" href="#/overview"><img src="/mark.svg" alt="" /><span class="brand-word">TinyTown</span><span class="brand-tag">Admin</span></a>
        <nav class="nav" aria-label="Console">
          ${NAV.map((x) => `<a href="${x.href}">${x.icon}<span>${x.label}</span><kbd>g ${x.key}</kbd></a>`).join('')}
        </nav>
        <div class="side-foot">
          <p class="hint"><kbd>/</kbd> search<br /><kbd>g</kbd> then <kbd>o</kbd> <kbd>w</kbd> <kbd>u</kbd> <kbd>a</kbd> to move</p>
          <div class="who"><span class="avatar" aria-hidden="true">${initial(me.email)}</span><span title="${esc(me.email)}">${esc(me.email)}</span></div>
          <div class="side-actions">
            <button class="btn ghost sm" type="button" data-theme-toggle aria-label="Switch theme"></button>
            <button class="btn ghost sm" type="button" data-signout>${ICON.signOut}Sign out</button>
          </div>
        </div>
      </aside>
      <main class="main">
        <header class="top"><span data-crumb></span><h1 data-title></h1><span class="badge ${me.access === 'waitlist' ? 'info' : 'good'}">${me.access === 'waitlist' ? 'Waitlist mode' : 'Open to all'}</span><span class="spacer"></span><span class="stamp" data-stamp></span></header>
        <div data-view></div>
      </main>
    </div>`;

  const titleEl = app.querySelector<HTMLElement>('[data-title]')!;
  const crumbEl = app.querySelector<HTMLElement>('[data-crumb]')!;
  const stampEl = app.querySelector<HTMLElement>('[data-stamp]')!;
  const holder = app.querySelector<HTMLElement>('[data-view]')!;
  const themeBtn = app.querySelector<HTMLButtonElement>('[data-theme-toggle]')!;
  const drawTheme = () => (themeBtn.innerHTML = isNight() ? `${ICON.sun}Day` : `${ICON.moon}Night`);
  drawTheme();
  themeBtn.addEventListener('click', () => {
    const next = isNight() ? 'day' : 'night';
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Remembered for this visit only.
    }
    drawTheme();
  });
  app.querySelector('[data-signout]')!.addEventListener('click', async () => {
    await auth.signOut();
    location.reload();
  });

  let generation = 0;
  const route = () => {
    const mine = ++generation;
    const hash = location.hash.replace(/^#/, '') || '/overview';
    // A fresh element per page, so a page's listeners leave with it.
    const root = document.createElement('div');
    holder.replaceChildren(root);
    stampEl.textContent = '';
    for (const a of app.querySelectorAll<HTMLAnchorElement>('.nav a')) {
      const active = hash.startsWith(a.getAttribute('href')!.slice(1));
      if (active) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    const view: View = {
      api,
      me,
      root,
      title(text, crumb) {
        titleEl.textContent = text;
        crumbEl.innerHTML = crumb ? `<a class="crumb" href="${crumb.href}">${esc(crumb.label)}</a> <span class="muted">/</span>` : '';
        document.title = `${text} · TinyTown admin`;
      },
      stamp: (text) => (stampEl.textContent = text),
      stale: () => mine !== generation,
    };
    const user = /^\/users\/([0-9a-fA-F-]{36})$/.exec(hash);
    if (user) void userPage(view, user[1]!);
    else if (hash.startsWith('/waitlist')) void waitlistPage(view);
    else if (hash.startsWith('/users')) void usersPage(view);
    else if (hash.startsWith('/audit')) void auditPage(view);
    else void overviewPage(view);
    window.scrollTo(0, 0);
  };
  addEventListener('hashchange', route);
  route();

  // Whole table rows open their link.
  app.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('a, button, input, select, textarea')) return;
    const row = t.closest<HTMLElement>('tr.link[data-href]');
    if (row) location.hash = row.dataset.href!;
  });

  // Keyboard: `/` to search, `g` then a letter to move.
  let pendingG = 0;
  addEventListener('keydown', (e) => {
    const typing = (e.target as HTMLElement).closest('input, textarea, select, [contenteditable]');
    if (typing || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return;
    if (e.key === '/') {
      const search = app.querySelector<HTMLInputElement>('[data-search]');
      e.preventDefault();
      if (search) search.focus();
      else location.hash = '#/users';
      return;
    }
    if (e.key === 'g') {
      pendingG = Date.now();
      return;
    }
    if (Date.now() - pendingG < 1200) {
      const target = NAV.find((x) => x.key === e.key);
      pendingG = 0;
      if (target) location.hash = target.href;
    }
  });
}

void boot();
