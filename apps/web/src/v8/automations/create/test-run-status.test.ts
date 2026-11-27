import { describe, expect, it } from 'vitest'
import { testRunStatusLabel } from './draft-model'

describe('1人テストの状態', () => {
  it('既知の状態を日本語で表示する', () => {
    expect(testRunStatusLabel('success')).toBe('終わりました')
    expect(testRunStatusLabel('failed')).toBe('失敗しました。実行の結果を見てください。')
  })

  it.each(['constructor', 'toString', '__proto__', 'future'])('未知の状態 %s を確認中と表示する', (status) => {
    expect(testRunStatusLabel(status)).toBe('確認中')
  })
})
