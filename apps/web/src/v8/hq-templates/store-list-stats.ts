import { emptyValue } from '@/components/shared/empty-value';
import { formatNumber } from '@/lib/format';
import type { HqTemplate } from '@/lib/hq-templates-api';



/** M月D日（店の一覧と同じ。時刻は title）。 */

/** 配布の保存記録だけを表示する。配布先でのお客さまへの公開は、個別の公開記録で判定する。 */
export function stateOf(row: HqTemplate): { label: string; tone: 'live' | 'changes' | 'draft' } {
  if (row.distributed_account_count == null) return { label: emptyValue('unknown'), tone: 'draft' }
  if (row.distributed_account_count === 0) return { label: '未配布', tone: 'draft' }
  if (row.outdated_account_count == null) return { label: emptyValue('unknown'), tone: 'draft' }
  if (row.outdated_account_count > 0) return { label: '更新の配布待ち', tone: 'changes' }
  return { label: '配布済み', tone: 'live' }
}


/** 件数は0以上の整数だけが確定値。 */
export function isKnownCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 合計（API-18）。1つでも不明・不正な行があれば null（「—」）。 */
export function sumOrNull(values: Array<number | null | undefined>): number | null {
  if (!values.every(isKnownCount)) return null
  const total = values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
  return Number.isSafeInteger(total) ? total : null
}


/** 今月送った数（API-18）。取れない種類（別資産のクーポン等）は null＝「—」。0 は「0通」。 */
export function sentLabel(count: number | null | undefined): string {
  return count == null ? emptyValue('unknown') : `${formatNumber(count)}通`
}
