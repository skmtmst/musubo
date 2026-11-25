// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { GoogleMark, InstagramMark } from './brand-marks'

afterEach(cleanup)

describe('公式ブランドマークの共通部品', () => {
  it('InstagramMark は公式グラデーションのカメラマークを固有の gradient ID で描く', () => {
    const { container } = render(
      <>
        <InstagramMark size={22} />
        <InstagramMark size={18} />
      </>,
    )
    const svgs = container.querySelectorAll('svg[data-brand-mark="instagram"]')
    expect(svgs).toHaveLength(2)
    expect(svgs[0]?.getAttribute('width')).toBe('22')
    expect(svgs[1]?.getAttribute('width')).toBe('18')
    const gradients = container.querySelectorAll('radialGradient')
    expect(gradients).toHaveLength(2)
    const firstId = gradients[0]?.getAttribute('id')
    const secondId = gradients[1]?.getAttribute('id')
    expect(firstId).toBeTruthy()
    expect(secondId).toBeTruthy()
    expect(firstId).not.toBe(secondId)
    expect(svgs[0]?.querySelector('path')?.getAttribute('fill')).toBe(`url(#${firstId})`)
    expect(svgs[1]?.querySelector('path')?.getAttribute('fill')).toBe(`url(#${secondId})`)
    const stops = Array.from(gradients[0]!.querySelectorAll('stop')).map((stop) => stop.getAttribute('stop-color'))
    expect(stops).toEqual(['#FDF497', '#FDF497', '#FD5949', '#D6249F', '#285AEB'])
  })

  it('GoogleMark は公式 4 色の G マークを描く', () => {
    const { container } = render(<GoogleMark size={20} />)
    const svg = container.querySelector('svg[data-brand-mark="google"]')
    expect(svg).toBeTruthy()
    expect(svg?.getAttribute('width')).toBe('20')
    const fills = Array.from(svg!.querySelectorAll('path')).map((path) => path.getAttribute('fill'))
    expect(fills).toEqual(['#EA4335', '#4285F4', '#FBBC05', '#34A853'])
  })
})
