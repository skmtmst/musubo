export type { AutoReply, CreateAutoReplyInput } from './auto-reply-record-types.js';
import type { AutoReply, CreateAutoReplyInput } from './auto-reply-record-types.js';
import { jstNow } from './utils.js';
import { removeConsumerReferences, planSyncTemplateReferenceStatements } from './template-versions.js';
import {
  planAutoReplyInternalMemoStatements,
  findAutoReplyCreateClaim,
  resolveAutoReplyCreateClaim,
  autoReplyCreateClaimStatement,
} from './auto-reply-runs.js';
import type { AutoReplyCreateIdempotency } from './auto-reply-runs-types.js';

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function getAutoReplies(
  db: D1Database,
  lineAccountId?: string,
): Promise<AutoReply[]> {
  if (lineAccountId) {
    const result = await db
      .prepare(
        // 上から順に評価して最初に当てはまった1件だけが動く。画面の並び順と
        // 評価順を一致させるため、一覧もこの順で返す。
        // 削除済み（deleted_at あり）は履歴として残すだけで、一覧には出さない。
        `SELECT * FROM auto_replies WHERE deleted_at IS NULL
          AND (line_account_id IS NULL OR line_account_id = ?)
          ORDER BY priority ASC, created_at ASC`,
      )
      .bind(lineAccountId)
      .all<AutoReply>();
    return result.results;
  }
  const result = await db
    .prepare(
      `SELECT * FROM auto_replies WHERE deleted_at IS NULL
        ORDER BY priority ASC, created_at ASC`,
    )
    .all<AutoReply>();
  return result.results;
}

