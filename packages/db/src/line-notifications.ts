import { jstNow } from './utils.js';

export type CustomerNotificationStatus = 'draft' | 'published' | 'stopped';
export type NotificationDeliveryStatus =
  | 'pending'
  | 'provider_accepted'
  | 'excluded'
  | 'retry_wait'
  | 'failed';

export class LineNotificationError extends Error {
  constructor(
    readonly code: 'not_found' | 'version_conflict' | 'duplicate_key',
    message: string,
  ) {
    super(message);
  }
}

export interface CustomerNotificationDefinitionRow {
  id: string;
  line_account_id: string;
  key: string;
  name: string;
  category: string;
  source_event_type: string;
  status: CustomerNotificationStatus;
  current_version_id: string | null;
  draft_config_json: string;
  transactional_only: number;
  version: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  current_version_number?: number | null;
}

export interface CustomerNotificationVersionRow {
  id: string;
  definition_id: string;
  version_number: number;
  config_json: string;
  line_template_json: string;
  aggregation_rule: string;
  email_fallback_policy: string;
  published_by: string;
  published_at: string;
}

export async function listCustomerNotificationDefinitions(
  db: D1Database,
  lineAccountId: string,
): Promise<CustomerNotificationDefinitionRow[]> {
  const result = await db.prepare(`
    SELECT d.*, v.version_number AS current_version_number
      FROM customer_notification_definitions d
      LEFT JOIN customer_notification_versions v ON v.id = d.current_version_id
     WHERE d.line_account_id = ?
     ORDER BY d.category, d.name, d.id
  `).bind(lineAccountId).all<CustomerNotificationDefinitionRow>();
  return result.results;
}

export async function getCustomerNotificationDefinition(
  db: D1Database,
  id: string,
  lineAccountId: string,
): Promise<{ definition: CustomerNotificationDefinitionRow; versions: CustomerNotificationVersionRow[] } | null> {
  const definition = await db.prepare(`
    SELECT d.*, v.version_number AS current_version_number
      FROM customer_notification_definitions d
      LEFT JOIN customer_notification_versions v ON v.id = d.current_version_id
     WHERE d.id = ? AND d.line_account_id = ?
  `).bind(id, lineAccountId).first<CustomerNotificationDefinitionRow>();
  if (!definition) return null;
  const versions = await db.prepare(`
    SELECT * FROM customer_notification_versions
     WHERE definition_id = ? ORDER BY version_number DESC
  `).bind(id).all<CustomerNotificationVersionRow>();
  return { definition, versions: versions.results };
}

export async function createCustomerNotificationDefinition(
  db: D1Database,
  input: {
    lineAccountId: string;
    key: string;
    name: string;
    category: string;
    sourceEventType: string;
    draftConfig: Record<string, unknown>;
    staffId: string;
  },
): Promise<{ definition: CustomerNotificationDefinitionRow; versions: CustomerNotificationVersionRow[] }> {
  const id = crypto.randomUUID();
  const now = jstNow();
  try {
    await db.prepare(`
      INSERT INTO customer_notification_definitions
        (id, line_account_id, key, name, category, source_event_type, status,
         draft_config_json, created_by, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)
    `).bind(
      id,
      input.lineAccountId,
      input.key,
      input.name,
      input.category,
      input.sourceEventType,
      JSON.stringify(input.draftConfig),
      input.staffId,
      input.staffId,
      now,
      now,
    ).run();
  } catch (error) {
    if (error instanceof Error && /UNIQUE/i.test(error.message)) {
      throw new LineNotificationError('duplicate_key', '同じキーのお知らせが既にあります');
    }
    throw error;
  }
  const saved = await getCustomerNotificationDefinition(db, id, input.lineAccountId);
  if (!saved) throw new LineNotificationError('not_found', 'お知らせが見つかりません');
  return saved;
}

export async function updateCustomerNotificationDraft(
  db: D1Database,
  input: {
    id: string;
    lineAccountId: string;
    expectedVersion: number;
    name: string;
    category: string;
    sourceEventType: string;
    draftConfig: Record<string, unknown>;
    staffId: string;
  },
): Promise<{ definition: CustomerNotificationDefinitionRow; versions: CustomerNotificationVersionRow[] }> {
  const current = await getCustomerNotificationDefinition(db, input.id, input.lineAccountId);
  if (!current) throw new LineNotificationError('not_found', 'お知らせが見つかりません');
  const result = await db.prepare(`
    UPDATE customer_notification_definitions
       SET name = ?, category = ?, source_event_type = ?, draft_config_json = ?,
           updated_by = ?, updated_at = ?, version = version + 1
     WHERE id = ? AND line_account_id = ? AND version = ?
  `).bind(
    input.name,
    input.category,
    input.sourceEventType,
    JSON.stringify(input.draftConfig),
    input.staffId,
    jstNow(),
    input.id,
    input.lineAccountId,
    input.expectedVersion,
  ).run();
  if (!Number(result.meta.changes ?? 0)) {
    throw new LineNotificationError('version_conflict', 'ほかの担当者が先に変更しました');
  }
  const saved = await getCustomerNotificationDefinition(db, input.id, input.lineAccountId);
  if (!saved) throw new LineNotificationError('not_found', 'お知らせが見つかりません');
  return saved;
}

