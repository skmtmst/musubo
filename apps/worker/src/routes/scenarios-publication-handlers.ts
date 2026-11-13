import { validateConditionForStorage } from './scenario-condition-validation.js';
import type { ActionBody } from './scenario-action-input-types.js';
import { inputError } from '../lib/input-errors.js';
import { fail } from '../lib/fail.js';
import { getScenarioById, getFriendScenarioById, pauseFriendScenarioManual, resumeFriendScenarioById, retryFailedFriendScenario, moveFriendScenarioTo, getFriendById, publishScenarioVersion, validateScenarioActionReferences } from '@line-crm/db';
import { getScenarioTriggers, addScenarioTrigger, removeScenarioTrigger } from '@line-crm/db';
import type { Env } from '../worker-env.js';

import { canAccessAllLineAccounts } from '../services/account-access.js';
import { validScenarioPublishKey, serializeAction, VALID_ACTION_HOOKS, VALID_ACTION_TYPES, validateActionConfig, runTestSend, requireScenarioAccountScope, parseJson, runFriendScenarioOp, serializeFriendScenario } from './scenarios-definition.js';
import type { Context } from 'hono';

export const post__api_scenarios_id_publish_1 = async (c: Context<Env, "/api/scenarios/:id/publish">) => {
  try {
    const requestKey = c.req.header('Idempotency-Key');
    if (!validScenarioPublishKey(requestKey)) {
      return inputError(c, { success: false, error: '公開操作の確認キーが必要です' }, 400, []);
    }
    const published = await publishScenarioVersion(c.env.DB, c.req.param('id'), {
      staffId: c.get('staff')?.id ?? null,
      idempotencyKey: requestKey,
    });
    return c.json({
      success: true,
      data: {
        scenarioId: c.req.param('id'),
        versionId: published.id,
        versionNumber: Number(published.version_number),
        publishedAt: published.published_at,
      },
    });
  } catch (err) {
    const code = err instanceof Error ? err.message : '';
    if (code === 'SCENARIO_NOT_FOUND') {
      return c.json({ success: false, error: 'シナリオが見つかりません' }, 404);
    }
    if (code === 'SCENARIO_PUBLISH_KEY_CONFLICT') {
      return c.json({ success: false, error: '同じ確認キーが別の内容・別の公開操作で使われています' }, 409);
    }
    if (code === 'SCENARIO_PUBLISH_CONFLICT') {
      return c.json({ success: false, error: '同時公開が競合しました。もう一度公開してください' }, 409);
    }
    if (code === 'SCENARIO_PUBLISH_CYCLE') {
      // モック化されたDBでも壊れないよう、型ではなく userMessage の有無で見る。
      const reason = err instanceof Error && 'userMessage' in err
          && typeof (err as { userMessage?: unknown }).userMessage === 'string'
        ? (err as { userMessage: string }).userMessage
        : '分岐または完了後の移動が循環しているため公開できません';
      return c.json({ success: false, error: reason, code: 'PUBLISH_CYCLE' }, 409);
    }
    throw err;
  }
};

export const get__api_scenarios_id_actions_2 = async (c: Context<Env, "/api/scenarios/:id/actions">) => {
  try {
    const rows = await c.env.DB.prepare(
      `SELECT id, scenario_id, hook, step_id, choice_index, sort_order,
              action_type, config_json, condition_json, repeat_on_refire
         FROM scenario_actions WHERE scenario_id = ?
        ORDER BY hook ASC, step_id ASC, choice_index ASC, sort_order ASC`,
    )
      .bind(c.req.param('id'))
      .all<Parameters<typeof serializeAction>[0]>();
    return c.json({ success: true, data: (rows.results ?? []).map(serializeAction) });
  } catch (err) {
    throw err;
  }
};

