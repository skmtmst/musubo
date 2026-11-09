import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MUSUBO_PRICE_SCHEDULE, type AppliedMusuboCondition, type MusuboIndividualQuote,
} from '@line-crm/shared';
import { firstMusuboCoreTerms } from './musubo-contract-terms.js';

const condition: AppliedMusuboCondition = {
  sourceConditionId: 'normal', sourceVersion: 1, internalName: '通常条件',
  appliedAt: '2026-11-09', trialPeriod: { unit: 'days', value: 30 },
  lineBasicDiscountPercent: 0, discountEndsOn: null,
  schedule: { ...DEFAULT_MUSUBO_PRICE_SCHEDULE },
};

describe('first musubo core contract', () => {
  it('charges one actual LINE from the trial end on a normal monthly plan', () => {
    expect(firstMusuboCoreTerms({ condition, interval: 'month', firstChargeDate: '2026-12-09' }))
      .toEqual({ amountYen: 5_900, interval: 'month', contractedLineCapacity: 1 });
  });

  it('uses only the LINE core discount for a special annual plan', () => {
    const special = { ...condition, lineBasicDiscountPercent: 50, trialPeriod: { unit: 'months' as const, value: 3 } };
    expect(firstMusuboCoreTerms({ condition: special, interval: 'year', firstChargeDate: '2027-02-09' }).amountYen)
      .toBe(31_860);
  });

  it('does not silently keep a temporary discount after its end date', () => {
    expect(() => firstMusuboCoreTerms({
      condition: { ...condition, lineBasicDiscountPercent: 50, discountEndsOn: '2027-01-31' },
      interval: 'month', firstChargeDate: '2026-12-09',
    })).toThrow('requires scheduled repricing');
  });

  it('charges the accepted 11-LINE capacity even when only the first LINE is connected', () => {
    const quote: MusuboIndividualQuote = {
      quoteNumber: 'Q-11', companyName: 'Example株式会社', issuedAt: '2026-11-09T00:00:00+09:00',
      expiresAt: '2026-11-30T23:59:59+09:00', acceptedAt: '2026-11-10T12:00:00+09:00',
      supersededAt: null, interval: 'month', plannedLineCount: 11,
      plannedFriendCountExcludingBlocked: 0, plannedLinkedAccountsByLine: [],
      trialPeriod: { unit: 'days', value: 30 },
      finalSchedule: { ...DEFAULT_MUSUBO_PRICE_SCHEDULE, eleventhAndLaterLineYen: 7_500,
        friendAllowanceForElevenOrMore: 50_000 }, finalAnnualLineChargeYen: null,
    };
    expect(firstMusuboCoreTerms({ condition, interval: 'month', firstChargeDate: '2026-12-09', quote }))
      .toEqual({ amountYen: 79_500, interval: 'month', contractedLineCapacity: 11 });
  });
});
