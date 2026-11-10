import { sqlIdSet } from './id-queries.js';
import type { AutoReply } from './auto-reply-record-types.js';
import { jstNow } from './utils.js';
import { type AutoReplyDraftSettings, type AutoReplyVersionRow } from './auto-reply-runs-types.js';


/**
 * 版の比較に使う定義。画面の表示名も含め、実行時の意味が変わる項目だけを固定する。
 * プロパティ順は変えない。JSON文字列を版の同一判定に使うため。
 */
export function autoReplyDraftSettingsFromRow(rule: AutoReply): AutoReplyDraftSettings {
  return {
    keyword: rule.keyword,
    matchType: rule.match_type,
    responseType: rule.response_type,
    responseContent: rule.response_content,
    templateId: rule.template_id,
    lineAccountId: rule.line_account_id,
    activeFrom: rule.active_from,
    activeUntil: rule.active_until,
    cooldownMinutes: rule.cooldown_minutes,
    skipWhenOperatorActive: rule.skip_when_operator_active === 1,
    priority: rule.priority,
    messageKinds: rule.message_kinds_json,
    receiveSources: ['line'],
    friendConditions: rule.friend_conditions_json,
    actions: rule.actions_json,
    responseWeekdays: rule.response_weekdays_json,
    responseHolidayRule: rule.response_holiday_rule,
    oncePerFriend: rule.once_per_friend === 1,
    keywords: rule.keywords_json,
    respondToAll: rule.respond_to_all === 1,
    name: rule.name,
    keywordMatchMode: rule.keyword_match_mode,
    normalizeKeywords: true,
    folderId: rule.folder_id,
    internalMemo: null,
    replyDelaySeconds: null,
    unmatchedAction: null,
  };
}

export function autoReplyDefinitionSnapshot(rule: AutoReply): string {
  return JSON.stringify(autoReplyDraftSettingsFromRow(rule));
}

/**
 * 保存だけ先行した運用項目は、Webhookが実行する定義の同一判定へ混ぜない。
 * 混ぜると、公開版の社内メモ等が auto_replies 本体に無いだけで別版を増やしてしまう。
 */
export function autoReplyRuntimeSnapshot(settings: AutoReplyDraftSettings): string {
  return JSON.stringify({
    ...settings,
    normalizeKeywords: true,
    receiveSources: ['line'],
    internalMemo: null,
    replyDelaySeconds: null,
    unmatchedAction: null,
  });
}

export function parseAutoReplyVersionSettings(row: AutoReplyVersionRow): AutoReplyDraftSettings {
  const parsed = JSON.parse(row.definition_snapshot) as Partial<AutoReplyDraftSettings>;
  return {
    keyword: parsed.keyword ?? '',
    matchType: parsed.matchType === 'contains' ? 'contains' : 'exact',
    responseType: parsed.responseType ?? 'text',
    responseContent: parsed.responseContent ?? '',
    templateId: parsed.templateId ?? null,
    lineAccountId: parsed.lineAccountId ?? row.line_account_id ?? null,
    activeFrom: parsed.activeFrom ?? null,
    activeUntil: parsed.activeUntil ?? null,
    cooldownMinutes: parsed.cooldownMinutes ?? null,
    skipWhenOperatorActive: parsed.skipWhenOperatorActive === true,
    priority: Number.isInteger(parsed.priority) ? Number(parsed.priority) : 0,
    messageKinds: parsed.messageKinds ?? null,
    receiveSources: Array.isArray(parsed.receiveSources)
      ? parsed.receiveSources.filter((source): source is 'line' | 'email' => source === 'line' || source === 'email')
      : ['line'],
    friendConditions: parsed.friendConditions ?? null,
    actions: parsed.actions ?? null,
    responseWeekdays: parsed.responseWeekdays ?? null,
    responseHolidayRule: parsed.responseHolidayRule ?? null,
    oncePerFriend: parsed.oncePerFriend === true,
    keywords: parsed.keywords ?? null,
    respondToAll: parsed.respondToAll === true,
    name: parsed.name ?? null,
    keywordMatchMode: parsed.keywordMatchMode === 'all' ? 'all' : 'any',
    normalizeKeywords: parsed.normalizeKeywords !== false,
    folderId: parsed.folderId ?? null,
    internalMemo: parsed.internalMemo ?? null,
    replyDelaySeconds: Number.isInteger(parsed.replyDelaySeconds)
      ? Number(parsed.replyDelaySeconds)
      : null,
    unmatchedAction: parsed.unmatchedAction ?? null,
  };
}

