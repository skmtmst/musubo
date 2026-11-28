'use client'

import { useState } from 'react'
import type { CommonVarDeleteImpact } from '@line-crm/shared'
import { Field } from '@/components/shared/form-controls'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { TextField } from '@/components/shared/text-field'
import type { FormRequirement } from '@/lib/form-requirement'
import { placeholderText, reasonRequirement, typedKeyRequirement } from './model'
import styles from './list.module.css'

function DeleteField({ label, value, onChange, placeholder, requirement, names, submitted }: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  requirement: FormRequirement
  names: string[]
  submitted?: boolean
}) {
  const [visited, setVisited] = useState(false)
  return <Field label={label} requirement={requirement} error={visited || submitted ? requirement.check(value) : undefined}>
    <SaveErrorField names={names}><TextField value={value} onChange={event => onChange(event.target.value)}
      onBlur={() => setVisited(true)} placeholder={placeholder} className={styles.dialogInput} /></SaveErrorField>
  </Field>
}

/** 消す条件は既存の定義のまま、欄の理由は操作後に示す。 */
export default function CommonVarDeleteFields({ impact, reason, typedKey, onReasonChange, onTypedKeyChange, error }: {
  impact: CommonVarDeleteImpact
  reason: string
  typedKey: string
  onReasonChange: (value: string) => void
  onTypedKeyChange: (value: string) => void
  error: string
}) {
  return <>
    <DeleteField label={impact.canDelete ? '消した理由（記録に残ります）' : '消した理由・止める理由（記録に残ります）'}
      value={reason} onChange={onReasonChange} placeholder="店舗情報の変更のため" requirement={reasonRequirement}
      names={['deleteReason', 'changeReason', 'reason', 'delete_reason']} submitted={Boolean(error)} />
    {impact.canDelete ? <DeleteField label="削除する場合は、差し込みキーを入力してください"
      value={typedKey} onChange={onTypedKeyChange} placeholder={placeholderText(impact.variable.varKey)}
      requirement={typedKeyRequirement(impact)} names={['typedKey', 'typed_key']} submitted={Boolean(error)} /> : null}
  </>
}
