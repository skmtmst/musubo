import { describe, expect, it } from 'vitest';
import { DEFAULT_TENANT_ID } from '@line-crm/shared';
import { createTestD1, insertFriend } from '../../test-utils/d1-sqlite.js';
import { decideIdentityCandidate, getIdentityCandidate } from '../identity/identity-candidates.js';
import { detectFriendDuplicateCandidates } from './friend-duplicate-candidates.js';

const SHARED_PROFILE =
  'https://profile.line-scdn.net/0hSHARED_PROFILE_TOKEN_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789/preview';

function seed() {
  const testDb = createTestD1();
  for (const [id, name] of [['account-a', '本店'], ['account-b', '支店'], ['account-c', '別店']]) {
    testDb.raw.prepare(`
      INSERT INTO line_accounts (
        id, channel_id, name, channel_access_token, channel_secret, tenant_id
      ) VALUES (?, ?, ?, 'token', 'secret', ?)
    `).run(id, `channel-${id}`, name, DEFAULT_TENANT_ID);
  }
  insertFriend(testDb.raw, 'friend-a', {
    line_account_id: 'account-a', display_name: '見本 171', picture_url: SHARED_PROFILE,
  });
  insertFriend(testDb.raw, 'friend-b', {
    line_account_id: 'account-b', display_name: '見本 161', picture_url: SHARED_PROFILE,
  });
  insertFriend(testDb.raw, 'friend-c', {
    line_account_id: 'account-c', display_name: '見本 141',
    picture_url: 'https://profile.line-scdn.net/0hDIFFERENT_PROFILE_TOKEN_ABCDEFGHIJKLMNOPQRSTUVWXYZ_012345/preview',
  });
  return testDb;
}

describe('friend duplicate candidate detector', () => {
  it('moves a profile-image match into the review ledger as weak evidence only', async () => {
    const { db, raw } = seed();
    const result = await detectFriendDuplicateCandidates(db, {
      tenantId: DEFAULT_TENANT_ID,
      allowedAccountIds: ['account-a', 'account-b', 'account-c'],
      detectedAt: '2026-09-01T00:00:00.000Z',
    });

    expect(result).toEqual({ processed: 1, hasMore: false, nextCursor: null });
    const row = raw.prepare('SELECT id FROM identity_candidates').get() as { id: string };
    const candidate = await getIdentityCandidate(db, DEFAULT_TENANT_ID, row.id);
    expect(candidate).toMatchObject({
      kind: 'friend_duplicate',
      status: 'pending',
      confidence: { score: 30, label: 'low' },
      evidence: [{
        key: 'similar_profile_image', strength: 'weak', verified: false, valuePreview: null,
      }],
    });
    expect([candidate.left.lineAccountName, candidate.right.lineAccountName].sort())
      .toEqual(['支店', '本店']);
    expect(JSON.stringify(candidate)).not.toContain('line-scdn.net');
    expect(JSON.stringify(candidate)).not.toContain('SHARED_PROFILE_TOKEN');
    expect(raw.prepare('SELECT COUNT(*) AS count FROM friend_identity_links').get())
      .toEqual({ count: 0 });
  });

  it('does not return a rejected pair to pending when the same weak evidence is detected again', async () => {
    const { db, raw } = seed();
    await detectFriendDuplicateCandidates(db, {
      tenantId: DEFAULT_TENANT_ID,
      allowedAccountIds: ['account-a', 'account-b'],
      detectedAt: '2026-09-01T00:00:00.000Z',
    });
    const row = raw.prepare('SELECT id FROM identity_candidates').get() as { id: string };
    await decideIdentityCandidate(
      db,
      { id: 'owner-a', name: '担当者', tenantId: DEFAULT_TENANT_ID },
      row.id,
      { expectedVersion: 1, decision: 'different', reason: '本人へ確認し、別人でした' },
    );

    await detectFriendDuplicateCandidates(db, {
      tenantId: DEFAULT_TENANT_ID,
      allowedAccountIds: ['account-a', 'account-b'],
      detectedAt: '2026-09-01T01:00:00.000Z',
    });

    const candidate = await getIdentityCandidate(db, DEFAULT_TENANT_ID, row.id);
    expect(candidate).toMatchObject({ status: 'different', version: 2 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM identity_candidates').get())
      .toEqual({ count: 1 });
  });

  it('limits each run and returns a cursor without creating same-account pairs', async () => {
    const { db, raw } = seed();
    insertFriend(raw, 'friend-d', {
      line_account_id: 'account-a', display_name: '同じ店舗の別レコード', picture_url: SHARED_PROFILE,
    });

    const first = await detectFriendDuplicateCandidates(db, {
      tenantId: DEFAULT_TENANT_ID,
      allowedAccountIds: ['account-a', 'account-b'],
      limit: 1,
      detectedAt: '2026-09-01T00:00:00.000Z',
    });
    expect(first).toMatchObject({ processed: 1, hasMore: true });
    expect(first.nextCursor).not.toBeNull();

    const second = await detectFriendDuplicateCandidates(db, {
      tenantId: DEFAULT_TENANT_ID,
      allowedAccountIds: ['account-a', 'account-b'],
      limit: 1,
      after: first.nextCursor,
      detectedAt: '2026-09-01T00:00:00.000Z',
    });
    expect(second).toEqual({ processed: 1, hasMore: false, nextCursor: null });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM identity_candidates').get())
      .toEqual({ count: 2 });
  });

  it('does not scan accounts outside the visible scope', async () => {
    const { db, raw } = seed();
    const result = await detectFriendDuplicateCandidates(db, {
      tenantId: DEFAULT_TENANT_ID,
      allowedAccountIds: ['account-a'],
    });
    expect(result).toEqual({ processed: 0, hasMore: false, nextCursor: null });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM identity_candidates').get())
      .toEqual({ count: 0 });
  });

  it('rejects a broken cursor instead of silently starting over', async () => {
    const { db } = seed();
    await expect(detectFriendDuplicateCandidates(db, {
      tenantId: DEFAULT_TENANT_ID,
      allowedAccountIds: ['account-a', 'account-b'],
      after: '%E0%A4%A',
    })).rejects.toMatchObject({ status: 422, code: 'INVALID_DETECTION_CURSOR' });
  });
});
