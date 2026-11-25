import { DEFAULT_TENANT_ID } from '@line-crm/shared';

export const OPERATION_HEALTH_CHECK_KEYS = [
  'line_connection',
  'message_quota',
  'external_integrations',
  'webhook',
  'dispatch_jobs',
  'friend_change',
  'monitoring_heartbeat',
  'infra_canary',
  'credential_expiry',
] as const;

export type OperationHealthCheckKey = (typeof OPERATION_HEALTH_CHECK_KEYS)[number];
export type OperationHealthStatus = 'normal' | 'warning' | 'danger' | 'unknown';

export type OperationHealthResultInput = {
  checkKey: OperationHealthCheckKey;
  status: OperationHealthStatus;
  summary: string;
  value?: Record<string, unknown> | null;
  threshold?: Record<string, unknown> | null;
  source: string;
  observedAt: string;
};

export type OperationHealthResult = OperationHealthResultInput & { id: string; runId: string };

export type OperationHealthRun = {
  id: string;
  scopeKey: string;
  lineAccountId: string | null;
  windowStartedAt: string;
  source: 'scheduled' | 'manual';
  status: 'running' | 'completed' | 'failed';
  overallStatus: OperationHealthStatus;
  actorId: string | null;
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  results: OperationHealthResult[];
};

export type OperationAlertStatus = 'open' | 'acknowledged' | 'resolved';
export type OperationAlertAction = 'opened' | 'escalated' | 'acknowledged' | 'resolved' | 'reopened';

export type OperationAlertNotificationSummary = {
  queued: number;
  sending: number;
  sent: number;
  failed: number;
  unconfigured: number;
  total: number;
};

export type OperationAlertEvent = {
  id: string;
  alertId: string;
  lineAccountId: string;
  sourceRunId: string | null;
  action: OperationAlertAction;
  severity: Exclude<OperationHealthStatus, 'normal'>;
  summary: string;
  actorId: string | null;
  note: string | null;
  alertVersion: number;
  createdAt: string;
};

export type OperationAlert = {
  id: string;
  lineAccountId: string;
  checkKey: OperationHealthCheckKey;
  status: OperationAlertStatus;
  severity: Exclude<OperationHealthStatus, 'normal'>;
  summary: string;
  sourceRunId: string;
  firstDetectedAt: string;
  lastDetectedAt: string;
  acknowledgedAt: string | null;
  acknowledgedById: string | null;
  acknowledgementNote: string | null;
  resolvedAt: string | null;
  version: number;
  reopenedCount: number;
  createdAt: string;
  updatedAt: string;
  notification: OperationAlertNotificationSummary;
  events: OperationAlertEvent[];
};

export type OperationDispatcherHeartbeat = {
  jobName: string;
  lastStartedAt: string;
  lastCompletedAt: string | null;
  lastStatus: 'running' | 'succeeded' | 'failed';
  updatedAt: string;
};

type OperationDispatcherHeartbeatRow = {
  job_name: string;
  last_started_at: string;
  last_completed_at: string | null;
  last_status: 'running' | 'succeeded' | 'failed';
  updated_at: string;
};

function mapDispatcherHeartbeat(row: OperationDispatcherHeartbeatRow): OperationDispatcherHeartbeat {
  return {
    jobName: row.job_name,
    lastStartedAt: row.last_started_at,
    lastCompletedAt: row.last_completed_at,
    lastStatus: row.last_status,
    updatedAt: row.updated_at,
  };
}

export async function startOperationDispatcherHeartbeat(
  db: D1Database,
  jobName: string,
  observedAt = new Date().toISOString(),
): Promise<void> {
  await db.prepare(
    `INSERT INTO operation_dispatcher_heartbeats
       (job_name, last_started_at, last_completed_at, last_status, updated_at)
     VALUES (?, ?, NULL, 'running', ?)
     ON CONFLICT(job_name) DO UPDATE SET
       last_started_at = excluded.last_started_at,
       last_status = 'running',
       updated_at = excluded.updated_at`,
  ).bind(jobName, observedAt, observedAt).run();
}

export async function finishOperationDispatcherHeartbeat(
  db: D1Database,
  jobName: string,
  status: 'succeeded' | 'failed',
  observedAt = new Date().toISOString(),
  startedAt?: string,
): Promise<void> {
  await db.prepare(
    `UPDATE operation_dispatcher_heartbeats
        SET last_completed_at = ?, last_status = ?, updated_at = ?
      WHERE job_name = ? AND (? IS NULL OR last_started_at = ?)`,
  ).bind(observedAt, status, observedAt, jobName, startedAt ?? null, startedAt ?? null).run();
}

export async function listOperationDispatcherHeartbeats(
  db: D1Database,
): Promise<OperationDispatcherHeartbeat[]> {
  const rows = await db.prepare(
    `SELECT job_name, last_started_at, last_completed_at, last_status, updated_at
       FROM operation_dispatcher_heartbeats ORDER BY job_name`,
  ).all<OperationDispatcherHeartbeatRow>();
  return (rows.results ?? []).map(mapDispatcherHeartbeat);
}

type HealthRunRow = {
  id: string;
  scope_key: string;
  line_account_id: string | null;
  window_started_at: string;
  source: 'scheduled' | 'manual';
  status: 'running' | 'completed' | 'failed';
  overall_status: OperationHealthStatus;
  actor_id: string | null;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
};

type HealthResultRow = {
  id: string;
  run_id: string;
  check_key: OperationHealthCheckKey;
  status: OperationHealthStatus;
  summary: string;
  value_json: string | null;
  threshold_json: string | null;
  source: string;
  observed_at: string;
};

type OperationAlertRow = {
  id: string;
  line_account_id: string;
  check_key: OperationHealthCheckKey;
  status: OperationAlertStatus;
  severity: Exclude<OperationHealthStatus, 'normal'>;
  summary: string;
  source_run_id: string;
  first_detected_at: string;
  last_detected_at: string;
  acknowledged_at: string | null;
  acknowledged_by_id: string | null;
  acknowledgement_note: string | null;
  resolved_at: string | null;
  version: number;
  reopened_count: number;
  created_at: string;
  updated_at: string;
};

type OperationAlertEventRow = {
  id: string;
  alert_id: string;
  line_account_id: string;
  source_run_id: string | null;
  action: OperationAlertAction;
  severity: Exclude<OperationHealthStatus, 'normal'>;
  summary: string;
  actor_id: string | null;
  note: string | null;
  alert_version: number;
  notification_enqueued_at?: string | null;
  notification_recipient_count?: number;
  notification_missing_contact_count?: number;
  created_at: string;
};

function mapOperationAlertEvent(row: OperationAlertEventRow): OperationAlertEvent {
  return {
    id: row.id,
    alertId: row.alert_id,
    lineAccountId: row.line_account_id,
    sourceRunId: row.source_run_id,
    action: row.action,
    severity: row.severity,
    summary: row.summary,
    actorId: row.actor_id,
    note: row.note,
    alertVersion: Number(row.alert_version),
    createdAt: row.created_at,
  };
}

