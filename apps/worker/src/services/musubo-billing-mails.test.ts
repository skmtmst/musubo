import { describe, expect, it } from 'vitest';
import { safeMailUrl } from './musubo-mail-layout.js';
import { musuboInvoiceMail } from './musubo-invoice-mail.js';
import { musuboTrialMail } from './musubo-trial-mail.js';

const invoice = {
  amountYen: 5900, invoiceAt: '2026-12-08T10:00:00+09:00',
  graceDeadlineAt: '2026-12-15T10:00:00+09:00',
  billingUrl: 'https://admin.example.com/hq/billing',
} as const;

describe('有料請求の通知メール', () => {
  it('失敗・6日目・停止・復帰を別々の件名と利用状態で伝える', () => {
    const failed = musuboInvoiceMail({ ...invoice, event: 'failed' });
    expect(failed.subject).toBe('【musubo】お支払いの確認をお願いします');
    expect(failed.html).toContain('2026年12月15日 10:00に利用を一時停止');
    expect(failed.text).toContain('¥5,900（税込）');
    const warning = musuboInvoiceMail({ ...invoice, event: 'day_six' });
    expect(warning.subject).toContain('明日、利用が一時停止');
    const suspended = musuboInvoiceMail({ ...invoice, event: 'suspended' });
    expect(suspended.text).toContain('停止中に送れなかった予約配信は自動送信しません');
    const recovered = musuboInvoiceMail({ ...invoice, event: 'recovered', nextChargeAt: '2027-01-08T10:00:00+09:00' });
    expect(recovered.subject).toBe('【musubo】お支払いを確認しました');
    expect(recovered.text).toContain('2027年1月8日');
  });

  it('危険なURLを拒否し、次回請求日が未確定なら請求画面を案内する', () => {
    expect(() => musuboInvoiceMail({ ...invoice, event: 'failed', billingUrl: 'javascript:alert(1)' })).toThrow();
    expect(() => safeMailUrl('http://admin.example.com/hq/billing')).toThrow();
    expect(safeMailUrl('https://admin.example.com/hq/billing')).toBe(invoice.billingUrl);
    expect(musuboInvoiceMail({ ...invoice, event: 'recovered' }).text).toContain('請求画面でご確認ください');
  });
});

const trial = {
  activatedDateJst: '2026-11-08', trialPeriod: { unit: 'days', value: 30 } as const,
  activeLineCount: 1, estimatedFirstChargeYen: 5900, lineBasicDiscountPercent: 0,
  accountUrl: 'https://admin.example.com/hq/accounts', billingUrl: 'https://admin.example.com/hq/billing',
};

describe('無料体験の通知メール', () => {
  it('30日の開始と終了7日前で初回請求日を一致させる', () => {
    const started = musuboTrialMail({ ...trial, event: 'started' });
    expect(started.subject).toContain('30日間の無料体験');
    expect(started.text).toContain('30日間の無料体験が始まりました');
    expect(started.text).toContain('2026年11月8日～2026年12月7日（30日）');
    expect(started.text).toContain('2026年12月8日');
    expect(started.html).toContain('width:280px');
    expect(started.html).toContain('text-align:center');
    const ending = musuboTrialMail({ ...trial, event: 'ending' });
    expect(ending.text).toContain('30日間の無料体験はまもなく終了します');
    expect(ending.text).toContain('現在の予定額：¥5,900（税込）');
  });

  it('3か月無料と基本料金50%割引を変数から表示し、オプションを割引しない', () => {
    const special = musuboTrialMail({ ...trial, event: 'ending', trialPeriod: { unit: 'months', value: 3 },
      estimatedFirstChargeYen: 2950, lineBasicDiscountPercent: 50 });
    expect(special.text).toContain('3か月の無料体験');
    expect(special.text).toContain('2027年2月7日');
    expect(special.text).toContain('2027年2月8日');
    expect(special.text).toContain('LINE基本料金のみ50%オフ');
    expect(special.text).toContain('追加連携枠は割引対象外');
  });
});
