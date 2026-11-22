import { jstCalendar as japanCalendar } from '@line-crm/shared';
import {markInsightFailed} from '../broadcast-insight-retry.js';
export {markInsightFailed} from '../broadcast-insight-retry.js';
import { sqlIdSet } from '../id-queries.js';
import { refreshBroadcastReferences, removeConsumerReferences } from '../template-versions.js';
import { jstNow } from '../utils.js';
// 'segment' は 029 の CHECK では前から許されていたが、型だけ落ちていた。
// 絞り込み条件（segment_conditions）で宛先を決める配信で使う。
export type BroadcastTargetType = 'all' | 'tag' | 'segment' | 'multi-account-dedup';
export type BroadcastStatus = 'draft' | 'scheduled' | 'sending' | 'sent';
/*
 * 一斉配信で送れる種別。
 *
 * シナリオ（`MessageType`）と同じ並びにそろえてある。別々にしていたときは
 * 一斉配信だけ text / image / flex の3つで、それ以外を選ぶと
 * 「テキストに JSON を入れたもの」に落ちて、**中身の JSON がそのまま
 * 相手のトークに届いた**。増やすときは 142〜145 と同じ手順で表を作り直す。
 */
export type BroadcastMessageType =
  | 'text'
  | 'image'
  | 'flex'
  | 'location'
  | 'video'
  | 'audio'
  | 'sticker'
  | 'carousel'
  | 'imagemap'
  | 'rich_message'
  | 'coupon';

export interface Broadcast {
  hq_run_id?: string | null;
  id: string;
  title: string;
  message_type: BroadcastMessageType;
  message_content: string;
  message_bubbles_json?: string | null;
  target_type: BroadcastTargetType;
  target_tag_id: string | null;
  status: BroadcastStatus;
  scheduled_at: string | null;
  sent_at: string | null;
  total_count: number;
  success_count: number;
  created_at: string;
  account_ids: string | null;
  dedup_priority: string | null;
  failed_account_ids: string | null;
  dedup_progress: string | null;
  batch_lock_at: string | null;
  track_links: number;
  /** 何分かけて配るか。0なら一気に送る。 */
  stealth_spread_minutes?: number;
  /** 初回実行時に固定した、account別の共通情報値・版。 */
  common_var_snapshot?: string | null;
  /** Worker再試行でも変えない共通情報の判定時刻。 */
  common_var_snapshot_at?: string | null;
  /** SegmentConditionのJSON。segment配信だけが持つ。 */
  segment_conditions?: string | null;
  folder_id?: string | null;
  /** 開封数を取るか。1 = 取る（既定）。 */
  measure_opens?: number;
  line_account_id?: string | null;
  alt_text?: string | null;
  internal_memo?: string | null;
  draft_step?: 'basic' | 'audience' | 'message' | 'schedule' | 'confirm' | null;
  draft_payload_json?: string | null;
  message_options_json?: string | null;
  after_action_version_id?: string | null;
  lock_version?: number;
  /** 停止を受け付けた時刻（JST）。NULL なら止まっていない。 */
  stopped_at?: string | null;
  /** 停止を押した担当者。監査で「誰が止めたか」を読むために残す。 */
  stopped_by?: string | null;
  /** 送信の試行番号。失敗分の再送で1つ進む。provider へ渡す再送キーの一部。 */
  send_attempt_no?: number;
  /**
   * 二者承認の今の状態（m12a）。
   * none（承認がいらない・まだ頼んでいない）/ pending / approved /
   * rejected / cancelled / expired（予約時刻を過ぎた）。
   * 送信の段階（status）とは別の軸。未マイグレーション環境では undefined。
   */
  approval_status?: string | null;
  /** 承認を頼んだ担当者（送る人）。 */
  approval_requested_by_staff_id?: string | null;
  /** 承認を頼んだ日時（JST）。 */
  approval_requested_at?: string | null;
  /** 承認を頼まれた担当者（承認する人）。 */
  approval_approver_staff_id?: string | null;
  /** 承認を頼むときのひとこと（任意）。 */
  approval_note?: string | null;
  /** 承認・差し戻しを決めた担当者。 */
  approval_decided_by_staff_id?: string | null;
  /** 承認・差し戻しを決めた日時（JST）。 */
  approval_decided_at?: string | null;
  /** 差し戻しの理由（差し戻すとき必須）。 */
  approval_reject_reason?: string | null;
  /** 1人運用のとき、送る人が確認で入れた人数。 */
  approval_confirmed_count?: number | null;
}

