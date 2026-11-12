import type { RestaurantFollowupManagement } from '@line-crm/shared'
import type { Automation } from '@line-crm/shared'

export type CommonActionStep = {
  id: string;
  type: 'add_tag' | 'remove_tag' | 'set_metadata' | 'start_scenario' | 'stop_scenario'
    | 'resume_scenario' | 'send_message' | 'send_webhook' | 'switch_rich_menu'
    | 'remove_rich_menu' | 'wait' | 'common_action' | 'branch';
  params: Record<string, unknown>;
  onFailure: 'stop' | 'continue';
};

export type CommonActionSummary = {
  folderId?: string | null
  id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'published' | 'archived';
  draftVersion: number | null;
  publishedVersion: number | null;
  actionCount: number;
  bindingCount: number;
  oldVersionBindingCount: number;
  executionCountThisMonth: number;
  failureCountThisMonth: number;
  lastRunAt: string | null;
  updatedAt: string;
};

export type AutomationListItem = Automation & {
  confirmationRevision?: number;
  followupManagement?:RestaurantFollowupManagement;
  folderId?: string | null
  triggerConfig: Record<string, unknown>;
  status: 'draft' | 'active' | 'stopped' | 'archived';
  versionId: string;
  version: number;
  executionCount30d: number;
  failureCount30d: number;
  lastRunAt: string | null;
};

export type CommonActionVersion = {
  id: string;
  versionNumber: number;
  status: 'draft' | 'published';
  actions: CommonActionStep[];
  /* 監査 R473・R477: 保存ごとに進む改訂番号。 */
  draftRevision: number;
  createdBy: string | null;
  createdAt: string;
  publishedAt: string | null;
};

export type CommonActionBinding = {
  id: string;
  confirmationRevision?: number;
  consumerType: string;
  consumerId: string;
  consumerPath: string;
  versionId: string;
  versionNumber: number;
  latestVersionNumber: number | null;
  hasNewerVersion: boolean;
  runningCount: number | null;
  waitingCount: number | null;
  /* 監査 R471: 切替後に旧版のまま進んでいる実行。現在版の件数とは分ける。 */
  olderRunningCount: number | null;
  olderWaitingCount: number | null;
  updatedAt: string;
};

export type CommonActionDetail = {
  folderId?: string | null
  id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'published' | 'archived';
  currentDraftVersionId: string | null;
  currentPublishedVersionId: string | null;
  versions: CommonActionVersion[];
  bindings: CommonActionBinding[];
};

export type CommonActionResources = {
  trigger?: 'tag.added' | null;
  actionTypes?: Array<{
    id: string;
    label: string;
    actionType: string;
    variant?: string;
    resource?: string;
    state: 'available' | 'unavailable';
    reason: string | null;
    schema: Record<string, unknown>;
  }>;
  tags: Array<{ id: string; name: string }>;
  scenarios: Array<{ id: string; name: string }>;
  templates: Array<{ id: string; name: string }>;
  friendFields?: Array<{ id: string; name: string }>;
  supportMarks?: Array<{ id: string; name: string }>;
  reminders?: Array<{ id: string; name: string }>;
  notificationRules?: Array<{ id: string; name: string }>;
  webhooks: Array<{ id: string; name: string }>;
  richMenus: Array<{ id: string; name: string }>;
  commonActions: Array<{
    id: string;
    name: string;
    version: number;
    currentPublishedVersionId: string;
  }>;
};

export type AutomationTemplateSummary = {
  key: string
  name: string
  description: string
  triggerLabel: string
  actionLabel: string
}

export type AutomationDraftAction = {
  id: string
  type: 'add_tag' | 'start_scenario' | 'send_message' | 'common_action' | 'notify_staff' | 'wait'
  params: Record<string, unknown>
  onFailure: 'stop'
}

export type AutomationDraftDetail = {
  followupManagement?:RestaurantFollowupManagement;
  folderId?: string | null
  id: string
  draftVersionId: string
  name: string
  description: string | null
  eventType: 'friend_add' | 'tag_change' | 'message_received' | 'form_submitted'
    | 'link_clicked' | 'calendar_booked' | 'datetime' | 'daily' | 'weekly'
    | 'ec.order.confirmed'
  triggerConfig: Record<string, unknown>
  conditions: Record<string, unknown>
  actions: AutomationDraftAction[]
  /**
   * 監査 R486/R487: 下書きの各「共通アクションを実行」が確認時点で指す
   * 公開版。版が解決できない処理は versionId が null で、画面は送信へ
   * 進めない扱いにする。
   */
  commonActionRefs: AutomationDraftCommonActionRef[]
  /** key=版id。確認画面が中身を展開するための版データ（入れ子の先も含む）。 */
  commonActionVersions: Record<string, AutomationDraftCommonActionVersionDetail>
}

/** 下書きの処理1件が指す共通アクションの固定版（見つからないときは null）。 */
export type AutomationDraftCommonActionRef = {
  stepId: string
  commonActionId: string
  name: string | null
  versionId: string | null
  versionNumber: number | null
}

/** 確認画面へ出すための、共通アクションの版の中身。 */
export type AutomationDraftCommonActionVersionDetail = {
  commonActionId: string
  name: string
  versionNumber: number
  actions: Array<{
    id: string
    type: string
    params: Record<string, unknown>
    onFailure: 'stop' | 'continue'
  }>
}

/** #942 N-354: 実行記録1件の詳細。処理ごとの結果と試行数を持つ。 */
export type AutomationRunStep = {
  stepKey: string
  actionType: string
  actionLabel: string
  status: 'queued' | 'running' | 'waiting' | 'success' | 'failed' | 'skipped' | 'cancelled'
  attemptNumber: number
  errorCode: string | null
  errorMessage: string | null
  commonActionVersionId: string | null
  startedAt: string | null
  completedAt: string | null
}

export type AutomationRunDetail = {
  id: string
  automationId: string
  automationName: string
  automationVersionId: string
  /** 実行時に固定された版番号。 */
  versionNumber: number
  /** 1人テストの実行か。 */
  isTest: boolean
  /** 取りやめられるのは、まだ終わっていない実行だけ。 */
  canCancel: boolean
  canRetry: boolean
  occurredAt: string
  subject: string | null
  accountLabel: string | null
  triggerLabel: string
  status: 'queued' | 'claimed' | 'succeeded' | 'skipped' | 'waiting' | 'retry_wait' | 'partial' | 'permanent_failed' | 'cancelled'
  domainStatus: string
  detail: string | null
  durationMs: number | null
  failureReason: string | null
  /** #1043: 運用停止・機能無効で動けない実行の理由。 */
  holdReason: string | null
  /** #1043: 実行した版がいまの公開版と同じか。 */
  isCurrentVersion: boolean
  currentVersionNumber: number | null
  successfulActions: string[]
  skippedActions: string[]
  failedAction: string | null
  friendId: string | null
  friendName: string | null
  steps: AutomationRunStep[]
}
