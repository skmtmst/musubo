// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot, readSessionSnapshot, rememberSessionSnapshot } from '@/lib/session-snapshot'
import { api } from '@/lib/api'
import { forgetAuthCheck, readAuthCheck, rememberAuthCheck } from '@/lib/auth-check-marker'
import { lockReason } from '@/components/shared/permission-lock'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import Button from '@/components/shared/button'
import ImpersonationBar from './impersonation-bar'

const mock = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), push: vi.fn(), refresh: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mock.push, refresh: mock.refresh }) }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, ops: { ...actual.api.ops, impersonation: { ...actual.api.ops.impersonation, read: mock.read, write: mock.write } } } }
})

const initial = { id: 'proxy', tenantId: 'tenant', tenantName: '隔離テスト', mode: 'write' as const, piiRevealed: false, startedAt: '2026-10-29T00:00:00Z' }
afterEach(() => { cleanup(); forgetStaffIdentity(); forgetSessionSnapshot(); forgetAuthCheck(); vi.resetAllMocks(); vi.unstubAllGlobals() })

function MutatingControl({ write }: { write: () => void }) {
  const reason = usePermissionLockReason(true, 'manager')
  return <Button lockedReason={reason} onClick={() => { if (lockReason(true, 'manager')) return; write() }}>設定を保存する</Button>
}

it('実際の代理帯で書込から閲覧へ戻すと、同じ画面の保存は起動しない', async () => {
  verifiedStaffRole('owner')
  rememberSessionSnapshot({ impersonation: initial, unfamiliarAt: null, stepUpMethod: 'none' })
  mock.read.mockResolvedValue({ success: true, data: { ...initial, mode: 'read' } })
  const write = vi.fn()
  render(<><ImpersonationBar initial={initial} /><MutatingControl write={write} /></>)
  fireEvent.click(screen.getByRole('button', { name: '設定を保存する' }))
  expect(write).toHaveBeenCalledTimes(1)
  write.mockClear()
  fireEvent.click(screen.getByRole('button', { name: '閲覧のみに戻す' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: '書き込みに切り替える' })).not.toBeNull())
  expect(mock.read).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: '設定を保存する' }))
  expect(write).not.toHaveBeenCalled()
  expect(readSessionSnapshot()?.impersonation?.mode).toBe('read')
  expect(screen.getByRole('button', { name: '設定を保存する' }).getAttribute('aria-disabled')).toBe('true')
})


it('閲覧から理由付き書込へ切り替えると元の編集許可を使え、保存は1回', async () => {
  verifiedStaffRole('owner')
  const reading = { ...initial, mode: 'read' as const }
  const known = { impersonation: reading, unfamiliarAt: '2026-10-28', stepUpMethod: 'totp' as const }
  rememberSessionSnapshot(known)
  rememberAuthCheck('fixture-fingerprint', 'active', known)
  mock.write.mockResolvedValue({ success: true, data: initial })
  const write = vi.fn()
  render(<><ImpersonationBar initial={reading} /><MutatingControl write={write} /></>)
  fireEvent.click(screen.getByRole('button', { name: '設定を保存する' }))
  expect(write).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '書き込みに切り替える' }))
  const dialog = await screen.findByRole('alertdialog')
  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '隔離された試験の確認' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '書き込みに切り替える' }))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  expect(mock.write).toHaveBeenCalledExactlyOnceWith('隔離された試験の確認', 'proxy')
  expect(readSessionSnapshot()).toEqual({ ...known, impersonation: initial })
  expect(readAuthCheck('fixture-fingerprint')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '設定を保存する' }))
  expect(write).toHaveBeenCalledTimes(1)
})

