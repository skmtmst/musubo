import { describe, expect, it } from 'vitest';
import { DEFAULT_TENANT_ID } from '@line-crm/shared';
import {
  createMileageRewardDraft,
  getMileageRewardRedemptionCounts,
  importMileageRewardCodes,
  publishMileageReward,
  refundMileageRewardRedemption,
  reserveMileageRewardRedemption,
} from '@line-crm/db';
import { createTestD1, insertFriend, type SqliteD1 } from '../../test-utils/d1-sqlite.js';
import {
  decideIdentityCandidate,
  undoIdentityCandidate,
  upsertIdentityCandidate,
  type IdentityCandidateDraft,
} from '../identity/identity-candidates.js';

/*
 * 同じ友だちの交換履歴は統合・取消・解除・UID 移行をまたいで数え、一人一回を守る。
 * 別の本人と返却済みは別扱いとする。誤統合の訂正後も統合前の友だちキーの履歴を保持し、実 SQLite と実サービスで検証する。
 */

const actor = { id: 'owner-1', name: '担当者', tenantId: DEFAULT_TENANT_ID };

function grant(raw: SqliteD1['raw'], id: string, friendId: string | null, userId: string | null, amount: number): void {
  raw.prepare(`
    INSERT INTO mileage_ledger
      (id, program_id, beneficiary_user_id, beneficiary_friend_id, entry_type, status,
       amount, reason, source, source_event_id, idempotency_key, metadata, occurred_at, created_at)
    VALUES (?, 'default', ?, ?, 'grant', 'available', ?, '試験の付与', 'test', ?, ?, '{}',
      '2026-08-30T09:00:00.000Z', '2026-08-30T09:00:00.000Z')
  `).run(id, userId, friendId, amount, `event-${id}`, `grant-${id}`);
}

async function seedReward(db: D1Database, name: string): Promise<string> {
  const draft = await createMileageRewardDraft(db, {
    lineAccountId: 'account-1',
    draft: { name, rewardKind: 'coupon', requiredMiles: 60, perFriendLimit: 1 },
  });
  await importMileageRewardCodes(db, {
    rewardId: draft.id,
    lineAccountId: 'account-1',
    codes: [
      { ciphertext: 'code-1', fingerprint: 'fp-1' },
      { ciphertext: 'code-2', fingerprint: 'fp-2' },
    ],
  });
  return (await publishMileageReward(db, { id: draft.id, lineAccountId: 'account-1' })).id;
}

function seedFriends(testDb: SqliteD1): void {
  const { raw } = testDb;
  raw.prepare(`
    INSERT INTO line_accounts (
      id, channel_id, name, channel_access_token, channel_secret, tenant_id
    ) VALUES ('account-1', 'channel-1', '本店', 'token', 'secret', ?)
  `).run(DEFAULT_TENANT_ID);
  insertFriend(raw, 'friend-bf', {
    line_account_id: 'account-1', line_user_id: 'UBF', display_name: '本人B', user_id: null,
  });
  insertFriend(raw, 'friend-fb', {
    line_account_id: 'account-1', line_user_id: 'UFB', display_name: '本人B', user_id: null,
  });
  insertFriend(raw, 'friend-other', {
    line_account_id: 'account-1', line_user_id: 'UOT', display_name: '別の人', user_id: null,
  });
}

function mergeDraft(id: string): IdentityCandidateDraft {
  const subject = (friendId: string, label: string) => ({
    kind: 'friend' as const, id: friendId, label, detail: '本店',
    lineAccountId: 'account-1', lineAccountName: '本店', shopKey: null,
    attributes: [{ label: 'メール', valuePreview: 'ta***@example.com', verified: true }],
  });
  return {
    id,
    tenantId: DEFAULT_TENANT_ID,
    kind: 'friend_duplicate',
    confidenceScore: 92,
    detectorVersion: 'friends-v1',
    left: subject('friend-bf', '本人B'),
    right: subject('friend-fb', '本人B'),
    evidence: [{
      key: 'verified_email', label: '確認済みのメールアドレスが同じ',
      strength: 'strong' as const, verified: true, valuePreview: 'ta***@example.com',
    }],
    impact: [],
    detectedAt: '2026-08-30T10:00:00.000Z',
  };
}

