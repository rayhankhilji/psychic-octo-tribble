/**
 * After paying: connect Stripe (required), GitHub (optional, then pick a
 * repository), and say where active users come from. Each step shows what's
 * connected and exactly what TinyTown can see. Installs leave for Stripe or
 * GitHub and come back to `/?connected=…`, which reopens this at the next step.
 */
import type { Api } from '../api/client.ts';
import type { ConfigResponse, Connections, MeResponse, ReposResponse, UsersRequest } from '../api/contract.ts';
import { busy, focusFirst, makeDialog, message } from './dialogs.ts';
import { compact, escape, showModal } from './dom.ts';
import { ICON } from './icons.ts';

type Step = 1 | 2 | 3;
type Repo = ReposResponse['repos'][number];
type UsersChoice = UsersRequest['source'];

export interface OnboardingDeps {
  api: Api;
  config: ConfigResponse;
  me(): MeResponse;
  /** The connections changed: keep the shell's copy of /api/me current. */
  onConnections(c: Connections): void;
  go(url: string): void;
  /** "Build my city" (or "Back to my city" when it's already open behind us). */
  finish(): void;
  /** True when the founder's city is already on screen. */
  inWorld: boolean;
}

const POSTHOG_HOSTS = [
  { id: 'us', label: 'US cloud', host: 'https://us.posthog.com' },
  { id: 'eu', label: 'EU cloud', host: 'https://eu.posthog.com' },
  { id: 'self', label: 'Self-hosted', host: '' },
] as const;

