// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BookingSettings } from '@/lib/api'
import type { V8TabEdit } from './shared'

const tab = vi.hoisted(() => ({ latest: null as V8TabEdit | null }))
const saveSettings = vi.hoisted(() => vi.fn())

vi.mock('./shared', async (importOriginal: () => Promise<typeof import('./shared')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    useV8TabEdit: (options: V8TabEdit) => {
      tab.latest = options
    },
  }
})

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    bookingApi: {
      ...actual.bookingApi,
      saveSettings,
    },
  }
})

import { HoursTabV8 } from './hours-tab'

function baseSettings(businessHours: unknown): BookingSettings {
  return {
    version: 3,
    timeZone: 'Asia/Tokyo',
    bookingWindowDays: 30,
    cutoffMinutesBefore: 60,
    cancelDeadlineMinutesBefore: 60,
    maxActiveBookingsPerFriend: 3,
    approvalMode: 'automatic',
    holdMinutes: 10,
    slotGranularityMinutes: 30,
    reminderDayBeforeTime: null,
    reminderHoursBefore: 2,
    businessHoursConfigured: true,
    exceptions: [],
    businessHours,
  } as unknown as BookingSettings
}

function renderHoursTab(settings: BookingSettings, onReload = vi.fn(), onSaved = vi.fn()) {
  vi.stubGlobal(
    'fetch',
    async () => new Response(JSON.stringify({ success: true, data: [], staff: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
  return render(
    <HoursTabV8
      accountId="acc-1"
      settings={settings}
      settingsStatus="ready"
      settingsError={null}
      resources={[]}
      resourcesStatus="ready"
      resourcesError={null}
      canEdit
      menus={[]}
      onSaved={onSaved}
      onReload={onReload}
      onResourceSaved={() => {}}
      onResourceCreated={() => {}}
      onResourceDeleted={() => {}}
      onResourcesRetry={() => {}}
    />,
  )
}

describe('HoursTabV8 の不正な営業時間レスポンス保護', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    tab.latest = null
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it.each([
    ['businessHours が null', null],
    ['businessHours が配列でない', { weekday: 1, intervals: [] }],
    ['曜日要素に null が混ざる', [null, { weekday: 2, intervals: [{ start: '10:00', end: '18:00', capacity: 1 }] }]],
    ['区間に null が混ざる', [
      { weekday: 1, intervals: [{ start: '09:00', end: '18:00', capacity: 1 }, null] },
      { weekday: 2, intervals: [{ start: '10:00', end: '18:00', capacity: 1 }] },
    ]],
    ['intervals が配列でない', [
      { weekday: 1, intervals: null },
      { weekday: 2, intervals: [{ start: '10:00', end: '18:00', capacity: 1 }] },
    ]],
  ])('%s のとき読み直し案内を出し、編集と保存を止める', async (_label, brokenBusinessHours) => {
    const onReload = vi.fn()
    renderHoursTab(baseSettings(brokenBusinessHours), onReload)

    expect(screen.getByText('営業時間を読み込めませんでした')).toBeTruthy()
    expect(screen.queryAllByRole('switch')).toHaveLength(0)
    expect(tab.latest?.saveDisabled).toBe(true)
    expect(tab.latest?.dirty).toBe(false)

    await act(async () => {
      await tab.latest?.onSave()
    })
    expect(saveSettings).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('正しい営業時間のときは従来どおり編集して保存できる', async () => {
    const valid = baseSettings([
      { weekday: 1, intervals: [{ start: '09:00', end: '18:00', capacity: 1 }] },
      { weekday: 2, intervals: [{ start: '10:00', end: '17:00', capacity: 2 }] },
    ])
    saveSettings.mockResolvedValue({ success: true, data: valid })
    const onReload = vi.fn()
    const onSaved = vi.fn()
    renderHoursTab(valid, onReload, onSaved)

    expect(screen.queryByText('営業時間を読み込めませんでした')).toBeNull()
    expect(screen.getAllByRole('switch', { name: /曜日を開ける/ })).toHaveLength(7)
    expect(tab.latest?.saveDisabled).toBe(false)

    fireEvent.click(screen.getByRole('switch', { name: '火曜日を開ける' }))
    expect(tab.latest?.dirty).toBe(true)

    await act(async () => {
      await tab.latest?.onSave()
    })

    expect(saveSettings).toHaveBeenCalledTimes(1)
    const sent = saveSettings.mock.calls[0][1].businessHours as Array<{ weekday: number; intervals: unknown[] }>
    expect(sent.find((day) => day.weekday === 1)?.intervals).toEqual([{ start: '09:00', end: '18:00', capacity: 1 }])
    expect(sent.find((day) => day.weekday === 2)?.intervals).toEqual([])
    expect(onSaved).toHaveBeenCalledWith(valid)
  })
})
