/**
 * マイルの調整・通知・残高の試験。
 *
 * - 確定済み調整の再送は、あとからの承認境界変更や期限経過で拒否されない
 * - 通知の sent は遅い失敗で戻らない
 * - 30日より先の期限つきマイルは「期限つき記録なし（null）」と区別する
 * - 「今月の増減」は日本時間の月初で切る
 * - 本人へ結ぶと、友だち宛ての残高・ロットが本人へ移る
 * - 同じ本人に複数プロフィールがあっても残高を二度足さない
 * - 権限外アカウントの調整理由・実行者・元イベントを明細へ返さない
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MileageAdjustmentError,
  findCommittedMileageAdjustment,
  getMileageHistoryForFriend,
  getMileageSummaryForFriend,
  postMileageAdjustment,
} from '../src/mileage/index.js';
import {
  getMileageFriendsV6,
  markMileageAdjustmentNotification,
  reserveMileageAdjustmentNotification,
} from '../src/mileage/admin-operations.js';
import { linkFriendToUser } from '../src/users.js';
import { asD1 } from './d1-test-helper.js';

let sqlite: Database.Database;
let db: D1Database;

function seed() {
  sqlite = new Database(':memory:');
  sqlite.exec(readFileSync(join(import.meta.dirname, '..', 'bootstrap.sql'), 'utf8'));
  sqlite.exec(`
    INSERT INTO users (id, display_name) VALUES ('user-1', '本人');
    INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES
      ('acc-a', 'ch-a', 'アカウントA', 'token-a', 'secret-a'),
      ('acc-b', 'ch-b', 'アカウントB', 'token-b', 'secret-b');
    INSERT INTO friends (id, line_user_id, display_name, user_id, line_account_id) VALUES
      ('fa-unlinked', 'UA0', '未紐付けA', NULL, 'acc-a'),
      ('fa-1', 'UA1', 'Aのプロフィール1', 'user-1', 'acc-a'),
      ('fa-2', 'UA2', 'Aのプロフィール2', 'user-1', 'acc-a'),
      ('fb-1', 'UB1', 'Bのプロフィール', 'user-1', 'acc-b');
  `);
  db = asD1(sqlite);
}

const STAFF = { executedByStaffId: 'staff-1', executedByStaffName: '担当者' };

function adjustmentInput(overrides: Partial<Parameters<typeof postMileageAdjustment>[1]> = {}) {
  return {
    friendId: 'fa-unlinked',
    amount: 100,
    reason: '問い合わせ対応の補填',
    reasonCategory: 'customer_support',
    idempotencyKey: 'key-1',
    lineAccountId: 'acc-a',
    ...STAFF,
    ...overrides,
  };
}

function friendWallet(beneficiaryKey: string) {
  return sqlite.prepare(
    `SELECT beneficiary_key, beneficiary_user_id, beneficiary_friend_id, available, pending
       FROM mileage_wallets WHERE beneficiary_key = ?`,
  ).get(beneficiaryKey) as
    | { beneficiary_key: string; beneficiary_user_id: string | null; beneficiary_friend_id: string | null; available: number; pending: number }
    | undefined;
}

beforeEach(seed);
afterEach(() => vi.useRealTimers());

describe('確定済みのマイル調整は同じ要求なら元の結果を返す', () => {
  it('同一キー・同一内容の再送は当時の結果を返す', async () => {
    const first = await postMileageAdjustment(db, adjustmentInput());
    const committed = await findCommittedMileageAdjustment(db, adjustmentInput());
    expect(committed).not.toBeNull();
    expect(committed!.entry.id).toBe(first.entry.id);
    expect(committed!.balanceBefore).toBe(first.balanceBefore);
    expect(committed!.balanceAfter).toBe(first.balanceAfter);
    expect(committed!.replayed).toBe(true);
    const rows = sqlite.prepare(
      `SELECT COUNT(*) AS n FROM mileage_ledger WHERE idempotency_key = 'key-1'`,
    ).get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('期限付きの確定済み調整も期限経過後の再送で同じ結果を返す', async () => {
    // 元の要求時点では未来の期限。再送時点では過去でもよい（指紋は期限を含む）。
    await postMileageAdjustment(db, adjustmentInput({ expiresAt: '2026-12-01T00:00:00.000Z' }));
    const committed = await findCommittedMileageAdjustment(
      db,
      adjustmentInput({ expiresAt: '2026-12-01T00:00:00.000Z' }),
    );
    expect(committed).not.toBeNull();
    expect(committed!.replayed).toBe(true);
  });

  it('同じキーで別の内容は idempotency_conflict', async () => {
    await postMileageAdjustment(db, adjustmentInput());
    await expect(
      findCommittedMileageAdjustment(db, adjustmentInput({ amount: 200 })),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(
      findCommittedMileageAdjustment(db, adjustmentInput({ reason: '別の理由' })),
    ).rejects.toBeInstanceOf(MileageAdjustmentError);
  });

  it('キーが見つからなければ null（新規判定へ進む）', async () => {
    expect(await findCommittedMileageAdjustment(db, adjustmentInput())).toBeNull();
  });
});

describe('マイル通知は送信後の遅い失敗で状態を戻さない', () => {
  it('sent 済みの通知はあとから届いた failed で上書きしない', async () => {
    await postMileageAdjustment(db, adjustmentInput({ notifyFriend: true }));
    const entry = sqlite.prepare(
      `SELECT id FROM mileage_ledger WHERE idempotency_key = 'key-1'`,
    ).get() as { id: string };
    const reserved = await reserveMileageAdjustmentNotification(db, {
      lineAccountId: 'acc-a',
      friendId: 'fa-unlinked',
      ledgerEntryId: entry.id,
      idempotencyKey: 'key-1',
      message: 'マイルが 100 mile 増えました。',
    });
    await markMileageAdjustmentNotification(db, {
      id: reserved.id, status: 'sent', lineRequestId: 'req-1',
    });
    // 並行した遅い試行の失敗があとから届く
    const after = await markMileageAdjustmentNotification(db, {
      id: reserved.id, status: 'failed', errorCode: 'delivery_failed',
    });
    expect(after.status).toBe('sent');
    expect(after.lineRequestId).toBe('req-1');
    expect(after.sentAt).not.toBeNull();
  });

  it('failed から sent への回復は許す', async () => {
    await postMileageAdjustment(db, adjustmentInput({ notifyFriend: true }));
    const entry = sqlite.prepare(
      `SELECT id FROM mileage_ledger WHERE idempotency_key = 'key-1'`,
    ).get() as { id: string };
    const reserved = await reserveMileageAdjustmentNotification(db, {
      lineAccountId: 'acc-a',
      friendId: 'fa-unlinked',
      ledgerEntryId: entry.id,
      idempotencyKey: 'key-1',
      message: 'マイルが 100 mile 増えました。',
    });
    await markMileageAdjustmentNotification(db, {
      id: reserved.id, status: 'failed', errorCode: 'delivery_unknown',
    });
    const recovered = await markMileageAdjustmentNotification(db, {
      id: reserved.id, status: 'sent', lineRequestId: 'req-2',
    });
    expect(recovered.status).toBe('sent');
    expect(recovered.lineRequestId).toBe('req-2');
  });

  it('同じ台帳行への再予約は通知行を増やさない', async () => {
    await postMileageAdjustment(db, adjustmentInput({ notifyFriend: true }));
    const entry = sqlite.prepare(
      `SELECT id FROM mileage_ledger WHERE idempotency_key = 'key-1'`,
    ).get() as { id: string };
    const first = await reserveMileageAdjustmentNotification(db, {
      lineAccountId: 'acc-a', friendId: 'fa-unlinked', ledgerEntryId: entry.id,
      idempotencyKey: 'key-1', message: 'm',
    });
    const again = await reserveMileageAdjustmentNotification(db, {
      lineAccountId: 'acc-a', friendId: 'fa-unlinked', ledgerEntryId: entry.id,
      idempotencyKey: 'key-1', message: 'm',
    });
    expect(again.id).toBe(first.id);
    const count = sqlite.prepare(
      `SELECT COUNT(*) AS n FROM mileage_adjustment_notifications WHERE ledger_entry_id = ?`,
    ).get(entry.id) as { n: number };
    expect(count.n).toBe(1);
  });
});

describe('マイル残高は30日以内の失効と次の失効日を区別する', () => {
  it('31日後に失効するロットは 30日内0・次の失効日ありで返る', async () => {
    const expiresAt = new Date(Date.now() + 31 * 86_400_000).toISOString();
    await postMileageAdjustment(db, adjustmentInput({ expiresAt }));
    const overview = await getMileageFriendsV6(db, {
      lineAccountId: 'acc-a', visibleAccountIds: ['acc-a'], search: '', limit: 50, offset: 0,
    });
    const member = overview.items.find((item) => item.friendId === 'fa-unlinked');
    expect(member).toBeDefined();
    expect(member!.expiringMiles30d).toBe(0);
    expect(member!.nextExpiringAt).not.toBeNull();
    expect(overview.summary.nextExpiringAt).not.toBeNull();
    // 期限つきのない友だちは null のまま
    const plain = overview.items.find((item) => item.friendId === 'fa-1');
    expect(plain!.expiringMiles30d).toBeNull();
  });

  it('30日ちょうどの境界は含め、30日1秒は含めない', async () => {
    const in30d = new Date(Date.now() + 30 * 86_400_000);
    const over30d = new Date(Date.now() + 30 * 86_400_000 + 2000);
    await postMileageAdjustment(db, adjustmentInput({
      idempotencyKey: 'key-in30', amount: 100, expiresAt: in30d.toISOString(),
    }));
    await postMileageAdjustment(db, adjustmentInput({
      idempotencyKey: 'key-over30', amount: 200, expiresAt: over30d.toISOString(),
      friendId: 'fa-unlinked',
    }));
    const overview = await getMileageFriendsV6(db, {
      lineAccountId: 'acc-a', visibleAccountIds: ['acc-a'], search: '', limit: 50, offset: 0,
    });
    const member = overview.items.find((item) => item.friendId === 'fa-unlinked');
    expect(member!.expiringMiles30d).toBe(100);
  });
});

describe('R384: 今月の増減は日本時間の月初で切る', () => {
  it('JST 10/1 00:00 時点で 9/15 分を今月へ混ぜない', async () => {
    // 9/15 の調整と 10/1 00:30(JST) の調整。台帳の occurred_at は +09:00 付きJST表記。
    await postMileageAdjustment(db, adjustmentInput({
      idempotencyKey: 'key-sep', amount: 50, occurredAt: '2026-09-15T12:00:00.000+09:00',
    }));
    await postMileageAdjustment(db, adjustmentInput({
      idempotencyKey: 'key-oct', amount: 100, occurredAt: '2026-10-01T00:30:00.000+09:00',
    }));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000+09:00'));
    const overview = await getMileageFriendsV6(db, {
      lineAccountId: 'acc-a', visibleAccountIds: ['acc-a'], search: '', limit: 50, offset: 0,
    });
    const member = overview.items.find((item) => item.friendId === 'fa-unlinked');
    // UTCの月初なら 50+100=150 に化ける。JSTの月初なら当月の100だけ。
    expect(member!.monthChange).toBe(100);
    expect(member!.available).toBe(150);
    expect(overview.summary.monthChange).toBe(100);
  });
});

describe('本人への紐付けでマイルを合算し再実行しても重複しない', () => {
  it('紐付け前の友だち宛てマイルが紐付け後も本人の残高として使える', async () => {
    await postMileageAdjustment(db, adjustmentInput());
    await linkFriendToUser(db, 'fa-unlinked', 'user-1');

    // 友だち名義の財布・ロットは本人名義へ移る
    expect(friendWallet('friend:fa-unlinked')).toBeUndefined();
    const wallet = friendWallet('user:user-1');
    expect(wallet?.available).toBe(100);
    const lot = sqlite.prepare(
      `SELECT beneficiary_key FROM mileage_grant_lots WHERE remaining_amount > 0`,
    ).get() as { beneficiary_key: string };
    expect(lot.beneficiary_key).toBe('user:user-1');
    // 台帳行は消さず、本人への印を足す
    const entry = sqlite.prepare(
      `SELECT beneficiary_user_id, beneficiary_friend_id FROM mileage_ledger WHERE idempotency_key = 'key-1'`,
    ).get() as { beneficiary_user_id: string | null; beneficiary_friend_id: string };
    expect(entry.beneficiary_user_id).toBe('user-1');
    expect(entry.beneficiary_friend_id).toBe('fa-unlinked');

    // 一覧・明細・履歴は同じ100を返す
    const overview = await getMileageFriendsV6(db, {
      lineAccountId: 'acc-a', visibleAccountIds: ['acc-a'], search: '', limit: 50, offset: 0,
    });
    const member = overview.items.find((item) => item.friendId === 'fa-unlinked');
    expect(member!.available).toBe(100);
    const summary = await getMileageSummaryForFriend(db, 'fa-unlinked');
    expect(summary.available).toBe(100);
    const history = await getMileageHistoryForFriend(db, 'fa-unlinked');
    expect(history.some((item) => item.amount === 100)).toBe(true);
  });

  it('紐付け先に残高があると合算し、再実行しても重複しない', async () => {
    // 本人の既存残高（別プロフィール fa-1 宛ての調整は本人キーの財布へ入る）
    await postMileageAdjustment(db, adjustmentInput({ friendId: 'fa-1', amount: 60, idempotencyKey: 'key-existing' }));
    await postMileageAdjustment(db, adjustmentInput());
    await linkFriendToUser(db, 'fa-unlinked', 'user-1');
    expect(friendWallet('user:user-1')?.available).toBe(160);
    // 再実行しても160のまま
    await linkFriendToUser(db, 'fa-unlinked', 'user-1');
    expect(friendWallet('user:user-1')?.available).toBe(160);
    const summary = await getMileageSummaryForFriend(db, 'fa-unlinked');
    expect(summary.available).toBe(160);
  });
});

describe('R386: 同一人物の複数プロフィールで残高を重複集計しない', () => {
  it('2プロフィールとも残高100、本人単位の合計も100', async () => {
    await postMileageAdjustment(db, adjustmentInput({ friendId: 'fb-1', lineAccountId: 'acc-b' }));
    const overview = await getMileageFriendsV6(db, {
      lineAccountId: 'acc-a', visibleAccountIds: ['acc-a', 'acc-b'], search: '', limit: 50, offset: 0,
    });
    const fa1 = overview.items.find((item) => item.friendId === 'fa-1');
    const fa2 = overview.items.find((item) => item.friendId === 'fa-2');
    // 各プロフィールは同じ本人の残高100をそのまま示す
    expect(fa1!.available).toBe(100);
    expect(fa2!.available).toBe(100);
    // 合計は本人単位に1度だけ（100 × プロフィール数ではない）
    expect(overview.summary.available).toBe(100);
    // 人数はプロフィール単位で数える
    expect(overview.summary.totalMembers).toBe(3);
  });
});

describe('閲覧権限がないアカウントのマイル履歴を伏せる', () => {
  it('見られないアカウントの理由・実行者・元イベントは返さない', async () => {
    await postMileageAdjustment(db, adjustmentInput({ friendId: 'fa-1', idempotencyKey: 'key-a' }));
    await postMileageAdjustment(db, {
      friendId: 'fb-1', lineAccountId: 'acc-b', amount: 200,
      reason: 'B専用の対応理由', reasonCategory: 'customer_support',
      sourceReferenceId: 'B-SECRET-REF', idempotencyKey: 'key-b',
      executedByStaffId: 'staff-b', executedByStaffName: 'Bの担当者',
    });
    const scoped = await getMileageHistoryForFriend(db, 'fa-1', {
      limit: 50, visibleAccountIds: ['acc-a'],
    });
    const hidden = scoped.find((item) => item.amount === 200);
    expect(hidden).toBeDefined();
    expect(hidden!.restricted).toBe(true);
    expect(hidden!.reason).toBeNull();
    expect(hidden!.executedByStaffName).toBeNull();
    expect(hidden!.sourceReferenceId).toBeNull();
    expect(hidden!.sourceEventId).toBeNull();
    const own = scoped.find((item) => item.amount === 100);
    expect(own!.restricted).toBe(false);
    expect(own!.reason).toBe('問い合わせ対応の補填');
    // 権限指定なし（owner相当）では従来どおり理由が見える
    const unscoped = await getMileageHistoryForFriend(db, 'fa-1', { limit: 50 });
    expect(unscoped.find((item) => item.amount === 200)!.reason).toBe('B専用の対応理由');
  });
});

describe('残高表示: 期限切れロットは利用可能から外す（m22u R360 の回帰）', () => {
  it('期限切れロットの残数を利用可能から差し引く', async () => {
    await postMileageAdjustment(db, adjustmentInput({ amount: 100 }));
    const entry = sqlite.prepare(
      `SELECT id FROM mileage_ledger WHERE idempotency_key = 'key-1'`,
    ).get() as { id: string };
    // ロットを過去期限にする（失効はまだ処理されていない状態）
    sqlite.prepare(
      `UPDATE mileage_grant_lots SET expires_at = '2020-01-01T00:00:00.000Z' WHERE ledger_entry_id = ?`,
    ).run(entry.id);
    const summary = await getMileageSummaryForFriend(db, 'fa-unlinked');
    expect(summary.available).toBe(0);
  });
});
