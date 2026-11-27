'use client'

import { knownValue } from '@/lib/known-value'

import { PAGE_SIZE_SELECT_OPTIONS } from '@/components/shared/page-size-select'
import { formatStamp } from '@/lib/common-vars'
import { formatListTimestamp,formatDate as polishFormatDate } from '@/lib/format'
import type { CommonVar } from '@line-crm/shared'
import { type CommonVarFilter,type CommonVarOrder } from './model'


/*
 * ★V8 共通情報の一覧（Pencil「★V8 画面の地図」の共通情報の行：
 * 一覧 、一覧（1152）、一覧（閲覧のみ）、
 * 止める窓 、削除の窓 、状態 ）。
 *
 * 一覧の型（ListPage）に載せて一から書いた。動き（読む API・権限・失敗時・
 * 止める／削除の確かめ方・まとめて削除・フォルダ）は今の V8 一覧
 * （app/contents/vars/list-v8.tsx）と同じ。違いは置き場と見せ方だけ——
 * 数の帯は板の横いっぱい、「共通情報を作る」は左のフォルダの列の上、
 * 空のまま使われているときの黄色の帯は表の列の上、行の右端は「…」
 * （編集・止める／再開する・削除する）。右クリックでも同じものが出る。
 */

/** 「未分類」を表す絞り込みの値。空文字だと「すべて」と区別できない。 */
export const UNGROUPED = '__ungrouped__'

/*
 * 一括削除の上限。1件ごとに使用先9種の走査が走るため、
 * 件数に比例してWorker・D1が重くなる。上限を超えたら確認口を打たず、
 * 絞り込みで分けるよう案内する。
 */
export const MAX_BATCH_DELETE_COUNT = 20

/** 期限が近い帯の幅。7日以内に期限切れになるものを数える。 */
export const EXPIRING_SOON_MS = 7 * 24 * 3600_000

/*
 * 道具の段の絞り込み（板 ：空のまま・期限つき・使われていない・
 * 下書き・止めた）。1つだけ選べる。選んだ札をもう一度押すと「すべて」に戻る。
 * 期限切れは絵に無いが今の機能なので、期限切れがあるとき（選んでいるとき）だけ出す。
 */
export type VarsChip = 'all' | 'empty' | 'scheduled' | 'unused' | 'draftStopped' | 'expired'

export const CHIP_FILTER: Record<VarsChip, CommonVarFilter> = {
  all: 'all',
  empty: 'empty',
  scheduled: 'scheduled',
  unused: 'unused',
  draftStopped: 'all',
  expired: 'expired',
}

export const ORDER_OPTIONS: Array<{ value: CommonVarOrder; label: string }> = [
  { value: 'usage_desc', label: '使われている数が多い順' },
  { value: 'updated_desc', label: '更新が新しい順' },
  { value: 'name_asc', label: '名前順' },
]

/** 表示件数（絵：10・20・50件）。 */
export const PAGE_SIZE_OPTIONS = PAGE_SIZE_SELECT_OPTIONS

/** 記録の更新日時は別年でも時刻を残す。業務値の日付は変えない。 */
export function formatListDate(value: string): string {
  return formatListTimestamp(value)
}

/** 「10/7まで」の札の日付。年月は要らず、月日だけ出す。 */
export function formatMonthDay(value: string): string {
  return polishFormatDate(value, { style: 'list-day', fallback: '—' })
}

/*
 * 種別が年月日・日時の値は、保存形（2027-10-01 や 2027-10-01T10:00）を
 * そのまま出すと一覧のほかの日付と区切りが違って見える。
 * `formatStamp` の「/」区切り（曜日付き）にそろえる。
 */
export function formatVarValue(type: CommonVar['type'], value: string): string {
  if (!value) return ''
  if (type === 'date' || type === 'datetime') return formatStamp(value)
  return value
}


import { COMMON_VAR_STATE_LABELS } from '@/lib/common-vars'
/** 札の文言と色。期限つきの使用中は「M/dまで」を青で出す（板 ）。 */
export function stateBadge(item: CommonVar): { label: string; tone: 'success' | 'info' | 'warning' | 'neutral' } {
  const state = item.state ?? 'active'
  if (state === 'active' && item.validUntil) {
    return { label: formatMonthDay(item.validUntil), tone: 'info' }
  }
  return {
    label: knownValue(COMMON_VAR_STATE_LABELS, state, '状態を確認できません'),
    tone: state === 'active' ? 'success' : state === 'expired' ? 'warning' : 'neutral',
  }
}
