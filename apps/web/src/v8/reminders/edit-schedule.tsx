'use client'

import { StageFrame } from './edit-model'

import { firstReminderStepMessage, reminderTriggerLabel } from '@/components/reminders/reminder-labels'
import { fillPreviewSample } from '@/components/shared/preview-sample'
import Button from '@/components/shared/button'
import { emptyValue } from '@/components/shared/empty-value'
import ListState from '@/components/shared/list-state'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import SegmentedControl from '@/components/shared/segmented'
import { CreatePage } from '@/components/templates'
import { useAccount } from '@/contexts/account-context'
import { formatNumber } from '@/lib/format'
import {
type ReminderDraftSettings,
type ReminderPreviewResult
} from '@line-crm/shared'
import {
ArrowRight,
Layers
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { countLabel,formatMd } from './edit-model'
import styles from './edit.module.css'
import { PhoneV8,SummaryCardV8,WizardFooterV8 } from './ui'
import Notice from '@/components/shared/notice'

/* ---------------- 手順4：配信予定 ---------------- */
export function ScheduleStageV8({
  frame,
  notice,
  reminderId,
  settings,
  preview,
  previewFailed = false,
  onRetryPreview,
  onNext,
  onSaveDraft,
  busy,
  onCancel,
}: {
  frame: StageFrame
  notice: ReactNode
  reminderId: string
  settings: ReminderDraftSettings
  preview: ReminderPreviewResult | null
  previewFailed?: boolean
  onRetryPreview?: () => void
  onNext: () => void
  onSaveDraft: () => void
  busy: boolean
  onCancel: () => void
}) {
  const { selectedAccount } = useAccount()
  const [range, setRange] = useState<'7d' | '30d' | 'conflict'>('7d')
  const items = preview?.items ?? []
  const now = Date.now()
  const rows = items.filter((item) => {
    if (range === 'conflict') return item.state === 'duplicate'
    const at = Date.parse(item.scheduledAt)
    return at > now && at <= now + (range === '7d' ? 7 : 30) * 86_400_000
  })
  const rangeCount = range === '7d' ? preview?.summary.next7Days ?? null : range === '30d' ? preview?.summary.next30Days ?? null : preview ? preview.summary.duplicateCount : null
  const nextItem = items.find((item) => item.state === 'scheduled') ?? null
  const messagesHref = `/reminders/edit?id=${encodeURIComponent(reminderId)}`
  const canProceed = !busy && settings.steps.length > 0
  const handleCancel = () => {
    if (busy) return
    return onCancel()
  }
  const handleSaveDraft = () => {
    if (busy) return
    return onSaveDraft()
  }
  const handleNext = () => {
    if (!canProceed) return
    return onNext()
  }
  const handleRetryPreview = onRetryPreview
    ? () => {
        if (busy) return
        return onRetryPreview()
      }
    : undefined

  return (
    <CreatePage
      {...frame}
      preview={(
        <>
          <SummaryCardV8
            rows={[
              { key: '基準日', value: reminderTriggerLabel(settings.triggerType) },
              { key: '対象者', value: preview ? countLabel(preview.summary.audience, '人') : emptyValue('unknown') },
              { key: '通知', value: `${settings.steps.length}通` },
              { key: '状態', value: '下書き' },
            ]}
          />
          <PhoneV8
            accountName={selectedAccount?.name ?? 'LINE公式アカウント'}
            chip={nextItem ? formatMd(nextItem.scheduledAt)
              : previewFailed ? '配信予定を読み込めませんでした'
                : preview ? '送信予定はまだありません' : '配信予定を確認しています'}
            empty={!nextItem}
            hasSampledBody={Boolean(nextItem && firstReminderStepMessage(settings, nextItem.stableStepId).trim())}
            message={nextItem ? fillPreviewSample(firstReminderStepMessage(settings, nextItem.stableStepId) || '本文はまだありません').text : undefined}
          />
        </>
      )}
      footerActions={(
        <WizardFooterV8
          onCancel={handleCancel}
          cancelDisabled={busy}
          onDraft={handleSaveDraft}
          draftBusy={busy}
          nextLabel="次へ：確認"
          nextIcon={<ArrowRight size={16} aria-hidden="true" />}
          onNext={handleNext}
          nextDisabled={!canProceed}
        />
      )} dirty={false}
    >
      {notice}
      <section className={styles.card} aria-labelledby="rm-schedule-title">
        <div className={styles.cardHead}>
          <h2 id="rm-schedule-title" className={styles.cardTitle}>これから送る予定</h2>
          <p className={styles.cardNote}>有効にしたら、この予定で送ります。予約が変わると予定も変わります。</p>
        </div>
        <div className={styles.rangeRow}>
          <SaveErrorField names={["range"]}><SegmentedControl
            aria-label="予定の範囲"
            options={[
              { value: '7d', label: '今後7日' },
              { value: '30d', label: '今後30日' },
              { value: 'conflict', label: '重なりだけ' },
            ]}
            value={range}
            onChange={setRange}
          /></SaveErrorField>
          <span className={styles.spacer} aria-hidden="true" />
          <span className={styles.rangeCount}>
            {range === 'conflict' ? `重なり ${countLabel(rangeCount, '件')}` : `${range === '7d' ? '今後7日' : '今後30日'} ${countLabel(rangeCount, '通')}`}
          </span>
        </div>
        {settings.steps.length === 0 ? (
          <ListState kind="empty" title="送る通知がまだありません" description="通知の中身（手順3）で本文を作成してから、配信予定を確認してください。" action={<Button href={messagesHref}>通知の中身へ</Button>} />
        ) : previewFailed ? (
          handleRetryPreview ? (
            <ListState
              kind="error"
              title="配信予定を確認できませんでした"
              description="通信または権限を確認して、もう一度お試しください。"
              onRetry={handleRetryPreview}
              retrying={busy}
            />
          ) : (
            <ListState
              kind="error"
              title="配信予定を確認できませんでした"
              description="通信または権限を確認し、ページを読み直してください。"
              action={<Button href={messagesHref}>通知の中身へ</Button>}
            />
          )
        ) : !preview ? (
          <ListState kind="loading" title="配信予定を確認しています" />
        ) : rows.length === 0 ? (
          <ListState kind="empty" title="条件に合う送信予定はありません" />
        ) : (
          <div className={styles.planTable} role="table" aria-label="これから送る予定">
            <div className={styles.planHead} role="row">
              <span role="columnheader" className={styles.colWhen}>送る日時</span>
              <span role="columnheader" className={styles.colWho}>友だち</span>
              <span role="columnheader" className={styles.colStep}>通知</span>
              <span role="columnheader" className={styles.colState}>状態</span>
            </div>
            {rows.map((item, index) => (
              <div key={`${item.stableStepId}-${index}`} role="row" className={styles.planRow} data-warn={item.state === 'duplicate' || undefined}>
                <span role="cell" className={styles.colWhen}>{formatMd(item.scheduledAt)}</span>
                <span role="cell" className={`${styles.colWho} ${styles.planWho}`} title={`対象になる人 全員（${countLabel(preview.summary.audience, '人')}）`}>
                  {`対象になる人 全員（${countLabel(preview.summary.audience, '人')}）`}
                </span>
                <span role="cell" className={styles.colStep}>{item.stepNumber} 通目</span>
                <span role="cell" className={styles.colState} data-tone={item.state === 'duplicate' ? 'warn' : undefined}>
                  {item.state === 'duplicate' ? '重なり→1通にまとめる' : item.state === 'past' ? '基準日が過去' : '送る予定'}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
      {preview && preview.summary.duplicateCount > 0 ? (
        <Notice tone="info" icon={<Layers size={16} aria-hidden="true" />}>
          同じ時刻に送る通知は、止めずに1通にまとめて送ります（
          {formatNumber(preview.summary.duplicateCount)}{" 件）。まとめたくないときは時刻をずらしてください。"}</Notice>
      ) : null}
    </CreatePage>
  )
}
