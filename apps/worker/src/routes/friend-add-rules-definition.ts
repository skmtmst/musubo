import { jstDate as japanDate, jstCalendar as japanCalendar } from '@line-crm/shared';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { inputError } from '../lib/input-errors.js';
import type { Context } from 'hono';
import { getFriendAddRule, listFriendAddRules, recordFriendAddRuleTest, type FriendAddRuleDefinition, type FriendAddRuleKind, type FriendAddRuleRow } from '@line-crm/db';

import type { Env } from '../worker-env.js';
import { getVisibleLineAccountScope } from '../services/account-access.js';
import { collectFriendAddReferences, evaluateFriendAddRuleConditions, evaluateFriendAddSchedule, findFriendAddUnusableReferences, friendAddJstHhmm, hasInvalidFriendAddTimeWindows, isValidFriendAddHhmm, parseFriendAddConditionAst } from '../features/friends/friend-add-routing/index.js';
import { type FriendAddSuppressReason } from '../features/friends/friend-add-routing-pick-string/index.js';
import { toJstParts } from '@line-crm/shared';

export const KINDS = new Set<FriendAddRuleKind>(['first_time', 'returning']);
export const RULE_STATUSES = new Set(['draft', 'published', 'stopped', 'archived']);
export const MESSAGE_TYPES = new Set(['text', 'template', 'form', 'scenario']);
export const TIMINGS = new Set(['immediate', 'scenario']);
export const ACTION_TYPES = new Set([
  'add_tag',
  'remove_tag',
  'start_scenario',
  // F9: 友だち情報を入れる・対応マークを付ける・マイルを渡す・共通情報を使う。
  'set_friend_field',
  'add_support_mark',
  'grant_mileage',
  'use_common_var',
]);

export type RuleInput = {
  accountId?: string;
  friendKind?: FriendAddRuleKind;
  name?: string;
  folderName?: string | null;
  priority?: number;
  definition?: Partial<FriendAddRuleDefinition>;
  version?: number;
};

export type RuleTestInput = {
  accountId?: string;
  ruleId?: string;
  friendKind?: FriendAddRuleKind;
  routeId?: string | null;
  expectedAt?: string | null;
  friendId?: string | null;
};

export function accountIdFrom(c: Context<Env>, body?: RuleInput): string | null {
  return c.req.query('account_id') || body?.accountId || null;
}

export async function canUseAccount(c: Context<Env>, accountId: string): Promise<boolean> {
  const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
  return scope.ids.includes(accountId);
}

export function parseSnapshot(value: string | null): FriendAddRuleDefinition {
  const raw = value ? JSON.parse(value) as Partial<FriendAddRuleDefinition> : {};
  return normalizeDefinition(raw);
}

export function safeActionErrorCode(value: string | null): string | null {
  return value === 'action_failed' ? value : (value ? 'action_failed' : null);
}

