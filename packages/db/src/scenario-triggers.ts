/*
 * シナリオの開始のきっかけ。
 *
 * これまで scenarios.trigger_type / trigger_tag_id で、1本につき1つしか
 * 持てなかった。「友だち追加でも始まるし、あとでタグが付いても始まる」を
 * 作れず、同じ内容のシナリオを複製することになっていた。
 *
 * 128 で scenario_triggers に切り出し、131 で既存の値を移してある。
 * ここは**読む側の入り口**。古い列は残してあるが、判断には使わない。
 * 2か所を見比べる作りにすると、片方だけ直したときに黙ってずれる。
 */
export type ScenarioTriggerKind = 'friend_add' | 'tag_added' | 'form_answer' | 'booking_confirmed';

export interface ScenarioTrigger {
  id: string;
  scenario_id: string;
  kind: ScenarioTriggerKind;
  /** kind が 'tag_added' のときだけ入る。 */
  tag_id: string | null;
  created_at: string;
}

/**
 * 友だち追加で始まるシナリオのIDを返す。
 *
 * 停止中（is_active = 0）は外す。きっかけがあっても止めているのだから、
 * 始めてはいけない。
 */
export async function getFriendAddScenarioIds(db: D1Database): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT st.scenario_id
         FROM scenario_triggers st
         JOIN scenarios s ON s.id = st.scenario_id
        WHERE st.kind = 'friend_add' AND s.is_active = 1`,
    )
    .all<{ scenario_id: string }>();
  return (rows.results ?? []).map((r) => r.scenario_id);
}

/** そのタグが付いたときに始まるシナリオのIDを返す。 */
export async function getTagAddedScenarioIds(
  db: D1Database,
  tagId: string,
): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT st.scenario_id
         FROM scenario_triggers st
         JOIN scenarios s ON s.id = st.scenario_id
        WHERE st.kind = 'tag_added' AND st.tag_id = ? AND s.is_active = 1`,
    )
    .bind(tagId)
    .all<{ scenario_id: string }>();
  return (rows.results ?? []).map((r) => r.scenario_id);
}

/**
 * そのタグが付いたときに始まる、指定アカウント向けのシナリオのIDだけを返す。
 *
 * 共通タグ（所属なし）はどのアカウントの友だちにも付けられるが、始めてよいのは
 * 友だちと同じアカウントのシナリオと、全体共通（所属なし）のシナリオだけ。
 * 別組織のシナリオが同じ共通タグをきっかけにしていても、ここで混ぜない。
 * 全体共通は友だち追加のきっかけと同じく「どの組織にも流れる」設計なので保つ。
 * 停止中は従来どおり外す。
 */
export async function getTagAddedScenarioIdsForAccount(
  db: D1Database,
  tagId: string,
  lineAccountId: string | null,
): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT st.scenario_id
         FROM scenario_triggers st
         JOIN scenarios s ON s.id = st.scenario_id
        WHERE st.kind = 'tag_added' AND st.tag_id = ?
          AND s.is_active = 1 AND (s.line_account_id = ? OR s.line_account_id IS NULL)`,
    )
    .bind(tagId, lineAccountId)
    .all<{ scenario_id: string }>();
  return (rows.results ?? []).map((r) => r.scenario_id);
}

/** 1本のシナリオに付いているきっかけを全部返す。画面用。 */
export async function getScenarioTriggers(
  db: D1Database,
  scenarioId: string,
): Promise<ScenarioTrigger[]> {
  const rows = await db
    .prepare(
      `SELECT id, scenario_id, kind, tag_id, created_at
         FROM scenario_triggers WHERE scenario_id = ?
        ORDER BY kind ASC, created_at ASC`,
    )
    .bind(scenarioId)
    .all<ScenarioTrigger>();
  return rows.results ?? [];
}

/**
 * きっかけを1つ足す。
 *
 * 同じものが既にあれば何もしない（部分UNIQUE索引が弾く）。二重に登録
 * できてしまうと、友だち追加のたびに同じシナリオを2回開始しようとする。
 */
export async function addScenarioTrigger(
  db: D1Database,
  scenarioId: string,
  kind: ScenarioTriggerKind,
  tagId: string | null,
): Promise<void> {
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO scenario_triggers (id, scenario_id, kind, tag_id)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), scenarioId, kind, kind === 'tag_added' ? tagId : null),
    db.prepare('UPDATE scenarios SET content_revision = content_revision + 1 WHERE id = ? AND changes() > 0').bind(scenarioId),
  ]);
}

export async function removeScenarioTrigger(
  db: D1Database,
  scenarioId: string,
  triggerId: string,
): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM scenario_triggers WHERE id = ? AND scenario_id = ?`).bind(triggerId, scenarioId),
    db.prepare('UPDATE scenarios SET content_revision = content_revision + 1 WHERE id = ? AND changes() > 0').bind(scenarioId),
  ]);
}
