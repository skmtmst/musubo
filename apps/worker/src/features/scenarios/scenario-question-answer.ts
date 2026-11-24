import { logger } from '@line-crm/shared/server';
import { attachTagAndFireSideEffects, detachTagAndFireSideEffects } from '../friends/friend-tag-attach/index.js';
import { applyTapExtras } from '../../services/tap-extras.js'
/*
 * 質問への回答は、返信・タグ・友だち情報・シナリオ操作・アクションの順で処理する。タグ付けが失敗しても押した人へ返信を返すため、返信を先に行う。
 * 後から編集された内容が混入しないよう、購読が固定した公開版の写しを読む。
 * 保存済みの sq:<下書き通ID>:<番号> 形式の押下は、固定版の写しへ解決してから実行する。解決できないときだけ live を読む。
 */
import {
  validateScenarioActionReferences,
  ensureWorkflowStep, getWorkflowStep, workflowJson,
  getFriendFieldById,
  getPinnedScenarioStep,
  isResourceInScenarioAccount,
  parseScenarioVersionActions,
  parseScenarioVersionSteps,
  jstNow,
  setFriendFieldValue,
  validateFriendFieldValue,
  type PinnedScenarioAction,
  type ScenarioVersion,
} from '@line-crm/db'

import type { LineClient } from '@line-crm/line-sdk'
import {
  parseQuestionPostback,
  parseQuestion,
  hasAnsweredBefore,
  DEFAULT_REPEAT_REPLY,
  buildQuestionPostbackData,
  type QuestionStepRef,
  type ScenarioQuestionChoice,
} from './scenario-question.js'
import { acquireWorkflow, type WorkflowExecution } from '../../services/workflow-execution.js'
import { stableWebhookStepId } from '../../services/incoming-webhook-receipts.js'
import { runActionRows, pinnedActionsToRows, runScenarioOp } from './scenario-actions.js'

interface StepRow {
  id: string
  scenario_id: string
  question_json: string | null
}

export interface HandleQuestionAnswerInput {
  /** 押されたボタンがどの形の通IDを載せていたか。省略時は下書き（旧形）。 */
  kind?: 'version' | 'live'
  stepId: string
  choiceIndex: number
  lineAccountId?: string | null
}

export interface HandleQuestionAnswerResult {
  handled: boolean
  /** 2度目以降の押下だったか。 */
  repeat: boolean
  /** replyToken を使ったか。呼び出し側が二重返信しないための目印。 */
  replyTokenConsumed: boolean
}

/**
 * 押された通を1つに決める。
 *
 * `source` が `version` なら、質問文・選択肢・アクションはすべて版の写し
 * から取る。`live` は版がまだ無い環境のための逃げ道で、ここへ落ちるのは
 * 移行前のデータだけ。
 */
interface ResolvedAnswerTarget {
  source: 'version' | 'live'
  scenarioId: string
  scenarioAccountId: string | null
  questionJson: string | null
  /** 押下の記録に使う形（押されたボタンが載せていた形）。 */
  postbackRef: QuestionStepRef
  /** 同じ通を指す別の形。版へ移す前後で「2度目」を数え落とさないため。 */
  alsoMatchRef: QuestionStepRef | null
  /** messages_log.scenario_step_id。live の通が残っているときだけ入れる。 */
  logLiveStepId: string | null
  /** messages_log.scenario_version_step_id。 */
  logVersionStepId: string | null
  /** 版に固定されたアクション。live を読まないための写し。 */
  pinnedActions: PinnedScenarioAction[] | null
  versionStepId: string | null
}

