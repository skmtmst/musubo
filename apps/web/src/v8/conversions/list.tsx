'use client'
import SegmentedControl from '@/components/shared/segmented'
import { DetailContent, DetailField } from '@/components/shared/detail-content'
import { formatYen } from '@line-crm/shared';

import { definitionRange } from './list-export'

import { downloadCsvBlob } from './list-export'

import { useStaffRole } from '@/lib/staff-role';
import { ListToolbarFrame, ListToolbarRow, ListToolbarEnd, ListToolbarSearchSlot, ListToolbarSort as SortSelect } from '@/components/shared/list-toolbar';
import { useListUrlValue, useListUrlParam } from '@/components/shared/list-url-state';
import TruncatedText from '@/components/shared/truncated-text'
import DetailPanel, { useDetailPanelUrl } from '@/components/shared/detail-panel';




import { useFolderMove } from '@/components/shared/use-folder-move';
import { moveConversionToFolder } from '@/lib/move-to-folder';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'next/navigation';
import { Banknote, Bookmark, CircleOff, CirclePause, Download, FilePen, KeyRound, Pause, Play, Plus, Target, TriangleAlert, Trophy, Unplug } from 'lucide-react'

import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation';
import { ListPage } from '@/components/templates';
import { ListPager } from '@/components/templates/list-page';
import SearchField from '@/components/shared/search-field'
import Button from '@/components/shared/button'
import EmptyList from '@/components/shared/empty-list'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import Notice from '@/components/shared/notice'
import Select from '@/components/shared/select'
import PageSizeSelect from '@/components/shared/page-size-select'
import ManagedFolderPanel, { folderDotFor, managedFolderOptions, useManagedFolders } from '@/components/shared/managed-folder-panel';
import { FolderDotName } from '@/components/shared/folder-dot';
import { DataTable, TableHeadRow, Th, Tr, Td, ActionCell, RowNameButton } from '@/components/shared/table';
import { type ActionMenuItem } from '@/components/shared/action-menu';
import { RowMenu } from '@/components/shared/row-actions';
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card';
import Dialog, { DialogActions } from '@/components/shared/dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Disclosure from '@/components/shared/disclosure'
import { Field } from '@/components/shared/form-controls';
import { TextField } from '@/components/shared/text-field';
import ListState from '@/components/shared/list-state'
import StatusBadge from '@/components/shared/status-badge'
import Card from '@/components/shared/card'
import Pagination from '@/components/shared/pagination'
import { DelayedSkeleton, Skeleton } from '@/components/shared/skeleton';
import { findConditionDraftIssue, pruneCondition } from '@/components/shared/condition-builder';
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome';
import { useAccount } from '@/contexts/account-context';
import { useNarrowViewport } from '@/lib/use-narrow-viewport';
import { canEditFeature } from '@/lib/staff-capability';
import { formatNumber, formatDate as polishFormatDate } from '@/lib/format';
import { api, describeSaveFailure, type ConversionDefinitionDeleteImpact, type ConversionDefinitionEvent, type ConversionDefinitionFilter, type ConversionDefinitionList, type ConversionDefinitionListItem, type ConversionDefinitionReport, type ConversionIngestionEvent } from '@/lib/api';
import { deduplicationLabel } from './dedup';
import { originInfoOf } from './origin-labels';
import { readExclusionCondition, readExclusionMemo } from './exclusion';
import { ConversionDetailDialog, ConversionEditDialog, ConversionReversalDialog, EDIT_VALUE_MODE_LABELS, STATE_LABELS, sourceTriggerLabel, usageLabel, type ConversionStopAction, type EditForm } from './dialogs';
import { notifyToast } from '@/components/shared/toast';
import { focusConversionField, type ConversionFieldIssue } from './field-issue';
import styles from './list.module.css'
import { describeApiFailure, withPermissionFailure } from '@/components/shared/api-error-message';
import { csvFileName } from '@/lib/csv-file-name';
import { emptyValue } from '@/components/shared/empty-value';
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors';
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select';
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { AffiliateTabs, useAffiliateShell } from '@/v8/affiliates/public/tabs'

/*
 * ★V8 コンバージョンの一覧（Pencil：一覧 ・1152 ・閲覧のみ ・
 * 状態の見本帳 ）。
 *
 * 型（ListPage）に、数の帯・左のフォルダの列（上に「成果地点を作る」）・
 * 案内の帯・道具の段・表（列の並び）を渡す。行の右端は「…」（使う場所を足す操作も中に残す）。
 * 行はURLに残る右の詳細パネル、「止める」は3択と理由を持つ確認画面。
 *
 * データの口・保存の口・権限・失敗の扱いは app/conversions/page.tsx と同じ
 * （BEHAVIOR.md）。違うのは見せ方だけ。
 */

type StatusFilter = 'all' | ConversionDefinitionFilter
/** フォルダの列の「未分類」（`?folder=unfiled`）。 */
const FOLDER_UNFILED = 'unfiled'
type PointSort = 'cv-desc' | 'value-desc' | 'name'

const READONLY_REASON = 'この操作にはオーナーか管理者の権限が要ります'

const SORT_OPTIONS: Array<{ value: PointSort; label: string }> = [
  { value: 'cv-desc', label: '件数が多い順' },
  { value: 'value-desc', label: '金額が多い順' },
  { value: 'name', label: '名前順' },
]
/* 画面の並びを口の並びに写す（今の一覧と同じ）。 */
const SORT_TO_API: Record<PointSort, 'count_desc' | 'value_desc' | 'name_asc'> = {
  'cv-desc': 'count_desc',
  'value-desc': 'value_desc',
  name: 'name_asc',
}

/* 状態の札（並び）。件数は口の stateCounts。 */
const CHIPS: Array<{ value: ConversionDefinitionFilter; label: string; icon: ReactNode }> = [
  { value: 'active', label: '有効', icon: <Play size={16} aria-hidden="true" /> },
  { value: 'stopped', label: '停止中', icon: <Pause size={16} aria-hidden="true" /> },
  { value: 'draft', label: '下書き', icon: <FilePen size={16} aria-hidden="true" /> },
  { value: 'invalid', label: '入力不良', icon: <TriangleAlert size={16} aria-hidden="true" /> },
  { value: 'sourceStopped', label: '起点停止', icon: <CirclePause size={16} aria-hidden="true" /> },
  { value: 'unused', label: 'どこからも使われていない', icon: <CircleOff size={16} aria-hidden="true" /> },
]

function toEditForm(item: ConversionDefinitionListItem): EditForm {
  return {
    name: item.name,
    sourceType: item.sourceType,
    deduplicationMode: item.deduplicationMode,
    deduplicationWindowDays: item.deduplicationWindowDays == null ? '' : String(item.deduplicationWindowDays),
    valueMode: item.valueMode,
    fixedValue: item.value == null ? '' : String(item.value),
    reversalPolicy: item.reversalPolicy,
    attributionDays: item.attributionDays == null ? '' : String(item.attributionDays),
    targetUrl: item.targetUrl ?? '',
    exclusion: readExclusionCondition(item.sourceConfig),
    exclusionMemo: readExclusionMemo(item.sourceConfig),
  }
}

/* 「何が起きたら数えるか」の1行目（短い言葉）。くわしい起点は title と詳細で読む。 */
const SHORT_TRIGGERS: Record<string, string> = {
  ec_order_confirmed: '注文が確定したとき',
  ec_subscription_confirmed: '定期便が確定したとき',
  reservation_confirmed: '予約が確定したとき',
  form_submitted: '回答フォームを送ったとき',
  form_submit: '回答フォームを送ったとき',
  webinar_completed: '視聴完了になったとき',
  tag_added: 'タグが付いたとき',
  purchase: '購入を記録したとき',
  visit: '来店・参加を記録したとき',
}
function shortTrigger(point: ConversionDefinitionListItem): string {
  if (point.measureMethod === 'url_reach') return 'ページのURLを開いたとき'
  if (point.measureMethod === 'manual') return '担当者が記録したとき'
  return SHORT_TRIGGERS[point.sourceType] ?? originInfoOf(point.sourceType).trigger
}

function shortDate(iso: string): string {
  return polishFormatDate(iso, { style: 'list-day', fallback: '—' })
}

