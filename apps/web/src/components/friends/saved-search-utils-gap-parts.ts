import { knownValue } from '@/lib/known-value'
import type { SavedSearchCondition, SavedSearchConditions, Tag } from '@line-crm/shared';


export type SavedSearchConditionLabels = {
  marks?: Readonly<Record<string, string>>
  scenarios?: Readonly<Record<string, string>>
  fields?: Readonly<Record<string, string>>
  assignees?: Readonly<Record<string, string>>
  forms?: Readonly<Record<string, string>>
}


const CHAT_STATUS_LABELS: Readonly<Record<string, string>> = {
  unread: '未対応',
  in_progress: '対応中',
  on_hold: '保留',
  resolved: '対応済み',
}


function singleDateLabel(condition: SavedSearchCondition, name: string): string {
  const value = typeof condition.value === 'string' ? condition.value : ''
  if (condition.op === 'between' && condition.value && typeof condition.value === 'object') {
    const range = condition.value as { from?: unknown; to?: unknown }
    const from = typeof range.from === 'string' ? range.from : ''
    const to = typeof range.to === 'string' ? range.to : ''
    if (from && to) return `${name}が ${from}〜${to}`
    if (from) return `${name}が ${from}以降`
    if (to) return `${name}が ${to}以前`
    return `${name}を指定`
  }
  if (condition.op === 'after' && value) return `${name}が ${value}以降`
  if (condition.op === 'before' && value) return `${name}が ${value}以前`
  return `${name}を指定`
}


/*
 * 友だち情報欄の値に使う比較方法の呼び名。
 * `SAVED_SEARCH_FIELD_OPS`（packages/shared）と1対1。編集画面が
 * 10演算子すべてを作れるので、eq/ne 以外も誤った文言で出さない
 * （IDEA-04：変更前後の条件をそのまま読める形で出す）。
 */
const FIELD_OP_LABELS: Readonly<Record<string, string>> = {
  eq: 'が次と同じ',
  equals: 'が次と同じ',
  ne: 'が次と異なる',
  not_equals: 'が次と異なる',
  contains: 'が次を含む',
  not_contains: 'が次を含まない',
  gte: 'が次以上',
  gt: 'がより大きい',
  lte: 'が以下',
  lt: 'がより小さい',
}


/** 「〜が無い」系の存在確認の否定形。has/eq は旧形式の互換名。 */
const NEGATED_OPS = new Set(['not_exists', 'not_has', 'excludes', 'ne', 'not_equals'])