/** "acct_1PxN…ghtjar": enough to recognise, not the whole thing. */
function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 9)}…${id.slice(-4)}` : id;
}

function shortDate(t: number): string {
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function hostLabel(host: string): string {
  try {
    return new URL(host).host;
  } catch {
    return host;
  }
}

export class OnboardingDialog {
  private d: HTMLDialogElement;
  private deps: OnboardingDeps;
  private step: Step = 1;
  private welcome = false;
  private error: { step: Step; text: string } | null = null;
  private skippedGithub = false;
  private repos: Repo[] | null = null;
  private reposError: string | null = null;
  private query = '';
  private changingRepo = false;
  private usersChoice: UsersChoice = 'customers';
  private posthogRegion: (typeof POSTHOG_HOSTS)[number]['id'] = 'us';
  private replacingKey = false;
  private saved: Step | null = null;
  private stripeBroken = false;
  private live: HTMLElement;
  private body: HTMLElement;

  constructor(deps: OnboardingDeps) {
    this.deps = deps;
    this.d = makeDialog('onboard-dialog', 'onboard-title');
    this.body = document.createElement('div');
    this.live = document.createElement('p');
    this.live.className = 'sr-only';
    this.live.setAttribute('role', 'status');
    this.d.append(this.body, this.live);
    this.d.addEventListener('click', (e) => void this.onClick(e));
    this.d.addEventListener('input', (e) => this.onInput(e));
    this.d.addEventListener('change', (e) => this.onChange(e));
    this.d.addEventListener('keydown', (e) => this.onKey(e));
    this.d.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.saveUsers(e.target as HTMLFormElement);
    });
  }

  open(opts: { step?: Step; welcome?: boolean; error?: string | null; stripeBroken?: boolean } = {}) {
    const c = this.deps.me().connections;
    this.welcome = !!opts.welcome;
    this.stripeBroken = !!opts.stripeBroken;
    this.step = opts.step ?? (c.stripe ? (c.github?.repo ? 3 : 2) : 1);
    this.error = opts.error ? { step: this.step, text: opts.error } : null;
    this.usersChoice = c.users.source;
    if (c.users.source === 'posthog') {
      const host = c.users.host;
      this.posthogRegion = POSTHOG_HOSTS.find((h) => h.host && h.host === host)?.id ?? 'self';
    }
    this.render();
    showModal(this.d);
    focusFirst(this.d, `[data-step="${this.step}"] [data-autofocus], [data-step="${this.step}"] .step-toggle`);
    if (this.step === 2 && c.github && !c.github.repo) void this.loadRepos();
  }

  private get c(): Connections {
    return this.deps.me().connections;
  }

  private render() {
    const c = this.c;
    const done = (s: Step) => (s === 1 ? !!c.stripe && !this.stripeBroken : s === 2 ? !!c.github?.repo : c.users.source !== 'customers' || this.saved === 3);
    const state = (s: Step) => (s === this.step ? 'current' : done(s) ? 'done' : 'todo');
    const node = (s: Step) => `<span class="step-node" aria-hidden="true">${done(s) ? ICON.check : s}</span>`;
    const badge = (s: Step) =>
      s === 1 && this.stripeBroken
        ? '<span class="status req">Needs reconnecting</span>'
        : done(s)
        ? `<span class="status on">${ICON.check}${s === 3 ? 'Set' : 'Connected'}</span>`
        : s === 1
          ? '<span class="status req">Required</span>'
          : s === 2 && this.skippedGithub
            ? '<span class="status">Skipped</span>'
            : '<span class="status">Optional</span>';
    const summary = (s: Step) => {
      if (s === 1) return c.stripe ? `${escape(c.stripe.name ?? `Stripe account ${shortId(c.stripe.account)}`)}${c.stripe.livemode ? '' : ' · test mode'}` : 'MRR and paying customers, read-only';
      if (s === 2) return c.github?.repo ? escape(c.github.repo) : c.github ? 'Installed: pick a repository' : 'Releases and commits, read-only';
      const u = c.users;
      return u.source === 'manual' ? `${u.value.toLocaleString('en-US')} you set` : u.source === 'posthog' ? `PostHog · ${escape(hostLabel(u.host))}` : 'Paying customers';
    };
    const step = (s: Step, title: string, content: () => string) => `
      <li class="step" data-step="${s}" data-state="${state(s)}">
        ${node(s)}
        <div class="step-main">
          <button class="step-toggle" type="button" data-goto="${s}" aria-expanded="${s === this.step}" aria-controls="step-${s}-body">
            <span class="step-title"><b>${title}</b><small>${summary(s)}</small></span>
            ${badge(s)}
          </button>
          <div class="step-body" id="step-${s}-body" ${s === this.step ? '' : 'hidden'}>
            ${this.error?.step === s ? message('bad', this.error.text) : ''}
            ${s === this.step ? content() : ''}
          </div>
        </div>
      </li>`;
    const ready = !!c.stripe && !this.stripeBroken;
    this.body.className = 'dialog-body onboard';
    this.body.innerHTML = `
      <header class="dialog-head">
        <span class="tile ${this.welcome ? 'tone-good' : 'tone-brand'}">${this.welcome ? ICON.check : ICON.plug}</span>
        <div>
          <h2 id="onboard-title">${this.welcome ? "You're in. Thank you." : this.stripeBroken ? 'Reconnect Stripe' : 'Set up your city'}</h2>
          <p>${this.welcome ? 'Your plan is active. Three short steps and your city runs on your real numbers.' : this.stripeBroken ? 'Your city and everything you built are safe. It just needs Stripe again to keep up with your revenue.' : 'Three short steps and your city runs on your real numbers. About two minutes.'}</p>
        </div>
        <button class="btn ghost icon-only close" type="button" data-act="close" aria-label="Close">${ICON.close}</button>
      </header>
      <ol class="steps">
        ${step(1, 'Connect Stripe', () => this.stripeStep())}
        ${step(2, 'Connect GitHub', () => this.githubStep())}
        ${step(3, 'Where your active users come from', () => this.usersStep())}
      </ol>
      <footer class="dialog-actions onboard-foot">
        <span class="onboard-hint">${
          ready
            ? `${ICON.check}<span>Stripe is connected. You can change any of this later in your account.</span>`
            : `${ICON.info}<span>${this.stripeBroken ? 'Reconnect Stripe to bring your city back.' : 'Connect Stripe to build your city: it runs on your revenue.'}</span>`
        }</span>
        <button class="btn primary lg" type="button" data-act="finish" ${ready ? '' : 'disabled aria-disabled="true"'}>${ICON.build}<span class="label">${this.deps.inWorld ? 'Back to my city' : this.stripeBroken ? 'Open my city' : 'Build my city'}</span></button>
      </footer>`;
  }

  // ── Step 1: Stripe ─────────────────────────────────────────────────────

  private stripeStep(): string {
    const s = this.c.stripe;
    const sees = `
      <ul class="sees">
        <li class="can">${ICON.eye}<span><b>Can see</b> your subscriptions: their prices, status and when each started or ended. That's how your city counts MRR and paying customers.</span></li>
        <li class="cannot">${ICON.lock}<span><b>Can't see</b> card or bank details, and can't charge, refund or change anything.</span></li>
      </ul>`;
    if (!s) {
      if (!this.deps.config.connect.stripe) return message('info', "Connecting Stripe isn't set up on this server yet.");
      return `
        <p class="step-lede">Install the TinyTown app on your Stripe account and approve it. It's read-only.</p>
        ${sees}
        <div class="step-actions">
          <button class="btn primary" type="button" data-act="connect-stripe" data-autofocus>${ICON.external}<span class="label">Install on Stripe</span></button>
          <span class="step-aside">You'll approve it on Stripe, then come straight back here.</span>
        </div>`;
    }
    return `
      <div class="connected-row">
        <span class="tile tone-good">${ICON.card}</span>
        <span class="connected-text"><b>${escape(s.name ?? 'Your Stripe account')}</b><small class="num">${escape(shortId(s.account))} · ${s.livemode ? 'Live mode' : 'Test mode'} · since ${shortDate(s.connectedAt)}</small></span>
        ${this.stripeBroken ? '' : `<button class="btn sm ghost" type="button" data-act="connect-stripe">${ICON.refresh}<span class="label">Reconnect</span></button>`}
      </div>
      ${this.stripeBroken ? `<div class="step-actions"><button class="btn primary" type="button" data-act="connect-stripe" data-autofocus>${ICON.refresh}<span class="label">Reconnect on Stripe</span></button><span class="step-aside">Same app, same read-only access.</span></div>` : ''}
      ${s.livemode ? '' : message('warn', "This is a test-mode account. Test data never moves your city: install the app in live mode to use your real revenue.")}
      ${this.stripeBroken ? '' : `<div class="step-actions"><button class="btn" type="button" data-goto="2" data-autofocus>Next: GitHub${ICON.arrowRight}</button></div>`}`;
  }

  // ── Step 2: GitHub ─────────────────────────────────────────────────────

  private githubStep(): string {
    const g = this.c.github;
    if (!this.deps.config.connect.github) {
      return `${message('info', "Connecting GitHub isn't set up on this server yet.")}<div class="step-actions"><button class="btn" type="button" data-goto="3" data-autofocus>Next${ICON.arrowRight}</button></div>`;
    }
    if (!g) {
      return `
        <p class="step-lede">Every release adds a floor to your HQ, and commits speed up the train. Skip it and your city simply runs on revenue.</p>
        <ul class="sees">
          <li class="can">${ICON.eye}<span><b>Reads</b> the repositories you share with it, and only ever looks at their releases and commit history.</span></li>
          <li class="cannot">${ICON.lock}<span><b>Can't</b> push code, open issues or pull requests, or change any settings.</span></li>
        </ul>
        <div class="step-actions">
          <button class="btn primary" type="button" data-act="connect-github" data-autofocus>${ICON.github}<span class="label">Install on GitHub</span></button>
          <button class="btn ghost" type="button" data-act="skip-github">Skip for now</button>
        </div>`;
    }
    if (g.repo && !this.changingRepo) {
      return `
        <div class="connected-row">
          <span class="tile tone-good">${ICON.repo}</span>
          <span class="connected-text"><b>${escape(g.repo)}</b><small class="num">Releases and commits · since ${shortDate(g.connectedAt)}</small></span>
          <button class="btn sm ghost" type="button" data-act="change-repo">Change</button>
        </div>
        <div class="step-actions"><button class="btn" type="button" data-goto="3" data-autofocus>Next: active users${ICON.arrowRight}</button></div>`;
    }
    return `
      <p class="step-lede">Installed. Now pick the repository your releases come from.</p>
      ${this.repoPicker()}`;
  }

  private repoPicker(): string {
    if (this.reposError) {
      return `${message('bad', this.reposError)}<div class="step-actions"><button class="btn" type="button" data-act="retry-repos">${ICON.refresh}<span class="label">Try again</span></button></div>`;
    }
    if (!this.repos) {
      return `<div class="repo-picker is-loading" aria-busy="true"><div class="repo-search">${ICON.search}<input type="search" disabled placeholder="Loading your repositories…" aria-label="Find a repository"></div><ul class="repo-list" aria-hidden="true">${'<li class="repo skeleton"><i></i><i></i></li>'.repeat(4)}</ul></div>`;
    }
    return `
      <div class="repo-picker">
        <label class="repo-search">${ICON.search}<input type="search" name="repo-q" placeholder="Find a repository" aria-label="Find a repository" aria-controls="repo-list" autocomplete="off" spellcheck="false" value="${escape(this.query)}" data-autofocus></label>
        <ul class="repo-list" id="repo-list" role="listbox" aria-label="Repositories">${this.repoOptions()}</ul>
        <p class="repo-foot"><span class="num">${this.repos.length.toLocaleString('en-US')} ${this.repos.length === 1 ? 'repository' : 'repositories'} shared with TinyTown.</span> <button class="linkish" type="button" data-act="connect-github">Share more on GitHub</button></p>
      </div>`;
  }

  private repoOptions(): string {
    const q = this.query.toLowerCase();
    const list = (this.repos ?? []).filter((r) => r.fullName.toLowerCase().includes(q));
    if (!list.length) return `<li class="repo-empty" role="presentation">No repository matches “${escape(this.query)}”. Only the ones you shared with the app are listed.</li>`;
    const current = this.c.github?.repo;
    return list
      .map(
        (r, i) => `
        <li class="repo" role="option" id="repo-${i}" tabindex="-1" data-repo="${escape(r.fullName)}" aria-selected="${r.fullName === current}">
          ${ICON.repo}
          <span class="repo-name"><b>${escape(r.fullName.split('/')[1] ?? r.fullName)}</b><small>${escape(r.fullName.split('/')[0] ?? '')} · ${escape(r.defaultBranch)}</small></span>
          <span class="chip">${r.private ? 'Private' : 'Public'}</span>
        </li>`,
      )
      .join('');
  }

  private async loadRepos() {
    this.repos = null;
    this.reposError = null;
    try {
      this.repos = await this.deps.api.githubRepos();
    } catch (err) {
      this.reposError = err instanceof Error ? err.message : "Couldn't load your repositories.";
    }
    if (this.step === 2 && this.d.open) {
      this.render();
      focusFirst(this.d, '[data-step="2"] input[name=repo-q], [data-step="2"] [data-act=retry-repos]');
    }
  }

  private async pickRepo(li: HTMLElement) {
    const repo = li.dataset.repo!;
    if (li.getAttribute('aria-busy')) return;
    li.setAttribute('aria-busy', 'true');
    li.classList.add('is-busy');
    li.insertAdjacentHTML('beforeend', '<span class="spinner" aria-hidden="true"></span>');
    try {
      const c = await this.deps.api.setGithubRepo(repo);
      this.deps.onConnections(c);
      this.changingRepo = false;
      this.error = null;
      this.step = 3;
      this.live.textContent = `Watching ${repo} for releases and commits.`;
      this.render();
      focusFirst(this.d, '[data-step="3"] [data-autofocus]');
    } catch (err) {
      li.removeAttribute('aria-busy');
      li.classList.remove('is-busy');
      li.querySelector('.spinner')?.remove();
      this.error = { step: 2, text: err instanceof Error ? err.message : "Couldn't save that repository." };
      this.render();
    }
  }

  // ── Step 3: active users ───────────────────────────────────────────────

  private usersStep(): string {
    const u = this.c.users;
    const choice = this.usersChoice;
    const opt = (id: UsersChoice, title: string, text: string, extra = '') => `
      <label class="choice-card" data-choice="${id}">
        <input type="radio" name="users" value="${id}" ${choice === id ? 'checked' : ''} ${choice === id ? 'data-autofocus' : ''}>
        <span class="plan-radio" aria-hidden="true"></span>
        <span class="choice-text"><b>${title}</b><small>${text}</small></span>
      </label>${choice === id ? extra : ''}`;
    const manualValue = u.source === 'manual' ? String(u.value) : '';
    const manual = `
      <div class="choice-extra">
        <label class="field"><span>Monthly active users</span><input type="number" name="value" min="0" step="1" inputmode="numeric" required value="${manualValue}" placeholder="e.g. 12000"></label>
        <p class="field-help">Update it whenever you like. Your city houses everyone you count.</p>
      </div>`;
    const ph = u.source === 'posthog' ? u : null;
    const posthog =
      ph && !this.replacingKey
        ? `<div class="choice-extra">
            <div class="connected-row">
              <span class="tile tone-good">${ICON.users}</span>
              <span class="connected-text"><b>Project ${escape(ph.projectId)}</b><small class="num">${escape(hostLabel(ph.host))} · key saved, never shown · since ${shortDate(ph.connectedAt)}</small></span>
              <button class="btn sm ghost" type="button" data-act="replace-key">${ICON.key}<span class="label">Replace key</span></button>
            </div>
          </div>`
        : `<div class="choice-extra">
            <div class="segmented" role="radiogroup" aria-label="PostHog region">${POSTHOG_HOSTS.map((h) => `<label><input type="radio" name="region" value="${h.id}" ${this.posthogRegion === h.id ? 'checked' : ''}><span>${h.label}</span></label>`).join('')}</div>
            ${this.posthogRegion === 'self' ? `<label class="field"><span>PostHog address</span><input type="url" name="host" required placeholder="https://posthog.yourstartup.com" value="${escape(ph?.host ?? '')}" spellcheck="false"></label>` : ''}
            <div class="field-row">
              <label class="field"><span>Project ID</span><input name="projectId" required inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="12345" value="${escape(ph?.projectId ?? '')}"></label>
              <label class="field grow"><span>Personal API key</span><input type="password" name="apiKey" required autocomplete="off" spellcheck="false" placeholder="phx_…"></label>
            </div>
            <p class="field-help">${ICON.lock}<span>Give the key read access to this project only. It goes straight to our server, is stored encrypted, and is never shown again, not even to you.</span></p>
          </div>`;
    const saveLabel = this.saved === 3 ? `${ICON.check}<span class="label">Saved</span>` : '<span class="label">Save</span>';
    return `
      <p class="step-lede">Everyone who uses your product lives in your city. Where should we count them?</p>
      <form class="users-form" novalidate>
        <fieldset class="choices">
          <legend class="sr-only">Count active users from</legend>
          ${opt('customers', 'Paying customers', 'Everyone who pays lives in the city. Exact, and nothing to set up.')}
          ${opt('manual', 'A number you set', 'Your monthly active users, typed in. Good if you count them elsewhere.', manual)}
          ${this.deps.config.connect.posthog ? opt('posthog', 'PostHog', 'Monthly active users from your PostHog project, kept up to date.', posthog) : ''}
        </fieldset>
        <div class="users-error"></div>
        <div class="step-actions"><button class="btn ${this.saved === 3 ? 'done' : ''}" type="submit">${saveLabel}</button>${u.source === 'customers' && this.usersChoice === 'customers' ? '<span class="step-aside">Paying customers is the default.</span>' : ''}</div>
      </form>`;
  }

  private async saveUsers(form: HTMLFormElement) {
    const slot = form.querySelector('.users-error')!;
    slot.innerHTML = '';
    const fd = new FormData(form);
    const fail = (text: string, name?: string) => {
      slot.innerHTML = message('bad', text);
      if (name) form.querySelector<HTMLInputElement>(`[name=${name}]`)?.focus();
    };
    let req: UsersRequest;
    if (this.usersChoice === 'manual') {
      const value = Number(fd.get('value'));
      if (!String(fd.get('value') ?? '').trim() || !Number.isFinite(value) || value < 0) return fail('Enter how many monthly active users you have, as a whole number.', 'value');
      req = { source: 'manual', value: Math.round(value) };
    } else if (this.usersChoice === 'posthog') {
      if (this.c.users.source === 'posthog' && !this.replacingKey) {
        this.saved = 3;
        return this.render();
      }
      const host = this.posthogRegion === 'self' ? String(fd.get('host') ?? '').trim() : POSTHOG_HOSTS.find((h) => h.id === this.posthogRegion)!.host;
      const projectId = String(fd.get('projectId') ?? '').trim();
      const apiKey = String(fd.get('apiKey') ?? '').trim();
      if (!/^https?:\/\/\S+\.\S+/.test(host)) return fail('Enter the full address of your PostHog, starting with https://', 'host');
      if (!/^\d+$/.test(projectId)) return fail('The project ID is the number in your PostHog project settings.', 'projectId');
      if (apiKey.length < 8) return fail('Paste a personal API key from your PostHog settings.', 'apiKey');
      req = { source: 'posthog', host, projectId, apiKey };
    } else {
      req = { source: 'customers' };
    }
    const done = busy(form.querySelector<HTMLButtonElement>('button[type=submit]'), req.source === 'posthog' ? 'Checking with PostHog…' : 'Saving…');
    try {
      const c = await this.deps.api.setUsers(req);
      this.deps.onConnections(c);
      this.replacingKey = false;
      this.saved = 3;
      this.live.textContent = 'Saved.';
      this.render();
      focusFirst(this.d, '[data-act=finish]');
    } catch (err) {
      done();
      fail(err instanceof Error ? err.message : "Couldn't save that. Try again.");
    }
  }

  // ── Events ─────────────────────────────────────────────────────────────

  private async onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const goto = t.closest<HTMLElement>('[data-goto]');
    if (goto) {
      this.step = Number(goto.dataset.goto) as Step;
      this.saved = null;
      this.render();
      const c = this.c;
      if (this.step === 2 && c.github && (!c.github.repo || this.changingRepo) && !this.repos) void this.loadRepos();
      focusFirst(this.d, `[data-step="${this.step}"] [data-autofocus], [data-step="${this.step}"] .step-toggle`);
      return;
    }
    const repo = t.closest<HTMLElement>('[data-repo]');
    if (repo) return this.pickRepo(repo);
    const btn = t.closest<HTMLButtonElement>('[data-act]');
    switch (btn?.dataset.act) {
      case 'connect-stripe':
      case 'connect-github': {
        const which = btn.dataset.act === 'connect-stripe' ? 'stripe' : 'github';
        const done = busy(btn, `Opening ${which === 'stripe' ? 'Stripe' : 'GitHub'}…`);
        try {
          const { url } = which === 'stripe' ? await this.deps.api.connectStripe() : await this.deps.api.connectGithub();
          this.deps.go(url);
        } catch (err) {
          done();
          this.error = { step: which === 'stripe' ? 1 : 2, text: err instanceof Error ? err.message : "Couldn't start connecting. Try again." };
          this.render();
        }
        return;
      }
      case 'skip-github':
        this.skippedGithub = true;
        this.step = 3;
        this.render();
        focusFirst(this.d, '[data-step="3"] [data-autofocus]');
        return;
      case 'change-repo':
        this.changingRepo = true;
        this.render();
        if (!this.repos) void this.loadRepos();
        else focusFirst(this.d, 'input[name=repo-q]');
        return;
      case 'retry-repos':
        this.render();
        return void this.loadRepos();
      case 'replace-key':
        this.replacingKey = true;
        this.render();
        focusFirst(this.d, 'input[name=projectId]');
        return;
      case 'finish':
        if (btn.disabled) return;
        this.d.close();
        this.deps.finish();
        return;
    }
  }

  private onInput(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.name === 'repo-q') {
      this.query = t.value;
      const list = this.d.querySelector('#repo-list');
      if (list) list.innerHTML = this.repoOptions();
    }
    if (this.saved === 3 && t.closest('.users-form')) {
      this.saved = null;
      const b = this.d.querySelector<HTMLButtonElement>('.users-form button[type=submit]');
      if (b) {
        b.classList.remove('done');
        b.innerHTML = '<span class="label">Save</span>';
      }
    }
  }

  private onChange(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.name === 'users') {
      this.usersChoice = t.value as UsersChoice;
      this.saved = null;
      this.render();
      focusFirst(this.d, `input[name=users][value=${t.value}]`);
    }
    if (t.name === 'region') {
      this.posthogRegion = t.value as typeof this.posthogRegion;
      this.render();
      focusFirst(this.d, this.posthogRegion === 'self' ? 'input[name=host]' : `input[name=region][value=${t.value}]`);
    }
  }

  /** The repository list is a listbox: arrows move, Enter picks, typing goes back to the search. */
  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    const list = this.d.querySelector<HTMLElement>('#repo-list');
    if (!list) return;
    const options = [...list.querySelectorAll<HTMLElement>('[role=option]')];
    if (!options.length) return;
    const i = options.indexOf(t);
    if (t instanceof HTMLInputElement && t.name === 'repo-q' && e.key === 'ArrowDown') {
      e.preventDefault();
      options[0]!.focus();
    } else if (i >= 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const next = options[i + (e.key === 'ArrowDown' ? 1 : -1)];
      if (next) next.focus();
      else if (e.key === 'ArrowUp') this.d.querySelector<HTMLInputElement>('input[name=repo-q]')?.focus();
    } else if (i >= 0 && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      void this.pickRepo(t);
    } else if (i >= 0 && e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      this.d.querySelector<HTMLInputElement>('input[name=repo-q]')?.focus();
    }
  }
}

/** For the account dialog: one line on where the population comes from. */
export function usersSummary(u: Connections['users']): string {
  if (u.source === 'manual') return `${compact(u.value)} active users, set by you`;
  if (u.source === 'posthog') return `PostHog project ${u.projectId} on ${hostLabel(u.host)}`;
  return 'Paying customers from Stripe';
}
