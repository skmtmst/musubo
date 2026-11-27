// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MenuContent, MetricValue } from './create-preview'

afterEach(() => {
  cleanup()
})

describe('create-preview の寸法整合と非有限値防御', () => {
  it('MetricValue は非有限値を NaN人 にせず数えられませんと表示する', () => {
    const { rerender, container } = render(
      <MetricValue metric={{ state: 'available', value: Number.NaN }} />,
    )
    expect(container.textContent).toBe('数えられません')

    rerender(<MetricValue metric={{ state: 'available', value: 1234 }} />)
    expect(container.textContent).toBe('1,234人')
  })

  it('MenuContent は compact サイズの画像に 2500×843 の寸法を与え、不正座標でも NaN% を出さない', () => {
    const { container } = render(
      <MenuContent
        size="compact"
        imageUrl="/sample-menu.png"
        areas={[
          { x: Number.NaN, y: -100, w: 5000, h: 421.5, label: '予約' },
        ]}
        pages={[{ id: 'p1', name: '1枚目' }]}
        activePageId="p1"
      />,
    )

    const img = screen.getByRole('img', { name: 'メニューの画像' })
    expect(img.getAttribute('width')).toBe('2500')
    expect(img.getAttribute('height')).toBe('843')

    const box = container.querySelector('[style*="left:"]') as HTMLElement
    expect(box.style.left).toBe('0%')
    expect(box.style.top).toBe('0%')
    expect(box.style.width).toBe('100%')
    expect(box.style.height).toBe('50%')
  })
})
