import { readFolderAssignment, FolderAssignmentError } from '@line-crm/db';

import { CommonActionValidationError, requiredString, validateActionShape, type CommonActionRow, parseStoredActions, requiredDraftRevision, type VersionRow, collectReferenceDrifts, type CommonActionVersion, type CommonActionBinding } from './common-actions-is-record.js';
import { pinAndValidateReferences, assertPublishableExpansion } from './common-actions-pin-and-validate-references.js';

/*
 * 監査 : 保存確定後の応答消失からの再試行で二重作成にしない。
 * 作成画面が初回から再試行まで同じ鍵を送り、鍵が同じ要求は最初の作成を返す。
 */
export async function findByRequestKey(
  db: D1Database,
  lineAccountId: string,
  requestKey: string,
): Promise<{ id: string; draftVersionId: string; versionNumber: number } | null> {
  const row = await db.prepare(
    `SELECT ca.id AS id, ca.current_draft_version_id AS draft_id, cav.version_number AS version_number
       FROM common_actions ca
       JOIN common_action_versions cav ON cav.id = ca.current_draft_version_id
      WHERE ca.line_account_id = ? AND ca.client_request_key = ?`,
  ).bind(lineAccountId, requestKey).first<{
    id: string; draft_id: string | null; version_number: number | null;
  }>();
  if (!row || !row.draft_id) return null;
  return { id: row.id, draftVersionId: row.draft_id, versionNumber: Number(row.version_number ?? 1) };
}

export function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('UNIQUE constraint failed');
}

export async function commonActionFolder(db: D1Database, accountId: string, value: unknown) {
  try { return await readFolderAssignment(db, 'common_action', accountId, value); }
  catch (error) {
    if (error instanceof FolderAssignmentError) throw new CommonActionValidationError(error.code, error.message, 'folderId');
    throw error;
  }
}

export async function createCommonAction(
  db: D1Database,
  input: {
    lineAccountId: string; name: unknown; description?: unknown; actions: unknown;
    createdBy?: string | null; clientRequestKey?: unknown; folderId?: unknown;
  },
): Promise<{ id: string; draftVersionId: string; versionNumber: number }> {
  const folderId = await commonActionFolder(db, input.lineAccountId, input.folderId);
  // 同じ鍵の再試行は最初の作成へ戻す。鍵なしの従来の作成は今の動きのまま。
  const requestKey = input.clientRequestKey === undefined || input.clientRequestKey === null
    ? null
    : requiredString(input.clientRequestKey, 'clientRequestKey', '作成の再試行鍵');
  if (requestKey) {
    const existing = await findByRequestKey(db, input.lineAccountId, requestKey);
    if (existing) return existing;
  }
  const name = requiredString(input.name, 'name', '共通アクション名');
  if (name.length > 120) throw new CommonActionValidationError('name_too_long', '共通アクション名は120文字までです', 'name');
  const description = typeof input.description === 'string' && input.description.trim()
    ? input.description.trim()
    : null;
  const id = crypto.randomUUID();
  // 監査 : 参照先は保存時に公開版へ固定する（表示と保存値を一致させる）。
  const actions = await pinAndValidateReferences(
    db, input.lineAccountId, id, validateActionShape(input.actions),
  );
  const versionId = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO common_actions
           (id, line_account_id, name, description, status, client_request_key, created_by, created_at, updated_at, folder_id)
         VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
      ).bind(id, input.lineAccountId, name, description, requestKey, input.createdBy ?? null, now, now, folderId ?? null),
      db.prepare(
        `INSERT INTO common_action_versions
           (id, common_action_id, version_number, status, action_config, created_by, created_at)
         VALUES (?, ?, 1, 'draft', ?, ?, ?)`,
      ).bind(versionId, id, JSON.stringify(actions), input.createdBy ?? null, now),
      db.prepare(
        `UPDATE common_actions SET current_draft_version_id = ? WHERE id = ?`,
      ).bind(versionId, id),
    ]);
  } catch (error) {
    // 同時到達で先に作られていたら、作り直さず最初の作成へ戻す。
    if (requestKey && isUniqueViolation(error)) {
      const existing = await findByRequestKey(db, input.lineAccountId, requestKey);
      if (existing) return existing;
    }
    throw error;
  }
  return { id, draftVersionId: versionId, versionNumber: 1 };
}

