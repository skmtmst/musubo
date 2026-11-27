// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BookingMonthBar, BookingUrlCopy } from './month-bar'

afterEach(cleanup)

describe('BookingMonthBar & BookingUrlCopy defensive guards', () => {
  it('hides month navigation when monthLabel is whitespace-only and trims valid labels', () => {
    const { container, rerender } = render(
      <BookingMonthBar monthLabel="   " urls={<span>URL</span>} />,
    )
    expect(container.querySelector('[role="group"][aria-label="表示する月"]')).toBeNull()

    rerender(<BookingMonthBar monthLabel=" 2026年10月 " urls={<span>URL</span>} />)
    expect(container.querySelector('[role="group"][aria-label="表示する月"]')).toBeTruthy()
    expect(container.querySelector('strong')?.textContent).toBe('2026年10月')
  })

  it('uses a fallback accessible label in BookingUrlCopy when label is blank', () => {
    const { container } = render(
      <BookingUrlCopy label="   " copied={false} onCopy={vi.fn()} />,
    )
    const button = container.querySelector('button')
    expect(button?.getAttribute('aria-label')).toBe('URLをコピーする')
  })
})
