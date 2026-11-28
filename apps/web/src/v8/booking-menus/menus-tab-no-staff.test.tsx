// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { BookingMenu } from '@/lib/api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
}))
vi.mock('../menu-version-history', () => ({ default: () => null }))

import { MenusTabV8 } from './tabs/menus-tab'

const menu = (id: string, name: string, staff: string[], active = 1) => ({
  id, name, sort_order: 0, version: 1, duration_minutes: 60, is_active: active, description: null, category_label: null,
  assigned_staff: staff.map((display_name, index) => ({ id: `${id}-${index}`, display_name })), booking_count_30_days: 0,
}) as unknown as BookingMenu

afterEach(cleanup)

it('担当がいない公開中のメニューは黄の札で理由を言い、押すと担当スタッフのタブへ。担当の列は薄い灰の — だけ', () => {
  const onOpenStaff = vi.fn()
  render(<MenusTabV8 accountId="a" status="ready" error={null} menuCount={3} canEdit onReload={() => {}} onOpenStaff={onOpenStaff}
    menus={[menu('m1', '歯みがき教室', []), menu('m2', 'カット', ['佐藤']), menu('m3', 'お休み中', [], 0)]} />)
  const rowOf = (name: string) => screen.getByRole('button', { name, exact: true }).closest('[data-reorder-id]') as HTMLElement
  const noStaff = rowOf('歯みがき教室')
  expect(noStaff.textContent).not.toContain('担当なし')
  expect(noStaff.textContent).toContain('—')
  const chip = noStaff.querySelector('[data-status-pill]') as HTMLElement
  expect(chip.textContent).toBe('担当がいないため停止中')
  expect(chip.dataset.tone).toBe('caution')
  fireEvent.click(chip.closest('button')!)
  expect(onOpenStaff).toHaveBeenCalledTimes(1)
  expect(rowOf('カット').querySelector('[data-status-pill]')?.textContent).toBe('公開中')
  expect(rowOf('お休み中').querySelector('[data-status-pill]')?.textContent).toBe('停止中')
})

it('閲覧のみでは予約メニューの作成入口を両方止める', () => {
  render(<MenusTabV8 accountId="a" status="ready" error={null} menuCount={0} canEdit={false} onReload={() => {}} onOpenStaff={() => {}} menus={[]} />)
  for (const name of ['予約メニューを作る', '最初の予約メニューを作る']) {
    const b = screen.getByRole('button', { name }) as HTMLButtonElement
    expect(b.disabled || b.getAttribute('aria-disabled') === 'true').toBe(true)
    expect(b.getAttribute('href')).toBeNull()
  }
})
