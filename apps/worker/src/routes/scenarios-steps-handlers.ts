import { jstCalendar as japanCalendar } from '@line-crm/shared';
import { validateConditionForStorage } from './scenario-condition-validation.js';
import { inputError } from '../lib/input-errors.js';
import { fail } from '../lib/fail.js';
import { getScenarioById, updateScenarioStep, deleteScenarioStep, enrollFriendInScenario, getFriendById, getScenarioPublishedVersion, computeNextDeliveryAt } from '@line-crm/db';
import { resolveStepContent } from '@line-crm/db';
import type { MessageType, DeliveryMode } from '@line-crm/db';
import { computeScenarioStats } from '../features/scenarios/scenario-stats/index.js';
import { parseQuestion } from '../features/scenarios/scenario-question/index.js';



import type { Env } from '../worker-env.js';

import { canAccessAllLineAccounts } from '../services/account-access.js';
import { validateTemplateMessage } from '../services/template-message-validation.js';
import { getScenarioRuns, saveScenarioDraft, simulateFriendPlan, simulateScenario } from '../features/scenarios/scenario-contract/index.js';
import { buildOffsetListResponse, listLimit } from '../lib/list-paging.js';
import { validateStepCondition, validateStepSchedule, validateQuestionForStorage, serializeScenario, serializeStep, WEEKDAY_JA, requireScenarioAccountScope, scenarioContractError, serializeFriendScenario } from './scenarios-definition.js';
import type { Context } from 'hono';

