import { describe, expect, it } from 'vitest'
import { originInfoOf } from './origin-labels'

describe('conversions/origin-labels ガード', () => {
  it('プロトタイプ継承キーや空白文字で関数や不正値を返さず安全な既定情報へ倒す', () => {
    for (const key of ['toString', 'constructor', 'valueOf', '__proto__']) {
      const info = originInfoOf(key)
      expect(info.name).toBe('その他')
      expect(info.key).toBe(key)
      expect(info.valueModes).toEqual(['fixed', 'none'])
      expect(info.defaultValueMode).toBe('none')
    }
    expect(originInfoOf('   ').name).toBe('その他')
    expect(originInfoOf('ec_order_confirmed').name).toBe('注文が確定した')
  })
})