describe('R388 一人一回は本人整理の前後で引き継ぐ', () => {
  it('統合後に同じ友だち・同じ特典の二度目は409になる', async () => {
    const testDb = createTestD1();
    seedFriends(testDb);
    const rewardId = await seedReward(testDb.db, '一人一回の特典');
    const redeem = (friendId: string, key: string) =>
      reserveMileageRewardRedemption(testDb.db, {
        lineAccountId: 'account-1', friendId, rewardId,
        idempotencyKey: key, requestFingerprint: key,
      });

    grant(testDb.raw, 'grant-1', 'friend-bf', null, 240);
    const first = await redeem('friend-bf', 'first');
    expect(first.kind).toBe('created');
    // 統合前の二度目は従来どおり409。
    await expect(redeem('friend-bf', 'second-before-merge'))
      .rejects.toMatchObject({ code: 'friend_limit_reached' });

    // 正式な候補判定で本人へ統合する。
    const candidateId = await upsertIdentityCandidate(testDb.db, mergeDraft('candidate-merge'));
    await decideIdentityCandidate(testDb.db, actor, candidateId, {
      expectedVersion: 1, decision: 'linked', reason: '本人確認が取れました',
    });
    grant(testDb.raw, 'grant-2', 'friend-bf', null, 240);

    // 統合後の二度目は409。別のコードを発行しない。
    await expect(redeem('friend-bf', 'second-after-merge'))
      .rejects.toMatchObject({ code: 'friend_limit_reached' });
    // 交換済みの表示も上限と一致する（「交換できる」と出さない）。
    const counts = await getMileageRewardRedemptionCounts(testDb.db, {
      lineAccountId: 'account-1', friendId: 'friend-bf',
    });
    expect(counts.byRewardId.get(rewardId)).toBe(1);
  });

  it('候補取消・解除の後も同じ友だちの使用は引き継ぐ', async () => {
    const testDb = createTestD1();
    seedFriends(testDb);
    const rewardId = await seedReward(testDb.db, '一人一回の特典');
    const redeem = (friendId: string, key: string) =>
      reserveMileageRewardRedemption(testDb.db, {
        lineAccountId: 'account-1', friendId, rewardId,
        idempotencyKey: key, requestFingerprint: key,
      });

    grant(testDb.raw, 'grant-1', 'friend-bf', null, 240);
    await redeem('friend-bf', 'first');
    const candidateId = await upsertIdentityCandidate(testDb.db, mergeDraft('candidate-merge'));
    await decideIdentityCandidate(testDb.db, actor, candidateId, {
      expectedVersion: 1, decision: 'linked', reason: '本人確認が取れました',
    });
    // 誤統合の訂正で取り消しても、統合前の友だちキーでの交換は残る。
    await undoIdentityCandidate(testDb.db, actor, candidateId, {
      expectedVersion: 2, reason: '誤りだったので取り消します',
    });
    grant(testDb.raw, 'grant-2', 'friend-bf', null, 240);
    await expect(redeem('friend-bf', 'after-undo'))
      .rejects.toMatchObject({ code: 'friend_limit_reached' });
  });

  it('異なる本人は別々に数え、返却済みは数えない', async () => {
    const testDb = createTestD1();
    seedFriends(testDb);
    const rewardId = await seedReward(testDb.db, '一人一回の特典');
    const redeem = (friendId: string, key: string) =>
      reserveMileageRewardRedemption(testDb.db, {
        lineAccountId: 'account-1', friendId, rewardId,
        idempotencyKey: key, requestFingerprint: key,
      });

    grant(testDb.raw, 'grant-1', 'friend-bf', null, 240);
    grant(testDb.raw, 'grant-2', 'friend-other', null, 240);
    const first = await redeem('friend-bf', 'first');
    expect(first.kind).toBe('created');
    // 別の人は交換できる。
    const other = await redeem('friend-other', 'other-first');
    expect(other.kind).toBe('created');
    // 返却した分は数えない。
    await refundMileageRewardRedemption(testDb.db, {
      redemptionId: first.redemption.id, reason: '試験の返却です',
    });
    const retry = await redeem('friend-bf', 'after-refund');
    expect(retry.kind).toBe('created');
  });
});
