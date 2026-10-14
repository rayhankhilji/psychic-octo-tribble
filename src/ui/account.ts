/**
 * Your account: the plan and when it renews, billing (Stripe's portal),
 * what's connected, the name on the HQ sign, and signing out.
 */
import { ApiRequestError, type Api } from '../api/client.ts';
import { isPaid, LEGAL, type ConfigResponse, type Connections, type EmailPrefs, type MeResponse, type Provider, type WorldInfo } from '../api/contract.ts';
import { perInterval } from '../api/pricing.ts';
import { markSvg } from './brand.ts';
import { busy, focusFirst, longDate, makeDialog, message } from './dialogs.ts';
import { escape, showModal } from './dom.ts';
import { ICON } from './icons.ts';
import type { Timeline } from '../data/types.ts';
import { brandTile } from './brand-icons.ts';
import { githubFacts, housingNeed, revenueFacts, shippingFacts, shortDate, shortId, statusPill, stripeFacts, usersBrand, usersSummary, viaOf, type ConnectorFacts } from './onboarding.ts';

export interface AccountDeps {
  api: Api;
  config: ConfigResponse;
  me(): MeResponse;
  onConnections(c: Connections): void;
  onWorld(w: WorldInfo): void;
  go(url: string): void;
  openPlans(): void;
  openSetup(step: 1 | 2 | 3): void;
  /** Where to write for help (the server's config). */
  support: string | null;
  signOut(): Promise<void>;
  /** Ends the session without leaving the page (after deleting the account). */
  forget(): Promise<void>;
  /** Off to the plain demo. */
  leave(): void;
}