function broadcastListQuery(
  accountId?: string,
  scope?: { allowedAccountIds: string[]; canSeeUnassigned: boolean },
  // 一覧の並び順。一覧画面の「並び順」選択と連動する。既定は新しい順。
  opts?: { order?: 'asc' | 'desc'; from?: string; until?: string },
): { sql: string; params: unknown[] } {
  // 一覧に集計の最新行を同梱する。送信済みごとに insight 口を叩く N+1 を
  // 一覧1クエリで吸収するため。LINEへの再取得は手動ボタン(fetch-insight)に寄せる。
  let sql = `SELECT b.*,
       (SELECT purpose FROM broadcast_execution_contexts x WHERE x.broadcast_id=b.id) AS purpose,
       (SELECT execution_mode FROM broadcast_execution_contexts x WHERE x.broadcast_id=b.id) AS execution_mode,
       (SELECT created_via FROM broadcast_execution_contexts x WHERE x.broadcast_id=b.id) AS created_via,
       bi.id as insight_id,
       bi.status as insight_status,
       bi.delivered as insight_delivered,
       bi.unique_impression as insight_unique_impression,
       bi.unique_click as insight_unique_click,
       bi.open_rate, bi.click_rate
FROM broadcasts b
LEFT JOIN broadcast_insights bi ON b.id = bi.broadcast_id
  AND bi.id = (SELECT id FROM broadcast_insights WHERE broadcast_id = b.id ORDER BY created_at DESC LIMIT 1)`;
  const params: unknown[] = [];
  if (accountId) {
    // Include:
    //   1. per-account broadcasts whose line_account_id matches (existing behavior)
    //   2. multi-account-dedup broadcasts whose account_ids JSON array contains
    //      the selected account (account_ids is null for legacy/non-dedup paths
    //      so the EXISTS short-circuits safely).
    sql += ` WHERE (
      b.line_account_id = ?
      OR (
        b.target_type = 'multi-account-dedup'
        AND b.account_ids IS NOT NULL
        AND EXISTS (SELECT 1 FROM json_each(b.account_ids) WHERE value = ?)
      )
    )`;
    params.push(accountId, accountId);
  } else if (scope) {
    const conditions: string[] = [];
    if (scope.allowedAccountIds.length > 0) {
      const idSet = sqlIdSet(scope.allowedAccountIds);
      const placeholders = idSet.sql;
      conditions.push(`(
        b.line_account_id IN (${placeholders})
        OR (
          b.target_type = 'multi-account-dedup'
          AND b.account_ids IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM json_each(b.account_ids)
             WHERE value IN (${placeholders})
          )
        )
      )`);
      params.push(...idSet.binds, ...idSet.binds);
    }
    if (scope.canSeeUnassigned) {
      conditions.push('(b.line_account_id IS NULL AND b.account_ids IS NULL)');
    }
    sql += ` WHERE ${conditions.length > 0 ? conditions.join(' OR ') : '0 = 1'}`;
  }
  sql = `SELECT * FROM (${sql}) b WHERE b.data_purged_at IS NULL`;
  if (opts?.from || opts?.until) {
    // 範囲のOR条件を括り、期間が別アカウントへ漏れないようにする。
    sql = `SELECT * FROM (${sql}) b WHERE 1 = 1`;
    if (opts.from) { sql += ' AND julianday(COALESCE(b.sent_at, b.scheduled_at, b.created_at)) >= julianday(?)'; params.push(opts.from); }
    if (opts.until) { sql += ' AND julianday(COALESCE(b.sent_at, b.scheduled_at, b.created_at)) < julianday(?)'; params.push(opts.until); }
  }
  sql += ` ORDER BY COALESCE(b.sent_at, b.scheduled_at, b.created_at) ${opts?.order === 'asc' ? 'ASC' : 'DESC'}`;
  return { sql, params };
}

export async function getBroadcasts(db: D1Database, accountId?: string,
  scope?: { allowedAccountIds: string[]; canSeeUnassigned: boolean },
  opts?: { order?: 'asc' | 'desc'; from?: string; until?: string; status?: string; dueAt?: string },
): Promise<Broadcast[]> {
  const query = broadcastListQuery(accountId, scope, opts);
  // 定期送信は終わった配信の本文まで読み込まない。
  if(opts?.status || opts?.dueAt) {
    query.sql = `SELECT * FROM (${query.sql}) b WHERE 1=1`;
    if(opts.status){query.sql+=' AND b.status=?';query.params.push(opts.status);}
    if(opts.dueAt){query.sql+=' AND b.scheduled_at IS NOT NULL AND julianday(b.scheduled_at)<=julianday(?)';query.params.push(opts.dueAt);}
  }
  return (await db.prepare(query.sql).bind(...query.params).all<Broadcast>()).results;
}

