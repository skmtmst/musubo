import { logger } from '@line-crm/shared/server';
/*
 * シナリオのアクション。
 *
 * Lステップの「アクション設定」にあたる。発火する場所が3つある。
 *   step_sent          … その通を送ったあと
 *   scenario_completed … 最終コンテンツを配り終えたあと
 *   choice_selected    … 質問の選択肢が押されたとき
 *
 * どこから呼んでも同じ形で動かせるように、実行はこの1か所に置く。
 * 配信の本流（step-delivery）から呼ばれるので、**1つのアクションが失敗しても
 * 残りと配信そのものは続ける**。タグが1つ付かなかったせいでメッセージが
 * 止まるほうが、運用上はよほど困る。
 */
import {
  addTagToFriend,
  enrollFriendInScenario,
  getFriendFieldById,
  isResourceInScenarioAccount,
  jstNow,
  setFriendFieldValue,
  friendFieldValueStatements,
  validateFriendFieldValue,
  type PinnedScenarioAction,
} from '@line-crm/db'

import { detachTagAndFireSideEffects } from '../friends/friend-tag-attach/index.js'
import { executeConfiguredAction } from '../../services/action-execution-context.js'
import type { AutomationActionExecutorDependencies } from '../automations/automation-action-executors/index.js'
import { runEventBookingAction, validEventBookingAction } from '../../services/event-booking-action.js'
import { matchesCondition, parseCondition } from '../../services/segment-query.js'

export type ScenarioActionHook = 'step_sent' | 'scenario_completed' | 'choice_selected'

export type ScenarioActionType =
  | 'tag'
  | 'friend_field'
  | 'support_mark'
  | 'scenario'
  | 'common_var'
  | 'send_message'
  | 'send_template'
  | 'reminder'
  | 'event_booking'

export interface ScenarioActionRow {
  id: string
  scenario_id: string
  hook: ScenarioActionHook
  step_id: string | null
  choice_index: number | null
  sort_order: number
  action_type: ScenarioActionType
  config_json: string
  condition_json: string | null
  repeat_on_refire: number
  /**
   * 「2回目以降は実行しない」の鍵（版固定の実行で使う）。版に固定された
   * アクションの `id` は版ごとに変わるので、そのまま鍵にすると
   * 「1回だけ」が「版ごとに1回」になる。公開時点の live のアクションIDを
   * 入れて、版をまたいでも同じ鍵にする。
   */
  fires_key?: string
}

export interface RunActionRowsOptions {
  /**
   * 実行済み台帳をどちらで持つか。
   * - `live`   … scenario_action_fires（下書きのアクション行に外部キーで縛られる）
   * - `pinned` … scenario_pinned_action_fires（版固定の実行用。live 行が消えても書ける）
   */
  fires?: 'live' | 'pinned'
  /** 呼び出し元の工程キー。同じイベントの再送では予約を増やさない。 */
  sourceEventId?: string
  /**
   * シナリオの LINE 公式アカウント。タグ・テンプレート・遷移先が別の
   * アカウントのものなら実行しない。null は共通シナリオ（確かめない）。
   */
  accountId?: string | null
  executorDependencies?: AutomationActionExecutorDependencies
}

/** config_json の形。action_type ごとに違う。 */
export interface TagActionConfig {
  op: 'add' | 'remove'
  tagIds: string[]
  /** タグフォルダを指定したとき、その中のタグを全部対象にする。 */
  folderId?: string | null
}
export interface FriendFieldActionConfig {
  fieldId: string
  op: 'set' | 'add' | 'sub' | 'clear'
  value: string
}
export interface SupportMarkActionConfig {
  /** null なら対応マークを外す。 */
  markId: string | null
}
export interface ScenarioActionConfig {
  op: 'start' | 'stop' | 'resume_previous'
  scenarioId?: string | null
  /**
   * start のとき、すでに読んだことがある人をどこから始めるか。
   *   from_start … 最初から
   *   from_read  … 読んだところから（再開）
   */
  restart?: 'from_start' | 'from_read'
  /** start のとき、いま読んでいるシナリオを控えて後で戻せるようにする。 */
  rememberPrevious?: boolean
}
export interface CommonVarActionConfig {
  varKey: string
  op: 'add' | 'sub'
  value: string
}