/** 保存値のIDや演算子を画面へ露出させず、運用者が読める条件にする。 */
export function describeSavedCondition(
  condition: SavedSearchCondition,
  tags: Tag[] = [],
  labels: SavedSearchConditionLabels = {},
): string {
  const raw = typeof condition.value === 'string' ? condition.value : ''
  const value = condition.kind === 'tag'
    ? tags.find((tag) => tag.id === raw)?.name ?? (raw ? '選択済みのタグ' : '')
    : raw
  if (condition.kind === 'tag') return `タグ ${NEGATED_OPS.has(condition.op) ? 'を含まない' : 'を含む'}「${value || '未指定'}」`
  if (condition.kind === 'name') return condition.op === 'eq' ? `名前が「${value || '未指定'}」` : `名前に「${value || '未指定'}」を含む`
  if (condition.kind === 'field') {
    const fieldName = condition.key
      ? labels.fields?.[condition.key] ?? '選択済みの友だち情報'
      : '項目未指定'
    if (condition.op === 'exists' || condition.op === 'has') return `${fieldName} が登録あり`
    if (condition.op === 'not_exists' || condition.op === 'not_has') return `${fieldName} が未登録`
    return `${fieldName} ${knownValue(FIELD_OP_LABELS, condition.op, 'が次と同じ')}「${value || '未指定'}」`
  }
  if (condition.kind === 'status_message') return condition.op === 'eq' ? `ステータスメッセージが「${value || '未指定'}」` : `ステータスメッセージに「${value || '未指定'}」を含む`
  if (condition.kind === 'mark') return `対応マークが「${labels.marks?.[raw] ?? (raw ? '選択済みの対応マーク' : '未指定')}」`
  if (condition.kind === 'scenario') return `シナリオが「${labels.scenarios?.[raw] ?? (raw ? '選択済みのシナリオ' : '未指定')}」`
  if (condition.kind === 'assignee') {
    const assigneeName = labels.assignees?.[raw] ?? (raw ? '選択済みの担当者' : '未指定')
    return NEGATED_OPS.has(condition.op) ? `担当者が「${assigneeName}」以外` : `担当者が「${assigneeName}」`
  }
  if (condition.kind === 'visit_count' || condition.kind === 'purchase_amount') {
    const r = (condition.value ?? {}) as { min?: number; max?: number }
    const unit = condition.kind === 'visit_count' ? '回' : '円'
    return `${condition.kind === 'visit_count' ? '来店の回数' : '購入の合計金額'} ${r.min ?? '…'}${unit} 〜 ${r.max ?? '…'}${unit}`
  }
  if (condition.kind === 'last_activity_at') {
    const r = (condition.value ?? {}) as { from?: string; to?: string }
    return `最後の来店・購入の日 ${r.from ?? '…'} 〜 ${r.to ?? '…'}`
  }
  if (condition.kind === 'member_tier') return '会員ランクを指定'
  if (condition.kind === 'chat_status') return `対応状況が「${knownValue(CHAT_STATUS_LABELS, raw, raw ? '選択済みの状態' : '未指定')}」`
  if (condition.kind === 'following') return condition.value === true ? '友だち中' : 'ブロック済み'
  if (condition.kind === 'created_at') return singleDateLabel(condition, '友だち追加日')
  if (condition.kind === 'last_activity') return singleDateLabel(condition, '最終反応日')
  if (condition.kind === 'event_booking') return NEGATED_OPS.has(condition.op) ? 'イベント予約がない' : 'イベント予約がある'
  if (condition.kind === 'calendar_booking') return NEGATED_OPS.has(condition.op) ? 'カレンダー予約がない' : 'カレンダー予約がある'
  if (condition.kind === 'reminder') return NEGATED_OPS.has(condition.op) ? 'リマインダがない' : 'リマインダがある'
  if (condition.kind === 'memo') {
    if (condition.op === 'exists' || condition.op === 'has') return 'メモがある'
    if (condition.op === 'not_exists' || condition.op === 'not_has') return 'メモがない'
    if (condition.op === 'eq' || condition.op === 'equals') return `メモが「${value || '未指定'}」`
    return `メモに「${value || '未指定'}」を含む`
  }
  if (condition.kind === 'common_event') return NEGATED_OPS.has(condition.op) ? `その他のイベント「${value || '未指定'}」がない` : `その他のイベント「${value || '未指定'}」がある`
  /*
   * R185: 回答フォーム・購入履歴は実行側が解釈できる（saved-search-filter）。
   * 「未接続」として削除を迫らない。特定の指定があれば名前で読める形にする。
   */
  if (condition.kind === 'form') {
    const formName = labels.forms?.[raw] ?? (raw ? '選択済みの回答フォーム' : '')
    return NEGATED_OPS.has(condition.op)
      ? `回答フォーム${formName ? `「${formName}」` : ''}の回答がない`
      : `回答フォーム${formName ? `「${formName}」` : ''}の回答がある`
  }
  if (condition.kind === 'purchase') {
    return NEGATED_OPS.has(condition.op)
      ? `購入履歴${raw ? `「${raw}」` : ''}がない`
      : `購入履歴${raw ? `「${raw}」` : ''}がある`
  }
  return '条件を確認できません'
}


export function savedSearchSummary(
  conditions: SavedSearchConditions,
  tags: Tag[] = [],
  labels: SavedSearchConditionLabels = {},
): string[] {
  return [
    ...(conditions.all ?? []).map((condition) => `AND: ${describeSavedCondition(condition, tags, labels)}`),
    ...(conditions.any ?? []).map((condition) => `OR: ${describeSavedCondition(condition, tags, labels)}`),
  ]
}
export { CHAT_STATUS_LABELS, singleDateLabel, FIELD_OP_LABELS, NEGATED_OPS }
