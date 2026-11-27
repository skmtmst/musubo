// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import KpiCollapse from '@/components/ui/kpi-collapse'

afterEach(cleanup)
it('折りたたんだ集計は開閉しても1つの帯のまま', () => {
  const view = render(<KpiCollapse gridClassName="sample-grid"><span>友だち</span><span>配信</span><span>回答</span></KpiCollapse>)
  const strip = view.container.querySelector('[data-kpi-strip]')!
  expect(strip.getAttribute('data-kpi-presentation')).toBe('band')
  expect(strip.textContent).toContain('友だち')
  expect(strip.textContent).toContain('回答')
  const toggle = screen.getByRole('button', { name: '残り1件の集計を見る' })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByRole('button', { name: '集計を閉じる' })).toBe(toggle)
  expect(view.container.querySelectorAll('[data-kpi-strip]')).toHaveLength(1)
  expect(strip.getAttribute('data-kpi-presentation')).toBe('band')
})
