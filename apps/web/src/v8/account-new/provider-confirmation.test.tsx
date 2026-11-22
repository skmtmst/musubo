// @vitest-environment happy-dom
import React, { act, Children, StrictMode, type ComponentProps } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ButtonProps } from '@/components/shared/button'
import type { StepUpRequest } from '@/components/step-up-prompt'
import type { Step2Field } from './step2-connect'
import { ApiError } from '@/lib/api'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity, readStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'
import { LOGIN_ACKS, WEBHOOK_ACKS } from './logic'
import { registrationStorageKey } from './registration-storage'
import { REGISTRATION_STYLE_KEY } from './use-registration-style'
import AccountRegisterV8 from './register'

const calls = vi.hoisted(() => ({
  me: vi.fn(), check: vi.fn(), connect: vi.fn(), receipt: vi.fn(), list: vi.fn(),
  oldCheck: undefined as (() => void) | undefined,
  update: undefined as ((key: Step2Field, value: string) => void) | undefined,
  retry: undefined as StepUpRequest['retry'] | undefined,
}))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, staff: { ...actual.api.staff, me: calls.me }, lineAccounts: {
    ...actual.api.lineAccounts, connectCheck: calls.check, connect: calls.connect, registrationReceipt: calls.receipt, list: calls.list,
  } } }
})
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/components/hq/notice-line-register-dialog', () => ({ default: () => null }))
vi.mock('./resume-style', () => ({ default: () => null }))
vi.mock('@/lib/api/helpers/styles', () => ({
  styleApi: { get: vi.fn(async () => ({ success: true, data: { style: 'standard', styleSelected: false, version: 0 } })) },
}))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/lib/qr-image', () => ({ qrToDataURL: vi.fn(async () => '') }))
vi.mock('@/components/shared/button', async original => {
  const actual = await original<typeof import('@/components/shared/button')>()
  const Button = actual.default
  return { ...actual, default: (props: ButtonProps) => {
    if (props.href !== undefined || !props.onClick) return <Button {...props} />
    const native = props as Extract<ButtonProps, { href?: never }>
    const originalClick = native.onClick!
    const check = Children.toArray(props.children).some(child => typeof child === 'string' && /接続を確かめる|もう一度確かめる/.test(child))
    return <Button {...native} onClick={event => {
      if (check) calls.oldCheck = () => originalClick(event)
      originalClick(event)
    }} />
  } }
})
vi.mock('./step2-connect', async original => {
  const actual = await original<typeof import('./step2-connect')>()
  const Step2 = actual.default
  return { ...actual, default: (props: ComponentProps<typeof Step2>) => {
    calls.update = props.onUpdate
    return <Step2 {...props} />
  } }
})
vi.mock('@/components/step-up-prompt', async original => {
  const actual = await original<typeof import('@/components/step-up-prompt')>()
  return { ...actual, default: ({ request }: { request: StepUpRequest }) => {
    calls.retry = request.retry
    return <div role="dialog" aria-label="登録の本人確認" />
  } }
})

const label = 'LINE Developersで同じプロバイダーにあることを確かめた'
const checked = {
  steps: [1, 2, 3, 4, 5].map(order => ({ order, state: 'passed', message: '確認済み' })),
  basicId: '@fixture', pictureUrl: null,
  verification: { tokenOk: true, loginOk: true, sameProvider: true, followerTotal: null,
    webhook: { expectedUrl: 'https://worker.test/webhook/1234567890', registeredUrl: 'https://worker.test/webhook/1234567890', active: true, testPassed: true } },
  followerImport: { capability: 'unknown', phase: 'not_started' }, remainingActions: [],
}
const fields = [
  ['channelId', '1234567891'], ['channelSecret', 'c'.repeat(32)], ['providerId', '2000000003'],
  ['loginChannelId', '2000000004'], ['loginChannelSecret', 'd'.repeat(32)],
] as const
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks()
  calls.oldCheck = undefined; calls.update = undefined; calls.retry = undefined
  verifiedStaffRole('owner')
  act(() => rememberStaffIdentity({ ...readStaffIdentity()!, id: 'owner-a', tenantId: 'tenant-a' }))
  calls.me.mockImplementation(() => new Promise(() => {}))
  calls.check.mockResolvedValue({ success: true, data: checked })
  calls.connect.mockResolvedValue({ success: true, data: { ...checked, id: 'mock-account' } })
  calls.receipt.mockResolvedValue({ success: true, data: { status: 'waiting', receivedAt: null } })
  calls.list.mockResolvedValue({ success: true, data: [] })
})
afterEach(() => { cleanup(); forgetStaffIdentity(); vi.restoreAllMocks() })

