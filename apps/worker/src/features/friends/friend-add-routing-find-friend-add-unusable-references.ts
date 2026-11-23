import { logger } from '@line-crm/shared/server';
import { postMileageEntry, claimInitialFriendAddActionRun, claimFriendAddEventForActionRetry, claimFailedFriendAddActionRuns, finishFriendAddActionRun, finishFriendAddEventActionRetry, type FriendAddActionRunRow, type FriendAddRoutingStatus, type FriendScenario, type FriendAddRuleDefinition } from '@line-crm/db';
import { toJstString } from '@line-crm/db';



import { type FriendAddAction, type FriendAddRowActionType, type FriendAddTiming } from '@line-crm/shared';

import { attachTagAndFireSideEffects } from './friend-tag-attach.js';
import type { ImmediatePushContext } from '../../services/immediate-first-step.js';
import { matchesCondition } from '../../services/segment-query.js';
import { type FriendAddReferenceIds, selectIds, parseFriendAddConditionAst, collectFriendAddReferences } from './friend-add-routing-parse-date-interval.js';
import { type FriendAddSuppressReason, evaluateFriendAddSchedule, normalizeActions, type FriendKind } from './friend-add-routing-pick-string.js';

/**
 * 参照しているIDのうち、**このアカウントで使えないもの**を返す。
 *
 * 使えない＝「消えている」か「別アカウント・別テナントの持ち物」。
 * 公開版のスナップショットは保存後もそのまま動くので、保存時に正しくても
 * 実行時には消えている・移っていることがある。どちらの場合も配信しない。
 *
 * 所有者が未設定（NULL）のタグ・シナリオも**使えない扱い**にする。
 * どのアカウントの持ち物か言い切れないものを、このアカウントの配信条件と
 * して読むと、他店の友だちを数える形になりうる。
 * 流入リンクだけは、保存時の契約（未設定＋同一テナントは可）にそろえる。
 * 友だち情報欄は `friend_field_scopes` の所属を見る（所属が無ければ共通）。
 * フォーム・対応マークは所属の置き場が無いので、存在だけを確かめる。
 */
export async function findFriendAddUnusableReferences(
  db: D1Database,
  accountId: string,
  refs: FriendAddReferenceIds,
): Promise<string[]> {
  const tenantOfAccount = '(SELECT tenant_id FROM line_accounts WHERE id = ?)';
  const [tags, scenarios, fields, routes, forms, marks, vars] = await Promise.all([
    selectIds(db, refs.tagIds, (p) => ({
      sql: `SELECT id FROM tags WHERE id IN (${p}) AND line_account_id = ?`,
      bindings: [...refs.tagIds, accountId],
    })),
    selectIds(db, refs.scenarioIds, (p) => ({
      sql: `SELECT id FROM scenarios WHERE id IN (${p}) AND line_account_id = ?`,
      bindings: [...refs.scenarioIds, accountId],
    })),
    /*
     * 友だち情報欄は表そのものに所有の列を持たないが、`friend_field_scopes`
     * が所属を持つ（migration 198）。所属が無い行はテナント共通なので通し、
     * 他アカウントに所属する行は止める。`reminders.ts` の同じ検査と同じ形。
     */
    selectIds(db, refs.friendFieldIds, (p) => ({
      sql: `SELECT ff.id FROM friend_fields ff
             LEFT JOIN friend_field_scopes ffs ON ffs.field_id = ff.id
            WHERE ff.id IN (${p})
              AND (ffs.line_account_id = ? OR ffs.line_account_id IS NULL)`,
      bindings: [...refs.friendFieldIds, accountId],
    })),
    selectIds(db, refs.routeIds, (p) => ({
      sql: `SELECT id FROM entry_routes
             WHERE id IN (${p})
               AND (line_account_id = ?
                    OR (line_account_id IS NULL AND tenant_id = ${tenantOfAccount}))`,
      bindings: [...refs.routeIds, accountId, accountId],
    })),
    selectIds(db, refs.formIds, (p) => ({
      sql: `SELECT id FROM forms WHERE id IN (${p})`,
      bindings: [...refs.formIds],
    })),
    selectIds(db, refs.supportMarkIds, (p) => ({
      sql: `SELECT id FROM support_marks WHERE id IN (${p})`,
      bindings: [...refs.supportMarkIds],
    })),
    // F9: 共通情報は var_key と所属・未保管を見る（実行側の applyCommonVar と同じ条件）。
    selectIds(db, refs.commonVarKeys, (p) => ({
      sql: `SELECT var_key AS id FROM common_vars
             WHERE var_key IN (${p}) AND line_account_id = ? AND archived_at IS NULL`,
      bindings: [...refs.commonVarKeys, accountId],
    })),
  ]);
  return [
    ...refs.tagIds.filter((id) => !tags.has(id)),
    ...refs.scenarioIds.filter((id) => !scenarios.has(id)),
    ...refs.friendFieldIds.filter((id) => !fields.has(id)),
    ...refs.routeIds.filter((id) => !routes.has(id)),
    ...refs.formIds.filter((id) => !forms.has(id)),
    ...refs.supportMarkIds.filter((id) => !marks.has(id)),
    ...refs.commonVarKeys.filter((id) => !vars.has(id)),
  ];
}

