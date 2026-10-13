/**
 * The hosted shell around the game: the calm "Make it yours" call to action
 * on the demo, the account button, the past-due banner, and the dialogs for
 * signing in, picking a plan, connecting data and managing the account.
 * It never touches the world; main.ts decides what's on screen.
 */
import './hosted.css';
import type { AuthProvider } from '../api/auth.ts';
import type { Opening, BootScreen } from '../api/boot.ts';
import type { Api, ApiRequestError } from '../api/client.ts';
import { isPaid, type ConfigResponse, type Connections, type MeResponse, type PlanInterval, type WorldInfo } from '../api/contract.ts';
import { formatPrice, priceSheet } from '../api/pricing.ts';
import { AccountDialog, initialOf } from './account.ts';
import { busy } from './dialogs.ts';
import { el, escape } from './dom.ts';
import type { Hud } from './hud.ts';
import { ICON } from './icons.ts';
import { OnboardingDialog } from './onboarding.ts';
import { PlanDialog } from './plans.ts';
import { SignInDialog } from './signin.ts';
import { WaitlistDialog } from './waitlist.ts';

const INTENT_KEY = 'tinytown:plan-intent';
const BANNER_KEY = 'tinytown:pastdue-dismissed';
const WAITLIST_KEY = 'tinytown:waitlist-shown';

export interface HostedDeps {
  api: Api;
  auth: AuthProvider;
  config: ConfigResponse;
  me: MeResponse | null;
  screen: BootScreen;
  hud: Hud;
  /** Where to land after signing out (the plain demo). */
  signedOutUrl: string;
  /** The signed-in email, known even when /api/me says the waitlist hasn't reached it. */
  email: string | null;
}

/** The plan someone picked before signing in, so we can carry on where they were. */
export function takePlanIntent(): PlanInterval | null {
  try {
    const v = localStorage.getItem(INTENT_KEY);
    localStorage.removeItem(INTENT_KEY);
    return v === 'month' || v === 'year' ? v : null;
  } catch {
    return null;
  }
}

function setPlanIntent(v: PlanInterval) {
  try {
    localStorage.setItem(INTENT_KEY, v);
  } catch {
    // Without storage they'll pick again after signing in.
  }
}

export class HostedShell {
  private deps: HostedDeps;
  private me: MeResponse | null;
  private screen: BootScreen;
  private cta: HTMLElement | null = null;
  private accountBtn: HTMLButtonElement | null = null;
  private banner: HTMLElement | null = null;
  private signin?: SignInDialog;
  private plans?: PlanDialog;
  private onboard?: OnboardingDialog;
  private account?: AccountDialog;
  private waitlist?: WaitlistDialog;
  /** Stripe is "connected" but its access has died: the call to action and setup say reconnect. */
  private stripeBroken = false;

  constructor(deps: HostedDeps) {
    this.deps = deps;
    this.me = deps.me;
    this.screen = deps.screen;
    // A 401 mid-session: the token expired or was revoked. A 402: the plan lapsed.
    deps.api.setHooks({
      onUnauthenticated: () => this.sessionEnded(),
      onPaymentRequired: (err) => this.planNeeded(err),
      onNotInvited: () => this.openWaitlist(),
    });
    const brand = deps.hud.brandButton;
    brand.dataset.tipTitle = this.screen.kind === 'world' ? 'Your city' : 'A demo city';
    brand.dataset.tip = this.screen.kind === 'world' ? 'Your account, connections and the name on your HQ sign.' : "This startup is made up. Make it yours and the city runs on your startup's real numbers.";
    this.render();
  }

  /** The brand button and the old "Connect" both lead here. */
  primary() {
    if (this.screen.kind === 'world') return this.openAccount();
    this.ctaAction();
  }

  // ── Top bar ────────────────────────────────────────────────────────────

