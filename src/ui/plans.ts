/**
 * The paywall: what you get, in the game's own terms, the one plan as a
 * ticket (TinyTown is sold by the year), and the honest small print set at
 * reading size. Prices come from the server's config (the plans actually on
 * sale), never from here; the monthly equivalent is worked out from them.
 * Every game number (the rate, the housing cost, the house ladder) comes
 * from the game's own constants, so retuning the economy can't leave the
 * paywall quoting an old one.
 */
import './plans.css';
import type { Api } from '../api/client.ts';
import { LEGAL, type ConfigResponse, type Plan, type PlanInterval, type PlanStatus } from '../api/contract.ts';
import { defaultInterval, formatPrice, perInterval, priceSheet } from '../api/pricing.ts';
import { HOME_TIERS } from '../game/catalog.ts';
import { MRR_PER_USER, RATE } from '../game/economy.ts';
import { markSvg } from './brand.ts';
import { busy, focusFirst, longDate, makeDialog, message, skylineSvg } from './dialogs.ts';
import { shortMrr, showModal } from './dom.ts';
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
function includes(): { icon: IconName; title: string; text: string; climb?: boolean }[] {
  return [
    { icon: 'coin', title: `$${RATE.toLocaleString('en-US')} to build with for every $1 of MRR.`, text: 'Your Stripe revenue is the only money in the game. Nothing in it is for sale.' },
    { icon: 'users', title: 'Your users need homes.', text: `Each one needs $${MRR_PER_USER.toFixed(2)} of MRR to be housed. Fall behind and the city starts to decay.` },
    { icon: 'rocket', title: 'Your HQ and your house climb.', text: 'Every release adds a floor to your HQ. Your house moves up as your MRR does:', climb: true },
    { icon: 'shield', title: 'Live on your real numbers.', text: "Read-only from Stripe and GitHub, refreshed through the day. TinyTown can't change a thing in either." },
  ];
}

/**
 * Four rungs of the founder's house, read from HOME_TIERS: where it starts,
 * and the first step into the Hills, onto the island and up to the moon.
 */
