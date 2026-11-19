'use client'

import { CommonVarTestFailure, type CommonVarFailure } from '@/components/shared/common-var-test-failure'

/*
 * ★V8 一斉配信を予約したあと（絵の再撮 ）。2026-10-06 一から書き直し。
 *
 * 白い板いっぱいに 板の頭（← 一覧へ・題＋札・1行の説明）→
 * 左（「できた」の箱：5行の内容・Slack の帯・真ん中のボタン → 送る前に確かめること）と
 * 右の欄（次にできること → メッセージのスマホ）。
 * 予約の読み込み・取消・複製・テスト送信の中身は入口（app/broadcasts/reserved/page.tsx）が持つ。
 */
import { CalendarCheck, Copy, Eye, Send } from 'lucide-react'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import { DetailPage } from '@/components/templates/detail-page'
import { CreateSummaryCard } from '@/components/templates/create-parts'
import StatusBadge from '@/components/shared/status-badge'
import SectionHeader from '@/components/shared/section-header'
import TruncatedText from '@/components/shared/truncated-text'
import type { ApiBroadcast } from '@/lib/api'
import { messageTypeLabel } from '@/lib/broadcast-summary'
import { formatNumber } from '@/lib/format'
import BroadcastPhone from './phone'
import { broadcastOperationAccounts, CancelReservationDialog } from './detail'
import { formatBroadcastDateTime, formatShortDateTime } from './display'
import styles from './reserved.module.css'
import { emptyValue } from '@/components/shared/empty-value'

type AudienceEstimate = {
  audienceCount: number
  hiddenExcluded: number
  warnings: Array<{ level: 'info' | 'warning'; message: string }>
}

export interface ReservedProps {
  broadcast: ApiBroadcast
  /** 人数の再集計。取れないときは null（0 と混ぜない）。 */
  estimate: AudienceEstimate | null
  /** 宛先の条件の要約（一覧・詳細と同じ audienceSummary を入口で作る）。 */
  audienceLabel: string
  /** 承認待ちのときの承認者名（「承認：名前」）。取れなければ null。 */
  approverName: string | null
  accountName: string
  notificationText: string
  /** 閲覧のみ：変える操作は置かずに隠す（2026-10-06 オーナー決定）。 */
  canEdit: boolean
  testSend: () => void
  duplicate: () => void
  actionBusy: 'test' | 'duplicate' | null
  actionError: string
  missingVars?: CommonVarFailure[] | null
  clearActionError: () => void
  /** 予約の取消の窓と実行。 */
  cancelOpen: boolean
  openCancel: () => void
  closeCancel: () => void
  confirmCancel: () => void
  cancelling: boolean
  cancelError: string
  cancelConflict?: boolean
  reloadCancel?: () => void
  cancelled: boolean
}

