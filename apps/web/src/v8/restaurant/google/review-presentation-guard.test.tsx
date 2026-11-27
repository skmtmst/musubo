// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Stars } from './review-presentation'

afterEach(cleanup)

describe('restaurant/google/review-presentation の星評価表示ガード', () => {
  it('評価が NaN や Infinity のときは不正な文字列や仮の星数を作らず未確定として表示する', () => {
    for (const rating of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const { unmount } = render(<Stars rating={rating} />)
      const img = screen.getByRole('img', { name: '評価を確認できません' })
      expect(img.textContent).toBe('—')
      expect(img.getAttribute('aria-label')).not.toContain('NaN')
      expect(img.getAttribute('aria-label')).not.toContain('Infinity')
      unmount()
    }
  })

  it('有効な評価値は星5段階と読み上げラベルをそのまま表示する', () => {
    const { rerender } = render(<Stars rating={2} />)
    const low = screen.getByRole('img', { name: '評価 2／5' })
    expect(low.textContent).toBe('★★☆☆☆')

    rerender(<Stars rating={4} small />)
    const high = screen.getByRole('img', { name: '評価 4／5' })
    expect(high.textContent).toBe('★★★★☆')
  })
})
