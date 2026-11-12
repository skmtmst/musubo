import type { TemplateRow } from './template-row-types.js';
export type { TemplateRow } from './template-row-types.js';
import { sqlIdSet } from './id-queries.js';
import { jstNow } from './utils.js';
import { applyMediaUsageMutation } from './media/index.js';
import { publishedVersionStatement } from './template-publish-statement.js';
export { publishedVersionStatement } from './template-publish-statement.js';

/** 下書きがあるかどうか。どれか1列でも入っていれば true。 */
export function hasTemplateDraft(row: Pick<TemplateRow,
  'draft_message_type' | 'draft_message_content' |
  'draft_carousel_actions_json' | 'draft_carousel_tap_limit_mode' |
  'draft_carousel_tap_limit_text' | 'draft_question_json' |
  'draft_question_status'> | null | undefined,
): boolean {
  if (!row) return false;
  // `!= null` で見る。347 より前の形の行や、一部の列だけ取る SELECT でも
  // 「下書きなし」と正しく判定するため。
  return row.draft_message_type != null
    || row.draft_message_content != null
    || row.draft_carousel_actions_json != null
    || row.draft_carousel_tap_limit_mode != null
    || row.draft_carousel_tap_limit_text != null
    || row.draft_question_json != null
    || row.draft_question_status != null;
}

export async function getTemplates(db: D1Database, category?: string): Promise<TemplateRow[]> {
  if (category) {
    const result = await db.prepare(`SELECT * FROM templates WHERE deleted_at IS NULL AND category = ? ORDER BY created_at DESC`)
      .bind(category).all<TemplateRow>();
    return result.results;
  }
  const result = await db.prepare(`SELECT * FROM templates WHERE deleted_at IS NULL ORDER BY created_at DESC`).all<TemplateRow>();
  return result.results;
}

export async function getTemplateById(db: D1Database, id: string): Promise<TemplateRow | null> {
  return db.prepare(`SELECT * FROM templates WHERE id = ? AND deleted_at IS NULL`).bind(id).first<TemplateRow>();
}

/**
 * 下書き全文の指紋(SHA-256 hex)。同じ内容なら同じ値に
 * なり、1文字でも違えば(削除も含めて)変わる。同キー再試行が別操作か
 * どうかの見分けに使う(成功時の控えと比べる)。32bit 非暗号ハッシュは不可。
 */