export function normalizeDefinition(raw: Partial<FriendAddRuleDefinition> | undefined): FriendAddRuleDefinition {
  const definition = raw ?? {};
  const messageType = MESSAGE_TYPES.has(String(definition.messageType))
    ? definition.messageType as FriendAddRuleDefinition['messageType']
    : 'text';
  const timing = TIMINGS.has(String(definition.timing))
    ? definition.timing as FriendAddRuleDefinition['timing']
    : 'immediate';
  const actions = Array.isArray(definition.actions)
    ? definition.actions.filter((action) => {
      if (!action || typeof action !== 'object') return false;
      const type = (action as { type?: unknown }).type;
      return typeof type === 'string' && ACTION_TYPES.has(type);
    })
    : [];
  const deliveryChoices = definition.deliveryChoices && typeof definition.deliveryChoices === 'object'
    ? {
        sendWelcomeMessage: definition.deliveryChoices.sendWelcomeMessage === true,
        startScenario: definition.deliveryChoices.startScenario !== false,
        runActions: definition.deliveryChoices.runActions !== false,
      }
    : {
        sendWelcomeMessage: messageType !== 'scenario',
        startScenario: true,
        runActions: true,
      };
  const resendSuppressionHours = definition.resendSuppressionHours == null
    ? 24
    : Math.max(0, Math.min(720, Math.floor(Number(definition.resendSuppressionHours))));
  const unknownRouteAction = definition.unknownRouteAction && typeof definition.unknownRouteAction === 'object'
    ? {
        sendCommonGuidance: definition.unknownRouteAction.sendCommonGuidance === true,
        notifyStaff: definition.unknownRouteAction.notifyStaff === true,
      }
    : { sendCommonGuidance: true, notifyStaff: false };
  const weekdays = Array.isArray(definition.weekdays)
    ? [...new Set(definition.weekdays.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6))]
    : [];
  /*
   * 時間帯は生のまま残す（落とさない）。99:99 や壊れた値をここで落とすと
   * 「制限なし」に読み替わり、送ってはいけない相手に送ってしまう。
   * 保存側の validateInput が新規の不正値を拒否し、既に入った不正値は
   * 実行時が fail-closed で止める。
   */
  const timeWindows = definition.timeWindows as { start: string; end: string }[] | undefined;
  return {
    routeIds: Array.isArray(definition.routeIds)
      ? definition.routeIds.filter((id): id is string => typeof id === 'string' && Boolean(id))
      : [],
    scenarioId: typeof definition.scenarioId === 'string' && definition.scenarioId
      ? definition.scenarioId
      : null,
    messageType,
    messageText: typeof definition.messageText === 'string' ? definition.messageText.slice(0, 5000) : '',
    timing,
    actions,
    friendCondition: typeof definition.friendCondition === 'string'
      ? definition.friendCondition.slice(0, 1000)
      : '',
    internalMemo: typeof definition.internalMemo === 'string'
      ? definition.internalMemo.slice(0, 2000)
      : undefined,
    activeFrom: typeof definition.activeFrom === 'string' && definition.activeFrom ? definition.activeFrom : null,
    activeUntil: typeof definition.activeUntil === 'string' && definition.activeUntil ? definition.activeUntil : null,
    returningMode: definition.returningMode === 'none' || definition.returningMode === 'same' || definition.returningMode === 'other'
      ? definition.returningMode
      : undefined,
    startPosition: definition.startPosition === 'beginning' || definition.startPosition === 'resume'
      ? definition.startPosition
      : undefined,
    deliveryChoices,
    resendSuppressionHours,
    unknownRouteAction,
    weekdays,
    timeWindows,
  };
}

export async function loadOptions(db: D1Database, accountId: string) {
  const [routeRows, scenarioRows, tagRows, folderRows] = await Promise.all([
    db.prepare(
      `SELECT id, name, COALESCE(genre, '未分類') AS kind
         FROM entry_routes
        WHERE is_active = 1 AND (
          line_account_id = ? OR (
            line_account_id IS NULL
            AND tenant_id = (SELECT tenant_id FROM line_accounts WHERE id = ?)
          )
        )
        ORDER BY name ASC`,
    ).bind(accountId, accountId).all<{ id: string; name: string; kind: string }>(),
    db.prepare(
      `SELECT id, name FROM scenarios
        WHERE line_account_id = ? AND is_active = 1
        ORDER BY name ASC`,
    ).bind(accountId).all<{ id: string; name: string }>(),
    db.prepare(
      `SELECT id, name FROM tags
        WHERE line_account_id = ?
        ORDER BY name ASC`,
    ).bind(accountId).all<{ id: string; name: string }>(),
    db.prepare(
      `SELECT id, name, color FROM friend_add_rule_folders
        WHERE line_account_id = ? ORDER BY name ASC, id ASC`,
    ).bind(accountId).all<{ id: string; name: string; color: string | null }>(),
  ]);
  return {
    routes: routeRows.results ?? [],
    scenarios: scenarioRows.results ?? [],
    tags: tagRows.results ?? [],
    folders: folderRows.results ?? [],
  };
}

export function toRule(row: FriendAddRuleRow, routeNames: Map<string, string>, scenarioNames: Map<string, string>) {
  const definition = parseSnapshot(row.definition_snapshot);
  return {
    id: row.id,
    accountId: row.line_account_id,
    friendKind: row.friend_kind,
    name: row.name,
    folderName: row.folder_name,
    priority: row.priority,
    isFallback: row.is_unknown_route_fallback === 1,
    status: row.status,
    versionId: row.version_id,
    versionNumber: row.version_number,
    versionStatus: row.version_status,
    lastTestStatus: row.last_test_status,
    lastTestedAt: row.last_tested_at,
    lastTestedByStaffId: row.last_tested_by_staff_id,
    lastTestedByStaffName: row.last_tested_by_staff_name,
    publishedAt: row.published_at,
    matchedLast7Days: row.matched_last_7_days,
    version: row.lock_version,
    definition,
    routeNames: definition.routeIds.map((id) => routeNames.get(id) ?? '削除済みの流入リンク'),
    scenarioName: definition.scenarioId ? scenarioNames.get(definition.scenarioId) ?? '削除済みのシナリオ' : null,
  };
}

