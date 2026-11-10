// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity, readStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'
import AccountRegisterV8 from './register'
import { DRAFT_KEY, LOGIN_ACKS, WEBHOOK_ACKS } from './logic'
import { registrationStorageKey } from './registration-storage'

const calls = vi.hoisted(() => ({ me: vi.fn(), connect: vi.fn(), check: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { staff: { me: calls.me }, lineAccounts: { connect: calls.connect, connectCheck: calls.check } } }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/components/hq/notice-line-register-dialog', () => ({ default: () => null }))
vi.mock('./resume-style', () => ({ default: () => null }))
vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: { get: vi.fn() } }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

const connection = {
  steps: [1, 2, 3, 4, 5].map(order => ({ order, state: 'passed', message: '確認済み' })),
  basicId: '@fixture', pictureUrl: null, displayName: '試験公式',
  verification: { tokenOk: true, loginOk: true, sameProvider: true, followerTotal: 3,
    webhook: { expectedUrl: 'https://worker.test/webhook/1234567890', registeredUrl: 'https://worker.test/webhook/1234567890', active: true, testPassed: true } },
  followerImport: { capability: 'available', phase: 'not_started' }, remainingActions: [],
}
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks()
  verifiedStaffRole('owner')
  act(() => rememberStaffIdentity({ ...readStaffIdentity()!, id: 'owner-a', tenantId: 'tenant-a' }))
  calls.me.mockImplementation(() => new Promise(() => {}))
  calls.check.mockResolvedValue({ success: true, data: connection })
  // 実際の登録や後続の取り込みを呼ばない。
  calls.connect.mockResolvedValue({ success: false, error: '試験では登録しません。' })
})
afterEach(() => {
  cleanup(); forgetStaffIdentity(); vi.restoreAllMocks()
})

function savedChoice(value: boolean, explicit = false) {
  const key = registrationStorageKey(DRAFT_KEY, readStaffIdentity())!
  localStorage.setItem(key, JSON.stringify({ step: 3, sub: 1, connectionStepsVersion: 4,
    precheckAt: 'done', precheck: { q1: 'yes', q2: value ? 'no' : 'yes', q4: 'no' },
    channelId: '1234567890', importFriends: value, importFriendsExplicit: explicit }))
  return key
}

async function confirmation(answer: boolean, restored?: boolean, explicit = false) {
  if (restored !== undefined) savedChoice(restored, explicit)
  render(<AccountRegisterV8 />)
  fireEvent.click(screen.getByRole('radio', { name: 'はい、あります' }))
  fireEvent.click(screen.getByRole('radio', { name: answer ? 'はい、引き継ぎます' : 'いいえ、引き継ぎません' }))
  if (answer) {
    fireEvent.click(screen.getByRole('checkbox', { name: '認証済みアカウントであることを確認した' }))
  }
  fireEvent.click(screen.getByRole('radio', { name: '使っていません' }))
  fireEvent.click(screen.getByRole('button', { name: '次へ', exact: true }))
  function fill(id: string, value: string) { fireEvent.change(document.getElementById(id)!, { target: { value } }) }
  const next = () => fireEvent.click(screen.getByRole('button', { name: '次のステップへ' }))
  fill('v8-channel-id', '1234567890'); fill('v8-channel-secret', 'a'.repeat(32)); next()
  fill('v8-provider-id', '2000000001'); next()
  WEBHOOK_ACKS.forEach(ack => fireEvent.click(screen.getByRole('checkbox', { name: ack.label }))); next()
  fill('v8-login-channel-id', '2000000002'); fill('v8-login-channel-secret', 'b'.repeat(32))
  LOGIN_ACKS.forEach(ack => fireEvent.click(screen.getByRole('checkbox', { name: ack.label }))); next()
  return screen.getByRole('checkbox', { name: 'いまの友だちの引き継ぎ' }) as HTMLInputElement
}

it('登録前の接続情報がある間はページを離れる前に確認する', async () => {
  await confirmation(false)
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
})