export async function getOwnedAction(db: D1Database, id: string, lineAccountId: string): Promise<CommonActionRow | null> {
  return db.prepare(
    `SELECT id, folder_id, line_account_id, name, description, status, current_draft_version_id,
            current_published_version_id, created_at, updated_at
       FROM common_actions WHERE id = ? AND line_account_id = ?`,
  ).bind(id, lineAccountId).first<CommonActionRow>();
}

export async function duplicateCommonAction(
  db: D1Database,
  input: { id: string; lineAccountId: string; createdBy?: string | null },
): Promise<{ id: string; draftVersionId: string; versionNumber: number }> {
  const owner = await getOwnedAction(db, input.id, input.lineAccountId);
  if (!owner) throw new CommonActionValidationError('not_found', '複製する共通アクションが見つかりません');
  const sourceId = owner.current_draft_version_id ?? owner.current_published_version_id;
  if (!sourceId) throw new CommonActionValidationError('source_version_not_found', '複製する内容が見つかりません');
  const source = await db.prepare(
    `SELECT action_config FROM common_action_versions
      WHERE id = ? AND common_action_id = ?`,
  ).bind(sourceId, owner.id).first<{ action_config: string }>();
  if (!source) throw new CommonActionValidationError('source_version_not_found', '複製する内容が見つかりません');
  return createCommonAction(db, {
    lineAccountId: input.lineAccountId,
    name: `${owner.name.slice(0, 114)} のコピー`,
    description: owner.description,
    actions: parseStoredActions(source.action_config),
    createdBy: input.createdBy,
  });
}

export async function updateCommonActionDraft(
  db: D1Database,
  input: {
    id: string; lineAccountId: string; expectedDraftVersionId: unknown;
    expectedDraftRevision: unknown;
    name: unknown; description?: unknown; actions: unknown; folderId?: unknown;
  },
): Promise<void> {
  const folderId = await commonActionFolder(db, input.lineAccountId, input.folderId);
  const owner = await getOwnedAction(db, input.id, input.lineAccountId);
  if (!owner) throw new CommonActionValidationError('not_found', '共通アクションが見つかりません');
  const expected = requiredString(input.expectedDraftVersionId, 'expectedDraftVersionId', '編集中の版');
  if (!owner.current_draft_version_id || owner.current_draft_version_id !== expected) {
    throw new CommonActionValidationError('version_conflict', '別の人が新版を作りました。再読み込みしてください');
  }
  // 監査 : 版IDは編集を重ねても変わらない。改訂番号で先行保存を検知する。
  const expectedRevision = requiredDraftRevision(input.expectedDraftRevision);
  const name = requiredString(input.name, 'name', '共通アクション名');
  const description = typeof input.description === 'string' && input.description.trim()
    ? input.description.trim()
    : null;
  // 監査 : 参照先は保存時に公開版へ固定する（表示と保存値を一致させる）。
  const actions = await pinAndValidateReferences(
    db, input.lineAccountId, owner.id, validateActionShape(input.actions),
  );
  const now = new Date().toISOString();
  /*
   * 監査 : 2文とも改訂番号で条件付けし、競合時はどちらも
   * 書き換えない。親行を先に触り、版行の番号上げは後に回す。
   * 逆順にすると成功時でも親行の条件が新しい番号を見て外れる。
   */
  const result = await db.batch([
    db.prepare(
      `UPDATE common_actions SET name = ?, description = ?, updated_at = ?,
            folder_id = CASE WHEN ? THEN ? ELSE folder_id END
        WHERE id = ? AND line_account_id = ? AND current_draft_version_id = ?
          AND EXISTS (
            SELECT 1 FROM common_action_versions
             WHERE id = ? AND common_action_id = ? AND status = 'draft'
               AND draft_revision = ?
          )`,
    ).bind(
      name, description, now, folderId !== undefined ? 1 : 0, folderId ?? null, owner.id, input.lineAccountId, expected,
      expected, owner.id, expectedRevision,
    ),
    db.prepare(
      `UPDATE common_action_versions
          SET action_config = ?, draft_revision = draft_revision + 1
        WHERE id = ? AND common_action_id = ? AND status = 'draft'
          AND draft_revision = ?`,
    ).bind(JSON.stringify(actions), expected, owner.id, expectedRevision),
  ]);
  if ((result[0].meta?.changes ?? 0) !== 1 || (result[1].meta?.changes ?? 0) !== 1) {
    throw new CommonActionValidationError(
      'draft_revision_conflict',
      '別の担当者が先に保存しました。読み込み直して差分を確認してください',
    );
  }
}

