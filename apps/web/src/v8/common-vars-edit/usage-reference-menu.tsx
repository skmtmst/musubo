'use client'

import type { CommonVarDeleteImpactItem } from '@line-crm/shared'
import type { ActionMenuItem } from '@/components/shared/action-menu'
import { RowMenu } from '@/components/shared/row-actions'

/** 使用先の参照方法は行末の共通メニューから変更する。 */
export function UsageReferenceMenu({ usage, version, pinDisabledReason, canPin, valueChanged, busy, onChoose }: {
  usage: CommonVarDeleteImpactItem
  version: number
  pinDisabledReason?: string | null
  canPin: boolean
  valueChanged: boolean
  busy: boolean
  onChoose: (mode: 'pin' | 'live') => void
}) {
  const scenarioParams = new URL(usage.href, 'https://example.invalid').searchParams
  const scenarioDraft = usage.kind === 'scenario' && (scenarioParams.has('step') || scenarioParams.has('action'))
  const supported = usage.kind === 'broadcast' || usage.kind === 'form' || scenarioDraft
  const unavailableReason = !canPin ? 'この使用先を編集する権限がありません'
    : !supported ? 'この使用先では固定できません'
      : usage.kind === 'broadcast' && (usage.status.includes('送信済み') || usage.status.includes('完了済み')) ? '送信済み・完了済みの配信は変更できません'
        : usage.kind === 'broadcast' && usage.status !== '下書き' ? '下書きの一斉配信だけ変更できます'
          : busy ? '処理中です' : undefined
  const fixed = usage.referenceMode === 'pinned'
  const items: ActionMenuItem[] = []
  if (fixed) {
    items.push({ id: 'live', label: '最新の値に戻す', icon: null,
      lockedReason: unavailableReason,
      onSelect: () => onChoose('live') })
  }
  if (!fixed || usage.referencedVersion !== version || unavailableReason || pinDisabledReason) {
    const googleReason = fixed && pinDisabledReason ? `${pinDisabledReason} 固定済みの場合は送らず要確認になります` : pinDisabledReason
    const reason = unavailableReason ?? googleReason ?? (valueChanged ? '変更を保存してから固定してください' : undefined)
    items.push({ id: 'pin', label: `版 ${version} で固定`, icon: null,
      lockedReason: reason ?? undefined,
      onSelect: () => onChoose('pin') })
  }
  return <RowMenu label={`${usage.name}の操作`} size="row" items={items} showGroupHeadings={false} />
}
