import { validateConditionForStorage } from './scenario-condition-validation.js';
import { hasDeliveryAccess } from '@line-crm/shared';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { inputError } from '../lib/input-errors.js';
import { fail } from '../lib/fail.js';
import { getScenarioById, createScenario, updateScenario, deleteScenario, createScenarioStep, listMoveReferrers } from '@line-crm/db';
import { reorderScenarios } from '@line-crm/db';
import type { ScenarioWithStepCount as DbScenarioWithStepCount, ScenarioTriggerType, MessageType, DeliveryMode } from '@line-crm/db';
import { getWorkflowStep } from '@line-crm/db';



import type { Env } from '../worker-env.js';

import { canAccessAllLineAccounts, getVisibleLineAccountScope } from '../services/account-access.js';
import { resolveRequestBoundary } from '../services/request-boundary.js';
import { scenarioSubscriptionScope } from './scenarios-definition.js';
import { validateTemplateMessage } from '../services/template-message-validation.js';
import { buildOffsetListResponse, parseOffsetPaging } from '../lib/list-paging.js';
import { resumeQuestionAnswer, registerLegacyQuestionAnswers } from '../features/scenarios/scenario-question-answer/index.js';
import { LineClient } from '@line-crm/line-sdk';

import { serializeScenario, serializeStep, VALID_DELIVERY_MODES, validateStepSchedule, validateStepCondition, validateQuestionForStorage } from './scenarios-definition.js';
import type { Context } from 'hono';

export const get__api_scenarios_id_question_answers_1 = async (c: Context<Env, "/api/scenarios/:id/question-answers">) => {
  const scenario=await getScenarioById(c.env.DB,c.req.param('id'));
  await registerLegacyQuestionAnswers(c.env.DB,scenario!.id,accountId=>canAccessAllLineAccounts(c.env.DB,c.get('staff'),[accountId]));
  const rows=await c.env.DB.prepare(`SELECT scope_id,subject_id,status,error_code,input_json,updated_at FROM workflow_steps
    WHERE process_kind='question_answer' AND step_key='__run' AND status!='succeeded'
      AND json_extract(input_json,'$.target.scenarioId')=? ORDER BY updated_at DESC LIMIT 100`)
    .bind(scenario!.id).all<{scope_id:string;subject_id:string;status:string;error_code:string|null;input_json:string;updated_at:number}>();
  const visible=[];
  for(const row of rows.results)if(await canAccessAllLineAccounts(c.env.DB,c.get('staff'),[row.scope_id.slice(5)==='default'?null:row.scope_id.slice(5)]))visible.push(row);
  return c.json({success:true,data:visible.map(row=>({executionId:row.subject_id,status:row.status,errorCode:row.error_code,
    friendId:JSON.parse(row.input_json).friendId,updatedAt:new Date(row.updated_at).toISOString()}))});
};

export const post__api_scenarios_id_question_answers_executionId_resume_2 = async (c: Context<Env, "/api/scenarios/:id/question-answers/:executionId/resume">) => {
  if(c.get('staff')?.readOnly) return c.json({success:false,error:'閲覧のみの権限では再開できません'},403);
  const body=await c.req.json().catch(()=>null);
  if(!body || typeof body.reason!=='string' || !body.reason.trim() || body.reason.length>500)
    return inputError(c, {success:false,error:'再開する理由を1〜500文字で入力してください'}, 400, ["reason"]);
  const scenario=await getScenarioById(c.env.DB,c.req.param('id'));
  const root=await c.env.DB.prepare(`SELECT * FROM workflow_steps WHERE process_kind='question_answer' AND subject_id=? AND step_key='__run'`)
    .bind(c.req.param('executionId')).first<import('@line-crm/db').WorkflowStepRow>();
  const scopeId=root?.scope_id ?? '';
  const accountId=scopeId.slice(5)==='default'?null:scopeId.slice(5);
  if(!await canAccessAllLineAccounts(c.env.DB,c.get('staff'),[accountId]))return c.json({success:false,error:'回答が見つかりません'},404);
  if(!root?.input_json || JSON.parse(root.input_json).target.scenarioId!==scenario!.id)
    return c.json({success:false,error:'回答が見つかりません'},404);

  try{
    const resumed=await resumeQuestionAnswer(c.env.DB,{scopeId,executionId:c.req.param('executionId'),actorId:c.get('staff')!.id,
      reason:body.reason.trim(),lineClient:new LineClient(''),
      confirmedChoiceIndex:body.confirmedChoiceIndex,confirmedCompletedSteps:body.confirmedCompletedSteps});
    const latest=await getWorkflowStep(c.env.DB,{scopeId,processKind:'question_answer',subjectId:c.req.param('executionId'),stepKey:'__run'});
    return c.json({success:true,data:{resumed,status:latest?.status}});
  }catch(error){
    const code=error instanceof Error?error.message:'answer_resume_failed';
    return c.json({success:false,code,error:code==='legacy_answer_unknown'?'古い回答の成功した工程は不明です。確認した工程と最初の選択肢を指定してください':'回答を再開できませんでした'},409);
  }
};