/** 集計はSQLで返し、本文・台帳は表示ページの分だけ読み込む。 */
export async function getBroadcastListPage(db:D1Database, accountId:string|undefined,
  scope:{allowedAccountIds:string[];canSeeUnassigned:boolean},
  opts:{order:'asc'|'desc';from?:string;until?:string;folderId?:string;status?:string;displayStatuses?:string[];limit:number;offset:number;now?:string},
):Promise<{items:Broadcast[];total:number;drafts:number;statusCounts:Record<string,number>}> {
  const base=broadcastListQuery(accountId,scope,opts);
  base.sql=base.sql.replace(/ ORDER BY COALESCE\(b.sent_at, b.scheduled_at, b.created_at\) (ASC|DESC)$/, '');
  const draftRow=await db.prepare(`SELECT COUNT(*) n FROM (${base.sql}) WHERE status='draft'`).bind(...base.params).first<{n:number}>();
  const folder=opts.folderId ? (opts.folderId==='unfiled' ? " WHERE (folder_id IS NULL OR folder_id='')" : ' WHERE folder_id=?') : '';
  const folderBinds=opts.folderId && opts.folderId!=='unfiled' ? [opts.folderId]:[];
  // deriveBroadcastDisplayStatus と同じ優先順位。件数・絞り込みのための存在確認はDB内だけで行う。
  const classified=`SELECT b.*, CASE
    WHEN execution_mode='simulation' AND status='sent' THEN 'sent'
    WHEN approval_status='pending' THEN CASE WHEN scheduled_at IS NOT NULL AND julianday(scheduled_at)<=julianday(?) THEN 'expired' ELSE 'pending_approval' END
    WHEN approval_status='expired' THEN 'expired'
    WHEN stopped_at IS NOT NULL AND stopped_at<>'' THEN 'stopped'
    WHEN status='scheduled' THEN 'scheduled'
    WHEN status='sending' THEN CASE WHEN EXISTS(SELECT 1 FROM broadcast_send_claims c WHERE c.broadcast_id=b.id AND c.state IN('sent','failed','unknown','claimed')) THEN 'sending' ELSE 'preparing' END
    WHEN status='sent' THEN CASE
      WHEN EXISTS(SELECT 1 FROM broadcast_send_claims c WHERE c.broadcast_id=b.id AND c.state='failed') THEN CASE WHEN EXISTS(SELECT 1 FROM broadcast_send_claims c WHERE c.broadcast_id=b.id AND c.state='sent') THEN 'partial_failed' ELSE 'failed' END
      WHEN NOT EXISTS(SELECT 1 FROM broadcast_send_claims c WHERE c.broadcast_id=b.id AND c.state='sent') AND EXISTS(SELECT 1 FROM broadcast_send_claims c WHERE c.broadcast_id=b.id AND c.state='unknown') THEN 'failed'
      ELSE 'sent' END
    ELSE 'draft' END AS display_status FROM (${base.sql}) b${folder}`;
  const binds=[opts.now??new Date().toISOString(),...base.params,...folderBinds];
  const counts=await db.prepare(`SELECT display_status,COUNT(*) n FROM (${classified}) GROUP BY display_status`).bind(...binds).all<{display_status:string;n:number}>();
  const statusCounts:Record<string,number>={all:0};
  for(const row of counts.results){statusCounts[row.display_status]=row.n;statusCounts.all+=row.n;}
  const conditions:string[]=[];const filterBinds:string[]=[];
  if(opts.status){conditions.push('status=?');filterBinds.push(opts.status);}
  if(opts.displayStatuses){conditions.push('display_status IN (SELECT value FROM json_each(?))');filterBinds.push(JSON.stringify(opts.displayStatuses));}
  const filtered=`SELECT * FROM (${classified})${conditions.length?' WHERE '+conditions.join(' AND '):''}`;
  const total=await db.prepare(`SELECT COUNT(*) n FROM (${filtered})`).bind(...binds,...filterBinds).first<{n:number}>();
  const items=await db.prepare(`${filtered} ORDER BY julianday(COALESCE(sent_at,scheduled_at,created_at)) ${opts.order==='asc'?'ASC':'DESC'},id ${opts.order==='asc'?'ASC':'DESC'} LIMIT ? OFFSET ?`).bind(...binds,...filterBinds,opts.limit,opts.offset).all<Broadcast>();
  return {items:items.results,total:total?.n??0,drafts:draftRow?.n??0,statusCounts};
}

export async function getBroadcastById(
  db: D1Database,
  id: string,
): Promise<Broadcast | null> {
  return db
    .prepare(
      `SELECT b.*,
       (SELECT purpose FROM broadcast_execution_contexts x WHERE x.broadcast_id=b.id) AS purpose,
       (SELECT execution_mode FROM broadcast_execution_contexts x WHERE x.broadcast_id=b.id) AS execution_mode,
       (SELECT created_via FROM broadcast_execution_contexts x WHERE x.broadcast_id=b.id) AS created_via,
       bi.id as insight_id, bi.delivered, bi.unique_impression,
       bi.unique_click, bi.unique_media_played,
       bi.open_rate, bi.click_rate, bi.status as insight_status,
       bi.retry_count, bi.fetched_at as insight_fetched_at,
       bi.created_at as insight_created_at
FROM broadcasts b
LEFT JOIN broadcast_insights bi ON b.id = bi.broadcast_id
WHERE b.id = ? AND b.data_purged_at IS NULL`,
    )
    .bind(id)
    .first<Broadcast>();
}

export interface CreateBroadcastInput {
  id?: string;
  title: string;
  messageType: BroadcastMessageType;
  messageContent: string;
  messageBubblesJson?: string | null;
  targetType: BroadcastTargetType;
  targetTagId?: string | null;
  scheduledAt?: string | null;
  accountIds?: string[];
  dedupPriority?: string[];
  trackLinks?: boolean;
  lineAccountId?: string | null;
  altText?: string | null;
  /** 何分かけて配るか。0（既定）は一気に送る */
  stealthSpreadMinutes?: number;
  /**
   * 絞り込み条件（JSON文字列）。targetType が 'segment' のときだけ使う。
   *
   * 下書きの時点で入れておく。送るときに渡す作りだと、下書きを開き直して
   * 送った人と、作った人の条件が別物になりうる。
   */
  segmentConditions?: string | null;
  /** 分類。null なら「未分類」。 */
  folderId?: string | null;
  /**
   * 開封数を取るか。既定は取る。
   *
   * LINE の集計ユニットはアカウントあたり月1,000までなので、全部の配信で
   * 取ると上限に当たる。少人数への配信では 20人未満だとどのみち返って
   * こないので、そこで切れるようにしてある。
   */
  measureOpens?: boolean;
  internalMemo?: string | null;
  draftStep?: 'basic' | 'audience' | 'message' | 'schedule' | 'confirm' | null;
  draftPayloadJson?: string | null;
  messageOptionsJson?: string | null;
  afterActionVersionId?: string | null;
  /** 予定日時が入力済みでも、途中保存なら実行待ちにしない。 */
  saveAsDraft?: boolean;
}