function mapOperationAlert(
  row: OperationAlertRow,
  notification: OperationAlertNotificationSummary,
  events: OperationAlertEvent[],
): OperationAlert {
  return {
    id: row.id,
    lineAccountId: row.line_account_id,
    checkKey: row.check_key,
    status: row.status,
    severity: row.severity,
    summary: row.summary,
    sourceRunId: row.source_run_id,
    firstDetectedAt: row.first_detected_at,
    lastDetectedAt: row.last_detected_at,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedById: row.acknowledged_by_id,
    acknowledgementNote: row.acknowledgement_note,
    resolvedAt: row.resolved_at,
    version: Number(row.version),
    reopenedCount: Number(row.reopened_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    notification,
    events,
  };
}

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function mapHealthResult(row: HealthResultRow): OperationHealthResult {
  return {
    id: row.id,
    runId: row.run_id,
    checkKey: row.check_key,
    status: row.status,
    summary: row.summary,
    value: parseObject(row.value_json),
    threshold: parseObject(row.threshold_json),
    source: row.source,
    observedAt: row.observed_at,
  };
}

async function mapHealthRun(db: D1Database, row: HealthRunRow): Promise<OperationHealthRun> {
  const resultRows = await db.prepare(
    'SELECT * FROM operation_health_results WHERE run_id = ? ORDER BY check_key',
  ).bind(row.id).all<HealthResultRow>();
  return {
    id: row.id,
    scopeKey: row.scope_key,
    lineAccountId: row.line_account_id,
    windowStartedAt: row.window_started_at,
    source: row.source,
    status: row.status,
    overallStatus: row.overall_status,
    actorId: row.actor_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorMessage: row.error_message,
    results: (resultRows.results ?? []).map(mapHealthResult),
  };
}

export function operationHealthWindow(now = new Date()): string {
  const windowMs = Math.floor(now.getTime() / 300_000) * 300_000;
  return new Date(windowMs).toISOString();
}

export async function startOperationHealthRun(
  db: D1Database,
  input: { lineAccountId: string; source: 'scheduled' | 'manual'; actorId?: string | null; now?: string },
): Promise<{ created: boolean; run: OperationHealthRun }> {
  const now = input.now ?? new Date().toISOString();
  const windowStartedAt = operationHealthWindow(new Date(now));
  const id = crypto.randomUUID();
  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO operation_health_runs
       (id, scope_key, line_account_id, window_started_at, source, status,
        overall_status, actor_id, started_at)
     VALUES (?, ?, ?, ?, ?, 'running', 'unknown', ?, ?)`,
  ).bind(id, input.lineAccountId, input.lineAccountId, windowStartedAt,
    input.source, input.actorId ?? null, now).run();
  const row = Number(inserted.meta?.changes ?? 0) === 1
    ? await db.prepare('SELECT * FROM operation_health_runs WHERE id = ?').bind(id).first<HealthRunRow>()
    : await db.prepare(
      'SELECT * FROM operation_health_runs WHERE scope_key = ? AND window_started_at = ?',
    ).bind(input.lineAccountId, windowStartedAt).first<HealthRunRow>();
  if (!row) throw new Error('operation_health_run_missing');
  return { created: Number(inserted.meta?.changes ?? 0) === 1, run: await mapHealthRun(db, row) };
}

function overallHealthStatus(results: OperationHealthResultInput[]): OperationHealthStatus {
  for (const status of ['danger', 'warning', 'unknown'] as const) {
    if (results.some((result) => result.status === status)) return status;
  }
  return 'normal';
}

export async function completeOperationHealthRun(
  db: D1Database,
  runId: string,
  results: OperationHealthResultInput[],
  completedAt = new Date().toISOString(),
): Promise<OperationHealthRun> {
  const statements = results.map((result) => db.prepare(
    `INSERT OR REPLACE INTO operation_health_results
       (id, run_id, check_key, status, summary, value_json, threshold_json, source, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), runId, result.checkKey, result.status, result.summary,
    result.value ? JSON.stringify(result.value) : null,
    result.threshold ? JSON.stringify(result.threshold) : null,
    result.source, result.observedAt,
  ));
  statements.push(db.prepare(
    `UPDATE operation_health_runs
        SET status = 'completed', overall_status = ?, completed_at = ?, error_message = NULL
      WHERE id = ?`,
  ).bind(overallHealthStatus(results), completedAt, runId));
  await db.batch(statements);
  const row = await db.prepare('SELECT * FROM operation_health_runs WHERE id = ?')
    .bind(runId).first<HealthRunRow>();
  if (!row) throw new Error('operation_health_run_missing');
  return mapHealthRun(db, row);
}

export async function failOperationHealthRun(
  db: D1Database,
  runId: string,
  errorMessage: string,
  completedAt = new Date().toISOString(),
): Promise<void> {
  await db.prepare(
    `UPDATE operation_health_runs
        SET status = 'failed', overall_status = 'unknown', error_message = ?, completed_at = ?
      WHERE id = ?`,
  ).bind(errorMessage.slice(0, 500), completedAt, runId).run();
}

/**
 * 結果保存の失敗で failed になった実行枠を、同じ5分枠の押し直しで再実行する。
 *
 * failed の行が枠を塞いだままだと、再送は failed 行を重複扱いで返すだけで
 * 確認処理が走らない。running に戻して呼び出し側が確認・保存をやり直せる
 * ようにする。completed・running の行には触らない。並列の押し直しで
 * 先に誰かが開け直したときは false を返し、呼び出し側は重複として返す。
 */
