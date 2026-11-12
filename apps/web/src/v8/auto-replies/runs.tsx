'use client'

import { isConflictResponse } from '@/components/shared/save-conflict'
import Card from '@/components/shared/card'
import LogEntryDetails, { type LogEntryFacts } from '@/components/shared/log-entry-details'
import { CreateSummaryCard } from '@/components/templates/create-parts'
import { DashboardColumns } from '@/components/templates/dashboard-page'
import PageSizeSelect from '@/components/shared/page-size-select'
import { ListToolbarFrame, ListToolbarRow } from '@/components/shared/list-toolbar'

import { jstMonthStart, jstDateOffset } from '@/lib/jst-datetime'


import ListDateTime from '@/components/shared/list-date-time'
import SegmentedControl from '@/components/shared/segmented'
import { RowNameLink } from '@/components/shared/table';
import { useListUrlValue } from '@/components/shared/list-url-state';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, MessageSquare, Users, Timer, Download, MessageCircle, Pause, Pencil, RotateCcw } from 'lucide-react';
import Link from '@/components/shared/list-navigation'

import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation';
import { TriangleAlert } from 'lucide-react';
import { withHonorific, type AutoReplyRun, type AutoReplyRunsResponse, type ExecutionRunStatus } from '@line-crm/shared';
import { DetailPage } from '@/components/templates';
import { usePageTitle } from '@/components/shell/page-chrome';
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { type ActionMenuItem } from '@/components/shared/action-menu';
import { RowMenu } from '@/components/shared/row-actions';
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import Pagination from '@/components/shared/pagination'
import SearchField from '@/components/shared/search-field'
import Select from '@/components/shared/select'
import DateField from '@/components/shared/date-field'
import StatusBadge, { type StatusBadgeTone } from '@/components/shared/status-badge';
import { DataTable, TableHeadRow, Th, Tr, Td, PersonCell, ActionCell } from '@/components/shared/table';
import { api, ApiError } from '@/lib/api';
import { canManageRole, useStaffRole } from '@/lib/staff-role';
import { effectiveStaffRole, readStaffIdentity } from '@/lib/staff-identity-state'
import { lockReason } from '@/components/shared/permission-lock'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import { formatDateTime, formatNumber, formatListDateTime as polishFormatListDateTime } from '@/lib/format';
import styles from './runs.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { permissionDeniedMessage } from '@/components/shared/api-error-message';
import { csvFileName } from '@/lib/csv-file-name';
import { emptyValue } from '@/components/shared/empty-value';
import { SaveErrorField } from '@/components/shared/save-form-errors';
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import Notice from '@/components/shared/notice'
import { DeliveryUnconfirmedBadge, DeliveryUnconfirmedNotice, DELIVERY_UNCONFIRMED_REASON } from '@/components/shared/delivery-unconfirmed'
import { TextField as SharedTextField } from '@/components/shared/text-field'

/*
 * ★V8 自動応答の実行結果（Pencil ）。
 *
 * 型は詳細（DetailPage）：頭（戻る・題・説明・右に3つの操作）→ 数の帯（4つ）→
 * 失敗の帯 → 実行の記録（道具の段・表・ページ送り）→ 言葉ごとの数と引き継ぎ。
 * 取得・操作の動き（読み直し・一時停止・再実行・CSV）は `app/auto-replies/runs/runs-v8.tsx`
 * から写した（import はしない）。動きの一覧は BEHAVIOR.md の「実行結果」。
 */

/* 再実行・一時停止は owner/admin だけ（R530・再実行POST・停止口の requireRole と同じ境目）。 */
const NO_RETRY_PERMISSION = permissionDeniedMessage('store')

function canManageRunsNow(): boolean {
  return canManageRole(effectiveStaffRole(readStaffIdentity())) && !lockReason(true, 'manager')
}

/* 絵の札の言葉（成功・確認待ち・失敗・見送り）。表に無い状態は「確認中」で出す（白い画面にしない）。 */
const STATUS: Record<ExecutionRunStatus, { label: string; tone: StatusBadgeTone }> = {
  succeeded: { label: '成功', tone: 'success' },
  failed: { label: '失敗', tone: 'danger' },
  partial: { label: '一部だけ完了', tone: 'warning' },
  skipped: { label: '見送り', tone: 'neutral' },
  pending: { label: '確認待ち', tone: 'warning' },
  cancelled: { label: '取り消し', tone: 'neutral' },
  claimed: { label: '処理中', tone: 'warning' },
  permanent_failed: { label: '失敗', tone: 'danger' },
}