export async function publishCustomerNotificationDefinition(
  db: D1Database,
  input: { id: string; lineAccountId: string; expectedVersion: number; staffId: string },
): Promise<{ definition: CustomerNotificationDefinitionRow; versions: CustomerNotificationVersionRow[] }> {
  const current = await getCustomerNotificationDefinition(db, input.id, input.lineAccountId);
  if (!current) throw new LineNotificationError('not_found', 'お知らせが見つかりません');
  if (Number(current.definition.version) !== input.expectedVersion) {
    throw new LineNotificationError('version_conflict', 'ほかの担当者が先に変更しました');
  }

  const versionId = crypto.randomUUID();
  const now = jstNow();
  let results: D1Result[];
  try {
    results = await db.batch([
      db.prepare(`
      INSERT INTO customer_notification_versions
        (id, definition_id, version_number, config_json, line_template_json,
         aggregation_rule, email_fallback_policy, published_by, published_at)
      SELECT ?, d.id,
             COALESCE((SELECT MAX(v.version_number) + 1
                         FROM customer_notification_versions v
                        WHERE v.definition_id = d.id), 1),
             d.draft_config_json,
             COALESCE(json_extract(d.draft_config_json, '$.lineTemplate'), '[]'),
             COALESCE(json_extract(d.draft_config_json, '$.aggregationRule'), 'definition_day'),
             COALESCE(json_extract(d.draft_config_json, '$.emailFallbackPolicy'), 'disabled'),
             ?, ?
        FROM customer_notification_definitions d
       WHERE d.id = ? AND d.line_account_id = ? AND d.version = ?
      `).bind(versionId, input.staffId, now, input.id, input.lineAccountId, input.expectedVersion),
      db.prepare(`
      UPDATE customer_notification_definitions
         SET current_version_id = ?, status = 'published', updated_by = ?,
             updated_at = ?, version = version + 1
       WHERE id = ? AND line_account_id = ? AND version = ?
      `).bind(
        versionId,
        input.staffId,
        now,
        input.id,
        input.lineAccountId,
        input.expectedVersion,
      ),
    ]);
  } catch (error) {
    if (error instanceof Error && /UNIQUE/i.test(error.message)) {
      throw new LineNotificationError('version_conflict', 'ほかの担当者が先に変更しました');
    }
    throw error;
  }
  if (!Number(results[1]?.meta.changes ?? 0)) {
    throw new LineNotificationError('version_conflict', 'ほかの担当者が先に変更しました');
  }
  const saved = await getCustomerNotificationDefinition(db, input.id, input.lineAccountId);
  if (!saved) throw new LineNotificationError('not_found', 'お知らせが見つかりません');
  return saved;
}

export async function stopCustomerNotificationDefinition(
  db: D1Database,
  input: { id: string; lineAccountId: string; expectedVersion: number; staffId: string },
): Promise<{ definition: CustomerNotificationDefinitionRow; versions: CustomerNotificationVersionRow[] }> {
  const current = await getCustomerNotificationDefinition(db, input.id, input.lineAccountId);
  if (!current) throw new LineNotificationError('not_found', 'お知らせが見つかりません');
  const result = await db.prepare(`
    UPDATE customer_notification_definitions
       SET status = 'stopped', updated_by = ?, updated_at = ?, version = version + 1
     WHERE id = ? AND line_account_id = ? AND version = ?
  `).bind(
    input.staffId,
    jstNow(),
    input.id,
    input.lineAccountId,
    input.expectedVersion,
  ).run();
  if (!Number(result.meta.changes ?? 0)) {
    throw new LineNotificationError('version_conflict', 'ほかの担当者が先に変更しました');
  }
  const saved = await getCustomerNotificationDefinition(db, input.id, input.lineAccountId);
  if (!saved) throw new LineNotificationError('not_found', 'お知らせが見つかりません');
  return saved;
}

/**
 * 送信に使う顧客通知の正本を決める。
 *
 * その業務イベントに顧客通知定義がある場合は、定義だけが正本になる。
 * `published` のときだけ送り、送る文面は確定済み版(`current_version_id`)の
 * config から取る。`draft`・`stopped` は送らない。定義が無いイベントだけ、
 * 呼び出し側は従来の `ec_notification_settings` を見る(未移行の互換)。
 * 定義が1つでもあれば旧設定へ戻らない——読み書きの正本を1系統にするため。
 */
export interface CustomerNotificationSource {
  definitionId: string;
  name: string;
  status: CustomerNotificationStatus;
  versionId: string | null;
  versionNumber: number | null;
  config: Record<string, unknown>;
}

export async function getCustomerNotificationSource(
  db: D1Database,
  lineAccountId: string,
  sourceEventType: string,
): Promise<CustomerNotificationSource | null> {
  const row = await db.prepare(`
    SELECT d.id, d.name, d.status, d.current_version_id,
           v.version_number, v.config_json
      FROM customer_notification_definitions d
      LEFT JOIN customer_notification_versions v ON v.id = d.current_version_id
     WHERE d.line_account_id = ? AND d.source_event_type = ?
     ORDER BY CASE WHEN d.status = 'published' THEN 0 ELSE 1 END,
              d.updated_at DESC, d.id
     LIMIT 1
  `).bind(lineAccountId, sourceEventType).first<{
    id: string; name: string; status: CustomerNotificationStatus;
    current_version_id: string | null;
    version_number: number | null; config_json: string | null;
  }>();
  if (!row) return null;
  let config: Record<string, unknown> = {};
  if (row.config_json) {
    try {
      const parsed = JSON.parse(row.config_json) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      config = {};
    }
  }
  return {
    definitionId: row.id,
    name: row.name,
    status: row.status,
    versionId: row.current_version_id,
    versionNumber: row.version_number == null ? null : Number(row.version_number),
    config,
  };
}

export type CustomerEcDeliveryFinish =
  | { kind: 'accepted'; providerRequestId?: string | null }
  | { kind: 'excluded'; errorCode: string; errorMessage: string }
  | { kind: 'failed'; errorCode: string; errorMessage: string };

/**
 * EC取引イベントからの顧客送信を共通送信台帳へ書く。
 *
 * 同一外部イベントは `(line_account_id, dedupe_key)` の通知1件、
 * `(line_account_id, idempotency_key)` の送達1件へ畳む。EC側の再送や
 * イベント処理のやり直しで台帳の行が増えない。送達の冪等キーには
 * LINE へ渡す固定 retry key をそのまま使うので、再試行は新しい送達行を
 * 作らず同じ行を確定する。
 *
 * `attemptedSend` のときだけ試行履歴を足し、送達の `attempts` を進める。
 * 送信対象外・送信済みの記録直し(自己復旧)は「この処理では送っていない」
 * ため試行を増やさない。一度 `provider_accepted` になった送達は、
 * 後から来る失敗・対象外の記録で戻さない。
 */
