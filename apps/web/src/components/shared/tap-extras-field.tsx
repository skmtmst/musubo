'use client'
import { useId, useState, useEffect } from 'react'
import { Plus, X } from 'lucide-react'
import { hasTapExtras, tapExtrasError, type TapExtras } from '@line-crm/shared'
import Button from './button'
import TagPickerField, { type TagPickerOption } from './tag-picker-field'
import { TextField } from './text-field'
import { FieldError } from './form-controls'
import styles from './tap-extras-field.module.css'

/** l3NXyz：閉じた形→タグ・合計スコアの欄→選択済みの札。 */
export default function TapExtrasField({ name, value, onChange, accountId, tags, readOnly = false, unavailable, error: serverError, addButtonVariant = 'text', actionLabel }: {
  name: string; value?: TapExtras; onChange: (value: TapExtras) => void; accountId?: string | null
  tags?: readonly TagPickerOption[]; readOnly?: boolean; unavailable?: string; error?: string | null; addButtonVariant?: 'text' | 'secondary'; actionLabel?: string
}) {
  const fieldId = useId()
  const [expanded, setExpanded] = useState(hasTapExtras(value))
  useEffect(() => { if (hasTapExtras(value)) setExpanded(true) }, [value])
  const error = tapExtrasError(value) ?? serverError
  if (readOnly) return hasTapExtras(value) ? <div className={styles.root}><TagPickerField label={`${name}の付けるタグ`} value={value?.tagIds ?? []} options={tags} accountId={accountId} onChange={() => {}} readOnly />{value?.scoreChange ? <span className="text-body">スコア {value.scoreChange > 0 ? '+' : ''}{value.scoreChange}点</span> : null}</div> : null
  if (unavailable) return <div className={styles.root}><p className={styles.note}>{unavailable}</p>{hasTapExtras(value) ? <Button variant="text" onClick={() => onChange({ tagIds: [], scoreChange: null })}><X size={16} />追加処理を外す</Button> : null}</div>
  if (!expanded) return <Button variant={addButtonVariant} onClick={() => setExpanded(true)}><Plus size={16} />{actionLabel === undefined ? '押されたときにあわせて行うことを足す' : `${actionLabel}を足す`}</Button>
  return <div className={styles.root} role="group" aria-label={`${name}の${actionLabel ?? '押されたときにあわせて行うこと'}`}>
    <div className={styles.head}><span>{actionLabel ?? '押されたときに、あわせて行うこと'}</span><Button variant="text" size="compact" aria-label={`${name}の追加処理を外す`} onClick={() => { onChange({ tagIds: [], scoreChange: null }); setExpanded(false) }}><X size={16} />外す</Button></div>
    <div className={styles.row}><span className={styles.label}>タグを付ける</span><TagPickerField label={`${name}の付けるタグ`} value={value?.tagIds ?? []} options={tags} accountId={accountId} invalid={Boolean(error)} describedBy={error ? `${fieldId}-error` : undefined} onChange={tagIds => onChange({ ...value, tagIds })} /></div>
    <div className={styles.row}><label className={styles.label} htmlFor={`${fieldId}-tap-score`}>スコアを足す</label><TextField id={`${fieldId}-tap-score`} aria-label={`${name}の足すスコア`} type="number" step={1} value={value?.scoreChange ?? ''} invalid={Boolean(error)} aria-describedby={error ? `${fieldId}-error` : undefined} onChange={event => onChange({ ...value, scoreChange: event.target.value === '' ? null : Number(event.target.value) })} /><span className={styles.unit}>点</span></div>
    <FieldError id={`${fieldId}-error`}>{error}</FieldError>
  </div>
}
