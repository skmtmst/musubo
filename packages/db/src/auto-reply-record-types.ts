
// =============================================================================
// Auto-Replies — Keyword-triggered automatic responses (L社 自動応答 equivalent)
// =============================================================================

export interface AutoReply {
  /** 公開版から読み込む実行設定。旧行は既定値で動く。 */
  normalize_keywords?: boolean;
  receive_sources?: Array<'line' | 'email'>;
  reply_delay_seconds?: number | null;
  unmatched_action?: string | null;

  confirmation_revision?: number;
  id: string;
  keyword: string;
  match_type: 'exact' | 'contains';
  response_type: string;
  response_content: string;
  template_id: string | null;
  line_account_id: string | null;
  is_active: number;
  /** 返す時間帯（JST の HH:MM）。NULL なら時間帯を問わない */
  active_from: string | null;
  active_until: string | null;
  /** 同じ相手へ自動応答を返してから、この分数は返さない。NULL なら抑制しない */
  cooldown_minutes: number | null;
  /** 担当者が対応中のトークでは返さない（1）か、返す（0）か */
  skip_when_operator_active: number;
  /** 評価順。小さいほど先に見る。同じ値なら created_at 順 */
  priority: number;
  /** 対象にするメッセージ種別のJSON配列。NULL なら全部 */
  message_kinds_json: string | null;
  /** 友だちの条件（saved_searches と同じ形）。NULL なら絞らない */
  friend_conditions_json: string | null;
  /** 所属フォルダ */
  folder_id: string | null;
  display_order: number;
  /** 151: 応答したときに順に実行することの並び（シナリオのアクションと同じ形）。 */
  actions_json: string | null;
  /** 151: 応答する曜日（0=日 … 6=土）。時間帯は active_from / active_until。 */
  response_weekdays_json: string | null;
  /** 151: 'ignore' | 'include' | 'exclude' */
  response_holiday_rule: string | null;
  /** 151: 1人につき1回だけ応答する。cooldown_minutes（N分空ける）とは別。 */
  once_per_friend: number;
  /** 151: キーワードを複数行持つ。NULL なら keyword / match_type を見る。 */
  keywords_json: string | null;
  /** 157: キーワードを問わず、届いたメッセージすべてに応答する。 */
  respond_to_all: number;
  /** 158: 管理用の名前。空なら keyword を代わりに出す。 */
  name: string | null;
  /** 158: キーワードが複数あるとき 'any'（どれか1つ）か 'all'（すべて）か。 */
  keyword_match_mode: string;
  /** 273: 'draft'（未公開）| 'published' | 'stopped' */
  lifecycle_status: string;
  /** 機能08 点検: 最後に停止した日時。止めたことが無ければ NULL。 */
  stopped_at: string | null;
  /** 機能08 点検: 最後に停止した担当者。 */
  stopped_by_staff_id: string | null;
  /** 機能08 点検: 停止の理由。任意なので NULL があり得る。 */
  stop_reason: string | null;
  /** 機能08 点検: 停止操作の冪等キー。同じキーの再送は新しい停止として残さない。 */
  stop_idempotency_key: string | null;
  /** 機能08 点検: 削除は履歴を残す方式。NULL なら有効な定義。 */
  deleted_at: string | null;
  /** 機能08 点検: 削除した担当者。 */
  deleted_by_staff_id: string | null;
  created_at: string;
}


export interface CreateAutoReplyInput {
  keyword: string;
  matchType?: 'exact' | 'contains';
  responseType?: string;
  responseContent: string;
  templateId?: string | null;
  lineAccountId?: string | null;
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
   * 運用者だけが読むメモ。auto_replies には列が無く、版スナップショットへ
   * 保存する。友だちへ送る本文には使わない（AUTOREPLY-09）。
   */
  internalMemo?: string | null;
  /**
   * 新規作成時の有効/停止。**省略や false は止まったまま作る。**
   * 「オフで作ったのに動いていた」は誤送信になるので、有効化は
   * 明示的な true（または公開・再開の操作）だけに限る。
   */
  isActive?: boolean;
}