export type ConditionAstError = Exclude<ReturnType<typeof parseFriendAddConditionAst>, { ok: true }>['error'];

export /**
 * 条件が読めなかった理由を、設定した人が直せる言葉にする。
 * 旧形式の自由文（`legacy_text`）はここに無い。保存を止めないため。
 */
const CONDITION_AST_MESSAGES: Record<Exclude<ConditionAstError, 'legacy_text'>, string> = {
  not_json: '友だち条件のJSONが壊れています。条件ビルダーで作り直してください。',
  not_object: '友だち条件の形が正しくありません。条件ビルダーで作り直してください。',
  bad_operator: '友だち条件の「すべて／いずれか」の指定が抜けているグループがあります。',
  bad_rules: '友だち条件の中に、条件の一覧が入っていないグループがあります。',
  bad_rule: '友だち条件に、使えない条件が含まれています。',
  bad_groups: '友だち条件の入れ子グループの形が正しくありません。',
  too_deep: '友だち条件の入れ子が深すぎます。もっと浅い形にしてください。',
  too_large: '友だち条件が大きすぎます。条件の数を減らしてください。',
  unbuildable: '友だち条件に、値が足りない条件があります。',
};

export function validateInput(body: RuleInput): string | null {
  if (!body.name?.trim()) return '設定名が必要です';
  if (body.name.trim().length > 60) return '設定名は60文字以内で入力してください';
  if (!body.friendKind || !KINDS.has(body.friendKind)) return '判定する人が正しくありません';
  if (!Number.isInteger(body.priority) || Number(body.priority) < 1) return '優先順位は1以上の整数で入力してください';
  // 不正な時間帯（99:99 など）は保存させない。落として保存すると
  // 「制限なし」に読み替わり、送ってはいけない相手に送ってしまう。
  const timeWindows = body.definition?.timeWindows;
  if (timeWindows != null) {
    if (!Array.isArray(timeWindows)) return '時間帯の指定が正しくありません';
    for (const window of timeWindows) {
      const start = (window as { start?: unknown } | null)?.start;
      const end = (window as { end?: unknown } | null)?.end;
      if (!isValidFriendAddHhmm(start) || !isValidFriendAddHhmm(end)) {
        return '時間帯は00:00〜23:59の形で入力してください';
      }
    }
  }
  /*
   * 友だち条件は入れ子まで検証する。入れ子グループの operator を省いた形は
   * 実行時に OR へ読み替わり、「両方を満たす人だけ」のつもりが
   * 「どちらかを満たす人すべて」へ広がる。保存させない。
   */
  const conditionAst = parseFriendAddConditionAst(body.definition?.friendCondition);
  /*
   * 旧形式の自由文だけは保存を止めない。止めると、その設定の名前や
   * 時間帯すら直せなくなる。配信は実行時に止め、画面で作り直しを促す。
   */
  if (!conditionAst.ok && conditionAst.error !== 'legacy_text') {
    return CONDITION_AST_MESSAGES[conditionAst.error];
  }
  /*
   * F9: 4つの操作は形が壊れていると実行時に黙って飛ぶだけになる。
   * 保存の側で止める（下書きも含む。壊れた値を残すと公開前確認でも
   * 理由が「参照先」だけになり、何が悪いか分からなくなる）。
   */
  const actions = body.definition?.actions;
  if (actions != null) {
    if (!Array.isArray(actions)) return 'することの指定が正しくありません';
    for (const raw of actions) {
      const action = (raw ?? {}) as { type?: unknown; targetId?: unknown; value?: unknown; amount?: unknown; op?: unknown };
      switch (action.type) {
        case 'set_friend_field':
          if (typeof action.targetId !== 'string' || !action.targetId) {
            return '入れる友だち情報の項目を選んでください';
          }
          if (typeof action.value !== 'string' || [...action.value].length > 2000) {
            return '入れる値は2000文字までの文字で入力してください';
          }
          break;
        case 'add_support_mark':
          if (typeof action.targetId !== 'string' || !action.targetId) {
            return '付ける対応マークを選んでください';
          }
          break;
        case 'grant_mileage':
          if (!Number.isInteger(action.amount) || (action.amount as number) < 1 || (action.amount as number) > 1000000) {
            return '渡すマイルは1〜1000000の整数で入力してください';
          }
          break;
        case 'use_common_var':
          if (typeof action.targetId !== 'string' || !action.targetId) {
            return '使う共通情報を選んでください';
          }
          if (action.op !== 'add' && action.op !== 'sub') {
            return '共通情報の足し引きの向きを選んでください';
          }
          if (typeof action.value !== 'string' || !Number.isFinite(Number(action.value))) {
            return '共通情報に足し引きする数は数字で入力してください';
          }
          break;
        default:
          break;
      }
    }
  }
  return null;
}

