/**
 * Prices as people read them, from the plans the server says are on sale.
 * Pure, so the numbers in the paywall are tested and always the real ones.
 */
import type { Plan, PlanInterval } from './contract.ts';

/** Minor units → "$29", "$2.42" (cents only when there are some). */
export function formatPrice(minor: number, currency: string): string {
  const major = minor / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: Number.isInteger(major) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(major);
}

export interface PriceSheet {
  month: Plan | null;
  year: Plan | null;
  /** What a year costs on the monthly plan minus the yearly price, in minor units (0 if it saves nothing). */
  yearlySaving: number;
  /** The yearly price spread over twelve months, rounded up to the cent so it never understates the cost ($29 → $2.42). */
  yearlyPerMonth: number | null;
}

export function priceSheet(plans: Plan[]): PriceSheet {
  const month = plans.find((p) => p.interval === 'month') ?? null;
  const year = plans.find((p) => p.interval === 'year') ?? null;
  const sameCurrency = month && year && month.currency === year.currency;
  const yearlySaving = sameCurrency ? Math.max(0, month.amount * 12 - year.amount) : 0;
  return { month, year, yearlySaving, yearlyPerMonth: year ? Math.ceil(year.amount / 12) : null };
}

/** "$29/year". */
export function perInterval(plan: Plan): string {
  return `${formatPrice(plan.amount, plan.currency)}/${plan.interval}`;
}

/** "$29 a year". */
export function inWords(plan: Plan): string {
  return `${formatPrice(plan.amount, plan.currency)} a ${plan.interval}`;
}

/**
 * The plan selected first and quoted by the calls to action. TinyTown is
 * sold by the year, so that's normally the only one; if a monthly price is
 * ever configured too, the smaller charge leads (no nudging towards the
 * bigger one).
 */
export function defaultInterval(sheet: PriceSheet): PlanInterval {
  return sheet.month || !sheet.year ? 'month' : 'year';
}

/** The price a button quotes: "$29/yr" (or "$12/mo" if a monthly plan leads), null when nothing is on sale. */
export function ctaPrice(plans: Plan[]): string | null {
  const sheet = priceSheet(plans);
  const plan = sheet[defaultInterval(sheet)];
  return plan ? `${formatPrice(plan.amount, plan.currency)}/${plan.interval === 'month' ? 'mo' : 'yr'}` : null;
}

/** Every plan on sale in words, for small print: "$29 a year" (or "$12 a month or $99 a year"). Null when nothing is on sale. */
export function priceLine(plans: Plan[]): string | null {
  const { month, year } = priceSheet(plans);
  const words = [month, year].filter((p): p is Plan => !!p).map(inWords);
  return words.length ? words.join(' or ') : null;
}
