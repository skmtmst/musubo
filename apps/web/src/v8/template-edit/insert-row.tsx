'use client'

/*
 * 本文の箱の下の「差し込む」の並び。
 * 名前は押すとすぐ入る。友だち情報・共通情報・配信日・その他は押すと選ぶ一覧が開く。
 * 差し込む文字（{{name}}・{{field.x}}・{{var.x}}・{{date…}}・{{days_until:…}}）は
 * 今の画面（TemplateInsertControls）と同じ。
 */
import { TEMPLATE_TEXT_MAX_CHARACTERS } from '@line-crm/shared'
import { useRef, useState, type RefObject } from 'react'
import Button from '@/components/shared/button'
import ActionMenu from '@/components/shared/action-menu'
import styles from './edit.module.css'
import Dialog from '@/components/shared/dialog'
import DateField from '@/components/shared/date-field'
import { useFeatureVisibility } from '@/lib/use-feature-visibility'
import { formatNumber } from '@/lib/format'
import type { TemplateReferenceState, TemplateReferences } from './core'
import MessageInsertRow, { MessageInsertButton } from '@/components/shared/message-insert-row'
import { SaveErrorField } from '@/components/shared/save-form-errors'

export const DATE_OPTIONS = [
  { value: '{{date}}', label: '月日と曜日（8月20日(木)）' },
  { value: '{{date:ymd_w}}', label: '年月日と曜日（2026年8月20日(木)）' },
  { value: '{{date:md}}', label: '月日（8月20日）' },
  { value: '{{date:ymd}}', label: '年月日（2026年8月20日）' },
  { value: '{{date:slash_md_w}}', label: '月日と曜日（8/20(木)）' },
  { value: '{{date:slash_ymd_w}}', label: '年月日と曜日（2026/8/20(木)）' },
  { value: '{{date:slash_md}}', label: '月日（8/20）' },
  { value: '{{date:slash_ymd}}', label: '年月日（2026/8/20）' },
]

export const OTHER_OPTIONS = [
  { value: '{{liff_id}}', label: 'LIFF ID' },
  { value: '{{date+1}}', label: '配信日の1日後' },
  { value: '{{date+3}}', label: '配信日の3日後' },
  { value: '{{date+7}}', label: '配信日の7日後' },
  { value: '{{date+14}}', label: '配信日の14日後' },
  { value: '{{date+30}}', label: '配信日の30日後' },
]

type MenuKey = 'field' | 'var' | 'date' | 'other'

function Chip({ label, onClick, disabled, title, buttonRef, expanded, more = false }: {
  label: string
  onClick: () => void
  disabled?: boolean
  title?: string
  buttonRef?: RefObject<HTMLButtonElement | null>
  expanded?: boolean
  more?: boolean
}) {
  return <MessageInsertButton kind={more ? 'other' : label === '名前' ? 'name' : label === '友だち情報' ? 'field' : label === '共通情報' ? 'var' : 'date'} ref={buttonRef} label={label} onClick={onClick} disabled={disabled} title={title ?? `${label}を差し込む`} expanded={expanded} />

}

