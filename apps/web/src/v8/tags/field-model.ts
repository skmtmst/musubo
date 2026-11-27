/*
 * 友だち情報欄の作る・編集で使う、画面の外の決まり（src/v8 は古い画面ファイルを import できないので写した）。
 * - storedDefaultLabels / sameLabels：app/tags/fields/default-labels.ts（R182）
 * - isSameFieldContent：app/tags/fields/edit/field-edit-conflict.ts（R517）
 */
import type { FriendField } from '@line-crm/shared'

/*
 * R182: 保存済みの既定値はID（複数選択はIDの配列のJSON）で入っている。
 * 画面は選択肢名で持つため、読み込み時と同じ戻し方で「保存済みの
 * 選択肢名」を作り、未保存の判定に使う。IDのまま比べると、単一選択は
 * 開いた瞬間に未保存扱いになり、複数選択は変えても未保存にならない。
 */
export function storedDefaultLabels(field: FriendField): { single: string; multi: string[] } {
  const stored = field.defaultValue ?? ''
  const labels = field.options ?? []
  const definitions = field.optionDefinitions ?? null
  const toLabel = (entry: string): string | null =>
    definitions?.find((item) => item.id === entry)?.label
    ?? (labels.includes(entry) ? entry : null)
  if (field.type === 'multi_select') {
    let entries: string[] = []
    try {
      const parsed: unknown = JSON.parse(stored)
      if (Array.isArray(parsed)) entries = parsed.map(String)
    } catch { entries = [] }
    return { single: '', multi: entries.map(toLabel).filter((item): item is string => item !== null) }
  }
  if (field.type === 'select' && stored) return { single: toLabel(stored) ?? '', multi: [] }
  return { single: stored, multi: [] }
}

export function sameLabels(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  return sortedA.every((item, index) => item === sortedB[index])
}

/** 保存のために送った内容（画面の入力を送信用に整えた形）。 */
export interface SentFieldContent {
  name: string
  folderId: string | null
  options: string[] | null
  defaultValue: string | string[] | null
  isPersonal: boolean
  isStarred: boolean
  ecIsMaster: boolean
  ecFieldPath: string | null
}

/**
 * R517: 送った内容と最新の保存内容が同じか。
 *
 * 同じなら、応答を失った1回目の保存が成功している（再試行の409は
 * 自分の保存との衝突）。違うなら、ほかの担当者が変えている。
 * 選択式の既定値は送るときは選択肢名、保存されるときは選択肢IDなので、
 * 最新の対応表でIDへ戻してから比べる。比べられない形のときは
 * 「違う」に倒す（保存済みと言い切らない）。
 */
export function isSameFieldContent(sent: SentFieldContent, latest: FriendField): boolean {
  if ((latest.options !== null && (!Array.isArray(latest.options) || !latest.options.every((option) => typeof option === 'string')))
    || (latest.defaultValue !== null && typeof latest.defaultValue !== 'string')) {
    throw new Error('最新の情報欄を確認できませんでした。')
  }
  if (sent.name !== latest.name) return false
  if ((sent.folderId ?? null) !== (latest.folderId ?? null)) return false
  if (JSON.stringify(sent.options ?? null) !== JSON.stringify(latest.options ?? null)) return false
  if (sent.isPersonal !== latest.isPersonal) return false
  if (sent.isStarred !== latest.isStarred) return false
  if (sent.ecIsMaster !== latest.ecIsMaster) return false
  if ((sent.ecFieldPath ?? null) !== (latest.ecFieldPath ?? null)) return false
  return normalizeSentDefault(sent, latest) === (latest.defaultValue ?? null)
}

function normalizeSentDefault(sent: SentFieldContent, latest: FriendField): string | null {
  const raw = sent.defaultValue
  if (raw === null || raw === undefined) return null
  if (Array.isArray(raw)) {
    if (raw.length === 0) return null
    const definitions = latest.optionDefinitions ?? null
    const ids = raw.map((label) => definitions?.find((item) => item.label === label)?.id ?? label)
    return JSON.stringify(ids)
  }
  if (!raw) return null
  if (latest.type === 'select') {
    return latest.optionDefinitions?.find((item) => item.label === raw)?.id ?? raw
  }
  return raw
}

/** 項目名から差し込み名の候補を作る（英字で始まる小文字・数字・_、32字まで）。 */
export function suggestKey(name: string): string {
  const ascii = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (!ascii || !/^[a-z]/.test(ascii)) return ''
  return ascii.slice(0, 32)
}
