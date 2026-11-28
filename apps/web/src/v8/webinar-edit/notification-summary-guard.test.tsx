// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { WebinarNotificationSettings } from '@/lib/api'
import {
  NotificationStateBadge,
  audienceText,
  deliveryTimingSummary,
  missedNoticeSummary,
} from './notification-summary'

afterEach(cleanup)

const baseSettings: WebinarNotificationSettings = {
  dayBeforeEnabled: true,
  dayBeforeTime: '   ',
  hourBeforeEnabled: true,
  hourBeforeMinutes: -10,
  startEnabled: false,
  missedEnabled: true,
  missedTime: '   ',
  missedWindowDays: Number.NaN,
  completedEnabled: false,
} as WebinarNotificationSettings

describe('webinar notification-summary の異常値表示ガード', () => {
  it('対象人数や予約件数が非数・負数のときは未取得表記へフォールバックする', () => {
    expect(audienceText({ people: Number.NaN, bookings: 3, definition: 'valid' })).toBe('—')
    expect(audienceText({ people: 3, bookings: -1, definition: 'valid' })).toBe('—')
    expect(audienceText({ people: 12, bookings: 15, definition: 'valid' })).toBe(
      '12人（取消を除いた有効な申込。延べ予約は15件）',
    )
  })

  it('当日案内で空白だけの時刻や0以下の分数をそのまま出さない', () => {
    expect(deliveryTimingSummary(baseSettings, true, false)).toBe('前日 —／開始前')
    expect(
      deliveryTimingSummary(
        { ...baseSettings, dayBeforeTime: '18:00', hourBeforeMinutes: 60, startEnabled: true },
        true,
        false,
      ),
    ).toBe('前日 18:00／60分前／開始時')
  })

  it('見逃し案内で空白だけの時刻や不正な期限日数を安全に補う', () => {
    expect(missedNoticeSummary(baseSettings, true, false)).toBe('未視聴者へ翌日—に送信（期限7日）')
    expect(
      missedNoticeSummary({ ...baseSettings, missedWindowDays: 0, missedTime: '10:00' }, true, false),
    ).toBe('未視聴者へ翌日10:00に送信（期限7日）')
  })

  it('状態バッジの描画を壊さない', () => {
    render(<NotificationStateBadge state="configured" />)
    expect(screen.getByText('設定済み')).toBeTruthy()
  })
})