export const patch__api_scenarios_reorder_3 = async (c: Context<Env, "/api/scenarios/reorder">) => {
  try {
    const body = await c.req.json<{ ids?: unknown }>();
    if (!Array.isArray(body.ids) || body.ids.some((v) => typeof v !== 'string')) {
      return inputError(c, { success: false, error: 'ids must be an array of scenario ids' }, 400, ["ids"]);
    }
    if (body.ids.length > 500) {
      return inputError(c, { success: false, error: 'too many ids' }, 400, ["ids"]);
    }
    // 編集できるスタッフでも、担当外の並びをIDだけで変更できない。
    if (c.get('staff').role === 'staff') {
      for (const id of body.ids as string[]) {
        const target = await getScenarioById(c.env.DB, id);
        if (!target) return fail(c, 404, 'SCENARIO_NOT_FOUND');
        const decision = await resolveRequestBoundary(c.env.DB, c.get('staff'), target.line_account_id ?? null, {
          requiredPermissionKey: 'scenario.definition.edit',
        });
        if (!decision.allowed) return fail(c, 404, 'SCENARIO_NOT_FOUND');
      }
    }
    await reorderScenarios(c.env.DB, body.ids as string[]);
    return c.json({ success: true, data: { updated: body.ids.length } });
  } catch (err) {
    throw err;
  }
};

