import { logger } from '@line-crm/shared/server';
import { readPriority } from '../features/auto-replies/auto-reply-priority/index.js';
import { sqlIdSet } from '@line-crm/db/id-queries';
import type { Context } from 'hono';
import { getAutoReplyById, getTemplateById, autoReplyRowFromDraftSettings, getAutoReplyInternalMemos, parseAutoReplyVersionSettings, jstNow } from '@line-crm/db';
import type { AutoReply as DbAutoReply, AutoReplyDraftSettings, AutoReplyVersionRow } from '@line-crm/db';


import type { Env } from '../worker-env.js';
import { compareAutoReplyCandidates, keywordMatches, parseAutoReplyActions, resolveKeywordRules } from '../features/auto-replies/auto-reply/index.js';
import { validateAutoReplyOperatorAction } from '../features/auto-replies/auto-reply-operator-action/index.js';
import { isScenarioActionComplete } from '../features/scenarios/scenario-actions/index.js';
import { validateFlexContent } from '@line-crm/shared';
import { type DraftReadResult, AUTO_REPLY_KEYWORD_MAX, parseHhmm, parseCooldown, COOLDOWN_RANGE_ERROR, readMessageKinds, readExtras, validateAutoReplyFolder, AUTO_REPLY_RESPONSE_MAX, jsonText, readJson, type AutoReplyConflict, type AutoReplyConflictPair, type AutoReplyValidationResult, type SerializedAutoReply, type EffectiveAccount } from './auto-replies-definition-validate-auto-reply-folder.js';

