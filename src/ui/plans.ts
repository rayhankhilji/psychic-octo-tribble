/**
 * The paywall: what you get, in the game's own terms, two plans, and the
 * honest small print set at reading size. Prices come from the server's
 * config (the plans actually on sale), never from here; the saving and the
 * yearly price per month are worked out from them.
 */
import type { Api } from '../api/client.ts';
import { LEGAL, type ConfigResponse, type PlanInterval, type PlanStatus } from '../api/contract.ts';
import { defaultInterval, formatPrice, perInterval, priceSheet } from '../api/pricing.ts';
import { markSvg } from './brand.ts';
import { busy, focusFirst, longDate, makeDialog, message, skylineSvg } from './dialogs.ts';
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

/** What a plan gets you, in the game's own terms. Every number is the game's real rule (docs/GAME_DESIGN.md). */
const INCLUDES: { icon: IconName; title: string; text: string; climb?: boolean }[] = [
  { icon: 'coin', title: '$10,000 to build with for every $1 of MRR.', text: 'Your Stripe revenue is the only money in the game. Nothing in it is for sale.' },
  { icon: 'users', title: 'Your users need homes.', text: 'Each one needs $0.20 of MRR to be housed. Fall behind and the city starts to decay.' },
  { icon: 'rocket', title: 'Your HQ and your house climb.', text: 'Every release adds a floor to your HQ. Your house moves up as your MRR does:', climb: true },
  { icon: 'shield', title: 'Live on your real numbers.', text: "Read-only from Stripe and GitHub, refreshed through the day. TinyTown can't change a thing in either." },
];

