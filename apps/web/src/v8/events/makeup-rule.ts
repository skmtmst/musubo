import type { EventMakeupRule } from '@/lib/api'

/** 読み出せない値を「オフ」と決めつけず、保存操作を止める。 */
export function readMakeupRule(value: string | null | undefined): EventMakeupRule | null {
  try {
    if (typeof value !== 'string' || !value.trim()) return null
    const r = JSON.parse(value) as EventMakeupRule
    if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.enabled !== 'boolean'
      || !Number.isInteger(r.cutoffHours) || r.cutoffHours < 0 || r.cutoffHours > 168
      || !Number.isInteger(r.validDays) || r.validDays < 1 || r.validDays > 366
      || !Number.isInteger(r.monthlyCap) || r.monthlyCap < 1 || r.monthlyCap > 52
      || !['same_kind', 'list'].includes(r.target) || !Array.isArray(r.targetIds)
      || r.targetIds.length > 100 || r.targetIds.some(id => typeof id !== 'string')
      || (r.target === 'list' && !r.targetIds.length)) return null
    return r
  } catch { return null }
}

export function makeupRuleSummary(rule: EventMakeupRule): string {
  const cutoff = Number.isFinite(rule.cutoffHours) && rule.cutoffHours >= 0
    ? `開始の ${rule.cutoffHours} 時間前まで`
    : '開始前の締切未設定'
  const valid = Number.isFinite(rule.validDays) && rule.validDays >= 1
    ? `元の回から ${rule.validDays} 日間`
    : '有効期限未設定'
  const cap = Number.isFinite(rule.monthlyCap) && rule.monthlyCap >= 1
    ? `月 ${rule.monthlyCap} 回まで`
    : '月の上限未設定'
  const targetCount = Array.isArray(rule.targetIds) ? rule.targetIds.length : 0
  return `${rule.enabled ? '使う' : '使わない'}・${cutoff}・${valid}・${cap}・${rule.target === 'same_kind' ? '同じクラス' : `指定の ${targetCount} クラス`}`
}
