import { describe, expect, it } from 'vitest'
import type { AutoReplyDraftInput } from '@line-crm/shared'
import { formFromSettings, ruleTriggerSummary, weekdaySummary } from './wizard-model'

describe('auto-replies/edit/wizard-model ガード', () => {
  it('重複・範囲外・非整数の曜日を除外し、重複7件を「毎日」と誤認しない', () => {
    expect(weekdaySummary([1, 1, 1, 1, 1, 1, 1])).toBe('月に反応')
    expect(weekdaySummary([1, 2, 3, 9, -1, Number.NaN])).toBe('月〜水に反応')
    expect(weekdaySummary([1, 1, 3, 5])).toBe('月・水・金に反応')
    expect(weekdaySummary([])).toBe('毎日反応する')
  })

  it('終了時刻のみ指定されたルールを「いつでも」に潰さず、00:00〜終了時刻で示す', () => {
    expect(ruleTriggerSummary({ keyword: '予約', activeFrom: null, activeUntil: '18:00' })).toBe('「予約」を含む・毎日 00:00〜18:00')
    expect(ruleTriggerSummary({ keyword: '予約', activeFrom: '21:00', activeUntil: null })).toBe('「予約」を含む・毎日 21:00〜24:00')
    expect(ruleTriggerSummary({ keyword: null, activeFrom: null, activeUntil: null })).toBe('すべてのメッセージ・いつでも')
  })

  it('壊れた数値・配列・未知の受信元を含む保存設定を安全に正規化して復元する', () => {
    const malformed = {
      name: 'テスト',
      respondToAll: false,
      keyword: '予約',
      matchType: 'contains',
      keywords: null,
      responseType: 'text',
      templateId: null,
      responseContent: '承りました',
      responseWeekdays: [1, 1, 9, Number.NaN],
      messageKinds: 'text',
      replyDelaySeconds: Number.NaN,
      cooldownMinutes: Number.POSITIVE_INFINITY,
      receiveSources: ['unknown', 'email', 'email'],
      priority: Number.NaN,
      actions: [],
    } as unknown as AutoReplyDraftInput

    const form = formFromSettings(malformed)
    expect(form.weekdays).toEqual([1])
    expect(form.messageKinds).toEqual([])
    expect(form.replyDelaySeconds).toBe('0')
    expect(form.cooldownOn).toBe(false)
    expect(form.cooldownMinutes).toBe('60')
    expect(form.receiveSources).toEqual(['email'])
    expect(form.priority).toBe(0)
  })
})
