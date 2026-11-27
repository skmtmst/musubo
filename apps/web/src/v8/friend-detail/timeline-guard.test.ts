import { describe, expect, it } from 'vitest'
import { dayHeading, dayKey, timelineSourceHref, type FriendTimelineItem } from './timeline'

function makeItem(url: string | null): FriendTimelineItem {
  return {
    id: 'item-1',
    type: 'ec_order',
    summary: '注文',
    status: 'current',
    source: {
      kind: 'ec_order',
      id: 'ord-1',
      parentId: null,
      url,
    },
    occurredAt: '2026-11-28T00:00:00Z',
    lineAccount: null,
  }
}

describe('friend-detail/timeline ガード', () => {
  it('javascript: や data: など危険な外部 URL スキームを拒否し、安全な https/http URL のみリンク化する', () => {
    expect(timelineSourceHref(makeItem('javascript:alert(1)'), 'f-1')).toBeNull()
    expect(timelineSourceHref(makeItem('data:text/html,<h1>x</h1>'), 'f-1')).toBeNull()
    expect(timelineSourceHref(makeItem('https://example.com/orders/1'), 'f-1')).toEqual({
      href: 'https://example.com/orders/1',
      external: true,
      label: '注文',
    })
  })

  it('不正な日時や Invalid Date の基準時刻で RangeError を出さず、空キー同士で「今日 —」と誤認しない', () => {
    expect(dayKey('invalid-date')).toBe('')
    expect(dayHeading('invalid-date', new Date('invalid'))).toBe('—')
    expect(dayHeading('2026-11-28T00:00:00Z', new Date('invalid'))).not.toContain('今日')
  })
})
