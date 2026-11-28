// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import KpiCard from './kpi-card'

afterEach(cleanup)
it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY])('数が取れない %s は — にし、単位や0を出さない', (value) => {
  const view = render(<KpiCard title="対象" value={value} unit="件" />)
  expect(view.container.textContent).toContain('—')
  expect(view.container.textContent).not.toContain('件')
  expect(view.container.textContent).not.toContain('0')
})
it('実際の0と正しい値は数と単位を表示する', () => {
  const view = render(<KpiCard title="対象" value={0} unit="件" />)
  expect(view.container.textContent).toContain('0')
  expect(view.container.textContent).toContain('件')
  view.rerender(<KpiCard title="対象" value={12345} unit="件" />)
  expect(view.container.textContent).toContain('12,345')
  expect(view.container.textContent).toContain('件')
})
