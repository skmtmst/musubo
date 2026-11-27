// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ops = vi.hoisted(() => ({
  members: vi.fn(),
  me: vi.fn(),
  addMember: vi.fn(),
  resendInvite: vi.fn(),
  setMemberActive: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/ops/members',
  useSearchParams: () => new URLSearchParams(''),
}))
vi.mock('@/v8/settings/staff', () => ({
  SelfSecurity: () => <div data-testid="self-security" />,
}))
vi.mock('@/components/ops/notice-line-account-card', () => ({
  default: () => <div data-testid="notice-line-account-card" />,
}))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      ops: {
        ...actual.api.ops,
        members: () => ops.members(),
        me: () => ops.me(),
        addMember: (...args: unknown[]) => ops.addMember(...args),
        resendInvite: (...args: unknown[]) => ops.resendInvite(...args),
        setMemberActive: (...args: unknown[]) => ops.setMemberActive(...args),
      },
    },
  }
})

import OpsMembersV8 from './members'

const MEMBERS = [
  {
    staffId: 'stf-1',
    name: '運営 太郎',
    email: 'taro@example.com',
    isActive: true,
    activationState: 'active',
    totpEnabled: true,
    lastLoginAt: '2026-10-01T00:00:00Z',
  },
  {
    staffId: 'stf-2',
    name: '運営 花子',
    email: 'hanako@example.com',
    isActive: true,
    activationState: 'active',
    totpEnabled: true,
    lastLoginAt: '2026-10-02T00:00:00Z',
  },
]

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  ops.members.mockReset()
  ops.me.mockReset()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  delete document.documentElement.dataset.theme
})

describe('運営メンバー管理：権限取得失敗とその場復旧', () => {
  it('ops.me が失敗しても一覧は表示し、注意帯の「権限を読み直す」で招待ボタンを操作可能に復旧できる', async () => {
    ops.members.mockResolvedValue({ success: true, data: MEMBERS })
    ops.me
      .mockRejectedValueOnce(new Error('ops me unavailable'))
      .mockResolvedValueOnce({ success: true, data: { id: 'stf-1', readOnly: false } })

    render(<OpsMembersV8 />)
    await screen.findByText('運営 太郎')
    await screen.findByText(/操作権限を確認できませんでした/)

    const inviteBtn = screen.getByRole('button', { name: '招待する' }) as HTMLButtonElement
    expect(inviteBtn.disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '権限を読み直す' }))

    await waitFor(() => expect(inviteBtn.disabled).toBe(false))
    expect(screen.queryByText(/操作権限を確認できませんでした/)).toBeNull()
    expect(screen.getByText('運営 太郎（自分）')).toBeTruthy()
    // メンバー一覧は再取得せず、権限確認（ops.me）だけをやり直す
    expect(ops.members).toHaveBeenCalledTimes(1)
    expect(ops.me).toHaveBeenCalledTimes(2)
  })

  it('権限を読み直すの二重押しを防ぎ、読み込み失敗中は絞り込み件数に偽の 0 を出さない', async () => {
    let finishMe!: (value: unknown) => void
    ops.members
      .mockRejectedValueOnce(new Error('members offline'))
      .mockResolvedValueOnce({ success: true, data: MEMBERS })
    ops.me
      .mockResolvedValueOnce({ success: false, error: 'me offline' })
      .mockResolvedValueOnce({ success: false, error: 'me offline 2' })
      .mockImplementationOnce(() => new Promise((resolve) => { finishMe = resolve }))

    render(<OpsMembersV8 />)
    await screen.findByText(/運営メンバーを読み込めませんでした/)

    // 失敗時は「有効 0」「止めた 0」の偽ゼロを出さない
    const activeChip = screen.getByRole('button', { name: /有効/ })
    expect(activeChip.textContent).not.toContain('0')
    const suspendedChip = screen.getByRole('button', { name: /止めた/ })
    expect(suspendedChip.textContent).not.toContain('0')

    // 一覧の再読み込みでメンバーが表示され、ops.me がまだ失敗なので権限注意帯が出る
    fireEvent.click(screen.getByRole('button', { name: /もう一度読み込む|再読み込み/ }))
    await screen.findByText('運営 太郎')
    const retryMeBtn = await screen.findByRole('button', { name: '権限を読み直す' })

    const meCallsBefore = ops.me.mock.calls.length
    fireEvent.click(retryMeBtn)
    fireEvent.click(retryMeBtn)
    expect(ops.me).toHaveBeenCalledTimes(meCallsBefore + 1)

    await act(async () => {
      finishMe({ success: true, data: { id: 'stf-1', readOnly: false } })
      await Promise.resolve()
    })

    await waitFor(() => expect((screen.getByRole('button', { name: '招待する' }) as HTMLButtonElement).disabled).toBe(false))
    expect(screen.queryByText(/操作権限を確認できませんでした/)).toBeNull()
  })
})
