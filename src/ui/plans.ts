/**
 * The paywall: what you get, in the game's own terms, the one plan as a
 * ticket (TinyTown is sold by the year), and the honest small print set at
 * reading size. Prices come from the server's config (the plans actually on
 * sale), never from here; the monthly equivalent is worked out from them.
 * Every game number (the rate, the housing cost, the house ladder) comes
 * from the game's own constants, so retuning the economy can't leave the
 * paywall quoting an old one.
 *
 * Setup is free and comes first, so a founder usually meets this with
 * Stripe already connected: it then leads with their own city's real
 * numbers ("your city is ready"), or says plainly that they're still on
 * their way. The first time such a founder closes it, it turns over to the
 * introductory offer (server/offer.ts): a golden ticket, first year at the
 * offer price, then the standard price, open 48 hours by the server's clock.
 * Shown once; "No thanks" is a plain no.
 */
import './plans.css';
import type { Api } from '../api/client.ts';
import { LEGAL, isPaid, type ConfigResponse, type MeResponse, type Offer, type Plan, type PlanInterval, type PlanStatus, type PreviewResponse } from '../api/contract.ts';
import { residentsOf } from '../api/preview.ts';
import { defaultInterval, formatPrice, perInterval, priceSheet } from '../api/pricing.ts';
import { formatMoney } from '../data/types.ts';
import { HOME_TIERS } from '../game/catalog.ts';
import { MRR_PER_USER, RATE } from '../game/economy.ts';
import { markSvg } from './brand.ts';
import { busy, focusFirst, longDate, makeDialog, message, skylineSvg } from './dialogs.ts';
import { compact, escape, shortMrr, showModal } from './dom.ts';
import { ICON, type IconName } from './icons.ts';

export type PlanNote = 'checkout-cancel' | 'canceled' | 'incomplete' | null;

export interface PlanDialogDeps {
  api: Api;
  config: ConfigResponse;
  signedIn(): boolean;
  /** Signed out: sign in first, then come back to this plan. */
  signIn(interval: PlanInterval): void;
  go(url: string): void;
  /** The signed-in founder, for their own numbers and the offer. */
  me?(): MeResponse | null;
  /** The offer changed (its window started): keep the shell's copy current. */
  onOffer?(offer: Offer | null): void;
}

/** "Saturday 2:14 PM · 47 hours left": the real time the offer closes, from the server's clock. */
export function offerEnds(expiresAt: number, now = Date.now()): { when: string; left: string } {
  const when = new Date(expiresAt).toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit' });
  const hours = Math.floor((expiresAt - now) / 3_600_000);
  const left = expiresAt <= now ? 'closed' : hours < 1 ? 'less than an hour left' : hours === 1 ? '1 hour left' : `${hours} hours left`;
  return { when, left };
}

/** The headline of a founder's own numbers: MRR, the people in the city, and what GitHub gave HQ (or how far back the history goes). */
export function teaserStats(p: PreviewResponse): [value: string, label: string][] {
  const r = p.revenue;
  if (!r) return [];
  const people = residentsOf(p) ?? 0;
  const out: [string, string][] = [
    [formatMoney(r.mrr, r.currency), 'MRR'],
    [people.toLocaleString('en-US'), people === 1 ? 'resident' : 'residents'],
  ];
  if (p.shipping) out.push([p.shipping.releases.toLocaleString('en-US'), p.shipping.releases === 1 ? 'release for HQ' : 'releases for HQ']);
  else if (r.since != null) out.push([new Date(r.since).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }), 'history from']);
  return out;
}