export async function handleQuestionAnswer(
  db: D1Database,
  lineClient: LineClient,
  friend: { id: string; line_user_id: string },
  input: HandleQuestionAnswerInput,
  replyToken: string | undefined,
): Promise<HandleQuestionAnswerResult> {
  const result: HandleQuestionAnswerResult = {
    handled: false,
    repeat: false,
    replyTokenConsumed: false,
  }

  const target = await resolveAnswerTarget(db, friend.id, input)
  if (!target) return result
  if (target.scenarioAccountId !== null) {
    const owner = await db.prepare('SELECT line_account_id FROM friends WHERE id=?').bind(friend.id).first<{ line_account_id: string | null }>()
    // 移行前の所属なしデータは保ち、別店舗の友だちへの実行を拒否する。
    if (!owner || (owner.line_account_id !== null && owner.line_account_id !== target.scenarioAccountId)) return result
  }

  const question = parseQuestion(target.questionJson)
  if (!question) return result

  const choice = question.choices[input.choiceIndex]
  if (!choice) return result

  result.handled = true

  // 記録より先に見る。記録したあとに数えると、いま押したぶんが混ざって
  // 1回目が2回目に見える。
  const repeatScope = question.tapMode === 'single' ? null : input.choiceIndex
  const answered = await hasAnsweredBefore(
    db,
    friend.id,
    target.postbackRef,
    repeatScope,
    target.alsoMatchRef,
  )
  result.repeat = answered

  const accountId = target.scenarioAccountId ?? input.lineAccountId ?? null
  const subjectId = await stableWebhookStepId(`question:${accountId}:${friend.id}:${target.versionStepId ?? target.logLiveStepId}`,
    String(repeatScope ?? 'single'))
  const ref = { scopeId: `line:${accountId ?? 'default'}`, processKind: 'question_answer', subjectId, stepKey: '__run' }
  const known = await getWorkflowStep(db, ref)
  if (answered || known) {
    // 繰り返し押下で失敗した副作用を自動再開しない。受領記録のない履歴は人が照合する。
    if (!known) await ensureWorkflowStep(db,ref,{status:'unknown',maxAttempts:50,
      input:{friendId:friend.id,target,choiceIndex:input.choiceIndex}})
    result.repeat = true
    const text = choice.repeatReply?.trim() || DEFAULT_REPEAT_REPLY
    try {
      const {expandSendCommonVars}=await import('../../services/interpolation-context.js')
      const expanded=await expandSendCommonVars(db,text,{kind:'scenario',id:target.versionStepId ?? input.stepId},
        {lineAccountId:accountId,friendId:friend.id})
      result.replyTokenConsumed=await sendReply(lineClient,friend,replyToken,expanded)
    } catch { /* The accepted first choice and its remaining work stay intact. */ }
    return result
  }
  const execution=await acquireWorkflow(db,{scopeId:ref.scopeId,processKind:ref.processKind,subjectId},
    {input:{friendId:friend.id,target,choiceIndex:input.choiceIndex},maxAttempts:50})
  if(!execution) { result.repeat=true;return result }
  try {
    await execution.step('received',()=>logPostback(execution.mutationDb('received'),friend.id,input.choiceIndex,target,accountId))
    result.replyTokenConsumed=await executeQuestionAnswer(db,execution,lineClient,friend,target,input.choiceIndex,replyToken,false)
  }catch(error){await execution.fail();throw error}
  return result
}

