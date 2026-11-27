// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MarkBasicFields from './mark-basic-fields'

vi.mock('@/components/shared/folder-color-button', () => ({
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
      onClick={() => onChange('#2563D4')}
    >
      pick-blue
    </button>
  ),
}))

afterEach(() => {
  cleanup()
})

describe('MarkBasicFields の無効時コールバックガード', () => {
  it('無効時はマーク名と色の変更コールバックを両方とも止める', () => {
    const onName = vi.fn()
    const onColor = vi.fn()

    render(
      <MarkBasicFields
        name="要確認"
        color="#EF4B55"
        disabled
        onName={onName}
        onColor={onColor}
      />,
    )

    const input = screen.getByRole('textbox', { name: 'マーク名' }) as HTMLInputElement
    expect(input.disabled).toBe(true)
    input.removeAttribute('disabled')
    fireEvent.change(input, { target: { value: '対応中' } })

    const colorBtn = screen.getByRole('button', { name: 'pick-blue' })
    expect(colorBtn.getAttribute('data-disabled-prop')).toBe('true')
    fireEvent.click(colorBtn)

    expect(onName).not.toHaveBeenCalled()
    expect(onColor).not.toHaveBeenCalled()
  })

  it('有効時はマーク名と色の変更コールバックをそのまま実行する', () => {
    const onName = vi.fn()
    const onColor = vi.fn()

    render(
      <MarkBasicFields
        name="要確認"
        color="#EF4B55"
        disabled={false}
        onName={onName}
        onColor={onColor}
      />,
    )

    fireEvent.change(screen.getByRole('textbox', { name: 'マーク名' }), { target: { value: '対応中' } })
    fireEvent.click(screen.getByRole('button', { name: 'pick-blue' }))

    expect(onName).toHaveBeenCalledWith('対応中')
    expect(onColor).toHaveBeenCalledWith('#2563D4')
  })
})