export async function reopenFailedOperationHealthRun(
  db: D1Database,
  runId: string,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE operation_health_runs
        SET status = 'running', overall_status = 'unknown', error_message = NULL, completed_at = NULL
      WHERE id = ? AND status = 'failed'`,
  ).bind(runId).run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function getLatestOperationHealthRun(
  db: D1Database,
  lineAccountId: string,
): Promise<OperationHealthRun | null> {
  const row = await db.prepare(
    `SELECT * FROM operation_health_runs
      WHERE scope_key = ? ORDER BY started_at DESC, id DESC LIMIT 1`,
  ).bind(lineAccountId).first<HealthRunRow>();
  return row ? mapHealthRun(db, row) : null;
}

function alertSeverity(status: OperationHealthStatus): Exclude<OperationHealthStatus, 'normal'> | null {
  return status === 'normal' ? null : status;
}

function alertSeverityRank(status: Exclude<OperationHealthStatus, 'normal'>): number {
  return status === 'danger' ? 3 : status === 'warning' ? 2 : 1;
}

async function recordOperationAlertEvent(
  db: D1Database,
  input: {
    alert: OperationAlertRow;
    action: OperationAlertAction;
    sourceRunId?: string | null;
    actorId?: string | null;
    note?: string | null;
    now: string;
  },
): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO operation_alert_events
       (id, alert_id, line_account_id, source_run_id, action, severity, summary,
        actor_id, note, alert_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), input.alert.id, input.alert.line_account_id, input.sourceRunId ?? null,
    input.action, input.alert.severity, input.alert.summary, input.actorId ?? null,
    input.note ?? null, input.alert.version, input.now,
  ).run();
}

/**
 * 異常を account + check_key の1行に集約する。5分ごとの同じ状態は最後の観測だけを
 * 更新し、初回・悪化・解消・再発のときだけeventを足す。eventは通知outboxの親でもある。
 */
export async function reconcileOperationHealthAlerts(
  db: D1Database,
  input: { lineAccountId: string; runId: string; results: OperationHealthResult[]; now?: string },
): Promise<void> {
  const now = input.now ?? new Date().toISOString();
  for (const result of input.results) {
    const observed = result.observedAt || now;
    const nextSeverity = alertSeverity(result.status);
    let current = await db.prepare(
      'SELECT * FROM operation_alerts WHERE line_account_id = ? AND check_key = ?',
    ).bind(input.lineAccountId, result.checkKey).first<OperationAlertRow>();

    if (!nextSeverity) {
      if (!current || current.status === 'resolved') continue;
      // 1回正常になっただけで解消にすると、たまに失敗する不調で「解消→再発」を
      // 5分ごとに繰り返してしまう。前回の確認も正常だったときに解消を確定する
      // （前回の記録が無いときは、そのまま解消にする）。
      const previous = await db.prepare(
        `SELECT r.status
           FROM operation_health_results r
           JOIN operation_health_runs h ON h.id = r.run_id
          WHERE h.scope_key = ? AND r.check_key = ? AND r.run_id != ?
          ORDER BY r.observed_at DESC, r.id DESC
          LIMIT 1`,
      ).bind(input.lineAccountId, result.checkKey, input.runId).first<{ status: string }>();
      if (previous && previous.status !== 'normal') continue;
      const changed = await db.prepare(
        `UPDATE operation_alerts
            SET status = 'resolved', source_run_id = ?, last_detected_at = ?, resolved_at = ?,
                version = version + 1, updated_at = ?
          WHERE id = ? AND version = ?`,
      ).bind(input.runId, observed, now, now, current.id, current.version).run();
      if (Number(changed.meta?.changes ?? 0) !== 1) continue;
      current = await db.prepare('SELECT * FROM operation_alerts WHERE id = ?')
        .bind(current.id).first<OperationAlertRow>();
      if (current) await recordOperationAlertEvent(db, { alert: current, action: 'resolved', sourceRunId: input.runId, now });
      continue;
    }

    if (!current) {
      const id = crypto.randomUUID();
      await db.prepare(
        `INSERT OR IGNORE INTO operation_alerts
           (id, line_account_id, check_key, status, severity, summary, source_run_id,
            first_detected_at, last_detected_at, version, reopened_count, created_at, updated_at)
         VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
      ).bind(
        id, input.lineAccountId, result.checkKey, nextSeverity, result.summary.slice(0, 500), input.runId,
        observed, observed, now, now,
      ).run();
      current = await db.prepare(
        'SELECT * FROM operation_alerts WHERE line_account_id = ? AND check_key = ?',
      ).bind(input.lineAccountId, result.checkKey).first<OperationAlertRow>();
      if (!current) throw new Error('operation_alert_missing');
      if (current.id === id) {
        await recordOperationAlertEvent(db, { alert: current, action: 'opened', sourceRunId: input.runId, now });
      }
      continue;
    }

    if (current.status === 'resolved') {
      const changed = await db.prepare(
        `UPDATE operation_alerts
            SET status = 'open', severity = ?, summary = ?, source_run_id = ?,
                last_detected_at = ?, acknowledged_at = NULL, acknowledged_by_id = NULL,
                acknowledgement_note = NULL, resolved_at = NULL, version = version + 1,
                reopened_count = reopened_count + 1, updated_at = ?
          WHERE id = ? AND version = ?`,
      ).bind(nextSeverity, result.summary.slice(0, 500), input.runId, observed, now, current.id, current.version).run();
      if (Number(changed.meta?.changes ?? 0) !== 1) continue;
      current = await db.prepare('SELECT * FROM operation_alerts WHERE id = ?')
        .bind(current.id).first<OperationAlertRow>();
      if (current) await recordOperationAlertEvent(db, { alert: current, action: 'reopened', sourceRunId: input.runId, now });
      continue;
    }

    // 配信枠が一時的に読めなくても、確認済みの注意・エラーを未確認へ下げない。
    // 次回同じ状態に戻っただけで受領解除や再通知が起きるのを防ぐ。
    if (result.checkKey === 'message_quota' && nextSeverity === 'unknown'
      && (current.severity === 'warning' || current.severity === 'danger')) continue;

    const escalated = alertSeverityRank(nextSeverity) > alertSeverityRank(current.severity);
    const changed = await db.prepare(
      `UPDATE operation_alerts
          SET status = CASE WHEN ? THEN 'open' ELSE status END,
              severity = ?, summary = ?, source_run_id = ?, last_detected_at = ?,
              acknowledged_at = CASE WHEN ? THEN NULL ELSE acknowledged_at END,
              acknowledged_by_id = CASE WHEN ? THEN NULL ELSE acknowledged_by_id END,
              acknowledgement_note = CASE WHEN ? THEN NULL ELSE acknowledgement_note END,
              version = version + CASE WHEN ? THEN 1 ELSE 0 END, updated_at = ?
        WHERE id = ? AND version = ?`,
    ).bind(
      escalated ? 1 : 0, nextSeverity, result.summary.slice(0, 500), input.runId, observed,
      escalated ? 1 : 0, escalated ? 1 : 0, escalated ? 1 : 0, escalated ? 1 : 0,
      now, current.id, current.version,
    ).run();
    if (Number(changed.meta?.changes ?? 0) !== 1 || !escalated) continue;
    current = await db.prepare('SELECT * FROM operation_alerts WHERE id = ?')
      .bind(current.id).first<OperationAlertRow>();
    if (current) await recordOperationAlertEvent(db, { alert: current, action: 'escalated', sourceRunId: input.runId, now });
  }
}