/** 既存の作成・更新と同じ制約で、公開前の定義だけを読む。 */
export async function readDraftSettings(db: D1Database, raw: unknown, checkReferences = true): Promise<DraftReadResult> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '設定の形式が正しくありません' };
  }
  const body = raw as Record<string, unknown>;
  const respondToAll = body.respondToAll === true;
  const keyword = typeof body.keyword === 'string' ? body.keyword.trim() : '';
  if (!respondToAll && !keyword) {
    return { ok: false, error: '応答する言葉を入力してください' , field: "keyword" };
  }
  if ([...keyword].length > AUTO_REPLY_KEYWORD_MAX) {
    return { ok: false, error: `応答する言葉は${AUTO_REPLY_KEYWORD_MAX}文字までです` , field: "keyword" };
  }
  if (body.matchType !== 'exact' && body.matchType !== 'contains') {
    return { ok: false, error: '言葉の一致方法を選んでください' , field: "matchType" };
  }
  if (typeof body.lineAccountId !== 'string' || !body.lineAccountId) {
    return { ok: false, error: '対象のLINEアカウントを選んでください' , field: "lineAccountId" };
  }
  const activeFrom = parseHhmm(body.activeFrom);
  const activeUntil = parseHhmm(body.activeUntil);
  if (!activeFrom.ok || !activeUntil.ok) {
    return { ok: false, error: '応答する時間を24時間表記で入力してください' , field: "activeFrom" };
  }
  const cooldown = parseCooldown(body.cooldownMinutes);
  if (!cooldown.ok) return { ok: false, error: COOLDOWN_RANGE_ERROR , field: "cooldownMinutes" };
  const priority = readPriority(body.priority ?? 0);
  if (!priority.ok) return { ok: false, error: '優先順位が正しくありません' , field: "priority" };
  const messageKinds = readMessageKinds(body.messageKinds);
  if (!messageKinds.ok) return { ok: false, error: '対象にするメッセージの種類が正しくありません' , field: "messageKinds" };
  const receiveSources = Array.isArray(body.receiveSources)
    ? [...new Set(body.receiveSources)]
    : ['line'];
  if (receiveSources.length === 0
    || receiveSources.some((source) => source !== 'line' && source !== 'email')) {
    return { ok: false, error: '受信元はLINEまたはメールを1つ以上選んでください' , field: "receiveSources" };
  }
  const extras = readExtras(body);
  if (!extras.ok) return { ok: false, error: extras.error , field: extras.field };
  // 絞り込みと後続処理は小さな設定のはず。際限なく大きいとDB肥大と描画肥大を招く。
  for (const [key, label] of [['friendConditions', '絞り込み条件'], ['actions', '応答したあとの処理']] as const) {
    const raw = extras.value[key];
    if (raw !== undefined && raw !== null && JSON.stringify(raw).length > 20000) {
      return { ok: false, error: `${label}が大きすぎます` , field: key };
    }
  }
  const folderError = checkReferences ? await validateAutoReplyFolder(db, extras.value.folderId) : null;
  if (folderError) return { ok: false, error: folderError, field: "folderId" };
  if (extras.value.actions) {
    const parsedActions = parseAutoReplyActions(JSON.stringify(extras.value.actions));
    if (parsedActions.length !== extras.value.actions.length) {
      return { ok: false, error: '応答したあとにすることの設定を確認してください' , field: "actions" };
    }
    for (const action of parsedActions) {
      const error = checkReferences ? await validateAutoReplyOperatorAction(db,action,body.lineAccountId as string,false) : null;
      if (error) return {ok:false,error, field: "actions"};
    }
    // 失敗したら止めるか続けるかは stop/continue のどちらかだけ受け付ける。
    // 読めない値は実行側が続けるに倒すが、保存時には書き直しを促す。
    for (const [index, item] of (extras.value.actions as unknown[]).entries()) {
      const raw = (item as Record<string, unknown> | null)?.onFailure
        ?? (item as Record<string, unknown> | null)?.on_failure;
      if (raw !== undefined && raw !== 'stop' && raw !== 'continue') {
        return { ok: false, error: `${index + 1}つ目の失敗したときの設定を確認してください` , field: "actions" };
      }
    }
  }

  const templateId = typeof body.templateId === 'string' && body.templateId ? body.templateId : null;
  let responseType = typeof body.responseType === 'string' && body.responseType ? body.responseType : 'text';
  let responseContent = typeof body.responseContent === 'string' ? body.responseContent : '';
  let templateLineAccountId: string | null = null;
  if (templateId && checkReferences) {
    const template = await getTemplateById(db, templateId);
    if (template?.message_bubbles_json) return {ok:false,error:'複数通のテンプレートは一斉配信から選んでください',field:'templateId'};
    if (!template) return { ok: false, error: '選んだテンプレートを確認できません' , field: "templateId" };
    templateLineAccountId = template.line_account_id ?? null;
    if (!responseType) responseType = template.message_type;
    if (!responseContent) responseContent = template.message_content;
  }
  if (responseType !== 'silent' && !templateId && !responseContent) {
    return { ok: false, error: '返信する内容を入力してください' , field: "responseContent" };
  }
  // LINEのテキスト上限と同じ基準。試し文の2000字より緩いが、保存文の上限として見る。
  if ([...responseContent].length > AUTO_REPLY_RESPONSE_MAX) {
    return { ok: false, error: `返信する内容は${AUTO_REPLY_RESPONSE_MAX.toLocaleString('ja-JP')}文字までです` , field: "responseContent" };
  }
  /*
   * カードはJSONとして読めるだけでは足りない。`{}` のような構造のない
   * 内容は送信時に落ちるだけなので、保存の側で止める。テンプレートから
   * 写した中身はテンプレート側の検査に任せ、直接入力だけここで見る。
   */
  if (!templateId) {
    const flexError = validateFlexContent(responseType, responseContent);
    if (flexError) return { ok: false, error: flexError , field: "responseContent" };
  }

  return {
    ok: true,
    templateLineAccountId,
    value: {
      keyword,
      matchType: body.matchType,
      responseType,
      responseContent,
      templateId,
      lineAccountId: body.lineAccountId,
      activeFrom: activeFrom.value,
      activeUntil: activeUntil.value,
      cooldownMinutes: cooldown.value,
      skipWhenOperatorActive: body.skipWhenOperatorActive === true,
      priority: priority.value,
      messageKinds: jsonText(messageKinds.value),
      receiveSources: receiveSources as Array<'line' | 'email'>,
      friendConditions: jsonText(extras.value.friendConditions),
      actions: jsonText(extras.value.actions),
      responseWeekdays: jsonText(extras.value.responseWeekdays),
      responseHolidayRule: extras.value.responseHolidayRule ?? null,
      oncePerFriend: extras.value.oncePerFriend === true,
      keywords: jsonText(extras.value.keywords),
      respondToAll,
      name: extras.value.name ?? null,
      normalizeKeywords: extras.value.normalizeKeywords !== false,
      keywordMatchMode: extras.value.keywordMatchMode ?? 'any',
      folderId: extras.value.folderId ?? null,
      internalMemo: extras.value.internalMemo ?? null,
      replyDelaySeconds: extras.value.replyDelaySeconds ?? null,
      unmatchedAction: jsonText(extras.value.unmatchedAction),
    },
  };
}