export async function templateDraftFingerprint(
  draft: Pick<TemplateRow,
    'draft_message_type' | 'draft_message_content' |
    'draft_carousel_actions_json' | 'draft_carousel_tap_limit_mode' |
    'draft_carousel_tap_limit_text' | 'draft_question_json' |
    'draft_question_status' | 'draft_message_bubbles_json'>,
): Promise<string> {
  const canonical = JSON.stringify([
    draft.draft_message_type ?? null,
    draft.draft_message_content ?? null,
    draft.draft_carousel_actions_json ?? null,
    draft.draft_carousel_tap_limit_mode ?? null,
    draft.draft_carousel_tap_limit_text ?? null,
    draft.draft_question_json ?? null,
    draft.draft_question_status ?? null,
    draft.draft_message_bubbles_json ?? null,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * いま送ってよいテンプレートかどうか。
 * 公開版があること(版1以上)に加え、送る側と持ち主の両方が分かり、
 * 完全一致すること。どちらかが null の wildcard 照合はしない(fail-close)。
 * 未公開・別アカウント・持ち主不明は送らない。
 */
export function isTemplateSendable(
  row: Pick<TemplateRow, 'published_version' | 'line_account_id' | 'message_bubbles_json'> | null | undefined,
  lineAccountId?: string | null,
): boolean {
  if (!row || row.message_bubbles_json) return false;
  if (Number(row.published_version ?? 0) < 1) return false;
  if (lineAccountId == null || row.line_account_id == null) return false;
  return row.line_account_id === lineAccountId;
}

/** 送ってよいテンプレートだけを返す。未公開・別アカウント・持ち主不明は null。 */
export async function getSendableTemplate(
  db: D1Database,
  id: string,
  lineAccountId?: string | null,
): Promise<TemplateRow | null> {
  const row = await getTemplateById(db, id);
  return row && isTemplateSendable(row, lineAccountId) ? row : null;
}

/**
 * 結びつけてよいテンプレートかどうか。
 * 公開版があり、結びつける側と完全一致すること。持ち主不明は通さない
 * (fail-close)。持ち主未定のシナリオに結ぶと、送る側で別アカウントの
 * 公開版が混ざる。送信時と同じ条件にする。
 */
export function isTemplateAssociable(
  row: Pick<TemplateRow, 'published_version' | 'line_account_id' | 'message_bubbles_json'> | null | undefined,
  lineAccountId?: string | null,
): boolean {
  if (!row || row.message_bubbles_json) return false;
  if (Number(row.published_version ?? 0) < 1) return false;
  if (lineAccountId == null || row.line_account_id == null) return false;
  return row.line_account_id === lineAccountId;
}

/** 結びつけてよいテンプレートだけを返す。 */
export async function getAssociableTemplate(
  db: D1Database,
  id: string,
  lineAccountId?: string | null,
): Promise<TemplateRow | null> {
  const row = await getTemplateById(db, id);
  return row && isTemplateAssociable(row, lineAccountId) ? row : null;
}

export interface CarouselOptions {
  /** 162: 選択肢を押したときの動き。{ パネル番号: { 選択肢番号: [...] } } */
  carouselActions?: unknown | null;
  /** 162: 'none'（制限なし）／'once'（カルーセル全体で1回） */
  carouselTapLimitMode?: 'none' | 'once';
  /** 162: 制限を超えたときに返すテキスト。 */
  carouselTapLimitText?: string | null;
}

export interface QuestionOptions {
  /** JSON文字列。null は通常テンプレート。 */
  questionJson?: string | null;
  questionStatus?: 'draft' | 'published';
}

export async function createTemplate(
  db: D1Database,
  input: {
    name: string;
    category?: string;
    messageType: string;
    messageContent: string;
    lineAccountId?: string | null;
    /** 置き場。省略・null は「未分類」。 */
    folderId?: string | null;
  } & CarouselOptions & QuestionOptions,
): Promise<TemplateRow> {
  const id = crypto.randomUUID();
  const now = jstNow();
  /*
   * 新規作成は未公開の下書きで始める。
   * live 列には初期内容を入れる(NOT NULL のため)が、版は 0・公開日時は空にし、
   * 初回の明示 publish でだけ公開版 1 になる。作った直後は送信候補に出さない。
   */
  const carouselActionsJson = input.carouselActions ? JSON.stringify(input.carouselActions) : null;
  const tapLimitMode = input.carouselTapLimitMode ?? 'none';
  const tapLimitText = input.carouselTapLimitText ?? null;
  const questionJson = input.questionJson ?? null;
  const questionStatus = input.questionStatus ?? 'published';
  const insert = db.prepare(
      `INSERT INTO templates
         (id, name, category, message_type, message_content,
          carousel_actions_json, carousel_tap_limit_mode, carousel_tap_limit_text,
          question_json, question_status, created_at, updated_at, line_account_id,
          folder_id, published_version, published_at,
          draft_message_type, draft_message_content,
          draft_carousel_actions_json, draft_carousel_tap_limit_mode, draft_carousel_tap_limit_text,
          draft_question_json, draft_question_status, draft_revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL,
               ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).bind(
      id,
      input.name,
      input.category ?? 'general',
      input.messageType,
      input.messageContent,
      carouselActionsJson,
      tapLimitMode,
      tapLimitText,
      questionJson,
      questionStatus,
      now,
      now,
      input.lineAccountId ?? null,
      input.folderId ?? null,
      input.messageType,
      input.messageContent,
      carouselActionsJson,
      tapLimitMode,
      tapLimitText,
      questionJson,
      questionStatus,
    );
  await applyMediaUsageMutation(db, {
    lineAccountId: input.lineAccountId ?? null,
    refKind: 'template',
    refId: id,
    searchableContent: [input.messageContent],
    mutationStatements: [insert],
  });
  return (await getTemplateById(db, id))!;
}

/**
 * live 列(公開版)への直接書き込み。
 *
 * 347 以降、送信文(message_type / message_content / carousel_* /
 * question_*)は公開操作でしか live 列へ書かない。編集画面の保存は
 * {@link saveTemplateDraft} を使う。ここへ送信文を渡すのは、
 * 名前・置き場だけを直す整理操作など、送信文を変えない場合に限る。
 */
export async function updateTemplate(
  db: D1Database,
  id: string,
  updates: Partial<{
    name: string;
    category: string;
    messageType: string;
    messageContent: string;
    /** 置き場。`null` を渡すと未分類へ戻す。 */
    folderId: string | null;
  }> &
    CarouselOptions & QuestionOptions,
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
  if (updates.category !== undefined) { sets.push('category = ?'); values.push(updates.category); }
  if (updates.messageType !== undefined) { sets.push('message_type = ?'); values.push(updates.messageType); }
  if (updates.messageContent !== undefined) { sets.push('message_content = ?'); values.push(updates.messageContent); }
  if (updates.carouselActions !== undefined) {
    sets.push('carousel_actions_json = ?');
    values.push(updates.carouselActions ? JSON.stringify(updates.carouselActions) : null);
  }
  if (updates.carouselTapLimitMode !== undefined) {
    sets.push('carousel_tap_limit_mode = ?');
    values.push(updates.carouselTapLimitMode);
  }
  if (updates.carouselTapLimitText !== undefined) {
    sets.push('carousel_tap_limit_text = ?');
    values.push(updates.carouselTapLimitText);
  }
  if (updates.questionJson !== undefined) {
    sets.push('question_json = ?');
    values.push(updates.questionJson);
  }
  if (updates.questionStatus !== undefined) {
    sets.push('question_status = ?');
    values.push(updates.questionStatus);
  }
  /*
    置き場。**`null` は「値が来なかった」ではなく「未分類へ戻す」。**
    だから `undefined` と `null` を分けて見る。
  */
  if (updates.folderId !== undefined) {
    sets.push('folder_id = ?');
    values.push(updates.folderId);
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  values.push(jstNow());
  values.push(id);
  const mutation = db.prepare(`UPDATE templates SET confirmation_revision=confirmation_revision+1, ${sets.join(', ')} WHERE id = ?`).bind(...values);
  if (updates.messageContent !== undefined) {
    const current = await getTemplateById(db, id);
    if (!current) return;
    await applyMediaUsageMutation(db, {
      lineAccountId: current.line_account_id,
      refKind: 'template',
      refId: id,
      searchableContent: [updates.messageContent, current.draft_message_content],
      mutationStatements: [mutation],
    });
    return;
  }
  await mutation.run();
}

export async function deleteTemplate(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE templates SET confirmation_revision=confirmation_revision+1, deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`).bind(jstNow(), jstNow(), id),
    db.prepare(`DELETE FROM media_usages WHERE ref_kind = 'template' AND ref_id = ?`).bind(id),
  ]);
}

/** 自動作成した未公開の下書きだけ、読み取った版のままなら消す。 */
export async function deleteCreatedTemplateDraft(db: D1Database, id: string, revision: number): Promise<boolean> {
  const now = jstNow();
  try {
    await db.batch([
      db.prepare(`SELECT json('__TEMPLATE_DRAFT_CHANGED__') WHERE NOT EXISTS (
        SELECT 1 FROM templates WHERE id = ? AND deleted_at IS NULL
          AND COALESCE(published_version, 0) = 0 AND COALESCE(draft_revision, 0) = ?
      )`).bind(id, revision),
      db.prepare(`UPDATE templates SET confirmation_revision=confirmation_revision+1, deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`).bind(now, now, id),
      db.prepare(`DELETE FROM media_usages WHERE ref_kind = 'template' AND ref_id = ?`).bind(id),
    ]);
    return true;
  } catch (error) {
    if (error instanceof Error && /malformed JSON/i.test(error.message)) return false;
    throw error;
  }
}

export interface TemplateDraftUpdates {
  /** 編集画面を読み込んだ時点の版。保存直前の読み直しで置き換えない。 */
  expectedVersion?: number;
  expectedDraftRevision?: number;
  name?: string;
  category?: string;
  folderId?: string | null;
  messageBubblesJson?: string | null;
  messageType?: string;
  messageContent?: string;
  /** 162: 選択肢を押したときの動き。`null` は動きの削除。 */
  carouselActions?: unknown | null;
  carouselTapLimitMode?: 'none' | 'once';
  /** 制限超過時の返信。`null` は返さない。 */
  carouselTapLimitText?: string | null;
  /** JSON文字列。`null` は通常テンプレートへ戻す。 */
  questionJson?: string | null;
  questionStatus?: 'draft' | 'published';
}

/**
 * 347: 編集内容を下書き(draft_* 列)へだけ書く。live 列(公開版)は触らない。
 *
 * 渡されなかった項目は「いま編集中の下書きがあればそれ、なければ公開版」
 * を引き継いで全文のスナップショットにする。部分的な下書きを作らないのは、
 * 公開時に「どの版が出るか」が1行で決まるようにするため。
 */
export async function saveTemplateDraft(
  db: D1Database,
  id: string,
  updates: TemplateDraftUpdates,
): Promise<TemplateRow> {
  const current = await getTemplateById(db, id);
  if (!current) throw new Error('TEMPLATE_NOT_FOUND');
  const expectedVersion = updates.expectedVersion ?? Number(current.published_version ?? 0);
  const expectedDraftRevision = updates.expectedDraftRevision ?? Number(current.draft_revision ?? 0);
  if (expectedVersion !== Number(current.published_version ?? 0)
    || expectedDraftRevision !== Number(current.draft_revision ?? 0)) throw new Error('TEMPLATE_DRAFT_CONFLICT');
  const metadata: string[] = [];
  const metadataValues: unknown[] = [];
  for (const [column, value] of [['name', updates.name], ['category', updates.category], ['folder_id', updates.folderId]] as const) {
    if (value !== undefined) { metadata.push(`${column} = ?`); metadataValues.push(value); }
  }
  /*
   * 下書きがある行の draft 列 NULL は「削除した」。
   * 下書きがない行の NULL は「下書きなし」。`??` で一列ずつ落とすと、
   * 削除したはずの値が公開版から復活して新しい下書きへ混入する。
   * 下書きは全文スナップショットなので、行単位でどちらかを見る。
   */
  const snapshot = hasTemplateDraft(current);
  const draftMessageType = updates.messageType ?? current.draft_message_type ?? current.message_type;
  const draftMessageContent = updates.messageContent ?? current.draft_message_content ?? current.message_content;
  const draftCarouselActionsJson = updates.carouselActions !== undefined
    ? (updates.carouselActions ? JSON.stringify(updates.carouselActions) : null)
    : (snapshot ? current.draft_carousel_actions_json : current.carousel_actions_json);
  const draftCarouselTapLimitMode = updates.carouselTapLimitMode
    ?? current.draft_carousel_tap_limit_mode
    ?? current.carousel_tap_limit_mode;
  const draftCarouselTapLimitText = updates.carouselTapLimitText !== undefined
    ? updates.carouselTapLimitText
    : (snapshot ? current.draft_carousel_tap_limit_text : current.carousel_tap_limit_text);
  const draftQuestionJson = updates.questionJson !== undefined
    ? updates.questionJson
    : (snapshot ? current.draft_question_json : current.question_json);
  const draftQuestionStatus = updates.questionStatus
    ?? current.draft_question_status
    ?? current.question_status;
  const nextDraftRevision = expectedDraftRevision + 1;
  const savedAt = jstNow();
  const mutation = db.prepare(
    `UPDATE templates
        SET confirmation_revision=confirmation_revision+1, ${metadata.length ? metadata.join(', ') + ',' : ''} draft_message_type = ?,
            draft_message_content = ?,
            draft_carousel_actions_json = ?,
            draft_carousel_tap_limit_mode = ?,
            draft_carousel_tap_limit_text = ?,
            draft_question_json = ?,
            draft_question_status = ?,
            draft_message_bubbles_json = ?,
            draft_revision = draft_revision + 1,
            updated_at = ?
      WHERE id = ? AND published_version = ? AND draft_revision = ?
        AND message_content IS ?`,
  ).bind(
    ...metadataValues,
    draftMessageType,
    draftMessageContent,
    draftCarouselActionsJson,
    draftCarouselTapLimitMode,
    draftCarouselTapLimitText,
    draftQuestionJson,
    draftQuestionStatus,
    updates.messageBubblesJson === undefined ? (snapshot ? current.draft_message_bubbles_json ?? null : current.message_bubbles_json ?? null) : updates.messageBubblesJson,
    savedAt,
    id,
    expectedVersion,
    expectedDraftRevision,
    current.message_content,
  );
  const [updated] = await applyMediaUsageMutation(db, {
    lineAccountId: current.line_account_id,
    refKind: 'template',
    refId: id,
    // 公開中の本文は下書き保存では消えない。両方を数える。
    searchableContent: [current.message_content, draftMessageContent],
    mutationStatements: [mutation],
    usageGuard: {
      sql: `EXISTS (
        SELECT 1 FROM templates
         WHERE id = ? AND published_version = ? AND draft_revision = ?
           AND message_content IS ? AND draft_message_content IS ?
      )`,
      binds: [id, expectedVersion, nextDraftRevision,
        current.message_content, draftMessageContent],
    },
  });
  if ((updated?.meta?.changes ?? 0) === 0) throw new Error('TEMPLATE_DRAFT_CONFLICT');
  // Return this write's version, even if another editor saves before our reply.
  return {
    ...current,
    name: updates.name ?? current.name,
    category: updates.category ?? current.category,
    folder_id: updates.folderId === undefined ? current.folder_id : updates.folderId,
    draft_message_type: draftMessageType,
    draft_message_content: draftMessageContent,
    draft_carousel_actions_json: draftCarouselActionsJson,
    draft_carousel_tap_limit_mode: draftCarouselTapLimitMode,
    draft_carousel_tap_limit_text: draftCarouselTapLimitText,
    draft_question_json: draftQuestionJson,
    draft_question_status: draftQuestionStatus,
    draft_message_bubbles_json: updates.messageBubblesJson === undefined
      ? (snapshot ? current.draft_message_bubbles_json ?? null : current.message_bubbles_json ?? null) : updates.messageBubblesJson,
    draft_revision: nextDraftRevision,
    updated_at: savedAt,
  };
}

export interface TemplatePublishResult {
  row: TemplateRow;
  /** 下書きを公開版へ写したかどうか。 */
  published: boolean;
  /** 同じ確認キーでの再試行を、そのままの結果で返したかどうか。 */
  replayed: boolean;
}

interface TemplatePublishKeyRecord {
  published_version: number;
  draft_revision: number;
  created_at: string;
  draft_fingerprint: string | null;
  message_type: string | null;
  message_content: string | null;
}

export async function publishTemplate(
  db: D1Database,
  id: string,
  options: {
    expectedVersion?: number;
    expectedDraftRevision?: number;
    idempotencyKey?: string;
    /** 使い始めの日時。空なら公開と同時。 */
    effectiveFrom?: string;
    createdByStaffId?: string | null;
  } = {},
): Promise<TemplatePublishResult> {
  const current = await getTemplateById(db, id);
  if (!current) throw new Error('TEMPLATE_NOT_FOUND');
  if (options.idempotencyKey) {
    const prior = await db.prepare(
      `SELECT published_version, draft_revision, created_at,
              draft_fingerprint, message_type, message_content
         FROM template_publish_keys
        WHERE template_id = ? AND idempotency_key = ?`,
    ).bind(id, options.idempotencyKey).first<TemplatePublishKeyRecord>();
    if (prior) {
      // 成功済みの操作。新しい下書きがあり、その指紋が記録と違えば、
      // 別操作の使い回しとして409。下書きがなければ同じ操作の再試行。
      if (hasTemplateDraft(current)
        && (await templateDraftFingerprint(current)) !== (prior.draft_fingerprint ?? '')) {
        throw new Error('TEMPLATE_PUBLISH_KEY_CONFLICT');
      }
      // 同じ内容の再試行。記録時の版・本文をそのまま返す(固定応答)。
      // 後に別キーで版が進んでいても、記録時の結果は変えない。
      const fixed: TemplateRow = {
        ...current,
        message_type: prior.message_type ?? current.message_type,
        message_content: prior.message_content ?? current.message_content,
        published_version: Number(prior.published_version),
        published_at: prior.created_at,
        draft_message_type: null,
        draft_message_content: null,
        draft_carousel_actions_json: null,
        draft_carousel_tap_limit_mode: null,
        draft_carousel_tap_limit_text: null,
        draft_question_json: null,
        draft_question_status: null,
        draft_revision: 0,
      };
      const history = await db.prepare(`SELECT id FROM template_versions WHERE template_id=? AND version_number=?`)
        .bind(id,Number(prior.published_version)).first();
      if (!history && Number(prior.published_version) > 0) {
        // 過去の欠落版の付属設定・利用開始日・操作者は成功キーだけでは
        // 復元できない。現在の設定から推測せず、人の復旧判断へ返す。
        throw new Error('TEMPLATE_VERSION_HISTORY_MISSING');
      }
      return { row: fixed, published: false, replayed: true };
    }
  }
  if (options.expectedVersion !== undefined
    && Number(current.published_version) !== options.expectedVersion) {
    throw new Error('TEMPLATE_VERSION_CONFLICT');
  }
  if (options.expectedDraftRevision !== undefined
    && Number(current.draft_revision ?? 0) !== options.expectedDraftRevision) {
    throw new Error('TEMPLATE_DRAFT_CONFLICT');
  }
  if (!hasTemplateDraft(current)) {
    if (options.idempotencyKey) {
      const now = jstNow();
      await db.prepare(
        `INSERT OR IGNORE INTO template_publish_keys
           (template_id, idempotency_key, published_version, draft_revision, created_at,
            draft_fingerprint, message_type, message_content)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, options.idempotencyKey, Number(current.published_version ?? 0),
        Number(current.draft_revision ?? 0), now, '',
        current.message_type, current.message_content).run();
    }
    return { row: current, published: false, replayed: false };
  }
  const now = jstNow();
  const publishedDraftRevision = Number(current.draft_revision ?? 0);
  const publishedFingerprint = await templateDraftFingerprint(current);
  const nextVersion = Number(current.published_version) + 1;
  /*
   * 公開版の更新とキー記録は単一の原子操作にする。
   * 記録に載せる版・本文は、下書き(成功すれば消える)から先に決める。
   * 2文の間で落ちても版だけ進むことはない。
   */
  const publishBatch = [
    db.prepare(
      `UPDATE templates
          SET confirmation_revision=confirmation_revision+1, message_type = draft_message_type,
              message_content = draft_message_content,
              message_bubbles_json = draft_message_bubbles_json,
              draft_message_bubbles_json = NULL,
              carousel_actions_json = draft_carousel_actions_json,
              carousel_tap_limit_mode = draft_carousel_tap_limit_mode,
              carousel_tap_limit_text = draft_carousel_tap_limit_text,
              question_json = draft_question_json,
              question_status = draft_question_status,
              draft_message_type = NULL,
              draft_message_content = NULL,
              draft_carousel_actions_json = NULL,
              draft_carousel_tap_limit_mode = NULL,
              draft_carousel_tap_limit_text = NULL,
              draft_question_json = NULL,
              draft_question_status = NULL,
              draft_revision = 0,
              published_version = published_version + 1,
              published_at = ?,
              publish_idempotency_key = ?,
              updated_at = ?
        WHERE id = ? AND published_version = ? AND draft_revision = ?`,
    ).bind(
      now,
      options.idempotencyKey ?? current.publish_idempotency_key,
      now,
      id,
      current.published_version,
      current.draft_revision ?? 0,
    ),
    publishedVersionStatement(db, id, nextVersion, options, now),
  ];
  if (options.idempotencyKey) {
    /*
     * 同じ原子操作の中で、公開UPDATEと直後の版履歴INSERTが
     * それぞれ1行に当たったときだけ記録する。無条件 INSERT にすると、
     * 同時負けの側まで記録が残り、再試行の見分けが壊れる。
     */
    publishBatch.push(
      db.prepare(
        `INSERT OR IGNORE INTO template_publish_keys
           (template_id, idempotency_key, published_version, draft_revision, created_at,
            draft_fingerprint, message_type, message_content)
         SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
      ).bind(id, options.idempotencyKey, nextVersion, publishedDraftRevision, now,
        publishedFingerprint, current.draft_message_type, current.draft_message_content),
    );
  }
  const publishResults = await applyMediaUsageMutation(db, {
    lineAccountId: current.line_account_id,
    refKind: 'template',
    refId: id,
    searchableContent: [current.draft_message_content],
    mutationStatements: publishBatch,
    usageGuard: {
      sql: `EXISTS (
        SELECT 1 FROM templates
         WHERE id = ? AND published_version = ? AND draft_revision = 0
           AND updated_at = ? AND message_content IS ?
      )`,
      binds: [id, nextVersion, now, current.draft_message_content],
    },
  });
  const [updated] = publishResults;
  if ((updated?.meta?.changes ?? 0) === 0) {
    // 同時公開の負け。同じ確認キーで相手が勝っていたら再試行として返す。
    // 履歴表への記録より先に相手の UPDATE が終わっている場合があるので、
    // 行の確認キー列も見る(同じ UPDATE 文で書かれるため順序が保証される)。
    if (options.idempotencyKey) {
      const winner = await db.prepare(
        `SELECT published_version FROM template_publish_keys
          WHERE template_id = ? AND idempotency_key = ?`,
      ).bind(id, options.idempotencyKey).first<{ published_version: number }>();
      const raced = await getTemplateById(db, id);
      if (winner && raced) return { row: raced, published: false, replayed: true };
      if (raced && raced.publish_idempotency_key === options.idempotencyKey) {
        return { row: raced, published: false, replayed: true };
      }
    }
    // 版と下書き版のどちらが進んだかで落とし分ける。
    const raced = await getTemplateById(db, id);
    if (!raced) throw new Error('TEMPLATE_NOT_FOUND');
    if (Number(raced.published_version) !== Number(current.published_version)) {
      throw new Error('TEMPLATE_VERSION_CONFLICT');
    }
    if (Number(raced.draft_revision ?? 0) !== publishedDraftRevision) {
      throw new Error('TEMPLATE_DRAFT_CONFLICT');
    }
    throw new Error('TEMPLATE_VERSION_CONFLICT');
  }
  // 原子操作で版が1つ進んだことが確定している。読み直して返す。
  const next = await getTemplateById(db, id);
  if (!next || Number(next.published_version) !== nextVersion) {
    throw new Error('TEMPLATE_VERSION_CONFLICT');
  }
  return { row: next, published: true, replayed: false };
}

export interface TemplateUsage {
  autoReplies: Array<{
    id: string;
    keyword: string;
    matchType: 'exact' | 'contains';
    lineAccountId: string | null;
  }>;
  automations: Array<{
    id: string;
    name: string;
    eventType: string;
  }>;
  scenarioSteps: Array<{
    scenarioId: string;
    scenarioName: string;
    stepId: string;
    stepOrder: number;
    displayOrder: number;
  }>;
  reminderSteps: Array<{
    reminderId: string;
    reminderName: string;
    stepId: string;
  }>;
  richMenuAreas: Array<{
    groupId: string;
    groupName: string;
    pageName: string;
    areaId: string;
    label: string | null;
  }>;
  trackedLinks: Array<{
    id: string;
    name: string;
  }>;
}

/**
 * Template の参照箇所を返す。
 * 現行の templates.id を参照する運用中の設定をすべて返す。
 * messages_log.template_id_at_send は送信済み履歴なので、削除を止める参照には含めない。
 *   automations は数十件規模なので LIKE で十分高速。
 *
 * templateAccountId を渡すと、使用先もテンプレートと同じアカウント
 * （またはアカウント未設定）のものだけに絞る。別アカウントの設定は
 * 名前・遷移先ともに見せられず、そこへ直しに行けないまま削除だけが
 * 止まるので、ここで除外する。
 */
export async function getTemplateUsage(
  db: D1Database,
  templateId: string,
  templateAccountId?: string | null,
): Promise<TemplateUsage> {
  // テンプレートがアカウント所属なら、使用先は「同じアカウント or 未設定」に限る。
  // テンプレート自体が未設定（null）なら全アカウントの使用先を返す。
  const scope = (column: string) =>
    templateAccountId ? ` AND (${column} IS NULL OR ${column} = ?)` : '';
  const scopeBinds = (values: unknown[]) =>
    templateAccountId ? [...values, templateAccountId] : values;

  const arRes = await db
    .prepare(
      `SELECT id, keyword, match_type, line_account_id
       FROM auto_replies WHERE template_id = ? AND deleted_at IS NULL${scope('line_account_id')} ORDER BY created_at DESC`,
    )
    .bind(...scopeBinds([templateId]))
    .all<{ id: string; keyword: string; match_type: 'exact' | 'contains'; line_account_id: string | null }>();

  // automations の actions JSON を全件取って JS 側で template_id をマッチさせる。
  // SQL LIKE で "%\"template_id\":\"<id>\"%" を投げると D1 SQLite の
  // "pattern too complex" 上限に当たるので JS 処理にしている。
  const autRes = await db
    .prepare(`SELECT id, name, event_type, actions, line_account_id FROM automations ORDER BY created_at DESC`)
    .all<{ id: string; name: string; event_type: string; actions: string; line_account_id: string | null }>();
  const matchedAutomations: Array<{ id: string; name: string; event_type: string }> = [];
  for (const r of autRes.results ?? []) {
    if (templateAccountId && r.line_account_id !== null && r.line_account_id !== templateAccountId) {
      continue;
    }
    try {
      const actions = JSON.parse(r.actions) as Array<{
        params?: { template_id?: string; templateId?: string };
      }>;
      // 実行系は template_id / templateId の両方のキーを参照として扱う
      // （automation-action-executors と移行347と同じ判定）。
      if (actions.some((a) => (a.params?.template_id ?? a.params?.templateId) === templateId)) {
        matchedAutomations.push({ id: r.id, name: r.name, event_type: r.event_type });
      }
    } catch {
      // ignore malformed
    }
  }

  const scenarioRes = await db
    .prepare(
      `SELECT ss.id AS step_id, ss.step_order, ss.scenario_id, s.name AS scenario_name,
              (SELECT COUNT(*) FROM scenario_steps preceding WHERE preceding.scenario_id = ss.scenario_id AND preceding.step_order <= ss.step_order) AS display_order
       FROM scenario_steps ss
       JOIN scenarios s ON s.id = ss.scenario_id
       WHERE ss.template_id = ?${scope('s.line_account_id')}
       ORDER BY s.name, ss.step_order`,
    )
    .bind(...scopeBinds([templateId]))
    .all<{ step_id: string; step_order: number; display_order: number; scenario_id: string; scenario_name: string }>();

  const reminderRes = await db
    .prepare(
      `SELECT rs.id AS step_id, r.id AS reminder_id, r.name AS reminder_name
       FROM reminder_steps rs
       JOIN reminders r ON r.id = rs.reminder_id
       WHERE rs.template_id = ?${scope('r.line_account_id')}
       ORDER BY r.name, rs.offset_minutes`,
    )
    .bind(...scopeBinds([templateId]))
    .all<{ step_id: string; reminder_id: string; reminder_name: string }>();

  const richMenuRes = await db
    .prepare(
      `SELECT a.id AS area_id, a.label, p.name AS page_name,
              g.id AS group_id, g.name AS group_name
       FROM rich_menu_areas a
       JOIN rich_menu_pages p ON p.id = a.page_id
       JOIN rich_menu_groups g ON g.id = p.group_id
       WHERE a.template_id = ?${scope('g.account_id')}
       ORDER BY g.name, p.order_index, a.id`,
    )
    .bind(...scopeBinds([templateId]))
    .all<{
      area_id: string;
      label: string | null;
      page_name: string;
      group_id: string;
      group_name: string;
    }>();

  const trackedLinkRes = await db
    .prepare(`SELECT id, name FROM tracked_links WHERE template_id = ?${scope('line_account_id')} ORDER BY name`)
    .bind(...scopeBinds([templateId]))
    .all<{ id: string; name: string }>();

  return {
    autoReplies: (arRes.results ?? []).map((r) => ({
      id: r.id,
      keyword: r.keyword,
      matchType: r.match_type,
      lineAccountId: r.line_account_id,
    })),
    automations: matchedAutomations.map((r) => ({
      id: r.id,
      name: r.name,
      eventType: r.event_type,
    })),
    scenarioSteps: (scenarioRes.results ?? []).map((r) => ({
      scenarioId: r.scenario_id,
      scenarioName: r.scenario_name,
      stepId: r.step_id,
      stepOrder: r.step_order,
      displayOrder: r.display_order,
    })),
    reminderSteps: (reminderRes.results ?? []).map((r) => ({
      reminderId: r.reminder_id,
      reminderName: r.reminder_name,
      stepId: r.step_id,
    })),
    richMenuAreas: (richMenuRes.results ?? []).map((r) => ({
      groupId: r.group_id,
      groupName: r.group_name,
      pageName: r.page_name,
      areaId: r.area_id,
      label: r.label,
    })),
    trackedLinks: (trackedLinkRes.results ?? []).map((r) => ({ id: r.id, name: r.name })),
  };
}

export interface TemplateRowWithUsage extends TemplateRow {
  usage_count: number;
}

export interface TemplateListScope {
  accountIds: string[];
  includeUnassigned: boolean;
}

export interface TemplateSendCounts {
  thisMonth: number;
  total: number;
}

/**
 * テンプレートを使って実際に送った数を、一覧1回ぶんまとめて数える。
 * 見えてよいテンプレートIDだけを受け取り、別アカウントの集計を返さない。
 */
export async function getTemplateSendCounts(
  db: D1Database,
  templateIds: string[],
  nowJst = jstNow(),
): Promise<Map<string, TemplateSendCounts>> {
  if (templateIds.length === 0) return new Map();
  const month = nowJst.slice(0, 7);
  const result = await db.prepare(
    `SELECT template_id_at_send AS template_id,
            COUNT(*) AS total_count,
            SUM(CASE WHEN substr(created_at, 1, 7) = ? THEN 1 ELSE 0 END) AS month_count
      FROM messages_log
      WHERE direction = 'outgoing'
        AND COALESCE(delivery_type, '') != 'test'
        AND template_id_at_send IN (SELECT value FROM json_each(?))
      GROUP BY template_id_at_send`,
  ).bind(month, JSON.stringify(templateIds)).all<{
    template_id: string;
    total_count: number;
    month_count: number;
  }>();

  return new Map((result.results ?? []).map((row) => [
    row.template_id,
    { thisMonth: Number(row.month_count ?? 0), total: Number(row.total_count ?? 0) },
  ]));
}

/** テンプレート選択の絞り込み。ページに切る前に適用する。 */
export type TemplateListFilter = {
  /** 名前・本文の部分一致（大文字小文字は LIKE の ASCII 規則に従う）。 */
  q?: string;
  /** 'none' は未分類。配列はフォルダ自身+直下の子を渡す。空配列は0件。 */
  folderIds?: string[] | 'none';
  /** 文字テンプレートだけに絞るなど。 */
  messageType?: string;
  /** 入力欄へ入れられる文字本文だけ。質問付きの文字は含めない。 */
  textOnly?: boolean;
  /** 選択画面の分類。reservation/ec は名称・本文の文字一致、frequent は送信実績順。 */
  quick?: 'reservation' | 'ec' | 'frequent';
};

const plainTextTemplateWhere = "message_type = 'text' AND (question_json IS NULL OR TRIM(question_json) IN ('', 'null'))";

const QUICK_KEYWORDS: Record<'reservation' | 'ec', string[]> = {
  // 選択画面がこれまでクライアント側で使っていた正規表現と同じ語。
  reservation: ['予約', '来店', '前日', '日程'],
  ec: ['EC', '注文', '発送', '配送', '商品'],
};

function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function quickClause(keywords: string[]): string {
  // instr は大文字小文字を区別するので、従来の正規表現と同じ一致方になる。
  return `(${keywords.map(() => '(instr(name, ?) > 0 OR instr(message_content, ?) > 0)').join(' OR ')})`;
}

/**
 * 一覧画面用に template + 使用数を返す。
 * - auto_replies は indexed lookup (1 SQL)
 * - automations は actions JSON 全件取って JS で template_id を抽出 (LIKE が
 *   D1 SQLite の "pattern too complex" 上限に当たるので避ける)
 */
export async function getTemplatesWithUsageCount(
  db: D1Database,
  category?: string,
  scope?: TemplateListScope,
  paging?: { limit: number; offset: number },
  filter?: TemplateListFilter,
): Promise<{ items: TemplateRowWithUsage[]; total: number }> {
  // 1. templates 本体
  const filters: string[] = ['deleted_at IS NULL'];
  const values: unknown[] = [];
  if (category) {
    filters.push('category = ?');
    values.push(category);
  }
  if (filter?.messageType) {
    filters.push('message_type = ?');
    values.push(filter.messageType);
  }
  if (filter?.textOnly) filters.push(plainTextTemplateWhere);
  if (filter?.q && filter.q.trim() !== '') {
    const like = `%${likeEscape(filter.q.trim())}%`;
    filters.push(`(name LIKE ? ESCAPE '\\' OR message_content LIKE ? ESCAPE '\\')`);
    values.push(like, like);
  }
  if (filter?.folderIds === 'none') {
    filters.push('folder_id IS NULL');
  } else if (filter?.folderIds) {
    if (filter.folderIds.length === 0) {
      filters.push('1 = 0');
    } else {
      filters.push(`folder_id IN (${sqlIdSet(filter.folderIds).sql})`);
      values.push(...(filter.folderIds.length ? sqlIdSet(filter.folderIds).binds : []));
    }
  }
  if (filter?.quick === 'reservation' || filter?.quick === 'ec') {
    const keywords = QUICK_KEYWORDS[filter.quick];
    filters.push(quickClause(keywords));
    for (const word of keywords) values.push(word, word);
  }
  if (scope) {
    if (scope.accountIds.length > 0) {
      filters.push(
        `(line_account_id IN (${sqlIdSet(scope.accountIds).sql})${scope.includeUnassigned ? ' OR line_account_id IS NULL' : ''})`,
      );
      values.push(...(scope.accountIds.length ? sqlIdSet(scope.accountIds).binds : []));
    } else {
      filters.push(scope.includeUnassigned ? 'line_account_id IS NULL' : '1 = 0');
    }
  }
  const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
  const totalStmt = values.length > 0
    ? db.prepare(`SELECT COUNT(*) AS total FROM templates${where}`).bind(...values)
    : db.prepare(`SELECT COUNT(*) AS total FROM templates${where}`);
  const totalRow = await totalStmt.first<{ total: number }>();

  // 2. 列で参照している設定を1回の問い合わせでまとめて取る。
  // 使用先のアカウントも一緒に返し、テンプレートと同じアカウント
  // （または未設定）の使用先だけを数える。詳細の getTemplateUsage と
  // 同じ粒度・同じ境界にしないと「一覧の数」と「詳細の件数」がずれる。
  // D1 の compound SELECT 上限(5項)を超えないよう2本に分けて問い合わせる。
  const relationalResA = await db.prepare(
    `SELECT template_id, acct FROM (
       SELECT template_id, line_account_id AS acct FROM auto_replies WHERE template_id IS NOT NULL AND deleted_at IS NULL
       UNION ALL
       SELECT ss.template_id, s.line_account_id AS acct
         FROM scenario_steps ss JOIN scenarios s ON s.id = ss.scenario_id
        WHERE ss.template_id IS NOT NULL
       UNION ALL
       SELECT rs.template_id, r.line_account_id AS acct
         FROM reminder_steps rs JOIN reminders r ON r.id = rs.reminder_id
        WHERE rs.template_id IS NOT NULL
     ) references_by_kind`,
  ).all<{ template_id: string; acct: string | null }>();
  const relationalResB = await db.prepare(
    `SELECT template_id, acct FROM (
       -- R347: 旧公開版に固定された送信待ち・取消ずみ（再開できる）の登録も
       -- 1登録1件で数える。版を切り替えても使用先が0件に見えないようにする。
       -- 手順単位ではなく登録単位にまとめる（使用先の件数とずらさない）。
       SELECT rvs.template_id, r.line_account_id AS acct
         FROM friend_reminders fr
         JOIN reminders r ON r.id = fr.reminder_id
         JOIN reminder_version_steps rvs ON rvs.reminder_version_id = fr.reminder_version_id
        WHERE rvs.template_id IS NOT NULL AND fr.status IN ('active', 'cancelled')
        GROUP BY rvs.template_id, fr.id
       UNION ALL
       SELECT a.template_id, g.account_id AS acct
         FROM rich_menu_areas a
         JOIN rich_menu_pages p ON p.id = a.page_id
         JOIN rich_menu_groups g ON g.id = p.group_id
        WHERE a.template_id IS NOT NULL
       UNION ALL
       SELECT template_id, line_account_id AS acct FROM tracked_links WHERE template_id IS NOT NULL
     ) references_by_kind`,
  ).all<{ template_id: string; acct: string | null }>();
  const relationalRows = [...(relationalResA.results ?? []), ...(relationalResB.results ?? [])];

  // 使用先1件を (template_id, 使用先のアカウント) の行として集める。
  const usageRefs = new Map<string, Array<string | null>>();
  const addRef = (templateId: string, acct: string | null) => {
    const list = usageRefs.get(templateId);
    if (list) list.push(acct);
    else usageRefs.set(templateId, [acct]);
  };
  for (const r of relationalRows) addRef(r.template_id, r.acct);

  // 3. automations の actions JSON を取って template_id を抽出。
  // 詳細側は「そのテンプレートを使うオートメーション」を1件として
  // 数えるので、一覧側も同じテンプレートを複数アクションで使う
  // オートメーションは1件として数える。
  const autRes = await db
    .prepare(`SELECT actions, line_account_id FROM automations`)
    .all<{ actions: string; line_account_id: string | null }>();
  for (const r of autRes.results ?? []) {
    try {
      const actions = JSON.parse(r.actions) as Array<{
        params?: { template_id?: string; templateId?: string };
      }>;
      const referenced = new Set(
        actions
          .map((a) => a.params?.template_id ?? a.params?.templateId)
          .filter((v): v is string => Boolean(v)),
      );
      for (const tid of referenced) addRef(tid, r.line_account_id);
    } catch {
      // ignore malformed JSON rows
    }
  }

  // テンプレートがアカウント所属なら、使用先は同じアカウント or
  // 未設定のものだけ。別アカウントの設定は名前も遷移先も見せられず、
  // 数だけ残ると削除が永久に止まる。
  const countVisible = (template: { id: string; line_account_id: string | null }): number => {
    const refs = usageRefs.get(template.id) ?? [];
    const account = template.line_account_id;
    if (!account) return refs.length;
    return refs.filter((acct) => acct === null || acct === account).length;
  };

  let templates: TemplateRow[];
  if (filter?.quick === 'frequent') {
    /*
      「よく使う」: 送信実績順は行を切る前に決める必要がある。
      絞り込んだ全件の id だけを取り、スコア順に切ってからその区画の
      行だけ SELECT * で読む。画面側の従来順（月間→累計→使用箇所数の
      多い順）と同じスコアにする。
    */
    const idRows = await (
      values.length > 0
        ? db.prepare(`SELECT id, line_account_id, created_at FROM templates${where}`).bind(...values)
        : db.prepare(`SELECT id, line_account_id, created_at FROM templates${where}`)
    ).all<{ id: string; line_account_id: string | null; created_at: string }>();
    const ids = idRows.results ?? [];
    const sends = await getTemplateSendCounts(db, ids.map((row) => row.id));
    const scored = ids
      .map((row) => ({
        row,
        score: sends.get(row.id)?.thisMonth ?? sends.get(row.id)?.total ?? countVisible(row),
      }))
      .sort((a, b) =>
        b.score - a.score
        || (a.row.created_at < b.row.created_at ? 1 : a.row.created_at > b.row.created_at ? -1 : 0)
        || (a.row.id < b.row.id ? -1 : 1));
    const slice = paging
      ? scored.slice(paging.offset, paging.offset + paging.limit)
      : scored;
    const pageIds = slice.map((entry) => entry.row.id);
    if (pageIds.length === 0) {
      templates = [];
    } else {
      const rows = await db.prepare(
        `SELECT * FROM templates WHERE id IN (SELECT value FROM json_each(?))`,
      ).bind(JSON.stringify(pageIds)).all<TemplateRow>();
      const order = new Map(pageIds.map((id, index) => [id, index]));
      templates = (rows.results ?? [])
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    }
  } else {
    const pageSql = `SELECT * FROM templates${where} ORDER BY created_at DESC, id ASC`
      + (paging ? ' LIMIT ? OFFSET ?' : '');
    const pageValues = paging ? [...values, paging.limit, paging.offset] : values;
    const tplStmt = pageValues.length > 0 ? db.prepare(pageSql).bind(...pageValues) : db.prepare(pageSql);
    templates = (await tplStmt.all<TemplateRow>()).results ?? [];
  }

  return {
    items: templates.map((t) => ({
      ...t,
      usage_count: countVisible(t),
    })),
    total: Number(totalRow?.total ?? 0),
  };
}

/** タブの種類で数えるための行。一覧と同じく削除済みを除き、種類の判定に使う列だけ読む。 */
export interface TemplateSectionRow {
  folder_id: string | null;
  message_type: string;
  message_content: string;
  draft_message_content: string | null;
  question_json: string | null;
}

export async function getTemplateSectionRows(db: D1Database, scope: TemplateListScope): Promise<TemplateSectionRow[]> {
  const accountSql = scope.accountIds.length > 0
    ? `(line_account_id IN (${sqlIdSet(scope.accountIds).sql})${scope.includeUnassigned ? ' OR line_account_id IS NULL' : ''})`
    : scope.includeUnassigned ? 'line_account_id IS NULL' : '1 = 0';
  const binds = scope.accountIds.length > 0 ? sqlIdSet(scope.accountIds).binds : [];
  const statement = db.prepare(`SELECT folder_id, message_type, message_content, draft_message_content, question_json
    FROM templates WHERE deleted_at IS NULL AND ${accountSql}`);
  const rows = await (binds.length > 0 ? statement.bind(...binds) : statement).all<TemplateSectionRow>();
  return rows.results ?? [];
}

/**
 * フォルダごとの件数。選択画面のフォルダ欄は件数を出すが、
 * 一覧を全件読まなくても分かるように、スコープ内で GROUP BY だけする。
 */
export async function getTemplateFolderCounts(
  db: D1Database,
  scope?: TemplateListScope,
  messageType?: string,
  textOnly = false,
): Promise<Map<string, number>> {
  const filters: string[] = ['deleted_at IS NULL'];
  const values: unknown[] = [];
  if (messageType) {
    filters.push('message_type = ?');
    values.push(messageType);
  }
  if (textOnly) filters.push(plainTextTemplateWhere);
  if (scope) {
    if (scope.accountIds.length > 0) {
      filters.push(
        `(line_account_id IN (${sqlIdSet(scope.accountIds).sql})${scope.includeUnassigned ? ' OR line_account_id IS NULL' : ''})`,
      );
      values.push(...(scope.accountIds.length ? sqlIdSet(scope.accountIds).binds : []));
    } else {
      filters.push(scope.includeUnassigned ? 'line_account_id IS NULL' : '1 = 0');
    }
  }
  const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
  const rows = await (
    values.length > 0
      ? db.prepare(`SELECT COALESCE(folder_id, '') AS folder_id, COUNT(*) AS c FROM templates${where} GROUP BY COALESCE(folder_id, '')`).bind(...values)
      : db.prepare(`SELECT COALESCE(folder_id, '') AS folder_id, COUNT(*) AS c FROM templates${where} GROUP BY COALESCE(folder_id, '')`)
  ).all<{ folder_id: string; c: number }>();
  return new Map((rows.results ?? []).map((row) => [row.folder_id, Number(row.c)]));
}
