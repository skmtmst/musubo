'use client'

import Toggle from './toggle'
import HelpTip from './help-tip'

/** 未取得・マスク済みの表示値だけでは一致と断定しない。 */
export function sameKnownValues(values: readonly (string | null | undefined)[]): boolean {
  const first = values[0]
  return values.length > 1 && first != null && !/[＊*•●]/u.test(first)
    && values.every((value) => value === first)
}

export default function DifferencesFilter({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return <div className="flex items-center gap-2">
    <label className="flex items-center gap-2">
      <Toggle label="違う項目だけ" checked={checked} onChange={onChange} />
      <span className="text-caption">違う項目だけ</span>
    </label>
    <HelpTip label="違う項目だけの説明">オフにすると一致した項目も確認できます。未取得・マスク済みの値は省略しません。表示を切り替えても選んだ値と保存対象は変わりません。</HelpTip>
  </div>
}

/** 同じ名前と出所でも、どちらの記録を選ぶか区別できる表示名にする。 */
export function comparisonSourceLabels(sources: readonly { id: string; name: string; source?: string | null }[]): Record<string, string> {
  const names = sources.map((item) => [item.source, item.name].filter(Boolean).join('・') || '名前は未取得')
  return Object.fromEntries(sources.map((item, index) => [item.id,
    names.filter((name) => name === names[index]).length > 1 ? `${names[index]}（${index + 1}件目）` : names[index],
  ]))
}
