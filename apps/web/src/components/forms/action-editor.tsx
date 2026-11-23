"use client"
import { SaveErrorField } from '@/components/shared/save-form-errors'

import { Bell, FileText, MessageSquare, Tag, User, Workflow } from 'lucide-react'
import type { FormAction } from '@line-crm/shared'
import ActionList, { type ActionChoice } from '@/components/shared/action-list'
import { EntityPickerField } from '@/components/shared/entity-picker'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import Select from '@/components/shared/select'
import { TextField } from '@/components/shared/text-field'
import type { FormRefs } from './form-refs'

const KINDS = [
  { id: 'send_text', label: 'テキストを送る', icon: MessageSquare },
  { id: 'send_template', label: 'テンプレートを送る', icon: FileText },
  { id: 'tag', label: 'タグを付ける・外す', icon: Tag },
  { id: 'friend_field', label: '友だち情報に書く', icon: User },
  { id: 'scenario', label: 'シナリオを開始・停止', icon: Workflow },
  { id: 'reminder', label: 'リマインダを開始', icon: Bell },
] as const

export function emptyFormAction(kind: Exclude<FormAction['kind'], 'research_action'>): FormAction {
  switch (kind) {
    case 'send_text': return { kind, text: '' }
    case 'send_template': return { kind, templateId: '' }
    case 'tag': return { kind, op: 'add', tagIds: [] }
    case 'friend_field': return { kind, fieldId: '', value: '' }
    case 'scenario': return { kind, op: 'start', scenarioId: '' }
    case 'reminder': return { kind, reminderId: '' }
  }
}

function targets(kind: FormAction['kind'], refs: FormRefs) {
  switch (kind) {
    case 'send_template': return refs.templates.filter(t => t.type === 'text')
    case 'tag': return refs.tags
    case 'friend_field': return refs.friendFields.map(f => ({ ...f, disabled: f.ecIsMaster, meta: f.ecIsMaster ? 'EC側から更新する欄です' : undefined }))
    case 'scenario': return refs.scenarios
    case 'reminder': return refs.reminders
    default: return []
  }
}
function applyTarget(action: FormAction, ids: string[]): FormAction {
  switch (action.kind) {
    case 'send_template': return { ...action, templateId: ids[0] }
    case 'tag': return { ...action, tagIds: ids }
    case 'friend_field': return { ...action, fieldId: ids[0] }
    case 'scenario': return { ...action, scenarioId: ids[0] }
    case 'reminder': return { ...action, reminderId: ids[0] }
    default: return action
  }
}
export function formActionChoices(refs: FormRefs): ActionChoice<FormAction>[] {
  return KINDS.map(kind => ({ ...kind, make: () => emptyFormAction(kind.id), picker: kind.id === 'send_text' ? undefined : {
    title: `${kind.id === 'send_template' ? 'テンプレート' : kind.id === 'tag' ? 'タグ' : kind.id === 'friend_field' ? '友だち情報欄' : kind.id === 'scenario' ? 'シナリオ' : 'リマインダ'}を選ぶ`,
    items: targets(kind.id, refs), multiple: kind.id === 'tag', apply: applyTarget,
  } }))
}
/*
 * 行の題は、種類（ kindOf ）と並んで出る。種類の言葉を繰り返さず、
 * 行を見分ける中身（送る文・選んだ先）だけを出す。
 * 選んでいない（未選択）と、選んだ先が消えた・ここでは読めない（見つかりません）は分ける。
 */
export function formActionTitle(action: FormAction, refs: FormRefs): string {
  if (action.kind === 'research_action') return 'リサーチで設定した動作'
  if (action.kind === 'send_text') return action.text ? `「${action.text}」` : '（本文が未設定）'
  const ids = action.kind === 'tag' ? action.tagIds : [action.kind === 'send_template' ? action.templateId : action.kind === 'friend_field' ? action.fieldId : action.kind === 'scenario' ? action.scenarioId : action.reminderId]
  if (ids.length === 0 || ids.every((id) => !id)) return '（未選択）'
  const names = ids.map((id) => targets(action.kind, refs).find((item) => item.id === id)?.name)
  if (names.some((name) => name === undefined)) return '（見つかりません）'
  const joined = (names as string[]).join('・')
  switch (action.kind) {
    case 'tag': return `「${joined}」`
    case 'send_template': return `「${joined}」`
    case 'friend_field': return `「${joined}」に書く`
    case 'scenario': return `「${joined}」を${action.op === 'stop' ? '停止' : '開始'}`
    case 'reminder': return `「${joined}」`
  }
}
function formActionKind(action: FormAction): string {
  if (action.kind === 'tag') return action.op === 'remove' ? 'タグを外す' : 'タグを付ける'
  if (action.kind === 'friend_field') return '友だち情報を変える'
  return KINDS.find(kind => kind.id === action.kind)?.label ?? action.kind
}
export function FormActionConfig({ action, refs, onChange, index = 0 }: { index?: number; action: FormAction; refs: FormRefs; onChange: (next: FormAction) => void }) {
  if (action.kind === 'research_action') return <p className="text-body">変更はリサーチの編集から行ってください。</p>
  const label = KINDS.find(kind => kind.id === action.kind)!.label
  return <>
    {action.kind === 'send_text' ? <SaveErrorField names={[`value.${index}.text`,"text","action.text"]}><TextField aria-label="送る文面" value={action.text} onChange={event => onChange({ ...action, text: event.target.value })} /></SaveErrorField>
      : action.kind === 'tag' ? <EntityPickerField label="タグ" noun="タグ" items={targets(action.kind, refs)} multiple value={action.tagIds} onChange={ids => onChange(applyTarget(action, ids))} />
      : <EntityPickerField label={label} noun={label} items={targets(action.kind, refs)} value={action.kind === 'send_template' ? action.templateId : action.kind === 'friend_field' ? action.fieldId : action.kind === 'scenario' ? action.scenarioId : action.reminderId} onChange={id => onChange(applyTarget(action, [id]))} />}
    {action.kind === 'tag' ? <SaveErrorField names={[`value.${index}.op`,"op","action.op"]}><Select aria-label="タグの付け外し" value={action.op} onChange={op => onChange({ ...action, op: op as 'add' | 'remove' })} options={[{ value: 'add', label: '付ける' }, { value: 'remove', label: '外す' }]} /></SaveErrorField> : null}
    {action.kind === 'scenario' ? <SaveErrorField names={[`value.${index}.op`,"op","action.op"]}><Select aria-label="シナリオの操作" value={action.op} onChange={op => onChange({ ...action, op: op as 'start' | 'stop' })} options={[{ value: 'start', label: '開始する' }, { value: 'stop', label: '停止する' }]} /></SaveErrorField> : null}
    {action.kind === 'friend_field' ? <SaveErrorField names={[`value.${index}.value`,"value","action.value"]}><TextField aria-label="書き込む値" value={action.value} onChange={event => onChange({ ...action, value: event.target.value })} /></SaveErrorField> : null}
  </>
}
export default function ActionEditor({ value, onChange, refs, readOnly = false }: { value: FormAction[]; onChange: (next: FormAction[]) => void; refs: FormRefs; readOnly?: boolean }) {
  return <ActionList value={value} onChange={onChange} choices={formActionChoices(refs)} idOf={(_, index) => String(index)}
    titleOf={action => formActionTitle(action, refs)} kindOf={formActionKind}
    iconOf={action => KINDS.find(kind => kind.id === action.kind)?.icon} readOnly={readOnly}
    renderEditor={(action, update, index) => <FormActionConfig index={index} action={action} refs={refs} onChange={update} />} />
}
