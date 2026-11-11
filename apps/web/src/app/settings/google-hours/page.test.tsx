// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  accountId: 'account-a',
  loading: false,
  connection: vi.fn(),
  replace: vi.fn(),
}))
const router = vi.hoisted(() => ({ replace: fixture.replace }))

vi.mock('next/navigation', () => ({ useRouter: () => router }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fixture.accountId, loading: fixture.loading }) }))
vi.mock('@/lib/restaurant-google-api', () => ({ restaurantGoogleApi: { connection: fixture.connection } }))
vi.mock('@/v8/restaurant/google/hours', () => ({ default: ({ accountId }: { accountId: string }) => <h1>Google営業時間：{accountId}</h1> }))

import Page from './page'

afterEach(cleanup)
beforeEach(() => { fixture.accountId = 'account-a'; fixture.loading = false; fixture.connection.mockReset(); fixture.replace.mockReset() })

it('接続済みのアカウントのGoogle営業時間を開く', async () => {
  fixture.connection.mockResolvedValue({ connection: { status: 'connected', locationName: 'locations/123' } })
  render(<Page />)
  expect(await screen.findByRole('heading', { name: 'Google営業時間：account-a' })).toBeTruthy()
  expect(fixture.connection).toHaveBeenCalledWith('account-a')
  expect(fixture.replace).not.toHaveBeenCalled()
})

it('未接続ならSNSのGoogle接続画面へ進む', async () => {
  fixture.connection.mockResolvedValue({ connection: { status: 'disconnected', locationName: null } })
  render(<Page />)
  await waitFor(() => expect(fixture.replace).toHaveBeenCalledWith('/settings/sns?source=hours'))
  expect(screen.queryByText('Google営業時間：account-a')).toBeNull()
})

it('アカウント切替中に前のアカウントの営業時間を表示しない', async () => {
  let resolveNext: (value: unknown) => void = () => {}
  fixture.connection.mockImplementation((accountId: string) => accountId === 'account-a'
    ? Promise.resolve({ connection: { status: 'connected', locationName: 'locations/123' } })
    : new Promise(resolve => { resolveNext = resolve }))
  const view = render(<Page />)
  expect(await screen.findByRole('heading', { name: 'Google営業時間：account-a' })).toBeTruthy()
  fixture.accountId = 'account-b'
  view.rerender(<Page />)
  expect(screen.queryByText('Google営業時間：account-a')).toBeNull()
  resolveNext({ connection: { status: 'connected', locationName: 'locations/456' } })
  expect(await screen.findByRole('heading', { name: 'Google営業時間：account-b' })).toBeTruthy()
})