export async function createBroadcast(
  db: D1Database,
  input: CreateBroadcastInput,
): Promise<Broadcast> {
  const id = input.id ?? crypto.randomUUID();
  const now = jstNow();

  const initialStatus: BroadcastStatus = input.saveAsDraft
    ? 'draft'
    : input.scheduledAt ? 'scheduled' : 'draft';

  await db
    .prepare(
      `INSERT INTO broadcasts
         (id, title, message_type, message_content, message_bubbles_json, target_type, target_tag_id, status, scheduled_at, sent_at, total_count, success_count, account_ids, dedup_priority, track_links, line_account_id, alt_text, stealth_spread_minutes, segment_conditions, folder_id, measure_opens, internal_memo, draft_step, draft_payload_json, message_options_json, after_action_version_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.title,
      input.messageType,
      input.messageContent,
      input.messageBubblesJson ?? null,
      input.targetType,
      input.targetTagId ?? null,
      initialStatus,
      input.scheduledAt ?? null,
      input.accountIds ? JSON.stringify(input.accountIds) : null,
      input.dedupPriority ? JSON.stringify(input.dedupPriority) : null,
      input.trackLinks === false ? 0 : 1,
      input.lineAccountId ?? null,
      input.altText ?? null,
      // 何分かけて配るか。0（既定）は一気に送る。
      input.stealthSpreadMinutes ?? 0,
      input.segmentConditions ?? null,
      input.folderId ?? null,
      input.measureOpens === false ? 0 : 1,
      input.internalMemo ?? null,
      input.draftStep ?? null,
      input.draftPayloadJson ?? null,
      input.messageOptionsJson ?? null,
      input.afterActionVersionId ?? null,
      now,
    )
    .run();

  // 467: 保存で参照表を書き換える。吹き出しの templateId を読む。
  await refreshBroadcastReferences(db, id, input.messageBubblesJson ?? null);
  return (await getBroadcastById(db, id))!;
}

export type UpdateBroadcastInput = Partial<
  Pick<
    Broadcast,
    | 'title'
    | 'message_type'
    | 'message_content'
    | 'message_bubbles_json'
    | 'target_type'
    | 'target_tag_id'
    | 'segment_conditions'
    | 'stealth_spread_minutes'
    | 'folder_id'
    | 'measure_opens'
    | 'status'
    | 'scheduled_at'
    | 'track_links'
    | 'internal_memo'
    | 'draft_step'
    | 'draft_payload_json'
    | 'message_options_json'
    | 'after_action_version_id'
  >
> & {
  /** 運用者がsnapshotの意味を変える編集・再予約をしたときだけtrue。 */
  resetCommonVarSnapshot?: boolean;
  /** 本文・宛先と同じCAS更新で古い承認を無効にする。 */
  resetApproval?: boolean;
  /** 新しい予約で本人が確認した人数。古い人数を引き継がない。 */
  approvalConfirmedCount?: number;
  resetDeliveryAttempt?: boolean;
};

// 版を必須にし、版なし迂回を残さない。呼び元は PUT 経路だけ。
export async function updateBroadcast(
  db: D1Database,
  id: string,
  updates: UpdateBroadcastInput,
  expectedVersion: number,
): Promise<Broadcast | null> {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.message_type !== undefined) {
    fields.push('message_type = ?');
    values.push(updates.message_type);
  }
  if (updates.message_content !== undefined) {
    fields.push('message_content = ?');
    values.push(updates.message_content);
  }
  if (updates.message_bubbles_json !== undefined) {
    fields.push('message_bubbles_json = ?');
    values.push(updates.message_bubbles_json);
  }
  if (updates.target_type !== undefined) {
    fields.push('target_type = ?');
    values.push(updates.target_type);
  }
  if (updates.target_tag_id !== undefined) {
    fields.push('target_tag_id = ?');
    values.push(updates.target_tag_id);
  }
  if (updates.segment_conditions !== undefined) {
    fields.push('segment_conditions = ?');
    values.push(updates.segment_conditions);
  }
  if (updates.stealth_spread_minutes !== undefined) {
    fields.push('stealth_spread_minutes = ?');
    values.push(updates.stealth_spread_minutes);
  }
  if (updates.folder_id !== undefined) {
    fields.push('folder_id = ?');
    values.push(updates.folder_id);
  }
  if (updates.measure_opens !== undefined) {
    fields.push('measure_opens = ?');
    values.push(updates.measure_opens);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.scheduled_at !== undefined) {
    fields.push('scheduled_at = ?');
    values.push(updates.scheduled_at);
  }
  if (updates.track_links !== undefined) {
    fields.push('track_links = ?');
    values.push(updates.track_links ? 1 : 0);
  }
  if (updates.internal_memo !== undefined) {
    fields.push('internal_memo = ?');
    values.push(updates.internal_memo);
  }
  if (updates.draft_step !== undefined) {
    fields.push('draft_step = ?');
    values.push(updates.draft_step);
  }
  if (updates.draft_payload_json !== undefined) {
    fields.push('draft_payload_json = ?');
    values.push(updates.draft_payload_json);
  }
  if (updates.message_options_json !== undefined) {
    fields.push('message_options_json = ?');
    values.push(updates.message_options_json);
  }
  if (updates.after_action_version_id !== undefined) {
    fields.push('after_action_version_id = ?');
    values.push(updates.after_action_version_id);
  }

  if (fields.length > 0) {
    if (updates.resetApproval) {
      fields.push("approval_status = CASE WHEN approval_status IN ('pending','approved') THEN 'none' ELSE approval_status END",
        'approval_decided_by_staff_id = NULL', 'approval_decided_at = NULL',
        'approval_reject_reason = NULL');
      if (updates.approvalConfirmedCount === undefined) fields.push('approval_confirmed_count = NULL');
    }
    if (updates.approvalConfirmedCount !== undefined) {
      fields.push('approval_confirmed_count = ?');
      values.push(updates.approvalConfirmedCount);
    }
    if (updates.resetDeliveryAttempt) {
      fields.push('dedup_progress = NULL', 'batch_lock_at = NULL', 'success_count = 0',
        'failed_account_ids = NULL', 'sent_at = NULL', 'aggregation_unit = NULL', 'line_request_id = NULL');
    }
    if (updates.resetCommonVarSnapshot) {
      // 新しい試行だけ判定時刻・値を同じCAS更新内で捨てる。provider失敗後に
      // 日時だけ入れ直す同一試行はfalseとして、固定済みsnapshotを維持する。
      fields.push('common_var_snapshot = NULL', 'common_var_snapshot_at = NULL');
    }
    fields.push('lock_version = lock_version + 1');
    const statement = db.prepare(`UPDATE broadcasts SET ${fields.join(', ')} WHERE id = ? AND lock_version = ? AND status IN ('draft','scheduled') AND data_purged_at IS NULL`)
      .bind(...values, id, expectedVersion);
    const result = updates.resetDeliveryAttempt
      ? (await db.batch([statement, db.prepare('DELETE FROM broadcast_insights WHERE broadcast_id = ? AND changes() > 0').bind(id)]))[0]
      : await statement.run();
    if (!result.meta.changes) return null;
  } else {
    const current = await getBroadcastById(db, id);
    if (!current || Number(current.lock_version ?? 1) !== expectedVersion) return null;
  }

  const saved = await getBroadcastById(db, id);
  // 467: 吹き出しが変わった保存だけ参照を数え直す。触っていない保存では残す。
  if (saved && updates.message_bubbles_json !== undefined) {
    await refreshBroadcastReferences(db, id, updates.message_bubbles_json);
  }
  return saved;
}

export async function deleteBroadcast(db: D1Database, id: string): Promise<boolean> {
  // D026: 下書き・予約だけ消す。送信中・送信済みは消さない。
  // 状態の確認と削除を1文にまとめる。確認のあとで送信が始まる窓を
  // 作らないため（cancel の UPDATE 側再確認と同じ考え方）。
  // 送信中の行を消すと broadcast_send_claims の請求行まで
  // ON DELETE CASCADE で一緒に消え、届き続けるのに記録だけ失う。
  const result = await db
    .prepare(`DELETE FROM broadcasts WHERE id = ? AND status IN ('draft', 'scheduled') AND data_purged_at IS NULL`)
    .bind(id)
    .run();
  // D1 includes cascaded execution/insight rows in this count. The primary-key
  // predicate still limits the deletion to this one draft or scheduled parent.
  if ((result.meta.changes ?? 0) < 1) return false;
  // 467: 消えた配信の参照を消す。
  await removeConsumerReferences(db, 'broadcast', id);
  return true;
}

export async function createBroadcastInsight(
  db: D1Database,
  broadcastId: string,
): Promise<void> {
  // Idempotent: dedup broadcast の resume 時など、この関数が同じ broadcastId に
  // 対して複数回呼ばれうる。broadcast_insights.broadcast_id に UNIQUE 制約がない
  // ため `INSERT` 単体だと重複行が生まれ、getBroadcastById の LEFT JOIN や
  // /insight ルートが古い pending 行を拾って表示が壊れる。
  // 既存行があれば skip する SELECT-then-INSERT パターンに変更。
  const existing = await db
    .prepare(`SELECT id FROM broadcast_insights WHERE broadcast_id = ? LIMIT 1`)
    .bind(broadcastId)
    .first<{ id: string }>();
  if (existing) return;

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO broadcast_insights (id, broadcast_id, status) VALUES (?, ?, 'pending')`,
    )
    .bind(id, broadcastId)
    .run();
}

