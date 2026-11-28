// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

describe('統括から友だち引き継ぎへ戻る画面', () => {
  it('状態確認が時間切れなら失敗を表示して再試行できる', async () => {
    vi.useFakeTimers()
    try {
      let resolveRetry!: (value: unknown) => void
      mocks.state.mockReturnValueOnce(new Promise(() => {})).mockReturnValueOnce(new Promise(done => { resolveRetry = done }))
      render(<ResumeFollowerHandover />)
      await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() })
      expect(mocks.state).toHaveBeenCalledTimes(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(LIST_REQUEST_TIMEOUT_MS + 5000) })
      expect(screen.getByText('引き継ぎの状態を確認できません')).toBeTruthy()
      expect(mocks.state).toHaveBeenCalledTimes(2)
      await act(async () => { resolveRetry({ success: true, data: importState({ phase: 'not_started' }) }) })
      expect(screen.getByText('引き継ぎが開始されていません')).toBeTruthy()
    } finally { vi.useRealTimers() }
  })
  it('状態確認が遅い間は定期確認を重ねず、完了後に再確認できる', async () => {
    let resolve!: (value: unknown) => void
    mocks.state.mockReturnValueOnce(new Promise(done => { resolve = done })).mockResolvedValue({ success: true, data: importState({ phase: 'not_started' }) })
    const interval = vi.spyOn(globalThis, 'setInterval')
    render(<ResumeFollowerHandover />)
    await waitFor(() => expect(mocks.state).toHaveBeenCalledTimes(1))
    const tick = interval.mock.calls.find(([, delay]) => delay === 5000)?.[0] as (() => void)
    expect(tick).toBeTypeOf('function')
    await act(async () => { tick(); tick() })
    expect(mocks.state).toHaveBeenCalledTimes(1)
    await act(async () => { resolve({ success: true, data: importState({ phase: 'not_started' }) }) })
    await screen.findByText('引き継ぎが開始されていません')
    await act(async () => { tick() })
    await waitFor(() => expect(mocks.state).toHaveBeenCalledTimes(2))
    interval.mockRestore()
  })

  it('古い引き継ぎリンクでも本人の登録が途中なら同じ登録へ進み、引き継ぎを動かさない', async () => {
    mocks.entry.mockResolvedValue({ success: true, data: { destination: 'registration', canResume: true } })
    render(<ResumeFollowerHandover />)
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/accounts/new?resume=the-shed'))
    expect(mocks.state).not.toHaveBeenCalled()
    expect(mocks.step).not.toHaveBeenCalled()
    expect(mocks.select).not.toHaveBeenCalled()
  })

  it('引き継がず登録した人は未開始をエラーにせず完了へ進める', async () => {
    const key = registrationStorageKey(REGISTRATION_STYLE_KEY, readStaffIdentity())!
    localStorage.setItem(`${key}:import:${encodeURIComponent('the-shed')}`, 'false')
    mocks.state.mockResolvedValue({ success: true, data: importState({ phase: 'not_started', updatedAt: '2000-01-01T00:00:00Z' }) })
    render(<ResumeFollowerHandover />)
    await screen.findByText('LINEアカウントの登録が完了しました')
    expect(screen.queryByText(/引き継ぎはオフ/)).toBeNull()
    expect(screen.queryByText('引き継ぎが開始されていません')).toBeNull()
    expect(screen.queryByRole('button', { name: '状態を再確認' })).toBeNull()
    expect(mocks.step).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'アカウントに入る' }))
    expect(mocks.select).toHaveBeenCalledWith('the-shed')
  })
  it('別の本人の選択を読み込まず、未開始のままなら確認を求める', async () => {
    const foreign = registrationStorageKey(REGISTRATION_STYLE_KEY, { id: 'owner-b', tenantId: 'tenant-a' })!
    localStorage.setItem(`${foreign}:import:the-shed`, 'false')
    mocks.state.mockResolvedValue({ success: true, data: importState({ phase: 'not_started' }) })
    render(<ResumeFollowerHandover />)
    await screen.findByText('引き継ぎが開始されていません')
    expect(screen.queryByRole('button', { name: 'アカウントに入る' })).toBeNull()
    expect(mocks.step).not.toHaveBeenCalled()
  })
  it('登録時はオフでも、その後始めた処理は実際の進捗を表示する', async () => {
    const key = registrationStorageKey(REGISTRATION_STYLE_KEY, readStaffIdentity())!
    localStorage.setItem(`${key}:import:the-shed`, 'false')
    render(<ResumeFollowerHandover />)
    await screen.findByText('友だちを確認しています', { selector: 'h2' })
    await waitFor(() => expect(mocks.step).toHaveBeenCalledWith('the-shed'))
    expect(screen.queryByText(/引き継ぎはオフ/)).toBeNull()
  })
  it('Penの探索中カードを表示して実際のジョブを進める', async () => {
    render(<ResumeFollowerHandover />)
    await screen.findByText('友だちを確認しています', { selector: 'h2' })
    expect(await screen.findByText('飲食店')).toBeTruthy()
    const bar = screen.getByRole('progressbar', { name: '友だちの引き継ぎ進捗' })
    expect(bar.childElementCount).toBe(0)
    expect(screen.queryByRole('button', { name: 'アカウントに入る' })).toBeNull()
    await waitFor(() => expect(mocks.step).toHaveBeenCalledWith('the-shed'))
    expect(mocks.select).not.toHaveBeenCalled()
  })

  it('完了を確認するまで店舗へ入れず、完了後だけ入れる', async () => {
    mocks.state.mockResolvedValue({ success: true, data: importState({ phase: 'completed', received: 4, claimedUnassigned: 3, alreadyPresent: 1 }) })
    render(<ResumeFollowerHandover />)
    const enter = await screen.findByRole('button', { name: 'アカウントに入る' })
    expect(screen.getByRole('progressbar', { name: '友だちの引き継ぎ進捗' }).getAttribute('aria-valuenow')).toBe('4')
    enter.click()
    expect(mocks.select).toHaveBeenCalledWith('the-shed')
    expect(mocks.push).toHaveBeenCalledWith('/')
  })

  it('未開始の再開画面は、状態だけ再確認して勝手に処理や入店を始めない', async () => {
    mocks.state.mockResolvedValue({ success: true, data: importState({ phase: 'not_started' }) })
    render(<ResumeFollowerHandover />)
    await screen.findByText('引き継ぎが開始されていません')
    fireEvent.click(screen.getByRole('button', { name: /もう一度|再読み込み|再確認/ }))
    await waitFor(() => expect(mocks.state).toHaveBeenCalledTimes(2))
    expect(mocks.step).not.toHaveBeenCalled()
    expect(mocks.select).not.toHaveBeenCalled(); expect(mocks.push).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'アカウントに入る' })).toBeNull()
  })
})
