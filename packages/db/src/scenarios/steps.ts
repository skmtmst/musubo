import type { ScenarioStep } from '../scenario-step-types.js';
import { refreshScenarioReferences } from '../template-versions.js';
import { jstNow } from '../utils.js';
import { type CreateScenarioStepInput, type UpdateScenarioStepInput } from './types.js';


export async function createScenarioStep(
  db: D1Database,
  input: CreateScenarioStepInput,
): Promise<ScenarioStep> {
  const id = crypto.randomUUID();
  const now = jstNow();

  const insert = db
    .prepare(
      `INSERT INTO scenario_steps
       (id, scenario_id, step_order, delay_minutes, message_type, message_content,
        condition_type, condition_value, next_step_on_false,
        offset_days, offset_minutes, delivery_time,
        template_id, on_reach_tag_id, after_send,
        target_condition_json, question_json, is_draft,
        created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.scenarioId,
      input.stepOrder,
      input.delayMinutes ?? 0,
      input.messageType,
      input.messageContent,
      input.conditionType ?? null,
      input.conditionValue ?? null,
      input.nextStepOnFalse ?? null,
      input.offsetDays ?? null,
      input.offsetMinutes ?? null,
      input.deliveryTime ?? null,
      input.templateId ?? null,
      input.onReachTagId ?? null,
      input.afterSend ?? 'continue',
      input.targetConditionJson ?? null,
      input.questionJson ?? null,
      input.isDraft ? 1 : 0,
      now,
    );
  await db.batch([insert, db.prepare('UPDATE scenarios SET content_revision = content_revision + 1 WHERE id = ? AND changes() > 0').bind(input.scenarioId)]);

  const created = (await db
    .prepare(`SELECT * FROM scenario_steps WHERE id = ?`)
    .bind(id)
    .first<ScenarioStep>())!;
  // 467: 手順の保存で参照表を書き換える。どの版を使っているかの正本。
  await refreshScenarioReferences(db, created.scenario_id);
  return created;
}

export async function updateScenarioStep(
  db: D1Database,
  id: string,
  updates: UpdateScenarioStepInput,
): Promise<ScenarioStep | null> {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.step_order !== undefined) {
    fields.push('step_order = ?');
    values.push(updates.step_order);
  }
  if (updates.delay_minutes !== undefined) {
    fields.push('delay_minutes = ?');
    values.push(updates.delay_minutes);
  }
  if (updates.message_type !== undefined) {
    fields.push('message_type = ?');
    values.push(updates.message_type);
  }
  if (updates.message_content !== undefined) {
    fields.push('message_content = ?');
    values.push(updates.message_content);
  }
  if (updates.condition_type !== undefined) {
    fields.push('condition_type = ?');
    values.push(updates.condition_type);
  }
  if (updates.condition_value !== undefined) {
    fields.push('condition_value = ?');
    values.push(updates.condition_value);
  }
  if (updates.next_step_on_false !== undefined) {
    fields.push('next_step_on_false = ?');
    values.push(updates.next_step_on_false);
  }
  if (updates.offset_days !== undefined) {
    fields.push('offset_days = ?');
    values.push(updates.offset_days);
  }
  if (updates.offset_minutes !== undefined) {
    fields.push('offset_minutes = ?');
    values.push(updates.offset_minutes);
  }
  if (updates.delivery_time !== undefined) {
    fields.push('delivery_time = ?');
    values.push(updates.delivery_time);
  }
  if (updates.template_id !== undefined) {
    fields.push('template_id = ?');
    values.push(updates.template_id);
  }
  if (updates.on_reach_tag_id !== undefined) {
    fields.push('on_reach_tag_id = ?');
    values.push(updates.on_reach_tag_id);
  }
  /*
   * after_send は型には並んでいたが、ここで拾っていなかった。
   * 作成時だけ効いて、編集では黙って捨てられていた（＝画面で
   * 「送信後に一時停止」を外しても元に戻らない）。
   */
  if (updates.after_send !== undefined) {
    fields.push('after_send = ?');
    values.push(updates.after_send);
  }
  if (updates.target_condition_json !== undefined) {
    fields.push('target_condition_json = ?');
    values.push(updates.target_condition_json);
  }
  if (updates.question_json !== undefined) {
    fields.push('question_json = ?');
    values.push(updates.question_json);
  }
  if (updates.is_draft !== undefined) {
    fields.push('is_draft = ?');
    values.push(updates.is_draft);
  }

  if (fields.length > 0) {
    values.push(id);
    await db.batch([
      db.prepare(`UPDATE scenario_steps SET ${fields.join(', ')} WHERE id = ?`).bind(...values),
      db.prepare('UPDATE scenarios SET content_revision = content_revision + 1 WHERE id = (SELECT scenario_id FROM scenario_steps WHERE id = ?) AND changes() > 0').bind(id),
    ]);
  }

  const updated = await db
    .prepare(`SELECT * FROM scenario_steps WHERE id = ?`)
    .bind(id)
    .first<ScenarioStep>();
  // 467: 手順の保存で参照表を書き換える。消えた手順の参照はここで消える。
  if (updated) await refreshScenarioReferences(db, updated.scenario_id);
  return updated;
}

export async function deleteScenarioStep(db: D1Database, id: string, confirmation?: { scenarioId: string; expectedRevision: number }): Promise<void> {
  const target = await db
    .prepare(`SELECT scenario_id FROM scenario_steps WHERE id = ?`)
    .bind(id)
    .first<{ scenario_id: string }>();
  if (confirmation) {
    try {
      await db.batch([
        db.prepare(`DELETE FROM scenario_steps WHERE id=? AND scenario_id=?
          AND EXISTS(SELECT 1 FROM scenarios WHERE id=? AND content_revision=?)`)
          .bind(id, confirmation.scenarioId, confirmation.scenarioId, confirmation.expectedRevision),
        db.prepare(`SELECT json(CASE WHEN changes()=1 THEN 'true' ELSE 'scenario_step_conflict' END)`),
        db.prepare(`UPDATE scenarios SET content_revision=content_revision+1 WHERE id=?`).bind(confirmation.scenarioId),
      ]);
    } catch (error) {
      if (String(error).includes('malformed JSON')) throw new Error('SCENARIO_CONFIRMATION_CONFLICT');
      throw error;
    }
  } else {
    await db.batch([
      db.prepare(`UPDATE scenarios SET content_revision = content_revision + 1
        WHERE id = (SELECT scenario_id FROM scenario_steps WHERE id = ?)`).bind(id),
      db.prepare(`DELETE FROM scenario_steps WHERE id = ?`).bind(id),
    ]);
  }
  // 467: 消えた手順の参照を数え直す。
  if (target) await refreshScenarioReferences(db, target.scenario_id);
}

export async function getScenarioSteps(
  db: D1Database,
  scenarioId: string,
): Promise<ScenarioStep[]> {
  const result = await db
    .prepare(
      `SELECT * FROM scenario_steps WHERE scenario_id = ? ORDER BY step_order ASC`,
    )
    .bind(scenarioId)
    .all<ScenarioStep>();
  return result.results;
}
