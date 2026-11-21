import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import { isReservationInputError } from './edit-save-result'

describe('予約変更の入力で直せる失敗', () => {
  it.each([
    [400, undefined, true], [422, undefined, true], [409, 'availability_conflict', true],
    [409, 'table_conflict', true], [500, 'table_conflict', false], [409, 'version_conflict', false], [409, undefined, false], [401, undefined, false],
    [403, 'availability_conflict', false], [500, 'availability_conflict', false],
  ] as const)('状態%sと符号%sを分ける', (status, code, expected) => {
    expect(isReservationInputError(new ApiError(status, '保存できませんでした', code))).toBe(expected)
  })
  it('通信失敗や型の異なる理由を入力失敗として扱わない', () => {
    for (const error of [new TypeError('network'), new Error('入力を確認してください'), null, { status: 400 }]) expect(isReservationInputError(error)).toBe(false)
  })
})