export const put__api_scenarios_id_steps_stepId_1 = async (c: Context<Env, "/api/scenarios/:id/steps/:stepId">) => {
  try {
    const scenarioId = c.req.param('id');
    const stepId = c.req.param('stepId');
    const body = await c.req.json<{
      stepOrder?: number;
      delayMinutes?: number;
      offsetDays?: number;
      offsetMinutes?: number;
      deliveryTime?: string;
      messageType?: MessageType;
      messageContent?: string;
      conditionType?: string | null;
      conditionValue?: string | null;
      nextStepOnFalse?: number | null;
      templateId?: string | null;
      onReachTagId?: string | null;
      afterSend?: 'continue' | 'pause';
      /** 1通ごとの配信対象。null は「購読中の全員に配信する」。 */
      targetCondition?: unknown;
      /** 質問メッセージ。 */
      question?: unknown;
      isDraft?: boolean;
    }>();

    // 種別と本文がそろっている更新はDBを読む前に止める。部分更新と
    // テンプレート参照は、下で現在値と合わせたあとにもう一度検査する。
    if (body.messageType !== undefined && body.messageContent !== undefined) {
      const message = validateTemplateMessage(body.messageType, body.messageContent);
      if (!message.ok) {
        const { ok: _ok, ...failure } = message;
        return inputError(c, { success: false, ...failure }, 422, ["messageType","messageContent"]);
      }
    }

    // 旧1通の編集で複数吹き出しを黙って消さない。来店フォローの版付き保存へ戻す。
    if (body.messageType !== undefined || body.messageContent !== undefined || body.templateId !== undefined) {
      const stored = await c.env.DB.prepare('SELECT message_bubbles_json FROM scenario_steps WHERE id=? AND scenario_id=?')
        .bind(stepId,scenarioId).first<{message_bubbles_json:string|null}>();
      if (stored?.message_bubbles_json) return c.json({success:false,code:'MULTIPLE_MESSAGES_REQUIRE_EDITOR',error:'複数の吹き出しは来店フォローの編集で保存してください'},409);
    }

    // conditionType / conditionValue の partial-update 検証（OSS issue  回帰防止）。
    // どちらかが touched なときだけ走らせる。effective 値は、body に来た値を優先しつつ
    // 既存行で穴埋めして組み立て、validateStepCondition で pair を検証する。
    // これにより「type だけ flipping、value は既存」のような partial 更新を壊さずに、
    // 未知 type や JSON 異形を確実に弾ける。
    if (body.conditionType !== undefined || body.conditionValue !== undefined) {
      const existingCond = await c.env.DB
        .prepare(`SELECT condition_type, condition_value FROM scenario_steps WHERE id = ? AND scenario_id = ?`)
        .bind(stepId, scenarioId)
        .first<{ condition_type: string | null; condition_value: string | null }>();
      if (!existingCond) {
        return fail(c, 404, 'STEP_NOT_FOUND');
      }
      const effectiveType = body.conditionType !== undefined ? body.conditionType : existingCond.condition_type;
      const effectiveValue = body.conditionValue !== undefined ? body.conditionValue : existingCond.condition_value;
      const cv = validateStepCondition(effectiveType, effectiveValue);
      if (!cv.ok) return inputError(c, { success: false, error: cv.error }, 400, ["conditionType","conditionValue"]);
    }

    // templateId / onReachTagId 参照整合性チェック (null は解除を意図、bypass)
    // templateId が指定された場合は内容も取得して snapshot 更新に使う。
    let templateSnapshot: { message_type: string; message_content: string } | null = null;
    if (body.templateId !== undefined && body.templateId !== null) {
      const tpl = await c.env.DB
        .prepare(`SELECT id, message_type, message_content FROM templates WHERE id = ? AND message_bubbles_json IS NULL`)
        .bind(body.templateId)
        .first<{ id: string; message_type: string; message_content: string }>();
      if (!tpl) return fail(c, 400, 'TEMPLATE_ID_NOT_FOUND', {}, ["templateId"]);
      templateSnapshot = { message_type: tpl.message_type, message_content: tpl.message_content };
    }
    if (body.onReachTagId !== undefined && body.onReachTagId !== null) {
      const tag = await c.env.DB
        .prepare(`SELECT id FROM tags WHERE id = ?`)
        .bind(body.onReachTagId)
        .first<{ id: string }>();
      if (!tag) return fail(c, 400, 'ON_REACH_TAG_ID_NOT_FOUND', {}, ["onReachTagId"]);
    }

    // スケジュールフィールドが1つでも指定されている場合は、既存値を DB から読んで
    // partial body と merge してから validateStepSchedule に渡す。
    // (1 フィールドだけ更新するケース、例: elapsed step の offsetMinutes だけ変更、
    //  absolute_time step の deliveryTime だけ変更 を許可するため)
    const scheduleTouched =
      body.delayMinutes != null ||
      body.offsetDays != null ||
      body.offsetMinutes != null ||
      body.deliveryTime != null;
    if (scheduleTouched) {
      const scenarioRow = await c.env.DB
        .prepare(`SELECT delivery_mode FROM scenarios WHERE id = ?`)
        .bind(scenarioId)
        .first<{ delivery_mode: DeliveryMode }>();
      if (!scenarioRow) {
        return fail(c, 404, 'SCENARIO_NOT_FOUND');
      }
      const existingStep = await c.env.DB
        .prepare(
          `SELECT delay_minutes, offset_days, offset_minutes, delivery_time
           FROM scenario_steps WHERE id = ? AND scenario_id = ?`,
        )
        .bind(stepId, scenarioId)
        .first<{
          delay_minutes: number;
          offset_days: number | null;
          offset_minutes: number | null;
          delivery_time: string | null;
        }>();
      if (!existingStep) {
        return fail(c, 404, 'STEP_NOT_FOUND');
      }
      // mode mismatch (relative scenario に offsetDays を投げる等) は body の生値で検出する。
      // 一方、対応 mode のフィールドが片方だけ送られた場合 (例: absolute_time で deliveryTime のみ)
      // は既存値で穴埋めする。
      const scheduleForValidation: {
        delayMinutes?: number;
        offsetDays?: number;
        offsetMinutes?: number;
        deliveryTime?: string;
      } = {
        delayMinutes: body.delayMinutes,
        offsetDays: body.offsetDays,
        offsetMinutes: body.offsetMinutes,
        deliveryTime: body.deliveryTime,
      };
      if (scenarioRow.delivery_mode === 'relative') {
        if (scheduleForValidation.delayMinutes === undefined) {
          scheduleForValidation.delayMinutes = existingStep.delay_minutes;
        }
      } else if (scenarioRow.delivery_mode === 'elapsed') {
        if (scheduleForValidation.offsetDays === undefined && existingStep.offset_days != null) {
          scheduleForValidation.offsetDays = existingStep.offset_days;
        }
        if (scheduleForValidation.offsetMinutes === undefined && existingStep.offset_minutes != null) {
          scheduleForValidation.offsetMinutes = existingStep.offset_minutes;
        }
      } else {
        // absolute_time
        if (scheduleForValidation.offsetDays === undefined && existingStep.offset_days != null) {
          scheduleForValidation.offsetDays = existingStep.offset_days;
        }
        if (scheduleForValidation.deliveryTime === undefined && existingStep.delivery_time != null) {
          scheduleForValidation.deliveryTime = existingStep.delivery_time;
        }
      }
      const v = validateStepSchedule(scenarioRow.delivery_mode, scheduleForValidation);
      if (!v.ok) return inputError(c, { success: false, error: v.error }, 400, ["delayMinutes","offsetDays","offsetMinutes","deliveryTime"]);
    }

    // templateId が指定された場合は snapshot (message_type/message_content) も
    // 同時に更新する。templates テーブルから取った値を優先することで、stale な
    // body 内容 (UI の templates state が古い等) が保存されるのを防ぐ。
    // templateId が指定されていない場合は body の値をそのまま使う (直接入力モード)。
    let effectiveMessageType = templateSnapshot
      ? (templateSnapshot.message_type as MessageType)
      : body.messageType;
    let effectiveMessageContent = templateSnapshot
      ? templateSnapshot.message_content
      : body.messageContent;
    if (
      !templateSnapshot
      && (body.messageType !== undefined || body.messageContent !== undefined)
      && (effectiveMessageType === undefined || effectiveMessageContent === undefined)
    ) {
      const existingMessage = await c.env.DB
        .prepare(`SELECT message_type, message_content FROM scenario_steps WHERE id = ? AND scenario_id = ?`)
        .bind(stepId, scenarioId)
        .first<{ message_type: MessageType; message_content: string }>();
      if (!existingMessage) return fail(c, 404, 'STEP_NOT_FOUND');
      effectiveMessageType ??= existingMessage.message_type;
      effectiveMessageContent ??= existingMessage.message_content;
    }
    const message = validateTemplateMessage(effectiveMessageType, effectiveMessageContent);
    if (!message.ok) {
      const { ok: _ok, ...failure } = message;
      return inputError(c, { success: false, ...failure }, 422, ["messageType","messageContent"]);
    }

    let targetJson: string | null | undefined;
    if (body.targetCondition !== undefined) {
      const checked = validateConditionForStorage(body.targetCondition, 'この通の配信対象');
      if (!checked.ok) return inputError(c, { success: false, error: checked.error }, 400, ["targetCondition"]);
      targetJson = checked.json;
    }
    let questionJson: string | null | undefined;
    if (body.question !== undefined) {
      const checked = validateQuestionForStorage(body.question);
      if (!checked.ok) return inputError(c, { success: false, error: checked.error }, 400, ["question"]);
      questionJson = checked.json;
    }

    const updated = await updateScenarioStep(c.env.DB, stepId, {
      step_order: body.stepOrder,
      delay_minutes: body.delayMinutes,
      message_type: effectiveMessageType,
      message_content: effectiveMessageContent,
      condition_type: body.conditionType,
      condition_value: body.conditionValue,
      next_step_on_false: body.nextStepOnFalse,
      offset_days: body.offsetDays,
      offset_minutes: body.offsetMinutes,
      delivery_time: body.deliveryTime,
      template_id: body.templateId,
      on_reach_tag_id: body.onReachTagId,
      after_send:
        body.afterSend === undefined ? undefined : body.afterSend === 'pause' ? 'pause' : 'continue',
      target_condition_json: targetJson,
      question_json: questionJson,
      is_draft: body.isDraft === undefined ? undefined : body.isDraft ? 1 : 0,
    });

    if (!updated) {
      return fail(c, 404, 'STEP_NOT_FOUND');
    }

    return c.json({ success: true, data: serializeStep(updated) });
  } catch (err) {
    throw err;
  }
};

