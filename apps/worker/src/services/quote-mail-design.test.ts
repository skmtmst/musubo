import { describe, expect, it } from 'vitest';
import { DEFAULT_MUSUBO_PRICE_SCHEDULE, type MusuboIndividualQuote } from '@line-crm/shared';
import { individualQuoteMail, musuboQuoteInquiryReceiptMail, quoteReissueRequestReceiptMail } from './quote-mail-design.js';

const quote: MusuboIndividualQuote = {
  quoteNumber: 'Q-2026-1108-01', companyName: '株式会社サンプルフード',
  issuedAt: '2026-11-08T00:00:00+09:00', expiresAt: '2026-12-08T23:59:00+09:00',
  acceptedAt: null, supersededAt: null, interval: 'month', plannedLineCount: 1,
  plannedFriendCountExcludingBlocked: 2800,
  plannedLinkedAccountsByLine: [{ googleBusiness: 11, instagram: 1 }],
  trialPeriod: { unit: 'months', value: 3 },
  finalSchedule: { ...DEFAULT_MUSUBO_PRICE_SCHEDULE }, finalAnnualLineChargeYen: null,
};

describe('個別見積もりメール', () => {
  it('11個以上の問い合わせ受付では料金確定前の流れを案内する', () => {
    const receipt = musuboQuoteInquiryReceiptMail();
    expect(receipt.subject).toBe('【musubo】お見積もりのお問い合わせを受け付けました');
    expect(receipt.text).toContain('Googleマイビジネス数とInstagram数を確認');
    expect(receipt.text).toContain('同意後に利用開始の準備');
    expect(receipt.text).toContain('この時点でカード登録やお支払いは必要ありません');
    expect(receipt.html).toContain('今後のご案内');
  });
  it('承認済みのメールデザインと変数料金、中央ボタン、無料期間を出す', () => {
    const mail = individualQuoteMail({ quote, reviewUrl: 'https://admin.example.com/hq/quote?token=abc', kind: 'issued' });
    expect(mail.subject).toBe('【musubo】個別見積もりのご案内');
    expect(mail.html).toContain('¥38,900／月（税込）');
    expect(mail.html).toContain('最初のLINE有効化日から3か月無料');
    expect(mail.html).toContain('width:280px');
    expect(mail.html).toContain('text-align:center');
    expect(mail.text).toContain('https://admin.example.com/hq/quote?token=abc');
  });

  it('再発行のメールは旧リンク無効と再同意を案内する', () => {
    const mail = individualQuoteMail({ quote, reviewUrl: 'https://admin.example.com/hq/quote?token=new', kind: 'reissued' });
    expect(mail.subject).toContain('再発行');
    expect(mail.text).toContain('以前のお見積もりは無効');
    expect(mail.html).toContain('旧リンクからは同意できません');
    expect(mail.text).toContain('改めて同意');
  });

  it('年払いのオプションは月次と説明し、最終年額を再割引しない', () => {
    const mail = individualQuoteMail({ quote: { ...quote, interval: 'year', finalAnnualLineChargeYen: 63_720 },
      reviewUrl: 'https://admin.example.com/quote', kind: 'issued' });
    expect(mail.html).toContain('¥63,720／年（税込）');
    expect(mail.html).toContain('¥33,000／月は毎月別に請求');
  });

  it('再発行依頼の受付を知らせ、HTML注入と危険なリンクを防ぐ', () => {
    const receipt = quoteReissueRequestReceiptMail({ quoteNumber: '<script>alert(1)</script>' });
    expect(receipt.html).toContain('&lt;script&gt;');
    expect(receipt.html).not.toContain('<script>');
    expect(() => individualQuoteMail({ quote, reviewUrl: 'javascript:alert(1)', kind: 'issued' })).toThrow();
    expect(() => individualQuoteMail({ quote, reviewUrl: 'http://admin.example.com/quote?token=abc', kind: 'issued' })).toThrow();
    expect(() => individualQuoteMail({ quote: { ...quote, supersededAt: quote.issuedAt },
      reviewUrl: 'https://admin.example.com/quote', kind: 'issued' })).toThrow();
  });
});
