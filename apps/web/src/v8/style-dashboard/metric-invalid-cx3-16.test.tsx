// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { StyleSnapshot } from '@line-crm/shared'
import KpiCard from '@/components/shared/kpi-card'
import { selectedKpis } from './metric-selection'

afterEach(cleanup)
const snapshot = { style: 'salon', from: '', to: '', timeZone: 'Asia/Tokyo', asOf: '', dateBasis: 'visit', range: 'today', metrics: {}, previous: {}, items: [], newBookings: [], resultId: 'r' } as unknown as StyleSnapshot
function draw(id: string, data = snapshot) {
  const kpi = selectedKpis('salon', data, 'today', [id])[0]
  render(<KpiCard title={kpi.title} icon={null} help={kpi.help} helpDisplay="question" value={kpi.value} valueText={kpi.valueText} unit={kpi.unit} detail={kpi.detail} />)
}

it('予約された名前の未知の指標も名前を確認できないと表示する', () => {
  draw('toString')
  expect(screen.getByText('表示できない項目')).toBeTruthy()
  expect(screen.queryByText(/native code/)).toBeNull()
})

it('不正な説明が届いてもカードの説明を開ける', () => {
  const data = { ...snapshot, metrics: { future: { value: 4, status: 'available', unit: '件', formula: { invalid: true } } } } as unknown as StyleSnapshot
  draw('future', data)
  fireEvent.click(screen.getByRole('button', { name: /表示できない項目/ }))
  expect(screen.getByText('この項目の集計はまだ取得できていません。')).toBeTruthy()
})
