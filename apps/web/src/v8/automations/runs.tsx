'use client'
import { knownValue } from '@/lib/known-value'
import { DetailContent, DetailFields, DetailField } from '@/components/shared/detail-content'
import { useListUrlValue } from '@/components/shared/list-url-state'
import { useSamePageUrl } from '@/lib/use-same-page-url'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { Activity, Bookmark, Download, Filter, Layers, TriangleAlert } from 'lucide-react'
import { api, ApiError, downloadApiFile, fetchApi, type AutomationRunDetail } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { formatNumber } from '@/lib/format'
import { ListPage } from '@/components/templates'
import ListToolbar from '@/components/shared/list-toolbar'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import { Tabs } from '@/components/shared/tabs'
import { LogEntryCopy } from '@/components/shared/log-entry-details'
import Select from '@/components/shared/select'
import PageSizeSelect from '@/components/shared/page-size-select'
import { DataTable, TableHeadRow, Th, Tr, Td, ActionCell, RowNameButton } from '@/components/shared/table'
import { type ActionMenuItem } from '@/components/shared/action-menu'
import { RowActions } from '@/components/shared/row-actions'
import DetailPanel, { useDetailPanelUrl } from '@/components/shared/detail-panel'
import ListState from '@/components/shared/list-state'
import Pagination from '@/components/shared/pagination'
import StatusBadge from '@/components/shared/status-badge'
import {
  AUTOMATIONS_DESCRIPTION,
  AutomationBand,
  AutomationTabs,
  useAutomationRunManage,
  useAutomationTabCounts,
  type BandCell,
} from './shell'
import styles from './runs.module.css'
import { formatDate as polishFormatDate } from '@/lib/format'
import { describeApiFailure, permissionDeniedMessage } from '@/components/shared/api-error-message'
import { csvFileName } from '@/lib/csv-file-name'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { lockReason } from '@/components/shared/permission-lock'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import { useStaffRole } from '@/lib/staff-role'
import { effectiveStaffRole, readStaffIdentity } from '@/lib/staff-identity-state'
import { canOperateAutomationRun, canExportAutomationRuns } from '@/components/automations/use-can-manage'


/*
 * ★V8 オートメーションの動いた記録（Pencil ）。
 *
 * 2026-10-06 オーナー決定で src/v8 に一から書いた。データの口・動きは今までの V8
 * （app/automations/runs-v8.tsx）と同じ（一覧・検索・結果の絞り込み・テスト実行の出し分け・CSV・
 * 中身・もう一度やる・取りやめ・?run= の直リンク）。違いは見せ方だけ——
 * 型（ListPage）に、タブ・数の帯・案内の帯・道具の段・表（列の並び）を渡す。
 * 中身は右の詳細パネルで開く。
 */

/** 保持された操作も、実行時の本人・専用鍵・代理モードで確かめる。 */
function canUseRunActionNow(action: 'operate' | 'export'): boolean {
  const identity = readStaffIdentity()
  const role = effectiveStaffRole(identity)
  const allowed = (action === 'operate' ? canOperateAutomationRun : canExportAutomationRuns)(role, identity?.permissionKeys ?? [])
  return allowed && !lockReason(true)
}

type RunStatus = AutomationRunDetail['status']
type ApiResponse<T> = { success: true; data: T } | { success: false; error: string }

/** 一覧の1行（口が返す形のうち、この画面で使うもの）。 */
export type AutomationRunRow = {
  id: string
  automationId: string
  occurredAt: string
  subject: string | null
  accountLabel: string | null
  triggerLabel: string
  status: RunStatus
  detail: string | null
  durationMs: number | null
  automationName: string
  canRetry: boolean
  versionNumber: number
  isTest: boolean
  canCancel: boolean
  friendId: string | null
  successfulActions?: string[]
  failureReason?: string | null
}

type RunsResponse = {
  summary: {
    total: number
    executed: number
    skipped: number
    failed: number
    mostRunName: string | null
    mostRunCount: number | null
  }
  items: AutomationRunRow[]
  pagination: { total: number; limit: number; offset: number }
}