export const post__api_scenarios_id_actions_3 = async (c: Context<Env, "/api/scenarios/:id/actions">) => {
  try {
    const scenarioId = c.req.param('id');
    const body = await c.req.json<ActionBody>();

    const hook = String(body.hook ?? '');
    if (!(VALID_ACTION_HOOKS as readonly string[]).includes(hook)) {
      return inputError(c, { success: false, error: 'アクションの発火点が不正です。' }, 400, ["hook"]);
    }
    const actionType = String(body.actionType ?? '');
    if (!(VALID_ACTION_TYPES as readonly string[]).includes(actionType)) {
      return inputError(c, { success: false, error: 'アクションの種別が不正です。' }, 400, ["actionType"]);
    }

    // 発火点ごとに、要る／要らない参照が違う。ここでそろえておかないと
    // loadScenarioActions の IS 比較に引っかからず、永遠に発火しない行ができる。
    const stepId = hook === 'scenario_completed' ? null : (body.stepId || null);
    const choiceIndex = hook === 'choice_selected' ? Number(body.choiceIndex ?? 0) : null;
    if (hook !== 'scenario_completed' && !stepId) {
      return inputError(c, { success: false, error: 'この発火点には通の指定が要ります。' }, 400, ["hook","stepId"]);
    }
    if (hook === 'choice_selected' && (!Number.isInteger(choiceIndex) || (choiceIndex ?? -1) < 0)) {
      return inputError(c, { success: false, error: '選択肢の番号が不正です。' }, 400, ["hook","choiceIndex"]);
    }
    if (stepId) {
      const step = await c.env.DB.prepare(
        `SELECT id FROM scenario_steps WHERE id = ? AND scenario_id = ?`,
      )
        .bind(stepId, scenarioId)
        .first<{ id: string }>();
      if (!step) return inputError(c, { success: false, error: '通が見つかりません。' }, 400, ["hook","stepId"]);
    }

    const configCheck = validateActionConfig(actionType, body.config);
    if (!configCheck.ok) return inputError(c, { success: false, error: configCheck.error }, 400, ["actionType","config"]);
    const conditionCheck = validateConditionForStorage(body.condition, 'アクションの実行');
    if (!conditionCheck.ok) return inputError(c, { success: false, error: conditionCheck.error }, 400, ["condition"]);

    // 参照先の存在と所属を保存前に確かめる。幽霊・他アカウントは
    // 1行も書かず 400 で返す。実行時の読み飛ばしに頼らない。
    const scenarioRow = await c.env.DB.prepare(
      `SELECT line_account_id FROM scenarios WHERE id = ?`,
    )
      .bind(scenarioId)
      .first<{ line_account_id: string | null }>();
    if (!scenarioRow) return c.json({ success: false, error: 'シナリオが見つかりません。' }, 404);
    const refCheck = await validateScenarioActionReferences(
      c.env.DB, scenarioRow.line_account_id, actionType, body.config,
    );
    if (!refCheck.ok) return inputError(c, { success: false, error: refCheck.issue.message }, 400, ["actionType","config"]);

    // 並び順を渡されなければ、同じ発火点の末尾に置く。
    let sortOrder = body.sortOrder;
    if (sortOrder === undefined) {
      const last = await c.env.DB.prepare(
        `SELECT COALESCE(MAX(sort_order), -1) AS n FROM scenario_actions
          WHERE scenario_id = ? AND hook = ? AND step_id IS ? AND choice_index IS ?`,
      )
        .bind(scenarioId, hook, stepId, choiceIndex)
        .first<{ n: number }>();
      sortOrder = (last?.n ?? -1) + 1;
    }

    const id = crypto.randomUUID();
    const insertAction = c.env.DB.prepare(
      `INSERT INTO scenario_actions
         (id, scenario_id, hook, step_id, choice_index, sort_order,
          action_type, config_json, condition_json, repeat_on_refire)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        scenarioId,
        hook,
        stepId,
        choiceIndex,
        sortOrder,
        actionType,
        JSON.stringify(body.config),
        conditionCheck.json,
        body.repeatOnRefire === false ? 0 : 1,
      );
    await c.env.DB.batch([insertAction, c.env.DB.prepare('UPDATE scenarios SET content_revision = content_revision + 1 WHERE id = ? AND changes() > 0').bind(scenarioId)]);

    const row = await c.env.DB.prepare(
      `SELECT id, scenario_id, hook, step_id, choice_index, sort_order,
              action_type, config_json, condition_json, repeat_on_refire
         FROM scenario_actions WHERE id = ?`,
    )
      .bind(id)
      .first<Parameters<typeof serializeAction>[0]>();
    return c.json({ success: true, data: row ? serializeAction(row) : null });
  } catch (err) {
    throw err;
  }
};

export const put__api_scenarios_id_actions_actionId_4 = async (c: Context<Env, "/api/scenarios/:id/actions/:actionId">) => {
  try {
    const scenarioId = c.req.param('id');
    const actionId = c.req.param('actionId');
    const body = await c.req.json<ActionBody>();

    const existing = await c.env.DB.prepare(
      `SELECT action_type FROM scenario_actions WHERE id = ? AND scenario_id = ?`,
    )
      .bind(actionId, scenarioId)
      .first<{ action_type: string }>();
    if (!existing) return c.json({ success: false, error: 'アクションが見つかりません。' }, 404);

    const fields: string[] = [];
    const values: unknown[] = [];

    if (body.config !== undefined) {
      const check = validateActionConfig(existing.action_type, body.config);
      if (!check.ok) return inputError(c, { success: false, error: check.error }, 400, ["config"]);
      // 新しく保存する設定だけ確かめる。並び順だけの変更や既存の
      // 幽霊参照には触らない（既存データの読み・実行を壊さない）。
      const scenarioRow = await c.env.DB.prepare(
        `SELECT line_account_id FROM scenarios WHERE id = ?`,
      )
        .bind(scenarioId)
        .first<{ line_account_id: string | null }>();
      if (!scenarioRow) return c.json({ success: false, error: 'シナリオが見つかりません。' }, 404);
      const refCheck = await validateScenarioActionReferences(
        c.env.DB, scenarioRow.line_account_id, existing.action_type, body.config,
      );
      if (!refCheck.ok) return inputError(c, { success: false, error: refCheck.issue.message }, 400, ["config"]);
      fields.push('config_json = ?');
      values.push(JSON.stringify(body.config));
    }
    if (body.condition !== undefined) {
      const check = validateConditionForStorage(body.condition, 'アクションの実行');
      if (!check.ok) return inputError(c, { success: false, error: check.error }, 400, ["condition"]);
      fields.push('condition_json = ?');
      values.push(check.json);
    }
    if (body.repeatOnRefire !== undefined) {
      fields.push('repeat_on_refire = ?');
      values.push(body.repeatOnRefire ? 1 : 0);
    }
    if (body.sortOrder !== undefined) {
      fields.push('sort_order = ?');
      values.push(body.sortOrder);
    }
    if (fields.length === 0) {
      return inputError(c, { success: false, error: '変えるものがありません。' }, 400, []);
    }

    values.push(actionId);
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE scenario_actions SET ${fields.join(', ')} WHERE id = ?`).bind(...values),
      c.env.DB.prepare('UPDATE scenarios SET content_revision = content_revision + 1 WHERE id = ? AND changes() > 0').bind(scenarioId),
    ]);

    const row = await c.env.DB.prepare(
      `SELECT id, scenario_id, hook, step_id, choice_index, sort_order,
              action_type, config_json, condition_json, repeat_on_refire
         FROM scenario_actions WHERE id = ?`,
    )
      .bind(actionId)
      .first<Parameters<typeof serializeAction>[0]>();
    return c.json({ success: true, data: row ? serializeAction(row) : null });
  } catch (err) {
    throw err;
  }
};

