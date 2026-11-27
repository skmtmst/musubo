// @vitest-environment happy-dom
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import type { StaffMember } from '@line-crm/shared'

import React from 'react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'

const fixture = vi.hoisted(() => ({
  listMenus: null as null | (() => Promise<unknown>),
  putBulk: null as null | ((...args: unknown[]) => Promise<unknown>),
}))

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/booking/menus/staff',
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', accounts: [] }),
}))
vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(),
  usePageTitle: () => undefined,
}))

const memStorage = vi.hoisted(() => {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key) },
    setItem: (key: string, value: string) => { values.set(key, String(value)) },
  }
})
vi.stubGlobal('localStorage', memStorage)
memStorage.setItem('lh_staff_role', 'owner')

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    describeSaveFailure: () => '保存できませんでした',
    bookingApi: {
      listMenus: (...args: unknown[]) => fixture.listMenus!(...(args as [])),
      listStaff: async () => ({ staff: [{ id: 'staff-a', display_name: '担当A', is_active: 1 }] }),
      listStaffMenusBulk: async () => ({ staff: [{ staff_id: 'staff-a', matrix: [] }] }),
      putStaffMenusBulk: (...args: unknown[]) => fixture.putBulk!(...(args as [])),
    },
  }
})

import AssignMatrixV8 from '@/v8/booking-menus/assign'

const MENUS = [{
  id: 'menu-1', name: 'カット', category_label: null, description: null,
  duration_minutes: 60, buffer_after_minutes: 0, base_price: 8000,
  price_mode: 'fixed', sort_order: 0, is_active: 1, auto_tag_id: null,
}]

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

function renderPage() {
  render(
    <>
      <AssignMatrixV8 />
      <ToastHost />
    </>,
  )
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-18T00:00:00.000Z'))
  forgetStaffIdentity(); rememberStaffIdentity({ role: 'owner' } as StaffMember);
  clearToastsForTest()
  fixture.listMenus = async () => ({ menus: MENUS })
  fixture.putBulk = vi.fn(async () => ({ ok: true }))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('担当まとめ（V8）の読み込みと保存', () => {
  test('元の表との差分だけを未保存として扱い、保存後は基準を更新する', async () => {
    renderPage()
    await screen.findByText('だれがどのメニューを受けるか')
    expect(screen.queryByText('未保存の変更があります')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '保存する', exact: true }))
    expect(await screen.findByText('変更はありません。')).toBeTruthy()
    expect(fixture.putBulk).not.toHaveBeenCalled()
    const box = screen.getByRole('checkbox', { name: 'カット を 担当A が受ける' })
    fireEvent.click(box)
    expect(screen.getByText('未保存の変更があります')).toBeTruthy()
    fireEvent.click(box)
    expect(screen.queryByText('未保存の変更があります')).toBeNull()
    fireEvent.click(box)
    fireEvent.click(screen.getByRole('button', { name: '保存する', exact: true }))
    await waitFor(() => expect(fixture.putBulk).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByText('未保存の変更があります')).toBeNull())
    fireEvent.click(box)
    expect(screen.getByText('未保存の変更があります')).toBeTruthy()
  })

  test('保存が失敗したら理由と未保存を残し、もう一度保存できる', async () => {
    fixture.putBulk = vi.fn().mockRejectedValueOnce(new Error('private')).mockResolvedValue({ ok: true })
    renderPage()
    await screen.findByText('だれがどのメニューを受けるか')
    fireEvent.click(screen.getByRole('checkbox', { name: 'カット を 担当A が受ける' }))
    fireEvent.click(screen.getByRole('button', { name: '保存する', exact: true }))
    expect(await screen.findByText(/保存できませんでした/)).toBeTruthy()
    expect(screen.getByText('未保存の変更があります')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保存する', exact: true }))
    await waitFor(() => expect(fixture.putBulk).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText('未保存の変更があります')).toBeNull())
  })

  test('担当割当でも予約設定の題と9つのタブを保つ', async () => {
    renderPage()
    await screen.findByText('だれがどのメニューを受けるか')
    expect(screen.getByRole('heading', { name: '予約設定' })).toBeTruthy()
    expect(screen.getAllByRole('tab')).toHaveLength(9)
    expect(screen.getByRole('tab', { name: '担当スタッフ' }).getAttribute('aria-selected')).toBe('true')
  })

  test('読み込み中は「読み込み中」の文字を出さず骨組みの入れ物で待つ', async () => {
    const gate = deferred<unknown>()
    fixture.listMenus = () => gate.promise
    renderPage()

    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
    expect(screen.queryByText('読み込み中')).toBeNull()
    expect(screen.queryByText('メニューと担当スタッフを読み込んでいます。')).toBeNull()

    await act(async () => { gate.resolve({ menus: MENUS }) })
    expect(await screen.findByText('だれがどのメニューを受けるか')).toBeTruthy()
  })

  test('保存後は成功を知らせ、取り消し操作を出さない', async () => {
    renderPage()
    await screen.findByText('だれがどのメニューを受けるか')

    // 升を1つ受けに変えると保存帯が出る。
    fireEvent.click(screen.getByRole('checkbox', { name: 'カット を 担当A が受ける' }))
    const saveButton = screen.getByRole('button', { name: '保存する', exact: true })

    const gate = deferred<unknown>()
    fixture.putBulk = vi.fn(() => gate.promise)
    fireEvent.click(saveButton)

    // ボタンの内側だけ保存中に変わる。
    expect(await screen.findByRole('button', { name: '保存しています…' })).toBeTruthy()

    await act(async () => { gate.resolve({ ok: true }) })
    // 保存結果を知らせる。
    await waitFor(() => { expect(screen.getByRole('status', { name: '知らせ' }).textContent).toContain('保存しました') })
    expect(screen.getByRole('button', { name: '保存する', exact: true })).toBeTruthy()
    const firstCall = (fixture.putBulk as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
    expect(JSON.stringify(firstCall)).toContain('"is_offered":true')

    expect(screen.queryByRole('button', { name: '元に戻す' })).toBeNull()
    expect(fixture.putBulk).toHaveBeenCalledTimes(1)
  })
})
