import type { FriendScenarioStatus } from './scenarios/types/index.js';
export interface FriendScenario {
  id: string;
  confirmation_revision: number;
  friend_id: string;
  scenario_id: string;
  current_step_order: number;
  status: FriendScenarioStatus;
  started_at: string;
  next_delivery_at: string | null;
  /** 割り込む前に読んでいたシナリオ（123）。「1つ前のシナリオを再開」で使う。 */
  previous_scenario_id: string | null;
  /** 開始時に固定した公開版（351）。配信はこの版だけを読む。 */
  published_version_id: string | null;
  /**
   * なぜ止まっているか（432）。'manual'（画面からの停止）・'after_send'
   * （この通を送ったら止める設定）・'delivery_failed'（配信失敗）。
   * 止まっていない行・古い行は null。
   */
  pause_reason?: string | null;
  updated_at: string;
}
