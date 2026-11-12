import type { MessageType, ScenarioStep } from '../scenario-step-types.js';

export type ScenarioTriggerType = 'friend_add' | 'tag_added' | 'form_answer' | 'booking_confirmed' | 'manual';
export type FriendScenarioStatus = 'active' | 'paused' | 'completed' | 'delivering';
export type DeliveryMode = 'relative' | 'elapsed' | 'absolute_time';

export interface Scenario {
  id: string;
  content_revision: number;
  name: string;
  description: string | null;
  trigger_type: ScenarioTriggerType;
  trigger_tag_id: string | null;
  line_account_id: string | null;
  is_active: number;
  delivery_mode: DeliveryMode;
  /** 他のシナリオと同時に動いてよいか。1 が既定（並行を許す） */
  allow_concurrent: number;
  /** 一覧での並び順。小さいほど上（113 で追加） */
  display_order: number;
  /** 置き場（099 で追加）。未分類は null。 */
  folder_id: string | null;
  /** シナリオ全体の配信対象（120）。SegmentCondition の JSON。null は条件なし。 */
  audience_condition_json: string | null;
  /** 最終コンテンツを配り終えたあと（121）。'pause' | 'resume_previous' | 'move' */
  on_complete_mode: string;
  /** on_complete_mode が 'move' のときの移動先（122）。 */
  on_complete_scenario_id: string | null;
  /** 最後の停止記録（590）。再開しても保持する。旧行は null。 */
  stopped_reason?: string | null;
  stopped_by?: string | null;
  stopped_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScenarioWithSteps extends Scenario {
  steps: ScenarioStep[];
}

/**
 * 公開版（351）。公開操作のたびに1行作る不変のスナップショット。
 * 通の配列は steps_snapshot の JSON に固定し、行の更新・削除は
 * トリガーで禁じている（自動応答の公開版 273 と同じ流儀）。
 */
export interface ScenarioVersion {
  id: string;
  scenario_id: string;
  version_number: number;
  delivery_mode: DeliveryMode;
  audience_condition_json: string | null;
  on_complete_mode: string;
  on_complete_scenario_id: string | null;
  steps_snapshot: string;
  /**
   * 公開時に写したアクション設定（scenario_actions）の JSON 配列。
   * これが無いと、旧版に固定された購読でも常に live のアクションが動き、
   * 公開後の編集が混入する。
   */
  actions_snapshot: string;
  status: 'published' | 'retired';
  published_at: string;
  published_by_staff_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 公開操作の冪等キー台帳（351）。同じキーの再実行は同じ版を返し、
 * 別内容・別シナリオでの使い回しは SCENARIO_PUBLISH_KEY_CONFLICT（409）に
 * する。同内容の公開でもキーを残すので、あとから別内容で再利用したら
 * 必ず検出できる。
 */
export interface ScenarioPublishKey {
  publish_idempotency_key: string;
  scenario_id: string;
  version_id: string;
  content_snapshot: string;
  created_at: string;
}

/**
 * 版に固定された通。`id` は版所有の通ID（`<版ID>:<通番>`）で、live の
 * scenario_steps.id ではない。配信の同一性・二重送信防止はこのIDで見る。
 * live 側のIDは履歴づけの控え（live_step_id）にだけ残す。通が消された
 * あとは null になることがある。配信の判断には使わない。
 */
export interface PinnedScenarioStep extends ScenarioStep {
  live_step_id: string | null;
  /** 公開時に確定した template。配信時に templates 表を読まない。 */
  template_id_at_send: string | null;
}

// ============================================================
// Scenario CRUD
// ============================================================

export type ScenarioWithStepCount = Scenario & { step_count: number };

export interface CreateScenarioInput {
  isActive?: boolean;
  name: string;
  description?: string | null;
  triggerType: ScenarioTriggerType;
  triggerTagId?: string | null;
  deliveryMode?: DeliveryMode;
  /** 他のシナリオと同時に動いてよいか。省略時は許す（従来どおり） */
  allowConcurrent?: boolean;
}

export type UpdateScenarioInput = Partial<
  Pick<
    Scenario,
    | 'name'
    | 'description'
    | 'trigger_type'
    | 'trigger_tag_id'
    | 'is_active'
    | 'allow_concurrent'
    | 'folder_id'
    /**
     * 配信方式。**通が1つでもあるときは変えない。**
     * 通の予定の持ち方（delay_minutes / offset_days / delivery_time）が
     * 方式ごとに違うので、あとから変えると予定の意味が変わる。
     * 呼ぶ側（worker）で通の数を見てから渡すこと。
     */
    | 'delivery_mode'
    /** シナリオ全体の配信対象（120）。 */
    | 'audience_condition_json'
    /** 最終コンテンツ配信後の処理（121/122）。 */
    | 'on_complete_mode'
    | 'on_complete_scenario_id'
  >
>;

/**
 * 終了後の移動先として `id` を指しているシナリオの一覧。
 *
 * 削除の確認窓で「どのシナリオの終了後の処理が変わるか」を見せるための
 * 読み取り。消す側の権限ではなく、見える範囲の名前だけ返す。
 */
export interface MoveReferrer {
  id: string;
  name: string;
  /** null = 全アカウント共通。窓側で権限の絞り込みに使う。 */
  lineAccountId: string | null;
}

// ============================================================
// Scenario Steps
// ============================================================

export interface CreateScenarioStepInput {
  scenarioId: string;
  stepOrder: number;
  delayMinutes?: number;
  messageType: MessageType;
  messageContent: string;
  conditionType?: string | null;
  conditionValue?: string | null;
  nextStepOnFalse?: number | null;
  offsetDays?: number | null;
  offsetMinutes?: number | null;
  deliveryTime?: string | null;
  templateId?: string | null;
  onReachTagId?: string | null;
  /** この通を送ったあと。'pause' なら次へ進めず止める。 */
  afterSend?: 'continue' | 'pause';
  /** 1通ごとの配信対象（124）。SegmentCondition の JSON。 */
  targetConditionJson?: string | null;
  /** 質問メッセージ（125）。ScenarioQuestion の JSON。 */
  questionJson?: string | null;
  /** 下書き（126）。 */
  isDraft?: boolean;
}

export type UpdateScenarioStepInput = Partial<
  Pick<
    ScenarioStep,
    | 'step_order'
    | 'delay_minutes'
    | 'message_type'
    | 'message_content'
    | 'condition_type'
    | 'condition_value'
    | 'next_step_on_false'
    | 'offset_days'
    | 'offset_minutes'
    | 'delivery_time'
    | 'template_id'
    | 'on_reach_tag_id'
    | 'after_send'
    | 'target_condition_json'
    | 'question_json'
    | 'is_draft'
  >
>;

export interface ScenarioActionSourceRow {
  id: string;
  scenario_id: string;
  hook: string;
  step_id: string | null;
  choice_index: number | null;
  sort_order: number;
  action_type: string;
  config_json: string;
  condition_json: string | null;
  repeat_on_refire: number;
}

/**
 * 版に固定されたアクション1件。実行側（worker）が読む形。
 * `id` は版所有のアクションID、`action_key` は「1回だけ」の鍵。
 */
export interface PinnedScenarioAction {
  id: string;
  action_key: string;
  scenario_id: string;
  hook: string;
  /** 版所有の通ID。通に紐づかないアクション（完了時など）は null。 */
  version_step_id: string | null;
  live_step_id: string | null;
  choice_index: number | null;
  sort_order: number;
  action_type: string;
  config_json: string;
  condition_json: string | null;
  repeat_on_refire: number;
}

// ============================================================
// 参照資源のアカウント境界
//
// テンプレート・タグ・遷移先シナリオを ID だけで読むと、よその LINE 公式
// アカウントの資源をシナリオへ混ぜられる。画面で選べないだけでは足りない
// （API を直接叩ける）ので、実行の直前に server 側で確かめる。
//
// 決まり: シナリオの line_account_id が NULL のときは共通シナリオとして
// 検証しない（従来どおり）。非 NULL のときは、資源側が NULL（共通）か
// 同じアカウントのときだけ通す。他アカウントの資源は使わない。
//
// 移行方針: 既存の不一致は migration で消さない（黙って運用が壊れる）。
// 実行時に拒否して警告を残し、次に公開した版の写しから外れていく。既存の
// 不一致は findScenarioReferenceMismatches で洗い出せる。
// ============================================================

/** アカウントで区切られる参照資源の種類。 */
export type AccountScopedResource = 'tag' | 'template' | 'scenario';

export interface ScenarioReferenceMismatch {
  scenarioId: string;
  scenarioAccountId: string | null;
  resource: AccountScopedResource;
  resourceId: string;
  resourceAccountId: string | null;
  /** どこから参照しているか（通・アクション・シナリオ本体）。 */
  origin: string;
}

export interface ScenarioActionReferenceIssue {
  /** config内の場所（tagIds[3] のような指し示し）。 */
  field: string;
  /** missing=幽霊 / cross-account=別アカウント（契約のない共通を含む）/ cross-tenant=別統括。 */
  reason: 'missing' | 'cross-account' | 'cross-tenant';
  message: string;
}

export type ActionReferenceCheck =
  | { ok: true }
  | { ok: false; issue: ScenarioActionReferenceIssue };

export interface ScenarioDeliverySource {
  deliveryMode: DeliveryMode;
  audienceConditionJson: string | null;
  onCompleteMode: string | null;
  onCompleteScenarioId: string | null;
  steps: PinnedScenarioStep[];
  /** 版に固定されたアクション設定。実行はこの写しから行う。 */
  actions: PinnedScenarioAction[];
  /** 購読開始時に固定した公開版。配信はこの版だけを読む。 */
  pinnedVersionId: string;
}
