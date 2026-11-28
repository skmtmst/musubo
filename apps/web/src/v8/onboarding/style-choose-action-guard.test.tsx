// @vitest-environment happy-dom
import type { ReactNode, Ref } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import StyleChooseAction from './style-choose-action'

vi.mock('@/components/shared/button', () => ({
  default: ({
    children,
    disabled,
    onClick,
    ref,
    ...rest
  }: {
    children?: ReactNode
    disabled?: boolean
    onClick?: () => void
    ref?: Ref<HTMLButtonElement>
    [key: string]: unknown
  }) => (
    <button
      ref={ref}
      type="button"
      data-disabled-prop={String(Boolean(disabled))}
      onClick={onClick}
      aria-disabled={rest['aria-disabled'] as 'true' | undefined}
    >
      {children}
    </button>
  ),
}))

afterEach(() => {
  cleanup()
})

describe('StyleChooseAction の無効ガードと保留焦点の整理', () => {
  it('無効時は選択ボタンのコールバック側でも onChoose を止め、焦点も奪わない', () => {
    const onChoose = vi.fn()
    const { rerender } = render(
      <StyleChooseAction
        viewing="restaurant"
        chosen={null}
        onChoose={onChoose}
        disabled
        primary
      />,
    )

    const button = screen.getByRole('button', { name: 'このスタイルにする' })
    expect(button.getAttribute('data-disabled-prop')).toBe('true')
    fireEvent.click(button)
    expect(onChoose).not.toHaveBeenCalled()

    rerender(
      <StyleChooseAction
        viewing="restaurant"
        chosen="restaurant"
        onChoose={onChoose}
        disabled
        primary
      />,
    )
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: '選んでいます' }))
  })

  it('別のスタイルを見に行った場合は古い保留焦点を消し、同じスタイル確定時だけ焦点を移す', () => {
    const onChoose = vi.fn()
    const { rerender } = render(
      <StyleChooseAction
        viewing="restaurant"
        chosen={null}
        onChoose={onChoose}
        disabled={false}
        primary
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'このスタイルにする' }))
    expect(onChoose).toHaveBeenCalledWith('restaurant')

    rerender(
      <StyleChooseAction
        viewing="salon"
        chosen={null}
        onChoose={onChoose}
        disabled={false}
        primary
      />,
    )
    rerender(
      <StyleChooseAction
        viewing="restaurant"
        chosen="restaurant"
        onChoose={onChoose}
        disabled={false}
        primary
      />,
    )
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: '選んでいます' }))

    rerender(
      <StyleChooseAction
        viewing="salon"
        chosen="restaurant"
        onChoose={onChoose}
        disabled={false}
        primary
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'このスタイルにする' }))
    expect(onChoose).toHaveBeenLastCalledWith('salon')

    rerender(
      <StyleChooseAction
        viewing="salon"
        chosen="salon"
        onChoose={onChoose}
        disabled={false}
        primary
      />,
    )
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '選んでいます' }))
  })
})
