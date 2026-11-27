// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IndustryStyle, StyleAnalyticsData, StyleMetric, StyleSnapshot } from '@line-crm/shared'
import { toAnalytics } from './adapter'
import { StyleAnalyticsView } from './analytics'

const metric = (value: number | null, status: StyleMetric['status'] = 'available'): StyleMetric => ({ value, status, unit: '件', formula: '開始日が期間内' })
const daily: NonNullable<StyleAnalyticsData['dailyComparison']> = {
  current: [
    { date: '2026-10-14', metrics: { bookings: metric(4), visits: metric(2) } },
    { date: '2026-10-15', metrics: { bookings: metric(0), visits: metric(0) } },
  ],
  previous: [
    { date: '2026-10-12', metrics: { bookings: metric(8), visits: metric(5) } },
    { date: '2026-10-13', metrics: { bookings: metric(0), visits: metric(0) } },
  ],
}
function data(style: IndustryStyle = 'restaurant', comparison: StyleAnalyticsData['dailyComparison'] = daily) {
  const snapshot: StyleSnapshot & { analytics: StyleAnalyticsData } = {
    style, from: '2026-10-13T15:00:00Z', to: '2026-10-15T15:00:00Z', asOf: '2026-10-21T00:00:00Z', timeZone: 'Asia/Tokyo', dateBasis: 'visit', range: 'month',
    metrics: { bookings: metric(4) }, previous: {}, items: [], newBookings: [], resultId: 'fixture',
    analytics: { dailyComparison: comparison, daily: [{ date: '2026-10-14', bookings: 999, visits: 888 }] },
  }
  return toAnalytics(style, snapshot, style === 'restaurant' ? 'reservations' : 'overview', {})
}
function show(value: ReturnType<typeof data>) {
  return render(<StyleAnalyticsView data={value} error={false} onTab={() => {}} onRetry={() => {}} onRowOpen={() => {}} />)
}
afterEach(cleanup)

it('日別指標が不正な形でも画面を表示し、その日の数を未取得にする', () => {
  const value = data('restaurant', { current: [{ date: '2026-10-14', metrics: null }, daily.current[1]], previous: daily.previous } as never)
  const onTab = vi.fn()
  render(<StyleAnalyticsView data={value} error={false} onTab={onTab} onRetry={() => {}} onRowOpen={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: '来店と席' }))
  expect(onTab).toHaveBeenCalledWith('seats')
  const point = screen.getByRole('img').querySelector('[title="2026-10-14：この期間 未取得・比較期間 2026-10-12：8"]')
  expect(point).toBeTruthy()
  expect(point?.querySelector('i[data-k="now"]')).toBeNull()
})

it('日付が不正な集計を正しい日付・件数として表示しない', () => {
  const value = data('restaurant', { current: [{ date: 'invalid', metrics: { bookings: metric(9) } }, daily.current[1]], previous: daily.previous } as never)
  show(value)
  expect(screen.queryByText('NaN/NaN')).toBeNull()
  const point = screen.getByRole('img').querySelector('[title="日付不明：この期間 未取得・比較期間 2026-10-12：8"]')
  expect(point).toBeTruthy()
  expect(point?.querySelector('i[data-k="now"]')).toBeNull()
})
