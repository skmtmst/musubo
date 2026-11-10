import { individualQuoteAccess } from './musubo-billing-flow.js';
import { musuboPrice, type LinkedAccountCounts, type MusuboPriceSchedule, type MusuboTrialPeriod } from './musubo-pricing.js';

/** Final prices in a company-specific quote. Any special LINE discount is already reflected in these unit prices. */
export interface MusuboIndividualQuote {
  quoteNumber: string;
  companyName: string;
  issuedAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  supersededAt: string | null;
  interval: 'month' | 'year';
  plannedLineCount: number;
  plannedFriendCountExcludingBlocked: number;
  plannedLinkedAccountsByLine: readonly LinkedAccountCounts[];
  trialPeriod: MusuboTrialPeriod;
  finalSchedule: MusuboPriceSchedule;
  /** Required for annual quotes. This final annual LINE amount is stored and never discounted again. */
  finalAnnualLineChargeYen: number | null;
}

function validMoney(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(name + ' must be a nonnegative integer');
}

/** Previewing a draft is allowed; activation must separately verify acceptedAt in persisted data. */
export function musuboIndividualQuotePrice(quote: MusuboIndividualQuote): {
  finalLineBasicMonthlyYen: number;
  finalAnnualLineChargeYen: number | null;
  optionsMonthlyYen: number;
  headquartersMonthlyYen: number;
  friendOverageMonthlyYen: number;
  linkedAccountSlotsMonthlyYen: number;
  plannedMonthlyTotalYen: number | null;
  linkedSlots: number;
} {
  if (!quote.quoteNumber || !quote.companyName.trim()) throw new RangeError('Quote number and company name are required');
  individualQuoteAccess(quote, quote.issuedAt);
  const trial = quote.trialPeriod;
  if (!Number.isSafeInteger(trial.value) || trial.value < 1
    || (trial.unit === 'days' && trial.value > 365)
    || (trial.unit === 'months' && trial.value > 12)
    || (trial.unit !== 'days' && trial.unit !== 'months')) {
    throw new RangeError('Quote trial period must be 1–365 days or 1–12 months');
  }
  const price = musuboPrice({
    lineCount: quote.plannedLineCount,
    friendCountExcludingBlocked: quote.plannedFriendCountExcludingBlocked,
    linkedAccountsByLine: quote.plannedLinkedAccountsByLine,
    schedule: quote.finalSchedule,
    interval: 'month',
    lineBasicDiscountPercent: 0,
    individualQuoteContext: true,
  });
  if (quote.interval === 'year') {
    if (quote.finalAnnualLineChargeYen === null) throw new RangeError('Final annual LINE charge is required');
    validMoney(quote.finalAnnualLineChargeYen, 'finalAnnualLineChargeYen');
  } else if (quote.interval !== 'month' || quote.finalAnnualLineChargeYen !== null) {
    throw new RangeError('Monthly quotes must not contain an annual LINE charge');
  }
  return {
    finalLineBasicMonthlyYen: price.lineBasicMonthlyYen,
    finalAnnualLineChargeYen: quote.finalAnnualLineChargeYen,
    optionsMonthlyYen: price.optionsMonthlyYen,
    headquartersMonthlyYen: price.headquartersMonthlyYen,
    friendOverageMonthlyYen: price.friendOverageMonthlyYen,
    linkedAccountSlotsMonthlyYen: price.linkedAccountSlotsMonthlyYen,
    plannedMonthlyTotalYen: quote.interval === 'month' ? price.monthlyTotalYen : null,
    linkedSlots: price.linkedAccountSlots,
  };
}

/** Initial annual value for the editor. Operations can adjust it before the quote is issued. */
export function suggestMusuboQuoteAnnualLineCharge(schedule: MusuboPriceSchedule, lineCount: number): number {
  const price = musuboPrice({
    lineCount,
    friendCountExcludingBlocked: 0,
    interval: 'year',
    schedule,
    individualQuoteContext: true,
  });
  return price.annualLineChargeYen;
}

/** Acceptance locks the final units and trial condition, even if the quote expires before card registration. */
export function acceptMusuboIndividualQuote(quote: MusuboIndividualQuote, acceptedAt: string): MusuboIndividualQuote {
  musuboIndividualQuotePrice(quote);
  if (quote.acceptedAt !== null && individualQuoteAccess(quote, quote.acceptedAt) === 'accepted') return quote;
  const access = individualQuoteAccess(quote, acceptedAt);
  if (access === 'accepted') return quote;
  if (access !== 'available') throw new RangeError('This quote can no longer be accepted');
  return {
    ...quote,
    acceptedAt,
    plannedLinkedAccountsByLine: quote.plannedLinkedAccountsByLine.map((counts) => ({ ...counts })),
    trialPeriod: { ...quote.trialPeriod },
    finalSchedule: { ...quote.finalSchedule },
  };
}

/** A replacement invalidates an unaccepted old link. Accepted contract terms remain untouched. */
export function supersedeMusuboIndividualQuote(quote: MusuboIndividualQuote, supersededAt: string): MusuboIndividualQuote {
  musuboIndividualQuotePrice(quote);
  if (quote.acceptedAt !== null && individualQuoteAccess(quote, quote.acceptedAt) === 'accepted') {
    throw new RangeError('An accepted quote cannot be superseded');
  }
  const access = individualQuoteAccess(quote, supersededAt);
  if (access === 'accepted') throw new RangeError('An accepted quote cannot be superseded');
  if (access === 'superseded') return quote;
  return { ...quote, supersededAt };
}
