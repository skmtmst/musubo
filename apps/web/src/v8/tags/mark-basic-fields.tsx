'use client'
import Card, { CardHeader } from '@/components/shared/card'
import FolderColorButton from '@/components/shared/folder-color-button'
import { markNameRequirement } from './mark-requirement'
import type { Ref } from 'react'
import { TextField } from '@/components/shared/text-field'
import { DuplicateNameNote } from '@/components/friend-fields/attribute-kind-guide'
import styles from './create.module.css'
import { Field } from '@/components/shared/form-controls'
import { SaveErrorField } from '@/components/shared/save-form-errors'

const COLORS = [
  { value: '#EF4B55', name: '赤' },
  { value: '#B86A00', name: 'オレンジ' },
  { value: '#06C755', name: '緑' },
  { value: '#2563D4', name: '青' },
  { value: '#6B56CF', name: '紫' },
  { value: '#707981', name: 'グレー' },
] as const

export default function MarkBasicFields({ name, color, onName, onColor, nameDuplicates = [], disabled = false, error, nameRef }: { name: string; color: string; onName: (name: string) => void; onColor: (color: string) => void; nameDuplicates?: string[]; disabled?: boolean; error?: string; nameRef?: Ref<HTMLInputElement> }) {
  const handleName = (next: string) => {
    if (disabled) return
    onName(next)
  }
  const handleColor = (next: string | null) => {
    if (disabled || !next) return
    onColor(next)
  }
  return (
            <Card variant="form" gap="normal" aria-labelledby="mark-basic">
              <CardHeader size="stacked" titleId="mark-basic" title="基本" />
              <Field requirement={markNameRequirement} error={error} label="マーク名"><SaveErrorField names={["name"]}><TextField ref={nameRef} aria-label="マーク名" invalid={Boolean(error)} disabled={disabled} value={name} onChange={(event) => handleName(event.target.value)} placeholder="例：要確認" /></SaveErrorField>
<DuplicateNameNote duplicates={nameDuplicates} kindLabel="対応マーク" /></Field>
              <div className={styles.colorField} role="group" aria-labelledby="mark-color">
                <span className={styles.labelStrong} id="mark-color">色</span>
                <FolderColorButton appearance="palette" label="マークの色" colors={COLORS} value={color} disabled={disabled} onChange={handleColor} />
                <p className={styles.keyNote}>赤・オレンジ・緑・青・紫・グレー（色と名前の両方で見分ける）</p>
              </div>
            </Card>
  )
}
