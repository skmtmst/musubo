'use client'
import { DetailPreview } from '@/components/shared/detail-content'
import { ListPageStats } from '@/components/templates/list-page'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { useListUrlValue } from '@/components/shared/list-url-state'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Bookmark, Download, FilePen, History, Mail, Plus } from 'lucide-react'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { RowMenu } from '@/components/shared/row-actions'
import type { ActionMenuItem } from '@/components/shared/action-menu'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import Dialog from '@/components/shared/dialog'
import ListState from '@/components/shared/list-state'
import SearchField from '@/components/shared/search-field'
import { api, type AnalyticsReportRun, type AnalyticsReportSchedule, type RecentOneTimeReport, type SavedAnalyticsSnapshot, type SavedAnalyticsSummary } from '@/lib/api'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { formatNumber } from '@/lib/format'
import { StatePill, shortDateTime, shortDay } from './common'
import { downloadCsv, formatAnalyticsDate, formatAnalyticsDateTime, useRegisterExport, CsvExportButton } from './parts'
import styles from './analytics.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { csvFileName } from '@/lib/csv-file-name'
import { emptyValue, EmptyCell } from '@/components/shared/empty-value'
import { useSaveFormErrors, SaveErrorScope } from '@/components/shared/save-form-errors'
import Notice from '@/components/shared/notice'
import { DetailColumns } from '@/components/templates/detail-columns'
import Card, { CardHeader } from '@/components/shared/card'
import { ActionCell, DataTable, RowNameButton, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'

/*
 * ★V8 分析「保存した分析」（Pencil ）。
 * 数の帯 → 道具の段（探す・説明）→ 左に保存した分析の表、右に選んだ分析の履歴（結果を見る・CSV・内容を変える）
 * → 定期レポート（作る・止める・また送る・しまう）→ 1回だけ送った結果。
 * 呼ぶ口・世代の守り・失敗の言い分け・CSV は今の画面（SavedAnalyticsTab）と同じ。
 */

const TABLE_LAYOUT = { headHeight: 'var(--polish-table-head)', rowHeight: 'var(--tpl-list-row-h)', gap: 'var(--polish-space-row)', padding: '0 var(--tpl-list-inset)', bodyTextSize: 'var(--polish-text-body)' }

const SAVED_STATE_LABELS: Record<SavedAnalyticsSnapshot['state'], string> = { available: '利用可能', partial: '一部集計', unavailable: '未取得', failed: '失敗' }
const REPORT_STATUS_LABELS: Record<AnalyticsReportSchedule['status'], string> = { active: '有効', paused: '停止中', archived: 'アーカイブ' }
const RUN_STATE_LABELS: Record<AnalyticsReportRun['state'], string> = { running: '送信中', available: '送信済み', partial: '一部だけ送信', unavailable: '未取得', failed: '失敗' }

function runErrorLabel(errorCode: string | null, state: AnalyticsReportRun['state']): string | null {
  if (state !== 'failed') return null
  if (errorCode === 'worker_interrupted') return '送信の途中で止まりました（送達不明）。届いたか分からない宛先へは送り直さず、確認してから判断してください。'
  if (errorCode === 'schedule_changed_before_send') return '送る直前に内容が変わったため、旧設定では送りませんでした。'
  return errorCode ? `送れませんでした（${errorCode}）。宛先別の結果を確かめてください。` : '送れませんでした。宛先別の結果を確かめてください。'
}
const cadenceLabel = (schedule: AnalyticsReportSchedule) => schedule.cadence === 'weekly'
  ? `毎週 ${'日月火水木金土'[schedule.weekday ?? 0]} ${schedule.sendTime}`
  : `毎月 ${schedule.monthDay}日 ${schedule.sendTime}`
const kindLabel = (kind: 'cross' | 'funnel') => kind === 'cross' ? 'クロス分析' : 'ファネル'
const periodShort = (from: string, to: string) => `${shortDay(from)}〜${shortDay(to)}`

/** 保存した時点の結果の葉の値を並べる（0 は「0件」、欠けは「未取得」）。今の画面と同じ。 */
function summarizeSnapshotResult(result: unknown, limit = 12): Array<{ path: string; text: string }> {
  const rows: Array<{ path: string; text: string }> = []
  const visit = (node: unknown, path: string, depth: number) => {
    if (rows.length >= limit || depth > 3) return
    if (node === null || node === undefined) { rows.push({ path, text: '未取得' }); return }
    if (typeof node === 'number' || typeof node === 'string' || typeof node === 'boolean') { rows.push({ path, text: typeof node === 'number' ? formatNumber(node) : String(node) }); return }
    if (Array.isArray(node)) {
      if (node.length === 0) rows.push({ path, text: '0件' })
      node.slice(0, 4).forEach((item, index) => visit(item, `${path}[${index + 1}]`, depth + 1))
      if (node.length > 4) rows.push({ path, text: `ほか${node.length - 4} 件` })
      return
    }
    if (typeof node === 'object') {
      const entries = Object.entries(node)
      if (entries.length === 0) rows.push({ path, text: '—' })
      entries.slice(0, 8).forEach(([key, child]) => visit(child, path ? `${path}・${key}` : key, depth + 1))
    }
  }
  visit(result, '', 0)
  return rows.filter((row) => row.path !== '' || row.text !== '—')
}

function latestPill(item: SavedAnalyticsSummary) {
  const latest = item.latestSnapshot
  if (!latest) return <EmptyCell />
  // 版ずれ（定義が古い）は集計状態とは別の軸。版ずれを先に出す。
  if (latest.definitionStale) return <StatePill tone="info">更新後未集計</StatePill>
  if (latest.state === 'available') return <StatePill tone="ok">最新の期間</StatePill>
  return <StatePill tone={latest.state === 'partial' ? 'warn' : 'neutral'}>{SAVED_STATE_LABELS[latest.state]}</StatePill>
}

/**
 * 定期レポートの行の「…」（行の右端は「…」1つ・）：内容を変える・止める／また送る・しまう。
 * 止める・また送る・しまうの動きは一覧の側が持ち、ここは項目に並べるだけ。
 */
function ScheduleMenu({ schedule, busy, onPause, onResume, onArchive }: { schedule: AnalyticsReportSchedule; busy: boolean; onPause: () => void; onResume: () => void; onArchive: () => void }) {
  const router = useRouter()
  const items: ActionMenuItem[] = [{ id: 'edit', label: '内容を変える', onSelect: () => router.push(`/analytics/reports/new?id=${schedule.id}`) }]
  if (schedule.status === 'active') items.push({ id: 'pause', label: '止める', disabled: busy, onSelect: onPause })
  if (schedule.status === 'paused') items.push({ id: 'resume', label: 'また送る', disabled: busy, onSelect: onResume })
  items.push({ id: 'archive', label: 'しまう', tone: 'danger', disabled: busy, onSelect: onArchive })
  return <span className={styles.rowMenu}>
    <RowMenu appearance="box" label={`定期レポート「${schedule.name}」の操作`} items={items} />
  </span>
}

export default function SavedV8({ accountId, onCountChange, canManage }: { accountId: string; onCountChange?: (count: number | null) => void; canManage: boolean }) {
  const saveErrors = useSaveFormErrors()
  const [items, setItems] = useState<SavedAnalyticsSummary[]>([])
  const [query, setQuery] = useListUrlValue('q', '')
  const [selectedId, setSelectedId] = useState('')
  const [snapshots, setSnapshots] = useState<SavedAnalyticsSnapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [snapshotLoading, setSnapshotLoading] = useState(false)
  const [error, setError] = useState('')
  const [schedules, setSchedules] = useState<AnalyticsReportSchedule[]>([])
  const [recentOneTime, setRecentOneTime] = useState<RecentOneTimeReport[]>([])
  const [schedulesLoading, setSchedulesLoading] = useState(true)
  const [schedulesError, setSchedulesError] = useState('')
  const [scheduleBusyId, setScheduleBusyId] = useState('')
  const [snapshotError, setSnapshotError] = useState('')
  const [savedReload, setSavedReload] = useState(0)
  const [snapshotReload, setSnapshotReload] = useState(0)
  const [archiveTarget, setArchiveTarget] = useState<AnalyticsReportSchedule | null>(null)
  const [archiveAccount, setArchiveAccount] = useState('')
  const archiveWindow = useRef<object>({})
  const archiveWindowAccount = useRef(accountId)
  if (archiveWindowAccount.current !== accountId) archiveWindow.current = {}
  archiveWindowAccount.current = accountId
  const renderedArchiveWindow = archiveWindow.current
  const currentAccount = useRef(accountId)
  currentAccount.current = accountId
  const [archiveError, setArchiveError] = useState('')
  const [archiveReviewRequired, setArchiveReviewRequired] = useState(false)
  const [historyExpanded, setHistoryExpanded] = useState(false)
  const [openSnapshot, setOpenSnapshot] = useState<SavedAnalyticsSnapshot | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true); setItems([]); setSelectedId(''); setSnapshots([]); setError('')
    void api.analytics.saved.list(accountId).then((response) => {
      if (!active) return
      if (!response.success) throw new Error(response.error)
      setItems(response.data)
      setSelectedId(response.data[0]?.id ?? '')
      // 件数表示はこの取得結果を使い回す。タブ名のためだけにもう1回叩かない。
      onCountChange?.(response.data.length)
    }).catch((caught: unknown) => {
      if (!active) return
      setError(describeApiFailure(caught, '読み込み'))
      onCountChange?.(null)
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, savedReload])

  const schedulesAlive = useRef(true)
  // 付くたびに true へ戻す（開発時の StrictMode の付ける→外す→付けるで false が残らないように）。
  useEffect(() => {
    schedulesAlive.current = true
    return () => { schedulesAlive.current = false }
  }, [])
  // 再読込の応答も「どのアカウントへ向けた取得か」の世代で比べる（切替後の遅い旧応答を捨てる）。
  const schedulesGen = useRef(0)
  const scheduleErrorText = (caught: unknown) => caught instanceof TypeError ? '定期レポートを確認できませんでした' : describeApiFailure(caught, '読み込み')
  const reloadSchedules = useCallback(() => {
    const gen = (schedulesGen.current += 1)
    setSchedulesLoading(true)
    void api.analytics.reportSchedules.list(accountId).then((response) => {
      if (!schedulesAlive.current || gen !== schedulesGen.current) return
      if (!response.success) throw new Error(response.error)
      setSchedules(response.data.items)
      setRecentOneTime(response.data.recentOneTime ?? [])
    }).catch((caught: unknown) => {
      if (!schedulesAlive.current || gen !== schedulesGen.current) return
      setSchedulesError(scheduleErrorText(caught))
    }).finally(() => { if (schedulesAlive.current && gen === schedulesGen.current) setSchedulesLoading(false) })
  }, [accountId])
  useEffect(() => {
    let active = true
    schedulesGen.current += 1
    setSchedulesLoading(true); setSchedules([]); setRecentOneTime([]); setSchedulesError('')
    // アカウントが変わったら前の確認窓は閉じる（別アカウントへ操作を送らない）。
    setArchiveTarget(null); setArchiveError(''); setArchiveReviewRequired(false)
    void api.analytics.reportSchedules.list(accountId).then((response) => {
      if (!active) return
      if (!response.success) throw new Error(response.error)
      setSchedules(response.data.items)
      setRecentOneTime(response.data.recentOneTime ?? [])
    }).catch((caught: unknown) => { if (active) setSchedulesError(scheduleErrorText(caught)) })
      .finally(() => { if (active) setSchedulesLoading(false) })
    return () => { active = false }
  }, [accountId])

  const changeScheduleStatus = async (schedule: AnalyticsReportSchedule, status: 'active' | 'paused' | 'archived') => {
    if (status === 'archived' && archiveReviewRequired) return false
    setScheduleBusyId(schedule.id)
    if (status === 'archived') setArchiveError('')
    try {
      const response = await api.analytics.reportSchedules.setStatus(accountId, schedule.id, { status, expectedUpdatedAt: schedule.updatedAt })
      if (!response.success) {
        // 先に誰かが変えていたら最新を読み直してから知らせる。
        const message = describeApiFailure(new Error(response.error), '更新')
        if (status === 'archived') { setArchiveError(message); setArchiveReviewRequired(true) }
        else setSchedulesError(message)
        reloadSchedules()
        return false
      }
      setSchedules((current) => status === 'archived' ? current.filter((item) => item.id !== schedule.id) : current.map((item) => (item.id === schedule.id ? response.data : item)))
      setArchiveTarget(null)
      return true
    } catch (caught) {
      saveErrors.capture(caught)
      const message = describeApiFailure(caught, '更新')
      if (status !== 'archived') setSchedulesError(message)
      if (status === 'archived') {
        setArchiveError(message)
        const code = caught && typeof caught === 'object' && 'status' in caught ? Number(caught.status) : null
        setArchiveReviewRequired(code === null || code === 409 || code >= 500)
      }
      return false
    } finally {
      setScheduleBusyId('')
    }
  }

  useEffect(() => {
    if (!selectedId) { setSnapshots([]); setSnapshotError(''); return }
    let active = true
    setSnapshotLoading(true); setSnapshots([]); setSnapshotError('')
    void api.analytics.saved.snapshots(accountId, selectedId).then((response) => {
      if (!active) return
      if (!response.success) throw new Error(response.error)
      setSnapshots(response.data)
      setSnapshotError('')
    }).catch((caught: unknown) => { if (active) setSnapshotError(describeApiFailure(caught, '読み込み')) })
      .finally(() => { if (active) setSnapshotLoading(false) })
    return () => { active = false }
  }, [accountId, selectedId, snapshotReload])

  const selected = items.find((item) => item.id === selectedId) ?? null
  const visibleItems = useMemo(() => items.filter((item) => `${item.name} ${item.createdByName}`.toLowerCase().includes(query.trim().toLowerCase())), [items, query])
  // 絞り込みで選んだ項目が見えなくなったら、見えている先頭へ選び直す。0件なら選択を外す。
  useEffect(() => {
    if (!visibleItems.some((item) => item.id === selectedId)) setSelectedId(visibleItems[0]?.id ?? '')
  }, [visibleItems, selectedId])
  // 「定義が古い」は版ずれだけを数える（未取得・失敗とは別の軸）。
  const staleCount = items.filter((item) => item.latestSnapshot?.definitionStale).length
  const exportSaved = () => downloadCsv(csvFileName("保存したレポート"), [
    ['分析名', '種類', '作った人', '定義版', '更新日時', '集計状態', '保存結果数'],
    ...visibleItems.map((item) => [
      item.name, kindLabel(item.kind), item.createdByName, item.currentVersionNumber, item.updatedAt,
      item.latestSnapshot ? `${SAVED_STATE_LABELS[item.latestSnapshot.state]}${item.latestSnapshot.definitionStale ? '（旧版の結果・更新後未集計）' : ''}` : null,
      item.snapshotCount,
    ]),
  ])
  const exportSnapshots = () => {
    if (!selected) return
    downloadCsv(csvFileName("保存したレポート"), [
      ['対象期間', 'データ締切', '集計状態', '結果の要約'],
      ...snapshots.map((snapshot) => [
        `${snapshot.periodFrom}〜${snapshot.periodTo}`, snapshot.dataCutoffAt, SAVED_STATE_LABELS[snapshot.state],
        summarizeSnapshotResult(snapshot.result, 6).map((row) => `${row.path || '結果'}: ${row.text}`).join(' / ').slice(0, 200),
      ]),
    ])
  }
  const exportDisabled = visibleItems.length === 0
  const exportReason = loading ? '保存した分析を読み込んでいます。' : error ? '保存した分析を読み込めないため書き出せません。' : (query.trim() ? '条件に合う分析がありません。' : '保存した分析はまだありません。')
  const snapshotExportReason = snapshotLoading ? '結果の履歴を読み込んでいます。' : snapshotError ? '結果の履歴を読み込めないため書き出せません。' : '保存された結果はありません。'
  useRegisterExport(exportSaved, exportDisabled, exportReason)
  const failed = error ? '読み込めませんでした' : null
  const crossCount = items.filter((item) => item.kind === 'cross').length

  return <SaveErrorScope errors={saveErrors}><>
    <ListPageStats><KpiBand className={styles.band}>
      <KpiCard presentation="band" title="保存した分析" icon={<Bookmark size={16} aria-hidden="true" />} value={error ? null : items.length} unit="件" detail={loading ? '読み込み中' : failed ?? `クロス分析 ${crossCount}・ファネル ${items.length - crossCount}`} loading={loading} />
      <KpiCard presentation="band" title="保存結果数" icon={<History size={16} aria-hidden="true" />} value={error ? null : items.reduce((sum, item) => sum + item.snapshotCount, 0)} unit="件" detail={failed ?? '時点ごとに固定した結果'} loading={loading} />
      <KpiCard presentation="band" title="定期レポート" icon={<Mail size={16} aria-hidden="true" />} value={error || schedulesError ? null : schedules.length} unit="件" detail={loading || schedulesLoading ? '読み込み中' : error || schedulesError ? '読み込めませんでした' : `動いている ${schedules.filter((item) => item.status === 'active').length}・止めている ${schedules.filter((item) => item.status === 'paused').length}`} loading={loading || schedulesLoading} />
      <KpiCard presentation="band" title="定義が古いもの" icon={<AlertTriangle size={16} aria-hidden="true" />} value={error ? null : staleCount} unit="件" detail={failed ?? '更新後まだ集計していない'} loading={loading} />
    </KpiBand></ListPageStats>
    <div className={styles.body} data-gap="tab">
      <div className={styles.toolbar}>
        <div className={styles.searchBox} data-w="saved"><SearchField id="saved-analysis-search" aria-label="分析名・作った人で探す" value={query} onChange={setQuery} onClear={() => setQuery('')} placeholder="分析名・作った人で探す" /></div>
        <span className={styles.spacer} />
        <span className={styles.caption} title="あとから条件が変わっても、保存時点の結果は書き換わりません。定期レポートは下の一覧で止めたり変えたりできます。">条件の定義と集計結果を分けて保存しています</span>
      </div>
      {loading ? <ListState kind="loading" title="保存した分析を読み込んでいます" />
        : error && items.length === 0 ? <ListState kind="error" title="保存した分析を読み込めませんでした" description="通信が切れたか、サーバが応えませんでした。登録した内容は消えていません。" onRetry={() => setSavedReload((n) => n + 1)} />
        : items.length === 0 ? <ListState kind="empty" title="保存した分析はまだありません" description="クロス分析かファネルを集計し、その結果を保存してください。" />
        : <DetailColumns presentation="analysis" variant="analysis-history" asideLabel="選んだ分析の履歴を開く" expanded={historyExpanded} onExpandedChange={setHistoryExpanded} aside={<DetailPreview titleId="saved-history-title" title={selected ? `選んだ分析の履歴：${selected.name}` : '選んだ分析の履歴'} description={selected ? `定期レポート ${schedulesLoading ? '確認中' : schedulesError ? emptyValue('unknown') : `${formatNumber(schedules.filter(schedule => schedule.savedAnalysisIds.includes(selected.id)).length)}件`}` : undefined} actions={{ primary: (selected ? <Button variant="primary" href={`/analytics?tab=${selected.kind}`} title="条件を変えるときは、元の分析で集計し直してから保存します"><FilePen size={16} aria-hidden="true"/>内容を変える</Button> : null), secondary: (selected ? <CsvExportButton variant="secondary" disabled={snapshots.length === 0} disabledReason={snapshotExportReason} onClick={exportSnapshots}><Download size={16} aria-hidden="true"/>CSVで書き出す</CsvExportButton> : null), primaryAllowed: canManage }}>
            {/* 履歴だけ取れないときは、その場所に小さく1行。一覧の失敗とは分ける。 */}
            {snapshotError ? <Notice tone="danger" className={styles.captionNoticePlacement} >結果の履歴を読み込めませんでした。<Button variant="text" size="inline" data-notice-inline-action type="button" onClick={() => setSnapshotReload((n) => n + 1)}>もう一度</Button></Notice> : null}
            {snapshotLoading ? <p data-card-footer className={styles.caption}>結果を読み込んでいます</p>
              : !selected ? <p data-card-footer className={styles.caption}>一覧から分析を選んでください</p>
              : snapshots.length === 0 ? <p data-card-footer className={styles.caption}>保存された結果はありません</p>
              : <DataTable aria-label="結果の履歴" columnSizing="content" columnLayout={{ ...TABLE_LAYOUT, rowHeight: 'var(--polish-table-row)' }}>
                <thead><TableHeadRow data-table-layout="columns">
                  <Th grow truncate>対象期間</Th>
                  <Th collapseAt="narrow" truncate>データ締切</Th>
                  <Th truncate>状態</Th>
                  <Th truncate>結果</Th>
                </TableHeadRow></thead><tbody>
                {snapshots.map((snapshot) => <Tr key={snapshot.id} data-table-layout="columns">
                  <Td grow title={`${formatAnalyticsDate(snapshot.periodFrom)}〜${formatAnalyticsDate(snapshot.periodTo)}・${kindLabel(snapshot.sourceKind)}・データ締切 ${formatAnalyticsDateTime(snapshot.dataCutoffAt)}`}><TruncatedText value={periodShort(snapshot.periodFrom, snapshot.periodTo)} /></Td>
                  <Td collapseAt="narrow"><TruncatedText value={shortDateTime(snapshot.dataCutoffAt).replace(/ 0(\d):/, ' $1:')} /></Td>
                  <Td><TruncatedText value={SAVED_STATE_LABELS[snapshot.state]} /></Td>
                  <ActionCell><Button variant="secondary" onClick={() => setOpenSnapshot(snapshot)}>結果を見る</Button></ActionCell>
                </Tr>)}</tbody>
              </DataTable>}

            <p data-card-footer className={styles.caption}>保存時点の固定結果です。いま集計し直しても変わりません。</p>
          </DetailPreview>} asideLayout="detail">
          <Card variant="records" contentPadding="0" aria-label="保存した分析の一覧"><DataTable aria-label="保存した分析" columnSizing="content" grid={{ columns: 'minmax(0, 1fr) var(--tpl-an-col-90) var(--tpl-an-col-80) var(--tpl-an-col-100) var(--tpl-an-col-100)', padding: '0 var(--tpl-list-inset)', headPadding: '0 var(--tpl-list-inset)', gap: 'var(--polish-space-row)', rowHeight: 'var(--tpl-list-row-h)', bodyTextSize: 'var(--polish-text-body)' }}>
            <thead><TableHeadRow><Th grow truncate>分析名</Th><Th truncate>種類</Th><Th truncate>作った人</Th><Th truncate>更新日時</Th><Th truncate>集計状態</Th></TableHeadRow></thead>
            <tbody>
              {visibleItems.length === 0 ? <Tr><Td colSpan={5}>条件に合う保存済み分析はありません。<Button onClick={() => setQuery('')}>キャンセル</Button></Td></Tr> : visibleItems.map(item => <Tr key={item.id} data-table-layout="columns" selected={selectedId === item.id} onOpen={() => setSelectedId(item.id)}>
                <Td grow><RowNameButton onClick={() => setSelectedId(item.id)} title={`${item.name}（第${item.currentVersionNumber}版・保存結果 ${formatNumber(item.snapshotCount)}件）`}><TruncatedText value={item.name} /></RowNameButton></Td>
                <Td><TruncatedText value={kindLabel(item.kind)} /></Td><Td><TruncatedText value={item.createdByName} /></Td><Td><TruncatedText value={shortDateTime(item.updatedAt)} /></Td>
                <Td title={item.latestSnapshot ? `${formatAnalyticsDate(item.latestSnapshot.periodFrom)}〜${formatAnalyticsDate(item.latestSnapshot.periodTo)}・${SAVED_STATE_LABELS[item.latestSnapshot.state]}` : undefined}>{latestPill(item)}</Td>
              </Tr>)}
            </tbody>
          </DataTable></Card>
        </DetailColumns>}

      <div className={styles.sectionHead}>
        <h2 className={styles.hoursTitle}>定期レポート</h2>
        <span className={styles.caption}>決まった曜日や日に、集計結果をメールやLINEへ届けられます。</span>
        <span className={styles.spacer} />
        {schedulesLoading ? <span className={styles.caption}>確認中</span> : null}
        {canManage ? <Button href="/analytics/reports/new" variant="secondary"><Plus size={16} aria-hidden="true" />定期レポートを作る</Button> : null}
      </div>
      {schedulesError ? <Notice tone="danger" ><span>{schedulesError}</span>{/* 版ずれの通知は reloadSchedules で消さない。消すのは手でやり直したこの入口だけ。 */}<Button variant="secondary" disabled={schedulesLoading} onClick={() => { setSchedulesError(''); reloadSchedules() }}>もう一度確認</Button></Notice> : null}
      {schedulesLoading ? null : schedules.length === 0 ? (schedulesError ? null : <ListState kind="empty" title="定期レポートはまだありません" description="決まった曜日や日に、集計結果をメールやLINEへ届けられます。" />)
        : <Card variant="records" contentPadding="0" aria-label="定期レポートの一覧">{/* 表を本文の直下に置くと、一覧の型が本文の左右の余白を 0 にする。枠で包んで余白を保つ。 */}<DataTable aria-label="定期レポート" columnSizing="content" columnLayout={TABLE_LAYOUT}>
          <thead><TableHeadRow data-table-layout="columns">
            <Th grow truncate>レポート名</Th>
            <Th truncate>間隔</Th>
            <Th truncate>次に届く予定</Th>
            <Th truncate>状態</Th>
            <Th truncate><span className="sr-only">操作</span></Th>
          </TableHeadRow></thead><tbody>
          {schedules.map((schedule) => <Tr key={schedule.id} data-table-layout="columns">
            <Td grow><TruncatedText value={String(schedule.name ?? '')} /></Td>
            <Td><TruncatedText value={schedule.isOneTime ? '1回だけ' : cadenceLabel(schedule)} /></Td>
            <Td><TruncatedText value={schedule.status === 'paused' ? emptyValue('unknown') : shortDateTime(schedule.nextRunAt).replace(/ 0(\d):/, ' $1:')} /></Td>
            <Td><span><StatePill tone={schedule.status === 'active' ? 'ok' : 'neutral'}>{REPORT_STATUS_LABELS[schedule.status]}</StatePill></span></Td>
            <ActionCell>{canManage && !schedule.isOneTime ? <ScheduleMenu schedule={schedule} busy={scheduleBusyId === schedule.id} onPause={() => void changeScheduleStatus(schedule, 'paused')} onResume={() => void changeScheduleStatus(schedule, 'active')} onArchive={() => { archiveWindow.current = {}; setArchiveAccount(accountId); setArchiveError(''); setArchiveReviewRequired(false); setArchiveTarget(schedule) }} /> : null}</ActionCell>
          </Tr>)}</tbody>
        </DataTable></Card>}

      {/* 1回だけ送った直近の結果。一覧からは消えるため、ここから失敗理由・宛先別結果へ進める。 */}
      {recentOneTime.length > 0 ? <section className={styles.table} aria-label="1回だけ送った結果">
        <div className={styles.thead}><span className={styles.colMain}>{`1回だけ送った結果（${formatNumber(recentOneTime.length)} 件）`}</span></div>
        {recentOneTime.map((item) => <div key={item.schedule.id} className={styles.trow} data-h="button">
          <span className={styles.colMain}><strong className={styles.cellStrong} ><TruncatedText value={String(item.schedule.name ?? '')} /></strong><span className={styles.cellSub}>{item.lastRun ? `${RUN_STATE_LABELS[item.lastRun.state] ?? item.lastRun.state}${runErrorLabel(item.lastRun.errorCode, item.lastRun.state) ? `：${runErrorLabel(item.lastRun.errorCode, item.lastRun.state)}` : ''}` : 'まだ送信されていません'}</span></span>
          <span className={styles.colOps}><Button href={`/analytics/reports/new?id=${item.schedule.id}`} variant="secondary">結果を見る</Button></span>
        </div>)}
      </section> : null}
    </div>
    <ConfirmDialog
      open={archiveTarget !== null && archiveAccount === accountId}
      title="定期レポートをしまいますか"
      description={archiveTarget ? `「${archiveTarget.name}」をしまうと、一覧から消えて今後の送信も止まります。` : ''}
      confirmLabel="しまう"
      destructive
      busy={archiveTarget !== null && scheduleBusyId === archiveTarget.id}
      error={archiveError || undefined} confirmDisabled={archiveReviewRequired} confirmDisabledReason="閉じて最新の定期レポートを確認してください。" onSuccess={() => { archiveWindow.current = {}; setArchiveTarget(null) }} onConfirm={() => archiveTarget && schedulesAlive.current && renderedArchiveWindow === archiveWindow.current && currentAccount.current === accountId ? changeScheduleStatus(archiveTarget, 'archived') : undefined}
      onCancel={() => { archiveWindow.current = {}; setArchiveTarget(null); setArchiveError(''); if (archiveReviewRequired) reloadSchedules(); setArchiveReviewRequired(false) }}
    ><OperationTargetSummary accounts={[{ id: archiveAccount }]} /></ConfirmDialog>
    <Dialog open={openSnapshot !== null} title="この時点の結果" description={openSnapshot ? `${formatAnalyticsDate(openSnapshot.periodFrom)}〜${formatAnalyticsDate(openSnapshot.periodTo)}・データ締切 ${formatAnalyticsDateTime(openSnapshot.dataCutoffAt)}・${SAVED_STATE_LABELS[openSnapshot.state]}` : undefined} confirmLabel="閉じる" onConfirm={() => setOpenSnapshot(null)} onCancel={() => setOpenSnapshot(null)}>
      {openSnapshot ? (() => {
        const rows = summarizeSnapshotResult(openSnapshot.result)
        return <dl className={styles.resultList}>
          {rows.length === 0 ? <div><dt>結果</dt><dd>保存された数値はありません</dd></div> : rows.map((row, index) => <div key={index}><dt title={row.path}>{row.path || '結果'}</dt><dd>{row.text}</dd></div>)}
          <p className={styles.caption}>保存時点の固定結果です。いま集計し直しても変わりません。</p>
        </dl>
      })() : null}
    </Dialog>
  </></SaveErrorScope>
}
