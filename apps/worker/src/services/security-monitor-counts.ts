import type { SecurityRuleKey } from './security-monitor-rules.js';

export type SecurityCount = { tenant_id: string; line_account_id: string | null; rule_key: SecurityRuleKey; count: number; latest_event_at?: number };

// JST と時差付き ISO の保存値は、移行済みの索引付き UTC 値で比較する。
const BASE = `SELECT tenant_id, line_account_id, category, action, result, after_json,
  security_created_at_jd AS utc_at FROM audit_events INDEXED BY idx_audit_events_security_utc
  WHERE security_created_at_jd > julianday(?) AND security_created_at_jd <= julianday(?)`;
const CONDITIONS: Record<Exclude<SecurityRuleKey, 'impersonation' | 'export_records'>, string> = {
  meeting_revoke_review: `action = 'booking.meeting.deleted_connection_review'`,
  login_failures: `category = 'auth' AND (action = 'auth.fail' OR (action IN ('auth.login', 'auth.mfa.verify') AND result != 'success'))`,
  api_mutations: `category = 'business' AND action GLOB 'api.*'`,
  export_requests: `action IN ('data.export', 'form_document.download', 'auth.export') AND result = 'success'`,
  permission_changes: `result = 'success' AND (action GLOB 'api.patch./api/staff/*' OR action GLOB 'api.put./api/staff/*' OR action GLOB 'api.*./api/access/users/*' OR action GLOB 'auth.permissions.*')`,
  admin_additions: `result = 'success' AND action IN ('api.post./api/staff', 'api.post./api/access/users')`,
  key_rotations: `result = 'success' AND action IN ('auth.api_key.rotate', 'auth.api_key.revoke', 'auth.mfa.reenroll', 'auth.mfa.recovery.regenerate', 'auth.mfa.policy')`,
  night_activity: `category = 'business' AND CAST(strftime('%H', utc_at, '+9 hours') AS INTEGER) < 6`,
};

export async function collectSecurityCounts(db: D1Database, now: Date): Promise<SecurityCount[]> {
  const until = now.toISOString();
  const since = new Date(now.getTime() - 15 * 60000).toISOString();
  const counts: SecurityCount[] = [];
  const expressions = Object.entries(CONDITIONS).flatMap(([key, condition]) => [
    `SUM(CASE WHEN ${condition} THEN 1 ELSE 0 END) AS ${key}`,
    `MAX(CASE WHEN ${condition} THEN utc_at ELSE NULL END) AS ${key}_latest`,
  ]);
  const metrics = await db.prepare(`WITH recent AS (${BASE})
    SELECT tenant_id, line_account_id, ${expressions.join(', ')} FROM recent
    GROUP BY tenant_id, line_account_id`)
    .bind(since, until).all<{ tenant_id: string; line_account_id: string | null } & Record<SecurityRuleKey, number>>();
  for (const row of metrics.results) {
    for (const key of Object.keys(CONDITIONS) as Array<keyof typeof CONDITIONS>) {
      counts.push({ tenant_id: row.tenant_id, line_account_id: row.line_account_id, rule_key: key, count: Number(row[key]), latest_event_at: Number((row as Record<string, unknown>)[`${key}_latest`]) });
    }
  }
  const exports = await db.prepare(`WITH recent AS (${BASE})
    SELECT tenant_id, line_account_id, MAX(utc_at) AS latest_event_at,
      SUM(CASE WHEN json_valid(after_json) AND json_type(after_json, '$.count') IN ('integer', 'real')
        THEN MAX(0, CAST(json_extract(after_json, '$.count') AS INTEGER)) ELSE 0 END) AS count
    FROM recent WHERE action = 'data.export' AND result = 'success'
    GROUP BY tenant_id, line_account_id`).bind(since, until).all<Omit<SecurityCount, 'rule_key'>>();
  counts.push(...exports.results.map(row => ({ ...row, rule_key: 'export_records' as const })));
  // 運営の記録は非表示の閲覧専用代理操作も含むため、店舗 API へ公開しない。
  const platform = await db.prepare(`SELECT COALESCE(tenant_id, '') AS tenant_id, NULL AS line_account_id, COUNT(*) AS count, MAX(security_created_at_jd) AS latest_event_at
    FROM platform_audit_logs INDEXED BY idx_platform_audit_logs_security_utc
    WHERE security_created_at_jd > julianday(?) AND security_created_at_jd <= julianday(?)
      AND action IN ('impersonation.start', 'impersonation.write', 'pii.reveal')
    GROUP BY tenant_id`).bind(since, until).all<Omit<SecurityCount, 'rule_key'>>();
  counts.push(...platform.results.map(row => ({ ...row, rule_key: 'impersonation' as const })));
  return counts;
}