export async function recordCustomerEcDelivery(
  db: D1Database,
  input: {
    lineAccountId: string;
    sourceEventType: string;
    /** EC側の外部イベントID。再送でも変わらない。 */
    sourceEventId: string;
    /** 友だちID。友だち未確定のときは届け先の LINE user id を入れる。 */
    recipientId: string;
    /** 送信に使った固定 retry key(X-Line-Retry-Key と同じ値)。 */
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
    definitionId?: string | null;
    definitionVersionId?: string | null;
    /** この処理で実際にLINE送信を試みたか。試行履歴と回数を足すかの印。 */
    attemptedSend: boolean;
    finish: CustomerEcDeliveryFinish;
  },
): Promise<void> {
  const now = jstNow();
  const dedupeKey = `ec:${input.sourceEventId}`;
  const instanceStatus = input.finish.kind === 'accepted'
    ? 'completed'
    : input.finish.kind === 'excluded' ? 'excluded' : 'failed';
  const metadata = input.metadata ? JSON.stringify(input.metadata) : null;
  await db.prepare(`
    INSERT INTO notification_instances
      (id, line_account_id, audience_type, definition_id, definition_version_id,
       source_event_type, source_event_id, source_metadata_json, dedupe_key,
       status, created_at, updated_at)
    VALUES (?, ?, 'customer', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(line_account_id, dedupe_key) DO UPDATE SET
      status = CASE WHEN notification_instances.status = 'completed'
                    THEN 'completed' ELSE excluded.status END,
      definition_id = COALESCE(notification_instances.definition_id, excluded.definition_id),
      definition_version_id = COALESCE(
        notification_instances.definition_version_id, excluded.definition_version_id),
      source_metadata_json = COALESCE(
        notification_instances.source_metadata_json, excluded.source_metadata_json),
      updated_at = excluded.updated_at
  `).bind(
    crypto.randomUUID(), input.lineAccountId,
    input.definitionId ?? null, input.definitionVersionId ?? null,
    input.sourceEventType, input.sourceEventId, metadata, dedupeKey,
    instanceStatus, now, now,
  ).run();
  const instance = await db.prepare(`
    SELECT id FROM notification_instances
     WHERE line_account_id = ? AND dedupe_key = ?
  `).bind(input.lineAccountId, dedupeKey).first<{ id: string }>();
  if (!instance) throw new Error('notification instance was not recorded');

  const deliveryStatus = input.finish.kind === 'accepted'
    ? 'provider_accepted'
    : input.finish.kind === 'excluded' ? 'excluded' : 'failed';
  const attemptDelta = input.attemptedSend ? 1 : 0;
  const providerRequestId = input.finish.kind === 'accepted'
    ? input.finish.providerRequestId ?? null
    : null;
  const errorCode = input.finish.kind === 'accepted' ? null : input.finish.errorCode;
  const errorMessage = input.finish.kind === 'accepted' ? null : input.finish.errorMessage;
  await db.prepare(`
    INSERT INTO notification_deliveries
      (id, line_account_id, instance_id, audience_type, recipient_type, recipient_id,
       channel, idempotency_key, status, retryable, attempts, provider_request_id,
       provider_status, error_code, error_message_safe, queued_at, accepted_at,
       failed_at, execution_mode, version, updated_at, source)
    VALUES (?, ?, ?, 'customer', 'friend', ?, 'line', ?, ?, 0, ?, ?, ?, ?, ?,
            ?, ?, ?, 'automatic', 1, ?, ?)
    ON CONFLICT(line_account_id, idempotency_key) DO UPDATE SET
      status = excluded.status,
      source = excluded.source,
      attempts = notification_deliveries.attempts + excluded.attempts,
      provider_request_id = COALESCE(
        excluded.provider_request_id, notification_deliveries.provider_request_id),
      provider_status = excluded.provider_status,
      error_code = excluded.error_code,
      error_message_safe = excluded.error_message_safe,
      accepted_at = COALESCE(excluded.accepted_at, notification_deliveries.accepted_at),
      failed_at = CASE WHEN excluded.status = 'failed'
                       THEN excluded.failed_at ELSE notification_deliveries.failed_at END,
      version = notification_deliveries.version + 1,
      updated_at = excluded.updated_at
    WHERE notification_deliveries.status != 'provider_accepted'
  `).bind(
    crypto.randomUUID(), input.lineAccountId, instance.id, input.recipientId,
    input.idempotencyKey, deliveryStatus, attemptDelta, providerRequestId,
    deliveryStatus, errorCode, errorMessage, now,
    deliveryStatus === 'provider_accepted' ? now : null,
    deliveryStatus === 'failed' ? now : null,
    now, input.sourceEventType,
  ).run();

  if (!input.attemptedSend) return;
  const delivery = await db.prepare(`
    SELECT id, attempts FROM notification_deliveries
     WHERE line_account_id = ? AND idempotency_key = ?
  `).bind(input.lineAccountId, input.idempotencyKey).first<{ id: string; attempts: number }>();
  if (!delivery) throw new Error('notification delivery was not recorded');
  await db.prepare(`
    INSERT OR IGNORE INTO notification_delivery_attempts
      (id, delivery_id, attempt_number, retry_key, outcome,
       provider_request_id, error_code, error_message_safe, attempted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(), delivery.id, Number(delivery.attempts) || 1,
    input.idempotencyKey,
    deliveryStatus === 'provider_accepted' ? 'provider_accepted' : 'failed',
    providerRequestId, errorCode, errorMessage, now,
  ).run();
}

export interface NotificationDeliveryListRow {
  id: string;
  audience_type: 'customer' | 'operator';
  recipient_type: string;
  recipient_id: string;
  channel: 'line' | 'email' | 'in_app';
  status: NotificationDeliveryStatus;
  retryable: number;
  attempts: number;
  next_retry_at: string | null;
  provider_status: string | null;
  error_code: string | null;
  error_message_safe: string | null;
  queued_at: string;
  accepted_at: string | null;
  execution_mode: 'automatic' | 'retry' | 'resend' | 'test';
  version: number;
  source_event_type: string;
  source_event_id: string;
  source_metadata_json: string | null;
  definition_name: string | null;
  definition_version: number | null;
  friend_name: string | null;
  clicked_at: string | null;
  resolution_action: 'resolved' | 'reopened' | null;
  resolved_at: string | null;
  resolved_by_name: string | null;
}

export interface NotificationDeliveryAttemptRow {
  delivery_id: string;
  attempt_number: number;
  outcome: 'provider_accepted' | 'retry_wait' | 'failed';
  provider_request_id: string | null;
  error_code: string | null;
  error_message_safe: string | null;
  attempted_at: string;
}

export async function listNotificationDeliveries(
  db: D1Database,
  input: { lineAccountId: string; view: 'all' | 'failures'; limit: number; offset: number },
): Promise<{
  items: NotificationDeliveryListRow[];
  total: number;
  summary: { accepted: number; failed: number; excluded: number; pending: number };
}> {
  const filter = input.view === 'failures'
    ? "AND d.status IN ('excluded', 'retry_wait', 'failed')"
    : '';
  const [items, count, summary] = await Promise.all([
    db.prepare(`
      WITH resolution_latest AS (
        SELECT id, target_id, action, actor_id, created_at
          FROM (
            SELECT oa.*,
                   ROW_NUMBER() OVER (
                     PARTITION BY oa.target_id
                     ORDER BY CAST(json_extract(oa.detail_json, '$.version') AS INTEGER) DESC,
                              oa.created_at DESC, oa.id DESC
                   ) AS row_number
              FROM operation_audit oa
             WHERE oa.target_kind = 'notification_delivery'
               AND oa.action IN ('resolved', 'reopened')
          ) WHERE row_number = 1
      )
      SELECT d.id, d.audience_type, d.recipient_type, d.recipient_id, d.channel,
             d.status, d.retryable, d.attempts, d.next_retry_at, d.provider_status,
             d.error_code, d.error_message_safe, d.queued_at, d.accepted_at,
             d.execution_mode, d.version,
             i.source_event_type, i.source_event_id, i.source_metadata_json,
             def.name AS definition_name, ver.version_number AS definition_version,
             CASE WHEN d.recipient_type = 'friend' THEN f.display_name ELSE NULL END AS friend_name,
             (SELECT MAX(x.clicked_at) FROM notification_interactions x
               WHERE x.delivery_id = d.id) AS clicked_at,
             resolution.action AS resolution_action,
             CASE WHEN resolution.action = 'resolved' THEN resolution.created_at ELSE NULL END AS resolved_at,
             CASE WHEN resolution.action = 'resolved' THEN resolver.name ELSE NULL END AS resolved_by_name
        FROM notification_deliveries d
        JOIN notification_instances i ON i.id = d.instance_id AND i.line_account_id = d.line_account_id
        LEFT JOIN customer_notification_definitions def
          ON def.id = i.definition_id AND def.line_account_id = d.line_account_id
        LEFT JOIN customer_notification_versions ver ON ver.id = i.definition_version_id
        LEFT JOIN friends f
          ON f.id = d.recipient_id AND f.line_account_id = d.line_account_id
        LEFT JOIN resolution_latest resolution ON resolution.target_id = d.id
        LEFT JOIN staff_members resolver ON resolver.id = resolution.actor_id
       WHERE d.line_account_id = ? ${filter}
       ORDER BY d.queued_at DESC, d.id DESC LIMIT ? OFFSET ?
    `).bind(input.lineAccountId, input.limit, input.offset).all<NotificationDeliveryListRow>(),
    db.prepare(`SELECT COUNT(*) AS count FROM notification_deliveries d
                 WHERE d.line_account_id = ? ${filter}`)
      .bind(input.lineAccountId).first<{ count: number }>(),
    db.prepare(`
      WITH resolution_latest AS (
        SELECT target_id, action
          FROM (
            SELECT oa.target_id, oa.action,
                   ROW_NUMBER() OVER (
                     PARTITION BY oa.target_id
                     ORDER BY CAST(json_extract(oa.detail_json, '$.version') AS INTEGER) DESC,
                              oa.created_at DESC, oa.id DESC
                   ) AS row_number
              FROM operation_audit oa
             WHERE oa.target_kind = 'notification_delivery'
               AND oa.action IN ('resolved', 'reopened')
          ) WHERE row_number = 1
      )
      SELECT
        SUM(CASE WHEN d.status = 'provider_accepted' THEN 1 ELSE 0 END) AS accepted,
        SUM(CASE WHEN d.status IN ('retry_wait', 'failed')
                  AND COALESCE(resolution.action, 'reopened') != 'resolved' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN d.status = 'excluded' THEN 1 ELSE 0 END) AS excluded,
        SUM(CASE WHEN d.status = 'pending' THEN 1 ELSE 0 END) AS pending
      FROM notification_deliveries d
      LEFT JOIN resolution_latest resolution ON resolution.target_id = d.id
      WHERE d.line_account_id = ?
    `).bind(input.lineAccountId).first<{
      accepted: number | null; failed: number | null; excluded: number | null; pending: number | null;
    }>(),
  ]);
  return {
    items: items.results,
    total: Number(count?.count ?? 0),
    summary: {
      accepted: Number(summary?.accepted ?? 0),
      failed: Number(summary?.failed ?? 0),
      excluded: Number(summary?.excluded ?? 0),
      pending: Number(summary?.pending ?? 0),
    },
  };
}

/** 表示中の送達だけに絞り、試行履歴をアカウント境界の内側でまとめて読む。 */
export async function listNotificationDeliveryAttempts(
  db: D1Database,
  lineAccountId: string,
  deliveryIds: string[],
): Promise<NotificationDeliveryAttemptRow[]> {
  if (deliveryIds.length === 0) return [];
  // D1は1文100 bindまで。accountIdの1個を含めても余裕がある90件ずつで読む。
  const chunks: string[][] = [];
  for (let offset = 0; offset < deliveryIds.length; offset += 90) {
    chunks.push(deliveryIds.slice(offset, offset + 90));
  }
  const results = await Promise.all(chunks.map(async (ids) => {
    const placeholders = ids.map(() => '?').join(', ');
    return db.prepare(`
      SELECT a.delivery_id, a.attempt_number, a.outcome, a.provider_request_id,
             a.error_code, a.error_message_safe, a.attempted_at
        FROM notification_delivery_attempts a
        JOIN notification_deliveries d ON d.id = a.delivery_id
       WHERE d.line_account_id = ? AND a.delivery_id IN (${placeholders})
       ORDER BY a.delivery_id, a.attempt_number DESC
    `).bind(lineAccountId, ...ids).all<NotificationDeliveryAttemptRow>();
  }));
  return results.flatMap((result) => result.results);
}

export interface NotificationRetryRow {
  id: string;
  line_account_id: string;
  status: NotificationDeliveryStatus;
  retryable: number;
  attempts: number;
  idempotency_key: string;
  version: number;
  channel: string;
  recipient_type: string;
  recipient_id: string;
  line_user_id: string | null;
  line_template_json: string | null;
  friend_is_following: number | null;
  resolution_action: 'resolved' | 'reopened' | null;
}

export async function getNotificationDeliveryForRetry(
  db: D1Database,
  id: string,
  lineAccountId: string,
): Promise<NotificationRetryRow | null> {
  return db.prepare(`
    SELECT d.id, d.line_account_id, d.status, d.retryable, d.attempts,
           d.idempotency_key, d.version, d.channel, d.recipient_type, d.recipient_id,
           f.line_platform_user_id AS line_user_id, v.line_template_json,
           f.is_following AS friend_is_following,
           (SELECT oa.action FROM operation_audit oa
             WHERE oa.target_kind = 'notification_delivery' AND oa.target_id = d.id
               AND oa.action IN ('resolved', 'reopened')
             ORDER BY CAST(json_extract(oa.detail_json, '$.version') AS INTEGER) DESC,
                      oa.created_at DESC, oa.id DESC LIMIT 1) AS resolution_action
      FROM notification_deliveries d
      JOIN notification_instances i ON i.id = d.instance_id AND i.line_account_id = d.line_account_id
      JOIN line_accounts a ON a.id = d.line_account_id
      LEFT JOIN friends f ON f.id = d.recipient_id AND f.line_account_id = d.line_account_id
      LEFT JOIN customer_notification_versions v ON v.id = i.definition_version_id
     WHERE d.id = ? AND d.line_account_id = ?
  `).bind(id, lineAccountId).first<NotificationRetryRow>();
}

export async function claimNotificationDeliveryRetry(
  db: D1Database,
  input: { id: string; lineAccountId: string; expectedVersion: number },
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE notification_deliveries
       SET status = 'pending', execution_mode = 'retry', next_retry_at = NULL,
           version = version + 1, updated_at = ?
     WHERE id = ? AND line_account_id = ? AND version = ?
       AND retryable = 1 AND status IN ('retry_wait', 'failed')
  `).bind(jstNow(), input.id, input.lineAccountId, input.expectedVersion).run();
  return Number(result.meta.changes ?? 0) > 0;
}

