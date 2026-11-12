/**
 * linkFriendToUser の結合試験。
 *
 * base が素の付け替えだけだったところへ、origin がマイル移管、
 * 自分の枝が競合対策を足し、merge で両方を残した。
 * 片方だけに戻ると赤くなるよう、1回の結び直しで両方が動くことを確かめる。
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_TENANT_ID } from '@line-crm/shared';
import { postMileageAdjustment } from '../src/mileage/index.js';
import { linkFriendToUser } from '../src/users.js';
import { asD1 } from './d1-test-helper.js';

let sqlite: Database.Database;
let db: D1Database;

function seed() {
  sqlite = new Database(':memory:');
  sqlite.exec(readFileSync(join(import.meta.dirname, '..', 'bootstrap.sql'), 'utf8'));
  sqlite.prepare(
    `INSERT OR IGNORE INTO tenants (id, name, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(DEFAULT_TENANT_ID, '既定統括', '2026-08-30', '2026-08-30');
  sqlite.prepare(
    `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, tenant_id)
     VALUES ('account-a', 'channel-a', '本店', 'token', 'secret', ?)`,
  ).run(DEFAULT_TENANT_ID);
  sqlite.prepare(
    `INSERT INTO users (id, tenant_id, status, display_name, revision, created_by, created_at, updated_at)
     VALUES
      ('user-a', NULL, 'active', '本人A', 1, 'owner-1', '2026-08-30T09:00:00.000Z', '2026-08-30T09:00:00.000Z'),
      ('user-u2', NULL, 'active', '本人U2', 1, 'owner-1', '2026-08-30T09:00:00.000Z', '2026-08-30T09:00:00.000Z')`,
  ).run();
  sqlite.prepare(
    `INSERT INTO friends (id, line_user_id, display_name, user_id, line_account_id)
     VALUES ('friend-a', 'UA', '見本 171', NULL, 'account-a'),
            ('friend-b', 'UB', '見本 161', NULL, 'account-a')`,
  ).run();
  sqlite.prepare(
    `INSERT INTO identity_candidates (
       id, tenant_id, kind, status, version, confidence_score, detector_version,
       left_subject_kind, left_subject_id, left_line_account_id, left_snapshot_json,
       right_subject_kind, right_subject_id, right_line_account_id, right_snapshot_json,
       evidence_fingerprint, evidence_json, impact_json, detected_at,
       created_at, updated_at
     ) VALUES ('candidate-a', ?, 'friend_duplicate', 'linked', 2, 92, 'v1',
       'friend', 'friend-a', 'account-a', '{}', 'friend', 'friend-b', 'account-a',
       '{}', 'fingerprint-a', '[]', '[]', '2026-08-30T09:10:00.000Z',
       '2026-08-30T09:00:00.000Z', '2026-08-30T09:10:00.000Z')`,
  ).run(DEFAULT_TENANT_ID);
  db = asD1(sqlite);
}

beforeEach(seed);

describe('linkFriendToUser の結合: 結び直しとマイル移管', () => {
  it('旧経路で残った友だち名義の残高を移し、古い結び付き行も外す', async () => {
    // 未連携のうちに付いた100は friend:friend-a の財布に入る。
    await postMileageAdjustment(db, {
      friendId: 'friend-a',
      amount: 100,
      reason: '問い合わせ対応の補填',
      reasonCategory: 'customer_support',
      idempotencyKey: 'merge-key-1',
      lineAccountId: 'account-a',
      executedByStaffId: 'staff-1',
      executedByStaffName: '担当者',
    });
    // 旧実装の付け替え（マイル移管なし・結び付き行の整理なし）を再現する。
    sqlite.prepare(`UPDATE friends SET user_id = 'user-a' WHERE id = 'friend-a'`).run();
    sqlite.prepare(
      `INSERT INTO friend_identity_links (
         id, tenant_id, candidate_id, user_id, friend_id, link_method,
         evidence_snapshot_json, confidence_score, linked_by, linked_at
       ) VALUES ('link-a', ?, 'candidate-a', 'user-a', 'friend-a',
         'operator_review', '[]', 92, 'owner-1', '2026-08-30T09:10:00.000Z')`,
    ).run(DEFAULT_TENANT_ID);

    const moved = await linkFriendToUser(db, 'friend-a', 'user-u2', { id: 'owner-2' });
    expect(moved).toBe(true);
    expect(
      (sqlite.prepare(`SELECT user_id FROM friends WHERE id = 'friend-a'`).get() as { user_id: string }).user_id,
    ).toBe('user-u2');
    // 古い候補の結び付き行は外れる。
    expect(
      (sqlite.prepare(
        `SELECT COUNT(*) AS n FROM friend_identity_links
          WHERE friend_id = 'friend-a' AND unlinked_at IS NULL`,
      ).get() as { n: number }).n,
    ).toBe(0);
    // 両本人の版が進む。
    expect(
      (sqlite.prepare(`SELECT revision FROM users WHERE id = 'user-a'`).get() as { revision: number }).revision,
    ).toBe(2);
    expect(
      (sqlite.prepare(`SELECT revision FROM users WHERE id = 'user-u2'`).get() as { revision: number }).revision,
    ).toBe(2);
    // 友だち名義の財布・ロットは本人へ移り、再実行しても重複しない。
    expect(
      sqlite.prepare(`SELECT * FROM mileage_wallets WHERE beneficiary_key = 'friend:friend-a'`).get(),
    ).toBeUndefined();
    expect(
      (sqlite.prepare(`SELECT available FROM mileage_wallets WHERE beneficiary_key = 'user:user-u2'`).get() as {
        available: number;
      }).available,
    ).toBe(100);
    expect(
      (sqlite.prepare(
        `SELECT beneficiary_user_id FROM mileage_ledger WHERE idempotency_key = 'merge-key-1'`,
      ).get() as { beneficiary_user_id: string }).beneficiary_user_id,
    ).toBe('user-u2');

    expect(await linkFriendToUser(db, 'friend-a', 'user-u2')).toBe(true);
    expect(
      (sqlite.prepare(`SELECT available FROM mileage_wallets WHERE beneficiary_key = 'user:user-u2'`).get() as {
        available: number;
      }).available,
    ).toBe(100);
  });
});
