// @vitest-environment happy-dom
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity, readStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'
import AccountRegisterV8 from './register'

const calls = vi.hoisted(() => ({ me: vi.fn(), connect: vi.fn(), check: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { staff: { me: calls.me }, lineAccounts: { connect: calls.connect, connectCheck: calls.check } } }))
vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: { get: vi.fn() } }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/components/hq/notice-line-register-dialog', () => ({ default: () => null }))
vi.mock('./resume-style', () => ({ default: () => null }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); verifiedStaffRole('owner')
  act(() => rememberStaffIdentity({ ...readStaffIdentity()!, id: 'owner-a', tenantId: 'tenant-a' }))
  calls.me.mockImplementation(() => new Promise(() => {}))
})
afterEach(() => { cleanup(); forgetStaffIdentity(); vi.restoreAllMocks() })

it.each([false, true])('友だちの引き継ぎが %s でも、チャット停止を求めず自動返信の重複防止を案内する', inherit => {
  render(<AccountRegisterV8 />)
  fireEvent.click(screen.getByRole('radio', { name: 'はい、あります' }))
  fireEvent.click(screen.getByRole('radio', { name: inherit ? 'はい、引き継ぎます' : 'いいえ、引き継ぎません' }))
  if (inherit) {
    fireEvent.click(screen.getByRole('checkbox', { name: '認証済みアカウントであることを確認した' }))
  }
  fireEvent.click(screen.getByRole('radio', { name: '使っていません' }))
  const guidance = screen.getByText('接続後に変わること').parentElement!.textContent!
  expect(guidance).not.toMatch(/チャット.{0,5}(?:オフ|停止)/)
  expect(guidance).toContain('チャット')
  expect(guidance).toContain('そのまま使えます')
  expect(guidance).toContain('あいさつメッセージ')
  expect(guidance).toContain('応答メッセージ')
  expect(guidance).toContain('二重')
  expect(guidance).toContain('オフにしてください')
  expect(calls.check).not.toHaveBeenCalled(); expect(calls.connect).not.toHaveBeenCalled()
})