it.each([undefined, true])('引き継ぎを断った回答は、接続確認でも未選択になる（保存値 %s）', async restored => {
  const checkbox = await confirmation(false, restored)
  expect(checkbox.checked).toBe(false)
  expect(calls.check).not.toHaveBeenCalled(); expect(calls.connect).not.toHaveBeenCalled()
})

it('引き継ぐ回答は、保存済みのオフより優先する', async () => {
  expect((await confirmation(true, false)).checked).toBe(true)
})

it('本人が手で選んだ値は、事前確認に戻って答え直しても変えない', async () => {
  expect((await confirmation(false, true, true)).checked).toBe(true)
})

it('以前の確認画面まで進んだ下書きの選択も、答え直しで失わない', async () => {
  const key = savedChoice(true)
  const draft = JSON.parse(localStorage.getItem(key)!)
  delete draft.importFriendsExplicit
  localStorage.setItem(key, JSON.stringify(draft))
  expect((await confirmation(false)).checked).toBe(true)
})

it('画面で手動オフにして戻り、事前確認を変えてもオフのまま', async () => {
  const checkbox = await confirmation(true)
  fireEvent.click(checkbox)
  const key = registrationStorageKey(DRAFT_KEY, readStaffIdentity())!
  expect(JSON.parse(localStorage.getItem(key)!).importFriendsExplicit).toBe(true)
  for (const name of ['LINEログインへ戻る', 'Webhook の設定へ戻る', 'プロバイダーIDへ戻る', 'Messaging API へ戻る', '事前確認へ戻る']) {
    fireEvent.click(screen.getByRole('button', { name }))
  }
  for (let i = 0; i < 2; i++) fireEvent.click(screen.getByRole('button', { name: '戻る', exact: true }))
  fireEvent.click(screen.getByRole('radio', { name: 'いいえ、引き継ぎません' }))
  fireEvent.click(screen.getByRole('button', { name: '戻る', exact: true }))
  fireEvent.click(screen.getByRole('radio', { name: 'はい、引き継ぎます' }))
  expect(JSON.parse(localStorage.getItem(key)!).importFriends).toBe(false)
})

it.each([false, true])('最終確認の選択 %s を、接続確認と登録の両方へ明示して送る', async finalChoice => {
  const checkbox = await confirmation(!finalChoice)
  // 最後の確認では、事前の回答を本人が上書きできる。
  if (checkbox.checked !== finalChoice) fireEvent.click(checkbox)
  fireEvent.click(screen.getByRole('checkbox', { name: 'LINE Developersで同じプロバイダーにあることを確かめた' }))
  fireEvent.click(screen.getByRole('button', { name: '接続を確かめる' }))
  await waitFor(() => expect(calls.check).toHaveBeenCalledTimes(1))
  expect.soft(calls.check).toHaveBeenCalledWith(expect.objectContaining({ importFriends: finalChoice }))
  await waitFor(() => expect((screen.getByRole('button', { name: '登録する' }) as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 })
  fireEvent.click(screen.getByRole('button', { name: '登録する' }))
  await waitFor(() => expect(calls.connect).toHaveBeenCalledWith(expect.objectContaining({ importFriends: finalChoice }), undefined))
  expect(calls.connect).toHaveBeenCalledTimes(1)
})

it.each([false, true])('再訪時は最終選択 %s を保ち、新しくQ2に答えた時だけ変える', async saved => {
  const key = savedChoice(saved)
  render(<AccountRegisterV8 />)
  expect((screen.getByRole('radio', { name: 'はい、あります' }) as HTMLInputElement).checked).toBe(false)
  const stored = () => JSON.parse(localStorage.getItem(key)!)
  await waitFor(() => expect(stored().step).toBe(1))
  expect(stored().importFriends).toBe(saved)
  fireEvent.click(screen.getByRole('radio', { name: 'はい、あります' }))
  expect(stored().importFriends).toBe(saved)
  fireEvent.click(screen.getByRole('radio', { name: saved ? 'いいえ、引き継ぎません' : 'はい、引き継ぎます' }))
  await waitFor(() => expect(stored().importFriends).toBe(!saved))
  expect(calls.check).not.toHaveBeenCalled(); expect(calls.connect).not.toHaveBeenCalled()
})