export function statusView(status: string): { label: string; tone: StatusBadgeTone } {
  return (STATUS as Record<string, { label: string; tone: StatusBadgeTone }>)[status]
    ?? { label: '確認中', tone: 'neutral' }
}

export function isDeliveryUnconfirmed(run: AutoReplyRun): boolean {
  return run.errorCode === 'delayed_delivery_unknown'
}

export function actionLabel(run: AutoReplyRun): string {
  if (isDeliveryUnconfirmed(run)) return DELIVERY_UNCONFIRMED_REASON
  const summary = run.actionSummary
  const parts: string[] = []
  if (run.replyStatus === 'accepted') parts.push('返信')
  if ((summary.executed ?? 0) > 0) parts.push(`後続処理${summary.executed}件`)
  if ((summary.failed ?? 0) > 0) parts.push(`失敗${formatNumber(summary.failed)}件`)
  return parts.length > 0 ? parts.join('＋') : statusView(run.status).label
}

function csvCell(value: unknown): string {
  return `"${String(value ?? '').replaceAll('"', '""')}"`
}

function csvFor(items: AutoReplyRun[]): string {
  const rows = [
    ['日時', '友だち', 'LINEアカウント', '入力', 'きっかけ', '結果', '処理内容', 'かかった時間'],
    ...items.map((item) => [
      formatDateTime(item.occurredAt),
      item.friendName ?? '削除済みの友だち',
      item.accountLabel ?? emptyValue('unknown'),
      '本文は非表示',
      item.triggerLabel,
      isDeliveryUnconfirmed(item) ? '要確認' : statusView(item.status).label,
      actionLabel(item),
      item.durationMs === null ? emptyValue('unknown') : `${item.durationMs}ms`,
    ]),
  ]
  return `﻿${rows.map((row) => row.map(csvCell).join(',')).join('\n')}`
}

export type RunFilter = 'all' | 'failed' | 'pending' | 'skipped'

export function matchesFilter(item: AutoReplyRun, filter: RunFilter): boolean {
  switch (filter) {
    case 'failed':
      return item.status === 'failed' || item.status === 'permanent_failed' || item.status === 'partial'
    case 'pending':
      return item.status === 'pending'
    case 'skipped':
      return item.status === 'skipped' || item.status === 'cancelled'
    default:
      return true
  }
}

/* 期間（絵は「今月」）。決めた日は「日付で決める」で2つの日付欄を出す。 */
export type PeriodKey = 'month' | 'last7' | 'last30' | 'all' | 'custom'
const PERIOD_OPTIONS: Array<{ value: PeriodKey; label: string }> = [
  { value: 'month', label: '今月' },
  { value: 'last7', label: 'この7日' },
  { value: 'last30', label: 'この30日' },
  { value: 'all', label: 'すべての期間' },
  { value: 'custom', label: '日付で決める' },
]

/** 期間の境目は日本時間。端末のタイムゾーンに左右されない。 */
export function periodFrom(period: PeriodKey, now: Date): string | null {
  if (period === 'month') return jstMonthStart(now)
  if (period === 'last7') return jstDateOffset(-6, now)
  if (period === 'last30') return jstDateOffset(-29, now)
  return null
}





/** サーバー（auto-reply-runs）が決まった言葉で返す失敗の理由だけを出す。それ以外（生のエラー・顧客の本文）は出さない。 */
const SAFE_FAILURE_REASONS = new Set(['LINEへの返信を受け付けてもらえませんでした', '返信または一部の処理だけ完了しました', '自動応答を完了できませんでした'])
const safeFailureReason = (detail: string | null | undefined) => (detail && SAFE_FAILURE_REASONS.has(detail) ? detail : null)