export const delete__api_scenarios_id_actions_actionId_5 = async (c: Context<Env, "/api/scenarios/:id/actions/:actionId">) => {
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`DELETE FROM scenario_actions WHERE id = ? AND scenario_id = ?`).bind(c.req.param('actionId'), c.req.param('id')),
      c.env.DB.prepare('UPDATE scenarios SET content_revision = content_revision + 1 WHERE id = ? AND changes() > 0').bind(c.req.param('id')),
    ]);
    return c.json({ success: true });
  } catch (err) {
    throw err;
  }
};

export const post__api_scenarios_id_test_send_6 = async (c: Context<Env, "/api/scenarios/:id/test-send">) => runTestSend(c, c.req.param('id'), null);

export const post__api_scenarios_id_steps_stepId_test_send_7 = async (c: Context<Env, "/api/scenarios/:id/steps/:stepId/test-send">) => runTestSend(c, c.req.param('id'), c.req.param('stepId'));

export const get__api_scenarios_id_triggers_8 = async (c: Context<Env, "/api/scenarios/:id/triggers">) => {
  try {
    const rows = await getScenarioTriggers(c.env.DB, c.req.param('id')!);
    return c.json({
      success: true,
      data: rows.map((t) => ({ id: t.id, kind: t.kind, tagId: t.tag_id })),
    });
  } catch (err) {
    throw err;
  }
};

