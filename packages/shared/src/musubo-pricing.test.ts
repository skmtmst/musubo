import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MUSUBO_PRICE_SCHEDULE,
  linkedAccountSlots,
  musuboPrice,
  musuboTrialDates,
  prorateAnnualLineIncrement,
  prorateMonthlyIncrement,
} from './musubo-pricing.js';

const base = { friendCountExcludingBlocked: 2_800, interval: 'month' as const };

describe('musubo LINE pricing', () => {
  it('uses the Pen amounts at the first, second, third, and sixth LINE', () => {
    expect(musuboPrice({ ...base, lineCount: 1 }).monthlyTotalYen).toBe(5_900);
    expect(musuboPrice({ ...base, lineCount: 2 }).monthlyTotalYen).toBe(19_300);
    expect(musuboPrice({ ...base, lineCount: 3 }).monthlyTotalYen).toBe(27_200);
    expect(musuboPrice({ ...base, lineCount: 6 }).monthlyTotalYen).toBe(49_900);
  });

  it('adds friend overage in ten-thousand-person blocks after the threshold', () => {
    const at = musuboPrice({ ...base, lineCount: 1, friendCountExcludingBlocked: 3_000 });
    const first = musuboPrice({ ...base, lineCount: 1, friendCountExcludingBlocked: 3_001 });
    const second = musuboPrice({ ...base, lineCount: 1, friendCountExcludingBlocked: 13_001 });
    expect(at.friendOverageMonthlyYen).toBe(0);
    expect(first.friendOverageMonthlyYen).toBe(1_100);
    expect(second.friendOverageMonthlyYen).toBe(2_200);
    expect(musuboPrice({ ...base, lineCount: 2, friendCountExcludingBlocked: 15_000 }).friendOverageMonthlyYen).toBe(0);
    expect(musuboPrice({ ...base, lineCount: 6, friendCountExcludingBlocked: 50_001 }).friendOverageMonthlyYen).toBe(1_100);
  });

  it('counts the larger social connection count once for each LINE', () => {
    expect(linkedAccountSlots({ googleBusiness: 0, instagram: 0 })).toBe(0);
    expect(linkedAccountSlots({ googleBusiness: 2, instagram: 1 })).toBe(1);
    expect(linkedAccountSlots({ googleBusiness: 2, instagram: 3 })).toBe(2);
    const result = musuboPrice({ ...base, lineCount: 2, linkedAccountsByLine: [
      { googleBusiness: 2, instagram: 1 }, { googleBusiness: 2, instagram: 3 },
    ] });
    expect(result.linkedAccountSlots).toBe(3);
    expect(result.linkedAccountSlotsMonthlyYen).toBe(9_900);
  });

  it('discounts LINE base only, leaving headquarters and linked slots unchanged', () => {
    const result = musuboPrice({ ...base, lineCount: 2, lineBasicDiscountPercent: 50,
      linkedAccountsByLine: [{ googleBusiness: 2, instagram: 1 }],
    });
    expect(result.lineBasicMonthlyYen).toBe(6_900);
    expect(result.headquartersMonthlyYen).toBe(5_500);
    expect(result.linkedAccountSlotsMonthlyYen).toBe(3_300);
    expect(result.monthlyTotalYen).toBe(15_700);
  });

  it('takes the yearly ten percent off the LINE base only', () => {
    const result = musuboPrice({ ...base, interval: 'year', lineCount: 2 });
    expect(result.annualLineChargeYen).toBe(149_040);
    expect(result.optionsMonthlyYen).toBe(5_500);
    expect(musuboPrice({ ...base, interval: 'year', lineCount: 1 }).annualLineChargeYen).toBe(63_720);
  });

  it('requires an individual quote at eleven and supports explicit quoted prices', () => {
    expect(() => musuboPrice({ ...base, lineCount: 11 })).toThrow(/individual quote/);
    expect(() => musuboPrice({ ...base, lineCount: 1, linkedAccountsByLine: [{ googleBusiness: 11, instagram: 1 }] })).toThrow(/individual quote/);
    expect(() => musuboPrice({ ...base, lineCount: 1, schedule: DEFAULT_MUSUBO_PRICE_SCHEDULE, linkedAccountsByLine: [{ googleBusiness: 11, instagram: 1 }] })).toThrow(/individual quote/);
    const quotedSchedule = {
      ...DEFAULT_MUSUBO_PRICE_SCHEDULE, eleventhAndLaterLineYen: 6_900, friendAllowanceForElevenOrMore: 50_000,
    };
    expect(() => musuboPrice({ ...base, lineCount: 11, schedule: quotedSchedule })).toThrow(/individual quote/);
    const quoted = musuboPrice({ ...base, lineCount: 11, schedule: quotedSchedule, individualQuoteContext: true });
    expect(quoted.lineBasicBeforeDiscountYen).toBe(78_900);
  });

  it('rejects invalid quantities and discounts', () => {
    expect(() => musuboPrice({ ...base, lineCount: 0 })).toThrow();
    expect(() => musuboPrice({ ...base, lineCount: 1, friendCountExcludingBlocked: -1 })).toThrow();
    expect(() => musuboPrice({ ...base, lineCount: 1, lineBasicDiscountPercent: 101 })).toThrow();
  });

  it('calculates variable quotes in integer yen and rejects totals outside safe range', () => {
    const large = Number.MAX_SAFE_INTEGER;
    const exact = musuboPrice({ ...base, lineCount: 1, lineBasicDiscountPercent: 99,
      schedule: { ...DEFAULT_MUSUBO_PRICE_SCHEDULE, firstLineYen: large } });
    expect(exact.lineBasicMonthlyYen).toBe(Number(BigInt(large) / 100n));
    expect(exact.lineBasicAnnualYen).toBe(Number(BigInt(large) * 12n * 90n / 10_000n));
    expect(() => musuboPrice({ ...base, lineCount: 2,
      schedule: { ...DEFAULT_MUSUBO_PRICE_SCHEDULE, firstLineYen: large } })).toThrow(/safe JPY/);
  });
});