/**
 * 中身が埋まっているか。
 *
 * 画面はカードを1枚置いてから埋める作りなので、**埋まっていない状態でも
 * 保存できる**。そのまま実行すると「タグを1つも指定していないタグ操作」が
 * 黙って何もしないだけになり、設定したつもりで効いていないことに
 * 気づけない。実行の直前でここを見て、飛ばしたことをログに残す。
 *
 * 画面側もこれと同じ判定で「未完成」と出す（API が complete を返す）。
 */
export function isScenarioActionComplete(actionType: string, config: unknown): boolean {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return false
  const c = config as Record<string, unknown>
  switch (actionType) {
    case 'tag':
      return (
        (c.op === 'add' || c.op === 'remove') &&
        ((Array.isArray(c.tagIds) && c.tagIds.length > 0) ||
          (typeof c.folderId === 'string' && c.folderId !== ''))
      )
    case 'friend_field':
      return (
        typeof c.fieldId === 'string' &&
        c.fieldId !== '' &&
        ['set', 'add', 'sub', 'clear'].includes(String(c.op))
      )
    case 'support_mark':
      // null は「対応マークを外す」という意味のある指定。
      return c.markId === null || (typeof c.markId === 'string' && c.markId !== '')
    case 'scenario':
      if (c.op === 'resume_previous') return true
      if (c.op === 'stop') return true
      return c.op === 'start' && typeof c.scenarioId === 'string' && c.scenarioId !== ''
    case 'common_var':
      return (
        typeof c.varKey === 'string' && c.varKey !== '' && (c.op === 'add' || c.op === 'sub')
      )
    case 'send_message':
      return typeof c.content === 'string' && c.content.trim() !== ''
    case 'send_template':
      return typeof c.templateId === 'string' && c.templateId !== ''
    case 'reminder':
      return typeof c.reminderId === 'string' && c.reminderId !== ''
    case 'event_booking':
      return validEventBookingAction(c)
    default:
      return false
  }
}

export interface RunActionsInput extends RunActionRowsOptions {
  scenarioId: string
  hook: ScenarioActionHook
  friendId: string
  stepId?: string | null
  choiceIndex?: number | null
}

export interface RunActionsResult {
  /** 実行したアクションの数。 */
  executed: number
  /** 条件に合わずに飛ばした数。 */
  skippedByCondition: number
  /** 「2回目以降は実行しない」で飛ばした数。 */
  skippedByOnce: number
  /** 失敗した数。失敗しても配信は続ける。 */
  failed: number
  /** 空き・申込なしは理由を記録し、この処理だけを止める。 */
  eventBookingFailure?: { code: string; reason: string }
  /** 中身が埋まっていないため飛ばした数。 */
  skippedIncomplete: number
  /**
   * このアクションでシナリオの購読状態を触ったか。
   * 呼び出し側（step-delivery）が、そのあとの進行判断に使う。
   */
  scenarioTouched: boolean
}

export async function loadScenarioActions(
  db: D1Database,
  input: RunActionsInput,
): Promise<ScenarioActionRow[]> {
  // step_id / choice_index は NULL のことがあるので IS 比較にする。
  // = で比べると NULL 同士が一致せず、シナリオ完了時のアクションが
  // 1つも拾えなくなる。
  const rows = await db
    .prepare(
      `SELECT id, scenario_id, hook, step_id, choice_index, sort_order,
              action_type, config_json, condition_json, repeat_on_refire
         FROM scenario_actions
        WHERE scenario_id = ?
          AND hook = ?
          AND step_id IS ?
          AND choice_index IS ?
        ORDER BY sort_order ASC, id ASC`,
    )
    .bind(input.scenarioId, input.hook, input.stepId ?? null, input.choiceIndex ?? null)
    .all<ScenarioActionRow>()
  return rows.results ?? []
}

/**
 * アクションを順に実行する。
 *
 * 並び順は画面で決めた順。タグを付けてから、そのタグを条件にした次の
 * アクションを動かす、という書き方ができるように、**逐次**で実行する。
 * 並列にすると同じ画面の見た目どおりに動かない。
 */