export const post__api_scenarios_id_triggers_9 = async (c: Context<Env, "/api/scenarios/:id/triggers">) => {
  try {
    const scenarioId = c.req.param('id');
    const body = await c.req.json<{ kind?: string; tagId?: string | null }>();
    const kind = String(body.kind ?? '');
    if (!['friend_add', 'tag_added', 'form_answer', 'booking_confirmed'].includes(kind)) {
      return inputError(c, { success: false, error: 'きっかけの種類が不正です。' }, 400, ["kind"]);
    }
    if (kind === 'tag_added' && !body.tagId) {
      return inputError(c, { success: false, error: 'きっかけになるタグを選んでください。' }, 400, ["kind","tagId"]);
    }

    const scenario = await c.env.DB.prepare(`SELECT id, line_account_id FROM scenarios WHERE id = ?`)
      .bind(scenarioId)
      .first<{ id: string; line_account_id: string | null }>();
    if (!scenario) return fail(c, 404, 'SCENARIO_NOT_FOUND');

    if (kind === 'tag_added') {
      const tag = await c.env.DB.prepare(`SELECT id, line_account_id FROM tags WHERE id = ?`)
        .bind(body.tagId)
        .first<{ id: string; line_account_id: string | null }>();
      if (!tag) return inputError(c, { success: false, error: 'タグが見つかりません。' }, 400, ["tagId"]);
      // 別組織のタグを開始条件に付けると、そのタグ操作で別組織の購読が
      // 作られてしまう。共通タグと自組織のタグだけ受け付ける。
      // 全体共通のシナリオはどの組織のタグでもよい（どの友だちにも流れる設計）。
      if (tag.line_account_id !== null
        && scenario.line_account_id !== null
        && tag.line_account_id !== scenario.line_account_id) {
        return inputError(c, { success: false, error: 'ほかのLINEアカウントのタグは開始条件にできません。' }, 400, ["tagId"]);
      }
    }

    await addScenarioTrigger(c.env.DB, scenarioId, kind as 'friend_add' | 'tag_added' | 'form_answer' | 'booking_confirmed', body.tagId ?? null);
    const rows = await getScenarioTriggers(c.env.DB, scenarioId);
    return c.json({
      success: true,
      data: rows.map((t) => ({ id: t.id, kind: t.kind, tagId: t.tag_id })),
    });
  } catch (err) {
    throw err;
  }
};

export const get__api_scenarios_id_draft_10 = async (c: Context<Env, "/api/scenarios/:id/draft">) => {
  const lineAccountId = (c.req.query('lineAccountId') ?? '').trim();
  if (!lineAccountId) return c.json({ success: false, error: 'LINE公式アカウントを選んでください' }, 400);
  const scopeError = await requireScenarioAccountScope(c, lineAccountId);
  if (scopeError) return scopeError;
  const row = await c.env.DB.prepare(
    `SELECT scenario_id, line_account_id, version, after_actions_json, updated_by, updated_at
       FROM scenario_drafts WHERE scenario_id = ? AND line_account_id = ?`,
  ).bind(c.req.param('id'), lineAccountId).first<{ scenario_id: string; line_account_id: string; version: number; after_actions_json: string; updated_by: string; updated_at: string }>();
  if (!row) return c.json({ success: true, data: null });
  return c.json({ success: true, data: {
    scenarioId: row.scenario_id, lineAccountId: row.line_account_id, version: row.version,
    afterActions: parseJson(row.after_actions_json), updatedBy: row.updated_by, updatedAt: row.updated_at,
  }});
};

export const delete__api_scenarios_id_triggers_triggerId_11 = async (c: Context<Env, "/api/scenarios/:id/triggers/:triggerId">) => {
    try {
      await removeScenarioTrigger(c.env.DB, c.req.param('id'), c.req.param('triggerId'));
      return c.json({ success: true });
    } catch (err) {
      throw err;
    }
  };

export const post__api_scenario_subscriptions_subscriptionId_pause_12 = async (c: Context<Env, "/api/scenario-subscriptions/:subscriptionId/pause">) => {
    try {
      return await runFriendScenarioOp(c, 'pause', async (subscription) => {
        if (subscription.status === 'paused') {
          return {
            status: 200,
            body: { success: true, data: serializeFriendScenario(subscription) },
          };
        }
        if (subscription.status === 'delivering') {
          return {
            status: 409,
            body: { success: false, error: 'いま配信を処理中です。少し待ってから止めてください' },
          };
        }
        const paused = await pauseFriendScenarioManual(c.env.DB, subscription.id);
        if (!paused) {
          return {
            status: 409,
            body: { success: false, error: 'すでに終わっている購読は止められません' },
          };
        }
        const row = await getFriendScenarioById(c.env.DB, subscription.id);
        return {
          status: 200,
          body: { success: true, data: serializeFriendScenario(row ?? subscription) },
        };
      });
    } catch (err) {
      throw err;
    }
  };