export type ReferenceErrorKey = 'first_time' | 'returning' | 'actions';

export type FriendAddRuleReferenceError = {
  key: ReferenceErrorKey;
  message: string;
};

export async function validateReferences(
  db: D1Database,
  accountId: string,
  definition: FriendAddRuleDefinition,
  friendKind: FriendAddRuleKind,
  options?: { allowIncomplete?: boolean; isFallback?: boolean },
): Promise<FriendAddRuleReferenceError[]> {
  const messages: FriendAddRuleReferenceError[] = [];
  const push = (key: ReferenceErrorKey, message: string) => {
    messages.push({ key, message });
  };
  /*
   * テスト・公開前確認では「そもそも動かない設定」をここで止める。
   * 下書き保存（allowIncomplete）は未完成を許すので対象外。
   * 実行側は routeIds の中身だけで拾う（EXISTS json_each）ため、
   * 空は「全部に届く」ではなく「どこにも届かない」。
   */
  if (!options?.allowIncomplete) {
    if (!options?.isFallback && definition.routeIds.length === 0) {
      push(friendKind, '対象の流入リンクが選ばれていません。流入条件で1つ以上選んでください。');
    }
    /*
     * 期限切れの設定は公開しても1件も動かない。有効期間はJSTの壁時計
     * （DateTimeField の値と振り分けSQLの `+9 hours` が同じ形）。
     */
    const nowJst = `${toJstParts(new Date()).date}T${friendAddJstHhmm(new Date())}`;
    // 実行側は `activeUntil >= now` で拾う（終了時刻ちょうどはまだ対象）。
    if (definition.activeUntil && definition.activeUntil < nowJst) {
      push(friendKind, '有効期間の終了時刻が過ぎています。終了を延ばすか、この設定を消してください。');
    }
    if (hasInvalidFriendAddTimeWindows(definition.timeWindows)) {
      push(friendKind, '配信する時間帯に読めない値があります。時間帯を入れ直してください。');
    }
    /*
     * 読めない友だち条件は実行時に fail-closed で止まる。
     * 旧形式の自由文は保存だけは許す（直せるように）ので、ここで理由を出す。
     */
    const conditionAst = parseFriendAddConditionAst(definition.friendCondition);
    if (!conditionAst.ok) {
      push(friendKind, conditionAst.error === 'legacy_text'
        ? '以前の形式の友だち条件が入っているため配信には使えません。条件を作り直してください。'
        : (CONDITION_AST_MESSAGES[conditionAst.error] ?? '友だち条件が読み取れません。条件を作り直してください。'));
    }
  }
  if (definition.routeIds.length > 0) {
    const placeholders = sqlIdSet(definition.routeIds).sql;
    const rows = await db.prepare(
      `SELECT id FROM entry_routes
        WHERE is_active = 1 AND id IN (${placeholders}) AND (
          line_account_id = ? OR (
            line_account_id IS NULL
            AND tenant_id = (SELECT tenant_id FROM line_accounts WHERE id = ?)
          )
        )`,
    ).bind(...(definition.routeIds.length ? sqlIdSet(definition.routeIds).binds : []), accountId, accountId).all<{ id: string }>();
    if ((rows.results ?? []).length !== new Set(definition.routeIds).size) {
      push(friendKind, 'このLINEアカウントで使えない流入リンクが含まれています。');
    }
  }
  if (definition.scenarioId) {
    const scenario = await db.prepare(
      `SELECT id FROM scenarios
        WHERE id = ? AND line_account_id = ? AND is_active = 1`,
    ).bind(definition.scenarioId, accountId).first<{ id: string }>();
    if (!scenario) push(friendKind, 'このLINEアカウントで使えないシナリオです。');
  }
  const tagIds = definition.actions
    .filter((action) => action.type === 'add_tag' || action.type === 'remove_tag')
    .map((action) => action.targetId)
    .filter((id): id is string => typeof id === 'string' && Boolean(id));
  if (tagIds.length > 0) {
    const unique = [...new Set(tagIds)];
    const placeholders = sqlIdSet(unique).sql;
    const rows = await db.prepare(
      `SELECT id FROM tags WHERE line_account_id = ? AND id IN (${placeholders})`,
    ).bind(accountId, ...(unique.length ? sqlIdSet(unique).binds : [])).all<{ id: string }>();
    if ((rows.results ?? []).length !== unique.length) push('actions', 'このLINEアカウントで使えないタグが含まれています。');
  }
  const actionScenarioIds = definition.actions
    .filter((action) => action.type === 'start_scenario')
    .map((action) => action.targetId)
    .filter((id): id is string => typeof id === 'string' && Boolean(id));
  if (actionScenarioIds.length > 0) {
    const unique = [...new Set(actionScenarioIds)];
    const placeholders = sqlIdSet(unique).sql;
    const rows = await db.prepare(
      `SELECT id FROM scenarios
        WHERE line_account_id = ? AND is_active = 1 AND id IN (${placeholders})`,
    ).bind(accountId, ...(unique.length ? sqlIdSet(unique).binds : [])).all<{ id: string }>();
    if ((rows.results ?? []).length !== unique.length) push('actions', 'アクションに使えないシナリオが含まれています。');
  }
  /*
   * F9: 4つの操作の参照先も、このアカウントの持ち物かを確かめる。
   * 友だち情報欄は scopes の所属を見る（所属が無ければ共通。reminders と同じ形）。
   * 対応マークに所属の置き場は無いので存在だけを見る。
   * 共通情報は var_key と所属・未保管を見る（実行側と同じ条件）。
   * マイルは金額だけなので参照先が無い（形は保存側の validateInput が見る）。
   */
  const actionFieldIds = definition.actions
    .filter((action) => action.type === 'set_friend_field')
    .map((action) => action.targetId)
    .filter((id): id is string => typeof id === 'string' && Boolean(id));
  if (actionFieldIds.length > 0) {
    const unique = [...new Set(actionFieldIds)];
    const placeholders = sqlIdSet(unique).sql;
    const rows = await db.prepare(
      `SELECT DISTINCT ff.id AS id FROM friend_fields ff
         LEFT JOIN friend_field_scopes ffs ON ffs.field_id = ff.id
        WHERE ff.id IN (${placeholders})
          AND (ffs.line_account_id = ? OR ffs.line_account_id IS NULL)`,
    ).bind(...(unique.length ? sqlIdSet(unique).binds : []), accountId).all<{ id: string }>();
    if ((rows.results ?? []).length !== unique.length) push('actions', 'アクションに使えない友だち情報の項目が含まれています。');
  }
  const actionMarkIds = definition.actions
    .filter((action) => action.type === 'add_support_mark')
    .map((action) => action.targetId)
    .filter((id): id is string => typeof id === 'string' && Boolean(id));
  if (actionMarkIds.length > 0) {
    const unique = [...new Set(actionMarkIds)];
    const placeholders = sqlIdSet(unique).sql;
    const rows = await db.prepare(
      `SELECT id FROM support_marks WHERE id IN (${placeholders})`,
    ).bind(...(unique.length ? sqlIdSet(unique).binds : [])).all<{ id: string }>();
    if ((rows.results ?? []).length !== unique.length) push('actions', 'アクションに使えない対応マークが含まれています。');
  }
  const actionVarKeys = definition.actions
    .filter((action) => action.type === 'use_common_var')
    .map((action) => action.targetId)
    .filter((id): id is string => typeof id === 'string' && Boolean(id));
  if (actionVarKeys.length > 0) {
    const unique = [...new Set(actionVarKeys)];
    const placeholders = sqlIdSet(unique).sql;
    const rows = await db.prepare(
      `SELECT var_key FROM common_vars
        WHERE var_key IN (${placeholders})
          AND line_account_id = ? AND archived_at IS NULL`,
    ).bind(...(unique.length ? sqlIdSet(unique).binds : []), accountId).all<{ var_key: string }>();
    if ((rows.results ?? []).length !== unique.length) push('actions', 'アクションに使えない共通情報が含まれています。');
  }
  if (definition.activeFrom && definition.activeUntil && definition.activeFrom > definition.activeUntil) {
    push(friendKind, '有効期間の終了は開始より後にしてください。');
  }
  /*
   * 再追加で「何も配信しない」(returningMode none) ときはシナリオを使わない。
   * 要件 -09 §4-3 の正規の選択肢であり、受け皿ルール自身も scenarioId なしで
   * 作られる (ensureFriendAddFallbackRules)。下書きの保存では未完成を許す。
   * それ以外（テスト・公開前確認・公開）は従来どおり必須とし、
   * 公開はテスト成功が鍵のため未完成のまま公開できない。
   */
  const skipsScenario = friendKind === 'returning' && definition.returningMode === 'none';
  if (!definition.scenarioId && !skipsScenario && !options?.allowIncomplete) {
    push(friendKind, '実際に配信するシナリオを決めてください。');
  }
  /*
   * 友だち条件の中で指しているタグ・シナリオ・友だち情報欄も、
   * このアカウントの持ち物かを確かめる。ここを見ないと、別アカウントの
   * タグで絞った条件がそのまま保存され、実行時に誰にも当たらない
   * （あるいは他アカウントの持ち物を読む）設定ができてしまう。
   */
  const conditionRefs = collectFriendAddReferences({
    scenarioId: null,
    routeIds: [],
    actions: [],
    friendCondition: definition.friendCondition,
  });
  const unusable = await findFriendAddUnusableReferences(db, accountId, conditionRefs);
  if (unusable.length > 0) {
    push(friendKind, 'このLINEアカウントで使えないタグ・シナリオ・友だち情報欄・フォーム・対応マークが友だち条件に含まれています。');
  }
  return messages;
}

