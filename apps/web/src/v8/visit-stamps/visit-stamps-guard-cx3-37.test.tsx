// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({
  accountId: 'acc-1',
  role: 'owner' as string | null,
  cards: vi.fn(), save: vi.fn(), create: vi.fn(), paperRequests: vi.fn(), reviewPaper: vi.fn(), wallet: vi.fn(), grant: vi.fn(), reverse: vi.fn(), setPin: vi.fn(),
  friendsList: vi.fn(), friendsGet: vi.fn(), staffList: vi.fn(), entries: vi.fn(), paperPhoto: vi.fn(),
  uploadImage: vi.fn(), replace: vi.fn(),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fx.accountId, accounts: [{ id: 'acc-1', name: '銀座店' }, { id: 'acc-2', name: '渋谷店' }] }) }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => fx.role, canManageRole: (r: string | null) => r === 'owner' || r === 'admin' }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {} }))
vi.mock('@/components/shared/toast', () => ({ ...(() => { const notifyToast = vi.fn(); return { notifyToast, notifySaved: notifyToast } })() }))
vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useRouter: () => ({ push: vi.fn(), replace: fx.replace, back: vi.fn() }),
    usePathname: () => '/visit-stamps',
    useSearchParams: () => {
      const search = useSyncExternalStore(
        listener => { window.addEventListener('popstate', listener); return () => window.removeEventListener('popstate', listener) },
        () => window.location.search,
      )
      return new URLSearchParams(search)
    },
  }
})
vi.mock('@/lib/visit-stamps-api', () => ({
  visitStampsApi: {
    storefrontQr:vi.fn(async()=>({success:true,data:null})),
    cards: fx.cards, save: fx.save, create: fx.create, paperRequests: fx.paperRequests, reviewPaper: fx.reviewPaper,
    wallet: fx.wallet, grant: fx.grant, reverse: fx.reverse, setPin: fx.setPin, entries: fx.entries, paperPhoto: fx.paperPhoto,
  },
}))
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { friends: { list: fx.friendsList, get: fx.friendsGet }, staff: { list: fx.staffList }, uploads: { image: fx.uploadImage } },
  describeSaveFailure: (e: unknown) => (e instanceof Error ? e.message : '保存できませんでした。'),
}))
import { flushListUrlState } from '@/components/shared/list-url-state'
import VisitStampsV8 from './visit-stamps'
import { notifyToast } from '@/components/shared/toast'

const card = {
  id: 'card-1', name: '然 来店スタンプカード', accountIds: ['acc-1'], active: true, version: 3, expectedVersion: 3,
  settings: {
    mode: 'visit' as const, amountUnit: 1000, maxPerVisit: 3, firstVisitBonus: 1, expiryMonths: 6, timezone: 'Asia/Tokyo',
    multipliers: [], rankMultipliers: [], rewards: [{ id: 'r1', name: 'ドリンク 1杯', stamps: 5 }, { id: 'r2', name: 'デザート 1品', stamps: 10 }],
  },
}

beforeEach(() => {
  fx.accountId = 'acc-1'
  flushListUrlState()
  window.history.replaceState(null, '', '/visit-stamps')
  fx.replace.mockImplementation((href: string) => {
    window.history.replaceState(null, '', href)
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  fx.role = verifiedStaffRole('owner')
  fx.uploadImage.mockResolvedValue({ success: true, data: { url: 'https://example.test/images/card.png' } })
  fx.cards.mockResolvedValue({ success: true, data: [card] })
  fx.save.mockResolvedValue({ success: true, data: card })
  fx.paperRequests.mockResolvedValue({ success: true, data: [{ id: 'p1', friend_id: 'f1', photo_url: '', stamps: 7, status: 'pending', created_at: '2026-01-12 11:14:00' }] })
  fx.reviewPaper.mockResolvedValue({ success: true, data: { id: 'p1', status: 'approved' } })
  fx.wallet.mockResolvedValue({ success: true, data: { wallet: { cardId: 'card-1', friendId: 'f1', balance: 3, earnedTotal: 3, expiresAt: null }, entries: [] } })
  fx.grant.mockResolvedValue({ success: true, data: {} })
  fx.friendsList.mockResolvedValue({ success: true, data: { items: [{ id: 'f1', displayName: 'みさき', metadata: { name: '見本 183' } }] } })
  fx.friendsGet.mockImplementation(async (id: string) => ({ success: true, data: { id, displayName: 'みさき' } }))
  fx.staffList.mockResolvedValue({ success: true, data: [{ id: 's1', name: '田村', role: 'staff' }] })
  fx.entries.mockResolvedValue({ success: true, data: { items: [
    { id: 'e1', cardId: 'card-1', friendId: 'f1', accountId: 'acc-1', kind: 'redeem', delta: -10, actorId: 's1', reason: 'デザート 1品', createdAt: '2026-01-13T09:10:00.000Z', originalId: null },
    { id: 'e2', cardId: 'card-1', friendId: 'f2', accountId: 'acc-1', kind: 'visit', delta: 1, actorId: null, reason: '', createdAt: '2026-01-12T03:05:00.000Z', originalId: null },
  ], total: 2, page: 1, pageSize: 5 } })
  fx.paperPhoto.mockResolvedValue(new Blob(['x'], { type: 'image/jpeg' }))
})
afterEach(() => { cleanup(); vi.clearAllMocks(); window.history.replaceState(null, '', '/') })

describe('不正なカード一覧', () => {
  it('失敗として表示し、再読み込みで正しいカードを表示する', async () => {
    fx.cards.mockResolvedValueOnce({ success: true, data: null }).mockResolvedValueOnce({ success: true, data: [card] })
    render(<VisitStampsV8 />)
    fireEvent.click(await screen.findByRole('button', { name: 'もう一度読み込む' }))
    expect(await screen.findByDisplayValue('然 来店スタンプカード')).toBeTruthy()
  })
})
