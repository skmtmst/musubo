import {
  lineBasicDiscountForDate, musuboIndividualQuotePrice, musuboPrice,
  type AppliedMusuboCondition, type MusuboIndividualQuote,
} from '@line-crm/shared';

export interface MusuboCoreTerms {
  amountYen: number;
  interval: 'month' | 'year';
  contractedLineCapacity: number;
}

/** The first subscription charges only a known LINE core amount. Usage options are reconciled separately. */
export function firstMusuboCoreTerms(input: {
  condition: AppliedMusuboCondition;
  interval: 'month' | 'year';
  firstChargeDate: string;
  quote?: MusuboIndividualQuote | null;
}): MusuboCoreTerms {
  const { condition, interval, firstChargeDate, quote } = input;
  if (quote) {
    if (!quote.acceptedAt || quote.supersededAt || quote.interval !== interval) {
      throw new Error('Accepted quote terms do not match the billing contract');
    }
    const price = musuboIndividualQuotePrice(quote);
    if (quote.plannedLineCount > 10) {
      return {
        amountYen: interval === 'year' ? price.finalAnnualLineChargeYen! : price.finalLineBasicMonthlyYen,
        interval,
        contractedLineCapacity: quote.plannedLineCount,
      };
    }
    if (interval === 'year' && quote.plannedLineCount !== 1) {
      throw new Error('Annual quote needs an agreed first-LINE amount');
    }
    const first = musuboPrice({
      lineCount: 1, friendCountExcludingBlocked: 0, interval,
      schedule: quote.finalSchedule, individualQuoteContext: true,
    });
    return {
      amountYen: interval === 'year' ? price.finalAnnualLineChargeYen! : first.lineBasicMonthlyYen,
      interval,
      contractedLineCapacity: 1,
    };
  }
  const first = musuboPrice({
    lineCount: 1, friendCountExcludingBlocked: 0, interval,
    schedule: condition.schedule,
    lineBasicDiscountPercent: lineBasicDiscountForDate(condition, firstChargeDate),
  });
  return {
    amountYen: interval === 'year' ? first.annualLineChargeYen : first.lineBasicMonthlyYen,
    interval,
    contractedLineCapacity: 1,
  };
}
