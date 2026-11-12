'use client'

import type { MenusTabProps } from './menus-tab-types'

import SharedStatusPill from '@/components/shared/status-pill'
import StatusAction from '@/components/shared/status-action'
import { useListUrlValue } from '@/components/shared/list-url-state'
import TagPill from '@/components/shared/tag-pill'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { Plus } from 'lucide-react'
import { type ActionMenuItem } from '@/components/shared/action-menu'
import { RowNameButton, DataTable, TableHeadRow, Tr, Th, Td } from '@/components/shared/table'
import Card from '@/components/shared/card'
import Button from '@/components/shared/button'
import EmptyList from '@/components/shared/empty-list'
import { EmptyCell } from '@/components/shared/empty-value'
import { notifyToast } from '@/components/shared/toast'

import Pagination from '@/components/shared/pagination'
import { RowMenu } from '@/components/shared/row-actions'
import ReorderHandle, { useReorder } from '@/components/shared/reorder-handle'
import SearchField from '@/components/shared/search-field'
import ListRange from '@/components/ui/list-range'
import { bookingApi, type BookingMenu } from '@/lib/api'
import { menuPriceLabel } from '../lib/menu-price'
import { bookingErrorMessage } from '../lib/menu-validation'
import MenuVersionHistory from '../menu-version-history'
import { AccountIcon, Band, MENU_PAGE_SIZE, StateCard, SkeletonRows, sortedMenus } from './shared'
import { FOLDER_SELECT_COLORS } from '@line-crm/shared'
import styles from '../settings.module.css'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import Notice from '@/components/shared/notice'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'

/* ① メニュー（settings-v8.tsx から分割。見た目・動きは変えない） */

