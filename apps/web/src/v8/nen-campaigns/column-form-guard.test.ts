import { describe, expect, it } from 'vitest'
import { EMPTY_DRAFT, publishedAtIso, toCreateInput, validateDraft } from './column-form'

describe('nen-campaigns/column-form の実在日時・空白タグIDガード', () => {
  it('存在しない日付や不正時刻は ISO に変換せず null を返す', () => {
    expect(publishedAtIso('2026-02-31T10:00')).toBeNull()
    expect(publishedAtIso('2026-13-01T10:00')).toBeNull()
    expect(publishedAtIso('2026-11-27T25:99')).toBeNull()
    expect(publishedAtIso('2026-11-27T09:30')).toBe('2026-11-27T09:30:00+09:00')
  })

  it('タグ絞り込みで空白だけのタグIDや実在しない配信日時は検証エラーで止める', () => {
    const errors = validateDraft({
      ...EMPTY_DRAFT,
      title: '冬の健康ケア',
      articleUrl: 'https://example.com/column/1',
      targetMode: 'tag',
      targetTagId: '   ',
      scheduledAt: '2026-02-31T10:00',
    })
    expect(errors.map((e) => e.field)).toContain('targetTagId')
    expect(errors.map((e) => e.field)).toContain('scheduledAt')
    expect(toCreateInput({ ...EMPTY_DRAFT, title: '題名', articleUrl: 'https://example.com/a', targetMode: 'tag', targetTagId: '   ' }).targetTagId).toBeNull()
  })
})
