import { describe, expect, it } from 'vitest'
import { balloonPlacement, dimPanels, isOffScreen, spotlightRing } from './guide-overlay-geometry'

/*
  承認済み Pen 枠 04-1 (dQfu4) の実値で確かめる。
  対象の穴 (276,312,106×43) → 光の輪 (270,306,118×55) → 吹き出し (408,300)。
*/
const target = { left: 276, top: 312, width: 106, height: 43 }
const viewport = { width: 1440, height: 1000 }

describe('スポットライトの形', () => {
  it('対象を6pxふくらませた輪にする（Pen 04-1 IzuXL）', () => {
    expect(spotlightRing(target)).toEqual({ left: 270, top: 306, width: 118, height: 55 })
  })

  it('暗幕は対象の穴を残して上下左右を覆う', () => {
    const panels = dimPanels(target, viewport)
    expect(panels).toEqual([
      { left: 0, top: 0, width: 1440, height: 312 },
      { left: 0, top: 312, width: 276, height: 43 },
      { left: 382, top: 312, width: 1058, height: 43 },
      { left: 0, top: 355, width: 1440, height: 645 },
    ])
  })

  it('対象が画面の端に寄っていても負の大きさの暗幕を作らない', () => {
    const panels = dimPanels({ left: -20, top: -10, width: 100, height: 40 }, viewport)
    expect(panels.every(panel => panel.width > 0 && panel.height > 0)).toBe(true)
  })
})

describe('吹き出しの置き場所', () => {
  it('右に入るなら輪の右20pxへ置く（Pen 04-1 mkzrI）', () => {
    expect(balloonPlacement(target, viewport, 160)).toEqual({ left: 408, top: 306, side: 'right' })
  })

  it('右に入らないなら左へ逃がし、対象を覆わない', () => {
    const placement = balloonPlacement({ left: 1200, top: 300, width: 160, height: 50 }, viewport, 160)
    expect(placement.side).toBe('left')
    expect(placement.left + 340).toBeLessThanOrEqual(1200 - 6)
  })

  it('左右とも入らないなら対象の下へ出す', () => {
    const narrow = { width: 400, height: 900 }
    const placement = balloonPlacement({ left: 40, top: 100, width: 320, height: 50 }, narrow, 160)
    expect(placement.side).toBe('below')
    expect(placement.top).toBeGreaterThan(100 + 50)
  })

  it('画面の下にはみ出す位置には置かない', () => {
    const placement = balloonPlacement({ left: 276, top: 960, width: 106, height: 43 }, viewport, 200)
    expect(placement.top + 200).toBeLessThanOrEqual(1000)
  })
})

describe('画面外の判定', () => {
  it('上にも下にもはみ出していれば自動スクロールの対象にする', () => {
    expect(isOffScreen(target, viewport)).toBe(false)
    expect(isOffScreen({ ...target, top: -5 }, viewport)).toBe(true)
    expect(isOffScreen({ ...target, top: 990 }, viewport)).toBe(true)
  })
})
