// @vitest-environment happy-dom
import { render, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import MusuboLogo from './musubo-logo'

afterEach(cleanup)
describe('公式ロゴの画素密度', () => {
  it.each([['auth', 188], ['ops', 176], ['mobile', 95], ['staff', 140]] as const)('%s の1倍・2倍・3倍画像を指定する', (size, width) => {
    const { getByRole } = render(<MusuboLogo size={size} />)
    const img = getByRole('img', { name: 'musubo' })
    expect(img.getAttribute('src')).toBe(`/brand/musubo-color-${width}-1x.png`)
    expect(img.getAttribute('srcset')).toBe([1, 2, 3].map(density => `/brand/musubo-color-${width}-${density}x.png ${density}x`).join(', '))
    expect(img.getAttribute('width')).toBe('3020')
    expect(img.getAttribute('height')).toBe('890')
  })
})
