import { jstCalendar as japanCalendar } from '@line-crm/shared';
import type { FriendScenario } from '../friend-scenario-types.js';
import { jstNow } from '../utils.js';
import { computeNextDeliveryAt } from '../scenario-schedule.js';
import { type DeliveryMode } from './types.js';
import { parseScenarioVersionSteps, getScenarioPublishedVersion } from './snapshots.js';
import { getFriendScenarioById, completeFriendScenario } from './enrollment-shared.js';


/**
 * live の通がまだ残っているか。配信ログの scenario_step_id には、残って
 * いるときだけ live の通IDを入れ、消されたあとは NULL にする（外部キー
 * を壊さない）。ダッシュボードの集計は残っている分だけ付く。
 */
export async function scenarioStepExists(db: D1Database, stepId: string | null): Promise<boolean> {
  if (!stepId) return false;
  const row = await db.prepare(`SELECT 1 AS ok FROM scenario_steps WHERE id = ?`)
    .bind(stepId)
    .first<{ ok: number }>();
  return row !== null;
}

// ============================================================
// Friend Scenario Enrollments
// ============================================================

export async function enrollFriendInScenario(
  db: D1Database,
  friendId: string,
  scenarioId: string,
  sourceEnrollmentId?: string,
  options: { replacingScenarioId?: string | null; move?: { id: string; revision: number; status: string } } = {},
): Promise<FriendScenario | null> {
  const id = sourceEnrollmentId ?? crypto.randomUUID();
  if (sourceEnrollmentId) {
    const previous = await db.prepare(`SELECT * FROM friend_scenarios WHERE id=? AND friend_id=? AND scenario_id=?`)
      .bind(id, friendId, scenarioId).first<FriendScenario>();
    if (previous) return previous;
  }
  const now = jstNow();

  // delivery_mode を取得（migration 037 適用前の DB では 'relative' が DEFAULT で既に入っている）
  const scenarioRow = await db
    .prepare(`SELECT delivery_mode, allow_concurrent, is_active FROM scenarios WHERE id = ?`)
    .bind(scenarioId)
    .first<{ delivery_mode: DeliveryMode; allow_concurrent: number | null; is_active: number }>();
  if (!scenarioRow) return null;

  // 止めているシナリオは受け付けない。cron も止めたシナリオには配らないので、
  // ここで購読だけ作ると「入ったのに届かない」行が残る。
  if (scenarioRow.is_active === 0) return null;

  // 重複は副作用の前に弾く。版の読み・予定計算の前に返すので、重複登録の
  // たびに公開側の状態を触らない。
  //
  // null を返す。例外にしないのは、呼び出し口が「友だち追加」や
  // 「タグが付いた」といった副作用の中にあり、そこで throw すると
  // 本来の処理まで巻き添えで失敗するため。
  const duplicate = await db
    .prepare(
      `SELECT id FROM friend_scenarios
        WHERE friend_id = ? AND scenario_id = ? AND status != 'completed'
        LIMIT 1`,
    )
    .bind(friendId, scenarioId)
    .first<{ id: string }>();
  if (duplicate) return null;

  // 並行を許さないシナリオは、他のシナリオが動いている人には登録しない。
  //
  // 既定は「許す」（104 で既存の行を 1 に寄せ、作成時も 1 を渡す）。
  // ここを既定で塞ぐと、いま複数のシナリオに入っている人への配信が
  // 止まってしまう。止めたい人だけが画面から 0 にする。
  //
  // 同じシナリオへの二重登録は、上の重複検査と部分UNIQUE索引が防いでいる
  // （idx_friend_scenarios_unique）。ここで見るのは「他のシナリオ」だけ。
  if (scenarioRow.allow_concurrent === 0) {
    const other = await db
      .prepare(
        `SELECT 1 FROM friend_scenarios
          WHERE friend_id = ? AND scenario_id != ? AND status = 'active'
            AND (? IS NULL OR scenario_id != ?)
          LIMIT 1`,
      )
      .bind(friendId, scenarioId, options.replacingScenarioId ?? null, options.replacingScenarioId ?? null)
      .first<{ 1: number }>();
    if (other) return null;
  }

  // 開始時の公開版へ固定する（351）。明示公開された版だけを選び、未公開の
  // 下書きを自動公開しない。未公開のときは受け付けない（null）。
  const version = await getScenarioPublishedVersion(db, scenarioId);
  if (!version) return null;
  const pinnedSteps = parseScenarioVersionSteps(version).filter((s) => (s.is_draft ?? 0) === 0);
  const firstStep = pinnedSteps.length > 0 ? pinnedSteps[0] : null;
  // Check again in the write itself. Two starts can both pass the earlier read.
  const admissionSql = `EXISTS (
    SELECT 1 FROM scenarios s WHERE s.id = ? AND s.is_active != 0
      AND (s.allow_concurrent IS NOT 0 OR NOT EXISTS (
        SELECT 1 FROM friend_scenarios other
         WHERE other.friend_id = ? AND other.scenario_id != ? AND other.status = 'active'
           AND (? IS NULL OR other.scenario_id != ?)
      ))
  )`;
  const admissionBinds = [scenarioId, friendId, scenarioId, options.replacingScenarioId ?? null, options.replacingScenarioId ?? null];
  const publishedGuard = options.move ? ' AND EXISTS (SELECT 1 FROM scenarios WHERE id=? AND current_published_version_id=?)' : '';
  const publishedBinds = options.move ? [scenarioId,version.id] : [];
  const save = async (insert: D1PreparedStatement): Promise<boolean> => {
    if (!options.move) return Boolean((await insert.run()).meta.changes);
    try {
      const results = await db.batch([
        db.prepare(`UPDATE friend_scenarios SET confirmation_revision=confirmation_revision+1,status='completed',next_delivery_at=NULL,pause_reason=NULL,updated_at=?
          WHERE id=? AND friend_id=? AND confirmation_revision=? AND status=? AND status NOT IN ('completed','delivering')`)
          .bind(now,options.move.id,friendId,options.move.revision,options.move.status),
        db.prepare("SELECT json(CASE WHEN changes()=1 THEN '{}' ELSE 'SCENARIO_MOVE_CONFLICT' END)"),
        insert,
        db.prepare("SELECT json(CASE WHEN changes()=1 THEN '{}' ELSE 'SCENARIO_MOVE_CONFLICT' END)"),
      ]);
      return Boolean(results[2].meta.changes);
    } catch (error) {
      if (/malformed JSON|UNIQUE constraint/i.test(String(error))) return false;
      throw error;
    }
  };

  // A scenario with no steps is immediately completed — no stuck active enrollment.
  if (!firstStep) {
    const insert = db
      .prepare(
        `INSERT OR IGNORE INTO friend_scenarios (id, friend_id, scenario_id, current_step_order, status, started_at, next_delivery_at, published_version_id, updated_at)
         SELECT ?, ?, ?, 0, 'completed', ?, NULL, ?, ? WHERE ${admissionSql}${publishedGuard}`,
      )
      .bind(id, friendId, scenarioId, now, version.id, now, ...admissionBinds, ...publishedBinds);

    if (!await save(insert)) return null;

    return (await db
      .prepare(`SELECT * FROM friend_scenarios WHERE id = ?`)
      .bind(id)
      .first<FriendScenario>())!;
  }

  const enrolledAtDate = japanCalendar();
  // 予定の組み立ては固定した版の値で行う。開始後に配信方式を変えても、
  // 既存の購読の予定は変わらない。
  const nextDeliveryDate = computeNextDeliveryAt(
    { delivery_mode: (version.delivery_mode ?? 'relative') as DeliveryMode },
    firstStep,
    { enrolledAt: enrolledAtDate, previousDeliveredAt: enrolledAtDate, now: enrolledAtDate },
  );
  const nextDeliveryAt = nextDeliveryDate.toISOString().slice(0, -1) + '+09:00';

  // current_step_order is initialized to -1 (NOT 0) so that the step-delivery
  // service's `steps.find(s => s.step_order > fs.current_step_order)` lookup
  // matches the very first step (step_order=0).
  // If we initialize to 0, scenarios that only have a step_order=0 step are
  // silently completed without delivering anything (because no step has
  // step_order > 0).
  const insert = db
    .prepare(
      `INSERT OR IGNORE INTO friend_scenarios (id, friend_id, scenario_id, current_step_order, status, started_at, next_delivery_at, published_version_id, updated_at)
       SELECT ?, ?, ?, -1, 'active', ?, ?, ?, ? WHERE ${admissionSql}${publishedGuard}`,
    )
    .bind(id, friendId, scenarioId, now, nextDeliveryAt, version.id, now, ...admissionBinds, ...publishedBinds);

  if (!await save(insert)) return null;

  return (await db
    .prepare(`SELECT * FROM friend_scenarios WHERE id = ?`)
    .bind(id)
    .first<FriendScenario>())!;
}