async function operationAlertNotificationSummary(
  db: D1Database,
  alertId: string,
): Promise<OperationAlertNotificationSummary> {
  const row = await db.prepare(
    `SELECT
       (SELECT SUM(CASE WHEN o.status = 'queued' THEN 1 ELSE 0 END)
          FROM operation_alert_notification_outbox o JOIN operation_alert_events e ON e.id = o.event_id
         WHERE e.alert_id = ?) AS queued,
       (SELECT SUM(CASE WHEN o.status = 'sending' THEN 1 ELSE 0 END)
          FROM operation_alert_notification_outbox o JOIN operation_alert_events e ON e.id = o.event_id
         WHERE e.alert_id = ?) AS sending,
       (SELECT SUM(CASE WHEN o.status = 'sent' THEN 1 ELSE 0 END)
          FROM operation_alert_notification_outbox o JOIN operation_alert_events e ON e.id = o.event_id
         WHERE e.alert_id = ?) AS sent,
       (SELECT SUM(CASE WHEN o.status = 'failed' THEN 1 ELSE 0 END)
          FROM operation_alert_notification_outbox o JOIN operation_alert_events e ON e.id = o.event_id
         WHERE e.alert_id = ?) AS failed,
       (SELECT COUNT(o.id)
          FROM operation_alert_notification_outbox o JOIN operation_alert_events e ON e.id = o.event_id
         WHERE e.alert_id = ?) AS total,
       (SELECT SUM(CASE
          WHEN e.notification_enqueued_at IS NULL THEN 0
          WHEN e.notification_recipient_count = 0 THEN 1
          ELSE e.notification_missing_contact_count END)
          FROM operation_alert_events e WHERE e.alert_id = ?) AS unconfigured`,
  ).bind(alertId, alertId, alertId, alertId, alertId, alertId).first<Record<string, number | null>>();
  return {
    queued: Number(row?.queued ?? 0), sending: Number(row?.sending ?? 0),
    sent: Number(row?.sent ?? 0), failed: Number(row?.failed ?? 0),
    unconfigured: Number(row?.unconfigured ?? 0), total: Number(row?.total ?? 0),
  };
}

async function operationAlertEvents(db: D1Database, alertId: string): Promise<OperationAlertEvent[]> {
  const rows = await db.prepare(
    `SELECT id, alert_id, line_account_id, source_run_id, action, severity, summary,
            actor_id, note, alert_version, created_at
       FROM operation_alert_events WHERE alert_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 20`,
  ).bind(alertId).all<OperationAlertEventRow>();
  return (rows.results ?? []).map(mapOperationAlertEvent);
}

export async function listOperationAlerts(
  db: D1Database,
  input: { lineAccountId: string; includeResolved?: boolean; limit?: number },
): Promise<OperationAlert[]> {
  const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 50), 100));
  const rows = await db.prepare(
    `SELECT * FROM operation_alerts
      WHERE line_account_id = ? AND (? = 1 OR status != 'resolved')
      ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END,
               updated_at DESC, id DESC LIMIT ?`,
  ).bind(input.lineAccountId, input.includeResolved ? 1 : 0, limit).all<OperationAlertRow>();
  const selected = `
    SELECT id FROM operation_alerts
     WHERE line_account_id = ? AND (? = 1 OR status != 'resolved')
     ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END,
              updated_at DESC, id DESC LIMIT ?`;
  const summaries = await db.prepare(
    `WITH selected_alerts AS (${selected}),
      outbox_totals AS (
        SELECT e.alert_id,
               SUM(CASE WHEN o.status = 'queued' THEN 1 ELSE 0 END) AS queued,
               SUM(CASE WHEN o.status = 'sending' THEN 1 ELSE 0 END) AS sending,
               SUM(CASE WHEN o.status = 'sent' THEN 1 ELSE 0 END) AS sent,
               SUM(CASE WHEN o.status = 'failed' THEN 1 ELSE 0 END) AS failed,
               COUNT(o.id) AS total
          FROM operation_alert_events e
          JOIN operation_alert_notification_outbox o ON o.event_id = e.id
         JOIN selected_alerts s ON s.id = e.alert_id
         GROUP BY e.alert_id
      ),
      gap_totals AS (
        SELECT e.alert_id,
               SUM(CASE
                 WHEN e.notification_enqueued_at IS NULL THEN 0
                 WHEN e.notification_recipient_count = 0 THEN 1
                 ELSE e.notification_missing_contact_count END) AS unconfigured
          FROM operation_alert_events e
          JOIN selected_alerts s ON s.id = e.alert_id
         GROUP BY e.alert_id
      )
      SELECT s.id AS alert_id,
             COALESCE(o.queued, 0) AS queued, COALESCE(o.sending, 0) AS sending,
             COALESCE(o.sent, 0) AS sent, COALESCE(o.failed, 0) AS failed,
             COALESCE(g.unconfigured, 0) AS unconfigured, COALESCE(o.total, 0) AS total
        FROM selected_alerts s
        LEFT JOIN outbox_totals o ON o.alert_id = s.id
        LEFT JOIN gap_totals g ON g.alert_id = s.id`,
  ).bind(input.lineAccountId, input.includeResolved ? 1 : 0, limit).all<{
    alert_id: string; queued: number; sending: number; sent: number;
    failed: number; unconfigured: number; total: number;
  }>();
  const eventRows = await db.prepare(
    `WITH selected_alerts AS (${selected}),
      ranked_events AS (
        SELECT e.*,
               ROW_NUMBER() OVER (PARTITION BY e.alert_id ORDER BY e.created_at DESC, e.id DESC) AS event_rank
          FROM operation_alert_events e
          JOIN selected_alerts s ON s.id = e.alert_id
      )
      SELECT id, alert_id, line_account_id, source_run_id, action, severity, summary,
             actor_id, note, alert_version, created_at
        FROM ranked_events WHERE event_rank <= 20
       ORDER BY alert_id, created_at DESC, id DESC`,
  ).bind(input.lineAccountId, input.includeResolved ? 1 : 0, limit).all<OperationAlertEventRow>();
  const summaryByAlert = new Map((summaries.results ?? []).map((row) => [row.alert_id, {
    queued: Number(row.queued), sending: Number(row.sending), sent: Number(row.sent),
    failed: Number(row.failed), unconfigured: Number(row.unconfigured), total: Number(row.total),
  }]));
  const eventsByAlert = new Map<string, OperationAlertEvent[]>();
  for (const row of eventRows.results ?? []) {
    const events = eventsByAlert.get(row.alert_id) ?? [];
    events.push(mapOperationAlertEvent(row));
    eventsByAlert.set(row.alert_id, events);
  }
  const emptySummary: OperationAlertNotificationSummary = {
    queued: 0, sending: 0, sent: 0, failed: 0, unconfigured: 0, total: 0,
  };
  return (rows.results ?? []).map((row) => mapOperationAlert(
    row, summaryByAlert.get(row.id) ?? emptySummary, eventsByAlert.get(row.id) ?? [],
  ));
}

