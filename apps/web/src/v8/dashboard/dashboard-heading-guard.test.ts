import { beforeEach, describe, expect, it, vi } from 'vitest'
import { greeting } from './dashboard-heading'

describe('dashboard-heading の異常日時・非文字列名保護', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('Invalid Date や非文字列 name が渡されても RangeError / TypeError で落ちない', () => {
    const result = greeting('山田 太郎', new Date('invalid'))
    expect(result).toMatch(/^(おはようございます|こんにちは|こんばんは)、山田 さん$/)
    expect(greeting(123 as unknown as string, new Date('2026-06-01T02:00:00Z'))).toBe('こんにちは')
    expect(greeting('  ', new Date('2026-06-01T02:00:00Z'))).toBe('こんにちは')
    expect(greeting('佐藤 花子', new Date('2026-06-01T02:00:00Z'))).toBe('こんにちは、佐藤 さん')
  })
})
