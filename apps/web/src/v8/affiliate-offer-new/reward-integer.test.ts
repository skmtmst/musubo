/*
 * 案件の報酬は整数だけ（小数を日本語で送る前に止める）。
 * 以前は旧い写し（app/affiliate-offers/new-offer-v8.tsx）の文字を見ていた
 * （app/affiliates/new/affiliate-create-behavior.test.ts）。今の入口
 * （app/affiliate-offers/new/page.tsx → src/v8/affiliate-offer-new/create.tsx）の判定を直接通す。
 */
import { describe, expect, it } from 'vitest'
import { rewardIntegerError } from './create'

describe('案件の報酬の数の断り方', () => {
  it('小数の報酬額・報酬マイルを日本語で止める', () => {
    expect(rewardIntegerError('100.5', 'amount')).toBe('報酬額は小数ではなく、1円単位の整数で入力してください')
    expect(rewardIntegerError('3.2', 'miles')).toBe('報酬マイルは小数ではなく、整数で入力してください')
  })

  it('空欄・0・整数は通し、負の数は止める', () => {
    expect(rewardIntegerError('', 'amount')).toBeNull()
    expect(rewardIntegerError('0', 'amount')).toBeNull()
    expect(rewardIntegerError('2000', 'amount')).toBeNull()
    expect(rewardIntegerError('-1', 'miles')).toBe('報酬マイルは0以上で入力してください')
  })


})
