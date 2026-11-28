import { describe, expect, it } from 'vitest'
import { formatCampaignTiming } from './display'

describe('nen-campaigns/display の配信タイミング表示ガード', () => {
  it('非有限・負の日数は不正な文字や確定表示にせず未確定の案内を返す', () => {
    for (const delayDays of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
      const label = formatCampaignTiming({ campaignKey: 'arrival_check', delayDays, deliveryTime: '10:00' })
      expect(label).toBe('配信日時を確認できません')
      expect(label).not.toContain('NaN')
      expect(label).not.toContain('Infinity')
    }
  })

  it('時刻が空や空白だけのときは日付だけで確定表示にせず時刻不明と分かる案内を返し、通常の値は維持する', () => {
    expect(formatCampaignTiming({ campaignKey: 'arrival_check', delayDays: 0, deliveryTime: '  ' })).toBe('発送当日（配信時刻を確認できません）')
    expect(formatCampaignTiming({ campaignKey: 'review_request', delayDays: 3, deliveryTime: '' })).toBe('発送から3日後（配信時刻を確認できません）')
    expect(formatCampaignTiming({ campaignKey: 'arrival_check', delayDays: 0, deliveryTime: '10:00' })).toBe('発送当日 10:00')
    expect(formatCampaignTiming({ campaignKey: 'review_request', delayDays: 3, deliveryTime: ' 12:30 ' })).toBe('発送から3日後 12:30')
    expect(formatCampaignTiming({ campaignKey: 'birthday_coupon', delayDays: Number.NaN, deliveryTime: '' })).toBe('誕生日の3日前 10:00')
  })
})
