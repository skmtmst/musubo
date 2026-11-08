import { describe, expect, it } from 'vitest';
import { DEFAULT_MUSUBO_PRICE_SCHEDULE } from './musubo-pricing.js';
import { acceptMusuboIndividualQuote, musuboIndividualQuotePrice, suggestMusuboQuoteAnnualLineCharge,
  supersedeMusuboIndividualQuote, type MusuboIndividualQuote } from './musubo-individual-quote.js';

const quote = (overrides: Partial<MusuboIndividualQuote> = {}): MusuboIndividualQuote => ({
  quoteNumber: 'Q-2026-1108-01', companyName: '株式会社サンプルフード',
  issuedAt: '2026-11-08T00:00:00+09:00', expiresAt: '2026-12-08T23:59:00+09:00',
  acceptedAt: null, supersededAt: null, interval: 'month',
  plannedLineCount: 1, plannedFriendCountExcludingBlocked: 2800,
  plannedLinkedAccountsByLine: [{ googleBusiness: 11, instagram: 1 }],
  trialPeriod: { unit: 'days', value: 30 },
  finalSchedule: { ...DEFAULT_MUSUBO_PRICE_SCHEDULE }, finalAnnualLineChargeYen: null,
  ...overrides,
});

describe('会社ごとの個別見積もり', () => {
  it('Googleマイビジネス11個では追加10枠を計算する', () => {
    const result = musuboIndividualQuotePrice(quote());
    expect(result).toMatchObject({ linkedSlots: 10, optionsMonthlyYen: 33_000, plannedMonthlyTotalYen: 38_900 });
  });

  it('LINE11個以上の最終単価と年額を保存し、年払いを再割引しない', () => {
    const schedule = { ...DEFAULT_MUSUBO_PRICE_SCHEDULE,
      eleventhAndLaterLineYen: 6_500, friendAllowanceForElevenOrMore: 50_000 };
    const annual = suggestMusuboQuoteAnnualLineCharge(schedule, 12);
    const result = musuboIndividualQuotePrice(quote({ interval: 'year', plannedLineCount: 12,
      plannedLinkedAccountsByLine: [{ googleBusiness: 1, instagram: 1 }],
      finalSchedule: schedule, finalAnnualLineChargeYen: annual - 1000 }));
    expect(result.finalAnnualLineChargeYen).toBe(annual - 1000);
    expect(result.optionsMonthlyYen).toBe(5_500);
    expect(result.plannedMonthlyTotalYen).toBeNull();
  });

  it('期限内の同意後は期限が過ぎても確定した条件を保持する', () => {
    const accepted = acceptMusuboIndividualQuote(quote(), '2026-12-07T14:20:00+09:00');
    expect(accepted.acceptedAt).toBe('2026-12-07T14:20:00+09:00');
    expect(accepted.finalSchedule).not.toBe(quote().finalSchedule);
    expect(acceptMusuboIndividualQuote(accepted, '2026-12-10T00:00:00+09:00')).toBe(accepted);
  });

  it('未同意の期限切れは承認できず、再発行は旧リンクを無効にする', () => {
    expect(() => acceptMusuboIndividualQuote(quote(), '2026-12-09T00:00:00+09:00')).toThrow();
    const superseded = supersedeMusuboIndividualQuote(quote(), '2026-12-01T00:00:00+09:00');
    expect(() => acceptMusuboIndividualQuote(superseded, '2026-12-02T00:00:00+09:00')).toThrow();
    expect(() => supersedeMusuboIndividualQuote(acceptMusuboIndividualQuote(quote(), '2026-12-01T00:00:00+09:00'), '2026-12-02T00:00:00+09:00')).toThrow();
  });
});
