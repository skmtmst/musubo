// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AddGrid from './add-blocks'
import { ADD_GROUPS } from './model'

afterEach(cleanup)

describe('AddGrid defensive guards', () => {
  it('omits empty group headings when all cards in a group are hidden', () => {
    const firstGroup = ADD_GROUPS[0]
    const hidden = new Set(firstGroup.cards.map((card) => card.key))
    const { container } = render(<AddGrid onAdd={vi.fn()} hide={hidden} />)
    expect(container.textContent).not.toContain(firstGroup.title)
    if (ADD_GROUPS.length > 1) {
      expect(container.textContent).toContain(ADD_GROUPS[1].title)
    }
  })

  it('renders all groups when hide is omitted', () => {
    const { container } = render(<AddGrid onAdd={vi.fn()} />)
    for (const group of ADD_GROUPS) {
      expect(container.textContent).toContain(group.title)
    }
  })
})