export const delete__api_scenarios_id_steps_stepId_2 = async (c: Context<Env, "/api/scenarios/:id/steps/:stepId">) => {
  try {
    const stepId = c.req.param('stepId');
    const body = await c.req.json<{ expectedContentRevision?: unknown }>().catch(() => null);
    const expected = body?.expectedContentRevision;
    if (expected !== undefined && (!Number.isSafeInteger(expected) || Number(expected) < 1))
      return inputError(c, { success: false, error: 'invalid_confirmation_revision' }, 400, ['expectedContentRevision']);
    await deleteScenarioStep(c.env.DB, stepId, expected === undefined ? undefined : { scenarioId: c.req.param('id'), expectedRevision: expected as number });
    return c.json({ success: true, data: null });
  } catch (err) {
    if (err instanceof Error && err.message === 'SCENARIO_CONFIRMATION_CONFLICT') {
      const current = await getScenarioById(c.env.DB, c.req.param('id'));
      return c.json({ success: false, error: 'scenario_confirmation_conflict', data: current ? serializeScenario(current) : null }, 409);
    }
    throw err;
  }
};

export const post__api_scenarios_id_steps_reorder_3 = async (c: Context<Env, "/api/scenarios/:id/steps/reorder">) => {
  try {
    const scenarioId = c.req.param('id');
    const body = await c.req.json<{ orders: { stepId: string; stepOrder: number }[] }>();

    if (!Array.isArray(body.orders) || body.orders.length === 0) {
      return inputError(c, { success: false, error: 'orders must be a non-empty array' }, 400, ["orders"]);
    }
    for (const o of body.orders) {
      if (typeof o.stepId !== 'string' || typeof o.stepOrder !== 'number' || o.stepOrder < 1) {
        return inputError(c, { success: false, error: 'invalid orders entry' }, 400, ["orders"]);
      }
    }

    // 既存ステップの step_order と next_step_on_false を取得して、
    // 旧 step_order → 新 step_order のマップを構築する。
    // 既存の branching (next_step_on_false) を保つには、移動する step の旧→新 step_order マップで
    // 各 step の next_step_on_false 値を書き換える必要がある。
    const existing = await c.env.DB
      .prepare(`SELECT id, step_order FROM scenario_steps WHERE scenario_id = ?`)
      .bind(scenarioId)
      .all<{ id: string; step_order: number }>();
    const oldOrderById = new Map(existing.results.map((r) => [r.id, r.step_order]));

    const newOrderById = new Map(body.orders.map((o) => [o.stepId, o.stepOrder]));
    // 移動した通だけの、新旧の通番対応を作る。
    const oldToNew = new Map<number, number>();
    for (const [stepId, newOrder] of newOrderById) {
      const oldOrder = oldOrderById.get(stepId);
      if (oldOrder !== undefined && oldOrder !== newOrder) {
        oldToNew.set(oldOrder, newOrder);
      }
    }

    // UNIQUE(scenario_id, step_order) 衝突回避: 一旦負数空間に逃がしてから最終値に再代入する2フェーズ。
    const phase1 = body.orders.map((o, i) =>
      c.env.DB
        .prepare(`UPDATE scenario_steps SET step_order = ? WHERE id = ? AND scenario_id = ?`)
        .bind(-1 - i, o.stepId, scenarioId),
    );
    const phase2 = body.orders.map((o) =>
      c.env.DB
        .prepare(`UPDATE scenario_steps SET step_order = ? WHERE id = ? AND scenario_id = ?`)
        .bind(o.stepOrder, o.stepId, scenarioId),
    );
    // phase3: branching ターゲット (next_step_on_false) も同様に2フェーズで書き換える。
    // 入れ替え (A 旧2→新4, B 旧4→新2) のケースで一発 UPDATE すると後続が前の結果を上書きするため、
    // 一旦負数 sentinel に逃がしてから新値に書く。
    const oldToNewArr = Array.from(oldToNew.entries());
    const phase3a = oldToNewArr.map(([oldOrder], i) =>
      c.env.DB
        .prepare(
          `UPDATE scenario_steps SET next_step_on_false = ?
           WHERE scenario_id = ? AND next_step_on_false = ?`,
        )
        .bind(-1000 - i, scenarioId, oldOrder),
    );
    const phase3b = oldToNewArr.map(([, newOrder], i) =>
      c.env.DB
        .prepare(
          `UPDATE scenario_steps SET next_step_on_false = ?
           WHERE scenario_id = ? AND next_step_on_false = ?`,
        )
        .bind(newOrder, scenarioId, -1000 - i),
    );
    await c.env.DB.batch([...phase1, ...phase2, ...phase3a, ...phase3b, c.env.DB.prepare('UPDATE scenarios SET content_revision=content_revision+1 WHERE id=?').bind(scenarioId)]);

    return c.json({ success: true });
  } catch (err) {
    throw err;
  }
};

