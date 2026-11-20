// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({ capStatus: vi.fn(), create: vi.fn(), list: vi.fn(), update: vi.fn(), toast: vi.fn(), folders: vi.fn(async () => ({ success: true, data: [
  { id: 'folder-a', kind: 'affiliate_offer', name: '紹介', color: '#16a34a', parentId: null, displayOrder: 0 },
  { id: 'folder-b', kind: 'affiliate_offer', name: '資料', color: '#2563eb', parentId: null, displayOrder: 1 },
], unfiledCount: 0 })), approvalsFull: false }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      affiliateOffers: {
        ...actual.api.affiliateOffers,
        capStatus: (...args: unknown[]) => net.capStatus(...args),
        create: (...args: unknown[]) => net.create(...args),
        list: net.list, update: net.update,
      },
      folders: { ...actual.api.folders, list: () => net.folders() },
      affiliates: { ...actual.api.affiliates, allReport: async () => ({ success: true, data: [] }) },
      conversionApprovals: {
        ...actual.api.conversionApprovals,
        list: async () => ({
          success: true,
          data: net.approvalsFull
            ? Array.from({ length: 200 }, (_, i) => ({ eventId: `e${i}`, affiliateId: 'af', offerId: 'of-1', friendId: `f${i}`, value: 100, status: 'approved', createdAt: new Date().toISOString() }))
            : [],
        }),
      },
      lineAccounts: { ...actual.api.lineAccounts, list: async () => ({ success: true, data: [] }) },
      tags: { ...actual.api.tags, list: async () => ({ success: true, data: [] }) },
      scenarios: { ...actual.api.scenarios, list: async () => ({ success: true, data: [] }) },
    },
  }
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/affiliates',
}))
vi.mock('@/components/shared/toast', () => ({ notifyToast: net.toast, notifySaved: net.toast }))

import OffersTab from './offers'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-18T00:00:00Z'))
  net.list.mockReset().mockResolvedValue({ success: true, data: [{ id: 'of-1', name: '紹介A', folderId: 'folder-a', description: null, rewardAmount: 1000, rewardMiles: 0, lineAccountId: null, tagId: null, scenarioId: null, isActive: true, createdAt: '2026-10-01T00:00:00Z' }] })
  net.update.mockReset()
  net.toast.mockReset()
})
afterEach(() => { cleanup(); vi.useRealTimers() })

it('公開停止を先に表示し、失敗すると戻し、成功しても一覧を読み直さない', async () => {
  let reject!: (reason: Error) => void
  net.update.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail })).mockResolvedValueOnce({ success: true })
  render(<OffersTab />)
  const menu = await screen.findByRole('button', { name: '紹介Aの操作' })
  const row = menu.closest('tr')!
  expect(row.textContent).toContain('公開中')
  fireEvent.click(menu)
  fireEvent.click(await screen.findByRole('menuitem', { name: '公開を止める' }))
  expect(net.update).toHaveBeenCalledWith('of-1', { isActive: false })
  expect(row.textContent).toContain('下書き')
  await act(async () => reject(new Error('offline')))
  await waitFor(() => expect(row.textContent).toContain('公開中'))
  expect(net.toast).toHaveBeenCalledWith(expect.stringContaining('元に戻しました'), expect.objectContaining({ tone: 'error' }))
  fireEvent.click(within(row).getByRole('button', { name: '紹介Aの操作' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '公開を止める' }))
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)) })
  expect(net.update).toHaveBeenCalledTimes(2)
  expect(row.textContent).toContain('下書き')
  expect(net.list).toHaveBeenCalledTimes(1)
})
