import { describe, expect, it } from 'vitest'
import { readExclusionCondition, readExclusionView } from './exclusion'

describe('conversions/exclusion ガード', () => {
  it('壊れたグループや空値・内部用ルール・循環参照をサーバー契約と同様に不正（invalid）として弾く', () => {
    const nonArrayGroups = {
      exclusion: {
        operator: 'AND',
        rules: [{ type: 'tag_exists', value: 'tag-1' }],
        groups: 'invalid',
      },
    }
    expect(readExclusionView(nonArrayGroups)).toMatchObject({ invalid: true, hasCondition: false })
    expect(readExclusionCondition(nonArrayGroups)).toBeNull()

    const invalidNestedGroup = {
      exclusion: {
        operator: 'AND',
        rules: [],
        groups: [{ operator: 'MAYBE', rules: [{ type: 'tag_exists', value: 'tag-1' }] }],
      },
    }
    expect(readExclusionView(invalidNestedGroup)).toMatchObject({ invalid: true, hasCondition: false })
    expect(readExclusionCondition(invalidNestedGroup)).toBeNull()

    const emptyRuleValue = {
      exclusion: {
        operator: 'AND',
        rules: [{ type: 'tag_exists', value: '' }],
      },
    }
    expect(readExclusionView(emptyRuleValue)).toMatchObject({ invalid: true, hasCondition: false })
    expect(readExclusionCondition(emptyRuleValue)).toBeNull()

    const internalRule = {
      exclusion: {
        operator: 'AND',
        rules: [{ type: 'friend_id_in', value: ['f-1'] }],
      },
    }
    expect(readExclusionView(internalRule)).toMatchObject({ invalid: true, hasCondition: false })
    expect(readExclusionCondition(internalRule)).toBeNull()

    const cyclic: Record<string, unknown> = { operator: 'AND', rules: [], groups: [] }
    ;(cyclic.groups as unknown[]).push(cyclic)
    expect(readExclusionView({ exclusion: cyclic })).toMatchObject({ invalid: true, hasCondition: false })
    expect(readExclusionCondition({ exclusion: cyclic })).toBeNull()
  })

  it('入れ子グループまで空なら条件なし（invalid ではない）、有効な入れ子条件は件数と要約を返す', () => {
    const emptyNested = {
      exclusion: {
        operator: 'AND',
        rules: [],
        groups: [{ operator: 'OR', rules: [] }],
      },
    }
    expect(readExclusionView(emptyNested)).toMatchObject({ invalid: false, hasCondition: false, ruleCount: 0 })
    expect(readExclusionCondition(emptyNested)).toBeNull()

    const validNested = {
      exclusion: {
        operator: 'AND',
        rules: [{ type: 'tag_exists', value: 'tag-1' }],
        groups: [{ operator: 'OR', rules: [{ type: 'name', value: 'テスト' }] }],
      },
    }
    expect(readExclusionView(validNested)).toMatchObject({
      invalid: false,
      hasCondition: true,
      ruleCount: 2,
      summary: 'タグ・名前に当てはまる人',
    })
    expect(readExclusionCondition(validNested)).toEqual(validNested.exclusion)
  })
})