export function messageKindsOverlap(a: DbAutoReply, b: DbAutoReply): boolean {
  const aKinds = readJson<string[]>(a.message_kinds_json);
  const bKinds = readJson<string[]>(b.message_kinds_json);
  if (!aKinds?.length || !bKinds?.length) return true;
  return aKinds.some((kind) => bKinds.includes(kind));
}

export function conflictSamples(a: DbAutoReply, b: DbAutoReply): string[] {
  const aWords = resolveKeywordRules(a).map((item) => item.keyword);
  const bWords = resolveKeywordRules(b).map((item) => item.keyword);
  return [
    ...aWords,
    ...bWords,
    aWords.join(' '),
    bWords.join(' '),
    [...aWords, ...bWords].join(' '),
    '確認用のメッセージ',
  ].filter(Boolean);
}

export function hasConditionalScope(rule: DbAutoReply): boolean {
  return Boolean(
    rule.active_from
    || rule.active_until
    || rule.response_weekdays_json
    || rule.friend_conditions_json
    || rule.once_per_friend
    || rule.cooldown_minutes
    || rule.skip_when_operator_active,
  );
}

export function conflictBetween(draft: DbAutoReply, other: DbAutoReply): AutoReplyConflict | null {
  if (!messageKindsOverlap(draft, other)) return null;
  const overlaps = conflictSamples(draft, other).some(
    (sample) => keywordMatches(draft, sample) && keywordMatches(other, sample),
  );
  const bothContain = resolveKeywordRules(draft).some((item) => item.matchType === 'contains')
    && resolveKeywordRules(other).some((item) => item.matchType === 'contains');
  if (!overlaps && !bothContain) return null;
  const winner = [draft, other].sort(compareAutoReplyCandidates)[0]!;
  const conditional = hasConditionalScope(draft) || hasConditionalScope(other);
  return {
    autoReplyId: other.id,
    name: other.name || other.keyword || '名前は未設定',
    certainty: overlaps && !conditional ? 'certain' : 'possible',
    winnerAutoReplyId: winner.id,
    reason: conditional
      ? '言葉が重なります。曜日・時間・友だち条件によって動く方が変わります。'
      : winner.id === draft.id
        ? '同じメッセージに当たり、この下書きが先に動きます。'
        : '同じメッセージに当たり、既存の自動応答が先に動きます。',
  };
}

export async function activeRulesWithDraft(
  db: D1Database,
  autoReplyId: string,
  settings: AutoReplyDraftSettings,
): Promise<DbAutoReply[]> {
  const active = await db.prepare(
    `SELECT * FROM auto_replies
      WHERE is_active = 1 AND deleted_at IS NULL
        AND (line_account_id IS NULL OR line_account_id = ?)
      ORDER BY priority ASC, respond_to_all ASC, created_at ASC`,
  ).bind(settings.lineAccountId).all<DbAutoReply>();
  const existing = await getAutoReplyById(db, autoReplyId);
  const draft = autoReplyRowFromDraftSettings(
    autoReplyId,
    settings,
    existing?.created_at ?? jstNow(),
  );
  draft.is_active = 1;
  return [...active.results.filter((item) => item.id !== autoReplyId), draft]
    .sort(compareAutoReplyCandidates);
}

export async function conflictsForDraft(
  db: D1Database,
  autoReplyId: string,
  settings: AutoReplyDraftSettings,
): Promise<AutoReplyConflict[]> {
  const candidates = await activeRulesWithDraft(db, autoReplyId, settings);
  const draft = candidates.find((item) => item.id === autoReplyId)!;
  return candidates
    .filter((item) => item.id !== autoReplyId)
    .map((item) => conflictBetween(draft, item))
    .filter((item): item is AutoReplyConflict => item !== null);
}

export /*
 * F7: 作成する前の仮の行と、現在有効なルールを当てる。
 * まだ行が無いので ID は仮。競合の有無だけを見て、有効化の可否を決める。
 * 共通（lineAccountId null）は全部のアカウントに届くので、有効な全件と当てる。
 */
