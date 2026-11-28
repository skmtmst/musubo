import { beforeEach, describe, expect, it, vi } from 'vitest'
import { actionSummary, displayName, type AutoReply } from './list-model'

describe('auto-replies list-model の欠損値・空白保護', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('displayName は空オブジェクトや欠損 keyword でも undefined を返さず安全に文字列を返す', () => {
    expect(displayName({} as AutoReply)).toBe('')
    expect(displayName(null as unknown as AutoReply)).toBe('')
    expect(displayName({ name: '   ', respondToAll: true, keyword: '' } as AutoReply)).toBe('すべてのメッセージ')
    expect(displayName({ name: '   ', respondToAll: false, keyword: '予約' } as AutoReply)).toBe('予約')
    expect(displayName({ name: '営業時間案内', respondToAll: false, keyword: '営業' } as AutoReply)).toBe('営業時間案内')
  })

  it('actionSummary は rule 欠損や空白のみの actionType を安全に除外する', () => {
    expect(actionSummary(null as unknown as { actions: unknown[] | null })).toEqual([])
    expect(actionSummary({ actions: [{ actionType: '' }, { actionType: '   ' }, { action_type: 'tag' }] })).toEqual([
      'タグ',
    ])
  })
})
