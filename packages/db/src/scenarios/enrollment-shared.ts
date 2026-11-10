import type { FriendScenario } from '../friend-scenario-types.js';
import { jstNow } from '../utils.js';
import { type ScenarioDeliverySource, type ScenarioVersion, type DeliveryMode } from './types.js';
import { parseScenarioVersionSteps, parseScenarioVersionActions } from './snapshots.js';



/**
 * 配信が読む通と条件を1箇所で決める。購読に固定された公開版だけを読む。
 *
 * 版が無い（未公開）・版の行が見つからない（欠損参照）ときは null を返す。
 * live の下書き表へは戻らない。呼ぶ側は送らずに止める（購読の一時停止・
 * 再開の見送り）。下書きの編集中身が配信へ混入しないための安全停止。
 */
export async function getStepsForDelivery(
  db: D1Database,
  scenarioId: string,
  publishedVersionId: string | null,
): Promise<ScenarioDeliverySource | null> {
  if (!publishedVersionId) return null;
  const version = await db.prepare(
    `SELECT * FROM scenario_versions WHERE id = ? AND scenario_id = ?`,
  ).bind(publishedVersionId, scenarioId).first<ScenarioVersion>();
  if (!version) return null;
  return {
    deliveryMode: (version.delivery_mode ?? 'relative') as DeliveryMode,
    audienceConditionJson: version.audience_condition_json ?? null,
    onCompleteMode: version.on_complete_mode ?? null,
    onCompleteScenarioId: version.on_complete_scenario_id ?? null,
    steps: parseScenarioVersionSteps(version),
    actions: parseScenarioVersionActions(version),
    pinnedVersionId: version.id,
  };
}

export async function completeFriendScenario(
  db: D1Database,
  id: string,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE friend_scenarios
       SET confirmation_revision = confirmation_revision + 1, status = 'completed',
           next_delivery_at = NULL,
           pause_reason = NULL,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(now, id)
    .run();
}

/** 購読1件を ID で読む。友だち単位の操作の入口。 */
export async function getFriendScenarioById(
  db: D1Database,
  id: string,
): Promise<FriendScenario | null> {
  return db
    .prepare(`SELECT * FROM friend_scenarios WHERE id = ?`)
    .bind(id)
    .first<FriendScenario>();
}
