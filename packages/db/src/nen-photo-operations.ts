import { sqlIdSet } from './id-queries.js';
import {
  findRewardedAdoptedDuplicate,
  getEffectivePhotoRewardPolicy,
} from './photo-reward-policies.js';

export type PhotoOperationSubject = {
  id: string;
  lineAccountId: string;
  originalObjectKey: string;
  contentType: string;
  /** 中身の hash。古い投稿は null。null 同士を重複としない。 */
  contentHash: string | null;
  reviewImageUrl: string | null;
  publicImageUrl: string | null;
  status: string;
  reviewVersion: number;
  friendId: string;
  customerId: string | null;
  latestRiskFlag: string | null;
  latestRiskConfidence: number | null;
};

type PhotoSubjectRow = {
  id: string;
  line_account_id: string;
  r2_key: string;
  content_type: string;
  content_hash: string | null;
  review_image_url: string | null;
  public_image_url: string | null;
  status: string;
  review_version: number;
  friend_id: string;
  customer_id: string | null;
  latest_risk_flag: string | null;
  latest_risk_confidence: number | null;
};

function mapSubject(row: PhotoSubjectRow): PhotoOperationSubject {
  return {
    id: row.id,
    lineAccountId: row.line_account_id,
    originalObjectKey: row.r2_key,
    contentType: row.content_type,
    reviewImageUrl: row.review_image_url,
    publicImageUrl: row.public_image_url,
    status: row.status,
    reviewVersion: Number(row.review_version),
    contentHash: row.content_hash ?? null,
    friendId: row.friend_id,
    customerId: row.customer_id,
    latestRiskFlag: row.latest_risk_flag,
    latestRiskConfidence: row.latest_risk_confidence === null ? null : Number(row.latest_risk_confidence),
  };
}

export async function getPhotoOperationSubject(
  db: D1Database,
  input: { photoId: string; lineAccountId: string },
): Promise<PhotoOperationSubject | null> {
  const row = await db.prepare(
    `SELECT ps.id, ps.line_account_id, ps.r2_key, ps.content_type, ps.content_hash, ps.friend_id,
            ps.review_image_url, ps.public_image_url, ps.status, ps.review_version,
            member.customer_id,
            (SELECT r.flag FROM nen_photo_risk_assessments r
              WHERE r.photo_id = ps.id AND r.line_account_id = ps.line_account_id
              ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS latest_risk_flag,
            (SELECT r.confidence FROM nen_photo_risk_assessments r
              WHERE r.photo_id = ps.id AND r.line_account_id = ps.line_account_id
              ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS latest_risk_confidence
       FROM nen_photo_submissions ps
       LEFT JOIN nen_ec_member_snapshots member ON member.friend_id = ps.friend_id
      WHERE ps.id = ? AND ps.line_account_id = ?`,
  ).bind(input.photoId, input.lineAccountId).first<PhotoSubjectRow>();
  return row ? mapSubject(row) : null;
}

export type PhotoReviewMetrics = {
  pendingCount: number;
  reviewedCount: number;
  averageReviewMinutes: number | null;
  oldestPendingAt: string | null;
  attentionCount: number;
};

export async function getPhotoReviewMetrics(
  db: D1Database,
  lineAccountId: string,
): Promise<PhotoReviewMetrics> {
  const row = await db.prepare(
    `SELECT
       SUM(CASE WHEN ps.status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
       SUM(CASE WHEN ps.status <> 'pending' THEN 1 ELSE 0 END) AS reviewed_count,
       AVG(CASE WHEN ps.reviewed_at IS NOT NULL
         THEN (julianday(ps.reviewed_at) - julianday(ps.created_at)) * 1440 END) AS average_review_minutes,
       MIN(CASE WHEN ps.status = 'pending' THEN ps.created_at END) AS oldest_pending_at,
       SUM(CASE WHEN
         COALESCE((SELECT r.flag FROM nen_photo_risk_assessments r
           WHERE r.photo_id = ps.id AND r.line_account_id = ps.line_account_id
           ORDER BY r.created_at DESC, r.id DESC LIMIT 1), 'safe') NOT IN ('safe', 'none', 'low')
         OR EXISTS (SELECT 1 FROM nen_photo_asset_jobs j
           WHERE j.photo_id = ps.id AND j.line_account_id = ps.line_account_id AND j.status = 'failed')
         THEN 1 ELSE 0 END) AS attention_count
     FROM nen_photo_submissions ps
    WHERE ps.line_account_id = ?`,
  ).bind(lineAccountId).first<{
    pending_count: number | null;
    reviewed_count: number | null;
    average_review_minutes: number | null;
    oldest_pending_at: string | null;
    attention_count: number | null;
  }>();
  return {
    pendingCount: Number(row?.pending_count ?? 0),
    reviewedCount: Number(row?.reviewed_count ?? 0),
    averageReviewMinutes: row?.average_review_minutes == null
      ? null
      : Math.round(Number(row.average_review_minutes) * 10) / 10,
    oldestPendingAt: row?.oldest_pending_at ?? null,
    attentionCount: Number(row?.attention_count ?? 0),
  };
}