export async function finishNotificationDeliveryRetry(
  db: D1Database,
  input: {
    delivery: NotificationRetryRow;
    outcome: 'provider_accepted' | 'retry_wait' | 'failed';
    providerRequestId?: string | null;
    errorCode?: string | null;
    errorMessageSafe?: string | null;
    nextRetryAt?: string | null;
  },
): Promise<boolean> {
  const attemptedAt = jstNow();
  const nextAttempt = Number(input.delivery.attempts) + 1;
  const results = await db.batch([
    db.prepare(`
      INSERT INTO notification_delivery_attempts
        (id, delivery_id, attempt_number, retry_key, outcome, provider_request_id,
         error_code, error_message_safe, attempted_at)
      SELECT ?, d.id, ?, ?, ?, ?, ?, ?, ?
        FROM notification_deliveries d
       WHERE d.id = ? AND d.line_account_id = ? AND d.status = 'pending'
         AND d.version = ? AND d.attempts = ?
    `).bind(
      crypto.randomUUID(),
      nextAttempt,
      input.delivery.idempotency_key,
      input.outcome,
      input.providerRequestId ?? null,
      input.errorCode ?? null,
      input.errorMessageSafe ?? null,
      attemptedAt,
      input.delivery.id,
      input.delivery.line_account_id,
      Number(input.delivery.version) + 1,
      input.delivery.attempts,
    ),
    db.prepare(`
      UPDATE notification_deliveries
         SET status = ?, attempts = ?, provider_request_id = ?, provider_status = ?,
             error_code = ?, error_message_safe = ?, next_retry_at = ?,
             accepted_at = CASE WHEN ? = 'provider_accepted' THEN ? ELSE accepted_at END,
             failed_at = CASE WHEN ? IN ('retry_wait', 'failed') THEN ? ELSE NULL END,
             retryable = CASE WHEN ? = 'retry_wait' THEN 1 ELSE 0 END,
             updated_at = ?
       WHERE id = ? AND line_account_id = ? AND status = 'pending'
         AND version = ? AND attempts = ?
    `).bind(
      input.outcome,
      nextAttempt,
      input.providerRequestId ?? null,
      input.outcome,
      input.errorCode ?? null,
      input.errorMessageSafe ?? null,
      input.nextRetryAt ?? null,
      input.outcome,
      attemptedAt,
      input.outcome,
      attemptedAt,
      input.outcome,
      attemptedAt,
      input.delivery.id,
      input.delivery.line_account_id,
      Number(input.delivery.version) + 1,
      input.delivery.attempts,
    ),
  ]);
  return Number(results[0]?.meta.changes ?? 0) === 1
    && Number(results[1]?.meta.changes ?? 0) === 1;
}

