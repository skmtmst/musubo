// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyHoursWorkspace, HOURS_WEEKDAYS, type OpeningWeek } from '@line-crm/shared'
import type { GoogleChange, GoogleProfileData } from '@/lib/restaurant-google-api'
import { HoursConfirm } from './hours-confirm'

const weekly = Object.fromEntries(
  HOURS_WEEKDAYS.map((day) => [day, [{ open: '11:00', close: '22:00' }]]),
) as OpeningWeek

const profile: GoogleProfileData = {
  success: true,
  store: { id: 'store-a', name: '対象店', lineAccountId: 'acc-a' },
  profile: {
    name: 'locations/a',
    title: '対象店',
    address: null,
    phone: null,
    websiteUri: null,
    description: null,
    openStatus: 'OPEN',
    regularHours: weekly,
    specialHours: [],
    mapsUri: null,
  },
  today: { date: '2026-11-04', weekday: 'WEDNESDAY', holidayName: null, periods: [], closed: true, special: false },
  holidays: [],
  timeZone: 'Asia/Tokyo',
  closed: false,
  photoCount: 0,
  googleUpdates: null,
  fetchedAt: '2026-11-04T03:00:00Z',
  stale: false,
  refreshError: null,
  pendingChangeCount: 0,
  writeEnabled: true,
  aiAvailable: true,
  permissions: { canManageConnection: true, canPublishReply: true, canSendChange: true },
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('営業時間確認画面の予約影響件数と重複日付の表示安全化', () => {
  it('影響件数が欠けた変更が混ざってもNaNにならず、同じ日付が重複しても1回だけ表示する', () => {
    const changes = [
      {
        id: 'c-1',
        kind: 'special_hours',
        status: 'draft',
        target: { dates: ['2026-11-14'] },
        before: [{ date: '2026-11-14', periods: weekly.SATURDAY }],
        after: [{ date: '2026-11-14', closed: true, periods: [] }],
        reservationImpactCount: 3,
      },
      {
        id: 'c-2',
        kind: 'special_hours',
        status: 'draft',
        target: { dates: ['2026-11-14'] },
        before: [{ date: '2026-11-14', periods: weekly.SATURDAY }],
        after: [{ date: '2026-11-14', closed: true, periods: [] }],
        reservationImpactCount: undefined,
      },
    ] as unknown as GoogleChange[]

    render(
      <HoursConfirm
        data={profile}
        workspace={emptyHoursWorkspace()}
        changes={changes}
        onBack={() => {}}
        onSend={() => {}}
        busy={false}
        disabled={false}
        error=""
      />,
    )

    expect(screen.getByText(/合わなくなる予約が3件あります/)).toBeTruthy()
    expect(screen.queryByText(/NaN/)).toBeNull()
    expect(screen.getByText('2026年11月14日')).toBeTruthy()
    expect(screen.getByText('この1日をGoogleの特別営業時間として反映します。')).toBeTruthy()
  })
})
