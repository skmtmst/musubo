// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({
  get: vi.fn(),
  friends: vi.fn(),
  saveSearch: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))
vi.mock('@/lib/api/helpers/gap3', () => ({
  customerSegmentsApi: {
    get: (...args: unknown[]) => fx.get(...args),
    friends: (...args: unknown[]) => fx.friends(...args),
    saveSearch: (...args: unknown[]) => fx.saveSearch(...args),
  },
}))

import SegmentsV8 from './segments'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeSegments(total: number, cellCount: number) {
  return {
    success: true,
    data: {
      status: 'ready',
      computedAt: '2026-11-27T19:00:00Z',
      total,
      outside: { count: 0 },
      cells: [{ r: 1, f: 1, name: '新客', count: cellCount }],
    },
  }
}

describe('SegmentsV8 ガード', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('アカウント切替で遅れて返った古い集計応答が新しい集計を上書きしない', async () => {
    const firstReq = deferred<ReturnType<typeof makeSegments>>()
    const secondReq = deferred<ReturnType<typeof makeSegments>>()
    fx.get
      .mockReturnValueOnce(firstReq.promise)
      .mockReturnValueOnce(secondReq.promise)

    const { rerender } = render(<SegmentsV8 accountId="acc-1" canManage />)
    rerender(<SegmentsV8 accountId="acc-2" canManage />)

    secondReq.resolve(makeSegments(20, 5))
    await waitFor(() => {
      expect(screen.getByText('全員 20 人')).toBeTruthy()
    })

    // 古い acc-1 の応答が遅れて届いても上書きしない
    firstReq.resolve(makeSegments(999, 100))
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getByText('全員 20 人')).toBeTruthy()
    expect(screen.queryByText('全員 999 人')).toBeNull()
  })

  it('引き出しの不正日付・不正回数・負の残り人数でも NaN や負数を出さず、不正人数の配信ボタンも止める', async () => {
    fx.get.mockResolvedValue(makeSegments(10, Number.NaN))
    fx.friends.mockResolvedValue({
      success: true,
      data: {
        items: [
          { id: 'f1', display_name: '山田', activity_count: -2, amount: 0, last_activity_at: 'invalid-date' },
        ],
        total: 0,
        optedOutCount: Number.NaN,
        nextCursor: 'cursor-2',
      },
    })

    render(<SegmentsV8 accountId="acc-1" canManage />)
    await waitFor(() => {
      expect(screen.getByText('全員 10 人')).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: /新客/ }))
    await waitFor(() => {
      expect(screen.getByText('山田')).toBeTruthy()
    })

    expect(screen.queryByText(/NaN/)).toBeNull()
    expect(screen.queryByText(/-2 回/)).toBeNull()
    expect(screen.queryByText(/ほか -1 人/)).toBeNull()
    expect(screen.getByText('ほか 0 人を見る')).toBeTruthy()
    expect(screen.getByText(/宣伝を止めている人 — 人/)).toBeTruthy()

    const sendBtn = screen.getByRole('button', { name: /LINE を送る/ }) as HTMLButtonElement
    expect(sendBtn.disabled).toBe(true)
  })
})
