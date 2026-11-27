// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import CarouselOrderChip from './carousel-order-chip'

afterEach(cleanup)

describe('CarouselOrderChip の異常値フォールバックガード', () => {
  it('エラー数が負数や非数のときは読み上げ名に不正な件数を出さない', () => {
    const first = render(<CarouselOrderChip index={0} label="商品A" src="" errorCount={-2} />)
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('商品A')
    first.unmount()

    render(<CarouselOrderChip index={0} label="商品A" src="" errorCount={Number.POSITIVE_INFINITY} />)
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('商品A')
  })

  it('番号が負数や非数・題名が空白だけのときは「カード1」へ補って表示する', () => {
    render(<CarouselOrderChip index={Number.NaN} label="   " src="" errorCount={2} />)
    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-label')).toBe('カード1（直す欄が2か所）')
    expect(button.textContent).toContain('カード1')
  })
})
