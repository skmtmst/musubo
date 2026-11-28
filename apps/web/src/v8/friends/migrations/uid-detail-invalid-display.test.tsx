// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StaffMember } from '@line-crm/shared'
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'
vi.hoisted(() => { process.env.NEXT_PUBLIC_API_URL ||= 'http://worker.test' })
const fixture = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn(), me: vi.fn() }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('next/navigation', () => ({ usePathname: () => '/friends/migrations', useRouter: () => ({ push() {}, replace() {} }), useSearchParams: () => new URLSearchParams() }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, fetchApi: fixture.detail, api: { ...actual.api,
    staff: { ...actual.api.staff, me: fixture.me },
    lineAccounts: { ...actual.api.lineAccounts, list: async () => ({ success: true, data: [{ id: 'from', name: '移行元' }, { id: 'to', name: '移行先' }] }) },
    friendMigrations: { ...actual.api.friendMigrations, list: fixture.list },
  } }
})
import UidMigrationV8 from './uid'
const run = { id:'run', fromAccountId:'from', toAccountId:'to', status:'review', createdBy:'owner', createdAt:'2026-11-27T00:00:00Z', counts:{total:1,auto:0,review:1,unmatched:0,conflict:0,applied:0,failed:0}, items:[] }
beforeEach(() => {
  vi.clearAllMocks()
  rememberStaffIdentity({ id:'owner', role:'owner', permissionKeys:[] } as unknown as StaffMember)
  forgetSessionSnapshot()
  fixture.me.mockResolvedValue({ success:false, error:'not available' })
  fixture.list.mockResolvedValue({ success:true, data:[] })
  fixture.detail.mockResolvedValue({ success:true, data:run })
})
afterEach(() => { cleanup(); forgetStaffIdentity(); forgetSessionSnapshot() })

it.each([
  { ...run, counts:null },
  { ...run, items:[null] },
  { ...run, items:[{ id:'bad', newUid:null, classification:'review', decision:'pending' }] },
])('対応表の不正な応答は画面を止めず、読み込み失敗を表示する', async (badDetail) => {
  fixture.list.mockResolvedValue({ success:true, data:[run] })
  fixture.detail.mockResolvedValue({ success:true, data:badDetail })
  render(<UidMigrationV8 initialRunId={null} />)
  await waitFor(() => expect(screen.getByText('対応表を読み直せませんでした。移行履歴からもう一度選んでください。')).toBeTruthy())
})