/**
 * 対応済み/未対応の切替を、監査記録と送達版の同一guard付きbatchで保存する。
 * 新しい台帳は作らず、既存operation_auditを状態履歴として使う。
 */
export async function setNotificationDeliveryResolution(
  db: D1Database,
  input: {
    id: string;
    lineAccountId: string;
    expectedVersion: number;
    resolved: boolean;
    staffId: string;
  },
): Promise<'updated' | 'not_found' | 'unavailable' | 'version_conflict'> {
  const current = await db.prepare(`
    SELECT status, version FROM notification_deliveries
     WHERE id = ? AND line_account_id = ?
  `).bind(input.id, input.lineAccountId).first<{ status: NotificationDeliveryStatus; version: number }>();
  if (!current) return 'not_found';
  if (current.status !== 'excluded' && current.status !== 'retry_wait' && current.status !== 'failed') {
    return 'unavailable';
  }
  if (Number(current.version) !== input.expectedVersion) return 'version_conflict';

  const now = jstNow();
  const action = input.resolved ? 'resolved' : 'reopened';
  const results = await db.batch([
    db.prepare(`
      INSERT INTO operation_audit
        (id, target_kind, target_id, action, actor_id, detail_json, created_at)
      SELECT ?, 'notification_delivery', d.id, ?, ?, ?, ?
        FROM notification_deliveries d
       WHERE d.id = ? AND d.line_account_id = ? AND d.version = ?
         AND d.status IN ('excluded', 'retry_wait', 'failed')
    `).bind(
      crypto.randomUUID(), action, input.staffId,
      JSON.stringify({ lineAccountId: input.lineAccountId, version: input.expectedVersion + 1 }), now,
      input.id, input.lineAccountId, input.expectedVersion,
    ),
    db.prepare(`
      UPDATE notification_deliveries SET version = version + 1, updated_at = ?
       WHERE id = ? AND line_account_id = ? AND version = ?
         AND status IN ('excluded', 'retry_wait', 'failed')
    `).bind(now, input.id, input.lineAccountId, input.expectedVersion),
  ]);
  return Number(results[0]?.meta.changes ?? 0) === 1
    && Number(results[1]?.meta.changes ?? 0) === 1
    ? 'updated'
    : 'version_conflict';
}