describe('trial and incremental billing dates', () => {
  it('starts thirty free calendar days with LINE activation', () => {
    expect(musuboTrialDates('2026-11-08', { unit: 'days', value: 30 })).toEqual({
      activationDate: '2026-11-08', lastFreeDate: '2026-12-07', firstChargeDate: '2026-12-08',
    });
  });

  it('supports a three-month condition and clamps month ends', () => {
    expect(musuboTrialDates('2026-11-08', { unit: 'months', value: 3 }).firstChargeDate).toBe('2027-02-08');
    expect(musuboTrialDates('2027-01-31', { unit: 'months', value: 1 }).firstChargeDate).toBe('2027-02-28');
    expect(musuboTrialDates('2028-01-31', { unit: 'months', value: 1 }).firstChargeDate).toBe('2028-02-29');
  });

  it('prorates a successful addition but not more than a full period', () => {
    expect(prorateMonthlyIncrement(13_400, 15, 30)).toBe(6_700);
    expect(prorateMonthlyIncrement(3_300, 15, 30)).toBe(1_650);
    expect(() => prorateMonthlyIncrement(3_300, 31, 30)).toThrow();
    expect(prorateMonthlyIncrement(Number.MAX_SAFE_INTEGER, 1, 3))
      .toBe(Number(BigInt(Number.MAX_SAFE_INTEGER) / 3n));
  });

  it('prorates annual LINE additions using the actual 365- or 366-day period', () => {
    expect(prorateAnnualLineIncrement({ annualIncrementYen: 85_320,
      periodStartDateJst: '2026-12-08', activationDateJst: '2027-06-08', renewalDateJst: '2027-12-08' }))
      .toEqual({ chargeYen: 42_776, remainingDays: 183, annualPeriodDays: 365 });
    expect(prorateAnnualLineIncrement({ annualIncrementYen: 42_660,
      periodStartDateJst: '2027-02-08', activationDateJst: '2027-08-08', renewalDateJst: '2028-02-08' }))
      .toEqual({ chargeYen: 21_505, remainingDays: 184, annualPeriodDays: 365 });
    expect(prorateAnnualLineIncrement({ annualIncrementYen: 100,
      periodStartDateJst: '2027-12-08', activationDateJst: '2028-06-08', renewalDateJst: '2028-12-08' }).annualPeriodDays)
      .toBe(366);
    expect(() => prorateAnnualLineIncrement({ annualIncrementYen: 100,
      periodStartDateJst: '2026-12-08', activationDateJst: '2027-12-08', renewalDateJst: '2027-12-08' })).toThrow();
    expect(() => prorateAnnualLineIncrement({ annualIncrementYen: 100,
      periodStartDateJst: '2027-01-01', activationDateJst: '2027-06-01', renewalDateJst: '2027-12-01' })).toThrow();
  });
});
