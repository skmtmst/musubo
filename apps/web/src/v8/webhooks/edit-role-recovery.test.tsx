// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'

const fixture = vi.hoisted(() => ({
  me: vi.fn(),
  detail: vi.fn(),
  accountId: 'acc-1' as string | null,
  accountLoading: false,
}))

vi.mock('next/navigation', async () => ({
  ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useSearchParams: () => new URLSearchParams('id=wh-1'),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: fixture.accountId,
    loading: fixture.accountLoading,
  }),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      staff: { ...actual.api.staff, me: fixture.me },
      webhooks: {
        ...actual.api.webhooks,
        outgoing: {
          ...actual.api.webhooks.outgoing,
          detail: fixture.detail,
        },
      },
    },
  }
})

import EditWebhookPage from './edit'

describe('送信Webhook編集：権限再確認の失敗通知・連打防止とアカウント未選択表示', () => {
  beforeEach(() => {
    forgetStaffIdentity()
    forgetSessionSnapshot()
    fixture.accountId = 'acc-1'
    fixture.accountLoading = false
    fixture.detail.mockResolvedValue({
      success: true,
      data: { name: '受注連携先', url: 'https://example.test/hook', eventTypes: ['*'], maxRetries: 3 },
    })
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    document.documentElement.dataset.theme = 'v8'
  })

  afterEach(() => {
    cleanup()
    forgetStaffIdentity()
    forgetSessionSnapshot()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    delete document.documentElement.dataset.theme
  })

  it('権限の再確認が失敗したときエラー通知を出し、進行中の連打を防ぎつつ再試行成功で編集画面へ復旧する', async () => {
    let resolveSecondRetry!: (value: unknown) => void
    fixture.me
      .mockRejectedValueOnce(new Error('offline-initial'))
      .mockResolvedValueOnce({ success: false, error: 'still offline' })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecondRetry = resolve }))

    render(<EditWebhookPage />)

    await screen.findByText(/権限の確認が終わるまで編集できません/)
    const retryBtn = screen.getByRole('button', { name: 'もう一度読み込む' })

    fireEvent.click(retryBtn)
    expect(await screen.findByText(/権限を確認できませんでした/)).toBeTruthy()
    await waitFor(() => expect((retryBtn as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(retryBtn)
    fireEvent.click(retryBtn)
    await waitFor(() => expect(fixture.me).toHaveBeenCalledTimes(3))

    await act(async () => {
      resolveSecondRetry({ success: true, data: { id: 'admin-1', role: 'admin' } })
      await Promise.resolve()
    })

    expect(await screen.findByRole('button', { name: /保存する/ })).toBeTruthy()
    expect(screen.queryByText(/権限を確認できませんでした/)).toBeNull()
  })

  it('アカウント読込完了後にLINEアカウント未選択のときは空状態案内を出し、無限ローディングにしない', async () => {
    fixture.accountId = null
    fixture.accountLoading = false
    fixture.me.mockResolvedValue({ success: true, data: { id: 'admin-1', role: 'admin' } })

    render(<EditWebhookPage />)

    expect(await screen.findByText('LINEアカウントを選択してください')).toBeTruthy()
    await waitFor(() => expect(fixture.detail).not.toHaveBeenCalled())
  })
})
