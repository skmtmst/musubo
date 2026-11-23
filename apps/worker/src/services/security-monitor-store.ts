import { securityRule } from './security-monitor-rules.js';
import type { SecurityCount } from './security-monitor-counts.js';
import type { SecurityAlert, SecurityMonitorStatus } from '@line-crm/shared';

export type SecurityAlertRow = {
  id: string; tenant_id: string; line_account_id: string | null; rule_key: string;
  observed_count: number; threshold_count: number; status: 'open' | 'acknowledged' | 'resolved';
  version: number; first_detected_at: string; last_detected_at: string; reviewed_at: string | null;
  slack_sent_version: number; slack_last_error: string | null;
  notification_id: string;
};

export function publicSecurityAlert(row: SecurityAlertRow): SecurityAlert {
  return {
    id: row.id, ruleKey: row.rule_key, summary: row.rule_key === 'stripe_hash_key_review' ? '決済照合の鍵を確認してください' : row.rule_key === 'stripe_external_effect_review' ? '決済操作の結果確認が必要' : row.rule_key === 'stripe_purge_review' ? '削除済み統括のStripe通知の照合' : securityRule(row.rule_key)?.label ?? '安全監視',
    count: row.observed_count, threshold: row.threshold_count, status: row.status, version: row.version,
    firstDetectedAt: row.first_detected_at, lastDetectedAt: row.last_detected_at, reviewedAt: row.reviewed_at,
    notification: row.slack_sent_version >= row.version ? 'sent' : row.slack_last_error === 'unconfigured' ? 'unconfigured' : 'pending',
  };
}

export async function observeSecurityAlert(db: D1Database, count: SecurityCount, threshold: number, now: string) {
  const scope = JSON.stringify([count.tenant_id, count.line_account_id]);
  // 静かな時間帯でも未解決の警告は消さず、人の確認で閉じる。
  await db.prepare(`INSERT INTO security_alerts
    (id, tenant_id, line_account_id, scope_key, rule_key, observed_count, threshold_count, first_detected_at, last_detected_at, notification_id, latest_event_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_key, rule_key) DO UPDATE SET
      observed_count = excluded.observed_count, threshold_count = excluded.threshold_count,
      last_detected_at = excluded.last_detected_at,
      latest_event_at = MAX(security_alerts.latest_event_at, excluded.latest_event_at),
      version = security_alerts.version + CASE WHEN security_alerts.status = 'resolved' THEN 1 ELSE 0 END,
      reviewed_at = CASE WHEN security_alerts.status = 'resolved' THEN NULL ELSE security_alerts.reviewed_at END,
      notification_id = CASE WHEN security_alerts.status = 'resolved' THEN excluded.notification_id ELSE security_alerts.notification_id END,
      status = CASE WHEN security_alerts.status = 'resolved' THEN 'open' ELSE security_alerts.status END
    WHERE security_alerts.status != 'resolved' OR excluded.latest_event_at > julianday(security_alerts.reviewed_at)`)
    .bind(crypto.randomUUID(), count.tenant_id, count.line_account_id, scope, count.rule_key,
      count.count, threshold, now, now, crypto.randomUUID(), count.latest_event_at ?? (Date.parse(now) / 86400000 + 2440587.5)).run();
}

export async function securityMonitorStatus(db: D1Database, now = new Date()): Promise<SecurityMonitorStatus> {
  const state = await db.prepare(`SELECT last_started_at, last_completed_at, last_error FROM security_monitor_state WHERE id = 'security'`)
    .first<{ last_started_at: string; last_completed_at: string | null; last_error: string | null }>();
  return {
    status: state?.last_error ? 'failed' : !state?.last_completed_at ? 'unknown'
      : now.getTime() - Date.parse(state.last_completed_at) > 15 * 60000 ? 'stale' : 'running',
    lastStartedAt: state?.last_started_at ?? null, lastCompletedAt: state?.last_completed_at ?? null,
    configurationValid: state?.last_error !== 'invalid_thresholds',
  };
}
