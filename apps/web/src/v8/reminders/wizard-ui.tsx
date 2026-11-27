'use client'

import { Steps } from '@/components/templates/steps'
import type { ReactNode } from 'react'
import Link from '@/components/shared/list-navigation'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { ChevronLeft } from 'lucide-react'
import type { StepperStep } from '@/components/shared/stepper'
import RadioCard from '@/components/shared/radio-card'
import LinePreview from '@/components/shared/line-preview'
import StickyBar from '@/components/shared/sticky-bar'
import { CreateSummaryCard } from '@/components/templates/create-parts'
import Button from '@/components/shared/button'
import styles from '../../app/reminders/wizard-v8.module.css'
import { PageHeading } from '@/components/templates/page-frame'

/*
 * ★V8 リマインダの作る・確かめる・詳細で共用する部品。
 * 板： /  /  /  /  /  /  / 。
 * V8 の表示の下だけで描く。管理画面 の reminder-管理画面-ui は触らない。
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

/** stage（URL の ?stage=）→ 手順の key。 */
export function stepKeyForStage(stage: string | null): ReminderV8StepKey {
  switch (stage) {
    case 'target':
      return 'target'
    case 'preview':
      return 'schedule'
    case 'test':
    case 'confirm':
      return 'confirm'
    case 'basics':
      return 'basics'
    default:
      // 段なしの /reminders/edit?id=X は通知の中身（手順3）。
      return 'messages'
  }
}

/** 手順の key → 戻る先の URL。reminderId が無い（手順1）ときは null。 */
function stepHref(step: ReminderV8StepKey, reminderId: string | null): string | null {
  if (!reminderId) return null
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

/**
 * 手順表示。済んだ段は押すとその手順へ戻れる。
 * 完了は current を外して全段 done にする。
 */
export function ReminderV8Stepper({
  current,
  reminderId,
}: {
  current: ReminderV8StepKey | 'done'
  reminderId: string | null
}) {
  const router = useRouter()
  const currentIndex = REMINDER_V8_STEPS.findIndex((step) => step.key === current)
  const steps: StepperStep[] = REMINDER_V8_STEPS.map((step, index) => {
    const done = current === 'done' || index < currentIndex
    const href = done ? stepHref(step.key, reminderId) : null
    return {
      key: step.key,
      label: step.label,
      state: done ? 'done' : index === currentIndex ? 'current' : 'todo',
      onSelect: href ? () => router.push(href) : undefined,
    }
  })
  return (
    <Steps
      label="リマインダを作る手順"
      steps={steps}
      currentKey={current === 'done' ? undefined : current}
    />
  )
}

/** ページの頭：戻るリンク・題名・手順・下の一行。 */
export function WizardHeadV8({
  title,
  note,
  current,
  reminderId,
}: {
  title: string
  note?: string
  current: ReminderV8StepKey | 'done'
  reminderId: string | null
}) {
  return (
    <>
      <Link href="/reminders" className={styles.backLink}>
        <ChevronLeft size={16} aria-hidden="true" />
        リマインダへ
      </Link>
      <div className={styles.headText}>
        <PageHeading title={title} />
        {note ? <p className={styles.headMeta}>{note}</p> : null}
      </div>
      <ReminderV8Stepper current={current} reminderId={reminderId} />
    </>
  )
}

/** 右欄の「設定内容」。共通部品 CreateSummaryCard に載せる（#1487）。 */
export function SummaryCardV8({
  title = '設定内容',
  rows,
}: {
  title?: string
  rows: Array<{ key: string; value: ReactNode; strong?: boolean; danger?: boolean }>
}) {
  return (
    <CreateSummaryCard
      title={title}
      rows={rows.map((row) => ({
        key: row.key,
        label: row.key,
        value: row.danger ? <span className={styles.kvValDanger}>{row.value}</span> : row.value,
      }))}
    />
  )
}

/**
 * 右欄のスマホ。LINE のトーク画面に近い形で届く見本を出す。
 * 枠・時計の帯・部屋名・下のメニューはここで持ち、吹き出しは本文だけ。
 */
export function PhoneMockV8({
  accountName,
  chip,
  message,
  empty,
}: {
  /** 部屋の名（LINE公式アカウントの表示名）。 */
  accountName: string
  /** 吹き出しの上の札。例「10/1（木）18:00」「通知は手順3で作ります」。 */
  chip?: string
  /** 届く本文。差し込みは見本値で置き換えてから渡す。 */
  message?: ReactNode
  /** 本文がまだ無いとき true。吹き出しを出さず札だけにする。 */
  empty?: boolean
}) {
  return (
    <LinePreview accountName={accountName} caption={chip} empty={empty}>
      {empty ? null : <div className={styles.phoneBubble}>{message ?? '本文はまだありません'}</div>}
    </LinePreview>
  )
}

/** 「LINEでの見え方」見出し＋スマホ。右欄に置く。 */
export function PhoneAsideV8(props: Parameters<typeof PhoneMockV8>[0]) {
  return <PhoneMockV8 {...props} />
}

/** 選択の操作は共通RadioCardに委ねる。印は呼び出し側の指定どおり出す（板どおりの印のため）。 */
export function ChoiceCardV8({ icon, ...props }: Parameters<typeof RadioCard>[0] & { icon?: ReactNode }) {
  return <RadioCard icon={icon} {...props} />
}

/** 下の操作帯。中央に「キャンセル → 下書き → 次へ・有効にする」。 */
export function WizardFooterV8({
  embedded = false,
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
  embedded?: boolean
  onCancel: () => void
  cancelDisabled?: boolean
  /** 真ん中のボタン。「下書きを保存」か「下書きのまま保存」。 */
  draftLabel?: string
  onDraft?: () => void
  draftBusy?: boolean
  nextLabel: string
  /** 主ボタンの左の印。例：→・⏻。 */
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
  const actions = (
        <>
          <Button type="button" onClick={handleCancel} disabled={cancelOff}>
            キャンセル
          </Button>
          {handleDraft ? (
            <Button
              type="button"
              variant="secondary"
              onClick={handleDraft}
              disabled={draftOff}
              busy={draftBusy}
              busyLabel="保存中…"
            >
              {draftLabel}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="primary"
            onClick={handleNext}
            disabled={nextOff}
            busy={nextBusy}
            busyLabel="処理中…"
          >
            {nextIcon}
            {nextLabel}
          </Button>
        </>
  )
  return embedded ? actions : <StickyBar actions={actions} />
}
