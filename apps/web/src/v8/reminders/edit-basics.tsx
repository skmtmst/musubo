'use client'

import { StageFrame } from './edit-model'

import ConfirmDialog from '@/components/shared/confirm-dialog'
import { CreatePage } from '@/components/templates'
import { type EventListItem } from '@/lib/api'
import {
type FriendField
} from '@line-crm/shared'
import {
ArrowRight
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useCallback,useState } from 'react'
import {
ReminderBasicsFormV8,
basicsBaseSummary,
reminderTemplatesV8,
type BasicsValue,
type ReminderTemplateV8
} from './basics-form'
import styles from './edit.module.css'
import { SummaryCardV8,WizardFooterV8 } from './ui'

/* ---------------- 手順1の直し（基本設定・競合 ） ---------------- */
export function BasicsStageV8({
  frame,
  notice,
  value,
  onChange,
  onTemplate,
  stepCount,
  busy,
  onSave,
  onSaveDraft,
  onCancel,
}: {
  frame: StageFrame
  notice: ReactNode
  value: BasicsValue
  onChange: (value: BasicsValue) => void
  onTemplate: (template: ReminderTemplateV8) => void
  stepCount: number
  busy: boolean
  onSave: (value: BasicsValue) => void
  onSaveDraft: (value: BasicsValue) => void
  onCancel: () => void
}) {
  const [appliedTemplateId, setAppliedTemplateId] = useState<string | null>(null)
  const [pendingTemplate, setPendingTemplate] = useState<ReminderTemplateV8 | null>(null)
  const [pendingFieldMatch, setPendingFieldMatch] = useState<string | null>(null)
  const [dateFields, setDateFields] = useState<FriendField[]>([])
  const [events, setEvents] = useState<EventListItem[]>([])
  const [fieldsState, setFieldsState] = useState<'loading' | 'ready' | 'error'>('ready')
  const [eventsState, setEventsState] = useState<'loading' | 'ready' | 'error'>('ready')

  const onFieldsReady = useCallback((fields: FriendField[], state: 'loading' | 'ready' | 'error') => {
    setDateFields(fields)
    setFieldsState(state)
  }, [])
  const onEventsReady = useCallback((items: EventListItem[], state: 'loading' | 'ready' | 'error') => {
    setEvents(items)
    setEventsState(state)
  }, [])

  const appliedTemplate = reminderTemplatesV8.find((template) => template.id === appliedTemplateId) ?? null

  function requestTemplate(template: ReminderTemplateV8) {
    if (busy) return
    const hasInputsToReplace =
      (appliedTemplateId !== null && appliedTemplateId !== template.id) ||
      value.triggerFieldId !== '' ||
      value.triggerEventId !== '' ||
      value.repeatYearly || stepCount > 0
    if (hasInputsToReplace) setPendingTemplate(template)
    else applyTemplate(template)
  }

  function applyTemplate(template: ReminderTemplateV8) {
    setAppliedTemplateId(template.id)
    onTemplate(template)
    onChange({
      ...value,
      triggerType: template.triggerType,
      repeatYearly: Boolean(template.repeatYearly),
      triggerFieldId: '',
      triggerEventId: '',
    })
    setPendingFieldMatch(template.triggerType === 'friend_field' ? template.fieldNameMatch ?? null : null)
  }

  function handleChange(next: BasicsValue) {
    if (appliedTemplate && appliedTemplate.triggerType !== next.triggerType) setAppliedTemplateId(null)
    if (next.triggerType !== 'friend_field') setPendingFieldMatch(null)
    onChange(next)
  }

  const candidatesPending =
    (value.triggerType === 'friend_field' && fieldsState !== 'ready') ||
    (value.triggerType === 'event' && eventsState !== 'ready')

  return (
    <CreatePage
      {...frame} previewLabel="設定内容を見る" previewTitle="設定内容"
      preview={(
        <>
          <SummaryCardV8
            rows={[
              { key: '基準日', value: basicsBaseSummary(value, dateFields, events) },
              { key: '対象者', value: '手順2で決める' },
              { key: '通知', value: stepCount > 0 ? `${stepCount} 通` : '手順3で作る' },
              { key: '状態', value: '下書き' },
            ]}
          />
          <p className={styles.sideHint}>LINEでの見え方は、届けるメッセージを決める手順から右に出ます。</p>
        </>
      )}
      footerActions={(
        <WizardFooterV8
          onCancel={onCancel}
          cancelDisabled={busy}
          onDraft={() => { if (!busy) onSaveDraft(value) }}
          draftBusy={busy}
          nextLabel="次へ：対象者と止める条件"
          nextIcon={<ArrowRight size={16} aria-hidden="true" />}
          onNext={() => { if (!candidatesPending && !busy && value.name.trim()) onSave(value) }}
          nextDisabled={candidatesPending || busy || !value.name.trim()}
        />
      )} dirty={false}
    >
      {notice}
      <ReminderBasicsFormV8
        value={value}
        onChange={handleChange}
        appliedTemplateId={appliedTemplateId}
        onRequestTemplate={requestTemplate}
        pendingFieldMatch={pendingFieldMatch}
        onFieldMatchHandled={() => setPendingFieldMatch(null)}
        onFieldsReady={onFieldsReady}
        onEventsReady={onEventsReady}
      />
      <ConfirmDialog
        open={pendingTemplate !== null}
        title="ひな形の内容で上書きしますか？"
        description="基準日・繰り返し・通知日時・本文をひな形の内容に置き換えます。いまの通知は残りません。"
        confirmLabel="このひな形を使う"
        busy={busy}
        onConfirm={() => {
          if (busy) return
          if (pendingTemplate) applyTemplate(pendingTemplate)
          setPendingTemplate(null)
        }}
        onCancel={() => { if (!busy) setPendingTemplate(null) }}
      />
    </CreatePage>
  )
}
