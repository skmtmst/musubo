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
  query: '',
  role: 'owner' as string,
  accountId: 'account-a',
  replace: vi.fn(),
  push: vi.fn(),
  myStaff: [] as Array<Record<string, unknown>>,
  putBreaks: vi.fn(), putRules: vi.fn(), putDates: vi.fn(),
  rules: [{ weekday: 1, start_time: '10:00', end_time: '19:00' }] as Array<{ weekday: number; start_time: string; end_time: string }>,
  getRules: vi.fn(), getBreaks: vi.fn(), listMenus: vi.fn(), getAvailability: vi.fn(), getDates: vi.fn(), createException: vi.fn(),
  getCalendar: vi.fn(), deleteCalendar: vi.fn(),
}))

const disconnectSnapshots = vi.hoisted(() => [] as Array<{ open: boolean; confirm: () => unknown }>)
vi.mock('@/components/shared/confirm-dialog', async original => {
  const actual = await original<typeof import('@/components/shared/confirm-dialog')>()
  return { ...actual, default: (props: React.ComponentProps<typeof actual.default>) => {
    if (fixture.accountId === 'account-b' && props.title === '外の予定とのつながりを切りますか？' && props.onConfirm) {
      disconnectSnapshots.push({ open: Boolean(props.open), confirm: props.onConfirm })
    }
    return <actual.default {...props} />
  } }
})

const stableRouter = { replace: (...args: unknown[]) => fixture.replace(...args), push: (...args: unknown[]) => fixture.push(...args) }
vi.mock('next/navigation', () => ({ useRouter: () => stableRouter, useSearchParams: () => new URLSearchParams(fixture.query) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined, usePageCrumbs: () => undefined }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fixture.accountId, selectedAccount: null }) }))

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
      getGoogleCalendar: (...args: unknown[]) => fixture.getCalendar(...args),
      deleteGoogleCalendar: (...args: unknown[]) => fixture.deleteCalendar(...args),
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
  disconnectSnapshots.length = 0
  fixture.accountId = 'account-a'
  fixture.getCalendar.mockReset().mockResolvedValue({ connection: null, service_account: { configured: true } })
  fixture.deleteCalendar.mockReset().mockResolvedValue({})
  fixture.query = ''
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

describe('休憩の曜日のまとまり', () => {
  test('続いた3日以上は「〜」、それ以外は「・」でつなぐ', () => {
    expect(weekdaySetLabel([1, 2, 3, 4, 5])).toBe('月〜金')
    expect(weekdaySetLabel([6, 0])).toBe('土・日')
    expect(weekdaySetLabel([1, 3])).toBe('月・水')
    expect(weekdaySetLabel([0, 1, 2, 3, 4, 5, 6])).toBe('毎日')
    expect(weekdaySetLabel([2])).toBe('火')
  })

  test('同じ時刻の曜日は1行に、違う時刻は別の行になる', () => {
    const groups = groupBreaks([
      { id: 'a', weekday: 1, start_time: '13:00', end_time: '14:00' },
      { id: 'b', weekday: 2, start_time: '13:00', end_time: '14:00' },
      { id: 'c', weekday: 2, start_time: '16:00', end_time: '16:30' },
    ])
    expect(groups.map((g) => [g.weekdays, g.start])).toEqual([[[1, 2], '13:00'], [[2], '16:00']])
    expect(groups[0].ids).toEqual({ 1: 'a', 2: 'b' })
  })

  test('日付は「10/12（月）」の形', () => {
    expect(shortDay('2026-10-12')).toBe('10/12（月）')
  })
})

