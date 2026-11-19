import { expect, it } from 'vitest';
import { createMileageRewardDraft, getMileageReward, publishMileageReward, reserveMileageRewardRedemption, updateMileageRewardDraft } from '@line-crm/db';
import { createTestD1 } from '../../test-utils/d1-sqlite.js';
import { deliverMileageReward } from './mileage-reward-delivery.js';

it('手渡し景品を作って公開し、交換すると自動で渡さず待つ', async () => {
  const d = createTestD1();
  try {
    d.raw.exec(`INSERT OR IGNORE INTO mileage_programs(id,code,name,created_at,updated_at) VALUES('default','default','マイル','x','x');
      INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token) VALUES('a','店','c','s','t');
      INSERT INTO friends(id,line_user_id,line_account_id) VALUES('f','U','a');
      INSERT INTO mileage_ledger(id,program_id,beneficiary_friend_id,entry_type,status,amount,reason,source,idempotency_key,occurred_at,created_at)
      VALUES('grant','default','f','grant','available',100,'付与','test','grant-key','2026-01-01','2026-01-01');`);
    await expect(createMileageRewardDraft(d.db, { lineAccountId: 'a', draft: { name: '景品', rewardKind: 'handgift', requiredMiles: 30, commonActionVersionId: 'action' } })).rejects.toMatchObject({ code: 'invalid_action' });
    const draft = await createMileageRewardDraft(d.db, { lineAccountId: 'a', draft: { name: '景品', rewardKind: 'handgift', requiredMiles: 30 } });
    expect(draft.rewardKind).toBe('handgift');
    expect((await getMileageReward(d.db, { id: draft.id, lineAccountId: 'a' }))?.rewardKind).toBe('handgift');
    await expect(updateMileageRewardDraft(d.db, { id: draft.id, lineAccountId: 'a', expectedVersionId: draft.currentDraftVersionId!, draft: { name: '変更', rewardKind: 'coupon', requiredMiles: 30 } })).rejects.toMatchObject({ code: 'invalid_kind_change' });
    await publishMileageReward(d.db, { id: draft.id, lineAccountId: 'a' });
    const { redemption } = await reserveMileageRewardRedemption(d.db, { lineAccountId: 'a', friendId: 'f', rewardId: draft.id, idempotencyKey: 'request', requestFingerprint: 'fp' });
    expect((await deliverMileageReward(d.db, redemption.id, {})).message).toContain('店舗でのお渡し');
    expect(d.raw.prepare('SELECT status FROM mileage_redemptions WHERE id=?').get(redemption.id)).toEqual({ status: 'reserved' });
  } finally { d.raw.close(); }
});