export async function runScenarioActions(
  db: D1Database,
  input: RunActionsInput,
): Promise<RunActionsResult> {
  let actions: ScenarioActionRow[]
  try {
    actions = await loadScenarioActions(db, input)
  } catch (err) {
    logger.error("services_scenario_actions_failed")
    return emptyActionsResult()
  }
  return runActionRows(db, actions, input.friendId, input)
}

/**
 * 版に固定されたアクションを、実行できる形へ直す。
 *
 * `id` は版所有のアクションID（ログ用）。「1回だけ」の鍵は公開時点の
 * live のアクションID（fires_key）を使う。版をまたいでも同じ鍵にする。
 */
export function pinnedActionsToRows(actions: PinnedScenarioAction[]): ScenarioActionRow[] {
  return actions.map((a) => ({
    id: a.id,
    fires_key: a.action_key,
    scenario_id: a.scenario_id,
    hook: a.hook as ScenarioActionHook,
    step_id: a.version_step_id,
    choice_index: a.choice_index,
    sort_order: a.sort_order,
    action_type: a.action_type as ScenarioActionType,
    config_json: a.config_json,
    condition_json: a.condition_json,
    repeat_on_refire: a.repeat_on_refire,
  }))
}

export interface RunPinnedActionsInput extends RunActionRowsOptions {
  /** 版に固定されたアクション一式（版の写しをそのまま渡す）。 */
  actions: PinnedScenarioAction[]
  hook: ScenarioActionHook
  friendId: string
  /** 版所有の通ID。通に紐づかないアクション（完了時など）は null。 */
  versionStepId?: string | null
  choiceIndex?: number | null
  /** シナリオの LINE 公式アカウント。参照資源の境界に使う。 */
  accountId?: string | null
}

/**
 * 購読が固定している版のアクションだけを実行する。live の scenario_actions を読むと、公開後の追加・削除・変更が別の版の購読へ混入する。
 */
export async function runPinnedScenarioActions(
  db: D1Database,
  input: RunPinnedActionsInput,
): Promise<RunActionsResult> {
  const stepId = input.versionStepId ?? null
  const choiceIndex = input.choiceIndex ?? null
  const rows = pinnedActionsToRows(input.actions)
    .filter(
      (a) =>
        a.hook === input.hook &&
        (a.step_id ?? null) === stepId &&
        (a.choice_index ?? null) === choiceIndex,
    )
    .sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id))
  return runActionRows(db, rows, input.friendId, {
    ...input,
    fires: 'pinned',
    accountId: input.accountId ?? null,
  })
}

function emptyActionsResult(): RunActionsResult {
  return {
    executed: 0,
    skippedByCondition: 0,
    skippedByOnce: 0,
    failed: 0,
    skippedIncomplete: 0,
    scenarioTouched: false,
  }
}

/**
 * 並べたアクションを順に実行する。
 *
 * シナリオは `scenario_actions` の行を読んでここへ渡す。自動応答は
 * `auto_replies.actions_json` を読んで同じ形に組み立てて渡す。**実行そのものは
 * 1か所しかない。** 呼び出し元ごとに実装を分けると、タグ操作の細かい挙動
 * （フォルダ指定、条件付き、1回だけ）がすぐに食い違う。
 *
 * 並び順は画面で決めた順のまま逐次で動かす。タグを付けてから、そのタグを
 * 条件にした次のアクションを動かす、という書き方ができるようにするため。
 * 並列にすると画面の見た目どおりに動かない。
 *
 * 1つ失敗しても残りは続ける。タグが1つ付かなかったせいでメッセージが
 * 止まるほうが、運用上はよほど困る。
 */
