// @vitest-environment happy-dom
import { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity, readStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'
import type { LineAccountConnectData } from '@/lib/api'
import AccountRegisterV8 from './register'
import { allV06RowsOk, checkErrorText, LOGIN_ACKS, toV06CheckRows, toV8CheckRows, WEBHOOK_ACKS } from './logic'

const calls = vi.hoisted(() => ({ me: vi.fn(), connect: vi.fn(), check: vi.fn(), receipt: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { staff: { me: calls.me }, lineAccounts: { connect: calls.connect, connectCheck: calls.check, registrationReceipt: calls.receipt, get: vi.fn(async () => ({ success: false })) } } }))
vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: { get: vi.fn() } }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/lib/qr-image', () => ({ qrToDataURL: vi.fn(async () => '') }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/components/hq/notice-line-register-dialog', () => ({ default: () => null }))

const result = (): LineAccountConnectData => ({
  steps: [1, 2, 3, 4, 5].map(order => ({ order: order as 1, state: 'passed', message: '認証済み' })),
  basicId: '@fixture', pictureUrl: null,
  verification: { tokenOk: true, loginOk: true, sameProvider: true, followerTotal: null,
    webhook: { expectedUrl: 'https://worker.test/webhook/1234567890', registeredUrl: 'https://worker.test/webhook/1234567890', active: true, testPassed: true } },
  followerImport: { capability: 'unknown', phase: 'not_started' }, remainingActions: [],
})
const manualGuidance = 'プロバイダーの所属は自動では照合していません。'
const unsupportedClaim = /同じプロバイダーの中にありました|別のプロバイダーにありました|作り直してください|ここで分かります/
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); verifiedStaffRole('owner')
  act(() => rememberStaffIdentity({ ...readStaffIdentity()!, id: 'owner-a', tenantId: 'tenant-a' }))
  calls.me.mockImplementation(() => new Promise(() => {}))
  calls.check.mockResolvedValue({ success: true, data: result() })
  calls.connect.mockResolvedValue({ success: true, data: { ...result(), id: 'mock-account' } })
  calls.receipt.mockResolvedValue({ success: true, data: { status: 'waiting', receivedAt: null } })
})
afterEach(() => { cleanup(); forgetStaffIdentity(); vi.restoreAllMocks() })

it.each([false, true])('保存済みIDの有無 %s にかかわらず、成功行は所属でなく認証の事実を示す', saved => {
  const connection = { ...result(), ...(saved ? { id: 'mock-account' } : {}) }
  const rows = toV06CheckRows(connection, { running: false, cursor: 5 })
  expect(rows[1]).toMatchObject({ title: '2つのチャネルの認証', detail: '両方のチャネルで認証できました。', phase: 'ok' })
  expect(toV8CheckRows(connection)[1]).toMatchObject({ title: '2つのチャネルの認証', detail: 'Messaging API・LINEログインの認証結果' })
  expect(JSON.stringify(rows)).not.toMatch(unsupportedClaim)
  expect(allV06RowsOk(rows)).toBe(true)
})

it.each([1, 4])('段%sの認証失敗を所属不一致と断定せず、従来どおり登録を止める', order => {
  const connection = result()
  connection.steps[order - 1].state = 'failed'
  connection.verification!.sameProvider = false
  if (order === 1) connection.verification!.tokenOk = false
  else connection.verification!.loginOk = false
  for (const response of [connection, { ...connection, verification: undefined }]) {
    const rows = toV06CheckRows(response, { running: false, cursor: 5 })
    expect(rows[0].phase).toBe('error'); expect(rows[1].phase).toBe('error')
    expect(allV06RowsOk(rows)).toBe(false)
    expect(rows[1].detail).toContain('チャネルIDとチャネルシークレットを確認')
    expect(JSON.stringify(rows)).not.toMatch(unsupportedClaim)
    const notice = checkErrorText('error', [rows[1], ...rows.slice(2)])!
    expect(notice.tone).toBe('danger')
    expect(notice.title).toBe('2つのチャネルの認証情報を確認してください')
    expect(notice.body).toContain('入力済みの内容はそのまま残っています')
    expect(notice.body).not.toMatch(unsupportedClaim)
  }
})

it('古い応答とsameProvider=falseの判定を変えない', () => {
  expect(allV06RowsOk(toV06CheckRows({ ...result(), verification: undefined }, { running: false, cursor: 5 }))).toBe(true)
  const connection = result(); connection.verification!.sameProvider = false
  expect(toV06CheckRows(connection, { running: false, cursor: 5 })[1].phase).toBe('waiting')
  expect(allV06RowsOk(toV06CheckRows(connection, { running: false, cursor: 5 }))).toBe(false)
})

