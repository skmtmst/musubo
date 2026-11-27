// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SampleMenuTiles } from './sample-menu'
import type { StarterButton } from './use-starter-menu'

afterEach(cleanup)

const duplicateButtons: StarterButton[] = [
  { feature: 'booking', label: '予約', bounds: { x: 0, y: 0, width: 1250, height: 843 } },
  { feature: 'hours', label: '予約', bounds: { x: 1250, y: 843, width: 1250, height: 843 } },
]

describe('SampleMenuTiles の画像寸法・URL・重複キーの守り', () => {
  it('imageHeight が 0 や NaN でも Infinity/NaN の座標を出さず、既定高さ 1686 で計算する', () => {
    const { container } = render(
      <SampleMenuTiles
        style="restaurant"
        buttons={duplicateButtons}
        imageUrl="/media/menu.png"
        imageHeight={0}
        onSelect={vi.fn()}
      />,
    )

    const grid = container.firstElementChild as HTMLElement
    expect(grid.style.aspectRatio).toBe('2500 / 1686')
    expect(grid.style.backgroundImage).toContain('/media/menu.png')

    const buttons = screen.getAllByRole('button', { name: '予約' })
    expect(buttons).toHaveLength(2)
    expect(buttons[1].style.top).toBe('50%')
    expect(buttons[1].style.height).toBe('50%')
    expect(buttons[1].style.top).not.toContain('Infinity')
    expect(buttons[1].style.height).not.toContain('NaN')
  })

  it('空白だけの imageUrl はカスタム画像として扱わず、同名ボタンでも重複キー警告を出さない', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { container } = render(
        <SampleMenuTiles
          style="restaurant"
          buttons={duplicateButtons}
          imageUrl="   "
          onSelect={vi.fn()}
        />,
      )

      const grid = container.firstElementChild as HTMLElement
      expect(grid.hasAttribute('data-image')).toBe(false)
      expect(grid.style.backgroundImage).toBe('')
      const keyWarnings = errorSpy.mock.calls.filter((args) =>
        args.some((arg) => typeof arg === 'string' && arg.includes('same key')),
      )
      expect(keyWarnings).toHaveLength(0)
    } finally {
      errorSpy.mockRestore()
    }
  })
})