export async function runActionRows(
  db: D1Database,
  actions: ScenarioActionRow[],
  friendId: string,
  options: RunActionRowsOptions = {},
): Promise<RunActionsResult> {
  const result = emptyActionsResult()
  if (actions.length === 0) return result

  const input = { friendId }
  const pinned = options.fires === 'pinned'

  for (const action of actions) {
    try {
      /*
       * 中身が埋まっていないアクションは実行しない。
       *
       * 「タグを1つも選んでいないタグ操作」を実行しても何も起きないが、
       * 設定したつもりで効いていないことに気づけない。飛ばしたことを
       * 残しておけば、あとから追える。
       */
      let parsedConfig: unknown
      try {
        parsedConfig = JSON.parse(action.config_json)
      } catch {
        logger.error("services_scenario_actions_failed")
        result.failed++
        continue
      }
      if (!isScenarioActionComplete(action.action_type, parsedConfig)) {
        logger.warn("services_scenario_actions_warn")
        result.skippedIncomplete++
        continue
      }

      if (action.repeat_on_refire === 0) {
        // 版固定の実行は、版の台帳と（版へ移す前に記録した）下書きの台帳を
        // 両方見る。片方だけ見ると、公開版へ移した瞬間に全員の「1回だけ」が
        // 戻ってしまう。
        const firesKey = action.fires_key ?? action.id
        const fired = pinned
          ? await db
              .prepare(
                `SELECT 1 AS ok FROM scenario_pinned_action_fires
                  WHERE action_key = ? AND friend_id = ?
                 UNION ALL
                 SELECT 1 AS ok FROM scenario_action_fires
                  WHERE action_id = ? AND friend_id = ?
                 LIMIT 1`,
              )
              .bind(firesKey, input.friendId, firesKey, input.friendId)
              .first<{ ok: number }>()
          : await db
              .prepare(`SELECT 1 AS ok FROM scenario_action_fires WHERE action_id = ? AND friend_id = ?`)
              .bind(action.id, input.friendId)
              .first<{ ok: number }>()
        if (fired) {
          result.skippedByOnce++
          continue
        }
      }

      const condition = parseCondition(action.condition_json)
      if (action.condition_json && !condition) {
        // 保存されている条件が読めない。全員に実行するより、飛ばして
        // ログに残すほうが安全側。
        logger.error("services_scenario_actions_failed")
        result.failed++
        continue
      }
      if (!(await matchesCondition(db, input.friendId, condition))) {
        result.skippedByCondition++
        continue
      }

      const touched = await executeAction(db, action, input.friendId, options)
      if (touched) result.scenarioTouched = true
      result.executed++

      if (action.repeat_on_refire === 0) {
        const firesKey = action.fires_key ?? action.id
        await db
          .prepare(
            pinned
              ? `INSERT OR IGNORE INTO scenario_pinned_action_fires (action_key, friend_id, fired_at) VALUES (?, ?, ?)`
              : `INSERT OR IGNORE INTO scenario_action_fires (action_id, friend_id, fired_at) VALUES (?, ?, ?)`,
          )
          .bind(pinned ? firesKey : action.id, input.friendId, jstNow())
          .run()
      }
    } catch (err) {
      // 1つ失敗しても残りは続ける。配信も止めない。
      logger.error("services_scenario_actions_failed")
      result.failed++
      if (action.action_type === 'event_booking' && err instanceof Error && 'code' in err &&
        (err.code === 'event_booking_unavailable' || err.code === 'event_booking_missing')) {
        result.eventBookingFailure = { code: err.code, reason: err.message }
      }
    }
  }

  return result
}

