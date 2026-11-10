import {
  lineBasicDiscountForDate, musuboIndividualQuotePrice, musuboPrice,
  prorateAnnualLineIncrement, prorateMonthlyIncrement,
  type AppliedMusuboCondition, type MusuboIndividualQuote,
} from '@line-crm/shared';

function calendarDay(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError('Invalid billing date');
  const time = Date.parse(`${value}T00:00:00Z`);
  const calendar = new Date(time);
  if (!Number.isFinite(time) || calendar.getUTCFullYear() !== Number(value.slice(0, 4))
    || calendar.getUTCMonth() + 1 !== Number(value.slice(5, 7))
    || calendar.getUTCDate() !== Number(value.slice(8, 10))) {
    throw new RangeError('Invalid billing date');
  }
  return time / 86_400_000;
}

/** Only agreed LINE core and automatic HQ increment; friend/linked usage is billed separately. */
export function musuboLineAdditionPrice(input: {
  condition: AppliedMusuboCondition;
  quote?: MusuboIndividualQuote | null;
  interval: 'month' | 'year';
  activeLineCount: number;
  activationDateJst: string;
  monthlyPeriodStartJst: string;
  nextMonthlyChargeDateJst: string;
  annualPeriodStartJst?: string;
  nextAnnualRenewalDateJst?: string;
  trialing: boolean;
  firstChargeDateJst?: string;
}): {
  addedLineOrdinal: number;
  coreIncrementYen: number;
  coreIncrementInterval: 'month' | 'year';
  headquartersIncrementMonthlyYen: number;
  dueNowYen: number;
  contractedLineCapacity: number;
} {
  const { condition, quote, interval, activeLineCount } = input;
  if (!Number.isSafeInteger(activeLineCount) || activeLineCount < 1) {
    throw new RangeError('At least one LINE must already be active');
  }
  const ordinal = activeLineCount + 1;
  const today = calendarDay(input.activationDateJst);
  const monthlyStart = calendarDay(input.monthlyPeriodStartJst);
  const monthlyEnd = calendarDay(input.nextMonthlyChargeDateJst);
  if (monthlyStart > today || today >= monthlyEnd) throw new RangeError('Monthly period is unavailable');
  if (input.trialing && !input.firstChargeDateJst) {
    throw new RangeError('Trial first charge date is unavailable');
  }
  if (quote && (!quote.acceptedAt || quote.supersededAt || quote.interval !== interval)) {
    throw new RangeError('Accepted quote does not match this contract');
  }
  if (quote && quote.plannedLineCount > 10 && ordinal > quote.plannedLineCount) {
    throw new RangeError('An amended quote is required above the contracted LINE capacity');
  }
  if ((!quote || quote.plannedLineCount <= 10) && ordinal > 10) {
    throw new RangeError('An individual quote is required for eleven or more LINE accounts');
  }
  const schedule = quote?.finalSchedule ?? condition.schedule;
  const discount = quote ? 0 : lineBasicDiscountForDate(condition,
    input.trialing ? input.firstChargeDateJst! : input.activationDateJst);
  const contracted = quote && quote.plannedLineCount > 10;
  const coreBefore = contracted ? null : musuboPrice({
    lineCount: activeLineCount, friendCountExcludingBlocked: 0, interval,
    schedule, lineBasicDiscountPercent: discount, individualQuoteContext: Boolean(quote),
  });
  const coreAfter = contracted ? null : musuboPrice({
    lineCount: ordinal, friendCountExcludingBlocked: 0, interval,
    schedule, lineBasicDiscountPercent: discount, individualQuoteContext: Boolean(quote),
  });
  if (quote && interval === 'year' && !contracted) {
    // The final annual quote amount cannot safely be split into per-LINE increments.
    throw new RangeError('An annual quoted LINE increment requires an amended quote');
  }
  if (contracted && quote) musuboIndividualQuotePrice(quote);
  const coreIncrementYen = contracted ? 0 : interval === 'year'
    ? coreAfter!.annualLineChargeYen - coreBefore!.annualLineChargeYen
    : coreAfter!.lineBasicMonthlyYen - coreBefore!.lineBasicMonthlyYen;
  const headquartersIncrementMonthlyYen = activeLineCount === 1 ? schedule.headquartersYen : 0;
  const monthlyRemaining = monthlyEnd - today;
  const monthlyLength = monthlyEnd - monthlyStart;
  let dueNowYen = 0;
  if (!input.trialing) {
    dueNowYen = prorateMonthlyIncrement(headquartersIncrementMonthlyYen, monthlyRemaining, monthlyLength);
    if (interval === 'month') {
      dueNowYen += prorateMonthlyIncrement(coreIncrementYen, monthlyRemaining, monthlyLength);
    } else if (coreIncrementYen > 0) {
      if (!input.annualPeriodStartJst || !input.nextAnnualRenewalDateJst) {
        throw new RangeError('Annual billing period is unavailable');
      }
      dueNowYen += prorateAnnualLineIncrement({
        annualIncrementYen: coreIncrementYen,
        periodStartDateJst: input.annualPeriodStartJst,
        activationDateJst: input.activationDateJst,
        renewalDateJst: input.nextAnnualRenewalDateJst,
      }).chargeYen;
    }
  }
  return {
    addedLineOrdinal: ordinal, coreIncrementYen, coreIncrementInterval: interval,
    headquartersIncrementMonthlyYen, dueNowYen,
    contractedLineCapacity: contracted && quote ? quote.plannedLineCount : ordinal,
  };
}
