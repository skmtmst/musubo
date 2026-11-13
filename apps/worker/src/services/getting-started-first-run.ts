import { firstDeliveredMessageAt, toJstString } from '@line-crm/db';
import { instant } from './style-analytics-core.js';

/** 保存の形がまちまち（Z・+09:00・時差なしの日本時間）な時刻を、日本時間の文字にそろえる。 */
function jst(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = instant(value);
  return Number.isFinite(at) ? toJstString(new Date(at)) : null;
}

/**
 * 最初の10分の5地点。初回のスタイル選択と初期セット適用は固定した時刻を読む。
 * - 友だち追加は LINE から届いた follow の記録だけを数える。取り込み（followers/ids）で作った友だちは
 *   follow の記録を作らないので入らない。
 * - 分は Worker の時刻で計算する。端末の時計は使わない。
 */
export async function firstRunTimes(db: D1Database, accountId: string) {
  const [account, style, starter, follow, firstMessage] = await Promise.all([
    db.prepare('SELECT created_at AS at FROM line_accounts WHERE id = ?')
      .bind(accountId).first<{ at: string | null }>(),
    db.prepare("SELECT first_selected_at AS at FROM account_styles WHERE line_account_id = ?")
      .bind(accountId).first<{ at: string | null }>(),
    db.prepare('SELECT first_starter_at AS at FROM account_styles WHERE line_account_id = ?')
      .bind(accountId).first<{ at: string | null }>(),
    db.prepare(
      `SELECT MIN(received_at) AS at FROM line_webhook_events INDEXED BY idx_line_webhook_events_account
        WHERE line_account_id = ? AND event_type = 'follow' AND status = 'succeeded'`,
    ).bind(accountId).first<{ at: string | null }>(),
    firstDeliveredMessageAt(db, accountId),
  ]);
  const startedAt = jst(account?.at);
  const firstMessageAt = jst(firstMessage);
  const minutes = startedAt && firstMessageAt
    ? Math.max(0, Math.ceil((instant(firstMessageAt) - instant(startedAt)) / 60000))
    : null;
  return {
    startedAt,
    styleAt: jst(style?.at),
    starterAt: jst(starter?.at),
    followAt: jst(follow?.at),
    firstMessageAt,
    minutes,
  };
}
