import { describe, expect, it } from 'vitest'
import type { ReminderDraftSettings } from '@line-crm/shared'
import { describeReminderDiff } from './conflict-diff'

function baseSettings(overrides: Partial<ReminderDraftSettings> = {}): ReminderDraftSettings {
  return {
    name: '予約前日のご案内',
    description: null,
    lineAccountId: 'acc-1',
    triggerType: 'booking',
    deliveryMode: 'countdown',
    triggerFieldId: null,
    triggerEventId: null,
    repeatYearly: false,
    triggerOffsetMinutes: -1440,
    sendAtTime: '18:00',
    targetTagId: null,
    targetCondition: null,
    folderId: null,
    stopConditions: { cancelOnVisit: false, stopOnBlock: true },
    steps: [{ offsetMinutes: -1440, messageContent: '明日です' }],
    ...overrides,
  } as ReminderDraftSettings
}

describe('reminders/conflict-diff のキー順正規化と空白名ガード', () => {
  it('入れ子オブジェクトのキー順が違うだけの同一条件・手順を競合差分と誤判定しない', () => {
    const mine = baseSettings({
      stopConditions: { stopOnBlock: true, cancelOnVisit: false } as unknown as ReminderDraftSettings['stopConditions'],
      steps: [{ messageContent: '明日です', offsetMinutes: -1440 }] as unknown as ReminderDraftSettings['steps'],
    })
    const incoming = baseSettings({
      stopConditions: { cancelOnVisit: false, stopOnBlock: true } as unknown as ReminderDraftSettings['stopConditions'],
      steps: [{ offsetMinutes: -1440, messageContent: '明日です' }] as unknown as ReminderDraftSettings['steps'],
    })

    expect(describeReminderDiff(mine, incoming)).toEqual([])
  })

  it('空白だけのリマインダ名は無題として扱い、空白同士を別の名前と誤判定しない', () => {
    expect(describeReminderDiff(baseSettings({ name: '   ' }), baseSettings({ name: '' }))).toEqual([])

    const diff = describeReminderDiff(baseSettings({ name: '   ' }), baseSettings({ name: '新しい名前' }))
    expect(diff).toEqual(['リマインダ名が違います（最新「新しい名前」／あなた「（無題）」）'])
  })
})
