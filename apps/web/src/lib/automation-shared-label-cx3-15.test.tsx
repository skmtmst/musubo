// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'

vi.mock('@line-crm/shared', async original => {
  const actual = await original<typeof import('@line-crm/shared')>()
  return { ...actual, automationTriggerLabel: (type: string) => `共有のきっかけ-${type}`, automationActionLabel: (type: string) => `共有の動き-${type}` }
})
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }), usePathname: () => '/automations', useSearchParams: () => new URLSearchParams('') }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-a', accounts: [{ id: 'account-a', name: '本店' }], loading: false }) }))
vi.mock('@/lib/use-running-version', () => ({ useRunningVersion: () => ({ detail: { deploy_env: 'staging' }, statusText: '稼働版を確認' }) }))
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: vi.fn(async () => ({ success: true, data: [{ id: 'account-a', name: '本店' }] })) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => false }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
import AutomationListV8 from '@/v8/automations/list'

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
const item = { id: 'au-1', name: '連絡の自動処理', description: null, eventType: 'message_received', triggerConfig: {}, conditions: {}, actions: [{ type: 'notify_staff', params: {} }, { type: 'add_tag', params: {} }], isActive: true, priority: 1, lineAccountId: 'account-a', status: 'active', versionId: 'v1', version: 1, confirmationRevision: 3, executionCount30d: 0, failureCount30d: 0, lastRunAt: null, createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-09-30T00:00:00Z' }
beforeEach(() => {
  verifiedStaffRole('owner')
  window.history.replaceState({}, '', '/automations')
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.pathname === '/api/automations') return json({ success: true, data: [item], summary: { active: 1, stopped: 0, executionCount30d: 0, failureCount30d: 0 } })
    if (url.pathname === '/api/folders' || url.pathname === '/api/automation-templates' || url.pathname === '/api/common-actions') return json({ success: true, data: [] })
    if (url.pathname === '/api/automation-runs') return json({ success: true, data: { summary: { skipped: 0 } } })
    return json({ success: true, data: null })
  }))
})
afterEach(() => { cleanup(); forgetStaffIdentity(); vi.unstubAllGlobals() })

it('一覧と検索で、きっかけと動きの共通の呼び名を使う', async () => {
  render(<AutomationListV8 />)
  await screen.findByText('連絡の自動処理')
  expect(screen.getByText('共有のきっかけ-message_received')).toBeTruthy()
  expect(screen.getByText('共有の動き-notify_staff')).toBeTruthy()
  const search = screen.getByRole('searchbox', { name: 'ルールを検索' })
  fireEvent.change(search, { target: { value: '一致しない文字列' } })
  await waitFor(() => expect(screen.queryByText('連絡の自動処理')).toBeNull())
  fireEvent.change(search, { target: { value: '共有の動き-add_tag' } })
  await screen.findByText('連絡の自動処理')
  fireEvent.change(search, { target: { value: '一致しない文字列' } })
  await waitFor(() => expect(screen.queryByText('連絡の自動処理')).toBeNull())
  fireEvent.change(search, { target: { value: '共有のきっかけ-message_received' } })
  await screen.findByText('連絡の自動処理')
})