export async function updateBroadcastLineRequestId(
  db: D1Database,
  broadcastId: string,
  lineRequestId: string | null,
  aggregationUnit: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE broadcasts SET line_request_id = ?, aggregation_unit = ? WHERE id = ?`,
    )
    .bind(lineRequestId, aggregationUnit, broadcastId)
    .run();
}

export async function getPendingInsights(
  db: D1Database,
): Promise<
  Array<{
    insightId: string;
    broadcastId: string;
    lineRequestId: string | null;
    aggregationUnit: string | null;
    sentAt: string;
    retryCount: number;
    lineAccountId: string | null;
    targetType: string | null;
    accountIds: string[] | null;
    failedAccountIds: string[] | null;
    successCount: number | null;
  }>
> {
  const result = await db
    .prepare(
      `SELECT bi.id as insight_id, bi.broadcast_id, bi.retry_count,
              b.line_request_id, b.aggregation_unit, b.sent_at, b.line_account_id,
              b.target_type, b.account_ids, b.failed_account_ids, b.success_count
       FROM broadcast_insights bi
       JOIN broadcasts b ON bi.broadcast_id = b.id
       WHERE bi.status = 'pending'
         AND b.sent_at IS NOT NULL
         AND julianday('now', '+9 hours') - julianday(b.sent_at) >= 3`,
    )
    .all();
  const parseArr = (v: unknown): string[] | null => {
    if (!v) return null;
    if (Array.isArray(v)) return v as string[];
    if (typeof v !== 'string') return null;
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? (p as string[]) : null;
    } catch {
      return null;
    }
  };
  return (result.results || []).map((r: Record<string, unknown>) => ({
    insightId: r.insight_id as string,
    broadcastId: r.broadcast_id as string,
    lineRequestId: r.line_request_id as string | null,
    aggregationUnit: r.aggregation_unit as string | null,
    sentAt: r.sent_at as string,
    retryCount: r.retry_count as number,
    lineAccountId: r.line_account_id as string | null,
    targetType: (r.target_type as string | null) ?? null,
    accountIds: parseArr(r.account_ids),
    failedAccountIds: parseArr(r.failed_account_ids),
    successCount: (r.success_count as number | null) ?? null,
  }));
}

export async function updateInsightResult(
  db: D1Database,
  insightId: string,
  result: {
    delivered: number | null;
    uniqueImpression: number | null;
    uniqueClick: number | null;
    uniqueMediaPlayed: number | null;
    rawResponse: string;
  },
): Promise<void> {
  const openRate =
    result.delivered && result.uniqueImpression
      ? result.uniqueImpression / result.delivered
      : null;
  const clickRate =
    result.delivered && result.uniqueClick
      ? result.uniqueClick / result.delivered
      : null;
  const now = japanCalendar().toISOString();
  await db
    .prepare(
      `UPDATE broadcast_insights
       SET delivered = ?, unique_impression = ?, unique_click = ?,
           unique_media_played = ?, open_rate = ?, click_rate = ?,
           raw_response = ?, status = 'ready', fetched_at = ?
       WHERE id = ?`,
    )
    .bind(
      result.delivered,
      result.uniqueImpression,
      result.uniqueClick,
      result.uniqueMediaPlayed,
      openRate,
      clickRate,
      result.rawResponse,
      now,
      insightId,
    )
    .run();
}


export async function getQueuedBroadcasts(db: D1Database): Promise<Broadcast[]> {
  // Pick up broadcasts explicitly queued for batch processing:
  //   - segment_conditions IS NOT NULL: tag/segment queued batches
  //   - account_ids IS NOT NULL: multi-account-dedup queued batches
  // batch_offset >= 0: ロック中（-1）のものは除外
  // sent_at IS NULL: 完了済みは除外
  const result = await db
    .prepare(
      // stopped_at IS NOT NULL は停止を受け付けた配信。**新しい送信権を取らせない**
      // ので、ここで拾わない。止めたあと再開すると stopped_at が NULL に
      // 戻り、次の tick から続きを送る。
      `SELECT * FROM broadcasts WHERE status = 'sending' AND batch_offset >= 0 AND sent_at IS NULL AND stopped_at IS NULL AND (segment_conditions IS NOT NULL OR account_ids IS NOT NULL) ORDER BY created_at ASC`,
    )
    .all<Broadcast>();
  return result.results;
}

/**
 * ロック解除: batch_offset=-1 のまま停滞したブロードキャストを復旧する。
 *
 * 2 系統 (idempotency 保護の有無で revoke 閾値を変える):
 * 1) 未着手 (success_count=0): segment / multi-account-dedup どちらでも、batch_offset=0 に
 *    戻して次の cron で再投入する。まだ送信実績が無く重複防止情報も無いため、最初の
 *    multicast / 最初の per-batch write が in-flight の間に revoke すると最初の 500 人を
 *    二重送信し得る。「Worker が確実に死んでいる」と言える長め (30分) の閾値を使う。
 * 2) multi-account-dedup の途中停滞 (success_count > 0 かつ dedup_progress あり):
 *    dedup_progress が sentIdentKeys を保持するので再投入しても既送は skip され二重送信
 *    しない (idempotent)。dedup は分割送信 (chunking) で 1 chunk あたり高々 ~15s しか
 *    -1 ロックを保持しないので、3分以上 -1 のまま = その chunk を実行していた Worker は
 *    既に死んでいる、と安全に判定できる。よって短い (3分) 閾値で素早く crash recovery
 *    してよい。success_count > 0 だが dedup_progress=NULL の row (resume 機能 deploy 前の
 *    停滞 / 030 migration 直後の在庫) は ID 集合が無く安全に再開できないため両系統とも
 *    対象外にし、手動対応 (D1 で sent に書き換え等) に委ねる。
 *
 * 3 系統とも `stopped_at IS NULL` で絞る。停止中の配信はロックを持ったまま
 * Worker が消えていても**戻さない**。戻すと次の cron が拾って送信を続け、
 * 運用者が押した停止が黙って無効になる。停止中のロックは再開
 * (resumeBroadcastSending) が外す。
 */
export async function recoverStalledBroadcasts(db: D1Database): Promise<void> {
  // 進捗ゼロ (success_count=0) の lock 用。idempotency 保護が無いので長め。0.021日 ≈ 30分。
  const STALL_LOCK_REVOKE_DAYS_NO_PROGRESS = 0.021;
  // dedup_progress あり (success_count>0) の再開可能 lock 用。chunking で 1 実行が短いため
  // 安全に短くできる。0.0021日 ≈ 3.0分。cron 間隔(5分)より短いので次の tick で resume。
  const STALL_LOCK_REVOKE_DAYS_RESUMABLE = 0.0021;
  // 1) 未着手 (segment / dedup どちらも対象)
  //    閾値は batch_lock_at (= ロック取得時刻) のみ。created_at にフォールバック
  //    すると jstNow の `+09:00` suffix で 9 時間ズレるバグが出るので使わない。
  //    マイグレーション 031 で在庫 row には batch_lock_at が backfill 済み。
  await db
    .prepare(
      `UPDATE broadcasts SET batch_offset = 0, batch_lock_at = NULL, ${ADVANCE_DELIVERY_CONFIRMATION_SQL.replace('json_valid(message_options_json)', "target_type <> 'multi-account-dedup' AND json_valid(message_options_json)")}, lock_version = CASE WHEN target_type <> 'multi-account-dedup' THEN lock_version + 1 ELSE lock_version END
       WHERE status = 'sending' AND batch_offset = -1
       AND sent_at IS NULL AND stopped_at IS NULL AND success_count = 0
       AND (segment_conditions IS NOT NULL OR account_ids IS NOT NULL)
       AND batch_lock_at IS NOT NULL
       AND julianday('now', '+9 hours') - julianday(batch_lock_at) > ${STALL_LOCK_REVOKE_DAYS_NO_PROGRESS}`,
    )
    .run();

  // 2) dedup の途中停滞 (success_count > 0 かつ dedup_progress あり) — idempotent に
  //    再開できる row だけを短い閾値で素早く resume する。success_count=0 の row は
  //    系統 1) が長い閾値で扱う。success_count > 0 だが dedup_progress=NULL のケース
  //    (resume 機能 deploy 前の停滞 / 030 migration 直後の在庫) は ID 集合が無く安全な
  //    再開ができず、resume すると全件再送 → 重複配信になるため両系統とも対象外。
  //
  //    閾値は batch_lock_at (= ロック取得時刻) のみ。created_at にフォールバック
  //    すると jstNow の `+09:00` suffix で 9 時間ズレるバグが出るので使わない。
  //    マイグレーション 031 で在庫 row には batch_lock_at が backfill 済み。
  await db
    .prepare(
      `UPDATE broadcasts SET batch_offset = 0, batch_lock_at = NULL
       WHERE status = 'sending' AND batch_offset = -1
       AND sent_at IS NULL AND stopped_at IS NULL
       AND target_type = 'multi-account-dedup'
       AND success_count > 0 AND dedup_progress IS NOT NULL
       AND batch_lock_at IS NOT NULL
       AND julianday('now', '+9 hours') - julianday(batch_lock_at) > ${STALL_LOCK_REVOKE_DAYS_RESUMABLE}`,
    )
    .run();

  // 3) Personalized standard broadcasts are also safely resumable. They use
  // one stable LINE retry key per broadcast+friend+rendered content and check
  // messages_log before each push. Restarting from offset 0 is intentional:
  // logged recipients are skipped, while a push accepted just before a crash
  // is acknowledged by LINE as retry-key 409 and then logged once.
  await db
    .prepare(
      `UPDATE broadcasts SET batch_offset = 0, batch_lock_at = NULL, ${ADVANCE_DELIVERY_CONFIRMATION_SQL}, lock_version = lock_version + 1
       WHERE status = 'sending' AND batch_offset = -1
       AND sent_at IS NULL AND stopped_at IS NULL
       AND target_type != 'multi-account-dedup'
       AND segment_conditions IS NOT NULL
       AND instr(replace(message_content, ' ', ''), '{{name}}') > 0
       AND batch_lock_at IS NOT NULL
       AND julianday('now', '+9 hours') - julianday(batch_lock_at) > ${STALL_LOCK_REVOKE_DAYS_RESUMABLE}`,
    )
    .run();
}

export async function updateBroadcastBatchProgress(
  db: D1Database,
  id: string,
  batchOffset: number,
  additionalSuccess: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE broadcasts SET batch_offset = ?, success_count = success_count + ? WHERE id = ?`,
    )
    .bind(batchOffset, additionalSuccess, id)
    .run();
}

