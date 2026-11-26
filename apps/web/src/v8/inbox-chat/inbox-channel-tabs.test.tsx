// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { InboxChannelTabs } from './inbox-channel-tabs'

const state = vi.hoisted(() => ({
  push: vi.fn(),
  connections: vi.fn(),
  query: '',
  error: null as string | null,
  account: { id: 'a', emailInboxEnabled: false },
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: state.push }),
  useSearchParams: () => new URLSearchParams(state.query),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: 'a',
    selectedAccount: state.account,
    loading: false,
    error: state.error,
    refreshAccounts: vi.fn(),
  }),
}))
vi.mock('@/lib/api', () => ({ api: { instagram: { connections: state.connections } } }))

beforeEach(() => {
  state.push.mockReset()
  state.connections.mockReset()
  state.query = ''
  state.error = null
  state.account.emailInboxEnabled = false
})
afterEach(cleanup)

it('URL条件を残してLINEへ切り替える', () => {
  state.query = 'sort=latest'
  render(<InboxChannelTabs />)
  fireEvent.click(screen.getByRole('tab', { name: 'LINE' }))
  expect(state.push).toHaveBeenCalledWith(expect.stringContaining('sort=latest&channel=line'))
})

it('未接続のInstagramは設定画面へ飛ばずInstagramタブへ切り替える', async () => {
  state.query = 'sort=latest'
  state.connections.mockResolvedValue({ success: true, data: { connections: [] } })
  render(<InboxChannelTabs />)
  fireEvent.click(screen.getByRole('tab', { name: 'Instagram' }))
  await waitFor(() => expect(state.push).toHaveBeenCalledWith(expect.stringContaining('sort=latest&channel=instagram')))
  expect(state.push).not.toHaveBeenCalledWith('/settings/sns')
})

it('読み込み失敗後に接続を確認すると共通の案内を開き、タブを切り替えない', async () => {
  state.connections
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ success: true, data: { connections: [{ state: 'connected' }] } })
  render(<InboxChannelTabs />)
  fireEvent.click(screen.getByRole('tab', { name: 'Instagram' }))
  fireEvent.click(await screen.findByRole('button', { name: '読み直す' }))
  expect(await screen.findByRole('dialog', { name: '現在準備中です' })).toBeTruthy()
  expect(state.push).not.toHaveBeenCalled()
  expect(screen.getByRole('tab', { name: 'すべて' }).getAttribute('aria-selected')).toBe('true')
})

it('接続済みInstagramのURLも一覧を保ち、共通の案内を開く', async () => {
  state.query = 'channel=instagram'
  state.connections.mockResolvedValue({ success: true, data: { connections: [{ state: 'connected' }] } })
  render(<InboxChannelTabs />)
  expect(await screen.findByRole('dialog', { name: '現在準備中です' })).toBeTruthy()
  expect(state.push).not.toHaveBeenCalled()
  expect(screen.getByRole('tab', { name: 'すべて' }).getAttribute('aria-selected')).toBe('true')
})

it('接続済みメールは会話の一覧へ切り替える', () => {
  state.account.emailInboxEnabled = true
  render(<InboxChannelTabs />)
  fireEvent.click(screen.getByRole('tab', { name: 'メール' }))
  expect(state.push).toHaveBeenCalledWith(expect.stringContaining('channel=email'))
})

it('未接続メールは設定画面へ飛ばずメールタブへ切り替える', () => {
  render(<InboxChannelTabs />)
  fireEvent.click(screen.getByRole('tab', { name: 'メール' }))
  expect(state.push).toHaveBeenCalledWith(expect.stringContaining('channel=email'))
  expect(state.push).not.toHaveBeenCalledWith('/settings/sns')
})

it('メールの取得失敗では設定へ移らず読み直しを出す', () => {
  state.error = 'offline'
  render(<InboxChannelTabs />)
  fireEvent.click(screen.getByRole('tab', { name: 'メール' }))
  expect(screen.getByRole('button', { name: '読み直す' })).toBeTruthy()
  expect(state.push).not.toHaveBeenCalled()
})

it('URLから選択中の媒体を復元する', () => {
  state.query = 'channel=line&sort=latest'
  render(<InboxChannelTabs />)
  expect(screen.getByRole('tab', { name: 'LINE' }).getAttribute('aria-selected')).toBe('true')
})

it('InstagramのURLでも接続確認に失敗すれば読み直しを出す', async () => {
  state.query = 'channel=instagram'
  state.connections.mockRejectedValue(new Error('offline'))
  render(<InboxChannelTabs />)
  expect(await screen.findByRole('button', { name: '読み直す' })).toBeTruthy()
  expect(state.push).not.toHaveBeenCalled()
})

it('未接続InstagramのURLではInstagramタブを選択状態にし、移動しない', async () => {
  state.query = 'channel=instagram'
  state.connections.mockResolvedValue({ success: true, data: { connections: [] } })
  render(<InboxChannelTabs />)
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Instagram' }).getAttribute('aria-selected')).toBe('true'))
  expect(state.push).not.toHaveBeenCalled()
})

it('未接続メールのURLではメールタブを選択状態にし、移動しない', () => {
  state.query = 'channel=email'
  render(<InboxChannelTabs />)
  expect(screen.getByRole('tab', { name: 'メール' }).getAttribute('aria-selected')).toBe('true')
  expect(state.push).not.toHaveBeenCalled()
})

it('メールの取得失敗から媒体を戻すと古いエラー案内が消える', async () => {
  state.query = 'channel=email'
  state.error = 'offline'
  const view = render(<InboxChannelTabs />)
  expect(await screen.findByText('メールの接続状態を読み込めませんでした。')).toBeTruthy()
  state.query = 'channel=line'
  state.error = null
  view.rerender(<InboxChannelTabs />)
  await waitFor(() => expect(screen.queryByText('メールの接続状態を読み込めませんでした。')).toBeNull())
})
