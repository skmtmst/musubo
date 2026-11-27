// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import RemindersTab from './reminders-tab'

afterEach(cleanup)

describe('RemindersTab defensive guards', () => {
  it('omits broken or unfiltered reminder link when friendId is blank or non-string', () => {
    const { container, rerender } = render(<RemindersTab friendId="   " />)
    expect(container.querySelectorAll('a')).toHaveLength(0)

    rerender(<RemindersTab friendId="" />)
    expect(container.querySelectorAll('a')).toHaveLength(0)

    rerender(<RemindersTab friendId={null as unknown as string} />)
    expect(container.querySelectorAll('a')).toHaveLength(0)
  })

  it('builds a trimmed friend-filtered reminder link for a valid friendId', () => {
    const { container } = render(<RemindersTab friendId=" f-123 " />)
    const link = container.querySelector('a')
    expect(link?.getAttribute('href')).toBe('/reminders?friendId=f-123')
  })
})
