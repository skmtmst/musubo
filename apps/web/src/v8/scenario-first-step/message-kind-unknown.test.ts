import { expect, it } from 'vitest'
import { messageKindLabel } from './first-step-form'

it.each(['constructor', 'toString', '__proto__', 'future'])('知らない1通目の種類 %s は文字のまま表示する', type => {
  expect(messageKindLabel(type)).toBe(type)
})
it('知っている種類は既存の名前を表示する', () => {
  expect(messageKindLabel('carousel')).toBe('カルーセル')
})