/** 最初に固定した選択肢とアクションを使い、未完了の工程だけを再実行する。 */
export async function executeQuestionAnswer(
  db:D1Database,execution:WorkflowExecution,lineClient:LineClient,
  friend:{id:string;line_user_id:string},target:ResolvedAnswerTarget,choiceIndex:number,
  replyToken:string|undefined,resuming:boolean,
):Promise<boolean> {
  const question=parseQuestion(target.questionJson)
  if(!question || !question.choices[choiceIndex]) { await execution.fail();throw new Error('answer_snapshot_invalid') }
  const choice=question.choices[choiceIndex]
  let failed=false,consumed=false
  const stage=async(key:string,work:(owned:D1Database)=>Promise<unknown>)=>{
    try { await execution.step(key,()=>work(execution.mutationDb(key)),{maxAttempts:50}) }
    catch { failed=true }
  }
  for(const id of choice.addTagIds ?? []) await stage(`tag:add:${id}`,async owned=>{
    if(!await isResourceInScenarioAccount(db,'tag',id,target.scenarioAccountId)) throw new Error('answer_resource_unavailable')
    await attachTagAndFireSideEffects(owned,friend.id,id)
  })
  if(choice.scoreChange) await stage('tap-extra-score',async owned=>{
    const accountId=execution.ref.scopeId === 'line:default' ? null : execution.ref.scopeId.slice('line:'.length)
    if(target.scenarioAccountId !== null && target.scenarioAccountId !== accountId) throw new Error('answer_scope_changed')
    await applyTapExtras(owned,friend.id,accountId,{scoreChange:choice.scoreChange},execution.ref.subjectId)
  })
  for(const id of choice.removeTagIds ?? []) await stage(`tag:remove:${id}`,async owned=>{
    if(!await isResourceInScenarioAccount(db,'tag',id,target.scenarioAccountId)) throw new Error('answer_resource_unavailable')
    await detachTagAndFireSideEffects(owned,friend.id,id,`${execution.sourceEventId}:remove:${id}`)
  })
  if(choice.field?.fieldId) await stage('field',async owned=>{
    if(!(await validateScenarioActionReferences(db,target.scenarioAccountId,'friend_field',{fieldId:choice.field!.fieldId})).ok) throw new Error('answer_resource_unavailable')
    const field=await getFriendFieldById(db,choice.field!.fieldId)
    if(!field) throw new Error('answer_resource_unavailable')
    const checked=validateFriendFieldValue(field,choice.field!.value ?? '')
    if(!checked.ok) throw new Error('answer_value_invalid')
    await setFriendFieldValue(owned,{friendId:friend.id,fieldId:field.id,value:checked.value,updatedBy:'scenario',field})
  })
  if(choice.behavior==='scenario' && choice.scenario) await stage('scenario',async owned=>{
    if(choice.scenario!.scenarioId && !await isResourceInScenarioAccount(db,'scenario',choice.scenario!.scenarioId,target.scenarioAccountId)) throw new Error('answer_resource_unavailable')
    await runScenarioOp(owned,friend.id,target.scenarioId,choice.scenario!)
  })
  let actions = target.pinnedActions ? pinnedActionsToRows(target.pinnedActions) : null
  if (!actions) {
    actions=await execution.step('action_plan',async()=>{
      const rows=await db.prepare(`SELECT * FROM scenario_actions WHERE scenario_id=? ORDER BY sort_order,id`)
        .bind(target.scenarioId).all<import('./scenario-actions.js').ScenarioActionRow>()
      return rows.results
    })
  }
  for(const action of actions.filter(a=>a.hook==='choice_selected' && (a.step_id ?? null)===(target.versionStepId ?? target.logLiveStepId)
    && (a.choice_index ?? null)===choiceIndex)) await stage(`action:${action.id}`,async owned=>{
      const references=await validateScenarioActionReferences(db,target.scenarioAccountId,action.action_type,JSON.parse(action.config_json))
      if(!references.ok)throw new Error('answer_resource_unavailable')
      const outcome=await runActionRows(owned,[action],friend.id,{fires:target.pinnedActions?'pinned':'live',accountId:target.scenarioAccountId,sourceEventId:execution.sourceEventId,executorDependencies:{resolveLineAccessToken:async()=> 'existing-client',createLineClient:()=>lineClient}})
      if(outcome.failed || outcome.skippedIncomplete) throw new Error('answer_action_failed')
      return outcome
    })
  // 再利用できない replyToken を消費する前に試行記録を保存する。実行中断や応答喪失は送達不明とし、管理者による再開でも再送しない。
  if(choice.reply?.trim() && !resuming) {
    try {
      const {expandSendCommonVars}=await import('../../services/interpolation-context.js')
      const text=await expandSendCommonVars(db,choice.reply,{kind:'scenario',id:target.versionStepId ?? target.logLiveStepId ?? target.scenarioId},
        {lineAccountId:target.scenarioAccountId,friendId:friend.id})
      await execution.step('reply_attempt',async()=>({attempted:true}))
      if(replyToken) { consumed=true;await lineClient.replyMessage(replyToken,[{type:'text',text}]) }
      else await lineClient.pushMessage(friend.line_user_id,[{type:'text',text}],await stableWebhookStepId(execution.sourceEventId,'reply'))
      await execution.step('reply_confirmed',async()=>({accepted:true}))
    }catch { failed=true }
  }
  if(failed) await execution.fail();else {try{await execution.complete()}catch(error){await execution.fail();throw error}}
  return consumed
}

