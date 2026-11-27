import type { CommonActionStep } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { automationWaitLabel } from '@line-crm/shared'

/*
 * 監査 R468: 版の切替確認で、処理の数だけでなく待ち時間・失敗時の動き・
 * 順序・追加/削除の前後が分かるようにする。履歴の「変更内容」と
 * 切替の確認窓の両方で使う。画面に出す言葉はここに集める。
 */

export const ACTION_LABELS: Record<string, string> = Object.assign(Object.create(null), {
  add_tag: 'タグを付ける', remove_tag: 'タグを外す', set_metadata: '友だち情報を設定する',
  start_scenario: 'シナリオを開始する', stop_scenario: 'シナリオを停止する',
  resume_scenario: 'シナリオを再開する', send_message: 'LINEメッセージを送る',
  send_webhook: '外部サービスへ送る', switch_rich_menu: 'リッチメニューを切り替える',
  remove_rich_menu: 'リッチメニューを外す', wait: '待つ', common_action: '別の共通アクションを呼ぶ',
  branch: '条件で分ける',
})

const FAILURE_LABELS: Record<string, string> = Object.assign(Object.create(null), {
  stop: '止める', continue: '次へ進む',
})

function stepLabel(type: string): string {
  return Object.prototype.hasOwnProperty.call(ACTION_LABELS, type) ? ACTION_LABELS[type] : '処理'
}

function failureLabel(value: string): string {
  return Object.prototype.hasOwnProperty.call(FAILURE_LABELS, value) ? FAILURE_LABELS[value] : '動作を確認できません'
}

function asParams(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function canonicalize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? `${value}n` : value
  }
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen))
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key]
    if (v !== undefined) out[key] = canonicalize(v, seen)
  }
  return out
}

function safeEqual(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b))
  } catch {
    return false
  }
}

function waitMinutes(params: Record<string, unknown>): number | null {
  const value = params.durationMinutes ?? params.minutes
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/* 分岐の中身の変わり方を1〜数行で書く。 */
function describeBranchChange(oldStep: CommonActionStep, newStep: CommonActionStep): string[] {
  const lines: string[] = []
  const oldParams = asParams(oldStep.params)
  const newParams = asParams(newStep.params)
  const oldCondition = oldParams.condition as { operator?: unknown; rules?: unknown[] } | undefined
  const newCondition = newParams.condition as { operator?: unknown; rules?: unknown[] } | undefined
  const operatorName = (operator: unknown) => operator === 'OR' ? 'どれかに当てはまる' : 'すべてに当てはまる'
  if (oldCondition && newCondition) {
    if (oldCondition.operator !== newCondition.operator) {
      lines.push(`条件分岐を「${operatorName(oldCondition.operator)}」から「${operatorName(newCondition.operator)}」にした`)
    }
    const oldRules = Array.isArray(oldCondition.rules) ? oldCondition.rules.length : 0
    const newRules = Array.isArray(newCondition.rules) ? newCondition.rules.length : 0
    if (oldRules !== newRules) {
      lines.push(`条件分岐の条件を${oldRules} 個から${newRules} 個にした`)
    } else if (!safeEqual(oldCondition.rules, newCondition.rules)) {
      lines.push('条件分岐の条件の中身を変えた')
    }
  } else if (Boolean(oldCondition) !== Boolean(newCondition)) {
    lines.push('条件分岐の条件の中身を変えた')
  }
  for (const [key, name] of [['then', '当てはまるとき'], ['else', '当てはまらないとき']] as const) {
    const oldSide = oldParams[key] as CommonActionStep[] | undefined
    const newSide = newParams[key] as CommonActionStep[] | undefined
    if (Array.isArray(oldSide) && Array.isArray(newSide)) {
      if (!safeEqual(oldSide, newSide)) {
        if (oldSide.length !== newSide.length) {
          lines.push(`条件分岐の${name}を${formatNumber(oldSide.length)} 個から${formatNumber(newSide.length)} 個にした`)
        } else {
          lines.push(`条件分岐の${name}の内容を変えた`)
        }
      }
    } else if (!safeEqual(oldSide, newSide)) {
      lines.push(`条件分岐の${name}の内容を変えた`)
    }
  }
  return lines
}

/* 同じIDの処理1件の変わり方を書く。前提：どちらも同じID。 */
function describeStepChange(oldStep: CommonActionStep, newStep: CommonActionStep): string[] {
  if (oldStep.type !== newStep.type) {
    return [`「${stepLabel(oldStep.type)}」を「${stepLabel(newStep.type)}」に変えた`]
  }
  const lines: string[] = []
  const label = stepLabel(newStep.type)
  const oldParams = asParams(oldStep.params)
  const newParams = asParams(newStep.params)
  if (newStep.type === 'wait') {
    const before = waitMinutes(oldParams)
    const after = waitMinutes(newParams)
    if (oldParams.mode === 'next_day' || newParams.mode === 'next_day') {
      const oldLabel = automationWaitLabel(oldParams)
      const newLabel = automationWaitLabel(newParams)
      if (oldLabel !== newLabel) lines.push(`「${oldLabel}」から「${newLabel}」にした`)
    } else if (before !== null && after !== null && before !== after) {
      lines.push(`「待つ」を${before}分から${after}分にした`)
    } else if (!safeEqual(oldParams, newParams)) {
      lines.push('「待つ」の内容を変えた')
    }
  }
  if (oldStep.onFailure !== newStep.onFailure) {
    lines.push(`「${label}」の失敗時を「${failureLabel(oldStep.onFailure)}」から「${failureLabel(newStep.onFailure)}」にした`)
  }
  if (newStep.type === 'branch') {
    lines.push(...describeBranchChange(oldStep, newStep))
  } else if (newStep.type !== 'wait' && !safeEqual(
    { ...oldParams, durationMinutes: undefined, minutes: undefined },
    { ...newParams, durationMinutes: undefined, minutes: undefined },
  )) {
    // 待ち時間と失敗時は上で個別に出す。残りの設定差は1行にまとめる。
    lines.push(`「${label}」の内容を変えた`)
  }
  return lines
}

function isStepObject(value: unknown): value is CommonActionStep {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { id?: unknown }).id === 'string'
}

