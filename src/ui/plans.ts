/**
 * The paywall: two plans, what you get, and the honest small print. Prices
 * come from the server's config (the plans actually on sale), never from
 * here; the saving is worked out from them.
 */
import type { Api } from '../api/client.ts';
import { LEGAL, type ConfigResponse, type PlanInterval, type PlanStatus } from '../api/contract.ts';
import { defaultInterval, formatPrice, perInterval, priceSheet } from '../api/pricing.ts';
import { busy, focusFirst, longDate, makeDialog, message } from './dialogs.ts';
import { showModal } from './dom.ts';
import { ICON, type IconName } from './icons.ts';

export type PlanNote = 'checkout-cancel' | 'canceled' | 'incomplete' | null;

export interface PlanDialogDeps {
  api: Api;
  config: ConfigResponse;
  signedIn(): boolean;
  /** Signed out: sign in first, then come back to this plan. */
  signIn(interval: PlanInterval): void;
  go(url: string): void;
}

const INCLUDES: { icon: IconName; title: string; text: string }[] = [
  { icon: 'chart', title: 'Your real numbers, live.', text: 'MRR and customers from Stripe, releases and commits from GitHub, refreshed through the day.' },
  { icon: 'map', title: 'A map of your own.', text: 'The same size and plots as every city, laid out just for you.' },
  { icon: 'coin', title: '$10,000 to build with for every $1 of MRR.', text: 'Nothing in the game is for sale. The only way to grow it is to grow your startup.' },
  { icon: 'shield', title: 'Read-only, always.', text: "TinyTown can't change anything in your Stripe or GitHub." },
  { icon: 'home', title: 'Saved to your account.', text: 'Pick your city up on any device.' },
];

export class PlanDialog {
  private d: HTMLDialogElement;
  private deps: PlanDialogDeps;
  private interval: PlanInterval;
  private note: PlanNote = null;
  private endedAt: number | null = null;

