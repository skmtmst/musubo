import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MUSUBO_PRICE_SCHEDULE, type AppliedMusuboCondition, type MusuboIndividualQuote,
} from '@line-crm/shared';
import { musuboLineAdditionPrice } from './musubo-line-addition-price.js';

const condition: AppliedMusuboCondition = {
  sourceConditionId: 'normal', sourceVersion: 1, internalName: '通常条件',
  appliedAt: '2026-11-09', trialPeriod: { unit: 'days', value: 30 },
  lineBasicDiscountPercent: 0, discountEndsOn: null,
  schedule: { ...DEFAULT_MUSUBO_PRICE_SCHEDULE },
};

const period = {
  condition, interval: 'month' as const, activeLineCount: 1,
  activationDateJst: '2027-01-16', monthlyPeriodStartJst: '2027-01-01',
  nextMonthlyChargeDateJst: '2027-01-31', trialing: false,
};

describe('server-side paid LINE addition price', () => {
  it('charges only the remaining portion of the second LINE and HQ option', () => {
    expect(musuboLineAdditionPrice(period)).toMatchObject({
      addedLineOrdinal: 2, coreIncrementYen: 7_900,
      headquartersIncrementMonthlyYen: 5_500, dueNowYen: 6_700,
    });
  });

  it('does not charge an addition during the free trial', () => {
    expect(musuboLineAdditionPrice({ ...period, trialing: true,
      firstChargeDateJst: '2027-02-01' }).dueNowYen).toBe(0);
  });

  it('keeps a special LINE discount off the HQ option', () => {
    const special = { ...condition, lineBasicDiscountPercent: 50 };
    expect(musuboLineAdditionPrice({ ...period, condition: special })).toMatchObject({
      coreIncrementYen: 3_950, headquartersIncrementMonthlyYen: 5_500,
      dueNowYen: 4_725,
    });
  });

  it('uses the first paid date, not the connection date, for a trial addition discount', () => {
    const limited = { ...condition, lineBasicDiscountPercent: 50,
      discountEndsOn: '2027-01-31' };
    expect(musuboLineAdditionPrice({ ...period, condition: limited, trialing: true,
      firstChargeDateJst: '2027-02-01' }).coreIncrementYen).toBe(7_900);
  });

  it('does not charge core again within an accepted eleven-LINE capacity', () => {
    const quote: MusuboIndividualQuote = {
      quoteNumber: 'Q-11', companyName: 'Example株式会社', issuedAt: '2026-11-09T00:00:00+09:00',
      expiresAt: '2026-11-30T23:59:59+09:00', acceptedAt: '2026-11-10T12:00:00+09:00',
      supersededAt: null, interval: 'month', plannedLineCount: 11,
      plannedFriendCountExcludingBlocked: 0, plannedLinkedAccountsByLine: [],
      trialPeriod: { unit: 'days', value: 30 },
      finalSchedule: { ...DEFAULT_MUSUBO_PRICE_SCHEDULE, eleventhAndLaterLineYen: 7_500,
        friendAllowanceForElevenOrMore: 50_000 }, finalAnnualLineChargeYen: null,
    };
    expect(musuboLineAdditionPrice({ ...period, quote })).toMatchObject({
      coreIncrementYen: 0, headquartersIncrementMonthlyYen: 5_500,
      dueNowYen: 2_750, contractedLineCapacity: 11,
    });
    expect(() => musuboLineAdditionPrice({ ...period, quote, activeLineCount: 11 }))
      .toThrow('amended quote');
  });

  it('rejects dates outside the current monthly billing period', () => {
    expect(() => musuboLineAdditionPrice({ ...period, activationDateJst: '2027-01-31' }))
      .toThrow('Monthly period');
  });
});
