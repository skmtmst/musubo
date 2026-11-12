// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const get = vi.fn(); const change = vi.fn(); const cancel = vi.fn()
vi.mock('@/lib/api/helpers/gap2', () => ({ bookingSeriesApi: { get: (...a: unknown[]) => get(...a), change: (...a: unknown[]) => change(...a), cancel: (...a: unknown[]) => cancel(...a) } }))
const impact = vi.fn()
vi.mock('@/lib/api/helpers/booking-advanced', () => ({ bookingAdvancedApi: { impact: (...a: unknown[]) => impact(...a) } }))
const notifySaved = vi.fn()
vi.mock('@/components/shared/toast', () => ({ notifySaved: (...a: unknown[]) => notifySaved(...a), notifyToast: vi.fn() }))
const { default: SeriesScopeDialog } = await import('./series-scope-dialog')

const b = (i: number, startsAt: string, status = 'confirmed') => ({ id: `b${i}`, series_index: i, starts_at: startsAt, status })
const bookings = [b(2, '2026-12-04T05:00:00.000Z'), b(3, '2026-12-11T05:00:00.000Z'), b(4, '2026-12-18T05:00:00.000Z'), b(5, '2027-01-01T05:00:00.000Z', 'cancelled'), b(6, '2027-01-08T05:00:00.000Z')]
const target = { seriesId: 's1', customerName: '見本 143', ruleText: '毎週金曜 14:00', menuName: 'トリミング（小型犬）', index: 4, bookingId: 'b3', startsAt: '2026-12-11T05:00:00.000Z' }

beforeEach(() => {
  impact.mockImplementation(async (_a, _id, input) => ({ success: true, data: { items: bookings.filter(b => b.status !== 'cancelled' && b.series_index >= 3).filter((_, i) => input.scope !== 'this' || i === 0).map(b => ({ bookingId: b.id, startsAt: b.starts_at, after: input.change?.startsAt ?? null, blocked: false, fee: null })) } }))
  get.mockResolvedValue({ success: true, data: { series: { id: 's1', version: 3 }, bookings } })
  change.mockResolvedValue({ success: true, data: { changed: ['b3', 'b4'], conflicts: ['b6'], version: 4 } })
  cancel.mockResolvedValue({ success: true, data: { cancelled: ['b3', 'b4', 'b6'], fees: [{ bookingId: 'b3', feeNow: 4200 }], version: 4 } })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

test('対象は選んだ回から後の有効な回だけ（取消済みは数えない）。版は組の版を添えて送る', async () => {
  const onDone = vi.fn()
  render(<SeriesScopeDialog open mode="change" accountId="a1" target={target} newStartsAt="2026-12-11T16:00:00+09:00" onClose={() => {}} onDone={onDone} />)
  expect(await screen.findByText('変わる日（3 件）')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '3 件を変える' }))
  await waitFor(() => expect(change).toHaveBeenCalledTimes(1))
  expect(change.mock.calls[0][2]).toMatchObject({ scope: 'following', fromBookingId: 'b3', expectedVersion: 3, change: { startsAt: '2026-12-11T16:00:00+09:00' } })
  /* 変えられなかった回（口の conflicts）は黙らず知らせる。 */
  await waitFor(() => expect(notifySaved.mock.calls[0][0]).toContain('1 件は埋まっていて前のまま'))
  expect(onDone).toHaveBeenCalledWith({ count: 2 })
})

test('取り消す：この回だけにすると 1 件。キャンセル料は口の返事の見込みを知らせに出す', async () => {
  render(<SeriesScopeDialog open mode="cancel" accountId="a1" target={target} onClose={() => {}} onDone={() => {}} />)
  expect(screen.getByRole('alertdialog').textContent).toContain('LINEアカウント')
  expect(screen.getByRole('alertdialog').textContent).toContain('環境')
  fireEvent.click(await screen.findByRole('radio', { name: /この回だけ/ }))
  fireEvent.click(await screen.findByRole('button', { name: '1 件を取り消す' }))
  await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1))
  expect(cancel.mock.calls[0][2]).toMatchObject({ scope: 'this', fromBookingId: 'b3', expectedVersion: 3 })
  await waitFor(() => expect(notifySaved.mock.calls[0][0]).toContain('¥4,200'))
})

test('対象の日を読めないときは実行できない', async () => {
  get.mockRejectedValue(new Error('503'))
  render(<SeriesScopeDialog open mode="cancel" accountId="a1" target={target} onClose={() => {}} onDone={() => {}} />)
  expect(await screen.findByText(/対象の日とキャンセル料の見込みを確認できませんでした/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /件を取り消す/ })?.hasAttribute('disabled') ?? true).toBe(true)
})

test('アカウントが変わると前の見込みでは実行できない', async () => {
  const pending = new Promise(() => {})
  const view = render(<SeriesScopeDialog open mode="cancel" accountId="a1" target={target} onClose={() => {}} onDone={() => {}} />)
  expect(await screen.findByRole('button', { name: '3 件を取り消す' })).toBeTruthy()
  get.mockReturnValueOnce(pending)
  view.rerender(<SeriesScopeDialog open mode="cancel" accountId="a2" target={target} onClose={() => {}} onDone={() => {}} />)
  expect(screen.queryByRole('button', { name: '3 件を取り消す' })).toBeNull()
  expect(cancel).not.toHaveBeenCalled()
})

test('埋まっている回を数えず、見込みの取得失敗は実行を止める', async () => {
  impact.mockResolvedValue({ success: true, data: { items: [
    { bookingId: 'b3', startsAt: bookings[1].starts_at, blocked: false, fee: { amount: 4200, percent: 50, reason: '24 時間前を過ぎた' } },
    { bookingId: 'b4', startsAt: bookings[2].starts_at, after: '2026-12-18T07:00:00.000Z', blocked: false, fee: null },
    { bookingId: 'b6', startsAt: bookings[4].starts_at, blocked: true, fee: null },
  ] } })
  render(<SeriesScopeDialog open mode="change" accountId="a1" target={target} newStartsAt="2026-12-11T16:00:00+09:00" onClose={() => {}} onDone={() => {}} />)
  expect(await screen.findByText(/埋まっています・14:00 のまま/)).toBeTruthy()
  expect(screen.getByRole('button', { name: '2 件を変える' })).toBeTruthy()
  /* 見出しとボタンの数が食い違って見えないよう「3 件のうち 2 件」と書く。 */
  expect(screen.getByText('変わる日（3 件のうち 2 件）')).toBeTruthy()
  cleanup()
  impact.mockRejectedValue(new Error('404'))
  render(<SeriesScopeDialog open mode="cancel" accountId="a1" target={target} onClose={() => {}} onDone={() => {}} />)
  expect(await screen.findByText(/対象の日とキャンセル料の見込みを確認できませんでした/)).toBeTruthy()
  expect(screen.queryByText('かかりません')).toBeNull()
  expect(cancel).not.toHaveBeenCalled()
})