export function autoReplyRowFromDraftSettings(
  id: string,
  settings: AutoReplyDraftSettings,
  createdAt = jstNow(),
): AutoReply {
  return {
    id,
    keyword: settings.keyword,
    match_type: settings.matchType,
    response_type: settings.responseType,
    response_content: settings.responseContent,
    template_id: settings.templateId,
    line_account_id: settings.lineAccountId,
    is_active: 0,
    active_from: settings.activeFrom,
    active_until: settings.activeUntil,
    cooldown_minutes: settings.cooldownMinutes,
    skip_when_operator_active: settings.skipWhenOperatorActive ? 1 : 0,
    priority: settings.priority,
    message_kinds_json: settings.messageKinds,
    friend_conditions_json: settings.friendConditions,
    folder_id: settings.folderId,
    display_order: 0,
    actions_json: settings.actions,
    response_weekdays_json: settings.responseWeekdays,
    response_holiday_rule: settings.responseHolidayRule,
    once_per_friend: settings.oncePerFriend ? 1 : 0,
    keywords_json: settings.keywords,
    respond_to_all: settings.respondToAll ? 1 : 0,
    name: settings.name,
    keyword_match_mode: settings.keywordMatchMode,
    normalize_keywords: settings.normalizeKeywords !== false,
    receive_sources: settings.receiveSources,
    reply_delay_seconds: settings.replyDelaySeconds ?? null,
    unmatched_action: settings.unmatchedAction ?? null,
    /* 下書き設定から作った仮の行。停止・削除の記録はまだ無い。 */
    lifecycle_status: 'draft',
    stopped_at: null,
    stopped_by_staff_id: null,
    stop_reason: null,
    stop_idempotency_key: null,
    deleted_at: null,
    deleted_by_staff_id: null,
    created_at: createdAt,
  };
}

export async function getAutoReplyVersionById(
  db: D1Database,
  versionId: string,
): Promise<AutoReplyVersionRow | null> {
  return db.prepare(`SELECT * FROM auto_reply_versions WHERE id = ?`)
    .bind(versionId)
    .first<AutoReplyVersionRow>();
}

export async function getAutoReplyDraftVersion(
  db: D1Database,
  autoReplyId: string,
): Promise<AutoReplyVersionRow | null> {
  return db.prepare(
    `SELECT arv.*
       FROM auto_replies ar
       JOIN auto_reply_versions arv ON arv.id = ar.current_draft_version_id
      WHERE ar.id = ? AND ar.deleted_at IS NULL AND arv.status = 'draft'`,
  ).bind(autoReplyId).first<AutoReplyVersionRow>();
}

export async function getAutoReplyPublishedVersion(
  db: D1Database,
  autoReplyId: string,
): Promise<AutoReplyVersionRow | null> {
  return db.prepare(
    `SELECT arv.*
       FROM auto_replies ar
       JOIN auto_reply_versions arv ON arv.id = ar.current_published_version_id
      WHERE ar.id = ? AND ar.deleted_at IS NULL AND arv.status = 'published'`,
  ).bind(autoReplyId).first<AutoReplyVersionRow>();
}

/**
 * 一覧・詳細の応答に載せる社内メモ。編集画面と同じ版（下書きを優先し、
 * 無ければ公開版）のスナップショットから読む。版が無い・壊れている
 * ルールはメモ無しとして扱う。
 */
export async function getAutoReplyInternalMemos(
  db: D1Database,
  autoReplyIds: string[],
): Promise<Map<string, string | null>> {
  const memos = new Map<string, string | null>();
  if (autoReplyIds.length === 0) return memos;
  const rows = await db.prepare(
    `SELECT arv.auto_reply_id AS auto_reply_id, arv.definition_snapshot AS definition_snapshot
       FROM auto_replies ar
       JOIN auto_reply_versions arv
         ON arv.id = COALESCE(ar.current_draft_version_id, ar.current_published_version_id)
      WHERE ar.id IN (${sqlIdSet(autoReplyIds).sql})`,
  ).bind(...(autoReplyIds.length ? sqlIdSet(autoReplyIds).binds : [])).all<{ auto_reply_id: string; definition_snapshot: string }>();
  for (const row of rows.results ?? []) {
    try {
      const parsed = JSON.parse(row.definition_snapshot) as { internalMemo?: unknown };
      memos.set(
        row.auto_reply_id,
        typeof parsed.internalMemo === 'string' && parsed.internalMemo !== ''
          ? parsed.internalMemo
          : null,
      );
    } catch {
      memos.set(row.auto_reply_id, null);
    }
  }
  return memos;
}