export async function createCommonActionDraft(
  db: D1Database,
  input: { id: string; lineAccountId: string; fromVersionId?: unknown; createdBy?: string | null },
): Promise<{ draftVersionId: string; versionNumber: number }> {
  const owner = await getOwnedAction(db, input.id, input.lineAccountId);
  if (!owner) throw new CommonActionValidationError('not_found', '共通アクションが見つかりません');
  if (owner.current_draft_version_id) {
    throw new CommonActionValidationError('draft_exists', '編集中の下書きがすでにあります');
  }
  const fromVersionId = typeof input.fromVersionId === 'string' && input.fromVersionId
    ? input.fromVersionId
    : owner.current_published_version_id;
  if (!fromVersionId) throw new CommonActionValidationError('base_version_required', 'もとにする公開版がありません');
  const base = await db.prepare(
    `SELECT id, action_config FROM common_action_versions
      WHERE id = ? AND common_action_id = ? AND status = 'published'`,
  ).bind(fromVersionId, owner.id).first<{ id: string; action_config: string }>();
  if (!base) throw new CommonActionValidationError('base_version_not_found', 'もとにする公開版が見つかりません');
  const max = await db.prepare(
    `SELECT COALESCE(MAX(version_number), 0) AS value FROM common_action_versions WHERE common_action_id = ?`,
  ).bind(owner.id).first<{ value: number }>();
  const versionNumber = Number(max?.value ?? 0) + 1;
  const versionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const result = await db.batch([
    db.prepare(
      `INSERT INTO common_action_versions
         (id, common_action_id, version_number, status, action_config, created_by, created_at)
       SELECT ?, ca.id, ?, 'draft', ?, ?, ?
         FROM common_actions ca
        WHERE ca.id = ? AND ca.line_account_id = ? AND ca.current_draft_version_id IS NULL`,
    ).bind(
      versionId, versionNumber, base.action_config, input.createdBy ?? null, now,
      owner.id, input.lineAccountId,
    ),
    db.prepare(
      `UPDATE common_actions SET current_draft_version_id = ?, updated_at = ?
        WHERE id = ? AND line_account_id = ? AND current_draft_version_id IS NULL`,
    ).bind(versionId, now, owner.id, input.lineAccountId),
  ]);
  if ((result[0].meta?.changes ?? 0) !== 1 || (result[1].meta?.changes ?? 0) !== 1) {
    throw new CommonActionValidationError('draft_exists', '編集中の下書きがすでにあります');
  }
  return { draftVersionId: versionId, versionNumber };
}

