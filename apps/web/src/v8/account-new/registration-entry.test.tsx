// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity, readStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'
import { ApiError } from '@/lib/api/transport/errors'
import AccountRegisterV8 from './register'
import { DRAFT_KEY } from './logic'
import { REGISTRATION_STYLE_KEY } from './use-registration-style'
import { registrationStorageKey } from './registration-storage'

const calls = vi.hoisted(() => ({ me: vi.fn(), connect: vi.fn(), check: vi.fn(), getStyle: vi.fn(), account: vi.fn(), receipt: vi.fn(), resume: vi.fn(), handover: vi.fn() }))
vi.mock('@/lib/api', async (original) => ({
  ...await original<typeof import('@/lib/api')>(),
  api: {
    staff: { me: calls.me },
    lineAccounts: { connect: calls.connect, connectCheck: calls.check, get: calls.account, registrationReceipt: calls.receipt, registrationResume: calls.resume, followerImportState: calls.handover },
  },
}))
vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: { get: calls.getStyle } }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/components/hq/notice-line-register-dialog', () => ({ default: () => null }))

function identify(id = 'owner-a', tenantId = 'tenant-a') {
  const identity = { ...readStaffIdentity()!, id, tenantId }
  act(() => rememberStaffIdentity(identity))
  return identity
}
const draft = {
  step: 2, sub: 4, connectionStepsVersion: 4, precheckAt: 'done',
  precheck: { q1: 'yes', q2: 'no', q4: 'no' }, channelId: '123456789', providerId: '2000001',
  loginChannelId: '2000002',
}
const entrance = () => expect((screen.getByRole('radio', { name: 'はい、あります' }) as HTMLInputElement).checked).toBe(false)

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks()
  verifiedStaffRole('owner'); identify()
  calls.me.mockImplementation(() => new Promise(() => {}))
  calls.account.mockResolvedValue({ success: true, data: { id: 'own-account', name: '接続待ちのアカウント', basicId: '@fixture' } })
  calls.getStyle.mockResolvedValue({ success: true, data: { style: 'standard', styleSelected: false, version: 0 } })
  calls.resume.mockResolvedValue({ success: false })
  calls.handover.mockResolvedValue({ success: true, data: { phase: 'not_started' } })
  calls.receipt.mockResolvedValue({ success: true, data: { status: 'waiting', receivedAt: null } })
})
afterEach(() => { cleanup(); forgetStaffIdentity(); vi.useRealTimers(); vi.restoreAllMocks() })

it('共通キーに途中の手順と作成済みIDが残っていても、新しい登録は最初の質問から始まる', () => {
  const legacy = JSON.stringify(draft)
  localStorage.setItem(DRAFT_KEY, legacy)
  sessionStorage.setItem(REGISTRATION_STYLE_KEY, 'foreign-account')
  render(<AccountRegisterV8 />)
  entrance()
  expect(screen.queryByText(/保存した入力があります/)).toBeNull()
  expect(screen.queryByRole('dialog', { name: '使い方のスタイルを選ぶ' })).toBeNull()
  expect(localStorage.getItem(DRAFT_KEY)).toBe(legacy)
  expect(calls.getStyle).not.toHaveBeenCalled()
  expect(calls.connect).not.toHaveBeenCalled()
})

it.each([['owner-b', 'tenant-a'], ['owner-a', 'tenant-b']])('別の利用者・統括（%s / %s）の保存位置を引き継がない', (id, tenantId) => {
  const previous = { id, tenantId }
  localStorage.setItem(registrationStorageKey(DRAFT_KEY, previous)!, JSON.stringify(draft))
  sessionStorage.setItem(registrationStorageKey(REGISTRATION_STYLE_KEY, previous)!, 'foreign-account')
  render(<AccountRegisterV8 />)
  entrance()
  expect(screen.queryByText(/保存した入力があります/)).toBeNull()
})

it('本人の下書きの手順と入力値を復元し、秘密値を読み込まない', async () => {
  const key = registrationStorageKey(DRAFT_KEY, readStaffIdentity())!
  localStorage.setItem(key, JSON.stringify({ ...draft, channelSecret: 'old-secret', loginChannelSecret: 'old-login-secret' }))
  render(<AccountRegisterV8 />)
  expect((document.getElementById('v8-login-channel-id') as HTMLInputElement).value).toBe('2000002')
  expect((document.getElementById('v8-login-channel-secret') as HTMLInputElement).value).toBe('')
  fireEvent.change(document.getElementById('v8-login-channel-secret')!, { target: { value: 'new-secret' } })
  await waitFor(() => expect(JSON.parse(localStorage.getItem(key)!).channelId).toBe('123456789'))
  expect(localStorage.getItem(key)).not.toContain('secret')
  expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
})

it('以前の保存済みIDを読んでも受信を再確認して使い方の設定を開く', async () => {
  calls.receipt.mockResolvedValueOnce({ success: true, data: { status: 'confirmed' } })
  sessionStorage.setItem(registrationStorageKey(REGISTRATION_STYLE_KEY, readStaffIdentity())!, 'own-account')
  render(<AccountRegisterV8 />)
  expect(await screen.findByRole('dialog', { name: '使い方のスタイルを選ぶ' })).toBeTruthy()
  expect(calls.receipt).toHaveBeenCalledWith('own-account')
  expect(calls.connect).not.toHaveBeenCalled()
})

