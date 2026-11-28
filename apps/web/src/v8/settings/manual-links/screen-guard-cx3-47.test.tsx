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
it('画面名が文字でなくても確認できないと表示し、他の行を開ける', async () => {
  mocks.list.mockResolvedValue({ success: true, data: { items: [{ ...link, name: { invalid: true } }, { ...link, key: '2-2', name: '別の画面' }], total: 2 } })
  render(<ManualLinksScreen />)
  expect(await screen.findByText('画面名を確認できません')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '別の画面のその他操作' }))
  expect(screen.getByRole('menuitem', { name: '行き先を編集する' })).toBeTruthy()
  fireEvent.keyDown(screen.getByRole('menuitem', { name: '行き先を編集する' }), { key: 'Escape' })
  fireEvent.click(screen.getByRole('button', { name: '画面名を確認できませんのその他操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '行き先を編集する' }))
  expect(screen.getByRole('textbox', { name: '画面名を確認できませんのマニュアルのURL' })).toBeTruthy()
  expect(document.body.textContent).not.toContain('[object Object]')
})

it('URLが文字でない行は確認できないと表示し、編集を止める', async () => {
  mocks.list.mockResolvedValue({ success: true, data: { items: [{ ...link, url: 123 }], total: 1 } })
  render(<ManualLinksScreen />)
  expect(await screen.findByText('URLを確認できません')).toBeTruthy()
  expect(screen.getByText('状態を確認できません')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '受信箱のその他操作' }))
  const edit = screen.getByRole('menuitem', { name: '行き先を編集する' })
  expect(edit.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(edit)
  expect(screen.queryByRole('textbox', { name: '受信箱のマニュアルのURL' })).toBeNull()
})