export /**
 * 想定日時を Date へ直す。
 * 画面の日時欄（"YYYY-MM-DDTHH:MM"）は日本時間の壁時計、
 * "Z" や "+09:00" 付きはそのまま ISO として読む。
 */
function parseExpectedAt(value: string | null | undefined): Date | null | 'invalid' {
  if (!value) return null;
  const wall = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value) ? `${value}+09:00` : value;
  const parsed = new Date(wall);
  return Number.isNaN(parsed.getTime()) ? 'invalid' : parsed;
}

export /**
 * 優先順位がこの設定より小さい（＝先に動く）同じ対象の設定のうち、
 * 流入リンクが重なるものの名前を返す。テスト結果の注意書き用。
 */
async function higherPriorityRouteNames(
  db: D1Database,
  input: { accountId: string; kind: FriendAddRuleKind; selfId: string; selfPriority: number; routeIds: string[] },
): Promise<string[]> {
  if (input.routeIds.length === 0) return [];
  const siblings = await listFriendAddRules(db, { lineAccountId: input.accountId, friendKind: input.kind });
  const mine = new Set(input.routeIds);
  return siblings
    .filter((other) =>
      other.id !== input.selfId
      && other.archived_at === null
      && other.priority < input.selfPriority
      && parseSnapshot(other.definition_snapshot).routeIds.some((id) => mine.has(id)))
    .map((other) => other.name);
}

