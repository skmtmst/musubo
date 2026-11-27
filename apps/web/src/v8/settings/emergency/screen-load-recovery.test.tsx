// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const net = vi.hoisted(() => ({
  accounts: vi.fn(),
}))

vi.mock('@/contexts/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/components/layout/settings-inner-nav', () => ({ default: () => null }))
vi.mock('@/lib/staff-role', async (original) => ({
  ...await original<typeof import('@/lib/staff-role')>(),
  useStaffRole: () => 'owner',
  useStaffIdentity: () => ({ role: 'owner', readOnly: false }),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/emergency',
  useSearchParams: () => new URLSearchParams('tab=health'),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ accounts: [], selectedAccountId: 'account-1', selectedAccount: null, loading: false }),
}))
vi.mock('./health', () => ({
  HealthPanelV8: ({ accountCount }: { accountCount: number | null }) => (
    <div data-testid="account-count">{accountCount === null ? 'unknown' : String(accountCount)}</div>
  ),
}))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      health: {
        ...actual.api.health,
        accounts: (...args: unknown[]) => net.accounts(...args),
      },
    },
  }
})

import EmergencyScreen from './screen'

beforeEach(() => {
  vi.resetAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('運用状態：アカウント一覧の失敗理由表示と再読み込み連打防止', () => {
  it('失敗理由を帯へ示し、再読み込み中はボタンを無効化して連打による重複送信を防ぎつつ回復できる', async () => {
    let resolveRetry: ((value: unknown) => void) | null = null
    net.accounts
      .mockResolvedValueOnce({ success: false, error: '一覧の取得がタイムアウトしました' })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve }))

    render(<EmergencyScreen />)

    expect(await screen.findByText(/一覧の取得がタイムアウトしました/)).toBeTruthy()
    expect(screen.getByTestId('account-count').textContent).toBe('unknown')

    const retryButton = screen.getByRole('button', { name: 'もう一度読み込む' }) as HTMLButtonElement
    fireEvent.click(retryButton)
    expect(retryButton.disabled).toBe(true)
    fireEvent.click(retryButton)
    expect(net.accounts).toHaveBeenCalledTimes(2)

    resolveRetry!({ success: true, data: [{ id: 'a1' }, { id: 'a2' }] })
    await waitFor(() => expect(screen.getByTestId('account-count').textContent).toBe('2'))
    expect(screen.queryByText(/アカウント一覧を読み込めませんでした/)).toBeNull()
  })
})
