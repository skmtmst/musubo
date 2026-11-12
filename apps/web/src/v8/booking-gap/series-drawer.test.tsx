// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { SeriesOccurrence } from '@line-crm/shared'
import { ApiError } from '@/lib/api'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
const preview = vi.fn()
const create = vi.fn()
vi.mock('@/lib/api/helpers/gap2', () => ({ bookingSeriesApi: { preview: (...a: unknown[]) => preview(...a), create: (...a: unknown[]) => create(...a) } }))
vi.mock('@/components/shared/toast', () => ({ notifySaved: vi.fn(), notifyToast: vi.fn() }))
const { default: SeriesBookingDrawer } = await import('./series-drawer')

const day = (n: number) => `2026-11-${String(n).padStart(2, '0')}T05:00:00.000Z`
const list: SeriesOccurrence[] = [
  { index: 0, startsAt: day(20), available: true, staffId: 'bs-1', reason: null, alternatives: [] },
  { index: 1, startsAt: '2026-12-04T05:00:00.000Z', available: false, staffId: null, reason: 'slot_unavailable', alternatives: ['2026-12-04T07:00:00.000Z'] },
  { index: 2, startsAt: '2026-12-25T05:00:00.000Z', available: false, staffId: null, reason: 'slot_unavailable', alternatives: [] },
]
const summary = { customerName: '見本 143', friendId: 'f1', menuId: 'bm-1', menuName: 'トリミング（小型犬）', durationMin: 105, staffId: 'bs-1', staffName: '佐々木', startsAt: day(20), endsAt: '2026-11-20T06:45:00.000Z' }

beforeEach(() => { preview.mockResolvedValue({ success: true, data: { occurrences: list } }); create.mockResolvedValue({ success: true, data: { series: { id: 's1' }, bookings: [{}, {}], skipped: [{}] } }) })
afterEach(() => { cleanup(); vi.clearAllMocks() })
const open = (onCreated = vi.fn()) => render(<SeriesBookingDrawer open accountId="a1" summary={summary} onClose={() => {}} onCreated={onCreated} />)

test('取れない回を表で見せ、飛ばす回を数えない（3 回のうち 2 件を入れる）', async () => {
  open()
  expect(await screen.findByText('取れない回 2 件')).toBeTruthy()
  expect(screen.getByText('→ 16:00 にする')).toBeTruthy()
  expect(screen.getByText('この回は作りません')).toBeTruthy()
  expect(screen.getByRole('button', { name: '2 件を入れる' })).toBeTruthy()
})

test('別の時間を飛ばすに替えると件数が減り、保存は回ごとの選択を送る（全部か無しは口が守る）', async () => {
  const onCreated = vi.fn()
  open(onCreated)
  await screen.findByText('取れない回 2 件')
  fireEvent.click(screen.getAllByText('飛ばす')[0])
  const save = await screen.findByRole('button', { name: '1 件を入れる' })
  fireEvent.click(save)
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
  const body = create.mock.calls[0][1]
  expect(body.choices.map((c: { action: string }) => c.action)).toEqual(['keep', 'skip', 'skip'])
  expect(body.friendId).toBe('f1')
  expect(typeof create.mock.calls[0][2]).toBe('string') // Idempotency-Key（二重押しは同じ組 1 つ）
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ seriesId: 's1', created: 2 }))
})

test('保存の間に埋まった回があれば何も作らず、表を出し直す', async () => {
  create.mockRejectedValue(new ApiError(409, 'conflict'))
  const onCreated = vi.fn()
  open(onCreated)
  fireEvent.click(await screen.findByRole('button', { name: '2 件を入れる' }))
  expect(await screen.findByText('その間に埋まった回があります。表を確かめ直してください。')).toBeTruthy()
  expect(onCreated).not.toHaveBeenCalled()
  await waitFor(() => expect(preview.mock.calls.length).toBeGreaterThan(1))
})

test('確かめられないときは保存を押せない（確かめないで保存しない）', async () => {
  preview.mockRejectedValue(new Error('503'))
  open()
  expect(await screen.findByText(/空きを確かめられませんでした/)).toBeTruthy()
  expect((screen.getByRole('button', { name: /件を入れる/ }) as HTMLButtonElement).disabled).toBe(true)
})

// 閉じる確認とは別に、入力中の再読込も共通の番兵が止める。
test('繰り返す予約の確認中はページを閉じる前に確かめ、閉じた後は番兵を外す', async () => {
  const view = open()
  await screen.findByText('取れない回 2 件')
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
  view.unmount()
  const after = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(after)
  expect(after.defaultPrevented).toBe(false)
})


test('日本と日付が違う店舗でも、表示・プレビュー・保存の曜日をそろえる', async () => {
  const local = { ...summary, startsAt: '2026-11-04T23:00:00Z', endsAt: '2026-11-05T00:45:00Z', timeZone: 'America/New_York' }
  render(<SeriesBookingDrawer open accountId="a1" summary={local} onClose={() => {}} onCreated={() => {}} />)
  await screen.findByText('取れない回 2 件')
  expect(screen.getByText('11/04（水） 18:00〜19:45')).toBeTruthy()
  expect(preview.mock.calls[0][1].rule.weekday).toBe(3)
  fireEvent.click(screen.getByRole('button', { name: '2 件を入れる' }))
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
  expect(create.mock.calls[0][1].rule.weekday).toBe(3)
})
