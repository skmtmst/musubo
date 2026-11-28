// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StaffMember } from '@line-crm/shared'
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
const model = vi.hoisted(() => ({ status: 'unknown' }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('next/navigation', () => ({ usePathname: () => '/friends/migrations', useRouter: () => ({ push() {}, replace() {} }), useSearchParams: () => new URLSearchParams() }))
vi.mock('./use-friend-migrations', async original => {
  const actual = await original<typeof import('./use-friend-migrations')>()
  return { ...actual, useFriendMigrations: () => ({ status: 'ready', summary: null, file: null, importId: null, message: '', exportResult: null, busy: false,
    jobs: [{ id: 'export-1', kind: 'export', status: model.status, created_at: '2026-01-01T00:00:00Z', created_by_name: '見本', row_count: 2, expires_at: '2030-01-01T00:00:00Z' }],
    accounts: [], columns: ['basic'], accountId: 'acc', manageLocked: false, downloadExport: vi.fn(), setAccountId: vi.fn(), toggleColumn: vi.fn(), createExport: vi.fn(), onPickFile: vi.fn(), previewImport: vi.fn(), cancelImport: vi.fn(), executeImport: vi.fn(), load: vi.fn(),
  }) }
})
import Csv from './csv'
beforeEach(() => rememberStaffIdentity({ id: 'owner', role: 'owner' } as StaffMember))
afterEach(() => { cleanup(); forgetStaffIdentity() })
it.each(['toString', 'constructor', '__proto__'])('未対応の状態 %s の履歴を確認中と表示する', status => {
  model.status = status
  render(<Csv />)
  expect(screen.getByText('確認中')).toBeTruthy()
  expect(screen.getByText('見本')).toBeTruthy()
})
