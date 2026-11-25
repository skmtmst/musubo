// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EmailConnectionCard } from './email-card'

const fixture = vi.hoisted(() => ({
  connection: vi.fn(), verify: vi.fn(), issue: vi.fn(), disconnect: vi.fn(), refreshAccounts: vi.fn(),
  accounts: [],
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => fixture }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
vi.mock('@/lib/api', async (original) => ({
  ...await original<typeof import('@/lib/api')>(),
  api: { accountEmail: fixture },
}))
const response = (status: string, extra: object = {}) => ({
  success: true, data: { status, canReply: false, address: null, mailbox: null, forwardingConfirmation: null, ...extra },
})
beforeEach(() => {
  vi.clearAllMocks()
  fixture.connection.mockResolvedValue(response('disconnected'))
})
afterEach(cleanup)

it('転送の確認コードとメールサービス別の手順を表示して、店舗へ確認メールを送れる', async () => {
  fixture.connection.mockResolvedValue(response('setup', {
    address: 'inbox-fixture@example.org', mailbox: 'shop@example.org', forwardingConfirmation: '12345678',
  }))
  fixture.verify.mockResolvedValue(response('pending', { address: 'inbox-fixture@example.org' }))
  render(<EmailConnectionCard accountId="store-a" canManage lockedReason="" />)
  expect(await screen.findByText('12345678')).toBeTruthy()
  // 確認コードも入力欄ではなく読み取り専用の文字で出し、任意の札を付けない。
  expect(screen.queryByDisplayValue('12345678')).toBeNull()
  expect(screen.queryByText('任意')).toBeNull()
  expect(screen.getByRole('button', { name: '確認コードをコピーする' })).toBeTruthy()
  fireEvent.click(screen.getByRole('radio', { name: 'Yahoo!メール' }))
  expect(screen.getByText(/IMAP\/POP\/SMTP/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '確認メールを送る' }))
  expect(fixture.verify).toHaveBeenCalledWith('store-a')
  expect(await screen.findByText('受信確認待ち')).toBeTruthy()
})

it('閲覧のみの利用者に接続できない理由を表示する', async () => {
  render(<EmailConnectionCard accountId="store-a" canManage={false} lockedReason="管理者へ依頼してください" />)
  const button = await screen.findByRole('button', { name: 'メールをつなぐ' })
  fireEvent.click(button)
  expect(fixture.issue).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('メールをつなぐ窓で打ちかけのアドレスがあるとき、画面を離れる前に確かめ、続けるなら入力を残す', async () => {
  render(<EmailConnectionCard accountId="store-a" canManage lockedReason="" />)
  fireEvent.click(await screen.findByRole('button', { name: 'メールをつなぐ' }))
  const mailbox = () => document.getElementById('sns-email-mailbox') as HTMLInputElement | null
  fireEvent.change(mailbox()!, { target: { value: 'shop@example.org' } })
  const leave = vi.fn()
  const { requestUnsavedAction } = await import('@/lib/unsaved-action')
  act(() => requestUnsavedAction(leave))
  expect(leave).not.toHaveBeenCalled()
  expect(screen.getByText('保存していない変更があります')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '編集を続ける' }))
  expect(leave).not.toHaveBeenCalled()
  expect(mailbox()?.value).toBe('shop@example.org')

  act(() => requestUnsavedAction(leave))
  fireEvent.click(screen.getByRole('button', { name: '保存せずに移る' }))
  expect(leave).toHaveBeenCalledTimes(1)
  expect(fixture.issue).not.toHaveBeenCalled()
  expect(mailbox()).toBeNull()
})

it('メールをつなぐ窓を開いても、何も打っていなければ画面の移動を止めない', async () => {
  render(<EmailConnectionCard accountId="store-a" canManage lockedReason="" />)
  fireEvent.click(await screen.findByRole('button', { name: 'メールをつなぐ' }))
  const leave = vi.fn()
  const { requestUnsavedAction } = await import('@/lib/unsaved-action')
  act(() => requestUnsavedAction(leave))
  expect(leave).toHaveBeenCalledTimes(1)
  expect(screen.queryByText('保存していない変更があります')).toBeNull()
})

it.each([
  ['未接続', 'disconnected', {}],
  ['接続済み', 'connected', { address: 'inbox-fixture@example.org', mailbox: 'shop@example.org', connectionId: 'connection-a' }],
  ['接続切れ', 'revoked', {}],
] as const)('%sのメールの枠は、受信箱と同じ言葉で受信専用であることと返信の経路を伝える', async (_label, status, extra) => {
  fixture.connection.mockResolvedValue(response(status, extra))
  render(<EmailConnectionCard accountId="store-a" canManage lockedReason="" />)
  expect(await screen.findByText('転送メールは受信専用です。返信は共通メールか LINE から')).toBeTruthy()
  expect(screen.queryByText(/お店のメールソフト/)).toBeNull()
})

it('転送用アドレスは入力欄ではなく読み取り専用の文字と［コピーする］で出し、任意の札を付けない', async () => {
  fixture.connection.mockResolvedValue(response('setup', { address: 'inbox-fixture@example.org', mailbox: 'shop@example.org', connectionId: 'connection-a' }))
  render(<EmailConnectionCard accountId="store-a" canManage lockedReason="" />)
  expect(await screen.findByText('inbox-fixture@example.org')).toBeTruthy()
  expect(screen.queryByDisplayValue('inbox-fixture@example.org')).toBeNull()
  expect(screen.getByRole('button', { name: '転送用アドレスをコピーする' })).toBeTruthy()
  expect(screen.queryByText('任意')).toBeNull()
})

it('転送用アドレスを見られない人には値の代わりに理由を出し、［コピーする］は理由つきで押せない', async () => {
  fixture.connection.mockResolvedValue(response('connected', { address: null, mailbox: null }))
  render(<EmailConnectionCard accountId="store-a" canManage={false} lockedReason="管理者へ依頼してください" />)
  expect((await screen.findAllByText('オーナーか管理者だけが見られます')).length).toBeGreaterThan(0)
  const copy = screen.getByRole('button', { name: 'コピーする' })
  expect(copy.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(copy)
  expect(screen.queryByDisplayValue('オーナーか管理者だけが見られます')).toBeNull()
})

it.each([
  ['Gmail の確認コード', '34567891', '確認コードをコピーする', '34567891'],
  ['確認用の URL', 'https://mail-settings.example.com/verify?forward=inbox-fixture%40example.org&token=mihon-0001', '確認用の URL をコピーする', 'https://mail-settings.example.com/verify?forward=inbox-fixture%40example.org&token=mihon-0001'],
] as const)('%sは画面に出し、［コピーする］でその値そのものをコピーする', async (_label, confirmation, copyLabel, copied) => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  fixture.connection.mockResolvedValue(response('setup', { address: 'inbox-fixture@example.org', mailbox: 'shop@example.org', connectionId: 'connection-a', forwardingConfirmation: confirmation }))
  render(<EmailConnectionCard accountId="store-a" canManage lockedReason="" />)
  const copy = await screen.findByRole('button', { name: copyLabel })
  // コードはそのまま、URL は途中を省略して見せても、全文は吹き出しで読める。
  if (confirmation.startsWith('https://')) expect(screen.getByText((text) => text.startsWith('https://mail-settings.example.com/'))).toBeTruthy()
  else expect(screen.getByText(confirmation)).toBeTruthy()
  await act(async () => { fireEvent.click(copy) })
  expect(writeText).toHaveBeenCalledWith(copied)
})
