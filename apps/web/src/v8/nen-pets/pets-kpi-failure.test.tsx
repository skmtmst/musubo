// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import type { NenPetListData } from '@/lib/nen-pets-api'

const fetchApi = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, fetchApi }
})
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/nen/pets',
}))
vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))
vi.mock('@/lib/staff-role', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/staff-role')>()
  return { ...actual, useStaffRole: () => verifiedStaffRole('owner') }
})

import PetsV8 from './pets'

const LIST: NenPetListData = {
  items: [
    {
      id: 'pet-komugi',
      name: 'こむぎ',
      callName: 'こむぎちゃん',
      gender: 'female',
      animalType: 'dog',
      breed: '柴',
      birthday: '2022-04-03',
      ageLabel: '4歳',
      weightKg: 9.2,
      neutered: 'yes',
      activityLevel: 'normal',
      activityLabel: 'ふつう',
      productName: 'ドライフード（成犬）',
      feeding: { dailyKcal: 560, dailyGrams: 128, factorLabel: '避妊・去勢済み', stageLabel: '成犬', venisonGrams: 12, venisonKcal: 56, treatName: null },
      imageUrl: null,
      updatedAt: '2026-09-28T10:00:00+09:00',
      weightUpdatedAt: '2026-09-28T10:00:00+09:00',
      weightStale: false,
      owner: { friendId: 'friend-3', name: '見本 169', pictureUrl: null, customerId: '10234' },
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
  kpis: { total: 8, dogs: 4, cats: 3, newThisMonth: 2, computable: 5, staleWeight: 2 },
  products: [],
  treatLimitPercent: 10,
}

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  fetchApi.mockReset()
})

afterEach(() => {
  cleanup()
  verifiedStaffRole(null)
  delete document.documentElement.dataset.theme
})

describe('マイペット一覧の読み込み失敗時のKPI帯表示と再読み込み', () => {
  it('一覧取得失敗時にKPI帯を読み込み中のままにせず失敗表示へ切り替え、再読み込みで復旧できる', async () => {
    fetchApi
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({ success: true, data: LIST })

    render(<PetsV8 accountId="acc-1" tab="pets" onChangeTab={() => {}} />)

    await screen.findByText('ペットを読み込めませんでした')
    const kpiBand = screen.getByLabelText('ペットの数の帯')
    expect(within(kpiBand).queryByText('読み込んでいます')).toBeNull()
    expect(within(kpiBand).getByText('読み込めませんでした')).toBeTruthy()
    expect(kpiBand.querySelectorAll('[aria-busy="true"]')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))

    await screen.findByText('こむぎ')
    await waitFor(() => expect(fetchApi).toHaveBeenCalledTimes(2))
    expect(within(kpiBand).queryByText('読み込めませんでした')).toBeNull()
    expect(within(kpiBand).getByText('犬 4・猫 3・その他 1')).toBeTruthy()
  })
})