export interface NotificationMetricRow {
  definition_id: string;
  definition_name: string;
  accepted_count: number;
  display_count: number | null;
  click_count: number;
  state: 'waiting' | 'ready' | 'unavailable_privacy' | 'failed';
  reason: string | null;
}

/**
 * 送信台帳の1件取得。要件 -24 §6 `GET deliveries/:id`。
 * 一覧と同じ射影・同じ結合で返し、アカウント境界の外側は null（404 隠蔽）にする。
 */
export async function getNotificationDelivery(
  db: D1Database,
  id: string,
  lineAccountId: string,
): Promise<NotificationDeliveryListRow | null> {
  return db.prepare(`
    WITH resolution_latest AS (
      SELECT id, target_id, action, actor_id, created_at
        FROM (
          SELECT oa.*,
                 ROW_NUMBER() OVER (
                   PARTITION BY oa.target_id
                   ORDER BY CAST(json_extract(oa.detail_json, '$.version') AS INTEGER) DESC,
                            oa.created_at DESC, oa.id DESC
                 ) AS row_number
            FROM operation_audit oa
           WHERE oa.target_kind = 'notification_delivery'
             AND oa.action IN ('resolved', 'reopened')
        ) WHERE row_number = 1
    )
    SELECT d.id, d.audience_type, d.recipient_type, d.recipient_id, d.channel,
           d.status, d.retryable, d.attempts, d.next_retry_at, d.provider_status,
           d.error_code, d.error_message_safe, d.queued_at, d.accepted_at,
           d.execution_mode, d.version,
           i.source_event_type, i.source_event_id, i.source_metadata_json,
           def.name AS definition_name, ver.version_number AS definition_version,
           CASE WHEN d.recipient_type = 'friend' THEN f.display_name ELSE NULL END AS friend_name,
           (SELECT MAX(x.clicked_at) FROM notification_interactions x
             WHERE x.delivery_id = d.id) AS clicked_at,
           resolution.action AS resolution_action,
           CASE WHEN resolution.action = 'resolved' THEN resolution.created_at ELSE NULL END AS resolved_at,
           CASE WHEN resolution.action = 'resolved' THEN resolver.name ELSE NULL END AS resolved_by_name
      FROM notification_deliveries d
      JOIN notification_instances i ON i.id = d.instance_id AND i.line_account_id = d.line_account_id
      LEFT JOIN customer_notification_definitions def
        ON def.id = i.definition_id AND def.line_account_id = d.line_account_id
      LEFT JOIN customer_notification_versions ver ON ver.id = i.definition_version_id
      LEFT JOIN friends f
        ON f.id = d.recipient_id AND f.line_account_id = d.line_account_id
      LEFT JOIN resolution_latest resolution ON resolution.target_id = d.id
      LEFT JOIN staff_members resolver ON resolver.id = resolution.actor_id
     WHERE d.id = ? AND d.line_account_id = ?
  `).bind(id, lineAccountId).first<NotificationDeliveryListRow>();
}

/**
 * 手動の新規再送（resend）の送達行を、元の通知インスタンス配下に積む。
 * retry と違い元の行は触らず、新しい冪等キーで送る。要件 -24 §6。
 */
