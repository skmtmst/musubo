'use client'

import { describeApiFailure } from '@/components/shared/api-error-message'
import { useUrlTab } from '@/lib/use-url-tab'
import { useListUrlValue } from '@/components/shared/list-url-state'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import type { RestaurantChannelCloseTask } from '@line-crm/shared'
import { ListPage } from '@/components/templates/list-page'
import Chip from '@/components/shared/chip'
import Button from '@/components/shared/button'
import ListState from '@/components/shared/list-state'
import SearchField from '@/components/shared/search-field'
import Select from '@/components/shared/select'
import Pagination from '@/components/shared/pagination'
import { DEFAULT_PAGE_SIZE as PAGE_SIZE } from '@/components/shared/page-size-options'
import StatusBadge from '@/components/shared/status-badge'
import { RowMenu } from '@/components/shared/row-actions'
import { DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import { Tabs } from '@/components/shared/tabs'
import { notifyToast } from '@/components/shared/toast'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { useAccount } from '@/contexts/account-context'
import { useStaffRole } from '@/lib/staff-role'
import { restaurantTestApi } from '@/lib/restaurant-test-api'
import { type CloseGroup, canWriteRole, groupCloseTasks, openItems, reasonText, slotTitle } from '@/v8/restaurant/dashboard/public/summarize/index'
import { type StoreMedium, loadStoreMedia, selectAccountStore } from '@/v8/restaurant/dashboard/public/use-store-today/index'
import styles from './close-tasks.module.css'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField, useSaveFormErrors, SaveErrorScope } from '@/components/shared/save-form-errors'

/*
 * ★V8 他のサイトの枠を閉じる知らせ（提案 E-5 。ダッシュボードの「すべて見る」から）。
 *
 * 未対応／閉じた で切り替え。1行＝1つの枠（時刻）。閉じる媒体は札で並べ、閉じた媒体には ✓。
 * ［閉じた］は媒体ごと（まだ閉じていない先頭の媒体。ほかの媒体は「…」から）。
 * 席が空いた枠は「もう開けてよい」。読む口・書く口は channel-close-tasks（今ある口）だけ。動きは BEHAVIOR.md。
 */

type Tab = 'open' | 'done'

/* 絵 ：表の下に件数とページ送り。1ページの行数。 */


/* 手を動かす順：未対応 → 残りあり → もう開けてよい → 閉じた（同じ状態の中は時刻順）。 */
const STATE_ORDER: Record<CloseGroup['state'], number> = { open: 0, partly: 1, reopen: 2, done: 3 }

const STATE_BADGE: Record<CloseGroup['state'], { label: string; tone: 'danger' | 'warning' | 'info' | 'success' }> = {
  open: { label: '未対応', tone: 'danger' },
  partly: { label: '残りあり', tone: 'warning' },
  reopen: { label: 'もう開けてよい', tone: 'info' },
  done: { label: '閉じた', tone: 'success' },
}

