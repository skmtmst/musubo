// @vitest-environment happy-dom
import React, { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { expectPermissionLocked } from '@/test-utils/permission-locked-control'
import { readStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'

const apiMocks = vi.hoisted(() => ({
  listBookings: vi.fn(),
  absence: vi.fn(),
  getBookingSummary: vi.fn(),
  getEvent: vi.fn(),
  updateBooking: vi.fn(),
  decideBooking: vi.fn(),
  adminCancelBooking: vi.fn(),
  listEvents: vi.fn(),
  listOccurrenceSelector: vi.fn(),
  getOccurrenceApplicants: vi.fn(),
  promoteOccurrenceWaitlist: vi.fn(),
  reorderOccurrenceWaitlist: vi.fn(),
  skipOccurrenceWaitlist: vi.fn(),
  downloadOccurrenceApplicantsCsv: vi.fn(async () => undefined),
  previewOccurrenceBroadcast: vi.fn(),
  sendOccurrenceBroadcast: vi.fn(),
}))

const accountMock = vi.hoisted(() => ({ selectedAccountId: 'account-a', role: 'owner' as string | null }))
vi.mock('@/lib/api/helpers/gap2', () => ({ bookingMakeupApi: { absenceByStore: apiMocks.absence } }))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return { ...actual, eventsApi: { ...actual.eventsApi, ...apiMocks }, api: { ...actual.api, broadcasts: { ...actual.api.broadcasts, send: apiMocks.sendOccurrenceBroadcast }, staff: { ...actual.api.staff, me: vi.fn(async () => ({ success: true, data: { id: 'me', role: accountMock.role, isActive: true } })) } } }
})
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), useSearchParams: () => new URLSearchParams('id=event-1') }))
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: accountMock.selectedAccountId,
    accounts: [
      { id: 'account-a', name: 'A店', role: accountMock.role },
      { id: 'account-b', name: 'B店', role: 'owner' },
    ],
  }),
}))
vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock() }))
vi.mock('@/components/shared/select', () => ({
  default: ({ value, onChange, options, size: _size, ...props }: {
    value: string
    onChange?: (value: string) => void
    options: Array<{ value: string; label: string }>
    size?: string
  } & React.ComponentProps<'select'>) => (
    <select value={value} onChange={(event) => onChange?.(event.target.value)} {...props}>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  ),
}))

import EventBookingsPage from '@/v8/events/bookings'

const mountedRoots: Root[] = []

beforeEach(() => {
  Object.values(apiMocks).forEach((mock) => mock.mockReset())
  apiMocks.listBookings.mockResolvedValue({ items: [], total: 0 })
  apiMocks.getBookingSummary.mockImplementation((accountId: string) => Promise.resolve({ requested: accountId === 'account-a' ? 7 : 0, confirmed: 2, cancelled: 0, totalCapacity: 10 }))
  document.documentElement.dataset.theme = 'v8'
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  accountMock.selectedAccountId = 'account-a'
  accountMock.role = 'owner'
  apiMocks.getEvent.mockResolvedValue({ id: 'event-1', name: '相談会', waitlist_enabled: 1 })

  apiMocks.decideBooking.mockResolvedValue({ ok: true })
  apiMocks.adminCancelBooking.mockResolvedValue({ ok: true })
  apiMocks.listEvents.mockResolvedValue({ items: [], total: 0 })
  apiMocks.listOccurrenceSelector.mockResolvedValue({
    items: [{ id: 'slot-1', starts_at: '2099-06-01T01:00:00.000Z', ends_at: '2099-06-01T02:00:00.000Z', is_active: 1 }],
  })
  apiMocks.getOccurrenceApplicants.mockResolvedValue({
    occurrence: { id: 'slot-1', eventId: 'event-1', startsAt: '2099-06-01T01:00:00.000Z', endsAt: '2099-06-01T02:00:00.000Z', capacity: 5, activeSeats: 1, version: 4 },
    summary: { bookingCount: 1, waitingCount: 1, activeSeats: 1 },
    snapshotId: 'snapshot-1', snapshotExpiresAt: '2099-06-01T00:15:00.000Z',
    applicants: [
      { source: 'booking', id: 'booking-1', friendId: 'friend-booking', displayName: '申込 太郎', pictureUrl: null, status: 'confirmed', partySize: 1, appliedAt: '2099-05-01T01:00:00.000Z', answers: null, firstParticipation: { isFirst: null, attendedCount: null, checkedAt: null }, offeredAt: null, offerExpiresAt: null },
      { source: 'waitlist', id: 'wait-1', friendId: 'friend-waiting', displayName: '待機 花子', pictureUrl: null, status: 'waiting', partySize: 2, appliedAt: '2099-05-02T01:00:00.000Z', answers: null, firstParticipation: { isFirst: null, attendedCount: null, checkedAt: null }, offeredAt: null, offerExpiresAt: null },
    ],
  })
  apiMocks.promoteOccurrenceWaitlist.mockResolvedValue({ kind: 'promoted', occurrenceVersion: 5, promoted: { waitlistId: 'wait-1', friendId: 'friend-waiting', partySize: 2, status: 'offered', offeredAt: '2099-05-03T01:00:00.000Z', expiresAt: '2099-05-04T01:00:00.000Z' } })
  apiMocks.previewOccurrenceBroadcast.mockResolvedValue({ broadcastId: 'broadcast-snapshot-1', recipientCount: 2 })
  apiMocks.sendOccurrenceBroadcast.mockResolvedValue({ success: true })
})

afterEach(async () => {
  await act(async () => {
    while (mountedRoots.length > 0) mountedRoots.pop()?.unmount()
  })
  document.body.textContent = ''
  delete document.documentElement.dataset.theme
})

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  })
}

async function mount(element: ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container as unknown as HTMLElement)
  mountedRoots.push(root)
  await act(async () => { root.render(element) })
  await flush()
  await openRecords()
  return {
    container: document.body,
    root,
    rerender: async (next: ReactElement) => {
      await act(async () => { root.render(next) })
      await flush()
      await openRecords()
    },
    /*
     * **commit と effect の隙間で応答を返す。** `flushSync` で新しい
     * アカウントの描画だけを確定させ、後片付けの effect がまだ動いて
     * いないところで `duringGap` を呼ぶ。切替の失効が effect 任せだと、
     * この隙間で旧アカウントの応答が「今の宛先」と判断されてしまう。
     */
    commitThen: async (next: ReactElement, duringGap: () => void) => {
      /*
        **`act` や `flushSync` では隙間が作れない。** どちらも描画の
        確定に続けて後片付け(useEffect)まで同じ塊で流してしまう。
        そこで act を外して普通に描画させ、**確定の最中に動く
        `useLayoutEffect`** で合図を取る。合図はマイクロタスクなので、
        後片付け（Reactが次の巡回＝マクロタスクへ積む）より先に戻って
        くる。そこが「Bを描き終えたが後片付けはまだ」の隙間。
      */
      const actEnvironment = Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
      Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', false)
      try {
        const committed = deferred<void>()
        function CommitProbe(): null {
          React.useLayoutEffect(() => { committed.resolve() }, [])
          return null
        }
        root.render(<>{next}<CommitProbe /></>)
        await committed.promise
        duringGap()
        for (let index = 0; index < 8; index += 1) await Promise.resolve()
      } finally {
        Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', actEnvironment)
      }
      await flush()
      await openRecords()
    },
  }
}

