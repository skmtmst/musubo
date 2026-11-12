import type { Scenario } from '@line-crm/shared'

/** シナリオ停止時の入力。理由は任意・200字まで。 */
export type ScenarioConfirmation = { contentRevision: number; activeCount: number; rowIdSum: number; rowIdSquareSum: number; totalCount: number; totalRowIdSum: number; totalRowIdSquareSum: number; referrers: Array<{ id: string; revision: number }> }
export type ScenarioStopInput = { reason?: string; expectedContentRevision?: number; expectedSubscriptions?: { activeCount: number; rowIdSum: number; rowIdSquareSum: number } }

export type ScenarioUpdateInput = Partial<Omit<Scenario,
  'id' | 'createdAt' | 'updatedAt' | 'stoppedReason' | 'stoppedBy' | 'stoppedAt'
>> & ScenarioStopInput

/** シナリオの開始のきっかけ（128）。1本に複数持てる。 */
export type ScenarioTriggerItem = {
  id: string
  /** friend_add … 友だち追加時 / tag_added … 決めたタグが付いたとき */
  kind: 'friend_add' | 'tag_added' | 'form_answer' | 'booking_confirmed'
  /** kind が tag_added のときだけ入る。 */
  tagId: string | null
}

/* ---- シナリオのアクション（Lステップの「アクション設定」にあたる） ---- */

/** どこで発火するか。 */
export type ScenarioActionHook = 'step_sent' | 'scenario_completed' | 'choice_selected'

/** 何をするか。 */
export type ScenarioActionType =
  | 'tag'
  | 'friend_field'
  | 'support_mark'
  | 'scenario'
  | 'common_var'
  | 'send_message'
  | 'send_template'
  | 'reminder'
  | 'event_booking'

export type ScenarioAction = {
  id: string
  scenarioId: string
  hook: ScenarioActionHook
  stepId: string | null
  choiceIndex: number | null
  sortOrder: number
  actionType: ScenarioActionType
  /** 種別ごとに形が違う。worker の services/scenario-actions.ts に定義がある。 */
  config: unknown
  /** 実行条件。null なら無条件。 */
  condition: unknown
  /** false なら、同じ友だちには1度しか実行しない。 */
  repeatOnRefire: boolean
  /**
   * 中身が埋まっているか。false のあいだは配信で実行されない。
   * 画面はカードを1枚置いてから埋める作りなので、途中の状態がありうる。
   */
  complete?: boolean
}

/** 機能5 管理画面の副作用なし試算。開始前の人数と通ごとの予定を同じ計算で返す。 */
export type ScenarioSimulation = {
  scenarioId: string
  lineAccountId: string
  computedAt: string
  sideEffects: false
  audience: {
    accountTotal: number
    matched: number
    alreadySubscribed: number
    newStartPlanned: number
    excluded: number
  }
  steps: Array<{
    id: string
    stepOrder: number
    scheduledAt: string
    targetCount: number
    excludedCount: number
  }>
}

export type ScenarioMeasuredMetric = {
  value: number | null
  state: 'available' | 'unavailable'
  reason?: string
}

/**
 * 友だち単位の購読1行（#949 N-054 の操作対象）。
 * `pauseReason` で「手動停止」「この通を送ったら止める」「配信失敗」を
 * 区別し、画面は「再開」と「失敗を再送」を出し分ける。
 */
export type FriendScenarioSubscription = {
  id: string
  friendId: string
  scenarioId: string
  currentStepOrder: number
  status: 'active' | 'paused' | 'completed' | 'delivering' | string
  startedAt: string
  nextDeliveryAt: string | null
  publishedVersionId: string | null
  pauseReason: 'manual' | 'after_send' | 'delivery_failed' | string | null
  updatedAt: string
}

/** 購読・テスト送信・送信枠・通別結果をまとめた機能5 管理画面の読取結果。 */
export type ScenarioRuns = {
  summary: { active: number; paused: number; completed: number; delivering: number }
  subscriptions: Array<{
    id: string
    confirmationRevision?: number
    friendId: string
    friendName: string
    status: string
    currentStepOrder: number
    currentDisplayOrder?: number | null
    startedAt: string
    nextDeliveryAt: string | null
    /** なぜ止まっているか（432）。止まっていない行・古い行は null。 */
    pauseReason?: string | null
    updatedAt: string
  }>
  pagination: { total: number; limit: number; cursor: string; nextCursor: string | null }
  testSends: Array<{
    id: string
    friendId: string
    friendName: string
    sentAt: string
    messageCount: number
  }>
  quota: {
    limit: number | null
    used: number | null
    remaining: number | null
    state: 'available' | 'unlimited' | 'unavailable'
    reason: string | null
    asOf: string
  }
  concurrentBroadcasts: Array<{ id: string; title: string; status: string; scheduledAt: string }>
  scenarioClickTotal: number
  steps: Array<{
    id: string
    stepOrder: number
    delivered: number
    opened: ScenarioMeasuredMetric
    clicked: ScenarioMeasuredMetric
    failed: ScenarioMeasuredMetric
  }>
}

/**
 * 友だち単位の配信予定（IDEA-05）。選んだ検証顧客へ現在のシナリオがどう
 * 配られるかを、送信・登録・タグ更新なしで試算した結果。
 */
export type ScenarioFriendPlanStep = {
  stepId: string
  stepOrder: number
  /** 版の全ての通を含めた表示順。旧APIでは返らない。 */
  displayOrder?: number
  /** 配信予定。未確定のときは null。 */
  scheduledAt: string | null
  outcome: 'deliver' | 'skip' | 'branch' | 'pause' | 'undetermined'
  /** 分岐・除外の理由。読む人向けの文。 */
  reason: string | null
  /** 配信時点の状態で結果が変わるとき true。画面は「未確定」と出す。 */
  dynamic: boolean
}

export type ScenarioFriendPlan = {
  scenarioId: string
  lineAccountId: string
  friendId: string
  friendName: string | null
  computedAt: string
  sideEffects: false
  subscription: {
    id: string
    status: string
    currentStepOrder: number
    startedAt: string
    nextDeliveryAt: string | null
    pauseReason: string | null
  } | null
  /** pinned=購読に固定された公開版 / published=現在の公開版 / draft=下書きの参考予定 */
  basis: 'pinned' | 'published' | 'draft'
  start: { state: 'ok' | 'blocked'; reasons: string[] }
  steps: ScenarioFriendPlanStep[]
  warnings: string[]
}

export type ScenarioDraftActionV6 = {
  id: string
  hook: 'step_sent' | 'scenario_completed' | 'choice_selected'
  stepId: string | null
  choiceKey: string | null
  type: string
  params: Record<string, unknown>
  condition: unknown
  onFailure: 'stop' | 'continue'
  sortOrder: number
}

export type ScenarioDraftV6 = {
  scenarioId: string
  lineAccountId: string
  version: number
  afterActions: ScenarioDraftActionV6[]
  updatedBy: string
  updatedAt: string
}