export const get__api_scenarios_id_preview_4 = async (c: Context<Env, "/api/scenarios/:id/preview">) => {
  try {
    // simulate と同じく開始日の正しさを見る。無いと NaN 時刻の予定が
    // 返るか 500 になる。
    const startParam = c.req.query('startAt');
    if (startParam && !Number.isFinite(new Date(startParam).getTime())) {
      return c.json({
        success: false,
        code: 'start_at_invalid',
        error: '開始日時が正しくありません',
        field: 'startAt',
      }, 400);
    }
    const scenarioId = c.req.param('id');
    const scenarioRow = await c.env.DB
      .prepare(`SELECT delivery_mode, line_account_id FROM scenarios WHERE id = ?`)
      .bind(scenarioId)
      .first<{ delivery_mode: DeliveryMode; line_account_id: string | null }>();
    if (!scenarioRow) return fail(c, 404, 'SCENARIO_NOT_FOUND');

    const stepsResult = await c.env.DB
      .prepare(
        `SELECT id, step_order, delay_minutes, offset_days, offset_minutes, delivery_time,
                template_id, message_type, message_content, question_json, is_draft
         FROM scenario_steps WHERE scenario_id = ? ORDER BY step_order ASC`,
      )
      .bind(scenarioId)
      .all<{
        id: string;
        step_order: number;
        delay_minutes: number;
        offset_days: number | null;
        offset_minutes: number | null;
        delivery_time: string | null;
        template_id: string | null;
        message_type: string;
        message_content: string;
        question_json: string | null;
        is_draft: number | null;
      }>();
    const steps = stepsResult.results;

    // 配信時と同じ resolveStepContent を呼んで、template_id があれば templates から
    // 最新内容を取って preview に返す。これで配信と preview の表示が一致する。
    // シナリオの line_account_id を渡し、配信時と同じく公開版・同一アカウントだけを解決する。
    const resolvedSteps = await Promise.all(
      steps.map(async (step) => {
        const resolved = await resolveStepContent(c.env.DB, step, scenarioRow.line_account_id);
        return { step, resolved };
      }),
    );

    // computeNextDeliveryAt は「JST clock-time を UTC として表現する Date」前提。
    // クエリの startParam は "+09:00" 付き ISO で本物の UTC instant として parse されるため、
    // +9h ずらして JST clock-time 表現に揃える。default の now も同様にずらして表現する。
    // （正しさは入口で見ているので、ここでは読むだけ。）
    const startAt = startParam
      ? japanCalendar(new Date(startParam))
      : japanCalendar();

    // Day N はカレンダー日数差で算出。経過 24h 単位だと、enrolledAt 14:32 →
    // 翌日 09:00 (18.5h 後) が Day 0 と表示されてしまう (本来 Day 1)。
    // startAt と at は両方 JST clock-time として表現された Date なので、
    // 日付部分の差を計算すれば正しい Day N が出る。
    const startEpochDay = Math.floor(
      Date.UTC(startAt.getUTCFullYear(), startAt.getUTCMonth(), startAt.getUTCDate()) / 86_400_000,
    );
    let prev = startAt;
    const timeline = resolvedSteps.map(({ step, resolved }) => {
      const at = computeNextDeliveryAt(
        { delivery_mode: scenarioRow.delivery_mode },
        step,
        { enrolledAt: startAt, previousDeliveredAt: prev, now: startAt },
      );
      prev = at;
      const atEpochDay = Math.floor(
        Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) / 86_400_000,
      );
      const day = atEpochDay - startEpochDay;
      const hh = String(at.getHours()).padStart(2, '0');
      const mm = String(at.getMinutes()).padStart(2, '0');
      const wd = WEEKDAY_JA[at.getDay()];
      return {
        stepOrder: step.step_order,
        deliveryAt: at.toISOString().slice(0, -1) + '+09:00',
        deliveryAtLabel: `Day ${day} ${hh}:${mm} (${wd})`,
        messageType: resolved.messageType,
        messageContent: resolved.messageContent,
        question: parseQuestion(resolved.questionJson),
        // 下書きの通も並ぶが、実際は送られない。送られる通と
        // 見分けられるよう別を付ける（友だち別の予定は下書きを除く）。
        isDraft: Number(step.is_draft ?? 0) !== 0,
        /*
         * 公開版・通の控えのどれを表示しているかを出す。
         * template 参照があるのに控えのときは、未反映の理由も付ける
         * （保存と公開を取り違えると、確認すべき場所を誤る）。
         */
        contentSource: resolved.templateIdAtSend != null
          ? 'template' as const
          : (step.template_id != null ? 'step-fallback' as const : 'step' as const),
        fallbackReason: resolved.fallbackReason,
      };
    });

    return c.json({
      success: true,
      data: {
        startAt: startAt.toISOString().slice(0, -1) + '+09:00',
        steps: timeline,
      },
    });
  } catch (err) {
    throw err;
  }
};

