import type { AccountHandover } from '@/lib/api'
import { formatNumber } from '@/lib/format'

/*
 * 乗り換え（V8）の言葉。今の画面（app/accounts/handover/handover-view.ts）の決まりを写した。
 * src/v8 からは @/app を読めないため。
 */

/** 絵の4つの段の札。 */
export const HANDOVER_PILLS = ['引き継ぎコード', '事前確認', '要確認を決める', '本実行'] as const

/** 状態 → いま光らせる段（1〜4）。事前確認が済んだら「要確認を決める」、決め終わったら「本実行」。 */
export function handoverPill(status: AccountHandover['status']): number {
  switch (status) {
  case 'code_issued':
  case 'cancelled':
    return 1
  case 'linked':
    return 2
  case 'previewed':
    return 3
  default:
    return 4
  }
}

/** 事前確認の4区分。合計が元の友だちの数と必ず合う。 */
export const MATCH_BUCKETS = [
  { key: 'auto', label: '自動で同じ人' },
  { key: 'review', label: '要確認' },
  { key: 'unmatched', label: '一致しない' },
  { key: 'lookalike', label: '別人の可能性' },
] as const

export type MatchBucketKey = (typeof MATCH_BUCKETS)[number]['key']
export type MatchCounts = Record<MatchBucketKey, number>

function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** 4区分の合計が、元の友だちの数と合っているか。合わない結果は画面に出さない。 */
export function totalsMatch(counts: MatchCounts | null, sourceTotal: number | null): boolean {
  if (!counts || typeof counts !== 'object') return false
  const total = nonNegativeInt(sourceTotal)
  if (total === null) return false
  let sum = 0
  for (const bucket of MATCH_BUCKETS) {
    const value = nonNegativeInt(counts[bucket.key])
    if (value === null) return false
    sum += value
  }
  return sum === total
}

/** `元の友だち 14 人：自動で同じ人 10・要確認 2・一致しない 2`。0 の区分は書かない（要確認は 0 でも書く）。 */
export function countsLine(counts: MatchCounts & { sourceTotal: number }): string {
  const parts = MATCH_BUCKETS
    .filter((bucket) => bucket.key === 'review' || counts[bucket.key] > 0)
    .map((bucket) => `${bucket.label} ${counts[bucket.key]}`)
  return `元の友だち ${formatNumber(counts.sourceTotal)} 人：${parts.join('・')}`
}

/** 判断の言葉。 */
export function decisionLabel(decision: 'link' | 'new' | 'skip'): string {
  return decision === 'link' ? '同じ人' : decision === 'new' ? '新しく作る' : '引き継がない'
}

/** プロバイダーが違うときの断り（1行と、続きの説明）。 */
export const DIFFERENT_PROVIDER_LEAD = 'プロバイダーが違うので、友だちのIDは自動でつなげません'
export const DIFFERENT_PROVIDER_DETAIL =
  '同じ人でも別のIDになるので、対応表を取り込むか、1件ずつ手で結びつけます（利用目的・規約・同意の確認も要ります）'
