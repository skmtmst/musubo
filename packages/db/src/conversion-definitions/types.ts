


export type ConversionDefinitionStatus = 'active' | 'stopped' | 'draft';
/**
 * 画面で区別する成果地点の状態。status 列そのものではなく、
 * 設定の壊れ(入力不良)や外部受信の停止(起点停止)も含めて導出する。
 *
 * - draft          : 作成だけして公開していない。計測には乗らない。
 * - stopped        : 運用者が止めた。
 * - invalid        : 計測中扱いだが設定が足りず、実際には数えられない。
 * - sourceStopped  : 地点は計測中だが、外部からの受信(起点)を止めている。
 * - active         : 上のどれにも当たらない、実際に計測できる状態。
 */
export type ConversionDefinitionState = 'active' | 'draft' | 'stopped' | 'invalid' | 'sourceStopped';
/** `state` クエリで追加で受ける、状態と直交する絞り込み。 */
export type ConversionDefinitionFilter = ConversionDefinitionState | 'unused';
export type ConversionDefinitionSort = 'count_desc' | 'value_desc' | 'updated_desc' | 'name_asc';
export type ConversionDeduplicationMode = 'every' | 'once_per_friend' | 'window';
export type ConversionValueMode = 'source' | 'fixed' | 'none';
export type ConversionReversalPolicy = 'source_cancelled' | 'manual' | 'none';
export type ConversionDefinitionUsageKind =
  | 'affiliate_offer'
  | 'analytics'
  | 'auto_reply'
  | 'scenario'
  | 'nen_campaign'
  | 'mileage_rule'
  | 'automation'
  | 'ad_platform';

export type ConversionDefinitionScope = {
  allowedAccountIds: readonly string[];
  includeUnassigned: boolean;
};

export type ConversionDefinitionRange = {
  from: string;
  to: string;
  timeZone: 'Asia/Tokyo';
};

export type ConversionDefinitionListInput = {
  scope: ConversionDefinitionScope;
  lineAccountId?: string;
  query?: string;
  status?: ConversionDefinitionStatus;
  /** 導出した状態での絞り込み。status よりこちらが正確。 */
  state?: ConversionDefinitionFilter;
  sourceType?: string;
  range: ConversionDefinitionRange;
  cursor: number;
  limit: number;
  sort: ConversionDefinitionSort;
};

export type ConversionDefinitionUsage = {
  id: string;
  conversionPointId: string;
  definitionVersion: number;
  lineAccountId: string;
  refKind: ConversionDefinitionUsageKind;
  refId: string;
  refVersionId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** 表示用の利用先名。参照先が未解決の場合はIDを返す。 */
  usageName: string;
};

