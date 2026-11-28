// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'

const fixture = vi.hoisted(() => ({ push: vi.fn(), account: 'account-a', create: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: fixture.push, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }), usePathname: () => '/inflow-links/new', useSearchParams: () => new URLSearchParams('name=見本&ref=sample') }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fixture.account, selectedAccount: { id: fixture.account, name: '見本' }, accounts: [], loading: false }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/pools-availability', () => ({ isPoolsFeatureAvailable: async () => false }))
vi.mock('../coupon-settings', () => ({ default: () => null }))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  const list = vi.fn().mockResolvedValue({ success: true, data: [] })
  return { ...actual, api: { ...actual.api, tags: { ...actual.api.tags, list }, scenarios: { ...actual.api.scenarios, list }, templates: { ...actual.api.templates, list }, tagGroups: { ...actual.api.tagGroups, list }, entryRouteGenres: { ...actual.api.entryRouteGenres, list }, entryRoutes: { ...actual.api.entryRoutes, create: fixture.create } } }
})
import InflowCreate from './create'
beforeEach(() => { fixture.account = 'account-a'; fixture.create.mockReset(); fixture.push.mockReset() })
afterEach(() => { cleanup(); clearToastsForTest() })

it('流入リンクを発行できたら完了を知らせる', async () => {
  fixture.create.mockResolvedValueOnce({ success: true, data: { id: 'sample-id' } })
  render(<><InflowCreate /><ToastHost /></>)
  const save = await screen.findByRole('button', { name: /発行して URL を受け取る/ })
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false))
  await act(async () => { fireEvent.click(save) })
  expect(await screen.findByText('流入リンクを発行しました。')).toBeTruthy()
  expect(fixture.push).toHaveBeenCalledWith('/inflow-links?highlight=sample-id')
})

it('発行に失敗したら完了を知らせず画面に残る', async () => {
  fixture.create.mockResolvedValueOnce({ success: false, error: '発行できませんでした' })
  render(<><InflowCreate /><ToastHost /></>)
  const save = await screen.findByRole('button', { name: /発行して URL を受け取る/ })
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false))
  await act(async () => { fireEvent.click(save) })
  expect(screen.queryByText('流入リンクを発行しました。')).toBeNull()
  expect(fixture.push).not.toHaveBeenCalled()
  expect(screen.getByDisplayValue('見本')).toBeTruthy()
})

it('アカウント切替後は前の発行結果で知らせたり移動したりしない', async () => {
  let complete!: (value: unknown) => void
  fixture.create.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
  const view = render(<><InflowCreate /><ToastHost /></>)
  const save = await screen.findByRole('button', { name: /発行して URL を受け取る/ })
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(save)
  expect(fixture.create).toHaveBeenCalledOnce()
  fixture.account = 'account-b'
  view.rerender(<><InflowCreate /><ToastHost /></>)
  await act(async () => { complete({ success: true, data: { id: 'sample-id' } }) })
  expect(screen.queryByText('流入リンクを発行しました。')).toBeNull()
  expect(fixture.push).not.toHaveBeenCalled()
})
