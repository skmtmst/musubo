import { jstCalendar as japanCalendar } from '@line-crm/shared';
import type { FriendScenario } from '../friend-scenario-types.js';
import { accountFeatureOffExclusionSql } from '../account-settings.js';
import { jstNow } from '../utils.js';
import { buildFriendScenariosDueForDeliveryQuery, normalizeScenarioDeliveryTimestamp, SCENARIO_DELIVERY_BATCH_LIMIT } from '../scenario-delivery-timestamps.js';


export async function getFriendScenariosDueForDelivery(
  db: D1Database,
  now: string,
  limit = SCENARIO_DELIVERY_BATCH_LIMIT,
  scenarioId?: string,
): Promise<FriendScenario[]> {
  const dueBefore = normalizeScenarioDeliveryTimestamp(now);
  if (dueBefore === null) throw new Error(`Invalid due-delivery timestamp: ${now}`);
  const batchLimit = Math.max(1, Math.floor(limit));
  const query = buildFriendScenariosDueForDeliveryQuery(scenarioId !== undefined);
  const result = await db
    .prepare(query)
    .bind(...(scenarioId === undefined
      ? [dueBefore, batchLimit]
      : [dueBefore, scenarioId, batchLimit]))
    .all<FriendScenario>();
  return result.results;
}

/**
 * Optimistic lock: claim a friend_scenario for delivery.
 * Only succeeds if status='active' and current_step_order matches.
 * Returns true if claimed, false if another worker already processed it.
 */
export async function claimFriendScenarioForDelivery(
  db: D1Database,
  id: string,
  expectedStepOrder: number,
): Promise<boolean> {
  const now = jstNow();
  const result = await db
    .prepare(
      `UPDATE friend_scenarios
       SET confirmation_revision = confirmation_revision + 1, status = 'delivering', updated_at = ?
       WHERE id = ? AND status = 'active' AND current_step_order = ?`,
    )
    .bind(now, id, expectedStepOrder)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Crash recovery: reset friend_scenarios stuck in 'delivering' for over 5 minutes back to 'active'.
 */
export async function recoverStuckDeliveries(db: D1Database): Promise<number> {
  const fiveMinAgo = japanCalendar(new Date(Date.now() - 5 * 60_000));
  const threshold = fiveMinAgo.toISOString().slice(0, -1) + '+09:00';
  // 機能オフ中のアカウントの行は回収しない。OFF中は status も updated_at も
  // 動かさず delivering のまま残し、再オンの tick で回収する。
  const result = await db
    .prepare(
      `UPDATE friend_scenarios SET confirmation_revision = confirmation_revision + 1, status = 'active', updated_at = ?
       WHERE status = 'delivering' AND updated_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM scenarios s
            WHERE s.id = friend_scenarios.scenario_id
              AND ${accountFeatureOffExclusionSql('s.line_account_id', 'scenarios')}
         )`,
    )
    .bind(jstNow(), threshold)
    .run();
  return result.meta.changes ?? 0;
}

/**
 * Stop a claimed delivery without losing its enrollment state.
 * Used for permanent recipient/payload failures and for account-bound
 * scenarios that do not have a safe destination friend for that account.
 *
 * pause_reason='delivery_failed' を残す。画面はこれを見て「再開」ではなく
 * 「失敗を再送」を出す（migration 432）。
 */
export async function pauseFriendScenarioDelivery(
  db: D1Database,
  id: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE friend_scenarios
          SET confirmation_revision = confirmation_revision + 1, status = 'paused', pause_reason = 'delivery_failed', updated_at = ?
       WHERE id = ? AND status = 'delivering'`,
    )
    .bind(jstNow(), id)
    .run();
}

export async function advanceFriendScenario(
  db: D1Database,
  id: string,
  nextStepOrder: number,
  nextDeliveryAt?: string | null,
): Promise<void> {
  const now = jstNow();
  const normalizedNextDeliveryAt = nextDeliveryAt
    ? normalizeScenarioDeliveryTimestamp(nextDeliveryAt)
    : null;
  if (nextDeliveryAt && normalizedNextDeliveryAt === null) {
    throw new Error(`Invalid scenario delivery timestamp: ${nextDeliveryAt}`);
  }
  await db
    .prepare(
      `UPDATE friend_scenarios
       SET confirmation_revision = confirmation_revision + 1, current_step_order = ?,
           next_delivery_at = ?,
           status = 'active',
           pause_reason = NULL,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(nextStepOrder, normalizedNextDeliveryAt, now, id)
    .run();
}