/**
 * 友だち条件を実データで評価する。
 *
 * - 空は制限なし（通す）。
 * - Segment条件JSONは**入れ子まで再帰検証**してから実データで評価する。
 * - JSON以外の自由文（旧形式の社内メモ混じり）は安全側に抑止する。
 *   通すと絞り込みが効かず全員に届く。社内メモは
 *   `internalMemo` へ分離し、画面で再設定を促す。
 * - 入れ子グループの operator 欠落のように、通すと絞り込みが緩む形も抑止する。
 */
export async function evaluateFriendAddFriendCondition(
  db: D1Database,
  definition: Pick<FriendAddRuleDefinition, 'friendCondition'>,
  friendId: string,
): Promise<{
  matched: boolean;
  reason: Extract<
    FriendAddSuppressReason,
    'friend_condition_not_met' | 'friend_condition_unreadable' | 'friend_condition_invalid'
  > | null;
}> {
  const ast = parseFriendAddConditionAst(definition.friendCondition);
  if (!ast.ok) {
    logger.error("services_friend_add_routing_failed");
    // 旧形式の自由文は「作り直してほしい」を画面へ出すため従来の理由のまま。
    // 木の形が壊れているものは別の理由で分ける。
    return {
      matched: false,
      reason: ast.error === 'legacy_text' || ast.error === 'not_json'
        ? 'friend_condition_unreadable'
        : 'friend_condition_invalid',
    };
  }
  if (!ast.condition) return { matched: true, reason: null };
  try {
    const matches = await matchesCondition(db, friendId, ast.condition);
    return matches
      ? { matched: true, reason: null }
      : { matched: false, reason: 'friend_condition_not_met' };
  } catch {
    logger.error("friend_add_routing_friendCondition_evaluation_failed_skipped_the_rule");
    return { matched: false, reason: 'friend_condition_invalid' };
  }
}

/**
 * 再送制限にかかっているか。
 *
 * 数えるのは「**届いた形跡がある実行**」だけ。
 *   - `completed`（送った印）
 *   - 送信の記録が残っている行（delivery_count > 0 / first_delivery_sent_at あり）
 *   - 送達不明（`delivery_unknown`）— 送ったかもしれない実行。
 *     自動で送り直すと二重に届くため、ここで止めて人の確認に回す。
 *
 * 逆に、送っていないことがはっきりしている実行（`send_failed`・抑止・
 * 処理中）は数えない。数えると、送れなかった人が永久に送れなくなる。
 * 時間数は公開版の値を使い、未設定は24時間（保存側の既定と同じ）に倒す。
 */
export async function isFriendAddResendSuppressed(
  db: D1Database,
  input: { lineAccountId: string; friendId: string; resendSuppressionHours: unknown; now: Date },
): Promise<boolean> {
  const hours = input.resendSuppressionHours == null
    ? 24
    : Math.max(0, Math.min(720, Math.floor(Number(input.resendSuppressionHours))));
  if (!Number.isFinite(hours) || hours <= 0) return false;
  // 文字列比較が崩れないよう、DBのJST書式（+09:00無し）にそろえる。
  const threshold = toJstString(new Date(input.now.getTime() - hours * 60 * 60 * 1000)).slice(0, 23);
  try {
    const row = await db.prepare(
      `SELECT 1 AS ok FROM friend_add_events
        WHERE line_account_id = ? AND friend_id = ?
          AND occurred_at >= ?
          AND (
            routing_status = 'completed'
            OR COALESCE(delivery_count, 0) > 0
            OR first_delivery_sent_at IS NOT NULL
            OR error_code = 'delivery_unknown'
          )
        LIMIT 1`,
    ).bind(input.lineAccountId, input.friendId, threshold).first<{ ok: number }>();
    return row != null;
  } catch (error) {
    // DB更新より先にWorkerだけが切り替わった短い時間は、旧設定へ安全に戻す。
    if (error instanceof Error && error.message.includes('no such table: friend_add_events')) return false;
    throw error;
  }
}

