import type { AutoReply } from './auto-reply-record-types.js';
import { jstNow } from './utils.js';
import { type AutoReplyVersionRow, type AutoReplyDraftSettings } from './auto-reply-runs-types.js';
import { getAutoReplyDraftVersion, parseAutoReplyVersionSettings, getAutoReplyVersionById, autoReplyDefinitionSnapshot, getAutoReplyPublishedVersion, autoReplyRuntimeSnapshot } from './auto-reply-runs-settings.js';


/**
 * 試験の記録は、試験を始めたときの内容と同じ版にだけ付ける。
 * expectedSnapshot（試験開始時に読んだ definition_snapshot）を渡すと、
 * 記録時に内容が変わっていないか1文で照合する。試験中に編集が入った
 * 場合は反映行数 0 になり、applied: false を返す。古い成功が新内容の
 * 公開条件になるのを防ぐ。渡さない旧来の呼び出しは従来どおり記録する。
 */
export async function recordAutoReplyDraftTest(
  db: D1Database,
  versionId: string,
  input: { succeeded: boolean; staffId: string | null },
  expectedSnapshot?: string,
): Promise<{ applied: boolean }> {
  const now = jstNow();
  const applied = expectedSnapshot === undefined
    ? await db.prepare(
      `UPDATE auto_reply_versions
          SET last_test_status = ?, last_tested_at = ?, last_tested_by_staff_id = ?, updated_at = ?
        WHERE id = ? AND status = 'draft'`,
    ).bind(input.succeeded ? 'succeeded' : 'failed', now, input.staffId, now, versionId).run()
    : await db.prepare(
      `UPDATE auto_reply_versions
          SET last_test_status = ?, last_tested_at = ?, last_tested_by_staff_id = ?, updated_at = ?
        WHERE id = ? AND status = 'draft' AND definition_snapshot = ?`,
    ).bind(
      input.succeeded ? 'succeeded' : 'failed',
      now,
      input.staffId,
      now,
      versionId,
      expectedSnapshot,
    ).run();
  return { applied: (applied.meta?.changes ?? 0) === 1 };
}

/**
 * 下書きを公開版へ進め、実行中の定義を同じbatchで差し替える。
 *
 * 公開の読取と書込のあいだに編集・停止が割り込んだら、
 * 公開を止めて競合にする。expectedSnapshot（公開前チェック時の内容）、
 * expectedStoppedAt / expectedIsActive（読取時の停止状態）を渡すと、
 * batch 内の3文すべてに割込み条件を付け、成功した公開版と稼働設定が
 * 同じ内容になることを保証する。条件を付けない旧来の呼び出しは従来動作。
 */
