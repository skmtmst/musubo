/**
 * 承認・却下の再試行で金額が変わらないことの試験。
 *
 * - 承認時のマイル設定を保存し、同じ成果の再試行で付与額が変わらない
 * - 承認金額の保存に失敗しても、設定変更後の再試行で過去の報酬額が変わらない
 * - 締め済み成果を却下して再承認すると、円の支払対象が復活する
 *
 * 守りを外すと落ちる形にしてある。
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  decideConversionApproval,
  getApprovalNotificationState,
  getConversionApprovalNotifyInfo,
  markApprovalNotified,
  releaseApprovalNotification,
} from '../src/affiliate-offers.js';
import {
  confirmAffiliateSettlement,
  previewAffiliateSettlement,
} from '../src/affiliate-settlements.js';
import { unappliedSettlementDebits } from '../src/affiliate-payouts.js';

async function unappliedDebits() {
  return unappliedSettlementDebits(db, { tenantId: TENANT_ID, lineAccountId: 'account-1' });
}
import { syncAffiliateConversionMileage } from '../src/mileage/index.js';
import { asD1 } from './d1-test-helper.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
let sqlite: Database.Database;
let db: D1Database;

function seed() {
  sqlite = new Database(':memory:');
  sqlite.exec(readFileSync(join(import.meta.dirname, '..', 'bootstrap.sql'), 'utf8'));
  sqlite.exec(`
    INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, tenant_id)
    VALUES ('account-1', 'channel-1', '本店', 'token', 'secret', '${TENANT_ID}');
    INSERT INTO friends (id, line_user_id, display_name, line_account_id)
    VALUES ('friend-1', 'U1', '田中', 'account-1'), ('friend-2', 'U2', '佐藤', 'account-1');
    INSERT INTO affiliates
      (id, name, code, commission_rate, friend_id, tenant_id, line_account_id, hold_days)
    VALUES ('affiliate-fixed', '定額さん', 'fixed-code', 0, 'friend-2', '${TENANT_ID}', 'account-1', 0);
    INSERT INTO conversion_points (id, name, event_type, value, line_account_id)
    VALUES ('point-1', '購入', 'purchase', 10000, 'account-1');
    INSERT INTO mileage_programs (id, code, name, created_at, updated_at)
    VALUES ('default', 'default', 'Harnessマイル', '2026-08-01', '2026-08-01');
    INSERT INTO affiliate_offers (id, name, reward_amount, reward_miles, line_account_id, created_at)
    VALUES ('offer-1', '定期便', 1000, 100, 'account-1', '2026-08-01');
    INSERT INTO affiliate_links (id, affiliate_id, ref_code, line_account_id, offer_id, created_at)
    VALUES ('link-1', 'affiliate-fixed', 'ref-1', 'account-1', 'offer-1', '2026-08-01');
  `);
  db = asD1(sqlite);
}

function addPendingEvent(id: string) {
  sqlite.prepare(
    `INSERT INTO conversion_events
       (id, conversion_point_id, friend_id, affiliate_id, attributed_ref_code, approval_status)
     VALUES (?, 'point-1', 'friend-1', 'affiliate-fixed', 'ref-1', NULL)`,
  ).run(id);
}

function ledgerGrantTotal(): number {
  // 取消は reversal 行（負数）で残るため、付与行だけではなく正味で見る。
  const row = sqlite.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM mileage_ledger
      WHERE source = 'affiliate_conversion' AND status = 'available'`,
  ).get() as { total: number };
  return Number(row.total);
}

function calcAmount(eventId: string): number | null {
  const row = sqlite.prepare(
    `SELECT amount_minor FROM affiliate_reward_calculations WHERE conversion_event_id = ?`,
  ).get(eventId) as { amount_minor: number } | undefined;
  return row ? Number(row.amount_minor) : null;
}

beforeEach(() => {
  seed();
});

describe('成果の承認を再送しても承認時のマイルを保つ', () => {
  it('0マイル承認の再送で設定変更後の300マイルが付与されない', async () => {
    sqlite.prepare(`UPDATE affiliate_offers SET reward_miles = 0 WHERE id = 'offer-1'`).run();
    addPendingEvent('ce-1');

    const first = await decideConversionApproval(db, 'ce-1', 'approved', 'pending');
    expect(first.outcome).toBe('updated');
    await syncAffiliateConversionMileage(db, 'ce-1', 'approved');
    expect(ledgerGrantTotal()).toBe(0);

    // 案件を300マイルへ変更して同じ承認を再送（一覧を読み直していない再試行）。
    sqlite.prepare(`UPDATE affiliate_offers SET reward_miles = 300 WHERE id = 'offer-1'`).run();
    const retry = await decideConversionApproval(db, 'ce-1', 'approved', 'pending');
    expect(retry.outcome).toBe('already_set');
    await syncAffiliateConversionMileage(db, 'ce-1', 'approved');

    expect(ledgerGrantTotal()).toBe(0);
  });

  it('付与失敗後の再試行で承認時の100マイルを回復する', async () => {
    addPendingEvent('ce-1');
    const first = await decideConversionApproval(db, 'ce-1', 'approved', 'pending');
    expect(first.outcome).toBe('updated');
    await syncAffiliateConversionMileage(db, 'ce-1', 'approved');
    expect(ledgerGrantTotal()).toBe(100);

    // 付与だけ消して「保存失敗後」の状態を作り、設定を300へ変えて再試行。
    sqlite.prepare(`DELETE FROM mileage_grant_lots`).run();
    sqlite.prepare(`DELETE FROM mileage_ledger WHERE source = 'affiliate_conversion'`).run();
    sqlite.prepare(`DELETE FROM mileage_event_queue`).run();
    sqlite.prepare(`DELETE FROM engagement_events WHERE source = 'affiliate_conversion'`).run();
    sqlite.prepare(`UPDATE affiliate_offers SET reward_miles = 300 WHERE id = 'offer-1'`).run();
    const retry = await decideConversionApproval(db, 'ce-1', 'approved', 'pending');
    expect(retry.outcome).toBe('already_set');
    await syncAffiliateConversionMileage(db, 'ce-1', 'approved');

    expect(ledgerGrantTotal()).toBe(100);
  });
});

describe('成果の承認を再試行しても承認時の金額を保つ', () => {
  it('版の保存失敗後の再試行で設定変更後の5000円にならない', async () => {
    addPendingEvent('ce-1');
    const first = await decideConversionApproval(db, 'ce-1', 'approved', 'pending');
    expect(first.outcome).toBe('updated');
    expect(calcAmount('ce-1')).toBe(1000);

    // 承認時の版INSERTだけ失敗した状態を再現し、案件を5000円へ変えて再試行。
    sqlite.prepare(`DELETE FROM affiliate_reward_calculations WHERE conversion_event_id = 'ce-1'`).run();
    sqlite.prepare(`UPDATE affiliate_offers SET reward_amount = 5000 WHERE id = 'offer-1'`).run();
    const retry = await decideConversionApproval(db, 'ce-1', 'approved', 'pending');
    expect(retry.outcome).toBe('already_set');

    expect(calcAmount('ce-1')).toBe(1000);
  });

  it('通知の金額も保存した1000円を使う（5000円を見せない）', async () => {
    addPendingEvent('ce-1');
    await decideConversionApproval(db, 'ce-1', 'approved', 'pending');
    sqlite.prepare(`DELETE FROM affiliate_reward_calculations WHERE conversion_event_id = 'ce-1'`).run();
    sqlite.prepare(`UPDATE affiliate_offers SET reward_amount = 5000 WHERE id = 'offer-1'`).run();

    const info = await getConversionApprovalNotifyInfo(db, 'ce-1');
    expect(info?.rewardAmount).toBe(1000);
  });
});

describe('成果の承認通知は送信記録を使って重複を防ぐ', () => {
  it('未送信の世代は送ってよく記録後は送らない、新しい承認ではまた送る', async () => {
    addPendingEvent('ce-1');
    // 未承認の行は送らない。
    expect(await getApprovalNotificationState(db, 'ce-1')).toMatchObject({ send: false });

    await decideConversionApproval(db, 'ce-1', 'approved', 'pending');
    const first = await getApprovalNotificationState(db, 'ce-1');
    expect(first.send).toBe(true);
    expect(first.approvedAt).not.toBeNull();

    // 送ったら記録し、同じ世代の再送では送らない。
    expect(await markApprovalNotified(db, 'ce-1', first.approvedAt!)).toBe(true);
    expect(await getApprovalNotificationState(db, 'ce-1')).toMatchObject({ send: false });
    // 二重の記録は取らない。
    expect(await markApprovalNotified(db, 'ce-1', first.approvedAt!)).toBe(false);

    // 却下→再承認（新しい世代）ではまた送る。世代はミリ秒刻みのため、
    // 同一ミリ秒の衝突を避けてから判断し直す。
    await new Promise((resolve) => setTimeout(resolve, 5));
    await decideConversionApproval(db, 'ce-1', 'rejected', 'approved');
    await decideConversionApproval(db, 'ce-1', 'approved', 'rejected');
    const second = await getApprovalNotificationState(db, 'ce-1');
    expect(second.send).toBe(true);
    expect(second.approvedAt).not.toBe(first.approvedAt);
  });

  it('同じ世代の並行確保は1件だけ通り、負けた側は送らない', async () => {
    addPendingEvent('ce-1');
    await decideConversionApproval(db, 'ce-1', 'approved', 'pending');
    const { approvedAt } = await getApprovalNotificationState(db, 'ce-1');

    // 同じ承認判断の並行要求を模し、同時に送信権を取りに行く。
    const [winner, loser] = await Promise.all([
      markApprovalNotified(db, 'ce-1', approvedAt!),
      markApprovalNotified(db, 'ce-1', approvedAt!),
    ]);
    // better-sqlite3 は直列だが CAS の契約（勝ち1・負け1）は変わらない。
    expect([winner, loser].filter(Boolean)).toHaveLength(1);
    expect(await getApprovalNotificationState(db, 'ce-1')).toMatchObject({ send: false });
  });

  it('送信の途中失敗は記録を戻し、再試行で送り直せる（欠落なし）', async () => {
    addPendingEvent('ce-1');
    await decideConversionApproval(db, 'ce-1', 'approved', 'pending');
    const { approvedAt } = await getApprovalNotificationState(db, 'ce-1');

    // 送信権を取ったあと送信に失敗した想定で、記録だけ戻す。
    expect(await markApprovalNotified(db, 'ce-1', approvedAt!)).toBe(true);
    expect(await releaseApprovalNotification(db, 'ce-1', approvedAt!)).toBe(true);
    // 再試行ではまた送ってよい状態に戻り、送り直せる。
    expect(await getApprovalNotificationState(db, 'ce-1')).toMatchObject({ send: true });
    expect(await markApprovalNotified(db, 'ce-1', approvedAt!)).toBe(true);
    expect(await getApprovalNotificationState(db, 'ce-1')).toMatchObject({ send: false });
  });

  it('古い世代の解放は新しい世代の未送信を消さない', async () => {
    addPendingEvent('ce-1');
    await decideConversionApproval(db, 'ce-1', 'approved', 'pending');
    const first = await getApprovalNotificationState(db, 'ce-1');
    expect(await markApprovalNotified(db, 'ce-1', first.approvedAt!)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await decideConversionApproval(db, 'ce-1', 'rejected', 'approved');
    await decideConversionApproval(db, 'ce-1', 'approved', 'rejected');
    const second = await getApprovalNotificationState(db, 'ce-1');
    expect(second.send).toBe(true);

    // 古い世代の遅れた解放が来ても、新しい世代の未送信は残る。
    expect(await releaseApprovalNotification(db, 'ce-1', first.approvedAt!)).toBe(false);
    expect(await getApprovalNotificationState(db, 'ce-1')).toMatchObject({ send: true });
  });
});

describe('締め後の成果は再承認しても二重払いを防ぐ', () => {
  it('再承認で確定が戻り取り立てが消える（二重支払いなし）', async () => {
    addPendingEvent('ce-1');
    await decideConversionApproval(db, 'ce-1', 'approved', 'pending');
    await syncAffiliateConversionMileage(db, 'ce-1', 'approved');
    expect(ledgerGrantTotal()).toBe(100);

    const settled = await confirmAffiliateSettlement(db, {
      tenantId: TENANT_ID, lineAccountId: 'account-1', affiliateId: 'affiliate-fixed',
      actorId: 'staff-1', idempotencyKey: 'settle-1', expectedAmount: 1000,
      now: '2026-09-01T00:00:00.000Z',
    });
    expect(settled.kind).toBe('created');

    const rejected = await decideConversionApproval(db, 'ce-1', 'rejected', 'approved');
    expect(rejected.outcome).toBe('updated');
    await syncAffiliateConversionMileage(db, 'ce-1', 'rejected');
    expect(ledgerGrantTotal()).toBe(0);
    // 却下の直後は1000円の取り立てが未適用で残る。
    expect(await unappliedDebits()).toHaveLength(1);

    const reapproved = await decideConversionApproval(db, 'ce-1', 'approved', 'rejected');
    expect(reapproved.outcome).toBe('updated');
    await syncAffiliateConversionMileage(db, 'ce-1', 'approved');
    // マイルは正味100に戻る。
    expect(ledgerGrantTotal()).toBe(100);

    // 円の確定も1件に戻り、取り立ては消える。締めの記録はそのまま残す。
    const credit = sqlite.prepare(
      `SELECT status FROM affiliate_reward_entries
        WHERE conversion_event_id = 'ce-1' AND entry_type = 'credit'`,
    ).get() as { status: string };
    expect(credit.status).toBe('settled');
    expect(await unappliedDebits()).toHaveLength(0);

    // 新しい確定は作らない（成果ごとに1件）。締め直しの対象も出ない。
    const credits = sqlite.prepare(
      `SELECT COUNT(*) AS c FROM affiliate_reward_entries
        WHERE conversion_event_id = 'ce-1' AND entry_type = 'credit'`,
    ).get() as { c: number };
    expect(credits.c).toBe(1);
    const preview = await previewAffiliateSettlement(db, {
      tenantId: TENANT_ID, affiliateId: 'affiliate-fixed', lineAccountId: 'account-1',
      now: '2026-09-02T00:00:00.000Z',
    });
    expect(preview?.entries.length ?? 0).toBe(0);

    // 再承認の再送では何も変わらない（調整は1回）。
    const again = await decideConversionApproval(db, 'ce-1', 'approved', 'approved');
    expect(again.outcome).toBe('already_set');
    const creditAgain = sqlite.prepare(
      `SELECT status FROM affiliate_reward_entries
        WHERE conversion_event_id = 'ce-1' AND entry_type = 'credit'`,
    ).get() as { status: string };
    expect(creditAgain.status).toBe('settled');
    expect(await unappliedDebits()).toHaveLength(0);
    expect(ledgerGrantTotal()).toBe(100);
  });
});
