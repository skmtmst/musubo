// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({
  syncPosts: vi.fn(),
  allowed: true,
}))

vi.mock('@/lib/restaurant-google-api', () => ({
  restaurantGoogleApi: {
    syncPosts: fx.syncPosts,
  },
}))

vi.mock('./use-google-permission', () => ({
  useGooglePermission: () => ({
    allowed: fx.allowed,
    canView: true,
    known: true,
    lockedReason: fx.allowed ? null : '権限がありません',
  }),
}))

import { usePostStatusCheck } from './use-post-status-check'

function Probe({ accountId, reload }: { accountId: string; reload: () => Promise<void> }) {
  const state = usePostStatusCheck(accountId, reload)
  return (
    <div>
      <button type="button" onClick={() => void state.sync()}>確認する</button>
      <span data-testid="syncing">{String(state.syncing)}</span>
      <span data-testid="last-checked">{state.lastChecked ?? 'none'}</span>
      <span data-testid="error">{state.syncError}</span>
    </div>
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  fx.allowed = true
})

afterEach(() => {
  cleanup()
})

describe('usePostStatusCheck 空accountIdと再読込失敗時の最終確認時刻防御', () => {
  it('空の accountId では syncPosts を呼ばない', async () => {
    const reload = vi.fn().mockResolvedValue(undefined)
    render(<Probe accountId="   " reload={reload} />)
    fireEvent.click(screen.getByRole('button', { name: '確認する' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(fx.syncPosts).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    expect(screen.getByTestId('last-checked').textContent).toBe('none')
  })

  it('syncPosts 後に一覧の再読み込みが失敗したときは最終確認時刻を更新せずエラーのみ出す', async () => {
    fx.syncPosts.mockResolvedValueOnce({ success: true })
    const reload = vi.fn().mockRejectedValueOnce(new Error('一覧の再取得に失敗しました'))

    render(<Probe accountId="acc-1" reload={reload} />)
    fireEvent.click(screen.getByRole('button', { name: '確認する' }))

    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toContain('Googleから投稿の状態を確認できませんでした。')
    })
    expect(screen.getByTestId('syncing').textContent).toBe('false')
    expect(screen.getByTestId('last-checked').textContent).toBe('none')
  })

  it('syncPosts と再読み込みの両方が成功したときだけ最終確認時刻を更新する', async () => {
    fx.syncPosts.mockResolvedValueOnce({ success: true })
    const reload = vi.fn().mockResolvedValueOnce(undefined)

    render(<Probe accountId="acc-1" reload={reload} />)
    fireEvent.click(screen.getByRole('button', { name: '確認する' }))

    await waitFor(() => {
      expect(screen.getByTestId('last-checked').textContent).not.toBe('none')
    })
    expect(screen.getByTestId('syncing').textContent).toBe('false')
    expect(screen.getByTestId('error').textContent).toBe('')
  })
})
