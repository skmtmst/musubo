// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushListUrlState } from '@/components/shared/list-url-state'

const net = vi.hoisted(() => ({ menus: vi.fn(), tab: 'menus', canEdit: true, withUrl: true }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams('tab=' + net.tab),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccount: { liffId: net.withUrl ? 'sample-liff' : null } }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('./lib/edit-permission', () => ({ useBookingEdit: () => net.canEdit }))
vi.mock('./tabs/hours-tab', () => ({ HoursTabV8: () => <p>受付枠の本文</p>, SlotCheckV8: () => null }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual,
    api: { ...actual.api, staff: { ...actual.api.staff, list: async () => ({ success: true, data: [] }) } },
    bookingApi: { ...actual.bookingApi,
      listMenus: net.menus,
      getSettings: async () => ({ success: true, data: { exceptions: [], businessHours: [], menuCount: 0 } }),
      listStaff: async () => ({ staff: [] }), listResources: async () => ({ resources: [] }),
      getAvailability: async () => ({ by_staff: [], closed_dates: [] }),
    },
  }
})
import Settings from './settings'

beforeEach(() => {
  flushListUrlState(); window.history.replaceState(null, '', '/')
  net.tab = 'menus'; net.canEdit = true; net.withUrl = true
  net.menus.mockReset().mockResolvedValue({ menus: [] })
})
afterEach(cleanup)
const content = (container: HTMLElement) => container.querySelector('[data-template-region="content"]')!
const lead = '上から並んだ順に、お客さまの画面に出ます。つまみで並べ替えます。'

it('アカウントのメニュー準備完了なら0件でも案内を保ち、プレビュー後の余白口を選ぶ', async () => {
  const { container } = render(<Settings accountId="account-a" />)
  await screen.findByText(lead)
  expect(content(container).getAttribute('data-content-spacing')).toBe('notice-after-preview')
  expect(screen.getByRole('button', { name: 'LINEでの見え方を見る' })).toBeTruthy()
  expect(screen.getAllByRole('link', { name: 'お客さまに見える画面を確かめる' }).length).toBeGreaterThan(0)
})
it('読込中・失敗の本文は既定の余白口のまま、準備できた時だけ切り替わる', async () => {
  let resolve!: (data: { menus: never[] }) => void
  net.menus.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  const { container } = render(<Settings accountId="account-a" />)
  expect(content(container).hasAttribute('data-content-spacing')).toBe(false)
  expect(screen.queryByText(lead)).toBeNull()
  await act(async () => { resolve({ menus: [] }) })
  await screen.findByText(lead)
  expect(content(container).getAttribute('data-content-spacing')).toBe('notice-after-preview')
  cleanup()
  net.menus.mockRejectedValueOnce(new Error('menu read failed'))
  const failed = render(<Settings accountId="account-a" />)
  await screen.findByText('予約設定を読み込めませんでした')
  expect(content(failed.container).hasAttribute('data-content-spacing')).toBe(false)
  expect(screen.queryByText(lead)).toBeNull()
})
it('未選択と他タブは新しい余白口を選ばない', async () => {
  const empty = render(<Settings accountId={null} />)
  expect(screen.getByText('LINEアカウントを選んでください')).toBeTruthy()
  expect(content(empty.container).hasAttribute('data-content-spacing')).toBe(false)
  cleanup(); net.tab = 'hours'
  const other = render(<Settings accountId="account-a" />)
  await screen.findByText('受付枠の本文')
  expect(content(other.container).hasAttribute('data-content-spacing')).toBe(false)
})
it('閲覧のみとプレビューURL無しでも、準備完了の案内と同じ余白口を保つ', async () => {
  net.canEdit = false; net.withUrl = false
  const { container } = render(<Settings accountId="account-a" />)
  await waitFor(() => expect(content(container).getAttribute('data-content-spacing')).toBe('notice-after-preview'))
  expect(screen.getByText('上から並んだ順に、お客さまの画面に出ます。')).toBeTruthy()
  expect(screen.queryByText(/つまみで並べ替えます/)).toBeNull()
  expect(screen.queryByRole('button', { name: /並び替える/ })).toBeNull()
  expect(screen.queryByRole('link', { name: '予約メニューを作る' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'お客さまに見える画面を確かめる' })).toBeNull()
})
