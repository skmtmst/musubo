import { describe, expect, it } from 'vitest'
import { scopeLabel, tokenDate, tokenUsedAt } from './api-tokens'

/* ★V8 外部連携 API 接続：表の日時は絵の書き方（作った日 2026/06/02・最後に使った 09/30 10:02）。 */
describe('API 接続（V8）', () => {
  it('作った日は年/月/日（日本の日付）', () => {
    expect(tokenDate('2026-06-01T15:30:00.000Z')).toBe('06/02')
    expect(tokenDate(null)).toBe('—')
    expect(tokenDate('こわれた値')).toBe('—')
  })

  it('最後に使ったは 月/日 時:分、まだなら「まだ使っていません」', () => {
    expect(tokenUsedAt('2026-09-30T01:02:00.000Z')).toBe('09/30 10:02')
    expect(tokenUsedAt(null)).toBe('まだ使っていません')
  })

  it('できることは日本語の名前（知らない値はそのまま）', () => {
    expect(scopeLabel('tags:read')).toBe('タグを見る')
    expect(scopeLabel('tags:write')).toBe('タグを付ける')
    expect(scopeLabel('friends:read')).toBe('friends:read')
  })
})


it.each(['constructor', 'toString', '__proto__', 'future'])('未知の接続権限 %s を文字として表示する', value => {
  expect(scopeLabel(value)).toBe(value)
})
