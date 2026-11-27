'use client'

import { knownValue } from '@/lib/known-value'

import PermissionGatedButton from '@/components/shared/permission-gated-button'

import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'
import SegmentedControl from '@/components/shared/segmented'
import { FOLDER_SELECT_COLORS } from '@/components/shared/folder-select'

import { KIND_LABEL,KIND_TABS,STARTER_SET_TAB,TAG_QUICK_FILTERS,WORDS,type TagQuickFilter } from './store-list-options'
export { KIND_TABS,hqTemplateTabsForStarterSets } from './store-list-options'
export { sentLabel,stateOf } from './store-list-stats'
export { type HqStoreListProps } from './store-list-types'

import { type HqStoreListProps } from './store-list-types'

import ActionMenu,{ type ActionMenuItem } from '@/components/shared/action-menu'
import Button from '@/components/shared/button'
import Checkbox from '@/components/shared/checkbox'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import EmptyList from '@/components/shared/empty-list'
import { emptyValue, EmptyCell } from '@/components/shared/empty-value'
import FilterChip from '@/components/shared/filter-chip'
import { folderDisplayColor } from '@/components/shared/folder-dot'
import FolderEditorDialog from '@/components/shared/folder-editor-dialog'
import { describeFolderFailure } from '@/components/shared/folder-failure'
import FolderPanel,{ FolderPanelNote,type FolderPanelRow } from '@/components/shared/folder-panel'
import { deleteFolderDescription } from '@/components/shared/folder-row-actions'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListDateTime from '@/components/shared/list-date-time'
import ListToolbar from '@/components/shared/list-toolbar'
import { useListUrlValue } from '@/components/shared/list-url-state'
import Notice from '@/components/shared/notice'
import { PAGE_SIZE_SELECT_OPTIONS } from '@/components/shared/page-size-select'
import Pagination from '@/components/shared/pagination'
import { RowMenu } from '@/components/shared/row-actions'
import { SaveErrorField,SaveErrorScope,useSaveFormErrors } from '@/components/shared/save-form-errors'
import Select from '@/components/shared/select'
import StatusBadge from '@/components/shared/status-badge'
import TruncatedText from '@/components/shared/truncated-text'
import { DataTable,NameCell,RowNameLink,TableHeadRow,Td,Th,Tr } from '@/components/shared/table'
import { Tabs,type TabItem } from '@/components/shared/tabs'
import TagPill from '@/components/shared/tag-pill'
import { notifyToast } from '@/components/shared/toast'
import { ListPage } from '@/components/templates'
import { formatNumber } from '@/lib/format'
import type { HqTemplate } from '@/lib/hq-templates-api'
import { useNarrowViewport } from '@/lib/use-narrow-viewport'
import type { HqTemplateFolder,TemplateKind } from '@line-crm/shared'
import { Archive,Bookmark,Braces,Check,CircleDashed,Copy,FileText,Inbox,Link,Pencil,Plus,Send,Sparkles,Trash2,Unlink,Users } from 'lucide-react'
import { useContext,useMemo,useRef,useState,type ReactNode } from 'react'
import storeStyles from '../templates/list.module.css'
import { AttributeTabs,OtherTabPanel,assignmentMethods,cleanupTagCount,cleanupTagIds,matchesTagFilters,unusedTagCount,useAttributeTab,type TagUsageFilter } from './attribute-tabs'
import attributeStyles from './attribute-tabs.module.css'
import { distributedAccountsLine,hqMessageTypeLabel,templateSubLine } from './list-row'
import { sentLabel,stateOf,sumOrNull } from './store-list-stats'
import hqStyles from './store-list.module.css'


const PAGE_SIZE_OPTIONS = PAGE_SIZE_SELECT_OPTIONS

