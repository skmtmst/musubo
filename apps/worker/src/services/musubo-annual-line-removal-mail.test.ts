import { describe, expect, it } from 'vitest';
import { musuboAnnualLineRemovalMail } from './musubo-annual-line-removal-mail.js';

const base = { lineName: '公式LINE B', previousLineCount: 2 as const,
  nextAnnualRenewalAt: '2027-12-08T00:00:00+09:00', nextAnnualLineChargeYen: 63_720,
  accountUrl: 'https://admin.example.com/hq/accounts' };

describe('年払い中に2個から1個へ減らす通知', () => {
  it('年次更新で終了する予約では、利用最終日と更新後の料金を示す', () => {
    const mail = musuboAnnualLineRemovalMail({ ...base, event: 'scheduled',
      endAt: '2027-12-08T00:00:00+09:00', lastUsableAt: '2027-12-07T23:59:59+09:00' });
    expect(mail.subject).toContain('利用終了予約');
    expect(mail.text).toContain('2027年12月7日まで利用');
    expect(mail.text).toContain('2個 → 1個');
    expect(mail.text).toContain('¥63,720');
    expect(mail.text).toContain('2027年12月8日から請求対象外');
  });

  it('即時終了では月次オプションと次回年額を別々に示す', () => {
    const mail = musuboAnnualLineRemovalMail({ ...base, event: 'immediate',
      endedAt: '2027-06-20T12:00:00+09:00',
      nextMonthlyChargeAt: '2027-07-08T00:00:00+09:00', nextMonthlyOptionsYen: 0 });
    expect(mail.subject).toContain('利用終了のご案内');
    expect(mail.text).toContain('2027年6月20日に公式LINE Bの利用を終了');
    expect(mail.text).toContain('次の月次請求：2027年7月8日　¥0');
    expect(mail.text).toContain('次の年次更新：2027年12月8日　¥63,720');
    expect(mail.text).toContain('年払い済みのLINE基本料金は返金されません');
  });

  it('年次更新を超える予約を作らない', () => {
    expect(() => musuboAnnualLineRemovalMail({ ...base, event: 'scheduled',
      endAt: '2027-12-09T00:00:00+09:00', lastUsableAt: '2027-12-08T23:59:59+09:00' })).toThrow();
  });
});
