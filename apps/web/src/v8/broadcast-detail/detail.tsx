'use client'
import { knownValue } from '@/lib/known-value'

import TextLink from '@/components/shared/text-link'
import { BroadcastAbResult, abStatusDefinition, useAbResult } from '@/v8/broadcast-ab/public/result/index'
import { useFeatureAccess } from '@/lib/use-feature-access'
import { isSaveConflict, SaveConflictBand, SaveConflictCompareDialog, useSaveConflict } from '@/components/shared/save-conflict'
import { useRef, useState, type ReactNode, type RefObject } from 'react'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import {
  ArrowLeft,
  Check,
  CircleAlert,
  Copy,
  Download,
  FileClock,
  Pencil,
  RefreshCw,
  Send,
  Stamp,
  Trash2,
  Undo2,
} from 'lucide-react'
import { notifyToast } from '@/components/shared/toast'
import {
  api,
  ApiError,
  type ApiBroadcast,
  type BroadcastApprovalCandidate,
  type BroadcastApprovalState,
  type BroadcastInsight,
} from '@/lib/api'
import { type ActionMenuItem } from '@/components/shared/action-menu'
import { RowMenu } from '@/components/shared/row-actions'
import { DetailColumns } from '@/components/templates/detail-columns'
import { ListPageSection } from '@/components/templates/list-page'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary, { type OperationAccountTarget } from '@/components/shared/operation-target-summary'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import Progress from '@/components/shared/progress'
import Notice from '@/components/shared/notice'
import { Tabs } from '@/components/shared/tabs'
import { TextField } from '@/components/shared/text-field'
import { ApprovalRequestFields } from '@/components/broadcasts/broadcast-approval'
import { PageFrame, PageHeading } from '@/components/templates/page-frame'
import { Steps } from '@/components/templates'
import { messageTypeLabel } from '@/lib/broadcast-summary'
import { formatNumber } from '@/lib/format'
import BroadcastPhone from './phone'
import {
  CREATION_STEPS,
  chaseHref,
  displayStatusOf,
  cancelConflictMessage,
  formatBroadcastDateTime,
  formatMonthDay,
  formatShortDateTime,
  rateText,
} from './display'
import styles from './detail.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { Field } from '@/components/shared/form-controls'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import StatusBadge from '@/components/shared/status-badge'


/** 配信の記録にある送信元だけを確認画面へ渡す。未記録は不明として扱う。 */
export function broadcastOperationAccounts(broadcast: ApiBroadcast): OperationAccountTarget[] {
  const ids = broadcast.targetType === 'multi-account-dedup' ? broadcast.accountIds : broadcast.lineAccountId ? [broadcast.lineAccountId] : null
  return ids?.length ? [...new Set(ids)].map(id => ({ id })) : [{ id: '' }]
}

/** 送るまでの6段階。承認が絡まない・予約しない配信はその段を省く。 */
const DELIVERY_STEPS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'draft', label: '下書き' },
  { key: 'pending_approval', label: '承認待ち' },
  { key: 'scheduled', label: '予約中' },
  { key: 'preparing', label: '送信準備' },
  { key: 'sending', label: '送信中' },
  { key: 'sent', label: '送信済み' },
]

const BRANCH_LABELS: Record<string, string> = {
  partial_failed: '一部失敗',
  failed: '失敗',
  stopped: '停止中',
  expired: '期限切れ',
}

const BADGE_TONE: Record<string, 'info' | 'warning' | 'caution' | 'success' | 'danger' | 'neutral'> = {
  pending_approval: 'caution',
  scheduled: 'info',
  preparing: 'info',
  sending: 'warning',
  sent: 'success',
  partial_failed: 'warning',
  failed: 'danger',
}

export const broadcastBranchLabel = (status: string) => knownValue(BRANCH_LABELS, status, '')
export const broadcastBadgeTone = (status: string) => knownValue(BADGE_TONE, status, 'neutral')

type TabKey = 'overview' | 'recipients' | 'activity'

export interface BroadcastDetailProps {
  broadcast: ApiBroadcast
  /** LINE側の集計。まだ無い・取れないは「—」で出す（0 と混ぜない）。 */
  insight: (BroadcastInsight & { suppressedByAudienceSize: boolean }) | null
  insightState: 'loading' | 'ready' | 'error'
  /** 宛先の条件の要約（一覧と同じ audienceSummary を入口で作って渡す）。 */
  audienceLabel: string
  /** スマホ見本の部屋の名。 */
  accountName: string
  tab: TabKey
  onSelectTab: (tab: TabKey) => void
  /** 宛先・記録のタブの中身（入口から差し込む）。 */
  recipients: ReactNode
  activity: ReactNode
  onExportCsv: () => void
  /** 集計の取り直し・状態の読み直し（reloadToken を進める）。 */
  onReload: () => void
  /**
   * ：ほかの人が更新したときだけ true。この画面は書き換えず、
   * 帯で知らせて読み直しだけ受け付ける。
   */
  conflict?: boolean
  onConflictReload?: () => void
  /** 閲覧のみ：変える操作は置かずに隠す（2026-10-06 オーナー決定）。 */
  canEdit: boolean
  contentRef: RefObject<HTMLElement | null>
  approval: {
    state: BroadcastApprovalState | null
    busy: boolean
    message: string | null
    requesterName: string | null
    approverName: string | null
    candidates: BroadcastApprovalCandidate[]
    messageSummary: string | null
    canReRequest: boolean
    reApproverId: string
    reApprovalNote: string
    onApproverChange: (id: string) => void
    onNoteChange: (note: string) => void
    onRequest: () => void
    onCancel: () => void
    onRemind: () => void
    onReject: (reason: string) => void
    onApprove: () => void
  }
}

