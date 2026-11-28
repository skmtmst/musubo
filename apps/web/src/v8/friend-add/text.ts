import type { SegmentCondition } from '@/lib/segment-condition'
import type { FriendAddRuleOptions } from '@/lib/api'

/*
 * 「再追加時の制限」の選択肢と同じ言葉で出す。保存値は時間数 (0/24/168)。
 * テスト実施状態 (lastTestStatus) をここへ混ぜない(#946 N-109)。
 *
 * エディタと最終確認で**同じ変換**を使う。片方だけ固定文言にすると、
 * 設定値と確認画面の説明が食い違う。
 */
export function resendSuppressionText(hours: number | null | undefined): string {
  const value = typeof hours === 'number' && Number.isFinite(hours) ? hours : 24
  if (value <= 0) return '制限しない'
  if (value === 24) return '24時間に1回'
  if (value % 24 === 0) return `${value / 24}日に1回`
  return `${value}時間に1回`
}

/** 日時の欄（datetime-local）の値。保存値の秒・時差は落として見せる。 */
export function localInputValue(value: string | null) {
  if (typeof value !== 'string' || !value) return ''
  return value.slice(0, 16)
}

/** 友だち条件の1行の言い方（タグの有無だけ名前で言う。ほかは件数）。 */
export function conditionSummary(condition: SegmentCondition | null, tags: FriendAddRuleOptions['tags']) {
  const rules = Array.isArray(condition?.rules) ? condition.rules : []
  const groups = Array.isArray(condition?.groups) ? condition.groups : []
  if (!condition || rules.length + groups.length === 0) return '友だち条件：なし（全員）'
  const safeTags = Array.isArray(tags) ? tags : []
  const tagName = (value: unknown) => {
    const id = typeof value === 'string' ? value : (value as { tagId?: string } | null)?.tagId
    if (typeof id !== 'string' || !id) return null
    return safeTags.find((tag) => tag && tag.id === id)?.name ?? null
  }
  const parts = rules.map((rule) => {
    if (!rule || typeof rule !== 'object') return null
    const name = tagName(rule.value)
    if (rule.type === 'tag_exists' && name) return `タグ「${name}」が付いている`
    if (rule.type === 'tag_not_exists' && name) return `タグ「${name}」が付いていない`
    return null
  })
  if (parts.length === 1 && parts[0] && groups.length === 0) return `友だち条件：${parts[0]}`
  return `友だち条件：${rules.length + groups.length}つ`
}