/** Four rungs of the founder's house (the full ladder has seven). */
const CLIMB: [string, string][] = [
  ['$0', 'Hacker house'],
  ['$1k', 'The Hills'],
  ['$100k', 'An island'],
  ['$1M', 'The moon'],
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
      const price = formatPrice(plan.amount, plan.currency);
      // Real arithmetic only: the yearly price over twelve months, and what it saves against twelve monthly payments.
      const sub =
        iv === 'year' && sheet.yearlyPerMonth
          ? `${formatPrice(sheet.yearlyPerMonth, plan.currency)} a month, billed once a year`
          : `Billed every ${iv}`;
      const badge = iv === 'year' && sheet.yearlySaving > 0 ? `<span class="plan-badge num">Save ${formatPrice(sheet.yearlySaving, plan.currency)}</span>` : '';
      return `
        <label class="plan-option" data-interval="${iv}">
          <input type="radio" name="interval" value="${iv}" ${this.interval === iv ? 'checked' : ''}>
          <span class="plan-radio" aria-hidden="true"></span>
          <span class="plan-label"><span class="plan-name">${iv === 'month' ? 'Monthly' : 'Yearly'}${badge}</span><small class="num">${sub}</small></span>
          <span class="plan-price num"><b>${price}</b><small>/${iv === 'month' ? 'mo' : 'yr'}</small></span>
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
    const waitlistNote =
      this.deps.config.access === 'waitlist' && !this.deps.signedIn()
        ? message('info', "TinyTown is opening to its waitlist a few people at a time. Sign in with the email you joined with: if your spot has opened, you'll go straight on to checkout.")
        : '';
    const onSale = !!(month || year);
    const back = this.note === 'canceled';
    this.d.innerHTML = `
      <div class="dialog-body plans">
        <button class="btn ghost icon-only close plans-close" type="button" data-act="close" aria-label="Close">${ICON.close}</button>
        <div class="plans-pitch">
          <div class="plans-art" aria-hidden="true">${skylineSvg('plans-skyline')}</div>
          <header class="plans-head">
            <span class="plans-brand" aria-hidden="true">${markSvg({ cls: 'plans-mark' })}<span>TinyTown</span></span>
            <h2 id="plan-title">${back ? 'Bring your city back' : 'Make it yours'}</h2>
            <p>${back ? 'Everything you built is where you left it. Pick a plan and it picks up from your real numbers again.' : "Your city, built from your startup's real revenue, on a map that's yours alone."}</p>
          </header>
          <section class="plan-includes" aria-labelledby="plan-includes-title">
            <h3 id="plan-includes-title" class="sr-only">What you get</h3>
            <ul>${INCLUDES.map(
              (i) => `<li><span class="tile">${ICON[i.icon]}</span><span><b>${i.title}</b> ${i.text}${
                i.climb ? `<ol class="climb">${CLIMB.map(([mrr, home]) => `<li><b class="num">${mrr}</b><span>${home}</span></li>`).join('')}</ol>` : ''
              }</span></li>`,
            ).join('')}</ul>
          </section>
        </div>
        <div class="plans-choice">
          ${noteHtml}${waitlistNote}
          ${
            onSale
              ? `<fieldset class="plan-options"><legend class="plans-label">Choose how to pay</legend>${option('month')}${option('year')}</fieldset>
                 <p class="plan-today num" aria-live="polite"></p>`
              : message('info', "Plans aren't on sale on this server yet. The demo is free to explore.")
          }
          <section class="plan-terms" aria-labelledby="plan-terms-title">
            <h3 id="plan-terms-title" class="plans-label">Before you pay</h3>
            <ul>
              <li>${ICON.map}<span><b>No free trial.</b> The demo city is free for as long as you like, so you can see exactly what you're getting first.</span></li>
              <li>${ICON.calendar}<span><b>No refunds.</b> Cancel any time in a couple of clicks: you won't be charged again, and your city stays open to the end of what you've paid for. A billing mistake is always refunded in full.</span></li>
            </ul>
          </section>
          <ol class="plan-steps" aria-label="What happens next"></ol>
          <footer class="plan-foot">
            <div class="plan-error"></div>
            <button class="btn primary block lg" type="button" data-act="checkout" ${onSale ? '' : 'disabled'}></button>
            <p class="plan-fine">${ICON.lock}<span class="plan-next"></span></p>
            <p class="legal-row">By subscribing you agree to the <a href="${LEGAL.terms}" target="_blank" rel="noopener">Terms</a> and <a href="${LEGAL.privacy}" target="_blank" rel="noopener">Privacy Policy</a> · <a href="${LEGAL.refunds}" target="_blank" rel="noopener">Refund policy</a></p>
          </footer>
        </div>
      </div>`;
    this.renderCta();
  }

  /** The button, and the plain sentence of exactly what happens to their card, follow the chosen plan. */
  private renderCta() {
    const btn = this.d.querySelector<HTMLButtonElement>('[data-act=checkout]');
    const today = this.d.querySelector<HTMLElement>('.plan-today');
    const next = this.d.querySelector<HTMLElement>('.plan-next');
    if (!btn) return;
    const plan = this.deps.config.plans.find((p) => p.interval === this.interval);
    if (!plan) return void (btn.innerHTML = '<span class="label">Not on sale yet</span>');
    const price = formatPrice(plan.amount, plan.currency);
    if (today) today.innerHTML = `<b>${price} today</b>, then ${price} every ${plan.interval} until you cancel.`;
    const signedIn = this.deps.signedIn();
    if (next) next.textContent = "You'll pay on Stripe's secure checkout. TinyTown never sees your card.";
    const steps = this.d.querySelector<HTMLElement>('.plan-steps');
    if (steps) {
      const list = [...(signedIn ? [] : ['Sign in, no password']), 'Pay on Stripe', 'Connect Stripe, read-only', 'Your city builds itself'];
      steps.innerHTML = list.map((s, i) => `<li><b class="num">${i + 1}</b><span>${s}</span></li>`).join('');
    }
    btn.innerHTML = `<span class="label">${signedIn ? 'Continue to checkout' : 'Sign in to continue'}</span><span class="cta-sep" aria-hidden="true"></span><span class="num">${perInterval(plan)}</span>${ICON.arrowRight}`;
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
