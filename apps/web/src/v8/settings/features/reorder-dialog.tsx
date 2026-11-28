'use client'

import { useMemo, useState } from 'react'
import { Check, RotateCcw } from 'lucide-react'
import Button from '@/components/shared/button'
import Dialog from '@/components/shared/dialog'
import ReorderList from '@/components/shared/reorder-list'
import type { FeatureGroup, MenuItemOrder } from '@/lib/feature-settings'
import { applyItemOrder } from './feature-settings-view'
import styles from './screen.module.css'

function validItemOrder(order: MenuItemOrder): boolean {
  return Boolean(order && typeof order === 'object' && !Array.isArray(order)
    && Object.values(order).every((items) => Array.isArray(items) && items.every((id) => typeof id === 'string')))
}

/** 並び替えの窓（★V8-B ）。下書きの並びを動かし、確定で反映する。 */
export function ReorderDialog({ groups, initialOrder, onCancel, onApply }: {
  groups: FeatureGroup[]
  initialOrder: MenuItemOrder
  onCancel: () => void
  onApply: (order: MenuItemOrder) => void
  moveItemInOrder: (order: MenuItemOrder, groupId: string, itemId: string, direction: -1 | 1) => MenuItemOrder
}) {
  const [invalidInitial] = useState(() => !validItemOrder(initialOrder))
  const invalidOrder = invalidInitial || !validItemOrder(initialOrder)
  const [draft, setDraft] = useState<MenuItemOrder>(() => invalidOrder ? {} : initialOrder)
  const draftGroups = useMemo(() => applyItemOrder(groups, draft), [groups, draft])
  const [groupId, setGroupId] = useState(groups.find((group) => group.id === 'delivery')?.id ?? groups[0]?.id ?? '')
  const group = draftGroups.find((item) => item.id === groupId)
  return (
    <Dialog
      open
      designNode="ztgRD"
      designWidth={560}
      designTop={140}
      designHeaderPadding="24px 24px 0"
      designContentPadding="4px 24px 0"
      designFooterPadding="10px 24px 24px"
      footerDivider={false}
      footerLeadFlexible={false}
      confirmIcon={<Check size={16} aria-hidden="true" />}
      title="左のメニューの並びを変える"
      confirmLabel="この並びにする"
      error={invalidOrder ? '並び順を確認できません。画面を読み直してください。' : undefined}
      confirmDisabled={invalidOrder}
      footerLead={<Button variant="text" disabled={invalidOrder} onClick={() => setDraft(initialOrder)}><RotateCcw size={16} aria-hidden="true" />元の並びに</Button>}
      onCancel={onCancel}
      onConfirm={() => { if (!invalidOrder) onApply(draft) }}
    >
      <p className={styles.orderDescription}>つまみで動かすか、矢印で1つずつ動かします。区分（メイン・配信…）の中で並べ替えます。</p>
      {group ? <>
        <ReorderList group={{ label: "区分", ariaLabel: "並びを変更する区分を選択する", value: groupId, onChange: setGroupId, options: groups.map((item) => ({ value: item.id, label: item.label })) }} items={group.items} visibleRows={5} onChange={(ids) => setDraft((current) => ({ ...current, [group.id]: ids }))} />
      </> : null}
    </Dialog>
  )
}
