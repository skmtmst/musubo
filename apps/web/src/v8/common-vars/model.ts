/*
 * 共通情報の一覧で使う計算（管理画面 の app/contents/vars/list-model.ts と delete-impact.ts の写し）。
 * src/v8 からは古い画面ファイルを import できないため、同じ中身をここに持つ。
 * 動きを変えるときは 管理画面 側と両方を直す（V8 完成までの二重管理）。
 */
import type { CommonVar, CommonVarDeleteImpact, CommonVarDeleteImpactItem } from '@line-crm/shared'
import { formatDateTime, formatNumber } from '@/lib/format'
import { requiredText, type FormRequirement } from '@/lib/form-requirement'

export function validNonNegInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export const reasonRequirement = requiredText('理由を入力してください。')
export function typedKeyRequirement(impact: CommonVarDeleteImpact | null): FormRequirement {
  const varKey = typeof impact?.variable?.varKey === 'string' ? impact.variable.varKey.trim() : ''
  const expected = varKey ? placeholderText(varKey) : ''
  return {
    required: Boolean(impact?.canDelete),
    check: (value) => {
      if (!expected) return '差し込みキーを確認できないため削除できません。'
      return value.trim() === expected ? null : `確認のため ${expected} を入力してください。`
    },
  }
}

export type CommonVarFilter = 'all' | 'empty' | 'scheduled' | 'unused' | 'draft' | 'stopped' | 'expired'
export type CommonVarOrder = 'usage_desc' | 'updated_desc' | 'name_asc'

export function filterAndSortCommonVars(
  items: CommonVar[],
  input: { query: string; folderId: string; ungroupedValue: string; filter: CommonVarFilter; order: CommonVarOrder },
): CommonVar[] {
  const needle = input.query.trim().toLocaleLowerCase('ja-JP')
  return items
    .filter((item) => {
      if (input.folderId === input.ungroupedValue && item.folderId !== null) return false
      if (input.folderId && input.folderId !== input.ungroupedValue && item.folderId !== input.folderId) return false
      if (input.filter === 'empty' && item.value !== '') return false
      /*
       * 「期限つき」は有効期間（validFrom/validUntil）のこと（VAR-04、
       * 要件 管理画面-14 §8-1）。値の切替予約（nextSchedule）も期限のある
       * 動きなので拾い続ける。両方ないものだけを外す。
       */
      if (input.filter === 'scheduled'
        && !item.nextSchedule && item.validFrom === null && item.validUntil === null) return false
      if (input.filter === 'unused' && item.usageCount !== 0) return false
      // Q: 状態（下書き・止めた・期限切れ）で絞る。サーバの計算した
      // state をそのまま見る（期限切れは時刻からの計算済み）。
      if ((input.filter === 'draft' || input.filter === 'stopped' || input.filter === 'expired')
        && (item.state ?? 'active') !== input.filter) return false
      if (!needle) return true
      return [item.name, item.varKey, item.value]
        .some((value) => value.toLocaleLowerCase('ja-JP').includes(needle))
    })
    .toSorted((left, right) => {
      if (input.order === 'name_asc') return left.name.localeCompare(right.name, 'ja-JP')
      if (input.order === 'updated_desc') return right.updatedAt.localeCompare(left.updatedAt)
      const leftUsage = validNonNegInt(left.usageCount) ? left.usageCount : -1
      const rightUsage = validNonNegInt(right.usageCount) ? right.usageCount : -1
      return rightUsage - leftUsage || left.name.localeCompare(right.name, 'ja-JP')
    })
}

/**
 * 共通情報を消したときの影響（設計 `yPkWe` 14-1-C／契約 #611）。
 *
 * **消すと、差し込んでいた場所が空欄のまま送られる。** 「ご不明な点は
 * までお気軽にどうぞ。」のような文になる。何か所でそれが起きるのかを、
 * 押す前に言う。
 */

/** 取得元が無い値。実値の0とは別。 */
export const NOT_AVAILABLE = '—（未取得）'

/**
 * 差し込みキーの見せ方。
 *
 * 本文で実際に置き換えられるのは `{{var.shop_hours}}` の形だけ
 * （差し込みの解析は `{{ … }}` しか拾わない）。`{営業時間}` のような
 * 見た目だけの表記を案内すると、手で写した運用者の本文が
 * 置き換えられないまま相手に届く。一覧・編集・コピーで出す表記は、
 * 挿入ツールが入れる形と同じ内部参照にそろえる。
 */
export function placeholderText(varKey: string): string {
  return `{{var.${varKey}}}`
}