/** @returns シナリオの購読状態を触ったか。 */
async function executeAction(
  db: D1Database,
  action: ScenarioActionRow,
  friendId: string,
  options: RunActionRowsOptions = {},
): Promise<boolean> {
  const config = JSON.parse(action.config_json) as unknown
  const accountId = options.accountId ?? null
  const numericEffectKey = action.repeat_on_refire === 0
    ? `once:${action.fires_key ?? action.id}`
    : options.sourceEventId ? JSON.stringify([options.sourceEventId, action.id]) : undefined

  switch (action.action_type) {
    case 'tag': {
      const c = config as TagActionConfig
      const tagIds = await resolveTagIds(db, c, accountId)
      for (const tagId of tagIds) {
        if (c.op === 'remove') await detachTagAndFireSideEffects(db, friendId, tagId, numericEffectKey ? `${numericEffectKey}:remove:${tagId}` : undefined)
        else await addTagToFriend(db, friendId, tagId)
      }
      return false
    }

    case 'friend_field': {
      await applyFriendField(db, friendId, config as FriendFieldActionConfig, numericEffectKey)
      return false
    }

    case 'support_mark': {
      const c = config as SupportMarkActionConfig
      await db
        .prepare(`UPDATE friends SET support_mark_id = ?, updated_at = ? WHERE id = ?`)
        .bind(c.markId ?? null, jstNow(), friendId)
        .run()
      return false
    }

    case 'scenario': {
      const c = config as ScenarioActionConfig
      // 遷移先が別の LINE 公式アカウントのシナリオなら動かさない。ID を
      // 直接渡せば他アカウントの人を動かせる、という抜けを塞ぐ。
      if (
        c.scenarioId &&
        !(await isResourceInScenarioAccount(db, 'scenario', c.scenarioId, accountId))
      ) {
        logger.warn("services_scenario_actions_warn")
        return false
      }
      await runScenarioOp(db, friendId, action.scenario_id, c, options.sourceEventId)
      return true
    }

    case 'common_var': {
      await applyCommonVar(db, friendId, config as CommonVarActionConfig, numericEffectKey)
      return false
    }

    case 'send_template':
    case 'send_message':
    case 'event_booking':
    case 'reminder': {
      const c = config as Record<string, unknown>
      const type = action.action_type === 'reminder'
        ? (c.op === 'stop' || c.op === 'cancel' ? 'stop_reminder' : 'start_reminder')
        : action.action_type === 'event_booking' ? 'event_booking' : 'send_message'
      await executeConfiguredAction(db, { friendId, accountId, source: 'scenario-action',
        sourceEventId: options.sourceEventId ?? (action.repeat_on_refire === 0 ? `once:${action.fires_key ?? action.id}` : crypto.randomUUID()),
        actionId: action.id, type, params: c, dependencies: options.executorDependencies })
      return false
    }
    default: {
      const exhaustive: never = action.action_type
      throw new Error(`Unknown action type: ${String(exhaustive)}`)
    }
  }
}

/**
 * タグフォルダ指定なら、その中のタグを全部返す。
 *
 * シナリオの LINE 公式アカウントが決まっているときは、別アカウントのタグを
 * 落とす。ID を直接渡せば他アカウントのタグを付けられる、という抜けを
 * server 側で塞ぐ（画面で選べないだけでは足りない）。
 */
async function resolveTagIds(
  db: D1Database,
  c: TagActionConfig,
  accountId: string | null,
): Promise<string[]> {
  const ids = new Set<string>(Array.isArray(c.tagIds) ? c.tagIds : [])
  if (c.folderId) {
    const rows = await db
      .prepare(`SELECT id FROM tags WHERE group_id = ?`)
      .bind(c.folderId)
      .all<{ id: string }>()
    for (const row of rows.results ?? []) ids.add(row.id)
  }
  const allowed: string[] = []
  for (const id of ids) {
    if (await isResourceInScenarioAccount(db, 'tag', id, accountId)) {
      allowed.push(id)
      continue
    }
    logger.warn("services_scenario_actions_warn")
  }
  return allowed
}

/**
 * 友だち情報欄を書き換える。
 *
 * 加算・減算は数として扱う。値が数でなければ 0 とみなす。ここで例外にすると、
 * 1人ぶんの値が壊れているだけで以降の配信が全部止まる(呼び出し側が
 * 失敗数に数え、残りのアクションと配信は続ける)。
 *
 * 書き込む値は項目の型で検証し、合わなければ保存せず例外にする。
 * 設定値が型に合わないまま配信されると、不正値が情報欄へ残るため。
 */
