// @vitest-environment happy-dom
/*
 * R318 / R319 / R322 / R320 / R321: 予約詳細の競合・再試行・移動・申し送り・履歴。
 *
 * 監査の隔離再現（detail-react-isolated.cjs）が示した事故を、
 * 実物の React で描いて直っていることを確かめる。
 *
 *   - R318: メモだけ変えた保存が競合した後、再試行で触っていない料金を
 *     古い値で送らない。警告は読み直し後も残す。
 *   - R319: 再試行の失敗理由は読み直しで消さない。
 *   - R322: 別の予約へ移った後に前の予約の保存が終わっても、今の表示を消さない。
 *   - R320: 前回申し送りに元予約への入口を出す。
 *   - R321: 10件で打ち切るときは総数を区別し、全件への入口を出す。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => {
  class ApiErrorMock extends Error {
    status: number
    code: string | undefined
    constructor(status = 500, message?: string, code?: string) {
      super(message ?? `API error: ${status}`)
      this.name = 'ApiError'
      this.status = status
      this.code = code
    }
  }
  return {
    ApiErrorMock,
    account: 'A',
    id: 'A',
    get: vi.fn(),
    update: vi.fn(),
    retryCalendar: vi.fn(),
    retryNotification: vi.fn(),
  }
})

const ApiErrorMock = m.ApiErrorMock

vi.mock('@/components/shell/page-chrome', () => ({ usePageCrumbs: () => undefined,  usePageTitle: vi.fn() }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: m.account }),
}))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useSearchParams: () => new URLSearchParams({ id: m.id }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))
vi.mock('@/lib/api', async () => ({
  ApiError: m.ApiErrorMock,
  api: { staff: { me: async () => ({ success: true, data: { role: 'owner' } }) } },
  bookingApi: {
    ...(await import('@/test-utils/booking-visit-api-mock')).bookingVisitApiMock(),
    getBooking: m.get,
    decideRequest: vi.fn(async () => ({ status: 'confirmed' })),
    listMenus: vi.fn(async () => ({ menus: [] })),
    listMenuStaff: vi.fn(async () => ({ staff: [] })),
    getAvailability: vi.fn(async () => ({ by_staff: [] })),
    updateBooking: m.update,
    retryCalendarSync: m.retryCalendar,
    retryNotification: m.retryNotification,
    getAuditLogs: vi.fn(async () => ({ audit_logs: [] })),
  },
}))

import Page from './page'

const booking = (name: string, overrides: Record<string, unknown> = {}) => ({
  id: name,
  menuId: `menu-${name}`,
  menuName: `${name}メニュー`,
  staffId: 'staff',
  staffName: '担当',
  status: 'confirmed',
  price: 1000,
  internalNote: '元のメモ',
  customerNote: null,
  startsAt: '2026-09-20T01:00:00Z',
  endsAt: '2026-09-20T02:00:00Z',
  requestedAt: '2026-09-19T01:00:00Z',
  source: 'liff',
  customer: {
    displayName: `${name}顧客`,
    isLineLinked: true,
    friendId: `friend-${name}`,
    phone: null,
    bookingCustomerId: null,
    petName: null,
    tags: [],
    mileageBalance: null,
  },
  previousHandover: null,
  previousHandoverBooking: null,
  notificationPolicy: { send_line_confirmation: true, day_before: true, hours_before: true },
  history: [],
  historyTotal: 0,
  operations: [],
  reminders: [],
  auditLogs: [],
  auditLogTotal: 0,
  lockVersion: 1,
  ...overrides,
})

const flush = () => act(async () => { await Promise.resolve() })

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  m.account = 'A'
  m.id = 'A'
})

describe('R318: 競合後の再試行は触った欄だけ送る', () => {
  it('メモのみ編集→他担当が料金変更→競合→再試行でも新料金を維持する', async () => {
    // 監査の再現手順そのまま。料金1000円・版1の予約を開き、店内メモだけ変える。
    // 保存する直前に別担当が料金2000円・版2へ更新した状態にする。
    const server = { price: 1000, lockVersion: 1, internalNote: '元のメモ' }
    m.get.mockImplementation(async () => ({
      booking: booking('A', {
        price: server.price,
        lockVersion: server.lockVersion,
        internalNote: server.internalNote,
      }),
    }))
    const sentPatches: Array<Record<string, unknown>> = []
    m.update.mockImplementation(async (_account: string, _reqId: string, patch: Record<string, unknown>) => {
      sentPatches.push({ ...patch })
      if (patch.lock_version !== server.lockVersion) {
        throw new ApiErrorMock(409, 'version conflict', 'version_conflict')
      }
      if (typeof patch.price === 'number') server.price = patch.price
      if (typeof patch.internal_note === 'string') server.internalNote = patch.internal_note
      server.lockVersion += 1
      return { change_notification: 'not_applicable', reminders_created: 0 }
    })

    render(<Page />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '内容を変更する' }))
    await flush()
    expect((screen.getByLabelText('料金（円・税込）') as HTMLInputElement).value).toBe('1000')

    fireEvent.change(screen.getByLabelText('店内メモ（お客様には見えません）'), {
      target: { value: '自分のメモ' },
    })
    // 保存の直前に別担当が料金2000円・版2へ更新したことにする。
    server.price = 2000
    server.lockVersion = 2
    fireEvent.click(screen.getByRole('button', { name: 'この内容にする' }))
    await flush()

    // 1回目はメモしか送っていない（差分保存）。
    expect(sentPatches).toHaveLength(1)
    expect(sentPatches[0]).toMatchObject({ lock_version: 1, internal_note: '自分のメモ' })
    expect(sentPatches[0]).not.toHaveProperty('price')

    // 警告は読み直し後も残り、相手が変えた欄（料金）を名指しする。
    expect(screen.getByText(/ほかの人が先に料金を変更しました/)).toBeTruthy()
    // 詳細の料金は2000円。編集欄も触っていない料金は2000円に戻り、変えたメモは残る。
    expect(screen.getByText('¥2,000（税込）')).toBeTruthy()
    expect((screen.getByLabelText('料金（円・税込）') as HTMLInputElement).value).toBe('2000')
    expect((screen.getByLabelText('店内メモ（お客様には見えません）') as HTMLTextAreaElement).value)
      .toBe('自分のメモ')

    // 再試行。新しい版でメモだけ送る。
    fireEvent.click(screen.getByRole('button', { name: 'この内容にする' }))
    await flush()
    expect(sentPatches).toHaveLength(2)
    expect(sentPatches[1]).toMatchObject({ lock_version: 2, internal_note: '自分のメモ' })
    expect(sentPatches[1]).not.toHaveProperty('price')
    // 新料金2000円は維持される。
    expect(server.price).toBe(2000)
  })
})

describe('R319: 再試行の失敗理由は読み直しで消さない', () => {
  it('通知の再送が失敗したら、読み直し後も理由が残る', async () => {
    m.get.mockResolvedValue({
      booking: booking('A', {
        operations: [{
          id: 'op-1',
          kind: 'confirmation_line',
          status: 'permanent_failed',
          scheduledAt: null,
          completedAt: null,
          openedAt: null,
          result: {},
          errorCode: 'fixture_previous_failure',
        }],
      }),
    })
    m.retryNotification.mockRejectedValue(new Error('relay down'))
    render(<Page />)
    await flush()

    fireEvent.click(screen.getByRole('button', { name: 'もう一度送る' }))
    await flush()
    await flush()

    // 読み直し（getBooking）が走っても、今回の失敗理由が残る。
    expect(m.get.mock.calls.length).toBeGreaterThan(1)
    expect(screen.getByText('お知らせを再送できませんでした。時間をおいて、もう一度お試しください。')).toBeTruthy()
  })

  it('カレンダー再試行の失敗理由も読み直しで消さない', async () => {
    m.get.mockResolvedValue({
      booking: booking('A', { calendarSync: 'failed', operations: [] }),
    })
    m.retryCalendar.mockRejectedValue(new ApiErrorMock(409, 'nothing to retry', 'no_retryable_operation'))
    render(<Page />)
    await flush()

    fireEvent.click(screen.getByRole('button', { name: 'もう一度反映する' }))
    await flush()
    await flush()

    expect(m.get.mock.calls.length).toBeGreaterThan(1)
    expect(screen.getByText('再試行できる失敗はありません')).toBeTruthy()
  })
})

describe('R322: 別の予約へ移動後は前の保存で今の表示を消さない', () => {
  it('Aの保存中にBへ移動し、Aの成功が遅れて返ってもBを残す', async () => {
    m.get.mockImplementation(async (_account: string, reqId: string) => ({
      booking: booking(reqId, { internalNote: `メモ-${reqId}` }),
    }))
    let resolveUpdate: ((v: unknown) => void) | undefined
    m.update.mockImplementationOnce(() => new Promise((r) => { resolveUpdate = r }))

    const v = render(<Page />)
    await flush()
    expect(screen.getByText('Aメニュー')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '内容を変更する' }))
    await flush()
    fireEvent.change(screen.getByLabelText('店内メモ（お客様には見えません）'), {
      target: { value: 'Aの新しいメモ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'この内容にする' }))
    await flush()

    // 保存の応答を待たずBへ移動する。
    m.id = 'B'
    await act(async () => { v.rerender(<Page />) })
    await flush()
    expect(screen.getByText('Bメニュー')).toBeTruthy()

    // 遅れてAの保存成功が返る。
    await act(async () => resolveUpdate?.({ change_notification: 'not_applicable', reminders_created: 0 }))
    await flush()

    // Bの表示は消えない。「見つかりません」にもならない。
    expect(screen.getByText('Bメニュー')).toBeTruthy()
    expect(screen.queryByText('この予約は見つかりません')).toBeNull()
    // Aの保存完了でAを読み直しに行かない。
    expect(m.get.mock.calls.filter((call) => call[1] === 'A')).toHaveLength(1)
  })
})

describe('R320/R321: 申し送りの入口と履歴の件数', () => {
  it('前回申し送りに日時と元予約への入口を出す', async () => {
    m.get.mockResolvedValue({
      booking: booking('A', {
        previousHandover: '足を触る前に声をかける',
        previousHandoverBooking: { id: 'old-1', startsAt: '2026-08-01T01:00:00.000Z', status: 'completed' },
      }),
    })
    render(<Page />)
    await flush()
    expect(screen.getByText('足を触る前に声をかける')).toBeTruthy()
    const link = screen.getByRole('link', { name: 'その時の予約を見る' })
    expect(link.getAttribute('href')).toContain('old-1')
  })

  it('12件中10件のときは総数を区別し、全件への入口を出す', async () => {
    const history = Array.from({ length: 10 }, (_v, i) => ({
      id: `past-${i}`,
      startsAt: `2026-08-${String(20 - i).padStart(2, '0')}T01:00:00.000Z`,
      status: 'completed',
      customerNote: null,
      handoverNote: null,
      price: 5000,
      menuName: '相談',
      staffName: '担当',
    }))
    m.get.mockResolvedValue({ booking: booking('A', { history, historyTotal: 12 }) })
    render(<Page />)
    await flush()
    expect(screen.getByText('最新10件を表示（全12件）')).toBeTruthy()
    expect(screen.getByRole('link', { name: '顧客カルテで以前の予約を見る' })).toBeTruthy()
  })

  it('打ち切りが無いときは件数だけ出す', async () => {
    const history = [{
      id: 'past-1',
      startsAt: '2026-08-01T01:00:00.000Z',
      status: 'completed',
      customerNote: null,
      handoverNote: null,
      price: 5000,
      menuName: '相談',
      staffName: '担当',
    }]
    m.get.mockResolvedValue({ booking: booking('A', { history, historyTotal: 1 }) })
    render(<Page />)
    await flush()
    expect(screen.getByText('1件')).toBeTruthy()
    expect(screen.queryByText(/最新.*件を表示/)).toBeNull()
  })
})

 describe('WEB298〜300：編集中の離脱・対象・保存入力', () => {
   it('WEB298：編集したメモがある間は離脱を防ぐ', async () => {
     m.get.mockResolvedValue({ booking: booking('A') })
     render(<Page />); await flush()
     fireEvent.click(screen.getByRole('button', { name: '内容を変更する' })); await flush()
     fireEvent.change(screen.getByLabelText('店内メモ（お客様には見えません）'), { target: { value: '未保存のメモ' } })
     const event = new Event('beforeunload', { cancelable: true })
     window.dispatchEvent(event)
     expect(event.defaultPrevented).toBe(true)
   })
   it('WEB299：予約Bへ移った後の予約Aの競合はAを再取得しない', async () => {
     let reject!: (reason: unknown) => void
     m.get.mockImplementation(async (_account: string, id: string) => ({ booking: booking(id) }))
     m.update.mockImplementationOnce(() => new Promise((_resolve, failure) => { reject = failure }))
     const view = render(<Page />); await flush()
     fireEvent.click(screen.getByRole('button', { name: '内容を変更する' })); await flush()
     fireEvent.change(screen.getByLabelText('店内メモ（お客様には見えません）'), { target: { value: '修正' } })
     fireEvent.click(screen.getByRole('button', { name: 'この内容にする' })); await flush()
     m.id = 'B'; view.rerender(<Page />); await flush()
     m.get.mockClear()
     await act(async () => { reject(new ApiErrorMock(409, 'conflict', 'version_conflict')) }); await flush()
     expect(m.get).not.toHaveBeenCalled()
     expect(screen.getByText('Bメニュー')).toBeTruthy()
   })
   it('WEB300：保存中は入力を止め、追加入力を消さない', async () => {
     m.get.mockResolvedValue({ booking: booking('A') })
     m.update.mockImplementationOnce(() => new Promise(() => {}))
     render(<Page />); await flush()
     fireEvent.click(screen.getByRole('button', { name: '内容を変更する' })); await flush()
     const note = screen.getByLabelText('店内メモ（お客様には見えません）') as HTMLTextAreaElement
     fireEvent.change(note, { target: { value: '保存するメモ' } })
     fireEvent.click(screen.getByRole('button', { name: 'この内容にする' })); await flush()
     expect(note.matches(':disabled')).toBe(true)
   })
 })