describe('役割はサーバーで決める', () => {
  test('実入口の担当者を読み、作る型の本文へ勤務の入力を描く', async () => {
    fixture.query = 'staff_id=bs-1'
    render(<StaffShiftsPage />)
    const weekday = await screen.findByRole('button', { name: '休憩の曜日（月〜金）を選ぶ' })
    expect(weekday.closest('[data-template-region="content"]')?.closest('[data-page-template="create"]')).toBeTruthy()
    expect(fixture.getBreaks).toHaveBeenCalledWith('account-a', 'bs-1')
  })

  test('手元が owner でもサーバーが staff なら、ひも付けなしの案内を出す（受付枠へ送らない）', async () => {
    fixture.role = 'staff'
    render(<StaffShiftsV8 staffId="" />)
    expect(await screen.findByText('ひも付いた予約スタッフがありません')).toBeTruthy()
    expect(screen.getByRole('link', { name: '予約の一覧へ戻る' })).toBeTruthy()
    expect(fixture.replace).not.toHaveBeenCalled()
  })

  test('本人の予約スタッフがあれば自分の勤務へ移る', async () => {
    fixture.role = 'staff'
    fixture.myStaff = [STAFF]
    render(<StaffShiftsV8 staffId="" />)
    await waitFor(() => { expect(fixture.replace).toHaveBeenCalledWith('/booking/staff/shifts?staff_id=bs-1') })
  })

  test('管理者が staff_id なしで来たら受付枠へ送る', async () => {
    render(<StaffShiftsV8 staffId="" />)
    await waitFor(() => { expect(fixture.replace).toHaveBeenCalledWith('/booking/menus?tab=hours') })
  })

  test('本人の画面は題が「自分の勤務」で、戻るリンクを出さない', async () => {
    fixture.role = 'staff'
    fixture.myStaff = [STAFF]
    render(<StaffShiftsV8 staffId="bs-1" />)
    expect(await screen.findByText('見本 110（トリマー）としてひも付いています。ひも付けを変えるときはオーナーか管理者に頼んでください。')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '自分の勤務' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: '← 担当スタッフへ' })).toBeNull()
  })
})

