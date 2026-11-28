import { knownValue } from '@/lib/known-value'
/*
 * ★V8 保存した検索の編集で使う小さな計算（画面から切り出して試験で確かめる）。
 */
import type { SavedSearch } from '@line-crm/shared'

export type ReferenceOption = { value: string; label: string }

/**
 * 保存済みの参照先が一覧から取れなくても、現在値を勝手に消さない。
 * ID そのものは画面へ出さず、「選択済み」とだけ伝えて選び直せるようにする。
 * （今の画面 app/tags/searches/edit/reference-options.ts の写し。src/v8 からは @/app を読めないため）
 */
export function optionsWithCurrent(options: ReferenceOption[], currentValue: string, currentLabel: string, emptyLabel: string): ReferenceOption[] {
  const rows: ReferenceOption[] = [{ value: '', label: emptyLabel }, ...options]
  if (currentValue && !options.some((option) => option.value === currentValue)) rows.splice(1, 0, { value: currentValue, label: currentLabel })
  return rows
}

type Usage = NonNullable<SavedSearch['usedIn']>[number]

const KIND_LABELS: Record<Usage['kind'], string> = {
  broadcast: '一斉配信',
  automation: '自動処理',
  scenario: 'シナリオ',
  other: 'そのほか',
}

/**
 * 右の列「使っている所」の行。一斉配信・自動処理は常に出し、シナリオ・そのほかは使っているときだけ。
 * 固定で使っている所は名前の後ろに「（固定）」。使っている所を取れていないときは「なし」と言い切らず「—」。
 */
export function usageRowsOf(usedIn: SavedSearch['usedIn']): Array<{ label: string; value: string }> {
  const kinds: Array<Usage['kind']> = ['broadcast', 'automation', 'scenario', 'other']
  return kinds
    .filter((kind) => kind === 'broadcast' || kind === 'automation' || (usedIn ?? []).some((usage) => usage.kind === kind))
    .map((kind) => {
      if (usedIn === undefined) return { label: KIND_LABELS[kind], value: '—' }
      const names = usedIn.filter((usage) => usage.kind === kind).map((usage) => `${usage.name}${usage.mode === 'live' ? '' : usage.mode === 'fixed' ? '（固定）' : '（固定か確認できません）'}`)
      return { label: KIND_LABELS[kind], value: names.length ? names.join('・') : 'なし' }
    })
}

/** 頭の説明の最後：「一斉配信「秋の案内」で使っている」。 */
export function headUsageText(usedIn: SavedSearch['usedIn']): string {
  if (usedIn === undefined) return '使っている所は確かめられません'
  if (usedIn.length === 0) return '使っている所はありません'
  const first = usedIn[0]!
  return `${knownValue(KIND_LABELS, first.kind, '種類を確認できません')}「${first.name}」で使っている${usedIn.length > 1 ? `（ほか${usedIn.length - 1} 件）` : ''}`
}
