'use client'

import { Steps } from '@/components/templates/steps'
import type { ReactNode } from 'react'
import type { ReminderDraftSettings } from '@line-crm/shared'
import { reminderStepTimings, reminderStopSummary, reminderTriggerLabel } from '@/components/reminders/reminder-labels'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import type { StepperStep } from '@/components/shared/stepper'
import RadioCard from '@/components/shared/radio-card'
import LinePreview from '@/components/shared/line-preview'
import Button from '@/components/shared/button'
import { CreateSummaryCard } from '@/components/templates/create-parts'
import styles from './edit.module.css'

/*
 * ★V8 リマインダの作る・確かめる・詳細で使う小さな部品（src/v8 の決まりで、
 * 古い v8/reminders/wizard-v8-ui.tsx を写して書き直した）。
 * 板： /  /  /  /  /  / 。
 */

/** V8 の作る手順。URL 段（stage）と手順番号の対応はここだけで持つ。 */
export const REMINDER_V8_STEPS = [
  { key: 'basics', label: '基本設定' },
  { key: 'target', label: '対象者と止める条件' },
  { key: 'messages', label: '通知の中身' },
  { key: 'schedule', label: '配信予定' },
  { key: 'confirm', label: '確認' },
] as const

export type ReminderV8StepKey = (typeof REMINDER_V8_STEPS)[number]['key']

/** 手順の key → 戻る先の URL。今の画面と同じ ?stage= の名前を使う。 */
export function stepHref(step: ReminderV8StepKey, reminderId: string): string {
  const id = encodeURIComponent(reminderId)
  switch (step) {
    case 'basics':
      return `/reminders/edit?id=${id}&stage=basics`
    case 'target':
      return `/reminders/edit?id=${id}&stage=target`
    case 'messages':
      return `/reminders/edit?id=${id}`
    case 'schedule':
      return `/reminders/edit?id=${id}&stage=preview`
    case 'confirm':
      return `/reminders/edit?id=${id}&stage=confirm`
  }
}

/** 手順表示。済んだ段は押すとその手順へ戻れる。完了は全段 done にする。 */
export function ReminderV8Stepper({ current, reminderId, settings, readOnly }: { current: ReminderV8StepKey | 'done'; reminderId: string; settings?: ReminderDraftSettings; readOnly?: boolean }) {
  const router = useRouter()
  const currentIndex = REMINDER_V8_STEPS.findIndex((step) => step.key === current)
  const steps: StepperStep[] = REMINDER_V8_STEPS.map((step, index) => {
    const done = current === 'done' || index < currentIndex
    return {
      key: step.key,
      label: step.label,
      state: done ? 'done' : index === currentIndex ? 'current' : 'todo',
      onSelect: done ? () => router.push(stepHref(step.key, reminderId)) : undefined,
    }
  })
  return <Steps label="リマインダを作る手順" steps={steps} currentKey={current === 'done' ? undefined : current} readOnly={readOnly}
    summaries={settings ? { basics: `${settings.name}・${reminderTriggerLabel(settings.triggerType)}`, target: `${settings.targetCondition ? '条件で絞る' : settings.targetTagId ? 'タグで絞る' : '対象者全員'}・${reminderStopSummary(settings.stopConditions)}`, messages: `${settings.steps.length}通`, schedule: reminderStepTimings(settings) } : undefined} />
}

/** 頭の「← リマインダへ」。 */
export function BackToReminders() {
  return null
}

/** 右の列の「設定内容」。共通部品 CreateSummaryCard に載せる。 */
export function SummaryCardV8({
  title = '設定内容',
  rows,
}: {
  title?: string
  rows: Array<{ key: string; value: ReactNode; danger?: boolean }>
}) {
  return (
    <CreateSummaryCard
      title={title}
      rows={rows.map((row) => ({
        key: row.key,
        label: row.key,
        value: row.danger ? <span className={styles.valueDanger}>{row.value}</span> : row.value,
      }))}
    />
  )
}

/** 右の列のスマホ。吹き出しは本文だけ。 */
export function PhoneV8({
  accountName,
  chip,
  message,
  hasSampledBody = false,
  empty,
}: {
  accountName: string
  /** 吹き出しの上の札（届く日時など）。 */
  chip?: string
  message?: ReactNode
  /** 本文に差し込み値の見本を表示しているときだけ説明を出す。 */
  hasSampledBody?: boolean
  /** 本文がまだ無いとき true。札だけにする。 */
  empty?: boolean
}) {
  return <>
    <LinePreview
      accountName={accountName}
      caption={chip}
      empty={empty}
      note={!empty && hasSampledBody ? '名前や日時は見本の値です。' : undefined}
    >
      {empty ? null : <div className={styles.phoneBubble}>{message ?? '本文はまだありません'}</div>}
    </LinePreview>
  </>
}

/** 選ぶカードは共通 RadioCard（本物の radio・カード全体が押せる）。 */
export function ChoiceCardV8(props: Parameters<typeof RadioCard>[0]) {
  return <RadioCard {...props} />
}

/** 下の帯の操作。「キャンセル → 下書き → 次へ・有効にする」。帯そのものは CreatePage が持つ。 */
export function WizardFooterV8({
  onCancel,
  cancelDisabled = false,
  draftLabel = '下書きを保存',
  onDraft,
  draftBusy = false,
  nextLabel,
  nextIcon,
  onNext,
  nextDisabled = false,
  nextBusy = false,
}: {
  onCancel: () => void
  cancelDisabled?: boolean
  draftLabel?: string
  onDraft?: () => void
  draftBusy?: boolean
  nextLabel: string
  nextIcon?: ReactNode
  onNext: () => void
  nextDisabled?: boolean
  nextBusy?: boolean
}) {
  const anyBusy = draftBusy || nextBusy
  const cancelOff = cancelDisabled || anyBusy
  const draftOff = draftBusy || nextBusy
  const nextOff = nextDisabled || anyBusy
  const handleCancel = () => {
    if (cancelOff) return
    return onCancel()
  }
  const handleDraft = onDraft
    ? () => {
        if (draftOff) return
        return onDraft()
      }
    : undefined
  const handleNext = () => {
    if (nextOff) return
    return onNext()
  }
  return (
    <>
      <Button type="button" onClick={handleCancel} disabled={cancelOff}>
        キャンセル
      </Button>
      {handleDraft ? (
        <Button type="button" variant="secondary" onClick={handleDraft} disabled={draftOff} busy={draftBusy} busyLabel="保存中…">
          {draftLabel}
        </Button>
      ) : null}
      <Button type="button" variant="primary" onClick={handleNext} disabled={nextOff} busy={nextBusy} busyLabel="処理中…">
        {nextLabel}
        {nextIcon}
      </Button>
    </>
  )
}