export async function getOperationAlert(
  db: D1Database,
  id: string,
  lineAccountId?: string,
): Promise<OperationAlert | null> {
  const row = lineAccountId === undefined
    ? await db.prepare('SELECT * FROM operation_alerts WHERE id = ?')
      .bind(id).first<OperationAlertRow>()
    : await db.prepare('SELECT * FROM operation_alerts WHERE id = ? AND line_account_id = ?')
      .bind(id, lineAccountId).first<OperationAlertRow>();
  return row ? mapOperationAlert(row, await operationAlertNotificationSummary(db, row.id), await operationAlertEvents(db, row.id)) : null;
}

export async function acknowledgeOperationAlert(
  db: D1Database,
  input: { id: string; lineAccountId: string; actorId: string; expectedVersion: number; note?: string | null; now?: string },
): Promise<{ status: 'changed' | 'duplicate' | 'conflict' | 'not_found'; alert: OperationAlert | null }> {
  const now = input.now ?? new Date().toISOString();
  const note = input.note?.trim().slice(0, 500) || null;
  const changed = await db.prepare(
    `UPDATE operation_alerts
        SET status = 'acknowledged', acknowledged_at = ?, acknowledged_by_id = ?, acknowledgement_note = ?,
            version = version + 1, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND status = 'open' AND version = ?`,
  ).bind(now, input.actorId, note, now, input.id, input.lineAccountId, input.expectedVersion).run();
  let row = await db.prepare('SELECT * FROM operation_alerts WHERE id = ? AND line_account_id = ?')
    .bind(input.id, input.lineAccountId).first<OperationAlertRow>();
  if (!row) return { status: 'not_found', alert: null };
  if (Number(changed.meta?.changes ?? 0) !== 1) {
    const duplicate = row.status === 'acknowledged'
      && row.version === input.expectedVersion
      && row.acknowledged_by_id === input.actorId
      && row.acknowledgement_note === note;
    if (duplicate) return { status: 'duplicate', alert: await getOperationAlert(db, row.id) };
    /*
     * 受領の状態更新までは成功し、受領イベントの保存だけ失敗したときの
     * 再送を補う。行は acknowledged・版が1つ進んだまま、イベントが無い状態で
     * 同じ版の再送は版競合になる。同じ担当者・同じ内容で版がちょうど1つ
     * 進んでおり、対応する受領イベントが無いときだけ、欠けたイベントを足して
     * 通知準備まで揃え、再送として返す。イベントがある通常の再送は従来どおり
     * 競合にし、別人の更新の競合判定は弱めない。
     */
    const orphaned = row.status === 'acknowledged'
      && row.version === input.expectedVersion + 1
      && row.acknowledged_by_id === input.actorId
      && row.acknowledgement_note === note
      && await operationAlertAcknowledgedEventMissing(db, row.id, row.version);
    if (orphaned) {
      await recordOperationAlertEvent(db, { alert: row, action: 'acknowledged', actorId: input.actorId, note, now });
      await enqueuePendingOperationAlertNotifications(db, { lineAccountId: input.lineAccountId });
      return { status: 'duplicate', alert: await getOperationAlert(db, row.id) };
    }
    return { status: 'conflict', alert: await getOperationAlert(db, row.id) };
  }
  await recordOperationAlertEvent(db, { alert: row, action: 'acknowledged', actorId: input.actorId, note, now });
  return { status: 'changed', alert: await getOperationAlert(db, row.id) };
}

/** 版に対応する受領イベントが無いときだけ true。 repair の二重書きを防ぐ。 */
async function operationAlertAcknowledgedEventMissing(
  db: D1Database,
  alertId: string,
  alertVersion: number,
): Promise<boolean> {
  const hit = await db.prepare(
    `SELECT 1 FROM operation_alert_events
      WHERE alert_id = ? AND action = 'acknowledged' AND alert_version = ?
      LIMIT 1`,
  ).bind(alertId, alertVersion).first();
  return hit === null;
}

/**
 * 未enqueueのeventだけに、同一tenant・対象accountを見られるowner/adminの通知行を積む。
 * 同じalertの同じactionを同じ担当者・同じ経路へ一定時間内に重ねて送らない。
 * 解消の直後の再発（ばたつき）もまとめて1通にする。表の追加は要らない。
 */
export const OPERATION_ALERT_NOTIFICATION_DEDUP_MS = 30 * 60_000;

async function operationAlertNotifiedRecently(
  db: D1Database,
  input: { alertId: string; action: string; staffId: string; channel: 'line' | 'email'; since: string },
): Promise<boolean> {
  const hit = await db.prepare(
    `SELECT 1 FROM operation_alert_notification_outbox o
       JOIN operation_alert_events e ON e.id = o.event_id
      WHERE e.alert_id = ? AND e.action = ? AND o.staff_id = ? AND o.channel = ?
        AND o.created_at >= ? AND o.status IN ('queued', 'sending', 'sent')
      LIMIT 1`,
  ).bind(input.alertId, input.action, input.staffId, input.channel, input.since).first();
  return hit !== null;
}

async function operationAlertResolvedRecently(
  db: D1Database,
  input: { alertId: string; eventId: string; createdAt: string; since: string },
): Promise<boolean> {
  const hit = await db.prepare(
    `SELECT 1 FROM operation_alert_events
      WHERE alert_id = ? AND action = 'resolved' AND id != ?
        AND created_at >= ? AND created_at <= ?
      LIMIT 1`,
  ).bind(input.alertId, input.eventId, input.since, input.createdAt).first();
  return hit !== null;
}

/** この異常について、過去にLINE・メールの通知行を積んだことがあるか。 */
async function operationAlertEverNotified(db: D1Database, alertId: string): Promise<boolean> {
  const hit = await db.prepare(
    `SELECT 1
       FROM operation_alert_notification_outbox o
       JOIN operation_alert_events e ON e.id = o.event_id
      WHERE e.alert_id = ?
      LIMIT 1`,
  ).bind(alertId).first();
  return hit !== null;
}