export default function CloseTasksPage() {
  const saveErrors = useSaveFormErrors()
  const router = useRouter()
  usePageTitle('枠を閉じる知らせ')
  usePageCrumbs([{ label: 'ダッシュボード', href: '/' }])
  const { selectedAccountId } = useAccount()
  const role = useStaffRole()
  const canWrite = canWriteRole(role)
  const [tasks, setTasks] = useState<RestaurantChannelCloseTask[] | null>(null)
  const [media, setMedia] = useState<StoreMedium[]>([])
  const [error, setError] = useState<unknown>(null)
  const [tab, setTab] = useUrlTab(['open', 'done'] as const, 'open')
  const [query, setQuery] = useListUrlValue('q', '')
  const [medium, setMedium] = useState('all')
  const [busyId, setBusyId] = useState('')
  const [page, setPage] = useState(1)

  const latest = useRef(0)
  const load = useCallback(async () => {
    const ticket = ++latest.current
    if (!selectedAccountId) return
    setError(null)
    try {
      const [stores, context] = await Promise.all([
        restaurantTestApi.listStores(selectedAccountId),
        restaurantTestApi.storeContext(selectedAccountId),
      ])
      const storeId = selectAccountStore(stores.data.stores, selectedAccountId, context.data.selectedStore?.id)
      if (!storeId) { if (ticket === latest.current) { setTasks([]); setMedia([]) }; return }
      const [list, channels] = await Promise.all([
        restaurantTestApi.channelCloseTasks(selectedAccountId, storeId),
        loadStoreMedia(selectedAccountId, storeId),
      ])
      if (ticket !== latest.current) return
      if (!Array.isArray(list.data)) throw new Error('読み込めませんでした')
      setTasks(list.data); setMedia(channels)
    } catch (caught) {
      if (ticket === latest.current) setError(caught)
    }
  }, [selectedAccountId])
  useEffect(() => { setTasks(null); setMedia([]); void load(); return () => { latest.current++ } }, [load])


  const groups = useMemo(() => groupCloseTasks(tasks ?? [], media), [tasks, media])
  const openCount = groups.filter((g) => g.state !== 'done').length
  const doneCount = groups.length - openCount
  const shown = groups
    .filter((g) => (tab === 'open' ? g.state !== 'done' : g.state === 'done'))
    .filter((g) => medium === 'all' || g.items.some((item) => item.channel === medium))
    .filter((g) => !query.trim() || slotTitle(g.startsAt).includes(query.trim()) || g.items.some((item) => item.name.includes(query.trim())))
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.startsAt.localeCompare(b.startsAt))
  const pageCount = Math.max(1, Math.ceil(shown.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const pageRows = shown.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
  // 絞り込み・タブを変えたら1ページ目へ（§6.11 の 5）。
  useEffect(() => { setPage(1) }, [tab, medium, query])
  const mediaOptions = [...new Map(groups.flatMap((g) => g.items).map((item) => [item.channel, item.name])).entries()]

  const close = async (taskId: string, name: string) => {
    if (!selectedAccountId) return
    setBusyId(taskId)
    try {
      await restaurantTestApi.completeChannelCloseTask(selectedAccountId, taskId)
      notifyToast(`${name}の枠を閉じた印を付けました。`)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught);


      if (!fieldFailure) {
      notifyToast(describeApiFailure(caught, '保存'), { tone: 'error' }) }
    } finally {
      await load()
      setBusyId('')
    }
  }

  let content
  if (error) content = <ListState kind="error" error={error} onRetry={() => void load()} action={canWrite ? <Button href="/settings/booking-media">店舗の選択を確認する</Button> : undefined} description={!canWrite ? '読み直しても解決しない場合は管理者にお問い合わせください。' : undefined} />
  else if (tasks === null) content = <ListState kind="loading" />
  else if (shown.length === 0) {
    content = <ListState kind="empty" title={tab === 'open' ? '未対応の知らせはありません' : '閉じた知らせはありません'} description={tab === 'open' ? '他の予約サイトの枠を閉じる必要があると、ここに出ます。' : undefined} />
  } else {
    content = (
      <DataTable presentation="columns" data-design="restaurant-close-tasks">
        <thead>
          <TableHeadRow data-table-layout="columns">
            <Th className={styles.colSlot}>枠の日時</Th>
            <Th className={styles.colRoute} collapseAt="narrow">入った経路</Th>
            <Th className={styles.colMedia}>閉じる媒体</Th>
            <Th className={styles.colState}>状態</Th>
            <Th className={styles.colActions}>操作</Th>
          </TableHeadRow>
        </thead>
        <tbody>
          {pageRows.map((group) => {
            const remaining = openItems(group)
            const target = remaining[0] ?? null
            /*
             * 「もう開けてよい」の行は、閉じた媒体の管理画面で枠を開け直す。
             * 開け直した印を付ける口（［開けた］）はまだ無い（BEHAVIOR.md の「今の口で出せないもの」）。
             */
            const linkItem = target ?? (group.state === 'reopen' ? group.items[0] ?? null : null)
            const targetMedium = linkItem ? media.find((m) => m.code === linkItem.channel) ?? null : null
            const badge = STATE_BADGE[group.state]
            return (
              <Tr key={group.slotId} data-table-layout="columns">
                <Td className={styles.colSlot}>
                  <span className={styles.slot}>{slotTitle(group.startsAt)}</span>
                  <span className={styles.reason}>{reasonText(group)}</span>
                </Td>
                {/* 予約と知らせの結び付け（どの経路で入った予約か）は口がまだ無い（Codex 担当）。来たらここに経路の札。 */}
                <Td className={styles.colRoute} collapseAt="narrow"><span className={styles.none} title="どの経路の予約で出た知らせかは、まだ出せません">{emptyValue('unknown')}</span></Td>
                <Td className={styles.colMedia}>
                  <span className={styles.chips} title={group.items.map((item) => `${item.name}${item.status === 'done' ? '（閉じた）' : ''}`).join('・')}>
                    {group.items.map((item) => (
                      <Chip key={item.id}>
                        {item.name}{item.status === 'done' ? <Check size={16} aria-label="閉じた" /> : null}
                      </Chip>
                    ))}
                  </span>
                </Td>
                <Td className={styles.colState}>
                  <StatusBadge tone={badge.tone}>{group.state === 'partly' ? `残り ${remaining.length}つ` : badge.label}</StatusBadge>
                </Td>
                <Td className={styles.colActions}>
                  <span className={styles.actions}>
                    {targetMedium?.adminUrl ? (
                      <Button external size="compact" href={targetMedium.adminUrl}  >管理画面を開く</Button>
                    ) : null}
                    {canWrite && target ? (
                      <Button size="compact" onClick={() => void close(target.id, target.name)} disabled={busyId === target.id} aria-label={`${target.name}の枠を閉じた`} title={`${target.name}の枠を閉じた`} busy={Boolean(busyId === target.id)} busyLabel="処理中…">
                        <Check size={16} aria-hidden="true" />閉じた
                      </Button>
                    ) : null}
                    <RowMenu
                      appearance="box"
                      label={`${slotTitle(group.startsAt)}の操作`}
                      items={[
                        ...(canWrite ? remaining.slice(1).map((item) => ({ id: item.id, label: `${item.name}を閉じた`, onSelect: () => void close(item.id, item.name) })) : []),
                        { id: 'ledger', label: '予約台帳でこの日を見る', external: false, href: `/restaurant-test/reservations?date=${group.startsAt.slice(0, 10)}`, onSelect: () => { router.push(`/restaurant-test/reservations?date=${group.startsAt.slice(0, 10)}`) } },
                      ]}
                    />
                  </span>
                </Td>
              </Tr>
            )
          })}
        </tbody>
      </DataTable>
    )
  }

  return (
    <SaveErrorScope errors={saveErrors}><ListPage
      boardId="YMVFD"
      tableInset
      headingSize="compact"
      title="他のサイトの枠を閉じる知らせ"
      help="LINE や電話で予約が入って席が少なくなった枠を、ほかの予約サイトでも閉じるための知らせです。閉じたら［閉じた］を押します。キャンセルで席が戻った枠は「もう開けてよい」になります。"
      tabs={(
        <span className={styles.tabsRow}><Tabs
          label="知らせの状態"
          items={[
            { label: `未対応（${openCount}）`, current: tab === 'open', onClick: () => setTab('open') },
            { label: `閉じた（${doneCount}）`, current: tab === 'done', onClick: () => setTab('done') },
          ]}
        /></span>
      )}
      pagination={tasks !== null && !error && shown.length > 0 ? (
        <Pagination
          spacing="restaurant"
          page={currentPage}
          pageCount={pageCount}
          onPageChange={setPage}
          ariaLabel="枠を閉じる知らせのページ送り"
          range={{ total: shown.length, first: (currentPage - 1) * PAGE_SIZE + 1, last: (currentPage - 1) * PAGE_SIZE + pageRows.length }}
        />
      ) : undefined}
      toolbar={(
        <>
          <span className={styles.search}>
            <SearchField aria-label="日時・媒体で探す" placeholder="日時・媒体で探す" value={query} onChange={setQuery} onClear={() => setQuery('')} />
          </span>
          <SaveErrorField names={["medium"]}><Select
            aria-label="媒体で絞る"
            value={medium}
            onChange={setMedium}
            options={[{ value: 'all', label: '媒体：すべて' }, ...mediaOptions.map(([code, name]) => ({ value: code, label: `媒体：${name}` }))]}
          /></SaveErrorField>
        </>
      )}
    >
      {content}
    </ListPage></SaveErrorScope>
  )
}