async function conflictsForCreate(
  db: D1Database,
  settings: AutoReplyDraftSettings,
): Promise<AutoReplyConflict[]> {
  const active = settings.lineAccountId == null
    ? await db.prepare(
      `SELECT * FROM auto_replies
         WHERE is_active = 1 AND deleted_at IS NULL
         ORDER BY priority ASC, respond_to_all ASC, created_at ASC`,
    ).all<DbAutoReply>()
    : await db.prepare(
      `SELECT * FROM auto_replies
         WHERE is_active = 1 AND deleted_at IS NULL
           AND (line_account_id IS NULL OR line_account_id = ?)
         ORDER BY priority ASC, respond_to_all ASC, created_at ASC`,
    ).bind(settings.lineAccountId).all<DbAutoReply>();
  const candidate = autoReplyRowFromDraftSettings('__create_pending__', settings, jstNow());
  candidate.is_active = 1;
  return (active.results ?? [])
    .map((item) => conflictBetween(candidate, item))
    .filter((item): item is AutoReplyConflict => item !== null);
}

export function conflictPairs(rules: DbAutoReply[]): AutoReplyConflictPair[] {
  const pairs: AutoReplyConflictPair[] = [];
  for (let leftIndex = 0; leftIndex < rules.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < rules.length; rightIndex += 1) {
      const left = rules[leftIndex]!;
      const right = rules[rightIndex]!;
      const conflict = conflictBetween(left, right);
      if (!conflict) continue;
      pairs.push({
        leftAutoReplyId: left.id,
        rightAutoReplyId: right.id,
        winnerAutoReplyId: conflict.winnerAutoReplyId,
        certainty: conflict.certainty,
        reason: conflict.reason,
      });
    }
  }
  return pairs;
}

export function conflictCounts(pairs: AutoReplyConflictPair[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const pair of pairs) {
    counts.set(pair.leftAutoReplyId, (counts.get(pair.leftAutoReplyId) ?? 0) + 1);
    counts.set(pair.rightAutoReplyId, (counts.get(pair.rightAutoReplyId) ?? 0) + 1);
  }
  return counts;
}

export async function actionExecutionCounts(
  db: D1Database,
  accountId: string | null,
): Promise<Map<string, number>> {
  const result = await db.prepare(
    `SELECT e.winning_auto_reply_id AS auto_reply_id, COUNT(*) AS action_count
       FROM auto_reply_action_runs action_run
       JOIN auto_reply_evaluations e ON e.id = action_run.evaluation_id
      WHERE action_run.status = 'succeeded'
        AND e.winning_auto_reply_id IS NOT NULL
        AND (? IS NULL OR e.line_account_id = ?)
      GROUP BY e.winning_auto_reply_id`,
  ).bind(accountId, accountId).all<{ auto_reply_id: string; action_count: number }>();
  return new Map((result.results ?? [])
    .filter((row) => typeof row.auto_reply_id === 'string')
    .map((row) => [row.auto_reply_id, Number(row.action_count)]));
}

export async function autoReplyReceiveSummary(
  db: D1Database,
  accountId: string,
  since: string,
): Promise<{
    receiveSourceCounts: Array<{ source: string; count: number }>;
    matchedLast28Days: number;
  }> {
  const [sources, matched] = await Promise.all([
    db.prepare(
      `SELECT message_kind AS source, COUNT(*) AS count
         FROM auto_reply_evaluations
        WHERE line_account_id = ? AND evaluated_at >= ?
        GROUP BY message_kind
        ORDER BY count DESC, message_kind ASC`,
    ).bind(accountId, since).all<{ source: string; count: number }>(),
    db.prepare(
      `SELECT COUNT(*) AS count
         FROM auto_reply_evaluations
        WHERE line_account_id = ? AND evaluated_at >= ?
          AND winning_auto_reply_id IS NOT NULL`,
    ).bind(accountId, since).first<{ count: number }>(),
  ]);
  return {
    receiveSourceCounts: (sources.results ?? []).map((row) => ({
      source: row.source,
      count: Number(row.count),
    })),
    matchedLast28Days: Number(matched?.count ?? 0),
  };
}

