import { describe, expect, it } from 'vitest'
import { followupHasMessage, type FollowupDraftContent } from './followup-guide-draft'

describe('followupHasMessage 非配列・欠損 content の防御', () => {
  it('bubbles が非配列や要素/content が欠損していても落ちずに false を返す', () => {
    expect(followupHasMessage(null as unknown as FollowupDraftContent['bubbles'])).toBe(false)
    expect(followupHasMessage(undefined as unknown as FollowupDraftContent['bubbles'])).toBe(false)
    expect(followupHasMessage([null as unknown as FollowupDraftContent['bubbles'][number]])).toBe(false)
    expect(
      followupHasMessage([
        { id: 'b-1', type: 'text', content: null } as unknown as FollowupDraftContent['bubbles'][number],
      ]),
    ).toBe(false)
  })

  it('正常なテキスト吹き出しと空テキストを正しく判定する', () => {
    expect(
      followupHasMessage([
        { id: 'b-1', type: 'text', content: { text: 'ご来店ありがとうございました' } } as FollowupDraftContent['bubbles'][number],
      ]),
    ).toBe(true)
    expect(
      followupHasMessage([
        { id: 'b-1', type: 'text', content: { text: '   ' } } as FollowupDraftContent['bubbles'][number],
      ]),
    ).toBe(false)
  })
})