/* 「何が起きたら数えるか」の2行目（数え方・金額または止めた日）。 */
function rowSub(point: ConversionDefinitionListItem): string {
  const parts = [deduplicationLabel(point.deduplicationMode, point.deduplicationWindowDays).replace(/だけ$/, '').replace('何回でも数える', '1回ごと')]
  if (point.status === 'stopped' && point.stoppedAt) parts.push(`止めた日 ${shortDate(point.stoppedAt)}`)
  else if (point.valueMode === 'fixed') parts.push(point.value == null ? '金額なし' : `決まった金額 ${formatYen(point.value)}`)
  else if (point.valueMode === 'none') parts.push('金額なし')
  else if (point.reversalPolicy === 'source_cancelled') parts.push('取り消しは引く')
  return parts.join('・')
}

/* 使われている場所：最後の1つを2行目に小さく（全部を見せる。詳細の小窓でも読める）。 */
function usageLines(point: ConversionDefinitionListItem): { main: string; sub: string } {
  const names = point.usageNames ?? []
  if (point.usageCount === 0) return { main: '—', sub: '' }
  if (names.length === 0) return { main: `${formatNumber(point.usageCount)}か所`, sub: '' }
  if (names.length === 1) return { main: names[0], sub: '' }
  return { main: names.slice(0, -1).join('・'), sub: names[names.length - 1] }
}

function StatePill({ point }: { point: ConversionDefinitionListItem }) {
  return (
    <StatusBadge tone={point.state === 'active' ? 'success' : point.state === 'invalid' || point.state === 'sourceStopped' ? 'warning' : 'neutral'}>
      {STATE_LABELS[point.state] ?? STATE_LABELS.active}
    </StatusBadge>
  )
}

function TableHead({ selection }: { selection?: ReactNode } = {}) {
  return (
    <thead>
      <TableHeadRow data-table-layout="columns">
        <Th grow>{selection}成果地点</Th>
        <Th className={styles.colState}>状態</Th>
            <Th className={styles.colTrigger} collapseAt="narrow">何が起きたら数えるか</Th>
        <Th className={styles.colCount} align="right">この30日</Th>
        <Th className={styles.colValue} align="right">金額</Th>
        <Th className={styles.colUsage} collapseAt="narrow">使われている場所</Th>
        <Th className={styles.colOps}>操作</Th>
      </TableHeadRow>
    </thead>
  )
}

function ListSkeleton() {
  return (
    <div className={styles.tableWrap} aria-busy="true">
      <span className="sr-only">成果地点を読み込んでいます</span>
      <DelayedSkeleton
        loading
        skeleton={
          <DataTable columnLayout={{ headHeight: 'var(--tpl-cn-head-h)', rowHeight: 'var(--tpl-cn-row-h)', gap: 'var(--tpl-cn-col-gap)', padding: '0 var(--tpl-list-inset)', numberInset: 'var(--tpl-cn-num-pad-end)', bodyTextSize: 'var(--polish-text-body)', collapseScope: 'page' }}>
            <TableHead />
            <tbody aria-hidden="true">
              {[0, 1, 2, 3, 4].map((index) => (
                <Tr key={index} data-table-layout="columns">
                  <Td grow><Skeleton className={styles.skeletonName} /></Td>
                  <Td className={styles.colState}><Skeleton className={styles.skeletonName} /></Td>
                    <Td className={styles.colTrigger} collapseAt="narrow"><Skeleton className={styles.skeletonName} /></Td>
                  <Td className={styles.colCount} align="right"><Skeleton className={styles.skeletonNum} /></Td>
                  <Td className={styles.colValue} align="right"><Skeleton className={styles.skeletonNum} /></Td>
                  <Td className={styles.colUsage} collapseAt="narrow"><Skeleton className={styles.skeletonName} /></Td>
                  <ActionCell className={styles.colOps}><Skeleton className={styles.skeletonNum} /></ActionCell>
                </Tr>
              ))}
            </tbody>
          </DataTable>
        }
      />
    </div>
  )
}

export default function ConversionListV8({ accountId, editId, embedded = false }: { accountId: string | null; editId?: string | null; embedded?: boolean }) {
  return (
    <Suspense fallback={<ListState kind="loading" />}>
      <ConversionList accountId={accountId} editId={editId} embedded={embedded} />
    </Suspense>
  )
}

