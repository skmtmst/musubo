'use client'
import { FolderDotName } from '@/components/shared/folder-dot'
import { useListUrlValue } from '@/components/shared/list-url-state'
import { useCallback, useEffect, useRef, useState } from 'react'
import { FileCode, History, Inbox, LayoutList, RefreshCw, RotateCw, TriangleAlert } from 'lucide-react'
import type { WebhookInteraction, WebhookInteractionList } from '@line-crm/shared'
import { api, ApiError } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { useStaffRole, canManageRole } from '@/lib/staff-role'
import { formatNumber } from '@/lib/format'
import { ListPage, ListPagePagination } from '@/components/templates'
import ListToolbar from '@/components/shared/list-toolbar'
import Button from '@/components/shared/button'
import StatusBadge, { type StatusBadgeTone } from '@/components/shared/status-badge'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import { Tabs } from '@/components/shared/tabs'
import { LogEntryCopy } from '@/components/shared/log-entry-details'
import { LogRecordJson } from '@/v8/log-record'
import ListState from '@/components/shared/list-state'
import AccountRequiredState from '@/components/shared/account-required-state'
import Notice from '@/components/shared/notice'
import Pagination from '@/components/shared/pagination'
import PageSizeSelect from '@/components/shared/page-size-select'
import Select from '@/components/shared/select'
import { ActionCell, DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table'
import { RowMenu } from '@/components/shared/row-actions'
import { DelayedSkeleton, Skeleton } from '@/components/shared/skeleton'
import { notifyToast } from '@/components/shared/toast'
import { withViewTransition } from '@/components/shared/view-transition'
import { ViewerBand, WEBHOOKS_DESCRIPTION, WebhookBand, WebhookTabs, useWebhookOverview, type BandCell } from './shell'
import { eventWord, shortDateTime } from './words'
import styles from './interactions.module.css'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField } from '@/components/shared/save-form-errors'

/*
 * ★V8 外部連携「やり取りの記録」タブ（Pencil 、中身は ）。
 *
 * 型（ListPage）に、タブ・やり取りの帯・案内の帯・道具の段（探す・札4つ・
 * まとめてやり直す）・表・ページ送りをはめる。データの口は 管理画面 と同じ
 * （一覧・送り直し・まとめて送り直し）。URL・鍵・本文は一覧にも中身にも出さない。
 * 絵と今の作りが合わない所は BEHAVIOR.md に書いた（CSV の書き出し口が無い など）。
 */

type Direction = 'all' | 'outgoing' | 'incoming'
type Status = 'all' | 'failed'

const EMPTY: WebhookInteractionList = {
  items: [],
  total: 0,
  page: 1,
  limit: 20,
  summary: {
    total: 0, outgoing: 0, incoming: 0, succeeded: 0, failed: 0,
    resultUnknown: 0, outgoingFailed: 0, retryable: 0, averageDurationMs: null,
  },
}

/** きっかけの言葉（古い点つきの種類も読む）。 */
function triggerWord(item: WebhookInteraction): string {
  if (item.eventType === 'incoming_webhook.test') return `${item.webhookName}の受け取りを試した`
  if (item.direction === 'incoming') return `${item.webhookName}から受け取った`
  return eventWord(item.eventType)
}

/*
 * 「送った・届いた中身」の2行。口は1つの文（triggerSummary）しか返さないので、
 * 最初の「・」の前を1行目、後ろを2行目にする。何度もやり直して失敗したときは経緯を足す。
 */
function bodyLines(item: WebhookInteraction): { main: string; sub: string } {
  const [head, ...rest] = item.triggerSummary.split('・')
  const tail = rest.join('・')
  const retried = item.retryOfId
    ? '前の失敗をやり直した記録'
    : item.status === 'failed' && item.attemptCount > 1 ? `${item.attemptCount}回やり直して失敗` : ''
  return { main: head || emptyValue('unknown'), sub: [tail, retried].filter(Boolean).join('・') }
}

/* 返事の札。言葉は口の返事、色は記録の状態（処理中・送り直し済みを成功の緑にしない）。 */
function replyLabel(item: WebhookInteraction): { text: string; tone: StatusBadgeTone } {
  const { tone } = interactionState(item)
  if (item.status === 'failed') return { text: item.responseLabel, tone }
  if (item.direction === 'incoming') return { text: '受け取った', tone }
  return { text: item.responseLabel, tone }
}