const moneyOf = (n: number, currency: string) => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${Math.round(n).toLocaleString('en-US')} ${currency.toUpperCase()}`;
  }
};
const monthYearOf = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

const PROVIDER_NAMES = { stripe: 'Stripe', github: 'GitHub', posthog: 'PostHog', ga4: 'Google Analytics' };

const link = (href: string, text: string) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;

/** The first letter of the email, for the avatar. */
export function initialOf(email: string | null): string {
  const c = email?.trim()[0];
  return c ? c.toUpperCase() : '·';
}

export class AccountDialog {
  private d: HTMLDialogElement;
  private deps: AccountDeps;
  private confirming: Provider | null = null;
  /** The founder's email choices, loaded when the menu opens (not on every page load). */
  private prefs: EmailPrefs | 'loading' | 'error' = 'loading';
  private live: HTMLElement;
  private body: HTMLElement;
  private nameSaved = false;
  /** The account view, or the "delete your account" confirmation. */
  private view: 'account' | 'delete' | 'goodbye' = 'account';
  private stillInstalled: { provider: 'stripe' | 'github'; url: string }[] = [];
  /** The numbers behind the connections (the city's own timeline), and whether it says a connection is dead. */
  private data: { state: 'loading' } | { state: 'ready'; t: Timeline } | { state: 'error'; err: unknown } | null = null;
  private manualSaved = false;

  constructor(deps: AccountDeps) {
    this.deps = deps;
    this.d = makeDialog('account-dialog', 'account-title', () => (this.confirming = null));
    this.body = document.createElement('div');
    this.live = document.createElement('p');
    this.live.className = 'sr-only';
    this.live.setAttribute('role', 'status');
    this.d.append(this.body, this.live);
    this.d.addEventListener('click', (e) => void this.onClick(e));
    this.d.addEventListener('submit', (e) => {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      if (form.classList.contains('delete-form')) void this.deleteAccount(form);
      else if (form.classList.contains('manual-form')) void this.saveManual(form);
      else void this.saveName(form);
    });
    this.d.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.pref) void this.savePref(t, t.dataset.pref as keyof EmailPrefs);
    });
    this.d.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.name === 'confirm') {
        const ok = t.value.trim().toLowerCase() === this.confirmWord().toLowerCase();
        const b = this.d.querySelector<HTMLButtonElement>('.delete-form button[type=submit]');
        if (b) b.disabled = !ok;
        return;
      }
      if (t.name === 'manual' && this.manualSaved) {
        this.manualSaved = false;
        const b = this.d.querySelector<HTMLButtonElement>('.manual-form button');
        if (b) (b.classList.remove('done'), (b.innerHTML = '<span class="label">Update</span>'));
        return;
      }
      if (!this.nameSaved) return;
      this.nameSaved = false;
      const b = this.d.querySelector<HTMLButtonElement>('.name-form button');
      if (b) (b.classList.remove('done'), (b.innerHTML = '<span class="label">Save</span>'));
    });
  }

  open() {
    this.view = 'account';
    this.confirming = null;
    this.nameSaved = false;
    this.prefs = 'loading';
    this.manualSaved = false;
    this.render();
    showModal(this.d);
    focusFirst(this.d, '[data-autofocus]');
    void this.loadPrefs();
    void this.loadData();
  }

  /** What the connections are feeding the city. Only the Connections section re-renders, so focus stays put. */
  private async loadData() {
    const c = this.deps.me().connections;
    if (!isPaid(this.deps.me().plan.status) || (!c.stripe && !c.github?.repo)) return void (this.data = null);
    this.data = { state: 'loading' };
    try {
      this.data = { state: 'ready', t: await this.deps.api.timeline() };
    } catch (err) {
      this.data = { state: 'error', err };
    }
    this.refreshConnections();
  }

  private refreshConnections() {
    const section = this.d.querySelector('[data-section=conn]');
    if (!section || this.view !== 'account') return;
    const active = document.activeElement as HTMLElement | null;
    const key = active && section.contains(active) ? (active.dataset.act ?? active.getAttribute('name')) : null;
    section.outerHTML = this.connectionsSection();
    if (key) this.d.querySelector<HTMLElement>(`[data-section=conn] [data-act="${key}"], [data-section=conn] [name="${key}"]`)?.focus({ preventScroll: true });
  }

  /** Stripe is "connected" but the city can't read it: the server said reconnect. */
  private get stripeBroken(): boolean {
    return this.data?.state === 'error' && this.data.err instanceof ApiRequestError && this.data.err.code === 'not_connected' && !!this.deps.me().connections.stripe?.livemode;
  }

  private connectionsSection(): string {
    const { connections: c, plan } = this.deps.me();
    const paid = isPaid(plan.status);
    const t = this.data?.state === 'ready' ? this.data.t : null;
    const loading = this.data?.state === 'loading';
    const scope = (f: ConnectorFacts) =>
      `<details class="acct-scope"><summary>${f.readOnly ? `${ICON.lock}Read-only` : `${ICON.alert}Read and write`} · what it reads</summary><ul>${f.reads.map((r) => `<li>${ICON.check}<span>${r}</span></li>`).join('')}${f.never.map((r) => `<li class="no">${ICON.close}<span>${r}</span></li>`).join('')}</ul><p>${escape(f.grant)}</p></details>`;
    const card = (key: string, brand: Parameters<typeof brandTile>[0], title: string, pill: string, detail: string, extra: string, actions: string, on: boolean, wide = '') => `
      <li class="conn acct-cx ${on ? 'on' : ''}" data-conn="${key}">
        ${brandTile(brand, 'md')}
        <span class="conn-text"><span class="acct-cx-title"><b>${title}</b>${pill}</span><small>${detail}</small></span>
        <span class="conn-actions">${actions}</span>
        ${wide || extra ? `<span class="acct-cx-wide">${wide}${extra}</span>` : ''}
      </li>`;
    const found = (text: string) => `<span class="acct-found${loading ? ' is-loading' : ''}">${text}</span>`;
    const confirm = (p: Provider, what: string) => `
      <li class="conn-confirm" role="group" aria-label="Confirm disconnect">
        ${ICON.alert}<span>${what}</span>
        <button class="btn sm ghost" type="button" data-act="keep">Keep it</button>
        <button class="btn sm danger" type="button" data-act="disconnect" data-provider="${p}" data-autofocus>Disconnect</button>
      </li>`;

    const sf = stripeFacts(viaOf(this.deps.config, 'stripe'));
    let stripe: string;
    if (c.stripe) {
      const r = t ? revenueFacts(t) : null;
      const broken = this.stripeBroken;
      const who = `${escape(c.stripe.name ?? shortId(c.stripe.account))}${c.stripe.name ? ` · ${escape(shortId(c.stripe.account))}` : ''} · ${c.stripe.livemode ? 'Live mode' : 'Test mode'} · since ${shortDate(c.stripe.connectedAt)}`;
      const wide = broken ? `<span class="acct-broken">${ICON.alert}<span>TinyTown can't read your subscriptions: the app was removed from your Stripe account, or its access expired. Your city and everything you built are safe; reconnect to bring it back.</span></span>` : '';
      const extra = broken
        ? ''
        : `${r && r.since != null ? found(`<b class="num">${moneyOf(r.mrr, r.currency)}</b> MRR · <b class="num">${r.customers.toLocaleString('en-US')}</b> paying customers · since ${monthYearOf(r.since)}`) : loading ? found('Reading your subscriptions…') : ''}${scope(sf)}`;
      stripe = card(
        'stripe',
        'stripe',
        'Stripe',
        statusPill(broken ? 'broken' : 'connected'),
        who,
        extra,
        `<button class="btn sm ${broken ? 'primary' : 'ghost'}" type="button" data-act="reconnect-stripe" ${broken ? 'data-autofocus' : ''}>${broken ? `${ICON.refresh}<span class="label">Reconnect</span>` : 'Reconnect'}</button><button class="btn sm ghost" type="button" data-act="ask" data-provider="stripe">Disconnect</button>`,
        !broken,
        wide,
      );
    } else {
      stripe = card('stripe', 'stripe', 'Stripe', '<span class="cx-status req">Required</span>', 'Not connected: your city runs on it', scope(sf), paid ? `<button class="btn sm" type="button" data-act="setup" data-step="1">Connect</button>` : '', false);
    }

    const gf = githubFacts(viaOf(this.deps.config, 'github'));
    let github: string;
    if (c.github) {
      const sh = t ? shippingFacts(t) : null;
      const extra = c.github.repo
        ? `${sh ? found(`<b class="num">${sh.releases.toLocaleString('en-US')}</b> ${sh.releases === 1 ? 'release' : 'releases'}${sh.latest ? `, latest ${escape(sh.latest.name)}` : ''} · <b class="num">${sh.commits30.toLocaleString('en-US')}</b> commits in 30 days`) : loading ? found('Reading releases and commits…') : ''}${scope(gf)}`
        : scope(gf);
      github = card(
        'github',
        'github',
        'GitHub',
        statusPill(c.github.repo ? 'connected' : 'off', true).replace('Optional', 'Pick a repository'),
        c.github.repo ? `${escape(c.github.repo)} · since ${shortDate(c.github.connectedAt)}` : 'Installed, no repository picked yet',
        extra,
        `<button class="btn sm ghost" type="button" data-act="setup" data-step="2">${c.github.repo ? 'Change' : 'Pick one'}</button><button class="btn sm ghost" type="button" data-act="ask" data-provider="github">Disconnect</button>`,
        !!c.github.repo,
      );
    } else {
      github = card('github', 'github', 'GitHub', statusPill('off', true), 'Not connected: releases add floors to your HQ', scope(gf), paid ? `<button class="btn sm" type="button" data-act="setup" data-step="2">Connect</button>` : '', false);
    }

    // Population: the source, what it counts today, and (for a number you set) a quick way to update it.
    const u = c.users;
    const last = t ? [...t.snapshots].reverse().find((x) => x.users != null) : null;
    const residents = u.source === 'customers' ? (t?.snapshots.at(-1)?.customers ?? null) : (last?.users ?? (u.source === 'manual' ? u.value : null));
    const mrr = t?.snapshots.at(-1)?.mrr ?? null;
    const house =
      residents != null
        ? found(
            `<b class="num">${residents.toLocaleString('en-US')}</b> residents${mrr != null ? ` · ${housingNeed(residents) <= mrr ? 'everyone has a home' : `homes for ${Math.max(100, Math.floor(mrr / 0.2)).toLocaleString('en-US')}`}` : ''}`,
          )
        : '';
    const manual =
      u.source === 'manual' && paid
        ? `<form class="manual-form" novalidate><label class="field"><span class="sr-only">Monthly active users</span><input type="number" name="manual" min="0" step="1" inputmode="numeric" value="${u.value}" aria-label="Monthly active users"></label><button class="btn sm ${this.manualSaved ? 'done' : ''}" type="submit">${this.manualSaved ? `${ICON.check}<span class="label">Updated</span>` : '<span class="label">Update</span>'}</button></form>`
        : '';
    const usersTitle = u.source === 'customers' ? 'Active users' : u.source === 'manual' ? 'Active users' : 'Active users';
    const users = card(
      'users',
      usersBrand(u),
      usersTitle,
      '',
      escape(usersSummary(u)),
      `${house}${manual}`,
      paid ? `<button class="btn sm ghost" type="button" data-act="setup" data-step="3">Change</button>${u.source === 'posthog' ? '<button class="btn sm ghost" type="button" data-act="ask" data-provider="posthog">Disconnect</button>' : ''}` : '',
      true,
    );
    return `<section class="acct-section" aria-labelledby="acct-conn" data-section="conn" ${loading ? 'aria-busy="true"' : ''}>
        <h3 id="acct-conn">Connections</h3>
        <ul class="conns">
          ${stripe}${this.confirming === 'stripe' ? confirm('stripe', 'Disconnect Stripe? Your city stops following your revenue until you reconnect.') : ''}
          ${github}${this.confirming === 'github' ? confirm('github', 'Disconnect GitHub? Releases and commits stop arriving; your HQ keeps the floors it has.') : ''}
          ${users}${this.confirming === 'posthog' ? confirm('posthog', 'Disconnect PostHog? Your population goes back to counting paying customers, and the saved key is deleted.') : ''}
        </ul>
        <div class="acct-error" data-slot="conn"></div>
      </section>`;
  }

  /** A number you set, updated in place: it counts from today, like the setup step. */
  private async saveManual(form: HTMLFormElement) {
    const input = form.querySelector<HTMLInputElement>('input[name=manual]')!;
    const raw = input.value.trim();
    this.slot('conn', '');
    if (!/^\d+$/.test(raw)) {
      this.slot('conn', message('bad', 'Enter your monthly active users as a whole number, like 12000.'));
      return input.focus();
    }
    const done = busy(form.querySelector('button'), 'Updating…');
    try {
      const c = await this.deps.api.setUsers({ source: 'manual', value: Number(raw) });
      this.deps.onConnections(c);
      this.manualSaved = true;
      this.live.textContent = `Active users set to ${Number(raw).toLocaleString('en-US')}, from today.`;
      void this.loadData();
      this.refreshConnections();
      this.d.querySelector<HTMLElement>('.manual-form button')?.focus();
    } catch (err) {
      done();
      this.slot('conn', message('bad', err instanceof Error ? err.message : "Couldn't update it. Try again."));
    }
  }

  private async loadPrefs() {
    try {
      this.prefs = await this.deps.api.emailPrefs();
    } catch {
      this.prefs = 'error';
    }
    // Only the switches change: re-rendering the whole menu would move the reader's focus.
    const section = this.d.querySelector('[data-section=email]');
    if (section && this.view === 'account') section.outerHTML = this.emailSection();
  }

  private emailSection(): string {
    const p = this.prefs;
    const ready = typeof p === 'object';
    const toggle = (key: keyof EmailPrefs, title: string, about: string) =>
      `<label class="switch"><input type="checkbox" role="switch" data-pref="${key}" ${ready && p[key] ? 'checked' : ''} ${ready ? '' : 'disabled'}><span class="switch-track"><i></i></span><span><b>${title}</b><small>${about}</small></span></label>`;
    return `<section class="acct-section" aria-labelledby="acct-email" data-section="email" ${p === 'loading' ? 'aria-busy="true"' : ''}>
        <h3 id="acct-email">Email</h3>
        <div class="acct-prefs">
          ${toggle('weeklyDigest', 'Your city this week', 'A Monday note with the week’s numbers and what you built.')}
          ${toggle('productUpdates', 'Product updates', 'New buildings, regions and features, a few times a year.')}
        </div>
        <p class="acct-fine">Receipts, payment problems and broken connections always come through.</p>
        <div class="acct-error" data-slot="email">${p === 'error' ? message('bad', 'Couldn’t load your email settings. Close and reopen to try again.') : ''}</div>
      </section>`;
  }

  private async savePref(input: HTMLInputElement, key: keyof EmailPrefs) {
    const on = input.checked;
    this.slot('email', '');
    input.disabled = true;
    try {
      this.prefs = await this.deps.api.setEmailPrefs({ [key]: on });
      this.live.textContent = `${key === 'weeklyDigest' ? 'Weekly email' : 'Product updates'} ${on ? 'on' : 'off'}.`;
    } catch (err) {
      input.checked = !on;
      this.slot('email', message('bad', err instanceof Error ? err.message : 'Couldn’t save that. Try again.'));
    } finally {
      input.disabled = false;
    }
  }

  private render() {
    if (this.view === 'delete') return this.renderDelete();
    if (this.view === 'goodbye') return this.renderGoodbye();
    const me = this.deps.me();
    const { plan, user, world } = me;
    const paid = isPaid(plan.status);
    const sale = this.deps.config.plans.find((p) => p.interval === plan.interval);
    const planName = plan.interval === 'year' ? 'Yearly' : plan.interval === 'month' ? 'Monthly' : 'No plan';
    const chip =
      plan.status === 'past_due'
        ? '<span class="chip" data-tone="bad">Payment failed</span>'
        : plan.cancelAtPeriodEnd && paid
          ? '<span class="chip" data-tone="warn">Cancels at period end</span>'
          : paid
            ? '<span class="chip" data-tone="good">Active</span>'
            : plan.status === 'canceled'
              ? '<span class="chip">Ended</span>'
              : '<span class="chip">None</span>';
    const when = plan.renewsAt
      ? plan.status === 'past_due'
        ? `Stripe is retrying your card. Update it to keep your city live.`
        : plan.cancelAtPeriodEnd
          ? `Ends on ${longDate(plan.renewsAt)}. You won't be charged again.`
          : paid
            ? `Renews on ${longDate(plan.renewsAt)}${sale ? ` for ${perInterval(sale).replace('/', ' a ')}` : ''}.`
            : `Ended on ${longDate(plan.renewsAt)}.`
      : paid
        ? 'Active.'
        : 'Pick a plan to open your own city.';
    this.body.className = 'dialog-body account';
    this.body.innerHTML = `
      <header class="dialog-head">
        <span class="avatar lg" aria-hidden="true">${escape(initialOf(user.email))}</span>
        <div><h2 id="account-title">Your account</h2><p>${user.email ? `Signed in as <b>${escape(user.email)}</b>` : 'Signed in'}</p></div>
        <button class="btn ghost icon-only close" type="button" data-act="close" aria-label="Close">${ICON.close}</button>
      </header>
      ${plan.status === 'past_due' ? message('bad', "Your last payment didn't go through. Your city stays live while Stripe retries; update your card to keep it that way.") : ''}
      <section class="acct-section" aria-labelledby="acct-plan">
        <h3 id="acct-plan">Plan</h3>
        <div class="acct-plan" data-status="${plan.status}">
          <span class="acct-plan-mark" aria-hidden="true">${markSvg({ cls: 'acct-mark' })}</span>
          <span class="acct-plan-text"><b>TinyTown ${planName} ${chip}</b><small>${when}</small></span>
          ${
            paid || plan.status === 'canceled'
              ? `<button class="btn ${plan.status === 'past_due' ? 'primary' : ''}" type="button" data-act="portal" ${paid ? 'data-autofocus' : ''}>${ICON.external}<span class="label">${plan.status === 'past_due' ? 'Update card' : 'Manage billing'}</span></button>`
              : ''
          }
          ${!paid ? `<button class="btn primary" type="button" data-act="plans" data-autofocus>Pick a plan</button>` : ''}
        </div>
        <div class="acct-error" data-slot="plan"></div>
        ${paid ? `<p class="acct-fine">${ICON.external}<span>Opens Stripe's billing portal: update your card, download invoices, or cancel.</span></p>` : ''}
      </section>
      ${this.connectionsSection()}
      ${
        paid
          ? `<section class="acct-section" aria-labelledby="acct-city">
              <h3 id="acct-city">Your city</h3>
              <form class="name-form">
                <label class="field"><span>Name on the HQ sign</span><input name="name" maxlength="22" autocomplete="off" spellcheck="false" value="${escape(world.name)}" required></label>
                <button class="btn ${this.nameSaved ? 'done' : ''}" type="submit">${this.nameSaved ? `${ICON.check}<span class="label">Saved</span>` : '<span class="label">Save</span>'}</button>
              </form>
              <div class="acct-error" data-slot="name"></div>
            </section>`
          : ''
      }
      ${this.emailSection()}
      <section class="acct-section" aria-labelledby="acct-data">
        <h3 id="acct-data">Your data</h3>
        <ul class="conns acct-rows">
          <li class="acct-row">
            <span class="conn-text"><b>Export</b><small>Everything TinyTown stores about you, as a JSON file.</small></span>
            <button class="btn sm" type="button" data-act="export">${ICON.download}<span class="label">Download my data</span></button>
          </li>
          <li class="acct-row is-danger">
            <span class="conn-text"><b>Delete account</b><small>Cancels your plan, disconnects everything and takes down your city. It can't be undone.</small></span>
            <button class="btn sm danger-quiet" type="button" data-act="delete-start">Delete account…</button>
          </li>
        </ul>
        <div class="acct-error" data-slot="data"></div>
      </section>
      <footer class="dialog-actions acct-foot">
        <button class="btn ghost" type="button" data-act="signout">${ICON.signOut}<span class="label">Sign out</span></button>
        <button class="btn" type="button" data-act="close">Done</button>
      </footer>
      <p class="acct-help">${this.deps.support ? `Need a hand? Write to <a href="mailto:${escape(this.deps.support)}">${escape(this.deps.support)}</a>. ` : ''}${link(LEGAL.terms, 'Terms')} · ${link(LEGAL.privacy, 'Privacy')} · ${link(LEGAL.refunds, 'Refunds')} · ${link(LEGAL.contact, 'Contact')}</p>`;
  }

  /** What to type to confirm: the account's email, or DELETE when it has none. */
  private confirmWord(): string {
    return this.deps.me().user.email ?? 'DELETE';
  }

  private renderGoodbye() {
    const name = { stripe: 'Stripe', github: 'GitHub' };
    const where = { stripe: 'your Stripe account', github: 'your GitHub account' };
    this.body.className = 'dialog-body auth-sent goodbye';
    this.body.innerHTML = `
      <div class="sent-art goodbye-art" aria-hidden="true"><span class="sent-envelope">${ICON.home}</span></div>
      <h2 id="account-title">Your account is deleted</h2>
      <p class="sent-lede">Your plan is cancelled, your connections are gone, and your city has been taken down. Thank you for building with us.</p>
      ${
        this.stillInstalled.length
          ? `<div class="goodbye-left">
              <p>One last thing only you can do: the TinyTown ${this.stillInstalled.length === 1 ? 'app is' : 'apps are'} still installed on your side.</p>
              <ul class="sent-tips">${this.stillInstalled
                .map((s) => `<li>${s.provider === 'stripe' ? ICON.card : ICON.github}<span><a href="${escape(s.url)}" target="_blank" rel="noopener">Remove the TinyTown app from ${where[s.provider]}</a>${ICON.external}<small> (${name[s.provider]} settings)</small></span></li>`)
                .join('')}</ul>
            </div>`
          : ''
      }
      <div class="dialog-actions"><button class="btn primary" type="button" data-act="leave" data-autofocus>Back to the demo</button></div>`;
  }

  private renderDelete() {
    const email = this.confirmWord();
    this.body.className = 'dialog-body account delete-account';
    this.body.innerHTML = `
      <header class="dialog-head">
        <span class="tile tone-bad">${ICON.alert}</span>
        <div><h2 id="account-title">Delete your account</h2><p>This can't be undone. Here's exactly what happens:</p></div>
        <button class="btn ghost icon-only close" type="button" data-act="close" aria-label="Close">${ICON.close}</button>
      </header>
      <ul class="sees delete-list">
        <li>${ICON.card}<span><b>Your plan is cancelled straight away,</b> with no refund for the time left on it.</span></li>
        <li>${ICON.unlink}<span><b>Stripe and GitHub are disconnected,</b> and any PostHog key we stored is deleted.</span></li>
        <li>${ICON.map}<span><b>Your city is deleted:</b> everything you built, its saves and its history.</span></li>
      </ul>
      <p class="delete-copy">Want a copy first? <button class="linkish" type="button" data-act="export">Download my data</button></p>
      <form class="delete-form" novalidate>
        <label class="field"><span>Type <b>${escape(email)}</b> to confirm</span><input name="confirm" type="email" autocomplete="off" spellcheck="false" placeholder="${escape(email)}" data-autofocus></label>
        <div class="acct-error" data-slot="delete"></div>
        <div class="dialog-actions">
          <button class="btn ghost" type="button" data-act="delete-cancel">Keep my account</button>
          <button class="btn danger" type="submit" disabled>Delete account</button>
        </div>
      </form>
      <div class="acct-error" data-slot="data"></div>`;
  }

  private async exportData(btn: HTMLButtonElement) {
    const done = busy(btn, 'Preparing…');
    try {
      const { blob, filename } = await this.deps.api.exportAccount();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      done();
      this.live.textContent = 'Your data is downloading.';
    } catch (err) {
      done();
      this.slot('data', message('bad', err instanceof Error ? err.message : "Couldn't prepare the download. Try again."));
    }
  }

  private async deleteAccount(form: HTMLFormElement) {
    const typed = (form.elements.namedItem('confirm') as HTMLInputElement).value.trim();
    const email = this.confirmWord();
    if (typed.toLowerCase() !== email.toLowerCase()) {
      this.slot('delete', message('bad', `Type ${email} exactly to confirm.`));
      return;
    }
    const btn = form.querySelector<HTMLButtonElement>('button[type=submit]');
    const done = busy(btn, 'Deleting…');
    form.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b !== btn && (b.disabled = true));
    try {
      const res = await this.deps.api.deleteAccount(this.deps.me().user.email ?? 'DELETE');
      this.stillInstalled = res.stillInstalled ?? [];
      await this.deps.forget();
      this.view = 'goodbye';
      this.render();
      this.live.textContent = 'Your account has been deleted.';
      focusFirst(this.d);
      // Closing the goodbye in any way leaves for the demo: the session is gone.
      this.d.addEventListener('close', () => this.deps.leave(), { once: true });
    } catch (err) {
      done();
      form.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.disabled = false));
      this.slot('delete', message('bad', err instanceof Error ? err.message : "Couldn't delete the account. Nothing was changed; try again."));
    }
  }

  private slot(name: string, html: string) {
    const s = this.d.querySelector(`[data-slot=${name}]`);
    if (s) s.innerHTML = html;
  }

  private async onClick(e: MouseEvent) {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const provider = btn.dataset.provider as Provider | undefined;
    if (act === 'portal' || act === 'reconnect-stripe') {
      const done = busy(btn, act === 'portal' ? 'Opening billing…' : 'Opening Stripe…');
      try {
        const { url } = act === 'portal' ? await this.deps.api.portal() : await this.deps.api.connectStripe();
        this.deps.go(url);
      } catch (err) {
        done();
        this.slot(act === 'portal' ? 'plan' : 'conn', message('bad', err instanceof Error ? err.message : 'That didn’t work. Try again.'));
      }
    }
    if (act === 'export') return this.exportData(btn);
    if (act === 'leave') return this.deps.leave();
    if (act === 'delete-start' || act === 'delete-cancel') {
      this.view = act === 'delete-start' ? 'delete' : 'account';
      this.render();
      focusFirst(this.d, act === 'delete-start' ? '[data-autofocus]' : '[data-act=delete-start]');
      return;
    }
    if (act === 'plans') {
      this.d.close();
      this.deps.openPlans();
    }
    if (act === 'setup') {
      this.d.close();
      this.deps.openSetup(Number(btn.dataset.step) as 1 | 2 | 3);
    }
    if (act === 'ask' && provider) {
      this.confirming = provider;
      this.render();
      focusFirst(this.d, '[data-act=disconnect]');
    }
    if (act === 'keep') {
      const p = this.confirming;
      this.confirming = null;
      this.render();
      focusFirst(this.d, `[data-act=ask][data-provider=${p}]`);
    }
    if (act === 'disconnect' && provider) {
      const done = busy(btn, 'Disconnecting…');
      try {
        await this.deps.api.disconnect(provider);
        const c = this.deps.me().connections;
        this.deps.onConnections(provider === 'posthog' ? { ...c, users: { source: 'customers' } } : { ...c, [provider]: null });
        this.confirming = null;
        this.live.textContent = `${(PROVIDER_NAMES as Record<string, string>)[provider] ?? 'That'} disconnected.`;
        this.render();
        focusFirst(this.d, `[data-conn=${provider === 'posthog' ? 'users' : provider}] button`);
      } catch (err) {
        done();
        this.slot('conn', message('bad', err instanceof Error ? err.message : "Couldn't disconnect. Try again."));
      }
    }
    if (act === 'signout') {
      busy(btn, 'Signing out…');
      await this.deps.signOut();
    }
  }

  private async saveName(form: HTMLFormElement) {
    const input = form.querySelector<HTMLInputElement>('input[name=name]')!;
    const name = input.value.trim();
    this.slot('name', '');
    if (!name) {
      this.slot('name', message('bad', 'Give your city a name, up to 22 characters.'));
      return input.focus();
    }
    const done = busy(form.querySelector('button'), 'Saving…');
    try {
      const w = await this.deps.api.patchWorld({ name });
      this.deps.onWorld(w);
      this.nameSaved = true;
      const b = form.querySelector<HTMLButtonElement>('button')!;
      done();
      b.classList.add('done');
      b.innerHTML = `${ICON.check}<span class="label">Saved</span>`;
      this.live.textContent = `Renamed to ${name}.`;
    } catch (err) {
      done();
      this.slot('name', message('bad', err instanceof Error ? err.message : "Couldn't save the name. Try again."));
    }
  }
}
