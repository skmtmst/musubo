import { describe, expect, it } from 'vitest'
import type { EcNotificationRun } from '@/lib/api'
import { filterNotificationRuns } from './notification-run-state'

const NOW = Date.parse('2026-09-09T12:00:00+09:00')

function run(overrides: Partial<EcNotificationRun> & Pick<EcNotificationRun, 'id'>): EcNotificationRun {
  return {
    recipientType: 'customer',
    notificationName: '発送のお知らせ',
    source: 'EC連携',
    sourceEventId: `event-${overrides.id}`,
    friendId: `friend-${overrides.id}`,
    friendName: '見本 143',
    orderNumber: `NEN-${overrides.id}`,
    channel: 'line',
    status: 'failed',
    reason: 'LINE APIが一時的に受け付けませんでした',
    receivedAt: '2026-09-09T11:00:00+09:00',
    acceptedAt: null,
    attemptCount: 1,
    nextRetryAt: null,
    clickedAt: null,
    version: 1,
    executionMode: 'automatic',
    retryAvailable: true,
    recordVersion: 1,
    providerStatus: null,
    ...overrides,
  }
}

const ITEMS = [
  run({ id: 'customer-failed-recent' }),
  run({
    id: 'operator-failed-week',
    recipientType: 'operator',
    friendName: '運用担当',
    receivedAt: '2026-09-04T12:00:00+09:00',
  }),
  run({
    id: 'customer-excluded-old',
    status: 'excluded',
    reason: 'LINEでつながっていないため対象外',
    receivedAt: '2026-07-01T12:00:00+09:00',
  }),
]

describe('LINE通知の表示中ページ絞り込み', () => {
  it('状態・対象・期間を同時に適用する', () => {
    expect(filterNotificationRuns(ITEMS, {
      query: '', status: 'failed', recipient: 'customer', period: '24h',
    }, NOW).map((item) => item.id)).toEqual(['customer-failed-recent'])
  })

  it('運用者だけ、7日以内だけをそれぞれ選べる', () => {
    expect(filterNotificationRuns(ITEMS, {
      query: '', status: 'all', recipient: 'operator', period: 'all',
    }, NOW).map((item) => item.id)).toEqual(['operator-failed-week'])
    expect(filterNotificationRuns(ITEMS, {
      query: '', status: 'all', recipient: 'all', period: '7d',
    }, NOW).map((item) => item.id)).toEqual(['customer-failed-recent', 'operator-failed-week'])
  })

  it('名前・注文番号・理由・発生元を検索し、未来や不正な日時を期間内に含めない', () => {
    expect(filterNotificationRuns(ITEMS, {
      query: 'つながっていない', status: 'all', recipient: 'all', period: 'all',
    }, NOW).map((item) => item.id)).toEqual(['customer-excluded-old'])

    const invalidDates = [
      run({ id: 'future', receivedAt: '2026-09-10T12:00:00+09:00' }),
      run({ id: 'invalid', receivedAt: 'not-a-date' }),
    ]
    expect(filterNotificationRuns(invalidDates, {
      query: '', status: 'all', recipient: 'all', period: '30d',
    }, NOW)).toEqual([])
  })
})
