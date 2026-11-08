import { describe, expect, it } from 'vitest';
import { musuboLinkedRemovalPrice } from './musubo-linked-removal.js';

describe('Googleマイビジネス・Instagramの連携解除', () => {
  it('多いほうが3個から2個に減ると月額を次回請求から減らし、即時返金しない', () => {
    expect(musuboLinkedRemovalPrice({ before: { googleBusiness: 3, instagram: 2 },
      service: 'googleBusiness', slotUnitYen: 3_300 })).toEqual({
      before: { googleBusiness: 3, instagram: 2 }, after: { googleBusiness: 2, instagram: 2 },
      slotsBefore: 2, slotsAfter: 1, removedSlots: 1,
      monthlyDecreaseYen: 3_300, monthlySlotsAfterYen: 3_300, refundNowYen: 0,
    });
  });

  it('少ないほうを解除しても追加枠料金を変えない', () => {
    expect(musuboLinkedRemovalPrice({ before: { googleBusiness: 3, instagram: 2 },
      service: 'instagram', slotUnitYen: 3_300 })).toMatchObject({
      after: { googleBusiness: 3, instagram: 1 }, slotsBefore: 2, slotsAfter: 2,
      removedSlots: 0, monthlyDecreaseYen: 0, refundNowYen: 0,
    });
  });

  it('0個を解除できず、11個以上は個別見積もりの確認へ送る', () => {
    expect(() => musuboLinkedRemovalPrice({ before: { googleBusiness: 0, instagram: 1 },
      service: 'googleBusiness', slotUnitYen: 3_300 })).toThrow(/no linked account/);
    expect(() => musuboLinkedRemovalPrice({ before: { googleBusiness: 11, instagram: 1 },
      service: 'googleBusiness', slotUnitYen: 3_300 })).toThrow(/individual quote/);
  });
});
