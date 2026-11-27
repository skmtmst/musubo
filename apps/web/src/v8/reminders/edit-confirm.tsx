'use client'

import { StageFrame } from './edit-model'

import { reminderPlaceholders, reminderStepTimings, reminderStopSummary, reminderTriggerLabel } from '@/components/reminders/reminder-labels'
import { fillPreviewSample } from '@/components/shared/preview-sample'
import { TestRecipientGuidance,testRecipientDestinationLabel,testRecipientNote } from '@/components/reminders/test-recipient-guidance'
import { useReminderTestRecipient } from '@/components/reminders/use-reminder-test-recipient'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import { pruneCondition,type SegmentCondition } from '@/components/shared/condition-builder'
import { emptyValue } from '@/components/shared/empty-value'
import ListState from '@/components/shared/list-state'
import { CreatePage } from '@/components/templates'
import { CreateCompletionHeading } from '@/components/templates/create-parts'
import { PageFrame,PageHeading } from '@/components/templates/page-frame'
import { useAccount } from '@/contexts/account-context'
import { api } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import {
describeReminderTiming,
type ReminderDraftSettings,
type ReminderDraftVersion,
type ReminderPreviewResult,
type ReminderPublishResult,
type ReminderValidationResult
} from '@line-crm/shared'
import {
ArrowRight,
CalendarClock,
Check,
CheckCircle2,
CircleAlert,
List,
Power,
Send
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect,useState } from 'react'
import { countLabel,formatMd } from './edit-model'
import styles from './edit.module.css'
import { PhoneV8,SummaryCardV8,WizardFooterV8 } from './ui'

/* ---------------- 手順5：確認＝ 設定の確認・テスト送信・有効にする前の確認 ---------------- */
export function editHref(reminderId: string, stage: 'basics' | 'target' | 'preview' | null): string {
  return `/reminders/edit?id=${encodeURIComponent(reminderId)}${stage ? `&stage=${stage}` : ''}`
}