export const get__api_scenarios_id_stats_5 = async (c: Context<Env, "/api/scenarios/:id/stats">) => {
  try {
    const scenarioId = c.req.param('id')!;
    const scenario = await c.env.DB
      .prepare(`SELECT id FROM scenarios WHERE id = ?`)
      .bind(scenarioId)
      .first<{ id: string }>();
    if (!scenario) {
      return fail(c, 404, 'SCENARIO_NOT_FOUND');
    }
    const stats = await computeScenarioStats(c.env.DB, scenarioId);
    return c.json({ success: true, data: stats });
  } catch (err) {
    throw err;
  }
};

export const post__api_scenarios_id_simulate_6 = async (c: Context<Env, "/api/scenarios/:id/simulate">) => {
  const body = await c.req.json<{
    lineAccountId?: unknown;
    startAt?: unknown;
  }>().catch(() => ({} as { lineAccountId?: unknown; startAt?: unknown }));
  const lineAccountId = typeof body.lineAccountId === 'string' ? body.lineAccountId.trim() : '';
  if (!lineAccountId) {
    return inputError(c, { success: false, error: 'LINE公式アカウントを選んでください' }, 400, ["lineAccountId"]);
  }
  const scopeError = await requireScenarioAccountScope(c, lineAccountId);
  if (scopeError) return scopeError;
  try {
    const data = await simulateScenario(c.env.DB, {
      scenarioId: c.req.param('id')!,
      lineAccountId,
      startAt: typeof body.startAt === 'string' ? body.startAt : undefined,
    });
    return c.json({ success: true, data });
  } catch (error) {
    return scenarioContractError(c, error);
  }
};