export default function AutoReplyRunsV8() {
  const [logEntry, setLogEntry] = useState<LogEntryFacts | null>(null)
  const router = useRouter()
  const searchParams = useSearchParams()
  const requestedRuleId = searchParams.get('id') ?? ''
  const staffRole = useStaffRole()
  const canManage = canManageRole(staffRole)
  const manageReason = usePermissionLockReason(canManage, 'manager')
  const canChange = canManage && !manageReason
  const [period, setPeriod] = useListUrlValue<PeriodKey>('period', 'month')
  const [dateFrom, setDateFrom] = useListUrlValue('dateFrom', '')
  const [dateTo, setDateTo] = useListUrlValue('dateTo', '')
  const [pageSize, setPageSize] = useListUrlValue('pageSize', 20)
  const [data, setData] = useState<AutoReplyRunsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [page, setPage] = useListUrlValue('page', 1)
  const [filter, setFilter] = useListUrlValue<RunFilter>('filter', 'all')
  const [search, setSearch] = useListUrlValue('q', '')
  const [actionMessage, setActionMessage] = useState('')
  const [stopOpen, setStopOpen] = useState(false)
  const [stopAccount, setStopAccount] = useState<{ ruleId: string; accountId: string | null; version: number } | null>(null)
  const [stopReason, setStopReason] = useState('')
  const [stopping, setStopping] = useState(false)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [retryingAll, setRetryingAll] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [menuId, setMenuId] = useState<string | null>(null)
  const exportCancelledRef = useRef(false)
  const loadSeqRef = useRef(0)

  usePageTitle(data ? `${data.rule.name}・実行結果` : '自動応答・実行結果')

  useEffect(() => {
    setPage(1)
    setLogEntry(null)
    setData(null)
    setActionMessage('')
    setFilter('all')
    setSearch('')
  }, [requestedRuleId])

  /* 口へ渡す期間。決めた日のときだけ日付欄の値を使う。 */
  const range = useMemo(() => {
    if (period === 'custom') return { from: dateFrom || undefined, to: dateTo || undefined }
    return { from: periodFrom(period, new Date()) ?? undefined, to: undefined }
  }, [period, dateFrom, dateTo])

  const load = useCallback(async () => {
    const seq = loadSeqRef.current + 1
    loadSeqRef.current = seq
    setLoading(true)
    setError('')
    try {
      const response = await api.autoReplies.runs({
        from: range.from,
        to: range.to,
        ruleId: requestedRuleId || undefined,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      })
      if (loadSeqRef.current !== seq) return
      if (!response.success) throw new Error(response.error)
      if (!response.data?.rule || !Array.isArray(response.data.items)) {
        throw new Error('runs_shape')
      }
      if (requestedRuleId && (response.data.rule.id || '') !== requestedRuleId) return
      setData(response.data)
    } catch {
      if (loadSeqRef.current !== seq) return
      setData(null)
      setError('実行結果を読み込めませんでした。時間を置いてもう一度お試しください。')
    } finally {
      if (loadSeqRef.current === seq) setLoading(false)
    }
  }, [page, pageSize, requestedRuleId, range])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    const ruleId = data?.rule.id
    if (!stopOpen || !ruleId) return
    let active = true
    setStopAccount(null)
    void api.autoReplies.get(ruleId).then(response => {
      if (active && response.success && response.data.id === ruleId && (response.data.lineAccountId === null || typeof response.data.lineAccountId === 'string') && Number.isSafeInteger(response.data.confirmationRevision) && response.data.confirmationRevision >= 1) {
        setStopAccount({ ruleId, accountId: response.data.lineAccountId, version: response.data.confirmationRevision })
      }
    }).catch(() => {})
    return () => { active = false }
  }, [stopOpen, data?.rule.id])

  const total = data?.pagination.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / pageSize))

  const stopRule = async () => {
    if (!canManageRunsNow() || !data?.rule.id || stopping || !stopAccount || stopAccount.ruleId !== data.rule.id) return
    setStopping(true)
    setActionMessage('')
    try {
      const response = await api.autoReplies.stop(
        data.rule.id,
        { reason: stopReason.trim() || null, expectedVersion: stopAccount.version },
        crypto.randomUUID(),
      )
      if (!response.success) throw new Error(response.error)
      setStopOpen(false)
      setStopReason('')
      setActionMessage('自動応答を一時停止しました。')
      await load()
      return true
    } catch (caught) {
      if (isConflictResponse(caught) && caught.code === 'auto_reply_confirmation_conflict') {
        setStopAccount(null)
        await load()
        const latest = await api.autoReplies.get(data.rule.id).catch(() => null)
        if (latest?.success && latest.data.id === data.rule.id && Number.isSafeInteger(latest.data.confirmationRevision) && latest.data.confirmationRevision >= 1) {
          setStopAccount({ ruleId: data.rule.id, accountId: latest.data.lineAccountId, version: latest.data.confirmationRevision })
          setActionMessage('内容が変わりました。読み直した内容を確認してください。')
        } else setActionMessage('最新の内容を確認できませんでした。窓を閉じて読み直してください。')
        return false
      }
      setActionMessage('一時停止できませんでした。状態を読み直してからお試しください。')
      return false
    } finally {
      setStopping(false)
    }
  }

  const retryRun = async (item: AutoReplyRun) => {
    if (!canManageRunsNow() || isDeliveryUnconfirmed(item) || !item.canRetry || retryingId !== null || retryingAll) return
    setRetryingId(item.id)
    setActionMessage('')
    try {
      const response = await api.autoReplies.retryRun(item.id)
      if (!response.success) throw new Error(response.error)
      setActionMessage('失敗した処理をもう一度実行しました。')
      await load()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setActionMessage('すでに処理中または完了しています。最新の状態を読み直しました。')
        await load()
      } else if (e instanceof ApiError && e.status === 403) {
        setActionMessage(NO_RETRY_PERMISSION)
      } else {
        setActionMessage('失敗した処理をもう一度実行できませんでした。時間を置いてお試しください。')
      }
    } finally {
      setRetryingId(null)
    }
  }

  const items = data?.items ?? []

  /* 「失敗した処理をもう一度」：今のページでやり直せる失敗を順に実行する。 */
  const retryAllFailed = async () => {
    if (!canManageRunsNow()) return
    const targets = items.filter((item) => !isDeliveryUnconfirmed(item) && item.canRetry && matchesFilter(item, 'failed'))
    if (targets.length === 0 || retryingAll || retryingId !== null) return
    setRetryingAll(true)
    setActionMessage('')
    let retried = 0
    let denied = false
    let failed = 0
    for (const item of targets) {
      if (!canManageRunsNow()) { denied = true; break }
      try {
        const response = await api.autoReplies.retryRun(item.id)
        if (!response.success) throw new Error(response.error)
        retried += 1
      } catch (e) {
        if (e instanceof ApiError && e.status === 403) denied = true
        if (!(e instanceof ApiError && e.status === 409)) failed += 1
        /* 409（もう動いている・済み）などは飛ばして次へ。 */
      }
    }
    setRetryingAll(false)
    if (denied) {
      setActionMessage(NO_RETRY_PERMISSION)
      return
    }
    setActionMessage(
      failed > 0
        ? `${retried > 0 ? `失敗した処理を${retried} 件もう一度実行しました。` : ''}${formatNumber(failed)} 件をもう一度実行できませんでした。時間を置いてお試しください。`
        : retried > 0
        ? `失敗した処理を${retried} 件もう一度実行しました。`
        : 'もう一度実行できる処理はありませんでした。',
    )
    await load()
  }

  const MAX_CSV_ROWS = 5000
  const exportCsv = async () => {
    if (!readStaffIdentity() || exporting) return
    setExporting(true)
    exportCancelledRef.current = false
    setActionMessage('')
    try {
      const rows: AutoReplyRun[] = []
      let offset = 0
      let capped = false
      for (;;) {
        if (exportCancelledRef.current) throw new Error('csv_cancelled')
        const response = await api.autoReplies.runs({ ruleId: requestedRuleId || undefined, from: range.from, to: range.to, limit: 100, offset })
        if (!response.success) throw new Error(response.error)
        const room = MAX_CSV_ROWS - rows.length
        rows.push(...response.data.items.slice(0, room))
        offset += response.data.items.length
        if (rows.length % 1000 === 0 && rows.length > 0) {
          setActionMessage(`${formatNumber(rows.length)} 件読み込み中…`)
        }
        if (rows.length >= MAX_CSV_ROWS) {
          capped = offset < response.data.pagination.total || response.data.items.length > room
          break
        }
        if (offset >= response.data.pagination.total || response.data.items.length === 0) break
      }
      const url = URL.createObjectURL(new Blob([csvFor(rows)], { type: 'text/csv;charset=utf-8' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = csvFileName("自動応答の実行履歴")
      anchor.click()
      URL.revokeObjectURL(url)
      setActionMessage(
        capped
          ? `直近${formatNumber(MAX_CSV_ROWS)} 件まで書き出しました。全部要るときは期間を絞って分けてください。`
          : `${formatNumber(rows.length)} 件を書き出しました。`,
      )
    } catch (e) {
      if (e instanceof Error && e.message === 'csv_cancelled') {
        setActionMessage('書き出しを止めました。')
      } else {
        setActionMessage('CSVを書き出せませんでした。もう一度お試しください。')
      }
    } finally {
      setExporting(false)
    }
  }

  const failedCount = data?.summary.errors ?? 0
  const retryableFailed = items.filter((item) => !isDeliveryUnconfirmed(item) && item.canRetry && matchesFilter(item, 'failed')).length
  const query = search.trim().toLowerCase()
  const visibleItems = items.filter((item) => {
    if (!matchesFilter(item, filter)) return false
    if (!query) return true
    return [item.friendName, item.triggerLabel]
      .some((text) => (text ?? '').toLowerCase().includes(query))
  })
  const isActiveRule = data?.rule.isActive === true && data.rule.id

  /* この切り替えは今のページを絞る。引き継ぎ待ちの人数を実行待ちの件数に流用しない。 */
  const chipCounts: Record<RunFilter, number | null> = Object.fromEntries(
    (['all', 'failed', 'pending', 'skipped'] as const).map(key => [key, data ? items.filter(item => matchesFilter(item, key)).length : null]),
  ) as Record<RunFilter, number | null>
  const chips: Array<{ key: RunFilter; label: string }> = [
    { key: 'all', label: 'すべて' },
    { key: 'failed', label: '失敗' },
    { key: 'pending', label: '確認待ち' },
    { key: 'skipped', label: '見送り' },
  ]

  const rowMenuItems = (item: AutoReplyRun): ActionMenuItem[] => {
    const list: ActionMenuItem[] = [{ id: 'detail', label: '実行の詳細を見る', onSelect: () => setLogEntry({ occurredAt: item.occurredAt, target: item.friendName ?? '削除済みの友だち', status: isDeliveryUnconfirmed(item) ? '要確認' : statusView(item.status).label, reason: isDeliveryUnconfirmed(item) ? DELIVERY_UNCONFIRMED_REASON : matchesFilter(item, 'failed') ? (safeFailureReason(item.detail) ?? '処理を完了できませんでした。設定と相手先の状態を確認してください。') : statusView(item.status).label }) }]
    if (item.friendId) {
      list.push({
        id: 'chat',
        label: 'トークを開く',
        icon: <MessageCircle size={16} aria-hidden="true" />,
        external: false,
        href: `/chats?friend=${encodeURIComponent(item.friendId)}`, onSelect: () => { router.push(`/chats?friend=${encodeURIComponent(item.friendId)}`) },
      })
    }
    if (!isDeliveryUnconfirmed(item) && item.canRetry) {
      list.push({
        id: 'retry',
        label: 'もう一度実行',
        icon: <RotateCcw size={16} aria-hidden="true" />,
        lockedReason: manageReason,
        disabled: !canChange || retryingId !== null || retryingAll,
        onSelect: () => { void retryRun(item) },
      })
    }
    return list
  }

  const filteredEmpty = filter !== 'all' || Boolean(search.trim() || dateFrom || dateTo) || period !== 'month'
  const clearEmptyFilters = () => { setFilter('all'); setSearch(''); setPeriod('month'); setDateFrom(''); setDateTo(''); setPage(1) }

  return (
    <DetailPage
      boardId="nWmLg"
      title={`実行結果：${data?.rule.name ?? '自動応答'}`}
      help="いつ・誰に・何を返したか、失敗した処理を見ます。"
      identity={<></>}
      actions={<div className={styles.headActions}>
          <Button lockedReason={manageReason} onClick={() => { if (canManageRunsNow()) { setActionMessage(''); setStopAccount(null); setStopOpen(true) } }} disabled={!canChange || !isActiveRule || stopping}>
            <Pause size={16} aria-hidden="true" />一時停止する
          </Button>
        {data?.rule.id ? (
          <Button lockedReason={manageReason} {...(staffRole === null ? { disabled: true } : { href: `/auto-replies/edit?id=${encodeURIComponent(data.rule.id)}` })}>
            <Pencil size={16} aria-hidden="true" />ルールの編集へ
          </Button>
        ) : null}
        <Button onClick={() => void exportCsv()} disabled={staffRole === null || exporting || loading} busy={exporting} busyLabel="書き出しています">
          <Download size={16} aria-hidden="true" />CSVで書き出す
        </Button>
        {exporting ? (
          <Button onClick={() => { exportCancelledRef.current = true }}>書き出しを止める</Button>
        ) : null}
      </div>}
    >
      {staffRole !== null && !canChange ? (
        <div className={styles.viewerBand}><ReadOnlyNotice need="manager" role="status" /></div>
      ) : null}

      <div className={styles.kpis}>
      <KpiBand data-design="KPIs">
        <KpiCard presentation="band" icon={<MessageSquare size={16} aria-hidden="true" />} title="今月当たった" value={data ? data.summary.monthHits : null} unit="回"
          detail={`累計 ${data ? formatNumber(data.summary.totalHits) : emptyValue('unknown')}回`} />
        <KpiCard presentation="band" icon={<Users size={16} aria-hidden="true" />} title="担当者へ引き継ぎ" value={data ? data.summary.handovers : null} unit="件"
          detail={`確認待ち ${data ? formatNumber(data.handovers.waiting) : emptyValue('unknown')}件`} />
        <KpiCard presentation="band" icon={<TriangleAlert size={16} aria-hidden="true" />} title="失敗した処理" value={data ? failedCount : null} unit="件"
          detail={failedCount > 0 ? '理由と送信記録を確認してください' : '記録を開始してからの合計です'} />
        <KpiCard presentation="band" icon={<Timer size={16} aria-hidden="true" />} title="平均で返すまで"
          value={data?.summary.averageResponseMs == null ? null : Number((data.summary.averageResponseMs / 1000).toFixed(1))} unit="秒"
          detail={`最後に動いた ${data ? polishFormatListDateTime(data.summary.lastRunAt) : emptyValue('unknown')}`} />
      </KpiBand>
      </div>

      {items.some(isDeliveryUnconfirmed) ? <DeliveryUnconfirmedNotice action={<Button href="/chats">トークの送信記録を確認</Button>} /> : null}
      {failedCount > 0 ? (
        <Notice tone="danger" heading={<> {`失敗した処理が ${formatNumber(failedCount)} 件あります`} </>} action={<> <Button onClick={() => { setFilter('failed'); setPage(1) }}>失敗だけ見る</Button>{retryableFailed > 0 ? (
            <Button
              variant="primary"
              lockedReason={manageReason}
              onClick={() => void retryAllFailed()}
              disabled={!canChange || retryableFailed === 0 || retryingAll || retryingId !== null}
              busy={retryingAll}
              busyLabel="実行しています"
            >
              <RotateCcw size={16} aria-hidden="true" />失敗した処理をもう一度
            </Button>
          ) : null} </>} >止まった行の理由を確認してください。「要確認」の行は届いたか分からないため、送り直しません。</Notice>
      ) : null}

      <Card padding="none" aria-label="実行の記録">
        <ListToolbarFrame><ListToolbarRow>

            <SearchField
              placeholder="友だち・きっかけで探す"
              aria-label="友だち・きっかけで探す"
              value={search}
              onChange={(value) => setSearch(value)}
              onClear={() => setSearch('')}
            />

          <SegmentedControl aria-label="結果で絞り込む" value={filter} onChange={setFilter} options={chips.map(chip=>({value:chip.key,label:chip.label,count:chipCounts[chip.key] ?? undefined,ariaLabel:`${chip.label}${chipCounts[chip.key] === null ? '' : ` ${chipCounts[chip.key]}件`}（このページ）`}))} />

          {period === 'custom' ? (
            <>
              <SaveErrorField names={["dateFrom","from","date_from"]}><DateField value={dateFrom} onChange={(value) => { setDateFrom(value); setPage(1) }} max={dateTo || undefined} aria-label="実行日（開始）" /></SaveErrorField>
              <SaveErrorField names={["dateTo","to","date_to"]}><DateField value={dateTo} onChange={(value) => { setDateTo(value); setPage(1) }} min={dateFrom || undefined} aria-label="実行日（終了）" /></SaveErrorField>
            </>
          ) : null}

            <SaveErrorField names={["period"]}><Select
              aria-label="期間"
              value={period}
              onChange={(value) => { setPeriod(value as PeriodKey); setPage(1) }}
              options={PERIOD_OPTIONS}
            /></SaveErrorField>


            <SaveErrorField names={["pageSize","limit","page_size"]}><PageSizeSelect label={null} value={pageSize} onChange={(value) => { setPageSize(value); setPage(1) }} /></SaveErrorField>

        </ListToolbarRow></ListToolbarFrame>

        {loading ? (
          <ListState kind="loading" />
        ) : error ? (
          <ListState kind="error" description={error} onRetry={() => void load()} />
        ) : items.length === 0 ? (
          <ListState kind="empty" emptyPreset={filteredEmpty ? 'filtered' : 'readonly'} title={filteredEmpty ? '条件に合う記録はありません' : '実行結果はまだありません'} description={filteredEmpty ? undefined : '自動応答が動くと、ここに結果が残ります。'} action={filteredEmpty ? <Button onClick={clearEmptyFilters}>条件を外す</Button> : undefined} />
        ) : visibleItems.length === 0 ? (
          <ListState kind="empty" emptyPreset="filtered" title="条件に合う記録はありません" action={<Button onClick={clearEmptyFilters}>条件を外す</Button>} />
        ) : (
          <DataTable columnSizing="content" columnLayout={{ headHeight: 'var(--polish-table-head)', rowHeight: 'var(--polish-table-row)', gap: 'var(--polish-space-card)', padding: '0 var(--tpl-list-inset)', collapseScope: 'page' }}>
            <thead>
              <TableHeadRow data-table-layout="columns">
                <Th className={styles.colWhen}>日時</Th>
                <Th className={styles.colFriend}>友だち</Th>
                <Th className={styles.colInput}>きっかけ</Th>
                <Th className={styles.colResult}>結果</Th>
                <Th grow className={styles.colDone}>行ったこと</Th>
                <Th collapseAt="narrow" className={styles.colTime}>時間</Th>
                <Th className={styles.colMenu}><span className="sr-only">操作</span></Th>
              </TableHeadRow>
            </thead>
            <tbody>
              {visibleItems.map((item) => {
                const view = statusView(item.status)
                const failed = matchesFilter(item, 'failed')
                const done = isDeliveryUnconfirmed(item) ? DELIVERY_UNCONFIRMED_REASON : failed ? safeFailureReason(item.detail) ?? '処理を完了できませんでした' : actionLabel(item)
                const name = item.friendName ?? '削除済みの友だち'
                const menuItems = rowMenuItems(item)
                return (
                  <Tr key={item.id} data-table-layout="columns" href={`/friends/detail?id=${encodeURIComponent(item.friendId)}`}>
                    <Td className={styles.colWhen}>
                      <time dateTime={item.occurredAt}><ListDateTime value={item.occurredAt} /></time>
                    </Td>
                    <PersonCell className={styles.colFriend} avatarName={item.friendName} name={item.friendId ? (
                      <RowNameLink href={`/friends/detail?id=${encodeURIComponent(item.friendId)}`}><TruncatedText value={name} /></RowNameLink>
                    ) : <TruncatedText value={name} />} />
                    <Td className={styles.colInput}>
                      <TruncatedText value={item.triggerLabel} />
                    </Td>
                    <Td className={styles.colResult}>{isDeliveryUnconfirmed(item) ? <DeliveryUnconfirmedBadge /> : <StatusBadge tone={view.tone} size="compact">{view.label}</StatusBadge>}</Td>
                    <Td grow className={styles.colDone}><TruncatedText value={done} /></Td>
                    <Td collapseAt="narrow" className={styles.colTime}>
                      <span className={styles.time}>{item.durationMs === null ? emptyValue('unknown') : `${(item.durationMs / 1000).toFixed(1)}秒`}</span>
                    </Td>
                    <ActionCell>
                      {menuItems.length > 0 ? (
                        <div className={styles.menuBox}>
                          <RowMenu
                            size="row" label={`${withHonorific(name)}の記録の操作`}
                            items={menuItems}
                            open={menuId === item.id}
                            onOpenChange={(next) => setMenuId(next ? item.id : null)}
                          />
                        </div>
                      ) : null}
                    </ActionCell>
                  </Tr>
                )
              })}
            </tbody>
          </DataTable>
        )}
        {!loading && !error && items.length > 0 ? (
          <div className={styles.pager}>
            <Pagination
              page={page}
              pageCount={pageCount}
              onPageChange={setPage}
              disabled={loading}
              range={{ total, first: (page - 1) * pageSize + 1, last: Math.min(page * pageSize, total) }}
            />
          </div>
        ) : null}
      </Card>

      <DashboardColumns layout="cards">{[
        <CreateSummaryCard key="triggers" title="言葉ごとの当たった回数" variant="record" rows={data ? data.triggerBreakdown.map(item => ({ key: item.trigger, label: item.trigger, value: `${formatNumber(item.count)} 回${item.share === null ? '' : `（${(item.share * 100).toFixed(1)}%）`}` })) : []}>
          {loading ? <ListState kind="loading" /> : !data || data.triggerBreakdown.length === 0 ? <ListState kind="empty" title="内訳はまだありません" description="実行結果がたまると、きっかけごとの件数が分かります。" /> : null}
        </CreateSummaryCard>,
        <CreateSummaryCard key="handovers" title="担当者への引き継ぎ" variant="record" rows={[
          { label: '確認待ち', value: data ? `${formatNumber(data.handovers.waiting)}件` : emptyValue('unknown') },
          { label: '対応中', value: data ? `${formatNumber(data.handovers.inProgress)}件` : emptyValue('unknown') },
          { label: '完了', value: data ? `${formatNumber(data.handovers.completed)}件` : emptyValue('unknown') },
        ]}><Button variant="text" href="/chats">受信箱で見る</Button></CreateSummaryCard>
      ]}</DashboardColumns>

      {actionMessage ? <p className={styles.hint} role="status">{actionMessage}</p> : null}

      <LogEntryDetails canCopy={canManage} entry={logEntry} onClose={() => setLogEntry(null)} />
      <ConfirmDialog
        open={stopOpen && canChange}
        title="この自動応答を止めますか？"
        description="止めると、条件に合うメッセージが届いても自動では返しません。あとで一覧から再び動かせます。"
        confirmLabel="一時停止する"
        destructive
        busy={stopping}
        confirmDisabled={!stopAccount || stopAccount.ruleId !== data?.rule.id}
        confirmDisabledReason="確認する内容を読み込んでください。"
        designNode="i8F12"
        error={actionMessage || undefined} onSuccess={() => setStopOpen(false)} onConfirm={() => stopRule()}
        onCancel={() => { if (!stopping) { setStopOpen(false); setStopReason('') } }}
      >
        <OperationTargetSummary allAccounts={Boolean(stopAccount && stopAccount.ruleId === data?.rule.id && stopAccount.accountId === null)} accounts={stopAccount && stopAccount.ruleId === data?.rule.id && stopAccount.accountId === null ? [] : [{ id: stopAccount && stopAccount.ruleId === data?.rule.id ? stopAccount.accountId ?? '' : '' }]} />
        <SaveErrorField names={["stopReason","reason","stop_reason"]}><SharedTextField
          type="text"
          className={styles.stopReason}
          placeholder="止める理由（任意・記録に残ります）"
          aria-label="止める理由（任意）"
          value={stopReason}
          onChange={(e) => setStopReason(e.target.value)}
        /></SaveErrorField>
      </ConfirmDialog>
    </DetailPage>
  )
}
