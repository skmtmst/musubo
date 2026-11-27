import { describe, expect, it } from 'vitest'
import { audienceReason, audienceText, impactFromError, NOT_AVAILABLE } from './delete-impact'

describe('rich-menus/delete-impact の非有限人数・409応答欠損ガード', () => {
  it('表示人数が NaN・Infinity・負数のときは「— 人」にせず未取得として扱う', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const audience = { value, reason: null }
      expect(audienceText(audience)).toBe(NOT_AVAILABLE)
      expect(audienceReason(audience)).toContain('人数は数えられません')
    }
  })

  it('409 の最新影響データで currentAudience や nextDisplay.candidates や group ID が欠けている応答を素通ししない', () => {
    const base = {
      group: { id: 'g1', accountId: 'a1', name: '通常メニュー', status: 'draft' },
      currentAudience: { value: null, reason: 'assignment_ledger_unavailable' },
      nextDisplay: { guaranteedGroupId: null, reason: 'friend_specific_rules', candidates: [] },
      incomingSwitches: [],
      operationalReferences: [],
      lineResources: { pageCount: 0, pagesWithLineRichMenuId: 0, isDefaultForAll: false, publishing: false },
      blockers: ['incoming_switches'],
      canDelete: false,
      recommendedAction: 'review_references',
    }
    expect(impactFromError(base)).not.toBeNull()
    expect(impactFromError({ ...base, currentAudience: null })).toBeNull()
    expect(impactFromError({ ...base, nextDisplay: { guaranteedGroupId: null, reason: 'friend_specific_rules' } })).toBeNull()
    expect(impactFromError({ ...base, group: { name: '通常メニュー' } })).toBeNull()
  })
})