describe('勤務とシフト（管理者）', () => {
  test('アカウント切替直後の古いカレンダー解除確認は開かず解除もしない', async () => {
    fixture.getCalendar.mockResolvedValue({ connection: { calendar_id: 'fixture-calendar', last_verified_at: null, last_error: null }, service_account: { configured: true } })
    const view = render(<StaffShiftsV8 staffId="bs-1" />)
    fireEvent.click(await screen.findByRole('button', { name: '外す' }))
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    fixture.accountId = 'account-b'
    view.rerender(<StaffShiftsV8 staffId="bs-1" />)
    const first = disconnectSnapshots[0]
    expect(first).toBeTruthy()
    expect(first.open).toBe(false)
    await act(async () => { await first.confirm() })
    expect(fixture.deleteCalendar).not.toHaveBeenCalled()
  })
  test('外の予定を切る確認に対象と環境を出し、アカウント切替で閉じる', async () => {
    fixture.getCalendar.mockResolvedValue({ connection: { calendar_id: 'fixture-calendar', last_verified_at: null, last_error: null }, service_account: { configured: true } })
    const view = render(<StaffShiftsV8 staffId="bs-1" />)
    fireEvent.click(await screen.findByRole('button', { name: '外す' }))
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
    expect(within(dialog).getByText('環境')).toBeTruthy()
    expect(within(dialog).getByText('見本 110')).toBeTruthy()
    fixture.accountId = 'account-b'
    view.rerender(<StaffShiftsV8 staffId="bs-1" />)
    await screen.findByRole('button', { name: '外す' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(fixture.deleteCalendar).not.toHaveBeenCalled()
  })
  test('この日だけの休憩削除は対象と環境を示し、アカウント変更で閉じる', async () => {
    fixture.getDates.mockResolvedValue({ version: 'd1', breaks: [{ id: 'br1', work_date: '2099-10-12', start_time: '12:00', end_time: '13:00' }] })
    const view = render(<StaffShiftsV8 staffId="bs-1" />)
    fireEvent.click(await screen.findByRole('button', { name: /10\/12.*の休憩を削除/ }))
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
    expect(within(dialog).getByText('環境')).toBeTruthy()
    fixture.accountId = 'account-b'
    view.rerender(<StaffShiftsV8 staffId="bs-1" />)
    await screen.findByRole('button', { name: /10\/12.*の休憩を削除/ })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(fixture.putDates).not.toHaveBeenCalled()
  })
  test('勤務の削除確認を開いた後のアカウント切替では古い確定口を閉じる', async () => {
    fixture.getDates.mockResolvedValue({ version: 'd1', breaks: [{ id: 'br1', work_date: '2099-10-12', start_time: '12:00', end_time: '13:00' }] })
    const view = render(<StaffShiftsV8 staffId="bs-1" />)
    fireEvent.click(await screen.findByRole('button', { name: /10\/12.*の休憩を削除/ }))
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    fixture.accountId = 'account-b'
    view.rerender(<StaffShiftsV8 staffId="bs-1" />)
    await screen.findByRole('button', { name: /10\/12.*の休憩を削除/ })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(fixture.putDates).not.toHaveBeenCalled()
  })
  test('休憩は月〜金の1行で出し、保存のときは曜日ごとに広げて今のIDを付けて送る', async () => {
    render(<StaffShiftsV8 staffId="bs-1" />)
    expect(await screen.findByRole('button', { name: '休憩の曜日（月〜金）を選ぶ' })).toBeTruthy()
    const saveButtons = screen.getAllByRole('button', { name: '保存する' })
    fireEvent.click(saveButtons[1])
    await waitFor(() => { expect(fixture.putBreaks).toHaveBeenCalled() })
    const rows = fixture.putBreaks.mock.calls[0][3] as Array<{ id?: string; weekday: number }>
    expect(rows.map((r) => [r.weekday, r.id])).toEqual([[1, 'bb-1'], [2, 'bb-2'], [3, 'bb-3'], [4, 'bb-4'], [5, 'bb-5']])
  })

  test('曜日を外すと、その曜日は送らない', async () => {
    render(<StaffShiftsV8 staffId="bs-1" />)
    fireEvent.click(await screen.findByRole('button', { name: '休憩の曜日（月〜金）を選ぶ' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '水' }))
    expect(screen.getByRole('button', { name: '休憩の曜日（月・火・木・金）を選ぶ' })).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: '保存する' })[1])
    await waitFor(() => { expect(fixture.putBreaks).toHaveBeenCalled() })
    const rows = fixture.putBreaks.mock.calls[0][3] as Array<{ weekday: number }>
    expect(rows.map((r) => r.weekday)).toEqual([1, 2, 4, 5])
  })

  test('曜日の時間が逆さまのまま保存すると、送らずその曜日の時刻の欄を赤くし、終わりの欄へ移る', async () => {
    fixture.rules = [{ weekday: 1, start_time: '19:00', end_time: '10:00' }]
    render(<StaffShiftsV8 staffId="bs-1" />)
    await screen.findByRole('button', { name: '休憩の曜日（月〜金）を選ぶ' })
    fireEvent.click(screen.getAllByRole('button', { name: '保存する' })[0])
    await act(async () => { await new Promise((r) => requestAnimationFrame(r)) })
    expect(fixture.putRules).not.toHaveBeenCalled()
    const end = document.querySelector('[aria-label="月曜日の終わり"]') as HTMLElement
    expect(end.getAttribute('aria-invalid')).toBe('true')
    expect(document.querySelector('[aria-label="月曜日の始まり"]')?.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(end)
  })

  test('変える権限が無い人には、保存・足す・ごみ箱のボタンを置かない', async () => {
    memStorage.setItem('lh_staff_role', 'staff')
    memStorage.setItem('lh_staff_permissions', '[]')
    fixture.role = 'staff'
    fixture.myStaff = [STAFF]
    render(<StaffShiftsV8 staffId="bs-1" />)
    expect(await screen.findByText(/閲覧のみです/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '保存する' })).toBeNull()
    expect(screen.queryByRole('button', { name: /休憩を足す/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /この日を足す/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /の休憩を削除/ })).toBeNull()
  })
})

 test('WEB187：この日だけの休憩の保存失敗では追加欄と日付を残し、再試行できる', async () => {
   fixture.putDates.mockRejectedValueOnce(new Error('network')).mockResolvedValue({ breaks: [], version: 'd2' })
   render(<StaffShiftsV8 staffId="bs-1" />)
   fireEvent.click(await screen.findByRole('button', { name: 'この日を足す' }))
   fireEvent.click(screen.getByRole('button', { name: '足す種別' }))
   fireEvent.click(within(await screen.findByRole('option', { name: 'この日だけの休憩' })).getByRole('button'))
   fireEvent.change(screen.getByLabelText('この日の日付'), { target: { value: '2026-10-12' } })
   for (const [label, value] of [['この日の始まり', '12:00'], ['この日の終わり', '13:00']]) {
     const input = screen.getByRole('combobox', { name: label }); fireEvent.change(input, { target: { value } }); fireEvent.blur(input)
   }
   await act(async () => { fireEvent.click(screen.getByRole('button', { name: '足す', exact: true })) })
   await waitFor(() => expect(fixture.putDates).toHaveBeenCalledTimes(1))
   expect((screen.getByLabelText('この日の日付') as HTMLInputElement).value).toBe('2026-10-12')
   await act(async () => { fireEvent.click(screen.getByRole('button', { name: '足す', exact: true })) })
   await waitFor(() => expect(fixture.putDates).toHaveBeenCalledTimes(2))
 })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

