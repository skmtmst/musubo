import type { MessageType } from './messages.js';
import type { BroadcastBubble } from '../broadcast-definition.js';

// -----------------------------------------------------------------------------
// シナリオ (Scenario)
// -----------------------------------------------------------------------------

/** シナリオのトリガー種別 */
export type ScenarioTriggerType = "friend_add" | "tag_added" | "manual";

/**
 * シナリオの配信モード
 * - relative: 前ステップからの相対遅延 (delayMinutes)
 * - elapsed: 購読開始からの経過時間 (offsetDays + offsetMinutes)
 * - absolute_time: 購読開始から N 日後の HH:MM JST (offsetDays + deliveryTime)
 */
export type DeliveryMode = "relative" | "elapsed" | "absolute_time";

export interface Scenario {
  /** 主キー (UUIDv4) */
  id: string;
  /** 危ない操作の確認に使う内容の版。 */
  contentRevision?: number;
  /** シナリオ名 */
  name: string;
  /** 説明文 */
  description: string | null;
  /** トリガー種別 */
  triggerType: ScenarioTriggerType;
  /** トリガーとなるタグID (triggerType が 'tag_added' の場合のみ使用) */
  triggerTagId: string | null;
  /** 紐づく LINE アカウント ID。null = 全アカウント共通として発火 */
  lineAccountId: string | null;
  /** 有効/無効フラグ */
  isActive: boolean;
  /** 最後の停止理由（200字まで）。停止記録が無い・理由未入力なら null。 */
  stoppedReason?: string | null;
  /** 最後に止めた担当者ID。停止記録が無いなら null。 */
  stoppedBy?: string | null;
  /** 最後に止めた日時（日本時間）。再開しても停止記録を残す。 */
  stoppedAt?: string | null;
  /** 配信モード (作成後の変更不可)。レスポンスでは常にセット、Create リクエストでは省略可 (default: 'relative') */
  deliveryMode?: DeliveryMode;
  /**
   * 他のシナリオと同時に動いてよいか。既定は true（並行を許す）。
   * false にすると、他のシナリオが動いている人はこのシナリオに登録されない。
   */
  allowConcurrent?: boolean;
  /** 一覧での並び順。小さいほど上 */
  displayOrder?: number;
  /** 作成日時 (ISO 8601) */
  createdAt: string;
  /** 更新日時 (ISO 8601) */
  updatedAt: string;
  /** 置き場。未分類は null。 */
  folderId?: string | null;
  /** シナリオ全体の配信対象 (120)。SegmentCondition。null は条件なし。 */
  audienceCondition?: unknown;
  /** 最終コンテンツを配り終えたあとどうするか (121)。 */
  onCompleteMode?: 'pause' | 'resume_previous' | 'move';
  /** onCompleteMode が 'move' のときの移動先 (122)。 */
  onCompleteScenarioId?: string | null;
}

export interface ScenarioStep {
  /** 主キー (UUIDv4) */
  id: string;
  /** 所属するシナリオID */
  scenarioId: string;
  /** ステップ順序 (1始まり) */
  stepOrder: number;
  /** 前のステップからの遅延時間 (分) — relative mode のみ意味あり、他モードは 0 */
  delayMinutes: number;
  /** 購読開始からの経過日数 — elapsed / absolute_time mode 用 */
  offsetDays?: number | null;
  /** 経過日数に追加する分 (0..1439) — elapsed mode 用 */
  offsetMinutes?: number | null;
  /** 配信時刻 "HH:MM" (JST) — absolute_time mode 用 */
  deliveryTime?: string | null;
  /** 参照するテンプレート ID (null = 直接入力モード) */
  templateId?: string | null;
  /** このステップ到達時に付与するタグ ID */
  onReachTagId?: string | null;
  /** この通を送ったあと。'pause' なら次へ進めず止める */
  afterSend?: 'continue' | 'pause';
  /** メッセージ種別 */
  messageType: MessageType;
  /** メッセージ内容 (テキスト or JSONシリアライズ済みFlexメッセージ等) */
  messageContent: string;
  /** 来店フォローの複数吹き出し。保存は専用の版付きAPIを使う。 */
  messageBubbles?: BroadcastBubble[] | null;
  /**
   * 1通ごとの配信対象 (124)。SegmentCondition。null は「購読中の全員に配信する」。
   *
   * ステップの条件 (condition_type) とは意味が違う。あちらは「満たさなければ
   * 次へ飛ばす」、こちらは「対象でなければこの通だけ送らない」。
   */
  targetCondition?: unknown;
  /** 質問メッセージ (125)。ScenarioQuestion。null ならふつうの通。 */
  question?: unknown;
  /** 下書き (126)。true なら配信の対象から外れる。 */
  isDraft?: boolean;
  /** 作成日時 (ISO 8601) */
  createdAt: string;
}

/** シナリオ到達率ダッシュボード */
export interface ScenarioStats {
  enrolledTotal: number;
  activeNow: number;
  completed: number;
  paused: number;
  steps: Array<{
    stepOrder: number;
    reachedCount: number;
    /** 0..1 */
    reachRate: number;
  }>;
}

// -----------------------------------------------------------------------------
// 友だち×シナリオ 進捗テーブル (FriendScenario)
// -----------------------------------------------------------------------------

/** シナリオ配信ステータス */
export type FriendScenarioStatus = "active" | "paused" | "completed";

export interface FriendScenario {
  /** 主キー (UUIDv4) */
  id: string;
  /** 友だちID */
  friendId: string;
  /** シナリオID */
  scenarioId: string;
  /** 現在処理中のステップ順序 */
  currentStepOrder: number;
  /** 配信ステータス */
  status: FriendScenarioStatus;
  /** 開始日時 (ISO 8601) */
  startedAt: string;
  /** 次回配信予定日時 (ISO 8601、null は配信完了) */
  nextDeliveryAt: string | null;
  /** 更新日時 (ISO 8601) */
  updatedAt: string;
}
