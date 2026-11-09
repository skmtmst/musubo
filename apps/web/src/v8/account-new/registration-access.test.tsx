// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
/* 登録・接続確認はオーナーと管理者。スタッフ・閲覧のみは入口も直アクセスも拒否する。 */
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const styleCalls = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }))
vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: styleCalls }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock() }))

const fixture = vi.hoisted(() => ({ role: { value: 'owner' as string | null } }))

vi.mock('@/lib/staff-role', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/staff-role')>()),
  useStaffRole: () => fixture.role.value,
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

vi.mock('@/lib/api', () => ({
  api: { lineAccounts: { connectCheck: vi.fn(), connect: vi.fn(), list: vi.fn(async () => ({ success: true, data: [] })) } },
  ApiError: class ApiError extends Error { status = 0 },
  describeSaveFailure: () => '',
}))

import AccountRegisterV8 from './register'

beforeEach(() => { fixture.role.value = verifiedStaffRole('owner'); vi.clearAllMocks() })
afterEach(cleanup)

const MANAGER_ONLY = 'LINEアカウントの登録はオーナーか管理者ができます。オーナーか管理者に頼んでください。'

describe('/accounts/new の登録権限', () => {
  it.each(['staff', 'viewer'])('%s には手順を出さず、頼む先と一覧へ戻る道を出す', (role) => {
    fixture.role.value = verifiedStaffRole(role)
    render(<AccountRegisterV8 />)
    expect(screen.getByText(MANAGER_ONLY)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'LINEアカウントの一覧へ戻る' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '次へ' })).toBeNull()
  })

  it.each(['owner', 'admin'])('%s は登録の手順を開始できる', (role) => {
    fixture.role.value = verifiedStaffRole(role)
    render(<AccountRegisterV8 />)
    expect(screen.queryByText(MANAGER_ONLY)).toBeNull()
    expect(screen.getByRole('radio', { name: 'はい、あります' })).toBeTruthy()
  })

  it('役割が読めるまでは読み込みを示し、下書き復元や変更を始めない', () => {
    fixture.role.value = verifiedStaffRole(null)
    render(<AccountRegisterV8 />)
    expect(screen.queryByText(MANAGER_ONLY)).toBeNull()
    expect(screen.getByLabelText('読み込んでいます').getAttribute('aria-busy')).toBe('true')
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(styleCalls.get).not.toHaveBeenCalled()
    expect(styleCalls.save).not.toHaveBeenCalled()
  })
})

afterEach(() => { verifiedStaffRole(null) })