/**
 * 社内メモは auto_replies に列を持たず、版のスナップショット
 * （definition_snapshot）にだけ置く。編集画面が読む版（下書きを優先し、
 * 無ければ公開版）へ書き込み、版がまだ無いルールには公開版を1つ作る。
 * 停止中に作られたルールは実行されず ensureAutoReplyPublishedVersion が
 * 走らないため、ここで版を確保しないとメモの置き場が無い（AUTOREPLY-09）。
 *
 * 公開済みの版は実行記録から参照されるため definition_snapshot は不変
 * （trg_auto_reply_versions_immutable_update）。公開版のメモを変えるときは
 * 旧版を retired へ進め、実行中の定義＋新しいメモを持つ新版へ張り替える。
 * 下書きは未公開の作業中なので、そのまま書き換えてよい。
 */
/**
 * 社内メモの書込文だけを組み立てて返す。呼び出し側が
 * ルール行・参照表と1回の batch に束ね、途中失敗で食い違わないようにする。
 */
export async function planAutoReplyInternalMemoStatements(
  db: D1Database,
  rule: AutoReply,
  internalMemo: string | null | undefined,
  normalizeKeywords?: boolean,
): Promise<{ statements: D1PreparedStatement[]; draftUpdated: boolean; versionId: string | null }> {
  const now = jstNow();
  const draft = await getAutoReplyDraftVersion(db, rule.id);
  if (draft) {
    const snapshot = JSON.parse(draft.definition_snapshot) as Record<string, unknown>;
    if (internalMemo !== undefined) snapshot.internalMemo = internalMemo;
    if (normalizeKeywords !== undefined) snapshot.normalizeKeywords = normalizeKeywords;
    return {
      statements: [
        db.prepare(
          `UPDATE auto_reply_versions
              SET definition_snapshot = ?, updated_at = ?
            WHERE id = ?`,
        ).bind(JSON.stringify(snapshot), now, draft.id),
      ],
      draftUpdated: true,
      versionId: draft.id,
    };
  }

  const published = await getAutoReplyPublishedVersion(db, rule.id);
  // 実行中の定義は auto_replies の現行値。版にしか無い設定
  // （受信経路・遅延・未一致時の別動作）は、消えないよう直前の版から引き継ぐ。
  const previous = published ? parseAutoReplyVersionSettings(published) : null;
  const snapshot = JSON.stringify({
    ...autoReplyDraftSettingsFromRow(rule),
    receiveSources: previous?.receiveSources ?? ['line'],
    normalizeKeywords: normalizeKeywords ?? (previous?.normalizeKeywords !== false),
    internalMemo: internalMemo === undefined ? previous?.internalMemo ?? null : internalMemo,
    replyDelaySeconds: previous?.replyDelaySeconds ?? null,
    unmatchedAction: previous?.unmatchedAction ?? null,
  });
  const next = await db.prepare(
    `SELECT COALESCE(MAX(version_number), 0) + 1 AS version_number
       FROM auto_reply_versions WHERE auto_reply_id = ?`,
  ).bind(rule.id).first<{ version_number: number }>();
  const versionId = crypto.randomUUID();
  return {
    versionId,
    statements: [
      db.prepare(
        `UPDATE auto_reply_versions SET status = 'retired', updated_at = ?
          WHERE auto_reply_id = ? AND status = 'published'`,
      ).bind(now, rule.id),
      db.prepare(
        `INSERT INTO auto_reply_versions
           (id, auto_reply_id, version_number, line_account_id, definition_snapshot,
            status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'published', ?, ?)`,
      ).bind(
        versionId,
        rule.id,
        Number(next?.version_number ?? 1),
        rule.line_account_id,
        snapshot,
        now,
        now,
      ),
      db.prepare(
        `UPDATE auto_replies SET confirmation_revision = confirmation_revision + 1, current_published_version_id = ? WHERE id = ?`,
      ).bind(versionId, rule.id),
    ],
    draftUpdated: false,
  };
}

export async function saveAutoReplyInternalMemo(
  db: D1Database,
  rule: AutoReply,
  internalMemo: string | null,
): Promise<void> {
  const planned = await planAutoReplyInternalMemoStatements(db, rule, internalMemo);
  await db.batch(planned.statements);
}
