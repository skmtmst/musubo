import { formatNumber } from '@/lib/format'
import { isRuleComplete, pruneCondition, type SegmentCondition, type SegmentRule } from '@/components/shared/condition-builder';

/**
 * 「だれに」の条件の1行を、状況メモへ書く（AUTOMATION-02）。
 *
 * **保存に送るのと同じ条件**から作るので、「条件なし」と出しながら実は
 * 絞り込んでいた、というずれは起きない。言い方は条件部品
 * （condition-builder.tsx）の選択肢に揃える。
 */
export function describeConditionRule(
  rule: SegmentRule,
  lookups: {
    tags: ReadonlyArray<{ id: string; name: string }>
    scenarios: ReadonlyArray<{ id: string; name: string }>
  },
): string {
  const v = rule.value as Record<string, unknown>
  const tagName = (id: string) => lookups.tags.find((tag) => tag.id === id)?.name ?? (id || 'タグ')
  const scenarioName = (id: string) =>
    lookups.scenarios.find((item) => item.id === id)?.name ?? (id || 'シナリオ')
  const dateRange = (label: string): string => {
    const from = typeof v?.from === 'string' && v.from ? v.from : ''
    const to = typeof v?.to === 'string' && v.to ? v.to : ''
    if (from && to) return `${label}が${from}〜${to}の人`
    if (from) return `${label}が${from}以降の人`
    if (to) return `${label}が${to}までの人`
    return `${label}で絞る人`
  }
  switch (rule.type) {
    case 'tag_exists':
      return `タグ「${tagName(String(rule.value ?? ''))}」を持っている人`
    case 'tag_not_exists':
      return `タグ「${tagName(String(rule.value ?? ''))}」を持っていない人`
    case 'tag_all':
      return '選んだタグをすべて持っている人'
    case 'tag_not_all':
      return '選んだタグをすべて持っている人を除く'
    case 'is_following':
      return rule.value === false ? 'ブロック中の人' : '友だち中の人'
    case 'is_hidden':
      return rule.value === true ? '非表示の人' : '表示中の人'
    case 'name': {
      const text = typeof v?.text === 'string' ? v.text.trim() : ''
      return text ? `名前に「${text}」を含む人` : '名前で絞る人'
    }
    case 'private_memo': {
      const text = typeof rule.value === 'string' ? rule.value.trim() : ''
      return text ? `メモに「${text}」を含む人` : 'メモで絞る人'
    }
    case 'status_message': {
      const text = typeof rule.value === 'string' ? rule.value.trim() : ''
      return text ? `ステータスメッセージに「${text}」を含む人` : 'ステータスメッセージで絞る人'
    }
    case 'registered_at':
      return dateRange('友だち登録日')
    case 'last_reaction_at':
      return dateRange('最終反応日')
    case 'support_mark': {
      const count = Array.isArray(v?.markIds) ? v.markIds.length : 0
      return v?.exclude === true
        ? `選んだ対応マーク（${formatNumber(count)} 件）の人を除く`
        : `対応マーク（${formatNumber(count)} 件）の人`
    }
    case 'friend_field':
      return '友だち情報で絞る人'
    case 'scenario_subscribed': {
      const id = typeof rule.value === 'string' ? rule.value : ''
      return id ? `シナリオ「${scenarioName(id)}」を購読中の人` : 'いずれかのシナリオを購読中の人'
    }
    case 'scenario_state': {
      const id = typeof v?.scenarioId === 'string' ? v.scenarioId : ''
      const states: Record<string, string> = Object.assign(Object.create(null), {
        subscribed: 'を購読中',
        not_subscribed: 'を購読していない',
        completed: 'を読み終えた',
        ever: 'を1度でも購読した',
      })
      return `シナリオ「${scenarioName(id)}」${states[String(v?.state ?? 'subscribed')] ?? 'の購読状態が不明'}の人`
    }
    case 'form_answered':
      return typeof rule.value === 'string' && rule.value
        ? '選んだフォームに回答した人'
        : 'いずれかのフォームに回答した人'
    case 'reaction_state': {
      const labels: Record<string, string> = Object.assign(Object.create(null), {
        reply_or_postback: '返信・応答のある人',
        reply: '返信のある人',
        postback: 'ボタン応答のみの人',
        none: '返信・応答の無い人',
      })
      return labels[String(rule.value)] ?? '反応状態を確認できない人'
    }
    case 'score_range': {
      const min = typeof v?.min === 'number' ? v.min : null
      const max = typeof v?.max === 'number' ? v.max : null
      if (min !== null && max !== null) return `行動スコア${min}〜${max}の人`
      if (min !== null) return `行動スコア${min}以上の人`
      if (max !== null) return `行動スコア${max}以下の人`
      return '行動スコアで絞る人'
    }
    default:
      return '条件を付けた人'
  }
}