export interface BroadcastStatusCounts {
  totalCount?: number;
  successCount?: number;
}

export async function updateBroadcastStatus(
  db: D1Database,
  id: string,
  status: BroadcastStatus,
  counts?: BroadcastStatusCounts,
): Promise<void> {
  const fields: string[] = ['status = ?'];
  const values: unknown[] = [status];

  if (status === 'sent') {
    fields.push('sent_at = ?');
    values.push(jstNow());
    // 再送も開始時の宛先と既送IDを使う。完了後も snapshot を捨てない。
    // recoverStalledBroadcasts は status='sending' だけを見るため、完了を
    // progress の有無で表す必要はない。
    // batch_lock_at もクリア (sent 後は recover の対象外なので影響はないが綺麗に).
    fields.push('batch_lock_at = NULL');
  }
  // 注: status='draft' では dedup_progress / batch_lock_at をクリアしない。
  // 失敗 rollback (processBroadcastSend の catch) で draft に戻すケースで partial
  // state を捨てると、次回 retry が全件再送 → 重複配信になる。resume を成立
  // させるには partial state を保持する必要がある。
  // 「ユーザーが draft を編集して送り直す」場合の clean reset は別途 PUT API 側で
  // 明示的に対応する設計にする (現状未実装。必要になったら追加)。
  if (counts?.totalCount !== undefined) {
    fields.push('total_count = ?');
    values.push(counts.totalCount);
  }
  if (counts?.successCount !== undefined) {
    fields.push('success_count = ?');
    values.push(counts.successCount);
  }

  values.push(id);
  await db
    .prepare(`UPDATE broadcasts SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();
}

export async function updateBroadcastFailedAccountIds(
  db: D1Database,
  broadcastId: string,
  failedAccountIds: string[],
): Promise<void> {
  await db.prepare(`UPDATE broadcasts SET failed_account_ids = ? WHERE id = ?`)
    .bind(JSON.stringify(failedAccountIds), broadcastId)
    .run();
}

/*
 * 送信中の一斉配信を止める／再開する／失敗した相手だけ送り直す。
 *
 * どれも**版（lock_version）付きの条件付き UPDATE 1本**で決める。
 * 読んでから書くと、2人が同時に押したときに両方が「自分が勝った」と読む。
 * 変わった行数（changes）を見て、1 だった者だけが先へ進む。
 *
 * 停止は status を動かさない。status の意味（下書き→予約→送信中→送信済み）は
 * そのままにして、「新しい送信権をもう取らない」という別の軸を stopped_at で
 * 持つ。status を増やすと 30 列の表を作り直すことになり、既存の
 * `status = 'sending'` の判定すべての意味が変わる。代わりに、送信中の行を
 * **拾う口すべて**に `stopped_at IS NULL` を足してある
 * （getQueuedBroadcasts / recoverStalledBroadcasts / バッチ取得の CAS）。
 */

// 停止・再開・失敗分の再送は定義を変えない。正しい版の人数の確認印だけを
// 同じCASの中で次の版へ引き継ぎ、人数と固定した宛先は変えない。
const ADVANCE_DELIVERY_CONFIRMATION_SQL = `message_options_json = CASE WHEN json_valid(message_options_json)
  THEN CASE WHEN json_extract(message_options_json, '$.deliveryLimitConfirmation.version') = lock_version
    AND json_extract(message_options_json, '$.deliveryLimitConfirmation.broadcastId') = id
    THEN json_set(message_options_json, '$.deliveryLimitConfirmation.version', lock_version + 1)
    ELSE message_options_json END ELSE message_options_json END`;

export interface BroadcastStopInput {
  id: string;
  expectedVersion: number;
  actorId?: string | null;
  at?: string;
}

/** 停止を受け付ける。送信中で、まだ止まっていなくて、版が一致したときだけ 1 を返す。 */
export async function requestBroadcastStop(
  db: D1Database,
  input: BroadcastStopInput,
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE broadcasts
          SET stopped_at = ?, stopped_by = ?, ${ADVANCE_DELIVERY_CONFIRMATION_SQL}, lock_version = lock_version + 1
        WHERE id = ? AND status = 'sending' AND stopped_at IS NULL AND lock_version = ?`,
    )
    .bind(input.at ?? jstNow(), input.actorId ?? null, input.id, input.expectedVersion)
    .run();
  return result.meta.changes ?? 0;
}

