// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import LineBubbleThumb from './line-bubble-thumb'
import type { BubbleThumb } from './line-bubble-thumb-model'

afterEach(cleanup)

function draw(thumb: BubbleThumb) {
  const { container } = render(<LineBubbleThumb thumb={thumb} />)
  return container.firstElementChild as HTMLElement
}

describe('LineBubbleThumb の異常値フォールバックガード', () => {
  it.each(['', '   ', 'http://example.com/a.jpg', 'javascript:alert(1)'])(
    '画像のURLが安全な https 以外（%s）のときは壊れた画像タグを出さず「画像」にする',
    (src) => {
      const root = draw({ kind: 'image', src })
      expect(root.querySelector('img')).toBeNull()
      expect(root.textContent).toBe('画像')
    },
  )

  it('空白だけの題名は空欄のままにせず種類名へフォールバックする', () => {
    expect(draw({ kind: 'card', title: '   ' }).textContent).toBe('カード型')
    expect(draw({ kind: 'rich_message', title: '  \t ' }).textContent).toBe('リッチメッセージ')
    expect(draw({ kind: 'rich_video', title: '   ' }).textContent).toBe('リッチビデオ')
    expect(draw({ kind: 'carousel', title: '   ', count: 2 }).textContent).toBe('カルーセル2枚')
    expect(draw({ kind: 'question', text: '   ', choices: 3 }).textContent).toBe('質問選択肢 3')
  })

  it('カルーセル枚数や選択肢数が不正値・負数のときは壊れた件数表示を出さない', () => {
    expect(draw({ kind: 'carousel', title: '特集', count: Number.NaN }).textContent).toBe('特集')
    expect(draw({ kind: 'carousel', title: '特集', count: -1 }).textContent).toBe('特集')
    expect(draw({ kind: 'question', text: 'ご用途は？', choices: Number.POSITIVE_INFINITY }).textContent).toBe('ご用途は？')
    expect(draw({ kind: 'question', text: 'ご用途は？', choices: -2 }).textContent).toBe('ご用途は？')
  })

  it('本文が空白だけのテキスト吹き出しは「本文がありません」と薄字表示にする', () => {
    const root = draw({ kind: 'text', text: '   ' })
    expect(root.textContent).toBe('本文がありません')
    expect(root.dataset.tone).toBe('muted')
  })
})