async function applyFriendField(
  db: D1Database,
  friendId: string,
  c: FriendFieldActionConfig,
  effectKey?: string,
): Promise<void> {
  if (!c.fieldId) throw new Error('friend_field action requires fieldId')
  const target = await getFriendFieldById(db, c.fieldId)
  if (!target) throw new Error(`friend_field action: field not found: ${c.fieldId}`)

  if (c.op === 'clear') {
    await db
      .prepare(`DELETE FROM friend_field_values WHERE friend_id = ? AND field_id = ?`)
      .bind(friendId, c.fieldId)
      .run()
    return
  }

  let raw: unknown = c.value ?? ''
  if (c.op === 'add' || c.op === 'sub') {
    const current = await db
      .prepare(`SELECT value FROM friend_field_values WHERE friend_id = ? AND field_id = ?`)
      .bind(friendId, c.fieldId)
      .first<{ value: string | null }>()
    const base = Number(current?.value ?? 0)
    const delta = Number(c.value ?? 0)
    const safeBase = Number.isFinite(base) ? base : 0
    const safeDelta = Number.isFinite(delta) ? delta : 0
    raw = String(c.op === 'add' ? safeBase + safeDelta : safeBase - safeDelta)
  }

  const checked = validateFriendFieldValue(target, raw)
  if (!checked.ok) throw new Error(`invalid friend field value: ${checked.error}`)
  const input = { friendId, fieldId: c.fieldId, value: checked.value, updatedBy: 'scenario', field: target }
  if (effectKey && (c.op === 'add' || c.op === 'sub')) {
    await commitNumericEffect(db, friendId, effectKey, friendFieldValueStatements(db, input))
  } else await setFriendFieldValue(db, input)
}

/**
 * シナリオの購読を動かす。
 *
 * start のとき rememberPrevious が立っていれば、いま読んでいるシナリオを
 * 控えてから移す。控えた先が「1つ前のシナリオを再開」で戻ってくる。
 */
export async function runScenarioOp(
  db: D1Database,
  friendId: string,
  currentScenarioId: string,
  c: ScenarioActionConfig,
  sourceEventId?: string,
): Promise<void> {
  const now = jstNow()

  if (c.op === 'stop') {
    const targetId = c.scenarioId || currentScenarioId
    await db
      .prepare(
        `UPDATE friend_scenarios SET confirmation_revision = confirmation_revision + 1, status = 'paused', updated_at = ?
          WHERE friend_id = ? AND scenario_id = ? AND status IN ('active','delivering')`,
      )
      .bind(now, friendId, targetId)
      .run()
    return
  }

  if (c.op === 'resume_previous') {
    await resumePreviousScenario(db, friendId, currentScenarioId)
    return
  }

  // start
  if (!c.scenarioId) throw new Error('scenario action requires scenarioId to start')

  let previousScenarioId: string | null = null
  if (c.rememberPrevious) {
    const running = await db
      .prepare(
        `SELECT scenario_id FROM friend_scenarios
          WHERE friend_id = ? AND scenario_id != ? AND status IN ('active','delivering')
          ORDER BY updated_at DESC LIMIT 1`,
      )
      .bind(friendId, c.scenarioId)
      .first<{ scenario_id: string }>()
    previousScenarioId = running?.scenario_id ?? null
  }

  // 元の購読を止めるのは、移動先への登録が成功した後だけ。
  const pausePrevious = previousScenarioId ? [db.prepare(
    `UPDATE friend_scenarios SET confirmation_revision = confirmation_revision + 1, status='paused', updated_at=?
      WHERE friend_id=? AND scenario_id=? AND status IN ('active','delivering')`,
  ).bind(now, friendId, previousScenarioId)] : []

  // 読み終えた行が残っていると部分UNIQUE索引には触れないが、
  // 「最初から」を選んだときに読了済の行が邪魔をする。先に消す。
  if (c.restart !== 'from_read') {
    await db
      .prepare(`DELETE FROM friend_scenarios WHERE friend_id = ? AND scenario_id = ? AND status = 'completed'`)
      .bind(friendId, c.scenarioId)
      .run()
  } else {
    // 「読んだところから」。止まっている行があれば起こすだけで済む。
    const paused = await db
      .prepare(
        `SELECT id FROM friend_scenarios
          WHERE friend_id = ? AND scenario_id = ? AND status = 'paused' LIMIT 1`,
      )
      .bind(friendId, c.scenarioId)
      .first<{ id: string }>()
    if (paused) {
      const available = await db.prepare(`SELECT 1 FROM scenarios WHERE id=? AND is_active=1 AND current_published_version_id IS NOT NULL`)
        .bind(c.scenarioId).first()
      if (!available) throw new Error('移動先のシナリオを開始できませんでした。元のシナリオは継続しています')
      await db.batch([
        db.prepare(`UPDATE friend_scenarios SET confirmation_revision = confirmation_revision + 1, status='active', previous_scenario_id=COALESCE(?,previous_scenario_id), updated_at=?
          WHERE id=? AND status='paused' AND EXISTS(SELECT 1 FROM scenarios WHERE id=? AND is_active=1 AND current_published_version_id IS NOT NULL)`)
          .bind(previousScenarioId, now, paused.id, c.scenarioId),
        // 読み取り後に先が変わっていたらbatch全体を戻し、元の停止へ進まない。
        db.prepare(`SELECT json(CASE WHEN changes()=1 THEN '{}' ELSE 'SCENARIO_NOT_RESUMED' END)`),
        ...pausePrevious,
      ])
      return
    }
  }

  const enrollmentId = sourceEventId ? `scenario-action:${JSON.stringify([friendId, sourceEventId, c.scenarioId])}` : undefined
  const enrolled = await enrollFriendInScenario(db, friendId, c.scenarioId, enrollmentId, { replacingScenarioId: previousScenarioId })
  if (!enrolled) {
    // 元々稼働中の同じ購読は重複開始。新しい移動とは扱わない。
    const active = await db.prepare(`SELECT 1 FROM friend_scenarios WHERE friend_id=? AND scenario_id=? AND status IN ('active','delivering')`)
      .bind(friendId, c.scenarioId).first()
    if (active && !previousScenarioId) return
    throw new Error('移動先のシナリオを開始できませんでした。元のシナリオは継続しています')
  }
  if (previousScenarioId) await db.batch([
    db.prepare(`UPDATE friend_scenarios SET confirmation_revision = confirmation_revision + 1, previous_scenario_id=COALESCE(?,previous_scenario_id)
      WHERE id=? AND status IN ('active','delivering') AND EXISTS(SELECT 1 FROM scenarios WHERE id=? AND is_active=1 AND current_published_version_id IS NOT NULL)`)
      .bind(previousScenarioId, enrolled.id, c.scenarioId),
    db.prepare(`SELECT json(CASE WHEN changes()=1 THEN '{}' ELSE 'SCENARIO_NOT_STARTED' END)`),
    ...pausePrevious,
  ])
}

