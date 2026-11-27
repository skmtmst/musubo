import { describe, expect, it } from 'vitest'
import { dimPanels, type Rect, type Viewport } from './guide-overlay-geometry'

const VIEWPORT: Viewport = { width: 1440, height: 800 }

function assertInsideViewport(panels: Rect[], viewport: Viewport) {
  for (const panel of panels) {
    expect(panel.left).toBeGreaterThanOrEqual(0)
    expect(panel.top).toBeGreaterThanOrEqual(0)
    expect(panel.width).toBeGreaterThan(0)
    expect(panel.height).toBeGreaterThan(0)
    expect(panel.left + panel.width).toBeLessThanOrEqual(viewport.width)
    expect(panel.top + panel.height).toBeLessThanOrEqual(viewport.height)
  }
}

describe('onboarding/guide-overlay-geometry の画面外ターゲット暗幕ガード', () => {
  it.each<[string, Rect]>([
    ['画面の上外', { left: 100, top: -120, width: 100, height: 40 }],
    ['画面の下外', { left: 100, top: 1200, width: 100, height: 40 }],
    ['画面の左外', { left: -240, top: 100, width: 100, height: 40 }],
    ['画面の右外', { left: 1600, top: 100, width: 100, height: 40 }],
  ])('対象が%sにあるときも暗幕が負座標や画面外へはみ出さない', (_label, target) => {
    const panels = dimPanels(target, VIEWPORT)
    expect(panels.length).toBeGreaterThan(0)
    assertInsideViewport(panels, VIEWPORT)
  })

  it('ビューポート寸法が 0 以下または非有限値のときは暗幕を返さない', () => {
    expect(dimPanels({ left: 10, top: 10, width: 50, height: 30 }, { width: 0, height: 800 })).toEqual([])
    expect(dimPanels({ left: 10, top: 10, width: 50, height: 30 }, { width: Number.NaN, height: 800 })).toEqual([])
  })
})
