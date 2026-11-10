// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import type { StyleMetric, StyleSnapshot } from '@line-crm/shared'
import { kpisFor, metricDelta, metricValue, toAnalytics } from './adapter'
import { selectedKpis } from './metric-selection'
import { StyleAnalyticsView } from './analytics'
import type { IndustryStyle } from './model'

afterEach(cleanup)

const rate: StyleMetric = { value: 0.05, numerator: 5, denominator: 100, unit: '割合', status: 'available', formula: '対象のうち当てはまる数' }
const rateIds = ['noShowRate', 'cancelRate', 'nextBookingRate', 'secondVisitRate', 'thirdVisitRate', 'returnRate', 'conversionRate', 'classroomOccupancy', 'onlineOccupancy', 'trialConversion', 'tableUtilization']
const snapshot = (style: IndustryStyle): StyleSnapshot => ({
  style, asOf: '2026-11-01T03:00:00Z', timeZone: 'Asia/Tokyo', from: '2026-11-01T00:00:00+09:00', to: '2026-11-02T00:00:00+09:00', dateBasis: 'visit', range: 'today',
  metrics: Object.fromEntries(rateIds.map(id => [id, { ...rate }])),
  previous: Object.fromEntries(rateIds.map(id => [id, { ...rate, value: 0.07, numerator: 7 }])),
  items: [], newBookings: [], resultId: 'rates',
})