export default function HqStoreList(props: HqStoreListProps) {
  const saveErrors = useSaveFormErrors()
  const {
    type, rows, ready, busy, canEdit, accountTotal, stats, kind, kindCounts, onKindChange, folders, folderLoadFailed, folderFilter, onFolderFilter,
    onAddFolder, onRenameFolder, onDeleteFolder, onReloadFolders, onCreate, onEdit, onOpen, itemHref, onDistribute, onDistributeFolder, folderContents, onDuplicate, onRemove, notices, overlays,
  } = props
  const words = WORDS[type]
  const [query, setQuery] = useListUrlValue('q', '')
  const [undistributedOnly, setUndistributedOnly] = useListUrlValue('undistributedOnly', false)
  /* タグだけ：上のタブ（タグ・友だち情報欄・対応マーク・保存した検索）と、使用状態・付け方の絞り込み。 */
  const attribute = useAttributeTab('/hq/friend-attributes')
  const [tagUsage, setTagUsage] = useState<TagUsageFilter>('all')
  const [tagMethod, setTagMethod] = useState('all')
  /* タグの「よく使う絞り込み」：数の帯と同じ2つ（新しい版を未配布・整理の候補）を重ねて絞る。 */
  const [tagQuick, setTagQuick] = useState<TagQuickFilter[]>([])
  const [tagQuickOpen, setTagQuickOpen] = useState(false)
  /* テンプレート：1通のみ・複数通・差し込みありの札（保存版の通数・差し込みの有無。API 組5）と、行のまとめて選ぶ印。 */
  const [tplCount, setTplCount] = useState<'single' | 'multiple' | null>(null)
  const [tplVars, setTplVars] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const narrow = useNarrowViewport()
  const [pageSize, setPageSize] = useListUrlValue('pageSize', 20)
  const [page, setPage] = useListUrlValue('page', 1)
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  /* 分類（フォルダ）の窓：足す・名前を変える（統括のひな形の分類は色を持たない）・消す。 */
  const [folderDialog, setFolderDialog] = useState<{ editing: HqTemplateFolder | null } | null>(null)
  const [folderName, setFolderName] = useState('')
  const [folderColor, setFolderColor] = useState<string | null>(FOLDER_SELECT_COLORS[0].value)
  const [deletingFolder, setDeletingFolder] = useState<HqTemplateFolder | null>(null)
  const deleteTicket = useRef<object | null>(null)
  const renderedDeleteTicket = deleteTicket.current
  const deleteLock = useRef(false)
  const [folderBusy, setFolderBusy] = useState(false)
  const depth = useContext(OverlayDepthContext)
  const folderGuard = useUnsavedGuard({
    dirty: folderDialog !== null && (folderName !== (folderDialog.editing?.name ?? '') || folderColor !== (folderDialog.editing ? folderDisplayColor(folderDialog.editing) : FOLDER_SELECT_COLORS[0].value) || folderBusy),
    busy: folderDialog !== null && folderBusy,
    onDiscard: () => setFolderDialog(null),
  })
  const [folderError, setFolderError] = useState('')
  const [folderNameError, setFolderNameError] = useState('')
  /* 送る版（revision）はいつも今の一覧から引く。409 で読み直したあとの2回目の保存が新しい版で通る。 */
  const latestFolder = (folder: HqTemplateFolder) => folders.find((f) => f.id === folder.id) ?? folder

  const folderOf = (id: string | null | undefined) => folders.find((folder) => folder.id === id) ?? null
  const countIn = (id: string) => rows.filter((row) => (row.folder_id ?? 'none') === id).length

  const cleanupNames = useMemo(() => cleanupTagIds(rows), [rows])
  const filtered = useMemo(() => {
    const words = query.normalize('NFKC').toLocaleLowerCase('ja-JP').trim()
    return rows.filter((row) => {
      if (folderFilter !== 'all' && (row.folder_id ?? 'none') !== folderFilter) return false
      if (undistributedOnly && (row.distributed_account_count ?? 0) > 0) return false
      if (type === 'tag' && !matchesTagFilters(row, tagUsage, tagMethod)) return false
      if (type === 'template' && tplCount === 'single' && row.message_count !== 1) return false
      if (type === 'template' && tplCount === 'multiple' && !((row.message_count ?? 0) > 1)) return false
      if (type === 'template' && tplVars && row.has_interpolations !== true) return false
      if (type === 'tag' && tagQuick.includes('outdated') && (row.outdated_account_count ?? 0) === 0) return false
      if (type === 'tag' && tagQuick.includes('cleanup') && !cleanupNames.has(row.id)) return false
      if (!words) return true
      return [row.name, row.description ?? '', row.content_summary ?? ''].some((text) => text.normalize('NFKC').toLocaleLowerCase('ja-JP').includes(words))
    })
  }, [rows, folderFilter, undistributedOnly, query, type, tagUsage, tagMethod, tagQuick, cleanupNames, tplCount, tplVars])
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const current = Math.min(page, pageCount)
  const shown = filtered.slice((current - 1) * pageSize, current * pageSize)

  /*
   * 数の帯：ひな形（下書き N件＝まだ配っていない）・配ったアカウント・今月送った数（テンプレートだけ。
   * ほかの種類は配ったひな形）・新しい版を未配布（API-18。直したあと配っていない先があるひな形の数）。
   */
  const distributed = rows.filter((row) => (row.distributed_account_count ?? 0) > 0).length
  const accountNames = new Set(rows.flatMap((row) => row.distributed_account_names ?? []))
  const namesComplete = rows.every((row) => (row.distributed_account_more ?? 0) === 0)
  const outdated = stats && !kind ? stats.outdatedTemplateCount : rows.some((row) => row.outdated_account_count == null) ? null : rows.filter((row) => (row.outdated_account_count ?? 0) > 0).length
  const kpis = [
    { key: 'templates', title: 'ひな形', icon: FileText, value: ready ? rows.length : null, unit: '件', detail: ready ? `下書き ${rows.length - distributed}件` : emptyValue('unknown') },
    { key: 'accounts', title: '配ったアカウント', icon: Link, value: ready && namesComplete ? accountNames.size : null, unit: '件', detail: ready ? (namesComplete ? `全 ${formatNumber(accountTotal)} アカウントのうち` : '数え切れないアカウントがあります') : emptyValue('unknown') },
    type === 'rich_menu'
      ? { key: 'taps', title: '今月押された', icon: Send, value: ready ? sumOrNull(rows.map((row) => row.tap_count)) : null, unit: '回', detail: ready ? '配った先でボタンが押された回数' : emptyValue('unknown') }
      : type === 'tag'
      ? { key: 'friends', title: '付けている友だち', icon: Users, value: ready ? sumOrNull(rows.map((row) => row.friend_count)) : null, unit: '人', detail: ready ? '配った先の合計' : emptyValue('unknown') }
      : type === 'template'
      ? { key: 'sent', title: '今月送った数', icon: Send, value: ready ? kind ? sumOrNull(rows.map((row) => row.this_month_sent_count)) : stats?.thisMonthSentCount ?? null : null, unit: '通', detail: ready ? '配った先の合計' : emptyValue('unknown') }
      : { key: 'distributed', title: '配ったひな形', icon: Send, value: ready ? distributed : null, unit: '件', detail: ready ? '1つ以上のアカウントへ配った' : emptyValue('unknown') },
    { key: 'outdated', title: '新しい版を未配布', icon: Archive, value: ready ? outdated : null, unit: '件', detail: ready ? '直したあと配っていない' : emptyValue('unknown') },
  ]

  /*
   * タグの数の帯：未使用・付けている友だち・（今月付けた回数の代わりに）新しい版を未配布・整理の候補。
   * 今月付けた回数は統括の一覧の受け口に無いので出さない（見た目だけ置かない）。
   */
  const tagKpis = [
    { key: 'unused', title: '未使用', icon: CircleDashed, value: ready ? unusedTagCount(rows) : null, unit: '件', detail: ready ? '配った先で付いている友だちが0人' : emptyValue('unknown') },
    { key: 'friends', title: '付けている友だち', icon: Users, value: ready ? sumOrNull(rows.map((row) => row.friend_count)) : null, unit: '人', detail: ready ? '配った先の合計' : emptyValue('unknown') },
    { key: 'outdated', title: '新しい版を未配布', icon: Send, value: ready ? outdated : null, unit: '件', detail: ready ? '直したあと配っていない' : emptyValue('unknown') },
    { key: 'cleanup', title: '整理の候補', icon: Sparkles, value: ready ? cleanupTagCount(rows) : null, unit: '件', detail: ready ? '未使用・名前が重なっている' : emptyValue('unknown') },
  ]
  const bandKpis = type === 'tag' ? tagKpis : kpis

  const tabs = kind && onKindChange ? (
      <Tabs
        size="compact"
        label={`${words.title}の種類`}
        items={[...KIND_TABS.map((tab): TabItem => ({
          label: tab.label,
          count: kindCounts?.[tab.kind],
          current: kind === tab.kind,
          onClick: () => { onKindChange(tab.kind); setPage(1) },
        })), STARTER_SET_TAB]}
      />
  ) : undefined

  const createButton = (full: boolean) => (
    <PermissionGatedButton allowed={canEdit} need="tenantWide" type="button" variant="primary" className={full ? 'v8-folder-create w-full' : undefined} disabled={!ready || busy} onClick={onCreate}>
      <Plus size={16} aria-hidden="true" />{words.create}
    </PermissionGatedButton>
  )

  const leadingActions = (id: string, name: string): ActionMenuItem[] | undefined => {
    const contents = folderContents === undefined ? rows : folderContents
    const count = contents?.filter((row) => id === 'none' ? !row.folder_id : row.folder_id === id).length ?? 0
    return canEdit && ready && !busy && type !== 'scenario' && onDistributeFolder && count > 0 ? [{
      id: `${id}-distribute`, label: 'このフォルダを配る', icon: <Send size={16} aria-hidden="true" />, emphasis: true,
      onSelect: () => onDistributeFolder(id, name),
    }] : undefined
  }
  const folderRows: FolderPanelRow[] = [
    { kind: 'all' as const, id: 'all', label: 'すべて', count: ready ? rows.length : null, icon: <Inbox size={16} aria-hidden="true" /> },
    ...folders.map((folder) => ({
      kind: 'folder' as const,
      id: folder.id,
      label: folder.name,
      color: folder.color,
      count: ready ? countIn(folder.id) : null,
      leadingActions: leadingActions(folder.id, folder.name),
      ...(canEdit ? {
        onEdit: () => { setFolderError(''); setFolderNameError(''); setFolderName(folder.name); setFolderColor(folderDisplayColor(folder)); setFolderDialog({ editing: folder }) },
        onDelete: () => { deleteTicket.current = {}; setFolderError(''); setDeletingFolder(folder) },
      } : {}),
    })),
    { kind: 'unfiled' as const, id: 'none', label: '未分類', count: ready ? countIn('none') : null, leadingActions: leadingActions('none', '未分類') },
  ]
  const selectFolder = (id: string) => { onFolderFilter(id); setPage(1) }
  const folderPanel = (
    <FolderPanel
      createAction={createButton(true)}
      showHeading={!folderLoadFailed}
      activeId={folderFilter}
      onSelect={selectFolder}
      onAddFolder={!folderLoadFailed && canEdit ? () => { setFolderError(''); setFolderNameError(''); setFolderName(''); setFolderColor(FOLDER_SELECT_COLORS[0].value); setFolderDialog({ editing: null }) } : undefined}
      addFolderLabel="フォルダを追加"
      rows={folderLoadFailed ? [] : folderRows}
    >
      {folderLoadFailed ? <Notice tone="danger" className={storeStyles.folderNoteNoticePlacement}>フォルダを読み込めませんでした。ページを再読み込みしてください。</Notice> : <FolderPanelNote itemLabel={words.item}>
        {type === 'template' ? 'フォルダは種類のタブをまたいで使えます。' : undefined}
      </FolderPanelNote>}
    </FolderPanel>
  )

  const saveFolder = async () => {
    const name = folderName.trim()
    if (!name || folderBusy || !folderDialog) return
    setFolderBusy(true)
    setFolderError('')
    setFolderNameError('')
    try {
      if (folderDialog.editing) await onRenameFolder(latestFolder(folderDialog.editing), name, folderColor)
      else await onAddFolder(name, folderColor)
      setFolderDialog(null)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)
      // 理由ごとに言い分ける（共通の describeFolderFailure）。入力した名前と色は残す。
      const failure = describeFolderFailure(caught, 'save');

      if (failure.kind === 'missing') {
        notifyToast(failure.message, { tone: 'error' })
        await onReloadFolders?.().catch(() => undefined)
        setFolderDialog(null)
        return
      }
      if (failure.kind === 'conflict') await onReloadFolders?.().catch(() => undefined)
      if (failure.nameError) { if (!fieldFailure) setFolderNameError(failure.nameError) }
      else { if (!fieldFailure) setFolderError(failure.message) }
    } finally {
      setFolderBusy(false)
    }
  }
  const removeFolder = async () => {
    if (!deletingFolder || folderBusy || deleteLock.current || !renderedDeleteTicket || renderedDeleteTicket !== deleteTicket.current) return
    deleteLock.current = true
    setFolderBusy(true)
    setFolderError('')
    try {
      await onDeleteFolder(latestFolder(deletingFolder))
      if (renderedDeleteTicket !== deleteTicket.current) return
      deleteTicket.current = null
      setDeletingFolder(null)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught);

      const failure = describeFolderFailure(caught, 'delete');

      if (failure.kind === 'missing') {
        deleteTicket.current = null
        setDeletingFolder(null)
        notifyToast(failure.message, { tone: 'error' })
        await onReloadFolders?.().catch(() => undefined)
        return
      }
      if (failure.kind === 'conflict') await onReloadFolders?.().catch(() => undefined)
      { if (!fieldFailure)
      setFolderError(failure.message) }
    } finally {
      deleteLock.current = false
      setFolderBusy(false)
    }
  }

  const rowMenu = (row: HqTemplate): ActionMenuItem[] => [
    { id: 'distribute', label: '配る', icon: <Send size={16} aria-hidden="true" />, disabled: busy, onSelect: () => onDistribute(row) },
    { id: 'edit', label: '編集する', icon: <Pencil size={16} aria-hidden="true" />, onSelect: () => onEdit(row) },
    { id: 'duplicate', label: '複製する', icon: <Copy size={16} aria-hidden="true" />, onSelect: () => onDuplicate(row) },
    { id: 'remove', label: '削除する', icon: <Trash2 size={16} aria-hidden="true" />, tone: 'danger', dividerBefore: true, onSelect: () => onRemove(row) },
  ]

  /* タグの名前の札。フォルダの色は札の中の丸。 */

  const toolbar = (
    <div className={type === 'tag' ? `${storeStyles.wideTools} ${attributeStyles.tagTools}` : storeStyles.wideTools}>
      <ListToolbar
        search={{ placeholder: words.search, label: `${words.title}のひな形を検索`, value: query, onChange: (value) => { setQuery(value); setPage(1) } }}
        filters={(
          <>
          {type === 'tag' ? (
            <>
              <SaveErrorField names={["tagUsage","tag_usage"]}><Select aria-label="使用状態で絞り込む" width={145} value={tagUsage} onChange={(value) => { setTagUsage(value as TagUsageFilter); setPage(1) }} options={[
                { value: 'all', label: '使用状態：すべて' },
                { value: 'used', label: '使用状態：付いている' },
                { value: 'unused', label: '使用状態：未使用' },
              ]} /></SaveErrorField>
              <SaveErrorField names={["tagMethod","tag_method"]}><Select aria-label="付け方で絞り込む" width={132} value={tagMethod} onChange={(value) => { setTagMethod(value); setPage(1) }} options={[
                { value: 'all', label: '付け方：すべて' },
                ...assignmentMethods(rows).map((method) => ({ value: method, label: `付け方：${method}` })),
              ]} /></SaveErrorField>
            </>
          ) : null}
          <div role="group" aria-label="配ったかで絞り込む" className={storeStyles.chipGroup}>
            {type === 'template' ? (
              <>
                <SegmentedControl aria-label="メッセージの数" fit="content" value={tplCount ?? 'all'} onClear={() => { setTplCount(null); setPage(1) }} onChange={(value) => { setTplCount(value === 'all' ? null : value); setPage(1) }} options={[
                  { value: 'all', label: 'すべて' }, { value: 'single', label: '1通のみ', title: '1通だけのテンプレート' }, { value: 'multiple', label: '複数通', title: '複数通に分かれるテンプレート' },
                ]} />
                <FilterChip selected={tplVars} onChange={() => { setTplVars((value) => !value); setPage(1) }} title="名前や情報を差し込むテンプレート" icon={<Braces size={16} aria-hidden="true" />}>
                  差し込みあり
                </FilterChip>
              </>
            ) : null}
            <FilterChip selected={undistributedOnly} onChange={() => { setUndistributedOnly((value) => !value); setPage(1) }} title="まだどのアカウントへも配っていないひな形" icon={<Unlink size={16} aria-hidden="true" />}>
              未配布
            </FilterChip>
          </div>
          </>
        )}
        trailing={(
          <>
          {type === 'tag' ? (
            <span className={hqStyles.menuAnchor}>
              <Button
                type="button"
                variant="secondary"
                aria-haspopup="menu"
                aria-expanded={tagQuickOpen}
                aria-label={tagQuick.length ? `よく使う絞り込み（${formatNumber(tagQuick.length)}件で絞り込み中）` : 'よく使う絞り込み'}
                title="よく使う絞り込み"
                filterActive={tagQuick.length > 0}
                onClick={() => setTagQuickOpen((open) => !open)}
              >
                <Bookmark size={16} aria-hidden="true" />
                {narrow ? null : <span>よく使う絞り込み</span>}
              </Button>
              <ActionMenu open={tagQuickOpen} onClose={() => setTagQuickOpen(false)} ariaLabel="よく使う絞り込み" items={[
                ...TAG_QUICK_FILTERS.map(([value, label]) => ({
                  id: `quick-${value}`,
                  label,
                  icon: tagQuick.includes(value) ? <Check size={16} aria-hidden="true" /> : <span className={hqStyles.checkSpace} aria-hidden="true" />,
                  onSelect: () => { setTagQuick((current) => current.includes(value) ? current.filter((key) => key !== value) : [...current, value]); setPage(1) },
                })),
                ...(tagQuick.length ? [{ id: 'quick-clear', label: 'すべて外す', dividerBefore: true, onSelect: () => { setTagQuick([]); setPage(1) } }] : []),
              ]} />
            </span>
          ) : null}
          {type === 'template' ? (
            <span className={hqStyles.menuAnchor}>
              <Button
                type="button"
                variant="secondary"
                aria-haspopup="menu"
                aria-expanded={tagQuickOpen}
                aria-label="よく使う絞り込み"
                title="よく使う絞り込み"
                onClick={() => setTagQuickOpen((open) => !open)}
              >
                <Bookmark size={16} aria-hidden="true" />
                {narrow ? null : <span>絞り込み</span>}
              </Button>
              <ActionMenu open={tagQuickOpen} onClose={() => setTagQuickOpen(false)} ariaLabel="よく使う絞り込み" items={[
                { id: 'quick-undistributed', label: 'まだ配っていない', icon: undistributedOnly ? <Check size={16} aria-hidden="true" /> : <span className={hqStyles.checkSpace} aria-hidden="true" />, onSelect: () => { setUndistributedOnly((value) => !value); setPage(1) } },
                { id: 'quick-vars', label: '差し込みがある', icon: tplVars ? <Check size={16} aria-hidden="true" /> : <span className={hqStyles.checkSpace} aria-hidden="true" />, onSelect: () => { setTplVars((value) => !value); setPage(1) } },
                { id: 'quick-multiple', label: '複数通に分かれている', icon: tplCount === 'multiple' ? <Check size={16} aria-hidden="true" /> : <span className={hqStyles.checkSpace} aria-hidden="true" />, onSelect: () => { setTplCount((value) => (value === 'multiple' ? null : 'multiple')); setPage(1) } },
                ...(undistributedOnly || tplVars || tplCount ? [{ id: 'quick-clear', label: 'すべて外す', dividerBefore: true, onSelect: () => { setUndistributedOnly(false); setTplVars(false); setTplCount(null); setPage(1) } }] : []),
              ]} />
            </span>
          ) : null}
          <div className={storeStyles.perPageBox}>
            <SaveErrorField names={["pageSize","page_size"]}><Select aria-label="1ページに出す件数" size="page-size" value={String(pageSize)} onChange={(value) => { setPageSize(Number(value)); setPage(1) }} options={PAGE_SIZE_OPTIONS} /></SaveErrorField>
          </div>
          </>
        )}
      />
    </div>
  )

  /*
   * 種類ごとの列（店の同じ機能の一覧と同じ並び）。違いは「配布先」の列だけ。
   *   テンプレート ：種類・公開・配布先・今月送った数・更新・「…」
   *   タグ ：人数・付け方・配布先・「…」（人数は API-18 の配った先で付いている友だちの合計）
   *   リッチメニュー ：順・誰に出すか・状態・配布先・今月押された・「…」（API-18 の順・誰に出すか・配った先の押された数）
   *   回答フォーム ：状態・配布先・更新・「…」
   * ［配る］は「…」の中。閲覧のみ（配れない人）には「…」ごと出さない。
   */
  const rankOf = new Map(type === 'rich_menu'
    ? [...rows].sort((a, b) => (a.display_order ?? Number.MAX_SAFE_INTEGER) - (b.display_order ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name, 'ja')).map((row, index) => [row.id, index + 1] as const)
    : [])
  const ordered = type === 'rich_menu' ? [...shown].sort((a, b) => (rankOf.get(a.id) ?? 0) - (rankOf.get(b.id) ?? 0)) : shown
  const destCell = (row: HqTemplate) => {
    const destLine = distributedAccountsLine(row)
    return row.distributed_account_count === undefined ? (
      <EmptyCell />
    ) : row.distributed_account_count > 0 ? (
      <span className={storeStyles.hqDest}>
        <span className={storeStyles.usageLink}>{`${formatNumber(row.distributed_account_count)} アカウント`}</span>
        {destLine ? <span className={storeStyles.cellSub} title={destLine}>{destLine}</span> : null}
      </span>
    ) : (
      <span className={storeStyles.usageLink}>まだ配っていない</span>
    )
  }
  const stateCell = (row: HqTemplate) => {
    const state = stateOf(row)
    return (
      <StatusBadge tone={state.tone === 'live' ? 'success' : state.tone === 'changes' ? 'warning' : 'neutral'}>
        {state.label}
      </StatusBadge>
    )
  }
  /* 列の幅（col）と中身の箱（Td）は列ごとに書く（className を変数で渡すと見張りが読めない）。 */
  type Column = { key: string; head: string; col: ReactNode; cell: (row: HqTemplate) => ReactNode }
  const plainTd = (key: string, text: ReactNode, title?: string) => <Td key={key} presentation="template-plain" title={title}>{text}</Td>
  const boxedTd = (key: string, inner: ReactNode) => <Td key={key}>{inner}</Td>
  const columns: Column[] = type === 'template' ? [
    { key: 'kind', head: '種類', col: <col key="kind" className={storeStyles.colKind} />, cell: (row) => {
      const label = !row.kind || row.kind === 'message' ? hqMessageTypeLabel(row) : knownValue(KIND_LABEL, row.kind, emptyValue('unknown'))
      return boxedTd('kind', label === emptyValue('unknown') ? label : <TagPill name={label} />)
    } },
    { key: 'state', head: '配布状況', col: <col key="state" className={storeStyles.colPublish} />, cell: (row) => boxedTd('state', stateCell(row)) },
    { key: 'dest', head: '配布先', col: <col key="dest" className={storeStyles.colUsage} />, cell: (row) => boxedTd('dest', destCell(row)) },
    { key: 'sent', head: '今月送った数', col: <col key="sent" className={storeStyles.colMonthly} />, cell: (row) => plainTd('sent', sentLabel(row.this_month_sent_count), row.this_month_sent_count == null ? '今月送った数は、この種類では数えていません' : undefined) },
    ...(!narrow ? [{ key: 'updated', head: '更新', col: <col key="updated" className={storeStyles.colUpdated} />, cell: (row: HqTemplate) => plainTd('updated', <ListDateTime value={row.updated_at} />, row.updated_at) },] : []),
  ] : type === 'tag' ? [
    { key: 'friends', head: '人数', col: <col key="friends" className={storeStyles.colKind} />, cell: (row) => plainTd('friends', row.friend_count == null ? emptyValue('unknown') : `${formatNumber(row.friend_count)}人`, '配った先のアカウントで、このタグが付いている友だちの合計') },
    { key: 'method', head: '付け方', col: <col key="method" className={storeStyles.colKind} />, cell: (row) => plainTd('method', row.assignment_method ?? emptyValue('unknown')) },
    { key: 'dest', head: '配布先', col: <col key="dest" className={storeStyles.colHqDest} />, cell: (row) => boxedTd('dest', destCell(row)) },
  ] : type === 'rich_menu' ? [
    { key: 'audience', head: '誰に出すか', col: <col key="audience" className={storeStyles.colPublish} />, cell: (row) => plainTd('audience', <TruncatedText value={row.display_audience ?? emptyValue('unknown')} />, row.display_audience ?? undefined) },
    { key: 'state', head: '配布状況', col: <col key="state" className={storeStyles.colPublish} />, cell: (row) => boxedTd('state', stateCell(row)) },
    { key: 'dest', head: '配布先', col: <col key="dest" className={storeStyles.colUsage} />, cell: (row) => boxedTd('dest', destCell(row)) },
    { key: 'taps', head: '今月押された', col: <col key="taps" className={storeStyles.colMonthly} />, cell: (row) => plainTd('taps', row.tap_count == null ? emptyValue('unknown') : `${formatNumber(row.tap_count)}回`, '配った先のアカウントで押された回数の合計') },
  ] : type === 'form' ? [
    { key: 'storage', head: '保存先', col: <col key="storage" className={hqStyles.colFormStorage} />, cell: () => plainTd('storage', '—', '保存先の情報は未取得です') },
    { key: 'state', head: '配布状況', col: <col key="state" className={hqStyles.colFormState} />, cell: (row) => boxedTd('state', stateCell(row)) },
    { key: 'dest', head: '配布先', col: <col key="dest" className={hqStyles.colFormDest} />, cell: (row) => boxedTd('dest', destCell(row)) },
  ] : [
    { key: 'state', head: '配布状況', col: <col key="state" className={storeStyles.colPublish} />, cell: (row) => boxedTd('state', stateCell(row)) },
    { key: 'dest', head: '配布先', col: <col key="dest" className={storeStyles.colHqDest} />, cell: (row) => boxedTd('dest', destCell(row)) },
    { key: 'updated', head: '更新', col: <col key="updated" className={storeStyles.colUpdated} />, cell: (row) => plainTd('updated', <ListDateTime value={row.updated_at} />, row.updated_at) },
  ]
  const body = !ready ? (
    <div className={storeStyles.stateCard} role="status">
      <p className={storeStyles.stateTitle}>{busy ? 'ひな形を読み込み中…' : '読み込めませんでした。権限や接続を確認し、ページを再読み込みしてください。'}</p>
    </div>
  ) : filtered.length === 0 ? (
    <EmptyList
      icon={<FileText aria-hidden="true" />}
      title={`まだ${words.item}のひな形がありません`}
      description="ひな形を作ると、ここから各 LINE アカウントへ配れます。"
      create={{ label: `最初の${words.item}を作る`, onClick: onCreate }}
      canCreate={canEdit}
      filtered={Boolean(query || undistributedOnly || folderFilter !== 'all' || tagUsage !== 'all' || tagMethod !== 'all')}
      onClearFilters={() => { setQuery(''); setUndistributedOnly(false); setTagUsage('all'); setTagMethod('all'); onFolderFilter('all'); setPage(1) }}
      filteredDescription="検索や「未配布」・フォルダを外すと、すべて出ます"
    />
  ) : (
    <div className={`${storeStyles.tableWrap} ${storeStyles.hqTable}`}>
      <DataTable columnSizing="content">
        <colgroup>
          {type === 'rich_menu' || type === 'template' ? <col className={storeStyles.colSelect} /> : null}
          <col />
          {columns.map((column) => column.col)}
          <col className={storeStyles.colMenu} />
        </colgroup>
        <thead>
          <TableHeadRow>
            {type === 'rich_menu' ? <Th className={storeStyles.headCell}>順</Th> : null}
            {type === 'template' ? <Th className={storeStyles.headCell}><Checkbox aria-label="表示中のテンプレートをすべて選ぶ" checked={shown.length > 0 && shown.every((row) => selectedIds.includes(row.id))} onCheckedChange={(checked) => setSelectedIds((current) => checked ? [...new Set([...current, ...shown.map((row) => row.id)])] : current.filter((id) => !shown.some((row) => row.id === id)))} /></Th> : null}
            <Th className={storeStyles.headCell}>{ordered.length > 0 && ordered.every(row => row.content_summary) ? words.column : words.column.replace(/（[^）]+）/, '')}</Th>
            {columns.map((column) => <Th key={column.key} className={storeStyles.headCell}>{column.head}</Th>)}
            <Th aria-label="操作" />
          </TableHeadRow>
        </thead>
        <tbody>
          {ordered.map((row) => {
            const folder = folderOf(row.folder_id)
            const sub = templateSubLine(row, knownValue(KIND_LABEL, (row.kind ?? 'message') as TemplateKind, words.item))
            return (
              <Tr selected={selectedIds.includes(row.id)} key={row.id} data-row-id={row.id} density="template" onOpen={() => (onOpen ?? onEdit)(row)}>
                {type === 'rich_menu' ? <Td presentation="template-plain">{rankOf.get(row.id) ?? emptyValue('unknown')}</Td> : null}
                {type === 'template' ? <Td presentation="template-plain"><Checkbox aria-label={`「${row.name}」を選ぶ`} checked={selectedIds.includes(row.id)} onCheckedChange={(checked) => setSelectedIds((current) => checked ? [...current, row.id] : current.filter((id) => id !== row.id))} /></Td> : null}
                {type === 'tag' ? (
                  /* タグは名前をタグの札で出す。フォルダの色は札の中の丸（名前の前の丸を二重に置かない）。 */
                  <NameCell name={(
                    <div className={storeStyles.dotLine}>
                      {itemHref ? <RowNameLink onOpen={() => (onOpen ?? onEdit)(row)} href={itemHref(row)} className={hqStyles.hqTagLink} aria-label={row.name} title={row.name}><TagPill name={row.name} color={folder ? folderDisplayColor(folder) : null} folderName={folder?.name ?? '未分類'} /></RowNameLink> : canEdit ? (
                        <button type="button" className={`${hqStyles.hqNameButton} ${hqStyles.hqTagLink}`} aria-label={row.name} title={row.name} onClick={() => (onOpen ?? onEdit)(row)}><TagPill name={row.name} color={folder ? folderDisplayColor(folder) : null} folderName={folder?.name ?? '未分類'} /></button>
                      ) : <span title={row.name}><TagPill name={row.name} color={folder ? folderDisplayColor(folder) : null} folderName={folder?.name ?? '未分類'} /></span>}
                    </div>
                  )} nameCarriesDot />
                ) : <NameCell name={(
                    <div className={storeStyles.dotLine}>
                      {itemHref ? <RowNameLink onOpen={() => (onOpen ?? onEdit)(row)} href={itemHref(row)} className={`${storeStyles.cellTitle} ${hqStyles.hqNameButton}`} title={row.name}>{row.name}</RowNameLink> : canEdit ? (
                        <button type="button" className={`${storeStyles.cellTitle} ${hqStyles.hqNameButton}`} title={row.name} onClick={() => (onOpen ?? onEdit)(row)}>{row.name}</button>
                      ) : <span className={storeStyles.cellTitle} title={row.name}>{row.name}</span>}
                    </div>
                  )} description={sub} folder={folder ? { name: folder.name, color: folder.color } : null}
                />}
                {columns.map((column) => column.cell(row))}
                <Td className={storeStyles.menuCell}>
                  <div className={`${storeStyles.menuBox} ${storeStyles.hqActions}`}>
                    {canEdit ? (
                      <RowMenu label={`${words.item}「${row.name}」の操作`} items={rowMenu(row)} size="row" open={openMenuId === row.id} onOpenChange={(next) => setOpenMenuId(next ? row.id : null)} />
                    ) : null}
                  </div>
                </Td>
              </Tr>
            )
          })}
        </tbody>
      </DataTable>
    </div>
  )

  const pager = !ready || filtered.length === 0 ? null : (
    <Pagination page={current} pageCount={pageCount} onPageChange={setPage} range={{ total: filtered.length, first: (current - 1) * pageSize + 1, last: Math.min(current * pageSize, filtered.length) }} />
  )

  if (type === 'tag' && attribute.tab !== 'tags') {
    return <SaveErrorScope errors={saveErrors}><OtherTabPanel tab={attribute.tab} title={words.title} description={words.description} onSelect={(key) => { attribute.select(key); setPage(1) }} /></SaveErrorScope>
  }

  return (
    <SaveErrorScope errors={saveErrors}><ListPage
      skeleton
      boardId={type === 'template' ? 'i0Ao0R' : type === 'form' ? 'wZPua' : type === 'tag' ? 'DzdC3' : type === 'rich_menu' ? 'noVq4' : 'LRc93'}
      headingSize="regular"
      title={words.title}
      help={words.description}
      tabs={type === 'tag' ? <AttributeTabs tab={attribute.tab} onSelect={(key) => { attribute.select(key); setPage(1) }} /> : tabs}
      stats={(
        <KpiBand data-design="KPIs">
          {bandKpis.map((kpi) => (
            <KpiCard key={kpi.key} presentation="band" title={kpi.title} icon={<kpi.icon size={16} aria-hidden="true" />} value={kpi.value} unit={kpi.value == null ? '' : kpi.unit} detail={kpi.detail} help={type === 'rich_menu' && kpi.key === 'accounts' ? '配布は各アカウントに下書きを届けることです。LINEへの公開は各アカウントで行います。' : undefined} />
          ))}
        </KpiBand>
      )}
      folderNav={{ rows: folderRows, activeId: folderFilter, onSelect: selectFolder, createAction: createButton(false) ?? undefined }}
      folders={folderPanel}
      toolbar={toolbar}
      pagination={pager}
      overlays={(
        <>
          {overlays}
          <OverlayDepthContext.Provider value={depth + 2}><UnsavedLeaveDialog open={folderGuard.leaveTarget !== null} busy={folderBusy} onConfirm={folderGuard.confirmLeave} onCancel={folderGuard.cancelLeave} /></OverlayDepthContext.Provider>
          <FolderEditorDialog
            name={folderName} onNameChange={(next) => { setFolderName(next); setFolderNameError('') }} color={folderColor} onColorChange={setFolderColor}
            nameError={folderNameError || undefined}
            open={folderDialog !== null}
            title={folderDialog?.editing ? 'フォルダを直す' : 'フォルダを追加'}
            description={`${words.item}のひな形を分けてしまう箱です。消しても、中のひな形は未分類に残ります。`}
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
            description={deleteFolderDescription(`${words.item}のひな形`, deletingFolder ? countIn(deletingFolder.id) : null)}
            confirmLabel="フォルダを消す"
            cancelLabel="キャンセル"
            destructive
            busy={folderBusy}
            error={folderError || undefined}
            onCancel={() => { if (!folderBusy && !deleteLock.current) { deleteTicket.current = null; setDeletingFolder(null) } }}
            onConfirm={() => removeFolder()}
          ><OperationTargetSummary accounts={[]} externalTarget={{ label: '統括のフォルダ', name: deletingFolder?.name }} /></ConfirmDialog>
        </>
      )}
    >
      {notices}
      {body}
    </ListPage></SaveErrorScope>
  )
}
