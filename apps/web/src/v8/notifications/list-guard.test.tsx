// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotificationCenterItem } from '@line-crm/shared'

const fx = vi.hoisted(() => ({
  query: '',
  role: 'owner' as string | null,
  list: vi.fn(),
  markRead: vi.fn(),
  markAllRead: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(fx.query),
}))
vi.mock('@/lib/staff-role', async (original) => ({ ...(await original<object>()), useStaffRole: () => fx.role }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined, usePageCrumbs: () => undefined }))
vi.mock('@/lib/api', () => ({
  api: {
    notifications: {
      center: {
        list: fx.list,
        markRead: fx.markRead,
        markAllRead: fx.markAllRead,
      },
    },
  },
}))

import NotificationsV8 from './list'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const makeItem = (id: string, category: 'error' | 'update', title: string, isRead: boolean, createdAt: string): NotificationCenterItem => ({
  id,
  eventType: category === 'error' ? 'account_health_webhook_delay' : 'maintenance.scheduled',
  category,
  title,
  body: '',
  metadata: null,
  isRead,
  createdAt,
})

describe('NotificationsV8 分類既読の未読数保持・連打防止・追加読込重複排除', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    fx.query = ''
    fx.role = 'owner'
    fx.markRead.mockResolvedValue({ success: true })
    fx.markAllRead.mockResolvedValue({ success: true })
  })

  afterEach(() => {
    cleanup()
  })

  it('システムタブでまとめて既読にしても他分類の未読数を 0 にせず、連打で二重送信しない', async () => {
    fx.query = 'category=system'
    const pendingAll = deferred<{ success: true }>()
    fx.markAllRead.mockReturnValue(pendingAll.promise)
    fx.list.mockResolvedValue({
      success: true,
      data: {
        items: [makeItem('sys-1', 'error', 'システム異常1', false, '2026-11-28T01:00:00Z')],
        counts: { all: 4, error: 1, update: 3, unread: 3 },
        unreadCount: 3,
      },
    })

    render(<NotificationsV8 />)
    expect(await screen.findByText('システム異常1')).toBeTruthy()

    const btn = screen.getByRole('button', { name: 'この分類をすべて既読にする' })
    fireEvent.click(btn)
    fireEvent.click(btn)

    await waitFor(() => expect(fx.markAllRead).toHaveBeenCalledTimes(1))
    expect(fx.markAllRead).toHaveBeenCalledWith('account-a', 'error')
    expect(screen.getByRole('tab', { name: '未読 2' })).toBeTruthy()
    expect(screen.queryByText('未読の通知はありません。')).toBeNull()

    await act(async () => { pendingAll.resolve({ success: true }) })
  })

  it('さらに読み込むで重複IDが返っても同じ通知行を二重表示しない', async () => {
    const firstItem = makeItem('n-1', 'update', '最初の通知', false, '2026-11-28T02:00:00Z')
    const secondItem = makeItem('n-2', 'update', '2件目の通知', true, '2026-11-28T01:00:00Z')
    fx.list
      .mockResolvedValueOnce({
        success: true,
        data: {
          items: [firstItem],
          counts: { all: 2, error: 0, update: 2, unread: 1 },
          unreadCount: 1,
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          items: [firstItem, secondItem],
          counts: { all: 2, error: 0, update: 2, unread: 1 },
          unreadCount: 1,
        },
      })

    render(<NotificationsV8 />)
    expect(await screen.findByText('最初の通知')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /さらに読み込む/ }))
    expect(await screen.findByText('2件目の通知')).toBeTruthy()
    expect(screen.getAllByText('最初の通知')).toHaveLength(1)
  })

  it('同じ未読行を連打しても既読APIを1回だけ呼び未読数を二重に減らさない', async () => {
    const pendingRead = deferred<{ success: true }>()
    fx.markRead.mockReturnValue(pendingRead.promise)
    fx.list.mockResolvedValue({
      success: true,
      data: {
        items: [
          makeItem('n-1', 'update', '未読1', false, '2026-11-28T02:00:00Z'),
          makeItem('n-2', 'update', '未読2', false, '2026-11-28T01:00:00Z'),
        ],
        counts: { all: 2, error: 0, update: 2, unread: 2 },
        unreadCount: 2,
      },
    })

    render(<NotificationsV8 />)
    const rowLink = (await screen.findByText('未読1')).closest('a')!
    fireEvent.click(rowLink)
    fireEvent.click(rowLink)

    await waitFor(() => expect(fx.markRead).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('tab', { name: '未読 1' })).toBeTruthy()

    await act(async () => { pendingRead.resolve({ success: true }) })
  })
})
