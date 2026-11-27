// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import StockListHeading from './stock-list-heading'

vi.mock('@/components/shared/date-field', () => ({
  default: ({
    disabled,
    onChange,
  }: {
    disabled?: boolean
    onChange: (value: string) => void
  }) => (
    <button
      type="button"
      data-disabled-prop={String(Boolean(disabled))}
      onClick={() => onChange('2026-11-04')}
    >
      change-stock-date
    </button>
  ),
}))

afterEach(() => {
  cleanup()
})

describe('StockListHeading の処理中日付変更ガード', () => {
  it('処理中は日付変更コールバックを止める', () => {
    const onChange = vi.fn()

    render(<StockListHeading date="2026-11-03" busy onChange={onChange} />)

    const button = screen.getByRole('button', { name: 'change-stock-date' })
    expect(button.getAttribute('data-disabled-prop')).toBe('true')
    fireEvent.click(button)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('待機中は選んだ日付をそのまま通知する', () => {
    const onChange = vi.fn()

    render(<StockListHeading date="2026-11-03" busy={false} onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'change-stock-date' }))
    expect(onChange).toHaveBeenCalledWith('2026-11-04')
  })
})
