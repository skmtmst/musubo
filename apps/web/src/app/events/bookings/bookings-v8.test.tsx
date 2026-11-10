// @vitest-environment happy-dom
/*
 * ★V8-B イベント予約の「申込者」（板 ）。
 * 開催回ごとの見せ方で、承認・拒否・キャンセル・受付・待ち・CSV・
 * お知らせの口が同じように動くこと。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readUiSource as readFileSync } from '../../../../scripts/test-ui-source.mjs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'

const getEvent = vi.hoisted(() => vi.fn())
const listBookings = vi.hoisted(() => vi.fn())
const getBookingSummary = vi.hoisted(() => vi.fn())
const listOccurrenceSelector = vi.hoisted(() => vi.fn())
const getOccurrenceApplicants = vi.hoisted(() => vi.fn())
const decideBooking = vi.hoisted(() => vi.fn())
const adminCancelBooking = vi.hoisted(() => vi.fn())
const updateBooking = vi.hoisted(() => vi.fn())
const promoteOccurrenceWaitlist = vi.hoisted(() => vi.fn())
const skipOccurrenceWaitlist = vi.hoisted(() => vi.fn())
const previewOccurrenceBroadcast = vi.hoisted(() => vi.fn())
const downloadOccurrenceApplicantsCsv = vi.hoisted(() => vi.fn())
const broadcastsSend = vi.hoisted(() => vi.fn())
const account = vi.hoisted(() => ({ id: 'acc-1' }))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      broadcasts: { ...actual.api.broadcasts, send: broadcastsSend },
      staff: { ...actual.api.staff, me: vi.fn().mockResolvedValue({ success: true, data: { id: 'me', role: 'owner', isActive: true } }) },
    },
    eventsApi: {
      ...actual.eventsApi,
      getEvent,
      listBookings,
      getBookingSummary,
      listOccurrenceSelector,
      getOccurrenceApplicants,
      decideBooking,
      adminCancelBooking,
      updateBooking,
      promoteOccurrenceWaitlist,
      skipOccurrenceWaitlist,
      previewOccurrenceBroadcast,
      downloadOccurrenceApplicantsCsv,
    },
  }
})

vi.mock('next/link', () => ({
  default: ({ children, ...p }: { children?: React.ReactNode } & Record<string, unknown>) => (
    <a {...(p as React.AnchorHTMLAttributes<HTMLAnchorElement>)}>{children}</a>
  ),
}))

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), useSearchParams: () => new URLSearchParams('id=e1') }))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: account.id,
    accounts: [{ id: 'acc-1', role: 'owner' }],
  }),
}))

vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(),
  usePageTitle: () => {},
}))

import BookingsV8 from '@/v8/events/bookings'
import BookingsPage from './page'

const v8css = readFileSync(join(process.cwd(), 'src/v8/events/bookings.module.css'), 'utf8')
const v8tsx = readFileSync(join(process.cwd(), 'src/v8/events/bookings.tsx'), 'utf8')

function applicant(over: Record<string, unknown>) {
  return {
    source: 'booking',
    id: 'b1',
    friendId: 'f1',
    displayName: '見本 141',
    pictureUrl: null,
    status: 'requested',
    partySize: 1,
    appliedAt: '2026-10-01T00:00:00.000Z',
    answers: null,
    firstParticipation: { isFirst: true, attendedCount: 0, checkedAt: null },
    offeredAt: null,
    offerExpiresAt: '2026-10-03T03:00:00.000Z',
    ...over,
  }
}

function applicantsPayload() {
  return {
    occurrence: {
      id: 'slot-1',
      eventId: 'e1',
      startsAt: '2026-10-12T05:00:00.000Z',
      endsAt: '2026-10-12T07:00:00.000Z',
      capacity: 20,
      activeSeats: 18,
      version: 2,
    },
    summary: {
      bookingCount: 5,
      waitingCount: 1,
      activeSeats: 18,
      confirmedSeats: 16,
      requestedSeats: 2,
      waitingSeats: 2,
      offeredSeats: 1,
      remainingSeats: 2,
    },
    applicants: [
      applicant({ id: 'b1', status: 'requested' }),
      applicant({ id: 'b2', displayName: '見本 169', status: 'confirmed', offerExpiresAt: null, firstParticipation: { isFirst: false, attendedCount: 2, checkedAt: null } }),
      applicant({ source: 'waitlist', id: 'w1', displayName: '見本 182', status: 'offered', offerExpiresAt: '2026-10-02T12:00:00.000Z', appliedAt: '2026-09-28T01:12:00.000Z' }),
    ],
    waitlistHistory: [
      {
        id: 'h1',
        friendId: 'f9',
        status: 'cancelled',
        partySize: 1,
        createdAt: '2026-09-27T00:02:00.000Z',
        offeredAt: null,
        offerExpiresAt: null,
        notifiedAt: null,
        updatedAt: '2026-09-29T13:15:00.000Z',
        displayName: '見本 14',
        convertedBookingId: null,
      },
    ],
    attendance: { attendedSeats: 9, noShowSeats: 1, entries: [] },
    snapshotId: 'snap-1',
    snapshotExpiresAt: '2099-01-01T00:00:00.000Z',
  }
}

let host: HTMLDivElement
let root: Root

function bookingPrimaryAction(id: string, action: string): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>(`[data-booking-id="${id}"][data-booking-action="${action}"]`)
  if (!button) throw new Error(`primary action not found: ${id}/${action}`)
  return button
}

beforeEach(() => {
  account.id = 'acc-1'
  document.documentElement.dataset.theme = 'v8'
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  getEvent.mockReset()
  listBookings.mockReset().mockResolvedValue({ items: [], total: 0 })
  getBookingSummary.mockReset().mockResolvedValue({ requested: 0, confirmed: 1, cancelled: 0, totalCapacity: 20 })
  listOccurrenceSelector.mockReset()
  getOccurrenceApplicants.mockReset()
  decideBooking.mockReset()
  updateBooking.mockReset()
  broadcastsSend.mockReset()
  previewOccurrenceBroadcast.mockReset()
  skipOccurrenceWaitlist.mockReset().mockResolvedValue({ success: true })
  getEvent.mockResolvedValue({ id: 'e1', name: '秋のしつけ教室', venue_name: '渋谷ベース 3F', is_published: 1, version: 3 })
  listOccurrenceSelector.mockResolvedValue({
    items: [{ id: 'slot-1', starts_at: '2026-10-12T05:00:00.000Z', ends_at: '2026-10-12T07:00:00.000Z', capacity: 20, is_active: 1 }],
  })
  getOccurrenceApplicants.mockResolvedValue(applicantsPayload())
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  document.body.innerHTML = ''
  delete document.documentElement.dataset.theme
})

async function flush() {
  await act(async () => {
    for (let step = 0; step < 10; step += 1) await Promise.resolve()
  })
}

async function renderV8() {
  await act(async () => { root.render(<BookingsV8 />) })
  await flush()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function prepareMessage(value: string) {
  const input = document.querySelector<HTMLInputElement>('#ev-bk-message')!
  await act(async () => { fireEvent.change(input, { target: { value } }) })
  const send = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '送る')!
  return send
}

describe('V8-B 申込者（Mu8qW）', () => {
  it('全回の件数は読み込み失敗を0にせず、件数だけを再取得する', async () => {
    getBookingSummary.mockRejectedValueOnce(new Error('offline'))
    await renderV8()
    const details = host.querySelector('details')!
    await act(async () => { details.open = true; fireEvent(details, new Event('toggle')) })
    await flush()
    expect(details.textContent).toContain('全開催回の件数を読み込めませんでした')
    expect(details.textContent).not.toContain('全開催回：承認待ち 0件')
    await act(async () => { [...details.querySelectorAll('button')].find((button) => button.textContent === '件数を読み直す')!.click() })
    await flush()
    expect(getBookingSummary).toHaveBeenCalledTimes(2)
    expect(listBookings).toHaveBeenCalledTimes(1)
    expect(details.textContent).toContain('全開催回：承認待ち 0件・確定 1件')
  })

  it('記録の状態切替は1ページ目へ戻り、全回の集計と開催回の申込者を取り直さない', async () => {
    listBookings.mockResolvedValue({ items: [{ id: 'r1', friend_id: 'f1', friend_display_name: '記録の人', status: 'confirmed' }], total: 21 })
    await renderV8()
    const details = host.querySelector('details')!
    await act(async () => { details.open = true; fireEvent(details, new Event('toggle')) })
    await flush()
    await act(async () => { details.querySelector<HTMLButtonElement>('[aria-label="次のページ"]')!.click() })
    await flush()
    expect(listBookings).toHaveBeenLastCalledWith('acc-1', 'e1', expect.objectContaining({ page: 2 }))
    await act(async () => { details.querySelector<HTMLButtonElement>('button[aria-label="申込記録の状態"]')!.click() })
    await flush()
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((element) => element.textContent?.trim() === '無断')!
    await act(async () => { option.querySelector('button')!.click() })
    await flush()
    expect(listBookings).toHaveBeenLastCalledWith('acc-1', 'e1', { status: 'no_show', slot_id: 'slot-1', page: 1, limit: 20 })
    expect(getBookingSummary).toHaveBeenCalledTimes(1)
    expect(getEvent).toHaveBeenCalledTimes(1)
    expect(getOccurrenceApplicants).toHaveBeenCalledTimes(1)
  })

  it('店の切替前の全回集計が遅れて届いても、新しい店へ件数を混ぜない', async () => {
    const old = deferred<unknown>()
    getBookingSummary.mockReturnValueOnce(old.promise).mockResolvedValue({ requested: 3, confirmed: 4, cancelled: 0, totalCapacity: 20 })
    await renderV8()
    let details = host.querySelector('details')!
    await act(async () => { details.open = true; fireEvent(details, new Event('toggle')) })
    await flush()
    account.id = 'acc-2'
    await renderV8()
    details = host.querySelector('details')!
    await act(async () => { details.open = true; fireEvent(details, new Event('toggle')) })
    await flush()
    await act(async () => { old.resolve({ requested: 97, confirmed: 1, totalCapacity: 20 }) })
    await flush()
    expect(details.textContent).toContain('全開催回：承認待ち 3件・確定 4件')
    expect(details.textContent).not.toContain('承認待ち 97件')
  })

  it('受付前は確定の人数で数え、記録済みの人数を二度引かない', async () => {
    await renderV8()
    const summary = host.querySelector('[aria-label="当日の受付"]')!
    expect(summary.textContent).toContain('参加済 9人')
    expect(summary.textContent).toContain('無断欠席 1人')
    expect(summary.textContent).toContain('受付前 16人')
  })

  it('詳細で席を消費する案内人数と当日受付を確認し、旧応答の未取得を0と混ぜない', async () => {
    const payload = applicantsPayload()
    getOccurrenceApplicants.mockResolvedValue({ ...payload, summary: { bookingCount: 2, waitingCount: 1, activeSeats: 18 }, applicants: [...payload.applicants, applicant({ source: 'waitlist', id: 'w2', status: 'accepted', partySize: 3 })], attendance: undefined, waitlistHistory: undefined })
    await renderV8()
    const details = host.querySelector('details')!
    await act(async () => { details.open = true; fireEvent(details, new Event('toggle')) })
    await flush()
    expect(details.textContent).toContain('案内中 4人')
    expect(details.textContent).toContain('残席 2席（定員 20人）')
    expect(details.textContent).toContain('受付の記録はまだ読み込めていません')
    expect(details.textContent).toContain('履歴はまだ読み込めていません')
    expect(host.querySelector('[aria-label="当日の受付"]')?.textContent).toContain('参加済 —人')
  })

  it('記録の参加印は既存APIへ送り、成功した後に記録と通知予定を読み直す', async () => {
    listBookings.mockResolvedValue({ items: [{ id: 'r1', friend_id: 'f1', friend_display_name: '過去の記録', status: 'confirmed' }], total: 1 })
    updateBooking.mockResolvedValue({ ok: true })
    await renderV8()
    const details = host.querySelector('details')!
    await act(async () => { details.open = true; fireEvent(details, new Event('toggle')) })
    await flush()
    const button = bookingPrimaryAction('r1', 'attended')
    await act(async () => { button.click() })
    await flush()
    expect(updateBooking).toHaveBeenCalledWith('acc-1', 'e1', 'r1', { status: 'attended' })
    expect(listBookings).toHaveBeenCalledTimes(2)
    expect(getOccurrenceApplicants).toHaveBeenCalledTimes(2)
  })

  it('待ちの見送りは理由なしでは押せず、理由を記録して最後尾へ回す', async () => {
    const payload = applicantsPayload()
    getOccurrenceApplicants.mockResolvedValue({ ...payload, applicants: [applicant({ source: 'waitlist', id: 'w1', status: 'waiting' })] })
    await renderV8()
    const details = host.querySelector('details')!
    await act(async () => { details.open = true; fireEvent(details, new Event('toggle')) })
    await flush()
    await act(async () => { [...details.querySelectorAll('button')].find((button) => button.textContent === '見送る')!.click() })
    await flush()
    const dialog = document.querySelector('[role="dialog"]')!
    expect(skipOccurrenceWaitlist).not.toHaveBeenCalled()
    expect([...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '実行する')!.disabled).toBe(true)
    await act(async () => { fireEvent.change(dialog.querySelector('textarea')!, { target: { value: '本人から後回しの希望' } }) })
    await act(async () => { [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '実行する')!.click() })
    await flush()
    expect(skipOccurrenceWaitlist).toHaveBeenCalledWith('acc-1', 'slot-1', { waitlist_id: 'w1', expectedVersion: 2, reason: '本人から後回しの希望' })
  })

  it('開いた申込記録で回答と通知の予定・結果を同じ予約に出す', async () => {
    getEvent.mockResolvedValue({ id: 'e1', name: '秋のしつけ教室', questions_json: JSON.stringify([{ id: 'food', label: '好きな食べ物', type: 'text', required: false }]) })
    listBookings.mockResolvedValue({ items: [{ id: 'record-1', friend_id: 'f1', friend_display_name: '記録の太郎', status: 'attended', requested_at: '2026-10-01T00:00:00Z', slot_starts_at: '2026-10-12T05:00:00Z', answer_snapshot_json: JSON.stringify({ food: 'りんご' }), customer_note: '椅子を希望', companion_note: '家族1人', reminders: ['pending', 'sent', 'cancelled', 'failed', 'failed_permanent'].map((status) => ({ kind: status === 'pending' ? 'day_before' : 'hours_before', scheduled_at: '2026-10-11T03:00:00Z', status })) }], total: 1 })
    await renderV8()
    expect(listBookings).not.toHaveBeenCalled()
    const details = host.querySelector('details')!
    await act(async () => { details.open = true; fireEvent(details, new Event('toggle')) })
    await flush()
    expect(listBookings).toHaveBeenCalledWith('acc-1', 'e1', { slot_id: 'slot-1', status: undefined, page: 1, limit: 20 })
    expect(details.textContent).toContain('好きな食べ物りんご')
    expect(details.textContent).toContain('備考：椅子を希望')
    expect(details.textContent).toContain('同行者：家族1人')
    const reminders = details.querySelector('[data-booking-reminders="record-1"]')!
    expect(reminders.querySelectorAll('li')).toHaveLength(5)
    for (const label of ['前日のお知らせ', '開始前のお知らせ', '送信予定', '送信済み', '停止済み', '失敗', '12:00']) expect(reminders.textContent).toContain(label)
    expect(details.querySelector('[aria-label="申込記録"] a')?.getAttribute('href')).toBe('/chats?friend=f1')
  })

  it('申込記録の失敗を空と混ぜず、開き直すと読み直せる', async () => {
    listBookings.mockRejectedValueOnce(new Error('offline'))
    await renderV8()
    const details = host.querySelector('details')!
    await act(async () => { details.open = true; fireEvent(details, new Event('toggle')) })
    await flush()
    expect(details.textContent).toContain('申込記録を読み込めませんでした')
    expect(details.textContent).not.toContain('この状態の申込記録はありません')
    await act(async () => { [...details.querySelectorAll('button')].find((button) => button.textContent === '開き直す')!.click() })
    await flush()
    expect(listBookings).toHaveBeenCalledTimes(2)
    expect(details.textContent).toContain('この状態の申込記録はありません')
  })

  it('申込記録のページを進めても前の応答を混ぜず、閉じた後の返事も使わない', async () => {
    const oldPage = deferred<{ items: unknown[]; total: number }>()
    listBookings.mockResolvedValueOnce({ items: [{ id: 'r1', friend_id: 'f1', friend_display_name: '1ページ目の人', status: 'confirmed' }], total: 21 }).mockImplementationOnce(() => oldPage.promise)
    await renderV8()
    const details = host.querySelector('details')!
    await act(async () => { details.open = true; fireEvent(details, new Event('toggle')) })
    await flush()
    await act(async () => { details.querySelector<HTMLButtonElement>('[aria-label="次のページ"]')!.click() })
    await flush()
    expect(listBookings).toHaveBeenLastCalledWith('acc-1', 'e1', expect.objectContaining({ page: 2, slot_id: 'slot-1' }))
    expect(details.textContent).not.toContain('1ページ目の人')
    await act(async () => { details.open = false; fireEvent(details, new Event('toggle')) })
    await act(async () => { oldPage.resolve({ items: [{ id: 'late', friend_display_name: '遅い記録' }], total: 21 }) })
    await flush()
    expect(details.textContent).not.toContain('遅い記録')
    expect(details.querySelector('[role="table"]')).toBeNull()
  })

  it('開催回の見せ方で数と表が出る', async () => {
    await act(async () => { root.render(<BookingsPage />) })
    await flush()
    expect(document.querySelector('[data-design-node="Mu8qW"]'), '板IDの枠がある').toBeTruthy()
    expect(document.body.textContent).toContain('秋のしつけ教室')
    expect(document.body.textContent).toContain('申込者')
    expect(document.body.textContent).toContain('キャンセル待ち')
    expect(document.body.textContent).toContain('キャンセル')
    expect(document.body.textContent).toContain('お知らせを送る')
    expect(document.body.textContent).toContain('初参加')
    expect(document.body.textContent).toContain('過去のイベント参加あり')
    expect(document.body.textContent).toContain('見本 14')
    expect(host.querySelector('[data-page-template="detail"] [data-template-region="content"]')?.textContent).toContain('見本 14')
  })

  it('開催回の入口は曜日と時刻を1つのボタンで示し、選ぶ窓を開ける', async () => {
    await renderV8()
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="開催回を選ぶ"]')!
    expect(trigger).toBeTruthy()
    expect(trigger.parentElement?.textContent).toBe('開催回：10/12（月） 14:00')
    await act(async () => { trigger.click() })
    await flush()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('10/12（月） 14:00')
  })

  it('承認すると確定の口を叩く', async () => {
    decideBooking.mockResolvedValue({})
    await renderV8()
    const approve = [...document.querySelectorAll('button')].find((b) => b.textContent === '承認する')
    expect(approve, '承認する口がある').toBeTruthy()
    const applicantRow = [...document.querySelectorAll<HTMLElement>('[role="row"]')].find((row) => row.textContent?.includes('見本 141'))!
    expect(applicantRow.querySelectorAll('button')).toHaveLength(2)
    const more = applicantRow.querySelector<HTMLButtonElement>('[data-row-menu]')!
    await act(async () => { more.click() })
    await flush()
    expect(document.querySelector('[role="menuitem"]')?.textContent?.trim()).toBe('断る')
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(bookingPrimaryAction('b2', 'attended').textContent).toContain('参加済にする')
    const confirmedMenu = host.querySelector<HTMLButtonElement>('[data-booking-id="b2"][data-booking-action="menu"]')!
    await act(async () => { confirmedMenu.click() })
    await flush()
    const confirmedItems = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.textContent?.trim())
    expect(confirmedItems).toContain('無断')
    expect(confirmedItems).toContain('キャンセルにする')
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(bookingPrimaryAction('w1', 'promote').textContent).toContain('予約に繰上げ')
    expect(host.querySelector('[data-booking-id="w1"][data-booking-action="menu"]')).toBeTruthy()
    await act(async () => { approve!.click() })
    await flush()
    expect(decideBooking).toHaveBeenCalledWith('acc-1', 'e1', 'b1', 'confirm', undefined)
  })

  it('お知らせは対象を確かめてから送る', async () => {
    previewOccurrenceBroadcast.mockResolvedValue({ broadcastId: 'bc-1', recipientCount: 5 })
    broadcastsSend.mockResolvedValue({})
    await renderV8()
    const input = document.querySelector('#ev-bk-message') as HTMLInputElement
    const disabledSend = [...document.querySelectorAll('button')].find((b) => b.textContent === '送る')!
    expect(disabledSend.disabled).toBe(true)
    expect(disabledSend.querySelector('svg.lucide-send')).toBeTruthy()
    expect(disabledSend.title).toBe('メッセージを入力してください')
    await act(async () => {
      fireEvent.change(input, { target: { value: '当日は動きやすい服装でお越しください' } })
    })
    await flush()
    const send = [...document.querySelectorAll('button')].find((b) => b.textContent === '送る')
    expect(send!.title).toBe('')
    await act(async () => { send!.click() })
    await flush()
    expect(previewOccurrenceBroadcast, '対象の確定を叩く').toHaveBeenCalled()
    const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]')
    expect(dialog, '送る前の確認窓が出る').toBeTruthy()
    expect(dialog?.textContent).toContain('5 人に送りますか')
    expect(broadcastsSend).not.toHaveBeenCalled()
    const confirm = [...dialog!.querySelectorAll('button')].find((b) => b.textContent === '送る')
    await act(async () => { confirm!.click() })
    await flush()
    expect(broadcastsSend, '送信を叩く').toHaveBeenCalledWith('bc-1')
  })

  it('V8 の型・色直書きなし・準備中なしを守る', () => {
    expect(v8tsx).toContain("import { DetailPage } from '@/components/templates'")
    expect(v8css).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    // 影は共通のカードの影だけ（2026-10-09 オーナー採用 ）。ほかの影は直書きしない。
    expect(v8css.replace(/box-shadow:\s*var\(--card-shadow\)/g, '')).not.toMatch(/box-shadow\s*:/)
    expect(v8tsx).toContain('boardId="Mu8qW"')
    expect(v8tsx).not.toContain('準備中')
  })

  it('前の店の遅いイベント名は切替後の名前を置き換えない', async () => {
    const old = deferred<unknown>()
    getEvent.mockReturnValueOnce(old.promise)
    await renderV8()
    account.id = 'acc-2'
    getEvent.mockResolvedValue({ id: 'e1', name: 'Bの相談会' })
    await renderV8()
    old.resolve({ id: 'e1', name: '古いAの相談会' })
    await flush()
    expect(document.body.textContent).toContain('Bの相談会')
    expect(document.body.textContent).not.toContain('古いAの相談会')
  })

  it('一度の描画中に対象確認を二重押ししても要求は一度だけ', async () => {
    const pending = deferred<{ broadcastId: string; recipientCount: number }>()
    previewOccurrenceBroadcast.mockReturnValue(pending.promise)
    await renderV8()
    const send = await prepareMessage('ご案内します')
    await act(async () => { send.click(); send.click() })
    expect(previewOccurrenceBroadcast).toHaveBeenCalledTimes(1)
    pending.resolve({ broadcastId: 'bc-1', recipientCount: 5 })
    await flush()
    const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]')!
    expect(dialog.textContent).toContain('5 人に送りますか')
  })

  it('店を切り替えて戻っても、古い送信対象が新しい確認を置き換えない', async () => {
    const old = deferred<{ broadcastId: string; recipientCount: number }>()
    previewOccurrenceBroadcast.mockReturnValueOnce(old.promise)
    await renderV8()
    const send = await prepareMessage('Aへ案内')
    await act(async () => { send.click() })
    account.id = 'acc-2'
    await renderV8()
    account.id = 'acc-1'
    await renderV8()
    previewOccurrenceBroadcast.mockResolvedValueOnce({ broadcastId: 'fresh', recipientCount: 2 })
    const fresh = await prepareMessage('新しいAへ案内')
    await act(async () => { fresh.click() })
    old.resolve({ broadcastId: 'old', recipientCount: 97 })
    await flush()
    expect(document.body.textContent).toContain('2 人に送りますか')
    expect(document.body.textContent).not.toContain('97 人に送りますか')
    expect(broadcastsSend).not.toHaveBeenCalled()
  })

  it('前の店の送信完了は切替後の未保存の文を消さない', async () => {
    const old = deferred<unknown>()
    previewOccurrenceBroadcast.mockResolvedValue({ broadcastId: 'bc-1', recipientCount: 2 })
    broadcastsSend.mockReturnValueOnce(old.promise)
    await renderV8()
    await act(async () => { (await prepareMessage('Aへ案内')).click() })
    const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]')!
    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '送る')!
    await act(async () => { confirm.click(); confirm.click() })
    expect(broadcastsSend).toHaveBeenCalledTimes(1)
    account.id = 'acc-2'
    await renderV8()
    await prepareMessage('Bの未保存の案内')
    old.resolve({ success: true })
    await flush()
    expect(document.querySelector<HTMLInputElement>('#ev-bk-message')!.value).toBe('Bの未保存の案内')
  })

  it('参加印の二重押しは一度だけ送り、戻った後の再操作は古い応答で終わらない', async () => {
    const old = deferred<unknown>()
    const fresh = deferred<unknown>()
    const payload = applicantsPayload()
    payload.applicants[0].status = 'confirmed'
    getOccurrenceApplicants.mockResolvedValue(payload)
    updateBooking.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    await renderV8()
    const initialMark = bookingPrimaryAction('b1', 'attended')
    await act(async () => { initialMark.click(); initialMark.click() })
    expect(updateBooking).toHaveBeenCalledTimes(1)
    account.id = 'acc-2'
    await renderV8()
    account.id = 'acc-1'
    await renderV8()
    expect(bookingPrimaryAction('b1', 'attended').disabled).toBe(false)
    await act(async () => { bookingPrimaryAction('b1', 'attended').click() })
    expect(updateBooking).toHaveBeenCalledTimes(2)
    old.resolve({ ok: true })
    await flush()
    expect(bookingPrimaryAction('b1', 'attended').disabled).toBe(true)
    fresh.resolve({ ok: true })
    await flush()
    expect(bookingPrimaryAction('b1', 'attended').disabled).toBe(false)
  })

  it('別の行の参加印は並行更新でき、成功の再読込で他方の失敗を消さない', async () => {
    const payload = applicantsPayload()
    payload.applicants[0].status = 'confirmed'
    getOccurrenceApplicants.mockResolvedValue(payload)
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    updateBooking.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    await renderV8()
    await act(async () => { bookingPrimaryAction('b1', 'attended').click() })
    await act(async () => { bookingPrimaryAction('b2', 'attended').click() })
    expect(updateBooking).toHaveBeenCalledTimes(2)
    second.reject(new Error('down'))
    await flush()
    first.resolve({ ok: true })
    await flush()
    expect(document.body.textContent).toContain('来場・不参加の記録を変えられませんでした')
  })
})