/**
 * 再開する。止まっているときだけ。
 *
 * `batch_offset` が -1（ロック中）のまま止まった場合は 0 に戻す。台帳が
 * 送達済み・送達不明を覚えているので、先頭から歩き直しても二重に送らない。
 */
export async function resumeBroadcastSending(
  db: D1Database,
  input: { id: string; expectedVersion: number; segmentConditions?: string | null },
): Promise<number> {
  const fields = [
    'stopped_at = NULL',
    'stopped_by = NULL',
    'batch_lock_at = NULL',
    'batch_offset = CASE WHEN batch_offset < 0 THEN 0 ELSE batch_offset END',
    ADVANCE_DELIVERY_CONFIRMATION_SQL,
    'lock_version = lock_version + 1',
  ];
  const values: unknown[] = [];
  if (input.segmentConditions) {
    fields.push('segment_conditions = ?');
    values.push(input.segmentConditions);
  }
  values.push(input.id, input.expectedVersion);
  const result = await db
    .prepare(
      `UPDATE broadcasts SET ${fields.join(', ')}
        WHERE id = ? AND status = 'sending' AND stopped_at IS NOT NULL AND lock_version = ?`,
    )
    .bind(...values)
    .run();
  return result.meta.changes ?? 0;
}

export interface BroadcastRetryAttemptInput {
  id: string;
  expectedVersion: number;
  /**
   * キューに載せるための絞り込み条件。tag 配信をキュー経路へ移すときだけ渡す。
   * 500人以下の tag 配信はその場で送り切る作りで、キューを通らないため、
   * 再送では条件の印を書いてキュー側へ寄せる。
   */
  segmentConditions?: string | null;
}