type ResultFilter = 'all' | 'executed' | 'skipped' | 'problems'
type SavedKey = '' | 'include-test'

const STATUS_LABEL: Record<RunStatus, string> = {
  queued: '待っています',
  claimed: '動いています',
  succeeded: '動いた',
  skipped: '条件に外れた',
  waiting: '待機しています',
  retry_wait: '再試行を待っています',
  partial: '失敗',
  permanent_failed: '失敗',
  cancelled: '取り消しました',
}

const STEP_STATUS_LABEL: Record<AutomationRunDetail['steps'][number]['status'], string> = {
  queued: '待機中',
  running: '実行中',
  waiting: '再試行待ち',
  success: '成功',
  failed: '失敗',
  skipped: '見送り',
  cancelled: '取りやめ',
}

export function runStatusLabel(status: string): string {
  return knownValue(STATUS_LABEL, status, '状態を確認できません')
}

export function stepStatusLabel(status: string): string {
  return knownValue(STEP_STATUS_LABEL, status, '状態を確認できません')
}

function statusTone(status: RunStatus): 'success' | 'danger' | 'warning' | 'neutral' {
  if (status === 'succeeded') return 'success'
  if (status === 'permanent_failed' || status === 'partial') return 'danger'
  if (status === 'retry_wait' || status === 'queued' || status === 'claimed' || status === 'waiting') return 'warning'
  return 'neutral'
}

/** 「9/30 14:12」（日本時間）。 */
export function shortDateTime(value: string): string {
  return polishFormatDate(value, { style: 'list', fallback: '日時不明' })
}

/** かかった時間（「0.8 秒」）。測れていないものは「—」。 */
export function durationText(value: number | null): string {
  if (value === null) return '—'
  return `${(value / 1000).toFixed(1)} 秒`
}

/** 結果の2行目：失敗の理由、条件に外れたときの理由。 */
function resultReason(run: AutomationRunRow): string | null {
  if (run.status === 'permanent_failed' || run.status === 'partial') return run.failureReason ?? run.detail
  if (run.status === 'skipped') return run.detail
  return null
}

function runsSearchUrl(pathname: string, currentParams: string, value: string): string {
  const next = new URLSearchParams(currentParams)
  if (value) next.set('search', value)
  else next.delete('search')
  const suffix = next.toString()
  return suffix ? `${pathname}?${suffix}` : pathname
}

function TableHead() {
  return (
    <thead>
      <TableHeadRow data-table-layout="columns">
        <Th grow>いつ・だれに</Th>
        <Th className={styles.colRule}>オートメーション</Th>
        <Th className={styles.colResult}>結果</Th>
        <Th className={styles.colDone}>したこと</Th>
        <Th className={styles.colTime} align="right">かかった時間</Th>
        <Th>操作</Th>
      </TableHeadRow>
    </thead>
  )
}

