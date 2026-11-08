import { describe, expect, it } from 'vitest';
import { musuboAddedLineMail, musuboFinalLineMail, musuboLinkedAccountMail, musuboPendingLineMail } from './musubo-account-lifecycle-mail.js';

const actionUrl = 'https://admin.example.com/hq/billing';

describe('LINE追加・連携解除のメール', () => {
  it('LINE追加の決済失敗では既存LINEの継続と保留期限を示す', () => {
    const failed = musuboPendingLineMail({ event: 'payment_failed', addedLineOrdinal: 2, activeLineCount: 1,
      amountYen: 6700, holdUntil: '2027-01-20T18:00:00+09:00', actionUrl });
    expect(failed.subject).toContain('お支払いを確認してください');
    expect(failed.text).toContain('現在お使いのLINEは通常どおり利用できます');
    expect(failed.text).toContain('2027年1月20日 18:00');
    const expired = musuboPendingLineMail({ event: 'expired', addedLineOrdinal: 2, activeLineCount: 1,
      amountYen: 6700, holdUntil: '2027-01-20T18:00:00+09:00', actionUrl });
    expect(expired.text).toContain('最新の料金を確認・同意');
    expect(expired.text).toContain('LINEの再認証');
  });

  it('追加分の成功確認後だけ料金と有効LINE数を表示する', () => {
    const mail = musuboAddedLineMail({ previousLineCount: 1, activeLineCount: 2, trialing: false,
      amountPaidNowYen: 6700, nextMonthlyTotalYen: 19300, accountUrl: actionUrl });
    expect(mail.text).toContain('1個 → 2個');
    expect(mail.text).toContain('¥6,700');
    expect(mail.text).toContain('¥19,300');
    expect(() => musuboAddedLineMail({ previousLineCount: 1, activeLineCount: 3, trialing: false,
      amountPaidNowYen: 0, nextMonthlyTotalYen: 0, accountUrl: actionUrl })).toThrow();
  });

  it('連携解除はすぐ停止、減額は次の月次請求と伝える', () => {
    const common = { lineName: '公式LINE A', service: 'googleBusiness' as const,
      before: { googleBusiness: 3, instagram: 2 }, after: { googleBusiness: 2, instagram: 2 },
      linkedAccountSlotYen: 3300, nextMonthlyChargeAt: '2027-02-08T00:00:00+09:00', actionUrl };
    const removed = musuboLinkedAccountMail({ ...common, event: 'removed' });
    expect(removed.text).toContain('3個 → 2個');
    expect(removed.text).toContain('2枠 → 1枠');
    expect(removed.text).toContain('¥3,300／月');
    expect(removed.text).toContain('次の月次請求日までに枠を再利用した場合');
    const added = musuboLinkedAccountMail({ ...common, event: 'added', before: common.after, after: common.before, amountPaidNowYen: 1650 });
    expect(added.text).toContain('¥1,650');
    expect(added.text).toContain('¥6,600／月');
  });

  it('多いほうの連携数が変わらない解除では減額を案内しない', () => {
    const removed = musuboLinkedAccountMail({
      event: 'removed', lineName: '公式LINE A', service: 'googleBusiness',
      before: { googleBusiness: 3, instagram: 3 },
      after: { googleBusiness: 2, instagram: 3 },
      linkedAccountSlotYen: 3300, nextMonthlyChargeAt: '2027-02-08T00:00:00+09:00', actionUrl,
    });
    expect(removed.text).toContain('今回の解除では料金は変わりません');
    expect(removed.text).toContain('料金変更：なし');
    expect(removed.text).toContain('追加枠料金：¥6,600／月');
    expect(removed.text).not.toContain('減額開始');
  });

  it('無料期間などで今回0円の連携先追加は決済済み・日割り請求と誤案内しない', () => {
    const added = musuboLinkedAccountMail({
      event: 'added', lineName: '公式LINE A', service: 'instagram',
      before: { googleBusiness: 1, instagram: 1 }, after: { googleBusiness: 1, instagram: 2 },
      amountPaidNowYen: 0, linkedAccountSlotYen: 3300,
      nextMonthlyChargeAt: '2027-02-08T00:00:00+09:00', actionUrl,
    });
    expect(added.text).toContain('今回のお支払いはありません');
    expect(added.text).not.toContain('決済を確認し');
    expect(added.text).not.toContain('日割り計算しました');
    expect(() => musuboLinkedAccountMail({
      event: 'added', lineName: '公式LINE A', service: 'instagram',
      before: { googleBusiness: 1, instagram: 1 }, after: { googleBusiness: 1, instagram: 2 },
      amountPaidNowYen: -1, linkedAccountSlotYen: 3300,
      nextMonthlyChargeAt: '2027-02-08T00:00:00+09:00', actionUrl,
    })).toThrow(/Invalid current charge/);
  });

  it('別サービスの既存追加枠を再利用する連携は、追加枠と請求を増やさず案内する', () => {
    const added = musuboLinkedAccountMail({
      event: 'added', lineName: '公式LINE A', service: 'instagram',
      before: { googleBusiness: 2, instagram: 1 }, after: { googleBusiness: 2, instagram: 2 },
      amountPaidNowYen: 0, linkedAccountSlotYen: 3300,
      nextMonthlyChargeAt: '2027-02-08T00:00:00+09:00', actionUrl,
    });
    expect(added.text).toContain('1枠 → 1枠');
    expect(added.text).toContain('今回のお支払いはありません');
    expect(added.text).toContain('¥3,300／月');
  });
});

describe('最後のLINEの利用終了・再開メール', () => {
  const base = { lineName: '公式LINE A', interval: 'year' as const, actionUrl };
  it('終了予約と即時終了で停止日と次回請求を示す', () => {
    const scheduled = musuboFinalLineMail({ ...base, event: 'scheduled', lastUsableAt: '2027-12-07T12:00:00+09:00', endAt: '2027-12-08T00:00:00+09:00' });
    expect(scheduled.text).toContain('2027年12月7日まで利用');
    expect(scheduled.text).toContain('次の年次更新：¥0');
    const immediate = musuboFinalLineMail({ ...base, event: 'immediate', endAt: '2027-08-01T12:00:00+09:00' });
    expect(immediate.text).toContain('請求履歴は引き続き確認');
    expect(immediate.text).toContain('無料体験の再適用はありません');
  });

  it('再開・終了予約の取消では次回料金を伝え、返金や二重請求を約束しない', () => {
    const common = { ...base, nextChargeAt: '2027-12-08T00:00:00+09:00', nextChargeYen: 63720 };
    const resumed = musuboFinalLineMail({ ...common, event: 'resumed', resumedAt: '2027-08-01T00:00:00+09:00', amountPaidNowYen: 0 });
    expect(resumed.text).toContain('お支払い済みの期間は二重請求しません');
    expect(resumed.text).toContain('¥63,720');
    const cancelled = musuboFinalLineMail({ ...common, event: 'cancelled' });
    expect(cancelled.text).toContain('終了予定：取り消し済み');
    expect(() => musuboFinalLineMail({ ...base, event: 'resumed' })).toThrow();
  });
});