export default function InsertRow({
  accountId,
  state,
  references,
  length,
  disabled = false,
  onInsert,
}: {
  accountId: string | null
  state: TemplateReferenceState
  references: TemplateReferences
  length: number
  disabled?: boolean
  onInsert: (token: string) => void
}) {
  const visibility = useFeatureVisibility(accountId)
  const fieldsEnabled = visibility.enabled('friend_fields')
  const varsEnabled = visibility.enabled('common_vars')
  const [menu, setMenu] = useState<MenuKey | null>(null)
  const [targetOpen, setTargetOpen] = useState(false)
  const [targetDate, setTargetDate] = useState('')
  const fieldRef = useRef<HTMLButtonElement>(null)
  const varRef = useRef<HTMLButtonElement>(null)
  const dateRef = useRef<HTMLButtonElement>(null)
  const otherRef = useRef<HTMLButtonElement>(null)
  const loadingWord = state === 'loading' ? '読み込み中です' : undefined
  const pick = (token: string) => {
    setMenu(null)
    onInsert(token)
  }
  const toggle = (key: MenuKey) => setMenu((current) => (current === key ? null : key))
  const fieldsReady = Boolean(accountId) && state === 'ready' && references.friendFields.length > 0
  const varsReady = Boolean(accountId) && state === 'ready' && references.commonVars.length > 0

  const nameChip = <Chip label="名前" disabled={disabled} onClick={() => onInsert('{{name}}')} />
  const fieldChip = fieldsEnabled ? (
    <Chip
      label="友だち情報"
      buttonRef={fieldRef}
      expanded={menu === 'field'}
      disabled={disabled || !fieldsReady}
      title={loadingWord ?? (fieldsReady ? '友だち情報を差し込む' : '差し込める友だち情報がありません')}
      onClick={() => toggle('field')}
    />
  ) : null
  const varChip = varsEnabled ? (
    <Chip
      label="共通情報"
      buttonRef={varRef}
      expanded={menu === 'var'}
      disabled={disabled || !varsReady}
      title={loadingWord ?? (varsReady ? '共通情報を差し込む' : '差し込める共通情報がありません')}
      onClick={() => toggle('var')}
    />
  ) : null
  const dateChip = <Chip label="配信日" buttonRef={dateRef} expanded={menu === 'date'} disabled={disabled} onClick={() => toggle('date')} />
  const otherChip = <Chip label="その他" more buttonRef={otherRef} expanded={menu === 'other'} disabled={disabled} title="その他の差し込みを選ぶ" onClick={() => toggle('other')} />

  return (
    <MessageInsertRow count={`${formatNumber(length)} / ${formatNumber(TEMPLATE_TEXT_MAX_CHARACTERS)}`} more={<>{varChip}{dateChip}{otherChip}</>}>
      {nameChip}{fieldChip}

      <ActionMenu
        open={menu === 'field'}
        anchorRef={fieldRef}
        ariaLabel="差し込む友だち情報"
        onClose={() => setMenu(null)}
        items={references.friendFields.map((field) => ({ id: field.fieldKey, label: field.name, onSelect: () => pick(`{{field.${field.fieldKey}}}`) }))}
      />
      <ActionMenu
        open={menu === 'var'}
        anchorRef={varRef}
        ariaLabel="差し込む共通情報"
        onClose={() => setMenu(null)}
        items={references.commonVars.map((item) => ({ id: item.varKey, label: item.name, onSelect: () => pick(`{{var.${item.varKey}}}`) }))}
      />
      <ActionMenu
        open={menu === 'date'}
        anchorRef={dateRef}
        ariaLabel="差し込む配信日の書き方"
        onClose={() => setMenu(null)}
        items={DATE_OPTIONS.map((option) => ({ id: option.value, label: option.label, onSelect: () => pick(option.value) }))}
      />
      <ActionMenu
        open={menu === 'other'}
        anchorRef={otherRef}
        ariaLabel="その他の差し込み"
        onClose={() => setMenu(null)}
        items={[
          ...OTHER_OPTIONS.map((option) => ({ id: option.value, label: option.label, onSelect: () => pick(option.value) })),
          { id: 'days-until', label: '目標日までの日数…', dividerBefore: true, onSelect: () => { setMenu(null); setTargetOpen(true) } },
        ]}
      />
      <Dialog
        open={targetOpen}
        title="目標日までの日数を差し込む"
        description="送る日から目標日までの日数に置き換わります（過ぎた日は0）。"
        confirmLabel="差し込む"
        busy={false}
        onConfirm={() => {
          if (!targetDate) return
          onInsert(`{{days_until:${targetDate}}}`)
          setTargetOpen(false)
        }}
        onCancel={() => setTargetOpen(false)}
      >
        <div className={styles.dateRow}>
          <SaveErrorField names={["targetDate","target_date"]}><DateField aria-label="日数を数える目標日" value={targetDate} onChange={setTargetDate} /></SaveErrorField>
        </div>
      </Dialog>
    </MessageInsertRow>
  )
}
