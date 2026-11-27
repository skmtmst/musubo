// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HoursWorkspace } from '@line-crm/shared'
import type { GoogleProfileData } from '@/lib/restaurant-google-api'
import { HoursCalendarPage } from './hours-calendar-page'

vi.mock('@/components/shared/button', () => ({
  default: ({
    children,
    disabled,
    onClick,
  }: {
    children?: ReactNode
    disabled?: boolean
    onClick?: () => void
  }) => (
    <button
      type="button"
      data-disabled-prop={String(Boolean(disabled))}
      onClick={onClick}
    >
      {children}
    </button>
  ),
}))

vi.mock('@/components/shared/hours-date-calendar', () => ({
  default: () => <div data-testid="hours-date-calendar" />,
}))

const DATA = {
  today: { date: '2026-11-27', weekday: 'FRIDAY' },
  profile: {
    regularHours: {
      MONDAY: [{ open: '11:00', close: '22:00' }],
      TUESDAY: [{ open: '11:00', close: '22:00' }],
      WEDNESDAY: [{ open: '11:00', close: '22:00' }],
      THURSDAY: [{ open: '11:00', close: '22:00' }],
      FRIDAY: [{ open: '11:00', close: '22:00' }],
      SATURDAY: [{ open: '11:00', close: '22:00' }],
      SUNDAY: [],
    },
    specialHours: [
      { date: '2026-11-28', closed: true, periods: [] },
    ],
  },
} as unknown as GoogleProfileData

const WORKSPACE: HoursWorkspace = {
  holiday: { mode: 'regular', periods: [] },
  notes: {},
  draft: {
    weekly: null,
    days: [],
    holidayChanged: false,
    serviceIds: [],
    reviewIds: [],
  },
  services: [],
  reviews: [],
}

afterEach(() => {
  cleanup()
})

describe('HoursCalendarPage の無効時コールバックガード', () => {
  it('無効時は編集・取消・変更内容を確認のコールバック側をすべて止める', () => {
    const onEdit = vi.fn()
    const onRemove = vi.fn()
    const onReview = vi.fn()

    render(
      <HoursCalendarPage
        data={DATA}
        workspace={WORKSPACE}
        holidays={[]}
        month="2026-11"
        onMonth={vi.fn()}
        selected="2026-11-28"
        onSelect={vi.fn()}
        onBack={vi.fn()}
        onEdit={onEdit}
        onRemove={onRemove}
        onReview={onReview}
        disabled
        changed
      />,
    )

    for (const label of ['この日を編集', 'この日の変更を取り消す', '変更内容を確認']) {
      const btn = screen.getByRole('button', { name: label })
      expect(btn.getAttribute('data-disabled-prop')).toBe('true')
      fireEvent.click(btn)
    }

    expect(onEdit).not.toHaveBeenCalled()
    expect(onRemove).not.toHaveBeenCalled()
    expect(onReview).not.toHaveBeenCalled()
  })

  it('有効時は編集・取消・変更内容を確認をそのまま実行する', () => {
    const onEdit = vi.fn()
    const onRemove = vi.fn()
    const onReview = vi.fn()

    render(
      <HoursCalendarPage
        data={DATA}
        workspace={WORKSPACE}
        holidays={[]}
        month="2026-11"
        onMonth={vi.fn()}
        selected="2026-11-28"
        onSelect={vi.fn()}
        onBack={vi.fn()}
        onEdit={onEdit}
        onRemove={onRemove}
        onReview={onReview}
        disabled={false}
        changed
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'この日を編集' }))
    fireEvent.click(screen.getByRole('button', { name: 'この日の変更を取り消す' }))
    fireEvent.click(screen.getByRole('button', { name: '変更内容を確認' }))

    expect(onEdit).toHaveBeenCalledWith(['2026-11-28'])
    expect(onRemove).toHaveBeenCalledWith(['2026-11-28'])
    expect(onReview).toHaveBeenCalledTimes(1)
  })
})
