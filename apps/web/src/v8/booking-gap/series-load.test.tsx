// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/lib/api/helpers/gap2', () => ({ bookingSeriesApi: { get: mocks.get } }))
vi.mock('@/v8/booking-payments/public/booking-group/index', () => ({ BookingGroupSection: () => <div>同伴の組</div> }))
vi.mock('./series-panel-section', () => ({ default: ({ series }: { series: { id: string } }) => <div>繰り返し {series.id}</div> }))
import BookingGapSections from './booking-gap-sections'
afterEach(() => { cleanup(); vi.resetAllMocks() })
const props = { accountId: 'a1', bookingId: 'b1', seriesId: 's1', customerName: '確認用', menuName: 'メニュー', startsAt: '2026-11-26T10:00:00Z', canOperate: true, onChanged: vi.fn() }
it('取得失敗を知らせ、繰り返し情報だけを読み直す', async () => {
  mocks.get.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ data: { series: { id: 's1' }, bookings: [] } })
  render(<BookingGapSections {...props} />)
  await screen.findByText('繰り返し予約の情報を読み込めませんでした。')
  expect(screen.getByText('同伴の組')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '繰り返し予約を読み直す' }))
  expect(await screen.findByText('繰り返し s1')).toBeTruthy()
  expect(props.onChanged).not.toHaveBeenCalled()
})
it('繰り返し予約でなければ取得しない', () => {
  render(<BookingGapSections {...props} seriesId={null} />)
  expect(mocks.get).not.toHaveBeenCalled()
  expect(screen.queryByText('繰り返し予約の情報を読み込めませんでした。')).toBeNull()
})

it('予約の切替後に古い返事を表示しない', async () => {
  let resolveOld!: (value: unknown) => void
  mocks.get.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve })).mockResolvedValueOnce({ data: { series: { id: 's2' }, bookings: [] } })
  const view = render(<BookingGapSections {...props} />)
  await vi.waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1))
  view.rerender(<BookingGapSections {...props} accountId="a2" bookingId="b2" seriesId="s2" />)
  await screen.findByText('繰り返し s2')
  await act(async () => { resolveOld({ data: { series: { id: 's1' }, bookings: [] } }) })
  expect(screen.queryByText('繰り返し s1')).toBeNull()
  expect(screen.getByText('繰り返し s2')).toBeTruthy()
})
