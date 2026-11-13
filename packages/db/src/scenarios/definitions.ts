import type { ScenarioStep } from '../scenario-step-types.js';
import { sqlIdSet } from '../id-queries.js';
import { removeConsumerReferences } from '../template-versions.js';
import { jstNow } from '../utils.js';
import { type ScenarioWithStepCount, type ScenarioWithSteps, type Scenario, type CreateScenarioInput, type UpdateScenarioInput, type MoveReferrer } from './types.js';


/**
 * 並び順をまとめて書く。
 *
 * 1件ずつ当てると、10件動かしたときに10往復する。その途中で誰かが一覧を
 * 開くと、半分だけ入れ替わった並びが見える。渡された順に 0,1,2… を振る。
 */
export async function reorderScenarios(db: D1Database, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.batch(
    ids.map((id, i) =>
      db.prepare(`UPDATE scenarios SET content_revision = content_revision + 1, display_order = ? WHERE id = ?`).bind(i, id),
    ),
  );
}

export async function getScenarios(db: D1Database): Promise<ScenarioWithStepCount[]> {
  const result = await db
    .prepare(
      `SELECT s.*, COUNT(ss.id) as step_count
       FROM scenarios s
       LEFT JOIN scenario_steps ss ON s.id = ss.scenario_id
       GROUP BY s.id
       ORDER BY s.created_at DESC`,
    )
    .all<ScenarioWithStepCount>();
  return result.results;
}

export async function getScenarioById(
  db: D1Database,
  id: string,
): Promise<ScenarioWithSteps | null> {
  const scenario = await db
    .prepare(`SELECT * FROM scenarios WHERE id = ?`)
    .bind(id)
    .first<Scenario>();

  if (!scenario) return null;

  const stepsResult = await db
    .prepare(
      `SELECT * FROM scenario_steps WHERE scenario_id = ? ORDER BY step_order ASC`,
    )
    .bind(id)
    .all<ScenarioStep>();

  return { ...scenario, steps: stepsResult.results };
}