function ConversionList({ accountId, editId, embedded }: { accountId: string | null; editId?: string | null; embedded: boolean }) {
  const saveErrors = useSaveFormErrors()
  const affiliateShell = useAffiliateShell()
  const inAffiliateTabs = embedded && affiliateShell.tab === 'points'
  usePageTitle(inAffiliateTabs ? '成果とアフィリエイト' : 'コンバージョン')
  usePageCrumbs([{ label: 'ホーム', href: '/' }])
  const router = useRouter()
  const narrow = useNarrowViewport()
  const { selectedAccountId, accounts } = useAccount()
  /* 作る画面は `?highlight=<作った行のID>` で戻ってくる。 */
  const highlightId = useSearchParams().get('highlight')

  const [definitions, setDefinitions] = useState<ConversionDefinitionList | null>(null)
  const [summaryReport, setSummaryReport] = useState<ConversionDefinitionReport | null>(null)
  const [listTruncated, setListTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useListUrlValue('q', '')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [sort, setSort] = useListUrlValue<PointSort>('sort', 'cv-desc')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [page, setPage] = useListUrlValue('page', 1)
  const [pageSize, setPageSize] = useListUrlValue('pageSize', 20)
  /* 左のフォルダの列（共通の /api/folders・種類 conversion）。'' はすべて。`?folder=` で共有できる。 */
  const [folderFilter, setFolderFilter] = useListUrlParam('folder')
  const folderState = useManagedFolders('conversion', accountId)
  const folders = folderState.folders
  const [loadFailed, setLoadFailed] = useState(false)
  const [reportFailed, setReportFailed] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const loadSeq = useRef(0)
  const accountIdRef = useRef(accountId)
  accountIdRef.current = accountId

  /* 行の詳細パネルと、停止の確認画面。 */
  const [panelId, setPanelId] = useDetailPanelUrl('point')
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [stopTarget, setStopTarget] = useState<ConversionDefinitionListItem | null>(null)
  const [stopEpoch, setStopEpoch] = useState(-1)
  const stopRequest = useRef(0)
  const [stopImpact, setStopImpact] = useState<ConversionDefinitionDeleteImpact | null>(null)
  const [stopImpactLoading, setStopImpactLoading] = useState(false)
  const [stopAction, setStopAction] = useState<ConversionStopAction>('stop')
  const [replacementId, setReplacementId] = useState('')
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState('')
  const [stopReason, setStopReason] = useState('')
  /* 中身を見る窓・編集の窓・取消の窓（今の画面と同じ窓）。 */
  const [detailTarget, setDetailTarget] = useState<ConversionDefinitionListItem | null>(null)
  const detailTargetRef = useRef(detailTarget)
  detailTargetRef.current = detailTarget
  const [editTarget, setEditTarget] = useState<ConversionDefinitionListItem | null>(null)
  const [editForm, setEditForm] = useState<EditForm | null>(null)
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState('')
  const [editFieldIssue, setEditFieldIssue] = useState<ConversionFieldIssue | null>(null)
  useEffect(() => {
    if (editFieldIssue) focusConversionField(editFieldIssue.field)
  }, [editFieldIssue])
  const [editValueModeNotice, setEditValueModeNotice] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [ingestBusy, setIngestBusy] = useState<'' | 'issue' | 'toggle'>('')
  const [issuedSecret, setIssuedSecret] = useState('')
  const [ingestError, setIngestError] = useState('')
  const [ingestEvents, setIngestEvents] = useState<ConversionIngestionEvent[]>([])
  const [definitionEvents, setDefinitionEvents] = useState<ConversionDefinitionEvent[]>([])
  const [eventsSource, setEventsSource] = useState<{ id: string; epoch: number } | null>(null)
  const [eventsFailed, setEventsFailed] = useState(false)
  const [reversalTarget, setReversalTarget] = useState<ConversionDefinitionEvent | null>(null)
  const [reversalScope, setReversalScope] = useState<{ epoch: number; definitionId: string; lineAccountId: string | null } | null>(null)
  const [reversalKind, setReversalKind] = useState<'reverse' | 'restore'>('reverse')
  const [reversalReason, setReversalReason] = useState('')
  const [reversalBusy, setReversalBusy] = useState(false)
  const [reversalError, setReversalError] = useState('')
  /* APIと同じ機能鍵・操作鍵を本人APIの応答で確認する。 */
  const role = useStaffRole()
  const canEdit = canEditFeature('/conversions', role) && canEditFeature('conversion.definition.edit', role)
  const canExport = canEditFeature('/conversions', role) && canEditFeature('conversion.report.export', role)
  const stopScope = useRef({ accountId, canEdit, epoch: 0 })
  if (stopScope.current.accountId !== accountId || stopScope.current.canEdit !== canEdit) stopScope.current = { accountId, canEdit, epoch: stopScope.current.epoch + 1 }
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [actionNotice, setActionNotice] = useState('')

  useEffect(() => {
    setDebouncedQuery(query.trim())
  }, [query])

  /* 一覧は検索・並びを口へ渡し、続く頁をすべて読む（50頁・5000件で止め、切れたら断る）。 */
  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    setLoading(true)
    setLoadFailed(false)
    setReportFailed(false)
    setDefinitions(null)
    setSummaryReport(null)
    setListTruncated(false)
    const range = definitionRange(30)
    const listParams = {
      ...range,
      lineAccountId: accountId ?? undefined,
      q: debouncedQuery || undefined,
      sort: SORT_TO_API[sort],
      limit: 100,
    }
    const fetchAllDefinitions = async (): Promise<{ data: ConversionDefinitionList; truncated: boolean } | null> => {
      const items: ConversionDefinitionList['items'] = []
      let cursor: string | undefined
      let first: ConversionDefinitionList | null = null
      for (let pageIndex = 0; pageIndex < 50; pageIndex += 1) {
        const response = await api.conversions.definitions({ ...listParams, cursor })
        if (!response.success || !Array.isArray(response.data.items)) return null
        if (!first) first = response.data
        items.push(...response.data.items)
        cursor = response.data.pagination.nextCursor ?? undefined
        if (!cursor) return { data: { ...response.data, items }, truncated: false }
      }
      return first ? { data: { ...first, items }, truncated: true } : null
    }
    const [listResult, reportResult] = await Promise.allSettled([
      fetchAllDefinitions(),
      api.conversions.definitionReport({ ...range, lineAccountId: accountId ?? undefined }),
    ])
    if (loadSeq.current !== seq) return
    if (listResult.status === 'fulfilled' && listResult.value !== null) {
      setDefinitions(listResult.value.data)
      setListTruncated(listResult.value.truncated)
    } else {
      setLoadFailed(true)
    }
    if (reportResult.status === 'fulfilled' && reportResult.value.success
      && Array.isArray(reportResult.value.data?.byDefinition)) {
      setSummaryReport(reportResult.value.data)
    } else {
      setReportFailed(true)
    }
    if (loadSeq.current === seq) setLoading(false)
  }, [accountId, debouncedQuery, sort])

  /* 集計だけを読み直す。一覧は触らない。遅れた応答は世代とアカウントで捨てる。 */
  const reloadReport = useCallback(async () => {
    const seq = ++loadSeq.current
    const requestAccountId = accountId
    try {
      const response = await api.conversions.definitionReport({ ...definitionRange(30), lineAccountId: accountId ?? undefined })
      if (loadSeq.current !== seq || accountIdRef.current !== requestAccountId) return
      if (response.success && Array.isArray(response.data?.byDefinition)) {
        setSummaryReport(response.data)
        setReportFailed(false)
      } else {
        setReportFailed(true)
      }
    } catch (saveFailure) {
      if (loadSeq.current !== seq || accountIdRef.current !== requestAccountId) return
      saveErrors.capture(saveFailure)
      setReportFailed(true)
    }
  }, [accountId, saveErrors])

  useEffect(() => { void load() }, [load])

  /* 中身と同じ成果地点から来た応答だけを、取消の対象にする。 */
  useEffect(() => {
    let active = true
    setIngestEvents([])
    setDefinitionEvents([])
    setEventsSource(null)
    setEventsFailed(false)
    if (!detailTarget) return () => { active = false }
    const id = detailTarget.id
    const epoch = stopScope.current.epoch
    void api.conversions.definitionEvents(id, 10)
      .then((response) => {
        if (!active || stopScope.current.epoch !== epoch) return
        if (response.success) { setDefinitionEvents(response.data.items); setEventsSource({ id, epoch }) }
        else setEventsFailed(true)
      })
      .catch(() => { if (active && stopScope.current.epoch === epoch) setEventsFailed(true) })
    if (detailTarget.measureMethod === 'webhook') {
      void api.conversions.ingestionEvents(id, 5)
        .then((response) => { if (active && stopScope.current.epoch === epoch && response.success) setIngestEvents(response.data.items) })
        .catch(() => undefined)
    }
    return () => { active = false }
  }, [detailTarget, accountId, canEdit])

  /* 鍵の平文は、見せた相手が変わったら消す（別の行に見せない）。 */
  useEffect(() => {
    setIssuedSecret('')
    setIngestError('')
  }, [panelId, detailTarget])

  const beginEdit = (target: ConversionDefinitionListItem) => {
    if (!canEdit) return
    setDetailTarget(null)
    setEditTarget(target)
    const form = toEditForm(target)
    const allowed = originInfoOf(form.sourceType).valueModes
    if (!allowed.includes(form.valueMode)) {
      const fallback = originInfoOf(form.sourceType).defaultValueMode
      setEditForm({ ...form, valueMode: fallback })
      setEditValueModeNotice(`起点に注文の金額が無いため、金額の決め方を「${EDIT_VALUE_MODE_LABELS[fallback]}」に戻しました。`)
    } else {
      setEditForm(form)
      setEditValueModeNotice(null)
    }
    setEditError('')
    setEditFieldIssue(null)
  }

  /* 編集を送る。開いたときの版をそのまま渡し、409 は上書きせずに読み直しを促す。 */
  const openEdit = (target: ConversionDefinitionListItem) => router.push(`/conversions/edit?id=${encodeURIComponent(target.id)}`)
  useEffect(() => {
    const target = definitions?.items.find((item) => item.id === editId)
    if (target) beginEdit(target)
  }, [editId, definitions])
  const submitEdit = async () => {
    if (!editTarget || !editForm || editSaving || !canEdit) return
    const invalid = (field: string, message: string) => {
      setEditError('')
      setEditFieldIssue({ field, message })
    }
    const name = editForm.name.trim()
    if (!name) { invalid('cv-edit-name', '名前を入れてください'); return }
    if (!originInfoOf(editForm.sourceType).valueModes.includes(editForm.valueMode)) {
      invalid('cv-edit-value-mode', 'この起点には注文の金額が無いため、金額の決め方を選び直してください')
      return
    }
    if (editForm.valueMode === 'fixed' && !editForm.fixedValue.trim()) { invalid('cv-edit-value', '1件あたりの金額を入れてください'); return }
    if (editForm.deduplicationMode === 'window' && !editForm.deduplicationWindowDays.trim()) { invalid('cv-edit-window', '数えない日数を入れてください'); return }
    if (editForm.sourceType === 'url_reach' && !editForm.targetUrl.trim()) { invalid('cv-edit-url', '数えてよいページを入れてください'); return }
    if (editForm.attributionDays.trim()
      && (!Number.isInteger(Number(editForm.attributionDays))
        || Number(editForm.attributionDays) < 1 || Number(editForm.attributionDays) > 365)) {
      invalid('cv-edit-days', '計測期間は1〜365日で入れてください（空欄なら既定の90日です）')
      return
    }
    if (editForm.exclusionMemo.trim().length > 500) { invalid('cv-edit-memo', '数えない条件のメモは500文字以内で入力してください'); return }
    const exclusionIssue = findConditionDraftIssue(editForm.exclusion)
    if (exclusionIssue) { invalid('cv-edit-exclusion', exclusionIssue); return }
    setEditFieldIssue(null)
    setEditSaving(true)
    setEditError('')
    try {
      const res = await api.conversions.reviseDefinition(editTarget.id, {
        expectedVersion: editTarget.version,
        name,
        sourceType: editForm.sourceType,
        sourceConfig: {
          ...editTarget.sourceConfig,
          exclusion: pruneCondition(editForm.exclusion),
          exclusionMemo: editForm.exclusionMemo.trim() || null,
        },
        deduplicationMode: editForm.deduplicationMode,
        deduplicationWindowDays: editForm.deduplicationMode === 'window' ? Number(editForm.deduplicationWindowDays) : null,
        valueMode: editForm.valueMode,
        fixedValue: editForm.valueMode === 'fixed' ? Number(editForm.fixedValue) : null,
        reversalPolicy: editForm.reversalPolicy,
        attributionDays: editForm.attributionDays.trim() ? Number(editForm.attributionDays) : null,
        targetUrl: editForm.targetUrl.trim() ? editForm.targetUrl.trim() : null,
        reason: '管理画面で成果地点を編集',
      })
      if (!res.success) throw new Error(res.error)
      setEditTarget(null)
      setEditForm(null)
      setEditValueModeNotice(null)
      await load()
      if (editId !== undefined) router.push('/conversions')
    } catch (error) {
      const fieldFailure = saveErrors.capture(error);


      const message = error instanceof Error ? error.message : ''
      { if (!fieldFailure)
      setEditError(message.includes('更新されています')
        ? 'ほかの人がこの成果地点を先に直しました。上書きしていません。画面を閉じて読み直してから、もう一度お試しください。'
        : withPermissionFailure(error, describeSaveFailure(error), 'store')) }
    } finally {
      setEditSaving(false)
    }
  }

  const openReversal = (event: ConversionDefinitionEvent, kind: 'reverse' | 'restore') => {
    if (!canEdit || !detailTarget || eventsSource?.id !== detailTarget.id || eventsSource.epoch !== stopScope.current.epoch || !definitionEvents.includes(event)) return
    setReversalScope({ epoch: stopScope.current.epoch, definitionId: detailTarget.id, lineAccountId: detailTarget.lineAccountId })
    setReversalTarget({ ...event })
    setReversalKind(kind)
    setReversalReason('')
    setReversalError('')
  }

  /* 成果の取り消し・戻し。元の行は消さず、理由つきの追記を足す。 */
  const submitReversal = async () => {
    if (!reversalTarget || !reversalScope || !detailTarget || !canEdit || reversalScope.epoch !== stopScope.current.epoch || reversalScope.definitionId !== detailTarget.id) return
    if (reversalTarget.latestReversalId === undefined || (reversalTarget.approvalRevision !== null && (typeof reversalTarget.approvalRevision !== 'number' || !Number.isSafeInteger(reversalTarget.approvalRevision) || reversalTarget.approvalRevision < 1))) { setReversalError('確認情報を読み直してから、もう一度お試しください。'); return }
    if (!reversalReason.trim()) { setReversalError('理由を入れてください'); return }
    setReversalBusy(true)
    setReversalError('')
    try {
      const res = await api.conversions.appendReversal(reversalTarget.id, { kind: reversalKind, reason: reversalReason.trim(), expectedReversalId: reversalTarget.latestReversalId, expectedApprovalStatus: reversalTarget.approvalStatus, expectedCancelled: reversalTarget.cancelled, expectedApprovalRevision: reversalTarget.approvalRevision ?? undefined })
      if (stopScope.current.epoch !== reversalScope.epoch) return
      if (!res.success) throw new Error(res.error || '記録できませんでした。時間をおいて、もう一度お試しください。')
      const targetId = reversalScope.definitionId
      setReversalTarget(null)
      setReversalReason('')
      void api.conversions.definitionEvents(targetId, 10)
        .then((ev) => { if (stopScope.current.epoch === reversalScope.epoch && detailTargetRef.current?.id === targetId && ev.success) setDefinitionEvents(ev.data.items) })
        .catch(() => undefined)
      void api.conversions
        .definitions({ ...definitionRange(30), lineAccountId: accountId ?? undefined })
        .then((list) => {
          if (!list.success || stopScope.current.epoch !== reversalScope.epoch) return
          const fresh = list.data.items.find((item) => item.id === targetId)
          if (fresh) setDetailTarget((current) => (current && current.id === targetId ? { ...current, ...fresh } : current))
        })
        .catch(() => undefined)
    } catch (err) {
      if (stopScope.current.epoch !== reversalScope.epoch) return
      const fieldFailure = saveErrors.capture(err)

      { if (!fieldFailure)
      setReversalError(describeApiFailure(err, '保存')) }
    } finally {
      setReversalBusy(false)
    }
  }

  /* 下書きを計測中へ。開いた時点の版を渡す。 */
  const publishDraft = async (target: ConversionDefinitionListItem) => {
    if (publishing || !canEdit) return
    setPublishing(true)
    setIngestError('')
    try {
      const res = await api.conversions.publishDefinition(target.id, { expectedVersion: target.version })
      if (!res.success) throw new Error(res.error)
      setDetailTarget(null)
      await load()
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setIngestError('公開できませんでした。画面を閉じて読み直してから、もう一度お試しください。') }
    } finally {
      setPublishing(false)
    }
  }

  /* 受信鍵の発行・再発行。平文はこの応答でだけ返る。 */
  const issueIngest = async (target: ConversionDefinitionListItem) => {
    if (ingestBusy || !canEdit) return
    setIngestBusy('issue')
    setIngestError('')
    try {
      const res = await api.conversions.issueIngestSecret(target.id, { expectedVersion: target.version })
      if (!res.success) throw new Error(res.error)
      await load()
      setIssuedSecret(res.data.secret)
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setIngestError('鍵を発行できませんでした。画面を閉じて読み直してから、もう一度お試しください。') }
    } finally {
      setIngestBusy('')
    }
  }

  /*
   * 受け口の停止・再開。止めても鍵は残る。押した瞬間に窓を閉じて札を変え、裏で保存する
   * （触り心地 5 回目）。成功したら返ってきた版に置き換える。失敗したら元に戻してトーストで知らせる。
   */
  const toggleIngest = async (target: ConversionDefinitionListItem) => {
    if (ingestBusy || !canEdit) return
    const before = target.ingest.disabledAt
    const disable = !before
    const patch = (id: string, change: Partial<Pick<ConversionDefinitionListItem, 'version'>> & { disabledAt: string | null }) => setDefinitions((current) => current && ({
      ...current,
      items: current.items.map((item) => (item.id === id
        ? { ...item, ...(change.version !== undefined ? { version: change.version } : {}), ingest: { ...item.ingest, disabledAt: change.disabledAt } }
        : item)),
    }))
    setIngestBusy('toggle')
    setIngestError('')
    setDetailTarget(null)
    patch(target.id, { disabledAt: disable ? new Date().toISOString() : null })
    try {
      const res = await api.conversions.setIngestDisabled(target.id, { expectedVersion: target.version, disabled: disable })
      if (!res.success) throw new Error(res.error)
      patch(target.id, { disabledAt: res.data.disabledAt, version: res.data.version })
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)
      patch(target.id, { disabledAt: before })
      { if (!fieldFailure)
      notifyToast(`「${target.name}」の受け口を${disable ? '止められ' : '再開でき'}ませんでした。元に戻しました。`, {
        tone: 'error',
        actionLabel: '読み直す',
        onAction: () => { void load() },
      }) }
    } finally {
      setIngestBusy('')
    }
  }

  const openStop = async (target: ConversionDefinitionListItem, action: ConversionStopAction = 'stop') => {
    if (!canEdit) return
    const epoch = stopScope.current.epoch
    const request = ++stopRequest.current
    setStopEpoch(epoch)
    setStopReason('')
    setDetailTarget(null)
    setStopTarget(target)
    setStopImpact(null)
    setStopError('')
    setStopAction(action)
    setReplacementId('')
    setStopImpactLoading(true)
    try {
      const response = await api.conversions.definitionDeleteImpact(target.id)
      if (stopRequest.current !== request || stopScope.current.epoch !== epoch) return
      if (!response.success) throw new Error(response.error)
      if (response.data.definition.id !== target.id || response.data.definition.version !== target.version) throw new Error('stale')
      setStopImpact(response.data)
    } catch (saveFailure) {
      if (stopRequest.current !== request || stopScope.current.epoch !== epoch) return
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setStopError('利用先と停止の影響を読み込めませんでした。画面を閉じて、もう一度お試しください。') }
    } finally {
      if (stopRequest.current === request && stopScope.current.epoch === epoch) setStopImpactLoading(false)
    }
  }

  /* 止める・差し替える・削除する。影響が読めていないまま確定しない。理由は必須。 */
  const runStop = async () => {
    if (!stopTarget || stopping || !canEdit || stopImpactLoading || stopEpoch !== stopScope.current.epoch) return
    if (!stopImpact) {
      setStopError('利用先と停止の影響を読み込めませんでした。画面を閉じて、もう一度お試しください。')
      return
    }
    if (!stopReason.trim()) {
      setStopError('止める・差し替える・削除する理由を入力してください')
      return
    }
    setStopping(true)
    setStopError('')
    try {
      const replacement = stopImpact.replacementCandidates.find((item) => item.id === replacementId)
      const res = stopAction === 'replace'
        ? replacement
          ? await api.conversions.replaceDefinition(stopTarget.id, {
              replacementId: replacement.id,
              expectedVersion: stopImpact.definition.version,
              replacementExpectedVersion: replacement.version,
              reason: stopReason.trim(),
            })
          : { success: false as const, error: '差し替え先を選んでください' }
        : stopAction === 'delete'
          ? await api.conversions.deleteDefinition(stopTarget.id, { expectedVersion: stopImpact.definition.version, reason: stopReason.trim() })
          : await api.conversions.stopDefinition(stopTarget.id, { expectedVersion: stopImpact.definition.version, reason: stopReason.trim() })
      if (!res.success) throw new Error(res.error)
      setStopTarget(null)
      await load()
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setStopError(stopAction === 'replace'
        ? '利用先を差し替えられませんでした。状態を読み直して、もう一度お試しください。'
        : stopAction === 'delete'
          ? 'この成果地点は削除できませんでした。利用先と成果件数を確認してください。'
          : 'この成果地点の計測を止められませんでした。状態を読み直してから、もう一度お試しください。') }
    } finally {
      setStopping(false)
    }
  }

  /* 複製：同じ数え方で「〇〇のコピー」を作る。使う場所は版が違うと結び直せないので引き継がない。 */
  const duplicatePoint = async (point: ConversionDefinitionListItem) => {
    if (!canEdit || duplicatingId) return
    const lineAccountId = point.lineAccountId ?? selectedAccountId ?? ''
    if (!lineAccountId) {
      setActionError('集計対象のアカウントが無いため、コピーを作れませんでした。')
      return
    }
    setDuplicatingId(point.id)
    setActionError('')
    setActionNotice('')
    try {
      const res = await api.conversions.createDefinition({
        name: `「${point.name}」のコピー`,
        sourceType: point.sourceType,
        sourceConfig: { ...(point.sourceConfig ?? {}) },
        targetUrl: point.targetUrl,
        lineAccountId,
        deduplicationMode: point.deduplicationMode,
        deduplicationWindowDays: point.deduplicationWindowDays,
        valueMode: point.valueMode,
        fixedValue: point.valueMode === 'fixed' ? point.value : null,
        reversalPolicy: point.reversalPolicy,
        attributionDays: point.attributionDays,
        usages: [],
      })
      if (!res.success) throw new Error(res.error)
      setActionNotice(`「${point.name}」のコピーを作りました。使う場所は引き継がないので、要れば足してください。`)
      await load()
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setActionError('コピーを作れませんでした。読み直してから、もう一度お試しください。') }
    } finally {
      setDuplicatingId(null)
    }
  }

  const exportCsv = async () => {
    if (exporting) return
    setExporting(true)
    setExportError('')
    try {
      const blob = await api.conversions.exportDefinitions({ ...definitionRange(30), lineAccountId: accountId ?? undefined })
      downloadCsvBlob(blob, csvFileName("成果地点"))
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setExportError('CSVを書き出せませんでした。権限を確認して、もう一度お試しください。') }
    } finally {
      setExporting(false)
    }
  }

  const points = useMemo(() => definitions?.items ?? [], [definitions])
  const total = definitions?.pagination.total ?? null
  const stateCounts = definitions?.stateCounts ?? null

  /* 画面で絞るのは状態だけ（探す言葉と並びは口が済ませている）。 */
  const shown = useMemo(() => points.filter((point) => {
    if (folderFilter === FOLDER_UNFILED ? Boolean(point.folderId) : folderFilter !== '' && point.folderId !== folderFilter) return false
    if (status === 'all') return true
    if (status === 'unused') return point.usageCount === 0
    return point.state === status
  }), [folderFilter, points, status])

  const pageCount = Math.max(1, Math.ceil(shown.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  const current = useMemo(() => shown.slice((currentPage - 1) * pageSize, currentPage * pageSize), [currentPage, pageSize, shown])
  useEffect(() => { if (page > pageCount) setPage(pageCount) }, [page, pageCount])
  useEffect(() => { setPage(1) }, [debouncedQuery, status, sort, pageSize, folderFilter])
  /* アカウントを切り替えたら、前のアカウントのフォルダの選択を外す。 */
  const folderAccountRef = useRef(accountId)
  useEffect(() => {
    if (folderAccountRef.current === accountId) return
    folderAccountRef.current = accountId
    setFolderFilter('')
  }, [accountId, setFolderFilter])

  const highlightedPoint = useMemo(() => (highlightId ? points.find((point) => point.id === highlightId) ?? null : null), [points, highlightId])
  useEffect(() => {
    if (!highlightedPoint) return
    const index = shown.findIndex((point) => point.id === highlightedPoint.id)
    if (index >= 0) setPage(Math.floor(index / pageSize) + 1)
  }, [highlightedPoint, pageSize, shown])
  useEffect(() => {
    if (!highlightedPoint || typeof document === 'undefined') return
    document.querySelector(`tr[data-row-id="${CSS.escape(highlightedPoint.id)}"]`)?.scrollIntoView({ block: 'center' })
  }, [highlightedPoint, current])

  const panelPoint = panelId ? points.find((point) => point.id === panelId) ?? null : null

  const kpi = useMemo(() => ({
    currentCount: summaryReport?.kpis.netCount ?? points.reduce((sum, row) => sum + row.metrics.netCount, 0),
    previousCount: summaryReport?.kpis.previousNetCount ?? null,
    currentValue: summaryReport?.kpis.netValue ?? points.reduce((sum, row) => sum + row.metrics.netValue, 0),
    unusedCount: stateCounts?.unused ?? null,
  }), [points, summaryReport, stateCounts])

  const addUsageHref = (point: ConversionDefinitionListItem) =>
    `/analytics?tab=funnel&conversionPointId=${encodeURIComponent(point.id)}&conversionPointName=${encodeURIComponent(point.name)}`

  /* 行の「…」。見るだけの操作は誰でも、変える操作は権限のある人だけに出す（押せない物は置かない）。 */
  const folderMove = useFolderMove({
    accountId: accountId, canEdit: canEdit, items: current, folders,
    move: (item, folderId) => moveConversionToFolder(item, folderId),
    onChanged: async () => { await load(); await folderState.reload() },
  })

  const rowMenuItems = (point: ConversionDefinitionListItem): ActionMenuItem[] => [
    { id: 'detail', label: "成果地点の詳細を見る", onSelect: () => setDetailTarget(point) },
    { id: 'usage', label: '使う場所を見る', onSelect: () => setPanelId(point.id) },
    ...(canEdit ? [
      { id: 'move', label: 'フォルダへ移す', onSelect: () => folderMove.open(point) },
      { id: 'add-usage', label: '使う場所を足す', external: false, href: addUsageHref(point), onSelect: () => router.push(addUsageHref(point)) },
      ...(point.status !== 'stopped' ? [{ id: 'edit', label: '編集する', onSelect: () => openEdit(point) }] : []),
      ...(point.state === 'draft'
        ? [{ id: 'publish', label: '公開する', disabled: publishing, onSelect: () => void publishDraft(point) }]
        : point.status !== 'stopped'
          ? [{ id: 'stop', label: '止める', onSelect: () => void openStop(point, 'stop') }]
          : []),
      { id: 'duplicate', label: '複製する', disabled: duplicatingId !== null, onSelect: () => void duplicatePoint(point) },
    ] : []),
  ]

  /* ===== フォルダ ===== */
  /* 共通のフォルダ（種類 conversion）。すべて・各フォルダ・未分類・追加・「…」（名前・色・並べ替え・消す）。 */
  const folderSelect = (
    <SaveErrorField names={["folderFilter","folder_filter"]}><Select
      narrowFolderPicker aria-label="フォルダ"
      value={folderFilter}
      onChange={setFolderFilter}
      options={managedFolderOptions('conversion', folders, { allId: '', unfiledId: FOLDER_UNFILED })}
    /></SaveErrorField>
  )
  /* 閲覧のみには作るボタンを置かない（場所だけ空ける）。 */
  const createLink = <Button variant="primary" href="/conversions/new"><Plus size={16} aria-hidden="true" />成果地点を作る</Button>
  const createButton = canEdit ? createLink : <span className={styles.createSpace} aria-hidden="true" />
  const createInRow = canEdit ? createLink : <span className={styles.createSpaceRow} aria-hidden="true" />

  /* ===== 道具の段 ===== */
  /* 1152 の板は札を2つ（動いている・止めている）だけ。ほかの状態は「よく使う絞り込み」から選ぶ。 */
  const chipList = narrow || (role !== null && !canEdit) ? CHIPS.slice(0, 2) : CHIPS
  const filterChips = (
    <SegmentedControl<StatusFilter> aria-label="状態で絞り込む" fit="content" value={status} onClear={() => setStatus('all')} onChange={setStatus}
      options={[{ value: 'all', label: 'すべて' }, ...chipList.map((chip) => ({ value: chip.value, label: chip.value === 'unused' ? '使っていない' : chip.label, title: chip.label, ariaLabel: stateCounts?.[chip.value] === undefined ? chip.label : `${chip.label} ${formatNumber(stateCounts[chip.value])}`, count: stateCounts?.[chip.value] }))]} />
  )
  const sortBox = (
    <>
      <SortSelect value={sort} onChange={(value) => setSort(value as PointSort)} options={SORT_OPTIONS} label="並び：" />
    </>
  )
  const savedBox = (
    <SaveErrorField names={["status","sort"]}><Select size="content" icon={<Bookmark size={16} aria-hidden="true" />} showChevron={false}
        aria-label="よく使う絞り込み"
        value={status === 'all' ? '' : status}
        onChange={(value) => {
          if (value.startsWith('sort:')) setSort(value.slice(5) as PointSort)
          else setStatus((value || 'all') as StatusFilter)
        }}
        options={[
          { value: '', label: 'よく使う絞り込み' },
          ...CHIPS.map((chip) => ({ value: chip.value, label: `${chip.label}だけ` })),
          ...(role !== null && !canEdit ? SORT_OPTIONS.map((option) => ({ value: `sort:${option.value}`, label: `並び：${option.label}` })) : []),
        ]}
      /></SaveErrorField>
  )
  const perPageBox = <PageSizeSelect value={pageSize} onChange={setPageSize} options={[10, 20, 50]} label={null} />
  const notice = (
    null
  )
  const searchBox = (
    <SearchField value={query} onChange={setQuery} onClear={() => setQuery('')} placeholder="成果地点の名前で探す" aria-label="成果地点の名前で探す" />
  )
  /* 1152 の板：案内の帯 → 1段目「作る・フォルダ・探す」→ 2段目「札 … よく使う絞り込み・件数」。 */

  const wideToolbar = (
    <div className={styles.wideTools} data-viewer={role !== null && !canEdit || undefined}>

      {/* 絵 r6dJFy：1段目「探す・状態の札」、2段目の右端に「よく使う絞り込み・並び・件数」。1段に詰めると札が選ぶ欄へ畳まれる。 */}
      <ListToolbarFrame layout="stacked">
        <ListToolbarRow>
          <ListToolbarSearchSlot width={160} search={{ placeholder: '成果地点の名前で探す', label: '成果地点の名前で探す', value: query, onChange: setQuery }} />
          {filterChips}
        </ListToolbarRow>
        <ListToolbarRow>
          <ListToolbarEnd>{savedBox}{canEdit ? sortBox : null}{perPageBox}</ListToolbarEnd>
        </ListToolbarRow>
      </ListToolbarFrame>
    </div>
  )

  const clearFilters = () => {
    setQuery('')
    setDebouncedQuery('')
    setStatus('all')
    setPage(1)
  }

  /* ===== 右の詳細パネルと停止の確認 ===== */
  const detailCard = panelPoint ? (
    <DetailPanel open contentSpacing="sections" title={panelPoint.name} onClose={() => setPanelId(null)}
      actions={{menuLabel: `詳細「${panelPoint.name}」のその他の操作`, menuItems: [...(panelPoint.measureMethod === 'webhook' && panelPoint.status !== 'stopped' ? [{ allowed: canEdit, id: 'body-0', label: ingestBusy ? "発行しています…" : "鍵を発行する", disabled: ingestBusy !== '', onSelect: () => issueIngest(panelPoint) }] : []),
        ...(panelPoint.state === 'draft' ? [{ allowed: canEdit, id: 'body-2', label: publishing ? "公開しています…" : "公開する", disabled: publishing, onSelect: () => publishDraft(panelPoint) }] : []),
        ...(panelPoint.status !== 'stopped' && panelPoint.state !== 'draft' ? [{ allowed: canEdit, id: 'body-3', label: "止める", onSelect: () => openStop(panelPoint, 'stop') }] : []),
        ...([
            ...(panelPoint.measureMethod === 'webhook' && panelPoint.ingest.configured && panelPoint.status !== 'stopped' ? [{
                    allowed: canEdit,
                    id: 'toggle-ingest', label: panelPoint.ingest.disabledAt ? '受け口を再開する' : '受け口を止める',
                    disabled: ingestBusy !== '', onSelect: () => void toggleIngest(panelPoint)
                }] : []),
            { id: 'events', label: "成果地点の詳細を見る", onSelect: () => setDetailTarget(panelPoint) },
            { id: 'close', label: '閉じる', onSelect: () => setPanelId(null) },
        ]), ...(panelPoint.status !== 'stopped' ? [{ allowed: canEdit, id: 'detail-0', label: "削除する", onSelect: () => openStop(panelPoint, 'delete'), tone: 'danger' as const }] : [])], primary: (panelPoint.status !== 'stopped' ? <Button variant="primary" onClick={() => openEdit(panelPoint)}>編集する</Button> : null), primaryAllowed: canEdit }} status={<StatePill point={panelPoint} />}>
<DetailContent>

      <div className={styles.panelFact}>
        <DetailField label="何が起きたら数えるか"><span title={sourceTriggerLabel(panelPoint)}>{`${shortTrigger(panelPoint)}・${rowSub(panelPoint)}`}</span></DetailField>
      </div>
      <div className={styles.panelFact}>
        <DetailField label="今月の成果"> {`${formatNumber(panelPoint.metrics.netCount)} 件${panelPoint.metrics.netValue == null ? '' : `・${formatYen(panelPoint.metrics.netValue)}`}`} </DetailField>
      </div>
      <div className={styles.panelFact}>
        <DetailField label="使われている場所"> {usageLabel(panelPoint)} </DetailField>
      </div>
      {panelPoint.measureMethod === 'webhook' ? (
        <div className={styles.panelFact}>
          <DetailField label="受け口">
            {`POST /api/conversions/ingest/${panelPoint.id}${panelPoint.ingest.disabledAt ? '（止まっています）' : panelPoint.ingest.configured ? '（動いています）' : '（まだ鍵を発行していません）'}`}
           </DetailField>
        </div>
      ) : null}
      {issuedSecret && panelPoint.measureMethod === 'webhook' ? (
        <p className={styles.secretBox} role="status">{`発行した鍵（この表示でだけ見られます。連携先へ渡してください）：${issuedSecret}`}</p>
      ) : null}
      {ingestError ? <Notice tone="danger" >{ingestError}</Notice> : null}



</DetailContent>
</DetailPanel>
  ) : null

  const stopCard = stopTarget && stopEpoch === stopScope.current.epoch ? (
    <Dialog open contentLayout="form" description={stopImpactLoading
          ? '利用先と影響を読み込んでいます。'
          : stopImpact
            ? `${formatNumber(stopImpact.stopImpact.affectedUsageCount)}か所で使われています。どうしますか。`
            : '利用先と影響を読み込めませんでした。'} title={`「${stopTarget.name}」を止めますか？`} designWidth={480} designTop={220} busy={stopping} onCancel={() => setStopTarget(null)} footer={<DialogActions>
        <Button onClick={() => setStopTarget(null)} disabled={stopping}>キャンセル</Button>
        <Button
          variant={stopAction === 'delete' ? 'danger' : 'primary'}
          disabled={stopping || stopImpactLoading || !stopReason.trim() || (stopAction === 'replace' && !replacementId)}
          disabledReason={stopping ? '止めています。' : stopImpactLoading ? '利用先と影響を確認しています。' : !stopReason.trim() ? '止める理由を入力してください。' : stopAction === 'replace' && !replacementId ? '差し替え先を選んでください。' : undefined}
          onClick={() => runStop()}
          busy={stopping || stopImpactLoading}
          busyLabel="止めています" widthReserve="idle"
        >
          {stopAction === 'delete' ? '削除する' : '止める'}
        </Button>
      </DialogActions>}>

      <OperationTargetSummary accounts={[{ id: stopTarget.lineAccountId ?? '', name: accounts.find(account => account.id === stopTarget.lineAccountId)?.name }]} />
      <SaveErrorField names={["conversion-v8-stop-action","stopAction"]}><RadioCardGroup legend="どうしますか？">
        <RadioCard
          variant="row"
          name="conversion-v8-stop-action"
          value="stop"
          checked={stopAction === 'stop'}
          onChange={() => setStopAction('stop')}
          title="止める（使う所の計測も止まる）"
        />
        <RadioCard
          variant="row"
          name="conversion-v8-stop-action"
          value="replace"
          checked={stopAction === 'replace'}
          onChange={() => setStopAction('replace')}
          disabled={!stopImpact?.replacementCandidates.length}
          disabledReason="差し替え先の成果地点がありません"
          title="別の成果地点に差し替えてから止める"
        />
        <RadioCard
          variant="row"
          name="conversion-v8-stop-action"
          value="delete"
          checked={stopAction === 'delete'}
          onChange={() => setStopAction('delete')}
          disabled={!stopImpact?.canDelete}
          disabledReason="成果または利用先があるため、物理削除は選べません。"
          title="削除する（使われていないときだけ選べる）"
        />
      </RadioCardGroup></SaveErrorField>
      {stopAction === 'replace' ? (
        <div className={styles.fieldBox}>
          <SaveErrorField names={["replacementId","replacement_id"]}><EntitySelect
            aria-label="差し替え先の成果地点"
            value={replacementId}
            options={[
              { value: '', label: '差し替え先を選ぶ' },
              ...(stopImpact?.replacementCandidates ?? []).map((item) => ({ ...entityOptionMetadata(item), value: item.id, label: `差し替え先：${item.name}` })),
            ]}
            onChange={setReplacementId}
          /></SaveErrorField>
        </div>
      ) : null}
      <Field label="理由（必須）" htmlFor="cv-stop-reason">
        <SaveErrorField names={["stopReason","reason","stop_reason"]}><TextField
          aria-label="止める理由"
          value={stopReason}
          maxLength={500}
          placeholder="計測の仕方を変えるため"
          onChange={(event) => setStopReason(event.target.value)}
        /></SaveErrorField>
      </Field>
      {stopError ? <Notice tone="danger" >{stopError}</Notice> : null}
      <Disclosure title="操作の影響を確認する" size="compact">
        <p className={styles.panelText}>対象：{stopTarget.name}</p>
        <p className={styles.panelText}>止める：これから先は数えません。過去の記録と分析は残します。</p>
        <p className={styles.panelText}>差し替える：利用先を別の成果地点へ切り替え、過去の数字を残します。</p>
        <p className={styles.panelText}>削除する：成果0件・利用先0件のときに、この成果地点だけを削除できます。</p>
      </Disclosure>
    </Dialog>
  ) : null

  /* ===== 表 ===== */
  let listBody: ReactNode
  if (loading) {
    listBody = <ListSkeleton />
  } else if (loadFailed) {
    listBody = (
      <ListState
        kind="error"
        title="成果地点を読み込めませんでした"
        description="数の帯は「—」です。検索や絞り込みはそのまま使えます（条件を変えてから試し直せます）。"
        onRetry={() => void load()}
      />
    )
  } else if (shown.length === 0) {
    /* 修正案 D-2：空の一覧。 */
    listBody = (
      <EmptyList
        icon={<Target aria-hidden="true" />}
        title="まだ成果地点がありません"
        description="「商品を買った」など、成果として数えるできごとを決めます。"
        create={{ label: '最初の成果地点を作る', href: '/conversions/new' }}
        canCreate={canEdit}
        filtered={points.length > 0 || Boolean(debouncedQuery)}
        onClearFilters={clearFilters}
      />
    )
  } else {
    listBody = (
      <>
        {listTruncated ? (
          <div className={styles.inlineNotice}>
            <Notice tone="warn">一覧は先頭5000個までを表示しています。これより後ろの成果地点は検索や絞り込みで範囲を分けて確認してください。</Notice>
          </div>
        ) : null}
        <div className={styles.tableWrap}>
          <DataTable columnLayout={{ headHeight: 'var(--tpl-cn-head-h)', rowHeight: 'var(--tpl-cn-row-h)', gap: 'var(--tpl-cn-col-gap)', padding: '0 var(--tpl-list-inset)', numberInset: 'var(--tpl-cn-num-pad-end)', bodyTextSize: 'var(--polish-text-body)', collapseScope: 'page' }}>
            <TableHead selection={folderMove.pageCheckbox} />
            <tbody>
              {current.map((point) => {
                const usage = usageLines(point)
                const menuLabel = `成果地点「${point.name}」の操作`
                const highlighted = highlightedPoint?.id === point.id
                return (
                  <Tr
                    key={point.id}
                    interactive
                    selected={folderMove.isSelected(point.id) || panelId === point.id || highlighted}
                    data-table-layout="columns"
                    data-row-id={point.id}
                    detailKey="point" onOpen={() => setPanelId((currentId) => (currentId === point.id ? null : point.id))}
                  >
                    <Td grow>
                      {/* 名前の前に左の列と同じフォルダの色の丸（未分類は色の無い輪）。札は名前の頭にそろえる。 */}
                      <FolderDotName folder={folderDotFor(folders, point.folderId)} dot={!narrow}>{folderMove.checkbox(point)}
                      <RowNameButton
                        title={point.name}
                        aria-expanded={panelId === point.id}
                        aria-label={`「${point.name}」の詳細を見る`}
                        onClick={(event) => { event.stopPropagation(); setPanelId((currentId) => (currentId === point.id ? null : point.id)) }}
                      >
                        {point.name}
                      </RowNameButton>
                      </FolderDotName>

                    </Td>
                    <Td className={styles.colState}><StatePill point={point} /></Td>
                    <Td className={styles.colTrigger} collapseAt="narrow">
                      <span className={styles.cellMain} title={sourceTriggerLabel(point)}>{shortTrigger(point)}</span>
                      <span className={styles.cellSub} title={rowSub(point)}>{rowSub(point)}</span>
                    </Td>
                    <Td className={styles.colCount} align="right"><span className={styles.num}>{`${formatNumber(point.metrics.netCount)} 件`}</span></Td>
                    <Td className={styles.colValue} align="right">
                      <span className={styles.num}>{point.metrics.netValue > 0 ? `${formatYen(point.metrics.netValue)}` : emptyValue('unknown')}</span>
                    </Td>
                    <Td className={styles.colUsage} collapseAt="narrow">
                      <span className={styles.usageMain} title={usageLabel(point)}><TruncatedText value={usage.main} /></span>
                      {usage.sub ? <span className={styles.cellSub} title={usage.sub}>{usage.sub}</span> : null}
                    </Td>
                    <ActionCell className={styles.colOps}>
                      <div className={styles.opsBox}>
                        <RowMenu
                          label={menuLabel}
                          open={openMenuId === point.id}
                          onOpenChange={(next) => setOpenMenuId(next ? point.id : null)}
                          items={rowMenuItems(point).map((item) => ({ ...item, onSelect: () => { setOpenMenuId(null); item.onSelect?.() } }))}
                        />
                      </div>
                    </ActionCell>
                  </Tr>
                )
              })}
            </tbody>
          </DataTable>
        </div>
        {detailCard}{stopCard}
      </>
    )
  }

  const pager = !loading && !loadFailed && shown.length > 0 ? (
    <ListPager>
      <Pagination page={currentPage} pageCount={pageCount} onPageChange={setPage} ariaLabel="成果地点の一覧のページ送り" range={{ total: shown.length, first: (currentPage - 1) * pageSize + 1, last: (currentPage - 1) * pageSize + current.length }} />
    </ListPager>
  ) : null

  const listUnavailable = loading || loadFailed
  const reportUnavailable = listUnavailable || reportFailed
  const delta = kpi.previousCount === null ? null : kpi.currentCount - kpi.previousCount

  const editSurface = (<ConversionEditDialog surface={editId !== undefined ? 'page' : 'dialog'}
          editTarget={editTarget}
          setEditTarget={(target) => { setEditTarget(target); if (!target && editId) router.push('/conversions') }}
          editForm={editForm}
          setEditForm={(next) => {
            const changed = typeof next === 'function' ? next(editForm) : next
            if (editFieldIssue && editForm && changed) {
              const fieldKeys: Record<string, keyof EditForm> = {
                'cv-edit-name': 'name', 'cv-edit-url': 'targetUrl', 'cv-edit-value-mode': 'valueMode',
                'cv-edit-value': 'fixedValue', 'cv-edit-window': 'deduplicationWindowDays',
                'cv-edit-days': 'attributionDays', 'cv-edit-memo': 'exclusionMemo', 'cv-edit-exclusion': 'exclusion',
              }
              const key = fieldKeys[editFieldIssue.field]
              if (key && editForm[key] !== changed[key]) setEditFieldIssue(null)
            }
            setEditForm(changed)
          }}
          editValueModeNotice={editValueModeNotice}
          setEditValueModeNotice={setEditValueModeNotice}
          editSaving={editSaving}
          editError={editError}
          editFieldIssue={editFieldIssue}
          submitEdit={() => void submitEdit()}
        />)
  if (editId !== undefined) {
    if (loading) return <ListState kind="loading" />
    if (!canEdit || !editTarget) return <ListState kind="error" title="この成果地点を編集できません" description="権限と成果地点を確認してください。" />
    return editSurface
  }

  return (
    <SaveErrorScope errors={saveErrors}><ListPage
      skeleton
      help={canEdit
            ? '行の「…」から 編集・使う場所を見る・使う場所を足す・止める・複製。止めると、使っている配信や流入リンクでも数えなくなります。'
            : '行の「…」から 中身と使う場所を見られます。止めると、使っている配信や流入リンクでも数えなくなります。'}
      explanation="成果地点は、配信・流入リンク・アフィリエイトの成果を数えるときに使います。止めると、使っている所でも数えなくなります。"
      boardId="r6dJFy"
      headingSize="regular"
      title={inAffiliateTabs ? '成果とアフィリエイト' : 'コンバージョン'}
      tabs={inAffiliateTabs ? <AffiliateTabs /> : undefined}
      actions={
        <Button onClick={() => exportCsv()} disabled={exporting} busy={exporting} busyLabel="書き出しています…">
          <Download size={16} aria-hidden="true" />CSVで書き出す
        </Button>
      }
      stats={<>
        {!canEdit && role !== null ? (
          <div className={styles.viewerBand}><ReadOnlyNotice role="status"></ReadOnlyNotice></div>
        ) : null}
        {exportError ? <div className={styles.statsNotice}><Notice tone="warn">{exportError}</Notice></div> : null}
        {actionError ? <div className={styles.statsNotice}><Notice tone="warn">{actionError}</Notice></div> : null}
        {actionNotice ? <div className={styles.statsNotice}><Notice tone="success">{actionNotice}</Notice></div> : null}
        {highlightedPoint ? <div className={styles.statsNotice}><Notice tone="success">{`「${highlightedPoint.name}」を保存しました。色の付いた行です。`}</Notice></div> : null}
        {reportFailed && !loadFailed ? (
          <div className={styles.statsNotice}>
            <Notice tone="info" action={<Button onClick={() => reloadReport()} busyLabel="処理中…">集計を読み直す</Button>}>集計を表示できませんでした。一覧はそのまま使えます。</Notice>
          </div>
        ) : null}
        <KpiBand>
          <KpiCard
            presentation="band"
            title="成果地点"
            icon={<Target size={16} aria-hidden="true" />}
            help="登録している成果地点の数です。"
            value={listUnavailable ? null : total}
            unit="件"
            detail={stateCounts ? `有効 ${formatNumber(stateCounts.active)}・下書き ${formatNumber(stateCounts.draft)}・停止中 ${formatNumber(stateCounts.stopped)}` : emptyValue('unknown')}
          />
          <KpiCard
            presentation="band"
            title="この30日の成果"
            icon={<Trophy size={16} aria-hidden="true" />}
            help="この30日に数えた成果の件数です（取り消しを引いた数）。"
            value={reportUnavailable ? null : kpi.currentCount}
            unit="件"
            detail={delta === null || reportUnavailable ? emptyValue('unknown') : <span title={`前の30日 ${formatNumber(kpi.previousCount ?? 0)}件`}>{`その前の30日より ${delta >= 0 ? '+' : ''}${formatNumber(delta)}`}</span>}
          />
          <KpiCard
            presentation="band"
            title="この30日の金額"
            icon={<Banknote size={16} aria-hidden="true" />}
            help="この30日に数えた成果の金額の合計です。"
            value={reportUnavailable ? null : kpi.currentValue}
            valueText={reportUnavailable ? undefined : `${formatYen(kpi.currentValue)}`}
            unit=""
            detail={<span title={listUnavailable ? '金額の内訳を読み込めませんでした' : `${formatNumber(points.filter(point => point.value != null).length)}個の成果地点で金額を記録`}>{listTruncated ? '直近5000件までの合計です' : '注文の金額で数えるもの'}</span>}
          />
          <KpiCard
            presentation="band"
            title={narrow ? '使われていない' : 'どこからも使われていない'}
            icon={<Unplug size={16} aria-hidden="true" />}
            help="配信・流入リンク・アフィリエイトのどこからも使われていない成果地点です。"
            value={listUnavailable ? null : kpi.unusedCount}
            unit="件"
            detail="配信・流入・アフィリエイトで未使用"
          />
        </KpiBand>
      </>}
      folders={<ManagedFolderPanel
          createAction={createButton}
          kind="conversion"
          accountId={accountId}
          folders={folders}
          onChanged={folderState.reload}
          canManage={canEdit}
          itemLabel="成果地点"
          activeId={folderFilter}
          onSelect={setFolderFilter}
          allId=""
          unfiledId={FOLDER_UNFILED}
          allCount={total}
          unfiledCount={folderState.unfiledCount}
          error={folderState.error}
        />}
      collapsedFolders={<>{createInRow}{folderSelect}</>}
      toolbar={wideToolbar}
      pagination={pager}
      overlays={<>
        {folderMove.overlays}
        <ConversionDetailDialog
          detailTarget={detailTarget}
          setDetailTarget={setDetailTarget}
          publishing={publishing}
          publishDraft={(target) => void publishDraft(target)}
          openEdit={openEdit}
          openStop={(target) => void openStop(target)}
          issueIngest={(target) => void issueIngest(target)}
          toggleIngest={(target) => void toggleIngest(target)}
          ingestBusy={ingestBusy}
          ingestError={ingestError}
          issuedSecret={issuedSecret}
          ingestEvents={ingestEvents}
          definitionEvents={eventsSource?.id === detailTarget?.id && eventsSource?.epoch === stopScope.current.epoch ? definitionEvents : []}
          eventsFailed={eventsFailed}
          canReverse={canEdit}
          openReversal={openReversal}
        />
        <ConversionReversalDialog
          reversalTarget={reversalScope?.epoch === stopScope.current.epoch && reversalScope?.definitionId === detailTarget?.id ? reversalTarget : null}
          account={{ id: reversalScope?.lineAccountId ?? '', name: reversalScope?.lineAccountId ? accounts.find(account => account.id === reversalScope.lineAccountId)?.name : '不明' }}
          reversalKind={reversalKind}
          reversalBusy={reversalBusy}
          reversalError={reversalError}
          reversalReason={reversalReason}
          setReversalTarget={setReversalTarget}
          setReversalReason={setReversalReason}
          submitReversal={() => void submitReversal()}
        />{editSurface}
      </>}
    >
      {listBody}
    </ListPage></SaveErrorScope>
  )
}
