import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FormAction, FormBlock, FormLayout } from '@line-crm/shared'
import type { FormRefs } from '@/components/forms/form-refs'
import {
  blockKindLine,
  blockTitleKind,
  blockTitleLine,
  describeAfterAction,
  describeConflictDiff,
  readPage,
} from './model'

function makeLayout(options: Record<string, unknown>): FormLayout {
  return {
    header: [],
    sections: [{ id: 's1', name: '1ページ目', blocks: [] }],
    options,
  } as unknown as FormLayout
}

describe('form-edit/model ガード', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('readPage は count が NaN・0以下のとき範囲外の番号を通さず 0 を返す', () => {
    expect(readPage('5', Number.NaN)).toBe(0)
    expect(readPage('1', 0)).toBe(0)
    expect(readPage('2', -3)).toBe(0)
    expect(readPage('2', 3)).toBe(1)
  })

  it('describeConflictDiff は options のキー順違いを偽差分にせず、不正な maxLines や壊れた配列でも落ちない', () => {
    const mine = { name: '案内', description: '', layout: makeLayout({ a: 1, b: 2 }) }
    const incoming = { name: '案内', description: '', layout: makeLayout({ b: 2, a: 1 }) }
    expect(describeConflictDiff(mine, incoming)).toEqual({ lines: [], omitted: 0 })

    const brokenMine = {
      name: '案内A',
      description: '',
      layout: { header: null, sections: null, options: {} } as unknown as FormLayout,
    }
    const brokenIncoming = {
      name: '案内B',
      description: '',
      layout: { header: null, sections: null, options: {} } as unknown as FormLayout,
    }
    const diff = describeConflictDiff(brokenMine, brokenIncoming, Number.NaN)
    expect(diff.lines).toHaveLength(1)
    expect(diff.omitted).toBe(0)
  })

  it('blockKindLine・blockTitleLine・blockTitleKind・describeAfterAction は未知・欠損値でも安全に返す', () => {
    const brokenHeading = { id: 'h1', kind: 'heading', level: Number.NaN, text: undefined } as unknown as FormBlock
    expect(blockKindLine(brokenHeading)).toBe('飾り・見出し')
    expect(blockTitleLine(brokenHeading)).toBe('見出し')

    const protoBlock = { id: 'p1', kind: 'toString' } as unknown as FormBlock
    expect(blockTitleKind(protoBlock)).toBe('項目')

    const emptyRefs = { templates: [], tags: [], friendFields: [], scenarios: [], reminders: [] } as unknown as FormRefs
    const unknownAction = { kind: 'future_action' } as unknown as FormAction
    expect(describeAfterAction(unknownAction, emptyRefs)).toBe('回答後の動作を確認できません')

    const brokenTextAction = { kind: 'send_text', text: null } as unknown as FormAction
    expect(describeAfterAction(brokenTextAction, emptyRefs)).toBe('テキストを送る（本文が未設定）')
  })
})