export function MenusTabV8({ accountId, menus, status, error, menuCount, canEdit, onReload, onOpenStaff }: MenusTabProps) {
  const saveErrors = useSaveFormErrors()
  const router = useRouter()
  const [query, setQuery] = useListUrlValue('q', '')
  const [page, setPage] = useListUrlValue('page', 1)
  const [deleteTarget, setDeleteTarget] = useState<{ menu: BookingMenu; accountId: string; generation: number } | null>(null)
  const scope = useRef({ accountId, generation: 0, awaitingLoad: false })
  if (scope.current.accountId !== accountId) scope.current = { accountId, generation: scope.current.generation + 1, awaitingLoad: true }
  if (scope.current.awaitingLoad && status === 'loading') scope.current.awaitingLoad = false
  const renderedScope = scope.current
  const statusRef = useRef(status)
  statusRef.current = status
  const canEditRef = useRef(canEdit)
  canEditRef.current = canEdit
  const alive = useRef(false)
  const deleteLock = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [historyTarget, setHistoryTarget] = useState<BookingMenu | null>(null)
  const [visibilityError, setVisibilityError] = useState<string | null>(null)
  const [updatingVisibility, setUpdatingVisibility] = useState(false)
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [reorderBusy, setReorderBusy] = useState(false)
  const [reorderError, setReorderError] = useState<string | null>(null)
  /* 先に画面を変える分（公開・並び）。裏の保存が終わるまでここが勝つ。 */
  const [visOverride, setVisOverride] = useState<Record<string, boolean>>({})
  const [orderOverride, setOrderOverride] = useState<string[] | null>(null)
  const menusRef = useRef(menus)
  menusRef.current = menus
  const reorderBusyRef = useRef(false)

  async function deleteMenu() {
    if (!deleteTarget || deleting || deleteLock.current || !alive.current || !canEditRef.current || statusRef.current !== 'ready' || scope.current.awaitingLoad || deleteTarget.generation !== scope.current.generation) return
    deleteLock.current = true
    setDeleting(true); setDeleteError('')
    try {
      await bookingApi.deleteMenu(deleteTarget.accountId, deleteTarget.menu.id)
      if (!alive.current || deleteTarget.generation !== scope.current.generation) return
      setDeleteTarget(null); onReload(); notifyToast('予約メニューを削除しました')
    } catch (cause) {
      if (!alive.current || deleteTarget.generation !== scope.current.generation) return
      setDeleteError(cause instanceof Error && 'status' in cause && cause.status === 409
        ? '予約が付いているため削除できません。新しい予約を止めるには「止める」を使ってください。'
        : '削除できませんでした。状態を読み直してお試しください。')
    } finally { deleteLock.current = false; if (alive.current) setDeleting(false) }
  }

  const orderedBase = useMemo(() => {
    const sorted = sortedMenus(menus)
    if (!orderOverride || orderOverride.length !== sorted.length) return sorted
    const byId = new Map(sorted.map((menu) => [menu.id, menu]))
    const applied = orderOverride.map((id) => byId.get(id)).filter((menu): menu is BookingMenu => Boolean(menu))
    return applied.length === sorted.length ? applied : sorted
  }, [menus, orderOverride])

  const shown = useMemo(() => {
    const keyword = query.trim()
    return keyword
      ? orderedBase.filter((menu) => menu.name.toLowerCase().includes(keyword.toLowerCase()))
      : orderedBase
  }, [orderedBase, query])
  const pageCount = Math.max(1, Math.ceil(shown.length / MENU_PAGE_SIZE))
  const safePage = Math.min(page, pageCount)

  /* 中身の直しはメニュー作成ページ（?menu=<id>、node ）に集約する。 */
  function openMenuForm(menu: BookingMenu) {
    router.push(`/booking/menus/new?menu=${menu.id}`)
  }

  /*
   * 並び替え（共通の並び替え）。つまみのドラッグ・上下キー・「…」の上へ／下へは
   * どれも persistOrder を通る。先に並びを変えて裏で保存する。
   * 動いた範囲を版番号付きの一括APIへ送り、途中まで順位が変わるのを防ぐ。
   * 失敗したときは画面を元の並びへ戻して読み直す。
   */
  async function persistOrder(movedId: string, nextIds: string[], undoable = true) {
    if (reorderBusyRef.current) return
    /* 知らせから押し直すときも、読み直した最新の版で計算する。 */
    const ordered = sortedMenus(menusRef.current)
    const byId = new Map(ordered.map((item) => [item.id, item]))
    const moved = byId.get(movedId)
    const changes = ordered
      .map((item, index) => ({ menu: byId.get(nextIds[index]), sortOrder: item.sort_order }))
      .filter((entry): entry is { menu: BookingMenu; sortOrder: number } => Boolean(entry.menu) && entry.menu!.sort_order !== entry.sortOrder)
    if (!moved || nextIds.length !== ordered.length || changes.length === 0) return
    if (changes.some(({ menu }) => typeof menu.version !== 'number' || !Number.isInteger(menu.version) || menu.version < 1)) {
      onReload()
      setReorderError('最新の状態を読み直しました。もう一度お試しください。')
      return
    }
    const fromIndex = ordered.findIndex((item) => item.id === movedId)
    const toIndex = nextIds.indexOf(movedId)
    const previousIds = ordered.map((item) => item.id)
    setOrderOverride(nextIds)
    reorderBusyRef.current = true
    setReorderBusy(true)
    setReorderError(null)
    try {
      await bookingApi.reorderMenus(accountId, {
        changes: changes.map(({ menu, sortOrder }) => ({ id: menu.id, expectedVersion: menu.version as number, sortOrder })),
      })
      setOrderOverride(null)
      onReload()
      notifyToast(`「${moved.name}」を${toIndex < fromIndex ? '上' : '下'}へ移しました。`, undoable ? {
        actionLabel: '元に戻す',
        onAction: () => { void persistOrder(movedId, previousIds, false) },
      } : undefined)
    } catch (cause) {
      const fieldFailure = saveErrors.capture(cause)
      setOrderOverride(null)
      onReload()
      { if (!fieldFailure)
      notifyToast(bookingErrorMessage(cause, '保存'), {
        actionLabel: 'もう一度',
        onAction: () => { void persistOrder(movedId, nextIds, undoable) },
      }) }
    } finally {
      reorderBusyRef.current = false
      setReorderBusy(false)
    }
  }

  const reorderDisabledReason = !canEdit
    ? '閲覧のみのため並び替えできません'
    : query.trim()
      ? '検索を外すと動かせます'
      : reorderBusy
        ? '並び替えを保存しています'
        : null
  const reorder = useReorder({
    items: orderedBase,
    idOf: (menu) => menu.id,
    disabledReason: reorderDisabledReason,
    onReorder: ({ id, ids }) => persistOrder(id, ids),
  })
  /* ドラッグ中は置き場所を入れ替えて見せる（検索中は動かせないので、絞った並びのまま）。 */
  const visibleBase = reorder.blocked ? shown : reorder.shown
  const visible = visibleBase.slice((safePage - 1) * MENU_PAGE_SIZE, safePage * MENU_PAGE_SIZE)

  /* 公開・止める。先に札を変えて裏で保存する。 */
  async function toggleVisibility(menu: BookingMenu, force?: boolean) {
    if (updatingVisibility) return
    const next = force ?? !(visOverride[menu.id] ?? menu.is_active)
    setVisOverride((current) => ({ ...current, [menu.id]: next }))
    setUpdatingVisibility(true)
    setVisibilityError(null)
    try {
      const version = menu.version
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
        throw new Error('booking_menu_version_missing')
      }
      await bookingApi.patchMenu(accountId, menu.id, version, { is_active: next })
      setVisOverride((current) => {
        const copy = { ...current }
        delete copy[menu.id]
        return copy
      })
      onReload()
      notifyToast(next ? `「${menu.name}」をお客さまの画面へ出しました。` : `「${menu.name}」の新しい予約を止めました。`, {
        actionLabel: '元に戻す',
        onAction: () => {
          const latest = menusRef.current.find((item) => item.id === menu.id) ?? menu
          void toggleVisibility(latest, !next)
        },
      })
    } catch (cause) {
      const fieldFailure = saveErrors.capture(cause)
      setVisOverride((current) => {
        const copy = { ...current }
        delete copy[menu.id]
        return copy
      })
      onReload()
      if (cause instanceof Error && cause.message === 'booking_menu_version_missing') {
        { if (!fieldFailure)
        setVisibilityError('最新の状態を読み直しました。もう一度お試しください。') }
      } else {
        notifyToast(bookingErrorMessage(cause, '保存'), {
          actionLabel: 'もう一度',
          onAction: () => {
            const latest = menusRef.current.find((item) => item.id === menu.id) ?? menu
            void toggleVisibility(latest, next)
          },
        })
      }
    } finally {
      setUpdatingVisibility(false)
    }
  }

  if (status === 'loading') {
    return (
      <SaveErrorScope errors={saveErrors}><div aria-busy="true">
        <SkeletonRows rows={5} />
      </div></SaveErrorScope>
    )
  }
  if (status === 'error') {
    return (
      <SaveErrorScope errors={saveErrors}>
      <StateCard
        icon={<AccountIcon />}
        title="予約設定を読み込めませんでした"
        description={error ?? '通信状態を確認して、もう一度お試しください。'}
        action={<Button onClick={onReload}>もう一度読み込む</Button>}
      /></SaveErrorScope>
    )
  }

  const activeCount = menus.filter((menu) => menu.is_active).length

  return (
    <SaveErrorScope errors={saveErrors}>
    <div className={styles.tabStack} data-design="Table">
      <ConfirmDialog open={deleteTarget !== null && deleteTarget.generation === scope.current.generation} title={`「${deleteTarget?.menu.name ?? ''}」を削除しますか？`} description="予約が付いているメニューは削除できません。" confirmLabel="削除する" destructive busy={deleting} error={deleteError} onConfirm={() => deleteMenu()} onCancel={() => { if (!deleting) setDeleteTarget(null) }}>{deleteTarget ? <OperationTargetSummary accounts={[{ id: deleteTarget.accountId }]} /> : null}</ConfirmDialog>
      <Band tone="hint">上から並んだ順に、お客さまの画面に出ます。{canEdit ? 'つまみで並べ替えます。' : null}</Band>

      <div className={styles.toolbar}>
        <div className={styles.searchBox}>
          <SearchField
            aria-label="メニュー名で探す"
            placeholder="メニュー名で探す"
            value={query}
            onChange={(value) => { setQuery(value); setPage(1) }}
          />
        </div>
        <span className={styles.toolbarSpacer} />
        {canEdit ? (
          <Button variant="primary" href="/booking/menus/new">{<><Plus size={16} aria-hidden="true" />予約メニューを作る</>}</Button>
        ) : (
          /* 閲覧のみ：作るボタンは置かず、場所だけ空ける（下の段の位置を変えない）。 */
          <span className={styles.createSlot} aria-hidden="true" />
        )}
      </div>

      {reorderError ? <Notice tone="danger" className="mt-2" >{reorderError}</Notice> : null}
      {visibilityError ? <Notice tone="danger" className="mt-2" >{visibilityError}</Notice> : null}

      {shown.length === 0 ? (
        /* 修正案 D-2：空の一覧。 */
        <EmptyList
          icon={<AccountIcon />}
          title="まだ予約メニューがありません"
          description="メニューと担当・開ける時間を決めて、お客さまが LINE から予約できるようにします。"
          create={{ label: '最初の予約メニューを作る', href: '/booking/menus/new' }}
          canCreate={canEdit}
          filtered={menus.length > 0}
          onClearFilters={() => { setQuery(''); setPage(1) }}
          filteredDescription="検索を外すと、すべて出ます"
        />
      ) : (
        <Card layout="vertical" padding="roomy" gap="normal">
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>メニュー</h2>
            <span className={styles.sectionDesc}>
              {menuCount ?? menus.length} 件・出しているもの {activeCount}
            </span>
          </div>
          <DataTable label="予約メニュー" columnSizing="content" columnLayout={{
            headHeight: 'var(--polish-table-head)',
            rowHeight: 'auto', gap: 'var(--tpl-bm-12)', padding: 'var(--tpl-bm-8)',
            headPadding: 'var(--tpl-bm-8)', bodyTextSize: 'var(--text-label)', collapseScope: 'page',
          }}>
          <thead><TableHeadRow className={styles.tableHead} data-table-layout="columns">
            <Th className={styles.colOrder} />
            <Th className={styles.colName} grow>メニュー</Th>
            <Th className={styles.colTime}>時間</Th>
            <Th className={styles.colPrice}>金額</Th>
            <Th className={styles.colStaff} collapseAt="narrow">担当</Th>
            <Th className={styles.colCount} collapseAt="narrow">30日</Th>
            <Th className={styles.colStatus}>状態</Th>
            <Th className={styles.colMenu} />
          </TableHeadRow></thead>
          <tbody>
          {visible.map((menu) => {
            const orderIndex = shown.findIndex((item) => item.id === menu.id)
            const staffNames = (menu.assigned_staff ?? []).map((person) => person.display_name)
            const menuItems: ActionMenuItem[] = [
              { id: 'history', label: '版の履歴', onSelect: () => setHistoryTarget(menu) },
              ...(canEdit ? [
                /* つまみと同じ入口の「上へ／下へ」。検索中・保存中は出さない（つまみも出さない）。 */
                ...reorder.menuItems(menu.id, () => setOpenMenuId(null)),
                { id: 'delete', label: '削除する', tone: 'danger', onSelect: () => { if (renderedScope !== scope.current || renderedScope.awaitingLoad || statusRef.current !== 'ready' || !canEditRef.current || !alive.current) return; setDeleteError(''); setDeleteTarget({ menu, accountId, generation: renderedScope.generation }) } },
                {
                  id: 'visibility',
                  label: (visOverride[menu.id] ?? menu.is_active) ? '止める' : '出す',
                  dividerBefore: !reorder.blocked,
                  onSelect: () => void toggleVisibility(menu),
                },
              ] satisfies ActionMenuItem[] : []),
            ]
            return (
              <Tr key={menu.id} className={styles.menuRow} {...reorder.rowProps(menu.id)} data-table-layout="columns">
                <Td className={styles.colOrder}>
                  {/* 動かせない時（閲覧のみ・検索中・保存中）はつまみを出さず、理由を title と読み上げで言う。 */}
                  <ReorderHandle
                    look="icon"
                    label={menu.name}
                    ariaLabel={`「${menu.name}」を並び替える（ドラッグ・↑↓キー）`}
                    className={styles.grip}
                    {...reorder.handle(menu.id)}
                    {...reorder.handleProps(menu.id)}
                  />
                  <span className={styles.orderNum}>{orderIndex + 1}</span>
                </Td>
                <Td className={styles.colName} grow>
                  <span className={styles.nameLine}>
                    <RowNameButton title={menu.name} onClick={() => openMenuForm(menu)}>{menu.name}</RowNameButton>
                    {/* 分類には色の項目が無い。絵 owaS3・P6EdLW どおり、色の一覧の先頭（青）の丸で出す。 */}
                    {menu.category_label ? <TagPill name={menu.category_label} color={FOLDER_SELECT_COLORS[0].value} size="sm" aria-label={`分類「${menu.category_label}」`} /> : null}
                  </span>
                  {menu.description ? <span className={styles.menuDesc} title={menu.description}>{menu.description}</span> : null}
                </Td>
                <Td data-list-number className={styles.colTime}>
                  <span className={styles.cellNum}>{menu.duration_minutes}分</span>
                </Td>
                <Td data-list-number className={styles.colPrice}>
                  <span className={styles.cellNum}>{menuPriceLabel(menu)}</span>
                </Td>
                <Td className={styles.colStaff} collapseAt="narrow">
                  {staffNames.length === 0 ? (
                    <EmptyCell />
                  ) : (
                    <span className={styles.cellText} title={staffNames.join('・')}>{staffNames.join('・')}</span>
                  )}
                </Td>
                <Td data-list-number className={styles.colCount} collapseAt="narrow">
                  <span className={styles.cellNum}>{menu.booking_count_30_days ?? 0} 件</span>
                </Td>
                <Td className={styles.colStatus}>
                  {/* 公開していても担当が 0 人だと予約を受けられない。理由を札で言い、押すと担当スタッフのタブへ。 */}
                  {(visOverride[menu.id] ?? menu.is_active) && staffNames.length === 0 ? (
                    <StatusAction onClick={onOpenStaff} title="担当スタッフのタブで担当を決める">
                      <SharedStatusPill tone="caution">担当がいないため停止中</SharedStatusPill>
                    </StatusAction>
                  ) : (
                    <SharedStatusPill tone={(visOverride[menu.id] ?? menu.is_active) ? 'success' : 'neutral'}>{(visOverride[menu.id] ?? menu.is_active) ? '公開中' : '停止中'}</SharedStatusPill>
                  )}
                </Td>
                <Td className={styles.colMenu}>
                  <RowMenu
                    appearance="box"
                    size="row"
                    label={`「${menu.name}」のそのほかの操作`}
                    menuLabel={`「${menu.name}」の操作`}
                    open={openMenuId === menu.id}
                    onOpenChange={(next) => setOpenMenuId(next ? menu.id : null)}
                    items={[
                      { id: 'edit', label: '中身を編集', onSelect: () => openMenuForm(menu) },
                      ...menuItems,
                    ]}
                  />
                </Td>
              </Tr>
            )
          })}
          </tbody>
          </DataTable>
          <div className="mt-3 flex items-center justify-between gap-3">
            <ListRange
              label="メニュー"
              total={shown.length}
              first={visible.length === 0 ? 0 : (safePage - 1) * MENU_PAGE_SIZE + 1}
              last={(safePage - 1) * MENU_PAGE_SIZE + visible.length}
            />
            <Pagination page={safePage} pageCount={pageCount} onPageChange={setPage} ariaLabel="予約メニューのページ送り" />
          </div>
        </Card>
      )}

      {historyTarget ? (
        <MenuVersionHistory
          menuId={historyTarget.id}
          menuName={historyTarget.name}
          currentVersion={historyTarget.version ?? 1}
          accountId={accountId}
          canRevert={canEdit}
          onReverted={(version) => {
            setHistoryTarget((current) => current && current.id === historyTarget.id ? { ...current, version } : current)
            onReload()
          }}
          onClose={() => setHistoryTarget(null)}
        />
      ) : null}

    </div></SaveErrorScope>
  )
}
