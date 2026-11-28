import { describe, expect, it } from 'vitest'
import type { RestaurantTable } from '@/lib/restaurant-test-api'
import { joinTableCodes, sanName } from './format'

describe('restaurant/inventory/format の空白入力ガード', () => {
  it('担当者名が空白だけ・先頭空白ありでも「さん」だけの壊れた表記にならない', () => {
    expect(sanName('   ')).toBe('ほかの担当者')
    expect(sanName(' 山田 太郎')).toBe('山田さん')
    expect(sanName(null)).toBe('ほかの担当者')
  })

  it('卓コードが空白の行が混ざっていても先頭や途中に余計な中点を入れない', () => {
    const tables = [
      { code: '   ', seat_type: 'table' },
      { code: ' T1 ', seat_type: 'table' },
      { code: 'T2', seat_type: 'table' },
      { code: 'T3', seat_type: 'table' },
    ] as unknown as RestaurantTable[]

    expect(joinTableCodes(tables)).toBe('T1〜T3')
  })
})
