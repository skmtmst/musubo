// @vitest-environment happy-dom
import { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { BookingRequest, BookingVisitMark } from '@/lib/api'
import PeopleDayList from '@/v8/booking-bookings/day-list'
import { usePeopleVisitMarks } from '@/v8/booking-bookings/use-visit-marks'

const fixture = vi.hoisted(() => ({
  mark: null as BookingVisitMark | null,
  getToday: vi.fn(), post: vi.fn(), unmark: vi.fn(), changed: vi.fn(), toast: vi.fn(),
}))
vi.mock('@/lib/api', () => ({ bookingApi: { getToday: fixture.getToday, postVisitMark: fixture.post, deleteVisitMark: fixture.unmark } }))
vi.mock('@/components/shared/toast', () => ({ notifyToast: fixture.toast }))
const row = { id: 'booking-1', starts_at: '2026-10-04T05:00:00.000Z', ends_at: '2026-10-04T06:00:00.000Z', status: 'confirmed', friend_name: '花子', menu_name: 'カット', staff_name: '太郎' } as BookingRequest

function Harness({ accountId = 'account-a', canMark = true }: { accountId?: string; canMark?: boolean }) {
  const visits = usePeopleVisitMarks(accountId, '2026-10-04', canMark, fixture.changed)
  return <PeopleDayList rows={[row]} canMark={canMark} visits={visits} onOpen={() => {}} />
}

beforeEach(() => {
  vi.clearAllMocks()
  fixture.mark = null
  fixture.getToday.mockImplementation(async () => ({ bookings: [{ id: row.id, visit_mark: fixture.mark }] }))
  fixture.post.mockImplementation(async (_account, _id, body) => {
    fixture.mark = { kind: body.kind, late_minutes: body.late_minutes ?? null, marked_at: '2026-10-04T05:00:00Z', marked_by_name: '店長' }
    return { status: body.kind === 'visited' ? 'completed' : 'confirmed', visit_mark: fixture.mark }
  })
  fixture.unmark.mockImplementation(async () => { fixture.mark = null; return { status: 'confirmed' } })
})
afterEach(cleanup)

async function mount() {
  const view = render(<Harness />)
  await waitFor(() => expect((screen.getByRole('button', { name: '来店した' }) as HTMLButtonElement).disabled).toBe(false))
  return view
}

test('来店したを押すと人の予約に印が付き、取消で戻して読み直す', async () => {
  await mount()
  fireEvent.click(screen.getByRole('button', { name: '来店した' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '取り消す' })).toBeTruthy())
  expect(fixture.post).toHaveBeenCalledWith('account-a', row.id, { kind: 'visited' })
  expect(fixture.changed).toHaveBeenCalledTimes(1)
  expect(fixture.getToday).toHaveBeenCalledWith('account-a', { date: '2026-10-04', mode: 'staff' })
  expect(fixture.toast).toHaveBeenCalledWith('来店しました', expect.objectContaining({ actionLabel: '元に戻す' }))
  fireEvent.click(screen.getByRole('button', { name: '取り消す' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: '取り消す' })).toBeNull())
  expect(fixture.unmark).toHaveBeenCalledWith('account-a', row.id)
  expect(fixture.changed).toHaveBeenCalledTimes(2)
})

test('来なかったは「…」の中から印を付ける', async () => {
  await mount()
  expect(screen.queryByRole('menuitem', { name: '来なかった' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'その他の操作' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '来なかった' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '取り消す' })).toBeTruthy())
  expect(fixture.post).toHaveBeenCalledWith('account-a', row.id, { kind: 'no_show' })
})

test('遅刻の分数を選べて、印を取り消せる', async () => {
  await mount()
  fireEvent.click(screen.getByRole('button', { name: '遅れる' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '15分' }))
  await waitFor(() => expect(screen.getByText('15分遅れる')).toBeTruthy())
  expect(fixture.post).toHaveBeenCalledWith('account-a', row.id, { kind: 'late', late_minutes: 15 })
  fireEvent.click(screen.getByRole('button', { name: 'その他の操作' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '印を取り消す' }))
  await waitFor(() => expect(screen.queryByText('15分遅れる')).toBeNull())
  expect(fixture.unmark).toHaveBeenCalledWith('account-a', row.id)
})

test('成功通知の元に戻すも人の印を取り消す', async () => {
  await mount()
  fireEvent.click(screen.getByRole('button', { name: '来店した' }))
  await waitFor(() => expect(fixture.toast).toHaveBeenCalled())
  const options = fixture.toast.mock.calls[0][1]
  await act(async () => options.onAction())
  expect(fixture.unmark).toHaveBeenCalledWith('account-a', row.id)
})

test('送信中の連打は1回だけ、失敗は印を変えず再試行できる', async () => {
  let reject!: (reason: unknown) => void
  fixture.post.mockImplementation(() => new Promise((_resolve, rejectRequest) => { reject = rejectRequest }))
  await mount()
  const button = screen.getByRole('button', { name: '来店した' })
  fireEvent.click(button); fireEvent.click(button)
  expect(fixture.post).toHaveBeenCalledTimes(1)
  await act(async () => reject(new Error('failed')))
  expect(fixture.mark).toBeNull()
  expect(fixture.changed).not.toHaveBeenCalled()
  expect(fixture.toast).toHaveBeenCalledWith(expect.stringContaining('変更できません'), expect.objectContaining({ tone: 'error' }))
  expect((screen.getByRole('button', { name: '来店した' }) as HTMLButtonElement).disabled).toBe(false)
})

test('アカウントを替えたら古い返事と通知を新しい画面へ出さない', async () => {
  let resolve!: (value: unknown) => void
  fixture.post.mockImplementation(() => new Promise(resolveRequest => { resolve = resolveRequest }))
  const view = await mount()
  fireEvent.click(screen.getByRole('button', { name: '来店した' }))
  view.rerender(<Harness accountId="account-b" />)
  await act(async () => resolve({ status: 'completed', visit_mark: { kind: 'visited', late_minutes: null } }))
  expect(fixture.post).toHaveBeenCalledWith('account-a', row.id, { kind: 'visited' })
  expect(fixture.changed).not.toHaveBeenCalled()
  expect(fixture.toast).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: '取り消す' })).toBeNull()
})

test('閲覧のみでは来店印を読みに行かず、操作は灰色で押せない', () => {
  render(<Harness canMark={false} />)
  for (const el of screen.queryAllByRole('button', { name: '来店した' })) expect(((el: HTMLElement) => el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled)(el)).toBe(true)
  expect(screen.queryByRole('button', { name: 'その他の操作' })).toBeNull()
  expect(fixture.getToday).not.toHaveBeenCalled()
})

test('来店印を取得できないときは未取得を印なしとして扱わず読み直せる', async () => {
  fixture.getToday.mockRejectedValueOnce(new Error('failed'))
  render(<Harness />)
  await screen.findByText('来店の印を読み込めませんでした。')
  expect((screen.getByRole('button', { name: '来店した' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '読み直す' }))
  await waitFor(() => expect((screen.getByRole('button', { name: '来店した' }) as HTMLButtonElement).disabled).toBe(false))
})
