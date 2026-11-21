/*
 * 受信箱を上の絞り込みを選んだ状態で開く URL の指定。統括からは期限超過の道で来る。
 */
import { describe, expect, it } from 'vitest'
import { INBOX_OVERDUE_HREF, inboxQuickFilterFromParam } from './overdue-link'

describe('inboxQuickFilterFromParam', () => {
  it('期限超過・要返信を読み、知らない値・無い値はすべてにする', () => {
    expect(inboxQuickFilterFromParam('overdue')).toBe('overdue')
    expect(inboxQuickFilterFromParam(' reply ')).toBe('reply')
    expect(inboxQuickFilterFromParam('all')).toBe('all')
    expect(inboxQuickFilterFromParam('soon')).toBe('all')
    expect(inboxQuickFilterFromParam(null)).toBe('all')
  })
  it('統括からの道は受信箱の期限超過を指す', () => {
    const url = new URL(INBOX_OVERDUE_HREF, 'https://admin.invalid')
    expect(url.pathname).toBe('/chats')
    expect(inboxQuickFilterFromParam(url.searchParams.get('quick'))).toBe('overdue')
  })
})
