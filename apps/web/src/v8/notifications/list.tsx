'use client'

/*
 * ★V8 通知（Pencil ）。ダッシュボードの通知パネルからの全件の行き先。
 *
 * 動き（呼ぶ API・既読・まとめて既読・さらに読み込む・失敗の扱い・URL の指定）は
 * 今の画面（app/notifications/page.tsx）と同じ。見た目だけを型（ListPage）と部品で組み直した。
 * 動きの一覧は同じ場所の BEHAVIOR.md。
 */
import Link from '@/components/shared/list-navigation'
import Card from '@/components/shared/card'
import TextLink from '@/components/shared/text-link'
import { useSamePageUrl } from '@/lib/use-same-page-url'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { CheckCheck, Sparkles, TriangleAlert } from 'lucide-react'
import type { NotificationCenterData, NotificationCenterItem } from '@line-crm/shared'
import { api } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { usePageTitle } from '@/components/shell/page-chrome'
import { ListPage } from '@/components/templates'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import ListState from '@/components/shared/list-state'
import { Tabs } from '@/components/shared/tabs'
import { STATE_TEXT } from '@/components/shared/not-connected'
import { loadFailureCopy, loadFailureNotice } from '@/components/shared/api-error-message'
import { runOptimistic } from '@/lib/undoable'
import { isDashboardNotificationData, notificationTime } from '@/components/dashboard/notification-summary'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { notificationDestination, notificationLinkLabel } from './destination'
import {
  NOTIFICATION_TABS,
  isSystemNotification,
  markAllCategoryForTab,
  notificationQueryForTab,
  notificationTabCount,
  notificationTabFromParam,
  type NotificationTab,
} from './tabs'
import styles from './list.module.css'

const PAGE_SIZE = 50