export default function AutomationRunsV8() {
  usePageTitle('オートメーション')
  usePageCrumbs([{ label: 'ホーム', href: '/' }])
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const pathname = usePathname()
  const router = useRouter()
  const samePageUrl = useSamePageUrl()
  const searchParams = useSearchParams()
  const searchFromUrl = searchParams.get('search') ?? ''
  const tabCounts = useAutomationTabCounts()
  const permissions = useAutomationRunManage()
  const staffRole = useStaffRole()
  const canOperate = staffRole !== null && permissions !== null && permissions.canOperate
  const canExport = staffRole !== null && permissions !== null && permissions.canExport
  const knownOperateReason = usePermissionLockReason(canOperate)
  const knownExportReason = usePermissionLockReason(canExport)
  const operateReason = permissions === null ? undefined : knownOperateReason
  const exportReason = permissions === null ? undefined : knownExportReason

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [data, setData] = useState<RunsResponse | null>(null)
  const [query, setQuery] = useState(searchFromUrl)
  const [resultFilter, setResultFilter] = useState<ResultFilter>(() => {
    const raw = searchParams.get('status')
    return raw === 'executed' || raw === 'skipped' || raw === 'problems' ? raw : 'all'
  })
  const [saved, setSaved] = useState<SavedKey>('')
  const includeTest = saved === 'include-test'
  const [pageSize, setPageSize] = useListUrlValue('pageSize', 20)
  const [page, setPage] = useListUrlValue('page', 1)
  const [runId, setRunId] = useDetailPanelUrl('run')
  const [selectedRun, setSelectedRunState] = useState<AutomationRunRow | null>(null)
  const setSelectedRun = (run: AutomationRunRow | null | ((current: AutomationRunRow | null) => AutomationRunRow | null)) => {
    if (typeof run === 'function') { setSelectedRunState(run); return }
    setRunId(run?.id ?? null)
    setSelectedRunState(run)
  }
  const [selectedDetail, setSelectedDetail] = useState<AutomationRunDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<null | 'error' | 'forbidden'>(null)
  const [detailReloadKey, setDetailReloadKey] = useState(0)
  const [deepLinkRunId, setDeepLinkRunId] = useState<string | null>(null)
  const [deepLinkLoading, setDeepLinkLoading] = useState(false)
  const [deepLinkError, setDeepLinkError] = useState<null | 'error' | 'forbidden'>(null)
  const [deepLinkReloadKey, setDeepLinkReloadKey] = useState(0)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [csvBusy, setCsvBusy] = useState(false)

  useEffect(() => {
    if (!canOperate || operateReason) setConfirmCancel(false)
  }, [canOperate, operateReason])

  const loadGeneration = useRef(0)
  const selectedAccountRef = useRef(selectedAccountId)
  selectedAccountRef.current = selectedAccountId
  const detailGeneration = useRef(0)

  useEffect(() => { setQuery(searchFromUrl) }, [searchFromUrl])

  const changeQuery = (value: string) => {
    setQuery(value)
    setPage(1)
    samePageUrl.replace(runsSearchUrl(pathname, searchParams.toString(), value))
  }
  const toggleResult = (value: Exclude<ResultFilter, 'all'>, next: boolean) => {
    setResultFilter(next ? value : 'all')
    setPage(1)
  }

  useEffect(() => { setPage(1) }, [selectedAccountId, pageSize, saved])

  useEffect(() => {
    loadGeneration.current += 1
    detailGeneration.current += 1
    setSelectedRunState(null)
    setSelectedDetail(null)
    setDetailError(null)
    setDeepLinkRunId(null)
    setDeepLinkError(null)
    setDeepLinkLoading(false)
    setConfirmCancel(false)
    setNotice('')
  }, [selectedAccountId])

  const load = useCallback(async () => {
    if (accountLoading) return
    const generation = loadGeneration.current + 1
    loadGeneration.current = generation
    setStatus('loading')
    try {
      const params = new URLSearchParams({ limit: String(pageSize), offset: String((page - 1) * pageSize) })
      if (selectedAccountId) params.set('lineAccountId', selectedAccountId)
      if (query.trim()) params.set('search', query.trim())
      if (resultFilter !== 'all') params.set('status', resultFilter)
      if (includeTest) params.set('include_test', '1')
      const response = await fetchApi<ApiResponse<RunsResponse>>(`/api/automation-runs?${params}`)
      if (generation !== loadGeneration.current) return
      if (!response.success) throw new Error(response.error)
      if (!response.data || !response.data.summary || !Array.isArray(response.data.items) || !response.data.pagination) {
        throw new Error('実行記録の応答形式が正しくありません')
      }
      setData(response.data)
      setStatus('ready')
    } catch {
      if (generation !== loadGeneration.current) return
      setData(null)
      setStatus('error')
    }
  }, [accountLoading, page, pageSize, query, resultFilter, selectedAccountId, includeTest])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 400)
    return () => window.clearTimeout(timer)
  }, [load])

  /* 中身（処理ごとの結果）は開いたときに読む。 */
  useEffect(() => {
    if (!selectedRun) {
      setSelectedDetail(null)
      setDetailError(null)
      setConfirmCancel(false)
      return
    }
    const accountAtStart = selectedAccountId
    const generationAtStart = detailGeneration.current
    const stale = () => generationAtStart !== detailGeneration.current || selectedAccountRef.current !== accountAtStart
    let cancelled = false
    setDetailLoading(true)
    setDetailError(null)
    api.automations.getRun(selectedRun.id)
      .then((response) => {
        if (cancelled || stale()) return
        if (response.success) setSelectedDetail(response.data)
        else { setSelectedDetail(null); setDetailError('error') }
      })
      .catch((caught: unknown) => {
        if (cancelled || stale()) return
        setSelectedDetail(null)
        setDetailError(caught instanceof ApiError && caught.status === 403 ? 'forbidden' : 'error')
      })
      .finally(() => { if (!cancelled && !stale()) setDetailLoading(false) })
    return () => { cancelled = true }
  }, [selectedRun, selectedAccountId, detailReloadKey])

  const cancelRun = async (run: AutomationRunRow) => {
    if (!canUseRunActionNow('operate') || !run.canCancel || cancellingId) return
    const accountAtStart = selectedAccountId
    setCancellingId(run.id)
    setNotice('')
    try {
      const response = await api.automations.cancelRun(run.id)
      if (!response.success) throw new Error(response.error)
      if (selectedAccountRef.current !== accountAtStart) return
      setNotice('実行を取りやめました。記録は残っています。')
      setSelectedRun(null)
      setConfirmCancel(false)
      await load()
    } catch (caught) {
      if (selectedAccountRef.current !== accountAtStart) return
      setNotice(describeApiFailure(caught, '取りやめ'))
    } finally {
      setCancellingId(null)
    }
  }

  /* もう一度やる：失敗した処理だけ。失敗したら記録を読み直して、受け付け済みかを確かめる。 */
  const retryRun = async (run: AutomationRunRow) => {
    if (!canUseRunActionNow('operate') || !run.canRetry || retryingId) return
    const accountAtStart = selectedAccountId
    setRetryingId(run.id)
    setNotice('')
    try {
      const response = await fetchApi<ApiResponse<{ status: string }>>(
        `/api/automation-runs/${encodeURIComponent(run.id)}/retry`,
        { method: 'POST' },
      )
      if (!response.success) throw new Error(response.error)
      if (selectedAccountRef.current !== accountAtStart) return
      setNotice('再実行を受け付けました。結果は実行記録で確認してください')
      setSelectedRun(null)
      await load()
    } catch (caught) {
      if (selectedAccountRef.current !== accountAtStart) return
      const failureMessage = describeApiFailure(caught, '再実行')
      await load()
      try {
        const detail = await api.automations.getRun(run.id)
        if (!detail.success || selectedAccountRef.current !== accountAtStart) {
          setNotice(failureMessage)
          return
        }
        setSelectedDetail(detail.data)
        setSelectedRun((current) => current && current.id === run.id
          ? { ...current, status: detail.data.status, canRetry: detail.data.canRetry, canCancel: detail.data.canCancel }
          : current)
        const accepted = !detail.data.canRetry
          && (detail.data.status === 'queued' || detail.data.status === 'claimed'
            || detail.data.status === 'waiting' || detail.data.status === 'retry_wait')
        setNotice(accepted ? '再試行を受け付けています。結果はこの記録で確認できます。' : failureMessage)
      } catch {
        setNotice(failureMessage)
      }
    } finally {
      setRetryingId(null)
    }
  }

  const downloadRunsCsv = () => {
    if (!canUseRunActionNow('export') || csvBusy) return
    setCsvBusy(true)
    setNotice('')
    void downloadApiFile(api.automations.runsCsvUrl({
      accountId: selectedAccountId || undefined,
      search: query.trim() || undefined,
      status: resultFilter !== 'all' ? resultFilter : undefined,
      includeTest,
    }), csvFileName("オートメーションの実行履歴"))
      .then((result) => {
        if (result.truncated && result.totalCount !== null) {
          const rest = result.totalCount - (result.returnedCount ?? 0)
          setNotice(`5,000件までしか出ませんでした（対象${formatNumber(result.totalCount)} 件・残り${formatNumber(rest)} 件）。期間や絞り込みで分けて出してください。`)
        }
      })
      .catch(() => setNotice('CSVを書き出せませんでした。通信を確認して、もう一度お試しください。'))
      .finally(() => setCsvBusy(false))
  }

  /* ?run=<id> の直リンク：その記録の中身を開く。 */
  useEffect(() => {
    if (!runId) { setSelectedRunState(null); setDeepLinkRunId(null); return }
    if (selectedRun?.id === runId) return
    setDeepLinkRunId(runId)
    const accountAtStart = selectedAccountRef.current
    let cancelled = false
    setDeepLinkLoading(true)
    setDeepLinkError(null)
    api.automations.getRun(runId)
      .then((response) => {
        if (cancelled || selectedAccountRef.current !== accountAtStart) return
        if (!response.success) { setDeepLinkError('error'); return }
        const detail = response.data
        setSelectedRunState({
          id: detail.id,
          automationId: detail.automationId,
          occurredAt: detail.occurredAt,
          subject: detail.friendName,
          accountLabel: detail.accountLabel,
          triggerLabel: detail.triggerLabel,
          status: detail.status,
          detail: detail.detail,
          durationMs: detail.durationMs,
          automationName: detail.automationName,
          canRetry: detail.canRetry,
          versionNumber: detail.versionNumber,
          isTest: detail.isTest,
          canCancel: detail.canCancel,
          friendId: detail.friendId,
          successfulActions: detail.successfulActions,
          failureReason: detail.failureReason,
        })
        setSelectedDetail(detail)
        setDeepLinkError(null)
      })
      .catch((caught: unknown) => {
        if (cancelled || selectedAccountRef.current !== accountAtStart) return
        setDeepLinkError(caught instanceof ApiError && caught.status === 403 ? 'forbidden' : 'error')
      })
      .finally(() => { if (!cancelled && selectedAccountRef.current === accountAtStart) setDeepLinkLoading(false) })
    return () => { cancelled = true }
  }, [runId, deepLinkReloadKey, selectedAccountId])

  /* 行の「…」：中身を見る・もう一度やる（やり直せる失敗のとき）・ルールを開く・トークを開く。 */
  const rowMenuItems = (run: AutomationRunRow): ActionMenuItem[] => [
    { id: 'open', label: "実行の記録を見る", onSelect: () => setSelectedRun(run) },
    ...(run.canRetry
      ? [{ id: 'retry', label: 'もう一度やる', lockedReason: operateReason, disabled: !canOperate || retryingId !== null, onSelect: () => void retryRun(run) }]
      : []),
    { id: 'rule', label: 'ルールを開く', onSelect: () => router.push(`/automations?search=${encodeURIComponent(run.automationName)}`) },
    ...(run.friendId
      ? [{ id: 'chat', label: 'トークを開く', onSelect: () => router.push(`/chats?friend=${encodeURIComponent(run.friendId as string)}`) }]
      : []),
  ]

  /* ===== 数の帯 ===== */
  const summary = data?.summary ?? null
  const cells: BandCell[] = [
    { key: 'executed', title: 'この30日に動いた', icon: <Activity size={16} aria-hidden="true" />, value: summary?.executed ?? null, unit: '回', detail: summary?.mostRunName ? `いちばん動いた：${summary.mostRunName}` : '実行結果を集計' },
    { key: 'skipped', title: '条件に外れた', icon: <Filter size={16} aria-hidden="true" />, value: summary?.skipped ?? null, unit: '回', detail: '条件が厳しすぎないか見てください' },
    { key: 'failed', title: '失敗', icon: <TriangleAlert size={16} aria-hidden="true" />, value: summary?.failed ?? null, unit: '件', detail: '「中身を見る」から理由を確かめられます' },
    { key: 'total', title: 'すべて', icon: <Layers size={16} aria-hidden="true" />, value: summary?.total ?? null, unit: '回', detail: 'この30日' },
  ]

  /* ===== 道具の段 ===== */
  const filterChips = <Tabs size="compact" wrap label="結果で絞り込む" items={[
    { label: 'すべて', count: summary?.total, current: resultFilter === 'all', onClick: () => { setResultFilter('all'); setPage(1) } },
    ...([{ value: 'executed', label: '動いた', count: summary?.executed }, { value: 'skipped', label: '条件に外れた', count: summary?.skipped }, { value: 'problems', label: '失敗', count: summary?.failed }] as const).map(item => ({ label: item.label, count: item.count, current: resultFilter === item.value, onClick: () => toggleResult(item.value, true) })),
  ]} />
  const savedBox = (
      <SaveErrorField names={["saved"]}><Select size="content" icon={<Bookmark size={16} aria-hidden="true" />} showChevron={false}
        aria-label="よく使う絞り込み"
        value={saved}
        onChange={(value) => setSaved(value as SavedKey)}
        options={[
          { value: '', label: 'よく使う絞り込み' },
          { value: 'include-test', label: 'テスト実行も見る' },
        ]}
      /></SaveErrorField>
  )
  const toolbar = (
    <>
      {operateReason ? <div className={styles.noticeRow}><ReadOnlyNotice need="feature" /></div> : null}
      {canExport && data && data.pagination.total > 5000 ? (
        <div className={styles.noticeRow}><Notice tone="warn">CSVは5,000件までしか出ません。期間や絞り込みで分けて出してください。</Notice></div>
      ) : null}
      {notice ? <div className={styles.noticeRow}><Notice tone="info" role="status">{notice}</Notice></div> : null}
      <ListToolbar
        search={{ placeholder: '友だち・ルールの名前で探す', label: '友だちの名前・オートメーションの名前で探す', width: 240, value: query, onChange: changeQuery }}
        filters={filterChips}
        trailing={<>{savedBox}<PageSizeSelect value={pageSize} onChange={setPageSize} options={[10, 20, 50]} label={null} /></>}
      />
    </>
  )

  /* ===== 表 ===== */
  let listBody: ReactNode
  if (accountLoading || status === 'loading') {
    listBody = <ListState kind="loading" title="動いた記録を読み込んでいます" />
  } else if (status === 'error') {
    listBody = (
      <ListState
        kind="error"
        title="動いた記録を読み込めませんでした"
        description="記録は消えていません。通信を確かめて、もう一度お試しください。"
        onRetry={() => void load()}
      />
    )
  } else if (!data || data.items.length === 0) {
    listBody = (
      <ListState
        kind="empty"
        title={query || resultFilter !== 'all' ? '条件に合う記録はありません' : '動いた記録はまだありません'}
        description={query || resultFilter !== 'all' ? '検索や絞り込みを外すと、すべて出ます。' : 'オートメーションが動くと、結果がここに残ります。'}
      />
    )
  } else {
    listBody = (
      <>
        <div className={styles.tableWrap}>
          <DataTable columnSizing="content" columnLayout={{ headHeight: 'var(--polish-table-head)', rowHeight: 'var(--polish-table-row)', gap: 'var(--polish-space-card)', padding: '0 var(--tpl-list-inset)', collapseScope: 'page' }}>
            <TableHead />
            <tbody>
              {data.items.map((run) => {
                const done = run.successfulActions ?? []
                const reason = resultReason(run)
                const whenLine = [shortDateTime(run.occurredAt), run.accountLabel].filter(Boolean).join('・')
                const versionLine = `第${run.versionNumber}版${run.isTest ? '・テスト' : ''}`
                const subjectName = `記録「${run.subject ?? '友だち名なし'}・${run.automationName}」`
                return (
                  <Tr key={run.id} data-table-layout="columns" data-row-id={run.id} onOpen={() => setSelectedRun(selectedRun?.id === run.id ? null : run)}>
                    <Td grow>
                      <RowNameButton title={run.subject ?? "友だち名なし"} onClick={() => setSelectedRun(run)}>
                        {run.subject ?? '友だち名なし'}
                      </RowNameButton>
                      <span className={styles.sub}>{whenLine}</span>
                    </Td>
                    <Td className={styles.colRule}>
                      <span className={styles.main} title={run.automationName}>{run.automationName}</span>
                      <span className={styles.sub}>{versionLine}</span>
                    </Td>
                    <Td className={styles.colResult}>
                      <StatusBadge tone={statusTone(run.status)}>{runStatusLabel(run.status)}</StatusBadge>
                      {reason ? <span className={styles.sub} title={reason}>{reason}</span> : null}
                    </Td>
                    <Td className={styles.colDone}>
                      <span className={styles.main} title={done.join('・') || run.detail || ''}>{done.length > 0 ? done.join('・') : emptyValue('unknown')}</span>
                      {done.length > 0 ? <span className={styles.sub}>{`${done.length} つ`}</span> : null}
                    </Td>
                    <Td align="right" className={styles.colTime}><span className={styles.main}>{durationText(run.durationMs)}</span></Td>
                    <ActionCell>
                      <RowActions subjectName={subjectName} detail={{ label: '中身を見る', onClick: () => setSelectedRun(run) }} menuItems={rowMenuItems(run)} />
                    </ActionCell>
                  </Tr>
                )
              })}
            </tbody>
          </DataTable>
        </div>
      </>
    )
  }

  const total = data?.pagination.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const pager = status === 'ready' && data && data.items.length > 0 ? (
    <>
      <Pagination page={page} pageCount={pageCount} onPageChange={setPage} ariaLabel="動いた記録のページ送り" range={{ total, first: data.pagination.offset + 1, last: data.pagination.offset + data.items.length }} />
    </>
  ) : null

  const run = selectedRun
  const runDetail = selectedDetail
  const deepLinkMessage = !run && deepLinkRunId
    ? deepLinkLoading ? '読み込んでいます'
      : deepLinkError === 'forbidden' ? permissionDeniedMessage('store')
        : deepLinkError === 'error' ? '詳細を読み込めませんでした。記録は消えていません。' : null
    : null

  return (
    <ListPage
      help={<>{AUTOMATIONS_DESCRIPTION}{"行の「…」から 中身を見る・もう一度やる（失敗のとき）・ルールを開く・トークを開く。"}</>}
      noticeSpacing="section"
      explanation="「もう一度やる」は、やり直せる失敗（一時的な送信の失敗など）だけに出ます。ブロック中など原因を直す必要があるものには出ません。条件に外れたものは、ルールの「だれに」に当てはまらなかった人です。"
      boardId="g98F9"
      headingSize="regular"
      title="オートメーション"

      actions={<Button onClick={downloadRunsCsv} lockedReason={exportReason} disabled={!canExport || csvBusy} busy={csvBusy} busyLabel="書き出しています…" title="いまの検索・絞り込みの行が出ます（5,000件まで）"><Download size={16} aria-hidden="true" />CSVで書き出す</Button>}
      tabs={<AutomationTabs active="runs" counts={tabCounts} />}
      stats={<AutomationBand label="動いた記録の数の帯" cells={cells} />}
      toolbar={toolbar}
      pagination={pager}
      overlays={<>
        {deepLinkMessage ? (
          <DetailPanel open title="実行記録の中身" onClose={() => { setDeepLinkRunId(null); setRunId(null) }}>
            <p className={styles.panelText}>{deepLinkMessage}</p>
            {deepLinkError === 'error' ? <Button onClick={() => setDeepLinkReloadKey((key) => key + 1)}>もう一度読み込む</Button> : null}
          </DetailPanel>
        ) : null}
        <DetailPanel
          open={run !== null}
          title={run ? run.automationName : ''}
          description={run ? `${shortDateTime(run.occurredAt)}・${run.subject ?? '友だち名なし'}` : undefined}
          onClose={() => setSelectedRun(null)}
          actions={run ? {
primary: confirmCancel && run.canCancel && canOperate && !operateReason ? <Button variant="danger" onClick={() => void cancelRun(run)} lockedReason={operateReason} disabled={!canOperate || cancellingId !== null} busy={cancellingId === run.id} busyLabel="取りやめ中">取りやめる</Button> : run.canRetry ? <Button variant="primary" onClick={() => void retryRun(run)} lockedReason={operateReason} disabled={!canOperate || retryingId !== null} busy={retryingId === run.id} busyLabel="実行中">失敗した処理をもう一度やる</Button> : null,
menuItems: confirmCancel && run.canRetry ? [{ id: 'retry-run', label: '失敗した処理をもう一度やる', allowed: canOperate, disabled: retryingId !== null, lockedReason: operateReason, onSelect: () => void retryRun(run) }] : [],
secondary: run.canCancel ? confirmCancel && canOperate && !operateReason ? <Button variant="secondary" onClick={() => setConfirmCancel(false)} disabled={cancellingId !== null}>キャンセル</Button> : <Button variant="secondary" onClick={() => { if (canUseRunActionNow('operate')) setConfirmCancel(true) }} lockedReason={operateReason} disabled={!canOperate || cancellingId !== null}>この実行を取りやめる</Button> : null,
} : undefined}
         status={run ? <StatusBadge tone={statusTone(run.status)}>{runStatusLabel(run.status)}</StatusBadge> : null}>
<DetailContent>
          {run ? (
            <div className={styles.panel}>
              <LogEntryCopy canCopy={permissions?.canExport === true} entry={{ occurredAt: run.occurredAt, target: run.subject ?? '友だち名なし', status: runStatusLabel(run.status), reason: resultReason(run) ?? runStatusLabel(run.status) }} />
              <DetailField label="版">
                {`第${(runDetail ?? run).versionNumber}版`}
                {(runDetail ?? run).isTest ? '・テスト実行' : ''}
                {runDetail ? (runDetail.isCurrentVersion ? '・いまの公開版です' : runDetail.currentVersionNumber !== null ? `・いまの公開版は 第${runDetail.currentVersionNumber}版 です` : '') : ''}
              </DetailField>
              <DetailFields>
                <div><dt>きっかけ</dt><dd>{run.triggerLabel}</dd></div>
                <div><dt>結果</dt><dd>{runStatusLabel(run.status)}</dd></div>
                <div><dt>したこと・失敗理由</dt><dd>{run.detail ?? '何もしていません'}</dd></div>
                <div><dt>かかった時間</dt><dd>{durationText(run.durationMs)}</dd></div>
                {runDetail?.holdReason ? <><div><dt>止まっている理由</dt><dd>{runDetail.holdReason}</dd></div></> : null}
              </DetailFields>
              <DetailField label="処理ごとの結果"> {detailLoading ? (
                <p className={styles.panelText}>読み込んでいます</p>
              ) : detailError === 'forbidden' ? (
                <p className={styles.panelText}>この実行を見る権限がありません。</p>
              ) : detailError === 'error' ? (
                <div className={styles.panelActions}>
                  <p className={styles.panelText}>詳細を読み込めませんでした。記録は消えていません。</p>
                  <Button onClick={() => setDetailReloadKey((key) => key + 1)}>もう一度読み込む</Button>
                </div>
              ) : runDetail && runDetail.steps.length > 0 ? (
                <ul className={styles.steps}>
                  {runDetail.steps.map((step) => (
                    <li key={step.stepKey} className={styles.step}>
                      <span>{step.actionLabel}{step.commonActionVersionId ? '（共通アクション）' : ''}</span>
                      <span className={styles.stepMeta}>{`${step.attemptNumber} 回目・${stepStatusLabel(step.status)}`}</span>
                      {step.errorMessage ? <span className={styles.stepError}>{step.errorMessage}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.panelText}>処理の記録はありません</p>
              )} </DetailField>
              <p className={styles.panelText}>
                {run.canRetry
                  ? '失敗した処理だけを、成功済みの処理と重ならないようにもう一度実行できます。'
                  : run.canCancel
                    ? 'まだ終わっていない実行です。取りやめるとこれ以降の処理は動きませんが、記録は残ります。'
                    : '安全な再実行の対象ではありません。成功済みの処理を二重に動かさないため、この記録からは再実行できません。'}
              </p>
              {confirmCancel && canOperate && !operateReason ? (
                <p className={styles.panelWarn}>{`「${run.accountLabel ?? '選択中のアカウント'}」の実行を取りやめますか？記録は残りますが、実行は戻せません。`}</p>
              ) : null}
            </div>
          ) : null}

</DetailContent>
</DetailPanel>
      </>}
    >
      {listBody}
    </ListPage>
  )
}
