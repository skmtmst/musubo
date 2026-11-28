// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { clearFeatureSettingsCache } from '@/lib/feature-settings-cache'
import { useFeatureSettings } from './use-feature-settings'
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/settings' }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc-a', loading: false }) }))
vi.mock('@/hooks/use-account-style', () => ({ useAccountStyle: () => ({ status: 'ready', data: { style: 'standard', styleSelected: true, version: 1, answers: {} } }) }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); clearFeatureSettingsCache() })
it('壊れた並び順は読み込み失敗にし、正しい値を読み直せる', async () => {
  clearFeatureSettingsCache()
  let order: unknown = { dashboard: [null] }
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input)
    const data = url.includes('/api/analytics/usage') ? { categories: [], features: [] } : { features: {}, sidebarItemOrder: order, version: 1 }
    return new Response(JSON.stringify({ success: true, data }), { headers: { 'Content-Type': 'application/json' } })
  })
  function Screen() {
    const state = useFeatureSettings()
    return <div>{state.loading ? '読込中' : state.loadFailed ? <button onClick={() => void state.load()}>再読み込み</button> : '設定を表示'}</div>
  }
  render(<Screen />)
  expect(await screen.findByRole('button', { name: '再読み込み' })).toBeTruthy()
  order = null
  fireEvent.click(screen.getByRole('button', { name: '再読み込み' }))
  await waitFor(() => expect(screen.getByText('設定を表示')).toBeTruthy())
})
