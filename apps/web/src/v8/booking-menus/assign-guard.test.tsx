// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({
  accountId: 'acc-a' as string | null,
  canEdit: true,
  listMenus: vi.fn(),
  listStaff: vi.fn(),
  listStaffMenusBulk: vi.fn(),
  getStaffMenus: vi.fn(),
  putStaffMenusBulk: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/booking/menus/staff',
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: fx.accountId }),
}))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => (fx.canEdit ? 'owner' : 'viewer') }))
vi.mock('./lib/edit-permission', () => ({ useBookingEdit: () => fx.canEdit }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    bookingApi: {
      ...actual.bookingApi,
      listMenus: (...args: unknown[]) => fx.listMenus(...args),
      listStaff: (...args: unknown[]) => fx.listStaff(...args),
      listStaffMenusBulk: (...args: unknown[]) => fx.listStaffMenusBulk(...args),
      getStaffMenus: (...args: unknown[]) => fx.getStaffMenus(...args),
      putStaffMenusBulk: (...args: unknown[]) => fx.putStaffMenusBulk(...args),
    },
  }
})

import AssignMatrixV8 from './assign'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('AssignMatrixV8 ガード', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    fx.accountId = 'acc-a'
    fx.canEdit = true
  })

  afterEach(() => {
    cleanup()
  })

  it('アカウント切替時に古いアカウントの遅延応答で新しいアカウントの表を上書きせず、保存中は入力と二重送信をロックする', async () => {
    const menusA = deferred<{ menus: unknown[] }>()
    const staffA = deferred<{ staff: unknown[] }>()
    const saveDef = deferred<unknown>()

    fx.listMenus.mockImplementation((acc: string) => {
      if (acc === 'acc-a') return menusA.promise
      return Promise.resolve({
        menus: [{ id: 'm-b', name: '支店カット', sort_order: 1, duration_minutes: 60, base_price: 5000, price_mode: 'fixed' }],
      })
    })
    fx.listStaff.mockImplementation((acc: string) => {
      if (acc === 'acc-a') return staffA.promise
      return Promise.resolve({
        staff: [{ id: 's-b', name: '佐藤', display_name: '佐藤', is_active: true, is_designation_optional: 0 }],
      })
    })
    fx.listStaffMenusBulk.mockImplementation((acc: string) => {
      if (acc === 'acc-a') return Promise.resolve({ staff: [] })
      return Promise.resolve({
        staff: [{ staff_id: 's-b', matrix: [{ menu_id: 'm-b', name: '支店カット', is_offered: 0, override_duration_minutes: null, override_price: null }] }],
      })
    })
    fx.putStaffMenusBulk.mockReturnValue(saveDef.promise)

    const view = render(<AssignMatrixV8 />)

    // A の読み込み中にアカウントを B へ切替
    fx.accountId = 'acc-b'
    view.rerender(<AssignMatrixV8 />)

    await waitFor(() => {
      expect(screen.getByText('支店カット')).toBeTruthy()
    })

    // 遅れて A の応答が返っても B の表を上書きしない
    menusA.resolve({
      menus: [{ id: 'm-a', name: '本店カット', sort_order: 1, duration_minutes: 30, base_price: 3000, price_mode: 'fixed' }],
    })
    staffA.resolve({
      staff: [{ id: 's-a', name: '田中', display_name: '田中', is_active: true, is_designation_optional: 0 }],
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getByText('支店カット')).toBeTruthy()
    expect(screen.queryByText('本店カット')).toBeNull()

    // B のチェックボックスを変更して保存を実行
    const checkbox = screen.getByRole('checkbox', { name: '支店カット を 佐藤 が受ける' }) as HTMLInputElement
    fireEvent.click(checkbox)
    const saveBtn = screen.getByRole('button', { name: '保存する' })
    fireEvent.click(saveBtn)
    fireEvent.click(saveBtn)

    // 二重送信されず、保存中はチェックボックスが無効化される
    expect(fx.putStaffMenusBulk).toHaveBeenCalledTimes(1)
    expect(checkbox.disabled).toBe(true)

    saveDef.resolve({ ok: true })
    await waitFor(() => {
      expect((screen.getByRole('checkbox', { name: '支店カット を 佐藤 が受ける' }) as HTMLInputElement).disabled).toBe(false)
    })
  })

  it('一括応答で一部担当者の matrix が不正（null）でも空割当へ潰さず個別取得へ切り替え、既存割当と個別時間・料金を保って保存する', async () => {
    fx.listMenus.mockResolvedValue({
      menus: [{ id: 'm-1', name: 'カット', sort_order: 1, duration_minutes: 60, base_price: 5000, price_mode: 'fixed' }],
    })
    fx.listStaff.mockResolvedValue({
      staff: [
        { id: 's-1', name: '田中', display_name: '田中', is_active: true, is_designation_optional: 0 },
        { id: 's-2', name: '佐藤', display_name: '佐藤', is_active: true, is_designation_optional: 0 },
      ],
    })
    // s-1 の matrix が null（不正）
    fx.listStaffMenusBulk.mockResolvedValue({
      staff: [
        { staff_id: 's-1', matrix: null },
        { staff_id: 's-2', matrix: [{ menu_id: 'm-1', name: 'カット', is_offered: 0, override_duration_minutes: null, override_price: null }] },
      ],
    })
    // 個別取得では s-1 の本来の割当・個別時間・個別料金が返る
    fx.getStaffMenus.mockImplementation(async (_acc: string, staffId: string) => {
      if (staffId === 's-1') {
        return {
          matrix: [{ menu_id: 'm-1', name: 'カット', is_offered: 1, override_duration_minutes: 90, override_price: 7500 }],
        }
      }
      return {
        matrix: [{ menu_id: 'm-1', name: 'カット', is_offered: 0, override_duration_minutes: null, override_price: null }],
      }
    })
    fx.putStaffMenusBulk.mockResolvedValue({ ok: true })

    render(<AssignMatrixV8 />)

    await waitFor(() => {
      expect((screen.getByRole('checkbox', { name: 'カット を 田中 が受ける' }) as HTMLInputElement).checked).toBe(true)
    })

    // 佐藤だけを変更して保存しても、田中の既存割当・個別時間・個別料金が消えない
    fireEvent.click(screen.getByRole('checkbox', { name: 'カット を 佐藤 が受ける' }))
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))

    await waitFor(() => {
      expect(fx.putStaffMenusBulk).toHaveBeenCalledTimes(1)
    })
    expect(fx.putStaffMenusBulk).toHaveBeenCalledWith('acc-a', [
      {
        staff_id: 's-1',
        menus: [{ menu_id: 'm-1', is_offered: true, override_duration_minutes: 90, override_price: 7500 }],
      },
      {
        staff_id: 's-2',
        menus: [{ menu_id: 'm-1', is_offered: true, override_duration_minutes: null, override_price: null }],
      },
    ])
  })

  it('一括応答で必要な担当者が欠けており個別取得も失敗した場合は読み込み失敗で止め、空割当で保存できない', async () => {
    fx.listMenus.mockResolvedValue({
      menus: [{ id: 'm-1', name: 'カット', sort_order: 1, duration_minutes: 60, base_price: 5000, price_mode: 'fixed' }],
    })
    fx.listStaff.mockResolvedValue({
      staff: [
        { id: 's-1', name: '田中', display_name: '田中', is_active: true, is_designation_optional: 0 },
        { id: 's-2', name: '佐藤', display_name: '佐藤', is_active: true, is_designation_optional: 0 },
      ],
    })
    // s-1 が欠損している一括応答
    fx.listStaffMenusBulk.mockResolvedValue({
      staff: [
        { staff_id: 's-2', matrix: [{ menu_id: 'm-1', name: 'カット', is_offered: 0, override_duration_minutes: null, override_price: null }] },
      ],
    })
    fx.getStaffMenus.mockRejectedValue(new Error('network error'))

    render(<AssignMatrixV8 />)

    await waitFor(() => {
      expect(screen.getByText('表示できませんでした')).toBeTruthy()
    })

    expect(screen.queryByRole('checkbox')).toBeNull()
    const saveBtn = screen.getByRole('button', { name: '保存する' }) as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)
    fireEvent.click(saveBtn)
    expect(fx.putStaffMenusBulk).not.toHaveBeenCalled()
  })
})