/**
 * 1つの公開版が「いま・この人」に動くか。安い順（曜日・時間帯→参照の
 * 持ち物確認→友だち条件→再送制限）に見て、最初に止めた理由だけを返す。
 * 競合確認の表示と本番の判定で意味がずれないよう、どちらもこの関数群を通す。
 */
export async function evaluateFriendAddRuleConditions(
  db: D1Database,
  input: {
    lineAccountId: string;
    friendId: string;
    definition: FriendAddRuleDefinition;
    now: Date;
  },
): Promise<{ matched: boolean; reason: FriendAddSuppressReason | null }> {
  const schedule = evaluateFriendAddSchedule(input.definition, input.now);
  if (!schedule.matched) return { matched: false, reason: schedule.reason };
  /*
   * 条件木の形は DB を見ずに確かめられるので先に見る。壊れた木から
   * 参照IDを拾っても意味が無いし、理由も「条件が読めない」が正しい。
   */
  const ast = parseFriendAddConditionAst(input.definition.friendCondition);
  if (!ast.ok) {
    logger.error("services_friend_add_routing_failed");
    return {
      matched: false,
      reason: ast.error === 'legacy_text' || ast.error === 'not_json'
        ? 'friend_condition_unreadable'
        : 'friend_condition_invalid',
    };
  }
  /*
   * 保存時に確かめていても、実行時にもう一度確かめる。タグやシナリオは
   * 保存のあとで消せる・別アカウントへ移せるため、公開版のスナップショットが
   * 使えない参照を抱えたまま動くことがある。消えた参照で絞ると
   * 「誰にも当たらない」ではなく「絞れていない」に化けることもあるため、
   * 消えている場合も配信しない（fail-closed）。
   */
  const unusable = await findFriendAddUnusableReferences(
    db,
    input.lineAccountId,
    collectFriendAddReferences(input.definition),
  );
  if (unusable.length > 0) {
    logger.error("services_friend_add_routing_failed");
    return { matched: false, reason: 'reference_out_of_account' };
  }
  const condition = await evaluateFriendAddFriendCondition(db, input.definition, input.friendId);
  if (!condition.matched) return { matched: false, reason: condition.reason };
  const suppressed = await isFriendAddResendSuppressed(db, {
    lineAccountId: input.lineAccountId,
    friendId: input.friendId,
    resendSuppressionHours: input.definition.resendSuppressionHours,
    now: input.now,
  });
  if (suppressed) return { matched: false, reason: 'resend_suppressed' };
  return { matched: true, reason: null };
}

// ── 実行 ────────────────────────────────────────────────────────────────────

async function postFriendAddMileage(db: D1Database, input: Parameters<typeof postMileageEntry>[1]): Promise<void> {
  try { await postMileageEntry(db, input); }
  catch (error) {
    if (error instanceof Error && error.message === 'MILEAGE_MANAGED_BY_EC') return;
    throw error;
  }
}

