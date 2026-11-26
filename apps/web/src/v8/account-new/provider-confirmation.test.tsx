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
  me: vi.fn(), check: vi.fn(), connect: vi.fn(), receipt: vi.fn(), list: vi.fn(), resume: vi.fn(), account: vi.fn(),
  retryStyle: vi.fn(), getStyle: vi.fn(async () => ({ success: true, data: { style: 'standard', styleSelected: false, version: 0, shouldPromptStyleSelection: false } })),
  oldCheck: undefined as (() => void) | undefined,
  update: undefined as ((key: Step2Field, value: string) => void) | undefined,
  retry: undefined as StepUpRequest['retry'] | undefined,
}))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, staff: { ...actual.api.staff, me: calls.me }, lineAccounts: {
    ...actual.api.lineAccounts, connectCheck: calls.check, connect: calls.connect, registrationReceipt: calls.receipt, list: calls.list, registrationResume: calls.resume, get: calls.account,
  } } }
})
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/components/hq/notice-line-register-dialog', () => ({ default: () => null }))
vi.mock('@/lib/api/helpers/styles', () => ({
  styleApi: { get: calls.getStyle, retryRegistrationInitialization: calls.retryStyle },
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
  calls.resume.mockResolvedValue({ success: false })
  calls.account.mockResolvedValue({ success: false })
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
const checkButton = () => screen.getByRole('button', { name: '接続を確かめる' }) as HTMLButtonElement
const registerButton = () => screen.getByRole('button', { name: '登録する' }) as HTMLButtonElement
function submit() { fireEvent.submit(document.querySelector('form')!) }
async function checkConnection() {
  fireEvent.click(checkButton())
  await waitFor(() => expect(registerButton().disabled).toBe(false), { timeout: 5000 })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

it('③では手動チェックなしで接続を確かめられ、5行が通るまでは登録できない', async () => {
  open()
  expect(screen.queryByRole('checkbox', { name: /同じプロバイダー/ })).toBeNull()
  expect(checkButton().disabled).toBe(false)
  submit()
  expect(calls.check).not.toHaveBeenCalled()
  expect(calls.connect).not.toHaveBeenCalled()
  await checkConnection()
  expect(calls.check).toHaveBeenCalledTimes(1)
})
it('初回登録は追加の本人確認を挟まず、LINE受信が確認できたら使い方を開く', async () => {
  calls.receipt.mockResolvedValue({ success: true, data: { status: 'confirmed', receivedAt: '2026-11-03T00:00:00Z' } })
  open(); await checkConnection(); submit()
  await screen.findByRole('dialog', { name: '使い方のスタイルを選ぶ' })
  expect(screen.queryByRole('dialog', { name: '登録の本人確認' })).toBeNull()
  expect(calls.connect).toHaveBeenCalledTimes(1)
  expect(calls.receipt).toHaveBeenCalledExactlyOnceWith('mock-account')
  expect(screen.queryByText('友だち追加できるか確かめます')).toBeNull()
  const key = registrationStorageKey(REGISTRATION_STYLE_KEY, { id: 'owner-a', tenantId: 'tenant-a' })!
  expect(sessionStorage.getItem(key)).toBe('mock-account')
})
it('初期設定の保存失敗後、同じアカウントとスタイルでやり直す', async () => {
  calls.connect.mockRejectedValueOnce(new ApiError(502, '保存失敗', 'style_save_failed', { accountId: 'mock-account', style: 'consult' }))
  calls.receipt.mockResolvedValue({ success: true, data: { status: 'confirmed' } })
  calls.retryStyle.mockRejectedValueOnce(new Error('failed')).mockResolvedValueOnce({ success: true, data: { version: 1 } })
  open(); await checkConnection(); submit()
  const button = await screen.findByRole('button', { name: 'もう一度保存する' })
  expect(screen.queryByRole('dialog', { name: '使い方のスタイルを選ぶ' })).toBeNull()
  fireEvent.click(button)
  await waitFor(() => expect(calls.retryStyle).toHaveBeenCalledTimes(1))
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度保存する' }))
  await waitFor(() => expect(calls.retryStyle).toHaveBeenCalledTimes(2))
  expect(calls.retryStyle).toHaveBeenLastCalledWith('mock-account', 'consult')
  expect(calls.connect).toHaveBeenCalledTimes(1)
})
it('保存後の応答が失われた場合は保存済みのスタイルを確認して先へ進む', async () => {
  calls.connect.mockRejectedValueOnce(new ApiError(502, '保存失敗', 'style_save_failed', { accountId: 'mock-account', style: 'consult' }))
  calls.receipt.mockResolvedValue({ success: true, data: { status: 'confirmed' } })
  calls.retryStyle.mockRejectedValueOnce(new ApiError(409, '競合', 'version_conflict'))
  calls.getStyle.mockResolvedValueOnce({ success: true, data: { style: 'consult', styleSelected: true, version: 1, shouldPromptStyleSelection: false } })
  open(); await checkConnection(); submit()
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度保存する' }))
  await waitFor(() => expect(screen.queryByText('初期設定を保存できませんでした')).toBeNull())
  expect(calls.getStyle).toHaveBeenCalledWith('mock-account', true)
})
it('引き継ぎを選んだ時だけ行う説明と、自然な確認ボタンを出す', () => {
  open()
  expect(screen.getByText('チェックすると、登録後にいまの友だちを musubo に引き継ぎます（数分かかります）')).toBeTruthy()
  expect(screen.getByRole('button', { name: '登録内容を見る' })).toBeTruthy()
})
it.each([false, true])('登録したアカウントの引き継ぎ選択 %s を本人の端末に保存する', async choice => {
  open()
  if (choice) fireEvent.click(screen.getByRole('checkbox', { name: 'いまの友だちの引き継ぎ' }))
  await checkConnection(); submit()
  await screen.findByText('友だち追加できるか確かめます')
  const key = registrationStorageKey(REGISTRATION_STYLE_KEY, { id: 'owner-a', tenantId: 'tenant-a' })!
  expect(localStorage.getItem(`${key}:import:mock-account`)).toBe(String(choice))
})
it.each([false, true])('接続確認の5行が通った時だけ登録し、既存の引き継ぎ選択%sを送る', async importFriends => {
  open()
  if (importFriends) fireEvent.click(screen.getByRole('checkbox', { name: 'いまの友だちの引き継ぎ' }))
  await checkConnection()
  submit()
  await screen.findByText('友だち追加できるか確かめます')
  expect(calls.check).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ importFriends }))
  expect(calls.connect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ importFriends }), undefined)
  for (const input of [calls.check.mock.calls[0][0], calls.connect.mock.calls[0][0]]) {
    expect(Object.keys(input).sort()).toEqual(['channelId', 'channelSecret', 'importFriends', 'loginChannelId', 'loginChannelSecret', 'name', 'parentLineAccountId', 'staffIds', 'tagIds'].sort())
  }
})
it('LINE認証が失敗したら登録しない', async () => {
  calls.check.mockResolvedValue({ success: true, data: { ...checked, verification: { ...checked.verification, tokenOk: false }, steps: checked.steps.map(item => item.order === 1 ? { ...item, state: 'failed' } : item) } })
  open(); fireEvent.click(checkButton())
  await screen.findByRole('button', { name: 'もう一度確かめる' }, { timeout: 5000 })
  submit()
  expect(calls.connect).not.toHaveBeenCalled()
})
it('同じ描画中にチャネルIDを変更して送信しても、旧確認で登録しない', async () => {
  open(); await checkConnection()
  const oldCheck = calls.oldCheck!
  act(() => {
    calls.update!('channelId', '1234567891')
    submit()
  })
  expect(screen.queryByRole('button', { name: '登録する' })).toBeNull()
  expect(calls.connect).not.toHaveBeenCalled()
  act(() => oldCheck())
  expect(calls.check).toHaveBeenCalledTimes(1)
})
it.each(fields)('%sの変更で接続確認を無効にし、旧確認操作から送らない', async (key, value) => {
  open(); await checkConnection()
  const oldCheck = calls.oldCheck!
  act(() => calls.update!(key, value))
  act(() => oldCheck())
  expect(calls.check).toHaveBeenCalledTimes(1); expect(calls.connect).not.toHaveBeenCalled()
})
it.each(['success', 'failure'] as const)('接続確認中にチャネルIDを変更して戻した後も、遅い%sを破棄し古い操作を無効にする', async outcome => {
  const request = deferred<{ success: true; data: typeof checked }>()
  calls.check.mockReturnValueOnce(request.promise)
  open(); fireEvent.click(checkButton())
  const oldCheck = calls.oldCheck!
  act(() => {
    calls.update!('channelId', '1234567891')
    calls.update!('channelId', '1234567890')
    oldCheck()
  })
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
  open(); fireEvent.click(checkButton())
  act(() => calls.update!(key, value))
  await act(async () => { request.resolve({ success: true, data: checked }); await request.promise })
  expect(screen.queryByRole('button', { name: '登録する' })).toBeNull()
  submit(); expect(calls.connect).not.toHaveBeenCalled()
})
it('同じ本人が先に登録を保存した場合は受信確認から続ける', async () => {
  calls.connect.mockRejectedValueOnce(new ApiError(409, 'このLINEチャネルは登録済みです'))
  calls.resume.mockResolvedValueOnce({ success: true, data: { accountId: 'already-created' } })
  open(); await checkConnection(); submit()
  await screen.findByText('友だち追加できるか確かめます')
  expect(calls.resume).toHaveBeenCalledWith('1234567890')
  expect(calls.receipt).toHaveBeenCalledWith('already-created')
  expect(calls.connect).toHaveBeenCalledTimes(1)
})