export default function NotificationsV8() {
  usePageTitle('通知')
  const router = useRouter()
  const samePageUrl = useSamePageUrl()
  const params = useSearchParams()
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const role = useStaffRole()
  // 既読は自分の印なので担当者まで付けられる。閲覧のみ・権限が分からない間は操作を出さない。
  const canMarkRead = role === 'owner' || role === 'admin' || role === 'staff'
  const destinationContext = { accountId: selectedAccountId, canManage: canManageRole(role), hqOrigin: params.get('from') === 'hq' }
  // タブ「すべて・未読・システム」。前の ?category=error はシステム、update はすべてとして読む。
  const filter: NotificationTab = notificationTabFromParam(params.get('category'))
  const [items, setItems] = useState<NotificationCenterItem[]>([])
  // 読み込んだ範囲を未読が先・新しい順にする。追加取得後も同じ順を保つ。
  const orderedItems = useMemo(
    () => [...items].sort((a, b) => a.isRead !== b.isRead ? (a.isRead ? 1 : -1) : b.createdAt.localeCompare(a.createdAt)),
    [items],
  )
  const [counts, setCounts] = useState<NotificationCenterData['counts'] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState<unknown>(null)
  const lastListFailure = useRef<string | null>(null)
  const requestId = useRef(0)
  const viewKeyRef = useRef('')
  const viewGeneration = useRef(0)
  const renderViewKey = `${selectedAccountId ?? ''}|${filter}`
  if (viewKeyRef.current !== renderViewKey) { viewKeyRef.current = renderViewKey; viewGeneration.current += 1 }

  const selectFilter = (next: NotificationTab) => {
    const query = new URLSearchParams(params.toString())
    if (next === 'all') query.delete('category')
    else query.set('category', next)
    const text = query.toString()
    samePageUrl.replace(text ? `/notifications?${text}` : '/notifications')
  }

  const load = useCallback(async (offset: number, append: boolean) => {
    const id = ++requestId.current
    if (accountLoading) return
    if (!selectedAccountId) {
      setItems([])
      setCounts(null)
      setError('LINEアカウントを選択してください')
      setLoadError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    if (!append) {
      setError('')
      setLoadError(null)
    }
    try {
      const response = await api.notifications.center.list(selectedAccountId, {
        ...notificationQueryForTab(filter),
        limit: PAGE_SIZE,
        offset,
      })
      if (id !== requestId.current) return
      if (!response.success) throw new Error(response.error)
      if (!isDashboardNotificationData(response.data)) throw new Error('invalid notification center response')
      setItems((current) => append ? [...current, ...response.data.items] : response.data.items)
      setCounts(response.data.counts)
      setLoadError(null)
      if (!append) setError('')
      else setError((current) => current === lastListFailure.current ? '' : current)
    } catch (caught) {
      if (id !== requestId.current) return
      if (!append) {
        setItems([])
        setCounts(null)
      }
      const message = loadFailureNotice(caught, '通知')
      lastListFailure.current = message
      setLoadError(caught)
      setError(message)
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [accountLoading, filter, selectedAccountId])

  useEffect(() => { void load(0, false) }, [load])

  /*
   * WEB071：既読の楽観更新の「戻す」「読み直す」は、押したときのアカウント・分類に結ぶ。
   * 失敗が届くまでに別のアカウントへ移っていたら、前の一覧・数で今の一覧を巻き戻さない。
   */
  const sameView = (key: string, generation: number, request: number) => viewKeyRef.current === key && viewGeneration.current === generation && requestId.current === request

  /* 既読は押した瞬間に画面へ反映し、裏で保存する。失敗したら未読へ戻してやり直せる知らせ。 */
  const markRead = (item: NotificationCenterItem) => {
    if (!canMarkRead || !selectedAccountId || item.isRead) return
    const accountId = selectedAccountId
    const viewKey = viewKeyRef.current
    const generation = viewGeneration.current
    const request = requestId.current
    const isCurrent = () => sameView(viewKey, generation, request)
    const apply = (isRead: boolean) => {
      if (!isCurrent()) return
      setItems((current) => current.map((row) => (row.id === item.id ? { ...row, isRead } : row)))
      setCounts((current) =>
        current ? { ...current, unread: Math.max(0, current.unread + (isRead ? -1 : 1)) } : current,
      )
    }
    apply(true)
    runOptimistic({
      isCurrent,
      request: () => api.notifications.center.markRead(item.id, accountId),
      revert: () => apply(false),
      failureMessage: '通知を既読にできませんでした。',
      retry: () => markRead(item),
    })
  }

  const openNotification = (item: NotificationCenterItem) => {
    markRead(item)
    router.push(notificationDestination(item, destinationContext))
  }

  const markAllRead = () => {
    if (!canMarkRead || !selectedAccountId || !counts || counts.unread === 0) return
    const accountId = selectedAccountId
    const viewKey = viewKeyRef.current
    const generation = viewGeneration.current
    const request = requestId.current
    const isCurrent = () => sameView(viewKey, generation, request)
    const beforeItems = items
    const beforeCounts = counts
    setItems((current) => current.map((row) => ({ ...row, isRead: true })))
    setCounts((current) => (current ? { ...current, unread: 0 } : current))
    runOptimistic({
      isCurrent,
      request: () => api.notifications.center.markAllRead(accountId, markAllCategoryForTab(filter)),
      revert: () => {
        if (!isCurrent()) return
        setItems(beforeItems)
        setCounts(beforeCounts)
      },
      failureMessage: '通知をまとめて既読にできませんでした。',
      retry: markAllRead,
      onSuccess: () => { if (isCurrent()) void load(0, false) },
    })
  }

  const filters = NOTIFICATION_TABS.map((tab) => ({ id: tab.value, label: tab.label, count: counts ? notificationTabCount(counts, tab.value) : null }))
  const total = counts ? notificationTabCount(counts, filter) : 0
  const hasMore = items.length < total
  const listFailed = loadError !== null && items.length === 0
  const listFailure = loadError !== null ? loadFailureCopy(loadError, '通知') : null

  return (
    <ListPage
      boardId="y8QQV"
      title="通知"
      help="musubo からの通知です。運用の異常、メンテナンス、新しい版の知らせが届きます。"
      actions={canMarkRead ? (
        <Button variant="secondary" onClick={() => { void markAllRead() }} disabled={!counts || counts.unread === 0}>
          <CheckCheck aria-hidden="true" className={styles.buttonIcon} />
          {filter === 'system' ? 'この分類をすべて既読にする' : 'すべて既読にする'}
        </Button>
      ) : undefined}
    >
      <div className={styles.body}>
        <Tabs
          size="notification"
          label="通知の種類"
          items={filters.map((entry) => ({
            // 絵は「すべて 6」を1つの文字で描く。数が取れないうちは名前だけ。
            label: entry.count === null ? entry.label : `${entry.label} ${entry.count}`,
            current: filter === entry.id,
            onClick: () => selectFilter(entry.id),
          }))}
        />

        {error && !listFailed ? (
          <Notice
            tone="danger"
            message={error}
            action={loadError !== null && listFailure?.retryable ? (
              <Button type="button" variant="text" onClick={() => void load(0, false)}>もう一度読み込む</Button>
            ) : undefined}
          />
        ) : null}

        <Card padding="rows" surface="inset" overflow="hidden" aria-label="通知一覧">
          {listFailed ? (
            <ListState
              kind="error"
              error={loadError ?? undefined}
              onRetry={listFailure?.retryable ? () => void load(0, false) : undefined}
            />
          ) : items.length === 0 && !loading ? (
            <ListState
              kind="empty"
              title={filter === 'unread' ? '未読の通知はありません' : filter === 'system' ? 'システムの通知はありません' : '通知はまだありません'}
              description="通知が届くと、ここに並びます。"
            />
          ) : (
            <ul className={styles.list}>
              {orderedItems.map((item) => (
                <li key={item.id} className={styles.item} data-unread={!item.isRead}>
                  <Link
                    href={notificationDestination(item, destinationContext)}
                    className={styles.row}
                    onClick={() => markRead(item)}
                    title={item.body || undefined}
                  >
                    <span className={styles.icon} data-category={isSystemNotification(item) ? 'error' : 'update'} aria-hidden="true">
                      {isSystemNotification(item) ? <TriangleAlert /> : <Sparkles />}
                    </span>
                    <span className={styles.text}>
                      <span className={styles.titleLine}>
                        <span className={styles.title}>{item.title}</span>
                        {!item.isRead ? <span className={styles.dot} aria-hidden="true" /> : null}
                        {!item.isRead ? <span className="sr-only">（未読）</span> : null}
                      </span>
                      <span className={styles.time}>{notificationTime(item.createdAt)}</span>
                    </span>
                    <span className={styles.go}>{`${notificationLinkLabel(item, destinationContext)} →`}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {loading ? <p className={styles.loading}>{STATE_TEXT.loading}…</p> : null}
        </Card>

        <div className={styles.foot}>
          <p className={styles.note}>
            {counts?.unread === 0 && !loading && !listFailed
              ? '未読の通知はありません。'
              : canMarkRead ? '未読は青い点と太字。押すと既読になり、行の右から関係する画面へ移れます' : '未読は青い点と太字。押すと関係する画面へ移れます'}
          </p>
          <TextLink href="/line-notifications?tab=operator">通知設定</TextLink>
        </div>

        {hasMore ? (
          <div className={styles.more}>
            <Button variant="secondary" onClick={() => { void load(items.length, true) }} disabled={loading}>
              さらに読み込む（残り {total - items.length} 件）
            </Button>
          </div>
        ) : null}
      </div>
    </ListPage>
  )
}
