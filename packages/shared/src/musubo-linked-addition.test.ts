import { describe, expect, it } from 'vitest';
import { musuboLinkedAdditionPrice } from './musubo-linked-addition.js';

describe('Googleマイビジネス・Instagramの追加枠', () => {
  it('契約枠を超える追加は1枠を日割りで請求する', () => {
    expect(musuboLinkedAdditionPrice({ before: { googleBusiness: 2, instagram: 2 },
      service: 'googleBusiness', slotUnitYen: 3_300,
      billing: { kind: 'paid', monthlyDaysRemaining: 15, monthlyDaysInPeriod: 30 } })).toEqual({
      before: { googleBusiness: 2, instagram: 2 }, after: { googleBusiness: 3, instagram: 2 },
      slotsBefore: 2, slotsAfter: 3, addedSlots: 1, monthlyIncreaseYen: 3_300,
      monthlySlotsAfterYen: 9_900, dueNowYen: 1_650,
    });
  });

  it('契約枠の中の追加は増額も今すぐの請求もしない', () => {
    const result = musuboLinkedAdditionPrice({
      before: { googleBusiness: 1, instagram: 1, contracted: { googleBusiness: 2, instagram: 1 } },
      service: 'googleBusiness', slotUnitYen: 3_300,
      billing: { kind: 'paid', monthlyDaysRemaining: 15, monthlyDaysInPeriod: 30 } });
    expect(result).toMatchObject({
      after: { googleBusiness: 2, instagram: 1, contracted: { googleBusiness: 2, instagram: 1 } },
      slotsBefore: 0, slotsAfter: 0, addedSlots: 0, monthlyIncreaseYen: 0, dueNowYen: 0 });
  });

  it('契約枠を使い切った次の1個から、そのサービスだけ課金する', () => {
    const result = musuboLinkedAdditionPrice({
      before: { googleBusiness: 2, instagram: 1, contracted: { googleBusiness: 2, instagram: 1 } },
      service: 'googleBusiness', slotUnitYen: 3_300,
      billing: { kind: 'paid', monthlyDaysRemaining: 15, monthlyDaysInPeriod: 30 } });
    expect(result).toMatchObject({ slotsBefore: 0, slotsAfter: 1, addedSlots: 1,
      monthlyIncreaseYen: 3_300, monthlySlotsAfterYen: 3_300, dueNowYen: 1_650 });
  });

  it('無料期間中は連携枠が増えても今すぐの請求は0円にする', () => {
    expect(musuboLinkedAdditionPrice({ before: { googleBusiness: 1, instagram: 1 },
      service: 'instagram', slotUnitYen: 3_300, billing: { kind: 'trialing' } }))
      .toMatchObject({ addedSlots: 1, monthlyIncreaseYen: 3_300, dueNowYen: 0 });
  });

  it('11個目は個別見積もりへ送り、不正な単価や件数を拒否する', () => {
    const input = { before: { googleBusiness: 10, instagram: 1 }, service: 'googleBusiness' as const,
      slotUnitYen: 3_300, billing: { kind: 'paid' as const, monthlyDaysRemaining: 15, monthlyDaysInPeriod: 30 } };
    expect(() => musuboLinkedAdditionPrice(input)).toThrow(/individual quote/);
    expect(() => musuboLinkedAdditionPrice({ ...input, before: { googleBusiness: 1, instagram: 1 }, slotUnitYen: -1 })).toThrow();
    expect(() => musuboLinkedAdditionPrice({ ...input, before: { googleBusiness: 1.5, instagram: 1 } })).toThrow();
  });
});
