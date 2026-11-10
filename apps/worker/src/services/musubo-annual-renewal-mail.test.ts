import { describe, expect, it } from 'vitest';
import { musuboAnnualRenewalMail } from './musubo-annual-renewal-mail.js';

const base = {
  estimatedAt: '2027-11-08T00:00:00+09:00', renewalAt: '2027-12-08T00:00:00+09:00',
  activeLineCountAfterReservations: 1, annualLineChargeYen: 63_720,
  monthlyOptionsAfterRenewalYen: 0, headquartersEndsAtRenewal: true,
  endingLine: { name: '公式LINE B', lastUsableAt: '2027-12-07T23:59:59+09:00' },
  billingUrl: 'https://admin.example.com/hq/billing',
};

describe('年次更新30日前の予定料金メール', () => {
  it('終了予約を反映したLINE数、年額、オプション料金を別々に示す', () => {
    const mail = musuboAnnualRenewalMail(base);
    expect(mail.subject).toBe('【musubo】年払い更新日とお支払い予定のご案内');
    expect(mail.text).toContain('次の年次更新（2027年11月8日時点の予定）');
    expect(mail.text).toContain('更新後の有効LINE：1個');
    expect(mail.text).toContain('LINE基本料金：¥63,720');
    expect(mail.text).toContain('毎月のオプション料金：¥0');
    expect(mail.text).toContain('公式LINE Bは2027年12月7日まで利用');
  });

  it('終了予約のない年次更新でも予定額を案内する', () => {
    const mail = musuboAnnualRenewalMail({ ...base, activeLineCountAfterReservations: 2,
      annualLineChargeYen: 149_040, monthlyOptionsAfterRenewalYen: 5_500,
      headquartersEndsAtRenewal: false, endingLine: undefined });
    expect(mail.text).toContain('有効LINE：2個');
    expect(mail.text).toContain('毎月のオプション料金：¥5,500');
    expect(mail.text).not.toContain('公式LINE B');
  });

  it('更新日時や料金の不整合を拒否する', () => {
    expect(() => musuboAnnualRenewalMail({ ...base, renewalAt: base.estimatedAt })).toThrow();
    expect(() => musuboAnnualRenewalMail({ ...base, annualLineChargeYen: -1 })).toThrow();
  });
});
