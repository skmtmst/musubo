import { expect, it } from 'vitest'
import { sourceName, SOURCE_LABEL } from './format'
import { sourceLabel } from '../closures/format'

it.each(['constructor', 'toString', '__proto__', 'future'])('未知の予約元 %s も文字と登録名を保つ', source => {
  expect(sourceName(source)).toBe(source)
  expect(SOURCE_LABEL[source]).toBeUndefined()
  expect(sourceLabel(source, [{ code: source, name: '登録した媒体' }])).toBe('登録した媒体')
  expect(sourceLabel(source)).toBe(source)
})
it('既知の予約元は従来どおり', () => {
  expect(sourceName('line')).toBe('LINE')
  expect(sourceLabel('phone')).toBe('電話')
})
