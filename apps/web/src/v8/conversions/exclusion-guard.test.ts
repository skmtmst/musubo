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

  it('入れ子の空グループを含む条件をサーバー契約と同様に保持し、有効な入れ子条件の件数と要約を返す', () => {
    const nestedEmptyGroups = {
      exclusion: {
        operator: 'AND',
        rules: [],
        groups: [{ operator: 'AND', rules: [], groups: [{ operator: 'AND', rules: [] }] }],
      },
    }
    expect(readExclusionCondition(nestedEmptyGroups)).toEqual(nestedEmptyGroups.exclusion)
    expect(readExclusionView(nestedEmptyGroups)).toMatchObject({
      invalid: false,
      hasCondition: true,
    })

    const topLevelEmpty = {
      exclusion: {
        operator: 'AND',
        rules: [],
      },
    }
    expect(readExclusionCondition(topLevelEmpty)).toBeNull()
    expect(readExclusionView(topLevelEmpty)).toMatchObject({ invalid: false, hasCondition: false, ruleCount: 0 })

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