/*
 * 2版の処理一覧の変わり方を順に書く。IDで突き合わせ、追加・削除・
 * 順序変更も出す。変わりがなければ「内容の変更はありません」1行。
 */
export function describeVersionChanges(
  previous: CommonActionStep[],
  current: CommonActionStep[],
): string[] {
  if (!Array.isArray(previous) || !Array.isArray(current) || !previous.every(isStepObject) || !current.every(isStepObject)) {
    return ['変更内容を確認できません']
  }
  const lines: string[] = []
  const previousById = new Map(previous.map((step) => [step.id, step]))
  const currentById = new Map(current.map((step) => [step.id, step]))
  const sameMembers = previous.length === current.length
    && previous.every((step) => currentById.has(step.id))
  if (sameMembers) {
    if (previous.some((step, index) => step.id !== current[index]?.id)) lines.push('処理の順番を変えた')
  }
  for (const step of current) {
    const oldStep = previousById.get(step.id)
    if (!oldStep) lines.push(`「${stepLabel(step.type)}」を追加した`)
    else lines.push(...describeStepChange(oldStep, step))
  }
  for (const step of previous) {
    if (!currentById.has(step.id)) lines.push(`「${stepLabel(step.type)}」を外した`)
  }
  if (lines.length === 0) lines.push('内容の変更はありません')
  return lines
}

/* 版の履歴の「変更内容」全行。確認窓と履歴のくわしい説明で使う。 */
export function versionChangeLines(
  version: { versionNumber: number; actions: CommonActionStep[] },
  versions: Array<{ versionNumber: number; actions: CommonActionStep[] }>,
): string[] {
  if (!version || !Array.isArray(versions)) return ['変更内容を確認できません']
  const previous = versions
    .filter((item) => item && typeof item.versionNumber === 'number' && Number.isFinite(item.versionNumber) && item.versionNumber < version.versionNumber)
    .sort((left, right) => right.versionNumber - left.versionNumber)[0]
  if (!previous) return ['はじめて公開した']
  if (!Array.isArray(previous.actions) || !Array.isArray(version.actions)) return ['変更内容を確認できません']
  if (previous.actions.length !== version.actions.length) {
    return [`処理を${formatNumber(previous.actions.length)} 個から${formatNumber(version.actions.length)} 個にした`]
  }
  return describeVersionChanges(previous.actions, version.actions)
}

/* 版の履歴の「変更内容」1行。 */
export function versionChangeSummary(
  version: { versionNumber: number; actions: CommonActionStep[] },
  versions: Array<{ versionNumber: number; actions: CommonActionStep[] }>,
): string {
  return versionChangeLines(version, versions)[0]
}