export async function publishCommonActionDraft(
  db: D1Database,
  input: { id: string; lineAccountId: string; draftVersionId: unknown; expectedDraftRevision: unknown },
): Promise<{ versionId: string; versionNumber: number }> {
  const owner = await getOwnedAction(db, input.id, input.lineAccountId);
  if (!owner) throw new CommonActionValidationError('not_found', '共通アクションが見つかりません');
  const draftVersionId = requiredString(input.draftVersionId, 'draftVersionId', '公開する版');
  if (owner.current_draft_version_id !== draftVersionId) {
    throw new CommonActionValidationError('version_conflict', '公開対象の下書きが変わりました。再読み込みしてください');
  }
  // 監査 : 公開の読取後に保存が入ったら、古い読取の公開で上書きしない。
  const expectedRevision = requiredDraftRevision(input.expectedDraftRevision);
  const draft = await db.prepare(
    `SELECT id, common_action_id, version_number, status, action_config, draft_revision,
            created_by, created_at, published_at
       FROM common_action_versions
      WHERE id = ? AND common_action_id = ? AND status = 'draft'`,
  ).bind(draftVersionId, owner.id).first<VersionRow>();
  if (!draft) throw new CommonActionValidationError('draft_not_found', '公開する下書きが見つかりません');
  if (Number(draft.draft_revision) !== expectedRevision) {
    throw new CommonActionValidationError(
      'draft_revision_conflict',
      '公開前に下書きが更新されました。差分を確認し直してください',
    );
  }
  const actions = validateActionShape(JSON.parse(draft.action_config));
  // 監査 : 確認後に参照先が更新されていたら、別の内容を再確認なしで公開しない。
  const drifts = await collectReferenceDrifts(db, input.lineAccountId, actions);
  if (drifts.length > 0) {
    const [first] = drifts;
    throw new CommonActionValidationError(
      'reference_updated',
      `参照先「${first.name}」に新しい版があります（v${first.fromVersion}→v${first.toVersion}）。編集画面で内容を確認して保存し直してください`,
    );
  }
  // 保存時に固定した版を保持し、最新へ自動で置き換えない。
  const pinned = await pinAndValidateReferences(db, input.lineAccountId, owner.id, actions, { keepPins: true });
  // 監査 : 参照を展開した深さ・総数も公開前に検査する。
  await assertPublishableExpansion(db, input.lineAccountId, pinned);
  const now = new Date().toISOString();
  /*
   * 監査 : 保存と同じく2文とも改訂番号で条件付けし、競合時は
   * 親行の版ポインタも版行の状態も変えない。親行を先に触り、
   * 版行の公開切替は後に回す（成功時の条件外れを防ぐ）。
   */
  const result = await db.batch([
    db.prepare(
      `UPDATE common_actions
          SET status = 'published', current_draft_version_id = NULL,
              current_published_version_id = ?, updated_at = ?
        WHERE id = ? AND line_account_id = ? AND current_draft_version_id = ?
          AND EXISTS (
            SELECT 1 FROM common_action_versions
             WHERE id = ? AND common_action_id = ? AND status = 'draft'
               AND draft_revision = ?
          )`,
    ).bind(
      draft.id, now, owner.id, input.lineAccountId, draft.id,
      draft.id, owner.id, expectedRevision,
    ),
    db.prepare(
      `UPDATE common_action_versions
          SET status = 'published', action_config = ?, published_at = ?
        WHERE id = ? AND common_action_id = ? AND status = 'draft'
          AND draft_revision = ?`,
    ).bind(JSON.stringify(pinned), now, draft.id, owner.id, expectedRevision),
  ]);
  if ((result[0].meta?.changes ?? 0) !== 1 || (result[1].meta?.changes ?? 0) !== 1) {
    throw new CommonActionValidationError(
      'draft_revision_conflict',
      '公開前に下書きが更新されました。差分を確認し直してください',
    );
  }
  return { versionId: draft.id, versionNumber: draft.version_number };
}