type PreviewState = { state: 'idle' } | { state: 'loading' } | { state: 'ready'; p: PreviewResponse } | { state: 'error' };

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
  /** The paywall, or the one-time offer it turns into the first time it's closed. */
  private view: 'plans' | 'offer' = 'plans';
  private preview: PreviewState = { state: 'idle' };

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
    // Every way out of the paywall (the close button, "Not now", a click outside, Esc) comes
    // through here first, so the first one can turn it over to the offer instead. Capture
    // phase: before the dialog's own close-on-click.
    this.d.addEventListener(
      'click',
      (e) => {
        const t = e.target as HTMLElement;
        if (t === this.d || t.closest('[data-act=close], [data-act=not-now]')) {
          e.stopImmediatePropagation();
          this.leave();
        }
      },
      true,
    );
    this.d.addEventListener('cancel', (e) => {
      e.preventDefault();
      this.leave();
    });
    // Browsers may close a dialog without asking (a second Esc in a row): the offer still gets its turn.
    this.d.addEventListener('close', () => {
      if (this.offerDue()) {
        this.turnToOffer();
        showModal(this.d);
      }
    });
    this.d.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'checkout') void this.checkout(this.offerOpen() !== null);
      if (act === 'offer-accept') void this.checkout(true);
      if (act === 'offer-decline') this.d.close();
    });
  }

  open(opts: { interval?: PlanInterval | null; note?: PlanNote; status?: PlanStatus; endedAt?: number | null } = {}) {
    // A plan picked before signing in, if it's still on sale (a monthly pick from before the yearly-only price isn't).
    if (opts.interval && this.deps.config.plans.some((p) => p.interval === opts.interval)) this.interval = opts.interval;
    this.note = opts.note ?? null;
    this.endedAt = opts.endedAt ?? null;
    this.view = 'plans';
    if (this.teaser && this.preview.state !== 'ready') this.loadPreview();
    this.render();
    showModal(this.d);
    focusFirst(this.d, `input[value=${this.interval}], [data-act=checkout]`);
    if (this.deps.signedIn()) void this.deps.api.paywallSeen(this.teaser);
  }

  private get me(): MeResponse | null {
    return this.deps.me?.() ?? null;
  }

  /** Set up and never paid: the paywall leads with their own city. */
  private get teaser(): boolean {
    const me = this.me;
    return !!me && me.plan.status === 'none' && !!me.connections.stripe;
  }

  /** The offer, while it's open for this founder (shown, inside its 48 hours by the server's clock). */
  private offerOpen(): Offer | null {
    const o = this.me?.offer;
    return o && o.status === 'open' && o.available && o.expiresAt != null && o.expiresAt > Date.now() ? o : null;
  }

  /** Leaving the paywall for the first time, as a founder who could still have the offer. */
  private offerDue(): boolean {
    const me = this.me;
    const o = me?.offer;
    return this.view === 'plans' && !!me && !isPaid(me.plan.status) && !!o && o.status === 'unseen' && o.available && !!this.deps.config.plans.find((p) => p.interval === 'year');
  }

  private leave() {
    if (this.offerDue()) this.turnToOffer();
    else this.d.close();
  }

  private loadPreview() {
    this.preview = { state: 'loading' };
    this.deps.api
      .preview()
      .then((p) => (this.preview = { state: 'ready', p }))
      .catch(() => (this.preview = { state: 'error' }))
      .finally(() => {
        const slot = this.d.querySelector('.plans-ready');
        if (slot && this.view === 'plans') slot.outerHTML = this.readyHead();
      });
  }

  // ── The paywall ────────────────────────────────────────────────────────

  private render() {
    this.d.classList.toggle('is-offer', this.view === 'offer');
    if (this.view === 'offer') return this.renderOffer();
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
        ? message('info', "TinyTown is opening to its waitlist a few people at a time. Sign in with the email you joined with: if your spot has opened, you'll set up your city straight away.")
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
    const head = this.teaser
      ? this.readyHead()
      : `<header class="plans-head">
            <span class="plans-brand" aria-hidden="true">${markSvg({ cls: 'plans-mark' })}<span>TinyTown</span></span>
            <h2 id="plan-title">${back ? 'Bring your city back' : 'Make it yours'}</h2>
            <p>${back ? 'Everything you built is where you left it. Renew and it picks up from your real numbers again.' : "Your city, built from your startup's real revenue, on a map that's yours alone."}</p>
          </header>`;
    this.d.innerHTML = `
      <div class="dialog-body plans">
        <button class="btn ghost icon-only close plans-close" type="button" data-act="close" aria-label="Close">${ICON.close}</button>
        <div class="plans-pitch">
          <div class="plans-art" aria-hidden="true">${skylineSvg('plans-skyline')}</div>
          ${head}
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
              ? `<section class="plan-offer" aria-labelledby="plan-offer-title"><div class="plan-offer-head"><h3 id="plan-offer-title" class="plans-label">${this.offerOpen() ? 'Your first-year offer' : 'The plan'}</h3>${choice}</div><div class="plan-ticket" aria-live="polite"></div></section>`
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
            ${this.teaser ? '<button class="btn ghost block plan-later" type="button" data-act="not-now">Not now</button>' : ''}
            <p class="plan-fine">${ICON.lock}<span class="plan-next"></span></p>
            <p class="legal-row">By subscribing you agree to the <a href="${LEGAL.terms}" target="_blank" rel="noopener">Terms</a> and <a href="${LEGAL.privacy}" target="_blank" rel="noopener">Privacy Policy</a> · <a href="${LEGAL.refunds}" target="_blank" rel="noopener">Refund policy</a></p>
          </footer>
        </div>
      </div>`;
    this.renderCta();
  }

  /**
   * "Your city is ready": the founder's own headline numbers, as the city will
   * open with them. Never a made-up number: while they're loading it says so,
   * and if Stripe hasn't sent them yet it says that.
   */
  private readyHead(): string {
    const me = this.me;
    const name = me?.world.name && me.world.name !== 'Your Startup' ? me.world.name : null;
    const p = this.preview;
    const ready = p.state === 'ready' && p.p.ready && p.p.revenue ? p.p : null;
    const stats = ready ? teaserStats(ready) : [];
    let body: string;
    if (p.state === 'loading' || p.state === 'idle') {
      body = `<div class="ready-stats is-loading" aria-busy="true">${['MRR', 'residents', 'releases'].map((l) => `<span class="ready-stat"><b class="num">—</b><small>${l}</small></span>`).join('')}</div>
        <p class="ready-note">Reading your numbers from Stripe…</p>`;
    } else if (ready && ready.revenue) {
      const budget = ready.revenue.mrr * RATE;
      body = `<div class="ready-stats" role="list">${stats.map(([v, l]) => `<span class="ready-stat" role="listitem"><b class="num">${escape(v)}</b><small>${l}</small></span>`).join('')}</div>
        <p class="ready-note">${
          budget > 0
            ? `That's about <b class="num">$${compact(budget)}</b> a month to build with, and every number in your city is one of these.`
            : 'No paying subscriptions yet, so your city starts small and grows with your first customer.'
        }</p>`;
    } else {
      body = `<p class="ready-note is-waiting">${ICON.info}<span>${
        p.state === 'error' ? "We couldn't read your numbers just now." : 'Your numbers are still on their way from Stripe.'
      } They'll be in your city the moment it opens.</span></p>`;
    }
    return `<header class="plans-head plans-ready">
        <span class="plans-brand" aria-hidden="true">${markSvg({ cls: 'plans-mark' })}<span>TinyTown</span></span>
        <p class="ready-eyebrow"><span class="ready-dot" aria-hidden="true"></span>Set up · Stripe connected</p>
        <h2 id="plan-title">${name ? `${escape(name)} is ready` : 'Your city is ready'}</h2>
        ${body}
      </header>`;
  }

  /** The ticket: the price, what it is a month, and exactly what happens to their card. */
  private ticket(plan: Plan): string {
    const offer = plan.interval === 'year' ? this.offerOpen() : null;
    if (offer) return this.offerTicket(offer, 'compact');
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

  /**
   * The golden ticket: the first year at the offer price, then the standard
   * price, both stated in full, and when the offer closes (the server's own
   * time, no countdown theatre).
   */
  private offerTicket(o: Offer, size: 'compact' | 'full'): string {
    const first = formatPrice(o.amount, o.currency);
    const then = formatPrice(o.regular, o.currency);
    const ends = o.expiresAt ? offerEnds(o.expiresAt) : null;
    return `
      <div class="ticket-main">
        <p class="ticket-eyebrow"><span>Admit one</span><span>First year</span></p>
        <p class="ticket-price"><b class="num">${first}</b><span>for your first year</span></p>
        <p class="ticket-sub">Then <span class="num">${then}</span> a year, until you cancel.</p>
        ${size === 'full' ? '<span class="ticket-stamp" aria-hidden="true"><span>Once</span><span>only</span></span>' : ''}
      </div>
      <div class="ticket-perf" aria-hidden="true"></div>
      <dl class="ticket-stub">
        <div><dt>Today</dt><dd class="num">${first}</dd></div>
        <div><dt>Then</dt><dd><span class="num">${then}</span> every year, until you cancel</dd></div>
      </dl>
      ${ends ? `<p class="ticket-ends">${ICON.calendar}<span>Open until ${ends.when} <span class="num">(${ends.left})</span></span></p>` : ''}`;
  }

  /** The ticket, the terms, the button and the plain sentence of exactly what happens to their card follow the chosen plan. */
  private renderCta() {
    const btn = this.d.querySelector<HTMLButtonElement>('[data-act=checkout]');
    const next = this.d.querySelector<HTMLElement>('.plan-next');
    const terms = this.d.querySelector<HTMLElement>('.plan-terms-list');
    const plan = this.deps.config.plans.find((p) => p.interval === this.interval);
    const period = plan?.interval === 'month' ? 'the month' : 'the year';
    const offer = plan?.interval === 'year' ? this.offerOpen() : null;
    if (terms) {
      terms.innerHTML = `
        <li>${ICON.map}<span><b>No free trial.</b> The demo and the whole setup are free, so you see your own numbers before you pay.</span></li>
        <li>${ICON.calendar}<span><b>No refunds.</b> Cancel any time in a couple of clicks: you won't be charged again, and your city stays open to the end of ${period} you've paid for. A billing mistake is always refunded in full.</span></li>`;
    }
    const ticket = this.d.querySelector<HTMLElement>('.plan-ticket');
    if (ticket) ticket.classList.toggle('is-golden', !!offer);
    if (!btn) return;
    if (!plan) return void (btn.innerHTML = '<span class="label">Not on sale yet</span>');
    if (ticket) ticket.innerHTML = this.ticket(plan);
    const signedIn = this.deps.signedIn();
    const me = this.me;
    if (next) next.textContent = "You'll pay on Stripe's secure checkout, which can show the price in your own currency. TinyTown never sees your card.";
    const steps = this.d.querySelector<HTMLElement>('.plan-steps');
    if (steps) {
      const connected = !!me?.connections.stripe;
      const list = !signedIn
        ? ['Sign in, free', 'Connect Stripe, free', 'Pay when your city is ready']
        : connected
          ? ['Pay on Stripe', 'Your grand opening']
          : ['Pay on Stripe', 'Connect Stripe, read-only', 'Your city builds itself'];
      steps.innerHTML = list.map((s, i) => `<li><b class="num">${i + 1}</b><span>${s}</span></li>`).join('');
    }
    const price = offer ? `${formatPrice(offer.amount, offer.currency)} first year` : perInterval(plan);
    btn.innerHTML = `<span class="label">${signedIn ? 'Continue to checkout' : 'Sign in to set up, free'}</span><span class="cta-sep" aria-hidden="true"></span><span class="num">${price}</span>${ICON.arrowRight}`;
  }

  // ── The one-time offer ─────────────────────────────────────────────────

  /** The paywall turns over to the offer, and the server starts its 48 hours. */
  private turnToOffer() {
    this.view = 'offer';
    this.render();
    focusFirst(this.d, '[data-act=offer-accept]');
    const shown = this.me?.offer ?? null;
    this.deps.api
      .offerSeen()
      .then((offer) => {
        this.deps.onOffer?.(offer);
        if (this.view === 'offer' && this.d.open) {
          const slot = this.d.querySelector<HTMLElement>('.offer-ticket');
          if (offer && offer.status === 'open' && slot) slot.innerHTML = this.offerTicket(offer, 'full');
          else if (!offer || !offer.available) this.offerGone();
        }
      })
      .catch(() => {
        // The window couldn't start, so it can't be claimed: say so rather than offer what checkout would refuse.
        if (shown && this.view === 'offer' && this.d.open) this.offerGone();
      });
  }

  private offerGone() {
    const slot = this.d.querySelector('.offer-error');
    if (slot) slot.innerHTML = message('warn', "This offer isn't available right now. The standard price is still on sale whenever you're ready.");
    const accept = this.d.querySelector<HTMLButtonElement>('[data-act=offer-accept]');
    if (accept) accept.disabled = true;
  }

  private renderOffer() {
    const o = this.me?.offer;
    const year = this.deps.config.plans.find((p) => p.interval === 'year');
    if (!o || !year) return void this.d.close();
    const first = formatPrice(o.amount, o.currency);
    const then = formatPrice(o.regular, o.currency);
    this.d.innerHTML = `
      <div class="dialog-body offer">
        <button class="btn ghost icon-only close plans-close" type="button" data-act="close" aria-label="Close">${ICON.close}</button>
        <header class="offer-head">
          <span class="offer-kicker">${ICON.sparkle}<span>A welcome offer, once</span></span>
          <h2 id="plan-title">Your first year for ${first}</h2>
          <p>Before you go: open your city for <b class="num">${first}</b> for the first year, then <b class="num">${then}</b> a year after that. It's yours for 48 hours.</p>
        </header>
        <div class="plan-ticket is-golden offer-ticket" aria-live="polite">${this.offerTicket(o, 'full')}</div>
        <div class="offer-error plan-error"></div>
        <footer class="offer-foot">
          <button class="btn primary block lg" type="button" data-act="offer-accept"><span class="label">Accept: ${first} for the first year</span>${ICON.arrowRight}</button>
          <button class="btn ghost block" type="button" data-act="offer-decline">No thanks</button>
          <p class="plan-fine">${ICON.lock}<span>Renews at ${then} a year until you cancel. No refunds; cancel any time before it renews. Stripe's checkout can show it in your own currency.</span></p>
          <p class="legal-row">By subscribing you agree to the <a href="${LEGAL.terms}" target="_blank" rel="noopener">Terms</a> and <a href="${LEGAL.privacy}" target="_blank" rel="noopener">Privacy Policy</a> · <a href="${LEGAL.refunds}" target="_blank" rel="noopener">Refund policy</a></p>
        </footer>
      </div>`;
  }

  private async checkout(offer: boolean) {
    const slot = this.d.querySelector('.plan-error')!;
    slot.innerHTML = '';
    if (!this.deps.signedIn()) {
      this.d.close();
      this.deps.signIn(this.interval);
      return;
    }
    const btn = this.d.querySelector<HTMLButtonElement>(offer && this.view === 'offer' ? '[data-act=offer-accept]' : '[data-act=checkout]');
    const done = busy(btn, 'Opening secure checkout…');
    try {
      const { url } = await this.deps.api.checkout(offer ? 'year' : this.interval, { offer });
      this.deps.go(url);
    } catch (err) {
      done();
      if (this.view === 'plans') this.renderCta();
      slot.innerHTML = message('bad', err instanceof Error ? err.message : "Couldn't open checkout. Try again.");
    }
  }
}