it('アーカイブ済みの再開リンクは受信確認を停止し一覧への案内を出す', async () => {
  vi.useFakeTimers()
  calls.receipt.mockRejectedValueOnce(new ApiError(404))
  sessionStorage.setItem(registrationStorageKey(REGISTRATION_STYLE_KEY, readStaffIdentity())!, 'own-account')
  await act(async () => { render(<AccountRegisterV8 />) })
  expect(screen.getByText('登録を再開できませんでした')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'アカウント一覧へ' })).toBeTruthy()
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(calls.receipt).toHaveBeenCalledTimes(1)
  expect(calls.account).not.toHaveBeenCalled()
})

it('受信待ちで読み直しても同じLINEを確認し、受信できたときだけ使い方の設定へ進む', async () => {
  vi.useFakeTimers()
  const key = registrationStorageKey(REGISTRATION_STYLE_KEY, readStaffIdentity())!
  sessionStorage.setItem(key, 'receipt:own-account')
  calls.receipt
    .mockRejectedValueOnce(new Error('通信が切れた'))
    .mockResolvedValueOnce({ success: true, data: { status: 'error', receivedAt: null } })
    .mockResolvedValueOnce({ success: true, data: { status: 'confirmed', receivedAt: '2026-11-22T11:00:00+09:00' } })

  await act(async () => { render(<AccountRegisterV8 />) })
  expect(screen.getByText('受信を確認できませんでした')).toBeTruthy()
  expect(screen.queryByRole('dialog', { name: '使い方のスタイルを選ぶ' })).toBeNull()
  expect(calls.receipt).toHaveBeenCalledExactlyOnceWith('own-account')

  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(screen.getByText('受信の確認に問題があります')).toBeTruthy()
  expect(screen.queryByRole('dialog', { name: '使い方のスタイルを選ぶ' })).toBeNull()

  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(screen.getByRole('dialog', { name: '使い方のスタイルを選ぶ' })).toBeTruthy()
  expect(sessionStorage.getItem(key)).toBe('own-account')
  expect(calls.connect).not.toHaveBeenCalled()

  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(calls.receipt).toHaveBeenCalledTimes(3)
})

it('開いたまま本人が切り替わっても、前の入力や手順を画面に残さない', () => {
  const key = registrationStorageKey(DRAFT_KEY, readStaffIdentity())!
  localStorage.setItem(key, JSON.stringify(draft))
  render(<AccountRegisterV8 />)
  expect((document.getElementById('v8-login-channel-id') as HTMLInputElement).value).toBe('2000002')
  identify('owner-b')
  entrance()
  expect(screen.queryByText(/保存した入力があります/)).toBeNull()
  const current = JSON.parse(localStorage.getItem(registrationStorageKey(DRAFT_KEY, readStaffIdentity())!)!)
  expect(current.channelId).toBe('')
})

it('本人の権限を確認する前には保存位置を復元しない', () => {
  forgetStaffIdentity()
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
  render(<AccountRegisterV8 />)
  expect(screen.getByLabelText('読み込んでいます')).toBeTruthy()
  expect(screen.queryByRole('radio')).toBeNull()
  expect(calls.getStyle).not.toHaveBeenCalled()
})

it('統括IDが未確認の古い本人API応答では、端末の共通下書きを使わない', () => {
  act(() => rememberStaffIdentity({ ...readStaffIdentity()!, tenantId: undefined }))
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
  render(<AccountRegisterV8 />)
  entrance()
  expect(screen.queryByText(/保存した入力があります/)).toBeNull()
})

it('保存領域が使えなくても途中へ飛ばず、入口から操作できる', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage blocked') })
  render(<AccountRegisterV8 />)
  entrance()
  expect(calls.connect).not.toHaveBeenCalled()
  expect(calls.getStyle).not.toHaveBeenCalled()
})

it('途中保存して閉じるを下の帯に置き、入力を下書きに残す', async () => {
  render(<AccountRegisterV8 />)
  fireEvent.click(screen.getByRole('radio', { name: 'はい、あります' }))
  fireEvent.click(screen.getByRole('radio', { name: 'いいえ、引き継ぎません' }))
  fireEvent.click(screen.getByRole('radio', { name: '使っていません' }))
  fireEvent.click(screen.getByRole('button', { name: '次へ', exact: true }))
  expect(screen.queryByRole('button', { name: '事前確認を変える' })).toBeNull()
  const input = document.getElementById('v8-channel-id') as HTMLInputElement
  fireEvent.change(input, { target: { value: '1234567890' } })
  const close = screen.getByRole('link', { name: '途中保存して閉じる' })
  expect(close.getAttribute('href')).toBe('/hq')
  expect(close.closest('[data-shared-part="sticky-bar"]')).toBeTruthy()
  const key = registrationStorageKey(DRAFT_KEY, readStaffIdentity())!
  await waitFor(() => expect(JSON.parse(localStorage.getItem(key)!).channelId).toBe('1234567890'))
  expect(calls.connect).not.toHaveBeenCalled()
})