type QueueKind = 'assessment' | 'asset';
type QueueRow = {
  id: string;
  photo_id: string | null;
  line_account_id: string;
  requested_version: number;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  requested_by: string;
  idempotency_key: string;
  request_fingerprint: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  operation?: string;
  provider?: string | null;
  model_version?: string | null;
};

function mapQueue(row: QueueRow) {
  return {
    id: row.id,
    photoId: row.photo_id,
    ...(row.photo_id === null ? { customerName: '削除済みのお客さま' } : {}),
    lineAccountId: row.line_account_id,
    requestedVersion: Number(row.requested_version),
    status: row.status,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorMessage: row.error_message,
    ...(row.operation ? { operation: row.operation } : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.model_version ? { modelVersion: row.model_version } : {}),
  };
}

async function createQueuedRun(
  db: D1Database,
  kind: QueueKind,
  input: {
    id: string;
    photoId: string;
    lineAccountId: string;
    expectedVersion: number;
    actorId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    operation?: 'review' | 'public' | 'thumbnail' | 'all';
    now?: string;
  },
): Promise<{ kind: 'created' | 'duplicate'; run: ReturnType<typeof mapQueue> } | { kind: 'changed' | 'idempotency_conflict' | 'not_found' }> {
  const table = kind === 'assessment' ? 'nen_photo_assessment_runs' : 'nen_photo_asset_jobs';
  const previous = await db.prepare(
    `SELECT * FROM ${table}
      WHERE line_account_id = ? AND requested_by = ? AND idempotency_key = ?`,
  ).bind(input.lineAccountId, input.actorId, input.idempotencyKey).first<QueueRow>();
  if (previous) {
    return previous.request_fingerprint === input.requestFingerprint
      ? { kind: 'duplicate', run: mapQueue(previous) }
      : { kind: 'idempotency_conflict' };
  }
  const subject = await getPhotoOperationSubject(db, input);
  if (!subject) return { kind: 'not_found' };
  if (subject.reviewVersion !== input.expectedVersion) return { kind: 'changed' };
  const now = input.now ?? new Date().toISOString();
  const statement = kind === 'assessment'
    ? db.prepare(
      `INSERT INTO nen_photo_assessment_runs
        (id, photo_id, line_account_id, requested_version, status, requested_by,
         idempotency_key, request_fingerprint, created_at)
       SELECT ?, id, line_account_id, review_version, 'queued', ?, ?, ?, ?
         FROM nen_photo_submissions
        WHERE id = ? AND line_account_id = ? AND review_version = ?`,
    ).bind(input.id, input.actorId, input.idempotencyKey, input.requestFingerprint, now,
      input.photoId, input.lineAccountId, input.expectedVersion)
    : db.prepare(
      `INSERT INTO nen_photo_asset_jobs
        (id, photo_id, line_account_id, operation, requested_version, status, requested_by,
         idempotency_key, request_fingerprint, created_at)
       SELECT ?, id, line_account_id, ?, review_version, 'queued', ?, ?, ?, ?
         FROM nen_photo_submissions
        WHERE id = ? AND line_account_id = ? AND review_version = ?`,
    ).bind(input.id, input.operation, input.actorId, input.idempotencyKey,
      input.requestFingerprint, now, input.photoId, input.lineAccountId, input.expectedVersion);
  const inserted = await statement.run();
  if (Number(inserted.meta?.changes ?? 0) !== 1) return { kind: 'changed' };
  const row = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(input.id).first<QueueRow>();
  if (!row) throw new Error(`created ${kind} run was not found`);
  return { kind: 'created', run: mapQueue(row) };
}

