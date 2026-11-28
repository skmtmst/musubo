'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { NotificationCenterItem } from '@line-crm/shared'
import { BellPanel, isSystemNotification, notificationQueryForTab, type BellPanelItem, type BellPanelState, type NotificationTab } from '@/v8/notifications/public/bell/index'
import type { TopBarNotificationsPopover } from '@/components/shared/top-bar'
import { notificationDestination, notificationLinkLabel } from '@/v8/notifications/public/destination/index'
import { loadFailureCopy, loadFailureNotice } from '@/components/shared/api-error-message'
import { formatDateTime, formatRelative, formatYmd } from '@/lib/format'
import { useStaffRole } from '@/lib/staff-role'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import { notifyToast } from '@/components/shared/toast'
import Notice from '@/components/shared/notice'
import { loadNotificationCenter, type NotificationAccount, type NotificationScope, type ScopedCenterData, type ScopedNotification } from './notification-center-data'

/** 小窓に出す最大の件数（絵 mV28V）。 */
export const BELL_POPOVER_LIMIT = 5
/** 読む件数。通知の一覧と同じ 50 件から未読を先に並べ、先頭の5件を出す。 */
const FETCH_LIMIT = 50

/** 未読が先・それぞれの中は口の順（新しい順）。通知の一覧と同じ並び。 */
export function bellOrder<T extends NotificationCenterItem>(items: T[]): T[] {
  const newestFirst = (rows: T[]) => [...rows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  return [...newestFirst(items.filter((item) => !item.isRead)), ...newestFirst(items.filter((item) => item.isRead))]
}

const NO_ACCOUNTS: NotificationAccount[] = []

/**
 * ★V8 ベルの小窓の中身（取得・既読・行き先）。見た目は `v8/notifications/bell-panel.tsx`。
 *
 * 通知の一覧（`v8/notifications/list.tsx`）と同じ口・同じ判定を使う：
 *   一覧 `api.notifications.center.list`・既読 `markRead`・まとめて既読 `markAllRead`
 *   タブ「すべて・未読・システム」（未読は口の unread=1、システムは category=error）
 *   行き先 `notificationDestination`（ダッシュボードの通知パネルと同じ判定＋EC連携）。
 * 既読は押した瞬間に反映し、失敗したら知らせて実際の既読状態を読み直す。
 * 未読の数が変わったら onUnreadChange でベルの赤い札へ返す。
 */
export default function BellNotifications({
  popover,
  target,
  hqOrigin = false,
  accounts = NO_ACCOUNTS,
  onAccountChange,
  onUnreadChange,
}: {
  hqOrigin?: boolean
  popover: TopBarNotificationsPopover
  /** 統括全店・個別店・店未選択を区別し、未選択から全店へ広げない。 */
  target: NotificationScope
  /** 統括で使えるアカウント一覧。個別アカウント画面では選択中だけ読む。 */
  accounts?: NotificationAccount[]
  onAccountChange: (accountId: string, after?: () => void) => void
  onUnreadChange: (count: number | null) => void
}) {
  const router = useRouter()
  const accountId = target.kind === 'store' ? target.accountId : null
  const targetKind = target.kind
  const loadTarget = useMemo<NotificationScope>(() => targetKind === 'store' && accountId ? { kind: 'store', accountId } : { kind: targetKind === 'all' ? 'all' : 'none' }, [targetKind, accountId])
  const role = useStaffRole()
  const canMarkReadByRole = role === 'owner' || role === 'admin' || role === 'staff'
  const markAllReadLockedReason = usePermissionLockReason(canMarkReadByRole, 'manager')
  const canMarkRead = canMarkReadByRole && !markAllReadLockedReason
  const { open, onClose } = popover
  // 上の未読数の更新で親が描き直されても、同じ対象への読込は起こし直さない。
  const accountsKey = JSON.stringify(accounts.map(({ id, label }) => ({ id, label })))
  const notificationAccounts = useMemo(() => JSON.parse(accountsKey) as NotificationAccount[], [accountsKey])
  const scopeKey = JSON.stringify([loadTarget, accountsKey])
  const mutationScope = useRef({ key: scopeKey })
  if (mutationScope.current.key !== scopeKey) mutationScope.current = { key: scopeKey }
  const scope = mutationScope.current
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const [tab, setTab] = useState<NotificationTab>('all')
  const [data, setData] = useState<ScopedCenterData | null>(null)
  const [state, setState] = useState<BellPanelState>('loading')
  const [error, setError] = useState<{ message: string; retryable: boolean } | null>(null)
  const markAllReadDisabledReason = role === null || markAllReadLockedReason || data?.unreadCount === 0
    ? undefined
    : data?.unreadCount === null || !data
      ? '未読件数を確認できないため、すべて既読にできません。'
      : undefined
  const requestId = useRef(0)
  const unreadRef = useRef(onUnreadChange)
  unreadRef.current = onUnreadChange

  const load = useCallback(async () => {
    const id = ++requestId.current
    setState('loading')
    setError(null)
    try {
      const result = await loadNotificationCenter(loadTarget, notificationAccounts, { ...notificationQueryForTab(tab), limit: FETCH_LIMIT })
      if (id !== requestId.current) return
      setData(result)
      setState(result ? 'ready' : 'no-account')
      unreadRef.current(result?.unreadCount ?? (loadTarget.kind === 'none' ? 0 : null))
    } catch (caught) {
      if (id !== requestId.current) return
      setData(null)
      unreadRef.current(null)
      setError({ message: loadFailureNotice(caught, '通知'), retryable: loadFailureCopy(caught, '通知').retryable })
      setState('error')
    }
  }, [loadTarget, notificationAccounts, tab])
  const loadRef = useRef(load)
  loadRef.current = load

  // 開くたび・タブを変えるたびに読み直す（閉じている間は読まない）。
  useEffect(() => {
    if (open) void load()
    return () => { requestId.current += 1 }
  }, [open, load])

  const apply = useCallback((next: ScopedCenterData) => {
    setData(next)
    unreadRef.current(next.unreadCount)
  }, [])

  const markRead = useCallback((item: ScopedNotification) => {
    if (!canMarkRead || !data || item.isRead) return
    apply({
      ...data,
      items: data.items.map((row) => (row.id === item.id && row.sourceAccountId === item.sourceAccountId ? { ...row, isRead: true } : row)),
      counts: { ...data.counts, unread: Math.max(0, data.counts.unread - 1) },
      unreadCount: data.unreadCount === null ? null : Math.max(0, data.unreadCount - 1),
    })
    void (async () => {
      try {
        const response = await (await import('@/lib/api')).api.notifications.center.markRead(item.id, item.sourceAccountId)
        if (!response.success) throw new Error(response.error)
      } catch {
        if (!mounted.current || scope !== mutationScope.current) return
        notifyToast('通知を既読にできませんでした。', { tone: 'error' })
        void loadRef.current()
      }
    })()
  }, [apply, canMarkRead, data, load, scope])

  const markAllRead = useCallback(() => {
    if (!canMarkRead || !data || data.unreadCount === null || data.unreadCount === 0 || data.loadedAccountIds.length === 0) return
    apply({
      ...data,
      items: data.items.map((row) => ({ ...row, isRead: true })),
      counts: { ...data.counts, unread: 0 },
      unreadCount: 0,
    })
    void (async () => {
      try {
        const { api } = await import('@/lib/api')
        const results = await Promise.allSettled(data.loadedAccountIds
          .map((id) => api.notifications.center.markAllRead(id, 'all')))
        if (results.some((result) => result.status === 'rejected' || !result.value.success)) throw new Error('notification read failed')
      } catch {
        if (!mounted.current || scope !== mutationScope.current) return
        notifyToast('通知をまとめて既読にできませんでした。', { tone: 'error' })
        void loadRef.current()
      }
    })()
  }, [apply, canMarkRead, data, load, scope])

  const shown = useMemo(() => (data ? bellOrder(data.items).slice(0, BELL_POPOVER_LIMIT) : []), [data])
  const today = formatYmd(new Date())
  const items: BellPanelItem[] = shown.map((item) => {
    const day = formatYmd(item.createdAt)
    return {
      id: `${item.sourceAccountId}:${item.id}`,
      title: accountId ? item.title : `${item.sourceAccountName}：${item.title}`,
      body: item.body,
      kind: isSystemNotification(item) ? 'system' : 'other',
      unread: !item.isRead,
      time: formatRelative(item.createdAt, undefined, '日時不明'),
      timeTitle: formatDateTime(item.createdAt, '日時不明'),
      period: day === '' ? 'unknown' : day === today ? 'today' : 'earlier',
      linkLabel: notificationLinkLabel(item, { accountId: item.sourceAccountId }),
    }
  })
  const partialNotice = data && data.failedAccountLabels.length > 0 ? (
    <Notice tone="warn" compact role="status" message={`${data.failedAccountLabels.join('、')} の通知を読み込めませんでした。読めた店舗の通知を表示しています。${data.unreadCount === null ? '全店の未読件数を確認できないため、すべて既読にできません。' : '全店の未読件数は確認できません。'}`} />
  ) : undefined

  const select = (id: string) => {
    const item = shown.find((row) => `${row.sourceAccountId}:${row.id}` === id)
    if (!item) return
    markRead(item)
    onClose()
    const nextContext = { accountId: item.sourceAccountId, hqOrigin }
    const destination = notificationDestination(item, nextContext)
    if (item.sourceAccountId !== accountId) {
      onAccountChange(item.sourceAccountId, () => {
        notifyToast(`${item.sourceAccountName} に切り替えました`, { tone: 'info' })
        router.push(destination)
      })
    } else router.push(destination)
  }

  return (
    <BellPanel
      open={open}
      onClose={onClose}
      getAnchor={popover.getAnchor}
      id={popover.id}
      state={state}
      items={items}
      unreadCount={data?.unreadCount ?? null}
      partialNotice={partialNotice}
      tab={tab}
      onTabChange={setTab}
      errorMessage={error?.message}
      onRetry={error?.retryable ? () => { void load() } : undefined}
      onSelect={select}
      onMarkAllRead={loadTarget.kind === 'none' ? undefined : markAllRead}
      markAllReadDisabled={role === null || Boolean(markAllReadLockedReason) || !data || data.unreadCount === null || data.unreadCount === 0}
      markAllReadDisabledReason={markAllReadDisabledReason}
      markAllReadLockedReason={markAllReadLockedReason}
      onViewAll={() => { onClose(); router.push(hqOrigin ? '/notifications?from=hq' : '/notifications') }}
    />
  )
}