export /*
 * 実判定の不一致理由を運用者の言葉へ写す表。
 * evaluateFriendAddSchedule / evaluateFriendAddRuleConditions が返す
 * reason を、画面にそのまま出せる文にする。
 */
const CONDITION_MISS_MESSAGES: Partial<Record<FriendAddSuppressReason, string>> = {
  outside_weekday: 'この曜日は配信対象ではありません。',
  outside_time_window: 'この時刻は配信対象の時間帯ではありません。',
  invalid_time_window: '配信する時間帯に読めない値があります。',
  friend_condition_not_met: '試した友だちは、設定した友だち条件を満たしていません。',
  friend_condition_unreadable: '友だち条件が読み取れません。条件を作り直してください。',
  friend_condition_invalid: '友だち条件の内容が壊れています。条件を作り直してください。',
  reference_out_of_account: '設定が、このアカウントで使えない参照を含んでいます。',
  resend_suppressed: 'この友だちは二重送信防止の期間内のため、実行しても届きません。',
};

export async function ruleTestResponse(
  c: Context<Env>,
  accountId: string,
  ruleId: string,
  input?: { routeId?: string | null; expectedAt?: string | null; friendId?: string | null },
) {
  const staff = c.get('staff');
  if (staff.role === 'staff' && !staff.permissionKeys?.includes('/friend-add-settings')) {
    return c.json({ success: false, error: 'この機能を操作する権限がありません' }, 403);
  }
  const row = await getFriendAddRule(c.env.DB, { lineAccountId: accountId, ruleId });
  if (!row) return c.json({ success: false, error: '設定が見つかりません' }, 404);
  const at = parseExpectedAt(input?.expectedAt);
  if (at === 'invalid') return inputError(c, { success: false, error: '想定日時が読めません' }, 400, ["expectedAt"]);
  const definition = parseSnapshot(row.definition_snapshot);
  const errors = await validateReferences(c.env.DB, accountId, definition, row.friend_kind, {
    isFallback: row.is_unknown_route_fallback === 1,
  });

  /*
   * 整合の確認（参照先・必須の欠落）と、条件の確かめ（曜日・時間帯・
   * 有効期間・試した流入リンク）は分ける。前者だけで「選ばれる」と
   * 断定すると、期限切れ・対象外の曜日でも成功に見えてしまう。
   */
  const misses: string[] = [];
  const caveats: string[] = [];
  if (errors.length === 0) {
    const when = at ?? new Date();
    const whenJst = `${toJstParts(when).date}T${friendAddJstHhmm(when)}`;
    if (definition.activeFrom && definition.activeFrom > whenJst) {
      misses.push('有効期間の開始前です。開始を過ぎると動き始めます。');
    }
    if (input?.friendId) {
      /*
       * 友だちを指定したときは、本番と同じ判定器で曜日・時間帯・
       * 友だち条件・再送制限まで確かめる。読み取るだけで、
       * 送信・属性・履歴は書き換えない。
       */
      const friend = await c.env.DB.prepare(
        'SELECT id FROM friends WHERE id = ? AND line_account_id = ?',
      ).bind(input.friendId, accountId).first<{ id: string }>();
      if (!friend) {
        misses.push('試す友だちがこのアカウントに見つかりません。');
      } else {
        const verdict = await evaluateFriendAddRuleConditions(c.env.DB, {
          lineAccountId: accountId,
          friendId: friend.id,
          definition,
          now: when,
        });
        if (!verdict.matched && verdict.reason) {
          misses.push(CONDITION_MISS_MESSAGES[verdict.reason] ?? 'この友だち・日時では条件に合いません。');
        }
      }
    } else {
      const schedule = evaluateFriendAddSchedule(definition, when);
      if (schedule.reason) {
        misses.push(CONDITION_MISS_MESSAGES[schedule.reason] ?? 'この曜日・時刻では条件に合いません。');
      }
    }
    if (input?.routeId != null) {
      if (row.is_unknown_route_fallback === 1) {
        misses.push('この設定は流入経路を確定できなかった人にだけ動きます。');
      } else if (!definition.routeIds.includes(input.routeId)) {
        misses.push('試した流入リンクはこの設定の対象ではありません。');
      }
    }
    /*
     * 優先順位の小さい設定が同じリンクを使っていても、この設定の条件自体は
     * 通る。選ばれない理由ではなく「先に動き得るもの」として注意書きにする。
     */
    const ahead = await higherPriorityRouteNames(c.env.DB, {
      accountId,
      kind: row.friend_kind,
      selfId: row.id,
      selfPriority: row.priority,
      routeIds: input?.routeId != null ? [input.routeId] : definition.routeIds,
    });
    if (ahead.length > 0) {
      caveats.push(`同じ流入リンクを、優先順位の小さい設定（${ahead.join('、')}）も使っています。その設定の条件に合うときは、そちらが先に動きます。`);
    }
  }

  const matched = errors.length === 0 && misses.length === 0;
  if (row.version_status === 'draft') {
    /*
     * 公開の鍵（テスト成功）は「設定の整合が取れたか」で判断する。
     * 「いまは対象の曜日・時間帯ではない」は設定の欠陥ではないため、
     * 曜日を待たずに公開できるよう失敗には数えない。
     */
    await recordFriendAddRuleTest(c.env.DB, {
      lineAccountId: accountId,
      ruleId: row.id,
      staffId: staff.id,
      succeeded: errors.length === 0,
    });
  }
  /*
   * 失敗も成功時と同じ器 (HTTP 200) で返す。400 にすると管理画面の共通取得部が
   * 本文を捨てるため、何を直せばよいか (reasons) が運用者に届かない。
   * 結果の成否は `matched` と `reasons` で見る。
   */
  return c.json({
    success: errors.length === 0,
    data: {
      stateChanged: false,
      ruleId: row.id,
      matched,
      reasons: errors.length > 0
        ? errors.map((error) => error.message)
        : [
            ...(matched
              ? ['保存済みの参照先と、曜日・時間帯・有効期間の条件を確認できました。']
              : misses),
            ...caveats,
          ],
      scenarioId: definition.scenarioId,
      message: definition.messageText || null,
      actions: definition.actions,
    },
    ...(errors.length > 0 ? { error: 'テスト条件を確認してください' } : {}),
  });
}