function advanceToConfirmation() {
  fireEvent.click(screen.getByRole('radio', { name: 'はい、あります' }))
  fireEvent.click(screen.getByRole('radio', { name: 'いいえ、引き継ぎません' }))
  fireEvent.click(screen.getByRole('radio', { name: '使っていません' }))
  fireEvent.click(screen.getByRole('button', { name: '次へ', exact: true }))
  const fill = (id: string, value: string) => fireEvent.change(document.getElementById(id)!, { target: { value } })
  const next = () => fireEvent.click(screen.getByRole('button', { name: '次のステップへ' }))
  fill('v8-channel-id', '1234567890'); fill('v8-channel-secret', 'a'.repeat(32)); next()
  fill('v8-provider-id', '2000000001'); next()
  WEBHOOK_ACKS.forEach(ack => fireEvent.click(screen.getByRole('checkbox', { name: ack.label }))); next()
  fill('v8-login-channel-id', '2000000002'); fill('v8-login-channel-secret', 'b'.repeat(32))
  LOGIN_ACKS.forEach(ack => fireEvent.click(screen.getByRole('checkbox', { name: ack.label }))); next()
}
function open(strict = false) {
  const view = render(strict ? <StrictMode><AccountRegisterV8 /></StrictMode> : <AccountRegisterV8 />)
  advanceToConfirmation()
  return view
}
const confirmation = () => screen.getByRole('checkbox', { name: label }) as HTMLInputElement
const checkButton = () => screen.getByRole('button', { name: '接続を確かめる' }) as HTMLButtonElement
const registerButton = () => screen.getByRole('button', { name: '登録する' }) as HTMLButtonElement
const agree = () => fireEvent.click(confirmation())
function submit() { fireEvent.submit(document.querySelector('form')!) }
async function confirmProviderAndCheck() {
  agree(); fireEvent.click(checkButton())
  await waitFor(() => expect(registerButton().disabled).toBe(false), { timeout: 5000 })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

it('最初は未確認で、接続確認とフォームからの登録を起動しない', () => {
  open()
  expect(confirmation().checked).toBe(false)
  expect(checkButton().disabled).toBe(true)
  expect(screen.getAllByText('接続の確認と登録の前に、このチェックで確認してください。')).toHaveLength(1)
  fireEvent.click(checkButton()); submit()
  expect(calls.check).not.toHaveBeenCalled(); expect(calls.connect).not.toHaveBeenCalled()
})
it('初回登録は追加の本人確認を挟まず、LINE受信が確認できたら使い方を開く', async () => {
  calls.receipt.mockResolvedValue({ success: true, data: { status: 'confirmed', receivedAt: '2026-11-03T00:00:00Z' } })
  open(); await confirmProviderAndCheck(); submit()
  await screen.findByRole('dialog', { name: '使い方のスタイルを選ぶ' })
  expect(screen.queryByRole('dialog', { name: '登録の本人確認' })).toBeNull()
  expect(calls.connect).toHaveBeenCalledTimes(1)
  expect(calls.receipt).toHaveBeenCalledExactlyOnceWith('mock-account')
  expect(screen.queryByText('友だち追加できるか確かめます')).toBeNull()
  const key = registrationStorageKey(REGISTRATION_STYLE_KEY, { id: 'owner-a', tenantId: 'tenant-a' })!
  expect(sessionStorage.getItem(key)).toBe('mock-account')
})
it('引き継ぎを選んだ時だけ行う説明と、自然な確認ボタンを出す', () => {
  open()
  expect(screen.getByText('チェックすると、登録後にいまの友だちを musubo に引き継ぎます（数分かかります）')).toBeTruthy()
  expect(screen.getByRole('button', { name: '登録内容を見る' })).toBeTruthy()
})
it.each([false, true])('登録したアカウントの引き継ぎ選択 %s を本人の端末に保存する', async choice => {
  open()
  if (choice) fireEvent.click(screen.getByRole('checkbox', { name: 'いまの友だちの引き継ぎ' }))
  await confirmProviderAndCheck(); submit()
  await screen.findByText('友だち追加できるか確かめます')
  const key = registrationStorageKey(REGISTRATION_STYLE_KEY, { id: 'owner-a', tenantId: 'tenant-a' })!
  expect(localStorage.getItem(`${key}:import:mock-account`)).toBe(String(choice))
})
it.each([false, true])('人が確認し5行も通った時だけ登録し、既存の引き継ぎ選択%sを送る', async importFriends => {
  open()
  if (importFriends) fireEvent.click(screen.getByRole('checkbox', { name: 'いまの友だちの引き継ぎ' }))
  await confirmProviderAndCheck()
  submit()
  await screen.findByText('友だち追加できるか確かめます')
  expect(calls.check).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ importFriends }))
  expect(calls.connect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ importFriends }), undefined)
  for (const input of [calls.check.mock.calls[0][0], calls.connect.mock.calls[0][0]]) {
    expect(Object.keys(input).sort()).toEqual(['channelId', 'channelSecret', 'importFriends', 'loginChannelId', 'loginChannelSecret', 'name', 'parentLineAccountId', 'staffIds', 'tagIds'].sort())
  }
})
it('本人確認ONでもLINE認証が失敗したら登録しない', async () => {
  calls.check.mockResolvedValue({ success: true, data: { ...checked, verification: { ...checked.verification, tokenOk: false }, steps: checked.steps.map(item => item.order === 1 ? { ...item, state: 'failed' } : item) } })
  open(); agree(); fireEvent.click(checkButton())
  await screen.findByRole('button', { name: 'もう一度確かめる' }, { timeout: 5000 })
  submit()
  expect(calls.connect).not.toHaveBeenCalled()
})
it('同tickの解除後にフォームを送っても登録せず、確認ONの旧callbackも復活しない', async () => {
  open(); await confirmProviderAndCheck()
  const oldCheck = calls.oldCheck!
  act(() => { fireEvent.click(confirmation()); submit() })
  expect(screen.queryByRole('button', { name: '登録する' })).toBeNull()
  expect(calls.connect).not.toHaveBeenCalled()
  agree()
  act(() => oldCheck())
  expect(calls.check).toHaveBeenCalledTimes(1)
})
it.each(fields)('%s更新で本人確認を取り消し、旧確認callbackから送らない', async (key, value) => {
  open(); await confirmProviderAndCheck()
  const oldCheck = calls.oldCheck!
  act(() => calls.update!(key, value))
  expect(confirmation().checked).toBe(false)
  agree(); act(() => oldCheck())
  expect(calls.check).toHaveBeenCalledTimes(1); expect(calls.connect).not.toHaveBeenCalled()
})
it.each(['success', 'failure'] as const)('接続確認中に解除した後の遅い%sを使わず、旧callbackを止める', async outcome => {
  const request = deferred<{ success: true; data: typeof checked }>()
  calls.check.mockReturnValueOnce(request.promise)
  open(); agree(); fireEvent.click(checkButton())
  const oldCheck = calls.oldCheck!
  agree(); agree()
  act(() => oldCheck())
  expect(calls.check).toHaveBeenCalledTimes(1)
  await act(async () => {
    if (outcome === 'success') request.resolve({ success: true, data: checked })
    else request.reject(new Error('fixture delayed failure'))
    await request.promise.catch(() => {})
  })
  expect(screen.queryByRole('button', { name: '登録する' })).toBeNull()
  act(() => oldCheck())
  expect(calls.check).toHaveBeenCalledTimes(1); expect(calls.connect).not.toHaveBeenCalled()
})
it.each(fields)('接続確認中の%s更新後に旧成功を表示せず、再確認前の実行0', async (key, value) => {
  const request = deferred<{ success: true; data: typeof checked }>()
  calls.check.mockReturnValueOnce(request.promise)
  open(); agree(); fireEvent.click(checkButton())
  act(() => calls.update!(key, value))
  expect(confirmation().checked).toBe(false)
  await act(async () => { request.resolve({ success: true, data: checked }); await request.promise })
  expect(screen.queryByRole('button', { name: '登録する' })).toBeNull()
  submit(); expect(calls.connect).not.toHaveBeenCalled()
})
it('登録中に解除しても追加送信せず、既に受理された登録のIDを捨てない', async () => {
  const request = deferred<{ success: true; data: typeof checked & { id: string } }>()
  calls.connect.mockReturnValueOnce(request.promise)
  open(); await confirmProviderAndCheck(); submit()
  agree(); agree(); submit()
  expect(calls.connect).toHaveBeenCalledTimes(1)
  await act(async () => { request.resolve({ success: true, data: { ...checked, id: 'accepted-before-withdrawal' } }); await request.promise })
  await screen.findByText('友だち追加できるか確かめます')
  const ownKey = registrationStorageKey(REGISTRATION_STYLE_KEY, { id: 'owner-a', tenantId: 'tenant-a' })!
  const foreignKey = registrationStorageKey(REGISTRATION_STYLE_KEY, { id: 'owner-a', tenantId: 'tenant-b' })!
  expect(sessionStorage.getItem(ownKey)).toBe('receipt:accepted-before-withdrawal')
  expect(sessionStorage.getItem(foreignKey)).toBeNull()
  await waitFor(() => expect(calls.receipt).toHaveBeenCalledWith('accepted-before-withdrawal'))
  act(() => calls.oldCheck!())
  expect(calls.check).toHaveBeenCalledTimes(1); expect(calls.connect).toHaveBeenCalledTimes(1)
})
it('応答受信後の5行表示中にOFFして再ONしても、再確認が成功するまで登録しない', async () => {
  const request = deferred<{ success: true; data: typeof checked }>()
  calls.check.mockReturnValueOnce(request.promise)
  open(); agree(); fireEvent.click(checkButton())
  await act(async () => { request.resolve({ success: true, data: checked }); await request.promise })
  expect(screen.queryByRole('button', { name: '登録する' })).toBeNull()
  agree(); agree(); submit()
  expect(calls.check).toHaveBeenCalledTimes(1)
  expect(calls.connect).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: '登録する' })?.hasAttribute('disabled') ?? true).toBe(true)
  fireEvent.click(checkButton())
  await waitFor(() => expect(registerButton().disabled).toBe(false), { timeout: 5000 })
  submit()
  await screen.findByText('友だち追加できるか確かめます')
  expect(calls.check).toHaveBeenCalledTimes(2)
  expect(calls.connect).toHaveBeenCalledTimes(1)
})
it('完了した確認もOFFで破棄され、再ONだけでは登録できない', async () => {
  open(); await confirmProviderAndCheck()
  agree(); agree(); submit()
  expect(calls.connect).not.toHaveBeenCalled()
  fireEvent.click(checkButton())
  await waitFor(() => expect(registerButton().disabled).toBe(false), { timeout: 5000 })
  submit(); await screen.findByText('友だち追加できるか確かめます')
  expect(calls.check).toHaveBeenCalledTimes(2); expect(calls.connect).toHaveBeenCalledTimes(1)
})
it('登録中に入力が変わり応答を失っても、送信時のチャネルIDで登録済みを探す', async () => {
  const request = deferred<never>()
  calls.connect.mockReturnValueOnce(request.promise)
  calls.list.mockResolvedValue({ success: true, data: [
    { id: 'saved-original', channelId: '1234567890', name: '送信時' },
    { id: 'other-after-change', channelId: '1234567891', name: '変更後' },
  ] })
  open(); await confirmProviderAndCheck(); submit()
  expect(calls.connect.mock.calls[0][0].channelId).toBe('1234567890')
  act(() => calls.update!('channelId', '1234567891'))
  await act(async () => { request.reject(new Error('fixture response lost')); await request.promise.catch(() => {}) })
  await screen.findByText('保存は終わっている可能性があります。登録済みのアカウントを開いて確認してください。')
  expect(calls.list).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('link', { name: '登録したアカウントを見る' }).getAttribute('href')).toBe('/accounts/detail?id=saved-original')
  expect(calls.connect).toHaveBeenCalledTimes(1)
})
it.each(fields)('登録中に%sを更新しても新規送信せず、送信済みの成功を取消と扱わない', async (key, value) => {
  const request = deferred<{ success: true; data: typeof checked & { id: string } }>()
  calls.connect.mockReturnValueOnce(request.promise)
  open(); await confirmProviderAndCheck(); submit()
  act(() => calls.update!(key, value))
  expect(confirmation().checked).toBe(false)
  submit(); expect(calls.connect).toHaveBeenCalledTimes(1)
  await act(async () => { request.resolve({ success: true, data: { ...checked, id: 'accepted-original-request' } }); await request.promise })
  await screen.findByText('友だち追加できるか確かめます')
  expect(calls.connect).toHaveBeenCalledTimes(1)
})
it('本人確認後のstep-up再試行は、解除や再確認後の旧callbackでは登録しない', async () => {
  calls.connect.mockRejectedValueOnce(new ApiError(428, '本人確認', 'STEP_UP_REQUIRED'))
  open(); await confirmProviderAndCheck(); submit()
  await screen.findByRole('dialog', { name: '登録の本人確認' })
  const retry = calls.retry!
  agree(); expect(screen.queryByRole('dialog', { name: '登録の本人確認' })).toBeNull()
  await act(async () => retry('fixture-grant'))
  agree(); await act(async () => retry('fixture-old-grant'))
  expect(calls.connect).toHaveBeenCalledTimes(1)
})
it('同じ対象を確認したままのstep-up再試行は従来のgrantを渡す', async () => {
  calls.connect.mockRejectedValueOnce(new ApiError(428, '本人確認', 'STEP_UP_REQUIRED'))
  open(); await confirmProviderAndCheck(); submit()
  await screen.findByRole('dialog', { name: '登録の本人確認' })
  await act(async () => calls.retry!('fixture-grant'))
  expect(calls.connect).toHaveBeenCalledTimes(2)
  expect(calls.connect.mock.calls[1][1]).toBe('fixture-grant')
})
it('登録中の解除後に遅いstep-up要求が来ても、新しい本人確認を開かない', async () => {
  const request = deferred<never>()
  calls.connect.mockReturnValueOnce(request.promise)
  open(); await confirmProviderAndCheck(); submit(); agree()
  await act(async () => { request.reject(new ApiError(428, '本人確認', 'STEP_UP_REQUIRED')); await request.promise.catch(() => {}) })
  expect(screen.queryByRole('dialog', { name: '登録の本人確認' })).toBeNull()
  expect(calls.connect).toHaveBeenCalledTimes(1)
})
it('同じ画面内で入力を変えず戻った場合だけ確認ONを保つ', async () => {
  open(); agree()
  fireEvent.click(screen.getByRole('button', { name: 'LINEログインへ戻る' }))
  fireEvent.click(screen.getByRole('button', { name: '次のステップへ' }))
  expect(confirmation().checked).toBe(true)
})
it('本人チェックだけを変えても端末の下書きや保存先を増やさない', () => {
  open()
  const stored = () => Object.fromEntries(Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)]))
  const before = stored()
  agree(); expect(stored()).toEqual(before)
  agree(); expect(stored()).toEqual(before)
  expect(calls.check).not.toHaveBeenCalled(); expect(calls.connect).not.toHaveBeenCalled()
})
it('再訪はOFFで、消えた画面の旧callbackから問い合わせない', async () => {
  const view = open(); await confirmProviderAndCheck(); const oldCheck = calls.oldCheck!
  calls.me.mockResolvedValue({ success: true, data: readStaffIdentity()! })
  view.unmount(); render(<AccountRegisterV8 />)
  await screen.findByRole('radio', { name: 'はい、あります' })
  advanceToConfirmation()
  expect(confirmation().checked).toBe(false)
  agree(); act(() => oldCheck())
  expect(calls.check).toHaveBeenCalledTimes(1)
})
it.each([['owner-b', 'tenant-a'], ['owner-a', 'tenant-b']] as const)('本人/統括が%s/%sへ変わればOFFで始まる', (id, tenantId) => {
  open(); agree()
  act(() => rememberStaffIdentity({ ...readStaffIdentity()!, id, tenantId }))
  advanceToConfirmation()
  expect(confirmation().checked).toBe(false)
  expect(calls.check).not.toHaveBeenCalled(); expect(calls.connect).not.toHaveBeenCalled()
})
it('StrictModeでも最初はOFFで、本人の明示確認後だけ接続を確かめる', async () => {
  calls.me.mockResolvedValue({ success: true, data: readStaffIdentity()! })
  render(<StrictMode><AccountRegisterV8 /></StrictMode>)
  await screen.findByRole('radio', { name: 'はい、あります' })
  advanceToConfirmation(); expect(confirmation().checked).toBe(false)
  await confirmProviderAndCheck()
  expect(calls.check).toHaveBeenCalledTimes(1)
})
it('接続確認が同期でthrowしてもbusyを解除し、未確認への自動再送はしない', async () => {
  calls.check.mockImplementationOnce(() => { throw new Error('fixture sync failure') })
  open(); agree(); fireEvent.click(checkButton())
  await screen.findByRole('button', { name: 'もう一度確かめる' })
  agree()
  act(() => calls.oldCheck!())
  expect(calls.check).toHaveBeenCalledTimes(1); expect(calls.connect).not.toHaveBeenCalled()
})