/**
 * 失敗した相手だけの再送を始める。試行番号を1つ進めて、キューへ戻す。
 *
 * 止まっている配信と、送り終わった配信のどちらからでも始められる。
 * **誰に送るかはここでは決めない。**台帳側（reopenFailedClaims）が
 * failed の行だけを開け直し、送信側が sent / unknown を飛ばす。
 */
export async function beginBroadcastRetryAttempt(
  db: D1Database,
  input: BroadcastRetryAttemptInput,
): Promise<{ changes: number; attemptNo: number | null }> {
  const fields = [
    'send_attempt_no = send_attempt_no + 1',
    "status = 'sending'",
    'sent_at = NULL',
    'stopped_at = NULL',
    'stopped_by = NULL',
    'batch_offset = 0',
    'batch_lock_at = NULL',
    ADVANCE_DELIVERY_CONFIRMATION_SQL,
    'lock_version = lock_version + 1',
  ];
  const values: unknown[] = [];
  if (input.segmentConditions) {
    fields.push('segment_conditions = ?');
    values.push(input.segmentConditions);
  }
  values.push(input.id, input.expectedVersion);
  const result = await db
    .prepare(
      `UPDATE broadcasts SET ${fields.join(', ')}
        WHERE id = ? AND lock_version = ?
          AND (status = 'sent' OR (status = 'sending' AND stopped_at IS NOT NULL))`,
    )
    .bind(...values)
    .run();
  if ((result.meta.changes ?? 0) !== 1) return { changes: 0, attemptNo: null };
  const row = await db
    .prepare(`SELECT send_attempt_no FROM broadcasts WHERE id = ?`)
    .bind(input.id)
    .first<{ send_attempt_no: number }>();
  return { changes: 1, attemptNo: Number(row?.send_attempt_no ?? 1) };
}

/** 停止の印を読む。送信の途中で「もう止まっているか」を確かめるのに使う。 */
export async function isBroadcastStopped(db: D1Database, id: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT stopped_at FROM broadcasts WHERE id = ?`)
    .bind(id)
    .first<{ stopped_at: string | null }>();
  return !!row?.stopped_at;
}