  private render() {
    const hud = this.deps.hud;
    this.cta?.remove();
    this.cta = null;
    if (this.screen.kind === 'demo') {
      this.cta = this.makeCta(this.screen.cta);
      hud.topEl.insertBefore(this.cta, hud.toolsEl);
    }
    if (this.me && !this.accountBtn) {
      const email = this.me.user.email;
      this.accountBtn = el(
        'button',
        { class: 'btn ghost icon-only account-btn', type: 'button', 'aria-label': `Your account${email ? ` (${email})` : ''}`, 'data-tip-title': 'Your account', 'data-tip': email ?? 'Plan, billing and connections' },
        `<span class="avatar" aria-hidden="true">${escape(initialOf(email))}</span>`,
      );
      this.accountBtn.addEventListener('click', () => this.openAccount());
      hud.toolsEl.append(el('span', { class: 'tool-sep account-sep', 'aria-hidden': 'true' }), this.accountBtn);
    }
    const pastDue = this.screen.kind === 'world' && this.screen.pastDue;
    if (pastDue && !this.banner && !this.bannerDismissed()) this.showPastDue();
  }

  private makeCta(kind: 'signin' | 'plan' | 'onboard' | 'world' | 'waitlist'): HTMLElement {
    const sheet = priceSheet(this.deps.config.plans);
    const price = sheet.month ? `${formatPrice(sheet.month.amount, sheet.month.currency)}/mo` : sheet.year ? `${formatPrice(sheet.year.amount, sheet.year.currency)}/yr` : '';
    const wrap = el('div', { class: 'cta card', 'data-cta': kind, role: 'group', 'aria-label': 'Your own city' });
    const c = this.me?.connections;
    const doneSteps = c ? [!!c.stripe, !!c.github?.repo, c.users.source !== 'customers'].filter(Boolean).length : 0;
    const main =
      kind === 'onboard' && this.stripeBroken
        ? { label: 'Reconnect Stripe', aside: '', icon: ICON.refresh, tip: "Stripe's access has stopped working. Reconnect it and your city comes back." }
        : kind === 'onboard'
        ? { label: 'Finish setup', aside: `${Math.min(3, doneSteps + 1)} of 3`, icon: ICON.plug, tip: 'Connect Stripe and your city runs on your real revenue.' }
        : kind === 'world'
          ? { label: 'Open my city', aside: '', icon: ICON.arrowRight, tip: 'Leave the demo for your own city.' }
          : kind === 'waitlist'
            ? { label: "You're on the list", aside: '', icon: ICON.check, tip: "We'll email you the moment your spot opens." }
          : { label: 'Make it yours', aside: price, icon: ICON.sparkle, tip: `Your startup's real numbers, your own city. ${price ? `${price.replace('/mo', ' a month')} or ${sheet.year ? formatPrice(sheet.year.amount, sheet.year.currency) : ''} a year. ` : ''}No free trial; the demo stays free.` };
    if (kind === 'signin') {
      const signIn = el('button', { class: 'btn ghost cta-signin', type: 'button' }, '<span class="label">Sign in</span>');
      signIn.addEventListener('click', () => this.openSignIn());
      wrap.append(signIn, el('span', { class: 'cta-sep', 'aria-hidden': 'true' }));
    }
    const btn = el('button', { class: 'btn cta-main', type: 'button', 'data-tip': main.tip }, `${main.icon}<span class="label">${main.label}</span>${main.aside ? `<span class="cta-aside num">${main.aside}</span>` : ''}`);
    btn.addEventListener('click', () => this.ctaAction());
    wrap.append(btn);
    return wrap;
  }

  private ctaAction() {
    if (this.screen.kind !== 'demo') return;
    const cta = this.screen.cta;
    if (cta === 'world') return void location.assign('/');
    if (cta === 'onboard') return this.openOnboarding({});
    if (cta === 'waitlist') return this.openWaitlist(true);
    this.openPlans({});
  }

