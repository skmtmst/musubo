// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { attentionFixture } from '@/test-utils/hq-attention-fixture'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  push: vi.fn(),
  select: vi.fn(),
  toast: vi.fn(),
  attention: vi.fn(),
  accounts: [{ id: 'account-a', name: '本店' }],
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: fixture.push }) }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ accounts: fixture.accounts, selectedAccountId: null, setSelectedAccountId: fixture.select }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {} }))
vi.mock('@/components/shared/toast', () => ({ notifyToast: fixture.toast }))
vi.mock('@/lib/api/helpers/styles', () => ({ hqStyleApi: { attention: fixture.attention } }))
vi.mock('@/lib/api', async (original) => ({
  ...await original<typeof import('@/lib/api')>(),
  api: { lineAccountFolders: { list: async () => ({ success: true, data: { folders: [] } }) } },
}))

import AttentionPage from '@/app/hq/attention/page'

beforeEach(() => {
  fixture.push.mockReset()
  fixture.select.mockReset()
  fixture.toast.mockReset()
  fixture.attention.mockResolvedValue({ success: true, data: { items: [{
    accountId: 'account-a', name: '本店', counts: { connections: 1, unhandledChats: 2 }, details: {},
  }] } })
})
afterEach(cleanup)

it('統括の表と同じ口の５種類をそのまま表示する', async () => {
  fixture.attention.mockResolvedValue({ success: true, data: { items: [attentionFixture] } })
  render(<AttentionPage />)
  for (const [label, count] of [['未対応のトーク', 1], ['承認待ちの予約', 2], ['未払い', 3], ['接続の異常', 4], ['止まった配信', 5]] as const) {
    expect(await screen.findByRole('button', { name: `本店の${label} ${count}件を開く` })).toBeTruthy()
  }
  expect(fixture.attention).toHaveBeenCalled()
})

it.each([
  ['本店の接続の異常 1件を開く', '/accounts/detail?id=account-a'],
  ['本店の未対応のトーク 2件を開く', '/chats?status=unread'],
])('%sから個別画面を開くと切り替え先を知らせる', async (name, href) => {
  render(<AttentionPage />)
  const action = await screen.findByRole('button', { name })
  fireEvent.click(action)
  await waitFor(() => expect(fixture.push).toHaveBeenCalledWith(href))
  expect(fixture.select).toHaveBeenCalledWith('account-a')
  expect(fixture.toast).toHaveBeenCalledWith('本店 に切り替えました', { tone: 'info' })
})

it('アカウントの詳細を見るだけなら切り替えも通知もしない', async () => {
  render(<AttentionPage />)
  fireEvent.click(await screen.findByRole('button', { name: '本店' }))
  expect(fixture.push).toHaveBeenCalledWith('/accounts/detail?id=account-a')
  expect(fixture.select).not.toHaveBeenCalled()
  expect(fixture.toast).not.toHaveBeenCalled()
})

it('?kind=connections で来たら種類を接続の異常に絞る', async () => {
  window.history.replaceState(null, '', '/hq/attention?kind=connections')
  try {
    fixture.attention.mockResolvedValue({ success: true, data: { items: [
      { accountId: 'account-a', name: '本店', counts: { connections: 1 }, details: {} },
      { accountId: 'account-b', name: '支店', counts: { unhandledChats: 2 }, details: {} },
    ] } })
    render(<AttentionPage />)
    expect(await screen.findByRole('button', { name: '本店' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '支店' })).toBeNull()
  } finally {
    window.history.replaceState(null, '', '/hq/attention')
  }
})

it('接続の行き先は他のアカウントの指定を使わない', async () => {
  fixture.attention.mockResolvedValue({ success: true, data: { items: [{ accountId: 'account-a', name: '本店', counts: { connections: 1 }, details: { connections: [{ id: 'check', href: '/line-accounts?accountId=other' }] } }] } })
  render(<AttentionPage />)
  fireEvent.click(await screen.findByRole('button', { name: '本店の接続の異常 1件を開く' }))
  expect(fixture.select).toHaveBeenCalledWith('account-a')
  expect(fixture.push).toHaveBeenCalledWith('/accounts/detail?id=account-a')
})