export async function insertNotificationResendDelivery(
  db: D1Database,
  input: {
    lineAccountId: string;
    sourceDelivery: NotificationRetryRow;
    staffId: string;
    reason: string;
  },
): Promise<{ id: string; idempotencyKey: string }> {
  const now = jstNow();
  const id = crypto.randomUUID();
  const idempotencyKey = `resend:${id}`;
  const instance = await db.prepare(`
    SELECT instance_id, audience_type, recipient_type, recipient_id, channel
      FROM notification_deliveries WHERE id = ? AND line_account_id = ?
  `).bind(input.sourceDelivery.id, input.lineAccountId).first<{
    instance_id: string; audience_type: string; recipient_type: string;
    recipient_id: string; channel: string;
  }>();
  if (!instance) throw new Error('notification resend source was not found');
  const results = await db.batch([
    db.prepare(`
      INSERT INTO notification_deliveries
        (id, line_account_id, instance_id, audience_type, recipient_type, recipient_id,
         channel, idempotency_key, status, retryable, attempts, queued_at,
         execution_mode, version, updated_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, 0, ?, 'resend', 1, ?,
              (SELECT i.source_event_type FROM notification_instances i
                WHERE i.id = ? AND i.line_account_id = ?))
    `).bind(
      id, input.lineAccountId, instance.instance_id, instance.audience_type,
      instance.recipient_type, instance.recipient_id, instance.channel,
      idempotencyKey, now, now, instance.instance_id, input.lineAccountId,
    ),
    // 再送理由は監査として残す。対応状況の履歴（resolved/reopened）とは
    // 別actionなので一覧の解決状態には影響しない。
    db.prepare(`
      INSERT INTO operation_audit
        (id, target_kind, target_id, action, actor_id, detail_json, created_at)
      VALUES (?, 'notification_delivery', ?, 'line_notification.delivery.resend', ?, ?, ?)
    `).bind(
      crypto.randomUUID(), id, input.staffId,
      JSON.stringify({
        lineAccountId: input.lineAccountId, version: 1,
        sourceDeliveryId: input.sourceDelivery.id, reason: input.reason,
      }), now,
    ),
  ]);
  if (Number(results[0]?.meta.changes ?? 0) !== 1) {
    throw new Error('notification resend delivery was not recorded');
  }
  return { id, idempotencyKey };
}

/**
 * 新規再送の送信結果を確定する。試行履歴を1件足し、送達の回数を進める。
 */
