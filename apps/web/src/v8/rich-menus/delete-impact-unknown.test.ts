import { describe, expect, it } from 'vitest'
import { blockerTexts, recommendedActionText, referenceKindText, UNKNOWN_BLOCKER_TEXT } from './delete-impact'

describe('リッチメニューの削除前の確認', () => {
  it.each(['constructor', 'toString', '__proto__', 'future'])('%s を未確認として表示する', value => {
    expect(blockerTexts([value] as Parameters<typeof blockerTexts>[0])).toEqual([UNKNOWN_BLOCKER_TEXT])
    expect(recommendedActionText(value as Parameters<typeof recommendedActionText>[0])).toBe('操作を確認できません。')
    expect(referenceKindText(value as Parameters<typeof referenceKindText>[0])).toBe('使われている場所')
  })
  it('既知の操作を表示する', () => {
    expect(recommendedActionText('delete')).toBe('消せます。')
  })
})