export type ConversionDefinitionListItem = {
  folderId: string | null;
  id: string;
  name: string;
  sourceType: string;
  value: number | null;
  measureMethod: string;
  targetUrl: string | null;
  countRepeat: boolean;
  attributionDays: number | null;
  sourceConfig: Record<string, unknown>;
  deduplicationMode: ConversionDeduplicationMode;
  deduplicationWindowDays: number | null;
  valueMode: ConversionValueMode;
  reversalPolicy: ConversionReversalPolicy;
  lineAccountId: string | null;
  status: ConversionDefinitionStatus;
  /** 画面表示用の導出状態。 */
  state: ConversionDefinitionState;
  /** 入力不良・起点停止のとき、直すべき中身を運用者の言葉で返す。 */
  stateReason: string | null;
  /** 外部受信の設定状況。秘密値そのものは絶対に返さない。 */
  ingest: { configured: boolean; disabledAt: string | null };
  version: number;
  usageCount: number;
  usageNames: string[];
  metrics: {
    recordedCount: number;
    netCount: number;
    reversedCount: number | null;
    /** 取消分の金額の合計(追記台帳+アフィリエイト調整)。 */
    reversedValue: number | null;
    netValue: number;
    reversalState: 'available' | 'unavailable';
    reversalReason: string;
    cancellationCount: number | null;
    cancellationValue: number | null;
  };
  stoppedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DefinitionRow = {
  folder_id: string | null;
  id: string;
  name: string;
  event_type: string;
  value: number | null;
  measure_method: string;
  target_url: string | null;
  count_repeat: number;
  attribution_days: number | null;
  source_config_json: string;
  deduplication_mode: ConversionDeduplicationMode;
  deduplication_window_days: number | null;
  value_mode: ConversionValueMode;
  reversal_policy: ConversionReversalPolicy;
  line_account_id: string | null;
  status: ConversionDefinitionStatus;
  version: number;
  stopped_at: string | null;
  created_at: string;
  updated_at: string;
  ingest_secret_encrypted: string | null;
  ingest_disabled_at: string | null;
  recorded_count: number;
  net_value: number;
  usage_count: number;
};

export type UsageRow = {
  id: string;
  conversion_point_id: string;
  definition_version: number;
  line_account_id: string;
  ref_kind: ConversionDefinitionUsageKind;
  ref_id: string;
  ref_version_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type CancellationMetric = { count: number; value: number };

export type AddConversionDefinitionUsageInput = {
  conversionPointId: string;
  lineAccountId: string;
  expectedVersion: number;
  refKind: ConversionDefinitionUsageKind;
  refId: string;
  refVersionId?: string | null;
  staffId: string;
  /**
   * 下書き・停止中の地点にも利用関係を記すか（CONVERSION-05）。
   *
   * 手で足す口（POST /api/conversions/definitions/:id/usages）は止めたまま。
   * ファネルの段に置かれた参照は「実際に使っている」事実なので、
   * 下書き・停止中の地点へも台帳へ書く。黙って弾くと、分析の作成は
   * 成功したのに利用先一覧へ出ない食い違いが残る。
   */
  allowInactive?: boolean;
};

export type CreateConversionDefinitionInput = {
  folderId?: unknown;
  name: string;
  sourceType: string;
  sourceConfig: Record<string, unknown>;
  measureMethod: 'url_reach' | 'webhook' | 'manual';
  targetUrl?: string | null;
  deduplicationMode: ConversionDeduplicationMode;
  deduplicationWindowDays?: number | null;
  valueMode: ConversionValueMode;
  fixedValue?: number | null;
  reversalPolicy: ConversionReversalPolicy;
  attributionDays?: number | null;
  lineAccountId: string;
  usages: Array<Pick<AddConversionDefinitionUsageInput, 'refKind' | 'refId' | 'refVersionId'>>;
  staffId: string;
  /** true のとき下書きで保存し、公開するまで計測しない。 */
  draft?: boolean;
};

export type PreviewConversionDefinitionInput = {
  scope: ConversionDefinitionScope;
  lineAccountId: string;
  sourceType: string;
  /** 保存される起点設定。url_reach のURL一致など、試算にも同じ条件を使う。 */
  sourceConfig?: Record<string, unknown>;
  measureMethod?: 'url_reach' | 'webhook' | 'manual';
  targetUrl?: string | null;
  deduplicationMode: ConversionDeduplicationMode;
  deduplicationWindowDays?: number | null;
  valueMode: ConversionValueMode;
  fixedValue?: number | null;
  reversalPolicy?: ConversionReversalPolicy;
  range: ConversionDefinitionRange;
};

/** 編集で差し替える設定。監査の前後比較にもこの形をそのまま使う。 */
export type DefinitionConfig = {
  name: string;
  sourceType: string;
  sourceConfig: Record<string, unknown>;
  measureMethod: 'url_reach' | 'webhook' | 'manual';
  targetUrl: string | null;
  deduplicationMode: ConversionDeduplicationMode;
  deduplicationWindowDays: number | null;
  valueMode: ConversionValueMode;
  fixedValue: number | null;
  reversalPolicy: ConversionReversalPolicy;
  attributionDays: number | null;
};

export type RevisionRow = {
  id: string;
  version: number;
  status: ConversionDefinitionStatus;
  line_account_id: string | null;
  name: string;
  event_type: string;
  value: number | null;
  measure_method: 'url_reach' | 'webhook' | 'manual';
  target_url: string | null;
  count_repeat: number;
  attribution_days: number | null;
  source_config_json: string;
  deduplication_mode: ConversionDeduplicationMode;
  deduplication_window_days: number | null;
  value_mode: ConversionValueMode;
  reversal_policy: ConversionReversalPolicy;
};

export type ReviseConversionDefinitionInput = {
  folderId?: unknown;
  id: string;
  scope: ConversionDefinitionScope;
  expectedVersion: number;
  reason?: string | null;
  staffId: string;
} & Omit<DefinitionConfig, 'targetUrl' | 'deduplicationWindowDays' | 'fixedValue' | 'attributionDays'>
  & Partial<Pick<DefinitionConfig, 'targetUrl' | 'deduplicationWindowDays' | 'fixedValue' | 'attributionDays'>>;

// ── 外部受信 ─────────────────────────────────────────────────────────
//
// 外部システムが POST /api/conversions/ingest/:id へ成果を送るときの
// 地点ごとの受信鍵と受信台帳。鍵は受信Webhookと同じ暗号化形式で保存し、
// 平文を返すのは発行の1回だけ。

export type IngestPointRow = {
  id: string;
  status: ConversionDefinitionStatus;
  ingest_secret_encrypted: string | null;
  ingest_disabled_at: string | null;
};

export type ConversionIngestionEvent = {
  id: string;
  conversionPointId: string;
  result: 'recorded' | 'duplicate' | 'rejected';
  reason: string | null;
  /**
   * 検証の受信か。true の受信は成果表へ書かず台帳だけに残るので、
   * 売上・報酬・集計へ混入しない。本番の受信は false。
   */
  isTest: boolean;
  sourceEventId: string | null;
  friendId: string | null;
  payloadShape: Record<string, unknown> | null;
  signatureSha256: string | null;
  createdAt: string;
};

export type IngestionEventRow = {
  id: string;
  conversion_point_id: string;
  result: 'recorded' | 'duplicate' | 'rejected';
  reason: string | null;
  is_test: number | null;
  source_event_id: string | null;
  friend_id: string | null;
  payload_shape_json: string | null;
  signature_sha256: string | null;
  created_at: string;
};

/**
 * 成果1件ごとの業務状態。
 *
 * - confirmed : 確定。承認が要らない成果は記録と同時にここへ来る。
 * - pending   : 確認待ち。アフィリエイト経由の成果で承認がまだのもの。
 * - rejected  : 確認の結果、却下されたもの。確定成果には数えない。
 * - cancelled : 確定のあと取消(返品・取消調整)が入ったもの。
 */
export type ConversionDefinitionEventStatus =
  | 'confirmed' | 'pending' | 'rejected' | 'cancelled';

export type ConversionDefinitionEventItem = {
  id: string;
  friendId: string;
  /** 友だちの表示名。退会・削除済みなら null(画面はIDに倒す)。 */
  friendName: string | null;
  status: ConversionDefinitionEventStatus;
  /** 生の承認状態。却下理由の列は持たないため null / pending / approved / rejected のみ。 */
  approvalStatus: 'pending' | 'approved' | 'rejected' | null;
  approvalRevision: number | null;
  /** 取消台帳に取消が入っているか(アフィリエイト調整・取消追記のどちらでも立つ)。 */
  cancelled: boolean;
  /**
   * 取消追記台帳(conversion_event_reversals)でいま取り消しか。
   * アフィリエイト調整の取消と区別するため別に持つ。こちらだけ
   * 「取消を戻す」操作の対象になる。
   */
  reversed: boolean;
  latestReversalId: string | null;
  /** 計測したときの1件あたりの金額(地点の後からの編集に引きずられない控え)。 */
  value: number | null;
  /** どこから届いた成果か。metadata の source / sourceType を写す。 */
  source: string | null;
  sourceEventId: string | null;
  createdAt: string;
};

export type DefinitionEventRow = {
  id: string;
  friend_id: string;
  friend_name: string | null;
  approval_status: 'pending' | 'approved' | 'rejected' | null;
  approval_revision: number | null;
  cancelled: number;
  reversed: number;
  latest_reversal_id: string | null;
  value_snapshot: number | null;
  metadata: string | null;
  created_at: string;
};

export type ReportLedgers = { affiliate: boolean; reversals: boolean };

export type ReportRow = {
  conversion_point_id: string;
  conversion_point_name: string;
  event_type: string;
  total_count: number;
  total_value: number;
  cancelled_count: number;
  cancelled_value: number;
};

export interface ConversionReport {
  conversionPointId: string;
  conversionPointName: string;
  eventType: string;
  totalCount: number;
  totalValue: number;
}