/**
 * 何か所で使われているか。
 *
 * **0か所は「どこにも差し込まれていません」。** 未取得と混ぜない。
 */
export function usageText(impact: CommonVarDeleteImpact): string {
  if (!validNonNegInt(impact.total)) return `${placeholderText(impact.variable.varKey)} の使用先件数を確認できません。`
  if (impact.total === 0) return 'どこにも差し込まれていません。'
  return `${placeholderText(impact.variable.varKey)} は ${formatNumber(impact.total)}か所で差し込まれています。`
}

/**
 * 消したときに起きること。
 *
 * **「消えます」ではなく「空欄のまま送られます」。** 差し込みが消えても
 * 文そのものは送られ続けるので、そこが伝わらないと危ない。
 */
export function consequenceText(impact: CommonVarDeleteImpact): string | null {
  if (impact.total === 0) return null
  if (!validNonNegInt(impact.total)) {
    return `削除すると、使用中の場所の ${placeholderText(impact.variable.varKey)} は空欄のまま送られます。`
  }
  return `削除すると、その${formatNumber(impact.total)}か所の `
    + `${placeholderText(impact.variable.varKey)} は空欄のまま送られます。`
}

/**
 * 使用先を、消せなくする分と履歴だけの分に分ける。
 *
 * **送信済みの配信は消せない理由にならない。** もう送ったものなので、
 * これから変わることは無い。同じ一覧に混ぜると「なぜ消せないのか」が
 * 読めなくなる。
 */
export function splitItems(items: CommonVarDeleteImpactItem[]): {
  blocking: CommonVarDeleteImpactItem[]
  historical: CommonVarDeleteImpactItem[]
} {
  return {
    blocking: items.filter((item) => item.blocksDeletion),
    historical: items.filter((item) => !item.blocksDeletion),
  }
}

/** 見せられない使用先。**件数を隠さない。** 名前だけ出せないと言う。 */
export function unavailableText(impact: CommonVarDeleteImpact): string | null {
  if (!Array.isArray(impact.unavailableReferences)) return '一部の使用先を確認できませんでした。'
  if (impact.unavailableReferences.length === 0) return null
  return impact.unavailableReferences
    .map((ref) => validNonNegInt(ref.count)
      ? `${ref.kindLabel}${formatNumber(ref.count)} 件（${ref.reason}）`
      : `${ref.kindLabel}（件数を確認できません・${ref.reason}）`)
    .join('／')
}

/**
 * 消してよいか。
 *
 * **差し込みキーを打ってもらう。** 空欄のまま送られる場所がある操作を、
 * ボタン1つで通さない。取り消せないので、対象を取り違えたまま押せる形に
 * しない。
 */
export function canDelete(input: {
  impact: CommonVarDeleteImpact | null
  typedKey: string
  reason: string
  busy: boolean
}): boolean {
  const impact = input.impact
  if (!impact || input.busy) return false
  if (!impact.canDelete) return false
  if (!validNonNegInt(impact.total) || !validNonNegInt(impact.blockingTotal)) return false
  if (reasonRequirement.check(input.reason)) return false
  return typedKeyRequirement(impact).check(input.typedKey) === null
}

/** 押せない理由。**押せないボタンを黙って出さない。** */
export function blockedReason(input: {
  impact: CommonVarDeleteImpact | null
  typedKey: string
  reason: string
}): string | null {
  const impact = input.impact
  if (!impact) return '使用先をまだ読み込めていません。'
  if (!impact.canDelete) {
    if (!validNonNegInt(impact.blockingTotal) || impact.blockingTotal <= 0) {
      return '使用先があるため削除できません。使用先から外してから、もう一度お試しください。'
    }
    return `${formatNumber(impact.blockingTotal)}か所で使われているあいだは削除できません。`
      + '使用先から外してから、もう一度お試しください。'
  }
  if (!validNonNegInt(impact.total) || !validNonNegInt(impact.blockingTotal)) return '使用先件数を確認できないため削除できません。画面を読み直してからお試しください。'
  if (reasonRequirement.check(input.reason)) return '消した理由を入力してください。'
  const keyProblem = typedKeyRequirement(impact).check(input.typedKey)
  if (keyProblem) return keyProblem
  return null
}

/** 確かめた時刻。「いつ時点の話か」が無いと、消す判断ができない。 */
export function checkedAtText(checkedAt: string): string {
  if (typeof checkedAt !== 'string' || !checkedAt.trim()) return NOT_AVAILABLE
  const date = new Date(checkedAt)
  if (Number.isNaN(date.getTime())) return NOT_AVAILABLE
  return formatDateTime(date)
}
