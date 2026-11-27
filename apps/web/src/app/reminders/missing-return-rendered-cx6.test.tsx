// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({ query: '', get: vi.fn(), editor: vi.fn(), fetch: vi.fn(), routeGet: vi.fn(), reminder: vi.fn() }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), useSearchParams: () => new URLSearchParams(fx.query) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-a', accounts: [], loading: false }) }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner', canManageRole: () => true }))
vi.mock('@/lib/pools-availability', () => ({ isPoolsFeatureAvailable: vi.fn().mockResolvedValue(false) }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, fetchApi: fx.fetch, webinarApi: { ...actual.webinarApi, get: fx.get, editor: fx.editor }, api: { ...actual.api, reminders: { ...actual.api.reminders, getDraft: fx.reminder }, entryRoutes: { ...actual.api.entryRoutes, list: vi.fn().mockResolvedValue({ success: true, data: [] }), get: fx.routeGet, funnel: vi.fn().mockResolvedValue({ success: false }) } } }
})
import { ApiError } from '@/lib/api'
import ReminderPage from '@/app/reminders/edit/page'
import WebinarPage from '@/app/webinars/edit/page'
import ResponsesPage from '@/app/form-submissions/responses/page'
import InflowPage from '@/app/inflow-links/detail/page'

beforeEach(() => {
  fx.query = ''
  fx.get.mockRejectedValue(new ApiError(404, 'not found'))
  fx.editor.mockRejectedValue(new ApiError(404, 'not found'))
  fx.fetch.mockRejectedValue(new ApiError(404, 'not found'))
  fx.routeGet.mockRejectedValue(new ApiError(404, 'not found'))
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('リマインダが未指定なら一覧に戻れ、対象の取得をしない', async () => {
  render(<ReminderPage />)
  expect(await screen.findByText('編集するリマインダが指定されていません')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'リマインダ一覧へ戻る' }).getAttribute('href')).toBe('/reminders')
  expect(fx.reminder).not.toHaveBeenCalled()
})

it('ウェビナーの未指定と見つからない場合に一覧へ戻れる', async () => {
  const view = render(<WebinarPage />)
  expect(await screen.findByText('編集するウェビナーが指定されていません')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'ウェビナー一覧へ戻る' }).getAttribute('href')).toBe('/webinars')
  expect(fx.get).not.toHaveBeenCalled()
  expect(fx.editor).not.toHaveBeenCalled()
  view.unmount()
  fx.query = 'id=missing'
  render(<WebinarPage />)
  expect(await screen.findByText('このウェビナーは見つかりません')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'ウェビナー一覧へ戻る' }).getAttribute('href')).toBe('/webinars')
  expect(fx.get).toHaveBeenCalledWith('missing')
})

it('回答フォームの未指定と見つからない場合に一覧へ戻れる', async () => {
  const view = render(<ResponsesPage />)
  expect(await screen.findByText('見る回答フォームが指定されていません')).toBeTruthy()
  expect(screen.getByRole('link', { name: '回答フォーム一覧へ戻る' }).getAttribute('href')).toBe('/form-submissions')
  expect(fx.fetch).not.toHaveBeenCalled()
  view.unmount()
  fx.query = 'id=missing'
  render(<ResponsesPage />)
  expect(await screen.findByText('この回答フォームは見つかりません')).toBeTruthy()
  expect(screen.getByRole('link', { name: '回答フォーム一覧へ戻る' }).getAttribute('href')).toBe('/form-submissions')
})

it('回答を見る権限がない場合も一覧へ戻れる', async () => {
  fx.query = 'id=forbidden'
  fx.fetch.mockRejectedValue(new ApiError(403, 'forbidden'))
  render(<ResponsesPage />)
  expect(await screen.findByText('集まった回答を見る権限がありません')).toBeTruthy()
  expect(screen.getByRole('link', { name: '回答フォーム一覧へ戻る' }).getAttribute('href')).toBe('/form-submissions')
})

it('流入経路の未指定と見つからない場合に一覧へ戻れる', async () => {
  const view = render(<InflowPage />)
  expect(await screen.findByText('見る流入経路が指定されていません')).toBeTruthy()
  expect(screen.getByRole('link', { name: '流入経路の一覧へ戻る' }).getAttribute('href')).toBe('/inflow-links')
  view.unmount()
  fx.query = 'id=missing'
  render(<InflowPage />)
  expect(await screen.findByText('この流入経路は見つかりません')).toBeTruthy()
  expect(screen.getByRole('link', { name: '流入経路の一覧へ戻る' }).getAttribute('href')).toBe('/inflow-links')
})
