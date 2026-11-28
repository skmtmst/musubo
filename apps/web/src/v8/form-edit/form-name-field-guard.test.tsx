// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FormNameField } from './form-name-field'

afterEach(cleanup)

describe('FormNameField defensive guards', () => {
  it('displays 未設定 in readOnly mode when value is whitespace-only or non-string', () => {
    const { container, rerender } = render(
      <FormNameField value="   " error={null} readOnly onChange={vi.fn()} />,
    )
    expect(container.querySelector('dd')?.textContent).toBe('未設定')

    rerender(<FormNameField value={null as unknown as string} error={null} readOnly onChange={vi.fn()} />)
    expect(container.querySelector('dd')?.textContent).toBe('未設定')

    rerender(<FormNameField value="来店アンケート" error={null} readOnly onChange={vi.fn()} />)
    expect(container.querySelector('dd')?.textContent).toBe('来店アンケート')
  })

  it('normalizes null/undefined editable value to empty string in TextField', () => {
    const { container } = render(
      <FormNameField value={undefined as unknown as string} error={null} onChange={vi.fn()} />,
    )
    const input = container.querySelector<HTMLInputElement>('#fe-name')
    expect(input?.value).toBe('')
  })
})
