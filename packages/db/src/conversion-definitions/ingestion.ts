import { jstNow } from '../utils.js';
import { encryptWebhookSecret, resolveWebhookSecret } from '../webhooks.js';
import { type WebhookKeyInput } from '../webhooks-types.js';
import { type ConversionDefinitionScope, type IngestPointRow, type ConversionIngestionEvent, type IngestionEventRow } from './types.js';
import { currentDefinitionForMutation, requireExpectedDefinition } from './revisions.js';
import { ConversionDefinitionError } from './reads.js';


/** 受信鍵の発行・再発行。再発行は古い鍵をその場で無効にする。 */
export async function issueConversionIngestSecret(
  db: D1Database,
  input: {
    id: string;
    scope: ConversionDefinitionScope;
    expectedVersion: number;
    staffId: string;
    keys?: WebhookKeyInput;
  },
) {
  const current = await currentDefinitionForMutation(db, input.id, input.scope);
  requireExpectedDefinition(current, input.expectedVersion);
  const plaintext = `cvwhk_${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const encrypted = await encryptWebhookSecret(plaintext, input.keys);
  const now = jstNow();
  const result = await db
    .prepare(`UPDATE conversion_points SET ingest_secret_encrypted = ?, ingest_disabled_at = NULL,
      updated_at = ?, version = version + 1
      WHERE id = ? AND version = ? AND status = 'active'`)
    .bind(encrypted, now, input.id, input.expectedVersion)
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new ConversionDefinitionError('version_conflict', '成果地点が更新されています。読み直してください', 409);
  }
  return { id: input.id, secret: plaintext, version: input.expectedVersion + 1 };
}

/**
 * 外部受信の停止・再開。鍵は消さないので、再開すると同じ鍵でまた受けられる。
 * 「止める」は status ではなく ingest_disabled_at で表す。地点自体は
 * 内部起点からの計測を続けられるため。
 */
export async function setConversionIngestDisabled(
  db: D1Database,
  input: {
    id: string;
    scope: ConversionDefinitionScope;
    expectedVersion: number;
    disabled: boolean;
    staffId: string;
  },
) {
  const current = await currentDefinitionForMutation(db, input.id, input.scope);
  requireExpectedDefinition(current, input.expectedVersion);
  const now = jstNow();
  const result = await db
    .prepare(`UPDATE conversion_points SET ingest_disabled_at = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND version = ? AND status = 'active'`)
    .bind(input.disabled ? now : null, now, input.id, input.expectedVersion)
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new ConversionDefinitionError('version_conflict', '成果地点が更新されています。読み直してください', 409);
  }
  return { id: input.id, disabledAt: input.disabled ? now : null, version: input.expectedVersion + 1 };
}

/** 公開受信口が使う地点の最小限の行。スコープ検査は署名の後で行う。 */
export async function getConversionPointForIngest(
  db: D1Database,
  id: string,
): Promise<IngestPointRow | null> {
  return db.prepare(`SELECT id, status, line_account_id, tenant_id, ingest_secret_encrypted, ingest_disabled_at
    FROM conversion_points WHERE id = ?`).bind(id).first<IngestPointRow>();
}

/**
 * 保存した受信鍵を復号する。照合の直前だけ呼ぶ。
 * 鍵不足・復号失敗は例外(fail-closed)。未設定なら null。
 */
export async function resolveConversionIngestSecret(
  row: IngestPointRow,
  keys?: WebhookKeyInput,
): Promise<string | null> {
  return resolveWebhookSecret(
    { id: row.id, secret: null, secret_encrypted: row.ingest_secret_encrypted },
    keys,
  );
}

/** 受信の成否を1件残す。台帳の失敗で受信処理そのものを止めないよう呼び側で握る。 */
export async function recordConversionIngestionEvent(
  db: D1Database,
  input: {
    conversionPointId: string;
    result: 'recorded' | 'duplicate' | 'rejected';
    reason?: string | null;
    /** 検証の受信なら true。成果表には書かない受信の目印。 */
    isTest?: boolean;
    sourceEventId?: string | null;
    friendId?: string | null;
    payloadShape?: Record<string, unknown> | null;
    signatureSha256?: string | null;
  },
): Promise<void> {
  await db.prepare(`INSERT INTO conversion_ingestion_events
    (id, conversion_point_id, result, reason, is_test, source_event_id, friend_id,
     payload_shape_json, signature_sha256, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      crypto.randomUUID(),
      input.conversionPointId,
      input.result,
      input.reason ?? null,
      input.isTest ? 1 : 0,
      input.sourceEventId ?? null,
      input.friendId ?? null,
      input.payloadShape ? JSON.stringify(input.payloadShape) : null,
      input.signatureSha256 ?? null,
      jstNow(),
    )
    .run();
}

/** 詳細画面・診断用の受信履歴。新しい順。 */
export async function listConversionIngestionEvents(
  db: D1Database,
  input: { id: string; scope: ConversionDefinitionScope; limit?: number },
): Promise<ConversionIngestionEvent[] | null> {
  const current = await currentDefinitionForMutation(db, input.id, input.scope);
  if (!current) return null;
  const limit = Math.min(100, Math.max(1, input.limit ?? 50));
  const rows = await db.prepare(`SELECT * FROM conversion_ingestion_events
    WHERE conversion_point_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(input.id, limit)
    .all<IngestionEventRow>();
  return rows.results.map((row) => ({
    id: row.id,
    conversionPointId: row.conversion_point_id,
    result: row.result,
    reason: row.reason,
    isTest: row.is_test === 1,
    sourceEventId: row.source_event_id,
    friendId: row.friend_id,
    payloadShape: row.payload_shape_json
      ? JSON.parse(row.payload_shape_json) as Record<string, unknown>
      : null,
    signatureSha256: row.signature_sha256,
    createdAt: row.created_at,
  }));
}