export function ConfirmStageV8({
  frame,
  notice,
  reminderId,
  draft,
  settings,
  validation,
  validationFailed = false,
  onRetryValidation,
  preview,
  previewFailed = false,
  recipientView,
  onRecipientRecheck,
  sentName,
  sentKind,
  sendBusy,
  onSend,
  busy,
  publishReady,
  onPublish,
  onSaveDraft,
  onCancel,
}: {
  frame: StageFrame
  notice: ReactNode
  reminderId: string
  draft: ReminderDraftVersion
  settings: ReminderDraftSettings
  validation: ReminderValidationResult | null
  validationFailed?: boolean
  onRetryValidation?: () => void
  preview: ReminderPreviewResult | null
  previewFailed?: boolean
  recipientView: ReturnType<typeof useReminderTestRecipient>['view']
  onRecipientRecheck: () => void
  sentName: string | null
  sentKind: 'self' | 'registered' | null
  sendBusy: boolean
  onSend: () => void
  busy: boolean
  publishReady: boolean
  onPublish: () => void
  onSaveDraft: () => void
  onCancel: () => void
}) {
  const { selectedAccount } = useAccount()
  const [folderName, setFolderName] = useState<string>('')

  // フォルダ名の解決だけ。一覧は確認の段でしか要らない。
  useEffect(() => {
    if (!settings.folderId) {
      setFolderName('')
      return
    }
    let active = true
    void api.folders.list('reminder').then((res) => {
      if (!active) return
      if (res.success) setFolderName(res.data.find((folder) => folder.id === settings.folderId)?.name ?? '')
    }).catch(() => undefined)
    return () => { active = false }
  }, [settings.folderId])

  const destination = testRecipientDestinationLabel(recipientView, sentName, sentKind)
  const placeholderSummary = reminderPlaceholders(settings, sentName ?? (recipientView.kind === 'ready' ? recipientView.recipient.displayName : null))
    .map((placeholder) => `${placeholder.token}：テストで使う値＝${placeholder.testValue}／本番での取得元＝${placeholder.source}`)
    .join('\n')
  const firstStep = settings.steps[0] ?? null
  const testedLabel = draft.lastTestStatus === 'succeeded' && draft.lastTestedAt
    ? `前回：${formatMd(draft.lastTestedAt)} に送れました（1通目）`
    : null

  const checkStageFor = (key: string): 'basics' | 'target' | 'preview' | null => {
    if (key === 'steps' || key === 'messages' || key === 'duplicate_schedule') return null
    if (key === 'stop_conditions') return 'target'
    return 'basics'
  }

  const confirmRows: Array<{ key: string; value: string; stage: 'basics' | 'target' | 'preview' | null }> = [
    { key: '名前・フォルダ', value: `${settings.name}${folderName ? `・${folderName}` : ''}`, stage: 'basics' },
    { key: '基準日', value: reminderTriggerLabel(settings.triggerType), stage: 'basics' },
    {
      key: '対象者',
      value: `${pruneCondition(settings.targetCondition as SegmentCondition | null) ? '条件に合う人だけ' : '基準日がある人すべて'}${validation?.audience.matched != null ? `（${formatNumber(validation.audience.matched)} 人に送る予定）` : ''}`,
      stage: 'target',
    },
    { key: '止める条件', value: reminderStopSummary(settings.stopConditions), stage: 'target' },
    { key: '通知', value: reminderStepTimings(settings), stage: null },
    {
      key: '配信予定',
      value: preview
        ? `今後7日 ${countLabel(preview.summary.next7Days, '通')}${preview.summary.duplicateCount > 0 ? `（重なり ${formatNumber(preview.summary.duplicateCount)} 件はまとめる）` : ''}`
        : previewFailed ? '読み込めませんでした' : '確認中',
      stage: 'preview',
    },
  ]

  return (
    <CreatePage
      {...frame}
      preview={(
        <>
          <SummaryCardV8
            rows={[
              { key: '基準日', value: reminderTriggerLabel(settings.triggerType) },
              { key: '対象者', value: validation?.audience.matched != null ? `${formatNumber(validation.audience.matched)}人` : emptyValue('unknown') },
              { key: '通知', value: `${settings.steps.length}通` },
              { key: '状態', value: '下書き → 有効にする' },
            ]}
          />
          <PhoneV8
            accountName={selectedAccount?.name ?? 'LINE公式アカウント'}
            chip={firstStep ? `1通目は ${describeReminderTiming(firstStep, settings.deliveryMode)}に届きます` : '通知ステップがありません'}
            empty={!firstStep}
            hasSampledBody={Boolean(firstStep?.messageContent.trim())}
            message={firstStep ? fillPreviewSample(firstStep.messageContent || '本文はまだありません').text : undefined}
          />
        </>
      )}
      footerActions={(
        <WizardFooterV8
          onCancel={onCancel}
          cancelDisabled={busy}
          draftLabel="下書きのまま保存"
          onDraft={onSaveDraft}
          draftBusy={busy}
          nextLabel="有効にする"
          nextIcon={<Power size={16} aria-hidden="true" />}
          onNext={onPublish}
          nextDisabled={busy || !publishReady}
          nextBusy={busy}
        />
      )} dirty={false}
    >
      {notice}
      <section className={styles.card} aria-labelledby="rm-confirm-title">
        <div className={styles.cardHead}>
          <h2 id="rm-confirm-title" className={styles.cardTitle}>設定の確認</h2>
        </div>
        <div className={styles.confirmRows}>
          {confirmRows.map((row) => (
            <div key={row.key} className={styles.confirmRow}>
              <span className={styles.confirmKey}>{row.key}</span>
              <span className={styles.confirmVal} title={row.key === '通知' && validation?.audience.matched != null
                ? `${row.value}（対象者×通知数：${countLabel(validation.audience.matched * settings.steps.length, '通')}）`
                : row.value}>{row.value}</span>
              <Button variant="text" href={editHref(reminderId, row.stage)}>変更する</Button>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.card} aria-labelledby="rm-test-title">
        <div className={styles.cardHead}>
          <h2 id="rm-test-title" className={styles.cardTitle}>テストを送る</h2>
          <p className={styles.cardNote}>{testRecipientNote(recipientView, sentKind)}</p>
        </div>
        <div className={styles.testRow}>
          <span className={styles.testDestination} aria-label="送り先" title={placeholderSummary || undefined}>送り先：{destination}</span>
          <Button variant="secondary" onClick={onSend} disabled={sendBusy || recipientView.kind !== 'ready'} busy={sendBusy} busyLabel="送信中…">
            <Send size={16} aria-hidden="true" />テストを送る
          </Button>
        </div>
        {testedLabel ? <p className={styles.testResult}>{testedLabel}</p> : null}
        <TestRecipientGuidance view={recipientView} accountId={settings.lineAccountId} onRecheck={onRecipientRecheck} />
      </section>

      <section className={styles.card} aria-labelledby="rm-check-title">
        <div className={styles.cardHead}>
          <h2 id="rm-check-title" className={styles.cardTitle}>有効にする前の確認</h2>
        </div>
        {!validation ? (
          validationFailed ? (
            <ListState kind="error" title="有効化前チェックを実行できませんでした" description="チェックが通るまで有効にはできません。通信を確認して、もう一度お試しください。" onRetry={onRetryValidation} />
          ) : (
            <ListState kind="loading" title="有効化前チェックを実行しています" />
          )
        ) : (
          <div className={styles.checkList}>
            <CheckRow
              ok={draft.lastTestStatus === 'succeeded'}
              title="テストを送った"
              note={draft.lastTestStatus === 'succeeded'
                ? `1通目を${sentKind === 'self' ? '自分' : sentKind === 'registered' ? '登録済みテスト宛先' : 'テスト送信先'}に送れました`
                : 'まだ送れていません。上の「テストを送る」から送ってください'}
            />
            <CheckRow
              ok={validation.audience.matched != null}
              title="対象者を数えた"
              note={validation.audience.matched != null ? `${formatNumber(validation.audience.matched)} 人に送る予定` : '対象者を数えられませんでした'}
              action={<Button variant="text" href={editHref(reminderId, 'target')}>見直す</Button>}
            />
            {validation.checks.filter((check) => check.key !== 'test_send').map((check) => (
              <CheckRow
                key={check.key}
                ok={check.status === 'passed'}
                title={check.label}
                note={check.message}
                action={check.status !== 'passed' ? <Button variant="text" href={editHref(reminderId, checkStageFor(check.key))}>直す</Button> : undefined}
              />
            ))}
          </div>
        )}
      </section>
    </CreatePage>
  )
}

export function CheckRow({ ok, title, note, action }: { ok: boolean; title: string; note: string; action?: ReactNode }) {
  return (
    <div className={styles.checkRow}>
      <span className={styles.checkIcon} data-ok={ok || undefined}>
        {ok ? <CheckCircle2 size={20} aria-hidden="true" /> : <CircleAlert size={20} aria-hidden="true" />}
      </span>
      <span className={styles.checkText}>
        <span className={styles.checkTitle}>{title}</span>
        <span className={styles.checkNote}>{note}</span>
      </span>
      {action}
    </div>
  )
}

/* ---------------- 完了 ---------------- */
export function DoneStageV8({
  frame,
  reminderId,
  settings,
  published,
  preview,
}: {
  frame: StageFrame
  reminderId: string
  settings: ReminderDraftSettings
  published: ReminderPublishResult | null
  preview: ReminderPreviewResult | null
}) {
  const nextScheduledAt = published?.nextScheduledAt
    ?? preview?.items.find((item) => item.state === 'scheduled')?.scheduledAt
    ?? null
  const next7 = preview?.summary.next7Days ?? published?.plannedDeliveries ?? null
  const { boardId, ...heading } = frame

  // 完了には下の帯が無い。型の枠と頭はそのまま使い、本文だけ真ん中のカードにする。
  return (
    <PageFrame kind="create" boardId={boardId}>
      <PageHeading {...heading} />
      <div className={styles.doneBody}>
        <Card variant="form" className={styles.doneCard}>
          <CreateCompletionHeading icon={<Check />} title={`「${settings.name}」を有効にしました`}>
            これから{settings.triggerType === 'friend_field' ? '基準日が入った人' : '予約が入った人'}にも、自動で予定が作られます。止めたいときは、詳細の「一時停止する」から止められます。
          </CreateCompletionHeading>
          <dl className={styles.doneFacts}>
            <div className={styles.doneFact}>
              <dt>最初に送る</dt>
              <dd>{nextScheduledAt ? formatMd(nextScheduledAt) : '予定なし'}</dd>
            </div>
            <div className={styles.doneFact}>
              <dt>今後7日</dt>
              <dd>{countLabel(next7, '通')}</dd>
            </div>
          </dl>
          <div className={styles.doneActions}>
            <Button href="/reminders"><List size={16} aria-hidden="true" />一覧へ戻る</Button>
            <Button variant="secondary" href={`/reminders/detail?id=${encodeURIComponent(reminderId)}&tab=schedule&status=planned`}>
              <CalendarClock size={16} aria-hidden="true" />配信予定を見る
            </Button>
            <Button variant="primary" href={`/reminders/detail?id=${encodeURIComponent(reminderId)}`}>
              詳細を見る<ArrowRight size={16} aria-hidden="true" />
            </Button>
          </div>
        </Card>
      </div>
    </PageFrame>
  )
}