function confirmation() {
  render(<AccountRegisterV8 />)
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
function expectNoManualGuidance() {
  expect(screen.queryByText(manualGuidance, { exact: false })).toBeNull()
  expect(screen.queryByRole('checkbox', { name: /同じプロバイダー/ })).toBeNull()
}

it('確認前から登録後まで、プロバイダーの手動確認を表示しない', async () => {
  confirmation(); expectNoManualGuidance()
  expect(screen.getByText('両方のチャネルの認証結果を確認します。')).toBeTruthy()
  expect(document.body.textContent).not.toMatch(unsupportedClaim)
  expect(calls.check).not.toHaveBeenCalled(); expect(calls.connect).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '接続を確かめる' }))
  await waitFor(() => expect((screen.getByRole('button', { name: '登録する' }) as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 })
  expectNoManualGuidance(); expect(document.body.textContent).not.toMatch(unsupportedClaim)
  fireEvent.click(screen.getByRole('button', { name: '登録する' }))
  await screen.findByText('友だち追加できるか確かめます')
  expectNoManualGuidance(); expect(document.body.textContent).not.toMatch(unsupportedClaim)
  expect(calls.connect).toHaveBeenCalledTimes(1)
})

it.each([1, 4])('段%sの認証が失敗したら登録APIを呼ばず、再確認できる', async order => {
  const connection = result(); connection.steps[order - 1].state = 'failed'
  connection.verification!.sameProvider = false
  if (order === 1) connection.verification!.tokenOk = false
  else connection.verification!.loginOk = false
  calls.check.mockResolvedValue({ success: true, data: connection })
  confirmation();
  fireEvent.click(screen.getByRole('button', { name: '接続を確かめる' }))
  await screen.findByRole('button', { name: 'もう一度確かめる' }, { timeout: 5000 })
  expectNoManualGuidance(); expect(document.body.textContent).not.toMatch(unsupportedClaim)
  const register = screen.queryByRole('button', { name: '登録する' }) as HTMLButtonElement | null
  expect(register === null || register.disabled).toBe(true)
  expect(calls.connect).not.toHaveBeenCalled()
})

it('接続情報が空なら理由を示し、次へで最初の誤りへ焦点を移す', () => {
  render(<AccountRegisterV8 />)
  fireEvent.click(screen.getByRole('radio', { name: 'はい、あります' }))
  fireEvent.click(screen.getByRole('radio', { name: 'いいえ、引き継ぎません' }))
  fireEvent.click(screen.getByRole('radio', { name: '使っていません' }))
  fireEvent.click(screen.getByRole('button', { name: '次へ', exact: true }))
  const next = () => screen.getByRole('button', { name: '次のステップへ' }) as HTMLButtonElement
  expect(next().disabled).toBe(false)
  expect(screen.getByText('チャネルIDとチャネルシークレットを入力してください。')).toBeTruthy()
  fireEvent.click(next())
  expect(document.activeElement).toBe(document.getElementById('v8-channel-id'))
  fireEvent.change(document.getElementById('v8-channel-id')!, { target: { value: '1234567890' } })
  expect(next().disabled).toBe(false)
  fireEvent.change(document.getElementById('v8-channel-secret')!, { target: { value: 'a'.repeat(32) } })
  expect(next().disabled).toBe(false)
  fireEvent.click(next())
  expect(next().disabled).toBe(false)
  expect(screen.getByText('プロバイダーIDを入力してください。')).toBeTruthy()
  expect(calls.check).not.toHaveBeenCalled()
  expect(calls.connect).not.toHaveBeenCalled()
})

it('接続確認の通信失敗を操作内容より先に表示し、再確認できる', async () => {
  calls.check.mockRejectedValueOnce(new Error('offline'))
  confirmation()
  fireEvent.click(screen.getByRole('button', { name: '接続を確かめる' }))
  const notice = await screen.findByText(/接続の確認結果を確認できませんでした/)
  const card = screen.getByRole('region', { name: '接続確認' })
  expect(notice.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.getByRole('button', { name: 'もう一度確かめる' })).toBeTruthy()
  expect(calls.connect).not.toHaveBeenCalled()
})

it('入力エラーが出たあと、ほかの欄へ焦点を移せる', () => {
  render(<AccountRegisterV8 />)
  fireEvent.click(screen.getByRole('radio', { name: 'はい、あります' }))
  fireEvent.click(screen.getByRole('radio', { name: 'いいえ、引き継ぎません' }))
  fireEvent.click(screen.getByRole('radio', { name: '使っていません' }))
  fireEvent.click(screen.getByRole('button', { name: '次へ', exact: true }))
  const id = document.getElementById('v8-channel-id') as HTMLInputElement
  const secret = document.getElementById('v8-channel-secret') as HTMLInputElement
  id.focus()
  secret.focus()
  fireEvent.blur(id, { relatedTarget: secret })
  expect(screen.getByText('チャネルIDを入力してください。')).toBeTruthy()
  expect(document.activeElement).toBe(secret)
})
