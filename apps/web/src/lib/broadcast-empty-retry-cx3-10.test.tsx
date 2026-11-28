// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'

const net = vi.hoisted(() => ({ list: vi.fn(), folders: vi.fn(), views: vi.fn() }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, broadcasts: { ...actual.api.broadcasts, list: net.list, savedViews: { ...actual.api.broadcasts.savedViews, list: net.views } }, folders: { ...actual.api.folders, list: net.folders }, tags: { ...actual.api.tags, list: vi.fn(async () => ({ success: true, data: [] })) }, scenarios: { ...actual.api.scenarios, list: vi.fn(async () => ({ success: true, data: [] })) }, dashboard: { ...actual.api.dashboard, overview: vi.fn(async () => ({ success: true, data: { delivery: { quotaLimit: 100, quotaUsed: 0 } } })) } } }
})
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }), useSearchParams: () => new URLSearchParams('') }))
vi.mock('@/contexts/account-context', () => ({ useOptionalAccount: () => ({ selectedAccountId: 'account-a' }), useAccount: () => ({ selectedAccountId: 'account-a', accounts: [{ id: 'account-a', name: '本店' }], loading: false }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
vi.mock('@/lib/line-accounts-cache', async original => ({ ...await original<typeof import('@/lib/line-accounts-cache')>(), loadLineAccounts: vi.fn(async () => ({ success: true, data: [{ id: 'account-a', name: '本店' }] })) }))
import BroadcastListV8 from '@/v8/broadcasts/list'

beforeEach(() => {
  verifiedStaffRole('owner'); forgetSessionSnapshot()
  window.history.replaceState(null, '', '/broadcasts')
  net.list.mockReset().mockRejectedValueOnce(new Error('failed')).mockResolvedValue({ success: true, data: [], pagination: { total: 0, limit: 20, offset: 0 } })
  net.folders.mockResolvedValue({ success: true, data: [], unfiledCount: 0 })
  net.views.mockResolvedValue({ success: true, data: [] })
})
afterEach(() => { cleanup(); forgetStaffIdentity(); forgetSessionSnapshot() })

it('配信一覧の失敗後、読み直しに成功して0件なら空の案内に切り替える', async () => {
  render(<BroadcastListV8 />)
  const retry = await screen.findByRole('button', { name: 'もう一度読み込む' })
  expect(screen.queryByText('まだ一斉配信がありません')).toBeNull()
  fireEvent.click(retry)
  await screen.findByText('まだ一斉配信がありません')
  await waitFor(() => expect(screen.queryByRole('button', { name: 'もう一度読み込む' })).toBeNull())
  expect(net.list).toHaveBeenCalledTimes(2)
})