async function openRecords() {
  const details = document.querySelector('details')
  if (details && !details.open) {
    await act(async () => { details.open = true; fireEvent(details, new Event('toggle')) })
    await flush()
  }
}

function elements(root: Node): HTMLElement[] {
  return [...(root as ParentNode).querySelectorAll<HTMLElement>('*')].filter((element) => !element.closest('[data-closing]'))
}

function isConfirm(element: HTMLElement) {
  return element.tagName === 'BUTTON' && element.getAttribute('data-dialog-action') === 'primary' && Boolean(element.closest('[role=dialog]:not([data-closing]), [role=alertdialog]:not([data-closing])'))
}

function propsOf(element: HTMLElement): Record<string, unknown> {
  const key = Object.keys(element).find((name) => name.startsWith('__reactProps$'))
  const props = key ? (element as unknown as Record<string, Record<string, unknown>>)[key] : undefined
  if (!props) throw new Error(`React props not found: ${element.tagName}`)
  return props
}

function actionButton(container: HTMLElement, bookingId: string, action: string): HTMLElement {
  const label = action === 'no_show' ? '無断' : action === 'cancel' ? 'キャンセルにする' : action === 'reject' ? '断る' : action
  if (action === 'attended') {
    const primary = elements(container).find((element) => (
      element.tagName === 'BUTTON'
      && element.getAttribute('data-booking-id') === bookingId
      && element.getAttribute('data-booking-action') === action
    ))
    if (!primary) throw new Error(`primary action not found: ${bookingId}/${action}`)
    return primary
  }
  const found = elements(container).find((element) => (
    element.tagName === 'BUTTON'
    && element.getAttribute('data-booking-id') === bookingId
    && element.getAttribute('data-booking-action') === 'menu'
  ))
  if (!found) throw new Error(`button not found: ${bookingId}/${action}`)
  fireEvent.click(found)
  const menuItem = elements(document.body).find((element) => element.getAttribute('role') === 'menuitem' && (element.getAttribute('aria-label') ?? element.textContent?.trim()) === label)
  if (!menuItem) throw new Error(`menu item not found: ${bookingId}/${action}`)
  return menuItem
}

function occurrenceActionButton(container: HTMLElement, _action: string): HTMLElement {
  const found = elements(container).find((element) => element.tagName === 'BUTTON' && !(element as HTMLButtonElement).disabled && ['次の方へ案内する', '予約に繰上げ'].includes(element.textContent?.trim() ?? ''))
  if (!found) throw new Error('promotion button not found')
  return found
}

function buttonByText(container: HTMLElement, text: string): HTMLElement {
  const preview = text === '対象と内容を確認'
  const found = elements(container).find((element) => element.tagName === 'BUTTON' && (preview ? !element.closest('[role=dialog], [role=alertdialog]') && ['送る', '確認中…'].includes(element.textContent?.trim() ?? '') : element.textContent === text))
  if (!found) throw new Error(`button not found: ${text}`)
  return found
}

async function click(button: HTMLElement): Promise<void> {
  await act(async () => { button.click() })
  await flush()
}

it.each([0, 1])('名簿の入口%sから欠席し、正規の読取で人数と予約の記録を更新する', async index => {
  apiMocks.getEvent.mockResolvedValue({ id: 'event-1', line_account_id: 'account-a', name: '相談会', makeup_rule_json: JSON.stringify({ enabled: true, cutoffHours: 3, validDays: 30, monthlyCap: 2, target: 'same_kind', targetIds: [] }) })
  apiMocks.listBookings.mockResolvedValue({ items: [{ id: 'booking-1', event_id: 'event-1', slot_id: 'slot-1', friend_id: 'friend-booking', status: 'confirmed', slot_starts_at: '2099-06-01T01:00:00Z', friend_display_name: '申込 太郎' }], total: 1 })
  apiMocks.absence.mockImplementation(async () => {
    const previous = await apiMocks.getOccurrenceApplicants()
    apiMocks.getOccurrenceApplicants.mockResolvedValue({ ...previous, occurrence: { ...previous.occurrence, activeSeats: 0 }, applicants: [] })
    apiMocks.listBookings.mockResolvedValue({ items: [], total: 0 })
    return { data: { eventBooking: { id: 'booking-1', status: 'absent' }, makeupCredit: null, reasonIfNone: 'monthly_cap' } }
  })
  const view = await mount(<EventBookingsPage />)
  const buttons = elements(view.container).filter(el => el.getAttribute('data-booking-action') === 'absence')
  expect(buttons).toHaveLength(2)
  await click(buttons[index])
  await click(buttonByText(view.container, '欠席にする'))
  expect(apiMocks.absence).toHaveBeenCalledWith('account-a', 'booking-1', { grantMakeup: true })
  expect(view.container.textContent).toContain('今月の振替の上限に達しているため')
  expect(apiMocks.listBookings.mock.calls.length).toBeGreaterThan(1)
  expect(elements(view.container).filter(el => el.getAttribute('data-booking-action') === 'absence')).toHaveLength(0)
})

