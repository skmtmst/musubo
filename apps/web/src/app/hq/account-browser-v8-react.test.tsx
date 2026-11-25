// @vitest-environment happy-dom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import type { AccountWithStats } from '@/contexts/account-context'
import AccountBrowser from '@/v8/hq/home'

const mocks = vi.hoisted(() => ({ list: vi.fn(), select: vi.fn(), refresh: vi.fn(), push: vi.fn(), restore: vi.fn(), stepUp: vi.fn(), accountEntry: vi.fn(), role: 'owner' }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), useRouter: () => ({ push: mocks.push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }) }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/components/hq/platform-notices', () => ({ default: () => null }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ accounts: [], setSelectedAccountId: mocks.select, refreshAccounts: mocks.refresh }) }))
vi.mock('@/lib/staff-role', async (original) => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => mocks.role }))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    lineAccounts: { ...actual.api.lineAccounts, list: mocks.list, restore: mocks.restore, accountEntry: mocks.accountEntry },
    lineAccountFolders: { ...actual.api.lineAccountFolders, list: vi.fn(async () => ({ success: true, data: { folders: [], total: 0, unclassifiedCount: 0 } })) },
    tenants: { ...actual.api.tenants, me: vi.fn(async () => ({ success: true, data: { name: '統括' } })) },
    auth: { ...actual.api.auth, stepUp: mocks.stepUp },
  } }
})

const accounts = Array.from({ length: 23 }, (_, i): AccountWithStats => ({ id: `a${i}`, name: `店舗${String(i).padStart(2, '0')}`, channelId: `channel${i}`, basicId: `@shop${i}`, isActive: true, country: null, role: i === 11 ? 'viewer' : 'owner', displayOrder: i, connection: { status: i === 11 ? 'warn' : 'ok', checkedAt: null }, stats: { friendCount: i, messagesThisMonth: i * 2, activeScenarios: 0, staffCount: 1 } }))
beforeEach(() => {
  vi.clearAllMocks(); window.history.replaceState(null, '', '/hq'); window.dispatchEvent(new PopStateEvent('popstate'))
  mocks.role = 'owner'
  mocks.list.mockResolvedValue({ success: true, data: accounts })
  mocks.refresh.mockResolvedValue(undefined)
  mocks.restore.mockResolvedValue({ success: true, data: {} })
  mocks.stepUp.mockResolvedValue({ success: true, data: { token: 'grant-1' } })
  mocks.accountEntry.mockResolvedValue({ success: true, data: { destination: 'dashboard', canResume: false } })
})
afterEach(() => { cleanup(); window.history.replaceState(null, '', '/') })

