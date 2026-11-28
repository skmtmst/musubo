/*
  スポットライトと吹き出しの置き場所の計算だけ。DOM を触らない（単体で確かめられるように分ける）。
  承認済み Pen 枠 04-1 (dQfu4) の実寸に合わせる:
  ・暗幕は対象の穴の上下左右に4枚（対象だけ明るく残す）
  ・光の輪は対象を 6px ふくらませた形
  ・吹き出しは幅340、輪の右 20px の所、上は輪より 6px 上
*/

export type Rect = { left: number; top: number; width: number; height: number }
export type Viewport = { width: number; height: number }

/** 対象を囲む光の輪。Pen 04-1 IzuXL は対象の穴(276,312,106×43)を6pxふくらませた(270,306,118×55)。 */
export const SPOTLIGHT_INFLATE = 6
export const BALLOON_WIDTH = 340
/** 輪と吹き出しの間。Pen 04-1 は輪の右端388→吹き出し408。 */
const BALLOON_GAP = 20
/** 画面の端に寄せすぎない余白。 */
const EDGE = 16

export function spotlightRing(target: Rect, inflate = SPOTLIGHT_INFLATE): Rect {
  return {
    left: target.left - inflate,
    top: target.top - inflate,
    width: target.width + inflate * 2,
    height: target.height + inflate * 2,
  }
}

/** 対象の穴を残した暗幕4枚（上・左・右・下）。負の大きさや画面外へのはみ出しを作らない。 */
export function dimPanels(target: Rect, viewport: Viewport): Rect[] {
  const vw = Number.isFinite(viewport.width) ? Math.max(0, viewport.width) : 0
  const vh = Number.isFinite(viewport.height) ? Math.max(0, viewport.height) : 0
  if (vw <= 0 || vh <= 0) return []
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
  const rawTop = Number.isFinite(target.top) ? target.top : 0
  const rawLeft = Number.isFinite(target.left) ? target.left : 0
  const rawWidth = Number.isFinite(target.width) ? Math.max(0, target.width) : 0
  const rawHeight = Number.isFinite(target.height) ? Math.max(0, target.height) : 0
  const top = clamp(rawTop, 0, vh)
  const bottom = clamp(rawTop + rawHeight, top, vh)
  const left = clamp(rawLeft, 0, vw)
  const right = clamp(rawLeft + rawWidth, left, vw)
  const band = Math.max(0, bottom - top)
  return [
    { left: 0, top: 0, width: vw, height: top },
    { left: 0, top, width: left, height: band },
    { left: right, top, width: Math.max(0, vw - right), height: band },
    { left: 0, top: bottom, width: vw, height: Math.max(0, vh - bottom) },
  ].filter(panel => panel.width > 0 && panel.height > 0)
}

export type BalloonPlacement = { left: number; top: number; side: 'right' | 'left' | 'below' }

/**
 * 吹き出しの置き場所。**対象を覆わない所に置く**（枠14 共通ルール izsr5）。
 * 右に入らなければ左、どちらも入らなければ対象の下に出す。
 */
export function balloonPlacement(target: Rect, viewport: Viewport, balloonHeight: number, width = BALLOON_WIDTH): BalloonPlacement {
  const ring = spotlightRing(target)
  const clampTop = (value: number) =>
    Math.max(EDGE, Math.min(value, Math.max(EDGE, viewport.height - balloonHeight - EDGE)))

  const rightLeft = ring.left + ring.width + BALLOON_GAP
  if (rightLeft + width + EDGE <= viewport.width) {
    return { left: rightLeft, top: clampTop(ring.top), side: 'right' }
  }
  const leftLeft = ring.left - BALLOON_GAP - width
  if (leftLeft >= EDGE) {
    return { left: leftLeft, top: clampTop(ring.top), side: 'left' }
  }
  const centered = ring.left + ring.width / 2 - width / 2
  return {
    left: Math.max(EDGE, Math.min(centered, Math.max(EDGE, viewport.width - width - EDGE))),
    top: clampTop(ring.top + ring.height + BALLOON_GAP),
    side: 'below',
  }
}

/** 対象が画面の外なら真。枠14 共通ルール「対象が画面外なら自動スクロール」の判定。 */
export function isOffScreen(target: Rect, viewport: Viewport): boolean {
  return target.top < EDGE || target.top + target.height > viewport.height - EDGE
}
