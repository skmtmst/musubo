import { describe, expect, it } from 'vitest'
import type { CommonVar } from '@line-crm/shared'
import { stateBadge } from './list-model'

describe('共通情報の状態', () => {
  it.each(['constructor', 'toString', '__proto__', 'future'])('%s を使用中と決めつけない', state => {
    expect(stateBadge({ state } as CommonVar)).toEqual({ label: '状態を確認できません', tone: 'neutral' })
  })
  it('使用中の表示を保つ', () => {
    expect(stateBadge({ state: 'active' } as CommonVar)).toEqual({ label: '有効', tone: 'success' })
  })
})
