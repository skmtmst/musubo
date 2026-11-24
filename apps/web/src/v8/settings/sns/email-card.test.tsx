// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EmailConnectionCard } from './email-card'

const fixture = vi.hoisted(() => ({
  connection: vi.fn(), verify: vi.fn(), issue: vi.fn(), disconnect: vi.fn(), refreshAccounts: vi.fn(),
  accounts: [],
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => fixture }))
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
  expect(await screen.findByDisplayValue('12345678')).toBeTruthy()
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
