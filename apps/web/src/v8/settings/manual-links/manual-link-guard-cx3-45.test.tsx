// @vitest-environment happy-dom
import React from 'react'
import { setImmediate } from 'node:timers'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import ManualLinksScreen from './screen'
import { useManualLinks } from './use-manual-links'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot, rememberSessionSnapshot } from '@/lib/session-snapshot'

const mocks = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn(), check: vi.fn(), readOnly: false, me: vi.fn(), roleBundle: undefined as string | undefined }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), usePathname: () => '/settings/manual-links' }))
vi.mock('@/components/layout/settings-inner-nav', () => ({ default: () => <nav>設定の目次</nav> }))
vi.mock('@/lib/api', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api')>()
  return { ...original, api: { ...original.api, staff: { ...original.api.staff, me: mocks.me }, manualLinks: { ...original.api.manualLinks, list: mocks.list, update: mocks.update, check: mocks.check } } }
})
const link = { key: '2-1', keyKind: 'screen', name: '受信箱', url: 'https://example.test/inbox', status: 'ok', lastCheckedAt: '2026-10-01T00:00:00Z', version: 2 }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.readOnly = false
  mocks.roleBundle = undefined
  mocks.me.mockImplementation(async () => ({ success: true, data: { id: 'owner', role: 'owner', readOnly: mocks.readOnly, roleBundle: mocks.roleBundle } }))
  mocks.list.mockResolvedValue({ success: true, data: { items: [link], total: 1 } })
  mocks.update.mockResolvedValue({ success: true, data: { ...link, version: 3 } })
})
afterEach(() => { cleanup(); forgetStaffIdentity(); forgetSessionSnapshot() })
it('不正な名前を含む一覧でも、ほかの画面名で検索できる', async () => {
  mocks.list.mockResolvedValue({ success: true, data: { items: [{ ...link, name: 123 }, { ...link, key: '2-2', name: '別の画面' }], total: 2 } })
  render(<ManualLinksScreen />)
  await screen.findByText('別の画面')
  fireEvent.change(screen.getByRole('searchbox', { name: /探す/ }), { target: { value: '別の画面' } })
  await waitFor(() => expect(screen.queryByText('123')).toBeNull())
  expect(screen.getByText('別の画面')).toBeTruthy()
})

it('文字でない確認日時は日付に変換せず、確認できないと出す', async () => {
  mocks.list.mockResolvedValue({ success: true, data: { items: [{ ...link, lastCheckedAt: 123 }], total: 1 } })
  render(<ManualLinksScreen />)
  expect(await screen.findByText('日時を確認できません')).toBeTruthy()
  fireEvent.change(screen.getByRole('searchbox', { name: /探す/ }), { target: { value: '受信箱' } })
  expect(screen.getByText('日時を確認できません')).toBeTruthy()
})