export default function BroadcastDetail({
  broadcast,
  insight,
  insightState,
  audienceLabel,
  accountName,
  tab,
  onSelectTab,
  recipients,
  activity,
  onExportCsv,
  onReload,
  canEdit,
  contentRef,
  approval,
  conflict = false,
  onConflictReload,
}: BroadcastDetailProps) {
  const canTestSend = useFeatureAccess('broadcasts', 'test')
  const canExport = useFeatureAccess('broadcasts', 'export')
  const router = useRouter()
  const { status: displayStatus, label: baseStatusLabel } = displayStatusOf(broadcast)
  /* G1：A/B の配信は状態を分けて札に出す（試し中・選んでください・残りへ送信中・送信済み）。 */
  const abResult = useAbResult(broadcast.status === 'draft' ? null : broadcast.id)
  const abStatus = abStatusDefinition(abResult.result)
  const statusLabel = abStatus?.label ?? baseStatusLabel
  const badgeTone = abStatus ? (abStatus.tone === 'neutral' ? 'info' : abStatus.tone) : broadcastBadgeTone(displayStatus)
  const isDraft = broadcast.status === 'draft'
  const isSent = broadcast.status === 'sent'
  const isScheduled = broadcast.status === 'scheduled'
  const broadcastScopeKey = JSON.stringify([broadcast.id, broadcast.targetType, broadcast.lineAccountId, broadcast.accountIds])
  const broadcastScope = useRef({ key: broadcastScopeKey, generation: 0 })
  if (broadcastScope.current.key !== broadcastScopeKey) broadcastScope.current = { key: broadcastScopeKey, generation: broadcastScope.current.generation + 1 }
  const [deleteGeneration, setDeleteGeneration] = useState(-1)
  const [cancelGeneration, setCancelGeneration] = useState(-1)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [asideExpanded, setAsideExpanded] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState('')
  const [cancelVersion, setCancelVersion] = useState<number | null>(null)
  const [cancelConflict, setCancelConflict] = useState(false)
  const cancelTicket = useRef<symbol | null>(null)
  const renderedCancelTicket = cancelTicket.current
  const [testing, setTesting] = useState(false)

  const collision = useSaveConflict<ApiBroadcast>({
    contextKey: broadcast.id,
    fetchLatest: async () => {
      const response = await api.broadcasts.get(broadcast.id)
      return response.success ? response.data : null
    },
    reload: () => onConflictReload?.(),
  })
  const editHref = `/broadcasts/new?draft=${encodeURIComponent(broadcast.id)}`
  const duplicateHref = `/broadcasts/new?duplicateFrom=${encodeURIComponent(broadcast.id)}`
  /* 下書きの現在地＝ `draft_step`（止まった手順）。なければ1つ目。 */
  const resumeStep = CREATION_STEPS[Math.max(0, CREATION_STEPS.findIndex((step) => step.key === broadcast.draftStep))]

  const deleteBroadcast = async () => {
    if (deleting) return
    setDeleting(true)
    setDeleteError('')
    try {
      const res = await api.broadcasts.delete(broadcast.id)
      if (!res.success) throw new Error(res.error)
      router.push('/broadcasts')
    } catch {
      setDeleteError('この配信を削除できませんでした。状態を読み直してから、もう一度お試しください。')
    } finally {
      setDeleting(false)
    }
  }

  const sendTest = async () => {
    if (!canTestSend) return
    if (testing) return
    setTesting(true)
    try {
      const res = await api.broadcasts.testSend(broadcast.id)
      if (!res.success) throw new Error(res.error)
      notifyToast(`テスト送信が完了しました（成功 ${res.sent ?? 0} 件・失敗 ${res.failed ?? 0} 件）。`)
    } catch {
      notifyToast('テスト送信できませんでした。テスト送信先の設定と配信内容を確認してください。', { tone: 'error' })
    } finally {
      setTesting(false)
    }
  }

  /* 予約の取り消し。中身は下書きとして残る（予約したあとの画面と同じ決まり）。 */
  const cancelReservation = async () => {
    if (cancelling || cancelConflict || cancelVersion === null) return
    setCancelling(true)
    setCancelError('')
    try {
      const res = await api.broadcasts.cancelReservation(broadcast.id, cancelVersion)
      if (renderedCancelTicket !== cancelTicket.current || cancelGeneration !== broadcastScope.current.generation) return
      if (!res.success) throw new Error(res.error)
      cancelTicket.current = null
      setCancelOpen(false)
      onReload()
    } catch (cause) {
      if (renderedCancelTicket !== cancelTicket.current || cancelGeneration !== broadcastScope.current.generation) return
      if (isSaveConflict(cause)) {
        setCancelConflict(true)
        setCancelError(cancelConflictMessage(cause instanceof ApiError ? cause.data : undefined))
      } else setCancelError('予約を取り消せませんでした。すでに送信が始まっているかもしれません。状態を読み直してから、もう一度お試しください。')
    } finally {
      setCancelling(false)
    }
  }

  /* 「…」の中身はすべて変える操作。閲覧のみには「…」ごと置かない。 */
  const menuItems: ActionMenuItem[] = [
    {
      id: 'duplicate',
      label: '複製して作る',
      icon: <Copy size={16} aria-hidden="true" />,
      external: false,
      href: duplicateHref, onSelect: () => router.push(duplicateHref),
    },
  ]
  if (isScheduled) {
    menuItems.push({
      id: 'cancel-reservation',
      label: '予約を取り消す',
      onSelect: () => { setCancelError(broadcast.version == null ? '予約の版を確認できません。読み直してから、もう一度選んでください' : ''); setCancelConflict(broadcast.version == null); cancelTicket.current = Symbol(); setCancelVersion(broadcast.version ?? null); setCancelGeneration(broadcastScope.current.generation); setCancelOpen(true) },
    })
  }
  menuItems.push({
    id: 'delete',
    label: '削除する',
    tone: 'danger',
    icon: <Trash2 size={16} aria-hidden="true" />,
    dividerBefore: true,
    onSelect: () => { setDeleteError(''); setDeleteGeneration(broadcastScope.current.generation); setDeleteOpen(true) },
  })

  const total = broadcast.totalCount
  const bubbleCount = broadcast.messageBubbles?.length ?? (broadcast.messageContent ? 1 : 0)
  const messageText = `${messageTypeLabel(broadcast.messageType)} ${formatNumber(bubbleCount)} 通`
  const scheduledLabel = broadcast.scheduledAt ? formatBroadcastDateTime(broadcast.scheduledAt) : null
  const approvalStatus = approval.state?.approval.status ?? null

  return (
    <PageFrame kind="detail" boardId="cgiGB pNiUk F3X1Mo Q28Gb dK1aE wfHIE tPm3e">
      <PageHeading title={broadcast.title}
        crumbs={<><p className={styles.meta}>{metaLine(broadcast, audienceLabel)}</p></>}
        steps={<>{isDraft
            ? <DraftStepRail broadcastId={broadcast.id} draftStep={broadcast.draftStep} canEdit={canEdit} />
            : <DeliveryRail broadcast={broadcast} approvalInvolved={approvalInvolved(broadcast, approval.state)} abWaiting={abResult.result?.status === 'undecided' || abResult.result?.status === 'testing'} />}</>}
        titleAccessory={<StatusBadge tone={badgeTone ?? 'neutral'}>{statusLabel}</StatusBadge>}
        actions={<>{canEdit ? (
            <>
              <RowMenu
                label={`配信「${broadcast.title}」の操作`}
                items={menuItems}
              />
            </>
          ) : null}
          {/* CSVは閲覧権限に加えて書き出しの鍵が要る。 */}
          {canExport ? <Button size="field" onClick={onExportCsv}>
            <Download aria-hidden="true" />
            CSVで書き出す
          </Button> : null}
          {canTestSend && !isSent && broadcast.status !== 'sending' ? (
            <Button size="field" onClick={() => void sendTest()} disabled={testing} busy={testing} busyLabel="テスト送信中…">
              <Send aria-hidden="true" />
              テストを送る
            </Button>
          ) : null}{canEdit && isDraft ? (
            <Button size="field" variant="primary" href={`${editHref}&step=${resumeStep.key}`}>
              <Pencil aria-hidden="true" />
              {resumeStep.order} {resumeStep.label}から続ける
            </Button>
          ) : null}{canEdit && isScheduled ? (
            <Button size="field" href={editHref}>
              <Pencil aria-hidden="true" />
              編集を続ける
            </Button>
          ) : null}{canEdit && isSent ? (
            <Button size="field" variant="primary" href={duplicateHref}>
              <Copy aria-hidden="true" />
              複製して作る
            </Button>
          ) : null}</>} />

      {conflict ? (
        <div className={styles.conflictWrap} data-design-node="Q28Gb">
          <SaveConflictBand title={`ほかの人が配信「${broadcast.title}」を更新しました`}
            description="この画面は古い内容です。読み直すと最新の設定と見本が出ます（この画面では書き換えません）。"
            compareBusy={collision.compareBusy} onCompare={collision.compare} onReload={collision.reloadLatest} />
          <SaveConflictCompareDialog open={collision.compareOpen} busy={collision.compareBusy} error={collision.compareError} onCancel={collision.closeCompare} onReload={collision.reloadLatest}
            lines={collision.latest ? [
              { text: `題：表示 ${broadcast.title} ／ 最新 ${collision.latest.title}` },
              { text: `状態：表示 ${broadcast.status} ／ 最新 ${collision.latest.status}` },
              { text: `予約時刻：表示 ${broadcast.scheduledAt ?? '未設定'} ／ 最新 ${collision.latest.scheduledAt ?? '未設定'}` },
            ] : null} />
        </div>
      ) : null}

      <div className={styles.tabs}>
        <Tabs
          label="配信の詳細"
          items={[
            { label: '概要', current: tab === 'overview', onClick: () => onSelectTab('overview') },
            { label: `宛先 ${formatNumber(total)}`, current: tab === 'recipients', onClick: () => onSelectTab('recipients') },
            { label: '記録', current: tab === 'activity', onClick: () => onSelectTab('activity') },
          ]}
        />
      </div>

      <ListPageSection><DetailColumns presentation="notification" asideLabel="配信した設定とメッセージ" expanded={asideExpanded} onExpandedChange={setAsideExpanded} aside={<>

          <h3 className={styles.secTitle}>配信した設定</h3>
          <dl className={styles.rows}>
            <Row label="対象" value={`${audienceLabel} ${formatNumber(total)} 人`} />
            <Row
              label={isSent ? '送った日時' : '送る日時'}
              value={
                isSent
                  ? formatBroadcastDateTime(broadcast.sentAt)
                  : scheduledLabel ? `${scheduledLabel} に送る予定` : '未設定（すぐに送る）'
              }
            />
            <Row label="送り方" value={isSent ? 'すぐに全員へ（分けて送らない）' : 'すぐに全員へ'} />
            <Row label="メッセージ" value={messageText} />
            <Row label="承認" value={approvalRowText(approvalStatus, approval)} />
            <Row
              label="作成者"
              value={broadcast.createdAt ? `${formatBroadcastDateTime(broadcast.createdAt)} 作成` : '記録していません'}
            />
          </dl>
          <h3 className={styles.secTitle} id="broadcast-phone">メッセージ</h3>
          <div ref={contentRef as RefObject<HTMLDivElement>}>
            <BroadcastPhone
              broadcast={broadcast}
              accountName={accountName}
              chip={
                isDraft
                  ? '送る前の見本'
                  : isSent
                    ? formatShortDateTime(broadcast.sentAt)
                    : broadcast.scheduledAt ? `${formatShortDateTime(broadcast.scheduledAt)} に届く予定` : '届く予定'
              }
              time={timeOf(isSent ? broadcast.sentAt : broadcast.scheduledAt)}
            />
          </div>

</>}>
<div className={styles.main}>
          {tab === 'recipients' ? recipients : tab === 'activity' ? activity : (<>
            <BroadcastAbResult broadcastId={broadcast.id} ab={abResult} canSend={canEdit} accounts={broadcastOperationAccounts(broadcast)} />
            <Overview
              broadcast={broadcast}
              insight={insight}
              insightState={insightState}
              approval={approval}
              canEdit={canEdit}
              messageText={messageText}
              scheduledLabel={scheduledLabel}
              resumeLabel={`${resumeStep.order} ${resumeStep.label}から続ける`}
              onReload={onReload}
              onChase={() => router.push(chaseHref(broadcast.id))}
            />
          </>)}
        </div>
</DetailColumns></ListPageSection>

      <ConfirmDialog
        open={deleteOpen && deleteGeneration === broadcastScope.current.generation}
        title={`「${broadcast.title}」を削除しますか？`}
        description="削除すると配信設定と確認画面から消えます。予約中の配信は中止され、この操作は取り消せません。"
        confirmLabel="削除する"
        destructive
        busy={deleting}
        error={deleteError || undefined}
        onConfirm={() => { if (deleteGeneration === broadcastScope.current.generation && canEdit) void deleteBroadcast() }}
        onCancel={() => { if (!deleting) setDeleteOpen(false) }}
      >
        <OperationTargetSummary accounts={broadcastOperationAccounts(broadcast)} />
      </ConfirmDialog>
      <CancelReservationDialog
        open={cancelOpen && cancelGeneration === broadcastScope.current.generation}
        broadcastId={broadcast.id} accounts={broadcastOperationAccounts(broadcast)}
        title={broadcast.title}
        description={broadcast.scheduledAt
          ? `${formatBroadcastDateTime(broadcast.scheduledAt)} に送る予定の ${formatNumber(total)} 人 に送らなくなります。取り消すと下書きに戻り、もう一度予約できます。${approvalStatus && approvalStatus !== 'none' ? '承認はやり直しになります。' : ''}`
          : '予約が取り消され、この配信は送られなくなります。書いた内容は下書きとして残るので、作り直しにはなりません。'}
        busy={cancelling}
        error={cancelError}
        reviewRequired={cancelConflict}
        onReload={() => { cancelTicket.current = null; setCancelOpen(false); setCancelConflict(false); onReload() }}
        onConfirm={() => { if (renderedCancelTicket && renderedCancelTicket === cancelTicket.current && cancelGeneration === broadcastScope.current.generation && canEdit) void cancelReservation() }}
        onClose={() => { if (!cancelling) { cancelTicket.current = null; setCancelOpen(false); if (cancelConflict) { setCancelConflict(false); onReload() } } }}
      />
    </PageFrame>
  )
}