export async function publishAutoReplyDraftVersion(
  db: D1Database,
  autoReplyId: string,
  input: {
    staffId: string | null;
    idempotencyKey: string;
    expectedSnapshot?: string;
    expectedStoppedAt?: string | null;
    expectedIsActive?: number;
  },
): Promise<AutoReplyVersionRow> {
  const replay = await db.prepare(
    `SELECT * FROM auto_reply_versions WHERE publish_idempotency_key = ?`,
  ).bind(input.idempotencyKey).first<AutoReplyVersionRow>();
  if (replay) {
    if (replay.auto_reply_id !== autoReplyId) throw new Error('AUTO_REPLY_PUBLISH_KEY_CONFLICT');
    return replay;
  }
  const draft = await getAutoReplyDraftVersion(db, autoReplyId);
  if (!draft) throw new Error('AUTO_REPLY_DRAFT_NOT_FOUND');
  if (draft.last_test_status !== 'succeeded') throw new Error('AUTO_REPLY_DRAFT_NOT_TESTED');
  // 公開前チェックから batch までのあいだの編集は、ここで止める。
  if (input.expectedSnapshot !== undefined && draft.definition_snapshot !== input.expectedSnapshot) {
    throw new Error('AUTO_REPLY_DRAFT_CHANGED');
  }
  const rule = await db.prepare(`SELECT * FROM auto_replies WHERE id = ? AND deleted_at IS NULL`)
    .bind(autoReplyId)
    .first<AutoReply>();
  if (!rule) throw new Error('AUTO_REPLY_DRAFT_NOT_FOUND');
  // 読取後の停止は、ここで止める（停止成功後の旧公開要求は再有効化しない）。
  if (input.expectedStoppedAt !== undefined
    && (rule.stopped_at ?? null) !== (input.expectedStoppedAt ?? null)) {
    throw new Error('AUTO_REPLY_STOPPED_AFTER_READ');
  }
  if (input.expectedIsActive !== undefined && rule.is_active !== input.expectedIsActive) {
    throw new Error('AUTO_REPLY_STOPPED_AFTER_READ');
  }
  const settings = parseAutoReplyVersionSettings(draft);
  const now = jstNow();
  /*
   * batch 直前の割込みは、3文の更新条件で止める。batch は原子的なので、
   * 条件を外した文だけが通る半端な公開は起きない。条件に使う停止状態は
   * 副問合せで読み、停止の割込みでは3文とも反映行数 0 になる。
   */
  const stopGuardSql = [
    input.expectedStoppedAt !== undefined
      ? `AND (SELECT stopped_at FROM auto_replies WHERE id = ?) IS ?`
      : '',
    input.expectedIsActive !== undefined
      ? `AND (SELECT is_active FROM auto_replies WHERE id = ?) = ?`
      : '',
  ].filter(Boolean).join(' ');
  const stopGuardBinds: unknown[] = [];
  if (input.expectedStoppedAt !== undefined) {
    stopGuardBinds.push(autoReplyId, input.expectedStoppedAt ?? null);
  }
  if (input.expectedIsActive !== undefined) {
    stopGuardBinds.push(autoReplyId, input.expectedIsActive);
  }
  const snapshotGuardSql = input.expectedSnapshot !== undefined
    ? `AND (SELECT definition_snapshot FROM auto_reply_versions WHERE id = ?) = ?`
    : '';
  const snapshotGuardBinds: unknown[] = input.expectedSnapshot !== undefined
    ? [draft.id, input.expectedSnapshot]
    : [];
  await db.batch([
    db.prepare(
      `UPDATE auto_reply_versions SET status = 'retired', updated_at = ?
        WHERE auto_reply_id = ? AND status = 'published' ${stopGuardSql}`,
    ).bind(now, autoReplyId, ...stopGuardBinds),
    db.prepare(
      `UPDATE auto_reply_versions
          SET status = 'published', published_at = ?, published_by_staff_id = ?,
              publish_idempotency_key = ?, updated_at = ?
        WHERE id = ? AND status = 'draft' AND definition_snapshot = ? ${stopGuardSql}`,
    ).bind(now, input.staffId, input.idempotencyKey, now, draft.id, draft.definition_snapshot, ...stopGuardBinds),
    db.prepare(
      `UPDATE auto_replies
          SET confirmation_revision = confirmation_revision + 1, keyword = ?, match_type = ?, response_type = ?, response_content = ?,
              template_id = ?, line_account_id = ?, is_active = 1,
              active_from = ?, active_until = ?, cooldown_minutes = ?,
              skip_when_operator_active = ?, priority = ?, message_kinds_json = ?,
              friend_conditions_json = ?, folder_id = ?, actions_json = ?,
              response_weekdays_json = ?, response_holiday_rule = ?, once_per_friend = ?,
              keywords_json = ?, respond_to_all = ?, name = ?, keyword_match_mode = ?,
              lifecycle_status = 'published', current_published_version_id = ?,
              current_draft_version_id = NULL
        WHERE id = ? ${snapshotGuardSql} ${stopGuardSql}`,
    ).bind(
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
      draft.id,
      autoReplyId,
      ...snapshotGuardBinds,
      ...stopGuardBinds,
    ),
  ]);
  const published = await getAutoReplyVersionById(db, draft.id);
  const ruleAfter = await db.prepare(`SELECT * FROM auto_replies WHERE id = ?`)
    .bind(autoReplyId)
    .first<AutoReply & { current_published_version_id?: string | null }>();
  const versionOk = published?.status === 'published'
    && published.publish_idempotency_key === input.idempotencyKey;
  const ruleOk = (ruleAfter?.current_published_version_id ?? null) === draft.id;
  if (versionOk && ruleOk) return published!;
  const guarded = input.expectedSnapshot !== undefined
    || input.expectedStoppedAt !== undefined
    || input.expectedIsActive !== undefined;
  if (!guarded) {
    if (!versionOk) throw new Error('AUTO_REPLY_DRAFT_NOT_PUBLISHED');
    if (published!.publish_idempotency_key !== input.idempotencyKey) {
      throw new Error('AUTO_REPLY_DRAFT_ALREADY_PUBLISHED');
    }
    throw new Error('AUTO_REPLY_DRAFT_NOT_PUBLISHED');
  }
  // batch 直前の割込みの切り分け。停止記録が動いていれば停止の割込み。
  const stopMoved = (ruleAfter?.stopped_at ?? null) !== (rule.stopped_at ?? null)
    || (ruleAfter?.is_active ?? rule.is_active) !== rule.is_active;
  if (stopMoved) throw new Error('AUTO_REPLY_STOPPED_AFTER_READ');
  throw new Error('AUTO_REPLY_DRAFT_CHANGED');
}

