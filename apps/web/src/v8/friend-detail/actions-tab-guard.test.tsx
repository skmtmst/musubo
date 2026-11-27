// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import ActionsTab from './actions-tab'

afterEach(cleanup)

describe('ActionsTab defensive guards', () => {
  it('omits broken history link when friendId is blank or non-string', () => {
    const { container, rerender } = render(<ActionsTab friendId="   " />)
    expect(container.querySelectorAll('a')).toHaveLength(0)

    rerender(<ActionsTab friendId={undefined as unknown as string} />)
    expect(container.querySelectorAll('a')).toHaveLength(0)
  })

  it('builds a trimmed, encoded history tab link for a valid friendId', () => {
    const { container } = render(<ActionsTab friendId=" f/1 " />)
    const link = container.querySelector('a')
    expect(link?.getAttribute('href')).toBe('/friends/detail?id=f%2F1&tab=history')
  })
})