export async function runActions(
  db: D1Database,
  friendId: string,
  actions: FriendAddAction[],
  push?: ImmediatePushContext,
  /**
   * 外部効果の直前に通す関門。アクションはタグ付けの副作用で外へ送ることが
   * あるため、**ひとつ手前で毎回**持ち主かを確かめる。まとめて1回では、
   * 前のアクションに時間がかかった間に奪われたことに気づけない。
   */
  fence?: () => Promise<boolean>,
  ledger?: { eventId: string; ruleVersionId: string | null; lineAccountId: string },
): Promise<{ total: number; failed: number }> {
  /*
   * シナリオと同じアクションは、シナリオと同じところで実行する。
   *
   * 自前で書くと、条件付き実行・順次実行・失敗の切り離しを2か所で
   * 保つことになり、必ずどちらかがずれる。行の形だけ合わせて渡す。
   * `scenario_id` などはシナリオ側の都合の列なので、ここでは空で埋める。
   */
  let failed = 0;
  for (const [index, action] of actions.entries()) {
    if (fence && !(await fence())) break;
    const actionType = action.kind === 'row' ? action.actionType : action.kind;
    const snapshot = JSON.stringify(action);
    let actionRunId: string | null = null;
    if (ledger) {
      const stableId = `${ledger.ruleVersionId ?? 'legacy'}:${index}`;
      const claimed = await claimInitialFriendAddActionRun(db, {
        eventId: ledger.eventId,
        actionStableId: stableId,
        actionType,
        actionSnapshot: snapshot,
        idempotencyKey: `friend-add-action:${ledger.eventId}:${stableId}`,
      });
      if (!claimed.acquired) {
        if (claimed.status === 'failed') failed += 1;
        continue;
      }
      actionRunId = claimed.id;
    }
    try {
      if (action.kind === 'row') {
        const { runActionRows } = await import('../scenarios/scenario-actions/index.js');
        const result = await runActionRows(db, [{
          id: actionRunId ?? `friend-add-${index}`,
          scenario_id: '',
          hook: 'on_enroll',
          step_id: null,
          choice_index: null,
          sort_order: index,
          action_type: action.actionType,
          config_json: JSON.stringify(action.config ?? {}),
          condition_json: null,
          repeat_on_refire: 1,
        }] as never, friendId, { accountId: ledger?.lineAccountId ?? null });
        if (result.failed > 0 || result.skippedIncomplete > 0) {
          throw new Error('friend_add_action_failed');
        }
      } else if (action.kind === 'tag') {
        // 読み込みで row へ直しているので、ここへは来ない。古い保存を
        // そのまま渡された場合の保険として残す。
        await attachTagAndFireSideEffects(db, friendId, action.tagId, push);
      } else if (action.kind === 'mile') {
        // 直接台帳へ1行入れる。付与ルール（/scoring）は「こういう行動をしたら
        // 何マイル」を決めるもので、友だち追加の1回だけの付与はここで足す。
        // idempotencyKey に friend を入れているので、同じ人に二重で入らない。
        await postFriendAddMileage(db, {
          beneficiaryFriendId: friendId,
          entryType: 'grant',
          amount: action.amount,
          reason: '友だち追加',
          source: 'friend_add_routing',
          sourceEventId: ledger?.eventId ?? friendId,
          idempotencyKey: actionRunId
            ? `friend_add_action:${actionRunId}`
            : `friend_add_routing:${friendId}:${action.amount}`,
        });
      }
      if (actionRunId) {
        await finishFriendAddActionRun(db, { id: actionRunId, status: 'completed' });
      }
    } catch (err) {
      // 1つ失敗しても残りは実行する。配信そのものは止めない。
      logger.error("services_friend_add_routing_failed");
      failed += 1;
      if (actionRunId) {
        await finishFriendAddActionRun(db, {
          id: actionRunId,
          status: 'failed',
          // 例外本文は顧客情報や外部応答を含み得るため保存しない。
          errorCode: 'action_failed',
        });
      }
    }
  }
  return { total: actions.length, failed };
}

export async function executeStoredFriendAddAction(
  db: D1Database,
  input: { run: FriendAddActionRunRow; friendId: string; lineAccountId: string },
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.run.action_snapshot);
  } catch {
    throw new Error('friend_add_action_snapshot_invalid');
  }
  const [action] = normalizeActions([parsed]);
  if (!action) throw new Error('friend_add_action_snapshot_invalid');
  if (action.kind === 'row') {
    const { runActionRows } = await import('../scenarios/scenario-actions/index.js');
    const result = await runActionRows(db, [{
      id: input.run.id,
      scenario_id: '',
      hook: 'on_enroll',
      step_id: null,
      choice_index: null,
      sort_order: 0,
      action_type: action.actionType,
      config_json: JSON.stringify(action.config ?? {}),
      condition_json: null,
      repeat_on_refire: 1,
    }] as never, input.friendId, { accountId: input.lineAccountId });
    if (result.failed > 0 || result.skippedIncomplete > 0) throw new Error('friend_add_action_failed');
    return;
  }
  if (action.kind === 'mile') {
    await postFriendAddMileage(db, {
      beneficiaryFriendId: input.friendId,
      entryType: 'grant',
      amount: action.amount,
      reason: '友だち追加',
      source: 'friend_add_routing',
      sourceEventId: input.run.event_id,
      idempotencyKey: `friend_add_action:${input.run.id}`,
    });
    return;
  }
  throw new Error('friend_add_action_snapshot_invalid');
}