export function requestPhotoAssessment(
  db: D1Database,
  input: Parameters<typeof createQueuedRun>[2],
) {
  return createQueuedRun(db, 'assessment', input);
}

export function requestPhotoAssetProcessing(
  db: D1Database,
  input: Parameters<typeof createQueuedRun>[2] & { operation: 'review' | 'public' | 'thumbnail' | 'all' },
) {
  return createQueuedRun(db, 'asset', input);
}

export async function getPhotoAssetStatus(
  db: D1Database,
  input: { photoId: string; lineAccountId: string },
) {
  const subject = await getPhotoOperationSubject(db, input);
  if (!subject) return null;
  const jobs = await db.prepare(
    `SELECT * FROM nen_photo_asset_jobs
      WHERE photo_id = ? AND line_account_id = ? ORDER BY created_at DESC, id DESC LIMIT 50`,
  ).bind(input.photoId, input.lineAccountId).all<QueueRow>();
  return { reviewVersion: subject.reviewVersion, jobs: jobs.results.map(mapQueue) };
}

export async function getPhotoDerivatives(
  db: D1Database,
  input: { photoId: string; lineAccountId: string },
) {
  const subject = await getPhotoOperationSubject(db, input);
  if (!subject) return null;
  const rows = await db.prepare(
    `SELECT kind, source_version, r2_key, content_type, byte_size, width, height, created_at
       FROM nen_photo_derivatives
      WHERE photo_id = ? AND line_account_id = ? ORDER BY source_version DESC, kind`,
  ).bind(input.photoId, input.lineAccountId).all<{
    kind: string; source_version: number; r2_key: string; content_type: string;
    byte_size: number | null; width: number | null; height: number | null; created_at: string;
  }>();
  const recorded = rows.results.map((row) => ({
    kind: row.kind,
    sourceVersion: Number(row.source_version),
    objectKey: row.r2_key,
    contentType: row.content_type,
    byteSize: row.byte_size === null ? null : Number(row.byte_size),
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    createdAt: row.created_at,
  }));
  const knownUrls = [
    subject.reviewImageUrl ? { kind: 'review', url: subject.reviewImageUrl, sourceVersion: subject.reviewVersion } : null,
    subject.publicImageUrl ? { kind: 'public', url: subject.publicImageUrl, sourceVersion: subject.reviewVersion } : null,
  ].filter((value): value is NonNullable<typeof value> => value !== null);
  return { reviewVersion: subject.reviewVersion, items: recorded, knownUrls };
}

export type BulkPhotoDecision = {
  photoId: string;
  decision: 'approve' | 'return' | 'reject';
  expectedVersion: number;
  reasonCode: string | null;
  reasonNote: string | null;
};

export type BulkPhotoDecisionItem = {
  photoId: string;
  decision: 'approve' | 'return' | 'reject';
  reviewVersion: number;
  /** 審査イベントのID。一括後のLINE通知の送達記録と再送に使う。 */
  decisionId: string;
};

export type BulkPhotoDecisionResult = {
  updatedCount: number;
  items: BulkPhotoDecisionItem[];
};