/** 条件の木に入っている全ルール（要約用に平らにする）。 */
export const collectConditionRules = (condition: SegmentCondition | null): SegmentRule[] =>
  !condition
    ? []
    : [...condition.rules, ...(condition.groups ?? []).flatMap(collectConditionRules)]

/**
 * 保存されていた条件を、この画面の編集の形へ戻す。
 *
 * 以前の保存口は「軸 + 自由入力」の独自形で、名前なら文字列のまま
 * 保存されていた（計算側は `{ text, targets }` を期待する）。その古い形は
 * **「読めない条件」として区別する**——黙って条件なしへ戻すと、知らない
 * うちに全員へ届くルールに変わってしまう（AUTOMATION-04）。
 */
export const storedConditionToForm = (
  raw: unknown,
): { condition: SegmentCondition | null; unreadable: boolean } => {
  if (raw === null || raw === undefined) return { condition: null, unreadable: false }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { condition: null, unreadable: true }
  if (Object.keys(raw as Record<string, unknown>).length === 0) {
    return { condition: null, unreadable: false }
  }
  const candidate = raw as Partial<SegmentCondition>
  if ((candidate.operator !== 'AND' && candidate.operator !== 'OR') || !Array.isArray(candidate.rules)) {
    return { condition: null, unreadable: true }
  }
  const nodeUsable = (node: SegmentCondition): boolean =>
    node.rules.every(
      (rule) => Boolean(rule) && typeof rule === 'object' && typeof rule.type === 'string' && isRuleComplete(rule),
    ) && (node.groups ?? []).every(nodeUsable)
  if (!nodeUsable(candidate as SegmentCondition)) return { condition: null, unreadable: true }
  return { condition: candidate as SegmentCondition, unreadable: false }
}

/** 画面で意味を確かめられない条件は、公開前に選び直してもらう。 */
const EDITABLE_CONDITION_TYPES = new Set(['name', 'private_memo', 'status_message', 'registered_at', 'support_mark', 'tag_exists', 'tag_not_exists', 'tag_all', 'tag_not_all', 'friend_field', 'scenario_subscribed', 'scenario_state', 'form_answered', 'last_reaction_at', 'reaction_state', 'score_range', 'visit_count', 'purchase_amount', 'last_activity_at', 'member_tier', 'is_following', 'is_hidden', 'analytics_audience', 'broadcast_link_clicked'])
const SCENARIO_CONDITION_STATES = new Set(['subscribed', 'not_subscribed', 'completed', 'ever'])
const REACTION_CONDITION_STATES = new Set(['reply_or_postback', 'reply', 'postback', 'none'])
const FIELD_OPERATORS = new Set(['equals', 'contains', 'exists', 'not_exists', 'not_equals', 'not_contains', 'gte', 'gt', 'lte', 'lt'])
export const UNKNOWN_CONDITION_REASON = '確認できない条件があります。条件を選び直してから公開してください。'
export function hasUnknownCondition(condition: SegmentCondition | null | undefined): boolean {
  if (!condition) return false
  if (condition.operator !== 'AND' && condition.operator !== 'OR') return true
  return condition.rules.some((rule) => {
    if (!EDITABLE_CONDITION_TYPES.has(rule.type)) return true
    if (rule.type === 'is_following' || rule.type === 'is_hidden') return typeof rule.value !== 'boolean'
    if (rule.type === 'scenario_state' || rule.type === 'friend_field') {
      if (!rule.value || typeof rule.value !== 'object' || Array.isArray(rule.value)) return true
      const value = rule.value as Record<string, unknown>
      if (rule.type === 'scenario_state') return !SCENARIO_CONDITION_STATES.has(String(value.state ?? 'subscribed'))
      return !FIELD_OPERATORS.has(String(value.op ?? 'contains'))
    }
    return rule.type === 'reaction_state' && !REACTION_CONDITION_STATES.has(String(rule.value))
  }) || (condition.groups ?? []).some(hasUnknownCondition)
}

/**
 * 「だれに」の条件を、保存で送る形へ直す（AUTOMATION-04）。
 *
 * 書きかけの行（タグを選ぶ前など）は落とす。一斉配信・シナリオと同じ
 * `pruneCondition` を使うので、保存される形は計算側の正本と一致する。
 * 条件が実質無ければ `{}`（＝絞り込みなし）を送る。
 */
export const conditionPayload = (condition: SegmentCondition | null): Record<string, unknown> =>
  (pruneCondition(condition) ?? {}) as Record<string, unknown>