export async function getAutoReplyById(
  db: D1Database,
  id: string,
): Promise<AutoReply | null> {
  return db
    .prepare(`SELECT * FROM auto_replies WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first<AutoReply>();
}

/** 空の配列は保存しない。「設定あり・中身なし」と「未設定」を分けないため。 */
function jsonOrNull(value: unknown[] | null | undefined): string | null {
  if (!value || value.length === 0) return null;
  return JSON.stringify(value);
}

export async function createAutoReply(
  db: D1Database,
  input: CreateAutoReplyInput,
  idempotency?: AutoReplyCreateIdempotency,
): Promise<{ rule: AutoReply; replayed: boolean }> {
  if (idempotency) {
    const previous = await findAutoReplyCreateClaim(db, idempotency.key);
    if (previous) {
      const matched = await resolveAutoReplyCreateClaim(db, idempotency.key, previous, 'rule', idempotency.fingerprint);
      if (matched) return { rule: matched, replayed: true };
    }
  }
  const id = crypto.randomUUID();
  const now = jstNow();
  const isActive = input.isActive === true;

  /*
   * 行・版・参照表を1回の batch で書く。版の書込が落ちたら
   * 行も残らない。不完全な行が残る部分成功を起こさない。
   */
  const created: AutoReply = {
    id,
    keyword: input.keyword,
    match_type: input.matchType ?? 'exact',
    response_type: input.responseType ?? 'text',
    response_content: input.responseContent,
    template_id: input.templateId ?? null,
    line_account_id: input.lineAccountId ?? null,
    is_active: isActive ? 1 : 0,
    active_from: input.activeFrom ?? null,
    active_until: input.activeUntil ?? null,
    cooldown_minutes: input.cooldownMinutes ?? null,
    skip_when_operator_active: input.skipWhenOperatorActive ? 1 : 0,
    priority: input.priority ?? 0,
    message_kinds_json: input.messageKinds && input.messageKinds.length > 0
      ? JSON.stringify(input.messageKinds)
      : null,
    friend_conditions_json: input.friendConditions ? JSON.stringify(input.friendConditions) : null,
    folder_id: input.folderId ?? null,
    display_order: 0,
    actions_json: jsonOrNull(input.actions),
    response_weekdays_json: jsonOrNull(input.responseWeekdays),
    response_holiday_rule: input.responseHolidayRule ?? null,
    once_per_friend: input.oncePerFriend ? 1 : 0,
    keywords_json: jsonOrNull(input.keywords),
    respond_to_all: input.respondToAll ? 1 : 0,
    name: input.name ?? null,
    keyword_match_mode: input.keywordMatchMode ?? 'any',
    // 止まって作った行は stopped、明示的に有効化した行は published。
    // draft は createAutoReplyWithDraftVersion 専用。
    lifecycle_status: isActive ? 'published' : 'stopped',
    stopped_at: null,
    stopped_by_staff_id: null,
    stop_reason: null,
    stop_idempotency_key: null,
    deleted_at: null,
    deleted_by_staff_id: null,
    created_at: now,
  };
  /*
   * 社内メモと編集画面が読む版を先に確保する。停止したまま作ったルールは
   * 実行されず ensureAutoReplyPublishedVersion が走らないので、ここで
   * 公開版を作っておかないとメモの置き場も編集画面の読み込み先も無い。
   * 版の状態は実行中の定義を表すので 'published'。ルール本体の
   * lifecycle_status（stopped）は変えない。新規行に下書きは無いので、
   * メモの plan は公開版の作成文だけを返す。
   */
  const memoPlanned = await planAutoReplyInternalMemoStatements(db, created, input.internalMemo ?? null,input.normalizeKeywords);
  // 保存で参照表を書き換える。どの版を使っているかの正本。
  const refStatements = await planSyncTemplateReferenceStatements(
    db,
    'auto_reply',
    id,
    created.template_id ? [created.template_id] : [],
  );
  // 要求キーの行も同じ batch で確定する。本体より後に積むため、
  // 外部キーのある環境でも制約に当たらない。同じキーの同時実行は
  // UNIQUE 制約で負けた側だけ巻き戻り、二重に残らない。
  const claimStatements = idempotency && memoPlanned.versionId
    ? [
      autoReplyCreateClaimStatement(
        db,
        'rule',
        created.line_account_id,
        idempotency,
        id,
        memoPlanned.versionId,
        now,
      ),
    ]
    : [];
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO auto_replies
         (id, keyword, match_type, response_type, response_content,
          template_id, line_account_id, is_active,
          active_from, active_until, cooldown_minutes, skip_when_operator_active,
          priority, message_kinds_json,
          actions_json, response_weekdays_json, response_holiday_rule,
          once_per_friend, keywords_json, friend_conditions_json, respond_to_all, name, keyword_match_mode, folder_id,
          lifecycle_status,
          created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      created.id,
      created.keyword,
      created.match_type,
      created.response_type,
      created.response_content,
      created.template_id,
      created.line_account_id,
      created.is_active,
      created.active_from,
      created.active_until,
      created.cooldown_minutes,
      created.skip_when_operator_active,
      created.priority,
      created.message_kinds_json,
      created.actions_json,
      created.response_weekdays_json,
      created.response_holiday_rule,
      created.once_per_friend,
      created.keywords_json,
      created.friend_conditions_json,
      created.respond_to_all,
      created.name,
      created.keyword_match_mode,
      created.folder_id,
      created.lifecycle_status,
      created.created_at,
    ),
    ...memoPlanned.statements,
    ...refStatements,
    ...claimStatements,
    ]);
  } catch (err) {
    // 同時に同じキーが確定した可能性がある。勝った側の結果に従い、
    // 勝者がいなければ元の失敗をそのまま返す（握りつぶさない）。
    if (idempotency) {
      const raced = await findAutoReplyCreateClaim(db, idempotency.key).catch(() => null);
      if (raced?.operation === 'rule' && raced.request_fingerprint === idempotency.fingerprint) {
        const winner = await getAutoReplyById(db, raced.auto_reply_id).catch(() => null);
        if (winner) return { rule: winner, replayed: true };
      }
    }
    throw err;
  }

  const saved = await getAutoReplyById(db, id);
  if (!saved) throw new Error('AUTO_REPLY_NOT_CREATED');
  return { rule: saved, replayed: false };
}

export interface UpdateAutoReplyInput {
  keyword?: string;
  matchType?: 'exact' | 'contains';
  responseType?: string;
  responseContent?: string;
  templateId?: string | null;
  lineAccountId?: string | null;
  isActive?: boolean;
  activeFrom?: string | null;
  activeUntil?: string | null;
  cooldownMinutes?: number | null;
  skipWhenOperatorActive?: boolean;
  priority?: number;
  messageKinds?: string[] | null;
  /** 151: 応答したときに順に実行すること。 */
  actions?: unknown[] | null;
  /** 151: 応答する曜日（0=日 … 6=土）。 */
  responseWeekdays?: number[] | null;
  /** 151: 'ignore' | 'include' | 'exclude' */
  responseHolidayRule?: string | null;
  /** 151: 1人につき1回だけ応答する。 */
  oncePerFriend?: boolean;
  /** 151: キーワードの複数行。 */
  keywords?: unknown[] | null;
  /** 友だちの絞り込み（一斉配信・シナリオと同じ形）。 */
  friendConditions?: unknown | null;
  /** 157: キーワードを問わず応答する。 */
  respondToAll?: boolean;
  /** 158: 管理用の名前。 */
  name?: string | null;
  /** 158: 'any'（どれか1つ）か 'all'（すべて）。 */
  keywordMatchMode?: 'any' | 'all';
  normalizeKeywords?: boolean;
  /** フォルダ。分けていなければ null。 */
  folderId?: string | null;
  /**
   * 運用者だけが読むメモ。送られたときだけ更新する。省略は「触らない」で、
   * メモを持たない呼び出しが既存のメモを消すことはない（AUTOREPLY-09）。
   */
  internalMemo?: string | null;
}

export async function updateAutoReply(
  db: D1Database,
  id: string,
  input: UpdateAutoReplyInput,
): Promise<AutoReply | null> {
  const existing = await getAutoReplyById(db, id);
  if (!existing) return null;

  /*
   * isActive の切替は lifecycle_status と揃える。専用の停止口（stopAutoReply）が
   * 理由・担当者・日時を残すが、素のトグル経由でも 'published'/'stopped' が
   * 矛盾した組合せにならないようにする。'draft' は公開の前段なので触らない。
   */
  let lifecycleStatus = existing.lifecycle_status;
  if ('isActive' in input) {
    if (input.isActive && existing.lifecycle_status === 'stopped') {
      lifecycleStatus = 'published';
    } else if (!input.isActive && existing.lifecycle_status === 'published') {
      lifecycleStatus = 'stopped';
    }
  }

  /*
   * 行・版・参照表を1回の batch で書く。版の書込が落ちたら
   * 行も変えず、行と公開版が食い違わない。
   */
  const merged: AutoReply = {
    ...existing,
    keyword: input.keyword ?? existing.keyword,
    match_type: input.matchType ?? existing.match_type,
    response_type: input.responseType ?? existing.response_type,
    response_content: input.responseContent ?? existing.response_content,
    template_id: 'templateId' in input ? (input.templateId ?? null) : existing.template_id,
    line_account_id: 'lineAccountId' in input ? (input.lineAccountId ?? null) : existing.line_account_id,
    is_active: 'isActive' in input ? (input.isActive ? 1 : 0) : existing.is_active,
    lifecycle_status: lifecycleStatus,
    active_from: 'activeFrom' in input ? (input.activeFrom ?? null) : existing.active_from,
    active_until: 'activeUntil' in input ? (input.activeUntil ?? null) : existing.active_until,
    cooldown_minutes: 'cooldownMinutes' in input ? (input.cooldownMinutes ?? null) : existing.cooldown_minutes,
    skip_when_operator_active: 'skipWhenOperatorActive' in input
      ? (input.skipWhenOperatorActive ? 1 : 0)
      : existing.skip_when_operator_active,
    priority: 'priority' in input ? (input.priority ?? 0) : existing.priority,
    message_kinds_json: 'messageKinds' in input
      ? (input.messageKinds && input.messageKinds.length > 0
          ? JSON.stringify(input.messageKinds)
          : null)
      : existing.message_kinds_json,
    // 配列や条件は「空なら NULL」に寄せる。空配列を保存すると、読む側で
    // 「設定あり・中身なし」と「未設定」を区別する必要が出る。
    actions_json: 'actions' in input ? jsonOrNull(input.actions) : existing.actions_json,
    response_weekdays_json: 'responseWeekdays' in input
      ? jsonOrNull(input.responseWeekdays)
      : existing.response_weekdays_json,
    response_holiday_rule: 'responseHolidayRule' in input
      ? (input.responseHolidayRule ?? null)
      : existing.response_holiday_rule,
    once_per_friend: 'oncePerFriend' in input
      ? (input.oncePerFriend ? 1 : 0)
      : existing.once_per_friend,
    keywords_json: 'keywords' in input ? jsonOrNull(input.keywords) : existing.keywords_json,
    friend_conditions_json: 'friendConditions' in input
      ? (input.friendConditions ? JSON.stringify(input.friendConditions) : null)
      : existing.friend_conditions_json,
    respond_to_all: 'respondToAll' in input ? (input.respondToAll ? 1 : 0) : existing.respond_to_all,
    name: 'name' in input ? (input.name ?? null) : existing.name,
    keyword_match_mode: 'keywordMatchMode' in input
      ? (input.keywordMatchMode ?? 'any')
      : existing.keyword_match_mode,
    folder_id: 'folderId' in input ? (input.folderId ?? null) : existing.folder_id,
  };
  const memoPlanned = 'internalMemo' in input || 'normalizeKeywords' in input
    ? await planAutoReplyInternalMemoStatements(db, merged, 'internalMemo' in input ? input.internalMemo ?? null : undefined,input.normalizeKeywords)
    : { statements: [], draftUpdated: false };
  // 保存で参照表を書き換える。外した参照はここで消える。
  const refStatements = await planSyncTemplateReferenceStatements(
    db,
    'auto_reply',
    id,
    merged.template_id ? [merged.template_id] : [],
  );
  await db.batch([
    db.prepare(
      `UPDATE auto_replies
       SET confirmation_revision = confirmation_revision + 1, keyword = ?,
           match_type = ?,
           response_type = ?,
           response_content = ?,
           template_id = ?,
           line_account_id = ?,
           is_active = ?,
           lifecycle_status = ?,
           active_from = ?,
           active_until = ?,
           cooldown_minutes = ?,
           skip_when_operator_active = ?,
           priority = ?,
           message_kinds_json = ?,
           actions_json = ?,
           response_weekdays_json = ?,
           response_holiday_rule = ?,
           once_per_friend = ?,
           keywords_json = ?,
           friend_conditions_json = ?,
           respond_to_all = ?,
           name = ?,
           keyword_match_mode = ?,
           folder_id = ?,
           created_at = ?
       WHERE id = ?`,
    ).bind(
      merged.keyword,
      merged.match_type,
      merged.response_type,
      merged.response_content,
      merged.template_id,
      merged.line_account_id,
      merged.is_active,
      merged.lifecycle_status,
      merged.active_from,
      merged.active_until,
      merged.cooldown_minutes,
      merged.skip_when_operator_active,
      merged.priority,
      merged.message_kinds_json,
      merged.actions_json,
      merged.response_weekdays_json,
      merged.response_holiday_rule,
      merged.once_per_friend,
      merged.keywords_json,
      merged.friend_conditions_json,
      merged.respond_to_all,
      merged.name,
      merged.keyword_match_mode,
      merged.folder_id,
      merged.created_at,
      id,
    ),
    ...memoPlanned.statements,
    ...refStatements,
  ]);

  return getAutoReplyById(db, id);
}

/**
 * 専用の停止口。
 *
 * isActive の素のトグルと違い、いつ・誰が・なぜ止めたかを残す。
 * stopped_* は「最後に停止した記録」なので、再び動かしても消さない。
 * 同じ冪等キーの再送は新しい停止として上書きしない。
 */
export async function stopAutoReply(
  db: D1Database,
  input: {
    id: string;
    staffId: string | null;
    reason: string | null;
    idempotencyKey: string;
    expectedVersion?: number;
  },
): Promise<AutoReply | null> {
  const replay = await db
    .prepare(
      `SELECT * FROM auto_replies
        WHERE id = ? AND stop_idempotency_key = ? AND deleted_at IS NULL`,
    )
    .bind(input.id, input.idempotencyKey)
    .first<AutoReply>();
  if (replay) {
    if (input.expectedVersion !== undefined && replay.confirmation_revision !== input.expectedVersion + 1) throw new Error('AUTO_REPLY_CONFIRMATION_CONFLICT');
    return replay;
  }
  const now = jstNow();
  const updated = await db
    .prepare(
      `UPDATE auto_replies
          SET confirmation_revision = confirmation_revision + 1, is_active = 0,
              lifecycle_status = CASE
                WHEN lifecycle_status = 'published' THEN 'stopped'
                ELSE lifecycle_status
              END,
              stopped_at = ?,
              stopped_by_staff_id = ?,
              stop_reason = ?,
              stop_idempotency_key = ?
        WHERE id = ? AND deleted_at IS NULL AND (? IS NULL OR confirmation_revision = ?)`,
    )
    .bind(now, input.staffId, input.reason, input.idempotencyKey, input.id, input.expectedVersion ?? null, input.expectedVersion ?? null)
    .run();
  if (!updated.meta.changes && input.expectedVersion !== undefined && await getAutoReplyById(db, input.id)) throw new Error('AUTO_REPLY_CONFIRMATION_CONFLICT');
  return getAutoReplyById(db, input.id);
}

/**
 * 削除は履歴を残す方式。
 *
 * 物理削除すると、設定と「誰が消したか」が跡形もなく消える。行を残して
 * deleted_at で隠し、一覧・評価・集計は deleted_at IS NULL の行だけを見る。
 * 過去の一致記録（auto_reply_hits）や実行台帳はそのまま残る。
 */
export async function deleteAutoReply(
  db: D1Database,
  id: string,
  staffId: string | null = null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE auto_replies
          SET confirmation_revision = confirmation_revision + 1, deleted_at = ?, deleted_by_staff_id = ?, is_active = 0,
              lifecycle_status = CASE
                WHEN lifecycle_status = 'published' THEN 'stopped'
                ELSE lifecycle_status
              END
        WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(jstNow(), staffId, id)
    .run();
  // 467: 消えた（論理削除の）自動応答の参照を消す。
  await removeConsumerReferences(db, 'auto_reply', id);
}

/*
 * 削除の取り消し（B 元に戻す）。deleted_at を空に戻すだけ。
 * 戻した直後は止めたまま（is_active = 0）にする。戻した瞬間に送り出すと、
 * 消えているつもりの間に変わった設定がお客さまへ届くため。再開は画面の
 * 再開操作（update isActive）で行う。参照の復活はしない（削除時に外した
 * 参照先が変わっている場合があるため。必要なら画面で付け直す）。
 */
export async function restoreAutoReply(
  db: D1Database,
  id: string,
): Promise<AutoReply | null> {
  const result = await db
    .prepare(
      `UPDATE auto_replies
          SET confirmation_revision = confirmation_revision + 1, deleted_at = NULL, deleted_by_staff_id = NULL, is_active = 0
        WHERE id = ? AND deleted_at IS NOT NULL`,
    )
    .bind(id)
    .run();
  if ((result.meta.changes ?? 0) !== 1) return null;
  return db
    .prepare(`SELECT * FROM auto_replies WHERE id = ?`)
    .bind(id)
    .first<AutoReply>();
}

// =============================================================================
// 当たった記録（152）
// =============================================================================

export async function recordAutoReplyHit(
  db: D1Database,
  input: {
    autoReplyId: string;
    friendId?: string | null;
    lineAccountId?: string | null;
    matchedKeyword?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO auto_reply_hits
         (id, auto_reply_id, friend_id, line_account_id, matched_keyword, hit_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.autoReplyId,
      input.friendId ?? null,
      input.lineAccountId ?? null,
      input.matchedKeyword ?? null,
      jstNow(),
    )
    .run();
}

/**
 * この人に、このルールで一度でも応答したことがあるか。
 * 「1人につき1回だけ応答する」の判定に使う。
 */
export async function hasAutoReplyHitForFriend(
  db: D1Database,
  autoReplyId: string,
  friendId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM auto_reply_hits
        WHERE auto_reply_id = ? AND friend_id = ? LIMIT 1`,
    )
    .bind(autoReplyId, friendId)
    .first<{ hit: number }>();
  return row != null;
}