export async function applyBulkPhotoDecisions(
  db: D1Database,
  input: {
    id: string;
    lineAccountId: string;
    actorId: string;
    actorName: string;
    idempotencyKey: string;
    requestFingerprint: string;
    decisions: BulkPhotoDecision[];
    now?: string;
  },
): Promise<{ kind: 'created' | 'duplicate'; result: unknown } | { kind: 'changed' | 'idempotency_conflict' | 'not_found' | 'risk_not_low'; photoId?: string }> {
  const previous = await db.prepare(
    `SELECT request_fingerprint, result_json FROM nen_photo_bulk_decision_receipts
      WHERE line_account_id = ? AND requested_by = ? AND idempotency_key = ?`,
  ).bind(input.lineAccountId, input.actorId, input.idempotencyKey).first<{
    request_fingerprint: string; result_json: string;
  }>();
  if (previous) {
    return previous.request_fingerprint === input.requestFingerprint
      ? { kind: 'duplicate', result: JSON.parse(previous.result_json) }
      : { kind: 'idempotency_conflict' };
  }
  const subjects = await Promise.all(input.decisions.map((decision) => getPhotoOperationSubject(db, {
    photoId: decision.photoId, lineAccountId: input.lineAccountId,
  })));
  for (let index = 0; index < input.decisions.length; index += 1) {
    const decision = input.decisions[index];
    const subject = subjects[index];
    if (!subject) return { kind: 'not_found', photoId: decision.photoId };
    if (subject.status !== 'pending' || subject.reviewVersion !== decision.expectedVersion) {
      return { kind: 'changed', photoId: decision.photoId };
    }
    if (decision.decision === 'approve' && !['safe', 'none', 'low'].includes(subject.latestRiskFlag ?? '')) {
      return { kind: 'risk_not_low', photoId: decision.photoId };
    }
  }
  // 単票と同じく、友だちの所属アカウントも審査確定の前に照合する。
  // 写真行だけ見ると、他アカウントへ移った友だちの写真を確定してしまう。
  {
    const friendIds = [...new Set(subjects.map((subject) => subject!.friendId))];
    const placeholders = sqlIdSet(friendIds).sql;
    const rows = await db.prepare(
      `SELECT id FROM friends WHERE id IN (${placeholders}) AND line_account_id = ?`,
    ).bind(...(friendIds.length ? sqlIdSet(friendIds).binds : []), input.lineAccountId).all<{ id: string }>();
    const visible = new Set(rows.results.map((row) => row.id));
    const mismatchIndex = subjects.findIndex((subject) => !visible.has(subject!.friendId));
    if (mismatchIndex >= 0) return { kind: 'not_found', photoId: input.decisions[mismatchIndex].photoId };
  }
  const now = input.now ?? new Date().toISOString();
  // 採用する時点の報酬の決まりを写す。版を変えても過去の付与は変わらない。
  const policy = await getEffectivePhotoRewardPolicy(db, now);
  // 同じ写真が2回採用されても、報酬は1回だけ。報酬つきで採用済みの
  // 重複がある写真は、点数を付けずに採用する。
  const duplicateFlags = await Promise.all(input.decisions.map((decision, index) => (
    decision.decision === 'approve'
      ? findRewardedAdoptedDuplicate(db, {
        contentHash: subjects[index]?.contentHash ?? null,
        lineAccountId: input.lineAccountId,
        excludePhotoId: decision.photoId,
      })
      : Promise.resolve(null)
  )));
  const eventIds = input.decisions.map(() => crypto.randomUUID());
  const result: BulkPhotoDecisionResult = {
    updatedCount: input.decisions.length,
    items: input.decisions.map((decision, index) => ({
      photoId: decision.photoId,
      decision: decision.decision,
      reviewVersion: decision.expectedVersion + 1,
      decisionId: eventIds[index],
    })),
  };
  const statements: D1PreparedStatement[] = [];
  for (let index = 0; index < input.decisions.length; index += 1) {
    const decision = input.decisions[index];
    const subject = subjects[index]!;
    const status = decision.decision === 'approve' ? 'adopted' : 'rejected';
    const eventId = eventIds[index];
    // 重複の二重報酬を止める。報酬つきで採用済みなら点数は付けない。
    const awarded = decision.decision === 'approve' && !duplicateFlags[index] ? policy.points : 0;
    statements.push(db.prepare(
      `INSERT INTO nen_photo_review_events
        (id, photo_id, line_account_id, from_status, to_status, reason_code, reason_note,
         awarded_points, reviewed_by, reviewed_by_name, notification_status, created_at, updated_at)
       SELECT ?, id, line_account_id, 'pending', ?, ?, ?, ?, ?, ?, 'pending', ?, ?
         FROM nen_photo_submissions
        WHERE id = ? AND line_account_id = ? AND status = 'pending' AND review_version = ?`,
    ).bind(eventId, status, decision.reasonCode, decision.reasonNote,
      awarded, input.actorId, input.actorName,
      now, now, decision.photoId, input.lineAccountId, decision.expectedVersion));
    statements.push(db.prepare(
      `UPDATE nen_photo_submissions
          SET status = ?, awarded_points = ?, review_reason_code = ?, review_reason_note = ?,
              reviewed_by = ?, reviewed_by_name = ?, review_notification_status = 'pending',
              reviewed_at = ?, review_version = review_version + 1, updated_at = ?
        WHERE id = ? AND line_account_id = ? AND status = 'pending' AND review_version = ?`,
    ).bind(status, awarded, decision.reasonCode, decision.reasonNote,
      input.actorId, input.actorName, now, now, decision.photoId, input.lineAccountId, decision.expectedVersion));
    if (decision.decision === 'approve' && awarded > 0 && subject.customerId) {
      statements.push(db.prepare(
        `INSERT INTO nen_photo_reward_outbox
          (id, photo_id, line_account_id, friend_id, customer_id, provider_award_key,
           policy_version, points, status, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      ).bind(crypto.randomUUID(), decision.photoId, input.lineAccountId, subject.friendId,
        subject.customerId, `nen-photo:${decision.photoId}`, policy.policyKey, awarded, now, now, now));
    }
  }
  statements.push(db.prepare(
    `INSERT INTO nen_photo_bulk_decision_receipts
      (id, line_account_id, requested_by, idempotency_key, request_fingerprint, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(input.id, input.lineAccountId, input.actorId, input.idempotencyKey,
    input.requestFingerprint, JSON.stringify(result), now));
  try {
    const outcomes = await db.batch(statements);
    if (outcomes.slice(0, -1).some((outcome) => Number(outcome.meta?.changes ?? 0) !== 1)) {
      return { kind: 'changed' };
    }
  } catch (error) {
    if (String(error).includes('UNIQUE constraint')) return { kind: 'changed' };
    throw error;
  }
  return { kind: 'created', result };
}

/**
 * 一括審査の受付票へ通知後の結果を上書きする。
 * 同じ再実行鍵の再送時はこの保存済み結果を返すだけで、LINEを再送しない。
 */
export type BulkNotifiedItem = BulkPhotoDecisionItem & {
  notificationStatus: 'sent' | 'failed';
  notificationError?: string;
};

export type BulkNotificationResult = {
  updatedCount: number;
  items: BulkNotifiedItem[];
  notificationFailures: Array<{ photoId: string; error: string }>;
  reconciled?: boolean;
};

export async function recordBulkDecisionNotificationResult(
  db: D1Database,
  input: {
    receiptId: string;
    lineAccountId: string;
    actorId: string;
    idempotencyKey: string;
    result: BulkNotificationResult;
    now?: string;
    /**
     * 通知前の受付票だけ上書きするCAS。送達台帳からの復旧用。
     * 並行する確定側の新しい結果を、古い復旧結果で上書きしない。
     */
    onlyIfPending?: boolean;
  },
): Promise<boolean> {
  const now = input.now ?? new Date().toISOString();
  const updated = input.onlyIfPending
    ? await db.prepare(
      `UPDATE nen_photo_bulk_decision_receipts
          SET result_json = ?, created_at = ?
        WHERE id = ? AND line_account_id = ? AND requested_by = ? AND idempotency_key = ?
          AND json_extract(result_json, '$.items[0].notificationStatus') IS NULL`,
    ).bind(
      JSON.stringify(input.result), now,
      input.receiptId, input.lineAccountId, input.actorId, input.idempotencyKey,
    ).run()
    : await db.prepare(
      `UPDATE nen_photo_bulk_decision_receipts
          SET result_json = ?, created_at = ?
        WHERE id = ? AND line_account_id = ? AND requested_by = ? AND idempotency_key = ?`,
    ).bind(
      JSON.stringify(input.result), now,
      input.receiptId, input.lineAccountId, input.actorId, input.idempotencyKey,
    ).run();
  return Number(updated.meta?.changes ?? 0) === 1;
}

export type PhotoNotificationStatus = 'pending' | 'sending' | 'sent' | 'failed';

export type PhotoNotificationState = {
  decisionId: string;
  status: PhotoNotificationStatus;
  error: string | null;
  generation: number;
  leaseId: string | null;
  leaseExpiresAt: string | null;
  attemptCount: number;
};

type PhotoNotificationStateRow = {
  id: string;
  notification_status: PhotoNotificationStatus;
  notification_error: string | null;
  notification_generation: number;
  notification_lease_id: string | null;
  notification_lease_expires_at: string | null;
  notification_attempt_count: number;
};

function mapNotificationState(row: PhotoNotificationStateRow): PhotoNotificationState {
  return {
    decisionId: row.id,
    status: row.notification_status,
    error: row.notification_error,
    generation: Number(row.notification_generation),
    leaseId: row.notification_lease_id,
    leaseExpiresAt: row.notification_lease_expires_at,
    attemptCount: Number(row.notification_attempt_count),
  };
}

const NOTIFICATION_STATE_COLUMNS = `id, notification_status, notification_error,
  notification_generation, notification_lease_id, notification_lease_expires_at,
  notification_attempt_count`;

export async function getBulkDecisionReceipt(
  db: D1Database,
  input: { lineAccountId: string; actorId: string; idempotencyKey: string },
): Promise<{ receiptId: string; result: unknown } | null> {
  const row = await db.prepare(
    `SELECT id, result_json FROM nen_photo_bulk_decision_receipts
      WHERE line_account_id = ? AND requested_by = ? AND idempotency_key = ?`,
  ).bind(input.lineAccountId, input.actorId, input.idempotencyKey)
    .first<{ id: string; result_json: string }>();
  if (!row) return null;
  try {
    return { receiptId: row.id, result: JSON.parse(row.result_json) };
  } catch {
    return { receiptId: row.id, result: null };
  }
}

export async function getPhotoNotificationState(
  db: D1Database,
  input: { decisionId: string; lineAccountId: string },
): Promise<PhotoNotificationState | null> {
  const row = await db.prepare(
    `SELECT ${NOTIFICATION_STATE_COLUMNS} FROM nen_photo_review_events
      WHERE id = ? AND line_account_id = ?`,
  ).bind(input.decisionId, input.lineAccountId).first<PhotoNotificationStateRow>();
  return row ? mapNotificationState(row) : null;
}

/*
 * 通知の送信権を取る。未送信・失敗済み・lease切れの送信中だけ送り手になれる。
 * 同じ行を同時に取り合っても、条件付き更新で勝者は1人になる。
 */
export async function claimPhotoNotificationDelivery(
  db: D1Database,
  input: {
    decisionId: string;
    lineAccountId: string;
    leaseId: string;
    leaseExpiresAt: string;
    now?: string;
  },
): Promise<{ generation: number } | null> {
  const now = input.now ?? new Date().toISOString();
  const row = await db.prepare(
    `UPDATE nen_photo_review_events
        SET notification_status = 'sending',
            notification_lease_id = ?, notification_lease_expires_at = ?,
            notification_generation = notification_generation + 1,
            notification_attempt_count = notification_attempt_count + 1,
            updated_at = ?
      WHERE id = ? AND line_account_id = ?
        AND photo_id IS NOT NULL
        AND (notification_status IN ('pending', 'failed')
          OR (notification_status = 'sending'
            AND (notification_lease_expires_at IS NULL OR notification_lease_expires_at <= ?)))
      RETURNING notification_generation`,
  ).bind(
    input.leaseId, input.leaseExpiresAt, now,
    input.decisionId, input.lineAccountId, now,
  ).first<{ notification_generation: number }>();
  return row ? { generation: Number(row.notification_generation) } : null;
}

/*
 * 送信結果を確定する。取った世代と一致し、まだ送信中のときだけ書く。
 * 遅れて届いた失敗が、ほかの処理の成功を上書きしないための条件。
 */
export async function completePhotoNotificationDelivery(
  db: D1Database,
  input: {
    decisionId: string;
    lineAccountId: string;
    generation: number;
    status: 'sent' | 'failed';
    error?: string | null;
    now?: string;
  },
): Promise<boolean> {
  const now = input.now ?? new Date().toISOString();
  const updated = input.status === 'sent'
    ? await db.prepare(
      `UPDATE nen_photo_review_events
          SET notification_status = 'sent', notification_error = NULL,
              notification_lease_id = NULL, notification_lease_expires_at = NULL,
              notification_sent_at = ?, updated_at = ?
        WHERE id = ? AND line_account_id = ?
          AND notification_status = 'sending' AND notification_generation = ?`,
    ).bind(now, now, input.decisionId, input.lineAccountId, input.generation).run()
    : await db.prepare(
      `UPDATE nen_photo_review_events
          SET notification_status = 'failed', notification_error = ?,
              notification_lease_id = NULL, notification_lease_expires_at = NULL,
              notification_first_failed_at = COALESCE(notification_first_failed_at, ?),
              updated_at = ?
        WHERE id = ? AND line_account_id = ?
          AND notification_status = 'sending' AND notification_generation = ?`,
    ).bind(
      input.error ?? '審査結果をLINEで通知できませんでした', now, now,
      input.decisionId, input.lineAccountId, input.generation,
    ).run();
  return Number(updated.meta?.changes ?? 0) === 1;
}

/*
 * 受付票の結果を送達台帳から作り直す。通知後の記録に失敗して受付票が
 * 古いままのとき、同じ再実行鍵の再送で結果を復旧するために使う。
 */
export async function reconcileBulkNotificationOutcomes(
  db: D1Database,
  input: {
    lineAccountId: string;
    items: BulkPhotoDecisionItem[];
  },
): Promise<Pick<BulkNotificationResult, 'items' | 'notificationFailures'>> {
  const notified: BulkNotifiedItem[] = [];
  const notificationFailures: Array<{ photoId: string; error: string }> = [];
  for (const item of input.items) {
    const state = await getPhotoNotificationState(db, {
      decisionId: item.decisionId, lineAccountId: input.lineAccountId,
    });
    let notificationStatus: 'sent' | 'failed';
    let notificationError: string | undefined;
    if (!state) {
      notificationStatus = 'failed';
      notificationError = '送達の記録が見つかりません。再送してください。';
    } else if (state.status === 'sent') {
      notificationStatus = 'sent';
    } else if (state.status === 'failed') {
      notificationStatus = 'failed';
      notificationError = state.error ?? '審査結果をLINEで通知できませんでした';
    } else if (state.status === 'sending') {
      notificationStatus = 'failed';
      notificationError = '送達を確認中です。しばらくしてから再送してください。';
    } else {
      notificationStatus = 'failed';
      notificationError = '通知はまだ送られていません。再送してください。';
    }
    notified.push({
      ...item, notificationStatus,
      ...(notificationError ? { notificationError } : {}),
    });
    if (notificationStatus === 'failed' && notificationError) {
      notificationFailures.push({ photoId: item.photoId, error: notificationError });
    }
  }
  return { items: notified, notificationFailures };
}

export async function issuePhotoOriginalDownload(
  db: D1Database,
  input: {
    tokenHash: string;
    photoId: string;
    lineAccountId: string;
    actorId: string;
    expectedVersion: number;
    idempotencyKey: string;
    requestFingerprint: string;
    expiresAt: string;
    now?: string;
  },
): Promise<{ kind: 'created' | 'duplicate'; expiresAt: string } | { kind: 'changed' | 'idempotency_conflict' | 'not_found' }> {
  const activeAccount = await db.prepare(`SELECT a.id FROM line_accounts a LEFT JOIN tenants t ON t.id=a.tenant_id
    WHERE a.id=? AND a.data_purged_at IS NULL AND (a.tenant_id IS NULL OR (t.id IS NOT NULL AND t.purge_started_at IS NULL AND t.data_purged_at IS NULL))`)
    .bind(input.lineAccountId).first<{id:string}>();
  if (!activeAccount) return {kind:'not_found'};
  const previous = await db.prepare(
    `SELECT request_fingerprint FROM nen_photo_original_download_grants
      WHERE line_account_id = ? AND requested_by = ? AND idempotency_key = ?`,
  ).bind(input.lineAccountId, input.actorId, input.idempotencyKey).first<{ request_fingerprint: string }>();
  const now = input.now ?? new Date().toISOString();
  if (previous) {
    if (previous.request_fingerprint !== input.requestFingerprint) return { kind: 'idempotency_conflict' };
    const renewed = await db.prepare(
      `UPDATE nen_photo_original_download_grants
          SET token_hash = ?, expires_at = ?, consumed_at = NULL, created_at = ?
        WHERE line_account_id = ? AND requested_by = ? AND idempotency_key = ?
          AND EXISTS (SELECT 1 FROM line_accounts a LEFT JOIN tenants t ON t.id=a.tenant_id
            WHERE a.id=nen_photo_original_download_grants.line_account_id AND a.data_purged_at IS NULL
              AND (a.tenant_id IS NULL OR (t.id IS NOT NULL AND t.purge_started_at IS NULL AND t.data_purged_at IS NULL)))`,
    ).bind(input.tokenHash, input.expiresAt, now, input.lineAccountId, input.actorId, input.idempotencyKey).run();
    return Number(renewed.meta?.changes ?? 0) === 1 ? { kind: 'duplicate', expiresAt: input.expiresAt } : {kind:'not_found'};
  }
  const subject = await getPhotoOperationSubject(db, input);
  if (!subject) return { kind: 'not_found' };
  if (subject.reviewVersion !== input.expectedVersion) return { kind: 'changed' };
  const inserted = await db.prepare(
    `INSERT INTO nen_photo_original_download_grants
      (token_hash, photo_id, line_account_id, requested_by, requested_version,
       idempotency_key, request_fingerprint, expires_at, created_at)
     SELECT ?, id, line_account_id, ?, review_version, ?, ?, ?, ?
       FROM nen_photo_submissions
      WHERE id = ? AND line_account_id = ? AND review_version = ?
        AND EXISTS (SELECT 1 FROM line_accounts a LEFT JOIN tenants t ON t.id=a.tenant_id
          WHERE a.id=nen_photo_submissions.line_account_id AND a.data_purged_at IS NULL
            AND (a.tenant_id IS NULL OR (t.id IS NOT NULL AND t.purge_started_at IS NULL AND t.data_purged_at IS NULL)))`,
  ).bind(input.tokenHash, input.actorId, input.idempotencyKey, input.requestFingerprint,
    input.expiresAt, now, input.photoId, input.lineAccountId, input.expectedVersion).run();
  if (Number(inserted.meta?.changes ?? 0) !== 1) return { kind: 'changed' };
  await db.prepare(
    `INSERT INTO nen_photo_original_download_audit
      (id, photo_id, line_account_id, requested_by, event, created_at)
     VALUES (?, ?, ?, ?, 'issued', ?)`,
  ).bind(crypto.randomUUID(), input.photoId, input.lineAccountId, input.actorId, now).run();
  return { kind: 'created', expiresAt: input.expiresAt };
}

export async function consumePhotoOriginalDownload(
  db: D1Database,
  input: { tokenHash: string; lineAccountId: string; actorId: string; now?: string },
): Promise<{ photoId: string; objectKey: string; contentType: string } | null> {
  const now = input.now ?? new Date().toISOString();
  const grant = await db.prepare(
    `UPDATE nen_photo_original_download_grants SET consumed_at = ?
      WHERE token_hash = ? AND line_account_id = ? AND requested_by = ?
        AND photo_id IS NOT NULL AND consumed_at IS NULL AND expires_at > ?
        AND EXISTS (SELECT 1 FROM line_accounts a LEFT JOIN tenants t ON t.id=a.tenant_id
          WHERE a.id=nen_photo_original_download_grants.line_account_id AND a.data_purged_at IS NULL
            AND (a.tenant_id IS NULL OR (t.id IS NOT NULL AND t.purge_started_at IS NULL AND t.data_purged_at IS NULL)))
      RETURNING photo_id`,
  ).bind(now, input.tokenHash, input.lineAccountId, input.actorId, now).first<{ photo_id: string }>();
  if (!grant) return null;
  const photo = await db.prepare(
    `SELECT r2_key, content_type FROM nen_photo_submissions
      WHERE id = ? AND line_account_id = ?`,
  ).bind(grant.photo_id, input.lineAccountId).first<{ r2_key: string; content_type: string }>();
  if (!photo) return null;
  await db.prepare(
    `INSERT INTO nen_photo_original_download_audit
      (id, photo_id, line_account_id, requested_by, event, created_at)
     VALUES (?, ?, ?, ?, 'downloaded', ?)`,
  ).bind(crypto.randomUUID(), grant.photo_id, input.lineAccountId, input.actorId, now).run();
  return { photoId: grant.photo_id, objectKey: photo.r2_key, contentType: photo.content_type };
}
