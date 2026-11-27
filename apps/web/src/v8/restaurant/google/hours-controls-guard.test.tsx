// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HoursWeekday, OpeningPeriod } from '@line-crm/shared'
import { PeriodFields, Weekdays } from './hours-controls'

vi.mock('@/components/shared/hours-date-calendar', () => ({
  WeekdayButtons: ({
    selected,
    onChange,
  }: {
    selected: number[]
    onChange: (indices: number[]) => void
  }) => (
    <div data-testid="weekday-buttons" data-selected={selected.join(',')}>
      <button type="button" onClick={() => onChange([0, 99, -1])}>pick-weekdays</button>
    </div>
  ),
}))

vi.mock('@/components/shared/time-field-v8', () => ({
  default: ({
    'aria-label': ariaLabel,
    onChange,
  }: {
    'aria-label'?: string
    onChange: (value: string) => void
  }) => (
    <button
      type="button"
      onClick={() => onChange(ariaLabel?.includes('閉店') ? '24:00' : '12:00')}
    >
      {ariaLabel}
    </button>
  ),
}))

vi.mock('@/components/shared/icon-button', () => ({
  default: ({
    'aria-label': ariaLabel,
    onClick,
  }: {
    'aria-label'?: string
    onClick?: () => void
  }) => (
    <button type="button" onClick={onClick}>{ariaLabel}</button>
  ),
}))

vi.mock('@/components/shared/button', () => ({
  default: ({
    children,
    onClick,
  }: {
    children?: ReactNode
    onClick?: () => void
  }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
}))

afterEach(() => {
  cleanup()
})

const TWO_PERIODS: OpeningPeriod[] = [
  { open: '11:00', close: '15:00' },
  { open: '17:00', close: '22:00' },
]

describe('hours-controls の無効ガードと曜日添字の境界防御', () => {
  it('Weekdays は範囲外の曜日添字を除外し、無効時は変更コールバックを止める', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <Weekdays
        selected={['MONDAY', 'INVALID' as unknown as HoursWeekday]}
        onChange={onChange}
      />,
    )

    expect(screen.getByTestId('weekday-buttons').getAttribute('data-selected')).toBe('0')
    fireEvent.click(screen.getByRole('button', { name: 'pick-weekdays' }))
    expect(onChange).toHaveBeenCalledWith(['MONDAY'])

    onChange.mockClear()
    rerender(<Weekdays selected={['MONDAY']} disabled onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'pick-weekdays' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('PeriodFields は無効時に開店・閉店・削除・追加のコールバック側をすべて止める', () => {
    const onChange = vi.fn()

    render(<PeriodFields value={TWO_PERIODS} disabled onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: '開店 1' }))
    fireEvent.click(screen.getByRole('button', { name: '閉店 1' }))
    fireEvent.click(screen.getByRole('button', { name: '時間帯1を削除' }))
    fireEvent.click(screen.getByRole('button', { name: '時間帯を追加' }))

    expect(onChange).not.toHaveBeenCalled()
  })

  it('PeriodFields は有効時に開店・24時変換・削除・追加を正しく反映する', () => {
    const onChange = vi.fn()

    render(<PeriodFields value={TWO_PERIODS} onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: '開店 1' }))
    expect(onChange).toHaveBeenLastCalledWith([
      { open: '12:00', close: '15:00' },
      { open: '17:00', close: '22:00' },
    ])

    fireEvent.click(screen.getByRole('button', { name: '閉店 2' }))
    expect(onChange).toHaveBeenLastCalledWith([
      { open: '11:00', close: '15:00' },
      { open: '17:00', close: '00:00' },
    ])

    fireEvent.click(screen.getByRole('button', { name: '時間帯1を削除' }))
    expect(onChange).toHaveBeenLastCalledWith([{ open: '17:00', close: '22:00' }])

    fireEvent.click(screen.getByRole('button', { name: '時間帯を追加' }))
    expect(onChange).toHaveBeenLastCalledWith([
      ...TWO_PERIODS,
      { open: '17:00', close: '22:00' },
    ])
  })
})
