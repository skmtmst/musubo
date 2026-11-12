import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TENANT_ID } from '@line-crm/shared';
import { linkFriendToUser } from '@line-crm/db';
import { createTestD1, insertFriend, type SqliteD1 } from '../../test-utils/d1-sqlite.js';
import {
  decideIdentityCandidate,
  IdentityCandidateError,
  undoIdentityCandidate,
} from './identity-candidates.js';
import {
  getMergedPerson,
  unlinkMergedPersonFriend,
  updateMergedPerson,
  updateMergedPersonDeliveryPriorities,
} from '../../services/merged-people.js';

/*
 * 本人統合・連携解除・候補競合を実 SQLite と実サービスで検証する。
 * D1 の往復の隙間を再現するため、読取と書込の間に別の操作を差し込む。
 */

const owner1 = { id: 'owner-1', name: '担当A', tenantId: DEFAULT_TENANT_ID };
const owner2 = { id: 'owner-2', name: '担当B', tenantId: DEFAULT_TENANT_ID };

function seed(): SqliteD1 {
  const testDb = createTestD1();
  const { raw } = testDb;
  raw.prepare(`
    INSERT OR IGNORE INTO tenants (id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(DEFAULT_TENANT_ID, '既定統括', '2026-08-30', '2026-08-30');
  for (const [id, name] of [['account-a', '本店'], ['account-b', '支店']]) {
    raw.prepare(`
      INSERT INTO line_accounts (
        id, channel_id, name, channel_access_token, channel_secret, tenant_id
      ) VALUES (?, ?, ?, 'token', 'secret', ?)
    `).run(id, `channel-${id}`, name, DEFAULT_TENANT_ID);
  }
  insertFriend(raw, 'friend-a', {
    line_account_id: 'account-a', display_name: '見本 171', user_id: 'user-a',
  });
  insertFriend(raw, 'friend-b', {
    line_account_id: 'account-b', display_name: '見本 161', user_id: 'user-a',
  });
  insertFriend(raw, 'friend-c', {
    line_account_id: 'account-a', display_name: '別の人', user_id: null,
  });
  /*
   * の被害形に寄せる: 本人は移行・判定で作られ、統括を持たない行になる。
   * 結び付きがある間は友だち経由で見え、0件になると見えなくなる。
   */
  raw.prepare(`
    INSERT INTO users (
      id, tenant_id, status, display_name, primary_display_name, revision,
      created_by, created_at, updated_at
    ) VALUES
      ('user-a', NULL, 'active', '見本 171', '見本 171', 1,
        'owner-1', '2026-08-30T09:00:00.000Z', '2026-08-30T09:00:00.000Z'),
      ('user-u2', NULL, 'active', '別の本人', '別の本人', 1,
        'owner-1', '2026-08-30T09:00:00.000Z', '2026-08-30T09:00:00.000Z')
  `).run();
  raw.prepare(`
    INSERT INTO identity_candidates (
      id, tenant_id, kind, status, version, confidence_score, detector_version,
      left_subject_kind, left_subject_id, left_line_account_id, left_snapshot_json,
      right_subject_kind, right_subject_id, right_line_account_id, right_snapshot_json,
      evidence_fingerprint, evidence_json, impact_json, detected_at, reviewed_at,
      created_at, updated_at
    ) VALUES ('candidate-a', ?, 'friend_duplicate', 'linked', 2, 92, 'v1',
      'friend', 'friend-a', 'account-a', '{}', 'friend', 'friend-b', 'account-b',
      '{}', 'fingerprint-a', '[]', '[]', '2026-08-30T09:00:00.000Z',
      '2026-08-30T09:10:00.000Z', '2026-08-30T09:00:00.000Z',
      '2026-08-30T09:10:00.000Z')
  `).run(DEFAULT_TENANT_ID);
  raw.prepare(`
    INSERT INTO identity_candidate_decisions (
      id, candidate_id, candidate_version, from_status, to_status, actor_name,
      reason, evidence_fingerprint, impact_snapshot_json, decided_at
    ) VALUES ('decision-a', 'candidate-a', 2, 'pending', 'linked', '担当者',
      '本人へ確認済みです', 'fingerprint-a', '[]', '2026-08-30T09:10:00.000Z')
  `).run();
  for (const [id, friendId] of [['link-a', 'friend-a'], ['link-b', 'friend-b']]) {
    raw.prepare(`
      INSERT INTO friend_identity_links (
        id, tenant_id, candidate_id, user_id, friend_id, link_method,
        evidence_snapshot_json, confidence_score, linked_by, linked_at
      ) VALUES (?, ?, 'candidate-a', 'user-a', ?, 'operator_review', '[]', 92,
        'owner-1', '2026-08-30T09:10:00.000Z')
    `).run(id, DEFAULT_TENANT_ID, friendId);
  }
  raw.prepare(`
    INSERT INTO user_profile_values (
      id, tenant_id, user_id, field_key, field_label, value_json, value_preview,
      source_type, source_id, source_label, source_friend_id, verified_at,
      selected_by, selected_by_name, selected_at, update_mode, is_active,
      created_at, updated_at
    ) VALUES
      ('profile-a', ?, 'user-a', 'email', 'メール', '"tanaka@example.com"',
        'ta***@example.com', 'form', 'form-a', '来店アンケート', 'friend-a',
        '2026-08-29T12:00:00.000Z', 'owner-1', '担当者',
        '2026-08-30T09:20:00.000Z', 'fixed', 1,
        '2026-08-30T09:20:00.000Z', '2026-08-30T09:20:00.000Z'),
      ('profile-b', ?, 'user-a', 'real_name', '本名', '"田中はなこ"',
        '田中はなこ', 'friend', 'friend-b', '支店の表示名', 'friend-b',
        '2026-08-29T12:00:00.000Z', 'owner-1', '担当者',
        '2026-08-30T09:20:00.000Z', 'fixed', 1,
        '2026-08-30T09:20:00.000Z', '2026-08-30T09:20:00.000Z')
  `).run(DEFAULT_TENANT_ID, DEFAULT_TENANT_ID);
  raw.prepare(`
    INSERT INTO user_delivery_priorities (
      id, tenant_id, user_id, purpose, friend_id, priority, is_active,
      reason, selected_by, selected_at, created_at, updated_at
    ) VALUES
      ('priority-a', ?, 'user-a', 'broadcast', 'friend-a', 1, 1,
        '本店を優先します', 'owner-1', '2026-08-30T09:30:00.000Z',
        '2026-08-30T09:30:00.000Z', '2026-08-30T09:30:00.000Z'),
      ('priority-b', ?, 'user-a', 'broadcast', 'friend-b', 2, 1,
        '支店を次にします', 'owner-1', '2026-08-30T09:30:00.000Z',
        '2026-08-30T09:30:00.000Z', '2026-08-30T09:30:00.000Z')
  `).run(DEFAULT_TENANT_ID, DEFAULT_TENANT_ID);
  return testDb;
}

function friendUserId(raw: Database.Database, id: string): string | null {
  return (raw.prepare('SELECT user_id FROM friends WHERE id = ?').get(id) as { user_id: string | null }).user_id ?? null;
}

function userRevision(raw: Database.Database, id: string): number {
  return Number((raw.prepare('SELECT revision FROM users WHERE id = ?').get(id) as { revision: number }).revision);
}

function unlinkEventCount(raw: Database.Database, actorId: string): number {
  return Number((raw.prepare(
    `SELECT COUNT(*) AS count FROM identity_events WHERE event_type = 'unlink' AND actor_staff_id = ?`,
  ).get(actorId) as { count: number }).count);
}

/*
 * 最初の batch 呼び出しの直前に勝者の操作を差し込む。敗者の読み取りと
 * 書込みの間に版が進む競合（実D1の往復の隙間）を再現する。
 */
function raceBeforeFirstBatch(db: D1Database, hook: () => Promise<void>): D1Database {
  let armed = true;
  const batch = async (statements: D1PreparedStatement[]) => {
    if (armed) {
      armed = false;
      await hook();
    }
    return db.batch(statements);
  };
  return { ...db, batch } as unknown as D1Database;
}

describe('R389 同時解除は409側に何も残さない', () => {
  it('勝者が先に解除したら敗者は409で友だち・結び付き・履歴が変わらない', async () => {
    const testDb = seed();
    const loserDb = raceBeforeFirstBatch(testDb.db, async () => {
      await unlinkMergedPersonFriend(testDb.db, owner2, 'user-a', 'friend-b', {
        expectedRevision: 1, reason: '勝者が先に解除します',
      });
    });
    await expect(unlinkMergedPersonFriend(loserDb, owner1, 'user-a', 'friend-a', {
      expectedRevision: 1, reason: '敗者が遅れて解除します',
    })).rejects.toMatchObject({ status: 409, code: 'STALE_PERSON' });
    // 敗者の操作は何も残らない。
    expect(friendUserId(testDb.raw, 'friend-a')).toBe('user-a');
    expect(Number((testDb.raw.prepare(
      `SELECT COUNT(*) AS count FROM friend_identity_links
        WHERE friend_id = 'friend-a' AND unlinked_at IS NULL`,
    ).get() as { count: number }).count)).toBe(1);
    expect(unlinkEventCount(testDb.raw, 'owner-1')).toBe(0);
    // 勝者の解除だけが残る。
    expect(friendUserId(testDb.raw, 'friend-b')).toBeNull();
    expect(unlinkEventCount(testDb.raw, 'owner-2')).toBe(1);
    expect(userRevision(testDb.raw, 'user-a')).toBe(2);
  });

  it('古い版の逐次解除も409で何も変えない', async () => {
    const testDb = seed();
    await unlinkMergedPersonFriend(testDb.db, owner2, 'user-a', 'friend-b', {
      expectedRevision: 1, reason: '勝者が先に解除します',
    });
    await expect(unlinkMergedPersonFriend(testDb.db, owner1, 'user-a', 'friend-a', {
      expectedRevision: 1, reason: '古い版で解除します',
    })).rejects.toMatchObject({ status: 409 });
    expect(friendUserId(testDb.raw, 'friend-a')).toBe('user-a');
    expect(unlinkEventCount(testDb.raw, 'owner-1')).toBe(0);
  });
});

describe('R390 解除した別店舗の設定は残さない', () => {
  it('解除と一緒に採用値の無効化・配信先の引退を行い履歴に残す', async () => {
    const testDb = seed();
    await unlinkMergedPersonFriend(testDb.db, owner1, 'user-a', 'friend-b', {
      expectedRevision: 1, reason: '支店の結び付きを解除します',
    });
    const detail = await getMergedPerson(testDb.db, DEFAULT_TENANT_ID, 'user-a');
    expect(detail.linkedFriends.map((friend) => friend.friendId)).toEqual(['friend-a']);
    expect(detail.profileValues.some((value) => value.sourceFriendId === 'friend-b')).toBe(false);
    expect(detail.deliveryPriorities.some((priority) => priority.friendId === 'friend-b')).toBe(false);
    // 解除前の採用値・配信先は行を残したまま無効化される。
    expect(Number((testDb.raw.prepare(
      `SELECT COUNT(*) AS count FROM user_profile_values
        WHERE source_friend_id = 'friend-b' AND is_active = 1`,
    ).get() as { count: number }).count)).toBe(0);
    expect(Number((testDb.raw.prepare(
      `SELECT COUNT(*) AS count FROM user_delivery_priorities
        WHERE friend_id = 'friend-b' AND retired_at IS NULL`,
    ).get() as { count: number }).count)).toBe(0);
    const event = testDb.raw.prepare(
      `SELECT after_json FROM identity_events WHERE event_type = 'unlink'`,
    ).get() as { after_json: string };
    expect(JSON.parse(event.after_json)).toMatchObject({
      friendId: 'friend-b', retiredPriorities: 1, deactivatedProfiles: 1,
    });
  });

  it('解除前に残った旧い行も詳細に返さない（読み側の二重防御）', async () => {
    const testDb = seed();
    await unlinkMergedPersonFriend(testDb.db, owner1, 'user-a', 'friend-b', {
      expectedRevision: 1, reason: '支店の結び付きを解除します',
    });
    // 解除より前の世代の行が残っていた想定で、直接有効な行を足す。
    testDb.raw.prepare(`
      INSERT INTO user_profile_values (
        id, tenant_id, user_id, field_key, field_label, value_json, value_preview,
        source_type, source_id, source_label, source_friend_id, verified_at,
        selected_by, selected_by_name, selected_at, update_mode, is_active,
        created_at, updated_at
      ) VALUES ('profile-stale', ?, 'user-a', 'nickname', '呼び名', '"はな"',
        'はな', 'friend', 'friend-b', '支店の表示名', 'friend-b', NULL,
        'owner-1', '担当者', '2026-08-30T09:20:00.000Z', 'fixed', 1,
        '2026-08-30T09:20:00.000Z', '2026-08-30T09:20:00.000Z')
    `).run(DEFAULT_TENANT_ID);
    testDb.raw.prepare(`
      INSERT INTO user_delivery_priorities (
        id, tenant_id, user_id, purpose, friend_id, priority, is_active,
        reason, selected_by, selected_at, created_at, updated_at
      ) VALUES ('priority-stale', ?, 'user-a', 'scenario', 'friend-b', 1, 1,
        '旧い理由です', 'owner-1', '2026-08-30T09:30:00.000Z',
        '2026-08-30T09:30:00.000Z', '2026-08-30T09:30:00.000Z')
    `).run(DEFAULT_TENANT_ID);
    const detail = await getMergedPerson(testDb.db, DEFAULT_TENANT_ID, 'user-a');
    expect(detail.profileValues.some((value) => value.sourceFriendId === 'friend-b')).toBe(false);
    expect(detail.deliveryPriorities.some((priority) => priority.friendId === 'friend-b')).toBe(false);
  });
});

describe('R391 最後の解除後も履歴は開ける', () => {
  it('結び付き0件でも解除履歴つきの詳細が返る', async () => {
    const testDb = seed();
    await unlinkMergedPersonFriend(testDb.db, owner1, 'user-a', 'friend-a', {
      expectedRevision: 1, reason: '本店の結び付きを解除します',
    });
    await unlinkMergedPersonFriend(testDb.db, owner1, 'user-a', 'friend-b', {
      expectedRevision: 2, reason: '支店の結び付きを解除します',
    });
    const detail = await getMergedPerson(testDb.db, DEFAULT_TENANT_ID, 'user-a');
    expect(detail.linkedFriends).toEqual([]);
    expect(detail.history.length).toBeGreaterThanOrEqual(2);
    expect(detail.history.some((item) => item.eventType === 'unlink')).toBe(true);
  });

  it('履歴のない本人は404のまま', async () => {
    const testDb = seed();
    // 統括に属さない・結び付きも履歴も無い本人は開けない。
    testDb.raw.prepare(`
      INSERT INTO users (id, tenant_id, status, display_name, revision, created_by, created_at, updated_at)
      VALUES ('user-ghost', NULL, 'active', '知らない本人', 1, 'owner-1',
        '2026-08-30T09:00:00.000Z', '2026-08-30T09:00:00.000Z')
    `).run();
    await expect(getMergedPerson(testDb.db, DEFAULT_TENANT_ID, 'user-ghost'))
      .rejects.toMatchObject({ status: 404 });
  });
});

describe('R392 取消が先なら古い保存は409になる', () => {
  it('取消で本人の版が進み、前に開いた保存は409で止まる', async () => {
    const testDb = seed();
    await undoIdentityCandidate(testDb.db, owner2, 'candidate-a', {
      expectedVersion: 2, reason: '誤りだったので取り消します',
    });
    expect(userRevision(testDb.raw, 'user-a')).toBe(2);
    await expect(updateMergedPerson(testDb.db, owner1, 'user-a', {
      expectedRevision: 1, primaryDisplayName: '古い画面の表示名',
    })).rejects.toMatchObject({ status: 409, code: 'STALE_PERSON' });
    await expect(updateMergedPersonDeliveryPriorities(testDb.db, owner1, 'user-a', {
      expectedRevision: 1,
      priorities: [{
        purpose: 'broadcast', friendId: 'friend-a', priority: 1,
        isActive: true, reason: '古い画面の理由です',
      }],
    })).rejects.toMatchObject({ status: 409, code: 'STALE_PERSON' });
  });

  it('保存が先なら取消時に関係設定を整理する', async () => {
    const testDb = seed();
    await updateMergedPersonDeliveryPriorities(testDb.db, owner1, 'user-a', {
      expectedRevision: 1,
      priorities: [{
        purpose: 'broadcast', friendId: 'friend-a', priority: 1,
        isActive: true, reason: '本店だけにします',
      }],
    });
    await undoIdentityCandidate(testDb.db, owner2, 'candidate-a', {
      expectedVersion: 2, reason: '誤りだったので取り消します',
    });
    // 外れた友だちの配信先・採用値は残さない。行は消さず無効化する。
    expect(friendUserId(testDb.raw, 'friend-a')).toBeNull();
    expect(Number((testDb.raw.prepare(
      `SELECT COUNT(*) AS count FROM user_delivery_priorities WHERE retired_at IS NULL`,
    ).get() as { count: number }).count)).toBe(0);
    expect(Number((testDb.raw.prepare(
      `SELECT COUNT(*) AS count FROM user_profile_values WHERE is_active = 1`,
    ).get() as { count: number }).count)).toBe(0);
  });
});

describe('R394 古い取消で新しい結び直しを消さない', () => {
  it('再連携の後は候補の取消自体が409になり結び直しが残る', async () => {
    const testDb = seed();
    expect(await linkFriendToUser(testDb.db, 'friend-a', 'user-u2', { id: 'owner-2' })).toBe(true);
    // 再連携で古い候補の結び付き行は外れる。
    expect(Number((testDb.raw.prepare(
      `SELECT COUNT(*) AS count FROM friend_identity_links
        WHERE candidate_id = 'candidate-a' AND friend_id = 'friend-a' AND unlinked_at IS NULL`,
    ).get() as { count: number }).count)).toBe(0);
    await expect(undoIdentityCandidate(testDb.db, owner1, 'candidate-a', {
      expectedVersion: 2, reason: '古い判定を取り消します',
    })).rejects.toMatchObject({ status: 409 });
    expect(friendUserId(testDb.raw, 'friend-a')).toBe('user-u2');
  });

  it('結び付き行が残る旧い移行経路でも取消は上書きしない', async () => {
    const testDb = seed();
    // 再連携相当の付け替えだけを行い、結び付き行はU1のまま残す（旧実装の状態）。
    testDb.raw.prepare(`UPDATE friends SET user_id = 'user-u2' WHERE id = 'friend-a'`).run();
    await expect(undoIdentityCandidate(testDb.db, owner1, 'candidate-a', {
      expectedVersion: 2, reason: '古い判定を取り消します',
    })).rejects.toMatchObject({ status: 409, code: 'IDENTITY_RELINKED' });
    expect(friendUserId(testDb.raw, 'friend-a')).toBe('user-u2');
    expect(Number((testDb.raw.prepare(
      `SELECT version AS version FROM identity_candidates WHERE id = 'candidate-a'`,
    ).get() as { version: number }).version)).toBe(2);
  });

  it('同時に動かした再連携は負けた側が409で何も変えない', async () => {
    const testDb = seed();
    const revisionBefore = userRevision(testDb.raw, 'user-a');
    // 読み取りと書込みの間に別の担当が付け替えた競合を再現する。
    const racyDb = raceBeforeFirstBatch(testDb.db, async () => {
      testDb.raw.prepare(`UPDATE friends SET user_id = NULL WHERE id = 'friend-a'`).run();
    });
    await expect(linkFriendToUser(racyDb, 'friend-a', 'user-u2')).resolves.toBe(false);
    expect(friendUserId(testDb.raw, 'friend-a')).toBeNull();
    expect(userRevision(testDb.raw, 'user-a')).toBe(revisionBefore);
    expect(userRevision(testDb.raw, 'user-u2')).toBe(1);
  });
});

describe('R397 同時判定・同時取消は409になる', () => {
  function seedPendingCandidate(raw: Database.Database): void {
    raw.prepare(`
      INSERT INTO identity_candidates (
        id, tenant_id, kind, status, version, confidence_score, detector_version,
        left_subject_kind, left_subject_id, left_line_account_id, left_snapshot_json,
        right_subject_kind, right_subject_id, right_line_account_id, right_snapshot_json,
        evidence_fingerprint, evidence_json, impact_json, detected_at,
        created_at, updated_at
      ) VALUES ('candidate-pending', ?, 'friend_duplicate', 'pending', 1, 80, 'v1',
        'friend', 'friend-a', 'account-a', '{}', 'friend', 'friend-c', 'account-a',
        '{}', 'fingerprint-pending', '[]', '[]', '2026-08-30T09:00:00.000Z',
        '2026-08-30T09:00:00.000Z', '2026-08-30T09:00:00.000Z')
    `).run(DEFAULT_TENANT_ID);
  }

  it('同じ版の同時判定は一方が409で二重結びにならない', async () => {
    const testDb = seed();
    seedPendingCandidate(testDb.raw);
    // 勝者が先に確定したのと同じ状態（一意制約に当たる記録だけ先に置く）。
    testDb.raw.prepare(`
      INSERT INTO identity_candidate_decisions (
        id, candidate_id, candidate_version, from_status, to_status, actor_name,
        reason, evidence_fingerprint, impact_snapshot_json, decided_at
      ) VALUES ('decision-winner', 'candidate-pending', 2, 'pending', 'linked',
        '担当B', '勝者が判定しました', 'fingerprint-pending', '[]',
        '2026-08-30T09:40:00.000Z')
    `).run();
    await expect(decideIdentityCandidate(testDb.db, owner1, 'candidate-pending', {
      expectedVersion: 1, decision: 'linked', reason: '敗者が判定します',
    })).rejects.toMatchObject({ status: 409 });
    // 敗者は何も書いていない。
    expect((testDb.raw.prepare(
      `SELECT status FROM identity_candidates WHERE id = 'candidate-pending'`,
    ).get() as { status: string }).status).toBe('pending');
    expect(friendUserId(testDb.raw, 'friend-c')).toBeNull();
    expect(Number((testDb.raw.prepare(
      `SELECT COUNT(*) AS count FROM friend_identity_links WHERE candidate_id = 'candidate-pending'`,
    ).get() as { count: number }).count)).toBe(0);
  });

  it('同じ版の同時取消は一方が409で結び付きが残る', async () => {
    const testDb = seed();
    testDb.raw.prepare(`
      INSERT INTO identity_candidate_decisions (
        id, candidate_id, candidate_version, from_status, to_status, actor_name,
        reason, evidence_fingerprint, impact_snapshot_json, decided_at
      ) VALUES ('decision-winner', 'candidate-a', 3, 'linked', 'invalidated',
        '担当B', '勝者が取り消しました', 'fingerprint-a', '[]',
        '2026-08-30T09:40:00.000Z')
    `).run();
    await expect(undoIdentityCandidate(testDb.db, owner1, 'candidate-a', {
      expectedVersion: 2, reason: '敗者が取り消します',
    })).rejects.toMatchObject({ status: 409 });
    expect((testDb.raw.prepare(
      `SELECT status FROM identity_candidates WHERE id = 'candidate-a'`,
    ).get() as { status: string }).status).toBe('linked');
    expect(friendUserId(testDb.raw, 'friend-a')).toBe('user-a');
  });

  it('逐次の古い版は従来どおり409', async () => {
    const testDb = seed();
    await undoIdentityCandidate(testDb.db, owner2, 'candidate-a', {
      expectedVersion: 2, reason: '勝者が取り消します',
    });
    await expect(undoIdentityCandidate(testDb.db, owner1, 'candidate-a', {
      expectedVersion: 2, reason: '古い版で取り消します',
    })).rejects.toMatchObject({ status: 409 });
  });
});

describe('R397 競合以外の障害は409に言い換えない', () => {
  it('結び付ける友だち自体が無いときは所属エラーのまま', async () => {
    const testDb = seed();
    testDb.raw.prepare(`
      INSERT INTO identity_candidates (
        id, tenant_id, kind, status, version, confidence_score, detector_version,
        left_subject_kind, left_subject_id, left_line_account_id, left_snapshot_json,
        right_subject_kind, right_subject_id, right_line_account_id, right_snapshot_json,
        evidence_fingerprint, evidence_json, impact_json, detected_at,
        created_at, updated_at
      ) VALUES ('candidate-broken', ?, 'friend_duplicate', 'pending', 1, 80, 'v1',
        'friend', 'friend-a', 'account-a', '{}', 'friend', 'friend-ghost', 'account-a',
        '{}', 'fingerprint-broken', '[]', '[]', '2026-08-30T09:00:00.000Z',
        '2026-08-30T09:00:00.000Z', '2026-08-30T09:00:00.000Z')
    `).run(DEFAULT_TENANT_ID);
    // friend-ghost は friends に無い。assertFriendScope で止まる。
    await expect(decideIdentityCandidate(testDb.db, owner1, 'candidate-broken', {
      expectedVersion: 1, decision: 'linked', reason: '壊れた候補を判定します',
    })).rejects.toMatchObject({ status: 403 });
    expect(IdentityCandidateError).toBeDefined();
  });
});