export const post__api_scenario_subscriptions_subscriptionId_resume_13 = async (c: Context<Env, "/api/scenario-subscriptions/:subscriptionId/resume">) => {
    try {
      return await runFriendScenarioOp(c, 'resume', async (subscription) => {
        if (subscription.status === 'active') {
          return {
            status: 200,
            body: { success: true, data: serializeFriendScenario(subscription) },
          };
        }
        if (subscription.status === 'delivering') {
          return {
            status: 409,
            body: { success: false, error: 'いま配信を処理中です。少し待ってから再開してください' },
          };
        }
        if (subscription.status === 'completed') {
          return {
            status: 409,
            body: { success: false, error: '終わった購読は再開できません' },
          };
        }
        const resumed = await resumeFriendScenarioById(c.env.DB, subscription.id);
        if (!resumed) {
          return {
            status: 409,
            body: { success: false, error: 'この購読は再開できません（シナリオ停止・続きの通なし）' },
          };
        }
        return { status: 200, body: { success: true, data: serializeFriendScenario(resumed) } };
      });
    } catch (err) {
      throw err;
    }
  };

export const post__api_scenario_subscriptions_subscriptionId_retry_14 = async (c: Context<Env, "/api/scenario-subscriptions/:subscriptionId/retry">) => {
    try {
      return await runFriendScenarioOp(c, 'retry', async (subscription) => {
        if (subscription.status === 'active') {
          return {
            status: 200,
            body: { success: true, data: serializeFriendScenario(subscription) },
          };
        }
        if (subscription.pause_reason !== 'delivery_failed') {
          return {
            status: 409,
            body: { success: false, error: '配信失敗で止まっている購読だけを再送できます' },
          };
        }
        const retried = await retryFailedFriendScenario(c.env.DB, subscription.id);
        if (!retried) {
          return {
            status: 409,
            body: { success: false, error: 'この購読は再送できません' },
          };
        }
        return { status: 200, body: { success: true, data: serializeFriendScenario(retried) } };
      });
    } catch (err) {
      throw err;
    }
  };

export const post__api_scenario_subscriptions_subscriptionId_move_15 = async (c: Context<Env, "/api/scenario-subscriptions/:subscriptionId/move">) => {
    try {
      return await runFriendScenarioOp(c, 'move', async (subscription) => {
        const body = await c.req.json<{ targetScenarioId?: unknown; expectedConfirmationRevision?: unknown; expectedStatus?: unknown }>().catch(() => null);
        const targetScenarioId = typeof body?.targetScenarioId === 'string'
          ? body.targetScenarioId.trim()
          : '';
        if (!targetScenarioId) {
          return {
            status: 400,
            body: { success: false, error: '移し先のシナリオを選んでください' },
          };
        }
        const revision = body?.expectedConfirmationRevision;
        if (revision !== undefined && (!Number.isSafeInteger(revision) || Number(revision)<1 || (body?.expectedStatus !== undefined && typeof body.expectedStatus !== 'string'))) return { status:400,body:{success:false,error:'確認した版が正しくありません'} };
        if (revision !== undefined && (revision !== subscription.confirmation_revision || (body?.expectedStatus !== undefined && body.expectedStatus !== subscription.status))) return { status:409,body:{success:false,error:'購読の状態が変わりました。読み直してください',current:serializeFriendScenario(subscription)} };
        if (subscription.status === 'delivering') {
          return {
            status: 409,
            body: { success: false, error: 'いま配信を処理中です。少し待ってから移してください' },
          };
        }
        if (subscription.status === 'completed') {
          return {
            status: 409,
            body: { success: false, error: '終わった購読は移せません' },
          };
        }

        const target = await getScenarioById(c.env.DB, targetScenarioId);
        const targetAccountId = (target as { line_account_id?: string | null } | null)?.line_account_id ?? null;
        if (!target || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [targetAccountId])) {
          return { status: 404, body: { success: false, error: '移し先のシナリオが見つかりません' } };
        }
        if (!target.is_active) {
          return {
            status: 422,
            body: { success: false, error: '停止中のシナリオには移せません' },
          };
        }
        const friend = await getFriendById(c.env.DB, subscription.friend_id);
        const friendAccountId = (friend as { line_account_id?: string | null } | null)?.line_account_id ?? null;
        if (targetAccountId && friendAccountId !== targetAccountId) {
          return {
            status: 422,
            body: { success: false, error: '移し先と同じLINEアカウントの友だちにだけ移せます' },
          };
        }

        const moved = await moveFriendScenarioTo(c.env.DB, subscription.id, targetScenarioId, revision === undefined ? undefined : { revision:Number(revision),status:typeof body?.expectedStatus === 'string' ? body.expectedStatus : subscription.status });
        if (!moved) {
          return {
            status: 409,
            body: { success: false, error: 'この友だちは移し先にすでに入っているか、移し先が受け付けません', current: serializeFriendScenario(await getFriendScenarioById(c.env.DB,subscription.id) ?? subscription) },
          };
        }
        return { status: 200, body: { success: true, data: serializeFriendScenario(moved) } };
      });
    } catch (err) {
      throw err;
    }
  };