describe('率の値と単位', () => {
  it.each([0, 0.05, 0.384, 1])('APIの割合 %s を百分率で読み、元の数と分子・分母を変えない', value => {
    const metric = { ...rate, value }
    const before = structuredClone(metric)
    expect(metricValue(metric)).toEqual({ value: Math.round(value * 1000) / 10, unit: '%', reason: '' })
    expect(metric).toEqual(before)
  })

  it.each(['', 'ratio', '%', '率'])('既存の率の単位 %s の倍率を変えない', unit => {
    expect(metricValue({ ...rate, unit })).toEqual({ value: 5, unit: '%', reason: '' })
  })

  it('既に百分率の値で届く%と、件数・金額を二重に変換しない', () => {
    expect(metricValue({ value: 5, unit: '%', status: 'available', formula: '' })).toEqual({ value: 5, unit: '%', reason: '' })
    expect(metricValue({ value: 5, unit: '件', status: 'available', formula: '' })).toEqual({ value: 5, unit: '件', reason: '' })
    expect(metricValue({ value: 500, unit: '円', status: 'available', formula: '' })).toMatchObject({ value: 500, unit: '', valueText: '¥500' })
  })

  it('実測0と分母不足・未設定・未取得を区別する', () => {
    expect(metricValue({ ...rate, value: 0, numerator: 0 })).toEqual({ value: 0, unit: '%', reason: '' })
    expect(metricValue({ ...rate, value: null, numerator: 0, denominator: 0, status: 'insufficient_sample' })).toEqual({ value: null, unit: '%', reason: '数が少ないため出せません' })
    expect(metricValue({ ...rate, value: null, status: 'unconfigured' })).toEqual({ value: null, unit: '%', reason: '未設定です' })
    expect(metricValue()).toEqual({ value: null, unit: '', reason: '口から返っていません' })
  })

  it('ごく小さい正の率を0%と区別して各表示に出す', () => {
    const tiny = { ...rate, value: 0.0004, numerator: 4, denominator: 10000 }
    expect(metricValue(tiny)).toMatchObject({ valueText: '0.1%未満' })
    expect(metricValue({ ...tiny, value: 0 })).toMatchObject({ value: 0, unit: '%' })
    expect(metricValue({ ...tiny, value: 0.0005 })).toEqual({ value: 0.1, unit: '%', reason: '' })
    const s = snapshot('lesson')
    s.metrics.onlineOccupancy = tiny
    s.metrics.noShowRate = tiny
    expect(kpisFor('lesson', s, 'today').find(k => k.id === 'fill')?.detail).toBe('オンラインは 0.1%未満')
    expect(selectedKpis('lesson', s, 'today', ['noShowRate'])[0].valueText).toBe('0.1%未満')
    const data = toAnalytics('salon', { ...s, analytics: { staff: [{ staffId: 'staff', bookings: 1, utilization: tiny }] } }, 'staff', {})
    expect(data.cards.find(card => card.id === 'noshow')?.valueText).toBe('0.1%未満')
    expect(data.table?.rows[0].cells[1]).toEqual({ text: '0.1%未満' })
    render(<StyleAnalyticsView data={data} error={false} onTab={vi.fn()} onRetry={vi.fn()} onRowOpen={vi.fn()} />)
    expect(screen.getAllByText('0.1%未満').length).toBeGreaterThan(0)
  })

  it('比較は百分率の差をptで出し、良い向きと欠損を保つ', () => {
    const prev = { ...rate, value: 0.07, numerator: 7 }
    expect(metricDelta(rate, prev, true)).toEqual({ text: '−2pt', tone: 'up' })
    expect(metricDelta(rate, prev)).toEqual({ text: '−2pt', tone: 'down' })
    expect(metricDelta(prev, rate)).toEqual({ text: '+2pt', tone: 'up' })
    expect(metricDelta(rate, rate)).toBeNull()
    expect(metricDelta({ ...rate, value: null }, prev)).toBeNull()
    expect(metricDelta(rate, { ...prev, value: null })).toBeNull()
  })

  it.each<IndustryStyle>(['restaurant', 'salon', 'consult', 'lesson'])('%sの選んだ指標と既定の帯で、すべての率が同じ単位になる', style => {
    const s = snapshot(style)
    const before = structuredClone(s)
    const selected = selectedKpis(style, s, 'today', rateIds)
    expect(selected).toHaveLength(rateIds.length)
    for (const kpi of selected) expect(kpi).toMatchObject({ value: 5, unit: '%' })
    const defaults = kpisFor(style, s, 'today').filter(kpi => kpi.metricId && rateIds.includes(kpi.metricId))
    expect(defaults.length).toBeGreaterThan(0)
    for (const kpi of defaults) expect(kpi).toMatchObject({ value: 5, unit: '%' })
    if (style === 'lesson') expect(defaults.find(kpi => kpi.id === 'fill')?.detail).toBe('オンラインは 5%')
    expect(s).toEqual(before)
  })

  it.each<IndustryStyle>(['restaurant', 'salon', 'consult', 'lesson'])('%sの分析の帯と表にも百分率を描く', style => {
    const data = toAnalytics(style, { ...snapshot(style), analytics: {
      menus: [{ menuId: 'menu', bookings: 100, visits: 95, cancellations: 0, estimatedRevenue: null, noShowRate: rate }],
      staff: [{ staffId: 'staff', bookings: 100, utilization: rate, designationRate: rate, nextBookingRate: rate, returnRate: rate }],
    } }, 'overview', { staff: '担当者', menu: 'コース' })
    const noShow = data.cards.find(card => card.id === 'noshow')!
    expect(noShow).toMatchObject({ valueText: '5', unit: '%', delta: { text: '−2pt', tone: 'up' } })
    if (style === 'restaurant') expect(data.table?.rows[0].cells.at(-1)).toEqual({ text: '5%' })
    if (style === 'salon' || style === 'lesson') expect(data.table?.rows[0].cells.slice(1)).toEqual(Array.from({ length: 4 }, () => ({ text: '5%' })))
    render(<StyleAnalyticsView data={data} error={false} onTab={vi.fn()} onRetry={vi.fn()} onRowOpen={vi.fn()} />)
    const card = within(screen.getByLabelText(noShow.title))
    expect(card.getByText('5')).toBeTruthy()
    expect(card.getByText('%')).toBeTruthy()
    expect(card.getByText('−2pt')).toBeTruthy()
    expect(card.queryByText('割合')).toBeNull()
  })

  it('分析の率の表は分母不足と未設定を0%にしない', () => {
    const data = toAnalytics('salon', { ...snapshot('salon'), analytics: { staff: [{ staffId: 'staff', bookings: 0,
      utilization: { ...rate, value: null, denominator: 0, status: 'insufficient_sample' },
      designationRate: { ...rate, value: null, status: 'unconfigured' }, nextBookingRate: { ...rate, value: 0 },
    }] } }, 'staff', {})
    expect(data.table?.rows[0].cells.slice(1)).toEqual([{ text: '—', note: '出せない' }, { text: '—', note: '未設定' }, { text: '0%' }, { text: '—' }])
  })
})