export async function finishNotificationResendDelivery(
  db: D1Database,
  input: {
    id: string;
    lineAccountId: string;
    idempotencyKey: string;
    outcome: 'provider_accepted' | 'retry_wait' | 'failed';
    providerRequestId?: string | null;
    errorCode?: string | null;
    errorMessageSafe?: string | null;
    nextRetryAt?: string | null;
  },
): Promise<boolean> {
  const attemptedAt = jstNow();
  const results = await db.batch([
    db.prepare(`
      INSERT INTO notification_delivery_attempts
        (id, delivery_id, attempt_number, retry_key, outcome, provider_request_id,
         error_code, error_message_safe, attempted_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(), input.id, input.idempotencyKey, input.outcome,
      input.providerRequestId ?? null, input.errorCode ?? null,
      input.errorMessageSafe ?? null, attemptedAt,
    ),
    db.prepare(`
      UPDATE notification_deliveries
         SET status = ?, attempts = 1, provider_request_id = ?, provider_status = ?,
             error_code = ?, error_message_safe = ?, next_retry_at = ?,
             accepted_at = CASE WHEN ? = 'provider_accepted' THEN ? ELSE NULL END,
             failed_at = CASE WHEN ? IN ('retry_wait', 'failed') THEN ? ELSE NULL END,
             retryable = CASE WHEN ? = 'retry_wait' THEN 1 ELSE 0 END,
             updated_at = ?
       WHERE id = ? AND line_account_id = ? AND status = 'pending' AND attempts = 0
    `).bind(
      input.outcome,
      input.providerRequestId ?? null,
      input.outcome,
      input.errorCode ?? null,
      input.errorMessageSafe ?? null,
      input.nextRetryAt ?? null,
      input.outcome,
      attemptedAt,
      input.outcome,
      attemptedAt,
      input.outcome,
      attemptedAt,
      input.id,
      input.lineAccountId,
    ),
  ]);
  return Number(results[0]?.meta.changes ?? 0) === 1
    && Number(results[1]?.meta.changes ?? 0) === 1;
}

/**
 * 顧客定義の公開前テスト送信の記録先インスタンスを作る。
 * 実イベントとは別の `test:` 系キーで、再送・集計と混ざらない。
 */
export async function createCustomerTestInstance(
  db: D1Database,
  input: {
    lineAccountId: string;
    definitionId: string;
    definitionVersionId: string | null;
    sourceEventType: string;
    metadata?: Record<string, unknown>;
  },
): Promise<{ instanceId: string; sourceEventId: string }> {
  const now = jstNow();
  const sourceEventId = `test:${crypto.randomUUID()}`;
  const instanceId = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO notification_instances
      (id, line_account_id, audience_type, definition_id, definition_version_id,
       source_event_type, source_event_id, source_metadata_json, dedupe_key,
       status, created_at, updated_at)
    VALUES (?, ?, 'customer', ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).bind(
    instanceId, input.lineAccountId, input.definitionId, input.definitionVersionId,
    input.sourceEventType, sourceEventId,
    input.metadata ? JSON.stringify(input.metadata) : null,
    `test:${sourceEventId}`, now, now,
  ).run();
  return { instanceId, sourceEventId };
}

/**
 * テスト送信の操作自体を監査に残す。誰がどの定義を誰に試し送りしたかが
 * 後から分かる。対応状況の履歴（resolved/reopened）とは別action・別kind。
 * 枠競合などで送る前に止めたときも outcome 付きで残し、送達の有無と
 * 止めた理由を区別できるようにする。
 */
export async function recordCustomerTestAudit(
  db: D1Database,
  input: {
    definitionId: string;
    lineAccountId: string;
    staffId: string;
    sourceEventId: string;
    recipientIds: string[];
    outcome?: 'sent' | 'quota_insufficient';
    errorMessage?: string;
  },
): Promise<void> {
  await db.prepare(`
    INSERT INTO operation_audit
      (id, target_kind, target_id, action, actor_id, detail_json, created_at)
    VALUES (?, 'customer_notification', ?, 'line_notification.definition.test', ?, ?, ?)
  `).bind(
    crypto.randomUUID(), input.definitionId, input.staffId,
    JSON.stringify({
      lineAccountId: input.lineAccountId,
      sourceEventId: input.sourceEventId,
      recipientIds: input.recipientIds,
      ...(input.outcome ? { outcome: input.outcome } : {}),
      ...(input.errorMessage ? { error: input.errorMessage } : {}),
    }), jstNow(),
  ).run();
}

/**
 * 送る前に止めた試し送りの記録先を失敗で確定する。送達行のない成功前提の
 * instance を残さないためのもので、送達行は作らない。
 */
export async function failCustomerTestInstance(
  db: D1Database,
  input: { lineAccountId: string; instanceId: string },
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE notification_instances SET status = 'failed', updated_at = ?
     WHERE id = ? AND line_account_id = ? AND status = 'pending'
  `).bind(jstNow(), input.instanceId, input.lineAccountId).run();
  return Number(result.meta.changes ?? 0) === 1;
}

/**
 * テスト送信の1宛先ぶんを記録する。送信は呼び出し側が行い、結果だけ書く。
 * テスト送信は再試行の対象にしない（retryable 0）。
 */
export async function recordCustomerTestDelivery(
  db: D1Database,
  input: {
    lineAccountId: string;
    instanceId: string;
    recipientId: string;
    idempotencyKey: string;
    outcome: 'provider_accepted' | 'failed';
    providerRequestId?: string | null;
    errorCode?: string | null;
    errorMessageSafe?: string | null;
  },
): Promise<{ id: string }> {
  const now = jstNow();
  const id = crypto.randomUUID();
  const status = input.outcome === 'provider_accepted' ? 'provider_accepted' : 'failed';
  await db.prepare(`
    INSERT INTO notification_deliveries
      (id, line_account_id, instance_id, audience_type, recipient_type, recipient_id,
       channel, idempotency_key, status, retryable, attempts, provider_request_id,
       provider_status, error_code, error_message_safe, queued_at, accepted_at,
       failed_at, execution_mode, version, updated_at, source)
    VALUES (?, ?, ?, 'customer', 'friend', ?, 'line', ?, ?, 0, 1, ?, ?, ?, ?,
            ?, ?, ?, 'test', 1, ?,
            (SELECT i.source_event_type FROM notification_instances i
              WHERE i.id = ? AND i.line_account_id = ?))
  `).bind(
    id, input.lineAccountId, input.instanceId, input.recipientId,
    input.idempotencyKey, status,
    input.providerRequestId ?? null, status,
    input.errorCode ?? null, input.errorMessageSafe ?? null, now,
    status === 'provider_accepted' ? now : null,
    status === 'failed' ? now : null, now,
    input.instanceId, input.lineAccountId,
  ).run();
  await db.prepare(`
    INSERT INTO notification_delivery_attempts
      (id, delivery_id, attempt_number, retry_key, outcome, provider_request_id,
       error_code, error_message_safe, attempted_at)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(), id, input.idempotencyKey, input.outcome,
    input.providerRequestId ?? null, input.errorCode ?? null,
    input.errorMessageSafe ?? null, now,
  ).run();
  await db.prepare(`
    UPDATE notification_instances SET status = ?, updated_at = ?
     WHERE id = ? AND line_account_id = ?
  `).bind(input.outcome === 'provider_accepted' ? 'completed' : 'failed', now,
    input.instanceId, input.lineAccountId).run();
  return { id };
}

export async function listNotificationMetrics(
  db: D1Database,
  input: { lineAccountId: string; from?: string; to?: string },
): Promise<NotificationMetricRow[]> {
  const conditions = ['m.line_account_id = ?'];
  const values: unknown[] = [input.lineAccountId];
  if (input.from) { conditions.push('m.metric_date >= ?'); values.push(input.from); }
  if (input.to) { conditions.push('m.metric_date <= ?'); values.push(input.to); }
  const result = await db.prepare(`
    SELECT m.definition_id, d.name AS definition_name,
           SUM(m.accepted_count) AS accepted_count,
           CASE WHEN SUM(CASE WHEN m.state != 'ready' THEN 1 ELSE 0 END) > 0
                THEN NULL ELSE SUM(m.display_count) END AS display_count,
           SUM(m.click_count) AS click_count,
           CASE
             WHEN SUM(CASE WHEN m.state = 'failed' THEN 1 ELSE 0 END) > 0 THEN 'failed'
             WHEN SUM(CASE WHEN m.state = 'unavailable_privacy' THEN 1 ELSE 0 END) > 0 THEN 'unavailable_privacy'
             WHEN SUM(CASE WHEN m.state = 'waiting' THEN 1 ELSE 0 END) > 0 THEN 'waiting'
             ELSE 'ready'
           END AS state,
           CASE
             WHEN SUM(CASE WHEN m.state = 'unavailable_privacy' THEN 1 ELSE 0 END) > 0
               THEN 'LINEの集計条件を満たさないため未取得です'
             WHEN SUM(CASE WHEN m.state = 'waiting' THEN 1 ELSE 0 END) > 0
               THEN 'LINEの集計を待っています'
             WHEN SUM(CASE WHEN m.state = 'failed' THEN 1 ELSE 0 END) > 0
               THEN 'LINEの集計を取得できませんでした'
             ELSE NULL
           END AS reason
      FROM notification_aggregate_metrics m
      JOIN customer_notification_definitions d
        ON d.id = m.definition_id AND d.line_account_id = m.line_account_id
     WHERE ${conditions.join(' AND ')}
     GROUP BY m.definition_id, d.name
     ORDER BY d.name, m.definition_id
  `).bind(...values).all<NotificationMetricRow>();
  return result.results;
}