/** 画面の再試行用。失敗した処理だけを固定snapshotから再実行する。 */
export async function retryFailedFriendAddActions(
  db: D1Database,
  input: { eventId: string; lineAccountId: string },
): Promise<{ found: boolean; acquired: boolean; status?: FriendAddRoutingStatus; retried?: number }> {
  const event = await claimFriendAddEventForActionRetry(db, input);
  if (!event) {
    const exists = await db.prepare(
      `SELECT 1 AS found FROM friend_add_events WHERE id = ? AND line_account_id = ? LIMIT 1`,
    ).bind(input.eventId, input.lineAccountId).first<{ found: number }>();
    return { found: Boolean(exists), acquired: false };
  }
  const runs = await claimFailedFriendAddActionRuns(db, input.eventId);
  for (const run of runs) {
    try {
      await executeStoredFriendAddAction(db, {
        run,
        friendId: event.friendId,
        lineAccountId: input.lineAccountId,
      });
      await finishFriendAddActionRun(db, { id: run.id, status: 'completed' });
    } catch (error) {
      logger.error("services_friend_add_routing_failed");
      await finishFriendAddActionRun(db, {
        id: run.id,
        status: 'failed',
        errorCode: 'action_failed',
      });
    }
  }
  const status = await finishFriendAddEventActionRetry(db, input);
  if (!status) throw new Error('friend_add_action_retry_not_finalized');
  return { found: true, acquired: true, status, retried: runs.length };
}

export interface FriendAddEnrollment {
  scenarioId: string;
  enrollment: FriendScenario;
  /**
   * 「前回読んだところから」で既にある行を生かした場合 true。
   *
   * **このときは1通目を即時に送ってはいけない。** `pushImmediateFirstStep` は
   * 名前のとおり1通目を出すので、続きから再開した人にもう一度1通目が届く。
   * 再開のぶんは `next_delivery_at` を見て cron が次の通を出す。
   */
  resumed: boolean;
}

export interface FriendAddRoutingResult {
  /** 設定が無く、いままでどおり全部流す場合は false */
  routed: boolean;
  kind: FriendKind | null;
  /** 実際に登録した行 */
  enrollments: FriendAddEnrollment[];
  /** ①の「開始のタイミング」。呼ぶ側が即時に出すかを決める */
  timing: FriendAddTiming;
  /** 「配信しない」を選んでいて何も流さなかった場合 true */
  suppressed: boolean;
  /**
   * 抑止した理由。送信したとき・設定が無いときは null。
   * 呼ぶ側は実行結果（friend_add_events.error_code）へ載せて追跡できる。
   */
  suppressReason: FriendAddSuppressReason | null;
  /** の複数ルールで選ばれた設定と公開版。旧設定ではどちらもnull。 */
  ruleId: string | null;
  ruleVersionId: string | null;
  /** 実行台帳上で失敗した処理数。配信結果とは分けて親台帳を確定する。 */
  actionFailureCount?: number;
  /** 公開ルールのテキスト本文。送信権を持つWebhookが送る。 */
  messageText?: string;
}