test.each(['すぐ返る', '入力後に返る'] as const)(
  'WEB188：勤務時間の再取得が%s場合も、再取得完了後に未保存の休憩を保つ',
  async (timing) => {
    const refreshedRules = { rules: [{ weekday: 1, start_time: '11:00', end_time: '19:00' }] }
    const rulesReload = deferred<typeof refreshedRules>()
    const previewReload = deferred<{ by_staff: []; closed_dates: [] }>()
    fixture.listMenus.mockResolvedValue({ menus: [{ id: 'menu-1', name: 'カット', is_active: 1 }] })

    render(<StaffShiftsV8 staffId="bs-1" />)
    const start = await screen.findByRole('combobox', { name: '休憩の始まり' })
    await waitFor(() => expect(fixture.getAvailability).toHaveBeenCalledTimes(1))
    expect((start as HTMLInputElement).value).toBe('13 : 00')
    const week = () => within(screen.getByRole('heading', { name: 'いつもの勤務時間' }).closest('section')!)
    const breaks = () => within(screen.getByRole('heading', { name: '休憩', exact: true }).closest('section')!)
    const input = (name: string) => screen.getByRole('combobox', { name }) as HTMLInputElement
    const setTime = (name: string, value: string) => {
      fireEvent.change(input(name), { target: { value } })
      fireEvent.blur(input(name))
      // 見える文字だけでなく、画面側へ確定した値も確認する。
      expect(input(name).title).toBe(value)
    }
    setTime('月曜日の始まり', '11:00')
    setTime('休憩の始まり', '12:00')
    setTime('休憩の終わり', '12:45')
    fireEvent.click(screen.getByRole('button', { name: '休憩の曜日（月〜金）を選ぶ' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '水' }))

    fixture.getRules.mockImplementationOnce(() => timing === 'すぐ返る'
      ? Promise.resolve(refreshedRules)
      : rulesReload.promise)
    fixture.getAvailability.mockReturnValueOnce(previewReload.promise)
    await act(async () => { fireEvent.click(week().getByRole('button', { name: '保存する' })) })
    await waitFor(() => expect(fixture.getRules).toHaveBeenCalledTimes(2))
    expect(fixture.putRules).toHaveBeenCalledExactlyOnceWith('account-a', 'bs-1', refreshedRules.rules)

    if (timing === '入力後に返る') {
      expect(fixture.getAvailability).toHaveBeenCalledTimes(1)
      expect(week().getByRole('button', { name: '保存しています…' }).hasAttribute('disabled')).toBe(true)
      // 再取得が止まっている間も、休憩は編集できる。
      setTime('休憩の終わり', '12:30')
      await act(async () => { rulesReload.resolve(refreshedRules) })
    }
    await waitFor(() => expect(fixture.getAvailability).toHaveBeenCalledTimes(2))
    expect(week().getByRole('button', { name: '保存しています…' }).hasAttribute('disabled')).toBe(true)

    // 保存通知やPUTの呼び出しでは終わりにしない。予約枠の再取得も返して、
    // 保存ボタンが戻った後に、取り直したDOMと実際の保存内容の両方を見る。
    await act(async () => { previewReload.resolve({ by_staff: [], closed_dates: [] }) })
    await waitFor(() => expect(week().getByRole('button', { name: '保存する' }).hasAttribute('disabled')).toBe(false))
    expect(input('休憩の始まり').value).toBe('12 : 00')
    const end = timing === '入力後に返る' ? '12:30' : '12:45'
    expect(input('休憩の終わり').value).toBe(end.replace(':', ' : '))
    expect(screen.getByRole('button', { name: '休憩の曜日（月・火・木・金）を選ぶ' })).toBeTruthy()
    expect(fixture.getBreaks).toHaveBeenCalledTimes(1)
    expect(fixture.putBreaks).not.toHaveBeenCalled()

    await act(async () => { fireEvent.click(breaks().getByRole('button', { name: '保存する' })) })
    expect(fixture.putBreaks).toHaveBeenCalledExactlyOnceWith('account-a', 'bs-1', 'v1',
      [1, 2, 4, 5].map((weekday) => ({ id: `bb-${weekday}`, weekday, start_time: '12:00', end_time: end })))
  },
)

