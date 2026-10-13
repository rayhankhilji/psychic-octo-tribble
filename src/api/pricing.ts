/**
 * Prices as people read them, from the plans the server says are on sale.
 * Pure, so the numbers in the paywall are tested and always the real ones.
 */
import type { Plan, PlanInterval } from './contract.ts';

/** Minor units → "$12", "$99", "$8.25" (cents only when there are some). */
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
  /** The yearly price spread over twelve months, rounded down to the cent. */
  yearlyPerMonth: number | null;
}

export function priceSheet(plans: Plan[]): PriceSheet {
  const month = plans.find((p) => p.interval === 'month') ?? null;
  const year = plans.find((p) => p.interval === 'year') ?? null;
  const sameCurrency = month && year && month.currency === year.currency;
  const yearlySaving = sameCurrency ? Math.max(0, month.amount * 12 - year.amount) : 0;
  return { month, year, yearlySaving, yearlyPerMonth: year ? Math.floor(year.amount / 12) : null };
}

/** "$12/month", "$99/year". */
export function perInterval(plan: Plan): string {
  return `${formatPrice(plan.amount, plan.currency)}/${plan.interval}`;
}

/** The plan selected first: monthly, the price the call to action quotes (no nudging towards the bigger charge). */
export function defaultInterval(sheet: PriceSheet): PlanInterval {
  return sheet.month || !sheet.year ? 'month' : 'year';
}