/** 未enqueueのeventだけに、同一tenant・対象accountを見られるowner/adminの通知行を積む。 */
export async function enqueuePendingOperationAlertNotifications(
  db: D1Database,
  input: { lineAccountId?: string; now?: string },
): Promise<void> {
  const now = input.now ?? new Date().toISOString();
  const since = new Date(Date.parse(now) - OPERATION_ALERT_NOTIFICATION_DEDUP_MS).toISOString();
  const events = await db.prepare(
    `SELECT e.id, e.line_account_id, e.alert_id, e.action, e.severity, e.created_at
       FROM operation_alert_events e
      WHERE e.notification_enqueued_at IS NULL
        AND (? IS NULL OR e.line_account_id = ?)
      ORDER BY e.created_at, e.id LIMIT 100`,
  ).bind(input.lineAccountId ?? null, input.lineAccountId ?? null).all<{
    id: string; line_account_id: string; alert_id: string; action: string;
    severity: string; created_at: string;
  }>();
  for (const event of events.results ?? []) {
    const recipients = await db.prepare(
      `SELECT sm.id, sm.email, sm.line_user_id, sm.notification_preferences
         FROM staff_members sm
         JOIN line_accounts la ON la.id = ?
        WHERE sm.is_active = 1 AND sm.role IN ('owner', 'admin')
          AND COALESCE(sm.tenant_id, ?) = COALESCE(la.tenant_id, ?)
          AND (
            COALESCE(sm.account_scope, 'all') = 'all'
            OR EXISTS (
              SELECT 1 FROM staff_account_scopes sas
               WHERE sas.staff_id = sm.id AND sas.line_account_id = ?
            )
          )
        ORDER BY sm.id`,
    ).bind(
      event.line_account_id, DEFAULT_TENANT_ID, DEFAULT_TENANT_ID, event.line_account_id,
    ).all<{ id: string; email: string | null; line_user_id: string | null; notification_preferences: string }>();
    // 解消の直後の再発は、解消の知らせとまとめて1通にする。
    const flapSuppressed = event.action === 'reopened'
      && await operationAlertResolvedRecently(db, {
        alertId: event.alert_id, eventId: event.id, createdAt: event.created_at, since,
      });
    // 「未確認」は、こちらの確認そのものができなかった状態。画面には残すが、
    // LINE・メールでは知らせない（確認できないたびに知らせが鳴ってしまう）。
    const unknownOnly = event.severity === 'unknown';
    // 知らせていない異常の「解消」「受領」は知らせない。鳴っていない物が止まった
    // お知らせだけが届くのを防ぐ。
    const unnotifiedFollowUp = (event.action === 'resolved' || event.action === 'acknowledged')
      && !(await operationAlertEverNotified(db, event.alert_id));
    const suppressed = flapSuppressed || unknownOnly || unnotifiedFollowUp;
    const statements: D1PreparedStatement[] = [];
    let missingContactCount = 0;
    for (const recipient of recipients.results ?? []) {
      let preferences: Record<string, { line?: boolean; email?: boolean }> = {};
      try {
        preferences = JSON.parse(recipient.notification_preferences) as typeof preferences;
      } catch { /* 旧データや破損値は従来の既定値を使う */ }
      const operations = preferences?.operations;
      if (!recipient.line_user_id && !recipient.email) missingContactCount += 1;
      if (recipient.line_user_id && operations?.line !== false && !suppressed
        && !(await operationAlertNotifiedRecently(db, {
          alertId: event.alert_id, action: event.action, staffId: recipient.id, channel: 'line', since,
        }))) statements.push(db.prepare(
        `INSERT OR IGNORE INTO operation_alert_notification_outbox
           (id, event_id, line_account_id, staff_id, channel, status, attempt_count,
            next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'line', 'queued', 0, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), event.id, event.line_account_id, recipient.id, now, now, now));
      if (recipient.email && operations?.email !== false && !suppressed
        && !(await operationAlertNotifiedRecently(db, {
          alertId: event.alert_id, action: event.action, staffId: recipient.id, channel: 'email', since,
        }))) statements.push(db.prepare(
        `INSERT OR IGNORE INTO operation_alert_notification_outbox
           (id, event_id, line_account_id, staff_id, channel, status, attempt_count,
            next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'email', 'queued', 0, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), event.id, event.line_account_id, recipient.id, now, now, now));
    }
    statements.push(db.prepare(
      `UPDATE operation_alert_events
          SET notification_enqueued_at = ?, notification_recipient_count = ?,
              notification_missing_contact_count = ?
        WHERE id = ? AND notification_enqueued_at IS NULL`,
    ).bind(now, (recipients.results ?? []).length, missingContactCount, event.id));
    await db.batch(statements);
  }
}

export async function retryOperationAlertNotifications(
  db: D1Database,
  input: { alertId: string; lineAccountId: string; now?: string },
): Promise<number> {
  const now = input.now ?? new Date().toISOString();
  const results = await db.batch([
    db.prepare(
      `UPDATE operation_alert_notification_outbox
          SET status = 'queued', next_attempt_at = ?, last_error = NULL, updated_at = ?
        WHERE status = 'failed' AND event_id IN (
          SELECT id FROM operation_alert_events WHERE alert_id = ? AND line_account_id = ?
        )`,
    ).bind(now, now, input.alertId, input.lineAccountId),
    db.prepare(
      `UPDATE operation_alert_events
          SET notification_enqueued_at = NULL, notification_recipient_count = 0,
              notification_missing_contact_count = 0
        WHERE alert_id = ? AND line_account_id = ? AND notification_enqueued_at IS NOT NULL
          AND (notification_recipient_count = 0 OR notification_missing_contact_count > 0)`,
    ).bind(input.alertId, input.lineAccountId),
  ]);
  return Number(results[0]?.meta?.changes ?? 0) + Number(results[1]?.meta?.changes ?? 0);
}

export async function createStepUpGrant(
  db: D1Database,
  input: {
    tokenHash: string;
    staffId: string;
    purpose: string;
    expiresAt: string;
    now?: string;
    totpStep?: number;
    /** 発行したセッションの指紋。無いとき（APIキー経路）は結び付けない。 */
    sessionTokenHash?: string | null;
    /** 発行時の権限の版。権限の更新で進むと確認票は使えない。 */
    issuedPolicyVersion?: number | null;
  },
): Promise<boolean> {
  const now = input.now ?? new Date().toISOString();
  const sessionTokenHash = input.sessionTokenHash ?? null;
  const issuedPolicyVersion = input.issuedPolicyVersion ?? null;
  if (input.totpStep === undefined) {
    await db.prepare(
      `INSERT INTO auth_step_up_grants
         (token_hash, staff_id, purpose, expires_at, created_at, session_token_hash, issued_policy_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(input.tokenHash, input.staffId, input.purpose, input.expiresAt, now, sessionTokenHash, issuedPolicyVersion).run();
    return true;
  }

  const results = await db.batch([
    db.prepare(
      `UPDATE staff_members
          SET totp_last_used_step = ?, updated_at = ?
        WHERE id = ? AND (totp_last_used_step IS NULL OR totp_last_used_step < ?)`,
    ).bind(input.totpStep, now, input.staffId, input.totpStep),
    // D1 batchは同じtransaction・接続で順に実行される。changesが直前の
    // claim成功を示すときだけgrantを保存し、並列の同一コードを増殖させない。
    db.prepare(
      `INSERT INTO auth_step_up_grants
         (token_hash, staff_id, purpose, expires_at, created_at, session_token_hash, issued_policy_version)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
    ).bind(input.tokenHash, input.staffId, input.purpose, input.expiresAt, now, sessionTokenHash, issuedPolicyVersion),
    db.prepare(
      `DELETE FROM auth_step_up_attempts
        WHERE staff_id = ?
          AND EXISTS (SELECT 1 FROM auth_step_up_grants WHERE token_hash = ?)`,
    ).bind(input.staffId, input.tokenHash),
  ]);
  return Number(results[1]?.meta?.changes ?? 0) === 1;
}

