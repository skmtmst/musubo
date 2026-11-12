// @vitest-environment happy-dom
/*
 * DEEP-18 / DEEP-19 / DEEP-20 (#995): 予約詳細の対象固定と通知表示。
 *
 * 監査の再現試験 (audit-deep-booking-detail.test.tsx) が示した事故を、
 * 実物の React で描いて直っていることを確かめる。
 *
 *   - 取得失敗・遅延のあとに前の予約を「今の予約」として出さない
 *     （アカウント×予約ID×要求世代で固定する）
 *   - 監査ログ0件の予約に、連携状態だけから「通知を送信しました」をでっち上げない
 *   - 確認窓の説明が操作と通知方針ごとの実処理と一致する
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ account: 'A', id: 'one', get: vi.fn(), update: vi.fn(), decide: vi.fn(), confirmation: undefined as undefined | (() => void), cancel: undefined as undefined | (() => void) }))

vi.mock('@/components/shared/confirm-dialog', async original => {
  const actual = await original<typeof import('@/components/shared/confirm-dialog')>()
  return { ...actual, default: (props: React.ComponentProps<typeof actual.default>) => {
    if (props.open && typeof props.title === 'string' && props.title.includes('この予約を')) { m.confirmation = props.onConfirm as () => void; m.cancel = props.onCancel }
    return <actual.default {...props} />
  } }
})
vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(), usePageTitle: vi.fn() }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: m.account }),
}))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useSearchParams: () => new URLSearchParams({ id: m.id }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))
vi.mock('@/lib/api', async () => ({
  ApiError: (await import('@/lib/api/transport/errors')).ApiError,
  api: { staff: { me: async () => ({ success: true, data: { role: 'owner' } }) } },
  bookingApi: {
    ...(await import('@/test-utils/booking-visit-api-mock')).bookingVisitApiMock(),
    getBooking: m.get,
    decideRequest: m.decide,
    listMenus: vi.fn(async () => ({ menus: [] })),
    listMenuStaff: vi.fn(async () => ({ staff: [] })),
    getAvailability: vi.fn(async () => ({ by_staff: [] })),
    updateBooking: m.update,
    retryCalendarSync: vi.fn(async () => ({ status: 'succeeded' })),
    retryNotification: vi.fn(async () => ({ status: 'succeeded' })),
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
  status: 'requested',
  price: 0,
  startsAt: '2026-09-20T01:00:00Z',
  endsAt: '2026-09-20T02:00:00Z',
  requestedAt: '2026-09-19T01:00:00Z',
  source: 'liff',
  customer: {
    displayName: `${name}顧客`,
    isLineLinked: true,
    friendId: null,
    phone: null,
    bookingCustomerId: null,
    petName: null,
    tags: [],
    mileageBalance: null,
  },
  previousHandover: null,
  notificationPolicy: { send_line_confirmation: false, day_before: false, hours_before: false },
  history: [],
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
  m.id = 'one'
  m.confirmation = undefined
  m.cancel = undefined
  m.decide.mockResolvedValue({ status: 'confirmed' })
})

function withinDialogButton(dialog: HTMLElement, label: string): HTMLButtonElement {
  const button = [...dialog.querySelectorAll('button')].find(item => item.textContent?.trim() === label)
  if (!button) throw new Error(`button ${label} not found`)
  return button
}

describe('DEEP-18: 詳細と操作対象の固定', () => {
  it('閉じた予約確認の確定を再度開いた窓に使えない', async () => {
    m.get.mockResolvedValue({ booking: booking('one') })
    render(<Page />)
    await screen.findByText('oneメニュー')
    fireEvent.click(screen.getByRole('button', { name: '承認する' }))
    await waitFor(() => expect(m.confirmation).toBeTypeOf('function'))
    const oldConfirm = m.confirmation!, oldCancel = m.cancel!
    const dialog = screen.getByRole('dialog')
    fireEvent.click(withinDialogButton(dialog, '戻る'))
    fireEvent.click(screen.getByRole('button', { name: '承認する' }))
    act(() => { oldCancel() })
    expect(screen.getByRole('dialog')).toBeTruthy()
    await act(async () => { oldConfirm(); await Promise.resolve() })
    expect(m.decide).not.toHaveBeenCalled()
    await act(async () => { m.confirmation!(); await Promise.resolve() })
    expect(m.decide).toHaveBeenCalledTimes(1)
  })

  it('別アカウントの取得に失敗したら、前の予約と承認ボタンを残さない', async () => {
    m.get
      .mockResolvedValueOnce({ booking: booking('A') })
      .mockRejectedValueOnce(new Error('404'))
    const v = render(<Page />)
    await flush()
    expect(screen.getByText('Aメニュー')).toBeTruthy()

    m.account = 'B'
    await act(async () => { v.rerender(<Page />) })
    await flush()

    // A の予約も、A を対象にした承認ボタンも残らない。
    expect(screen.queryByText('Aメニュー')).toBeNull()
    expect(screen.queryByRole('button', { name: /承認する/ })).toBeNull()
    // 取得の失敗は ★管理画面 TargetMissing の error で出す（生の応答文は出さない）。
    expect(screen.getByText(/予約を読み込めませんでした/)).toBeTruthy()
  })

  it('遅れて届いた古い詳細で、今見ている予約を上書きしない', async () => {
    let resolveA: ((v: unknown) => void) | undefined
    m.get
      .mockImplementationOnce(() => new Promise((r) => { resolveA = r }))
      .mockResolvedValueOnce({ booking: booking('B') })
    const v = render(<Page />)
    await flush()

    m.id = 'two'
    await act(async () => { v.rerender(<Page />) })
    await flush()
    expect(screen.getByText('Bメニュー')).toBeTruthy()

    await act(async () => resolveA?.({ booking: booking('A') }))
    expect(screen.getByText('Bメニュー')).toBeTruthy()
    expect(screen.queryByText('Aメニュー')).toBeNull()
  })

  it('対象が変わった直後は前の詳細を出さず、次の取得を待つ', async () => {
    m.get
      .mockResolvedValueOnce({ booking: booking('A') })
      .mockImplementationOnce(() => new Promise(() => {}))
    const v = render(<Page />)
    await flush()
    expect(screen.getByText('Aメニュー')).toBeTruthy()

    m.id = 'two'
    await act(async () => { v.rerender(<Page />) })

    // 取得が終わっていない間は A の内容も承認ボタンも出さない。
    expect(screen.queryByText('Aメニュー')).toBeNull()
    expect(screen.queryByRole('button', { name: /承認する/ })).toBeNull()
    expect(screen.getByText('読み込み中…')).toBeTruthy()
  })
})

describe('DEEP-19: 記録の無い予約に送信済みを書かない', () => {
  it('監査0件・通知OFFでも「送信しました」と表示せず、履歴なしと書く', async () => {
    m.get.mockResolvedValue({ booking: booking('A') })
    render(<Page />)
    await flush()
    expect(screen.queryByText('受付のお知らせを自動送信しました')).toBeNull()
    expect(screen.getByText('お客様が予約を申し込みました')).toBeTruthy()
    expect(screen.getByText('通知履歴はありません。')).toBeTruthy()
  })

  it('通知実行台帳に失敗があれば、推測ではなく失敗の事実を出す', async () => {
    m.get.mockResolvedValue({
      booking: booking('A', {
        operations: [{
          id: 'op-1',
          kind: 'confirmation_line',
          status: 'permanent_failed',
          scheduledAt: '2026-09-19T01:00:00Z',
          completedAt: '2026-09-19T01:00:05Z',
          openedAt: null,
          result: { notificationKind: 'requested' },
          errorCode: 'LineApiError',
        }],
      }),
    })
    render(<Page />)
    await flush()
    expect(screen.getByText('受付のお知らせの送信に失敗しました')).toBeTruthy()
    expect(screen.queryByText('通知履歴はありません。')).toBeNull()
  })

  it('スタッフ代理登録の予約は「お客様が申し込みました」と言い切らない', async () => {
    m.get.mockResolvedValue({ booking: booking('A', { source: 'operator' }) })
    render(<Page />)
    await flush()
    expect(screen.getByText('スタッフが予約を記録しました')).toBeTruthy()
    expect(screen.queryByText('お客様が予約を申し込みました')).toBeNull()
  })
})

describe('DEEP-20: 確認窓の説明を実処理に合わせる', () => {
  it('確定のお知らせOFFなら、承認してもLINEが届かないことを確認窓で伝える', async () => {
    m.get.mockResolvedValue({ booking: booking('A') })
    render(<Page />)
    await flush()
    expect(screen.getByText('この予約は確定のお知らせを送らない設定です。承認してもLINEには届きません。')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '承認する' }))
    await flush()
    // ボタン横の案内と確認窓の説明、両方に届かないことを書く。
    expect(screen.getAllByText(/承認してもLINEには届きません/).length).toBeGreaterThan(1)
    expect(screen.queryByText(/この結果がLINEで届きます/)).toBeNull()
  })

  it('確定のお知らせONなら、届くことを伝える', async () => {
    m.get.mockResolvedValue({
      booking: booking('A', {
        notificationPolicy: { send_line_confirmation: true, day_before: true, hours_before: true },
      }),
    })
    render(<Page />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '承認する' }))
    await flush()
    expect(screen.getByText(/確定のお知らせがお客様のLINEへ届きます/)).toBeTruthy()
  })

  it('キャンセルは自動連絡が無い操作として説明する', async () => {
    m.get.mockResolvedValue({ booking: booking('A', { status: 'confirmed' }) })
    render(<Page />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    await flush()
    const cancelWindow = screen.getByRole('alertdialog')
    expect(Array.from(cancelWindow.querySelectorAll('button')).map(button => button.textContent?.trim())).toEqual(expect.arrayContaining(['戻る', 'キャンセル']))
    expect(Array.from(cancelWindow.querySelectorAll('button')).filter(button => button.textContent?.trim() === 'キャンセル')).toHaveLength(1)
    expect(screen.getByText(/キャンセルしてもお客様への自動連絡はありません/)).toBeTruthy()
    expect(screen.getByText('LINEアカウント')).toBeTruthy()
    expect(screen.getByText('環境')).toBeTruthy()
    expect(screen.queryByText(/この結果がLINEで届きます/)).toBeNull()
  })

  it('LINE未連携なら、どの操作でも自動連絡が無いことを伝える', async () => {
    m.get.mockResolvedValue({
      booking: booking('A', {
        customer: {
          displayName: 'A顧客',
          isLineLinked: false,
          friendId: null,
          phone: '末尾 1234',
          bookingCustomerId: null,
          petName: null,
          tags: [],
          mileageBalance: null,
        },
      }),
    })
    render(<Page />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '承認する' }))
    await flush()
    // ボタン横の案内と確認窓の説明、両方に自動連絡が無いことを書く。
    expect(
      screen.getAllByText(/LINEと結びついていないため、お客様への自動連絡はありません/).length,
    ).toBeGreaterThan(1)
  })
})

it('WEB300：保存を待つ間は予約の追加編集を止め、失敗後に入力を残す', async () => {
  let reject!: (e: Error) => void
  m.get.mockResolvedValue({ booking: booking('A', { status: 'confirmed' }) })
  m.update.mockImplementation(() => new Promise((_, no) => { reject = no }))
  render(<Page />); await flush()
  fireEvent.click(screen.getByRole('button', { name: '内容を変える' }))
  await flush()
  const reason = screen.getByPlaceholderText('例：お客様の都合で時間変更') as HTMLInputElement
  fireEvent.change(reason, { target: { value: '変更の理由' } })
  const price = document.querySelector('input[type="number"]') as HTMLInputElement
  fireEvent.change(price, { target: { value: '1000' } })
  fireEvent.click(screen.getByRole('button', { name: 'この内容にする' }))
  await waitFor(() => expect(m.update).toHaveBeenCalled())
  expect(reason.matches(':disabled')).toBe(true)
  expect(price.matches(':disabled')).toBe(true)
  reject(new Error('down'))
  await waitFor(() => expect(reason.matches(':disabled')).toBe(false))
  expect(reason.value).toBe('変更の理由')
})

// 取得失敗の文と再試行は実際のAPIエラーから決める。
it.each([403, 503])('詳細の%sは原因を言い分け、手動の読み直しは同じ対象を取る', async status => {
  const { ApiError } = await import('@/lib/api')
  m.get.mockRejectedValueOnce(new ApiError(status)).mockResolvedValue({ booking: booking('回復') })
  render(<Page />)
  if (status === 403) {
    await screen.findByText('予約を見る権限がありません')
    expect(screen.queryByText('回復メニュー')).toBeNull()
    expect(screen.queryByRole('button', { name: /承認する/ })).toBeNull()
    expect(m.get).toHaveBeenCalledTimes(1)
  }
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度読み込む' }))
  await screen.findByText('回復メニュー')
  expect(m.get).toHaveBeenLastCalledWith('A', 'one')
  expect(m.get).toHaveBeenCalledTimes(2)
  expect(m.update).not.toHaveBeenCalled()
})