/**
 * 予約を取り消す（確かめ）の窓（絵 ：幅480・題16/700・説明13/21・
 * ボタンは 取り消す（赤）・やめる・← 予約のまま残す（主）の順に左から）。
 */
export function CancelReservationDialog({
  open,
  broadcastId,
  accounts,
  title,
  description,
  busy,
  error,
  reviewRequired = false,
  onReload,
  onConfirm,
  onClose,
}: {
  open: boolean
  broadcastId: string
  accounts: OperationAccountTarget[]
  title: string
  description: string
  busy: boolean
  error: string
  reviewRequired?: boolean
  onReload?: () => void
  onConfirm: () => void
  onClose: () => void
}) {
  const key = JSON.stringify([broadcastId, accounts.map(account => account.id)])
  const target = useRef({ active: false, key: '', invalid: false })
  if (!open) target.current = { active: false, key: '', invalid: false }
  else if (!target.current.active) target.current = { active: true, key, invalid: false }
  else if (target.current.key !== key) target.current.invalid = true
  return (
    <Dialog
      open={open && !target.current.invalid}
      title={`「${title}」の予約を取り消しますか？`}
      description={description}
      designNode="BeNtj"
      designWidth={480}
      designHeaderPadding="24px 24px 0"
      busy={busy}
      error={reviewRequired && onReload ? undefined : error || undefined}
      onCancel={onClose}
      footer={reviewRequired && onReload ? undefined :
        <DialogActions>
          <>
            <Button type="button" variant="danger" onClick={() => { if (!reviewRequired && !target.current.invalid && target.current.key === key) onConfirm() }} disabled={busy || reviewRequired} busy={busy} busyLabel="取り消しています…">
              予約を取り消す
            </Button>
            <Button type="button" className={styles.cancelKeep} onClick={onClose} disabled={busy}>
              やめる
            </Button>
            <Button type="button" variant="primary" onClick={onClose} disabled={busy}>
              <ArrowLeft aria-hidden="true" />
              予約のまま残す
            </Button>
          </>
        </DialogActions>
      }
    >
      <OperationTargetSummary accounts={accounts} />
      {reviewRequired && onReload ? <SaveConflictBand title={error || '予約が変更されました'} description="最新の状態を確認してから、もう一度選んでください。" reloadVariant="primary" onReload={onReload} /> : null}
    </Dialog>
  )
}

