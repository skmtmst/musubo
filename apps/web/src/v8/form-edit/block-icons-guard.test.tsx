// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { HelpCircle } from 'lucide-react'
import { afterEach, describe, expect, it } from 'vitest'
import type { FormBlock } from '@line-crm/shared'
import { formBlockIcon, formKindIcon } from './block-icons'

afterEach(cleanup)

describe('form-edit block-icons defensive guards', () => {
  it('returns HelpCircle instead of Object.prototype methods for prototype keys', () => {
    expect(formKindIcon('toString')).toBe(HelpCircle)
    expect(formKindIcon('constructor')).toBe(HelpCircle)
    expect(formKindIcon('valueOf')).toBe(HelpCircle)
    expect(formKindIcon(null as unknown as string)).toBe(HelpCircle)
  })

  it('renders safely when given a null block or prototype block kind', () => {
    const { container } = render(
      <>
        {formBlockIcon(null as unknown as FormBlock)}
        {formBlockIcon({ kind: 'toString' } as unknown as FormBlock)}
      </>,
    )
    expect(container.querySelectorAll('svg')).toHaveLength(2)
  })
})
