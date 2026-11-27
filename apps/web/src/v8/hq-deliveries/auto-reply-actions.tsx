'use client'

import { useRef, useState } from 'react'
import type { HqDeliveryTemplateDefinition } from '@line-crm/shared'
import { actionRowTitle } from '@/components/shared/action-rows'
import type { InlineAction } from '@/components/auto-replies/draft-fields'
import ActionList, { type ActionChoice } from '@/components/shared/action-list'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import Select from '@/components/shared/select'
import Card, { CardHeader } from '@/components/shared/card'
import HqActionResourcePicker from './action-resource-picker'
import { selectableAction, type HqActionResource, type HqSavedAction } from './auto-reply-actions-model'

type Operation = 'add' | 'remove' | 'start'
function editableAction(action: unknown): action is HqSavedAction {
  if (!selectableAction(action)) return false
  if (action.onFailure != null && action.onFailure !== 'stop' && action.onFailure !== 'continue') return false
  if (action.actionType === 'tag') {
    const config = action.config as Record<string, unknown>
    return config.op === 'add' || config.op === 'remove'
  }
  return true
}
export default function HqAutoReplyActions({ value, references, canEdit, busy, onChange }: {
  value: unknown; references: HqDeliveryTemplateDefinition['references']; canEdit: boolean; busy: boolean
  onChange: (actions: unknown[], resources: HqActionResource[]) => void
}) {
  const candidates = useRef(new Map<string, HqActionResource>())
  const [editing, setEditing] = useState<{ index: number; kind: 'tag' | 'scenario' } | null>(null)
  const actions = Array.isArray(value) ? value : value == null ? [] : null
  const change = (next: unknown[]) => { if (canEdit && !busy) onChange(next, [...candidates.current.values()]) }
  const targetOptions = { tags: (references ?? []).filter(ref => ref.kind === 'tag').map(ref => ({ id: ref.sourceId, name: ref.name })), scenarios: (references ?? []).filter(ref => ref.kind === 'scenario').map(ref => ({ id: ref.sourceId, name: ref.name })), fields: [], marks: [], vars: [] }
  const choice = (op: Operation, label: string): ActionChoice<unknown> => ({
    id: op, label, make: () => ({ actionType: op === 'start' ? 'scenario' : 'tag', config: { op: op === 'start' ? 'start' : op, ...(op === 'start' ? { restart: 'from_start' } : {}) }, onFailure: 'stop' }),
    picker: { title: op === 'start' ? 'シナリオを選ぶ' : 'タグを選ぶ', items: [],
      render: ({ onConfirm, onCancel }) => <HqActionResourcePicker kind={op === 'start' ? 'scenario' : 'tag'} onCancel={onCancel} onConfirm={item => { candidates.current.set(item.id, item); onConfirm([item.id]) }} />,
      apply: (raw, ids) => { const action = raw as HqSavedAction; return { ...action, config: { ...(action.config as object), ...(op === 'start' ? { scenarioId: ids[0] } : { tagIds: ids }) } } },
    },
  })
  return <Card variant="form" gap="normal"><CardHeader size="stacked" title="返信した後に行うこと" />
    {actions === null ? <Notice tone="warn">保存済みの後処理を確認できません。ほかの設定を保存しても、元の値は引き継がれます。</Notice> : <ActionList value={actions} onChange={change} choices={canEdit && !busy ? ([{ id: 'add', label: 'タグを付ける' }, { id: 'remove', label: 'タグを外す' }, { id: 'start', label: 'シナリオを始める' }] as const).map(item => choice(item.id, item.label)) : []}
      readOnly={!canEdit || busy} idOf={(_, index) => String(index)}
      titleOf={action => editableAction(action) ? actionRowTitle({ key: '', actionType: action.actionType, config: action.config, onFailure: action.onFailure === 'stop' ? 'stop' : 'continue' } as InlineAction, targetOptions) : '保存済みの後処理'}
      renderEditor={(action, update, index) => editableAction(action) ? <>
        <Button disabled={busy} onClick={() => setEditing({ index, kind: action.actionType === 'tag' ? 'tag' : 'scenario' })}>対象を選び直す</Button>
        <Select aria-label={`${index + 1}つ目の行うことに失敗したとき`} value={action.onFailure === 'stop' ? 'stop' : 'continue'} options={[{ value: 'stop', label: 'そこで止める' }, { value: 'continue', label: '次へ進む' }]} onChange={onFailure => update({ ...action, onFailure })} />
      </> : <Notice tone="info">この種類の設定はここでは変えられません。保存済みの内容を引き継ぎます。</Notice>} />}
    {editing && canEdit && !busy && actions ? <HqActionResourcePicker kind={editing.kind} onCancel={() => setEditing(null)} onConfirm={item => {
      const action = actions[editing.index]
      if (!editableAction(action)) return
      candidates.current.set(item.id, item)
      change(actions.map((entry, index) => index === editing.index ? { ...action, config: { ...(action.config as object), ...(editing.kind === 'tag' ? { tagIds: [item.id] } : { scenarioId: item.id }) } } : entry))
      setEditing(null)
    }} /> : null}
  </Card>
}