export const get__api_scenarios_id_runs_7 = async (c: Context<Env, "/api/scenarios/:id/runs">) => {
  const lineAccountId = (c.req.query('lineAccountId') ?? '').trim();
  if (!lineAccountId) {
    return c.json({ success: false, error: 'LINE公式アカウントを選んでください' }, 400);
  }
  const scopeError = await requireScenarioAccountScope(c, lineAccountId);
  if (scopeError) return scopeError;
  try {
    const data = await getScenarioRuns(c.env.DB, {
      scenarioId: c.req.param('id')!,
      lineAccountId,
      status: c.req.query('status'),
      cursor: c.req.query('cursor'),
      limit: listLimit(c.req.query('limit'), 50, 100),
    });
    return c.json({ success: true, data: buildOffsetListResponse({ ...data, items: data.subscriptions, total: data.pagination.total, paging: { limit: data.pagination.limit }, sort: [] }) });
  } catch (error) {
    return scenarioContractError(c, error);
  }
};

export const get__api_scenarios_id_friends_friendId_plan_8 = async (c: Context<Env, "/api/scenarios/:id/friends/:friendId/plan">) => {
  const lineAccountId = (c.req.query('lineAccountId') ?? '').trim();
  if (!lineAccountId) {
    return c.json({ success: false, error: 'LINE公式アカウントを選んでください' }, 400);
  }
  const scopeError = await requireScenarioAccountScope(c, lineAccountId);
  if (scopeError) return scopeError;
  try {
    const friend = await getFriendById(c.env.DB, c.req.param('friendId')!);
    const friendAccountId = (friend as { line_account_id?: string | null } | null)
      ?.line_account_id ?? null;
    if (!friend || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [friendAccountId])) {
      return c.json({ success: false, error: '友だちが見つかりません' }, 404);
    }
    const startAt = c.req.query('startAt');
    const data = await simulateFriendPlan(c.env.DB, {
      scenarioId: c.req.param('id')!,
      lineAccountId,
      friendId: c.req.param('friendId')!,
      ...(startAt ? { startAt } : {}),
    });
    return c.json({ success: true, data });
  } catch (error) {
    return scenarioContractError(c, error);
  }
};

