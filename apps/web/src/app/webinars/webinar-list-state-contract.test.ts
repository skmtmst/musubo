import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { describe, expect, it } from 'vitest'

import { ApiError } from '@/lib/api'

import { webinarLoadFailure } from '@/v8/webinars/helpers'

const PAGE = readFileSync(new URL('./list-v8.tsx', import.meta.url), 'utf8')

/**
 * ウェビナー一覧（設計 `ZC13r` 10-1 ／ `zCQXe` 10-1-L）の、
 * 中身が出せないときの見え方。
 *
 * **一覧が読めなかったのに「0件」と出ると、登録したものが消えたように
 * 見える。** 直し方も状態ごとに違う——権限不足は誰かに足してもらう、
 * 混み合いは待つ、通信は確かめる。
 */
describe('読み込めなかった理由の見分け', () => {
  it('権限不足は、読み直しの口を出さない', () => {
    /* 403 は何度押しても直らない。「もう一度読み込む」は誤った道案内になる。 */
    const failure = webinarLoadFailure(new ApiError(403, 'Forbidden'))
    expect(failure.kind).toBe('forbidden')
    expect(failure.retryable).toBe(false)
    expect(failure.title).toBe('ウェビナーを見る権限がありません')
  })

  it('混み合いは、待てば直ると言う', () => {
    const failure = webinarLoadFailure(new ApiError(429, 'Too Many Requests'))
    expect(failure.kind).toBe('error')
    expect(failure.retryable).toBe(true)
    expect(failure.description).toContain('少し待ってから')
  })

  it('それ以外は通信を確かめてもらう', () => {
    for (const thrown of [new ApiError(500, 'boom'), new Error('network'), 'なにか']) {
      const failure = webinarLoadFailure(thrown)
      expect(failure.kind).toBe('error')
      expect(failure.retryable).toBe(true)
      expect(failure.title).toBe('ウェビナーを表示できませんでした')
    }
  })

  it('どの理由でも、内部の語をそのまま画面へ出さない', () => {
    for (const thrown of [new ApiError(500, 'API error: 500'), new Error('fetch failed')]) {
      const failure = webinarLoadFailure(thrown)
      for (const text of [failure.title, failure.description]) {
        expect(text).not.toMatch(/API error|fetch|undefined|NaN/)
      }
    }
  })
})

describe('一覧の状態（設計 10-1-L `zCQXe`）', () => {
  it('読めていないときはページ送りを出さない（頁が2以上かでは決めない）', () => {
    expect(PAGE).not.toContain('hasListData && pageCount > 1')
  })
})
