// @vitest-environment happy-dom
import React, { act } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'

const fixture = vi.hoisted(() => ({ path: '/friends', lookup: vi.fn(), topBar: vi.fn() }))
vi.mock('next/navigation', () => ({ usePathname: () => fixture.path, useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => <a href={href} {...props}>{children}</a> }))
vi.mock('@/components/auth-guard', () => ({ useOnboardingAccess: () => false }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ accounts: [], selectedAccountId: null, setSelectedAccountId: vi.fn(), clearSelectedAccountId: vi.fn(), loading: false, error: null, refreshing: false, refreshAccounts: vi.fn() }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageChrome: () => ({ title: null, crumbs: null }) }))
vi.mock('@/lib/use-brand', () => ({ useBrand: () => ({ name: 'お店', iconUrl: null }) }))
vi.mock('@/components/shared/top-bar', () => ({ default: (props: { manualHref?: string | null }) => { fixture.topBar(props); return null } }))
vi.mock('@/components/shell/notification-center-data', () => ({ loadNotificationCenter: vi.fn(async () => null) }))
import AppTopBar from '@/components/shell/app-top-bar'

beforeEach(() => {
  fixture.path = '/friends'
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })))
  fixture.lookup.mockReset()
  fixture.topBar.mockReset()
  vi.spyOn(api.manualLinks, 'lookup').mockImplementation(fixture.lookup)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

// 画面内ボタンと同じ仕組みにするため、参照は useManualHref へまとめた。
// ここでは上の帯への受け渡しと正本表の取得を確かめる。
it('現在の画面IDで正本表を読み、登録されたマニュアルのURLを上の帯へ渡す', async () => {
  fixture.lookup.mockResolvedValue({ success: true, data: { url: 'https://example.com/manual' } })
  render(<AppTopBar />)
  await waitFor(() => expect(fixture.topBar).toHaveBeenLastCalledWith(expect.objectContaining({ manualHref: 'https://example.com/manual' })))
  expect(fixture.lookup).toHaveBeenCalledWith('3-1')
})

it.each(['failed', 'unregistered', 'unknown'])('%s の場合はマニュアルのURLを渡さない', async (state) => {
  if (state === 'unknown') fixture.path = '/not-a-real-page'
  if (state === 'failed') fixture.lookup.mockRejectedValue(new Error('failed'))
  if (state === 'unregistered') fixture.lookup.mockResolvedValue({ success: false })
  render(<AppTopBar />)
  if (state === 'unknown') {
    await waitFor(() => expect(fixture.lookup).not.toHaveBeenCalled())
  } else {
    await waitFor(() => expect(fixture.lookup).toHaveBeenCalledWith('3-1'))
  }
  await act(async () => { await Promise.resolve() })
  expect(fixture.topBar).toHaveBeenLastCalledWith(expect.objectContaining({ manualHref: null }))
})