test('BUG-03：空きの取得失敗を満席と区別し、見本の再試行で回復する', async () => {
  fixture.listMenus.mockResolvedValue({ menus: [{ id: 'm1', name: '相談', is_active: 1 }] })
  fixture.getAvailability.mockRejectedValueOnce(new Error('network failed'))
  render(<StaffShiftsV8 staffId="bs-1" />)
  const failed = await screen.findByText('読み込めませんでした')
  const preview = screen.getByRole('group', { name: 'お客さまの予約画面の見本' })
  expect(preview.contains(failed)).toBe(true)
  expect(within(preview).queryAllByText('満')).toHaveLength(0)
  const marks = screen.getByLabelText('佐々木の予約枠（14日分）')
  expect(marks.textContent).not.toContain('×')
  fixture.getAvailability.mockResolvedValueOnce({ by_staff: [{ staff_id: 'bs-1', slots: [{ date: '2099-10-15', start: '09:00', end: '10:00', remaining: 1 }] }], closed_dates: [] })
  fireEvent.click(within(preview).getByRole('button', { name: 'もう一度読み込む' }))
  await waitFor(() => expect(screen.queryByText('読み込めませんでした')).toBeNull())
  await waitFor(() => expect(within(preview).getByText('空き')).toBeTruthy())
  expect(fixture.getAvailability).toHaveBeenCalledTimes(2)
})

function setTime(label: string, value: string) {
  const input=screen.getByRole('combobox',{name:label});fireEvent.change(input,{target:{value}});fireEvent.blur(input)
}
async function addSpecialDay(kind: '休憩'|'休み') {
  fireEvent.click(await screen.findByRole('button',{name:'この日を足す'}))
  fireEvent.click(screen.getByRole('button',{name:'足す種別'}))
  fireEvent.click(within(await screen.findByRole('option',{name:`この日だけの${kind}`})).getByRole('button'))
  fireEvent.change(screen.getByLabelText('この日の日付'),{target:{value:'2026-10-12'}})
  if(kind==='休憩'){setTime('この日の始まり','12:00');setTime('この日の終わり','13:00')}
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'足す',exact:true}))})
}
test.each(['毎週の休憩','この日だけの休憩','休み'] as const)('SL-C01: %sの保存後は空き見本を再取得する',async kind=>{
  fixture.listMenus.mockResolvedValue({menus:[{id:'m1',name:'人工メニュー',is_active:1}]})
  fixture.putDates.mockResolvedValue({version:'d2',breaks:[{id:'br1',work_date:'2026-10-12',start_time:'12:00',end_time:'13:00'}]})
  render(<StaffShiftsV8 staffId="bs-1"/>)
  await screen.findByRole('combobox',{name:'休憩の始まり'})
  await waitFor(()=>expect(fixture.getAvailability).toHaveBeenCalledTimes(1))
  if(kind==='毎週の休憩') await act(async()=>{fireEvent.click(screen.getAllByRole('button',{name:'保存する'})[1])})
  else await addSpecialDay(kind==='休み'?'休み':'休憩')
  await waitFor(()=>expect(fixture.getAvailability).toHaveBeenCalledTimes(2))
})
test('SL-C03: 毎週の休憩が409でも入力を残し、本人が最新を読むまで置き換えない',async()=>{
  fixture.putBreaks.mockRejectedValueOnce(Object.assign(new ApiError(409),{data:{version:'v9',breaks:[{id:'other',weekday:1,start_time:'15:00',end_time:'16:00'}]}}))
  render(<StaffShiftsV8 staffId="bs-1"/>)
  await screen.findByRole('combobox',{name:'休憩の始まり'})
  setTime('休憩の始まり','12:00')
  await waitFor(()=>expect((screen.getByRole('combobox',{name:'休憩の始まり'}) as HTMLInputElement).title).toBe('12:00'))
  await act(async()=>{fireEvent.click(screen.getAllByRole('button',{name:'保存する'})[1])})
  expect((screen.getByRole('combobox',{name:'休憩の始まり'}) as HTMLInputElement).title).toBe('12:00')
  expect(fixture.getBreaks).toHaveBeenCalledTimes(1)
  fixture.getBreaks.mockResolvedValue({version:'v10',breaks:[{id:'latest',weekday:1,start_time:'16:00',end_time:'17:00'}]})
  fireEvent.click(screen.getByRole('button',{name:'最新を読み込んで続ける'}))
  await waitFor(()=>expect((screen.getByRole('combobox',{name:'休憩の始まり'}) as HTMLInputElement).title).toBe('16:00'))
  await act(async()=>{fireEvent.click(screen.getAllByRole('button',{name:'保存する'})[1])})
  expect(fixture.putBreaks.mock.calls[1][2]).toBe('v10')
})
test('SL-C03: 日付付き休憩も409では編集を残し、選んだ読み直しの失敗でも残す',async()=>{
  const original={id:'b1',work_date:'2026-10-12',start_time:'13:00',end_time:'14:00'}
  fixture.getDates.mockResolvedValue({version:'d1',breaks:[original]})
  fixture.putDates.mockRejectedValue(Object.assign(new ApiError(409),{data:{version:'d9',breaks:[{...original,start_time:'15:00',end_time:'16:00'}]}}))
  render(<StaffShiftsV8 staffId="bs-1"/>)
  fireEvent.click(await screen.findByRole('button',{name:'休憩 13:00〜14:00'}))
  setTime('10/12（月）の休憩の始まり','12:00')
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'更新する'}))})
  expect((screen.getByRole('combobox',{name:'10/12（月）の休憩の始まり'}) as HTMLInputElement).title).toBe('12:00')
  fixture.getDates.mockRejectedValueOnce(new Error('network'))
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'最新を読み込んで続ける'}))})
  expect((screen.getByRole('combobox',{name:'10/12（月）の休憩の始まり'}) as HTMLInputElement).title).toBe('12:00')
  fixture.getDates.mockResolvedValue({version:'d10',breaks:[{...original,start_time:'16:00',end_time:'17:00'}]})
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'最新を読み込んで続ける'}))})
  expect(screen.getByRole('button',{name:'休憩 16:00〜17:00'})).toBeTruthy()
})

