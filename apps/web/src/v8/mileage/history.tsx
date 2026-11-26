'use client'

import { describeApiFailure } from '@/components/shared/api-error-message'
import { viewName, isGranted, PRESETS, monthStart, daysAgo } from './history-model'
import { validateHistoryPeriod } from './history-period'
import DateField from '@/components/shared/date-field'
import Select from '@/components/shared/select'
import { useListUrlValue } from '@/components/shared/list-url-state'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { Download, Plus } from 'lucide-react'
import { useAccount } from '@/contexts/account-context'
import {
  ApiError,
  api,
  type MileageAdminHistory,
  type MileageAdminHistoryItem,
  type MileageHistoryItem,
} from '@/lib/api'

import { csvCell } from '@/lib/presentation'
import Button from '@/components/shared/button'
import Dialog from '@/components/shared/dialog'
import SegmentedControl from '@/components/shared/segmented'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import { mileagePaginationTotal } from './display'
import HistoryTable from './history-table'
import HistoryStats from './history-stats'
import HistoryPager from './history-pager'
import { MileageFrame, useMileageShell } from './frame'
import { MileageToolbar, PerPageSelect, RetryButton, SavedSelect, StateCard, ToolbarNotices } from './parts'
import styles from './mileage.module.css'
import { Field } from '@/components/shared/form-controls'
import { csvFileName } from '@/lib/csv-file-name'

import { SaveErrorField } from '@/components/shared/save-form-errors'
import { TextArea as SharedTextArea } from '@/components/shared/text-field'
import OperationTargetSummary from '@/components/shared/operation-target-summary'