export async function validateDraft(
  db: D1Database,
  version: AutoReplyVersionRow,
): Promise<AutoReplyValidationResult> {
  const settings = parseAutoReplyVersionSettings(version);
  const errors: string[] = [];
  if (!settings.lineAccountId) errors.push('対象のLINEアカウントを選んでください');
  if (!settings.respondToAll && !settings.keyword) errors.push('応答する言葉を入力してください');
  if (settings.responseType !== 'silent' && !settings.templateId && !settings.responseContent) {
    errors.push('返信する内容を入力してください');
  }
  if (settings.templateId && !await getTemplateById(db, settings.templateId)) {
    errors.push('選んだテンプレートを確認できません');
  }
  for (const action of parseAutoReplyActions(settings.actions)) {
    if (action.action_type === 'notify_staff') {
      const error = await validateAutoReplyOperatorAction(db,action,settings.lineAccountId ?? '',true);
      if (error) errors.push(error);
    } else if (action.action_type === 'tag') {
      let config: Record<string,unknown> = {}; try { config=JSON.parse(action.config_json) } catch {}
      if (!isScenarioActionComplete('tag',config)) errors.push('応答後に付けるタグを選んでください');
      if (Array.isArray(config.tagIds)) for (const id of config.tagIds) {
        if (typeof id !== 'string' || !await db.prepare('SELECT id FROM tags WHERE id = ? AND line_account_id = ?').bind(id,settings.lineAccountId).first()) errors.push('応答後に付けるタグが対象アカウントにありません');
      }
    }
  }
  const conflicts = await conflictsForDraft(db, version.auto_reply_id, settings);
  return {
    valid: errors.length === 0,
    errors,
    warnings: conflicts.length > 0
      ? ['同じメッセージに当たる自動応答があります。実際の相手と文面で試してください。']
      : [],
    conflicts,
    lastTestStatus: version.last_test_status,
  };
}

export function validIdempotencyKey(value: string | undefined): value is string {
  return Boolean(value && value.length >= 8 && value.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(value));
}

export /*
 * m26c /: 作成・複製の確認キー。ヘッダで受け、形が正しいときだけ
 * 重複防止に使う。無い・壊れているときは従来どおり作る（後方互換）。
 */
function readIdempotencyKey(c: Context<Env>): string | undefined {
  const raw = c.req.header('Idempotency-Key');
  return validIdempotencyKey(raw) ? raw : undefined;
}

export /** 要求キー台帳の失敗を応答へ寄せる。該当なしは null。 */
function idempotencyErrorResponse(err: unknown): { status: 409; error: string } | null {
  const code = err instanceof Error ? err.message : '';
  if (code === 'AUTO_REPLY_IDEMPOTENCY_CONFLICT'
    || code === 'AUTO_REPLY_IDEMPOTENCY_OPERATION_CONFLICT') {
    return {
      status: 409,
      error: '同じ確認キーに異なる内容が送られました。一覧を確認してください',
    };
  }
  // 同時実行の負け側で勝者がまだ確定していない。作り直しは起きないので再送を求める。
  if (code.includes('auto_reply_create_requests') && /unique constraint/i.test(code)) {
    return { status: 409, error: '処理中です。もう一度お試しください' };
  }
  return null;
}

export function serializeAutoReply(
  row: DbAutoReply,
  internalMemo: string | null = null,
): SerializedAutoReply {
  return {
    id: row.id,
    keyword: row.keyword,
    matchType: row.match_type,
    responseType: row.response_type,
    responseContent: row.response_content,
    templateId: row.template_id,
    lineAccountId: row.line_account_id,
    isActive: Boolean(row.is_active),
    activeFrom: row.active_from,
    activeUntil: row.active_until,
    cooldownMinutes: row.cooldown_minutes,
    skipWhenOperatorActive: Boolean(row.skip_when_operator_active),
    priority: Number(row.priority ?? 0),
    messageKinds: row.message_kinds_json
      ? (JSON.parse(row.message_kinds_json) as string[])
      : null,
    receiveSources: ['line'],
    actions: readJson<unknown[]>(row.actions_json),
    responseWeekdays: readJson<number[]>(row.response_weekdays_json),
    responseHolidayRule: row.response_holiday_rule,
    oncePerFriend: Boolean(row.once_per_friend),
    keywords: readJson<unknown[]>(row.keywords_json),
    friendConditions: readJson<unknown>(row.friend_conditions_json),
    respondToAll: Boolean(row.respond_to_all),
    name: row.name,
    keywordMatchMode: row.keyword_match_mode ?? 'any',
    folderId: row.folder_id,
    internalMemo,
    lifecycleStatus: row.lifecycle_status ?? 'published',
    confirmationRevision: Number(row.confirmation_revision ?? 1),
    stoppedAt: row.stopped_at ?? null,
    stoppedByStaffId: row.stopped_by_staff_id ?? null,
    stoppedByStaffName: null,
    stopReason: row.stop_reason ?? null,
    createdAt: row.created_at,
  };
}

export /**
 * 社内メモを編集画面と同じ版（下書き優先、無ければ公開版）から引く。
 * 読めなくても一覧・詳細そのものは落とさない——付随情報なので。
 */
