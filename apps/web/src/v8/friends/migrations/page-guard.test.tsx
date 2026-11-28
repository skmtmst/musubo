// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const searchParamsMock = vi.hoisted(() => vi.fn())
const uidPropsMock = vi.hoisted(() => vi.fn())

vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParamsMock(),
}))

vi.mock('./csv', () => ({
  default: () => <div data-testid="csv-view">csv</div>,
}))

vi.mock('./uid', () => ({
  default: (props: { initialRunId?: string | null }) => {
    uidPropsMock(props)
    return <div data-testid="uid-view">{props.initialRunId ?? 'none'}</div>
  },
}))

import FriendMigrationsV8 from './page'

beforeEach(() => {
  vi.resetAllMocks()
})

afterEach(cleanup)

describe('FriendMigrationsV8 query param guards', () => {
  it('renders CSV view safely when useSearchParams returns null', () => {
    searchParamsMock.mockReturnValue(null)
    const { container } = render(<FriendMigrationsV8 />)
    expect(container.querySelector('[data-testid="csv-view"]')).toBeTruthy()
  })

  it('normalizes whitespace-only run param to null and trims valid tab/run params', () => {
    searchParamsMock.mockReturnValue(new URLSearchParams('tab=uid&run=%20%20%20'))
    const { container, rerender } = render(<FriendMigrationsV8 />)
    expect(container.querySelector('[data-testid="uid-view"]')?.textContent).toBe('none')
    expect(uidPropsMock).toHaveBeenLastCalledWith({ initialRunId: null })

    searchParamsMock.mockReturnValue(new URLSearchParams('tab=%20uid%20&run=%20run-42%20'))
    rerender(<FriendMigrationsV8 />)
    expect(container.querySelector('[data-testid="uid-view"]')?.textContent).toBe('run-42')
    expect(uidPropsMock).toHaveBeenLastCalledWith({ initialRunId: 'run-42' })
  })
})