export const get__api_scenarios_4 = async (c: Context<Env, "/api/scenarios">) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    const paging = parseOffsetPaging({ page: c.req.query('page'), limit: c.req.query('limit') });
    const { limit, offset } = paging;
    const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
    if (lineAccountId && !scope.allowedAccountIds.includes(lineAccountId)) {
      return c.json({ success: false, error: 'シナリオが見つかりません' }, 404);
    }

    const clauses: string[] = [];
    const binds: unknown[] = [];
    if (lineAccountId) {
      const accountClauses = ['s.line_account_id = ?'];
      binds.push(lineAccountId);
      if (scope.canSeeUnassigned) accountClauses.push('s.line_account_id IS NULL');
      clauses.push(`(${accountClauses.join(' OR ')})`);
    } else {
      const accountClauses: string[] = [];
      if (scope.allowedAccountIds.length > 0) {
        accountClauses.push(`s.line_account_id IN (${sqlIdSet(scope.allowedAccountIds).sql})`);
        binds.push(...(scope.allowedAccountIds.length ? sqlIdSet(scope.allowedAccountIds).binds : []));
      }
      if (scope.canSeeUnassigned) accountClauses.push('s.line_account_id IS NULL');
      clauses.push(accountClauses.length > 0 ? `(${accountClauses.join(' OR ')})` : '0 = 1');
    }
    const query = c.req.query('query')?.trim();
    if (query) {
      /*
       * LIKE ではなく instr で部分一致する。
       * D1 は LIKE/GLOB パターンを最大50バイトに制限するため、
       * `%<検索語>%` を束縛すると48バイト超の検索語で500になっていた。
       * 記号はワイルドカードとして効かず文字どおり探す点は ESCAPE 版と同じ。
       */
      clauses.push(`instr(lower(s.name), lower(?)) > 0`);
      binds.push(query);
    }
    if (c.req.query('active') === '0') clauses.push('s.is_active = 0');
    const createdFrom = c.req.query('createdFrom')?.trim();
    if (createdFrom) {
      clauses.push('s.created_at >= ?');
      binds.push(createdFrom);
    }
    const folderId = c.req.query('folderId');
    if (folderId === '__unfiled__') clauses.push('s.folder_id IS NULL');
    else if (folderId) {
      clauses.push('s.folder_id = ?');
      binds.push(folderId);
    }
    const where = `WHERE ${clauses.join(' AND ')}`;
    const [rows, count] = await Promise.all([
      c.env.DB.prepare(
        `SELECT s.*, COUNT(ss.id) as step_count
           FROM scenarios s
           LEFT JOIN scenario_steps ss ON s.id = ss.scenario_id
           ${where}
          GROUP BY s.id
          ORDER BY s.created_at DESC, s.id DESC
          LIMIT ? OFFSET ?`,
      ).bind(...binds, limit, offset).all<DbScenarioWithStepCount>(),
      c.env.DB.prepare(`SELECT COUNT(*) AS total FROM scenarios s ${where}`)
        .bind(...binds).first<{ total: number }>(),
    ]);
    const items = rows.results;
    const total = Number(count?.total ?? 0);

    /*
     * 購読中と読了済の人数。
     *
     * 設計の一覧はこの2つを列で出す。これまでは通数（ステップ数）しか
     * 返しておらず、「作ったが誰も通っていない」シナリオを見分けられなかった。
     *
     * シナリオごとに数えると件数ぶん往復するので、1回で全部数えて配る。
     */
    // 集計が成功して行が無いシナリオは実際の0人。失敗時はこの初期値も破棄する。
    const counts = new Map<string, { active: number | null; completed: number | null }>(
      items.map(row => [row.id, { active: 0, completed: 0 }]),
    );
    try {
      const scenarioIds = items.map((item) => item.id);
      const accountIds = lineAccountId ? [lineAccountId] : scope.allowedAccountIds;
      if (scenarioIds.length > 0 && accountIds.length > 0) {
        const scenarioPlaceholders = sqlIdSet(scenarioIds).sql;
        const accountPlaceholders = sqlIdSet(accountIds).sql;
        const rows = await c.env.DB
          .prepare(
          `SELECT scenario_id,
                  SUM(CASE WHEN fs.status = 'active' THEN 1 ELSE 0 END) AS active_count,
                  SUM(CASE WHEN fs.status = 'completed' THEN 1 ELSE 0 END) AS completed_count
             FROM friend_scenarios fs
             INNER JOIN friends f ON f.id = fs.friend_id
            WHERE fs.scenario_id IN (${scenarioPlaceholders})
              AND f.line_account_id IN (${accountPlaceholders})
            GROUP BY scenario_id`,
          )
          .bind(...sqlIdSet(scenarioIds).binds, ...(accountIds.length ? sqlIdSet(accountIds).binds : []))
          .all<{ scenario_id: string; active_count: number | null; completed_count: number | null }>();
        for (const r of rows.results) {
          counts.set(r.scenario_id, {
            active: typeof r.active_count === 'number' && Number.isFinite(r.active_count) && r.active_count >= 0 ? r.active_count : null,
            completed: typeof r.completed_count === 'number' && Number.isFinite(r.completed_count) && r.completed_count >= 0 ? r.completed_count : null,
          });
        }
      }
    } catch {
      // 一覧が読めていれば残す。人数の未取得を0人とは扱わない。
      counts.clear();
    }

    return c.json({
      success: true,
      data: buildOffsetListResponse({
        items: items.map((row) => ({
          ...serializeScenario(row),
          stepCount: row.step_count,
          subscriberCount: counts.get(row.id)?.active ?? null,
          completedCount: counts.get(row.id)?.completed ?? null,
        })),
        total,
        paging,
        sort: [
          { field: 'createdAt', direction: 'desc' },
          { field: 'id', direction: 'desc' },
        ],
      }),
    });
  } catch (err) {
    throw err;
  }
};

