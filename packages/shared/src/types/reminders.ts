import type { RestaurantFollowupManagement } from '../restaurant-followup-management.js';
import type { MessageType } from './messages.js';
import type { ExecutionRunListItem } from './execution-runs.js';

// -----------------------------------------------------------------------------
// リマインダ (Reminder)
// -----------------------------------------------------------------------------

/** リマインダを動かすきっかけ */
/**
 * リマインダのゴールを何で決めるか。
 *   friend_field … 友だち情報欄の日付（誕生日・次回お届け日・契約更新日）。154 で追加。
 */
export type ReminderTriggerType = "manual" | "booking" | "event" | "friend_field";

export interface Reminder {
  followupManagement?:RestaurantFollowupManagement;
  id: string;
  /** 所属先を取得できない古い応答や未所属では null または省略。 */
  lineAccountId?: string | null;
  /** null は未所属、省略は古い応答。名前が null の場合は取得できなかった。 */
  lineAccount?: { id: string; name: string | null } | null;
  name: string;
  description: string | null;
  isActive: boolean;
  /** きっかけ。manual は従来どおり手で登録する */
  triggerType?: ReminderTriggerType;
  /** 起点を何分ずらすか。null ならずらさない。負の値も使える */
  triggerOffsetMinutes?: number | null;
  /** 起点の時刻を固定する JST の "HH:MM"。null なら予約時刻のまま */
  sendAtTime?: string | null;
  /** 対象を絞るタグ。null なら対象者全員 */
  targetTagId?: string | null;
  /** 153: 'time'（ゴールの○日前の●時）か 'countdown'（残り時間）。**作成後は変えられない。** */
  deliveryMode?: 'time' | 'countdown';
  /** 154: 友だち情報欄の日付を起点にするとき、見る欄。 */
  triggerFieldId?: string | null;
  /** 154: 毎年くり返すか（誕生日なら true）。 */
  repeatYearly?: boolean;
  /** 419: 2月29日が基準日の毎年くり返しで、平年にいつ扱うか。 */
  leapYearPolicy?: 'feb28' | 'mar1' | 'skip';
  createdAt: string;
  updatedAt: string;
}

export interface ReminderStep {
  id: string;
  reminderId: string;
  offsetMinutes: number;
  messageType: MessageType;
  messageContent: string;
  /** 153: ゴールから何日ずらすか。配信方式が 'time' のとき使う。 */
  offsetDays?: number | null;
  /** 153: その日の何時に送るか（日本時間の "HH:MM"）。 */
  sendAtTime?: string | null;
  /** 153: 送る中身をテンプレートから選ぶ。 */
  templateId?: string | null;
  createdAt: string;
}

export interface FriendReminder {
  id: string;
  friendId: string;
  reminderId: string;
  targetDate: string;
  status: "active" | "completed" | "cancelled";
  createdAt: string;
  updatedAt: string;
}

export type ReminderLifecycleStatus = "draft" | "published" | "stopped";

export interface ReminderStopConditions {
  bookingCancelled: boolean;
  supportMarkCompleted: boolean;
  daysAfterTarget: number | null;
  friendBlocked: boolean;
}

export interface ReminderDraftStep {
  messageParts?: Array<{messageType:string;messageContent:string}>;
  stableStepId: string;
  offsetMinutes: number;
  messageType: MessageType;
  messageContent: string;
  offsetDays?: number | null;
  sendAtTime?: string | null;
  templateId?: string | null;
  targetCondition?: Record<string, unknown>;
  action?: Record<string, unknown>;
}

/**
 * リマインダの対象条件。一斉配信・シナリオと同じ絞り込みの形。
 *
 * settings_snapshot の JSON にだけ持つので列の追加は要らない。
 * 空 (rules・groups ともに0件) は「絞り込みなし」と同じく扱う。
 */
export interface ReminderTargetCondition {
  operator: 'AND' | 'OR';
  rules: Array<{ type: string; value: unknown }>;
  groups?: ReminderTargetCondition[];
}

export interface ReminderDraftSettings {
  name: string;
  description?: string | null;
  lineAccountId: string;
  triggerType: ReminderTriggerType;
  deliveryMode: "time" | "countdown";
  triggerFieldId?: string | null;
  /** triggerType が 'event' のときの起点イベント。未指定(NULL)は全イベントが起点になる従来動作。 */
  triggerEventId?: string | null;
  repeatYearly?: boolean;
  /** 419: 2月29日が基準日の毎年くり返しで、平年にいつ扱うか。既定 'feb28'。 */
  leapYearPolicy?: 'feb28' | 'mar1' | 'skip';
  triggerOffsetMinutes?: number | null;
  sendAtTime?: string | null;
  targetTagId?: string | null;
  /** 対象の絞り込み条件。あるときは targetTagId よりこちらが勝つ。 */
  targetCondition?: ReminderTargetCondition | null;
  folderId?: string | null;
  stopConditions: ReminderStopConditions;
  steps: ReminderDraftStep[];
}

