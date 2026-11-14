import { expect, it } from 'vitest'
import { bookingWords } from './words'

it.each([
  ['standard', '電話の予約を入れる'], ['salon', '電話の予約を入れる'], ['restaurant', '電話の予約を入れる'], ['ec', '電話の予約を入れる'],
  ['consult', '面談を入れる'], ['lesson', '会員を予約する'], [null, '電話の予約を入れる'],
] as const)('予約を入れるボタンの言葉（TM-V20）：%s は「%s」', (style, label) => {
  expect(bookingWords(style).create).toBe(label)
})
