// @vitest-environment happy-dom
/*
 * V8 通知（src/v8/notifications）の動きの試験。BEHAVIOR.md の主な動きを守る。
 * 未読が先・新しい順／行の右の行き先の言葉（EC連携は EC連携へ）／押すと既読にして移る／
 * タブは「すべて・未読・システム」で「すべて 6」の1つの文字／未読が無いと「すべて既読にする」は押せない／
 * 閲覧のみには既読の操作を出さない／LINE の鍵の知らせはそのアカウントの設定へ。
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { NotificationCenterItem } from '@line-crm/shared'

const push = vi.fn()
const fx = vi.hoisted(() => ({ query: '', role: 'owner' as string | null }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(fx.query),
}))
vi.mock('@/lib/staff-role', async (original) => ({ ...(await original<object>()), useStaffRole: () => fx.role }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined, usePageCrumbs: () => undefined }))

const markRead = vi.fn(() => Promise.resolve({ success: true }))
const markAllRead = vi.fn(() => Promise.resolve({ success: true }))
let items: NotificationCenterItem[] = []
const list = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({
  api: {
    notifications: {
      center: {
        list: (...args: unknown[]) => { list(...args); return Promise.resolve({
          success: true,
          data: {
            items,
            counts: {
              all: items.length,
              error: items.filter((x) => x.category === 'error').length,
              update: items.filter((x) => x.category === 'update').length,
              unread: items.filter((x) => !x.isRead).length,
            },
            unreadCount: items.filter((x) => !x.isRead).length,
          },
        }) },
        markRead: (...args: unknown[]) => markRead(...(args as [])),
        markAllRead: (...args: unknown[]) => markAllRead(...(args as [])),
      },
    },
  },
}))

import NotificationsV8 from './list'

const item = (id: string, eventType: string, category: string, title: string, isRead: boolean, createdAt: string): NotificationCenterItem => ({
  id, eventType, category: category as NotificationCenterItem['category'], title, body: '', metadata: null, isRead, createdAt,
})

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  push.mockClear()
  markRead.mockClear()
  markAllRead.mockClear()
  list.mockClear()
  fx.query = ''
  fx.role = 'owner'
  // 口は作成日の新しい順で返す（既読が混ざっていても）。
  items = [
    item('n-read', 'visual_qa.update', 'update', '既読の新しい版', true, '2026-08-25T00:00:00.000Z'),
    item('n-hook', 'account_health_webhook_delay', 'error', 'Webhook の遅れ', false, '2026-08-21T09:32:00.000Z'),
    item('n-ec', 'ec.import_failed', 'error', 'EC連携の取り込みが失敗', false, '2026-08-21T00:15:00.000Z'),
    item('n-mt', 'maintenance.scheduled', 'update', 'メンテナンス予定', true, '2026-08-12T00:00:00.000Z'),
  ]
})
afterEach(() => cleanup())

describe('V8 通知', () => {
  test('統括からの通知は更新履歴と運用状態に戻り先を引き継ぐ', async () => {
    fx.query = 'from=hq'
    render(<NotificationsV8 />)
    const update = await screen.findByText('既読の新しい版')
    expect(update.closest('a')?.getAttribute('href')).toBe('/updates?from=hq')
    expect(screen.getByText('Webhook の遅れ').closest('a')?.getAttribute('href')).toBe('/emergency?from=hq')
    expect(screen.getByText('EC連携の取り込みが失敗').closest('a')?.getAttribute('href')).toBe('/ec-commerce')
  })

  test('未読が先・新しい順。右の言葉は行き先どおり', async () => {
    render(<NotificationsV8 />)
    await screen.findByText('Webhook の遅れ')
    const rows = screen.getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Webhook の遅れ'),
      expect.stringContaining('EC連携の取り込みが失敗'),
      expect.stringContaining('既読の新しい版'),
      expect.stringContaining('メンテナンス予定'),
    ])
    expect(within(rows[0]).getByText('運用状態を開く →')).toBeTruthy()
    expect(within(rows[1]).getByText('EC連携を開く →')).toBeTruthy()
    expect(within(rows[2]).getByText('更新履歴を見る →')).toBeTruthy()
    expect(within(rows[3]).getByText('詳細を見る →')).toBeTruthy()
  })

  test('タブは「すべて・未読・システム」で「すべて 4」の1つの文字。アップデートのタブは無い', async () => {
    render(<NotificationsV8 />)
    expect(await screen.findByRole('tab', { name: 'すべて 4' })).toBeTruthy()
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['すべて 4', '未読 2', 'システム 2'])
    expect(list).toHaveBeenLastCalledWith('account-a', { limit: 50, offset: 0 })
  })

  test.each([
    ['unread', { unread: true }, 'すべて既読にする', 'all'],
    ['system', { category: 'error' }, 'この分類をすべて既読にする', 'error'],
    // 前の URL の ?category=error はシステムとして読む。
    ['error', { category: 'error' }, 'この分類をすべて既読にする', 'error'],
  ])('?category=%s は口へ %o を送り、まとめて既読の範囲も合わせる', async (query, sent, label, scope) => {
    fx.query = `category=${query}`
    render(<NotificationsV8 />)
    await screen.findByText('Webhook の遅れ')
    expect(list).toHaveBeenLastCalledWith('account-a', { ...sent, limit: 50, offset: 0 })
    fireEvent.click(screen.getByRole('button', { name: label }))
    await waitFor(() => expect(markAllRead).toHaveBeenCalledWith('account-a', scope))
  })

  test.each(['viewer', null])('権限が %s の間は既読の操作を出さず、押しても既読にしない', async (role) => {
    fx.role = role
    render(<NotificationsV8 />)
    const title = await screen.findByText('Webhook の遅れ')
    expect(screen.queryByRole('button', { name: /すべて既読にする/ })).toBeNull()
    fireEvent.click(title.closest('a')!)
    expect(markRead).not.toHaveBeenCalled()
  })

  test.each([
    ['owner', '更新する →'],
    ['viewer', 'アカウントを見る →'],
  ])('LINE の鍵の知らせはそのアカウントの設定へ。権限 %s は %s', async (role, label) => {
    fx.role = role
    items = [item('n-token', 'line_token_refresh_failed', 'error', 'LINEの鍵を取り替えられません', false, '2026-08-25T00:00:00.000Z')]
    render(<NotificationsV8 />)
    const title = await screen.findByText('LINEの鍵を取り替えられません')
    expect(title.closest('a')?.getAttribute('href')).toBe('/accounts/detail?id=account-a')
    expect(within(title.closest('li')!).getByText(label)).toBeTruthy()
  })

  test('EC連携の通知を押すと既読にして EC連携へ移る', async () => {
    render(<NotificationsV8 />)
    const title = await screen.findByText('EC連携の取り込みが失敗')
    fireEvent.click(title.closest('a')!)
    expect(title.closest('a')?.getAttribute('href')).toBe('/ec-commerce')
    await waitFor(() => expect(markRead).toHaveBeenCalledWith('n-ec', 'account-a'))
  })

  test('未読が無いと「すべて既読にする」は押せず、注記が替わる', async () => {
    items = items.map((x) => ({ ...x, isRead: true }))
    render(<NotificationsV8 />)
    expect(await screen.findByText('未読の通知はありません。')).toBeTruthy()
    expect((screen.getByRole('button', { name: /すべて既読にする/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})

test.each(['owner', 'viewer', null])('未読の案内は権限 %s で実際の操作に合う', async role => {
  fx.role = role
  render(<NotificationsV8 />)
  await screen.findByText('Webhook の遅れ')
  expect(screen.getByText(/未読は青い点と太字/)).toBeTruthy()
  expect(Boolean(screen.queryByText(/押すと既読になり/))).toBe(role === 'owner')
  if (role !== 'owner') expect(screen.getByText(/押すと関係する画面へ移れます/)).toBeTruthy()
})