export async function resumeQuestionAnswer(db:D1Database,input:{
  scopeId:string;executionId:string;actorId:string;reason:string;lineClient:LineClient;
  confirmedChoiceIndex?:number;confirmedCompletedSteps?:string[];
}):Promise<boolean> {
  if(!input.actorId || !input.reason.trim() || input.reason.length>500)throw new Error('answer_resume_reason_invalid')
  const ref={scopeId:input.scopeId,processKind:'question_answer',subjectId:input.executionId,stepKey:'__run'}
  const root=await getWorkflowStep(db,ref)
  if(!root?.input_json) throw new Error('answer_not_found')
  const snapshot=JSON.parse(root.input_json) as {friendId:string;target:ResolvedAnswerTarget;choiceIndex:number}
  const friend=await db.prepare('SELECT id,line_platform_user_id AS line_user_id,line_account_id FROM friends WHERE id=?').bind(snapshot.friendId)
    .first<{id:string;line_user_id:string;line_account_id:string|null}>()
  if(!friend || `line:${friend.line_account_id ?? 'default'}`!==input.scopeId || (snapshot.target.scenarioAccountId!==null && snapshot.target.scenarioAccountId!==friend.line_account_id))
    throw new Error('answer_scope_changed')
  if(root.status==='succeeded') return false
  if(root.status==='running' && root.lease_expires_at!>Date.now()) throw new Error('answer_busy')
  if(root.status==='unknown') {
    if(!Number.isInteger(input.confirmedChoiceIndex) || !Array.isArray(input.confirmedCompletedSteps)) throw new Error('legacy_answer_unknown')
    const question=parseQuestion(snapshot.target.questionJson)
    if(!question?.choices[input.confirmedChoiceIndex!]) throw new Error('answer_reconciliation_invalid')
    snapshot.choiceIndex=input.confirmedChoiceIndex!
    const choice=question.choices[snapshot.choiceIndex];
    const valid=new Set<string>([
      ...(choice.addTagIds ?? []).map(id=>`tag:add:${id}`),...(choice.removeTagIds ?? []).map(id=>`tag:remove:${id}`),
      ...(choice.field?.fieldId?['field']:[]),...(choice.behavior==='scenario' && choice.scenario?['scenario']:[]),
      ...(choice.reply?.trim()?['reply_attempt','reply_confirmed']:[]),
    ]);
    const actions=snapshot.target.pinnedActions?pinnedActionsToRows(snapshot.target.pinnedActions):
      (await db.prepare('SELECT * FROM scenario_actions WHERE scenario_id=? ORDER BY sort_order,id').bind(snapshot.target.scenarioId)
        .all<import('./scenario-actions.js').ScenarioActionRow>()).results;
    for(const action of actions.filter(a=>a.hook==='choice_selected' && (a.step_id ?? null)===(snapshot.target.versionStepId ?? snapshot.target.logLiveStepId)
      && (a.choice_index ?? null)===snapshot.choiceIndex))valid.add(`action:${action.id}`);
    if(input.confirmedCompletedSteps.some(key=>!valid.has(key)))throw new Error('answer_reconciliation_invalid');
  }
  const execution=await acquireWorkflow(db,{scopeId:ref.scopeId,processKind:ref.processKind,subjectId:ref.subjectId},
    {input:snapshot,maxAttempts:50,resume:{expectedUpdatedAt:root.updated_at}});
  if(!execution)throw new Error('answer_busy');
  const audit={...ref,stepKey:`resume:${crypto.randomUUID()}`};
  try {
  await ensureWorkflowStep(execution.db,audit,{input:{actorId:input.actorId,reason:input.reason,at:new Date().toISOString(),
    legacyConfirmed:root.status==='unknown',confirmedChoiceIndex:input.confirmedChoiceIndex ?? null,
    confirmedCompletedSteps:input.confirmedCompletedSteps ?? []}});
  await execution.db.prepare(`UPDATE workflow_steps SET status='succeeded' WHERE scope_id=? AND process_kind=? AND subject_id=? AND step_key=?`)
    .bind(audit.scopeId,audit.processKind,audit.subjectId,audit.stepKey).run();
  if(root.status==='unknown')for(const key of input.confirmedCompletedSteps!){
    await ensureWorkflowStep(execution.db,{...ref,stepKey:key});
    await execution.db.prepare(`UPDATE workflow_steps SET status='succeeded',result_json='null' WHERE scope_id=? AND process_kind=? AND subject_id=? AND step_key=? AND status='pending'`)
      .bind(ref.scopeId,ref.processKind,ref.subjectId,key).run();
  }
  await execution.db.prepare(`UPDATE workflow_steps SET status='pending',attempt_count=0,next_attempt_at=NULL,error_code=NULL
    WHERE scope_id=? AND process_kind=? AND subject_id=? AND step_key!='__run' AND status IN ('failed','exhausted')`)
    .bind(ref.scopeId,ref.processKind,ref.subjectId).run()
  await executeQuestionAnswer(db,execution,input.lineClient,friend,snapshot.target,snapshot.choiceIndex,undefined,true)
  return true
  }catch(error){await execution.fail();throw error}
}

