'use client'

import { formFileKinds,type FormInputBlock } from '@line-crm/shared'
import Checkbox from './checkbox'
import { Field } from './form-controls'
import { TextField } from './text-field'
export default function FormFileSettings({ block, onChange }: { block: FormInputBlock; onChange: (patch: Partial<FormInputBlock>) => void }) {
  const savedKinds = formFileKinds(block)
  const kinds = savedKinds.filter(kind => kind !== 'identity')
  return <>
    <Field label="受け取る種類（いくつでも）">
      {([{ kind: 'image', label: '写真（JPG・PNG・HEICなど）' }, { kind: 'pdf', label: 'PDF' }] as const).map(option =>
        <Checkbox key={option.kind} checked={kinds.includes(option.kind)} onCheckedChange={checked => onChange({ fileKinds: checked ? [...kinds, option.kind] : kinds.filter(kind => kind !== option.kind), fileBothSides: false })}>{option.label}</Checkbox>)}
    </Field>
    <Field label="枚数の上限" note="1〜10枚"><TextField aria-label="枚数の上限" type="number" min={1} max={10} value={block.fileMaxCount ?? 1} onChange={e => onChange({ fileMaxCount: Number(e.target.value) })} /></Field>
    {savedKinds.includes('identity') ? <p role="status" className="text-body">この質問では本人確認書類を受け取れません。受け取る種類を写真かPDFへ変更してください。</p> : null}
  </>
}
