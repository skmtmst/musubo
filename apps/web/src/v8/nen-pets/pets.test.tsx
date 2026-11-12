// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
/*
 * V8 マイペット（src/v8/nen-pets）の動きの試験。BEHAVIOR.md を守る。
 * 一覧を取り直し続けない・「…」→ペットの情報を直す（版つき保存・409 で止める）・
 * ごはんの目安の保存・閲覧のみで押せないボタンを置かない、を確かめる。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NenPetListData, NenPetRow } from '@/lib/nen-pets-api'
import type { NenFeedingData } from '@/lib/nen-ranks-api'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const fetchApi = vi.hoisted(() => vi.fn())
const role = vi.hoisted(() => ({ value: 'owner' as string | null }))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
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
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => role.value }
})

import { ApiError, api } from '@/lib/api'
import PetsV8, { type PetTab } from './pets'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const KOMUGI: NenPetRow = {
  id: 'pet-komugi', name: 'こむぎ', callName: 'こむぎちゃん', gender: 'female', animalType: 'dog', breed: '柴', birthday: '2022-04-03', ageLabel: '4歳',
  weightKg: 9.2, neutered: 'yes', activityLevel: 'normal', activityLabel: 'ふつう', productName: 'ドライフード（成犬）',
  feeding: { dailyKcal: 560, dailyGrams: 128, factorLabel: '避妊・去勢済み', stageLabel: '成犬', venisonGrams: 12, venisonKcal: 56, treatName: null },
  imageUrl: null, updatedAt: '2026-09-28T10:00:00+09:00', weightUpdatedAt: '2026-09-28T10:00:00+09:00', weightStale: false,
  owner: { friendId: 'friend-3', name: '見本 169', pictureUrl: null, customerId: '10234' },
}
const HANA: NenPetRow = { ...KOMUGI, id: 'pet-hana', name: 'ハナ', callName: 'ハナちゃん', animalType: 'cat', breed: '雑種', weightStale: true, weightUpdatedAt: '2026-06-12T10:00:00+09:00', feeding: { ...KOMUGI.feeding!, venisonGrams: null, stageLabel: 'シニア' } }
const LIST: NenPetListData = {
  items: [KOMUGI, HANA], total: 2, page: 1, pageSize: 10,
  kpis: { total: 8, dogs: 4, cats: 3, newThisMonth: 2, computable: 5, staleWeight: 2 },
  products: [], treatLimitPercent: 10,
}
const FEEDING: NenFeedingData = {
  products: [
    { id: 'st-1', name: 'ドライフード（成犬・成猫用）', kcalPer100g: 380, isDefault: true, kind: 'staple' },
    { id: 'st-2', name: 'ウェットフード', kcalPer100g: 90, isDefault: false, kind: 'staple' },
    { id: 'nen-1', name: '然 鹿肉ジャーキー', kcalPer100g: 330, isDefault: true, kind: 'nen' },
  ],
  treatLimitPercent: 10,
  petCount: 8,
}

let host: HTMLDivElement
let root: Root

async function settle(ms = 30) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) })
}
async function render(tab: PetTab) {
  await act(async () => { root.render(<PetsV8 accountId="acc-1" tab={tab} onChangeTab={() => {}} />) })
  await settle()
}
const buttons = () => Array.from(document.querySelectorAll('button'))
const byText = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button,a')].find((b) => b.textContent?.trim() === text)
const byLabel = (label: string) => buttons().find((b) => b.getAttribute('aria-label') === label)
async function click(target: Element | undefined) {
  expect(target).toBeTruthy()
  await act(async () => { fireEvent.click(target!) })
  await settle()
}
const listCalls = () => fetchApi.mock.calls.filter(([path]) => String(path).startsWith('/api/nen/pets?') && !String(path).includes('pageSize=all'))

describe('V8 マイペット（src/v8/nen-pets）', () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/")
    document.documentElement.dataset.theme = 'v8'
    role.value = verifiedStaffRole('owner')
    LIST.products = []
    fetchApi.mockReset()
    fetchApi.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/nen/pets?')) return { success: true, data: LIST }
      if (path.startsWith('/api/nen/feeding-products')) return { success: true, data: FEEDING }
      return { success: true, data: {} }
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    act(() => { root.unmount() })
    host.remove()
    delete document.documentElement.dataset.theme
  })

  it('主食の絞り込みで実際の商品を選び、一覧を同じ条件で取り直す', async () => {
    LIST.products = [{ id: 'st-1', name: 'いつものごはん' }]
    await render('pets')
    expect(document.querySelectorAll('[data-kpi-icon] svg.lucide-circle-plus')).toHaveLength(1)
    expect(document.querySelectorAll('[data-kpi-icon] svg.lucide-circle-minus')).toHaveLength(1)
    expect(document.querySelectorAll('[data-kpi-icon] svg.lucide-undo-2')).toHaveLength(1)
    await click(byLabel('主食で絞り込む'))
    await click(screen.getByRole('radio', { name: 'いつものごはん' }))
    expect(listCalls().some(([path]) => String(path).includes('product=st-1'))).toBe(false)
    await click(byText('選ぶ'))
    expect(listCalls().some(([path]) => String(path).includes('product=st-1'))).toBe(true)
    await click(byLabel('主食で絞り込む'))
    await click(screen.getByRole('radio', { name: 'すべて' }))
    expect(String(listCalls().at(-1)?.[0])).toContain('product=st-1')
    await click(byText('選ぶ'))
    expect(String(listCalls().at(-1)?.[0])).not.toContain('product=st-1')
    LIST.products = []
  })

  it('一覧は1回だけ取り、数の帯・今日の目安・体重の古い札を出す（取り直しの輪にならない）', async () => {
    await render('pets')
    await settle(80)
    expect(listCalls()).toHaveLength(1)
    expect(host.textContent).toContain('登録ペット 8')
    expect(host.textContent).toContain('犬 4・猫 3・その他 1')
    expect(host.textContent).toContain('128g／日')
    expect(host.textContent).toContain('約560kcal・鹿肉 12g')
    expect(host.textContent).toContain('約560kcal・シニア')
    expect(host.textContent).toContain('06/12')
  })

  it('110: 体重が古い行は日付の下に黄の札「90日以上前」を出す', async () => {
    await render('pets')
    await settle(80)
    const name = screen.getByText('ハナ')
    const row = name.closest('tr')!
    /* 日付は残し、意味は札の文字で出す。札の中身が日付だけだと意味が伝わらない。 */
    expect(row.textContent).toContain('06/12')
    const badge = row.querySelector('[data-tone="warning"]')!
    expect(badge.textContent).toContain('90日以上前')
  })

  it('名前が空なら保存せず、欄を赤くしてそこへ移動し、直すと理由が消える', async () => {
    await render('pets')
    await click(byLabel('「こむぎ」の操作'))
    await click(byText('ペットの情報を編集する'))
    const name = document.querySelector<HTMLInputElement>('input[aria-label="ペットの名前"]')!
    const update = vi.spyOn(api.nenCampaigns, 'updatePet')
    await act(async () => { fireEvent.change(name, { target: { value: '' } }) })
    await click(byText('保存する'))
    await settle(40)
    expect(update).not.toHaveBeenCalled()
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(name.getAttribute('aria-describedby')).toContain('pet-edit-name-error')
    expect(document.activeElement).toBe(name)
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1)
    await act(async () => { fireEvent.change(name, { target: { value: 'こむぎ' } }) })
    expect(name.getAttribute('aria-invalid')).not.toBe('true')
    expect(document.getElementById('pet-edit-name-error')).toBeNull()
  })

  it('「…」→ペットの情報を直す：版つきで保存し、体重の「kg」は外して数で送る', async () => {
    await render('pets')
    await click(byLabel('「こむぎ」の操作'))
    await click(byText('ペットの情報を編集する'))
    expect(document.body.textContent).toContain('飼い主 見本 169さん・EC-10234')
    const weight = document.querySelector<HTMLInputElement>('input[aria-label="体重"]')
    expect(weight?.value).toBe('9.2 kg')
    await act(async () => { fireEvent.change(weight!, { target: { value: '9.0 kg' } }) })
    const update = vi.spyOn(api.nenCampaigns, 'updatePet').mockResolvedValue({ success: true, data: { updatedAt: '2026-10-01T00:00:00Z' } })
    await click(byText('保存する'))
    expect(update).toHaveBeenCalledWith('acc-1', 'pet-komugi', expect.objectContaining({ name: 'こむぎ', animalType: 'dog', gender: 'female', birthday: '2022-04-03', weightKg: 9, expectedUpdatedAt: KOMUGI.updatedAt }))
    // 保存できたら窓を閉じて一覧を取り直す。
    expect(document.body.textContent).not.toContain('間違っている項目を直して保存します')
    expect(listCalls().length).toBeGreaterThanOrEqual(2)
  })

  it('ほかの人が先に直していたら（409）止めて、入力を残したまま知らせる', async () => {
    await render('pets')
    await click(byLabel('「こむぎ」の操作'))
    await click(byText('ペットの情報を編集する'))
    const update = vi.spyOn(api.nenCampaigns, 'updatePet').mockRejectedValue(new ApiError(409, 'conflict', 'VERSION_CONFLICT', { latest: { updatedAt: '2026-10-02T00:00:00Z' } }))
    await click(byText('保存する'))
    expect(update).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('ほかの人が先にペットの情報を変えました')
    expect(document.querySelector<HTMLInputElement>('input[aria-label="ペットの名前"]')?.value).toBe('こむぎ')
    // もう一度保存するときは、409 で受け取った最新の版で送る。
    update.mockResolvedValue({ success: true, data: { updatedAt: '2026-10-03T00:00:00Z' } })
    await click(byText('保存する'))
    expect(update).toHaveBeenLastCalledWith('acc-1', 'pet-komugi', expect.objectContaining({ expectedUpdatedAt: '2026-10-02T00:00:00Z' }))
  })

  it('ごはんの目安：既定を替えて保存すると、種類ごとに既定が1つの形で送る', async () => {
    await render('feeding')
    expect(host.textContent).toContain('今日の目安の計算')
    await click(byText('既定にする'))
    fetchApi.mockImplementationOnce(async () => ({ success: true, data: FEEDING }))
    await click(buttons().find((b) => b.textContent?.trim() === '保存する'))
    const call = fetchApi.mock.calls.find(([path, options]) => path === '/api/nen/feeding-products' && options?.method === 'PUT')
    expect(call).toBeTruthy()
    const body = JSON.parse(call![1].body)
    expect(body.products.filter((p: { kind: string; isDefault: boolean }) => p.kind === 'staple' && p.isDefault).map((p: { id: string }) => p.id)).toEqual(['st-2'])
    expect(body.products.find((p: { id: string }) => p.id === 'nen-1').isDefault).toBe(true)
    expect(body.treatLimitPercent).toBe(10)
  })

  it('閲覧のみ：帯を出し、直す・既定にする・削除・追加・保存を置かない（CSV は使える）', async () => {
    role.value = verifiedStaffRole('staff')
    await render('pets')
    expect(host.textContent).toContain('閲覧のみで見ています')
    await click(byLabel('「こむぎ」の操作'))
    expect(byText('ペットの情報を編集する')).toBeFalsy()
    expect(byText('飼い主を開く')).toBeTruthy()
    expect(buttons().some((b) => b.textContent?.includes('CSVで書き出す'))).toBe(true)
    await act(async () => { root.render(<PetsV8 accountId="acc-1" tab="feeding" onChangeTab={() => {}} />) })
    await settle()
    for (const text of ['既定にする', 'これを使う', '＋ 主食を追加する', '＋ 然の商品を追加する', '保存する', 'キャンセル']) {
      expect(buttons().some((b) => b.textContent?.trim() === text)).toBe(false)
    }
    expect(buttons().some((b) => b.getAttribute('aria-label')?.endsWith('を削除する'))).toBe(false)
  })
})

afterEach(() => { verifiedStaffRole(null) })
