// @vitest-environment happy-dom
/*
 * R308/R309: 担当割当表を実物の React で描いて確かめる。
 *
 * - R308: 「提供できる数」は有効の担当だけ。非公開の担当は割当として
 *   数え、列見出しに「非公開」と出す。受付できる担当がいないメニューは
 *   警告する（誰も割っていない場合と、非公開しかいない場合を分ける）。
 * - R309: 標準の料金は一覧と同じ言葉（お問い合わせ・無料・¥）で出す。
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

const fixture = vi.hoisted(() => ({
  listMenus: null as null | (() => Promise<unknown>),
  listStaff: null as null | (() => Promise<unknown>),
  listStaffMenusBulk: null as null | (() => Promise<unknown>),
  putStaffMenusBulk: null as null | ((...args: unknown[]) => Promise<unknown>),
  getStaffMenus: vi.fn(),
}))

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a' }),
}))

vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(),
  usePageTitle: () => undefined,
}))

// R538: この試験は編集できる立場で表を触る。閲覧のみの出し分けは
// page.r537-r538.test.tsx が担う。
vi.mock('@/lib/staff-capability', () => ({
  canEditFeature: () => true,
  canViewFeature: () => true,
}))

vi.mock('@/lib/api', () => ({
  bookingApi: {
    listMenus: (...args: unknown[]) => fixture.listMenus!(...(args as [])),
    listStaff: (...args: unknown[]) => fixture.listStaff!(...(args as [])),
    listStaffMenusBulk: (...args: unknown[]) => fixture.listStaffMenusBulk!(...(args as [])),
    getStaffMenus: (...args: unknown[]) => fixture.getStaffMenus(...args),
    putStaffMenusBulk: (...args: unknown[]) => fixture.putStaffMenusBulk!(...args),
  },
}))

import MenuStaffMatrix from './page'

const MENUS = [
  { id: 'menu-cut', name: 'カット', duration_minutes: 60, base_price: 8000, price_mode: 'fixed', is_active: 1 },
  { id: 'menu-inquiry', name: '相談', duration_minutes: 30, base_price: 0, price_mode: 'inquiry', is_active: 1 },
  { id: 'menu-free', name: 'お試し', duration_minutes: 15, base_price: 0, price_mode: 'free', is_active: 1 },
  { id: 'menu-hidden-only', name: '特別ケア', duration_minutes: 90, base_price: 5000, price_mode: 'fixed', is_active: 1 },
]

const STAFF = [
  { id: 'staff-a', name: '稼働', display_name: '稼働さん', is_active: 1, is_designation_optional: 0 },
  { id: 'staff-h', name: '非公開', display_name: '非公開さん', is_active: 0, is_designation_optional: 0 },
]

function matrixRow(staffId: string, offeredMenuIds: string[]) {
  return {
    staff_id: staffId,
    matrix: MENUS.map((m) => ({
      menu_id: m.id,
      name: m.name,
      is_offered: offeredMenuIds.includes(m.id) ? 1 : 0,
      override_duration_minutes: null,
      override_price: null,
    })),
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-18T00:00:00.000Z'))
  fixture.listMenus = async () => ({ menus: MENUS })
  fixture.listStaff = async () => ({ staff: STAFF })
  fixture.listStaffMenusBulk = async () => ({
    staff: [
      matrixRow('staff-a', ['menu-cut', 'menu-inquiry']),
      matrixRow('staff-h', ['menu-cut', 'menu-hidden-only']),
    ],
  })
  fixture.putStaffMenusBulk = vi.fn(async () => ({ ok: true }))
  fixture.getStaffMenus.mockReset().mockResolvedValue({ matrix: [] })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** メニュー名の行。 */
function menuRow(name: string): HTMLElement {
  return screen.getByText(name).closest('tr') as HTMLElement
}