/**
 * 割り込む前に読んでいたシナリオへ戻す。
 *
 * 戻り先は friend_scenarios.previous_scenario_id に控えてある。控えが無ければ
 * 何もしない。**適当なシナリオを選んで再開しない**。意図しない配信が始まる。
 */
export async function resumePreviousScenario(
  db: D1Database,
  friendId: string,
  currentScenarioId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT previous_scenario_id FROM friend_scenarios
        WHERE friend_id = ? AND scenario_id = ?
        ORDER BY updated_at DESC LIMIT 1`,
    )
    .bind(friendId, currentScenarioId)
    .first<{ previous_scenario_id: string | null }>()
  const previousId = row?.previous_scenario_id ?? null
  if (!previousId) return false

  const updated = await db
    .prepare(
      `UPDATE friend_scenarios SET confirmation_revision = confirmation_revision + 1, status = 'active', updated_at = ?
        WHERE friend_id = ? AND scenario_id = ? AND status = 'paused'`,
    )
    .bind(jstNow(), friendId, previousId)
    .run()
  return (updated.meta?.changes ?? 0) > 0
}

/**
 * 共通情報の加算・減算。在庫や残席のような、店ぜんたいで1つの数に使う。
 *
 * 読み→計算→書き込みを分けると、同時実行で片方の増減が消える。
 * 読み直しの再試行で吸収する作りも、上限を使い切ると失敗として
 * 握りつぶされ、加減算が永久に消える。そこで値・版番号・履歴を
 * 1つの batch で書き、計算は SQL の中で今の値に足す。D1 の batch は
 * 原子的なので、並んだ更新は必ず1件ずつ順に当たり、負けも再試行も
 * 上限もない。版番号と履歴を進めるのは画面編集・予約適用と同じ契約
 * にするためで、古い版のままの上書きを防ぐ。
 *
 * 数の読み方は SQLite の数値化に従う。整数・小数・空・ただの文字は
 * 従来どおり（文字は0とみなす）。'12abc' のような先頭数字つき文字列は
 * 先頭の数として読む点だけ、従来の Number 扱いと違う。
 */
async function applyCommonVar(
  db: D1Database,
  friendId: string,
  c: CommonVarActionConfig,
  effectKey?: string,
): Promise<void> {
  if (!c.varKey) throw new Error('common_var action requires varKey')
  const delta = Number(c.value ?? 0)
  const safeDelta = Number.isFinite(delta) ? delta : 0
  const signed = c.op === 'add' ? safeDelta : -safeDelta
  const now = jstNow()
  const statements = [
    db.prepare(
      `UPDATE common_vars
          SET value = CASE
                WHEN (COALESCE(CAST(value AS REAL), 0.0) + ?)
                   = CAST(COALESCE(CAST(value AS REAL), 0.0) + ? AS INTEGER)
                THEN CAST(CAST(COALESCE(CAST(value AS REAL), 0.0) + ? AS INTEGER) AS TEXT)
                ELSE CAST(COALESCE(CAST(value AS REAL), 0.0) + ? AS TEXT)
              END,
              version = version + 1,
              updated_at = ?
        WHERE var_key = ?
          AND line_account_id = (SELECT line_account_id FROM friends WHERE id = ?)
          AND archived_at IS NULL`,
    ).bind(signed, signed, signed, signed, now, c.varKey, friendId),
    // 履歴は更新後の行から取るので、版・値・名前が今の行と必ず一致する。
    // 既存の履歴に欠番があっても、負けた側が誤った行を補うことはない。
    // batch が原子的なので、敗者がいることもない。
    db.prepare(
      `INSERT INTO common_var_versions
         (id, common_var_id, version_no, name, value, memo, change_reason, actor_id, created_at)
       SELECT ?, cv.id, cv.version, cv.name, cv.value, cv.memo, ?, NULL, ?
         FROM common_vars cv
        WHERE cv.var_key = ?
          AND cv.line_account_id = (SELECT line_account_id FROM friends WHERE id = ?)
          AND cv.archived_at IS NULL`,
    ).bind(
      crypto.randomUUID(),
      c.op === 'add' ? 'シナリオ加算' : 'シナリオ減算',
      now,
      c.varKey,
      friendId,
    ),
  ]
  if (effectKey) {
    await commitNumericEffect(db, friendId, effectKey, [
      db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM common_vars WHERE var_key=?
        AND line_account_id=(SELECT line_account_id FROM friends WHERE id=?) AND archived_at IS NULL)
        THEN '{}' ELSE 'MISSING_COMMON_VAR' END)`).bind(c.varKey, friendId),
      ...statements,
    ])
  } else {
    const results = await db.batch(statements)
    if ((results[0]?.meta?.changes ?? 0) === 0) throw new Error(`common_var not found: ${c.varKey}`)
  }
}

