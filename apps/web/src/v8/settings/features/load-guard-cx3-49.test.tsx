// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const net = vi.hoisted(() => ({ load: vi.fn(), usage: vi.fn() }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/hooks/use-account-style', () => ({ useAccountStyle: () => ({ status: 'ready', data: { style: 'standard', styleSelected: true } }) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'A' }) }))
vi.mock('@/lib/feature-settings-cache', () => ({ loadFeatureSettings: net.load, clearFeatureSettingsCache: vi.fn() }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, analytics: { ...actual.api.analytics, usageOverview: net.usage } } }
})
import { useFeatureSettings } from './use-feature-settings'
function Screen() {
  const settings = useFeatureSettings()
  if (settings.loading) return <p>読み込み中</p>
  if (settings.loadFailed) return <><p>設定を確認できません</p><button onClick={() => void settings.load()}>読み直す</button></>
  return <p>設定を表示中</p>
}
beforeEach(() => {
  vi.resetAllMocks()
  net.usage.mockResolvedValue({ success: true, data: { data: { categories: [], features: [] } } })
})
afterEach(cleanup)
it.each([
  ['設定全体が配列', []],
  ['機能の状態が文字', { scenarios: 'true' }],
])('%sの場合は設定を確定せず、読み直せる', async (_label, features) => {
  net.load.mockResolvedValueOnce({ success: true, data: { features, sidebarItemOrder: {}, version: 3 } })
    .mockResolvedValueOnce({ success: true, data: { features: { scenarios: false }, sidebarItemOrder: {}, version: 3 } })
  render(<Screen />)
  expect(await screen.findByText('設定を確認できません')).toBeTruthy()
  expect(screen.queryByText('設定を表示中')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '読み直す' }))
  expect(await screen.findByText('設定を表示中')).toBeTruthy()
})
