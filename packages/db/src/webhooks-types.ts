import type { WebhookInteractionFailureReason } from './webhook-failure-types.js';


export interface IncomingWebhookRow {
  confirmation_revision?: number;
  folder_id?: string | null;
  id: string;
  name: string;
  source_type: string;
  /** 旧平文。暗号化後の新規・更新では NULL になる。読み取りの後方互換だけに使う。 */
  secret: string | null;
  /** AES-GCM 暗号文。こちらが正本。旧スキーマの行には無いことがある。 */
  secret_encrypted?: string | null;
  /**
   * 入れ替え前の合言葉の暗号文。入れ替えから24時間だけ
   * 署名の照合に使える。期限は secret_rotated_at から数える。
   */
  secret_previous_encrypted?: string | null;
  /** 合言葉を最後に入れ替えた時刻。入れ替えたことが無い行は NULL。 */
  secret_rotated_at?: string | null;
  is_active: number;
  line_account_id: string | null;
  version: number;
  identity_match_json: string;
  action_refs_json: string;
  latest_masked_sample_json: string | null;
  latest_received_at: string | null;
  /** 履歴保持の削除印。NULL 以外の行は読み取り・実行から外す。 */
  deleted_at?: string | null;
  deleted_by_staff_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface OutgoingWebhookDeliverySummaryRow {
  webhook_id: string;
  total: number;
  succeeded: number;
  failed: number;
  pending: number;
  last_status: WebhookInteractionStatus | null;
  last_response_status: number | null;
  last_completed_at: string | null;
  last_failure_reason: WebhookInteractionFailureReason | null;
  can_retry: number;
}

export interface OutgoingWebhookRow {
  confirmation_revision?: number;
  version?: number;
  updated_by_staff_id?: string | null;
  folder_id?: string | null;
  id: string;
  name: string;
  url: string;
  event_types: string; // JSON配列
  /** 旧平文。暗号化後の新規・更新では NULL になる。読み取りの後方互換だけに使う。 */
  secret: string | null;
  /** AES-GCM 暗号文。こちらが正本。旧スキーマの行には無いことがある。 */
  secret_encrypted?: string | null;
  is_active: number;
  /** 失敗したとき何回まで送り直すか。0 なら送り直さない */
  max_retries: number;
  /** 連続して失敗している回数。成功すると 0 に戻る */
  consecutive_failures: number;
  /** 最後に失敗した時刻。成功すると NULL に戻る */
  last_failed_at: string | null;
  /**
   * 連続失敗で自動停止した時刻。手動停止(NULL)と区別する。
   * 運用者が再有効化すると NULL に戻る。
   */
  auto_stopped_at?: string | null;
  line_account_id?: string | null;
  /** 履歴保持の削除印。NULL 以外の行は読み取り・実行から外す。 */
  deleted_at?: string | null;
  deleted_by_staff_id?: string | null;
  created_at: string;
  updated_at: string;
}

export type WebhookInteractionDirection = 'outgoing' | 'incoming';
export type WebhookInteractionStatus = 'pending' | 'succeeded' | 'failed' | 'retried';

export interface WebhookInteractionRow {
  confirmation_revision?: number;
  id: string;
  line_account_id: string;
  direction: WebhookInteractionDirection;
  webhook_id: string | null;
  webhook_name: string;
  event_type: string;
  trigger_summary: string;
  status: WebhookInteractionStatus;
  request_body_json: string | null;
  response_status: number | null;
  attempt_count: number;
  duration_ms: number | null;
  failure_reason: WebhookInteractionFailureReason | null;
  idempotency_key: string;
  retry_of_id: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
}

export interface WebhookInteractionSummary {
  total: number;
  outgoing: number;
  incoming: number;
  succeeded: number;
  failed: number;
  /**
   * 送信の失敗の総数。失敗の内訳を画面へ説明するとき、
   * 受信の失敗と混ぜないために使う。
   */
  outgoingFailed: number;
  /**
   * 送信の失敗のうち、今この画面からまとめて送り直せる件数。
   * 届いたか分からない記録・署名の合言葉が読めない記録・送り先が
   * 消えた/止まった記録・自動の送り直しが動いている記録は含まない。
   */
  retryable: number;
  /**
   * 失敗のうち「相手先へ届いたか分からない」件数。
   * この件数は無条件のまとめて再送へ入れず、相手先で確かめてから
   * 1件ずつやり直す対象として画面へ示す。
   */
  resultUnknown: number;
  averageDurationMs: number | null;
}

/** 自動配送台帳(outgoing_webhook_deliveries)の状態。 */
export type OutgoingDeliveryStatus = 'pending' | 'sending' | 'retry_wait' | 'delivered' | 'failed';

/**
 * 一覧用の行。やり取りの記録に、送り先と自動配送の
 * 現状を添えたもの。個別取得(getWebhookInteractionById)では付かない。
 */
export interface WebhookInteractionListRow extends WebhookInteractionRow {
  linked_webhook_revision?: number | null;
  /**
   * 送り先の有効印。削除印のある・存在しない送り先では NULL。
   * webhook_id 自体が NULL の記録（連携先が消えたもの）でも NULL。
   */
  linked_webhook_active: number | null;
  /** 同じ通知の自動配送の現状。台帳に無い記録では NULL。 */
  delivery_status: OutgoingDeliveryStatus | null;
  /** 自動配送の次回予定。予定が無いとき NULL。 */
  delivery_next_retry_at: string | null;
}

/**
 * Webhook secret の暗号化の約束。
 *
 * 保存形式: secret_encrypted 列に `k<鍵ID>.v1.<iv>.<暗号文>` を入れる。
 * 鍵ID は鍵素材の SHA-256 先頭12桁で、鍵そのものは含まない。
 * secret 列の旧平文は後方互換の読み取りだけに使い、新規・更新では NULL にする。
 * 平文で返すのは作成直後の1回だけ(API層)。GET・ログ・エラーには出さない。
 * 送信・照合の直前だけ復号する。鍵不足・復号失敗は例外にして止める。
 * 平文列の廃止は、暗号化の行き渡り確認後に別の票で行う。
 *
 * 鍵ローテーション手順(新旧併用):
 * 1. 新鍵を現行にし、旧鍵を LINE_CREDENTIAL_PREVIOUS_KEYS に残す(両方で読める期間)。
 * 2. backfillWebhookSecrets で全行を新鍵に寄せ直す(dry-run→batch→照合)。
 * 3. getWebhookSecretKeyStats で旧鍵IDの参照が 0 件になったら旧鍵を捨てる。
 */
export type WebhookSecretColumns = {
  id?: string;
  secret: string | null;
  secret_encrypted?: string | null;
  /** S: 入れ替え前の合言葉の暗号文。併用期間の照合だけに使う。 */
  secret_previous_encrypted?: string | null;
  /** S: 合言葉を最後に入れ替えた時刻。入れ替えたことが無い行は NULL。 */
  secret_rotated_at?: string | null;
};

/** 呼び出し側が渡す鍵。文字列1件は現行鍵だけの指定とみなす。 */
export interface WebhookKeyInput {
  current?: string | undefined;
  previous?: string | string[] | undefined;
}

export interface WebhookKeySet {
  current: { id: string; material: string };
  previous: { id: string; material: string }[];
}

export type WebhookSecretTable = 'incoming_webhooks' | 'outgoing_webhooks';

export interface WebhookSecretBackfillOptions {
  lineAccountId?: string;
  tables?: WebhookSecretTable[];
  batchSize?: number;
  dryRun?: boolean;
  keys?: WebhookKeyInput | string;
}

export interface WebhookSecretBackfillReport {
  dryRun: boolean;
  batchSize: number;
  legacyTotal: number;
  rekeyTotal: number;
  processed: number;
  migrated: number;
  failed: Array<{
    table: WebhookSecretTable;
    id: string;
    reason: 'unreadable' | 'encrypt_failed' | 'verify_failed' | 'write_failed';
  }>;
  remainingLegacy: number;
  remainingRekey: number;
  done: boolean;
}

export interface WebhookSecretKeyStats {
  legacy: number;
  encrypted: number;
  unknownFormat: number;
  byKeyId: Record<string, number>;
}

export type IncomingWebhookIdentityMatch = {
  methods: Array<{
    kind: 'harness_friend_id' | 'external_customer_id' | 'verified_email' | 'verified_phone';
    path: string;
  }>;
  onNotFound: 'do_nothing' | 'unmatched_box' | 'create_candidate';
};

export type IncomingWebhookActionRef = {
  refKind: string;
  refId: string;
  refVersionId: string | null;
};

// --- 人が見つからなかった届物 ---
//
// 受信Webhookの「未照合時の扱い」で unmatched_box / create_candidate を
// 選んだとき、見つからなかった届物をここへ置く。どちらも「あとで人が
// 確かめる箱」の1行で、kind だけが違う。
//   unmatched_box      … 未照合として確認する
//   create_candidate   … 友だち候補として残す（自動で友だちは作らない。
//                        相手の名乗りをそのまま友だちにすると成り済ませるため）
// 同じ受信の再送は (webhook_id, source_event_id) の UNIQUE で増やさない。

//   ambiguous        … 同じ値の友だちが2人以上いて自動では決められない
//                      人が候補から選ぶまで保留する。
export type IncomingWebhookUnmatchedKind = 'unmatched' | 'candidate' | 'ambiguous';
export type IncomingWebhookUnmatchedStatus = 'pending' | 'resolved' | 'dismissed';

export interface IncomingWebhookUnmatchedEventRow {
  id: string;
  webhook_id: string;
  line_account_id: string;
  source_event_id: string;
  kind: IncomingWebhookUnmatchedKind;
  status: IncomingWebhookUnmatchedStatus;
  /** 照合に使おうとした {kind, path, value} の並び。値は運用者が照合するためのもの。 */
  identity_attempts_json: string;
  /** 届いた本文の形だけの見本。値は •••• に伏せる。 */
  masked_shape_json: string | null;
  /** S: kind='ambiguous' の届物が持つ、一致した友だちIDの並び。 */
  candidate_friend_ids_json?: string | null;
  resolved_friend_id: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  received_at: string;
  created_at: string;
  updated_at: string;
}
