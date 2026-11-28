// @vitest-environment happy-dom
/*
 * 監査 WEB075（画面側）：友だちのマイル明細は最新100件だけ読んでいる。全件より少ないとき、
 * 「今月たまった」を一部から数えて出さず、ページ送りの件数にも一部だと書く。
 */
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: () => {} }),
  useSearchParams: () => new URLSearchParams('id=f1'),
  usePathname: () => '/mileage/friend',
}))
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc', loading: false }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined, usePageCrumbs: () => undefined }))

const calls = vi.hoisted(() => ({ legacy: vi.fn(), history: vi.fn() }))
const today = '2026-10-15T03:00:00.000Z'
let rank: string | null = null
let rankLoaded = false
let source: 'ec' | 'musubo' = 'musubo'
let sourceUnavailable = false
let pendingBalance = 0
let historyCount = 340
let connections: Array<{ accountId: string; accountName: string }> | undefined
beforeEach(() => { calls.legacy.mockClear(); calls.history.mockClear(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(today)); rank = null; rankLoaded = false; source = 'musubo'; sourceUnavailable = false; connections = undefined; pendingBalance = 0; historyCount = 340 })
const entry = (id: string) => ({
  id, entryType: 'grant', status: 'available', amount: 10, reason: '来店', source: 'rule', hasSourceEvent: false,
  sourceReferenceId: null, ruleName: null, mode: 'automatic', executedByStaffName: null, lineAccountId: 'acc',
  notificationStatus: null, notificationErrorCode: null, balanceAfter: 10, occurredAt: today, displayName: '田中',
})
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      friends: {
        ...actual.api.friends,
        get: async () => ({ success: true, data: { id: 'f1', displayName: '田中', createdAt: '2026-01-01T00:00:00Z' } }),
        mileage: async () => { calls.legacy(); return { success: true, data: { summary: { available: 0, pending: pendingBalance, lifetimeEarned: 0, spent: 0 }, history: [], insights: null, connections } } },
      },
      staff: { ...actual.api.staff, me: async () => ({ success: true, data: { role: 'staff' } }) },
      mileage: {
        ...actual.api.mileage,
        friendsV6: async () => sourceUnavailable ? ({ success: false, error: 'source' }) : rankLoaded ? ({ success: true, data: { balanceSource: source, items: [{ friendId: 'f1', rank, rankReason: 'ランクは未公開です', available: source === 'ec' ? 29 : 0, pending: pendingBalance, monthChange: 0 } ] } }) : ({ success: true, data: { balanceSource: 'musubo', items: [] } }),
        history: async () => { calls.history(); return { success: true, data: { items: Array.from({ length: 100 }, (_, i) => entry(`e${i}`)), summary: { byType: [] }, pagination: { total: historyCount, limit: 100, offset: 0 } } } },
      },
    },
  }
})

import FriendDetailV8 from './friend-detail'
afterEach(() => { cleanup(); vi.useRealTimers() })

test('最新100件より多いとき、今月の数は「数えられません」、件数は一部と書く', async () => {
  render(<FriendDetailV8 />)
  await screen.findByText('最新100 件だけでは数えられません')
  expect(screen.getByText(/最新100件（全340件）のうち/)).toBeTruthy()
})

test('未公開のランクを最高到達にせず、未取得の接続先と付与回数を0にしない', async () => {
  rankLoaded = true
  render(<FriendDetailV8 />)
  expect((await screen.findByRole('link', { name: '使い道・ランクを作る', exact: true })).getAttribute('href')).toBe('/mileage?tab=rewards')
  expect(screen.getByTitle('ランクは未公開です')).toBeTruthy()
  expect(screen.queryByTitle(/いちばん上のランクです/)).toBeNull()
  expect(screen.getByTitle('接続先を確認できませんでした')).toBeTruthy()
  expect(screen.getByTitle('付与記録の回数は未取得')).toBeTruthy()
})

test('最高ランクと接続先0件を区別し、接続先の同じアカウントは1回表示する', async () => {
  rankLoaded = true
  rank = 'gold'
  connections = []
  const view = render(<FriendDetailV8 />)
  await screen.findByTitle(/いちばん上のランクです/)
  expect(screen.getByRole('link', { name: '使い道を見る', exact: true }).getAttribute('href')).toBe('/mileage?tab=rewards')
  expect(screen.getByTitle('接続先はありません')).toBeTruthy()
  expect(screen.queryByText('使い道・ランクを作る')).toBeNull()
  view.unmount()
  connections = [{ accountId: 'a', accountName: '本店' }, { accountId: 'a', accountName: '本店' }]
  render(<FriendDetailV8 />)
  expect(await screen.findByTitle('本人確認済みの接続先：本店')).toBeTruthy()
})

test('待ち残高があるとき明細0件を待ちなしと言わない', async () => {
  pendingBalance = 120
  historyCount = 100
  render(<FriendDetailV8 />)
  await screen.findByText('確定待ちの残高があります。明細を確認してください')
  expect(screen.queryByText('確定待ちはありません')).toBeNull()
})

test('一部取得した明細の0件は取得範囲を示す', async () => {
  pendingBalance = 120
  render(<FriendDetailV8 />)
  await screen.findByText('最新100 件のうち 0 件が確定待ち')
  expect(screen.queryByText('確定待ちはありません')).toBeNull()
})

test('ECが正の友だちはEC残高を表示し、musuboの調整を出さない', async () => {
  source = 'ec'; rankLoaded = true; rank = 'プラチナ'
  render(<FriendDetailV8 />)
  expect(await screen.findByText('ECと同期')).toBeTruthy()
  expect(screen.getByText('29')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /増やす|減らす/ })).toBeNull()
  expect(calls.legacy).not.toHaveBeenCalled()
  expect(calls.history).not.toHaveBeenCalled()
})

test('設定元を確認できないときにmusubo残高へ黙って戻さない', async () => {
  sourceUnavailable = true
  render(<FriendDetailV8 />)
  expect(await screen.findByText('マイル明細を読み込めませんでした')).toBeTruthy()
  expect(screen.queryByText('使える残高')).toBeNull()
})
