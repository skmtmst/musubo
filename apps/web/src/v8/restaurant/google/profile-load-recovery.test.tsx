// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

import { ApiError } from '@/lib/api'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import type { GoogleProfileData } from '@/lib/restaurant-google-api'
import ProfileBoard from './profile'

const mocks = vi.hoisted(() => ({
  profile: vi.fn(),
  syncProfile: vi.fn(),
}))

vi.mock('@/lib/restaurant-google-api', () => ({ restaurantGoogleApi: mocks }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner', canManageRole: () => true }))

function makeProfile(title: string): GoogleProfileData {
  return {
    stale: false,
    fetchedAt: '2026-10-10T00:00:00Z',
    closed: false,
    pendingChangeCount: 0,
    photoCount: 2,
    googleUpdates: null,
    holidays: [],
    timeZone: 'Asia/Tokyo',
    profile: {
      title,
      address: null,
      phone: '03-0000-0000',
      websiteUri: 'https://example.com',
      regularHours: [],
      specialHours: [],
      description: '紹介文',
    },
    today: { closed: false, periods: [], date: '2026-10-10', special: false, holidayName: null },
  } as unknown as GoogleProfileData
}

beforeEach(() => {
  vi.resetAllMocks()
  document.documentElement.dataset.theme = 'v8'
  verifiedStaffRole('owner')
})

afterEach(() => {
  cleanup()
  verifiedStaffRole(null)
  delete document.documentElement.dataset.theme
})

describe('Googleプロフィール：同期失敗時の再同期操作・403分類・古い応答の破棄', () => {
  it('通常表示中に同期が失敗したとき、失敗帯の再同期ボタンから再試行して回復できる', async () => {
    mocks.profile.mockResolvedValueOnce(makeProfile('渋谷店'))
    mocks.syncProfile
      .mockRejectedValueOnce(new ApiError(500, '一時エラー'))
      .mockResolvedValueOnce(makeProfile('渋谷店（最新）'))

    render(<ProfileBoard accountId="acc-1" go={() => {}} />)

    await screen.findByText('渋谷店')
    fireEvent.click(screen.getByRole('button', { name: '同期する' }))

    const retryButton = await screen.findByRole('button', { name: '再同期する' })
    expect(screen.getByText('プロフィールを読み込めませんでした。')).toBeTruthy()

    fireEvent.click(retryButton)
    await waitFor(() => expect(screen.getByText('渋谷店（最新）')).toBeTruthy())
    expect(screen.queryByRole('button', { name: '再同期する' })).toBeNull()
    expect(mocks.syncProfile).toHaveBeenCalledTimes(2)
  })

  it('初回取得が403権限不足のときは権限案内に切り替え、アカウント切替後の古い応答も捨てる', async () => {
    let resolveOld!: (value: GoogleProfileData) => void
    mocks.profile
      .mockReturnValueOnce(new Promise<GoogleProfileData>((resolve) => { resolveOld = resolve }))
      .mockRejectedValueOnce(new ApiError(403, 'forbidden'))

    const view = render(<ProfileBoard accountId="acc-old" go={() => {}} />)
    view.rerender(<ProfileBoard accountId="acc-new" go={() => {}} />)

    await screen.findByText(/オーナーか管理者に頼んでください/)

    await act(async () => { resolveOld(makeProfile('古い店舗')) })
    expect(screen.queryByText('古い店舗')).toBeNull()
  })
})
