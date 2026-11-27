import { describe, expect, it } from 'vitest'
import type { Area } from '../../../components/rich-menus/area-types'
import { areaDraftsWithSwitchTargets, describeMenuSummary, parseStoredCondition } from './create-draft'

function switchArea(targetPageId: unknown): Area {
  return {
    id: 'area-1',
    boundsX: 0,
    boundsY: 0,
    boundsWidth: 100,
    boundsHeight: 100,
    actionType: 'richmenuswitch',
    actionData: { targetPageId },
  } as unknown as Area
}

describe('rich-menus/new/create-draft の下書き投影ガード', () => {
  it('切替先の targetPageId が空文字・空白・負数のときは誤って targetPageIndex を付けない', () => {
    for (const raw of ['', '   ', '-1']) {
      const [out] = areaDraftsWithSwitchTargets([switchArea(raw)])
      expect(out.actionData).not.toHaveProperty('targetPageIndex')
    }
    const [valid] = areaDraftsWithSwitchTargets([switchArea('2')])
    expect(valid.actionData).toEqual({ targetPageIndex: 2 })
  })

  it('parseStoredCondition は配列やプリミティブの JSON を条件オブジェクト扱いしない', () => {
    expect(parseStoredCondition('[]')).toBeNull()
    expect(parseStoredCondition('123')).toBeNull()
    expect(parseStoredCondition('"text"')).toBeNull()
    expect(parseStoredCondition('null')).toBeNull()
  })

  it('describeMenuSummary は空白だけの名前と言葉を未設定表記にする', () => {
    const summary = describeMenuSummary({
      name: '   ',
      chatBarText: '   ',
      audience: 'all',
      pages: [{ areas: [] }],
    })
    expect(summary).toContain('名前：未設定')
    expect(summary).toContain('言葉：未設定')
  })
})