/** 工程の受領記録がない押下は、人が照合するまで送達不明として扱う。 */
export async function registerLegacyQuestionAnswers(db:D1Database,scenarioId:string,canSee:(accountId:string|null)=>Promise<boolean>):Promise<void>{
  const logs=await db.prepare(`SELECT m.friend_id,m.content,f.line_account_id FROM messages_log m
    JOIN friends f ON f.id=m.friend_id WHERE m.source='postback' AND m.direction='incoming' AND m.content LIKE 'sq:%'
      AND (EXISTS(SELECT 1 FROM scenario_steps st WHERE st.id=m.scenario_step_id AND st.scenario_id=?)
        OR EXISTS(SELECT 1 FROM scenario_versions sv WHERE sv.scenario_id=? AND m.scenario_version_step_id LIKE sv.id || ':%'))
    ORDER BY m.created_at,m.id LIMIT 100`).bind(scenarioId,scenarioId)
    .all<{friend_id:string;content:string;line_account_id:string|null}>()
  for(const log of logs.results){
    if(!await canSee(log.line_account_id))continue
    const parsed=parseQuestionPostback(log.content)
    if(!parsed)continue
    const target=await resolveAnswerTarget(db,log.friend_id,parsed)
    if(!target || target.scenarioId!==scenarioId)continue
    const question=parseQuestion(target.questionJson)
    if(!question?.choices[parsed.choiceIndex])continue
    const accountId=target.scenarioAccountId ?? log.line_account_id
    const subjectId=await stableWebhookStepId(`question:${accountId}:${log.friend_id}:${target.versionStepId ?? target.logLiveStepId}`,
      String(question.tapMode==='single'?'single':parsed.choiceIndex))
    await ensureWorkflowStep(db,{scopeId:`line:${accountId ?? 'default'}`,processKind:'question_answer',subjectId,stepKey:'__run'},
      {status:'unknown',maxAttempts:50,input:{friendId:log.friend_id,target,choiceIndex:parsed.choiceIndex}})
  }
}

