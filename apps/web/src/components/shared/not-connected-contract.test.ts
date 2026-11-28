import { describe, expect, it } from 'vitest'

import { NOT_AVAILABLE, STATE_TEXT, countOrDash, notConnectedText } from './not-connected'

describe('未接続の書き方をそろえる', () => {
  it('取れない数字は空欄ではなく — を出す', () => {
    expect(countOrDash(undefined)).toBe(NOT_AVAILABLE)
    expect(countOrDash(null)).toBe(NOT_AVAILABLE)
    expect(countOrDash(Number.NaN)).toBe(NOT_AVAILABLE)
    expect(countOrDash(Number.POSITIVE_INFINITY)).toBe(NOT_AVAILABLE)
    expect(NOT_AVAILABLE).not.toBe('')
  })

  it('数えて0だったことは、取れなかったことと混ぜない', () => {
    expect(countOrDash(0, '人')).toBe('0人')
    expect(countOrDash(0, '人')).not.toBe(NOT_AVAILABLE)
  })

  it('大きい数は桁を区切って読めるようにする', () => {
    expect(countOrDash(12345, '人')).toBe('12,345人')
  })

  it('理由文の形をそろえる', () => {
    expect(notConnectedText('開封の記録')).toBe(
      'まだ繋がっていません。開封の記録が接続されると表示されます。',
    )
  })

  it('状態の言葉を混ぜない', () => {
    // 未接続・読込中・取得失敗・権限不足・実値0 は運用者にとって別物。
    expect(STATE_TEXT.loading).toBe('読み込んでいます')
    expect(STATE_TEXT.error).toBe('読み込めませんでした')
    expect(STATE_TEXT.retry).toBe('再読み込み')
    expect(STATE_TEXT.forbiddenView).toBe('見る権限がありません')
    expect(STATE_TEXT.forbiddenAct).toBe('操作する権限がありません')
    const all = Object.values(STATE_TEXT)
    expect(new Set(all).size).toBe(all.length)
    for (const t of all) expect(t).not.toContain('繋がって')
  })

})