it.each(['read', 'write'] as const)('%sへの切替が失敗したら共有モードと保存可否は変わらない', async target => {
  verifiedStaffRole('owner')
  const before = { ...initial, mode: target === 'read' ? 'write' as const : 'read' as const }
  const known = { impersonation: before, unfamiliarAt: null, stepUpMethod: 'password' as const }
  rememberSessionSnapshot(known)
  rememberAuthCheck('fixture-fingerprint', 'active', known)
  mock.read.mockResolvedValue({ success: false, error: '試験の拒否' })
  mock.write.mockResolvedValue({ success: false, error: '試験の拒否' })
  const write = vi.fn()
  render(<><ImpersonationBar initial={before} /><MutatingControl write={write} /></>)
  if (target === 'read') {
    fireEvent.click(screen.getByRole('button', { name: '閲覧のみに戻す' }))
    await waitFor(() => expect(mock.read).toHaveBeenCalledTimes(1))
    await waitFor(() => expect((screen.getByRole('button', { name: '閲覧のみに戻す' }) as HTMLButtonElement).disabled).toBe(false))
  } else {
    fireEvent.click(screen.getByRole('button', { name: '書き込みに切り替える' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '隔離された試験の確認' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '書き込みに切り替える' }))
    await screen.findByText('試験の拒否')
  }
  expect(readSessionSnapshot()).toBe(known)
  expect(readAuthCheck('fixture-fingerprint')?.snapshot).toEqual(known)
  fireEvent.click(screen.getByRole('button', { name: '設定を保存する' }))
  expect(write).toHaveBeenCalledTimes(target === 'read' ? 1 : 0)
})

it('帯で閲覧へ戻しても、閲覧のGETは同じ画面で利用できる', async () => {
  verifiedStaffRole('owner')
  rememberSessionSnapshot({ impersonation: initial, unfamiliarAt: null, stepUpMethod: 'none' })
  mock.read.mockResolvedValue({ success: true, data: { ...initial, mode: 'read' } })
  const get = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ success: true, data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', get)
  render(<ImpersonationBar initial={initial} />)
  fireEvent.click(screen.getByRole('button', { name: '閲覧のみに戻す' }))
  await screen.findByRole('button', { name: '書き込みに切り替える' })
  expect(readSessionSnapshot()?.impersonation?.mode).toBe('read')
  await api.lineAccounts.list()
  expect(get).toHaveBeenCalledTimes(1)
  expect(String(get.mock.calls[0]?.[0])).toContain('/api/line-accounts')
  expect(get.mock.calls[0]?.[1]?.method ?? 'GET').toBe('GET')
})


it.each([true, false])('控えが無い時の再確認中は保存0、認証の情報を作らない（再確認成功=%s）', async success => {
  verifiedStaffRole('owner')
  forgetSessionSnapshot()
  mock.read.mockResolvedValue({ success: true, data: { ...initial, mode: 'read' } })
  let finish!: (value: Response) => void
  const fetchSession = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
  vi.stubGlobal('fetch', fetchSession)
  const write = vi.fn()
  render(<><ImpersonationBar initial={initial} /><MutatingControl write={write} /></>)
  fireEvent.click(screen.getByRole('button', { name: '閲覧のみに戻す' }))
  await waitFor(() => expect(fetchSession).toHaveBeenCalledTimes(1))
  expect(readSessionSnapshot()).toBeNull()
  expect(lockReason(true, 'manager')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '設定を保存する' }))
  expect(write).not.toHaveBeenCalled()
  finish(new Response(JSON.stringify({ success, data: { impersonation: { ...initial, mode: 'read' }, stepUpMethod: 'password', unfamiliarAt: '2026-10-28T01:00:00Z' } }), { status: success ? 200 : 503, headers: { 'content-type': 'application/json' } }))
  if (success) {
    await waitFor(() => expect(readSessionSnapshot()?.stepUpMethod).toBe('password'))
    expect(readSessionSnapshot()?.unfamiliarAt).toBe('2026-10-28T01:00:00Z')
  } else {
    await screen.findByText(/切り替え後のログインを確認できませんでした/)
    expect(readSessionSnapshot()).toBeNull()
    expect(lockReason(true, 'manager')).toBeTruthy()
  }
  fireEvent.click(screen.getByRole('button', { name: '設定を保存する' }))
  expect(write).not.toHaveBeenCalled()
})


it('代理帯の開始時刻が空なら区切りだけ出さず、確定した時刻には区切りを残す', () => {
  const first = render(<ImpersonationBar initial={{ ...initial, mode: 'read', startedAt: '' }} />)
  expect(first.container.querySelector('[data-notice-message]')?.textContent).not.toContain('〜')
  first.unmount()
  const second = render(<ImpersonationBar initial={{ ...initial, mode: 'read' }} />)
  expect(second.container.querySelector('[data-notice-message]')?.textContent).toContain('〜')
})
