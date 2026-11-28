// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import ResumeFollowerHandover from './resume-handover'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity, readStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'
import { registrationStorageKey } from './registration-storage'
import { REGISTRATION_STYLE_KEY } from './use-registration-style'
import { LIST_REQUEST_TIMEOUT_MS } from '@/lib/request-timeout'

const mocks = vi.hoisted(() => ({
  entry: vi.fn(), state: vi.fn(), step: vi.fn(), select: vi.fn(), push: vi.fn(), replace: vi.fn(),
}))
vi.mock('next/navigation', async () => ({
  ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useSearchParams: () => new URLSearchParams('accountId=the-shed'),
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({
  accounts: [{ id: 'the-shed', name: 'THE SHED', displayName: 'THE SHED', basicId: '@test', pictureUrl: null }],
  setSelectedAccountId: mocks.select,
}) }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/api', () => ({ api: { lineAccounts: { accountEntry: mocks.entry, followerImportState: mocks.state, stepFollowerImport: mocks.step } } }))
vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: { get: vi.fn(async () => ({ success: true, data: { style: 'restaurant' } })) } }))

const importState = (over: Record<string, unknown> = {}) => ({
  capability: 'available', phase: 'importing_ids', received: 0, imported: 0,
  alreadyPresent: 0, reactivated: 0, claimedUnassigned: 0, conflicts: 0, invalid: 0,
  profilesProcessed: 0, profilesUpdated: 0, profileErrors: 0,
  updatedAt: new Date().toISOString(), ...over,
})

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear()
  verifiedStaffRole('owner')
  rememberStaffIdentity({ ...readStaffIdentity()!, id: 'owner-a', tenantId: 'tenant-a' })
  vi.clearAllMocks()
  mocks.entry.mockResolvedValue({ success: true, data: { destination: 'handover', canResume: false } })
  mocks.state.mockResolvedValue({ success: true, data: importState() })
  mocks.step.mockImplementation(() => new Promise(() => {}))
})
afterEach(() => { cleanup(); forgetStaffIdentity() })

import { latestFollowerImportState } from './check-rows'
import { useRegistrationImport } from './use-registration-import'

it('最初に不正な状態が届いても採用しない', () => {
  expect(latestFollowerImportState(null, importState({ phase: 'completed', received: -1 }) as never)).toBeNull()
})

it('登録直後の最初の読み込みが不正なら失敗を出し、再確認で正常な状態に戻る', async () => {
  mocks.state.mockResolvedValueOnce({ success: true, data: importState({ phase: 'completed', received: -1 }) })
    .mockResolvedValueOnce({ success: true, data: importState({ phase: 'completed', received: 4 }) })
  const { result } = renderHook(() => useRegistrationImport('the-shed', true, undefined, true, false))
  await waitFor(() => expect(result.current.importRequestError).toBe(true))
  expect(result.current.importState).toBeNull()
  await act(async () => { await result.current.refreshImport() })
  expect(result.current.importState?.phase).toBe('completed')
  expect(result.current.importRequestError).toBe(false)
})

it('処理応答が最初に不正な完了を返しても完了と扱わない', async () => {
  mocks.state.mockReturnValue(new Promise(() => {}))
  mocks.step.mockResolvedValue({ success: true, data: { state: importState({ phase: 'completed', profilesProcessed: -1 }) } })
  const { result } = renderHook(() => useRegistrationImport('the-shed', true, 'importing_ids', true, false))
  await waitFor(() => expect(result.current.importRequestError).toBe(true))
  expect(result.current.importState).toBeNull()
  expect(result.current.importRunning).toBe(true)
})

it('再開画面では最初の不正な完了で入店させず、再確認で復帰する', async () => {
  mocks.state.mockResolvedValueOnce({ success: true, data: importState({ phase: 'completed', profilesUpdated: -1 }) })
    .mockResolvedValueOnce({ success: true, data: importState({ phase: 'completed', received: 4 }) })
  render(<ResumeFollowerHandover />)
  await screen.findByText('引き継ぎの状態を確認できません')
  expect(screen.queryByRole('button', { name: 'アカウントに入る' })).toBeNull()
  expect(mocks.select).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  expect(await screen.findByRole('button', { name: 'アカウントに入る' })).toBeTruthy()
})