/** 実行時の定義を不変の版として確保する。既存UIの保存形式は変えない。 */
export async function ensureAutoReplyPublishedVersion(
  db: D1Database,
  rule: AutoReply,
): Promise<AutoReplyVersionRow> {
  const snapshot = autoReplyDefinitionSnapshot(rule);
  const current = await getAutoReplyPublishedVersion(db, rule.id);
  if (current && (
    current.definition_snapshot === snapshot
    || autoReplyRuntimeSnapshot(parseAutoReplyVersionSettings(current)) === snapshot
  )) return current;
  const latest = await db
    .prepare(
      `SELECT * FROM auto_reply_versions
        WHERE auto_reply_id = ?
        ORDER BY version_number DESC LIMIT 1`,
    )
    .bind(rule.id)
    .first<AutoReplyVersionRow>();
  if (latest?.status === 'published' && (
    latest.definition_snapshot === snapshot
    || autoReplyRuntimeSnapshot(parseAutoReplyVersionSettings(latest)) === snapshot
  )) {
    await db.prepare(
      `UPDATE auto_replies SET current_published_version_id = ? WHERE id = ?`,
    ).bind(latest.id, rule.id).run();
    return latest;
  }

  const versionNumber = Number(latest?.version_number ?? 0) + 1;
  const now = jstNow();
  const id = crypto.randomUUID();
  /*
   * 実行の同一判定に混ぜない運用項目は、実行版を張り替えても引き継ぐ。
   * 引き継がないと、従来の更新口（PUT /api/auto-replies/:id）で定義を
   * 直したあとの初回評価で、新版に社内メモが載らず編集画面から消える
   * （AUTOREPLY-09）。
   */
  const previous = current ?? (latest?.status === 'published' ? latest : null);
  let snapshotToSave = snapshot;
  if (previous) {
    try {
      const carried = JSON.parse(previous.definition_snapshot) as Partial<AutoReplyDraftSettings>;
      snapshotToSave = JSON.stringify({
        ...(JSON.parse(snapshot) as Record<string, unknown>),
        normalizeKeywords: carried.normalizeKeywords !== false,
        receiveSources: carried.receiveSources ?? ['line'],
        internalMemo: carried.internalMemo ?? null,
        replyDelaySeconds: carried.replyDelaySeconds ?? null,
        unmatchedAction: carried.unmatchedAction ?? null,
      });
    } catch {
      /* 読めない旧版は引き継がない */
    }
  }
  await db.batch([
    db.prepare(
      `UPDATE auto_reply_versions SET status = 'retired', updated_at = ?
        WHERE auto_reply_id = ? AND status = 'published'`,
    ).bind(now, rule.id),
    db.prepare(
      `INSERT OR IGNORE INTO auto_reply_versions
         (id, auto_reply_id, version_number, line_account_id, definition_snapshot,
          status, published_at, published_by_staff_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'published', ?, NULL, ?, ?)`,
    ).bind(id, rule.id, versionNumber, rule.line_account_id, snapshotToSave, now, now, now),
    db.prepare(
      `UPDATE auto_replies SET current_published_version_id = ?, lifecycle_status = 'published'
        WHERE id = ?`,
    ).bind(id, rule.id),
  ]);

  const saved = await db
    .prepare(
      `SELECT * FROM auto_reply_versions
        WHERE auto_reply_id = ?
        ORDER BY version_number DESC LIMIT 1`,
    )
    .bind(rule.id)
    .first<AutoReplyVersionRow>();
  if (!saved) throw new Error('auto_reply_version_not_saved');
  return saved;
}