export async function getCommonActionDetail(
  db: D1Database,
  input: { id: string; lineAccountId: string },
): Promise<{
  id: string; folderId: string | null; name: string; description: string | null; status: CommonActionRow['status'];
  currentDraftVersionId: string | null; currentPublishedVersionId: string | null;
  versions: CommonActionVersion[]; bindings: CommonActionBinding[];
}> {
  const owner = await getOwnedAction(db, input.id, input.lineAccountId);
  if (!owner) throw new CommonActionValidationError('not_found', '共通アクションが見つかりません');
  const [versionsResult, bindingsResult] = await Promise.all([
    db.prepare(
      `SELECT id, common_action_id, version_number, status, action_config, draft_revision,
              created_by, created_at, published_at
         FROM common_action_versions WHERE common_action_id = ?
        ORDER BY version_number DESC`,
    ).bind(owner.id).all<VersionRow>(),
    db.prepare(
      `SELECT b.id, b.confirmation_revision, b.consumer_type, b.consumer_id, b.consumer_path,
              b.common_action_version_id, b.updated_at, v.version_number,
              pv.version_number AS latest_version_number,
              /* 監査 R472: 利用先の呼び出し箇所と実行の目印を突き合わせる。
                 自動化IDと版だけでは、動かしていない箇所に同じ実行を
                 重ねて数えてしまう。空の箇所は全体とみなす。 */
              CASE WHEN b.consumer_type = 'automation' THEN (
                SELECT COUNT(DISTINCT r.id) FROM automation_runs r
                JOIN automation_run_steps s ON s.automation_run_id = r.id
                WHERE r.automation_id = b.consumer_id
                  AND s.common_action_version_id = b.common_action_version_id
                  AND (b.consumer_path = ''
                    OR s.step_key = b.consumer_path
                    OR substr(s.step_key, 1, length(b.consumer_path) + 1) = b.consumer_path || '/')
                  AND r.status = 'running'
              ) END AS running_count,
              CASE WHEN b.consumer_type = 'automation' THEN (
                SELECT COUNT(DISTINCT r.id) FROM automation_runs r
                JOIN automation_run_steps s ON s.automation_run_id = r.id
                WHERE r.automation_id = b.consumer_id
                  AND s.common_action_version_id = b.common_action_version_id
                  AND (b.consumer_path = ''
                    OR s.step_key = b.consumer_path
                    OR substr(s.step_key, 1, length(b.consumer_path) + 1) = b.consumer_path || '/')
                  AND r.status = 'waiting'
              ) END AS waiting_count,
              /* 監査 R471: 新版へ切り替えたあとも、旧版のまま進んでいる
                 実行を別に数える。0と混ぜると監視から漏れる。 */
              CASE WHEN b.consumer_type = 'automation' THEN (
                SELECT COUNT(DISTINCT r.id) FROM automation_runs r
                JOIN automation_run_steps s ON s.automation_run_id = r.id
                WHERE r.automation_id = b.consumer_id
                  AND s.common_action_version_id <> b.common_action_version_id
                  AND s.common_action_version_id IN (
                    SELECT v2.id FROM common_action_versions v2
                     WHERE v2.common_action_id = b.common_action_id)
                  AND (b.consumer_path = ''
                    OR s.step_key = b.consumer_path
                    OR substr(s.step_key, 1, length(b.consumer_path) + 1) = b.consumer_path || '/')
                  AND r.status = 'running'
              ) END AS older_running_count,
              CASE WHEN b.consumer_type = 'automation' THEN (
                SELECT COUNT(DISTINCT r.id) FROM automation_runs r
                JOIN automation_run_steps s ON s.automation_run_id = r.id
                WHERE r.automation_id = b.consumer_id
                  AND s.common_action_version_id <> b.common_action_version_id
                  AND s.common_action_version_id IN (
                    SELECT v2.id FROM common_action_versions v2
                     WHERE v2.common_action_id = b.common_action_id)
                  AND (b.consumer_path = ''
                    OR s.step_key = b.consumer_path
                    OR substr(s.step_key, 1, length(b.consumer_path) + 1) = b.consumer_path || '/')
                  AND r.status = 'waiting'
              ) END AS older_waiting_count
         FROM common_action_bindings b
         JOIN common_action_versions v ON v.id = b.common_action_version_id
         LEFT JOIN common_action_versions pv ON pv.id = ?
        WHERE b.common_action_id = ? AND b.line_account_id = ?
        ORDER BY b.updated_at DESC`,
    ).bind(owner.current_published_version_id, owner.id, input.lineAccountId).all<{
      id: string; confirmation_revision: number; consumer_type: string; consumer_id: string; consumer_path: string;
      common_action_version_id: string; updated_at: string; version_number: number;
      latest_version_number: number | null; running_count: number | null; waiting_count: number | null;
      older_running_count: number | null; older_waiting_count: number | null;
    }>(),
  ]);
  const versions = (versionsResult.results ?? []).map((row) => ({
    id: row.id,
    versionNumber: row.version_number,
    status: row.status,
    actions: parseStoredActions(row.action_config),
    draftRevision: Number(row.draft_revision ?? 1),
    createdBy: row.created_by,
    createdAt: row.created_at,
    publishedAt: row.published_at,
  }));
  const bindings = (bindingsResult.results ?? []).map((row) => ({
    id: row.id,
    confirmationRevision: row.confirmation_revision,
    consumerType: row.consumer_type,
    consumerId: row.consumer_id,
    consumerPath: row.consumer_path,
    versionId: row.common_action_version_id,
    versionNumber: row.version_number,
    latestVersionNumber: row.latest_version_number,
    hasNewerVersion: row.latest_version_number !== null && row.latest_version_number > row.version_number,
    runningCount: row.running_count === null ? null : Number(row.running_count),
    waitingCount: row.waiting_count === null ? null : Number(row.waiting_count),
    olderRunningCount: row.older_running_count === null ? null : Number(row.older_running_count),
    olderWaitingCount: row.older_waiting_count === null ? null : Number(row.older_waiting_count),
    updatedAt: row.updated_at,
  }));
  return {
    id: owner.id,
    folderId: owner.folder_id ?? null,
    name: owner.name,
    description: owner.description,
    status: owner.status,
    currentDraftVersionId: owner.current_draft_version_id,
    currentPublishedVersionId: owner.current_published_version_id,
    versions,
    bindings,
  };
}