export default function Reserved({
  broadcast,
  estimate,
  audienceLabel,
  approverName,
  accountName,
  notificationText,
  canEdit,
  testSend,
  duplicate,
  actionBusy,
  actionError,
  missingVars,
  clearActionError,
  cancelOpen,
  openCancel,
  closeCancel,
  confirmCancel,
  cancelling,
  cancelError,
  cancelConflict,
  reloadCancel,
  cancelled,
}: ReservedProps) {
  const scheduledLabel = broadcast.scheduledAt ? formatBroadcastDateTime(broadcast.scheduledAt) : '日時未設定'
  const audienceCount = estimate?.audienceCount ?? null
  const bubbleCount = broadcast.messageBubbles?.length ?? (broadcast.messageContent ? 1 : 0)
  const approverLabel = broadcast.approvalStatus === 'approved'
    ? '（承認済み）'
    : broadcast.approvalStatus === 'pending'
      ? approverName ? `（承認：${approverName}）` : '（承認待ち）'
      : ''
  const warnings = estimate?.warnings.length
    ? estimate.warnings.map((warning) => warning.message)
    : ['送り始めるときに、対象の人数をもう一度数えます。']
  const canCancel = canEdit && broadcast.status === 'scheduled' && !cancelled
  const shortTime = formatShortDateTime(broadcast.scheduledAt)

  const summary = <div className={styles.aside}>
    {canEdit ? <>
      <SectionHeader title="次にできること" />
      <div className={styles.nextActions}>
        <Button fullWidth onClick={testSend} disabled={actionBusy !== null} title={actionBusy === 'duplicate' ? '複製が終わるまでお待ちください' : undefined} busy={actionBusy === 'test'} busyLabel="テスト送信中…">
          <Send aria-hidden="true" />テストを送る
        </Button>
        <Button fullWidth onClick={duplicate} disabled={actionBusy !== null} title={actionBusy === 'test' ? 'テスト送信が終わるまでお待ちください' : undefined} busy={actionBusy === 'duplicate'} busyLabel="複製中…">
          <Copy aria-hidden="true" />複製して別の配信を作る
        </Button>
        {canCancel ? <Button variant="text" textTone="danger" onClick={openCancel}>予約を取り消す…</Button> : null}
      </div>
      {missingVars && <CommonVarTestFailure names={missingVars} />}
      {actionError ? <Notice tone="danger" message={actionError} onClose={clearActionError} /> : null}
    </> : null}
    <SectionHeader title="メッセージ" />
    <BroadcastPhone broadcast={broadcast} accountName={accountName}
      chip={shortTime ? `${shortTime} に届きます` : undefined}
      time={shortTime ? shortTime.slice(shortTime.indexOf('）') + 1) : emptyValue('unknown')} />
  </div>
  const rows = [
    { label: '管理名', value: broadcast.title },
    { label: '配信対象', value: `${audienceLabel}${audienceCount === null ? '' : ` ${formatNumber(audienceCount)} 人`}${estimate && estimate.hiddenExcluded > 0 ? `（除く見込み ${formatNumber(estimate.hiddenExcluded)} 人）` : ''}` },
    { label: '送る日時', value: scheduledLabel },
    { label: 'メッセージ', value: `${messageTypeLabel(broadcast.messageType)} ${formatNumber(bubbleCount)} 通` },
    { label: '状態', value: `予約中${approverLabel}` },
  ].map(row => ({ ...row, value: <TruncatedText value={row.value} /> }))

  return (
    <DetailPage layout="record-detail" heightMode="content" boardId="cdZBf CRtK8" readOnly={!canEdit}
      title={broadcast.title}
      subtitle={`${scheduledLabel} に、${audienceCount === null ? '対象の友だち' : `${formatNumber(audienceCount)}人`}へ送ります。開始の前までは確かめる・取り消すができます。`}
      titleAccessory={<StatusBadge tone="info">予約中</StatusBadge>}
      summary={summary} summaryLabel="次にできることとメッセージ"
      summaryPreview={{ label: '次の操作とメッセージを見る', title: '次にできることとメッセージ' }}>
      <CreateSummaryCard variant="completion" completionIcon={<CalendarCheck />} title="一斉配信を予約しました" description="送る前にもう一度、対象の人数を数え直します" rows={rows}>
        <Notice tone="info" message={notificationText || '配信の開始・完了・エラーは、Slack の同じスレッドへ知らせます。'} />
        <div className={styles.doneButtons}><Button variant="primary" href={`/broadcasts/detail?id=${encodeURIComponent(broadcast.id)}`}><Eye aria-hidden="true" />予約の内容を見る</Button></div>
      </CreateSummaryCard>
      <Notice tone="warn" heading="送る前に確かめること">{warnings.map((message,index) => <span key={index}>{`・${message}`}{index < warnings.length - 1 ? <br /> : null}</span>)}</Notice>
      {cancelled ? <Notice tone="success" message="予約を取り消しました。内容は下書きとして残っています。" /> : null}

      <CancelReservationDialog
        open={cancelOpen}
        broadcastId={broadcast.id} accounts={broadcastOperationAccounts(broadcast)}
        title={broadcast.title}
        description={broadcast.scheduledAt
          ? `${scheduledLabel} に送る予定の ${audienceCount === null ? '対象の友だち' : `${formatNumber(audienceCount)} 人`} に送らなくなります。取り消すと下書きに戻り、もう一度予約できます。${broadcast.approvalStatus && broadcast.approvalStatus !== 'none' ? '承認はやり直しになります。' : ''}`
          : '予約が取り消され、この配信は送られなくなります。書いた内容は下書きとして残るので、作り直しにはなりません。'}
        busy={cancelling}
        error={cancelError}
        reviewRequired={cancelConflict}
        onReload={reloadCancel}
        onConfirm={confirmCancel}
        onClose={closeCancel}
      />
    </DetailPage>
  )
}
