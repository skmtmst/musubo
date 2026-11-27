import { describe, expect, it } from 'vitest'
import { PHOTO_PAGE_SIZE, photoPagePath } from './review-model'

describe('nen-posts/review-model のページ取得URLガード', () => {
  it('offset が Infinity・NaN・負数や小数のときに不正なクエリを送らず、空白だけの検索語を省く', () => {
    const infUrl = new URL(photoPagePath('acc-1', Number.POSITIVE_INFINITY, '   '), 'https://example.test')
    expect(infUrl.searchParams.get('accountId')).toBe('acc-1')
    expect(infUrl.searchParams.get('limit')).toBe(String(PHOTO_PAGE_SIZE))
    expect(infUrl.searchParams.has('offset')).toBe(false)
    expect(infUrl.searchParams.has('q')).toBe(false)

    const nanUrl = new URL(photoPagePath('acc-1', Number.NaN, ''), 'https://example.test')
    expect(nanUrl.searchParams.has('offset')).toBe(false)

    const floatUrl = new URL(photoPagePath('acc-1', 12.9, ' 柴犬 '), 'https://example.test')
    expect(floatUrl.searchParams.get('offset')).toBe('12')
    expect(floatUrl.searchParams.get('q')).toBe('柴犬')
  })

  it('通常の正の整数 offset と検索語はそのまま渡す', () => {
    const normalUrl = new URL(photoPagePath('acc-1', 200, 'ポメラニアン'), 'https://example.test')
    expect(normalUrl.pathname).toBe('/api/nen-members/photos')
    expect(normalUrl.searchParams.get('offset')).toBe('200')
    expect(normalUrl.searchParams.get('q')).toBe('ポメラニアン')
  })
})