/** 見出しの下の1行：種類・対象（人数）・送る/送った日時。 */
function metaLine(broadcast: ApiBroadcast, audienceLabel: string): string {
  const kind = messageTypeLabel(broadcast.messageType)
  const audience = broadcast.status === 'sent' ? audienceLabel : `${audienceLabel}（${formatNumber(broadcast.totalCount)} 人）`
  const when = broadcast.status === 'sent'
    ? (broadcast.sentAt ? `${formatBroadcastDateTime(broadcast.sentAt)} に送信` : '送信済み')
    : broadcast.status === 'sending'
      ? 'いま送っています'
      : broadcast.scheduledAt
        ? `${formatBroadcastDateTime(broadcast.scheduledAt)} に送る予定`
        : 'まだ送っていません'
  return `${kind}・${audience}・${when}`
}

function timeOf(value: string | null | undefined): string {
  const short = formatShortDateTime(value)
  return short ? short.slice(short.indexOf('）') + 1) : emptyValue('unknown')
}

/** 承認が絡む配信か（承認の段を進みの帯に出すか）。 */
function approvalInvolved(broadcast: ApiBroadcast, state: BroadcastApprovalState | null): boolean {
  const status = state?.approval.status ?? broadcast.approvalStatus ?? 'none'
  return status !== 'none' && status !== 'cancelled'
}