function seconds(ms: number | null): string {
  return ms == null ? emptyValue('unknown') : `${(Math.round(ms / 100) / 10).toFixed(1)} 秒`
}

/* その記録をここからやり直せるかを業務の言葉で説明する（管理画面 と同じ定義）。 */
function retryabilityText(item: WebhookInteraction, allowed: boolean): string {
  if (item.eventType === 'incoming_webhook.test') return '受け取りの試しの記録です。実際の受け取りと処理の実行はしていないため、送り直す対象ではありません。'
  if (item.status === 'succeeded') return '届いた記録なので、送り直す必要はありません。'
  if (item.status === 'pending') return 'いま処理の途中です。終わってから結果を確かめてください。'
  if (item.status === 'retried') return 'すでに送り直した記録です。あとから追加された新しい記録の結果を確かめてください。'
  if (item.direction === 'incoming') return '受け取った記録なので、こちらからは送り直せません。相手側でもう一度送ってもらってください。'
  if (item.retryBlockReason === 'webhook_deleted') return '送り先は削除されました。ここからは送り直せません。必要なら連携を作り直してください。'
  if (item.retryBlockReason === 'webhook_inactive') return '送り先が止められています。送る一覧で動かしてから「やり直す」を押してください。'
  if (item.retryBlockReason === 'auto_retry_scheduled') return `自動での送り直しが予定されています${item.autoRetryNextAt ? `（${shortDateTime(item.autoRetryNextAt)}頃）` : ''}。しばらく待って届かない場合は、連携先の状態を確かめてください。`
  if (item.retryBlockReason === 'already_delivered') return '自動の送り直しで届いています。ここから送り直す必要はありません。'
  if (!item.canRetry) return 'つなぎ先の設定が消えたか、送った内容が残っていないため、ここからは送り直せません。'
  if (!allowed) return '送り直せるのは統括と管理者です。'
  if (item.failureReasonCode === 'secret_unavailable') return '署名に使う合言葉をこちらで確認できませんでした。相手には一度も送っていません。連携の設定を保存し直してから「やり直す」を押してください。'
  if (item.failureReasonCode === 'unknown') return '相手先に届いたか分かっていません。相手先の記録で同じ処理がないか確かめてから「やり直す」を押してください。'
  return 'この画面の「やり直す」から、同じ届け番号でもう一度送れます。届いていた場合でも相手先で二重に処理されない仕組みです。'
}

/** 状態の札の言葉と色。色は共通の札（StatusBadge）の5色だけを使う。 */
function interactionState(item: WebhookInteraction): { label: string; tone: StatusBadgeTone } {
  if (item.status === 'failed') return { label: '失敗', tone: 'danger' }
  if (item.status === 'succeeded') return { label: '成功', tone: 'success' }
  if (item.status === 'retried') return { label: '送り直し済み', tone: 'neutral' }
  return { label: '処理中', tone: 'warning' }
}

function canRetryNow(item: WebhookInteraction, allowed: boolean): boolean {
  return allowed && item.canRetry && item.direction === 'outgoing' && item.status === 'failed'
}

function failureDetail(
  items: WebhookInteraction[],
  summary: WebhookInteractionList['summary'],
): string {
  if (summary.failed === 0) return '失敗はありません'
  const parts: string[] = []
  const incomingFailed = Math.max(0, summary.failed - summary.outgoingFailed)
  if (summary.retryable > 0) {
    const visibleFailures = items.filter((item) => item.status === 'failed' && item.direction === 'outgoing')
    const firstDestination = visibleFailures[0]?.webhookName.split('／')[0]?.trim()
    const sameDestination = firstDestination
      && visibleFailures.length > 0
      && visibleFailures.every((item) => item.webhookName.startsWith(firstDestination))
    parts.push(sameDestination
      ? `すべて${firstDestination}へ。うち${summary.retryable}件はここから送り直せます`
      : `うち${summary.retryable}件はここから送り直せます`)
  } else if (summary.outgoingFailed > 0) {
    parts.push('ここからまとめて送り直せる失敗はありません。行ごとの理由を確かめてください')
  }
  const excluded = summary.outgoingFailed - summary.retryable
  if (excluded > 0) {
    parts.push(`${excluded}件は送り先の停止・削除・自動の送り直し中などで対象外です`)
  }
  if (summary.resultUnknown > 0) {
    parts.push(`うち${summary.resultUnknown}件は届いたか分からないため、相手先で確かめてからやり直します`)
  }
  if (incomingFailed > 0) {
    parts.push(`受け取りの失敗${incomingFailed}件は相手側で送り直してもらってください`)
  }
  return parts.join('。') || '失敗はありません'
}