const STEP_UP_MAX_ATTEMPTS = 5;
const STEP_UP_ATTEMPT_WINDOW_MS = 10 * 60_000;

export type StepUpAttemptReservation = {
  attempts: number;
  maxAttempts: number;
  windowStartedAt: string;
};

/**
 * TOTPを検証する前に、職員単位の試行枠を原子的に1つ確保する。
 *
 * SELECT後にUPDATEする形だと、並列リクエストが同じ回数を見て上限を
 * すり抜ける。UPSERTのWHEREで、期限内かつ上限到達済みの更新を拒否する。
 */
export async function reserveStepUpAttempt(
  db: D1Database,
  staffId: string,
  now = new Date().toISOString(),
): Promise<StepUpAttemptReservation | null> {
  const windowCutoff = new Date(Date.parse(now) - STEP_UP_ATTEMPT_WINDOW_MS).toISOString();
  const row = await db.prepare(
    `INSERT INTO auth_step_up_attempts
       (staff_id, attempts, window_started_at, updated_at)
     VALUES (?, 1, ?, ?)
     ON CONFLICT(staff_id) DO UPDATE SET
       attempts = CASE
         WHEN auth_step_up_attempts.window_started_at <= ? THEN 1
         ELSE auth_step_up_attempts.attempts + 1
       END,
       window_started_at = CASE
         WHEN auth_step_up_attempts.window_started_at <= ? THEN excluded.window_started_at
         ELSE auth_step_up_attempts.window_started_at
       END,
       updated_at = excluded.updated_at
     WHERE auth_step_up_attempts.window_started_at <= ?
        OR auth_step_up_attempts.attempts < ?
     RETURNING attempts, window_started_at`,
  ).bind(
    staffId, now, now,
    windowCutoff, windowCutoff, windowCutoff, STEP_UP_MAX_ATTEMPTS,
  ).first<{ attempts: number; window_started_at: string }>();
  return row ? {
    attempts: Number(row.attempts),
    maxAttempts: STEP_UP_MAX_ATTEMPTS,
    windowStartedAt: row.window_started_at,
  } : null;
}

/**
 * 入力上限で止めたとき、次に試せるまでの秒数。
 *
 * 10分窓の開始から数える。行が無い・読めないときは窓全体（10分）を返す。
 * 画面は「約N分待ってからやり直してください」と出す。
 */
export async function stepUpAttemptRetryAfterSeconds(
  db: D1Database,
  staffId: string,
  now = new Date().toISOString(),
): Promise<number> {
  const windowSeconds = Math.round(STEP_UP_ATTEMPT_WINDOW_MS / 1000);
  try {
    const row = await db.prepare(
      'SELECT window_started_at FROM auth_step_up_attempts WHERE staff_id = ?',
    ).bind(staffId).first<{ window_started_at: string }>();
    if (!row) return windowSeconds;
    const resetAt = Date.parse(row.window_started_at) + STEP_UP_ATTEMPT_WINDOW_MS;
    return Math.max(1, Math.ceil((resetAt - Date.parse(now)) / 1000));
  } catch {
    return windowSeconds;
  }
}

/** 二段階認証の初回設定確認について、10分間に5回までの試行枠を確保する。 */
export async function reserveTwoFactorSetupAttempt(
  db: D1Database,
  staffId: string,
  now = new Date().toISOString(),
): Promise<StepUpAttemptReservation | null> {
  const windowCutoff = new Date(Date.parse(now) - STEP_UP_ATTEMPT_WINDOW_MS).toISOString();
  const row = await db.prepare(
    `INSERT INTO staff_two_factor_setup_attempts
       (staff_id, attempts, window_started_at, updated_at)
     VALUES (?, 1, ?, ?)
     ON CONFLICT(staff_id) DO UPDATE SET
       attempts = CASE
         WHEN staff_two_factor_setup_attempts.window_started_at <= ? THEN 1
         ELSE staff_two_factor_setup_attempts.attempts + 1
       END,
       window_started_at = CASE
         WHEN staff_two_factor_setup_attempts.window_started_at <= ? THEN excluded.window_started_at
         ELSE staff_two_factor_setup_attempts.window_started_at
       END,
       updated_at = excluded.updated_at
     WHERE staff_two_factor_setup_attempts.window_started_at <= ?
        OR staff_two_factor_setup_attempts.attempts < ?
     RETURNING attempts, window_started_at`,
  ).bind(
    staffId, now, now,
    windowCutoff, windowCutoff, windowCutoff, STEP_UP_MAX_ATTEMPTS,
  ).first<{ attempts: number; window_started_at: string }>();
  return row ? {
    attempts: Number(row.attempts),
    maxAttempts: STEP_UP_MAX_ATTEMPTS,
    windowStartedAt: row.window_started_at,
  } : null;
}

/** 設定確認に成功したときだけ、失敗を含む試行枠を解放する。 */
export async function clearTwoFactorSetupAttempts(
  db: D1Database,
  staffId: string,
): Promise<void> {
  await db.prepare(
    `DELETE FROM staff_two_factor_setup_attempts WHERE staff_id = ?`,
  ).bind(staffId).run();
}

/** 再確認（step-up）に成功したとき、失敗を含む試行枠を解放する。 */
export async function clearStepUpAttempts(db: D1Database, staffId: string): Promise<void> {
  await db.prepare(
    `DELETE FROM auth_step_up_attempts WHERE staff_id = ?`,
  ).bind(staffId).run();
}