function approvalRowText(status: string | null, approval: BroadcastDetailProps['approval']): string {
  if (status === 'pending') return `${approval.approverName ?? 'スタッフ'}さんの承認待ち`
  if (status === 'approved') {
    const decided = approval.state?.approval.decidedAt
    return `${approval.approverName ?? 'スタッフ'}（${decided ? formatMonthDay(decided) : '承認済み'}）`
  }
  if (status === 'rejected') return '差し戻し'
  if (status === 'expired') return '期限切れ'
  return '要らない'
}

/**
 * 下書きの進み：作るときの5手順（`draft_step` で現在地）。型の共通部品 Steps（Fa8ED）で題と説明のすぐ下に1行。
 * 済んだ手順を押すとその手順の作成画面へ戻る（閲覧のみは押せる形にしない）。
 */
function DraftStepRail({ broadcastId, draftStep, canEdit }: { broadcastId: string; draftStep: string | null | undefined; canEdit: boolean }) {
  const router = useRouter()
  const currentIndex = Math.max(0, CREATION_STEPS.findIndex((step) => step.key === draftStep))
  return (
    <div className={styles.draftSteps}>
      <Steps
        label="作成の進み"
        currentKey={CREATION_STEPS[currentIndex]?.key}
        steps={CREATION_STEPS.map((step, index) => ({
          key: step.key,
          label: step.label,
          order: step.order,
          state: index < currentIndex ? 'done' as const : 'todo' as const,
          onSelect: canEdit && index < currentIndex
            ? () => router.push(`/broadcasts/new?draft=${encodeURIComponent(broadcastId)}&step=${step.key}`)
            : undefined,
        }))}
      />
    </div>
  )
}

