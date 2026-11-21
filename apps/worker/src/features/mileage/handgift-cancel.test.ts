import { describe, expect, it } from 'vitest';
import { reserveMileageRewardRedemption } from '@line-crm/db';
import { createTestD1 } from '../../test-utils/d1-sqlite.js';
import { deliverHandgift } from './handgift-delivery.js';
import { cancelHandgift } from './handgift-cancel.js';

async function fixture() {
  const d = createTestD1();
  d.raw.exec(`INSERT OR IGNORE INTO mileage_programs(id,code,name,created_at,updated_at) VALUES('default','default','マイル','x','x');
    INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token) VALUES('a','店','channel','s','t');
    INSERT INTO friends(id,line_user_id,line_account_id) VALUES('friend','U','a');
    INSERT INTO mileage_ledger(id,program_id,beneficiary_friend_id,entry_type,status,amount,reason,source,idempotency_key,occurred_at,created_at)
      VALUES('grant','default','friend','grant','available',100,'付与','test','grant-key','2026-01-01','2026-01-01');
    INSERT INTO mileage_rewards(id,line_account_id,name,reward_kind,status,current_published_version_id) VALUES('gift','a','景品','tag','published','v');
    INSERT INTO mileage_reward_versions(id,reward_id,version_number,required_miles,status) VALUES('v','gift',1,30,'published');
    INSERT INTO mileage_handgift_rewards(reward_id) VALUES('gift');`);
  const { redemption } = await reserveMileageRewardRedemption(d.db, { lineAccountId: 'a', friendId: 'friend', rewardId: 'gift', idempotencyKey: 'key', requestFingerprint: 'fp' });
  const input = { accountId: 'a', redemptionId: redemption.id, actorId: 'staff', reason: '誤りの訂正', expectedStatus: 'reserved' as const };
  return { d, input };
}
function balance(d: ReturnType<typeof createTestD1>) {
  return (d.raw.prepare("SELECT available FROM mileage_wallets WHERE beneficiary_key='friend:friend'").get() as {available: number}).available;
}

describe('手渡し景品の取消', () => {
  it('渡す前に取り消してマイルを一度だけ返す', async () => {
    const { d, input } = await fixture();
    try {
      expect(balance(d)).toBe(70);
      expect(await cancelHandgift(d.db, input)).toBe('completed');
      expect(balance(d)).toBe(100);
      expect(await cancelHandgift(d.db, input)).toBe('completed');
      expect(balance(d)).toBe(100);
      expect(await deliverHandgift(d.db, input)).toBe(false);
    } finally { d.raw.close(); }
  });
  it('古い手渡し前の状態では取り消せず、訂正後も両方の記録を残す', async () => {
    const { d, input } = await fixture();
    try {
      expect(await deliverHandgift(d.db, input)).toBe(true);
      expect(await cancelHandgift(d.db, input)).toBe('conflict');
      expect(await cancelHandgift(d.db, { ...input, expectedStatus: 'succeeded' })).toBe('completed');
      expect(balance(d)).toBe(100);
      expect(d.raw.prepare('SELECT delivered_at, cancelled_at, cancellation_reason FROM mileage_handgifts WHERE redemption_id=?').get(input.redemptionId)).toEqual({ delivered_at: expect.any(String), cancelled_at: expect.any(String), cancellation_reason: input.reason });
    } finally { d.raw.close(); }
  });
  it('同時に取消しても返却は1回で、引渡しとの競合でも記録が矛盾しない', async () => {
    const { d, input } = await fixture();
    try {
      const result = await Promise.all([cancelHandgift(d.db, input), cancelHandgift(d.db, { ...input, actorId: 'other' })]);
      expect(result).toEqual(['completed', 'completed']);
      expect(balance(d)).toBe(100);
      expect((d.raw.prepare("SELECT COUNT(*) AS n FROM mileage_ledger WHERE source='mileage_reward_refund'").get() as { n: number }).n).toBe(1);
    } finally { d.raw.close(); }
  });
  it('手渡しと取消が同時でも、取消結果とマイルが一致する', async () => {
    const { d, input } = await fixture();
    try {
      const [delivered, cancelled] = await Promise.all([
        deliverHandgift(d.db, input), cancelHandgift(d.db, input),
      ]);
      expect(Number(delivered) + Number(cancelled === 'completed')).toBe(1);
      expect(balance(d)).toBe(cancelled === 'completed' ? 100 : 70);
      const row = d.raw.prepare('SELECT delivered_at,cancelled_at FROM mileage_handgifts WHERE redemption_id=?').get(input.redemptionId) as { delivered_at: string | null; cancelled_at: string | null };
      expect(Boolean(row.delivered_at)).toBe(delivered);
      expect(Boolean(row.cancelled_at)).toBe(cancelled === 'completed');
    } finally { d.raw.close(); }
  });

  it('返却が途中で失敗しても再送で1回だけ戻す', async () => {
    const { d, input } = await fixture();
    try {
      let calls = 0;
      const db = Object.create(d.db) as D1Database;
      db.batch = async (statements) => {
        calls += 1;
        if (calls === 2) throw new Error('一時的な失敗');
        return d.db.batch(statements);
      };
      expect(await cancelHandgift(db, input)).toBe('pending');
      expect(balance(d)).toBe(70);
      expect(await cancelHandgift(db, input)).toBe('completed');
      expect(balance(d)).toBe(100);
    } finally { d.raw.close(); }
  });

});
