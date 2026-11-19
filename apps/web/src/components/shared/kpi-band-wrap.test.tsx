// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import KpiBand from './kpi-band'
import KpiCard from './kpi-card'
afterEach(cleanup)
it.each([0, 5])('%s metrics preserve the original single band', count => {
  const { container } = render(<KpiBand maxColumns={5} aria-label="Metrics">{Array.from({ length: count }, (_, i) => <KpiCard key={i} title={`Metric ${i}`} value={i} />)}</KpiBand>)
  expect(container.querySelectorAll('[data-kpi-strip]')).toHaveLength(1)
  expect(container.querySelector('[data-shared-part="kpi-band-rows"]')).toBeNull()
  expect(screen.getByLabelText('Metrics').children.length).toBe(count)
})
it('32 metrics wrap without loss or reordering and retain unknown versus zero', () => {
  const { container } = render(<KpiBand id="all-metrics" maxColumns={5} aria-label="All metrics" layout="link-row">{Array.from({ length: 32 }, (_, i) => <KpiCard key={i} aria-label={`Metric ${i}`} title={`Metric ${i}`} value={i === 1 ? null : i} />)}</KpiBand>)
  expect(container.querySelectorAll('#all-metrics')).toHaveLength(1)
  const rows = Array.from(screen.getByLabelText('All metrics').children)
  expect(rows.map(row => row.children.length)).toEqual([5, 5, 5, 5, 5, 5, 2])
  expect(rows.flatMap(row => Array.from(row.children).map(card => card.getAttribute('aria-label')))).toEqual(Array.from({ length: 32 }, (_, i) => `Metric ${i}`))
  expect(screen.getByLabelText('Metric 0').textContent).toContain('0')
  expect(screen.getByLabelText('Metric 1').textContent).toContain('—')
})

it.each([0, NaN, -1, Infinity, 0.5])('invalid maxColumns %s preserves a finite original band', maxColumns => {
  const { container } = render(<KpiBand maxColumns={maxColumns}>{Array.from({ length: 6 }, (_, i) => <span key={i}>{i}</span>)}</KpiBand>)
  expect(container.querySelectorAll('[data-kpi-strip]')).toHaveLength(1)
  expect(container.querySelector('[data-kpi-strip]')?.children.length).toBe(6)
})

it('段に分けたときは、画面の className を段の包み全体にだけ付ける（包みが中身の幅に縮まない）', () => {
  const { container } = render(<KpiBand className="screen-band" maxColumns={3}>{Array.from({ length: 5 }, (_, i) => <KpiCard key={i} title={`Metric ${i}`} value={i} unit="件" detail={null} />)}</KpiBand>)
  const rows = container.querySelector('[data-shared-part="kpi-band-rows"]')
  expect(rows?.classList.contains('screen-band')).toBe(true)
  expect(Array.from(rows?.children ?? []).map(row => row.children.length)).toEqual([3, 2])
  expect(container.querySelectorAll('[data-kpi-strip].screen-band')).toHaveLength(0)
})