/**
 * 送るまでの6段階。承認が絡まない・予約しない
 * 配信はその段を省く。分かれ道（失敗・停止・期限切れ）は札で添える。
 */
/* abWaiting：A/B で残りの人への送信がまだ（選んでください・試し中）。段は「送信中」にとどめ、送信済みへ進めない。 */
function DeliveryRail({ broadcast, approvalInvolved: withApproval, abWaiting = false }: { broadcast: ApiBroadcast; approvalInvolved: boolean; abWaiting?: boolean }) {
  const { status: baseStatus } = displayStatusOf(broadcast)
  const displayStatus = abWaiting && baseStatus === 'sent' ? 'sending' : baseStatus
  const scheduled = broadcast.status === 'scheduled' || broadcast.scheduledAt != null
  const steps = DELIVERY_STEPS.filter((step) => {
    if (step.key === 'pending_approval') return withApproval
    if (step.key === 'scheduled') return scheduled
    return true
  })
  const progressKey = displayStatus === 'partial_failed' || displayStatus === 'failed' ? 'sent'
    : displayStatus === 'stopped' ? 'sending'
    : displayStatus === 'expired' ? (withApproval ? 'pending_approval' : 'draft')
    : displayStatus
  const currentIndex = Math.max(0, steps.findIndex((step) => step.key === progressKey))
  const branchLabel = broadcastBranchLabel(displayStatus)
  return (
    <ol className={styles.rail} aria-label="配信の状態">
      {steps.map((step, index) => {
        const finished = displayStatus === 'sent' && index === currentIndex
        const state = index < currentIndex || finished ? 'done' : index === currentIndex ? 'current' : 'todo'
        return (
          <li key={step.key} className={`${styles.railItem} ${styles.railDelivery}`} data-delivery-stage={state} data-finished={finished || undefined} data-kind="delivery">
            {index > 0 ? <span className={styles.railLine} data-done={index <= currentIndex || undefined} aria-hidden="true" /> : null}
            <span className={styles.railStep}>
              <span className={styles.railMark} aria-hidden="true">{state === 'done' && !finished ? <Check size={16} strokeWidth={3} /> : null}</span>
              <span className={styles.railLabel} aria-current={state === 'current' ? 'step' : undefined}>{step.label}</span>
            </span>
          </li>
        )
      })}
      {branchLabel ? (
        <li className={styles.railItem}>
          <span className={styles.railLine} aria-hidden="true" />
          <StatusBadge tone={broadcastBadgeTone(displayStatus)}>{branchLabel}</StatusBadge>
        </li>
      ) : null}
    </ol>
  )
}

