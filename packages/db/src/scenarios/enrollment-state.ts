import { jstCalendar as japanCalendar } from '@line-crm/shared';
import type { FriendScenario } from '../friend-scenario-types.js';
import { jstNow } from '../utils.js';
import { computeNextDeliveryAt } from '../scenario-schedule.js';
import { getStepsForDelivery, getFriendScenarioById } from './enrollment-shared.js';


/**
 * 送ったところで止める。
 *
 * 「送信後 一時停止」が付いた通を送ったあとに呼ぶ。次の配信日時を消して
 * status を paused にするので、時間が来ても勝手には進まない。人が再開すると
 * 止まった続きから流れる（current_step_order はそのまま残す）。
 */
export async function pauseFriendScenario(
  db: D1Database,
  id: string,
  atStepOrder: number,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE friend_scenarios
       SET confirmation_revision = confirmation_revision + 1, status = 'paused',
           pause_reason = 'after_send',
           current_step_order = ?,
           next_delivery_at = NULL,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(atStepOrder, now, id)
    .run();
}

/**
 * 前回読んだところから、同じシナリオを再開する（設計 V2 4-6「開始位置」）。
 *
 * `enrollFriendInScenario` は必ず `current_step_order = -1` の新しい行を作るので、
 * ブロックを解除した人にもう一度1通目から流れてしまう。ここは既にある行を
 * 生かして、続きから配信する。
 *
 * 進める先が無い（最後まで読み終えている）ときは `null` を返す。呼ぶ側で
 * 「送るものが無い」として扱う。既にある行が `active` のときも `null`
 * （もう流れているので、触ると二重配信になる）。
 */
export async function resumeFriendScenario(
  db: D1Database,
  friendId: string,
  scenarioId: string,
): Promise<FriendScenario | null> {
  const existing = await db
    .prepare(
      `SELECT * FROM friend_scenarios
        WHERE friend_id = ? AND scenario_id = ?
        ORDER BY started_at DESC
        LIMIT 1`,
    )
    .bind(friendId, scenarioId)
    .first<FriendScenario>();
  if (!existing) return null;
  return resumeExistingFriendScenario(db, existing);
}

/**
 * 既にある購読行を続きから動かす共通部品。
 *
 * active / delivering の行は null（もう流れている・送信中なので、触ると
 * 二重配信になる）。止まっているシナリオ・版が読めない購読・進める先が
 * 無い購読も null。
 */
export async function resumeExistingFriendScenario(
  db: D1Database,
  existing: FriendScenario,
): Promise<FriendScenario | null> {
  if (existing.status === 'active' || existing.status === 'delivering') return null;

  // 止めているシナリオは再開しない。起こすと cron が拾って配り始める。
  const scenarioState = await db.prepare(`SELECT is_active FROM scenarios WHERE id = ?`)
    .bind(existing.scenario_id)
    .first<{ is_active: number }>();
  if (!scenarioState || scenarioState.is_active === 0) return null;

  // 固定した版だけから次を探す（351）。版が無い・欠損しているときは
  // live の表へ戻らず見送る（null）。
  const source = await getStepsForDelivery(db, existing.scenario_id, existing.published_version_id ?? null);
  if (!source) return null;
  const nextStep = source.steps.find(s => s.step_order > existing.current_step_order);
  if (!nextStep) return null;

  const nowDate = japanCalendar();
  const nextDeliveryDate = computeNextDeliveryAt(
    { delivery_mode: source.deliveryMode },
    nextStep,
    { enrolledAt: nowDate, previousDeliveredAt: nowDate, now: nowDate },
  );
  const nextDeliveryAt = nextDeliveryDate.toISOString().slice(0, -1) + '+09:00';
  const now = jstNow();

  await db
    .prepare(
      `UPDATE friend_scenarios
          SET confirmation_revision = confirmation_revision + 1, status = 'active', next_delivery_at = ?, pause_reason = NULL, updated_at = ?
        WHERE id = ?`,
    )
    .bind(nextDeliveryAt, now, existing.id)
    .run();

  return (await db
    .prepare(`SELECT * FROM friend_scenarios WHERE id = ?`)
    .bind(existing.id)
    .first<FriendScenario>())!;
}

/**
 * 画面からの手動停止。
 *
 * 進行中（active）の購読だけを止める。送信中（delivering）はここでは
 * 触らない。直前に claim した配信が走っている最中に書き換えると、
 * advanceFriendScenario が paused を active へ戻して「止めたのに動く」
 * になるため、呼び出し側で delivering を断ってから呼ぶこと。
 *
 * @returns 状態を paused に変えられたら true。
 */
export async function pauseFriendScenarioManual(
  db: D1Database,
  id: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE friend_scenarios
          SET confirmation_revision = confirmation_revision + 1, status = 'paused',
              pause_reason = 'manual',
              next_delivery_at = NULL,
              updated_at = ?
        WHERE id = ? AND status = 'active'`,
    )
    .bind(jstNow(), id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * 止まっている購読1件を ID 指定で再開する。
 *
 * 画面は友だちではなく購読行を指して操作するため、friend_id + scenario_id
 * で「いちばん新しい行」を探す resumeFriendScenario とは別の入口が要る。
 * paused の行だけを受け付ける。active / delivering / completed は null。
 */
export async function resumeFriendScenarioById(
  db: D1Database,
  id: string,
): Promise<FriendScenario | null> {
  const existing = await getFriendScenarioById(db, id);
  if (!existing || existing.status !== 'paused') return null;
  return resumeExistingFriendScenario(db, existing);
}

/**
 * 配信失敗で止まった購読を、失敗した通からすぐ送り直す。
 *
 * pause_reason='delivery_failed' の paused 行だけを受け付ける。
 * 再開と違い、版の予定を計算し直さず next_delivery_at を「いま」に
 * 置く。cron が次の tick で拾い、失敗した通をもう一度組み立てて送る。
 *
 * @returns 再送待ちにできた購読。条件に合わない行は null。
 */
export async function retryFailedFriendScenario(
  db: D1Database,
  id: string,
): Promise<FriendScenario | null> {
  const now = jstNow();
  const result = await db
    .prepare(
      `UPDATE friend_scenarios
          SET confirmation_revision = confirmation_revision + 1, status = 'active',
              next_delivery_at = ?,
              pause_reason = NULL,
              updated_at = ?
        WHERE id = ? AND status = 'paused' AND pause_reason = 'delivery_failed'`,
    )
    .bind(now, now, id)
    .run();
  if ((result.meta.changes ?? 0) === 0) return null;
  return getFriendScenarioById(db, id);
}
