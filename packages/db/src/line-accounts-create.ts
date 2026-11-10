import { jstNow } from './utils.js';
import { DEFAULT_TENANT_ID, SPECIALIZED_CATALOG_SETTING_KEY } from '@line-crm/shared';
import { encryptCredential } from './credential-crypto.js';
import { type CreateLineAccountInput, type LineAccount, type LineAccountConnectionCheck, type SaveLineAccountConnectionChecksInput } from './line-accounts-types.js';
import { resolveCredentialEncryptionKey } from './line-accounts-credentials.js';
import { getLineAccountById } from './line-accounts-reads.js';


export async function createLineAccount(
  db: D1Database,
  input: CreateLineAccountInput,
  credentialEncryptionKey?: string,
): Promise<LineAccount> {
  const id = crypto.randomUUID();
  const now = jstNow();

  // Auto-fill display_order to (max existing + 1) so new accounts go to the end.
  // COALESCE handles the empty-table case: -1 + 1 = 0.
  const orderRow = await db
    .prepare(`SELECT COALESCE(MAX(display_order), -1) + 1 AS next FROM line_accounts`)
    .first<{ next: number }>();
  const displayOrder = orderRow?.next ?? 0;
  const encryptionKey = await resolveCredentialEncryptionKey(credentialEncryptionKey);
  const [encryptedAccessToken, encryptedChannelSecret, encryptedLoginSecret] = await Promise.all([
    encryptCredential(input.channelAccessToken, encryptionKey),
    encryptCredential(input.channelSecret, encryptionKey),
    input.loginChannelSecret ? encryptCredential(input.loginChannelSecret, encryptionKey) : null,
  ]);

  const accountInsert = db
    .prepare(
      `INSERT INTO line_accounts
         (id, channel_id, name, channel_access_token, channel_secret,
          channel_access_token_encrypted, channel_secret_encrypted,
          channel_access_token_updated_at, channel_secret_updated_at,
          login_channel_secret_updated_at,
          login_channel_id, login_channel_secret, login_channel_secret_encrypted, liff_id,
          is_active, is_default, display_order,
          og_site_name, og_default_image_url, og_default_description,
          official_profile_url, timezone, country, role,
          parent_line_account_id, tenant_id,
          line_display_name, line_picture_url, line_basic_id, line_profile_synced_at,
          created_by_staff_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         CASE WHEN EXISTS (
           SELECT 1 FROM line_accounts
            WHERE COALESCE(tenant_id, ?) = ? AND archived_at IS NULL
          ) THEN 0 ELSE 1 END,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.channelId,
      input.name,
      input.channelAccessToken,
      input.channelSecret,
      encryptedAccessToken,
      encryptedChannelSecret,
      now,
      now,
      input.loginChannelSecret ? now : null,
      input.loginChannelId ?? null,
      // 平文の列には書かない。値は暗号化列だけに置く（-33 §19-2）。
      null,
      encryptedLoginSecret,
      input.liffId ?? null,
      input.initialActive === false ? 0 : 1,
      DEFAULT_TENANT_ID,
      input.tenantId ?? DEFAULT_TENANT_ID,
      displayOrder,
      input.ogSiteName ?? null,
      input.ogDefaultImageUrl ?? null,
      input.ogDefaultDescription ?? null,
      input.officialProfileUrl ?? null,
      input.timezone ?? 'Asia/Tokyo',
      input.country ?? null,
      input.role ?? null,
      input.parentLineAccountId ?? null,
      input.tenantId ?? DEFAULT_TENANT_ID,
      input.lineDisplayName ?? null,
      input.linePictureUrl ?? null,
      input.lineBasicId ?? null,
      input.lineProfileSyncedAt ?? null,
      input.createdByStaffId ?? null,
      now,
      now,
    );

  // テナントに関係なく、今後作成する店舗アカウントへ然専用機能は渡さない。
  // 既存アカウントは書き換えず、作成と初期設定を同一トランザクションにする。
  await db.batch([
    accountInsert,
    db.prepare(`INSERT INTO account_settings (id, line_account_id, key, value, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)`).bind(
      crypto.randomUUID(), id, SPECIALIZED_CATALOG_SETTING_KEY, '[]', now, now,
    ),
  ]);

  return (await getLineAccountById(db, id, encryptionKey))!;
}

export class LineAccountRevisionConflictError extends Error {
  constructor() {
    super('REVISION_CONFLICT');
    this.name = 'LineAccountRevisionConflictError';
  }
}

export async function getLineAccountConnectionChecksByIdempotencyKey(
  db: D1Database,
  lineAccountId: string,
  idempotencyKey: string,
): Promise<LineAccountConnectionCheck[]> {
  const result = await db
    .prepare(
      `SELECT * FROM line_account_connection_checks
        WHERE line_account_id = ? AND idempotency_key = ?
        ORDER BY CASE check_kind
          WHEN 'bot_info' THEN 1
          WHEN 'webhook_endpoint' THEN 2
          WHEN 'webhook_test' THEN 3
          WHEN 'liff_config' THEN 4
          ELSE 5 END`,
    )
    .bind(lineAccountId, idempotencyKey)
    .all<LineAccountConnectionCheck>();
  return result.results;
}

/**
 * Saves one complete check run and advances the account revision in one D1 batch.
 * Each INSERT requires the preceding statement to have written one row: first
 * the guarded UPDATE, then the preceding check INSERT. A rejected UPDATE therefore
 * keeps changes at zero throughout the batch, even if another run owns nextRevision.
 */
export async function saveLineAccountConnectionChecks(
  db: D1Database,
  input: SaveLineAccountConnectionChecksInput,
): Promise<LineAccountConnectionCheck[]> {
  const nextRevision = input.expectedRevision + 1;
  const statements = [
    db.prepare(
      `UPDATE line_accounts
          SET revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND archived_at IS NULL`,
    ).bind(input.checkedAt, input.lineAccountId, input.expectedRevision),
    db.prepare(`SELECT json(CASE WHEN changes()=1 THEN '{}' ELSE 'LINE_ACCOUNT_REVISION_CONFLICT' END)`),
    ...input.checks.map((check) => db.prepare(
      `INSERT INTO line_account_connection_checks (
         id, line_account_id, check_kind, result, expected_url, registered_url,
         webhook_active, http_status, checked_by, checked_at, correlation_id,
         idempotency_key, account_revision
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE changes() = 1 AND EXISTS (
          SELECT 1 FROM line_accounts
           WHERE id = ? AND revision = ? AND archived_at IS NULL
        )`,
    ).bind(
      crypto.randomUUID(),
      input.lineAccountId,
      check.kind,
      check.result,
      check.expectedUrl ?? null,
      check.registeredUrl ?? null,
      check.webhookActive == null ? null : (check.webhookActive ? 1 : 0),
      check.httpStatus ?? null,
      input.checkedBy,
      input.checkedAt,
      input.correlationId,
      input.idempotencyKey,
      nextRevision,
      input.lineAccountId,
      nextRevision,
    )),
  ];
  let results: D1Result[];
  try { results = await db.batch(statements); }
  catch (error) {
    if (error instanceof Error && /malformed JSON/i.test(error.message)) throw new LineAccountRevisionConflictError();
    throw error;
  }
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    throw new LineAccountRevisionConflictError();
  }
  return getLineAccountConnectionChecksByIdempotencyKey(
    db,
    input.lineAccountId,
    input.idempotencyKey,
  );
}