export type RunCursor = { occurredAt: string; id: string };

export function parseRunCursor(value: string | undefined): RunCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as Partial<RunCursor>;
    return typeof parsed.occurredAt === 'string' && typeof parsed.id === 'string'
      ? { occurredAt: parsed.occurredAt, id: parsed.id }
      : null;
  } catch {
    return null;
  }
}

export function makeRunCursor(row: { occurred_at: string; id: string }): string {
  return encodeURIComponent(JSON.stringify({ occurredAt: row.occurred_at, id: row.id }));
}

export const RUN_STATUSES = new Set(['pending', 'completed', 'failed', 'suppressed', 'partial_failed']);

export const RUN_ATTRIBUTIONS = new Set(['captured', 'unavailable']);

export /**
 * 担当者は実行状況を確認できれば足りる。顧客を特定するIDや表示名は、
 * クライアントで隠すのではなく read model から外す。
 */
function runFriendReadModel(
  row: { friend_id: string; display_name: string | null },
  isStaff: boolean,
): { id: string; displayName: string | null; redacted: false } | { displayName: string; redacted: true } {
  if (isStaff) return { displayName: '顧客名は非表示', redacted: true };
  return { id: row.friend_id, displayName: row.display_name, redacted: false };
}

export type RunPeriod = { from: string | null; to: string | null };
export function runPeriod(period: string | undefined, from: string | undefined, to: string | undefined): RunPeriod | null {
  const validDay = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
  if (from || to) {
    if (period || (from && !validDay(from)) || (to && !validDay(to)) || (from && to && from > to)) return null;
    return { from: from ? `${from}T00:00:00+09:00` : null, to: to ? new Date(Date.parse(`${to}T00:00:00+09:00`) + 86400000).toISOString() : null };
  }
  const now = new Date();
  const jst = japanCalendar(now);
  const day = japanDate(now);
  const month = day.slice(0, 7);
  if (!period || period === 'all') return { from: null, to: null };
  if (period === 'last28days') return { from: new Date(now.getTime() - 28 * 86400000).toISOString(), to: null };
  if (period === 'today') return { from: `${day}T00:00:00+09:00`, to: new Date(Date.parse(`${day}T00:00:00+09:00`) + 86400000).toISOString() };
  if (period === 'this_month') return { from: `${month}-01T00:00:00+09:00`, to: new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() + 1, 1) - 9 * 3600000).toISOString() };
  if (period === 'last_month') return { from: new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() - 1, 1) - 9 * 3600000).toISOString(), to: `${month}-01T00:00:00+09:00` };
  return null;
}
export function runFailureKind(code: string | null): 'delivery_unknown' | 'delivery_failed' | 'action_failed' | 'invalid_reference' | 'other' | null {
  if (!code) return null;
  if (code === 'delivery_unknown') return 'delivery_unknown';
  if (code === 'send_failed' || code === 'send_claim_unavailable') return 'delivery_failed';
  if (code === 'action_failed') return 'action_failed';
  if (code === 'reference_out_of_account' || code === 'entry_route_stopped') return 'invalid_reference';
  return 'other';
}

export /*
 * 並びの版。受け皿以外の生きている設定の lock_version の合計。
 * 並べ替え・下書き保存・停止のたびにどれかが行の版を上げるので、
 * 合計が変わる。行の増減はIDの集合で見る。合計と集合の両方で
 * 並びの今の姿を掴み、PUT /order の expectedVersion と突き合わせる。
 */
async function getFriendAddOrderVersion(
  db: D1Database,
  lineAccountId: string,
  friendKind: FriendAddRuleKind,
): Promise<number> {
  const row = await db.prepare(
    `SELECT COALESCE(SUM(lock_version), 0) AS version
       FROM friend_add_rules
      WHERE line_account_id = ? AND friend_kind = ?
        AND is_unknown_route_fallback = 0 AND archived_at IS NULL`,
  ).bind(lineAccountId, friendKind).first<{ version: number | null }>();
  return Number(row?.version ?? 0);
}
