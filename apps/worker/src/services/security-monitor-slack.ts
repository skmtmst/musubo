import { tracedFetch as fetch } from '@line-crm/shared/server';
import type { CodexSlackRelayConfig } from './codex-slack-relay.js';
import { securityRule } from './security-monitor-rules.js';
import type { SecurityAlertRow } from './security-monitor-store.js';

/** 送信待ち状態は警告の版へ保存し、実行権で同時 cron の重複送信を防ぐ。 */
export async function flushSecurityAlerts(db: D1Database, config: CodexSlackRelayConfig, now: Date, fetcher: typeof fetch = fetch) {
  const rows = await db.prepare(`SELECT * FROM security_alerts WHERE slack_sent_version < version AND rule_key NOT IN ('stripe_purge_review','stripe_external_effect_review','stripe_hash_key_review')
    AND (slack_lease_until IS NULL OR slack_lease_until <= ?) ORDER BY first_detected_at LIMIT 30`)
    .bind(now.toISOString()).all<SecurityAlertRow>();
  for (const row of rows.results) {
    const rule = securityRule(row.rule_key);
    if (!rule) continue;
    const token = crypto.randomUUID();
    const lease = new Date(now.getTime() + 5 * 60000).toISOString();
    const claimed = await db.prepare(`UPDATE security_alerts SET slack_lease_until = ?, slack_lease_token = ?
      WHERE id = ? AND version = ? AND slack_sent_version < version
        AND (slack_lease_until IS NULL OR slack_lease_until <= ?)`)
      .bind(lease, token, row.id, row.version, now.toISOString()).run();
    if (Number(claimed.meta.changes) !== 1) continue;
    let error: string | null = null;
    try {
      if (!config.SLACK_BOT_TOKEN || !config.SLACK_ERROR_CHANNEL_ID) {
        error = 'unconfigured';
      } else {
        // DB 外へ出すのは固定名・サーバー生成 UUID・整数・正規化済み UTC 時刻だけ。
        const id = /^[a-f0-9-]{36}$/.test(row.id) ? row.id : 'unavailable';
        const count = Number.isSafeInteger(row.observed_count) ? row.observed_count : 0;
        const response = await fetcher('https://slack.com/api/chat.postMessage', {
          method: 'POST', headers: { Authorization: `Bearer ${config.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(10000),
          body: JSON.stringify({ channel: config.SLACK_ERROR_CHANNEL_ID,
            client_msg_id: row.notification_id, text: `【musubo 安全監視】${rule.label}\n直近15分：${count}件\n検知：${now.toISOString()}\n事故ID：${id}\n運用状態の要対応を確認してください。`,
            unfurl_links: false, unfurl_media: false }),
        });
        const result = await response.json() as { ok?: boolean };
        if (!response.ok || result.ok !== true) error = 'delivery_failed';
      }
    } catch { error = 'delivery_failed'; }
    await db.prepare(`UPDATE security_alerts SET
      slack_sent_version = CASE WHEN ? IS NULL THEN MAX(slack_sent_version, ?) ELSE slack_sent_version END,
      slack_last_error = ?, slack_lease_token = NULL, slack_lease_until = ?
      WHERE id = ? AND slack_lease_token = ?`)
      .bind(error, row.version, error, error ? lease : null, row.id, token).run();
  }
}