export async function createScenario(
  db: D1Database,
  input: CreateScenarioInput,
): Promise<Scenario> {
  const id = crypto.randomUUID();
  const now = jstNow();

  await db
    .prepare(
      // allow_concurrent は必ず渡す。列の既定は 0 だが、それは
      // 「他のシナリオが動いていたら登録しない」という強い動きになる。
      // 既定は従来どおり「並行を許す」(1) にする。
      `INSERT INTO scenarios (id, name, description, trigger_type, trigger_tag_id, is_active, delivery_mode, allow_concurrent, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.name,
      input.description ?? null,
      input.triggerType,
      input.triggerTagId ?? null,
      input.isActive === false ? 0 : 1,
      input.deliveryMode ?? 'relative',
      input.allowConcurrent === false ? 0 : 1,
      now,
      now,
    )
    .run();

  return (await db
    .prepare(`SELECT * FROM scenarios WHERE id = ?`)
    .bind(id)
    .first<Scenario>())!;
}

export async function updateScenario(
  db: D1Database,
  id: string,
  updates: UpdateScenarioInput,
  options?: { stop?: { reason: string | null; staffId: string }; expectedRevision?: number; expectedSubscriptions?: { activeCount: number; rowIdSum: number; rowIdSquareSum: number }; accountScope?: { accountIds: string[]; canSeeUnassigned: boolean } },
): Promise<Scenario | null> {
  const now = jstNow();
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    fields.push('description = ?');
    values.push(updates.description);
  }
  if (updates.trigger_type !== undefined) {
    fields.push('trigger_type = ?');
    values.push(updates.trigger_type);
  }
  if (updates.allow_concurrent !== undefined) {
    fields.push('allow_concurrent = ?');
    values.push(updates.allow_concurrent);
  }
  if (updates.trigger_tag_id !== undefined) {
    fields.push('trigger_tag_id = ?');
    values.push(updates.trigger_tag_id);
  }
  if (updates.is_active !== undefined) {
    fields.push('is_active = ?');
    values.push(updates.is_active);
  }
  if (updates.is_active === 0 && options?.stop) {
    // 同じ UPDATE 内の変更前の状態で判定する。二重クリックや同時停止で
    // 最初の停止記録を上書きせず、次に再開して止めたときだけ更新する。
    for (const [column, value] of [
      ['stopped_reason', options.stop.reason],
      ['stopped_by', options.stop.staffId],
      ['stopped_at', now],
    ] as const) {
      fields.push(`${column} = CASE WHEN is_active = 1 THEN ? ELSE ${column} END`);
      values.push(value);
    }
  }
  if (updates.folder_id !== undefined) {
    fields.push('folder_id = ?');
    values.push(updates.folder_id);
  }
  if (updates.delivery_mode !== undefined) {
    fields.push('delivery_mode = ?');
    values.push(updates.delivery_mode);
  }
  if (updates.audience_condition_json !== undefined) {
    fields.push('audience_condition_json = ?');
    values.push(updates.audience_condition_json);
  }
  if (updates.on_complete_mode !== undefined) {
    fields.push('on_complete_mode = ?');
    values.push(updates.on_complete_mode);
  }
  if (updates.on_complete_scenario_id !== undefined) {
    fields.push('on_complete_scenario_id = ?');
    values.push(updates.on_complete_scenario_id);
  }

  if (fields.length === 0) {
    return db
      .prepare(`SELECT * FROM scenarios WHERE id = ?`)
      .bind(id)
      .first<Scenario>();
  }

  fields.push('content_revision = content_revision + 1', 'updated_at = ?');
  values.push(now);
  values.push(id);

  // 複数の購読が同時に入れ替わると、3つの集計が偶然一致する可能性がある。
  // 最後の行が削除されると rowid が再利用され、入れ替わりを検知できない場合がある。
  const expected = options?.expectedSubscriptions;
  const updated = await db
    .prepare(`UPDATE scenarios SET ${fields.join(', ')}
      WHERE id = ? AND (? IS NULL OR content_revision = ?)
      AND (? IS NULL OR ((SELECT COUNT(*) FROM friend_scenarios WHERE scenario_id=scenarios.id AND status IN ('active','delivering'))=?
        AND (SELECT COALESCE(SUM(rowid),0) FROM friend_scenarios WHERE scenario_id=scenarios.id AND status IN ('active','delivering'))=?
        AND (SELECT COALESCE(SUM((rowid % 104729) * (rowid % 104729)),0) FROM friend_scenarios WHERE scenario_id=scenarios.id AND status IN ('active','delivering'))=?))
      AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM friend_scenarios fs LEFT JOIN friends f ON f.id=fs.friend_id WHERE fs.scenario_id=scenarios.id AND (f.id IS NULL OR (f.line_account_id IS NULL AND ?=0) OR (f.line_account_id IS NOT NULL AND f.line_account_id NOT IN (SELECT value FROM json_each(?))))))` )
    .bind(...values, options?.expectedRevision ?? null, options?.expectedRevision ?? null, expected?.activeCount ?? null, expected?.activeCount ?? null, expected?.rowIdSum ?? null, expected?.rowIdSquareSum ?? null, options?.accountScope ? 1 : null, options?.accountScope?.canSeeUnassigned ? 1 : 0, JSON.stringify(options?.accountScope?.accountIds ?? []))
    .run();
  if (!updated.meta.changes && (options?.expectedRevision !== undefined || expected !== undefined || options?.accountScope !== undefined)) throw new Error('SCENARIO_CONFIRMATION_CONFLICT');

  return db
    .prepare(`SELECT * FROM scenarios WHERE id = ?`)
    .bind(id)
    .first<Scenario>();
}

/**
 * シナリオの親削除。親子削除と全参照解除を1回の batch（原子）で行う。
 *
 * - 他の機能から参照されている（アフィリエイト案件の completion 連携など）
 *   ときは黙って切らず SCENARIO_HAS_DEPENDENTS（409）にする。勝手に
 *   切ると報酬の支払い条件が静かに壊れる。
 * - 版の削除禁止トリガーは「親が残っている間の削除」だけを止めるので、
 *   親の DELETE を先頭に置く。外部キー制約が有効な環境では親削除で
 *   CASCADE/SET NULL が走り、無効な環境では残るので後段で明示削除・
 *   参照解除する。どちらでも同じ終状態になり、500 にならない。
 * - 参照解除（entry_routes / tracked_links / forms の送信後シナリオ・
 *   他シナリオ完了時の遷移先）も同じ batch に入れる。FK OFF の環境では
 *   CASCADE も SET NULL も走らないので、明示で NULL に寄せる。
 * - 他シナリオ完了時の遷移先は、移動先だけを NULL にしない。
 *   mode='move' のまま target だけ空になると、通常の保存では作れない
 *   「移動先のない移動」が残り、運用者は気づけない。削除と同時に
 *   mode='pause'（何もしない）へ戻し、整合した設定にする。削除の確認窓で
 *   参照元の名前を見せてから消す（窓側の役目）。
 */
export async function deleteScenario(db: D1Database, id: string, confirmation?: { expectedRevision: number; expectedSubscriptions: { activeCount: number; rowIdSum: number; rowIdSquareSum: number }; expectedActiveSubscriptions?: { activeCount: number; rowIdSum: number; rowIdSquareSum: number }; expectedReferrers: Array<{ id: string; revision: number }>; accountIds?: string[]; canSeeUnassigned?: boolean }): Promise<void> {
  const dependent = await db.prepare(
    `SELECT id FROM affiliate_offers WHERE scenario_id = ? LIMIT 1`,
  ).bind(id).first<{ id: string }>();
  if (dependent) throw new Error('SCENARIO_HAS_DEPENDENTS');

  /*
   * 参照元は消す前に押さえる。外部キーが有効な環境では親 DELETE の
   * 時点で SET NULL が走り、あとの `WHERE on_complete_scenario_id = ?` が
   * 誰にも当たらなくなる。ID 指定ならどちらの環境でも同じ終状態になる。
   */
  const referrers = await db.prepare(
    `SELECT id FROM scenarios WHERE on_complete_scenario_id = ?`,
  ).bind(id).all<{ id: string }>();
  const referrerIds = confirmation ? confirmation.expectedReferrers.map(row => row.id) : referrers.results.map((row) => row.id);

  const expected = confirmation?.expectedSubscriptions;
  const expectedActive = confirmation?.expectedActiveSubscriptions;
  const expectedReferrers = confirmation ? JSON.stringify(confirmation.expectedReferrers) : null;
  try { await db.batch([
    confirmation ? db.prepare(`DELETE FROM scenarios WHERE id=? AND content_revision=?
      AND (SELECT COUNT(*) FROM friend_scenarios WHERE scenario_id=scenarios.id)=?
      AND (SELECT COALESCE(SUM(rowid),0) FROM friend_scenarios WHERE scenario_id=scenarios.id)=?
        AND (SELECT COALESCE(SUM((rowid % 104729) * (rowid % 104729)),0) FROM friend_scenarios WHERE scenario_id=scenarios.id)=?
      AND (? IS NULL OR ((SELECT COUNT(*) FROM friend_scenarios WHERE scenario_id=scenarios.id AND status IN ('active','delivering'))=?
        AND (SELECT COALESCE(SUM(rowid),0) FROM friend_scenarios WHERE scenario_id=scenarios.id AND status IN ('active','delivering'))=?
        AND (SELECT COALESCE(SUM((rowid % 104729) * (rowid % 104729)),0) FROM friend_scenarios WHERE scenario_id=scenarios.id AND status IN ('active','delivering'))=?))
      AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM friend_scenarios fs LEFT JOIN friends f ON f.id=fs.friend_id WHERE fs.scenario_id=scenarios.id AND (f.id IS NULL OR (f.line_account_id IS NULL AND ?=0) OR (f.line_account_id IS NOT NULL AND f.line_account_id NOT IN (SELECT value FROM json_each(?))))))
      AND (SELECT COUNT(*) FROM scenarios ref WHERE ref.on_complete_scenario_id=scenarios.id)=json_array_length(?)
      AND NOT EXISTS (SELECT 1 FROM scenarios ref WHERE ref.on_complete_scenario_id=scenarios.id
        AND NOT EXISTS (SELECT 1 FROM json_each(?) expected WHERE json_extract(expected.value,'$.id')=ref.id
          AND json_extract(expected.value,'$.revision')=ref.content_revision))`)
      .bind(id, confirmation.expectedRevision, expected!.activeCount, expected!.rowIdSum, expected!.rowIdSquareSum, expectedActive?.activeCount ?? null, expectedActive?.activeCount ?? null, expectedActive?.rowIdSum ?? null, expectedActive?.rowIdSquareSum ?? null, confirmation.accountIds ? 1 : null, confirmation.canSeeUnassigned ? 1 : 0, JSON.stringify(confirmation.accountIds ?? []), expectedReferrers, expectedReferrers)
      : db.prepare(`DELETE FROM scenarios WHERE id = ?`).bind(id),
    ...(confirmation ? [db.prepare(`SELECT json(CASE WHEN changes()=1 THEN 'true' ELSE 'scenario_delete_conflict' END)`)] : []),
    db.prepare(`DELETE FROM scenario_publish_keys WHERE scenario_id = ?`).bind(id),
    db.prepare(`DELETE FROM scenario_versions WHERE scenario_id = ?`).bind(id),
    db.prepare(
      `DELETE FROM scenario_action_fires WHERE action_id IN (
         SELECT a.id FROM scenario_actions a WHERE a.scenario_id = ?
       )`,
    ).bind(id),
    db.prepare(`DELETE FROM scenario_actions WHERE scenario_id = ?`).bind(id),
    db.prepare(
      `UPDATE messages_log SET scenario_step_id = NULL
        WHERE scenario_step_id IN (SELECT id FROM scenario_steps WHERE scenario_id = ?)`,
    ).bind(id),
    db.prepare(`DELETE FROM scenario_steps WHERE scenario_id = ?`).bind(id),
    db.prepare(`DELETE FROM friend_scenarios WHERE scenario_id = ?`).bind(id),
    db.prepare(`DELETE FROM scenario_triggers WHERE scenario_id = ?`).bind(id),
    db.prepare(`DELETE FROM scenario_drafts WHERE scenario_id = ?`).bind(id),
    db.prepare(`UPDATE entry_routes SET scenario_id = NULL WHERE scenario_id = ?`).bind(id),
    db.prepare(`UPDATE tracked_links SET scenario_id = NULL WHERE scenario_id = ?`).bind(id),
    db.prepare(`UPDATE forms SET on_submit_scenario_id = NULL WHERE on_submit_scenario_id = ?`).bind(id),
    ...(referrerIds.length > 0
      ? [
        db.prepare(
          `UPDATE scenarios SET content_revision = content_revision + 1, on_complete_mode = 'pause', on_complete_scenario_id = NULL WHERE id IN (${sqlIdSet(referrerIds).sql})`,
        ).bind(...(referrerIds.length ? sqlIdSet(referrerIds).binds : [])),
      ]
      : []),
  ]); } catch (error) {
    if (confirmation && String(error).includes('malformed JSON')) throw new Error('SCENARIO_CONFIRMATION_CONFLICT');
    throw error;
  }
  // 467: 消えたシナリオの参照を消す。残すと削除の止めが誤作動する。
  await removeConsumerReferences(db, 'scenario', id);
}

export async function listMoveReferrers(
  db: D1Database,
  id: string,
): Promise<MoveReferrer[]> {
  const result = await db
    .prepare(
      `SELECT id, name, line_account_id FROM scenarios WHERE on_complete_scenario_id = ? ORDER BY name`,
    )
    .bind(id)
    .all<{ id: string; name: string; line_account_id: string | null }>();
  return result.results.map((row) => ({
    id: row.id,
    name: row.name,
    lineAccountId: row.line_account_id ?? null,
  }));
}
