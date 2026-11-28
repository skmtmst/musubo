import { knownValue } from '@/lib/known-value'
/**
 * 「数えない条件」の画面側の読み取り(R40)。
 *
 * 保存形は `source_config_json` の中の `exclusion`(条件)・
 * `exclusionMemo`(メモ)・旧 `excludedCondition`(文字列)。条件とメモを
 * 分け、旧文字列はメモとしてだけ読む(条件としては効かせない)。
 * 評価そのものはサーバーが行い、ここでは表示だけを作る。
 */

/** 条件の形(画面とサーバーで同じ)。評価はサーバーが行う。 */
export interface ExclusionCondition {
  operator: 'AND' | 'OR'
  rules: Array<{ type: string; value: unknown }>
  groups?: ExclusionCondition[]
}

function hasRuleValue(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((entry) =>
      entry !== null && entry !== undefined && entry !== ''
      && !(typeof entry === 'number' && !Number.isFinite(entry))
      && !(Array.isArray(entry) && entry.length === 0))
  }
  return false
}

function isRuleShape(rule: unknown): rule is { type: string; value: unknown } {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return false
  const candidate = rule as { type?: unknown; value?: unknown }
  if (candidate.type === 'friend_id_in') return false
  return typeof candidate.type === 'string'
    && candidate.type.length > 0
    && hasRuleValue(candidate.value)
}

function isConditionShape(value: unknown, seen: WeakSet<object> = new WeakSet()): value is ExclusionCondition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (seen.has(value)) return false
  seen.add(value)
  const candidate = value as { operator?: unknown; rules?: unknown; groups?: unknown }
  const valid = (candidate.operator === 'AND' || candidate.operator === 'OR')
    && Array.isArray(candidate.rules)
    && candidate.rules.every(isRuleShape)
    && (
      candidate.groups === undefined
      || (Array.isArray(candidate.groups) && candidate.groups.every((group) => isConditionShape(group, seen)))
    )
  seen.delete(value)
  return valid
}

function isEmptyConditionValue(condition: ExclusionCondition): boolean {
  const groupCount = (condition.groups ?? []).filter(
    (group) => group.rules.length > 0 || (group.groups?.length ?? 0) > 0,
  ).length
  return condition.rules.length === 0 && groupCount === 0
}

/** sourceConfig から実効する条件オブジェクトだけを読む。無い・壊れたときは null。 */
export function readExclusionCondition(sourceConfig: unknown): ExclusionCondition | null {
  if (!sourceConfig || typeof sourceConfig !== 'object' || Array.isArray(sourceConfig)) return null
  const raw = (sourceConfig as Record<string, unknown>).exclusion
  if (!isConditionShape(raw)) return null
  if (raw.rules.length === 0 && (!raw.groups || raw.groups.length === 0)) return null
  return raw
}

/**
 * 編集窓に入れる条件。形が崩れていても保存されている形のまま渡し、
 * 編集窓の側で「読めない」「未完成」を案内して保存を止める（黙って消さない）。
 */
export function readEditableExclusion(sourceConfig: unknown): ExclusionCondition | null {
  if (!sourceConfig || typeof sourceConfig !== 'object' || Array.isArray(sourceConfig)) return null
  const raw = (sourceConfig as Record<string, unknown>).exclusion
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const node = raw as { operator?: unknown; rules?: unknown; groups?: unknown }
  if ((node.operator !== 'AND' && node.operator !== 'OR') || !Array.isArray(node.rules)) return null
  if (node.rules.length === 0 && (!Array.isArray(node.groups) || node.groups.length === 0)) return null
  return raw as ExclusionCondition
}

/** sourceConfig からメモだけを読む(旧文字列もメモとして読む)。 */
export function readExclusionMemo(sourceConfig: unknown): string {
  if (!sourceConfig || typeof sourceConfig !== 'object' || Array.isArray(sourceConfig)) return ''
  const config = sourceConfig as Record<string, unknown>
  return memoText(config.exclusionMemo) ?? memoText(config.excludedCondition) ?? ''
}

export interface ExclusionView {
  /** 実効する条件がある。 */
  hasCondition: boolean;
  /** 条件の行数(グループ内も数える)。 */
  ruleCount: number;
  /** 条件の短い説明(例:「タグ・名前に当てはまる人」)。 */
  summary: string | null;
  /** 自由文のメモ。数え方に影響しない。 */
  memo: string | null;
  /** 条件が壊れていて読めない。 */
  invalid: boolean;
  /** 旧 excludedCondition 文字列をメモとして読んだ。 */
  legacyMemo: boolean;
}

const RULE_LABELS: Record<string, string> = {
  tag_exists: 'タグ',
  tag_all: 'タグ',
  tag_not_exists: 'タグの除外',
  tag_not_all: 'タグの除外',
  name: '名前',
  private_memo: 'メモ',
  status_message: 'ステータスメッセージ',
  registered_at: '友だち登録日',
  support_mark: '対応マーク',
  friend_field: '友だち情報',
  scenario_subscribed: 'シナリオ購読',
  scenario_state: 'シナリオ',
  form_answered: '回答フォーム',
  last_reaction_at: '最終反応日',
  reaction_state: '反応状態',
  score_range: '行動スコア',
  is_following: 'ブロック状態',
  is_hidden: '表示状態',
  ref_code: '紹介コード',
  metadata_equals: '共通情報',
  metadata_not_equals: '共通情報',
}

function memoText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function collectRuleLabels(node: {
  rules?: Array<{ type?: unknown }>;
  groups?: unknown;
}): string[] {
  const labels: string[] = []
  for (const rule of node.rules ?? []) {
    const label = typeof rule?.type === 'string' ? (knownValue(RULE_LABELS, rule.type, '条件')) : '条件'
    if (!labels.includes(label)) labels.push(label)
  }
  if (Array.isArray(node.groups)) {
    for (const group of node.groups) {
      if (group && typeof group === 'object') {
        for (const label of collectRuleLabels(group as { rules?: Array<{ type?: unknown }> })) {
          if (!labels.includes(label)) labels.push(label)
        }
      }
    }
  }
  return labels
}

function countRules(node: { rules?: unknown[]; groups?: unknown }): number {
  let count = Array.isArray(node.rules) ? node.rules.length : 0
  if (Array.isArray(node.groups)) {
    for (const group of node.groups) {
      if (group && typeof group === 'object') count += countRules(group as { rules?: unknown[] })
    }
  }
  return count
}

/** sourceConfig から表示用の除外情報を読む。壊れていても投げない。 */
export function readExclusionView(sourceConfig: unknown): ExclusionView {
  const empty: ExclusionView = {
    hasCondition: false, ruleCount: 0, summary: null, memo: null, invalid: false, legacyMemo: false,
  }
  if (!sourceConfig || typeof sourceConfig !== 'object' || Array.isArray(sourceConfig)) return empty
  const config = sourceConfig as Record<string, unknown>
  const memo = memoText(config.exclusionMemo)
  const legacy = memoText(config.excludedCondition)
  const view: ExclusionView = {
    ...empty,
    memo: memo ?? legacy,
    legacyMemo: memo === null && legacy !== null,
  }
  const raw = config.exclusion
  if (raw === undefined || raw === null) return view
  if (!isConditionShape(raw)) return { ...view, invalid: true }
  if (isEmptyConditionValue(raw)) return view
  const ruleCount = countRules(raw)
  const labels = collectRuleLabels(raw)
  return {
    ...view,
    hasCondition: true,
    ruleCount,
    summary: `${labels.length > 0 ? labels.join('・') : '条件'}に当てはまる人`,
  }
}