/**
 * 遅れと成功率の対象期間をカードの補足へ書く(IDEA-26)。
 * 「いつからいつまでの数字か」が分からないと、遅い・悪いの判断が付かない。
 */
function durationDetail(
  items: WebhookInteraction[],
  averageDurationMs: number | null,
  periodDays: number,
): string {
  if (averageDurationMs == null) return `この${periodDays}日は未取得`
  const durations = items.flatMap((item) => item.durationMs == null ? [] : [item.durationMs])
  if (durations.length === 0) return `この${periodDays}日の送受信の処理時間`
  return `この${periodDays}日でいちばん遅くて ${Math.round(Math.max(...durations) / 100) / 10}秒`
}

export default function WebhooksInteractionsV8() {
  usePageTitle('外部連携')
  usePageCrumbs([{ label: 'ホーム', href: '/' }])
  const { selectedAccountId, accounts } = useAccount()
  const accountRef = useRef(selectedAccountId)
  accountRef.current = selectedAccountId
  const accountScopeRef = useRef({ accountId: selectedAccountId })
  if (accountScopeRef.current.accountId !== selectedAccountId) accountScopeRef.current = { accountId: selectedAccountId }
  const generationRef = useRef(0)
  const staffRole = useStaffRole()
  /* 送り直しは統括と管理者（管理画面 と同じ）。確認が終わるまでは出す。 */
  const canRetry = canManageRole(staffRole)
  const isOwner = staffRole === 'owner'
  const overview = useWebhookOverview()

  const [data, setData] = useState<WebhookInteractionList>(EMPTY)
  const [loadedAccountId, setLoadedAccountId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [search, setSearch] = useListUrlValue('q', '')
  const [direction, setDirection] = useState<Direction>('all')
  const [status, setStatus] = useState<Status>('all')
  const [periodDays, setPeriodDays] = useState(30)
  const [page, setPage] = useListUrlValue('page', 1)
  const [limit, setLimit] = useState(20)
  const [selected, setSelected] = useState<WebhookInteraction | null>(null)
  const [techOpen, setTechOpen] = useState(false)
  const [retrying, setRetrying] = useState<string | null>(null)
  const [bulkRetrying, setBulkRetrying] = useState(false)
  const [notice, setNotice] = useState('')
  const [confirmingRetry, setConfirmingRetry] = useState<{ item: WebhookInteraction; accountId: string; scope: object } | null>(null)

  const load = useCallback(async () => {
    const accountId = selectedAccountId
    const generation = ++generationRef.current
    setData(EMPTY)
    setLoadedAccountId(null)
    setSelected(null)
    setTechOpen(false)
    setRetrying(null)
    setBulkRetrying(false)
    setConfirmingRetry(null)
    setRetryCheckRequired(false)
    if (!accountId) {
      setLoading(false)
      setError(false)
      return
    }
    setLoading(true)
    setError(false)
    try {
      const response = await api.webhooks.interactions.list(accountId, {
        periodDays,
        direction: direction === 'all' ? undefined : direction,
        status: status === 'all' ? undefined : status,
        search: search || undefined,
        page,
        limit,
      })
      if (!response.success) throw new Error(response.error)
      if (generationRef.current !== generation || accountRef.current !== accountId) return
      setData(response.data)
      setLoadedAccountId(accountId)
    } catch {
      if (generationRef.current !== generation || accountRef.current !== accountId) return
      setData(EMPTY)
      setLoadedAccountId(accountId)
      setError(true)
    } finally {
      if (generationRef.current === generation && accountRef.current === accountId) setLoading(false)
    }
  }, [selectedAccountId, periodDays, direction, status, search, page, limit])

  useEffect(() => { setNotice(''); void load() }, [load])

  const pageCount = Math.max(1, Math.ceil(data.total / data.limit))
  const rangeFirst = data.total === 0 ? 0 : (data.page - 1) * data.limit + 1
  const rangeLast = data.total === 0 ? 0 : Math.min(data.total, rangeFirst + data.items.length - 1)

  const [retryCheckRequired, setRetryCheckRequired] = useState(false)
  const retry = async (item: WebhookInteraction, confirmed = false, target?: { accountId: string; scope: object }) => {
    const accountId = target?.accountId ?? selectedAccountId
    const scope = target?.scope ?? accountScopeRef.current
    if (!accountId || accountRef.current !== accountId || loadedAccountId !== accountId || accountScopeRef.current !== scope) return
    if (!item.confirmationRevision || !item.webhookRevision) { setNotice('送り直しを受け付けられませんでした。状態を読み直してからお試しください。'); return false }
    setRetrying(item.id)
    setNotice('')
    try {
      const response = await api.webhooks.interactions.retry(item.id, accountId, { confirmed, interactionRevision: item.confirmationRevision, webhookRevision: item.webhookRevision })
      if (accountRef.current !== accountId || accountScopeRef.current !== scope) return
      if (!response.success) throw new Error(response.error)
      if (response.data.status === 'succeeded') notifyToast(`「${item.webhookName}」へもう一度送り、届いたことを確認しました。`)
      else setNotice(`「${item.webhookName}」へ送り直しましたが、まだ届きませんでした。`)
      setConfirmingRetry(null)
      void load()
      return true
    } catch (err) {
      if (accountRef.current !== accountId || accountScopeRef.current !== scope) return
      if (err instanceof ApiError && err.code === 'result_unknown_needs_check') { setConfirmingRetry({ item, accountId, scope }); setNotice('届いたかどうか確認できませんでした。相手先の記録を確認してください。') }
      else if (err instanceof ApiError && err.code === 'webhook_not_found') { setNotice('送り先は削除されています。一覧の表示を最新にしました。'); void load() }
      else if (err instanceof ApiError && err.code === 'auto_retry_scheduled') setNotice('この知らせは自動での送り直しが予定されています。しばらく待っても届かない場合は、連携先の設定を確かめてください。')
      else if (err instanceof ApiError && err.code === 'already_delivered') { setNotice('この知らせは自動の送り直しで届いています。一覧の表示を最新にしました。'); void load() }
      else if (err instanceof ApiError && err.code === 'webhook_inactive') setNotice('送り先が止められています。送る一覧で動かしてからやり直してください。')
      else if (err instanceof ApiError && err.status === 503) setNotice('署名に使う合言葉を確認できないため、まだ送っていません。連携の設定を保存し直してからやり直してください。')
      else setNotice('送り直しを受け付けられませんでした。状態を読み直してからお試しください。')
      // Never bypass an unknown-result check, a scheduled retry, or a stale target with the retry button.
      setRetryCheckRequired(confirmed && (!(err instanceof ApiError) || err.status !== 503))
      return false
    } finally {
      if (accountRef.current === accountId && accountScopeRef.current === scope) setRetrying(null)
    }
  }

  const retryFailed = async () => {
    const accountId = selectedAccountId
    if (!accountId || loadedAccountId !== accountId) return
    setBulkRetrying(true)
    setNotice('')
    try {
      const response = await api.webhooks.interactions.retryFailed(accountId)
      if (accountRef.current !== accountId) return
      if (!response.success) throw new Error(response.error)
      const d = response.data
      const remainingNote = d.remaining > 0 ? `まだ失敗のまま残っているものが${formatNumber(d.remaining)} 件あります。もう一度押すと続きをやり直します。` : ''
      const reviewNote = d.needsReview > 0 ? `届いたか分からないものが${d.needsReview} 件あります。相手先の記録で同じ処理がないか確かめてから、一覧で1件ずつやり直してください。` : ''
      const excludedNote = d.excluded > 0 ? `送り先が消えた・止まっている・自動の送り直し中などで、対象外のものが${d.excluded} 件あります。` : ''
      const message = `${d.requested} 件を確認し、${formatNumber(d.succeeded)} 件が届きました。届かなかったもの ${formatNumber(d.failed)} 件、対象外 ${formatNumber(d.skipped)} 件です。${remainingNote}${reviewNote}${excludedNote}`
      if (d.failed > 0 || d.skipped > 0 || d.remaining > 0 || d.needsReview > 0 || d.excluded > 0) setNotice(message)
      else notifyToast(message)
      await load()
    } catch {
      if (accountRef.current !== accountId) return
      setNotice('まとめて送り直せませんでした。状態を読み直してからお試しください。')
    } finally {
      if (accountRef.current === accountId) setBulkRetrying(false)
    }
  }

  const openDetail = (item: WebhookInteraction) => withViewTransition(() => { setSelected(item); setTechOpen(false) })

  const summary = data.summary
  const loaded = loadedAccountId === selectedAccountId && !error && Boolean(selectedAccountId)
  const known = loaded ? summary : null
  const bandCells: BandCell[] = [
    {
      // 数の帯の題はタブをまたいで「直近30日 送った」にそろえる。期間を変えたらその日数で出す。
      key: 'sent', title: `直近${periodDays}日 送った`, icon: <History size={16} aria-hidden="true" />,
      value: known ? known.outgoing : null, unit: '回',
      detail: known ? `成功 ${formatNumber(Math.max(0, known.outgoing - known.outgoingFailed))}` : '集計を読み込めませんでした',
    },
    {
      key: 'received', title: '受け取った', icon: <Inbox size={16} aria-hidden="true" />,
      value: known ? known.incoming : null, unit: '回',
      detail: known ? `成功 ${formatNumber(Math.max(0, known.incoming - (known.failed - known.outgoingFailed)))}` : '集計を読み込めませんでした',
    },
    {
      key: 'failed', title: '失敗', icon: <TriangleAlert size={16} aria-hidden="true" />,
      value: known ? known.failed : null, unit: '件',
      detail: known ? <span title={failureDetail(data.items, summary)}>{`やり直せるもの ${formatNumber(known.retryable)}`}</span> : '集計を読み込めませんでした',
    },
    {
      key: 'all', title: 'すべて', icon: <LayoutList size={16} aria-hidden="true" />,
      value: known ? known.total : null, unit: '回',
      detail: known ? <span title={`この${periodDays}日で ${formatNumber(known.total > 0 ? Math.round(known.succeeded / known.total * 1000) / 10 : 0)}%成功。平均 ${seconds(known.averageDurationMs)}。${durationDetail(data.items, known.averageDurationMs, periodDays)}`}>{`この${periodDays}日`}</span> : '集計を読み込めませんでした',
    },
  ]

  /* 絞り込みの札は文字と数だけ（意味のない印は付けない・絵 ）。 */
  const chip = (label: string, count: number, current: boolean, select: () => void) => ({ label, count: loaded ? count : undefined, current, onClick: () => { select(); setPage(1) } })
  const chips = (
    <Tabs size="compact" wrap label="向きと結果で絞り込む" items={[
      chip('すべて', summary.total, direction === 'all' && status === 'all', () => { setDirection('all'); setStatus('all') }),
      chip('送った', summary.outgoing, direction === 'outgoing' && status === 'all', () => { setDirection('outgoing'); setStatus('all') }),
      chip('受け取った', summary.incoming, direction === 'incoming' && status === 'all', () => { setDirection('incoming'); setStatus('all') }),
      chip('失敗', summary.failed, status === 'failed', () => { setDirection('all'); setStatus('failed') }),
    ]} />
  )
  /* 期間は絵に無い。消さずに、道具の段の右の空いた所へ小さく置く（件数はページ送りの段へ）。 */
  const trailing = (
    <>
      <div className={styles.smallSelect}>
        <SaveErrorField names={["periodDays","period_days"]}><Select
          aria-label="期間"
          value={String(periodDays)}
          onChange={(value) => { setPeriodDays(Number(value)); setPage(1) }}
          options={[{ value: '7', label: 'この7日' }, { value: '30', label: 'この30日' }, { value: '90', label: 'この90日' }]}
        /></SaveErrorField>
      </div>
      <SaveErrorField names={["limit"]}><PageSizeSelect value={limit} onChange={(value) => { setLimit(value); setPage(1) }} label={null} /></SaveErrorField>
      {/* 閲覧のみには押せない「まとめてやり直す」を置かない。 */}
      {canRetry ? (
        <Button
          variant="primary"
          onClick={() => void retryFailed()}
          disabled={loading || bulkRetrying || summary.retryable === 0}
          title={summary.retryable === 0 ? '今ここから送り直せる失敗はありません' : undefined}
          busy={bulkRetrying}
          busyLabel="失敗したものを確認中"
        >
          <RefreshCw size={16} aria-hidden="true" />失敗したものをまとめてやり直す
        </Button>
      ) : null}
    </>
  )

  let listBody
  if (!selectedAccountId) {
    listBody = <AccountRequiredState hasAccounts={accounts.length > 0} />
  } else if (loading && data.items.length === 0) {
    listBody = (
      <div aria-busy="true" aria-label="やり取りの記録を読み込んでいます">
        <DelayedSkeleton
          loading
          skeleton={(
            <div aria-hidden="true">
              {[0, 1, 2, 3].map((row) => (
                <div key={row} className={styles.skeletonRow}>
                  <Skeleton className={styles.skeletonDot} />
                  <Skeleton className={styles.skeletonBar} />
                  <Skeleton className={styles.skeletonBar} />
                  <Skeleton className={styles.skeletonBar} />
                </div>
              ))}
            </div>
          )}
        />
      </div>
    )
  } else if (error) {
    listBody = (
      <ListState
        kind="error"
        title="やり取りの記録を表示できませんでした"
        description="記録は消えていません。通信の状態を確認して、もう一度お試しください。"
        onRetry={() => void load()}
      />
    )
  } else if (data.items.length === 0) {
    listBody = <ListState kind="empty" emptyPreset={search || direction !== 'all' || status !== 'all' || periodDays !== 30 ? 'filtered' : 'readonly'} title="条件に合うやり取りはありません" description="期間や絞り込みを変えて確認してください。" action={search || direction !== 'all' || status !== 'all' || periodDays !== 30 ? <Button onClick={() => { setSearch(''); setDirection('all'); setStatus('all'); setPeriodDays(30); setPage(1) }}>条件を外す</Button> : undefined} />
  } else {
    listBody = (
      <div className={styles.tableWrap}>
        <DataTable columnLayout={{ headHeight: 'var(--tpl-wh-head-h)', rowHeight: 'var(--tpl-wh-log-row-h)', gap: 'var(--tpl-wh-col-gap)', padding: 'var(--tpl-wh-row-pad)', numberInset: 'var(--tpl-wh-num-pad-end)' }}>
          <thead>
            <TableHeadRow data-table-layout="columns">
              <Th className={styles.colWhen}>いつ・どちら向き</Th>
              <Th grow className={styles.colName}>つなぎ先</Th>
              <Th className={styles.colBody}>送った・届いた中身</Th>
              <Th className={styles.colReply}>返事</Th>
              <Th align="right" className={styles.colTime}>かかった時間</Th>
              <Th className={styles.colOps}>操作</Th>
            </TableHeadRow>
          </thead>
          <tbody>
            {data.items.map((item) => {
              const reply = replyLabel(item)
              const lines = bodyLines(item)
              return (
                <Tr key={item.id} data-table-layout="columns" data-row-id={item.id}>
                  <Td className={styles.colWhen}>
                    <time dateTime={item.startedAt} className={styles.main}>{shortDateTime(item.startedAt)}</time>
                    <span className={styles.sub}>{item.direction === 'outgoing' ? '送る' : '受け取る'}</span>
                  </Td>
                  <Td grow className={styles.colName}><FolderDotName>
                    <span className={styles.main} title={`${item.webhookName}（${triggerWord(item)}）`}>{item.webhookName}</span>
                  </FolderDotName></Td>
                  <Td className={styles.colBody}>
                    <span className={styles.main} title={item.triggerSummary}>{lines.main}</span>
                    {lines.sub ? <span className={styles.sub} title={lines.sub}>{lines.sub}</span> : null}
                  </Td>
                  <Td className={styles.colReply}>
                    <StatusBadge tone={reply.tone}>{reply.text}</StatusBadge>
                  </Td>
                  <Td align="right" className={styles.colTime}><span className={styles.main}>{seconds(item.durationMs)}</span></Td>
                  <ActionCell className={styles.colOps}>
                    <RowMenu
                      label={`「${item.webhookName}」の操作`}
                      title="操作"
                      items={[{ id: 'view', label: '中身を見る', onSelect: () => openDetail(item) }]}
                    />
                  </ActionCell>
                </Tr>
              )
            })}
          </tbody>
        </DataTable>
      </div>
    )
  }

  const pager = loaded && data.total > 0 ? (
    <ListPagePagination>
      <Pagination page={data.page} pageCount={pageCount} onPageChange={setPage} ariaLabel="やり取りの記録のページ送り" range={{ total: data.total, first: rangeFirst, last: rangeLast }} />
    </ListPagePagination>
  ) : null

  return (
    <ListPage
      help={<>{WEBHOOKS_DESCRIPTION}{"行の「…」の「中身を見る」から 送った中身と返事・もう一度送る（失敗のとき）。"}</>}
      explanation="失敗したものは「もう一度送る」でやり直せます。相手が止まっていたときは、自動で3回までやり直します。"
      boardId="Uv9AA"
      headingSize="regular"
      title="外部連携"

      tabs={<WebhookTabs active="interactions" outgoingCount={overview.outgoingCount} incomingCount={overview.incomingCount} />}
      stats={<>
        {!isOwner && !canRetry ? <ViewerBand /> : null}
        <WebhookBand cells={bandCells} />
      </>}
      toolbar={<>

        {notice ? <div className={styles.noticeRow}><Notice tone="danger" message={notice} onClose={() => setNotice('')} /></div> : null}
        <ListToolbar preserveFilterChips
          search={{ placeholder: '送り先・友だちで探す', label: '送り先・友だちで探す', width: 240, value: search, onChange: (value) => { setSearch(value); setPage(1) } }}
          filters={chips}
          trailing={trailing}
        />
      </>}
      pagination={pager}
      overlays={<>
        {selected ? (
          <InteractionDialog
            item={selected}
            techOpen={techOpen}
            setTechOpen={setTechOpen}
            canRetry={canRetry}
            retrying={retrying === selected.id}
            busy={retrying !== null}
            onClose={() => setSelected(null)}
            onRetry={() => {
              if (selected.failureReasonCode === 'unknown' && selectedAccountId && loadedAccountId === selectedAccountId) { setNotice(''); setRetryCheckRequired(false); setConfirmingRetry({ item: selected, accountId: selectedAccountId, scope: accountScopeRef.current }) }
              else void retry(selected)
            }}
          />
        ) : null}
        <ConfirmDialog
          open={confirmingRetry !== null}
          title="届いたか確かめてから送り直します"
          description={confirmingRetry ? `「${confirmingRetry.item.webhookName}」へ届いたかどうか分かっていません。無条件に送り直すと、届いていた処理を二重に送ることがあります。相手先の記録で同じ処理がないか確かめましたか。` : ''}
          confirmLabel="確かめたので送り直す"
          cancelLabel="まだ確かめていない"
          busy={retrying === confirmingRetry?.item.id}
          error={notice || undefined} confirmDisabled={retryCheckRequired} confirmDisabledReason="閉じて相手先の記録と最新の状態を確認してください。" onSuccess={() => setConfirmingRetry(null)} onConfirm={() => confirmingRetry ? retry(confirmingRetry.item, true, confirmingRetry) : undefined}
          onCancel={() => { setConfirmingRetry(null); setRetryCheckRequired(false) }}
        >
          {confirmingRetry ? <OperationTargetSummary accounts={[{ id: confirmingRetry.accountId }]} /> : null}
        </ConfirmDialog>
      </>}
    >
      {listBody}

    </ListPage>
  )
}

/** 窓のきっかけ：「予約が入った・Masato S.」→「予約が入った（Masato S.）」。文が無ければ種類の言葉。 */
/* JSON で見せる記録。きっかけの文はお客さまの名前が入ることがあるので写さない。 */
function jsonRecord(item: WebhookInteraction): Partial<WebhookInteraction> {
  const record: Partial<WebhookInteraction> = { ...item }
  delete record.triggerSummary
  return record
}

function dialogTrigger(item: WebhookInteraction): string {
  const [head, ...rest] = item.triggerSummary.split('・')
  if (!head) return triggerWord(item)
  return rest.length > 0 ? `${head}（${rest.join('・')}）` : head
}

/*
 * やり取りの中身の窓（絵 ：幅680・上から110・題 18/700 と状態の札・1行の説明・
 * 8行の項目・送った・届いた中身・伏せている旨・下の段 技術的な記録／閉じる／送り直す）。
 * 送受信本文・URL・鍵は取得せず、表示用の記録だけを出す。
 */
function InteractionDialog({ item, techOpen, setTechOpen, canRetry, retrying, busy, onClose, onRetry }: {
  item: WebhookInteraction
  techOpen: boolean
  setTechOpen: (open: boolean) => void
  canRetry: boolean
  retrying: boolean
  busy: boolean
  onClose: () => void
  onRetry: () => void
}) {
  const retryable = canRetryNow(item, canRetry)
  const state = interactionState(item)
  const why = retryabilityText(item, canRetry)
  /* 送り直せるふつうの失敗は札だけ（説明は札の title）。それ以外は理由を札の横に出す。 */
  const showWhy = !(retryable && !item.failureReasonCode?.match(/^(unknown|secret_unavailable)$/))
  return (
    <Dialog
      open
      title="やり取りの中身"
      titleHelp={<StatusBadge tone={state.tone}>{state.label}</StatusBadge>}
      description={`${shortDateTime(item.startedAt)}・${item.direction === 'outgoing' ? '送った' : '受け取った'}・${item.webhookName}`}
      designNode="DA0Ag"
      designWidth={680}
      designTop={110}
      designHeaderPadding="24px 24px 0"
      busy={busy}
      onCancel={onClose}
      footer={
        <DialogActions leadingAction={<Button onClick={() => setTechOpen(!techOpen)}>
            <FileCode size={16} aria-hidden="true" />{techOpen ? '技術的な記録を閉じる' : '技術的な記録を開く'}
          </Button>}>


          <Button onClick={onClose} disabled={busy}>閉じる</Button>
          {retryable ? (<Button variant="primary" onClick={onRetry} busy={retrying} busyLabel="やり直し中">
              <RotateCw size={16} aria-hidden="true" />届いたか確かめてから送り直す
            </Button>) : null}
        </DialogActions>
      }
    >
      <div className={styles.dialogBody}>
        <LogEntryCopy canCopy={canRetry} entry={{ occurredAt: item.startedAt, target: item.webhookName, status: state.label, reason: item.failureReason ?? item.responseLabel }} />
        <dl className={styles.dialogList}>
          <div className={styles.dialogRow}><dt>きっかけ</dt><dd>{dialogTrigger(item)}</dd></div>
          <div className={styles.dialogRow}><dt>出来事の種類</dt><dd>{item.eventType}</dd></div>
          <div className={styles.dialogRow}><dt>返事</dt><dd>{item.responseLabel}{item.responseStatus !== null ? `（相手の応答番号 ${item.responseStatus}）` : ''}</dd></div>
          {item.failureReason ? <div className={styles.dialogRow}><dt>失敗した理由</dt><dd className={styles.danger}>{item.failureReason}</dd></div> : null}
          <div className={styles.dialogRow}><dt>試した回数</dt><dd>{`${item.attemptCount} 回（1分・5分・30分あけて）`}</dd></div>
          <div className={styles.dialogRow}><dt>かかった時間</dt><dd>{item.durationMs == null ? emptyValue('unknown') : `返事まで ${seconds(item.durationMs)}`}</dd></div>
          <div className={styles.dialogRow}><dt>記録の番号</dt><dd>{item.id}</dd></div>
          {techOpen ? (
            <>
              <div className={styles.dialogRow}><dt>状態の記号</dt><dd>{item.status}</dd></div>
              <div className={styles.dialogRow}><dt>やり直し元の記録</dt><dd>{item.retryOfId ?? emptyValue('unknown')}</dd></div>
            </>
          ) : null}
          <div className={`${styles.dialogRow} ${styles.dialogRowPill}`}>
            <dt>やり直せるか</dt>
            <dd>
              <StatusBadge tone={retryable ? 'success' : 'neutral'} title={why}>{retryable ? 'やり直せる' : 'やり直せない'}</StatusBadge>
              {showWhy ? <span className={styles.dialogWhy}>{why}</span> : null}
            </dd>
          </div>
        </dl>
        {techOpen ? <div className={styles.dialogJson}><LogRecordJson value={jsonRecord(item)} label="この記録" canCopy={canRetry} /></div> : null}
        <p className={styles.dialogNote}>接続先URL、秘密値、送受信の本文は、この記録には表示しません。</p>
      </div>
    </Dialog>
  )
}
