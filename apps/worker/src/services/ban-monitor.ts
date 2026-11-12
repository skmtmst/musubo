import { lineWebhookSilence, jstCalendar as japanCalendar } from '@line-crm/shared';
import { logger, tracedFetch as fetch } from '@line-crm/shared/server';
/**
 * BAN検知モニター — cronトリガーで定期実行
 *
 * LINE APIのエラー率を監視し、BAN リスクを検出する
 * 403/429 エラーのパターンを分析してリスクレベルを判定
 */

import {
  getLineAccounts,
  createAccountHealthLog,
  createNotification,
  getLatestRiskLevel,
  recordPoolSwitchEvent,
  listAutoSwitchedOutPoolAccounts,
  togglePoolAccount,
  recordAuditEvent,
  type LineAccount,
} from '@line-crm/db';


/** 「正常」が続いたらプールへ自動で戻すまでの時間（X の確定値・24時間）。 */
const POOL_RETURN_NORMAL_MS = 24 * 60 * 60 * 1000;

export async function checkAccountHealth(
  db: D1Database,
): Promise<void> {
  const accounts = await getLineAccounts(db);

  for (const account of accounts) {
    if (!account.is_active) continue;

    try {
      await checkSingleAccount(db, account);
    } catch (err) {
      logger.error("ban_monitor.check_account_health_failed");
    }
  }

  try {
    await returnRecoveredAccountsToPools(db);
  } catch (err) {
    logger.error("ban_monitor.check_account_health_failed");
  }
}

async function checkSingleAccount(
  db: D1Database,
  account: LineAccount,
): Promise<void> {
  const jstMs = Date.now() + 9 * 60 * 60_000;
  const now = new Date(jstMs);
  const checkPeriod = now.toISOString().slice(0, -1) + '+09:00';

  // 直近1時間のメッセージログからエラーパターンを推定
  // (実際のLINE APIエラーはログに残らないが、送信成功率から推定)
  const oneHourAgo = new Date(jstMs - 60 * 60_000).toISOString().slice(0, -1) + '+09:00';

  const sentMessages = await db
    .prepare(
      `SELECT COUNT(*) as count FROM messages_log
       WHERE direction = 'outgoing' AND created_at >= ? AND line_account_id = ?`,
    )
    .bind(oneHourAgo, account.id)
    .first<{ count: number }>();

  const totalSent = sentMessages?.count ?? 0;

  // LINE APIにヘルスチェックリクエスト
  let errorCode: number | null = null;
  let errorCount = 0;

  try {
    const response = await fetch('https://api.line.me/v2/bot/info', {
      headers: { Authorization: `Bearer ${account.channel_access_token}` },
    });

    if (!response.ok) {
      errorCode = response.status;
      errorCount = 1;
    }
  } catch {
    errorCode = 0; // ネットワークエラー
    errorCount = 1;
  }

  // Webhook 受信が想定時間（既定24時間）無いときは warning。
  // 受信しない運用のアカウントは webhook_silence_exempt で外せる。
  const silent = lineWebhookSilence({ lastReceivedAt: account.last_webhook_received_at, createdAt: account.created_at, exempt: Boolean(account.webhook_silence_exempt) });

  // リスクレベル判定
  let riskLevel = 'normal';
  if (errorCode === 403) {
    riskLevel = 'danger'; // BAN の可能性
  } else if (errorCode === 429 || silent || totalSent > 5000) {
    riskLevel = 'warning'; // レート制限・Webhook無受信・大量送信の警告
  }

  const previousRiskLevel = await getLatestRiskLevel(db, account.id);
  const healthLog = await createAccountHealthLog(db, {
    lineAccountId: account.id,
    errorCode: errorCode ?? undefined,
    errorCount,
    checkPeriod,
    riskLevel,
  });

  // 定期確認のたびに同じ通知を増やさず、状態が変わった時だけ知らせる。
  if (riskLevel !== previousRiskLevel) {
    if (riskLevel === 'warning' || riskLevel === 'danger') {
      await createNotification(db, {
        eventType: `account_health_${riskLevel}`,
        title: riskLevel === 'danger'
          ? 'LINE公式アカウントの接続を確認してください'
          : silent ? 'Webhook が届いていません' : 'LINE公式アカウントの送信状況を確認してください',
        body: riskLevel === 'danger'
          ? 'LINEとの接続に問題が見つかりました。運用状態から確認してください。'
          : silent ? 'Webhookを24時間以上受信していません。運用状態から確認してください。' : '送信量またはLINEの応答に注意が必要です。運用状態から確認してください。',
        channel: 'dashboard',
        lineAccountId: account.id,
        category: 'error',
        metadata: JSON.stringify({
          healthLogId: healthLog.id,
          riskLevel,
          errorCode,
        }),
      });
    } else if (riskLevel === 'normal' && (previousRiskLevel === 'warning' || previousRiskLevel === 'danger')) {
      await createNotification(db, {
        eventType: 'account_health_recovered',
        title: 'LINE公式アカウントの接続が正常に戻りました',
        body: '接続と送信状況が正常に戻りました。',
        channel: 'dashboard',
        lineAccountId: account.id,
        category: 'update',
        metadata: JSON.stringify({
          healthLogId: healthLog.id,
          previousRiskLevel,
        }),
      });
    }
  }

  if (riskLevel === 'danger') {
    logger.error("ban_monitor.check_single_account_failed");
    /*
     * 自動切替（-33 §11-2、X-2）。トラフィックプールに入っている
     * アカウントが danger になったら、プールの中だけで止めて、
     * 友だち追加先を同じ組の予備へ切り替える。
     * アカウント自体の is_active は触らない（配信・受信の停止は別の決まり）。
     */
    await switchOutOfPools(db, account.id);
  }
}

