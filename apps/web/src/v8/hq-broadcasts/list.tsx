'use client'

import PermissionGatedButton from '@/components/shared/permission-gated-button'

import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'

import ListDateTime from '@/components/shared/list-date-time'

import { canManageRole, useTenantWideAccess, useStaffRole } from '@/lib/staff-role'
import { RowNameLink, DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import { ListToolbarFrame, ListToolbarRow, ListToolbarSearchSlot, ListToolbarEnd, ListToolbarSort } from '@/components/shared/list-toolbar'
import { useListUrlValue } from '@/components/shared/list-url-state';
import { useNarrowViewport } from '@/lib/use-narrow-viewport';
import Link, { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CalendarClock, FilePen, Inbox, List, MailOpen, Plus, Send, ArrowUpDown } from 'lucide-react'
import { type HqBroadcastRun, FOLDER_SELECT_COLORS } from '@line-crm/shared'
import { ListPage, ListPagePagination } from '@/components/templates/list-page';
import Button from '@/components/shared/button'
import EmptyList from '@/components/shared/empty-list'
import SegmentedControl from '@/components/shared/segmented'
import FolderPanel, { FolderPanelNote, type FolderPanelRow } from '@/components/shared/folder-panel'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import FolderEditorDialog from '@/components/shared/folder-editor-dialog'
import { FolderDotName, folderDisplayColor } from '@/components/shared/folder-dot'
import { deleteFolderDescription } from '@/components/shared/folder-row-actions';
import { describeFolderFailure } from '@/components/shared/folder-failure';
import { notifyToast } from '@/components/shared/toast';
import Pagination from '@/components/shared/pagination'
import SearchField from '@/components/shared/search-field'
import Select from '@/components/shared/select'
import StatusBadge from '@/components/shared/status-badge'
import { RowActions } from '@/components/shared/row-actions';
import { usePageTitle } from '@/components/shell/page-chrome';
import { formatNumber } from '@/lib/format';
import { hqBroadcastsApi } from '@/lib/hq-broadcasts-api';
import { failedCount, runBadge, sendTotals } from './model';
import styles from '../broadcasts/list.module.css'
import { emptyValue } from '@/components/shared/empty-value';
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors';

/*
 * ★V8 統括 一括配信の一覧（絵のV8.pen の行「統括」。2026-10-08 オーナー：店の一斉配信とほぼ同じ画面）。
 *
 * 店の一斉配信の一覧（src/v8/broadcasts/list.tsx）と同じ型（ListPage）・同じ共通部品（数の帯・札・表・ページ送り）・
 * 同じ見た目（店の一覧の CSS をそのまま読む）で組む。違いは「送るアカウント」だけ：
 *   - 配信条件の列は「N アカウント」と、誰に送るか（友だち全員／タグ）
 *   - 結果の列はアカウントの合計（届いた人数・失敗したアカウント）
 * 1行＝1回の一括配信。行を押すと詳細（送った結果）へ。動きは BEHAVIOR.md。
 */

type StatusKey = 'all' | 'scheduled' | 'draft' | 'sent' | 'error'
const STATUS_CHIPS: { key: StatusKey; label: string; icon: typeof List }[] = [
  { key: 'all', label: 'すべて', icon: List },
  { key: 'scheduled', label: '予約中', icon: CalendarClock },
  { key: 'draft', label: '下書き', icon: FilePen },
  { key: 'sent', label: '送信済み', icon: Send },
  { key: 'error', label: 'エラー', icon: AlertCircle },
]

/** 一覧の札と同じ分け方（runBadge の言葉から）。 */
function statusKeyOf(run: HqBroadcastRun): Exclude<StatusKey, 'all'> | null {
  const label = runBadge(run).label
  if (label === '下書き') return 'draft'
  if (label === '予約中' || label === '送っています') return 'scheduled'
  if (label === '送信済み' || label === '一部失敗') return 'sent'
  if (label === '失敗あり') return 'error'
  return null
}

function audienceText(run: HqBroadcastRun): string {
  return run.input?.audience?.kind === 'tag' ? `タグ：${run.input.audience.tagName}` : '友だち全員'
}

const NEW_HREF = '/hq/broadcasts/new'

/** 開封・クリックの率（API-18。アカウントの合計。1つでも数えていなければ出さない）。 */
function rateLine(targets: HqBroadcastRun['targets'], reached: number): string | null {
  if (reached <= 0 || targets.length === 0) return null
  if (targets.some((t) => t.openedCount == null || t.clickedCount == null)) return null
  const pct = (n: number) => `${((n / reached) * 100).toFixed(1)}%`
  return `開封 ${pct(targets.reduce((sum, t) => sum + (t.openedCount ?? 0), 0))}・クリック ${pct(targets.reduce((sum, t) => sum + (t.clickedCount ?? 0), 0))}`
}

/** 統括の一括配信のフォルダ（API-18。色は持たない）。 */
type HqFolder = { id: string; name: string; revision: number; item_count: number; color?: string | null }

export default function HqBroadcastList() {
  const saveErrors = useSaveFormErrors()

  const router = useRouter()
  const narrow = useNarrowViewport()
  usePageTitle('一括配信')
  const role = useStaffRole()
  const canManage = useTenantWideAccess()
  const [runs, setRuns] = useState<HqBroadcastRun[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const listSeqRef = useRef(0)
  const listInFlightRef = useRef<number | null>(null)
  const [query, setQuery] = useListUrlValue('q', '')
  const [status, setStatus] = useState<StatusKey>('all')
  const [pageSize, setPageSize] = useListUrlValue('pageSize', 20)
  const [page, setPage] = useListUrlValue('page', 1)
  /* 並び順（「新しい順」）。口は作った順の新しい順で返すので、古い順は逆に並べる。 */
  const [sortKey, setSortKey] = useListUrlValue<'newest' | 'oldest'>('sortKey', 'newest')
  /* 左の列のフォルダ（店の一斉配信と同じ。API-18 の統括のフォルダ）。読めなくても一覧は出す。 */
  const [folders, setFolders] = useState<HqFolder[] | null>(null)
  const [folderLoading, setFolderLoading] = useState(true)
  const [folderLoadError, setFolderLoadError] = useState(false)
  const folderSeqRef = useRef(0)
  const folderInFlightRef = useRef<number | null>(null)
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      listSeqRef.current += 1
      listInFlightRef.current = null
      folderSeqRef.current += 1
      folderInFlightRef.current = null
    }
  }, [])
  const [folderFilter, setFolderFilter] = useListUrlValue('folderFilter', 'all')
  const [folderDialog, setFolderDialog] = useState<{ editing: HqFolder | null } | null>(null)
  const [folderName, setFolderName] = useState('')
  const [folderColor, setFolderColor] = useState<string | null>(FOLDER_SELECT_COLORS[0].value)
  const [deletingFolder, setDeletingFolder] = useState<HqFolder | null>(null)
  const folderDeleteTicket = useRef<object | null>(null)
  const renderedFolderDeleteTicket = folderDeleteTicket.current
  const folderDeleteLock = useRef(false)
  const [folderBusy, setFolderBusy] = useState(false)
  const depth = useContext(OverlayDepthContext)
  const folderGuard = useUnsavedGuard({
    dirty: folderDialog !== null && (folderName !== (folderDialog.editing?.name ?? '') || folderColor !== (folderDialog.editing ? folderDisplayColor(folderDialog.editing) : FOLDER_SELECT_COLORS[0].value) || folderBusy),
    busy: folderDialog !== null && folderBusy,
    onDiscard: () => setFolderDialog(null),
  })
  const [folderError, setFolderError] = useState('')

  const load = useCallback(async (options?: { force?: boolean }) => {
    if (!options?.force && listInFlightRef.current !== null) return
    const seq = ++listSeqRef.current
    listInFlightRef.current = seq
    setLoading(true)
    setError(null)
    try {
      const res = await hqBroadcastsApi.list()
      if (!aliveRef.current || seq !== listSeqRef.current) return
      if (!res || (res as { success?: boolean }).success === false || !Array.isArray(res.data)) {
        throw new Error('invalid_hq_broadcast_list')
      }
      setRuns(res.data)
      setError(null)
    } catch (caught) {
      if (!aliveRef.current || seq !== listSeqRef.current) return
      const fieldFailure = saveErrors.capture(caught)
      if (!fieldFailure) setError(caught)
    } finally {
      if (listInFlightRef.current === seq) listInFlightRef.current = null
      if (aliveRef.current && seq === listSeqRef.current) setLoading(false)
    }
  }, [saveErrors])

  const loadFolders = useCallback(async (options?: { force?: boolean }) => {
    if (!options?.force && folderInFlightRef.current !== null) return
    const seq = ++folderSeqRef.current
    folderInFlightRef.current = seq
    setFolderLoading(true)
    setFolderLoadError(false)
    try {
      const res = await hqBroadcastsApi.folders()
      if (!aliveRef.current || seq !== folderSeqRef.current) return
      if (!res || (res as { success?: boolean }).success === false || !Array.isArray(res.data)) {
        throw new Error('invalid_hq_broadcast_folders')
      }
      setFolders(res.data)
      setFolderLoadError(false)
    } catch (saveFailure) {
      if (!aliveRef.current || seq !== folderSeqRef.current) return
      saveErrors.capture(saveFailure)
      setFolders(null)
      setFolderLoadError(true)
    } finally {
      if (folderInFlightRef.current === seq) folderInFlightRef.current = null
      if (aliveRef.current && seq === folderSeqRef.current) setFolderLoading(false)
    }
  }, [saveErrors])
  useEffect(() => { void load({ force: true }); void loadFolders({ force: true }) }, [load, loadFolders]);


  const all = useMemo(() => runs ?? [], [runs])
  const counts = useMemo(() => {
    const result: Record<StatusKey, number> = { all: all.length, scheduled: 0, draft: 0, sent: 0, error: 0 }
    for (const run of all) { const key = statusKeyOf(run); if (key) result[key] += 1 }
    return result
  }, [all])
  const folderIdOf = (run: HqBroadcastRun) => run.input?.folderId ?? null
  const inFolder = useCallback((run: HqBroadcastRun) => folderFilter === 'all' || (folderFilter === 'none' ? !run.input?.folderId || !(folders ?? []).some((f) => f.id === run.input.folderId) : run.input?.folderId === folderFilter), [folderFilter, folders])
  const filtered = useMemo(() => {
    const words = query.trim().toLocaleLowerCase()
    const hits = all.filter((run) => inFolder(run) && (status === 'all' || statusKeyOf(run) === status)
      && (!words || [run.title, run.input?.messageContent ?? ''].some((text) => text.toLocaleLowerCase().includes(words))))
    return sortKey === 'oldest' ? [...hits].reverse() : hits
  }, [all, status, query, inFolder, sortKey])
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const current = Math.min(page, pageCount)
  const shown = filtered.slice((current - 1) * pageSize, current * pageSize)

  /* 数の帯（一括配信の記録から数えられるもの）。 */
  const ready = !loading && !error && runs !== null
  const listFailed = Boolean(error) && runs === null
  const kpiFallback = listFailed ? '読み込めませんでした' : emptyValue('unknown')
  const sentRuns = all.filter((run) => statusKeyOf(run) === 'sent')
  const delivered = sentRuns.reduce((sum, run) => sum + run.targets.filter((t) => !t.excluded).reduce((s, t) => s + t.successCount, 0), 0)
  const failedStores = all.reduce((sum, run) => sum + run.targets.filter((t) => !t.excluded && (t.status === 'failed' || failedCount(t) > 0)).length, 0)
  /*
   * 平均の開封率（4つ目）：送った配信の開いた人の合計÷届いた人の合計。開いた数を数えていない
   * アカウントが1つでもあれば出さない（「—」）。一覧に送った日が無いので「過去28日」ではなく送った配信全体。
   * 今月の送信枠（2つ目）は統括の口に無いので、代わりにエラーを置く（見た目だけ置かない）。
   */
  const sentTargets = all.filter((run) => statusKeyOf(run) === 'sent' || statusKeyOf(run) === 'error').flatMap((run) => run.targets.filter((t) => !t.excluded && t.successCount > 0))
  const openKnown = sentTargets.length > 0 && sentTargets.every((t) => t.openedCount != null)
  const openReached = sentTargets.reduce((sum, t) => sum + t.successCount, 0)
  const openRate = openKnown && openReached > 0 ? Math.round((sentTargets.reduce((sum, t) => sum + (t.openedCount ?? 0), 0) / openReached) * 1000) / 10 : null
  const kpis = [
    { key: 'scheduled', title: '予約中', icon: CalendarClock, value: ready ? counts.scheduled : null, unit: '件', detail: ready ? `下書き ${formatNumber(counts.draft)}件` : kpiFallback },
    { key: 'sent', title: '送った配信', icon: Send, value: ready ? counts.sent : null, unit: '件', detail: ready ? `${formatNumber(delivered)}人に届いた` : kpiFallback },
    { key: 'error', title: 'エラー', icon: AlertCircle, value: ready ? counts.error : null, unit: '件', detail: ready ? `失敗したアカウント ${formatNumber(failedStores)}件` : kpiFallback },
    { key: 'open', title: '平均の開封率', icon: MailOpen, value: ready ? openRate : null, unit: '%', detail: ready ? (openRate == null ? 'まだ数えていません' : '送った配信の合計') : kpiFallback },
  ]

  const createButton = (full: boolean) => (
    <PermissionGatedButton allowed={canManage} need="tenantWide" variant="primary" href={NEW_HREF} className={full ? 'v8-folder-create w-full' : undefined}>
      <Plus size={16} aria-hidden="true" />配信を作る
    </PermissionGatedButton>
  )

  const countIn = (id: string) => all.filter((run) => (id === 'none' ? !folderIdOf(run) || !(folders ?? []).some((f) => f.id === folderIdOf(run)) : folderIdOf(run) === id)).length
  const folderRows: FolderPanelRow[] = [
    { kind: 'all' as const, id: 'all', label: 'すべて', count: ready ? all.length : null, icon: <Inbox size={16} aria-hidden="true" /> },
    ...(folders ?? []).map((folder) => ({
      kind: 'folder' as const,
      id: folder.id,
      label: folder.name,
      color: folder.color,
      count: ready ? countIn(folder.id) : null,
      ...(canManage ? {
        onEdit: () => { setFolderError(''); setFolderNameError(''); setFolderName(folder.name); setFolderColor(folderDisplayColor(folder)); setFolderDialog({ editing: folder }) },
        onDelete: () => { folderDeleteTicket.current = {}; setFolderError(''); setDeletingFolder(folder) },
      } : {}),
    })),
    // 未分類はほかの一覧と同じく、フォルダが1つも無くても出す。読めなかったときは出さない。
    ...(folders ? [{ kind: 'unfiled' as const, id: 'none', label: '未分類', count: ready ? countIn('none') : null }] : []),
  ]
  const selectFolder = (id: string) => { setFolderFilter(id); setPage(1) }
  /* 送る版（revision）はいつも今の一覧から引く。409 で読み直したあとの2回目の保存が新しい版で通る。 */
  const latestFolder = <F extends { id: string }>(folder: F): F => ((folders ?? []).find((f) => f.id === folder.id) as F | undefined) ?? folder
  const [folderNameError, setFolderNameError] = useState('')
  const saveFolder = async () => {
    const name = folderName.trim()
    if (!name || folderBusy || !folderDialog) return
    setFolderBusy(true); setFolderError(''); setFolderNameError('')
    try {
      if (folderDialog.editing) await hqBroadcastsApi.updateFolder(folderDialog.editing.id, name, latestFolder(folderDialog.editing).revision, folderColor)
      else await hqBroadcastsApi.createFolder(name, folderColor)
      await loadFolders({ force: true })
      setFolderDialog(null)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)
      // 理由ごとに言い分ける（共通の describeFolderFailure）。入力した名前と色は残す。
      const failure = describeFolderFailure(caught, 'save');

      if (failure.kind === 'missing') {
        notifyToast(failure.message, { tone: 'error' })
        await loadFolders({ force: true })
        setFolderDialog(null)
        return
      }
      if (failure.kind === 'conflict') await loadFolders({ force: true })
      if (failure.nameError) { if (!fieldFailure) setFolderNameError(failure.nameError) }
      else { if (!fieldFailure) setFolderError(failure.message) }
    } finally {
      setFolderBusy(false)
    }
  }
  const removeFolder = async () => {
    if (!deletingFolder || folderBusy || !renderedFolderDeleteTicket || renderedFolderDeleteTicket !== folderDeleteTicket.current || folderDeleteLock.current) return
    folderDeleteLock.current = true
    setFolderBusy(true); setFolderError('')
    try {
      await hqBroadcastsApi.deleteFolder(deletingFolder.id, latestFolder(deletingFolder).revision)
      if (renderedFolderDeleteTicket !== folderDeleteTicket.current) return
      folderDeleteTicket.current = null
      setDeletingFolder(null); setFolderFilter('all')
      await loadFolders({ force: true })
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught);


      const failure = describeFolderFailure(caught, 'delete');

      if (failure.kind === 'missing') {
        folderDeleteTicket.current = null
        setDeletingFolder(null)
        notifyToast(failure.message, { tone: 'error' })
        await loadFolders({ force: true })
        return
      }
      if (failure.kind === 'conflict') await loadFolders({ force: true })
      { if (!fieldFailure)
      setFolderError(failure.message) }
    } finally {
      folderDeleteLock.current = false
      setFolderBusy(false)
    }
  }

  /* 店の一覧と同じ2段：探す／札 … 件数・並び。1段にまとめると件数と並びが縦に割れる。 */
  const toolbar = (
    <ListToolbarFrame layout="stacked">
      {folderLoadError ? (
        <Notice
          tone="warn"
          message="フォルダを読み込めませんでした。一覧の確認はそのまま続けられます。"
          action={
            <Button
              variant="text"
              size="inline"
              onClick={() => void loadFolders()}
              disabled={folderLoading}
              busy={folderLoading}
              busyLabel="読み込んでいます"
            >
              フォルダを読み直す
            </Button>
          }
        />
      ) : null}
      <ListToolbarRow>
        <ListToolbarSearchSlot>
          <SearchField aria-label="タイトル・内容で探す" placeholder="タイトル・内容で探す" value={query} onChange={(value) => { setQuery(value); setPage(1) }} onClear={() => { setQuery(''); setPage(1) }} />
        </ListToolbarSearchSlot>
      </ListToolbarRow>
      <ListToolbarRow>
        <SegmentedControl<StatusKey>
          aria-label="状態で絞る"
          value={status}
          onChange={(next) => { setStatus(next); setPage(1) }}
          options={STATUS_CHIPS.map((chip) => ({ value: chip.key, label: chip.label, count: counts[chip.key] }))}
        />
        <ListToolbarEnd>
        <div className={styles.pageSizeBox}>
          <SaveErrorField names={["pageSize","page_size"]}><Select
            aria-label="表示件数"
            size="page-size"
            value={String(pageSize)}
            onChange={(value) => { setPageSize(Number(value) || 20); setPage(1) }}
            options={[{ value: '10', label: '10件表示' }, { value: '20', label: '20件表示' }, { value: '50', label: '50件表示' }]}
          /></SaveErrorField>
        </div>
<ListToolbarSort value={sortKey} onChange={(value) => { setSortKey(value as typeof sortKey); setPage(1) }} options={[{ value: 'newest', label: '新しい順' }, { value: 'oldest', label: '古い順' }]} />
        </ListToolbarEnd>
      </ListToolbarRow>
    </ListToolbarFrame>
  )

  /* まだ1件も無いときは、空の案内の主ボタンだけにする（左の列の「配信を作る」と2つ並べない）。 */
  const hasFilters = Boolean(query || status !== 'all' || folderFilter !== 'all')
  const firstEmpty = !error && runs != null && filtered.length === 0 && !hasFilters

  let content
  if (loading && !runs) content = <ListState permissionScope="hq" kind="loading" />
  else if (error && !runs) content = <ListState permissionScope="hq" kind="error" error={error} onRetry={() => void load()} />
  else if (!runs) content = <ListState permissionScope="hq" kind="loading" />
  else if (filtered.length === 0) {
    content = (
      <EmptyList
        icon={<Send aria-hidden="true" />}
        title="一括配信はまだありません"
        description="送るアカウントを選んで、同じ内容を一度に送れます。各店のアカウントに入らずに送れます。"
        create={{ label: '最初の一括配信を作る', href: NEW_HREF }}
        canCreate={canManage}
        filtered={hasFilters}
        onClearFilters={() => { setQuery(''); setStatus('all'); setFolderFilter('all'); setPage(1) }}
        filteredDescription="検索や状態の絞り込みを外すと、すべて出ます"
      />
    )
  } else {
    content = (
      <DataTable className={styles.table} data-design="hq-broadcasts">
        <thead>
          <TableHeadRow>
            <Th className={styles.colTitle}>タイトル・内容</Th>
            <Th className={styles.colStatus}>状態</Th>
            <Th className={styles.colAudience}>配信条件</Th>
            <Th className={styles.colDate}>配信日時</Th>
            {!narrow && <Th className={styles.colResultWide}>結果</Th>}
            <Th className={styles.colMenu}><span className="sr-only">操作</span></Th>
          </TableHeadRow>
        </thead>
        <tbody>
          {shown.map((run) => {
            const badge = runBadge(run)
            const totals = sendTotals(run.targets)
            const live = run.targets.filter((t) => !t.excluded)
            const href = `/hq/broadcasts/detail?id=${encodeURIComponent(run.id)}`
            const stores = run.status === 'prepared' ? `${formatNumber(totals.sendStores)} アカウント（外す ${formatNumber(totals.skipStores)}）` : `${formatNumber(live.length)} アカウント`
            const reached = live.reduce((sum, t) => sum + t.successCount, 0)
            const failed = live.filter((t) => t.status === 'failed' || failedCount(t) > 0).length
            const sent = statusKeyOf(run) === 'sent' || statusKeyOf(run) === 'error'
            return (
              <Tr key={run.id} className={styles.row} data-row-id={run.id}>
                <Td>
                  <div className={styles.titleLine}>
                    <FolderDotName folder={(() => { const folder = (folders ?? []).find((f) => f.id === folderIdOf(run)); return folder ? { name: folder.name, color: folder.color } : null })()}>
                      <RowNameLink href={href} className={styles.cellTitle} title={run.title}>{run.title}</RowNameLink>
                    </FolderDotName>
                  </div>

                </Td>
                <Td><StatusBadge tone={badge.tone}>{badge.label}</StatusBadge></Td>
                <Td>
                  <span className={styles.cellMain} title={stores}>{stores}</span>
                  <span className={styles.cellSub}>{audienceText(run)}</span>
                </Td>
                <Td>
                  {/* 日時だけの1行。予約中（まだ先）の日時だけ少し濃くする。「予約」は状態の札にあるので重ねない。 */}
                  <span className={styles.cellMain} data-upcoming={statusKeyOf(run) === 'scheduled' && run.scheduledAt ? true : undefined}>{run.scheduledAt ? <ListDateTime value={run.scheduledAt} /> : run.status === 'prepared' ? emptyValue('unconfigured') : 'すぐ送った'}</span>
                </Td>
                {!narrow && <Td>
                  {sent ? (
                    <>
                      <span className={styles.resultMain}>{`${formatNumber(reached)} 人に届いた`}</span>
                      {failed > 0 ? <span className={styles.cellSub}>{`失敗したアカウント ${formatNumber(failed)}`}</span> : rateLine(live, reached) ? <span className={styles.cellSub}>{rateLine(live, reached)}</span> : null}
                    </>
                  ) : <span className={styles.cellMain}>{emptyValue('unknown')}</span>}
                </Td>}
                <Td className={styles.colMenu}>
                  <div className={styles.menuBox}>
                    <RowActions subjectName={run.title} menuItems={[
                      { id: 'open', label: run.status === 'prepared' ? '確かめて送る' : '送った結果を見る', onSelect: () => { router.push(href) } },
                      ...(run.status === 'prepared' && canManage ? [{ id: 'edit', label: '下書きを直す', onSelect: () => { router.push(`${NEW_HREF}?id=${encodeURIComponent(run.id)}`) } }] : []),
                    ]} />
                  </div>
                </Td>
              </Tr>
            )
          })}
        </tbody>
      </DataTable>
    )
  }

  const pager = runs && filtered.length > 0 ? (
    <ListPagePagination>
      <Pagination page={current} pageCount={pageCount} onPageChange={setPage} ariaLabel="一括配信のページ送り" range={{ total: filtered.length, first: (current - 1) * pageSize + 1, last: Math.min(current * pageSize, filtered.length) }} />
    </ListPagePagination>
  ) : null

  return (
    <SaveErrorScope errors={saveErrors}><ListPage
      skeleton
      boardId="U4Eep0"
      headingSize="regular"
      title="一括配信"
      help="選んだアカウントの友だちにまとめて送るメッセージの一覧です。予約・下書き・送った結果をここで見ます。"
      stats={(
        <KpiBand>
          {kpis.map((kpi) => (
            <KpiCard key={kpi.key} presentation="band" density="compact" loading={loading && runs === null} title={kpi.title} icon={<kpi.icon size={16} aria-hidden="true" />} value={kpi.value} unit={kpi.value == null ? '' : kpi.unit} detail={kpi.detail} />
          ))}
        </KpiBand>
      )}
      folderNav={{ rows: folderRows, activeId: folderFilter, onSelect: selectFolder, createAction: firstEmpty ? undefined : createButton(false) ?? undefined }}
      folders={(
        <FolderPanel
          createAction={firstEmpty ? null : createButton(true)}
          activeId={folderFilter}
          onSelect={selectFolder}
          onAddFolder={canManage ? () => { setFolderError(''); setFolderNameError(''); setFolderName(''); setFolderColor(FOLDER_SELECT_COLORS[0].value); setFolderDialog({ editing: null }) } : undefined}
          addFolderLabel="フォルダを追加"
          rows={folderRows}
        >
          {canManage && !firstEmpty ? null : <span className={styles.viewerAddSpace} aria-hidden="true" />}
          <FolderPanelNote>フォルダを消しても、入っていたものは未分類に残ります</FolderPanelNote>
        </FolderPanel>
      )}
      overlays={(
        <>
          <OverlayDepthContext.Provider value={depth + 2}><UnsavedLeaveDialog open={folderGuard.leaveTarget !== null} busy={folderBusy} onConfirm={folderGuard.confirmLeave} onCancel={folderGuard.cancelLeave} /></OverlayDepthContext.Provider>
          <FolderEditorDialog
            name={folderName} onNameChange={(next) => { setFolderName(next); setFolderNameError('') }} color={folderColor} onColorChange={setFolderColor}
            nameError={folderNameError || undefined}
            open={folderDialog !== null}
            title={folderDialog?.editing ? 'フォルダを直す' : 'フォルダを追加'}
            description="一括配信を分けてしまう箱です。消しても、中の配信は未分類に残ります。"
            busy={folderBusy}
            error={folderError || undefined}
            confirmLabel={folderDialog?.editing ? '保存する' : '追加する'}
            cancelLabel="やめる"
            onCancel={() => { if (!folderBusy) setFolderDialog(null) }}
            onConfirm={() => saveFolder()}
          />
          <ConfirmDialog
            open={deletingFolder !== null}
            title={`フォルダ「${deletingFolder?.name ?? ''}」を消しますか？`}
            description={deleteFolderDescription('一括配信', deletingFolder ? countIn(deletingFolder.id) : null)}
            confirmLabel="フォルダを消す"
            cancelLabel="キャンセル"
            destructive
            busy={folderBusy}
            error={folderError || undefined}
            onCancel={() => { if (!folderBusy && !folderDeleteLock.current) { folderDeleteTicket.current = null; setDeletingFolder(null) } }}
            onConfirm={() => removeFolder()}
          ><OperationTargetSummary accounts={[]} /></ConfirmDialog>
        </>
      )}
      toolbar={toolbar}
      pagination={pager}
    >
      {content}
    </ListPage></SaveErrorScope>
  )
}
