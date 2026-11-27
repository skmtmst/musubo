// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

it('CSVを読めなければ画面に理由を出し、処理を進めない', async () => {
  const view = render(<UidMigrationV8 initialRunId={null} />)
  await screen.findByText('まだ移行していません')
  const file = new File(['data'], '壊れた対応表.csv', { type:'text/csv' })
  Object.defineProperty(file, 'text', { value: () => Promise.reject(new Error('unreadable')) })
  const input = view.container.querySelector('input[type="file"]')!
  fireEvent.change(input, { target:{ files:[file] } })
  expect(await screen.findByText('CSVを読み込めませんでした。ファイルを確認して、もう一度選んでください。')).toBeTruthy()
})

it('選び直した後に古いCSVの読み込みが失敗しても、今のファイルに失敗を出さない', async () => {
  let rejectOld!: (error: Error) => void
  const view = render(<UidMigrationV8 initialRunId={null} />)
  await screen.findByText('まだ移行していません')
  const old = new File(['old'], '古い.csv', { type:'text/csv' })
  Object.defineProperty(old, 'text', { value: () => new Promise((_resolve, reject) => { rejectOld = reject }) })
  const current = new File(['new'], '新しい.csv', { type:'text/csv' })
  Object.defineProperty(current, 'text', { value: () => Promise.resolve('old_uid,new_uid\nOLD,NEW\n') })
  const input = view.container.querySelector('input[type="file"]')!
  fireEvent.change(input, { target:{ files:[old] } })
  fireEvent.change(input, { target:{ files:[current] } })
  await screen.findByText('新しい.csv')
  await act(async () => { rejectOld(new Error('unreadable')) })
  expect(screen.queryByText('CSVを読み込めませんでした。ファイルを確認して、もう一度選んでください。')).toBeNull()
})
