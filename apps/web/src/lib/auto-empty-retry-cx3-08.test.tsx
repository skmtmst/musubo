// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'

const net = vi.hoisted(() => ({ list: vi.fn(), templates: vi.fn(), summary: vi.fn(), folders: vi.fn() }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, autoReplies: { ...actual.api.autoReplies, list: net.list, summary: net.summary }, templates: { ...actual.api.templates, list: net.templates }, folders: { ...actual.api.folders, list: net.folders } } }
})
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }), useSearchParams: () => new URLSearchParams('') }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-a', accounts: [{ id: 'account-a', name: '本店' }], loading: false }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner', canManageRole: () => true }))
import AutoRepliesListV8 from '@/v8/auto-replies/list'

beforeEach(() => {
  verifiedStaffRole('owner'); forgetSessionSnapshot()
  window.history.replaceState(null, '', '/auto-replies')
  net.list.mockReset().mockResolvedValueOnce({ success: false, error: '通信に失敗しました' }).mockResolvedValue({ success: true, data: [] })
  net.templates.mockResolvedValue({ success: true, data: [] })
  net.summary.mockResolvedValue({ success: true, data: { conflictCount: 0, dispatchStopped: false } })
  net.folders.mockResolvedValue({ success: true, data: [], unfiledCount: 0 })
})
afterEach(() => { cleanup(); forgetStaffIdentity(); forgetSessionSnapshot() })

it('取得に失敗した後、読み直しに成功して0件なら空の案内に切り替える', async () => {
  render(<AutoRepliesListV8 />)
  const retry = await screen.findByRole('button', { name: 'もう一度読み込む' })
  expect(screen.queryByText('まだ自動応答のルールはありません')).toBeNull()
  fireEvent.click(retry)
  await screen.findByText('まだ自動応答のルールはありません')
  await waitFor(() => expect(screen.queryByRole('button', { name: 'もう一度読み込む' })).toBeNull())
  expect(net.list).toHaveBeenCalledTimes(2)
})
