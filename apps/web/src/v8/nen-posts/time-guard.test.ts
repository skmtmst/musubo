import { describe, expect, it } from 'vitest'
import { formatPhotoReceivedAt } from './time'

describe('nen-posts/time のオフセットなしUTC・数値時刻・異常値ガード', () => {
  it('SQLite 形式のオフセットなし UTC 文字列を端末の地域に左右されず日本時間で表示する', () => {
    expect(formatPhotoReceivedAt('2026-08-22 09:22:00')).toBe('8月22日 18:22')
    expect(formatPhotoReceivedAt(' 2026-08-22T09:22:00 ')).toBe('8月22日 18:22')
  })

  it('エポックミリ秒の数値を日本時間で表示し、NaN・Infinity・非日時型は — にする', () => {
    expect(formatPhotoReceivedAt(Date.UTC(2026, 7, 22, 9, 22))).toBe('8月22日 18:22')
    expect(formatPhotoReceivedAt(new Date(Date.UTC(2026, 7, 22, 9, 22)))).toBe('8月22日 18:22')
    expect(formatPhotoReceivedAt(Number.NaN)).toBe('—')
    expect(formatPhotoReceivedAt(Number.POSITIVE_INFINITY)).toBe('—')
    expect(formatPhotoReceivedAt('   ')).toBe('—')
    expect(formatPhotoReceivedAt(true)).toBe('—')
    expect(formatPhotoReceivedAt({})).toBe('—')
  })
})
