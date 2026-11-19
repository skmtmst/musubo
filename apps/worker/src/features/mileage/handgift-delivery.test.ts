import { describe, expect, it } from 'vitest';
import { createTestD1 } from '../../test-utils/d1-sqlite.js';
import { refundMileageRewardRedemption } from '@line-crm/db';
import { deliverHandgift } from './handgift-delivery.js';
import { deliverMileageReward } from './mileage-reward-delivery.js';

function fixture() {
  const d = createTestD1();
  d.raw.exec(`INSERT INTO mileage_rewards(id,line_account_id,name,reward_kind) VALUES('gift','a','景品','tag'),('other','a','通常','tag');
    INSERT INTO mileage_reward_versions(id,reward_id,version_number,required_miles,status) VALUES('v','gift',1,10,'published'),('v2','other',1,10,'published');
    INSERT INTO mileage_redemptions(id,line_account_id,program_id,beneficiary_key,reward_id,reward_version_id,spend_ledger_entry_id,idempotency_key,request_fingerprint) VALUES
      ('r','a','default','friend:x','gift','v','ledger','key','fingerprint'),
      ('other-r','a','default','friend:x','other','v2','ledger2','key2','fingerprint2');
    INSERT INTO mileage_handgift_rewards(reward_id) VALUES('gift');`);
  return d;
}

describe('手渡し景品', () => {
  it('自動配送は手渡し待ちにし、配送済みにしない', async () => {
    const d = fixture();
    try {
      const result = await deliverMileageReward(d.db, 'r', {});
      expect(result.status).toBe('pending');
      expect(result.message).toContain('店舗でのお渡し');
      expect(d.raw.prepare("SELECT status, delivered_at FROM mileage_redemptions WHERE id='r'").get()).toEqual({ status: 'reserved', delivered_at: null });
    } finally { d.raw.close(); }
  });
  it('返却済みの交換は手渡しを記録しない', async () => {
    const d = fixture();
    try {
      d.raw.prepare("UPDATE mileage_redemptions SET status='refunded' WHERE id='r'").run();
      expect(await deliverHandgift(d.db, { accountId: 'a', redemptionId: 'r', actorId: 'staff' })).toBe(false);
      expect(d.raw.prepare("SELECT count(*) AS n FROM mileage_handgifts WHERE redemption_id='r'").get()).toEqual({ n: 0 });
      expect((await deliverMileageReward(d.db, 'r', {})).message).toBe('交換は取り消されています。');
    } finally { d.raw.close(); }
  });
  it('同時に渡しても1回だけ記録し、別アカウントと普通の景品は拒否する', async () => {
    const d = fixture();
    try {
      expect(await deliverHandgift(d.db, { accountId: 'b', redemptionId: 'r', actorId: 'staff' })).toBe(false);
      expect(await deliverHandgift(d.db, { accountId: 'a', redemptionId: 'other-r', actorId: 'staff' })).toBe(false);
      const results = await Promise.all(['one', 'two'].map(actorId => deliverHandgift(d.db, { accountId: 'a', redemptionId: 'r', actorId })));
      expect(results.sort()).toEqual([false, true]);
      expect(d.raw.prepare("SELECT count(*) AS n FROM mileage_handgifts WHERE redemption_id='r'").get()).toEqual({ n: 1 });
      expect(d.raw.prepare("SELECT status FROM mileage_redemptions WHERE id='r'").get()).toEqual({ status: 'succeeded' });
      await expect(refundMileageRewardRedemption(d.db, { redemptionId: 'r', reason: '誤操作' })).rejects.toMatchObject({ code: 'already_delivered' });
      expect((await deliverMileageReward(d.db, 'r', {})).status).toBe('succeeded');
    } finally { d.raw.close(); }
  });
});
