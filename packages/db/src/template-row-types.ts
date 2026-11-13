// テンプレート管理クエリヘルパー

export interface TemplateRow {
  id: string;
  confirmation_revision: number;
  name: string;
  category: string;
  message_type: string;
  message_content: string;
  message_bubbles_json?: string | null;
  draft_message_bubbles_json?: string | null;
  /** テンプレートの置き場（099 で追加）。未分類は null。 */
  folder_id: string | null;
  /** 162: カルーセルの選択肢を押したときの動き。{ パネル番号: { 選択肢番号: [...] } } */
  carousel_actions_json: string | null;
  /** 162: 選択肢の押せる回数。'none'（制限なし）／'once'（全体で1回） */
  carousel_tap_limit_mode: string;
  /** 162: 制限を超えたときに返すテキスト。空なら何も返さない。 */
  carousel_tap_limit_text: string | null;
  /** 質問テンプレート。scenario_steps.question_json と同じ形。 */
  question_json: string | null;
  question_status: 'draft' | 'published';
  created_at: string;
  updated_at: string;
  line_account_id: string | null;
  /**
   * 347: 公開版の版番号。公開操作でだけ +1 する。
   * 送信側が読む live 列(message_type / message_content / carousel_* /
   * question_*)は公開版そのものなので、版番号と live 列は常に一致する。
   */
  published_version: number;
  /** 347: 最後に公開した日時。既存行は移行時に updated_at を入れる。 */
  published_at: string | null;
  deleted_at?: string | null;
  /**
   * 347: 編集中の下書き。PUT はここへだけ書く。
   * どれか1つでも入っていれば「公開待ちの下書きあり」。
   */
  draft_message_type: string | null;
  draft_message_content: string | null;
  draft_carousel_actions_json: string | null;
  draft_carousel_tap_limit_mode: string | null;
  draft_carousel_tap_limit_text: string | null;
  draft_question_json: string | null;
  draft_question_status: 'draft' | 'published' | null;
  /**
   * 下書きの版。保存のたびに +1 し、公開で 0 に戻す。
   * 公開口はこの番号も確認し、検査後に書き換わった下書きを出さない。
   */
  draft_revision: number;
  /** 347: 公開の再試行を見分ける確認キー。auto_reply_versions と同じ使い方。 */
  publish_idempotency_key: string | null;
}
