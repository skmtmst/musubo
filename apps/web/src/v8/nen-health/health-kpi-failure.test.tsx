// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NenHealthListData } from '@/lib/nen-pets-api'

const fetchApi = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, fetchApi }
})
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/nen/health',
}))
vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

import HealthV8 from './health'

const LIST: NenHealthListData = {
  items: [
    {
      pet: { id: 'pet-1', name: 'こむぎ', callName: 'こむぎちゃん', animalType: 'dog', breed: '柴', ageLabel: '4歳', imageUrl: null },
      owner: { friendId: 'friend-1', name: '見本 169', customerId: '10234' },
      lastLoggedOn: '2026-09-30',
      lastLoggedLabel: '7日前',
      daysSinceLast: 7,
      count30d: 12,
      totalRecords: 40,
      weightSeries: [9.8, 9.7, 9.6, 9.5, 9.4, 9.3, 9.2, 9.2],
      latestWeightKg: 9.2,
      weightChangePercent: -6,
      latestStool: '正常',
      latestAppetite: '普通',
      changes: [],
      concerning: false,
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
  kpis: { petsWithRecords: 6, petsTotal: 8, concerning: 1, recordsThisWeek: 14, silent30: 2 },
}

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  fetchApi.mockReset()
})

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.theme
})

describe('健康日記一覧の読み込み失敗時KPI表示と再読み込み', () => {
  it('一覧取得失敗時にKPI帯を読み込み中のままにせず失敗表示へ切り替え、再読み込みで復旧できる', async () => {
    fetchApi
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ success: true, data: LIST })

    render(<HealthV8 accountId="acc-1" tab="logs" onChangeTab={() => {}} />)

    await screen.findByText('健康日記を読み込めませんでした')
    const kpiBand = screen.getByLabelText('健康日記の数の帯')
    expect(within(kpiBand).queryByText('読み込んでいます')).toBeNull()
    expect(within(kpiBand).getByText('読み込めませんでした')).toBeTruthy()
    expect(kpiBand.querySelectorAll('[aria-busy="true"]')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))

    await screen.findByText('こむぎ')
    await waitFor(() => expect(fetchApi).toHaveBeenCalledTimes(2))
    expect(within(kpiBand).queryByText('読み込めませんでした')).toBeNull()
    expect(within(kpiBand).getByText('登録 8 匹のうち')).toBeTruthy()
  })
})
