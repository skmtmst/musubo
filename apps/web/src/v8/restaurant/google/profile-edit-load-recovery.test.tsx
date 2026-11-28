// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

import { ApiError } from '@/lib/api'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { ProfileEditScreen } from './profile-edit'

const mocks = vi.hoisted(() => ({
  profile: vi.fn(),
  photos: vi.fn(),
  proposeProfile: vi.fn(),
  media: vi.fn(),
}))

vi.mock('@/lib/restaurant-google-api', () => ({ restaurantGoogleApi: mocks }))
vi.mock('@/lib/api', async (original) => ({ ...await original<typeof import('@/lib/api')>(), api: { media: { list: mocks.media } } }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner', canManageRole: () => true }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

const profileData = {
  store: { name: '対象店舗' },
  closed: false,
  profile: {
    title: 'テスト店舗',
    address: { postalCode: '150-0001', administrativeArea: '東京都', locality: '渋谷区', addressLines: ['1-2-3'] },
    phone: '03-0000-0000',
    websiteUri: 'https://example.com',
    description: '紹介文',
  },
}

const go = vi.fn()

beforeEach(() => {
  vi.resetAllMocks()
  document.documentElement.dataset.theme = 'v8'
  verifiedStaffRole('owner')
})

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.theme
})

describe('Googleプロフィール編集：プロフィールと写真の読み込み失敗からの回復', () => {
  it('プロフィール取得が失敗したとき、再試行ボタンで実際に再取得して編集画面へ回復できる', async () => {
    mocks.profile
      .mockRejectedValueOnce(new ApiError(500, '読み込みに失敗しました'))
      .mockResolvedValueOnce(profileData)
    mocks.photos.mockResolvedValue({ photos: [] })

    render(<ProfileEditScreen accountId="account-1" go={go} />)

    await screen.findByText('プロフィールを読み込めませんでした')
    expect(mocks.profile).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /もう一度/ }))

    await screen.findByRole('textbox', { name: '店舗名' })
    expect(mocks.profile).toHaveBeenCalledTimes(2)
    expect(go).not.toHaveBeenCalled()
  })

  it('写真取得が失敗したとき、0枚と誤表示せず再読み込みボタンで重複送信を防ぎつつ回復できる', async () => {
    let resolvePhotos!: (value: unknown) => void
    mocks.profile.mockResolvedValue(profileData)
    mocks.photos
      .mockRejectedValueOnce(new ApiError(500, '写真の取得に失敗しました'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolvePhotos = resolve }))

    render(<ProfileEditScreen accountId="account-1" go={go} />)

    await screen.findByText('写真を読み込めませんでした。')
    expect(screen.getByText('写真（—）')).toBeTruthy()
    expect(screen.queryByText('写真（0枚）')).toBeNull()

    const retryButton = screen.getByRole('button', { name: '写真を読み直す' }) as HTMLButtonElement
    fireEvent.click(retryButton)
    expect(retryButton.disabled).toBe(true)
    fireEvent.click(retryButton)
    expect(mocks.photos).toHaveBeenCalledTimes(2)

    resolvePhotos({ photos: [{ name: 'photos/1', thumbnailUrl: 'https://example.com/1.jpg', googleUrl: null }] })
    await waitFor(() => expect(screen.getByText('写真（1枚）')).toBeTruthy())
    expect(screen.queryByText('写真を読み込めませんでした。')).toBeNull()
  })
})