export const put__api_scenarios_id_draft_9 = async (c: Context<Env, "/api/scenarios/:id/draft">) => {
  const body = await c.req.json<{
    lineAccountId?: unknown;
    expectedVersion?: unknown;
    afterActions?: unknown;
  }>().catch(() => ({} as {
    lineAccountId?: unknown;
    expectedVersion?: unknown;
    afterActions?: unknown;
  }));
  const lineAccountId = typeof body.lineAccountId === 'string' ? body.lineAccountId.trim() : '';
  if (!lineAccountId) {
    return inputError(c, { success: false, error: 'LINE公式アカウントを選んでください' }, 400, ["lineAccountId"]);
  }
  const scopeError = await requireScenarioAccountScope(c, lineAccountId);
  if (scopeError) return scopeError;
  try {
    const data = await saveScenarioDraft(c.env.DB, {
      scenarioId: c.req.param('id')!,
      lineAccountId,
      expectedVersion: Number(body.expectedVersion),
      afterActions: body.afterActions,
      staffId: c.get('staff').id,
    });
    return c.json({ success: true, data });
  } catch (error) {
    return scenarioContractError(c, error);
  }
};

export const post__api_scenarios_id_enroll_friendId_10 = async (c: Context<Env, "/api/scenarios/:id/enroll/:friendId">) => {
  try {
    const scenarioId = c.req.param('id');
    const friendId = c.req.param('friendId');
    const db = c.env.DB;


    const [scenario, friend] = await Promise.all([
      getScenarioById(db, scenarioId),
      getFriendById(db, friendId),
    ]);

    if (!scenario) {
      return fail(c, 404, 'SCENARIO_NOT_FOUND');
    }
    if (!friend) {
      return fail(c, 404, 'FRIEND_NOT_FOUND');
    }

    /*
     * 手動登録は本物の購読を作る。IDを直接渡されても、見えない友だちや
     * 別アカウントの友だちを混ぜない（点検  中12）。
     * テスト送信と同じく、友だち側のアカウント一致を見る。
     */
    const friendAccountId = (friend as { line_account_id?: string | null }).line_account_id ?? null;
    if (!await canAccessAllLineAccounts(db, c.get('staff'), [friendAccountId])) {
      return c.json({ success: false, error: '登録する友だちが見つかりません。' }, 404);
    }
    if (scenario.line_account_id && friendAccountId !== scenario.line_account_id) {
      return inputError(c, { success: false, error: 'このシナリオと同じLINEアカウントの友だちを選んでください。' }, 422, ["scenario","friend"]);
    }
    if ((friend as { is_following?: number | null }).is_following !== 1) {
      return inputError(c, { success: false, error: 'ブロック中の友だちは登録できません。' }, 422, ["friend"]);
    }
    /*
     * 未公開・停止中の契約はここで正直に返す。enrollFriendInScenario は
     * webhook 経路の副作用でも使うので null に倒すだけだが、手動登録では
     * 理由を 422 で返す。
     */
    if (!scenario.is_active) {
      return inputError(c, { success: false, error: '停止中のシナリオには登録できません。' }, 422, ["scenario"]);
    }
    if (!await getScenarioPublishedVersion(db, scenarioId)) {
      return inputError(c, { success: false, error: 'まだ公開されていないため登録できません。先に公開してください。' }, 422, []);
    }

    const enrollment = await enrollFriendInScenario(db, friendId, scenarioId);
    if (!enrollment) {
      return c.json({ success: false, error: 'Already enrolled in this scenario' }, 409);
    }
    return c.json({ success: true, data: serializeFriendScenario(enrollment) }, 201);
  } catch (err) {
    throw err;
  }
};
