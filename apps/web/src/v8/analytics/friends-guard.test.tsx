// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({
  friendsOverview: vi.fn(),
  routesOverview: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      analytics: {
        ...actual.api.analytics,
        friendsOverview: (...args: unknown[]) => fx.friendsOverview(...args),
        routesOverview: (...args: unknown[]) => fx.routesOverview(...args),
      },
    },
  }
})

import FriendsV8 from './friends'

function metric(value: number | null) {
  return { value, state: value === null ? 'unavailable' : 'available', reason: null }
}

describe('FriendsV8 ガード', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('日ごとの集計や経路一覧が非配列の破損応答でもクラッシュせずエラー表示し、不正な日付・数値で NaN を出さない', async () => {
    fx.friendsOverview.mockResolvedValue({
      success: true,
      data: {
        period: { from: '2026-11-01', to: '2026-11-28' },
        dataCutoffAt: '2026-11-28T00:00:00Z',
        data: {
          state: 'available',
          stateReason: null,
          metrics: {
            added: metric(10),
            removed: metric(2),
            net: metric(8),
            firstTime: metric(7),
            currentFriends: metric(100),
          },
          days: null,
          campaigns: null,
        },
      },
    })
    fx.routesOverview.mockResolvedValue({
      success: true,
      data: {
        period: { from: '2026-11-01', to: '2026-11-28' },
        dataCutoffAt: '2026-11-28T00:00:00Z',
        data: {
          routes: { broken: true },
        },
      },
    })

    const { rerender } = render(<FriendsV8 accountId="acc-1" />)

    await waitFor(() => {
      expect(screen.getByText('日ごとの集計データを読み込めませんでした。')).toBeTruthy()
      expect(screen.getByText('流入経路のデータを読み込めませんでした。')).toBeTruthy()
    })

    // 壊れた日付と NaN の日別データでも「NaN月NaN日」や「増加 NaN 人」を出さない
    fx.friendsOverview.mockResolvedValue({
      success: true,
      data: {
        period: { from: '2026-11-01', to: '2026-11-28' },
        dataCutoffAt: '2026-11-28T00:00:00Z',
        data: {
          state: 'available',
          stateReason: null,
          metrics: {
            added: metric(10),
            removed: metric(2),
            net: metric(8),
            firstTime: metric(7),
            currentFriends: metric(100),
          },
          days: [{ date: 'bad-date', added: Number.NaN, removed: Number.NaN, net: Number.NaN }],
          campaigns: [],
        },
      },
    })
    fx.routesOverview.mockResolvedValue({
      success: true,
      data: {
        period: { from: '2026-11-01', to: '2026-11-28' },
        dataCutoffAt: '2026-11-28T00:00:00Z',
        data: { routes: [] },
      },
    })

    rerender(<FriendsV8 accountId="acc-2" />)

    await waitFor(() => {
      expect(screen.getByText('この期間に流入リンクから増えた友だちはいません')).toBeTruthy()
      expect(screen.getByText('日ごとの集計データを読み込めませんでした。')).toBeTruthy()
    })
    expect(screen.queryByText(/NaN/)).toBeNull()
  })
})