it('登録中に再度送信しても重複せず、受理された登録IDで受信を確かめる', async () => {
  const request = deferred<{ success: true; data: typeof checked & { id: string } }>()
  calls.connect.mockReturnValueOnce(request.promise)
  open(); await checkConnection(); submit()
  submit()
  expect(calls.connect).toHaveBeenCalledTimes(1)
  await act(async () => { request.resolve({ success: true, data: { ...checked, id: 'accepted-once' } }); await request.promise })
  await screen.findByText('友だち追加できるか確かめます')
  const ownKey = registrationStorageKey(REGISTRATION_STYLE_KEY, { id: 'owner-a', tenantId: 'tenant-a' })!
  const foreignKey = registrationStorageKey(REGISTRATION_STYLE_KEY, { id: 'owner-a', tenantId: 'tenant-b' })!
  expect(sessionStorage.getItem(ownKey)).toBe('receipt:accepted-once')
  expect(sessionStorage.getItem(foreignKey)).toBeNull()
  await waitFor(() => expect(calls.receipt).toHaveBeenCalledWith('accepted-once'))
  act(() => calls.oldCheck!())
  expect(calls.check).toHaveBeenCalledTimes(1); expect(calls.connect).toHaveBeenCalledTimes(1)
})
it('接続結果の5行を表示中に入力を変えたら、再確認が通るまで登録しない', async () => {
  const request = deferred<{ success: true; data: typeof checked }>()
  calls.check.mockReturnValueOnce(request.promise)
  open(); fireEvent.click(checkButton())
  await act(async () => { request.resolve({ success: true, data: checked }); await request.promise })
  expect(screen.queryByRole('button', { name: '登録する' })).toBeNull()
  act(() => calls.update!('channelId', '1234567891'))
  submit()
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
it('確認完了後にチャネルIDを変更して戻しても、再確認が通るまで登録しない', async () => {
  open(); await checkConnection()
  act(() => {
    calls.update!('channelId', '1234567891')
    calls.update!('channelId', '1234567890')
  })
  submit()
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
  open(); await checkConnection(); submit()
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
  open(); await checkConnection(); submit()
  act(() => calls.update!(key, value))
  submit(); expect(calls.connect).toHaveBeenCalledTimes(1)
  await act(async () => { request.resolve({ success: true, data: { ...checked, id: 'accepted-original-request' } }); await request.promise })
  await screen.findByText('友だち追加できるか確かめます')
  expect(calls.connect).toHaveBeenCalledTimes(1)
})
it('追加確認を求められた後に入力を変えると、以前の再試行からは登録しない', async () => {
  calls.connect.mockRejectedValueOnce(new ApiError(428, '本人確認', 'STEP_UP_REQUIRED'))
  open(); await checkConnection(); submit()
  await screen.findByRole('dialog', { name: '登録の本人確認' })
  const retry = calls.retry!
  act(() => calls.update!('channelId', '1234567891'))
  expect(screen.queryByRole('dialog', { name: '登録の本人確認' })).toBeNull()
  await act(async () => retry('fixture-grant'))
  await checkConnection()
  await act(async () => retry('fixture-old-grant'))
  expect(calls.connect).toHaveBeenCalledTimes(1)
})
it('同じ対象を確認したままのstep-up再試行は従来のgrantを渡す', async () => {
  calls.connect.mockRejectedValueOnce(new ApiError(428, '本人確認', 'STEP_UP_REQUIRED'))
  open(); await checkConnection(); submit()
  await screen.findByRole('dialog', { name: '登録の本人確認' })
  await act(async () => calls.retry!('fixture-grant'))
  expect(calls.connect).toHaveBeenCalledTimes(2)
  expect(calls.connect.mock.calls[1][1]).toBe('fixture-grant')
})
it('登録中に入力が変わった後で追加確認を求められても、本人確認を開かない', async () => {
  const request = deferred<never>()
  calls.connect.mockReturnValueOnce(request.promise)
  open(); await checkConnection(); submit()
  act(() => calls.update!('channelId', '1234567891'))
  await act(async () => { request.reject(new ApiError(428, '本人確認', 'STEP_UP_REQUIRED')); await request.promise.catch(() => {}) })
  expect(screen.queryByRole('dialog', { name: '登録の本人確認' })).toBeNull()
  expect(calls.connect).toHaveBeenCalledTimes(1)
})
it('再訪時に自動照合せず、消えた画面の古い確認操作から問い合わせない', async () => {
  const view = open(); await checkConnection(); const oldCheck = calls.oldCheck!
  calls.me.mockResolvedValue({ success: true, data: readStaffIdentity()! })
  view.unmount(); render(<AccountRegisterV8 />)
  await screen.findByRole('button', { name: '接続を確かめる' })
  act(() => oldCheck())
  expect(calls.check).toHaveBeenCalledTimes(1)
})
it.each([['owner-b', 'tenant-a'], ['owner-a', 'tenant-b']] as const)('本人・統括が%s/%sへ変わっても自動で接続や登録を送信しない', (id, tenantId) => {
  open()
  act(() => rememberStaffIdentity({ ...readStaffIdentity()!, id, tenantId }))
  advanceToConfirmation()
  expect(calls.check).not.toHaveBeenCalled(); expect(calls.connect).not.toHaveBeenCalled()
})
it('StrictModeでも接続確認の操作で一度だけ照合する', async () => {
  calls.me.mockResolvedValue({ success: true, data: readStaffIdentity()! })
  render(<StrictMode><AccountRegisterV8 /></StrictMode>)
  await screen.findByRole('radio', { name: 'はい、あります' })
  advanceToConfirmation()
  expect(calls.check).not.toHaveBeenCalled()
  await checkConnection()
  expect(calls.check).toHaveBeenCalledTimes(1)
})
it('接続確認が通信を始められない場合も、再試行を選べる', async () => {
  calls.check.mockImplementationOnce(() => { throw new Error('fixture sync failure') })
  open(); fireEvent.click(checkButton())
  await screen.findByRole('button', { name: 'もう一度確かめる' })
  expect(calls.check).toHaveBeenCalledTimes(1)
  expect(calls.connect).not.toHaveBeenCalled()
})
