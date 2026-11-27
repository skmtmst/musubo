// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyHoursWorkspace, HOURS_WEEKDAYS, type OpeningWeek } from '@line-crm/shared'
import type { GoogleChange, GoogleProfileData } from '@/lib/restaurant-google-api'

const api = vi.hoisted(() => ({ proposeHours: vi.fn() }))
vi.mock('@/lib/restaurant-google-api', () => ({ restaurantGoogleApi: api }))

import { HoursEditPanel } from './hours-edit-panel'

const weekly = Object.fromEntries(
  HOURS_WEEKDAYS.map(day => [day, day === 'WEDNESDAY' ? [] : [{ open: '11:00', close: '22:00' }]]),
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

describe('営業時間の文章入力パネルの連打防止と古い応答の破棄', () => {
  it('「変更案を作る」を連打しても読み取り要求は1回だけ送る', async () => {
    let resolvePropose!: (value: { change: GoogleChange }) => void
    api.proposeHours.mockImplementation(
      () => new Promise<{ change: GoogleChange }>(resolve => { resolvePropose = resolve }),
    )
    const onDraft = vi.fn()

    render(
      <HoursEditPanel
        panel={{ kind: 'text' }}
        data={profile}
        workspace={emptyHoursWorkspace()}
        holidays={[]}
        serviceTypes={[]}
        onDraft={onDraft}
        onReview={() => {}}
        onClose={() => {}}
        onEditDates={() => {}}
        saving={false}
        saved
        disabled={false}
      />,
    )

    fireEvent.change(screen.getByRole('textbox', { name: '文章で入力' }), {
      target: { value: '12月30日を休業' },
    })
    const proposeButton = screen.getByRole('button', { name: '変更案を作る' })
    fireEvent.click(proposeButton)
    fireEvent.click(proposeButton)

    expect(api.proposeHours).toHaveBeenCalledTimes(1)

    resolvePropose({
      change: {
        id: 'change-1',
        kind: 'special_hours',
        summary: '12月30日を休業',
        after: [{ date: '2026-12-30', closed: true, periods: [] }],
      } as GoogleChange,
    })

    expect(await screen.findByRole('heading', { name: '読み取った変更案' })).toBeTruthy()
    expect(onDraft).toHaveBeenCalledTimes(1)
  })

  it('読み取り中に文章を書き換えると古い変更案を下書きへ反映せず、失敗表示も打ち直しで消える', async () => {
    let resolveFirst!: (value: { change: GoogleChange }) => void
    api.proposeHours
      .mockImplementationOnce(() => new Promise<{ change: GoogleChange }>(resolve => { resolveFirst = resolve }))
      .mockRejectedValueOnce(new Error('temporary failure'))
    const onDraft = vi.fn()

    render(
      <HoursEditPanel
        panel={{ kind: 'text' }}
        data={profile}
        workspace={emptyHoursWorkspace()}
        holidays={[]}
        serviceTypes={[]}
        onDraft={onDraft}
        onReview={() => {}}
        onClose={() => {}}
        onEditDates={() => {}}
        saving={false}
        saved
        disabled={false}
      />,
    )

    const textarea = screen.getByRole('textbox', { name: '文章で入力' })
    fireEvent.change(textarea, { target: { value: '12月30日を休業' } })
    fireEvent.click(screen.getByRole('button', { name: '変更案を作る' }))

    // 読み取り途中で文章を書き換える
    fireEvent.change(textarea, { target: { value: '1月2日を休業' } })

    resolveFirst({
      change: {
        id: 'stale-change',
        kind: 'special_hours',
        summary: '12月30日を休業',
        after: [{ date: '2026-12-30', closed: true, periods: [] }],
      } as GoogleChange,
    })

    await waitFor(() => expect(onDraft).not.toHaveBeenCalled())
    expect(screen.queryByRole('heading', { name: '読み取った変更案' })).toBeNull()

    // 失敗したあとに入力を直すとエラー表示も消える
    fireEvent.click(screen.getByRole('button', { name: '変更案を作る' }))
    expect(await screen.findByRole('alert')).toBeTruthy()

    fireEvent.change(textarea, { target: { value: '1月3日を休業' } })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})
