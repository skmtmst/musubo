import { describe, expect, it } from 'vitest';
import { musuboAnnualAddedLineMail } from './musubo-annual-line-mail.js';

const base = {
  previousLineCount: 1, activeLineCount: 2,
  lineBasicDiscountPercent: 0,
  accountUrl: 'https://admin.example.com/hq/accounts',
} as const;

describe('年払い中のLINE追加メール', () => {
  it('無料期間中は初回年額と初月オプションを区別し、本日の請求を0円で示す', () => {
    const mail = musuboAnnualAddedLineMail({ ...base, phase: 'trial',
      firstChargeAt: '2026-12-08T00:00:00+09:00',
      firstAnnualLineChargeYen: 149_040, firstMonthOptionsYen: 5_500 });
    expect(mail.subject).toContain('初回料金');
    expect(mail.text).toContain('本日の請求：¥0');
    expect(mail.text).toContain('2026年12月8日　¥154,540');
    expect(mail.text).toContain('LINE年額 ¥149,040 ＋ オプション初月 ¥5,500');
    expect(mail.text).toContain('年払い10%OFFはLINE基本料金だけ');
  });

  it('有料利用中は日割り、次の月次請求と年次更新を別々に示す', () => {
    const mail = musuboAnnualAddedLineMail({ ...base, phase: 'paid',
      paidNowYen: 48_276, proratedAnnualLineYen: 42_776, firstMonthOptionsYen: 5_500,
      remainingAnnualDays: 183, annualPeriodDays: 365,
      nextMonthlyChargeAt: '2027-07-08T00:00:00+09:00', nextMonthlyOptionsYen: 5_500,
      nextAnnualRenewalAt: '2027-12-08T00:00:00+09:00', nextAnnualLineChargeYen: 149_040 });
    expect(mail.subject).toContain('お支払いのご案内');
    expect(mail.text).toContain('接続時の請求：¥48,276');
    expect(mail.text).toContain('2027年7月8日　¥5,500');
    expect(mail.text).toContain('2027年12月8日　¥149,040');
    expect(mail.text).toContain('残り183日分 ¥42,776 ＋ オプション初月 ¥5,500');
  });

  it('特別条件ではLINE基本料金だけの割引と説明し、内訳が合わない請求を拒否する', () => {
    const special = { ...base, phase: 'paid' as const, lineBasicDiscountPercent: 50,
      paidNowYen: 27_005, proratedAnnualLineYen: 21_505, firstMonthOptionsYen: 5_500,
      remainingAnnualDays: 184, annualPeriodDays: 365,
      nextMonthlyChargeAt: '2027-09-08T00:00:00+09:00', nextMonthlyOptionsYen: 5_500,
      nextAnnualRenewalAt: '2028-02-08T00:00:00+09:00', nextAnnualLineChargeYen: 74_520 };
    expect(musuboAnnualAddedLineMail(special).text).toContain('50%OFFの特別条件と年払い10%OFFはLINE基本料金だけ');
    expect(() => musuboAnnualAddedLineMail({ ...special, paidNowYen: 26_005 })).toThrow(/Paid amount/);
  });
});
