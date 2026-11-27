'use client'

import { Field } from '@/components/shared/form-controls'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { TextField } from '@/components/shared/text-field'
import { requiredText } from '@/lib/form-requirement'
import styles from './edit.module.css'

export const formNameRequirement = requiredText('フォーム名を入力してください')

/** どの編集タブでも同じ名前・入力検証・保存先を使う。 */
export function FormNameField({ value, error, readOnly, onChange, onBlur }: {
  value: string
  error: string | null
  readOnly?: boolean
  onChange: (name: string) => void
  onBlur?: () => void
}) {
  const safeValue = typeof value === 'string' ? value : ''
  if (readOnly) return <dl>
    <div className={styles.field}>
      <dt className={styles.fieldLabel}>フォーム名</dt>
      <dd>{safeValue.trim() ? safeValue : '未設定'}</dd>
    </div>
  </dl>
  return <div className={styles.field}>
    <Field label="フォーム名" htmlFor="fe-name" requirement={formNameRequirement}>
      <SaveErrorField names={['name', 'props.name']}>
        <TextField id="fe-name" value={safeValue} readOnly={readOnly} invalid={Boolean(error)} onBlur={readOnly ? undefined : onBlur} onChange={event => { if (!readOnly) onChange(event.target.value) }} />
      </SaveErrorField>
      {error ? <p role="alert" className={styles.fieldError}>{error}</p> : null}
    </Field>
  </div>
}
