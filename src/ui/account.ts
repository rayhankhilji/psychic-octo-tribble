/**
 * Your account: the plan and when it renews, billing (Stripe's portal),
 * what's connected, the name on the HQ sign, and signing out.
 */
import type { Api } from '../api/client.ts';
import { isPaid, LEGAL, type ConfigResponse, type Connections, type EmailPrefs, type MeResponse, type Provider, type WorldInfo } from '../api/contract.ts';
import { perInterval } from '../api/pricing.ts';
import { busy, focusFirst, longDate, makeDialog, message } from './dialogs.ts';
import { escape, showModal } from './dom.ts';
import { ICON } from './icons.ts';
import { usersSummary } from './onboarding.ts';

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
    this.render();
    showModal(this.d);
    focusFirst(this.d, '[data-autofocus]');
    void this.loadPrefs();
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
    const { plan, connections: c, user, world } = me;
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
    const row = (icon: string, title: string, detail: string, actions: string, on: boolean, key: string) => `
      <li class="conn ${on ? 'on' : ''}" data-conn="${key}">
        <span class="tile ${on ? 'tone-good' : ''}">${icon}</span>
        <span class="conn-text"><b>${title}</b><small>${detail}</small></span>
        <span class="conn-actions">${actions}</span>
      </li>`;
    const confirm = (p: Provider, what: string) => `
      <li class="conn-confirm" role="group" aria-label="Confirm disconnect">
        ${ICON.alert}<span>${what}</span>
        <button class="btn sm ghost" type="button" data-act="keep">Keep it</button>
        <button class="btn sm danger" type="button" data-act="disconnect" data-provider="${p}" data-autofocus>Disconnect</button>
      </li>`;
    const stripe = c.stripe
      ? row(ICON.card, 'Stripe', `${escape(c.stripe.name ? `${c.stripe.name} · ${c.stripe.account}` : c.stripe.account)}${c.stripe.livemode ? '' : ' · test mode'}`, `<button class="btn sm ghost" type="button" data-act="reconnect-stripe">Reconnect</button><button class="btn sm ghost" type="button" data-act="ask" data-provider="stripe">Disconnect</button>`, true, 'stripe')
      : row(ICON.card, 'Stripe', 'Not connected: your city needs it', paid ? `<button class="btn sm" type="button" data-act="setup" data-step="1">Connect</button>` : '', false, 'stripe');
    const github = c.github
      ? row(ICON.github, 'GitHub', c.github.repo ? escape(c.github.repo) : 'Installed, no repository picked', `<button class="btn sm ghost" type="button" data-act="setup" data-step="2">${c.github.repo ? 'Change' : 'Pick one'}</button><button class="btn sm ghost" type="button" data-act="ask" data-provider="github">Disconnect</button>`, true, 'github')
      : row(ICON.github, 'GitHub', 'Optional: releases and commits', paid ? `<button class="btn sm" type="button" data-act="setup" data-step="2">Connect</button>` : '', false, 'github');
    const users = row(
      ICON.users,
      'Active users',
      escape(usersSummary(c.users)),
      paid ? `<button class="btn sm ghost" type="button" data-act="setup" data-step="3">Change</button>${c.users.source === 'posthog' ? '<button class="btn sm ghost" type="button" data-act="ask" data-provider="posthog">Disconnect</button>' : ''}` : '',
      true,
      'users',
    );
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
        <div class="acct-plan">
          <span class="tile tone-brand">${ICON.sparkle}</span>
          <span class="acct-plan-text"><b>TinyTown · ${planName} ${chip}</b><small>${ICON.calendar}<span>${when}</span></small></span>
          ${
            paid || plan.status === 'canceled'
              ? `<button class="btn ${plan.status === 'past_due' ? 'primary' : ''}" type="button" data-act="portal" ${paid ? 'data-autofocus' : ''}>${ICON.external}<span class="label">${plan.status === 'past_due' ? 'Update card' : 'Manage billing'}</span></button>`
              : ''
          }
          ${!paid ? `<button class="btn primary" type="button" data-act="plans" data-autofocus>Pick a plan</button>` : ''}
        </div>
        <div class="acct-error" data-slot="plan"></div>
        ${paid ? `<p class="acct-fine">${plan.status === 'past_due' ? 'Update card' : 'Manage billing'} opens Stripe's billing portal: update your card, switch plans, get your invoices, or Cancel plan.</p>` : ''}
      </section>
      <section class="acct-section" aria-labelledby="acct-conn">
        <h3 id="acct-conn">Connections</h3>
        <ul class="conns">
          ${stripe}${this.confirming === 'stripe' ? confirm('stripe', 'Disconnect Stripe? Your city stops following your revenue until you reconnect.') : ''}
          ${github}${this.confirming === 'github' ? confirm('github', 'Disconnect GitHub? Releases and commits stop arriving; your HQ keeps the floors it has.') : ''}
          ${users}${this.confirming === 'posthog' ? confirm('posthog', 'Disconnect PostHog? Your population goes back to counting paying customers, and the saved key is deleted.') : ''}
        </ul>
        <div class="acct-error" data-slot="conn"></div>
      </section>
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
        <div class="acct-data">
          <button class="btn" type="button" data-act="export">${ICON.download}<span class="label">Download my data</span></button>
          <button class="btn ghost danger-text" type="button" data-act="delete-start">Delete account…</button>
        </div>
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
        this.live.textContent = `${{ stripe: 'Stripe', github: 'GitHub', posthog: 'PostHog' }[provider]} disconnected.`;
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
