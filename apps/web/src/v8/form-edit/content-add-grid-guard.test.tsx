// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { FormBlock } from '@line-crm/shared'
import { ADD_CARD_ICONS, blockIcon } from './content-add-grid'

afterEach(cleanup)

describe('content-add-grid defensive guards', () => {
  it('uses a null-prototype map for ADD_CARD_ICONS so Object.prototype keys return undefined', () => {
    expect(ADD_CARD_ICONS['toString']).toBeUndefined()
    expect(ADD_CARD_ICONS['constructor']).toBeUndefined()
    expect(ADD_CARD_ICONS['valueOf']).toBeUndefined()
    expect(ADD_CARD_ICONS['radio']).toBeTruthy()
  })

  it('renders a fallback icon safely when blockIcon receives null or undefined', () => {
    const { container } = render(
      <>
        {blockIcon(null as unknown as FormBlock)}
        {blockIcon(undefined as unknown as FormBlock)}
      </>,
    )
    expect(container.querySelectorAll('svg')).toHaveLength(2)
  })
})