/** danger になったアカウントを、入っているプールから外す。 */
async function switchOutOfPools(db: D1Database, lineAccountId: string): Promise<void> {
  const pools = await db
    .prepare(
      `SELECT pa.id AS pool_account_id, pa.pool_id
         FROM pool_accounts pa
         JOIN traffic_pools tp ON tp.id = pa.pool_id
        WHERE pa.line_account_id = ? AND pa.is_active = 1`,
    )
    .bind(lineAccountId)
    .all<{ pool_account_id: string; pool_id: string }>();

  for (const row of pools.results) {
    await togglePoolAccount(db, row.pool_account_id, false);
    await recordPoolSwitchEvent(db, {
      poolId: row.pool_id,
      lineAccountId,
      direction: 'out',
      reason: 'health_danger',
    });
    await recordAuditEvent(db, {
      category: 'business',
      actorRole: 'system',
      action: 'line_account.pool_switch',
      targetKind: 'line_account',
      targetId: lineAccountId,
      reason: 'health_danger',
      lineAccountId,
    });
    await createNotification(db, {
      eventType: 'account_pool_switched',
      title: 'アカウントの割り当てを自動で切り替えました',
      body: '接続の状態が「危ない」になったため、同じ組の予備へ切り替えました。元のアカウントが24時間「正常」なら自動で戻します。',
      channel: 'dashboard',
      lineAccountId,
      category: 'error',
      metadata: JSON.stringify({ poolId: row.pool_id, direction: 'out', reason: 'health_danger' }),
    });
  }
}

/**
 * 自動で外れたアカウントを、24時間「正常」が続いたらプールへ戻す（X-2）。
 * 「正常が続いた」＝直近24時間に warning/danger の記録が1件も無い。
 */
async function returnRecoveredAccountsToPools(db: D1Database): Promise<void> {
  const switchedOut = await listAutoSwitchedOutPoolAccounts(db);
  // account_health_logs.created_at は JST(+09:00) 表記。同じ形で比べる。
  const since =
    japanCalendar(new Date(Date.now() - POOL_RETURN_NORMAL_MS))
      .toISOString()
      .slice(0, -1) + '+09:00';

  for (const entry of switchedOut) {
    const abnormal = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM account_health_logs
          WHERE line_account_id = ? AND risk_level != 'normal' AND created_at > ?`,
      )
      .bind(entry.line_account_id, since)
      .first<{ count: number }>();
    // 24時間ぶんの記録がまだ溜まっていない（外れたばかり）ときは戻さない。
    if ((abnormal?.count ?? 0) > 0) continue;
    const normalCount = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM account_health_logs
          WHERE line_account_id = ? AND risk_level = 'normal' AND created_at > ?`,
      )
      .bind(entry.line_account_id, since)
      .first<{ count: number }>();
    if ((normalCount?.count ?? 0) === 0) continue;

    await db.batch([
      db.prepare(`UPDATE pool_accounts SET is_active = 1 WHERE pool_id = ? AND line_account_id = ? AND is_active = 0`).bind(entry.pool_id, entry.line_account_id),
      db.prepare('UPDATE traffic_pools SET confirmation_revision=confirmation_revision+1 WHERE id=? AND changes()>0').bind(entry.pool_id),
    ]);
    await recordPoolSwitchEvent(db, {
      poolId: entry.pool_id,
      lineAccountId: entry.line_account_id,
      direction: 'in',
      reason: 'health_recovered_24h',
    });
    await recordAuditEvent(db, {
      category: 'business',
      actorRole: 'system',
      action: 'line_account.pool_switch',
      targetKind: 'line_account',
      targetId: entry.line_account_id,
      reason: 'health_recovered_24h',
      lineAccountId: entry.line_account_id,
    });
    await createNotification(db, {
      eventType: 'account_pool_switched',
      title: 'アカウントの割り当てが元に戻りました',
      body: '24時間「正常」が続いたため、予備から元のアカウントへ戻しました。',
      channel: 'dashboard',
      lineAccountId: entry.line_account_id,
      category: 'update',
      metadata: JSON.stringify({ poolId: entry.pool_id, direction: 'in', reason: 'health_recovered_24h' }),
    });
  }
}