export function ruleActions(value: unknown[]): FriendAddAction[] {
  const actions: FriendAddAction[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const action = item as {
      type?: unknown;
      targetId?: unknown;
      tagId?: unknown;
      amount?: unknown;
      value?: unknown;
      op?: unknown;
      kind?: unknown;
      actionType?: unknown;
      config?: Record<string, unknown>;
    };
    // migration 290で旧JSONの共通アクションをそのまま固定した公開版も読める。
    if (action.kind === 'row' && typeof action.actionType === 'string') {
      actions.push({ kind: 'row', actionType: action.actionType as FriendAddRowActionType, config: action.config ?? {} });
      continue;
    }
    if (action.kind === 'tag' && typeof action.tagId === 'string' && action.tagId) {
      actions.push({ kind: 'row', actionType: 'tag', config: { op: 'add', tagIds: [action.tagId] } });
      continue;
    }
    if (action.kind === 'mile' && typeof action.amount === 'number' && action.amount > 0) {
      actions.push({ kind: 'mile', amount: Math.floor(action.amount) });
      continue;
    }
    const targetId = typeof action.targetId === 'string' ? action.targetId : '';
    if (action.type === 'add_tag' && targetId) {
      actions.push({ kind: 'row', actionType: 'tag', config: { op: 'add', tagIds: [targetId] } });
    } else if (action.type === 'remove_tag' && targetId) {
      actions.push({ kind: 'row', actionType: 'tag', config: { op: 'remove', tagIds: [targetId] } });
    } else if (action.type === 'start_scenario' && targetId) {
      actions.push({ kind: 'row', actionType: 'scenario', config: { op: 'start', scenarioId: targetId, restart: 'from_start' } });
      /*
       * F9: 4つの操作は、シナリオと同じ行アクションへ直して実行する。
       * 実行そのものは scenario-actions が担うので、ここでは形を合わせるだけ。
       * 壊れた値はここで落とす（保存側も止めるが、既存の公開版に混ざっていても
       * 実行時には黙って飛ばさず、件数として残す）。
       */
    } else if (action.type === 'set_friend_field' && targetId
      && typeof action.value === 'string') {
      actions.push({
        kind: 'row',
        actionType: 'friend_field',
        config: { fieldId: targetId, op: 'set', value: action.value },
      });
    } else if (action.type === 'add_support_mark' && targetId) {
      actions.push({ kind: 'row', actionType: 'support_mark', config: { markId: targetId } });
    } else if (action.type === 'grant_mileage'
      && typeof action.amount === 'number' && Number.isFinite(action.amount) && action.amount > 0) {
      actions.push({ kind: 'mile', amount: Math.floor(action.amount) });
    } else if (action.type === 'use_common_var' && targetId
      && (action.op === 'add' || action.op === 'sub')
      && typeof action.value === 'string' && Number.isFinite(Number(action.value))) {
      actions.push({
        kind: 'row',
        actionType: 'common_var',
        config: { varKey: targetId, op: action.op, value: action.value },
      });
    }
  }
  return actions;
}

export interface PublishedFriendAddCandidate {
  ruleId: string;
  versionId: string;
  isFallback: boolean;
  definition: FriendAddRuleDefinition;
}

export async function loadPublishedFriendAddCandidates(
  db: D1Database,
  input: { accountId: string; kind: FriendKind; entryRouteId: string | null },
): Promise<PublishedFriendAddCandidate[]> {
  try {
    const result = await db.prepare(
      `SELECT r.id AS rule_id, v.id AS version_id, r.is_unknown_route_fallback AS is_fallback,
              v.definition_snapshot
         FROM friend_add_rules r
         JOIN friend_add_rule_versions v ON v.id = r.current_version_id AND v.status = 'published'
        WHERE r.line_account_id = ? AND r.friend_kind = ?
          AND r.status = 'published' AND r.archived_at IS NULL
          AND (
            (r.is_unknown_route_fallback = 0 AND ? IS NOT NULL AND EXISTS (
              SELECT 1 FROM json_each(v.definition_snapshot, '$.routeIds') WHERE value = ?
            ))
            OR r.is_unknown_route_fallback = 1
          )
          AND (json_extract(v.definition_snapshot, '$.activeFrom') IS NULL
               OR json_extract(v.definition_snapshot, '$.activeFrom') <= strftime('%Y-%m-%dT%H:%M', 'now', '+9 hours'))
          AND (json_extract(v.definition_snapshot, '$.activeUntil') IS NULL
               OR json_extract(v.definition_snapshot, '$.activeUntil') >= strftime('%Y-%m-%dT%H:%M', 'now', '+9 hours'))
        ORDER BY r.is_unknown_route_fallback ASC, r.priority ASC, r.created_at ASC`,
    ).bind(input.accountId, input.kind, input.entryRouteId, input.entryRouteId).all<{
      rule_id: string;
      version_id: string;
      is_fallback: number;
      definition_snapshot: string;
    }>();
    return (result.results ?? []).map((row) => ({
      ruleId: row.rule_id,
      versionId: row.version_id,
      isFallback: row.is_fallback === 1,
      definition: JSON.parse(row.definition_snapshot) as FriendAddRuleDefinition,
    }));
  } catch (error) {
    // DB更新より先にWorkerだけが切り替わった短い時間は、旧設定へ安全に戻す。
    if (error instanceof Error && error.message.includes('no such table: friend_add_rules')) return [];
    throw error;
  }
}

export interface PublishedFriendAddSelection {
  /** 条件をすべて通った公開版。無ければ null。 */
  selected: PublishedFriendAddCandidate | null;
  /** 抑止したときに評価していた公開版（理由の追跡用）。送信時・設定無しは null。 */
  evaluated: PublishedFriendAddCandidate | null;
  reason: FriendAddSuppressReason | null;
}