async function resolveAnswerTarget(
  db: D1Database,
  friendId: string,
  input: HandleQuestionAnswerInput,
): Promise<ResolvedAnswerTarget | null> {
  if (input.kind === 'version') {
    const hit = await getPinnedScenarioStep(db, input.stepId)
    if (!hit) return null
    return buildVersionTarget(db, hit.version, {
      versionStepId: hit.step.id,
      liveStepId: hit.step.live_step_id,
      questionJson: hit.step.question_json,
      postbackRef: { kind: 'version', stepId: hit.step.id },
      alsoMatchRef: hit.step.live_step_id
        ? { kind: 'live', stepId: hit.step.live_step_id }
        : null,
    })
  }

  // 旧形の押下。この人が固定している版へ繋ぎ直す。
  const step = await db
    .prepare(`SELECT id, scenario_id, question_json FROM scenario_steps WHERE id = ?`)
    .bind(input.stepId)
    .first<StepRow>()
  if (!step) return null

  const pinned = await db
    .prepare(
      `SELECT sv.*
         FROM friend_scenarios fs
         JOIN scenario_versions sv ON sv.id = fs.published_version_id
        WHERE fs.friend_id = ? AND fs.scenario_id = ?
        ORDER BY fs.updated_at DESC
        LIMIT 1`,
    )
    .bind(friendId, step.scenario_id)
    .first<ScenarioVersion>()

  if (pinned) {
    const versionStep = parseScenarioVersionSteps(pinned).find(
      (s) => s.live_step_id === step.id,
    )
    if (versionStep) {
      return buildVersionTarget(db, pinned, {
        versionStepId: versionStep.id,
        liveStepId: step.id,
        questionJson: versionStep.question_json,
        // 押されたボタンは旧形を載せている。記録も押された形のまま残す。
        postbackRef: { kind: 'live', stepId: step.id },
        alsoMatchRef: { kind: 'version', stepId: versionStep.id },
      })
    }
  }

  // 版がまだ無い（移行前）。従来どおり live を読む。
  const account = await db
    .prepare(`SELECT line_account_id FROM scenarios WHERE id = ?`)
    .bind(step.scenario_id)
    .first<{ line_account_id: string | null }>()
  return {
    source: 'live',
    scenarioId: step.scenario_id,
    scenarioAccountId: account?.line_account_id ?? null,
    questionJson: step.question_json,
    postbackRef: { kind: 'live', stepId: step.id },
    alsoMatchRef: null,
    logLiveStepId: step.id,
    logVersionStepId: null,
    pinnedActions: null,
    versionStepId: null,
  }
}

async function buildVersionTarget(
  db: D1Database,
  version: ScenarioVersion,
  parts: {
    versionStepId: string
    liveStepId: string | null
    questionJson: string | null
    postbackRef: QuestionStepRef
    alsoMatchRef: QuestionStepRef | null
  },
): Promise<ResolvedAnswerTarget> {
  const account = await db
    .prepare(`SELECT line_account_id FROM scenarios WHERE id = ?`)
    .bind(version.scenario_id)
    .first<{ line_account_id: string | null }>()
  // 外部キーを壊さないよう、live の通が残っているときだけ控えを入れる。
  const liveStepId = parts.liveStepId
    ? ((
        await db
          .prepare(`SELECT 1 AS ok FROM scenario_steps WHERE id = ?`)
          .bind(parts.liveStepId)
          .first<{ ok: number }>()
      )
        ? parts.liveStepId
        : null)
    : null
  return {
    source: 'version',
    scenarioId: version.scenario_id,
    scenarioAccountId: account?.line_account_id ?? null,
    questionJson: parts.questionJson,
    postbackRef: parts.postbackRef,
    alsoMatchRef: parts.alsoMatchRef,
    logLiveStepId: liveStepId,
    logVersionStepId: parts.versionStepId,
    pinnedActions: parseScenarioVersionActions(version),
    versionStepId: parts.versionStepId,
  }
}

async function logPostback(
  db: D1Database,
  friendId: string,
  choiceIndex: number,
  target: ResolvedAnswerTarget,
  lineAccountId: string | null,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, scenario_version_step_id, source, line_account_id, created_at)
         VALUES (?, ?, 'incoming', 'text', ?, NULL, ?, ?, 'postback', ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        friendId,
        buildQuestionPostbackData(target.postbackRef, choiceIndex),
        target.logLiveStepId,
        target.logVersionStepId,
        lineAccountId,
        jstNow(),
      )
      .run()
  } catch (err) {
    throw err
  }
}

async function sendReply(
  lineClient: LineClient,
  friend: { line_user_id: string },
  replyToken: string | undefined,
  text: string,
): Promise<boolean> {
  try {
    if (replyToken) {
      await lineClient.replyMessage(replyToken, [{ type: 'text', text }])
      return true
    }
    await lineClient.pushMessage(friend.line_user_id, [{ type: 'text', text }])
    return false
  } catch (err) {
    logger.error("services_scenario_question_answer_failed")
    return false
  }
}