async function internalMemosOf(
  db: D1Database,
  autoReplyIds: string[],
): Promise<Map<string, string | null>> {
  try {
    return await getAutoReplyInternalMemos(db, autoReplyIds);
  } catch (err) {
    logger.error("auto_replies.internal_memos_of_failed");
    return new Map();
  }
}

export /** 停止した担当者の表示名を引く。止めた記録が無い一覧では1問も投げない。 */
async function resolveStoppedByNames(
  db: D1Database,
  items: SerializedAutoReply[],
): Promise<void> {
  const ids = [...new Set(
    items.map((item) => item.stoppedByStaffId).filter((id): id is string => Boolean(id)),
  )];
  if (ids.length === 0) return;
  try {
    const rows = await db.prepare(
      `SELECT id, name FROM staff_members WHERE id IN (${sqlIdSet(ids).sql})`,
    ).bind(...(ids.length ? sqlIdSet(ids).binds : [])).all<{ id: string; name: string }>();
    const nameById = new Map((rows.results ?? []).map((row) => [row.id, row.name]));
    for (const item of items) {
      item.stoppedByStaffName = item.stoppedByStaffId
        ? nameById.get(item.stoppedByStaffId) ?? null
        : null;
    }
  } catch (err) {
    // 名前が引けなくても一覧は出す。ID そのものは画面に出さず null のままにする。
    logger.error("auto_replies.resolve_stopped_by_names_failed");
  }
}

export /**
 * 全 active LINE accounts と全 active automations を一発で取って、各 auto_reply の
 * 「実際にどのアカで返信するか」を計算する。auto_reply の line_account_id が null
 * なら全アカ対象、specific なら対象 1 アカのみ。返信は inline (silent 以外) または
 * 同 keyword の automation rule (event_type='message_received') で起きる。
 */
async function computeEffectiveAccounts(
  db: D1Database,
  rule: DbAutoReply,
  accounts: Array<{ id: string; name: string }>,
  automationsByKeyword: Map<string, Set<string>>,  // keyword -> set of account_ids that have rule
): Promise<EffectiveAccount[]> {
  return accounts.map((acc) => {
    // line_account_id が specific なら対象アカ以外は適用外
    if (rule.line_account_id && rule.line_account_id !== acc.id) {
      return { accountId: acc.id, accountName: acc.name, status: 'not_applicable', via: null };
    }
    // inline 返信 (text / flex / image)
    if (rule.response_type !== 'silent') {
      return { accountId: acc.id, accountName: acc.name, status: 'reply', via: 'inline' };
    }
    // silent: 同 keyword の automation rule が同アカに存在すれば返信、無ければ silent only
    const automationAccs = automationsByKeyword.get(rule.keyword);
    if (automationAccs?.has(acc.id)) {
      return { accountId: acc.id, accountName: acc.name, status: 'reply', via: 'automation' };
    }
    return { accountId: acc.id, accountName: acc.name, status: 'silent', via: null };
  });
}

export async function buildAutomationKeywordIndex(db: D1Database): Promise<Map<string, Set<string>>> {
  // event_type='message_received' で keyword を持ち、send_message を含む automation を全件取って
  // keyword -> set<account_id> のインデックス化。
  const res = await db
    .prepare(`SELECT line_account_id, conditions, actions FROM automations WHERE is_active = 1 AND event_type = 'message_received'`)
    .all<{ line_account_id: string | null; conditions: string; actions: string }>();
  const idx = new Map<string, Set<string>>();
  for (const r of res.results ?? []) {
    if (!r.line_account_id) continue;  // 画面はアカウント単位を前提とするため、全体ルールは除く。
    let keyword: string | null = null;
    try {
      const c = JSON.parse(r.conditions) as { keyword?: string; keyword_exact?: string };
      keyword = c.keyword ?? c.keyword_exact ?? null;
    } catch { continue; }
    if (!keyword) continue;
    // send_message action があるか
    let hasSendMessage = false;
    try {
      const acts = JSON.parse(r.actions) as Array<{ type: string }>;
      hasSendMessage = acts.some((a) => a.type === 'send_message');
    } catch { continue; }
    if (!hasSendMessage) continue;
    const set = idx.get(keyword) ?? new Set<string>();
    set.add(r.line_account_id);
    idx.set(keyword, set);
  }
  return idx;
}

export /** 停止の理由は任意。長文は理由というよりメモなので上限を付ける。 */
const AUTO_REPLY_STOP_REASON_MAX = 500;
