'use client'

import { describeApiFailure } from '@/components/shared/api-error-message'
import { isOwnerRole, useStaffRole } from '@/lib/staff-role'
import { ListToolbarFrame } from '@/components/shared/list-toolbar'
import HelpTip from '@/components/shared/help-tip'
import { jstDateOffset } from '@/lib/jst-datetime'
import { FolderDotName } from '@/components/shared/folder-dot'
import { useListUrlValue } from '@/components/shared/list-url-state'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { Check, CircleDot, Clock3, Download, RefreshCw, TrendingDown, TrendingUp, Undo2, Users, Wallet } from 'lucide-react'
import { useAccount } from '@/contexts/account-context'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import {
  api,
  type MileageAdjustmentApprovalRequest,
  type MileageAdminHistory,
  type MileageFriendV6,
  type MileageFriendsV6Overview,
} from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { csvCell } from '@/lib/presentation'
import Button from '@/components/shared/button'

import Dialog from '@/components/shared/dialog'
import FilterChip from '@/components/shared/filter-chip'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import Pagination from '@/components/shared/pagination'
import { DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import {
  formatMileageMonthDay,
  formatMileageNumber,
  formatMileageShortDateTime,
  isMileageFriendsV6Overview,
  mileagePaginationTotal,
} from './display'
import { MILEAGE_TABLE_LAYOUT, MileageFrame, useMileageShell } from './frame'
import { MileageToolbar, PerPageSelect, RetryButton, SavedSelect, StateCard, ToolbarNotices } from './parts'
import styles from './mileage.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import BalanceRowMenu from './balance-row-menu'
import { Field } from '@/components/shared/form-controls'
import { csvFileName } from '@/lib/csv-file-name'
import { emptyValue } from '@/components/shared/empty-value'
import { formatMileageDate } from './display'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { TextArea as SharedTextArea } from '@/components/shared/text-field'

/*
 * ★V8 マイル「友だちの残高」（板 、状態は見本帳 ）。
 *
 * app/mileage/v8-balances-tab.tsx から動きを写し、見た目を一覧の型で組み直した。
 * フォルダの列は無い（絵どおり）。表は「友だち・ランク・いまの残高・今月の増減・
 * 消える予定・最終行動・操作（…から明細を見る・増減）」。承認待ちの板は今と同じ条件で出す。
 *
 * 口に残高あり・確定待ちの絞り込みは無い。札を押したときは全件を読み切ってから
 * 絞る（読んだ頁の中だけで絞ると 21 件目以降が検索に出ない）。
 */

function dateOnlyDaysAgo(days: number) {
  return jstDateOffset(-days)
}

function expiringText(member: MileageFriendV6): string {
  if (member.expiringMiles30d == null) return 'なし'
  if (member.expiringMiles30d === 0 && member.nextExpiringAt) return '30日以内はなし'
  return formatMileageNumber(member.expiringMiles30d)
}

function rankLabel(rank: string | null) {
  if (rank === 'gold') return 'ゴールド'
  if (rank === 'silver') return 'シルバー'
  if (rank === 'bronze') return 'ブロンズ'
  return null
}

function signed(value: number): string {
  if (value > 0) return `+${formatMileageNumber(value)}`
  if (value < 0) return `−${formatMileageNumber(Math.abs(value))}`
  return '0'
}

export default function BalancesTab() {
  const { readonly, narrow, setCount } = useMileageShell()
  const router = useRouter()
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const scope = useRef({ id: selectedAccountId, generation: 0 })
  if (scope.current.id !== selectedAccountId) scope.current = { id: selectedAccountId, generation: scope.current.generation + 1 }
  const loadedApprovalScope = useRef(-1)
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const latestAccountRef = useRef(selectedAccountId)
  useEffect(() => {
    latestAccountRef.current = selectedAccountId
  }, [selectedAccountId])
  const [overview, setOverview] = useState<MileageFriendsV6Overview | null>(null)
  const [allMembers, setAllMembers] = useState<MileageFriendV6[] | null>(null)
  const [grantedMiles, setGrantedMiles] = useState<number | null>(null)
  const [decreasedMiles, setDecreasedMiles] = useState<number | null>(null)
  const [historyFailed, setHistoryFailed] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const reloadSeqRef = useRef(0)
  const historySeqRef = useRef(0)
  const historyLoadingRef = useRef(false)
  const approvalLoadingRef = useRef(false)
  const [searchInput, setSearchInput] = useListUrlValue('q', '')
  const [search, setSearch] = useListUrlValue('q', '')
  const [offset, setOffset] = useListUrlValue('offset', 0)
  const [pageSize, setPageSize] = useListUrlValue('pageSize', 20)
  const [withBalanceOnly, setWithBalanceOnly] = useListUrlValue('withBalanceOnly', false)
  const [pendingOnly, setPendingOnly] = useListUrlValue('pendingOnly', false)
  const [approvalRequests, setApprovalRequests] = useState<MileageAdjustmentApprovalRequest[] | null>(null)
  const [approvalFailed, setApprovalFailed] = useState(false)
  const [approvalLoading, setApprovalLoading] = useState(false)
  const [approvalBusyId, setApprovalBusyId] = useState<string | null>(null)
  const [approvalError, setApprovalError] = useState('')
  const [rejectTarget, setRejectTarget] = useState<MileageAdjustmentApprovalRequest | null>(null)
  const [rejectScope, setRejectScope] = useState<{ id: string; generation: number } | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const isOwner = isOwnerRole(useStaffRole())
  const canDecide = useRef(isOwner && !readonly && overview?.balanceSource === 'musubo')
  canDecide.current = isOwner && !readonly && overview?.balanceSource === 'musubo'
  const [exportError, setExportError] = useState('')

  const chipActive = withBalanceOnly || (pendingOnly && overview?.balanceSource !== 'ec')

  const loadOverview = useCallback(async () => {
    const accountAtRequest = selectedAccountId
    if (!accountAtRequest) {
      setOverview(null)
      return
    }
    /* 札の絞り込み中は全件を読み切る（100件ずつ）。 */
    if (chipActive) {
      const items: MileageFriendV6[] = []
      let nextOffset = 0
      let source: 'ec' | 'musubo' | undefined
      const limit = 100
      for (;;) {
        const res = await api.mileage.friendsV6({ accountId: accountAtRequest, search: search || undefined, limit, offset: nextOffset })
        if (accountAtRequest !== latestAccountRef.current) return
        if (!res.success) throw new Error(res.error)
        if (!isMileageFriendsV6Overview(res.data)) throw new Error('invalid_mileage_overview')
        if (source && source !== res.data.balanceSource) throw new Error('mileage_source_changed')
        source = res.data.balanceSource
        if (items.length === 0) setOverview(res.data)
        items.push(...res.data.items)
        const total = res.data.pagination.total
        if (items.length >= total || res.data.items.length === 0) break
        nextOffset += limit
      }
      setAllMembers(items)
      return source
    }
    const res = await api.mileage.friendsV6({ accountId: accountAtRequest, search: search || undefined, limit: pageSize, offset })
    if (accountAtRequest !== latestAccountRef.current) return
    if (!res.success) throw new Error(res.error)
    if (!isMileageFriendsV6Overview(res.data)) throw new Error('invalid_mileage_overview')
    setOverview(res.data)
    setAllMembers(null)
    return res.data.balanceSource
  }, [chipActive, offset, pageSize, search, selectedAccountId])

  const loadHistorySummary = useCallback(async (accountId: string, expectedSeq?: number) => {
    const seq = expectedSeq ?? ++historySeqRef.current
    historyLoadingRef.current = true
    setHistoryLoading(true)
    setHistoryFailed(false)
    try {
      const historyRes = await api.mileage.history({
        accountId,
        from: dateOnlyDaysAgo(29),
        to: dateOnlyDaysAgo(0),
        limit: 1,
        offset: 0,
      })
      if (historySeqRef.current !== seq || latestAccountRef.current !== accountId || !alive.current) return
      if (historyRes.success && Array.isArray((historyRes.data as MileageAdminHistory)?.summary?.byType)) {
        const byType = (historyRes.data as MileageAdminHistory).summary.byType
        setGrantedMiles(byType.find((item) => item.entryType === 'grant')?.amount ?? 0)
        setDecreasedMiles(byType
          .filter((item) => item.entryType !== 'grant')
          .reduce((sum, item) => sum + Math.abs(item.amount ?? 0), 0))
        setHistoryFailed(false)
      } else {
        setGrantedMiles(null)
        setDecreasedMiles(null)
        setHistoryFailed(true)
      }
    } catch {
      if (historySeqRef.current !== seq || latestAccountRef.current !== accountId || !alive.current) return
      setGrantedMiles(null)
      setDecreasedMiles(null)
      setHistoryFailed(true)
    } finally {
      if (historySeqRef.current === seq) {
        historyLoadingRef.current = false
        setHistoryLoading(false)
      }
    }
  }, [])

  const retryHistory = useCallback(() => {
    if (!selectedAccountId || historyLoadingRef.current) return
    void loadHistorySummary(selectedAccountId)
  }, [loadHistorySummary, selectedAccountId])

  const reloadAll = useCallback(async () => {
    const seq = ++reloadSeqRef.current
    const historySeq = ++historySeqRef.current
    historyLoadingRef.current = false
    setLoading(true)
    setLoadError(false)
    setGrantedMiles(null)
    setDecreasedMiles(null)
    setHistoryFailed(false)
    setHistoryLoading(false)
    try {
      const source = await loadOverview()
      if (reloadSeqRef.current !== seq) return
      if (source === 'musubo' && selectedAccountId && latestAccountRef.current === selectedAccountId) {
        await loadHistorySummary(selectedAccountId, historySeq)
      }
    } catch {
      if (reloadSeqRef.current === seq) setLoadError(true)
    } finally {
      if (reloadSeqRef.current === seq) setLoading(false)
    }
  }, [loadHistorySummary, loadOverview, selectedAccountId])

  useEffect(() => {
    if (accountLoading) return
    setOverview(null)
    setAllMembers(null)
    void reloadAll()
  }, [accountLoading, reloadAll])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setOffset(0)
      setSearch(searchInput.trim())
    }, 0)
    return () => window.clearTimeout(timer)
  }, [searchInput])



  const loadApprovals = useCallback(async () => {
    const requestScope = scope.current.generation
    if (!selectedAccountId) {
      approvalLoadingRef.current = false
      setApprovalLoading(false)
      setApprovalRequests(null)
      setApprovalFailed(false)
      return
    }
    if (approvalLoadingRef.current) return
    approvalLoadingRef.current = true
    setApprovalLoading(true)
    try {
      const response = await api.mileage.adjustmentApprovals(selectedAccountId, 'pending')
      if (!alive.current || requestScope !== scope.current.generation) return
      if (response.success) loadedApprovalScope.current = requestScope
      setApprovalRequests(response.success ? response.data : null)
      setApprovalFailed(!response.success)
    } catch {
      if (!alive.current || requestScope !== scope.current.generation) return
      setApprovalRequests(null)
      setApprovalFailed(true)
    } finally {
      approvalLoadingRef.current = false
      if (alive.current && requestScope === scope.current.generation) setApprovalLoading(false)
    }
  }, [selectedAccountId])

  useEffect(() => {
    void loadApprovals()
  }, [loadApprovals])

  const decideApproval = async (requestId: string, action: 'approve' | 'reject', reason?: string) => {
    if (!alive.current || !canDecide.current || !selectedAccountId || approvalBusyId || loadedApprovalScope.current !== scope.current.generation) return
    setApprovalBusyId(requestId)
    setApprovalError('')
    try {
      const response = action === 'approve'
        ? await api.mileage.approveAdjustment(requestId, selectedAccountId)
        : await api.mileage.rejectAdjustment(requestId, selectedAccountId, reason)
      if (!response.success) throw new Error(response.error)
      setRejectTarget(null)
      setRejectReason('')
      await loadApprovals()
      await loadOverview().catch(() => {})
    } catch (caught) {
      setApprovalError(describeApiFailure(caught, '保存'))
    } finally {
      setApprovalBusyId(null)
    }
  }

  const summary = overview?.summary ?? null
  const ecSource = overview?.balanceSource === 'ec'
  const overviewTotal = mileagePaginationTotal(overview)
  const pageMembers = useMemo(() => {
    if (!chipActive) return overview?.items ?? []
    return (allMembers ?? []).filter((member) => {
      if (withBalanceOnly && (member.available ?? 0) <= 0) return false
      if (pendingOnly && !ecSource && member.pending <= 0) return false
      return true
    })
  }, [allMembers, chipActive, ecSource, overview, pendingOnly, withBalanceOnly])
  /* 札の絞り込み中は手元で頁を切る。そうでなければ口が返した頁そのまま。 */
  const members = useMemo(
    () => (chipActive ? pageMembers.slice(offset, offset + pageSize) : pageMembers),
    [chipActive, offset, pageMembers, pageSize],
  )
  const exportCsv = useCallback(() => {
    if (members.length === 0) return
    setExportError('')
    try {
      const rows = members.map((member) => [
        member.displayName,
        member.lineAccount.name,
        member.available,
        ...(ecSource ? [member.rank ?? '未設定'] : [member.pending, member.expiringMiles30d ?? '', member.lastChangedAt ?? '']),
      ])
      const csv = [[...(ecSource ? ['友だち', 'LINEアカウント', 'ECの残高', 'ランク'] : ['友だち', 'LINEアカウント', 'いまの残高', '確定待ち', '30日以内に失効', '最終変動'])], ...rows]
        .map((row) => row.map((value) => csvCell(value)).join(','))
        .join('\n')
      const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = csvFileName("マイル残高")
      anchor.click()
      URL.revokeObjectURL(url)
    } catch {
      setExportError('CSVを書き出せませんでした。もう一度お試しください。')
    }
  }, [members, ecSource])
  const filteredTotal = chipActive ? pageMembers.length : (overviewTotal ?? 0)
  const pageCount = Math.max(1, Math.ceil(filteredTotal / pageSize))
  const currentPage = Math.floor(offset / pageSize) + 1
  const pendingCount = useMemo(
    () => (allMembers ?? overview?.items ?? []).filter((member) => member.pending > 0).length,
    [allMembers, overview],
  )

  /* タブの名の横の件数。読み直し中・失敗時は消す。 */
  useEffect(() => {
    if (loading) return
    setCount('balances', loadError || overview === null ? null : formatMileageNumber(overview.summary.totalMembers))
  }, [loadError, loading, overview, setCount])

  const resetAll = () => {
    setSearchInput('')
    setSearch('')
    setOffset(0)
    setWithBalanceOnly(false)
    setPendingOnly(false)
  }

  const ready = !loading && !loadError && summary !== null

  const stats = (
    <KpiBand>
      <KpiCard
        presentation="band"
        title="友だち"
        icon={<Users size={16} aria-hidden="true" />}
        value={ready ? summary.totalMembers : null}
        unit="人"
        loading={loading}
        detail={ready ? `マイルを持っている ${formatMileageNumber(summary.withBalanceCount)}人` : emptyValue('unknown')}
      />
      <KpiCard
        presentation="band"
        title="残高の合計"
        icon={<Wallet size={16} aria-hidden="true" />}
        value={ready && (!ecSource || (overview?.ecKnownCount ?? 0) > 0) ? summary.available : null}
        unit=""
        loading={loading}
        detail={ready
          ? ecSource ? `ECと同期・取得済み ${formatMileageNumber(overview?.ecKnownCount ?? 0)} 人` : `1人あたり ${formatMileageNumber(summary.totalMembers > 0 ? Math.round((summary.available ?? 0) / summary.totalMembers) : 0)} マイル`
          : emptyValue('unknown')}
      />
      {!ecSource ? <><KpiCard
        presentation="band"
        title="直近30日 増えた"
        icon={<TrendingUp size={16} aria-hidden="true" />}
        value={ready && !historyFailed ? grantedMiles : null}
        unit=""
        loading={loading || historyLoading}
        detail={ready && historyFailed ? '集計を読み込めませんでした' : 'この30日に付いた分'}
        onRetry={ready && historyFailed && !historyLoading ? retryHistory : undefined}
      />
      <KpiCard
        presentation="band"
        title="直近30日 減った"
        icon={<TrendingDown size={16} aria-hidden="true" />}
        value={ready && !historyFailed ? decreasedMiles : null}
        unit=""
        loading={loading || historyLoading}
        detail={ready && historyFailed ? '集計を読み込めませんでした' : '交換・取り消し'}
        onRetry={ready && historyFailed && !historyLoading ? retryHistory : undefined}
      /></> : null}
    </KpiBand>
  )

  /* 承認待ちの板（黄の地）。案内の帯のすぐ下・道具の段の上。 */
  const approval = approvalRequests && approvalRequests.length > 0 ? (
    <section className={styles.approval} aria-label="承認待ちのマイル変更">
      <p className={styles.approvalTitle}>{`承認待ちのマイル変更 ${formatNumber(approvalRequests.length)} 件`}</p>
      {approvalError ? <Notice tone="danger" message={approvalError} /> : null}
      {approvalRequests.map((request) => (
        <div key={request.id} className={styles.approvalRow}>
          <div className={styles.approvalText}>
            <span className={styles.approvalName}>
              {`${request.friend_display_name ?? request.friend_id} に ${request.direction === 'increase' ? '+' : '−'}${formatNumber(request.amount)} マイル`}
            </span>
            <span className={styles.approvalSub} title={request.reason}>
              {`${request.reason}・申請 ${request.requested_by_staff_name}（${formatMileageShortDateTime(request.created_at)}）`}
            </span>
          </div>
          {canDecide.current ? (
            <>
              <Button
                variant="secondary"
                disabled={approvalBusyId !== null}
                onClick={() => { if (!selectedAccountId || !canDecide.current || loadedApprovalScope.current !== scope.current.generation) return; setRejectScope({ id: selectedAccountId, generation: scope.current.generation }); setRejectTarget(request); setRejectReason(''); setApprovalError('') }}
              >
                <Undo2 size={16} aria-hidden="true" /> 差し戻す
              </Button>
              <Button
                variant="primary"
                disabled={approvalBusyId !== null}
                onClick={() => void decideApproval(request.id, 'approve')}
              >
                <Check size={16} aria-hidden="true" /> 承認する
              </Button>
            </>
          ) : (
            <span className={styles.approvalSub}>{ecSource ? 'EC管理のため保留しています' : overview?.balanceSource !== 'musubo' ? '管理元を確認できていません' : 'オーナーが対応します'}</span>
          )}
        </div>
      ))}
      <p className={styles.approvalNote}>{ecSource ? '切り替え前の依頼をそのまま表示しています。' : '5,000 マイル以上の変更は、申請した人とは別のオーナーが承認するまで付きません。'}</p>
    </section>
  ) : approvalFailed ? (
    <section className={styles.approval} aria-label="承認待ちのマイル変更">
      <p className={styles.approvalTitle}>承認待ちのマイル変更</p>
      <p className={styles.approvalNote}>承認待ちを読み込めませんでした。依頼があるか分からない状態です。</p>
      <div>
        <Button onClick={() => void loadApprovals()} disabled={approvalLoading} busy={approvalLoading} busyLabel="読み込み中…">もう一度読み込む</Button>
      </div>
    </section>
  ) : null

  const chips = (
    <div role="group" aria-label="状態で絞り込む" className={styles.chipGroup}>
      <FilterChip
        selected={withBalanceOnly}
        icon={<CircleDot size={16} aria-hidden="true" />}
        onChange={(selected) => { setOffset(0); setWithBalanceOnly(selected) }}
      >
        {`残高あり ${summary === null ? emptyValue('unknown') : formatMileageNumber(summary.withBalanceCount)}`}
      </FilterChip>
      {!ecSource ? <FilterChip
        selected={pendingOnly}
        icon={<Clock3 size={16} aria-hidden="true" />}
        onChange={(selected) => { setOffset(0); setPendingOnly(selected) }}
      >
        {/* 件数は全件を読み切ったときだけ確か（読んだ頁の中だけの数と混ぜない）。 */}
        {chipActive ? `確定待ちあり ${formatMileageNumber(pendingCount)}` : '確定待ちあり'}
      </FilterChip> : null}
    </div>
  )

  const toolbar = (
    <ListToolbarFrame>
      {approval ? <div className={styles.fullRow}>{approval}</div> : null}
      <MileageToolbar
        narrow={narrow}
        notices={<ToolbarNotices error={exportError} />}
        search={{
          placeholder: '友だちの名前で探す',
          value: searchInput,
          onChange: (value) => {
            setSearchInput(value)
            if (!value) { setSearch(''); setOffset(0) }
          },
        }}
        chips={chips}
        trailing={<>
          <SavedSelect
            value={withBalanceOnly ? 'with-balance' : pendingOnly && !ecSource ? 'pending' : 'default'}
            options={[
              { value: 'default', label: 'よく使う絞り込み' },
              { value: 'with-balance', label: '残高ありのみ' },
              ...(!ecSource ? [{ value: 'pending', label: '確定待ちありのみ' }] : []),
            ]}
            onChange={(value) => {
              setOffset(0)
              setWithBalanceOnly(value === 'with-balance')
              setPendingOnly(value === 'pending')
            }}
          />
          <PerPageSelect value={pageSize} onChange={(next) => { setOffset(0); setPageSize(next) }} />
          {/* 絵 CJlf4：件数の右に表の読み方の「？」。 */}
          <HelpTip label="表の読み方">いまの残高は使えるマイルです。「保留」は確定待ちの分です。消える予定は30日以内に期限を迎える分、最終行動は最後にマイルが動いた日です。</HelpTip>
        </>}
      />
    </ListToolbarFrame>
  )

  const table = (
    <div className={styles.tableWrap}>
      <DataTable columnLayout={MILEAGE_TABLE_LAYOUT} columnSizing="controls">
        <thead>
          <TableHeadRow data-table-layout="columns">
            <Th grow>友だち</Th>
            <Th collapseAt={ecSource ? undefined : 'narrow'} className={styles.colRank} title={ecSource ? 'ECと同期' : summary ? summary.rankCounts.length > 0 ? summary.rankCounts.map(rank => `${rank.rankName} ${formatMileageNumber(rank.friendCount)}名`).join('・') : '公開中のランクなし' : 'ランク別の人数は未取得'}>ランク</Th>
            <Th align="right" className={styles.colBalance} title="並び順：残高が多い順">いまの残高</Th>
            {!ecSource ? <Th align="right" className={styles.colChange}>今月の増減</Th> : null}
            {!ecSource ? <Th align="right" className={styles.colBalance} title={`もうすぐ消えるマイル：${summary?.expiringMiles30d == null ? '未取得' : formatMileageNumber(summary.expiringMiles30d)}`}>消える予定</Th> : null}
            <Th collapseAt="narrow" className={styles.colLast}>{ecSource ? 'EC更新' : '最終行動'}</Th>
            <Th align="right" className={styles.colOpsMenu}><span className="sr-only">操作</span></Th>
          </TableHeadRow>
        </thead>
        <tbody>
          {members.map((member) => {
            const href = `/mileage/friends/detail?id=${encodeURIComponent(member.friendId)}`
            return (
              <Tr
                key={member.friendId}

                data-table-layout="columns"
                interactive
                onClick={(event) => {
                  /* 行の中のボタン・リンクを押したときは、そちらに任せる。 */
                  if ((event.target as HTMLElement).closest('a, button')) return
                  router.push(href)
                }} data-row-id={member.friendId}
              >
                <Td grow><FolderDotName>
                  <span  title={member.displayName}>{member.displayName}</span>

                </FolderDotName></Td>
                <Td collapseAt={ecSource ? undefined : 'narrow'} className={styles.colRank}><span className={styles.cellMain} title={member.rankReason}>{ecSource ? member.rank ?? '未設定' : rankLabel(member.rank) ?? '—'}</span></Td>
                <Td align="right" className={styles.colBalance}>
                  <span className={styles.cellMain}>{formatMileageNumber(member.available)}</span>
                  {!ecSource && member.pending > 0 ? <span className={styles.cellSub}>{`保留 ${formatMileageNumber(member.pending)}`}</span> : null}
                </Td>
                {!ecSource ? <Td align="right" className={styles.colChange}><span className={styles.cellMain}>{signed(member.monthChange)}</span></Td> : null}
                {!ecSource ? <Td align="right" className={styles.colBalance}><span className={styles.cellMain} title={member.nextExpiringAt ? `次は ${formatMileageDate(member.nextExpiringAt)}` : undefined}>{expiringText(member)}</span></Td> : null}
                <Td collapseAt="narrow" className={styles.colLast}><span className={styles.cellMain}>{formatMileageMonthDay(member.lastChangedAt)}</span></Td>
                <Td align="right" className={styles.colOpsMenu}><BalanceRowMenu friendId={member.friendId} friendName={member.displayName} readonly={readonly || ecSource} /></Td>
              </Tr>
            )
          })}
        </tbody>
      </DataTable>
    </div>
  )

  const body = loading ? (
    <ListState kind="loading" title="マイルの残高を読み込んでいます" />
  ) : loadError ? (
    <StateCard
      tone="error"
      title="マイルの残高を読み込めませんでした"
      description="数の帯は「—」、道具はそのまま使える。残高の再読み込みもここから"
      action={<RetryButton onRetry={() => void reloadAll()} />}
    />
  ) : members.length === 0 ? (
    search.trim() || chipActive ? (
      <StateCard title="条件に合う友だちはいません" description="名前の検索や絞り込みを外すと、すべて出ます" action={<Button type="button" onClick={resetAll}>条件を外す</Button>} />
    ) : (
      <StateCard title="まだ残高がありません" description="たまる決めごとを作ると、友だちにマイルがたまりはじめます" />
    )
  ) : (
    table
  )

  const pager = !loading && !loadError && members.length > 0 ? (
    <div className={styles.pagerRow}>
      <Pagination page={currentPage} pageCount={pageCount} range={{ total: filteredTotal, first: offset + 1, last: Math.min(offset + members.length, filteredTotal), unit: '人' }} onPageChange={(nextPage) => setOffset((nextPage - 1) * pageSize)} disabled={loading} />
    </div>
  ) : null
  /* 絵 ：表 → ページ送り → 下の案内の順。 */
  const footer = !loading && !loadError && members.length > 0 ? (
    <>
      {pager}
    </>
  ) : undefined

  return (
    <MileageFrame
      help={ecSource ? '残高とランクはECから受け取った情報です。' : '行を押すと、その人のマイルの詳細（明細・増やす／減らす）を開きます。CSV はこのページの残高を書き出します。'} explanationInset="content"
      explanation={ecSource ? 'ECと同期した残高とランクを表示しています。未連携の友だちは残高を確認できません。' : '残高は数分ごとに計算し直します。「残高を再読み込み」で今すぐ計算し直せます。'}
      actions={<div className={styles.headActions}>
        <Button onClick={() => void reloadAll()} disabled={loading}>
          <RefreshCw size={16} aria-hidden="true" /> 残高を再読み込み
        </Button>
        <Button onClick={exportCsv} disabled={members.length === 0}>
          <Download size={16} aria-hidden="true" /> この頁の残高を CSV
        </Button>
      </div>}
      stats={stats}
      toolbar={toolbar}
      pagination={footer}
      overlays={
        <Dialog
          open={rejectTarget !== null && rejectScope?.generation === scope.current.generation}
          contentLayout="form"
          title="この変更依頼を差し戻しますか？"
          description={rejectTarget ? `${rejectTarget.friend_display_name ?? rejectTarget.friend_id} への変更は行われず、台帳は変わりません。` : undefined}
          tone="destructive"
          confirmLabel="差し戻す"
          cancelLabel="キャンセル"
          busy={approvalBusyId !== null}
          error={approvalError || undefined}
          onCancel={() => { if (approvalBusyId === null) setRejectTarget(null) }}
          onConfirm={() => { if (rejectTarget && rejectScope?.generation === scope.current.generation) void decideApproval(rejectTarget.id, 'reject', rejectReason.trim() || undefined) }}
        >
          {rejectScope ? <OperationTargetSummary accounts={[{ id: rejectScope.id }]} /> : null}
          <Field label="差し戻す理由"><SaveErrorField names={["rejectReason","reject_reason"]}><SharedTextArea
              className={styles.textarea}
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
              placeholder="例：調整の根拠となる資料を確認できませんでした"
              rows={3}
            /></SaveErrorField></Field>
        </Dialog>
      }
    >
      {body}
    </MileageFrame>
  )
}