/** DB内の数値更新と受領記録を同じbatchへ入れる。工程記録を失っても加算し直さない。 */
async function commitNumericEffect(
  db: D1Database, friendId: string, effectKey: string, statements: D1PreparedStatement[],
): Promise<void> {
  const sourceId = JSON.stringify([friendId, effectKey])
  const recorded = () => db.prepare('SELECT 1 FROM audit_events WHERE source_kind=? AND source_id=?')
    .bind('scenario_numeric_action', sourceId).first()
  if (await recorded()) return
  try {
    await db.batch([
      db.prepare(`INSERT INTO audit_events(id,source_kind,source_id,tenant_id,line_account_id,category,actor_role,action,target_kind,target_id,result)
        SELECT ?,'scenario_numeric_action',?,COALESCE(a.tenant_id,'00000000-0000-4000-8000-000000000001'),f.line_account_id,
          'business','system','scenario.numeric','friend',f.id,'success'
        FROM friends f LEFT JOIN line_accounts a ON a.id=f.line_account_id WHERE f.id=?`)
        .bind(crypto.randomUUID(), sourceId, friendId),
      ...statements,
    ])
  } catch (error) {
    // 同じ出来事の並行実行だけは成功済みとして収束する。その他のDB失敗は返す。
    if (!await recorded()) throw error
  }
}
