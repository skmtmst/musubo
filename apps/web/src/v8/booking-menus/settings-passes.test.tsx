// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ query: 'tab=passes', replace: vi.fn(), list: vi.fn(), canEdit: true }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: state.replace }), useSearchParams: () => new URLSearchParams(state.query), usePathname: () => '/booking/menus' }))
vi.mock('@/lib/use-same-page-url', () => ({ useSamePageUrl: () => ({ replace: state.replace, push: vi.fn() }) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccount: null }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('./lib/edit-permission', () => ({ useBookingEdit: () => state.canEdit }))
vi.mock('@/lib/api/helpers/gap3', () => ({ bookingPassPlansApi: { list: state.list, holders: async () => ({ success: true, data: { total: 0, items: [] } }) } }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, staff: { ...actual.api.staff, list: async () => ({ success: true, data: [] }) } }, bookingApi: { ...actual.bookingApi, listMenus: async () => ({ menus: [] }), getSettings: async () => ({ settings: null }), listStaff: async () => ({ staff: [] }) } }
})
import Settings from './settings'
beforeEach(() => {
  state.replace.mockClear()
  state.canEdit = true
  state.list.mockResolvedValue({ success: true, data: { items: [], total: 0, summary: { onSale: 0, holders: 0, expiringIn30d: 0, billingFailed: 0 } } })
})
afterEach(cleanup)
it.each(['passes', 'tickets'])('%s で同じ回数券・月謝の商品一覧と案内が開く', async tab => {
  state.query = `tab=${tab}&keep=1`
  render(<Settings accountId="a" />)
  expect(screen.getAllByRole('tab', { name: '回数券・月謝' })).toHaveLength(1)
  expect(screen.getByRole('tab', { name: '回数券・月謝' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('tab', { name: 'お支払い' })).toBeTruthy()
  expect(await screen.findByText('まだ回数券・月謝がありません')).toBeTruthy()
  expect(screen.getByText(/回数券・月謝は、お客さまごとに入れます（/).textContent).toContain('友だちの詳細の「予約」タブから')
  expect(screen.getByText(/回数券や月謝を作ると/).textContent).toContain('紙の回数券の引き継ぎ')
  expect(screen.getAllByRole('link', { name: '回数券・月謝を作る' }).length).toBeGreaterThan(0)
  expect(screen.queryByRole('button', { name: 'LINEでの見え方を見る' })).toBeNull()
  if (tab === 'tickets') await waitFor(() => expect(state.replace).toHaveBeenCalledWith('?tab=passes&keep=1'))
  else expect(state.replace).not.toHaveBeenCalled()
})


it('閲覧のみでは回数券の作成入口を止める', async () => {
  state.query = 'tab=passes'
  state.canEdit = false
  render(<Settings accountId="a" />)
  await screen.findByText('まだ回数券・月謝がありません')
  const buttons = screen.getAllByRole('button', { name: '回数券・月謝を作る' }) as HTMLButtonElement[]
  expect(buttons).toHaveLength(2)
  for (const b of buttons) {
    expect(b.disabled || b.getAttribute('aria-disabled') === 'true').toBe(true)
    expect(b.getAttribute('href')).toBeNull()
  }
})