/** U: 待ち操作の確認窓に理由を書いて確認する。 */
async function confirmWaitlistDialog(container: HTMLElement, reason: string): Promise<void> {
  const area = elements(container).find((element) => (
    element.tagName === 'TEXTAREA' && Boolean(element.closest('[role=dialog]:not([data-closing])'))
  ))
  if (!area) throw new Error('reason textarea not found')
  await act(async () => {
    const onChange = propsOf(area).onChange as (event: { target: { value: string } }) => void
    onChange({ target: { value: reason } })
  })
  await flush()
  await click(elements(container).find((element) => isConfirm(element))!)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function booking(id: string, name: string) {
  return {
    id,
    status: 'confirmed',
    friend_display_name: name,
    friend_name: name,
    line_account_id: accountMock.selectedAccountId,
    requested_at: '2026-09-09T01:00:00Z',
    created_at: '2026-09-09T01:00:00Z',
    slot_starts_at: '2026-09-10T01:00:00Z',
    companion_note: null,
    is_first_time: 1,
  }
}

describe('Issue #684 イベント予約の実操作', () => {
  it('開催回の待ち順・案内期限・個別トークを表示し、同じ版への案内は二重送信しない', async () => {
    const sending = deferred<{ kind: 'promoted' }>()
    apiMocks.promoteOccurrenceWaitlist.mockReturnValue(sending.promise)
    apiMocks.getOccurrenceApplicants.mockResolvedValue({
      occurrence: { id: 'slot-1', eventId: 'event-1', startsAt: '2099-06-01T01:00:00.000Z', endsAt: '2099-06-01T02:00:00.000Z', capacity: 5, activeSeats: 1, version: 4 },
    summary: { bookingCount: 1, waitingCount: 1, activeSeats: 1 },
    snapshotId: 'snapshot-1', snapshotExpiresAt: '2099-06-01T00:15:00.000Z',
      applicants: [
        { source: 'waitlist', id: 'wait-1', friendId: 'friend-waiting', displayName: '待機 花子', pictureUrl: null, status: 'offered', partySize: 2, appliedAt: '2099-05-02T01:00:00.000Z', answers: null, firstParticipation: { isFirst: null, attendedCount: null, checkedAt: null }, offeredAt: '2099-05-03T01:00:00.000Z', offerExpiresAt: '2099-05-04T01:00:00.000Z' },
      ],
    })
    const view = await mount(<EventBookingsPage />)

    expect(apiMocks.listOccurrenceSelector).toHaveBeenCalledWith('account-a', 'event-1')
    expect(view.container.textContent).toContain('キャンセル待ち')
    expect(view.container.textContent).toContain('案内中')
    expect(view.container.textContent).not.toContain('キャンセル待ち 1番')
    expect(view.container.textContent).toContain('待機 花子')
    expect(view.container.textContent).toContain('5/4 10:00')
    const talk = elements(view.container).find((element) => element.tagName === 'A' && element.textContent === '個別トーク')
    expect(talk && propsOf(talk).href).toBe('/chats?friend=friend-waiting')

    const button = occurrenceActionButton(view.container, 'promote-waitlist')
    await click(button)
    await click(button)
    expect(view.container.textContent).toContain('LINEアカウント')
    expect(view.container.textContent).toContain('環境')
    // U: 理由の確認窓が先。理由なしでは送らない。
    expect(apiMocks.promoteOccurrenceWaitlist).toHaveBeenCalledTimes(0)
    await confirmWaitlistDialog(view.container, '空きが出たため順番どおり案内します')
    expect(apiMocks.promoteOccurrenceWaitlist).toHaveBeenCalledTimes(1)
    expect(apiMocks.promoteOccurrenceWaitlist).toHaveBeenCalledWith('account-a', 'slot-1', 4, '空きが出たため順番どおり案内します')
    sending.resolve({ kind: 'promoted' })
    await flush()
  })

  it('採用済みの待ち順は案内中・受諾済みも数え、それぞれの状態を区別する', async () => {
    apiMocks.getOccurrenceApplicants.mockResolvedValue({
      occurrence: { id: 'slot-1', eventId: 'event-1', startsAt: '2099-06-01T01:00:00.000Z', endsAt: '2099-06-01T02:00:00.000Z', capacity: 5, activeSeats: 1, version: 4 },
      summary: { bookingCount: 0, waitingCount: 1, activeSeats: 1 },
      snapshotId: 'snapshot-1', snapshotExpiresAt: '2099-06-01T00:15:00.000Z',
      applicants: [
        { source: 'waitlist', id: 'wait-offered', friendId: 'friend-offered', displayName: '見本 04', pictureUrl: null, status: 'offered', partySize: 1, appliedAt: '2099-05-01T01:00:00.000Z', answers: null, firstParticipation: { isFirst: null, attendedCount: null, checkedAt: null }, offeredAt: '2099-05-02T01:00:00.000Z', offerExpiresAt: '2099-05-03T01:00:00.000Z' },
        { source: 'waitlist', id: 'wait-accepted', friendId: 'friend-accepted', displayName: '見本 05', pictureUrl: null, status: 'accepted', partySize: 1, appliedAt: '2099-05-01T02:00:00.000Z', answers: null, firstParticipation: { isFirst: null, attendedCount: null, checkedAt: null }, offeredAt: '2099-05-02T02:00:00.000Z', offerExpiresAt: null },
        { source: 'waitlist', id: 'wait-waiting', friendId: 'friend-waiting', displayName: '待機 花子', pictureUrl: null, status: 'waiting', partySize: 1, appliedAt: '2099-05-01T03:00:00.000Z', answers: null, firstParticipation: { isFirst: null, attendedCount: null, checkedAt: null }, offeredAt: null, offerExpiresAt: null },
      ],
    })
    const view = await mount(<EventBookingsPage />)

    expect(view.container.textContent).toContain('案内中')
    expect(view.container.textContent).toContain('受諾済み')
    expect(view.container.textContent).toContain('待機中')
    expect(view.container.textContent).toContain('キャンセル待ち 1 番')
    expect(view.container.textContent).toContain('キャンセル待ち 2 番')
    expect(view.container.textContent).toContain('キャンセル待ち 3 番')
  })

  it('IDEA-29: 残席・待機/案内中の人数・繰上げ履歴・当日受付を人数で分けて出す', async () => {

    apiMocks.getOccurrenceApplicants.mockResolvedValue({
      occurrence: { id: 'slot-1', eventId: 'event-1', startsAt: '2099-06-01T01:00:00.000Z', endsAt: '2099-06-01T02:00:00.000Z', capacity: 5, activeSeats: 5, version: 4 },
      summary: {
        bookingCount: 2, waitingCount: 2, activeSeats: 5,
        confirmedSeats: 1, requestedSeats: 2, waitingSeats: 3, offeredSeats: 2, remainingSeats: 0,
      },
      waitlistHistory: [
        { id: 'wait-done', friendId: 'friend-done', displayName: '繰上 太郎', status: 'converted', partySize: 1, createdAt: '2099-05-01T01:00:00.000Z', offeredAt: '2099-05-02T01:00:00.000Z', offerExpiresAt: '2099-05-03T01:00:00.000Z', notifiedAt: '2099-05-02T01:00:00.000Z', updatedAt: '2099-05-02T02:00:00.000Z', convertedBookingId: 'event-waitlist:wait-done' },
        { id: 'wait-lost', friendId: 'friend-lost', displayName: '見本 06', status: 'expired', partySize: 1, createdAt: '2099-04-28T01:00:00.000Z', offeredAt: '2099-04-29T01:00:00.000Z', offerExpiresAt: '2099-04-30T01:00:00.000Z', notifiedAt: null, updatedAt: '2099-04-30T01:00:00.000Z', convertedBookingId: null },
      ],
      attendance: {
        attendedSeats: 2,
        noShowSeats: 1,
        entries: [
          { id: 'booking-att', friendId: 'friend-att', displayName: '見本 07', status: 'attended', partySize: 2, markedAt: '2099-06-01T02:10:00.000Z' },
          { id: 'booking-ns', friendId: 'friend-ns', displayName: '見本 08', status: 'no_show', partySize: 1, markedAt: '2099-06-01T02:20:00.000Z' },
        ],
      },
      snapshotId: 'snapshot-1', snapshotExpiresAt: '2099-06-01T00:15:00.000Z',
      applicants: [
        { source: 'booking', id: 'booking-1', friendId: 'friend-booking', displayName: '申込 太郎', pictureUrl: null, status: 'confirmed', partySize: 1, appliedAt: '2099-05-01T01:00:00.000Z', answers: null, firstParticipation: { isFirst: null, attendedCount: null, checkedAt: null }, offeredAt: null, offerExpiresAt: null },
        { source: 'booking', id: 'booking-2', friendId: 'friend-requested', displayName: '見本 09', pictureUrl: null, status: 'requested', partySize: 2, appliedAt: '2099-05-01T02:00:00.000Z', answers: null, firstParticipation: { isFirst: null, attendedCount: null, checkedAt: null }, offeredAt: null, offerExpiresAt: null },
        { source: 'waitlist', id: 'wait-1', friendId: 'friend-waiting', displayName: '待機 花子', pictureUrl: null, status: 'waiting', partySize: 3, appliedAt: '2099-05-02T01:00:00.000Z', answers: null, firstParticipation: { isFirst: null, attendedCount: null, checkedAt: null }, offeredAt: null, offerExpiresAt: null },
        { source: 'waitlist', id: 'wait-2', friendId: 'friend-offered', displayName: '見本 10', pictureUrl: null, status: 'offered', partySize: 2, appliedAt: '2099-05-02T02:00:00.000Z', answers: null, firstParticipation: { isFirst: null, attendedCount: null, checkedAt: null }, offeredAt: '2099-05-03T01:00:00.000Z', offerExpiresAt: '2099-05-04T01:00:00.000Z' },
      ],
    })
    const view = await mount(<EventBookingsPage />)

    // 開催回パネル: 申込を確定/承認待ちへ分け、待機と案内中を人数で分ける。
    expect(view.container.textContent).toContain('申込 3人（確定 1人・承認待ち 2人）')
    expect(view.container.textContent).toContain('キャンセル待ち 3人・案内中 2人')
    expect(view.container.textContent).toContain('満席（定員 5人）')
    // 上部の集計カードも人数基準: 待ち列は待機+案内中=5人。
    expect(view.container.textContent).toContain('キャンセル待ち 3人・案内中 2人')
    // 当日受付: 記録済みを人数で出し、確定のままの人は受付前として残す。
    const attendance = view.container.querySelector('[aria-label="当日の受付"]')!
    expect(attendance.textContent).toContain('参加済 2人')
    expect(attendance.textContent).toContain('無断欠席 1人')
    expect(attendance.textContent).toContain('受付前 1人')
    expect(view.container.textContent).toContain('見本 07')
    expect(view.container.textContent).toContain('見本 08')
    // 繰上げ履歴: 予約化・期限切れを運用の言葉で出す。
    expect(view.container.querySelector('[aria-label="キャンセル待ち"]')).toBeTruthy()
    expect(view.container.textContent).toContain('予約に繰上げ')
    expect(view.container.textContent).toContain('期限切れ')
    expect(view.container.textContent).toContain('繰上 太郎')
  })

  it('IDEA-29: 旧応答(席数・履歴なし)でも行から数え直し、未取得と0を混ぜない', async () => {
    // beforeEach の既定応答は新しい集計フィールドを持たない旧形。
    const view = await mount(<EventBookingsPage />)

    // 行から数え直した人数で出る(確定1人・待機2人・案内中0人・残席4)。
    expect(view.container.textContent).toContain('申込 1人（確定 1人・承認待ち 0人）')
    expect(view.container.textContent).toContain('キャンセル待ち 2人・案内中 0人')
    expect(view.container.textContent).toContain('残席 4席（定員 5人）')
    // 履歴・受付は「0件」ではなく「まだ取得できていません」と区別する。
    expect(view.container.textContent).toContain('履歴はまだ読み込めていません')
    expect(view.container.textContent).toContain('受付の記録はまだ読み込めていません')
  })

  it('待ち案内の失敗後は最新一覧を読み直しても理由を残す', async () => {
    apiMocks.promoteOccurrenceWaitlist.mockRejectedValue(new Error('version_conflict'))
    const view = await mount(<EventBookingsPage />)
    const readsBeforeAction = apiMocks.getOccurrenceApplicants.mock.calls.length

    await click(occurrenceActionButton(view.container, 'promote-waitlist'))
    await confirmWaitlistDialog(view.container, '空きが出たため順番どおり案内します')

    expect(apiMocks.getOccurrenceApplicants).toHaveBeenCalledTimes(readsBeforeAction + 1)
    // 実際の窓で失敗を伝え、閉じずに書いた理由を残す。
    expect(elements(view.container).some((element) => isConfirm(element))).toBe(true)
    const area = elements(view.container).find((element) => (
      element.tagName === 'TEXTAREA' && Boolean(element.closest('[role=dialog]:not([data-closing])'))
    ))!
    expect(propsOf(area).value).toBe('空きが出たため順番どおり案内します')
    expect(view.container.textContent).toContain('待機 花子')
  })

  it('U: 理由なしでは送らず、見送りは理由つきで送る', async () => {
    apiMocks.skipOccurrenceWaitlist.mockResolvedValue({ success: true, occurrence_version: 5, waitlist_id: 'wait-1', log_id: 'log-1' })
    const view = await mount(<EventBookingsPage />)
    await click(buttonByText(view.container, '見送る'))
    // 理由が空のままは実際の確認ボタンを押せない。
    const confirm = elements(view.container).find((element) => isConfirm(element))!
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    await click(confirm)
    expect(apiMocks.skipOccurrenceWaitlist).not.toHaveBeenCalled()
    await confirmWaitlistDialog(view.container, '連絡がつかないため今回は見送ります')
    expect(apiMocks.skipOccurrenceWaitlist).toHaveBeenCalledWith('account-a', 'slot-1', {
      waitlist_id: 'wait-1',
      expectedVersion: 4,
      reason: '連絡がつかないため今回は見送ります',
    })
  })

  it('U: 上へで2人の順番を入れ替える', async () => {
    apiMocks.getOccurrenceApplicants.mockResolvedValue({
      occurrence: { id: 'slot-1', eventId: 'event-1', startsAt: '2099-06-01T01:00:00.000Z', endsAt: '2099-06-01T02:00:00.000Z', capacity: 5, activeSeats: 1, version: 4 },
      summary: { bookingCount: 0, waitingCount: 2, activeSeats: 1 },
      snapshotId: 'snapshot-1', snapshotExpiresAt: '2099-06-01T00:15:00.000Z',
      applicants: [
        { source: 'waitlist', id: 'wait-1', friendId: 'friend-1', displayName: '見本 11', pictureUrl: null, status: 'waiting', partySize: 1, appliedAt: '2099-05-01T01:00:00.000Z', answers: null, firstParticipation: { isFirst: null, attendedCount: null, checkedAt: null }, offeredAt: null, offerExpiresAt: null },
        { source: 'waitlist', id: 'wait-2', friendId: 'friend-2', displayName: '見本 12', pictureUrl: null, status: 'waiting', partySize: 1, appliedAt: '2099-05-02T01:00:00.000Z', answers: null, firstParticipation: { isFirst: null, attendedCount: null, checkedAt: null }, offeredAt: null, offerExpiresAt: null },
      ],
    })
    apiMocks.reorderOccurrenceWaitlist.mockResolvedValue({ success: true, occurrence_version: 5, order: ['wait-2', 'wait-1'], log_id: 'log-2' })
    const view = await mount(<EventBookingsPage />)
    const reorderButtons = elements(view.container).filter((element) => element.tagName === 'BUTTON' && element.textContent === '待ち順を変える')
    expect(reorderButtons).toHaveLength(2)
    await click(reorderButtons[1])
    await click(buttonByText(view.container, '上へ'))
    await confirmWaitlistDialog(view.container, '車いすの方を先にします')
    expect(apiMocks.reorderOccurrenceWaitlist).toHaveBeenCalledWith('account-a', 'slot-1', {
      ordered_ids: ['wait-2', 'wait-1'],
      expectedVersion: 4,
      reason: '車いすの方を先にします',
    })
  })

  it('owner/adminだけが申込者への一斉送信を操作できる', async () => {
    const ownerView = await mount(<EventBookingsPage />)
    expect(ownerView.container.textContent).toContain('お知らせを送る')
    expect(elements(ownerView.container).some((element) => element.tagName === 'INPUT' && element.id === 'ev-bk-message')).toBe(true)

    await act(async () => { mountedRoots.pop()!.unmount() })
    document.body.textContent = ''
    accountMock.role = 'admin'
    const adminView = await mount(<EventBookingsPage />)
    expect(adminView.container.textContent).toContain('お知らせを送る')
    expect(elements(adminView.container).some((element) => element.tagName === 'INPUT' && element.id === 'ev-bk-message')).toBe(true)
  })

  it.each([null, 'staff', 'unknown'] as const)('権限が%sのときも一斉送信の場所を残し、実行を止める', async (role) => {
    accountMock.role = role
    const view = await mount(<EventBookingsPage />)

    expect(view.container.textContent).toContain('お知らせを送る')
    expect(view.container.querySelector<HTMLInputElement>('#ev-bk-message')?.readOnly).toBe(true)
    const send = buttonByText(view.container, '送る') as HTMLButtonElement
    expect(send.disabled || send.getAttribute('aria-disabled') === 'true').toBe(true)
    await click(send)
    expect(apiMocks.previewOccurrenceBroadcast).not.toHaveBeenCalled()
    expect(view.container.textContent).toContain('CSVで書き出す')
    expect(view.container.textContent).toContain('個別トーク')
    expect(view.container.textContent).toContain('次の方へ案内する')
  })

  it('閲覧のみでも申込操作を残し、焦点と理由を示して全ての更新を拒否する', async () => {
    accountMock.role = 'viewer'
    const view = await mount(<EventBookingsPage />)
    expect(view.container.querySelector('[data-read-only-notice]')).toBeTruthy()
    await expectPermissionLocked(actionButton(view.container, 'booking-1', 'attended'))
    await expectPermissionLocked(occurrenceActionButton(view.container, 'promote-waitlist'))
    await expectPermissionLocked(buttonByText(view.container, 'CSVで書き出す'))
    await expectPermissionLocked(buttonByText(view.container, '送る'))
    await expectPermissionLocked(actionButton(view.container, 'booking-1', 'no_show'))
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull()
    for (const method of [apiMocks.updateBooking, apiMocks.decideBooking, apiMocks.adminCancelBooking,
      apiMocks.promoteOccurrenceWaitlist, apiMocks.reorderOccurrenceWaitlist, apiMocks.skipOccurrenceWaitlist,
      apiMocks.downloadOccurrenceApplicantsCsv, apiMocks.previewOccurrenceBroadcast, apiMocks.sendOccurrenceBroadcast]) {
      expect(method).not.toHaveBeenCalled()
    }
  })

  it('確認窓を開いた後で閲覧のみへ変わったら窓を閉じ、更新しない', async () => {
    const view = await mount(<EventBookingsPage />)
    await click(actionButton(view.container, 'booking-1', 'cancel'))
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeTruthy()
    expect(document.body.textContent).toContain('LINEアカウント')
    expect(document.body.textContent).toContain('環境')
    await act(async () => { rememberStaffIdentity({ ...readStaffIdentity()!, role: 'viewer' }) })
    await flush()
    expect(elements(document.body).some((element) => ['dialog', 'alertdialog'].includes(element.getAttribute('role') ?? ''))).toBe(false)
    await expectPermissionLocked(actionButton(view.container, 'booking-1', 'attended'))
    expect(apiMocks.adminCancelBooking).not.toHaveBeenCalled()
  })

  it('申込を断る確認に操作先と環境を示す', async () => {
    const data = await apiMocks.getOccurrenceApplicants()
    data.applicants[0].status = 'requested'
    const view = await mount(<EventBookingsPage />)
    await click(actionButton(view.container, 'booking-1', 'reject'))
    expect(document.body.textContent).toContain('LINEアカウント')
    expect(document.body.textContent).toContain('環境')
    expect(apiMocks.decideBooking).not.toHaveBeenCalled()
  })

  it('一斉送信はサーバーで固定した対象を確認してから送り、二重押しでpreviewを増やさない', async () => {
    const preview = deferred<{ broadcastId: string; recipientCount: number }>()
    apiMocks.previewOccurrenceBroadcast.mockReturnValue(preview.promise)
    const view = await mount(<EventBookingsPage />)
    const message = elements(view.container).find((element) => element.tagName === 'INPUT' && element.id === 'ev-bk-message')!
    await act(async () => {
      const onChange = propsOf(message).onChange as (event: { target: { value: string } }) => void
      onChange({ target: { value: '開催回のご案内です' } })
    })
    await flush()
    const previewButton = buttonByText(view.container, '対象と内容を確認')
    await click(previewButton)
    await click(previewButton)
    expect(apiMocks.previewOccurrenceBroadcast).toHaveBeenCalledTimes(1)
    expect(apiMocks.previewOccurrenceBroadcast).toHaveBeenCalledWith(
      'account-a', 'slot-1', expect.objectContaining({ snapshotId: 'snapshot-1' }), expect.any(String),
    )
    preview.resolve({ broadcastId: 'broadcast-snapshot-1', recipientCount: 2 })
    await flush()
    expect(view.container.textContent).toContain('2 人に送りますか')
    expect(document.querySelector('[role=dialog]:not([data-closing])')).toBeTruthy()
    expect(view.container.textContent).toContain('LINEアカウント')
    expect(view.container.textContent).toContain('環境')
    await click(elements(view.container).find((element) => isConfirm(element))!)
    expect(apiMocks.sendOccurrenceBroadcast).toHaveBeenCalledWith('broadcast-snapshot-1')
  })

  it('アカウント切替前の一斉送信previewは確認・送信できない', async () => {
    const view = await mount(<EventBookingsPage />)
    const message = elements(view.container).find((element) => element.tagName === 'INPUT' && element.id === 'ev-bk-message')!
    await act(async () => {
      const onChange = propsOf(message).onChange as (event: { target: { value: string } }) => void
      onChange({ target: { value: '開催回のご案内です' } })
    })
    await flush()
    await click(buttonByText(view.container, '対象と内容を確認'))
    expect(document.querySelector('[role=dialog]:not([data-closing])')).toBeTruthy()
    expect(elements(view.container).some((element) => isConfirm(element))).toBe(true)

    accountMock.selectedAccountId = 'account-b'
    await view.rerender(<EventBookingsPage />)

    expect(elements(view.container).some((element) => isConfirm(element))).toBe(false)
    expect(apiMocks.sendOccurrenceBroadcast).not.toHaveBeenCalled()
  })

  it('切替前のpreview処理中でも、新しいアカウントで一斉送信を開始できる', async () => {
    const oldPreview = deferred<{ broadcastId: string; recipientCount: number }>()
    apiMocks.previewOccurrenceBroadcast.mockReturnValueOnce(oldPreview.promise)
    const view = await mount(<EventBookingsPage />)
    const firstMessage = elements(view.container).find((element) => element.tagName === 'INPUT' && element.id === 'ev-bk-message')!
    await act(async () => {
      const onChange = propsOf(firstMessage).onChange as (event: { target: { value: string } }) => void
      onChange({ target: { value: 'Aの案内です' } })
    })
    await flush()
    await click(buttonByText(view.container, '対象と内容を確認'))

    accountMock.selectedAccountId = 'account-b'
    await view.rerender(<EventBookingsPage />)
    const secondMessage = elements(view.container).find((element) => element.tagName === 'INPUT' && element.id === 'ev-bk-message')!
    await act(async () => {
      const onChange = propsOf(secondMessage).onChange as (event: { target: { value: string } }) => void
      onChange({ target: { value: 'Bの案内です' } })
    })
    await flush()
    await click(buttonByText(view.container, '対象と内容を確認'))

    expect(apiMocks.previewOccurrenceBroadcast).toHaveBeenCalledTimes(2)
  })

  it('切替前の送信処理中でも、新しいアカウントの待ち案内を操作できる', async () => {
    const oldSend = deferred<{ success: true }>()
    apiMocks.sendOccurrenceBroadcast.mockReturnValueOnce(oldSend.promise)
    const view = await mount(<EventBookingsPage />)
    const message = elements(view.container).find((element) => element.tagName === 'INPUT' && element.id === 'ev-bk-message')!
    await act(async () => {
      const onChange = propsOf(message).onChange as (event: { target: { value: string } }) => void
      onChange({ target: { value: 'Aの案内です' } })
    })
    await flush()
    await click(buttonByText(view.container, '対象と内容を確認'))
    expect(document.querySelector('[role=dialog]:not([data-closing])')).toBeTruthy()
    await click(elements(view.container).find((element) => isConfirm(element))!)

    accountMock.selectedAccountId = 'account-b'
    await view.rerender(<EventBookingsPage />)
    const promote = occurrenceActionButton(view.container, 'promote-waitlist')
    expect(propsOf(promote).disabled).toBe(false)
    await click(promote)
    await confirmWaitlistDialog(view.container, 'Bの空きを案内します')

    expect(apiMocks.promoteOccurrenceWaitlist).toHaveBeenCalledWith('account-b', 'slot-1', 4, 'Bの空きを案内します')
  })

  it('切替前の待ち案内処理中でも、新しいアカウントで待ち案内をやり直せる', async () => {
    const oldPromotion = deferred<{ kind: 'promoted' }>()
    apiMocks.promoteOccurrenceWaitlist.mockReturnValueOnce(oldPromotion.promise)
    const view = await mount(<EventBookingsPage />)
    await click(occurrenceActionButton(view.container, 'promote-waitlist'))
    await confirmWaitlistDialog(view.container, 'Aの空きを案内します')

    accountMock.selectedAccountId = 'account-b'
    await view.rerender(<EventBookingsPage />)
    const promote = occurrenceActionButton(view.container, 'promote-waitlist')
    expect(propsOf(promote).disabled).toBe(false)
    await click(promote)
    await confirmWaitlistDialog(view.container, 'Bの空きを案内します')

    expect(apiMocks.promoteOccurrenceWaitlist).toHaveBeenCalledWith('account-b', 'slot-1', 4, 'Bの空きを案内します')
  })

  it('開催回を切り替えた後に古いpreviewが返っても、新しい開催回の確認・送信に使えない', async () => {
    apiMocks.listOccurrenceSelector.mockResolvedValue({
      items: [
        { id: 'slot-1', starts_at: '2099-06-01T01:00:00.000Z', ends_at: '2099-06-01T02:00:00.000Z', is_active: 1 },
        { id: 'slot-2', starts_at: '2099-06-08T01:00:00.000Z', ends_at: '2099-06-08T02:00:00.000Z', is_active: 1 },
      ],
    })
    apiMocks.getOccurrenceApplicants.mockImplementation(async (_accountId: string, occurrenceId: string) => ({
      occurrence: { id: occurrenceId, eventId: 'event-1', startsAt: '2099-06-01T01:00:00.000Z', endsAt: '2099-06-01T02:00:00.000Z', capacity: 5, activeSeats: 1, version: 4 },
      summary: { bookingCount: 1, waitingCount: 0, activeSeats: 1 },
      snapshotId: `snapshot-${occurrenceId}`, snapshotExpiresAt: '2099-06-01T00:15:00.000Z',
      applicants: [],
    }))
    const oldPreview = deferred<{ broadcastId: string; recipientCount: number }>()
    apiMocks.previewOccurrenceBroadcast.mockReturnValueOnce(oldPreview.promise)
    const view = await mount(<EventBookingsPage />)
    const message = elements(view.container).find((element) => (
      element.tagName === 'INPUT' && element.id === 'ev-bk-message'
    ))!
    await act(async () => {
      const onChange = propsOf(message).onChange as (event: { target: { value: string } }) => void
      onChange({ target: { value: '開催回のご案内です' } })
    })
    await flush()
    await click(buttonByText(view.container, '対象と内容を確認'))
    expect(apiMocks.previewOccurrenceBroadcast).toHaveBeenCalledWith(
      'account-a', 'slot-1', expect.objectContaining({ snapshotId: 'snapshot-slot-1' }), expect.any(String),
    )

    // 開催回2へ切り替え、申込者の表示が切り替わるのを待つ。
    const selector = elements(view.container).find((element) => (
      element.tagName === 'SELECT' && element.getAttribute('aria-label') === '開催回を選ぶ'
    ))!
    await act(async () => {
      fireEvent.change(selector, { target: { value: 'slot-2' } })
    })
    await flush()
    expect(apiMocks.getOccurrenceApplicants).toHaveBeenLastCalledWith('account-a', 'slot-2')

    // 切り替え前の古いpreview応答が今返る。
    oldPreview.resolve({ broadcastId: 'slot-1-draft', recipientCount: 97 })
    await flush()

    expect(view.container.textContent).not.toContain('97 人に送りますか')
    expect(elements(view.container).some(isConfirm)).toBe(false)
    expect(apiMocks.sendOccurrenceBroadcast).not.toHaveBeenCalled()
  })

  it('Aへ戻って押し直した後に古いpreviewが返っても最新の対象を置き換えない', async () => {
    apiMocks.listOccurrenceSelector.mockResolvedValue({
      items: [
        { id: 'slot-1', starts_at: '2099-06-01T01:00:00.000Z', ends_at: '2099-06-01T02:00:00.000Z', is_active: 1 },
        { id: 'slot-2', starts_at: '2099-06-08T01:00:00.000Z', ends_at: '2099-06-08T02:00:00.000Z', is_active: 1 },
      ],
    })
    apiMocks.getOccurrenceApplicants.mockImplementation(async (_accountId: string, occurrenceId: string) => ({
      occurrence: { id: occurrenceId, eventId: 'event-1', startsAt: '2099-06-01T01:00:00.000Z', endsAt: '2099-06-01T02:00:00.000Z', capacity: 5, activeSeats: 1, version: 4 },
      summary: { bookingCount: 1, waitingCount: 0, activeSeats: 1 },
      snapshotId: `snapshot-${occurrenceId}`, snapshotExpiresAt: '2099-06-01T00:15:00.000Z',
      applicants: [],
    }))
    const oldPreview = deferred<{ broadcastId: string; recipientCount: number }>()
    apiMocks.previewOccurrenceBroadcast.mockReturnValueOnce(oldPreview.promise)
    const view = await mount(<EventBookingsPage />)
    const message = elements(view.container).find((element) => (
      element.tagName === 'INPUT' && element.id === 'ev-bk-message'
    ))!
    await act(async () => {
      const onChange = propsOf(message).onChange as (event: { target: { value: string } }) => void
      onChange({ target: { value: '開催回のご案内です' } })
    })
    await flush()
    const selectOccurrence = async (id: string) => {
      const selector = elements(view.container).find((element) => (
        element.tagName === 'SELECT' && element.getAttribute('aria-label') === '開催回を選ぶ'
      ))!
      await act(async () => {
        fireEvent.change(selector, { target: { value: id } })
      })
      await flush()
    }
    await click(buttonByText(view.container, '対象と内容を確認'))
    await selectOccurrence('slot-2')
    await selectOccurrence('slot-1')
    await act(async () => { fireEvent.change(document.querySelector('#ev-bk-message')!, { target: { value: '戻った開催回への案内です' } }) })
    apiMocks.previewOccurrenceBroadcast.mockResolvedValueOnce({ broadcastId: 'fresh-A', recipientCount: 2 })
    await click(buttonByText(view.container, '対象と内容を確認'))
    expect(view.container.textContent).toContain('2 人に送りますか')

    // 1回目の古い応答が今返っても、最新のAの対象を置き換えない。
    oldPreview.resolve({ broadcastId: 'obsolete-A', recipientCount: 97 })
    await flush()
    expect(view.container.textContent).not.toContain('97 人に送りますか')
    expect(view.container.textContent).toContain('2 人に送りますか')
    expect(apiMocks.sendOccurrenceBroadcast).not.toHaveBeenCalled()
  })

  it('古いAの後片付けで処理中のBの操作中表示を消さない', async () => {
    apiMocks.listOccurrenceSelector.mockResolvedValue({
      items: [
        { id: 'slot-1', starts_at: '2099-06-01T01:00:00.000Z', ends_at: '2099-06-01T02:00:00.000Z', is_active: 1 },
        { id: 'slot-2', starts_at: '2099-06-08T01:00:00.000Z', ends_at: '2099-06-08T02:00:00.000Z', is_active: 1 },
      ],
    })
    apiMocks.getOccurrenceApplicants.mockImplementation(async (_accountId: string, occurrenceId: string) => ({
      occurrence: { id: occurrenceId, eventId: 'event-1', startsAt: '2099-06-01T01:00:00.000Z', endsAt: '2099-06-01T02:00:00.000Z', capacity: 5, activeSeats: 1, version: 4 },
      summary: { bookingCount: 1, waitingCount: 0, activeSeats: 1 },
      snapshotId: `snapshot-${occurrenceId}`, snapshotExpiresAt: '2099-06-01T00:15:00.000Z',
      applicants: [],
    }))
    const oldPreview = deferred<{ broadcastId: string; recipientCount: number }>()
    const freshPreview = deferred<{ broadcastId: string; recipientCount: number }>()
    apiMocks.previewOccurrenceBroadcast.mockReturnValueOnce(oldPreview.promise).mockReturnValueOnce(freshPreview.promise)
    const view = await mount(<EventBookingsPage />)
    const message = elements(view.container).find((element) => (
      element.tagName === 'INPUT' && element.id === 'ev-bk-message'
    ))!
    await act(async () => {
      const onChange = propsOf(message).onChange as (event: { target: { value: string } }) => void
      onChange({ target: { value: '開催回のご案内です' } })
    })
    await flush()
    await click(buttonByText(view.container, '対象と内容を確認'))
    const selector = elements(view.container).find((element) => (
      element.tagName === 'SELECT' && element.getAttribute('aria-label') === '開催回を選ぶ'
    ))!
    await act(async () => {
      fireEvent.change(selector, { target: { value: 'slot-2' } })
    })
    await flush()
    await act(async () => { fireEvent.change(document.querySelector('#ev-bk-message')!, { target: { value: '新しい開催回への案内です' } }) })
    await click(buttonByText(view.container, '対象と内容を確認'))
    expect(propsOf(buttonByText(view.container, '対象と内容を確認')).disabled).toBe(true)

    // 古いAの応答が返っても、Bの処理中表示は残る。
    oldPreview.resolve({ broadcastId: 'old-A', recipientCount: 97 })
    await flush()
    expect(propsOf(buttonByText(view.container, '対象と内容を確認')).disabled).toBe(true)
    freshPreview.resolve({ broadcastId: 'new-B', recipientCount: 2 })
    await flush()
    expect(view.container.textContent).toContain('2 人に送りますか')
    expect(view.container.textContent).not.toContain('97 人に送りますか')
    expect(apiMocks.sendOccurrenceBroadcast).not.toHaveBeenCalled()
  })

  it('同じ行を連打しても更新は1回だけ送る', async () => {
    const pending = deferred<{ ok: true }>()
    apiMocks.listBookings.mockResolvedValue({ items: [booking('booking-a', '青木さん')], total: 1 })
    apiMocks.updateBooking.mockReturnValue(pending.promise)
    const view = await mount(<EventBookingsPage />)
    const button = actionButton(view.container, 'booking-a', 'attended')
    await act(async () => {
      button.click()
      button.click()
    })
    await flush()

    expect(apiMocks.updateBooking).toHaveBeenCalledTimes(1)
    expect(propsOf(actionButton(view.container, 'booking-a', 'attended')).disabled).toBe(true)
    pending.resolve({ ok: true })
    await flush()
  })

  it('別行は並行更新でき、一方の成功で他方の失敗を消さない', async () => {
    const first = deferred<{ ok: true }>()
    const second = deferred<{ ok: true }>()
    apiMocks.listBookings.mockResolvedValue({
      items: [booking('booking-a', '青木さん'), booking('booking-b', '井上さん')],
      total: 2,
    })
    apiMocks.updateBooking.mockImplementation((_accountId: string, _eventId: string, id: string) => (
      id === 'booking-a' ? first.promise : second.promise
    ))
    const view = await mount(<EventBookingsPage />)

    await click(actionButton(view.container, 'booking-a', 'attended'))
    await click(actionButton(view.container, 'booking-b', 'no_show'))
    expect(apiMocks.updateBooking).toHaveBeenCalledTimes(2)

    first.reject(new Error('late failure'))
    await flush()
    expect(view.container.textContent).toContain('来場・不参加の記録を変えられませんでした。')

    second.resolve({ ok: true })
    await flush()
    expect(view.container.textContent).toContain('来場・不参加の記録を変えられませんでした。')
  })

  it('切替前の遅延失敗は、切替後の同じ行の成功表示を上書きしない', async () => {
    const oldFailure = deferred<{ ok: true }>()
    const newSuccess = deferred<{ ok: true }>()
    apiMocks.listBookings.mockImplementation(() => Promise.resolve({
      items: [booking('booking-a', accountMock.selectedAccountId === 'account-a' ? '青木さん' : '井上さん')],
      total: 1,
    }))
    apiMocks.updateBooking.mockImplementation((accountId: string) => (
      accountId === 'account-a' ? oldFailure.promise : newSuccess.promise
    ))
    const view = await mount(<EventBookingsPage />)
    await click(actionButton(view.container, 'booking-a', 'attended'))

    accountMock.selectedAccountId = 'account-b'
    await view.rerender(<EventBookingsPage />)
    await click(actionButton(view.container, 'booking-a', 'attended'))
    newSuccess.resolve({ ok: true })
    await flush()
    oldFailure.reject(new Error('old delayed failure'))
    await flush()

    expect(apiMocks.updateBooking).toHaveBeenCalledTimes(2)
    expect(view.container.textContent).not.toContain('来場・不参加の記録を変えられませんでした。')
  })

  it('切替前に押した成功が後から返っても、切替後の画面へ前のアカウントの予約・件数を入れない', async () => {
    const oldSuccess = deferred<{ ok: true }>()
    // 同じ予約IDを両方に置き、行の書き換えが混ざるかどうかまで見る。
    apiMocks.listBookings.mockImplementation((accountId: string) => Promise.resolve({
      items: [booking('booking-a', accountId === 'account-a' ? '青木さん' : '井上さん')],
      total: 1,
    }))
    apiMocks.getEvent.mockImplementation((accountId: string) => Promise.resolve({
      id: 'event-1',
      name: accountId === 'account-a' ? '相談会A' : '相談会B',
      waitlist_enabled: 1,
    }))

    const originalApplicants = await apiMocks.getOccurrenceApplicants.getMockImplementation()!('account-a', 'slot-1')
    apiMocks.getOccurrenceApplicants.mockImplementation((accountId: string) => Promise.resolve({ ...originalApplicants, summary: { ...originalApplicants.summary, requestedSeats: accountId === 'account-a' ? 7 : 0 } }))
    apiMocks.updateBooking.mockReturnValue(oldSuccess.promise)

    const view = await mount(<EventBookingsPage />)
    await click(actionButton(view.container, 'booking-a', 'attended'))
    expect(apiMocks.updateBooking).toHaveBeenCalledTimes(1)
    expect(apiMocks.updateBooking.mock.calls[0][0]).toBe('account-a')

    accountMock.selectedAccountId = 'account-b'
    await view.rerender(<EventBookingsPage />)
    expect(view.container.textContent).toContain('井上さん')
    expect(view.container.textContent).toContain('相談会B')

    const callsFor = (mock: { mock: { calls: unknown[][] } }, accountId: string) => (
      mock.mock.calls.filter((call) => call[0] === accountId).length
    )
    const before = {
      list: callsFor(apiMocks.listBookings, 'account-a'),
      event: callsFor(apiMocks.getEvent, 'account-a'),
      summary: callsFor(apiMocks.getOccurrenceApplicants, 'account-a'),
    }

    // ここでようやく旧アカウントの更新が成功で返る。
    oldSuccess.resolve({ ok: true })
    await flush()

    // 前のアカウントの取り直しも集計も走らせない。
    expect(callsFor(apiMocks.listBookings, 'account-a')).toBe(before.list)
    expect(callsFor(apiMocks.getEvent, 'account-a')).toBe(before.event)
    expect(callsFor(apiMocks.getOccurrenceApplicants, 'account-a')).toBe(before.summary)
    // 画面はBのまま。Aの予約者・イベント名・承認待ち件数を出さない。
    expect(view.container.textContent).toContain('井上さん')
    expect(view.container.textContent).not.toContain('青木さん')
    expect(view.container.textContent).toContain('相談会B')
    expect(view.container.textContent).not.toContain('相談会A')
    expect(view.container.textContent).toContain('承認待ち 0人')
    expect(view.container.textContent).not.toContain('承認待ち 7人')
    // Bの行を勝手に参加済へ書き換えない（書き換わると操作ボタンが消える）。
    expect(() => actionButton(view.container, 'booking-a', 'attended')).not.toThrow()
    expect(propsOf(actionButton(view.container, 'booking-a', 'attended')).disabled).toBe(false)
    expect(view.container.textContent).not.toContain('来場・不参加の記録を変えられませんでした。')
  })

  it('切替の描画が確定した直後、後片付けが走る前にAの成功が返っても混ざらない', async () => {
    const oldSuccess = deferred<{ ok: true }>()
    apiMocks.listBookings.mockImplementation((accountId: string) => Promise.resolve({
      items: [booking('booking-a', accountId === 'account-a' ? '青木さん' : '井上さん')],
      total: 1,
    }))
    apiMocks.getEvent.mockImplementation((accountId: string) => Promise.resolve({
      id: 'event-1',
      name: accountId === 'account-a' ? '相談会A' : '相談会B',
      waitlist_enabled: 1,
    }))

    const originalApplicants = await apiMocks.getOccurrenceApplicants.getMockImplementation()!('account-a', 'slot-1')
    apiMocks.getOccurrenceApplicants.mockImplementation((accountId: string) => Promise.resolve({ ...originalApplicants, summary: { ...originalApplicants.summary, requestedSeats: accountId === 'account-a' ? 7 : 0 } }))
    apiMocks.updateBooking.mockReturnValue(oldSuccess.promise)

    const view = await mount(<EventBookingsPage />)
    await click(actionButton(view.container, 'booking-a', 'attended'))
    expect(apiMocks.updateBooking).toHaveBeenCalledTimes(1)

    const callsFor = (mock: { mock: { calls: unknown[][] } }, accountId: string) => (
      mock.mock.calls.filter((call) => call[0] === accountId).length
    )
    const before = {
      list: callsFor(apiMocks.listBookings, 'account-a'),
      event: callsFor(apiMocks.getEvent, 'account-a'),
      summary: callsFor(apiMocks.getOccurrenceApplicants, 'account-a'),
    }

    /*
      Bの描画を確定させたその場で、まだ後片付けが動いていないうちに
      旧Aの更新が成功で返る。失効が描画の時点で効いていないと、
      ここで旧Aの宛先が「今の宛先」と読まれる。
    */
    accountMock.selectedAccountId = 'account-b'
    await view.commitThen(<EventBookingsPage />, () => {
      oldSuccess.resolve({ ok: true })
    })

    expect(callsFor(apiMocks.listBookings, 'account-a')).toBe(before.list)
    expect(callsFor(apiMocks.getEvent, 'account-a')).toBe(before.event)
    expect(callsFor(apiMocks.getOccurrenceApplicants, 'account-a')).toBe(before.summary)
    expect(view.container.textContent).toContain('井上さん')
    expect(view.container.textContent).not.toContain('青木さん')
    expect(view.container.textContent).toContain('相談会B')
    expect(view.container.textContent).not.toContain('相談会A')
    expect(view.container.textContent).toContain('承認待ち 0人')
    expect(view.container.textContent).not.toContain('承認待ち 7人')
    expect(() => actionButton(view.container, 'booking-a', 'attended')).not.toThrow()
    expect(propsOf(actionButton(view.container, 'booking-a', 'attended')).disabled).toBe(false)
    expect(view.container.textContent).not.toContain('来場・不参加の記録を変えられませんでした。')
  })

  it('切り替えて戻ったあとの押し直しを、前の応答が終わらせない', async () => {
    const stale = deferred<{ ok: true }>()
    const fresh = deferred<{ ok: true }>()
    let updateCalls = 0
    apiMocks.listBookings.mockImplementation((accountId: string) => Promise.resolve({
      items: [booking('booking-a', accountId === 'account-a' ? '青木さん' : '井上さん')],
      total: 1,
    }))
    apiMocks.updateBooking.mockImplementation(() => {
      updateCalls += 1
      return updateCalls === 1 ? stale.promise : fresh.promise
    })

    const view = await mount(<EventBookingsPage />)
    await click(actionButton(view.container, 'booking-a', 'attended'))

    accountMock.selectedAccountId = 'account-b'
    await view.rerender(<EventBookingsPage />)
    accountMock.selectedAccountId = 'account-a'
    await view.rerender(<EventBookingsPage />)

    // 切替で世代が変わったので、同じ行をもう一度押せる。
    expect(propsOf(actionButton(view.container, 'booking-a', 'attended')).disabled).toBe(false)
    await click(actionButton(view.container, 'booking-a', 'attended'))
    expect(updateCalls).toBe(2)

    // 前の世代の応答は、今の「記録中…」を解かない。
    stale.resolve({ ok: true })
    await flush()
    expect(propsOf(actionButton(view.container, 'booking-a', 'attended')).disabled).toBe(true)

    fresh.resolve({ ok: true })
    await flush()
    expect(view.container.textContent).not.toContain('来場・不参加の記録を変えられませんでした。')
  })


})

// 選ぶ物の欄も、保存/API境界の試験では以前のSelectと同じ差し替えにする。
vi.mock('@/components/shared/entity-select', () => import('@/test-utils/entity-select-mock'))
