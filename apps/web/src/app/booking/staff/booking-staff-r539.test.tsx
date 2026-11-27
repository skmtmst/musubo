// @vitest-environment happy-dom
/*
 * R539: 予約スタッフ一覧の429は、待ち案内と一緒に画面内の再読込で
 * 取り直せる。403だけが権限案内のみで再試行の口を出さない。
 */
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const fixture = vi.hoisted(() => ({
  listStaff: vi.fn() as unknown as (...args: unknown[]) => Promise<unknown>,
  account: 'account-a',
}))

// 画面は localStorage の権限表を読む。happy-dom では未定義なので
// インメモリに差し替え、既定を owner（全通過）にする。
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

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: fixture.account }),
}))
vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(), usePageTitle: vi.fn() }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status?: number
  },
  bookingApi: {
    listStaff: (...args: unknown[]) => fixture.listStaff(...args),
    createStaff: vi.fn(),
    updateStaff: vi.fn(),
    deleteStaff: vi.fn(),
  },
  api: { staff: { list: async () => ({ success: true, data: [] }) } },
}))

import { ApiError as MockApiError } from '@/lib/api'
import BookingStaffPage from './page'

const ROW = {
  id: 'staff-a',
  name: 'kasei',
  display_name: '稼働さん',
  role: 'スタイリスト',
  profile_image_url: '',
  bio: '',
  sort_order: 0,
  is_designation_optional: 0,
  is_active: 1,
}

beforeEach(() => {
  fixture.account = 'account-a'
  fixture.listStaff = vi.fn(async () => ({ staff: [ROW] })) as unknown as typeof fixture.listStaff
})

afterEach(cleanup)

describe('R539 429は画面内の再読込で取り直せる', () => {
  test('混雑のあと復旧すれば、同じ画面の再読込で一覧が戻る', async () => {
    fixture.listStaff = vi.fn(async () => {
      throw Object.assign(new MockApiError('rate limited'), { status: 429 })
    }) as unknown as typeof fixture.listStaff
    render(<BookingStaffPage />)

    // 待ち案内と一緒に再試行の口が出る。
    await screen.findByText('予約スタッフを読み込めませんでした')
    const retry = screen.getByRole('button', { name: '予約スタッフを再読み込み' })

    fixture.listStaff = vi.fn(async () => ({ staff: [ROW] })) as unknown as typeof fixture.listStaff
    fireEvent.click(retry)
    await screen.findByText('稼働さん')
  })

  test('通信断は空一覧ではなく理由を表示し、作成を押せなくする', async () => {
    fixture.listStaff = vi.fn(async () => { throw new Error('private network failure') }) as unknown as typeof fixture.listStaff
    render(<BookingStaffPage />)
    await screen.findByText('予約スタッフを読み込めませんでした')
    expect(screen.getByText(/登録したスタッフは消えていません/)).toBeTruthy()
    expect(screen.queryByText(/private network failure/)).toBeNull()
    expect(screen.queryByText('予約スタッフはまだいません')).toBeNull()
    expect((screen.getByRole('button', { name: /スタッフを作る/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  test.each(['success', 'failure'])('店を切り替えた後の古い%s応答を表示しない', async (result) => {
    let resolveOld!: (value: unknown) => void
    let rejectOld!: (reason: unknown) => void
    fixture.listStaff = vi.fn((account: unknown) => account === 'account-a'
      ? new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject })
      : Promise.resolve({ staff: [{ ...ROW, id: 'new', display_name: '新しい店舗の担当' }] })) as unknown as typeof fixture.listStaff
    const view = render(<BookingStaffPage />)
    fixture.account = 'account-b'
    view.rerender(<BookingStaffPage />)
    await screen.findByText('新しい店舗の担当')
    await act(async () => { if (result === 'success') resolveOld({ staff: [ROW] }); else rejectOld(new Error('old failure')) })
    expect(screen.queryByText('稼働さん')).toBeNull()
    expect(screen.queryByText('予約スタッフを読み込めませんでした')).toBeNull()
    expect(screen.getByText('新しい店舗の担当')).toBeTruthy()
  })

  test('403は権限案内のみで、再試行の口は出さない', async () => {
    fixture.listStaff = vi.fn(async () => {
      throw Object.assign(new MockApiError('forbidden'), { status: 403 })
    }) as unknown as typeof fixture.listStaff
    render(<BookingStaffPage />)

    await screen.findByText('予約スタッフを読み込めませんでした')
    expect(screen.queryByRole('button', { name: '予約スタッフを再読み込み' })).toBeNull()
  })

  test('通信断でも再試行の口は出る', async () => {
    fixture.listStaff = vi.fn(async () => { throw new Error('network') }) as unknown as typeof fixture.listStaff
    render(<BookingStaffPage />)

    await screen.findByText('予約スタッフを読み込めませんでした')
    expect(screen.getByRole('button', { name: '予約スタッフを再読み込み' })).toBeTruthy()
  })
})
