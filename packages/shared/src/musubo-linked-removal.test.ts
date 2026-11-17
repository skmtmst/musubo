import { describe, expect, it } from 'vitest';
import { musuboLinkedRemovalPrice } from './musubo-linked-removal.js';

describe('Googleマイビジネス・Instagramの連携解除', () => {
  it('枠を超えている接続を解除すると月額を次回請求から減らし、即時返金しない', () => {
    expect(musuboLinkedRemovalPrice({ before: { googleBusiness: 3, instagram: 2 },
      service: 'googleBusiness', slotUnitYen: 3_300 })).toEqual({
      before: { googleBusiness: 3, instagram: 2 }, after: { googleBusiness: 2, instagram: 2 },
      slotsBefore: 3, slotsAfter: 2, removedSlots: 1,
      monthlyDecreaseYen: 3_300, monthlySlotsAfterYen: 6_600, refundNowYen: 0,
    });
  });

  it('契約枠の中の接続を解除しても契約枠は変わらず減額しない', () => {
    expect(musuboLinkedRemovalPrice({
      before: { googleBusiness: 2, instagram: 1, contracted: { googleBusiness: 2, instagram: 1 } },
      service: 'googleBusiness', slotUnitYen: 3_300 })).toMatchObject({
      after: { googleBusiness: 1, instagram: 1, contracted: { googleBusiness: 2, instagram: 1 } },
      slotsBefore: 0, slotsAfter: 0, removedSlots: 0, monthlyDecreaseYen: 0, refundNowYen: 0,
    });
  });

  it('もう一方のサービスの枠超過は解除の影響を受けない', () => {
    expect(musuboLinkedRemovalPrice({ before: { googleBusiness: 3, instagram: 2 },
      service: 'instagram', slotUnitYen: 3_300 })).toMatchObject({
      after: { googleBusiness: 3, instagram: 1 }, slotsBefore: 3, slotsAfter: 2,
      removedSlots: 1, monthlyDecreaseYen: 3_300, monthlySlotsAfterYen: 6_600, refundNowYen: 0,
    });
  });

  it('0個を解除できず、11個以上は個別見積もりの確認へ送る', () => {
    expect(() => musuboLinkedRemovalPrice({ before: { googleBusiness: 0, instagram: 1 },
      service: 'googleBusiness', slotUnitYen: 3_300 })).toThrow(/no linked account/);
    expect(() => musuboLinkedRemovalPrice({ before: { googleBusiness: 11, instagram: 1 },
      service: 'googleBusiness', slotUnitYen: 3_300 })).toThrow(/individual quote/);
  });
});
