import type { Broadcast, BroadcastTargetType, BroadcastBubble, BroadcastMessageOptions } from '@line-crm/shared'
import type { SegmentCondition } from '../../segment-condition'

/** Broadcast type from API (now camelCase after worker serialization) */
export type ApiBroadcast = Omit<Broadcast, 'targetType'> & {
  targetType: BroadcastTargetType;
  correctionOfBroadcastId?: string | null;
  correctionExcludedAtCreation?: number;
  correction?: { id: string; status: string } | null;
  /** Worker が返す配信元LINEアカウント。旧データは null。 */
  lineAccountId: string | null;
  accountIds: string[] | null;
  dedupPriority: string[] | null;
  failedAccountIds: string[] | null;
  trackLinks: boolean;
  messageBubbles?: BroadcastBubble[] | null;
  /** 宛先の条件。一覧で「何で絞ったか」を出すのに使う。 */
  segmentConditions?: SegmentCondition | null;
  /** 分類。null なら未分類。 */
  folderId?: string | null;
  /**
   * 一覧に同梱される集計の最新値。行が無い(未送信・未取得)ときは null。
   * 送信済みごとの insight 取得(N+1)を一覧1回で済ませるため。
   */
  insightSummary?: {
    delivered: number | null
    uniqueImpression: number | null
    uniqueClick: number | null
    openRate: number | null
    clickRate: number | null
  } | null;
  /** 開封数を取るか。 */
  measureOpens?: boolean;
  /** 友だちには見せない運用メモ。 */
  internalMemo?: string | null;
  /** 現在の配送に保存された分散の分数。旧Workerでは省略。 */
  stealthSpreadMinutes?: number;
  /** 途中保存した編集段。 */
  draftStep?: 'basic' | 'audience' | 'message' | 'schedule' | 'confirm' | null;
  /** 途中保存した入力一式。 */
  draftPayload?: Record<string, unknown> | null;
  /** ボタンなど、本文以外のメッセージ設定。 */
  messageOptions?: BroadcastMessageOptions | null;
  /** 公開済みの共通アクション版。 */
  afterActionVersionId?: string | null;
  /** 楽観ロックに使う版。 */
  version?: number;
  /**
   * 停止中か（#662 / N-059）。
   *
   * `status` は動かしていない。停止は送信の段階とは別の軸——「送信中だが、
   * 新しい送信権をもう取らない」——なので、画面はこの2つを合わせて読む。
   * `status === 'sending' && stopped` が「停止中」。
   */
  stopped?: boolean;
  stoppedAt?: string | null;
  /** 送信の試行番号。失敗分の再送で進む。 */
  sendAttemptNo?: number;
  /*
   * 二者承認の今の状態（m12a）。送信の段階（status）とは別の軸。
   * none（承認がいらない・まだ頼んでいない）/ pending / approved /
   * rejected / cancelled / expired（予約時刻を過ぎた）。
   */
  approvalStatus?: 'none' | 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired';
  approvalRequestedByStaffId?: string | null;
  approvalRequestedAt?: string | null;
  approvalApproverStaffId?: string | null;
  approvalNote?: string | null;
  approvalDecidedByStaffId?: string | null;
  approvalDecidedAt?: string | null;
  approvalRejectReason?: string | null;
  /**
   * 10の状態（#816）。status・承認・停止・台帳から組み立てた見せ方の状態。
   * 無いとき（古い応答）は status から読み替える。
   */
  displayStatus?: BroadcastDisplayStatus;
  displayStatusLabel?: string;
  ledger?: BroadcastLedger;
};

/** 一斉配信の10の状態（#816）。 */
export type BroadcastDisplayStatus =
  | 'draft'
  | 'pending_approval'
  | 'scheduled'
  | 'preparing'
  | 'sending'
  | 'sent'
  | 'partial_failed'
  | 'failed'
  | 'stopped'
  | 'expired';

/** 宛先台帳の1行（GET /:id/recipients）。札の言葉は Worker が直して返す。 */
export type BroadcastRecipientRow = {
  friendId: string
  displayName: string
  lineAccountId: string | null
  group: 'delivered' | 'failed_temporary' | 'failed_permanent' | 'unknown' | 'inflight'
  label: string
  detail: string
  retryable: boolean
  lineRequestId: string | null
  errorCode: string | null
  dispatchedAt: string | null
  settledAt: string | null
};

export type BroadcastRecipientsSummary = {
  sent: number
  failedTemporary: number
  failedPermanent: number
  unknown: number
  inFlight: number
  pending: number | null
  total: number
  retryableCount: number
};

/** 操作の記録の1件（GET /:id/activity）。操作と承認を混ぜて新しい順に返す。 */
export type BroadcastActivityEntry = {
  kind: 'lifecycle' | 'approval'
  action: string
  label: string
  actorStaffId: string | null
  actorName: string | null
  reason: string | null
  createdAt: string
};

/** 承認の依頼先の候補（承認できる人だけ。自分は除く）。 */
export type BroadcastApprovalCandidate = {
  id: string
  name: string
  role: string
  canApprove: boolean
};

/** 二者承認の今の状態と判定（GET /:id/approval の応答）。 */
export type BroadcastApprovalState = import('@line-crm/shared').BroadcastApprovalState;

/**
 * 送達台帳の内訳（#662 / N-059）。
 *
 * `successCount` だけだと「残りは失敗」と読めてしまい、送達不明の相手を
 * 送り直してよいものと誤解させる。届いた・届かなかった・分からない を分ける。
 */
export type BroadcastLedger = {
  /** 届いた人。 */
  sent: number
  /** 届かなかったと断定できた人（一時的＋恒常的）。 */
  failed: number
  /** 一時的な失敗（混み合い・止める前で未送信）。**再送の対象**。 */
  failedTemporary?: number
  /** 恒常的な失敗（ブロックなど）。送り直さない。 */
  failedPermanent?: number
  /** 外へ出たかもしれないが確かめられない人。**再送しない**。 */
  unknown: number
  /** いま送っている途中の人。 */
  inFlight: number
  /** 再送の対象人数（= 一時的な失敗）。 */
  retryableCount: number
};

export type BroadcastSavedView = {
  id: string
  name: string
  filters: Record<string, unknown>
  sortKey: 'newest' | 'oldest' | 'title' | 'scheduled'
  pageSize: 20 | 50 | 100
  createdBy: string
  createdAt: string
  updatedAt: string
  version: number
}

export type BroadcastAssetKind = 'rich_message' | 'card_message' | 'coupon' | 'research';

export type BroadcastAssetFolder = {
  id: string;
  lineAccountId: string | null;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type BroadcastMessageAsset = {
  folderId?: string | null;
  status?: 'draft' | 'published' | 'published_with_draft';
  hasDraft?: boolean;
  publishedPayload?: Record<string, unknown>;
  publishedVersion?: number;
  draftRevision?: number;
  id: string;
  lineAccountId: string | null;
  kind: BroadcastAssetKind;
  name: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type BroadcastInsight = {
  broadcastId?: string
  delivered: number | null
  uniqueImpression: number | null
  uniqueClick: number | null
  uniqueMediaPlayed: number | null
  openRate: number | null
  clickRate: number | null
  status?: string
  fetchedAt?: string | null
  opens?: {
    count: number | null
    denominator: number | null
    rate: number | null
    state: 'available' | 'pending' | 'unavailable' | 'insufficient'
  }
  links?: Array<{
    id: string
    label: string
    url: string
    clickCount: number
    uniqueClickCount: number
    clickRate: number | null
    lastClickedAt?: string | null
  }>
}
