// @vitest-environment happy-dom
/*
 * ★V8-B 予約の詳細（`AjZhH`）の小窓。
 * 差し替えるのは見た目だけ。来店回数・閉じる・取り消す・変えるが実在する。
 * 卓・人数・アレルギーは予約のデータに無いので出さない。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  getBooking: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    bookingApi: {
      ...actual.bookingApi,
      getBooking: apiMocks.getBooking,
    },
  }
})

vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/booking/bookings',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import BookingDetailV8 from './booking-detail'

const BOOKING = {
  id: 'booking-1',
  friend_id: null,
  booking_customer_id: 'customer-1',
  starts_at: '2026-10-02T19:00:00+09:00',
  ends_at: '2026-10-02T21:00:00+09:00',
  status: 'confirmed',
  customer_note: null,
  internal_note: null,
  price_at_booking: 8800,
  menu_name: '秋の鹿肉コース',
  staff_name: '佐藤',
  friend_name: '見本 182',
  requested_at: '2026-10-01T10:00:00+09:00',
  decided_at: null,
  external_event_id: null,
  staff_id: 'staff-1',
  source: 'phone',
} as unknown as import('@/lib/api').BookingRequest

const mounted: Array<{ root: Root; host: HTMLElement }> = []

function render(onCancel = vi.fn()): { host: HTMLElement; onCancel: ReturnType<typeof vi.fn> } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  mounted.push({ root, host })
  act(() => {
    root.render(
      <BookingDetailV8
        booking={BOOKING}
        accountId="account-1"
        canOperate
        onClose={() => undefined}
        onCancel={onCancel}
        detailHref="/booking/bookings/detail?id=booking-1"
      />,
    )
  })
  return { host, onCancel }
}

describe('予約の詳細のV8（AjZhH）', () => {
  beforeEach(() => {
    apiMocks.getBooking.mockResolvedValue({ booking: { historyTotal: 3 } })
  })

  afterEach(async () => {
    await act(async () => {
      for (const { root } of mounted) root.unmount()
    })
    for (const { host } of mounted) host.remove()
    mounted.length = 0
    vi.clearAllMocks()
  })

  it('板IDと中身・3つのボタンを出す', async () => {
    render()
    await act(async () => undefined)
    await act(async () => undefined)
    // 小窓は portal で body 直下へ移る。
    expect(document.querySelector('[data-design-node="AjZhH"]')).not.toBeNull()
    expect(document.body.textContent).toContain('見本 182さん')
    expect(document.body.textContent).toContain('秋の鹿肉コース')
    expect(document.body.textContent).toContain('3回')
    expect(document.querySelector('[role="dialog"] button[aria-label="閉じる"]')).not.toBeNull()
    for (const label of ['取り消す', '変える']) {
      expect(document.body.textContent).toContain(label)
    }
  })

  it('来店回数の読み込み中は文字を出さず骨組みにする', async () => {
    let resolveLoad!: (value: { booking: { historyTotal: number } }) => void
    apiMocks.getBooking.mockReturnValueOnce(new Promise((resolve) => { resolveLoad = resolve }))
    render()
    await act(async () => undefined)
    // 「読み込んでいます」の文字は置かず、入れ物が読み込み中と伝える。
    expect(document.body.textContent).not.toContain('読み込んでいます')
    const dd = [...document.querySelectorAll('dd')].find((el) => el.textContent?.includes('回') || el.getAttribute('aria-busy') === 'true')
    expect(dd?.getAttribute('aria-busy')).toBe('true')
    await act(async () => { resolveLoad({ booking: { historyTotal: 5 } }) })
    await act(async () => undefined)
    expect(document.body.textContent).toContain('5回')
  })

  it('取り消すを押すと取消の口へ渡す', async () => {
    const { onCancel } = render()
    await act(async () => undefined)
    await act(async () => undefined)
    const cancel = [...document.querySelectorAll('button')].find((el) => el.textContent === '取り消す')
    await act(async () => {
      cancel!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
