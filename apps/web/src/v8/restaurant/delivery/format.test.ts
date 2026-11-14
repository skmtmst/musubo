import { describe, expect, it } from 'vitest'
import { formatDetailStamp, formatElapsed } from './format'

/*
 * 23：受信からの経過は長いとき日に直す。短い表示（分・時間）は今までどおり。
 */
describe('formatElapsed', () => {
  const at = (nowMs: number, minutesAgo: number) => new Date(nowMs - minutesAgo * 60_000).toISOString()
  const nowMs = Date.parse('2026-10-29T12:00:00+09:00')

  it('無い・読めない受信時刻は「—」', () => {
    expect(formatElapsed(null, nowMs)).toBe('—')
    expect(formatElapsed('not-a-date', nowMs)).toBe('—')
  })

  it('1時間未満は分、24時間未満は時間で出す', () => {
    expect(formatElapsed(at(nowMs, 2), nowMs)).toBe('2分')
    expect(formatElapsed(at(nowMs, 18), nowMs)).toBe('18分')
    expect(formatElapsed(at(nowMs, 60), nowMs)).toBe('1時間')
    expect(formatElapsed(at(nowMs, 150), nowMs)).toBe('2時間30分')
  })

  it('長い経過は日に直す（30時間→1日6時間）', () => {
    expect(formatElapsed(at(nowMs, 30 * 60), nowMs)).toBe('1日6時間')
    expect(formatElapsed(at(nowMs, 3 * 24 * 60 + 5), nowMs)).toBe('3日5分')
  })
})

describe('formatDetailStamp（詳細の日時は管理画面共通の書き方）', () => {
  it('今年は M月D日 HH:mm、別の年は年付き、時刻は日本時間', () => {
    expect(formatDetailStamp('2026-10-09T03:02:00Z', '2026-11-08T00:00:00Z')).toBe('10月9日 12:02')
    expect(formatDetailStamp('2024-10-09T03:02:00Z', '2026-11-08T00:00:00Z')).toBe('2024年10月9日 12:02')
  })
  it('値が無い時は —', () => {
    expect(formatDetailStamp(null)).toBe('—')
  })
})