test('畳んだ予約画面を中身の名前で開き、閉じても勤務の値を保つ', async () => {
  render(<StaffShiftsV8 staffId="bs-1" />)
  const launcher = await screen.findByRole('button', { name: 'お客さまの予約画面を見る' })
  const times = screen.getAllByRole('combobox').map(node => (node as HTMLInputElement).value)
  fireEvent.click(launcher)
  const dialog = await screen.findByRole('dialog', { name: 'お客さまの予約画面' })
  expect(within(dialog).getByText(/予約画面のURLがまだありません/)).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }))
  expect(screen.getAllByRole('combobox').map(node => (node as HTMLInputElement).value)).toEqual(times)
})

test('勤務の5段は共通の見出しを使い、保存の操作と入力の役目を保つ', async () => {
  render(<StaffShiftsV8 staffId="bs-1" />)
  await screen.findByRole('button', { name: 'この日を足す' })
  for (const name of ['いつもの勤務時間', '休憩', 'この日だけ（休み・シフト・休憩）', '何週分かのシフトを作る', 'Google カレンダー']) {
    const heading = screen.getByRole('heading', { name, exact: true })
    expect(heading.closest('[data-design-node="t0jk8p"]')).toBeTruthy()
    expect(heading.closest('section')?.getAttribute('aria-labelledby')).toBe(heading.id)
  }
  expect(screen.getAllByRole('button', { name: '保存する', exact: true })).toHaveLength(2)
  expect(screen.getByRole('button', { name: '月〜金 13:00〜14:00 の休憩を削除' }).getAttribute('data-design-node')).toBe('H0V8EK')
  expect(within(document.querySelector('[aria-labelledby="bks-gen"]') as HTMLElement).getAllByText('必須')).toHaveLength(2)
  const weeks = screen.getByRole('spinbutton', { name: 'まとめて作る週の数' })
  expect(weeks.closest('[data-form-row="columns"]')?.getAttribute('data-form-columns')).toBe('2')
  expect(weeks.getAttribute('min')).toBe('1')
  expect(weeks.getAttribute('max')).toBe('12')
  fireEvent.change(weeks, { target: { value: '7' } })
  expect((weeks as HTMLInputElement).value).toBe('7')
  const calendar = screen.getByRole('textbox', { name: 'カレンダーのID' })
  expect(calendar.getAttribute('data-design-node')).toBe('Ume2U')
  fireEvent.change(calendar, { target: { value: 'calendar@example.invalid' } })
  expect((calendar as HTMLInputElement).value).toBe('calendar@example.invalid')
})


test('休みを追加する入力列は開いた状態も間隔の見張りの対象', async () => {
  render(<StaffShiftsV8 staffId="bs-1" />)
  fireEvent.click(await screen.findByRole('button', { name: 'この日を足す' }))
  fireEvent.click(screen.getByRole('button', { name: '足す種別' }))
  fireEvent.click(within(await screen.findByRole('option', { name: 'この日だけの休み' })).getByRole('button'))
  const memo = screen.getByRole('textbox', { name: '休みの理由' })
  expect(memo.closest('[data-shift-day-entry="closed"]')).not.toBeNull()
})