/** 概要タブの本文（左の列）。状態ごとに見せる段を変える。 */
function Overview({
  broadcast,
  insight,
  insightState,
  approval,
  canEdit,
  messageText,
  scheduledLabel,
  resumeLabel,
  onReload,
  onChase,
}: {
  broadcast: ApiBroadcast
  insight: (BroadcastInsight & { suppressedByAudienceSize: boolean }) | null
  insightState: 'loading' | 'ready' | 'error'
  approval: BroadcastDetailProps['approval']
  canEdit: boolean
  messageText: string
  scheduledLabel: string | null
  resumeLabel: string
  onReload: () => void
  onChase: () => void
}) {
  const total = broadcast.totalCount
  const isSent = broadcast.status === 'sent'
  const delivered = insight?.delivered ?? broadcast.successCount
  const opened = insight?.opens?.count ?? insight?.uniqueImpression ?? null
  const openRate = insight?.opens?.rate ?? insight?.openRate ?? null
  const failedCount = Math.max(0, total - broadcast.successCount)
  const insightReady = insightState === 'ready'
  const waiting = insightState === 'loading' ? '読み込んでいます' : insightState === 'error' ? '読み込めませんでした' : null
  const unclicked = insight?.uniqueClick != null ? Math.max(0, delivered - insight.uniqueClick) : null
  const state = approval.state

  return (
    <>
      {broadcast.status === 'draft' ? (
        <section className={styles.softBox}>
          <FileClock className={styles.boxIcon} aria-hidden="true" />
          <div className={styles.boxText}>
            <p className={styles.boxTitle}>まだ送っていません</p>
            <p className={styles.desc}>
              まだ送っていません。送ると、届いた・開いた・押した数がここに出ます。
              {canEdit ? `「${resumeLabel}」で作るのを続けられます。` : ''}
            </p>
          </div>
        </section>
      ) : null}

      {state ? (
        <ApprovalBox
          state={state}
          approval={approval}
          canEdit={canEdit}
          messageText={messageText}
          scheduledLabel={scheduledLabel}
        />
      ) : null}
      {state?.approval.status === 'pending' ? (
        <Notice tone="warn" appearance="soft" className={styles.deadline}>
          承認されないまま {scheduledLabel ?? '送る時刻'} を過ぎると、送らずに期限切れになります。
        </Notice>
      ) : null}

      {canEdit && approval.canReRequest && state ? (
        <section aria-label="承認の依頼" className={styles.section}>
          <h3 className={styles.secTitle}>承認を依頼する</h3>
          <p className={styles.desc}>
            {formatNumber(state.gate.recipientCount)} 人への配信です。承認されるまで送られません。
          </p>
          <ApprovalRequestFields
            recipientCount={state.gate.recipientCount}
            threshold={state.gate.threshold}
            candidates={approval.candidates}
            candidatesState={approval.candidates.length > 0 ? 'ready' : 'loading'}
            approverId={approval.reApproverId}
            onApproverChange={approval.onApproverChange}
            note={approval.reApprovalNote}
            onNoteChange={approval.onNoteChange}
          />
          {approval.message ? <p className={styles.error}>{approval.message}</p> : null}
          <div>
            <Button onClick={approval.onRequest} disabled={approval.busy}>承認を依頼する</Button>
          </div>
        </section>
      ) : null}

      {broadcast.status !== 'draft' ? <>
      <h3 className={styles.secTitle}>{isSent ? '配信結果' : '送信の進み具合'}</h3>
      {broadcast.status === 'sending' ? (
        <Progress
          state="active"
          title="送信中"
          percent={total > 0 ? (broadcast.successCount / total) * 100 : 0}
          countText={`${formatNumber(broadcast.successCount)} / ${formatNumber(total)} 件`}
        />
      ) : null}
      <KpiBand>
        {isSent ? (
          <>
            <KpiCard title="届いた" value={delivered} unit="人" detail={`送信成功 ${rateText(total > 0 ? delivered / total : null)}`} presentation="band" />
            <KpiCard title="開いた" value={insightReady ? opened : null} unit="人" detail={waiting ?? `開封 ${rateText(openRate)}`} presentation="band" />
            <KpiCard title="押した" value={insightReady ? insight?.uniqueClick ?? null : null} unit="人" detail={waiting ?? `クリック ${rateText(insight?.clickRate)}`} presentation="band" />
            {/* ブロックは単独では取れない。届かなかった数（送信失敗を含む）を出し、内訳は下の「エラー」に書く。 */}
            <KpiCard title="ブロック" value={failedCount} unit="人" detail={rateText(total > 0 ? failedCount / total : null)} presentation="band" />
          </>
        ) : (
          <>
            <KpiCard title="送信"
              value={broadcast.successCount}
              unit="件"
              detail={scheduledLabel ? `${scheduledLabel} に送り始めます` : 'まだ送っていません'} presentation="band"
            />
            <KpiCard title="届いた" value={broadcast.successCount} unit="人" detail="送る前のため、まだありません" presentation="band" />
            <KpiCard title="開いた" value={null} unit="" detail={insightState === 'error' ? '読み込めませんでした' : '—'} presentation="band" />
            <KpiCard title="押した" value={null} unit="" detail={insightState === 'error' ? '読み込めませんでした' : '—'} presentation="band" />
          </>
        )}
      </KpiBand>
      {isSent ? (
        <p className={styles.note}>
          配信から 14 日間の数。開いた・押したは人数（同じ人は 1 人）。20 人に満たないときは「—」で出します（少なすぎる数は出さない）。率は届いた人数で割った値。
        </p>
      ) : null}
      {insightState === 'error' ? (
        <div className={styles.inlineRow}>
          <p className={styles.desc}>開封・クリックを読み込めませんでした。送信の件数は上のとおりです。</p>
          <Button onClick={onReload}>集計を再読み込み</Button>
        </div>
      ) : null}

      {isSent ? (
        <>
          <section className={styles.section}>
            <div className={styles.secHead}>
              <h3 className={styles.secTitle}>反応</h3>
              <TextLink href="/inflow-links">流入経路で見る</TextLink>
            </div>
            {insight?.links?.length ? (
              <ul className={styles.linkList}>
                {insight.links.map((link) => (
                  <li key={link.id} className={styles.linkRow}>
                    <div className={styles.linkTop}>
                      <div className={styles.linkText}>
                        <p className={styles.linkTitle} title={link.label}>{link.label}</p>
                        <p className={styles.linkUrl} ><TruncatedText value={String(link.url ?? '')} url /></p>
                      </div>
                      <p className={styles.linkCount}>
                        {`押した ${formatNumber(link.uniqueClickCount)} 人（${rateText(link.clickRate)}）`}
                        {link.clickCount != null ? `・押された回数 ${formatNumber(link.clickCount)} 回` : ''}
                      </p>
                    </div>
                    <progress
                      className={styles.bar}
                      max={100}
                      value={Math.min(100, Math.max(0, (link.clickRate ?? 0) <= 1 ? (link.clickRate ?? 0) * 100 : (link.clickRate ?? 0)))}
                      aria-label={`${link.label}を押した割合`}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.desc}>計測したボタン・リンクはありません。</p>
            )}
          </section>
          {insight?.links?.length && canEdit ? (
            <section className={styles.chase}>
              <p className={styles.boxTitle}>リンクを押していない人へ追送</p>
              <p className={styles.desc}>
                {`届いたのにリンクを押していない${unclicked != null ? ` ${formatNumber(unclicked)} 人` : '人'}だけを宛先にして、同じ文面で作り直します。作成画面で人数を確かめてから送ります。`}
              </p>
              <div>
                <Button size="field" onClick={onChase}>
                  <Send aria-hidden="true" />
                  追送する配信を作る
                </Button>
              </div>
            </section>
          ) : null}
          <section className={styles.section}>
            <h3 className={styles.secTitle}>エラー</h3>
            <p className={styles.plain}>
              {failedCount > 0 ? `送信に失敗した人がいます（${formatNumber(failedCount)} 人）。` : '送信に失敗した人はいません（0 人）。'}
            </p>
          </section>
        </>
      ) : null}

      <section className={styles.section}>
        <h3 className={styles.secTitle}>アカウント別の内訳</h3>
        <p className={styles.faint}>
          アカウントごとの送信・届いた・開いた数は記録していません。複数のアカウントに送った場合も、上の数は合計です。
        </p>
      </section>

      {isSent ? null : (
        <section className={styles.section}>
          <div className={styles.secHead}>
            <h3 className={styles.secTitle}>押されたリンク</h3>
            <TextLink href="/inflow-links">流入経路で見る</TextLink>
          </div>
          <p className={styles.faint}>
            配信ごとのリンク別の押された数はまだ出せません。リンク全体は「分析 → URL クリック」で見られます。
          </p>
        </section>
      )}
      </> : null}
    </>
  )
}

/**
 * 承認の箱。承認待ちは緑の箱に 依頼・要点・差し戻す理由・操作。
 * 頼まれた人だけが 差し戻す／承認して送る を押せる。頼んだ人には 取り消す／もう一度知らせる。
 * 差し戻し・期限切れは理由だけを出す。承認済みは右の欄の「承認」に出す（箱は出さない）。
 */
function ApprovalBox({
  state,
  approval,
  canEdit,
  messageText,
  scheduledLabel,
}: {
  state: BroadcastApprovalState
  approval: BroadcastDetailProps['approval']
  canEdit: boolean
  messageText: string
  scheduledLabel: string | null
}) {
  const [reason, setReason] = useState('')
  const { status, note, requestedAt, rejectReason } = state.approval
  if (status === 'rejected' || status === 'expired') {
    return (
      <section className={styles.softBox} aria-label={status === 'rejected' ? '差し戻し' : '期限切れ'}>
        <CircleAlert className={styles.boxIcon} aria-hidden="true" />
        <div className={styles.boxText}>
          <p className={styles.boxTitle}>{status === 'rejected' ? '差し戻されました' : '期限切れです'}</p>
          <p className={styles.desc}>
            {status === 'rejected'
              ? `理由：${rejectReason || emptyValue('unknown')}。内容を直して、もう一度承認を依頼してください。`
              : '承認されないまま予約の時刻を過ぎたため、送っていません。送るには作り直してください。'}
          </p>
        </div>
      </section>
    )
  }
  if (status !== 'pending') return null
  const mine = state.viewer.isApprover
  const request = [
    `依頼：${approval.requesterName ?? emptyValue('unknown')}・${formatBroadcastDateTime(requestedAt)}`,
    note ? `ひとこと「${note}」` : '',
  ].filter(Boolean).join('　')
  return (
    <section className={styles.approval} aria-label="承認待ち">
      <p className={styles.approvalTitle}>
        <Stamp className={styles.approvalIcon} aria-hidden="true" />
        {mine ? 'あなたの承認を待っています' : approval.approverName ? `${approval.approverName}さんの承認を待っています` : '承認を待っています'}
      </p>
      <p className={styles.approvalRequest}>{request}</p>
      <dl className={styles.facts}>
        <div className={styles.fact}><dt>送る相手</dt><dd>{formatNumber(state.gate.recipientCount)} 人</dd></div>
        <div className={styles.fact}><dt>送る日時</dt><dd>{scheduledLabel ?? '今すぐ送る'}</dd></div>
        <div className={styles.fact}><dt>メッセージ</dt><dd>{`${messageText}（右のスマホ）`}</dd></div>
      </dl>
      {mine ? (
        <>
          <div className={styles.field}><Field label="差し戻すときの理由" htmlFor="approval-reject-reason" required><SaveErrorField names={["reason"]}><TextField
              id="approval-reject-reason"
              maxLength={1000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="例：日時を 10 月にずらしてください"
            /></SaveErrorField></Field></div>
          {approval.message ? <p className={styles.error}>{approval.message}</p> : null}
          <div className={styles.approvalButtons}>
            <Button
              onClick={() => approval.onReject(reason)}
              disabled={approval.busy || reason.trim() === ''}
              title={reason.trim() === '' ? '差し戻すときは理由が要ります' : undefined}
            >
              <Undo2 aria-hidden="true" />
              差し戻す
            </Button>
            <Button variant="primary" onClick={approval.onApprove} disabled={approval.busy}>
              <Check aria-hidden="true" />
              承認して送る
            </Button>
          </div>
        </>
      ) : state.viewer.isRequester && canEdit ? (
        <>
          {approval.message ? <p className={styles.error}>{approval.message}</p> : null}
          <div className={styles.approvalButtons}>
            <Button onClick={approval.onCancel} disabled={approval.busy}>依頼を取り消す</Button>
            <Button onClick={approval.onRemind} disabled={approval.busy}>もう一度知らせる</Button>
          </div>
        </>
      ) : null}
    </section>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.row}>
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  )
}