export async function consumeStepUpGrant(
  db: D1Database,
  input: {
    tokenHash: string; staffId: string; purpose: string; now?: string;
    /**
     * 使おうとしている要求のセッション指紋（無いときは null）。
     * 確認票の発行セッションと違う・発行セッションが消えていたら使えない。
     * 確認票側の結び付けが無い（移行前）は従来どおり通す。
     */
    sessionTokenHash?: string | null;
  },
): Promise<boolean> {
  const now = input.now ?? new Date().toISOString();
  const result = await db.prepare(
    `UPDATE auth_step_up_grants SET consumed_at = ?
      WHERE token_hash = ? AND staff_id = ? AND purpose = ?
        AND consumed_at IS NULL AND expires_at > ?
        AND (purpose <> 'auth.login.trust' OR (session_token_hash IS NOT NULL AND session_token_hash = ?))
        AND (session_token_hash IS NULL OR session_token_hash = ?)
        AND (session_token_hash IS NULL OR EXISTS (
          SELECT 1 FROM admin_sessions
          WHERE token_hash = auth_step_up_grants.session_token_hash
            AND staff_id = auth_step_up_grants.staff_id))
        AND (issued_policy_version IS NULL OR issued_policy_version = (
          SELECT policy_version FROM staff_members WHERE id = auth_step_up_grants.staff_id))`,
  ).bind(now, input.tokenHash, input.staffId, input.purpose, now, input.sessionTokenHash ?? null, input.sessionTokenHash ?? null).run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export type OperationRequestReceipt = {
  action: string;
  actorId: string;
  idempotencyKey: string;
  requestHash: string;
  resourceId: string;
  createdAt: string;
};

type ReceiptRow = {
  action: string; actor_id: string; idempotency_key: string;
  request_hash: string; resource_id: string; created_at: string;
};

function mapReceipt(row: ReceiptRow): OperationRequestReceipt {
  return {
    action: row.action, actorId: row.actor_id, idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash, resourceId: row.resource_id, createdAt: row.created_at,
  };
}

export async function getOperationRequestReceipt(
  db: D1Database,
  action: string,
  actorId: string,
  idempotencyKey: string,
): Promise<OperationRequestReceipt | null> {
  const row = await db.prepare(
    `SELECT * FROM operation_request_receipts
      WHERE action = ? AND actor_id = ? AND idempotency_key = ?`,
  ).bind(action, actorId, idempotencyKey).first<ReceiptRow>();
  return row ? mapReceipt(row) : null;
}

export async function saveOperationRequestReceipt(
  db: D1Database,
  input: Omit<OperationRequestReceipt, 'createdAt'> & { createdAt?: string },
): Promise<boolean> {
  const result = await db.prepare(
    `INSERT OR IGNORE INTO operation_request_receipts
       (action, actor_id, idempotency_key, request_hash, resource_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(input.action, input.actorId, input.idempotencyKey, input.requestHash,
    input.resourceId, input.createdAt ?? new Date().toISOString()).run();
  return Number(result.meta?.changes ?? 0) === 1;
}

/**
 * 対象に結び付いた再実行記録があるか。
 *
 * 停止・復旧は状態確定のあとで receipt を保存する。receipt の保存だけ失敗すると
 * 状態だけ残り、同じキー・版の再送は版競合になる。再送の修復では「誰かの完了した
 * 要求がこの対象を持っているか」で、他人の確定済み要求の横取りか、置き去りの
 * 部分実行かを見分ける。記録がある対象は他人の確定済みとして競合のままにする。
 */
export async function hasOperationRequestReceiptForResource(
  db: D1Database,
  action: string,
  resourceId: string,
): Promise<boolean> {
  const hit = await db.prepare(
    `SELECT 1 FROM operation_request_receipts
      WHERE action = ? AND resource_id = ?
      LIMIT 1`,
  ).bind(action, resourceId).first();
  return hit !== null;
}

export type OperationDeploymentEventInput = {
  deploymentId: string;
  phase: 'queued' | 'deploying' | 'verifying' | 'succeeded' | 'failed' | 'rolled_back';
  environment: string;
  fromCommit?: string | null;
  toCommit?: string | null;
  version?: string | null;
  migrations?: string[];
  rollbackAvailable?: boolean;
  downtimeSeconds?: number | null;
  pullRequest?: number | null;
  releaseSummary?: string | null;
  actor: string;
  smokeCheck?: Record<string, unknown> | null;
  occurredAt: string;
};

export type OperationDeploymentEvent = OperationDeploymentEventInput & { id: string; receivedAt: string };

type DeploymentRow = {
  id: string; deployment_id: string; phase: OperationDeploymentEventInput['phase']; environment: string;
  from_commit: string | null; to_commit: string | null; version: string | null; migration_json: string;
  rollback_available: number; downtime_seconds: number | null; pull_request: number | null;
  release_summary: string | null; actor: string; smoke_check_json: string | null;
  occurred_at: string; received_at: string;
};

function mapDeployment(row: DeploymentRow): OperationDeploymentEvent {
  return {
    id: row.id, deploymentId: row.deployment_id, phase: row.phase, environment: row.environment,
    fromCommit: row.from_commit, toCommit: row.to_commit, version: row.version,
    migrations: JSON.parse(row.migration_json) as string[], rollbackAvailable: row.rollback_available === 1,
    downtimeSeconds: row.downtime_seconds, pullRequest: row.pull_request,
    releaseSummary: row.release_summary, actor: row.actor,
    smokeCheck: parseObject(row.smoke_check_json), occurredAt: row.occurred_at, receivedAt: row.received_at,
  };
}

export async function recordOperationDeploymentEvent(
  db: D1Database,
  input: OperationDeploymentEventInput,
): Promise<{ created: boolean; event: OperationDeploymentEvent }> {
  const id = crypto.randomUUID();
  const receivedAt = new Date().toISOString();
  const result = await db.prepare(
    `INSERT OR IGNORE INTO operation_deployment_events
       (id, deployment_id, phase, environment, from_commit, to_commit, version,
        migration_json, rollback_available, downtime_seconds, pull_request,
        release_summary, actor, smoke_check_json, occurred_at, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, input.deploymentId, input.phase, input.environment, input.fromCommit ?? null,
    input.toCommit ?? null, input.version ?? null, JSON.stringify(input.migrations ?? []),
    input.rollbackAvailable ? 1 : 0, input.downtimeSeconds ?? null, input.pullRequest ?? null,
    input.releaseSummary ?? null, input.actor, input.smokeCheck ? JSON.stringify(input.smokeCheck) : null,
    input.occurredAt, receivedAt,
  ).run();
  const row = await db.prepare(
    'SELECT * FROM operation_deployment_events WHERE deployment_id = ? AND phase = ?',
  ).bind(input.deploymentId, input.phase).first<DeploymentRow>();
  if (!row) throw new Error('operation_deployment_event_missing');
  return { created: Number(result.meta?.changes ?? 0) === 1, event: mapDeployment(row) };
}

export async function listOperationDeploymentEvents(
  db: D1Database,
  limit = 100,
): Promise<OperationDeploymentEvent[]> {
  const rows = await db.prepare(
    `SELECT * FROM operation_deployment_events
      ORDER BY occurred_at DESC, id DESC LIMIT ?`,
  ).bind(Math.max(1, Math.min(Math.floor(limit), 200))).all<DeploymentRow>();
  return (rows.results ?? []).map(mapDeployment);
}

export async function enqueueOperationNotifications(
  db: D1Database,
  input: { incidentId: string; eventKind: 'stopped' | 'restored'; payload: Record<string, unknown>; now?: string },
): Promise<Array<{ channel: 'line' | 'email'; status: 'queued' }>> {
  const now = input.now ?? new Date().toISOString();
  await db.batch((['line', 'email'] as const).map((channel) => db.prepare(
    `INSERT OR IGNORE INTO operation_notification_outbox
       (id, incident_id, event_kind, channel, status, payload_json,
        next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), input.incidentId, input.eventKind, channel,
    JSON.stringify(input.payload), now, now, now)));
  return [{ channel: 'line', status: 'queued' }, { channel: 'email', status: 'queued' }];
}