describe('V8 統括のアカウントを探す', () => {
  it('2ページ目のアカウントへ入る時は表示した行のIDを渡す', async () => {
    render(<AccountBrowser />); await screen.findByText('店舗22')
    expect(screen.queryByText('店舗00')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '2ページ目へ' }))
    fireEvent.click(screen.getByRole('button', { name: '店舗02 へ入る', exact: true }))
    await waitFor(() => expect(mocks.select).toHaveBeenCalledExactlyOnceWith('a2'))
    expect(mocks.accountEntry).toHaveBeenCalledExactlyOnceWith('a2')
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith('/')
    expect(screen.getByText(/21〜23\s*件/)).toBeTruthy()
  })
  it('LINE ID検索でページを戻し、閲覧者の設定操作を出さない', async () => {
    mocks.role = 'viewer'
    render(<AccountBrowser />); await screen.findByText('店舗22')
    fireEvent.click(screen.getByRole('button', { name: '2ページ目へ' }))
    fireEvent.change(screen.getByRole('searchbox', { name: '名前・LINE ID・フォルダで探す' }), { target: { value: '@shop11' } })
    await screen.findByText('店舗11')
    expect(screen.queryByRole('button', { name: '店舗11 の設定' })).toBeNull()
    expect(screen.getByRole('button', { name: '店舗11 へ入る' })).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox', { name: '名前・LINE ID・フォルダで探す' }), { target: { value: '' } })
    await screen.findByText('店舗22')
    await waitFor(() => expect(screen.getByRole('button', { name: '1ページ目へ' }).getAttribute('aria-current')).toBe('page'))
  })
  it('分類のフォルダを追加する窓が開く', async () => {
    render(<AccountBrowser />); await screen.findByText('店舗22')
    fireEvent.click(screen.getByRole('button', { name: 'フォルダを追加' }))
    expect(screen.getByRole('textbox', { name: 'フォルダの名前' })).toBeTruthy()
  })
  it('アーカイブは登録内容の編集と戻すだけを出し、本人確認して戻す', async () => {
    const archived: AccountWithStats = { id: 'old', name: '旧キャンペーン', channelId: 'c-old', basicId: '@nen-old', isActive: false, country: null, role: 'owner', displayOrder: 99, archivedAt: '2026-01-01', stats: { friendCount: 0, messagesThisMonth: 0, activeScenarios: 0, staffCount: 0 } }
    mocks.list.mockResolvedValue({ success: true, data: [accounts[0], archived] })
    render(<AccountBrowser />); await screen.findByText('店舗00')
    expect(screen.queryByText('旧キャンペーン')).toBeNull()
    const allButtons = screen.getAllByRole('button', { name: /^すべて/ })
    expect(allButtons).toHaveLength(2)
    expect(allButtons.every((button) => button.textContent?.includes('1'))).toBe(true)
    const explanationButton = screen.getByRole('button', { name: '統括のアカウントの説明' })
    fireEvent.click(explanationButton)
    const explanation = document.getElementById(explanationButton.getAttribute('aria-describedby') ?? '')
    expect(explanation).not.toBeNull()
    expect(explanation?.getAttribute('role')).toBe('note')
    expect(explanation?.textContent).toContain('アーカイブしたアカウントは「登録内容を編集」と「戻す」だけです')
    expect(explanation?.textContent).toContain('「戻す」を使えるのはオーナーだけです。本人確認のあと、アカウントは「停止中」になります')
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: /^アーカイブ/ }))
    await screen.findByText('旧キャンペーン')
    expect(screen.queryByText('店舗00')).toBeNull()
    expect(screen.getByRole('button', { name: '登録内容を編集' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '詳細' })).toBeNull()
    expect(screen.queryByRole('button', { name: / へ入る$/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '戻す' }))
    const dialog = await screen.findByRole('dialog', { name: '「旧キャンペーン」をアーカイブから戻しますか？' })
    expect(mocks.restore).not.toHaveBeenCalled()
    const digits = within(dialog).getAllByRole('textbox')
    expect(digits).toHaveLength(6)
    digits.forEach((digit, index) => fireEvent.change(digit, { target: { value: String(index + 1) } }))
    await waitFor(() => expect(mocks.restore).toHaveBeenCalledWith('old', 'grant-1'))
    expect(mocks.stepUp).toHaveBeenCalledWith({ method: 'totp', value: '123456', purpose: 'line_account.archive' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
  it('接続状態の絞り込みと表へ切り替えても同じアカウントを表示する', async () => {
    render(<AccountBrowser />); await screen.findByText('店舗22')
    fireEvent.click(screen.getByRole('button', { name: /^要確認/ }))
    fireEvent.click(screen.getByRole('button', { name: '表' }))
    expect(screen.getAllByRole('row')).toHaveLength(2)
    expect(screen.getByText('店舗11')).toBeTruthy()
    expect(screen.queryByText('店舗00')).toBeNull()
    const person = screen.getByText('店舗11').closest('[data-list-person-cell]')
    expect(person?.querySelector('[data-avatar]')).toBeTruthy()
    const name = person?.querySelector('[data-list-name]')
    const dots = name?.querySelectorAll('[data-folder-dot]')
    expect(dots).toHaveLength(1)
    expect(dots?.[0].getAttribute('data-folder-dot')).toBe('unfiled')
    expect(dots?.[0].getAttribute('aria-label')).toBe('フォルダ：未分類')
    expect(name?.getAttribute('data-has-annotation')).toBeNull()
    expect(name?.textContent).not.toContain('要確認')
    expect(name?.closest('tr')?.querySelectorAll('td')[1].textContent).toContain('要確認')
    expect(person?.textContent).toContain('@shop11')
  })
})
it('統括のフォルダ名を編集中は画面移動前に確認する', async () => {
  render(<><AccountBrowser /><a href="/events">イベントへ</a></>)
  await screen.findByText('店舗22')
  fireEvent.click(screen.getByRole('button', { name: 'フォルダを追加' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'フォルダの名前' }), { target: { value: '新しい分類' } })
  fireEvent.click(screen.getByRole('link', { name: 'イベントへ' }))
  expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
})
