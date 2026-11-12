// @vitest-environment happy-dom
/*
 * ★V8 勤務とシフト・自分の勤務・ひも付けなしの動き。
 * - 役割はサーバー（/api/staff/me）で決める（手元の保存値が owner でも、サーバーが staff なら本人の画面）。
 * - 休憩は同じ時刻の曜日を1行にまとめ、保存のときは曜日ごとに広げる。
 * - 変える権限が無い人には保存・足す・ごみ箱のボタンを置かない。
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const fixture = vi.hoisted(() => ({
  query: '', account: 'account-a',
  role: 'owner' as string,
  replace: vi.fn(),
  push: vi.fn(),
  myStaff: [] as Array<Record<string, unknown>>,
  putBreaks: vi.fn(), putRules: vi.fn(), putDates: vi.fn(),
  rules: [{ weekday: 1, start_time: '10:00', end_time: '19:00' }] as Array<{ weekday: number; start_time: string; end_time: string }>,
  getRules: vi.fn(), getBreaks: vi.fn(), listMenus: vi.fn(), getAvailability: vi.fn(), getDates: vi.fn(), createException: vi.fn(),
}))

const stableRouter = { replace: (...args: unknown[]) => fixture.replace(...args), push: (...args: unknown[]) => fixture.push(...args) }
vi.mock('next/navigation', () => ({ useRouter: () => stableRouter, useSearchParams: () => new URLSearchParams(fixture.query) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined, usePageCrumbs: () => undefined }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fixture.account, selectedAccount: null }) }))

const STAFF = { id: 'bs-1', name: '見本 110', display_name: '佐々木', role: 'トリマー', profile_image_url: null, bio: null, sort_order: 1, is_designation_optional: 0, is_active: 1 }

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number
    data?: unknown
    constructor(status: number, message?: string) {
      super(message ?? `API error: ${status}`)
      this.status = status
    }
  }
  return {
    ApiError,
    api: { staff: { me: async () => ({ success: true, data: { id: 'me', name: 'me', role: fixture.role, email: null } }) } },
    bookingApi: {
      listMyStaff: async () => ({ staff: fixture.myStaff }),
      listStaff: async () => ({ staff: [STAFF] }),
      getSettings: async () => ({ success: true, data: { timeZone: 'Asia/Tokyo', exceptions: [], businessHoursConfigured: false, businessHours: [] } }),
      listMenus: (...args: unknown[]) => fixture.listMenus(...args),
      listExceptions: async () => ({ success: true, data: { items: [] } }),
      getAvailabilityRules: (...args: unknown[]) => fixture.getRules(...args),
      getAvailability: (...args: unknown[]) => fixture.getAvailability(...args),
      getShifts: async () => ({ shifts: [] }),
      getBreaks: (...args: unknown[]) => fixture.getBreaks(...args),
      getBreakDates: (...args: unknown[]) => fixture.getDates(...args),
      createException: (...args: unknown[]) => fixture.createException(...args),
      getGoogleCalendar: async () => ({ connection: null, service_account: { configured: true } }),
      putBreaks: (...args: unknown[]) => fixture.putBreaks(...args),
      putAvailabilityRules: (...args: unknown[]) => fixture.putRules(...args),
      putBreakDates: (...args: unknown[]) => fixture.putDates(...args),
    },
  }
})

vi.mock('@/components/shared/date-field', () => ({ default: (p: { value: string; onChange: (v: string) => void; 'aria-label'?: string }) => <input aria-label={p['aria-label']} value={p.value} onChange={(e) => p.onChange(e.target.value)} /> }))

import { ApiError } from '@/lib/api'
import StaffShiftsV8, { groupBreaks, shortDay, weekdaySetLabel } from './shifts'
import StaffShiftsPage from '@/app/booking/staff/shifts/page'

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

beforeEach(() => {
  fixture.account = 'account-a'; fixture.query = ''
  memStorage.setItem('lh_staff_role', 'owner')
  fixture.role = 'owner'
  fixture.myStaff = []
  fixture.replace.mockClear()
  fixture.listMenus.mockReset().mockResolvedValue({ menus: [] })
  fixture.getRules.mockReset().mockImplementation(async () => ({ rules: fixture.rules }))
  fixture.getAvailability.mockReset().mockResolvedValue({ by_staff: [], closed_dates: [] })
  fixture.getBreaks.mockReset().mockResolvedValue({
    version: 'v1',
    breaks: [1, 2, 3, 4, 5].map((weekday) => ({ id: `bb-${weekday}`, weekday, start_time: '13:00', end_time: '14:00' })),
  })
  fixture.putRules.mockReset().mockResolvedValue({ ok: true })
  fixture.rules = [{ weekday: 1, start_time: '10:00', end_time: '19:00' }]
  fixture.getDates.mockReset().mockResolvedValue({ version: 'd1', breaks: [] })
  fixture.createException.mockReset().mockResolvedValue({ success: true, data: { id: 'ex1', dateFrom: '2026-10-12', dateTo: '2026-10-12', kind: 'closed', intervals: [] } })
  fixture.putDates.mockReset()
  fixture.putBreaks.mockReset()
  fixture.putBreaks.mockImplementation(async (_a: unknown, _s: unknown, _v: unknown, rows: Array<{ weekday: number; start_time: string; end_time: string }>) => ({
    version: 'v2',
    breaks: rows.map((row, i) => ({ id: `n-${i}`, ...row })),
  }))
})

afterEach(() => {
  cleanup()
  memStorage.clear()
})


test.each(['rules', 'weekly', 'dated'] as const)('%sの保存中に店を切り替えても次の店で保存でき、旧応答で新しい保存を解放しない', async kind => {
 const dated = [{ id: 'dated', work_date: '2026-10-12', start_time: '13:00', end_time: '14:00' }]
 fixture.getDates.mockResolvedValue({ version: 'd1', breaks: dated })
 const write = kind === 'rules' ? fixture.putRules : kind === 'weekly' ? fixture.putBreaks : fixture.putDates
 let old!: (value: unknown) => void, fresh!: (value: unknown) => void
 write.mockImplementationOnce(() => new Promise(resolve => { old = resolve })).mockImplementationOnce(() => new Promise(resolve => { fresh = resolve }))
 const view = render(<StaffShiftsV8 staffId="bs-1" />)
 await screen.findByRole('button', { name: '休憩の曜日（月〜金）を選ぶ' })
 const panel = () => document.querySelector<HTMLElement>(`[data-design="${kind === 'rules' ? 'Week' : kind === 'weekly' ? 'Breaks' : 'Special'}"]`)!
 const prepare = async () => {
  if (kind === 'dated' && !within(panel()).queryByRole('button', { name: '更新する' })) fireEvent.click(within(panel()).getByRole('button', { name: '休憩 13:00〜14:00' }))
 }
 const action = () => panel().querySelector<HTMLButtonElement>('button[aria-busy="true"]') ?? within(panel()).getByRole<HTMLButtonElement>('button', { name: kind === 'dated' ? '更新する' : '保存する' })
 await prepare(); fireEvent.click(action())
 await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
 expect(action().hasAttribute('disabled')).toBe(true)
 fixture.account = 'account-b'; view.rerender(<StaffShiftsV8 staffId="bs-1" />)
 await waitFor(() => expect(fixture.getBreaks).toHaveBeenLastCalledWith('account-b', 'bs-1'))
 await screen.findByRole('button', { name: '休憩の曜日（月〜金）を選ぶ' })
 await prepare()
 expect(action().hasAttribute('disabled')).toBe(false)
 fireEvent.click(action()); await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
 const saved = { version: 'v2', breaks: kind === 'dated' ? dated : [], ok: true }
 await act(async () => { old(saved) })
 expect(action().hasAttribute('disabled')).toBe(true)
 expect(write.mock.calls.map(call => call[0])).toEqual(['account-a', 'account-b'])
 await act(async () => { fresh(saved) })
 if (kind !== 'dated') await waitFor(() => expect(action().hasAttribute('disabled')).toBe(false))
 else await waitFor(() => expect(within(panel()).queryByRole('button', { name: '更新する' })).toBeNull())
})
