// @vitest-environment happy-dom
/*
 * ★V8-B 健康日記（・・）の骨格。
 * データの口は 管理画面 と同じ（nenPetsApi.health・healthSummary）。
 * 板の印・8列・札・項目の表・まとめの引き出しを見る。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const health = vi.hoisted(() => ({ health: vi.fn(), healthSummary: vi.fn() }))

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/lib/nen-pets-api', () => ({
  nenPetsApi: health,
  petAnimalTypeLabel: (t: string) => (t === 'dog' ? '犬' : t === 'cat' ? '猫' : 'その他'),
  headCountLabel: (total: number) => `${total}頭中 1〜${total}頭`,
}))
vi.mock('@/lib/api', () => ({
  ApiError: class extends Error { status?: number; code?: string },
}))

import HealthPageV8 from '@/v8/nen-health/health'

const flush = () => act(async () => { await Promise.resolve() })

const healthRow = {
  pet: { id: 'pet-1', name: 'こむぎ', callName: 'こむぎ', animalType: 'dog', breed: '柴', ageLabel: '4歳', imageUrl: null },
  owner: { friendId: 'f1', name: '見本 169', customerId: '10234' },
  lastLoggedOn: '2026-09-30',
  lastLoggedLabel: '9/30 体重',
  daysSinceLast: 0,
  count30d: 28,
  totalRecords: 30,
  weightSeries: [9.8, 9.7, 9.6, 9.5, 9.4, 9.3, 9.2, 9.2],
  latestWeightKg: 9.2,
  weightChangePercent: -6,
  latestStool: '良い',
  latestAppetite: 'ふつう',
  changes: [],
  concerning: false,
}

const listData = {
  items: [healthRow],
  total: 1,
  page: 1,
  pageSize: 20,
  kpis: { recordsThisWeek: 5, petsWithRecords: 1, petsTotal: 1, concerning: 0, silent30: 0 },
}

const summaryData = {
  pet: { id: 'pet-1', name: 'こむぎ', callName: 'こむぎ', animalType: 'dog', breed: '柴', ageLabel: '4歳', weightKg: 9.2 },
  owner: { friendId: 'f1', name: '見本 169' },
  generatedAt: '2026-09-30T00:00:00Z',
  summary: {
    days: 30,
    records: 28,
    weight: { first: 9.8, last: 9.2, min: 9.1, max: 9.9 },
    heartRateAvg: 96,
    respiratoryRateAvg: 24,
    stool: { normal: 20 },
    appetite: { good: 15 },
    skin: {},
    tearStain: {},
    notes: [],
    logs: [
      { loggedOn: '2026-09-30', weightKg: 9.2, heartRateBpm: 96, respiratoryRateBpm: 24, stool: 'normal', appetite: 'good', skin: null, tearStain: null },
    ],
  },
  labels: { stool: { normal: '問題なし' }, appetite: { good: '良い' } },
}

afterEach(cleanup)

describe('健康日記 V8', () => {
  it('一覧は mIwA4 の印で8列と札を出す', async () => {
    health.health.mockResolvedValue({ success: true, data: listData })
    const { container } = render(<HealthPageV8 accountId="account-a" tab="logs" onChangeTab={() => undefined} />)
    await screen.findByText('こむぎ')
    expect(container.querySelector('[data-design-node="mIwA4"]')).toBeTruthy()
    const heads = Array.from(container.querySelectorAll('th')).map((th) => th.textContent)
    for (const head of ['ペット', '飼い主', '最終記録', '30日の記録', '体重の推移（8週）', '便・食いつき', '気になる変化', '操作']) {
      expect(heads).toContain(head)
    }
    expect(screen.getByTitle('体重の±10%の変化・便の異常・食いつき不良が3回続いたペットだけ出します')).toBeTruthy()
    expect(screen.getByText('いつもどおり')).toBeTruthy()
  })

  it('記録の項目は z2tvtX の印で決まりの表を出す', async () => {
    health.health.mockResolvedValue({ success: true, data: listData })
    const { container } = render(<HealthPageV8 accountId="account-a" tab="items" onChangeTab={() => undefined} />)
    await flush()
    expect(container.querySelector('[data-design-node="z2tvtX"]')).toBeTruthy()
    expect(screen.getByText('記録の形')).toBeTruthy()
    expect(screen.getByText('「気になる変化」に出る条件')).toBeTruthy()
    expect(screen.getByText('30日のまとめ', { selector: '[role=columnheader]' })).toBeTruthy()
  })

  it('行の「…」に飼い主を開く・トークで声をかけるが出る', async () => {
    health.health.mockResolvedValue({ success: true, data: listData })
    render(<HealthPageV8 accountId="account-a" tab="logs" onChangeTab={() => undefined} />)
    await screen.findByText('こむぎ')
    fireEvent.click(screen.getByRole('button', { name: '「こむぎ」の操作' }))
    expect(await screen.findByRole('menuitem', { name: '飼い主を開く' })).toBeTruthy()
    expect(await screen.findByRole('menuitem', { name: '飼い主にトークで声をかける' })).toBeTruthy()
  })

  it('行の「…」から30日のまとめ（BVuYh）を開く', async () => {
    health.health.mockResolvedValue({ success: true, data: listData })
    health.healthSummary.mockResolvedValue({ success: true, data: summaryData })
    const { container } = render(<HealthPageV8 accountId="account-a" tab="logs" onChangeTab={() => undefined} />)
    await screen.findByText('こむぎ')
    fireEvent.click(screen.getByRole('button', { name: '「こむぎ」の操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '30日のまとめ' }))
    expect(await screen.findByText('健康日記 30日のまとめ')).toBeTruthy()
    expect(document.querySelector('[data-design-node="BVuYh"]')).toBeTruthy()
    expect(screen.getByText('印刷・PDF に保存する')).toBeTruthy()
  })
})