export async function updateCommonActionBindingVersion(
  db: D1Database,
  input: {
    id: string;
    bindingId: string;
    lineAccountId: string;
    versionId: unknown;
    expectedVersionId: unknown;
    expectedConfirmationRevision?: unknown;
    actorId?: string | null;
  },
): Promise<void> {
  const versionId = requiredString(input.versionId, 'versionId', '切り替える版');
  const expectedVersionId = requiredString(
    input.expectedVersionId, 'expectedVersionId', '現在利用中の版',
  );
  if (input.expectedConfirmationRevision !== undefined && (!Number.isSafeInteger(input.expectedConfirmationRevision) || (input.expectedConfirmationRevision as number) < 1)) {
    throw new CommonActionValidationError('revision_invalid', '確認した版が不正です', 'expectedConfirmationRevision');
  }
  const version = await db.prepare(
    `SELECT cav.id
       FROM common_action_versions cav
       JOIN common_actions ca ON ca.id = cav.common_action_id
      WHERE cav.id = ? AND cav.common_action_id = ? AND cav.status = 'published'
        AND ca.line_account_id = ?`,
  ).bind(versionId, input.id, input.lineAccountId).first<{ id: string }>();
  if (!version) throw new CommonActionValidationError('version_not_found', '切り替える公開版が見つかりません', 'versionId');
  const now = new Date().toISOString();
  const eventId = crypto.randomUUID();
  const results = await db.batch([
    db.prepare(
      `INSERT INTO common_action_binding_migration_events
         (id, line_account_id, common_action_id, binding_id,
          from_action_version_id, to_action_version_id, actor_id, created_at)
       SELECT ?, line_account_id, common_action_id, id,
              common_action_version_id, ?, ?, ?
         FROM common_action_bindings
        WHERE id = ? AND common_action_id = ? AND line_account_id = ?
          AND common_action_version_id = ? AND (? IS NULL OR confirmation_revision = ?)`,
    ).bind(
      eventId, version.id, input.actorId ?? null, now,
      input.bindingId, input.id, input.lineAccountId, expectedVersionId, input.expectedConfirmationRevision ?? null, input.expectedConfirmationRevision ?? null,
    ),
    db.prepare(
      `UPDATE common_action_bindings SET common_action_version_id = ?, updated_at = ?, confirmation_revision = confirmation_revision + 1
        WHERE id = ? AND common_action_id = ? AND line_account_id = ?
          AND common_action_version_id = ? AND (? IS NULL OR confirmation_revision = ?)`,
    ).bind(
      version.id, now, input.bindingId, input.id, input.lineAccountId, expectedVersionId, input.expectedConfirmationRevision ?? null, input.expectedConfirmationRevision ?? null,
    ),
  ]);
  if ((results[0].meta?.changes ?? 0) !== 1 || (results[1].meta?.changes ?? 0) !== 1) {
    const binding = await db.prepare(
      `SELECT id FROM common_action_bindings
        WHERE id = ? AND common_action_id = ? AND line_account_id = ?`,
    ).bind(input.bindingId, input.id, input.lineAccountId).first<{ id: string }>();
    if (!binding) throw new CommonActionValidationError('binding_not_found', '利用先が見つかりません');
    throw new CommonActionValidationError('version_conflict', '利用先の固定版が変わりました。再読み込みしてください');
  }
}