export function climb(): [mrr: string, home: string][] {
  const first = (where: string) => HOME_TIERS.find((t) => t.where === where);
  const start = HOME_TIERS[0]!;
  const rungs: [string, string][] = [[shortMrr(start.mrr), start.options[0]?.name.replace(/ House$/, ' house') ?? 'Hacker house']];
  for (const [where, label] of [['hills', 'The Hills'], ['island', 'An island'], ['moon', 'The moon']] as const) {
    const t = first(where);
    if (t) rungs.push([shortMrr(t.mrr), label]);
  }
  return rungs;
}

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
    // A plan picked before signing in, if it's still on sale (a monthly pick from before the yearly-only price isn't).
    if (opts.interval && this.deps.config.plans.some((p) => p.interval === opts.interval)) this.interval = opts.interval;
    this.note = opts.note ?? null;
    this.endedAt = opts.endedAt ?? null;
    this.render();
    showModal(this.d);
    focusFirst(this.d, `input[value=${this.interval}], [data-act=checkout]`);
  }

  private render() {
    const sheet = priceSheet(this.deps.config.plans);
    const { month, year } = sheet;
    const noteHtml =
      this.note === 'checkout-cancel'
        ? message('info', 'Checkout closed before paying. Nothing was charged.')
        : this.note === 'canceled'
          ? message('warn', `Your plan ended${this.endedAt ? ` on ${longDate(this.endedAt)}` : ''}. Your city and its saves are kept: renew and it opens again.`)
          : this.note === 'incomplete'
            ? message('warn', "Your last payment didn't go through, so the plan never started. Nothing was charged.")
            : '';
    const waitlistNote =
      this.deps.config.access === 'waitlist' && !this.deps.signedIn()
        ? message('info', "TinyTown is opening to its waitlist a few people at a time. Sign in with the email you joined with: if your spot has opened, you'll go straight on to checkout.")
        : '';
    const onSale = !!(month || year);
    const rungs = climb();
    const back = this.note === 'canceled';
    // TinyTown is sold by the year. Only a server that still has a monthly price configured shows a choice.
    const choice =
      month && year
        ? `<div class="segmented plan-switch" role="radiogroup" aria-label="Billing period">${(['year', 'month'] as const)
            .map((iv) => `<label><input type="radio" name="interval" value="${iv}" ${this.interval === iv ? 'checked' : ''}><span>${iv === 'year' ? 'Yearly' : 'Monthly'}</span></label>`)
            .join('')}</div>`
        : '';
    this.d.innerHTML = `
      <div class="dialog-body plans">
        <button class="btn ghost icon-only close plans-close" type="button" data-act="close" aria-label="Close">${ICON.close}</button>
        <div class="plans-pitch">
          <div class="plans-art" aria-hidden="true">${skylineSvg('plans-skyline')}</div>
          <header class="plans-head">
            <span class="plans-brand" aria-hidden="true">${markSvg({ cls: 'plans-mark' })}<span>TinyTown</span></span>
            <h2 id="plan-title">${back ? 'Bring your city back' : 'Make it yours'}</h2>
            <p>${back ? 'Everything you built is where you left it. Renew and it picks up from your real numbers again.' : "Your city, built from your startup's real revenue, on a map that's yours alone."}</p>
          </header>
          <section class="plan-includes" aria-labelledby="plan-includes-title">
            <h3 id="plan-includes-title" class="sr-only">What you get</h3>
            <ul>${includes()
              .map(
                (i) => `<li><span class="tile">${ICON[i.icon]}</span><span><b>${i.title}</b> ${i.text}${
                  i.climb ? `<ol class="climb" style="--rungs:${rungs.length}">${rungs.map(([mrr, home]) => `<li><b class="num">${mrr}</b><span>${home}</span></li>`).join('')}</ol>` : ''
                }</span></li>`,
              )
              .join('')}</ul>
          </section>
        </div>
        <div class="plans-choice">
          ${noteHtml}${waitlistNote}
          ${
            onSale
              ? `<section class="plan-offer" aria-labelledby="plan-offer-title"><div class="plan-offer-head"><h3 id="plan-offer-title" class="plans-label">The plan</h3>${choice}</div><div class="plan-ticket" aria-live="polite"></div></section>`
              : message('info', "Plans aren't on sale on this server yet. The demo is free to explore.")
          }
          <section class="plan-terms" aria-labelledby="plan-terms-title">
            <h3 id="plan-terms-title" class="plans-label">Before you pay</h3>
            <ul class="plan-terms-list"></ul>
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

  /** The ticket: the price, what it is a month, and exactly what happens to their card. */
  private ticket(plan: Plan): string {
    const price = formatPrice(plan.amount, plan.currency);
    const sheet = priceSheet(this.deps.config.plans);
    const yearly = plan.interval === 'year';
    // Real arithmetic: the yearly price over twelve months, rounded up so it never understates ($29 → $2.42).
    const perMonth = yearly && sheet.yearlyPerMonth ? formatPrice(sheet.yearlyPerMonth, plan.currency) : null;
    return `
      <div class="ticket-main">
        <p class="ticket-eyebrow"><span>Admit one</span><span>${yearly ? 'A whole year' : 'One month'}</span></p>
        <p class="ticket-price"><b class="num">${price}</b><span>a ${plan.interval}</span></p>
        <p class="ticket-sub num">${perMonth ? `That's ${perMonth} a month, paid once a year.` : 'Paid every month.'}</p>
      </div>
      <div class="ticket-perf" aria-hidden="true"></div>
      <dl class="ticket-stub">
        <div><dt>Today</dt><dd class="num">${price}</dd></div>
        <div><dt>Then</dt><dd><span class="num">${price}</span> every ${plan.interval}, until you cancel</dd></div>
      </dl>`;
  }

  /** The ticket, the terms, the button and the plain sentence of exactly what happens to their card follow the chosen plan. */
  private renderCta() {
    const btn = this.d.querySelector<HTMLButtonElement>('[data-act=checkout]');
    const next = this.d.querySelector<HTMLElement>('.plan-next');
    const terms = this.d.querySelector<HTMLElement>('.plan-terms-list');
    const plan = this.deps.config.plans.find((p) => p.interval === this.interval);
    const period = plan?.interval === 'month' ? 'the month' : 'the year';
    if (terms) {
      terms.innerHTML = `
        <li>${ICON.map}<span><b>No free trial.</b> The demo city is free for as long as you like, so you can see exactly what you're getting first.</span></li>
        <li>${ICON.calendar}<span><b>No refunds.</b> Cancel any time in a couple of clicks: you won't be charged again, and your city stays open to the end of ${period} you've paid for. A billing mistake is always refunded in full.</span></li>`;
    }
    if (!btn) return;
    if (!plan) return void (btn.innerHTML = '<span class="label">Not on sale yet</span>');
    const ticket = this.d.querySelector<HTMLElement>('.plan-ticket');
    if (ticket) ticket.innerHTML = this.ticket(plan);
    const signedIn = this.deps.signedIn();
    if (next) next.textContent = "You'll pay on Stripe's secure checkout, which can show the price in your own currency. TinyTown never sees your card.";
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