export default function HistoryTab() {
  const { readonly: roleReadonly, narrow, balanceSource } = useMileageShell()
  const ecSource = balanceSource === 'ec'
  const readonly = roleReadonly || ecSource
  const router = useRouter()
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const scope = useRef({ id: selectedAccountId, generation: 0 })
  if (scope.current.id !== selectedAccountId) scope.current = { id: selectedAccountId, generation: scope.current.generation + 1 }
  const loadedScope = useRef(-1)
  const readonlyRef = useRef(readonly)
  readonlyRef.current = readonly
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const requestRef = useRef(0)
  const periodRequestRef = useRef(0)
  const periodInFlightRef = useRef<number | null>(null)
  const [result, setResult] = useState<MileageAdminHistory | null>(null)
  const [periodResult, setPeriodResult] = useState<MileageAdminHistory | null>(null)
  const [periodLoading, setPeriodLoading] = useState(true)
  const [periodSummaryError, setPeriodSummaryError] = useState(false)
  const [loadedAccountId, setLoadedAccountId] = useState<string | null>(null)
  const [exportError, setExportError] = useState('')
  const [pendingAction, setPendingAction] = useState<{ kind: 'confirm' | 'void'; item: MileageAdminHistoryItem; accountId: string; generation: number } | null>(null)
  const [pendingReason, setPendingReason] = useState('')
  const [pendingBusy, setPendingBusy] = useState(false)
  const [pendingError, setPendingError] = useState('')
  const [searchInput, setSearchInput] = useListUrlValue('q', '')
  const [search, setSearch] = useListUrlValue('q', '')
  const [grantedOnly, setGrantedOnly] = useListUrlValue('grantedOnly', false)
  const [spentOnly, setSpentOnly] = useListUrlValue('spentOnly', false)
  const [preset, setPreset] = useState('all')
  const [customFrom, setCustomFrom] = useListUrlValue('from', '')
  const [to, setTo] = useListUrlValue('to', '')
  const [customEntryType, setCustomEntryType] = useListUrlValue<MileageHistoryItem['entryType'] | ''>('entryType', '')
  const [customStatus, setCustomStatus] = useListUrlValue<MileageHistoryItem['status'] | ''>('status', '')
  const [customMode, setCustomMode] = useListUrlValue<'automatic' | 'manual' | ''>('mode', '')
  const [filterOpen, setFilterOpen] = useState(false)
  const [filterDraft, setFilterDraft] = useState({ from: '', to: '', entryType: '', status: '', mode: '' })
  const [filterError, setFilterError] = useState<string | null>(null)
  const [inputRejected, setInputRejected] = useState<string | null>(null)
  const [pageSize, setPageSize] = useListUrlValue('pageSize', 20)
  const [page, setPage] = useListUrlValue('page', 1)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const applyPreset = (value: string) => {
    if (value === 'custom') {
      setFilterDraft({ from: customFrom, to, entryType: customEntryType, status: customStatus, mode: customMode })
      setFilterError(null)
      setFilterOpen(true)
      return
    }
    setCustomFrom(''); setTo(''); setCustomEntryType(''); setCustomStatus(''); setCustomMode('')
    setPreset(value)
    setPage(1)
    setGrantedOnly(value === 'granted')
    setSpentOnly(value === 'spent')
  }
  const presetValue = customFrom || to || customEntryType || customStatus || customMode ? 'custom'
    : preset === 'all' && !grantedOnly && !spentOnly ? 'all'
    : preset !== 'all' ? preset
      : grantedOnly ? 'granted' : 'spent'

  const from = preset === 'month' ? monthStart() : preset === 'week' ? daysAgo(6) : customFrom
  const periodError = validateHistoryPeriod(from, to)
  const modeFilter: 'automatic' | 'manual' | undefined = preset === 'manual' ? 'manual' : customMode || undefined
  const entryTypeFilter: MileageHistoryItem['entryType'] | undefined = grantedOnly ? 'grant' : customEntryType || undefined

  const load = useCallback(async () => {
    const request = ++requestRef.current
    const periodRequest = ++periodRequestRef.current
    periodInFlightRef.current = null
    const requestScope = scope.current.generation
    setLoading(true)
    setError(false)
    setPeriodLoading(true)
    setPeriodSummaryError(false)
    setExportError('')
    setInputRejected(null)
    if (!selectedAccountId) {
      setResult(null); setPeriodResult(null); setLoadedAccountId(null); setLoading(false); setPeriodLoading(false)
      return
    }
    if (validateHistoryPeriod(from, to)) {
      setResult(null); setPeriodResult(null); setLoading(false); setPeriodLoading(false)
      return
    }
    try {
      const [response, period] = await Promise.all([api.mileage.history({
        accountId: selectedAccountId ?? '',
        search: search || undefined,
        entryType: entryTypeFilter,
        mode: modeFilter,
        from: from || undefined,
        to: to || undefined,
        status: customStatus || undefined,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }), api.mileage.history({ accountId: selectedAccountId ?? '', from: daysAgo(29), to: daysAgo(0), limit: 1, offset: 0 }).catch(() => null)])
      if (request !== requestRef.current || requestScope !== scope.current.generation) return
      if (!response.success) throw new Error(response.error)
      /* 「使った・取り消しのみ」は口に種類の絞り込みが無いので、付けた分を手元で除く。 */
      if (spentOnly) {
        response.data.items = response.data.items.filter((item) => !isGranted(item))
      }
      const periodData = period?.success && Array.isArray(period.data?.summary?.byType) ? period.data : null
      if (periodRequest === periodRequestRef.current) {
        setPeriodResult(periodData)
        setPeriodSummaryError(periodData === null)
      }
      setResult(response.data)
      setLoadedAccountId(selectedAccountId)
      loadedScope.current = requestScope
    } catch (caught) {
      if (request !== requestRef.current || requestScope !== scope.current.generation) return
      setResult(null); setPeriodResult(null); setPeriodSummaryError(false)
      if (caught instanceof ApiError && caught.status === 400) setInputRejected('入力した条件を確認してください。開始日は終了日より前の日付を入力してください。')
      else setError(true)
    } finally {
      if (request === requestRef.current && requestScope === scope.current.generation) setLoading(false)
      if (periodRequest === periodRequestRef.current && requestScope === scope.current.generation) setPeriodLoading(false)
    }
  }, [entryTypeFilter, from, modeFilter, page, pageSize, search, selectedAccountId, spentOnly, to, customStatus])

  const reloadPeriodSummary = useCallback(async () => {
    if (!selectedAccountId || periodInFlightRef.current !== null) return
    const periodRequest = ++periodRequestRef.current
    const requestScope = scope.current.generation
    periodInFlightRef.current = periodRequest
    setPeriodLoading(true)
    setPeriodSummaryError(false)
    try {
      const period = await api.mileage.history({
        accountId: selectedAccountId,
        from: daysAgo(29),
        to: daysAgo(0),
        limit: 1,
        offset: 0,
      })
      if (periodRequest !== periodRequestRef.current || requestScope !== scope.current.generation) return
      const periodData = period?.success && Array.isArray(period.data?.summary?.byType) ? period.data : null
      setPeriodResult(periodData)
      setPeriodSummaryError(periodData === null)
    } catch {
      if (periodRequest !== periodRequestRef.current || requestScope !== scope.current.generation) return
      setPeriodResult(null)
      setPeriodSummaryError(true)
    } finally {
      if (periodInFlightRef.current === periodRequest) periodInFlightRef.current = null
      if (periodRequest === periodRequestRef.current && requestScope === scope.current.generation) setPeriodLoading(false)
    }
  }, [selectedAccountId])

  useEffect(() => {
    if (accountLoading) return
    void load()
  }, [accountLoading, load])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1)
      setSearch(searchInput.trim())
    }, 0)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  const items = useMemo(() => result?.items ?? [], [result])
  const total = mileagePaginationTotal(result)
  const pageCount = Math.max(1, Math.ceil((total ?? 0) / pageSize))
  const byType = periodResult?.summary.byType ?? []
  const countOf = (entryType: MileageHistoryItem['entryType']) =>
    byType.find((item) => item.entryType === entryType)?.count ?? 0
  const amountOf = (entryType: MileageHistoryItem['entryType']) =>
    byType.find((item) => item.entryType === entryType)?.amount ?? 0
  const grantedCount = countOf('grant')
  const reversalCount = countOf('reversal')

  const canExport = !accountLoading && !loading && !error && !!selectedAccountId
    && loadedAccountId === selectedAccountId && items.length > 0
  const exportCsv = useCallback(() => {
    if (!canExport) return
    setExportError('')
    try {
      const rows = items.map((item) => [
        item.occurredAt,
        viewName(item),
        item.amount,
        item.reason,
        item.balanceAfter ?? '',
        item.mode === 'manual' ? item.executedByStaffName ?? '担当者未取得' : '自動',
      ])
      const csv = [['日時', '友だち', '増減', '理由', ecSource ? 'musuboの残高' : '残高', 'だれが'], ...rows]
        .map((row) => row.map((value) => csvCell(value)).join(','))
        .join('\n')
      const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = csvFileName("マイル履歴")
      anchor.click()
      URL.revokeObjectURL(url)
    } catch {
      setExportError('CSVを書き出せませんでした。もう一度お試しください。')
    }
  }, [canExport, items, ecSource])

  const runPendingAction = async () => {
    if (!pendingAction || pendingBusy || !alive.current || readonlyRef.current || pendingAction.generation !== scope.current.generation || pendingAction.accountId !== scope.current.id) return
    const reason = pendingReason.trim()
    if (!reason) {
      setPendingError('理由を入力してください。')
      return
    }
    setPendingBusy(true)
    setPendingError('')
    try {
      const response = pendingAction.kind === 'confirm'
        ? await api.mileage.confirmMileageEntry(pendingAction.item.id, { accountId: pendingAction.accountId, reason })
        : await api.mileage.voidMileageEntry(pendingAction.item.id, { accountId: pendingAction.accountId, reason })
      if (!alive.current || pendingAction.generation !== scope.current.generation) return
      if (!response.success) throw new Error(response.error)
      setPendingAction(null)
      setPendingReason('')
      await load()
    } catch (caught) {
      if (!alive.current || pendingAction.generation !== scope.current.generation) return
      setPendingError(describeApiFailure(caught, '保存'))
    } finally {
      setPendingBusy(false)
    }
  }

  const openPending = (kind: 'confirm' | 'void', item: MileageAdminHistoryItem) => {
    if (!selectedAccountId || readonlyRef.current || loadedScope.current !== scope.current.generation) return
    setPendingAction({ kind, item, accountId: selectedAccountId, generation: scope.current.generation })
    setPendingReason('')
    setPendingError('')
  }

  const filtered = search.trim() || grantedOnly || spentOnly || preset !== 'all' || customFrom || to || customEntryType || customStatus || customMode
  const resetAll = () => {
    setCustomFrom(''); setTo(''); setCustomEntryType(''); setCustomStatus(''); setCustomMode('')
    setSearchInput('')
    setSearch('')
    setGrantedOnly(false)
    setSpentOnly(false)
    setPreset('all')
    setPage(1)
  }

  const ready = !loading && !error && !periodLoading && !periodSummaryError && periodResult !== null

  const stats = <HistoryStats title="直近30日の動き"
    ready={ready} loading={loading || periodLoading} failed={error} summaryFailed={!loading && !error && periodSummaryError}
    total={mileagePaginationTotal(periodResult)} grantedCount={grantedCount}
    spendCount={countOf('spend')} reversalCount={reversalCount}
    manualCount={result?.summary.manualCount} pendingCount={result?.summary.pendingCount}
    grantAmount={amountOf('grant')} spendAmount={amountOf('spend')} />

  const chips = (
    <SegmentedControl
      aria-label="種類で絞り込む"
      value={grantedOnly ? 'granted' : spentOnly ? 'spent' : 'all'}
      onChange={(next) => {
        setPreset('all')
        setPage(1)
        setGrantedOnly(next === 'granted')
        setSpentOnly(next === 'spent')
      }}
      options={[
        { value: 'all', label: 'すべて' },
        { value: 'granted', label: '付けた' },
        { value: 'spent', label: '使った・取り消し' },
      ]}
    />
  )

  const toolbar = (
    <MileageToolbar
      narrow={narrow}
      notices={<>
        {ecSource ? <Notice tone="info">これはmusubo側の履歴です。現在の残高とランクはECと同期しています。</Notice> : null}
        {!loading && !error && periodSummaryError ? (
          <div className={styles.fullRow}>
            <Notice
              tone="warn"
              message="直近30日の集計を読み込めませんでした。履歴の一覧はそのまま確認できます。"
              action={
                <Button
                  variant="text"
                  size="inline"
                  onClick={() => void reloadPeriodSummary()}
                  disabled={periodLoading}
                  busy={periodLoading}
                  busyLabel="読み込んでいます"
                >
                  集計を読み直す
                </Button>
              }
            />
          </div>
        ) : null}
        <ToolbarNotices error={exportError} />
      </>}
      search={{
        placeholder: '友だち・できごとで探す',
        value: searchInput,
        onChange: (value) => {
          setSearchInput(value)
          if (!value) { setSearch(''); setPage(1) }
        },
      }}
      chips={chips}
      trailing={<>
        <SavedSelect value={presetValue} options={PRESETS} onChange={applyPreset} />
        <PerPageSelect value={pageSize} onChange={(next) => { setPage(1); setPageSize(next) }} />
      </>}
    />
  )

  const table = <HistoryTable {...{ items, readonly, menuId, setMenuId, openPending, viewName }} ecSource={ecSource} />

  const body = !accountLoading && !selectedAccountId ? (
    <ListState kind="empty" title="LINEアカウントを選択してください" description="共通トップバーでLINEアカウントを選ぶと、マイルの履歴を確認できます。" />
  ) : loading ? (
    <ListState kind="loading" title="マイルの履歴を読み込んでいます" />
  ) : (periodError ?? inputRejected) ? (
    <StateCard title="日付の条件を確認してください" description={periodError ?? inputRejected ?? undefined} />
  ) : error ? (
    <StateCard tone="error" title="マイルの履歴を読み込めませんでした" description="数の帯は「—」にしています。道具はそのまま使えます。" action={<RetryButton onRetry={() => void load()} />} />
  ) : items.length === 0 ? (

    spentOnly && pageCount > 1 ? (
      <StateCard title="このページには、使った・取り消しの履歴がありません" description="この絞り込みは1ページずつ見ています。ほかのページにある場合があります。下のページ送りで確かめてください。" />
    ) : filtered ? (
      <StateCard title="条件に合う履歴はありません" description="検索や絞り込みを外すと、すべて出ます" action={<Button type="button" onClick={resetAll}>条件を外す</Button>} />
    ) : (
      <StateCard title="まだ履歴がありません" description="マイルを付けたり使ったりすると、ここに記録が残ります" />
    )
  ) : table


  const footer = !loading && !error && total !== null && (items.length > 0 || (spentOnly && pageCount > 1)) ? (
    <div className={styles.pagerStack}>
      <HistoryPager {...{ spentOnly, total, page, pageSize, items, pageCount, loading, setPage }} />
      {/* 行の操作の案内はページ送りの下の1行（絵 oRbJi の「下の段」）。 */}
      <p className={styles.footNoteFlush}>{ecSource ? 'これはmusubo側の履歴です。現在の残高はECと同期しています。' : '行を押すと、その友だちのマイルの詳細を開きます。「増やす・減らす」は理由を書いて明細を足します（オーナー・管理者だけ）。'}</p>
    </div>
  ) : undefined

  return (
    <MileageFrame
      explanation={ecSource ? 'ここはmusuboの過去の履歴です。現在の残高とランクはECと同期しています。' : '明細はあとから消せません。間違えて付けたときは「減らす」で取り消しの明細を足します。'}
      actions={<div className={styles.headActions}>
        <Button onClick={exportCsv} disabled={!canExport}>
          <Download size={16} aria-hidden="true" /> CSVで書き出す
        </Button>
        {/* 閲覧のみの人には出さない。 */}
        {!readonly ? (
          <Button href="/mileage?tab=balances" title="友だちを選んで増減します">
            <Plus size={16} aria-hidden="true" /> 増やす・減らす
          </Button>
        ) : null}
      </div>}
      stats={stats}
      toolbar={toolbar}
      pagination={footer}
      overlays={
        <>
        <Dialog open={filterOpen} title="履歴の条件を指定" confirmLabel="この条件で絞る" onCancel={() => setFilterOpen(false)} onConfirm={() => {
          const invalid = validateHistoryPeriod(filterDraft.from, filterDraft.to)
          if (invalid) { setFilterError(invalid); return }
          setPreset('all'); setGrantedOnly(false); setSpentOnly(false); setPage(1)
          setCustomFrom(filterDraft.from); setTo(filterDraft.to)
          setCustomEntryType(filterDraft.entryType as MileageHistoryItem['entryType'] | '')
          setCustomStatus(filterDraft.status as MileageHistoryItem['status'] | '')
          setCustomMode(filterDraft.mode as 'automatic' | 'manual' | '')
          setFilterOpen(false)
        }}>
          <div className={styles.dlgBody}>
            <Field label="開始日"><DateField aria-label="開始日" value={filterDraft.from} invalid={Boolean(filterError ?? periodError ?? inputRejected)} onChange={(value) => setFilterDraft((draft) => ({ ...draft, from: value }))} /></Field>
            <Field label="終了日"><DateField aria-label="終了日" value={filterDraft.to} invalid={Boolean(filterError ?? periodError ?? inputRejected)} onChange={(value) => setFilterDraft((draft) => ({ ...draft, to: value }))} /></Field>
            {(filterError ?? periodError ?? inputRejected) ? <Notice tone="danger">{filterError ?? periodError ?? inputRejected}</Notice> : null}
            <Select label="種類" aria-label="種類" value={filterDraft.entryType} options={[{ value: '', label: 'すべての種類' }, { value: 'grant', label: '付与' }, { value: 'reversal', label: '取消' }, { value: 'spend', label: '使用' }, { value: 'expiration', label: '失効' }, { value: 'adjustment', label: '手動調整' }]} onChange={(value) => setFilterDraft((draft) => ({ ...draft, entryType: value }))} />
            <Select label="状態" aria-label="状態" value={filterDraft.status} options={[{ value: '', label: 'すべての状態' }, { value: 'available', label: '利用可能' }, { value: 'pending', label: '確定待ち' }, { value: 'void', label: '取消済み' }]} onChange={(value) => setFilterDraft((draft) => ({ ...draft, status: value }))} />
            <Select label="動かした方法" aria-label="動かした方法" value={filterDraft.mode} options={[{ value: '', label: 'すべての方法' }, { value: 'automatic', label: '自動' }, { value: 'manual', label: '手動' }]} onChange={(value) => setFilterDraft((draft) => ({ ...draft, mode: value }))} />
          </div>
        </Dialog>
        <Dialog
          open={pendingAction !== null && pendingAction.generation === scope.current.generation}
          title={pendingAction?.kind === 'confirm' ? 'このマイルを確定しますか？' : 'このマイルを取り消しますか？'}
          description={pendingAction?.kind === 'confirm'
            ? '確定待ちから利用可能に変わります。'
            : '取り消すと逆向きの記録が残ります。もとの記録そのものは消えません。'}
          tone={pendingAction?.kind === 'void' ? 'destructive' : 'default'}
          confirmLabel={pendingAction?.kind === 'confirm' ? '確定する' : '取り消す'}
          busy={pendingBusy}
          error={pendingError || undefined}
          onCancel={() => { if (!pendingBusy) setPendingAction(null) }}
          onConfirm={() => runPendingAction()}
        >
          {pendingAction ? <OperationTargetSummary accounts={[{ id: pendingAction.accountId }]} /> : null}
          <Field label="理由" required><SaveErrorField names={["pendingReason","pending_reason"]}><SharedTextArea
              className={styles.textarea}
              value={pendingReason}
              onChange={(event) => setPendingReason(event.target.value)}
              placeholder={pendingAction?.kind === 'confirm' ? '例：入金を確認しました' : '例：予約がキャンセルされました'}
              rows={3}
            /></SaveErrorField></Field>
        </Dialog>
        </>
      }
    >
      {body}
    </MileageFrame>
  )
}
