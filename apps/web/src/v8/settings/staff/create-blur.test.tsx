// @vitest-environment happy-dom
/*
 * ログインユーザーを追加する画面の「欄から離れた時点で教える」動きの試験。
 * - 離れた欄だけ理由を出し、触っていない欄は黙っている。直すとその場で消える
 * - 送信では全欄を見て上にまとめを出し、招待は送らず、1つ目の欄へ移れる
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const createStaff = vi.hoisted(() => vi.fn())

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/staff/new',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href, ...rest }, children),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', selectedAccount: { id: 'account-a', name: '本店' } }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined, usePageCrumbs: () => undefined }))
vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  const api = (actual as unknown as { api: Record<string, object> }).api
  return {
    ...actual,
    api: {
      ...api,
      lineAccounts: { list: async () => ({ success: true, data: [{ id: 'account-a', name: '本店' }] }) },
      staff: { ...api.staff, create: createStaff },
    },
  }
})

import NewStaffPage from './create'

const nameField = () => document.getElementById('staff-name') as HTMLInputElement

beforeEach(() => {
  createStaff.mockReset()
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(() => cleanup())

describe('ログインユーザーを追加する：欄を離れたときの検査', () => {
  it('名前の欄を空のまま離れると、その欄だけ理由を出し、入れると消える', async () => {
    await act(async () => { render(<NewStaffPage />) })
    expect(screen.queryByText('名前を入力してください')).toBeNull()
    fireEvent.focus(nameField())
    fireEvent.blur(nameField())
    expect(screen.getAllByText('名前を入力してください')).toHaveLength(1)
    expect(nameField().getAttribute('aria-invalid')).toBe('true')
    // 触っていない欄は黙っている。
    expect(screen.queryByText('メールアドレスを入力してください')).toBeNull()
    fireEvent.change(nameField(), { target: { value: '見本 143' } })
    expect(screen.queryByText('名前を入力してください')).toBeNull()
  })

  it('送信では全欄を見てまとめを出し、招待は送らず、まとめから1つ目の欄へ移る', async () => {
    await act(async () => { render(<NewStaffPage />) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '招待メールを送る' })) })
    expect(createStaff).not.toHaveBeenCalled()
    const summary = document.querySelector('[data-design-part="validation-summary"]') as HTMLElement
    expect(summary.textContent).toContain('2か所直してください')
    expect(summary.textContent).toContain('名前')
    expect(summary.textContent).toContain('メールアドレス')
    expect(screen.getByText('名前を入力してください')).toBeTruthy()
    expect(screen.getByText('メールアドレスを入力してください')).toBeTruthy()
    const jump = within(summary).getAllByRole('button').at(-1)!
    await act(async () => { fireEvent.click(jump) })
    expect(document.activeElement).toBe(nameField())
  })

  it('アカウント選択を見せず、追加元だけの担当範囲で招待する', async () => {
    createStaff.mockResolvedValue({ success: true, data: { id: 'new-staff' } })
    await act(async () => { render(<NewStaffPage />) })
    expect(screen.queryByText('最初に表示するLINEアカウント')).toBeNull()
    expect(screen.queryByText('この店舗より下のアカウントにも権限を付ける')).toBeNull()
    expect(screen.getByText('担当範囲は本店のみです。')).toBeTruthy()
    fireEvent.change(nameField(), { target: { value: '見本 143' } })
    fireEvent.change(document.getElementById('staff-email')!, { target: { value: 'hanako@example.test' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '招待メールを送る' })) })
    expect(createStaff).toHaveBeenCalledWith(expect.objectContaining({
      assignedLineAccountId: 'account-a',
      accountScope: 'accounts',
      scopedLineAccountIds: ['account-a'],
      canAccessDescendantAccounts: false,
    }))
  })

  it('新しい店舗のスタッフには共通の機能権限だけを表示する', async () => {
    await act(async () => { render(<NewStaffPage />) })
    fireEvent.click(screen.getByRole('radio', { name: /スタッフ/ }))
    expect(screen.getByText('基本')).toBeTruthy()
    expect(screen.getByText('受信箱')).toBeTruthy()
    expect(screen.queryByText('専用機能')).toBeNull()
    expect(screen.queryByText('ECデータ連携')).toBeNull()
    expect(screen.queryByText('投稿写真審査')).toBeNull()
  })
})
