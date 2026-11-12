import { expect, test } from 'vitest'
import { inputPlaceholder } from './input-placeholder'

test('見本の印を全角コロンにそろえ、メール・URL・電話の見本と入力値を区別する', () => {
  expect(['例: 山田太郎','例：山田太郎','例）山田太郎'].map(inputPlaceholder)).toEqual(['例：山田太郎','例：山田太郎','例：山田太郎'])
  expect(['you@example.com','https://example.com','090-0000-5678'].map(inputPlaceholder)).toEqual(['例：you@example.com','例：https://example.com','例：090-0000-5678'])
  expect(['名前で探す','タグを選ぶ','-- : --','0','例えばの説明',''].map(inputPlaceholder)).toEqual(['名前で探す','タグを選ぶ','-- : --','0','例えばの説明',''])
  expect(inputPlaceholder(undefined)).toBeUndefined()
})