  constructor(deps: PlanDialogDeps) {
    this.deps = deps;
    this.interval = defaultInterval(priceSheet(deps.config.plans));
    this.d = makeDialog('plan-dialog', 'plan-title');
    this.d.addEventListener('change', (e) => {
      const r = e.target as HTMLInputElement;
      if (r.name === 'interval') {
        this.interval = r.value as PlanInterval;
        this.renderCta();
      }
    });
    this.d.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-act=checkout]')) void this.checkout();
    });
  }

  open(opts: { interval?: PlanInterval | null; note?: PlanNote; status?: PlanStatus; endedAt?: number | null } = {}) {
    if (opts.interval) this.interval = opts.interval;
    this.note = opts.note ?? null;
    this.endedAt = opts.endedAt ?? null;
    this.render();
    showModal(this.d);
    focusFirst(this.d, `input[value=${this.interval}]`);
  }

  private render() {
    const sheet = priceSheet(this.deps.config.plans);
    const { month, year } = sheet;
    const option = (iv: PlanInterval) => {
      const plan = iv === 'month' ? month : year;
      if (!plan) return '';
      // Exactly what happens to their card: charged today, then on each renewal until they cancel.
      const sub = `${formatPrice(plan.amount, plan.currency)} today, then every ${iv} until you cancel.`;
      const badge = iv === 'year' && sheet.yearlySaving > 0 ? `<span class="plan-badge num">Saves ${formatPrice(sheet.yearlySaving, plan.currency)} a year</span>` : '';
      return `
        <label class="plan-option">
          <input type="radio" name="interval" value="${iv}" ${this.interval === iv ? 'checked' : ''}>
          <span class="plan-option-top"><span class="plan-radio" aria-hidden="true"></span><span class="plan-name">${iv === 'month' ? 'Monthly' : 'Yearly'}</span>${badge}</span>
          <span class="plan-price num"><b>${formatPrice(plan.amount, plan.currency)}</b><small>/${iv}</small></span>
          <span class="plan-sub num">${sub}</span>
        </label>`;
    };
    const noteHtml =
      this.note === 'checkout-cancel'
        ? message('info', 'Checkout closed before paying. Nothing was charged.')
        : this.note === 'canceled'
          ? message('warn', `Your plan ended${this.endedAt ? ` on ${longDate(this.endedAt)}` : ''}. Your city and its saves are kept: pick a plan to open it again.`)
          : this.note === 'incomplete'
            ? message('warn', "Your last payment didn't go through, so the plan never started. Nothing was charged.")
            : '';
    const onSale = !!(month || year);
    this.d.innerHTML = `
      <div class="dialog-body plans">
        <header class="dialog-head">
          <span class="tile tone-brand">${ICON.sparkle}</span>
          <div><h2 id="plan-title">${this.note === 'canceled' ? 'Bring your city back' : 'Make it yours'}</h2><p>Your city, built from your startup's real revenue, on a map that's yours alone.</p></div>
          <button class="btn ghost icon-only close" type="button" data-act="close" aria-label="Close">${ICON.close}</button>
        </header>
        ${noteHtml}
        ${this.deps.config.access === 'waitlist' && !this.deps.signedIn() ? message('info', "TinyTown is opening to its waitlist a few people at a time. Sign in with the email you joined with: if your spot has opened, you'll go straight on to checkout.") : ''}
        ${
          onSale
            ? `<fieldset class="plan-options"><legend class="sr-only">Billing</legend>${option('month')}${option('year')}</fieldset>`
            : message('info', "Plans aren't on sale on this server yet. The demo is free to explore.")
        }
        <section class="plan-includes" aria-labelledby="plan-includes-title">
          <h3 id="plan-includes-title">Everything's included</h3>
          <ul>${INCLUDES.map((i) => `<li><span class="tile">${ICON[i.icon]}</span><span><b>${i.title}</b> ${i.text}</span></li>`).join('')}</ul>
        </section>
        <footer class="plan-foot">
          <p class="plan-honest"><b>No free trial.</b> The demo is free to explore for as long as you like.</p>
          <div class="plan-error"></div>
          <button class="btn primary block lg" type="button" data-act="checkout" ${onSale ? '' : 'disabled'}></button>
          <p class="plan-fine">${ICON.lock}<span>Renews automatically. Cancel any time. No refunds. Payment is handled by Stripe.</span></p>
          <p class="legal-row">By subscribing you agree to the <a href="${LEGAL.terms}" target="_blank" rel="noopener">Terms</a> and <a href="${LEGAL.privacy}" target="_blank" rel="noopener">Privacy Policy</a>. <a href="${LEGAL.refunds}" target="_blank" rel="noopener">Refund policy</a></p>
        </footer>
      </div>`;
    this.renderCta();
  }

  private renderCta() {
    const btn = this.d.querySelector<HTMLButtonElement>('[data-act=checkout]');
    if (!btn) return;
    const plan = this.deps.config.plans.find((p) => p.interval === this.interval);
    if (!plan) return void (btn.innerHTML = '<span class="label">Not on sale yet</span>');
    btn.innerHTML = this.deps.signedIn()
      ? `<span class="label">Continue to checkout</span><span class="cta-sep" aria-hidden="true"></span><span class="num">${perInterval(plan)}</span>${ICON.arrowRight}`
      : `<span class="label">Sign in to continue</span><span class="cta-sep" aria-hidden="true"></span><span class="num">${perInterval(plan)}</span>${ICON.arrowRight}`;
  }

  private async checkout() {
    const slot = this.d.querySelector('.plan-error')!;
    slot.innerHTML = '';
    if (!this.deps.signedIn()) {
      this.d.close();
      this.deps.signIn(this.interval);
      return;
    }
    const btn = this.d.querySelector<HTMLButtonElement>('[data-act=checkout]');
    const done = busy(btn, 'Opening secure checkout…');
    try {
      const { url } = await this.deps.api.checkout(this.interval);
      this.deps.go(url);
    } catch (err) {
      done();
      this.renderCta();
      slot.innerHTML = message('bad', err instanceof Error ? err.message : "Couldn't open checkout. Try again.");
    }
  }
}