export interface ReminderDraftVersion {
  reminderId: string;
  versionId: string;
  versionNumber: number;
  status: "draft" | "published" | "superseded";
  settings: ReminderDraftSettings;
  lastTestStatus: "succeeded" | "failed" | null;
  lastTestedAt: string | null;
  publishedAt: string | null;
  /**
   * 版の更新時刻。保存のたびに変わるため、開いたときの値と
   * ずれていれば別の画面が先に保存したと分かる。保存時に送り返す。
   */
  updatedAt: string;
}

export interface ReminderValidationResult {
  valid: boolean;
  checks: Array<{
    key: string;
    label: string;
    status: "passed" | "failed" | "warning";
    message: string;
  }>;
  audience: { matched: number | null; excluded: number | null };
}

export interface ReminderPreviewResult {
  targetDate: string;
  items: Array<{
    stableStepId: string;
    stepNumber: number;
    scheduledAt: string;
    label: string;
    state: "scheduled" | "past" | "duplicate";
  }>;
  summary: {
    audience: number | null;
    next7Days: number | null;
    next30Days: number | null;
    duplicateCount: number;
  };
}

export interface ReminderPublishResult {
  reminderId: string;
  versionId: string;
  versionNumber: number;
  publishedAt: string;
  audience: number | null;
  plannedDeliveries: number | null;
  nextScheduledAt: string | null;
}

/**
 * テスト送信前に画面へ出す送信先の状態。
 * unset=未設定 / unavailable=設定済みだがこのアカウントで届けられない /
 * ready=送信できる。送信本体と同じ判定を使うので表示と実送信がずれない。
 *
 * REMINDER-12: ready の送信先は「操作者本人のLINE（self）」と
 * 「アカウント設定の登録済みテスト宛先（registered）」を区別する。
 * 本人宛てはスタッフとの本人対応をサーバーで確認できた場合だけ名乗り、
 * 登録宛先は画面・確認窓・要約で実名を明示する。
 */
export interface ReminderTestRecipientStatus {
  state: "unset" | "unavailable" | "ready";
  recipient: {
    id: string;
    displayName: string;
    pictureUrl: string | null;
  } | null;
  /** ready のときだけ埋まる送信先の種別。それ以外は null。 */
  recipientKind: "self" | "registered" | null;
}

/** リマインダの書込台帳だけが持つ詳細状態。共通状態へ潰さず保存する。 */
export type ReminderDeliveryRunStatus =
  | "planned"
  | "claimed"
  | "succeeded"
  | "skipped"
  | "retry_wait"
  | "permanent_failed"
  | "cancelled";

export interface ReminderDeliveryRun extends ExecutionRunListItem {
  id: string;
  reminderId: string;
  friendReminderId: string;
  friendId: string;
  friendName: string | null;
  reminderStepId: string;
  stepNumber: number;
  scheduledAt: string;
  startedAt: string | null;
  completedAt: string | null;
  domainStatus: ReminderDeliveryRunStatus;
  attemptCount: number;
  nextRetryAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  /** LINEが返した要求ID。取れなかった場合はnullのままにし、作らない。 */
  lineRequestId: string | null;
  /** 実際に送った本文へ辿るためのmessages_log ID。成功前はnull。 */
  messageLogId: string | null;
}

export interface ReminderDeliveryRunsResponse {
  reminder: {
    id: string;
    name: string;
    isActive: boolean;
    /** 公開版スナップショットのライフサイクル。旧API由来の行は 'published' 相当。 */
    lifecycleStatus: "draft" | "published" | "stopped";
    /** 公開版スナップショットの停止条件。公開版が無いときは null（未取得と区別する）。 */
    stopConditions: ReminderStopConditions | null;
    /**
     * 公開版があるか。無い下書きは「停止中」ではなく
     * 「下書き」と出し、再開はさせない。
     */
    hasPublishedVersion: boolean;
  };
  summary: {
    sent: number;
    scheduled: number;
    stopped: number;
    errors: number;
    targetCount: number;
    nextScheduledAt: string | null;
  };
  steps: Array<{
    id: string;
    stepNumber: number;
    offsetMinutes: number;
    messageType: MessageType;
    messageContent: string;
    sent: number;
    /** LINE Messaging APIは友だち単位の既読を返さないため、null。 */
    openRate: number | null;
    errors: number;
  }>;
  items: ReminderDeliveryRun[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
  };
}
