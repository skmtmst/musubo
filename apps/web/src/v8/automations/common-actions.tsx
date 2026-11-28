'use client'

import PermissionGatedButton from '@/components/shared/permission-gated-button'
import SegmentedControl from '@/components/shared/segmented'
import { describeApiFailure } from '@/components/shared/api-error-message'
import StatusBadge from '@/components/shared/status-badge'

import { useListUrlValue } from '@/components/shared/list-url-state'
import { useFolderMove } from '@/components/shared/use-folder-move'
import { moveCommonActionToFolder } from '@/lib/move-to-folder'
import { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import {
  Activity,
  Bookmark,
  Download,
  Link2,
  ListChecks,
  Plus,
  TriangleAlert,
} from 'lucide-react'
import type { Folder } from '@line-crm/shared'
import { api, type CommonActionSummary } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { formatNumber } from '@/lib/format'
import { ListPage, ListPagePagination } from '@/components/templates'
import ListToolbar from '@/components/shared/list-toolbar'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import Select from '@/components/shared/select'
import PageSizeSelect from '@/components/shared/page-size-select'
import { type FolderPanelRow } from '@/components/shared/folder-panel'
import ManagedFolderPanel from '@/components/shared/managed-folder-panel'
import { FolderDotName } from '@/components/shared/folder-dot'
import { ActionCell, DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table'
import { type ActionMenuItem } from '@/components/shared/action-menu'
import { RowMenu } from '@/components/shared/row-actions'
import Dialog from '@/components/shared/dialog'
import ListState from '@/components/shared/list-state'
import Pagination from '@/components/shared/pagination'
import {
  AUTOMATIONS_DESCRIPTION,
  AUTOMATION_TABLE_LAYOUT,
  AutomationBand,
  AutomationTabs,
  READONLY_REASON,
  ViewerBand,
  useAutomationManage,
  useAutomationRunManage,
  useAutomationTabCounts,
  type BandCell,
} from './shell'
import styles from './common-actions.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField } from '@/components/shared/save-form-errors'

/*
 * ★V8 オートメーションの共通アクション（Pencil ）。
 *
 * 2026-10-06 オーナー決定で src/v8 に一から書いた。データの口・動きは今までの V8
 * （共通アクションの既存API）と同じ（一覧・検索・状態の絞り込み・複製・保管・CSV）。
 * 違いは見せ方だけ——型（ListPage）に、タブ・数の帯・左のフォルダの列（上に「共通アクションを作る」）・
 * 案内の帯・道具の段・表（列の並び）を渡す。行の右端は「中身を見る」と「…」。
 */

type Filter = 'all' | 'published' | 'draft' | 'old_version' | 'unused' | 'archived'
type Summary = {
  total: number; published: number; draft: number; oldVersion: number; unused: number; archived: number
  actions: number; bindings: number; outdated: number; outdatedItems: number; executions: number; failures: number
}

const STATUS_LABEL: Record<CommonActionSummary['status'], string> = {
  published: '公開中',
  draft: '下書き',
  archived: '保管',
}
const UNFILED = '__unfiled__'

/** 「中身を見る」と「使われている場所」の行き先（版と使われている場所の画面）。 */
export function versionsHref(id: string): string {
  return `/common-actions/versions?id=${encodeURIComponent(id)}`
}

function TableHead({ selection }: { selection?: ReactNode } = {}) {
  return (
    <thead>
      <TableHeadRow data-table-layout="columns">
        <Th grow>{selection}アクション名</Th>
        <Th className={styles.colState}>状態</Th>
        <Th collapseAt="narrow" className={styles.colSteps}>中の処理</Th>
        <Th className={styles.colUsed} align="right">呼び出し元</Th>
        <Th className={styles.colVersion}>版</Th>
        <Th className={styles.colOps}>操作</Th>
      </TableHeadRow>
    </thead>
  )
}

export default function CommonActionsV8() {
  usePageTitle('オートメーション')
  usePageCrumbs([{ label: 'ホーム', href: '/' }])
  const router = useRouter()
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const canManage = useAutomationManage()
  const canEdit = canManage === true
  const viewerOnly = canManage === false
  const runPermissions = useAutomationRunManage()
  const canExportCsv = runPermissions?.canExport === true

  const [items, setItems] = useState<CommonActionSummary[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const tabCounts = useAutomationTabCounts(undefined, summary?.total ?? null)
  const [filter, setFilter] = useListUrlValue<Filter>('filter', 'all')
  const [query, setQuery] = useListUrlValue('q', '')
  const deferredQuery = useDeferredValue(query)
  const [page, setPage] = useListUrlValue('page', 1)
  const [pageSize, setPageSize] = useListUrlValue('pageSize', 20)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [folders, setFolders] = useState<Folder[]>([])
  const [foldersError,setFoldersError]=useState(false)
  const [unfiledCount, setUnfiledCount] = useState<number | null>(null)
  const [folderFilter, setFolderFilter] = useListUrlValue('folderFilter', '')
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null)
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [archiving, setArchiving] = useState<{ item: CommonActionSummary; mode: 'archive' | 'unarchive' } | null>(null)
  const [archivingBusy, setArchivingBusy] = useState(false)
  const [archiveError, setArchiveError] = useState('')
  const [actionError, setActionError] = useState('')
  const requestSeq = useRef(0)

  const load = useCallback(async () => {
    const my = ++requestSeq.current
    if (!selectedAccountId) {
      setItems([]); setSummary(null); setTotal(0); setLoading(false)
      return
    }
    setLoading(true)
    setActionError('')
    setLoadFailed(false)
    try {
      const response = await api.commonActions.list({
        accountId: selectedAccountId,
        status: filter,
        folderId: folderFilter || undefined,
        query: deferredQuery,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      })
      if (requestSeq.current !== my) return
      if (response.success) {
        setItems(response.data)
        setTotal(response.pagination?.total ?? response.data.length)
        if (response.summary) setSummary(response.summary)
      } else {
        setLoadFailed(true)
      }
    } catch {
      if (requestSeq.current !== my) return
      setLoadFailed(true)
    } finally {
      if (requestSeq.current === my) setLoading(false)
    }
  }, [deferredQuery, filter, folderFilter, page, pageSize, selectedAccountId])

  /* フォルダの箱と件数（kind=common_action）。 */
  const loadFolders = useCallback(async () => {
    if (!selectedAccountId) { setFolders([]); return }
    setFoldersError(false)
    try {
      const res = await api.folders.list('common_action', selectedAccountId)
      if(!res.success)throw new Error(res.error)
      setFolders(res.data)
      setUnfiledCount(res.success ? res.unfiledCount ?? null : null)
    } catch {
      setFoldersError(true)
    }
  }, [selectedAccountId])

  useEffect(() => { if (!accountLoading) void load() }, [accountLoading, load])
  useEffect(() => { void loadFolders() }, [loadFolders])
  useEffect(() => { setPage(1) }, [filter, folderFilter, deferredQuery, pageSize, selectedAccountId])

  const folderMove = useFolderMove({
    accountId: selectedAccountId, canEdit: canEdit, items: items, folders,
    move: (item, folderId) => moveCommonActionToFolder(item.id, selectedAccountId!, folderId),
    onChanged: async () => { await load(); await loadFolders() },
  })

  const duplicate = async (item: CommonActionSummary) => {
    if (!selectedAccountId || duplicatingId) return
    setDuplicatingId(item.id)
    setActionError('')
    try {
      const response = await api.commonActions.duplicate(item.id, selectedAccountId)
      if (!response.success) throw new Error(response.error)
      router.push(`/common-actions/edit?id=${encodeURIComponent(response.data.id)}`)
    } catch (caught) {
      setActionError(describeApiFailure(caught, '複製'))
      setDuplicatingId(null)
    }
  }

  /* 保管：使われている所があるときは保管できない（サーバも断る）。窓で理由を出して閉じるだけ。 */
  const confirmArchive = async () => {
    if (!archiving || !selectedAccountId || archivingBusy) return
    if (archiving.mode === 'archive' && archiving.item.bindingCount > 0) {
      setArchiving(null)
      return
    }
    setArchivingBusy(true)
    setArchiveError('')
    try {
      const response = archiving.mode === 'archive'
        ? await api.commonActions.archive(archiving.item.id, selectedAccountId)
        : await api.commonActions.unarchive(archiving.item.id, selectedAccountId)
      if (!response.success) throw new Error(response.error)
      setArchiving(null)
      await load()
    } catch (caught) {
      setArchiveError(describeApiFailure(caught, '保存'))
    } finally {
      setArchivingBusy(false)
    }
  }

  /* 行の「…」：使われている場所・公開する（下書き）・複製・保管／保管を戻す（閲覧のみは使われている場所だけ）。 */
  const rowMenuItems = (item: CommonActionSummary): ActionMenuItem[] => {
    const usage: ActionMenuItem = { id: 'usage', label: '版と使われている場所を見る', onSelect: () => router.push(versionsHref(item.id)) }
    if (!canEdit) return [usage]
    return [
      { id: 'move', label: 'フォルダへ移す', onSelect: () => folderMove.open(item) },
      usage,
      ...(item.status !== 'archived'
        ? [{ id: 'edit', label: item.status === 'draft' ? '下書きを編集・公開する' : '下書きの中身を編集する', onSelect: () => router.push(`/common-actions/edit?id=${encodeURIComponent(item.id)}`) }]
        : []),
      { id: 'duplicate', label: duplicatingId === item.id ? '複製中' : '複製して下書きを作る', disabled: duplicatingId !== null, onSelect: () => void duplicate(item) },
      item.status === 'archived'
        ? { id: 'unarchive', label: '保管を戻す', onSelect: () => { setArchiveError(''); setArchiving({ item, mode: 'unarchive' }) } }
        : { id: 'archive', label: '保管する', tone: 'danger', dividerBefore: true, onSelect: () => { setArchiveError(''); setArchiving({ item, mode: 'archive' }) } },
    ]
  }

  /* ===== 数の帯 ===== */
  const ready = summary !== null && !loadFailed
  const cells: BandCell[] = [
    { key: 'total', title: '共通アクション', icon: <ListChecks size={16} aria-hidden="true" />, value: ready ? summary.total : null, unit: '件', detail: ready ? `公開中 ${summary.published}・下書き ${summary.draft}` : emptyValue('unknown') },
    { key: 'bindings', title: '使われている所', icon: <Link2 size={16} aria-hidden="true" />, value: ready ? summary.bindings : null, unit: 'か所', detail: ready && summary.outdated > 0 ? `古い版のまま ${summary.outdated}か所` : 'ルール・シナリオなど5機能から' },
    { key: 'executions', title: '今月動いた', icon: <Activity size={16} aria-hidden="true" />, value: ready ? summary.executions : null, unit: '回', detail: '今月（日本時間）の実行回数' },
    { key: 'failures', title: '失敗', icon: <TriangleAlert size={16} aria-hidden="true" />, value: ready ? summary.failures : null, unit: '件', detail: '「動いた記録」からやり直せます' },
  ]

  /* ===== フォルダ ===== */
  const folderRows: FolderPanelRow[] = [
    { kind: 'all' as const, id: '', label: 'すべて', count: ready ? summary.total : null },
    ...folders.map((folder) => ({ kind: 'folder' as const, id: folder.id, label: folder.name, count: folder.itemCount ?? null, color: folder.color })),
    { kind: 'unfiled' as const, id: UNFILED, label: '未分類', count: unfiledCount },
  ]
  const createButton = <PermissionGatedButton allowed={canEdit} variant="primary" href="/common-actions/new" className="v8-folder-create w-full"><Plus size={16} aria-hidden="true" />共通アクションを作る</PermissionGatedButton>

  /* ===== 道具の段 ===== */
  const filterChips = (
    <SegmentedControl<Filter> aria-label="状態で絞り込む" fit="content" value={filter} onClear={() => setFilter('all')} onChange={setFilter} options={[
      { value: 'all', label: 'すべて' },
      { value: 'published', label: '公開中', count: ready ? summary?.published : undefined },
      { value: 'draft', label: '下書き', count: ready ? summary?.draft : undefined },
      { value: 'old_version', label: '古い版あり', count: ready ? summary?.oldVersion : undefined },
      { value: 'unused', label: '呼ばれていない', count: ready ? summary?.unused : undefined },
      { value: 'archived', label: '保管したもの', count: ready ? summary?.archived : undefined },
    ]} />
  )
  const savedBox = (
      <SaveErrorField names={["filter","status"]}><Select size="content" icon={<Bookmark size={16} aria-hidden="true" />} showChevron={false}
        aria-label="よく使う絞り込み"
        value={filter === 'old_version' || filter === 'unused' ? filter : ''}
        onChange={(value) => setFilter((value || 'all') as Filter)}
        options={[
          { value: '', label: 'よく使う絞り込み' },
          { value: 'old_version', label: '古い版のまま使われている' },
          { value: 'unused', label: 'どこからも呼ばれていない' },
        ]}
      /></SaveErrorField>
  )
  const toolbar = (
    <>

      {actionError ? <div className={styles.noticeRow}><Notice tone="danger">{actionError}</Notice></div> : null}
      <ListToolbar
        search={{ placeholder: '共通アクションを探す', label: '共通アクションを検索', width: 240, value: query, onChange: setQuery }}
        filters={filterChips}
        trailing={<>{savedBox}<PageSizeSelect value={pageSize} onChange={setPageSize} options={[10, 20, 50]} label={null} /></>}
      />
    </>
  )

  /* ===== 表 ===== */
  let listBody: ReactNode
  if (accountLoading || loading) {
    listBody = <ListState kind="loading" title="共通アクションを読み込んでいます" />
  } else if (!selectedAccountId) {
    listBody = <ListState kind="empty" title="LINE公式アカウントを選んでください" />
  } else if (loadFailed) {
    listBody = (
      <ListState
        kind="error"
        title="共通アクションを読み込めませんでした"
        description="登録した内容は消えていません。通信を確かめて、もう一度お試しください。"
        onRetry={() => void load()}
      />
    )
  } else if (items.length === 0) {
    listBody = query || filter !== 'all' || folderFilter
      ? <ListState kind="empty" title="条件に合う共通アクションはありません" description="検索や絞り込みを外すと、すべて出ます。" action={<Button variant="secondary" onClick={() => { setQuery(''); setFilter('all'); setFolderFilter('') }}>条件を外す</Button>} />
      : <ListState kind="empty" title="まだ、共通アクションはありません" description="よく使う処理をまとめると、設定の重複を減らせます。" action={<PermissionGatedButton allowed={canEdit} variant="primary" href="/common-actions/new"><Plus size={16} aria-hidden="true" />共通アクションを作る</PermissionGatedButton>} />
  } else {
    listBody = (
      <>
        <div className={styles.tableWrap}>
          <DataTable columnLayout={AUTOMATION_TABLE_LAYOUT}>
            <TableHead selection={folderMove.pageCheckbox} />
            <tbody>
              {items.map((item) => {
                const menuLabel = `共通アクション「${item.name}」の操作`
                const versionSub = item.oldVersionBindingCount > 0
                  ? `古い版 ${item.oldVersionBindingCount}`
                  : item.status === 'published' && item.draftVersion != null ? '下書きあり' : null
                return (
                  <Tr selected={folderMove.isSelected(item.id)} key={item.id} data-table-layout="columns" data-row-id={item.id} href={versionsHref(item.id)}>
                    <Td grow>
                      {/* 名前の前に分類先の色の丸。説明は名前の頭にそろえる。 */}
                      <FolderDotName folder={folders.find((folder) => folder.id === item.folderId) ?? null}>{folderMove.checkbox(item)}
                        <a className={styles.name} href={versionsHref(item.id)}  onClick={(event) => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0) { event.preventDefault(); router.push(versionsHref(item.id)) } }}><TruncatedText value={String(item.name ?? '')} /></a>
                      </FolderDotName>

                    </Td>
                    <Td className={styles.colState}>
                      <StatusBadge tone={item.status === 'published' ? 'success' : 'neutral'}>
                        {STATUS_LABEL[item.status]}
                      </StatusBadge>
                    </Td>
                    <Td collapseAt="narrow" className={styles.colSteps}><span className={styles.main}>{`${formatNumber(item.actionCount)} 個の処理`}</span></Td>
                    <Td className={styles.colUsed}><span className={styles.main}>{`${formatNumber(item.bindingCount)} か所`}</span></Td>
                    <Td className={styles.colVersion}>
                      <span className={styles.main}>{item.publishedVersion ? `第${item.publishedVersion}版` : emptyValue('unknown')}</span>
                      {versionSub ? <span className={item.oldVersionBindingCount > 0 ? styles.subWarn : styles.sub}>{versionSub}</span> : null}
                    </Td>
                    <ActionCell className={styles.colOps}>
                      <div className={styles.opsBox}>
                        <Button size="compact" href={versionsHref(item.id)}>中身を見る</Button>
                        <RowMenu
                          label={menuLabel}
                          open={openMenuId === item.id}
                          onOpenChange={(next) => setOpenMenuId(next ? item.id : null)}
                          note={canEdit ? undefined : READONLY_REASON}
                          items={rowMenuItems(item).map((menuItem) => ({ ...menuItem, onSelect: () => { setOpenMenuId(null); menuItem.onSelect?.() } }))}
                        />
                      </div>
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

  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const pager = !loading && !loadFailed && items.length > 0 ? (
    <ListPagePagination>
      <Pagination page={page} pageCount={pageCount} onPageChange={setPage} ariaLabel="共通アクション一覧のページ送り" range={{ total: total, first: (page - 1) * pageSize + 1, last: Math.min(page * pageSize, total) }} />
    </ListPagePagination>
  ) : null

  const csvEmpty = !loading && !loadFailed && total === 0
  const csvScoped = filter !== 'all' || deferredQuery.trim() !== ''

  return (
    <ListPage
      help={<>{AUTOMATIONS_DESCRIPTION}{canEdit
            ? '行の「…」から 版と使われている場所を見る・下書きの中身を編集・複製・保管。'
            : '行の「…」から 版と使われている場所を見る。'}</>}
      explanation="共通アクションは、ルール・シナリオ・自動応答・回答フォーム・リッチメニューから呼び出せる「処理のまとまり」です。公開しても、使っている所は今の版のまま。使う所ごとに新しい版へ切り替えます。"
      boardId="LnGNw"
      headingSize="regular"
      title="オートメーション"

      actions={canExportCsv && selectedAccountId
        ? csvEmpty
          ? <Button disabled title="条件に合う共通アクションがないため書き出せません"><Download size={16} aria-hidden="true" />CSVで書き出す</Button>
          : (
            <Button
              href={api.commonActions.csvUrl({ accountId: selectedAccountId, status: filter === 'all' ? undefined : filter, query: deferredQuery.trim() || undefined })}
              title={csvScoped ? `この条件の${formatNumber(total)} 件を書き出します` : `全${formatNumber(total)} 件を書き出します`}
            >
              <Download size={16} aria-hidden="true" />CSVで書き出す
            </Button>
          )
        : undefined}
      tabs={<AutomationTabs active="common-actions" counts={{ ...tabCounts, commonActions: ready ? summary.total : tabCounts.commonActions }} />}
      stats={<>
        {viewerOnly ? <ViewerBand /> : null}
        <AutomationBand label="共通アクションの数の帯" cells={cells} />
      </>}
      folders={foldersError?<ListState kind="error" title="フォルダを読み込めませんでした" onRetry={()=>void loadFolders()}/>:<>
        {createButton}
        {/* 共通のフォルダの列（種類 common_action）。一覧の口がフォルダで絞れるまでは件数を出さず、未分類に全部を数える。 */}
        <ManagedFolderPanel
          kind="common_action"
          accountId={selectedAccountId}
          folders={folders}
          onChanged={loadFolders}
          canManage={canEdit}
          itemLabel="共通アクション"
          activeId={folderFilter}
          onSelect={setFolderFilter}
          allId=""
          unfiledId={UNFILED}
          allCount={ready ? summary.total : null}
          unfiledCount={unfiledCount}
          countOf={(folder) => folder.itemCount ?? null}
          placeholder="例： 購入・予約"
        />
      </>}
      folderNav={foldersError?undefined:{ rows: folderRows, activeId: folderFilter, onSelect: setFolderFilter, createAction: createButton }}
      toolbar={toolbar}
      pagination={pager}
      overlays={<>
        {folderMove.overlays}
        <Dialog
          open={Boolean(archiving)}
          title={archiving?.mode === 'unarchive'
            ? `「${archiving?.item.name}」の保管を戻しますか`
            : `「${archiving?.item.name}」を保管しますか`}
          description={archiving?.mode === 'unarchive'
            ? '通常一覧に戻ります。実行記録はそのまま残ります。'
            : '通常一覧から外れます。実行記録は残ります。'}
          confirmLabel={archiving?.mode === 'unarchive'
            ? '保管を戻す'
            : archiving && archiving.item.bindingCount > 0 ? '閉じる' : '保管する'}
          busy={archivingBusy}
          onCancel={() => setArchiving(null)}
          onConfirm={() => confirmArchive()}
        >
          {archiving?.mode === 'archive' && archiving.item.bindingCount > 0 ? (
            <Notice tone="danger" className={styles.dialogWarnNoticePlacement} >利用中のため保管できません（{archiving.item.bindingCount}か所）。先に利用先を外してください。</Notice>
          ) : null}
          {archiveError ? <Notice tone="danger" >{archiveError}</Notice> : null}
        </Dialog>
      </>}
    >
      {listBody}
    </ListPage>
  )
}
