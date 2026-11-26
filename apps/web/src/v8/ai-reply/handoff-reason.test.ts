import { describe, expect, it } from 'vitest'
import { handoffReasonText } from './words'

describe('AI から担当者へ引き継いだ理由', () => {
  it('登録済みと未指定の理由を表示する', () => {
    expect(handoffReasonText('complaint')).toBe('苦情')
    expect(handoffReasonText(null)).toBe('—')
    expect(handoffReasonText('')).toBe('—')
  })

  it.each(['new_reason', 'constructor', 'toString', '__proto__'])('未登録の理由 %s は共通の案内を表示する', (reason) => {
    expect(handoffReasonText(reason)).toBe('人へ回しました')
  })
})