export interface AutoReplyHitCount {
  autoReplyId: string;
  /** 期間内の回数。 */
  period: number;
  /** 記録が残っている全期間の回数。 */
  total: number;
}

/**
 * ルールごとの当たった回数。一覧に「35回（累計 35）」と出すため。
 *
 * from / to は日本時間の ISO 文字列。to は含まない。
 */
export async function getAutoReplyHitCounts(
  db: D1Database,
  lineAccountId: string | null,
  from: string,
  to: string,
): Promise<AutoReplyHitCount[]> {
  // グローバルのルール（line_account_id が NULL）も一緒に数える。
  // 一覧が両方を並べて出しているので、数だけ片方に寄せると食い違う。
  const rows = await db
    .prepare(
      `SELECT h.auto_reply_id AS auto_reply_id,
              SUM(CASE WHEN h.hit_at >= ? AND h.hit_at < ? THEN 1 ELSE 0 END) AS period,
              COUNT(*) AS total
         FROM auto_reply_hits h
         JOIN auto_replies r ON r.id = h.auto_reply_id
        WHERE r.deleted_at IS NULL
          AND (r.line_account_id IS NULL OR r.line_account_id = ?)
        GROUP BY h.auto_reply_id`,
    )
    .bind(from, to, lineAccountId)
    .all<{ auto_reply_id: string; period: number; total: number }>();
  return (rows.results ?? []).map((r) => ({
    autoReplyId: r.auto_reply_id,
    period: r.period,
    total: r.total,
  }));
}

/**
 * 公開前確認に出す、1ルールの期間内一致数。
 *
 * 0件と集計失敗を混ぜないため、この関数は取得できた数だけを返し、
 * 呼び出し側が失敗を null として扱う。
 */
export async function getAutoReplyHitCountSince(
  db: D1Database,
  autoReplyId: string,
  since: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM auto_reply_hits
        WHERE auto_reply_id = ?
          AND datetime(hit_at) >= datetime(?)`,
    )
    .bind(autoReplyId, since)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}