export const ARCHIVE_CONSUMER_LABELS: Record<string, string> = {
  automation: 'オートメーション',
  scenario: 'シナリオ配信',
  form: '回答フォーム',
  auto_reply: '自動応答',
  rich_menu: 'リッチメニュー',
};

/*
 * 監査 : 未使用の共通アクションを保管する。利用中は件数と利用先を
 * 示して拒否する。保管は一方通行ではなく、戻す操作も用意する。
 * 実行記録は残る（物理削除ではない）。
 */
export async function archiveCommonAction(
  db: D1Database,
  input: { id: string; lineAccountId: string },
): Promise<void> {
  const owner = await getOwnedAction(db, input.id, input.lineAccountId);
  if (!owner) throw new CommonActionValidationError('not_found', '共通アクションが見つかりません');
  if (owner.status === 'archived') return;
  const bindings = await db.prepare(
    `SELECT consumer_type, consumer_id
       FROM common_action_bindings
      WHERE common_action_id = ? AND line_account_id = ?
      ORDER BY consumer_type, consumer_id`,
  ).bind(owner.id, input.lineAccountId).all<{ consumer_type: string; consumer_id: string }>();
  const rows = bindings.results ?? [];
  if (rows.length > 0) {
    const kinds = [...new Set(rows.map((row) => ARCHIVE_CONSUMER_LABELS[row.consumer_type] ?? row.consumer_type))];
    throw new CommonActionValidationError(
      'binding_exists',
      `利用中のため保管できません（${kinds.join('・')} ${rows.length}か所）。先に利用先を外してください`,
    );
  }
  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE common_actions SET status = 'archived', archived_at = ?, updated_at = ?
      WHERE id = ? AND line_account_id = ?`,
  ).bind(now, now, owner.id, input.lineAccountId).run();
}

export async function unarchiveCommonAction(
  db: D1Database,
  input: { id: string; lineAccountId: string },
): Promise<void> {
  const owner = await getOwnedAction(db, input.id, input.lineAccountId);
  if (!owner) throw new CommonActionValidationError('not_found', '共通アクションが見つかりません');
  if (owner.status !== 'archived') {
    throw new CommonActionValidationError('version_conflict', '保管中ではありません。再読み込みしてください');
  }
  const status = owner.current_published_version_id ? 'published' : 'draft';
  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE common_actions SET status = ?, archived_at = NULL, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND status = 'archived'`,
  ).bind(status, now, owner.id, input.lineAccountId).run();
}
