// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { RestaurantFloor } from '@line-crm/shared'
import type { RestaurantTable } from '@/lib/restaurant-test-api'
import WalkInDialog from './walk-in-dialog'

const floorList = [
  { id: 'one', name: '1階' }, { id: 'terrace', name: 'テラス' },
] as RestaurantFloor[]
const fixtures = [
  { id: '10', code: '10', label: 'テーブル10', floor_id: 'one', min_capacity: 1, max_capacity: 2, is_active: 1 },
  { id: '2', code: '2', label: 'テーブル2', floor_id: 'one', min_capacity: 1, max_capacity: 4, is_active: 1 },
  { id: '3', code: '3', label: 'テラス3', floor_id: 'terrace', min_capacity: 1, max_capacity: 4, is_active: 1 },
] as RestaurantTable[]
const net = vi.hoisted(() => ({ floors: vi.fn(), reservationsDay: vi.fn() }))
vi.mock('@/lib/api/helpers/reservation-board', () => ({ reservationBoardApi: { floors: net.floors } }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: { reservationsDay: net.reservationsDay } }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('階の順と卓番の数の順で表示し、人数に合う件数で絞り、隠れた選択を外す', async () => {
  net.floors.mockResolvedValue({ data: floorList })
  net.reservationsDay.mockResolvedValue({ data: { reservations: [] } })
  render(<WalkInDialog open accountId="a" storeId="s" tables={fixtures} onClose={() => {}} onSaved={() => {}} />)
  const all = await screen.findByRole('tab', { name: /すべて/ })
  expect(all.getAttribute('aria-selected')).toBe('true')
  expect(all.textContent).toContain('3')
  const floor = screen.getByRole('tab', { name: /1階/ })
  expect(floor.textContent).toContain('2')
  expect(screen.getAllByRole('radio').map(el => (el as HTMLInputElement).value)).toEqual(['2', '10', '3'])
  fireEvent.click(screen.getByRole('tab', { name: /テラス/ }))
  expect(screen.getAllByRole('radio').map(el => (el as HTMLInputElement).value)).toEqual(['3'])
  expect((screen.getByRole('radio') as HTMLInputElement).checked).toBe(false)
  expect(screen.getByRole('button', { name: 'キャンセル' })).toBeTruthy()
  expect((screen.getByRole('button', { name: /入店にする/ }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText('座る卓を選んでください。')).toBeTruthy()
  fireEvent.click(screen.getByRole('radio'))
  fireEvent.click(screen.getByRole('button', { name: '人数を増やす' }))
  expect(screen.getByRole('tab', { name: /1階/ }).textContent).toContain('1')
  fireEvent.click(screen.getByRole('button', { name: '人数を増やす' }))
  fireEvent.click(screen.getByRole('button', { name: '人数を増やす' }))
  await waitFor(() => expect(screen.queryByRole('radio')).toBeNull())
  expect(screen.getByRole('tab', { name: /テラス/ }).textContent).toContain('0')
})

it('階が1つの場合は階のタブを表示しない', async () => {
  net.floors.mockResolvedValue({ data: floorList.slice(0, 1) })
  net.reservationsDay.mockResolvedValue({ data: { reservations: [] } })
  render(<WalkInDialog open accountId="a" storeId="s" tables={fixtures.slice(0, 2)} onClose={() => {}} onSaved={() => {}} />)
  await screen.findByRole('radio', { name: /テーブル2/ })
  expect(screen.queryByRole('tablist', { name: '階・エリア' })).toBeNull()
})

it('予約の取得が先に終わっても階の並びが分かってから先頭の卓を選ぶ', async () => {
  let finish!: (value: { data: RestaurantFloor[] }) => void
  net.floors.mockReturnValue(new Promise(resolve => { finish = resolve }))
  net.reservationsDay.mockResolvedValue({ data: { reservations: [] } })
  render(<WalkInDialog open accountId="a" storeId="s" tables={[{ ...fixtures[2], code: '1' }, fixtures[1]]} onClose={() => {}} onSaved={() => {}} />)
  await screen.findByRole('radio', { name: /テラス3/ })
  expect((screen.getByRole('radio', { name: /テラス3/ }) as HTMLInputElement).checked).toBe(false)
  finish({ data: floorList })
  await waitFor(() => expect((screen.getByRole('radio', { name: /テーブル2/ }) as HTMLInputElement).checked).toBe(true))
})

it('店が変わり階の取得が失敗しても前の店のタブを残さない', async () => {
  net.floors.mockResolvedValueOnce({ data: floorList }).mockRejectedValueOnce(new Error('failed'))
  net.reservationsDay.mockResolvedValue({ data: { reservations: [] } })
  const { rerender } = render(<WalkInDialog open accountId="a" storeId="s" tables={fixtures} onClose={() => {}} onSaved={() => {}} />)
  fireEvent.click(await screen.findByRole('tab', { name: /テラス/ }))
  rerender(<WalkInDialog open accountId="a" storeId="another" tables={fixtures} onClose={() => {}} onSaved={() => {}} />)
  expect(await screen.findByText('階・エリアを読み込めませんでした。卓はすべて表示しています。')).toBeTruthy()
  expect(screen.queryByRole('tablist', { name: '階・エリア' })).toBeNull()
  expect(screen.getAllByRole('radio')).toHaveLength(3)
})

it('窓を開き直すとすべてのタブに戻る', async () => {
  net.floors.mockResolvedValue({ data: floorList })
  net.reservationsDay.mockResolvedValue({ data: { reservations: [] } })
  const props = { accountId: 'a', storeId: 's', tables: fixtures, onClose: () => {}, onSaved: () => {} }
  const { rerender } = render(<WalkInDialog {...props} open />)
  fireEvent.click(await screen.findByRole('tab', { name: /テラス/ }))
  rerender(<WalkInDialog {...props} open={false} />)
  rerender(<WalkInDialog {...props} open />)
  await waitFor(() => expect(screen.getByRole('tab', { name: /すべて/ }).getAttribute('aria-selected')).toBe('true'))
})

it('店を切り替えた直後は新しい予約を読めるまで入店できない', async () => {
  net.floors.mockResolvedValue({ data: floorList })
  net.reservationsDay.mockImplementation((_account: string, store: string) => store === 'new' ? new Promise(() => {}) : Promise.resolve({ data: { reservations: [] } }))
  const { rerender } = render(<WalkInDialog open accountId="a" storeId="s" tables={fixtures} onClose={() => {}} onSaved={() => {}} />)
  await waitFor(() => expect((screen.getByRole('button', { name: /入店にする/ }) as HTMLButtonElement).disabled).toBe(false))
  rerender(<WalkInDialog open accountId="a" storeId="new" tables={fixtures} onClose={() => {}} onSaved={() => {}} />)
  expect((screen.getByRole('button', { name: /入店にする/ }) as HTMLButtonElement).disabled).toBe(true)
})

it('予約の読み込みに失敗したら卓を選べず、入店を確定できない', async () => {
  net.floors.mockResolvedValue({ data: floorList })
  net.reservationsDay.mockRejectedValue(new Error('unavailable'))
  render(<WalkInDialog open accountId="a" storeId="s" tables={fixtures} onClose={() => {}} onSaved={() => {}} />)
  expect(await screen.findByText('今日の予約を読み込めませんでした。閉じてもう一度開いてください。')).toBeTruthy()
  expect(screen.queryAllByRole('radio')).toHaveLength(0)
  expect((screen.getByRole('button', { name: /入店にする/ }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.queryByText('空いている卓を調べています。')).toBeNull()
})

it('読み込み失敗後に店舗を変えると新しい空き状況を使う', async () => {
  net.floors.mockResolvedValue({ data: floorList })
  net.reservationsDay.mockImplementation((_account: string, store: string) => store === 's' ? Promise.reject(new Error('unavailable')) : Promise.resolve({ data: { reservations: [] } }))
  const props = { open: true, accountId: 'a', storeId: 's', tables: fixtures, onClose: () => {}, onSaved: () => {} }
  const { rerender } = render(<WalkInDialog {...props} />)
  expect(await screen.findByText('今日の予約を読み込めませんでした。閉じてもう一度開いてください。')).toBeTruthy()
  rerender(<WalkInDialog {...props} storeId="new" />)
  expect(await screen.findAllByRole('radio')).toHaveLength(3)
  expect(screen.queryByText('今日の予約を読み込めませんでした。閉じてもう一度開いてください。')).toBeNull()
})
