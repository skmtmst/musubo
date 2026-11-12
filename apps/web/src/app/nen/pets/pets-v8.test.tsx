// @vitest-environment happy-dom
/*
 * ★V8-B マイペット（・・）の骨格。
 * データの口は 管理画面 と同じ（nenPetsApi.pets・nenRanksApi.feeding）。
 * 板の印・10列・節のカード・計算のカード・小窓の見出しを見る。
 */
import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const pets = vi.hoisted(() => ({ pets: vi.fn() }))
const feeding = vi.hoisted(() => ({ feeding: vi.fn(), saveFeeding: vi.fn() }))
const staffMe = vi.hoisted(() => ({ me: vi.fn() }))

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/lib/nen-pets-api', () => ({
  nenPetsApi: pets,
  petAnimalTypeLabel: (t: string) => (t === 'dog' ? '犬' : t === 'cat' ? '猫' : 'その他'),
  headCountLabel: (total: number) => `${total}頭中 1〜${total}頭`,
}))
vi.mock('@/lib/nen-ranks-api', () => ({ nenRanksApi: feeding }))
vi.mock('@/lib/api', () => ({
  ApiError: class extends Error { status?: number; code?: string },
  api: { staff: staffMe, nenCampaigns: { updatePet: vi.fn() } },
  describeSaveFailure: () => '保存できませんでした。',
}))

import PetsPageV8 from '@/v8/nen-pets/pets'

const flush = () => act(async () => { await Promise.resolve() })

const petRow = {
  id: 'pet-1',
  name: 'こむぎ',
  callName: 'こむぎ',
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
  feeding: { dailyKcal: 560, dailyGrams: 128, factorLabel: '', stageLabel: '成犬', venisonGrams: 12, venisonKcal: 40, treatName: null },
  imageUrl: null,
  updatedAt: 'v1',
  weightUpdatedAt: '2026-09-28T00:00:00Z',
  weightStale: false,
  owner: { friendId: 'f1', name: '見本 169', pictureUrl: null, customerId: '10234' },
}

const listData = {
  items: [petRow],
  total: 1,
  page: 1,
  pageSize: 10,
  kpis: { total: 1, dogs: 1, cats: 0, newThisMonth: 0, computable: 1, staleWeight: 0 },
  products: [],
  treatLimitPercent: 10,
}

afterEach(cleanup)

describe('マイペット V8', () => {
  it('一覧は wTIej の印で10列を出す', async () => {
    staffMe.me.mockResolvedValue({ success: true, data: { role: 'owner' } })
    pets.pets.mockResolvedValue({ success: true, data: listData })
    const { container } = render(<PetsPageV8 accountId="account-a" tab="pets" onChangeTab={() => undefined} />)
    await screen.findByText('こむぎ')
    expect(container.querySelector('[data-design-node="wTIej"]')).toBeTruthy()
    for (const head of ['ペット', '飼い主', '年齢', '体重', '今日の目安', '避妊去勢', '運動量', '主食', '体重の更新']) {
      expect(screen.getByText(head)).toBeTruthy()
    }
    expect(screen.getByText('見本 169')).toBeTruthy()
    expect(await screen.findByText('マイページで更新を促す', { exact: false, selector: 'p' })).toBeTruthy()
  })

  it('ごはんの目安は h7A2F の印で節と計算のカードを出す', async () => {
    pets.pets.mockResolvedValue({ success: true, data: listData })
    feeding.feeding.mockResolvedValue({
      success: true,
      data: {
        products: [{ id: 'p1', name: 'ドライフード', kcalPer100g: 380, isDefault: true, kind: 'staple' }],
        treatLimitPercent: 10,
        petCount: 1,
      },
    })
    const { container } = render(<PetsPageV8 accountId="account-a" tab="feeding" onChangeTab={() => undefined} />)
    await screen.findByText('主食（お客さまが選ぶ、ふだんのごはん）')
    expect(container.querySelector('[data-design-node="h7A2F"]')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '今日の目安の計算' })).toBeTruthy()
    expect(screen.getByText('安静時エネルギー')).toBeTruthy()
    expect(screen.getByRole('button', { name: '保存する' })).toBeTruthy()
  })

  it('読み込めないときは失敗面を出す', async () => {
    staffMe.me.mockResolvedValue({ success: true, data: { role: 'owner' } })
    pets.pets.mockResolvedValue({ success: false, error: 'x' })
    render(<PetsPageV8 accountId="account-a" tab="pets" onChangeTab={() => undefined} />)
    expect(await screen.findByText('ペットを読み込めませんでした')).toBeTruthy()
  })
})
