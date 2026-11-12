import type { AutoReply, CreateAutoReplyInput } from './auto-reply-record-types.js';
import { jstNow } from './utils.js';
import { type AutoReplyCreateClaim, type AutoReplyCreateOperation, type AutoReplyCreateIdempotency, type AutoReplyDraftSettings, type AutoReplyVersionRow } from './auto-reply-runs-types.js';
import { getAutoReplyDraftVersion, getAutoReplyPublishedVersion, getAutoReplyVersionById } from './auto-reply-runs-settings.js';


/** auto-replies.ts との循環参照を避けるための最小取得。 */
export async function getClaimRuleById(db: D1Database, id: string): Promise<AutoReply | null> {
  return db.prepare(`SELECT * FROM auto_replies WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first<AutoReply>();
}

export async function findAutoReplyCreateClaim(
  db: D1Database,
  key: string,
): Promise<AutoReplyCreateClaim | null> {
  return db.prepare(
    `SELECT operation, request_fingerprint, auto_reply_id, version_id
       FROM auto_reply_create_requests WHERE idempotency_key = ?`,
  ).bind(key).first<AutoReplyCreateClaim>();
}

/** 保存済みの要求と突き合わせる。作り直すときは古い予約を消して null を返す。 */
export async function resolveAutoReplyCreateClaim(
  db: D1Database,
  key: string,
  previous: AutoReplyCreateClaim,
  operation: AutoReplyCreateOperation,
  fingerprint: string,
): Promise<AutoReply | null> {
  if (previous.operation !== operation) throw new Error('AUTO_REPLY_IDEMPOTENCY_OPERATION_CONFLICT');
  if (previous.request_fingerprint !== fingerprint) throw new Error('AUTO_REPLY_IDEMPOTENCY_CONFLICT');
  const rule = await getClaimRuleById(db, previous.auto_reply_id);
  if (rule) return rule;
  await db.prepare(`DELETE FROM auto_reply_create_requests WHERE idempotency_key = ?`)
    .bind(key).run();
  return null;
}

export function autoReplyCreateClaimStatement(
  db: D1Database,
  operation: AutoReplyCreateOperation,
  lineAccountId: string | null,
  idempotency: AutoReplyCreateIdempotency,
  autoReplyId: string,
  versionId: string | null,
  now: string,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO auto_reply_create_requests
       (id, line_account_id, operation, idempotency_key, request_fingerprint,
        auto_reply_id, version_id, response_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    lineAccountId,
    operation,
    idempotency.key,
    idempotency.fingerprint,
    autoReplyId,
    versionId,
    JSON.stringify({ autoReplyId, versionId }),
    now,
  );
}

/**
 * 直接作成の内容指紋。1文字でも違えば別の要求とみなし、作らず止める。
 * 呼び出し側（Worker）がテンプレート解決後の値を渡すため、再送の突き合わせは
 * 解決後の内容で行う。
 */
export function autoReplyRuleCreateFingerprint(input: CreateAutoReplyInput): string {
  return JSON.stringify({
    keyword: input.keyword,
    matchType: input.matchType ?? 'exact',
    responseType: input.responseType ?? 'text',
    responseContent: input.responseContent,
    templateId: input.templateId ?? null,
    lineAccountId: input.lineAccountId ?? null,
    isActive: input.isActive === true,
    activeFrom: input.activeFrom ?? null,
    activeUntil: input.activeUntil ?? null,
    cooldownMinutes: input.cooldownMinutes ?? null,
    skipWhenOperatorActive: input.skipWhenOperatorActive === true,
    priority: input.priority ?? 0,
    messageKinds: input.messageKinds ?? null,
    actions: input.actions ?? null,
    responseWeekdays: input.responseWeekdays ?? null,
    responseHolidayRule: input.responseHolidayRule ?? null,
    oncePerFriend: input.oncePerFriend === true,
    keywords: input.keywords ?? null,
    friendConditions: input.friendConditions ?? null,
    respondToAll: input.respondToAll === true,
    name: input.name ?? null,
    normalizeKeywords: input.normalizeKeywords !== false,
    keywordMatchMode: input.keywordMatchMode ?? 'any',
    folderId: input.folderId ?? null,
    internalMemo: input.internalMemo ?? null,
  });
}

/** 新規定義と下書き版を1回のbatchで作る。作成時点では評価対象にしない。 */
export async function createAutoReplyWithDraftVersion(
  db: D1Database,
  settings: AutoReplyDraftSettings,
  idempotency?: AutoReplyCreateIdempotency,
): Promise<{ rule: AutoReply; version: AutoReplyVersionRow; replayed: boolean }> {
  if (idempotency) {
    const previous = await findAutoReplyCreateClaim(db, idempotency.key);
    if (previous) {
      const matched = await resolveAutoReplyCreateClaim(
        db,
        idempotency.key,
        previous,
        'draft',
        idempotency.fingerprint,
      );
      if (matched) {
        const version = await getAutoReplyDraftVersion(db, matched.id)
          ?? await getAutoReplyPublishedVersion(db, matched.id);
        if (version) return { rule: matched, version, replayed: true };
        await db.prepare(`DELETE FROM auto_reply_create_requests WHERE idempotency_key = ?`)
          .bind(idempotency.key).run();
      }
    }
  }
  const autoReplyId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const now = jstNow();
  const claimStatements = idempotency
    ? [
      autoReplyCreateClaimStatement(
        db,
        'draft',
        settings.lineAccountId,
        idempotency,
        autoReplyId,
        versionId,
        now,
      ),
    ]
    : [];
  try {
    await db.batch([
    db.prepare(
      `INSERT INTO auto_replies
         (id, keyword, match_type, response_type, response_content,
          template_id, line_account_id, is_active, active_from, active_until,
          cooldown_minutes, skip_when_operator_active, priority, message_kinds_json,
          friend_conditions_json, folder_id, actions_json, response_weekdays_json,
          response_holiday_rule, once_per_friend, keywords_json, respond_to_all,
          name, keyword_match_mode, lifecycle_status, current_draft_version_id,
          created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               'draft', ?, ?)`,
    ).bind(
      autoReplyId,
      settings.keyword,
      settings.matchType,
      settings.responseType,
      settings.responseContent,
      settings.templateId,
      settings.lineAccountId,
      settings.activeFrom,
      settings.activeUntil,
      settings.cooldownMinutes,
      settings.skipWhenOperatorActive ? 1 : 0,
      settings.priority,
      settings.messageKinds,
      settings.friendConditions,
      settings.folderId,
      settings.actions,
      settings.responseWeekdays,
      settings.responseHolidayRule,
      settings.oncePerFriend ? 1 : 0,
      settings.keywords,
      settings.respondToAll ? 1 : 0,
      settings.name,
      settings.keywordMatchMode,
      versionId,
      now,
    ),
    db.prepare(
      `INSERT INTO auto_reply_versions
         (id, auto_reply_id, version_number, line_account_id, definition_snapshot,
          status, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, 'draft', ?, ?)`,
    ).bind(
      versionId,
      autoReplyId,
      settings.lineAccountId,
      JSON.stringify(settings),
      now,
      now,
    ),
    ...claimStatements,
    ]);
  } catch (err) {
    // 同時に同じキーが確定した可能性がある。勝った側の結果に従い、
    // 勝者がいなければ元の失敗をそのまま返す（握りつぶさない）。
    if (idempotency) {
      const raced = await findAutoReplyCreateClaim(db, idempotency.key).catch(() => null);
      if (raced?.operation === 'draft' && raced.request_fingerprint === idempotency.fingerprint) {
        const winnerRule = await getClaimRuleById(db, raced.auto_reply_id).catch(() => null);
        const winnerVersion = winnerRule
          ? await getAutoReplyDraftVersion(db, winnerRule.id).catch(() => null)
          : null;
        if (winnerRule && winnerVersion) return { rule: winnerRule, version: winnerVersion, replayed: true };
      }
    }
    throw err;
  }
  const [rule, version] = await Promise.all([
    db.prepare(`SELECT * FROM auto_replies WHERE id = ?`).bind(autoReplyId).first<AutoReply>(),
    getAutoReplyVersionById(db, versionId),
  ]);
  if (!rule || !version) throw new Error('AUTO_REPLY_DRAFT_NOT_CREATED');
  return { rule, version, replayed: false };
}

/**
 * 公開中の定義は触らず、編集用の版だけを作る／更新する。
 *
 * 下書きの更新は版を1つ進め、呼び出し元が読んだ版番号を
 * 更新条件に含める。同じ版からの後続保存は 1 件しか通らず、負けた側は
 * AUTO_REPLY_VERSION_CONFLICT になる（先行内容は保たれる）。
 * expectedVersion を渡さない旧来の呼び出しは、従来どおり条件なしで
 * 上書きする。
 */
export async function saveAutoReplyDraftVersion(
  db: D1Database,
  autoReplyId: string,
  settings: AutoReplyDraftSettings,
  expectedVersion?: number,
): Promise<AutoReplyVersionRow> {
  const rule = await db.prepare(`SELECT * FROM auto_replies WHERE id = ? AND deleted_at IS NULL`)
    .bind(autoReplyId)
    .first<AutoReply>();
  if (!rule) throw new Error('AUTO_REPLY_NOT_FOUND');
  const now = jstNow();
  let draft = await getAutoReplyDraftVersion(db, autoReplyId);
  if (!draft) {
    if (expectedVersion !== undefined) {
      const current = await db.prepare(
        `SELECT version_number FROM auto_reply_versions
          WHERE auto_reply_id = ? ORDER BY version_number DESC LIMIT 1`,
      ).bind(autoReplyId).first<{ version_number: number }>();
      if (Number(current?.version_number ?? 0) !== Number(expectedVersion)) {
        throw new Error('AUTO_REPLY_VERSION_CONFLICT');
      }
    }
    const next = await db.prepare(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS version_number
         FROM auto_reply_versions WHERE auto_reply_id = ?`,
    ).bind(autoReplyId).first<{ version_number: number }>();
    const versionId = crypto.randomUUID();
    await db.batch([
      db.prepare(
        `INSERT INTO auto_reply_versions
           (id, auto_reply_id, version_number, line_account_id, definition_snapshot,
            status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`,
      ).bind(
        versionId,
        autoReplyId,
        Number(next?.version_number ?? 1),
        settings.lineAccountId,
        JSON.stringify(settings),
        now,
        now,
      ),
      db.prepare(
        `UPDATE auto_replies
            SET confirmation_revision = confirmation_revision + 1, current_draft_version_id = ?
          WHERE id = ?`,
      ).bind(versionId, autoReplyId),
    ]);
    draft = await getAutoReplyVersionById(db, versionId);
    if (draft) {
      // 同時作成の負け側は札だけが残る。指し示されていない版は消して競合にする。
      const pointer = await db.prepare(
        `SELECT current_draft_version_id FROM auto_replies WHERE id = ?`,
      ).bind(autoReplyId).first<{ current_draft_version_id: string | null }>();
      if (pointer?.current_draft_version_id !== versionId) {
        await db.prepare(`DELETE FROM auto_reply_versions WHERE id = ? AND status = 'draft'`)
          .bind(versionId).run();
        throw new Error('AUTO_REPLY_VERSION_CONFLICT');
      }
    }
  } else if (expectedVersion === undefined) {
    await db.prepare(
      `UPDATE auto_reply_versions
          SET line_account_id = ?, definition_snapshot = ?,
              last_test_status = NULL, last_tested_at = NULL,
              last_tested_by_staff_id = NULL, updated_at = ?
        WHERE id = ? AND status = 'draft'`,
    ).bind(settings.lineAccountId, JSON.stringify(settings), now, draft.id).run();
  } else {
    // 版番号の条件を含めた1文の更新。読取と書込のあいだの割込みは
    // 反映行数 0 になり、競合として検出する。
    const applied = await db.prepare(
      `UPDATE auto_reply_versions
          SET version_number = version_number + 1,
              line_account_id = ?, definition_snapshot = ?,
              last_test_status = NULL, last_tested_at = NULL,
              last_tested_by_staff_id = NULL, updated_at = ?
        WHERE id = ? AND status = 'draft' AND version_number = ?`,
    ).bind(
      settings.lineAccountId,
      JSON.stringify(settings),
      now,
      draft.id,
      Number(expectedVersion),
    ).run();
    if ((applied.meta?.changes ?? 0) !== 1) {
      throw new Error('AUTO_REPLY_VERSION_CONFLICT');
    }
  }
  if (!draft) throw new Error('AUTO_REPLY_DRAFT_NOT_SAVED');
  return (await getAutoReplyVersionById(db, draft.id))!;
}