  private bannerDismissed(): boolean {
    try {
      return sessionStorage.getItem(BANNER_KEY) === '1';
    } catch {
      return false;
    }
  }

  private showPastDue() {
    const b = el(
      'div',
      { class: 'billing-banner card', role: 'status' },
      `<span class="tile tone-warn">${ICON.card}</span>
       <span class="billing-text"><b>Your last payment didn't go through.</b><span>Your city stays live while Stripe retries. Update your card to keep it that way.</span></span>
       <button class="btn sm primary" type="button" data-act="portal">Update card</button>
       <button class="btn ghost icon-only sm" type="button" data-act="dismiss" aria-label="Hide until next visit">${ICON.close}</button>`,
    );
    b.addEventListener('click', async (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]');
      if (btn?.dataset.act === 'dismiss') {
        try {
          sessionStorage.setItem(BANNER_KEY, '1');
        } catch {
          // Hidden for this page view only.
        }
        b.remove();
        this.banner = null;
      }
      if (btn?.dataset.act === 'portal') {
        const done = busy(btn, 'Opening…');
        try {
          location.assign((await this.deps.api.portal()).url);
        } catch (err) {
          done();
          this.deps.hud.notice((err as Error).message);
        }
      }
    });
    document.getElementById('ui')!.append(b);
    this.banner = b;
  }

  // ── Dialogs ────────────────────────────────────────────────────────────

  openSignIn(opts: { context?: string | null; error?: string | null } = {}) {
    this.signin ??= new SignInDialog(this.deps.auth, { captchaSiteKey: this.deps.config.captcha?.siteKey ?? null });
    this.signin.open(opts);
  }

  openPlans(opts: { interval?: PlanInterval | null; note?: 'checkout-cancel' | 'canceled' | 'incomplete' | null }) {
    this.plans ??= new PlanDialog({
      api: this.deps.api,
      config: this.deps.config,
      signedIn: () => !!this.me,
      signIn: (interval) => {
        setPlanIntent(interval);
        const plan = this.deps.config.plans.find((p) => p.interval === interval);
        const price = plan ? `${formatPrice(plan.amount, plan.currency)} a ${interval}` : '';
        this.openSignIn({ context: `Next: checkout for the ${interval === 'year' ? 'yearly' : 'monthly'} plan${price ? `, ${price}` : ''}.` });
      },
      go: (url) => location.assign(url),
    });
    const plan = this.me?.plan;
    this.plans.open({ interval: opts.interval, note: opts.note ?? null, status: plan?.status, endedAt: plan?.status === 'canceled' ? plan.renewsAt : null });
  }

  openOnboarding(opts: { step?: 1 | 2 | 3; welcome?: boolean; error?: string | null; stripeBroken?: boolean }) {
    if (!this.me) return this.openSignIn();
    this.onboard ??= new OnboardingDialog({
      api: this.deps.api,
      config: this.deps.config,
      me: () => this.me!,
      onConnections: (c) => this.setConnections(c),
      go: (url) => location.assign(url),
      // A fresh boot loads the world with its seed and the new connections.
      finish: () => location.assign('/'),
      inWorld: this.screen.kind === 'world',
    });
    this.onboard.open({ ...opts, stripeBroken: opts.stripeBroken ?? this.stripeBroken });
  }

  /** "You're on the list". By itself once a session; any time from the call to action. */
  openWaitlist(force = false) {
    if (!force) {
      try {
        if (sessionStorage.getItem(WAITLIST_KEY)) return;
        sessionStorage.setItem(WAITLIST_KEY, '1');
      } catch {
        // Show it; storage only stops repeats.
      }
    }
    document.querySelectorAll<HTMLDialogElement>('dialog[open]').forEach((d) => d.close());
    this.waitlist ??= new WaitlistDialog({ signOut: () => this.signOut(), support: this.deps.config.supportEmail ?? null });
    this.waitlist.open(this.me?.user.email ?? this.deps.email);
    if (this.screen.kind === 'demo' && this.screen.cta !== 'waitlist') {
      this.screen = { kind: 'demo', cta: 'waitlist' };
      this.render();
    }
  }

  openAccount() {
    if (!this.me) return this.openSignIn();
    this.account ??= new AccountDialog({
      api: this.deps.api,
      config: this.deps.config,
      me: () => this.me!,
      onConnections: (c) => this.setConnections(c),
      onWorld: (w) => this.setWorld(w),
      go: (url) => location.assign(url),
      openPlans: () => this.openPlans({}),
      openSetup: (step) => this.openOnboarding({ step }),
      support: this.deps.config.supportEmail ?? null,
      forget: () => this.deps.auth.signOut(),
      leave: () => location.assign(this.deps.signedOutUrl),
      signOut: () => this.signOut(),
    });
    this.account.open();
  }

  /** Opens whatever boot decided should open by itself. */
  handleOpening(o: Opening) {
    if (o.dialog === 'signin') this.openSignIn({ error: o.error });
    if (o.dialog === 'plan') this.openPlans({ interval: takePlanIntent(), note: o.note });
    if (o.dialog === 'onboard') {
      if (o.stripeBroken && !this.stripeBroken) {
        this.stripeBroken = true;
        this.render();
      }
      this.openOnboarding({ step: o.step, welcome: o.welcome, error: o.error });
    }
    if (o.dialog === 'waitlist') this.openWaitlist();
  }

  /**
   * Back from Checkout before Stripe's webhook has landed: the plan isn't
   * active yet. Check again for a little while instead of showing the paywall.
   */
  async confirmCheckout(): Promise<void> {
    const note = el(
      'div',
      { class: 'billing-banner card is-pending', role: 'status' },
      `<span class="spinner lg" aria-hidden="true"></span><span class="billing-text"><b>Confirming your payment with Stripe…</b><span>This usually takes a few seconds.</span></span>`,
    );
    document.getElementById('ui')!.append(note);
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const me = await this.deps.api.me();
        if (isPaid(me.plan.status)) {
          note.remove();
          this.me = me;
          this.screen = me.connections.stripe ? { kind: 'world', pastDue: me.plan.status === 'past_due' } : { kind: 'demo', cta: 'onboard' };
          if (this.screen.kind === 'world') return void location.assign('/');
          this.render();
          this.openOnboarding({ step: 1, welcome: true });
          return;
        }
      } catch {
        // Keep trying.
      }
    }
    note.classList.remove('is-pending');
    note.innerHTML = `<span class="tile tone-info">${ICON.info}</span><span class="billing-text"><b>Your payment is taking longer than usual to confirm.</b><span>If Stripe charged you, your plan will show up here within a few minutes. Reload to check.</span></span><button class="btn sm" type="button">Reload</button>`;
    note.querySelector('button')!.addEventListener('click', () => location.reload());
  }

  private setConnections(c: Connections) {
    if (!this.me) return;
    this.me = { ...this.me, connections: c };
    if (this.screen.kind === 'demo') this.render();
  }

  private setWorld(w: WorldInfo) {
    if (!this.me) return;
    const renamed = w.name !== this.me.world.name;
    this.me = { ...this.me, world: w };
    // The name is painted into the HQ sign when the city is built: rebuild it.
    if (renamed && this.screen.kind === 'world') location.reload();
  }

  private async signOut() {
    await this.deps.auth.signOut();
    location.assign(this.deps.signedOutUrl);
  }

  private sessionEnded() {
    if (document.querySelector('.auth-dialog[open]')) return;
    this.deps.hud.notice('Your session ended. Sign in again to keep your changes saving.');
    this.openSignIn();
  }

  private planNeeded(_err: ApiRequestError) {
    if (document.querySelector('.plan-dialog[open]')) return;
    this.openPlans({ note: this.me?.plan.status === 'canceled' ? 'canceled' : null });
  }
}