describe('R308 提供できる数は有効の担当だけ', () => {
  test('担当ごとに読まず、割り当て表を一括で1回だけ読む', async () => {
    fixture.listStaffMenusBulk = vi.fn(async () => ({ staff: [matrixRow('staff-a', ['menu-cut']), matrixRow('staff-h', [])] }))
    render(<MenuStaffMatrix />)
    await screen.findByText('カット')
    expect(fixture.listStaffMenusBulk).toHaveBeenCalledTimes(1)
    expect(fixture.listStaffMenusBulk).toHaveBeenCalledWith('account-a')
    expect(fixture.getStaffMenus).not.toHaveBeenCalled()
    expect((within(menuRow('カット')).getByRole('checkbox', { name: 'カット を 稼働さん が受ける' }) as HTMLInputElement).checked).toBe(true)
  })

  test('一括取得に失敗したときだけ担当ごとに読み直す', async () => {
    fixture.listStaffMenusBulk = vi.fn(async () => { throw new Error('unavailable') })
    render(<MenuStaffMatrix />)
    await screen.findByText('カット')
    expect(fixture.listStaffMenusBulk).toHaveBeenCalledTimes(1)
    expect(fixture.getStaffMenus).toHaveBeenCalledTimes(2)
    expect(fixture.getStaffMenus).toHaveBeenCalledWith('account-a', 'staff-a')
    expect(fixture.getStaffMenus).toHaveBeenCalledWith('account-a', 'staff-h')
  })

  test('非公開の担当は割当として数え、見出しに「非公開」と出す', async () => {
    render(<MenuStaffMatrix />)
    await screen.findByText('カット')

    // 列見出しで非公開と分かる。
    const header = screen.getByText('非公開さん').closest('th') as HTMLElement
    expect(within(header).getByText('停止中')).toBeTruthy()
    // 有効の見出しには付けない。
    const activeHeader = screen.getByText('稼働さん').closest('th') as HTMLElement
    expect(within(activeHeader).queryByText('停止中')).toBeNull()

    // カットは稼働1＋非公開1の割当。受付できる数は1人と区別する。
    const cut = menuRow('カット')
    expect(cut.closest('[data-template-region="content"]')?.closest('[data-page-template="create"]')).toBeTruthy()
    expect((within(cut).getByRole('checkbox', { name: 'カット を 稼働さん が受ける' }) as HTMLInputElement).checked).toBe(true)
    expect((within(cut).getByRole('checkbox', { name: 'カット を 非公開さん が受ける' }) as HTMLInputElement).checked).toBe(true)
    expect(screen.queryByText(/「カット」は受付を止めている担当しか/)).toBeNull()
  })

  test('非公開だけの割当は受付可能0人と警告する', async () => {
    render(<MenuStaffMatrix />)
    await screen.findByText('カット')

    // 特別ケアは非公開しかいない。受付できる数は0人、割当は残す。
    const row = menuRow('特別ケア')
    expect((within(row).getByRole('checkbox', { name: '特別ケア を 稼働さん が受ける' }) as HTMLInputElement).checked).toBe(false)
    expect((within(row).getByRole('checkbox', { name: '特別ケア を 非公開さん が受ける' }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText(/「特別ケア」は受付を止めている担当しかいません。/)).toBeTruthy()
    // 誰も割っていない「お試し」とは別の文言。
    expect(screen.getByText(/「お試し」は担当が0人です。/)).toBeTruthy()
  })

  test('有効を外す（未保存）と受付できる数が減り、警告が出る', async () => {
    render(<MenuStaffMatrix />)
    await screen.findByText('カット')

    // 相談は有効だけの割当。外すと受付できる数が0人になる。
    const row = menuRow('相談')
    const activeBox = within(row).getByRole('checkbox', { name: '相談 を 稼働さん が受ける' })
    fireEvent.click(activeBox)

    expect((activeBox as HTMLInputElement).checked).toBe(false)
    // お試しと並んで「担当できるスタッフがいません」に入る。
    const warn = await screen.findByRole('alert')
    const box = warn.closest('[data-design="Warn"]') as HTMLElement
    expect(box.textContent).toContain('「相談」')
    expect(box.textContent).toContain('担当が0人です')
  })
})

describe('R309 標準の料金は一覧と同じ言葉', () => {
  test('お問い合わせ・無料・固定料金を区別し、¥0と出さない', async () => {
    render(<MenuStaffMatrix />)
    await screen.findByText('カット')

    for (const [name, price] of [['カット', '¥8,000'], ['相談', 'お問い合わせ'], ['お試し', '無料']]) {
      fireEvent.click(menuRow(name).querySelector('td')!)
      fireEvent.click(screen.getByRole('button', { name: 'このスタッフの料金の説明' }))
      expect(screen.getByText(`メニューは ${price}`)).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'このスタッフの料金の説明' }))
    }
    // 標準の設定に金額0の表示は残らない。
    expect(screen.queryByText('¥0')).toBeNull()
  })
})
