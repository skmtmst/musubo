import { describe, expect, it } from 'vitest';
import {
  finalLineEndOption, individualQuoteAccess, invoiceFailureAccess,
  linkedSlotRemoval, pendingAdditionAccess,
} from './musubo-billing-flow.js';

describe('有料請求失敗後の利用状態', () => {
  const failedAt = '2027-01-01T00:00:00.000Z';
  it('7日間は利用でき、6日目に予告し、7日経過で停止する', () => {
    expect(invoiceFailureAccess({ failedAt }, '2027-01-07T00:00:00.000Z')).toMatchObject({
      state: 'grace', daysRemaining: 1, sendDaySixWarning: true,
    });
    expect(invoiceFailureAccess({ failedAt }, '2027-01-08T00:00:00.000Z').state).toBe('suspended');
  });
  it('支払いが確認できれば利用を再開する', () => {
    expect(invoiceFailureAccess({ failedAt, paidAt: '2027-01-09T00:00:00.000Z' }, '2027-01-09T00:00:01.000Z').state).toBe('recovered');
  });
});

describe('追加分の決済失敗', () => {
  const requestedAt = '2027-01-01T00:00:00.000Z';
  it('保留中も期限切れ後も既存の利用を止めない', () => {
    expect(pendingAdditionAccess({ requestedAt }, '2027-01-02T00:00:00.000Z')).toMatchObject({ state: 'pending', existingUsageAllowed: true });
    expect(pendingAdditionAccess({ requestedAt }, '2027-01-08T00:00:00.000Z')).toMatchObject({ state: 'expired', existingUsageAllowed: true });
  });
  it('期限内に支払いが成功した分だけ有効化する', () => {
    expect(pendingAdditionAccess({ requestedAt, paymentSucceededAt: '2027-01-03T00:00:00.000Z' }, '2027-01-03T00:00:01.000Z').state).toBe('activate');
    expect(pendingAdditionAccess({ requestedAt, paymentSucceededAt: '2027-01-08T00:00:00.000Z' }, '2027-01-08T00:00:01.000Z').state).toBe('expired');
  });
  it('決済が先に成功した場合は遅れて届いた取消で有効化を覆さない', () => {
    expect(pendingAdditionAccess({ requestedAt,
      paymentSucceededAt: '2027-01-03T00:00:00.000Z', cancelledAt: '2027-01-03T00:00:01.000Z',
    }, '2027-01-03T00:00:02.000Z').state).toBe('activate');
    expect(pendingAdditionAccess({ requestedAt,
      cancelledAt: '2027-01-03T00:00:00.000Z', paymentSucceededAt: '2027-01-03T00:00:01.000Z',
    }, '2027-01-03T00:00:02.000Z').state).toBe('cancelled');
  });
});

describe('見積もりの同意期限', () => {
  const base = {
    issuedAt: '2027-01-01T00:00:00.000Z',
    expiresAt: '2027-02-01T00:00:00.000Z',
    acceptedAt: null,
    supersededAt: null,
  };
  it('期限内の同意は期限後もカード登録へ進める', () => {
    expect(individualQuoteAccess({ ...base, acceptedAt: '2027-01-31T00:00:00.000Z' }, '2027-03-01T00:00:00.000Z')).toBe('accepted');
  });
  it('期限後の未同意と旧版を区別する', () => {
    expect(individualQuoteAccess(base, '2027-02-02T00:00:00.000Z')).toBe('expired');
    expect(individualQuoteAccess({ ...base, supersededAt: '2027-01-15T00:00:00.000Z' }, '2027-01-16T00:00:00.000Z')).toBe('superseded');
  });
  it('発行前の同意は許可せず、未来の同意も先取りして表示しない', () => {
    expect(() => individualQuoteAccess(base, '2026-12-31T23:59:00.000Z')).toThrow(/not been issued/);
    expect(individualQuoteAccess({ ...base, acceptedAt: '2027-01-10T00:00:00.000Z' },
      '2027-01-09T00:00:00.000Z')).toBe('available');
  });
});

describe('解約と連携枠減額', () => {
  it('無料体験・月払い・年払いとも次の請求前日までを初期選択とする', () => {
    expect(finalLineEndOption({ billingState: 'active', interval: 'month', nextMonthlyChargeAt: '2027-02-01T00:00:00.000Z' }, '2027-01-12T00:00:00.000Z')).toMatchObject({
      defaultEndAt: '2027-01-31T15:00:00.000Z', lastUsableDateJst: '2027-01-31',
    });
    expect(finalLineEndOption({ billingState: 'trialing', interval: 'year', trialFirstChargeAt: '2026-12-08T00:00:00+09:00' }, '2026-11-30T00:00:00+09:00')).toMatchObject({
      defaultEndAt: '2026-12-07T15:00:00.000Z', lastUsableDateJst: '2026-12-07',
    });
    expect(finalLineEndOption({ billingState: 'active', interval: 'year', nextAnnualRenewalAt: '2027-12-08T10:00:00+09:00' }, '2027-01-01T00:00:00+09:00').lastUsableDateJst).toBe('2027-12-07');
  });
  it('追加連携枠の解除は即時停止し、次回月次請求から減額する', () => {
    expect(linkedSlotRemoval({ disconnectedAt: '2027-01-12T00:00:00.000Z', nextMonthlyChargeAt: '2027-02-01T00:00:00.000Z' })).toEqual({
      accessEndsAt: '2027-01-12T00:00:00.000Z',
      reducedChargeStartsAt: '2027-02-01T00:00:00.000Z',
      refundDue: false,
    });
  });
});