/**
 * 購読を別のシナリオへ移す（機能05「友だちごとの移動」）。
 *
 * いまの購読を completed に閉じ、移し先へ新しい購読を作る。先に移し先へ
 * 登録してから元を閉じるので、移し先が受け付けない（停止中・未公開・
 * すでに入っている・並行を許さない）ときは元の購読はそのまま残る。
 *
 * 送信中（delivering）の行はここでは動かさない。claim 済みの配信が
 * 走っている最中に閉じると結果の書き戻しとぶつかるため、呼び出し側で
 * delivering を断ってから呼ぶこと。
 *
 * @returns 移し先で新しくできた購読。条件に合わないときは null。
 */
export async function moveFriendScenarioTo(
  db: D1Database,
  id: string,
  targetScenarioId: string,
  expected?: { revision: number; status: string },
): Promise<FriendScenario | null> {
  const current = await getFriendScenarioById(db, id);
  if (!current) return null;
  if (current.status === 'completed' || current.status === 'delivering') return null;
  if (current.scenario_id === targetScenarioId) return null;

  // 移し先が受け付けないなら元は残す（null）。理由の区別は呼び出し側で
  // 移し先シナリオの状態を見て返す。
  const moved = await enrollFriendInScenario(db, current.friend_id, targetScenarioId, undefined, expected ? { move: { id, ...expected } } : {});
  if (!moved) return null;
  if (!expected) await completeFriendScenario(db, id);
  return moved;
}