export const get__api_scenarios_id_5 = async (c: Context<Env, "/api/scenarios/:id">) => {
  try {
    const id = c.req.param('id')!;
    const scenario = await getScenarioById(c.env.DB, id);

    if (!scenario) {
      return fail(c, 404, 'SCENARIO_NOT_FOUND');
    }

    return c.json({
      success: true,
      data: {
        ...serializeScenario(scenario),
        steps: scenario.steps.map(serializeStep),
      },
    });
  } catch (err) {
    throw err;
  }
};

export const post__api_scenarios_6 = async (c: Context<Env, "/api/scenarios">) => {
  try {
    const body = await c.req.json<{
      name: string;
      description?: string | null;
      triggerType: ScenarioTriggerType;
      triggerTagId?: string | null;
      isActive?: boolean;
      lineAccountId?: string | null;
      deliveryMode?: string;
      allowConcurrent?: boolean;
      folderId?: string | null;
    }>();
    if (body.isActive === true && !hasDeliveryAccess(c.get('staff'), 'scenarios', 'publish')) return c.json({ success: false, error: '公開には管理者権限が必要です' }, 403);

    if (!body.name || !body.triggerType) {
      return inputError(c, { success: false, error: 'name and triggerType are required' }, 400, ["name","triggerType"]);
    }
    if (body.name.length > 60) {
      return inputError(c, { success: false, error: 'シナリオ名は60文字以内で入力してください' }, 400, ['name']);
    }

    if (body.lineAccountId
      && !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [body.lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを操作する権限がありません' }, 403);
    }

    const deliveryMode = body.deliveryMode ?? 'relative';
    if (!VALID_DELIVERY_MODES.includes(deliveryMode as DeliveryMode)) {
      return inputError(c, { success: false, error: 'invalid deliveryMode' }, 400, ["deliveryMode"]);
    }

    let scenario = await createScenario(c.env.DB, {
      name: body.name,
      isActive: body.isActive === true && hasDeliveryAccess(c.get('staff'), 'scenarios', 'publish'),
      description: body.description ?? null,
      triggerType: body.triggerType,
      triggerTagId: body.triggerTagId ?? null,
      deliveryMode: deliveryMode as DeliveryMode,
      // 省略時は「並行を許す」。ここを既定で塞ぐと、いま複数のシナリオに
      // 入っている人への配信が止まる。
      allowConcurrent: body.allowConcurrent !== false,
    });


    if (body.lineAccountId) {
      await c.env.DB.prepare(`UPDATE scenarios SET content_revision = content_revision + 1, line_account_id = ? WHERE id = ?`)
        .bind(body.lineAccountId, scenario.id).run();
    }

    // フォルダは create の中身に入っていないので、指定があればここで付ける
    // （ : 新規作成画面が名前・フォルダ・方式をまとめて送る）。
    if (body.folderId !== undefined) {
      const updated = await updateScenario(c.env.DB, scenario.id, { folder_id: body.folderId });
      if (updated) scenario = updated;
    }

    return c.json({ success: true, data: serializeScenario(scenario) }, 201);
  } catch (err) {
    throw err;
  }
};

export const put__api_scenarios_id_7 = async (c: Context<Env, "/api/scenarios/:id">) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{
      name?: string;
      description?: string | null;
      triggerType?: ScenarioTriggerType;
      triggerTagId?: string | null;
      isActive?: boolean;
      expectedContentRevision?: number;
      expectedSubscriptions?: { activeCount: number; rowIdSum: number; rowIdSquareSum: number };
      /** isActive: false で止めるときの理由（任意・200字まで）。 */
      reason?: string;
      deliveryMode?: DeliveryMode;
      allowConcurrent?: boolean;
      folderId?: string | null;
      /** シナリオ全体の配信対象。null を渡すと条件なしに戻す。 */
      audienceCondition?: unknown;
      /** 最終コンテンツ配信後の処理。 */
      onCompleteMode?: 'pause' | 'resume_previous' | 'move';
      onCompleteScenarioId?: string | null;
    }>();

    const stopScope = body.isActive === false ? await scenarioSubscriptionScope(c, id) : null;
    if (body.isActive === false && !stopScope) return c.json({ success: false, error: '関連する対象を確認できないため操作できません' }, 403);
    if (body.expectedContentRevision !== undefined && (!Number.isSafeInteger(body.expectedContentRevision) || body.expectedContentRevision < 1)) {
      return inputError(c, { success: false, error: 'invalid_confirmation_revision' }, 400, ['expectedContentRevision']);
    }
    if (body.expectedSubscriptions !== undefined && (body.expectedContentRevision === undefined || !validSubscriptionSummary(body.expectedSubscriptions))) {
      return inputError(c, { success: false, error: 'invalid_confirmation_subscriptions' }, 400, ['expectedSubscriptions']);
    }
    let name = body.name;
    if (name !== undefined && name.length > 60) {
      const existing = await getScenarioById(c.env.DB, id);
      if (!existing) return fail(c, 404, 'SCENARIO_NOT_FOUND');
      if (existing.name !== name) {
        return inputError(c, { success: false, error: 'シナリオ名は60文字以内で入力してください' }, 400, ['name']);
      }
      // 未変更の長いシナリオ名を送らず、同時編集による上書きを防ぐ。
      name = undefined;
    }
    if (body.reason !== undefined && (
      body.isActive !== false
      || typeof body.reason !== 'string'
      || Array.from(body.reason).length > 200
    )) {
      return inputError(c, { success: false, error: '止める理由は停止時だけ指定でき、200字以内の文字列が必要です' }, 400, ["reason","isActive"]);
    }
    if (body.isActive !== undefined && !hasDeliveryAccess(c.get('staff'), 'scenarios', 'publish')) {
      return c.json({ success: false, error: '公開・停止には管理者権限が必要です' }, 403);
    }
    if (body.isActive !== undefined && typeof body.isActive !== 'boolean') {
      return inputError(c, { success: false, error: 'isActive は真偽値で指定してください' }, 400, ["isActive"]);
    }

    /*
     * 配信方式は「通がまだ1つも無いとき」だけ変えられる。
     *
     * 設計（配信方式の選択）は、シナリオを作ってから方式を選ぶ流れ。
     * 作った直後は通が0なので、ここを通る。
     *
     * 通があるときに変えると、通の予定（delay_minutes / offset_days /
     * delivery_time）が方式と食い違ったまま残る。どれを配信時刻と
     * みなすかが変わるので、黙って通すと配信の時刻がずれる。
     * 消してから変えてもらう。
     */
    if (body.deliveryMode !== undefined) {
      const row = await c.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM scenario_steps WHERE scenario_id = ?`,
      )
        .bind(id)
        .first<{ n: number }>();
      if ((row?.n ?? 0) > 0) {
        return inputError(c, {
            success: false,
            error:
              '通がすでにあるため、配信方式を変えられません。通の予定の持ち方が方式ごとに違うためです。通を消してから変えてください。',
          }, 400, ["deliveryMode"]);
      }
    }

    let audienceJson: string | null | undefined;
    if (body.audienceCondition !== undefined) {
      const checked = validateConditionForStorage(body.audienceCondition, 'シナリオの配信対象');
      if (!checked.ok) return inputError(c, { success: false, error: checked.error }, 400, ["audienceCondition"]);
      audienceJson = checked.json;
    }

    /*
     * 「別のシナリオへ移動」は、移動先が要る。移動先が無いまま保存すると、
     * 配り終えた人がどこにも行けずに黙って止まる。
     */
    if (body.onCompleteMode === 'move' && !body.onCompleteScenarioId) {
      return inputError(c, { success: false, error: '「別のシナリオへ移動」には移動先のシナリオが要ります。' }, 400, ["onCompleteMode","onCompleteScenarioId"]);
    }
    // 自分自身へは移せない。配り終えた直後にまた最初から始まって止まらなくなる。
    if (body.onCompleteScenarioId && body.onCompleteScenarioId === id) {
      return inputError(c, { success: false, error: '移動先に自分自身は選べません。配信が終わらなくなります。' }, 400, ["onCompleteScenarioId"]);
    }

    const updated = await updateScenario(c.env.DB, id, {
      name,
      description: body.description,
      trigger_type: body.triggerType,
      trigger_tag_id: body.triggerTagId,
      is_active: body.isActive !== undefined ? (body.isActive ? 1 : 0) : undefined,
      allow_concurrent:
        body.allowConcurrent !== undefined ? (body.allowConcurrent ? 1 : 0) : undefined,
      delivery_mode: body.deliveryMode,
      folder_id: body.folderId === undefined ? undefined : (body.folderId || null),
      audience_condition_json: audienceJson,
      on_complete_mode: body.onCompleteMode,
      on_complete_scenario_id:
        body.onCompleteScenarioId === undefined ? undefined : (body.onCompleteScenarioId || null),
    }, {
      ...(body.isActive === false ? { stop: { reason: body.reason?.trim() || null, staffId: c.get('staff')!.id } } : {}),
      expectedRevision: body.expectedContentRevision,
      expectedSubscriptions: body.expectedSubscriptions,
      accountScope: stopScope ? { accountIds: stopScope.allowedAccountIds, canSeeUnassigned: stopScope.canSeeUnassigned } : undefined,
    });

    if (!updated) {
      return fail(c, 404, 'SCENARIO_NOT_FOUND');
    }

    return c.json({ success: true, data: serializeScenario(updated) });
  } catch (err) {
    if (err instanceof Error && err.message === 'SCENARIO_CONFIRMATION_CONFLICT') {
      const current = await getScenarioById(c.env.DB, c.req.param('id'));
      if (!current) return fail(c, 404, 'SCENARIO_NOT_FOUND');
      return c.json({ success: false, error: 'scenario_confirmation_conflict', data: serializeScenario(current) }, 409);
    }
    throw err;
  }
};

export const get__api_scenarios_id_move_referrers_8 = async (c: Context<Env, "/api/scenarios/:id/move-referrers">) => {
  try {
    const id = c.req.param('id')!;
    const scenario = await getScenarioById(c.env.DB, id);
    if (!scenario) {
      return fail(c, 404, 'SCENARIO_NOT_FOUND');
    }
    // 見える範囲だけに絞る。見えないアカウントの名前は数えない。
    const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
    const referrers = await listMoveReferrers(c.env.DB, id);
    const items = referrers
      .filter((r) => r.lineAccountId === null
        ? scope.canSeeUnassigned
        : scope.allowedAccountIds.includes(r.lineAccountId))
      .map(({ id: referrerId, name }) => ({ id: referrerId, name }));
    return c.json({ success: true, data: { items, total: items.length } });
  } catch (err) {
    throw err;
  }
};

export const delete__api_scenarios_id_9 = async (c: Context<Env, "/api/scenarios/:id">) => {
  try {
    const id = c.req.param('id');
    const scope = await scenarioSubscriptionScope(c, id);
    if (!scope) return c.json({ success: false, error: '関連する対象を確認できないため操作できません' }, 403);
    const body = await c.req.json<{ expectedContentRevision?: unknown; expectedSubscriptions?: unknown; expectedActiveSubscriptions?: unknown; expectedReferrers?: unknown }>().catch(() => null);
    const revision = body?.expectedContentRevision;
    const subscriptions = body?.expectedSubscriptions;
    const activeSubscriptions = body?.expectedActiveSubscriptions;
    const referrers = body?.expectedReferrers;
    if (revision !== undefined || subscriptions !== undefined || activeSubscriptions !== undefined || referrers !== undefined) {
      if (!Number.isSafeInteger(revision) || Number(revision) < 1 || !validSubscriptionSummary(subscriptions) || !validSubscriptionSummary(activeSubscriptions)
        || !Array.isArray(referrers) || referrers.some(item => !item || typeof item.id !== 'string' || !item.id || !Number.isSafeInteger(item.revision) || item.revision < 1)
        || new Set(referrers.map(item => item.id)).size !== referrers.length)
        return inputError(c, { success: false, error: 'invalid_confirmation' }, 400, ['expectedContentRevision', 'expectedSubscriptions', 'expectedActiveSubscriptions', 'expectedReferrers']);
    }
    await deleteScenario(c.env.DB, id, revision === undefined ? undefined : { expectedRevision: revision as number, expectedSubscriptions: subscriptions as { activeCount: number; rowIdSum: number; rowIdSquareSum: number }, expectedActiveSubscriptions: activeSubscriptions as { activeCount: number; rowIdSum: number; rowIdSquareSum: number } | undefined, expectedReferrers: referrers as Array<{id: string; revision: number}>, accountIds: scope.allowedAccountIds, canSeeUnassigned: scope.canSeeUnassigned });
    return c.json({ success: true, data: null });
  } catch (err) {
    const code = err instanceof Error ? err.message : '';
    if (code === 'SCENARIO_CONFIRMATION_CONFLICT') {
      const current = await getScenarioById(c.env.DB, c.req.param('id'));
      if (!current) return fail(c, 404, 'SCENARIO_NOT_FOUND');
      return c.json({ success: false, error: 'scenario_confirmation_conflict', data: serializeScenario(current) }, 409);
    }
    if (code === 'SCENARIO_HAS_DEPENDENTS' || /FOREIGN KEY/i.test(code)) {
      const scenario = await getScenarioById(c.env.DB, c.req.param('id'));
      return c.json({ success: false, error: '他の機能から使われているため削除できません。先に連携を外してください。', current: scenario ? serializeScenario(scenario) : null }, 409);
    }
    throw err;
  }
};

export const post__api_scenarios_id_steps_10 = async (c: Context<Env, "/api/scenarios/:id/steps">) => {
  try {
    const scenarioId = c.req.param('id');
    const body = await c.req.json<{
      stepOrder: number;
      delayMinutes?: number;
      offsetDays?: number;
      offsetMinutes?: number;
      deliveryTime?: string;
      messageType: MessageType;
      messageContent: string;
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

    if (body.stepOrder === undefined || !body.messageType || body.messageContent === undefined) {
      return inputError(c, { success: false, error: 'stepOrder, messageType, and messageContent are required' }, 400, ["stepOrder","messageType","messageContent"]);
    }

    // 画面の disabled だけでは、古い画面や直接APIを呼ぶ経路を止められない。
    // テンプレートと同じ正本で数え、絵文字も表示上の1文字として扱う。
    const message = validateTemplateMessage(body.messageType, body.messageContent);
    if (!message.ok) {
      const { ok: _ok, ...failure } = message;
      return inputError(c, { success: false, ...failure }, 422, ["messageType","messageContent"]);
    }

    const scenarioRow = await c.env.DB
      .prepare(`SELECT delivery_mode FROM scenarios WHERE id = ?`)
      .bind(scenarioId)
      .first<{ delivery_mode: DeliveryMode }>();
    if (!scenarioRow) {
      return fail(c, 404, 'SCENARIO_NOT_FOUND');
    }

    const v = validateStepSchedule(scenarioRow.delivery_mode, body);
    if (!v.ok) return inputError(c, { success: false, error: v.error }, 400, ["offsetDays","offsetMinutes","deliveryTime","delayMinutes"]);

    const cv = validateStepCondition(body.conditionType, body.conditionValue);
    if (!cv.ok) return inputError(c, { success: false, error: cv.error }, 400, ["conditionType","conditionValue"]);

    // templateId / onReachTagId 参照整合性チェック
    if (body.templateId != null) {
      const tpl = await c.env.DB
        .prepare(`SELECT id FROM templates WHERE id = ?`)
        .bind(body.templateId)
        .first<{ id: string }>();
      if (!tpl) return fail(c, 400, 'TEMPLATE_ID_NOT_FOUND', {}, ["templateId"]);
    }
    if (body.onReachTagId != null) {
      const tag = await c.env.DB
        .prepare(`SELECT id FROM tags WHERE id = ?`)
        .bind(body.onReachTagId)
        .first<{ id: string }>();
      if (!tag) return fail(c, 400, 'ON_REACH_TAG_ID_NOT_FOUND', {}, ["onReachTagId"]);
    }

    /*
     * 同じ番号の通が既にあると、UNIQUE(scenario_id, step_order) に当たって
     * 500 になる。「Internal server error」とだけ返ると、何が悪いのか
     * 分からないまま同じ操作を繰り返すことになるので、先に見て理由を返す。
     *
     * 実際に踏んだ: 通が2つあるシナリオで「ステップの作成」を開き直すと、
     * その画面は必ず1通目を作るので、毎回500になっていた。
     */
    const duplicate = await c.env.DB.prepare(
      `SELECT id FROM scenario_steps WHERE scenario_id = ? AND step_order = ?`,
    )
      .bind(scenarioId, body.stepOrder)
      .first<{ id: string }>();
    if (duplicate) {
      return c.json(
        {
          success: false,
          error: `${body.stepOrder}通目はすでにあります。シナリオ編集の「ここに挿入」から足すか、番号を変えてください。`,
        },
        409,
      );
    }

    const stepTarget = validateConditionForStorage(body.targetCondition, 'この通の配信対象');
    if (!stepTarget.ok) return inputError(c, { success: false, error: stepTarget.error }, 400, ["targetCondition"]);
    const stepQuestion = validateQuestionForStorage(body.question);
    if (!stepQuestion.ok) return inputError(c, { success: false, error: stepQuestion.error }, 400, ["question"]);
    if (body.messageType === 'text' && body.messageContent.trim() === '' && stepQuestion.json === null) {
      return inputError(c, { success: false, error: '本文または質問を入力してください。' }, 400, ["messageType","messageContent","question"]);
    }

    const step = await createScenarioStep(c.env.DB, {
      scenarioId,
      stepOrder: body.stepOrder,
      delayMinutes: body.delayMinutes ?? 0,
      messageType: body.messageType,
      messageContent: body.messageContent,
      conditionType: body.conditionType ?? null,
      conditionValue: body.conditionValue ?? null,
      nextStepOnFalse: body.nextStepOnFalse ?? null,
      offsetDays: body.offsetDays ?? null,
      offsetMinutes: body.offsetMinutes ?? null,
      deliveryTime: body.deliveryTime ?? null,
      templateId: body.templateId ?? null,
      onReachTagId: body.onReachTagId ?? null,
      // 知らない値は 'continue'。列の CHECK に引っかかって 500 になるより、
      // これまでの動き（次へ進む）に寄せる。
      afterSend: body.afterSend === 'pause' ? 'pause' : 'continue',
      targetConditionJson: stepTarget.json,
      questionJson: stepQuestion.json,
      isDraft: body.isDraft === true,
    });

    return c.json({ success: true, data: serializeStep(step) }, 201);
  } catch (err) {
    throw err;
  }
};

function validSubscriptionSummary(value: unknown): value is { activeCount: number; rowIdSum: number; rowIdSquareSum: number } {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return Number.isSafeInteger(v.activeCount) && Number(v.activeCount) >= 0 && Number.isSafeInteger(v.rowIdSum) && Number(v.rowIdSum) >= 0 && Number.isSafeInteger(v.rowIdSquareSum) && Number(v.rowIdSquareSum) >= 0;
}
