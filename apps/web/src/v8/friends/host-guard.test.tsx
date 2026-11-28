// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const searchParamsMock = vi.hoisted(() => vi.fn())

vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParamsMock(),
}))

vi.mock('./list/list', () => ({ default: () => <div data-testid="friends-list">list</div> }))
vi.mock('./merged/merged', () => ({ default: () => <div data-testid="friends-merged">merged</div> }))
vi.mock('./duplicates/list', () => ({ default: () => <div data-testid="friends-duplicates">duplicates</div> }))

import FriendsHostV8 from './host'

beforeEach(() => {
  vi.resetAllMocks()
})

afterEach(cleanup)

describe('FriendsHostV8 query param guards', () => {
  it('falls back to list safely when useSearchParams returns null', () => {
    searchParamsMock.mockReturnValue(null)
    const { container } = render(<FriendsHostV8 />)
    expect(container.querySelector('[data-testid="friends-list"]')).toBeTruthy()
  })

  it('trims whitespace-padded tab query values before routing', () => {
    searchParamsMock.mockReturnValue(new URLSearchParams('tab=%20merged%20'))
    const { container, rerender } = render(<FriendsHostV8 />)
    expect(container.querySelector('[data-testid="friends-merged"]')).toBeTruthy()

    searchParamsMock.mockReturnValue(new URLSearchParams('tab=%20duplicates%20'))
    rerender(<FriendsHostV8 />)
    expect(container.querySelector('[data-testid="friends-duplicates"]')).toBeTruthy()
  })
})
